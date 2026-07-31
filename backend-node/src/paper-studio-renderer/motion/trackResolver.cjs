const DEFAULT_MOTION = Object.freeze({
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  opacity: 1,
  blur: 0,
  state: null,
  clip_progress: 0,
  procedural_amount: 0,
});

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

// M1 缓动库（纸片动画优化方案 §3.1）：全部为纯函数，帧号→值确定可复现。
function ease(name, value, params = {}) {
  const t = clamp(value);
  switch (name) {
    case 'ease-in': return t * t * t;
    case 'ease-out': return 1 - ((1 - t) ** 3);
    case 'ease-in-out': return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
    case 'ease-in-quint': return t ** 5;
    case 'ease-out-quint': return 1 - ((1 - t) ** 5);
    case 'ease-out-back': {
      // 过冲回稳：s 控制过冲量，默认约 4%
      const s = Number(params.s || 1.30);
      return 1 + (s + 1) * ((t - 1) ** 3) + s * ((t - 1) ** 2);
    }
    case 'spring': {
      // 衰减弹簧解析解：到达后回摆收敛
      const omega = Number(params.omega || 14);
      const zeta = clamp(Number(params.zeta || 0.55), 0.05, 0.99);
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * omega * t) * Math.cos(wd * t);
    }
    case 'stepped-ease': {
      // 剪纸顿挫：位移量化成 n 个台阶，台阶内 ease-out
      const n = Math.max(1, Math.round(Number(params.n || 6)));
      const scaled = t * n;
      const step = Math.floor(scaled);
      const frac = scaled - step;
      return clamp((step + (1 - ((1 - frac) ** 3))) / n);
    }
    case 'linear':
    default: return t;
  }
}

function orderedKeyframes(track) {
  return [...(track?.keyframes || [])]
    .filter((keyframe) => Number.isInteger(Number(keyframe.frame)))
    .map((keyframe) => ({ ...keyframe, frame: Number(keyframe.frame) }))
    .sort((a, b) => a.frame - b.frame);
}

function resolveTrackValue(track, frame) {
  const keyframes = orderedKeyframes(track);
  if (!keyframes.length) return undefined;
  const current = Math.max(0, Number(frame) || 0);
  if (current <= keyframes[0].frame) return keyframes[0].value;
  if (current >= keyframes[keyframes.length - 1].frame) return keyframes[keyframes.length - 1].value;
  let rightIndex = keyframes.findIndex((keyframe) => keyframe.frame >= current);
  if (rightIndex <= 0) rightIndex = 1;
  const left = keyframes[rightIndex - 1];
  const right = keyframes[rightIndex];
  if (typeof left.value !== 'number' || typeof right.value !== 'number') {
    return current >= right.frame ? right.value : left.value;
  }
  const span = Math.max(1, right.frame - left.frame);
  const easingName = right.easing || left.easing || 'linear';
  const easingParams = right.easing_params || left.easing_params || {};
  const progress = ease(easingName, (current - left.frame) / span, easingParams);
  return left.value + ((right.value - left.value) * progress);
}

function allTracks(motionPlan) {
  return [
    ...(motionPlan?.subject_tracks || []),
    ...(motionPlan?.camera_tracks || []),
    ...(motionPlan?.scene_tracks || []),
    ...(motionPlan?.transition_tracks || []),
  ];
}

function resolveTargetMotion(motionPlan, target, frame) {
  const resolved = { ...DEFAULT_MOTION };
  for (const track of allTracks(motionPlan)) {
    if (track.target !== target || !(track.property in resolved)) continue;
    const value = resolveTrackValue(track, frame);
    if (value !== undefined) resolved[track.property] = value;
  }
  return resolved;
}

// M2 辅助：主体在当前帧的位移速度（屏幅/帧），中心差分，纯函数。
function velocityFor(motionPlan, target, frame) {
  const before = resolveTargetMotion(motionPlan, target, Math.max(0, frame - 1));
  const after = resolveTargetMotion(motionPlan, target, frame + 1);
  const vx = (Number(after.x) - Number(before.x)) / 2;
  const vy = (Number(after.y) - Number(before.y)) / 2;
  return { vx, vy, speed: Math.sqrt(vx * vx + vy * vy) };
}

// M6 辅助：状态交叉过渡——返回当前状态、上一状态与过渡进度（0..1，1=过渡完成）。
function stateTransition(motionPlan, target, frame, fadeFrames = 3) {
  const track = allTracks(motionPlan).find((item) => item.target === target && item.property === 'state');
  if (!track) return { current: null, previous: null, progress: 1 };
  const keyframes = orderedKeyframes(track);
  if (!keyframes.length) return { current: null, previous: null, progress: 1 };
  let current = keyframes[0].value;
  let previous = null;
  let switchFrame = keyframes[0].frame;
  for (const keyframe of keyframes) {
    if (keyframe.frame > frame) break;
    if (keyframe.value !== current) {
      previous = current;
      current = keyframe.value;
      switchFrame = keyframe.frame;
    }
  }
  const sinceSwitch = frame - switchFrame;
  const progress = previous == null ? 1 : clamp(fadeFrames <= 0 ? 1 : sinceSwitch / fadeFrames);
  return { current, previous: progress >= 1 ? null : previous, progress };
}

function numericRange(track) {
  const values = orderedKeyframes(track).map((keyframe) => keyframe.value).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return 0;
  return Math.max(...values) - Math.min(...values);
}

function distinctStates(track) {
  return new Set(orderedKeyframes(track).map((keyframe) => keyframe.value).filter((value) => typeof value === 'string')).size;
}

function motionSemantics(motionPlan) {
  const subjectTracks = motionPlan?.subject_tracks || [];
  const cameraTracks = motionPlan?.camera_tracks || [];
  const visibleSubjectTracks = subjectTracks.filter((track) => (
    (['x', 'y'].includes(track.property) && numericRange(track) >= 0.015)
    || (track.property === 'rotation' && numericRange(track) >= 4)
    || (track.property === 'scale' && numericRange(track) >= 0.04)
    || (track.property === 'state' && distinctStates(track) >= 2)
    || (['clip_progress', 'procedural_amount'].includes(track.property) && numericRange(track) >= 0.1)
  ));
  return {
    camera_only: visibleSubjectTracks.length === 0 && cameraTracks.length > 0,
    subject_track_count: subjectTracks.length,
    visible_subject_track_count: visibleSubjectTracks.length,
    state_track_count: subjectTracks.filter((track) => track.property === 'state').length,
  };
}

module.exports = {
  DEFAULT_MOTION,
  clamp,
  ease,
  orderedKeyframes,
  resolveTrackValue,
  resolveTargetMotion,
  velocityFor,
  stateTransition,
  numericRange,
  distinctStates,
  motionSemantics,
};
