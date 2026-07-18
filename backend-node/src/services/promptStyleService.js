function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
  if (value === true || value === 1 || value === '1') return 1;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '启用'].includes(s)) return 1;
  if (['false', 'no', 'off', '0', '停用'].includes(s)) return 0;
  return fallback ? 1 : 0;
}

function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '')
      .split(/[,，、\n]/g);
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = String(item || '').trim().slice(0, 30);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function normalizeIds(ids) {
  if (ids == null || ids === '') return [];
  const arr = Array.isArray(ids) ? ids : String(ids).split(',');
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const n = Number(item);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(Math.floor(n));
  }
  return out;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeCompatibilityTags(input) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' && input.trim().startsWith('[')
      ? parseJson(input, [])
      : String(input || '').split(/[,，、\n]/g));
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .map((item) => String(item || '').trim().slice(0, 40))
    .filter((item) => item && !seen.has(item) && (seen.add(item), true));
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch (_) {
    return new Set();
  }
}

/** 新字段由迁移负责，服务单独在旧/测试库中运行时也能平滑工作。 */
function ensureClassificationColumns(db) {
  const columns = tableColumns(db, 'prompt_styles');
  const wanted = [
    ['role', "TEXT DEFAULT 'constraint'"],
    ['medium', 'TEXT'],
    ['compatibility_tags', 'TEXT'],
    ['priority', 'INTEGER DEFAULT 50'],
  ];
  for (const [name, type] of wanted) {
    if (columns.has(name)) continue;
    try { db.exec(`ALTER TABLE prompt_styles ADD COLUMN ${name} ${type}`); } catch (_) {}
  }
  return tableColumns(db, 'prompt_styles');
}

function tagsForStyleIds(db, styleIds) {
  if (!styleIds.length) return {};
  const placeholders = styleIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT style_id, tag FROM prompt_style_tags
     WHERE style_id IN (${placeholders})
     ORDER BY id ASC`
  ).all(...styleIds);
  const map = {};
  for (const row of rows) {
    if (!map[row.style_id]) map[row.style_id] = [];
    if (row.tag) map[row.style_id].push(row.tag);
  }
  return map;
}

function attachTags(db, rows) {
  const list = rows || [];
  const tagMap = tagsForStyleIds(db, list.map((r) => r.id));
  return list.map((r) => ({
    id: r.id,
    name: r.name || '',
    content: r.content || '',
    description: r.description || '',
    enabled: Number(r.enabled) !== 0,
    sort_order: Number(r.sort_order) || 0,
    role: r.role || 'constraint',
    medium: r.medium || '',
    compatibility_tags: normalizeCompatibilityTags(r.compatibility_tags),
    priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 50,
    tags: tagMap[r.id] || [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function listStyles(db, query = {}) {
  ensureClassificationColumns(db);
  const keyword = String(query.keyword || '').trim();
  const tag = String(query.tag || '').trim();
  const enabled = query.enabled;
  const where = ['ps.deleted_at IS NULL'];
  const params = [];
  if (keyword) {
    where.push(`(
      ps.name LIKE ?
      OR ps.content LIKE ?
      OR ps.description LIKE ?
      OR EXISTS (
        SELECT 1 FROM prompt_style_tags pst
        WHERE pst.style_id = ps.id AND pst.tag LIKE ?
      )
    )`);
    const k = `%${keyword}%`;
    params.push(k, k, k, k);
  }
  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM prompt_style_tags pst
      WHERE pst.style_id = ps.id AND pst.tag = ?
    )`);
    params.push(tag);
  }
  if (enabled !== undefined && enabled !== null && enabled !== '') {
    where.push('ps.enabled = ?');
    params.push(normalizeBool(enabled, true));
  }
  const rows = db.prepare(
    `SELECT ps.* FROM prompt_styles ps
     WHERE ${where.join(' AND ')}
     ORDER BY ps.sort_order ASC, ps.id DESC`
  ).all(...params);
  return attachTags(db, rows);
}

function getStyle(db, id) {
  ensureClassificationColumns(db);
  const row = db.prepare('SELECT * FROM prompt_styles WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  return attachTags(db, [row])[0];
}

function replaceTags(db, styleId, tags) {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM prompt_style_tags WHERE style_id = ?').run(Number(styleId));
  const insert = db.prepare('INSERT INTO prompt_style_tags (style_id, tag, created_at) VALUES (?, ?, ?)');
  for (const tag of normalizeTags(tags)) insert.run(Number(styleId), tag, now);
}

function nextSortOrder(db) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM prompt_styles WHERE deleted_at IS NULL'
  ).get();
  return Number(row?.next_order) || 10;
}

function createStyle(db, body = {}) {
  const columns = ensureClassificationColumns(db);
  const name = String(body.name || '').trim();
  const content = String(body.content || '').trim();
  if (!name) {
    const err = new Error('名称不能为空');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (!content) {
    const err = new Error('提示词内容不能为空');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const now = new Date().toISOString();
  const sortOrder = body.sort_order !== undefined && body.sort_order !== null
    ? Number(body.sort_order) || 0
    : nextSortOrder(db);
  const tx = db.transaction(() => {
    const fields = ['name', 'content', 'description', 'enabled', 'sort_order', 'created_at', 'updated_at'];
    const values = [
      name,
      content,
      body.description != null ? String(body.description).trim() : null,
      normalizeBool(body.enabled, true),
      sortOrder,
      now,
      now,
    ];
    if (columns.has('role')) { fields.push('role'); values.push(String(body.role || 'constraint').trim() || 'constraint'); }
    if (columns.has('medium')) { fields.push('medium'); values.push(String(body.medium || '').trim() || null); }
    if (columns.has('compatibility_tags')) { fields.push('compatibility_tags'); values.push(JSON.stringify(normalizeCompatibilityTags(body.compatibility_tags || body.compatibilityTags))); }
    if (columns.has('priority')) { fields.push('priority'); values.push(Number.isFinite(Number(body.priority)) ? Number(body.priority) : 50); }
    const info = db.prepare(
      `INSERT INTO prompt_styles (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`
    ).run(...values);
    replaceTags(db, info.lastInsertRowid, body.tags);
    return info.lastInsertRowid;
  });
  return getStyle(db, tx());
}

function updateStyle(db, id, body = {}) {
  const columns = ensureClassificationColumns(db);
  const styleId = Number(id);
  const existing = getStyle(db, styleId);
  if (!existing) return null;
  const updates = [];
  const params = [];
  const add = (key, value) => {
    updates.push(`${key} = ?`);
    params.push(value);
  };
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      const err = new Error('名称不能为空');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    add('name', name);
  }
  if (body.content !== undefined) {
    const content = String(body.content || '').trim();
    if (!content) {
      const err = new Error('提示词内容不能为空');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    add('content', content);
  }
  if (body.description !== undefined) add('description', String(body.description || '').trim() || null);
  if (body.enabled !== undefined) add('enabled', normalizeBool(body.enabled, true));
  if (body.sort_order !== undefined) add('sort_order', Number(body.sort_order) || 0);
  if (columns.has('role') && body.role !== undefined) add('role', String(body.role || 'constraint').trim() || 'constraint');
  if (columns.has('medium') && body.medium !== undefined) add('medium', String(body.medium || '').trim() || null);
  if (columns.has('compatibility_tags') && (body.compatibility_tags !== undefined || body.compatibilityTags !== undefined)) {
    add('compatibility_tags', JSON.stringify(normalizeCompatibilityTags(body.compatibility_tags || body.compatibilityTags)));
  }
  if (columns.has('priority') && body.priority !== undefined) add('priority', Number.isFinite(Number(body.priority)) ? Number(body.priority) : 50);
  const tx = db.transaction(() => {
    if (updates.length > 0) {
      params.push(new Date().toISOString(), styleId);
      db.prepare(`UPDATE prompt_styles SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
    }
    if (body.tags !== undefined) replaceTags(db, styleId, body.tags);
  });
  tx();
  return getStyle(db, styleId);
}

function deleteStyle(db, id) {
  const styleId = Number(id);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const result = db.prepare(
      'UPDATE prompt_styles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
    ).run(now, now, styleId);
    if (result.changes > 0) {
      db.prepare('DELETE FROM prompt_style_tags WHERE style_id = ?').run(styleId);
    }
    return result.changes > 0;
  });
  return tx();
}

function listTags(db) {
  return db.prepare(
    `SELECT DISTINCT pst.tag AS tag
     FROM prompt_style_tags pst
     INNER JOIN prompt_styles ps ON ps.id = pst.style_id
     WHERE ps.deleted_at IS NULL AND pst.tag IS NOT NULL AND TRIM(pst.tag) != ''
     ORDER BY pst.tag ASC`
  ).all().map((r) => r.tag);
}

function getEnabledStylesByIds(db, ids) {
  ensureClassificationColumns(db);
  const normalized = normalizeIds(ids);
  if (!normalized.length) return [];
  const placeholders = normalized.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM prompt_styles
     WHERE deleted_at IS NULL AND enabled = 1 AND id IN (${placeholders})`
  ).all(...normalized);
  const byId = new Map(attachTags(db, rows).map((style) => [Number(style.id), style]));
  return normalized.map((id) => byId.get(id)).filter(Boolean);
}

function buildPromptStyleConstraintBlock(db, ids, options = {}) {
  const styles = getEnabledStylesByIds(db, ids);
  if (!styles.length) return '';
  const heading = options.heading || '【用户选择的提示词风格约束】';
  const lines = [heading, '以下约束由用户在「提示词风格」中选择，必须融入本次生成；可作为画面/场景提示词的扩展或限制，不要在输出中解释这些规则。'];
  styles.forEach((style, idx) => {
    const tags = style.tags && style.tags.length ? `（标签：${style.tags.join('、')}）` : '';
    lines.push(`${idx + 1}. ${style.name}${tags}`);
    lines.push(String(style.content || '').trim());
  });
  return lines.join('\n');
}

module.exports = {
  normalizeTags,
  normalizeIds,
  listStyles,
  getStyle,
  createStyle,
  updateStyle,
  deleteStyle,
  listTags,
  getEnabledStylesByIds,
  buildPromptStyleConstraintBlock,
  normalizeCompatibilityTags,
  ensureClassificationColumns,
};
