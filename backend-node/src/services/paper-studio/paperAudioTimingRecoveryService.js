const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const storyboardAudioService = require('./paperStoryboardAudioService');
const motionGateService = require('./paperMotionGateService');
const runAggregateService = require('./paperRunAggregateService');
const revisionService = require('./paperSourceRevisionService');
const eventService = require('./paperStudioEventService');
const storyboardService = require('./paperStoryboardService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
} = require('./paperStudioUtils');

function reopen(db, cfg, log, shotId, body = {}) {
  schemaService.assertValid('apiShotAction', body, '按完整声音重排镜头的参数无效');
  revisionService.assertShotCurrent(db, shotId);
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!shot.paper_storyboard_id) throw new PaperStudioError('PAPER_STUDIO_AUDIO_TIMING_PAPER_ONLY', '只有独立纸片分镜支持按完整声音自动延长', { shot_id: Number(shot.id) }, 409);
  if (shot.status === 'rendering') throw new PaperStudioError('PAPER_AUDIO_RENDER_IN_PROGRESS', '当前分镜正在正式渲染，请等待完成后再重排声音时长', { shot_id: Number(shot.id) }, 409);
  const audio = storyboardAudioService.workspace(db, cfg, shot.paper_storyboard_id, shot.storyboard);
  if (!audio.ready) throw new PaperStudioError('PAPER_STUDIO_AUDIO_INCOMPLETE', '当前声音尚未就绪，不能重排镜头时长', { missing: audio.missing }, 409);
  const currentFrames = Number(shot.motion_plan?.plan_json?.duration_frames || 0);
  if (currentFrames >= Number(audio.effective_duration_frames || 0) && !['published', 'rendered', 'approved', 'preview_ready', 'proof_ready', 'proof_failed', 'render_failed'].includes(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_AUDIO_TIMING_ALREADY_CURRENT', '当前镜头已经覆盖完整声音，无需重新打开', { shot_id: Number(shot.id), duration_frames: currentFrames }, 409);
  }

  const now = nowIso();
  const previousVideoGenerationId = shot.published_video_generation_id == null ? null : Number(shot.published_video_generation_id);
  db.transaction(() => {
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')").run(Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('pending','running','passed','completed')").run(Number(shot.id));
    db.prepare("UPDATE paper_motion_plans SET status = 'confirmed', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ?")
      .run(now, Number(shot.id));
    db.prepare(
      `UPDATE paper_studio_shots
       SET status = 'asset_ready', current_snapshot_id = NULL, approved_snapshot_id = NULL,
           published_video_generation_id = NULL, attention_required = 'none',
           last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(now, Number(shot.id));
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'queued', result_json = '{}', error_json = '{}', lease_owner = NULL,
           lease_expires_at = NULL, started_at = NULL, completed_at = NULL,
           authorization_id = NULL, user_visible_status = NULL, updated_at = ?
       WHERE run_id = ? AND shot_id = ? AND step_key IN
         ('plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview',
          'wait_preview_approval','render_formal','publish_video')`,
    ).run(now, Number(shot.run_id), Number(shot.id));
    db.prepare(
      `UPDATE paper_storyboards
       SET published_video_generation_id = NULL, status = 'in_production',
           version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    ).run(now, Number(shot.paper_storyboard_id));
    const storyboard = db.prepare('SELECT paper_episode_id FROM paper_storyboards WHERE id = ?').get(Number(shot.paper_storyboard_id));
    if (storyboard) storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now, reason: '镜头已按完整声音延长，请重新审核和发布' });
    eventService.record(db, {
      runId: shot.run_id,
      shotId: shot.id,
      eventType: 'audio_timing_reopened',
      title: '已按完整声音重排镜头',
      message: `画面由 ${(currentFrames / Math.max(1, Number(audio.fps || 30))).toFixed(1)} 秒延长至 ${audio.effective_duration_seconds} 秒`,
      details: { previous_video_generation_id: previousVideoGenerationId, current_duration_frames: currentFrames, effective_duration_frames: audio.effective_duration_frames },
    });
  })();
  runAggregateService.sync(db, shot.run_id);
  const reopened = shotService.get(db, shot.id);
  const planned = motionGateService.planMotion(db, cfg, log, shot.id, {
    request_id: body.request_id,
    expected_version: reopened.version,
  });
  return {
    ...planned,
    previous_video_generation_id: previousVideoGenerationId,
    audio_timing: storyboardAudioService.workspace(db, cfg, shot.paper_storyboard_id, shot.storyboard),
  };
}

module.exports = { reopen };
