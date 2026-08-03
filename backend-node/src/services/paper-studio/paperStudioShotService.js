const { PaperStudioError, parseJson } = require('./paperStudioUtils');
const { nextActionForShot } = require('./paperStudioStateService');
const continuityService = require('./paperContinuityService');
const blueprintService = require('./paperBlueprintService');

function rowToShot(row) {
  if (!row) return null;
  const lastError = parseJson(row.last_error_json, {});
  const paperContent = parseJson(row.paper_revision_content_json, null);
  const paperSource = row.source_kind === 'paper' || row.paper_storyboard_revision_id != null;
  const storyboard = paperSource ? {
    id: Number(row.paper_storyboard_id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    revision_id: Number(row.paper_storyboard_revision_id),
    storyboard_number: Number(paperContent?.shot_number || 0),
    title: paperContent?.title || '',
    description: paperContent?.description || '',
    action: paperContent?.action || '',
    dialogue: paperContent?.dialogue || '',
    narration: paperContent?.narration || '',
    duration: Number(paperContent?.duration || 0),
    image_url: paperContent?.reference_image_url || null,
    local_path: paperContent?.reference_local_path || null,
    shot_type: paperContent?.shot_type || null,
    movement: paperContent?.camera_motion || null,
    environment_only: Boolean(paperContent?.environment_only),
    source_kind: 'paper',
  } : row.storyboard_title !== undefined ? {
    id: Number(row.legacy_storyboard_id || row.storyboard_id),
    storyboard_number: Number(row.storyboard_number || 0),
    title: row.storyboard_title || '',
    description: row.storyboard_description || '',
    action: row.storyboard_action || '',
    duration: Number(row.storyboard_duration || 0),
    image_url: row.storyboard_image_url || null,
    local_path: row.storyboard_local_path || null,
    source_kind: 'legacy',
  } : undefined;
  return {
    ...row,
    run_id: Number(row.run_id),
    drama_id: Number(row.drama_id),
    episode_id: Number(row.episode_id),
    storyboard_id: Number(row.storyboard_id),
    paper_storyboard_id: row.paper_storyboard_id == null ? null : Number(row.paper_storyboard_id),
    paper_storyboard_revision_id: row.paper_storyboard_revision_id == null ? null : Number(row.paper_storyboard_revision_id),
    legacy_storyboard_id: row.legacy_storyboard_id == null ? null : Number(row.legacy_storyboard_id),
    blueprint_revision_id: row.blueprint_revision_id == null ? null : Number(row.blueprint_revision_id),
    action_contract_id: row.action_contract_id == null ? null : Number(row.action_contract_id),
    current_plan_revision_id: row.current_plan_revision_id == null ? null : Number(row.current_plan_revision_id),
    shot_index: Number(row.shot_index),
    semantic_contract_json: parseJson(row.semantic_contract_json, {}),
    plan_summary_json: parseJson(row.plan_summary_json, {}),
    last_error_json: lastError,
    version: Number(row.version || 1),
    attention_required: row.attention_required || 'none',
    next_action: nextActionForShot(row.status, lastError),
    storyboard,
  };
}

const SHOT_SELECT = `
  SELECT ps.*,
         sb.storyboard_number,
         sb.title AS storyboard_title,
         sb.description AS storyboard_description,
         sb.action AS storyboard_action,
         sb.duration AS storyboard_duration,
         sb.image_url AS storyboard_image_url,
         sb.local_path AS storyboard_local_path,
         psr.content_json AS paper_revision_content_json
  FROM paper_studio_shots ps
  LEFT JOIN storyboards sb
    ON sb.id = COALESCE(ps.legacy_storyboard_id, ps.storyboard_id)
   AND COALESCE(ps.source_kind, 'legacy') != 'paper'
  LEFT JOIN paper_storyboard_revisions psr
    ON psr.id = ps.paper_storyboard_revision_id
   AND psr.paper_storyboard_id = ps.paper_storyboard_id
`;

function listByRun(db, runId) {
  return db.prepare(
    `${SHOT_SELECT}
     WHERE ps.run_id = ? AND ps.deleted_at IS NULL
     ORDER BY ps.shot_index, ps.id`,
  ).all(Number(runId)).map(rowToShot);
}

function get(db, shotId) {
  const row = db.prepare(
    `${SHOT_SELECT}
     WHERE ps.id = ? AND ps.deleted_at IS NULL`,
  ).get(Number(shotId));
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SHOT_NOT_FOUND',
      '纸片工作室分镜不存在',
      { shot_id: Number(shotId) },
      404,
    );
  }
  const shot = rowToShot(row);
  const currentPlanRevisionId = Number(shot.current_plan_revision_id || 0);
  const familySummary = db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM paper_source_families WHERE shot_id = ? AND plan_revision_id = ? AND deleted_at IS NULL
     GROUP BY status`,
  ).all(Number(shotId), currentPlanRevisionId);
  const families = db.prepare(
    `SELECT * FROM paper_source_families
     WHERE shot_id = ? AND plan_revision_id = ? AND deleted_at IS NULL
     ORDER BY id`,
  ).all(Number(shotId), currentPlanRevisionId).map((family) => ({
    ...family,
    id: Number(family.id),
    shot_id: Number(family.shot_id),
    registration_canvas_json: parseJson(family.registration_canvas_json, {}),
    contract_json: parseJson(family.contract_json, {}),
    version: Number(family.version || 1),
    slots: db.prepare(
      `SELECT * FROM paper_asset_slots
       WHERE family_id = ? AND deleted_at IS NULL
       ORDER BY id`,
    ).all(Number(family.id)).map((slot) => {
      const hydrateVersion = (version) => {
        if (!version) return null;
        const localPath = version.alpha_local_path || version.source_local_path || version.mask_local_path || null;
        const decision = db.prepare(
          `SELECT id, decision, reason, reviewer, request_id, created_at
           FROM paper_asset_review_decisions
           WHERE asset_version_id = ? ORDER BY id DESC LIMIT 1`,
        ).get(Number(version.id));
        return {
          ...version,
          id: Number(version.id),
          attempt_index: Number(version.attempt_index || 1),
          parent_version_id: version.parent_version_id == null ? null : Number(version.parent_version_id),
          quality_report_json: parseJson(version.quality_report_json, {}),
          processing_json: parseJson(version.processing_json, {}),
          registration_json: parseJson(version.registration_json, {}),
          provenance_json: parseJson(version.provenance_json, {}),
          latest_review_decision: decision ? { ...decision, id: Number(decision.id) } : null,
          preview_url: localPath ? `/static/${String(localPath).replace(/^\/+/, '')}` : null,
        };
      };
      const current = slot.current_version_id == null ? null : db.prepare(
        `SELECT id, parent_version_id, attempt_index, derivation_kind, source_local_path, alpha_local_path,
                mask_local_path, source_hash, alpha_hash, processing_json, registration_json,
                provenance_json, quality_report_json, status,
                created_at, accepted_at, rejected_at
         FROM paper_asset_versions WHERE id = ? AND slot_id = ?`,
      ).get(Number(slot.current_version_id), Number(slot.id));
      const versions = db.prepare(
        `SELECT id, parent_version_id, attempt_index, derivation_kind, source_local_path, alpha_local_path,
                mask_local_path, source_hash, alpha_hash, processing_json, registration_json, provenance_json,
                quality_report_json, status, created_at, accepted_at, rejected_at
         FROM paper_asset_versions WHERE slot_id = ? ORDER BY id DESC LIMIT 20`,
      ).all(Number(slot.id)).map(hydrateVersion);
      return {
        ...slot,
        id: Number(slot.id),
        family_id: Number(slot.family_id),
        constraints_json: parseJson(slot.constraints_json, {}),
        required_for_gate: Boolean(slot.required_for_gate),
        version: Number(slot.version || 1),
        current_version: hydrateVersion(current),
        versions,
      };
    }),
  }));
  const nodes = db.prepare(
    `SELECT * FROM paper_composition_nodes
     WHERE shot_id = ? AND plan_revision_id = ? AND deleted_at IS NULL
     ORDER BY parent_node_id, local_z, id`,
  ).all(Number(shotId), currentPlanRevisionId).map((node) => ({
    ...node,
    id: Number(node.id),
    shot_id: Number(node.shot_id),
    parent_node_id: node.parent_node_id == null ? null : Number(node.parent_node_id),
    transform_json: parseJson(node.transform_json, {}),
    relation_json: parseJson(node.relation_json, {}),
    clip_json: parseJson(node.clip_json, {}),
    local_z: Number(node.local_z || 0),
    version: Number(node.version || 1),
  }));
  const motionRow = db.prepare(
    'SELECT * FROM paper_motion_plans WHERE shot_id = ? AND plan_revision_id = ?',
  ).get(Number(shotId), currentPlanRevisionId);
  const motionPlan = motionRow ? {
    ...motionRow,
    id: Number(motionRow.id),
    shot_id: Number(motionRow.shot_id),
    plan_json: parseJson(motionRow.plan_json, {}),
    compiled_tracks_json: parseJson(motionRow.compiled_tracks_json, {}),
    version: Number(motionRow.version || 1),
  } : null;
  const steps = db.prepare(
    `SELECT id, plan_revision_id, step_key, depends_on_json, status, attempt, max_attempts,
            result_json, error_json, started_at, completed_at, updated_at,
            authorization_id, user_visible_status
     FROM paper_job_steps WHERE shot_id = ? AND plan_revision_id = ? ORDER BY id`,
  ).all(Number(shotId), currentPlanRevisionId).map((step) => {
    const authorization = step.authorization_id == null ? null : db.prepare(
      'SELECT slot_scope_json FROM paper_generation_authorizations WHERE id = ? AND deleted_at IS NULL',
    ).get(Number(step.authorization_id));
    const authorizedSlotIds = parseJson(authorization?.slot_scope_json, [])
      .filter((item) => Number(item.shot_id) === Number(shotId))
      .map((item) => Number(item.slot_id));
    return {
      ...step,
      id: Number(step.id),
      authorization_id: step.authorization_id == null ? null : Number(step.authorization_id),
      authorized_slot_ids: authorizedSlotIds,
      depends_on_json: parseJson(step.depends_on_json, []),
      result_json: parseJson(step.result_json, {}),
      error_json: parseJson(step.error_json, {}),
    };
  });
  const snapshotRow = shot.current_snapshot_id == null ? null : db.prepare(
    `SELECT id, schema_version, renderer_version, snapshot_hash, render_hash,
            local_path, status, approved_at, created_at
     FROM paper_render_snapshots WHERE id = ? AND shot_id = ?`,
  ).get(Number(shot.current_snapshot_id), Number(shotId));
  const proofRuns = db.prepare(
    `SELECT id, snapshot_id, run_kind, scale, status, preview_local_path,
            report_json, proof_hash, created_at, completed_at
     FROM paper_proof_runs WHERE shot_id = ? ORDER BY id DESC LIMIT 12`,
  ).all(Number(shotId)).map((proof) => ({
    ...proof,
    id: Number(proof.id),
    snapshot_id: Number(proof.snapshot_id),
    scale: Number(proof.scale || 1),
    report_json: parseJson(proof.report_json, {}),
    preview_url: proof.preview_local_path && proof.run_kind === 'preview'
      ? `/static/${String(proof.preview_local_path).replace(/^\/+/, '')}`
      : null,
  }));
  const currentSnapshotId = shot.current_snapshot_id == null ? null : Number(shot.current_snapshot_id);
  const latestMotionProof = proofRuns.find((proof) => proof.run_kind === 'motion_proof' && Number(proof.snapshot_id) === currentSnapshotId) || null;
  const evidence = latestMotionProof ? db.prepare(
    `SELECT * FROM paper_proof_evidence
     WHERE proof_run_id = ? ORDER BY frame, id`,
  ).all(Number(latestMotionProof.id)).map((item) => ({
    ...item,
    id: Number(item.id),
    proof_run_id: Number(item.proof_run_id),
    frame: Number(item.frame),
    metrics_json: parseJson(item.metrics_json, {}),
    assertion_json: parseJson(item.assertion_json, []),
    full_url: item.full_local_path ? `/static/${String(item.full_local_path).replace(/^\/+/, '')}` : null,
    crop_url: item.crop_local_path ? `/static/${String(item.crop_local_path).replace(/^\/+/, '')}` : null,
    debug_url: item.debug_local_path ? `/static/${String(item.debug_local_path).replace(/^\/+/, '')}` : null,
  })) : [];
  const video = shot.published_video_generation_id == null ? null : db.prepare(
    `SELECT id, generation_kind, video_url, local_path, status, render_hash,
            renderer_version, paper_snapshot_id, completed_at
     FROM video_generations WHERE id = ? AND deleted_at IS NULL`,
  ).get(Number(shot.published_video_generation_id));
  const motionRevisions = db.prepare('SELECT * FROM paper_motion_revisions WHERE shot_id = ? ORDER BY id DESC LIMIT 20').all(Number(shotId)).map((revision) => ({
    ...revision,
    id: Number(revision.id),
    shot_id: Number(revision.shot_id),
    motion_plan_id: Number(revision.motion_plan_id),
    intent_json: parseJson(revision.intent_json, {}),
    patch_json: parseJson(revision.patch_json, {}),
    gate_report_json: parseJson(revision.gate_report_json, {}),
  }));
  const blueprint = shot.blueprint_revision_id == null
    ? null
    : blueprintService.getRevision(db, shot.blueprint_revision_id);
  const reviewableVersions = families.flatMap((family) => family.slots)
    .map((slot) => slot.current_version)
    .filter((version) => version?.status === 'accepted');
  const approvedVersions = reviewableVersions.filter((version) => version.latest_review_decision?.decision === 'approved');
  const requiredMissing = families.flatMap((family) => family.slots)
    .filter((slot) => slot.required_for_gate && (!slot.current_version || slot.status !== 'ready'));
  return {
    ...shot,
    family_summary: familySummary.map((item) => ({ ...item, count: Number(item.count || 0) })),
    families,
    composition_nodes: nodes,
    motion_plan: motionPlan,
    steps,
    current_snapshot: snapshotRow ? { ...snapshotRow, id: Number(snapshotRow.id) } : null,
    proof_runs: proofRuns,
    evidence,
    latest_preview: proofRuns.find((proof) => proof.run_kind === 'preview' && proof.status === 'completed' && Number(proof.snapshot_id) === currentSnapshotId) || null,
    formal_video: video ? { ...video, id: Number(video.id), paper_snapshot_id: Number(video.paper_snapshot_id) } : null,
    continuity: continuityService.listForShot(db, shot.id),
    motion_revisions: motionRevisions,
    blueprint,
    asset_review_progress: {
      total: reviewableVersions.length,
      approved: approvedVersions.length,
      remaining: Math.max(0, reviewableVersions.length - approvedVersions.length),
      required_missing_slot_ids: requiredMissing.map((slot) => Number(slot.id)),
      complete: reviewableVersions.length > 0 && approvedVersions.length === reviewableVersions.length && requiredMissing.length === 0,
    },
  };
}

module.exports = { rowToShot, listByRun, get };
