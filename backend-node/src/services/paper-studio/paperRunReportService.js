const runService = require('./paperStudioRunService');
const { canonicalJson, nowIso, parseJson, sha256 } = require('./paperStudioUtils');

const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|credential|credentials|password)$/i;

function sanitizeString(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(sanitizeForReport(JSON.parse(trimmed)));
    } catch (_) {}
  }
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|signature|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|credential|credentials|password)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
}

function sanitizeForReport(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeForReport(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeForReport(item),
    ]));
  }
  return typeof value === 'string' ? sanitizeString(value) : value;
}

function groupedCounts(rows, key = 'status') {
  return rows.reduce((result, row) => {
    const value = row[key] || 'unknown';
    result[value] = Number(result[value] || 0) + 1;
    return result;
  }, {});
}

function build(db, runId) {
  const run = runService.get(db, runId);
  const steps = db.prepare(
    `SELECT id, shot_id, step_key, input_hash, depends_on_json, status, attempt,
            max_attempts, result_json, error_json, started_at, completed_at, updated_at
     FROM paper_job_steps WHERE run_id = ? ORDER BY shot_id, id`,
  ).all(Number(run.id)).map((step) => ({
    ...step,
    id: Number(step.id),
    shot_id: step.shot_id == null ? null : Number(step.shot_id),
    attempt: Number(step.attempt || 0),
    max_attempts: Number(step.max_attempts || 0),
    depends_on_json: parseJson(step.depends_on_json, []),
    result_json: parseJson(step.result_json, {}),
    error_json: parseJson(step.error_json, {}),
  }));
  const imageAttempts = db.prepare(
    `SELECT ig.id, ig.storyboard_id, ig.paper_storyboard_id, ig.provider, ig.model, ig.frame_type, ig.size,
            ig.quality, ig.status, ig.generation_kind, ig.generation_purpose,
            ig.request_fingerprint, ig.provider_task_id, ig.error_msg,
            ig.created_at, ig.updated_at, ig.completed_at, pav.id AS asset_version_id,
            pas.slot_key, psf.shot_id
     FROM image_generations ig
     JOIN paper_asset_versions pav ON pav.id = ig.paper_asset_version_id
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id
     WHERE pss.run_id = ? AND ig.deleted_at IS NULL
     ORDER BY ig.id`,
  ).all(Number(run.id)).map((row) => ({
    ...row,
    id: Number(row.id),
    storyboard_id: row.storyboard_id == null ? null : Number(row.storyboard_id),
    paper_storyboard_id: row.paper_storyboard_id == null ? null : Number(row.paper_storyboard_id),
    asset_version_id: Number(row.asset_version_id),
    shot_id: Number(row.shot_id),
  }));
  const assetVersions = db.prepare(
    `SELECT pav.*, pas.slot_key, pas.asset_type, psf.family_key, psf.shot_id
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id
     WHERE pss.run_id = ? ORDER BY pav.id`,
  ).all(Number(run.id)).map((row) => ({
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    family_key: row.family_key,
    slot_key: row.slot_key,
    asset_type: row.asset_type,
    attempt_index: Number(row.attempt_index || 0),
    derivation_kind: row.derivation_kind,
    status: row.status,
    source_local_path: row.source_local_path,
    alpha_local_path: row.alpha_local_path,
    mask_local_path: row.mask_local_path,
    source_hash: row.source_hash,
    alpha_hash: row.alpha_hash,
    mask_hash: row.mask_hash,
    processing: parseJson(row.processing_json, {}),
    registration: parseJson(row.registration_json, {}),
    provenance: parseJson(row.provenance_json, {}),
    quality_report: parseJson(row.quality_report_json, {}),
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    rejected_at: row.rejected_at,
  }));
  const snapshots = db.prepare(
    `SELECT prs.id, prs.shot_id, prs.schema_version, prs.renderer_version,
            prs.source_revision_hash, prs.timing_hash, prs.snapshot_hash,
            prs.render_hash, prs.local_path, prs.status, prs.approved_at, prs.created_at
     FROM paper_render_snapshots prs
     JOIN paper_studio_shots pss ON pss.id = prs.shot_id
     WHERE pss.run_id = ? ORDER BY prs.id`,
  ).all(Number(run.id)).map((row) => ({ ...row, id: Number(row.id), shot_id: Number(row.shot_id), schema_version: Number(row.schema_version) }));
  const proofRuns = db.prepare(
    `SELECT ppr.* FROM paper_proof_runs ppr
     JOIN paper_studio_shots pss ON pss.id = ppr.shot_id
     WHERE pss.run_id = ? ORDER BY ppr.id`,
  ).all(Number(run.id)).map((row) => ({
    ...row,
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    snapshot_id: Number(row.snapshot_id),
    scale: Number(row.scale),
    report_json: parseJson(row.report_json, {}),
  }));
  const proofEvidence = db.prepare(
    `SELECT ppe.* FROM paper_proof_evidence ppe
     JOIN paper_proof_runs ppr ON ppr.id = ppe.proof_run_id
     JOIN paper_studio_shots pss ON pss.id = ppr.shot_id
     WHERE pss.run_id = ? ORDER BY ppe.id`,
  ).all(Number(run.id)).map((row) => ({
    ...row,
    id: Number(row.id),
    proof_run_id: Number(row.proof_run_id),
    frame: Number(row.frame),
    metrics_json: parseJson(row.metrics_json, {}),
    assertion_json: parseJson(row.assertion_json, []),
  }));
  const revisions = db.prepare(
    `SELECT pmr.* FROM paper_motion_revisions pmr
     JOIN paper_studio_shots pss ON pss.id = pmr.shot_id
     WHERE pss.run_id = ? ORDER BY pmr.id`,
  ).all(Number(run.id)).map((row) => ({
    ...row,
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    motion_plan_id: Number(row.motion_plan_id),
    intent_json: parseJson(row.intent_json, {}),
    patch_json: parseJson(row.patch_json, {}),
    gate_report_json: parseJson(row.gate_report_json, {}),
  }));
  const videos = db.prepare(
    `SELECT vg.id, vg.storyboard_id, vg.paper_storyboard_id, vg.status, vg.generation_kind, vg.video_url,
            vg.local_path, vg.render_hash, vg.renderer_version, vg.paper_snapshot_id,
            vg.completed_at, vg.created_at, vg.paper_studio_shot_id
     FROM video_generations vg
     JOIN paper_studio_shots pss ON pss.id = vg.paper_studio_shot_id
     WHERE pss.run_id = ? AND vg.deleted_at IS NULL ORDER BY vg.id`,
  ).all(Number(run.id)).map((row) => ({
    ...row,
    id: Number(row.id),
    storyboard_id: row.storyboard_id == null ? null : Number(row.storyboard_id),
    paper_storyboard_id: row.paper_storyboard_id == null ? null : Number(row.paper_storyboard_id),
    paper_studio_shot_id: Number(row.paper_studio_shot_id),
    paper_snapshot_id: row.paper_snapshot_id == null ? null : Number(row.paper_snapshot_id),
  }));
  const shots = run.shots.map((shot) => ({
    id: Number(shot.id),
    storyboard_id: shot.legacy_storyboard_id == null ? null : Number(shot.legacy_storyboard_id),
    paper_storyboard_id: shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id),
    paper_storyboard_revision_id: shot.paper_storyboard_revision_id == null ? null : Number(shot.paper_storyboard_revision_id),
    source_kind: shot.source_kind || 'legacy',
    shot_index: Number(shot.shot_index),
    title: shot.storyboard?.title || '',
    status: shot.status,
    source_revision_hash: shot.source_revision_hash,
    plan_summary: shot.plan_summary_json,
    current_snapshot_id: shot.current_snapshot_id == null ? null : Number(shot.current_snapshot_id),
    approved_snapshot_id: shot.approved_snapshot_id == null ? null : Number(shot.approved_snapshot_id),
    published_video_generation_id: shot.published_video_generation_id == null ? null : Number(shot.published_video_generation_id),
    last_error: shot.last_error_json,
  }));
  const core = {
    schema_version: 1,
    report_kind: 'paper_studio_run_report',
    run: {
      id: Number(run.id),
      project_id: Number(run.project_id),
      drama_id: Number(run.drama_id),
      episode_id: run.legacy_episode_id == null ? null : Number(run.legacy_episode_id),
      paper_episode_id: run.paper_episode_id == null ? null : Number(run.paper_episode_id),
      source_kind: run.paper_episode_id == null ? 'legacy' : 'paper',
      run_number: Number(run.run_number),
      quality_tier: run.quality_tier,
      status: run.status,
      progress: Number(run.progress),
      style_version_id: run.style_version_id == null ? null : Number(run.style_version_id),
      style_signature: run.style_signature,
      source_revision_hash: run.source_revision_hash,
      selection: run.selection_json,
      budget: run.budget_json,
      created_at: run.created_at,
      updated_at: run.updated_at,
      completed_at: run.completed_at,
    },
    summary: {
      shot_statuses: groupedCounts(shots),
      step_statuses: groupedCounts(steps),
      image_attempt_statuses: groupedCounts(imageAttempts),
      asset_version_statuses: groupedCounts(assetVersions),
      continuity_statuses: groupedCounts(run.continuity || []),
      proof_statuses: groupedCounts(proofRuns),
      published_video_count: videos.filter((video) => video.status === 'completed').length,
      warning_count: shots.filter((shot) => Object.keys(shot.last_error || {}).length).length,
    },
    shots,
    steps,
    image_attempts: imageAttempts,
    asset_versions: assetVersions,
    continuity: run.continuity || [],
    motion_revisions: revisions,
    snapshots,
    proof_runs: proofRuns,
    proof_evidence: proofEvidence,
    published_videos: videos,
  };
  const sanitizedCore = sanitizeForReport(core);
  const reportHash = sha256(canonicalJson(sanitizedCore));
  return { ...sanitizedCore, report_hash: reportHash, generated_at: nowIso() };
}

module.exports = { groupedCounts, sanitizeForReport, build };
