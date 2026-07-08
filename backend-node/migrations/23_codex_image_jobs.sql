-- Codex 开发辅助生图队列：前端提交需求，Codex 离线生成候选图，用户确认后应用到正式资产
CREATE TABLE IF NOT EXISTS codex_image_jobs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  drama_id INTEGER,
  episode_id INTEGER,
  frame_type TEXT DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT,
  negative_prompt TEXT,
  aspect_ratio TEXT,
  quality TEXT DEFAULT 'standard',
  style TEXT,
  source_snapshot TEXT,
  candidates TEXT,
  selected_candidate_id TEXT,
  applied_image_url TEXT,
  applied_local_path TEXT,
  error_msg TEXT,
  manifest_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  used_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_entity
  ON codex_image_jobs(entity_type, entity_id, status);

CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_drama
  ON codex_image_jobs(drama_id, status, updated_at);
