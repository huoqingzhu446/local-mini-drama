const reuseService = require('./paperAssetReuseService');
const { PaperStudioError, parseJson } = require('./paperStudioUtils');

function storyboardRow(db, storyboardId) {
  const row = db.prepare(
    `SELECT ps.*, pse.project_id, psp.drama_id
     FROM paper_storyboards ps
     JOIN paper_studio_episodes pse ON pse.id = ps.paper_episode_id
     JOIN paper_studio_projects psp ON psp.id = pse.project_id
     WHERE ps.id = ?`,
  ).get(Number(storyboardId));
  if (!row) throw new PaperStudioError('PAPER_STORYBOARD_NOT_FOUND', '纸片分镜不存在', { paper_storyboard_id: Number(storyboardId) }, 404);
  return row;
}

function pagination(input = {}) {
  const limit = Math.max(1, Math.min(50, Number(input.limit || 20)));
  const cursor = input.cursor == null || input.cursor === '' ? null : Number(input.cursor);
  return { limit, cursor: Number.isFinite(cursor) ? cursor : null };
}

function list(db, storyboardId, query = {}) {
  const storyboard = storyboardRow(db, storyboardId);
  const { limit, cursor } = pagination(query);
  const runs = db.prepare(
    `SELECT psr.id, psr.run_number, psr.status, psr.progress, psr.quality_tier,
            psr.style_signature, psr.created_at, psr.updated_at, psr.completed_at,
            psr.deleted_at, pss.id AS shot_id, pss.paper_storyboard_revision_id,
            pss.current_plan_revision_id, pss.status AS shot_status,
            (SELECT COUNT(*) FROM paper_plan_revisions ppr WHERE ppr.shot_id = pss.id) AS plan_revision_count,
            (SELECT COUNT(*) FROM paper_asset_versions pav
             JOIN paper_asset_slots pas ON pas.id = pav.slot_id
             JOIN paper_source_families psf ON psf.id = pas.family_id
             WHERE psf.shot_id = pss.id) AS asset_version_count
     FROM paper_studio_shots pss
     JOIN paper_studio_runs psr ON psr.id = pss.run_id
     WHERE pss.paper_storyboard_id = ?
       AND (? IS NULL OR psr.id < ?)
     ORDER BY psr.id DESC
     LIMIT ?`,
  ).all(Number(storyboardId), cursor, cursor, limit + 1);
  const hasMore = runs.length > limit;
  const totalRunCount = Number(db.prepare(
    `SELECT COUNT(*) AS count
     FROM paper_studio_shots pss
     JOIN paper_studio_runs psr ON psr.id = pss.run_id
     WHERE pss.paper_storyboard_id = ?`,
  ).get(Number(storyboardId))?.count || 0);
  const page = runs.slice(0, limit).map((run) => ({
    ...run,
    id: Number(run.id),
    shot_id: Number(run.shot_id),
    paper_storyboard_revision_id: run.paper_storyboard_revision_id == null ? null : Number(run.paper_storyboard_revision_id),
    current_plan_revision_id: run.current_plan_revision_id == null ? null : Number(run.current_plan_revision_id),
    plan_revision_count: Number(run.plan_revision_count || 0),
    asset_version_count: Number(run.asset_version_count || 0),
    archived: Boolean(run.deleted_at),
  }));
  const revisions = db.prepare(
    `SELECT id, revision_number, content_hash, created_from, created_at,
            (SELECT COUNT(*) FROM paper_studio_shots pss
             WHERE pss.paper_storyboard_revision_id = paper_storyboard_revisions.id) AS run_count,
            CASE WHEN id = ? THEN 1 ELSE 0 END AS is_current
     FROM paper_storyboard_revisions
     WHERE paper_storyboard_id = ?
     ORDER BY revision_number DESC, id DESC`,
  ).all(storyboard.current_revision_id, Number(storyboardId)).map((revision) => ({
    ...revision,
    id: Number(revision.id),
    revision_number: Number(revision.revision_number),
    run_count: Number(revision.run_count || 0),
    is_current: Boolean(revision.is_current),
  }));
  return {
    storyboard: {
      id: Number(storyboard.id),
      paper_episode_id: Number(storyboard.paper_episode_id),
      project_id: Number(storyboard.project_id),
      drama_id: Number(storyboard.drama_id),
      shot_number: Number(storyboard.shot_number),
      title: storyboard.title,
      status: storyboard.status,
      version: Number(storyboard.version || 1),
      current_revision_id: storyboard.current_revision_id == null ? null : Number(storyboard.current_revision_id),
      working_copy_base_revision_id: storyboard.working_copy_base_revision_id == null ? null : Number(storyboard.working_copy_base_revision_id),
      working_copy_fork_audit_id: storyboard.working_copy_fork_audit_id == null ? null : Number(storyboard.working_copy_fork_audit_id),
      archived: Boolean(storyboard.deleted_at),
    },
    script_revisions: revisions,
    runs: page,
    total_run_count: totalRunCount,
    timezone: 'Asia/Shanghai',
    page: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore ? Number(page[page.length - 1].id) : null,
    },
  };
}

function revisionDetail(db, storyboardId, revisionId) {
  const storyboard = storyboardRow(db, storyboardId);
  const revision = db.prepare(
    `SELECT * FROM paper_storyboard_revisions
     WHERE id = ? AND paper_storyboard_id = ?`,
  ).get(Number(revisionId), Number(storyboardId));
  if (!revision) {
    throw new PaperStudioError(
      'PAPER_HISTORY_SOURCE_NOT_FOUND',
      '该脚本修订不存在或不属于当前分镜',
      { paper_storyboard_id: Number(storyboardId), revision_id: Number(revisionId) },
      404,
    );
  }
  const current = storyboard.current_revision_id == null ? null : db.prepare(
    'SELECT id, revision_number, content_json FROM paper_storyboard_revisions WHERE id = ? AND paper_storyboard_id = ?',
  ).get(Number(storyboard.current_revision_id), Number(storyboardId));
  const content = parseJson(revision.content_json, {});
  const currentContent = parseJson(current?.content_json, {});
  const ignored = new Set(['schema_version', 'paper_storyboard_id', 'paper_episode_id']);
  const changedFields = [...new Set([...Object.keys(content), ...Object.keys(currentContent)])]
    .filter((key) => !ignored.has(key) && JSON.stringify(content[key] ?? null) !== JSON.stringify(currentContent[key] ?? null));
  const relatedRuns = db.prepare(
    `SELECT psr.id, psr.run_number, psr.status, psr.created_at, psr.completed_at,
            pss.id AS shot_id
     FROM paper_studio_shots pss
     JOIN paper_studio_runs psr ON psr.id = pss.run_id
     WHERE pss.paper_storyboard_id = ? AND pss.paper_storyboard_revision_id = ?
     ORDER BY psr.id DESC`,
  ).all(Number(storyboardId), Number(revisionId)).map((run) => ({
    ...run,
    id: Number(run.id),
    run_number: Number(run.run_number),
    shot_id: Number(run.shot_id),
  }));
  return {
    id: Number(revision.id),
    paper_storyboard_id: Number(revision.paper_storyboard_id),
    revision_number: Number(revision.revision_number),
    content_hash: revision.content_hash,
    created_from: revision.created_from,
    created_at: revision.created_at,
    is_current: Number(revision.id) === Number(storyboard.current_revision_id),
    content,
    related_runs: relatedRuns,
    diff_from_current: {
      current_revision_id: current?.id == null ? null : Number(current.id),
      current_revision_number: current?.revision_number == null ? null : Number(current.revision_number),
      changed_fields: changedFields,
    },
  };
}

function hydrateAssetVersion(row) {
  const localPath = row.alpha_local_path || row.source_local_path || row.mask_local_path || null;
  return {
    ...row,
    id: Number(row.id),
    slot_id: Number(row.slot_id),
    parent_version_id: row.parent_version_id == null ? null : Number(row.parent_version_id),
    image_generation_id: row.image_generation_id == null ? null : Number(row.image_generation_id),
    attempt_index: Number(row.attempt_index || 1),
    processing_json: parseJson(row.processing_json, {}),
    registration_json: parseJson(row.registration_json, {}),
    provenance_json: parseJson(row.provenance_json, {}),
    quality_report_json: parseJson(row.quality_report_json, {}),
    preview_url: localPath ? `/static/${String(localPath).replace(/^\/+/, '')}` : null,
  };
}

function runDetail(db, storyboardId, runId) {
  storyboardRow(db, storyboardId);
  const shot = db.prepare(
    `SELECT pss.*, psr.run_number, psr.status AS run_status, psr.quality_tier,
            psr.style_signature, psr.created_at AS run_created_at, psr.deleted_at AS run_deleted_at
     FROM paper_studio_shots pss
     JOIN paper_studio_runs psr ON psr.id = pss.run_id
     WHERE pss.paper_storyboard_id = ? AND psr.id = ?`,
  ).get(Number(storyboardId), Number(runId));
  if (!shot) {
    throw new PaperStudioError('PAPER_STUDIO_HISTORY_RUN_NOT_FOUND', '该生产版本不属于当前纸片分镜', { paper_storyboard_id: Number(storyboardId), run_id: Number(runId) }, 404);
  }
  const plans = db.prepare(
    `SELECT * FROM paper_plan_revisions WHERE shot_id = ?
     ORDER BY revision_number DESC, id DESC`,
  ).all(Number(shot.id)).map((plan) => {
    const families = db.prepare(
      `SELECT * FROM paper_source_families
       WHERE shot_id = ? AND plan_revision_id = ? ORDER BY id`,
    ).all(Number(shot.id), Number(plan.id)).map((family) => ({
      ...family,
      id: Number(family.id),
      plan_revision_id: Number(family.plan_revision_id),
      registration_canvas_json: parseJson(family.registration_canvas_json, {}),
      contract_json: parseJson(family.contract_json, {}),
      archived: Boolean(family.deleted_at),
      slots: db.prepare(
        'SELECT * FROM paper_asset_slots WHERE family_id = ? ORDER BY id',
      ).all(Number(family.id)).map((slot) => ({
        ...slot,
        id: Number(slot.id),
        family_id: Number(slot.family_id),
        current_version_id: slot.current_version_id == null ? null : Number(slot.current_version_id),
        required_for_gate: Boolean(slot.required_for_gate),
        constraints_json: parseJson(slot.constraints_json, {}),
        archived: Boolean(slot.deleted_at),
        versions: db.prepare(
          'SELECT * FROM paper_asset_versions WHERE slot_id = ? ORDER BY id DESC',
        ).all(Number(slot.id)).map(hydrateAssetVersion),
      })),
    }));
    const nodes = db.prepare(
      `SELECT id, node_key, parent_node_id, node_kind, pattern, slot, asset_version_id,
              local_z, status, created_at, updated_at, deleted_at
       FROM paper_composition_nodes WHERE plan_revision_id = ? ORDER BY id`,
    ).all(Number(plan.id)).map((node) => ({ ...node, id: Number(node.id), archived: Boolean(node.deleted_at) }));
    const motion = db.prepare(
      'SELECT * FROM paper_motion_plans WHERE plan_revision_id = ?',
    ).get(Number(plan.id));
    const steps = db.prepare(
      `SELECT id, step_key, status, attempt, max_attempts, result_json, error_json,
              created_at, updated_at, completed_at
       FROM paper_job_steps WHERE plan_revision_id = ? ORDER BY id`,
    ).all(Number(plan.id)).map((step) => ({
      ...step,
      id: Number(step.id),
      result_json: parseJson(step.result_json, {}),
      error_json: parseJson(step.error_json, {}),
    }));
    return {
      ...plan,
      id: Number(plan.id),
      shot_id: Number(plan.shot_id),
      revision_number: Number(plan.revision_number),
      blueprint_revision_id: plan.blueprint_revision_id == null ? null : Number(plan.blueprint_revision_id),
      transition_report_json: parseJson(plan.transition_report_json, {}),
      is_current: Number(plan.id) === Number(shot.current_plan_revision_id),
      families,
      composition_nodes: nodes,
      motion_plan: motion ? {
        ...motion,
        id: Number(motion.id),
        plan_json: parseJson(motion.plan_json, {}),
        compiled_tracks_json: parseJson(motion.compiled_tracks_json, {}),
      } : null,
      job_steps: steps,
    };
  });
  return {
    run: {
      id: Number(runId),
      run_number: Number(shot.run_number),
      status: shot.run_status,
      quality_tier: shot.quality_tier,
      style_signature: shot.style_signature,
      created_at: shot.run_created_at,
      archived: Boolean(shot.run_deleted_at),
    },
    shot: {
      id: Number(shot.id),
      status: shot.status,
      paper_storyboard_id: Number(shot.paper_storyboard_id),
      paper_storyboard_revision_id: Number(shot.paper_storyboard_revision_id),
      current_plan_revision_id: Number(shot.current_plan_revision_id),
      archived: Boolean(shot.deleted_at),
    },
    plan_revisions: plans,
  };
}

function assetDetail(db, cfg, storyboardId, assetVersionId) {
  storyboardRow(db, storyboardId);
  const row = db.prepare(
    `SELECT pav.*, pas.slot_key, pas.asset_type, pas.generation_purpose, pas.constraints_json,
            psf.family_key, psf.plan_revision_id, psf.shot_id,
            pss.run_id, pss.paper_storyboard_id, pss.paper_storyboard_revision_id
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id
     WHERE pav.id = ? AND pss.paper_storyboard_id = ?`,
  ).get(Number(assetVersionId), Number(storyboardId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_HISTORY_ASSET_NOT_FOUND', '历史素材不存在或不属于当前纸片分镜', { asset_version_id: Number(assetVersionId) }, 404);
  const generation = row.image_generation_id == null ? null : db.prepare(
    `SELECT id, provider, model, status, provider_call_count, request_fingerprint,
            error_msg, created_at, updated_at
     FROM image_generations WHERE id = ?`,
  ).get(Number(row.image_generation_id));
  const reviews = db.prepare(
    'SELECT * FROM paper_asset_review_decisions WHERE asset_version_id = ? ORDER BY id DESC',
  ).all(Number(row.id));
  const reusedFrom = db.prepare(
    'SELECT * FROM paper_asset_reuse_links WHERE target_asset_version_id = ?',
  ).get(Number(row.id));
  const reuseDestinations = db.prepare(
    'SELECT * FROM paper_asset_reuse_links WHERE source_asset_version_id = ? ORDER BY id DESC',
  ).all(Number(row.id));
  return {
    asset: {
      ...hydrateAssetVersion(row),
      constraints_json: parseJson(row.constraints_json, {}),
      file_integrity: reuseService.verifyVersionFile(cfg, row),
    },
    generation: generation ? { ...generation, id: Number(generation.id), provider_call_count: Number(generation.provider_call_count || 0) } : null,
    reviews: reviews.map((review) => ({ ...review, id: Number(review.id) })),
    reused_from: reusedFrom ? { ...reusedFrom, compatibility_report_json: parseJson(reusedFrom.compatibility_report_json, {}) } : null,
    reuse_destinations: reuseDestinations.map((link) => ({ ...link, compatibility_report_json: parseJson(link.compatibility_report_json, {}) })),
  };
}

module.exports = { list, revisionDetail, runDetail, assetDetail };
