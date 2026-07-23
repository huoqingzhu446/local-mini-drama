import { clampedProgress, interpolateKeyframes } from './easing';

export const resolveLayerMotion = (layer, frame) => {
  const entry = layer.motion?.entry;
  const rest = (to, fallback) => (to == null ? fallback : to);
  const result = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  if (entry) {
    const progress = clampedProgress(frame, entry.start_frame, entry.end_frame, entry.ease || 'power3.out');
    result.x = (entry.from_x || 0) * (1 - progress) + rest(entry.to_x, 0) * progress;
    result.y = (entry.from_y || 0) * (1 - progress) + rest(entry.to_y, 0) * progress;
    result.scale = (entry.from_scale ?? 1) * (1 - progress) + rest(entry.to_scale, 1) * progress;
    result.rotation = (entry.from_rotation || 0) * (1 - progress) + rest(entry.to_rotation, 0) * progress;
    result.opacity = (entry.from_opacity ?? 1) * (1 - progress) + rest(entry.to_opacity, 1) * progress;
  }
  for (const track of layer.motion?.tracks || []) {
    if (!Array.isArray(track.keyframes) || !track.keyframes.length) continue;
    const value = interpolateKeyframes(frame, track.keyframes, track.ease || 'linear');
    if (track.property === 'x' || track.property === 'y' || track.property === 'rotation') result[track.property] += value;
    else if (track.property === 'scale' || track.property === 'opacity') result[track.property] *= value;
  }
  return result;
};

export const resolveAmbientMotion = (layer, frame) => {
  const ambient = layer.motion?.ambient;
  if (!ambient || frame < ambient.start_frame || frame > ambient.end_frame) {
    return { x: 0, y: 0, rotation: 0, scale: 1 };
  }
  const period = Math.max(1, ambient.period_frames || 120);
  const wave = Math.sin(((frame - ambient.start_frame) / period) * Math.PI * 2 + (ambient.phase || 0));
  return {
    x: wave * (ambient.x || 0),
    y: wave * (ambient.y || 0),
    rotation: wave * (ambient.rotation || 0),
    scale: 1 + wave * (ambient.scale || 0),
  };
};
