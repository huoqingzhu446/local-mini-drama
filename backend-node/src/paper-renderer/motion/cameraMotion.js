import { clampedProgress } from './easing';

export const resolveCamera = (snapshot, frame) => {
  const camera = snapshot.camera || {};
  const start = camera.start || { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
  const end = camera.end || start;
  const lastFrame = Math.max(1, snapshot.composition.duration_frames - 1);
  const progress = clampedProgress(frame, 0, lastFrame, camera.ease || 'sine.inOut');
  const mix = (a, b) => a + (b - a) * progress;
  return {
    x: mix(start.x ?? 0.5, end.x ?? start.x ?? 0.5),
    y: mix(start.y ?? 0.5, end.y ?? start.y ?? 0.5),
    scale: mix(start.scale ?? 1, end.scale ?? start.scale ?? 1),
    rotation: mix(start.rotation ?? 0, end.rotation ?? start.rotation ?? 0),
    start,
  };
};
