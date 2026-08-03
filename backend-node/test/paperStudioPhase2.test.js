const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyzer = require('../src/services/paper-studio/paperStudioAnalyzerService');
const motionGate = require('../src/services/paper-studio/paperMotionGateService');
const schema = require('../src/services/paper-studio/paperStudioSchemaService');
const { numericRange } = require('../src/paper-studio-renderer/motion/trackResolver.cjs');

const scene = { id: 8, prompt: '没有人物和关键道具的古代室内或河岸干净背景' };
const characters = [
  { id: 1, name: '项羽', appearance: '高大、玄甲、红披风', local_path: 'characters/xiangyu.png', source_table: 'characters' },
  { id: 2, name: '虞姬', appearance: '青衣、长发、玉簪', local_path: 'characters/yuji.png', source_table: 'characters' },
];
const props = [
  { id: 10, name: '令箭', type: '军令', description: '黑木令箭', local_path: 'props/token.png' },
  { id: 11, name: '军帐书案', type: '桌案', description: '深色木制书案', local_path: 'props/table.png' },
];

function build(storyboard, overrides = {}) {
  return analyzer.buildPlan({ storyboard: { id: 100, duration: 5, ...storyboard }, scene, characters, props, ...overrides }, { fps: 30 });
}

function assertPlan(plan, catalogKey) {
  assert.equal(plan.catalog_key, catalogKey);
  assert.equal(plan.motionPlan.camera_only, false);
  assert.equal(schema.validate('semanticContract', plan.semanticContract).valid, true);
  assert.equal(schema.validate('compositionNode', plan.root).valid, true);
  assert.equal(schema.validate('motionPlan', plan.motionPlan).valid, true);
  assert.ok(plan.families.every((family) => schema.validate('sourceFamily', family).valid));
  assert.ok(plan.proofTargets.every((target) => schema.validate('proofTarget', target).valid));
  assert.ok(plan.summary.semantic_primitives.includes('independent_asset_versions'));
  assert.ok(plan.summary.semantic_primitives.includes('state_transition'));
  const gate = motionGate.evaluate(plan.motionPlan, plan.summary);
  assert.equal(gate.pass, true, JSON.stringify(gate.assertions));
  assert.equal(gate.camera_only, false);
  assert.ok(gate.assertions.some((item) => item.metric));
}

test('multi-subject interaction capability creates two independent identity families and turn-taking motion', () => {
  const plan = build({ title: '帐中问答', dialogue: '项羽质问，虞姬低声回答', action: '二人交谈后彼此反应' }, { props: [] });
  assertPlan(plan, 'multi-subject-interaction-v1');
  assert.deepEqual(plan.families.map((family) => family.family_key), ['clean_environment', 'actor_a', 'actor_b']);
  assert.ok(plan.motionPlan.subject_tracks.some((track) => track.target === 'actor_a' && track.property === 'state'));
  assert.ok(plan.motionPlan.subject_tracks.some((track) => track.target === 'actor_b' && track.property === 'state'));
});

test('attached-prop capability binds an independently generated prop to the actor contact zone', () => {
  const plan = build({ title: '高举令箭', action: '项羽拿起令箭，握住后高举示众' }, { props: [props[0]], characters: [characters[0]] });
  assertPlan(plan, 'attached-prop-action-v1');
  const propNode = plan.root.children.find((node) => node.key === 'held_action_group').children.find((node) => node.key === 'held_prop');
  assert.equal(propNode.relation.predicate, 'held-by');
  assert.equal(propNode.relation.contact_zone, 'front_hand');
  assert.equal(plan.families.find((family) => family.family_key === 'held_prop').slots[0].constraints.allow_source_import, false);
  assert.ok(plan.motionPlan.subject_tracks.some((track) => track.target === 'held_prop' && track.property === 'y'));
});

test('foreground-occlusion capability creates rear support, subject and derived front occluder slots', () => {
  const plan = build({ title: '帐中拍案', action: '项羽坐在书案后猛然拍案' }, { props: [props[1]], characters: [characters[0]] });
  assertPlan(plan, 'foreground-occlusion-v1');
  const family = plan.families.find((item) => item.family_key === 'foreground_support');
  assert.deepEqual(family.slots.map((slot) => slot.slot_key), ['support_body', 'support_front']);
  assert.equal(family.slots[0].constraints.allow_source_import, false);
  assert.equal(family.slots[1].constraints.source_slot, 'support_body');
  const group = plan.root.children.find((node) => node.key === 'supported_group');
  assert.deepEqual(group.children.map((node) => node.relation.role), ['rear-support', 'subject', 'front-occluder']);
});

test('registered-boundary capability requires visible subject crossing plus final occlusion', () => {
  const plan = build({ title: '涉水登岸', location: '漳河浅滩', action: '项羽从岸边踏入水中涉水前进' }, { props: [], characters: [characters[0]] });
  assertPlan(plan, 'registered-boundary-crossing-v1');
  assert.deepEqual(plan.semanticContract.environment.registered_boundaries, ['primary_boundary']);
  assert.ok(plan.root.children.some((node) => node.key === 'boundary_front' && node.relation.occludes.includes('actor')));
  const occlusionRequirement = plan.motionPlan.gate_requirements.find((item) => item.key === 'boundary_occlusion');
  assert.equal(occlusionRequirement.min >= 0.45, true);
});

test('environment-only establishing shot plans atmospheric depth instead of inventing a title-named character', () => {
  const plan = build({ title: '寒雾建立镜头', action: '', description: '寒雾清晨的河岸大远景' }, { props: [], characters: [] });
  assertPlan(plan, 'environmental-depth-motion-v1');
  assert.equal(plan.semanticContract.subjects[0].kind, 'effect');
  assert.equal(plan.semanticContract.subjects[0].identity.includes('寒雾建立镜头'), false);
  assert.ok(plan.root.children.some((node) => node.relation?.procedural_kind === 'atmosphere-drift'));
  assert.equal(plan.motionPlan.primary_action, 'environmental_depth_motion');
});

test('flat-diagram shot reveals a registered path and completion marker without a fake character or generated labels', () => {
  const plan = build({ title: '战线北移', action: '镜头沿旧绢地图由定陶向北推进，路线逐段延伸并在巨鹿合拢，文字留给后期' }, {
    scene: { id: 9, prompt: '无文字的旧绢战略地图干净背景' }, props: [], characters: [],
  });
  assertPlan(plan, 'path-reveal-v1');
  assert.equal(plan.semanticContract.subjects[0].kind, 'effect');
  assert.ok(plan.root.children.filter((node) => node.relation?.procedural_kind === 'path-reveal').length >= 2);
  assert.equal(plan.motionPlan.primary_action, 'path_reveal');
  assert.ok(plan.summary.relation_contracts.includes('no generated text'));
});

test('multi-object montage plans impact states, contact tool, secondary reveal and procedural transition', () => {
  const plan = build({ title: '物件连续动作', action: '木槌落下将陶釜击碎；甩镜到三日口粮袋；再甩向燃烧营舍' }, {
    characters: [], props,
  });
  assertPlan(plan, 'object-sequence-transition-v1');
  assert.deepEqual(plan.families.find((family) => family.family_key === 'impact_subject').slots.map((slot) => slot.constraints.state), ['intact', 'fracture', 'broken']);
  assert.ok(plan.root.children.some((node) => node.key === 'impact_tool' && node.relation.predicate === 'contacts'));
  assert.ok(plan.motionPlan.subject_tracks.some((track) => track.target === 'secondary_prop' && track.property === 'opacity'));
  const toolOpacity = plan.motionPlan.subject_tracks.find((track) => track.target === 'impact_tool' && track.property === 'opacity');
  const impactOpacity = plan.motionPlan.subject_tracks.find((track) => track.target === 'impact_subject' && track.property === 'opacity');
  const cameraPan = plan.motionPlan.camera_tracks.find((track) => track.target === 'camera' && track.property === 'x');
  assert.equal(toolOpacity.keyframes[0].value, 0);
  assert.ok(toolOpacity.keyframes.some((keyframe) => keyframe.value === 1 && keyframe.frame < plan.motionPlan.cues.find((cue) => cue.key === 'impact').frame));
  assert.equal(toolOpacity.keyframes.at(-1).value, 0);
  assert.equal(impactOpacity.keyframes.at(-1).value, 0);
  assert.ok(numericRange(cameraPan) >= 0.12);
  assert.ok(plan.motionPlan.cues.some((cue) => cue.key === 'focus_transfer'));
  assert.ok(plan.motionPlan.cues.some((cue) => cue.key === 'tool_entry'));
  const gate = motionGate.evaluate(plan.motionPlan, plan.summary);
  assert.equal(gate.pass, true);
  assert.equal(gate.assertions.find((item) => item.key === 'tool_hidden_initial').actual, 0);
  assert.equal(gate.assertions.find((item) => item.key === 'tool_visible_at_impact').actual, 1);
  assert.ok(plan.proofTargets.find((target) => target.key === 'object_start').assertions.some((assertion) => assertion.type === 'track_value_at_frame' && assertion.max === 0.05));
  assert.ok(plan.root.children.some((node) => node.relation?.procedural_kind === 'transition-effect'));
  assert.match(plan.semanticContract.subjects.find((subject) => subject.key === 'impact_tool').identity, /用于完成主体作用动作的独立工具/);
  assert.equal(plan.families.find((family) => family.family_key === 'secondary_prop').slots[0].constraints.allow_source_import, false);
});

test('collective supported-boundary action keeps a multi-person group and regenerates the support cutout', () => {
  const plan = build({ title: '通用边界转换', action: '士卒合力推动承载物，随后主体下沉并穿过水面边界' }, {
    characters: [], props: [props[0]],
  });
  assertPlan(plan, 'supported-boundary-transition-v1');
  const family = plan.families.find((item) => item.family_key === 'supported_subject_family');
  assert.equal(family.slots.find((slot) => slot.slot_key === 'support_body').constraints.allow_source_import, false);
  assert.deepEqual(family.slots.find((slot) => slot.slot_key === 'actor_engage').constraints.group_size, [2, 4]);
  assert.equal(plan.semanticContract.subjects.find((subject) => subject.key === 'actors').identity.includes('群组'), true);
  assert.deepEqual(plan.summary.actor_group_size, [2, 4]);
});

test('unmatched no-subject action is blocked instead of becoming a title-named paper character', () => {
  assert.throws(
    () => build({ title: '抽象标题', action: '发生一个无法识别的抽象变化' }, { props: [], characters: [] }),
    (error) => error.code === 'PAPER_STUDIO_SEMANTIC_SUBJECT_MISSING',
  );
});

test('all capability plans fail when their subject tracks are removed even if camera motion remains', () => {
  const plan = build({ title: '帐中问答', dialogue: '项羽质问，虞姬回答', action: '二人对话' }, { props: [] });
  const invalid = { ...plan.motionPlan, subject_tracks: [] };
  const gate = motionGate.evaluate(invalid, plan.summary);
  assert.equal(gate.pass, false);
  assert.equal(gate.camera_only, true);
  assert.ok(gate.assertions.some((item) => item.key === 'visible_subject_tracks' && !item.pass));
});

test('production protocol contains no test-scene identifiers', () => {
  const serviceRoot = path.join(__dirname, '..', 'src', 'services', 'paper-studio');
  const rendererRoot = path.join(__dirname, '..', 'src', 'paper-studio-renderer');
  const files = [
    path.join(serviceRoot, 'paperStudioAnalyzerService.js'),
    path.join(serviceRoot, 'paperAssetProductionService.js'),
    path.join(serviceRoot, 'paperMotionGateService.js'),
    path.join(serviceRoot, 'paperStudioRenderService.js'),
    path.join(rendererRoot, 'ProceduralLayer.jsx'),
  ];
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const forbidden of [
    'sink-boat-v1', 'supported_sink', 'boat_with_soldiers', 'soldiers_push', 'water_front', 'registered-water-mask-v1',
    '凿沉', '船尾', '船舱', '木槌', '粮袋', '营火', '破釜', '巨鹿', '定陶', 'boat', 'ship', 'pottery',
  ]) {
    assert.equal(source.includes(forbidden), false, `production protocol leaked fixture identifier: ${forbidden}`);
  }
});
