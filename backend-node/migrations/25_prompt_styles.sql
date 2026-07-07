CREATE TABLE IF NOT EXISTS prompt_styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  description TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS prompt_style_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id INTEGER NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_styles_deleted_enabled ON prompt_styles(deleted_at, enabled);
CREATE INDEX IF NOT EXISTS idx_prompt_style_tags_style ON prompt_style_tags(style_id);
CREATE INDEX IF NOT EXISTS idx_prompt_style_tags_tag ON prompt_style_tags(tag);
