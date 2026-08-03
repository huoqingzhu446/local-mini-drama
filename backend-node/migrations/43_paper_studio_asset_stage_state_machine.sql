INSERT OR IGNORE INTO paper_job_steps
  (run_id, shot_id, step_key, input_hash, depends_on_json, status, attempt,
   max_attempts, result_json, error_json, started_at, completed_at, created_at, updated_at)
SELECT register_step.run_id,
       register_step.shot_id,
       'technical_asset_gate',
       'technical-asset-gate:' || register_step.input_hash,
       '["register_assets"]',
       CASE WHEN register_step.status = 'completed' THEN 'completed' ELSE 'queued' END,
       register_step.attempt,
       register_step.max_attempts,
       CASE WHEN register_step.status = 'completed' THEN '{"migrated_from":"register_assets"}' ELSE '{}' END,
       '{}',
       CASE WHEN register_step.status = 'completed' THEN register_step.completed_at ELSE NULL END,
       CASE WHEN register_step.status = 'completed' THEN register_step.completed_at ELSE NULL END,
       register_step.created_at,
       register_step.updated_at
FROM paper_job_steps register_step
WHERE register_step.step_key = 'register_assets'
  AND NOT EXISTS (
    SELECT 1
    FROM paper_job_steps existing_step
    WHERE existing_step.run_id = register_step.run_id
      AND COALESCE(existing_step.shot_id, 0) = COALESCE(register_step.shot_id, 0)
      AND existing_step.step_key = 'technical_asset_gate'
      AND existing_step.input_hash = 'technical-asset-gate:' || register_step.input_hash
      AND existing_step.attempt = register_step.attempt
  );

UPDATE paper_job_steps
SET depends_on_json = '["matte_assets"]'
WHERE step_key = 'register_assets';

UPDATE paper_job_steps
SET depends_on_json = '["technical_asset_gate"]'
WHERE step_key = 'asset_gate';
