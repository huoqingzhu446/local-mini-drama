const schemaService = require('./paperStudioSchemaService');
const { PaperStudioError } = require('./paperStudioUtils');

const ACTOR_WORDS = [
  '人物', '角色', '主角', '男孩', '女孩', '男人', '女人', '老人', '少年', '少女',
  '士兵', '士卒', '将军', '侍卫', '店员', '顾客', '旅客', '司机', '孩子', '他', '她',
];
const PROP_WORDS = [
  '行李箱', '手提箱', '箱子', '背包', '雨伞', '书包', '书本', '杯子', '篮子',
  '包裹', '武器', '长剑', '木箱', '手机', '信件', '道具',
];
const SUPPORT_WORDS = [
  '长椅', '椅子', '沙发', '床边', '床', '台阶', '凳子', '座位', '桌旁', '桌子',
  '门口', '站台', '岸边', '窗边',
];

function frameAt(durationFrames, ratio) {
  return Math.max(0, Math.min(durationFrames - 1, Math.round((durationFrames - 1) * ratio)));
}

function firstMatch(text, words) {
  return words.find((word) => text.includes(word)) || '';
}

function cleanCapturedName(value = '') {
  return String(value)
    .replace(/^(?:从|向|往|到|走到|来到|靠近|移到|左侧|右侧|前方|后方)+/, '')
    .replace(/(?:旁边|旁|边上|前面|前|后面|后|上面|上|处)$/g, '')
    .trim();
}

function inferActorName(text, context) {
  const source = context.characters?.[0];
  if (source?.name) return source.name;
  const dictionary = firstMatch(text, ACTOR_WORDS);
  if (dictionary) return dictionary;
  const prefix = text.match(/(?:^|[，。；])([^，。；]{1,12}?)(?=提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着|走向|走到|走|跑向|跑到|跑|坐下|落座|进入|离开)/);
  const captured = cleanCapturedName(prefix?.[1] || '');
  return captured && !/(镜头|画面|背景|场景|室内|室外)/.test(captured) ? captured : '人物';
}

function inferPropName(text, context) {
  const source = context.props?.[0];
  if (source?.name) return source.name;
  const carried = text.match(/(?:提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着)([^，。；]{1,10}?)(?=从|向|往|走|跑|来到|到达|并|后|，|。|；|$)/);
  const captured = cleanCapturedName(carried?.[1] || '');
  return captured || firstMatch(text, PROP_WORDS);
}

function inferSupportName(text) {
  const dictionary = firstMatch(text, SUPPORT_WORDS);
  if (dictionary) return dictionary;
  const destination = text.match(/(?:走到|跑到|来到|到达|靠近|移到)(?:画面)?(?:左侧|右侧|前方|后方)?([^，。；]{1,10}?)(?=并|后|坐下|落座|停下|放下|，|。|；|$)/);
  const captured = cleanCapturedName(destination?.[1] || '');
  if (!captured) return '';
  // A coarse screen direction followed by another verb is a waypoint, not an
  // environment anchor. Without this guard, phrases such as “走到右侧停下”
  // backtrack through the optional direction group and turn “停下” into a
  // fake support entity.
  if (/^(?:停下|站定|驻足|放下|落下|转身|回头|离开|走开|继续|移动|目标位置|原地)$/.test(captured)) return '';
  if (/^(?:画面)?(?:左侧|右侧|前方|后方)$/.test(captured)) return '';
  return captured;
}

function inferDirection(text) {
  if (/从右.{0,24}(?:到|向|往).{0,8}左|向左|往左/.test(text)) return 'right_to_left';
  if (/从左.{0,24}(?:到|向|往).{0,8}右|向右|往右|右侧/.test(text)) return 'left_to_right';
  if (/向前|往前|前方/.test(text)) return 'forward';
  if (/向后|往后|后方/.test(text)) return 'backward';
  return 'left_to_right';
}

function sourceIdentity(entity, source) {
  if (!source?.id) return entity;
  return {
    ...entity,
    source_library_type: source.source_table || (entity.type === 'character' ? 'characters' : 'props'),
    source_library_id: Number(source.id),
    ...(source.source_table === 'paper_library' && source.identity_version_id
      ? { identity_version_id: Number(source.identity_version_id) }
      : {}),
  };
}

function phase(key, label, startRatio, endRatio, actorState, objectState = null) {
  return { key, label, start_ratio: startRatio, end_ratio: endRatio, actor_state: actorState, object_state: objectState };
}

function infer(context = {}) {
  const storyboard = context.storyboard || {};
  const text = [storyboard.title, storyboard.description, storyboard.action, storyboard.dialogue, storyboard.narration]
    .filter(Boolean)
    .join('，');
  const environmentDescription = context.scene?.prompt || storyboard.location || storyboard.description || storyboard.title || '分镜干净背景';
  const environmentOnly = Boolean(storyboard.environment_only);
  if (environmentOnly) {
    const blueprint = {
      schema_version: 1,
      environment: { description: environmentDescription, clean_plate_required: true, camera_intent: storyboard.camera_motion || 'static', registered_boundaries: [] },
      entities: [{ key: 'atmosphere_1', type: 'effect', name: '环境氛围', role: 'environment_motion', independent_layer: true, reusable: false, states: ['quiet', 'drift', 'settle'], attributes: {} }],
      relations: [],
      action_contract: {
        primary_action: 'environmental_depth_motion', actor_key: 'atmosphere_1', object_key: null, support_key: null,
        direction: 'stationary', start_state: 'quiet', end_state: 'settle',
        waypoints: [{ key: 'environment_center', label: '环境中心', x: 0, y: 0 }],
        phases: [phase('quiet', '静置', 0, 0.25, 'quiet'), phase('drift', '环境运动', 0.25, 0.75, 'drift'), phase('settle', '收束', 0.75, 1, 'settle')],
        contact_events: [], occlusion_events: [],
      },
      generation_slots: [],
    };
    schemaService.assertValid('paperBlueprint', blueprint, '环境镜头生产蓝图无效');
    return blueprint;
  }

  const actorName = inferActorName(text, context);
  const propName = inferPropName(text, context);
  const supportName = inferSupportName(text);
  const hasCarry = Boolean(propName) && /提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着/.test(text);
  const hasMove = /走|跑|移动|来到|到达|靠近|穿过|进入|离开/.test(text);
  const hasSit = /坐下|落座|坐到|坐在/.test(text);
  const hasRelease = Boolean(propName) && /放下|放到|放在|松开|卸下|搁下|丢下/.test(text);
  const direction = inferDirection(text);
  const primaryAction = hasCarry && hasMove && hasSit
    ? 'carry_move_sit'
    : hasMove
      ? 'directed_move'
      : hasSit
        ? 'state_transition'
        : 'generic_subject_action';
  const actorStates = primaryAction === 'carry_move_sit'
    ? ['standing_holding', 'walking_holding', 'seated']
    : primaryAction === 'directed_move'
      ? ['start', 'moving', 'arrived']
      : primaryAction === 'state_transition'
        ? ['standing', 'transitioning', 'seated']
        : ['start', 'action', 'settle'];
  const entities = [sourceIdentity({
    key: 'actor_1', type: 'character', name: actorName, role: 'actor', independent_layer: true,
    reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: actorStates, attributes: { inferred_from: 'storyboard_text' },
  }, context.characters?.[0])];
  if (propName) entities.push(sourceIdentity({
    key: 'prop_1', type: 'prop', name: propName, role: hasCarry ? 'carried_object' : 'prop', independent_layer: true,
    reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: hasCarry ? ['held', 'carried', 'released'] : ['stable'], attributes: { inferred_from: 'storyboard_text' },
  }, context.props?.[0]));
  if (supportName) entities.push({
    key: 'support_1', type: 'environment_anchor', name: supportName, role: hasSit ? 'destination_support' : 'destination_anchor',
    independent_layer: false, reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: ['registered'], attributes: { included_in_clean_plate: true },
  });

  const objectKey = propName ? 'prop_1' : null;
  const supportKey = supportName ? 'support_1' : null;
  const relations = [];
  if (objectKey && hasCarry) {
    relations.push({ key: 'actor_holds_prop', subject_key: 'actor_1', predicate: 'holds', object_key: objectKey, start_phase: primaryAction === 'carry_move_sit' ? 'lift' : 'start', end_phase: 'arrive', attributes: { attachment: 'hand' } });
    relations.push({ key: 'prop_follows_actor', subject_key: objectKey, predicate: 'follows', object_key: 'actor_1', start_phase: 'move', end_phase: 'arrive', attributes: { synchronized: true } });
    if (hasRelease && !supportKey) relations.push({ key: 'prop_released_at_destination', subject_key: objectKey, predicate: 'released_beside', object_key: 'actor_1', start_phase: 'arrive', end_phase: 'arrive', attributes: { destination_waypoint: 'destination' } });
  }
  if (supportKey) relations.push({ key: 'actor_moves_to_support', subject_key: 'actor_1', predicate: 'moves_to', object_key: supportKey, start_phase: 'move', end_phase: 'arrive', attributes: {} });
  if (supportKey && hasSit) {
    relations.push({ key: 'actor_sits_on_support', subject_key: 'actor_1', predicate: 'sits_on', object_key: supportKey, start_phase: 'sit', end_phase: 'settle', attributes: {} });
    relations.push({ key: 'actor_occluded_by_support', subject_key: 'actor_1', predicate: 'occluded_by', object_key: supportKey, start_phase: 'sit', end_phase: 'settle', attributes: { part: 'lower_body' } });
  }
  if (objectKey && supportKey && primaryAction === 'carry_move_sit') relations.push({ key: 'prop_released_beside_support', subject_key: objectKey, predicate: 'released_beside', object_key: supportKey, start_phase: 'release', end_phase: 'settle', attributes: {} });

  let phases;
  if (primaryAction === 'carry_move_sit') {
    phases = [
      phase('lift', '提起道具', 0, 0.16, 'standing_holding', 'held'),
      phase('move', '携带移动', 0.16, 0.64, 'walking_holding', 'carried'),
      phase('arrive', '到达支撑物', 0.64, 0.76, 'walking_holding', 'carried'),
      phase('sit', '坐下', 0.76, 0.9, 'seated', 'carried'),
      phase('release', '道具落位', 0.9, 0.96, 'seated', 'released'),
      phase('settle', '保持结束姿态', 0.96, 1, 'seated', 'released'),
    ];
  } else if (primaryAction === 'directed_move') {
    phases = [
      phase('start', '起始', 0, 0.15, 'start', hasCarry ? 'held' : null),
      phase('move', '移动', 0.15, 0.8, 'moving', hasCarry ? 'carried' : null),
      phase('arrive', hasRelease ? '到达并放下道具' : '到达', 0.8, 1, 'arrived', hasRelease ? 'released' : hasCarry ? 'carried' : null),
    ];
  } else if (primaryAction === 'state_transition') {
    phases = [phase('start', '站立', 0, 0.25, 'standing'), phase('transition', '姿态切换', 0.25, 0.78, 'transitioning'), phase('settle', '坐稳', 0.78, 1, 'seated')];
  } else {
    phases = [phase('start', '起始', 0, 0.25, 'start'), phase('action', '动作', 0.25, 0.75, 'action'), phase('settle', '收束', 0.75, 1, 'settle')];
  }
  const startX = direction === 'right_to_left' ? 0.3 : direction === 'left_to_right' ? -0.3 : 0;
  const endX = direction === 'right_to_left' ? -0.3 : direction === 'left_to_right' ? 0.3 : 0;
  const blueprint = {
    schema_version: 1,
    environment: {
      description: environmentDescription,
      clean_plate_required: true,
      camera_intent: storyboard.camera_motion || 'static',
      registered_boundaries: supportKey && hasSit ? ['support_front'] : [],
    },
    entities,
    relations,
    action_contract: {
      primary_action: primaryAction,
      actor_key: 'actor_1', object_key: objectKey, support_key: supportKey, direction,
      start_state: actorStates[0], end_state: actorStates[actorStates.length - 1],
      waypoints: [
        { key: 'start', label: direction === 'right_to_left' ? '画面右侧' : '画面左侧', x: startX, y: 0 },
        { key: supportKey ? 'support' : 'destination', label: supportName || '目标位置', x: endX, y: 0 },
      ],
      phases,
      contact_events: [
        ...(objectKey && hasCarry ? ['grip_prop'] : []),
        ...(supportKey ? ['reach_support'] : []),
        ...(supportKey && hasSit ? ['sit_on_support'] : []),
        ...(objectKey && (primaryAction === 'carry_move_sit' || hasRelease) ? ['release_prop'] : []),
      ],
      occlusion_events: supportKey && hasSit ? ['lower_body_behind_support_front'] : [],
    },
    generation_slots: [],
  };
  schemaService.assertValid('paperBlueprint', blueprint, '自然语言生产蓝图无效');
  return blueprint;
}

function sourceConstraints(entity) {
  if (!entity?.source_library_id) return {};
  if (entity.source_library_type === 'paper_library') {
    return entity.identity_version_id
      ? { source_paper_entity_id: Number(entity.source_library_id), source_identity_version_id: Number(entity.identity_version_id) }
      : {};
  }
  if (entity.source_library_type === 'character_libraries') return { source_character_library_id: Number(entity.source_library_id) };
  if (entity.type === 'character') return { source_character_id: Number(entity.source_library_id) };
  if (entity.type === 'prop') return { source_prop_id: Number(entity.source_library_id) };
  return {};
}

function node(key, kind, pattern, slot, transform, relation, localZ, children = []) {
  return { key, kind, pattern, slot, asset_version_id: null, transform, relation, clip: {}, local_z: localZ, children };
}

function baseEnvironmentFamily(blueprint, { includeSupportMask = false } = {}) {
  return {
    family_key: 'clean_environment', pattern: 'registered-environment', registration_canvas: { width: 1920, height: 1080 },
    slots: [
      { slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true, constraints: { no_primary_subjects: true, same_canvas: true, aspect_ratio: '16:9', environment_description: blueprint.environment.description } },
      ...(includeSupportMask ? [{ slot_key: 'support_front_mask', asset_type: 'occlusion-mask', generation_purpose: 'support_front_occlusion', required_for_gate: true, constraints: { derivation: 'registered_procedural_mask', boundary: 'support_front', fill_direction: 'support_front', subject_key: blueprint.action_contract.support_key } }] : []),
    ],
    contract: { boundaries: blueprint.environment.registered_boundaries || [], origin: [0, 0], description: blueprint.environment.description },
  };
}

function compoundPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const actor = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key);
  const prop = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.object_key);
  const support = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.support_key);
  if (!actor || !prop || !support) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_COMPOUND_ENTITY_MISSING', '携带移动并坐下需要角色、独立道具和目标支撑物', { actor: actor?.key || null, prop: prop?.key || null, support: support?.key || null }, 422);
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 4, Math.round(Number(storyboard.duration || 6) * fps));
  const liftFrame = frameAt(durationFrames, 0.14);
  const moveFrame = frameAt(durationFrames, 0.26);
  const arriveFrame = frameAt(durationFrames, 0.66);
  const sitFrame = frameAt(durationFrames, 0.82);
  const releaseFrame = frameAt(durationFrames, 0.92);
  const finalFrame = durationFrames - 1;
  const start = blueprint.action_contract.waypoints[0];
  const destination = blueprint.action_contract.waypoints[blueprint.action_contract.waypoints.length - 1];
  const startX = Number(start?.x ?? -0.3);
  const endX = Number(destination?.x ?? 0.3);
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: { description: blueprint.environment.description, clean_plate_required: true, registered_boundaries: ['support_front'] },
    subjects: [
      { key: actor.key, kind: 'character', identity: actor.name, support_key: null, required_states: actor.states },
      { key: prop.key, kind: 'prop', identity: prop.name, support_key: actor.key, required_states: prop.states },
    ],
    action_beats: [
      { key: 'lift', start_frame: 0, peak_frame: liftFrame, end_frame: moveFrame, subject_key: actor.key, action: 'grip_and_lift' },
      { key: 'move', start_frame: moveFrame, peak_frame: arriveFrame, end_frame: arriveFrame, subject_key: actor.key, action: 'carry_to_waypoint' },
      { key: 'sit', start_frame: arriveFrame, peak_frame: sitFrame, end_frame: releaseFrame, subject_key: actor.key, action: 'sit_on_support' },
      { key: 'release', start_frame: sitFrame, peak_frame: releaseFrame, end_frame: finalFrame, subject_key: prop.key, action: 'release_beside_support' },
    ],
  };
  const families = [
    baseEnvironmentFamily(blueprint, { includeSupportMask: true }),
    {
      family_key: 'actor_family', pattern: 'supported-subject', registration_canvas: { width: 1920, height: 1080 },
      slots: actor.states.map((state) => ({ slot_key: `actor_${state}`, asset_type: 'character-cutout', generation_purpose: `actor_state_${state}`, required_for_gate: true, constraints: { transparent_background: true, single_subject: true, subject_key: actor.key, state, identity: actor.name, ...sourceConstraints(actor) } })),
      contract: { subject_key: actor.key, identity: actor.name, subject_slots: Object.fromEntries(actor.states.map((state) => [state, `actor_${state}`])) },
    },
    {
      family_key: 'prop_family', pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
      slots: [{ slot_key: 'prop_cutout', asset_type: 'prop-cutout', generation_purpose: 'independent_carried_prop', required_for_gate: true, constraints: { transparent_background: true, single_subject: true, subject_key: prop.key, identity: prop.name, ...sourceConstraints(prop) } }],
      contract: { subject_key: prop.key, identity: prop.name, attachment_schedule: ['held', 'carried', 'released'] },
    },
  ];
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0),
    ]),
    node(actor.key, 'asset', 'supported-subject', `actor_${actor.states[0]}`, { x: 0.5, y: 0.65, width: 0.34, height: 0.64, anchor_x: 0.5, anchor_y: 0.88 }, { family_key: 'actor_family', role: 'actor', state_slots: Object.fromEntries(actor.states.map((state) => [state, `actor_${state}`])) }, 20),
    node(prop.key, 'asset', 'free', 'prop_cutout', { x: 0.5, y: 0.71, width: 0.18, height: 0.24, anchor_x: 0.5, anchor_y: 0.5 }, { family_key: 'prop_family', predicate: 'held-by', object: actor.key, relation_schedule: { held_until: 'release_prop', then: 'released_beside', support_key: support.key } }, 24),
    node('support_front', 'procedural', 'registered-environment', 'support_front_mask', { x: 0.5, y: 0.76, width: 1, height: 0.48 }, { family_key: 'clean_environment', role: 'front-occluder', occludes: [actor.key], support_key: support.key }, 40),
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'carry_move_sit', camera_only: false,
    subject_tracks: [
      { target: actor.key, property: 'x', keyframes: [{ frame: 0, value: startX }, { frame: moveFrame, value: startX }, { frame: arriveFrame, value: endX, easing: 'ease-in-out' }, { frame: finalFrame, value: endX }] },
      { target: actor.key, property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: arriveFrame, value: 0 }, { frame: sitFrame, value: 0.1, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.1 }] },
      { target: actor.key, property: 'state', keyframes: [{ frame: 0, value: actor.states[0] }, { frame: moveFrame, value: actor.states[1] }, { frame: sitFrame, value: actor.states[2] }, { frame: finalFrame, value: actor.states[2] }] },
      { target: prop.key, property: 'x', keyframes: [{ frame: 0, value: startX - 0.04 }, { frame: moveFrame, value: startX - 0.04 }, { frame: arriveFrame, value: endX - 0.04, easing: 'ease-in-out' }, { frame: releaseFrame, value: endX + 0.13, easing: 'ease-out' }, { frame: finalFrame, value: endX + 0.13 }] },
      { target: prop.key, property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: arriveFrame, value: 0 }, { frame: releaseFrame, value: 0.16, easing: 'ease-in' }, { frame: finalFrame, value: 0.16 }] },
      { target: prop.key, property: 'state', keyframes: [{ frame: 0, value: 'held' }, { frame: moveFrame, value: 'carried' }, { frame: releaseFrame, value: 'released' }, { frame: finalFrame, value: 'released' }] },
      { target: 'support_front', property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: arriveFrame, value: 0 }, { frame: sitFrame, value: 0.86, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.86 }] },
    ],
    camera_tracks: [],
    cues: [
      { key: 'grip_prop', frame: liftFrame, kind: 'contact' },
      { key: 'walk_start', frame: moveFrame, kind: 'semantic' },
      { key: 'reach_support', frame: arriveFrame, kind: 'contact' },
      { key: 'sit_on_support', frame: sitFrame, kind: 'semantic' },
      { key: 'release_prop', frame: releaseFrame, kind: 'contact' },
    ],
    gate_requirements: [
      { key: 'actor_reaches_destination', metric: 'numeric_range', target: actor.key, property: 'x', min: 0.45 },
      { key: 'actor_has_seated_state', metric: 'distinct_states', target: actor.key, property: 'state', min: 3 },
      { key: 'prop_follows_actor', metric: 'numeric_range', target: prop.key, property: 'x', min: 0.42 },
      { key: 'prop_releases', metric: 'distinct_states', target: prop.key, property: 'state', min: 3 },
      { key: 'support_occlusion_final', metric: 'final_value', target: 'support_front', property: 'opacity', min: 0.7 },
      { key: 'release_cue_exists', metric: 'cue_exists', cue: 'release_prop' },
    ],
  };
  const proofTargets = [
    { key: 'carry_start', frame: 0, target_node_key: actor.key, crop: { x: 0.02, y: 0.18, width: 0.46, height: 0.78 }, assertions: [{ type: 'state_equals', target: actor.key, value: actor.states[0] }, { type: 'relation_exists', node: prop.key, predicate: 'held-by' }] },
    { key: 'carry_arrive', frame: arriveFrame, target_node_key: actor.key, crop: { x: 0.44, y: 0.18, width: 0.54, height: 0.78 }, assertions: [{ type: 'track_range', target: actor.key, property: 'x', min: 0.45 }, { type: 'track_range', target: prop.key, property: 'x', min: 0.42 }] },
    { key: 'carry_final', frame: finalFrame, target_node_key: actor.key, crop: { x: 0.44, y: 0.18, width: 0.54, height: 0.78 }, assertions: [{ type: 'state_equals', target: actor.key, value: actor.states[2] }, { type: 'state_equals', target: prop.key, value: 'released' }, { type: 'final_track_value', target: 'support_front', property: 'opacity', min: 0.7 }] },
  ];
  return {
    catalog_key: 'compound-carry-move-sit-v1', semanticContract, families, root, motionPlan, proofTargets,
    summary: {
      catalog_key: 'compound-carry-move-sit-v1', primary_action: 'carry_move_sit', camera_only: false,
      clean_plate_required: true, source_family_count: families.length,
      required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
      entity_keys: [actor.key, prop.key, support.key], required_states: { [actor.key]: actor.states, [prop.key]: prop.states },
      relation_contracts: blueprint.relations.map((relation) => `${relation.subject_key}:${relation.predicate}:${relation.object_key}`),
      proof_targets: proofTargets,
    },
  };
}

function genericPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const actorKey = blueprint.action_contract.actor_key;
  const subject = blueprint.entities.find((entity) => entity.key === actorKey) || blueprint.entities.find((entity) => entity.independent_layer) || blueprint.entities[0];
  const auxiliaryEntities = blueprint.entities.filter((entity) => entity.independent_layer && entity.key !== subject.key);
  const actionObject = auxiliaryEntities.find((entity) => entity.key === blueprint.action_contract.object_key) || null;
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 3, Math.round(Number(storyboard.duration || 5) * fps));
  const actionFrame = frameAt(durationFrames, 0.58);
  const releaseFrame = frameAt(durationFrames, 0.86);
  const finalFrame = durationFrames - 1;
  const states = subject.states.length >= 3 ? subject.states.slice(0, 3) : [subject.states[0] || 'start', 'action', 'settle'];
  const start = blueprint.action_contract.waypoints[0] || { x: -0.06, y: 0 };
  const end = blueprint.action_contract.waypoints[blueprint.action_contract.waypoints.length - 1] || { x: 0.06, y: 0 };
  const motionAction = blueprint.action_contract.primary_action;
  const semanticKind = subject.type === 'prop' ? 'prop' : subject.type === 'effect' ? 'effect' : 'character';
  const releaseRequested = Boolean(actionObject) && (blueprint.action_contract.contact_events || []).includes('release_prop');
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(storyboard.id),
    environment: { description: blueprint.environment.description, clean_plate_required: true, registered_boundaries: blueprint.environment.registered_boundaries },
    subjects: [
      { key: subject.key, kind: semanticKind, identity: subject.name, support_key: null, required_states: states },
      ...auxiliaryEntities.map((entity) => ({
        key: entity.key,
        kind: entity.type === 'effect' ? 'effect' : entity.type === 'character' ? 'character' : 'prop',
        identity: entity.name,
        support_key: entity.key === blueprint.action_contract.object_key ? subject.key : null,
        required_states: entity.states,
      })),
    ],
    action_beats: [
      { key: 'primary_action', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: subject.key, action: blueprint.action_contract.primary_action },
      ...(actionObject ? [{ key: 'object_relation', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: actionObject.key, action: releaseRequested ? 'follow_and_release' : 'follow_subject' }] : []),
    ],
  };
  const assetType = subject.type === 'prop' ? 'prop-cutout' : subject.type === 'effect' ? 'effect-cutout' : 'character-cutout';
  const subjectFamily = {
    family_key: 'primary_subject_family', pattern: subject.type === 'effect' ? 'free' : 'supported-subject', registration_canvas: { width: 1920, height: 1080 },
    slots: states.map((state) => ({ slot_key: `subject_${state}`, asset_type: assetType, generation_purpose: `subject_state_${state}`, required_for_gate: state !== states[1] || subject.type !== 'effect', constraints: { transparent_background: true, subject_key: subject.key, state, identity: subject.name, fallback: subject.type === 'effect' ? 'procedural' : undefined, ...sourceConstraints(subject) } })),
    contract: { subject_key: subject.key, identity: subject.name, subject_slots: Object.fromEntries(states.map((state) => [state, `subject_${state}`])) },
  };
  const auxiliaryFamilies = auxiliaryEntities.map((entity, index) => {
    const familyKey = entity.key === 'prop_1' ? 'prop_family' : `${entity.key}_family`;
    const slotKey = entity.key === 'prop_1' ? 'prop_cutout' : `${entity.key}_cutout`;
    const assetType = entity.type === 'character' ? 'character-cutout' : entity.type === 'effect' ? 'effect-cutout' : 'prop-cutout';
    return {
      family_key: familyKey,
      pattern: entity.type === 'character' ? 'supported-subject' : 'free',
      registration_canvas: { width: 1920, height: 1080 },
      slots: [{
        slot_key: slotKey,
        asset_type: assetType,
        generation_purpose: entity.key === blueprint.action_contract.object_key ? 'independent_action_object' : 'independent_secondary_entity',
        required_for_gate: true,
        constraints: { transparent_background: true, single_subject: true, subject_key: entity.key, identity: entity.name, states: entity.states, ...sourceConstraints(entity) },
      }],
      contract: { subject_key: entity.key, identity: entity.name, subject_slots: { default: slotKey }, order: index },
    };
  });
  const families = [baseEnvironmentFamily(blueprint), subjectFamily, ...auxiliaryFamilies];
  const auxiliaryNodes = auxiliaryEntities.map((entity, index) => {
    const family = auxiliaryFamilies[index];
    const slot = family.slots[0].slot_key;
    const attached = entity.key === blueprint.action_contract.object_key;
    return node(
      entity.key,
      'asset',
      family.pattern,
      slot,
      { x: 0.5, y: 0.7, width: entity.type === 'character' ? 0.34 : 0.18, height: entity.type === 'character' ? 0.62 : 0.24, anchor_x: 0.5, anchor_y: entity.type === 'character' ? 0.88 : 0.5 },
      attached
        ? { family_key: family.family_key, predicate: 'held-by', object: subject.key, relation_schedule: { held_until: releaseRequested ? 'release_prop' : 'settle', then: releaseRequested ? 'released_beside' : 'held' } }
        : { family_key: family.family_key, role: entity.role },
      24 + index,
    );
  });
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0),
    ]),
    node(subject.key, 'asset', subjectFamily.pattern, `subject_${states[0]}`, { x: 0.5, y: 0.62, width: 0.42, height: 0.62, anchor_x: 0.5, anchor_y: 0.82 }, { family_key: subjectFamily.family_key, role: subject.role, state_slots: subjectFamily.contract.subject_slots }, 20),
    ...auxiliaryNodes,
  ]);
  const displacement = Math.abs(Number(end.x) - Number(start.x));
  const xValues = displacement >= 0.08 ? [Number(start.x), Number(end.x)] : [-0.06, 0.06];
  const translationThreshold = Math.min(2, Math.max(0.06, displacement * 0.8));
  const subjectMotionTracks = (() => {
    if (motionAction === 'state_transition') {
      return [
        { target: subject.key, property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: actionFrame, value: 0.09, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.12 }] },
        { target: subject.key, property: 'state', keyframes: [{ frame: 0, value: states[0] }, { frame: actionFrame, value: states[1] }, { frame: finalFrame, value: states[2] }] },
      ];
    }
    if (motionAction === 'generic_subject_action') {
      return [
        { target: subject.key, property: 'rotation', keyframes: [{ frame: 0, value: -4 }, { frame: actionFrame, value: 6, easing: 'ease-in-out' }, { frame: finalFrame, value: 0, easing: 'ease-out' }] },
        { target: subject.key, property: 'state', keyframes: [{ frame: 0, value: states[0] }, { frame: actionFrame, value: states[1] }, { frame: finalFrame, value: states[2] }] },
      ];
    }
    return [
      { target: subject.key, property: 'x', keyframes: [{ frame: 0, value: xValues[0] }, { frame: actionFrame, value: xValues[1], easing: 'ease-in-out' }, { frame: finalFrame, value: xValues[1] }] },
      { target: subject.key, property: 'state', keyframes: [{ frame: 0, value: states[0] }, { frame: actionFrame, value: states[1] }, { frame: finalFrame, value: states[2] }] },
    ];
  })();
  const objectStates = actionObject
    ? (actionObject.states.length >= 3 ? actionObject.states.slice(0, 3) : [actionObject.states[0] || 'held', releaseRequested ? 'carried' : 'active', releaseRequested ? 'released' : actionObject.states.at(-1) || 'settle'])
    : [];
  const objectTracks = actionObject ? [
    { target: actionObject.key, property: 'x', keyframes: [{ frame: 0, value: xValues[0] - 0.03 }, { frame: actionFrame, value: xValues[1] - 0.03, easing: 'ease-in-out' }, ...(releaseRequested ? [{ frame: releaseFrame, value: xValues[1] + 0.08, easing: 'ease-out' }] : []), { frame: finalFrame, value: releaseRequested ? xValues[1] + 0.08 : xValues[1] - 0.03 }] },
    { target: actionObject.key, property: 'state', keyframes: [{ frame: 0, value: objectStates[0] }, { frame: actionFrame, value: objectStates[1] }, ...(releaseRequested ? [{ frame: releaseFrame, value: objectStates[2] }] : []), { frame: finalFrame, value: objectStates[releaseRequested ? 2 : 1] }] },
    ...(releaseRequested ? [{ target: actionObject.key, property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: actionFrame, value: 0 }, { frame: releaseFrame, value: 0.12, easing: 'ease-in' }, { frame: finalFrame, value: 0.12 }] }] : []),
  ] : [];
  const contactCues = (blueprint.action_contract.contact_events || []).map((key) => ({
    key,
    frame: key === 'grip_prop' ? frameAt(durationFrames, 0.1) : key === 'release_prop' ? releaseFrame : actionFrame,
    kind: 'contact',
  }));
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: motionAction, camera_only: false,
    subject_tracks: [
      ...subjectMotionTracks,
      ...objectTracks,
    ],
    camera_tracks: [],
    cues: [{ key: 'action_peak', frame: actionFrame, kind: 'semantic' }, ...contactCues, { key: 'settle', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'subject_state_progression', metric: 'distinct_states', target: subject.key, property: 'state', min: 3 },
      ...(motionAction === 'state_transition'
        ? [{ key: 'posture_vertical_change', metric: 'numeric_range', target: subject.key, property: 'y', min: 0.08 }]
        : motionAction === 'generic_subject_action'
          ? [{ key: 'subject_action_range', metric: 'numeric_range', target: subject.key, property: 'rotation', min: 8 }]
          : [{ key: 'subject_translation', metric: 'numeric_range', target: subject.key, property: 'x', min: translationThreshold }]),
      ...(actionObject ? [{ key: 'action_object_follows_subject', metric: 'numeric_range', target: actionObject.key, property: 'x', min: translationThreshold }] : []),
      ...(actionObject && objectStates.length >= 3 ? [{ key: 'action_object_state_progression', metric: 'distinct_states', target: actionObject.key, property: 'state', min: releaseRequested ? 3 : 2 }] : []),
      ...(releaseRequested ? [{ key: 'release_cue_exists', metric: 'cue_exists', cue: 'release_prop' }] : []),
    ],
  };
  const actionAssertion = motionAction === 'state_transition'
    ? { type: 'track_range', target: subject.key, property: 'y', min: 0.08 }
    : motionAction === 'generic_subject_action'
      ? { type: 'track_range', target: subject.key, property: 'rotation', min: 8 }
      : { type: 'track_range', target: subject.key, property: 'x', min: translationThreshold };
  const proofTargets = [
    { key: 'subject_start', frame: 0, target_node_key: subject.key, assertions: [{ type: 'state_equals', target: subject.key, value: states[0] }, ...(actionObject ? [{ type: 'relation_exists', node: actionObject.key, predicate: 'held-by' }] : [])] },
    { key: 'subject_action', frame: actionFrame, target_node_key: subject.key, assertions: [actionAssertion, ...(actionObject ? [{ type: 'track_range', target: actionObject.key, property: 'x', min: translationThreshold }] : [])] },
    { key: 'subject_final', frame: finalFrame, target_node_key: subject.key, assertions: [{ type: 'state_equals', target: subject.key, value: states[2] }, ...(actionObject ? [{ type: 'state_equals', target: actionObject.key, value: objectStates[releaseRequested ? 2 : 1] }] : []), { type: 'camera_only', expected: false }] },
  ];
  return {
    catalog_key: `blueprint-${blueprint.action_contract.primary_action}-v1`, semanticContract, families, root, motionPlan, proofTargets,
    summary: {
      catalog_key: `blueprint-${blueprint.action_contract.primary_action}-v1`, primary_action: blueprint.action_contract.primary_action,
      camera_only: false, clean_plate_required: true, source_family_count: families.length,
      required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
      entity_keys: blueprint.entities.map((entity) => entity.key),
      required_states: auxiliaryEntities.length ? Object.fromEntries([[subject.key, states], ...auxiliaryEntities.map((entity) => [entity.key, entity.states])]) : states,
      relation_contracts: blueprint.relations.map((relation) => `${relation.subject_key}:${relation.predicate}:${relation.object_key}`),
      proof_targets: proofTargets,
    },
  };
}

function compile(blueprint, context = {}, config = {}) {
  schemaService.assertValid('paperBlueprint', blueprint, '生产蓝图不符合 Schema');
  const entityKeys = new Set(blueprint.entities.map((entity) => entity.key));
  const duplicateKeys = blueprint.entities.length !== entityKeys.size;
  const invalidRelations = blueprint.relations.filter((relation) => !entityKeys.has(relation.subject_key) || !entityKeys.has(relation.object_key));
  const contract = blueprint.action_contract;
  const invalidContractKeys = [contract.actor_key, contract.object_key, contract.support_key].filter((key) => key != null && !entityKeys.has(key));
  const phaseKeys = new Set(contract.phases.map((item) => item.key));
  const invalidPhaseRelations = blueprint.relations.filter((relation) => !phaseKeys.has(relation.start_phase) || !phaseKeys.has(relation.end_phase));
  if (duplicateKeys || invalidRelations.length || invalidContractKeys.length || invalidPhaseRelations.length) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_RELATION_INVALID', '蓝图中的实体或关系引用无效', {
      duplicate_entity_keys: duplicateKeys,
      invalid_relations: invalidRelations.map((relation) => relation.key),
      invalid_contract_keys: invalidContractKeys,
      invalid_phase_relations: invalidPhaseRelations.map((relation) => ({
        key: relation.key,
        start_phase: relation.start_phase,
        end_phase: relation.end_phase,
      })),
    }, 422);
  }
  return contract.primary_action === 'carry_move_sit'
    ? compoundPlan(blueprint, context, config)
    : genericPlan(blueprint, context, config);
}

function slotReason(slot, family) {
  if (slot.slot_key === 'clean_plate') return '提供不含可动主体的干净背景';
  if (slot.asset_type === 'occlusion-mask') return '在动作阶段恢复正确的前后遮挡关系';
  if (/character/.test(slot.asset_type)) return `角色动作状态：${slot.constraints?.state || slot.slot_key}`;
  if (/prop/.test(slot.asset_type)) return '道具必须作为独立纸片层跟随、释放或单独调整';
  if (/effect/.test(slot.asset_type)) return '环境或动作效果独立层';
  return `${family.family_key} 的正式素材`;
}

function slotSource(slot) {
  if (slot.asset_type === 'occlusion-mask' || slot.constraints?.derivation) return 'local_derivation';
  if (slot.constraints?.source_paper_entity_id) return 'existing_asset';
  if (slot.constraints?.source_prop_id || slot.constraints?.source_character_id || slot.constraints?.source_character_library_id) return 'existing_asset';
  if (slot.constraints?.fallback === 'procedural' && slot.required_for_gate === false) return 'procedural';
  return 'image_api';
}

function withGenerationSlots(blueprint, plan) {
  return {
    ...blueprint,
    generation_slots: plan.families.flatMap((family) => family.slots.map((slot) => ({
      family_key: family.family_key,
      slot_key: slot.slot_key,
      asset_type: slot.asset_type,
      reason: slotReason(slot, family),
      required: slot.required_for_gate !== false,
      source: slotSource(slot),
    }))),
  };
}

module.exports = { infer, compile, withGenerationSlots };
