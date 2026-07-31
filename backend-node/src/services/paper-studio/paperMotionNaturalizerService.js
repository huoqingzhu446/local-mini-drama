// M1/M5 轨道自然化（纸片动画优化方案 §3 / §7）。
// 在 snapshot 冻结时对 motion_plan 做纯函数后处理：缓动升级、弧线注入、
// 预备/缓冲微相位、相机起止 hold、道具惯性滞后（闭式展开成关键帧）。
// 不修改数据库中的原始 plan_json；动态门禁与渲染消费同一份处理结果，所见即所得。

const DEFAULT_MOTION_QUALITY = Object.freeze({
  schema_version: 1,
  easing_pack: 'natural-v1',
  secondary: 'subtle',            // off | subtle | lively
  contact_shadow: { enabled: true, opacity: 0.34 },
  smear: true,
  parallax: true,
  handheld: 'breath',             // off | breath | documentary
  timing: { anticipation: true, adaptive_speed: true },
  state_crossfade_frames: 3,
});

function motionQualityFromConfig(cfg) {
  const raw = cfg?.paper_studio?.motion_quality;
  if (raw === false || raw?.enabled === false) return null; // 显式关闭 → 完全旧行为
  return {
    ...DEFAULT_MOTION_QUALITY,
    ...(typeof raw === 'object' ? raw : {}),
    contact_shadow: { ...DEFAULT_MOTION_QUALITY.contact_shadow, ...(raw?.contact_shadow || {}) },
    timing: { ...DEFAULT_MOTION_QUALITY.timing, ...(raw?.timing || {}) },
  };
}

function cloneTrack(track) {
  return { ...track, keyframes: (track.keyframes || []).map((keyframe) => ({ ...keyframe })) };
}

function orderedNumericKeyframes(track) {
  return (track.keyframes || [])
    .filter((keyframe) => Number.isFinite(Number(keyframe.frame)) && typeof keyframe.value === 'number')
    .sort((a, b) => Number(a.frame) - Number(b.frame));
}

function trackDelta(track) {
  const keyframes = orderedNumericKeyframes(track);
  if (keyframes.length < 2) return 0;
  return keyframes[keyframes.length - 1].value - keyframes[0].value;
}

const isSubjectPositionTrack = (track) => ['x', 'y'].includes(track.property);
const isPropTarget = (target) => /^prop/.test(String(target || ''));
const isActorTarget = (target) => /^(actor|subject|primary_subject|supported_group)/.test(String(target || ''));
const NATURALIZED_EASING_PROPERTIES = new Set(['x', 'y', 'rotation', 'scale']);

// §3.2 缓动升级：到达段用五次缓出 + 轻微过冲；中段补 ease-in-out。
function upgradeEasing(track) {
  const keyframes = orderedNumericKeyframes(track);
  if (keyframes.length < 2) return;
  const delta = Math.abs(trackDelta(track));
  for (let index = 1; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    const isFinal = index === keyframes.length - 1;
    if (isFinal && isSubjectPositionTrack(track) && delta > 0.03) {
      if (!['spring', 'ease-out-back'].includes(keyframe.easing)) {
        keyframe.easing = 'ease-out-back';
        keyframe.easing_params = { s: 1.15 };
      }
    } else if (!keyframe.easing || keyframe.easing === 'linear') {
      keyframe.easing = 'ease-in-out';
    }
  }
  // 起步段：大位移的第一段渐入
  if (isSubjectPositionTrack(track) && delta > 0.06 && keyframes.length >= 2) {
    if (!keyframes[1].easing || keyframes[1].easing === 'ease-in-out') keyframes[1].easing = 'ease-in';
  }
}

// §3.3 弧线注入：水平大位移带浅拱弧线（在 y 轨道插中间关键帧）。
function injectArc(tracks, target, durationFrames) {
  const xTrack = tracks.find((track) => track.target === target && track.property === 'x');
  if (!xTrack) return;
  const dx = Math.abs(trackDelta(xTrack));
  if (dx < 0.08) return;
  let yTrack = tracks.find((track) => track.target === target && track.property === 'y');
  const yRange = yTrack ? Math.abs(trackDelta(yTrack)) : 0;
  if (yRange > 0.05) return; // 已有明显纵向运动，不叠弧线
  const xKeyframes = orderedNumericKeyframes(xTrack);
  const startFrame = xKeyframes[0].frame;
  const endFrame = xKeyframes[xKeyframes.length - 1].frame;
  if (endFrame - startFrame < 8) return;
  const amplitude = Math.min(0.012, dx * 0.08);
  const baseY = yTrack ? orderedNumericKeyframes(yTrack)[0]?.value || 0 : 0;
  if (!yTrack) {
    yTrack = { target, property: 'y', keyframes: [{ frame: startFrame, value: baseY }, { frame: endFrame, value: baseY, easing: 'ease-in-out' }] };
    tracks.push(yTrack);
  }
  for (const ratio of [0.25, 0.5, 0.75]) {
    const frame = Math.round(startFrame + (endFrame - startFrame) * ratio);
    yTrack.keyframes.push({ frame, value: baseY - amplitude * Math.sin(Math.PI * ratio), easing: 'ease-in-out', arc: true });
  }
  yTrack.keyframes.sort((a, b) => Number(a.frame) - Number(b.frame));
}

// §7.1 预备与缓冲：大位移起步前 8% 时长做 0.006 屏宽的反向后坐。
function injectAnticipation(track, durationFrames) {
  if (!isSubjectPositionTrack(track)) return;
  const keyframes = orderedNumericKeyframes(track);
  if (keyframes.length < 2) return;
  const delta = trackDelta(track);
  if (Math.abs(delta) < 0.1) return;
  const start = keyframes[0];
  const window = Math.round(Math.max(4, durationFrames * 0.08));
  if (keyframes[1].frame - start.frame < window * 1.5) return; // 起步太密就不插
  track.keyframes.push({
    frame: start.frame + window,
    value: start.value - Math.sign(delta) * 0.006,
    easing: 'ease-in-out',
    anticipation: true,
  });
  track.keyframes.sort((a, b) => Number(a.frame) - Number(b.frame));
}

// §6.3 相机起止 hold：12% 时长静止，杜绝开幕即漂移。
function injectCameraHolds(track, durationFrames) {
  const keyframes = orderedNumericKeyframes(track);
  if (keyframes.length < 2) return;
  const hold = Math.round(durationFrames * 0.12);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (first.frame === 0 && keyframes[1].frame > hold * 2) {
    track.keyframes.push({ frame: hold, value: first.value, hold: true });
  }
  if (last.frame >= durationFrames - 1 && last.frame - keyframes[keyframes.length - 2].frame > hold * 2) {
    track.keyframes.push({ frame: durationFrames - 1 - hold, value: last.value, easing: last.easing || 'ease-in-out', hold: true });
    // 原末帧保持值不变形成结尾静止
  }
  track.keyframes.sort((a, b) => Number(a.frame) - Number(b.frame));
}

// §4.2 道具惯性滞后：以角色轨道为目标做一阶低通，闭式展开为密集关键帧（每 4 帧）。
function injectPropLag(tracks, resolveValue, durationFrames) {
  const actorTargets = [...new Set(tracks.filter((track) => isActorTarget(track.target) && isSubjectPositionTrack(track)).map((track) => track.target))];
  if (!actorTargets.length) return;
  const actorTarget = actorTargets[0];
  for (const propTarget of [...new Set(tracks.filter((track) => isPropTarget(track.target)).map((track) => track.target))]) {
    for (const property of ['x', 'y']) {
      const propTrack = tracks.find((track) => track.target === propTarget && track.property === property);
      const actorTrack = tracks.find((track) => track.target === actorTarget && track.property === property);
      if (!propTrack || !actorTrack) continue;
      if (Math.abs(trackDelta(propTrack)) < 0.02) continue; // 道具本身不怎么动就不处理
      const k = 0.22;
      const dense = [];
      let lagged = resolveValue(propTrack, 0);
      if (typeof lagged !== 'number') continue;
      for (let frame = 0; frame < durationFrames; frame += 1) {
        const target = Number(resolveValue(propTrack, frame));
        lagged += (target - lagged) * k;
        if (frame % 4 === 0 || frame === durationFrames - 1) {
          dense.push({ frame, value: Math.round(lagged * 10000) / 10000 });
        }
      }
      propTrack.keyframes = dense;
      propTrack.lagged = true;
    }
  }
}

/**
 * 主入口：返回处理后的 motion_plan 深拷贝；quality 为 null 时原样返回（旧行为）。
 */
function naturalize(motionPlan, quality, resolveValue) {
  if (!quality || !motionPlan) return motionPlan;
  const durationFrames = Math.max(2, Number(motionPlan.duration_frames || 0));
  const plan = {
    ...motionPlan,
    subject_tracks: (motionPlan.subject_tracks || []).map(cloneTrack),
    camera_tracks: (motionPlan.camera_tracks || []).map(cloneTrack),
  };

  const subjectTargets = [...new Set(plan.subject_tracks.map((track) => track.target))];

  for (const track of plan.subject_tracks) {
    // Opacity and procedural intensity have explicit frame-level continuity
    // contracts. Replacing their authored linear ramps with nonlinear easing
    // can increase the peak per-frame slope and make a previously valid fade
    // fail only after snapshot naturalization.
    if (typeof (track.keyframes || [])[0]?.value === 'number' && NATURALIZED_EASING_PROPERTIES.has(track.property)) upgradeEasing(track);
    if (quality.timing?.anticipation) injectAnticipation(track, durationFrames);
  }
  for (const target of subjectTargets) {
    if (isActorTarget(target)) injectArc(plan.subject_tracks, target, durationFrames);
  }
  if (quality.timing?.anticipation) {
    injectPropLag(plan.subject_tracks, resolveValue, durationFrames);
  }
  for (const track of plan.camera_tracks) {
    if (typeof (track.keyframes || [])[0]?.value === 'number') {
      injectCameraHolds(track, durationFrames);
      upgradeEasing(track);
    }
  }
  plan.naturalized = { pack: quality.easing_pack || 'natural-v1', schema_version: 1 };
  return plan;
}

module.exports = { DEFAULT_MOTION_QUALITY, motionQualityFromConfig, naturalize };
