const schemaService = require('./paperStudioSchemaService');
const spatialContractService = require('./paperSpatialContractService');
const visualSceneCompiler = require('./paperVisualSceneCompilerService');
const transitionGateService = require('./paperTransitionGateService');
const mobilityContractService = require('./paperMobilityContractService');
const { CURRENT_PLANNER_VERSION } = require('./paperStudioPlannerVersion');
const { PaperStudioError } = require('./paperStudioUtils');

const ACTOR_WORDS = [
  '人物', '角色', '主角', '男孩', '女孩', '男人', '女人', '老人', '少年', '少女',
  '士兵', '士卒', '将军', '侍卫', '店员', '顾客', '旅客', '司机', '孩子', '他', '她',
];
const PROP_WORDS = [
  '行李箱', '手提箱', '箱子', '背包', '雨伞', '书包', '书本', '杯子', '篮子',
  '物资袋', '马车', '车辆', '运输队', '包裹', '工具', '木箱',
  '手推车', '独轮车', '板车', '搬运车', '运输车', '汽车', '卡车', '货车', '摩托车',
  '自行车', '大型器械', '多人操作平台', '轿子', '担架', '手机', '信件', '道具',
];
const SUPPORT_WORDS = [
  '长椅', '椅子', '沙发', '床边', '床', '台阶', '凳子', '座位', '桌旁', '桌子',
  '门口', '站台', '岸边', '窗边',
];
const PATH_REVEAL_PATTERN = /(?:地图|平面图|示意图|流程图|线路图|管线图).{0,100}(?:路线|路径|线路|轨迹|流程线|管线|箭头|连线|标记).{0,100}(?:亮起|推进|延伸|展开|显现|到达|连接|合拢|闭合|包围)|(?:路线|路径|线路|轨迹|流程线|管线).{0,80}(?:推进|延伸|展开|显现|到达|连接|合拢|闭合)/i;
const MULTI_BEAT_GROUNDED_PATTERN = /(?:滑落|掉落|落地|坠落)[\s\S]{0,160}(?:前行|驶入|移动|推进|穿过|进入)[\s\S]{0,160}(?:逼近|合拢|收紧|靠近|聚拢)/i;
const GROUND_VEHICLE_PATTERN = mobilityContractService.GROUND_MOBILITY_PATTERN;

function frameAt(durationFrames, ratio) {
  return Math.max(0, Math.min(durationFrames - 1, Math.round((durationFrames - 1) * ratio)));
}

function captionFrame(captions, matcher, edge, fallback, durationFrames) {
  const patterns = (Array.isArray(matcher) ? matcher : [matcher]).filter(Boolean).map((value) => (
    value instanceof RegExp ? value : new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  ));
  let caption = null;
  for (const pattern of patterns) {
    caption = (captions || []).find((item) => pattern.test(String(item.text || ''))) || null;
    if (caption) break;
  }
  const raw = caption ? Number(edge === 'end' ? caption.end_frame : caption.start_frame) : Number(fallback);
  return Math.max(0, Math.min(durationFrames - 1, Math.round(raw)));
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

function escapedPattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceMentionedAsActor(text, source) {
  const name = String(source?.name || '').trim();
  if (!name) return false;
  const escaped = escapedPattern(name);
  const organizationOnly = new RegExp(`${escaped}(?:军|部|所部|麾下|军队|阵营|的军队|的部队)`).test(text)
    && !new RegExp(`${escaped}.{0,10}(?:下令|命令|走|跑|坐|站|举|挥|看|说|进入|离开|被俘|战死)`).test(text);
  if (organizationOnly) return false;
  return new RegExp(`(?:^|[，。；、\\s])${escaped}(?=$|[，。；、\\s]|(?:下令|命令|走|跑|坐|站|举|挥|看|说|进入|离开|被俘|战死))`).test(text)
    || new RegExp(`${escaped}.{0,10}(?:下令|命令|走|跑|坐|站|举|挥|看|说|进入|离开|被俘|战死)`).test(text);
}

function sourceMentionedAsProp(text, source) {
  const name = String(source?.name || '').trim();
  if (!name) return false;
  if (text.includes(name)) return true;
  const shortened = name.replace(/^(?:一辆|一队|一箱|一捆|一名|一位)/, '');
  return shortened.length >= 2 && text.includes(shortened);
}

function inferActorName(text, context) {
  const explicitSource = (context.characters || []).find((source) => sourceMentionedAsActor(text, source));
  if (explicitSource?.name) return explicitSource.name;
  const dictionary = firstMatch(text, ACTOR_WORDS);
  if (dictionary) return dictionary;
  const prefix = text.match(/(?:^|[，。；])([^，。；]{1,12}?)(?=提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着|走向|走到|走|跑向|跑到|跑|坐下|落座|进入|离开)/);
  const captured = cleanCapturedName(prefix?.[1] || '');
  if (captured && !/(镜头|画面|背景|场景|室内|室外)/.test(captured)) return captured;
  return context.characters?.[0]?.name || '人物';
}

function inferPropName(text, context) {
  const source = (context.props || []).find((candidate) => sourceMentionedAsProp(text, candidate));
  if (source?.name) return source.name;
  const carried = text.match(/(?:提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着)([^，。；]{1,10}?)(?=从|向|往|走|跑|来到|到达|并|后|，|。|；|$)/);
  const captured = cleanCapturedName(carried?.[1] || '');
  const groundVehicle = text.match(/(?:^|[，。；\s])(?:近景中)?(?:一辆|一队|一组)?([\p{Script=Han}]{1,8}?车(?:队)?)(?=从|沿|向|往|驶|前行|行进|移动|推进|穿过|进入|离开|运送|运输|开往)/u);
  return captured || groundVehicle?.[1] || firstMatch(text, PROP_WORDS) || context.props?.[0]?.name || '';
}

function matchingActorSource(text, context, actorName) {
  return (context.characters || []).find((source) => source.name === actorName && sourceMentionedAsActor(text, source)) || null;
}

function matchingPropSource(text, context, propName) {
  return (context.props || []).find((source) => source.name === propName && sourceMentionedAsProp(text, source)) || null;
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

function quotedTitleForCharacter(text, name) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return String(name || '人物');
  const match = String(text || '').match(new RegExp(`${escaped}[^“”\"]{0,48}[“\"]([^”\"]+)[”\"]`));
  return match?.[1]?.trim() || String(name);
}

function cleanRouteLabel(value, fallback) {
  const label = String(value || '')
    .replace(/^(?:地图上|平面图上|示意图上|路线|路径|包裹|车辆|人物|由|从|向|到)+/, '')
    .replace(/(?:路线|路径|线路|轨迹|推进|延伸|展开|显现|到达|连接|合拢|逐步|最终)+$/g, '')
    .trim();
  return label.slice(0, 16) || fallback;
}

function inferRouteWaypoints(text) {
  const between = String(text || '').match(/(?:从|由)([^，。；]{1,16}?)(?:向|到|至|通往|延伸到)([^，。；]{1,16}?)(?=推进|延伸|展开|显现|到达|连接|合拢|，|。|；|$)/);
  const destination = String(text || '').match(/(?:在|到达|连接到|延伸到)([^，。；]{1,16}?)(?=合拢|停止|完成|，|。|；|$)/);
  const start = cleanRouteLabel(between?.[1], '起点');
  const end = cleanRouteLabel(destination?.[1] || between?.[2], '终点');
  return [
    { key: 'path_start', label: start, x: -0.32, y: 0.24 },
    { key: 'path_mid', label: '中间节点', x: 0, y: 0 },
    { key: 'path_end', label: end, x: 0.3, y: -0.18 },
  ];
}

function defaultPlacementRegions({ protectRight = false } = {}) {
  return [
    {
      key: 'foreground_ground', kind: 'walkable',
      polygon: [[0.06, 0.7], [protectRight ? 0.68 : 0.94, 0.7], [protectRight ? 0.68 : 0.94, 0.94], [0.06, 0.94]],
      ground_y: 0.82,
    },
    ...(protectRight ? [{
      key: 'right_forbidden', kind: 'forbidden',
      polygon: [[0.68, 0.48], [1, 0.48], [1, 1], [0.68, 1]],
    }] : []),
  ];
}

function placementAttributes({ regionKey = 'foreground_ground', contactKind = 'base', lock = true } = {}) {
  return {
    support_kind: 'ground', region_key: regionKey, contact_kind: contactKind, contact_lock: lock,
  };
}

function finalizeBlueprint(blueprint, context, validationMessage) {
  mobilityContractService.annotateBlueprint(blueprint, context);
  schemaService.assertValid('paperBlueprint', blueprint, validationMessage);
  return blueprint;
}

function pathRevealBlueprint(context, storyboard, text) {
  const markers = (context.characters || []).slice(0, 4).map((source, index) => sourceIdentity({
    key: `path_subject_${index + 1}`,
    type: 'character',
    name: source.name || `主体${index + 1}`,
    role: 'path_subject_marker',
    independent_layer: true,
    reusable: true,
    identity_version_id: null,
    source_library_type: null,
    source_library_id: null,
    states: ['path_marker'],
    attributes: { inferred_from: 'path_storyboard_entity_links', title_card: quotedTitleForCharacter(text, source.name), reveal_order: index },
  }, source));
  const waypoints = inferRouteWaypoints(text);
  return finalizeBlueprint({
    schema_version: 1,
    environment: {
      description: [storyboard.title, storyboard.description, storyboard.action].filter(Boolean).join('；') || '俯视平面信息图',
      clean_plate_required: true,
      camera_intent: storyboard.camera_motion || 'static',
      registered_boundaries: [],
    },
    entities: [{
      key: 'path_subject', type: 'effect', name: '逐步揭示的路径', role: 'path_reveal',
      independent_layer: false, reusable: false, states: ['hidden', 'revealing', 'complete'], attributes: { procedural: true },
    }, ...markers],
    relations: [],
    action_contract: {
      primary_action: 'path_reveal', actor_key: 'path_subject', object_key: null, support_key: null,
      direction: 'forward', start_state: 'hidden', end_state: 'complete', waypoints,
      phases: [
        phase('hidden', '底图静置', 0, 0.12, 'hidden'),
        phase('reveal', '路径逐步揭示', 0.12, 0.72, 'revealing'),
        phase('complete', '终点与关联主体显现', 0.72, 1, 'complete'),
      ],
      contact_events: [], occlusion_events: [],
    },
    generation_slots: [],
  }, context, '路径揭示生产蓝图无效');
}

function sequenceSubjectName(text, matcher, fallback) {
  const match = String(text || '').match(matcher);
  const value = String(match?.[1] || '')
    .split(/[，。；]/).at(-1)
    .replace(/^(?:一个|一只|一辆|一队|一名|一位|随后|接着|同时|远处|近处|画面中)+/, '')
    .trim();
  return value.slice(-12) || fallback;
}

function multiBeatGroundedSequenceBlueprint(context, storyboard, text) {
  const transportSource = (context.props || []).find((source) => (
    GROUND_VEHICLE_PATTERN.test(String(source.name || '')) && sourceMentionedAsProp(text, source)
  )) || null;
  const fallingName = sequenceSubjectName(text, /([^，。；]{1,18}?)(?=(?:从[^，。；]{0,16})?(?:滑落|掉落|落地|坠落))/, '落地主体');
  const transportName = transportSource?.name || sequenceSubjectName(
    text,
    /([^，。；]{1,18}?)(?=(?:沿[^，。；]{0,12})?(?:前行|驶入|移动|推进|穿过|进入))/,
    '接地移动主体',
  );
  const fallingSource = (context.props || []).find((source) => String(source.name || '') === fallingName) || null;
  const captions = [...(storyboard.audio_captions || [])].sort((left, right) => Number(left.start_frame || 0) - Number(right.start_frame || 0));
  const segments = String(text || '').split(/[。；]/).map((item) => item.trim()).filter(Boolean);
  const firstDescription = segments[0] || storyboard.description || storyboard.title || '第一动作区域';
  const followupDescription = segments.slice(1).join('；') || storyboard.action || storyboard.description || '后续动作区域';
  const entities = [
    sourceIdentity({
      key: 'ground_subject_1', type: 'prop', name: fallingName, role: 'ground_prop', independent_layer: true,
      reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
      states: ['suspended', 'falling', 'grounded'],
      attributes: { inferred_from: 'storyboard_text', source_evidence: firstDescription, placement: { ...placementAttributes({ contactKind: 'base' }), grounded_states: ['grounded'] } },
    }, fallingSource),
    sourceIdentity({
      key: 'ground_transport_1', type: 'prop', name: transportName, role: 'ground_vehicle', independent_layer: true,
      reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
      states: ['approach', 'moving', 'arrived'],
      attributes: { inferred_from: 'storyboard_text', source_evidence: followupDescription, placement: placementAttributes({ contactKind: 'wheels' }) },
    }, transportSource),
    {
      key: 'ground_effect_1', type: 'effect', name: '后续空间变化', role: 'grounded_crowd_effect',
      independent_layer: true, reusable: false, states: ['hidden', 'changing', 'settled'],
      attributes: { procedural: true, source_evidence: segments.at(-1) || followupDescription },
    },
  ];
  return finalizeBlueprint({
    schema_version: 1,
    environment: {
      description: firstDescription,
      clean_plate_required: true,
      camera_intent: storyboard.camera_motion || 'static',
      registered_boundaries: [],
      placement_regions: defaultPlacementRegions({ protectRight: true }),
    },
    entities,
    relations: [],
    visual_scenes: [
      {
        key: 'scene_primary', label: '第一动作区域', description: firstDescription, location: '第一动作区域',
        time_context: 'continuous', camera_signature: '近景低机位', environment_family_key: 'primary_environment',
        subject_keys: ['ground_subject_1'], source_caption_keys: captions[0]?.key ? [String(captions[0].key)] : [], confidence: 0.9,
        placement_regions: defaultPlacementRegions({ protectRight: true }),
      },
      {
        key: 'scene_followup', label: '后续动作区域', description: followupDescription, location: '后续动作区域',
        time_context: 'continuous', camera_signature: '中远景平视', environment_family_key: 'followup_environment',
        subject_keys: ['ground_transport_1', 'ground_effect_1'], source_caption_keys: captions[1]?.key ? [String(captions[1].key)] : [], confidence: 0.9,
        placement_regions: defaultPlacementRegions({ protectRight: true }),
      },
    ],
    transition_contracts: [{
      key: 'primary_to_followup', from_scene_key: 'scene_primary', to_scene_key: 'scene_followup',
      relation: 'location_change', kind: 'dust_whip_pan', duration_seconds: 0.6, direction: 'left',
      requires_new_plate: true, hard_cut_allowed: false, hard_cut_reason: null,
      source_caption_key: captions[1]?.key ? String(captions[1].key) : null, confidence: 0.9,
    }],
    action_contract: {
      primary_action: 'multi_beat_grounded_sequence', actor_key: 'ground_subject_1', object_key: 'ground_transport_1', support_key: null,
      direction: 'left_to_right', start_state: 'suspended', end_state: 'settled',
      waypoints: [
        { key: 'ground_contact', label: '落地点', x: -0.14, y: 0, region_key: 'foreground_ground' },
        { key: 'transport_lane', label: '接地移动通道', x: 0.05, y: 0, region_key: 'foreground_ground' },
        { key: 'depth_change', label: '后续空间变化区', x: 0.08, y: -0.2, region_key: 'foreground_ground' },
      ],
      phases: [
        phase('ground_contact', '主体落地', 0, 0.32, 'falling'),
        phase('ground_move', '接地主体前行', 0.32, 0.7, 'grounded', 'moving'),
        phase('depth_change', '后续空间变化', 0.7, 1, 'grounded', 'arrived'),
      ],
      contact_events: ['subject_contacts_ground'], occlusion_events: [],
    },
    generation_slots: [],
  }, context, '多节拍接地序列生产蓝图无效');
}

function infer(context = {}) {
  const storyboard = context.storyboard || {};
  const text = [storyboard.title, storyboard.description, storyboard.action, storyboard.dialogue, storyboard.narration]
    .filter(Boolean)
    .join('，');
  const environmentDescription = context.scene?.prompt || storyboard.location || storyboard.description || storyboard.title || '分镜干净背景';
  const environmentOnly = Boolean(storyboard.environment_only);
  if (PATH_REVEAL_PATTERN.test(text)) return pathRevealBlueprint(context, storyboard, text);
  if (MULTI_BEAT_GROUNDED_PATTERN.test(text)) return multiBeatGroundedSequenceBlueprint(context, storyboard, text);
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
    return finalizeBlueprint(blueprint, context, '环境镜头生产蓝图无效');
  }

  const actorName = inferActorName(text, context);
  const propName = inferPropName(text, context);
  const actorSource = matchingActorSource(text, context, actorName);
  const propSource = matchingPropSource(text, context, propName);
  const supportName = inferSupportName(text);
  const propIsGroundVehicle = Boolean(propName) && GROUND_VEHICLE_PATTERN.test(propName);
  const explicitVehicleOperator = propIsGroundVehicle
    && /(推着|推动|推行|拉着|拖着|牵着|驾驶|驾着|骑着|抬着|操作)/.test(text);
  const hasCarry = Boolean(propName) && !propIsGroundVehicle && /提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着/.test(text);
  const hasMove = /走|跑|移动|来到|到达|靠近|穿过|掠过|飞过|飞向|落在|进入|离开|前行|驶向|驶入|驶出|行进|推进|开往/.test(text);
  const hasSit = /坐下|落座|坐到|坐在/.test(text);
  const hasRelease = Boolean(propName) && /放下|放到|放在|松开|卸下|搁下|丢下/.test(text);
  const direction = inferDirection(text);
  const primaryAction = propIsGroundVehicle && hasMove
    ? 'transport_move'
    : hasCarry && hasMove && hasSit
    ? 'carry_move_sit'
    : hasMove
      ? 'directed_move'
      : hasSit
        ? 'state_transition'
        : 'generic_subject_action';
  const actorStates = primaryAction === 'transport_move'
    ? (explicitVehicleOperator ? ['engage', 'moving', 'arrived'] : ['watching', 'observing', 'settle'])
    : primaryAction === 'carry_move_sit'
    ? ['standing_holding', 'walking_holding', 'seated']
    : primaryAction === 'directed_move'
      ? ['start', 'moving', 'arrived']
      : primaryAction === 'state_transition'
        ? ['standing', 'transitioning', 'seated']
        : ['start', 'action', 'settle'];
  const entities = [sourceIdentity({
    key: 'actor_1', type: 'character', name: actorName, role: 'actor', independent_layer: true,
    reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: actorStates, attributes: {
      inferred_from: 'storyboard_text',
      source_evidence: actorSource?.name || actorName,
      ...(!hasSit ? { placement: placementAttributes({ contactKind: 'feet' }) } : {}),
    },
  }, actorSource)];
  if (propName) entities.push(sourceIdentity({
    key: 'prop_1', type: 'prop', name: propName,
    role: hasCarry ? 'carried_object' : propIsGroundVehicle ? 'ground_vehicle' : 'prop', independent_layer: true,
    reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: hasCarry ? ['held', 'carried', 'released'] : propIsGroundVehicle && hasMove ? ['approach', 'moving', 'arrived'] : ['stable'], attributes: {
      inferred_from: 'storyboard_text',
      source_evidence: propSource?.name || propName,
      ...(!hasCarry ? { placement: placementAttributes({ contactKind: propIsGroundVehicle ? 'wheels' : 'base' }) } : {}),
    },
  }, propSource));
  if (supportName) entities.push({
    key: 'support_1', type: 'environment_anchor', name: supportName, role: hasSit ? 'destination_support' : 'destination_anchor',
    independent_layer: false, reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: ['registered'], attributes: { included_in_clean_plate: true },
  });

  const propKey = propName ? 'prop_1' : null;
  const actionActorKey = primaryAction === 'transport_move' ? propKey : 'actor_1';
  const actionObjectKey = primaryAction === 'transport_move'
    ? (explicitVehicleOperator ? 'actor_1' : null)
    : propKey;
  const supportKey = supportName ? 'support_1' : null;
  const relations = [];
  if (primaryAction === 'transport_move' && explicitVehicleOperator) {
    relations.push({ key: 'operator_moves_transport', subject_key: 'actor_1', predicate: 'interacts_with', object_key: propKey, start_phase: 'engage', end_phase: 'arrive', attributes: { mobility_relation: 'power_source', synchronized: true } });
  }
  if (propKey && hasCarry) {
    relations.push({ key: 'actor_holds_prop', subject_key: 'actor_1', predicate: 'holds', object_key: propKey, start_phase: primaryAction === 'carry_move_sit' ? 'lift' : 'start', end_phase: 'arrive', attributes: { attachment: 'hand' } });
    relations.push({ key: 'prop_follows_actor', subject_key: propKey, predicate: 'follows', object_key: 'actor_1', start_phase: 'move', end_phase: 'arrive', attributes: { synchronized: true } });
    if (hasRelease && !supportKey) relations.push({ key: 'prop_released_at_destination', subject_key: propKey, predicate: 'released_beside', object_key: 'actor_1', start_phase: 'arrive', end_phase: 'arrive', attributes: { destination_waypoint: 'destination' } });
  }
  if (supportKey) relations.push({ key: 'actor_moves_to_support', subject_key: 'actor_1', predicate: 'moves_to', object_key: supportKey, start_phase: 'move', end_phase: 'arrive', attributes: {} });
  if (supportKey && hasSit) {
    relations.push({ key: 'actor_sits_on_support', subject_key: 'actor_1', predicate: 'sits_on', object_key: supportKey, start_phase: 'sit', end_phase: 'settle', attributes: {} });
    relations.push({ key: 'actor_occluded_by_support', subject_key: 'actor_1', predicate: 'occluded_by', object_key: supportKey, start_phase: 'sit', end_phase: 'settle', attributes: { part: 'lower_body' } });
  }
  if (propKey && supportKey && primaryAction === 'carry_move_sit') relations.push({ key: 'prop_released_beside_support', subject_key: propKey, predicate: 'released_beside', object_key: supportKey, start_phase: 'release', end_phase: 'settle', attributes: {} });

  let phases;
  if (primaryAction === 'transport_move') {
    phases = [
      phase('engage', explicitVehicleOperator ? '动力角色接触运输工具' : '运输单位入场', 0, 0.15, 'approach', explicitVehicleOperator ? 'engage' : null),
      phase('move', '运输单位持续前行', 0.15, 0.82, 'moving', explicitVehicleOperator ? 'moving' : null),
      phase('arrive', '运输单位到达并稳定', 0.82, 1, 'arrived', explicitVehicleOperator ? 'arrived' : null),
    ];
  } else if (primaryAction === 'carry_move_sit') {
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
      placement_regions: defaultPlacementRegions(),
    },
    entities,
    relations,
    action_contract: {
      primary_action: primaryAction,
      actor_key: actionActorKey, object_key: actionObjectKey, support_key: primaryAction === 'transport_move' ? null : supportKey, direction,
      start_state: primaryAction === 'transport_move' ? 'approach' : actorStates[0], end_state: primaryAction === 'transport_move' ? 'arrived' : actorStates[actorStates.length - 1],
      waypoints: [
        { key: 'start', label: direction === 'right_to_left' ? '画面右侧' : '画面左侧', x: startX, y: 0 },
        { key: supportKey ? 'support' : 'destination', label: supportName || '目标位置', x: endX, y: 0 },
      ],
      phases,
      contact_events: [
        ...(primaryAction === 'transport_move' && explicitVehicleOperator ? ['operator_contacts_vehicle'] : []),
        ...(propKey && hasCarry ? ['grip_prop'] : []),
        ...(supportKey ? ['reach_support'] : []),
        ...(supportKey && hasSit ? ['sit_on_support'] : []),
        ...(propKey && (primaryAction === 'carry_move_sit' || hasRelease) ? ['release_prop'] : []),
      ],
      occlusion_events: supportKey && hasSit ? ['lower_body_behind_support_front'] : [],
    },
    generation_slots: [],
  };
  return finalizeBlueprint(blueprint, context, '自然语言生产蓝图无效');
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

function transportUnitLayouts(count) {
  if (count <= 1) return [{ x: 0.5, y: 0.5, width: 0.24, height: 0.3 }];
  if (count === 2) return [
    { x: 0.43, y: 0.515, width: 0.22, height: 0.29 },
    { x: 0.57, y: 0.48, width: 0.18, height: 0.25 },
  ];
  return [
    { x: 0.4, y: 0.525, width: 0.22, height: 0.29 },
    { x: 0.5, y: 0.49, width: 0.18, height: 0.25 },
    { x: 0.58, y: 0.465, width: 0.15, height: 0.22 },
  ];
}

function transportFamily(entity, contract, { familyKey, slotKey }) {
  return {
    family_key: familyKey,
    pattern: 'free',
    registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: slotKey,
      asset_type: 'transport-prop-cutout',
      generation_purpose: 'complete_powered_transport_unit',
      required_for_gate: true,
      constraints: {
        transparent_background: true,
        single_subject: false,
        composite_subject: true,
        ensemble_kind: 'transport_unit',
        subject_key: entity.key,
        identity: entity.name,
        vehicle_identity: entity.name,
        propulsion_mode: contract.propulsion_mode,
        allow_self_motion: contract.allow_self_motion,
        required_movers: contract.required_movers,
        operator_entity_key: contract.operator_entity_key,
        contact_kind: 'wheels',
        allow_source_import: false,
        review_checks: ['required_movers_visible', 'physical_contact_visible', 'no_unmanned_motion'],
      },
    }],
    contract: {
      subject_key: entity.key,
      identity: entity.name,
      mobility_contract: contract,
      subject_slots: { default: slotKey },
    },
  };
}

function transportGroupNode(entity, family, contract, { groundY = 0.82, localZ = 22 } = {}) {
  const slot = family.slots[0].slot_key;
  const unitCount = Math.max(1, Math.min(3, Number(contract.unit_count?.target_visible || 1)));
  const layouts = transportUnitLayouts(unitCount);
  const children = layouts.map((layout, index) => node(
    `${entity.key}__unit_${index + 1}`,
    'asset',
    'free',
    slot,
    { ...layout, anchor_x: 0.5, anchor_y: 0.92 },
    {
      family_key: family.family_key,
      role: 'transport_unit',
      subject_key: entity.key,
      propulsion_mode: contract.propulsion_mode,
      embedded_movers: contract.required_movers,
      composite_members: ['vehicle', ...contract.required_movers.map((item) => item.role)],
      unit_index: index + 1,
    },
    localZ + layouts.length - index,
  ));
  return node(
    entity.key,
    'group',
    'free',
    null,
    { x: 0.5, y: groundY, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
    {
      role: 'ground_vehicle',
      mobility_contract: contract,
      placement: entity.attributes?.placement || placementAttributes({ contactKind: 'wheels' }),
      contact_anchor: { x: 0.5, y: 0.5, derived_from: 'transport_group' },
    },
    localZ,
    children,
  );
}

function baseEnvironmentFamily(blueprint, { includeSupportMask = false, reuseStoryboardReference = false } = {}) {
  return {
    family_key: 'clean_environment', pattern: 'registered-environment', registration_canvas: { width: 1920, height: 1080 },
    slots: [
      { slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true, constraints: { no_primary_subjects: true, same_canvas: true, aspect_ratio: '16:9', environment_description: blueprint.environment.description, ...(reuseStoryboardReference ? { source_storyboard_reference: true } : {}) } },
      ...(includeSupportMask ? [{ slot_key: 'support_front_mask', asset_type: 'occlusion-mask', generation_purpose: 'support_front_occlusion', required_for_gate: true, constraints: { derivation: 'registered_procedural_mask', boundary: 'support_front', fill_direction: 'support_front', subject_key: blueprint.action_contract.support_key } }] : []),
    ],
    contract: {
      boundaries: blueprint.environment.registered_boundaries || [], origin: [0, 0],
      description: blueprint.environment.description,
      placement_regions: blueprint.environment.placement_regions || [],
    },
  };
}

function environmentPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const subject = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key)
    || blueprint.entities[0];
  if (!subject) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_ENVIRONMENT_ENTITY_MISSING', '纯环境镜头缺少环境动态实体', null, 422);
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 3, Math.round(Number(storyboard.duration || 5) * fps));
  const peakFrame = frameAt(durationFrames, 0.58);
  const finalFrame = durationFrames - 1;
  const states = subject.states.length >= 3 ? subject.states.slice(0, 3) : ['quiet', 'drift', 'settle'];
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: {
      description: blueprint.environment.description,
      clean_plate_required: true,
      registered_boundaries: blueprint.environment.registered_boundaries || [],
    },
    subjects: [{
      key: subject.key,
      kind: 'effect',
      identity: subject.name,
      support_key: null,
      required_states: states,
    }],
    action_beats: [{
      key: 'environment_reveal', start_frame: 0, peak_frame: peakFrame, end_frame: finalFrame,
      subject_key: subject.key, action: 'reveal_depth_through_atmosphere',
    }],
  };
  const families = [baseEnvironmentFamily(blueprint, { reuseStoryboardReference: true })];
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    node(subject.key, 'procedural', 'free', null, { x: 0.5, y: 0.48, width: 1.2, height: 0.78, anchor_x: 0.5, anchor_y: 0.5 }, {
      procedural_kind: 'atmosphere-drift', appearance: 'mist', role: 'environment-motion',
    }, 20),
    node('ambient_flow', 'procedural', 'free', null, { x: 0.5, y: 0.69, width: 1.1, height: 0.48, anchor_x: 0.5, anchor_y: 0.5 }, {
      procedural_kind: 'ambient-flow', appearance: 'contextual', role: 'environment-motion',
    }, 21),
  ]);
  const motionPlan = {
    schema_version: 1,
    fps,
    duration_frames: durationFrames,
    primary_action: 'environmental_depth_motion',
    camera_only: false,
    subject_tracks: [
      { target: subject.key, property: 'x', keyframes: [{ frame: 0, value: -0.08 }, { frame: peakFrame, value: 0.045, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.075, easing: 'ease-out' }] },
      { target: subject.key, property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.18 }, { frame: peakFrame, value: 0.82, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.46, easing: 'ease-out' }] },
      { target: 'ambient_flow', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.12 }, { frame: peakFrame, value: 0.72, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.38, easing: 'ease-out' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'y', keyframes: [{ frame: 0, value: -0.018 }, { frame: finalFrame, value: 0.018, easing: 'ease-in-out' }] }],
    cues: [{ key: 'atmosphere_peak', frame: peakFrame, kind: 'semantic' }, { key: 'environment_settle', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'mist_translation', metric: 'numeric_range', target: subject.key, property: 'x', min: 0.12 },
      { key: 'mist_density_change', metric: 'numeric_range', target: subject.key, property: 'procedural_amount', min: 0.5 },
      { key: 'ambient_flow_change', metric: 'numeric_range', target: 'ambient_flow', property: 'procedural_amount', min: 0.45 },
      { key: 'atmosphere_peak_cue', metric: 'cue_exists', cue: 'atmosphere_peak' },
    ],
  };
  const proofTargets = [
    { key: 'environment_start', frame: 0, target_node_key: subject.key, assertions: [{ type: 'camera_only', expected: false }] },
    { key: 'environment_peak', frame: peakFrame, target_node_key: subject.key, assertions: [{ type: 'track_range', target: subject.key, property: 'procedural_amount', min: 0.5 }, { type: 'track_range', target: subject.key, property: 'x', min: 0.12 }] },
    { key: 'environment_final', frame: finalFrame, target_node_key: 'ambient_flow', assertions: [{ type: 'track_range', target: 'ambient_flow', property: 'procedural_amount', min: 0.45 }] },
  ];
  return {
    catalog_key: 'blueprint-environmental-depth-motion-v2',
    semanticContract,
    families,
    root,
    motionPlan,
    proofTargets,
    summary: {
      catalog_key: 'blueprint-environmental-depth-motion-v2',
      primary_action: 'environmental_depth_motion',
      camera_only: false,
      environment_only: true,
      clean_plate_required: true,
      source_family_count: 1,
      required_asset_count: 1,
      entity_keys: [subject.key],
      required_states: { [subject.key]: states },
      relation_contracts: ['procedural atmosphere over clean environment'],
      proof_targets: proofTargets,
    },
  };
}

function transportPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const vehicle = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key && entity.role === 'ground_vehicle');
  if (!vehicle) {
    throw new PaperStudioError('PAPER_STUDIO_TRANSPORT_ENTITY_MISSING', '运输动作缺少可移动运输实体', null, 422);
  }
  const contract = vehicle.attributes?.mobility_contract;
  if (!contract) {
    throw new PaperStudioError('PAPER_STUDIO_MOBILITY_CONTRACT_MISSING', '运动车辆缺少动力来源与数量合同', { subject_key: vehicle.key }, 422);
  }
  const operator = contract.operator_entity_key
    ? blueprint.entities.find((entity) => entity.key === contract.operator_entity_key && entity.type === 'character')
    : null;
  const storyboardText = [storyboard.title, storyboard.description, storyboard.action, storyboard.narration].filter(Boolean).join('，');
  const observer = !operator && /(看着|望着|注视|目送|观察)/.test(storyboardText)
    ? blueprint.entities.find((entity) => entity.type === 'character')
    : null;
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 4, Math.round(Number(storyboard.duration || 6) * fps));
  const finalFrame = durationFrames - 1;
  const moveStart = frameAt(durationFrames, 0.15);
  const moveEnd = frameAt(durationFrames, 0.78);
  const start = blueprint.action_contract.waypoints[0] || { x: -0.3 };
  const end = blueprint.action_contract.waypoints.at(-1) || { x: 0.3 };
  let xStart = Number(start.x || 0);
  let xEnd = Number(end.x || 0);
  if (Math.abs(xEnd - xStart) < 0.12) {
    if (blueprint.action_contract.direction === 'backward') [xStart, xEnd] = [0.12, -0.18];
    else [xStart, xEnd] = [-0.18, 0.12];
  }
  const transportAssetFamily = transportFamily(vehicle, contract, {
    familyKey: `${vehicle.key}_transport_family`,
    slotKey: `${vehicle.key}_transport_unit_cutout`,
  });
  const observerFamily = observer ? {
    family_key: `${observer.key}_observer_family`, pattern: 'supported-subject', registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: `${observer.key}_observer_cutout`, asset_type: 'character-cutout', generation_purpose: 'transport_observer', required_for_gate: true,
      constraints: { transparent_background: true, single_subject: true, subject_key: observer.key, identity: observer.name, state: 'watching', ...sourceConstraints(observer) },
    }],
    contract: { subject_key: observer.key, identity: observer.name, subject_slots: { watching: `${observer.key}_observer_cutout` } },
  } : null;
  const families = [baseEnvironmentFamily(blueprint), transportAssetFamily, ...(observerFamily ? [observerFamily] : [])];
  const groundY = Number((blueprint.environment.placement_regions || []).find((region) => region.key === vehicle.attributes?.placement?.region_key)?.ground_y || 0.82);
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    transportGroupNode(vehicle, transportAssetFamily, contract, { groundY, localZ: 22 }),
    ...(observer ? [node(
      observer.key, 'asset', 'supported-subject', observerFamily.slots[0].slot_key,
      { x: blueprint.action_contract.direction === 'right_to_left' ? 0.18 : 0.82, y: groundY, width: 0.24, height: 0.5, anchor_x: 0.5, anchor_y: 0.9 },
      { family_key: observerFamily.family_key, role: 'observer', placement: observer.attributes?.placement || placementAttributes({ contactKind: 'feet' }) },
      30,
    )] : []),
  ]);
  const mobilityContracts = mobilityContractService.contractsFromBlueprint(blueprint);
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: {
      description: blueprint.environment.description,
      clean_plate_required: true,
      registered_boundaries: blueprint.environment.registered_boundaries || [],
      placement_regions: blueprint.environment.placement_regions || [],
    },
    subjects: [
      { key: vehicle.key, kind: 'vehicle', identity: vehicle.name, support_key: null, required_states: vehicle.states, placement: vehicle.attributes?.placement || null },
      ...(operator ? [{ key: operator.key, kind: 'character', identity: operator.name, support_key: vehicle.key, required_states: operator.states }] : []),
      ...(observer ? [{ key: observer.key, kind: 'character', identity: observer.name, support_key: null, required_states: observer.states, placement: observer.attributes?.placement || null }] : []),
    ],
    mobility_contracts: mobilityContracts,
    action_beats: [{ key: 'transport_advance', start_frame: moveStart, peak_frame: moveEnd, end_frame: finalFrame, subject_key: vehicle.key, action: 'advance_with_visible_power_source' }],
  };
  const displacement = Math.abs(xEnd - xStart);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'transport_move', camera_only: false,
    subject_tracks: [
      { target: vehicle.key, property: 'x', keyframes: [{ frame: 0, value: xStart }, { frame: moveStart, value: xStart }, { frame: moveEnd, value: xEnd, easing: 'ease-in-out' }, { frame: finalFrame, value: xEnd }] },
      { target: vehicle.key, property: 'state', keyframes: [{ frame: 0, value: 'approach' }, { frame: moveStart, value: 'moving' }, { frame: moveEnd, value: 'arrived' }, { frame: finalFrame, value: 'arrived' }] },
    ],
    camera_tracks: [],
    cues: [
      { key: 'transport_engages', frame: moveStart, kind: 'contact' },
      { key: 'transport_arrives', frame: moveEnd, kind: 'semantic' },
    ],
    gate_requirements: [
      { key: 'transport_ground_translation', metric: 'numeric_range', target: vehicle.key, property: 'x', min: Math.max(0.12, displacement * 0.8) },
      { key: 'transport_state_progression', metric: 'distinct_states', target: vehicle.key, property: 'state', min: 3 },
      { key: 'transport_contact_cue', metric: 'cue_exists', cue: 'transport_engages' },
    ],
  };
  const proofTargets = [
    { key: 'transport_start', frame: 0, target_node_key: vehicle.key, assertions: [{ type: 'state_equals', target: vehicle.key, value: 'approach' }] },
    { key: 'transport_advance', frame: moveEnd, target_node_key: vehicle.key, assertions: [{ type: 'track_range', target: vehicle.key, property: 'x', min: Math.max(0.12, displacement * 0.8) }] },
    { key: 'transport_final', frame: finalFrame, target_node_key: vehicle.key, assertions: [{ type: 'state_equals', target: vehicle.key, value: 'arrived' }, { type: 'camera_only', expected: false }] },
  ];
  return {
    catalog_key: 'blueprint-transport-move-v1', semanticContract, families, root, motionPlan, proofTargets,
    summary: {
      catalog_key: 'blueprint-transport-move-v1', primary_action: 'transport_move', camera_only: false,
      clean_plate_required: true, source_family_count: families.length,
      required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
      entity_keys: blueprint.entities.map((entity) => entity.key),
      required_states: { [vehicle.key]: vehicle.states },
      relation_contracts: blueprint.relations.map((relation) => `${relation.subject_key}:${relation.predicate}:${relation.object_key}`),
      mobility_contracts: mobilityContracts,
      proof_targets: proofTargets,
    },
  };
}

function pathRevealPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const pathEntity = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key);
  const markers = blueprint.entities.filter((entity) => entity.type === 'character' && ['path_subject_marker', 'map_character_marker'].includes(entity.role));
  if (!pathEntity) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_PATH_REVEAL_MISSING', '路径揭示镜头缺少程序化路径主体', null, 422);
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 4, Math.round(Number(storyboard.duration || 6) * fps));
  const finalFrame = durationFrames - 1;
  const captions = Array.isArray(storyboard.audio_captions) ? storyboard.audio_captions : [];
  const labels = blueprint.action_contract.waypoints.map((item) => item.label).filter(Boolean);
  const revealFrame = captionFrame(captions, [...labels, /路线|路径|线路|轨迹|流程|管线/], 'end', frameAt(durationFrames, 0.58), durationFrames);
  const completionFrame = Math.max(
    Math.min(finalFrame, revealFrame + 1),
    captionFrame(captions, [/到达|完成|连接|合拢|终点/, labels.at(-1)], 'end', frameAt(durationFrames, 0.74), durationFrames),
  );
  const points = blueprint.action_contract.waypoints.map((item) => [
    Math.max(0.08, Math.min(0.92, 0.5 + Number(item.x || 0) * 0.9)),
    Math.max(0.08, Math.min(0.92, 0.5 + Number(item.y || 0) * 0.9)),
  ]);
  const environmentFamily = baseEnvironmentFamily(blueprint);
  environmentFamily.slots = environmentFamily.slots.map((slot) => slot.slot_key === 'clean_plate' ? {
    ...slot,
    generation_purpose: 'flat_diagram_clean_background',
    constraints: {
      ...slot.constraints,
      label: '干净平面底图',
      path_base: true,
      remove_path_overlays: true,
      allow_source_import: false,
    },
  } : slot);
  environmentFamily.contract = {
    ...environmentFamily.contract,
    role: 'flat_information_canvas',
    excludes: ['path_overlays', 'subject_markers', 'label_cards', 'readable_text'],
  };
  const markerFamilies = markers.map((marker, index) => ({
    family_key: `${marker.key}_family`, pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: `${marker.key}_cutout`, asset_type: 'character-cutout', generation_purpose: 'path_subject_marker', required_for_gate: true,
      constraints: { label: `${marker.name} · 路径主体标记`, transparent_background: true, single_subject: true, complete_silhouette: true, subject_key: marker.key, state: 'path_marker', identity: marker.name, reveal_order: index, ...sourceConstraints(marker) },
    }],
    contract: { subject_key: marker.key, identity: marker.name, subject_slots: { path_marker: `${marker.key}_cutout` }, title_card: marker.attributes?.title_card || marker.name, order: index },
  }));
  const markerLayouts = [
    { x: 0.82, y: 0.5 }, { x: 0.62, y: 0.78 }, { x: 0.2, y: 0.52 }, { x: 0.74, y: 0.24 },
  ];
  const markerNodes = markers.flatMap((marker, index) => {
    const layout = markerLayouts[index] || markerLayouts.at(-1);
    return [
      node(marker.key, 'asset', 'free', `${marker.key}_cutout`, { x: layout.x, y: layout.y, width: 0.17, height: 0.38, anchor_x: 0.5, anchor_y: 0.86 }, { family_key: `${marker.key}_family`, role: 'path-subject-marker', identity: marker.name }, 30 + index * 2),
      node(`${marker.key}_label`, 'procedural', 'free', null, { x: layout.x, y: Math.min(0.92, layout.y + 0.18), width: 0.22, height: 0.08, anchor_x: 0.5, anchor_y: 0.5 }, { procedural_kind: 'label-card', appearance: 'subject', role: 'path-label', text: marker.attributes?.title_card || marker.name, subject_key: marker.key }, 31 + index * 2),
    ];
  });
  const waypointNodes = blueprint.action_contract.waypoints.map((waypoint, index) => node(
    `path_waypoint_${index + 1}`, 'procedural', 'free', null,
    { x: points[index][0], y: points[index][1], width: 0.13, height: 0.055, anchor_x: 0.5, anchor_y: 0.5 },
    { procedural_kind: 'label-card', appearance: 'place', role: 'path-waypoint-label', text: waypoint.label, reveal_order: index },
    14 + index,
  ));
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    ...waypointNodes,
    node('path_reveal_layer', 'procedural', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, { procedural_kind: 'path-reveal', appearance: 'ink-route', role: 'path-overlay', points }, 20),
    node('path_completion', 'procedural', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, { procedural_kind: 'path-reveal', appearance: 'completion-ring', role: 'path-completion', points: [...points.slice(-1), ...points.slice(-1)] }, 21),
    ...markerNodes,
  ]);
  const markerRevealTracks = markers.flatMap((marker, index) => {
    const reveal = frameAt(durationFrames, Math.min(0.94, 0.76 + index * 0.08));
    const fade = Math.max(2, Math.round(fps * 0.3));
    return [
      { target: marker.key, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: Math.max(0, reveal - fade), value: 0 }, { frame: reveal, value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
      { target: `${marker.key}_label`, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: reveal, value: 0 }, { frame: Math.min(finalFrame, reveal + fade), value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
    ];
  });
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'path_reveal', camera_only: false,
    subject_tracks: [
      { target: pathEntity.key, property: 'state', keyframes: [{ frame: 0, value: 'hidden' }, { frame: revealFrame, value: 'revealing' }, { frame: finalFrame, value: 'complete' }] },
      { target: 'path_reveal_layer', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: revealFrame, value: 1, easing: 'ease-in-out' }, { frame: finalFrame, value: 1 }] },
      { target: 'path_completion', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: revealFrame, value: 0 }, { frame: completionFrame, value: 1, easing: 'ease-out' }, { frame: finalFrame, value: 1 }] },
      ...blueprint.action_contract.waypoints.map((unused, index) => ({ target: `path_waypoint_${index + 1}`, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: frameAt(durationFrames, 0.16 + index * 0.12), value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] })),
      ...markerRevealTracks,
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.018, easing: 'ease-in-out' }] }],
    cues: [{ key: 'path_revealed', frame: revealFrame, kind: 'semantic' }, { key: 'path_completed', frame: completionFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'path_reveal_range', metric: 'numeric_range', target: 'path_reveal_layer', property: 'clip_progress', min: 0.95 },
      { key: 'path_completion_range', metric: 'numeric_range', target: 'path_completion', property: 'clip_progress', min: 0.95 },
      { key: 'path_reveal_cue', metric: 'cue_exists', cue: 'path_revealed' },
    ],
  };
  const proofTargets = [
    { key: 'path_start', frame: 0, target_node_key: 'path_reveal_layer', assertions: [{ type: 'camera_only', expected: false }] },
    { key: 'path_revealed', frame: revealFrame, target_node_key: 'path_reveal_layer', assertions: [{ type: 'track_range', target: 'path_reveal_layer', property: 'clip_progress', min: 0.95 }] },
    { key: 'path_complete', frame: completionFrame, target_node_key: 'path_completion', assertions: [{ type: 'track_range', target: 'path_completion', property: 'clip_progress', min: 0.95 }] },
  ];
  const families = [environmentFamily, ...markerFamilies];
  return {
    catalog_key: 'blueprint-path-reveal-v1',
    semanticContract: {
      schema_version: 3, storyboard_id: Number(storyboard.id),
      environment: { description: blueprint.environment.description, clean_plate_required: true, registered_boundaries: [] },
      subjects: [{ key: pathEntity.key, kind: 'effect', identity: pathEntity.name, support_key: null, required_states: pathEntity.states }, ...markers.map((marker) => ({ key: marker.key, kind: 'character', identity: marker.name, support_key: null, required_states: marker.states }))],
      action_beats: [{ key: 'path_reveal', start_frame: 0, peak_frame: revealFrame, end_frame: completionFrame, subject_key: pathEntity.key, action: 'reveal_path' }],
    },
    families, root, motionPlan, proofTargets,
    summary: {
      catalog_key: 'blueprint-path-reveal-v1', primary_action: 'path_reveal', camera_only: false, path_reveal: true,
      clean_plate_required: true, source_family_count: families.length,
      required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
      entity_keys: [pathEntity.key, ...markers.map((marker) => marker.key)],
      required_states: Object.fromEntries([[pathEntity.key, pathEntity.states], ...markers.map((marker) => [marker.key, marker.states])]),
      relation_contracts: ['path overlay registered to flat canvas', 'subject markers revealed independently', 'labels rendered procedurally'],
      path_subject_names: markers.map((marker) => marker.name),
      path_waypoint_names: blueprint.action_contract.waypoints.map((item) => item.label), proof_targets: proofTargets,
    },
  };
}

function multiBeatGroundedSequencePlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const falling = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key);
  const transport = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.object_key);
  const effect = blueprint.entities.find((entity) => entity.role === 'grounded_crowd_effect')
    || blueprint.entities.find((entity) => entity.type === 'effect');
  if (!falling || !transport || !effect) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GROUNDED_SEQUENCE_ENTITY_MISSING',
      '多阶段接地序列缺少必要的接地主体或场景主体',
      { falling: falling?.key || null, transport: transport?.key || null, effect: effect?.key || null },
      422,
    );
  }
  const mobilityContracts = mobilityContractService.contractsFromBlueprint(blueprint);
  const transportMobility = mobilityContracts.find((item) => item.subject_key === transport.key);
  if (!transportMobility) {
    throw new PaperStudioError('PAPER_STUDIO_MOBILITY_CONTRACT_MISSING', '运输主体缺少动力来源与运输规模合同', { subject_key: transport.key }, 422);
  }
  if (effect && transportMobility.unit_count) {
    transportMobility.unit_count = {
      ...transportMobility.unit_count,
      min_visible: Math.max(3, Number(transportMobility.unit_count.min_visible || 1)),
      target_visible: Math.max(3, Number(transportMobility.unit_count.target_visible || 1)),
      reason: 'multi_beat_depth_scale',
    };
    transportMobility.formation = 'staggered_convoy';
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 5, Math.round(Number(storyboard.duration || 6) * fps));
  const finalFrame = durationFrames - 1;
  const captions = Array.isArray(storyboard.audio_captions) ? storyboard.audio_captions : [];
  const fallingMatch = visualSceneCompiler.orderedCaptionMatch(captions, [falling.name, /滑落|掉落|落地|坠落/], {
    edge: 'end', fallback_frame: frameAt(durationFrames, 0.3),
  });
  const transportMatch = visualSceneCompiler.orderedCaptionMatch(captions, [transport.name, /前行|驶入|移动|推进|穿过|进入/], {
    edge: 'start', after_frame: fallingMatch.frame - 1, after_caption_key: fallingMatch.caption_key,
    exclude_caption_keys: fallingMatch.caption_key ? [fallingMatch.caption_key] : [], fallback_frame: frameAt(durationFrames, 0.44),
  });
  const transitionFrames = Math.max(Math.round(fps * 0.6), Math.round(fps * 0.5));
  const boundaryFrame = Math.max(Math.round(fps * 1.2), Math.min(finalFrame - Math.round(fps * 2.1), transportMatch.frame));
  const transitionStart = Math.max(0, boundaryFrame - Math.floor(transitionFrames / 2));
  const transitionEnd = Math.min(finalFrame - Math.round(fps * 1.8), transitionStart + transitionFrames);
  const contactFrame = Math.max(1, Math.min(fallingMatch.frame, transitionStart - Math.max(1, Math.round(fps * 0.1))));
  const moveStart = Math.min(finalFrame - Math.round(fps), transitionEnd + Math.round(fps * 0.1));
  const moveEnd = Math.min(finalFrame - Math.round(fps * 1.2), Math.max(moveStart + Math.round(fps * 1.9), frameAt(durationFrames, 0.66)));
  const effectStart = Math.min(finalFrame - Math.round(fps * 0.8), moveEnd + Math.round(fps * 0.2));
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: {
      description: blueprint.environment.description, clean_plate_required: true,
      registered_boundaries: blueprint.environment.registered_boundaries || [],
      placement_regions: blueprint.environment.placement_regions || [],
    },
    subjects: [
      { key: falling.key, kind: 'prop', identity: falling.name, support_key: null, required_states: falling.states, placement: falling.attributes?.placement || null },
      { key: transport.key, kind: 'vehicle', identity: transport.name, support_key: null, required_states: transport.states, placement: transport.attributes?.placement || null },
      { key: effect.key, kind: 'effect', identity: effect.name, support_key: null, required_states: effect.states },
    ],
    mobility_contracts: mobilityContracts,
    action_beats: [
      { key: 'ground_contact', start_frame: 0, peak_frame: Math.max(1, contactFrame - Math.round(fps * 0.2)), end_frame: contactFrame, subject_key: falling.key, action: 'fall_and_contact_ground' },
      { key: 'ground_move', start_frame: moveStart, peak_frame: Math.max(moveStart + 1, moveEnd - Math.round(fps * 0.16)), end_frame: moveEnd, subject_key: transport.key, action: 'advance_on_ground' },
      { key: 'depth_change', start_frame: effectStart, peak_frame: Math.max(effectStart, finalFrame - Math.round(fps * 0.8)), end_frame: finalFrame, subject_key: effect.key, action: 'change_spatial_formation' },
    ],
  };
  const environmentFamily = baseEnvironmentFamily(blueprint);
  const fallingFamily = {
    family_key: `${falling.key}_family`, pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: `${falling.key}_cutout`, asset_type: 'prop-cutout', generation_purpose: 'ground_contact_subject', required_for_gate: true,
      constraints: { transparent_background: true, single_subject: true, subject_key: falling.key, identity: falling.name, contact_kind: 'base', ...sourceConstraints(falling) },
    }],
    contract: { subject_key: falling.key, identity: falling.name, placement: falling.attributes?.placement, contact_states: falling.states },
  };
  const transportFamily = transportFamilyForSequence(transport, transportMobility);
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    node(falling.key, 'asset', 'free', `${falling.key}_cutout`, { x: 0.34, y: 0.82, width: 0.18, height: 0.22, anchor_x: 0.5, anchor_y: 0.9 }, { family_key: fallingFamily.family_key, role: falling.role, placement: falling.attributes?.placement }, 20),
    transportGroupNode(transport, transportFamily, transportMobility, { groundY: 0.82, localZ: 22 }),
    node(effect.key, 'procedural', 'free', null, { x: 0.48, y: 0.57, width: 0.82, height: 0.3, anchor_x: 0.5, anchor_y: 0.5 }, { procedural_kind: 'crowd-formation', appearance: 'neutral-silhouette', role: effect.role }, 18),
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'multi_beat_grounded_sequence', camera_only: false,
    subject_tracks: [
      { target: falling.key, property: 'y', keyframes: [{ frame: 0, value: -0.18 }, { frame: Math.max(1, contactFrame - Math.round(fps * 0.2)), value: 0, easing: 'ease-in' }, { frame: contactFrame, value: 0 }, { frame: finalFrame, value: 0 }] },
      { target: falling.key, property: 'rotation', keyframes: [{ frame: 0, value: -12 }, { frame: Math.max(1, contactFrame - Math.round(fps * 0.2)), value: 6, easing: 'ease-in' }, { frame: contactFrame, value: 0, easing: 'ease-out' }, { frame: finalFrame, value: 0 }] },
      { target: falling.key, property: 'state', keyframes: [{ frame: 0, value: 'suspended' }, { frame: Math.max(1, contactFrame - Math.round(fps * 0.2)), value: 'falling' }, { frame: contactFrame, value: 'grounded' }, { frame: finalFrame, value: 'grounded' }] },
      { target: transport.key, property: 'x', keyframes: [{ frame: 0, value: -0.3 }, { frame: moveStart, value: -0.3 }, { frame: moveEnd, value: 0.06, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.06 }] },
      { target: transport.key, property: 'state', keyframes: [{ frame: 0, value: 'approach' }, { frame: moveStart, value: 'moving' }, { frame: moveEnd, value: 'arrived' }, { frame: finalFrame, value: 'arrived' }] },
      { target: effect.key, property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: effectStart, value: 0 }, { frame: finalFrame, value: 1, easing: 'ease-in-out' }] },
      { target: effect.key, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: effectStart, value: 0 }, { frame: Math.min(finalFrame, effectStart + Math.round(fps * 0.3)), value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
    ],
    camera_tracks: [],
    cues: [
      { key: 'subject_contacts_ground', frame: contactFrame, kind: 'contact' },
      { key: 'ground_transport_enters', frame: moveStart, kind: 'semantic', matched_transition: blueprint.transition_contracts?.[0]?.key || 'primary_to_followup' },
      { key: 'depth_formation_changes', frame: effectStart, kind: 'semantic' },
    ],
    gate_requirements: [
      { key: 'ground_contact_range', metric: 'numeric_range', target: falling.key, property: 'y', min: 0.16 },
      { key: 'ground_transport_translation', metric: 'numeric_range', target: transport.key, property: 'x', min: 0.24 },
      { key: 'depth_formation_change', metric: 'numeric_range', target: effect.key, property: 'procedural_amount', min: 0.9 },
      { key: 'ground_contact_cue', metric: 'cue_exists', cue: 'subject_contacts_ground' },
    ],
  };
  const proofTargets = [
    { key: 'ground_contact', frame: Math.max(1, contactFrame - Math.round(fps * 0.2)), target_node_key: falling.key, assertions: [{ type: 'track_range', target: falling.key, property: 'y', min: 0.16 }, { type: 'camera_only', expected: false }] },
    { key: 'ground_transport_move', frame: moveEnd, target_node_key: transport.key, assertions: [{ type: 'track_range', target: transport.key, property: 'x', min: 0.24 }] },
    { key: 'depth_formation_final', frame: finalFrame, target_node_key: effect.key, assertions: [{ type: 'track_range', target: effect.key, property: 'procedural_amount', min: 0.9 }] },
  ];
  const primarySceneKey = blueprint.visual_scenes?.[0]?.key || 'scene_primary';
  const followupSceneKey = blueprint.visual_scenes?.[1]?.key || primarySceneKey;
  return {
    catalog_key: 'multi-beat-grounded-sequence-v1', semanticContract,
    families: [environmentFamily, fallingFamily, transportFamily], root, motionPlan, proofTargets,
    sceneBoundaryFrames: [boundaryFrame],
    timingAlignment: { primary: { caption_key: fallingMatch.caption_key, confidence: fallingMatch.confidence }, followup: { caption_key: transportMatch.caption_key, confidence: transportMatch.confidence } },
    visualBeats: [
      { key: 'ground_contact', scene_key: primarySceneKey, subject_keys: [falling.key], source_caption_keys: fallingMatch.caption_key ? [String(fallingMatch.caption_key)] : [], start_frame: 0, peak_frame: Math.max(1, contactFrame - Math.round(fps * 0.3)), end_frame: contactFrame, minimum_hold_frames: Math.round(fps * 0.3), motion_verb: 'drop_and_settle' },
      { key: 'ground_move', scene_key: followupSceneKey, subject_keys: [transport.key], source_caption_keys: transportMatch.caption_key ? [String(transportMatch.caption_key)] : [], start_frame: moveStart, peak_frame: moveEnd, end_frame: Math.min(finalFrame, moveEnd + Math.round(fps * 0.3)), minimum_hold_frames: Math.round(fps * 0.3), motion_verb: 'enter_and_advance' },
      { key: 'depth_change', scene_key: followupSceneKey, subject_keys: [effect.key], source_caption_keys: transportMatch.caption_key ? [String(transportMatch.caption_key)] : [], start_frame: effectStart, peak_frame: Math.max(effectStart, finalFrame - Math.round(fps * 0.8)), end_frame: finalFrame, minimum_hold_frames: Math.round(fps * 0.8), motion_verb: 'change_formation' },
    ],
    summary: {
      catalog_key: 'multi-beat-grounded-sequence-v1', primary_action: 'multi_beat_grounded_sequence', camera_only: false,
      clean_plate_required: true, source_family_count: 3, required_asset_count: 3,
      entity_keys: blueprint.entities.map((entity) => entity.key),
      required_states: Object.fromEntries(blueprint.entities.map((entity) => [entity.key, entity.states])),
      relation_contracts: [], placement_regions: blueprint.environment.placement_regions || [], mobility_contracts: mobilityContracts,
      proof_targets: proofTargets,
      timing_alignment: { primary: { caption_key: fallingMatch.caption_key, confidence: fallingMatch.confidence }, followup: { caption_key: transportMatch.caption_key, confidence: transportMatch.confidence } },
    },
  };
}

function transportFamilyForSequence(transport, mobility) {
  return transportFamily(transport, mobility, {
    familyKey: `${transport.key}_family`,
    slotKey: `${transport.key}_transport_unit_cutout`,
  });
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
  const actionObjectMobility = actionObject?.attributes?.mobility_contract || null;
  const stationaryActionObject = Boolean(actionObjectMobility && actionObjectMobility.movement_expected === false);
  const declaredHold = Boolean(actionObject) && blueprint.relations.some((relation) => (
    relation.predicate === 'holds' && relation.subject_key === subject.key && relation.object_key === actionObject.key
  ));
  const attachedObject = Boolean(actionObject) && (declaredHold || actionObject.role === 'carried_object');
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
  const releaseRequested = attachedObject && (blueprint.action_contract.contact_events || []).includes('release_prop');
  const semanticContract = {
    schema_version: 3, storyboard_id: Number(storyboard.id),
    environment: { description: blueprint.environment.description, clean_plate_required: true, registered_boundaries: blueprint.environment.registered_boundaries },
    subjects: [
      { key: subject.key, kind: semanticKind, identity: subject.name, support_key: null, required_states: states },
      ...auxiliaryEntities.map((entity) => ({
        key: entity.key,
        kind: entity.type === 'effect' ? 'effect' : entity.type === 'character' ? 'character' : entity.role === 'ground_vehicle' ? 'vehicle' : 'prop',
        identity: entity.name,
        support_key: entity.key === blueprint.action_contract.object_key && attachedObject ? subject.key : null,
        required_states: entity.states,
      })),
    ],
    action_beats: [
      { key: 'primary_action', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: subject.key, action: blueprint.action_contract.primary_action },
      ...(actionObject ? [{ key: 'object_relation', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: actionObject.key, action: stationaryActionObject ? 'remain_stationary_on_ground' : attachedObject ? (releaseRequested ? 'follow_and_release' : 'follow_subject') : 'move_independently_on_ground' }] : []),
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
    const attached = entity.key === blueprint.action_contract.object_key && attachedObject;
    const placement = entity.attributes?.placement || null;
    const groundY = Number((blueprint.environment.placement_regions || []).find((region) => region.key === placement?.region_key)?.ground_y || 0.82);
    return node(
      entity.key,
      'asset',
      family.pattern,
      slot,
      { x: 0.5, y: attached ? 0.7 : groundY, width: entity.type === 'character' ? 0.34 : 0.18, height: entity.type === 'character' ? 0.62 : 0.24, anchor_x: 0.5, anchor_y: entity.type === 'character' ? 0.88 : 0.5 },
      attached
        ? { family_key: family.family_key, predicate: 'held-by', object: subject.key, relation_schedule: { held_until: releaseRequested ? 'release_prop' : 'settle', then: releaseRequested ? 'released_beside' : 'held' } }
        : { family_key: family.family_key, role: entity.role, ...(placement ? { placement } : {}) },
      24 + index,
    );
  });
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0),
    ]),
    node(subject.key, 'asset', subjectFamily.pattern, `subject_${states[0]}`, {
      x: 0.5,
      y: Number((blueprint.environment.placement_regions || []).find((region) => region.key === subject.attributes?.placement?.region_key)?.ground_y || 0.82),
      width: 0.42, height: 0.62, anchor_x: 0.5, anchor_y: 0.88,
    }, { family_key: subjectFamily.family_key, role: subject.role, state_slots: subjectFamily.contract.subject_slots, ...(subject.attributes?.placement ? { placement: subject.attributes.placement } : {}) }, 20),
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
    ? (stationaryActionObject
      ? [actionObject.states[0] || 'stable', actionObject.states[0] || 'stable', actionObject.states[0] || 'stable']
      : actionObject.states.length >= 3 ? actionObject.states.slice(0, 3) : [actionObject.states[0] || 'held', releaseRequested ? 'carried' : 'active', releaseRequested ? 'released' : actionObject.states.at(-1) || 'settle'])
    : [];
  const independentObjectX = actionObject?.role === 'ground_vehicle' ? [-0.18, 0.1] : [-0.08, 0.08];
  const objectTracks = actionObject ? [
    { target: actionObject.key, property: 'x', keyframes: stationaryActionObject
      ? [{ frame: 0, value: 0 }, { frame: finalFrame, value: 0 }]
      : attachedObject
      ? [{ frame: 0, value: xValues[0] - 0.03 }, { frame: actionFrame, value: xValues[1] - 0.03, easing: 'ease-in-out' }, ...(releaseRequested ? [{ frame: releaseFrame, value: xValues[1] + 0.08, easing: 'ease-out' }] : []), { frame: finalFrame, value: releaseRequested ? xValues[1] + 0.08 : xValues[1] - 0.03 }]
      : [{ frame: 0, value: independentObjectX[0] }, { frame: actionFrame, value: independentObjectX[1], easing: 'ease-in-out' }, { frame: finalFrame, value: independentObjectX[1] }] },
    { target: actionObject.key, property: 'state', keyframes: [{ frame: 0, value: objectStates[0] }, { frame: actionFrame, value: objectStates[1] }, ...(releaseRequested ? [{ frame: releaseFrame, value: objectStates[2] }] : []), { frame: finalFrame, value: objectStates[releaseRequested ? 2 : 1] }] },
    ...(releaseRequested ? [{ target: actionObject.key, property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: actionFrame, value: 0 }, { frame: releaseFrame, value: 0.12, easing: 'ease-in' }, { frame: finalFrame, value: 0.12 }] }] : []),
  ] : [];
  const contactCues = (blueprint.action_contract.contact_events || []).map((key) => {
    const frame = key === 'grip_prop' ? frameAt(durationFrames, 0.1) : key === 'release_prop' ? releaseFrame : actionFrame;
    return {
      key, frame, kind: 'contact',
      ...(frame === actionFrame ? { matched_transition: 'primary_action_peak' } : {}),
    };
  });
  const actionPeakMatchesContact = contactCues.some((cue) => cue.frame === actionFrame && cue.matched_transition === 'primary_action_peak');
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: motionAction, camera_only: false,
    subject_tracks: [
      ...subjectMotionTracks,
      ...objectTracks,
    ],
    camera_tracks: [],
    cues: [{ key: 'action_peak', frame: actionFrame, kind: 'semantic', ...(actionPeakMatchesContact ? { matched_transition: 'primary_action_peak' } : {}) }, ...contactCues, { key: 'settle', frame: finalFrame, kind: 'semantic' }],
    gate_requirements: [
      { key: 'subject_state_progression', metric: 'distinct_states', target: subject.key, property: 'state', min: 3 },
      ...(motionAction === 'state_transition'
        ? [{ key: 'posture_vertical_change', metric: 'numeric_range', target: subject.key, property: 'y', min: 0.08 }]
        : motionAction === 'generic_subject_action'
          ? [{ key: 'subject_action_range', metric: 'numeric_range', target: subject.key, property: 'rotation', min: 8 }]
          : [{ key: 'subject_translation', metric: 'numeric_range', target: subject.key, property: 'x', min: translationThreshold }]),
      ...(actionObject && !stationaryActionObject ? [{ key: attachedObject ? 'action_object_follows_subject' : 'independent_object_ground_translation', metric: 'numeric_range', target: actionObject.key, property: 'x', min: attachedObject ? translationThreshold : 0.12 }] : []),
      ...(actionObject && !stationaryActionObject && objectStates.length >= 3 ? [{ key: 'action_object_state_progression', metric: 'distinct_states', target: actionObject.key, property: 'state', min: releaseRequested ? 3 : 2 }] : []),
      ...(releaseRequested ? [{ key: 'release_cue_exists', metric: 'cue_exists', cue: 'release_prop' }] : []),
    ],
  };
  const actionAssertion = motionAction === 'state_transition'
    ? { type: 'track_range', target: subject.key, property: 'y', min: 0.08 }
    : motionAction === 'generic_subject_action'
      ? { type: 'track_range', target: subject.key, property: 'rotation', min: 8 }
      : { type: 'track_range', target: subject.key, property: 'x', min: translationThreshold };
  const proofTargets = [
    { key: 'subject_start', frame: 0, target_node_key: subject.key, assertions: [{ type: 'state_equals', target: subject.key, value: states[0] }, ...(attachedObject ? [{ type: 'relation_exists', node: actionObject.key, predicate: 'held-by' }] : [])] },
    { key: 'subject_action', frame: actionFrame, target_node_key: subject.key, assertions: [actionAssertion, ...(actionObject && !stationaryActionObject ? [{ type: 'track_range', target: actionObject.key, property: 'x', min: attachedObject ? translationThreshold : 0.12 }] : [])] },
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

function flattenNodes(root) {
  if (!root) return [];
  return [root, ...(root.children || []).flatMap(flattenNodes)];
}

function assertCompiledRelationProvenance(blueprint, plan) {
  const entities = new Map(blueprint.entities.map((entity) => [entity.key, entity]));
  const invented = [];
  const invalidHeldEntities = [];
  for (const current of flattenNodes(plan.root)) {
    if (current.relation?.predicate !== 'held-by') continue;
    const holder = current.relation.object;
    const declared = blueprint.relations.some((relation) => (
      relation.predicate === 'holds' && relation.subject_key === holder && relation.object_key === current.key
    ));
    if (!declared) invented.push({ node_key: current.key, predicate: 'held-by', object: holder });
    const entity = entities.get(current.key);
    if (entity?.role === 'ground_vehicle' || GROUND_VEHICLE_PATTERN.test(String(entity?.name || ''))) {
      invalidHeldEntities.push({ node_key: current.key, name: entity?.name || current.key });
    }
  }
  if (invented.length || invalidHeldEntities.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_BLUEPRINT_RELATION_PROVENANCE_INVALID',
      '组合计划创建了蓝图未声明的持有关系，或试图手持大型接地道具',
      { invented_relations: invented, invalid_held_entities: invalidHeldEntities },
      422,
    );
  }
}

function normalizeLegacyBlueprint(blueprint) {
  const action = blueprint?.action_contract?.primary_action;
  if (!['map_route_reveal', 'siege_supply_sequence'].includes(action)) return blueprint;
  const normalized = JSON.parse(JSON.stringify(blueprint));
  if (action === 'map_route_reveal') {
    normalized.action_contract.primary_action = 'path_reveal';
    for (const entity of normalized.entities || []) {
      if (entity.type === 'character' && entity.role === 'map_character_marker') entity.role = 'path_subject_marker';
      if (entity.key === normalized.action_contract.actor_key) entity.role = 'path_reveal';
    }
  } else {
    normalized.action_contract.primary_action = 'multi_beat_grounded_sequence';
    const effect = (normalized.entities || []).find((entity) => entity.type === 'effect');
    if (effect) effect.role = 'grounded_crowd_effect';
  }
  return normalized;
}

function compile(blueprint, context = {}, config = {}) {
  blueprint = normalizeLegacyBlueprint(blueprint);
  mobilityContractService.annotateBlueprint(blueprint, context);
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
  let plan;
  if (contract.primary_action === 'environmental_depth_motion') plan = environmentPlan(blueprint, context, config);
  else if (contract.primary_action === 'path_reveal') plan = pathRevealPlan(blueprint, context, config);
  else if (contract.primary_action === 'multi_beat_grounded_sequence') plan = multiBeatGroundedSequencePlan(blueprint, context, config);
  else if (contract.primary_action === 'transport_move') plan = transportPlan(blueprint, context, config);
  else plan = contract.primary_action === 'carry_move_sit'
    ? compoundPlan(blueprint, context, config)
    : genericPlan(blueprint, context, config);
  assertCompiledRelationProvenance(blueprint, plan);
  visualSceneCompiler.applySceneContinuity(plan, blueprint, context);
  const compiledMobilityContracts = mobilityContractService.contractsFromBlueprint(blueprint);
  const mobilityAssemblies = mobilityContractService.runtimeAssemblies(plan.root, plan.families, compiledMobilityContracts);
  plan.summary = {
    ...(plan.summary || {}),
    planner_version: CURRENT_PLANNER_VERSION,
    spatial_contract: {
      placement_regions: blueprint.environment.placement_regions || [],
      mobility_contracts: compiledMobilityContracts,
      mobility_assemblies: mobilityAssemblies,
      scenes: (plan.visualScenes || []).map((scene) => ({
        scene_key: scene.key,
        environment_family_key: scene.environment_family_key,
        placement_regions: scene.placement_regions || blueprint.environment.placement_regions || [],
      })),
      blueprint_relations: blueprint.relations.map((relation) => ({
        subject_key: relation.subject_key, predicate: relation.predicate, object_key: relation.object_key,
      })),
      nodes: spatialContractService.spatialNodesFromRoot(plan.root),
    },
  };
  plan.summary.transition_gate = transitionGateService.assertPlan(plan.motionPlan, {
    planner_version: CURRENT_PLANNER_VERSION,
    visual_scenes: plan.visualScenes,
    transition_contracts: plan.transitionContracts,
    root: plan.root,
    families: plan.families,
    semantic_contract: plan.semanticContract,
    spatial_contract: plan.summary.spatial_contract,
    visual_beats: plan.visualBeats,
    captions: context.storyboard?.audio_captions || [],
  }, '场景或主体切换过于突兀，生产蓝图已阻止进入素材生成');
  spatialContractService.assertPlan(plan);
  return plan;
}

function slotReason(slot, family) {
  if (slot.constraints?.label) return slot.constraints.label;
  if (slot.slot_key === 'clean_plate') return '提供不含可动主体的干净背景';
  if (slot.asset_type === 'occlusion-mask') return '在动作阶段恢复正确的前后遮挡关系';
  if (slot.constraints?.ensemble_kind === 'transport_unit') return '车辆、动力角色和接触关系必须形成完整运输单位';
  if (/character/.test(slot.asset_type)) return `角色动作状态：${slot.constraints?.state || slot.slot_key}`;
  if (/prop/.test(slot.asset_type)) return '道具必须作为独立纸片层跟随、释放或单独调整';
  if (/effect/.test(slot.asset_type)) return '环境或动作效果独立层';
  return `${family.family_key} 的正式素材`;
}

function slotSource(slot) {
  if (slot.asset_type === 'occlusion-mask' || slot.constraints?.derivation) return 'local_derivation';
  if (slot.constraints?.source_storyboard_reference) return 'existing_asset';
  if (slot.constraints?.source_paper_entity_id) return 'existing_asset';
  if (slot.constraints?.source_prop_id || slot.constraints?.source_character_id || slot.constraints?.source_character_library_id) return 'existing_asset';
  if (slot.constraints?.fallback === 'procedural' && slot.required_for_gate === false) return 'procedural';
  return 'image_api';
}

function withGenerationSlots(blueprint, plan) {
  blueprint = normalizeLegacyBlueprint(blueprint);
  return visualSceneCompiler.withBlueprintSceneContracts({
    ...blueprint,
    generation_slots: plan.families.flatMap((family) => family.slots.map((slot) => ({
      family_key: family.family_key,
      slot_key: slot.slot_key,
      asset_type: slot.asset_type,
      reason: slotReason(slot, family),
      required: slot.required_for_gate !== false,
      source: slotSource(slot),
    }))),
  }, plan);
}

module.exports = {
  infer,
  compile,
  withGenerationSlots,
  inferActorName,
  inferPropName,
  sourceMentionedAsActor,
  assertCompiledRelationProvenance,
};
