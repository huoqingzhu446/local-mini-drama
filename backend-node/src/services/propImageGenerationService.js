// 与 Go PropService.GeneratePropImage + processPropImageGeneration 对齐：道具图片生成
const path = require('path');
const taskService = require('./taskService');
const imageClient = require('./imageClient');
const propService = require('./propService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const { aspectRatioToSize } = require('./imageService');
const promptCompiler = require('./promptCompiler');
const generationContextService = require('./generationContextService');
const visualStyleVersionService = require('./visualStyleVersionService');
const { normalizeImageQuality } = require('../utils/imageQuality');
const {
  isStyleSignatureCurrent,
  scopedStyleTextsFromStyleObject,
} = require('../utils/dramaStyleMerge');

function appendPrompt(base, extra) {
  const add = (extra || '').toString().trim();
  if (!add) return (base || '').toString().trim();
  const current = (base || '').toString().trim();
  if (!current) return add;
  const lowerCurrent = current.toLowerCase();
  const lowerAdd = add.toLowerCase();
  if (lowerCurrent.includes(lowerAdd)) return current;
  return current + ', ' + add;
}

function propScopedStyle(styleObj) {
  return scopedStyleTextsFromStyleObject(styleObj || {}, 'prop');
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
  catch (_) { return new Set(); }
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/**
 * 道具旧流程直接调用 callImageApi，导致 prompt 没有和场景/分镜一样的
 * 视觉版本快照。这里先创建 image_generations provenance 行，再发起请求；
 * 这样失败、重试和审计都能追溯到同一份不可变上下文。
 */
function createPropImageGenerationRecord(db, options) {
  const columns = tableColumns(db, 'image_generations');
  const now = new Date().toISOString();
  const entries = [
    ['prop_id', Number(options.prop_id) || null],
    ['drama_id', Number(options.drama_id) || 0],
    ['provider', options.provider || 'openai'],
    ['prompt', options.prompt || ''],
    ['negative_prompt', options.negative_prompt || null],
    ['model', options.model || null],
    ['frame_type', 'main'],
    ['reference_images', Array.isArray(options.reference_images) && options.reference_images.length ? JSON.stringify(options.reference_images.slice(0, 10)) : null],
    ['size', options.size || null],
    ['quality', normalizeImageQuality(options.quality, '') || null],
    ['status', 'processing'],
    ['task_id', options.task_id || null],
    ['created_at', now],
    ['updated_at', now],
    ['style_version_id', options.compiled?.style_version_id || null],
    ['context_snapshot_id', options.context_snapshot_id || null],
    ['prompt_hash', options.compiled?.prompt_hash || null],
    ['reference_pack', options.compiled?.reference_pack ? JSON.stringify(options.compiled.reference_pack) : null],
    ['compiler_version', options.compiled?.compiler_version || null],
  ];
  const fields = [];
  const values = [];
  for (const [field, value] of entries) {
    if (columns.has(field)) { fields.push(field); values.push(value); }
  }
  const info = db.prepare(`INSERT INTO image_generations (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
  return Number(info.lastInsertRowid);
}

function updatePropImageGeneration(db, id, fields) {
  if (!id) return;
  const columns = tableColumns(db, 'image_generations');
  const set = [];
  const values = [];
  for (const [field, value] of Object.entries(fields || {})) {
    if (columns.has(field)) { set.push(`${field} = ?`); values.push(value); }
  }
  if (!set.length) return;
  set.push('updated_at = ?');
  values.push(new Date().toISOString(), Number(id));
  db.prepare(`UPDATE image_generations SET ${set.join(', ')} WHERE id = ?`).run(...values);
}

async function processPropImageGeneration(db, log, taskId, propId, opts) {
  taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在生成图片...');

  const prop = propService.getById(db, propId);
  if (!prop) {
    taskService.updateTaskError(db, taskId, '道具不存在');
    return;
  }

  const loadConfig = require('../config').loadConfig;
  const { mergeCfgStyleWithDrama, refreshCfgVisualStyleMetadata } = require('../utils/dramaStyleMerge');
  let cfg = loadConfig();
  let dramaRow = null;
  if (prop.drama_id) {
    try {
      dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(prop.drama_id);
      cfg = mergeCfgStyleWithDrama(cfg, dramaRow || {});
    } catch (_) {}
  }
  const styleOverride = (opts && opts.style) ? String(opts.style).trim() : '';
  if (styleOverride) {
    cfg = refreshCfgVisualStyleMetadata({
      ...cfg,
      style: {
        ...(cfg?.style || {}),
        default_style_zh: styleOverride,
        default_style_en: styleOverride,
        default_style: styleOverride,
      },
    });
  }
  let activeStyleSignature = '';
  try { activeStyleSignature = visualStyleVersionService.ensureActiveVersion(db, Number(prop.drama_id))?.signature || ''; } catch (_) {}
  const currentStyleSignature = activeStyleSignature || (cfg?.style?.prop_style_signature || cfg?.style?.style_signature || '').trim();
  const propPromptMissing = !prop.prompt || !String(prop.prompt).trim();
  const propPromptStale = !propPromptMissing && !isStyleSignatureCurrent(prop.prompt_style_signature, currentStyleSignature);
  if (propPromptMissing || propPromptStale) {
    const rebuilt = await propService.generatePropPromptOnly(db, log, cfg, propId, opts?.model || undefined, opts?.style || undefined);
    if (!rebuilt.ok) {
      taskService.updateTaskError(db, taskId, rebuilt.error || '道具提示词生成失败');
      return;
    }
    const refreshed = propService.getById(db, propId);
    if (!refreshed?.prompt || !String(refreshed.prompt).trim()) {
      taskService.updateTaskError(db, taskId, '道具没有图片提示词');
      return;
    }
    prop.prompt = refreshed.prompt;
    prop.prompt_style_signature = refreshed.prompt_style_signature || currentStyleSignature;
  }
  // 优先用项目 aspect_ratio 推导尺寸；兜底 1920x1920（满足 ≥3,686,400 像素要求）
  let imageSize = null;
  if (prop.drama_id) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(prop.drama_id);
      if (dramaRow && dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) imageSize = aspectRatioToSize(meta.aspect_ratio);
      }
    } catch (_) {}
  }
  if (!imageSize) imageSize = cfg?.style?.default_image_size || '1920x1920';

  // 与角色/场景一致：使用前端「图片生成模型」选择的 model；未传时用 YAML default_image_provider 兜底
  const model = (opts && opts.model) ? String(opts.model).trim() || null : null;
  const preferredProvider = !model && cfg?.ai?.default_image_provider ? cfg.ai.default_image_provider : null;
  const userNeg = imageClient.resolveAssetUserNegativeForApi(model, prop.negative_prompt);

  // 道具与场景/分镜共用版本化提示词编译器。显式 style 仍作为手动
  // 覆盖传入，但始终会被包在当前激活版本的 GLOBAL ART DIRECTION
  // 与 STYLE LOCK 之下。
  let compiled = null;
  try {
    const out = promptCompiler.compile(db, cfg, {
      entity_type: 'prop',
      entity_id: Number(propId),
      drama_id: prop.drama_id,
      frame_type: 'main',
      style: styleOverride || undefined,
      prompt: styleOverride ? String(prop.prompt || '').trim() : undefined,
      negative_prompt: prop.negative_prompt || undefined,
      aspect_ratio: cfg?.style?.default_image_ratio || undefined,
      quality: opts?.quality || undefined,
    });
    if (out?.ok) compiled = out;
  } catch (err) {
    log.warn('[道具图生] 统一提示词编译失败，使用兼容回退', { prop_id: propId, error: err.message });
  }

  const fallbackStyle = styleOverride || propScopedStyle(cfg?.style).en;
  const fallbackPrompt = appendPrompt(String(prop.prompt).trim(), fallbackStyle);
  const fullPrompt = compiled?.compiled_prompt || fallbackPrompt;
  const effectiveNegative = compiled?.compiled_negative_prompt || userNeg || '';
  const referenceImages = compiled?.reference_images || [];
  let contextSnapshot = null;
  if (compiled?.ok) {
    try {
      contextSnapshot = generationContextService.createSnapshot(db, {
        drama_id: compiled.drama_id || prop.drama_id,
        episode_id: compiled.episode_id,
        scene_id: compiled.scene_id,
        storyboard_id: compiled.storyboard_id,
        entity_type: compiled.entity_type,
        entity_id: compiled.entity_id,
        frame_type: compiled.frame_type,
        style_version_id: compiled.style_version_id,
        style_signature: compiled.style_signature,
        prompt_source: compiled.prompt_source,
        source_prompt: compiled.source_prompt,
        compiled_prompt: compiled.compiled_prompt,
        compiled_negative_prompt: compiled.compiled_negative_prompt,
        reference_pack: compiled.reference_pack,
        source_snapshot: compiled.source_snapshot,
        prompt_hash: compiled.prompt_hash,
        reference_hash: compiled.reference_hash,
        compiler_version: compiled.compiler_version,
        diagnostics: compiled.diagnostics,
      });
    } catch (err) {
      log.warn('[道具图生] 生成上下文快照写入失败', { prop_id: propId, error: err.message });
    }
  }
  if (contextSnapshot) {
    try { generationContextService.markEntityCompiled(db, compiled); } catch (_) {}
  }

  let imageGenerationId = null;
  try {
    imageGenerationId = createPropImageGenerationRecord(db, {
      prop_id: propId,
      drama_id: prop.drama_id,
      provider: preferredProvider || 'openai',
      prompt: fullPrompt,
      negative_prompt: effectiveNegative,
      model,
      size: imageSize,
      quality: opts?.quality,
      reference_images: referenceImages,
      compiled,
      context_snapshot_id: contextSnapshot?.id || null,
      task_id: taskId,
    });
  } catch (err) {
    // provenance 不是请求成功的前置条件；旧库缺列时仍允许兼容生图，
    // 但会在日志中明确暴露，方便迁移审计。
    log.warn('[道具图生] image_generations provenance 写入失败', { prop_id: propId, error: err.message });
  }

  let result;
  try {
    result = await imageClient.callImageApi(db, log, {
      prompt: fullPrompt,
      size: imageSize,
      drama_id: prop.drama_id,
      model: model || undefined,
      quality: opts?.quality || undefined,
      preferred_provider: preferredProvider || undefined,
      user_negative_prompt: effectiveNegative || undefined,
      reference_image_urls: referenceImages.length ? referenceImages : undefined,
      image_gen_id: imageGenerationId || undefined,
    });
  } catch (err) {
    const errMsg = '图片生成请求失败: ' + (err.message || '未知错误');
    updatePropImageGeneration(db, imageGenerationId, { status: 'failed', error_msg: errMsg });
    log.error('Prop image API failed', { prop_id: propId, error: err.message });
    taskService.updateTaskError(db, taskId, errMsg);
    try {
      db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, new Date().toISOString(), propId);
    } catch (_) {}
    return;
  }

  if (result.error) {
    updatePropImageGeneration(db, imageGenerationId, { status: 'failed', error_msg: result.error });
    taskService.updateTaskError(db, taskId, result.error);
    try {
      db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, new Date().toISOString(), propId);
    } catch (_) {}
    return;
  }
  if (!result.image_url) {
    const errMsg = '未返回图片地址';
    updatePropImageGeneration(db, imageGenerationId, { status: 'failed', error_msg: errMsg });
    taskService.updateTaskError(db, taskId, errMsg);
    try {
      db.prepare('UPDATE props SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, new Date().toISOString(), propId);
    } catch (_) {}
    return;
  }

  taskService.updateTaskStatus(db, taskId, 'processing', 80, '正在保存图片...');

  let localPath = null;
  try {
    const storagePath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, prop.drama_id);
    localPath = await uploadService.downloadImageToLocal(
      storagePath,
      result.image_url,
      'props',
      log,
      'prop_' + propId,
      projectSubdir
    );
  } catch (_) {}

  const now = new Date().toISOString();
  // 旧图追加到 extra_images，与上传逻辑保持一致
  const oldProp = db.prepare('SELECT local_path, image_url, extra_images FROM props WHERE id = ?').get(propId);
  const oldPath = oldProp?.local_path || oldProp?.image_url || '';
  let extras = [];
  try { extras = oldProp?.extra_images ? JSON.parse(oldProp.extra_images) : []; } catch (_) {}
  if (!Array.isArray(extras)) extras = [];
  if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
  const extraJson = extras.length ? JSON.stringify(extras) : null;
  try {
    db.prepare(
      'UPDATE props SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?'
    ).run(result.image_url, localPath, extraJson, now, propId);
  } catch (e) {
    if ((e.message || '').includes('extra_images')) {
      db.prepare('UPDATE props SET image_url = ?, local_path = ?, updated_at = ? WHERE id = ?').run(result.image_url, localPath, now, propId);
    } else {
      throw e;
    }
  }

  updatePropImageGeneration(db, imageGenerationId, {
    status: 'completed',
    image_url: result.image_url,
    local_path: localPath,
    completed_at: now,
    error_msg: null,
  });

  taskService.updateTaskResult(db, taskId, {
    image_url: result.image_url,
    local_path: localPath,
    prop_id: propId,
    image_generation_id: imageGenerationId,
    context_snapshot_id: contextSnapshot?.id || null,
    prompt_hash: compiled?.prompt_hash || null,
  });
  log.info('Prop image generation completed', { prop_id: propId, image_generation_id: imageGenerationId, image_url: result.image_url, local_path: localPath });
}

function generatePropImage(db, log, propId, opts) {
  const prop = propService.getById(db, propId);
  if (!prop) throw new Error('道具不存在');
  if (!prop.prompt || !String(prop.prompt).trim()) {
    throw new Error('道具没有图片提示词');
  }

  const task = taskService.createTask(db, log, 'prop_image_generation', String(propId));
  setImmediate(() => {
    processPropImageGeneration(db, log, task.id, propId, opts || {}).catch((err) => {
      log.error('processPropImageGeneration fatal', { error: err.message, task_id: task.id });
    });
  });
  return task.id;
}

module.exports = {
  generatePropImage,
  processPropImageGeneration,
  createPropImageGenerationRecord,
  updatePropImageGeneration,
};
