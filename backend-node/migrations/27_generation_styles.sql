CREATE TABLE IF NOT EXISTS generation_styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  description TEXT,
  style_prompt_zh TEXT,
  style_prompt_en TEXT,
  visual_bible TEXT,
  visual_bible_struct TEXT,
  character_style_prompt_zh TEXT,
  character_style_prompt_en TEXT,
  scene_style_prompt_zh TEXT,
  scene_style_prompt_en TEXT,
  prop_style_prompt_zh TEXT,
  prop_style_prompt_en TEXT,
  video_style_prompt_zh TEXT,
  video_style_prompt_en TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_generation_styles_deleted_enabled
  ON generation_styles(deleted_at, enabled);
