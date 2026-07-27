// M1–M5 运动质量回归（纸片动画优化方案 §12.3）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const resolver = require(path.join(__dirname, '..', 'src', 'paper-studio-renderer', 'motion', 'trackResolver.cjs'));
const secondary = require(path.join(__dirname, '..', 'src', 'paper-studio-renderer', 'motion', 'secondaryMotion.cjs'));
const naturalizer = require(path.join(__dirname, '..', 'src', 'services', 'paper-studio', 'paperMotionNaturalizerService.js'));

test('缓动库：新曲线端点正确且有过冲/回摆特征', () => {
  for (const name of ['ease-in-quint', 'ease-out-quint', 'ease-out-back', 'spring', 'stepped-ease']) {
    assert.ok(Math.abs(resolver.ease(name, 0)) < 0.02, `${name}(0)≈0`);
    assert.ok(Math.abs(resolver.ease(name, 1) - 1) < 0.06, `${name}(1)≈1`);
  }
  // ease-out-back 中途必须超过 1（过冲）
  const overshoot = Math.max(...[...Array(50)].map((_, i) => resolver.ease('ease-out-back', i / 49)));
  assert.ok(overshoot > 1.01, '过冲存在');
  // spring 必须回摆（越过 1 再回落）
  const springValues = [...Array(100)].map((_, i) => resolver.ease('spring', i / 99));
  assert.ok(Math.max(...springValues) > 1.02, '弹簧越过目标');
});

test('easing_params 生效：不同 s 产生不同过冲量', () => {
  const track = (s) => ({ keyframes: [{ frame: 0, value: 0 }, { frame: 100, value: 1, easing: 'ease-out-back', easing_params: { s } }] });
  const midSmall = resolver.resolveTrackValue(track(1.05), 80);
  const midLarge = resolver.resolveTrackValue(track(2.2), 80);
  assert.ok(midLarge > midSmall, '更大的 s → 更大过冲');
});

test('stateTransition：切换后按 fade 帧数给出过渡进度', () => {
  const plan = { subject_tracks: [{ target: 'actor_1', property: 'state', keyframes: [
    { frame: 0, value: 'standing' }, { frame: 30, value: 'seated' },
  ] }] };
  assert.equal(resolver.stateTransition(plan, 'actor_1', 10, 3).previous, null);
  const mid = resolver.stateTransition(plan, 'actor_1', 31, 3);
  assert.equal(mid.current, 'seated');
  assert.equal(mid.previous, 'standing');
  assert.ok(mid.progress > 0 && mid.progress < 1);
  assert.equal(resolver.stateTransition(plan, 'actor_1', 40, 3).previous, null, '过渡完成后不再保留旧状态');
});

test('次级运动：确定性、off 档为零、移动才有步态', () => {
  const base = { role: 'actor', frame: 42, fps: 30, velocity: { vx: 0.004, vy: 0, speed: 0.004 }, seedKey: '1:actor_1', config: { secondary: 'subtle' }, relativeHeight: 1, tall: true };
  const a = secondary.secondaryDelta(base);
  const b = secondary.secondaryDelta(base);
  assert.deepEqual(a, b, '同帧同种子结果一致');
  assert.ok(a.y < 0, '移动时有步态起伏');
  const off = secondary.secondaryDelta({ ...base, config: { secondary: 'off' } });
  assert.deepEqual(off, { x: 0, y: 0, rotation: 0, scaleY: 0, skewX: 0 });
  const idle = secondary.secondaryDelta({ ...base, velocity: { vx: 0, vy: 0, speed: 0 } });
  assert.equal(idle.y, 0, '静止无步态');
  assert.notEqual(idle.scaleY, 0, '静止有呼吸');
});

test('naturalize：null 配置原样返回（旧 snapshot 兼容合同 N8）', () => {
  const plan = { duration_frames: 90, subject_tracks: [{ target: 'actor_1', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 89, value: 0.3 }] }], camera_tracks: [] };
  assert.equal(naturalizer.naturalize(plan, null, resolver.resolveTrackValue), plan);
});

test('naturalize：大位移到达段升级为过冲缓动并注入弧线与预备', () => {
  const plan = {
    duration_frames: 120,
    subject_tracks: [
      { target: 'actor_1', property: 'x', keyframes: [{ frame: 0, value: -0.1 }, { frame: 110, value: 0.15 }] },
    ],
    camera_tracks: [
      { target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: 119, value: 1.05, easing: 'ease-in-out' }] },
    ],
  };
  const out = naturalizer.naturalize(plan, naturalizer.DEFAULT_MOTION_QUALITY, resolver.resolveTrackValue);
  const xTrack = out.subject_tracks.find((t) => t.property === 'x');
  const finalKf = [...xTrack.keyframes].sort((a, b) => a.frame - b.frame).pop();
  assert.equal(finalKf.easing, 'ease-out-back');
  assert.ok(xTrack.keyframes.some((kf) => kf.anticipation), '注入预备关键帧');
  const yTrack = out.subject_tracks.find((t) => t.property === 'y');
  assert.ok(yTrack && yTrack.keyframes.some((kf) => kf.arc), '注入弧线关键帧');
  const camTrack = out.camera_tracks[0];
  assert.ok(camTrack.keyframes.some((kf) => kf.hold), '相机注入 hold');
  // 原 plan 未被修改
  assert.equal(plan.subject_tracks.length, 1);
  assert.equal(plan.subject_tracks[0].keyframes.length, 2);
});

test('naturalize：道具轨道被闭式滞后展开', () => {
  const plan = {
    duration_frames: 60,
    subject_tracks: [
      { target: 'actor_1', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 59, value: 0.2 }] },
      { target: 'prop_1', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 59, value: 0.2 }] },
    ],
    camera_tracks: [],
  };
  const out = naturalizer.naturalize(plan, naturalizer.DEFAULT_MOTION_QUALITY, resolver.resolveTrackValue);
  const prop = out.subject_tracks.find((t) => t.target === 'prop_1');
  assert.ok(prop.lagged, '标记滞后');
  assert.ok(prop.keyframes.length > 10, '展开为密集关键帧');
  // 中段道具落后于未加滞后的目标曲线（惯性滞后），结尾追平
  const originalTarget = { keyframes: [{ frame: 0, value: 0 }, { frame: 59, value: 0.2, easing: 'ease-out-back', easing_params: { s: 1.15 } }] };
  const mid = resolver.resolveTrackValue(prop, 20);
  assert.ok(mid < resolver.resolveTrackValue(originalTarget, 20), '中段滞后');
  const end = resolver.resolveTrackValue(prop, 59);
  assert.ok(Math.abs(end - 0.2) < 0.02, '结尾追平');
});

test('velocityFor：中心差分速度正确', () => {
  const plan = { duration_frames: 60, subject_tracks: [{ target: 'a', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 59, value: 0.59 }] }], camera_tracks: [] };
  const v = resolver.velocityFor(plan, 'a', 30);
  assert.ok(Math.abs(v.vx - 0.01) < 0.002, '每帧约 0.01');
});
