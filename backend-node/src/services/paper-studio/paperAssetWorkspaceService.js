const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const runAggregateService = require('./paperRunAggregateService');
const storageLayout = require('../storageLayout');
const assetProductionService = require('./paperAssetProductionService');
const spatialContractService = require('./paperSpatialContractService');
const matteThresholds = require('./paperMatteThresholds');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const EDITABLE_STATES = new Set([
  // A confirmed blueprint already has immutable, addressable slots. Allowing
  // uploads here lets a user complete production with their own files without
  // being forced to authorize an image API call first.
  'plan_confirmed', 'asset_review', 'asset_failed', 'asset_ready', 'motion_failed', 'motion_ready',
  'proof_failed', 'proof_ready', 'preview_ready', 'approved', 'render_failed', 'rendered',
]);

function normalizeMultipartBody(body = {}) {
  return {
    request_id: String(body.request_id || ''),
    expected_version: Number(body.expected_version),
  };
}

function slotContext(db, shotId, slotId) {
  const row = db.prepare(
    `SELECT pas.*, psf.shot_id, psf.family_key, psf.plan_revision_id
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots ps ON ps.id = psf.shot_id
     WHERE pas.id = ? AND psf.shot_id = ?
       AND psf.plan_revision_id = ps.current_plan_revision_id
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL`,
  ).get(Number(slotId), Number(shotId));
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_SLOT_NOT_FOUND',
      '素材槽位不存在或不属于当前镜头',
      { shot_id: Number(shotId), slot_id: Number(slotId) },
      404,
    );
  }
  return {
    ...row,
    id: Number(row.id),
    family_id: Number(row.family_id),
    shot_id: Number(row.shot_id),
    current_version_id: row.current_version_id == null ? null : Number(row.current_version_id),
    required_for_gate: Boolean(row.required_for_gate),
    constraints_json: parseJson(row.constraints_json, {}),
  };
}

function nextVersion(db, slot, derivationKind, provenance = {}) {
  const attempt = db.prepare(
    'SELECT COALESCE(MAX(attempt_index), 0) + 1 AS next_attempt FROM paper_asset_versions WHERE slot_id = ?',
  ).get(Number(slot.id));
  const result = db.prepare(
    `INSERT INTO paper_asset_versions
      (slot_id, source_family_id, parent_version_id, attempt_index, derivation_kind,
       reuse_fingerprint, processing_json, registration_json, provenance_json, quality_report_json,
       status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, '{}', 'candidate', ?)`,
  ).run(
    Number(slot.id), Number(slot.family_id), slot.current_version_id,
    Number(attempt.next_attempt), derivationKind, slot.reuse_fingerprint || null,
    JSON.stringify(provenance), nowIso(),
  );
  return Number(result.lastInsertRowid);
}

function versionPath(db, cfg, shot, versionId, slotKey) {
  const projectDir = storageLayout.getProjectStorageSubdir(db, shot.drama_id);
  const relative = `${projectDir}/paper-studio/runs/${shot.run_id}/shots/${shot.id}/assets/v${versionId}-${slotKey}.png`.replace(/\\/g, '/');
  const absolute = assetProductionService.safeStorageFile(cfg, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return { relative, absolute };
}

function inspectRgba(data, info, requireAlpha) {
  const pixels = Number(info.width) * Number(info.height);
  let transparent = 0;
  let visible = 0;
  let partial = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha < 20) transparent += 1;
      if (alpha > 235) visible += 1;
      else if (alpha >= 20) partial += 1;
      if (alpha >= 20) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const transparentRatio = pixels ? transparent / pixels : 0;
  const visibleRatio = pixels ? (visible + partial) / pixels : 0;
  const alphaBbox = maxX >= 0 ? {
    x: minX / info.width,
    y: minY / info.height,
    width: (maxX - minX + 1) / info.width,
    height: (maxY - minY + 1) / info.height,
  } : {};
  return {
    pass: !requireAlpha || matteThresholds.alphaGate({ transparentRatio, visibleRatio }),
    width: Number(info.width),
    height: Number(info.height),
    transparent_ratio: Number(transparentRatio.toFixed(6)),
    visible_ratio: Number(visibleRatio.toFixed(6)),
    partial_alpha_ratio: Number((pixels ? partial / pixels : 0).toFixed(6)),
    alpha_bbox: alphaBbox,
    matte_method: 'user_supplied_alpha',
  };
}

async function decodeImage(input) {
  try {
    return await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_UPLOAD_INVALID', '上传文件不是可读取的图片', { error: error.message }, 422);
  }
}

function recordReplacement(db, shot, slot, previousVersionId, requestId, reason) {
  if (!previousVersionId) return;
  db.prepare(
    `INSERT OR IGNORE INTO paper_asset_review_decisions
      (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
     VALUES (?, ?, ?, 'replaced', ?, 'local_user', ?, ?)`,
  ).run(Number(shot.id), Number(slot.id), Number(previousVersionId), reason, requestId, nowIso());
}

function invalidateDownstream(db, shot, now) {
  db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')")
    .run(Number(shot.id));
  db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('pending','running','passed','completed')")
    .run(Number(shot.id));
  db.prepare("UPDATE paper_motion_plans SET status = 'draft', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ? AND plan_revision_id = ?")
    .run(now, Number(shot.id), Number(shot.current_plan_revision_id));
  db.prepare(
    `UPDATE paper_job_steps
     SET status = 'queued', result_json = '{}', error_json = '{}', lease_owner = NULL,
         lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
     WHERE run_id = ? AND shot_id = ? AND step_key IN
       ('asset_gate','plan_motion','compile_snapshot','render_proof','dynamic_gate',
        'render_preview','wait_preview_approval','render_formal','publish_video')
       AND plan_revision_id = ?`,
  ).run(now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id));
}

function allRequiredSlotsReady(db, shotId) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS count
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     WHERE psf.shot_id = ? AND pas.required_for_gate = 1
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
       AND (pas.current_version_id IS NULL OR pas.status != 'ready')`,
  ).get(Number(shotId), Number(shotId))?.count || 0) === 0;
}

function activateVersion(db, shot, slot, versionId, requestId, reason) {
  const now = nowIso();
  const ready = allRequiredSlotsReadyAfter(db, shot.id, slot.id, versionId);
  const status = ready ? 'asset_review' : 'asset_failed';
  db.transaction(() => {
    recordReplacement(db, shot, slot, slot.current_version_id, requestId, reason);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?")
      .run(Number(versionId), now, Number(slot.id));
    db.prepare("UPDATE paper_source_families SET status = 'review', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, Number(slot.family_id));
    invalidateDownstream(db, shot, now);
    db.prepare(
      `UPDATE paper_studio_shots
       SET status = ?, attention_required = ?, current_snapshot_id = NULL,
           approved_snapshot_id = NULL, last_error_json = '{}',
           version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(status, ready ? 'review_assets' : 'authorize_generation', now, Number(shot.id));
    db.prepare(
      `UPDATE paper_studio_runs
       SET status = ?, progress = 38, attention_required = ?,
           last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(ready ? 'assets_processing' : 'partial', ready ? 'review_assets' : 'authorize_generation', now, Number(shot.run_id));
  })();
}

function allRequiredSlotsReadyAfter(db, shotId, replacingSlotId, versionId) {
  if (!versionId) return allRequiredSlotsReady(db, shotId);
  const missing = db.prepare(
    `SELECT pas.id
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     WHERE psf.shot_id = ? AND pas.required_for_gate = 1
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
       AND pas.id != ? AND (pas.current_version_id IS NULL OR pas.status != 'ready')
     LIMIT 1`,
  ).get(Number(shotId), Number(shotId), Number(replacingSlotId));
  return !missing;
}

function assertReusableSourceCompatibility(targetShot, targetSlot, source) {
  if (Number(targetShot.drama_id) !== Number(source.drama_id)) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_PROJECT_MISMATCH', '只能复用同一剧集项目中的已批准素材', null, 409);
  }
  if (String(targetSlot.asset_type) !== String(source.asset_type)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REUSE_TYPE_MISMATCH',
      '源素材类型与目标槽位不一致',
      { source_asset_type: source.asset_type, target_asset_type: targetSlot.asset_type },
      409,
    );
  }
  const sourceApproved = source.latest_review_decision == null
    ? Number(source.approved_review_count || 0) > 0
    : source.latest_review_decision === 'approved';
  if (source.status !== 'accepted' || !sourceApproved) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_NOT_APPROVED', '只能复用已通过人工审核的正式素材版本', { source_asset_version_id: Number(source.id) }, 409);
  }
  const archiveImport = parseJson(source.provenance_json, {})?.archive_import || null;
  if (archiveImport?.import_trust_state === 'review_required'
      && Number(source.review_decision_count || 0) <= Number(archiveImport.imported_review_decision_count || 0)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REUSE_IMPORT_TRUST_REQUIRED',
      '导入素材需要在当前设备重新审核确认后才能复用',
      { source_asset_version_id: Number(source.id), import_trust_state: 'review_required' },
      409,
    );
  }
  if (targetShot.paper_storyboard_id != null || source.paper_storyboard_id != null) {
    const sameStoryboard = Number(targetShot.paper_storyboard_id) === Number(source.paper_storyboard_id);
    if (!sameStoryboard) {
      throw new PaperStudioError(
        'PAPER_STUDIO_ASSET_REUSE_STORYBOARD_MISMATCH',
        '历史素材必须来自同一个纸片分镜',
        {
          source_paper_storyboard_id: source.paper_storyboard_id == null ? null : Number(source.paper_storyboard_id),
          source_paper_storyboard_revision_id: source.paper_storyboard_revision_id == null ? null : Number(source.paper_storyboard_revision_id),
          target_paper_storyboard_id: targetShot.paper_storyboard_id == null ? null : Number(targetShot.paper_storyboard_id),
          target_paper_storyboard_revision_id: targetShot.paper_storyboard_revision_id == null ? null : Number(targetShot.paper_storyboard_revision_id),
        },
        409,
      );
    }
  }
  if (!targetSlot.reuse_fingerprint || targetSlot.reuse_fingerprint !== source.reuse_fingerprint) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REUSE_VISUAL_CONTRACT_MISMATCH',
      '源素材与目标槽位的静态视觉合同不一致，只能作为人工比较候选',
      {
        source_reuse_fingerprint: source.reuse_fingerprint || null,
        target_reuse_fingerprint: targetSlot.reuse_fingerprint || null,
      },
      409,
    );
  }
  const targetIdentity = String(targetSlot.constraints_json?.identity || '').trim();
  const sourceIdentity = String(parseJson(source.constraints_json, {}).identity || '').trim();
  if (targetIdentity && sourceIdentity && targetIdentity !== sourceIdentity) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REUSE_IDENTITY_MISMATCH',
      '源素材主体与目标槽位要求的主体不一致',
      { source_identity: sourceIdentity, target_identity: targetIdentity },
      409,
    );
  }
  if (targetSlot.asset_type === 'environment' && parseJson(source.quality_report_json, {}).reference_gate_passed === false) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_REFERENCE_GATE_FAILED', '源环境素材未通过构图参考门禁，不能复用', { source_asset_version_id: Number(source.id) }, 409);
  }
}

function reuseAcceptedVersion(db, cfg, log, shotId, slotId, sourceVersionId, body = {}) {
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!EDITABLE_STATES.has(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_STATE_CONFLICT', '当前镜头状态不允许复用正式素材', { shot_id: shot.id, status: shot.status }, 409);
  }
  const slot = slotContext(db, shot.id, slotId);
  const source = db.prepare(
    `SELECT pav.*, pas.asset_type, pas.constraints_json, psf.shot_id AS source_shot_id,
            ps.drama_id, ps.paper_storyboard_id, ps.paper_storyboard_revision_id,
            (SELECT decision FROM paper_asset_review_decisions
             WHERE asset_version_id = pav.id ORDER BY id DESC LIMIT 1) AS latest_review_decision,
            (SELECT COUNT(*) FROM paper_asset_review_decisions
             WHERE asset_version_id = pav.id) AS review_decision_count
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots ps ON ps.id = psf.shot_id
     WHERE pav.id = ? AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL AND ps.deleted_at IS NULL`,
  ).get(Number(sourceVersionId));
  if (!source) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_SOURCE_NOT_FOUND', '要复用的正式素材版本不存在', { source_asset_version_id: Number(sourceVersionId) }, 404);
  }
  assertReusableSourceCompatibility(shot, slot, source);
  const sourceRelative = source.alpha_local_path || source.source_local_path;
  const expectedHash = source.alpha_hash || source.source_hash;
  if (!sourceRelative || !expectedHash) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_HASH_MISMATCH', '源正式素材没有可验证的文件或哈希，不能复用', { source_asset_version_id: Number(source.id) }, 409);
  }
  const sourceAbsolute = assetProductionService.safeStorageFile(cfg, sourceRelative);
  if (!fs.existsSync(sourceAbsolute) || sha256(fs.readFileSync(sourceAbsolute)) !== expectedHash) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_REUSE_HASH_MISMATCH', '源正式素材文件缺失或哈希不一致，不能复用', { source_asset_version_id: Number(source.id) }, 409);
  }
  const provenance = {
    request_id: body.request_id,
    source_asset_version_id: Number(source.id),
    source_shot_id: Number(source.source_shot_id),
    reuse_kind: 'same_storyboard_revision',
  };
  const versionId = nextVersion(db, slot, 'historical_reuse', provenance);
  const target = versionPath(db, cfg, shot, versionId, slot.slot_key);
  try {
    fs.copyFileSync(sourceAbsolute, target.absolute);
    const copiedHash = sha256(fs.readFileSync(target.absolute));
    const requireAlpha = slot.asset_type !== 'environment';
    const sourceQuality = parseJson(source.quality_report_json, {});
    const registration = spatialContractService.rawRegistration({
      ...source,
      constraints_json: slot.constraints_json,
    }) || parseJson(source.registration_json, {});
    db.prepare(
      `UPDATE paper_asset_versions
       SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
           processing_json = ?, registration_json = ?, provenance_json = ?, quality_report_json = ?,
           status = 'accepted', accepted_at = ?
       WHERE id = ?`,
    ).run(
      target.relative, requireAlpha ? target.relative : null, copiedHash, requireAlpha ? copiedHash : null,
      JSON.stringify({ ...parseJson(source.processing_json, {}), source: 'accepted_version_reuse' }),
      JSON.stringify(registration || {}), JSON.stringify(provenance),
      JSON.stringify({ ...sourceQuality, semantic_review: { status: 'inherited_pending_confirmation', source_asset_version_id: Number(source.id) } }),
      nowIso(), Number(versionId),
    );
  } catch (error) {
    try { if (fs.existsSync(target.absolute)) fs.unlinkSync(target.absolute); } catch (_) { /* best effort cleanup */ }
    db.prepare('DELETE FROM paper_asset_versions WHERE id = ? AND status = ?').run(Number(versionId), 'candidate');
    throw error;
  }
  activateVersion(db, shot, slot, versionId, body.request_id, `复用已批准正式素材 v${source.id}`);
  db.prepare(
    `INSERT INTO paper_asset_reuse_links
      (source_asset_version_id, target_asset_version_id, target_shot_id, target_slot_id,
       match_kind, compatibility_report_json, source_file_hash, request_id, created_at)
     VALUES (?, ?, ?, ?, 'exact', ?, ?, ?, ?)`,
  ).run(
    Number(source.id), versionId, Number(shot.id), Number(slot.id),
    JSON.stringify({ reuse_fingerprint: slot.reuse_fingerprint, file_verified: true }),
    expectedHash, body.request_id || null, nowIso(),
  );
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio approved asset reused', { shot_id: shot.id, slot_id: slot.id, source_asset_version_id: Number(source.id), asset_version_id: versionId });
  return { shot: shotService.get(db, shot.id), asset_version_id: versionId, source_asset_version_id: Number(source.id), slot_id: slot.id };
}

async function uploadReplacement(db, cfg, log, shotId, slotId, body = {}, file = null) {
  const input = normalizeMultipartBody(body);
  schemaService.assertValid('apiAssetUpload', input, '上传替换素材的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, input.expected_version, '纸片动画镜头');
  if (!EDITABLE_STATES.has(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_UPLOAD_STATE_CONFLICT', '当前镜头状态不允许替换正式素材', { shot_id: shot.id, status: shot.status }, 409);
  }
  if (!file?.buffer?.length) throw new PaperStudioError('PAPER_STUDIO_ASSET_FILE_REQUIRED', '请选择要上传的素材图片', null, 400);
  const slot = slotContext(db, shot.id, slotId);
  if (slot.asset_type === 'occlusion-mask') {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_UPLOAD_SLOT_INVALID', '遮挡 Mask 请通过 Mask 修正入口修改', { slot_id: slot.id }, 409);
  }
  const decoded = await decodeImage(file.buffer);
  const requireAlpha = slot.asset_type !== 'environment';
  const report = inspectRgba(decoded.data, decoded.info, requireAlpha);
  if (!report.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_UPLOAD_ALPHA_REQUIRED',
      '角色和道具替换图必须包含真实透明背景（透明区域至少占画面 5%）；请上传透明 PNG，或在当前素材上使用 Mask 修正',
      { slot_id: slot.id, report },
      422,
    );
  }
  const versionId = nextVersion(db, slot, 'user_upload', {
    request_id: input.request_id, original_name: file.originalname || null,
    mime_type: file.mimetype || null, size: Number(file.size || file.buffer.length),
  });
  const target = versionPath(db, cfg, shot, versionId, slot.slot_key);
  await sharp(decoded.data, { raw: decoded.info }).png().toFile(target.absolute);
  const hash = sha256(fs.readFileSync(target.absolute));
  db.prepare(
    `UPDATE paper_asset_versions
     SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
         processing_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ?
     WHERE id = ?`,
  ).run(
    target.relative, requireAlpha ? target.relative : null, hash, requireAlpha ? hash : null,
    JSON.stringify({ source: 'user_upload', alpha_preserved: requireAlpha }), JSON.stringify(report),
    nowIso(), Number(versionId),
  );
  activateVersion(db, shot, slot, versionId, input.request_id, '用户上传了替换素材');
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio asset replacement uploaded', { shot_id: shot.id, slot_id: slot.id, asset_version_id: versionId });
  return { shot: shotService.get(db, shot.id), asset_version_id: versionId, slot_id: slot.id, report };
}

function applyBrushPoint(data, info, point, feather) {
  const centerX = Number(point.x) * (info.width - 1);
  const centerY = Number(point.y) * (info.height - 1);
  const radius = Math.max(1, Number(point.radius) * Math.min(info.width, info.height));
  const strength = Number(point.strength ?? 1);
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(info.width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(info.height - 1, Math.ceil(centerY + radius));
  const hardPart = Math.max(0, Math.min(1, 1 - Number(feather || 0)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY) / radius;
      if (distance > 1) continue;
      const raw = distance <= hardPart || hardPart >= 0.999
        ? 1
        : 1 - ((distance - hardPart) / Math.max(0.001, 1 - hardPart));
      const weight = Math.max(0, Math.min(1, raw * raw * (3 - 2 * raw) * strength));
      const offset = (y * info.width + x) * 4 + 3;
      const alpha = data[offset];
      data[offset] = point.kind === 'foreground'
        ? Math.max(alpha, Math.round(255 * weight))
        : Math.min(alpha, Math.round(255 * (1 - weight)));
    }
  }
}

async function patchMask(db, cfg, log, shotId, assetVersionId, body = {}) {
  schemaService.assertValid('apiAssetMaskPatch', body, 'Mask 修正参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!EDITABLE_STATES.has(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_MASK_PATCH_STATE_CONFLICT', '当前镜头状态不允许修改素材 Mask', { shot_id: shot.id, status: shot.status }, 409);
  }
  const row = db.prepare(
    `SELECT pav.*, pas.asset_type, pas.slot_key, pas.family_id, pas.current_version_id,
            pas.required_for_gate, pas.constraints_json
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     WHERE pav.id = ? AND psf.shot_id = ? AND pas.current_version_id = pav.id
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL`,
  ).get(Number(assetVersionId), Number(shot.id));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_ASSET_VERSION_NOT_CURRENT', '只能修正当前正在使用的素材版本', { asset_version_id: Number(assetVersionId) }, 409);
  if (row.asset_type === 'environment' || row.asset_type === 'occlusion-mask') {
    throw new PaperStudioError('PAPER_STUDIO_MASK_PATCH_ASSET_INVALID', '干净背景或程序化遮挡层不能使用主体 Mask 笔刷', { asset_version_id: Number(assetVersionId) }, 409);
  }
  const sourceRel = row.alpha_local_path || row.source_local_path;
  const sourcePath = assetProductionService.safeStorageFile(cfg, sourceRel);
  if (!fs.existsSync(sourcePath)) throw new PaperStudioError('PAPER_STUDIO_ASSET_PATH_MISSING', '当前素材文件不存在', { local_path: sourceRel }, 422);
  const decoded = await decodeImage(sourcePath);
  const data = Buffer.from(decoded.data);
  body.points.forEach((point) => applyBrushPoint(data, decoded.info, point, body.feather ?? 0.35));
  const report = inspectRgba(data, decoded.info, true);
  if (!report.pass) throw new PaperStudioError('PAPER_STUDIO_MASK_PATCH_EMPTY', 'Mask 修正后主体为空或覆盖整个画布，请减少笔刷范围', { report }, 422);
  const slot = {
    ...row,
    id: Number(row.slot_id),
    family_id: Number(row.family_id),
    current_version_id: Number(row.current_version_id),
    required_for_gate: Boolean(row.required_for_gate),
    constraints_json: parseJson(row.constraints_json, {}),
  };
  const versionId = nextVersion(db, slot, 'mask_patch', {
    request_id: body.request_id, parent_asset_version_id: Number(row.id), points: body.points.length,
  });
  const target = versionPath(db, cfg, shot, versionId, row.slot_key);
  await sharp(data, { raw: decoded.info }).png().toFile(target.absolute);
  const hash = sha256(fs.readFileSync(target.absolute));
  db.prepare(
    `UPDATE paper_asset_versions
     SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
         processing_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ?
     WHERE id = ?`,
  ).run(
    target.relative, target.relative, hash, hash,
    JSON.stringify({ source: 'mask_patch', parent_asset_version_id: Number(row.id), feather: body.feather ?? 0.35 }),
    JSON.stringify({ ...report, matte_method: 'manual_point_mask' }), nowIso(), Number(versionId),
  );
  db.prepare(
    `INSERT INTO paper_asset_mask_edits
      (shot_id, slot_id, parent_asset_version_id, asset_version_id, edit_kind,
       patch_json, request_id, created_at)
     VALUES (?, ?, ?, ?, 'point_brush', ?, ?, ?)`,
  ).run(Number(shot.id), Number(slot.id), Number(row.id), Number(versionId), JSON.stringify({ points: body.points, feather: body.feather ?? 0.35 }), body.request_id, nowIso());
  activateVersion(db, shot, slot, versionId, body.request_id, '用户修正了素材 Mask');

  const derivedSlots = db.prepare(
    `SELECT pas.* FROM paper_asset_slots pas
     WHERE pas.family_id = ? AND pas.deleted_at IS NULL
       AND json_extract(pas.constraints_json, '$.derivation') = 'registered_alpha_band'
       AND json_extract(pas.constraints_json, '$.source_slot') = ?`,
  ).all(Number(slot.family_id), row.slot_key).map((item) => ({
    ...item,
    id: Number(item.id),
    family_id: Number(item.family_id),
    constraints_json: parseJson(item.constraints_json, {}),
  }));
  const derivedVersionIds = [];
  for (const derived of derivedSlots) {
    derivedVersionIds.push(await assetProductionService.deriveOccluder(db, cfg, shot, derived));
  }
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio asset mask patched', { shot_id: shot.id, slot_id: slot.id, asset_version_id: versionId, points: body.points.length });
  return { shot: shotService.get(db, shot.id), asset_version_id: versionId, parent_asset_version_id: Number(row.id), report, derived_asset_version_ids: derivedVersionIds };
}

module.exports = {
  EDITABLE_STATES,
  normalizeMultipartBody,
  slotContext,
  inspectRgba,
  applyBrushPoint,
  assertReusableSourceCompatibility,
  reuseAcceptedVersion,
  uploadReplacement,
  patchMask,
};
