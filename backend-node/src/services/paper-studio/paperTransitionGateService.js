const { PaperStudioError } = require('./paperStudioUtils');
const transitionService = require('./paperSceneTransitionService');
const {
  orderedKeyframes,
  resolveTrackValue,
} = require('../../paper-studio-renderer/motion/trackResolver.cjs');

const NORMAL_MAX_VEHICLE_SPEED_PER_SECOND = 0.6;
const NORMAL_MAX_OPACITY_SLOPE_AT_30FPS = 0.12;
const NORMAL_MAX_ACCELERATION_PER_SECOND_SQUARED = 15;
const NORMAL_MAX_ROTATION_SPEED_PER_SECOND = 240;
const NORMAL_MAX_SCALE_SPEED_PER_SECOND = 0.8;

function assertion(key, pass, message, details = {}) {
  return { key, pass: Boolean(pass), message, ...details };
}

function allTracks(plan = {}) {
  return [
    ...(plan.subject_tracks || []),
    ...(plan.camera_tracks || []),
    ...(plan.scene_tracks || []),
    ...(plan.transition_tracks || []),
  ];
}

function trackFor(plan, target, property) {
  return allTracks(plan).find((track) => track.target === target && track.property === property) || null;
}

function nodeList(root, output = []) {
  if (!root) return output;
  output.push(root);
  (root.children || []).forEach((child) => nodeList(child, output));
  return output;
}

function numericMetrics(track, fps, durationFrames) {
  if (!track) return { max_velocity_per_second: 0, max_acceleration_per_second_squared: 0, max_frame_delta: 0 };
  let previous = Number(resolveTrackValue(track, 0) || 0);
  let previousVelocity = 0;
  let maxVelocity = 0;
  let maxAcceleration = 0;
  let maxFrameDelta = 0;
  for (let frame = 1; frame < durationFrames; frame += 1) {
    const value = Number(resolveTrackValue(track, frame) || 0);
    const delta = value - previous;
    const velocity = delta * fps;
    maxFrameDelta = Math.max(maxFrameDelta, Math.abs(delta));
    maxVelocity = Math.max(maxVelocity, Math.abs(velocity));
    if (frame > 1) maxAcceleration = Math.max(maxAcceleration, Math.abs(velocity - previousVelocity) * fps);
    previous = value;
    previousVelocity = velocity;
  }
  return {
    max_velocity_per_second: Number(maxVelocity.toFixed(5)),
    max_acceleration_per_second_squared: Number(maxAcceleration.toFixed(5)),
    max_frame_delta: Number(maxFrameDelta.toFixed(5)),
  };
}

function changingSegments(track, threshold = 0.001) {
  const frames = orderedKeyframes(track);
  const segments = [];
  for (let index = 1; index < frames.length; index += 1) {
    const left = frames[index - 1];
    const right = frames[index];
    if (typeof left.value !== 'number' || typeof right.value !== 'number') continue;
    if (Math.abs(right.value - left.value) < threshold) continue;
    segments.push({ start_frame: left.frame, end_frame: right.frame, frames: right.frame - left.frame, from: left.value, to: right.value });
  }
  return segments;
}

function transitionEvents(plan) {
  return (plan.transition_contracts || []).flatMap((item) => {
    const start = Number(item.start_frame);
    const end = Number(item.end_frame);
    if (start === end) return [{ frame: start, key: `${item.key}:hard_cut`, kind: 'scene_transition' }];
    return [
      { frame: start, key: `${item.key}:start`, kind: 'scene_transition' },
      { frame: end, key: `${item.key}:end`, kind: 'scene_transition' },
    ];
  });
}

function eventDensity(plan, fps, captions = []) {
  const events = [
    ...(plan.cues || []).map((cue) => ({ frame: Number(cue.frame), key: cue.key, kind: cue.kind || 'cue', matched_transition: cue.matched_transition || null })),
    ...transitionEvents(plan),
    ...captions.slice(1).map((caption) => ({ frame: Number(caption.start_frame), key: caption.key || `caption:${caption.start_frame}`, kind: 'caption_change' })),
  ].sort((left, right) => left.frame - right.frame);
  const windowFrames = Math.max(2, Math.round(fps * 0.08));
  let max = 0;
  let cluster = [];
  const sameFrame = new Map();
  for (const event of events.filter((item) => !item.matched_transition)) {
    const frameEvents = sameFrame.get(event.frame) || [];
    frameEvents.push(event);
    sameFrame.set(event.frame, frameEvents);
  }
  const sameFrameCluster = [...sameFrame.values()].sort((left, right) => right.length - left.length)[0] || [];
  for (let index = 0; index < events.length; index += 1) {
    const current = events.filter((event) => Math.abs(event.frame - events[index].frame) <= windowFrames);
    const unmatched = current.filter((event) => !event.matched_transition);
    if (unmatched.length > max) {
      max = unmatched.length;
      cluster = unmatched;
    }
  }
  return {
    max_unmatched_events: max,
    max_same_frame_unmatched_events: sameFrameCluster.length,
    window_frames: windowFrames,
    cluster,
    same_frame_cluster: sameFrameCluster,
  };
}

function evaluate(plan = {}, context = {}) {
  const plannerVersion = Number(context.planner_version || context.summary?.planner_version || 0);
  if (Number(plan.schema_version || 1) < 2 || (plannerVersion > 0 && plannerVersion < 9)) {
    return { pass: true, skipped: true, reason: 'legacy_motion_plan', assertions: [], metrics: {} };
  }
  const fps = Math.max(1, Number(plan.fps || 30));
  const durationFrames = Math.max(2, Number(plan.duration_frames || 2));
  const scenes = context.visual_scenes || context.semantic_contract?.visual_scenes || context.summary?.visual_scenes || [];
  const transitions = plan.transition_contracts || context.transition_contracts || [];
  const captions = context.captions || [];
  const captionKeys = new Set(captions.map((caption) => String(caption.key || '')));
  const beats = plan.visual_beats || context.visual_beats || [];
  const root = context.root || null;
  const nodes = nodeList(root);
  const sceneGroups = nodes.filter((node) => node.relation?.scene_role === 'visual_scene');
  const families = context.source_families || context.families || [];
  const familyKeys = new Set(families.map((family) => family.family_key));
  const spatialScenes = new Map((context.spatial_contract?.scenes || []).map((scene) => [scene.scene_key, scene]));
  const sceneKeys = new Set(scenes.map((scene) => scene.key));
  const assertions = [];

  assertions.push(assertion(
    'transition_structure_scene_groups',
    scenes.length <= 1 || !root || sceneGroups.length === scenes.length,
    `视觉场景 ${scenes.length} 个，跨场景组合需要 ${scenes.length > 1 ? scenes.length : 0} 个完整场景组，当前 ${sceneGroups.length} 个`,
    { actual: sceneGroups.length, expected: scenes.length > 1 ? scenes.length : 0 },
  ));
  assertions.push(assertion(
    'transition_structure_boundaries',
    transitions.length === Math.max(0, scenes.length - 1),
    `相邻场景边界需要 ${Math.max(0, scenes.length - 1)} 个转场合同，当前 ${transitions.length} 个`,
    { actual: transitions.length, expected: Math.max(0, scenes.length - 1) },
  ));
  for (const scene of scenes) {
    const group = sceneGroups.find((item) => item.key === scene.key);
    assertions.push(assertion(
      `scene:${scene.key}:environment`,
      (scenes.length <= 1 || !root || Boolean(group)) && (!families.length || familyKeys.has(scene.environment_family_key)),
      `${scene.label || scene.key} 必须绑定自己的完整场景组和环境素材`,
      { scene_key: scene.key, environment_family_key: scene.environment_family_key },
    ));
    if (scenes.length > 1 && context.spatial_contract) {
      const spatial = spatialScenes.get(scene.key);
      assertions.push(assertion(
        `scene:${scene.key}:spatial_contract`,
        Boolean(spatial && Array.isArray(spatial.placement_regions)),
        `${scene.label || scene.key} 必须冻结与自身背景对应的地面和禁区合同`,
      ));
    }
  }

  for (let transitionIndex = 0; transitionIndex < transitions.length; transitionIndex += 1) {
    const transition = transitions[transitionIndex];
    const label = transitionService.transitionLabel(transition);
    const hardCut = transitionService.hardCutAuthorized(transition, plan);
    const policy = transitionService.policyFor(transition.kind, transition.relation);
    const duration = Number(transition.end_frame) - Number(transition.start_frame);
    const minimum = transitionService.secondsToFrames(policy.min_seconds, fps, hardCut ? 0 : 1);
    const referenced = sceneKeys.has(transition.from_scene_key) && sceneKeys.has(transition.to_scene_key);
    assertions.push(assertion(`transition:${transition.key}:references`, referenced, `${label} 引用的前后场景必须存在`));
    assertions.push(assertion(
      `transition:${transition.key}:adjacent_scenes`,
      transition.from_scene_key === scenes[transitionIndex]?.key && transition.to_scene_key === scenes[transitionIndex + 1]?.key,
      `${label} 必须连接时间轴上相邻的两个场景，不能跳过或倒序引用`,
    ));
    assertions.push(assertion(
      `transition:${transition.key}:frame_order`,
      Number(transition.start_frame) >= 0
        && Number(transition.end_frame) < durationFrames
        && (hardCut ? Number(transition.start_frame) === Number(transition.end_frame) : Number(transition.start_frame) < Number(transition.end_frame)),
      `${label} 的开始与结束帧必须按顺序落在完整画面时间轴内`,
    ));
    if (transition.source_caption_key && captions.length) {
      assertions.push(assertion(
        `transition:${transition.key}:caption_reference`,
        captionKeys.has(String(transition.source_caption_key)),
        `${label} 引用的字幕 ${transition.source_caption_key} 必须存在`,
      ));
    }
    if (transitionIndex > 0) {
      const previousTransition = transitions[transitionIndex - 1];
      assertions.push(assertion(
        `transition:${transition.key}:non_overlapping`,
        Number(transition.start_frame) >= Number(previousTransition.end_frame),
        `${label} 不能与前一个场景转场重叠，否则中间场景没有可识别停留`,
      ));
    }
    assertions.push(assertion(
      `transition:${transition.key}:duration`,
      hardCut || duration >= minimum,
      hardCut
        ? `${label} 已记录显式硬切原因`
        : `${label} 持续 ${(duration / fps).toFixed(2)} 秒，最低 ${policy.min_seconds.toFixed(2)} 秒`,
      { actual_frames: duration, min_frames: minimum, actual_seconds: Number((duration / fps).toFixed(3)) },
    ));
    assertions.push(assertion(
      `transition:${transition.key}:audio_continuity`,
      transition.audio_policy === 'continuous',
      `${label} 必须保持声音连续，不能随场景组一起切断`,
      { actual: transition.audio_policy || null, expected: 'continuous' },
    ));
    assertions.push(assertion(
      `transition:${transition.key}:caption_continuity`,
      transition.caption_policy === 'global_overlay',
      `${label} 的字幕必须保留在全局叠加层，不能跟随背景移出画面`,
      { actual: transition.caption_policy || null, expected: 'global_overlay' },
    ));
    if ((transition.kind === 'hard_cut' || transition.relation === 'explicit_hard_cut') && !hardCut) {
      assertions.push(assertion(`transition:${transition.key}:hard_cut_authorized`, false, `${label} 是硬切，但缺少明确原因或 hard_cut 动作配置`));
    }
    if (transition.relation === 'location_change') {
      const from = scenes.find((scene) => scene.key === transition.from_scene_key);
      const to = scenes.find((scene) => scene.key === transition.to_scene_key);
      const distinct = from?.environment_family_key && to?.environment_family_key && from.environment_family_key !== to.environment_family_key;
      assertions.push(assertion(
        `transition:${transition.key}:new_plate`,
        transition.requires_new_plate === true && distinct,
        `${label} 是地点变化，必须使用两个不同的环境底图槽位`,
        { from_environment: from?.environment_family_key || null, to_environment: to?.environment_family_key || null },
      ));
    }
    const fromOpacity = trackFor(plan, transition.from_scene_key, 'opacity');
    const toOpacity = trackFor(plan, transition.to_scene_key, 'opacity');
    if (!hardCut) {
      const incomingPreFrame = Math.max(0, Number(transition.start_frame) - 1);
      const incomingInitialOpacity = Number(resolveTrackValue(toOpacity, incomingPreFrame) || 0);
      assertions.push(assertion(
        `transition:${transition.key}:incoming_initially_hidden`,
        Boolean(toOpacity) && incomingInitialOpacity <= 0.05,
        `${label} 的新场景不能在入场前一帧已经完整可见`,
        { frame: incomingPreFrame, actual: incomingInitialOpacity, max: 0.05 },
      ));
      const crossfadeCovered = fromOpacity && toOpacity && Array.from({ length: duration + 1 }, (_, offset) => {
        const frame = Number(transition.start_frame) + offset;
        return Number(resolveTrackValue(fromOpacity, frame) || 0) + Number(resolveTrackValue(toOpacity, frame) || 0) >= 0.72;
      }).every(Boolean);
      assertions.push(assertion(
        `transition:${transition.key}:crossfade_coverage`,
        crossfadeCovered,
        `${label} 的前后场景必须在整个转场期间连续覆盖画面，不能出现黑场`,
      ));
      const midpoint = Math.round((Number(transition.start_frame) + Number(transition.end_frame)) / 2);
      const fromX = trackFor(plan, transition.from_scene_key, 'x');
      const toX = trackFor(plan, transition.to_scene_key, 'x');
      const fromBefore = Number(resolveTrackValue(fromX, Math.max(0, midpoint - 1)) || 0);
      const fromAfter = Number(resolveTrackValue(fromX, midpoint + 1) || 0);
      const toBefore = Number(resolveTrackValue(toX, Math.max(0, midpoint - 1)) || 0);
      const toAfter = Number(resolveTrackValue(toX, midpoint + 1) || 0);
      const fromVelocity = ((fromAfter - fromBefore) / 2) * fps;
      const toVelocity = ((toAfter - toBefore) / 2) * fps;
      const velocityError = Math.abs(fromVelocity - toVelocity);
      assertions.push(assertion(
        `transition:${transition.key}:matched_velocity`,
        Boolean(fromX && toX) && velocityError <= 0.12,
        `${label} 的出入场方向和中点速度必须衔接`,
        { from_velocity: Number(fromVelocity.toFixed(4)), to_velocity: Number(toVelocity.toFixed(4)), error: Number(velocityError.toFixed(4)), max_error: 0.12 },
      ));
    }
  }

  for (const beat of beats) {
    const ordered = Number(beat.start_frame) >= 0
      && Number(beat.start_frame) <= Number(beat.peak_frame)
      && Number(beat.peak_frame) <= Number(beat.end_frame)
      && Number(beat.end_frame) < durationFrames;
    assertions.push(assertion(
      `beat:${beat.key}:frame_order`,
      ordered,
      `视觉节拍 ${beat.key} 的开始、峰值和结束帧必须按顺序排列`,
    ));
    assertions.push(assertion(
      `beat:${beat.key}:scene_reference`,
      scenes.length === 0 || sceneKeys.has(beat.scene_key),
      `视觉节拍 ${beat.key} 必须归属于有效场景`,
    ));
    const duration = Number(beat.end_frame) - Number(beat.start_frame);
    const recognitionHold = Number(beat.end_frame) - Number(beat.peak_frame);
    assertions.push(assertion(
      `beat:${beat.key}:minimum_hold`,
      recognitionHold >= Number(beat.minimum_hold_frames || 1),
      `视觉节拍 ${beat.key} 在动作峰值后停留 ${(recognitionHold / fps).toFixed(2)} 秒，必须保留最低识别时间`,
      { actual_frames: recognitionHold, min_frames: Number(beat.minimum_hold_frames || 1), beat_duration_frames: duration },
    ));
    if (captions.length) {
      for (const captionKey of beat.source_caption_keys || []) {
        assertions.push(assertion(
          `beat:${beat.key}:caption:${captionKey}`,
          captionKeys.has(String(captionKey)),
          `视觉节拍 ${beat.key} 引用的字幕 ${captionKey} 必须存在`,
        ));
      }
    }
  }

  const roleByTarget = new Map(nodes.map((node) => [node.key, node.relation?.role || null]));
  const motionMetrics = [];
  for (const track of allTracks(plan)) {
    if (!['x', 'y', 'rotation', 'scale', 'opacity'].includes(track.property)) continue;
    const metrics = numericMetrics(track, fps, durationFrames);
    motionMetrics.push({ target: track.target, property: track.property, ...metrics });
    if (track.property === 'opacity') {
      const maxDelta = NORMAL_MAX_OPACITY_SLOPE_AT_30FPS * (30 / fps);
      assertions.push(assertion(
        `track:${track.target}:opacity_slope`,
        metrics.max_frame_delta <= maxDelta + 0.0001 || plan.motion_profile === 'hard_cut',
        `${track.target} 的透明度变化不能在相邻帧突然跳变`,
        { actual: metrics.max_frame_delta, max: Number(maxDelta.toFixed(5)) },
      ));
      for (const segment of changingSegments(track, 0.5)) {
        const minFrames = transitionService.secondsToFrames(0.3, fps);
        assertions.push(assertion(
          `track:${track.target}:opacity_duration:${segment.start_frame}`,
          segment.frames >= minFrames || plan.motion_profile === 'hard_cut',
          `${track.target} 在 ${(segment.frames / fps).toFixed(2)} 秒内完成主要显隐，最低需要 0.30 秒`,
          { actual_frames: segment.frames, min_frames: minFrames },
        ));
      }
    }
    if (track.property === 'x' && roleByTarget.get(track.target) === 'ground_vehicle') {
      const segments = changingSegments(track, 0.08);
      const minFrames = transitionService.secondsToFrames(1, fps);
      for (const segment of segments) {
        assertions.push(assertion(
          `track:${track.target}:vehicle_entry_duration:${segment.start_frame}`,
          segment.frames >= minFrames,
          `${track.target} 的完整驶入只有 ${(segment.frames / fps).toFixed(2)} 秒，最低需要 1.00 秒`,
          { actual_frames: segment.frames, min_frames: minFrames },
        ));
      }
      assertions.push(assertion(
        `track:${track.target}:vehicle_speed`,
        metrics.max_velocity_per_second <= NORMAL_MAX_VEHICLE_SPEED_PER_SECOND + 0.0001,
        `${track.target} 的最高速度为 ${metrics.max_velocity_per_second.toFixed(2)} 屏宽/秒，不能超过 ${NORMAL_MAX_VEHICLE_SPEED_PER_SECOND.toFixed(2)}`,
        { actual: metrics.max_velocity_per_second, max: NORMAL_MAX_VEHICLE_SPEED_PER_SECOND },
      ));
    }
    if (['x', 'y'].includes(track.property) && roleByTarget.get(track.target) !== 'ground_vehicle') {
      const minFrames = transitionService.secondsToFrames(0.3, fps);
      for (const segment of changingSegments(track, 0.08)) {
        assertions.push(assertion(
          `track:${track.target}:${track.property}:movement_duration:${segment.start_frame}`,
          segment.frames >= minFrames || plan.motion_profile === 'impact' || plan.motion_profile === 'hard_cut',
          `${track.target} 的主要${track.property === 'x' ? '位移' : '纵向运动'}只有 ${(segment.frames / fps).toFixed(2)} 秒，最低需要 0.30 秒`,
          { actual_frames: segment.frames, min_frames: minFrames },
        ));
      }
    }
    if (['x', 'y'].includes(track.property) && plan.motion_profile === 'normal') {
      assertions.push(assertion(
        `track:${track.target}:${track.property}:acceleration`,
        metrics.max_acceleration_per_second_squared <= NORMAL_MAX_ACCELERATION_PER_SECOND_SQUARED + 0.0001,
        `${track.target} 的${track.property === 'x' ? '横向' : '纵向'}运动加速度需要保持连续`,
        { actual: metrics.max_acceleration_per_second_squared, max: NORMAL_MAX_ACCELERATION_PER_SECOND_SQUARED },
      ));
    }
    if (track.property === 'rotation' && plan.motion_profile === 'normal') {
      assertions.push(assertion(
        `track:${track.target}:rotation_slope`,
        metrics.max_velocity_per_second <= NORMAL_MAX_ROTATION_SPEED_PER_SECOND + 0.0001,
        `${track.target} 的旋转速度过快，会产生突然翻转`,
        { actual: metrics.max_velocity_per_second, max: NORMAL_MAX_ROTATION_SPEED_PER_SECOND },
      ));
    }
    if (track.property === 'scale' && plan.motion_profile === 'normal') {
      assertions.push(assertion(
        `track:${track.target}:scale_slope`,
        metrics.max_velocity_per_second <= NORMAL_MAX_SCALE_SPEED_PER_SECOND + 0.0001,
        `${track.target} 的缩放速度过快，会产生突然跳近或跳远`,
        { actual: metrics.max_velocity_per_second, max: NORMAL_MAX_SCALE_SPEED_PER_SECOND },
      ));
    }
  }

  const density = eventDensity(plan, fps, captions);
  const densityPass = density.max_same_frame_unmatched_events <= 1 && density.max_unmatched_events <= 2;
  assertions.push(assertion(
    'event_density',
    densityPass,
    densityPass
      ? '主要事件已错峰安排'
      : density.max_same_frame_unmatched_events > 1
        ? `同一帧出现 ${density.max_same_frame_unmatched_events} 个未声明同步的主要事件`
        : `有 ${density.max_unmatched_events} 个未声明同步的主要事件挤在 ${(density.window_frames / fps).toFixed(2)} 秒内`,
    density,
  ));
  const failed = assertions.filter((item) => !item.pass);
  return {
    pass: failed.length === 0,
    skipped: false,
    assertions,
    failures: failed.map((item) => ({ key: item.key, message: item.message })),
    metrics: { fps, duration_frames: durationFrames, motion: motionMetrics, event_density: density },
  };
}

function assertPlan(plan, context = {}, message = '场景转场连续性门禁未通过') {
  const report = evaluate(plan, context);
  if (!report.pass) {
    throw new PaperStudioError('PAPER_STUDIO_TRANSITION_GATE_FAILED', message, report, 422);
  }
  return report;
}

module.exports = {
  NORMAL_MAX_VEHICLE_SPEED_PER_SECOND,
  NORMAL_MAX_OPACITY_SLOPE_AT_30FPS,
  NORMAL_MAX_ROTATION_SPEED_PER_SECOND,
  NORMAL_MAX_SCALE_SPEED_PER_SECOND,
  evaluate,
  assertPlan,
  numericMetrics,
  changingSegments,
  eventDensity,
};
