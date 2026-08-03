// P3：实体库形象生产。
// 角色/道具 → 纯色底出图 + 本地抠图成透明纸片素材；场景 → clean plate 空景。
// 每个实体 1 次图片调用；必须由前端显式确认后才会进入本服务（BR-001）。
const path = require('path');
const sharp = require('sharp');
const imageClient = require('../imageClient');
const uploadService = require('../uploadService');
const storageLayout = require('../storageLayout');
const { estimateBorderKeyColor, alphaForPixel, defringeRgba } = require('../paperMatteService');
const providerService = require('./paperProviderCapabilityService');
const schemaService = require('./paperStudioSchemaService');
const projectService = require('./paperStudioProjectService');
const libraryService = require('./paperLibraryService');
const { storageRoot } = require('./paperAssetProductionService');
const {
  PaperStudioError,
  canonicalJson,
  nowIso,
  sha256,
} = require('./paperStudioUtils');

const SIZE_BY_TYPE = {
  character: '1024x1536',
  prop: '1024x1024',
  scene: '1664x928',
};

function promptForEntity(entity, styleAnchor) {
  const anchor = styleAnchor?.anchor_text ? `${styleAnchor.anchor_text}。` : '手工剪纸动画风格，扁平色块，清晰描边。';
  const base = entity.canonical_prompt || entity.description || entity.name;
  if (entity.entity_type === 'scene') {
    return `${anchor}空镜场景背景图：${entity.name}。${base}。要求：干净空景，画面中绝对没有任何人物、动物或可移动道具，没有文字；中下部留出角色活动空间；构图完整不裁切。`;
  }
  if (entity.entity_type === 'character') {
    return `${anchor}单个角色全身立绘：${entity.name}。${base}。要求：纯白色背景，单一主体居中，全身完整（头到脚），自然站立正面或四分之三侧面，四肢与躯干轮廓清晰不粘连，无地面阴影，无文字。`;
  }
  return `${anchor}单个道具图：${entity.name}。${base}。要求：纯白色背景，单一主体居中占画面约七成，轮廓完整清晰，无地面阴影，无投影，无文字。`;
}

function createGeneration(db, project, entity, provider, prompt, size, fingerprint) {
  const columns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  const values = {
    drama_id: Number(project.drama_id),
    provider: provider.provider || 'image',
    prompt,
    model: provider.model,
    frame_type: 'paper_identity',
    size,
    quality: 'high',
    status: 'processing',
    generation_kind: 'paper_studio_identity',
    generation_purpose: `paper_library_${entity.entity_type}`,
    request_fingerprint: fingerprint,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const entries = Object.entries(values).filter(([key]) => columns.has(key));
  return Number(db.prepare(`INSERT INTO image_generations (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value)).lastInsertRowid);
}

async function extractAlpha(cfg, sourceRel) {
  const root = storageRoot(cfg);
  const sourceAbs = path.join(root, sourceRel);
  const input = await sharp(sourceAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(input.data);
  const key = estimateBorderKeyColor(data, input.info);
  const threshold = 34;
  const softness = 22;
  for (let y = 0; y < input.info.height; y += 1) {
    for (let x = 0; x < input.info.width; x += 1) {
      const i = (y * input.info.width + x) * 4;
      const alpha = alphaForPixel(data[i], data[i + 1], data[i + 2], data[i + 3], key, threshold, softness);
      data[i + 3] = alpha;
    }
  }
  defringeRgba(data, input.info, key, { apply_unmix: true });
  let visible = 0;
  let minX = input.info.width;
  let minY = input.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < input.info.height; y += 1) {
    for (let x = 0; x < input.info.width; x += 1) {
      if (data[(y * input.info.width + x) * 4 + 3] < 12) continue;
      visible += 1;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const alphaRel = sourceRel.replace(/(\.[a-zA-Z0-9]+)?$/, '') + '-alpha.png';
  await sharp(data, { raw: input.info }).png().toFile(path.join(root, alphaRel));
  const total = input.info.width * input.info.height;
  const visibleRatio = total ? visible / total : 0;
  const bbox = maxX >= 0 ? {
    x: minX / input.info.width,
    y: minY / input.info.height,
    width: (maxX - minX + 1) / input.info.width,
    height: (maxY - minY + 1) / input.info.height,
  } : null;
  return {
    alpha_rel: alphaRel,
    quality: {
      visible_ratio: Number(visibleRatio.toFixed(4)),
      key_color: key,
      pass: visibleRatio > 0.02 && visibleRatio < 0.95,
    },
    registration: {
      canvas: { width: input.info.width, height: input.info.height },
      subject_bbox: bbox,
      ground_anchor: bbox ? Number((bbox.y + bbox.height).toFixed(4)) : null,
    },
  };
}

function nextVersionNumber(db, entityId) {
  return Number(db.prepare('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM paper_library_identity_versions WHERE entity_id = ?').get(Number(entityId)).next);
}

async function generateOne(db, cfg, log, project, entity, provider, styleAnchor, requestId) {
  const prompt = promptForEntity(entity, styleAnchor);
  const size = SIZE_BY_TYPE[entity.entity_type] || '1024x1024';
  const fingerprint = sha256(canonicalJson({ entity_id: entity.id, prompt, provider, size }));
  const generationId = createGeneration(db, project, entity, provider, prompt, size, fingerprint);
  try {
    const result = await imageClient.callImageApi(db, log, {
      prompt,
      model: provider.model || undefined,
      preferred_provider: provider.provider || undefined,
      size,
      quality: 'high',
      drama_id: Number(project.drama_id),
      imageServiceType: 'storyboard_image',
      image_gen_id: generationId,
      files_base_url: cfg?.storage?.base_url,
      storage_local_path: storageRoot(cfg),
      user_negative_prompt: 'text, caption, watermark, logo, split panel, collage, multiple views',
    });
    if (result?.error || !result?.image_url) throw new Error(result?.error || '图片 API 未返回图片');
    const projectDir = storageLayout.getProjectStorageSubdir(db, project.drama_id);
    const downloaded = await uploadService.downloadImageToLocal(storageRoot(cfg), result.image_url, 'paper-library', log, `paper-entity-${entity.id}-g${generationId}`, projectDir);
    if (!downloaded) throw new Error('形象图片下载到本地失败');

    let alphaInfo = null;
    if (entity.entity_type !== 'scene') {
      try {
        alphaInfo = await extractAlpha(cfg, downloaded);
      } catch (matteError) {
        if (log) log.warn('Paper identity alpha extraction failed', { entity_id: entity.id, error: matteError.message });
      }
    }

    const now = nowIso();
    const versionNumber = nextVersionNumber(db, entity.id);
    const insert = db.prepare(
      `INSERT INTO paper_library_identity_versions
         (entity_id, version_number, source_local_path, alpha_local_path, source_hash,
          registration_json, provenance_json, derivation_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'generated', 'candidate', ?)`,
    ).run(
      entity.id,
      versionNumber,
      downloaded,
      alphaInfo?.alpha_rel || null,
      null,
      JSON.stringify({ ...(alphaInfo?.registration || {}), quality: alphaInfo?.quality || null }),
      JSON.stringify({
        request_id: requestId,
        image_generation_id: generationId,
        provider: provider.provider,
        model: provider.model,
        prompt,
        size,
        style_anchor_hash: styleAnchor?.anchor_hash || null,
        request_fingerprint: fingerprint,
      }),
      now,
    );
    db.prepare("UPDATE image_generations SET image_url = ?, local_path = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(result.image_url, downloaded, now, now, generationId);
    return {
      entity_id: entity.id,
      ok: true,
      version_id: Number(insert.lastInsertRowid),
      version_number: versionNumber,
      alpha_ok: Boolean(alphaInfo?.alpha_rel),
    };
  } catch (error) {
    db.prepare("UPDATE image_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(error.message, nowIso(), generationId);
    return { entity_id: entity.id, ok: false, error: error.message };
  }
}

async function generate(db, cfg, log, projectId, body = {}) {
  schemaService.assertValid('apiPaperIdentityGenerate', body, '生成实体形象的参数无效');
  const project = projectService.get(db, projectId);
  const provider = providerService.select(db, body.image_provider_config_id || null);
  if (!provider) throw new PaperStudioError('PAPER_STUDIO_PROVIDER_UNAVAILABLE', '没有可用的图片 API 配置', {}, 409);
  const styleAnchor = libraryService.getStyleAnchor(db, project.id);
  const entities = body.entity_ids.map((id) => libraryService.getEntity(db, id));
  for (const entity of entities) {
    if (entity.project_id !== project.id) throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_MISMATCH', '实体不属于当前项目', { entity_id: entity.id }, 409);
    if (entity.status === 'archived') throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_ARCHIVED', `实体「${entity.name}」已归档，不能生成形象`, { entity_id: entity.id }, 409);
  }
  const results = [];
  for (const entity of entities) {
    // 串行执行，避免同时打爆图片 API 限流
    // eslint-disable-next-line no-await-in-loop
    results.push(await generateOne(db, cfg, log, project, entity, provider, styleAnchor, body.request_id));
  }
  const succeeded = results.filter((item) => item.ok).length;
  if (log) log.info('Paper identity generation batch finished', { project_id: project.id, requested: entities.length, succeeded });
  return { results, succeeded, failed: results.length - succeeded, library: libraryService.library(db, project.id) };
}

function review(db, log, versionId, body = {}) {
  schemaService.assertValid('apiPaperIdentityReview', body, '审核形象版本的参数无效');
  const row = db.prepare('SELECT * FROM paper_library_identity_versions WHERE id = ?').get(Number(versionId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_IDENTITY_VERSION_NOT_FOUND', '形象版本不存在', { version_id: Number(versionId) }, 404);
  if (row.status !== 'candidate') throw new PaperStudioError('PAPER_STUDIO_IDENTITY_VERSION_NOT_REVIEWABLE', '该形象版本已审核过', { version_id: Number(versionId), status: row.status }, 409);
  const entity = libraryService.getEntity(db, row.entity_id);
  const now = nowIso();
  const transaction = db.transaction(() => {
    if (body.decision === 'approve') {
      db.prepare("UPDATE paper_library_identity_versions SET status = 'superseded' WHERE entity_id = ? AND status = 'approved'").run(entity.id);
      db.prepare("UPDATE paper_library_identity_versions SET status = 'approved', accepted_at = ? WHERE id = ?").run(now, Number(versionId));
      db.prepare('UPDATE paper_library_entities SET current_identity_version_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(Number(versionId), now, entity.id);
    } else {
      db.prepare("UPDATE paper_library_identity_versions SET status = 'rejected', rejected_at = ? WHERE id = ?").run(now, Number(versionId));
    }
  });
  transaction();
  if (log) log.info('Paper identity version reviewed', { version_id: Number(versionId), entity_id: entity.id, decision: body.decision });
  return { entity: libraryService.getEntity(db, entity.id), decision: body.decision };
}

module.exports = { generate, review, promptForEntity, SIZE_BY_TYPE };
