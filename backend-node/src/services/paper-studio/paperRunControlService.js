const schemaService = require('./paperStudioSchemaService');
const runService = require('./paperStudioRunService');
const eventService = require('./paperStudioEventService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
} = require('./paperStudioUtils');

function recover(db, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '恢复纸片生产版本的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (!['partial', 'failed'].includes(run.status)) {
    throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '当前生产版本不需要恢复', { run_id: run.id, status: run.status }, 409);
  }
  const selected = body.shot_ids?.length
    ? run.shots.filter((shot) => body.shot_ids.map(Number).includes(Number(shot.id)))
    : run.shots.filter((shot) => ['asset_failed', 'motion_failed', 'proof_failed', 'render_failed'].includes(shot.status));
  if (!selected.length) throw new PaperStudioError('PAPER_STUDIO_RECOVERY_TARGET_MISSING', '没有可恢复的失败镜头', { run_id: run.id }, 409);
  const statusPriority = {
    asset_failed: 'assets_generating',
    motion_failed: 'motion_planning',
    proof_failed: 'proofing',
    render_failed: 'approved',
  };
  const nextStatus = statusPriority[selected[0].status] || 'partial';
  const needsImageAuthorization = selected.some((shot) => shot.status === 'asset_failed');
  const effectiveStatus = needsImageAuthorization ? 'awaiting_generation_authorization' : nextStatus;
  const now = nowIso();
  db.prepare('UPDATE paper_studio_runs SET status = ?, attention_required = ?, active_authorization_id = CASE WHEN ? THEN NULL ELSE active_authorization_id END, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(effectiveStatus, needsImageAuthorization ? 'authorize_generation' : 'none', needsImageAuthorization ? 1 : 0, JSON.stringify({ recovery_requested_at: now, shot_ids: selected.map((shot) => Number(shot.id)), request_id: body.request_id }), now, Number(run.id));
  db.prepare("UPDATE paper_job_steps SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed_terminal' END, attempt = CASE WHEN attempt < max_attempts THEN attempt + 1 ELSE attempt END, lease_owner = NULL, lease_expires_at = NULL, error_json = CASE WHEN attempt < max_attempts THEN '{}' ELSE error_json END, updated_at = ? WHERE run_id = ? AND shot_id IN (" + selected.map(() => '?').join(',') + ") AND status = 'failed_retryable'").run(now, Number(run.id), ...selected.map((shot) => Number(shot.id)));
  if (needsImageAuthorization) {
    const assetShotIds = selected.filter((shot) => shot.status === 'asset_failed').map((shot) => Number(shot.id));
    db.prepare("UPDATE paper_job_steps SET status = 'blocked_user_authorization', authorization_id = NULL, blocked_reason = 'user_authorization_required', user_visible_status = 'waiting_for_authorization', updated_at = ? WHERE run_id = ? AND shot_id IN (" + assetShotIds.map(() => '?').join(',') + ") AND step_key = 'generate_layout_master'")
      .run(now, Number(run.id), ...assetShotIds);
    db.prepare("UPDATE paper_studio_shots SET attention_required = 'authorize_generation' WHERE id IN (" + assetShotIds.map(() => '?').join(',') + ")")
      .run(...assetShotIds);
  }
  if (log) log.info('Paper studio run recovery requested', { run_id: Number(run.id), shot_ids: selected.map((shot) => Number(shot.id)), next_status: effectiveStatus });
  return { run: runService.get(db, run.id), recovered_shot_ids: selected.map((shot) => Number(shot.id)) };
}

function cancel(db, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '取消纸片生产版本的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (['delivered', 'cancelled'].includes(run.status)) {
    throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '已交付或已取消的版本不能再次取消', { run_id: run.id, status: run.status }, 409);
  }
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE paper_studio_runs SET status = 'cancelled', paused_at = NULL, attention_required = 'none', active_authorization_id = NULL, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify({ cancelled_at: now, request_id: body.request_id }), now, Number(run.id));
    db.prepare("UPDATE paper_studio_shots SET status = 'cancelled', version = version + 1, updated_at = ? WHERE run_id = ? AND status NOT IN ('published','cancelled') AND deleted_at IS NULL").run(now, Number(run.id));
    db.prepare("UPDATE paper_job_steps SET status = 'cancelled', cancel_requested_at = ?, blocked_reason = 'run_cancelled', user_visible_status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed','cancelled')").run(now, now, Number(run.id));
    db.prepare("UPDATE paper_generation_authorizations SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ? WHERE run_id = ? AND status IN ('authorized','executing')").run(now, now, Number(run.id));
  });
  transaction();
  eventService.record(db, { runId: run.id, eventType: 'run_cancelled', severity: 'warning', title: '生产版本已取消', message: '未开始的任务已取消；运行中的远程结果不会写入当前版本' });
  if (log) log.info('Paper studio run cancelled', { run_id: Number(run.id) });
  return { run: runService.get(db, run.id) };
}

function pause(db, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '暂停纸片生产版本的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (['delivered', 'cancelled', 'stale'].includes(run.status)) {
    throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '已结束的生产版本不能暂停', { run_id: run.id, status: run.status }, 409);
  }
  if (run.paused_at) return { run };
  const now = nowIso();
  db.prepare("UPDATE paper_studio_runs SET paused_at = ?, attention_required = 'none', version = version + 1, updated_at = ? WHERE id = ?")
    .run(now, now, Number(run.id));
  db.prepare("UPDATE paper_job_steps SET user_visible_status = 'paused', updated_at = ? WHERE run_id = ? AND status = 'queued'")
    .run(now, Number(run.id));
  eventService.record(db, { runId: run.id, eventType: 'run_paused', severity: 'warning', title: '生产版本已暂停', message: '不会再领取新的图片或渲染任务', recoveryActions: ['resume_run', 'cancel_run'] });
  if (log) log.info('Paper studio run paused', { run_id: Number(run.id) });
  return { run: runService.get(db, run.id) };
}

function resume(db, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '恢复纸片生产版本的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (!run.paused_at) throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '当前生产版本没有暂停', { run_id: run.id, status: run.status }, 409);
  const now = nowIso();
  db.prepare("UPDATE paper_studio_runs SET paused_at = NULL, attention_required = CASE WHEN status = 'awaiting_generation_authorization' THEN 'authorize_generation' ELSE attention_required END, version = version + 1, updated_at = ? WHERE id = ?")
    .run(now, Number(run.id));
  db.prepare("UPDATE paper_job_steps SET user_visible_status = CASE WHEN status = 'queued' THEN 'queued' ELSE user_visible_status END, updated_at = ? WHERE run_id = ?")
    .run(now, Number(run.id));
  eventService.record(db, { runId: run.id, eventType: 'run_resumed', title: '生产版本已恢复', message: '后台会继续领取已获授权且尚未完成的任务' });
  if (log) log.info('Paper studio run resumed', { run_id: Number(run.id) });
  return { run: runService.get(db, run.id) };
}

function steps(db, runId) {
  const run = runService.get(db, runId);
  return db.prepare('SELECT * FROM paper_job_steps WHERE run_id = ? ORDER BY shot_id, id').all(Number(run.id)).map((step) => ({
    ...step,
    id: Number(step.id),
    run_id: Number(step.run_id),
    shot_id: step.shot_id == null ? null : Number(step.shot_id),
    depends_on_json: JSON.parse(step.depends_on_json || '[]'),
    result_json: JSON.parse(step.result_json || '{}'),
    error_json: JSON.parse(step.error_json || '{}'),
  }));
}

module.exports = { recover, cancel, pause, resume, steps };
