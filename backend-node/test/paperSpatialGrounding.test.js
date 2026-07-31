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

test('巨鹿危城进入多阶段接地模板，不生成王离手持粮车', () => {
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
  assert.equal(plan.catalog_key, 'siege-supply-sequence-v2');
  assert.equal(blueprint.entities.some((entity) => entity.name === '王离'), false);
  assert.equal(plan.root.children.some((node) => node.relation?.predicate === 'held-by'), false);
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const cart = flatten(plan.root).find((node) => node.key === 'supply_cart');
  assert.equal(cart.relation.placement.contact_kind, 'wheels');
  assert.equal(spatialContract.evaluatePlan(plan.motionPlan, plan.summary).pass, true);
});

test('普通粮车是独立接地道具，只有明确提起的行李箱才是 held-by', () => {
  const cartContext = context({
    storyboard: { action: '守城士兵看着秦军粮车向前行。' },
    props: [{ id: 27, name: '秦军粮车', source_table: 'paper_library', identity_version_id: 8 }],
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

test('跨生产版本只允许复用同分镜修订、同类型、同主体的已批准素材', () => {
  const targetShot = { drama_id: 5, paper_storyboard_id: 17, paper_storyboard_revision_id: 47 };
  const targetSlot = { asset_type: 'prop-cutout', constraints_json: { identity: '秦军粮车' } };
  const source = {
    id: 97,
    drama_id: 5,
    paper_storyboard_id: 17,
    paper_storyboard_revision_id: 47,
    asset_type: 'prop-cutout',
    constraints_json: JSON.stringify({ identity: '秦军粮车' }),
    status: 'accepted',
    approved_review_count: 1,
    quality_report_json: '{}',
  };
  assert.doesNotThrow(() => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, source));
  assert.throws(
    () => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, { ...source, constraints_json: JSON.stringify({ identity: '王离' }) }),
    (error) => error.code === 'PAPER_STUDIO_ASSET_REUSE_IDENTITY_MISMATCH',
  );
  assert.throws(
    () => assetWorkspace.assertReusableSourceCompatibility(targetShot, targetSlot, { ...source, paper_storyboard_revision_id: 46 }),
    (error) => error.code === 'PAPER_STUDIO_ASSET_REUSE_SOURCE_REVISION_MISMATCH',
  );
});
