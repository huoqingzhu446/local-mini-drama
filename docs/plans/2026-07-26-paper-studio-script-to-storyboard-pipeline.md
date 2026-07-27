# 纸片动画工作室：剧本直入 · 实体库 · 自动分镜 一体化方案

> 文档状态：方案设计（待评审，未实施）
> 日期：2026-07-26
> 适用范围：独立纸片动画模式（Paper Studio）
> 前置文档：`docs/plans/2026-07-26-paper-studio-business-ux-closure-redesign.md`、`docs/technical/2026-07-26-paper-studio-independent-authoring-design.md`
> 一句话目标：在纸片工作室内完成「导入剧本 → 一键提取人物/场景/道具 → 自动生成纸片分镜」，且提取生成的实体素材以**纸片规格**落库，任意分镜切换场景时角色与道具**位图级复用、零重复调用、零画风漂移**。
> 本次增补：第 11 章「UI 全面重构」——修复当前界面字号过小、点按目标过小、手输 ID 等问题，让纸片视频全流程操作方便快捷。

---

## 0. 决策摘要

### 0.1 用户需求原文

> 我导入剧本，一键提取人物/场景/道具 → 自动生成纸片分镜；生成的人物/场景/道具必须要能完美切换纸片动画的场景。

### 0.2 「完美切换场景」的工程定义

这句话必须翻译成可验收的合同，否则会退化成"看起来差不多"：

| # | 合同 | 可验收口径 |
|---|------|-----------|
| C1 | 同一角色/道具在所有分镜中使用**同一张正式素材**（同一 identity version 的 source/alpha/mask 文件） | 跨镜素材文件 hash 一致；`paper_asset_versions.derivation_kind = 'library_reuse'` |
| C2 | 场景是**干净空景**（clean plate），不含任何角色与道具 | 现有 `clean_plate` 槽位约束 `no_primary_subjects: true` 沿用 |
| C3 | 角色/道具是**透明背景独立层**，可直接叠放到任何场景上 | alpha PNG + 统一登记画布；provider 不支持透明时走 `paperMatteService` 本地抠图 |
| C4 | 切换场景 = 只换背景 family，前景层原样保留，**不触发角色/道具重新生图** | 生成授权报价中库复用槽位显示「0 次调用」 |
| C5 | 角色跨场景**比例不畸变**（在 A 场景是全身 1/3 屏高，到 B 场景不会变成半屏） | 实体库登记比例锚（relative_height）+ 蓝图布局按比例锚推导 |
| C6 | 全剧**画风统一** | 实体库级风格锚（style anchor）注入所有实体生图 prompt，并写入 provenance |

### 0.3 方案一句话

在 Paper Studio 前面加一个「剧本工作台」阶段（剧本版本 → 实体提取 → 实体库 → 分镜生成），并把**项目级纸片实体库**贯通到现有蓝图/素材/授权链路——实体库产出的正式素材直接成为每一镜素材槽位的复用来源。

---

## 1. 现状与差距分析（代码基线）

### 1.1 已有的"插座"（本方案直接复用，不新造）

| 现有能力 | 位置 | 本方案如何用 |
|---|---|---|
| 分镜实体表已预留库绑定字段：`identity_version_id`、`source_library_type`、`source_library_id`、`reusable` | `migrations/35_paper_studio_blueprints.sql` → `paper_storyboard_entities` | 直接写入纸片实体库的引用，不改表结构（编译器现在全部写 `null`，见 `paperBlueprintCompilerService.js:136-146`） |
| 素材槽位/版本体系：family → slot → version，version 带 `source/alpha/mask` 三路文件和 `derivation_kind` | `migrations/31_paper_studio_v3.sql` | 新增 `derivation_kind: 'library_reuse'`，复制库素材文件为镜内版本 |
| 透明约束与登记画布：`transparent_background: true`、`registration_canvas 1920×1080`、`clean_plate` + `no_primary_subjects` | `paperBlueprintCompilerService.js:235-298` | 实体库素材按同一套约束生成，天然兼容 |
| 本地抠图 | `services/paperMatteService.js` | provider 不支持透明输出时给库素材补 alpha |
| 连续性合同（subject signature 按 identity 文本哈希） | `paperContinuityService.js` | 绑定库实体后 signature 改用 `library_entity_id`，从"文本相似"升级为"同一实体" |
| 三段式付费门禁（报价 → 授权 → 执行） | `paperGenerationAuthorizationService.js` | 实体形象生成走同一门禁；分镜生产报价区分"新调用/库复用 0 调用" |
| 素材逐张审核工作台 | `PaperAssetReviewWorkbench.vue` + `paperAssetReviewService.js` | 实体库形象审核复用同一交互（批准/退回/重抠/上传替换/历史） |
| 影响确认对话框 | `PaperImpactDialog.vue` | 实体改版影响预览复用 |
| 旧工作台文本提取能力（prompt 模板 `character_extraction` / `scene_extraction`、`propExtractionService`、小说导入 `dramaImportService`） | `backend-node/src/services/` | 提取/分镜生成的 LLM prompt 逻辑参考移植，但**独立成纸片版服务**，不建立运行时依赖（保持独立模式边界） |

### 1.2 差距（本方案要补的洞）

| # | 差距 | 后果 |
|---|---|---|
| G1 | Paper Studio 没有"剧本"概念，分集只有 title/summary | 用户只能逐镜手写，无法从剧本出发 |
| G2 | `paperStudioSourceService.context()` 对纸片分镜返回 `characters: [] / scene: null / props: []`（`paperStudioSourceService.js:context`） | 分析器只能从自由文本猜实体（`inferredActorIdentity` 的正则兜底），身份不稳定 |
| G3 | `paper_source_families` 是 per-shot 的（`UNIQUE(shot_id, family_key)`），没有项目级素材库 | 同一角色每镜重新生图：费额度、跨镜漂移、切场景不一致 |
| G4 | 没有实体提取和分镜自动生成的纸片版服务与 API | 一键流程无从谈起 |
| G5 | 分镜编辑器无实体绑定 UI | 用户无法声明"这一镜有谁、在哪、拿什么" |

---

## 2. 总体方案与信息架构

### 2.1 新的一级流程

```text
阶段 S1 剧本          导入/粘贴剧本 → 保存为不可变剧本版本
阶段 S2 实体          一键提取（文本模型，0 图片调用）→ 人工确认/合并/改名 → 入库
阶段 S3 形象          批量生成实体形象（显式授权 N 次图片调用）→ 逐张审核 → 冻结为 identity version
阶段 S4 分镜          一键生成纸片分镜（文本模型，0 图片调用）→ 每镜结构化绑定实体 → 人工调整
阶段 A–H（现有）      参考图 → 创建生产版本 → 蓝图 → 授权 → 素材(库复用) → 动作 → 预览 → 音频 → 交付
```

关键原则：

- S1–S4 全部**可跳过**——现有"手写分镜"路径原样保留，新链路是加速通道不是必经之路；
- S2/S4 只花文本模型额度，S3 才碰图片 API，且必过现有三段式授权门禁（BR-001 不破例）；
- 实体库属于**纸片项目级**（`paper_studio_projects`），与旧工作台的 characters/scenes/props 表零运行时依赖；旧工作台资产只能"显式引用导入"（复制文件 + 补抠图），与现有"从旧工作台导入分镜"同一边界哲学。

### 2.2 页面结构（前端）

```text
Paper Studio
├── 左栏（现有：纸片分集 / 纸片分镜 / 生产版本）
├── 工作区模式切换（现有：分镜创作 / 分集交付）
│   └── 新增：剧本与实体   ← 新 tab，含 S1–S4 四个分区
│       ├── 剧本卡（版本历史 / 粘贴 / 上传 txt / 从旧工作台复制剧本文本）
│       ├── 实体库（人物 / 场景 / 道具 三列卡片，形象状态、版本、引用计数）
│       ├── 提取结果确认面板（候选实体 diff：新增 / 合并到已有 / 忽略）
│       └── 生成分镜面板（目标镜数、时长偏好、覆盖策略、生成预览与应用）
├── 分镜编辑器（现有 PaperStoryboardEditor）
│   └── 新增：实体绑定芯片行（场景 ×1 / 人物 ×N / 道具 ×N，可增删改）
└── 右栏（现有）
    └── 授权报价新增"库复用 0 调用"行
```

---

## 3. 数据模型

### 3.1 新表（migration `41_paper_studio_script_library.sql`）

```sql
-- 剧本：分集级，不可变版本链（对齐 BR-002：进入生成的必须是已保存版本）
CREATE TABLE IF NOT EXISTS paper_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_episode_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'manual',   -- manual | file_upload | legacy_copy
  created_at TEXT NOT NULL,
  UNIQUE(paper_episode_id, version_number)
);

-- 实体库：纸片项目级
CREATE TABLE IF NOT EXISTS paper_library_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,                  -- paper_studio_projects.id
  entity_type TEXT NOT NULL,                    -- character | scene | prop
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',      -- 提取合并时累积的别名，用于后续分镜生成的实体对齐
  description TEXT NOT NULL DEFAULT '',         -- 外貌/氛围/材质等画面描述
  canonical_prompt TEXT NOT NULL DEFAULT '',    -- 生图用的规范化 prompt（含风格锚展开）
  scale_anchor_json TEXT NOT NULL DEFAULT '{}', -- C5 比例锚：{ relative_height: 0.62, ground_anchor: 0.88 }
  current_identity_version_id INTEGER,          -- 当前正式形象
  extraction_meta_json TEXT NOT NULL DEFAULT '{}', -- 来源剧本版本、提取批次
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | confirmed | archived
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE(project_id, entity_type, name)
);

-- 实体形象版本：不可变（对齐素材版本哲学；改版=新版本+影响预览）
CREATE TABLE IF NOT EXISTS paper_library_identity_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  source_local_path TEXT,                       -- 原图
  alpha_local_path TEXT,                        -- 透明层（character/prop 必有；scene 为 NULL）
  mask_local_path TEXT,
  source_hash TEXT, alpha_hash TEXT,
  registration_json TEXT NOT NULL DEFAULT '{}', -- 登记画布、主体包围盒、接地线
  provenance_json TEXT NOT NULL DEFAULT '{}',   -- provider、model、prompt、style_anchor_hash、image_generation_id
  derivation_kind TEXT NOT NULL,                -- generated | uploaded | legacy_import
  status TEXT NOT NULL DEFAULT 'candidate',     -- candidate | approved | rejected | superseded
  created_at TEXT NOT NULL, accepted_at TEXT, rejected_at TEXT,
  UNIQUE(entity_id, version_number)
);

-- 分镜⇄实体绑定：作者态（生产态仍走 paper_storyboard_entities 冻结快照）
CREATE TABLE IF NOT EXISTS paper_storyboard_entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',         -- scene | subject | carried_prop | static_prop
  binding_json TEXT NOT NULL DEFAULT '{}',      -- 该镜内的状态覆盖（初始位置偏好等，可选）
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(paper_storyboard_id, entity_id, role)
);

-- 项目级风格锚（C6）：一条激活记录，注入所有实体生图 prompt
CREATE TABLE IF NOT EXISTS paper_style_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  anchor_text TEXT NOT NULL,                    -- 例：剪纸质感、扁平色块、粗描边、暖色纸纹……
  anchor_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

### 3.2 复用而非新建

- 分镜的 `content_json`（`paper_storyboard_revisions`）增加可选字段 `entity_links`（entity_id + role 数组的快照），保证"创建生产版本时冻结的 revision"自包含实体绑定——**revision hash 因此覆盖绑定变化**，改绑定 = 新 revision = 旧蓝图/授权按现有规则失效，无需新失效机制；
- 生产态实体仍写 `paper_storyboard_entities`，但填上 `source_library_type='paper_library'`、`source_library_id`、`identity_version_id`、`reusable=1`；
- 库素材复用进镜时在 `paper_asset_versions` 新增一条 `derivation_kind='library_reuse'` 记录，`provenance_json` 指回 `identity_version_id`——镜内审核、Mask、回退等现有能力全部自然可用。

---

## 4. 后端服务与 API

### 4.1 新服务（`services/paper-studio/`）

| 服务 | 职责 | 要点 |
|---|---|---|
| `paperScriptService.js` | 剧本版本 CRUD | 纯数据；空剧本不能提取（对齐"空白不能进生产"） |
| `paperEntityExtractionService.js` | 剧本 → 候选实体 | 调文本模型（走现有 `aiClient` + AI 配置），输出严格 JSON schema；与库中已有实体做名称/别名对齐，返回三态候选：`new` / `merge_into:<id>` / `conflict`；**不落库**，确认后才写 |
| `paperIdentityProductionService.js` | 实体形象生成 | 组 prompt（canonical_prompt + style anchor + 纸片规格约束），走三段式授权 → 图片 API → provider 无透明输出则 `paperMatteService` 补抠 → 登记包围盒/接地线 → candidate 版本 → 审核后 approved 并设为 current |
| `paperStoryboardGenerationService.js` | 剧本 + 实体库 → 分镜草稿 | 文本模型输出每镜 `{title, description, action, dialogue, narration, duration, shot_type, camera_motion, environment_only, scene_entity, character_entities[], prop_entities[]}`；实体引用**必须命中库 id**（prompt 里给实体清单，输出校验，未命中项降级为文本并标警告）；写入 `paper_storyboards` + revision + entity_links |
| `paperLibraryReuseService.js` | 生产时库素材 → 镜内槽位 | 复制 source/alpha/mask 文件到镜目录，建 `library_reuse` 版本；同一 run 内幂等 |

### 4.2 现有服务改造（最小侵入）

| 文件 | 改造 |
|---|---|
| `paperStudioSourceService.js` | `context()` 纸片分支：读取 revision 内 `entity_links` → 关联库实体 → 返回真实的 `characters / scene / props`（结构对齐 legacy 分支字段，含 name/description/appearance），**G2 关闭** |
| `paperStudioAnalyzerService.js` | 优先使用 context 中的结构化实体，正则推断只作无绑定时的兜底 |
| `paperBlueprintCompilerService.js` | 实体带库引用时：`identity_version_id/source_library_*/reusable` 写真值；对应 generation slot 增加 `source: 'library'` 与 `identity_version_id` 约束 |
| `paperAssetProductionService.js` | 遇到 `source: 'library'` 槽位 → 调 `paperLibraryReuseService`，**不调图片 API**；用户在镜内点"重新生成"时弹二选一：仅本镜覆盖（脱离库，镜内新版本）/ 更新库版本（走 S3 流程 + 全项目影响预览） |
| `paperGenerationAuthorizationService.js` | 报价分组：`新图片调用 N 次 / 库复用 M 项 0 调用`；授权记录存分组明细供任务中心展示 |
| `paperContinuityService.js` | `subjectSignature`：有 `library_entity_id` 时以其为准，文本归一化仅兜底 |
| `paperStudioDoctorService.js` | 新表 schema 检查加入 doctor |

### 4.3 API（`routes/paperStudio.js` 追加，均带 zod/schema 校验）

```text
POST   /paper-studio/episodes/:id/scripts                     保存剧本版本
GET    /paper-studio/episodes/:id/scripts                     版本列表
POST   /paper-studio/episodes/:id/scripts/:ver/extract        提取候选实体（文本模型）
POST   /paper-studio/projects/:id/library/confirm             批量确认候选（new/merge/ignore）
GET    /paper-studio/projects/:id/library                     实体库（含形象状态、引用计数）
PATCH  /paper-studio/library/entities/:id                     改名/描述/比例锚/归档
POST   /paper-studio/library/identity/quote                   形象生成报价（勾选实体集合）
POST   /paper-studio/library/identity/generate                授权后批量生成
POST   /paper-studio/library/identity/:versionId/review       批准/退回/重抠/上传替换
POST   /paper-studio/episodes/:id/scripts/:ver/generate-storyboards   生成分镜草稿（预览）
POST   /paper-studio/episodes/:id/apply-generated-storyboards         应用（含覆盖策略）
PUT    /paper-studio/storyboards/:id/entity-links             更新分镜实体绑定
```

---

## 5. 素材规格 —— C1~C6 的技术落点

### 5.1 角色（character）

- 登记画布 1024×1536 竖幅透明 PNG；主体居中，占画布高约 80%；
- **全身、自然站立、正面或 3/4 侧、四肢与躯干轮廓清晰不粘连**（有利后续纸片关节拆分）；
- 底部接地线登记进 `registration_json.ground_anchor`（默认 0.88，对齐现编译器 actor 节点 `anchor_y: 0.88`）；
- prompt 注入：style anchor + `transparent_background, single_subject, full_body, clean_silhouette, no_ground_shadow`；
- provider 能力探测沿用 `paperProviderCapabilityService`：支持透明 → 直出；不支持 → 纯色底色出图 + `paperMatteService` 抠图，抠图质量进 `quality_report_json` 供审核页展示。

### 5.2 场景（scene）

- 1920×1080（随分集画幅），**clean plate**：无人物、无可移动道具、无文字；
- prompt 注入 `no_primary_subjects`（与现有 `clean_plate` 槽位约束同源）；
- 构图留白：中下部预留主体活动区（安全区提示写入 `registration_json`），避免生成"塞满前景"的背景导致角色无处站。

### 5.3 道具（prop）

- 1024×1024 透明 PNG，单主体居中，占画布约 70%；
- 记录默认相对高度（相对角色身高的比例，写入 `scale_anchor_json`），供蓝图布局推导。

### 5.4 比例锚如何保证 C5

蓝图节点布局目前用硬编码相对尺寸（如 actor `height: 0.64`）。改造：编译器读取实体 `scale_anchor_json.relative_height`（人=1.0 基准，道具按登记比例），结合镜头 `shot_type`（远/中/近景系数）推导节点 width/height——同一角色在不同场景、相同景别下屏高一致，不同景别下按统一系数缩放。

### 5.5 一致性传导链（C1/C6 完整闭环）

```text
style_anchor(项目级) ──┐
canonical_prompt ──────┼─→ 生成 identity version（一次）─→ 审核批准 ─→ 冻结
                       │
每一镜 blueprint entity(identity_version_id) ─→ slot(source: library)
       ─→ paper_asset_versions(library_reuse, 文件复制, hash 相同)
       ─→ 合成/渲染
切换场景 = clean_environment family 换新场景实体的形象文件，前景层引用不变
```

---

## 6. 用户主流程（UX 细化）

### 6.1 一键路径（快乐路径，约 5 次决策）

1. 进入「剧本与实体」→ 粘贴剧本 → **保存剧本 v1**；
2. 点「提取人物/场景/道具」（提示：使用文本模型，不消耗图片调用）→ 确认面板逐项勾选 → **入库**；
3. 勾选全部实体 → 「生成形象」→ 报价弹窗（如：角色 3 + 场景 2 + 道具 2 = **7 次图片调用**）→ 授权 → 任务中心跑批 → 逐张审核批准；
4. 回剧本卡 → 「生成纸片分镜」→ 预览 N 镜草稿（每镜实体绑定芯片可见）→ **应用**；
5. 走现有链路：勾选分镜 → 创建生产版本 → 蓝图确认时实体区显示"来自实体库 · v1 · 已批准形象"，授权弹窗显示"库复用 7 项 0 调用 / 新调用 X 次（遮挡层、状态帧等）"→ 后续照旧。

### 6.2 关键交互规则

- **提取确认不是全选默认**：候选与已有实体重名/别名命中时默认建议 `merge`，用户可改；未确认的候选不落库；
- **形象未批准的实体可以先绑进分镜**（不阻塞写作），但创建生产版本门禁检查：绑定实体的 current identity version 必须 `approved`，否则给出精确阻断（"角色·阿禾 还没有批准形象 → 去生成"），对齐现有"就绪门禁 + 定位修复"模式；
- **改版影响可预见**（复用 `PaperImpactDialog`）：更新实体形象出新版本时，展示"引用该实体的 K 个分镜、其中 J 个已有生产版本；已发布 run 不受影响，新 run 将使用 v2"；
- **覆盖策略**：分集内已有手写分镜时，「应用生成分镜」提供两种模式——追加到末尾 / 全量替换（替换走影响确认，列出将被归档的分镜数）；
- **每一步费用可见**：S2/S4 标注"文本模型调用"，S3 与生产授权保持现有报价-授权-执行三段式，绝不后台自动调图片 API（BR-001）。

### 6.3 空态与引导

- 「剧本与实体」空态：三步图示（贴剧本 → 建实体 → 出分镜）+「使用示例剧本」（复用 `paperExampleDraftService` 思路，0 调用）；
- 首次清单（`onboardingChecklist`）增加两项：`已建立实体库形象`、`分镜已绑定实体`。

---

## 7. 业务规则增补

| 规则 | 内容 |
|---|---|
| BR-011 剧本版本不可变 | 提取与分镜生成只消费已保存的剧本版本，记录 `script_version_id` 到产物 meta |
| BR-012 实体形象不可变 | identity version 只增不改；current 指针切换必须经影响预览 |
| BR-013 库引用零调用 | `library_reuse` 槽位在报价、授权、执行三处都不得产生图片 API 调用；违反视为 P0 缺陷 |
| BR-014 提取/生成不落地即无痕 | 候选实体与分镜草稿在用户确认前只存于响应/临时态，取消无副作用 |
| BR-015 独立边界 | 实体库与旧工作台仅允许显式"引用导入"（复制文件 + 记 provenance），无运行时 JOIN |

---

## 8. 实施分期

| Phase | 内容 | 交付判定 |
|---|---|---|
| P1 数据与剧本 | migration 41、`paperScriptService`、剧本卡 UI、doctor 检查 | 剧本可保存/查版本；回归全绿 |
| P2 提取与实体库 | 提取服务 + 确认面板 + 实体库 UI（含改名/合并/归档/比例锚编辑） | 真实剧本提取 → 确认入库全流程可用，0 图片调用 |
| P3 形象生产 | `paperIdentityProductionService` + 报价授权 + 审核复用 + 抠图兜底 + 风格锚 | 7 实体一批生成、逐张审核、透明与登记数据合格 |
| P4 分镜生成与绑定 | `paperStoryboardGenerationService` + 预览/应用 + 编辑器绑定芯片 + revision 冻结绑定 | 剧本一键出 N 镜、绑定完整、改绑定触发 revision 更新 |
| P5 生产链路贯通 | sourceService/analyzer/compiler/assetProduction/authorization/continuity 六处改造 + `paperLibraryReuseService` | 验收场景（下）通过 |
| P6 回归与文档 | 全量回归、真实浏览器走查、README/闭环文档更新 | Go/No-Go 审计 |

### 8.1 端到端验收场景（P5 出口门禁）

用一个真实剧本（≥2 个场景、≥2 个角色、≥1 个道具、≥4 镜，其中至少一次"同一角色从场景 A 走到场景 B"）：

1. 剧本 v1 → 提取 → 确认 → 形象生成（一次授权）→ 全部批准；
2. 一键生成 ≥4 镜，自动绑定正确（人对人、景对景）;
3. 创建生产版本：授权报价出现"库复用 0 调用"分组；
4. 生产完成后校验：跨镜同一角色的素材文件 hash 一致（C1）；场景切换镜之间角色屏高一致（C5，ffprobe/像素抽样）；全部素材 provenance 指回同一批 identity version 与 style anchor（C6）；
5. 修改角色形象出 v2 → 影响预览列出全部引用镜 → 新 run 用 v2、旧 run 不变。

---

## 9. 风险与边界

| 风险 | 缓解 |
|---|---|
| 文本模型提取/分镜 JSON 不稳 | 严格 schema 校验 + 自动重试 + 失败降级为"部分结果 + 人工补"；绝不写入半合法数据 |
| 抠图质量差导致"纸片感"毛边 | 质量报告进审核页；审核工作台已有重抠/手动 Mask/上传替换三条出路 |
| 一角色一姿态素材表现力不足（现编译器有 actor 多 state 槽位） | v1 约定：库素材承担 `actor_默认姿态` 槽位；其余状态帧仍按现流程镜内生成（以库素材为参考图，`reference_images` 能力已探测），后续版本再扩"实体多姿态库" |
| 分镜生成质量与镜数失控 | 生成参数暴露"目标镜数/单镜时长"；预览-应用两段式，不满意可整批丢弃（BR-014） |
| 剧本很长超上下文 | 分段提取 + 实体清单跨段带入合并；分镜生成按幕/段分批 |

---

## 10. 本方案不做什么（防止范围蔓延）

- 不做实体多姿态/多服装库（v1 单正式形象 + 镜内状态帧）；
- 不做跨纸片项目共享实体库；
- 不改旧工作台任何行为；
- 不做剧本 AI 扩写（旧工作台已有，纸片侧只管"导入已有剧本"；需要扩写可先在旧工作台完成再粘贴）。

---

## 11. UI 全面重构：可读、可点、可快捷操作

> 目标：解决"界面元素普遍过小、操作路径过长"的问题，使纸片视频从剧本到交付的全流程**看得清、够得着、一键达**。视觉命题（深色安静、媒体优先、暖金主操作）不变，改的是尺度与操作效率。

### 11.1 现状审计（对当前代码实测）

对 `PaperStudio.vue` + `components/paper-studio/*.vue` 全量扫描的结果：

| # | 问题 | 实测证据 | 影响 |
|---|---|---|---|
| A1 | **字号系统性过小** | 全部字号落在 7–12px：8px×29 处、9px×25 处、10px×17 处、7px×10 处；正文/说明文大量使用 8–9px | 低于可读下限（正文应 ≥13px），高分屏上如"蚂蚁字"，读状态和报错要凑近屏幕 |
| A2 | **点按目标过小** | 大量 8–10px 文本按钮（`font-size: 8px; cursor: pointer` ×10 处等）；`run-item` padding 仅 9px | 误点率高，操作有"怕点错"的心理负担 |
| A3 | **三栏固定窄宽** | `grid-template-columns: 252px 1fr 272px`；右栏承载了主操作（创建生产版本、授权、交付入口）却只有 272px | 主操作被挤在最窄的栏里；中央媒体区反而常年留黑 |
| A4 | **关键操作靠手输数字 ID** | 5 处 `ElMessageBox.prompt`：新建纸片分集、从旧工作台导入（输入旧分集 ID）、同步到旧工作台（输入目标 ID）、退回素材、退回预览 | 用户要先记住 ID 再打字，属于最慢的一类交互 |
| A5 | **无键盘快捷键** | 全项目仅 2 个抽屉支持 Esc 关闭 | 逐张审素材、逐镜切换全靠鼠标点小目标 |
| A6 | **主操作不常驻** | 保存/创建生产版本/批准分散在右栏与卡片内部，滚动后不可见 | "下一步该点哪"需要找 |

### 11.2 设计令牌（Design Tokens）—— 一次性根治 A1/A2

新建 `frontweb/src/styles/paper-tokens.css`，Paper Studio 全组件**禁止裸写字号**，统一走 CSS 变量：

```css
:root {
  /* 字阶：现有 7–12px 按语义映射到新字阶，全局最小 11px */
  --paper-fs-xs: 11px;      /* 仅限大写字距标签、徽标（如 SHOT 01 / READY） */
  --paper-fs-sm: 12px;      /* 辅助说明、时间戳、次级状态 */
  --paper-fs-base: 14px;    /* 正文、表单、按钮、列表项 —— 默认值 */
  --paper-fs-lg: 16px;      /* 卡片标题、分镜标题 */
  --paper-fs-xl: 20px;      /* 工作区标题 */
  --paper-fs-display: 24px; /* 页面主标题 */

  /* 控件与点按目标 */
  --paper-control-h: 36px;        /* 输入框 / 次按钮 */
  --paper-control-h-primary: 42px;/* 主操作按钮 */
  --paper-hit-min: 32px;          /* 任何可点元素最小高度 */

  /* 间距阶梯 4 / 8 / 12 / 16 / 24 / 32，替代现在随手写的 1–10px */
}
```

迁移映射（机械可执行，便于全量替换）：`7–8px → xs`、`9–10px → sm`、`11–12px → base`；替换后按语义把标题类升到 `lg/xl`。CI 加一条守门脚本：paper-studio 目录内出现 `font-size:` 后跟 `<11px` 的字面量即失败。

### 11.3 布局重构 —— 根治 A3/A6

```text
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：项目名 · 环境状态 · 任务/调用中心                        │
│ 流程步骤条：① 剧本 → ② 实体 → ③ 分镜 → ④ 生产 → ⑤ 交付       │  ← 新增
├──────────┬───────────────────────────────┬───────────────────┤
│ 左栏 280px│        中央媒体/编辑区          │   右栏 320px       │
│ 可折叠 64px│   （始终 ≥ 60% 视宽）          │  上下文属性/检查    │
├──────────┴───────────────────────────────┴───────────────────┤
│ 粘性操作条：保存状态 ·「当前唯一主操作」大按钮 · 费用提示       │  ← 新增
└──────────────────────────────────────────────────────────────┘
```

- **流程步骤条**（新组件 `PaperStageNav.vue`）：五段与本方案 S1–S4 + 现有生产/交付阶段对齐；每段显示就绪状态（✓ / 数字角标 / 阻断红点），可点击直达。它取代"入口散落在左栏、右栏、抽屉"的现状，回答"我在哪、下一步去哪"（在 S1–S4 落地前先按现有四段：分镜 → 生产 → 交付 + 任务）；
- **粘性操作条**（新组件 `PaperActionBar.vue`）：始终展示当前阶段的**唯一主操作**（保存并下一镜 / 创建生产版本 / 批准素材 / 合并整集……）与自动保存状态。右栏里的"创建生产版本"等主按钮迁移至此，右栏回归纯上下文信息；
- 左栏可折叠为 64px 图标栏（分集/分镜数字角标保留），把宽度让给媒体区；
- 断点策略保留（<1180 右栏浮层化），但浮层宽度升至 360px 且带遮罩点击关闭。

### 11.4 交互提速 —— 根治 A4/A5

| 改造 | 内容 | 替代的现状 |
|---|---|---|
| **选择器取代手输 ID** | 5 处 `ElMessageBox.prompt` 全部改为卡片单选列表（带搜索、显示集号/标题/分镜数，回车确认）；"新建纸片分集"改为内联表单 | 记 ID + 打字 |
| **全局快捷键**（新 composable `usePaperHotkeys`） | `↑/↓ 或 J/K` 切分镜 · `Ctrl+S` 保存 · `Ctrl+Enter` 保存并下一镜 · `A` 批准当前素材 · `R` 退回 · `Space` 播放/暂停预览 · `Esc` 关层 · `?` 快捷键速查面板 | 全鼠标点小目标 |
| **素材审核队列模式** | 审核工作台加"队列审核"：待审 N 张按顺序全屏大图逐张过，`A/R` 键连续判定后自动跳下一张，顶部进度 `7/24`；退回时才展开原因输入 | 逐张点开小卡片再找按钮 |
| **分镜批量工具条** | 分镜栏多选（已有 checkbox）后浮出工具条：全选 / 反选 / 全部勾入生产 / 列出未就绪项并逐个直达修复 | 逐个勾选、逐个排查 |
| **保存降级为状态** | 自动保存已存在（draft + dirty 状态），"保存分镜"从主按钮降级为操作条上的状态指示（已保存 ✓ / 保存中 / 失败重试）；主按钮位置让给"下一步" | 每镜手动点保存 |
| **阻断即导航** | 交付看板 `fixDeliveryBlocker` 的"点击直达出错字段并聚焦"模式推广到：创作门禁（缺画面描述/主体动作）、实体门禁（形象未批准）、授权门禁 | 看到报错自己找地方 |

### 11.5 组件与规范收口

- 抽出基础组件：`PaperButton`（primary/secondary/danger 三态，内置 42/36px 高度与 loading）、`PaperSelectCard`（上面的卡片单选器）、`PaperDialog`（统一替代 ElMessageBox 风格漂移）；
- 状态徽标统一最小 `--paper-fs-xs` + 大写字距，颜色仅用现有语义色（金=主操作、绿=就绪、红=阻断、灰=等待）；
- 媒体优先约束写进组件规范：任何新面板不得把媒体区压到 60% 视宽以下。

### 11.6 可访问性与验收门禁

- 正文对比度 ≥ 4.5:1，焦点环可见，快捷键全部有可视等价操作；
- 键盘可完整走通"四镜从创作到交付"（配合 `?` 速查面板验收）；
- 字号守门：扫描脚本确认 paper-studio 目录 0 处 <11px 字号；
- 效率验收：以现版为基线录制同一真实四镜流程，重构后**鼠标点击次数下降 ≥ 40%**、无一次手输 ID；
- 1440×900 与 1920×1080 双分辨率真实浏览器截图走查（延续闭环文档第 16/17 节验收方式）。

### 11.7 实施分期（U 系列，可与 P 系列并行）

| Phase | 内容 | 依赖 | 交付判定 |
|---|---|---|---|
| U1 | 设计令牌 + 全量字号/间距/点按目标迁移 + 三栏布局调整 + 左栏折叠（纯样式，不动业务逻辑） | 无，可立即开始 | 双分辨率截图走查；0 处 <11px；回归全绿 |
| U2 | 流程步骤条 + 粘性操作条 + 5 处 prompt 改选择器 + 主操作迁移 | U1 | 手输 ID 清零；主操作常驻可见 |
| U3 | 全局快捷键 + 审核队列模式 + 批量工具条 + 阻断即导航推广 | U2 | 点击数 ≥40% 下降达标；键盘走通四镜交付 |
| U4 | S1–S4（剧本/实体/分镜）新界面按本规范实现，步骤条补全为五段 | U2 + P2–P4 | 第 8.1 端到端验收场景在新 UI 上通过 |

> 推荐排期：**U1 先行**（收益最大、风险最低、纯样式），随后 U2 与 P1–P2 并行，U3 收尾，U4 与功能 P4–P5 合流。这样"字太小"的问题第一周就消失，而新功能上线时直接生在新规范里，不产生二次返工。
