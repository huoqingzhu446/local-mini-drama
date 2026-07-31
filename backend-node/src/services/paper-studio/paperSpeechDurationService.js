const DEFAULT_TAIL_PADDING_SECONDS = 0.5;

function normalizeFps(value) {
  const fps = Number(value || 30);
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function audioEndFrame(version, fpsValue = 30) {
  const fps = normalizeFps(fpsValue);
  const startFrame = Math.max(0, Math.round(Number(version?.start_frame || 0)));
  const measuredFrames = Number(version?.duration_ms || 0) > 0
    ? Math.max(1, Math.ceil((Number(version.duration_ms) / 1000) * fps))
    : Math.max(1, Math.round(Number(version?.end_frame || startFrame + 1)) - startFrame);
  return startFrame + measuredFrames;
}

function durationProfile({
  authoredDurationSeconds,
  fps: fpsValue = 30,
  versions = [],
  tailPaddingSeconds = DEFAULT_TAIL_PADDING_SECONDS,
} = {}) {
  const fps = normalizeFps(fpsValue);
  const authoredSeconds = Math.max(0, Number(authoredDurationSeconds || 0));
  const authoredFrames = Math.max(2, Math.round((authoredSeconds || 6) * fps));
  const tracks = (versions || []).filter(Boolean).map((version) => {
    const startFrame = Math.max(0, Math.round(Number(version.start_frame || 0)));
    const endFrame = audioEndFrame(version, fps);
    return {
      version_id: version.id == null ? null : Number(version.id),
      kind: version.audio_kind || version.kind || null,
      start_frame: startFrame,
      end_frame: endFrame,
      duration_frames: Math.max(1, endFrame - startFrame),
      duration_seconds: Math.max(0, Number(version.duration_ms || 0) / 1000),
    };
  });
  const speechEndFrame = tracks.reduce((max, track) => Math.max(max, track.end_frame), 0);
  const tailPaddingFrames = speechEndFrame > 0
    ? Math.max(1, Math.ceil(Math.max(0, Number(tailPaddingSeconds || 0)) * fps))
    : 0;
  const requiredWithTail = speechEndFrame > 0 ? speechEndFrame + tailPaddingFrames : authoredFrames;
  // Keep the UI and delivery timeline readable while preserving a deterministic
  // frame boundary. Whole-second rounding also leaves room for AAC encoder delay.
  const effectiveFrames = Math.max(authoredFrames, Math.ceil(requiredWithTail / fps) * fps);
  return {
    fps,
    authored_duration_frames: authoredFrames,
    authored_duration_seconds: Number((authoredFrames / fps).toFixed(3)),
    speech_end_frame: speechEndFrame,
    speech_end_seconds: Number((speechEndFrame / fps).toFixed(3)),
    tail_padding_frames: tailPaddingFrames,
    tail_padding_seconds: Number((tailPaddingFrames / fps).toFixed(3)),
    required_duration_frames: effectiveFrames,
    effective_duration_frames: effectiveFrames,
    effective_duration_seconds: Number((effectiveFrames / fps).toFixed(3)),
    overflow_frames: Math.max(0, speechEndFrame - authoredFrames),
    overflow_seconds: Number((Math.max(0, speechEndFrame - authoredFrames) / fps).toFixed(3)),
    duration_extended: effectiveFrames > authoredFrames,
    authored_fits_speech: speechEndFrame <= authoredFrames,
    tracks,
  };
}

module.exports = {
  DEFAULT_TAIL_PADDING_SECONDS,
  normalizeFps,
  audioEndFrame,
  durationProfile,
};
