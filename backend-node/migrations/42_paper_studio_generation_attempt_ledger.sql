-- Durable paper-studio provider attempt ownership.
-- These columns are populated before any external provider call so budget,
-- recovery and idempotency do not depend on paper_asset_version_id backfill.
ALTER TABLE image_generations ADD COLUMN paper_studio_run_id INTEGER;
ALTER TABLE image_generations ADD COLUMN paper_studio_shot_id INTEGER;
ALTER TABLE image_generations ADD COLUMN paper_asset_slot_id INTEGER;
ALTER TABLE image_generations ADD COLUMN generation_authorization_id INTEGER;
ALTER TABLE image_generations ADD COLUMN provider_attempted_at TEXT;
ALTER TABLE image_generations ADD COLUMN provider_call_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_image_generations_paper_studio_run_attempts
  ON image_generations(paper_studio_run_id, status, provider_attempted_at)
  WHERE generation_kind = 'paper_studio_asset' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_image_generations_paper_studio_authorization
  ON image_generations(generation_authorization_id, paper_asset_slot_id, created_at)
  WHERE generation_kind = 'paper_studio_asset' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generations_paper_studio_active_fingerprint
  ON image_generations(paper_studio_run_id, paper_asset_slot_id, request_fingerprint)
  WHERE generation_kind = 'paper_studio_asset'
    AND request_fingerprint IS NOT NULL
    AND status IN ('processing','completed')
    AND deleted_at IS NULL;
