const fs = require('fs');
const path = require('path');

const videoMergeService = require('../videoMergeService');
const episodeService = require('./paperStudioEpisodeService');
const storyboardService = require('./paperStoryboardService');
const audioService = require('./paperStoryboardAudioService');
const storageLayout = require('../storageLayout');
const { safeStorageFile } = require('./paperAssetProductionService');
const schemaService = require('./paperStudioSchemaService');
const { PaperStudioError, assertExpectedVersion, canonicalJson, parseJson, sha256 } = require('./paperStudioUtils');

function list(db, episodeId) {
  episodeService.get(db, episodeId);
  return videoMergeService.list(db, { paper_episode_id: Number(episodeId) });
}

function sortedIds(values) {
  return [...values].map(Number).sort((left, right) => left - right);
}

function sameIds(left, right) {
  const a = sortedIds(left);
  const b = sortedIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function localVideoReady(cfg, video) {
  if (!video || video.status !== 'completed' || !video.local_path) return false;
  try {
    const absolute = safeStorageFile(cfg, video.local_path);
    if (!fs.existsSync(absolute)) return false;
    const stat = fs.statSync(absolute);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function deliveryBoard(db, cfg, episodeId) {
  const episode = episodeService.get(db, episodeId);
  const storyboards = storyboardService.list(db, episodeId);
  const items = storyboards.map((storyboard) => {
    const audio = audioService.workspace(db, cfg, storyboard.id);
    const video = storyboard.published_video_generation_id == null ? null : db.prepare(
      `SELECT id, status, video_url, local_path, render_hash, paper_snapshot_id, completed_at
       FROM video_generations WHERE id = ? AND paper_storyboard_id = ? AND deleted_at IS NULL`,
    ).get(Number(storyboard.published_video_generation_id), Number(storyboard.id));
    const snapshot = video?.paper_snapshot_id == null ? null : db.prepare(
      'SELECT snapshot_json, render_hash FROM paper_render_snapshots WHERE id = ?',
    ).get(Number(video.paper_snapshot_id));
    const snapshotJson = parseJson(snapshot?.snapshot_json, {});
    const embeddedAudioIds = (snapshotJson.audio || []).map((entry) => Number(entry.version_id)).filter(Boolean);
    const expectedAudioIds = [audio.dialogue?.id, audio.narration?.id].filter(Boolean).map(Number);
    const videoFileReady = localVideoReady(cfg, video);
    const audioEmbedded = Boolean(videoFileReady && audio.ready && sameIds(embeddedAudioIds, expectedAudioIds));
    const latestShot = db.prepare(
      `SELECT pss.id, pss.status, pss.run_id
       FROM paper_studio_shots pss
       JOIN paper_studio_runs psr ON psr.id = pss.run_id AND psr.deleted_at IS NULL
       WHERE pss.paper_storyboard_id = ? AND pss.deleted_at IS NULL
       ORDER BY psr.id DESC, pss.id DESC LIMIT 1`,
    ).get(Number(storyboard.id));
    const blockers = [];
    if (!storyboard.description || (!storyboard.environment_only && !storyboard.action)) blockers.push({ key: 'script', label: '补齐画面与动作' });
    if (!audio.ready) blockers.push({ key: 'audio', label: audio.missing.map((entry) => entry.kind === 'dialogue' ? '补对白音频' : entry.kind === 'narration' ? '补旁白音频' : '确认声音策略').join('、') });
    if (!video || video.status !== 'completed') blockers.push({ key: 'video', label: '发布正式视频' });
    else if (!videoFileReady) blockers.push({ key: 'video_file', label: '正式视频文件缺失，请重新渲染' });
    else if (!audioEmbedded) blockers.push({ key: 'audio_snapshot', label: '用当前声音重新渲染' });
    return {
      paper_storyboard_id: Number(storyboard.id),
      shot_number: Number(storyboard.shot_number),
      title: storyboard.title,
      duration: Number(storyboard.duration || 0),
      script_ready: !blockers.some((entry) => entry.key === 'script'),
      reference_ready: Boolean(storyboard.reference_local_path || storyboard.reference_image_url),
      latest_run_id: latestShot?.run_id == null ? null : Number(latestShot.run_id),
      latest_shot_id: latestShot?.id == null ? null : Number(latestShot.id),
      production_status: latestShot?.status || 'not_started',
      audio_ready: audio.ready,
      audio_mode: audio.audio_mode,
      audio_version_ids: expectedAudioIds,
      subtitle_ready: audio.audio_mode === 'silent' || Boolean(
        audio.ready
        && expectedAudioIds.length > 0
        && [audio.dialogue, audio.narration].filter(Boolean).every((version) => version.captions_json.length > 0 || !version.text_content)
      ),
      video_ready: videoFileReady,
      audio_embedded: audioEmbedded,
      video_generation_id: video?.id == null ? null : Number(video.id),
      video_url: video?.video_url || null,
      video_local_path: video?.local_path || null,
      render_hash: video?.render_hash || null,
      blockers,
      merge_ready: blockers.length === 0,
    };
  });
  const merges = list(db, episodeId);
  return {
    episode,
    items,
    ready: items.length > 0 && items.every((item) => item.merge_ready),
    ready_count: items.filter((item) => item.merge_ready).length,
    total_count: items.length,
    blockers: items.flatMap((item) => item.blockers.map((blocker) => ({ ...blocker, paper_storyboard_id: item.paper_storyboard_id, shot_number: item.shot_number, title: item.title }))),
    latest_merge: merges[0] || null,
    merges,
  };
}

function srtTimestamp(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function writeEpisodeSubtitles(db, cfg, episode, project, board, deliveryHash) {
  const fps = Number(episode.fps || 30);
  let offsetFrames = 0;
  const captions = [];
  for (const item of board.items) {
    const audio = audioService.workspace(db, cfg, item.paper_storyboard_id);
    for (const version of [audio.dialogue, audio.narration].filter(Boolean)) {
      for (const caption of version.captions_json || []) {
        captions.push({
          text: caption.text,
          start_frame: offsetFrames + Number(caption.start_frame || 0),
          end_frame: offsetFrames + Number(caption.end_frame || 0),
        });
      }
    }
    offsetFrames += Math.max(1, Math.round(Number(item.duration || 0) * fps));
  }
  if (!captions.length) return null;
  captions.sort((left, right) => left.start_frame - right.start_frame || left.end_frame - right.end_frame);
  const body = captions.map((caption, index) => [
    String(index + 1),
    `${srtTimestamp((caption.start_frame / fps) * 1000)} --> ${srtTimestamp((caption.end_frame / fps) * 1000)}`,
    caption.text,
    '',
  ].join('\n')).join('\n');
  const projectDir = storageLayout.getProjectStorageSubdir(db, project.drama_id);
  const relative = `${projectDir}/paper-studio/episodes/${episode.id}/deliveries/${deliveryHash.replace('sha256:', '')}.srt`.replace(/\\/g, '/');
  const absolute = safeStorageFile(cfg, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `\uFEFF${body}\n`, 'utf8');
  return relative;
}

function create(db, cfg, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperEpisodeMerge', body, '合并纸片分集的参数无效');
  const episode = episodeService.get(db, episodeId);
  assertExpectedVersion(episode.version, body.expected_version, '纸片分集');
  const board = deliveryBoard(db, cfg, episodeId);
  if (!board.items.length) throw new PaperStudioError('PAPER_EPISODE_EMPTY', '当前纸片分集还没有分镜', { paper_episode_id: Number(episodeId) }, 409);
  if (!board.ready) {
    throw new PaperStudioError(
      'PAPER_EPISODE_VIDEOS_INCOMPLETE',
      '所有纸片分镜的声音、字幕和正式视频都就绪后才能合并整集',
      { paper_episode_id: Number(episodeId), blockers: board.blockers },
      409,
    );
  }
  const project = db.prepare('SELECT drama_id FROM paper_studio_projects WHERE id = ? AND deleted_at IS NULL').get(Number(episode.project_id));
  const scenes = board.items.map((item, index) => ({
    scene_id: Number(item.paper_storyboard_id),
    paper_storyboard_id: Number(item.paper_storyboard_id),
    video_generation_id: Number(item.video_generation_id),
    video_url: item.video_local_path || item.video_url,
    duration: Number(item.duration || 0),
    order: index,
  }));
  const sourceManifest = {
    schema_version: 1,
    paper_episode_id: Number(episode.id),
    episode: {
      title: episode.title,
      aspect_ratio: episode.aspect_ratio,
      fps: Number(episode.fps || 30),
    },
    fps: Number(episode.fps || 30),
    scenes: board.items.map((item, index) => ({
      order: index,
      paper_storyboard_id: Number(item.paper_storyboard_id),
      video_generation_id: Number(item.video_generation_id),
      render_hash: item.render_hash,
      audio_version_ids: item.audio_version_ids,
      duration: Number(item.duration || 0),
    })),
  };
  const deliveryHash = sha256(canonicalJson(sourceManifest));
  const existing = db.prepare(
    `SELECT id FROM video_merges
     WHERE paper_episode_id = ? AND delivery_hash = ? AND deleted_at IS NULL
       AND status IN ('pending','processing','completed')
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(episode.id), deliveryHash);
  if (existing) return { merge: videoMergeService.getById(db, existing.id), scenes_count: scenes.length, reused: true };
  const subtitlePath = writeEpisodeSubtitles(db, cfg, episode, project, board, deliveryHash);
  const created = videoMergeService.createPaper(db, log, {
    paper_episode_id: Number(episode.id),
    drama_id: Number(project.drama_id),
    title: body.title?.trim() || episode.title,
    scenes,
    provider: 'ffmpeg',
  });
  const mergeId = Number(created.merge_id || created.id);
  db.prepare(
    `UPDATE video_merges
     SET delivery_hash = ?, source_manifest_json = ?, subtitle_local_path = ?
     WHERE id = ?`,
  ).run(deliveryHash, canonicalJson(sourceManifest), subtitlePath, mergeId);
  db.prepare("UPDATE paper_studio_episodes SET status = 'merging', updated_at = ?, version = version + 1 WHERE id = ?")
    .run(new Date().toISOString(), Number(episode.id));
  setImmediate(() => {
    Promise.resolve(videoMergeService.processVideoMerge(db, log, mergeId, cfg?.storage?.base_url)).catch((error) => {
      const now = new Date().toISOString();
      const message = String(error?.message || '纸片分集视频合并异常').slice(0, 1000);
      log?.error?.('Paper episode merge unhandled error', { merge_id: mergeId, paper_episode_id: Number(episode.id), error: message });
      db.prepare("UPDATE video_merges SET status = 'failed', error_msg = ?, completed_at = ? WHERE id = ?").run(message, now, mergeId);
      db.prepare("UPDATE paper_studio_episodes SET status = 'merge_failed', updated_at = ?, version = version + 1 WHERE id = ?").run(now, Number(episode.id));
      if (created.task_id) require('../taskService').updateTaskError(db, created.task_id, message);
    });
  });
  return { merge: videoMergeService.getById(db, mergeId), scenes_count: scenes.length, reused: false };
}

module.exports = { list, deliveryBoard, create };
