const test = require('node:test');
const assert = require('node:assert/strict');

const blueprintCompiler = require('../src/services/paper-studio/paperBlueprintCompilerService');
const motionGate = require('../src/services/paper-studio/paperMotionGateService');
const transitionGate = require('../src/services/paper-studio/paperTransitionGateService');

function context(storyboard = {}, overrides = {}) {
  return {
    source_kind: 'paper',
    storyboard: {
      id: 71,
      title: '运输镜头',
      description: '',
      action: '',
      narration: '',
      duration: 6,
      camera_motion: 'static',
      environment_only: false,
      audio_captions: [],
      ...storyboard,
    },
    characters: overrides.characters || [],
    props: overrides.props || [],
  };
}

function flatten(root) {
  return root ? [root, ...(root.children || []).flatMap(flatten)] : [];
}

test('运输队语义生成三组带动力成员的组合运输单位', () => {
  const source = context({
    title: '粮道运输',
    description: '粮道上，秦军粮车队源源不断前行。',
    action: '粮车队沿道路向前行进。',
  });
  const blueprint = blueprintCompiler.infer(source);
  const contract = blueprint.entities.find((entity) => entity.key === 'prop_1').attributes.mobility_contract;
  assert.equal(blueprint.action_contract.primary_action, 'transport_move');
  assert.equal(contract.propulsion_mode, 'human_push');
  assert.equal(contract.allow_self_motion, false);
  assert.equal(contract.required_movers[0].role, 'pusher');
  assert.equal(contract.required_movers[0].min_visible, 2);
  assert.equal(contract.unit_count.min_visible, 3);

  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  const vehicleGroup = flatten(plan.root).find((node) => node.key === 'prop_1');
  const units = flatten(vehicleGroup).filter((node) => node.relation?.role === 'transport_unit');
  const slot = plan.families.flatMap((family) => family.slots).find((item) => item.constraints?.subject_key === 'prop_1');
  assert.equal(plan.catalog_key, 'blueprint-transport-move-v1');
  assert.equal(vehicleGroup.kind, 'group');
  assert.equal(units.length, 3);
  assert.ok(units.every((unit) => unit.relation.embedded_movers[0].role === 'pusher'));
  assert.equal(slot.constraints.composite_subject, true);
  assert.equal(slot.constraints.single_subject, false);
  assert.equal(slot.constraints.allow_source_import, false);
  assert.equal(plan.summary.transition_gate.pass, true);
  assert.equal(motionGate.evaluate(plan.motionPlan, plan.summary).pass, true);
});

test('单辆近景保持一组运输单位，现代卡车允许自行驱动', () => {
  const singleSource = context({ action: '近景中一辆粮车从左向右前行。' });
  const singleBlueprint = blueprintCompiler.infer(singleSource);
  const singleContract = singleBlueprint.entities.find((entity) => entity.key === 'prop_1').attributes.mobility_contract;
  const singlePlan = blueprintCompiler.compile(singleBlueprint, singleSource, { fps: 30 });
  assert.equal(singleContract.unit_count.min_visible, 1);
  assert.equal(singleContract.unit_count.reason, 'representative_framing');
  assert.equal(flatten(singlePlan.root).filter((node) => node.relation?.role === 'transport_unit').length, 1);

  const truckSource = context({ action: '卡车从左向右驶入仓库。' });
  const truckBlueprint = blueprintCompiler.infer(truckSource);
  const truckContract = truckBlueprint.entities.find((entity) => entity.key === 'prop_1').attributes.mobility_contract;
  const truckPlan = blueprintCompiler.compile(truckBlueprint, truckSource, { fps: 30 });
  assert.equal(truckContract.propulsion_mode, 'self_powered');
  assert.equal(truckContract.allow_self_motion, true);
  assert.deepEqual(truckContract.required_movers, []);
  assert.equal(truckPlan.summary.transition_gate.pass, true);
});

test('明确推车角色绑定为动力成员，不再创建手持粮车关系', () => {
  const source = context(
    { action: '守城士兵推着粮车从左向右前行。' },
    { characters: [{ id: 9, name: '守城士兵', source_table: 'characters' }] },
  );
  const blueprint = blueprintCompiler.infer(source);
  const vehicle = blueprint.entities.find((entity) => entity.key === 'prop_1');
  assert.equal(blueprint.action_contract.primary_action, 'transport_move');
  assert.equal(blueprint.action_contract.object_key, 'actor_1');
  assert.equal(vehicle.attributes.mobility_contract.operator_entity_key, 'actor_1');
  assert.ok(blueprint.relations.some((relation) => relation.key === 'operator_moves_transport' && relation.predicate === 'interacts_with'));
  assert.equal(blueprint.relations.some((relation) => relation.predicate === 'holds' && relation.object_key === 'prop_1'), false);
});

test('移动门禁拒绝缺少动力成员或不足运输规模的组合', () => {
  const source = context({
    title: '粮道运输',
    description: '粮道上的粮车队源源不断前行。',
    action: '粮车队从左向右行进。',
  });
  const blueprint = blueprintCompiler.infer(source);
  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  const invalidRoot = structuredClone(plan.root);
  const vehicleGroup = flatten(invalidRoot).find((node) => node.key === 'prop_1');
  vehicleGroup.children = vehicleGroup.children.slice(0, 1);
  vehicleGroup.children[0].relation.embedded_movers = [];
  const report = transitionGate.evaluate(plan.motionPlan, {
    planner_version: 10,
    visual_scenes: plan.visualScenes,
    transition_contracts: plan.transitionContracts,
    semantic_contract: plan.semanticContract,
    root: invalidRoot,
    families: plan.families,
    spatial_contract: plan.summary.spatial_contract,
    visual_beats: plan.visualBeats,
  });
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((item) => item.key === 'mobility:prop_1:unit_count'));
  assert.ok(report.failures.some((item) => item.key === 'mobility:prop_1:causal_power'));
});
