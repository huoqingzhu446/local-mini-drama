# Codex 生图队列工作流

本文记录 LocalMiniDrama 中“只依靠 Codex 生成图片”的开发辅助模式。以后处理角色、道具、场景、分镜主图、分镜首帧/尾帧的 Codex 生图问题时，先看这份文档。

## 目标

在不配置后端图片模型的情况下，让页面把角色、道具、场景、分镜帧的图片需求加入本地队列，由 Codex 使用内置图片生成能力出图，再把候选图回写到项目存储和数据库。

适用场景：

- 快速给短剧项目做样片资产。
- 从数据库或接口读取角色、道具、场景、分镜描述后批量生成概念图。
- 保留“候选图 -> 用户点击使用 -> 写回业务表”的人工确认流程。

## 代码入口

后端：

- `backend-node/src/services/codexImageJobService.js`
  - 创建队列任务、导出 `jobs.json`、导入 `results.json`、应用候选图。
- `backend-node/src/routes/codexImageJobs.js`
  - Codex 生图任务 API。
- `backend-node/migrations/23_codex_image_jobs.sql`
  - `codex_image_jobs` 表。
- `backend-node/migrations/24_scene_polished_prompt_single.sql`
  - 场景单图提示词字段 `scenes.polished_prompt_single`。
- `backend-node/scripts/codex-export-image-jobs.js`
  - 导出待生成任务。
- `backend-node/scripts/codex-import-image-results.js`
  - 导入 Codex 生成结果。

前端：

- `frontweb/src/components/CodexImageJobButton.vue`
  - 单个角色、道具、场景、分镜主图/首帧/尾帧上的 `Codex` 入队按钮。
- `frontweb/src/components/CodexImageCandidatePicker.vue`
  - 候选图展示与“使用”操作。
- `frontweb/src/api/codexImageJobs.js`
  - 前端 API 封装。
- `frontweb/src/views/FilmCreate.vue`
  - 角色生成、道具生成、场景生成、分镜图片区域接入 Codex 按钮和候选图组件。
  - 资源管理顶部提供“本集缺图入 Codex”，只把当前集缺主图的角色、道具、场景加入队列。
  - 分镜生成区域提供“Codex 批量分镜图”，批量把当前集缺图分镜加入队列。

## 数据文件

队列文件位于：

```bash
backend-node/data/codex-image-jobs/jobs.json
```

Codex 生成后写入：

```bash
backend-node/data/codex-image-jobs/results.json
```

候选图会被导入到：

```bash
backend-node/data/storage/projects/<project>/codex-candidates/<characters|props|scenes|storyboards>/
```

用户点击“使用”后，候选图会复制到正式目录：

```bash
backend-node/data/storage/projects/<project>/<characters|props|scenes|storyboards>/
```

资源图会写回对应业务表的 `image_url` 和 `local_path`。分镜图会先落到 `image_generations`，再通过 `storyboardFrameBinding` 绑定回 `storyboards.image_url/local_path/first_frame_image_id` 或 `storyboards.last_frame_*`。

## 标准流程

1. 页面入队

   在角色、道具、场景卡片上点击 `Codex`，或点击分区的 `Codex 批量`。资源管理顶部的“本集缺图入 Codex”会扫描当前集角色、道具、场景，只入队缺主图的资源。

   分镜区域也可以入队：

   - 单主图模式：分镜参考图位置的 `Codex` 使用 `entity_type=storyboard`、`frame_type=main`。
   - 首尾帧模式：首帧按钮使用 `frame_type=first`，尾帧按钮使用 `frame_type=last`。
   - 分镜批量：点击“Codex 批量分镜图”，普通模式只入队缺主图分镜；首尾帧模式会分别入队缺首帧、缺尾帧的分镜。

   后端创建 `codex_image_jobs` 记录，并刷新 `jobs.json`。

2. Codex 生成图片

   用户说“生成当前 jobs.json 里的所有图片”时，Codex 应：

   - 读取 `jobs.json`。
   - 对照 `results.json` 和 `codex_image_jobs`，跳过已生成、已完成、已使用的任务。
   - 如果同一个业务实体和同一个 `frame_type` 已经有正式 `local_path/image_url`，不要重复生成，除非用户明确要求重做。
   - 对剩余任务逐条调用内置 `image_gen`。

3. 写入并导入结果

   生成完成后，Codex 写入 `results.json`：

   ```json
   {
     "version": 1,
     "generated_at": "2026-07-06T00:00:00.000Z",
     "results": [
       {
         "job_id": "cij_xxx",
         "status": "completed",
         "candidates": [
           {
             "id": "cij_xxx_v1",
             "path": "/Users/.../.codex/generated_images/.../image.png",
             "prompt": "..."
           }
         ]
       }
     ]
   }
   ```

   然后执行：

   ```bash
   cd backend-node
   npm run codex:import-image-results -- --file data/codex-image-jobs/results.json
   ```

   导入会把 Codex 默认目录下的图片复制到项目的 `codex-candidates` 目录，并把任务状态设为 `completed`。

4. 使用候选图

   正常交互是用户在页面候选图上点击“使用”。后端会：

   - 将候选图复制到正式 `characters` / `props` / `scenes` / `storyboards` 目录。
   - 角色、道具、场景：更新业务表的 `image_url`、`local_path`、`extra_images`。
   - 分镜：调用 `imageService.upload()` 创建已完成的 `image_generations` 记录，再按 `frame_type` 绑定主图/首帧/尾帧。
   - 将 job 标记为 `used`。
   - 刷新 `jobs.json`，已使用任务不再出现在待生成队列里。

   如果用户明确要求 Codex 直接完成第四步，可以在后端调用：

   ```js
   const svc = require('./src/services/codexImageJobService');
   svc.useCandidate(db, console, cfg, jobId, { candidate_id });
   ```

   对已经有正式图的重复任务，只标记复用即可，不要再次复制覆盖原图。

## 分镜帧规则

Codex 分镜生图统一使用：

```text
entity_type = storyboard
entity_id   = storyboards.id
frame_type  = main | first | last
```

后端写入时会转换成图片生成系统已有的帧类型：

- `main`：按普通分镜主图处理。
- `first`：写入 `image_generations.frame_type = storyboard_first`，并绑定 `storyboards.image_url/local_path/first_frame_image_id`。
- `last`：写入 `image_generations.frame_type = storyboard_last`，并绑定 `storyboards.last_frame_image_url/last_frame_local_path/last_frame_image_id`。

提示词来源优先级：

- 首帧：优先 `frame_prompts` 中的 `first/storyboard_first/first_frame`。
- 尾帧：优先 `frame_prompts` 中的 `last/storyboard_last/last_frame`。
- 主图：优先 `storyboards.polished_prompt`，再用 `image_prompt`，最后回退到分镜字段拼接。

分镜 Codex prompt 会强制“单张电影帧”，避免生成拼图、分镜网格、多面板图。

## 和普通 AI 生成的区别

`从剧本提取道具`、`从剧本提取场景` 是文本模型任务，不是 Codex 出图任务。它们负责把剧本文字变成结构化道具/场景记录。

Codex 生图只从已有实体记录中取描述或提示词，创建图片候选图。也就是说：

```text
剧本 -> 文本 AI 提取道具/场景/分镜 -> 实体卡片或分镜帧 -> Codex 入队 -> Codex 出图 -> 候选图 -> 使用 -> 写回业务表/分镜绑定
```

## 常见问题

### `AI 提取失败: AI 返回内容为空`

这是文本提取失败，不是 Codex 出图失败。当前项目使用 DeepSeek 文本模型时，如果全局开启 thinking，结构化 JSON 提取可能只返回 reasoning 或空 content。

修复策略：

- `prop_extraction` 和 `scene_extraction` 调用 `generateText` 时传 `deepseek_thinking: 'disabled'`。
- `backend-node/src/services/deepseekConfig.js` 支持单次调用覆盖 DeepSeek thinking 设置。

### `no such column: polished_prompt_single`

这是旧数据库缺少 `scenes.polished_prompt_single` 字段。这个字段用于场景单图提示词缓存，避免把四宫格场景提示词误用于单图。

修复策略：

- `backend-node/migrations/24_scene_polished_prompt_single.sql`
- `backend-node/src/db/migrate.js` 的 `ensureAllColumns()` 也兜底补列。
- `codexImageJobService.loadEntity()` 对旧库做字段兼容，缺失时按 `NULL` 处理。

## 2026-07-06 当前项目执行记录

项目：`三体测试`

已生成并使用：

- 角色：`张将军`
- 道具：`水滴探测器`
- 道具：`恒星级战舰残骸`
- 场景：`太空`
- 场景：`联合舰队矩形阵列`
- 场景：`指挥室`
- 场景：`太空（战舰被击毁后）`
- 场景：`太空（金属云团）`
- 场景：`太空（水滴飞行轨迹）`

当前 `jobs.json` 待生成任务数应为 `0`。

已完成路线图：

- 第四步：分镜主图、首帧、尾帧已接入 Codex 队列。
- 第五步：资源管理顶部已增加“本集缺图入 Codex”，批量加入当前集缺图角色、道具、场景；分镜区已增加“Codex 批量分镜图”，批量加入缺图分镜主图/首帧/尾帧。

## 验证命令

```bash
cd backend-node
node --test test/*.test.js
```

```bash
cd frontweb
node --test test/*.test.js
npm run build
```

检查当前队列：

```bash
node - <<'NODE'
const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync('data/codex-image-jobs/jobs.json', 'utf8')).jobs || [];
console.log({ pending_jobs: jobs.length });
NODE
```

检查已使用任务：

```bash
sqlite3 data/drama_generator.db "select id,entity_type,entity_id,status,applied_local_path from codex_image_jobs where deleted_at is null order by created_at asc;"
```
