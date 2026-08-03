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
  transport_move: { family: 'mobility-ensemble', revision_axes: ['timing', 'direction', 'relation', 'state', 'staging', 'grounding'] },
  state_transition: { family: 'staging', revision_axes: ['timing', 'relation', 'state', 'staging'] },
  generic_subject_action: { family: 'free', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation'] },
  subject_settle: { family: 'free', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation'] },
  environmental_depth_motion: { family: 'environment', revision_axes: ['intensity', 'timing', 'direction', 'depth'] },
  path_reveal: { family: 'information-reveal', revision_axes: ['intensity', 'timing', 'direction'] },
  multi_beat_grounded_sequence: { family: 'multi-beat-grounded-sequence', revision_axes: ['timing', 'direction', 'state', 'relation', 'staging', 'grounding'] },
  object_sequence_transition: { family: 'object-sequence', revision_axes: ['intensity', 'timing', 'direction', 'rotation', 'state', 'relation', 'staging'] },
});

const ACTION_UI = Object.freeze({
  carry_move_sit: { label: '携带移动并坐下', user_selectable: true, blueprint_supported: true, compiler_strategy: 'compound' },
  directed_move: { label: '定向移动', user_selectable: true, blueprint_supported: true, compiler_strategy: 'generic' },
  transport_move: { label: '接地运输移动', user_selectable: true, blueprint_supported: true, compiler_strategy: 'transport' },
  state_transition: { label: '姿态切换', user_selectable: true, blueprint_supported: true, compiler_strategy: 'generic' },
  generic_subject_action: { label: '通用主体动作', user_selectable: true, blueprint_supported: true, compiler_strategy: 'generic' },
  environmental_depth_motion: { label: '环境层次运动', user_selectable: true, blueprint_supported: true, compiler_strategy: 'environment' },
  path_reveal: { label: '路径逐步揭示', user_selectable: true, blueprint_supported: true, compiler_strategy: 'path-reveal' },
  multi_beat_grounded_sequence: { label: '多节拍接地序列', user_selectable: true, blueprint_supported: true, compiler_strategy: 'multi-beat-grounded' },
});

const ACTION_ALIASES = Object.freeze({
  map_route_reveal: 'path_reveal',
  siege_supply_sequence: 'multi_beat_grounded_sequence',
});

const BLUEPRINT_ID_ALIASES = Object.freeze({
  'map-route-reveal-v1': 'path-reveal-v1',
  'blueprint-map-route-reveal-v2': 'blueprint-path-reveal-v1',
  'siege-supply-sequence-v1': 'multi-beat-grounded-sequence-v1',
  'siege-supply-sequence-v2': 'multi-beat-grounded-sequence-v1',
  'siege-supply-sequence-v3': 'multi-beat-grounded-sequence-v1',
});

const PROCEDURAL_KIND_ALIASES = Object.freeze({
  'route-reveal': 'path-reveal',
  'map-title-card': 'label-card',
  'army-formation': 'crowd-formation',
  'ember-field': 'ember-drift',
});

const APPEARANCE_ALIASES = Object.freeze({
  'qin-silhouette': 'neutral-silhouette',
});

function normalizeAction(action) {
  return ACTION_ALIASES[action] || action;
}

function normalizeBlueprintId(catalogKey) {
  return BLUEPRINT_ID_ALIASES[catalogKey] || catalogKey;
}

function normalizeProceduralKind(kind) {
  return PROCEDURAL_KIND_ALIASES[kind] || kind;
}

function normalizeAppearance(appearance) {
  return APPEARANCE_ALIASES[appearance] || appearance;
}

function isPathRevealSummary(summary = {}) {
  const action = normalizeAction(summary.primary_action);
  const catalogKey = normalizeBlueprintId(String(summary.catalog_key || ''));
  return action === 'path_reveal'
    || summary.path_reveal === true
    || summary.map_route === true
    || /(?:path|map)-route-reveal|path-reveal/.test(catalogKey);
}

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
  const normalizedAction = normalizeAction(plan.primary_action);
  const catalog = ACTION_CATALOG[normalizedAction] || null;
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
    action: catalog ? { key: normalizedAction, ...catalog, legacy_key: normalizedAction === plan.primary_action ? null : plan.primary_action } : null,
    assertions,
    subject_motion_ranges: (plan.subject_tracks || []).filter((track) => track.property !== 'state').map((track) => ({ target: track.target, property: track.property, range: numericRange(track) })),
  };
}

function get(action) {
  const normalizedAction = normalizeAction(action);
  const item = ACTION_CATALOG[normalizedAction];
  return item ? {
    key: normalizedAction,
    ...item,
    ...(ACTION_UI[normalizedAction] || { label: normalizedAction, user_selectable: false, blueprint_supported: false, compiler_strategy: null }),
    legacy_key: normalizedAction === action ? null : action,
  } : null;
}

function list() {
  return Object.keys(ACTION_CATALOG).map((key) => get(key));
}

module.exports = {
  ACTION_CATALOG,
  ACTION_UI,
  ACTION_ALIASES,
  BLUEPRINT_ID_ALIASES,
  PROCEDURAL_KIND_ALIASES,
  APPEARANCE_ALIASES,
  NUMERIC_LIMITS,
  normalizeAction,
  normalizeBlueprintId,
  normalizeProceduralKind,
  normalizeAppearance,
  isPathRevealSummary,
  get,
  list,
  validatePlan,
};
