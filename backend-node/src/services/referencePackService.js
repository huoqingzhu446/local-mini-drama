'use strict';

const crypto = require('crypto');
const visualStyleVersionService = require('./visualStyleVersionService');

const DEFAULT_LIMITS = Object.freeze({ total: 8, maxCharacters: 4, maxObjects: 8 });

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch (_) {
    return new Set();
  }
}

function normalizeFrameType(frameType) {
  const value = String(frameType || 'main').trim();
  if (['storyboard_first', 'first_frame', 'head'].includes(value)) return 'first';
  if (['storyboard_last', 'last_frame', 'tail'].includes(value)) return 'last';
  if (['scene_reference_grid', 'nine_grid', 'scene_nine_grid'].includes(value)) return 'reference_grid';
  return value || 'main';
}

function canonicalRefKey(ref) {
  let value = ref;
  if (value && typeof value === 'object') value = value.value || value.url || value.path || value.local_path || value.image_url;
  if (value == null || value === '') return '';
  const text = String(value).trim().replace(/\\/g, '/');
  if (!text) return '';
  if (text.startsWith('data:')) return text.slice(0, 160);
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.origin}${url.pathname}`.toLowerCase();
    } catch (_) {
      return text.split('?')[0].toLowerCase();
    }
  }
  return text.split('?')[0].replace(/^\/+/, '/').toLowerCase();
}

function normalizeLimits(input = {}) {
  const total = Number(input.total ?? input.max_total ?? input.maxTotal);
  const maxCharacters = Number(input.maxCharacters ?? input.max_characters);
  const maxObjects = Number(input.maxObjects ?? input.max_objects);
  return {
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : DEFAULT_LIMITS.total,
    maxCharacters: Number.isFinite(maxCharacters) && maxCharacters >= 0 ? Math.floor(maxCharacters) : DEFAULT_LIMITS.maxCharacters,
    maxObjects: Number.isFinite(maxObjects) && maxObjects >= 0 ? Math.floor(maxObjects) : DEFAULT_LIMITS.maxObjects,
  };
}

function imageValue(row, options = {}) {
  if (!row) return '';
  const keys = options.keys || ['local_path', 'image_url', 'ref_image'];
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function appendExtraValues(out, raw) {
  const parsed = parseJson(raw, raw);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const value = typeof item === 'object' && item ? (item.local_path || item.image_url || item.url || item.path) : item;
      if (value) out.push(String(value).trim());
    }
  } else if (typeof parsed === 'string' && parsed.trim()) {
    out.push(parsed.trim());
  }
}

function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch (_) { return null; }
}

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params) || []; } catch (_) { return []; }
}

function activeStyleVersion(db, dramaId) {
  if (!Number(dramaId)) return null;
  try {
    const dramaCols = tableColumns(db, 'dramas');
    // 只有明确迁移并激活过 V2 版本的项目才过滤 legacy reference。
    // 对尚未迁移的旧库，ensureActiveVersion 的兼容 bootstrap 不应改变
    // 原有参考图行为。
    if (!dramaCols.has('active_visual_style_version_id')) return null;
    const dramaFields = ['active_visual_style_version_id'];
    if (dramaCols.has('active_visual_style_signature')) dramaFields.push('active_visual_style_signature');
    if (dramaCols.has('metadata')) dramaFields.push('metadata');
    const row = safeGet(db, `SELECT ${dramaFields.join(', ')} FROM dramas WHERE id = ?`, [Number(dramaId)]);
    const metadata = parseJson(row?.metadata, {}) || {};
    if (!row?.active_visual_style_version_id || !row?.active_visual_style_signature || !Number(metadata.style_version)) return null;
    return visualStyleVersionService.getVersion(db, Number(row.active_visual_style_version_id));
  } catch (_) { return null; }
}

function referenceProvenance(db, entityType, entityId, value) {
  const columns = tableColumns(db, 'image_generations');
  const entityColumn = entityType === 'character' ? 'character_id' : entityType === 'prop' ? 'prop_id' : entityType === 'storyboard' ? 'storyboard_id' : 'scene_id';
  if (!columns.has(entityColumn) || !columns.has('status')) return null;
  const fields = [
    columns.has('style_version_id') ? 'style_version_id' : 'NULL AS style_version_id',
    columns.has('context_snapshot_id') ? 'context_snapshot_id' : 'NULL AS context_snapshot_id',
    columns.has('local_path') ? 'local_path' : 'NULL AS local_path',
    columns.has('image_url') ? 'image_url' : 'NULL AS image_url',
  ];
  const rows = safeAll(db, `SELECT ${fields.join(', ')} FROM image_generations WHERE ${entityColumn} = ? AND status = 'completed'${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''} ORDER BY id DESC`, [Number(entityId)]);
  const key = canonicalRefKey(value);
  return rows.find((row) => canonicalRefKey(row.local_path) === key || canonicalRefKey(row.image_url) === key) || null;
}

function shouldFilterStaleReference(db, value, details, options = {}) {
  if (options.allow_stale_references || options.allowStaleReferences) return false;
  if (!value || ['user_reference', 'manual'].includes(details.role)) return false;
  const active = activeStyleVersion(db, details.drama_id);
  if (!active) return false;
  const provenance = referenceProvenance(db, details.entity_type, details.entity_id, value);
  // 有 V2 活动版本但没有生成 provenance 的旧主图/旧候选图，默认视为
  // legacy reference；避免模型把旧水墨/CG媒介复制进新分镜。
  if (!provenance || !provenance.style_version_id || Number(provenance.style_version_id) !== Number(active.id)) return true;
  return false;
}

function addManagedReference(state, db, value, details = {}, options = {}) {
  if (shouldFilterStaleReference(db, value, details, options)) {
    state.diagnostics.push({
      code: 'STALE_REFERENCE',
      severity: 'warning',
      message: `已跳过未绑定当前视觉版本的旧参考图：${details.label || value}`,
      value,
      role: details.role || null,
      entity_type: details.entity_type || null,
      entity_id: details.entity_id || null,
    });
    return false;
  }
  return addReference(state, value, details);
}

function getStoryboard(db, storyboardId) {
  const columns = tableColumns(db, 'storyboards');
  if (!columns.size) return null;
  const fields = [
    'id', 'episode_id', 'scene_id', 'storyboard_number', 'title', 'description', 'location', 'time',
    'action', 'dialogue', 'narration', 'result', 'characters', 'image_url', 'local_path',
    'first_frame_image_id', 'last_frame_image_url', 'last_frame_local_path',
  ].filter((name) => columns.has(name));
  const row = safeGet(db, `SELECT ${fields.join(', ')} FROM storyboards WHERE id = ?${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(storyboardId)]);
  if (!row) return null;
  if (columns.has('episode_id')) {
    const ep = safeGet(db, `SELECT drama_id FROM episodes WHERE id = ?${tableColumns(db, 'episodes').has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(row.episode_id)]);
    row.drama_id = ep?.drama_id || null;
  }
  return row;
}

function getScene(db, sceneId) {
  const columns = tableColumns(db, 'scenes');
  if (!columns.size) return null;
  const wanted = [
    'id', 'drama_id', 'episode_id', 'location', 'time', 'image_url', 'local_path',
    'reference_grid_image_url', 'reference_grid_local_path', 'ref_image', 'extra_images',
  ];
  const fields = wanted.map((name) => columns.has(name) ? name : `NULL AS ${name}`);
  return safeGet(db, `SELECT ${fields.join(', ')} FROM scenes WHERE id = ?${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(sceneId)]);
}

function getFirstFrameReference(db, storyboard) {
  if (!storyboard) return '';
  if (storyboard.first_frame_image_id) {
    const cols = tableColumns(db, 'image_generations');
    const row = safeGet(db, `SELECT ${cols.has('local_path') ? 'local_path' : 'NULL AS local_path'}, ${cols.has('image_url') ? 'image_url' : 'NULL AS image_url'} FROM image_generations WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(storyboard.first_frame_image_id)]);
    const value = imageValue(row);
    if (value) return value;
  }
  return imageValue(storyboard, { keys: ['local_path', 'image_url'] });
}

function fallbackGeneratedReference(db, entityColumn, entityId, frameType) {
  const columns = tableColumns(db, 'image_generations');
  if (!columns.has(entityColumn) || !columns.has('frame_type')) return '';
  const fields = [columns.has('local_path') ? 'local_path' : 'NULL AS local_path', columns.has('image_url') ? 'image_url' : 'NULL AS image_url'];
  const row = safeGet(db, `SELECT ${fields.join(', ')} FROM image_generations WHERE ${entityColumn} = ? AND frame_type = ? AND status = 'completed'${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''} ORDER BY id DESC LIMIT 1`, [Number(entityId), frameType]);
  return imageValue(row);
}

function parseSelectedCharacterIds(raw) {
  const parsed = parseJson(raw, null);
  if (!Array.isArray(parsed)) return null;
  return parsed.map((item) => Number(typeof item === 'object' && item ? item.id : item)).filter((id) => Number.isFinite(id) && id > 0);
}

function addReference(state, value, details = {}) {
  const ref = String(value || '').trim();
  if (!ref) return false;
  const key = canonicalRefKey(ref);
  if (!key || state.seen.has(key)) return false;
  const countsAs = details.counts_as || (details.role === 'character' ? 'character' : 'object');
  const isLayout = countsAs === 'layout';
  const canAdd = isLayout
    ? state.references.length < state.limits.total
    : state.references.length < state.limits.total && (
      countsAs === 'character' ? state.characterCount < state.limits.maxCharacters : state.objectCount < state.limits.maxObjects
    );
  if (!canAdd) {
    state.diagnostics.push({ code: 'REFERENCE_LIMIT', message: `参考图达到上限，已跳过 ${details.label || ref}`, value: ref });
    return false;
  }
  state.seen.add(key);
  const item = {
    value: ref,
    path: ref,
    url: /^https?:\/\//i.test(ref) || ref.startsWith('/static/') ? ref : undefined,
    role: details.role || (countsAs === 'character' ? 'character' : 'object'),
    counts_as: countsAs,
    priority: Number.isFinite(Number(details.priority)) ? Number(details.priority) : 50,
    label: details.label || ref,
    source: details.source || 'database',
    entity_type: details.entity_type || null,
    entity_id: details.entity_id != null ? Number(details.entity_id) : null,
  };
  state.references.push(item);
  if (countsAs === 'character') state.characterCount += 1;
  else if (!isLayout) state.objectCount += 1;
  return true;
}

function addManualReferences(state, values, options = {}) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  list.forEach((value, index) => {
    const ref = typeof value === 'object' && value ? (value.value || value.url || value.path || value.local_path || value.image_url) : value;
    if (!ref) return;
    addReference(state, ref, {
      role: value?.role || options.role || 'manual',
      counts_as: value?.counts_as || options.counts_as || 'object',
      priority: value?.priority ?? options.priority ?? 5,
      label: value?.label || options.label || `手动参考图 ${index + 1}`,
      source: 'request',
    });
  });
}

function buildReferencePack(db, options = {}) {
  const entityType = String(options.entity_type || options.entityType || '').trim();
  const entityId = Number(options.entity_id ?? options.entityId);
  const frameType = normalizeFrameType(options.frame_type ?? options.frameType);
  const limits = normalizeLimits(options.limits || options.provider_limits || {});
  const state = { limits, references: [], seen: new Set(), characterCount: 0, objectCount: 0, diagnostics: [] };

  if (entityType === 'scene') {
    const scene = getScene(db, entityId);
    if (scene && frameType === 'reference_grid') {
      const main = imageValue(scene);
      if (main) addManagedReference(state, db, main, {
        role: 'scene_main', counts_as: 'object', priority: 10,
        label: `场景主图：${scene.location || entityId}`, source: 'scene_main', entity_type: 'scene', entity_id: entityId, drama_id: scene.drama_id,
      }, options);
    } else if (scene) {
      const user = scene.ref_image;
      if (user) addReference(state, user, {
        role: 'user_reference', counts_as: 'object', priority: 5,
        label: `场景用户参考：${scene.location || entityId}`, source: 'scene_ref_image', entity_type: 'scene', entity_id: entityId,
      });
      appendExtraValuesToState(state, scene.extra_images, { role: 'scene_extra', counts_as: 'object', priority: 30, label: `场景补充图：${scene.location || entityId}`, entity_type: 'scene', entity_id: entityId, drama_id: scene.drama_id }, db, options);
    }
  } else if (entityType === 'character' || entityType === 'prop') {
    const table = entityType === 'character' ? 'characters' : 'props';
    const cols = tableColumns(db, table);
    if (cols.size) {
      const fields = ['id', 'drama_id', 'name', 'image_url', 'local_path', 'ref_image', 'extra_images'].map((name) => cols.has(name) ? name : `NULL AS ${name}`);
      const row = safeGet(db, `SELECT ${fields.join(', ')} FROM ${table} WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [entityId]);
      if (row) {
        const main = imageValue(row, { keys: ['ref_image', 'local_path', 'image_url'] });
        if (main) addManagedReference(state, db, main, {
          role: entityType, counts_as: entityType === 'character' ? 'character' : 'object', priority: 10,
          label: `${entityType === 'character' ? '角色' : '道具'}：${row.name || entityId}`, source: `${entityType}_entity`, entity_type: entityType, entity_id: entityId, drama_id: row.drama_id,
        }, options);
        appendExtraValuesToState(state, row.extra_images, { role: `${entityType}_extra`, counts_as: entityType === 'character' ? 'character' : 'object', priority: 30, label: `${entityType} 补充图：${row.name || entityId}`, entity_type: entityType, entity_id: entityId, drama_id: row.drama_id }, db, options);
      }
    }
  } else if (entityType === 'storyboard') {
    const storyboard = getStoryboard(db, entityId);
    if (storyboard) {
      if (frameType === 'last' && options.use_first_frame_layout_lock !== false && options.useFirstFrameLayoutLock !== false) {
        const first = getFirstFrameReference(db, storyboard);
        if (first) addManagedReference(state, db, first, {
          role: 'first_frame_layout_lock', counts_as: 'layout', priority: 0,
          label: '首帧构图与人物站位锁（尾帧最高优先级）', source: 'storyboard_first_frame', entity_type: 'storyboard', entity_id: entityId, drama_id: storyboard.drama_id,
        }, options);
      }
      const scene = storyboard.scene_id ? getScene(db, storyboard.scene_id) : null;
      if (scene) {
        const sceneMain = imageValue(scene);
        if (sceneMain) addManagedReference(state, db, sceneMain, {
          role: 'scene_main', counts_as: 'object', priority: 10,
          label: `场景主图：${scene.location || storyboard.location || storyboard.scene_id}`, source: 'scene_main', entity_type: 'scene', entity_id: storyboard.scene_id, drama_id: scene.drama_id || storyboard.drama_id,
        }, options);
        const grid = imageValue(scene, { keys: ['reference_grid_local_path', 'reference_grid_image_url'] });
        if (grid) addManagedReference(state, db, grid, {
          role: 'scene_reference_grid', counts_as: 'object', priority: 20,
          label: `场景参考九宫格：${scene.location || storyboard.location || storyboard.scene_id}`, source: 'scene_reference_grid', entity_type: 'scene', entity_id: storyboard.scene_id, drama_id: scene.drama_id || storyboard.drama_id,
        }, options);
      }

      const selectedIds = parseSelectedCharacterIds(storyboard.characters);
      const explicitSelection = selectedIds !== null;
      const charIds = selectedIds || [];
      if (!explicitSelection) {
        // 兼容旧数据：通过关联表和文本补扫；不会在显式空数组时偷偷加角色。
        for (const link of safeAll(db, 'SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?', [entityId])) {
          if (link.character_id) charIds.push(Number(link.character_id));
        }
        const dramaChars = storyboard.drama_id
          ? safeAll(db, 'SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL', [Number(storyboard.drama_id)])
          : [];
        const scanText = [storyboard.title, storyboard.description, storyboard.action, storyboard.dialogue, storyboard.narration, storyboard.result].filter(Boolean).join(' ').toLowerCase();
        for (const char of dramaChars) {
          if (char.name && scanText.includes(String(char.name).toLowerCase())) charIds.push(Number(char.id));
        }
      }
      const uniqueCharIds = [...new Set(charIds.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0))];
      for (const charId of uniqueCharIds) {
        const charCols = tableColumns(db, 'characters');
        if (!charCols.size) break;
        const fields = ['id', 'drama_id', 'name', 'image_url', 'local_path'].map((name) => charCols.has(name) ? name : `NULL AS ${name}`);
        const char = safeGet(db, `SELECT ${fields.join(', ')} FROM characters WHERE id = ?${charCols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(charId)]);
        if (!char) continue;
        let ref = imageValue(char);
        if (!ref) ref = fallbackGeneratedReference(db, 'character_id', charId, 'quad_panel_1');
        if (ref) addManagedReference(state, db, ref, {
          role: 'character', counts_as: 'character', priority: 30,
          label: `角色外观：${char.name || charId}`, source: 'storyboard_character', entity_type: 'character', entity_id: charId, drama_id: char.drama_id || storyboard.drama_id,
        }, options);
      }

      for (const link of safeAll(db, 'SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?', [entityId])) {
        const propCols = tableColumns(db, 'props');
        if (!propCols.size) break;
        const fields = ['id', 'drama_id', 'name', 'image_url', 'local_path', 'ref_image', 'extra_images'].map((name) => propCols.has(name) ? name : `NULL AS ${name}`);
        const prop = safeGet(db, `SELECT ${fields.join(', ')} FROM props WHERE id = ?${propCols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(link.prop_id)]);
        if (!prop) continue;
        let ref = imageValue(prop, { keys: ['ref_image', 'local_path', 'image_url'] });
        if (!ref) {
          const extras = [];
          appendExtraValues(extras, prop.extra_images);
          ref = extras[0] || '';
        }
        if (ref) addManagedReference(state, db, ref, {
          role: 'prop', counts_as: 'object', priority: 40,
          label: `道具外观：${prop.name || link.prop_id}`, source: 'storyboard_prop', entity_type: 'prop', entity_id: Number(link.prop_id), drama_id: prop.drama_id || storyboard.drama_id,
        }, options);
      }

      // 角色库是旧版本的第二来源；只有没有显式角色选择时才补入，避免 UI 去掉的角色回流。
      if (!explicitSelection) {
        for (const link of safeAll(db, 'SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?', [entityId])) {
          const libCols = tableColumns(db, 'character_libraries');
          if (!libCols.size) break;
          const fields = ['id', 'name', 'four_view_image_url', 'image_url', 'local_path'].map((name) => libCols.has(name) ? name : `NULL AS ${name}`);
          const lib = safeGet(db, `SELECT ${fields.join(', ')} FROM character_libraries WHERE id = ?${libCols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(link.character_id)]);
          if (!lib) continue;
          const ref = imageValue(lib, { keys: ['four_view_image_url', 'local_path', 'image_url'] }) || fallbackGeneratedReference(db, 'character_id', lib.id, 'quad_panel_1');
          if (ref) addManagedReference(state, db, ref, {
            role: 'character_library', counts_as: 'character', priority: 45,
            label: `角色库外观：${lib.name || lib.id}`, source: 'storyboard_character_library', entity_type: 'character_library', entity_id: lib.id, drama_id: storyboard.drama_id,
          }, options);
        }
      }
    }
  }

  // 项目上下文（尾帧首帧锁、场景主图/网格、选中角色与道具）优先于临时手动图；
  // 这样在供应商有上限时不会因为旧调用传入的参考图挤掉空间连续性锚点。
  addManualReferences(state, options.reference_images || options.referenceImages, { priority: 60 });

  // 更低优先级的引用排在高优先级后面；手动图/首帧已在前面锁定。
  state.references.sort((a, b) => (a.priority - b.priority));
  const references = state.references.map((item, index) => ({ ...item, index: index + 1 }));
  const referenceImages = references.map((item) => item.value);
  const hash = crypto.createHash('sha256').update(JSON.stringify(references.map(({ value, role, source, entity_type, entity_id }) => ({ value, role, source, entity_type, entity_id })))).digest('hex').slice(0, 20);
  return {
    version: 1,
    entity_type: entityType,
    entity_id: entityId,
    frame_type: frameType,
    limits,
    references,
    reference_images: referenceImages,
    hash,
    diagnostics: state.diagnostics,
  };
}

function appendExtraValuesToState(state, raw, details, db, options = {}) {
  const values = [];
  appendExtraValues(values, raw);
  values.forEach((value, index) => addManagedReference(state, db, value, {
    ...details,
    label: `${details.label || '补充参考图'} ${index + 1}`,
  }, options));
}

module.exports = {
  DEFAULT_LIMITS,
  parseJson,
  tableColumns,
  normalizeFrameType,
  canonicalRefKey,
  normalizeLimits,
  buildReferencePack,
  addReference,
};
