const imageClient = require('../imageClient');
const uploadService = require('../uploadService');
const storageLayout = require('../storageLayout');
const sharp = require('sharp');
const providerService = require('./paperProviderCapabilityService');
const schemaService = require('./paperStudioSchemaService');
const storyboardService = require('./paperStoryboardService');
const { storageRoot } = require('./paperAssetProductionService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  sha256,
  parseJson,
} = require('./paperStudioUtils');

function rowToReference(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    image_generation_id: row.image_generation_id == null ? null : Number(row.image_generation_id),
    parent_version_id: row.parent_version_id == null ? null : Number(row.parent_version_id),
    version: Number(row.version || 1),
    constraints_json: parseJson(row.constraints_json, {}),
    provenance_json: parseJson(row.provenance_json, {}),
    preview_url: row.local_path ? `/static/${String(row.local_path).replace(/^\/+/, '')}` : row.image_url || null,
  };
}

function list(db, storyboardId) {
  storyboardService.get(db, storyboardId);
  return db.prepare(
    `SELECT * FROM paper_storyboard_reference_versions
     WHERE paper_storyboard_id = ? AND status != 'rejected'
     ORDER BY CASE WHEN status = 'selected' THEN 0 ELSE 1 END, id DESC`,
  ).all(Number(storyboardId)).map(rowToReference);
}

function getReference(db, storyboardId, referenceId) {
  const row = db.prepare(
    `SELECT * FROM paper_storyboard_reference_versions
     WHERE id = ? AND paper_storyboard_id = ?`,
  ).get(Number(referenceId), Number(storyboardId));
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_REFERENCE_NOT_FOUND',
      '参考图候选不存在或不属于当前纸片分镜',
      { paper_storyboard_id: Number(storyboardId), reference_version_id: Number(referenceId) },
      404,
    );
  }
  return rowToReference(row);
}

function insertReference(db, storyboard, values = {}) {
  const now = nowIso();
  const result = db.prepare(
    `INSERT INTO paper_storyboard_reference_versions
      (paper_storyboard_id, image_generation_id, parent_version_id, source_kind,
       image_url, local_path, prompt, constraints_json, provenance_json,
       status, version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?)`,
  ).run(
    Number(storyboard.id), values.image_generation_id == null ? null : Number(values.image_generation_id),
    values.parent_version_id == null ? null : Number(values.parent_version_id), values.source_kind,
    values.image_url || null, values.local_path, values.prompt || null,
    JSON.stringify(values.constraints || {}), JSON.stringify(values.provenance || {}), now,
  );
  return getReference(db, storyboard.id, result.lastInsertRowid);
}

function select(db, log, storyboardId, referenceId, body = {}) {
  schemaService.assertValid('apiPaperReferenceSelect', body, '选择参考图的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  const reference = getReference(db, storyboard.id, referenceId);
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE paper_storyboard_reference_versions
       SET status = 'candidate', version = version + 1
       WHERE paper_storyboard_id = ? AND status = 'selected' AND id != ?`,
    ).run(Number(storyboard.id), Number(reference.id));
    db.prepare(
      `UPDATE paper_storyboard_reference_versions
       SET status = 'selected', selected_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(now, Number(reference.id));
    db.prepare(
      `UPDATE paper_storyboards
       SET current_reference_version_id = ?, reference_image_generation_id = ?,
           reference_image_url = ?, reference_local_path = ?, reference_constraints_json = ?,
           published_video_generation_id = NULL, status = 'ready',
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      Number(reference.id), reference.image_generation_id, reference.image_url,
      reference.local_path, JSON.stringify(reference.constraints_json || {}), now, Number(storyboard.id),
    );
    storyboardService.ensureRevision(db, storyboard.id, `reference_${reference.source_kind}_selected`);
    storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now });
  });
  transaction();
  if (log) log.info('Paper storyboard reference selected', { paper_storyboard_id: Number(storyboard.id), reference_version_id: Number(reference.id) });
  return { storyboard: storyboardService.get(db, storyboard.id), reference: getReference(db, storyboard.id, reference.id), references: list(db, storyboard.id) };
}

function normalizeMultipartBody(body = {}) {
  return {
    request_id: String(body.request_id || ''),
    expected_version: Number(body.expected_version),
    ...(body.select === undefined ? {} : { select: ['true', '1', true, 1].includes(body.select) }),
  };
}

async function upload(db, cfg, log, storyboardId, body = {}, file = null) {
  const input = normalizeMultipartBody(body);
  schemaService.assertValid('apiPaperReferenceUpload', input, '上传参考图的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, input.expected_version, '纸片分镜');
  if (!file?.buffer?.length) throw new PaperStudioError('PAPER_STUDIO_REFERENCE_FILE_REQUIRED', '请选择要上传的参考图', null, 400);
  let metadata;
  try { metadata = await sharp(file.buffer).metadata(); } catch (error) {
    throw new PaperStudioError('PAPER_STUDIO_REFERENCE_FILE_INVALID', '上传文件不是可读取的图片', { error: error.message }, 422);
  }
  if (!metadata.width || !metadata.height) throw new PaperStudioError('PAPER_STUDIO_REFERENCE_FILE_INVALID', '参考图缺少有效尺寸', null, 422);
  const projectDir = storageLayout.getProjectStorageSubdir(db, storyboard.drama_id);
  const stored = uploadService.uploadFile(
    storageRoot(cfg), cfg?.storage?.base_url || '', log, file.buffer,
    file.originalname || 'paper-reference.png', file.mimetype || 'image/png',
    'paper-storyboards', projectDir,
  );
  const reference = insertReference(db, storyboard, {
    source_kind: 'upload', image_url: stored.url, local_path: stored.local_path,
    constraints: {}, provenance: {
      request_id: input.request_id, original_name: file.originalname || null,
      mime_type: file.mimetype || null, size: Number(file.size || file.buffer.length),
      width: Number(metadata.width), height: Number(metadata.height),
    },
  });
  if (input.select !== false) return select(db, log, storyboard.id, reference.id, { request_id: input.request_id, expected_version: storyboard.version });
  return { storyboard, reference, references: list(db, storyboard.id) };
}

function updateConstraints(db, log, storyboardId, referenceId, body = {}) {
  schemaService.assertValid('apiPaperReferenceConstraints', body, '保存参考图构图约束的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  const reference = getReference(db, storyboard.id, referenceId);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      'UPDATE paper_storyboard_reference_versions SET constraints_json = ?, version = version + 1 WHERE id = ?',
    ).run(JSON.stringify(body.constraints || {}), Number(reference.id));
    if (Number(storyboard.current_reference_version_id || 0) === Number(reference.id)) {
      db.prepare(
        `UPDATE paper_storyboards
         SET reference_constraints_json = ?, published_video_generation_id = NULL,
             version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(body.constraints || {}), now, Number(storyboard.id));
      storyboardService.ensureRevision(db, storyboard.id, 'reference_constraints');
      storyboardService.invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now });
    }
  })();
  if (log) log.info('Paper storyboard reference constraints updated', { paper_storyboard_id: Number(storyboard.id), reference_version_id: Number(reference.id) });
  return { storyboard: storyboardService.get(db, storyboard.id), reference: getReference(db, storyboard.id, reference.id), references: list(db, storyboard.id) };
}

function sizeForRatio(ratio) {
  if (ratio === '9:16') return '1024x1536';
  if (ratio === '1:1') return '1024x1024';
  if (ratio === '3:4') return '1024x1536';
  return '1536x1024';
}

function promptForReference(storyboard, drama, body = {}) {
  if (body.prompt?.trim()) return body.prompt.trim();
  return [
    'Create one coherent storyboard reference frame for an independent layered paper animation shot.',
    `Project: ${drama?.title || 'paper animation project'}.`,
    `Shot title: ${storyboard.title}.`,
    `Visual description: ${storyboard.description || 'Use the action and title to establish the composition.'}`,
    `Action: ${storyboard.action || 'A clear readable narrative moment.'}`,
    storyboard.shot_type ? `Shot type: ${storyboard.shot_type}.` : '',
    storyboard.camera_motion ? `Camera intention: ${storyboard.camera_motion}.` : '',
    storyboard.visual_prompt ? `Additional art direction: ${storyboard.visual_prompt}` : '',
    'Single continuous frame, tactile 2D paper collage, handmade cut-paper edges, mineral-pigment color and ink linework.',
    'This image is composition and style reference only. Keep subjects clearly separated and readable so clean background and independent character/prop layers can be produced next.',
    'No split panels, no contact sheet, no storyboard grid, no captions, no labels, no logo and no watermark.',
  ].filter(Boolean).join('\n\n');
}

function createGeneration(db, storyboard, provider, prompt, size, fingerprint) {
  const columns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  const values = {
    storyboard_id: storyboard.legacy_storyboard_id || null,
    paper_storyboard_id: Number(storyboard.id),
    drama_id: Number(storyboard.drama_id),
    provider: provider.provider || 'image',
    prompt,
    model: provider.model,
    frame_type: 'paper_reference',
    size,
    quality: 'high',
    status: 'processing',
    generation_kind: 'paper_studio_reference',
    generation_purpose: 'paper_shot_reference',
    request_fingerprint: fingerprint,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const entries = Object.entries(values).filter(([key]) => columns.has(key));
  return Number(db.prepare(`INSERT INTO image_generations (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value)).lastInsertRowid);
}

async function generate(db, cfg, log, storyboardId, body = {}) {
  schemaService.assertValid('apiPaperReferenceGenerate', body, '生成纸片分镜参考图的参数无效');
  const storyboard = storyboardService.get(db, storyboardId);
  assertExpectedVersion(storyboard.version, body.expected_version, '纸片分镜');
  const provider = providerService.select(db, body.image_provider_config_id || null);
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.drama_id));
  const episode = db.prepare('SELECT aspect_ratio FROM paper_studio_episodes WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.paper_episode_id));
  const prompt = promptForReference(storyboard, drama, body);
  const negativePrompt = body.negative_prompt || storyboard.negative_prompt || 'split panel, storyboard grid, contact sheet, text, caption, logo, watermark';
  const size = sizeForRatio(episode?.aspect_ratio || '16:9');
  const fingerprint = sha256(canonicalJson({ paper_storyboard_id: storyboard.id, version: storyboard.version, prompt, negative_prompt: negativePrompt, provider, size }));
  const generationId = createGeneration(db, storyboard, provider, prompt, size, fingerprint);
  try {
    const result = await imageClient.callImageApi(db, log, {
      prompt,
      model: provider.model || undefined,
      preferred_provider: provider.provider || undefined,
      size,
      quality: 'high',
      drama_id: Number(storyboard.drama_id),
      imageServiceType: 'storyboard_image',
      image_gen_id: generationId,
      files_base_url: cfg?.storage?.base_url,
      storage_local_path: storageRoot(cfg),
      user_negative_prompt: negativePrompt,
    });
    if (result?.error || !result?.image_url) throw new Error(result?.error || '图片 API 未返回图片');
    const projectDir = storageLayout.getProjectStorageSubdir(db, storyboard.drama_id);
    const downloaded = await uploadService.downloadImageToLocal(storageRoot(cfg), result.image_url, 'paper-storyboards', log, `paper-shot-${storyboard.id}-reference-${generationId}`, projectDir);
    if (!downloaded) throw new Error('纸片分镜参考图下载到本地失败');
    const now = nowIso();
    let reference;
    const commit = db.transaction(() => {
      db.prepare("UPDATE image_generations SET image_url = ?, local_path = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
        .run(result.image_url, downloaded, now, now, generationId);
      reference = insertReference(db, storyboard, {
        image_generation_id: generationId, source_kind: 'image_api', image_url: result.image_url,
        local_path: downloaded, prompt, constraints: {}, provenance: {
          request_id: body.request_id, provider, size, negative_prompt: negativePrompt,
          request_fingerprint: fingerprint,
        },
      });
    });
    commit();
    const selected = select(db, log, storyboard.id, reference.id, { request_id: body.request_id, expected_version: storyboard.version });
    return { ...selected, image_generation: { id: generationId, image_url: result.image_url, local_path: downloaded, status: 'completed' } };
  } catch (error) {
    const normalized = /(?:429|usage_limit_reached|usage limit|quota)/i.test(error.message || '')
      ? new PaperStudioError('PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED', '图片 API 当前额度已用尽，恢复后可重新生成当前参考图', { provider: provider.provider, model: provider.model, original_error: error.message }, 429)
      : error;
    db.prepare("UPDATE image_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(normalized.message, nowIso(), generationId);
    throw normalized;
  }
}

module.exports = {
  rowToReference,
  list,
  getReference,
  insertReference,
  select,
  upload,
  updateConstraints,
  sizeForRatio,
  promptForReference,
  generate,
};
