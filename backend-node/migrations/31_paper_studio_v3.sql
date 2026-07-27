-- LocalMiniDrama paper studio v3.
-- Tables are isolated from the legacy v2 paper-layer editor. Shared generation
-- tables only receive publication/provenance columns.

ALTER TABLE image_generations ADD COLUMN generation_kind TEXT DEFAULT 'standard';
ALTER TABLE image_generations ADD COLUMN paper_asset_version_id INTEGER;
ALTER TABLE image_generations ADD COLUMN generation_purpose TEXT;
ALTER TABLE image_generations ADD COLUMN request_fingerprint TEXT;
ALTER TABLE image_generations ADD COLUMN provider_task_id TEXT;

ALTER TABLE video_generations ADD COLUMN paper_studio_shot_id INTEGER;
ALTER TABLE video_generations ADD COLUMN paper_snapshot_id INTEGER;

CREATE TABLE IF NOT EXISTS paper_studio_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 3,
  default_tier TEXT NOT NULL DEFAULT 'balanced',
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_studio_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  run_number INTEGER NOT NULL,
  request_id TEXT,
  selection_json TEXT NOT NULL DEFAULT '{}',
  quality_tier TEXT NOT NULL DEFAULT 'balanced',
  style_version_id INTEGER,
  style_signature TEXT,
  source_revision_hash TEXT,
  budget_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  progress INTEGER NOT NULL DEFAULT 0,
  last_error_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  UNIQUE(project_id, episode_id, run_number),
  UNIQUE(project_id, request_id)
);

CREATE TABLE IF NOT EXISTS paper_studio_shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  storyboard_id INTEGER NOT NULL,
  shot_index INTEGER NOT NULL,
  source_revision_hash TEXT,
  semantic_contract_json TEXT NOT NULL DEFAULT '{}',
  plan_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  current_snapshot_id INTEGER,
  approved_snapshot_id INTEGER,
  published_video_generation_id INTEGER,
  last_error_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(run_id, storyboard_id)
);

CREATE TABLE IF NOT EXISTS paper_source_families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  family_key TEXT NOT NULL,
  pattern TEXT NOT NULL,
  registration_canvas_json TEXT NOT NULL DEFAULT '{}',
  contract_json TEXT NOT NULL DEFAULT '{}',
  layout_master_version_id INTEGER,
  context_snapshot_id TEXT,
  provider_signature TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(shot_id, family_key)
);

CREATE TABLE IF NOT EXISTS paper_asset_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL,
  slot_key TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  generation_purpose TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  required_for_gate INTEGER NOT NULL DEFAULT 1,
  current_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(family_id, slot_key)
);

CREATE TABLE IF NOT EXISTS paper_asset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  source_family_id INTEGER NOT NULL,
  image_generation_id INTEGER,
  parent_version_id INTEGER,
  attempt_index INTEGER NOT NULL DEFAULT 1,
  derivation_kind TEXT NOT NULL,
  source_local_path TEXT,
  alpha_local_path TEXT,
  mask_local_path TEXT,
  source_hash TEXT,
  alpha_hash TEXT,
  mask_hash TEXT,
  processing_json TEXT NOT NULL DEFAULT '{}',
  registration_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  quality_report_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  rejected_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_composition_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  parent_node_id INTEGER,
  node_kind TEXT NOT NULL,
  pattern TEXT,
  slot TEXT,
  asset_version_id INTEGER,
  transform_json TEXT NOT NULL DEFAULT '{}',
  relation_json TEXT NOT NULL DEFAULT '{}',
  clip_json TEXT NOT NULL DEFAULT '{}',
  local_z INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(shot_id, node_key)
);

CREATE TABLE IF NOT EXISTS paper_motion_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  semantic_contract_hash TEXT NOT NULL,
  timing_hash TEXT,
  plan_json TEXT NOT NULL,
  compiled_tracks_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_render_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 3,
  renderer_version TEXT NOT NULL,
  source_revision_hash TEXT NOT NULL,
  timing_hash TEXT,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  render_hash TEXT NOT NULL,
  local_path TEXT,
  status TEXT NOT NULL DEFAULT 'compiled',
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(shot_id, render_hash)
);

CREATE TABLE IF NOT EXISTS paper_proof_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  run_kind TEXT NOT NULL,
  scale REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  preview_local_path TEXT,
  report_json TEXT NOT NULL DEFAULT '{}',
  proof_hash TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_proof_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_run_id INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  frame INTEGER NOT NULL,
  full_local_path TEXT,
  crop_local_path TEXT,
  debug_local_path TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  assertion_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL,
  UNIQUE(proof_run_id, target_key, frame)
);

CREATE TABLE IF NOT EXISTS paper_job_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  shot_id INTEGER,
  step_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  async_task_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_studio_runs_lookup
  ON paper_studio_runs(project_id, episode_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_paper_studio_shots_run
  ON paper_studio_shots(run_id, status, shot_index);
CREATE INDEX IF NOT EXISTS idx_paper_source_families_shot
  ON paper_source_families(shot_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_asset_slots_family
  ON paper_asset_slots(family_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_asset_versions_slot
  ON paper_asset_versions(slot_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_paper_composition_nodes_shot
  ON paper_composition_nodes(shot_id, parent_node_id, local_z);
CREATE INDEX IF NOT EXISTS idx_paper_job_steps_run
  ON paper_job_steps(run_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_job_steps_idempotency
  ON paper_job_steps(run_id, COALESCE(shot_id, 0), step_key, input_hash, attempt);
CREATE INDEX IF NOT EXISTS idx_paper_render_snapshots_shot
  ON paper_render_snapshots(shot_id, created_at);
CREATE INDEX IF NOT EXISTS idx_paper_proof_runs_snapshot
  ON paper_proof_runs(snapshot_id, status);
CREATE INDEX IF NOT EXISTS idx_image_generations_paper_asset
  ON image_generations(paper_asset_version_id, status);
CREATE INDEX IF NOT EXISTS idx_video_generations_paper_studio
  ON video_generations(paper_studio_shot_id, status);
