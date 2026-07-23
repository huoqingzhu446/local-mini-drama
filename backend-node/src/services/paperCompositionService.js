const {
  PaperError,
  nowIso,
  parseJson,
  assertExpectedVersion,
  PAPER_RENDERER_VERSION,
  PAPER_PROOF_KINDS,
} = require('./paperUtils');
const planner = require('./paperLayerPlannerService');
const sequenceService = require('./paperSequenceService');
const assetService = require('./paperAssetService');
const rigService = require('./paperRigService');
const audioTimingService = require('./paperAudioTimingService');
const validationService = require('./paperValidationService');
const taskService = require('./taskService');

function assertPaperRenderEnabled(cfg) {
  if (cfg?.paper_render?.enabled === false) {
    throw new PaperError('PAPER_RENDER_DISABLED', '纸片分层渲染已在本地配置中禁用', null, 409);
  }
}

function rowToComposition(row) {
  if (!row) return null;
  return {
    ...row,
    camera_json: parseJson(row.camera_json, {}),
    continuity_json: parseJson(row.continuity_json, {}),
    audio_json: parseJson(row.audio_json, {}),
    last_validation_json: parseJson(row.last_validation_json, {}),
    version: Number(row.version || 1),
  };
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM paper_compositions WHERE id = ? AND deleted_at IS NULL').get(Number(id));
}

function get(db, id, options = {}) {
  const row = getRow(db, id);
  if (!row) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  const comp = rowToComposition(row);
  const layers = db.prepare('SELECT * FROM paper_layers WHERE composition_id = ? AND deleted_at IS NULL ORDER BY z_index, layer_key').all(Number(id)).map((layer) => ({
    ...layer,
    content_json: parseJson(layer.content_json, {}),
    pivot_json: parseJson(layer.pivot_json, {}),
    transform_json: parseJson(layer.transform_json, {}),
    animation_json: parseJson(layer.animation_json, {}),
    occlusion_json: parseJson(layer.occlusion_json, {}),
    version: Number(layer.version || 1),
  }));
  const rigIds = [...new Set(layers.map((layer) => layer.rig_id).filter(Boolean))];
  const rigs = rigIds.map((id) => rigService.get(db, id)).filter(Boolean);
  // Include current-episode assets, reusable drama-level assets, and every
  // asset referenced by a layer/mask/rig. Filtering only by episode_id drops
  // drama-scoped rig parts (episode_id NULL), which made the editor unable to
  // show or refresh their Codex candidates.
  const assetsById = new Map();
  for (const asset of [
    ...assetService.list(db, { drama_id: comp.drama_id, episode_id: comp.episode_id }),
    ...assetService.list(db, { drama_id: comp.drama_id, asset_scope: 'drama' }),
  ]) assetsById.set(Number(asset.id), asset);
  const referencedAssetIds = new Set();
  for (const layer of layers) {
    if (layer.paper_asset_id != null) referencedAssetIds.add(Number(layer.paper_asset_id));
    if (layer.mask_asset_id != null) referencedAssetIds.add(Number(layer.mask_asset_id));
  }
  for (const rig of rigs) {
    for (const part of rig.parts || []) {
      if (part.asset_id != null) referencedAssetIds.add(Number(part.asset_id));
    }
  }
  for (const assetId of referencedAssetIds) {
    if (assetsById.has(assetId)) continue;
    const asset = assetService.get(db, assetId);
    if (asset && Number(asset.drama_id) === Number(comp.drama_id)) assetsById.set(assetId, asset);
  }
  const assets = [...assetsById.values()];
  const sequence = comp.sequence_id ? sequenceService.get(db, comp.sequence_id) : null;
  const proofs = db.prepare('SELECT * FROM paper_render_proofs WHERE composition_id = ? ORDER BY render_hash, proof_kind').all(Number(id)).map((proof) => ({ ...proof, diagnostics_json: parseJson(proof.diagnostics_json, {}) }));
  const videos = db.prepare('SELECT * FROM video_generations WHERE paper_composition_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(Number(id)).map((video) => ({
    ...video,
    generation_kind: video.generation_kind || 'ai',
    render_snapshot: video.render_snapshot ? parseJson(video.render_snapshot, video.render_snapshot) : null,
  }));
  return { composition: comp, layers, assets, rigs, sequence, proofs, video_generations: videos };
}

function list(db, filters = {}) {
  let sql = 'SELECT * FROM paper_compositions WHERE deleted_at IS NULL';
  const params = [];
  for (const key of ['drama_id', 'episode_id', 'storyboard_id']) {
    if (filters[key] == null || filters[key] === '') continue;
    sql += ` AND ${key} = ?`; params.push(Number(filters[key]));
  }
  if (filters.status) { sql += ' AND status = ?'; params.push(String(filters.status)); }
  sql += ' ORDER BY episode_id, sequence_index, id';
  return db.prepare(sql).all(...params).map(rowToComposition);
}

function createOrPlan(db, cfgOrLog, logOrStoryboardId, storyboardIdOrOptions, options = {}) {
  // Keep the old (db, log, storyboardId, options) signature usable for
  // scripts/tests while allowing the planner to reconcile existing files
  // against the configured project storage root.
  const hasCfg = cfgOrLog && typeof cfgOrLog === 'object' && cfgOrLog.storage;
  const cfg = hasCfg ? cfgOrLog : null;
  const log = hasCfg ? logOrStoryboardId : cfgOrLog;
  const storyboardId = hasCfg ? storyboardIdOrOptions : logOrStoryboardId;
  const planOptions = hasCfg ? options : (storyboardIdOrOptions || {});
  const result = planner.plan(db, log, storyboardId, { ...planOptions, cfg });
  return { ...result, ...get(db, result.composition.id) };
}

function update(db, log, id, patch = {}, expectedVersion) {
  const current = getRow(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  assertExpectedVersion(current.version, expectedVersion, '纸片合成');
  const allowed = ['template_key', 'fps', 'width', 'height', 'duration_frames', 'camera_json', 'continuity_json', 'audio_json', 'schema_version'];
  const fields = [];
  const values = [];
  let invalidates = false;
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key.endsWith('_json')) value = JSON.stringify(parseJson(value, {}));
    if (['fps', 'width', 'height', 'duration_frames', 'schema_version'].includes(key)) value = Number(value);
    fields.push(`${key} = ?`); values.push(value);
    if (['fps', 'width', 'height', 'duration_frames', 'camera_json', 'audio_json', 'schema_version'].includes(key)) invalidates = true;
  }
  if (!fields.length) return get(db, id);
  const now = nowIso();
  if (invalidates) {
    fields.push("audio_timing_status = CASE WHEN audio_timing_status = 'locked' THEN 'stale' ELSE audio_timing_status END", "status = CASE WHEN status = 'rendered' THEN 'stale' ELSE status END", "last_validation_json = '{}'", 'last_proof_hash = NULL');
    db.prepare('DELETE FROM paper_render_proofs WHERE composition_id = ?').run(Number(id));
  }
  fields.push('version = version + 1', 'updated_at = ?'); values.push(now);
  const result = db.prepare(`UPDATE paper_compositions SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`).run(...values, Number(id), current.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', '纸片合成版本已变化', null, 409);
  if (log) log.info('Paper composition updated', { composition_id: id, version: current.version + 1, invalidates });
  return get(db, id);
}

function addLayer(db, id, input = {}, expectedVersion) {
  const comp = getRow(db, id);
  if (!comp) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  assertExpectedVersion(comp.version, expectedVersion, '纸片合成');
  if (!String(input.layer_key || '').trim() || !String(input.layer_type || '').trim()) throw new PaperError('PAPER_INVALID_ARGUMENT', 'layer_key 和 layer_type 必填');
  const now = nowIso();
  try {
    const result = db.prepare(
      `INSERT INTO paper_layers (composition_id, paper_asset_id, rig_id, layer_key, layer_type, role, parent_layer_key, content_json, z_index, depth, pivot_json, transform_json, animation_json, occlusion_json, mask_asset_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(Number(id), input.paper_asset_id || null, input.rig_id || null, String(input.layer_key), input.layer_type, input.role || null, input.parent_layer_key || null, JSON.stringify(parseJson(input.content_json, {})), Number(input.z_index || 0), Number(input.depth ?? 0.5), JSON.stringify(parseJson(input.pivot_json, {})), JSON.stringify(parseJson(input.transform_json, {})), JSON.stringify(parseJson(input.animation_json, {})), JSON.stringify(parseJson(input.occlusion_json, {})), input.mask_asset_id || null, input.status || 'missing', now, now);
    db.prepare("UPDATE paper_compositions SET version = version + 1, status = CASE WHEN status = 'rendered' THEN 'stale' ELSE status END, last_validation_json = '{}', last_proof_hash = NULL, updated_at = ? WHERE id = ? AND version = ?").run(now, Number(id), comp.version);
    return db.prepare('SELECT * FROM paper_layers WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new PaperError('PAPER_INVALID_ARGUMENT', '同一合成中 layer_key 已存在');
    throw err;
  }
}

function updateLayer(db, layerId, patch = {}, expectedVersion) {
  const current = db.prepare('SELECT * FROM paper_layers WHERE id = ? AND deleted_at IS NULL').get(Number(layerId));
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片图层不存在', { layer_id: layerId }, 404);
  assertExpectedVersion(current.version, expectedVersion, '纸片图层');
  const allowed = ['paper_asset_id', 'rig_id', 'layer_key', 'layer_type', 'role', 'parent_layer_key', 'content_json', 'z_index', 'depth', 'pivot_json', 'transform_json', 'animation_json', 'occlusion_json', 'mask_asset_id', 'status'];
  const fields = []; const values = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key.endsWith('_json')) value = JSON.stringify(parseJson(value, {}));
    fields.push(`${key} = ?`); values.push(value);
  }
  if (!fields.length) return current;
  const now = nowIso(); fields.push('version = version + 1', 'updated_at = ?'); values.push(now);
  const result = db.prepare(`UPDATE paper_layers SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`).run(...values, Number(layerId), current.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', '纸片图层版本已变化', null, 409);
  db.prepare("UPDATE paper_compositions SET version = version + 1, status = CASE WHEN status = 'rendered' THEN 'stale' ELSE status END, last_validation_json = '{}', last_proof_hash = NULL, updated_at = ? WHERE id = ?").run(now, current.composition_id);
  return db.prepare('SELECT * FROM paper_layers WHERE id = ?').get(Number(layerId));
}

function deleteLayer(db, layerId, expectedVersion) {
  const current = db.prepare('SELECT * FROM paper_layers WHERE id = ? AND deleted_at IS NULL').get(Number(layerId));
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片图层不存在', { layer_id: layerId }, 404);
  assertExpectedVersion(current.version, expectedVersion, '纸片图层');
  const now = nowIso();
  db.prepare('UPDATE paper_layers SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, now, Number(layerId));
  db.prepare("UPDATE paper_compositions SET version = version + 1, status = CASE WHEN status = 'rendered' THEN 'stale' ELSE status END, last_validation_json = '{}', last_proof_hash = NULL, updated_at = ? WHERE id = ?").run(now, current.composition_id);
  return { ok: true };
}

function duplicate(db, log, id, options = {}) {
  const source = getRow(db, id);
  if (!source) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  const now = nowIso();
  const result = db.prepare(
    `INSERT INTO paper_compositions (drama_id, episode_id, storyboard_id, sequence_id, sequence_index, version, schema_version, template_key, fps, width, height, duration_frames, camera_json, continuity_json, audio_json, audio_timing_status, audio_timing_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unlocked', NULL, 'draft', ?, ?)`
  ).run(source.drama_id, source.episode_id, options.storyboard_id || source.storyboard_id, source.sequence_id, source.sequence_index, source.schema_version, source.template_key, source.fps, source.width, source.height, source.duration_frames, source.camera_json, source.continuity_json, JSON.stringify({}), now, now);
  const newId = result.lastInsertRowid;
  const layers = db.prepare('SELECT * FROM paper_layers WHERE composition_id = ? AND deleted_at IS NULL').all(Number(id));
  const insert = db.prepare(
    `INSERT INTO paper_layers (composition_id, paper_asset_id, rig_id, layer_key, layer_type, role, parent_layer_key, content_json, z_index, depth, pivot_json, transform_json, animation_json, occlusion_json, mask_asset_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const layer of layers) insert.run(newId, layer.paper_asset_id, layer.rig_id, layer.layer_key, layer.layer_type, layer.role, layer.parent_layer_key, layer.content_json, layer.z_index, layer.depth, layer.pivot_json, layer.transform_json, layer.animation_json, layer.occlusion_json, layer.mask_asset_id, layer.status, now, now);
  if (log) log.info('Paper composition duplicated', { source_id: id, composition_id: newId });
  return get(db, newId);
}

function lockTiming(db, cfg, id, payload, expectedVersion) {
  const current = getRow(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  const result = audioTimingService.lockTiming(db, { ...current, audio_json: current.audio_json }, { ...payload, cfg }, expectedVersion);
  return get(db, id);
}

function validation(db, cfg, id, options = {}) {
  return validationService.validate(db, cfg, id, options);
}

function requestProofFrames(db, cfg, log, id, payload = {}) {
  assertPaperRenderEnabled(cfg);
  const current = getRow(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  assertExpectedVersion(current.version, payload.expected_version ?? payload.version, '纸片合成');
  const result = validation(db, cfg, id, { allowProvisional: true });
  if (result.blocking.length) throw new PaperError('PAPER_RENDER_GATE_FAILED', '纸片合成未通过 proof 门禁', { blocking: result.blocking, warnings: result.warnings }, 409);
  const task = taskService.createTask(db, log, 'paper_proof', String(id));
  db.prepare("UPDATE paper_compositions SET status = 'rendering', updated_at = ? WHERE id = ?").run(nowIso(), Number(id));
  setImmediate(() => {
    const renderService = require('./paperRenderService');
    (renderService.enqueueRender ? renderService.enqueueRender : renderService.renderComposition)({ db, cfg, log, compositionId: Number(id), taskId: task.id, proofOnly: true, preview: payload.preview === true }).catch((err) => {
      log.error('paper proof task failed', { composition_id: id, task_id: task.id, error: err.message });
    });
  });
  return { task_id: task.id, composition_id: Number(id), status: 'pending' };
}

function requestRender(db, cfg, log, id, payload = {}) {
  assertPaperRenderEnabled(cfg);
  const current = getRow(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: id }, 404);
  assertExpectedVersion(current.version, payload.expected_version ?? payload.version, '纸片合成');
  if (payload.preview === true) throw new PaperError('PAPER_FORMAL_ONLY', '纸片分层只允许正式生产渲染；请先生成 proof frames 验证', null, 409);
  const preview = false;
  const result = validation(db, cfg, id, { allowProvisional: false, allowIntentionalHold: false });
  if (result.blocking.length) throw new PaperError('PAPER_RENDER_GATE_FAILED', '纸片合成未通过正式渲染门禁', { blocking: result.blocking, warnings: result.warnings, computed: result.computed }, 409);
  if (!preview && current.audio_timing_status !== 'locked') throw new PaperError('PAPER_TIMING_NOT_LOCKED', '正式渲染必须锁定时序', null, 409);
  const specCompiler = require('./paperSpecCompiler');
  const compiled = specCompiler.compile(db, cfg, id, { allowProvisional: preview });
  const existing = db.prepare("SELECT * FROM video_generations WHERE paper_composition_id = ? AND render_hash = ? AND status = 'completed' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(Number(id), compiled.render_hash);
  if (existing && !preview) return { deduplicated: true, video_generation_id: existing.id, composition_id: Number(id), render_hash: compiled.render_hash, video_generation: existing };
  const task = taskService.createTask(db, log, preview ? 'paper_preview' : 'paper_render', String(id));
  const now = nowIso();
  let videoGenerationId = null;
  if (!preview) {
    const insert = db.prepare(
      `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, status, task_id, generation_kind, paper_composition_id, render_snapshot, render_hash, renderer_version, created_at, updated_at)
       VALUES (?, ?, 'local_remotion', ?, 'paper-layer-v1', ?, ?, ?, 'processing', ?, 'paper_layered', ?, ?, ?, ?, ?, ?)`
    ).run(current.drama_id, current.storyboard_id, 'paper-layered', current.duration_frames / current.fps, `${current.width}:${current.height}`, `${current.width}x${current.height}`, task.id, id, JSON.stringify(compiled.snapshot), compiled.render_hash, PAPER_RENDERER_VERSION, now, now);
    videoGenerationId = insert.lastInsertRowid;
  }
  db.prepare("UPDATE paper_compositions SET status = 'rendering', renderer_version = ?, updated_at = ? WHERE id = ?").run(PAPER_RENDERER_VERSION, now, Number(id));
  setImmediate(() => {
    const renderService = require('./paperRenderService');
    (renderService.enqueueRender ? renderService.enqueueRender : renderService.renderComposition)({ db, cfg, log, compositionId: Number(id), taskId: task.id, videoGenerationId, proofOnly: false, preview, scale: preview ? 0.5 : 1 }).catch((err) => {
      log.error('paper render task failed', { composition_id: id, task_id: task.id, video_generation_id: videoGenerationId, error: err.message });
    });
  });
  return { task_id: task.id, video_generation_id: videoGenerationId, composition_id: Number(id), render_hash: compiled.render_hash, status: 'pending' };
}

module.exports = {
  rowToComposition,
  getRow,
  get,
  list,
  createOrPlan,
  update,
  addLayer,
  updateLayer,
  deleteLayer,
  duplicate,
  lockTiming,
  validation,
  requestProofFrames,
  requestRender,
};
