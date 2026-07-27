-- Paper Studio P1: 剧本直入 · 实体库 · 自动分镜（方案 docs/plans/2026-07-26-paper-studio-script-to-storyboard-pipeline.md 第 3 章）
-- 本迁移建立剧本版本链与纸片实体库的数据层；提取/形象/分镜生成服务在后续 Phase 接入。

-- 剧本：分集级，不可变版本链（BR-011：进入生成的必须是已保存版本）
CREATE TABLE IF NOT EXISTS paper_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_episode_id INTEGER NOT NULL,
  request_id TEXT,
  version_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE(paper_episode_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_paper_scripts_episode ON paper_scripts(paper_episode_id);

-- 实体库：纸片项目级（character | scene | prop）
CREATE TABLE IF NOT EXISTS paper_library_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  canonical_prompt TEXT NOT NULL DEFAULT '',
  scale_anchor_json TEXT NOT NULL DEFAULT '{}',
  current_identity_version_id INTEGER,
  extraction_meta_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, entity_type, name)
);
CREATE INDEX IF NOT EXISTS idx_paper_library_entities_project ON paper_library_entities(project_id, entity_type);

-- 实体形象版本：不可变（BR-012：只增不改，current 指针切换须经影响预览）
CREATE TABLE IF NOT EXISTS paper_library_identity_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  source_local_path TEXT,
  alpha_local_path TEXT,
  mask_local_path TEXT,
  source_hash TEXT,
  alpha_hash TEXT,
  registration_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  derivation_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  rejected_at TEXT,
  UNIQUE(entity_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_paper_identity_versions_entity ON paper_library_identity_versions(entity_id, status);

-- 分镜⇄实体绑定：作者态（生产态冻结进 paper_storyboard_entities）
CREATE TABLE IF NOT EXISTS paper_storyboard_entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',
  binding_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_storyboard_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_paper_entity_links_storyboard ON paper_storyboard_entity_links(paper_storyboard_id);
CREATE INDEX IF NOT EXISTS idx_paper_entity_links_entity ON paper_storyboard_entity_links(entity_id);

-- 项目级风格锚（C6：统一画风，注入所有实体生图 prompt）
CREATE TABLE IF NOT EXISTS paper_style_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  anchor_text TEXT NOT NULL,
  anchor_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_style_anchors_project ON paper_style_anchors(project_id, active);
