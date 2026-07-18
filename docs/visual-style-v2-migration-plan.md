# 统一视觉上下文 V2 改造方案

> 适用项目：LocalMiniDrama
> 目标剧本：`历史战争`（`drama_id=4`）
> 目标集数：第 2 集（`episode_id=7`）
> 文档版本：2026-07-18

## 1. 改造结论

当前“场景图和分镜图风格不一致”不是单个提示词写错，而是生成链路存在多套互相覆盖的风格来源：项目 metadata、旧版 `polished_prompt`、提示词模块、图片生成服务内部二次润色、Codex 队列快照和参考图都可能各自带一套画风。历史战争第二集的真实数据已经证明同一项目同时出现水墨、国潮厚涂和 CGI 词。

V2 的核心原则是：

1. 一个项目同一时间只有一个“激活视觉版本”。
2. 所有图片请求先经过同一个编译器，再调用 Codex 或普通图片模型。
3. 生成时冻结完整上下文，之后不再回读旧的 `polished_prompt` 覆盖生成内容。
4. 参考图也必须有视觉版本 provenance；旧图默认不进入新分镜参考包。
5. 旧 prompt、旧图片和旧候选图只归档/标记过期，不自动覆盖、不自动应用。

## 2. 真实问题证据

历史战争第二集当前范围为 13 个场景、34 个分镜（165–198）。迁移前的数据库状态包含：

- 项目 metadata 版本为 v4，主风格声明为 `ink wash`。
- 场景 `polished_prompt` 同时带有“国潮史诗厚涂”“traditional Chinese ink wash”“塑料 CGI”等互斥媒介。
- Codex 任务存在多个风格签名（包括 `87f8ade01ab1d6c1`、`07b8ba4e44821085`、`716e13115d60392f`）。
- 旧 Codex source snapshot 的全局风格是水墨，但 visual bible 是国潮史诗厚涂。
- 旧任务和旧图片没有稳定的 prompt hash、风格版本号和参考包 hash，无法证明某张图使用了哪套上下文。

因此，单纯把 `ink wash` 替换成 `impasto`，或者只修改分镜 prompt，都不能解决问题；旧参考图仍可能把旧媒介带入模型。

## 3. 目标架构

```mermaid
flowchart LR
  A[剧本/角色/道具/场景/分镜结构化字段] --> B[活动视觉版本]
  B --> C[Prompt Compiler V2]
  A --> C
  C --> D[参考包构建器]
  C --> E[负面词与输出合同]
  D --> F[Generation Context Snapshot]
  E --> F
  F --> G{生成通道}
  G --> H[Codex jobs.json]
  G --> I[普通图片 API]
  H --> J[候选图导入]
  I --> K[image_generations]
  J --> L[用户确认后写正式资产]
  K --> L
```

### 3.1 风格版本生命周期

`draft → active → archived`。

- 保存草稿不会改变现有生成任务。
- 显式激活才改变新任务的默认风格。
- 激活时归档旧版本、更新 `dramas.active_visual_style_version_id` 和签名、标记实体 prompt 过期、取消旧的 pending/generating/completed Codex 任务。
- 旧候选图仍保留，但只有显式 `allow_stale` 才能应用。

### 3.2 Prompt 编译顺序

编译器固定按照以下顺序输出，避免内容字段反向改写艺术方向：

1. 输出合同（单帧、四视图、九宫格或尾帧）。
2. 项目级中英文艺术方向。
3. 视觉圣经（色板、光线、材质、构图、时代锚点、负面词）。
4. 实体 scope overlay（角色/场景/道具/分镜）。
5. 兼容的 prompt style modules；媒介冲突模块跳过并记录诊断。
6. 场景连续性和前后镜头连续性。
7. 结构化动作、镜头、对白、道具和角色内容。
8. 质量、画幅、风格锁和负面词。

旧的混合 prompt 只作为事实内容候选。检测到旧签名或 stale state 时，编译器会优先使用结构化字段，并移除已识别的旧水墨/厚涂/CG 模板词；不会把旧画风当成当前艺术方向。

## 4. 数据层改造

迁移文件：`backend-node/migrations/29_visual_style_context.sql`，启动兜底：`backend-node/src/db/migrate.js`。

| 表/字段 | 用途 |
|---|---|
| `drama_visual_style_versions` | 保存完整风格版本、模块快照、媒介、签名和激活时间 |
| `generation_context_snapshots` | 不可变保存最终 prompt、负面词、参考包、hash、诊断和来源快照 |
| `dramas.active_visual_style_version_id` | 指向当前激活版本 |
| `dramas.active_visual_style_signature` | 快速校验缓存和任务是否属于当前版本 |
| `scenes/storyboards/characters/props.prompt_state` | `current`、`stale_style`、`stale_scene`、`compiled_v2`、`manual_override` 等状态 |
| `codex_image_jobs.style_version_id` | Codex 任务所属风格版本 |
| `codex_image_jobs.context_snapshot_id` | 任务冻结上下文 |
| `codex_image_jobs.prompt_hash/reference_pack/compiler_version` | 可复现性和审计 |
| `image_generations.style_version_id/context_snapshot_id/prompt_hash/reference_pack` | 普通图片生成 provenance |
| `image_generations.prop_id` | 道具普通图生成记录与道具实体关联 |
| `prompt_styles.role/medium/compatibility_tags/priority` | 风格模块兼容性分类 |

## 5. 参考图策略

分镜参考包顺序固定为：

`尾帧首帧构图锁 → 场景主图 → 场景九宫格 → 显式角色 → 显式道具 → 手动参考图`。

每张参考图会去重、排序、按供应商上限截断并写入 hash。V2 项目中，主图/角色/道具/场景网格若没有当前激活版本 provenance，默认跳过并记录 `STALE_REFERENCE`；这样旧水墨图不会悄悄成为新厚涂分镜的视觉模板。

如果确实要临时利用旧图的空间或身份信息，可在明确评估后传 `allow_stale_references=true`。这只改变参考包，不会改变当前风格版本，也不会自动把旧图写成正式图。

## 6. 代码改造清单

### 后端核心

- `visualStyleVersionService.js`：版本创建、激活、归档、影响范围和旧任务失效。
- `generationContextService.js`：快照、hash、快照列表和 `compiled_v2` 状态。
- `promptCompiler.js`：统一编译、旧 prompt 清理、媒介冲突诊断、四视图/九宫格/尾帧合同。
- `referencePackService.js`：版本化参考图、去重、供应商限制、旧图过滤。
- `codexImageJobService.js`：任务冻结上下文、manifest 字段、旧候选图保护和 `allow_stale` 应用门禁。
- `imageClient.js` / `imageService.js`：普通图片、角色、场景、道具、分镜和特殊网格流程共享快照。
- `propImageGenerationService.js`：道具生成写入 `image_generations` provenance，不再只走裸 `callImageApi()`。
- `sceneService.js` / `characterLibraryService.js`：四视图和单图流程不再绕过 V2 编译器。

### API 与前端

- 视觉风格 API：读取、保存草稿、激活版本、查看影响范围。
- 分镜 prompt preview：展示最终 prompt、负面词、参考包、诊断、hash 和版本。
- `StyleStatusBadge`：显示当前、已按 V2 编译、风格过期、手动覆盖等状态。
- Codex 任务卡：显示版本、上下文快照和 prompt hash，避免用户误用旧候选图。

## 7. 历史战争第二集实际迁移结果

已在真实数据库执行保护性迁移并生成数据库备份：

- 当前激活版本：v5「上古青铜史诗·电影厚涂」。
- 媒介：`impasto`。
- 色板：暗金、青铜、蓝灰、朱砂、土色和灰烬。
- 光线：冷月光/蓝灰环境光与暖火光/炉火对照。
- 材质：粗麻、氧化青铜、夯土、木构、皮革、厚涂笔触。
- 明确禁止：纯水墨、宣纸/Sumi-e、塑料 CGI、霓虹、时代错置、文字水印。
- 批量生成前 `jobs.json` 有 31 条待生成任务；现已逐条生成并一次性导入，当前 `jobs.json` 已清空。
- `results.json` 现有 73 条结果（保留原有 42 条历史结果，新增 31 条 V5 候选），每条新任务保留 1 张候选图。
- 31 条新任务已标记为 `completed`，候选图仍未自动应用；用户仍需在页面执行“候选图 → 使用”确认流程。
- 3 条已有正式分镜图按“已有图不重复生成”规则跳过。
- 31 条新分镜任务均有 `style_version_id=3`、上下文快照和 prompt hash，正向媒介检查为 0 个水墨标记、0 个 CGI 标记。
- 旧任务被取消并保留历史；没有自动应用任何候选图。
- 审计发现 101 次旧参考图被跳过，原因是没有当前版本 provenance；这属于保护性行为，不是生成失败。

## 8. 推荐执行顺序

### 阶段 A：生成当前活动队列（本次已完成）

遵守 `docs/codex-image-workflow.md`：只生成 `jobs.json` 中尚未完成、没有正式图的任务；每个任务只生成一个候选图；结果合并进 `results.json` 后一次性导入；不调用 `useCandidate`。

本次执行结果：31 条候选图已经生成并导入，队列为空；3 条已有正式分镜图未重复生成。

### 阶段 B：人工挑选关键基础资产

优先处理场景主图、角色主图和关键道具。用户在页面点击“使用”后，系统会把候选图复制到正式目录，并写入当前版本 provenance。

### 阶段 C：重新入队获得连续性参考

基础资产使用完成后，再对需要强连续性的分镜执行“重新编译/重新入队”。此时参考包会重新包含当前版本的场景、角色和道具图，分镜会同时获得风格一致性和空间/身份连续性。

### 阶段 D：视频生成

确认分镜主图、首帧、尾帧后再生成视频。尾帧继续使用首帧构图锁；视频上下文只引用当前版本资产。

## 9. 迁移与回滚命令

迁移前先做 dry-run：

```bash
cd backend-node
node scripts/migrate-visual-style-v2.js --drama 4 --episode 7
```

执行默认跳过已有正式分镜图：

```bash
node scripts/migrate-visual-style-v2.js --drama 4 --episode 7 --apply
```

只有明确要重做已有正式分镜图时才使用：

```bash
node scripts/migrate-visual-style-v2.js --drama 4 --episode 7 --apply --requeue-existing
```

隔离审计：

```bash
node scripts/audit-visual-style-consistency.js \
  --db /path/to/test/drama_generator.db \
  --drama 4 --episode 7 --json
```

脚本会在数据库同目录的 `backups/` 下保存迁移前数据库。若需要回滚，先停止后端，再用对应备份恢复数据库及其 `-wal/-shm` 文件，并从迁移前的 `jobs.json` 备份恢复队列；不要只恢复数据库而继续使用新 manifest。

## 10. 验收标准

### 自动验收

- 后端测试全部通过。
- 前端测试全部通过，Vite build 通过。
- 活动 Codex 任务全部有上下文快照、prompt hash、当前 style version。
- 活动任务的正向媒介 token 不包含 `ink_wash`、`cgi` 或其他冲突媒介。
- 旧 prompt 仍保留，但编译器不会在签名过期时直接信任它。
- 旧候选图不能在没有 `allow_stale` 的情况下应用。
- 场景九宫格候选图不会覆盖场景主图。

### 人工验收

- 场景、角色、道具、分镜的色板和光线方向一致。
- 同一场景不同镜头的建筑结构、材质和时间氛围连续。
- 同一角色在不同镜头的脸型、服装、配饰和比例稳定。
- 首帧/尾帧左右站位保持一致。
- 画面没有拼图、分屏、字幕、随机文字和水印。

## 11. 风险与处理

| 风险 | 处理 |
|---|---|
| 旧正式场景图风格不一致 | 不自动覆盖；先生成候选、人工确认，再重新入队分镜 |
| 旧候选图误应用 | `useCandidate` 做版本门禁；旧任务必须显式 `allow_stale` |
| 供应商参考图数量不足 | 参考包按优先级截断，首帧锁和场景连续性优先 |
| 手动 prompt 被误判为旧风格 | `manual_override` 保留内容，但始终包在当前 STYLE LOCK 下 |
| 临时数据库污染真实队列 | 迁移脚本会把 `--db` 同步到 config，manifest 写入临时数据库旁边 |
| 结果文件包含旧任务 | 保留历史结果；导入时只接受当前数据库存在的 job，审计记录未知 job 错误 |
