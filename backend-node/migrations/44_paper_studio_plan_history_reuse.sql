-- Paper Studio immutable plan history and zero-call asset reuse.

CREATE TABLE IF NOT EXISTS paper_plan_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL,
  blueprint_revision_id INTEGER,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  transition_report_json TEXT NOT NULL DEFAULT '{}',
  created_from TEXT NOT NULL DEFAULT 'analysis',
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  superseded_at TEXT,
  UNIQUE(shot_id, revision_number)
);

ALTER TABLE paper_studio_shots ADD COLUMN current_plan_revision_id INTEGER;
ALTER TABLE paper_source_families ADD COLUMN plan_revision_id INTEGER;
ALTER TABLE paper_composition_nodes ADD COLUMN plan_revision_id INTEGER;
ALTER TABLE paper_motion_plans ADD COLUMN plan_revision_id INTEGER;
ALTER TABLE paper_job_steps ADD COLUMN plan_revision_id INTEGER;
ALTER TABLE paper_asset_slots ADD COLUMN reuse_fingerprint TEXT;
ALTER TABLE paper_asset_versions ADD COLUMN reuse_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS paper_asset_reuse_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_asset_version_id INTEGER NOT NULL,
  target_asset_version_id INTEGER NOT NULL,
  target_shot_id INTEGER NOT NULL,
  target_slot_id INTEGER NOT NULL,
  match_kind TEXT NOT NULL,
  compatibility_report_json TEXT NOT NULL DEFAULT '{}',
  source_file_hash TEXT NOT NULL,
  preview_fingerprint TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(target_asset_version_id)
);

CREATE TABLE IF NOT EXISTS paper_continuity_repair_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  source_plan_revision_id INTEGER NOT NULL,
  target_plan_revision_id INTEGER NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  asset_diff_json TEXT NOT NULL DEFAULT '{}',
  gate_report_json TEXT NOT NULL DEFAULT '{}',
  provider_call_count_before INTEGER NOT NULL DEFAULT 0,
  provider_call_count_after INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(shot_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_plan_revisions_shot
  ON paper_plan_revisions(shot_id, revision_number DESC, status);
CREATE INDEX IF NOT EXISTS idx_paper_asset_slots_reuse
  ON paper_asset_slots(reuse_fingerprint, asset_type, generation_purpose);
CREATE INDEX IF NOT EXISTS idx_paper_asset_versions_reuse
  ON paper_asset_versions(reuse_fingerprint, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_asset_reuse_source
  ON paper_asset_reuse_links(source_asset_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_asset_reuse_target_shot
  ON paper_asset_reuse_links(target_shot_id, target_slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_continuity_repair_shot
  ON paper_continuity_repair_audits(shot_id, created_at DESC);
