-- 同一纸片镜头、冻结快照与渲染哈希只能有一个进行中的正式渲染。
-- 已完成的历史重复产物保留，避免迁移时破坏用户已有文件。
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_generations_paper_formal_processing_unique
  ON video_generations(paper_studio_shot_id, paper_snapshot_id, render_hash)
  WHERE generation_kind = 'paper_studio'
    AND status = 'processing';
