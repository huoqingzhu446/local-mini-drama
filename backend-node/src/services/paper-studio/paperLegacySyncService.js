const legacyStoryboardService = require('../storyboardService');
const schemaService = require('./paperStudioSchemaService');
const storyboardService = require('./paperStoryboardService');
const { PaperStudioError, assertExpectedVersion, nowIso } = require('./paperStudioUtils');

function sync(db, log, storyboardId, body = {}) {
  schemaService.assertValid('apiPaperSyncLegacy', body, '同步到旧工作台的参数无效');
  const paper = storyboardService.get(db, storyboardId);
  assertExpectedVersion(paper.version, body.expected_version, '纸片分镜');
  const episode = db.prepare(
    `SELECT e.* FROM episodes e
     WHERE e.id = ? AND e.drama_id = ? AND e.deleted_at IS NULL`,
  ).get(Number(body.legacy_episode_id), Number(paper.drama_id));
  if (!episode) throw new PaperStudioError('PAPER_STUDIO_LEGACY_EPISODE_NOT_FOUND', '目标旧工作台分集不存在或不属于当前项目', { legacy_episode_id: Number(body.legacy_episode_id) }, 404);

  let legacy = null;
  const requestedTarget = body.legacy_storyboard_id || paper.legacy_storyboard_id;
  if (requestedTarget) {
    legacy = db.prepare('SELECT * FROM storyboards WHERE id = ? AND episode_id = ? AND deleted_at IS NULL')
      .get(Number(requestedTarget), Number(episode.id));
    if (!legacy) throw new PaperStudioError('PAPER_STUDIO_LEGACY_STORYBOARD_MISMATCH', '目标旧分镜不存在或不属于所选分集', { legacy_storyboard_id: Number(requestedTarget), legacy_episode_id: Number(episode.id) }, 409);
  } else {
    const next = db.prepare('SELECT COALESCE(MAX(storyboard_number), 0) + 1 AS next_number FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').get(Number(episode.id));
    legacy = legacyStoryboardService.createStoryboard(db, log, {
      episode_id: Number(episode.id),
      storyboard_number: Number(next.next_number),
      title: paper.title,
      description: paper.description,
      duration: Number(paper.duration || 6),
      dialogue: paper.dialogue,
      action: paper.action,
      image_prompt: paper.visual_prompt,
      video_prompt: paper.visual_prompt,
    });
  }

  const syncReference = body.sync_reference_image !== false;
  const syncVideo = body.sync_published_video !== false;
  legacy = legacyStoryboardService.updateStoryboard(db, log, legacy.id, {
    title: paper.title,
    description: paper.description,
    action: paper.action,
    dialogue: paper.dialogue,
    narration: paper.narration,
    duration: Number(paper.duration || 6),
    shot_type: paper.shot_type,
    movement: paper.camera_motion,
    image_prompt: paper.visual_prompt,
    ...(syncReference ? { image_url: paper.reference_image_url, local_path: paper.reference_local_path } : {}),
    ...(syncVideo && paper.published_video_url ? { video_url: paper.published_video_local_path || paper.published_video_url, video_render_mode: 'paper_layered' } : {}),
  });
  const now = nowIso();
  db.prepare("UPDATE paper_storyboards SET legacy_storyboard_id = ?, source_kind = CASE WHEN source_kind = 'paper' THEN 'paper' ELSE source_kind END, version = version + 1, updated_at = ? WHERE id = ?")
    .run(Number(legacy.id), now, Number(paper.id));
  storyboardService.ensureRevision(db, paper.id, 'legacy_sync');
  log?.info?.('Paper storyboard explicitly synced to legacy workspace', {
    paper_storyboard_id: Number(paper.id), legacy_storyboard_id: Number(legacy.id), legacy_episode_id: Number(episode.id),
  });
  return { storyboard: storyboardService.get(db, paper.id), legacy_storyboard: legacy, created: !requestedTarget };
}

module.exports = { sync };
