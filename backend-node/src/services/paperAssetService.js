const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const storageLayout = require('./storageLayout');
const paperMatteService = require('./paperMatteService');
const {
  PaperError,
  nowIso,
  parseJson,
  assertExpectedVersion,
  resolveStorageRoot,
  resolveStorageFile,
  normalizeRelativePath,
  relativeStoragePath,
  sha256File,
  asPublicStaticPath,
  inspectImageFile,
  isPathInsideReal,
} = require('./paperUtils');

const ASSET_TYPES = new Set([
  'background_plate', 'midground', 'cutout', 'rig_part', 'prop_state',
  'occluder', 'mask', 'atmosphere', 'texture', 'decoration',
]);
const ASSET_SCOPES = new Set(['drama', 'scene', 'storyboard']);
const ASSET_STATUSES = new Set(['missing', 'candidate', 'needs_review', 'ready', 'stale', 'deleted']);

function rowToAsset(row) {
  if (!row) return null;
  return {
    ...row,
    processing_json: parseJson(row.processing_json, {}),
    content_bbox_json: parseJson(row.content_bbox_json, {}),
    alpha_bbox_json: parseJson(row.alpha_bbox_json, {}),
    image_url: row.image_url || asPublicStaticPath(row.local_path),
    cutout_url: asPublicStaticPath(row.cutout_local_path),
    version: Number(row.version || 1),
  };
}

function get(db, id) {
  return rowToAsset(db.prepare('SELECT * FROM paper_assets WHERE id = ? AND deleted_at IS NULL').get(Number(id)));
}

function list(db, filters = {}) {
  let sql = 'SELECT * FROM paper_assets WHERE deleted_at IS NULL';
  const params = [];
  for (const key of ['drama_id', 'episode_id', 'scene_id', 'storyboard_id', 'source_entity_id']) {
    if (filters[key] == null || filters[key] === '') continue;
    sql += key === 'source_entity_id' ? ' AND source_entity_id = ?' : ` AND ${key} = ?`;
    params.push(Number(filters[key]));
  }
  if (filters.asset_type) { sql += ' AND asset_type = ?'; params.push(String(filters.asset_type)); }
  if (filters.status) { sql += ' AND status = ?'; params.push(String(filters.status)); }
  if (filters.asset_scope) { sql += ' AND asset_scope = ?'; params.push(String(filters.asset_scope)); }
  sql += ' ORDER BY updated_at DESC, id DESC';
  return db.prepare(sql).all(...params).map(rowToAsset);
}

function assertEnums(input) {
  if (input.asset_type && !ASSET_TYPES.has(String(input.asset_type))) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', `不支持的 asset_type: ${input.asset_type}`);
  }
  if (input.asset_scope && !ASSET_SCOPES.has(String(input.asset_scope))) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', `不支持的 asset_scope: ${input.asset_scope}`);
  }
  if (input.status && !ASSET_STATUSES.has(String(input.status))) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', `不支持的 asset status: ${input.status}`);
  }
}

function create(db, input = {}) {
  assertEnums(input);
  const dramaId = Number(input.drama_id);
  const assetKey = String(input.asset_key || '').trim();
  if (!dramaId || !assetKey || !input.asset_type) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', 'drama_id、asset_key、asset_type 必填');
  }
  const variantKey = input.variant_key == null ? '' : String(input.variant_key).trim();
  const existing = db.prepare(
    'SELECT * FROM paper_assets WHERE drama_id = ? AND asset_key = ? AND variant_key = ?'
  ).get(dramaId, assetKey, variantKey);
  const now = nowIso();
  if (existing) {
    if (existing.deleted_at) {
      db.prepare(
        `UPDATE paper_assets SET deleted_at = NULL, status = ?, updated_at = ?, version = version + 1
         WHERE id = ?`
      ).run(input.status || 'missing', now, existing.id);
      return get(db, existing.id);
    }
    return rowToAsset(existing);
  }
  const result = db.prepare(
    `INSERT INTO paper_assets
      (drama_id, episode_id, scene_id, storyboard_id, asset_scope, asset_key, asset_type, variant_key,
       rig_key, source_entity_type, source_entity_id, source_image_generation_id, context_snapshot_id,
       style_version_id, style_signature, prompt, negative_prompt, image_url, local_path, cutout_local_path,
       processing_json, camera_signature, facing, foot_line, content_bbox_json, alpha_bbox_json,
       matte_quality, asset_hash, schema_version, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
  ).run(
    dramaId,
    input.episode_id == null ? null : Number(input.episode_id),
    input.scene_id == null ? null : Number(input.scene_id),
    input.storyboard_id == null ? null : Number(input.storyboard_id),
    input.asset_scope || 'storyboard',
    assetKey,
    input.asset_type,
    variantKey,
    input.rig_key || null,
    input.source_entity_type || null,
    input.source_entity_id == null ? null : Number(input.source_entity_id),
    input.source_image_generation_id == null ? null : Number(input.source_image_generation_id),
    input.context_snapshot_id || null,
    input.style_version_id == null ? null : Number(input.style_version_id),
    input.style_signature || null,
    input.prompt || null,
    input.negative_prompt || null,
    input.image_url || null,
    normalizeRelativePath(input.local_path),
    normalizeRelativePath(input.cutout_local_path),
    JSON.stringify(parseJson(input.processing_json, {})),
    input.camera_signature || null,
    input.facing || null,
    input.foot_line == null ? null : Number(input.foot_line),
    JSON.stringify(parseJson(input.content_bbox_json, {})),
    JSON.stringify(parseJson(input.alpha_bbox_json, {})),
    input.matte_quality || 'unknown',
    input.asset_hash || null,
    input.status || 'missing',
    now,
    now
  );
  return get(db, result.lastInsertRowid);
}

function update(db, id, patch = {}, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, '纸片资产');
  assertEnums(patch);
  const allowed = [
    'episode_id', 'scene_id', 'storyboard_id', 'asset_scope', 'asset_type', 'variant_key', 'rig_key',
    'source_entity_type', 'source_entity_id', 'context_snapshot_id', 'style_version_id', 'style_signature',
    'prompt', 'negative_prompt', 'image_url', 'local_path', 'cutout_local_path', 'processing_json',
    'camera_signature', 'facing', 'foot_line', 'content_bbox_json', 'alpha_bbox_json', 'matte_quality',
    'asset_hash', 'status',
  ];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key.endsWith('_json')) value = JSON.stringify(parseJson(value, {}));
    if (['local_path', 'cutout_local_path'].includes(key)) value = normalizeRelativePath(value);
    if (['episode_id', 'scene_id', 'storyboard_id', 'source_entity_id', 'style_version_id'].includes(key)) {
      value = value == null ? null : Number(value);
    }
    if (key === 'foot_line') value = value == null ? null : Number(value);
    fields.push(`${key} = ?`); values.push(value);
  }
  if (!fields.length) return current;
  const now = nowIso();
  fields.push('version = version + 1', 'updated_at = ?'); values.push(now);
  const result = db.prepare(`UPDATE paper_assets SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`)
    .run(...values, Number(id), current.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', '纸片资产版本已变化', null, 409);
  if (['local_path', 'cutout_local_path', 'processing_json', 'content_bbox_json', 'alpha_bbox_json', 'matte_quality', 'asset_hash', 'status', 'camera_signature', 'style_signature'].some((key) => key in patch)) {
    markReferencingCompositionsStale(db, id, 'paper asset metadata or file changed');
  }
  return get(db, id);
}

function countReferences(db, assetId) {
  const layers = db.prepare('SELECT COUNT(*) AS count FROM paper_layers WHERE paper_asset_id = ? AND deleted_at IS NULL').get(Number(assetId)).count;
  const masks = db.prepare('SELECT COUNT(*) AS count FROM paper_layers WHERE mask_asset_id = ? AND deleted_at IS NULL').get(Number(assetId)).count;
  let rigs = 0;
  const rigRows = db.prepare('SELECT parts_json FROM paper_rigs WHERE deleted_at IS NULL').all();
  for (const row of rigRows) {
    const parts = parseJson(row.parts_json, []);
    if (Array.isArray(parts) && parts.some((part) => Number(part.asset_id) === Number(assetId))) rigs += 1;
  }
  return { layers, masks, rigs, total: layers + masks + rigs };
}

function markReferencingCompositionsStale(db, assetId, reason = 'paper asset changed') {
  const compositionIds = new Set(db.prepare(
    `SELECT DISTINCT pl.composition_id
       FROM paper_layers pl
      WHERE pl.deleted_at IS NULL
        AND (pl.paper_asset_id = ? OR pl.mask_asset_id = ?)`
  ).all(Number(assetId), Number(assetId)).map((row) => Number(row.composition_id)));
  const rigRows = db.prepare('SELECT id, parts_json FROM paper_rigs WHERE deleted_at IS NULL').all();
  const referencingRigIds = rigRows
    .filter((rig) => parseJson(rig.parts_json, []).some((part) => Number(part.asset_id) === Number(assetId)))
    .map((rig) => Number(rig.id));
  if (referencingRigIds.length) {
    const placeholders = referencingRigIds.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT DISTINCT composition_id FROM paper_layers WHERE rig_id IN (${placeholders}) AND deleted_at IS NULL`).all(...referencingRigIds)) {
      compositionIds.add(Number(row.composition_id));
    }
  }
  const now = nowIso();
  const update = db.prepare(
    `UPDATE paper_compositions
        SET status = CASE WHEN status = 'rendering' THEN 'rendering' ELSE 'stale' END,
            last_validation_json = ?, last_proof_hash = NULL, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`
  );
  const removeProofs = db.prepare('DELETE FROM paper_render_proofs WHERE composition_id = ?');
  const payload = JSON.stringify({ code: 'PAPER_ASSET_STALE', reason, asset_id: Number(assetId) });
  for (const compositionId of compositionIds) {
    update.run(payload, now, compositionId);
    removeProofs.run(compositionId);
  }
  return [...compositionIds];
}

function softDelete(db, id, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, '纸片资产');
  const refs = countReferences(db, id);
  if (refs.total > 0) throw new PaperError('PAPER_ASSET_IN_USE', '纸片资产仍被引用，不能删除', { asset_id: id, references: refs }, 409);
  db.prepare('UPDATE paper_assets SET deleted_at = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
    .run(nowIso(), 'deleted', nowIso(), Number(id));
  return { ok: true };
}

function resolveAssetForRender(db, cfg, id, options = {}) {
  const row = get(db, id);
  if (!row) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { asset_id: id }, 404);
  if (row.source_entity_type === 'storyboard' || row.asset_type === 'storyboard_reference') {
    throw new PaperError('PAPER_SCHEMA_INVALID', '完整分镜图只能作为构图参考，不能作为纸片渲染层', { asset_id: id }, 422);
  }
  if (!['ready', 'manual_pass'].includes(row.status) && !options.allowCandidate) {
    throw new PaperError('MISSING_SEMANTIC_ASSET', '纸片资产尚未通过正式素材审核', { asset_id: id, status: row.status }, 409);
  }
  const relative = row.cutout_local_path || row.local_path;
  const absolute = resolveStorageFile(cfg, relative);
  if (!relative || !absolute || !fs.existsSync(absolute)) {
    throw new PaperError('PAPER_ASSET_PATH_INVALID', '纸片资产文件不存在或路径非法', { asset_id: id, local_path: relative }, 422);
  }
  const storageRoot = resolveStorageRoot(cfg);
  if (!isPathInsideReal(storageRoot, absolute)) {
    throw new PaperError('PAPER_ASSET_PATH_INVALID', '纸片资产路径不能越过 storage 根目录', { asset_id: id, local_path: relative }, 422);
  }
  const imageInfo = inspectImageFile(absolute);
  const processing = { ...(row.processing_json || {}) };
  if (imageInfo) {
    if (!processing.width) processing.width = imageInfo.width;
    if (!processing.height) processing.height = imageInfo.height;
    if (processing.has_alpha == null) processing.has_alpha = imageInfo.has_alpha;
  }
  const contentBbox = Object.keys(row.content_bbox_json || {}).length ? row.content_bbox_json : (imageInfo?.content_bbox || {});
  const alphaBbox = Object.keys(row.alpha_bbox_json || {}).length ? row.alpha_bbox_json : (imageInfo?.alpha_bbox || {});
  if (!options.allowIncompleteMetadata) {
    const width = Number(processing.width);
    const height = Number(processing.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new PaperError('PAPER_ASSET_METADATA_MISSING', '正式纸片资产缺少有效尺寸元数据', { asset_id: id }, 422);
    }
    if (!contentBbox || !Number(contentBbox.width) || !Number(contentBbox.height)) {
      throw new PaperError('PAPER_ASSET_METADATA_MISSING', '正式纸片资产缺少有效 content bbox', { asset_id: id }, 422);
    }
    const maxPixels = Number(cfg?.paper_render?.max_asset_pixels || 25000000);
    if (Number.isFinite(maxPixels) && maxPixels > 0 && width * height > maxPixels) {
      throw new PaperError('PAPER_LIMIT_EXCEEDED', '纸片资产像素数超过本地渲染上限', { asset_id: id, width, height, max_pixels: maxPixels }, 413);
    }
    if (['cutout', 'rig_part', 'prop_state', 'mask'].includes(row.asset_type)
      && (!alphaBbox || !Number(alphaBbox.width) || !Number(alphaBbox.height))) {
      throw new PaperError('PAPER_ASSET_METADATA_MISSING', '透明纸片资产缺少有效 alpha bbox', { asset_id: id }, 422);
    }
  }
  if (row.asset_hash) {
    const actual = sha256File(absolute);
    if (actual !== row.asset_hash) {
      throw new PaperError('PAPER_STALE_COMPOSITION', '纸片资产文件 hash 已变化，请重新审核', { asset_id: id, expected: row.asset_hash, actual }, 409);
    }
  } else if (!options.allowMissingHash) {
    throw new PaperError('PAPER_ASSET_HASH_MISSING', '正式纸片资产缺少文件 hash，请重新导入/审核', { asset_id: id }, 422);
  }
  if (['cutout', 'rig_part', 'prop_state', 'mask'].includes(row.asset_type) && row.matte_quality === 'fail') {
    throw new PaperError('PAPER_MATTE_INVALID', '透明素材抠图诊断未通过', { asset_id: id }, 422);
  }
  return {
    ...row,
    processing_json: processing,
    content_bbox_json: contentBbox,
    alpha_bbox_json: alphaBbox,
    resolved_local_path: relative,
    absolute_path: absolute,
  };
}

/**
 * Reconcile a paper asset that points at an existing scene/background file.
 * Planning is synchronous, so the lightweight header inspection in
 * paperUtils is used here; upload/matte still remains the authoritative
 * alpha analysis path for transparent parts.
 */
function refreshFileMetadata(db, cfg, id, options = {}) {
  const asset = get(db, id);
  if (!asset) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { id }, 404);
  const relative = asset.cutout_local_path || asset.local_path;
  const absolute = resolveStorageFile(cfg, relative);
  if (!relative || !absolute || !fs.existsSync(absolute) || !isPathInsideReal(resolveStorageRoot(cfg), absolute)) {
    throw new PaperError('PAPER_ASSET_PATH_INVALID', '纸片资产文件不存在或路径非法', { asset_id: id, local_path: relative }, 422);
  }
  const info = inspectImageFile(absolute);
  if (!info) throw new PaperError('PAPER_ASSET_METADATA_MISSING', '无法读取纸片资产尺寸', { asset_id: id }, 422);
  const processing = { ...asset.processing_json, width: info.width, height: info.height, has_alpha: info.has_alpha, source_hash: sha256File(absolute) };
  const status = options.status || asset.status;
  const updated = update(db, id, {
    asset_hash: sha256File(absolute),
    processing_json: processing,
    content_bbox_json: asset.content_bbox_json && Object.keys(asset.content_bbox_json).length ? asset.content_bbox_json : info.content_bbox,
    alpha_bbox_json: asset.alpha_bbox_json && Object.keys(asset.alpha_bbox_json).length ? asset.alpha_bbox_json : info.alpha_bbox,
    matte_quality: asset.matte_quality === 'unknown' && ['background_plate', 'midground', 'occluder', 'decoration', 'texture', 'atmosphere'].includes(asset.asset_type) ? 'pass' : asset.matte_quality,
    status,
  }, asset.version);
  return { ...updated, width: info.width, height: info.height };
}

async function attachSource(db, cfg, id, sourcePath, options = {}) {
  const asset = get(db, id);
  if (!asset) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { id }, 404);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new PaperError('PAPER_INVALID_ARGUMENT', '上传源文件不存在');
  const storageRoot = resolveStorageRoot(cfg);
  const project = storageLayout.getProjectStorageSubdir(db, asset.drama_id);
  const safeName = `${asset.asset_key.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')}-${crypto.randomUUID().slice(0, 8)}.png`;
  const rel = `${project}/paper/assets/${safeName}`.replace(/\\/g, '/');
  const dest = resolveStorageFile(cfg, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp(sourcePath).png().toFile(dest);
  const metadata = await sharp(dest).metadata();
  const hash = sha256File(dest);
  const hasAlpha = Boolean(metadata.hasAlpha || metadata.channels === 4);
  const bbox = { x: 0, y: 0, width: 1, height: 1 };
  const status = options.status || (['background_plate', 'midground', 'occluder', 'decoration'].includes(asset.asset_type) ? 'ready' : 'needs_review');
  const updated = update(db, id, {
    local_path: rel,
    image_url: asPublicStaticPath(rel),
    asset_hash: hash,
    processing_json: { ...asset.processing_json, width: metadata.width, height: metadata.height, has_alpha: hasAlpha, source_hash: hash },
    content_bbox_json: bbox,
    alpha_bbox_json: bbox,
    matte_quality: hasAlpha || status === 'ready' ? 'pass' : 'unknown',
    status,
  }, asset.version);
  return { ...updated, width: metadata.width, height: metadata.height };
}

async function matte(db, cfg, id, options = {}) {
  const asset = get(db, id);
  if (!asset) throw new PaperError('PAPER_NOT_FOUND', '纸片资产不存在', { id }, 404);
  return paperMatteService.process(db, cfg, asset, options);
}

module.exports = {
  ASSET_TYPES,
  ASSET_SCOPES,
  ASSET_STATUSES,
  rowToAsset,
  get,
  list,
  create,
  update,
  countReferences,
  markReferencingCompositionsStale,
  softDelete,
  resolveAssetForRender,
  refreshFileMetadata,
  attachSource,
  matte,
};
