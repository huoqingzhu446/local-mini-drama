-- 统一视觉上下文 V2：项目风格版本、不可变生成上下文、任务溯源字段。
CREATE TABLE IF NOT EXISTS drama_visual_style_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  name TEXT NOT NULL DEFAULT '',
  style_prompt_zh TEXT,
  style_prompt_en TEXT,
  visual_bible TEXT,
  visual_bible_struct TEXT,
  scope_overrides TEXT,
  prompt_style_ids TEXT,
  style_family TEXT,
  medium TEXT,
  signature TEXT NOT NULL,
  compiler_version TEXT NOT NULL DEFAULT 'v2',
  source TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  superseded_at TEXT,
  UNIQUE(drama_id, version)
);

CREATE INDEX IF NOT EXISTS idx_visual_style_versions_drama
  ON drama_visual_style_versions(drama_id, version);

CREATE INDEX IF NOT EXISTS idx_visual_style_versions_status
  ON drama_visual_style_versions(drama_id, status);

CREATE TABLE IF NOT EXISTS generation_context_snapshots (
  id TEXT PRIMARY KEY,
  drama_id INTEGER,
  episode_id INTEGER,
  scene_id INTEGER,
  storyboard_id INTEGER,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  frame_type TEXT,
  style_version_id INTEGER,
  style_signature TEXT NOT NULL,
  prompt_source TEXT,
  source_prompt TEXT,
  compiled_prompt TEXT NOT NULL,
  compiled_negative_prompt TEXT,
  reference_pack TEXT,
  source_snapshot TEXT,
  prompt_hash TEXT NOT NULL,
  reference_hash TEXT,
  compiler_version TEXT NOT NULL DEFAULT 'v2',
  diagnostics TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_context_entity
  ON generation_context_snapshots(entity_type, entity_id, frame_type, created_at);

CREATE INDEX IF NOT EXISTS idx_generation_context_drama
  ON generation_context_snapshots(drama_id, style_version_id, created_at);

ALTER TABLE dramas ADD COLUMN active_visual_style_version_id INTEGER;
ALTER TABLE dramas ADD COLUMN active_visual_style_signature TEXT;

ALTER TABLE scenes ADD COLUMN prompt_state TEXT DEFAULT 'current';
ALTER TABLE storyboards ADD COLUMN prompt_state TEXT DEFAULT 'current';
ALTER TABLE characters ADD COLUMN prompt_state TEXT DEFAULT 'current';
ALTER TABLE props ADD COLUMN prompt_state TEXT DEFAULT 'current';

ALTER TABLE codex_image_jobs ADD COLUMN style_version_id INTEGER;
ALTER TABLE codex_image_jobs ADD COLUMN context_snapshot_id TEXT;
ALTER TABLE codex_image_jobs ADD COLUMN prompt_hash TEXT;
ALTER TABLE codex_image_jobs ADD COLUMN reference_pack TEXT;
ALTER TABLE codex_image_jobs ADD COLUMN compiler_version TEXT;
ALTER TABLE codex_image_jobs ADD COLUMN stale_reason TEXT;

ALTER TABLE image_generations ADD COLUMN style_version_id INTEGER;
ALTER TABLE image_generations ADD COLUMN context_snapshot_id TEXT;
ALTER TABLE image_generations ADD COLUMN prompt_hash TEXT;
ALTER TABLE image_generations ADD COLUMN reference_pack TEXT;
ALTER TABLE image_generations ADD COLUMN compiler_version TEXT;
ALTER TABLE image_generations ADD COLUMN prop_id INTEGER;

ALTER TABLE generation_styles ADD COLUMN style_family TEXT;
ALTER TABLE generation_styles ADD COLUMN medium TEXT;
ALTER TABLE generation_styles ADD COLUMN compatibility_tags TEXT;

ALTER TABLE prompt_styles ADD COLUMN role TEXT DEFAULT 'constraint';
ALTER TABLE prompt_styles ADD COLUMN medium TEXT;
ALTER TABLE prompt_styles ADD COLUMN compatibility_tags TEXT;
ALTER TABLE prompt_styles ADD COLUMN priority INTEGER DEFAULT 50;
