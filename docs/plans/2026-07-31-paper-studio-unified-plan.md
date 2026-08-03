# 纸片工作室统一优化方案（引擎质量 + 题材去耦 + 分镜历史与素材复用）

> 日期：2026-07-31
> 增补日期：2026-08-01
> 范围：paper-studio 后端服务、render worker、paper-studio-renderer、frontweb 工作台
> 来源：本方案由《2026-07-31-paper-studio-engine-quality-plan.md》（下称"质量案"）与《2026-07-31-paper-studio-remove-theme-hardcode-plan.md》（下称"题材案"）合并，并于 2026-08-01 纳入《2026-08-01-paper-storyboard-history-and-asset-reuse-reasons.md》（下称"历史复用原因案"）的评审结论。三份源文档保留作历史参考，不再分别作为执行入口。
> 原则：保持"compile-once + hash 链 + 门禁"架构不变；性能优化不破坏渲染确定性；一致性修复以"单一事实源"为目标；题材去除遵循"先立后破"，回归断言不放宽；分镜历史、计划结构和素材版本必须不可变；任何图片 API 报价必须先扣除可复用历史素材。

## 0. 代码评审修正记录（已并入正文）

合并前对两份源方案做了逐条代码核实，以下修正已直接写进对应模块，不再单独跟踪：

**对质量案的修正**：
1. E3：`paper_asset_versions` 表**没有** `request_fingerprint` 列（仅存在于 `provenance_json`），唯一索引只建在 `image_generations` 上。
2. B1：无 ACTIONS 映射的 step 不止四个，还有 `compile_snapshot / dynamic_gate / wait_preview_approval`（本方案明确不处理，仅记录）；`asset_gate` 的 completed 唯一来源是人工审核 approve（`paperAssetReviewService.js` L134），失败恢复目前只能靠 reject 全量重置（L175-182）——`runAssetGate` 设计不得触碰人工语义。
3. C3：预算统计还有更大的洞——`usedImages` 的 JOIN 依赖 `ig.paper_asset_version_id` 回填（L720），回填前崩溃的记录既不计费也不去重，统计口径改为不依赖该 JOIN。
4. D1：假成功有第二类——`review_assets` 分支返回 `{attention_required}` 对象（store L1208-1209）而非请求结果，view 同样弹"已完成"；按钮 disabled 目前只排除 `wait_for_render`（PaperStudio.vue L242），其余 `wait_for_*` 均可点空转。
5. D2：`nextActionDescription` 无重复维护（PaperStudio.vue L555 单一 computed + `utils/paperStudioProduction.js` 单一来源），从清理清单移除；实际重复面更大——4 个 `statusLabel`（PaperShotRail L77 / PaperStoryboardRail L80 / PaperEpisodeRail L34 / PaperAudioWorkbench L287）+ `PaperRunOverview.shotStatusLabel`（L239，含 environmentOnly 特判 L240-247）+ 2 份 `mergeStatusLabel`（PaperDeliveryBoard L215 / PaperStudio L1570），文案已漂移（如 plan_confirmed："计划确认" vs "计划已确认，等待生成授权"）。
6. D4：签名对比（`[id, status, published_video_generation_id]`，store L1031/L1055）控制的是 delivery 刷新而非 getShot；`getShot` 每轮无条件调用（L1040-1041）——除分档外需给 getShot 加门控。
7. C1：`compile` 全库唯一调用方是 `paperMotionGateService` L117（重构面小于原估计）；但有两个额外触点——`compiled_tracks_json` 当前写原始 tracks（snapshot L115）、`compile` 内 `transitionGateService.assertPlan`（L202）已消费 naturalized plan。
8. C2：注意两层语义——step 表 `max_attempts`（step 重试，`settleUnhandledFailure` L162 据此判 exhausted）与报价 `maxAttempts`（API 调用授权）不是一回事，覆盖逻辑须保持 `settleUnhandledFailure` 语义不变。
9. A2：publicDir 是素材根目录、内容频繁变化，整目录摘要命中率低——bundle key 改为按 **snapshot 资产清单**（本 shot 引用的资产文件 hash 集）计算。

**对题材案的修正**：
1. A3（源案分类）：`GROUND_VEHICLE_PATTERN` 不是"粮车|马车|战车"词表正则，而是 `mobilityContractService.GROUND_MOBILITY_PATTERN` 的**别名**（compiler L23-25），是通用 `transport_move` 触发器（infer L358/L366），并被 `siegeSupplyBlueprint`（L185）、`assertCompiledRelationProvenance`（L1477）复用——**属通用机制，保留不删**；"粮车|辎重车|车队"题材词实际住在 `paperMobilityContractService.js`，处理方式是从通用正则中剥离题材词而非删除机制。
2. 遗漏第二套地图实现：`paperStudioTemplateCatalog.js` 自带 `MAP_ROUTE_PATTERN`（L5）与 legacy `map-route-reveal-v1`（L175-209/L714/L727，含"旧绢地图"）——只删 compiler 删不干净，须同步处理。
3. 其余遗漏硬编码：recovery 脚本 `data/recovery/20260731-restore-session/restore-paper-studio.js` L348（`siege-supply-sequence-v2`）；验证文案"巨鹿危城多阶段生产蓝图无效"（compiler L268）；第二个题材错误消息 L1038"粮车缺少动力来源与运输规模合同"；`paperAssetLabels.js` L26-27（`map_clean_background`/`map_character_marker`）；`paperStudioProduction.js` L33-48 整段"寒雾/环境底板"语境文案（源案只列了 L37/L40 两行）。
4. alias 兼容范围不足：action 名持久化在多处——`paper_motion_plans.plan_json`、`paper_studio_shots.plan_summary_json`（`primary_action/catalog_key/map_route/entity_keys`）、`semantic_contract_json`、磁盘快照（版本化蓝图 ID `siege-supply-sequence-v1/v2/v3`、`blueprint-map-route-reveal-v2`、`qin-silhouette`）；回读点包括 `paperAssetProductionService` L499/L652 的 `/map-route-reveal/` 正则与 `summary.map_route` 标记、`paperMotionGateService`、`paperAudioMotionSyncService`、`paperContinuityService`、`paperStudioRecoveryService`、`paperStudioArchiveService`。重命名须做"版本化 ID + 标记位 + 正则"三层兼容（见 G3）。
5. "断言不变"不可达：5 个测试文件硬断言题材产物——`paperSpatialGrounding.test.js`（`siege-supply-sequence-v3`、"巨鹿危城进入多阶段接地模板"）、`paperStudioBusinessUxPhase1.test.js`（`blueprint-map-route-reveal-v2`、`map_place_names=['定陶','黄河','邯郸','巨鹿']`）、`paper-motion-naturalizer.test.js`（siege_line 轨道）、`paperStudioRenderer.test.js`（procedural route-reveal/map-title-card/army-formation）、`paperStudioPhase2.test.js`（legacy `map-route-reveal-v1`）——须同步改断言（改为断言通用能力产物 + 等效质量指标）。
6. 验收 grep 与"词典保留"决策冲突：`甬道/城墙/战场` 在 `LOCATION_WORDS`（有意保留并外置）、`粮车|辎重车|车队` 在 mobility contract——grep 范围须豁免词典/词汇表文件（见 §5）。

**对历史复用原因案的评审修正**：
1. 当前 `paper_storyboard_revisions → paper_studio_shots → paper_source_families → paper_asset_slots → paper_asset_versions` 已能表达部分历史，但 `persistPlan()` 会物理删除旧素材族和槽位；因此"增加历史版本抽屉"不能作为独立前端任务，必须先完成计划结构不可变改造。
2. 当前 `assertReusableSourceCompatibility()` 强制跨生产版本复用来自同一个分镜修订。该条件过严：对白、声音、时长、字幕或纯转场参数变化不应让静态图片失效。复用条件改为比较独立的视觉合同指纹，而不是比较分镜修订 ID。
3. 当前 `request_fingerprint` 只用于一次付费请求的幂等，包含 authorization/run/source 等执行上下文，不能承担跨生产版本素材复用判断。新增 `reuse_fingerprint`，二者严禁混用。
4. 当前报价只排除目标槽位已有正式图、实体库素材和本地派生层，没有统一扣除同一分镜历史生产版本中的已批准素材。报价流程必须改为"编译需求 → 历史复用预检 → 应用零调用复用 → 只报价差异槽位"。
5. 连续性门禁失败不能默认要求修改原分镜并新建生产版本。只涉及转场时间、缓动、动作轨迹或遮挡的修复必须留在当前 run/shot 内完成，并在应用前展示保留、失效、新增素材和图片调用数。
6. 所有历史图（采用、淘汰、拒绝、失败）都应可查看；只有已批准、文件完整、哈希一致且视觉合同兼容的版本可以进入复用候选。
7. 旧素材被新版本复用时必须保留来源版本、目标槽位、兼容性报告和文件哈希，复用失败不得自动降级为付费生成。

## 1. 背景

纸片工作室 v9 已跑通全链路并验收，但存在八类工程问题：渲染 worker 性能浪费、四个 job step 是"纸面步骤"无法细分执行、门禁/报价/预算三处一致性缝隙、前端假成功与重复维护、资产 hash 与路径语义不一致、matte 对深色背景退化、题材硬编码进入生产协议（与 v3 技术设计"生产协议中没有船、水面或其他测试剧情专用分支"的原则直接冲突），以及分镜历史不可完整查看、计划重编译可能破坏历史关联、跨修订素材不能安全复用并可能造成重复图片 API 调用。本方案统一给出修复设计与实施顺序。

## 2. 问题清单与方案

### 模块 A：渲染性能

#### A1 proof 模式每个 target 单独启动 Chrome（`scripts/render-paper-studio.mjs` L195-212）

**现状**：proof 模式每个 target 开一个 Chrome 实例（`openRenderBrowser()` L196），渲染 full/repeat/debug 三张 still 后关闭（`finally close` L211）。20 个 target 即 20 次浏览器启动（每次 2-5 秒）。L173-177 注释说明原因：共享浏览器会让解码后的 state-atlas 图片在内存堆积，最终 Target closed 崩溃。已核实：`renderStill` 来自 `@remotion/renderer@4.0.491`，经 `puppeteerInstance` 注入实例，**无显式内存释放 API**，释放完全靠关闭浏览器。

**方案（保守）**：批内复用 + 定期重启
- 复用同一 Chrome 实例渲染连续 N 个 target（默认 N=5，可配置 `paper_studio.proof_browser_targets_per_session`），每 N 个或每 60 秒重启一次；
- 崩溃兜底：`renderStill` 抛 Target closed 类错误时，当前 target 用新浏览器重试一次（局部重试，不整批失败）；
- 确定性校验不变（full/repeat 仍同一浏览器内连续渲染，重复性断言语义不变）；
- 预期收益：20 target 从 20 次启动降为 4 次，proof 时长缩短 30-50%。

**激进选项（后续验证）**：全局复用 + 渲染前主动清理；先用保守方案跑通再评估。

#### A2 每次渲染都重新 `bundle()`（L146-154）

**现状**：`bundle({ entryPoint, publicDir, enableCaching: true })` 每次 proof/preview/formal 进程执行一次（bundle 在 target 循环之外，每进程一次）。`enableCaching` 只缓存 webpack 内部产物，serveUrl 每次生成，bundle 阶段每次仍要扫描/打包（数秒到数十秒）。

**方案**：bundle 结果按内容 key 复用
- key = `sha256(renderer 源码目录内容摘要 + snapshot 资产清单摘要)`——资产清单取本 shot 引用的资产文件 hash 集（**不按整个 publicDir 摘要**，素材根目录变化频繁会导致缓存几乎不命中）；
- bundle 输出目录固定为 `backend-node/data/paper-studio-render-bundle/{key}/`，key 命中且目录存在时跳过 bundle 直接复用 serveUrl；
- 服务端进程内缓存最近 1 个 key（内存持有 serveUrl），跨进程用目录判断；
- 预期收益：同一 snapshot 连续渲染（proof→preview→formal）时后两次省掉 bundle。

#### A3 `renderMedia` 固定 `concurrency: 1`（L251）+ `enforceAudioTrack: true`（L248）

**方案**：
- concurrency 可配置：`paper_studio.render_concurrency`，默认 `min(max(1, floor(os.cpus().length / 2)), 4)`（每 worker 约 0.5-1GB 内存，桌面端需评估）；preview 固定 2；
- `enforceAudioTrack` 改为 `snapshot.audio_sources?.length > 0`，无音频不强制音轨（ffprobe 断言同步放宽）；
- 保持不变：crf（preview 28 / formal 20）、x264Preset（veryfast / medium）。

### 模块 B：纸面步骤原子化

#### B1 四个 step 无 ACTIONS 映射（`paperOrchestratorService.js` L17-66）

**现状**：ACTIONS 仅 6 个 key（`generate_layout_master / plan_motion / render_proof / render_preview / render_formal / publish_video`），`runnableSteps`（L115-116）与 `claim`（L134-135）均以 `ACTIONS[step.step_key]` 为前置条件——`generate_required_slots / matte_assets / register_assets / asset_gate` 永不被调度，由 `generateAssets` 成功（`paperAssetProductionService.js` L996，四个 step，不含 asset_gate）/失败（L1017，五个 step，含 asset_gate）时批量标记。后果：无法"只重跑 matte"、"只补生成单个 slot"、"只重跑技术门禁"；任何素材失败都是整镜 `generate_layout_master` 重跑。

**范围澄清**（评审补充）：无 ACTIONS 的 step 还有 `compile_snapshot / dynamic_gate / wait_preview_approval`——它们由其他服务内部推进，**不在本次原子化范围**；`asset_gate` 的 completed 唯一来源是人工审核 approve（`paperAssetReviewService.js` L134），失败恢复目前只能靠 reject 全量重置（L175-182），`runAssetGate` 只重跑**技术门禁**，不改人工审核语义。

**方案**：把 `generateAssets` 拆成可组合的原子操作，再配 4 个 ACTIONS
- 原子操作（同一文件内新增纯函数，从原函数体**机械抽取**、不重写逻辑）：
  - `generateMissingSlots(db, cfg, log, shotId, { slotIds?, requestId, expectedVersion, authorizationId })`：只处理 `status != ready` 的 slot（支持 slotIds 白名单）；
  - `mattePendingVersions(db, cfg, log, shotId, { versionIds? })`：只对 `quality_report_json` 缺 matte 结果的 accepted/candidate 版本跑 `alphaReport + defringe`；
  - `registerVersions(db, cfg, log, shotId, { versionIds? })`：重算 `contact_anchor` 与 registration_json；
  - `runAssetGate(db, cfg, log, shotId)`：重跑 alpha 技术门禁 + family 状态汇总（不改人工审核语义）；
- 4 个 ACTIONS 各映射一个原子操作（queue: local，state 转换沿用现有 failureState 表）；
- `generate_layout_master` 保留为聚合动作：内部顺序调用 4 个原子操作（"全量生产"一键路径不变，测试断言 plan_hash 不变）；
- 依赖关系不变（matte 依赖 required_slots 完成、asset_gate 依赖 register 完成）；
- 额外收益：失败恢复精确到 slot——`review_error → retry_step` 只重跑失败 slot，配合预算口径（C3）。

**不做**：不引入按 slot 的独立授权（现有 authorization 已是 slot 粒度：`max_authorized_calls = slots.length * maxAttempts`，L197）；不处理 `compile_snapshot / dynamic_gate / wait_preview_approval` 三个 step。

### 模块 C：一致性缝隙

#### C1 门禁评估原始 plan，snapshot 存自然化后 plan

**现状**（已核实）：`planMotion` 先 `audioMotionSyncService.sync`（`paperMotionGateService.js` L106-107）→ 对原始 `plan_json` 跑门禁 `evaluate`（L108）→ 通过后 `snapshotService.compile`（L117）内部才 `naturalize`（`paperSnapshotService.js` L177）。naturalize 会注入 arc 拱形（幅值 0.012）、anticipation 回坐、ease-out-back 过冲——可能把原本合格的指标推越界，但门禁报告与快照内容不一致，只能靠 proof 兜底。已核实：naturalize 是纯函数（clone 所有 track，不改库中原始 plan_json）；`compile` 全库唯一调用方即 motion gate L117。

**方案（改顺序，不改算法）**：
- `planMotion` 改为：`sync 音频时序 → 原始 compile → naturalize（纯函数，现成）→ 用自然化后的 plan 跑五层门禁 → 通过后直接冻结 snapshot（compile 不再重复 naturalize）`；
- **触点清单**（评审补充，缺一不可）：
  1. evaluate 输入改为 naturalized plan；
  2. `compile` L177 去重（已 naturalize 则跳过）；
  3. `compiled_tracks_json`（snapshot L115）当前写原始 tracks——改为写 naturalized 后 tracks，保持"快照内容 = 门禁所见"；
  4. `transitionGateService.assertPlan`（compile L202）现消费 naturalized plan——顺序调整后语义不变，但需回归确认；
- 回归影响：naturalize 后指标超限的镜头会从"漏过 proof"变为"gate 拦截"（正确行为），需全量回归确认巨鹿 fixture 仍通过；如个别阈值过紧（arc 0.012 vs ground_tolerance 0.012），把 gate 数值断言改为"naturalize 后重新计算"，必要时微调 arc 幅值（0.012 → 0.010）并记录决策。

#### C2 报价 max_attempts 与 job step max_attempts 脱节

**现状**（已核实）：报价按 slot 计算 `maxAttempts = max_auto_retries_per_slot + 1`（`paperGenerationAuthorizationService.js` L184；tier 定义在 `paperStudioRunService.js` L86-88：draft=1→2 次、balanced=2→3 次、full-depth=2→3 次）；执行侧 step 的 `max_attempts` 由 analyzer 固定写 2（`paperStudioAnalyzerService.js` L415-420）。full-depth 报价 3 次、执行仍 2 次——白付了报价用不上。

**方案**：单一事实源
- `authorizeAndStartGeneration` 成功时，按 authorization 的 slot 维度计算该 shot 相关 step 的 `max_attempts = max_auto_retries_per_slot + 1` 并 UPDATE `paper_job_steps`（analyzer 插入保留默认值，授权时覆盖）；
- **语义边界**（评审补充）：step `max_attempts`（step 重试次数）与报价 `maxAttempts`（API 调用授权次数）是两层概念，`settleUnhandledFailure`（L162）按 step 层判定 exhausted——覆盖逻辑只统一数值来源，不得改变 `settleUnhandledFailure` 的语义；
- 报价函数与授权函数共用同一常量计算（`budget_json.max_auto_retries_per_slot`）；
- 展示层：报价文案明确"最多 N 次调用（含自动重试）"。

#### C3 预算统计不含 failed 调用 + JOIN 回填洞

**现状**（已核实）：`usedImages`（`paperAssetProductionService.js` L632-642）只统计 `ig.status IN ('processing','completed')` 且 JOIN `pav.id = ig.paper_asset_version_id`——两个问题：① failed 调用（4xx/5xx、超时）通常已真实消耗 provider 配额却不计入；② `paper_asset_version_id` 在 createImageGeneration 时为 NULL、L720 才回填，**回填前崩溃的记录既不计费也不去重**，预算实际可超支。

**方案**：
- 统计口径改为 `('processing','completed','failed')`，且**不依赖 `paper_asset_version_id` JOIN**（按 shot 维度直接统计 image_generations 行）——预算 = 已消耗配额（保守：宁可多算不可超支）；
- 报价弹窗文案加注"含失败调用与自动重试"；
- 429/限流归一化的 `PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED` 保持不计重试（该错误不落 image_generations 的 failed 行，无重复计数风险——实现时验证此路径）；
- 与 B1 合并实现（"失败只重跑失败 slot"需要预算口径一致）。

### 模块 D：前端缺陷

#### D1 假成功（两类）（`paperStudioStore.js` / `PaperStudio.vue`）

**现状**（已核实）：
- 第一类：`runNextAction`（store L1187-1269）对 `recover_run / review_preview / wait_for_analysis / wait_for_assets / wait_for_motion / wait_for_proof` 无分支、else return null（L1235-1237）；view 的 `runCurrentAction`（L1369-1372）不检查返回值直接 `ElMessage.success('当前生产步骤已完成')`。注意：这些 action 字面量在 frontweb/src 零出现（前端从未认识它们），按钮 disabled 目前只排除 `wait_for_render`（L242），其余 wait_for_* 可点空转。
- 第二类（评审补充）：`review_assets` 分支返回 `{ attention_required: 'review_assets', shot }`（store L1208-1209）而非请求结果，view 不区分，同样弹"已完成"——实际未触发任何服务端动作。

**方案（两处都改）**：
- store：`runNextAction` 对无分支 action 返回 `{ noop: true, action }`；`review_assets` 类返回 `{ attention_required }` 时也标记为非成功语义；
- view：`runCurrentAction` 收到 `noop / attention_required` 时**不弹任何提示**并即时刷新 run 状态（attention_required 可跳转对应面板）；`canRunCurrentAction` 黑名单补全部 `wait_for_*` / `recover_run` / `review_preview`，按钮置灰 + tooltip"后台处理中/等待人工操作"；
- 测试：store 单测"noop 不产生成功 toast"、"attention_required 不弹已完成"。

#### D2 状态文案统一（修正版）

**现状**（已核实）：`runStatusLabel` 1 处（PaperStudio.vue L1569）；`mergeStatusLabel` 2 处且文案不同（PaperDeliveryBoard L215"可交付/历史版本" vs PaperStudio L1570"整集合并完成/分镜已更新，需要重新合并"）；shot 文案实为 5 处——4 个 `statusLabel`（PaperShotRail L77 / PaperStoryboardRail L80 / PaperEpisodeRail L34 / PaperAudioWorkbench L287）+ `PaperRunOverview.shotStatusLabel`（L239，含 environmentOnly 特判 L240-247），两套文案已漂移。`nextActionDescription` 是单一 computed（PaperStudio L555）+ `paperStudioProduction.js` 单一来源，**无重复维护，不动**。

**方案**：新建 `frontweb/src/utils/paperStudioLabels.js`，导出 `runStatusLabel / shotStatusLabel / mergeStatusLabel`（含 environmentOnly 特判逻辑）单一来源，六处组件改引用；后端 label 仍以 `next_action` + 事件为准，前端不做第二份状态机。

#### D3 死 API（已核实：`frontweb/src/api/paperStudio.js`）

- `listActions`（L155，→ `GET /paper-studio/actions`，后端 `routes/paperStudio.js` L219 已在）：**保留并在 G0 启用**（前端主动作下拉动态化）；
- `recoverRun`：PaperStudio.vue 无对应 UI，若后端有 recover 语义则补入口，否则删除；
- `updatePaperEpisode / deletePaperEpisode / listContinuity / listRevisions`：API 层与 store 包装层（如 store L354/L358/L1541 的 updatePaperEpisode 包装）均零调用——删除或在文件头注释"预留，未接线"；删除时同步清理 store 同名空方法。

#### D4 轮询恒定 2.5s × 3-4 请求（已核实：PaperStudio.vue L742-753；store refreshActiveRun）

**现状**：固定 `setInterval 2500`，仅按 visibilityState/acting/终态跳过，无分档/退避；每轮 `getRun`（L1034）必调、`getShot`（L1040-1041）只要 preferred 存在就无条件调、`loadRuns + loadRunEvents`（L1058）也每轮调；latestMerge 为 pending/processing 时再叠加并发请求（L746-748）。签名对比 `[id, status, published_video_generation_id]`（L1031/L1055）控制的是 delivery 刷新，不含 version。

**方案**：
- 按 next_action 分档：后台执行中（analyzing/motion/proof/render/publish）保持 2.5s；人工阻塞点（plan_review/asset_review/preview_ready）降频 8s；无活跃 run 停止轮询（任务中心抽屉打开时单独轮询）；
- **给 getShot 加门控**：签名对比扩展 `version` 字段（素材/动作/预览变化能触发重载），签名不变时跳过 getShot——这是请求量下降的主要来源；
- 估算：后台阶段请求密度不变，人工阶段下降约 70%+。

### 模块 E：数据一致性

#### E1 `source_hash` 与 `source_local_path` 指向不同文件

**现状**（已核实）：落库（`paperAssetProductionService.js` L792-800）`source_hash = hashFile(downloadedPath)`（原始下载图），而 `source_local_path = target.relative`（alpha 处理后产物）——同一行 hash 与路径描述的不是同一个文件。无 `raw_local_path/raw_hash` 列；rematte 的原图来源是 `ig.local_path AS raw_local_path`（L1045，从 image_generations 取）。

**方案**：
- image_api 路径：migration 加 `raw_local_path + raw_hash` 列（原始下载图），保持 `source_local_path/source_hash` 指向**处理后的最终文件**；历史行 raw_hash 为空时回退用 source_hash（旧语义）；可考虑用 `ig.local_path` 回填存量 raw 列；
- 复用/比对统一：优先 `alpha_hash`（已有），其次 `source_hash`（处理后），`raw_hash` 仅用于"重新处理"场景（rematte 不再对已抠图再抠）；
- 新增断言测试：遍历 `paper_asset_versions`，断言 `hash(路径指向的文件) === 对应 hash 字段`（新旧两套语义）。

#### E2 alpha 门禁阈值两套（已核实）

生产 `transparent >= 0.05`（`paperAssetProductionService.js` L226）vs 用户上传 `>= 0.01`（`paperAssetWorkspaceService.js` L118）。

**方案**：抽 `paperMatteThresholds.alphaGate(kind)` 单一常量表（transparent_ratio、visible_ratio 上下限、residual_key_edge_ratio），生产与上传共用；上传路径收紧到 0.05 前，UI 先提示透明占比要求，避免上传后才发现不合格。

#### E3 fingerprint 无唯一索引，重复请求可能重复扣费（修正版）

**现状**（已核实）：`image_generations.request_fingerprint`（migration 31 加列）无索引、无 UNIQUE；`paper_asset_versions` **没有** fingerprint 列（仅 `provenance_json` 内含，L811）。

**方案**：
- migration 加部分唯一索引：`CREATE UNIQUE INDEX ... ON image_generations (request_fingerprint) WHERE generation_kind = 'paper_studio_asset' AND request_fingerprint IS NOT NULL AND deleted_at IS NULL`；
- `generateViaApi` 调用前先按 fingerprint 查询：已存在 completed 直接复用该 version（幂等返回），processing 等待/复用，failed 才重新发起；
- 存量重复数据：索引仅对新数据生效，存量清理单独立项。

### 模块 F：Matte 短板

#### F1 深色背景退化（已核实：`paperMatteService.js`，位于 services/ 根目录）

**现状**：`estimateBorderKeyColor` 过滤 `luminance < 128` 的像素（L53-56，注释说明是为防止主体贴边污染 key），无样本时兜底返回 `[255,255,255]`（L62）——深色背景素材边缘采样全部被丢弃，抠图失败或严重色溢。matte 路径仅两条：provider_alpha / border_matte_v2（L190），无 onnx/rembg。

**方案**：
- 新增 `dark_v1` 键色模式：过滤 `luminance > 128` 取中位数（与 white_v1 对称）；
- 新增自动模式 `auto`：双边采样，分别算白侧/黑侧中位数的色度方差，取方差小的一侧；`alphaReport` 按素材边缘亮度分布自动选择；
- 键色置信度检查：边缘采样量 < 阈值（如 500 像素）或键色与边缘主体色距离 < 24 → 不自动失败，标记"建议提供透明底/换图"，走人工审核路径；
- 对现有白底素材零影响（默认仍 white_v1）。

#### F2 无 onnx/rembg 模型兜底（分期）

- **P1（本方案）**：不引入模型。交付 F1 + defringe 增强（边缘收缩 1px + 羽化；形态学 erode 可选参数）；
- **P2（长期，单独立项）**：rembg/BiRefNet 作为独立 adapter，先做**外部 HTTP rembg 服务**（`paper_studio.matte.provider: 'chroma' | 'rembg-http' | 'provider-alpha'`），本地 ONNX 推理在 desktop 双架构验证后再接入；
- adapter 接口预留在 `paperMatteService.js`（新 `mattePipeline(version, method)` 分发），F1 改动时就位。

### 模块 G：题材去耦

> 详细清单见源题材案 §2（A-E 类）及本方案 §0 的评审修正。此处给出修正后的执行设计。

#### G0：前端安全修复（不动协议）

1. **主动作下拉动态化**：`PaperBlueprintEditor.vue` L87-95 硬编码 `<option>`（7 项，含"战役地图推进"/"缺粮·运粮·围城多阶段"）改为从 `listActions()`（前后端链路已齐全）动态拉取；catalog 中题材项标记 `user_selectable: false`（后端小改）。
2. **错误码通用化**：`PAPER_STUDIO_SIEGE_SEQUENCE_ENTITY_MISSING`（compiler L1034）→ `PAPER_STUDIO_GROUNDED_SEQUENCE_ENTITY_MISSING`，消息"多阶段接地序列缺少必要的接地主体或场景主体"；同步改第二个题材错误消息（L1038"粮车缺少动力来源与运输规模合同"→ 通用"运输主体缺少动力来源与运输规模合同"）与验证文案（L268"巨鹿危城多阶段生产蓝图无效"→ 通用）。本仓库错误码无外部依赖，直接替换。
3. **UI 文案通用化**：`PaperBlueprintEditor.vue` L403 → "大型接地道具（车辆、推车、大型器物等）不能设置为手持关系"；`paperStudioProduction.js` **L33-48 整段**（非仅 L37/L40）"寒雾/环境底板"语境文案 → "环境氛围漂移、空气流动由本地程序动画完成"等通用表述；`paperAssetLabels.js` L26-27（`map_clean_background`/`map_character_marker`）一并通用化；L10 `map_marker: '地图人物剪影'`保留（状态语义）并注释来源。
4. **前缀剥离表合并**：`PaperBlueprintEditor.vue` L427 与 compiler L80 的 `^(?:秦军|楚军|赵军|军用|一辆|一队)` 收敛为后端单一常量，内容改为通用量词 `^(?:一辆|一队|一箱|一捆|一名|一位)`（删题材部分），前端注释指向后端。

#### G1：通用模板先立（核心第一步）

1. **通用多节拍接地序列** `multiBeatGroundedSequencePlan`（数据驱动）：从 storyboard 上下文提取全部接地主体（`role: ground_prop / ground_vehicle` 道具、`grounded` 角色）；按文本时序（关键词锚定：掉落/落地/前行/驶入/逼近/合拢 + 主体名）分配节拍；节拍数自适应 2-4；实体/场景/轨道/转场全部来自上下文，不预设 `supply_bag/supply_cart/siege_line`。该模板即 `siegeSupplyPlan`（L1028-1173）的通用化版本，须保留 `visual_scenes + transition_contracts` 产出（否则 transitionGate 门禁行为变化，不只是质量退化）。
2. **通用路径揭示** `pathRevealPlan`：保留"地图/平面图 + 路径逐步延伸"机制，移除战役限定（围城圈/军阵符号），改为路线/路径/管道/流程线逐步揭示；`MAP_PLACE_LAYOUTS`（L26-31）删除，关键点按上下文实体生成（`map_marker` 状态保留为通用标记）。
3. **infer 双跑验证**：不删除专用函数，让 infer 的命中路径切到通用模板，巨鹿危城 fixture **改走通用路径**，断言全部通过且关键质量指标与现状一致（360 帧/12 秒、两场景、两环境、18 帧转场、粮车 30 帧位移、节拍错峰）。
4. **配套交付**：蓝图编辑器转场时间轴从只读改为可编辑（字幕锚定失去"兵少粮尽"等强关键词后，用户可手动拖锚点兜底）。
5. **同步改 5 个测试文件的断言**（清单见 §0 题材修正 5）：从断言题材产物（蓝图 ID/地名/siege_line 轨道）改为断言通用能力产物 + 等效质量指标。
6. **新增题材无关回归**（必须）：现代都市分镜（"外卖员骑车穿过街道，停在公寓楼下"）、奇幻分镜（"巨龙掠过山谷，落在岩台上"）、现代地图分镜（"物流地图上，包裹路线从仓库延伸到门店"→ 走 path_reveal，断言无"围城/军阵"）。

**验收原则：同一分镜在通用路径下的输出质量不得低于专用路径，回归断言不放宽。做不到说明抽象未完成，不得进入 G2。**

#### G2：题材后破（G1 验收通过后）

1. 删除 infer 的 `MAP_ROUTE_PATTERN / SIEGE_SUPPLY_PATTERN` 分发（L333-334）、`siegeSupplyBlueprint / mapRouteBlueprint / siegeSupplyPlan / mapRoutePlan` 四函数（连同 `MAP_PLACE_LAYOUTS`、字幕锚定正则、`qin-silhouette` L1114）；compile 分发表（L1514-1520）只留通用 action。
2. **同步删除第二套实现**：`paperStudioTemplateCatalog.js` 的 `MAP_ROUTE_PATTERN`（L5）与 legacy `map-route-reveal-v1`（L175-209/L714/L727）及"旧绢地图"。
3. `paperMobilityContractService.js` 的 `粮车|辎重车|车队` 题材词从通用正则剥离（**机制保留**——`GROUND_VEHICLE_PATTERN` 是通用 `transport_move` 触发器，infer L358/L366 与 `assertCompiledRelationProvenance` L1477 依赖它）。
4. `SUPPORTED_BOUNDARY_TRANSITION_PATTERN`（analyzer L20/L338）**保留**：沉没/坠入/越过边界是通用动词，仅确认契约文本无题材词（现有代码已是"液体表面边界"通用描述）。
5. 处理 recovery 脚本 `restore-paper-studio.js` L348 的 `siege-supply-sequence-v2`（历史恢复脚本，加注释放行或改经 alias）。
6. **泄漏守卫测试**：扫描 compiler/analyzer/template 输出（prompt、蓝图、plan、错误消息）断言不匹配 `秦军|巨鹿|定陶|黄河|邯郸|粮袋|寒雾|王离|章邯|围城|破釜`（测试文件、示例内容、词典文件除外）。

#### G3：能力命名抽象化 + 三层兼容（与 G2 同批）

1. **catalog 重命名**：`siege_supply_sequence → multi_beat_grounded_sequence`、`map_route_reveal → path_reveal`；新增 `ACTION_ALIASES`。
2. **procedural kind 重命名**：`route-reveal → path-reveal`、`map-title-card → label-card`、`army-formation → crowd-formation`、`ember-field → ember-drift`（可选保留原值）；`ProceduralLayer.jsx` 的分发是 if 链（L167 起），alias 最自然落点在 L168 `const kind = ...` 处做一次 `KIND_ALIASES[raw] || raw` 归一化，单点覆盖全部 8 个分支。
3. **三层兼容**（评审补充，alias 只覆盖第 1 层不够）：
   - 第 1 层 action 名：`ACTION_ALIASES` 只读归一化（plan_json / plan_summary_json.primary_action）；
   - 第 2 层版本化蓝图 ID 与外观：磁盘快照中的 `siege-supply-sequence-v1/v2/v3`、`blueprint-map-route-reveal-v2`、`qin-silhouette`——校验/渲染路径对旧 ID 走映射表，不修改快照文件；
   - 第 3 层标记位与正则：`plan_summary_json.catalog_key / map_route / entity_keys`、素材生产 L499/L652 的 `/map-route-reveal/` 正则与 `summary.map_route` 判断——回读处兼容新旧两套值；
   - 新生产只写新名；`validatePlan` 对未知 action 直接 fail（不静默通过），alias 表补全测试覆盖。
4. `appearance: 'qin-silhouette'` 删除，剪影外观由 prompt 或默认剪影生成（旧快照经第 2 层映射仍渲染）。
5. 语义合同/快照 schema 不升大版本；新增 `visual_beats` 字段再随 v10 planner 升版本。

#### G4：词典外置与项目配置化（长期，可选）

1. 新建 `paperThemeVocabulary.js` 集中承载：`LOCATION_WORDS`（扩充通用地点词：小区/商场/办公室/教室/医院/车站/公园…）、群组词（人群/众人/队伍/一行人/围观群众/同伴/随行人员…）、`stateDirections`、默认关键点命名；
2. `paper_studio_projects.config_json` 支持 `vocabulary_overrides`：项目级注入自定义词表（修仙/科幻等题材项目），不改产品代码；
3. 前端 `paperStudioProduction.js`/`paperAssetLabels.js` 文案引用后端词汇表导出常量（或前端独立词典并注明与后端同步）。

### 模块 H：分镜全历史与素材复用（2026-08-01 增补，下一实施阻断项）

> 原因与产品原则详见《2026-08-01-paper-storyboard-history-and-asset-reuse-reasons.md》。本模块不是单纯增加历史图片界面，而是修复计划持久化、历史关联、复用判定和费用报价四个层面的结构性缺口。

#### H0：不可违反的产品与数据合同

1. 每个纸片分镜必须能查看全部脚本修订、生产版本、蓝图/动作计划版本、素材槽位及图片版本。
2. 重新分析、重新编译、修订蓝图和修复转场时，不得物理删除旧计划、旧素材族、旧槽位或旧图片版本；只能新建版本并把旧版本标记为 `superseded`。
3. 图片文件只要仍被任意历史版本引用，就不能被垃圾回收或覆盖。
4. 复用、比较、重新抠图、Mask 修正、本地程序化过渡和重新执行门禁均为零图片调用操作。
5. 图片 API 的执行顺序固定为：素材需求编译 → 历史/实体库/本地复用预检 → 用户审核复用清单 → 只对剩余槽位报价 → 用户明确授权 → 调用 provider。
6. 复用失败必须停在人工决策点，不得自动降级为付费生成。

#### H1：计划与素材结构不可变

**现状问题**：`paperStudioAnalyzerService.persistPlan()` 会 `DELETE` 当前 shot 的 `paper_source_families / paper_asset_slots / paper_composition_nodes / paper_motion_plans / paper_job_steps` 后重建。素材版本和文件可能仍在，但旧槽位和旧计划关系会丢失，历史界面与复用判断都不再可信。

**数据模型**：

- 新建 `paper_plan_revisions`：`id / shot_id / blueprint_revision_id / plan_hash / status / transition_report_json / created_at / confirmed_at / superseded_at`；
- `paper_studio_shots` 新增 `current_plan_revision_id`，只指向当前有效计划；
- `paper_source_families / paper_composition_nodes / paper_motion_plans / paper_job_steps` 增加 `plan_revision_id`；
- 重建依赖 `shot_id` 的唯一约束，使同一个 shot 在不同 `plan_revision_id` 下可以保存同名 family/node/step；
- `paper_asset_slots` 通过 family 归属到计划修订；旧 family/slot 保持原 ID，不搬迁、不覆盖；
- `persistPlan()` 改为插入新计划修订、标记旧计划 `superseded`、更新 `current_plan_revision_id`，禁止执行历史结构的 `DELETE`；
- 所有当前生产查询显式限定 `current_plan_revision_id`，所有历史查询不做该限定；
- 迁移前运行只读完整性报告；发现失联素材版本时，使用 `image_generations.paper_storyboard_id / paper_studio_run_id / paper_studio_shot_id / paper_asset_slot_id / paper_asset_version_id / frame_type / generation_purpose` 回建归档关系，不删除原行和文件。

**迁移门禁**：迁移前后必须断言每个 `paper_asset_version` 的槽位、生产镜头、分镜和文件哈希仍可追溯；旧记录数量只能保持或增加，不能减少。

#### H2：分镜级历史查询与展示

新增只读历史服务，以 `paper_storyboard_id` 为主键聚合：

- `GET /paper-studio/storyboards/:id/history?cursor=&limit=`：返回脚本修订及其生产版本摘要；
- `GET /paper-studio/storyboards/:id/history/runs/:run_id`：返回指定生产版本中的 shot、计划修订、素材槽位和全部素材版本；
- `GET /paper-studio/storyboards/:id/history/assets/:asset_version_id`：返回单张历史素材的文件、来源、调用、审核、质量和复用去向；
- 历史列表使用游标分页，摘要响应不内嵌全部图片和大型 JSON，展开生产版本后再加载详情；
- 默认包含采用、淘汰、拒绝、失败、取消和 superseded 记录；软删除记录标记为归档，不静默隐藏。

前端在两个位置提供同一入口：

1. 分镜创作页标题栏：`历史版本 N`；
2. 生产镜头页：`查看该分镜全部历史`。

历史抽屉按“脚本修订 → 生产版本 → 计划修订 → 素材槽位 → 图片版本”展示时间线，支持“全部 / 当前采用 / 可复用 / 已淘汰 / 失败”筛选。每张图显示模型、调用次数、审核状态、来源版本、文件完整性和复用状态。

#### H3：视觉合同指纹与复用分级

`request_fingerprint` 继续只负责一次付费生成请求的幂等；新增独立 `reuse_fingerprint`，写入目标素材槽位和产生的素材版本。

`reuse_fingerprint` 由真正影响静态图片内容的视觉合同计算：

- 项目/分镜归属、素材类型、slot 用途与 generation purpose；
- 稳定实体身份（实体库 ID、identity version 或规范化 subject identity）；
- 主体状态、组合规模、动力成员和接触关系；
- 场景地点、时间、天气、环境描述、构图和注册画布；
- 当前视觉风格签名、参考图文件哈希、画幅和透明背景策略；
- 与图片内容相关的 blueprint/slot constraints 版本。

以下字段不得直接进入复用指纹：run ID、shot ID、分镜修订 ID、authorization ID、对白、旁白、声音时间、字幕时间、纯时长变化、转场帧数和缓动参数。若自由文本动作变化导致主体状态或视觉合同变化，应由编译后的结构化 constraints 改变指纹，而不是直接比较整段文本。

复用分级：

| 等级 | 判定 | 行为 |
|---|---|---|
| `exact` | 同一项目和分镜、指纹一致、源版本已批准、文件存在且哈希一致 | 显示“可直接复用（0 调用）”，由用户批量确认后挂接 |
| `review` | 类型和主体一致，但状态、场景或参考合同存在可解释差异 | 只作为人工候选，禁止自动采用 |
| `blocked` | 主体身份、素材类型、风格、场景合同不兼容，或源图未批准/文件异常 | 显示原因，不进入复用操作 |

环境图的匹配必须比角色/道具更严格：地点、时间、天气、环境状态、参考图和构图合同任一变化均不得自动复用。角色/道具则按身份版本、状态、外观和风格匹配，不因背景、对白或转场变化自动失效。

新增 `paper_asset_reuse_links` 审计表：记录 `source_asset_version_id / target_asset_version_id / target_shot_id / target_slot_id / match_kind / compatibility_report_json / created_at`。复用生成新的目标素材版本记录，`derivation_kind = 'historical_reuse'`，文件采用内容寻址引用或安全硬链接/复制，记录源文件哈希；不得创建付费 `image_generations` 行。

#### H4：先复用后报价

生成报价前新增 `buildReusePreview()`：

1. 目标槽位已有已批准版本 → 当前素材，0 调用；
2. 实体库正式形象匹配 → `paper_library` 复用，0 调用；
3. 同分镜历史版本存在 `exact` 候选 → 历史复用，0 调用；
4. 本地 Mask/程序化派生 → 本地生成，0 调用；
5. 其余槽位 → `needs_image_api`。

报价响应新增：

```json
{
  "required_slot_count": 8,
  "current_reuse_count": 1,
  "history_reuse_count": 3,
  "library_reuse_count": 2,
  "local_derivation_count": 1,
  "estimated_image_count": 1,
  "max_authorized_calls": 3,
  "reuse_preview_fingerprint": "sha256:...",
  "slots": []
}
```

用户先审核并点击“应用 3 张历史素材（0 调用）”；服务端重新计算版本和文件完整性后挂接。挂接完成再生成付费报价，`estimated_image_count` 只能等于剩余 `needs_image_api` 槽位数。复用清单、目标计划或 provider 配置变化时，旧报价必须失效。

槽位级“只重新生成这一张”属于显式强制生成，仍可跳过历史复用，但必须在确认框中标记“将忽略 N 个可复用历史版本并新增 1 次图片生成授权”。

#### H5：当前生产版本内的零调用连续性修复

连续性门禁失败时不能丢弃失败计划。编译器改为返回可持久化的 draft plan 和 `transition_report`，计划修订状态记为 `blocked_continuity`，shot attention 记为 `repair_transition`。

新增两阶段接口：

- `POST /paper-studio/shots/:id/continuity-repair-preview`：只计算修复后的 blueprint/motion plan、门禁结果和素材槽位 diff，不写库、不调用图片 API；
- `POST /paper-studio/shots/:id/continuity-repair`：携带 preview fingerprint、expected version 和用户确认，插入新的计划修订并映射未变化素材。

修复预览必须明确显示：

```text
计划修改：延长转场并错开主体动作
保留素材：4 张
历史复用：0 张
失效素材：0 张
新增素材槽位：0
图片 API：0 次
```

只有素材 diff 为零或全部可以 `exact` 复用时，才允许“应用零调用修复”。如果新增场景、主体或状态导致槽位变化，修复操作只保存新计划和缺失槽位，不得自动生成；随后进入 H4 的复用预检和差异报价。

**版本边界**：

- 只修改蓝图、动作轨迹、转场、遮挡和 timing：保留当前 run/shot，新增计划修订；
- 用户修改分镜脚本事实、主体身份、地点或视觉风格：创建新的分镜修订和生产版本，但必须通过 H3/H4 复用未变化素材；
- 任何路径都必须保留旧 run、旧计划、旧槽位和旧图片历史。

#### H6：安全与并发要求

- 所有复用、修复和应用操作使用 `expected_version`；版本冲突时重新计算预览，不复用旧决定；
- `reuse_preview_fingerprint` 包含目标计划、候选素材 ID、文件哈希和 compatibility report；任一变化即失效；
- 文件复制/链接与数据库写入使用可回滚流程，失败时不改变 target slot 当前版本；
- 复用源文件在读取前重新做路径边界、存在性和 SHA-256 校验；
- provider 调用账本必须证明复用和连续性修复路径的调用增量为 0；
- 归档、导出和项目删除流程必须把历史计划、复用链和所有仍被引用的素材文件纳入清单。

## 3. 统一实施顺序（含依赖与冲突管理）

| 阶段 | 内容 | 预计 | 依赖 | 风险 |
|---|---|---|---|---|
| **S0** | D1 假成功（两类）、D2 文案统一、C2 max_attempts、C3 预算口径（含 JOIN 洞）、E2 阈值统一、B1 步骤原子化、G0 前端题材修复（下拉动态化/错误码/文案/前缀表） | 2-3 天 | 无 | 低（行为不变或纯修复） |
| **S1** | G1 通用模板先立（multiBeatGroundedSequencePlan + pathRevealPlan + infer 双跑 + 5 测试文件改断言 + 转场时间轴可编辑 + 3 个题材无关回归） | 3-4 天 | S0 | 中（通用模板质量须不低于专用路径） |
| **S2** | G2 题材后破 + G3 命名迁移与三层兼容 + 泄漏守卫测试 | 1-2 天 | S1 验收通过 | 中（旧数据兼容面大） |
| **S3** | A1 proof 浏览器批复用、A2 bundle 缓存（资产清单 key）、C1 先自然化后门禁、E1 hash 语义修正 + F1 深色 matte（E1/F1 同批，都触碰 paper_asset_versions 落盘） | 3-5 天 | S2 | 中（A1 崩溃回退、C1 行为变化、E1 迁移） |
| **S4** | A3 concurrency、D3 死 API 清理、D4 轮询分档+getShot 门控、E3 fingerprint 索引、F2 模型 adapter、G4 词典外置 | 长期 | 无 | 中低 |
| **S5（下一阻断阶段）** | H1 不可变计划修订 + 停止删除旧 family/slot/node/motion/step + 存量完整性检查与回建 | 3-5 天 | 当前数据库备份、迁移 dry-run | 高（历史结构迁移，完成前禁止继续扩展复用） |
| **S6** | H2 分镜历史只读 API + 创作页/生产页历史入口 + 分页图片时间线 | 2-3 天 | S5 | 中低（只读展示，不改变当前采用状态） |
| **S7** | H3 视觉复用指纹 + 复用分级/审计 + H4 复用预览和差异报价 + 单槽位/批量零调用挂接 | 4-6 天 | S5、S6 | 高（直接影响费用范围，必须以 provider 调用账本验收） |
| **S8** | H5 当前 run 内连续性修复预览/应用 + 素材 diff + H6 并发、归档、导出与回滚保障 | 3-5 天 | S7 | 高（计划状态机变化，但不得触发图片调用） |

**2026-08-01 优先级修订**：S0-S3 和已完成的部分 S4 是历史交付记录；尚未执行的 F2/G4 以及新的 Paper Studio 功能扩展，优先级均低于 S5-S8。必须先消除计划重编译对历史关联的破坏，再实现历史界面、素材复用和连续性修复。

**冲突管理（两案合并的核心原因）**：
1. **巨鹿 fixture 是 S1/S2（题材）与 S3-C1（门禁顺序）共同的回归门**——C1 不得与 S2 同批合入，否则 fixture 挂掉无法归因；故 C1 排在 S2 之后。
2. **`paperAssetProductionService` 被三批改动触碰**：S0（B1 拆分 + C3 预算）、S2（G3 第 3 层 map_route 兼容）、S3（E1/F1 落盘）——严格按阶段顺序合入，每批全量回归。
3. `listActions`：D3 保留、G0 启用，S0 内闭环。
4. C3 与 B1 合并实现（失败只重跑失败 slot 需预算口径一致），同在 S0。
5. **H1 与现有 `persistPlan()` 是结构性冲突**：H1 完成前，不允许在重新分析路径上增加任何“先删后建”的临时补丁；迁移后的所有当前查询必须通过 `current_plan_revision_id` 限定。
6. **E3 与 H3 是两个不同指纹域**：E3 `request_fingerprint` 处理付费请求幂等，H3 `reuse_fingerprint` 处理跨版本视觉兼容；不得共用列、唯一索引或计算函数。
7. **B1 原子素材步骤必须支持历史复用来源**：S7 应通过统一的 slot source resolver 注入 `historical_reuse`，不能绕过技术门禁、人工审核状态和 job step 聚合。
8. **H5 连续性修复复用 C1 的 naturalized plan**：修复预览、门禁评估和最终冻结必须消费同一份自然化后 plan，防止预览显示零影响但冻结计划再次变化。

## 4. 统一测试策略

- **确定性不回归**（A1/A2/A3/C1 必须验证）：同一 snapshot 的 proof repeat 断言、preview/formal render_hash 一致性；后端 `node --test test/*.test.js` 全量、前端 `node --test test/*.test.js` + `npm run build`；
- **B1**：只对指定 slot/version 重跑 matte/register/gate，未指定行 `updated_at` 不变；聚合路径 plan_hash 不变；
- **C1**：构造"naturalize 后超速/超透明斜率"的 plan，断言 gate 在 snapshot 冻结前失败（此前会漏）；
- **C3**：制造 failed image_generation 行 + 回填前崩溃行，断言预算均计数并触发 `PAPER_STUDIO_IMAGE_BUDGET_EXHAUSTED`；
- **E1**：遍历版本行断言 路径↔hash 一致（新旧两套语义）；
- **F1**：深色背景 fixture 走 dark_v1/auto 成功，白底 fixture 走 white_v1 结果不变；
- **D1**：store 单测"noop 不弹 toast"、"attention_required 不弹已完成"；
- **G1**：3 个题材无关分镜全链路（mock provider）通过；巨鹿 fixture 走通用路径、质量指标不降低；
- **G2/G3**：泄漏守卫测试；构造含旧 action 名/旧蓝图 ID/旧 kind 的 motion plan/snapshot，断言三层兼容后校验通过、渲染正常；
- **回归样本**：巨鹿危城（360 帧/12 秒、两场景、两环境、18 帧转场、粮车 30 帧位移）在 S1、S2、S3-C1 每批后原样通过（断言按 §0 修正 5 改后的版本）。
- **H1 不可变历史**：同一 shot 连续持久化三个计划版本，断言旧 `plan/family/slot/node/motion/step/asset_version` 全部仍可查询，记录数不减少，当前指针只指向最新计划；迁移前后文件路径与哈希一致；
- **H2 历史 API**：构造三个脚本修订、两个生产版本、采用/淘汰/拒绝/失败图片，断言分镜历史分页完整、顺序稳定、归档状态明确且不会返回跨项目数据；
- **H3 复用指纹**：对白、声音、时长、字幕和纯转场变化不改变静态素材指纹；地点变化只改变环境指纹；主体 identity/state 变化只改变相关角色/道具槽位；视觉风格变化使所有风格相关槽位不兼容；
- **H4 差异报价**：原版本四张已批准图，纯时序修改后断言 `history_reuse_count = 4 / estimated_image_count = 0 / provider 调用增量 = 0`；只换地点时断言角色/道具复用、只报价背景；
- **H5 连续性修复**：修复前后 `run_id/shot_id` 不变，旧计划可见，未变化素材文件哈希不变，新增计划通过门禁，`image_generations.provider_call_count` 和 provider mock 调用数均不增加；
- **H6 安全失败**：源文件缺失、哈希错误、源图未批准、preview fingerprint 过期和 expected version 冲突时复用失败，target 当前素材不变，且绝不自动创建付费生成记录。

## 5. 统一验收标准

1. proof 20 target 浏览器启动 ≤ 4 次，proof 耗时下降 ≥ 30%（同 snapshot 对比）；
2. 同 snapshot 的 preview/formal 不再重复 bundle（命中资产清单 key 缓存）；
3. 四个素材 step 可单独调度执行，"全量生产"一键路径行为不变；
4. 门禁报告、冻结快照、渲染三方消费同一份（naturalize 后）plan，构造的越界样例在 gate 阶段失败；
5. `max_attempts` 单一来源；预算统计含 failed 且不依赖 version 回填；重复 fingerprint 不产生第二次 provider 调用（E3 生效后）；
6. 前端：两类假成功消除；run/shot/merge 文案单一来源；死 API 已清点处置；人工阻塞阶段轮询请求量下降 ≥ 70%；
7. `source_hash`/`source_local_path` 指向同一文件（新数据）；生产与上传 alpha 门禁同一阈值；
8. 深色背景素材可 matte（dark_v1/auto），白底结果与改动前一致；
9. `grep -rn "秦军|楚军|赵军|巨鹿|定陶|黄河|邯郸|粮车|粮袋|寒雾|王离|章邯|围城|沉船" backend-node/src frontweb/src`（**排除 `test/`、`docs/`、示例内容、词典/词汇表文件**——`LOCATION_WORDS` 的甬道/城墙/战场与 mobility contract 剥离后的残留通用词属有意保留）零命中；
10. 前端动作下拉无题材选项且数据来自后端 catalog；旧 snapshot 可播放、旧 run 可打开，无数据迁移；
11. 至少 2 个非战争题材分镜通过"分析 → 蓝图 → 素材 → 动作 → 门禁 → 预览"链路（mock provider）；
12. 后端/前端全部测试与构建通过，巨鹿危城 fixture（改后断言版）在每批后原样通过；
13. 每个分镜可以从创作页和生产页打开统一历史入口，查看全部脚本修订、生产版本、计划修订、素材槽位和图片版本；
14. 重新分析和重新编译后，旧计划结构与图片版本记录数量不能减少，历史文件仍可按版本访问；
15. 只修改对白、声音、时长、字幕或转场时，已批准静态素材全部显示为精确复用，图片 API 调用增量为 0；
16. 只更换背景合同时，角色和道具继续复用，费用报价只包含受影响的背景槽位；
17. 连续性修复在原 run/shot 内完成，应用前显示素材 diff 和调用数，应用后旧计划可查看且不新增图片调用；
18. 报价弹窗逐槽位显示当前素材、历史复用、实体库复用、本地派生和需要生成的来源，`estimated_image_count` 只等于最终差异槽位数量；
19. 所有复用都有来源、目标、兼容性报告和文件哈希审计；复用失败不会自动付费生成；
20. 已取消、失败、淘汰和 superseded 版本的图片仍可查看，但不满足批准/完整性/兼容性条件时禁止复用。

## 6. 风险与决策门

| 风险 | 应对 |
|---|---|
| 通用 `multiBeatGroundedSequencePlan` 质量低于题材专用模板 | 参数与节拍数自适应；G1 验收不过不得进 G2；必要时保留 `TEMPLATE_REGISTRY` 扩展点（按 `storyboard.theme_tags` 匹配，默认空） |
| 字幕锚定失去强关键词后转场定位退化 | G1 配套：蓝图编辑器转场时间轴可编辑（手动拖锚点） |
| 旧数据三层兼容遗漏导致门禁误判/渲染失败 | alias/映射表补全测试；`validatePlan` 对未知 action 直接 fail |
| C1 自然化后指标拦掉既有合格镜头 | 先全量回归；若仅巨鹿 fixture 受影响且属 arc 容差边界，微调 arc 幅值 0.012→0.010 并记录决策 |
| A1 浏览器复用引发 Target closed 回归 | 保守方案（批内复用+定期重启+单 target 局部重试）；激进方案先压测 |
| A2 资产清单 key 误命中/误失效 | key 只含"renderer 源码 + 本 shot 引用资产 hash 集"；命中后渲染结果 render_hash 校验兜底 |
| E1 hash 语义变更影响旧行复用 | raw_hash 空值回退旧语义；遍历校验测试兜底 |
| E3 唯一索引与存量重复冲突 | 索引仅对新数据生效；存量清理单独立项 |
| B1 拆分引入行为漂移 | 原子函数从原函数体机械抽取；聚合路径 plan_hash 断言 |
| C2 覆盖 step max_attempts 误改 exhausted 语义 | 只统一数值来源；`settleUnhandledFailure` 行为测试锁定 |
| C3 429 路径重复计数 | 实现时验证 `PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED` 不落 failed 行 |
| F1 自动模式误判白/深 | auto 仅在两侧方差接近时启用；默认按边缘亮度直方图；键色置信度兜底走人工 |
| S 阶段间 fixture 归因困难 | C1 不与 S2 同批；每批合入后单独全量回归 |
| H1 SQLite 唯一约束阻止同名 family/node 跨计划保存 | 用新表/重建表方式把唯一键升级为 `plan_revision_id + 业务 key`；迁移先 dry-run、备份和计数对账，失败整体回滚 |
| H1 存量图片版本失去槽位关系 | 迁移扫描失联关系，优先按现存 FK 恢复；必要时使用 image_generations 的 run/shot/slot/version/frame_type/generation_purpose 建立归档槽位，不删除无法自动归类的记录 |
| H3 指纹字段过少导致错误复用 | 自动复用只允许结构化合同精确匹配；环境合同从严；不确定项进入人工候选，不静默采用 |
| H3 指纹字段过多导致复用率过低 | 明确排除 run/revision/authorization/对白/声音/纯 timing 字段；以编译后的结构化视觉合同为准，不比较整段自由文本 |
| H4 复用预览后数据变化造成过期决定 | 预览 fingerprint 包含目标计划版本、候选 ID、文件哈希和兼容性报告；应用时全部重验 |
| H4 复用失败后误触发付费生成 | 复用与授权使用独立接口和状态；失败只返回人工阻断，不创建 authorization/image_generation |
| H5 连续性修复意外改变素材需求 | 应用前做 slot diff；只有零差异或全部 exact 复用时显示“零调用修复”，其余只保存计划并进入差异报价 |
| 历史数据和文件增长 | 历史只追加；列表游标分页；文件按内容哈希去重或安全硬链接；清理器只删除零引用文件并生成审计报告 |

## 7. 执行结果与新增待实施范围

### 7.1 历史交付结果（2026-07-31）

原“引擎质量 + 题材去耦”交付范围中，S0-S3 已落地；S4 中 A3、D3、D4、E3 已同步完成。F2 的外部 rembg/本地 ONNX adapter 与 G4 项目级词汇覆盖仍按正文定义保留为长期可选项，本次没有引入新的模型运行时或配置协议。

补充收尾项：

- 旧 action、蓝图 ID、procedural kind 与外观值统一走只读 alias；新生产只写通用命名，未知 action 直接失败。
- 已物理删除 compiler 中四个失效题材专用函数，新增生产源码题材泄漏守卫。
- Matte 增加默认 1px Alpha 边缘收缩与羽化，并保留可配置关闭/调整能力。
- bundle 缓存增加跨进程锁、临时目录和原子 rename；并发单测证明同 key 首次构建只执行一次。
- 旧库迁移自愈已覆盖新增账本列、索引和 `technical_asset_gate` 回填。

验证结果：

- 后端：276 项，274 通过，1 项默认跳过（真实 Remotion 集成），1 项因当前沙箱禁止监听 `127.0.0.1` 而失败；其余后端测试全部通过。
- 前端：27 项全部通过。
- `npm run build` 通过。
- 主动启用真实 Remotion 集成时，bundle 已成功产出，随后 Remotion 因沙箱无法取得本地端口而停止；该限制不属于业务代码失败。
- 20-target 实机耗时下降比例仍需在允许 Chrome/本地端口的桌面环境中压测；浏览器每 5 target/60 秒重启、局部崩溃重试和 bundle 命中逻辑已有自动测试覆盖。

以上测试数字是 2026-07-31 交付快照，只用于说明原范围的验证状态；后续新增测试会改变总数，不应继续把该数字写作整个统一方案的最终验收结果。

### 7.2 2026-08-01 增补范围状态

模块 H（S5-S8）已经完成业务代码、迁移实现、数据库副本 dry-run、历史/复用/连续性修复接口、前端统一历史抽屉和自动测试。正式数据库已于 2026-08-01 16:16（CST）完成 migration 44 并通过迁移后验收；模块 H 及本次批准范围已完成，F2/G4 仍按长期可选项保留。

当前实施结果：

1. S5：`paper_plan_revisions`、`current_plan_revision_id`、计划归属列和唯一约束重建已实现；`persistPlan()` 已改为只追加并 supersede。正式库迁移后为：27 shots、27 plan revisions、62 families、85 slots、108 asset versions、150 composition nodes、20 motion plans、98 job steps；孤儿关系、计划错挂和 job step 重复均为 0，SQLite integrity 为 `ok`。108 条图片版本原有字段摘要与迁移前一致，116 个文件引用全部存在。
2. S6：三个分镜历史只读 API、游标分页、生产版本展开、单图片审计详情，以及创作页/生产页共用的历史抽屉已经实现。
3. S7：独立 `reuse_fingerprint`、精确/人工/阻断分级、文件哈希复验、`paper_asset_reuse_links` 审计、复用预览、显式零调用挂接和只对差异槽位报价已经实现；复用失败不会创建授权或图片生成记录。
4. S8：当前 shot 的连续性修复预览/应用、计划修订克隆、未变化素材映射、素材 diff 与 provider 调用前后账本已经实现；调用增量不为 0 时会失败。

本轮验证结果：

- 后端全量：281 项，279 通过，1 项默认跳过，1 项仅因当前沙箱禁止监听 `127.0.0.1` 而失败；业务测试无失败；
- 新增历史与复用定向测试：连续持久化记录只增不减、跨脚本 revision 指纹复用、文件/哈希校验和 provider 调用增量 0 均通过；
- 前端：30 项全部通过；
- `npm run build` 通过；
- 归档往返测试通过，manifest 已包含计划修订、复用链及其仍被引用的素材文件。
- migration 44 正式执行与后端重启通过；迁移前后图片 provider 调用总数保持 9，调用增量为 0。

模块 H 的实施批准不等于允许直接调用图片 API。开发、迁移和自动测试必须使用现有文件、临时 fixture 或 mock provider；只有用户在产品界面审核最终差异报价并明确授权后，运行时才允许产生新的付费图片调用。

### 7.3 模块 H 执行决策门

- **S5 迁移评审（已批准并执行）**：表结构、唯一约束重建、存量计数对账、回滚和重复执行 dry-run 均已通过；正式 migration 44 已完成。
- **S6 只读历史评审**：确认全部历史类型、分页响应和权限边界；不得修改当前采用状态。
- **S7 复用规则评审**：用“纯时序修改 / 只换背景 / 只换主体 / 换风格”四类样例展示指纹差异和费用结果；未批准不得启用自动精确复用。
- **S8 连续性修复评审**：每种修复必须提交素材 diff 和 provider 调用账本；调用增量不为 0 的操作不能标记为“零调用修复”。
