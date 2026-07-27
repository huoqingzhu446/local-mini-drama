# 纸片动画优化方案 —— 让每一镜流畅、自然、有生命感

> 文档状态：方案设计（待评审，未实施）
> 日期：2026-07-26
> 适用范围：独立纸片动画模式（Paper Studio）渲染与运动系统
> 前置文档：`docs/plans/2026-07-26-paper-studio-script-to-storyboard-pipeline.md`（P1–P5 已完成）
> 一句话目标：在不增加任何视频模型调用的前提下，把纸片动画从「会移动的贴纸」升级为「有重量、有节奏、有生命感的剪纸动画」，可量化验收。

---

## 0. 问题定义：什么叫"不流畅、不自然"

纸片动画的画质由素材决定（已由实体库与审核链路保障），**观感由运动质量决定**。当前成片的"PPT 感"可以拆解为六个具体病灶，每一个都能在代码里定位：

| # | 病灶 | 观感表现 | 代码定位 |
|---|------|---------|---------|
| D1 | 关键帧稀疏 + 缓动单一 | 长距离位移全程一个速度曲线，像滑冰 | `paperStudioAnalyzerService.js` 每条轨道仅 2–4 个关键帧；`trackResolver.cjs` 的 `ease()` 只有 cubic in/out/in-out 三种，无弹簧、无过冲、无回弹 |
| D2 | 零次级运动 | 整张 cutout 平移，身体不起伏、不前倾、衣物不摆动、静止时如照片定格 | `RecursiveNode.jsx` 的 `nodeStyle()` 只做 translate/scale/rotate 的直接叠加，无任何叠加分量 |
| D3 | 角色悬浮 | 角色和背景是"两张纸叠着"，没踩在地上 | `AssetNode` 无接触阴影；透明素材直接合成 |
| D4 | 道具刚性跟随 | 手里的东西像焊在手上，没有惯性滞后 | 道具轨道与角色轨道同步生成（`relation_schedule` 同帧同值），无 follow-through |
| D5 | 相机呆板 | 推拉摇移是匀速直线，全部图层同速移动，无空间纵深 | `PaperStudioComposition.jsx` 相机变换施加于整个画布，无视差分层、无手持质感 |
| D6 | 状态硬切 | 角色姿态状态切换瞬间跳变 | `state` 轨道是阶跃值，`AssetNode` 直接换图，无交叉过渡 |

**本方案的总原则**：运动即数学，全部病灶都在本地渲染与轨道编译层修复，**零图片/视频 API 调用**（仅 M6 走路循环与口型需要少量图片调用，且素材入库全剧复用）。

### 0.1 「流畅自然」的可验收定义

| 合同 | 内容 | 验收口径 |
|---|---|---|
| N1 | 无匀速直线位移 | 任何位移轨道相邻两关键帧之间的速度曲线一阶导数非常数（除刻意的匀速运镜外） |
| N2 | 主体运动含次级分量 | 移动 phase 中主体 y 含步频起伏分量、rotation 含倾斜分量 |
| N3 | 角色接地 | 每个非空镜主体脚下有跟随的接触阴影 |
| N4 | 携带物有惯性 | 道具轨道相对角色轨道存在相位滞后与阻尼收敛 |
| N5 | 静止不僵死 | 时长 >1s 的静止 phase 中主体有呼吸幅度的微动 |
| N6 | 运镜有纵深 | 推拉摇移时背景/主体/前景位移速度比不等于 1:1:1 |
| N7 | 帧间平滑 | 帧差能量曲线无尖峰突变（见 12.2 的量化脚本），状态切换处帧差 ≤ 阈值 |
| N8 | 可复现与可回退 | 同一 snapshot 渲染结果比特级一致；旧 snapshot（无运动增强字段）渲染结果与升级前逐帧一致 |

---

## 1. 理论基线：十二原则在剪纸媒介上的取舍

迪士尼动画十二原则不是全部适用于纸片媒介，明确取舍，避免过度工程：

| 原则 | 采用 | 落点 |
|---|---|---|
| Slow In & Slow Out（缓入缓出） | ★ 全面采用 | M1 缓动系统 |
| Follow Through & Overlapping（跟随与重叠） | ★ 全面采用 | M2 道具滞后、衣物摆动 |
| Secondary Action（次级动作） | ★ 全面采用 | M2 步态起伏、呼吸 |
| Arcs（弧线运动） | ★ 采用 | M1 位移路径弧线化 |
| Anticipation（预备） | ★ 采用 | M5 phase 注入 |
| Timing（节奏） | ★ 采用 | M5 时长自适应 |
| Staging（构图）/ Appeal | 已由蓝图与构图参考承担 | 不在本方案 |
| Squash & Stretch（挤压拉伸） | ▲ 克制采用 | 纸片是硬质媒介，仅在落地/坐下瞬间做 ≤3% 的 scaleY 压缩回弹，多了会破坏剪纸质感 |
| Exaggeration（夸张） | ▲ 克制采用 | 通过 M2 振幅参数档位表达 |
| Solid Drawing / Straight Ahead | ✗ 不适用 | 逐帧绘画范畴 |

剪纸动画的独特美学要保留：**轻微的机械感、可见的分层、硬切与顿挫本身是媒介魅力**。目标不是模仿真人运动，而是"精心操纵的纸偶"——参考 Lotte Reiniger 与 South Park 的运动语言：位移流畅、姿态离散、节奏明确。

---

## 2. 总体架构：三层注入，零破坏

运动增强分三层注入，各层独立开关、独立回退：

```text
轨道编译层（后端，出关键帧时）
  paperStudioAnalyzerService / 模板目录
  → M1 缓动升级、M5 节奏注入：更密的关键帧 + 更丰富的 easing 标签
  → 结果写入 motion_plan（snapshot 冻结，可追溯）

轨道求值层（渲染器，逐帧求值时）
  trackResolver.cjs
  → M1 新增插值函数（spring / overshoot / arc）
  → M2 程序化次级分量（确定性噪声，帧号驱动，不破坏可复现性）

合成层（渲染器，React 组件）
  RecursiveNode / AssetNode / PaperStudioComposition
  → M3 接触阴影、边缘处理、运动模糊
  → M4 视差与手持
  → M6 状态交叉过渡、口型
```

**兼容合同（对应 N8）**：所有新行为由 snapshot 内的 `motion_quality` 配置块驱动（见第 10 章）。该块缺失时（所有历史 snapshot），渲染路径与现在**逐帧一致**——增强只对新创建的生产版本生效。`paper_render_snapshots` 不需要迁移。

---

## 3. M1 缓动与物理插值（第一优先级）

### 3.1 扩充插值函数库（trackResolver.cjs）

在现有 `ease()` 基础上新增，全部为纯函数（帧号 → 值，确定性，符合 Remotion 渲染模型）：

```js
// 五次缓动：比 cubic 更沉稳，适合大质量主体（将领、重物）
'ease-in-quint'  : t => t ** 5
'ease-out-quint' : t => 1 - (1 - t) ** 5

// 过冲：到达目标后超出再回落，用于"坐下""落地""急停"
// s 控制过冲幅度，默认 1.30（约 4% 过冲）
'ease-out-back'  : t => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2

// 弹簧（无需物理模拟器，解析解）：衰减正弦逼近目标
// 用于"放下道具""披风落定"，omega 频率、zeta 阻尼
'spring'         : t => 1 - Math.exp(-zeta * omega * t) * Math.cos(omega * Math.sqrt(1 - zeta ** 2) * t)
                   // 默认 omega = 14, zeta = 0.55（两次可见回摆后静止）

// 顿挫（剪纸质感专用）：把连续位移量化成 N 个小台阶 + 台阶内 ease-out
// 用于远景群体移动，模仿定格动画的"手拨感"，N 默认 0（关闭）
'stepped-ease'   : t => (floor(t * N) + easeOut(fract(t * N))) / N
```

关键帧 schema 扩展（向后兼容，旧字段不变）：

```json
{ "frame": 72, "value": 0.31, "easing": "ease-out-back", "easing_params": { "s": 1.3 } }
```

### 3.2 动作原语 → 缓动映射表（轨道编译层）

现有五类动作原语的每条轨道按下表重编译（这是 M1 的核心交付物，直接改 `paperStudioAnalyzerService` 与 `paperStudioTemplateCatalog` 中的轨道模板）：

| 动作原语 | 轨道 | 现状 | 改为 |
|---|---|---|---|
| directed_move 起步段 | subject.x/y | linear 或 ease-out | `ease-in`（0→15% 路程慢启动） |
| directed_move 巡航段 | subject.x/y | 单段直线 | 拆 2–3 个中间关键帧走**弧线**（见 3.3），`ease-in-out` |
| directed_move 到达段 | subject.x/y | ease-in | `ease-out-quint` + 末端 `ease-out-back`(s=1.15) 轻微过冲 |
| carry_move_sit 坐下 | subject.y | ease-in-out | `ease-out-back`(s=1.3)；同时 scaleY 注入 0.97→1.0 的压缩回弹（squash 克制版） |
| 道具 release | prop.y | 与角色同步 | `spring`(omega=14, zeta=0.55)——落下、轻弹、停住 |
| state_transition | rotation | ease-out | `ease-in-out` + 过程中 anchor 保持接地点（见 3.4） |
| environmental_depth_motion | procedural_amount | ease-in | 保持，但加 0.8–1.2 的随机相位错开多层 |
| camera 全部 | camera.x/y/scale | ease-in-out | 保持 ease-in-out，但起止各加 12% 时长的静止 hold（运镜不满帧） |

### 3.3 弧线运动（Arcs）

自然位移不走直线。对任何 `|Δx| > 0.08` 且 `|Δy| < 0.05` 的水平位移轨道，编译时自动注入垂直弧线分量：

```text
y_arc(t) = -A * sin(π * t)        A = min(0.012, |Δx| * 0.08)
```

即一段 1/3 屏宽的横移会带约 1% 屏高的浅拱弧线——肉眼几乎察觉不到弧线本身，但直线感消失。实现为编译期在 y 轨道插入 3 个中间关键帧（避免运行时特判）。

### 3.4 旋转锚点接地

现在 rotation 围绕 `anchor_y: 0.88`（接地线）旋转是正确的，保持；但 state_transition（如坐下）过程中要把 anchor 动态锁在**接触点**：编译期把坐下 phase 的 anchor 通过 transform 前置平移补偿到支撑物接触点，防止"绕脚踝旋转导致臀部划出大弧"的穿帮。

---

## 4. M2 次级运动系统（生命感的来源）

### 4.1 设计原则：确定性程序化分量

次级运动**不进 motion_plan 关键帧**（否则轨道爆炸、门禁指纹不稳），而是在 `trackResolver.resolveTargetMotion()` 求值后叠加一层**由帧号和 node key 哈希驱动的确定性分量**：

```js
// 同一 snapshot 同一帧永远得到同一结果（Remotion 可复现性合同）
seed = hash(snapshot.id + node.key)          // 每层独立相位
noise(f) = value_noise(seed, f / period)     // 一维值噪声，周期插值
```

所有分量统一挂在新模块 `motion/secondaryMotion.cjs`，按 `motion_quality` 配置逐项开关。

### 4.2 分量清单与参数表

| 分量 | 触发条件 | 公式 | 默认参数 | 作用对象 |
|---|---|---|---|---|
| **步态起伏 bob** | 主体位移速度 v > 0.02 屏宽/s | `y += A_bob * |sin(2π * f_step * t)|`（绝对值正弦=脚步的双峰节奏） | A_bob = 0.006 屏高 × 速度系数；f_step = 1.8 步/s（按 relative_height 缩放：孩童 2.4，重甲 1.5） | character cutout |
| **移动前倾 lean** | 同上 | `rotation += L * sign(vx) * smoothstep(v)` | L = 2.5°，加速段渐入、减速段渐出 | character cutout |
| **呼吸 idle** | 主体速度 < 0.005 且 phase 时长 > 1s | `scaleY += 0.008 * sin(2π * 0.28 * t)`，anchor 在接地点（向上呼吸不离地） | 频率 0.28Hz（≈16 次/分，静息呼吸） | character cutout |
| **重心微摆 sway** | idle 同上 | `rotation += 0.5° * noise(t / 2.2s)` | 慢噪声，非周期 | character cutout |
| **道具跟随滞后 follow-through** | prop 存在 `follows` 关系 | prop 位置 = 角色位置的**一阶低通**：`p[f] = p[f-1] + (target[f] - p[f-1]) * k`，k = 0.22；释放瞬间切换到 spring 落点 | 滞后约 4–6 帧，停止后 2–3 帧内追平 | prop cutout |
| **携带物摆动 pendulum** | 同上且位移中 | `rotation += P * sin(2π * f_step * t + π/2)`（与步频同频、相位差 90°） | P = 4° | prop cutout |
| **衣物/披风摆 cloth** | 素材登记 bbox 高宽比 > 1.6（有下摆）| 对 cutout 下 35% 区域做 `skewX(S * sin(2π * f_step * t + π))`（CSS clip 分区或整体 skew 二选一，v1 用整体 skew × 0.4 系数弱化） | S = 1.8° | character cutout |
| **群体错相** | 同一镜多个角色 | 所有周期分量的相位加 `hash(node.key) * 2π` | — | 全部 |

> 低通滞后是唯一"依赖上一帧"的分量，与 Remotion 逐帧独立渲染冲突。解法：低通有解析形式，`p[f] = target[f] - Σ (Δtarget) * (1-k)^n`，编译期直接把角色轨道做闭式卷积生成 prop 轨道关键帧（每 4 帧一个），运行时零状态。M2 全部分量保持"帧号 → 值"纯函数。

### 4.3 强度档位

`motion_quality.secondary` 提供三档（融入现有草稿/标准/精细的质量语言）：

| 档位 | 说明 | 参数缩放 |
|---|---|---|
| `off` | 与现状完全一致 | ×0 |
| `subtle`（默认） | 上表默认值 | ×1.0 |
| `lively` | 童话/喜剧向 | ×1.6，f_step +20% |

---

## 5. M3 接地、光影与边缘（真实感三件套）

### 5.1 接触阴影（contact shadow）

新渲染组件 `ContactShadow.jsx`，为每个 `asset_type: character-cutout / prop-cutout` 且非 `held-by` 状态的节点自动注入（z 序在该 cutout 之下、背景之上）：

```text
形状：椭圆径向渐变  rgba(20,16,10, 0.34) → 透明
宽度：cutout 登记 bbox 宽 × 0.72
高度：宽 × 0.22
位置：x = cutout 锚点 x；y = 接地线（registration.ground_anchor）
动态：
  - 跟随 cutout x 位移（同帧同值，阴影不滞后）
  - bob 起伏时反向缩放：主体升高 → 阴影缩小 8% 且变浅 15%（脚离地的暗示）
  - 坐下后阴影过渡到支撑物下方并加宽 20%
```

阴影参数（透明度、颜色偏暖）进 `motion_quality.shadow`，跟随暗色调场景自动降透明度（从 clean_plate 的平均亮度估计，编译期算好写入 snapshot，运行时不采样）。

### 5.2 边缘处理

抠图 cutout 的 1px 硬边在深色背景上会发亮、浅色背景上发黑。合成期修复，不重抠：

- `AssetNode` 对 cutout 层加 `filter: drop-shadow(0 0 0.5px rgba(0,0,0,0.35))`——半像素暗描边，视觉上"压住"锯齿，同时贴合剪纸的描边审美；
- 素材侧（P3 生成链路顺手改）：`extractAlpha` 输出前对 alpha 通道做 1px 高斯羽化（sharp `.blur(0.6)` 仅作用于 alpha），已在库里的素材不重处理，新版本自动获得。

### 5.3 方向性运动模糊

快速移动（v > 0.15 屏宽/s）的 cutout 加轻量方向模糊，模拟快门：

```text
blur_px = clamp((v - 0.15) * 26, 0, 3.5)
实现：CSS filter: blur() 不支持方向 → 用 2 层残影替代：
  同一 cutout 以 0.25/0.12 透明度、沿速度反方向偏移 40%/80% 帧位移量各画一层
```

残影法在纸片媒介上比真模糊更协调（类似定格动画的 smear frame），且渲染成本低。仅在 `motion_quality.smear: true` 时启用，默认开。

---

## 6. M4 相机语言（空间感）

### 6.1 视差分层（parallax）

合成节点增加可选 `depth` 系数（编译器按 pattern 自动赋值，无需人工填写）：

| 层 | depth | 相机位移响应 |
|---|---|---|
| clean_plate 背景 | 0.55 | 移动量 × 0.55（远景动得慢） |
| 环境锚点/支撑物 | 0.80 | × 0.80 |
| 主体/道具 | 1.00 | × 1.00（基准） |
| 前景遮挡层 | 1.25 | × 1.25（近景动得快） |
| 程序化氛围层 | 1.15 | × 1.15 |

实现：`PaperStudioComposition` 不再把相机变换加在根容器，改为把 `camera.x/y × depth` 分发到每个顶层节点；`camera.scale` 同理按 `1 + (scale-1) × depth` 分发。推近时前景放大快于背景——两行数学，纵深立现。overscan 计算相应按最大 depth 取值。

### 6.2 手持质感（handheld）

相机位置叠加极低幅度二维慢噪声：

```text
camera.x += 0.0016 * noise(f / 90)    // 周期约 3s
camera.y += 0.0011 * noise(f / 73 + φ)
camera.rotation += 0.08° * noise(f / 110)
```

幅度刻意低于可察觉阈值——观众感觉不到"晃"，只感觉画面"活着"。空镜与对白近景默认开，动作大镜默认关（避免与主体运动打架）。档位：`off / breath(默认) / documentary(×2.2)`。

### 6.3 运镜节奏

- 所有相机轨道起止各加 **12% 时长的 hold**（静→动→静），杜绝"开幕即漂移"；
- 推近（scale 上行）默认配 `ease-in-quint` 前 40% + `linear` 后 60%——电影感推镜的标准型；
- 新增两个可选相机预设进动作目录：`push_in_settle`（缓推 3% 后停住）与 `drift_lateral`（极慢横漂，空镜专用）。

---

## 7. M5 节奏系统（Timing）

### 7.1 anticipation / settle 微 phase 注入

编译动作合同时自动注入两类微 phase（不改用户可见的 phase 语义，只在轨道层展开）：

```text
directed_move:  [start 0–8%: 反向 0.006 屏宽的预备后坐 + lean 反向]
                [move 8–86%]
                [settle 86–100%: 过冲回正 + bob 衰减到 0]
carry_move_sit: 坐下前插入 10% 时长的 hesitation（速度降到 30% 但不为 0）
state_transition: 变化前 6% 的 anticipation 反向旋转 1.5°
```

### 7.2 时长自适应

现在 phase 比例硬编码（如 move 占 0.16–0.64）。改为按分镜 `duration` 与位移距离自适应：

```text
移动速度上限：0.22 屏宽/s（超过则压缩位移或提示时长不足）
移动速度下限：0.04 屏宽/s（低于则收缩 move phase、延长首尾 hold——宁可多停，不可慢爬）
```

"慢爬"是 PPT 感的第二大来源（仅次于匀速）：位移小时长长时，现在会摊成极慢匀速——改为快速完成位移 + 两端停顿，节奏立刻正确。

### 7.3 对白节拍钩子

音频版本已有逐句 cue。对白 phase 中，说话角色注入 `+0.4°` 的头部方向摆（整体 rotation 近似）与 idle 呼吸增幅 ×1.3；听者保持 idle。让"谁在说话"从画面可读。

---

## 8. M6 多姿态与口型（少量图片调用，表现力质变）

### 8.1 走路循环（每角色 2 次调用）

实体库扩展**姿态槽**（`paper_library_identity_versions` 增加 `pose_key` 列，默认 `neutral`）：

- 以已批准形象为参考图（reference_images 能力已探测）生成 `walk_a`（左脚在前）与 `walk_b`（右脚在前）两帧，prompt 锁定："同一角色、同一服装配色、同一比例，仅步态不同，其余一切保持一致"；
- 审核复用现有批准流；
- 移动 phase 中 state 轨道按步频交替 `walk_a/walk_b`（编译期生成，与 bob 分量同相位：脚步落地时 y 最低）；
- 静止/对白回 `neutral`。不生成走路帧的角色自动回退 M2 纯 bob 方案——**多姿态是增强，不是依赖**。

### 8.2 状态交叉过渡（消灭硬切，0 调用）

`AssetNode` 对 state 切换做 3 帧交叉溶解：前状态透明度 1→0、新状态 0→1，同时新状态从 98% scale 进入。walk_a/walk_b 交替例外（硬切正是步感），仅对语义状态（站→坐）生效。

### 8.3 口型开合（每角色 1 次调用，可选）

- 生成 `mouth_open` 变体（仅嘴部张开，其余锁定）；
- 渲染时按当句音频的**响度包络**（编译期用 ffmpeg `astats` 每 100ms 采样一次写入 snapshot）在 `neutral/mouth_open` 间切换，阈值迟滞防抖；
- South Park 式两帧口型在剪纸媒介中成立且成本极低。无 `mouth_open` 素材的角色自动跳过。

---

## 9. M7 关节 rig（远期，方向性设计）

仓库已有 `paper_rigs` 表与 `PaperRig.jsx` 雏形。完整路线：

1. **自动拆件**：对已批准角色形象跑分割（头/躯干/左右臂/左右腿六件），alpha 连通域 + 骨架启发式；拆不干净的退回整片模式；
2. **pivot 登记**：肩/髋 pivot 按 bbox 比例估计（肩 = bbox 顶部下 22%、左右 28%/72%），可在审核工作台手动微调；
3. **程序化步态**：大臂 ±14°、大腿 ±18° 的对侧摆（与 f_step 同频），小腿跟随滞后 90° 相位；
4. 与 M6 互斥择优：有 rig 用 rig，有走路帧用帧，都没有用 bob。

M7 单独立项，不阻塞 M1–M6；本方案只锁定数据结构兼容（pose_key 与拆件素材同表存储）。

---

## 10. 配置与数据结构

### 10.1 snapshot 扩展（`motion_quality` 块）

```json
{
  "motion_quality": {
    "schema_version": 1,
    "easing_pack": "natural-v1",         // 缺失 = 完全旧行为
    "secondary": "subtle",               // off | subtle | lively
    "contact_shadow": { "enabled": true, "opacity": 0.34 },
    "smear": true,
    "parallax": true,
    "handheld": "breath",                // off | breath | documentary
    "timing": { "anticipation": true, "adaptive_speed": true },
    "state_crossfade_frames": 3
  }
}
```

- 创建生产版本时按项目默认值写入（项目级可改，进现有「开始制作」区一个"运动质量"折叠项：三档预设 = 关闭/标准/生动，高级展开逐项）；
- snapshot 冻结后不变——同一 run 内预览、门禁、正式渲染看到的运动完全一致（所见即所得合同不破坏）；
- 动态门禁的证据帧走同一渲染路径，实测值自动覆盖新运动（无需改门禁逻辑；bob 幅度远小于门禁位移阈值，不会误判）。

### 10.2 触碰的文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| 求值 | `paper-studio-renderer/motion/trackResolver.cjs` | 新 easing 函数 + easing_params |
| 求值 | `paper-studio-renderer/motion/secondaryMotion.cjs`（新） | M2 全部分量 + 确定性噪声 |
| 合成 | `RecursiveNode.jsx` | depth 视差、次级分量叠加入口 |
| 合成 | `AssetNode.jsx` | 边缘描边、smear 残影、状态交叉过渡 |
| 合成 | `ContactShadow.jsx`（新） | 接触阴影 |
| 合成 | `PaperStudioComposition.jsx` | 相机分发（视差）、手持噪声 |
| 编译 | `paperStudioAnalyzerService.js` + `paperStudioTemplateCatalog.js` | 缓动映射表、弧线注入、微 phase、时长自适应、prop 闭式滞后轨道 |
| 编译 | `paperStudioRenderService.js` | motion_quality 写入 snapshot、响度包络采样 |
| 素材 | `paperIdentityProductionService.js` | alpha 羽化；M6 姿态变体生成 |
| 数据 | `migrations/42_paper_motion_quality.sql` | identity_versions 加 `pose_key`；项目配置默认值 |
| 门禁 | `paperMotionGateService.js` | 仅验证：确认 bob/lean 分量不影响语义断言（预期零改动，加回归用例） |

---

## 11. 实施分期

| Phase | 内容 | 调用成本 | 交付判定 |
|---|---|---|---|
| **M1 缓动与弧线** | easing 库 + 映射表 + 弧线 + 锚点接地 | 0 | 同一 snapshot A/B 渲染对比；N1 通过 |
| **M2 次级运动** | secondaryMotion.cjs 全分量 + 三档位 + prop 闭式滞后 | 0 | N2/N4/N5 通过；off 档逐帧等于 M1 |
| **M3 接地光影** | 接触阴影 + 边缘 + smear | 0 | N3 通过；深浅两种场景走查 |
| **M4 相机** | 视差 + 手持 + 运镜节奏 | 0 | N6 通过；overscan 无露边 |
| **M5 节奏** | 微 phase + 时长自适应 + 对白节拍 | 0 | 快/慢两种时长用例对比 |
| **M6 多姿态与口型** | pose_key + 走路帧 + 交叉过渡 + mouth flap | 每角色 2–3 次图片调用（一次性入库） | 走路镜 A/B；口型与响度对齐抽查 |
| **M7 rig** | 单独立项 | — | 另行设计 |

推荐节奏：M1+M3 一起先上（改动集中、对比最震撼），M2+M4 第二批，M5 第三批，M6 在用户确认前三批效果后再花调用。

## 12. 验收方法

### 12.1 A/B 对比机制

给 `renderService` 加开发参数 `motion_quality_override`：同一个已批准 snapshot 用 off/subtle 各渲一遍，输出并排对比视频（ffmpeg hstack）。每个 Phase 交付时用同一组四镜（含移动、坐下、携带、空镜各一）出对比片。

### 12.2 帧间平滑度量化（N7 脚本）

`backend-node/tools/motion-smoothness.mjs`：

```text
1. ffmpeg 抽帧 → 相邻帧做像素差分能量 e[f]
2. 计算 jerk 指标：J = stddev(diff(e)) / mean(e)
   匀速滑动 + 硬切 → e 呈方波，J 高；缓动 + 次级运动 → e 平滑起伏，J 低
3. 验收线：同一 snapshot 增强后 J 下降 ≥ 30%；状态切换帧 e 峰值下降 ≥ 50%（交叉过渡生效）
```

### 12.3 回归门禁

- off 档逐帧 hash 等于升级前渲染（N8）；
- 全量后端测试 + 动态门禁四类动作原语用例全绿；
- 双分辨率真实浏览器走查（延续既有验收方式）。

## 13. 风险与边界

| 风险 | 缓解 |
|---|---|
| 次级运动叠加过头变"果冻" | 所有幅度参数集中一处、默认 subtle 档保守取值；lively 档才放开；A/B 片人工把关 |
| 视差导致 overscan 露边 | overscan 按最大 depth 重算 + 渲染前静态检查（最大位移 × depth ≤ 过扫余量） |
| 低通滞后破坏可复现性 | 已规避：编译期闭式展开成关键帧，运行时纯函数 |
| 走路帧与正式形象漂移 | 参考图 + 锁定 prompt + 审核门禁；漂移严重就退回 bob 方案 |
| 门禁误判次级运动为语义位移 | bob 幅度（0.006）比门禁位移阈值低一个数量级；加专项回归用例锁定 |
| 老项目观感突变 | motion_quality 只写入新 run；旧 snapshot 永远旧行为 |

## 14. 本方案不做什么

- 不做逐帧 AI 生成或视频模型插帧（违背纸片模式的确定性与零视频成本原则）；
- 不做物理引擎（弹簧解析解足够，引擎引入不可复现风险）；
- 不做 3D/骨骼蒙皮（M7 的平面 pivot rig 已是上限）；
- 不追求拟真人运动——保留纸偶的媒介质感是美学选择，不是技术妥协。
