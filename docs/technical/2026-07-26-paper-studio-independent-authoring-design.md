# LocalMiniDrama 纸片动画工作室完全独立化改造方案

> 文档状态：核心链路已实施并完成真实页面验收
> 日期：2026-07-26
> 适用项目：LocalMiniDrama
> 前置方案：`2026-07-24-paper-studio-v3-technical-design.md`
> 核心目标：纸片动画工作室能够在不创建、不读取旧工作台分集与分镜的情况下，从空白纸片分镜完成生图、动作、预览、发布和整集合并。

## 1. 结论

当前 Paper Studio v3 已经拥有独立入口、独立生产状态、版本化素材、动作规划、动态门禁、同 snapshot 预览/正式渲染和整集合并能力，但创作源仍绑定旧 `episodes/storyboards`：

- `paper_studio_runs.episode_id` 必填；
- `paper_studio_shots.storyboard_id` 必填；
- 创建生产版本必须传 `storyboard_ids`；
- 发布正式视频会直接更新 `storyboards.video_url`。

因此当前只实现了“生产链独立”，没有实现“创作数据独立”。本次改造采用：

```text
独立纸片创作层
  + 复用现有 Paper Studio 生产引擎
  + 复用图片 API / 存储 / Remotion / video_generations
  + 旧工作台仅作为可选单向导入与显式同步目标
```

不重写已经跑通的素材 family、Alpha、动作、proof、snapshot 和 renderer。

## 2. 完成定义

以下流程不得访问旧工作台分集或分镜接口：

```mermaid
flowchart LR
  P["纸片项目"] --> E["新建纸片分集"]
  E --> S["新增纸片分镜"]
  S --> R["生成或上传参考图"]
  R --> A["分析素材需求"]
  A --> G["生成背景/角色/道具/Mask"]
  G --> M["动作规划"]
  M --> Q["动态门禁"]
  Q --> V["预览批准"]
  V --> F["正式发布"]
  F --> X["纸片分集合并"]
```

旧工作台数据只允许：

1. 用户主动点击“导入旧分镜”后复制进纸片数据模型；
2. 用户主动点击“同步到旧工作台”后写回指定旧分镜；
3. 历史 Run 继续保留旧数据来源审计字段。

## 3. 架构边界

### 3.1 独立部分

- 纸片分集；
- 纸片分镜；
- 分镜修订版；
- 分镜参考图；
- 分镜排序、复制和删除；
- 纸片分镜正式视频归属；
- 纸片分集合并；
- 正常创作与生产 API；
- Paper Studio 工作台 UI。

### 3.2 继续共享的基础设施

- `dramas` 作为产品项目容器；
- AI 配置与图片 provider；
- `imageClient.callImageApi()`；
- `image_generations`；
- `video_generations`；
- 本地 storage；
- Remotion renderer；
- 现有素材处理、动作、proof、snapshot 和正式渲染服务。

共享基础设施不等于共享旧工作台创作数据。

## 4. 数据模型

### 4.1 `paper_studio_episodes`

```sql
id                INTEGER PRIMARY KEY
project_id        INTEGER NOT NULL
episode_number    INTEGER NOT NULL
title             TEXT NOT NULL
description       TEXT NOT NULL DEFAULT ''
aspect_ratio      TEXT NOT NULL DEFAULT '16:9'
fps               INTEGER NOT NULL DEFAULT 30
default_duration  REAL NOT NULL DEFAULT 6
status            TEXT NOT NULL DEFAULT 'draft'
version           INTEGER NOT NULL DEFAULT 1
created_at        TEXT NOT NULL
updated_at        TEXT NOT NULL
deleted_at        TEXT
```

唯一键：`(project_id, episode_number)`。

### 4.2 `paper_storyboards`

```sql
id                              INTEGER PRIMARY KEY
paper_episode_id                INTEGER NOT NULL
shot_number                     INTEGER NOT NULL
title                           TEXT NOT NULL
description                     TEXT NOT NULL DEFAULT ''
action                          TEXT NOT NULL DEFAULT ''
dialogue                        TEXT NOT NULL DEFAULT ''
narration                       TEXT NOT NULL DEFAULT ''
duration                        REAL NOT NULL DEFAULT 6
shot_type                       TEXT
camera_motion                   TEXT
visual_prompt                   TEXT NOT NULL DEFAULT ''
negative_prompt                 TEXT NOT NULL DEFAULT ''
status                          TEXT NOT NULL DEFAULT 'draft'
current_revision_id             INTEGER
reference_image_generation_id   INTEGER
reference_image_url             TEXT
reference_local_path            TEXT
published_video_generation_id   INTEGER
legacy_storyboard_id            INTEGER
source_kind                     TEXT NOT NULL DEFAULT 'paper'
version                         INTEGER NOT NULL DEFAULT 1
created_at                      TEXT NOT NULL
updated_at                      TEXT NOT NULL
deleted_at                      TEXT
```

唯一键：`(paper_episode_id, shot_number)`。

### 4.3 `paper_storyboard_revisions`

```sql
id                    INTEGER PRIMARY KEY
paper_storyboard_id   INTEGER NOT NULL
revision_number       INTEGER NOT NULL
content_json          TEXT NOT NULL
content_hash          TEXT NOT NULL
created_from          TEXT NOT NULL
created_at            TEXT NOT NULL
```

修订版不可修改。生产 Run 只绑定 revision，不直接读取可编辑分镜。

### 4.4 `paper_studio_runs`

新结构：

```text
paper_episode_id     新生产版本必填
legacy_episode_id    历史兼容，可空
episode_id           迁移后仅作历史兼容，不再作为新 Run 真相源
selection_json       保存 paper_storyboard_revision_ids
```

### 4.5 `paper_studio_shots`

新结构：

```text
paper_storyboard_id           新生产镜头必填
paper_storyboard_revision_id  新生产镜头必填
legacy_storyboard_id          历史审计，可空
storyboard_id                 迁移后仅兼容历史 Run
source_kind                   paper | legacy_import
```

生产服务读取统一的 `shot.source_storyboard`，不在各服务中散布 legacy/paper 分支。

## 5. 修订与生产规则

1. 新建和编辑纸片分镜只更新 `paper_storyboards`；
2. 每次开始生产前自动生成或复用内容 hash 相同的 revision；
3. Run 的 `source_revision_hash` 由纸片分镜 revision、视觉风格、provider、档位共同计算；
4. 已冻结 Run 永远不读取后来修改的分镜；
5. 修改分镜后，旧 Run 标记为历史版本，但其素材和视频保持可播放；
6. 新建 Run 可以复用内容 hash 与 provider 签名一致的已接受素材；
7. 发布默认写入 `paper_storyboards.published_video_generation_id`；
8. 只有显式同步才更新旧 `storyboards.video_url`。

## 6. API

### 6.1 纸片分集

```text
GET    /paper-studio/projects/:projectId/episodes
POST   /paper-studio/projects/:projectId/episodes
GET    /paper-studio/episodes/:episodeId
PUT    /paper-studio/episodes/:episodeId
DELETE /paper-studio/episodes/:episodeId
```

### 6.2 纸片分镜

```text
GET    /paper-studio/episodes/:episodeId/storyboards
POST   /paper-studio/episodes/:episodeId/storyboards
GET    /paper-studio/storyboards/:storyboardId
PUT    /paper-studio/storyboards/:storyboardId
DELETE /paper-studio/storyboards/:storyboardId
POST   /paper-studio/storyboards/:storyboardId/duplicate
POST   /paper-studio/episodes/:episodeId/storyboards/reorder
```

所有修改接口使用 `expected_version`，删除使用软删除，重新排序在事务内完成。

### 6.3 参考图

```text
POST /paper-studio/storyboards/:id/reference/generate
POST /paper-studio/storyboards/:id/reference/upload
POST /paper-studio/storyboards/:id/reference/select
```

生成参考图显式调用图片 API，使用 `generation_kind=paper_studio`、`generation_purpose=paper_shot_reference`，不进入 Codex 图片队列。

### 6.4 导入与同步

```text
POST /paper-studio/episodes/:id/import-legacy
POST /paper-studio/storyboards/:id/sync-to-legacy
```

导入是复制，不保留运行时引用；同步必须指定目标并二次确认。

### 6.5 生产与合并

```text
POST /paper-studio/runs
  paper_episode_id
  paper_storyboard_ids
  quality_tier
  image_provider_config_id

POST /paper-studio/episodes/:id/merge
GET  /paper-studio/episodes/:id/merges
```

现有镜头分析、生成素材、动作、proof、preview、render、publish API 继续复用。

## 7. 图片生产体验

### 7.1 参考图

纸片分镜编辑区提供：

- 生成分镜参考图；
- 上传参考图；
- 选择历史候选；
- 重新生成。

参考图只提供构图、色调和主体位置，不直接成为带主体的正式背景。

### 7.2 正式素材

镜头分析后展示明确槽位：

- 干净背景；
- 角色/主体状态；
- 道具；
- 前景遮挡；
- 边界 Mask；
- 程序效果。

全局操作：

- 生成全部缺失素材；
- 只生成必需素材；
- 重试失败素材。

单槽位操作：

- 生成；
- 重新生成；
- 上传替换；
- 选择候选；
- 重新抠图；
- 批准；
- 退回。

每次付费调用前展示 provider、模型、数量和剩余预算。

## 8. 前端工作台

### 8.1 视觉命题

黑色制作台、暖金纸张强调、分镜图作为主视觉锚点；保持当前 Paper Studio 气质，不引入通用后台卡片墙。

### 8.2 内容结构

```text
左侧：纸片分集 / 纸片分镜 / 新增分镜
中间：分镜脚本 / 参考图 / 素材 / 动作 / 预览
右侧：provider / 预算 / 状态 / 下一步主操作
底部或抽屉：生产版本历史
```

版本不再是工作台主入口。用户首先操作分镜，Run 作为不可变生产历史存在。

### 8.3 主操作

顶部镜头带固定提供：

```text
+ 新增分镜
导入旧分镜
```

空项目首屏只保留一个主任务：“创建第一条纸片分镜”。

### 8.4 交互命题

- 新增分镜在镜头带尾部展开，不跳回旧工作台；
- 素材生成与审核局部更新，主预览不重建；
- 分镜切换使用快速淡入与共享布局，轮询不丢失编辑内容；
- 删除、同步、覆盖发布使用明确确认；
- 所有 AI/图片 API 调用必须由用户点击触发。

## 9. 历史迁移

1. 为每个现有 Paper Studio 项目创建纸片分集；
2. 将历史 Run 使用的旧 storyboard 复制为纸片 storyboard；
3. 创建内容 revision；
4. 将历史 `paper_studio_shots` 关联到纸片 storyboard/revision；
5. 保留旧 storyboard id 作为 `legacy_storyboard_id`；
6. 已发布 video generation 和 snapshot 不变；
7. Run 4 显示为“旧分镜导入的历史生产版本”；
8. 迁移可重复执行且不得复制第二份数据。

严禁通过“新建纸片分镜时偷偷创建旧 storyboard”伪造独立性。

## 10. 实施阶段

### P0：冻结合同

- 新 schema 与 API 测试；
- 记录历史 Run 4 的 snapshot/render/video hash；
- 迁移前备份与回滚说明。

### P1：独立创作数据

- 新增表和迁移；
- 分集、分镜、revision CRUD；
- 排序、复制、软删除；
- 历史数据迁移。

### P2：工作台创作 UI

- 独立分集栏；
- 新增/编辑/复制/删除分镜；
- 保存状态；
- 导入入口；
- 版本历史降级为辅助区。

### P3：参考图与素材

- 参考图生成/上传/候选；
- provider preflight；
- 生成费用确认；
- 槽位级生成、重试、审核。

### P4：生产改接 revision

- Run 选择纸片 storyboard；
- 分析器读取统一 source storyboard；
- source hash 使用 revision；
- 现有素材、动作、proof、preview、formal 全链路回归。

### P5：独立发布与整集合并

- 发布到纸片 storyboard；
- 纸片分集整集合并；
- 导出正式 MP4；
- 显式同步旧工作台。

### P6：验收与清理

- 正常流程不访问旧 storyboard API；
- 历史 Run 可读可播；
- 新旧模式互不修改；
- 前后端全量测试、production build、真实浏览器烟测。

## 11. 验收标准

- 空项目没有旧分集/分镜时能创建纸片分集和纸片分镜；
- 能新增、编辑、复制、删除、排序分镜；
- 能生成或上传参考图；
- 能生成背景、主体、道具与 Mask；
- 新 Run 不要求旧 `storyboard_id`；
- 删除或修改旧分镜不影响纸片项目；
- 发布不会自动覆盖旧分镜视频；
- 显式同步才写入旧工作台；
- 四镜可独立发布并合并整集 MP4；
- 全流程不需要进入旧版编辑器；
- 失败素材可单槽位恢复；
- 预览与正式视频保持同 snapshot；
- 页面轮询不会重建播放器或丢失编辑内容；
- 历史 Run 4 的正式视频、hash 和报告保持可用。

## 12. 实施原则

- 不调用 Codex 生图队列；
- 不自动批准图片或预览；
- 不用旧 storyboard 影子记录规避迁移；
- 不把具体测试剧情写进生产分支；
- 不破坏现有用户工作区和历史正式视频；
- 每阶段必须有数据库、服务和 UI 测试；
- 前端只根据后端状态和 next action 展示生产流程。

## 13. 2026-07-26 实施结果

已落地：

- 独立纸片分集、分镜和不可变 revision；
- 分集/分镜 CRUD、复制、连续排序、软删除；
- 旧分镜单向复制导入；
- 图片 API 参考图生成，调用前展示 provider 并二次确认；
- `paper_episode_id + paper_storyboard_ids` 独立 Run；
- 素材、动作、proof、preview、formal、publish 全链路读取冻结 revision；
- 发布只写 `paper_storyboards`，不自动写旧 `storyboards`；
- 独立纸片整集合并；
- 指定旧分集并二次确认的显式同步；
- 独立数据和生产历史的归档导入/导出；
- 创作优先的三栏纸片工作台；
- 历史 legacy Run 兼容读取，Run 4 正式视频和 hash 未迁移、未重写。

历史 Run 没有原地改写为新 revision。原因是任何原地迁移都会改变历史 source/hash 语义；当前实现保留 legacy reader，新建生产版本只走 paper revision。这同时满足历史可播放和新链路不依赖旧表两个目标。

验证结果：

- 独立链路专项测试 7/7；
- 前端测试 8/8；
- 前端 production build 通过；
- 后端整仓 167 项中 165 项通过、1 项原有跳过；唯一受沙箱影响的 HTTP listen 用例已在允许监听的环境单独执行并通过；
- 真实页面完成“空纸片项目 → 新建分集 → 新建/编辑/保存/复制/排序/删除分镜 → 创建独立 Run”；
- 历史 Run 4 可打开并加载正式 MP4；
- 活跃 Run 轮询前后没有 loading overlay、错误或控制台告警；
- 验收期间没有实际调用图片 API。
