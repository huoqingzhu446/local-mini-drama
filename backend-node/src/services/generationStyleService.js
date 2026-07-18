'use strict';

const { normalizeVisualBible } = require('../utils/dramaStyleMerge');

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
  if (value === true || value === 1 || value === '1') return 1;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '启用'].includes(s)) return 1;
  if (['false', 'no', 'off', '0', '停用'].includes(s)) return 0;
  return fallback ? 1 : 0;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeCompatibilityTags(input) {
  const parsed = Array.isArray(input)
    ? input
    : (typeof input === 'string' && input.trim().startsWith('[') ? parseJson(input, []) : String(input || '').split(/[,，、\n]/g));
  const seen = new Set();
  return (Array.isArray(parsed) ? parsed : []).map((item) => String(item || '').trim()).filter((item) => item && !seen.has(item) && (seen.add(item), true));
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
  catch (_) { return new Set(); }
}

function ensureClassificationColumns(db) {
  const cols = tableColumns(db, 'generation_styles');
  for (const [name, type] of [['style_family', 'TEXT'], ['medium', 'TEXT'], ['compatibility_tags', 'TEXT']]) {
    if (!cols.has(name)) { try { db.exec(`ALTER TABLE generation_styles ADD COLUMN ${name} ${type}`); } catch (_) {} }
  }
  return tableColumns(db, 'generation_styles');
}

function trimText(value, maxLen = 0) {
  const text = value != null ? String(value).trim() : '';
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim();
}

function normalizeVisualBibleStruct(input) {
  let source = input;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return null;
    try {
      source = JSON.parse(text);
    } catch (_) {
      return null;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const normalized = {
    palette: trimText(source.palette || source.colors || source.color_palette, 500),
    lighting: trimText(source.lighting || source.light, 500),
    texture: trimText(source.texture || source.rendering || source.materials, 500),
    composition: trimText(source.composition || source.framing, 500),
    negative: trimText(source.negative || source.forbidden || source.avoid, 500),
    notes: trimText(source.notes || source.misc, 800),
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeStylePayload(body = {}) {
  const visualBibleStruct = normalizeVisualBibleStruct(
    body.visual_bible_struct || body.visual_bible_schema || body.visual_bible_json || body.visual_bible
  );
  const visualBibleText = normalizeVisualBible(visualBibleStruct || body.visual_bible || body.visual_bible_text || '');
  return {
    name: trimText(body.name, 80),
    description: trimText(body.description, 300) || null,
    style_prompt_zh: trimText(body.style_prompt_zh || body.prompt || body.style_prompt || body.prompt_zh, 4000),
    style_prompt_en: trimText(body.style_prompt_en || body.promptEn || body.prompt_en, 4000),
    visual_bible: visualBibleText || null,
    visual_bible_struct: visualBibleStruct,
    character_style_prompt_zh: trimText(body.character_style_prompt_zh, 3000) || null,
    character_style_prompt_en: trimText(body.character_style_prompt_en, 3000) || null,
    scene_style_prompt_zh: trimText(body.scene_style_prompt_zh, 3000) || null,
    scene_style_prompt_en: trimText(body.scene_style_prompt_en, 3000) || null,
    prop_style_prompt_zh: trimText(body.prop_style_prompt_zh, 3000) || null,
    prop_style_prompt_en: trimText(body.prop_style_prompt_en, 3000) || null,
    video_style_prompt_zh: trimText(body.video_style_prompt_zh, 3000) || null,
    video_style_prompt_en: trimText(body.video_style_prompt_en, 3000) || null,
    enabled: normalizeBool(body.enabled, true),
    sort_order: body.sort_order !== undefined && body.sort_order !== null
      ? Number(body.sort_order) || 0
      : null,
    style_family: trimText(body.style_family || body.styleFamily, 120) || null,
    medium: trimText(body.medium, 120) || null,
    compatibility_tags: normalizeCompatibilityTags(body.compatibility_tags || body.compatibilityTags),
  };
}

function rowToStyle(row) {
  if (!row) return null;
  let visualBibleStruct = null;
  if (row.visual_bible_struct) {
    try {
      visualBibleStruct = typeof row.visual_bible_struct === 'string'
        ? JSON.parse(row.visual_bible_struct)
        : row.visual_bible_struct;
    } catch (_) {
      visualBibleStruct = null;
    }
  }
  return {
    id: row.id,
    name: row.name || '',
    description: row.description || '',
    style_prompt_zh: row.style_prompt_zh || '',
    style_prompt_en: row.style_prompt_en || '',
    visual_bible: row.visual_bible || '',
    visual_bible_struct: visualBibleStruct,
    character_style_prompt_zh: row.character_style_prompt_zh || '',
    character_style_prompt_en: row.character_style_prompt_en || '',
    scene_style_prompt_zh: row.scene_style_prompt_zh || '',
    scene_style_prompt_en: row.scene_style_prompt_en || '',
    prop_style_prompt_zh: row.prop_style_prompt_zh || '',
    prop_style_prompt_en: row.prop_style_prompt_en || '',
    video_style_prompt_zh: row.video_style_prompt_zh || '',
    video_style_prompt_en: row.video_style_prompt_en || '',
    enabled: Number(row.enabled) !== 0,
    sort_order: Number(row.sort_order) || 0,
    style_family: row.style_family || '',
    medium: row.medium || '',
    compatibility_tags: normalizeCompatibilityTags(row.compatibility_tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function nextSortOrder(db) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM generation_styles WHERE deleted_at IS NULL'
  ).get();
  return Number(row?.next_order) || 10;
}

function listStyles(db, query = {}) {
  ensureClassificationColumns(db);
  const keyword = trimText(query.keyword, 100);
  const enabled = query.enabled;
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (keyword) {
    where.push(`(
      name LIKE ?
      OR description LIKE ?
      OR style_prompt_zh LIKE ?
      OR style_prompt_en LIKE ?
      OR visual_bible LIKE ?
    )`);
    const k = `%${keyword}%`;
    params.push(k, k, k, k, k);
  }
  if (enabled !== undefined && enabled !== null && enabled !== '') {
    where.push('enabled = ?');
    params.push(normalizeBool(enabled, true));
  }
  const rows = db.prepare(
    `SELECT * FROM generation_styles
     WHERE ${where.join(' AND ')}
     ORDER BY sort_order ASC, id DESC`
  ).all(...params);
  return rows.map(rowToStyle);
}

function getStyle(db, id) {
  ensureClassificationColumns(db);
  const row = db.prepare('SELECT * FROM generation_styles WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return rowToStyle(row);
}

function validateRequired(payload) {
  if (!payload.name) {
    const err = new Error('名称不能为空');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (!payload.style_prompt_zh && !payload.style_prompt_en) {
    const err = new Error('至少填写一项全局风格提示词');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

function createStyle(db, body = {}) {
  const columns = ensureClassificationColumns(db);
  const payload = normalizeStylePayload(body);
  validateRequired(payload);
  const now = new Date().toISOString();
  const sortOrder = payload.sort_order == null ? nextSortOrder(db) : payload.sort_order;
  const fields = [
    'name', 'description', 'style_prompt_zh', 'style_prompt_en', 'visual_bible', 'visual_bible_struct',
    'character_style_prompt_zh', 'character_style_prompt_en', 'scene_style_prompt_zh', 'scene_style_prompt_en',
    'prop_style_prompt_zh', 'prop_style_prompt_en', 'video_style_prompt_zh', 'video_style_prompt_en',
    'enabled', 'sort_order', 'created_at', 'updated_at',
  ];
  const values = [
    payload.name,
    payload.description,
    payload.style_prompt_zh || null,
    payload.style_prompt_en || null,
    payload.visual_bible,
    payload.visual_bible_struct ? JSON.stringify(payload.visual_bible_struct) : null,
    payload.character_style_prompt_zh,
    payload.character_style_prompt_en,
    payload.scene_style_prompt_zh,
    payload.scene_style_prompt_en,
    payload.prop_style_prompt_zh,
    payload.prop_style_prompt_en,
    payload.video_style_prompt_zh,
    payload.video_style_prompt_en,
    payload.enabled,
    sortOrder,
    now,
    now
  ];
  for (const [field, value] of [['style_family', payload.style_family], ['medium', payload.medium], ['compatibility_tags', JSON.stringify(payload.compatibility_tags)]]) {
    if (columns.has(field)) { fields.push(field); values.push(value); }
  }
  const info = db.prepare(`INSERT INTO generation_styles (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
  return getStyle(db, info.lastInsertRowid);
}

function updateStyle(db, id, body = {}) {
  const columns = ensureClassificationColumns(db);
  const styleId = Number(id);
  const existing = getStyle(db, styleId);
  if (!existing) return null;
  const payload = normalizeStylePayload(body);
  const preview = {
    name: body.name !== undefined ? payload.name : existing.name,
    style_prompt_zh:
      body.style_prompt_zh !== undefined || body.prompt !== undefined || body.style_prompt !== undefined || body.prompt_zh !== undefined
        ? (payload.style_prompt_zh || '')
        : (existing.style_prompt_zh || ''),
    style_prompt_en:
      body.style_prompt_en !== undefined || body.promptEn !== undefined || body.prompt_en !== undefined
        ? (payload.style_prompt_en || '')
        : (existing.style_prompt_en || ''),
  };
  validateRequired(preview);
  const updates = [];
  const params = [];
  const add = (field, value) => {
    updates.push(`${field} = ?`);
    params.push(value);
  };
  if (body.name !== undefined) {
    if (!payload.name) {
      const err = new Error('名称不能为空');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    add('name', payload.name);
  }
  if (body.description !== undefined) add('description', payload.description);
  if (body.style_prompt_zh !== undefined || body.prompt !== undefined || body.style_prompt !== undefined || body.prompt_zh !== undefined) {
    add('style_prompt_zh', payload.style_prompt_zh || null);
  }
  if (body.style_prompt_en !== undefined || body.promptEn !== undefined || body.prompt_en !== undefined) {
    add('style_prompt_en', payload.style_prompt_en || null);
  }
  if (
    body.visual_bible !== undefined ||
    body.visual_bible_text !== undefined ||
    body.visual_bible_struct !== undefined ||
    body.visual_bible_schema !== undefined ||
    body.visual_bible_json !== undefined
  ) {
    add('visual_bible', payload.visual_bible);
    add('visual_bible_struct', payload.visual_bible_struct ? JSON.stringify(payload.visual_bible_struct) : null);
  }
  [
    'character_style_prompt_zh',
    'character_style_prompt_en',
    'scene_style_prompt_zh',
    'scene_style_prompt_en',
    'prop_style_prompt_zh',
    'prop_style_prompt_en',
    'video_style_prompt_zh',
    'video_style_prompt_en',
  ].forEach((field) => {
    if (body[field] !== undefined) add(field, payload[field]);
  });
  if (body.enabled !== undefined) add('enabled', payload.enabled);
  if (body.sort_order !== undefined) add('sort_order', payload.sort_order == null ? 0 : payload.sort_order);
  if (columns.has('style_family') && (body.style_family !== undefined || body.styleFamily !== undefined)) add('style_family', payload.style_family);
  if (columns.has('medium') && body.medium !== undefined) add('medium', payload.medium);
  if (columns.has('compatibility_tags') && (body.compatibility_tags !== undefined || body.compatibilityTags !== undefined)) add('compatibility_tags', JSON.stringify(payload.compatibility_tags));
  if (updates.length > 0) {
    params.push(new Date().toISOString(), styleId);
    db.prepare(`UPDATE generation_styles SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
  }
  return getStyle(db, styleId);
}

function deleteStyle(db, id) {
  const result = db.prepare(
    'UPDATE generation_styles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), new Date().toISOString(), Number(id));
  return result.changes > 0;
}

module.exports = {
  listStyles,
  getStyle,
  createStyle,
  updateStyle,
  deleteStyle,
  normalizeStylePayload,
};
