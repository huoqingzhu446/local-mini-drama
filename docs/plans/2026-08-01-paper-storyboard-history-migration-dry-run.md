# 分镜历史与素材复用迁移 Dry-run 报告

> 日期：2026-08-01
> 数据库：`backend-node/data/drama_generator.db` 的临时副本
> 结论：副本迁移与重复执行验证通过；正式数据库已于 2026-08-01 16:16（CST）完成 migration 44。

## 1. 迁移内容

- 新建 `paper_plan_revisions`，每次重新分析或重新编译只追加计划修订。
- `paper_studio_shots.current_plan_revision_id` 指向当前采用计划。
- family、composition node、motion plan、job step 增加 `plan_revision_id`。
- family 唯一键由 `shot_id + family_key` 改为 `plan_revision_id + family_key`。
- composition node 唯一键由 `shot_id + node_key` 改为 `plan_revision_id + node_key`。
- motion plan 唯一键由 `shot_id` 改为 `plan_revision_id`。
- slot/version 增加独立的 `reuse_fingerprint`；不与付费请求的 `request_fingerprint` 混用。
- 新建 `paper_asset_reuse_links` 和 `paper_continuity_repair_audits` 审计表。

表重建由 `ensurePaperPlanRevisionSchema()` 在单个 SQLite transaction 中执行。任一建表、复制或索引步骤失败时，整个重建回滚。

## 2. 副本演练方法

执行：

```bash
cd backend-node
node scripts/dry-run-paper-plan-history-migration.js data/drama_generator.db
```

脚本使用 SQLite backup API 创建临时数据库，只在临时副本连续运行两次迁移；第二次执行后所有受保护表数量必须与第一次完全一致。完成完整性检查后删除副本，不写正式数据库。

## 3. 数量对账

| 表 | 迁移前 | 迁移后 | 结果 |
|---|---:|---:|---|
| `paper_studio_shots` | 27 | 27 | 保持 |
| `paper_source_families` | 62 | 62 | 保持 |
| `paper_asset_slots` | 85 | 85 | 保持 |
| `paper_asset_versions` | 108 | 108 | 保持 |
| `paper_composition_nodes` | 150 | 150 | 保持 |
| `paper_motion_plans` | 20 | 20 | 保持 |
| `paper_job_steps` | 97 | 98 | 增加 1 条缺失的 `technical_asset_gate` 自愈记录 |

在同一副本再次完整执行迁移后，上表数量全部保持不变，`paper_job_steps` 仍为 98，重复执行幂等检查通过。

迁移后新增：

- 27 条初始 `paper_plan_revisions`；
- 85 个槽位和 108 个图片版本完成 `reuse_fingerprint` 回填。

## 4. 完整性结果

- `current_plan_revision_id` 为空：0；
- 孤儿素材槽位：0；
- 孤儿图片版本：0；
- 非当前 family 错挂当前计划：0；
- 非当前 composition node / motion plan 错挂当前计划：0；
- 带分镜的 job step 缺少计划归属：0；
- job step 业务幂等键重复：0；
- `PRAGMA integrity_check`：`ok`；
- `PRAGMA foreign_key_check`：0 条异常；
- 所有受保护表的记录数均未减少。

## 5. 正式迁移、异常处理与回滚

正式迁移前必须停止后端写入。应用启动前已有数据库安全机制通过 `VACUUM INTO` 在 `backend-node/data/backups/startup/` 创建独立备份；迁移完成后再次执行本报告中的数量和完整性查询。

若正式迁移失败：

1. 停止后端进程，避免产生新的 WAL 写入；
2. 保留失败数据库、`-wal` 和 `-shm` 作为诊断现场；
3. 从本次启动前生成的 `drama_generator.startup-*.db` 恢复主数据库；
4. 确认恢复库 `PRAGMA integrity_check = ok` 后再启动旧版本代码；
5. 不删除素材目录。历史图片文件没有在 migration 44 中移动、覆盖或清理。

正式执行记录：

1. 16:09 首次手动重跑时发现 migration 43 的旧回填语句在 migration 44 新幂等键下会补出 6 条 `plan_revision_id = NULL` 的重复 `technical_asset_gate`，随后唯一约束阻止继续回填；进程按预期失败，没有调用图片 provider。
2. 修复 migration 43：在插入前按不含计划修订的稳定业务键执行 `NOT EXISTS` 检查；dry-run 增加第二次完整迁移，确认重复执行不会新增记录。
3. 停止后端，将失败现场的一致性副本和数据库保存在 `backend-node/data/recovery/migration44-formal-retry-20260801-160924/`，从 16:03 的启动备份恢复后重新执行。
4. 正式执行前备份：`backend-node/data/backups/startup/drama_generator.startup-2026-08-01T08-16-01-696Z.db`。
5. 修正后的正式迁移返回 `Migrations complete.`，后端恢复后 `/health` 返回 `ok`。

正式库迁移后对账：

- shots / plan revisions / families / slots / asset versions：27 / 27 / 62 / 85 / 108；
- composition nodes / motion plans / job steps：150 / 20 / 98；
- 迁移前后 108 条 `paper_asset_versions` 原有字段 SHA-256 摘要一致；
- 116 个非空图片、Alpha 和 Mask 文件引用全部存在；
- `image_generations` 仍为 80 条，`provider_call_count` 合计仍为 9，迁移调用增量为 0；
- SQLite 完整性为 `ok`，孤儿关系、当前计划错挂和 job step 重复均为 0。

## 6. 门禁结论

- [x] 表结构与唯一约束重建方案已提交；
- [x] 副本 dry-run 已通过；
- [x] 存量数量和孤儿关系已对账；
- [x] 回滚路径已明确；
- [x] 正式数据库 migration 44 已获用户确认、执行并通过迁移后验收。
