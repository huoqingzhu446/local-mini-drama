const test = require('node:test');
const assert = require('node:assert/strict');

const blueprintCompiler = require('../src/services/paper-studio/paperBlueprintCompilerService');
const spatialContract = require('../src/services/paper-studio/paperSpatialContractService');
const assetWorkspace = require('../src/services/paper-studio/paperAssetWorkspaceService');

function context(overrides = {}) {
  return {
    source_kind: 'paper',
    storyboard: {
      id: 17,
      title: '测试分镜',
      description: '',
      action: '',
      dialogue: '',
      narration: '',
      duration: 6,
      camera_motion: 'static',
      environment_only: false,
      audio_captions: [],
      ...overrides.storyboard,
    },
    characters: overrides.characters || [],
    props: overrides.props || [],
    scene: overrides.scene || null,
  };
}

test('王离军只表示组织时，不会把守城士兵替换成王离实体', () => {
  const blueprint = blueprintCompiler.infer(context({
    storyboard: {
      description: '守城士兵站在城门前，王离军在远处列阵。',
      action: '守城士兵低头查看最后一袋粮食。',
    },
    characters: [{ id: 9, name: '王离', source_table: 'paper_library', identity_version_id: 3 }],
  }));
  const actor = blueprint.entities.find((entity) => entity.key === 'actor_1');
  assert.equal(actor.name, '士兵');
  assert.equal(actor.source_library_id, null);
});

test('王离本人明确执行动作时，仍然绑定王离实体', () => {
  const blueprint = blueprintCompiler.infer(context({
    storyboard: { action: '王离下令收紧包围圈。' },
    characters: [{ id: 9, name: '王离', source_table: 'paper_library', identity_version_id: 3 }],
  }));
  const actor = blueprint.entities.find((entity) => entity.key === 'actor_1');
  assert.equal(actor.name, '王离');
  assert.equal(actor.source_library_id, 9);
});

test('多主体分镜进入通用多节拍接地模板，不生成角色手持大型运输道具', () => {
  const source = context({
    storyboard: {
      title: '巨鹿危城',
      description: '空粮袋从守城士兵手中滑落。城外秦军粮车沿甬道前行，王离军包围圈逐渐逼近城墙。',
      action: '粮袋落地，粮车前行，军阵收紧。',
    },
    characters: [{ id: 9, name: '王离', source_table: 'paper_library', identity_version_id: 3 }],
    props: [{ id: 27, name: '秦军粮车', source_table: 'paper_library', identity_version_id: 8 }],
  });
  const blueprint = blueprintCompiler.infer(source);
  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  assert.equal(plan.catalog_key, 'multi-beat-grounded-sequence-v1');
  assert.equal(blueprint.action_contract.primary_action, 'multi_beat_grounded_sequence');
  assert.equal(blueprint.entities.some((entity) => entity.name === '王离'), false);
  assert.equal(plan.root.children.some((node) => node.relation?.predicate === 'held-by'), false);
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const cart = flatten(plan.root).find((node) => node.key === 'ground_transport_1');
  const transportUnits = flatten(cart).filter((node) => node.relation?.role === 'transport_unit');
  assert.equal(cart.relation.placement.contact_kind, 'wheels');
  assert.equal(transportUnits.length, 3);
  assert.ok(transportUnits.every((node) => node.relation.embedded_movers.some((mover) => mover.role === 'pusher' && mover.min_visible >= 2)));
  assert.equal(spatialContract.evaluatePlan(plan.motionPlan, plan.summary).pass, true);
});

test('普通搬运车是独立接地道具，只有明确提起的行李箱才是 held-by', () => {
  const cartContext = context({
    storyboard: { action: '仓库员工看着物流手推车向前行。' },
    props: [{ id: 27, name: '物流手推车', source_table: 'paper_library', identity_version_id: 8 }],
  });
  const cartBlueprint = blueprintCompiler.infer(cartContext);
  const cartPlan = blueprintCompiler.compile(cartBlueprint, cartContext, { fps: 30 });
  const cart = cartPlan.root.children.find((node) => node.key === 'prop_1');
  assert.equal(cart.relation.predicate, undefined);
  assert.equal(cart.relation.placement.contact_kind, 'wheels');

  const luggageContext = context({
    storyboard: { action: '人物提起行李箱，从左向右走。' },
    props: [{ id: 2, name: '行李箱', source_table: 'props' }],
  });
  const luggageBlueprint = blueprintCompiler.infer(luggageContext);
  const luggagePlan = blueprintCompiler.compile(luggageBlueprint, luggageContext, { fps: 30 });
  const luggage = luggagePlan.root.children.find((node) => node.key === 'prop_1');
  assert.equal(luggage.relation.predicate, 'held-by');
});

test('历史 action 名只读归一化到通用编译器，未知 action 直接失败', () => {
  const pathContext = context({
    storyboard: { description: '物流地图上，路线从仓库延伸到门店。', action: '路径逐步显现并到达门店。' },
  });
  const legacyPath = structuredClone(blueprintCompiler.infer(pathContext));
  legacyPath.action_contract.primary_action = 'map_route_reveal';
  const pathPlan = blueprintCompiler.compile(legacyPath, pathContext, { fps: 30 });
  assert.equal(pathPlan.motionPlan.primary_action, 'path_reveal');
  assert.equal(pathPlan.catalog_key, 'blueprint-path-reveal-v1');

  const sequenceContext = context({
    storyboard: { description: '纸箱从货架滑落，搬运车穿过仓库，工作人员逐渐聚拢。', action: '纸箱落地，搬运车前行，人群靠近。' },
    props: [{ id: 28, name: '搬运车', source_table: 'paper_library', identity_version_id: 9 }],
  });
  const legacySequence = structuredClone(blueprintCompiler.infer(sequenceContext));
  legacySequence.action_contract.primary_action = 'siege_supply_sequence';
  const sequencePlan = blueprintCompiler.compile(legacySequence, sequenceContext, { fps: 30 });
  assert.equal(sequencePlan.motionPlan.primary_action, 'multi_beat_grounded_sequence');
  assert.equal(sequencePlan.catalog_key, 'multi-beat-grounded-sequence-v1');

  const unknown = structuredClone(blueprintCompiler.infer(context({ storyboard: { action: '人物向右走。' } })));
  unknown.action_contract.primary_action = 'execute_arbitrary_code';
  assert.throws(() => blueprintCompiler.compile(unknown, context(), { fps: 30 }));
});

test('现代配送分镜使用通用运输能力并保留可见骑行动力', () => {
  const source = context({
    storyboard: { description: '公寓街道的傍晚', action: '外卖员骑着自行车穿过街道，停在公寓楼下。' },
    characters: [{ id: 31, name: '外卖员', source_table: 'paper_library', identity_version_id: 11 }],
    props: [{ id: 32, name: '自行车', source_table: 'paper_library', identity_version_id: 12 }],
  });
  const blueprint = blueprintCompiler.infer(source);
  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  assert.equal(blueprint.action_contract.primary_action, 'transport_move');
  assert.equal(plan.catalog_key, 'blueprint-transport-move-v1');
  assert.equal(plan.summary.mobility_contracts[0].propulsion_mode, 'human_ridden');
  assert.equal(spatialContract.evaluatePlan(plan.motionPlan, plan.summary).pass, true);
});

test('奇幻飞行与落地分镜走通用主体动作，不依赖历史题材模板', () => {
  const source = context({
    storyboard: { description: '暮色山谷与高处岩台', action: '巨龙掠过山谷，落在岩台上。' },
    characters: [{ id: 41, name: '巨龙', source_table: 'paper_library', identity_version_id: 15 }],
  });
  const blueprint = blueprintCompiler.infer(source);
  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  assert.equal(blueprint.action_contract.primary_action, 'directed_move');
  assert.equal(plan.catalog_key, 'blueprint-directed_move-v1');
  assert.equal(plan.motionPlan.camera_only, false);
});

test('现代物流平面图使用通用路径揭示且产物不含战役外观', () => {
  const source = context({
    storyboard: { title: '包裹追踪', description: '物流地图上，包裹路线从仓库延伸到门店。', action: '路线逐步显现并到达门店。' },
  });
  const blueprint = blueprintCompiler.infer(source);
  const plan = blueprintCompiler.compile(blueprint, source, { fps: 30 });
  assert.equal(blueprint.action_contract.primary_action, 'path_reveal');
  assert.equal(plan.catalog_key, 'blueprint-path-reveal-v1');
  assert.deepEqual(plan.summary.path_waypoint_names, ['仓库', '中间节点', '门店']);
  assert.doesNotMatch(JSON.stringify(plan), /围城|军阵/);
});

test('粮车轨迹进入禁止区域时空间门禁失败', () => {
  const report = spatialContract.evaluatePlan({
    duration_frames: 180,
    subject_tracks: [{ target: 'cart', property: 'x', keyframes: [{ frame: 0, value: -0.33 }, { frame: 179, value: 0.27 }] }],
    camera_tracks: [],
  }, {
    planner_version: 8,
    spatial_contract: {
      placement_regions: [
        { key: 'road', kind: 'walkable', polygon: [[0.06, 0.7], [0.68, 0.7], [0.68, 0.94], [0.06, 0.94]], ground_y: 0.82 },
        { key: 'water', kind: 'forbidden', polygon: [[0.68, 0.48], [1, 0.48], [1, 1], [0.68, 1]] },
      ],
      nodes: [{ key: 'cart', base_x: 0.5, base_y: 0.82, placement: { support_kind: 'ground', region_key: 'road', contact_kind: 'wheels', contact_lock: true } }],
    },
  });
  assert.equal(report.pass, false);
  assert.ok(report.assertions.some((item) => item.key.includes('inside_region') && item.pass === false));
});

test('空间门禁检查关键帧之间的每一帧，不能穿越狭窄禁区', () => {
  const report = spatialContract.evaluatePlan({
    duration_frames: 11,
    subject_tracks: [{ target: 'cart', property: 'x', keyframes: [{ frame: 0, value: -0.3 }, { frame: 10, value: 0.3 }] }],
    camera_tracks: [],
  }, {
    planner_version: 8,
    spatial_contract: {
      placement_regions: [
        { key: 'road', kind: 'walkable', polygon: [[0.1, 0.7], [0.9, 0.7], [0.9, 0.94], [0.1, 0.94]], ground_y: 0.82 },
        { key: 'ditch', kind: 'forbidden', polygon: [[0.47, 0.7], [0.53, 0.7], [0.53, 0.94], [0.47, 0.94]] },
      ],
      nodes: [{ key: 'cart', base_x: 0.5, base_y: 0.82, placement: { support_kind: 'ground', region_key: 'road', contact_kind: 'wheels', contact_lock: true } }],
    },
  });
  assert.equal(report.pass, false);
  assert.ok(report.assertions.some((item) => item.key === 'spatial:cart:frame:5:inside_region' && item.pass === false));
});

test('允许区域边界计入区域内部，但与禁止区共边时仍会拦截', () => {
  assert.equal(spatialContract.pointInPolygon({ x: 0.68, y: 0.82 }, [[0.06, 0.7], [0.68, 0.7], [0.68, 0.94], [0.06, 0.94]]), true);
  assert.equal(spatialContract.pointInPolygon({ x: 0.68, y: 0.82 }, [[0.68, 0.48], [1, 0.48], [1, 1], [0.68, 1]]), true);
});

test('Alpha 边界底部生成接地点并适配 contain 盒子', () => {
  const version = {
    asset_type: 'character-cutout',
    constraints_json: JSON.stringify({ contact_kind: 'feet' }),
    registration_json: '{}',
    quality_report_json: JSON.stringify({ width: 1024, height: 1536, alpha_bbox: { x: 0.1, y: 0.03, width: 0.8, height: 0.94 } }),
  };
  const registration = spatialContract.rawRegistration(version);
  assert.equal(registration.contact_kind, 'feet');
  assert.equal(registration.contact_anchor.x, 0.5);
  assert.ok(Math.abs(registration.contact_anchor.y - 0.97) < 1e-9);
  const fitted = spatialContract.fittedContactAnchor({ transform: { width: 0.42, height: 0.62 } }, version);
  assert.ok(fitted.x > 0 && fitted.x < 1);
  assert.ok(fitted.y > 0.9 && fitted.y < 1);
});

test('跨生产版本按视觉合同复用同一分镜素材，不再被纯脚本修订号阻断', () => {
  const targetShot = { drama_id: 5, paper_storyboard_id: 17, paper_storyboard_revision_id: 47 };
  const targetSlot = { asset_type: 'prop-cutout', constraints_json: { identity: '秦军粮车' }, reuse_fingerprint: 'sha256:visual-contract-1' };
  const source = {
    id: 97,
    drama_id: 5,
    paper_storyboard_id: 17,
    paper_storyboard_revision_id: 47,
    asset_type: 'prop-cutout',
    constraints_json: JSON.stringify({ identity: '秦军粮车' }),
    status: 'accepted',
    approved_review_count: 1,
    reuse_fingerprint: 'sha256:visual-contract-1',
    quality_report_json: '{}',
  };
  assert.doesNotThrow(() => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, source));
  assert.throws(
    () => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, { ...source, constraints_json: JSON.stringify({ identity: '王离' }) }),
    (error) => error.code === 'PAPER_STUDIO_ASSET_REUSE_IDENTITY_MISMATCH',
  );
  assert.doesNotThrow(() => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, { ...source, paper_storyboard_revision_id: 46 }));
  assert.throws(
    () => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, { ...source, reuse_fingerprint: 'sha256:visual-contract-2' }),
    (error) => error.code === 'PAPER_STUDIO_ASSET_REUSE_VISUAL_CONTRACT_MISMATCH',
  );
});
