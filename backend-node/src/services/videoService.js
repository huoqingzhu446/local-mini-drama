/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now) {
  try {
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
}

function list(db, query) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    generation_kind: r.generation_kind || 'ai',
    paper_composition_id: r.paper_composition_id,
    render_hash: r.render_hash,
    renderer_version: r.renderer_version,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

/**
 * 将远程 video_url 下载到本地
 * @returns {string|null} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = path.join(dir, name);
    const res = await fetch(videoUrl, { method: 'GET' });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    log.warn('Download video error', { videoGenId, error: e.message });
    return null;
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免 Grok 等返回实际像素不一致导致连播时画面跳动。
 */
function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  if (!hasLocalFfmpeg()) {
    log.info('[视频] 未找到 ffmpeg，跳过画幅归一化', { videoGenId });
    return false;
  }
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    r = spawnSync(ffmpeg, [...baseArgs, '-an', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    fs.renameSync(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
}

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
  normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

/** 防止同一 videoGenId 重复发起 poll（含重启恢复） */
const activeVideoPolls = new Set();

function resolveStoragePath(cfg) {
  return path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
}

async function finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, videoUrl, logLabel) {
  const now = new Date().toISOString();
  let localPath = null;
  try {
    const cfg = require('../config').loadConfig();
    const storagePath = resolveStoragePath(cfg);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    localPath = await downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir);
    maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
  } catch (_) {}
  try {
    db.prepare(
      'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run('completed', videoUrl, localPath, now, now, videoGenId);
  } catch (e) {
    if ((e.message || '').includes('completed_at')) {
      db.prepare(
        'UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
      ).run('completed', videoUrl, localPath, now, videoGenId);
    } else throw e;
  }
  if (row.storyboard_id) {
    try {
      db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(
        videoUrl, localPath, now, row.storyboard_id
      );
      log.info('Updated storyboard video' + (logLabel ? ` (${logLabel})` : ''), {
        storyboard_id: row.storyboard_id,
        video_url: videoUrl,
      });
    } catch (_) {}
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: videoGenId,
      video_url: videoUrl,
      status: 'completed',
    });
  }
  log.info('Video generation completed' + (logLabel ? ` (${logLabel})` : ''), {
    id: videoGenId,
    video_url: videoUrl,
    local_path: localPath,
  });
}

async function pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = await videoClient.pollVideoTask(
    db,
    log,
    videoGenId,
    providerTaskId,
    config,
    pollMaxAttempts,
    POLL_INTERVAL_MS
  );
  const now = new Date().toISOString();
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
  if (polledVideo.ok) {
    await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, polledVideo.video_url, 'after poll');
  } else {
    setVideoGenFailed(db, videoGenId, polledVideo.error, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 服务重启后恢复对厂商异步任务的轮询（需已持久化 provider_task_id）
 */
async function resumePollForVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row || row.status !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  const config = videoClient.getDefaultVideoConfig(db, row.model);
  if (!config) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
    return;
  }

  activeVideoPolls.add(videoGenId);
  log.info('Resuming video generation poll after restart', {
    videoGenId,
    provider_task_id: providerTaskId,
  });
  try {
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
  } catch (err) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log) {
  const stuck = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')`
    )
    .all();
  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';
  for (const s of stuck) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, s.id, stuckMsg, now);
    if (s.task_id) taskService.updateTaskError(db, s.task_id, stuckMsg);
    log.warn('Marked interrupted video generation as failed', { videoGenId: s.id });
  }

  const resumable = db
    .prepare(
      `SELECT id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''`
    )
    .all();
  if (resumable.length) {
    log.info('Resuming video generation polls', { count: resumable.length });
  }
  for (const r of resumable) {
    setImmediate(() => {
      resumePollForVideoGeneration(db, log, r.id).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
}

async function processVideoGeneration(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video generation already in progress, skip duplicate', { videoGenId });
    return;
  }
  activeVideoPolls.add(videoGenId);
  log.info('processVideoGeneration started', { videoGenId });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) {
    activeVideoPolls.delete(videoGenId);
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, videoGenId);
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const config = videoClient.getDefaultVideoConfig(db, row.model);
    if (!config) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    let reference_urls = null;
    if (row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    // 优先使用分镜自身的镜头时长（storyboard.duration），其次用 video_generations.duration
    let effectiveDuration = row.duration || null;
    if (row.storyboard_id) {
      const sb = db.prepare('SELECT duration FROM storyboards WHERE id = ?').get(row.storyboard_id);
      if (sb && sb.duration > 0) {
        effectiveDuration = sb.duration;
        log.info('使用分镜镜头时长', { storyboard_id: row.storyboard_id, duration: effectiveDuration, video_gen_id: videoGenId });
      }
    }
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const hasOmniRefs = !!(reference_urls && reference_urls.length > 0);
    if (row.task_id && hasOmniRefs) {
      taskService.updateTaskStatus(
        db,
        row.task_id,
        'processing',
        5,
        `正在上传 ${reference_urls.length} 张参考图到图床…`
      );
    }
    const result = await videoClient.callVideoApi(db, log, {
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: hasOmniRefs ? undefined : row.image_url,
      first_frame_url: hasOmniRefs ? undefined : row.first_frame_url,
      last_frame_url: hasOmniRefs ? undefined : row.last_frame_url,
      reference_urls,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
    });
    const now2 = new Date().toISOString();
    if (result.error) {
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, directVideo.video_url, '');
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      db.prepare(
        'UPDATE video_generations SET status = ?, provider_task_id = ?, updated_at = ? WHERE id = ?'
      ).run('processing', result.task_id, now2, videoGenId);
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, config);
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const now2 = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now2);
    if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation error', { id: videoGenId, error: err.message });
  } finally {
    activeVideoPolls.delete(videoGenId);
  }
}

function deleteById(db, log, id) {
  const videoId = Number(id);
  const now = new Date().toISOString();
  // 删除当前分镜视频时同步解除 storyboards 绑定，避免合成流程继续引用已删除地址。
  // 仅在分镜仍指向这条视频时清理，防止误清理后来生成并绑定的新视频。
  try {
    const row = db.prepare(
      'SELECT storyboard_id, video_url, local_path FROM video_generations WHERE id = ? AND deleted_at IS NULL'
    ).get(videoId);
    if (row?.storyboard_id != null) {
      const matchClauses = [];
      const matchParams = [];
      if (row.video_url) {
        matchClauses.push('video_url = ?');
        matchParams.push(row.video_url);
      }
      if (row.local_path) {
        matchClauses.push('local_path = ?');
        matchParams.push(row.local_path);
      }
      if (matchClauses.length > 0) {
        db.prepare(
          `UPDATE storyboards
           SET video_url = NULL, local_path = NULL, updated_at = ?
           WHERE id = ? AND (${matchClauses.join(' OR ')})`
        ).run(now, row.storyboard_id, ...matchParams);
      }
    }
  } catch (e) {
    try { log?.warn?.('[video delete] 清除分镜绑定失败', { id: videoId, err: e.message }); } catch (_) {}
  }
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, videoId);
  return result.changes > 0;
}

/**
 * Finalize a video that was rendered locally. This path intentionally never
 * calls videoClient and keeps the video row, storyboard pointer, paper
 * composition and async task in one SQLite transaction.
 */
function finalizeLocalVideoGeneration(db, log, input = {}) {
  const videoGenerationId = Number(input.video_generation_id);
  const compositionId = Number(input.paper_composition_id);
  const fail = (code, message, details) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  };
  if (!Number.isInteger(videoGenerationId) || videoGenerationId <= 0 || !Number.isInteger(compositionId) || compositionId <= 0) {
    throw fail('LOCAL_VIDEO_INVALID_ARGUMENT', '本地视频回写缺少有效记录 ID');
  }
  if (!String(input.video_url || '').trim() || !String(input.local_path || '').trim() || !String(input.render_hash || '').trim()) {
    throw fail('LOCAL_VIDEO_INVALID_ARGUMENT', '本地视频回写缺少 video_url、local_path 或 render_hash');
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(videoGenerationId);
  if (!row) throw fail('LOCAL_VIDEO_NOT_FOUND', 'Local video generation record not found');
  if ((row.generation_kind || 'ai') !== 'paper_layered') throw fail('LOCAL_VIDEO_KIND_INVALID', 'Local finalizer only accepts paper_layered records');
  if (Number(row.paper_composition_id) !== compositionId) {
    throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', '视频记录与纸片合成不匹配', { video_generation_id: videoGenerationId, paper_composition_id: compositionId });
  }
  const composition = db.prepare('SELECT * FROM paper_compositions WHERE id = ? AND deleted_at IS NULL').get(compositionId);
  if (!composition || Number(composition.storyboard_id) !== Number(row.storyboard_id)) throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', 'Paper composition/video ownership mismatch');
  if (row.render_hash && row.render_hash !== input.render_hash) {
    throw fail('LOCAL_VIDEO_RENDER_HASH_CONFLICT', '视频记录已有不同的 render hash', { expected: row.render_hash, actual: input.render_hash });
  }

  const serializedSnapshot = typeof input.render_snapshot === 'string'
    ? input.render_snapshot
    : JSON.stringify(input.render_snapshot || {});
  const taskResult = {
    ...(input.task_result && typeof input.task_result === 'object' ? input.task_result : {}),
    video_generation_id: videoGenerationId,
    composition_id: compositionId,
    video_url: input.video_url,
    local_path: input.local_path,
    render_hash: input.render_hash,
    status: 'completed',
  };
  let idempotent = false;
  const tx = db.transaction(() => {
    // Re-read inside the transaction so two retrying workers converge on the
    // same completed row instead of overwriting each other's artifact.
    const currentComposition = db.prepare('SELECT * FROM paper_compositions WHERE id = ? AND deleted_at IS NULL').get(compositionId);
    if (!currentComposition) throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', '纸片合成已被删除或不存在', { paper_composition_id: compositionId });
    const current = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(videoGenerationId);
    if (!current) throw fail('LOCAL_VIDEO_NOT_FOUND', 'Local video generation record not found');
    if ((current.generation_kind || 'ai') !== 'paper_layered'
      || Number(current.paper_composition_id) !== compositionId
      || Number(current.storyboard_id) !== Number(currentComposition.storyboard_id)) {
      throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', '视频记录与纸片合成不匹配', { video_generation_id: videoGenerationId, paper_composition_id: compositionId });
    }
    if (current.render_hash && current.render_hash !== input.render_hash) {
      throw fail('LOCAL_VIDEO_RENDER_HASH_CONFLICT', '视频记录已有不同的 render hash', { expected: current.render_hash, actual: input.render_hash });
    }
    if (current.status === 'completed') {
      const sameArtifact = current.render_hash === input.render_hash
        && current.video_url === input.video_url
        && current.local_path === input.local_path;
      if (!sameArtifact) throw fail('LOCAL_VIDEO_FINALIZE_CONFLICT', '本地视频记录已完成且 artifact 不一致', { video_generation_id: videoGenerationId });
      idempotent = true;
      // A crash could theoretically commit the video row before the task
      // update. Repair only that missing task state; never rewrite completed
      // video/storyboard timestamps on an idempotent retry.
      if (current.task_id) {
        const task = db.prepare('SELECT status FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(current.task_id);
        if (task && task.status !== 'completed') taskService.updateTaskResult(db, current.task_id, taskResult);
      }
      return;
    }
    const now = new Date().toISOString();
    const update = db.prepare(
      `UPDATE video_generations SET status = 'completed', video_url = ?, local_path = ?, completed_at = ?, updated_at = ?,
       render_snapshot = ?, render_hash = ?, renderer_version = ? WHERE id = ? AND status <> 'completed'`
    ).run(input.video_url, input.local_path, now, now, serializedSnapshot, input.render_hash, input.renderer_version, videoGenerationId);
    if (!update.changes) throw fail('LOCAL_VIDEO_FINALIZE_CONFLICT', '本地视频记录已被其他任务完成', { video_generation_id: videoGenerationId });
    const storyboardUpdate = db.prepare('UPDATE storyboards SET video_url = ?, local_path = ?, updated_at = ? WHERE id = ?')
      .run(input.video_url, input.local_path, now, current.storyboard_id);
    if (!storyboardUpdate.changes) throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', '关联分镜不存在，无法完成本地视频回写', { storyboard_id: current.storyboard_id });
    const compositionUpdate = db.prepare("UPDATE paper_compositions SET status = 'rendered', last_proof_hash = ?, renderer_version = ?, updated_at = ? WHERE id = ?")
      .run(input.last_proof_hash || null, input.renderer_version || null, now, compositionId);
    if (!compositionUpdate.changes) throw fail('LOCAL_VIDEO_OWNERSHIP_MISMATCH', '纸片合成已被删除，无法完成本地视频回写', { paper_composition_id: compositionId });
    if (current.task_id) {
      const task = db.prepare('SELECT id FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(current.task_id);
      if (!task) throw fail('LOCAL_VIDEO_TASK_MISSING', '本地视频异步任务不存在', { task_id: current.task_id });
      taskService.updateTaskResult(db, current.task_id, taskResult);
    }
  });
  try {
    tx();
  } catch (error) {
    // The success updates remain all-or-nothing. On the error path, persist a
    // terminal task state outside the rolled-back transaction so callers do
    // not leave an orphaned processing task after a partial DB failure.
    try {
      if (row.task_id) {
        const task = db.prepare('SELECT status FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(row.task_id);
        if (task && task.status !== 'completed') taskService.updateTaskError(db, row.task_id, error.message || '本地视频回写失败');
      }
    } catch (_) {}
    throw error;
  }
  if (log) log.info('Local paper video generation completed', { video_generation_id: videoGenerationId, composition_id: compositionId, render_hash: input.render_hash, idempotent });
  return getById(db, videoGenerationId);
}

module.exports = {
  list,
  getById,
  deleteById,
  processVideoGeneration,
  resumeProcessingVideoGenerations,
  finalizeLocalVideoGeneration,
};
