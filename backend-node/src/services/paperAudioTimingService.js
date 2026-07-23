const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfprobePath } = require('../utils/ffmpegPath');
const {
  PaperError,
  nowIso,
  parseJson,
  canonicalJson,
  sha256,
  clamp,
  resolveStorageFile,
  sha256File,
  assertExpectedVersion,
} = require('./paperUtils');

function runProbe(filePath) {
  const ffprobe = getFfprobePath();
  const env = { ...process.env };
  if (ffprobe && ffprobe !== 'ffprobe' && process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [path.dirname(ffprobe), env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  }
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) return { ok: false, error: (result.stderr || '').trim() || 'ffprobe failed' };
  try { return { ok: true, data: JSON.parse(result.stdout) }; } catch (err) { return { ok: false, error: err.message }; }
}

function storyboardAudioRows(db, storyboardId) {
  const row = db.prepare('SELECT id, audio_local_path, narration_audio_local_path, duration FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(storyboardId));
  if (!row) throw new PaperError('PAPER_NOT_FOUND', '分镜不存在', { storyboard_id: storyboardId }, 404);
  return row;
}

function probeStoryboardAudio(db, cfg, storyboardId) {
  const row = storyboardAudioRows(db, storyboardId);
  const candidates = [
    ['dialogue', row.audio_local_path],
    ['narration', row.narration_audio_local_path],
  ].filter(([, rel]) => rel);
  const sources = [];
  for (const [kind, rel] of candidates) {
    const abs = resolveStorageFile(cfg, rel);
    if (!abs || !fs.existsSync(abs)) {
      throw new PaperError('PAPER_AUDIO_MISSING', `${kind} 音频文件不存在`, { storyboard_id: storyboardId, local_path: rel }, 409);
    }
    const probe = runProbe(abs);
    if (!probe.ok) throw new PaperError('PAPER_AUDIO_PROBE_FAILED', `${kind} 音频无法解析`, { error: probe.error, local_path: rel }, 422);
    const duration = Number(probe.data?.format?.duration || probe.data?.streams?.[0]?.duration || 0);
    sources.push({ kind, src: rel, hash: sha256File(abs), duration_seconds: duration, probe: { codec: probe.data?.streams?.[0]?.codec_name || null, sample_rate: probe.data?.streams?.[0]?.sample_rate || null } });
  }
  return { storyboard: row, sources, total_duration_seconds: sources.reduce((max, item) => Math.max(max, item.duration_seconds || 0), 0) };
}

function normalizeCues(rawCues, fps, durationFrames) {
  if (!Array.isArray(rawCues)) return [];
  return rawCues.map((cue, index) => {
    const milliseconds = cue.milliseconds != null ? Number(cue.milliseconds) : null;
    const sourceFrame = cue.frame != null ? Number(cue.frame) : milliseconds != null ? Math.round(milliseconds / 1000 * fps) : 0;
    return {
      id: String(cue.id || `cue-${index + 1}`),
      kind: String(cue.kind || 'manual_cue'),
      frame: clamp(Math.round(sourceFrame), 0, Math.max(0, durationFrames - 1)),
      source_ms: milliseconds,
      confidence: cue.confidence == null ? null : Number(cue.confidence),
    };
  });
}

function buildTimingHash({ source, cues, sources, durationFrames, fps }) {
  return sha256(canonicalJson({ source, cues, sources, duration_frames: durationFrames, fps }));
}

function lockTiming(db, composition, payload = {}, expectedVersion) {
  assertExpectedVersion(composition.version, expectedVersion, '纸片合成');
  const source = payload.source || 'manual';
  if (!['audio', 'manual'].includes(source)) throw new PaperError('PAPER_INVALID_ARGUMENT', 'timing source 必须为 audio 或 manual');
  let audioInfo = { sources: [], total_duration_seconds: 0 };
  if (source === 'audio') audioInfo = probeStoryboardAudio(db, payload.cfg || {}, composition.storyboard_id);
  if (source === 'manual' && !String(payload.reason || '').trim() && !(Array.isArray(payload.cues) && payload.cues.length)) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', 'manual timing 需要 cues 或 reason');
  }
  const cues = normalizeCues(payload.cues || [], composition.fps, composition.duration_frames);
  const timingHash = buildTimingHash({ source, cues, sources: audioInfo.sources, durationFrames: composition.duration_frames, fps: composition.fps });
  const audioJson = {
    ...(parseJson(composition.audio_json, {})),
    timing_hash: timingHash,
    source,
    sources: audioInfo.sources,
    cues,
    manual_reason: payload.reason || null,
    enforce_audio_track: payload.enforce_audio_track !== false,
    sample_rate: 48000,
  };
  const now = nowIso();
  const result = db.prepare(
    `UPDATE paper_compositions SET audio_json = ?, audio_timing_status = 'locked', audio_timing_hash = ?,
     version = version + 1, status = CASE WHEN status = 'stale' THEN 'draft' ELSE status END, updated_at = ?
     WHERE id = ? AND version = ? AND deleted_at IS NULL`
  ).run(JSON.stringify(audioJson), timingHash, now, composition.id, composition.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', '纸片合成版本已变化', null, 409);
  return { audio_json: audioJson, audio_timing_hash: timingHash, audio_timing_status: 'locked' };
}

function invalidateTiming(db, compositionId, reason) {
  const now = nowIso();
  db.prepare(`UPDATE paper_compositions SET audio_timing_status = 'stale', audio_timing_hash = NULL,
    last_validation_json = ?, status = CASE WHEN status = 'rendered' THEN 'stale' ELSE status END, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(JSON.stringify({ code: 'AUDIO_TIMING_STALE', reason: String(reason || 'audio changed') }), now, Number(compositionId));
  return true;
}

module.exports = { runProbe, probeStoryboardAudio, normalizeCues, buildTimingHash, lockTiming, invalidateTiming };
