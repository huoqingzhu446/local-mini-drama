const schemaService = require('./paperStudioSchemaService');
const spatialContractService = require('./paperSpatialContractService');
const visualSceneCompiler = require('./paperVisualSceneCompilerService');
const transitionGateService = require('./paperTransitionGateService');
const { CURRENT_PLANNER_VERSION } = require('./paperStudioPlannerVersion');
const { PaperStudioError } = require('./paperStudioUtils');

const ACTOR_WORDS = [
  '人物', '角色', '主角', '男孩', '女孩', '男人', '女人', '老人', '少年', '少女',
  '士兵', '士卒', '将军', '侍卫', '店员', '顾客', '旅客', '司机', '孩子', '他', '她',
];
const PROP_WORDS = [
  '行李箱', '手提箱', '箱子', '背包', '雨伞', '书包', '书本', '杯子', '篮子',
  '粮袋', '粮车', '马车', '战车', '车辆', '车队', '包裹', '武器', '长剑', '木箱',
  '手机', '信件', '道具',
];
const SUPPORT_WORDS = [
  '长椅', '椅子', '沙发', '床边', '床', '台阶', '凳子', '座位', '桌旁', '桌子',
  '门口', '站台', '岸边', '窗边',
];
const MAP_ROUTE_PATTERN = /(战役地图|战略地图|地图上|地图展开|黑色箭头|地图.{0,40}(?:箭头|路线|地名|包围|围城)|(?:路线|战线).{0,30}(?:推进|延伸|合拢)|由.{0,12}向.{0,12}推进)/i;
const SIEGE_SUPPLY_PATTERN = /(?:粮袋|粮尽|缺粮)[\s\S]{0,180}(?:粮车|运粮|甬道|补给)[\s\S]{0,180}(?:包围|军阵|城墙|围城)/i;
const GROUND_VEHICLE_PATTERN = /(粮车|马车|战车|车辆|车队|辎重车|运输车)/;
const MAP_PLACE_LAYOUTS = [
  { key: 'dingtao', name: '定陶', x: 0.405, y: 0.91, width: 0.11 },
  { key: 'yellow_river', name: '黄河', x: 0.37, y: 0.42, width: 0.11 },
  { key: 'handan', name: '邯郸', x: 0.49, y: 0.12, width: 0.11 },
  { key: 'julu', name: '巨鹿', x: 0.61, y: 0.52, width: 0.11 },
];

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
  const shortened = name.replace(/^(?:秦军|楚军|赵军|军用|一辆|一队)/, '');
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
  return captured || firstMatch(text, PROP_WORDS) || context.props?.[0]?.name || '';
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

function siegeSupplyBlueprint(context, storyboard) {
  const cartSource = (context.props || []).find((source) => sourceMentionedAsProp('粮车', source))
    || (context.props || []).find((source) => GROUND_VEHICLE_PATTERN.test(String(source.name || '')))
    || null;
  const bagSource = (context.props || []).find((source) => /粮袋/.test(String(source.name || ''))) || null;
  const entities = [
    sourceIdentity({
      key: 'supply_bag', type: 'prop', name: bagSource?.name || '空粮袋', role: 'ground_prop',
      independent_layer: true, reusable: true, identity_version_id: null,
      source_library_type: null, source_library_id: null,
      states: ['held', 'falling', 'grounded'],
      attributes: {
        inferred_from: 'storyboard_text',
        source_evidence: '空粮袋从守城士兵手中滑落',
        placement: { ...placementAttributes({ contactKind: 'base' }), grounded_states: ['grounded'] },
      },
    }, bagSource),
    sourceIdentity({
      key: 'supply_cart', type: 'prop', name: cartSource?.name || '秦军粮车', role: 'ground_vehicle',
      independent_layer: true, reusable: true, identity_version_id: null,
      source_library_type: null, source_library_id: null,
      states: ['approach', 'passing', 'continue'],
      attributes: {
        inferred_from: 'storyboard_text',
        source_evidence: '秦军甬道上的运粮车队',
        placement: placementAttributes({ contactKind: 'wheels' }),
      },
    }, cartSource),
    {
      key: 'siege_line', type: 'effect', name: '逼近城墙的秦军阵线', role: 'army_formation',
      independent_layer: true, reusable: false, states: ['hidden', 'advancing', 'settle'],
      attributes: { procedural: true, source_evidence: '王离军包围圈逐渐缩小' },
    },
  ];
  const captions = [...(storyboard.audio_captions || [])].sort((left, right) => Number(left.start_frame || 0) - Number(right.start_frame || 0));
  const insideDescription = '巨鹿城内，困守的石路与城墙内侧，空粮袋落地，冷灰战争烟尘色调';
  const outsideDescription = '巨鹿城外秦军甬道，接地运粮车队沿土路前行，远处秦军阵线围城，与城内保持相同年代、天气和冷灰战争色调';
  const blueprint = {
    schema_version: 1,
    environment: {
      description: insideDescription,
      clean_plate_required: true,
      camera_intent: storyboard.camera_motion || 'static',
      registered_boundaries: [],
      placement_regions: defaultPlacementRegions({ protectRight: true }),
    },
    entities,
    relations: [],
    visual_scenes: [
      {
        key: 'scene_inside_city', label: '巨鹿城内', description: insideDescription, location: '巨鹿城内',
        time_context: 'continuous', camera_signature: '近景低机位', environment_family_key: 'city_inside_environment',
        subject_keys: ['supply_bag'], source_caption_keys: captions[0]?.key ? [String(captions[0].key)] : [], confidence: 0.98,
        placement_regions: defaultPlacementRegions({ protectRight: true }),
      },
      {
        key: 'scene_outside_road', label: '巨鹿城外甬道', description: outsideDescription, location: '巨鹿城外',
        time_context: 'continuous', camera_signature: '中远景平视', environment_family_key: 'city_outside_road_environment',
        subject_keys: ['supply_cart', 'siege_line'], source_caption_keys: captions[1]?.key ? [String(captions[1].key)] : [], confidence: 0.98,
        placement_regions: defaultPlacementRegions({ protectRight: true }),
      },
    ],
    transition_contracts: [{
      key: 'inside_to_outside', from_scene_key: 'scene_inside_city', to_scene_key: 'scene_outside_road',
      relation: 'location_change', kind: 'dust_whip_pan', duration_seconds: 0.6, direction: 'left',
      requires_new_plate: true, hard_cut_allowed: false, hard_cut_reason: null,
      source_caption_key: captions[1]?.key ? String(captions[1].key) : null, confidence: 0.98,
    }],
    action_contract: {
      primary_action: 'siege_supply_sequence', actor_key: 'supply_bag', object_key: 'supply_cart', support_key: null,
      direction: 'left_to_right', start_state: 'held', end_state: 'settle',
      waypoints: [
        { key: 'bag_contact', label: '左侧石路粮袋落点', x: -0.14, y: 0, region_key: 'foreground_ground' },
        { key: 'cart_lane', label: '中部石路粮车通道', x: 0.05, y: 0, region_key: 'foreground_ground' },
        { key: 'siege_depth', label: '远处城墙与军阵', x: 0.08, y: -0.2, region_key: 'foreground_ground' },
      ],
      phases: [
        phase('bag_fall', '空粮袋落地', 0, 0.32, 'falling'),
        phase('cart_advance', '粮车沿甬道前行', 0.32, 0.7, 'grounded', 'passing'),
        phase('siege_close', '秦军阵线收紧', 0.7, 1, 'grounded', 'continue'),
      ],
      contact_events: ['bag_contacts_ground'], occlusion_events: [],
    },
    generation_slots: [],
  };
  schemaService.assertValid('paperBlueprint', blueprint, '巨鹿危城多阶段生产蓝图无效');
  return blueprint;
}

function mapRouteBlueprint(context, storyboard, text) {
  const characters = (context.characters || []).slice(0, 4).map((source, index) => sourceIdentity({
    key: `map_character_${index + 1}`,
    type: 'character',
    name: source.name || `人物${index + 1}`,
    role: 'map_character_marker',
    independent_layer: true,
    reusable: true,
    identity_version_id: null,
    source_library_type: null,
    source_library_id: null,
    states: ['map_marker'],
    attributes: {
      inferred_from: 'map_storyboard_entity_links',
      title_card: quotedTitleForCharacter(text, source.name),
      reveal_order: index,
    },
  }, source));
  const blueprint = {
    schema_version: 1,
    environment: {
      description: [storyboard.title, storyboard.description, storyboard.action].filter(Boolean).join('；') || '俯拍战略地图',
      clean_plate_required: true,
      camera_intent: storyboard.camera_motion || 'static',
      registered_boundaries: [],
    },
    entities: [
      {
        key: 'strategic_route', type: 'effect', name: '地图推进路线与包围圈', role: 'map_route',
        independent_layer: false, reusable: false, states: ['hidden', 'advancing', 'encircled'],
        attributes: { procedural: true },
      },
      ...characters,
    ],
    relations: [],
    action_contract: {
      primary_action: 'map_route_reveal', actor_key: 'strategic_route', object_key: null, support_key: null,
      direction: 'forward', start_state: 'hidden', end_state: 'encircled',
      waypoints: [
        { key: 'route_start', label: '推进起点', x: -0.08, y: 0.38 },
        { key: 'encirclement', label: '巨鹿包围圈', x: 0.12, y: 0.02 },
      ],
      phases: [
        phase('hidden', '地图静置', 0, 0.12, 'hidden'),
        phase('advance', '路线推进', 0.12, 0.58, 'advancing'),
        phase('encircle', '包围合拢', 0.58, 0.72, 'encircled'),
        phase('reveal_commanders', '将领与题签显现', 0.72, 1, 'encircled'),
      ],
      contact_events: [], occlusion_events: [],
    },
    generation_slots: [],
  };
  schemaService.assertValid('paperBlueprint', blueprint, '地图镜头生产蓝图无效');
  return blueprint;
}

function infer(context = {}) {
  const storyboard = context.storyboard || {};
  const text = [storyboard.title, storyboard.description, storyboard.action, storyboard.dialogue, storyboard.narration]
    .filter(Boolean)
    .join('，');
  const environmentDescription = context.scene?.prompt || storyboard.location || storyboard.description || storyboard.title || '分镜干净背景';
  const environmentOnly = Boolean(storyboard.environment_only);
  if (MAP_ROUTE_PATTERN.test(text)) return mapRouteBlueprint(context, storyboard, text);
  if (SIEGE_SUPPLY_PATTERN.test(text)) return siegeSupplyBlueprint(context, storyboard);
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
  const actorSource = matchingActorSource(text, context, actorName);
  const propSource = matchingPropSource(text, context, propName);
  const supportName = inferSupportName(text);
  const hasCarry = Boolean(propName) && /提起|提着|拿起|拿着|抱起|抱着|拖着|拉着|推着/.test(text);
  const hasMove = /走|跑|移动|来到|到达|靠近|穿过|进入|离开|前行|驶向|推进/.test(text);
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
    states: actorStates, attributes: {
      inferred_from: 'storyboard_text',
      source_evidence: actorSource?.name || actorName,
      ...(!hasSit ? { placement: placementAttributes({ contactKind: 'feet' }) } : {}),
    },
  }, actorSource)];
  if (propName) entities.push(sourceIdentity({
    key: 'prop_1', type: 'prop', name: propName,
    role: hasCarry ? 'carried_object' : GROUND_VEHICLE_PATTERN.test(propName) ? 'ground_vehicle' : 'prop', independent_layer: true,
    reusable: true, identity_version_id: null, source_library_type: null, source_library_id: null,
    states: hasCarry ? ['held', 'carried', 'released'] : ['stable'], attributes: {
      inferred_from: 'storyboard_text',
      source_evidence: propSource?.name || propName,
      ...(!hasCarry ? { placement: placementAttributes({ contactKind: GROUND_VEHICLE_PATTERN.test(propName) ? 'wheels' : 'base' }) } : {}),
    },
  }, propSource));
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
      placement_regions: defaultPlacementRegions(),
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

function mapRoutePlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const route = blueprint.entities.find((entity) => entity.key === blueprint.action_contract.actor_key);
  const characters = blueprint.entities.filter((entity) => entity.type === 'character' && entity.role === 'map_character_marker');
  if (!route) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_MAP_ROUTE_MISSING', '地图镜头缺少程序化推进路线', null, 422);
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 4, Math.round(Number(storyboard.duration || 6) * fps));
  const finalFrame = durationFrames - 1;
  const audioCaptions = Array.isArray(storyboard.audio_captions) ? storyboard.audio_captions : [];
  const routeFrame = captionFrame(audioCaptions, [/渡河北上|北上攻赵/, /退入巨鹿|巨鹿城外/], 'end', frameAt(durationFrames, 0.56), durationFrames);
  const encircleFrame = Math.max(
    Math.min(finalFrame, routeFrame + 1),
    captionFrame(audioCaptions, [/围死|围城|团团包围/, /输送粮草|甬道/], 'end', frameAt(durationFrames, 0.7), durationFrames),
  );
  const characterRevealFrames = characters.map((character, index) => captionFrame(
    audioCaptions,
    [
      new RegExp(`${String(character.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:出身|则是|负责|驻军)`),
      String(character.name || ''),
    ],
    'start',
    frameAt(durationFrames, Math.min(0.92, 0.74 + index * 0.11)),
    durationFrames,
  ));
  const storyboardText = [storyboard.title, storyboard.description, storyboard.action].filter(Boolean).join('；');
  const places = MAP_PLACE_LAYOUTS.filter((item) => storyboardText.includes(item.name));
  const mapFamily = baseEnvironmentFamily(blueprint);
  mapFamily.slots = mapFamily.slots.map((slot) => slot.slot_key === 'clean_plate' ? {
    ...slot,
    generation_purpose: 'map_clean_background',
    constraints: {
      ...slot.constraints,
      label: '干净战役地图底图',
      map_base: true,
      remove_map_overlays: true,
      allow_source_import: false,
    },
  } : slot);
  mapFamily.contract = {
    ...mapFamily.contract,
    role: 'strategic_map_canvas',
    excludes: ['route_arrows', 'encirclement', 'character_markers', 'title_cards', 'readable_text'],
  };
  const characterFamilies = characters.map((character, index) => {
    const familyKey = `${character.key}_family`;
    const slotKey = `${character.key}_cutout`;
    return {
      family_key: familyKey,
      pattern: 'free',
      registration_canvas: { width: 1920, height: 1080 },
      slots: [{
        slot_key: slotKey,
        asset_type: 'character-cutout',
        generation_purpose: 'map_character_marker',
        required_for_gate: true,
        constraints: {
          label: `${character.name} · 地图人物剪影`,
          transparent_background: true,
          single_subject: true,
          complete_silhouette: true,
          subject_key: character.key,
          state: 'map_marker',
          identity: character.name,
          map_role: 'commander_marker',
          reveal_order: index,
          ...sourceConstraints(character),
        },
      }],
      contract: {
        subject_key: character.key,
        identity: character.name,
        subject_slots: { map_marker: slotKey },
        title_card: character.attributes?.title_card || character.name,
        order: index,
      },
    };
  });
  const characterLayouts = [
    { x: 0.84, y: 0.49, width: 0.18, height: 0.42, label_x: 0.84, label_y: 0.67 },
    { x: 0.5, y: 0.82, width: 0.19, height: 0.38, label_x: 0.68, label_y: 0.8 },
    { x: 0.18, y: 0.5, width: 0.18, height: 0.4, label_x: 0.18, label_y: 0.7 },
    { x: 0.76, y: 0.22, width: 0.16, height: 0.34, label_x: 0.78, label_y: 0.34 },
  ];
  const characterNodes = characters.flatMap((character, index) => {
    const layout = characterLayouts[index] || characterLayouts.at(-1);
    const family = characterFamilies[index];
    const slot = family.slots[0].slot_key;
    return [
      node(character.key, 'asset', 'free', slot, {
        x: layout.x, y: layout.y, width: layout.width, height: layout.height, anchor_x: 0.5, anchor_y: 0.86, opacity: 1,
      }, { family_key: family.family_key, role: 'map-character-marker', identity: character.name }, 30 + index * 2),
      node(`${character.key}_title`, 'procedural', 'free', null, {
        x: layout.label_x, y: layout.label_y, width: 0.24, height: 0.09, anchor_x: 0.5, anchor_y: 0.5, opacity: 1,
      }, {
        procedural_kind: 'map-title-card', appearance: 'commander', role: 'map-label',
        text: character.attributes?.title_card || character.name, subject_key: character.key,
      }, 31 + index * 2),
    ];
  });
  const placeNodes = places.map((place, index) => node(`map_place_${place.key}`, 'procedural', 'free', null, {
    x: place.x, y: place.y, width: place.width, height: 0.055, anchor_x: 0.5, anchor_y: 0.5, opacity: 1,
  }, {
    procedural_kind: 'map-title-card', appearance: 'place', role: 'map-place-label', text: place.name, reveal_order: index,
  }, 14 + index));
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    ...placeNodes,
    node('route_reveal', 'procedural', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, {
      procedural_kind: 'route-reveal', appearance: 'ink-route', role: 'map-route',
      points: [[0.42, 0.93], [0.46, 0.76], [0.52, 0.62], [0.49, 0.43], [0.48, 0.3], [0.5, 0.13]],
    }, 20),
    node('encirclement', 'procedural', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, {
      procedural_kind: 'route-reveal', appearance: 'encirclement', role: 'map-encirclement',
      points: [[0.53, 0.47], [0.62, 0.43], [0.7, 0.48], [0.72, 0.57], [0.66, 0.64], [0.56, 0.64], [0.51, 0.56], [0.53, 0.47]],
    }, 21),
    ...characterNodes,
  ]);
  const characterRevealTracks = characters.flatMap((character, index) => {
    const revealFrame = characterRevealFrames[index];
    const fadeFrames = Math.max(2, Math.round(fps * 0.3));
    const preReveal = Math.max(0, revealFrame - fadeFrames);
    return [
      { target: character.key, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: preReveal, value: 0 }, { frame: revealFrame, value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
      { target: `${character.key}_title`, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: revealFrame, value: 0 }, { frame: Math.min(finalFrame, revealFrame + fadeFrames), value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
    ];
  });
  const placeTracks = places.map((place, index) => {
    const revealFrame = captionFrame(audioCaptions, place.name, 'start', frameAt(durationFrames, 0.16 + index * 0.09), durationFrames);
    const fadeFrames = Math.max(2, Math.round(fps * 0.3));
    return {
      target: `map_place_${place.key}`,
      property: 'opacity',
      keyframes: [{ frame: 0, value: 0 }, { frame: Math.max(0, revealFrame - fadeFrames), value: 0 }, { frame: revealFrame, value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }],
    };
  });
  const motionPlan = {
    schema_version: 1,
    fps,
    duration_frames: durationFrames,
    primary_action: 'map_route_reveal',
    camera_only: false,
    subject_tracks: [
      { target: route.key, property: 'state', keyframes: [{ frame: 0, value: 'hidden' }, { frame: routeFrame, value: 'advancing' }, { frame: finalFrame, value: 'encircled' }] },
      { target: 'route_reveal', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 1, easing: 'ease-in-out' }, { frame: finalFrame, value: 1 }] },
      { target: 'encirclement', property: 'clip_progress', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 0 }, { frame: encircleFrame, value: 1, easing: 'ease-in-out' }, { frame: finalFrame, value: 1 }] },
      { target: 'encirclement', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: routeFrame, value: 0 }, { frame: encircleFrame, value: 1, easing: 'ease-out' }, { frame: finalFrame, value: 1 }] },
      ...placeTracks,
      ...characterRevealTracks,
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.018, easing: 'ease-in-out' }] }],
    cues: [
      { key: 'route_arrival', frame: routeFrame, kind: 'semantic' },
      { key: 'encirclement_closed', frame: encircleFrame, kind: 'semantic' },
      ...characters.map((character, index) => ({ key: `${character.key}_revealed`, frame: characterRevealFrames[index], kind: 'semantic' })),
    ],
    gate_requirements: [
      { key: 'route_reveal_range', metric: 'numeric_range', target: 'route_reveal', property: 'clip_progress', min: 0.95 },
      { key: 'encirclement_reveal_range', metric: 'numeric_range', target: 'encirclement', property: 'clip_progress', min: 0.95 },
      { key: 'encirclement_final', metric: 'final_value', target: 'encirclement', property: 'procedural_amount', min: 0.9 },
      ...characters.map((character) => ({ key: `${character.key}_visible`, metric: 'final_value', target: character.key, property: 'opacity', min: 0.95 })),
      { key: 'route_arrival_cue', metric: 'cue_exists', cue: 'route_arrival' },
    ],
  };
  const proofTargets = [
    { key: 'map_start', frame: 0, target_node_key: 'route_reveal', assertions: [{ type: 'camera_only', expected: false }] },
    { key: 'route_arrival', frame: routeFrame, target_node_key: 'route_reveal', assertions: [{ type: 'track_range', target: 'route_reveal', property: 'clip_progress', min: 0.95 }] },
    { key: 'encirclement_final', frame: encircleFrame, target_node_key: 'encirclement', assertions: [{ type: 'track_range', target: 'encirclement', property: 'clip_progress', min: 0.95 }] },
    ...characters.map((character, index) => ({
      key: `${character.key}_final`, frame: finalFrame, target_node_key: character.key,
      assertions: [{ type: 'final_track_value', target: character.key, property: 'opacity', min: 0.95 }, { type: 'track_range', target: `${character.key}_title`, property: 'opacity', min: 0.95 }],
      crop: index === 0 ? { x: 0.68, y: 0.25, width: 0.31, height: 0.55 } : { x: 0.36, y: 0.58, width: 0.48, height: 0.4 },
    })),
  ];
  const families = [mapFamily, ...characterFamilies];
  return {
    catalog_key: 'blueprint-map-route-reveal-v2',
    semanticContract: {
      schema_version: 3,
      storyboard_id: Number(storyboard.id),
      environment: { description: blueprint.environment.description, clean_plate_required: true, registered_boundaries: [] },
      subjects: [
        { key: route.key, kind: 'effect', identity: route.name, support_key: null, required_states: route.states },
        ...characters.map((character) => ({ key: character.key, kind: 'character', identity: character.name, support_key: null, required_states: character.states })),
      ],
      action_beats: [
        { key: 'route_advance', start_frame: 0, peak_frame: routeFrame, end_frame: encircleFrame, subject_key: route.key, action: 'reveal_route_and_encircle' },
        ...characters.map((character, index) => ({ key: `${character.key}_reveal`, start_frame: Math.max(0, characterRevealFrames[index] - Math.round(fps * 0.2)), peak_frame: characterRevealFrames[index], end_frame: finalFrame, subject_key: character.key, action: 'reveal_map_character_marker' })),
      ],
    },
    families,
    root,
    motionPlan,
    proofTargets,
    summary: {
      catalog_key: 'blueprint-map-route-reveal-v2', primary_action: 'map_route_reveal', camera_only: false,
      map_route: true, clean_plate_required: true, source_family_count: families.length,
      required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
      entity_keys: [route.key, ...characters.map((character) => character.key)],
      required_states: Object.fromEntries([[route.key, route.states], ...characters.map((character) => [character.key, character.states])]),
      relation_contracts: ['route overlay registered to clean map', 'character markers revealed independently', 'all labels rendered procedurally'],
      map_character_names: characters.map((character) => character.name),
      map_place_names: places.map((place) => place.name),
      proof_targets: proofTargets,
    },
  };
}

function siegeSupplyPlan(blueprint, context, config) {
  const storyboard = context.storyboard || {};
  const bag = blueprint.entities.find((entity) => entity.key === 'supply_bag');
  const cart = blueprint.entities.find((entity) => entity.key === 'supply_cart');
  const siege = blueprint.entities.find((entity) => entity.key === 'siege_line');
  if (!bag || !cart || !siege) {
    throw new PaperStudioError('PAPER_STUDIO_SIEGE_SEQUENCE_ENTITY_MISSING', '巨鹿危城多阶段镜头缺少粮袋、粮车或军阵实体', null, 422);
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 5, Math.round(Number(storyboard.duration || 6) * fps));
  const finalFrame = durationFrames - 1;
  const captions = Array.isArray(storyboard.audio_captions) ? storyboard.audio_captions : [];
  const bagMatch = visualSceneCompiler.orderedCaptionMatch(captions, [/兵少粮尽/, /粮尽/, /补给却没有断/], {
    edge: 'end', fallback_frame: frameAt(durationFrames, 0.3),
  });
  const cartCaptionMatch = visualSceneCompiler.orderedCaptionMatch(captions, [/城池一旦陷落/, /反秦力量/, /秦军补给/], {
    edge: 'start', after_frame: bagMatch.frame - 1, after_caption_key: bagMatch.caption_key,
    exclude_caption_keys: bagMatch.caption_key ? [bagMatch.caption_key] : [], fallback_frame: frameAt(durationFrames, 0.42),
  });
  if (captions.length >= 2 && !cartCaptionMatch.caption) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SCENE_CAPTION_ALIGNMENT_UNCERTAIN',
      '无法把第二视觉场景可靠地对齐到后续字幕，已阻止生成可能倒序或突切的时间轴',
      { first_caption_key: bagMatch.caption_key, available_caption_keys: captions.map((caption) => caption.key || null) },
      422,
    );
  }
  const transitionFrames = Math.max(Math.round(fps * 0.6), Math.round(fps * 0.5));
  const boundaryFrame = Math.max(Math.round(fps * 1.2), Math.min(finalFrame - Math.round(fps * 2.1), cartCaptionMatch.frame));
  const transitionStart = Math.max(0, boundaryFrame - Math.floor(transitionFrames / 2));
  const transitionEnd = Math.min(finalFrame - Math.round(fps * 1.8), transitionStart + transitionFrames);
  const bagFrame = Math.max(1, Math.min(bagMatch.frame, transitionStart - Math.max(1, Math.round(fps * 0.1))));
  const cartMoveStart = Math.min(finalFrame - Math.round(fps), transitionEnd + Math.round(fps * 0.1));
  const cartFrame = Math.min(
    finalFrame - Math.round(fps * 1.2),
    Math.max(cartMoveStart + Math.round(fps * 1.9), frameAt(durationFrames, 0.62)),
  );
  const siegeRevealStart = Math.min(finalFrame - Math.round(fps * 0.8), cartFrame + Math.round(fps * 0.2));
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
      { key: bag.key, kind: 'prop', identity: bag.name, support_key: null, required_states: bag.states, placement: bag.attributes?.placement || null },
      { key: cart.key, kind: 'vehicle', identity: cart.name, support_key: null, required_states: cart.states, placement: cart.attributes?.placement || null },
      { key: siege.key, kind: 'effect', identity: siege.name, support_key: null, required_states: siege.states },
    ],
    action_beats: [
      { key: 'bag_fall', start_frame: 0, peak_frame: Math.max(1, bagFrame - Math.round(fps * 0.2)), end_frame: bagFrame, subject_key: bag.key, action: 'fall_and_contact_ground' },
      { key: 'cart_advance', start_frame: cartMoveStart, peak_frame: Math.max(cartMoveStart + 1, cartFrame - Math.round(fps * 0.16)), end_frame: cartFrame, subject_key: cart.key, action: 'advance_on_ground' },
      { key: 'siege_close', start_frame: siegeRevealStart, peak_frame: Math.max(siegeRevealStart, finalFrame - Math.round(fps * 0.8)), end_frame: finalFrame, subject_key: siege.key, action: 'close_encirclement' },
    ],
  };
  const environmentFamily = baseEnvironmentFamily(blueprint);
  const bagFamily = {
    family_key: 'supply_bag_family', pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: 'supply_bag_cutout', asset_type: 'prop-cutout', generation_purpose: 'empty_supply_bag', required_for_gate: true,
      constraints: { transparent_background: true, single_subject: true, subject_key: bag.key, identity: bag.name, contact_kind: 'base', ...sourceConstraints(bag) },
    }],
    contract: { subject_key: bag.key, identity: bag.name, placement: bag.attributes?.placement, contact_states: bag.states },
  };
  const cartFamily = {
    family_key: 'supply_cart_family', pattern: 'free', registration_canvas: { width: 1920, height: 1080 },
    slots: [{
      slot_key: 'supply_cart_cutout', asset_type: 'prop-cutout', generation_purpose: 'grounded_supply_cart', required_for_gate: true,
      constraints: { transparent_background: true, single_subject: true, subject_key: cart.key, identity: cart.name, contact_kind: 'wheels', ...sourceConstraints(cart) },
    }],
    contract: { subject_key: cart.key, identity: cart.name, placement: cart.attributes?.placement, contact_states: cart.states },
  };
  const root = node('root', 'group', 'free', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, {}, 0, [
    node('clean_environment', 'registered-environment', 'registered-environment', null, { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment' }, 0, [
      node('clean_plate', 'asset', 'registered-environment', 'clean_plate', { x: 0.5, y: 0.5, width: 1, height: 1 }, { family_key: 'clean_environment', fit: 'cover' }, 0),
    ]),
    node(bag.key, 'asset', 'free', 'supply_bag_cutout', { x: 0.34, y: 0.82, width: 0.18, height: 0.22, anchor_x: 0.5, anchor_y: 0.9 }, {
      family_key: bagFamily.family_key, role: bag.role, placement: bag.attributes?.placement,
    }, 20),
    node(cart.key, 'asset', 'free', 'supply_cart_cutout', { x: 0.5, y: 0.82, width: 0.26, height: 0.3, anchor_x: 0.5, anchor_y: 0.9 }, {
      family_key: cartFamily.family_key, role: cart.role, placement: cart.attributes?.placement,
    }, 22),
    node(siege.key, 'procedural', 'free', null, { x: 0.48, y: 0.57, width: 0.82, height: 0.3, anchor_x: 0.5, anchor_y: 0.5 }, {
      procedural_kind: 'army-formation', appearance: 'qin-silhouette', role: siege.role,
    }, 18),
  ]);
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'siege_supply_sequence', camera_only: false,
    subject_tracks: [
      { target: bag.key, property: 'y', keyframes: [{ frame: 0, value: -0.18 }, { frame: Math.max(1, bagFrame - Math.round(fps * 0.2)), value: 0, easing: 'ease-in' }, { frame: bagFrame, value: 0 }, { frame: finalFrame, value: 0 }] },
      { target: bag.key, property: 'rotation', keyframes: [{ frame: 0, value: -12 }, { frame: Math.max(1, bagFrame - Math.round(fps * 0.2)), value: 6, easing: 'ease-in' }, { frame: bagFrame, value: 0, easing: 'ease-out' }, { frame: finalFrame, value: 0 }] },
      { target: bag.key, property: 'opacity', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1 }] },
      { target: bag.key, property: 'state', keyframes: [{ frame: 0, value: 'held' }, { frame: Math.max(1, bagFrame - Math.round(fps * 0.2)), value: 'falling' }, { frame: bagFrame, value: 'grounded' }, { frame: finalFrame, value: 'grounded' }] },
      { target: cart.key, property: 'x', keyframes: [{ frame: 0, value: -0.3 }, { frame: cartMoveStart, value: -0.3 }, { frame: cartFrame, value: 0.08, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.08 }] },
      { target: cart.key, property: 'opacity', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1 }] },
      { target: cart.key, property: 'state', keyframes: [{ frame: 0, value: 'approach' }, { frame: cartMoveStart, value: 'approach' }, { frame: cartFrame, value: 'passing' }, { frame: finalFrame, value: 'continue' }] },
      { target: siege.key, property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: siegeRevealStart, value: 0 }, { frame: finalFrame, value: 1, easing: 'ease-in-out' }] },
      { target: siege.key, property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: siegeRevealStart, value: 0 }, { frame: Math.min(finalFrame, siegeRevealStart + Math.round(fps * 0.3)), value: 1, easing: 'linear' }, { frame: finalFrame, value: 1 }] },
    ],
    camera_tracks: [],
    cues: [
      { key: 'bag_contacts_ground', frame: bagFrame, kind: 'contact' },
      { key: 'cart_enters_lane', frame: cartMoveStart, kind: 'semantic', matched_transition: 'inside_to_outside' },
      { key: 'siege_closes', frame: siegeRevealStart, kind: 'semantic' },
    ],
    gate_requirements: [
      { key: 'bag_fall_range', metric: 'numeric_range', target: bag.key, property: 'y', min: 0.16 },
      { key: 'cart_ground_translation', metric: 'numeric_range', target: cart.key, property: 'x', min: 0.24 },
      { key: 'siege_formation_change', metric: 'numeric_range', target: siege.key, property: 'procedural_amount', min: 0.9 },
      { key: 'bag_contact_cue', metric: 'cue_exists', cue: 'bag_contacts_ground' },
    ],
  };
  const proofTargets = [
    { key: 'supply_bag_fall', frame: Math.max(1, bagFrame - Math.round(fps * 0.2)), target_node_key: bag.key, assertions: [{ type: 'track_range', target: bag.key, property: 'y', min: 0.16 }, { type: 'camera_only', expected: false }] },
    { key: 'supply_cart_lane', frame: cartFrame, target_node_key: cart.key, assertions: [{ type: 'track_range', target: cart.key, property: 'x', min: 0.24 }] },
    { key: 'siege_line_final', frame: finalFrame, target_node_key: siege.key, assertions: [{ type: 'track_range', target: siege.key, property: 'procedural_amount', min: 0.9 }] },
  ];
  return {
    catalog_key: 'siege-supply-sequence-v2', semanticContract,
    families: [environmentFamily, bagFamily, cartFamily], root, motionPlan, proofTargets,
    sceneBoundaryFrames: [boundaryFrame],
    timingAlignment: {
      bag: { caption_key: bagMatch.caption_key, confidence: bagMatch.confidence },
      cart: { caption_key: cartCaptionMatch.caption_key, confidence: cartCaptionMatch.confidence },
    },
    visualBeats: [
      { key: 'bag_fall', scene_key: 'scene_inside_city', subject_keys: [bag.key], source_caption_keys: bagMatch.caption_key ? [String(bagMatch.caption_key)] : [], start_frame: 0, peak_frame: Math.max(1, bagFrame - Math.round(fps * 0.3)), end_frame: bagFrame, minimum_hold_frames: Math.round(fps * 0.3), motion_verb: 'drop_and_settle' },
      { key: 'cart_advance', scene_key: 'scene_outside_road', subject_keys: [cart.key], source_caption_keys: cartCaptionMatch.caption_key ? [String(cartCaptionMatch.caption_key)] : [], start_frame: cartMoveStart, peak_frame: cartFrame, end_frame: Math.min(finalFrame, cartFrame + Math.round(fps * 0.3)), minimum_hold_frames: Math.round(fps * 0.3), motion_verb: 'enter_and_advance' },
      { key: 'siege_close', scene_key: 'scene_outside_road', subject_keys: [siege.key], source_caption_keys: cartCaptionMatch.caption_key ? [String(cartCaptionMatch.caption_key)] : [], start_frame: siegeRevealStart, peak_frame: Math.max(siegeRevealStart, finalFrame - Math.round(fps * 0.8)), end_frame: finalFrame, minimum_hold_frames: Math.round(fps * 0.8), motion_verb: 'close_encirclement' },
    ],
    summary: {
      catalog_key: 'siege-supply-sequence-v2', primary_action: 'siege_supply_sequence', camera_only: false,
      clean_plate_required: true, source_family_count: 3, required_asset_count: 3,
      entity_keys: blueprint.entities.map((entity) => entity.key),
      required_states: Object.fromEntries(blueprint.entities.map((entity) => [entity.key, entity.states])),
      relation_contracts: [], placement_regions: blueprint.environment.placement_regions || [], proof_targets: proofTargets,
      timing_alignment: {
        bag: { caption_key: bagMatch.caption_key, confidence: bagMatch.confidence },
        cart: { caption_key: cartCaptionMatch.caption_key, confidence: cartCaptionMatch.confidence },
      },
    },
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
      ...(actionObject ? [{ key: 'object_relation', start_frame: 0, peak_frame: actionFrame, end_frame: finalFrame, subject_key: actionObject.key, action: attachedObject ? (releaseRequested ? 'follow_and_release' : 'follow_subject') : 'move_independently_on_ground' }] : []),
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
    ? (actionObject.states.length >= 3 ? actionObject.states.slice(0, 3) : [actionObject.states[0] || 'held', releaseRequested ? 'carried' : 'active', releaseRequested ? 'released' : actionObject.states.at(-1) || 'settle'])
    : [];
  const independentObjectX = actionObject?.role === 'ground_vehicle' ? [-0.18, 0.1] : [-0.08, 0.08];
  const objectTracks = actionObject ? [
    { target: actionObject.key, property: 'x', keyframes: attachedObject
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
      ...(actionObject ? [{ key: attachedObject ? 'action_object_follows_subject' : 'independent_object_ground_translation', metric: 'numeric_range', target: actionObject.key, property: 'x', min: attachedObject ? translationThreshold : 0.12 }] : []),
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
    { key: 'subject_start', frame: 0, target_node_key: subject.key, assertions: [{ type: 'state_equals', target: subject.key, value: states[0] }, ...(attachedObject ? [{ type: 'relation_exists', node: actionObject.key, predicate: 'held-by' }] : [])] },
    { key: 'subject_action', frame: actionFrame, target_node_key: subject.key, assertions: [actionAssertion, ...(actionObject ? [{ type: 'track_range', target: actionObject.key, property: 'x', min: attachedObject ? translationThreshold : 0.12 }] : [])] },
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
  let plan;
  if (contract.primary_action === 'environmental_depth_motion') plan = environmentPlan(blueprint, context, config);
  else if (contract.primary_action === 'map_route_reveal') plan = mapRoutePlan(blueprint, context, config);
  else if (contract.primary_action === 'siege_supply_sequence') plan = siegeSupplyPlan(blueprint, context, config);
  else plan = contract.primary_action === 'carry_move_sit'
    ? compoundPlan(blueprint, context, config)
    : genericPlan(blueprint, context, config);
  assertCompiledRelationProvenance(blueprint, plan);
  visualSceneCompiler.applySceneContinuity(plan, blueprint, context);
  plan.summary = {
    ...(plan.summary || {}),
    planner_version: CURRENT_PLANNER_VERSION,
    spatial_contract: {
      placement_regions: blueprint.environment.placement_regions || [],
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
