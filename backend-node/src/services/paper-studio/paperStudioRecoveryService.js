const aggregateService = require('./paperRunAggregateService');
const { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion } = require('./paperStudioPlannerVersion');
const { nowIso, parseJson } = require('./paperStudioUtils');

const RESTART_MESSAGE = '服务重启时纸片任务仍在执行；为避免重复计费，已停止自动重试';
const LOCAL_RESTART_STEPS = new Set([
  'matte_assets', 'register_assets', 'technical_asset_gate',
  'plan_motion', 'render_proof', 'render_preview', 'render_formal', 'publish_video',
]);
const LOCAL_STEP_STATES = Object.freeze({
  plan_motion: new Set(['asset_ready', 'motion_failed']),
  render_proof: new Set(['motion_ready', 'proof_failed']),
  render_preview: new Set(['proof_ready']),
  render_formal: new Set(['approved', 'render_failed']),
  publish_video: new Set(['rendered']),
});

function recoverOnStartup(db, log) {
  const now = nowIso();
  const orphanProofRuns = db.prepare(
    `SELECT ppr.id, pss.run_id
     FROM paper_proof_runs ppr
     JOIN paper_studio_shots pss ON pss.id = ppr.shot_id
     WHERE ppr.status IN ('pending','running') AND pss.deleted_at IS NULL`,
  ).all();
  const interruptedRender = JSON.stringify({ code: 'PAPER_STUDIO_LOCAL_RENDER_INTERRUPTED', message: '本地渲染在服务重启时中断，旧临时记录已失效并可安全重渲染', at: now });
  if (orphanProofRuns.length) {
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded', report_json = ?, completed_at = ? WHERE status IN ('pending','running')")
      .run(interruptedRender, now);
  }
  const orphanLocalVideos = db.prepare(
    `SELECT vg.id, pss.id AS shot_id, pss.run_id, pss.status AS shot_status
     FROM video_generations vg
     JOIN paper_studio_shots pss ON pss.id = vg.paper_studio_shot_id
     WHERE vg.generation_kind = 'paper_studio' AND vg.status = 'processing'
       AND vg.deleted_at IS NULL AND pss.deleted_at IS NULL`,
  ).all();
  for (const video of orphanLocalVideos) {
    db.prepare("UPDATE video_generations SET status = 'failed', error_msg = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
      .run('本地正式渲染在服务重启时中断；可从已批准 snapshot 安全重渲染', now, now, Number(video.id));
    if (video.shot_status === 'rendering') {
      db.prepare(
        `UPDATE paper_studio_shots
         SET status = 'render_failed', last_error_json = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'rendering'`,
      ).run(interruptedRender, now, Number(video.shot_id));
    }
  }
  const running = db.prepare(
    `SELECT pjs.*, pss.status AS shot_status
     FROM paper_job_steps pjs
     LEFT JOIN paper_studio_shots pss ON pss.id = pjs.shot_id
     WHERE pjs.status = 'running'`,
  ).all();
  const affectedRuns = new Set();
  const interruptedAuthorizations = db.prepare(
    "SELECT id, run_id FROM paper_generation_authorizations WHERE status = 'executing' AND deleted_at IS NULL",
  ).all();
  for (const authorization of interruptedAuthorizations) {
    affectedRuns.add(Number(authorization.run_id));
    const authorizationShotIds = db.prepare('SELECT DISTINCT shot_id FROM paper_job_steps WHERE authorization_id = ? AND shot_id IS NOT NULL')
      .all(Number(authorization.id)).map((row) => Number(row.shot_id));
    const error = {
      code: 'PAPER_STUDIO_GENERATION_REAUTHORIZATION_REQUIRED',
      message: '服务重启后不会自动恢复付费图片任务，请重新查看费用并授权',
      authorization_id: Number(authorization.id),
      at: now,
    };
    db.prepare("UPDATE paper_generation_authorizations SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ? AND status = 'executing'")
      .run(now, Number(authorization.id));
    db.prepare("UPDATE paper_job_steps SET status = 'blocked_user_authorization', authorization_id = NULL, blocked_reason = 'restart_reauthorization_required', user_visible_status = 'waiting_for_authorization', error_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE authorization_id = ? AND status = 'queued'")
      .run(JSON.stringify(error), now, Number(authorization.id));
    if (authorizationShotIds.length) {
      db.prepare(
        `UPDATE paper_job_steps
         SET status = 'blocked_user_authorization', authorization_id = NULL,
             blocked_reason = 'restart_reauthorization_required', user_visible_status = 'waiting_for_authorization',
             result_json = '{}', completed_at = NULL, error_json = ?, updated_at = ?
         WHERE run_id = ? AND shot_id IN (${authorizationShotIds.map(() => '?').join(',')})
           AND step_key = 'generate_layout_master'`,
      ).run(JSON.stringify(error), now, Number(authorization.run_id), ...authorizationShotIds);
      db.prepare("UPDATE paper_studio_shots SET attention_required = 'authorize_generation', last_error_json = ?, version = version + 1, updated_at = ? WHERE run_id = ? AND id IN (" + authorizationShotIds.map(() => '?').join(',') + ")")
        .run(JSON.stringify(error), now, Number(authorization.run_id), ...authorizationShotIds);
    }
    db.prepare("UPDATE paper_studio_runs SET active_authorization_id = NULL, attention_required = 'authorize_generation', updated_at = ? WHERE id = ?")
      .run(now, Number(authorization.run_id));
  }
  const handledShotIds = new Set();
  let requeued = 0;
  let blocked = 0;
  let stalePlans = 0;
  for (const step of running) {
    affectedRuns.add(Number(step.run_id));
    if (step.shot_id != null) handledShotIds.add(Number(step.shot_id));
    const hasUnknownPaidAttempt = step.shot_id != null && db.prepare(
      `SELECT COUNT(*) AS count
       FROM image_generations ig
       JOIN paper_asset_versions pav ON pav.id = ig.paper_asset_version_id
       JOIN paper_asset_slots pas ON pas.id = pav.slot_id
       JOIN paper_source_families psf ON psf.id = pas.family_id
       WHERE psf.shot_id = ? AND ig.status IN ('pending','processing') AND ig.deleted_at IS NULL`,
    ).get(Number(step.shot_id)).count > 0;
    if (hasUnknownPaidAttempt) {
      const error = { code: 'PAPER_STUDIO_PROVIDER_ATTEMPT_UNKNOWN', message: RESTART_MESSAGE, step_key: step.step_key, at: now };
      db.prepare("UPDATE paper_job_steps SET status = 'blocked_unknown', lease_owner = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, Number(step.id));
      db.prepare("UPDATE paper_studio_shots SET status = 'asset_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'asset_pending'").run(JSON.stringify(error), now, Number(step.shot_id));
      blocked += 1;
    } else if (LOCAL_RESTART_STEPS.has(step.step_key)) {
      db.prepare("UPDATE paper_job_steps SET status = 'queued', attempt = attempt + 1, lease_owner = NULL, lease_expires_at = NULL, started_at = NULL, error_json = '{}', updated_at = ? WHERE id = ?")
        .run(now, Number(step.id));
      requeued += 1;
    } else if (Number(step.attempt || 1) < Number(step.max_attempts || 2)) {
      if (step.step_key === 'generate_required_slots') {
        const error = { code: 'PAPER_STUDIO_GENERATION_REAUTHORIZATION_REQUIRED', message: '服务重启后不会自动恢复付费图片任务，请重新查看费用并授权', step_key: step.step_key, at: now };
        db.prepare("UPDATE paper_job_steps SET status = 'blocked_user_authorization', authorization_id = NULL, blocked_reason = 'restart_reauthorization_required', user_visible_status = 'waiting_for_authorization', lease_owner = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(error), now, Number(step.id));
        db.prepare("UPDATE paper_studio_shots SET status = 'asset_failed', attention_required = 'authorize_generation', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(error), now, Number(step.shot_id));
        blocked += 1;
      } else {
        db.prepare("UPDATE paper_job_steps SET status = 'queued', attempt = attempt + 1, lease_owner = NULL, lease_expires_at = NULL, error_json = '{}', updated_at = ? WHERE id = ?").run(now, Number(step.id));
        requeued += 1;
      }
    } else {
      const error = { code: 'PAPER_STUDIO_RESTART_RETRY_EXHAUSTED', message: '任务重启恢复次数已用尽', step_key: step.step_key, at: now };
      db.prepare("UPDATE paper_job_steps SET status = 'failed_terminal', lease_owner = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, Number(step.id));
      blocked += 1;
    }
  }

  const strandedLocalSteps = db.prepare(
    `SELECT pjs.*, pss.status AS shot_status
     FROM paper_job_steps pjs
     JOIN paper_studio_shots pss ON pss.id = pjs.shot_id AND pss.deleted_at IS NULL
     WHERE pjs.status IN ('failed_retryable','failed_terminal')
       AND pjs.step_key IN ('plan_motion','render_proof','render_preview','render_formal','publish_video')`,
  ).all();
  for (const step of strandedLocalSteps) {
    if (!LOCAL_STEP_STATES[step.step_key]?.has(step.shot_status)) continue;
    db.prepare("UPDATE paper_job_steps SET status = 'queued', attempt = attempt + 1, lease_owner = NULL, lease_expires_at = NULL, started_at = NULL, completed_at = NULL, result_json = '{}', error_json = '{}', updated_at = ? WHERE id = ?")
      .run(now, Number(step.id));
    affectedRuns.add(Number(step.run_id));
    requeued += 1;
  }

  const strandedRenderShots = db.prepare(
    `SELECT pss.id, pss.run_id
     FROM paper_studio_shots pss
     WHERE pss.status = 'rendering' AND pss.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM video_generations vg
         WHERE vg.paper_studio_shot_id = pss.id AND vg.generation_kind = 'paper_studio'
           AND vg.status = 'processing' AND vg.deleted_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM paper_job_steps pjs
         WHERE pjs.shot_id = pss.id AND pjs.plan_revision_id = pss.current_plan_revision_id
           AND pjs.step_key = 'render_formal' AND pjs.status = 'running'
       )`,
  ).all();
  for (const shot of strandedRenderShots) {
    db.prepare(
      `UPDATE paper_studio_shots
       SET status = 'render_failed', last_error_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'rendering'`,
    ).run(interruptedRender, now, Number(shot.id));
    affectedRuns.add(Number(shot.run_id));
  }

  orphanProofRuns.forEach((row) => affectedRuns.add(Number(row.run_id)));
  orphanLocalVideos.forEach((row) => affectedRuns.add(Number(row.run_id)));

  const orphanShots = db.prepare(
    `SELECT id, run_id FROM paper_studio_shots
     WHERE status = 'asset_pending' AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM paper_job_steps WHERE shot_id = paper_studio_shots.id AND status = 'running')`,
  ).all().filter((shot) => !handledShotIds.has(Number(shot.id)));
  for (const shot of orphanShots) {
    const error = { code: 'PAPER_STUDIO_ASSET_WORK_INTERRUPTED', message: RESTART_MESSAGE, at: now };
    db.prepare("UPDATE paper_studio_shots SET status = 'asset_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, Number(shot.id));
    db.prepare("UPDATE paper_job_steps SET status = CASE WHEN step_key = 'generate_required_slots' THEN 'blocked_user_authorization' ELSE 'failed_retryable' END, authorization_id = CASE WHEN step_key = 'generate_required_slots' THEN NULL ELSE authorization_id END, blocked_reason = CASE WHEN step_key = 'generate_required_slots' THEN 'restart_reauthorization_required' ELSE blocked_reason END, error_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE shot_id = ? AND status IN ('queued','running') AND step_key IN ('generate_required_slots','matte_assets','register_assets','technical_asset_gate')").run(JSON.stringify(error), now, Number(shot.id));
    affectedRuns.add(Number(shot.run_id));
    blocked += 1;
  }

  const plannedShots = db.prepare(
    `SELECT id, run_id, status, plan_summary_json
     FROM paper_studio_shots
     WHERE status NOT IN ('pending','published','cancelled','stale')
       AND plan_summary_json != '{}'
       AND deleted_at IS NULL`,
  ).all();
  for (const shot of plannedShots) {
    const summary = parseJson(shot.plan_summary_json, {});
    if (isCurrentPlannerVersion(summary)) continue;
    const error = {
      code: 'PAPER_STUDIO_PLAN_VERSION_STALE',
      message: '该生产版本使用旧的场景化计划，已停止继续执行；请新建生产版本以使用通用能力链路',
      expected_planner_version: CURRENT_PLANNER_VERSION,
      actual_planner_version: Number(summary.planner_version || 0),
      at: now,
    };
    db.prepare("UPDATE paper_studio_shots SET status = 'stale', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, Number(shot.id));
    db.prepare("UPDATE paper_job_steps SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ? WHERE shot_id = ? AND status IN ('queued','failed_retryable','failed_terminal')").run(JSON.stringify(error), now, Number(shot.id));
    affectedRuns.add(Number(shot.run_id));
    stalePlans += 1;
  }
  affectedRuns.forEach((runId) => aggregateService.sync(db, runId));
  if ((running.length || orphanShots.length || stalePlans || orphanProofRuns.length || orphanLocalVideos.length || strandedLocalSteps.length || strandedRenderShots.length) && log) {
    log.warn('Paper studio startup recovery completed', {
      running_steps: running.length,
      orphan_shots: orphanShots.length,
      orphan_proof_runs: orphanProofRuns.length,
      orphan_local_videos: orphanLocalVideos.length,
      stranded_local_steps: strandedLocalSteps.length,
      stranded_render_shots: strandedRenderShots.length,
      stale_plans: stalePlans,
      requeued,
      blocked,
      run_ids: [...affectedRuns],
    });
  }
  return {
    interrupted_authorizations: interruptedAuthorizations.length,
    running_steps: running.length,
    orphan_shots: orphanShots.length,
    orphan_proof_runs: orphanProofRuns.length,
    orphan_local_videos: orphanLocalVideos.length,
    stranded_local_steps: strandedLocalSteps.length,
    stranded_render_shots: strandedRenderShots.length,
    stale_plans: stalePlans,
    requeued,
    blocked,
    run_ids: [...affectedRuns],
  };
}

module.exports = { RESTART_MESSAGE, LOCAL_RESTART_STEPS, recoverOnStartup };
