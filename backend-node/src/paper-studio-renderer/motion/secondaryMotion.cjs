// M2 次级运动系统（纸片动画优化方案 §4）。
// 所有分量都是「帧号 + 节点种子 → 增量」的确定性纯函数，不依赖上一帧状态，
// 保证 Remotion 逐帧独立渲染下同一 snapshot 结果比特级一致。
const { clamp } = require('./trackResolver.cjs');

// 稳定字符串哈希 → [0, 1)
function hashSeed(text) {
  let hash = 2166136261;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

// 一维值噪声：整数格点伪随机 + smoothstep 插值，确定性。
function pseudoRandom(seed, index) {
  const x = Math.sin((seed * 127.1 + index) * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function valueNoise(seed, position) {
  const i0 = Math.floor(position);
  const i1 = i0 + 1;
  const t = position - i0;
  const smooth = t * t * (3 - 2 * t);
  const a = pseudoRandom(seed, i0) * 2 - 1;
  const b = pseudoRandom(seed, i1) * 2 - 1;
  return a + (b - a) * smooth; // [-1, 1]
}

const PRESETS = {
  off: 0,
  subtle: 1,
  lively: 1.6,
};

/**
 * 计算某个节点在当前帧的次级运动增量。
 * @param {object} ctx
 *   role: 'actor' | 'prop' | 'other'
 *   frame, fps
 *   velocity: { vx, vy, speed }  单位：屏幅/帧
 *   seedKey: 稳定种子（snapshot 内唯一）
 *   config: motion_quality.secondary 档位 + 可选覆盖
 *   relativeHeight: 实体身高比（可空，默认 1）
 *   tall: 素材是否高瘦（决定衣摆分量）
 * @returns {{ x, y, rotation, scaleY, skewX }}
 */
function secondaryDelta(ctx) {
  const level = PRESETS[ctx.config?.secondary || 'subtle'] ?? 1;
  const out = { x: 0, y: 0, rotation: 0, scaleY: 0, skewX: 0 };
  if (!level || ctx.role === 'other') return out;

  const fps = Math.max(1, Number(ctx.fps || 30));
  const seconds = ctx.frame / fps;
  const seed = hashSeed(ctx.seedKey);
  const phase = seed * Math.PI * 2; // 群体错相（§4.2）
  const speedPerSecond = Number(ctx.velocity?.speed || 0) * fps;
  const moving = speedPerSecond > 0.02;
  const idle = speedPerSecond < 0.005;
  // 步频：默认 1.8 步/s，按身高比缩放（孩童更碎步，重甲更沉）
  const relativeHeight = clamp(Number(ctx.relativeHeight || 1), 0.3, 2);
  const stepHz = 1.8 / Math.sqrt(relativeHeight);
  const speedGain = clamp(speedPerSecond / 0.12, 0, 1.4);

  if (ctx.role === 'actor') {
    if (moving) {
      // 步态起伏：绝对值正弦 = 双峰脚步节奏
      out.y -= 0.006 * level * speedGain * Math.abs(Math.sin(Math.PI * stepHz * seconds + phase));
      // 移动前倾：朝速度方向，随速度渐入
      out.rotation += 2.5 * level * Math.sign(ctx.velocity.vx || 0) * clamp(speedPerSecond / 0.1, 0, 1);
      // 衣摆/披风微摆（高瘦素材才有下摆）
      if (ctx.tall) out.skewX += 1.8 * 0.4 * level * Math.sin(Math.PI * 2 * stepHz * seconds + phase + Math.PI);
    }
    if (idle) {
      // 呼吸：0.28Hz ≈ 静息呼吸频率；scaleY 由接地锚点向上（不离地）
      out.scaleY += 0.008 * level * Math.sin(Math.PI * 2 * 0.28 * seconds + phase);
      // 重心慢摆：非周期噪声
      out.rotation += 0.5 * level * valueNoise(seed, seconds / 2.2);
    }
  }

  if (ctx.role === 'prop') {
    if (moving) {
      // 携带物摆动：与步频同频、相位差 90°
      out.rotation += 4 * level * Math.sin(Math.PI * 2 * stepHz * seconds + phase + Math.PI / 2) * speedGain;
    }
  }

  return out;
}

// M4 手持相机噪声（§6.2）：低于察觉阈值的慢噪声。
const HANDHELD_PRESETS = {
  off: 0,
  breath: 1,
  documentary: 2.2,
};

function handheldDelta(config, frame, seedKey = 'camera') {
  const level = HANDHELD_PRESETS[config?.handheld || 'breath'] ?? 1;
  if (!level) return { x: 0, y: 0, rotation: 0 };
  const seed = hashSeed(seedKey);
  return {
    x: 0.0016 * level * valueNoise(seed, frame / 90),
    y: 0.0011 * level * valueNoise(seed + 0.37, frame / 73),
    rotation: 0.08 * level * valueNoise(seed + 0.71, frame / 110),
  };
}

// M4 视差深度系数（§6.1）：按节点种类/角色映射。
function depthFor(node) {
  if (node.kind === 'registered-environment') return 0.55;
  if (node.relation?.role === 'front-occluder') return 1.25;
  if (node.kind === 'procedural') return 1.15;
  return 1;
}

module.exports = { secondaryDelta, handheldDelta, depthFor, hashSeed, valueNoise, PRESETS };
