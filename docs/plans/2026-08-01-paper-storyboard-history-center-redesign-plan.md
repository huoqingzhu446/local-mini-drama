# 纸片分镜历史中心重新设计方案（评审稿）

> 日期：2026-08-01
> 版本：v2（已合并首轮评审意见）
> 状态：条件性通过；5 个遗漏缺陷与 3 处设计澄清已补入，待评审人复核
> 范围：纸片分镜脚本修订、生产版本、计划版本、图片版本、历史派生、素材复用、费用门禁与归档
> 本轮交付：仅生成方案文档；不修改业务代码、不执行 migration 45、不调用任何图片 API
> 基线：migration 44 已在正式库完成并校验，不回滚；本方案是在 migration 44 之上继续演进

## 0. 结论摘要

当前“历史版本”只能算一个只读素材抽屉，还不是可以真正使用的历史中心。它缺少明确时间、脚本正文详情和从历史继续工作的入口；同时，现有复用报价、连续性修复与归档还存在可能误判或丢失历史语义的问题。此时直接增加“重新编辑”按钮，会把风险从“看不见历史”扩大为“错误复用、低估费用或覆盖工作副本”。

本方案建议采用以下产品语义：

1. 历史记录永久只读，任何 S/R/P/V 历史行都不允许原地修改。
2. 点击历史版本先进入完整只读详情，而不是直接编辑或生成。
3. 用户可以从历史 S 创建新的工作副本，从历史 R/P 创建新的生产副本；所有派生都有来源审计。
4. 创建工作副本和生产副本都是零图片 API 操作。
5. 新生产版本先编译需求，再检查历史图片复用，再由用户确认复用，最后只对剩余差异槽位报价。
6. `review`、`blocked`、已拒绝、文件缺失或哈希异常的图片，在未完成人工确认前不得按“0 调用”处理。
7. 所有历史图片状态都必须归档并原样恢复；`include_diagnostics` 只能控制诊断产物，不能裁剪业务历史。

推荐落地形态为“快速历史抽屉 + 全尺寸分镜历史中心”：抽屉用于快速浏览，全尺寸页面用于查看详情、比较版本、派生工作副本和审核复用影响。

### 0.1 首轮评审结论与本版处理

首轮评审裁决为“条件性通过”。评审确认 migration 44 基线、报价漏算、连续性越权克隆、归档失真、历史接口和前端缺口均属实。本版已完成以下文档修订：

- 补充归档完全漏导出 `paper_asset_review_decisions` 的现状；
- 明确 v1 复用范围仅限同一个 `paper_storyboard_id`，不承诺跨分镜 exact 复用；
- 把连续性修复硬编码 compatibility report、缺 request ID/preview fingerprint 纳入阶段 A；
- 明确 apply-reuse 不能伪造 `local_user` 审核，目标批准必须来自用户明确确认并记录真实 actor/reason；
- 把历史抽屉总数、分页错误、错误竞态、裸枚举和焦点管理 5 个问题纳入阶段 B；
- 写明 S 的 hash 去重范围是同一 storyboard 的全部历史修订；
- 在 fork-draft 影响预览中增加“已发布视频将失效”；
- 删除成体系的移动端页签设计，只保留 Electron 桌面窗口的窄宽响应式微调；
- §16 的 7 个推荐决策全部按评审结论固化为已确认设计决策。

## 1. 改造原因

### 1.1 用户实际需要的是可复用的完整历史，不只是旧版本编号

同一个分镜在制作过程中会多次修改对白、时长、动作、转场、场景和提示词。这些修改不会天然导致此前图片全部失效。背景、角色、道具以及部分状态图经常仍可使用。

如果系统只告诉用户“请修改并重新创建生产版本”，却不提供历史详情与复用预检，用户无法判断旧图是否还在，也无法确认新生产是否会重复调用图片 API。这会直接增加费用并削弱用户对系统的信任。

### 1.2 当前界面没有回答最基本的历史问题

现有历史抽屉中，生产版本摘要只显示版本号、状态、计划数量和图片数量；没有显示创建时间、完成时间或归档时间。脚本修订只显示 `S1/S2` 标签，也不能点击查看保存过的完整内容。

用户因此无法判断：

- 这个版本是什么时候创建的；
- 当时的分镜正文、动作、对白、提示词是什么；
- 哪一个生产版本使用了哪一个脚本修订；
- 哪些图片被采用、拒绝、淘汰或生成失败；
- 哪些旧图可以用于当前工作；
- 从旧版本继续编辑是否会覆盖当前内容或重新生图。

### 1.3 “点击后重新编辑”必须是派生，不是覆盖

历史记录承担追溯、对比和复用证据的职责，不能被编辑。用户所说的“点击进去重新编辑”，正确语义应是：

> 先查看只读历史详情，再明确选择“基于此版本创建工作副本”或“复制为新生产版本”。

源历史版本保持不变，目标是一个新的可变工作上下文。所有操作都记录源版本、目标版本、影响预览和请求 ID。

### 1.4 费用控制必须成为硬门禁

查看历史、创建工作副本、复制生产结构、应用精确匹配的旧图、调整计划和运行连续性门禁都不应调用图片 API。只有经过下列完整链路后，才允许发生付费调用：

```text
编译素材需求
  → 历史/实体库/本地派生复用预检
  → 用户应用零调用复用
  → 再次计算剩余差异
  → 展示逐槽位报价
  → 用户明确授权
  → 执行图片 provider
```

任何复用失败都必须停在预览或报价阶段，不得自动降级成付费生成。

## 2. 已核实的现状与缺口

| 能力 | 当前事实 | 缺口/风险 | 本方案要求 |
|---|---|---|---|
| 脚本历史存储 | `paper_storyboard_revisions.content_json` 已保存完整内容 | 历史接口只返回摘要，不返回正文 | 增加单个 S 版本只读详情接口 |
| 时间数据 | R 已有 `created_at/updated_at/completed_at`；P、V 也有各自时间 | 前端 R 摘要未渲染时间，空值直接显示为空 | 每层显示主时间与次时间，缺失有明确占位 |
| 点击 R | 只能展开计划和图片只读详情 | 无法进入脚本详情或创建派生版本 | 详情页提供受门禁的派生操作 |
| 脚本保存 | 每次实际内容变化会形成不可变 S 修订 | 相同内容按 hash 去重，不能靠复制相同内容伪造“新 S” | 用工作副本基线指针表达“基于 Sxx 编辑” |
| 新建生产 | 只接受分镜当前 `current_revision_id` | 不能直接从历史 S/R 创建生产副本 | 增加历史派生预览与专用创建接口 |
| 图片复用 | migration 44 已有计划历史、`reuse_fingerprint` 和复用链接 | `review/blocked` 当前都可能被归为 0 调用候选 | 修正分类和报价口径后才开放派生按钮 |
| 指纹范围 | 当前 `reuse_fingerprint` 混入 `project_id + paper_storyboard_id` | 跨分镜指纹结构性不同，不可能 exact | v1 明确只支持同分镜历史复用 |
| 连续性修复 | 已有修复审计基础 | 存在将未批准 candidate 克隆为 `accepted + approved` 的风险 | 源版本、审批、文件和目标状态四重校验 |
| 连续性报告 | compatibility report 当前硬编码 fingerprint/file 均通过 | 审计内容与真实校验脱节，且缺 request ID/preview fingerprint | 只能写入实际计算结果和完整请求链 |
| 复用审核 | apply-reuse 当前自动写 `reviewer='local_user'` 的 approved | 服务端替用户制造人工审核事实 | 只接受用户明确确认，actor 来自可信上下文，reason 可追溯 |
| 归档 | 默认只导出 accepted 图片，完全不导出 `paper_asset_review_decisions`；导入将图片强制为 accepted | 状态失真且批准信任链断裂，导入后历史图全部无法满足 approved 校验 | 归档 v2 始终包含全部业务历史和审核事实并保真导入 |
| 历史抽屉 | 已有列表、分页和详情基础 | 总数少报、分页错误静默、共享 error 竞态、`created_from` 裸枚举、缺 ESC/焦点陷阱 | 阶段 B 与时间展示一起修复 |
| migration 执行 | SQL 文件按分号拆分逐条执行，后置回填另行执行 | 中途失败可能留下半迁移状态 | migration 45 的 DDL、回填和断言整体事务化 |

### 2.1 migration 44 正式库基线

本方案不回滚 migration 44。当前已确认的基线数据如下，后续 migration 45 前后都必须保持或增加，不能减少：

- 108 个图片版本；
- 116 个图片、Alpha、Mask 文件引用存在；
- SQLite integrity 为 `ok`；
- 27 个分镜计划指针完整；
- provider 调用总数为 9。

这些值是上线前后数据守恒检查的最低基线，不是新 migration 的修改目标。

## 3. 目标、原则与非目标

### 3.1 改造目标

1. 每个分镜在一个入口中查看全部 S/R/P/V 历史及明确时间。
2. 每个脚本修订可查看完整正文和字段差异。
3. 每个生产与计划版本可查看状态、来源、素材、审核、调用与复用去向。
4. 历史行只读，但可派生新的工作副本或生产副本。
5. 派生前展示完整影响预览，明确保留图片数和预计 API 次数。
6. 旧图优先复用，只有剩余差异槽位进入付费授权。
7. 全链路幂等、并发安全、可审计、可归档和可恢复。

### 3.2 必须遵守的原则

- **历史不可变**：历史表不提供 update/delete 业务接口。
- **先看后操作**：单击版本只打开详情，不产生写操作。
- **先复用后报价**：报价必须建立在最新复用预览之上。
- **费用显式授权**：任何 API 调用都需要独立授权，派生按钮不能携带授权语义。
- **状态保真**：accepted/rejected/failed/cancelled/superseded 都是有效历史。
- **事实可解释**：每次派生和复用都能追溯源、目标、hash、原因和用户请求。
- **并发失败优先**：版本或文件变化时返回 409 并要求重新预览，不做猜测性继续。

### 3.3 本次非目标

- 不支持直接编辑历史 S/R/P/V 行。
- 不支持删除单条历史图片或“清空历史”。
- 不在历史页直接执行图片 provider。
- 不在第一版支持同一分镜多个并行工作副本；仍维持一个活动工作副本。
- v1 不支持跨分镜 exact 素材复用；复用查询和 fork scope 均限制在同一个 `paper_storyboard_id`。当前指纹包含 `project_id + paper_storyboard_id`，不得在本次改造中悄悄删除这两个隔离维度。
- 不改变 migration 44 已生成的历史 ID 和素材文件路径。
- 不用视觉相似度模型代替视觉合同与人工审核。

## 4. 统一版本术语

| 标识 | 名称 | 数据来源 | 是否可变 | 可执行操作 |
|---|---|---|---|---|
| S | 脚本修订 | `paper_storyboard_revisions` | 否 | 查看、比较、创建工作副本 |
| R | 生产版本 | `paper_studio_runs` + 对应 shot | 否；运行状态只能按既有状态机推进 | 查看、复制为新生产版本、以其 S 创建工作副本 |
| P | 计划修订 | `paper_plan_revisions` | 否 | 查看、比较、在允许状态下派生新 P；历史/完成态则复制到新 R |
| V | 图片版本 | `paper_asset_versions` | 否 | 查看、审核、作为复用候选；不得覆盖文件与状态历史 |

界面统一显示 `S12 / R16 / P3 / V108`。数据库主键只用于请求和诊断，不作为用户理解版本顺序的唯一依据。

## 5. 产品信息架构

### 5.1 两级入口

1. **快速历史抽屉**：保留现有入口，显示最近版本、时间、状态和图片概况；适合快速定位。
2. **分镜历史中心**：点击“查看完整历史”或任一版本后进入全尺寸视图；承担详情、对比、派生与影响预览。

抽屉内不堆叠复杂编辑表单。所有会改变工作状态的操作都在完整历史中心的右侧操作区完成。

### 5.2 桌面端布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 返回分镜     分镜 08 · 巷口相遇              当前工作副本：基于 S12 编辑 │
│ [全部] [脚本 S] [生产 R] [计划 P] [图片 V]          搜索/筛选/比较          │
├───────────────┬──────────────────────────────────┬───────────────────────────┤
│ 历史时间轴     │ 只读详情                         │ 影响与操作                 │
│               │                                  │                           │
│ ● S16 当前     │ S12 · 2026-08-01 14:32          │ 历史版本只读               │
│ │ R18          │ 标题、描述、动作、对白、旁白…    │ [基于 S12 创建工作副本]    │
│ │ └ P2         │ 与当前 S16 的字段差异            │                           │
│ │   ├ V108     │                                  │ 若选择 R/P：               │
│ │   └ V107     │ 关联生产：R16、R17               │ 保留 6 · 待确认 1 · 缺失 1 │
│ ● S12 已历史   │ 关联图片与调用记录                │ 预计图片 API：2 次          │
│ │ R16 已完成   │                                  │ [预览派生影响]              │
│ │ └ P3 已采用  │                                  │                           │
│ ● S11          │                                  │                           │
└───────────────┴──────────────────────────────────┴───────────────────────────┘
```

三栏职责固定：

- 左栏只负责版本导航和层级关系；
- 中栏只负责查看内容、文件、差异和证据；
- 右栏只负责影响说明与可执行动作。

### 5.3 桌面窗口窄宽响应式微调

本项目是 Electron 桌面应用，第一版不建设独立移动端信息架构、移动页签或底部操作条。响应式工作只保证用户缩窄桌面窗口时仍能完成查看和确认：

- 宽度充足时使用 §5.2 三栏布局；
- 中等宽度时压缩左侧时间轴，右侧影响区改为可展开侧栏；
- 更窄时按“时间轴 → 只读详情 → 影响预览”的自然文档顺序纵向排列；
- 主要操作仍位于影响预览末尾，不做固定底部浮层，避免遮挡内容；
- 不为手机触控单独设计手势和导航；如未来正式支持移动端，另立专项方案。

### 5.4 时间展示规范

| 对象 | 主时间 | 次时间 | UI 示例 |
|---|---|---|---|
| S | `created_at` | 无 | `保存于 2026-08-01 14:32:18` |
| R | `created_at` | `updated_at`、`completed_at` | `创建 14:35 · 完成 15:08` |
| P | `created_at` | `confirmed_at`、`superseded_at` | `创建 14:36 · 确认 14:40` |
| V | `created_at` | `accepted_at`、`rejected_at` | `生成 14:42 · 采用 14:45` |
| 审核 | decision `created_at` | reviewer | `14:45 由本地用户批准` |
| 复用 | reuse link `created_at` | source/target | `15:12 从 R16/P3/V108 复用` |

展示规则：

- 默认使用本机时区和 24 小时制，完整格式 `YYYY-MM-DD HH:mm:ss`；
- 同一天可在卡片摘要显示 `今天 14:32`，但 hover/focus title 和详情必须提供完整绝对时间；
- API 返回原始 ISO 时间和 `timezone`，前端负责本地化；
- 空值显示 `—（历史记录未记录）`，不得渲染为空白；
- 排序使用后端原始时间与 ID 游标，不使用本地化字符串排序。

### 5.5 点击行为

| 用户动作 | 结果 | 是否写库 | 图片 API |
|---|---|---:|---:|
| 单击 S/R/P/V | 打开只读详情 | 否 | 0 |
| 双击版本 | 与单击相同，不进入编辑 | 否 | 0 |
| “与当前比较” | 展示字段/计划/素材差异 | 否 | 0 |
| “基于 S 创建工作副本” | 先打开影响预览，确认后切换活动工作副本基线 | 是 | 0 |
| “复制 R 为新生产版本” | 先预览，再创建新 R 和新 shot/plan 结构 | 是 | 0 |
| “基于 P 继续调整” | 活动 run 内派生新 P，或完成/归档 run 中复制到新 R | 是 | 0 |
| “应用精确复用” | 创建目标 V 与复用链接 | 是 | 0 |
| “生成缺失图片” | 必须跳转独立报价与授权流程 | 是 | 用户授权后才可能调用 |

历史详情页不得出现“保存历史版本”或可编辑输入框。操作文案必须使用“基于此版本创建…”而不是“恢复/覆盖”，防止用户误解。

## 6. 从历史继续编辑的交互

### 6.1 基于脚本修订 S 创建工作副本

流程：

1. 用户选中 S12，查看完整只读正文以及与当前 S16 的差异。
2. 点击“基于 S12 创建工作副本”。
3. 系统展示确认页：

```text
源版本：S12（2026-08-01 14:32）
当前版本：S16（已作为历史保留）
将工作副本内容切换为：S12
旧生产版本和全部图片：保持不变
当前已发布视频：将标记为失效，需要从新工作副本重新发布
图片 API 调用：0 次
```

4. 用户确认后，系统把 `paper_storyboards` 的可编辑字段装载为 S12 内容，并记录 `working_copy_base_revision_id = S12`。
5. 因 S12 内容已存在且内容 hash 相同，此时不伪造新的 S17；界面显示“正在基于 S12 编辑”。
6. 用户真正修改并保存后，`ensureRevision()` 生成新的 S17，并记录 S17 的来源为此次派生审计。

这里的 hash 去重范围必须保持现有语义：`ensureRevision()` 按 `(paper_storyboard_id, content_hash)` 查询该分镜的**全部历史 S**，不是只与当前 S16 对比。工作副本内容与任意历史 S12 完全相同时，都复用 S12 并把 `current_revision_id` 指回 S12；只有内容 hash 在该分镜历史中从未出现时，才递增 `revision_number` 创建新 S。

切换工作副本前，当前内容必须已由现有修订机制持久化。若 `expected_version` 已过期，返回 409，不能覆盖其他窗口刚保存的内容。

### 6.2 基于生产版本 R 创建生产副本

R 详情提供两个明确不同的入口：

- **以 R16 使用的 S12 创建工作副本**：回到脚本编辑流程；
- **复制 R16 为新生产版本**：保留脚本来源和生产上下文，创建新的 R，不修改 R16。

复制生产版本分为三步：

1. 只读预览源 S/R/P、样式签名、provider 配置签名和素材状态；
2. 创建新 run、shot 和新的计划结构；只复制结构与来源关系，不复制 provider 调用账本；
3. 对新槽位执行历史复用预检，精确匹配图片在用户确认后以 `historical_reuse` 创建目标 V 和 reuse link。

新 R 创建完成时默认停在“等待复用确认/计划确认”，绝不自动推进到生图。

### 6.3 基于计划版本 P 继续调整

- 源 run 仍可编辑，且 shot 状态允许计划修复时：在当前 shot 内由 P3 派生 P4；P3 标记 superseded，但内容不变。
- 源 run 已完成、发布、取消或归档时：不能修改原 run；创建新 R，再把 P3 作为目标 run 的计划基线。
- 若修改仅涉及时间、缓动、动作轨迹或遮挡，不改变静态视觉合同，影响预览应为图片 API 0 次。
- 若计划新增主体、场景或状态槽位，只把新增/不兼容槽位送入差异报价。

### 6.4 离开与刷新后的状态

页面刷新后仍必须显示：

```text
当前工作副本：基于 S12 创建
创建时间：2026-08-01 16:20
尚未产生新脚本修订
```

用户可以“放弃当前工作副本变更并回到最新 S16”，但该操作也必须经过预览和 `expected_version` 校验。放弃只改变活动工作副本，不删除任何 S 记录。

## 7. 素材复用与费用门禁

### 7.1 候选分级

| 分类 | 条件 | 能否应用 | 当前报价口径 |
|---|---|---|---:|
| `exact` | 源 V 为 accepted；最新有效审核为 approved；文件存在且 hash 一致；视觉合同指纹完全相同 | 用户可批量确认后零调用复用 | 0 |
| `review` | 源文件和批准事实有效，但视觉合同只有部分字段兼容 | 必须逐张人工确认；未确认不能应用 | 默认计入待生成上限 1 |
| `blocked` | 文件缺失/hash 异常、来源未批准、用途冲突、身份/场景/风格不兼容 | 不能复用 | 1 |
| `rejected_history` | 源 V 为 rejected/failed/cancelled/superseded | 仅供查看，不进入复用候选 | 1 |
| `missing` | 没有可用来源 | 不能复用 | 1 |

`review` 不是“免费素材”，只是“待用户判断的候选”。在用户应用前，保守报价必须把它算进可能需要生成的数量。用户确认复用后重新生成 preview fingerprint 和报价，数量才变为 0。

### 7.2 必须修正的当前分类缺陷

当前实现把 `review` 和 `blocked` 都归入 `history_candidate`，并设置 `calls: 0`。这会低估 `estimated_image_count`。开放历史派生前必须先改为：

```text
exact        → historical_reuse, calls = 0
review       → history_review_required, calls = 1（确认复用后重新预览为 0）
blocked      → needs_image_api, calls = 1，并返回 blocked reason
no candidate → needs_image_api, calls = 1
```

费用 UI 同时展示：

- 已确认零调用数量；
- 待人工确认数量；
- 确定需要生成数量；
- 当前最少调用数；
- 未处理 review 时的保守最大调用数。

最终授权只允许基于“所有 review 已处理”的报价，避免授权金额存在歧义。

### 7.3 精确复用的硬校验

应用历史图片时，事务内重新校验：

1. 源 V 的当前状态必须是 `accepted`；
2. 最新有效审核决定必须是 `approved`，不能只判断历史上“曾经有过 approved”；
3. source/alpha/mask 中实际使用的文件必须存在且 hash 一致；
4. 源与目标的 `reuse_fingerprint` 必须相同；
5. 样式、画幅、素材类型、generation purpose 与身份锚点满足合同；
6. 目标 shot 只能处于 `plan_confirmed / asset_failed / asset_review` 等明确白名单状态；
7. published/cancelled/archived/generating/rendering 目标禁止写入；
8. 目标已有 accepted 当前图时，默认禁止覆盖；替换必须走独立人工操作。

第 4 条在 v1 只适用于同一个 `paper_storyboard_id` 内的历史版本。当前指纹包含 `project_id + paper_storyboard_id`，跨分镜 exact 在结构上不会命中；本次不删除隔离字段，也不把跨分镜 review 强行提升为 exact。

复用成功只创建新的目标 V、真实的用户确认事实和 reuse link；文件可以引用同一内容寻址 artifact，不复制或覆盖源文件。

#### 7.3.1 目标版本的审核语义

“确认采用精确匹配历史图”本身可以构成一次人工批准，但必须满足以下条件，不能由 apply-reuse 服务自动冒充用户：

1. 用户在复用影响预览中明确勾选源 V，并点击“确认采用所选历史图”；
2. 请求携带对应 source/target、preview fingerprint 和独立 confirmation request ID；
3. reviewer/actor 从可信的本地会话或操作上下文取得，不能在服务内部无条件硬编码 `local_user`；
4. reason 使用结构化语义 `historical_exact_reuse_confirmed`，同时记录人类可读说明“用户在复用预览中明确确认采用精确匹配历史图”；
5. 决定记录关联 source V、target V、reuse link 和 preview fingerprint；
6. 缺少明确确认时，目标 V 保持待审核状态，不能写入 approved；
7. 连续性修复等系统任务只能记录 system proposal，不能产生人工 approved。

如果本地产品没有登录用户，actor 可解析为受控枚举 `local_owner`，但仍必须来自本次明确按钮动作，而不是 apply-reuse 的默认值。

### 7.4 连续性修复安全约束

连续性修复不得把 `candidate` 或没有批准事实的图片直接克隆成 `accepted + approved`。只有满足 §7.3 的源图可以进入“可确认复用”列表，系统本身不能代替用户批准。

当前 `paperContinuityRepairService` 还会把 `compatibility_report` 硬编码为 `{ fingerprint_match: true, file_verified: true }`，且未完整记录 `request_id/preview_fingerprint`。阶段 A 必须删除硬编码：报告字段只能来自实际 fingerprint 比较、文件/hash 校验、最新审核决定和目标状态检查；audit 与 reuse link 都必须写入同一 request ID 和实际 preview fingerprint。任一实际校验未执行时应记录 `not_checked`，不能写 true。

连续性影响预览必须分别返回：

- 保留的 V；
- 精确可复用的 V；
- 待人工确认的 V；
- 被阻止的 V 及原因；
- 新增槽位；
- 失效槽位；
- 预计 provider 调用数。

若应用过程中任一文件或版本发生变化，整个应用事务回滚并返回 409。不能对剩余槽位自动调用 provider。

### 7.5 费用状态机

```text
HISTORY_READ_ONLY
  → FORK_PREVIEWED
  → FORK_CREATED
  → REUSE_PREVIEWED
  → REVIEW_RESOLVED
  → ZERO_CALL_REUSE_APPLIED
  → DIFFERENCE_REQUOTED
  → GENERATION_AUTHORIZED
  → PROVIDER_EXECUTING
```

硬性不变量：

- `HISTORY_READ_ONLY` 至 `DIFFERENCE_REQUOTED` 均不得增加 provider 调用账本；
- 报价必须引用最新 `preview_fingerprint`；
- 授权必须引用最新 `quote_fingerprint`；
- provider 执行只能消费有效授权；
- 复用失败不能隐式创建授权；
- 每次零调用操作记录 `provider_call_count_before/after`，两者必须相等。

## 8. API 设计

API 路径延续现有 `/api/paper-studio` 命名。所有写接口必须带 `request_id + expected_version + preview_fingerprint`；重复 `request_id` 返回第一次的结果，不重复写入。

### 8.1 历史列表

```http
GET /api/paper-studio/storyboards/:storyboardId/history?limit=20&cursor=...
```

在现有响应上补充：

```json
{
  "history": {
    "timezone": "Asia/Shanghai",
    "storyboard": {
      "id": 8,
      "version": 21,
      "current_revision_id": 16,
      "working_copy_base_revision_id": 12
    },
    "script_revisions": [
      {
        "id": 12,
        "revision_number": 12,
        "created_at": "2026-08-01T14:32:18.000Z",
        "created_from": "manual",
        "is_current": false,
        "run_count": 2
      }
    ],
    "runs": [
      {
        "id": 16,
        "run_number": 16,
        "created_at": "2026-08-01T14:35:00.000Z",
        "updated_at": "2026-08-01T15:08:00.000Z",
        "completed_at": "2026-08-01T15:08:00.000Z"
      }
    ]
  }
}
```

列表响应不返回全部 `content_json` 和大体积计划 JSON，避免首屏过重。

### 8.2 脚本修订只读详情

```http
GET /api/paper-studio/storyboards/:storyboardId/history/revisions/:revisionId
```

响应必须包含 `content_json` 的解析结果、创建信息、关联 R，以及与当前 S 的字段差异摘要：

```json
{
  "revision": {
    "id": 12,
    "revision_number": 12,
    "created_at": "2026-08-01T14:32:18.000Z",
    "content_hash": "sha256:...",
    "content": {
      "title": "巷口相遇",
      "description": "...",
      "action": "...",
      "dialogue": "...",
      "duration": 6,
      "visual_prompt": "..."
    },
    "related_runs": [{ "id": 16, "run_number": 16 }],
    "diff_from_current": {
      "changed_fields": ["dialogue", "duration"]
    }
  }
}
```

必须校验 revision 归属于 URL 中的 storyboard，防止跨分镜读取。

### 8.3 历史派生影响预览

```http
POST /api/paper-studio/storyboards/:storyboardId/history/fork-preview
```

请求示例：

```json
{
  "source": { "kind": "run", "id": 16, "plan_revision_id": 3 },
  "target_mode": "production_copy",
  "scope": "storyboard_only",
  "expected_version": 21
}
```

响应示例：

```json
{
  "preview": {
    "source_storyboard_revision_id": 12,
    "source_run_id": 16,
    "source_plan_revision_id": 3,
    "target_mode": "production_copy",
    "preserved_asset_count": 6,
    "exact_reuse_count": 5,
    "review_required_count": 1,
    "blocked_count": 1,
    "needs_image_api_count": 2,
    "provider_call_min": 1,
    "provider_call_max": 2,
    "slots": [],
    "provider_call_count_before": 9,
    "preview_fingerprint": "sha256:...",
    "expires_at": "2026-08-01T16:35:00.000Z"
  }
}
```

fingerprint 必须覆盖源版本 hash、目标当前 version、计划 hash、槽位视觉合同、候选图片状态、最新审核决定、文件 hash 和 provider 配置签名。

### 8.4 创建历史工作副本

```http
POST /api/paper-studio/storyboards/:storyboardId/history/fork-draft
```

```json
{
  "source_revision_id": 12,
  "expected_version": 21,
  "preview_fingerprint": "sha256:...",
  "request_id": "uuid"
}
```

返回当前可编辑 storyboard、工作副本来源和审计 ID。该接口必须在一个事务内：重新校验 preview、记录派生审计、装载可编辑字段、更新工作副本基线、递增 version、使已发布视频指针失效，并保留所有 S/R/P/V 历史。

`fork-preview` 和最终确认页都必须返回并显示 `published_video_will_be_invalidated`。若当前分镜存在已发布视频，用户未确认这一影响时，`fork-draft` 拒绝执行。

### 8.5 复制历史生产版本

```http
POST /api/paper-studio/storyboards/:storyboardId/history/fork-run
```

```json
{
  "source_run_id": 16,
  "source_plan_revision_id": 3,
  "scope": "storyboard_only",
  "expected_version": 21,
  "preview_fingerprint": "sha256:...",
  "request_id": "uuid"
}
```

返回新 run/shot、派生审计和初始复用预览。该接口不得接收 generation authorization，也不得调用 `advance` 或 provider。

### 8.6 复用与报价接口调整

现有接口保留，但契约收紧：

```http
POST /api/paper-studio/runs/:runId/reuse-preview
POST /api/paper-studio/runs/:runId/apply-reuse
POST /api/paper-studio/runs/:runId/generation-quote
POST /api/paper-studio/runs/:runId/generation-authorizations
```

- reuse preview 返回 `exact/review/blocked/needs_image_api` 四类，不再使用含义模糊的统一 `history_candidate`；
- apply reuse 默认只接受 exact；请求必须带用户明确选择、actor context 和 confirmation request ID，服务端不能自动硬编码 `reviewer='local_user'`；review 必须走单独的人工选择与决策 request ID；
- generation quote 必须拒绝包含未处理 review 的 preview；
- authorization 必须引用 quote fingerprint；
- 所有错误使用稳定 error code，并返回可重新预览的上下文。

### 8.7 建议错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| `PAPER_HISTORY_SOURCE_NOT_FOUND` | 404 | 源 S/R/P 不存在或不属于当前分镜 |
| `PAPER_HISTORY_VERSION_CONFLICT` | 409 | 当前工作副本已在其他窗口变化 |
| `PAPER_HISTORY_PREVIEW_STALE` | 409 | 来源、计划、审核、文件或目标版本已变化 |
| `PAPER_HISTORY_TARGET_STATE_INVALID` | 409 | 目标正在生成、已发布或已归档，不能写入 |
| `PAPER_HISTORY_REVIEW_PENDING` | 409 | 仍有 review 候选未处理，不能报价/授权 |
| `PAPER_HISTORY_REUSE_SOURCE_INVALID` | 409 | 源图状态、批准事实、文件或 hash 不再有效 |
| `PAPER_HISTORY_REQUEST_ID_REQUIRED` | 400 | 写接口缺少幂等 request ID |
| `PAPER_HISTORY_ZERO_CALL_INVARIANT_BROKEN` | 500 | 零调用操作意外改变 provider 调用账本 |

## 9. 数据模型与 migration 45 草案

### 9.1 `paper_storyboards` 新增工作副本基线

```sql
ALTER TABLE paper_storyboards
  ADD COLUMN working_copy_base_revision_id INTEGER;

ALTER TABLE paper_storyboards
  ADD COLUMN working_copy_fork_audit_id INTEGER;
```

- `current_revision_id` 继续表示当前内容对应的已保存修订；
- `working_copy_base_revision_id` 表示当前编辑工作是从哪一个 S 开始；
- 当用户修改并保存形成新 S 后，基线仍可用于显示派生关系；
- 当用户明确“以当前 S 作为新基线”时再更新该字段。

### 9.2 新增历史派生审计表

```sql
CREATE TABLE paper_history_fork_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_storyboard_revision_id INTEGER NOT NULL,
  source_run_id INTEGER,
  source_shot_id INTEGER,
  source_plan_revision_id INTEGER,
  target_mode TEXT NOT NULL,
  target_storyboard_revision_id INTEGER,
  target_run_id INTEGER,
  target_shot_id INTEGER,
  target_plan_revision_id INTEGER,
  status TEXT NOT NULL DEFAULT 'previewed',
  impact_json TEXT NOT NULL DEFAULT '{}',
  preview_fingerprint TEXT NOT NULL,
  provider_call_count_before INTEGER NOT NULL DEFAULT 0,
  provider_call_count_after INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  UNIQUE(paper_storyboard_id, request_id)
);

CREATE INDEX idx_paper_history_fork_source
  ON paper_history_fork_audits(
    paper_storyboard_id,
    source_storyboard_revision_id,
    created_at DESC
  );

CREATE INDEX idx_paper_history_fork_target_run
  ON paper_history_fork_audits(target_run_id, target_shot_id);
```

`impact_json` 保存预览时的完整资产差异和费用统计，但不能代替 `paper_asset_reuse_links`。前者记录一次派生决策，后者记录每一张源 V 到目标 V 的事实关系。

### 9.3 脚本修订来源

当前 `created_from` 是文本字段，可以新增规范值 `history_fork_edit`。新 S 形成后，把对应 audit ID 写入审计表的 `target_storyboard_revision_id`，不修改旧 S。

第一版不必给 `paper_storyboard_revisions` 增加父 ID；派生图可以从审计表得出。若未来支持多个并行工作副本，再单独引入 revision parent/branch 模型，避免本次过度设计。

### 9.4 migration 45 的事务要求

当前 migration runner 会按分号逐条执行 SQL，`ensureColumns()`、回填和结构重建又在后续步骤执行。migration 45 不应继续依赖这种“逐条成功”的方式。

实施要求：

1. 为 migration 45 增加专用幂等执行器；执行前通过 `PRAGMA table_info` 检查列，而不是靠捕获 duplicate column；
2. DDL、`working_copy_base_revision_id = current_revision_id` 回填、索引创建、审计表创建和完整性断言放在同一个 `database.transaction()`；
3. 任一断言失败则整体回滚；
4. 事务成功后才写 migration 完成标记；
5. 启动兜底逻辑只能补齐缺失结构，不能在事务外重复业务回填；
6. 必须用“旧库、部分 migration 44 库、当前正式库副本”三类 fixture 测试；
7. 正式执行前先备份数据库并运行 dry-run；正式执行需要用户单独确认。

migration 45 完成断言至少包括：

- 所有活动 storyboard 的 `working_copy_base_revision_id` 非空且指向同 storyboard 的修订；
- migration 44 的 27 个计划指针仍完整；
- 图片版本数不少于 108；
- 文件引用不少于 116，且原 hash 校验结果不退化；
- provider 调用总数仍为 9；
- `PRAGMA integrity_check = ok`；
- 没有孤立 fork audit 或跨 storyboard 的 source revision。

## 10. 幂等、并发与失败回滚

### 10.1 幂等

- 每个写接口必须要求客户端 UUID `request_id`；
- 唯一键范围包含资源 owner，例如 `(paper_storyboard_id, request_id)`；
- 重复请求返回首次成功创建的 target/audit，不重复创建 run、plan、V 或审核决定；
- 前端按钮提交后立即 disabled，并允许网络重试复用同一 request ID。

### 10.2 乐观并发

- 工作副本写入校验 `paper_storyboards.version`；
- run 操作校验 `paper_studio_runs.version`；
- shot/plan 影响写入时同时校验 `shot.version + current_plan_revision_id`；
- 复用应用时重新计算文件 hash、最新审核决定和 preview fingerprint；
- 任何一项变化返回 409，前端刷新预览，不自动重试写操作。

### 10.3 事务边界

以下内容分别在单一数据库事务内完成：

- 创建工作副本 + fork audit；
- 创建新 run/shot/plan 基线 + fork audit；
- 每批 exact 复用的目标 V、slot 指针、审核事实、reuse link 和版本递增；
- 计划派生、旧 P superseded 标记、目标 P 创建和影响审计。

文件不在 SQLite 事务内，因此应用复用前先校验现存内容寻址文件，事务内再次核对记录 hash；不复制文件就不产生半写文件。若未来需要复制 artifact，采用“临时文件 → fsync/hash → 数据库提交 → 原子 rename”的顺序。

### 10.4 失败表现

- 预览失败：不写任何业务数据；
- 工作副本派生失败：工作副本和 audit 一起回滚；
- 新 R 创建失败：run/shot/plan/audit 一起回滚；
- 复用批次任一槽位失败：整批回滚，不保留半批结果；
- provider 执行失败：按现有 generation ledger 记录，不能回写为历史复用成功；
- 客户端断线：用 request ID 查询结果，不重复操作。

## 11. 归档保真设计

### 11.1 当前问题

当前普通归档在 `include_diagnostics=false` 时只导出 `status='accepted'` 的图片版本；归档 manifest 还完全不导出 `paper_asset_review_decisions`。导入时又把所有图片强制写为 accepted，并使用新的当前时间。这会产生三类后果：

- rejected/failed/cancelled/superseded 图片、原始时间和父版本丢失或失真；
- 原 approved/rejected 审核事实、reviewer、reason 和顺序全部丢失；
- 导入后的图片虽然被强制标成 accepted，但 `approved_review_count=0`，按新的复用门禁会全部成为 blocked，审核信任链断裂。

因此，v2 不能只补图片状态；图片版本、审核决定和源目标关系必须作为同一个业务历史单元归档。

### 11.2 archive schema v2 要求

普通归档必须始终包含：

- 所有 S/R/P/V 业务记录，包括 soft-deleted/archived 记录；
- 所有图片版本及其 source/alpha/mask 文件；
- V 的原始 status、created/accepted/rejected 时间、parent version；
- 所有图片审核决定及 reviewer、reason、request ID、时间；
- 所有复用链接、连续性修复审计和历史派生审计；
- 所有 current 指针和 source/target 映射；
- 每个 artifact 的 hash、大小和 kind。

`include_diagnostics` 只控制 proof/debug frame、运行日志等可再生诊断数据，不能控制业务历史和历史图片文件。

### 11.3 导入要求

- 使用 old ID → new ID 映射恢复父子关系和 current 指针；
- 保留原始 status 和时间，不把所有 V 改成 accepted；
- 保留源审核事实，但跨设备导入后增加独立 `import_trust_state=review_required` 语义；
- 导入图片只有在本地重新 hash 校验且用户确认信任后，才能用于新生产复用；
- 导入失败必须整体回滚数据库写入；已落盘 artifact 采用内容寻址，可由清理任务识别未引用文件；
- archive v1 继续只读兼容，但导入时明确标注“旧归档缺少完整状态，需人工复核”，不得伪造批准事实。

### 11.4 往返验证

同一项目执行 export v2 → 新库 import → export v2 后，除数据库新 ID、导入信任状态和 manifest 时间外，下列语义必须一致：

- S/R/P/V 数量与层级；
- 每个 V 的状态、时间、父版本和文件 hash；
- 审核决定顺序；
- current 指针；
- reuse link 与 fork audit 的源目标关系；
- provider 调用事实。

## 12. 前端行为与可访问性

视觉上延续现有黑金暗色系统，不引入新的主主题。绿色只用于“文件完整”“精确可复用”“0 调用”等正向状态；红色用于文件损坏、费用或阻断警告；金色保留给当前选择和主要操作。

必须满足：

- 所有版本卡片和操作按钮可通过 Tab 到达；
- 时间轴节点使用 button/link 语义，不用仅绑定 click 的 span；
- 折叠项动态设置 `aria-expanded` 和 `aria-controls`；
- 当前版本使用文本 + 图标 + 颜色三重表达，不只靠颜色；
- 历史详情明确显示“只读”；
- 图片有描述性 alt；失败占位说明失败原因；
- focus 边框对比度清晰；
- 动效遵守 `prefers-reduced-motion`；
- 历史抽屉作为 modal dialog 时必须建立焦点陷阱，打开后聚焦标题或第一个操作，关闭后把焦点还给触发按钮；
- Escape 关闭二级检查器，但不能误关闭尚未确认的影响预览；
- 列表、分页、run detail 和 asset detail 使用各自的 loading/error 状态与请求序号（或 AbortController），旧请求不得覆盖新选择的错误和数据；
- 关闭含未提交工作副本修改的编辑页时沿用现有离开确认。

## 13. 实施顺序

### 阶段 A：先修安全与计费缺陷

1. 修正 `review/blocked` 的复用分类和报价口径；
2. 明确并测试 v1 的 `storyboard_only` 指纹/查询边界；不得把当前跨分镜不命中误报为 exact；
3. 修正连续性修复的 accepted/approved 克隆条件，并把硬编码 compatibility report 改为实际校验结果；
4. 给连续性 repair audit/reuse link 补齐同一个 request ID 和实际 preview fingerprint；
5. 把“最新有效审核决定”作为复用依据；
6. 修正 apply-reuse 的审核语义：只有用户明确确认才记录目标 approved，actor/reason/preview 可追溯；
7. archive v2 完成前，导入素材保持 `review_required`，不得因 imported/accepted 状态绕过批准事实；
8. 增加零调用账本、实际 compatibility report 和人工确认不变量测试；
9. 与统一方案保持指纹域顺序：先通过 E1 路径↔hash 校验，再做 exact 文件校验；付费请求继续使用 E3 `request_fingerprint` 幂等，严禁与 `reuse_fingerprint` 混用；
10. 在这些测试通过前，不开放任何历史派生按钮。

### 阶段 B：只读历史中心

1. 现有抽屉补齐 S/R/P/V 时间；
2. 增加脚本修订详情接口，展示完整 `content_json`；
3. 历史列表 API 增加真实 `total_run_count`；分页加载后不能用“当前已加载数组长度”冒充总生产版本数；
4. `loadMore` 增加 catch、可见错误与安全重试，不能静默失败；
5. 拆分 list/run/asset/pagination error 状态并增加请求竞态保护；
6. 在现有 `paperStudioLabels.js` 上扩展 `created_from`、复用与时间文案映射，不展示裸枚举；
7. 给抽屉补齐 Escape、初始焦点、焦点陷阱和关闭后的焦点归还；
8. 建立全尺寸历史中心、筛选、只读详情、版本比较和窄宽响应式微调；
9. 所有操作按钮暂为 feature flag 关闭。

这一阶段不需要 migration 45，可先独立验收“看得见、时间清楚、不能误编辑”。

### 阶段 C：migration 45 与脚本工作副本派生

1. 实现事务化 migration 45 和 dry-run；
2. 新增 working copy 基线与 fork audit；
3. 实现 fork preview 与 fork draft；
4. 完成幂等、并发、刷新恢复和放弃工作副本测试；
5. 正式数据库 migration 需用户再次明确确认。

### 阶段 D：生产/计划派生与素材复用

1. 实现 fork run 与 plan 派生；
2. v1 的 fork/reuse scope 固定为同一 storyboard；从 R 派生默认仅当前分镜；
3. 把 source S/R/P 与目标结构完整写入 audit；
4. 接通 exact/review/blocked UI 和真实用户确认；
5. 强制执行“复用 → 重报价 → 授权”顺序；
6. feature flag 小范围启用。

### 阶段 E：归档 v2

1. 全状态图片、`paper_asset_review_decisions`、复用链接和派生审计导出；
2. 状态、时间、parent/current 指针保真导入；
3. v1 兼容与 v2 往返测试；
4. 通过后才能宣称历史可长期保存和跨库恢复。

### 阶段 F：上线与观察

1. 上线前记录正式库守恒指标；
2. 先开启只读中心，再开启工作副本派生，最后开启生产派生；
3. 记录 preview、reuse、quote、authorization 各阶段数量；
4. 发现 provider 调用异常立即关闭派生 feature flag，不回滚历史数据；
5. 观察期结束后再移除旧抽屉中的临时展示路径。

## 14. 测试计划

### 14.1 后端单元/集成测试

- 历史列表返回所有时间字段，空值语义明确；
- S 详情返回完整 content，跨 storyboard revision 返回 404；
- 查看历史不改变任何 version 和 provider ledger；
- fork draft 保留源 S，当前 S 也仍可查询；
- 工作副本回到任意历史 S 的相同内容时复用该历史 revision；去重查询覆盖同 storyboard 全部 S，而不是只比当前 S；
- fork draft 预览明确返回已发布视频失效影响；未确认该影响时拒绝执行；
- 相同 request ID 不重复派生；过期 expected version 返回 409；
- 用户保存真实修改后才创建新 S；
- fork run 不复制 provider 调用记录，不自动 advance；
- exact 仅在 accepted + 最新 approved + 文件/hash + fingerprint 全部满足时成立；
- 同 storyboard exact 可命中，跨 storyboard 因 v1 scope/指纹隔离不得命中；
- approved 后又 rejected 的来源不得复用；
- review 未确认时计入待生成上限且不能授权；
- blocked 必须落入 needs image API，但不能自动生成；
- candidate 不得被连续性修复克隆为 accepted/approved；
- continuity compatibility report 的 fingerprint/file/approval/state 字段均来自实际校验，并保存 request ID/preview fingerprint，不允许硬编码 true；
- apply-reuse 缺少用户明确选择或可信 actor context 时不得创建目标 approved；system repair 永远不能创建人工批准；
- 复用批次中一个文件变化时整批回滚；
- 零调用流程 provider count 前后相同；
- 归档 v2 往返保留所有状态、时间、parent、`paper_asset_review_decisions`、review 顺序和 hash；
- archive v1 或未重建本地信任的导入素材保持 review_required，不能进入 exact；
- migration 45 中途故障时整体回滚。

### 14.2 前端测试

- R 摘要和 S/P/V 详情都显示明确时间；
- 点击版本进入只读详情，没有可编辑 input；
- “基于此版本…”必须先出现影响预览；
- 确认页固定显示“源历史不变”和“图片 API 调用”；
- review/blocked/0 调用颜色与文案一致；
- 有未处理 review 时生成授权按钮 disabled，并说明原因；
- 请求失败后可安全重试同一 request ID；
- 总版本数来自 API total，不随分页加载数量变化；
- loadMore 失败显示可见错误且可以重试；list/run/asset 的旧请求不能覆盖新选择；
- `created_from` 使用 `paperStudioLabels.js` 中文映射，不显示裸枚举；
- 键盘导航、焦点陷阱、关闭后焦点归还、Escape 和 `aria-expanded` 正确；
- 桌面窄窗口按文档顺序重排，主要操作不使用遮挡内容的固定底栏。

### 14.3 核心端到端场景

1. **只改对白**：从 S12 创建工作副本，修改对白生成 S17，新 R 复用全部静态图，provider 调用增量为 0。
2. **只换背景**：角色和道具 exact 复用，只对背景槽位报价；授权前调用增量为 0。
3. **旧图待确认**：review 图未确认时不能授权；用户接受后重新预览，调用数减少 1。
4. **文件损坏**：历史 V 可查看但标为 blocked；系统说明 hash 异常，不自动补图。
5. **历史拒绝图**：rejected 图仍可查看，但不能作为复用来源。
6. **连续性时间修复**：在当前 run 派生 P，图片全部保留，provider 调用增量为 0。
7. **已完成 R 派生**：R16 保持不变，新建 R17，复用关系可从 V 追溯回 R16/P3/V108。
8. **归档往返**：accepted/rejected/failed/cancelled/superseded 图片数量和状态全部一致。

## 15. 验收标准

只有全部满足以下条件，才可关闭本次改造：

1. 每个分镜可在同一历史中心查看所有 S/R/P/V。
2. 每条历史记录显示明确绝对时间，空值不再表现为空白。
3. 点击任意 S 能查看完整历史正文和与当前版本差异。
4. 历史版本没有原地编辑入口。
5. 从 S/R/P 派生前必须展示影响预览，确认后源版本仍完全可查。
6. 创建工作副本、复制生产结构和应用 exact 复用的 provider 调用增量均为 0。
7. review 未确认、blocked、拒绝和文件异常图片不会被计为已完成零调用复用。
8. v1 exact 复用严格限制在同一 storyboard；界面和 API 不暗示支持跨分镜 exact。
9. apply-reuse 只有在用户明确确认、actor/reason/preview 完整时才能记录目标 approved；系统任务不能伪造人工批准。
10. continuity compatibility report 全部来自实际校验，不存在硬编码通过项。
11. 只有扣除已应用复用后的差异槽位可以进入报价和授权。
12. 未经最终授权，任何路径都不能执行图片 provider。
13. 每次派生和复用都有 source/target、hash、预览指纹、request ID 和调用前后记录。
14. 普通归档包含所有图片状态与 `paper_asset_review_decisions`，导入不篡改状态、时间、parent 和审核事实。
15. migration 45 故障可整体回滚，正式库基线数量和 integrity 不退化。
16. 自动测试证明“只改对白/时长/转场”可以实现图片 API 0 次。

## 16. 首轮评审已确认的设计决策

首轮评审已对以下 7 项全部同意推荐方案。本版将其视为已确认约束，不再作为待决问题；后续若要变更，必须重新走方案评审。

| 决策点 | 已确认方案 | 未采用方案及影响 |
|---|---|---|
| 工作副本模型 | 第一版维持每个分镜一个活动工作副本，并用 audit 记录来源 | 多并行分支需要新增 branch 实体、合并与冲突 UI，范围显著扩大 |
| 从 R 派生的范围 | v1 仅允许“当前分镜”；原 R 全部分镜复制留待后续按每个 storyboard 分别计算指纹与费用 | 直接复制整个 R 容易意外带入其他分镜，且与当前 storyboard-only 指纹边界冲突 |
| review 的报价 | 未处理时禁止最终授权；预览显示最少/最大调用数 | 直接按 0 会低估费用；直接按必生成会掩盖可复用价值 |
| exact 是否自动应用 | 默认仍需用户批量确认，再以 0 调用应用 | 静默自动应用降低可审计性，且文件/审核变化时更难解释 |
| 已发布/归档 run 的 P 调整 | 必须复制到新 R | 原地修改会破坏已发布证据链 |
| 跨设备导入的批准事实 | 保留历史事实，但本地复用前重新建立信任 | 直接继承可复用权限存在信任域风险 |
| archive v1 | 只读兼容并标记信息不完整 | 尝试推断缺失状态会制造不真实审核事实 |

## 17. 评审通过后的执行门禁

评审通过不等于立即执行正式 migration。建议采用三个单独确认点：

1. **方案确认**：确认产品语义、API 和 migration 45 设计；
2. **代码确认**：代码与自动测试完成后，提交变更审查；
3. **正式 migration 确认**：展示正式库备份、dry-run 结果和守恒指标后，由用户明确批准执行。

在第三个确认点之前，不允许对正式数据库运行 migration 45。

## 18. 预计代码触点（供评审估算）

本节只列预计触点，不代表本轮已经修改。

### 18.1 后端

| 文件/模块 | 预计职责 |
|---|---|
| `backend-node/migrations/45_paper_storyboard_history_fork.sql` | working copy 字段、fork audit 表和索引的结构说明 |
| `backend-node/src/db/migrate.js` | migration 45 专用事务执行、回填、完成标记和断言 |
| `paperStoryboardHistoryService.js` | 时间摘要、S 详情、版本关联和只读差异数据 |
| 新 `paperStoryboardHistoryForkService.js` | fork preview、fork draft、fork run、幂等与审计 |
| `paperStoryboardService.js` | 安全装载历史 content、工作副本基线、真实修改后创建新 S |
| `paperStudioRunService.js` | 从指定历史 revision 创建目标 run，而不再强制只能使用当前 S |
| `paperAssetReuseService.js` | exact/review/blocked 分类、storyboard-only 边界、最新审核决定、真实确认 actor/reason、零调用不变量 |
| `paperContinuityRepairService.js` | 禁止 candidate 越权变 accepted/approved，实际 compatibility report、request/preview 链、目标状态白名单 |
| `paperGenerationAuthorizationService.js` | 强制 review 已处理、quote/reuse fingerprint 一致 |
| `paperStudioArchiveService.js` | archive v2 全状态、review decisions 与审计关系导出及保真导入 |
| `backend-node/src/routes/paperStudio.js`、`routes/index.js` | 新历史详情和派生接口路由 |
| Paper Studio API schema | 新请求/响应校验与稳定错误码 |

### 18.2 前端

| 文件/模块 | 预计职责 |
|---|---|
| `PaperStoryboardHistoryDrawer.vue` | 补时间/真实总数、分页错误、请求竞态、ESC/焦点陷阱和完整历史入口 |
| 新 `PaperStoryboardHistoryCenter.vue` | 桌面三栏与窄宽重排、只读详情、版本比较 |
| 新 `PaperHistoryForkPreview.vue` | 来源、影响、复用和调用次数确认 |
| `frontweb/src/api/paperStudio.js` | S 详情、fork preview/draft/run API |
| `paperStudioStore.js` | 历史中心缓存、幂等 request ID、409 刷新和工作副本来源 |
| `PaperStudio.vue` / 分镜 rail | 历史中心导航、刷新后“基于 Sxx 编辑”提示 |
| 已存在的 `paperStudioLabels.js` | 在现有单一来源上扩展 S/R/P/V、`created_from`、复用和时间状态文案 |

### 18.3 测试

| 文件/模块 | 预计职责 |
|---|---|
| `paperStoryboardHistoryReuse.test.js` | 扩展历史详情、storyboard-only 分类、真实审核确认、派生和零调用测试 |
| 新 `paperStoryboardHistoryFork.test.js` | fork 幂等、并发、事务和来源追溯 |
| `paperStudioAssets.test.js` | 最新审核决定、文件/hash 和目标状态门禁 |
| archive 测试 | v1 兼容、v2 全状态与 review decisions 往返、导入信任 |
| migration fixture 测试 | 旧库、半迁移库、正式库副本和故障回滚 |
| `frontweb/test` 历史中心测试 | 时间、真实总数、分页/竞态、只读、影响预览、键盘和桌面窄宽布局 |

## 19. v2 复核检查清单

首轮决策已经固化。评审人可用以下清单确认条件项是否已全部关闭：

1. §11.1 是否明确写出当前归档完全漏掉 `paper_asset_review_decisions` 及其后果；
2. §3.3、§7.3、§8.5 和 §16 是否一致限定 v1 为 storyboard-only；
3. §7.4 和阶段 A 是否要求 continuity compatibility report 使用实际校验结果并记录 request/preview 链；
4. §7.3.1 是否把用户明确确认、可信 actor 和结构化 reason 作为目标 approved 的必要条件；
5. 阶段 B 是否覆盖总数少报、loadMore 静默失败、error 竞态、裸 `created_from` 和 ESC/焦点陷阱；
6. §6.1 是否明确 S hash 去重覆盖同 storyboard 的全部历史修订；
7. fork-draft 预览是否明确显示已发布视频将失效，并要求用户确认；
8. 是否已删除独立移动端设计，只保留 Electron 桌面窗口窄宽微调；
9. 阶段 A 是否仍是所有派生功能的不可跳过前提，并与统一方案 E1/E3 指纹域保持正确顺序；
10. 归档、复用、连续性和抽屉缺陷是否都有对应自动测试与验收项。

---

本方案的核心保证是：用户可以从任意历史版本继续创作，但历史本身永远不被改写；用户可以复用旧图，但系统不会把“可能可用”伪装成“已经免费复用”；任何图片 API 调用都发生在差异复用完成、报价重新计算并得到最终授权之后。
