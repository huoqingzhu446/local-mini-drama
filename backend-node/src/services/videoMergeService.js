const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg, hasLocalFfprobe } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.paper_episode_id) {
    sql += ' AND paper_episode_id = ?';
    params.push(query.paper_episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  let sourceManifest = {};
  try { sourceManifest = JSON.parse(r.source_manifest_json || '{}'); } catch (_) {}
  return {
    id: r.id,
    episode_id: r.episode_id,
    paper_episode_id: r.paper_episode_id == null ? null : Number(r.paper_episode_id),
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    subtitle_local_path: r.subtitle_local_path || null,
    subtitle_url: r.subtitle_local_path ? `/static/${String(r.subtitle_local_path).replace(/^\/+/, '')}` : null,
    delivery_hash: r.delivery_hash || null,
    source_manifest_json: sourceManifest,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = req.merge_options;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function createPaper(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const paperEpisodeId = Number(req.paper_episode_id);
  const task = taskService.createTask(db, log, 'paper_video_merge', String(paperEpisodeId));
  const mergeOptionsJson = req.merge_options && typeof req.merge_options === 'object'
    ? JSON.stringify(req.merge_options)
    : '{}';
  const info = db.prepare(
    `INSERT INTO video_merges
      (episode_id, paper_episode_id, drama_id, title, provider, model, status, scenes,
       merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    -Math.abs(paperEpisodeId),
    paperEpisodeId,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now,
  );
  return { merge_id: Number(info.lastInsertRowid), task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    // 前端常用 /static/<storage-relative-path>；static 不是 storageRoot 下的真实目录。
    const relative = u.replace(/^\/+/, '').replace(/^static\//, '');
    const localPath = path.join(storageRoot, relative.replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

function parseFrameRate(raw) {
  if (raw == null) return 0;
  const text = String(raw).trim();
  if (!text || text === '0/0') return 0;
  if (text.includes('/')) {
    const [n, d] = text.split('/').map(Number);
    return Number.isFinite(n) && Number.isFinite(d) && d !== 0 ? n / d : 0;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** 探测真实媒体流；仅靠扩展名无法区分被误传入的首尾帧图片。 */
function probeMediaFile(filePath, log) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,time_base,duration,sample_rate,channels,channel_layout',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    log?.warn?.('Video merge: ffprobe failed', {
      path: filePath,
      error: result.error?.message,
      stderr: result.stderr?.slice(-500),
    });
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    if (!video || !Number(video.width) || !Number(video.height)) return null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const formatDuration = Number(parsed.format?.duration) || 0;
    const videoDuration = Number(video.duration) || formatDuration;
    if (!(videoDuration > 0)) return null;
    return {
      path: filePath,
      duration: videoDuration,
      formatDuration,
      video,
      audio,
      frameRate: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
    };
  } catch (error) {
    log?.warn?.('Video merge: ffprobe output parse failed', { path: filePath, error: error.message });
    return null;
  }
}

function sameStreamValue(a, b, key) {
  return String(a?.[key] ?? '') === String(b?.[key] ?? '');
}

/** concat demuxer 的 -c copy 只适用于编码参数和流布局完全一致的片段。 */
function streamsAreCopyCompatible(infos) {
  if (!Array.isArray(infos) || infos.length < 2) return true;
  const first = infos[0];
  return infos.slice(1).every((info) => {
    const videoSame = [
      'codec_name', 'width', 'height', 'pix_fmt', 'avg_frame_rate', 'r_frame_rate', 'time_base',
    ].every((key) => sameStreamValue(first.video, info.video, key));
    if (!videoSame || Boolean(first.audio) !== Boolean(info.audio)) return false;
    if (!first.audio) return true;
    return [
      'codec_name', 'sample_rate', 'channels', 'channel_layout', 'time_base',
    ].every((key) => sameStreamValue(first.audio, info.audio, key));
  });
}

function verifyMergedOutput(outputPath, expectedDuration, log) {
  const info = probeMediaFile(outputPath, log);
  if (!info) return { ok: false, error: '合成文件不包含可播放的视频流' };
  const actualDuration = Number(info.formatDuration) || Number(info.duration) || 0;
  const tolerance = Math.max(1, expectedDuration * 0.05);
  if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
    return {
      ok: false,
      duration: actualDuration,
      error: `合成时长异常：期望约 ${expectedDuration.toFixed(2)} 秒，实际 ${actualDuration.toFixed(2)} 秒`,
    };
  }
  return { ok: true, duration: actualDuration, info };
}

/** 对参数完全一致的片段执行无损快速拼接。 */
function runFfmpegCopyConcat(localPaths, outputPath, log) {
  const ffmpegBin = getFfmpegPath();
  const listFile = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
  try {
    const lines = localPaths.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      outputPath,
    ];
    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) {
      log.warn('Video merge: ffmpeg spawn error', { error: result.error.message });
      return false;
    }
    if (result.status !== 0) {
      log.warn('Video merge: ffmpeg failed', { stderr: result.stderr?.slice(-500) });
      return false;
    }
    return true;
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
  }
}

/**
 * 统一每段视频的画幅、帧率、时间基准和音轨后再拼接。
 * 没有音频的片段补静音轨，避免“第一段有声、后续无声”导致 concat 时间戳错乱。
 */
function runFfmpegReencodeConcat(infos, outputPath, log) {
  const ffmpegBin = getFfmpegPath();
  const firstVideo = infos[0].video;
  const targetWidth = Math.max(2, Math.round(Number(firstVideo.width) / 2) * 2);
  const targetHeight = Math.max(2, Math.round(Number(firstVideo.height) / 2) * 2);
  const detectedMaxFps = Math.max(...infos.map((info) => info.frameRate || 0), 0);
  const targetFps = Math.min(30, Math.max(24, Math.round(detectedMaxFps || 30)));
  const args = ['-y'];
  for (const info of infos) args.push('-i', info.path);

  const filters = [];
  const concatInputs = [];
  infos.forEach((info, index) => {
    const duration = Math.max(0.04, Number(info.duration) || 0).toFixed(6);
    filters.push(
      `[${index}:v:0]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,`
      + `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,`
      + `fps=${targetFps},setsar=1,trim=duration=${duration},settb=AVTB,setpts=PTS-STARTPTS[v${index}]`
    );
    if (info.audio) {
      filters.push(
        `[${index}:a:0]aresample=48000:async=1:first_pts=0,`
        + 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
        + `apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
      );
    } else {
      filters.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000,`
        + `atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${infos.length}:v=1:a=1[vout][aout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  );
  const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    log.warn('Video merge: ffmpeg reencode spawn error', { error: result.error.message });
    return false;
  }
  if (result.status !== 0) {
    log.warn('Video merge: ffmpeg reencode failed', { stderr: result.stderr?.slice(-1500) });
    return false;
  }
  return true;
}

/** 可靠合并：兼容时快速流拷贝，否则统一转码；两条路径都必须通过真实时长校验。 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const infos = localPaths.map((p) => probeMediaFile(p, log));
  if (infos.some((info) => !info)) {
    return { ok: false, error: '存在无法读取或不含视频流的片段' };
  }
  const expectedDuration = infos.reduce((sum, info) => sum + info.duration, 0);
  if (streamsAreCopyCompatible(infos)) {
    const copied = runFfmpegCopyConcat(localPaths, outputPath, log);
    if (copied) {
      const verified = verifyMergedOutput(outputPath, expectedDuration, log);
      if (verified.ok) return { ...verified, expectedDuration, mode: 'copy' };
      log.warn('Video merge: copy concat verification failed, retrying with reencode', {
        error: verified.error,
      });
    }
  }
  try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
  const encoded = runFfmpegReencodeConcat(infos, outputPath, log);
  if (!encoded) return { ok: false, error: 'FFmpeg 统一转码合并失败' };
  const verified = verifyMergedOutput(outputPath, expectedDuration, log);
  return verified.ok
    ? { ...verified, expectedDuration, mode: 'reencode' }
    : { ok: false, error: verified.error || '合成后时长校验失败' };
}

function cleanupFiles(paths) {
  for (const p of paths || []) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

function failVideoMerge(db, taskService, mergeId, taskId, episodeId, message, paperEpisodeId = null) {
  const now = new Date().toISOString();
  const error = String(message || '视频合并失败').slice(0, 1000);
  const updated = db.prepare("UPDATE video_merges SET status = ?, error_msg = ?, completed_at = ? WHERE id = ? AND status != 'stale'")
    .run('failed', error, now, mergeId);
  if (!updated.changes) return false;
  if (paperEpisodeId != null) {
    db.prepare('UPDATE paper_studio_episodes SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL')
      .run('merge_failed', now, Number(paperEpisodeId));
  } else {
    db.prepare('UPDATE episodes SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, episodeId);
  }
  if (taskId) taskService.updateTaskError(db, taskId, error);
  return true;
}

/**
 * 异步处理视频合成。所有片段必须可读，输出必须通过真实时长校验；不再用首段伪装合成成功。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  const paperEpisodeId = r.paper_episode_id == null ? null : Number(r.paper_episode_id);
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const claimed = db.prepare("UPDATE video_merges SET status = 'processing' WHERE id = ? AND status = 'pending'").run(mergeId);
  if (!claimed.changes) return;
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    failVideoMerge(db, taskService, mergeId, taskId, episodeId, '无有效视频片段', paperEpisodeId);
    return;
  }
  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const localPaths = [];
  const toCleanup = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i].video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (p) {
      localPaths.push(p);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const ffmpegAvailable = hasLocalFfmpeg();
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  if (!ffmpegAvailable) {
    cleanupFiles(toCleanup);
    failVideoMerge(db, taskService, mergeId, taskId, episodeId, '服务器未安装 FFmpeg，无法合成视频', paperEpisodeId);
    return;
  }
  if (!hasLocalFfprobe()) {
    cleanupFiles(toCleanup);
    failVideoMerge(db, taskService, mergeId, taskId, episodeId, '服务器未安装 FFprobe，无法校验视频片段和合成时长', paperEpisodeId);
    return;
  }
  if (localPaths.length !== scenes.length) {
    cleanupFiles(toCleanup);
    failVideoMerge(
      db,
      taskService,
      mergeId,
      taskId,
      episodeId,
      `有 ${scenes.length - localPaths.length} 个视频片段无法读取，已停止合成`,
      paperEpisodeId,
    );
    return;
  }

  let mergedRelativePath = null;
  let mergedDuration = 0;
  let expectedDuration = 0;
  let outputPath = null;
  if (localPaths.length > 0 && localPaths.length <= 100) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    outputPath = path.join(mergedDir, outputFileName);
    const result = runFfmpegConcat(localPaths, outputPath, log);
    if (result.ok && fs.existsSync(outputPath)) {
      mergedDuration = result.duration;
      expectedDuration = result.expectedDuration;
      mergedRelativePath = sub
        ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
        : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', {
        merge_id: mergeId,
        episode_id: episodeId,
        output: mergedRelativePath,
        duration: mergedDuration,
        mode: result.mode,
      });
    } else {
      cleanupFiles([...toCleanup, outputPath]);
      failVideoMerge(db, taskService, mergeId, taskId, episodeId, result.error || '视频合并失败', paperEpisodeId);
      return;
    }
  }

  if (!mergedRelativePath) {
    cleanupFiles(toCleanup);
    failVideoMerge(db, taskService, mergeId, taskId, episodeId, '没有生成有效的合成视频', paperEpisodeId);
    return;
  }

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postNeed =
    !!mergeOpts.burn_narration_subtitles
    || !!mergeOpts.burn_dialogue_audio
    || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
  if (mergedRelativePath && ffmpegAvailable && postNeed) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        storageRoot,
        scenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process skipped', { merge_id: mergeId, err: post.error });
      }
    }
  }

  const finalAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
  const finalVerified = verifyMergedOutput(finalAbsPath, expectedDuration, log);
  cleanupFiles(toCleanup);
  if (!finalVerified.ok) {
    failVideoMerge(db, taskService, mergeId, taskId, episodeId, finalVerified.error || '合成视频校验失败', paperEpisodeId);
    return;
  }
  mergedDuration = finalVerified.duration;

  const finalMergedUrl = mergedRelativePath;
  const completedAt = new Date().toISOString();
  let committed = false;
  const finish = db.transaction(() => {
    const updated = db.prepare(
      "UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ? AND status = 'processing'"
    ).run('completed', finalMergedUrl, Math.round(mergedDuration) || null, completedAt, null, mergeId);
    if (!updated.changes) return;
    if (paperEpisodeId != null) {
      db.prepare('UPDATE paper_studio_episodes SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL')
        .run('published', completedAt, paperEpisodeId);
    } else {
      db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', completedAt, episodeId);
    }
    if (taskId) {
      taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(mergedDuration) });
    }
    committed = true;
  });
  finish();
  if (!committed) cleanupFiles([finalAbsPath, outputPath].filter(Boolean));
}

module.exports = {
  list,
  getById,
  create,
  createPaper,
  deleteById,
  processVideoMerge,
  _test: {
    parseFrameRate,
    probeMediaFile,
    streamsAreCopyCompatible,
    verifyMergedOutput,
    runFfmpegConcat,
  },
};
