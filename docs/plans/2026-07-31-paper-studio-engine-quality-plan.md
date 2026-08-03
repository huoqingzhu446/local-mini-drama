# 纸片工作室引擎质量优化方案（性能 / 步骤原子化 / 一致性 / 前端 / 数据 / Matte）

> **⚠️ 已合并**：本方案已与题材去耦方案合并为《2026-07-31-paper-studio-unified-plan.md》，并吸收代码评审修正（E3/B1/C3/D1/D2/D4/A2 等 9 处）。执行以统一方案为准，本文档保留作历史参考。

> 日期：2026-07-31
> 范围：paper-studio 后端服务、render worker、paper-studio-renderer、frontweb 工作台
> 原则：所有改动保持"compile-once + hash 链 + 门禁"架构不变；性能优化不得破坏渲染确定性；一致性修复以"单一事实源"为目标

## 1. 背景

纸片工作室 v9 已跑通全链路并验收，但存在六类工程问题：渲染 worker 性能浪费、四个 job step 是"纸面步骤"无法细分执行、门禁/报价/预算三处一致性缝隙、前端假成功与重复维护、资产 hash 与路径语义不一致、matte 对深色背景退化。本方案逐项给出修复设计与优先级，全部改动不涉及题材（与题材去耦方案互不依赖，可并行）。

## 2. 问题清单与方案

### 模块 A：渲染性能

#### A1 proof 模式每个 target 单独启动 Chrome（已验证 `scripts/render-paper-studio.mjs:195-212`）

**现状**：proof 模式每个 target 开一个 Chrome 实例，渲染 full/repeat/debug 三张 still 后关闭（L196-211）。20 个 target 即有 20 次浏览器启动（每次 2-5 秒）+ 20 次 `renderStill` 调用。代码注释（L173-177）说明原因：共享浏览器会让解码后的 state-atlas 图片在内存堆积，最终 Target closed 崩溃。

**方案（保守，推荐）**：批内复用 + 定期重启
- 复用同一 Chrome 实例渲染连续 N 个 target（默认 N=5，可配置 `paper_studio.proof_browser_targets_per_session`），每 N 个或每 60 秒重启一次；
- 崩溃兜底：`renderStill` 抛 Target closed 类错误时，当前 target 用新浏览器重试一次（局部重试，不整批失败）；
- 保留确定性校验不变（full/repeat 仍同一浏览器内连续渲染，重复性断言语义不变）。
- 预期收益：20 target 从 20 次启动降为 4 次，proof 时长缩短 30-50%（启动开销为主）。

**激进选项（后续验证）**：全局复用 + `renderStill` 前主动清理（Remotion 有内存释放接口）；先用保守方案跑通再评估。

#### A2 每次渲染都重新 `bundle()`（已验证 L146-154）

**现状**：`bundle({ entryPoint, publicDir, enableCaching: true })` 每次 proof/preview/formal 都执行。Remotion 的 enableCaching 只缓存 webpack 内部产物，serveUrl 每次生成，bundle 阶段每次仍要扫描/打包（数秒到数十秒）。

**方案**：bundle 结果按内容 key 复用
- key = `sha256(renderer 源码目录内容摘要 + publicDir 内容摘要)`（素材变化会自然失效）；
- bundle 输出目录固定为 `backend-node/data/paper-studio-render-bundle/{key}/`，key 命中且目录存在时跳过 bundle 直接复用 serveUrl；
- 服务端进程内缓存最近 1 个 key（内存持有 serveUrl），跨进程用目录判断；
- 注意 publicDir 是素材根目录，内容变化频繁——摘要可用 `find publicDir -newer marker -type f | sort | xargs sha256sum` 或退化为"renderer 源码版本号 + publicDir 最后修改时间"（分钟级粒度，够用）。
- 预期收益：连续渲染（proof→preview→formal 同一 snapshot）时后两次省掉 bundle。

#### A3 `renderMedia` 固定 `concurrency: 1`（已验证 L251）+ `enforceAudioTrack: true`（L248）

**现状**：1080p 正式渲染单并发偏慢；无音频源时 `enforceAudioTrack: true` 也会强制编码 AAC 音轨。

**方案**：
- concurrency 改为可配置：`paper_studio.render_concurrency`，默认 `min(max(1, floor(os.cpus().length / 2)), 4)`（每 worker 约 0.5-1GB 内存，4 并发约需 4GB，桌面端需评估）；preview 可固定 2；
- `enforceAudioTrack` 改为 `snapshot.audio_sources?.length > 0`，无音频时不强制音轨（省编码时间，ffprobe 断言同步放宽）；
- 保持不变：crf（preview 28 / formal 20）、x264Preset（veryfast / medium）。

### 模块 B：纸面步骤原子化

#### B1 四个 step 无 ACTIONS 映射（已验证 `paperOrchestratorService.js:17-66`，仅 `generate_layout_master` 有 action；`paperAssetProductionService.js:976,997` 批量改状态）

**现状**：`generate_required_slots / matte_assets / register_assets / asset_gate` 四个 step 永远不被调度，由 `generateAssets` 成功/失败时被批量标记。后果：无法"只重跑 matte"、"只补生成单个 slot"、"只重跑技术门禁"；任何素材失败都是整镜 `generate_layout_master` 重跑（受尝试/预算限制）。

**方案**：把 `generateAssets` 拆成可组合的原子操作，再配 4 个 ACTIONS
- 原子操作（同一文件内新增纯函数，保持现有行为不变）：
  - `generateMissingSlots(db, cfg, log, shotId, { slotIds?, requestId, expectedVersion, authorizationId })`：只处理 `status != ready` 的 slot（支持 slotIds 白名单）；
  - `mattePendingVersions(db, cfg, log, shotId, { versionIds? })`：只对 `quality_report_json` 缺 matte 结果的 accepted/candidate 版本跑 `alphaReport + defringe`；
  - `registerVersions(db, cfg, log, shotId, { versionIds? })`：重算 `contact_anchor` 与 registration_json；
  - `runAssetGate(db, cfg, log, shotId)`：重跑 alpha 技术门禁 + family 状态汇总（不改人工审核语义）；
- 4 个 ACTIONS 各映射一个原子操作（queue: local，state 转换沿用现有 failureState 表）；
- `generate_layout_master` 保留为聚合动作：内部顺序调用 4 个原子操作（保证"全量生产"一键路径不变）；
- 依赖关系不变（matte 依赖 required_slots 完成、asset_gate 依赖 register 完成），前端 step 条不再只是摆设；
- 额外收益：失败恢复路径可精确到 slot——`review_error → retry_step` 时只重跑失败 slot 的 matte/生成，不整镜重来（配合预算，见 C3）。

**不做**：不引入按 slot 的独立授权（现有 authorization 已是 slot 粒度，天然支持）。

### 模块 C：一致性缝隙

#### C1 门禁评估原始 plan，snapshot 存自然化后 plan（`paperMotionGateService.js:98-110` sync → evaluate → `paperSnapshotService.js:177` naturalize）

**现状**：`planMotion` 先对 `plan_json` 跑五层门禁，通过后 `snapshotService.compile` 内部才做自然化。naturalize 会注入 arc 拱形（幅值 0.012）、anticipation 回坐、ease-out-back 过冲等——这些后处理**可能**把原本合格的指标推越界（如 arc 幅值恰好等于 ground_lock 容差 0.012），但门禁报告与快照内容不一致，只能靠 proof 阶段兜底。

**方案（改顺序，不改算法）**：
- `planMotion` 改为：`sync 音频时序 → 原始 compile → naturalize（纯函数，现成）→ 用自然化后的 plan 跑五层门禁 → 通过后直接冻结 snapshot（compile 不再重复 naturalize）`；
- 门禁报告、快照、渲染三方消费同一份 plan，消除"自然化可能越界"的盲区——这是行为改进：原本会漏过 proof 的越界现在提前在 gate 拦截；
- 回归影响：naturalize 后指标如果超限，部分此前通过的镜头会变成 gate 失败（正确行为），需跑全量测试确认巨鹿 fixture 仍通过；如个别阈值过紧（如 arc 0.012 vs ground_tolerance 0.012），把 gate 的数值断言改为"naturalize 后重新计算"，必要时微调 arc 幅值（0.012 → 0.010）。

#### C2 报价 max_attempts 与 job step max_attempts 脱节（`paperGenerationAuthorizationService.js:184` 报价按 slot 计算；`paperStudioAnalyzerService.js:419` step 固定插 2）

**现状**：报价承诺 `max_auto_retries_per_slot + 1` 次调用，但执行侧 step 的 `max_attempts` 是 analyzer 写死的 2，二者可能不一致（draft tier 报价 2 次、执行允许 2 次；full-depth 报价 3 次、执行仍 2 次——白付了报价却用不上）。

**方案**：单一事实源
- `authorizeAndStartGeneration` 成功时，按 authorization 的 slot 维度计算该 shot 相关 step 的 `max_attempts = max_auto_retries_per_slot + 1` 并 UPDATE `paper_job_steps`（analyzer 插入时保留默认值，授权时覆盖）；
- 报价函数与授权函数共用同一常量计算（`budget_json.max_auto_retries_per_slot`），消灭两处不一致；
- 展示层：报价文案明确"最多 N 次调用（含自动重试）"。

#### C3 预算统计不含 failed 调用（已验证 `paperAssetProductionService.js:614-625`）

**现状**：`usedImages` 只统计 `status IN ('processing','completed')`，failed 不计入——但 failed 调用（4xx/5xx、超时）通常已真实消耗 provider 配额。用户可能在超预算后仍继续扣费。

**方案**：
- 统计口径改为 `('processing','completed','failed')`，预算 = 已消耗配额（保守：宁可多算不可超支）；
- 报价弹窗文案加注"含失败调用与自动重试"；
- 429/限流归一化的 `PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED` 保持不计重试（该错误本身不进入 version 生成，不落 image_generations 的 failed 行，无重复计数风险——需在实现时验证此路径）。

### 模块 D：前端缺陷

#### D1 无操作 action 弹"当前生产步骤已完成"假成功（已验证 `paperStudioStore.js:1230-1231` else return null；`PaperStudio.vue` runCurrentAction 对 null 弹 success）

**现状**：`recover_run / review_preview / wait_for_analysis / wait_for_assets / wait_for_motion / wait_for_proof` 等 action 在 store 无分支返回 null，view 端按钮仍可点（`runnableStates` 含 failed/analyzing/preview_ready），点击后弹成功提示但什么都没发生。

**方案（两处都改）**：
- store：`runNextAction` 对无分支 action 返回 `{ noop: true, action }` 而不是 null；
- view：`runCurrentAction` 收到 `noop` 时**不弹任何提示**，并即时刷新 run 状态；同时 `canRunCurrentAction` 黑名单补充 `recover_run / review_preview / wait_for_*`，按钮置灰并显示 tooltip"后台处理中/等待人工操作"；
- 断言测试：`frontweb/test` 增加"点击 noop action 不产生成功 toast"的 store 单测。

#### D2 run/shot 状态文案三处重复维护（`PaperStudio.vue` runStatusLabel、`PaperShotRail.vue:77-85`、`PaperDeliveryBoard.vue:186-194` + mergeStatusLabel 两份）

**方案**：新建 `frontweb/src/utils/paperStudioLabels.js`，导出 `runStatusLabel / shotStatusLabel / mergeStatusLabel / nextActionDescription` 单一来源，三处组件改为引用；后端 label 仍以 `next_action` + 事件为准，前端不做第二份状态机。

#### D3 死 API（`frontweb/src/api/paperStudio.js`：updatePaperEpisode/deletePaperEpisode/listActions/recoverRun/listContinuity/listRevisions 前端零调用）

**方案**：清点后分类处置——
- `listActions`：**保留并在题材去耦方案 P0 中启用**（前端主动作下拉动态化）；
- `recoverRun`：`PaperStudio.vue` 无对应 UI，若后端有 recover 语义则补入口，否则删除；
- 其余（updatePaperEpisode/deletePaperEpisode/listContinuity/listRevisions）：删除或在文件头注释"预留，未接线"；删除时同步清理 store 暴露的同名空方法。

#### D4 轮询 2.5s 恒定 × 3-4 请求（`PaperStudio.vue` onMounted setInterval 2500ms → refreshActiveRun = getRun + getShot + loadRuns）

**方案**：
- 按 next_action 分档：后台执行中（analyzing/motion/proof/render/publish）保持 2.5s；人工阻塞点（plan_review/asset_review/preview_ready）降频到 8s；无活跃 run 时停止轮询（任务中心抽屉打开时单独轮询）；
- `refreshActiveRun` 只在前端"当前激活 shot"变化时才拉 getShot（现有签名对比 `[id, status, published_video_generation_id]` 基础上增加 `version` 字段，素材/动作/预览变化能触发重载）；
- 估算：后台阶段请求密度不变，人工阶段下降约 70%。

### 模块 E：数据一致性

#### E1 `source_hash` 与 `source_local_path` 指向不同文件（`paperAssetProductionService.js:772-780`：sourceHash=原始下载图 hash，source_local_path=alpha 处理后的文件）

**现状**：同一行里 hash 与路径描述的不是同一个文件，任何依赖"路径↔hash 校验"的复用/比对逻辑存在歧义（当前因优先使用 `alpha_local_path + alpha_hash` 被掩盖）。

**方案**：
- image_api 路径：落库 `raw_local_path + raw_hash`（原始下载图，migration 加列）+ 保持 `source_local_path/source_hash` 指向**处理后的最终文件**；历史行 raw_hash 为空时回退用 source_hash（旧语义）；
- 复用/比对逻辑统一：优先 `alpha_hash`（已有），其次 `source_hash`（处理后），`raw_hash` 仅用于"重新处理"场景（rematte 不再对已抠图再抠）；
- 新增断言测试：任何版本行满足 `hash(路径指向的文件) === 对应 hash 字段`（遍历 `paper_asset_versions`）。

#### E2 alpha 门禁阈值两套（生产 `transparent>=0.05` vs 用户上传 `>=0.01`，`paperAssetProductionService.js:226` / `paperAssetWorkspaceService.js:118`）

**现状**：同一素材"API 生成不合格、手动上传合格"，规则自相矛盾。

**方案**：抽 `paperMatteThresholds.alphaGate(kind)` 单一常量表（transparent_ratio、visible_ratio 上下限、residual_key_edge_ratio），生产与上传共用；两处调用点改引用。行为变更：上传路径从 ≥0.01 收紧到 ≥0.05（与生产一致）——上传前 UI 提示透明占比要求，避免上传后才发现不合格。

#### E3 fingerprint 无唯一索引，重复请求可能重复扣费（`paper_asset_versions`/`image_generations` 仅存 request_fingerprint，无 UNIQUE）

**现状**：前端重试/并发双击可能产生重复 image_generation 与 version，各消耗一次 provider 配额。

**方案**：
- migration 加部分唯一索引：`CREATE UNIQUE INDEX ... ON image_generations (request_fingerprint) WHERE generation_kind = 'paper_studio_asset' AND request_fingerprint IS NOT NULL AND deleted_at IS NULL`；
- `generateViaApi` 调用前先按 fingerprint 查询：已存在 completed 则直接复用该 version（幂等返回），processing 则等待/复用，failed 才重新发起；
- 存量重复数据：迁移脚本按 fingerprint 去重标记（保留最新，其余 deleted_at 置位）或仅对新数据生效（推荐先只对新数据生效，存量清理另开）。

### 模块 F：Matte 短板

#### F1 深色背景退化（已验证 `paperMatteService.js:39-64`：estimateBorderKeyColor L56 过滤 luminance<128，L62 无样本时返回白色）

**现状**：white_v1 模式对深色背景素材，边缘采样全部被亮度过滤丢弃，兜底返回 [255,255,255]，导致深色背景抠图失败或产生严重色溢。注意 L53-56 注释表明过滤是为"防止主体贴边污染 key"——深色模式需要对称处理。

**方案**：
- 新增 `dark_v1` 键色模式：过滤 `luminance > 128` 的像素取中位数（与 white_v1 对称）；
- 新增自动模式 `auto`：双边采样，分别算白侧/黑侧中位数的色度方差，取方差小（更纯净）的一侧；`alphaReport` 按素材边缘亮度分布自动选择模式；
- 键色置信度检查：若边缘采样量 < 阈值（如 500 像素）或键色与边缘主体色距离 < 24，判定本地 matte 不可信 → 不自动失败，而是标记"建议提供透明底/换图"，走人工审核路径；
- 对现有白底素材零影响（默认仍 white_v1）。

#### F2 无 onnx/rembg 模型兜底（现状：只有 provider_alpha / 色度键两条路径）

**现状**：抠图质量上限受限于"provider 给透明通道 or 纯色背景"，复杂背景（纹理、渐变）素材无法生产。

**方案（分期）**：
- **P1（本方案）**：不引入模型。交付 F1 深色模式 + 键色置信度 + defringe 增强（边缘收缩 1px + 羽化，解决亮边；形态学 erode 作为可选参数）。
- **P2（长期，单独立项）**：rembg/BiRefNet 作为独立 adapter。v3 文档风险表已提示 Node 18/Electron 与 ONNX native 兼容风险——建议先做**外部 HTTP rembg 服务**（可选配置项 `paper_studio.matte.provider: 'chroma' | 'rembg-http' | 'provider-alpha'`），本地 ONNX 推理在 desktop 双架构验证通过后再接入；
- adapter 接口预留在 `paperMatteService.js`（新 `mattePipeline(version, method)` 分发），F1 改动时就位。

## 3. 实施顺序与依赖

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P0（1-2 天）** | D1 假成功修复、D2 label 统一、C2 max_attempts 统一、C3 预算计入 failed、E2 alpha 阈值统一、B1 原子化步骤 | 无 | 低（行为不变或纯修复） |
| **P1（3-5 天）** | A1 proof 浏览器批复用、A2 bundle 缓存、C1 先自然化后门禁、E1 hash 语义修正、F1 深色 matte | B1 完成（C3 依赖 B1 的原子重试路径） | 中（A1 崩溃回退、C1 行为变化需全量回归、E1 涉及迁移） |
| **P2（长期）** | A3 concurrency 调优、D3 死 API 清理（配合题材方案启用 listActions）、D4 轮询分档、E3 fingerprint 唯一索引、F2 模型 adapter | 无 | 中低 |

**注意**：C3（预算含 failed）与 B1（原子化步骤）合并实现，因为"失败只重跑失败 slot"需要预算口径一致；E1 与 F1 都触碰 `paper_asset_versions` 的落盘逻辑，建议同一批次改动避免冲突。

## 4. 测试策略

- **确定性不回归**（A1/A2/A3 必须验证）：同一 snapshot 的 proof repeat 断言、preview/formal render_hash 一致性不受浏览器复用/并发影响；`node --test test/*.test.js` 全量；
- **新增单测**：
  - 原子步骤：只对指定 slot/version 重跑 matte/register/gate，未指定的不动（构造 fixture 断言未处理行的 updated_at 不变）；
  - C1：构造"naturalize 后超速/超透明斜率"的 plan，断言 gate 在 snapshot 冻结前失败（此前会漏）；
  - C3：制造 failed image_generation 行，断言预算计数 +1 并触发 `PAPER_STUDIO_IMAGE_BUDGET_EXHAUSTED`；
  - E1：遍历版本行断言 路径↔hash 一致（新旧两套语义）；
  - F1：深色背景 fixture 走 dark_v1/auto 模式成功，白底 fixture 走 white_v1 结果不变；
  - D1：store 单测"noop 不弹 toast"；
- **前端**：`node --test test/*.test.js` + `npm run build`；
- **回归样本**：巨鹿危城（360 帧/12 秒、两场景、两环境、18 帧转场、粮车 30 帧位移）在 C1 改动后必须原样通过（naturalize 后指标不得把 fixture 拦掉，否则按 §C1 微调参数）。

## 5. 验收标准

1. proof 20 target 的浏览器启动次数 ≤ 4，proof 阶段耗时下降 ≥ 30%（基准：改动前后同 snapshot 对比）；
2. 同 snapshot 的 preview 与 formal 不再重复 bundle（第二个模式命中缓存）；
3. `generate_required_slots / matte_assets / register_assets / asset_gate` 四个 step 可被单独调度执行（手动触发或失败恢复），且"全量生产"一键路径行为不变；
4. 门禁报告、冻结快照、渲染三方消费同一份（naturalize 后）plan；构造的越界样例在 gate 阶段失败；
5. `max_attempts` 单一来源；预算统计含 failed；重复 fingerprint 不再产生第二次 provider 调用（E3 生效后）；
6. 前端：点击无操作 action 不弹假成功；run/shot/merge 文案单一来源；死 API 已清点处置；
7. `source_hash`/`source_local_path` 指向同一文件（新数据）；生产与上传 alpha 门禁同一阈值；
8. 深色背景素材可被 matte 处理（dark_v1/auto），白底素材结果与改动前一致；
9. 后端/前端全部测试与构建通过，巨鹿危城 fixture 原样通过。

## 6. 风险与决策门

| 风险 | 应对 |
|---|---|
| A1 浏览器复用引发 Target closed 崩溃回归 | 保守方案（批内复用+定期重启+单 target 局部重试）；激进方案先跑压测再上线 |
| C1 自然化后指标拦掉既有合格镜头 | 先全量回归；若仅巨鹿 fixture 受影响且属 arc 容差边界，微调 arc 幅值 0.012→0.010 并记录决策 |
| E1 hash 语义变更影响旧行复用 | raw_hash 空值回退旧语义；遍历校验测试兜底 |
| E3 唯一索引与存量重复数据冲突 | 索引仅对新数据生效；存量清理单独立项 |
| B1 拆分 generateAssets 引入行为漂移 | 原子函数从原函数体机械抽取（不重写逻辑），聚合路径结果不变，测试断言 plan_hash 不变 |
| F1 自动模式误判白/深 | auto 模式仅在白/深两侧方差接近时启用，默认仍按素材边缘亮度直方图决定；键色置信度检查兜底 |
