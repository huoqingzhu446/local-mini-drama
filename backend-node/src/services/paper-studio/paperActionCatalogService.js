const { numericRange, orderedKeyframes } = require('../../paper-studio-renderer/motion/trackResolver.cjs');

const ACTION_CATALOG = Object.freeze({
  carry_move_sit: { family: 'compound-staging', revision_axes: ['timing', 'direction', 'relation', 'state', 'staging', 'occlusion'] },
  supported_boundary_transition: { family: 'boundary-transition', revision_axes: ['intensity', 'timing', 'rotation', 'depth', 'occlusion', 'relation'] },
  registered_boundary_crossing: { family: 'boundary-transition', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'depth', 'occlusion'] },
  multi_subject_interaction: { family: 'interaction', revision_axes: ['intensity', 'timing', 'relation', 'state'] },
  dialogue_turn: { family: 'interaction', revision_axes: ['intensity', 'timing', 'relation', 'state'] },
  attached_prop_action: { family: 'attachment', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'relation'] },
  hold_and_lift: { family: 'attachment', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'relation'] },
  foreground_occluded_action: { family: 'occlusion', revision_axes: ['intensity', 'timing', 'occlusion', 'relation', 'state'] },
  directed_move: { family: 'staging', revision_axes: ['timing', 'direction', 'relation', 'state', 'staging'] },
  state_transition: { family: 'staging', revision_axes: ['timing', 'relation', 'state', 'staging'] },
  generic_subject_action: { family: 'free', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation'] },
  subject_settle: { family: 'free', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation'] },
  environmental_depth_motion: { family: 'environment', revision_axes: ['intensity', 'timing', 'direction', 'depth'] },
  map_route_reveal: { family: 'information-reveal', revision_axes: ['intensity', 'timing', 'direction'] },
  object_sequence_transition: { family: 'object-sequence', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation', 'staging'] },
  siege_supply_sequence: { family: 'multi-beat-grounded-sequence', revision_axes: ['timing', 'direction', 'state', 'relation', 'staging', 'grounding'] },
});

const NUMERIC_LIMITS = Object.freeze({
  x: [-2, 2],
  y: [-2, 2],
  rotation: [-360, 360],
  scale: [0.05, 8],
  opacity: [0, 1],
  blur: [0, 50],
  clip_progress: [0, 1],
  procedural_amount: [0, 1],
});

function validateTrack(track, durationFrames) {
  const assertions = [];
  const keyframes = orderedKeyframes(track);
  const frames = keyframes.map((keyframe) => keyframe.frame);
  assertions.push({
    key: `track:${track.target}:${track.property}:frames`,
    pass: frames.length >= 2 && new Set(frames).size === frames.length && frames.every((frame) => frame >= 0 && frame < durationFrames),
    actual: frames,
    expected: `2+ unique frames in 0..${durationFrames - 1}`,
  });
  if (track.property === 'state') {
    assertions.push({
      key: `track:${track.target}:state:values`,
      pass: keyframes.every((keyframe) => typeof keyframe.value === 'string' && keyframe.value.trim().length > 0),
      actual: keyframes.map((keyframe) => keyframe.value),
      expected: 'non-empty categorical states',
    });
  } else {
    const limits = NUMERIC_LIMITS[track.property];
    const values = keyframes.map((keyframe) => keyframe.value);
    assertions.push({
      key: `track:${track.target}:${track.property}:values`,
      pass: Boolean(limits) && values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= limits[0] && value <= limits[1]),
      actual: values,
      expected: limits || null,
    });
  }
  return assertions;
}

function validatePlan(plan = {}) {
  const durationFrames = Math.max(2, Number(plan.duration_frames || 0));
  const catalog = ACTION_CATALOG[plan.primary_action] || null;
  const assertions = [{
    key: 'primary_action_catalogued',
    pass: Boolean(catalog),
    actual: plan.primary_action || null,
    expected: Object.keys(ACTION_CATALOG),
  }];
  for (const track of [
    ...(plan.subject_tracks || []),
    ...(plan.camera_tracks || []),
    ...(plan.scene_tracks || []),
    ...(plan.transition_tracks || []),
  ]) {
    assertions.push(...validateTrack(track, durationFrames));
  }
  assertions.push({
    key: 'cue_frames_in_range',
    pass: (plan.cues || []).every((cue) => Number.isInteger(cue.frame) && cue.frame >= 0 && cue.frame < durationFrames),
    actual: (plan.cues || []).map((cue) => ({ key: cue.key, frame: cue.frame })),
    expected: `0..${durationFrames - 1}`,
  });
  return {
    pass: assertions.every((assertion) => assertion.pass),
    action: catalog ? { key: plan.primary_action, ...catalog } : null,
    assertions,
    subject_motion_ranges: (plan.subject_tracks || []).filter((track) => track.property !== 'state').map((track) => ({ target: track.target, property: track.property, range: numericRange(track) })),
  };
}

function get(action) {
  const item = ACTION_CATALOG[action];
  return item ? { key: action, ...item } : null;
}

function list() {
  return Object.entries(ACTION_CATALOG).map(([key, item]) => ({ key, ...item }));
}

module.exports = { ACTION_CATALOG, NUMERIC_LIMITS, get, list, validatePlan };
