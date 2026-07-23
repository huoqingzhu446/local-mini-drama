const {
  PaperError,
  nowIso,
  parseJson,
  assertExpectedVersion,
  PAPER_MAX_RIG_PARTS,
} = require('./paperUtils');

function rowToRig(row) {
  if (!row) return null;
  return {
    ...row,
    parts: parseJson(row.parts_json, []),
    version: Number(row.version || 1),
  };
}

function get(db, id) {
  return rowToRig(db.prepare('SELECT * FROM paper_rigs WHERE id = ? AND deleted_at IS NULL').get(Number(id)));
}

function list(db, filters = {}) {
  let sql = 'SELECT * FROM paper_rigs WHERE deleted_at IS NULL';
  const params = [];
  if (filters.drama_id != null) { sql += ' AND drama_id = ?'; params.push(Number(filters.drama_id)); }
  if (filters.subject_type) { sql += ' AND subject_type = ?'; params.push(String(filters.subject_type)); }
  if (filters.subject_id != null) { sql += ' AND subject_id = ?'; params.push(Number(filters.subject_id)); }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params).map(rowToRig);
}

function validateParts(parts, rootPartKey) {
  if (!Array.isArray(parts) || !parts.length) {
    throw new PaperError('PAPER_SCHEMA_INVALID', 'rig 至少需要一个部件', { path: 'parts' }, 422);
  }
  if (parts.length > PAPER_MAX_RIG_PARTS) {
    throw new PaperError('PAPER_LIMIT_EXCEEDED', `rig 部件不能超过 ${PAPER_MAX_RIG_PARTS} 个`, { path: 'parts' }, 413);
  }
  const keys = new Set();
  for (const part of parts) {
    if (!part || !String(part.key || '').trim()) throw new PaperError('PAPER_SCHEMA_INVALID', 'rig 部件缺少 key', { path: 'parts' }, 422);
    const key = String(part.key).trim();
    if (keys.has(key)) throw new PaperError('PAPER_SCHEMA_INVALID', `rig 部件 key 重复: ${key}`, { path: `parts.${key}` }, 422);
    keys.add(key);
    if (part.parent != null && !String(part.parent).trim()) part.parent = null;
    const pivot = part.pivot || [0.5, 0.5];
    if (!Array.isArray(pivot) || pivot.length !== 2 || pivot.some((n) => !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 1)) {
      throw new PaperError('PAPER_SCHEMA_INVALID', `rig 部件 pivot 越界: ${key}`, { path: `parts.${key}.pivot` }, 422);
    }
    part.pivot = [Number(pivot[0]), Number(pivot[1])];
    if (part.initial_transform && typeof part.initial_transform !== 'object') {
      throw new PaperError('PAPER_SCHEMA_INVALID', `rig 部件 initial_transform 非法: ${key}`, { path: `parts.${key}.initial_transform` }, 422);
    }
  }
  const roots = parts.filter((part) => part.parent == null);
  if (roots.length !== 1 || roots[0].key !== rootPartKey) {
    throw new PaperError('PAPER_RIG_ROOT_INVALID', 'rig 必须且只能有一个 root_part_key', { roots: roots.map((p) => p.key), root_part_key: rootPartKey }, 422);
  }
  for (const part of parts) {
    if (part.parent != null && !keys.has(String(part.parent))) {
      throw new PaperError('PAPER_RIG_PARENT_MISSING', `rig 父部件不存在: ${part.parent}`, { path: `parts.${part.key}.parent` }, 422);
    }
    const seen = new Set([part.key]);
    let cursor = part.parent;
    while (cursor != null) {
      if (seen.has(cursor)) throw new PaperError('PAPER_RIG_CYCLE', `rig 部件存在循环: ${part.key}`, { path: `parts.${part.key}` }, 422);
      seen.add(cursor);
      const parent = parts.find((item) => item.key === cursor);
      cursor = parent ? parent.parent : null;
    }
  }
  return parts;
}

function create(db, input = {}) {
  const dramaId = Number(input.drama_id);
  const subjectType = String(input.subject_type || '').trim();
  const subjectId = Number(input.subject_id);
  const rigKey = String(input.rig_key || '').trim();
  const root = String(input.root_part_key || '').trim();
  if (!dramaId || !subjectType || !subjectId || !rigKey || !root) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', 'drama_id、subject_type、subject_id、rig_key、root_part_key 必填');
  }
  const parts = validateParts(parseJson(input.parts_json ?? input.parts, []), root);
  const existing = db.prepare('SELECT * FROM paper_rigs WHERE subject_type = ? AND subject_id = ? AND rig_key = ?').get(subjectType, subjectId, rigKey);
  const now = nowIso();
  if (existing && !existing.deleted_at) return rowToRig(existing);
  if (existing) {
    db.prepare('UPDATE paper_rigs SET deleted_at = NULL, parts_json = ?, root_part_key = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(parts), root, input.status || 'draft', now, existing.id);
    return get(db, existing.id);
  }
  const result = db.prepare(
    `INSERT INTO paper_rigs
      (drama_id, subject_type, subject_id, rig_key, schema_version, root_part_key, parts_json, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(dramaId, subjectType, subjectId, rigKey, Number(input.schema_version) || 1, root, JSON.stringify(parts), input.status || 'draft', now, now);
  return get(db, result.lastInsertRowid);
}

function update(db, id, patch = {}, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', 'rig 不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, 'rig');
  const fields = [];
  const values = [];
  if ('root_part_key' in patch || 'parts' in patch || 'parts_json' in patch) {
    const root = String(patch.root_part_key || current.root_part_key);
    const parts = validateParts(parseJson(patch.parts_json ?? patch.parts, current.parts), root);
    fields.push('root_part_key = ?', 'parts_json = ?'); values.push(root, JSON.stringify(parts));
  }
  for (const key of ['status', 'schema_version']) {
    if (!(key in patch)) continue;
    fields.push(`${key} = ?`); values.push(key === 'schema_version' ? Number(patch[key]) || current.schema_version : patch[key]);
  }
  if (!fields.length) return current;
  fields.push('version = version + 1', 'updated_at = ?'); values.push(nowIso());
  const result = db.prepare(`UPDATE paper_rigs SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`)
    .run(...values, Number(id), current.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', 'rig 版本已变化', null, 409);
  markReferencingCompositionsStale(db, id, 'rig hierarchy, pivot or status changed');
  return get(db, id);
}

function markReferencingCompositionsStale(db, rigId, reason = 'rig changed') {
  const rows = db.prepare('SELECT DISTINCT composition_id FROM paper_layers WHERE rig_id = ? AND deleted_at IS NULL').all(Number(rigId));
  const now = nowIso();
  const update = db.prepare("UPDATE paper_compositions SET status = CASE WHEN status = 'rendering' THEN 'rendering' ELSE 'stale' END, last_validation_json = ?, last_proof_hash = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL");
  const removeProofs = db.prepare('DELETE FROM paper_render_proofs WHERE composition_id = ?');
  const payload = JSON.stringify({ code: 'PAPER_RIG_STALE', reason, rig_id: Number(rigId) });
  for (const row of rows) { update.run(payload, now, Number(row.composition_id)); removeProofs.run(Number(row.composition_id)); }
  return rows.map((row) => Number(row.composition_id));
}

function softDelete(db, id, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', 'rig 不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, 'rig');
  const refs = db.prepare('SELECT COUNT(*) AS count FROM paper_layers WHERE rig_id = ? AND deleted_at IS NULL').get(Number(id));
  if (refs.count) throw new PaperError('PAPER_ASSET_IN_USE', 'rig 仍被图层引用', { rig_id: id, references: refs.count }, 409);
  db.prepare('UPDATE paper_rigs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), Number(id));
  return { ok: true };
}

module.exports = { rowToRig, get, list, validateParts, create, update, softDelete, markReferencingCompositionsStale };
