# 纸片工作室题材硬编码去除方案（Theme De-coupling Plan）

> **⚠️ 已合并**：本方案已与引擎质量方案合并为《2026-07-31-paper-studio-unified-plan.md》，并吸收代码评审修正（GROUND_VEHICLE_PATTERN 机制保留、templateCatalog 第二套地图、三层兼容、5 个测试文件改断言等 6 处）。执行以统一方案为准，本文档保留作历史参考。

> 日期：2026-07-31
> 范围：paper-studio 后端服务、paper-studio-renderer、frontweb 工作台
> 目标：把"巨鹿危城/沉船断路"等测试题材从生产协议中彻底剥离，恢复"通用语义原语 → 通用模板"的产品原则

## 1. 背景与原则冲突

v3 技术设计（`docs/technical/2026-07-24-paper-studio-v3-technical-design.md`）明确要求：

- "生产协议中没有船、水面或其他测试剧情专用分支"
- "任意分镜统一经过语义合同 → 通用关系/动作原语 → 素材生产 → 组合与动作 → proof → 预览 → 正式渲染"
- "'沉船断路'只证明通用原语能组合出船体下沉、水面遮挡和人物状态变化；该 fixture 通过不代表任意分镜完成"

但当前实现中，题材判定正则与题材专用蓝图/动作计划**进入了生产主链路**（`infer() → compile()` 分发），且部分题材选项出现在用户可选的 UI 中。这与上述原则直接冲突，并导致：

- 非战争题材（都市/奇幻/现代生活）无法命中 `siege_supply_sequence` / `map_route_reveal`，只能退回通用主体动作，质量降级；
- 换一个题材就需要改代码，不可持续；
- 题材词泄漏进 UI 文案、错误消息、资产标签和状态命名，用户可见。

## 2. 硬编码完整清单

### A 类：题材判定正则进入生产协议（最严重，P1）

| # | 位置 | 内容 | 问题 |
|---|---|---|---|
| A1 | `paperBlueprintCompilerService.js:21` `MAP_ROUTE_PATTERN` | `战役地图\|战略地图\|地图上\|地图展开\|黑色箭头\|...包围\|围城...战线...推进` | "战役地图"是题材，"黑色箭头/包围圈"是战役地图特有视觉，普通地图（藏宝图/旅游图/线路图）无法命中 |
| A2 | `paperBlueprintCompilerService.js:22` `SIEGE_SUPPLY_PATTERN` | `粮袋\|粮尽\|缺粮 … 粮车\|运粮\|甬道\|补给 … 包围\|军阵\|城墙\|围城` | 整个"巨鹿危城"题材的判定正则，不是通用能力 |
| A3 | `paperBlueprintCompilerService.js:23` `GROUND_VEHICLE_PATTERN` | `粮车\|马车\|战车\|车辆\|车队\|辎重车\|运输车` | 半通用（车辆概念），"粮车"为题材词；可保留但需去题材化 |
| A4 | `paperStudioAnalyzerService.js:20` `SUPPORTED_BOUNDARY_TRANSITION_PATTERN` | `沉没\|下沉\|没入\|沉入\|浸没\|坠入\|跌入\|塌入\|陷入\|越过\|穿过\|跨过...边界` | "沉船断路"fixture 的启发式；动词本身通用，但进入 legacy 分镜的生产协议分发 |

### B 类：题材专用蓝图/动作计划函数（最严重，P1）

| # | 位置 | 内容 | 问题 |
|---|---|---|---|
| B1 | `paperBlueprintCompilerService.js:175-260` `siegeSupplyBlueprint()` | 固定实体 `supply_bag`/`supply_cart`/`siege_line`，默认名"空粮袋/秦军粮车/逼近城墙的秦军阵线"，场景文案"巨鹿城内/巨鹿城外秦军甬道"，关键点 `bag_contact`/`cart_lane`/`siege_depth` | 整段是"巨鹿危城"专用蓝图 |
| B2 | `paperBlueprintCompilerService.js:264-318` `mapRouteBlueprint()` | 固定 `strategic_route` 实体、`encirclement`（"巨鹿包围圈"）关键点 | 战役地图专用 |
| B3 | `paperBlueprintCompilerService.js:593-800` `mapRoutePlan()` | 字幕锚定正则 `渡河北上\|北上攻赵`、`退入巨鹿\|巨鹿城外`、`围死\|围城\|团团包围`、`输送粮草\|甬道`；`MAP_PLACE_LAYOUTS`（定陶/黄河/邯郸/巨鹿坐标，L25-28） | 战役叙事专用 |
| B4 | `paperBlueprintCompilerService.js:804-940` `siegeSupplyPlan()` | 字幕正则 `兵少粮尽`、`城池一旦陷落`、`秦军补给`；阶段"秦军阵线收紧"；`appearance: 'qin-silhouette'`（L890）；proof targets `supply_bag_fall`/`supply_cart_lane`/`siege_line_final` | 秦末战争叙事专用 |
| B5 | `paperBlueprintCompilerService.js:810` | 错误码 `PAPER_STUDIO_SIEGE_SEQUENCE_ENTITY_MISSING`，消息"巨鹿危城多阶段镜头缺少粮袋、粮车或军阵实体" | 题材进入错误协议 |
| B6 | `paperBlueprintCompilerService.js:1284-1286` | `compile()` 分发 `siege_supply_sequence` → `siegeSupplyPlan`、`map_route_reveal` → `mapRoutePlan` | 题材分支在主链路 |
| B7 | `paperStudioAnalyzerService.js:338` | legacy 分镜分发 `SUPPORTED_BOUNDARY_TRANSITION_PATTERN → supportedBoundaryTransitionPlan` | fixture 正则进入 legacy 生产协议 |

### C 类：题材化能力命名（catalog / procedural kind，P2）

| # | 位置 | 内容 | 问题 |
|---|---|---|---|
| C1 | `paperActionCatalogService.js:19` | `siege_supply_sequence`（family 已是通用 `multi-beat-grounded-sequence`，名称却是题材） | 能力名与题材耦合 |
| C2 | `paperActionCatalogService.js:17` | `map_route_reveal`（family `information-reveal`） | 战役限定命名，应为通用"路径揭示" |
| C3 | `ProceduralLayer.jsx:184,187,190,193` | kind：`route-reveal` / `map-title-card` / `ember-field` / `army-formation` | 战争/地图特效语义；`army-formation`、`ember-field` 为战场专用 |
| C4 | `paperBlueprintCompilerService.js:890` | `appearance: 'qin-silhouette'` | 直接写死秦军剪影 |
| C5 | `paperAssetProductionService.js`（`promptForSlot` stateDirections） | `map_marker` 等地图状态词 | 战役地图状态混入通用状态表（部分已在 `paperAssetLabels.js:10` 显示为"地图人物剪影"） |

### D 类：前端 UI 文案与校验（P0，用户可见）

| # | 位置 | 内容 | 问题 |
|---|---|---|---|
| D1 | `PaperBlueprintEditor.vue:94-95` | 主动作下拉："战役地图推进"、"缺粮·运粮·围城多阶段" | 题材作为可选动作暴露给用户；且下拉硬编码，未从后端 catalog 拉取 |
| D2 | `PaperBlueprintEditor.vue:403` | 校验消息"粮车、车辆等大型接地道具不能设置为手持关系" | 消息具体到粮车 |
| D3 | `PaperBlueprintEditor.vue:427` | `name.replace(/^(?:秦军|楚军|赵军|军用|一辆|一队)/, '')` | 题材前缀剥离（与后端 A 类 L78 重复，双份维护） |
| D4 | `paperStudioProduction.js:37,40` | "确认只生成干净环境底板，寒雾和空气流动由本地程序动画完成。"/"生成寒雾漂移、空气流动和轻微运镜" | 环境镜头文案写死"寒雾"（来自漳河寒雾 fixture） |

### E 类：半通用词表（P3 配置化，不删除）

| # | 位置 | 内容 | 处理 |
|---|---|---|---|
| E1 | `paperVisualSceneCompilerService.js:4-7` `LOCATION_WORDS` | 城内/城外/营帐/军营/战场/甬道/街道/巷道/宫殿/仓廒/城墙… | 机制本身通用，战争地点词偏多；扩充通用地点词（小区/商场/办公室/教室/医院/车站/公园/街道…）并外置为词典 |
| E2 | `paperStudioAnalyzerService.js:36,47-55` | `inferredActorIdentity`/`inferredActorGroupSize` 群组词：士卒/士兵/将士/操作员/参与者/众人/百姓/随从/侍卫 | 军事倾向 + 现代词混杂；整理为通用群组词典（人群/众人/队伍/一行人/围观群众/同伴/随行人员…） |
| E3 | `paperBlueprintCompilerService.js:672-679` `characterLayouts` | 4 个固定排布 | 可保留为"默认排布回退"，非题材，标注即可 |
| E4 | `paperEntityExtractionService.js:47` | LLM prompt 历史考据示例"秦军黑衣玄甲、札甲形制，楚军尚赤" | 作为历史题材示例可保留，但改为参数化/举例通用化 |
| E5 | 测试 fixture | `巨鹿危城`/`沉船断路`/`漳河寒雾`/`秦军的绞索`（`test/*.test.js` 十余处） | **保留**：作为固定回归样本验证"通用能力组合"，但需保证生产协议无题材分支（见 §5 测试策略） |
| E6 | `paperExampleDraftService.js` EXAMPLE_STORYBOARDS | 收到来信/穿过街巷/发现线索 | 本身是通用现代题材示例，保留 |

## 3. 去除方案（分层实施）

### P0：立即安全修复（不动协议，1 天内）

1. **前端主动作下拉去硬编码**：`PaperBlueprintEditor.vue:88-95` 的 `<option>` 列表改为从后端 `GET /api/paper-studio/actions`（`paperActionCatalogService.list()` 已有）动态拉取；同时移除 `siege_supply_sequence`、`map_route_reveal` 两个题材项的展示（在 catalog 中标记 `user_selectable: false`）。
2. **错误消息通用化**：`PAPER_STUDIO_SIEGE_SEQUENCE_ENTITY_MISSING` 改为通用码 `PAPER_STUDIO_GROUNDED_SEQUENCE_ENTITY_MISSING`，消息"多阶段接地序列缺少必要的接地主体或场景主体"（错误码变更需在 route 层做兼容映射或直接全量替换，本仓库错误码无外部依赖，直接替换）。
3. **UI 文案通用化**：
   - `PaperBlueprintEditor.vue:403` → "大型接地道具（车辆、推车、大型器物等）不能设置为手持关系"
   - `paperStudioProduction.js:37,40` → "环境氛围漂移、空气流动由本地程序动画完成" / "生成环境氛围漂移、轻微空气流动和运镜"
4. **前缀剥离表合并**：`PaperBlueprintEditor.vue:427` 与 `paperBlueprintCompilerService.js:78` 的 `^(?:秦军|楚军|赵军|军用|一辆|一队)` 收敛为单一常量（后端一份，前端注释指向后端），表内容改为通用量词/冠词剥离 `^(?:一辆|一队|一箱|一捆|一名|一位)`（保留通用部分，删题材部分）。
5. **D 类其余文案清理**：`paperAssetLabels.js` 的 `map_marker: '地图人物剪影'` 保留（是状态语义不是题材），但注释标明来源。

### P1：题材分支退役（核心，2-4 天）

6. **`infer()` 移除题材正则分发**（`paperBlueprintCompilerService.js:327-328`）：
   - 删除 `MAP_ROUTE_PATTERN`、`SIEGE_SUPPLY_PATTERN` 两条分发；
   - 删除 `siegeSupplyBlueprint()`、`mapRouteBlueprint()`、`siegeSupplyPlan()`、`mapRoutePlan()` 四个函数（连同 `MAP_PLACE_LAYOUTS`、字幕锚定正则、`qin-silhouette`）；
   - `compile()` 分发表（L1284-1286）只保留通用 action：`directed_move`、`state_transition`、`generic_subject_action`、`carry_move_sit`（或重命名）、`environmental_depth_motion`。
7. **替代能力一：通用多节拍接地序列**（新 `multiBeatGroundedSequencePlan`，数据驱动）：
   - 从 storyboard 上下文提取全部接地主体（`role: ground_prop` / `ground_vehicle` 的道具、`grounded` 角色）；
   - 按文本时序（关键词锚定：掉落/落地/前行/驶入/逼近/合拢 + 主体名）分配节拍，实体/场景/轨道/转场全部来自上下文，不预设 `supply_bag/supply_cart/siege_line`；
   - 该模板即原 `siegeSupplyPlan` 的通用化版本（三节拍：落地沉降 → 主体长距离驶入 → 人群/阵线逼近），节拍数自适应 2-4 个。
8. **替代能力二：通用路径揭示**（`pathRevealPlan`，信息揭示）：
   - 保留"地图/平面图 + 路径逐步延伸"的视觉机制，移除战役限定（围城圈、军阵符号），改为通用：路线/路径/管道/流程线逐步揭示；
   - `MAP_PLACE_LAYOUTS` 删除，关键点改为按上下文实体生成（`map_marker` 状态保留，作为通用标记）。
9. **legacy 分发**（`paperStudioAnalyzerService.js:338`）：`SUPPORTED_BOUNDARY_TRANSITION_PATTERN` 保留为动词启发式（沉没/坠入/越过边界是通用动词），但移除"沉船"语义关联，错误消息与契约描述不再出现船/水特定词（现有代码已是"液体表面边界"的通用描述，仅需确认契约文本无题材词）。

### P2：能力命名抽象化（含持久化兼容，与 P1 合并或延后 1-2 天）

10. **动作 catalog 重命名 + alias 映射**（`paperActionCatalogService.js`）：
    - `siege_supply_sequence` → `multi_beat_grounded_sequence`
    - `map_route_reveal` → `path_reveal`（或 `overlay_reveal`）
    - 新增 `ACTION_ALIASES = { siege_supply_sequence: 'multi_beat_grounded_sequence', map_route_reveal: 'path_reveal' }`；
    - 读取旧数据（`paper_motion_plans.plan_json` / snapshot）时经 alias 归一化后校验；**新生产只写新名**；旧 snapshot 继续按原值播放（校验时走 alias）。
11. **procedural kind 重命名 + renderer 兼容映射**（`ProceduralLayer.jsx`）：
    - `route-reveal` → `path-reveal`；`map-title-card` → `label-card`；`army-formation` → `crowd-formation`（人群阵型，战争/集会/游行通用）；`ember-field` → `ember-drift`（余烬/萤火/火星通用，可选保留原值）；
    - renderer 内置 `KIND_ALIASES` 映射表，旧 snapshot 的旧 kind 仍渲染对应实现；
    - `appearance: 'qin-silhouette'` 删除，剪影外观由 prompt 或默认剪影生成。
12. **语义合同/快照 schema 版本说明**：本次不升 schema 大版本，alias 兼容即可；如新增 `visual_beats` 语义字段再随 v10 planner 升版本。

### P3：词典外置与项目配置化（长期，可选）

13. 新建 `backend-node/src/services/paper-studio/paperThemeVocabulary.js` 集中承载：`LOCATION_WORDS`（扩充通用地点词）、群组词、`stateDirections`、默认关键点命名；导出常量供 compiler/analyzer/visualSceneCompiler 引用。
14. `paper_studio_projects.config_json` 支持 `vocabulary_overrides`：项目级注入自定义地点词/群组词/锚定词，满足特定题材项目（如修仙、科幻）的识别需求，**不改产品代码**。
15. 前端 `paperStudioProduction.js`/`paperAssetLabels.js` 文案引用后端词汇表导出的常量（通过现有 API 透传，或前端独立词典并注明与后端同步）。

## 4. 兼容策略

| 对象 | 策略 |
|---|---|
| 旧 snapshot（v8/v9 已冻结） | 继续播放：`KIND_ALIASES` + `ACTION_ALIASES` 只读归一化，不修改快照文件 |
| 旧 run/蓝图中已保存的 `siege_supply_sequence` | 读取时经 alias 归一化展示为新名；编辑后落库为新名 |
| 前端动作下拉 | 动态拉取 catalog，题材项 `user_selectable: false`（旧 run 打开时仍显示其动作但禁用切换） |
| 测试 fixture | 全部保留；巨鹿危城改为"通过通用能力组合出两场景/两环境/转场/粮车长位移"的回归断言（断言不变，入口从专用函数改为通用模板） |

## 5. 测试策略

1. **新增题材无关回归**（必须）：
   - 现代都市分镜（"外卖员骑车穿过街道，停在公寓楼下"）→ 走 `directed_move`/`multi_beat_grounded_sequence`，断言产物无题材词；
   - 奇幻分镜（"巨龙掠过山谷，落在岩台上"）→ 走通用路径，`supported_boundary_transition` 或 `directed_move`；
   - 现代地图分镜（"物流地图上，包裹路线从仓库延伸到门店"）→ 走 `path_reveal`，断言无"围城/军阵"。
2. **泄漏守卫测试**：扫描 compiler/analyzer/template 输出（prompt、蓝图、plan、错误消息）断言不匹配 `秦军|巨鹿|定陶|黄河|邯郸|粮车|粮袋|寒雾|王离|章邯|甬道|围城|破釜`（测试文件与示例内容除外）。
3. **巨鹿 fixture 保留**：现有 `paperSceneContinuity.test.js:130`（两场景/两环境/18 帧转场/粮车 30 帧位移）继续通过——但走通用模板路径。
4. **兼容测试**：构造含旧 action 名的 motion plan/snapshot，断言 alias 归一化后校验通过、渲染正常。
5. 完整回归：后端 `node --test test/*.test.js`、前端 `node --test test/*.test.js`、`npm run build`。

## 6. 验收标准

1. `grep -rn "秦军\|楚军\|赵军\|巨鹿\|定陶\|黄河\|邯郸\|粮车\|粮袋\|寒雾\|王离\|章邯\|甬道\|围城\|沉船" backend-node/src frontweb/src`（排除 `test/`、`docs/`、示例内容）**零命中**；
2. 前端动作下拉无题材选项，且数据来自后端 catalog；
3. 巨鹿危城固定样例（360 帧/12 秒、两场景、两环境、18 帧转场、粮车长位移）仍通过，但路径为通用模板；
4. 至少 2 个非战争题材分镜通过"分析 → 蓝图 → 素材 → 动作 → 门禁 → 预览"链路（mock provider）；
5. 旧 snapshot 可播放，旧 run 可打开，无数据迁移；
6. 后端/前端全部测试与构建通过。

## 7. 为什么会有硬编码，删除是否导致功能退化

### 7.1 成因：未完成的抽象（不是失误）

题材硬编码是垂直切片开发策略的中间产物被冻结成了最终产品：

1. **能力验证优先**：v3 文档要求"Phase 1 必须用同一个沉船 snapshot 集成"、"沉船只是第一条 regression fixture"——先用一个具体题材打通全链路，验证门禁/转场/接地/证明等机制。`siegeSupplyPlan` 本质是"多节拍接地序列"能力的**验证实现**，粮车/粮袋只是让规则可匹配的封闭词表。
2. **规则优先的无奈**：中文剧本没有结构化输入，LLM 规划不可靠时，题材词（"秦军补给"）是最强的时序锚点，正则最便宜可靠。
3. **缺失的收尾步骤**：文档写了"沉船只证明通用原语能组合"，但没人执行"从专用到通用"的抽象（抽象难、测试贵、当时不紧急），于是题材实例泄漏进生产协议。

**结论：硬编码的三层结构**——题材实例（数据，可删）→ 通用模板（机制，保留参数化）→ 语义原语（能力，永不删）。当前代码把三层写在一起，所以看起来"删了就不工作"；实际只有最外层数据需要删除，机制层保留并参数化。

### 7.2 逐项删除影响评估

| 处置 | 硬编码项 | 删除后果 | 必要配套 |
|---|---|---|---|
| **安全删**（纯数据，不影响机制） | 前缀剥离表"秦军/楚军/赵军"、错误码文案、UI 文案（"粮车不能手持"/"寒雾"）、`qin-silhouette` 外观、`MAP_PLACE_LAYOUTS` 地名坐标 | 无机制影响；地图地名退化为按文本顺序均匀布局（可接受） | 无 |
| **带替换删**（删了机制退化，必须同步上替代） | `SIEGE_SUPPLY_PATTERN` 分发 | **最大功能损失**：巨鹿类分镜退化为 `directed_move`（单主体单节拍），粮袋落地+粮车驶入+军阵逼近的多主体多节拍编排丢失 | 通用 `multiBeatGroundedSequencePlan`（节拍数自适应 2-4，主体从上下文提取） |
| | 字幕锚定词"兵少粮尽/秦军补给" | 转场/节拍的时序定位退化（关键词改为"实体名+动作动词"匹配，置信度下降） | 蓝图编辑器转场时间轴改为可编辑（手动拖锚点） |
| | `MAP_ROUTE_PATTERN` 分发 | 地图镜头退化为 generic 单主体动作，路径揭示能力丢失 | 通用 `pathRevealPlan`（任意平面图/线路图） |
| | `SUPPORTED_BOUNDARY_TRANSITION_PATTERN`（legacy） | legacy 沉船类分镜退化为 generic | 保留动词启发式（沉没/坠入/越过边界本就是通用动词），仅去题材化契约文本 |
| **命名迁移**（功能不变，需兼容层） | catalog key `siege_supply_sequence`/`map_route_reveal`、procedural kind `route-reveal`/`map-title-card`/`army-formation`/`ember-field` | 旧 snapshot/旧 run 校验与渲染会找不到条目 | `ACTION_ALIASES` + `KIND_ALIASES` 只读归一化 |

### 7.3 通用化的正确性验收（先立后破）

为避免"删了题材模板但通用模板没接住"，P1 必须分两步走：

1. **先立**：实现 `multiBeatGroundedSequencePlan` / `pathRevealPlan`，并在不删除专用函数的情况下，让巨鹿危城 fixture **改走通用路径**，断言全部通过且关键质量指标与现状一致（360 帧/12 秒、两场景、两环境、18 帧转场、粮车 30 帧位移、节拍错峰）。
2. **后破**：通用路径通过后，才删除专用函数与题材正则。

**验收原则：同一分镜在通用路径下的输出质量不得低于专用路径，回归断言不放宽。** 如果通用模板做不到，说明抽象未完成，不得交付。

### 7.4 演进方向（长期）

- **规则 + LLM 双通道**：实体/节拍提取交给受限 LLM（已有规划器增强的雏形），规则词表降级为兜底，门禁负责校验——这是通用化的最终解，但成本高，不作为本次范围。
- **模板注册扩展点** `TEMPLATE_REGISTRY`：允许特定题材项目注册自己的模板（按 storyboard 的 `theme_tags` 匹配，默认空），题材模板以插件形式存在，不污染产品核心。
- **UI 兜底**：蓝图编辑器已支持实体增删/动作改选/关键点编辑，配合转场时间轴可编辑后，规则未命中的镜头全部可人工修正，不阻塞生产。

## 8. 风险与决策门

| 风险 | 应对 |
|---|---|
| 通用 `multiBeatGroundedSequencePlan` 质量低于题材专用模板 | 参数与节拍数自适应；巨鹿 fixture 断言不放宽；必要时保留"题材模板注册"扩展点（`TEMPLATE_REGISTRY`，按 `storyboard.theme_tags` 匹配，默认空） |
| 旧数据 alias 遗漏导致门禁误判 | alias 表补全测试覆盖；`validatePlan` 对未知 action 直接 fail（不静默通过） |
| 字幕锚定失去"兵少粮尽"等强关键词后转场定位退化 | 蓝图编辑器转场时间轴从只读改为可编辑（用户手动拖转场锚点），作为 P1 的配套交付 |
| 前端下拉动态化影响旧 run 编辑 | 旧 run 的动作值经 alias 归一化后仍在选项中，仅不可新增题材动作 |
