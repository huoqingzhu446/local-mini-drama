const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const imageClient = require('../imageClient');
const uploadService = require('../uploadService');
const storageLayout = require('../storageLayout');
const paperMatte = require('../paperMatteService');
const schemaService = require('./paperStudioSchemaService');
const runService = require('./paperStudioRunService');
const shotService = require('./paperStudioShotService');
const providerCapabilityService = require('./paperProviderCapabilityService');
const runAggregateService = require('./paperRunAggregateService');
const continuityService = require('./paperContinuityService');
const revisionService = require('./paperSourceRevisionService');
const sourceService = require('./paperStudioSourceService');
const matteThresholds = require('./paperMatteThresholds');
const actionCatalogService = require('./paperActionCatalogService');
const { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion } = require('./paperStudioPlannerVersion');
const {
  normalizeVisualBible,
  parseDramaMetadata,
  visualStyleStateFromDramaRow,
} = require('../../utils/dramaStyleMerge');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const transparentUnsupportedProviders = new Set();

function storageRoot(cfg) {
  const configured = cfg?.storage?.local_path || './data/storage';
  return path.resolve(process.cwd(), configured);
}

function safeStorageFile(cfg, relativePath) {
  const root = storageRoot(cfg);
  const clean = String(relativePath || '').replace(/^\/static\//, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(root, clean);
  if (!clean || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
    throw new PaperStudioError('PAPER_STUDIO_ASSET_PATH_INVALID', '素材路径不在本地存储目录内', { local_path: relativePath }, 422);
  }
  return resolved;
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function selectedProvider(db, run) {
  const configId = Number(run.selection_json?.image_provider_config_id || 0);
  const selected = providerCapabilityService.select(db, configId > 0 ? configId : null);
  return {
    provider: selected.provider,
    model: selected.model,
    config_id: selected.id,
    api_protocol: selected.api_protocol,
    capabilities: selected.capabilities,
  };
}

function insertVersion(db, slot, derivationKind, provenance = {}) {
  const next = db.prepare('SELECT COALESCE(MAX(attempt_index), 0) + 1 AS attempt FROM paper_asset_versions WHERE slot_id = ?').get(Number(slot.id));
  const result = db.prepare(
    `INSERT INTO paper_asset_versions
      (slot_id, source_family_id, attempt_index, derivation_kind, reuse_fingerprint, processing_json,
       registration_json, provenance_json, quality_report_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, '{}', 'candidate', ?)`,
  ).run(Number(slot.id), Number(slot.family_id), Number(next.attempt), derivationKind, slot.reuse_fingerprint || null, JSON.stringify(provenance), nowIso());
  return Number(result.lastInsertRowid);
}

function isProceduralStateFallback(slot) {
  return Boolean(
    slot
    && slot.required_for_gate === false
    && slot.constraints_json?.fallback === 'procedural'
    && slot.constraints_json?.state,
  );
}

function deriveProceduralStateFallback(db, slot) {
  if (slot.current_version_id) {
    const current = db.prepare("SELECT id FROM paper_asset_versions WHERE id = ? AND slot_id = ? AND status = 'accepted'")
      .get(Number(slot.current_version_id), Number(slot.id));
    if (current) return { versionId: Number(current.id), created: false };
  }
  const source = db.prepare(
    `SELECT pav.*, pas.slot_key AS source_slot_key
     FROM paper_asset_slots pas
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id AND pav.status = 'accepted'
     WHERE pas.family_id = ? AND pas.id != ? AND pas.deleted_at IS NULL
     ORDER BY CASE WHEN pas.id < ? THEN 0 ELSE 1 END, ABS(pas.id - ?), pas.id
     LIMIT 1`,
  ).get(Number(slot.family_id), Number(slot.id), Number(slot.id), Number(slot.id));
  if (!source?.source_local_path) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PROCEDURAL_FALLBACK_SOURCE_MISSING',
      '自动环境过渡缺少可复用的相邻状态素材',
      { slot_id: Number(slot.id), slot_key: slot.slot_key, state: slot.constraints_json?.state || null },
      409,
    );
  }
  const versionId = insertVersion(db, slot, 'procedural_state_fallback', {
    fallback_strategy: 'reuse_nearest_state_with_motion',
    source_asset_version_id: Number(source.id),
    source_slot_key: source.source_slot_key,
  });
  const now = nowIso();
  const requestId = `auto-procedural-fallback:${slot.id}:${versionId}`;
  const quality = {
    ...parseJson(source.quality_report_json, {}),
    pass: true,
    auto_accepted: true,
    fallback_strategy: 'reuse_nearest_state_with_motion',
    source_asset_version_id: Number(source.id),
    semantic_review: { status: 'approved', reviewer: 'system_procedural_fallback', reviewed_at: now },
  };
  db.transaction(() => {
    db.prepare(
      `UPDATE paper_asset_versions
       SET parent_version_id = ?, source_local_path = ?, alpha_local_path = ?, mask_local_path = ?,
           source_hash = ?, alpha_hash = ?, mask_hash = ?, processing_json = ?, registration_json = ?,
           quality_report_json = ?, status = 'accepted', accepted_at = ?
       WHERE id = ?`,
    ).run(
      Number(source.id), source.source_local_path, source.alpha_local_path, source.mask_local_path,
      source.source_hash, source.alpha_hash, source.mask_hash,
      JSON.stringify({ fallback_strategy: 'reuse_nearest_state_with_motion', source_asset_version_id: Number(source.id) }),
      source.registration_json || '{}', JSON.stringify(quality), now, versionId,
    );
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?")
      .run(versionId, now, Number(slot.id));
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       SELECT psf.shot_id, ?, ?, 'approved', ?, 'system_procedural_fallback', ?, ?
       FROM paper_source_families psf WHERE psf.id = ?`,
    ).run(
      Number(slot.id), versionId, '相邻正式状态已通过审核；中间状态由本地动作轨道自动过渡',
      requestId, now, Number(slot.family_id),
    );
  })();
  return { versionId, created: true };
}

function ensureProceduralStateFallbacks(db, shotId) {
  const slots = db.prepare(
    `SELECT pas.*
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     WHERE psf.shot_id = ?
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND psf.deleted_at IS NULL AND pas.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shotId), Number(shotId)).map((slot) => ({
    ...slot,
    id: Number(slot.id),
    family_id: Number(slot.family_id),
    current_version_id: slot.current_version_id == null ? null : Number(slot.current_version_id),
    required_for_gate: Boolean(slot.required_for_gate),
    constraints_json: parseJson(slot.constraints_json, {}),
  }));
  const repaired = [];
  for (const slot of slots.filter(isProceduralStateFallback)) {
    const result = deriveProceduralStateFallback(db, slot);
    if (result.created) repaired.push({ slot_id: Number(slot.id), slot_key: slot.slot_key, version_id: result.versionId });
  }
  return { repaired, repaired_count: repaired.length };
}

function ensureVersionPath(db, cfg, shot, versionId, slotKey, extension = 'png') {
  const run = db.prepare('SELECT * FROM paper_studio_runs WHERE id = ?').get(Number(shot.run_id));
  const projectDir = storageLayout.getProjectStorageSubdir(db, shot.drama_id);
  const relative = `${projectDir}/paper-studio/runs/${run.id}/shots/${shot.id}/assets/v${versionId}-${slotKey}.${extension}`.replace(/\\/g, '/');
  const absolute = safeStorageFile(cfg, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return { relative, absolute };
}

function ensureSourceVersionPath(db, cfg, shot, versionId, slotKey, extension = 'png') {
  return ensureVersionPath(db, cfg, shot, versionId, `${slotKey}-source`, extension);
}

async function alphaReport(inputPath, outputPath, { requireAlpha = true } = {}) {
  const source = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(source.data);
  const keyEstimate = requireAlpha ? paperMatte.estimateBorderKey(data, source.info, 'auto') : null;
  const key = keyEstimate?.key || null;
  const pixels = source.info.width * source.info.height;
  let inputTransparent = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 245) inputTransparent += 1;
  }
  let matteMethod = inputTransparent / pixels > 0.015
    ? 'provider_alpha'
    : keyEstimate?.mode === 'dark_v1' ? 'border_matte_dark_v1' : 'border_matte_v2';
  if (requireAlpha && matteMethod !== 'provider_alpha') {
    for (let index = 0; index < data.length; index += 4) {
      data[index + 3] = paperMatte.alphaForPixel(data[index], data[index + 1], data[index + 2], data[index + 3], key, 24, 48);
    }
  }
  const defringe = requireAlpha
    ? paperMatte.defringeRgba(data, source.info, key, { apply_unmix: matteMethod !== 'provider_alpha' })
    : null;
  let transparent = 0;
  let visible = 0;
  let minX = source.info.width;
  let minY = source.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < source.info.height; y += 1) {
    for (let x = 0; x < source.info.width; x += 1) {
      const alpha = data[(y * source.info.width + x) * 4 + 3];
      if (alpha < 20) transparent += 1;
      else {
        visible += 1;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  await sharp(data, { raw: source.info }).png().toFile(outputPath);
  const transparentRatio = transparent / pixels;
  const visibleRatio = visible / pixels;
  const bbox = maxX >= 0 ? {
    x: minX / source.info.width,
    y: minY / source.info.height,
    width: (maxX - minX + 1) / source.info.width,
    height: (maxY - minY + 1) / source.info.height,
  } : {};
  const pass = !requireAlpha || matteThresholds.alphaGate({
    transparentRatio,
    visibleRatio,
    residualKeyEdgeRatio: defringe?.residual_key_edge_ratio || 0,
    checkResidualKey: Boolean(defringe?.chroma_green),
  });
  return {
    pass,
    width: source.info.width,
    height: source.info.height,
    pixels,
    matte_method: matteMethod,
    key_color: key,
    key_confidence: keyEstimate,
    defringe,
    residual_key_edge_ratio: defringe?.residual_key_edge_ratio || 0,
    transparent_ratio: Number(transparentRatio.toFixed(6)),
    visible_ratio: Number(visibleRatio.toFixed(6)),
    alpha_bbox: bbox,
  };
}

function sourceForSlot(db, shot, slot) {
  const constraints = slot.constraints_json || {};
  if (constraints.allow_source_import === false) return null;
  if (constraints.source_storyboard_reference === true && sourceService.isPaperShot(shot)) {
    const storyboard = sourceService.storyboard(db, shot);
    if (storyboard?.local_path) {
      return {
        local_path: storyboard.local_path,
        source_kind: 'storyboard_reference',
        source_id: Number(storyboard.id),
      };
    }
  }
  const librarySource = require('./paperLibraryReuseService').sourceForSlot(db, shot, slot);
  if (librarySource) return librarySource;
  if (constraints.source_scene_id && constraints.source_is_clean_plate === true) {
    const scene = db.prepare('SELECT id, image_url, local_path FROM scenes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_scene_id), Number(shot.drama_id));
    if (scene?.local_path) return { local_path: scene.local_path, source_kind: 'scene', source_id: Number(scene.id) };
  }
  if (constraints.source_prop_id) {
    const prop = db.prepare('SELECT id, image_url, local_path FROM props WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_prop_id), Number(shot.drama_id));
    if (prop?.local_path) return { local_path: prop.local_path, source_kind: 'prop', source_id: Number(prop.id) };
  }
  if (constraints.source_character_id) {
    const character = db.prepare('SELECT id, image_url, local_path FROM characters WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_character_id), Number(shot.drama_id));
    if (character?.local_path) return { local_path: character.local_path, source_kind: 'character', source_id: Number(character.id) };
  }
  if (constraints.source_character_library_id) {
    const character = db.prepare('SELECT id, image_url, local_path FROM character_libraries WHERE id = ? AND deleted_at IS NULL').get(Number(constraints.source_character_library_id));
    if (character?.local_path) return { local_path: character.local_path, source_kind: 'character_library', source_id: Number(character.id) };
  }
  return null;
}

function isImageReference(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return true;
  return /\.(?:png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i.test(text);
}

function mediaReference(row) {
  return [row?.local_path, row?.image_url, row?.ref_image, row?.four_view_image_url]
    .find((value) => isImageReference(value)) || null;
}

function referenceImagesForSlot(db, shot, slot, provider) {
  if (!provider.capabilities?.reference_images) return [];
  const constraints = slot.constraints_json || {};
  const refs = [];
  const add = (value) => {
    if (isImageReference(value) && !refs.includes(value)) refs.push(value);
  };
  const canUseSceneReference = slot.asset_type === 'environment'
    ? constraints.source_is_clean_plate === true
    : constraints.use_scene_as_reference === true;
  // The first scene uses the selected storyboard as a composition authority.
  // Later scenes use an accepted sibling plate (when available) and the
  // storyboard only as style continuity references.
  if (sourceService.isPaperShot(shot) && slot.asset_type === 'environment') {
    if (constraints.use_storyboard_composition_reference !== false) {
      add(sourceService.referenceMedia(db, shot));
    } else {
      const acceptedEnvironment = db.prepare(
        `SELECT pav.alpha_local_path, pav.source_local_path
         FROM paper_asset_versions pav
         JOIN paper_asset_slots pas ON pas.id = pav.slot_id
         JOIN paper_source_families psf ON psf.id = pas.family_id
         WHERE psf.shot_id = ?
           AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
           AND pas.asset_type = 'environment'
           AND pas.id != ? AND pav.status = 'accepted'
         ORDER BY pav.id DESC LIMIT 1`,
      ).get(Number(shot.id), Number(shot.id), Number(slot.id));
      add(acceptedEnvironment?.alpha_local_path || acceptedEnvironment?.source_local_path);
      add(sourceService.referenceMedia(db, shot));
    }
  }
  if (canUseSceneReference) {
    const scene = constraints.source_scene_id
      ? db.prepare('SELECT * FROM scenes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_scene_id), Number(shot.drama_id))
      : sourceService.isPaperShot(shot)
        ? null
        : db.prepare('SELECT s.* FROM scenes s JOIN storyboards sb ON sb.scene_id = s.id WHERE sb.id = ? AND s.deleted_at IS NULL').get(Number(shot.legacy_storyboard_id || shot.storyboard_id));
    add(mediaReference(scene));
  }
  if (constraints.source_prop_id) {
    add(mediaReference(db.prepare('SELECT * FROM props WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_prop_id), Number(shot.drama_id))));
  }
  if (constraints.source_character_id) {
    add(mediaReference(db.prepare('SELECT * FROM characters WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(constraints.source_character_id), Number(shot.drama_id))));
  }
  if (constraints.source_character_library_id) {
    add(mediaReference(db.prepare('SELECT * FROM character_libraries WHERE id = ? AND deleted_at IS NULL').get(Number(constraints.source_character_library_id))));
  }
  continuityService.referencePathsForSlot(db, shot, slot, provider).forEach(add);
  const siblings = db.prepare(
    `SELECT pas.constraints_json, pav.alpha_local_path, pav.source_local_path
     FROM paper_asset_slots pas
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE pas.family_id = ? AND pas.id != ? AND pav.status = 'accepted'
     ORDER BY pas.id`,
  ).all(Number(slot.family_id), Number(slot.id));
  const subjectKey = constraints.subject_key || null;
  siblings
    .filter((item) => {
      if (!subjectKey) return false;
      return parseJson(item.constraints_json, {}).subject_key === subjectKey;
    })
    .forEach((item) => add(item.alpha_local_path || item.source_local_path));
  if (slot.asset_type !== 'environment' && refs.length === 0) {
    add(sourceService.referenceMedia(db, shot));
  }
  return refs.slice(0, Math.max(0, Number(provider.capabilities.max_reference_images || 0)));
}

function referenceEvidence(cfg, referenceImages = []) {
  return referenceImages.map((reference, index) => {
    const value = String(reference || '');
    if (/^data:image\//i.test(value)) {
      return { order: index + 1, kind: 'data_url', content_hash: sha256(value) };
    }
    if (/^https?:\/\//i.test(value)) {
      return { order: index + 1, kind: 'remote_url', url: value, locator_hash: sha256(value) };
    }
    try {
      const absolute = safeStorageFile(cfg, value);
      return {
        order: index + 1,
        kind: 'local_file',
        local_path: value,
        content_hash: fs.existsSync(absolute) ? hashFile(absolute) : null,
      };
    } catch (_) {
      return { order: index + 1, kind: 'unresolved', reference: value, locator_hash: sha256(value) };
    }
  });
}

async function importSource(db, cfg, shot, slot, source) {
  const versionId = insertVersion(db, slot, 'source_import', source);
  const target = ensureVersionPath(db, cfg, shot, versionId, slot.slot_key);
  const sourceTarget = ensureSourceVersionPath(db, cfg, shot, versionId, slot.slot_key);
  const sourceAbsolute = safeStorageFile(cfg, source.local_path);
  if (!fs.existsSync(sourceAbsolute)) throw new PaperStudioError('PAPER_STUDIO_SOURCE_ASSET_MISSING', '引用的正式素材文件不存在', { slot_id: slot.id, local_path: source.local_path }, 422);
  fs.copyFileSync(sourceAbsolute, sourceTarget.absolute);
  const requireAlpha = slot.asset_type !== 'environment';
  const report = await alphaReport(sourceTarget.absolute, target.absolute, { requireAlpha });
  if (!report.pass) throw new PaperStudioError('PAPER_STUDIO_ASSET_GATE_FAILED', '正式素材无法形成可用透明纸片', { slot_id: slot.id, report }, 422);
  const sourceHash = hashFile(sourceTarget.absolute);
  const outputHash = hashFile(target.absolute);
  db.prepare(
    `UPDATE paper_asset_versions SET source_local_path = ?, alpha_local_path = ?, source_hash = ?,
       alpha_hash = ?, processing_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ?
     WHERE id = ?`,
  ).run(sourceTarget.relative, requireAlpha ? target.relative : null, sourceHash, requireAlpha ? outputHash : null, JSON.stringify({ derivation: 'immutable_copy', matte_method: report.matte_method }), JSON.stringify(report), nowIso(), versionId);
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?").run(versionId, nowIso(), Number(slot.id));
  return versionId;
}

async function deriveMask(db, cfg, shot, slot) {
  const generator = 'registered-boundary-mask-v1';
  const constraints = slot.constraints_json || {};
  const family = db.prepare('SELECT registration_canvas_json FROM paper_source_families WHERE id = ?').get(Number(slot.family_id));
  const canvas = parseJson(family?.registration_canvas_json, {});
  const width = Math.max(1, Math.round(Number(canvas.width || 1920)));
  const height = Math.max(1, Math.round(Number(canvas.height || 1080)));
  const boundaryY = Math.max(0, Math.min(1, Number(constraints.boundary_y ?? 0.53)));
  const fillDirection = constraints.fill_direction === 'above' ? 'above' : 'below';
  const versionId = insertVersion(db, slot, 'procedural_mask', {
    generator,
    boundary: constraints.boundary || null,
    boundary_description: constraints.boundary_description || null,
  });
  const target = ensureVersionPath(db, cfg, shot, versionId, slot.slot_key);
  const boundaryRow = Math.round(height * boundaryY);
  const overlay = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const inside = fillDirection === 'above' ? y <= boundaryRow : y >= boundaryRow;
    if (!inside) continue;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      overlay[i] = 255; overlay[i + 1] = 255; overlay[i + 2] = 255; overlay[i + 3] = 255;
    }
  }
  await sharp(overlay, { raw: { width, height, channels: 4 } }).png().toFile(target.absolute);
  const hash = hashFile(target.absolute);
  const alphaCoverage = fillDirection === 'above' ? boundaryY : 1 - boundaryY;
  const registration = { width, height, origin: [0, 0], boundary: constraints.boundary || null, boundary_y: boundaryY, fill_direction: fillDirection };
  const report = { pass: true, ...registration, alpha_coverage: Number(alphaCoverage.toFixed(6)), registered_canvas: [width, height] };
  db.prepare(
    `UPDATE paper_asset_versions SET source_local_path = ?, alpha_local_path = ?, mask_local_path = ?,
       source_hash = ?, alpha_hash = ?, mask_hash = ?, processing_json = ?, registration_json = ?,
       quality_report_json = ?, status = 'accepted', accepted_at = ? WHERE id = ?`,
  ).run(target.relative, target.relative, target.relative, hash, hash, hash, JSON.stringify({ generator }), JSON.stringify(registration), JSON.stringify(report), nowIso(), versionId);
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?").run(versionId, nowIso(), Number(slot.id));
  return versionId;
}

function uniqueTextBlocks(parts) {
  const seen = new Set();
  return (parts || []).map((part) => String(part || '').trim()).filter((part) => {
    if (!part) return false;
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function styleLockForSlot(drama, scope = 'global') {
  const metadata = parseDramaMetadata(drama);
  const style = visualStyleStateFromDramaRow(drama);
  const scoped = scope === 'scene'
    ? [style.scene_style_prompt_en, style.scene_style_prompt_zh]
    : scope === 'character'
      ? [style.character_style_prompt_en, style.character_style_prompt_zh]
      : scope === 'prop'
        ? [style.prop_style_prompt_en, style.prop_style_prompt_zh]
        : [];
  const bibleSource = metadata.visual_bible_struct !== undefined
    ? parseJson(metadata.visual_bible_struct, metadata.visual_bible_struct)
    : (metadata.visual_bible || style.visual_bible || '');
  const visualBible = normalizeVisualBible(bibleSource);
  const projectStyle = uniqueTextBlocks([
    style.style_prompt_en,
    style.style_prompt_zh,
    ...scoped,
  ]);
  return uniqueTextBlocks([
    projectStyle.length ? `PROJECT VISUAL STYLE — mandatory:\n${projectStyle.join('\n\n')}` : '',
    visualBible ? `PROJECT VISUAL BIBLE — mandatory:\n${visualBible}` : '',
    'PAPER-ANIMATION MEDIUM GATE — mandatory: Render as a tactile 2D hand-painted paper-animation asset with visible traditional pigment, brush, paper or textile texture appropriate to the project style. Never output photography, live action, a photorealistic person, costume-drama publicity photography, smooth 3D CGI, plastic skin, glossy game art, or a generic AI-rendered look.',
  ]).join('\n\n');
}

function propStateInstruction(state) {
  const instructions = {
    intact: 'Reconstruct the same object fully intact and unbroken immediately before impact. This state overrides any damaged, cracked, broken or shattered wording and imagery in the source identity or references. No cracks, missing sections, loose fragments or repaired seams.',
    fracture: 'Show the first newly formed impact fracture: the same object is still mostly whole, with one clear fresh crack and only a few displaced fragments. Do not show a fully shattered or long-broken object.',
    broken: 'Show the same object fully broken after impact, with separated readable fragments and a clearly collapsed silhouette distinct from the intact and fracture states.',
  };
  return instructions[state] || '';
}

function promptForSlot(db, shot, slot) {
  const sourceContext = sourceService.context(db, shot);
  const storyboard = sourceContext.storyboard;
  const drama = db.prepare('SELECT title, style, metadata FROM dramas WHERE id = ?').get(Number(shot.drama_id));
  const semantic = parseJson(db.prepare('SELECT semantic_contract_json FROM paper_studio_shots WHERE id = ?').get(Number(shot.id))?.semantic_contract_json, {});
  const summary = parseJson(db.prepare('SELECT plan_summary_json FROM paper_studio_shots WHERE id = ?').get(Number(shot.id))?.plan_summary_json, {});
  const scene = sourceContext.scene;
  const constrainedSubject = (semantic.subjects || []).find((subject) => subject.key === slot.constraints_json?.subject_key);
  const primarySubject = constrainedSubject || (semantic.subjects || []).find((subject) => subject.key === 'primary_subject') || (semantic.subjects || [])[0] || {};
  const transportUnit = slot.constraints_json?.ensemble_kind === 'transport_unit';
  if (slot.asset_type === 'environment') {
    const styleLock = styleLockForSlot(drama, 'scene');
    const environmentOnly = Boolean(summary.environment_only || storyboard?.environment_only);
    const pathBase = actionCatalogService.isPathRevealSummary(summary);
    const selectedReference = sourceService.isPaperShot(shot) ? sourceService.referenceMedia(db, shot) : null;
    const sceneDescription = String(slot.constraints_json?.environment_description || semantic.environment?.description || '').trim();
    const compositionReference = slot.constraints_json?.use_storyboard_composition_reference !== false;
    const fixedSceneContext = [scene?.location, scene?.time].filter(Boolean);
    const place = (fixedSceneContext.length ? fixedSceneContext : [storyboard?.location, storyboard?.time].filter(Boolean))
      .join('，') || 'the fixed storyboard location and time';
    const cleanDescription = pathBase
      ? `Create the clean unannotated flat-diagram base shown by the selected storyboard reference. Preserve its exact top-down geometry, fixed landmarks, boundaries, paper framing, palette and camera composition. Remove every path line, arrow, moving marker, subject silhouette, title card, label and readable character; all changing information and people will be added later as independent layers.`
      : environmentOnly
        ? `Create the full environmental base frame at ${place}. Preserve the selected storyboard reference's visible environment storytelling, including its terrain, river or shoreline, fortifications, ruins, damaged structures, camps, fire and smoke, banners, vessels, distant silhouettes, debris, weather and atmospheric depth. These are part of this environment-only shot and must not be replaced by a generic empty landscape.`
        : `Create a clean environment plate for this exact visual scene: ${sceneDescription || place}. Preserve fixed terrain, shoreline, water, sky, permanent architecture, vegetation, damage to the location, weather, atmospheric depth, lighting and perspective. Remove only the characters or movable hero props that are explicitly planned as separate animation layers, then reconstruct the areas hidden behind them. Do not erase fixed story-world evidence such as ruined architecture or environmental damage.`;
    const storyContext = uniqueTextBlocks(environmentOnly || pathBase
      ? [storyboard?.description, storyboard?.action, storyboard?.atmosphere, storyboard?.visual_prompt, storyboard?.prompt]
      : [storyboard?.atmosphere, storyboard?.visual_prompt, storyboard?.prompt]).join('\n');
    return [
      pathBase
        ? 'Create the production clean flat-diagram plate for layered paper animation, not a finished annotated diagram.'
        : environmentOnly
        ? 'Create the production environment plate for this paper-animation shot.'
        : 'Create a production clean plate for layered paper animation, not a finished storyboard frame.',
      cleanDescription,
      selectedReference && compositionReference
        ? 'SELECTED STORYBOARD REFERENCE — highest priority composition and style authority: Match its composition, camera angle, era, location, geography, weather, damage state, lighting, color palette, paper texture and rendering medium. If any project-wide style text conflicts with the selected reference, the selected reference overrides that conflict.'
        : selectedReference
        ? `SELECTED STORYBOARD REFERENCE — STYLE ONLY: preserve its era, weather family, lighting direction, color palette, paper texture and rendering medium, but do not copy its location or composition. The required location and composition are: ${sceneDescription || place}.`
        : 'Keep the supplied reference composition, camera angle, lighting, perspective and visual style.',
      pathBase
        ? 'Keep the full canvas and all fixed diagram features, but reconstruct the base underneath every removed path, marker, person, title card and label. No blank cutout holes or erased smudges may remain.'
        : environmentOnly
        ? 'Do not simplify, beautify, modernize, relight or relocate the scene. Do not turn a cold, damaged, smoky or war-torn environment into a sunny, clean or peaceful generic landscape.'
        : 'Reconstruct every area hidden by the removed animation subjects. Keep the storyboard atmosphere and environmental description; the final image must have no text, logo, unexplained holes or subject-shaped shadows.',
      storyContext ? `STORYBOARD ENVIRONMENT CONTEXT — preserve unless it conflicts with the selected reference:\n${storyContext}` : '',
      'Single continuous 16:9 background, full canvas, opaque output, no collage and no split panel.',
      styleLock,
      selectedReference && compositionReference
        ? 'FINAL PRIORITY RULE: the selected storyboard reference controls composition, era, place, weather, damage, palette and medium; project defaults may refine details but may not replace those facts.'
        : selectedReference
        ? 'FINAL PRIORITY RULE: the scene-specific description controls place, camera and composition; references control only shared visual identity, era, weather family, palette and paper medium.'
        : '',
    ].filter(Boolean).join('\n\n');
  }
  const state = slot.constraints_json?.state || slot.generation_purpose.replace(/^.*state_/, '') || 'action';
  const stateDirections = {
    start: 'a neutral readable starting pose',
    action: 'the main action pose described by the storyboard',
    settle: 'a readable settled pose after the action',
    engage: 'an active contact or effort pose before the transition',
    destabilize: 'a visibly off-balance reaction caused by the support changing',
    separate: 'a clear separation or release pose with distinct silhouettes',
    approach: 'an approaching pose before boundary contact',
    contact: 'a clear pose at the instant of boundary contact',
    crossed: 'a readable pose after crossing the registered boundary',
    intact: 'an intact readable state immediately before impact',
    fracture: 'the exact impact state with a clearly visible new fracture and displaced fragments',
    broken: 'a fully broken settled state with separated readable fragments',
    raised: 'a raised preparation state before contact',
    released: 'a released state after contact',
    map_marker: 'one iconic full-body silhouette designed to appear as a neutral subject marker on the selected map or flat diagram, matching the selected storyboard reference',
  };
  const propSubject = primarySubject.kind === 'prop' || slot.asset_type.includes('prop');
  const styleScope = propSubject
    ? 'prop'
    : (primarySubject.kind === 'character' || slot.asset_type.includes('character') || slot.asset_type.includes('subject'))
      ? 'character'
      : 'global';
  const styleLock = styleLockForSlot(drama, styleScope);
  const groupSize = Array.isArray(slot.constraints_json?.group_size) ? slot.constraints_json.group_size : null;
  const groupHint = groupSize ? ` Keep the same group of ${groupSize[0]}${groupSize[1] !== groupSize[0] ? ` to ${groupSize[1]}` : ''} subjects across every state.` : '';
  const stateDirection = stateDirections[state] || `a clearly readable ${state} state derived from the storyboard action`;
  const moverDescriptions = {
    pusher: 'human pushers visibly leaning into and holding the vehicle handles',
    puller: 'human pullers visibly connected to and pulling the vehicle',
    draft_animal: 'draft animals visibly harnessed to the vehicle with complete shafts and harness',
    rider: 'a visible rider correctly seated on and controlling the vehicle',
    crew: 'visible crew members physically operating and moving the equipment',
  };
  const requiredMoverLine = (slot.constraints_json?.required_movers || []).map((mover) => (
    `at least ${Number(mover.min_visible || 1)} ${moverDescriptions[mover.role] || mover.role}`
  )).join('; ');
  const subjectLine = transportUnit
    ? `one complete ${slot.constraints_json?.vehicle_identity || primarySubject.identity || 'transport vehicle'} transport unit${requiredMoverLine ? ` together with ${requiredMoverLine}` : ''} as one coherent cutout`
    : propSubject
    ? `${primarySubject.identity || storyboard?.title || 'the required prop'}, isolated as one complete object`
    : `${primarySubject.identity || storyboard?.title || 'the primary storyboard subject'} in ${stateDirection}.${groupHint}`;
  const exclusions = transportUnit
    ? 'Exactly one transport unit per asset. Keep the required people or animals and the vehicle in physical contact. No unmanned moving vehicle, missing harness, detached hands, floating wheels, unrelated bystanders, scenery, ground, cast shadow, border, text, logo, collage or split panel.'
    : 'No unrelated characters or props, no support object unless this slot explicitly represents it, no scenery, no ground, no cast shadow, no border, no text, no logo, no collage, no split panel, no duplicate limbs.';
  const stateOverride = propSubject ? propStateInstruction(state) : '';
  return [
    'Create one production-ready paper animation cutout asset, not a finished scene.',
    `Subject: ${subjectLine}.`,
    stateOverride ? `STATE OVERRIDE — mandatory: ${stateOverride}` : '',
    transportUnit
      ? 'Show the complete vehicle, every required mover, hands or harness contact, wheels and feet or hooves in one clean separated silhouette. The transport must have an obvious physical cause for its motion.'
      : `Show the complete ${propSubject ? 'object' : 'subject'} with a clean separated silhouette. Preserve identity, proportions, facing, palette, mineral-pigment impasto and gongbi linework across all states.`,
    'Use a transparent background when the image endpoint supports it. If transparent output is unavailable, place the subject on one perfectly uniform technical chroma-green matte (#00FF00), edge to edge. The matte color is exempt from the project palette and will be removed locally. No gradient, texture, horizon, floor, contact shadow, halo or colored light spill on that matte.',
    exclusions,
    `Story context: ${storyboard?.title || ''}; ${storyboard?.action || storyboard?.description || ''}`,
    styleLock,
  ].filter(Boolean).join('\n\n');
}

function providerCapabilityKey(provider) {
  return `${Number(provider?.config_id || 0)}:${String(provider?.model || '')}`;
}

function isTransparentBackgroundUnsupported(error) {
  return /transparent background is not supported|transparent(?: output| background)?.{0,80}(?:not supported|unsupported)|background.{0,80}transparent.{0,80}(?:not supported|unsupported)/i
    .test(String(error?.message || error || ''));
}

function createImageGeneration(db, run, shot, slot, provider, prompt, requestFingerprint, referenceImages = [], options = {}) {
  const columns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  const values = {
    storyboard_id: sourceService.legacyStoryboardId(shot), paper_storyboard_id: shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id), drama_id: Number(shot.drama_id), provider: provider.provider || 'openai',
    prompt, model: provider.model, frame_type: slot.slot_key, size: '1536x1024', quality: 'high',
    status: 'processing', generation_kind: 'paper_studio_asset', generation_purpose: slot.generation_purpose,
    request_fingerprint: requestFingerprint, reference_images: referenceImages.length ? JSON.stringify(referenceImages) : null,
    paper_asset_version_id: options.version_id == null ? null : Number(options.version_id),
    paper_studio_run_id: Number(run.id), paper_studio_shot_id: Number(shot.id), paper_asset_slot_id: Number(slot.id),
    generation_authorization_id: options.authorization_id == null ? null : Number(options.authorization_id),
    provider_call_count: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  const entries = Object.entries(values).filter(([key]) => columns.has(key));
  const result = db.prepare(`INSERT INTO image_generations (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value));
  return Number(result.lastInsertRowid);
}

function usedImageCount(db, runId) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS count
     FROM image_generations
     WHERE generation_kind = 'paper_studio_asset'
       AND paper_studio_run_id = ?
       AND deleted_at IS NULL
       AND (
         status IN ('processing','completed')
         OR (status = 'failed' AND provider_attempted_at IS NOT NULL)
       )`,
  ).get(Number(runId))?.count || 0);
}

function reserveProviderCall(db, imageGenerationId, maxAttempts) {
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT id, status, provider_call_count, generation_authorization_id, paper_asset_slot_id
       FROM image_generations WHERE id = ? AND deleted_at IS NULL`,
    ).get(Number(imageGenerationId));
    if (!row || !['processing', 'failed'].includes(row.status)) {
      throw new PaperStudioError(
        'PAPER_STUDIO_GENERATION_ATTEMPT_STATE_CONFLICT',
        '图片生成记录当前不能继续调用模型',
        { image_generation_id: Number(imageGenerationId), status: row?.status || null },
        409,
      );
    }
    const used = Number(row.provider_call_count || 0);
    const limit = Math.max(1, Number(maxAttempts || 1));
    if (used >= limit) {
      throw new PaperStudioError(
        'PAPER_STUDIO_GENERATION_AUTHORIZED_CALLS_EXHAUSTED',
        '当前素材槽位已用完授权的图片模型调用次数',
        {
          image_generation_id: Number(imageGenerationId),
          authorization_id: row.generation_authorization_id == null ? null : Number(row.generation_authorization_id),
          slot_id: row.paper_asset_slot_id == null ? null : Number(row.paper_asset_slot_id),
          used_calls: used,
          max_attempts: limit,
        },
        409,
      );
    }
    const now = nowIso();
    db.prepare(
      `UPDATE image_generations
       SET status = 'processing', provider_call_count = provider_call_count + 1,
           provider_attempted_at = COALESCE(provider_attempted_at, ?), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, Number(imageGenerationId));
    return used + 1;
  })();
}

function isTransientProviderFailure(error) {
  return /(?:502|503|504|timeout|timed out|ECONNRESET|socket hang up|upstream|temporarily unavailable)/i
    .test(String(error?.message || error || ''));
}

async function generateViaApi(db, cfg, log, run, shot, slot, authorizationId) {
  const authorization = require('./paperGenerationAuthorizationService').assertUsable(db, authorizationId, {
    runId: run.id,
    shotId: shot.id,
    slotId: slot.id,
  });
  const maxImages = Number(run.budget_json?.max_images || 24);
  const provider = selectedProvider(db, run);
  const prompt = promptForSlot(db, shot, slot);
  const transportUnit = slot.constraints_json?.ensemble_kind === 'transport_unit';
  const referenceImages = referenceImagesForSlot(db, shot, slot, provider);
  const sourceStoryboard = sourceService.storyboard(db, shot);
  const environmentOnly = Boolean(shot.plan_summary_json?.environment_only || sourceStoryboard?.environment_only);
  const pathBase = actionCatalogService.isPathRevealSummary(shot.plan_summary_json || {});
  const selectedStoryboardReference = sourceService.isPaperShot(shot)
    ? sourceService.referenceMedia(db, shot)
    : null;
  const compositionReferenceRequired = slot.constraints_json?.use_storyboard_composition_reference !== false;
  const styleReferenceRequired = slot.asset_type === 'environment'
    && slot.constraints_json?.reference_role === 'style_only'
    && Boolean(selectedStoryboardReference);
  if (slot.asset_type === 'environment' && selectedStoryboardReference && compositionReferenceRequired && !provider.capabilities?.reference_images) {
    throw new PaperStudioError(
      'PAPER_STUDIO_COMPOSITION_REFERENCE_UNSUPPORTED',
      '当前图片模型不支持构图参考，已阻止生成不一致的正式环境素材；请改用支持参考图的图片模型',
      {
        shot_id: Number(shot.id),
        slot_id: Number(slot.id),
        provider: provider.provider,
        model: provider.model,
      },
      409,
    );
  }
  if (styleReferenceRequired && !provider.capabilities?.reference_images) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STYLE_REFERENCE_UNSUPPORTED',
      '当前图片模型不支持参考图，无法保证第二场景与第一场景的时代、色调和纸片媒介一致；已在调用图片 API 前阻止生成',
      { shot_id: Number(shot.id), slot_id: Number(slot.id), scene_key: slot.constraints_json?.scene_key || null, provider: provider.provider, model: provider.model },
      409,
    );
  }
  const selectedReferenceRequired = Boolean(
    slot.asset_type === 'environment'
    && selectedStoryboardReference
    && compositionReferenceRequired
  );
  if (selectedReferenceRequired && referenceImages[0] !== selectedStoryboardReference) {
    throw new PaperStudioError(
      'PAPER_STUDIO_COMPOSITION_REFERENCE_NOT_ATTACHED',
      '正式环境素材未携带已选构图参考，已阻止生成；请重试当前素材，不会进入错误审核流程',
      {
        shot_id: Number(shot.id),
        slot_id: Number(slot.id),
        selected_reference: selectedStoryboardReference,
        reference_images: referenceImages,
      },
      409,
    );
  }
  if (styleReferenceRequired && referenceImages.length < 1) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STYLE_REFERENCE_NOT_ATTACHED',
      '第二场景环境素材未携带风格连续性参考，已在调用图片 API 前阻止生成',
      { shot_id: Number(shot.id), slot_id: Number(slot.id), scene_key: slot.constraints_json?.scene_key || null },
      409,
    );
  }
  const referencesProvenance = referenceEvidence(cfg, referenceImages);
  const requireAlpha = slot.asset_type !== 'environment';
  const capabilityKey = providerCapabilityKey(provider);
  const canRequestTransparent = requireAlpha
    && provider.capabilities?.transparent_background
    && !transparentUnsupportedProviders.has(capabilityKey);
  const backgroundStrategy = requireAlpha ? 'provider_alpha_then_local_matte' : 'opaque';
  const fingerprint = sha256(canonicalJson({ authorization_id: Number(authorization.id), shot_source: shot.source_revision_hash, slot: slot.slot_key, prompt, provider, reference_images: referenceImages, background_strategy: backgroundStrategy }));
  const reservation = db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, paper_asset_version_id, status
       FROM image_generations
       WHERE generation_kind = 'paper_studio_asset'
         AND paper_studio_run_id = ? AND paper_asset_slot_id = ?
         AND request_fingerprint = ? AND deleted_at IS NULL
         AND status IN ('processing','completed')
       ORDER BY id DESC LIMIT 1`,
    ).get(Number(run.id), Number(slot.id), fingerprint);
    if (existing) return { existing };
    const usedImages = usedImageCount(db, run.id);
    if (usedImages >= maxImages) {
      throw new PaperStudioError('PAPER_STUDIO_IMAGE_BUDGET_EXHAUSTED', '当前生产版本的图片预算已用完', { run_id: Number(run.id), shot_id: Number(shot.id), used_images: usedImages, max_images: maxImages }, 409);
    }
    const versionId = insertVersion(db, slot, 'image_api', { provider_config_id: provider.config_id, request_fingerprint: fingerprint, prompt, reference_images: referenceImages, authorization_id: Number(authorization.id) });
    const imageGenerationId = createImageGeneration(db, run, shot, slot, provider, prompt, fingerprint, referenceImages, { version_id: versionId, authorization_id: authorization.id });
    db.prepare('UPDATE paper_asset_versions SET image_generation_id = ? WHERE id = ?').run(imageGenerationId, versionId);
    db.prepare("UPDATE paper_asset_slots SET status = 'generating', version = version + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), Number(slot.id));
    return { imageGenerationId, versionId };
  })();
  if (reservation.existing) {
    const existingVersion = reservation.existing.paper_asset_version_id == null ? null : db.prepare(
      "SELECT id FROM paper_asset_versions WHERE id = ? AND slot_id = ? AND status = 'accepted'",
    ).get(Number(reservation.existing.paper_asset_version_id), Number(slot.id));
    if (reservation.existing.status === 'completed' && existingVersion) return Number(existingVersion.id);
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_ALREADY_PROCESSING',
      '当前素材槽位已有相同图片生成请求正在处理',
      { image_generation_id: Number(reservation.existing.id), slot_id: Number(slot.id) },
      409,
    );
  }
  const { imageGenerationId, versionId } = reservation;
  const previousVersionId = slot.current_version_id == null ? null : Number(slot.current_version_id);
  try {
    const apiOptions = {
      prompt,
      model: provider.model || undefined,
      preferred_provider: provider.provider || undefined,
      size: '1536x1024',
      quality: 'high',
      drama_id: Number(shot.drama_id),
      imageServiceType: 'image',
      image_gen_id: imageGenerationId,
      files_base_url: cfg?.storage?.base_url,
      storage_local_path: storageRoot(cfg),
      reference_image_urls: referenceImages,
      system_prompt: referenceImages.map((_, index) => slot.asset_type === 'environment'
        ? (pathBase
          ? `Image ${index + 1}${index === 0 ? ' is the selected flat-diagram composition and the primary visual authority' : ''}: preserve its complete fixed geometry, landmarks, boundaries, paper framing, palette and camera. Remove all path lines, arrows, changing markers, people, title cards and readable text so they can be animated independently.`
          : slot.constraints_json?.reference_role === 'style_only'
          ? `Image ${index + 1}: STYLE CONTINUITY reference only. Preserve era, weather family, lighting direction, palette, paper texture and rendering medium. Do not copy its place, architecture, subject layout, camera composition or perspective; build the different scene required by environment_description.`
          : environmentOnly
          ? `Image ${index + 1}${index === 0 ? ' is the selected storyboard reference and the primary visual authority' : ''}: preserve its composition, era, location, weather, damage, palette, paper medium and visible environmental storytelling. Do not replace it with a generic landscape.`
          : `Image ${index + 1}${index === 0 ? ' is the selected storyboard reference and the primary visual authority' : ''}: preserve geography, perspective, era, weather, environmental damage, lighting and style. Remove only characters or hero props explicitly separated into independent animation layers.`)
        : `Image ${index + 1}: identity, historical form, silhouette or same-family pose reference only. Treat its background, lighting and rendering medium as obsolete. Do not copy photography, photorealistic surface rendering or CGI from the reference; redraw the subject from scratch in the mandatory PROJECT VISUAL STYLE and PAPER-ANIMATION MEDIUM.`).join('\n'),
      user_negative_prompt: slot.asset_type === 'environment'
        ? (pathBase
          ? 'path arrow, arrowhead, route line, moving marker, subject marker, person, silhouette, title card, label, readable text, changed fixed geometry, changed landmark position, changed composition, photorealism, smooth CGI, split panel, collage'
          : slot.constraints_json?.reference_role === 'style_only'
          ? 'copied reference location, copied reference composition, wrong scene, hybrid indoor-outdoor location, independent foreground character, independent hero prop, subject-shaped hole, changed era, changed weather family, text, logo, split panel, collage'
          : environmentOnly
          ? 'reference drift, changed composition, changed era, changed location, changed weather, changed damage state, sunny generic landscape, clean peaceful beach, modern scenery, cheerful palette, photorealism, smooth CGI, text, logo, split panel, collage'
          : 'independent foreground character, independent hero prop, subject-shaped hole, changed composition, changed era, changed weather, text, logo, split panel, collage')
        : transportUnit
          ? 'unmanned vehicle, self-moving cart, missing pusher, missing puller, missing draft animal, detached hands, broken harness, floating wheel, background, scenery, floor, cast shadow, text, logo, split panel, collage, duplicate limbs, cropped vehicle, cropped operator'
          : 'background, scenery, floor, cast shadow, text, logo, split panel, collage, duplicate limbs, cropped body',
    };
    let requestedBackground = canRequestTransparent ? 'transparent' : 'opaque';
    let providerTransparencyRejected = false;
    let result;
    const callProvider = async (options) => {
      let lastError;
      while (Number(db.prepare('SELECT provider_call_count FROM image_generations WHERE id = ?').get(imageGenerationId)?.provider_call_count || 0) < Number(authorization.max_attempts || 1)) {
        const callIndex = reserveProviderCall(db, imageGenerationId, authorization.max_attempts);
        try {
          const response = await imageClient.callImageApi(db, log, options);
          if (response?.error && isTransientProviderFailure(response.error)) throw new Error(response.error);
          return response;
        } catch (error) {
          lastError = error;
          if (!isTransientProviderFailure(error)) throw error;
          if (log) log.warn('Paper studio transient image provider failure; retrying authorized slot call', {
            image_generation_id: imageGenerationId,
            slot_id: Number(slot.id),
            call_index: callIndex,
            max_attempts: Number(authorization.max_attempts || 1),
            error: error.message,
          });
        }
      }
      throw lastError || new PaperStudioError('PAPER_STUDIO_GENERATION_AUTHORIZED_CALLS_EXHAUSTED', '当前素材槽位已用完授权的图片模型调用次数', { slot_id: Number(slot.id) }, 409);
    };
    const retryWithOpaqueMatte = async () => {
      transparentUnsupportedProviders.add(capabilityKey);
      providerTransparencyRejected = true;
      requestedBackground = 'opaque';
      if (log) log.warn('Paper studio provider rejected transparent output; retrying with local matte fallback', {
        provider_config_id: provider.config_id,
        model: provider.model,
        shot_id: Number(shot.id),
        slot_key: slot.slot_key,
      });
      return callProvider({ ...apiOptions, background: requestedBackground });
    };
    try {
      result = await callProvider({ ...apiOptions, background: requestedBackground });
    } catch (error) {
      if (requestedBackground !== 'transparent' || !isTransparentBackgroundUnsupported(error)) throw error;
      result = await retryWithOpaqueMatte();
    }
    if (requestedBackground === 'transparent' && result?.error && isTransparentBackgroundUnsupported(result.error)) {
      result = await retryWithOpaqueMatte();
    }
    if (result?.error || !result?.image_url) throw new Error(result?.error || '图片 API 未返回图片');
    const projectDir = storageLayout.getProjectStorageSubdir(db, shot.drama_id);
    const downloaded = await uploadService.downloadImageToLocal(storageRoot(cfg), result.image_url, 'paper-studio', log, `paper_v${versionId}`, projectDir);
    if (!downloaded) throw new Error('图片 API 结果下载到本地失败');
    const downloadedPath = safeStorageFile(cfg, downloaded);
    const target = ensureVersionPath(db, cfg, shot, versionId, slot.slot_key);
    const report = await alphaReport(downloadedPath, target.absolute, { requireAlpha });
    if (!report.pass) throw new PaperStudioError('PAPER_STUDIO_ASSET_GATE_FAILED', '图片 API 结果未通过 Alpha 素材门禁', { slot_id: slot.id, report }, 422);
    require('./paperGenerationAuthorizationService').assertUsable(db, authorizationId, {
      runId: run.id,
      shotId: shot.id,
    });
    const sourceHash = hashFile(downloadedPath);
    const alphaHash = requireAlpha ? hashFile(target.absolute) : null;
    db.prepare(
      `UPDATE paper_asset_versions SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
         processing_json = ?, provenance_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ? WHERE id = ?`,
    ).run(
      downloaded,
      requireAlpha ? target.relative : null,
      sourceHash,
      alphaHash,
      JSON.stringify({
        matte_method: report.matte_method,
        requested_background: requestedBackground,
        local_matte_fallback: requireAlpha && requestedBackground === 'opaque',
        provider_transparency_rejected: providerTransparencyRejected,
      }),
      JSON.stringify({
        provider,
        prompt,
        request_fingerprint: fingerprint,
        reference_images: referenceImages,
        reference_evidence: referencesProvenance,
        selected_storyboard_reference: selectedStoryboardReference,
        background_strategy: backgroundStrategy,
        requested_background: requestedBackground,
      }),
      JSON.stringify({
        ...report,
        reference_count: referenceImages.length,
        reference_required: selectedReferenceRequired,
        reference_gate_passed: !selectedReferenceRequired || referenceImages.length > 0,
        reference_hashes: referencesProvenance.map((item) => item.content_hash || item.locator_hash).filter(Boolean),
      }),
      nowIso(),
      versionId,
    );
    db.prepare("UPDATE image_generations SET image_url = ?, local_path = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(result.image_url, downloaded, nowIso(), nowIso(), imageGenerationId);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?").run(versionId, nowIso(), Number(slot.id));
    return versionId;
  } catch (error) {
    const normalized = /(?:429|usage_limit_reached|usage limit)/i.test(error.message || '')
      ? new PaperStudioError('PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED', '图片 API 当前额度已用尽；已保留完成素材，额度恢复后只需重试失败槽位', { provider: provider.provider, model: provider.model, original_error: error.message }, 429)
      : error;
    db.prepare("UPDATE paper_asset_versions SET status = 'rejected', rejected_at = ?, quality_report_json = ? WHERE id = ?").run(nowIso(), JSON.stringify({ pass: false, error: normalized.message, code: normalized.code || null }), versionId);
    db.prepare("UPDATE image_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(normalized.message, nowIso(), imageGenerationId);
    const previousAccepted = previousVersionId == null ? null : db.prepare(
      "SELECT id FROM paper_asset_versions WHERE id = ? AND slot_id = ? AND status = 'accepted'",
    ).get(previousVersionId, Number(slot.id));
    db.prepare("UPDATE paper_asset_slots SET status = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(previousAccepted ? 'ready' : 'failed', nowIso(), Number(slot.id));
    throw normalized;
  }
}

async function deriveOccluder(db, cfg, shot, slot) {
  const family = db.prepare('SELECT * FROM paper_source_families WHERE id = ?').get(Number(slot.family_id));
  const constraints = slot.constraints_json || {};
  const sourceSlotKey = constraints.source_slot || null;
  const sourceSlot = sourceSlotKey ? db.prepare('SELECT * FROM paper_asset_slots WHERE family_id = ? AND slot_key = ?').get(Number(family.id), sourceSlotKey) : null;
  const sourceVersion = sourceSlot?.current_version_id ? db.prepare('SELECT * FROM paper_asset_versions WHERE id = ? AND status = ?').get(Number(sourceSlot.current_version_id), 'accepted') : null;
  if (!sourceVersion?.alpha_local_path) throw new PaperStudioError('PAPER_STUDIO_ASSET_DEPENDENCY_MISSING', '前景遮挡派生层缺少已接受的源 Alpha', { slot_id: slot.id, source_slot: sourceSlotKey }, 409);
  const versionId = insertVersion(db, slot, 'derived_occluder', { source_asset_version_id: Number(sourceVersion.id), source_slot: sourceSlotKey });
  const target = ensureVersionPath(db, cfg, shot, versionId, slot.slot_key);
  const inputPath = safeStorageFile(cfg, sourceVersion.alpha_local_path);
  const input = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(input.data);
  const band = Array.isArray(constraints.band) && constraints.band.length === 2 ? constraints.band : [0.45, 0.72];
  const minY = Math.round(input.info.height * Math.max(0, Math.min(1, Number(band[0]))));
  const maxY = Math.round(input.info.height * Math.max(0, Math.min(1, Number(band[1]))));
  for (let y = 0; y < input.info.height; y += 1) {
    if (y >= minY && y <= maxY) continue;
    for (let x = 0; x < input.info.width; x += 1) data[(y * input.info.width + x) * 4 + 3] = 0;
  }
  await sharp(data, { raw: input.info }).png().toFile(target.absolute);
  const hash = hashFile(target.absolute);
  const report = { pass: true, width: input.info.width, height: input.info.height, semantic_part: constraints.semantic_part || slot.slot_key, source_asset_version_id: Number(sourceVersion.id), band };
  db.prepare(
    `UPDATE paper_asset_versions SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
       processing_json = ?, provenance_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ? WHERE id = ?`,
  ).run(target.relative, target.relative, hash, hash, JSON.stringify({ derivation: 'registered_alpha_band' }), JSON.stringify({ source_asset_version_id: Number(sourceVersion.id), source_slot: sourceSlotKey }), JSON.stringify(report), nowIso(), versionId);
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?").run(versionId, nowIso(), Number(slot.id));
  return versionId;
}

async function produceSlot(db, cfg, log, run, shot, slot, force, authorizationId) {
  if (!force && slot.current_version_id) {
    const accepted = db.prepare("SELECT id FROM paper_asset_versions WHERE id = ? AND status = 'accepted'").get(Number(slot.current_version_id));
    if (accepted) return { slot_id: Number(slot.id), version_id: Number(accepted.id), reused: true };
  }
  let versionId;
  // An explicit slot regeneration is the opt-in path for creating a new clean
  // plate from the frozen reference. Normal production reuses the approved
  // source verbatim and therefore makes no image API call.
  const source = force ? null : sourceForSlot(db, shot, slot);
  if (slot.asset_type === 'occlusion-mask') versionId = await deriveMask(db, cfg, shot, slot);
  else if (slot.constraints_json?.derivation === 'registered_alpha_band') versionId = await deriveOccluder(db, cfg, shot, slot);
  else if (source) versionId = await importSource(db, cfg, shot, slot, source);
  else if (isProceduralStateFallback(slot)) versionId = deriveProceduralStateFallback(db, slot).versionId;
  else if (slot.required_for_gate || slot.constraints_json?.fallback !== 'procedural') versionId = await generateViaApi(db, cfg, log, run, shot, slot, authorizationId);
  else return { slot_id: Number(slot.id), version_id: null, skipped_optional: true };
  return { slot_id: Number(slot.id), version_id: Number(versionId), reused: false };
}

async function generateMissingSlots(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '生成纸片素材的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!isCurrentPlannerVersion(shot.plan_summary_json)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PLAN_VERSION_STALE',
      '生产计划版本已经更新，已阻止旧计划继续生成素材',
      {
        shot_id: Number(shot.id),
        expected_planner_version: CURRENT_PLANNER_VERSION,
        actual_planner_version: Number(shot.plan_summary_json?.planner_version || 0),
      },
      409,
    );
  }
  if (!['plan_confirmed', 'asset_failed', 'asset_review'].includes(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头状态不允许生成素材', { shot_id: shot.id, status: shot.status }, 409);
  }
  const run = runService.get(db, shot.run_id);
  if (!body.authorization_id) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_AUTHORIZATION_REQUIRED',
      '生成正式素材前必须先查看费用并明确授权图片 API',
      { run_id: run.id, shot_id: shot.id },
      409,
    );
  }
  const authorization = require('./paperGenerationAuthorizationService').assertUsable(db, body.authorization_id, {
    runId: run.id,
    shotId: shot.id,
  });
  const authorizedSlots = new Map(
    authorization.slot_scope_json
      .filter((item) => Number(item.shot_id) === Number(shot.id))
      .map((item) => [Number(item.slot_id), item]),
  );
  const continuitySources = continuityService.assertIncomingSourcesReady(db, shot.id);
  if (!continuitySources.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_CONTINUITY_SOURCE_NOT_READY',
      '前序镜头的连续性素材尚未完成；请先生成前序镜头，避免当前镜头身份漂移',
      { shot_id: Number(shot.id), ...continuitySources },
      409,
    );
  }
  const now = nowIso();
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending', version = version + 1, last_error_json = '{}', updated_at = ? WHERE id = ?").run(now, Number(shot.id));
  db.prepare("UPDATE paper_studio_runs SET status = 'assets_generating', progress = 18, updated_at = ? WHERE id = ?").run(now, Number(run.id));
  const slots = shot.families.flatMap((family) => family.slots).sort((a, b) => {
    const rank = (slot) => {
      if (slot.slot_key === 'clean_plate') return 0;
      if (slot.asset_type === 'occlusion-mask') return 5;
      if (slot.constraints_json?.derivation === 'registered_alpha_band') return 90;
      if (slot.asset_type.includes('prop')) return 15;
      if (slot.asset_type.includes('character') || slot.asset_type.includes('subject')) return 30;
      return 60;
    };
    return rank(a) - rank(b) || Number(a.id) - Number(b.id);
  });
  const results = [];
  const continuityRetryKeys = new Set(continuityService.failedTargetSubjectKeys(db, shot.id));
  try {
    for (const slot of slots) {
      const retryForContinuity = continuityRetryKeys.has(slot.constraints_json?.subject_key);
      const authorized = authorizedSlots.get(Number(slot.id));
      const localOnly = slot.asset_type === 'occlusion-mask'
        || slot.constraints_json?.derivation === 'registered_alpha_band'
        || isProceduralStateFallback(slot)
        || Boolean(sourceForSlot(db, shot, slot));
      if (!localOnly && !authorized) {
        const currentAccepted = slot.current_version_id == null ? null : db.prepare(
          "SELECT id FROM paper_asset_versions WHERE id = ? AND slot_id = ? AND status = 'accepted'",
        ).get(Number(slot.current_version_id), Number(slot.id));
        results.push({
          slot_id: Number(slot.id),
          version_id: currentAccepted ? Number(currentAccepted.id) : null,
          reused: Boolean(currentAccepted),
          skipped_outside_authorization: !currentAccepted,
        });
        continue;
      }
      const force = Boolean(body.force) || Boolean(authorized?.force_regeneration) || (retryForContinuity && Boolean(authorized));
      results.push(await produceSlot(db, cfg, log, run, shot, slot, force, body.authorization_id));
    }
    db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending', attention_required = 'none', version = version + 1, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.id));
    runAggregateService.sync(db, run.id);
    return { shot: shotService.get(db, shot.id), generated: results };
  } catch (error) {
    const liveRun = db.prepare('SELECT status FROM paper_studio_runs WHERE id = ?').get(Number(run.id));
    const liveShot = db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(Number(shot.id));
    if (liveRun?.status === 'cancelled' || liveShot?.status === 'cancelled') throw error;
    const failure = { code: error.code || 'PAPER_STUDIO_ASSET_GENERATION_FAILED', message: error.message, at: nowIso() };
    const requiredMissing = Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_asset_slots pas
       JOIN paper_source_families psf ON psf.id = pas.family_id
       WHERE psf.shot_id = ?
         AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
         AND pas.required_for_gate = 1
         AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
         AND (pas.current_version_id IS NULL OR pas.status != 'ready')`,
    ).get(Number(shot.id), Number(shot.id))?.count || 0);
    const recoverableWithCurrent = requiredMissing === 0;
    db.prepare("UPDATE paper_studio_shots SET status = ?, attention_required = ?, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(recoverableWithCurrent ? 'asset_review' : 'asset_failed', recoverableWithCurrent ? 'review_assets' : 'authorize_generation', JSON.stringify(failure), nowIso(), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = ?, attention_required = ?, last_error_json = ?, updated_at = ? WHERE id = ?")
      .run(recoverableWithCurrent ? 'assets_processing' : 'partial', recoverableWithCurrent ? 'review_assets' : 'authorize_generation', JSON.stringify(failure), nowIso(), Number(run.id));
    runAggregateService.sync(db, run.id);
    throw error;
  }
}

function currentAssetVersionRows(db, shotId) {
  return db.prepare(
    `SELECT pav.*, pas.id AS slot_id, pas.slot_key, pas.asset_type, pas.required_for_gate,
            pas.constraints_json, psf.id AS family_id
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ?
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shotId), Number(shotId)).map((row) => ({
    ...row,
    slot_id: Number(row.slot_id),
    family_id: Number(row.family_id),
    required_for_gate: Boolean(row.required_for_gate),
    constraints_json: parseJson(row.constraints_json, {}),
  }));
}

function assertLocalAssetStage(db, shotId, body, label) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, `${label}的参数无效`);
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['asset_pending', 'asset_failed', 'asset_review'].includes(shot.status)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_SHOT_STATE_CONFLICT',
      `当前镜头状态不允许${label}`,
      { shot_id: Number(shot.id), status: shot.status },
      409,
    );
  }
  return shot;
}

async function mattePendingVersions(db, cfg, log, shotId, body = {}) {
  const shot = assertLocalAssetStage(db, shotId, body, '处理素材透明通道');
  const rows = currentAssetVersionRows(db, shot.id);
  const processed = [];
  const skipped = [];
  for (const row of rows) {
    const quality = parseJson(row.quality_report_json, {});
    const requireAlpha = row.asset_type !== 'environment';
    const outputRel = requireAlpha ? row.alpha_local_path : row.source_local_path;
    const outputExists = outputRel && fs.existsSync(safeStorageFile(cfg, outputRel));
    if (row.status === 'accepted' && quality.pass === true && quality.matte_method && outputExists) {
      skipped.push(Number(row.id));
      continue;
    }
    const generation = row.image_generation_id == null ? null : db.prepare(
      'SELECT local_path FROM image_generations WHERE id = ? AND deleted_at IS NULL',
    ).get(Number(row.image_generation_id));
    const provenance = parseJson(row.provenance_json, {});
    const sourceRel = provenance.raw_source_local_path || generation?.local_path || row.source_local_path;
    if (!sourceRel) {
      throw new PaperStudioError(
        'PAPER_STUDIO_ASSET_SOURCE_MISSING',
        '素材透明通道处理缺少原始图片',
        { asset_version_id: Number(row.id), slot_id: Number(row.slot_id) },
        422,
      );
    }
    const sourceAbsolute = safeStorageFile(cfg, sourceRel);
    if (!fs.existsSync(sourceAbsolute)) {
      throw new PaperStudioError(
        'PAPER_STUDIO_ASSET_SOURCE_MISSING',
        '素材透明通道处理所需的原始图片不存在',
        { asset_version_id: Number(row.id), local_path: sourceRel },
        422,
      );
    }
    const target = ensureVersionPath(db, cfg, shot, Number(row.id), row.slot_key);
    const sameFile = path.resolve(sourceAbsolute) === path.resolve(target.absolute);
    const outputAbsolute = sameFile ? `${target.absolute}.matte-${process.pid}-${Date.now()}.png` : target.absolute;
    let report;
    try {
      report = await alphaReport(sourceAbsolute, outputAbsolute, { requireAlpha });
      if (!report.pass) {
        throw new PaperStudioError(
          'PAPER_STUDIO_ASSET_GATE_FAILED',
          '素材未通过透明通道技术门禁',
          { asset_version_id: Number(row.id), slot_id: Number(row.slot_id), report },
          422,
        );
      }
      if (sameFile) fs.renameSync(outputAbsolute, target.absolute);
    } catch (error) {
      if (sameFile && fs.existsSync(outputAbsolute)) fs.unlinkSync(outputAbsolute);
      throw error;
    }
    const sourceHash = hashFile(sourceAbsolute);
    const outputHash = hashFile(target.absolute);
    db.prepare(
      `UPDATE paper_asset_versions
       SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
           processing_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = COALESCE(accepted_at, ?)
       WHERE id = ?`,
    ).run(
      sourceRel,
      requireAlpha ? target.relative : null,
      sourceHash,
      requireAlpha ? outputHash : null,
      JSON.stringify({ ...parseJson(row.processing_json, {}), matte_method: report.matte_method }),
      JSON.stringify(report),
      nowIso(),
      Number(row.id),
    );
    db.prepare("UPDATE paper_asset_slots SET status = 'ready', version = version + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), Number(row.slot_id));
    processed.push(Number(row.id));
  }
  const now = nowIso();
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending', version = version + 1, updated_at = ? WHERE id = ?")
    .run(now, Number(shot.id));
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio asset matte stage completed', { shot_id: Number(shot.id), processed, skipped });
  return { shot: shotService.get(db, shot.id), processed_asset_version_ids: processed, skipped_asset_version_ids: skipped };
}

async function registerVersions(db, cfg, log, shotId, body = {}) {
  const shot = assertLocalAssetStage(db, shotId, body, '注册素材接触点');
  const spatialContractService = require('./paperSpatialContractService');
  const rows = currentAssetVersionRows(db, shot.id);
  const registered = [];
  for (const row of rows) {
    if (row.status !== 'accepted') continue;
    const registration = spatialContractService.rawRegistration(row);
    if (!registration) continue;
    db.prepare('UPDATE paper_asset_versions SET registration_json = ? WHERE id = ?')
      .run(JSON.stringify(registration), Number(row.id));
    registered.push(Number(row.id));
  }
  const now = nowIso();
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending', version = version + 1, updated_at = ? WHERE id = ?")
    .run(now, Number(shot.id));
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio asset registration stage completed', { shot_id: Number(shot.id), registered });
  return { shot: shotService.get(db, shot.id), registered_asset_version_ids: registered };
}

async function runTechnicalAssetGate(db, cfg, log, shotId, body = {}) {
  const shot = assertLocalAssetStage(db, shotId, body, '执行素材技术门禁');
  const rows = currentAssetVersionRows(db, shot.id);
  const missing = db.prepare(
    `SELECT pas.id, pas.slot_key
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     LEFT JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ?
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND pas.required_for_gate = 1
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
       AND (pav.id IS NULL OR pav.status != 'accepted')`,
  ).all(Number(shot.id), Number(shot.id));
  const invalid = rows.filter((row) => {
    const quality = parseJson(row.quality_report_json, {});
    return row.required_for_gate && quality.pass !== true;
  });
  if (missing.length || invalid.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_GATE_FAILED',
      '部分必需素材尚未通过透明通道或尺寸技术门禁',
      {
        shot_id: Number(shot.id),
        missing_slot_ids: missing.map((row) => Number(row.id)),
        invalid_asset_version_ids: invalid.map((row) => Number(row.id)),
      },
      422,
    );
  }
  const continuity = continuityService.evaluateForShot(db, shot.id);
  if (!continuity.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_CONTINUITY_GATE_FAILED',
      '跨镜头身份连续性未通过；失败角色槽位将在重试时按前序素材重新生成',
      { shot_id: Number(shot.id), ...continuity },
      422,
    );
  }
  const now = nowIso();
  for (const family of shot.families) {
    const familyMissing = db.prepare(
      "SELECT COUNT(*) AS count FROM paper_asset_slots WHERE family_id = ? AND required_for_gate = 1 AND (current_version_id IS NULL OR status != 'ready') AND deleted_at IS NULL",
    ).get(Number(family.id));
    db.prepare("UPDATE paper_source_families SET status = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(Number(familyMissing.count) ? 'failed' : 'review', now, Number(family.id));
  }
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_review', attention_required = 'review_assets', last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?")
    .run(now, Number(shot.id));
  db.prepare("UPDATE paper_studio_runs SET status = 'assets_processing', progress = 38, attention_required = 'review_assets', updated_at = ? WHERE id = ?")
    .run(now, Number(shot.run_id));
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio technical asset gate passed', { shot_id: Number(shot.id), asset_version_ids: rows.map((row) => Number(row.id)) });
  return { shot: shotService.get(db, shot.id), continuity, manual_review_required: true };
}

async function generateAssets(db, cfg, log, shotId, body = {}) {
  let generated;
  try {
    generated = await generateMissingSlots(db, cfg, log, shotId, body);
    let shot = shotService.get(db, shotId);
    const matte = await mattePendingVersions(db, cfg, log, shotId, {
      request_id: body.request_id,
      expected_version: shot.version,
    });
    shot = shotService.get(db, shotId);
    const registration = await registerVersions(db, cfg, log, shotId, {
      request_id: body.request_id,
      expected_version: shot.version,
    });
    shot = shotService.get(db, shotId);
    const gate = await runTechnicalAssetGate(db, cfg, log, shotId, {
      request_id: body.request_id,
      expected_version: shot.version,
    });
    const now = nowIso();
    const result = {
      asset_versions: generated.generated.map((item) => item.version_id).filter(Boolean),
      manual_review_required: true,
    };
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ? AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets','technical_asset_gate')")
      .run(JSON.stringify(result), now, now, Number(gate.shot.run_id), Number(gate.shot.id), Number(gate.shot.current_plan_revision_id));
    require('./paperGenerationAuthorizationService').markConsumedIfFinished(db, body.authorization_id);
    return { shot: gate.shot, generated: generated.generated, matte, registration, continuity: gate.continuity };
  } catch (error) {
    const row = db.prepare('SELECT run_id FROM paper_studio_shots WHERE id = ?').get(Number(shotId));
    if (row) {
      const failure = { code: error.code || 'PAPER_STUDIO_ASSET_GENERATION_FAILED', message: error.message, at: nowIso() };
      db.prepare("UPDATE paper_job_steps SET status = 'failed_retryable', error_json = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?) AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets','technical_asset_gate') AND status != 'completed'")
        .run(JSON.stringify(failure), nowIso(), Number(row.run_id), Number(shotId), Number(shotId));
    }
    if (body.authorization_id) require('./paperGenerationAuthorizationService').markConsumedIfFinished(db, body.authorization_id);
    throw error;
  }
}

async function materializeZeroCallSlots(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['plan_confirmed', 'asset_failed', 'asset_review'].includes(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头状态不允许应用零调用素材', { shot_id: Number(shot.id), status: shot.status }, 409);
  }
  const run = runService.get(db, shot.run_id);
  const slots = shot.families.flatMap((family) => family.slots);
  const missingPaid = slots.filter((slot) => {
    if (slot.current_version?.status === 'accepted') return false;
    return !(slot.asset_type === 'occlusion-mask'
      || slot.constraints_json?.derivation === 'registered_alpha_band'
      || isProceduralStateFallback(slot)
      || Boolean(sourceForSlot(db, shot, slot)));
  });
  if (missingPaid.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ZERO_CALL_SCOPE_INCOMPLETE',
      '仍有素材需要图片 API，零调用应用已停止；请查看差异报价',
      { slot_ids: missingPaid.map((slot) => Number(slot.id)) },
      409,
    );
  }
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending', attention_required = 'none', version = version + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), Number(shot.id));
  const produced = [];
  for (const slot of slots) {
    if (slot.current_version?.status === 'accepted') {
      produced.push({ slot_id: Number(slot.id), version_id: Number(slot.current_version.id), reused: true });
    } else {
      produced.push(await produceSlot(db, cfg, log, run, shot, slot, false, null));
    }
  }
  let current = shotService.get(db, shot.id);
  const matte = await mattePendingVersions(db, cfg, log, shot.id, { request_id: body.request_id, expected_version: current.version });
  current = shotService.get(db, shot.id);
  const registration = await registerVersions(db, cfg, log, shot.id, { request_id: body.request_id, expected_version: current.version });
  current = shotService.get(db, shot.id);
  const gate = await runTechnicalAssetGate(db, cfg, log, shot.id, { request_id: body.request_id, expected_version: current.version });
  const now = nowIso();
  db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ? AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets','technical_asset_gate')")
    .run(JSON.stringify({ zero_call: true, asset_versions: produced.map((item) => item.version_id).filter(Boolean) }), now, now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id));
  if (log) log.info('Paper studio zero-call slots materialized', { shot_id: Number(shot.id), slot_count: produced.length });
  return { shot: gate.shot, produced, matte, registration, continuity: gate.continuity };
}

async function rematteAssets(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiAssetRematte', body, '重新抠图参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  const allowedStates = new Set([
    'asset_review', 'asset_failed', 'asset_ready', 'motion_failed', 'motion_ready',
    'proof_failed', 'proof_ready', 'preview_ready',
  ]);
  if (!allowedStates.has(shot.status)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REMATTE_STATE_CONFLICT',
      '当前镜头状态不允许重新抠图',
      { shot_id: Number(shot.id), status: shot.status },
      409,
    );
  }

  const currentRows = db.prepare(
    `SELECT pas.*, psf.shot_id, pav.image_generation_id, pav.derivation_kind,
            pav.source_local_path, pav.alpha_local_path, pav.status AS version_status,
            ig.local_path AS raw_local_path
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     LEFT JOIN image_generations ig ON ig.id = pav.image_generation_id
     WHERE psf.shot_id = ?
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL`,
  ).all(Number(shot.id), Number(shot.id)).map((row) => ({ ...row, constraints_json: parseJson(row.constraints_json, {}) }));
  const wanted = new Set(body.asset_version_ids.map(Number));
  const selected = currentRows.filter((row) => wanted.has(Number(row.current_version_id)));
  if (selected.length !== wanted.size) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_VERSION_NOT_CURRENT',
      '只能重新处理当前镜头正在使用的素材版本',
      { shot_id: Number(shot.id), asset_version_ids: [...wanted] },
      409,
    );
  }
  const invalid = selected.filter((row) => row.asset_type === 'environment'
    || row.asset_type === 'occlusion-mask'
    || !row.alpha_local_path
    || row.version_status !== 'accepted');
  if (invalid.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_ASSET_REMATTE_UNSUPPORTED',
      '所选版本不是可重新抠图的独立透明层',
      { asset_version_ids: invalid.map((row) => Number(row.current_version_id)) },
      422,
    );
  }

  const prepared = [];
  try {
    for (const row of selected) {
      const sourceRel = row.raw_local_path || row.source_local_path;
      const sourceAbsolute = safeStorageFile(cfg, sourceRel);
      if (!fs.existsSync(sourceAbsolute)) {
        throw new PaperStudioError(
          'PAPER_STUDIO_ASSET_SOURCE_MISSING',
          '重新抠图所需的原始图片不存在',
          { asset_version_id: Number(row.current_version_id), local_path: sourceRel },
          422,
        );
      }
      const versionId = insertVersion(db, row, 'matte_refinement', {
        parent_version_id: Number(row.current_version_id),
        raw_source_local_path: sourceRel,
        algorithm_version: 'edge-defringe-v2',
        request_id: body.request_id,
      });
      db.prepare('UPDATE paper_asset_versions SET parent_version_id = ? WHERE id = ?')
        .run(Number(row.current_version_id), versionId);
      const target = ensureVersionPath(db, cfg, shot, versionId, row.slot_key);
      prepared.push({ row, versionId, target, sourceRel, sourceAbsolute });
      const report = await alphaReport(sourceAbsolute, target.absolute, { requireAlpha: true });
      if (!report.pass) {
        throw new PaperStudioError(
          'PAPER_STUDIO_ASSET_GATE_FAILED',
          '重新抠图结果仍有残留底色或 Alpha 不合格',
          { asset_version_id: Number(row.current_version_id), report },
          422,
        );
      }
      prepared[prepared.length - 1].report = report;
      prepared[prepared.length - 1].sourceHash = hashFile(sourceAbsolute);
      prepared[prepared.length - 1].alphaHash = hashFile(target.absolute);
    }
  } catch (error) {
    const failedAt = nowIso();
    for (const item of prepared) {
      db.prepare("UPDATE paper_asset_versions SET status = 'rejected', rejected_at = ?, quality_report_json = ? WHERE id = ?")
        .run(failedAt, JSON.stringify({ pass: false, code: error.code || null, error: error.message }), Number(item.versionId));
    }
    throw error;
  }

  const now = nowIso();
  const apply = db.transaction(() => {
    const updateVersion = db.prepare(
      `UPDATE paper_asset_versions
       SET source_local_path = ?, alpha_local_path = ?, source_hash = ?, alpha_hash = ?,
           processing_json = ?, provenance_json = ?, quality_report_json = ?,
           status = 'accepted', accepted_at = ? WHERE id = ?`,
    );
    const updateSlot = db.prepare(
      "UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready', version = version + 1, updated_at = ? WHERE id = ?",
    );
    for (const item of prepared) {
      updateVersion.run(
        item.sourceRel,
        item.target.relative,
        item.sourceHash,
        item.alphaHash,
        JSON.stringify({
          matte_method: item.report.matte_method,
          defringe: item.report.defringe,
          rematte: true,
          algorithm_version: 'edge-defringe-v2',
        }),
        JSON.stringify({
          parent_version_id: Number(item.row.current_version_id),
          raw_source_local_path: item.sourceRel,
          request_id: body.request_id,
        }),
        JSON.stringify(item.report),
        now,
        Number(item.versionId),
      );
      updateSlot.run(Number(item.versionId), now, Number(item.row.id));
    }
    for (const familyId of new Set(prepared.map((item) => Number(item.row.family_id)))) {
      db.prepare("UPDATE paper_source_families SET status = 'review', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, familyId);
    }
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE shot_id = ? AND status IN ('compiled','approved')")
      .run(Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND status IN ('pending','running','passed','completed')")
      .run(Number(shot.id));
    db.prepare("UPDATE paper_motion_plans SET status = 'draft', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ? AND plan_revision_id = ?")
      .run(now, Number(shot.id), Number(shot.current_plan_revision_id));
    db.prepare(`UPDATE paper_studio_shots
      SET status = 'asset_review', current_snapshot_id = NULL, approved_snapshot_id = NULL,
          last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?`)
      .run(now, Number(shot.id));
    db.prepare(`UPDATE paper_job_steps
      SET status = 'queued', result_json = '{}', error_json = '{}', lease_owner = NULL,
          lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ? AND step_key IN
        ('asset_gate','plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview',
         'wait_preview_approval','render_formal','publish_video')`)
      .run(now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ? AND step_key IN ('matte_assets','register_assets')")
      .run(JSON.stringify({ rematted_asset_version_ids: prepared.map((item) => Number(item.versionId)), algorithm_version: 'edge-defringe-v2' }), now, now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id));
    db.prepare("UPDATE paper_studio_runs SET status = 'assets_processing', progress = 38, last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, Number(shot.run_id));
  });
  apply();

  const selectedSlotKeys = new Set(prepared.map((item) => item.row.slot_key));
  const derived = currentRows.filter((row) => row.constraints_json?.derivation === 'registered_alpha_band'
    && selectedSlotKeys.has(row.constraints_json?.source_slot));
  const derivedVersionIds = [];
  for (const row of derived) {
    derivedVersionIds.push(await deriveOccluder(db, cfg, shot, row));
  }
  runAggregateService.sync(db, shot.run_id);
  if (log) {
    log.info('Paper studio assets rematted', {
      shot_id: Number(shot.id),
      parent_asset_version_ids: [...wanted],
      asset_version_ids: prepared.map((item) => Number(item.versionId)),
      derived_asset_version_ids: derivedVersionIds,
    });
  }
  return {
    shot: shotService.get(db, shot.id),
    rematted: prepared.map((item) => ({
      parent_version_id: Number(item.row.current_version_id),
      asset_version_id: Number(item.versionId),
      slot_id: Number(item.row.id),
      report: item.report,
    })),
    derived_asset_version_ids: derivedVersionIds,
  };
}

module.exports = {
  storageRoot,
  safeStorageFile,
  alphaReport,
  sourceForSlot,
  usedImageCount,
  reserveProviderCall,
  referenceImagesForSlot,
  styleLockForSlot,
  propStateInstruction,
  isTransparentBackgroundUnsupported,
  promptForSlot,
  isProceduralStateFallback,
  ensureProceduralStateFallbacks,
  deriveOccluder,
  generateMissingSlots,
  mattePendingVersions,
  registerVersions,
  runTechnicalAssetGate,
  generateAssets,
  materializeZeroCallSlots,
  rematteAssets,
};
