const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const blueprintCompiler = require('../src/services/paper-studio/paperBlueprintCompilerService');
const sceneCompiler = require('../src/services/paper-studio/paperVisualSceneCompilerService');
const transitionGate = require('../src/services/paper-studio/paperTransitionGateService');
const spatialContractService = require('../src/services/paper-studio/paperSpatialContractService');
const renderService = require('../src/services/paper-studio/paperStudioRenderService');
const { resolveTargetMotion } = require('../src/paper-studio-renderer/motion/trackResolver.cjs');

function singleScenePlan({ fps = 30, duration = fps * 3, tracks = [] } = {}) {
  return {
    schema_version: 2,
    fps,
    duration_frames: duration,
    primary_action: 'generic_subject_action',
    camera_only: false,
    subject_tracks: tracks,
    camera_tracks: [],
    scene_tracks: [],
    transition_tracks: [],
    visual_beats: [],
    transition_contracts: [],
    motion_profile: 'normal',
    exceptions: [],
    cues: [],
  };
}

function scene(key, environment) {
  return { key, label: key, description: key, location: key, environment_family_key: environment, subject_keys: [], source_caption_keys: [], confidence: 1 };
}

test('顺序字幕匹配不会因重复宽泛关键词倒回第一句', () => {
  const captions = [
    { key: 'one', text: '秦军补给却没有断', start_frame: 0, end_frame: 96 },
    { key: 'two', text: '城池一旦陷落，秦军补给将决定战局', start_frame: 96, end_frame: 210 },
  ];
  const first = sceneCompiler.orderedCaptionMatch(captions, [/补给却没有断/, /秦军补给/], { edge: 'end' });
  const second = sceneCompiler.orderedCaptionMatch(captions, [/城池一旦陷落/, /秦军补给/], {
    edge: 'start', after_caption_key: first.caption_key, exclude_caption_keys: [first.caption_key],
  });
  assert.equal(first.caption_key, 'one');
  assert.equal(second.caption_key, 'two');
  assert.equal(second.frame, 96);
});

test('人物转身不是场景变化，镜头转向城外会拆成两个视觉场景', () => {
  assert.equal(sceneCompiler.inferVisualScenes({ title: '人物', action: '守城士兵转身看向城门。' }).length, 1);
  const scenes = sceneCompiler.inferVisualScenes({ title: '城防', action: '守城士兵站在城内。镜头转向城外，秦军粮车沿甬道前行。' });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[1].location, '城外');
  assert.equal(sceneCompiler.inferVisualScenes({ title: '补给', action: '城内粮袋落地；城外粮车继续前行。' }).length, 2);
});

test('同地点机位变化复用环境家族，时间跳跃使用独立关系类型', () => {
  const samePlace = sceneCompiler.inferVisualScenes({ title: '城防', action: '人物站在城内。镜头转向城内另一侧，士兵打开城门。' });
  assert.equal(samePlace.length, 2);
  assert.equal(samePlace[0].environment_family_key, samePlace[1].environment_family_key);
  assert.equal(sceneCompiler.inferredRelation(samePlace[0], samePlace[1]), 'camera_change');
  const later = { ...samePlace[1], time_context: 'time_jump', description: '三日后，城内已经空无一人' };
  assert.equal(sceneCompiler.inferredRelation(samePlace[0], later), 'time_jump');
});

test('一帧位移和两帧淡入会被秒级运动门禁拒绝', () => {
  const movement = singleScenePlan({ tracks: [{ target: 'actor', property: 'x', keyframes: [{ frame: 10, value: 0 }, { frame: 11, value: 0.2 }] }] });
  const moveReport = transitionGate.evaluate(movement, { planner_version: 9, visual_scenes: [scene('main', 'clean_environment')] });
  assert.equal(moveReport.pass, false);
  assert.ok(moveReport.failures.some((item) => item.key.includes('movement_duration')));

  const fade = singleScenePlan({ tracks: [{ target: 'actor', property: 'opacity', keyframes: [{ frame: 10, value: 0 }, { frame: 12, value: 1 }] }] });
  const fadeReport = transitionGate.evaluate(fade, { planner_version: 9, visual_scenes: [scene('main', 'clean_environment')] });
  assert.equal(fadeReport.pass, false);
  assert.ok(fadeReport.failures.some((item) => item.key.includes('opacity_duration')));
});

test('地点变化只有一个环境家族时失败', () => {
  const plan = singleScenePlan();
  plan.transition_contracts = [{
    key: 'inside_outside', from_scene_key: 'inside', to_scene_key: 'outside', relation: 'location_change', kind: 'hard_cut',
    start_frame: 20, end_frame: 20, hard_cut_allowed: true, hard_cut_reason: '测试明确撞击切镜', requires_new_plate: true,
    audio_policy: 'continuous', caption_policy: 'global_overlay',
  }];
  plan.motion_profile = 'hard_cut';
  const report = transitionGate.evaluate(plan, {
    planner_version: 9,
    visual_scenes: [scene('inside', 'same_environment'), scene('outside', 'same_environment')],
  });
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((item) => item.key.endsWith(':new_plate')));
});

test('显式硬切必须同时提供许可、原因和 hard_cut 配置', () => {
  const make = (authorized) => {
    const plan = singleScenePlan();
    plan.motion_profile = authorized ? 'hard_cut' : 'normal';
    plan.transition_contracts = [{
      key: 'impact_cut', from_scene_key: 'a', to_scene_key: 'b', relation: 'explicit_hard_cut', kind: 'hard_cut',
      start_frame: 20, end_frame: 20, hard_cut_allowed: authorized, hard_cut_reason: authorized ? '撞击重音明确切镜' : null,
      audio_policy: 'continuous', caption_policy: 'global_overlay',
    }];
    return transitionGate.evaluate(plan, { planner_version: 9, visual_scenes: [scene('a', 'a_env'), scene('b', 'b_env')] });
  };
  assert.equal(make(true).pass, true);
  assert.equal(make(false).pass, false);
});

test('12/24/30/60fps 使用等效 0.30 秒淡入阈值', () => {
  for (const fps of [12, 24, 30, 60]) {
    const frames = Math.round(fps * 0.3);
    const plan = singleScenePlan({ fps, duration: fps * 2, tracks: [{ target: 'actor', property: 'opacity', keyframes: [{ frame: 0, value: 0 }, { frame: frames, value: 1 }, { frame: fps * 2 - 1, value: 1 }] }] });
    const report = transitionGate.evaluate(plan, { planner_version: 9, visual_scenes: [scene('main', 'clean_environment')] });
    assert.equal(report.pass, true, `${fps}fps should pass: ${JSON.stringify(report.failures)}`);
  }
});

test('旧 v8/v3 快照仍可播放检查，但不能作为当前版本正式发布', () => {
  const snapshot = { schema_version: 3, motion_plan: { schema_version: 1 }, provenance: { planner_version: 8 } };
  assert.equal(renderService.assertSnapshotContinuity(snapshot).skipped, true);
  assert.throws(
    () => renderService.assertSnapshotContinuity(snapshot, { requireCurrent: true }),
    (error) => error.code === 'PAPER_STUDIO_PLANNER_VERSION_STALE',
  );
});

test('多节拍接地样例生成两场景、两环境、完整转场和长距离运输轨迹', () => {
  const context = {
    source_kind: 'paper',
    storyboard: {
      id: 37, title: '巨鹿危城', duration: 12,
      description: '空粮袋从守城士兵手中滑落。镜头转向城外，秦军粮车沿甬道前行，王离军包围圈逼近城墙。',
      action: '粮袋落地，镜头转向城外，粮车前行，军阵收紧。',
      audio_captions: [
        { key: 'narration_1', text: '巨鹿城内兵少粮尽，秦军补给却没有断', start_frame: 0, end_frame: 96 },
        { key: 'narration_2', text: '城池一旦陷落，反秦力量将被摧毁', start_frame: 96, end_frame: 318 },
      ],
    },
    characters: [{ id: 9, name: '王离', source_table: 'paper_library', identity_version_id: 3 }],
    props: [],
  };
  const blueprint = blueprintCompiler.infer(context);
  const plan = blueprintCompiler.compile(blueprint, context, { fps: 30 });
  const environmentFamilies = plan.families.filter((family) => family.slots.some((slot) => slot.asset_type === 'environment'));
  const cartTrack = plan.motionPlan.subject_tracks.find((track) => track.target === 'ground_transport_1' && track.property === 'x');
  const moving = sceneCompiler.orderedCaptionMatch(context.storyboard.audio_captions, /城池一旦陷落/, { edge: 'start', after_frame: 95 });
  assert.equal(plan.summary.planner_version, 11);
  assert.equal(plan.visualScenes.length, 2);
  assert.equal(environmentFamilies.length, 2);
  assert.equal(environmentFamilies[0].slots[0].constraints.reference_role, 'composition_and_style');
  assert.equal(environmentFamilies[1].slots[0].constraints.reference_role, 'style_only');
  assert.match(environmentFamilies[1].slots[0].constraints.environment_description, /粮车沿甬道前行/);
  assert.ok(plan.transitionContracts[0].end_frame - plan.transitionContracts[0].start_frame >= 18);
  assert.ok(cartTrack.keyframes[2].frame - cartTrack.keyframes[1].frame >= 30);
  assert.equal(plan.motionPlan.duration_frames, 360);
  assert.equal(moving.caption_key, 'narration_2');
  assert.equal(blueprint.entities.some((entity) => entity.name === '王离'), false);
  assert.equal(JSON.stringify(plan.root).includes('held-by'), false);
  assert.ok(plan.transitionContracts[0].confidence >= 0.9);
  assert.equal(plan.transitionContracts[0].audio_policy, 'continuous');
  assert.equal(plan.transitionContracts[0].caption_policy, 'global_overlay');
  assert.ok(plan.motionPlan.duration_frames - context.storyboard.audio_captions.at(-1).end_frame >= 15);
  const cartSpatialNode = plan.summary.spatial_contract.nodes.find((item) => item.key === 'ground_transport_1');
  assert.equal(cartSpatialNode.scene_key, 'scene_followup');
  assert.equal(spatialContractService.evaluatePlan(plan.motionPlan, plan.summary).pass, true);
});

test('六秒旁白会把十二秒多节拍分镜收束为七秒，末节拍落在语音尾部', () => {
  const context = {
    source_kind: 'paper',
    storyboard: {
      id: 38, title: '巨鹿危城', duration: 7,
      description: '空粮袋从守城士兵手中滑落。镜头转向城外，秦军粮车沿甬道前行，王离军包围圈逼近城墙。',
      action: '粮袋落地，镜头转向城外，粮车前行，军阵收紧。',
      audio_captions: [
        { key: 'narration_1', text: '巨鹿城内兵少粮尽，秦军补给却没有断', start_frame: 0, end_frame: 55 },
        { key: 'narration_2', text: '城池一旦陷落，反秦力量将被摧毁', start_frame: 55, end_frame: 180 },
      ],
    },
    characters: [], props: [],
  };
  const blueprint = blueprintCompiler.infer(context);
  const plan = blueprintCompiler.compile(blueprint, context, { fps: 30 });
  const finalBeat = plan.semanticContract.action_beats.find((beat) => beat.key === 'depth_change');
  assert.equal(plan.motionPlan.duration_frames, 210);
  assert.ok(finalBeat.start_frame < 180);
  assert.equal(finalBeat.end_frame, 209);
});

test('转场证明固定包含前、开始、中点、结束、后五个阶段', () => {
  const targets = sceneCompiler.transitionProofTargets([{ key: 't', from_scene_key: 'a', to_scene_key: 'b', start_frame: 30, end_frame: 48 }], 120);
  assert.deepEqual(targets.map((item) => item.transition_phase), ['pre', 'start', 'mid', 'end', 'post']);
  assert.deepEqual(targets.map((item) => item.frame), [29, 30, 39, 48, 49]);
  assert.ok(targets[0].assertions.some((item) => item.target === 'b' && item.property === 'opacity' && item.max === 0.05));
  assert.ok(targets[4].assertions.some((item) => item.target === 'a' && item.property === 'opacity' && item.max === 0.05));
  const tracks = sceneCompiler.sceneTracks([scene('a', 'a_env'), scene('b', 'b_env')], [{ key: 't', from_scene_key: 'a', to_scene_key: 'b', start_frame: 30, end_frame: 48, direction: 'left', kind: 'dust_whip_pan', relation: 'location_change', easing_in: 'ease-out', easing_out: 'ease-in' }], 120);
  const plan = { scene_tracks: tracks };
  assert.ok(resolveTargetMotion(plan, 'a', 49).opacity < 0.01);
  assert.ok(resolveTargetMotion(plan, 'b', 49).opacity > 0.99);
});

test('复用到第二场景的关联节点会一起改写引用，不会跨场景指向旧人物', () => {
  const scenes = [
    { ...scene('a', 'clean_environment'), subject_keys: ['actor', 'prop'] },
    { ...scene('b', 'clean_environment'), subject_keys: ['actor', 'prop'] },
  ];
  const blueprint = {
    environment: { description: '同一房间', placement_regions: [] },
    entities: [{ key: 'actor', name: '人物' }, { key: 'prop', name: '道具' }],
    visual_scenes: scenes,
    transition_contracts: [{ key: 'a_to_b', from_scene_key: 'a', to_scene_key: 'b', relation: 'camera_change', kind: 'soft_crossfade', duration_seconds: 0.5 }],
  };
  const node = (key, kind, slot, relation = {}, children = []) => ({ key, kind, pattern: 'free', slot, asset_version_id: null, transform: { x: 0.5, y: 0.5, width: 1, height: 1 }, relation, clip: {}, local_z: 0, children });
  const plan = {
    families: [{ family_key: 'clean_environment', pattern: 'registered-environment', registration_canvas: { width: 1920, height: 1080 }, slots: [{ slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true, constraints: {} }], contract: {} }],
    root: node('root', 'group', null, {}, [
      node('clean_environment', 'registered-environment', null, { family_key: 'clean_environment' }, [node('clean_plate', 'asset', 'clean_plate', { family_key: 'clean_environment' })]),
      node('actor', 'asset', 'actor_cutout', { family_key: 'actor_family' }),
      node('prop', 'asset', 'prop_cutout', { family_key: 'prop_family', predicate: 'held-by', object: 'actor' }),
    ]),
    motionPlan: singleScenePlan({ duration: 120, tracks: [{ target: 'actor', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 119, value: 0.1 }] }, { target: 'prop', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 119, value: 0.1 }] }] }),
    semanticContract: { schema_version: 3 }, proofTargets: [], summary: {},
  };
  sceneCompiler.applySceneContinuity(plan, blueprint, { storyboard: { duration: 4 } });
  const second = plan.root.children.find((item) => item.key === 'b');
  const clonedProp = second.children.find((item) => item.key === 'prop__b');
  assert.equal(clonedProp.relation.object, 'actor__b');
  assert.ok(plan.motionPlan.subject_tracks.some((track) => track.target === 'actor__b'));
});

test('同场景主体交接可以平滑通过，新场景在入场前完整可见会失败', () => {
  const scenes = [
    { ...scene('speaker', 'room_environment'), subject_keys: ['actor_a'] },
    { ...scene('listener', 'room_environment'), subject_keys: ['actor_b'] },
  ];
  const transition = {
    key: 'handoff', from_scene_key: 'speaker', to_scene_key: 'listener', relation: 'subject_change', kind: 'soft_crossfade',
    start_frame: 30, end_frame: 48, direction: 'left', easing_in: 'ease-out', easing_out: 'ease-in',
    requires_new_plate: false, audio_policy: 'continuous', caption_policy: 'global_overlay', hard_cut_allowed: false,
  };
  const plan = singleScenePlan({ duration: 120 });
  plan.transition_contracts = [transition];
  plan.scene_tracks = sceneCompiler.sceneTracks(scenes, [transition], 120);
  assert.equal(transitionGate.evaluate(plan, { planner_version: 9, visual_scenes: scenes }).pass, true);

  const invalid = structuredClone(plan);
  const incomingOpacity = invalid.scene_tracks.find((track) => track.target === 'listener' && track.property === 'opacity');
  incomingOpacity.keyframes[0].value = 1;
  incomingOpacity.keyframes[1].value = 1;
  const report = transitionGate.evaluate(invalid, { planner_version: 9, visual_scenes: scenes });
  assert.equal(report.pass, false);
  assert.ok(report.failures.some((item) => item.key.endsWith(':incoming_initially_hidden')));
});

test('普通模式限制突然旋转和缩放，同帧事件必须显式声明同步', () => {
  const abrupt = singleScenePlan({ tracks: [
    { target: 'actor', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 300 }] },
    { target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: 30, value: 2 }] },
  ] });
  abrupt.camera_tracks = [abrupt.subject_tracks.pop()];
  const abruptReport = transitionGate.evaluate(abrupt, { planner_version: 9, visual_scenes: [scene('main', 'clean_environment')] });
  assert.equal(abruptReport.pass, false);
  assert.ok(abruptReport.failures.some((item) => item.key.endsWith(':rotation_slope')));
  assert.ok(abruptReport.failures.some((item) => item.key.endsWith(':scale_slope')));

  const crowded = singleScenePlan();
  crowded.cues = [{ key: 'contact', frame: 20, kind: 'contact' }, { key: 'reveal', frame: 20, kind: 'subject_reveal' }];
  assert.equal(transitionGate.evaluate(crowded, { planner_version: 9 }).pass, false);
  crowded.cues = crowded.cues.map((item) => ({ ...item, matched_transition: 'contact_reveal' }));
  assert.equal(transitionGate.evaluate(crowded, { planner_version: 9 }).pass, true);
});

test('无旁白按剧本比例分配多场景，连续转场不会重叠或残留旧场景', () => {
  const scenes = [scene('inside', 'inside_env'), scene('road', 'road_env'), scene('camp', 'camp_env')];
  const transitions = sceneCompiler.buildTransitionContracts(scenes, {}, {}, [], 30, 300);
  const beats = sceneCompiler.visualBeats(scenes, transitions, 300, 30);
  assert.equal(transitions.length, 2);
  assert.ok(transitions[0].start_frame > 70 && transitions[0].start_frame < 120);
  assert.ok(transitions[1].start_frame > 170 && transitions[1].start_frame < 220);
  assert.ok(transitions[1].start_frame >= transitions[0].end_frame);
  assert.ok(beats.every((beat) => beat.end_frame - beat.peak_frame >= beat.minimum_hold_frames));

  const plan = singleScenePlan({ duration: 300 });
  plan.transition_contracts = transitions;
  plan.visual_beats = beats;
  plan.scene_tracks = sceneCompiler.sceneTracks(scenes, transitions, 300);
  const firstPost = transitions[0].end_frame + 1;
  const secondPre = transitions[1].start_frame - 1;
  assert.ok(resolveTargetMotion(plan, 'inside', firstPost).opacity < 0.01);
  assert.ok(resolveTargetMotion(plan, 'road', firstPost).opacity > 0.99);
  assert.ok(resolveTargetMotion(plan, 'road', secondPre).opacity > 0.99);
  assert.ok(resolveTargetMotion(plan, 'camp', secondPre).opacity < 0.01);
  assert.equal(transitionGate.evaluate(plan, { planner_version: 9, visual_scenes: scenes, visual_beats: beats }).pass, true);
});

test('五阶段渲染证明拦截闪变并确认转场后接地、字幕和声音合同', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-transition-proof-'));
  const scenes = [scene('a', 'a_env'), scene('b', 'b_env')];
  const transition = {
    key: 'a_to_b', from_scene_key: 'a', to_scene_key: 'b', relation: 'location_change', kind: 'dust_whip_pan',
    start_frame: 30, end_frame: 48, direction: 'left', easing_in: 'ease-out', easing_out: 'ease-in',
    requires_new_plate: true, audio_policy: 'continuous', caption_policy: 'global_overlay', hard_cut_allowed: false,
  };
  const plan = singleScenePlan({ duration: 90 });
  plan.subject_tracks = [{ target: 'actor', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 89, value: 0.1 }] }];
  plan.transition_contracts = [transition];
  plan.scene_tracks = sceneCompiler.sceneTracks(scenes, [transition], 90);
  plan.transition_tracks = sceneCompiler.transitionTracks([transition]);
  const targets = sceneCompiler.transitionProofTargets([transition], 90);
  const colors = {
    pre: { r: 80, g: 70, b: 60 }, start: { r: 80, g: 70, b: 60 }, mid: { r: 102, g: 85, b: 68 },
    end: { r: 68, g: 80, b: 92 }, post: { r: 68, g: 80, b: 92 },
  };
  try {
    const proofs = {};
    for (const target of targets) {
      const file = path.join(directory, `${target.key}.png`);
      await sharp({ create: { width: 64, height: 36, channels: 4, background: { ...colors[target.transition_phase], alpha: 1 } } }).png().toFile(file);
      proofs[target.key] = { crop_path: file, deterministic: true };
    }
    const report = await renderService.evaluateProof({
      provenance: { planner_version: 9, catalog_key: 'transition-proof-test' },
      motion_plan: plan,
      visual_scenes: scenes,
      visual_beats: [],
      transition_contracts: [transition],
      transition_gate: { pass: true },
      source_families: [],
      spatial_contract: {
        placement_regions: [], nodes: [],
        scenes: scenes.map((item) => ({ scene_key: item.key, environment_family_key: item.environment_family_key, placement_regions: [] })),
      },
      captions: [],
      root: null,
      proof_targets: targets,
    }, { proofs });
    assert.equal(report.pass, true, JSON.stringify({
      motion_failures: report.motion_gate?.assertions?.filter((assertion) => !assertion.pass),
      evidence_failures: report.evidence.flatMap((item) => item.assertions.filter((assertion) => !assertion.pass)),
    }));
    const post = report.evidence.find((item) => item.target.transition_phase === 'post');
    assert.ok(post.assertions.some((item) => item.type === 'transition_endpoint_stability' && item.pass));
    assert.ok(post.assertions.some((item) => item.type === 'transition_spatial_gate' && item.pass));
    assert.ok(post.assertions.some((item) => item.type === 'transition_caption_continuity' && item.pass));
    assert.ok(post.assertions.some((item) => item.type === 'transition_audio_continuity' && item.pass));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
