const fs = require('fs');
const path = require('path');

const schemaService = require('./paperStudioSchemaService');
const storyboardService = require('./paperStoryboardService');
const storageLayout = require('../storageLayout');
const ttsService = require('../ttsService');
const runAggregateService = require('./paperRunAggregateService');
const speechDurationService = require('./paperSpeechDurationService');
const { ffprobeDurationSec } = require('../mergedEpisodePostProcess');
const { safeStorageFile } = require('./paperAssetProductionService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const AUDIO_KINDS = Object.freeze(['dialogue', 'narration']);
const POINTER_COLUMN = Object.freeze({
  dialogue: 'current_dialogue_audio_version_id',
  narration: 'current_narration_audio_version_id',
});

function boolValue(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMultipartBody(body = {}) {
  return {
    request_id: String(body.request_id || ''),
    expected_version: Number(body.expected_version),
    audio_kind: String(body.audio_kind || ''),
    volume: numberValue(body.volume, 1),
    start_seconds: numberValue(body.start_seconds, 0),
    captions_enabled: boolValue(body.captions_enabled, true),
    ...(body.caption_text == null ? {} : { caption_text: String(body.caption_text) }),
  };
}

function textForKind(source, kind) {
  return String(source?.[kind] || '').trim();
}

function textHash(text) {
  return sha256(String(text || '').trim());
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    paper_storyboard_revision_id: row.paper_storyboard_revision_id == null ? null : Number(row.paper_storyboard_revision_id),
    parent_version_id: row.parent_version_id == null ? null : Number(row.parent_version_id),
    version_number: Number(row.version_number),
    speed: Number(row.speed || 1),
    volume: Number(row.volume == null ? 1 : row.volume),
    start_frame: Number(row.start_frame || 0),
    end_frame: row.end_frame == null ? null : Number(row.end_frame),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    captions_json: parseJson(row.captions_json, []),
    error_json: parseJson(row.error_json, {}),
    audio_url: row.local_path ? `/static/${String(row.local_path).replace(/^\/+/, '')}` : null,
    subtitle_url: row.subtitle_local_path ? `/static/${String(row.subtitle_local_path).replace(/^\/+/, '')}` : null,
  };
}

function getVersion(db, versionId) {
  const row = db.prepare('SELECT * FROM paper_storyboard_audio_versions WHERE id = ? AND deleted_at IS NULL').get(Number(versionId));
  if (!row) throw new PaperStudioError('PAPER_AUDIO_VERSION_NOT_FOUND', '纸片分镜音频版本不存在', { audio_version_id: Number(versionId) }, 404);
  return hydrate(row);
}

function currentVersion(db, storyboard, kind) {
  const id = storyboard?.[POINTER_COLUMN[kind]];
  if (id == null) return null;
  const row = db.prepare(
    `SELECT * FROM paper_storyboard_audio_versions
     WHERE id = ? AND paper_storyboard_id = ? AND audio_kind = ? AND deleted_at IS NULL`,
  ).get(Number(id), Number(storyboard.id), kind);
  return hydrate(row);
}

function episodeFps(db, storyboardId) {
  return Number(db.prepare(
    `SELECT pe.fps FROM paper_storyboards ps
     JOIN paper_studio_episodes pe ON pe.id = ps.paper_episode_id
     WHERE ps.id = ? AND ps.deleted_at IS NULL AND pe.deleted_at IS NULL`,
  ).get(Number(storyboardId))?.fps || 30);
}

function splitCaptionText(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) return [];
  const logical = normalized.split(/\n+/).flatMap((line) => line.split(/(?<=[。！？!?；;])/)).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  for (const line of logical) {
    if (line.length <= 28) {
      chunks.push(line);
      continue;
    }
    for (let index = 0; index < line.length; index += 28) chunks.push(line.slice(index, index + 28));
  }
  return chunks;
}

function buildCaptions(text, kind, startFrame, endFrame) {
  const chunks = splitCaptionText(text);
  if (!chunks.length) return [];
  const start = Math.max(0, Math.round(Number(startFrame || 0)));
  const end = Math.max(start + chunks.length, Math.round(Number(endFrame || start + chunks.length)));
  const span = end - start;
  const weights = chunks.map((caption) => {
    const spoken = String(caption).replace(/[\s，。！？!?；;、：“”‘’（）()《》]/g, '').length;
    const pause = (String(caption).match(/[，、]/g) || []).length * 0.35
      + (String(caption).match(/[。！？!?；;]/g) || []).length * 0.8;
    return Math.max(1, spoken + pause);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumedWeight = 0;
  return chunks.map((caption, index) => ({
    key: `${kind}_${index + 1}`,
    kind,
    text: caption,
    start_frame: index === 0 ? start : Math.round(start + ((span * consumedWeight) / totalWeight)),
    end_frame: (() => {
      consumedWeight += weights[index];
      return index === chunks.length - 1
        ? end
        : Math.max(start + index + 1, Math.round(start + ((span * consumedWeight) / totalWeight)));
    })(),
    timing_source: 'speech-weighted-estimate',
  })).map((caption, index, all) => ({
    ...caption,
    start_frame: index === 0 ? start : all[index - 1].end_frame,
    end_frame: Math.max(index === 0 ? start + 1 : all[index - 1].end_frame + 1, caption.end_frame),
  }));
}

function captionsForVersion(version, fps) {
  const saved = Array.isArray(version?.captions_json) ? version.captions_json : [];
  if (!saved.length) return [];
  const startFrame = Math.max(0, Math.round(Number(version.start_frame || 0)));
  const endFrame = speechDurationService.audioEndFrame(version, fps);
  const savedStart = Number(saved[0]?.start_frame || 0);
  const savedEnd = Number(saved.at(-1)?.end_frame || 0);
  if (savedStart === startFrame && savedEnd === endFrame) return saved;
  return buildCaptions(version.text_content, version.audio_kind, startFrame, endFrame);
}

function srtTimestamp(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function writeSubtitle(cfg, relativeAudioPath, captions, fps) {
  if (!captions.length) return null;
  const relative = String(relativeAudioPath).replace(/\.[^.]+$/, '.srt');
  const absolute = safeStorageFile(cfg, relative);
  const body = captions.map((caption, index) => [
    String(index + 1),
    `${srtTimestamp((caption.start_frame / fps) * 1000)} --> ${srtTimestamp((caption.end_frame / fps) * 1000)}`,
    caption.text,
    '',
  ].join('\n')).join('\n');
  fs.writeFileSync(absolute, `\uFEFF${body}\n`, 'utf8');
  return relative;
}

function audioDirectory(db, storyboard) {
  const projectDir = storageLayout.getProjectStorageSubdir(db, storyboard.drama_id);
  return `${projectDir}/paper-studio/episodes/${storyboard.paper_episode_id}/storyboards/${storyboard.id}/audio`.replace(/\\/g, '/');
}

function assertNoRenderInProgress(db, storyboardId) {
  const running = db.prepare(
    `SELECT id, run_id FROM paper_studio_shots
     WHERE paper_storyboard_id = ? AND deleted_at IS NULL AND status = 'rendering'
     LIMIT 1`,
  ).get(Number(storyboardId));
  if (running) {
    throw new PaperStudioError(
      'PAPER_AUDIO_RENDER_IN_PROGRESS',
      '当前分镜正在正式渲染；请等待完成后再修改声音，以免产物版本不一致',
      { shot_id: Number(running.id), run_id: Number(running.run_id) },
      409,
    );
  }
}

function invalidateActiveSnapshots(db, storyboardId, now) {
  const shots = db.prepare(
    `SELECT id, run_id, status, current_snapshot_id, current_plan_revision_id
     FROM paper_studio_shots
     WHERE paper_storyboard_id = ? AND deleted_at IS NULL
       AND status NOT IN ('published','cancelled','stale','pending','analyzed','plan_confirmed','asset_pending','asset_review','asset_failed')`,
  ).all(Number(storyboardId));
  for (const shot of shots) {
    if (shot.current_snapshot_id == null) continue;
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')").run(Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('pending','running','passed','completed')").run(Number(shot.id));
    db.prepare("UPDATE paper_motion_plans SET status = 'confirmed', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ? AND plan_revision_id = ?")
      .run(now, Number(shot.id), Number(shot.current_plan_revision_id));
    db.prepare(
      `UPDATE paper_studio_shots
       SET status = 'asset_ready', current_snapshot_id = NULL, approved_snapshot_id = NULL,
           published_video_generation_id = NULL, last_error_json = '{}',
           version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(now, Number(shot.id));
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'queued', result_json = '{}', error_json = '{}', lease_owner = NULL,
           lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ? AND step_key IN
         ('plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview',
          'wait_preview_approval','render_formal','publish_video')`,
    ).run(now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id));
    runAggregateService.sync(db, shot.run_id);
  }
  return shots.map((shot) => Number(shot.id));
}

function nextVersionNumber(db, storyboardId, kind) {
  return Number(db.prepare(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM paper_storyboard_audio_versions WHERE paper_storyboard_id = ? AND audio_kind = ?',
  ).get(Number(storyboardId), kind).value);
}

function readiness(db, cfg, storyboard, source = storyboard) {
  const mode = storyboard.audio_mode || 'auto';
  const fps = episodeFps(db, storyboard.id);
  const authoredDurationSeconds = Number(source.duration || storyboard.duration || 6);
  if (mode === 'silent') {
    const profile = speechDurationService.durationProfile({ authoredDurationSeconds, fps, versions: [] });
    return { ready: true, mode, explicit_silence: true, required_kinds: [], missing: [], items: [], duration_frames: profile.effective_duration_frames, ...profile };
  }
  const requiredKinds = AUDIO_KINDS.filter((kind) => textForKind(source, kind));
  const missing = [];
  const items = [];
  if (!requiredKinds.length) {
    missing.push({
      kind: 'audio_choice',
      reason: mode === 'required'
        ? '已要求声音，但对白和旁白都为空'
        : '对白和旁白都为空；请明确选择静音，避免无意发布静音视频',
    });
  }
  for (const kind of requiredKinds) {
    const version = currentVersion(db, storyboard, kind);
    const expectedTextHash = textHash(textForKind(source, kind));
    let fileReady = Boolean(version?.local_path && version.status === 'ready' && version.text_hash === expectedTextHash);
    if (fileReady && cfg) {
      try {
        const absolute = safeStorageFile(cfg, version.local_path);
        fileReady = fs.existsSync(absolute) && sha256(fs.readFileSync(absolute)) === version.audio_hash;
      } catch (_) {
        fileReady = false;
      }
    }
    if (!fileReady) missing.push({ kind, reason: version ? '音频与当前文本不一致或文件损坏' : '尚未生成或上传音频' });
    else items.push(version);
  }
  const profile = speechDurationService.durationProfile({ authoredDurationSeconds, fps, versions: items });
  return {
    ready: missing.length === 0,
    mode,
    explicit_silence: false,
    required_kinds: requiredKinds,
    missing,
    items,
    duration_frames: profile.effective_duration_frames,
    ...profile,
  };
}

function workspace(db, cfg, storyboardId, source = null) {
  const storyboard = storyboardService.get(db, storyboardId);
  const result = readiness(db, cfg, storyboard, source || storyboard);
  const history = db.prepare(
    `SELECT * FROM paper_storyboard_audio_versions
     WHERE paper_storyboard_id = ? AND deleted_at IS NULL
     ORDER BY audio_kind, version_number DESC LIMIT 60`,
  ).all(Number(storyboardId)).map(hydrate);
  return {
    paper_storyboard_id: Number(storyboard.id),
    storyboard_version: Number(storyboard.version),
    audio_mode: storyboard.audio_mode || 'auto',
    ready: result.ready,
    explicit_silence: result.explicit_silence,
    required_kinds: result.required_kinds,
    missing: result.missing,
    fps: result.fps,
    authored_duration_frames: result.authored_duration_frames,
    authored_duration_seconds: result.authored_duration_seconds,
    speech_end_frame: result.speech_end_frame,
    speech_end_seconds: result.speech_end_seconds,
    effective_duration_frames: result.effective_duration_frames,
    effective_duration_seconds: result.effective_duration_seconds,
    tail_padding_seconds: result.tail_padding_seconds,
    overflow_frames: result.overflow_frames,
    overflow_seconds: result.overflow_seconds,
    duration_extended: result.duration_extended,
    duration_shortened: result.duration_shortened,
    duration_adjusted: result.duration_adjusted,
    authored_fits_speech: result.authored_fits_speech,
    timing_tracks: result.tracks,
    dialogue: currentVersion(db, storyboard, 'dialogue'),
    narration: currentVersion(db, storyboard, 'narration'),
    history,
  };
}

function applyTimingToContext(db, context, fps = 30) {
  if (!context?.storyboard?.paper_storyboard_id && context?.source_kind !== 'paper') return context;
  const storyboardId = Number(context.storyboard.paper_storyboard_id || context.storyboard.id);
  const liveStoryboard = storyboardService.get(db, storyboardId);
  const result = readiness(db, null, liveStoryboard, context.storyboard);
  const captions = result.items.flatMap((version) => captionsForVersion(version, fps).map((caption) => ({
    ...caption,
    audio_version_id: Number(version.id),
  })));
  return {
    ...context,
    audio_timing: result,
    storyboard: {
      ...context.storyboard,
      authored_duration: Number(context.storyboard.duration || 0),
      duration: Number(result.effective_duration_seconds || context.storyboard.duration || 6),
      audio_captions: captions,
      audio_duration_extended: Boolean(result.duration_extended),
      audio_duration_shortened: Boolean(result.duration_shortened),
      audio_duration_adjusted: Boolean(result.duration_adjusted),
    },
  };
}

function insertAndActivate(db, cfg, storyboard, input) {
  const now = nowIso();
  const captionsHash = sha256(canonicalJson(input.captions));
  const subtitlePath = writeSubtitle(cfg, input.local_path, input.captions, input.fps);
  const versionNumber = nextVersionNumber(db, storyboard.id, input.audio_kind);
  let id;
  db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO paper_storyboard_audio_versions
        (paper_storyboard_id, paper_storyboard_revision_id, parent_version_id, version_number,
         request_id, audio_kind, source_kind, text_content, text_hash, provider, model,
         voice_id, speed, volume, start_frame, end_frame, local_path, audio_hash,
         duration_ms, captions_json, captions_hash, subtitle_local_path, status,
         error_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', '{}', ?, ?, ?)`,
    ).run(
      Number(storyboard.id), storyboard.current_revision_id == null ? null : Number(storyboard.current_revision_id),
      input.parent_version_id || null, versionNumber, input.request_id, input.audio_kind,
      input.source_kind, input.text_content, textHash(input.text_content), input.provider || null,
      input.model || null, input.voice_id || null, Number(input.speed || 1), Number(input.volume == null ? 1 : input.volume),
      Number(input.start_frame || 0), input.end_frame == null ? null : Number(input.end_frame),
      input.local_path, input.audio_hash, input.duration_ms == null ? null : Number(input.duration_ms),
      canonicalJson(input.captions), captionsHash, subtitlePath, now, now, now,
    );
    id = Number(result.lastInsertRowid);
    const pointer = POINTER_COLUMN[input.audio_kind];
    db.prepare(
      `UPDATE paper_storyboard_audio_versions SET status = 'superseded', updated_at = ?
       WHERE paper_storyboard_id = ? AND audio_kind = ? AND id != ? AND status = 'ready'`,
    ).run(now, Number(storyboard.id), input.audio_kind, id);
    db.prepare(
      `UPDATE paper_storyboards
       SET ${pointer} = ?, audio_status = 'ready', published_video_generation_id = NULL,
           status = 'draft', version = version + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(id, now, Number(storyboard.id));
    invalidateActiveSnapshots(db, storyboard.id, now);
    storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now, reason: '纸片分镜声音或字幕已更新，请重新渲染并合并整集' });
  })();
  return { audio_version: getVersion(db, id), storyboard: storyboardService.get(db, storyboard.id), audio: workspace(db, cfg, storyboard.id) };
}

function existingRequest(db, cfg, storyboardId, requestId) {
  if (!requestId) return null;
  const row = db.prepare(
    'SELECT id FROM paper_storyboard_audio_versions WHERE paper_storyboard_id = ? AND request_id = ? AND deleted_at IS NULL',
  ).get(Number(storyboardId), requestId);
  if (!row) return null;
  return { audio_version: getVersion(db, row.id), storyboard: storyboardService.get(db, storyboardId), audio: workspace(db, cfg, storyboardId), deduplicated: true };
}

async function synthesize(db, cfg, log, storyboardId, body = {}) {
  schemaService.assertValid('apiPaperAudioTts', body, '生成纸片分镜配音的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  assertNoRenderInProgress(db, storyboard.id);
  const deduplicated = existingRequest(db, cfg, storyboard.id, body.request_id);
  if (deduplicated) return deduplicated;
  const kind = body.audio_kind;
  const text = textForKind(storyboard, kind);
  if (!text) throw new PaperStudioError('PAPER_AUDIO_TEXT_EMPTY', kind === 'dialogue' ? '请先保存对白文本' : '请先保存旁白文本', { audio_kind: kind }, 409);
  const fps = episodeFps(db, storyboard.id);
  const startFrame = Math.max(0, Math.round(Number(body.start_seconds || 0) * fps));
  const outputSubdir = audioDirectory(db, storyboard);
  const generated = await ttsService.synthesize(db, log, {
    text,
    storyboard_id: null,
    storage_base: path.resolve(cfg?.storage?.local_path || './data/storage'),
    voice_id: body.voice_id,
    speed: body.speed,
    output_subdir: outputSubdir,
    file_prefix: `${kind}-tts`,
  });
  const absolute = safeStorageFile(cfg, generated.local_path);
  const durationSeconds = ffprobeDurationSec(absolute);
  if (!(durationSeconds > 0)) {
    try { fs.unlinkSync(absolute); } catch (_) {}
    throw new PaperStudioError('PAPER_AUDIO_FILE_INVALID', 'TTS 返回的音频无法读取', null, 422);
  }
  const endFrame = Math.max(startFrame + 1, startFrame + Math.ceil(durationSeconds * fps));
  const captionText = body.caption_text == null ? text : String(body.caption_text).trim();
  const captions = body.captions_enabled === false ? [] : buildCaptions(captionText, kind, startFrame, endFrame);
  return insertAndActivate(db, cfg, storyboard, {
    request_id: body.request_id,
    audio_kind: kind,
    source_kind: 'tts',
    text_content: text,
    provider: generated.provider,
    model: generated.model,
    voice_id: generated.voice_id,
    speed: generated.speed,
    volume: body.volume == null ? 1 : body.volume,
    start_frame: startFrame,
    end_frame: endFrame,
    local_path: generated.local_path,
    audio_hash: sha256(fs.readFileSync(absolute)),
    duration_ms: Math.round(durationSeconds * 1000),
    captions,
    fps,
  });
}

function extensionForAudio(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  return '.mp3';
}

async function upload(db, cfg, log, storyboardId, body = {}, file = null) {
  const input = normalizeMultipartBody(body);
  schemaService.assertValid('apiPaperAudioUpload', input, '上传纸片分镜音频的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, input.expected_version, '纸片分镜');
  assertNoRenderInProgress(db, storyboard.id);
  const deduplicated = existingRequest(db, cfg, storyboard.id, input.request_id);
  if (deduplicated) return deduplicated;
  if (!file?.buffer?.length) throw new PaperStudioError('PAPER_AUDIO_FILE_REQUIRED', '请选择要上传的音频文件', null, 400);
  const kind = input.audio_kind;
  const text = textForKind(storyboard, kind);
  if (!text) throw new PaperStudioError('PAPER_AUDIO_TEXT_EMPTY', kind === 'dialogue' ? '请先保存对白文本' : '请先保存旁白文本', { audio_kind: kind }, 409);
  const directory = audioDirectory(db, storyboard);
  const relative = `${directory}/${kind}-upload-${Date.now()}${extensionForAudio(file)}`.replace(/\\/g, '/');
  const absolute = safeStorageFile(cfg, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, file.buffer);
  const durationSeconds = ffprobeDurationSec(absolute);
  if (!(durationSeconds > 0)) {
    try { fs.unlinkSync(absolute); } catch (_) {}
    throw new PaperStudioError('PAPER_AUDIO_FILE_INVALID', '上传文件不是可读取的音频', { mime_type: file.mimetype || null }, 422);
  }
  const fps = episodeFps(db, storyboard.id);
  const startFrame = Math.max(0, Math.round(input.start_seconds * fps));
  const endFrame = Math.max(startFrame + 1, startFrame + Math.ceil(durationSeconds * fps));
  const captionText = input.caption_text == null ? text : String(input.caption_text).trim();
  const captions = input.captions_enabled ? buildCaptions(captionText, kind, startFrame, endFrame) : [];
  const result = insertAndActivate(db, cfg, storyboard, {
    request_id: input.request_id,
    audio_kind: kind,
    source_kind: 'upload',
    text_content: text,
    volume: input.volume,
    start_frame: startFrame,
    end_frame: endFrame,
    local_path: relative,
    audio_hash: sha256(file.buffer),
    duration_ms: Math.round(durationSeconds * 1000),
    captions,
    fps,
  });
  log?.info?.('Paper storyboard audio uploaded', { paper_storyboard_id: storyboard.id, audio_kind: kind, audio_version_id: result.audio_version.id });
  return result;
}

function revise(db, cfg, log, storyboardId, versionId, body = {}) {
  schemaService.assertValid('apiPaperAudioRevise', body, '修订纸片分镜音频的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  assertNoRenderInProgress(db, storyboard.id);
  const deduplicated = existingRequest(db, cfg, storyboard.id, body.request_id);
  if (deduplicated) return deduplicated;
  const source = getVersion(db, versionId);
  if (Number(source.paper_storyboard_id) !== Number(storyboard.id)) throw new PaperStudioError('PAPER_AUDIO_OWNERSHIP_MISMATCH', '音频版本不属于当前纸片分镜', null, 409);
  if (Number(storyboard[POINTER_COLUMN[source.audio_kind]] || 0) !== Number(source.id)) throw new PaperStudioError('PAPER_AUDIO_NOT_CURRENT', '只能修订当前使用中的音频版本', { audio_version_id: source.id }, 409);
  const fps = episodeFps(db, storyboard.id);
  const startFrame = body.start_seconds == null ? source.start_frame : Math.max(0, Math.round(Number(body.start_seconds) * fps));
  const audioFrames = Math.max(1, Math.ceil((Number(source.duration_ms || 0) / 1000) * fps));
  const endFrame = startFrame + audioFrames;
  const captionsEnabled = body.captions_enabled == null ? source.captions_json.length > 0 : body.captions_enabled;
  const captionText = body.caption_text == null ? source.text_content : String(body.caption_text).trim();
  const captions = captionsEnabled ? buildCaptions(captionText, source.audio_kind, startFrame, endFrame) : [];
  const result = insertAndActivate(db, cfg, storyboard, {
    parent_version_id: source.id,
    request_id: body.request_id,
    audio_kind: source.audio_kind,
    source_kind: 'revision',
    text_content: source.text_content,
    provider: source.provider,
    model: source.model,
    voice_id: source.voice_id,
    speed: source.speed,
    volume: body.volume == null ? source.volume : body.volume,
    start_frame: startFrame,
    end_frame: endFrame,
    local_path: source.local_path,
    audio_hash: source.audio_hash,
    duration_ms: source.duration_ms,
    captions,
    fps,
  });
  log?.info?.('Paper storyboard audio revised', { paper_storyboard_id: storyboard.id, parent_version_id: source.id, audio_version_id: result.audio_version.id });
  return result;
}

function setPolicy(db, cfg, log, storyboardId, body = {}) {
  schemaService.assertValid('apiPaperAudioPolicy', body, '更新纸片分镜声音策略的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  assertNoRenderInProgress(db, storyboard.id);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE paper_storyboards
       SET audio_mode = ?, audio_status = ?, published_video_generation_id = NULL,
           status = 'draft', version = version + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(body.audio_mode, body.audio_mode === 'silent' ? 'ready' : 'pending', now, Number(storyboard.id));
    invalidateActiveSnapshots(db, storyboard.id, now);
    storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now, reason: '纸片分镜声音策略已更新，请重新渲染并合并整集' });
  })();
  const audio = workspace(db, cfg, storyboard.id);
  db.prepare('UPDATE paper_storyboards SET audio_status = ? WHERE id = ?').run(audio.ready ? 'ready' : 'pending', Number(storyboard.id));
  log?.info?.('Paper storyboard audio policy updated', { paper_storyboard_id: storyboard.id, audio_mode: body.audio_mode });
  return { storyboard: storyboardService.get(db, storyboard.id), audio };
}

function invalidateChangedText(db, storyboardId, previous, current, now = nowIso()) {
  const changedKinds = AUDIO_KINDS.filter((kind) => textForKind(previous, kind) !== textForKind(current, kind));
  // Duration-only edits change the visual timeline, not the spoken file or its
  // text identity. Keep the approved audio and let the motion/snapshot chain
  // reflow it instead of forcing another TTS call.
  if (!changedKinds.length) return { changed_kinds: [], invalidated_audio_version_ids: [] };
  const kinds = changedKinds;
  const invalidated = [];
  for (const kind of kinds) {
    const pointer = POINTER_COLUMN[kind];
    const id = current?.[pointer] ?? previous?.[pointer];
    if (id != null) {
      invalidated.push(Number(id));
      db.prepare("UPDATE paper_storyboard_audio_versions SET status = 'stale', updated_at = ? WHERE id = ? AND status IN ('ready','superseded')").run(now, Number(id));
    }
    db.prepare(`UPDATE paper_storyboards SET ${pointer} = NULL WHERE id = ?`).run(Number(storyboardId));
  }
  db.prepare("UPDATE paper_storyboards SET audio_status = 'pending' WHERE id = ?").run(Number(storyboardId));
  return { changed_kinds: kinds, invalidated_audio_version_ids: invalidated };
}

function snapshotBundle(db, cfg, detail) {
  if (!detail?.paper_storyboard_id) return { sources: [], captions: [], readiness: { ready: true, mode: 'legacy' } };
  const storyboard = storyboardService.get(db, detail.paper_storyboard_id);
  const result = readiness(db, cfg, storyboard, detail.storyboard || storyboard);
  if (!result.ready) {
    throw new PaperStudioError(
      'PAPER_STUDIO_AUDIO_INCOMPLETE',
      '当前分镜的对白或旁白还没有可用音频；请先生成、上传，或明确设为静音',
      { paper_storyboard_id: storyboard.id, missing: result.missing },
      409,
    );
  }
  const sources = result.items.map((version) => ({
    version_id: Number(version.id),
    kind: version.audio_kind,
    local_path: version.local_path,
    hash: version.audio_hash,
    text_hash: version.text_hash,
    captions_hash: version.captions_hash,
    from_frame: Number(version.start_frame || 0),
    duration_frames: Math.max(1, speechDurationService.audioEndFrame(version, result.fps) - Number(version.start_frame || 0)),
    volume: Number(version.volume == null ? 1 : version.volume),
  }));
  const captions = result.items.flatMap((version) => captionsForVersion(version, result.fps).map((caption) => ({
    ...caption,
    audio_version_id: Number(version.id),
  })));
  return { sources, captions, readiness: result };
}

module.exports = {
  AUDIO_KINDS,
  POINTER_COLUMN,
  buildCaptions,
  captionsForVersion,
  applyTimingToContext,
  getVersion,
  readiness,
  workspace,
  synthesize,
  upload,
  revise,
  setPolicy,
  invalidateChangedText,
  snapshotBundle,
};
