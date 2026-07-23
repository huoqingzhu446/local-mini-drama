const DEFAULT_PHASES = [
  ['anticipation', 0.08],
  ['entry', 0.14],
  ['action', 0.34],
  ['peak', 0.11],
  ['settle', 0.14],
  ['hold', 0.15],
  ['exit', 0.04],
];

const finiteFrame = (value, fallback) => {
  const frame = Number(value);
  return Number.isFinite(frame) ? Math.round(frame) : fallback;
};

const clampFrame = (value, duration) => Math.max(0, Math.min(Math.max(0, duration - 1), finiteFrame(value, 0)));

/**
 * Normalize a phase list into seek-safe half-open ranges. This is intentionally
 * renderer-local: database/compiler validation remains the source of truth,
 * while hand-authored snapshots still receive deterministic fallbacks.
 */
export const compilePhases = (snapshotOrDuration, configured = null) => {
  const duration = Math.max(1, finiteFrame(
    typeof snapshotOrDuration === 'object' ? snapshotOrDuration?.composition?.duration_frames : snapshotOrDuration,
    1,
  ));
  const source = configured || (typeof snapshotOrDuration === 'object' ? snapshotOrDuration?.timing?.phases : null);
  if (Array.isArray(source) && source.length) {
    const phases = source.map((phase, index) => ({
      name: String(phase?.name || `phase_${index}`),
      start_frame: Math.max(0, Math.min(duration, finiteFrame(phase?.start_frame, 0))),
      end_frame: Math.max(0, Math.min(duration, finiteFrame(phase?.end_frame, 0))),
    }));
    let cursor = 0;
    return phases.map((phase, index) => {
      const start = Math.max(cursor, Math.min(duration, phase.start_frame));
      const remaining = phases.length - index - 1;
      const minimumEnd = remaining > 0 ? Math.min(duration, start + 1) : duration;
      const end = Math.max(minimumEnd, Math.min(duration, phase.end_frame));
      cursor = Math.min(duration, end);
      return { ...phase, start_frame: start, end_frame: end };
    });
  }
  let cursor = 0;
  let ratioCursor = 0;
  const ratioTotal = DEFAULT_PHASES.reduce((sum, [, ratio]) => sum + ratio, 0);
  return DEFAULT_PHASES.map(([name, ratio], index) => {
    ratioCursor += ratio;
    const end = index === DEFAULT_PHASES.length - 1
      ? duration
      : Math.max(cursor, Math.min(duration, Math.round(duration * ratioCursor / ratioTotal)));
    const phase = { name, start_frame: cursor, end_frame: Math.max(cursor, end) };
    cursor = Math.min(duration, phase.end_frame);
    return phase;
  });
};

export const phaseRange = (snapshot, name) => {
  const phases = compilePhases(snapshot);
  const phase = phases.find((item) => item.name === name);
  if (!phase) return null;
  return { start: phase.start_frame, end: phase.end_frame };
};

export const phaseFrame = (snapshot, name, position = 'start') => {
  const range = phaseRange(snapshot, name);
  if (!range) return null;
  return position === 'end' ? Math.max(range.start, range.end - 1) : range.start;
};

export const proofFrameMap = (snapshot) => {
  const configured = snapshot?.proof_frames || {};
  const duration = Math.max(1, finiteFrame(snapshot?.composition?.duration_frames, 1));
  const finalFrame = duration - 1;
  const hold = phaseRange(snapshot, 'hold');
  const peak = phaseRange(snapshot, 'peak');
  const cues = Array.isArray(snapshot?.timing?.cues) ? snapshot.timing.cues : [];
  const speechPeak = cues.find((cue) => String(cue?.kind || '').toLowerCase() === 'speech_peak');
  const peakMidpoint = peak ? Math.floor((peak.start + peak.end) / 2) : Math.floor(finalFrame * 0.6);
  const fallback = {
    first: 0,
    anticipation: phaseFrame(snapshot, 'anticipation', 'end') ?? Math.min(finalFrame, 0),
    peak: speechPeak?.frame ?? peakMidpoint,
    settle: phaseFrame(snapshot, 'settle', 'end') ?? finalFrame,
    final_minus_hold: hold ? Math.max(0, hold.start - 1) : Math.max(0, finalFrame - 1),
    exact_final: finalFrame,
  };
  const result = {};
  for (const key of Object.keys(fallback)) result[key] = clampFrame(configured[key] ?? fallback[key], duration);
  return result;
};
