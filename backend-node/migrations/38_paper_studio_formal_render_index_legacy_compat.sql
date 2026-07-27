-- 37 首版索引引用了旧数据库可能尚未补齐的 deleted_at；
-- 重建为只依赖 Paper Studio 迁移已经保证存在的列。
DROP INDEX IF EXISTS idx_video_generations_paper_formal_processing_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_generations_paper_formal_processing_unique
  ON video_generations(paper_studio_shot_id, paper_snapshot_id, render_hash)
  WHERE generation_kind = 'paper_studio'
    AND status = 'processing';
