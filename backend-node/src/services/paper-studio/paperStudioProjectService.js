const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  nowIso,
  parseJson,
  assertExpectedVersion,
} = require('./paperStudioUtils');

function rowToProject(row) {
  if (!row) return null;
  return {
    ...row,
    drama_id: Number(row.drama_id),
    schema_version: Number(row.schema_version || 3),
    config_json: parseJson(row.config_json, {}),
    version: Number(row.version || 1),
  };
}

function getByDrama(db, dramaId) {
  const row = db.prepare(
    'SELECT * FROM paper_studio_projects WHERE drama_id = ? AND deleted_at IS NULL',
  ).get(Number(dramaId));
  return rowToProject(row);
}

function get(db, projectId) {
  const row = db.prepare(
    'SELECT * FROM paper_studio_projects WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(projectId));
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PROJECT_NOT_FOUND',
      '纸片动画工作室项目不存在',
      { project_id: Number(projectId) },
      404,
    );
  }
  return rowToProject(row);
}

function create(db, log, dramaId, body = {}) {
  schemaService.assertValid('apiProjectCreate', body, '创建纸片工作室的参数无效');
  const numericDramaId = Number(dramaId);
  const drama = db.prepare(
    'SELECT id, title FROM dramas WHERE id = ? AND deleted_at IS NULL',
  ).get(numericDramaId);
  if (!drama) {
    throw new PaperStudioError(
      'PAPER_STUDIO_DRAMA_NOT_FOUND',
      '剧集项目不存在',
      { drama_id: numericDramaId },
      404,
    );
  }

  const existing = getByDrama(db, numericDramaId);
  if (existing) return { project: existing, created: false, deduplicated: true };

  const now = nowIso();
  const result = db.prepare(
    `INSERT INTO paper_studio_projects
      (drama_id, schema_version, default_tier, config_json, status, version, created_at, updated_at)
     VALUES (?, 3, ?, ?, 'active', 1, ?, ?)`,
  ).run(
    numericDramaId,
    body.default_tier || 'balanced',
    JSON.stringify(body.config || {}),
    now,
    now,
  );
  const project = get(db, result.lastInsertRowid);
  if (log) log.info('Paper studio project created', { project_id: project.id, drama_id: numericDramaId });
  return { project, created: true, deduplicated: false };
}

function update(db, log, projectId, body = {}) {
  schemaService.assertValid('apiProjectUpdate', body, '更新纸片工作室的参数无效');
  const current = get(db, projectId);
  assertExpectedVersion(current.version, body.expected_version, '纸片工作室项目');

  const fields = [];
  const values = [];
  if (body.default_tier !== undefined) {
    fields.push('default_tier = ?');
    values.push(body.default_tier);
  }
  if (body.status !== undefined) {
    fields.push('status = ?');
    values.push(body.status);
  }
  if (body.config !== undefined) {
    fields.push('config_json = ?');
    values.push(JSON.stringify({ ...current.config_json, ...body.config }));
  }
  fields.push('version = version + 1', 'updated_at = ?');
  values.push(nowIso(), Number(projectId), current.version);
  const result = db.prepare(
    `UPDATE paper_studio_projects SET ${fields.join(', ')}
     WHERE id = ? AND version = ? AND deleted_at IS NULL`,
  ).run(...values);
  if (!result.changes) {
    throw new PaperStudioError(
      'PAPER_STUDIO_VERSION_CONFLICT',
      '纸片工作室项目已被更新，请刷新后重试',
      { project_id: Number(projectId) },
      409,
    );
  }
  const project = get(db, projectId);
  if (log) log.info('Paper studio project updated', { project_id: project.id, version: project.version });
  return project;
}

module.exports = { rowToProject, getByDrama, get, create, update };
