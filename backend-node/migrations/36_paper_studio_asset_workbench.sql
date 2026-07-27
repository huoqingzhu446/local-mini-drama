-- Paper Studio Phase 2: reference candidates, per-asset review and local mask edits.

ALTER TABLE paper_storyboards ADD COLUMN current_reference_version_id INTEGER;
ALTER TABLE paper_storyboards ADD COLUMN reference_constraints_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS paper_storyboard_reference_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_storyboard_id INTEGER NOT NULL,
  image_generation_id INTEGER,
  parent_version_id INTEGER,
  source_kind TEXT NOT NULL,
  image_url TEXT,
  local_path TEXT NOT NULL,
  prompt TEXT,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  selected_at TEXT,
  rejected_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_asset_review_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  asset_version_id INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  reviewer TEXT NOT NULL DEFAULT 'local_user',
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(asset_version_id, request_id)
);

CREATE TABLE IF NOT EXISTS paper_asset_mask_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  parent_asset_version_id INTEGER NOT NULL,
  asset_version_id INTEGER NOT NULL,
  edit_kind TEXT NOT NULL,
  patch_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(asset_version_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_storyboard_reference_versions_storyboard
  ON paper_storyboard_reference_versions(paper_storyboard_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_asset_review_decisions_version
  ON paper_asset_review_decisions(asset_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_asset_review_decisions_shot
  ON paper_asset_review_decisions(shot_id, slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_asset_mask_edits_shot
  ON paper_asset_mask_edits(shot_id, slot_id, created_at DESC);

INSERT INTO paper_storyboard_reference_versions
  (paper_storyboard_id, image_generation_id, source_kind, image_url, local_path,
   constraints_json, provenance_json, status, version, created_at, selected_at)
SELECT ps.id, ps.reference_image_generation_id,
       CASE WHEN ps.reference_image_generation_id IS NULL THEN 'existing_upload' ELSE 'existing_generation' END,
       ps.reference_image_url, ps.reference_local_path, '{}', '{"migration":"36"}',
       'selected', 1, ps.updated_at, ps.updated_at
FROM paper_storyboards ps
WHERE ps.deleted_at IS NULL AND ps.reference_local_path IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM paper_storyboard_reference_versions prv
    WHERE prv.paper_storyboard_id = ps.id
  );

UPDATE paper_storyboards
SET current_reference_version_id = (
  SELECT prv.id FROM paper_storyboard_reference_versions prv
  WHERE prv.paper_storyboard_id = paper_storyboards.id AND prv.status = 'selected'
  ORDER BY prv.id DESC LIMIT 1
)
WHERE current_reference_version_id IS NULL;
