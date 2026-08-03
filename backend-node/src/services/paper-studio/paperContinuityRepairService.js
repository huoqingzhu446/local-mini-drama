const motionGateService = require('./paperMotionGateService');
const motionNaturalizer = require('./paperMotionNaturalizerService');
const reuseService = require('./paperAssetReuseService');
const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const runService = require('./paperStudioRunService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');
const { resolveTrackValue } = require('../../paper-studio-renderer/motion/trackResolver.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestedMotionPlan(shot, body = {}) {
  const motionPlan = clone(body.motion_plan || shot.motion_plan?.plan_json || null);
  if (!motionPlan) throw new PaperStudioError('PAPER_STUDIO_CONTINUITY_REPAIR_PLAN_REQUIRED', '当前镜头还没有可修复的动作计划', { shot_id: Number(shot.id) }, 409);
  schemaService.assertValid('motionPlan', motionPlan, '连续性修复后的动作计划不符合 Schema');
  return motionPlan;
}

function currentAssetRows(db, shot) {
  return db.prepare(
    `SELECT pas.id AS slot_id, pas.slot_key, pas.asset_type, pas.generation_purpose,
            pas.reuse_fingerprint AS target_reuse_fingerprint,
            pas.current_version_id, psf.id AS family_id,
            pav.*
     FROM paper_source_families psf
     JOIN paper_asset_slots pas ON pas.family_id = psf.id
     LEFT JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ? AND psf.plan_revision_id = ?
       AND psf.deleted_at IS NULL AND pas.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shot.id), Number(shot.current_plan_revision_id));
}

const REPAIRABLE_STATES = new Set([
  'asset_ready', 'motion_ready', 'motion_failed', 'proof_ready', 'proof_failed',
  'preview_ready', 'approved', 'render_failed', 'rendered',
]);

function formalRenderActivity(db, shot) {
  const step = db.prepare(
    `SELECT id FROM paper_job_steps
     WHERE shot_id = ? AND plan_revision_id = ? AND step_key = 'render_formal'
       AND status = 'running'
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(shot.id), Number(shot.current_plan_revision_id));
  const video = db.prepare(
    `SELECT id FROM video_generations
     WHERE paper_studio_shot_id = ? AND generation_kind = 'paper_studio'
       AND status = 'processing' AND deleted_at IS NULL
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(shot.id));
  return {
    active: Boolean(step || video),
    job_step_id: step ? Number(step.id) : null,
    video_generation_id: video ? Number(video.id) : null,
  };
}

function repairability(db, shot) {
  const status = String(shot.status || '');
  if (REPAIRABLE_STATES.has(status)) return { pass: true, status };
  if (status === 'rendering') {
    const activity = formalRenderActivity(db, shot);
    if (!activity.active) {
      return {
        pass: true,
        status,
        recovered_stranded_render: true,
        message: '正式渲染已中断，可安全废弃旧临时任务并派生零调用修复计划',
      };
    }
    return {
      pass: false,
      status,
      code: 'PAPER_STUDIO_CONTINUITY_REPAIR_RENDER_ACTIVE',
      message: '正式渲染仍在运行，请等待完成或服务完成中断恢复后再应用零调用修复',
      ...activity,
    };
  }
  return {
    pass: false,
    status,
    code: 'PAPER_STUDIO_CONTINUITY_REPAIR_TARGET_STATE_INVALID',
    message: status === 'published'
      ? '已发布镜头不能改写当前生产版本，请新建生产版本并复用历史素材'
      : '当前镜头状态不允许派生连续性修复计划',
  };
}

function preview(db, cfg, shotId, body = {}) {
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  const proposed = requestedMotionPlan(shot, body);
  const naturalized = motionNaturalizer.naturalize(
    proposed,
    motionNaturalizer.motionQualityFromConfig(cfg),
    resolveTrackValue,
  );
  const gate = motionGateService.evaluate(naturalized, shot.plan_summary_json || {});
  const assets = currentAssetRows(db, shot);
  const inspected = assets.map((asset) => {
    const file = asset.id == null ? null : reuseService.verifyVersionFile(cfg, asset);
    const latestReview = asset.id == null ? null : reuseService.latestReviewDecision(db, asset.id);
    const trust = asset.id == null ? null : reuseService.localTrustState(db, asset);
    const fingerprintMatch = asset.id != null
      && Boolean(asset.reuse_fingerprint)
      && asset.reuse_fingerprint === asset.target_reuse_fingerprint;
    const reusable = asset.id != null
      && asset.status === 'accepted'
      && latestReview?.decision === 'approved'
      && trust?.trusted
      && file?.pass
      && fingerprintMatch;
    return {
      slot_id: Number(asset.slot_id),
      slot_key: asset.slot_key,
      current_version_id: asset.current_version_id == null ? null : Number(asset.current_version_id),
      asset_version_id: asset.id == null ? null : Number(asset.id),
      source_status: asset.status || null,
      latest_review_decision: latestReview?.decision || null,
      latest_reviewer: latestReview?.reviewer || null,
      import_trust_state: trust?.review_required ? 'review_required' : 'trusted',
      fingerprint_match: fingerprintMatch,
      file,
      reusable,
      reasons: [
        ...(asset.id == null ? ['source_missing'] : []),
        ...(asset.id == null || asset.status === 'accepted' ? [] : ['source_not_accepted']),
        ...(asset.id == null || latestReview?.decision === 'approved' ? [] : ['source_not_approved']),
        ...(asset.id == null || trust?.trusted ? [] : ['import_trust_required']),
        ...(asset.id == null || file?.pass ? [] : [file?.reason || 'file_not_verified']),
        ...(asset.id == null || fingerprintMatch ? [] : ['visual_contract_changed']),
      ],
    };
  });
  const invalid = inspected.filter((asset) => asset.asset_version_id && !asset.reusable);
  const missing = inspected.filter((asset) => asset.current_version_id == null);
  const assetDiff = {
    preserved_asset_count: inspected.filter((asset) => asset.reusable).length,
    history_reuse_count: 0,
    invalidated_asset_count: invalid.length,
    added_slot_count: 0,
    missing_slot_count: missing.length,
    image_api_calls: 0,
    slots: inspected,
  };
  const core = {
    shot_id: Number(shot.id),
    shot_version: Number(shot.version),
    run_id: Number(shot.run_id),
    source_plan_revision_id: Number(shot.current_plan_revision_id),
    proposed_motion_plan: naturalized,
    gate,
    asset_diff: assetDiff,
    repairability: repairability(db, shot),
    provider_call_count: reuseService.providerCallCount(db, shot.run_id),
  };
  return {
    ...core,
    can_apply_zero_call: core.repairability.pass && gate.pass && invalid.length === 0,
    preview_fingerprint: `sha256:${sha256(canonicalJson(core))}`,
  };
}

function clonePlanStructures(db, cfg, shot, proposedMotionPlan, planHash, now, {
  requestId,
  previewFingerprint,
  confirmation,
} = {}) {
  const sourcePlanId = Number(shot.current_plan_revision_id);
  const nextRevision = db.prepare(
    'SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM paper_plan_revisions WHERE shot_id = ?',
  ).get(Number(shot.id));
  const revisionResult = db.prepare(
    `INSERT INTO paper_plan_revisions
      (shot_id, revision_number, blueprint_revision_id, plan_hash, status,
       transition_report_json, created_from, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, 'confirmed', ?, 'continuity_repair', ?, ?)`,
  ).run(
    Number(shot.id), Number(nextRevision.value), shot.blueprint_revision_id || null,
    planHash, JSON.stringify({ repaired: true }), now, now,
  );
  const targetPlanId = Number(revisionResult.lastInsertRowid);
  db.prepare("UPDATE paper_plan_revisions SET status = 'superseded', superseded_at = ? WHERE id = ?")
    .run(now, sourcePlanId);
  db.prepare("UPDATE paper_source_families SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ?")
    .run(now, sourcePlanId);
  db.prepare("UPDATE paper_asset_slots SET status = 'superseded', updated_at = ? WHERE family_id IN (SELECT id FROM paper_source_families WHERE plan_revision_id = ?)")
    .run(now, sourcePlanId);
  db.prepare("UPDATE paper_composition_nodes SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ?")
    .run(now, sourcePlanId);
  db.prepare("UPDATE paper_motion_plans SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ?")
    .run(now, sourcePlanId);
  db.prepare("UPDATE paper_job_steps SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE plan_revision_id = ?")
    .run(now, sourcePlanId);

  const familyMap = new Map();
  const slotMap = new Map();
  const versionMap = new Map();
  const sourceFamilies = db.prepare(
    'SELECT * FROM paper_source_families WHERE plan_revision_id = ? ORDER BY id',
  ).all(sourcePlanId);
  for (const family of sourceFamilies) {
    const familyResult = db.prepare(
      `INSERT INTO paper_source_families
        (shot_id, plan_revision_id, family_key, pattern, registration_canvas_json,
         contract_json, context_snapshot_id, provider_signature, status, version,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)`,
    ).run(
      Number(shot.id), targetPlanId, family.family_key, family.pattern,
      family.registration_canvas_json, family.contract_json,
      family.context_snapshot_id, family.provider_signature, now, now,
    );
    const targetFamilyId = Number(familyResult.lastInsertRowid);
    familyMap.set(Number(family.id), targetFamilyId);
    const slots = db.prepare('SELECT * FROM paper_asset_slots WHERE family_id = ? ORDER BY id').all(Number(family.id));
    for (const slot of slots) {
      const slotResult = db.prepare(
        `INSERT INTO paper_asset_slots
          (family_id, slot_key, asset_type, generation_purpose, constraints_json,
           required_for_gate, reuse_fingerprint, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        targetFamilyId, slot.slot_key, slot.asset_type, slot.generation_purpose,
        slot.constraints_json, Number(slot.required_for_gate), slot.reuse_fingerprint,
        slot.current_version_id ? 'ready' : 'planned', now, now,
      );
      const targetSlotId = Number(slotResult.lastInsertRowid);
      slotMap.set(Number(slot.id), targetSlotId);
      if (!slot.current_version_id) continue;
      const source = db.prepare('SELECT * FROM paper_asset_versions WHERE id = ?').get(Number(slot.current_version_id));
      const file = reuseService.verifyVersionFile(cfg, source);
      const latestReview = reuseService.latestReviewDecision(db, source.id);
      const trust = reuseService.localTrustState(db, source);
      const fingerprintMatch = Boolean(source.reuse_fingerprint)
        && source.reuse_fingerprint === slot.reuse_fingerprint;
      if (source.status !== 'accepted' || latestReview?.decision !== 'approved'
          || !trust.trusted || !file.pass || !fingerprintMatch) {
        throw new PaperStudioError(
          'PAPER_STUDIO_CONTINUITY_REPAIR_SOURCE_INVALID',
          '连续性修复引用的历史素材已不满足保留条件，请重新预览',
          {
            source_asset_version_id: Number(source.id),
            source_status: source.status,
            latest_review_decision: latestReview?.decision || null,
            import_trust_state: trust.review_required ? 'review_required' : 'trusted',
            file,
            fingerprint_match: fingerprintMatch,
          },
          409,
        );
      }
      const compatibilityReport = {
        continuity_repair: true,
        fingerprint_match: fingerprintMatch,
        file_verified: file.pass,
        source_approved: latestReview?.decision === 'approved',
        source_locally_trusted: trust.trusted,
        latest_reviewer: latestReview?.reviewer || null,
        source_reuse_fingerprint: source.reuse_fingerprint || null,
        target_reuse_fingerprint: slot.reuse_fingerprint || null,
        reasons: [],
      };
      const targetVersionResult = db.prepare(
        `INSERT INTO paper_asset_versions
          (slot_id, source_family_id, parent_version_id, attempt_index, derivation_kind,
           source_local_path, alpha_local_path, mask_local_path, source_hash, alpha_hash,
           mask_hash, reuse_fingerprint, processing_json, registration_json, provenance_json,
           quality_report_json, status, created_at, accepted_at)
         VALUES (?, ?, ?, 1, 'historical_reuse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      ).run(
        targetSlotId, targetFamilyId, Number(source.id), source.source_local_path,
        source.alpha_local_path, source.mask_local_path, source.source_hash,
        source.alpha_hash, source.mask_hash, slot.reuse_fingerprint,
        JSON.stringify({ ...parseJson(source.processing_json, {}), source: 'continuity_repair_reuse' }),
        source.registration_json || '{}',
        JSON.stringify({
          request_id: requestId,
          preview_fingerprint: previewFingerprint,
          source_asset_version_id: Number(source.id),
          reuse_kind: 'continuity_repair',
          confirmation: { actor: confirmation.actor, reason: confirmation.reason },
        }),
        source.quality_report_json || '{}', now, now,
      );
      const targetVersionId = Number(targetVersionResult.lastInsertRowid);
      versionMap.set(Number(source.id), targetVersionId);
      db.prepare('UPDATE paper_asset_slots SET current_version_id = ? WHERE id = ?').run(targetVersionId, targetSlotId);
      db.prepare(
        `INSERT INTO paper_asset_reuse_links
          (source_asset_version_id, target_asset_version_id, target_shot_id, target_slot_id,
           match_kind, compatibility_report_json, source_file_hash,
           preview_fingerprint, request_id, created_at)
         VALUES (?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?)`,
      ).run(
        Number(source.id), targetVersionId, Number(shot.id), targetSlotId,
        JSON.stringify(compatibilityReport), file.actual_hash,
        previewFingerprint, requestId, now,
      );
      db.prepare(
        `INSERT INTO paper_asset_review_decisions
          (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`,
      ).run(
        Number(shot.id), targetSlotId, targetVersionId,
        'continuity_exact_reuse_confirmed: 用户确认连续性修复保留精确匹配素材',
        confirmation.actor, `${requestId}:${targetSlotId}`, now,
      );
    }
  }

  const sourceNodes = db.prepare(
    'SELECT * FROM paper_composition_nodes WHERE plan_revision_id = ? ORDER BY id',
  ).all(sourcePlanId);
  const nodeMap = new Map();
  for (const node of sourceNodes) {
    const result = db.prepare(
      `INSERT INTO paper_composition_nodes
        (shot_id, plan_revision_id, node_key, parent_node_id, node_kind, pattern,
         slot, asset_version_id, transform_json, relation_json, clip_json, local_z,
         status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)`,
    ).run(
      Number(shot.id), targetPlanId, node.node_key,
      node.parent_node_id == null ? null : nodeMap.get(Number(node.parent_node_id)),
      node.node_kind, node.pattern, node.slot,
      node.asset_version_id == null ? null : (versionMap.get(Number(node.asset_version_id)) || null),
      node.transform_json, node.relation_json, node.clip_json, Number(node.local_z), now, now,
    );
    nodeMap.set(Number(node.id), Number(result.lastInsertRowid));
  }
  const sourceMotion = db.prepare('SELECT * FROM paper_motion_plans WHERE plan_revision_id = ?').get(sourcePlanId);
  db.prepare(
    `INSERT INTO paper_motion_plans
      (shot_id, plan_revision_id, schema_version, semantic_contract_hash, timing_hash,
       plan_json, compiled_tracks_json, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 'confirmed', 1, ?, ?)`,
  ).run(
    Number(shot.id), targetPlanId, Number(proposedMotionPlan.schema_version || sourceMotion?.schema_version || 1),
    sourceMotion.semantic_contract_hash,
    sha256(canonicalJson({ fps: proposedMotionPlan.fps, duration_frames: proposedMotionPlan.duration_frames, cues: proposedMotionPlan.cues || [] })),
    JSON.stringify(proposedMotionPlan), now, now,
  );
  const sourceStepRows = db.prepare('SELECT * FROM paper_job_steps WHERE plan_revision_id = ? ORDER BY id').all(sourcePlanId);
  const sourceSteps = [...new Map(sourceStepRows.map((step) => [step.step_key, step])).values()];
  for (const step of sourceSteps) {
    const completed = ['analyze_shot', 'plan_families', 'generate_layout_master', 'generate_required_slots', 'matte_assets', 'register_assets', 'technical_asset_gate', 'asset_gate'].includes(step.step_key);
    db.prepare(
      `INSERT INTO paper_job_steps
        (run_id, shot_id, plan_revision_id, step_key, input_hash, depends_on_json,
         status, attempt, max_attempts, result_json, error_json, started_at,
         completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '{}', ?, ?, ?, ?)`,
    ).run(
      Number(shot.run_id), Number(shot.id), targetPlanId, step.step_key,
      sha256(canonicalJson({ plan_hash: planHash, step_key: step.step_key })),
      step.depends_on_json, completed ? 'completed' : 'queued', Number(step.max_attempts || 2),
      completed ? step.result_json : '{}', completed ? now : null, completed ? now : null, now, now,
    );
  }
  return targetPlanId;
}

function apply(db, cfg, log, shotId, body = {}) {
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!String(body.request_id || '').trim()) throw new PaperStudioError('PAPER_STUDIO_REQUEST_ID_REQUIRED', '应用连续性修复需要 request_id', null, 400);
  const stateGate = repairability(db, shot);
  if (!stateGate.pass) {
    throw new PaperStudioError(
      stateGate.code,
      stateGate.message,
      { shot_id: Number(shot.id), ...stateGate },
      409,
    );
  }
  const duplicate = db.prepare(
    'SELECT target_plan_revision_id FROM paper_continuity_repair_audits WHERE shot_id = ? AND request_id = ?',
  ).get(Number(shot.id), body.request_id);
  if (duplicate) return { shot, target_plan_revision_id: Number(duplicate.target_plan_revision_id), deduplicated: true, provider_call_delta: 0 };
  const currentPreview = preview(db, cfg, shot.id, { expected_version: shot.version, motion_plan: body.motion_plan });
  if (currentPreview.preview_fingerprint !== body.preview_fingerprint) {
    throw new PaperStudioError('PAPER_STUDIO_CONTINUITY_REPAIR_PREVIEW_STALE', '镜头、计划或素材已经变化，请重新预览修复', { expected: currentPreview.preview_fingerprint, actual: body.preview_fingerprint }, 409);
  }
  if (!currentPreview.can_apply_zero_call) {
    throw new PaperStudioError('PAPER_STUDIO_CONTINUITY_REPAIR_BLOCKED', '修复后的动作门禁或素材完整性未通过，不能标记为零调用修复', { gate: currentPreview.gate, asset_diff: currentPreview.asset_diff }, 409);
  }
  const reusableSourceIds = currentPreview.asset_diff.slots
    .filter((slot) => slot.asset_version_id != null)
    .map((slot) => Number(slot.asset_version_id));
  const confirmation = body.confirmation || null;
  const confirmedSources = new Set((confirmation?.source_asset_version_ids || []).map(Number));
  if (reusableSourceIds.length
    && (confirmation?.actor !== 'local_owner'
      || confirmation?.reason !== 'continuity_exact_reuse_confirmed'
      || confirmedSources.size !== reusableSourceIds.length
      || reusableSourceIds.some((id) => !confirmedSources.has(id)))) {
    throw new PaperStudioError(
      'PAPER_STUDIO_CONTINUITY_REPAIR_CONFIRMATION_REQUIRED',
      '连续性修复需要用户明确确认保留预览中的历史素材',
      { source_asset_version_ids: reusableSourceIds },
      400,
    );
  }
  const now = nowIso();
  const planHash = sha256(canonicalJson({
    source_plan_revision_id: Number(shot.current_plan_revision_id),
    motion_plan: currentPreview.proposed_motion_plan,
    asset_diff: currentPreview.asset_diff,
  }));
  let targetPlanId;
  db.transaction(() => {
    targetPlanId = clonePlanStructures(db, cfg, shot, currentPreview.proposed_motion_plan, planHash, now, {
      requestId: body.request_id,
      previewFingerprint: currentPreview.preview_fingerprint,
      confirmation,
    });
    const missingRequired = Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_asset_slots pas
       JOIN paper_source_families psf ON psf.id = pas.family_id
       WHERE psf.plan_revision_id = ? AND pas.required_for_gate = 1
         AND pas.current_version_id IS NULL`,
    ).get(targetPlanId).count || 0);
    db.prepare(
      `UPDATE paper_studio_shots
       SET current_plan_revision_id = ?, plan_summary_json = ?, status = ?,
           attention_required = ?, current_snapshot_id = NULL,
           approved_snapshot_id = NULL, published_video_generation_id = NULL,
           last_error_json = '{}',
           version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(
      targetPlanId,
      JSON.stringify({ ...shot.plan_summary_json, plan_hash: planHash, continuity_repaired_from_plan_revision_id: Number(shot.current_plan_revision_id) }),
      missingRequired ? 'plan_confirmed' : 'asset_ready',
      missingRequired ? 'authorize_generation' : 'none',
      now, Number(shot.id),
    );
    db.prepare('UPDATE paper_studio_runs SET status = ?, attention_required = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(missingRequired ? 'awaiting_generation_authorization' : 'motion_planning', missingRequired ? 'authorize_generation' : 'none', now, Number(shot.run_id));
    db.prepare(
      `INSERT INTO paper_continuity_repair_audits
        (shot_id, source_plan_revision_id, target_plan_revision_id, preview_fingerprint,
         asset_diff_json, gate_report_json, provider_call_count_before,
         provider_call_count_after, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(shot.id), Number(shot.current_plan_revision_id), targetPlanId,
      currentPreview.preview_fingerprint, JSON.stringify(currentPreview.asset_diff),
      JSON.stringify(currentPreview.gate), currentPreview.provider_call_count,
      currentPreview.provider_call_count, body.request_id, now,
    );
  })();
  const callsAfter = reuseService.providerCallCount(db, shot.run_id);
  if (callsAfter !== currentPreview.provider_call_count) {
    throw new PaperStudioError('PAPER_STUDIO_ZERO_CALL_INVARIANT_BROKEN', '连续性修复产生了意外图片调用账本变化', { before: currentPreview.provider_call_count, after: callsAfter }, 500);
  }
  if (log) log.info('Paper studio continuity repaired without image calls', { shot_id: Number(shot.id), source_plan_revision_id: Number(shot.current_plan_revision_id), target_plan_revision_id: targetPlanId });
  return { shot: shotService.get(db, shot.id), target_plan_revision_id: targetPlanId, deduplicated: false, provider_call_delta: 0 };
}

module.exports = { preview, apply };
