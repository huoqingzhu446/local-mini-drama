import { interpolateKeyframes } from './easing';
import rigTrackModel from './rigTrackModel.cjs';

const { firstTrackForPart } = rigTrackModel;

const numberOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const valueAt = (track, frame, fallback, durationFrames = null) => {
  if (!track) return fallback;
  const keyframes = Array.isArray(track.keyframes) && track.keyframes.length
    ? track.keyframes.map((keyframe) => ({
      ...keyframe,
      value: numberOr(keyframe.value, fallback),
      // Authoring UI keyframes may use normalized offsets. Compiled snapshots
      // use absolute frames; accepting both keeps older compositions renderable.
      frame: keyframe.frame == null
        ? Math.round((Number(keyframe.offset) || 0) * Math.max(0, (Number(durationFrames) || 1) - 1))
        : Number(keyframe.frame),
    }))
    : [
      { frame: Number(track.start_frame ?? 0), value: numberOr(track.from, fallback) },
      { frame: Number(track.end_frame ?? track.start_frame ?? 1), value: numberOr(track.to, fallback) },
    ];
  return numberOr(interpolateKeyframes(frame, keyframes, track.ease || 'power2.inOut'), fallback);
};

/**
 * Resolve all seek-safe local transforms for one rig part. Values for x/y are
 * local offsets in rig-width units; rotation is an additive degree offset;
 * scale and opacity are multiplicative values. The defaults preserve the
 * pre-keyframe renderer behaviour.
 */
export const resolvePartMotion = (rig, part, frame, durationFrames = null) => {
  const xTrack = firstTrackForPart(rig, part.key, 'x');
  const yTrack = firstTrackForPart(rig, part.key, 'y');
  const rotationTrack = firstTrackForPart(rig, part.key, 'rotation');
  const scaleTrack = firstTrackForPart(rig, part.key, 'scale');
  const opacityTrack = firstTrackForPart(rig, part.key, 'opacity');
  return {
    x: valueAt(xTrack, frame, 0, durationFrames),
    y: valueAt(yTrack, frame, 0, durationFrames),
    rotation: valueAt(rotationTrack, frame, 0, durationFrames),
    scale: valueAt(scaleTrack, frame, 1, durationFrames),
    opacity: valueAt(opacityTrack, frame, 1, durationFrames),
  };
};

export const resolvePartRotation = (rig, part, frame) => {
  const motion = resolvePartMotion(rig, part, frame);
  return numberOr(part.initial_rotation, 0) + motion.rotation;
};
