-- Independent Paper Studio audio and delivery provenance.

CREATE TABLE IF NOT EXISTS paper_storyboard_audio_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  paper_storyboard_revision_id INTEGER,
  parent_version_id INTEGER,
  version_number INTEGER NOT NULL,
  request_id TEXT,
  audio_kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  text_hash TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  voice_id TEXT,
  speed REAL NOT NULL DEFAULT 1,
  volume REAL NOT NULL DEFAULT 1,
  start_frame INTEGER NOT NULL DEFAULT 0,
  end_frame INTEGER,
  local_path TEXT NOT NULL,
  audio_hash TEXT NOT NULL,
  duration_ms INTEGER,
  captions_json TEXT NOT NULL DEFAULT '[]',
  captions_hash TEXT NOT NULL,
  subtitle_local_path TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  UNIQUE(paper_storyboard_id, audio_kind, version_number)
);

ALTER TABLE paper_storyboards ADD COLUMN current_dialogue_audio_version_id INTEGER;
ALTER TABLE paper_storyboards ADD COLUMN current_narration_audio_version_id INTEGER;
ALTER TABLE paper_storyboards ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE paper_storyboards ADD COLUMN audio_mix_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE paper_storyboards ADD COLUMN audio_status TEXT NOT NULL DEFAULT 'empty';

ALTER TABLE video_merges ADD COLUMN subtitle_local_path TEXT;
ALTER TABLE video_merges ADD COLUMN delivery_hash TEXT;
ALTER TABLE video_merges ADD COLUMN source_manifest_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_paper_storyboard_audio_versions
  ON paper_storyboard_audio_versions(paper_storyboard_id, audio_kind, status, version_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_storyboard_audio_request
  ON paper_storyboard_audio_versions(paper_storyboard_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paper_episode_delivery_hash
  ON video_merges(paper_episode_id, delivery_hash, status);
