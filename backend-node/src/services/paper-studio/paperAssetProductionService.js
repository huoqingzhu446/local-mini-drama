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
      (slot_id, source_family_id, attempt_index, derivation_kind, processing_json,
       registration_json, provenance_json, quality_report_json, status, created_at)
     VALUES (?, ?, ?, ?, '{}', '{}', ?, '{}', 'candidate', ?)`,
  ).run(Number(slot.id), Number(slot.family_id), Number(next.attempt), derivationKind, JSON.stringify(provenance), nowIso());
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
     WHERE psf.shot_id = ? AND psf.deleted_at IS NULL AND pas.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shotId)).map((slot) => ({
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

async function alphaReport(inputPath, outputPath, { requireAlpha = true } = {}) {
  const source = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(source.data);
  const key = requireAlpha ? paperMatte.estimateBorderKeyColor(data, source.info) : null;
  const pixels = source.info.width * source.info.height;
  let inputTransparent = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 245) inputTransparent += 1;
  }
  let matteMethod = inputTransparent / pixels > 0.015 ? 'provider_alpha' : 'border_matte_v2';
  if (requireAlpha && matteMethod === 'border_matte_v2') {
    for (let index = 0; index < data.length; index += 4) {
      data[index + 3] = paperMatte.alphaForPixel(data[index], data[index + 1], data[index + 2], data[index + 3], key, 24, 48);
    }
  }
  const defringe = requireAlpha
    ? paperMatte.defringeRgba(data, source.info, key, { apply_unmix: matteMethod === 'border_matte_v2' })
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
  const pass = !requireAlpha || (
    transparentRatio >= 0.05
    && visibleRatio >= 0.005
    && visibleRatio <= 0.92
    && (!defringe?.chroma_green || defringe.residual_key_edge_ratio <= 0.02)
  );
  return {
    pass,
    width: source.info.width,
    height: source.info.height,
    pixels,
    matte_method: matteMethod,
    key_color: key,
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
         WHERE psf.shot_id = ? AND pas.asset_type = 'environment'
           AND pas.id != ? AND pav.status = 'accepted'
         ORDER BY pav.id DESC LIMIT 1`,
      ).get(Number(shot.id), Number(slot.id));
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
  const sourceAbsolute = safeStorageFile(cfg, source.local_path);
  if (!fs.existsSync(sourceAbsolute)) throw new PaperStudioError('PAPER_STUDIO_SOURCE_ASSET_MISSING', '引用的正式素材文件不存在', { slot_id: slot.id, local_path: source.local_path }, 422);
  const requireAlpha = slot.asset_type !== 'environment';
  const report = await alphaReport(sourceAbsolute, target.absolute, { requireAlpha });
  if (!report.pass) throw new PaperStudioError('PAPER_STUDIO_ASSET_GATE_FAILED', '正式素材无法形成可用透明纸片', { slot_id: slot.id, report }, 422);
  const hash = hashFile(target.absolute);
  db.prepare(
    `UPDATE paper_asset_versions SET source_local_path = ?, alpha_local_path = ?, source_hash = ?,
       alpha_hash = ?, processing_json = ?, quality_report_json = ?, status = 'accepted', accepted_at = ?
     WHERE id = ?`,
  ).run(target.relative, requireAlpha ? target.relative : null, hash, requireAlpha ? hash : null, JSON.stringify({ derivation: 'immutable_copy', matte_method: report.matte_method }), JSON.stringify(report), nowIso(), versionId);
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
  if (slot.asset_type === 'environment') {
    const styleLock = styleLockForSlot(drama, 'scene');
    const environmentOnly = Boolean(summary.environment_only || storyboard?.environment_only);
    const mapBase = Boolean(summary.map_route || /map-route-reveal/.test(String(summary.catalog_key || '')));
    const selectedReference = sourceService.isPaperShot(shot) ? sourceService.referenceMedia(db, shot) : null;
    const sceneDescription = String(slot.constraints_json?.environment_description || semantic.environment?.description || '').trim();
    const compositionReference = slot.constraints_json?.use_storyboard_composition_reference !== false;
    const fixedSceneContext = [scene?.location, scene?.time].filter(Boolean);
    const place = (fixedSceneContext.length ? fixedSceneContext : [storyboard?.location, storyboard?.time].filter(Boolean))
      .join('，') || 'the fixed storyboard location and time';
    const cleanDescription = mapBase
      ? `Create the clean unannotated strategic-map base shown by the selected storyboard reference. Preserve its exact top-down geography, river course, bridges, mountains, plains, city positions, paper boundary, tabletop framing, palette and camera composition. Remove every route arrow, dot, encirclement ring, army symbol, commander silhouette, title card, label and readable character; all strategic information and people will be added later as independent layers.`
      : environmentOnly
        ? `Create the full environmental base frame at ${place}. Preserve the selected storyboard reference's visible environment storytelling, including its terrain, river or shoreline, fortifications, ruins, damaged structures, camps, fire and smoke, banners, vessels, distant silhouettes, debris, weather and atmospheric depth. These are part of this environment-only shot and must not be replaced by a generic empty landscape.`
        : `Create a clean environment plate for this exact visual scene: ${sceneDescription || place}. Preserve fixed terrain, shoreline, water, sky, permanent architecture, vegetation, damage to the location, weather, atmospheric depth, lighting and perspective. Remove only the characters or movable hero props that are explicitly planned as separate animation layers, then reconstruct the areas hidden behind them. Do not erase fixed story-world evidence such as ruined architecture or environmental damage.`;
    const storyContext = uniqueTextBlocks(environmentOnly || mapBase
      ? [storyboard?.description, storyboard?.action, storyboard?.atmosphere, storyboard?.visual_prompt, storyboard?.prompt]
      : [storyboard?.atmosphere, storyboard?.visual_prompt, storyboard?.prompt]).join('\n');
    return [
      mapBase
        ? 'Create the production clean strategic-map plate for layered paper animation, not a finished annotated map.'
        : environmentOnly
        ? 'Create the production environment plate for this paper-animation shot.'
        : 'Create a production clean plate for layered paper animation, not a finished storyboard frame.',
      cleanDescription,
      selectedReference && compositionReference
        ? 'SELECTED STORYBOARD REFERENCE — highest priority composition and style authority: Match its composition, camera angle, era, location, geography, weather, damage state, lighting, color palette, paper texture and rendering medium. If any project-wide style text conflicts with the selected reference, the selected reference overrides that conflict.'
        : selectedReference
        ? `SELECTED STORYBOARD REFERENCE — STYLE ONLY: preserve its era, weather family, lighting direction, color palette, paper texture and rendering medium, but do not copy its location or composition. The required location and composition are: ${sceneDescription || place}.`
        : 'Keep the supplied reference composition, camera angle, lighting, perspective and visual style.',
      mapBase
        ? 'Keep the full map canvas and all fixed geographic features, but reconstruct clean paper and terrain underneath every removed arrow, person, title card and label. No blank cutout holes or erased smudges may remain.'
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
    map_marker: 'one iconic full-body ink silhouette designed to appear as a commander marker on a strategic map, matching the selected storyboard reference',
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
  const subjectLine = propSubject
    ? `${primarySubject.identity || storyboard?.title || 'the required prop'}, isolated as one complete object`
    : `${primarySubject.identity || storyboard?.title || 'the primary storyboard subject'} in ${stateDirection}.${groupHint}`;
  const exclusions = 'No unrelated characters or props, no support object unless this slot explicitly represents it, no scenery, no ground, no cast shadow, no border, no text, no logo, no collage, no split panel, no duplicate limbs.';
  const stateOverride = propSubject ? propStateInstruction(state) : '';
  return [
    'Create one production-ready paper animation cutout asset, not a finished scene.',
    `Subject: ${subjectLine}.`,
    stateOverride ? `STATE OVERRIDE — mandatory: ${stateOverride}` : '',
    `Show the complete ${propSubject ? 'object' : 'subject'} with a clean separated silhouette. Preserve identity, proportions, facing, palette, mineral-pigment impasto and gongbi linework across all states.`,
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

function createImageGeneration(db, run, shot, slot, provider, prompt, requestFingerprint, referenceImages = []) {
  const columns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  const values = {
    storyboard_id: sourceService.legacyStoryboardId(shot), paper_storyboard_id: shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id), drama_id: Number(shot.drama_id), provider: provider.provider || 'openai',
    prompt, model: provider.model, frame_type: slot.slot_key, size: '1536x1024', quality: 'high',
    status: 'processing', generation_kind: 'paper_studio_asset', generation_purpose: slot.generation_purpose,
    request_fingerprint: requestFingerprint, reference_images: referenceImages.length ? JSON.stringify(referenceImages) : null,
    created_at: nowIso(), updated_at: nowIso(),
  };
  const entries = Object.entries(values).filter(([key]) => columns.has(key));
  const result = db.prepare(`INSERT INTO image_generations (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value));
  return Number(result.lastInsertRowid);
}

async function generateViaApi(db, cfg, log, run, shot, slot, authorizationId) {
  require('./paperGenerationAuthorizationService').assertUsable(db, authorizationId, {
    runId: run.id,
    shotId: shot.id,
    slotId: slot.id,
  });
  const maxImages = Number(run.budget_json?.max_images || 24);
  const usedImages = Number(db.prepare(
    `SELECT COUNT(*) AS count
     FROM image_generations ig
     JOIN paper_asset_versions pav ON pav.id = ig.paper_asset_version_id
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id
     WHERE ig.generation_kind = 'paper_studio_asset' AND pss.run_id = ?
       AND ig.status IN ('processing','completed')
       AND ig.deleted_at IS NULL`,
  ).get(Number(run.id))?.count || 0);
  if (usedImages >= maxImages) {
    throw new PaperStudioError('PAPER_STUDIO_IMAGE_BUDGET_EXHAUSTED', '当前生产版本的图片预算已用完', { run_id: Number(run.id), shot_id: Number(shot.id), used_images: usedImages, max_images: maxImages }, 409);
  }
  const provider = selectedProvider(db, run);
  const prompt = promptForSlot(db, shot, slot);
  const referenceImages = referenceImagesForSlot(db, shot, slot, provider);
  const sourceStoryboard = sourceService.storyboard(db, shot);
  const environmentOnly = Boolean(shot.plan_summary_json?.environment_only || sourceStoryboard?.environment_only);
  const mapBase = Boolean(shot.plan_summary_json?.map_route || /map-route-reveal/.test(String(shot.plan_summary_json?.catalog_key || '')));
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
  const fingerprint = sha256(canonicalJson({ shot_source: shot.source_revision_hash, slot: slot.slot_key, prompt, provider, reference_images: referenceImages, background_strategy: backgroundStrategy }));
  const imageGenerationId = createImageGeneration(db, run, shot, slot, provider, prompt, fingerprint, referenceImages);
  const versionId = insertVersion(db, slot, 'image_api', { provider_config_id: provider.config_id, request_fingerprint: fingerprint, prompt, reference_images: referenceImages });
  const previousVersionId = slot.current_version_id == null ? null : Number(slot.current_version_id);
  db.prepare("UPDATE paper_asset_slots SET status = 'generating', version = version + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), Number(slot.id));
  db.prepare('UPDATE image_generations SET paper_asset_version_id = ? WHERE id = ?').run(versionId, imageGenerationId);
  db.prepare('UPDATE paper_asset_versions SET image_generation_id = ? WHERE id = ?').run(imageGenerationId, versionId);
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
        ? (mapBase
          ? `Image ${index + 1}${index === 0 ? ' is the selected strategic-map composition and the primary visual authority' : ''}: preserve its complete map geometry, river, bridge, mountains, cities, paper boundary, tabletop framing, palette and camera. Remove all arrows, encirclement marks, people, title cards and readable text so they can be animated independently.`
          : slot.constraints_json?.reference_role === 'style_only'
          ? `Image ${index + 1}: STYLE CONTINUITY reference only. Preserve era, weather family, lighting direction, palette, paper texture and rendering medium. Do not copy its place, architecture, subject layout, camera composition or perspective; build the different scene required by environment_description.`
          : environmentOnly
          ? `Image ${index + 1}${index === 0 ? ' is the selected storyboard reference and the primary visual authority' : ''}: preserve its composition, era, location, weather, damage, palette, paper medium and visible environmental storytelling. Do not replace it with a generic landscape.`
          : `Image ${index + 1}${index === 0 ? ' is the selected storyboard reference and the primary visual authority' : ''}: preserve geography, perspective, era, weather, environmental damage, lighting and style. Remove only characters or hero props explicitly separated into independent animation layers.`)
        : `Image ${index + 1}: identity, historical form, silhouette or same-family pose reference only. Treat its background, lighting and rendering medium as obsolete. Do not copy photography, photorealistic surface rendering or CGI from the reference; redraw the subject from scratch in the mandatory PROJECT VISUAL STYLE and PAPER-ANIMATION MEDIUM.`).join('\n'),
      user_negative_prompt: slot.asset_type === 'environment'
        ? (mapBase
          ? 'route arrow, arrowhead, route line, encirclement ring, strategy dot, army marker, commander, person, silhouette, title card, label, readable text, Chinese character, changed geography, changed river, changed city position, changed composition, photorealism, smooth CGI, split panel, collage'
          : slot.constraints_json?.reference_role === 'style_only'
          ? 'copied reference location, copied reference composition, wrong scene, hybrid indoor-outdoor location, independent foreground character, independent hero prop, subject-shaped hole, changed era, changed weather family, text, logo, split panel, collage'
          : environmentOnly
          ? 'reference drift, changed composition, changed era, changed location, changed weather, changed damage state, sunny generic landscape, clean peaceful beach, modern scenery, cheerful palette, photorealism, smooth CGI, text, logo, split panel, collage'
          : 'independent foreground character, independent hero prop, subject-shaped hole, changed composition, changed era, changed weather, text, logo, split panel, collage')
        : 'background, scenery, floor, cast shadow, text, logo, split panel, collage, duplicate limbs, cropped body',
    };
    let requestedBackground = canRequestTransparent ? 'transparent' : 'opaque';
    let providerTransparencyRejected = false;
    let result;
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
      return imageClient.callImageApi(db, log, { ...apiOptions, background: requestedBackground });
    };
    try {
      result = await imageClient.callImageApi(db, log, { ...apiOptions, background: requestedBackground });
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
      target.relative,
      requireAlpha ? target.relative : null,
      requireAlpha ? sourceHash : hashFile(target.absolute),
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

async function generateAssets(db, cfg, log, shotId, body = {}) {
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
    for (const family of shot.families) {
      const missing = db.prepare("SELECT COUNT(*) AS count FROM paper_asset_slots WHERE family_id = ? AND required_for_gate = 1 AND (current_version_id IS NULL OR status != 'ready') AND deleted_at IS NULL").get(Number(family.id));
      db.prepare("UPDATE paper_source_families SET status = ?, version = version + 1, updated_at = ? WHERE id = ?").run(Number(missing.count) ? 'failed' : 'review', nowIso(), Number(family.id));
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
    db.prepare("UPDATE paper_studio_shots SET status = 'asset_review', version = version + 1, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = 'assets_processing', progress = 38, updated_at = ? WHERE id = ?").run(nowIso(), Number(run.id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets')").run(JSON.stringify({ asset_versions: results.map((item) => item.version_id).filter(Boolean), manual_review_required: true }), nowIso(), nowIso(), Number(run.id), Number(shot.id));
    runAggregateService.sync(db, run.id);
    require('./paperGenerationAuthorizationService').markConsumedIfFinished(db, body.authorization_id);
    return { shot: shotService.get(db, shot.id), generated: results, continuity };
  } catch (error) {
    const liveRun = db.prepare('SELECT status FROM paper_studio_runs WHERE id = ?').get(Number(run.id));
    const liveShot = db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(Number(shot.id));
    if (liveRun?.status === 'cancelled' || liveShot?.status === 'cancelled') throw error;
    const failure = { code: error.code || 'PAPER_STUDIO_ASSET_GENERATION_FAILED', message: error.message, at: nowIso() };
    const requiredMissing = Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_asset_slots pas
       JOIN paper_source_families psf ON psf.id = pas.family_id
       WHERE psf.shot_id = ? AND pas.required_for_gate = 1
         AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL
         AND (pas.current_version_id IS NULL OR pas.status != 'ready')`,
    ).get(Number(shot.id))?.count || 0);
    const recoverableWithCurrent = requiredMissing === 0;
    db.prepare("UPDATE paper_studio_shots SET status = ?, attention_required = ?, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(recoverableWithCurrent ? 'asset_review' : 'asset_failed', recoverableWithCurrent ? 'review_assets' : 'authorize_generation', JSON.stringify(failure), nowIso(), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = ?, attention_required = ?, last_error_json = ?, updated_at = ? WHERE id = ?")
      .run(recoverableWithCurrent ? 'assets_processing' : 'partial', recoverableWithCurrent ? 'review_assets' : 'authorize_generation', JSON.stringify(failure), nowIso(), Number(run.id));
    db.prepare("UPDATE paper_job_steps SET status = 'failed_retryable', error_json = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key IN ('generate_layout_master','generate_required_slots','matte_assets','register_assets','asset_gate') AND status != 'completed'").run(JSON.stringify(failure), nowIso(), Number(run.id), Number(shot.id));
    runAggregateService.sync(db, run.id);
    require('./paperGenerationAuthorizationService').markConsumedIfFinished(db, body.authorization_id);
    throw error;
  }
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
     WHERE psf.shot_id = ? AND pas.deleted_at IS NULL AND psf.deleted_at IS NULL`,
  ).all(Number(shot.id)).map((row) => ({ ...row, constraints_json: parseJson(row.constraints_json, {}) }));
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
        item.target.relative,
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
    db.prepare("UPDATE paper_motion_plans SET status = 'draft', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ?")
      .run(now, Number(shot.id));
    db.prepare(`UPDATE paper_studio_shots
      SET status = 'asset_review', current_snapshot_id = NULL, approved_snapshot_id = NULL,
          last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?`)
      .run(now, Number(shot.id));
    db.prepare(`UPDATE paper_job_steps
      SET status = 'queued', result_json = '{}', error_json = '{}', lease_owner = NULL,
          lease_expires_at = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE run_id = ? AND shot_id = ? AND step_key IN
        ('asset_gate','plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview',
         'wait_preview_approval','render_formal','publish_video')`)
      .run(now, Number(shot.run_id), Number(shot.id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key IN ('matte_assets','register_assets')")
      .run(JSON.stringify({ rematted_asset_version_ids: prepared.map((item) => Number(item.versionId)), algorithm_version: 'edge-defringe-v2' }), now, now, Number(shot.run_id), Number(shot.id));
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
  referenceImagesForSlot,
  styleLockForSlot,
  propStateInstruction,
  isTransparentBackgroundUnsupported,
  promptForSlot,
  isProceduralStateFallback,
  ensureProceduralStateFallbacks,
  deriveOccluder,
  generateAssets,
  rematteAssets,
};
