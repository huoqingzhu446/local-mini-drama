import { Easing, interpolate } from 'remotion';

const EASINGS = {
  linear: Easing.linear,
  'power3.out': Easing.bezier(0.16, 1, 0.3, 1),
  'power2.in': Easing.bezier(0.55, 0.06, 0.68, 0.19),
  'power2.inOut': Easing.bezier(0.45, 0, 0.55, 1),
  'sine.inOut': Easing.inOut(Easing.sin),
  'sine.out': Easing.out(Easing.sin),
  'back.out': Easing.bezier(0.34, 1.35, 0.64, 1),
};

export const easingByName = (name) => EASINGS[name] || EASINGS.linear;

export const clampedProgress = (frame, start, end, easing = 'linear') => {
  if (end <= start) return frame >= end ? 1 : 0;
  return interpolate(frame, [start, end], [0, 1], {
    easing: easingByName(easing),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
};

export const interpolateKeyframes = (frame, keyframes, easing = 'linear') => {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return 0;
  const normalized = keyframes
    .map((keyframe) => ({ ...keyframe, frame: Number(keyframe?.frame), value: Number(keyframe?.value) }))
    .filter((keyframe) => Number.isFinite(keyframe.frame) && Number.isFinite(keyframe.value))
    .sort((a, b) => a.frame - b.frame);
  if (!normalized.length) return 0;
  // Duplicate frames can appear after very short phases are clamped. Keep the
  // last authored value and never call interpolate() with a zero-length range.
  const ordered = normalized.filter((keyframe, index) => (
    index === normalized.length - 1 || keyframe.frame !== normalized[index + 1].frame
  ));
  if (ordered.length === 1) return ordered[0].value;
  if (frame <= ordered[0].frame) return ordered[0].value;
  if (frame >= ordered[ordered.length - 1].frame) return ordered[ordered.length - 1].value;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index];
    const right = ordered[index + 1];
    if (frame >= left.frame && frame <= right.frame) {
      return interpolate(frame, [left.frame, right.frame], [left.value, right.value], {
        easing: easingByName(right.ease || left.ease || easing),
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
  }
  return ordered[ordered.length - 1].value;
};
