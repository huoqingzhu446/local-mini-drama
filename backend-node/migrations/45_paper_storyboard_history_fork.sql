-- Paper storyboard history fork schema.
--
-- IMPORTANT: this file is intentionally executed by the dedicated
-- ensurePaperHistoryForkSchema() transaction, not by the generic statement
-- splitter. Formal databases must use the reviewed migration-45 script.

ALTER TABLE paper_storyboards ADD COLUMN working_copy_base_revision_id INTEGER;
ALTER TABLE paper_storyboards ADD COLUMN working_copy_fork_audit_id INTEGER;

CREATE TABLE IF NOT EXISTS paper_history_fork_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_storyboard_revision_id INTEGER NOT NULL,
  source_run_id INTEGER,
  source_shot_id INTEGER,
  source_plan_revision_id INTEGER,
  target_mode TEXT NOT NULL,
  target_storyboard_revision_id INTEGER,
  target_run_id INTEGER,
  target_shot_id INTEGER,
  target_plan_revision_id INTEGER,
  status TEXT NOT NULL DEFAULT 'previewed',
  impact_json TEXT NOT NULL DEFAULT '{}',
  preview_fingerprint TEXT NOT NULL,
  provider_call_count_before INTEGER NOT NULL DEFAULT 0,
  provider_call_count_after INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  UNIQUE(paper_storyboard_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_history_fork_source
  ON paper_history_fork_audits(
    paper_storyboard_id,
    source_storyboard_revision_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_paper_history_fork_target_run
  ON paper_history_fork_audits(target_run_id, target_shot_id);

CREATE TABLE IF NOT EXISTS paper_asset_reuse_review_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  target_slot_id INTEGER NOT NULL,
  source_asset_version_id INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(target_slot_id, source_asset_version_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_asset_reuse_review_target
  ON paper_asset_reuse_review_decisions(target_slot_id, source_asset_version_id, id DESC);

CREATE TABLE IF NOT EXISTS paper_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
