-- Paper Studio Phase 3: auditable semantic motion revisions and cross-shot continuity.

CREATE TABLE IF NOT EXISTS paper_motion_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  motion_plan_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  patch_json TEXT NOT NULL DEFAULT '{}',
  gate_report_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'applied',
  created_at TEXT NOT NULL,
  UNIQUE(shot_id, request_id)
);

CREATE TABLE IF NOT EXISTS paper_continuity_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  source_shot_id INTEGER NOT NULL,
  target_shot_id INTEGER NOT NULL,
  continuity_key TEXT NOT NULL,
  subject_signature TEXT NOT NULL,
  contract_json TEXT NOT NULL DEFAULT '{}',
  report_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, source_shot_id, target_shot_id, continuity_key)
);

CREATE INDEX IF NOT EXISTS idx_paper_motion_revisions_shot
  ON paper_motion_revisions(shot_id, created_at);

CREATE INDEX IF NOT EXISTS idx_paper_continuity_run
  ON paper_continuity_contracts(run_id, target_shot_id, status);
