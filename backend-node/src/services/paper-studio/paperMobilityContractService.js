const SELF_POWERED_PATTERN = /(汽车|卡车|货车|摩托车|火车|机车|坦克|装甲车|电动车|拖拉机|巴士|公交车)/;
const RIDDEN_PATTERN = /(自行车|脚踏车|单车)/;
const ANIMAL_DRAWN_PATTERN = /(马车|牛车|驴车|骡车)/;
const CREW_OPERATED_PATTERN = /(大型器械|多人操作平台|轿子|担架)/;
const HUMAN_PUSH_PATTERN = /(手推车|独轮车|板车|推车|搬运车)/;
const GENERIC_VEHICLE_NAME_PATTERN = /[\p{Script=Han}]{1,8}车(?:队)?$/u;
const GROUND_MOBILITY_PATTERN = new RegExp([
  SELF_POWERED_PATTERN.source,
  RIDDEN_PATTERN.source,
  ANIMAL_DRAWN_PATTERN.source,
  CREW_OPERATED_PATTERN.source,
  HUMAN_PUSH_PATTERN.source,
  GENERIC_VEHICLE_NAME_PATTERN.source,
  '(车辆|运输车)',
].join('|'), 'u');
const MOVEMENT_PATTERN = /(前行|行进|移动|驶向|驶入|驶出|推进|穿过|进入|离开|运送|运输|赶往|通过|开往|向前|走)/;
const CONVOY_SCALE_PATTERN = /(运输队|运输车组|成队|连续多辆|多组运输|源源不断)/;
const REPRESENTATIVE_PATTERN = /(一辆|单辆|单车|特写|近景|代表性镜头)/;

function storyboardText(context = {}, entity = null) {
  const storyboard = context.storyboard || {};
  return [
    storyboard.title,
    storyboard.description,
    storyboard.action,
    storyboard.result,
    storyboard.dialogue,
    storyboard.narration,
    storyboard.location,
    context.scene?.prompt,
    entity?.name,
    entity?.attributes?.source_evidence,
  ].filter(Boolean).join('，');
}

function isGroundMobilityEntity(entity = {}) {
  return entity.role === 'ground_vehicle' || GROUND_MOBILITY_PATTERN.test(String(entity.name || ''));
}

function propulsionFor(entity, text) {
  const name = String(entity.name || '');
  if (SELF_POWERED_PATTERN.test(name)) return 'self_powered';
  if (RIDDEN_PATTERN.test(name)) return 'human_ridden';
  if (/(牛|马|驴|骡).{0,6}(?:拉|牵|挽)|牲畜牵引|畜力/.test(text) || ANIMAL_DRAWN_PATTERN.test(name)) return 'animal_drawn';
  if (CREW_OPERATED_PATTERN.test(name)) return 'crew_operated';
  if (/(?:拉着|拖着|牵着|人力牵引)/.test(text)) return 'human_pull';
  if (/(?:推着|推动|推行|人力推)/.test(text) || HUMAN_PUSH_PATTERN.test(name)) return 'human_push';
  // Unknown non-motorized ground vehicles must not silently become
  // self-propelled. A visible human power source is the safest paper-animation
  // fallback and can be overridden in the editable blueprint.
  return 'human_push';
}

function moversFor(mode, entity) {
  const name = String(entity.name || '');
  if (mode === 'self_powered') return [];
  if (mode === 'animal_drawn') return [{ role: 'draft_animal', min_visible: 1, relation: 'harnessed_to' }];
  if (mode === 'human_ridden') return [{ role: 'rider', min_visible: 1, relation: 'rides' }];
  if (mode === 'crew_operated') {
    const minVisible = /(轿子|担架)/.test(name) ? 2 : 4;
    return [{ role: 'crew', min_visible: minVisible, relation: 'operates' }];
  }
  if (mode === 'human_pull') return [{ role: 'puller', min_visible: 1, relation: 'pulls' }];
  const minVisible = /(手推车|独轮车)/.test(name) ? 1 : 2;
  return [{ role: 'pusher', min_visible: minVisible, relation: 'pushes' }];
}

function operatorBinding(blueprint, entity, text) {
  if (blueprint.action_contract?.primary_action !== 'transport_move') return null;
  const candidate = blueprint.entities.find((item) => item.key === blueprint.action_contract.object_key && item.type === 'character');
  if (!candidate) return null;
  if (!/(推着|推动|推行|拉着|拖着|牵着|驾驶|驾着|骑着|抬着|操作)/.test(text)) return null;
  return candidate.key;
}

function inferContract(blueprint, entity, context = {}) {
  const text = storyboardText(context, entity);
  const existing = entity.attributes?.mobility_contract;
  if (existing?.schema_version === 1 && existing.subject_key === entity.key) return existing;
  const propulsionMode = propulsionFor(entity, text);
  const representative = REPRESENTATIVE_PATTERN.test(text);
  const convoyScale = CONVOY_SCALE_PATTERN.test(text) && !representative;
  const minVisible = convoyScale ? 3 : 1;
  const movementExpected = MOVEMENT_PATTERN.test(text)
    || blueprint.action_contract?.primary_action === 'transport_move'
    || blueprint.action_contract?.primary_action === 'multi_beat_grounded_sequence';
  return {
    schema_version: 1,
    subject_key: entity.key,
    mobility_class: propulsionMode === 'self_powered' ? 'motor_vehicle' : 'non_self_propelled_transport',
    propulsion_mode: propulsionMode,
    allow_self_motion: propulsionMode === 'self_powered',
    movement_expected: movementExpected,
    required_movers: moversFor(propulsionMode, entity),
    operator_entity_key: operatorBinding(blueprint, entity, text),
    unit_count: {
      min_visible: minVisible,
      target_visible: minVisible,
      reason: representative ? 'representative_framing' : convoyScale ? 'convoy_scale' : 'single_unit',
    },
    formation: minVisible > 1 ? 'staggered_convoy' : 'single_unit',
    evidence: convoyScale ? '文本或镜头表达连续运输规模' : representative ? '文本明确单辆或代表性近景' : '普通运输单位',
    confidence: convoyScale || representative ? 0.94 : 0.82,
  };
}

function annotateBlueprint(blueprint, context = {}) {
  for (const entity of blueprint.entities || []) {
    if (!isGroundMobilityEntity(entity)) continue;
    entity.role = 'ground_vehicle';
    entity.attributes = {
      ...(entity.attributes || {}),
      mobility_contract: inferContract(blueprint, entity, context),
    };
  }
  return blueprint;
}

function contractsFromBlueprint(blueprint = {}) {
  return (blueprint.entities || [])
    .map((entity) => entity.attributes?.mobility_contract)
    .filter(Boolean);
}

function flattenNodes(root) {
  if (!root) return [];
  return [root, ...(root.children || []).flatMap(flattenNodes)];
}

function runtimeAssemblies(root, families = [], contracts = []) {
  const nodes = flattenNodes(root);
  return contracts.map((contract) => {
    const subject = nodes.find((node) => node.key === contract.subject_key) || null;
    const units = subject
      ? flattenNodes(subject).slice(1).filter((node) => node.relation?.role === 'transport_unit')
      : [];
    const slot = families.flatMap((family) => family.slots || []).find((candidate) => (
      candidate.constraints?.subject_key === contract.subject_key
      && candidate.constraints?.ensemble_kind === 'transport_unit'
    ));
    return {
      subject_key: contract.subject_key,
      group_compiled: Boolean(subject?.kind === 'group' && subject.relation?.role === 'ground_vehicle'),
      composite_asset_contract: Boolean(slot?.constraints?.composite_subject),
      units: units.map((unit) => ({ key: unit.key, transform: unit.transform, relation: unit.relation })),
    };
  });
}

module.exports = {
  GROUND_MOBILITY_PATTERN,
  GENERIC_VEHICLE_NAME_PATTERN,
  MOVEMENT_PATTERN,
  annotateBlueprint,
  contractsFromBlueprint,
  inferContract,
  isGroundMobilityEntity,
  runtimeAssemblies,
};
