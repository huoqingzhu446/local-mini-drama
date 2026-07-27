-- Paper Studio Phase 5: local product funnel events for onboarding, recovery,
-- task-center and delivery experience analysis. These events contain ids and
-- coarse UI context only. Prompts, credentials and media bytes are excluded.

CREATE TABLE IF NOT EXISTS paper_studio_product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  paper_episode_id INTEGER,
  paper_storyboard_id INTEGER,
  run_id INTEGER,
  shot_id INTEGER,
  event_name TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_product_events_project
  ON paper_studio_product_events(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_product_events_funnel
  ON paper_studio_product_events(project_id, event_name, created_at DESC);
