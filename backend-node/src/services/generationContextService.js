'use strict';

const crypto = require('crypto');

const COMPILER_VERSION = 'v2';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

function hashValue(value, length = 20) {
  const source = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return crypto.createHash('sha256').update(source || '').digest('hex').slice(0, length);
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
  catch (_) { return new Set(); }
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS generation_context_snapshots (
    id TEXT PRIMARY KEY,
    drama_id INTEGER,
    episode_id INTEGER,
    scene_id INTEGER,
    storyboard_id INTEGER,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    frame_type TEXT,
    style_version_id INTEGER,
    style_signature TEXT NOT NULL,
    prompt_source TEXT,
    source_prompt TEXT,
    compiled_prompt TEXT NOT NULL,
    compiled_negative_prompt TEXT,
    reference_pack TEXT,
    source_snapshot TEXT,
    prompt_hash TEXT NOT NULL,
    reference_hash TEXT,
    compiler_version TEXT NOT NULL DEFAULT 'v2',
    diagnostics TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_generation_context_entity ON generation_context_snapshots(entity_type, entity_id, frame_type, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_generation_context_drama ON generation_context_snapshots(drama_id, style_version_id, created_at)');
}

function makeId() {
  return `gctx_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function rowToSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    drama_id: row.drama_id == null ? null : Number(row.drama_id),
    episode_id: row.episode_id == null ? null : Number(row.episode_id),
    scene_id: row.scene_id == null ? null : Number(row.scene_id),
    storyboard_id: row.storyboard_id == null ? null : Number(row.storyboard_id),
    entity_type: row.entity_type,
    entity_id: Number(row.entity_id),
    frame_type: row.frame_type || 'main',
    style_version_id: row.style_version_id == null ? null : Number(row.style_version_id),
    style_signature: row.style_signature || '',
    prompt_source: row.prompt_source || '',
    source_prompt: row.source_prompt || '',
    compiled_prompt: row.compiled_prompt || '',
    compiled_negative_prompt: row.compiled_negative_prompt || '',
    reference_pack: parseJson(row.reference_pack, null),
    source_snapshot: parseJson(row.source_snapshot, null),
    prompt_hash: row.prompt_hash || '',
    reference_hash: row.reference_hash || '',
    compiler_version: row.compiler_version || COMPILER_VERSION,
    diagnostics: parseJson(row.diagnostics, []),
    created_at: row.created_at,
  };
}

function normalizeContext(context = {}) {
  const compiledPrompt = String(context.compiled_prompt ?? context.prompt ?? '').trim();
  if (!compiledPrompt) {
    const error = new Error('compiled_prompt is required');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const entityId = Number(context.entity_id);
  if (!context.entity_type || !Number.isFinite(entityId) || entityId <= 0) {
    const error = new Error('entity_type and entity_id are required');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const referencePack = context.reference_pack ?? context.references ?? null;
  const promptHash = context.prompt_hash || hashValue(compiledPrompt);
  const referenceHash = context.reference_hash || (referencePack ? hashValue(referencePack) : '');
  return {
    drama_id: context.drama_id == null ? null : Number(context.drama_id),
    episode_id: context.episode_id == null ? null : Number(context.episode_id),
    scene_id: context.scene_id == null ? null : Number(context.scene_id),
    storyboard_id: context.storyboard_id == null ? null : Number(context.storyboard_id),
    entity_type: String(context.entity_type),
    entity_id: entityId,
    frame_type: context.frame_type || 'main',
    style_version_id: context.style_version_id == null ? null : Number(context.style_version_id),
    style_signature: String(context.style_signature || '').trim(),
    prompt_source: String(context.prompt_source || '').trim(),
    source_prompt: context.source_prompt == null ? '' : String(context.source_prompt),
    compiled_prompt: compiledPrompt,
    compiled_negative_prompt: context.compiled_negative_prompt == null ? '' : String(context.compiled_negative_prompt),
    reference_pack: referencePack,
    source_snapshot: context.source_snapshot ?? null,
    prompt_hash: String(promptHash),
    reference_hash: String(referenceHash || ''),
    compiler_version: String(context.compiler_version || COMPILER_VERSION),
    diagnostics: context.diagnostics ?? [],
  };
}

function createSnapshot(db, context = {}) {
  ensureSchema(db);
  const normalized = normalizeContext(context);
  const id = context.id || makeId();
  const createdAt = context.created_at || new Date().toISOString();
  db.prepare(`INSERT INTO generation_context_snapshots (
    id, drama_id, episode_id, scene_id, storyboard_id, entity_type, entity_id, frame_type,
    style_version_id, style_signature, prompt_source, source_prompt, compiled_prompt,
    compiled_negative_prompt, reference_pack, source_snapshot, prompt_hash, reference_hash,
    compiler_version, diagnostics, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, normalized.drama_id, normalized.episode_id, normalized.scene_id, normalized.storyboard_id,
      normalized.entity_type, normalized.entity_id, normalized.frame_type, normalized.style_version_id,
      normalized.style_signature, normalized.prompt_source || null, normalized.source_prompt || null,
      normalized.compiled_prompt, normalized.compiled_negative_prompt || null,
      normalized.reference_pack == null ? null : JSON.stringify(normalized.reference_pack),
      normalized.source_snapshot == null ? null : JSON.stringify(normalized.source_snapshot),
      normalized.prompt_hash, normalized.reference_hash || null, normalized.compiler_version,
      JSON.stringify(normalized.diagnostics || []), createdAt
    );
  return getSnapshot(db, id);
}

function getSnapshot(db, id) {
  ensureSchema(db);
  return rowToSnapshot(db.prepare('SELECT * FROM generation_context_snapshots WHERE id = ?').get(String(id)));
}

function listSnapshots(db, query = {}) {
  ensureSchema(db);
  const where = ['1 = 1'];
  const params = [];
  if (query.entity_type) { where.push('entity_type = ?'); params.push(String(query.entity_type)); }
  if (query.entity_id != null) { where.push('entity_id = ?'); params.push(Number(query.entity_id)); }
  if (query.drama_id != null) { where.push('drama_id = ?'); params.push(Number(query.drama_id)); }
  if (query.style_version_id != null) { where.push('style_version_id = ?'); params.push(Number(query.style_version_id)); }
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const rows = db.prepare(`SELECT * FROM generation_context_snapshots WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  return rows.map(rowToSnapshot);
}

function latestSnapshot(db, entityType, entityId, frameType) {
  ensureSchema(db);
  const row = db.prepare(`SELECT * FROM generation_context_snapshots
    WHERE entity_type = ? AND entity_id = ? AND COALESCE(frame_type, 'main') = ?
    ORDER BY created_at DESC LIMIT 1`).get(String(entityType), Number(entityId), frameType || 'main');
  return rowToSnapshot(row);
}

/** 标记业务实体已有一份按 V2 编译的快照；不覆盖历史 prompt 文本。 */
function markEntityCompiled(db, context = {}) {
  const type = String(context.entity_type || '').trim();
  const id = Number(context.entity_id);
  if (!type || !Number.isFinite(id) || id <= 0) return false;
  const table = type === 'scene' ? 'scenes' : type === 'storyboard' ? 'storyboards' : type === 'character' ? 'characters' : type === 'prop' ? 'props' : null;
  if (!table) return false;
  const columns = tableColumns(db, table);
  if (!columns.has('prompt_state')) return false;
  const set = ['prompt_state = ?'];
  const params = ['compiled_v2'];
  if (columns.has('updated_at')) { set.push('updated_at = ?'); params.push(new Date().toISOString()); }
  params.push(id);
  const result = db.prepare(`UPDATE ${table} SET ${set.join(', ')} WHERE id = ? AND${columns.has('deleted_at') ? ' deleted_at IS NULL AND' : ''} 1 = 1`).run(...params);
  return result.changes > 0;
}

module.exports = {
  COMPILER_VERSION,
  parseJson,
  canonicalize,
  hashValue,
  tableColumns,
  ensureSchema,
  normalizeContext,
  createSnapshot,
  getSnapshot,
  listSnapshots,
  latestSnapshot,
  markEntityCompiled,
};
