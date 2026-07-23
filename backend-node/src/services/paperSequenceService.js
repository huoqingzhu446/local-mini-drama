const {
  PaperError,
  nowIso,
  parseJson,
  assertExpectedVersion,
  asNumber,
} = require('./paperUtils');

const DEFAULT_CONTINUITY = {
  schema_version: 1,
  entry_anchor: {},
  exit_anchor: {},
  camera_signature: {},
  allowed_delta: { position: 0.04, scale: 0.06, rotation: 8, camera_center: 0.05 },
  transition: { type: 'hard_cut', duration_frames: 0 },
  continuity_break: false,
};

function rowToSequence(row) {
  if (!row) return null;
  return {
    ...row,
    continuity_json: parseJson(row.continuity_json, {}),
    version: Number(row.version || 1),
  };
}

function get(db, id) {
  return rowToSequence(db.prepare('SELECT * FROM paper_sequences WHERE id = ? AND deleted_at IS NULL').get(Number(id)));
}

function list(db, filters = {}) {
  let sql = 'SELECT * FROM paper_sequences WHERE deleted_at IS NULL';
  const params = [];
  if (filters.drama_id != null) { sql += ' AND drama_id = ?'; params.push(Number(filters.drama_id)); }
  if (filters.episode_id != null) { sql += ' AND episode_id = ?'; params.push(Number(filters.episode_id)); }
  if (filters.scene_id != null) { sql += ' AND scene_id = ?'; params.push(Number(filters.scene_id)); }
  sql += ' ORDER BY episode_id, sequence_key, id';
  return db.prepare(sql).all(...params).map(rowToSequence);
}

function create(db, input = {}) {
  const dramaId = Number(input.drama_id);
  const episodeId = Number(input.episode_id);
  const sequenceKey = String(input.sequence_key || '').trim();
  if (!dramaId || !episodeId || !sequenceKey) {
    throw new PaperError('PAPER_INVALID_ARGUMENT', 'drama_id、episode_id、sequence_key 必填');
  }
  const now = nowIso();
  const continuity = { ...DEFAULT_CONTINUITY, ...parseJson(input.continuity_json, {}) };
  try {
    const result = db.prepare(
      `INSERT INTO paper_sequences
       (drama_id, episode_id, scene_id, sequence_key, fps, continuity_json, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      dramaId,
      episodeId,
      input.scene_id == null ? null : Number(input.scene_id),
      sequenceKey,
      Number(input.fps) || 30,
      JSON.stringify(continuity),
      input.status || 'draft',
      now,
      now
    );
    return get(db, result.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new PaperError('PAPER_INVALID_ARGUMENT', '同一集已存在相同 sequence_key');
    }
    throw err;
  }
}

function update(db, id, patch = {}, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '连续镜头合同不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, '连续镜头合同');
  const allowed = ['scene_id', 'fps', 'continuity_json', 'status'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === 'continuity_json') value = JSON.stringify(parseJson(value, {}));
    if (key === 'scene_id') value = value == null ? null : Number(value);
    if (key === 'fps') value = Number(value) || current.fps;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (!fields.length) return current;
  const now = nowIso();
  fields.push('version = version + 1', 'updated_at = ?');
  values.push(now);
  const result = db.prepare(`UPDATE paper_sequences SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`)
    .run(...values, Number(id), current.version);
  if (!result.changes) throw new PaperError('PAPER_VERSION_CONFLICT', '连续镜头合同版本已变化', null, 409);
  const compositionRows = db.prepare('SELECT id FROM paper_compositions WHERE sequence_id = ? AND deleted_at IS NULL').all(Number(id));
  const stale = db.prepare("UPDATE paper_compositions SET status = CASE WHEN status = 'rendering' THEN 'rendering' ELSE 'stale' END, last_validation_json = ?, last_proof_hash = NULL, updated_at = ? WHERE id = ?");
  const removeProofs = db.prepare('DELETE FROM paper_render_proofs WHERE composition_id = ?');
  for (const composition of compositionRows) {
    stale.run(JSON.stringify({ code: 'PAPER_CONTINUITY_STALE', reason: 'sequence continuity changed', sequence_id: Number(id) }), now, composition.id);
    removeProofs.run(composition.id);
  }
  return get(db, id);
}

function softDelete(db, id, expectedVersion) {
  const current = get(db, id);
  if (!current) throw new PaperError('PAPER_NOT_FOUND', '连续镜头合同不存在', { id }, 404);
  assertExpectedVersion(current.version, expectedVersion, '连续镜头合同');
  const refs = db.prepare('SELECT COUNT(*) AS count FROM paper_compositions WHERE sequence_id = ? AND deleted_at IS NULL').get(Number(id));
  if (refs.count > 0) throw new PaperError('PAPER_ASSET_IN_USE', '连续镜头合同仍被合成引用', { sequence_id: id, references: refs.count }, 409);
  db.prepare('UPDATE paper_sequences SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), Number(id));
  return { ok: true };
}

function getOrCreateForStoryboard(db, storyboard) {
  if (!storyboard) return null;
  const sceneId = storyboard.scene_id == null ? null : Number(storyboard.scene_id);
  const key = `scene-${sceneId || 'none'}`;
  const existing = db.prepare(
    'SELECT * FROM paper_sequences WHERE episode_id = ? AND sequence_key = ? AND deleted_at IS NULL'
  ).get(Number(storyboard.episode_id), key);
  if (existing) return rowToSequence(existing);
  try {
    return create(db, {
      drama_id: storyboard.drama_id,
      episode_id: storyboard.episode_id,
      scene_id: sceneId,
      sequence_key: key,
      fps: 30,
      continuity_json: { ...DEFAULT_CONTINUITY, camera_signature: { shot: storyboard.shot_type, movement: storyboard.movement } },
    });
  } catch (err) {
    if (err.code === 'PAPER_INVALID_ARGUMENT' && String(err.message).includes('相同')) {
      return rowToSequence(db.prepare('SELECT * FROM paper_sequences WHERE episode_id = ? AND sequence_key = ? AND deleted_at IS NULL').get(Number(storyboard.episode_id), key));
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_CONTINUITY,
  rowToSequence,
  get,
  list,
  create,
  update,
  softDelete,
  getOrCreateForStoryboard,
};
