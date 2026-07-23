-- LocalMiniDrama paper-layered animation v2.
-- All statements are idempotent so the desktop app can run migrations on every start.

ALTER TABLE storyboards ADD COLUMN video_render_mode TEXT DEFAULT 'ai_video';

ALTER TABLE video_generations ADD COLUMN generation_kind TEXT DEFAULT 'ai';
ALTER TABLE video_generations ADD COLUMN paper_composition_id INTEGER;
ALTER TABLE video_generations ADD COLUMN render_snapshot TEXT;
ALTER TABLE video_generations ADD COLUMN render_hash TEXT;
ALTER TABLE video_generations ADD COLUMN renderer_version TEXT;

CREATE TABLE IF NOT EXISTS paper_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  scene_id INTEGER,
  sequence_key TEXT NOT NULL,
  fps INTEGER NOT NULL DEFAULT 30,
  continuity_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(episode_id, sequence_key)
);
CREATE INDEX IF NOT EXISTS idx_paper_sequences_episode ON paper_sequences(episode_id, status);

CREATE TABLE IF NOT EXISTS paper_compositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  storyboard_id INTEGER NOT NULL UNIQUE,
  sequence_id INTEGER,
  sequence_index INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 2,
  template_key TEXT NOT NULL DEFAULT 'paper_history_v1',
  fps INTEGER NOT NULL DEFAULT 30,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  duration_frames INTEGER NOT NULL,
  camera_json TEXT NOT NULL DEFAULT '{}',
  continuity_json TEXT NOT NULL DEFAULT '{}',
  audio_json TEXT NOT NULL DEFAULT '{}',
  audio_timing_status TEXT NOT NULL DEFAULT 'unlocked',
  audio_timing_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  spec_hash TEXT,
  renderer_version TEXT,
  last_validation_json TEXT NOT NULL DEFAULT '{}',
  last_proof_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_compositions_episode ON paper_compositions(episode_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_compositions_sequence ON paper_compositions(sequence_id, sequence_index);

CREATE TABLE IF NOT EXISTS paper_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  episode_id INTEGER,
  scene_id INTEGER,
  storyboard_id INTEGER,
  asset_scope TEXT NOT NULL DEFAULT 'storyboard',
  asset_key TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT '',
  rig_key TEXT,
  source_entity_type TEXT,
  source_entity_id INTEGER,
  source_image_generation_id INTEGER,
  context_snapshot_id TEXT,
  style_version_id INTEGER,
  style_signature TEXT,
  prompt TEXT,
  negative_prompt TEXT,
  image_url TEXT,
  local_path TEXT,
  cutout_local_path TEXT,
  processing_json TEXT NOT NULL DEFAULT '{}',
  camera_signature TEXT,
  facing TEXT,
  foot_line REAL,
  content_bbox_json TEXT NOT NULL DEFAULT '{}',
  alpha_bbox_json TEXT NOT NULL DEFAULT '{}',
  matte_quality TEXT NOT NULL DEFAULT 'unknown',
  asset_hash TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(drama_id, asset_key, variant_key)
);
CREATE INDEX IF NOT EXISTS idx_paper_assets_scene ON paper_assets(scene_id, asset_scope, status);
CREATE INDEX IF NOT EXISTS idx_paper_assets_entity ON paper_assets(source_entity_type, source_entity_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_assets_hash ON paper_assets(asset_hash);

CREATE TABLE IF NOT EXISTS paper_rigs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  rig_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  root_part_key TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(subject_type, subject_id, rig_key)
);
CREATE INDEX IF NOT EXISTS idx_paper_rigs_subject ON paper_rigs(subject_type, subject_id, status);

CREATE TABLE IF NOT EXISTS paper_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id INTEGER NOT NULL,
  paper_asset_id INTEGER,
  rig_id INTEGER,
  layer_key TEXT NOT NULL,
  layer_type TEXT NOT NULL,
  role TEXT,
  parent_layer_key TEXT,
  content_json TEXT NOT NULL DEFAULT '{}',
  z_index INTEGER NOT NULL DEFAULT 0,
  depth REAL NOT NULL DEFAULT 0.5,
  pivot_json TEXT NOT NULL DEFAULT '{}',
  transform_json TEXT NOT NULL DEFAULT '{}',
  animation_json TEXT NOT NULL DEFAULT '{}',
  occlusion_json TEXT NOT NULL DEFAULT '{}',
  mask_asset_id INTEGER,
  schema_version INTEGER NOT NULL DEFAULT 2,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(composition_id, layer_key)
);
CREATE INDEX IF NOT EXISTS idx_paper_layers_composition ON paper_layers(composition_id, z_index, status);
CREATE INDEX IF NOT EXISTS idx_paper_layers_asset ON paper_layers(paper_asset_id);

CREATE TABLE IF NOT EXISTS paper_render_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  composition_id INTEGER NOT NULL,
  render_hash TEXT NOT NULL,
  proof_kind TEXT NOT NULL,
  frame INTEGER NOT NULL,
  local_path TEXT NOT NULL,
  image_hash TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(composition_id, render_hash, proof_kind)
);
CREATE INDEX IF NOT EXISTS idx_paper_proofs_composition ON paper_render_proofs(composition_id, render_hash, status);
