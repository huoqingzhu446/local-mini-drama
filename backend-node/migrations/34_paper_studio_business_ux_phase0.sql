-- Paper Studio Phase 0: explicit paid-generation authorization, pause control,
-- attention state, and user-visible production events.

CREATE TABLE IF NOT EXISTS paper_generation_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  source_revision_hash TEXT NOT NULL,
  quote_fingerprint TEXT NOT NULL,
  shot_scope_json TEXT NOT NULL DEFAULT '[]',
  slot_scope_json TEXT NOT NULL DEFAULT '[]',
  provider_config_id INTEGER,
  provider TEXT,
  model TEXT,
  estimated_image_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  budget_limit_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'authorized',
  version INTEGER NOT NULL DEFAULT 1,
  authorized_at TEXT,
  executed_at TEXT,
  expires_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(run_id, request_id)
);

CREATE TABLE IF NOT EXISTS paper_studio_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  shot_id INTEGER,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  recovery_actions_json TEXT NOT NULL DEFAULT '[]',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

ALTER TABLE paper_studio_runs ADD COLUMN paused_at TEXT;
ALTER TABLE paper_studio_runs ADD COLUMN attention_required TEXT NOT NULL DEFAULT 'none';
ALTER TABLE paper_studio_runs ADD COLUMN active_authorization_id INTEGER;

ALTER TABLE paper_studio_shots ADD COLUMN attention_required TEXT NOT NULL DEFAULT 'none';

ALTER TABLE paper_job_steps ADD COLUMN authorization_id INTEGER;
ALTER TABLE paper_job_steps ADD COLUMN blocked_reason TEXT;
ALTER TABLE paper_job_steps ADD COLUMN user_visible_status TEXT;
ALTER TABLE paper_job_steps ADD COLUMN cancel_requested_at TEXT;

ALTER TABLE paper_storyboards ADD COLUMN environment_only INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_paper_generation_authorizations_run
  ON paper_generation_authorizations(run_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_paper_studio_events_run
  ON paper_studio_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_job_steps_authorization
  ON paper_job_steps(authorization_id, status);
