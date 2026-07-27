// P2：纸片项目级实体库（人物/场景/道具）与风格锚。
// 形象版本（identity versions）的生成与审核在 P3 接入；本服务先提供实体 CRUD 与候选确认。
const projectService = require('./paperStudioProjectService');
const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const ENTITY_TYPES = ['character', 'scene', 'prop'];

function rowToEntity(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    entity_type: row.entity_type,
    name: row.name,
    aliases: parseJson(row.aliases_json, []),
    description: row.description || '',
    canonical_prompt: row.canonical_prompt || '',
    scale_anchor: parseJson(row.scale_anchor_json, {}),
    current_identity_version_id: row.current_identity_version_id == null ? null : Number(row.current_identity_version_id),
    identity_status: row.identity_status || (row.current_identity_version_id ? 'approved' : 'none'),
    identity_version_number: row.identity_version_number == null ? null : Number(row.identity_version_number),
    identity_source_local_path: row.identity_source_local_path || null,
    identity_alpha_local_path: row.identity_alpha_local_path || null,
    latest_version: row.latest_version_id ? {
      id: Number(row.latest_version_id),
      version_number: Number(row.latest_version_number || 0),
      status: row.latest_version_status,
      source_local_path: row.latest_source_local_path || null,
      alpha_local_path: row.latest_alpha_local_path || null,
    } : null,
    reference_count: Number(row.reference_count || 0),
    status: row.status,
    version: Number(row.version || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getEntity(db, entityId) {
  const row = db.prepare('SELECT * FROM paper_library_entities WHERE id = ? AND deleted_at IS NULL').get(Number(entityId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_NOT_FOUND', '实体不存在', { entity_id: Number(entityId) }, 404);
  return rowToEntity(row);
}

function listEntities(db, projectId, { includeArchived = false } = {}) {
  const statusFilter = includeArchived ? '' : " AND ple.status != 'archived'";
  return db.prepare(
    `SELECT ple.*,
            iv.status AS identity_status,
            iv.version_number AS identity_version_number,
            iv.source_local_path AS identity_source_local_path,
            iv.alpha_local_path AS identity_alpha_local_path,
            (SELECT COUNT(*) FROM paper_storyboard_entity_links link WHERE link.entity_id = ple.id) AS reference_count,
            (SELECT iv2.id FROM paper_library_identity_versions iv2 WHERE iv2.entity_id = ple.id ORDER BY iv2.id DESC LIMIT 1) AS latest_version_id,
            (SELECT iv2.version_number FROM paper_library_identity_versions iv2 WHERE iv2.entity_id = ple.id ORDER BY iv2.id DESC LIMIT 1) AS latest_version_number,
            (SELECT iv2.status FROM paper_library_identity_versions iv2 WHERE iv2.entity_id = ple.id ORDER BY iv2.id DESC LIMIT 1) AS latest_version_status,
            (SELECT iv2.source_local_path FROM paper_library_identity_versions iv2 WHERE iv2.entity_id = ple.id ORDER BY iv2.id DESC LIMIT 1) AS latest_source_local_path,
            (SELECT iv2.alpha_local_path FROM paper_library_identity_versions iv2 WHERE iv2.entity_id = ple.id ORDER BY iv2.id DESC LIMIT 1) AS latest_alpha_local_path
     FROM paper_library_entities ple
     LEFT JOIN paper_library_identity_versions iv ON iv.id = ple.current_identity_version_id
     WHERE ple.project_id = ? AND ple.deleted_at IS NULL${statusFilter}
     ORDER BY CASE ple.entity_type WHEN 'character' THEN 0 WHEN 'scene' THEN 1 ELSE 2 END, ple.name, ple.id`,
  ).all(Number(projectId)).map(rowToEntity);
}

function library(db, projectId, options = {}) {
  projectService.get(db, projectId);
  const entities = listEntities(db, projectId, options);
  return {
    entities,
    counts: {
      character: entities.filter((item) => item.entity_type === 'character').length,
      scene: entities.filter((item) => item.entity_type === 'scene').length,
      prop: entities.filter((item) => item.entity_type === 'prop').length,
    },
    style_anchor: getStyleAnchor(db, projectId),
  };
}

function insertEntity(db, projectId, item, now) {
  const scaleAnchor = {};
  if (item.relative_height != null) scaleAnchor.relative_height = Number(item.relative_height);
  const result = db.prepare(
    `INSERT INTO paper_library_entities
       (project_id, entity_type, name, aliases_json, description, canonical_prompt, scale_anchor_json,
        extraction_meta_json, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, 'confirmed', 1, ?, ?)`,
  ).run(
    Number(projectId),
    item.entity_type,
    item.name,
    JSON.stringify(item.aliases || []),
    item.description || '',
    JSON.stringify(scaleAnchor),
    JSON.stringify(item.extraction_meta || {}),
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

function mergeIntoEntity(db, target, item, now) {
  const aliases = new Set(target.aliases || []);
  if (normalize(item.name) !== normalize(target.name)) aliases.add(item.name);
  for (const alias of item.aliases || []) {
    if (normalize(alias) !== normalize(target.name)) aliases.add(alias);
  }
  const candidateDescription = String(item.description || '');
  const description = candidateDescription.length > String(target.description || '').length ? candidateDescription : (target.description || '');
  db.prepare(
    'UPDATE paper_library_entities SET aliases_json = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify([...aliases].slice(0, 16)), description, now, target.id);
}

function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function confirm(db, log, projectId, body = {}) {
  schemaService.assertValid('apiPaperLibraryConfirm', body, '确认实体候选的参数无效');
  const project = projectService.get(db, projectId);
  if (project.status !== 'active') throw new PaperStudioError('PAPER_STUDIO_PROJECT_INACTIVE', '纸片工作室项目已归档', { project_id: project.id }, 409);
  const now = nowIso();
  const summary = { created: [], merged: [], ignored: 0, conflicts: [] };

  const transaction = db.transaction(() => {
    for (const item of body.items) {
      if (item.action === 'ignore') {
        summary.ignored += 1;
        continue;
      }
      if (item.action === 'merge') {
        if (!item.merge_into_id) throw new PaperStudioError('PAPER_STUDIO_LIBRARY_MERGE_TARGET_MISSING', `候选「${item.name}」选择了合并但缺少合并目标`, { name: item.name }, 400);
        const target = getEntity(db, item.merge_into_id);
        if (target.project_id !== project.id || target.entity_type !== item.entity_type) {
          throw new PaperStudioError('PAPER_STUDIO_LIBRARY_MERGE_MISMATCH', '合并目标不属于当前项目或类型不一致', { entity_id: target.id, entity_type: item.entity_type }, 409);
        }
        mergeIntoEntity(db, target, item, now);
        summary.merged.push({ entity_id: target.id, name: target.name });
        continue;
      }
      // action === 'new'
      const duplicate = db.prepare(
        'SELECT id, name FROM paper_library_entities WHERE project_id = ? AND entity_type = ? AND name = ? AND deleted_at IS NULL',
      ).get(project.id, item.entity_type, item.name);
      if (duplicate) {
        const target = getEntity(db, duplicate.id);
        mergeIntoEntity(db, target, item, now);
        summary.conflicts.push({ entity_id: target.id, name: target.name, resolved: 'merged' });
        continue;
      }
      const id = insertEntity(db, project.id, item, now);
      summary.created.push({ entity_id: id, name: item.name });
    }
  });
  transaction();

  if (log) log.info('Paper studio library confirm applied', { project_id: project.id, created: summary.created.length, merged: summary.merged.length, ignored: summary.ignored });
  return { summary, library: library(db, project.id) };
}

function updateEntity(db, log, entityId, body = {}) {
  schemaService.assertValid('apiPaperEntityUpdate', body, '更新实体的参数无效');
  const current = getEntity(db, entityId);
  assertExpectedVersion(current.version, body.expected_version, '实体');
  const now = nowIso();
  const fields = [];
  const values = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_NAME_EMPTY', '实体名称不能为空', {}, 400);
    const duplicate = db.prepare(
      'SELECT id FROM paper_library_entities WHERE project_id = ? AND entity_type = ? AND name = ? AND id != ? AND deleted_at IS NULL',
    ).get(current.project_id, current.entity_type, name, current.id);
    if (duplicate) throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_NAME_CONFLICT', '同类型下已有同名实体', { name }, 409);
    fields.push('name = ?');
    values.push(name);
  }
  if (body.description !== undefined) { fields.push('description = ?'); values.push(String(body.description)); }
  if (body.aliases !== undefined) { fields.push('aliases_json = ?'); values.push(JSON.stringify(body.aliases.slice(0, 16))); }
  if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
  if (body.relative_height !== undefined) {
    const anchor = { ...current.scale_anchor };
    if (body.relative_height == null) delete anchor.relative_height;
    else anchor.relative_height = Number(body.relative_height);
    fields.push('scale_anchor_json = ?');
    values.push(JSON.stringify(anchor));
  }
  if (!fields.length) return getEntity(db, entityId);
  fields.push('version = version + 1', 'updated_at = ?');
  values.push(now, current.id, current.version);
  const result = db.prepare(
    `UPDATE paper_library_entities SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`,
  ).run(...values);
  if (!result.changes) throw new PaperStudioError('PAPER_STUDIO_VERSION_CONFLICT', '实体已被更新，请刷新后重试', { entity_id: current.id }, 409);
  const entity = getEntity(db, entityId);
  if (log) log.info('Paper studio library entity updated', { entity_id: entity.id, version: entity.version });
  return entity;
}

function getStyleAnchor(db, projectId) {
  const row = db.prepare(
    'SELECT * FROM paper_style_anchors WHERE project_id = ? AND active = 1 ORDER BY id DESC LIMIT 1',
  ).get(Number(projectId));
  if (!row) return null;
  return { id: Number(row.id), anchor_text: row.anchor_text, anchor_hash: row.anchor_hash, created_at: row.created_at };
}

function setStyleAnchor(db, log, projectId, body = {}) {
  schemaService.assertValid('apiPaperStyleAnchor', body, '设置风格锚的参数无效');
  const project = projectService.get(db, projectId);
  const text = String(body.anchor_text || '').trim();
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE paper_style_anchors SET active = 0 WHERE project_id = ? AND active = 1').run(project.id);
    if (text) {
      db.prepare(
        'INSERT INTO paper_style_anchors (project_id, anchor_text, anchor_hash, active, created_at) VALUES (?, ?, ?, 1, ?)',
      ).run(project.id, text, sha256(text), now);
    }
  });
  transaction();
  if (log) log.info('Paper studio style anchor set', { project_id: project.id, has_text: Boolean(text) });
  return { style_anchor: getStyleAnchor(db, project.id) };
}

module.exports = {
  ENTITY_TYPES,
  rowToEntity,
  getEntity,
  listEntities,
  library,
  confirm,
  updateEntity,
  getStyleAnchor,
  setStyleAnchor,
};
