const storyboardService = require('./paperStoryboardService');
const reuseService = require('./paperAssetReuseService');
const runService = require('./paperStudioRunService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

function assertSchemaReady(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(paper_storyboards)').all().map((row) => row.name));
  const auditTable = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'paper_history_fork_audits'",
  ).get();
  if (!columns.has('working_copy_base_revision_id')
    || !columns.has('working_copy_fork_audit_id')
    || !auditTable) {
    throw new PaperStudioError(
      'PAPER_HISTORY_MIGRATION_REQUIRED',
      '历史派生功能尚未完成 migration 45，请先执行并复核数据库迁移',
      { migration_id: '45_paper_storyboard_history_fork' },
      503,
    );
  }
}

function providerCallCount(db, storyboardId) {
  return Number(db.prepare(
    `SELECT COALESCE(SUM(ig.provider_call_count), 0) AS count
     FROM image_generations ig
     WHERE ig.paper_storyboard_id = ?
        OR EXISTS (
          SELECT 1 FROM paper_studio_shots pss
          WHERE pss.run_id = ig.paper_studio_run_id
            AND pss.paper_storyboard_id = ?
        )`,
  ).get(Number(storyboardId), Number(storyboardId))?.count || 0);
}

function revisionRow(db, storyboardId, revisionId) {
  const revision = db.prepare(
    `SELECT * FROM paper_storyboard_revisions
     WHERE id = ? AND paper_storyboard_id = ?`,
  ).get(Number(revisionId), Number(storyboardId));
  if (!revision) {
    throw new PaperStudioError(
      'PAPER_HISTORY_SOURCE_NOT_FOUND',
      '历史脚本修订不存在或不属于当前分镜',
      { paper_storyboard_id: Number(storyboardId), revision_id: Number(revisionId) },
      404,
    );
  }
  return {
    ...revision,
    id: Number(revision.id),
    paper_storyboard_id: Number(revision.paper_storyboard_id),
    revision_number: Number(revision.revision_number),
    content: parseJson(revision.content_json, {}),
  };
}

function resolveSource(db, storyboardId, source = {}) {
  if (source.kind === 'revision') {
    return { kind: 'revision', revision: revisionRow(db, storyboardId, source.id) };
  }
  if (source.kind === 'run') {
    const shot = db.prepare(
      `SELECT pss.*, psr.run_number, psr.status AS run_status,
              psr.created_at AS run_created_at
       FROM paper_studio_shots pss
       JOIN paper_studio_runs psr ON psr.id = pss.run_id
       WHERE pss.paper_storyboard_id = ? AND psr.id = ?`,
    ).get(Number(storyboardId), Number(source.id));
    if (!shot) {
      throw new PaperStudioError(
        'PAPER_HISTORY_SOURCE_NOT_FOUND',
        '历史生产版本不存在或不属于当前分镜',
        { paper_storyboard_id: Number(storyboardId), run_id: Number(source.id) },
        404,
      );
    }
    const planId = source.plan_revision_id == null
      ? Number(shot.current_plan_revision_id || 0)
      : Number(source.plan_revision_id);
    const plan = planId ? db.prepare(
      'SELECT * FROM paper_plan_revisions WHERE id = ? AND shot_id = ?',
    ).get(planId, Number(shot.id)) : null;
    if (source.plan_revision_id != null && !plan) {
      throw new PaperStudioError(
        'PAPER_HISTORY_SOURCE_NOT_FOUND',
        '历史计划修订不存在或不属于所选生产版本',
        { run_id: Number(source.id), plan_revision_id: Number(source.plan_revision_id) },
        404,
      );
    }
    return {
      kind: 'run',
      revision: revisionRow(db, storyboardId, shot.paper_storyboard_revision_id),
      run: {
        id: Number(shot.run_id),
        run_number: Number(shot.run_number),
        status: shot.run_status,
        created_at: shot.run_created_at,
      },
      shot: { ...shot, id: Number(shot.id) },
      plan: plan ? { ...plan, id: Number(plan.id), revision_number: Number(plan.revision_number) } : null,
    };
  }
  throw new PaperStudioError(
    'PAPER_HISTORY_SOURCE_NOT_FOUND',
    '历史派生来源必须是 revision 或 run',
    { source },
    400,
  );
}

function changedFields(current, source) {
  return storyboardService.CONTENT_FIELDS.filter((field) => (
    JSON.stringify(current[field] ?? null) !== JSON.stringify(source[field] ?? null)
  ));
}

function productionAssetImpact(db, cfg, source) {
  if (!source.plan) {
    return {
      required_slot_count: 0,
      exact_reuse_count: 0,
      review_required_count: 0,
      blocked_count: 0,
      missing_count: 0,
      needs_image_api_count: 0,
      slots: [],
    };
  }
  const slots = db.prepare(
    `SELECT pas.*, psf.family_key, pav.status AS source_status,
            pav.reuse_fingerprint AS source_reuse_fingerprint,
            pav.source_local_path, pav.alpha_local_path, pav.mask_local_path,
            pav.source_hash, pav.alpha_hash, pav.mask_hash, pav.provenance_json
     FROM paper_source_families psf
     JOIN paper_asset_slots pas ON pas.family_id = psf.id
     LEFT JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.plan_revision_id = ? AND psf.deleted_at IS NULL AND pas.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(source.plan.id)).map((slot) => {
    if (slot.current_version_id == null) {
      return {
        slot_id: Number(slot.id), slot_key: slot.slot_key, family_key: slot.family_key,
        source_asset_version_id: null, match_kind: 'missing', calls: 1,
        reasons: ['source_missing'],
      };
    }
    const latestReview = reuseService.latestReviewDecision(db, slot.current_version_id);
    const trust = reuseService.localTrustState(db, { ...slot, id: slot.current_version_id });
    const file = reuseService.verifyVersionFile(cfg, slot);
    const fingerprintMatch = Boolean(slot.reuse_fingerprint)
      && (slot.source_reuse_fingerprint || slot.reuse_fingerprint) === slot.reuse_fingerprint;
    const exact = slot.source_status === 'accepted'
      && latestReview?.decision === 'approved'
      && trust.trusted
      && file.pass
      && fingerprintMatch;
    const review = slot.source_status === 'accepted' && latestReview?.decision === 'approved' && file.pass;
    const matchKind = exact ? 'exact' : (review ? 'review' : 'blocked');
    return {
      slot_id: Number(slot.id),
      slot_key: slot.slot_key,
      family_key: slot.family_key,
      source_asset_version_id: Number(slot.current_version_id),
      match_kind: matchKind,
      calls: exact ? 0 : 1,
      file,
      latest_review_decision: latestReview?.decision || null,
      latest_reviewer: latestReview?.reviewer || null,
      import_trust_state: trust.review_required ? 'review_required' : 'trusted',
      fingerprint_match: fingerprintMatch,
      reasons: [
        ...(slot.source_status === 'accepted' ? [] : ['source_not_accepted']),
        ...(latestReview?.decision === 'approved' ? [] : ['source_not_approved']),
        ...(trust.trusted ? [] : ['import_trust_required']),
        ...(file.pass ? [] : [file.reason]),
        ...(fingerprintMatch ? [] : ['visual_contract_changed']),
      ],
    };
  });
  const count = (kind) => slots.filter((slot) => slot.match_kind === kind).length;
  return {
    required_slot_count: slots.length,
    exact_reuse_count: count('exact'),
    review_required_count: count('review'),
    blocked_count: count('blocked'),
    missing_count: count('missing'),
    needs_image_api_count: slots.filter((slot) => Number(slot.calls || 0) > 0).length,
    slots,
  };
}

function buildPreview(db, storyboardId, body = {}, { cfg = {} } = {}) {
  assertSchemaReady(db);
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  const targetMode = String(body.target_mode || 'working_copy');
  if (!['working_copy', 'production_copy'].includes(targetMode)) {
    throw new PaperStudioError('PAPER_HISTORY_TARGET_MODE_INVALID', '历史派生目标类型无效', { target_mode: targetMode }, 400);
  }
  const source = resolveSource(db, storyboard.id, body.source || {});
  if (targetMode === 'production_copy' && source.kind !== 'run') {
    throw new PaperStudioError('PAPER_HISTORY_TARGET_MODE_INVALID', '生产副本必须来自历史生产版本', null, 400);
  }
  const content = source.revision.content;
  const callsBefore = providerCallCount(db, storyboard.id);
  const assetImpact = targetMode === 'production_copy'
    ? productionAssetImpact(db, cfg, source)
    : {
        required_slot_count: 0, exact_reuse_count: 0, review_required_count: 0,
        blocked_count: 0, missing_count: 0, needs_image_api_count: 0, slots: [],
      };
  const core = {
    paper_storyboard_id: Number(storyboard.id),
    storyboard_version: Number(storyboard.version),
    current_revision_id: Number(storyboard.current_revision_id || 0) || null,
    source_kind: source.kind,
    source_storyboard_revision_id: Number(source.revision.id),
    source_content_hash: source.revision.content_hash,
    source_run_id: source.run?.id || null,
    source_shot_id: source.shot?.id || null,
    source_plan_revision_id: source.plan?.id || null,
    target_mode: targetMode,
    scope: 'storyboard_only',
    changed_fields: changedFields(storyboard, content),
    published_video_will_be_invalidated: storyboard.published_video_generation_id != null,
    preserved_history: true,
    provider_call_count_before: callsBefore,
    provider_call_min: assetImpact.blocked_count + assetImpact.missing_count,
    provider_call_max: assetImpact.needs_image_api_count,
    asset_impact: assetImpact,
  };
  return {
    ...core,
    source_revision_number: Number(source.revision.revision_number),
    source_run_number: source.run?.run_number || null,
    source_plan_revision_number: source.plan?.revision_number || null,
    preview_fingerprint: `sha256:${sha256(canonicalJson(core))}`,
  };
}

function auditRow(row) {
  return row ? {
    ...row,
    id: Number(row.id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    source_storyboard_revision_id: Number(row.source_storyboard_revision_id),
    source_run_id: row.source_run_id == null ? null : Number(row.source_run_id),
    source_shot_id: row.source_shot_id == null ? null : Number(row.source_shot_id),
    source_plan_revision_id: row.source_plan_revision_id == null ? null : Number(row.source_plan_revision_id),
    target_storyboard_revision_id: row.target_storyboard_revision_id == null ? null : Number(row.target_storyboard_revision_id),
    target_run_id: row.target_run_id == null ? null : Number(row.target_run_id),
    target_shot_id: row.target_shot_id == null ? null : Number(row.target_shot_id),
    target_plan_revision_id: row.target_plan_revision_id == null ? null : Number(row.target_plan_revision_id),
    impact_json: parseJson(row.impact_json, {}),
    provider_call_count_before: Number(row.provider_call_count_before || 0),
    provider_call_count_after: Number(row.provider_call_count_after || 0),
  } : null;
}

function forkDraft(db, log, storyboardId, body = {}) {
  assertSchemaReady(db);
  const storyboard = storyboardService.get(db, storyboardId);
  const requestId = String(body.request_id || '').trim();
  if (!requestId) throw new PaperStudioError('PAPER_HISTORY_REQUEST_ID_REQUIRED', '创建历史工作副本需要 request_id', null, 400);
  const existing = db.prepare(
    'SELECT * FROM paper_history_fork_audits WHERE paper_storyboard_id = ? AND request_id = ?',
  ).get(Number(storyboard.id), requestId);
  if (existing) {
    return { storyboard, audit: auditRow(existing), created: false, deduplicated: true, provider_call_delta: 0 };
  }
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  const preview = buildPreview(db, storyboard.id, {
    source: { kind: 'revision', id: body.source_revision_id },
    target_mode: 'working_copy',
    expected_version: storyboard.version,
  });
  if (preview.preview_fingerprint !== body.preview_fingerprint) {
    throw new PaperStudioError(
      'PAPER_HISTORY_PREVIEW_STALE',
      '脚本来源或当前工作副本已经变化，请重新预览',
      { expected: preview.preview_fingerprint, actual: body.preview_fingerprint },
      409,
    );
  }
  if (preview.published_video_will_be_invalidated && body.confirmation?.published_video_invalidation !== true) {
    throw new PaperStudioError(
      'PAPER_HISTORY_PUBLISHED_VIDEO_CONFIRMATION_REQUIRED',
      '当前分镜已有发布视频，请确认切换工作副本后发布结果将失效',
      null,
      400,
    );
  }
  if (body.confirmation?.actor !== 'local_owner' || body.confirmation?.reason !== 'history_working_copy_confirmed') {
    throw new PaperStudioError('PAPER_HISTORY_USER_CONFIRMATION_REQUIRED', '请在影响预览中明确确认创建历史工作副本', null, 400);
  }
  const revision = revisionRow(db, storyboard.id, body.source_revision_id);
  const content = revision.content;
  const now = nowIso();
  let auditId;
  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO paper_history_fork_audits
        (paper_storyboard_id, source_kind, source_storyboard_revision_id,
         target_mode, status, impact_json, preview_fingerprint,
         provider_call_count_before, provider_call_count_after,
         request_id, created_at, completed_at)
       VALUES (?, 'revision', ?, 'working_copy', 'completed', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(storyboard.id), Number(revision.id), JSON.stringify(preview),
      preview.preview_fingerprint, preview.provider_call_count_before,
      preview.provider_call_count_before, requestId, now, now,
    );
    auditId = Number(insert.lastInsertRowid);
    const fields = [...storyboardService.CONTENT_FIELDS];
    const assignments = fields.map((field) => `${field} = ?`);
    const values = fields.map((field) => (
      field === 'environment_only' ? (content[field] ? 1 : 0) : content[field] ?? null
    ));
    assignments.push(
      'current_reference_version_id = ?',
      'reference_constraints_json = ?',
      'current_revision_id = ?',
      'working_copy_base_revision_id = ?',
      'working_copy_fork_audit_id = ?',
      'published_video_generation_id = NULL',
      "status = 'draft'",
      'version = version + 1',
      'updated_at = ?',
    );
    values.push(
      content.current_reference_version_id == null ? null : Number(content.current_reference_version_id),
      JSON.stringify(content.reference_constraints || {}),
      Number(revision.id), Number(revision.id), auditId, now,
      Number(storyboard.id), Number(storyboard.version),
    );
    const result = db.prepare(
      `UPDATE paper_storyboards SET ${assignments.join(', ')}
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    ).run(...values);
    if (!result.changes) {
      throw new PaperStudioError('PAPER_HISTORY_VERSION_CONFLICT', '当前工作副本已被更新，请重新预览', null, 409);
    }
    const changedContent = storyboardService.get(db, storyboard.id);
    require('./paperStoryboardAudioService').invalidateChangedText(db, storyboard.id, storyboard, changedContent, now);
    storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now });
    const callsAfter = providerCallCount(db, storyboard.id);
    if (callsAfter !== preview.provider_call_count_before) {
      throw new PaperStudioError(
        'PAPER_HISTORY_ZERO_CALL_INVARIANT_BROKEN',
        '创建历史工作副本意外改变了图片调用账本',
        { before: preview.provider_call_count_before, after: callsAfter },
        500,
      );
    }
  })();
  const audit = auditRow(db.prepare('SELECT * FROM paper_history_fork_audits WHERE id = ?').get(auditId));
  const result = { storyboard: storyboardService.get(db, storyboard.id), audit, created: true, deduplicated: false, provider_call_delta: 0 };
  if (log) log.info('Paper storyboard working copy forked from history', {
    paper_storyboard_id: Number(storyboard.id), source_revision_id: Number(revision.id), audit_id: auditId,
  });
  return result;
}

function clonePlanBaseline(db, source, targetShotId, targetRunId, now) {
  if (!source.plan) return null;
  const planResult = db.prepare(
    `INSERT INTO paper_plan_revisions
      (shot_id, revision_number, blueprint_revision_id, plan_hash, status,
       transition_report_json, created_from, created_at)
     VALUES (?, 1, ?, ?, 'draft', ?, 'history_fork_run', ?)`,
  ).run(
    Number(targetShotId), source.plan.blueprint_revision_id == null ? null : Number(source.plan.blueprint_revision_id),
    source.plan.plan_hash, source.plan.transition_report_json || '{}', now,
  );
  const targetPlanId = Number(planResult.lastInsertRowid);
  const familyMap = new Map();
  const sourceFamilies = db.prepare(
    `SELECT * FROM paper_source_families
     WHERE shot_id = ? AND plan_revision_id = ? AND deleted_at IS NULL
     ORDER BY id`,
  ).all(Number(source.shot.id), Number(source.plan.id));
  for (const family of sourceFamilies) {
    const familyId = Number(db.prepare(
      `INSERT INTO paper_source_families
        (shot_id, plan_revision_id, family_key, pattern, registration_canvas_json,
         contract_json, context_snapshot_id, provider_signature, status, version,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)`,
    ).run(
      Number(targetShotId), targetPlanId, family.family_key, family.pattern,
      family.registration_canvas_json || '{}', family.contract_json || '{}',
      family.context_snapshot_id || null, family.provider_signature || null, now, now,
    ).lastInsertRowid);
    familyMap.set(Number(family.id), familyId);
    const slots = db.prepare(
      'SELECT * FROM paper_asset_slots WHERE family_id = ? AND deleted_at IS NULL ORDER BY id',
    ).all(Number(family.id));
    for (const slot of slots) {
      db.prepare(
        `INSERT INTO paper_asset_slots
          (family_id, slot_key, asset_type, generation_purpose, constraints_json,
           required_for_gate, reuse_fingerprint, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)`,
      ).run(
        familyId, slot.slot_key, slot.asset_type, slot.generation_purpose,
        slot.constraints_json || '{}', Number(slot.required_for_gate || 0),
        slot.reuse_fingerprint || null, now, now,
      );
    }
  }

  const nodeMap = new Map();
  const sourceNodes = db.prepare(
    'SELECT * FROM paper_composition_nodes WHERE plan_revision_id = ? AND deleted_at IS NULL ORDER BY id',
  ).all(Number(source.plan.id));
  for (const node of sourceNodes) {
    const parentId = node.parent_node_id == null ? null : nodeMap.get(Number(node.parent_node_id));
    const nodeId = Number(db.prepare(
      `INSERT INTO paper_composition_nodes
        (shot_id, plan_revision_id, node_key, parent_node_id, node_kind, pattern,
         slot, asset_version_id, transform_json, relation_json, clip_json, local_z,
         status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
    ).run(
      Number(targetShotId), targetPlanId, node.node_key, parentId, node.node_kind,
      node.pattern, node.slot, node.transform_json || '{}', node.relation_json || '{}',
      node.clip_json || '{}', Number(node.local_z || 0), now, now,
    ).lastInsertRowid);
    nodeMap.set(Number(node.id), nodeId);
  }

  const motion = db.prepare('SELECT * FROM paper_motion_plans WHERE plan_revision_id = ?').get(Number(source.plan.id));
  if (motion) {
    db.prepare(
      `INSERT INTO paper_motion_plans
        (shot_id, plan_revision_id, schema_version, semantic_contract_hash,
         timing_hash, plan_json, compiled_tracks_json, status, version,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
    ).run(
      Number(targetShotId), targetPlanId, Number(motion.schema_version || 1),
      motion.semantic_contract_hash, motion.timing_hash || null, motion.plan_json,
      motion.compiled_tracks_json || '{}', now, now,
    );
  }

  const sourceSteps = db.prepare('SELECT * FROM paper_job_steps WHERE plan_revision_id = ? ORDER BY id').all(Number(source.plan.id));
  for (const step of sourceSteps) {
    const completed = ['analyze_shot', 'plan_families'].includes(step.step_key);
    db.prepare(
      `INSERT INTO paper_job_steps
        (run_id, shot_id, plan_revision_id, step_key, input_hash,
         depends_on_json, status, attempt, max_attempts, result_json,
         error_json, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '{}', ?, ?, ?)`,
    ).run(
      Number(targetRunId), Number(targetShotId), targetPlanId, step.step_key,
      sha256(canonicalJson({ source_step_id: Number(step.id), target_plan_revision_id: targetPlanId, step_key: step.step_key })),
      step.depends_on_json || '[]', completed ? 'completed' : 'queued',
      Number(step.max_attempts || 2), completed ? step.result_json || '{}' : '{}',
      completed ? now : null, now, now,
    );
  }
  return targetPlanId;
}

function forkRun(db, cfg, log, storyboardId, body = {}) {
  assertSchemaReady(db);
  const storyboard = storyboardService.get(db, storyboardId);
  const requestId = String(body.request_id || '').trim();
  if (!requestId) throw new PaperStudioError('PAPER_HISTORY_REQUEST_ID_REQUIRED', '复制历史生产版本需要 request_id', null, 400);
  const existing = db.prepare(
    'SELECT * FROM paper_history_fork_audits WHERE paper_storyboard_id = ? AND request_id = ?',
  ).get(Number(storyboard.id), requestId);
  if (existing?.target_run_id) {
    return {
      run: runService.get(db, existing.target_run_id), audit: auditRow(existing),
      created: false, deduplicated: true, provider_call_delta: 0,
    };
  }
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  if (body.scope !== 'storyboard_only') {
    throw new PaperStudioError('PAPER_HISTORY_SCOPE_INVALID', 'v1 只允许复制当前分镜', { scope: body.scope }, 400);
  }
  const sourceSpec = {
    kind: 'run', id: body.source_run_id,
    ...(body.source_plan_revision_id == null ? {} : { plan_revision_id: body.source_plan_revision_id }),
  };
  const preview = buildPreview(db, storyboard.id, {
    source: sourceSpec,
    target_mode: 'production_copy',
    expected_version: storyboard.version,
  }, { cfg });
  if (preview.preview_fingerprint !== body.preview_fingerprint) {
    throw new PaperStudioError(
      'PAPER_HISTORY_PREVIEW_STALE',
      '源生产版本、审核或素材文件已经变化，请重新预览',
      { expected: preview.preview_fingerprint, actual: body.preview_fingerprint },
      409,
    );
  }
  if (body.confirmation?.actor !== 'local_owner' || body.confirmation?.reason !== 'history_production_copy_confirmed') {
    throw new PaperStudioError('PAPER_HISTORY_USER_CONFIRMATION_REQUIRED', '请在影响预览中明确确认复制历史生产版本', null, 400);
  }
  const source = resolveSource(db, storyboard.id, sourceSpec);
  const sourceRun = db.prepare('SELECT * FROM paper_studio_runs WHERE id = ?').get(Number(source.run.id));
  const now = nowIso();
  let targetRunId;
  let targetShotId;
  let targetPlanId;
  let auditId;
  db.transaction(() => {
    const nextRunNumber = Number(db.prepare(
      `SELECT COALESCE(MAX(run_number), 0) + 1 AS value
       FROM paper_studio_runs WHERE project_id = ? AND paper_episode_id = ?`,
    ).get(Number(sourceRun.project_id), Number(sourceRun.paper_episode_id)).value);
    const sourceSelection = parseJson(sourceRun.selection_json, {});
    const selection = {
      ...sourceSelection,
      source_kind: 'paper_history_fork',
      paper_storyboard_ids: [Number(storyboard.id)],
      paper_storyboard_revision_ids: [Number(source.revision.id)],
      fork_source_run_id: Number(source.run.id),
      fork_source_plan_revision_id: source.plan?.id || null,
    };
    const runHash = sha256(canonicalJson({
      kind: 'paper_history_fork', source_run_id: Number(source.run.id),
      source_revision_hash: source.revision.content_hash,
      source_plan_hash: source.plan?.plan_hash || null,
      style_signature: sourceRun.style_signature || null,
      quality_tier: sourceRun.quality_tier,
    }));
    targetRunId = Number(db.prepare(
      `INSERT INTO paper_studio_runs
        (project_id, drama_id, episode_id, paper_episode_id, legacy_episode_id,
         run_number, request_id, selection_json, quality_tier, style_version_id,
         style_signature, source_revision_hash, budget_json, status, progress,
         attention_required, last_error_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`,
    ).run(
      Number(sourceRun.project_id), Number(sourceRun.drama_id), Number(sourceRun.episode_id),
      Number(sourceRun.paper_episode_id), nextRunNumber, requestId, JSON.stringify(selection),
      sourceRun.quality_tier, sourceRun.style_version_id || null, sourceRun.style_signature || null,
      runHash, sourceRun.budget_json || '{}', source.plan ? 'plan_review' : 'draft',
      source.plan ? 10 : 0, source.plan ? 'confirm_plan' : 'none', now, now,
    ).lastInsertRowid);
    targetShotId = Number(db.prepare(
      `INSERT INTO paper_studio_shots
        (run_id, drama_id, episode_id, storyboard_id, paper_storyboard_id,
         paper_storyboard_revision_id, legacy_storyboard_id, source_kind, shot_index,
         source_revision_hash, semantic_contract_json, plan_summary_json,
         blueprint_revision_id, status, attention_required, last_error_json,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'paper', 0, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`,
    ).run(
      targetRunId, Number(source.shot.drama_id), Number(source.shot.episode_id),
      Number(source.shot.storyboard_id), Number(storyboard.id), Number(source.revision.id),
      sha256(canonicalJson({ run_hash: runHash, revision_hash: source.revision.content_hash })),
      source.shot.semantic_contract_json || '{}', source.shot.plan_summary_json || '{}',
      source.shot.blueprint_revision_id || null, source.plan ? 'analyzed' : 'pending',
      source.plan ? 'confirm_plan' : 'none', now, now,
    ).lastInsertRowid);
    targetPlanId = clonePlanBaseline(db, source, targetShotId, targetRunId, now);
    if (targetPlanId) {
      db.prepare('UPDATE paper_studio_shots SET current_plan_revision_id = ? WHERE id = ?')
        .run(targetPlanId, targetShotId);
    }
    auditId = Number(db.prepare(
      `INSERT INTO paper_history_fork_audits
        (paper_storyboard_id, source_kind, source_storyboard_revision_id,
         source_run_id, source_shot_id, source_plan_revision_id,
         target_mode, target_run_id, target_shot_id, target_plan_revision_id,
         status, impact_json, preview_fingerprint, provider_call_count_before,
         provider_call_count_after, request_id, created_at, completed_at)
       VALUES (?, 'run', ?, ?, ?, ?, 'production_copy', ?, ?, ?, 'completed',
               ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(storyboard.id), Number(source.revision.id), Number(source.run.id), Number(source.shot.id),
      source.plan?.id || null, targetRunId, targetShotId, targetPlanId,
      JSON.stringify(preview), preview.preview_fingerprint, preview.provider_call_count_before,
      preview.provider_call_count_before, requestId, now, now,
    ).lastInsertRowid);
    const callsAfter = providerCallCount(db, storyboard.id);
    if (callsAfter !== preview.provider_call_count_before) {
      throw new PaperStudioError(
        'PAPER_HISTORY_ZERO_CALL_INVARIANT_BROKEN',
        '复制历史生产版本意外改变了图片调用账本',
        { before: preview.provider_call_count_before, after: callsAfter },
        500,
      );
    }
  })();
  const audit = auditRow(db.prepare('SELECT * FROM paper_history_fork_audits WHERE id = ?').get(auditId));
  const result = {
    run: runService.get(db, targetRunId), audit,
    reuse_preview_required: true,
    created: true, deduplicated: false, provider_call_delta: 0,
  };
  if (log) log.info('Paper studio run forked from storyboard history', {
    source_run_id: Number(source.run.id), target_run_id: targetRunId,
    paper_storyboard_id: Number(storyboard.id), audit_id: auditId,
  });
  return result;
}

module.exports = {
  assertSchemaReady,
  providerCallCount,
  buildPreview,
  forkDraft,
  forkRun,
};
