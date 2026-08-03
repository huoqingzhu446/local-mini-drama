const fs = require('fs');
const { randomUUID } = require('node:crypto');

const assetProductionService = require('./paperAssetProductionService');
const runService = require('./paperStudioRunService');
const shotService = require('./paperStudioShotService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

function providerCallCount(db, runId) {
  return Number(db.prepare(
    `SELECT COALESCE(SUM(provider_call_count), 0) AS count
     FROM image_generations WHERE paper_studio_run_id = ?`,
  ).get(Number(runId))?.count || 0);
}

function verifyVersionFile(cfg, version) {
  const localPath = version.alpha_local_path || version.source_local_path || version.mask_local_path || null;
  const expectedHash = version.alpha_hash || version.source_hash || version.mask_hash || null;
  if (!localPath || !expectedHash) return { pass: false, local_path: localPath, expected_hash: expectedHash, reason: 'missing_path_or_hash' };
  let absolute;
  try { absolute = assetProductionService.safeStorageFile(cfg, localPath); } catch (_) {
    return { pass: false, local_path: localPath, expected_hash: expectedHash, reason: 'path_outside_storage' };
  }
  if (!fs.existsSync(absolute)) return { pass: false, local_path: localPath, expected_hash: expectedHash, reason: 'file_missing' };
  const actualHash = sha256(fs.readFileSync(absolute));
  return {
    pass: actualHash === expectedHash,
    local_path: localPath,
    expected_hash: expectedHash,
    actual_hash: actualHash,
    reason: actualHash === expectedHash ? null : 'hash_mismatch',
  };
}

function latestReviewDecision(db, assetVersionId) {
  const row = db.prepare(
    `SELECT id, decision, reason, reviewer, request_id, created_at
     FROM paper_asset_review_decisions
     WHERE asset_version_id = ?
     ORDER BY id DESC
     LIMIT 1`,
  ).get(Number(assetVersionId));
  return row ? { ...row, id: Number(row.id) } : null;
}

function localTrustState(db, version) {
  const archiveImport = parseJson(version?.provenance_json, {})?.archive_import || null;
  if (!archiveImport || archiveImport.import_trust_state !== 'review_required') {
    return { imported: false, trusted: true, review_required: false };
  }
  const importedDecisionCount = Number(archiveImport.imported_review_decision_count || 0);
  const currentDecisionCount = version.review_decision_count == null
    ? Number(db.prepare(
      'SELECT COUNT(*) AS count FROM paper_asset_review_decisions WHERE asset_version_id = ?',
    ).get(Number(version.id))?.count || 0)
    : Number(version.review_decision_count || 0);
  const trusted = currentDecisionCount > importedDecisionCount;
  return {
    imported: true,
    trusted,
    review_required: !trusted,
    archive_schema_version: Number(archiveImport.schema_version || 1),
    imported_review_decision_count: importedDecisionCount,
    current_review_decision_count: currentDecisionCount,
  };
}

function reuseReviewDecisionTableReady(db) {
  return Boolean(db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'paper_asset_reuse_review_decisions'",
  ).get());
}

function latestReuseReviewDecision(db, targetSlotId, sourceAssetVersionId) {
  if (!reuseReviewDecisionTableReady(db)) return null;
  const row = db.prepare(
    `SELECT * FROM paper_asset_reuse_review_decisions
     WHERE target_slot_id = ? AND source_asset_version_id = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(targetSlotId), Number(sourceAssetVersionId));
  return row ? { ...row, id: Number(row.id) } : null;
}

function approvedHistoryCandidates(db, shot, slot) {
  return db.prepare(
    `SELECT pav.*, pas.slot_key AS source_slot_key, pas.asset_type, pas.generation_purpose,
            pas.constraints_json, pas.reuse_fingerprint AS slot_reuse_fingerprint,
            psf.family_key, psf.plan_revision_id, psf.shot_id AS source_shot_id,
            source_shot.run_id AS source_run_id,
            source_shot.paper_storyboard_revision_id AS source_storyboard_revision_id,
            ppr.revision_number AS source_plan_revision_number,
            (SELECT d.decision FROM paper_asset_review_decisions d
             WHERE d.asset_version_id = pav.id ORDER BY d.id DESC LIMIT 1) AS latest_review_decision,
            (SELECT d.reviewer FROM paper_asset_review_decisions d
             WHERE d.asset_version_id = pav.id ORDER BY d.id DESC LIMIT 1) AS latest_reviewer,
            (SELECT COUNT(*) FROM paper_asset_review_decisions d
             WHERE d.asset_version_id = pav.id) AS review_decision_count
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots source_shot ON source_shot.id = psf.shot_id
     LEFT JOIN paper_plan_revisions ppr ON ppr.id = psf.plan_revision_id
     WHERE source_shot.paper_storyboard_id = ?
       AND source_shot.drama_id = ?
       AND pav.status = 'accepted'
       AND pav.id != COALESCE(?, 0)
       AND pas.asset_type = ?
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
     ORDER BY pav.accepted_at DESC, pav.id DESC`,
  ).all(
    Number(shot.paper_storyboard_id), Number(shot.drama_id),
    slot.current_version_id == null ? null : Number(slot.current_version_id), String(slot.asset_type),
  );
}

function historicalMatch(db, cfg, shot, slot) {
  const candidates = approvedHistoryCandidates(db, shot, slot);
  const inspected = candidates.map((candidate) => {
    const file = verifyVersionFile(cfg, candidate);
    const approved = candidate.latest_review_decision === 'approved';
    const trust = localTrustState(db, candidate);
    const sourceFingerprint = candidate.reuse_fingerprint || candidate.slot_reuse_fingerprint || null;
    const exact = approved && trust.trusted && file.pass
      && sourceFingerprint && sourceFingerprint === slot.reuse_fingerprint;
    const samePurpose = String(candidate.generation_purpose || '') === String(slot.generation_purpose || '');
    const reuseDecision = latestReuseReviewDecision(db, slot.id, candidate.id);
    return {
      candidate,
      file,
      approved,
      trust,
      reuse_decision: reuseDecision?.decision || null,
      match_kind: exact ? 'exact' : (approved && file.pass && samePurpose ? 'review' : 'blocked'),
      reasons: [
        ...(approved ? [] : ['source_not_approved']),
        ...(trust.trusted ? [] : ['import_trust_required']),
        ...(file.pass ? [] : [file.reason]),
        ...(sourceFingerprint === slot.reuse_fingerprint ? [] : ['visual_contract_changed']),
        ...(samePurpose ? [] : ['generation_purpose_changed']),
      ],
    };
  });
  const eligible = inspected.filter((item) => item.reuse_decision !== 'declined');
  const exact = eligible.find((item) => item.match_kind === 'exact');
  const review = eligible.find((item) => item.match_kind === 'review');
  const selected = exact || review || eligible[0] || null;
  if (!selected) return null;
  return {
    match_kind: selected.match_kind,
    source_asset_version_id: Number(selected.candidate.id),
    source_shot_id: Number(selected.candidate.source_shot_id),
    source_run_id: Number(selected.candidate.source_run_id),
    source_plan_revision_id: Number(selected.candidate.plan_revision_id),
    source_plan_revision_number: Number(selected.candidate.source_plan_revision_number || 0),
    source_storyboard_revision_id: Number(selected.candidate.source_storyboard_revision_id || 0) || null,
    preview_url: selected.file.local_path ? `/static/${String(selected.file.local_path).replace(/^\/+/, '')}` : null,
    file: selected.file,
    reasons: selected.reasons,
    compatibility_report: {
      fingerprint_match: selected.candidate.reuse_fingerprint === slot.reuse_fingerprint
        || selected.candidate.slot_reuse_fingerprint === slot.reuse_fingerprint,
      source_approved: selected.approved,
      source_locally_trusted: selected.trust.trusted,
      import_trust_state: selected.trust.review_required ? 'review_required' : 'trusted',
      latest_review_decision: selected.candidate.latest_review_decision || null,
      latest_reviewer: selected.candidate.latest_reviewer || null,
      file_verified: selected.file.pass,
      source_reuse_fingerprint: selected.candidate.reuse_fingerprint || selected.candidate.slot_reuse_fingerprint || null,
      target_reuse_fingerprint: slot.reuse_fingerprint || null,
      reasons: selected.reasons,
    },
  };
}

function classifySlot(db, cfg, shot, slot, { force = false } = {}) {
  if (!force && slot.current_version_id && slot.current_version?.status === 'accepted') {
    const trust = localTrustState(db, slot.current_version);
    if (trust.trusted) {
      return { source_kind: 'current', calls: 0, current_asset_version_id: Number(slot.current_version_id) };
    }
  }
  if (slot.asset_type === 'occlusion-mask' || slot.constraints_json?.derivation === 'registered_alpha_band'
      || (!slot.required_for_gate && slot.constraints_json?.fallback === 'procedural')) {
    return { source_kind: 'local_derivation', calls: 0 };
  }
  if (!force) {
    const reusableSource = assetProductionService.sourceForSlot(db, shot, slot);
    if (reusableSource?.source_kind === 'paper_library') {
      return {
        source_kind: 'paper_library', calls: 0,
        entity_id: Number(reusableSource.source_id),
        identity_version_id: Number(reusableSource.identity_version_id),
        entity_name: reusableSource.entity_name || null,
      };
    }
    // Existing storyboard references and legacy scene/character/prop files are
    // imported locally by produceSlot(). They must use the same zero-call
    // classification here; otherwise the quote reports 0 calls while the
    // reuse executor sees a paid slot and never materializes it.
    if (reusableSource) {
      return {
        source_kind: 'local_derivation',
        calls: 0,
        derivation_kind: 'source_import',
        local_source_kind: reusableSource.source_kind || 'existing_asset',
        local_source_id: reusableSource.source_id == null ? null : Number(reusableSource.source_id),
      };
    }
    const historical = historicalMatch(db, cfg, shot, slot);
    if (historical?.match_kind === 'exact') return { source_kind: 'historical_reuse', calls: 0, ...historical };
    if (historical?.match_kind === 'review') return { source_kind: 'history_review_required', calls: 1, ...historical };
    if (historical) return { source_kind: 'needs_image_api', calls: 1, blocked_history: true, ...historical };
  }
  return { source_kind: 'needs_image_api', calls: 1 };
}

function selectedShots(run, body = {}) {
  const wanted = body.shot_ids?.length ? new Set(body.shot_ids.map(Number)) : null;
  const shots = run.shots.filter((shot) => !wanted || wanted.has(Number(shot.id)));
  if (wanted && shots.length !== wanted.size) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_OWNERSHIP_MISMATCH', '部分镜头不属于当前生产版本', { shot_ids: body.shot_ids }, 409);
  }
  return shots;
}

function buildReusePreview(db, cfg, runId, body = {}) {
  const run = runService.get(db, runId);
  if (body.expected_version != null) assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  const shots = selectedShots(run, body);
  const wantedSlots = body.slot_ids?.length ? new Set(body.slot_ids.map(Number)) : null;
  const slots = shots.flatMap((summary) => {
    const shot = shotService.get(db, summary.id);
    return shot.families.flatMap((family) => family.slots.map((slot) => ({
      slot,
      shot,
      family,
    })));
  }).filter(({ slot }) => !wantedSlots || wantedSlots.has(Number(slot.id)));
  if (wantedSlots && slots.length !== wantedSlots.size) {
    throw new PaperStudioError('PAPER_STUDIO_REUSE_PREVIEW_SLOT_INVALID', '部分素材槽位不属于当前计划', { slot_ids: [...wantedSlots] }, 409);
  }
  const force = Boolean(body.force_regeneration || wantedSlots);
  const classified = slots.map(({ slot, shot, family }) => ({
    slot_id: Number(slot.id),
    shot_id: Number(shot.id),
    plan_revision_id: Number(shot.current_plan_revision_id),
    family_key: family.family_key,
    slot_key: slot.slot_key,
    asset_type: slot.asset_type,
    generation_purpose: slot.generation_purpose,
    required: Boolean(slot.required_for_gate),
    reuse_fingerprint: slot.reuse_fingerprint || null,
    ...classifySlot(db, cfg, shot, slot, { force }),
  }));
  const count = (kind) => classified.filter((slot) => slot.source_kind === kind).length;
  const core = {
    run_id: Number(run.id),
    run_version: Number(run.version),
    shot_plan_revisions: shots.map((shot) => ({
      shot_id: Number(shot.id),
      plan_revision_id: Number(shot.current_plan_revision_id || 0),
      shot_version: Number(shot.version),
    })),
    required_slot_count: classified.length,
    current_reuse_count: count('current'),
    history_reuse_count: count('historical_reuse'),
    history_review_count: count('history_review_required'),
    blocked_history_count: classified.filter((slot) => slot.source_kind === 'needs_image_api' && slot.match_kind === 'blocked').length,
    library_reuse_count: count('paper_library'),
    local_derivation_count: count('local_derivation'),
    estimated_image_count: classified.filter((slot) => Number(slot.calls || 0) > 0).length,
    provider_call_min: count('needs_image_api'),
    provider_call_max: classified.filter((slot) => Number(slot.calls || 0) > 0).length,
    force_regeneration: force,
    slots: classified,
  };
  return { ...core, reuse_preview_fingerprint: `sha256:${sha256(canonicalJson(core))}` };
}

function nextAttempt(db, slotId) {
  return Number(db.prepare(
    'SELECT COALESCE(MAX(attempt_index), 0) + 1 AS value FROM paper_asset_versions WHERE slot_id = ?',
  ).get(Number(slotId)).value);
}

async function applyReviewDecisions(db, cfg, log, runId, body = {}) {
  if (!reuseReviewDecisionTableReady(db)) {
    throw new PaperStudioError(
      'PAPER_HISTORY_MIGRATION_REQUIRED',
      '人工复用选择需要 migration 45，请先完成数据库迁移',
      { migration_id: '45_paper_storyboard_history_fork' },
      503,
    );
  }
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  const requestId = String(body.request_id || '').trim();
  if (!requestId) throw new PaperStudioError('PAPER_STUDIO_REQUEST_ID_REQUIRED', '处理历史候选需要 request_id', null, 400);
  const existing = db.prepare(
    'SELECT * FROM paper_asset_reuse_review_decisions WHERE run_id = ? AND request_id = ? ORDER BY id',
  ).all(Number(run.id), requestId);
  if (existing.length) {
    return { run, review_decisions: existing, reused: [], deduplicated: true, provider_call_delta: 0 };
  }
  if (body.confirmation?.actor !== 'local_owner' || body.confirmation?.reason !== 'historical_review_reuse_confirmed') {
    throw new PaperStudioError(
      'PAPER_STUDIO_REUSE_USER_CONFIRMATION_REQUIRED',
      '请逐张查看历史候选并明确选择采用或改为差异生成',
      null,
      400,
    );
  }
  const preview = buildReusePreview(db, cfg, run.id, {
    expected_version: run.version,
    ...(body.shot_ids?.length ? { shot_ids: body.shot_ids } : {}),
  });
  if (preview.reuse_preview_fingerprint !== body.reuse_preview_fingerprint) {
    throw new PaperStudioError(
      'PAPER_STUDIO_REUSE_PREVIEW_STALE',
      '计划、历史候选或文件已经变化，请重新预览',
      { expected: preview.reuse_preview_fingerprint, actual: body.reuse_preview_fingerprint },
      409,
    );
  }
  const reviewSlots = preview.slots.filter((slot) => slot.source_kind === 'history_review_required');
  const decisions = Array.isArray(body.review_decisions) ? body.review_decisions : [];
  const bySlot = new Map(decisions.map((decision) => [Number(decision.slot_id), decision]));
  if (!reviewSlots.length || bySlot.size !== reviewSlots.length || reviewSlots.some((slot) => {
    const decision = bySlot.get(Number(slot.slot_id));
    return !decision
      || Number(decision.source_asset_version_id) !== Number(slot.source_asset_version_id)
      || !['accepted', 'declined'].includes(decision.decision);
  })) {
    throw new PaperStudioError(
      'PAPER_STUDIO_REUSE_REVIEW_INCOMPLETE',
      '必须对当前预览中的每一张历史候选选择采用或改为差异生成',
      { required_slot_ids: reviewSlots.map((slot) => slot.slot_id) },
      400,
    );
  }
  const callsBefore = providerCallCount(db, run.id);
  const now = nowIso();
  const reused = [];
  db.transaction(() => {
    for (const target of reviewSlots) {
      const choice = bySlot.get(Number(target.slot_id));
      db.prepare(
        `INSERT INTO paper_asset_reuse_review_decisions
          (run_id, shot_id, target_slot_id, source_asset_version_id,
           decision, reason, actor, preview_fingerprint, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Number(run.id), Number(target.shot_id), Number(target.slot_id),
        Number(target.source_asset_version_id), choice.decision,
        choice.decision === 'accepted' ? 'historical_review_reuse_confirmed' : 'generate_difference_instead',
        body.confirmation.actor, preview.reuse_preview_fingerprint, requestId, now,
      );
      if (choice.decision !== 'accepted') continue;
      const slot = db.prepare('SELECT * FROM paper_asset_slots WHERE id = ?').get(Number(target.slot_id));
      const source = db.prepare(
        `SELECT pav.*, pas.generation_purpose AS source_generation_purpose
         FROM paper_asset_versions pav
         JOIN paper_asset_slots pas ON pas.id = pav.slot_id
         WHERE pav.id = ?`,
      ).get(Number(target.source_asset_version_id));
      const latestReview = latestReviewDecision(db, source.id);
      const file = verifyVersionFile(cfg, source);
      const targetShot = db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(Number(target.shot_id));
      if (source.status !== 'accepted' || latestReview?.decision !== 'approved' || !file.pass
        || String(source.source_generation_purpose || '') !== String(slot.generation_purpose || '')
        || !['plan_confirmed', 'asset_failed', 'asset_review'].includes(String(targetShot?.status || ''))) {
        throw new PaperStudioError(
          'PAPER_STUDIO_REUSE_SOURCE_CHANGED',
          '人工确认的历史候选已不满足复用条件，请重新预览',
          { slot_id: Number(slot.id), source_asset_version_id: Number(source.id), file },
          409,
        );
      }
      const versionId = Number(db.prepare(
        `INSERT INTO paper_asset_versions
          (slot_id, source_family_id, parent_version_id, attempt_index, derivation_kind,
           source_local_path, alpha_local_path, mask_local_path, source_hash, alpha_hash,
           mask_hash, reuse_fingerprint, processing_json, registration_json, provenance_json,
           quality_report_json, status, created_at, accepted_at)
         VALUES (?, ?, ?, ?, 'historical_reuse_reviewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        Number(slot.id), Number(slot.family_id), Number(source.id), nextAttempt(db, slot.id),
        source.source_local_path, source.alpha_local_path, source.mask_local_path,
        source.source_hash, source.alpha_hash, source.mask_hash, slot.reuse_fingerprint,
        JSON.stringify({ ...parseJson(source.processing_json, {}), source: 'historical_reuse_reviewed' }),
        source.registration_json || '{}',
        JSON.stringify({
          request_id: requestId, preview_fingerprint: preview.reuse_preview_fingerprint,
          source_asset_version_id: Number(source.id), reuse_kind: 'historical_review_confirmed',
          confirmation: { actor: body.confirmation.actor, reason: body.confirmation.reason },
        }),
        JSON.stringify({ ...parseJson(source.quality_report_json, {}), inherited_from_asset_version_id: Number(source.id) }),
        now, now,
      ).lastInsertRowid);
      db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?")
        .run(versionId, now, Number(slot.id));
      db.prepare("UPDATE paper_source_families SET status = 'review', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, Number(slot.family_id));
      db.prepare(
        `INSERT INTO paper_asset_review_decisions
          (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`,
      ).run(
        Number(target.shot_id), Number(slot.id), versionId,
        'historical_review_reuse_confirmed: 用户逐张确认采用历史候选',
        body.confirmation.actor, `${requestId}:${slot.id}`, now,
      );
      db.prepare(
        `INSERT INTO paper_asset_reuse_links
          (source_asset_version_id, target_asset_version_id, target_shot_id, target_slot_id,
           match_kind, compatibility_report_json, source_file_hash, preview_fingerprint,
           request_id, created_at)
         VALUES (?, ?, ?, ?, 'review', ?, ?, ?, ?, ?)`,
      ).run(
        Number(source.id), versionId, Number(target.shot_id), Number(slot.id),
        JSON.stringify(target.compatibility_report || {}), file.actual_hash,
        preview.reuse_preview_fingerprint, requestId, now,
      );
      reused.push({ slot_id: Number(slot.id), source_asset_version_id: Number(source.id), target_asset_version_id: versionId });
    }
    const affectedShotIds = [...new Set(reviewSlots.map((slot) => Number(slot.shot_id)))];
    for (const shotId of affectedShotIds) {
      db.prepare('UPDATE paper_studio_shots SET version = version + 1, updated_at = ? WHERE id = ?').run(now, shotId);
    }
    db.prepare('UPDATE paper_studio_runs SET version = version + 1, updated_at = ? WHERE id = ?').run(now, Number(run.id));
    const callsAfter = providerCallCount(db, run.id);
    if (callsAfter !== callsBefore) {
      throw new PaperStudioError(
        'PAPER_STUDIO_ZERO_CALL_INVARIANT_BROKEN',
        '人工确认历史候选意外改变了图片调用账本',
        { before: callsBefore, after: callsAfter },
        500,
      );
    }
  })();
  if (log) log.info('Paper studio historical review candidates resolved', {
    run_id: Number(run.id), reviewed_count: reviewSlots.length, reused_count: reused.length,
  });
  return {
    run: runService.get(db, run.id), review_decisions: decisions, reused,
    deduplicated: false, provider_call_delta: 0,
  };
}

async function applyReusePreview(db, cfg, log, runId, body = {}) {
  if (Array.isArray(body.review_decisions) && body.review_decisions.length) {
    return applyReviewDecisions(db, cfg, log, runId, body);
  }
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (!String(body.request_id || '').trim()) throw new PaperStudioError('PAPER_STUDIO_REQUEST_ID_REQUIRED', '应用历史素材需要 request_id', null, 400);
  const existing = db.prepare(
    'SELECT target_shot_id FROM paper_asset_reuse_links WHERE request_id = ? ORDER BY id',
  ).all(String(body.request_id));
  if (existing.length) return { run, reused: [], deduplicated: true, provider_call_delta: 0 };
  const preview = buildReusePreview(db, cfg, run.id, {
    expected_version: run.version,
    ...(body.shot_ids?.length ? { shot_ids: body.shot_ids } : {}),
  });
  if (preview.reuse_preview_fingerprint !== body.reuse_preview_fingerprint) {
    throw new PaperStudioError(
      'PAPER_STUDIO_REUSE_PREVIEW_STALE',
      '计划、历史素材或文件已经变化，请重新预览复用清单',
      { expected: preview.reuse_preview_fingerprint, actual: body.reuse_preview_fingerprint },
      409,
    );
  }
  const chosen = new Set((body.slot_ids?.length
    ? body.slot_ids
    : preview.slots.filter((slot) => slot.source_kind === 'historical_reuse').map((slot) => slot.slot_id)).map(Number));
  const targets = preview.slots.filter((slot) => chosen.has(Number(slot.slot_id)));
  if (targets.length !== chosen.size || targets.some((slot) => slot.source_kind !== 'historical_reuse' || slot.match_kind !== 'exact')) {
    throw new PaperStudioError('PAPER_STUDIO_REUSE_SELECTION_INVALID', '只能应用预览中精确匹配且文件完整的历史素材', { slot_ids: [...chosen] }, 409);
  }
  let confirmation = null;
  if (targets.length) {
    confirmation = body.confirmation || null;
    const actor = String(confirmation?.actor || '').trim();
    const reason = String(confirmation?.reason || '').trim();
    const confirmedSources = new Set((confirmation?.source_asset_version_ids || []).map(Number));
    if (actor !== 'local_owner'
      || reason !== 'historical_exact_reuse_confirmed'
      || confirmedSources.size !== targets.length
      || targets.some((target) => !confirmedSources.has(Number(target.source_asset_version_id)))) {
      throw new PaperStudioError(
        'PAPER_STUDIO_REUSE_USER_CONFIRMATION_REQUIRED',
        '应用历史素材需要用户在复用预览中明确确认所选图片',
        { required_actor: 'local_owner', required_reason: 'historical_exact_reuse_confirmed' },
        400,
      );
    }
  }
  const callsBefore = providerCallCount(db, run.id);
  const now = nowIso();
  const reused = [];
  db.transaction(() => {
    for (const target of targets) {
      const slot = db.prepare('SELECT * FROM paper_asset_slots WHERE id = ?').get(Number(target.slot_id));
      const source = db.prepare(
        `SELECT pav.*, pas.reuse_fingerprint AS source_slot_reuse_fingerprint
         FROM paper_asset_versions pav
         JOIN paper_asset_slots pas ON pas.id = pav.slot_id
         WHERE pav.id = ?`,
      ).get(Number(target.source_asset_version_id));
      const file = verifyVersionFile(cfg, source);
      const latestReview = latestReviewDecision(db, source.id);
      const trust = localTrustState(db, source);
      const targetShot = db.prepare('SELECT id, status FROM paper_studio_shots WHERE id = ?').get(Number(target.shot_id));
      const targetStateAllowed = ['plan_confirmed', 'asset_failed', 'asset_review'].includes(String(targetShot?.status || ''));
      const sourceFingerprint = source.reuse_fingerprint || source.source_slot_reuse_fingerprint || null;
      if (!file.pass || source.status !== 'accepted' || latestReview?.decision !== 'approved' || !trust.trusted
        || slot.reuse_fingerprint !== sourceFingerprint || !targetStateAllowed) {
        throw new PaperStudioError('PAPER_STUDIO_REUSE_SOURCE_CHANGED', '历史素材已不满足复用条件，请重新预览', {
          slot_id: Number(slot.id), source_asset_version_id: Number(source.id), file,
          latest_review_decision: latestReview?.decision || null,
          import_trust_state: trust.review_required ? 'review_required' : 'trusted',
          target_shot_status: targetShot?.status || null,
        }, 409);
      }
      const versionResult = db.prepare(
        `INSERT INTO paper_asset_versions
          (slot_id, source_family_id, parent_version_id, attempt_index, derivation_kind,
           source_local_path, alpha_local_path, mask_local_path, source_hash, alpha_hash,
           mask_hash, reuse_fingerprint, processing_json, registration_json, provenance_json,
           quality_report_json, status, created_at, accepted_at)
         VALUES (?, ?, ?, ?, 'historical_reuse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        Number(slot.id), Number(slot.family_id), Number(source.id), nextAttempt(db, slot.id),
        source.source_local_path, source.alpha_local_path, source.mask_local_path,
        source.source_hash, source.alpha_hash, source.mask_hash, slot.reuse_fingerprint,
        JSON.stringify({ ...parseJson(source.processing_json, {}), source: 'historical_reuse' }),
        source.registration_json || '{}',
        JSON.stringify({
          request_id: body.request_id,
          preview_fingerprint: preview.reuse_preview_fingerprint,
          source_asset_version_id: Number(source.id),
          reuse_kind: 'historical_exact',
          confirmation: { actor: confirmation.actor, reason: confirmation.reason },
        }),
        JSON.stringify({ ...parseJson(source.quality_report_json, {}), inherited_from_asset_version_id: Number(source.id) }),
        now, now,
      );
      const versionId = Number(versionResult.lastInsertRowid);
      db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?")
        .run(versionId, now, Number(slot.id));
      db.prepare("UPDATE paper_source_families SET status = 'review', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, Number(slot.family_id));
      db.prepare(
        `INSERT INTO paper_asset_review_decisions
          (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`,
      ).run(
        Number(target.shot_id), Number(slot.id), versionId,
        'historical_exact_reuse_confirmed: 用户在复用预览中明确确认采用精确匹配历史图',
        confirmation.actor, `${body.request_id}:${slot.id}`, now,
      );
      db.prepare(
        `INSERT INTO paper_asset_reuse_links
          (source_asset_version_id, target_asset_version_id, target_shot_id, target_slot_id,
           match_kind, compatibility_report_json, source_file_hash, preview_fingerprint,
           request_id, created_at)
         VALUES (?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?)`,
      ).run(
        Number(source.id), versionId, Number(target.shot_id), Number(slot.id),
        JSON.stringify(target.compatibility_report || {}), file.actual_hash,
        preview.reuse_preview_fingerprint, body.request_id, now,
      );
      reused.push({ slot_id: Number(slot.id), source_asset_version_id: Number(source.id), target_asset_version_id: versionId });
    }
    for (const shotId of new Set(reused.map((item) => preview.slots.find((slot) => slot.slot_id === item.slot_id).shot_id))) {
      db.prepare("UPDATE paper_studio_shots SET version = version + 1, updated_at = ? WHERE id = ?").run(now, Number(shotId));
    }
    db.prepare('UPDATE paper_studio_runs SET version = version + 1, updated_at = ? WHERE id = ?').run(now, Number(run.id));
  })();
  const zeroCallShotIds = [...new Set(preview.slots.map((slot) => Number(slot.shot_id)))].filter((shotId) => (
    !preview.slots.some((slot) => Number(slot.shot_id) === shotId && Number(slot.calls || 0) > 0)
  ));
  const materialized = [];
  for (const shotId of zeroCallShotIds) {
    const current = shotService.get(db, shotId);
    if (!['plan_confirmed', 'asset_failed', 'asset_review'].includes(current.status)) continue;
    materialized.push(await assetProductionService.materializeZeroCallSlots(db, cfg, log, shotId, {
      request_id: randomUUID(),
      expected_version: current.version,
    }));
  }
  const callsAfter = providerCallCount(db, run.id);
  if (callsAfter !== callsBefore) {
    throw new PaperStudioError('PAPER_STUDIO_ZERO_CALL_INVARIANT_BROKEN', '历史素材复用产生了意外图片调用账本变化', { before: callsBefore, after: callsAfter }, 500);
  }
  if (log) log.info('Paper studio historical assets reused', { run_id: Number(run.id), reused_count: reused.length, provider_call_delta: 0 });
  return { run: runService.get(db, run.id), reused, materialized_shot_ids: materialized.map((item) => Number(item.shot.id)), deduplicated: false, provider_call_delta: 0 };
}

module.exports = {
  providerCallCount,
  verifyVersionFile,
  latestReviewDecision,
  localTrustState,
  latestReuseReviewDecision,
  historicalMatch,
  buildReusePreview,
  applyReusePreview,
  applyReviewDecisions,
};
