-- Paper Studio independent authoring domain.

CREATE TABLE IF NOT EXISTS paper_studio_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  request_id TEXT,
  episode_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  fps INTEGER NOT NULL DEFAULT 30,
  default_duration REAL NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(project_id, episode_number)
);

CREATE TABLE IF NOT EXISTS paper_storyboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_episode_id INTEGER NOT NULL,
  request_id TEXT,
  shot_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '',
  narration TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 6,
  shot_type TEXT,
  camera_motion TEXT,
  visual_prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  current_revision_id INTEGER,
  reference_image_generation_id INTEGER,
  reference_image_url TEXT,
  reference_local_path TEXT,
  published_video_generation_id INTEGER,
  legacy_storyboard_id INTEGER,
  source_kind TEXT NOT NULL DEFAULT 'paper',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(paper_episode_id, shot_number)
);

CREATE TABLE IF NOT EXISTS paper_storyboard_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  revision_number INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_from TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE(paper_storyboard_id, revision_number),
  UNIQUE(paper_storyboard_id, content_hash)
);

ALTER TABLE paper_studio_runs ADD COLUMN paper_episode_id INTEGER;
ALTER TABLE paper_studio_runs ADD COLUMN legacy_episode_id INTEGER;

ALTER TABLE paper_studio_shots ADD COLUMN paper_storyboard_id INTEGER;
ALTER TABLE paper_studio_shots ADD COLUMN paper_storyboard_revision_id INTEGER;
ALTER TABLE paper_studio_shots ADD COLUMN legacy_storyboard_id INTEGER;
ALTER TABLE paper_studio_shots ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE image_generations ADD COLUMN paper_storyboard_id INTEGER;
ALTER TABLE video_generations ADD COLUMN paper_storyboard_id INTEGER;
ALTER TABLE video_merges ADD COLUMN paper_episode_id INTEGER;

ALTER TABLE paper_studio_episodes ADD COLUMN request_id TEXT;
ALTER TABLE paper_storyboards ADD COLUMN request_id TEXT;

UPDATE paper_studio_runs
SET legacy_episode_id = episode_id
WHERE legacy_episode_id IS NULL AND paper_episode_id IS NULL;

UPDATE paper_studio_shots
SET legacy_storyboard_id = storyboard_id,
    source_kind = 'legacy'
WHERE paper_storyboard_id IS NULL AND legacy_storyboard_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_paper_studio_episodes_project
  ON paper_studio_episodes(project_id, episode_number, deleted_at);

CREATE INDEX IF NOT EXISTS idx_paper_storyboards_episode
  ON paper_storyboards(paper_episode_id, shot_number, deleted_at);

CREATE INDEX IF NOT EXISTS idx_paper_storyboard_revisions_storyboard
  ON paper_storyboard_revisions(paper_storyboard_id, revision_number);

CREATE INDEX IF NOT EXISTS idx_paper_runs_paper_episode
  ON paper_studio_runs(project_id, paper_episode_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_paper_shots_paper_storyboard
  ON paper_studio_shots(paper_storyboard_id, paper_storyboard_revision_id);

CREATE INDEX IF NOT EXISTS idx_image_generations_paper_storyboard
  ON image_generations(paper_storyboard_id, status);

CREATE INDEX IF NOT EXISTS idx_video_generations_paper_storyboard
  ON video_generations(paper_storyboard_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_episode_request
  ON paper_studio_episodes(project_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_storyboard_request
  ON paper_storyboards(paper_episode_id, request_id)
  WHERE request_id IS NOT NULL;

UPDATE paper_storyboards
SET shot_number = -id
WHERE deleted_at IS NOT NULL AND shot_number > 0;

UPDATE paper_storyboards
SET shot_number = shot_number + 1000000
WHERE deleted_at IS NULL AND shot_number < 1000000;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY paper_episode_id ORDER BY shot_number, id) AS next_number
  FROM paper_storyboards
  WHERE deleted_at IS NULL
)
UPDATE paper_storyboards
SET shot_number = (SELECT next_number FROM ranked WHERE ranked.id = paper_storyboards.id)
WHERE id IN (SELECT id FROM ranked);
