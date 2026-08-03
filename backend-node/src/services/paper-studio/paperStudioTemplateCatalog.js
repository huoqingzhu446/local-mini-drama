const FOREGROUND_OCCLUSION_PATTERN = /(后方|后面|遮挡|遮住|桌后|案后|桌前|案前|拍案|伏案|书案|桌子|桌面|案几|柜台|餐桌|会议桌)/i;
const REGISTERED_BOUNDARY_PATTERN = /(穿过|越过|跨过|进入|离开|岸边|河岸|水边|浅滩|涉水|踏入水|走入水|湖边|海边|水面|浪花|潮水|门框|门洞|洞口|窗口|幕帘)/i;
const ATTACHED_PROP_PATTERN = /(拿起|拿着|握住|手持|高举|举起|递给|接过|放下|拔出|挥动|端起|捧起|抓住|抱住)/i;
const MULTI_SUBJECT_INTERACTION_PATTERN = /(对话|交谈|争执|质问|回答|说道|开口|交代|低语|喊道|问道|答道)/i;
const PATH_REVEAL_PATTERN = /(?:地图|平面图|示意图|流程图|线路图|管线图).{0,100}(?:路线|路径|线路|轨迹|流程线|管线|箭头|连线|标记).{0,100}(?:亮起|推进|延伸|展开|显现|到达|连接|合拢|闭合|包围)|(?:路线|路径|线路|轨迹|流程线|管线).{0,80}(?:推进|延伸|展开|显现|到达|连接|合拢|闭合)/i;
const OBJECT_SEQUENCE_PATTERN = /(?:击打|敲击|撞击|砸击|击碎|砸碎|切割|撕裂|破坏|碎裂|破碎|断裂|燃烧|点燃|作用|操作).{0,80}(?:依次|甩镜|再甩|切镜|随后|接着|继而|最后|转向|移焦|转场)|(?:依次|甩镜|再甩|切镜|随后|接着|继而).{0,80}(?:击打|敲击|撞击|砸击|击碎|砸碎|切割|撕裂|破坏|碎裂|破碎|断裂|燃烧|点燃|显现|进入画面)/i;

function frameAt(durationFrames, ratio) {
  return Math.max(0, Math.min(durationFrames - 1, Math.round((durationFrames - 1) * ratio)));
}

function duration(context, config, minimumSeconds = 3) {
  const fps = Number(config?.fps || 30);
  return {
    fps,
    durationFrames: Math.max(fps * minimumSeconds, Math.round(Number(context.storyboard.duration || 5) * fps)),
  };
}

function identity(entity, fallback) {
  return [entity?.name, entity?.appearance, entity?.description, entity?.prompt].filter(Boolean).join('；') || fallback;
}

function environmentDescription(context) {
  return context.scene?.prompt || context.storyboard.location || context.storyboard.description || '与分镜构图一致、没有人物和关键道具的干净背景';
}

function rootNode(children) {
  return {
    key: 'root', kind: 'group', pattern: 'free', slot: null, asset_version_id: null,
    transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
    relation: {}, clip: {}, local_z: 0, children,
  };
}

function cleanEnvironmentFamily(boundaries = []) {
  return {
    family_key: 'clean_environment',
    pattern: 'registered-environment',
    registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true,
      constraints: {
        no_people: true,
        no_key_props: true,
        same_canvas: true,
        aspect_ratio: '16:9',
        use_scene_as_reference: true,
        allow_source_import: false,
      },
    }],
    contract: { boundaries, coverage: ['background', 'midground', 'ground'], origin: [0, 0] },
  };
}

function cleanEnvironmentNode(boundary = null) {
  return {
    key: 'clean_environment', kind: 'registered-environment', pattern: 'registered-environment', slot: null, asset_version_id: null,
    transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
    relation: { family_key: 'clean_environment', ...(boundary ? { boundary } : {}) }, clip: {}, local_z: 0,
    children: [{
      key: 'clean_plate', kind: 'asset', pattern: 'registered-environment', slot: 'clean_plate', asset_version_id: null,
      transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
      relation: { family_key: 'clean_environment', fit: 'cover' }, clip: {}, local_z: 0, children: [],
    }],
  };
}

function characterConstraints(character, subjectKey, state) {
  return {
    transparent_background: true,
    single_subject: true,
    complete_silhouette: true,
    subject_key: subjectKey,
    state,
    family_consistency: true,
    allow_source_import: false,
    ...(character?.source_table === 'character_libraries'
      ? { source_character_library_id: Number(character.id) }
      : character?.id ? { source_character_id: Number(character.id) } : {}),
  };
}

function characterFamily(familyKey, character, states, options = {}) {
  const subjectKey = options.subjectKey || familyKey;
  return {
    family_key: familyKey,
    pattern: options.pattern || 'free',
    registration_canvas: options.registrationCanvas === false ? null : { width: 1920, height: 1080 },
    slots: states.map((state) => ({
      slot_key: `${familyKey}_${state}`,
      asset_type: 'character-cutout',
      generation_purpose: `character_state_${state}`,
      required_for_gate: true,
      constraints: characterConstraints(character, subjectKey, state),
    })),
    contract: {
      subject_key: subjectKey,
      identity: identity(character, options.fallbackIdentity || '分镜角色'),
      subject_slots: states.map((state) => `${familyKey}_${state}`),
      state_order: states,
      ...(options.contract || {}),
    },
  };
}

function characterNode(nodeKey, familyKey, states, transform, localZ, relation = {}) {
  return {
    key: nodeKey, kind: 'asset', pattern: 'free', slot: `${familyKey}_${states[0]}`, asset_version_id: null,
    transform: { anchor_x: 0.5, anchor_y: 0.82, ...transform },
    relation: {
      family_key: familyKey,
      state_slots: Object.fromEntries(states.map((state) => [state, `${familyKey}_${state}`])),
      ...relation,
    },
    clip: {}, local_z: localZ, children: [],
  };
}

function proofCrop(x, y, width, height) {
  return { x, y, width, height };
}

function environmentalDepthPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const peakFrame = frameAt(durationFrames, 0.58);
  const finalFrame = durationFrames - 1;
  const place = [context.scene?.location, context.scene?.time].filter(Boolean).join('，') || context.storyboard.location || '当前环境';
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: [] },
    subjects: [{ key: 'atmospheric_depth', kind: 'effect', identity: `${place}的雾层、空气透视和环境流动`, support_key: null, required_states: ['quiet', 'drift', 'settle'] }],
    action_beats: [{ key: 'environment_reveal', start_frame: 0, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'atmospheric_depth', action: 'reveal_depth_through_atmosphere' }],
  };
  const families = [cleanEnvironmentFamily()];
  const root = rootNode([
    cleanEnvironmentNode(),
    { key: 'mist_depth', kind: 'procedural', pattern: 'free', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.48, width: 1.2, height: 0.78, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'atmosphere-drift', appearance: 'mist', role: 'environment-subject' }, clip: {}, local_z: 20, children: [] },
    { key: 'ambient_flow', kind: 'procedural', pattern: 'free', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.69, width: 1.1, height: 0.48, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'ambient-flow', appearance: 'contextual', role: 'environment-subject' }, clip: {}, local_z: 21, children: [] },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'environmental_depth_motion', camera_only: false,
    subject_tracks: [
      { target: 'mist_depth', property: 'state', keyframes: [{ frame: 0, value: 'quiet' }, { frame: peakFrame, value: 'drift' }, { frame: finalFrame, value: 'settle' }] },
      { target: 'mist_depth', property: 'x', keyframes: [{ frame: 0, value: -0.08 }, { frame: peakFrame, value: 0.045, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.075, easing: 'ease-out' }] },
      { target: 'mist_depth', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.18 }, { frame: peakFrame, value: 0.82, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.46, easing: 'ease-out' }] },
      { target: 'ambient_flow', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.12 }, { frame: peakFrame, value: 0.72, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.38, easing: 'ease-out' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'y', keyframes: [{ frame: 0, value: -0.018 }, { frame: finalFrame, value: 0.018, easing: 'ease-in-out' }] }],
    cues: [{ key: 'atmosphere_peak', frame: peakFrame, kind: 'semantic' }, { key: 'environment_settle', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'mist_translation', metric: 'numeric_range', target: 'mist_depth', property: 'x', min: 0.12 },
      { key: 'mist_density_change', metric: 'numeric_range', target: 'mist_depth', property: 'procedural_amount', min: 0.5 },
      { key: 'ambient_flow_change', metric: 'numeric_range', target: 'ambient_flow', property: 'procedural_amount', min: 0.45 },
      { key: 'atmosphere_peak_cue', metric: 'cue_exists', cue: 'atmosphere_peak' },
    ],
  };
  const proofTargets = [
    { key: 'environment_start', frame: 0, target_node_key: 'mist_depth', crop: proofCrop(0.02, 0.06, 0.96, 0.88), assertions: [{ type: 'camera_only', expected: false }] },
    { key: 'environment_peak', frame: peakFrame, target_node_key: 'mist_depth', crop: proofCrop(0.02, 0.06, 0.96, 0.88), assertions: [{ type: 'track_range', target: 'mist_depth', property: 'procedural_amount', min: 0.5 }, { type: 'track_range', target: 'mist_depth', property: 'x', min: 0.12 }] },
    { key: 'environment_final', frame: finalFrame, target_node_key: 'ambient_flow', crop: proofCrop(0.02, 0.28, 0.96, 0.66), assertions: [{ type: 'track_range', target: 'ambient_flow', property: 'procedural_amount', min: 0.45 }] },
  ];
  return { catalog_key: 'environmental-depth-motion-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'environmental-depth-motion-v1', primary_action: motionPlan.primary_action, camera_only: false, clean_plate_required: true, source_family_count: 1, required_asset_count: 1, required_states: ['quiet', 'drift', 'settle'], relation_contracts: ['procedural atmosphere over clean environment'], proof_targets: proofTargets } };
}

function pathRevealPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const routeFrame = frameAt(durationFrames, 0.62);
  const finalFrame = durationFrames - 1;
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: [] },
    subjects: [{ key: 'path_subject', kind: 'effect', identity: '平面底图上逐步显现的路径与终点标记', support_key: null, required_states: ['hidden', 'revealing', 'complete'] }],
    action_beats: [
      { key: 'path_advance', start_frame: 0, peak_frame: routeFrame, end_frame: finalFrame, subject_key: 'path_subject', action: 'reveal_path' },
      { key: 'path_complete', start_frame: routeFrame, peak_frame: finalFrame, end_frame: finalFrame, subject_key: 'path_subject', action: 'show_completion' },
    ],
  };
  const families = [cleanEnvironmentFamily()];
  const root = rootNode([
    cleanEnvironmentNode(),
    { key: 'path_reveal', kind: 'procedural', pattern: 'free', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.51, width: 0.92, height: 0.82, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'path-reveal', appearance: 'ink-route', role: 'path-subject', points: [[0.18, 0.82], [0.34, 0.66], [0.46, 0.52], [0.62, 0.38], [0.78, 0.24]] }, clip: {}, local_z: 20, children: [] },
    { key: 'path_completion', kind: 'procedural', pattern: 'free', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.51, width: 0.92, height: 0.82, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'path-reveal', appearance: 'completion-ring', role: 'path-subject', points: [[0.7, 0.2], [0.84, 0.24], [0.87, 0.39], [0.76, 0.48], [0.64, 0.39], [0.65, 0.26], [0.7, 0.2]] }, clip: {}, local_z: 21, children: [] },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'path_reveal', camera_only: false,
    subject_tracks: [
      { target: 'path_reveal', property: 'state', keyframes: [{ frame: 0, value: 'hidden' }, { frame: routeFrame, value: 'revealing' }, { frame: finalFrame, value: 'complete' }] },
      { target: 'path_reveal', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 1, easing: 'ease-in-out' }, { frame: finalFrame, value: 1 }] },
      { target: 'path_completion', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 0 }, { frame: finalFrame, value: 1, easing: 'ease-in-out' }] },
      { target: 'path_completion', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 0.12 }, { frame: finalFrame, value: 1, easing: 'ease-out' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'x', keyframes: [{ frame: 0, value: -0.025 }, { frame: finalFrame, value: 0.025, easing: 'ease-in-out' }] }],
    cues: [{ key: 'path_arrival', frame: routeFrame, kind: 'semantic' }, { key: 'path_completed', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'path_reveal_range', metric: 'numeric_range', target: 'path_reveal', property: 'clip_progress', min: 0.95 },
      { key: 'path_completion_range', metric: 'numeric_range', target: 'path_completion', property: 'clip_progress', min: 0.95 },
      { key: 'path_completion_final', metric: 'final_value', target: 'path_completion', property: 'procedural_amount', min: 0.9 },
      { key: 'path_arrival_cue', metric: 'cue_exists', cue: 'path_arrival' },
    ],
  };
  const proofTargets = [
    { key: 'path_start', frame: 0, target_node_key: 'path_reveal', crop: proofCrop(0.04, 0.05, 0.92, 0.9), assertions: [{ type: 'camera_only', expected: false }] },
    { key: 'path_arrival', frame: routeFrame, target_node_key: 'path_reveal', crop: proofCrop(0.04, 0.05, 0.92, 0.9), assertions: [{ type: 'track_range', target: 'path_reveal', property: 'clip_progress', min: 0.95 }] },
    { key: 'path_completion_final', frame: finalFrame, target_node_key: 'path_completion', crop: proofCrop(0.04, 0.05, 0.92, 0.9), assertions: [{ type: 'final_track_value', target: 'path_completion', property: 'procedural_amount', min: 0.9 }, { type: 'track_range', target: 'path_completion', property: 'clip_progress', min: 0.95 }] },
  ];
  return { catalog_key: 'path-reveal-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'path-reveal-v1', primary_action: motionPlan.primary_action, camera_only: false, clean_plate_required: true, source_family_count: 1, required_asset_count: 1, required_states: ['hidden', 'revealing', 'complete'], relation_contracts: ['path overlay registered to flat canvas', 'no generated text'], proof_targets: proofTargets } };
}

function replaceTrack(plan, target, property, keyframes) {
  const next = { target, property, keyframes };
  const index = (plan.subject_tracks || []).findIndex((track) => track.target === target && track.property === property);
  if (index >= 0) plan.subject_tracks[index] = next;
  else plan.subject_tracks.push(next);
  return `${target}:${property}`;
}

function replaceCameraTrack(plan, property, keyframes) {
  const next = { target: 'camera', property, keyframes };
  const index = (plan.camera_tracks || []).findIndex((track) => track.target === 'camera' && track.property === property);
  if (index >= 0) plan.camera_tracks[index] = next;
  else plan.camera_tracks.push(next);
  return `camera:${property}`;
}

function applyObjectSequenceStaging(plan, { impactFrame, revealFrame, hasSecondary = true } = {}) {
  const finalFrame = Math.max(1, Number(plan.duration_frames || 2) - 1);
  const impact = Math.max(1, Math.min(finalFrame - 3, Number(impactFrame ?? frameAt(plan.duration_frames, 0.3))));
  const reveal = Math.max(impact + 2, Math.min(finalFrame - 1, Number(revealFrame ?? frameAt(plan.duration_frames, 0.62))));
  const entryFrame = Math.max(1, Math.min(impact - 2, Math.round(impact * 0.46)));
  const strikeStartFrame = Math.max(entryFrame + 1, Math.min(impact - 1, Math.round(impact * 0.68)));
  const transferFrame = Math.max(impact + 1, Math.min(reveal - 1, Math.round(impact + ((reveal - impact) * 0.56))));
  const brokenFrame = Math.max(impact + 1, Math.min(transferFrame, Math.round(impact + ((reveal - impact) * 0.24))));
  const changedTracks = [];

  changedTracks.push(replaceTrack(plan, 'impact_subject', 'state', [
    { frame: 0, value: 'intact' },
    { frame: impact, value: 'fracture' },
    { frame: brokenFrame, value: 'broken' },
    { frame: finalFrame, value: 'broken' },
  ]));
  changedTracks.push(replaceTrack(plan, 'impact_tool', 'x', [
    { frame: 0, value: 0.1 },
    { frame: entryFrame, value: 0.1 },
    { frame: strikeStartFrame, value: 0.035, easing: 'ease-out' },
    { frame: impact, value: 0 },
    { frame: transferFrame, value: -0.08, easing: 'ease-out' },
    { frame: reveal, value: -0.22, easing: 'ease-in' },
    { frame: finalFrame, value: -0.24 },
  ]));
  changedTracks.push(replaceTrack(plan, 'impact_tool', 'y', [
    { frame: 0, value: -0.58 },
    { frame: entryFrame, value: -0.58 },
    { frame: strikeStartFrame, value: -0.24, easing: 'ease-in' },
    { frame: impact, value: 0.08, easing: 'ease-in' },
    { frame: transferFrame, value: -0.24, easing: 'ease-out' },
    { frame: reveal, value: -0.42, easing: 'ease-in' },
    { frame: finalFrame, value: -0.44 },
  ]));
  changedTracks.push(replaceTrack(plan, 'impact_tool', 'rotation', [
    { frame: 0, value: -48 },
    { frame: entryFrame, value: -48 },
    { frame: strikeStartFrame, value: -30, easing: 'ease-out' },
    { frame: impact, value: 8, easing: 'ease-in' },
    { frame: transferFrame, value: 14, easing: 'ease-out' },
    { frame: reveal, value: 18 },
    { frame: finalFrame, value: 18 },
  ]));
  changedTracks.push(replaceTrack(plan, 'impact_tool', 'opacity', [
    { frame: 0, value: 0 },
    { frame: entryFrame, value: 0 },
    { frame: strikeStartFrame, value: 1, easing: 'ease-out' },
    { frame: impact, value: 1 },
    { frame: transferFrame, value: 0.72, easing: 'ease-out' },
    { frame: reveal, value: 0, easing: 'ease-in' },
    { frame: finalFrame, value: 0 },
  ]));

  if (hasSecondary) {
    changedTracks.push(replaceTrack(plan, 'impact_subject', 'opacity', [
      { frame: 0, value: 1 },
      { frame: transferFrame, value: 1 },
      { frame: reveal, value: 0.12, easing: 'ease-in-out' },
      { frame: finalFrame, value: 0 },
    ]));
    changedTracks.push(replaceTrack(plan, 'impact_subject', 'x', [
      { frame: 0, value: 0 },
      { frame: transferFrame, value: 0 },
      { frame: reveal, value: -0.18, easing: 'ease-in-out' },
      { frame: finalFrame, value: -0.22 },
    ]));
    changedTracks.push(replaceTrack(plan, 'secondary_prop', 'opacity', [
      { frame: 0, value: 0 },
      { frame: transferFrame, value: 0 },
      { frame: reveal, value: 1, easing: 'ease-out' },
      { frame: finalFrame, value: 1 },
    ]));
    changedTracks.push(replaceTrack(plan, 'secondary_prop', 'x', [
      { frame: 0, value: 0.16 },
      { frame: transferFrame, value: 0.16 },
      { frame: reveal, value: 0, easing: 'ease-out' },
      { frame: finalFrame, value: -0.015 },
    ]));
    changedTracks.push(replaceTrack(plan, 'secondary_prop', 'scale', [
      { frame: 0, value: 0.84 },
      { frame: transferFrame, value: 0.84 },
      { frame: reveal, value: 1.06, easing: 'ease-out' },
      { frame: finalFrame, value: 1 },
    ]));
    changedTracks.push(replaceCameraTrack(plan, 'x', [
      { frame: 0, value: -0.055 },
      { frame: impact, value: -0.055 },
      { frame: transferFrame, value: -0.04 },
      { frame: reveal, value: 0.1, easing: 'ease-in-out' },
      { frame: finalFrame, value: 0.085, easing: 'ease-out' },
    ]));
  }

  const requirements = (plan.gate_requirements || []).filter((item) => ![
    'tool_hidden_initial', 'tool_entry_visibility', 'tool_visible_at_impact',
    'tool_entry_cue', 'impact_exits_final', 'tool_exits_final', 'camera_focus_transfer',
  ].includes(item.key));
  requirements.push({ key: 'tool_hidden_initial', metric: 'initial_value', target: 'impact_tool', property: 'opacity', max: 0.05 });
  requirements.push({ key: 'tool_entry_visibility', metric: 'numeric_range', target: 'impact_tool', property: 'opacity', min: 0.95 });
  requirements.push({ key: 'tool_visible_at_impact', metric: 'cue_value', target: 'impact_tool', property: 'opacity', cue: 'impact', min: 0.95 });
  requirements.push({ key: 'tool_entry_cue', metric: 'cue_exists', cue: 'tool_entry' });
  requirements.push({ key: 'tool_exits_final', metric: 'final_value', target: 'impact_tool', property: 'opacity', max: 0.05 });
  if (hasSecondary) {
    requirements.push({ key: 'impact_exits_final', metric: 'final_value', target: 'impact_subject', property: 'opacity', max: 0.1 });
    requirements.push({ key: 'camera_focus_transfer', metric: 'numeric_range', target: 'camera', property: 'x', min: 0.12 });
  }
  plan.gate_requirements = requirements;
  plan.cues = [
    ...(plan.cues || []).filter((cue) => !['tool_entry', 'focus_transfer'].includes(cue.key)),
    { key: 'tool_entry', frame: entryFrame, kind: 'entrance' },
    { key: 'focus_transfer', frame: transferFrame, kind: 'transition' },
  ].sort((left, right) => left.frame - right.frame);
  return { entry_frame: entryFrame, strike_start_frame: strikeStartFrame, impact_frame: impact, broken_frame: brokenFrame, transfer_frame: transferFrame, reveal_frame: reveal, changed_tracks: changedTracks };
}

function impactToolIdentity(context) {
  const text = [context.storyboard.action, context.storyboard.description]
    .filter(Boolean)
    .join(' ');
  const explicit = text.match(/(?:使用|用|挥动|举起|抡起|持有|拿着)([^，。；,;]{1,16}?)(?:击打|敲击|撞击|砸击|砸向|击碎|砸碎|切割|切入|劈向|作用)/i)
    || text.match(/(?:^|[，。；,;\s])([^，。；,;\s]{1,16}?)(?:落下|击打|敲击|撞击|砸击|砸向|击碎|砸碎|切入|劈向)/i);
  const name = String(explicit?.[1] || '').trim();
  return name
    ? `${name}；分镜中用于完成主体作用动作的独立工具，完整轮廓，形态与目标和动作匹配`
    : '分镜中用于完成主体作用动作的独立工具，完整轮廓，形态与目标和动作匹配';
}

function objectSequencePlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 5);
  const impactFrame = frameAt(durationFrames, 0.3);
  const revealFrame = frameAt(durationFrames, 0.62);
  const finalFrame = durationFrames - 1;
  const primary = context.props[0];
  const secondary = context.props[1] || null;
  const toolIdentity = impactToolIdentity(context);
  const states = ['intact', 'fracture', 'broken'];
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: [] },
    subjects: [
      { key: 'impact_subject', kind: 'prop', identity: identity(primary, '被击碎的关键物件'), support_key: null, required_states: states },
      { key: 'impact_tool', kind: 'prop', identity: toolIdentity, support_key: null, required_states: ['raised', 'contact', 'released'] },
      ...(secondary ? [{ key: 'secondary_prop', kind: 'prop', identity: identity(secondary, '随后显现的关键物件'), support_key: null, required_states: ['hidden', 'present'] }] : []),
      { key: 'sequence_effect', kind: 'effect', identity: '撞击碎屑与后续顺序转场效果', support_key: 'impact_subject', required_states: ['hidden', 'impact', 'settle'] },
    ],
    action_beats: [
      { key: 'object_impact', start_frame: 0, peak_frame: impactFrame, end_frame: revealFrame, subject_key: 'impact_subject', action: 'fracture' },
      { key: 'secondary_reveal', start_frame: impactFrame, peak_frame: revealFrame, end_frame: finalFrame, subject_key: secondary ? 'secondary_prop' : 'sequence_effect', action: 'reveal' },
      { key: 'sequence_transition', start_frame: revealFrame, peak_frame: finalFrame, end_frame: finalFrame, subject_key: 'sequence_effect', action: 'settle' },
    ],
  };
  const families = [
    cleanEnvironmentFamily(),
    {
      family_key: 'impact_subject', pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
      slots: states.map((state) => ({ slot_key: `impact_${state}`, asset_type: 'prop-cutout', generation_purpose: `prop_state_${state}`, required_for_gate: true, constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'impact_subject', state, ...(primary?.id ? { source_prop_id: Number(primary.id) } : {}) } })),
      contract: { subject_key: 'impact_subject', identity: identity(primary, '被击碎的关键物件'), subject_slots: states.map((state) => `impact_${state}`), state_order: states },
    },
    {
      family_key: 'impact_tool', pattern: 'free', registration_canvas: null,
      slots: [{ slot_key: 'impact_tool_cutout', asset_type: 'prop-cutout', generation_purpose: 'impact_tool_cutout', required_for_gate: true, constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'impact_tool', state: 'contact' } }],
      contract: { subject_key: 'impact_tool', identity: toolIdentity, contact_zone: 'impact_point' },
    },
    ...(secondary ? [{
      family_key: 'secondary_prop', pattern: 'free', registration_canvas: null,
      slots: [{ slot_key: 'secondary_prop_cutout', asset_type: 'prop-cutout', generation_purpose: 'secondary_prop_cutout', required_for_gate: true, constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'secondary_prop', source_prop_id: Number(secondary.id) } }],
      contract: { subject_key: 'secondary_prop', identity: identity(secondary, '随后显现的关键物件') },
    }] : []),
    {
      family_key: 'sequence_effect', pattern: 'free', registration_canvas: null,
      slots: [{ slot_key: 'sequence_effect_alpha', asset_type: 'effect-cutout', generation_purpose: 'impact_transition_effect', required_for_gate: false, constraints: { transparent_background: true, subject_key: 'sequence_effect', fallback: 'procedural' } }],
      contract: { event_cues: ['impact', 'sequence_reveal'], persistent_contact: false },
    },
  ];
  const root = rootNode([
    cleanEnvironmentNode(),
    { key: 'impact_subject', kind: 'asset', pattern: 'free', slot: 'impact_intact', asset_version_id: null, transform: { x: 0.35, y: 0.7, width: 0.36, height: 0.48, anchor_x: 0.5, anchor_y: 0.75 }, relation: { family_key: 'impact_subject', role: 'subject', state_slots: Object.fromEntries(states.map((state) => [state, `impact_${state}`])) }, clip: {}, local_z: 20, children: [] },
    { key: 'impact_tool', kind: 'asset', pattern: 'free', slot: 'impact_tool_cutout', asset_version_id: null, transform: { x: 0.36, y: 0.42, width: 0.24, height: 0.38, anchor_x: 0.5, anchor_y: 0.82 }, relation: { family_key: 'impact_tool', role: 'tool', predicate: 'contacts', object_key: 'impact_subject', contact_zone: 'impact_point' }, clip: {}, local_z: 24, children: [] },
    ...(secondary ? [{ key: 'secondary_prop', kind: 'asset', pattern: 'free', slot: 'secondary_prop_cutout', asset_version_id: null, transform: { x: 0.7, y: 0.67, width: 0.3, height: 0.45, anchor_x: 0.5, anchor_y: 0.72 }, relation: { family_key: 'secondary_prop', role: 'subject' }, clip: {}, local_z: 22, children: [] }] : []),
    { key: 'sequence_effect', kind: 'procedural', pattern: 'free', slot: 'sequence_effect_alpha', asset_version_id: null, transform: { x: 0.5, y: 0.63, width: 0.86, height: 0.62, anchor_x: 0.5, anchor_y: 0.7 }, relation: { procedural_kind: 'transition-effect', appearance: 'particles', role: 'transition-effect' }, clip: {}, local_z: 30, children: [] },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'object_sequence_transition', camera_only: false,
    subject_tracks: [
      { target: 'impact_subject', property: 'state', keyframes: [{ frame: 0, value: 'intact' }, { frame: impactFrame, value: 'fracture' }, { frame: revealFrame, value: 'broken' }, { frame: finalFrame, value: 'broken' }] },
      { target: 'impact_subject', property: 'rotation', keyframes: [{ frame: 0, value: -3 }, { frame: impactFrame, value: 9, easing: 'ease-out' }, { frame: revealFrame, value: 1, easing: 'ease-in-out' }, { frame: finalFrame, value: 0 }] },
      { target: 'impact_subject', property: 'scale', keyframes: [{ frame: 0, value: 0.96 }, { frame: impactFrame, value: 1.1, easing: 'ease-out' }, { frame: revealFrame, value: 1 }, { frame: finalFrame, value: 1 }] },
      { target: 'impact_tool', property: 'y', keyframes: [{ frame: 0, value: -0.2 }, { frame: impactFrame, value: 0.08, easing: 'ease-in' }, { frame: revealFrame, value: -0.1, easing: 'ease-out' }, { frame: finalFrame, value: -0.12 }] },
      { target: 'impact_tool', property: 'rotation', keyframes: [{ frame: 0, value: -32 }, { frame: impactFrame, value: 8, easing: 'ease-in' }, { frame: revealFrame, value: 18 }, { frame: finalFrame, value: 18 }] },
      ...(secondary ? [
        { target: 'secondary_prop', property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: impactFrame, value: 0 }, { frame: revealFrame, value: 1, easing: 'ease-out' }, { frame: finalFrame, value: 1 }] },
        { target: 'secondary_prop', property: 'x', keyframes: [{ frame: 0, value: 0.12 }, { frame: impactFrame, value: 0.12 }, { frame: revealFrame, value: 0, easing: 'ease-out' }, { frame: finalFrame, value: -0.02 }] },
      ] : []),
      { target: 'sequence_effect', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: impactFrame, value: 0.75, easing: 'ease-out' }, { frame: revealFrame, value: 0.24 }, { frame: finalFrame, value: 0.9, easing: 'ease-in' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'x', keyframes: [{ frame: 0, value: -0.03 }, { frame: impactFrame, value: -0.015 }, { frame: revealFrame, value: 0.025, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.04 }] }],
    cues: [{ key: 'impact', frame: impactFrame, kind: 'contact' }, { key: 'secondary_reveal', frame: revealFrame, kind: 'semantic' }, { key: 'sequence_reveal', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'impact_state_count', metric: 'distinct_states', target: 'impact_subject', property: 'state', min: 3 },
      { key: 'tool_strike_range', metric: 'numeric_range', target: 'impact_tool', property: 'y', min: 0.25 },
      ...(secondary ? [{ key: 'secondary_reveal_range', metric: 'numeric_range', target: 'secondary_prop', property: 'opacity', min: 0.9 }] : []),
      { key: 'effect_change', metric: 'numeric_range', target: 'sequence_effect', property: 'procedural_amount', min: 0.7 },
      { key: 'impact_cue', metric: 'cue_exists', cue: 'impact' },
    ],
  };
  applyObjectSequenceStaging(motionPlan, { impactFrame, revealFrame, hasSecondary: Boolean(secondary) });
  const proofTargets = [
    { key: 'object_start', frame: 0, target_node_key: 'impact_subject', crop: proofCrop(0.05, 0.12, 0.9, 0.82), assertions: [{ type: 'state_equals', target: 'impact_subject', value: 'intact' }, { type: 'track_value_at_frame', target: 'impact_tool', property: 'opacity', max: 0.05 }, { type: 'camera_only', expected: false }] },
    { key: 'object_impact', frame: impactFrame, target_node_key: 'impact_subject', crop: proofCrop(0.05, 0.12, 0.9, 0.82), assertions: [{ type: 'state_equals', target: 'impact_subject', value: 'fracture' }, { type: 'track_range', target: 'impact_tool', property: 'y', min: 0.25 }, { type: 'track_value_at_frame', target: 'impact_tool', property: 'opacity', min: 0.95 }] },
    { key: 'object_sequence_final', frame: finalFrame, target_node_key: secondary ? 'secondary_prop' : 'sequence_effect', crop: proofCrop(0.05, 0.12, 0.9, 0.82), assertions: [{ type: 'state_distinct_count', target: 'impact_subject', min: 3 }, { type: 'final_track_value', target: 'impact_tool', property: 'opacity', max: 0.05 }, ...(secondary ? [{ type: 'final_track_value', target: 'impact_subject', property: 'opacity', max: 0.1 }, { type: 'final_track_value', target: 'secondary_prop', property: 'opacity', min: 0.9 }] : []), { type: 'final_track_value', target: 'sequence_effect', property: 'procedural_amount', min: 0.85 }] },
  ];
  return { catalog_key: 'object-sequence-transition-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'object-sequence-transition-v1', primary_action: motionPlan.primary_action, camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length, required_states: states, relation_contracts: ['impact_tool contacts impact_subject', 'secondary prop revealed after impact'], proof_targets: proofTargets } };
}

function multiSubjectInteractionPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const turnFrame = frameAt(durationFrames, 0.34);
  const peakFrame = frameAt(durationFrames, 0.64);
  const finalFrame = durationFrames - 1;
  const actors = [context.characters[0], context.characters[1]];
  const statesA = ['listen', 'speak', 'settle'];
  const statesB = ['listen', 'react', 'settle'];
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: [] },
    subjects: actors.map((actor, index) => ({
      key: `actor_${index === 0 ? 'a' : 'b'}`,
      kind: 'character',
      identity: identity(actor, `对话角色${index + 1}`),
      support_key: null,
      required_states: index === 0 ? statesA : statesB,
    })),
    action_beats: [
      { key: 'speaker_turn', start_frame: 0, peak_frame: turnFrame, end_frame: peakFrame, subject_key: 'actor_a', action: 'speak' },
      { key: 'listener_reaction', start_frame: turnFrame, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'actor_b', action: 'react' },
    ],
  };
  const families = [
    cleanEnvironmentFamily(),
    characterFamily('actor_a', actors[0], statesA, { subjectKey: 'actor_a' }),
    characterFamily('actor_b', actors[1], statesB, { subjectKey: 'actor_b' }),
  ];
  const root = rootNode([
    cleanEnvironmentNode(),
    characterNode('actor_a', 'actor_a', statesA, { x: 0.33, y: 0.65, width: 0.38, height: 0.7 }, 20, { facing: 'right', relation: 'faces', target: 'actor_b' }),
    characterNode('actor_b', 'actor_b', statesB, { x: 0.69, y: 0.65, width: 0.38, height: 0.7 }, 21, { facing: 'left', relation: 'faces', target: 'actor_a' }),
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'dialogue_turn', camera_only: false,
    subject_tracks: [
      { target: 'actor_a', property: 'state', keyframes: [{ frame: 0, value: 'listen' }, { frame: turnFrame, value: 'speak' }, { frame: finalFrame, value: 'settle' }] },
      { target: 'actor_a', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: turnFrame, value: -4, easing: 'ease-out' }, { frame: finalFrame, value: 0, easing: 'ease-in-out' }] },
      { target: 'actor_b', property: 'state', keyframes: [{ frame: 0, value: 'listen' }, { frame: peakFrame, value: 'react' }, { frame: finalFrame, value: 'settle' }] },
      { target: 'actor_b', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: peakFrame, value: 4, easing: 'ease-out' }, { frame: finalFrame, value: 0, easing: 'ease-in-out' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.018, easing: 'ease-in-out' }] }],
    cues: [{ key: 'dialogue_turn', frame: turnFrame, kind: 'dialogue' }, { key: 'reaction_peak', frame: peakFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'actor_a_states', metric: 'distinct_states', target: 'actor_a', property: 'state', min: 3 },
      { key: 'actor_b_states', metric: 'distinct_states', target: 'actor_b', property: 'state', min: 3 },
      { key: 'speaker_motion', metric: 'numeric_range', target: 'actor_a', property: 'rotation', min: 3 },
      { key: 'listener_motion', metric: 'numeric_range', target: 'actor_b', property: 'rotation', min: 3 },
      { key: 'dialogue_cue', metric: 'cue_exists', cue: 'dialogue_turn' },
    ],
  };
  const proofTargets = [
    { key: 'dialogue_start', frame: 0, target_node_key: 'actor_a', crop: proofCrop(0.08, 0.14, 0.84, 0.78), assertions: [{ type: 'state_equals', target: 'actor_a', value: 'listen' }] },
    { key: 'dialogue_turn', frame: turnFrame, target_node_key: 'actor_a', crop: proofCrop(0.08, 0.14, 0.84, 0.78), assertions: [{ type: 'state_equals', target: 'actor_a', value: 'speak' }, { type: 'track_range', target: 'actor_a', property: 'rotation', min: 3 }, { type: 'camera_only', expected: false }] },
    { key: 'dialogue_reaction', frame: peakFrame, target_node_key: 'actor_b', crop: proofCrop(0.08, 0.14, 0.84, 0.78), assertions: [{ type: 'state_equals', target: 'actor_b', value: 'react' }, { type: 'state_distinct_count', target: 'actor_b', min: 3 }] },
  ];
  return {
    catalog_key: 'multi-subject-interaction-v1', semanticContract, families, root, motionPlan, proofTargets,
    summary: { catalog_key: 'multi-subject-interaction-v1', primary_action: 'dialogue_turn', camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: 7, required_states: { actor_a: statesA, actor_b: statesB }, relation_contracts: ['actor_a faces actor_b', 'dialogue turn-taking'], proof_targets: proofTargets },
  };
}

function attachedPropActionPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const contactFrame = frameAt(durationFrames, 0.38);
  const peakFrame = frameAt(durationFrames, 0.65);
  const finalFrame = durationFrames - 1;
  const actor = context.characters[0];
  const prop = context.props[0];
  const states = ['reach', 'grasp', 'present'];
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: [] },
    subjects: [
      { key: 'actor', kind: 'character', identity: identity(actor, '持物角色'), support_key: null, required_states: states },
      { key: 'held_prop', kind: 'prop', identity: identity(prop, '关键手持道具'), support_key: 'actor', required_states: ['rest', 'held'] },
    ],
    action_beats: [
      { key: 'reach_prop', start_frame: 0, peak_frame: contactFrame, end_frame: peakFrame, subject_key: 'actor', action: 'reach' },
      { key: 'lift_prop', start_frame: contactFrame, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'held_prop', action: 'lift' },
    ],
  };
  const families = [
    cleanEnvironmentFamily(),
    characterFamily('actor', actor, states, { subjectKey: 'actor', pattern: 'supported-subject', contract: { support_slot: 'actor_reach', subject_slots: ['actor_grasp', 'actor_present'], contact_zone: 'front_hand' } }),
    {
      family_key: 'held_prop', pattern: 'free', registration_canvas: null,
      slots: [{ slot_key: 'held_prop_cutout', asset_type: 'prop-cutout', generation_purpose: 'held_prop_cutout', required_for_gate: true, constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'held_prop', ...(prop?.id ? { source_prop_id: Number(prop.id) } : {}) } }],
      contract: { predicate: 'held-by', subject_key: 'held_prop', object_key: 'actor', contact_zone: 'front_hand' },
    },
  ];
  const root = rootNode([
    cleanEnvironmentNode(),
    {
      key: 'held_action_group', kind: 'supported-subject', pattern: 'supported-subject', slot: null, asset_version_id: null,
      transform: { x: 0.53, y: 0.62, width: 0.62, height: 0.72, anchor_x: 0.5, anchor_y: 0.82 },
      relation: { family_key: 'actor', support: 'actor', contact_zone: 'front_hand' }, clip: {}, local_z: 20,
      children: [
        characterNode('actor', 'actor', states, { x: 0.5, y: 0.5, width: 0.78, height: 1 }, 5, { role: 'support', contact_zone: 'front_hand' }),
        { key: 'held_prop', kind: 'asset', pattern: 'supported-subject', slot: 'held_prop_cutout', asset_version_id: null, transform: { x: 0.66, y: 0.52, width: 0.24, height: 0.32, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'held_prop', role: 'subject', predicate: 'held-by', object_key: 'actor', contact_zone: 'front_hand' }, clip: {}, local_z: 10, children: [] },
      ],
    },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'hold_and_lift', camera_only: false,
    subject_tracks: [
      { target: 'actor', property: 'state', keyframes: [{ frame: 0, value: 'reach' }, { frame: contactFrame, value: 'grasp' }, { frame: peakFrame, value: 'present' }, { frame: finalFrame, value: 'present' }] },
      { target: 'actor', property: 'rotation', keyframes: [{ frame: 0, value: -3 }, { frame: contactFrame, value: 2, easing: 'ease-out' }, { frame: peakFrame, value: -1, easing: 'ease-in-out' }, { frame: finalFrame, value: 0 }] },
      { target: 'held_prop', property: 'y', keyframes: [{ frame: 0, value: 0.13 }, { frame: contactFrame, value: 0.08, easing: 'ease-in-out' }, { frame: peakFrame, value: -0.09, easing: 'ease-out' }, { frame: finalFrame, value: -0.07 }] },
      { target: 'held_prop', property: 'rotation', keyframes: [{ frame: 0, value: -12 }, { frame: contactFrame, value: -4 }, { frame: peakFrame, value: 9, easing: 'ease-out' }, { frame: finalFrame, value: 6 }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.025, easing: 'ease-in-out' }] }],
    cues: [{ key: 'prop_contact', frame: contactFrame, kind: 'contact' }, { key: 'prop_present_peak', frame: peakFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'actor_state_count', metric: 'distinct_states', target: 'actor', property: 'state', min: 3 },
      { key: 'prop_lift_delta', metric: 'numeric_range', target: 'held_prop', property: 'y', min: 0.16 },
      { key: 'prop_rotation_delta', metric: 'numeric_range', target: 'held_prop', property: 'rotation', min: 12 },
      { key: 'contact_cue', metric: 'cue_exists', cue: 'prop_contact' },
    ],
  };
  const proofTargets = [
    { key: 'hold_start', frame: 0, target_node_key: 'held_action_group', crop: proofCrop(0.18, 0.12, 0.68, 0.8), assertions: [{ type: 'state_equals', target: 'actor', value: 'reach' }] },
    { key: 'hold_contact', frame: contactFrame, target_node_key: 'held_action_group', crop: proofCrop(0.18, 0.12, 0.68, 0.8), assertions: [{ type: 'state_equals', target: 'actor', value: 'grasp' }, { type: 'camera_only', expected: false }] },
    { key: 'hold_peak', frame: peakFrame, target_node_key: 'held_action_group', crop: proofCrop(0.18, 0.08, 0.68, 0.84), assertions: [{ type: 'track_range', target: 'held_prop', property: 'y', min: 0.16 }, { type: 'state_distinct_count', target: 'actor', min: 3 }] },
  ];
  return { catalog_key: 'attached-prop-action-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'attached-prop-action-v1', primary_action: 'hold_and_lift', camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: 5, required_states: states, relation_contracts: ['held_prop held-by actor', 'front_hand contact'], proof_targets: proofTargets } };
}

function foregroundOcclusionPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const actionFrame = frameAt(durationFrames, 0.4);
  const peakFrame = frameAt(durationFrames, 0.67);
  const finalFrame = durationFrames - 1;
  const actor = context.characters[0];
  const support = context.props.find((item) => FOREGROUND_OCCLUSION_PATTERN.test(`${item.name || ''} ${item.type || ''} ${item.description || ''}`)) || context.props[0];
  const states = ['rest', 'act', 'settle'];
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: ['foreground_boundary'] },
    subjects: [
      { key: 'actor', kind: 'character', identity: identity(actor, '被前景局部遮挡的角色'), support_key: 'support_surface', required_states: states },
      { key: 'support_surface', kind: 'prop', identity: identity(support, '与场景一致的前景支撑物'), support_key: null, required_states: ['static'] },
    ],
    action_beats: [{ key: 'foreground_occluded_action', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: 'actor', action: 'act_behind_foreground' }],
  };
  const families = [
    cleanEnvironmentFamily(['foreground_boundary']),
    characterFamily('actor', actor, states, { subjectKey: 'actor', pattern: 'supported-subject', contract: { support_slot: 'support_body', front_slot: 'support_front', contact_zone: 'support_contact_zone' } }),
    {
      family_key: 'foreground_support', pattern: 'supported-subject', registration_canvas: { width: 1920, height: 1080 },
      slots: [
        { slot_key: 'support_body', asset_type: 'prop-cutout', generation_purpose: 'foreground_support_body', required_for_gate: true, constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'support_surface', ...(support?.id ? { source_prop_id: Number(support.id) } : {}) } },
        { slot_key: 'support_front', asset_type: 'occluder-cutout', generation_purpose: 'foreground_support_occlusion', required_for_gate: true, constraints: { transparent_background: true, derivation: 'registered_alpha_band', source_slot: 'support_body', semantic_part: 'support_front', band: [0.48, 1] } },
      ],
      contract: { support_slot: 'support_body', subject_slots: states.map((state) => `actor_${state}`), front_slot: 'support_front', contact_zone: 'support_contact_zone' },
    },
  ];
  const root = rootNode([
    cleanEnvironmentNode('foreground_boundary'),
    {
      key: 'supported_group', kind: 'supported-subject', pattern: 'supported-subject', slot: null, asset_version_id: null,
      transform: { x: 0.52, y: 0.67, width: 0.68, height: 0.7, anchor_x: 0.5, anchor_y: 0.75 },
      relation: { family_key: 'foreground_support', support: 'support_body', contact_zone: 'support_contact_zone', boundary: 'foreground_boundary' }, clip: {}, local_z: 20,
      children: [
        { key: 'support_body', kind: 'asset', pattern: 'supported-subject', slot: 'support_body', asset_version_id: null, transform: { x: 0.5, y: 0.7, width: 1, height: 0.5, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'foreground_support', role: 'rear-support' }, clip: {}, local_z: 0, children: [] },
        characterNode('actor', 'actor', states, { x: 0.5, y: 0.37, width: 0.62, height: 0.74 }, 5, { role: 'subject', predicate: 'behind', object_key: 'support_front' }),
        { key: 'support_front', kind: 'asset', pattern: 'supported-subject', slot: 'support_front', asset_version_id: null, transform: { x: 0.5, y: 0.7, width: 1, height: 0.5, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'foreground_support', role: 'front-occluder', occludes: ['actor'] }, clip: { boundary: 'foreground_boundary' }, local_z: 10, children: [] },
      ],
    },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'foreground_occluded_action', camera_only: false,
    subject_tracks: [
      { target: 'actor', property: 'state', keyframes: [{ frame: 0, value: 'rest' }, { frame: actionFrame, value: 'act' }, { frame: finalFrame, value: 'settle' }] },
      { target: 'actor', property: 'rotation', keyframes: [{ frame: 0, value: -2 }, { frame: actionFrame, value: 5, easing: 'ease-out' }, { frame: peakFrame, value: 2 }, { frame: finalFrame, value: 0, easing: 'ease-in-out' }] },
      { target: 'actor', property: 'y', keyframes: [{ frame: 0, value: 0.025 }, { frame: actionFrame, value: -0.035, easing: 'ease-out' }, { frame: finalFrame, value: 0 }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.02, easing: 'ease-in-out' }] }],
    cues: [{ key: 'occluded_action_peak', frame: actionFrame, kind: 'semantic' }, { key: 'action_settle', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'actor_state_count', metric: 'distinct_states', target: 'actor', property: 'state', min: 3 },
      { key: 'actor_rotation', metric: 'numeric_range', target: 'actor', property: 'rotation', min: 6 },
      { key: 'actor_vertical_gesture', metric: 'numeric_range', target: 'actor', property: 'y', min: 0.05 },
      { key: 'action_cue', metric: 'cue_exists', cue: 'occluded_action_peak' },
    ],
  };
  const proofTargets = [
    { key: 'occlusion_start', frame: 0, target_node_key: 'supported_group', crop: proofCrop(0.14, 0.14, 0.76, 0.82), assertions: [{ type: 'state_equals', target: 'actor', value: 'rest' }] },
    { key: 'occluded_action', frame: actionFrame, target_node_key: 'supported_group', crop: proofCrop(0.14, 0.14, 0.76, 0.82), assertions: [{ type: 'state_equals', target: 'actor', value: 'act' }, { type: 'track_range', target: 'actor', property: 'rotation', min: 6 }, { type: 'camera_only', expected: false }] },
    { key: 'occlusion_final', frame: finalFrame, target_node_key: 'supported_group', crop: proofCrop(0.14, 0.14, 0.76, 0.82), assertions: [{ type: 'state_distinct_count', target: 'actor', min: 3 }, { type: 'relation_exists', node: 'support_front', role: 'front-occluder' }] },
  ];
  return { catalog_key: 'foreground-occlusion-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'foreground-occlusion-v1', primary_action: motionPlan.primary_action, camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: 6, required_states: states, relation_contracts: ['actor behind support_front', 'support_front occludes actor'], proof_targets: proofTargets } };
}

function registeredBoundaryCrossingPlan(context, config = {}) {
  const { fps, durationFrames } = duration(context, config, 4);
  const enterFrame = frameAt(durationFrames, 0.38);
  const peakFrame = frameAt(durationFrames, 0.66);
  const finalFrame = durationFrames - 1;
  const actor = context.characters[0];
  const states = ['approach', 'contact', 'crossed'];
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(context.storyboard.id),
    environment: { description: environmentDescription(context), clean_plate_required: true, registered_boundaries: ['primary_boundary'] },
    subjects: [{ key: 'actor', kind: 'character', identity: identity(actor, '穿越边界的角色'), support_key: null, required_states: states }],
    action_beats: [
      { key: 'approach_boundary', start_frame: 0, peak_frame: enterFrame, end_frame: peakFrame, subject_key: 'actor', action: 'approach' },
      { key: 'cross_boundary', start_frame: enterFrame, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'actor', action: 'cross' },
    ],
  };
  const families = [
    {
      ...cleanEnvironmentFamily(['primary_boundary']),
      slots: [
        ...cleanEnvironmentFamily(['primary_boundary']).slots,
        { slot_key: 'boundary_front_mask', asset_type: 'occlusion-mask', generation_purpose: 'registered_boundary_front_occlusion', required_for_gate: true, constraints: { boundary: 'primary_boundary', boundary_y: 0.53, fill_direction: 'below', min_final_occlusion_ratio: 0.45, derivation: 'registered_procedural_mask' } },
      ],
      contract: { boundaries: ['primary_boundary'], origin: [0, 0] },
    },
    characterFamily('actor', actor, states, { subjectKey: 'actor', pattern: 'registered-environment', contract: { crosses_boundary: 'primary_boundary' } }),
  ];
  const environment = cleanEnvironmentNode('primary_boundary');
  environment.children.push({ key: 'boundary_back', kind: 'procedural', pattern: 'registered-environment', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.75, width: 1, height: 0.5, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'boundary-back', appearance: 'contextual', family_key: 'clean_environment' }, clip: { boundary: 'primary_boundary' }, local_z: 5, children: [] });
  const root = rootNode([
    environment,
    characterNode('actor', 'actor', states, { x: 0.46, y: 0.62, width: 0.38, height: 0.66 }, 20, { predicate: 'crosses', boundary: 'primary_boundary' }),
    { key: 'boundary_front', kind: 'procedural', pattern: 'registered-environment', slot: 'boundary_front_mask', asset_version_id: null, transform: { x: 0.5, y: 0.84, width: 1, height: 0.38, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'boundary-front', appearance: 'contextual', role: 'front-occluder', family_key: 'clean_environment', occludes: ['actor'] }, clip: { boundary: 'primary_boundary' }, local_z: 40, children: [] },
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'registered_boundary_crossing', camera_only: false,
    subject_tracks: [
      { target: 'actor', property: 'state', keyframes: [{ frame: 0, value: 'approach' }, { frame: enterFrame, value: 'contact' }, { frame: peakFrame, value: 'crossed' }, { frame: finalFrame, value: 'crossed' }] },
      { target: 'actor', property: 'x', keyframes: [{ frame: 0, value: -0.16 }, { frame: enterFrame, value: -0.04, easing: 'ease-in-out' }, { frame: peakFrame, value: 0.08, easing: 'ease-out' }, { frame: finalFrame, value: 0.13 }] },
      { target: 'actor', property: 'y', keyframes: [{ frame: 0, value: -0.04 }, { frame: enterFrame, value: 0.02 }, { frame: peakFrame, value: 0.09, easing: 'ease-in' }, { frame: finalFrame, value: 0.12 }] },
      { target: 'actor', property: 'rotation', keyframes: [{ frame: 0, value: -4 }, { frame: enterFrame, value: 3 }, { frame: peakFrame, value: -2 }, { frame: finalFrame, value: 1 }] },
      { target: 'boundary_front', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.16 }, { frame: enterFrame, value: 0.24 }, { frame: peakFrame, value: 0.45, easing: 'ease-in' }, { frame: finalFrame, value: 0.52 }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'x', keyframes: [{ frame: 0, value: -0.015 }, { frame: finalFrame, value: 0.015, easing: 'ease-in-out' }] }],
    cues: [{ key: 'boundary_contact', frame: enterFrame, kind: 'contact' }, { key: 'crossing_peak', frame: peakFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'actor_state_count', metric: 'distinct_states', target: 'actor', property: 'state', min: 3 },
      { key: 'actor_crossing_x', metric: 'numeric_range', target: 'actor', property: 'x', min: 0.25 },
      { key: 'actor_enter_y', metric: 'numeric_range', target: 'actor', property: 'y', min: 0.14 },
      { key: 'boundary_occlusion', metric: 'final_value', target: 'boundary_front', property: 'procedural_amount', min: 0.45 },
      { key: 'boundary_contact_cue', metric: 'cue_exists', cue: 'boundary_contact' },
    ],
  };
  const proofTargets = [
    { key: 'boundary_start', frame: 0, target_node_key: 'actor', crop: proofCrop(0.1, 0.16, 0.82, 0.78), assertions: [{ type: 'state_equals', target: 'actor', value: 'approach' }] },
    { key: 'boundary_contact', frame: enterFrame, target_node_key: 'actor', crop: proofCrop(0.1, 0.16, 0.82, 0.78), assertions: [{ type: 'state_equals', target: 'actor', value: 'contact' }, { type: 'track_range', target: 'actor', property: 'x', min: 0.25 }, { type: 'camera_only', expected: false }] },
    { key: 'boundary_final', frame: finalFrame, target_node_key: 'actor', crop: proofCrop(0.1, 0.16, 0.82, 0.78), assertions: [{ type: 'final_track_value', target: 'boundary_front', property: 'procedural_amount', min: 0.45 }, { type: 'state_distinct_count', target: 'actor', min: 3 }, { type: 'relation_exists', node: 'boundary_front', role: 'front-occluder' }] },
  ];
  return { catalog_key: 'registered-boundary-crossing-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'registered-boundary-crossing-v1', primary_action: motionPlan.primary_action, camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: 5, required_states: states, final_occlusion_ratio: 0.52, relation_contracts: ['actor crosses primary_boundary', 'boundary_front occludes actor'], proof_targets: proofTargets } };
}

function sourceText(context) {
  return [
    context.storyboard.title,
    context.storyboard.description,
    context.storyboard.dialogue,
    context.storyboard.action,
    context.storyboard.result,
    context.storyboard.location,
  ].filter(Boolean).join('\n');
}

function selectCapability(context) {
  const text = sourceText(context);
  const hasCharacter = Array.isArray(context.characters) && context.characters.length > 0;
  const hasTwoCharacters = hasCharacter && context.characters.length > 1;
  const hasProp = Array.isArray(context.props) && context.props.length > 0;
  if (!hasCharacter && PATH_REVEAL_PATTERN.test(text)) return 'path-reveal-v1';
  if (!hasCharacter && (context.props || []).length >= 2 && OBJECT_SEQUENCE_PATTERN.test(text)) return 'object-sequence-transition-v1';
  if (!hasCharacter && !hasProp && !String(context.storyboard.action || '').trim()) return 'environmental-depth-motion-v1';
  if (hasCharacter && hasProp && FOREGROUND_OCCLUSION_PATTERN.test(`${text}\n${context.props.map((prop) => `${prop.name || ''} ${prop.type || ''}`).join('\n')}`)) return 'foreground-occlusion-v1';
  if (hasCharacter && REGISTERED_BOUNDARY_PATTERN.test(text)) return 'registered-boundary-crossing-v1';
  if (hasCharacter && hasProp && ATTACHED_PROP_PATTERN.test(text)) return 'attached-prop-action-v1';
  if (hasTwoCharacters && (MULTI_SUBJECT_INTERACTION_PATTERN.test(text) || String(context.storyboard.dialogue || '').trim())) return 'multi-subject-interaction-v1';
  return null;
}

function buildCapabilityPlan(context, config = {}) {
  switch (selectCapability(context)) {
    case 'environmental-depth-motion-v1': return environmentalDepthPlan(context, config);
    case 'path-reveal-v1': return pathRevealPlan(context, config);
    case 'object-sequence-transition-v1': return objectSequencePlan(context, config);
    case 'multi-subject-interaction-v1': return multiSubjectInteractionPlan(context, config);
    case 'attached-prop-action-v1': return attachedPropActionPlan(context, config);
    case 'foreground-occlusion-v1': return foregroundOcclusionPlan(context, config);
    case 'registered-boundary-crossing-v1': return registeredBoundaryCrossingPlan(context, config);
    default: return null;
  }
}

module.exports = {
  FOREGROUND_OCCLUSION_PATTERN,
  REGISTERED_BOUNDARY_PATTERN,
  ATTACHED_PROP_PATTERN,
  MULTI_SUBJECT_INTERACTION_PATTERN,
  PATH_REVEAL_PATTERN,
  OBJECT_SEQUENCE_PATTERN,
  selectCapability,
  buildCapabilityPlan,
  multiSubjectInteractionPlan,
  attachedPropActionPlan,
  foregroundOcclusionPlan,
  registeredBoundaryCrossingPlan,
  environmentalDepthPlan,
  pathRevealPlan,
  objectSequencePlan,
  applyObjectSequenceStaging,
};
