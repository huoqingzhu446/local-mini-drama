const schemaService = require('./paperStudioSchemaService');
const runService = require('./paperStudioRunService');
const shotService = require('./paperStudioShotService');
const providerService = require('./paperProviderCapabilityService');
const assetService = require('./paperAssetProductionService');
const eventService = require('./paperStudioEventService');
const { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion } = require('./paperStudioPlannerVersion');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

function rowToAuthorization(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    run_id: Number(row.run_id),
    provider_config_id: row.provider_config_id == null ? null : Number(row.provider_config_id),
    estimated_image_count: Number(row.estimated_image_count || 0),
    max_attempts: Number(row.max_attempts || 1),
    version: Number(row.version || 1),
    shot_scope_json: parseJson(row.shot_scope_json, []),
    slot_scope_json: parseJson(row.slot_scope_json, []),
    budget_limit_json: parseJson(row.budget_limit_json, {}),
  };
}

function get(db, authorizationId) {
  const row = db.prepare(
    'SELECT * FROM paper_generation_authorizations WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(authorizationId));
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_AUTHORIZATION_NOT_FOUND',
      '图片生成授权不存在',
      { authorization_id: Number(authorizationId) },
      404,
    );
  }
  return rowToAuthorization(row);
}

function selectedShots(run, body = {}) {
  const allowedStates = new Set(['plan_confirmed', 'asset_failed', ...(body.slot_ids?.length ? ['asset_review'] : [])]);
  const wanted = body.shot_ids?.length ? new Set(body.shot_ids.map(Number)) : null;
  const selected = run.shots.filter((shot) => (!wanted || wanted.has(Number(shot.id))) && allowedStates.has(shot.status));
  if (wanted && selected.length !== wanted.size) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_QUOTE_TARGET_INVALID',
      '只有已确认计划或待重试素材的当前镜头可以生成报价',
      { run_id: Number(run.id), shot_ids: body.shot_ids },
      409,
    );
  }
  if (!selected.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_QUOTE_EMPTY',
      '当前没有等待图片生成授权的镜头',
      { run_id: Number(run.id) },
      409,
    );
  }
  return selected;
}

function slotNeedsImageApi(db, shot, slot, { force = false } = {}) {
  if (!force && slot.current_version_id) {
    const accepted = db.prepare(
      "SELECT id FROM paper_asset_versions WHERE id = ? AND status = 'accepted'",
    ).get(Number(slot.current_version_id));
    if (accepted) return false;
  }
  if (slot.asset_type === 'occlusion-mask') return false;
  if (slot.constraints_json?.derivation === 'registered_alpha_band') return false;
  if (!force && assetService.sourceForSlot(db, shot, slot)) return false;
  return Boolean(slot.required_for_gate || slot.constraints_json?.fallback !== 'procedural');
}

function assertNoActiveGenerationSteps(db, runId, shotIds, { ignoreAuthorizationId = null } = {}) {
  const ids = [...new Set((shotIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return;
  const active = db.prepare(
    `SELECT id, shot_id, status, authorization_id
     FROM paper_job_steps
     WHERE run_id = ? AND shot_id IN (${ids.map(() => '?').join(',')})
       AND step_key = 'generate_layout_master'
       AND status IN ('queued', 'running')`,
  ).all(Number(runId), ...ids).filter((step) => (
    ignoreAuthorizationId == null || Number(step.authorization_id) !== Number(ignoreAuthorizationId)
  ));
  if (!active.length) return;
  throw new PaperStudioError(
    'PAPER_STUDIO_ASSET_GENERATION_ALREADY_ACTIVE',
    '当前镜头的素材已经在排队或生成中，请等待完成后再重新生成',
    {
      run_id: Number(runId),
      steps: active.map((step) => ({
        step_id: Number(step.id),
        shot_id: Number(step.shot_id),
        status: step.status,
        authorization_id: step.authorization_id == null ? null : Number(step.authorization_id),
      })),
    },
    409,
  );
}

function buildQuote(db, runId, body = {}, { validateSchema = true } = {}) {
  if (validateSchema) schemaService.assertValid('apiRunAction', body, '图片生成报价参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (run.paused_at) {
    throw new PaperStudioError('PAPER_STUDIO_RUN_PAUSED', '生产版本已暂停，请先恢复后再生成报价', { run_id: run.id }, 409);
  }
  const shots = selectedShots(run, body);
  const stale = shots.filter((shot) => !isCurrentPlannerVersion(shot.plan_summary_json));
  if (stale.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PLAN_VERSION_STALE',
      '生产计划版本已经更新，请重新分析后再生成素材',
      {
        expected_planner_version: CURRENT_PLANNER_VERSION,
        shots: stale.map((shot) => ({
          shot_id: Number(shot.id),
          actual_planner_version: Number(shot.plan_summary_json?.planner_version || 0),
        })),
      },
      409,
    );
  }
  assertNoActiveGenerationSteps(db, run.id, shots.map((shot) => shot.id));
  const wantedSlotIds = body.slot_ids?.length ? new Set(body.slot_ids.map(Number)) : null;
  const providerConfigId = run.selection_json?.image_provider_config_id || null;
  const provider = providerService.select(db, providerConfigId);
  const allShotSlots = shots.flatMap((summary) => {
    const shot = shotService.get(db, summary.id);
    return shot.families.flatMap((family) => family.slots)
      .map((slot) => ({
        ...slot,
        shot,
      }));
  });
  if (wantedSlotIds) {
    const actual = new Set(allShotSlots.filter((slot) => wantedSlotIds.has(Number(slot.id))).map((slot) => Number(slot.id)));
    const missing = [...wantedSlotIds].filter((id) => !actual.has(Number(id)));
    if (missing.length) {
      throw new PaperStudioError(
        'PAPER_STUDIO_GENERATION_QUOTE_SLOT_INVALID',
        '部分素材槽位不属于当前报价镜头',
        { run_id: Number(run.id), slot_ids: missing },
        409,
      );
    }
  }
  const slots = allShotSlots
    .filter((slot) => (!wantedSlotIds || wantedSlotIds.has(Number(slot.id)))
      && slotNeedsImageApi(db, slot.shot, slot, { force: Boolean(wantedSlotIds) }))
    .map((slot) => ({
        slot_id: Number(slot.id),
        shot_id: Number(slot.shot.id),
        slot_key: slot.slot_key,
        asset_type: slot.asset_type,
        generation_purpose: slot.generation_purpose,
        required: Boolean(slot.required_for_gate),
        // A slot-scoped quote is an explicit request to create a fresh model
        // result, including when the normal zero-cost path would import an
        // existing storyboard reference.
        force_regeneration: Boolean(wantedSlotIds),
      }));
  if (wantedSlotIds && slots.length !== wantedSlotIds.size) {
    const invalid = [...wantedSlotIds].filter((id) => !slots.some((slot) => Number(slot.slot_id) === Number(id)));
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_QUOTE_SLOT_NOT_IMAGE_API',
      '所选槽位是本地派生层，不能消耗图片 API 重新生成',
      { slot_ids: invalid },
      409,
    );
  }
  const maxAttempts = Math.max(1, Number(run.budget_json?.max_auto_retries_per_slot || 0) + 1);
  const quoteCore = {
    run_id: Number(run.id),
    run_version: Number(run.version),
    source_revision_hash: run.source_revision_hash,
    shot_ids: shots.map((shot) => Number(shot.id)),
    requested_slot_ids: wantedSlotIds ? [...wantedSlotIds] : [],
    slots,
    provider_config_id: Number(provider.id),
    provider: provider.provider,
    model: provider.model,
    estimated_image_count: slots.length,
    max_attempts: maxAttempts,
    max_authorized_calls: slots.length * maxAttempts,
    budget_limit: run.budget_json,
  };
  const libraryReuseSlots = allShotSlots
    .filter((slot) => (!wantedSlotIds || wantedSlotIds.has(Number(slot.id))))
    .map((slot) => {
      const source = assetService.sourceForSlot(db, slot.shot, slot);
      return source?.source_kind === 'paper_library'
        ? {
            slot_id: Number(slot.id),
            shot_id: Number(slot.shot.id),
            slot_key: slot.slot_key,
            asset_type: slot.asset_type,
            entity_id: Number(source.source_id),
            entity_name: source.entity_name || null,
            identity_version_id: Number(source.identity_version_id),
            calls: 0,
          }
        : null;
    })
    .filter(Boolean);
  return {
    ...quoteCore,
    quote_fingerprint: sha256(canonicalJson(quoteCore)),
    library_reuse: { count: libraryReuseSlots.length, calls: 0, slots: libraryReuseSlots },
  };
}

function authorize(db, log, runId, body = {}) {
  schemaService.assertValid('apiGenerationAuthorization', body, '创建图片生成授权的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  const existing = db.prepare(
    'SELECT * FROM paper_generation_authorizations WHERE run_id = ? AND request_id = ? AND deleted_at IS NULL',
  ).get(Number(run.id), body.request_id);
  if (existing) return { authorization: rowToAuthorization(existing), created: false, deduplicated: true };
  const quote = buildQuote(db, run.id, {
    request_id: body.request_id,
    expected_version: Number(run.version),
    ...(body.shot_ids?.length ? { shot_ids: body.shot_ids } : {}),
    ...(body.slot_ids?.length ? { slot_ids: body.slot_ids } : {}),
  });
  if (quote.quote_fingerprint !== body.quote_fingerprint) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_QUOTE_STALE',
      '生成范围、模型或版本已经变化，请重新查看费用并确认',
      { expected_quote_fingerprint: quote.quote_fingerprint, actual_quote_fingerprint: body.quote_fingerprint },
      409,
    );
  }
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const result = db.prepare(
    `INSERT INTO paper_generation_authorizations
      (run_id, request_id, source_revision_hash, quote_fingerprint,
       shot_scope_json, slot_scope_json, provider_config_id, provider, model,
       estimated_image_count, max_attempts, budget_limit_json, status, version,
       authorized_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', 1, ?, ?, ?, ?)`,
  ).run(
    Number(run.id), body.request_id, run.source_revision_hash, quote.quote_fingerprint,
    JSON.stringify(quote.shot_ids), JSON.stringify(quote.slots), Number(quote.provider_config_id),
    quote.provider, quote.model, Number(quote.estimated_image_count), Number(quote.max_attempts),
    JSON.stringify(quote.budget_limit), now, expiresAt, now, now,
  );
  const authorization = get(db, result.lastInsertRowid);
  eventService.record(db, {
    runId: run.id,
    eventType: 'generation_authorized',
    title: '已授权图片生成',
    message: `已授权 ${authorization.estimated_image_count} 个素材槽位，模型 ${authorization.model}`,
    details: { authorization_id: authorization.id, quote_fingerprint: authorization.quote_fingerprint },
  });
  if (log) log.info('Paper studio image generation authorized', { run_id: run.id, authorization_id: authorization.id, estimated_image_count: authorization.estimated_image_count });
  return { authorization, created: true, deduplicated: false };
}

function assertUsable(db, authorizationId, { runId = null, shotId = null, slotId = null } = {}) {
  const authorization = get(db, authorizationId);
  if (!['authorized', 'executing'].includes(authorization.status)) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_INACTIVE', '图片生成授权已失效或已结束', { authorization_id: authorization.id, status: authorization.status }, 409);
  }
  if (authorization.expires_at && Date.parse(authorization.expires_at) <= Date.now()) {
    db.prepare("UPDATE paper_generation_authorizations SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), authorization.id);
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_EXPIRED', '图片生成授权已过期，请重新查看费用并授权', { authorization_id: authorization.id }, 409);
  }
  if (runId != null && Number(authorization.run_id) !== Number(runId)) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_SCOPE_MISMATCH', '图片生成授权不属于当前生产版本', { authorization_id: authorization.id, run_id: Number(runId) }, 409);
  }
  if (shotId != null && !authorization.shot_scope_json.map(Number).includes(Number(shotId))) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_SCOPE_MISMATCH', '图片生成授权不包含当前镜头', { authorization_id: authorization.id, shot_id: Number(shotId) }, 409);
  }
  if (slotId != null && !authorization.slot_scope_json.some((slot) => Number(slot.slot_id) === Number(slotId))) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_SCOPE_MISMATCH', '图片生成授权不包含当前素材槽位', { authorization_id: authorization.id, slot_id: Number(slotId) }, 409);
  }
  const run = runService.get(db, authorization.run_id);
  if (run.source_revision_hash !== authorization.source_revision_hash) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_SOURCE_CHANGED', '生产源版本已变化，旧图片生成授权不能继续使用', { authorization_id: authorization.id }, 409);
  }
  if (run.paused_at || ['cancelled', 'stale', 'delivered'].includes(run.status)) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_RUN_BLOCKED', '生产版本已暂停、取消或结束，不能继续使用图片生成授权', { authorization_id: authorization.id, run_id: run.id, status: run.status }, 409);
  }
  const provider = providerService.select(db, run.selection_json?.image_provider_config_id || null);
  if (Number(provider.id) !== Number(authorization.provider_config_id) || String(provider.model || '') !== String(authorization.model || '')) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_PROVIDER_CHANGED', '图片模型配置已经变化，请重新查看费用并授权', { authorization_id: authorization.id, authorized_model: authorization.model, current_model: provider.model }, 409);
  }
  return authorization;
}

function execute(db, log, authorizationId, body = {}) {
  schemaService.assertValid('apiGenerationAuthorizationExecute', body, '执行图片生成授权的参数无效');
  const authorization = get(db, authorizationId);
  assertExpectedVersion(authorization.version, body.expected_version, '图片生成授权');
  assertUsable(db, authorization.id, { runId: authorization.run_id });
  if (authorization.status !== 'authorized') {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_STATE_CONFLICT', '图片生成授权已经执行', { authorization_id: authorization.id, status: authorization.status }, 409);
  }
  const now = nowIso();
  const shotIds = authorization.shot_scope_json.map(Number);
  assertNoActiveGenerationSteps(db, authorization.run_id, shotIds, { ignoreAuthorizationId: authorization.id });
  const forceRegeneration = authorization.slot_scope_json.some((slot) => Boolean(slot.force_regeneration));
  const transaction = db.transaction(() => {
    db.prepare(
      "UPDATE paper_generation_authorizations SET status = 'executing', executed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'authorized'",
    ).run(now, now, authorization.id);
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'queued', authorization_id = ?, blocked_reason = NULL,
           user_visible_status = 'queued', error_json = '{}', cancel_requested_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL, started_at = NULL,
           completed_at = NULL, updated_at = ?
       WHERE run_id = ? AND shot_id IN (${shotIds.map(() => '?').join(',')})
         AND step_key = 'generate_layout_master'
         AND status IN ('blocked_user_authorization','failed_retryable','failed_terminal','cancelled')`,
    ).run(authorization.id, now, authorization.run_id, ...shotIds);
    if (forceRegeneration) {
      db.prepare(
        `UPDATE paper_job_steps
         SET status = 'queued', authorization_id = ?, blocked_reason = NULL,
             user_visible_status = 'queued', error_json = '{}', cancel_requested_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, started_at = NULL,
             completed_at = NULL, updated_at = ?
         WHERE run_id = ? AND shot_id IN (${shotIds.map(() => '?').join(',')})
           AND step_key = 'generate_layout_master'`,
      ).run(authorization.id, now, authorization.run_id, ...shotIds);
    }
    db.prepare(
      `UPDATE paper_studio_shots
       SET attention_required = 'none', version = version + 1, updated_at = ?
       WHERE run_id = ? AND id IN (${shotIds.map(() => '?').join(',')})`,
    ).run(now, authorization.run_id, ...shotIds);
    db.prepare(
      `UPDATE paper_studio_runs
       SET status = 'assets_generating', progress = 18, attention_required = 'none',
           active_authorization_id = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(authorization.id, now, authorization.run_id);
  });
  transaction();
  eventService.record(db, {
    runId: authorization.run_id,
    eventType: 'generation_started',
    title: '正式素材开始生成',
    message: `正在生成 ${authorization.estimated_image_count} 个付费素材槽位`,
    recoveryActions: ['pause_run', 'cancel_run'],
    details: { authorization_id: authorization.id },
  });
  if (log) log.info('Paper studio image generation authorization executed', { run_id: authorization.run_id, authorization_id: authorization.id, shot_ids: shotIds });
  return { authorization: get(db, authorization.id), run: runService.get(db, authorization.run_id) };
}

function cancel(db, log, authorizationId, body = {}) {
  schemaService.assertValid('apiGenerationAuthorizationExecute', body, '取消图片生成授权的参数无效');
  const authorization = get(db, authorizationId);
  assertExpectedVersion(authorization.version, body.expected_version, '图片生成授权');
  if (!['authorized', 'executing'].includes(authorization.status)) {
    throw new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZATION_STATE_CONFLICT', '图片生成授权当前不能取消', { authorization_id: authorization.id, status: authorization.status }, 409);
  }
  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE paper_generation_authorizations SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, now, authorization.id);
    db.prepare("UPDATE paper_job_steps SET status = 'cancelled', cancel_requested_at = ?, blocked_reason = 'authorization_cancelled', user_visible_status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE authorization_id = ? AND status NOT IN ('completed','cancelled')")
      .run(now, now, authorization.id);
    db.prepare("UPDATE paper_studio_runs SET active_authorization_id = NULL, attention_required = 'authorize_generation', version = version + 1, updated_at = ? WHERE id = ? AND active_authorization_id = ?")
      .run(now, authorization.run_id, authorization.id);
  })();
  eventService.record(db, { runId: authorization.run_id, eventType: 'generation_authorization_cancelled', severity: 'warning', title: '已取消图片生成授权', message: '未开始的图片任务不会继续执行', details: { authorization_id: authorization.id } });
  if (log) log.info('Paper studio image generation authorization cancelled', { run_id: authorization.run_id, authorization_id: authorization.id });
  return { authorization: get(db, authorization.id), run: runService.get(db, authorization.run_id) };
}

function markConsumedIfFinished(db, authorizationId) {
  if (!authorizationId) return null;
  const authorization = get(db, authorizationId);
  if (authorization.status !== 'executing') return authorization;
  const pending = db.prepare(
    "SELECT COUNT(*) AS count FROM paper_job_steps WHERE authorization_id = ? AND status IN ('queued','running','blocked_user_authorization')",
  ).get(Number(authorization.id));
  if (Number(pending.count) === 0) {
    const now = nowIso();
    db.prepare("UPDATE paper_generation_authorizations SET status = 'consumed', version = version + 1, updated_at = ? WHERE id = ? AND status = 'executing'")
      .run(now, authorization.id);
    db.prepare('UPDATE paper_studio_runs SET active_authorization_id = NULL, updated_at = ? WHERE id = ? AND active_authorization_id = ?')
      .run(now, authorization.run_id, authorization.id);
  }
  return get(db, authorization.id);
}

module.exports = {
  rowToAuthorization,
  get,
  buildQuote,
  authorize,
  assertUsable,
  execute,
  cancel,
  markConsumedIfFinished,
};
