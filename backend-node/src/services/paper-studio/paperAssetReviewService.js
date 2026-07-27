const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const runAggregateService = require('./paperRunAggregateService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
  parseJson,
} = require('./paperStudioUtils');

function currentVersions(db, shotId) {
  return db.prepare(
    `SELECT pav.*, pas.id AS slot_id, pas.slot_key, pas.required_for_gate,
            psf.id AS family_id, psf.family_key
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ? AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shotId)).map((row) => {
    const decision = db.prepare(
      `SELECT id, decision, reason, reviewer, request_id, created_at
       FROM paper_asset_review_decisions
       WHERE asset_version_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(Number(row.id));
    return {
      ...row,
      required_for_gate: Boolean(row.required_for_gate),
      latest_review_decision: decision ? { ...decision, id: Number(decision.id) } : null,
    };
  });
}

function reviewProgress(rows) {
  const reviewable = rows.filter((row) => row.status === 'accepted');
  const approved = reviewable.filter((row) => row.latest_review_decision?.decision === 'approved');
  const requiredMissing = rows.filter((row) => row.required_for_gate && row.status !== 'accepted');
  return {
    total: reviewable.length,
    approved: approved.length,
    remaining: Math.max(0, reviewable.length - approved.length),
    required_missing_slot_ids: requiredMissing.map((row) => Number(row.slot_id)),
    complete: reviewable.length > 0 && approved.length === reviewable.length && requiredMissing.length === 0,
  };
}

function insertDecision(db, shot, row, body, decision, reason = null) {
  const existing = db.prepare(
    'SELECT * FROM paper_asset_review_decisions WHERE asset_version_id = ? AND request_id = ?',
  ).get(Number(row.id), body.request_id);
  if (existing) return { ...existing, id: Number(existing.id), deduplicated: true };
  const result = db.prepare(
    `INSERT INTO paper_asset_review_decisions
      (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'local_user', ?, ?)`,
  ).run(Number(shot.id), Number(row.slot_id), Number(row.id), decision, reason, body.request_id, nowIso());
  return { id: Number(result.lastInsertRowid), decision, reason, request_id: body.request_id, deduplicated: false };
}

function reviewedQuality(row, review) {
  return JSON.stringify({
    ...parseJson(row.quality_report_json, {}),
    semantic_review: review,
  });
}

function approve(db, shot, body, rows) {
  if (shot.status !== 'asset_review') {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REVIEW_STATE_CONFLICT', '当前镜头没有待批准的独立素材', { shot_id: shot.id, status: shot.status }, 409);
  }
  const wanted = new Set(body.asset_version_ids.map(Number));
  const selected = rows.filter((row) => wanted.has(Number(row.id)));
  if (selected.length !== 1) throw new PaperStudioError('PAPER_STUDIO_ASSET_VERSION_NOT_CURRENT', '一次只能批准当前正在使用的一张素材', { asset_version_ids: [...wanted] }, 409);
  if (selected[0].status !== 'accepted') throw new PaperStudioError('PAPER_STUDIO_ASSET_TECHNICAL_GATE_REQUIRED', '该素材尚未通过尺寸或透明通道技术门禁', { asset_version_id: Number(selected[0].id) }, 409);
  const now = nowIso();
  const review = { status: 'approved', request_id: body.request_id, reviewed_at: now, asset_version_id: Number(selected[0].id) };
  let progress;
  let decision;
  const transaction = db.transaction(() => {
    decision = insertDecision(db, shot, selected[0], body, 'approved');
    db.prepare('UPDATE paper_asset_versions SET quality_report_json = ? WHERE id = ?')
      .run(reviewedQuality(selected[0], review), Number(selected[0].id));
    progress = reviewProgress(currentVersions(db, shot.id));
    if (progress.complete) {
      db.prepare("UPDATE paper_source_families SET status = 'ready', version = version + 1, updated_at = ? WHERE shot_id = ? AND deleted_at IS NULL").run(now, Number(shot.id));
      db.prepare("UPDATE paper_studio_shots SET status = 'asset_ready', attention_required = 'none', last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?").run(now, Number(shot.id));
      db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key = 'asset_gate'")
        .run(JSON.stringify({ semantic_review: { status: 'approved', completed_at: now }, asset_version_ids: rows.map((row) => Number(row.id)) }), now, now, Number(shot.run_id), Number(shot.id));
    } else {
      db.prepare("UPDATE paper_studio_shots SET attention_required = 'review_assets', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, Number(shot.id));
    }
  });
  transaction();
  runAggregateService.sync(db, shot.run_id);
  return { shot: shotService.get(db, shot.id), review, decision, progress };
}

function reject(db, shot, body, rows) {
  if (!['asset_review', 'asset_ready', 'motion_ready', 'proof_ready', 'preview_ready', 'asset_failed'].includes(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REVIEW_STATE_CONFLICT', '当前镜头状态不允许退回素材', { shot_id: shot.id, status: shot.status }, 409);
  }
  const wanted = new Set(body.asset_version_ids.map(Number));
  const selected = rows.filter((row) => wanted.has(Number(row.id)));
  if (selected.length !== 1 || wanted.size !== 1) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_VERSION_NOT_CURRENT', '一次只能退回当前正在使用的一张素材', { shot_id: shot.id, asset_version_ids: [...wanted] }, 409);
  }
  const now = nowIso();
  const review = { status: 'rejected', request_id: body.request_id, reason: body.reason.trim(), reviewed_at: now };
  const transaction = db.transaction(() => {
    insertDecision(db, shot, selected[0], body, 'rejected', review.reason);
    const rejectVersion = db.prepare("UPDATE paper_asset_versions SET status = 'rejected', rejected_at = ?, quality_report_json = ? WHERE id = ?");
    const rejectSlot = db.prepare("UPDATE paper_asset_slots SET current_version_id = NULL, status = 'failed', version = version + 1, updated_at = ? WHERE id = ? AND current_version_id = ?");
    selected.forEach((row) => {
      rejectVersion.run(now, reviewedQuality(row, review), Number(row.id));
      rejectSlot.run(now, Number(row.slot_id), Number(row.id));
    });
    for (const familyId of new Set(selected.map((row) => Number(row.family_id)))) {
      db.prepare("UPDATE paper_source_families SET status = 'failed', version = version + 1, updated_at = ? WHERE id = ?").run(now, familyId);
    }
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')").run(Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('passed','completed')").run(Number(shot.id));
    db.prepare("UPDATE paper_motion_plans SET status = 'draft', version = version + 1, updated_at = ? WHERE shot_id = ?").run(now, Number(shot.id));
    db.prepare(`UPDATE paper_studio_shots
      SET status = 'asset_failed', current_snapshot_id = NULL, approved_snapshot_id = NULL,
          last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ code: 'PAPER_STUDIO_ASSET_SEMANTIC_REJECTED', message: review.reason, asset_version_ids: [...wanted] }), now, Number(shot.id));
    db.prepare(`UPDATE paper_job_steps
      SET status = CASE WHEN step_key = 'generate_layout_master' THEN 'blocked_user_authorization' ELSE 'queued' END,
          attempt = attempt + 1, result_json = '{}', error_json = '{}',
          authorization_id = CASE WHEN step_key = 'generate_layout_master' THEN NULL ELSE authorization_id END,
          blocked_reason = CASE WHEN step_key = 'generate_layout_master' THEN 'user_authorization_required' ELSE NULL END,
          user_visible_status = CASE WHEN step_key = 'generate_layout_master' THEN 'waiting_for_authorization' ELSE 'queued' END,
          lease_owner = NULL, lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE run_id = ? AND shot_id = ? AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets','asset_gate','plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview','wait_preview_approval','render_formal','publish_video')`)
      .run(now, Number(shot.run_id), Number(shot.id));
    db.prepare("UPDATE paper_studio_shots SET attention_required = 'authorize_generation' WHERE id = ?")
      .run(Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET active_authorization_id = NULL, attention_required = 'authorize_generation', updated_at = ? WHERE id = ?")
      .run(now, Number(shot.run_id));
    db.prepare("UPDATE paper_generation_authorizations SET status = 'consumed', version = version + 1, updated_at = ? WHERE run_id = ? AND status = 'executing'")
      .run(now, Number(shot.run_id));
  });
  transaction();
  runAggregateService.sync(db, shot.run_id);
  return { shot: shotService.get(db, shot.id), review, rejected_asset_version_ids: [...wanted] };
}

function review(db, log, shotId, body = {}) {
  schemaService.assertValid('apiAssetReview', body, '素材语义审核参数无效');
  if (!body.asset_version_ids?.length) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REVIEW_TARGET_REQUIRED', '请先打开并选择一张当前素材再审核', null, 400);
  }
  if (body.action === 'reject' && !String(body.reason || '').trim()) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REJECTION_REASON_REQUIRED', '退回素材必须选择当前版本并填写原因', null, 400);
  }
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  const rows = currentVersions(db, shot.id);
  const result = body.action === 'approve' ? approve(db, shot, body, rows) : reject(db, shot, body, rows);
  if (log) log.info('Paper studio asset semantic review', { shot_id: Number(shot.id), action: body.action, reviewed_versions: body.action === 'approve' ? rows.length : body.asset_version_ids.length });
  return result;
}

module.exports = { currentVersions, reviewProgress, review };
