const projectService = require('./paperStudioProjectService');
const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
} = require('./paperStudioUtils');

function rowToEpisode(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    project_id: Number(row.project_id),
    episode_number: Number(row.episode_number),
    fps: Number(row.fps || 30),
    default_duration: Number(row.default_duration || 6),
    version: Number(row.version || 1),
    storyboard_count: Number(row.storyboard_count || 0),
    published_storyboard_count: Number(row.published_storyboard_count || 0),
  };
}

function get(db, episodeId) {
  const row = db.prepare(
    `SELECT pe.*,
            COUNT(ps.id) AS storyboard_count,
            SUM(CASE WHEN ps.published_video_generation_id IS NOT NULL THEN 1 ELSE 0 END) AS published_storyboard_count
     FROM paper_studio_episodes pe
     LEFT JOIN paper_storyboards ps ON ps.paper_episode_id = pe.id AND ps.deleted_at IS NULL
     WHERE pe.id = ? AND pe.deleted_at IS NULL
     GROUP BY pe.id`,
  ).get(Number(episodeId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_EPISODE_NOT_FOUND', '纸片分集不存在', { paper_episode_id: Number(episodeId) }, 404);
  return rowToEpisode(row);
}

function list(db, projectId) {
  projectService.get(db, projectId);
  return db.prepare(
    `SELECT pe.*,
            COUNT(ps.id) AS storyboard_count,
            SUM(CASE WHEN ps.published_video_generation_id IS NOT NULL THEN 1 ELSE 0 END) AS published_storyboard_count
     FROM paper_studio_episodes pe
     LEFT JOIN paper_storyboards ps ON ps.paper_episode_id = pe.id AND ps.deleted_at IS NULL
     WHERE pe.project_id = ? AND pe.deleted_at IS NULL
     GROUP BY pe.id
     ORDER BY pe.episode_number, pe.id`,
  ).all(Number(projectId)).map(rowToEpisode);
}

function create(db, log, projectId, body = {}) {
  schemaService.assertValid('apiPaperEpisodeCreate', body, '创建纸片分集的参数无效');
  const project = projectService.get(db, projectId);
  if (project.status !== 'active') throw new PaperStudioError('PAPER_STUDIO_PROJECT_INACTIVE', '纸片工作室项目已归档', { project_id: project.id }, 409);
  const existing = db.prepare('SELECT id FROM paper_studio_episodes WHERE project_id = ? AND request_id = ? AND deleted_at IS NULL').get(project.id, body.request_id);
  if (existing) return { episode: get(db, existing.id), created: false, deduplicated: true };
  const number = body.episode_number == null
    ? Number(db.prepare('SELECT COALESCE(MAX(episode_number), 0) + 1 AS next_number FROM paper_studio_episodes WHERE project_id = ? AND deleted_at IS NULL').get(project.id).next_number)
    : Number(body.episode_number);
  const now = nowIso();
  let result;
  try {
    result = db.prepare(
      `INSERT INTO paper_studio_episodes
        (project_id, request_id, episode_number, title, description, aspect_ratio, fps,
         default_duration, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
    ).run(
      project.id,
      body.request_id,
      number,
      body.title.trim(),
      body.description || '',
      body.aspect_ratio || '16:9',
      Number(body.fps || project.config_json?.fps || 30),
      Number(body.default_duration || 6),
      now,
      now,
    );
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new PaperStudioError('PAPER_STUDIO_EPISODE_NUMBER_CONFLICT', '纸片分集序号已存在', { project_id: project.id, episode_number: number }, 409);
    throw error;
  }
  const episode = get(db, result.lastInsertRowid);
  if (log) log.info('Paper studio episode created', { paper_episode_id: episode.id, project_id: project.id });
  return { episode, created: true, deduplicated: false };
}

function update(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperEpisodeUpdate', body, '更新纸片分集的参数无效');
  const current = get(db, episodeId);
  assertExpectedVersion(current.version, body.expected_version, '纸片分集');
  const fields = [];
  const values = [];
  for (const key of ['title', 'description', 'aspect_ratio', 'fps', 'default_duration', 'status']) {
    if (body[key] === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(key === 'fps' ? Number(body[key]) : key === 'default_duration' ? Number(body[key]) : body[key]);
  }
  const now = nowIso();
  fields.push('version = version + 1', 'updated_at = ?');
  values.push(now, Number(episodeId), current.version);
  const result = db.prepare(`UPDATE paper_studio_episodes SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`).run(...values);
  if (!result.changes) throw new PaperStudioError('PAPER_STUDIO_VERSION_CONFLICT', '纸片分集已被更新，请刷新后重试', { paper_episode_id: Number(episodeId) }, 409);
  const episode = get(db, episodeId);
  if (log) log.info('Paper studio episode updated', { paper_episode_id: episode.id, version: episode.version });
  return episode;
}

function remove(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiShotAction', body, '删除纸片分集的参数无效');
  const current = get(db, episodeId);
  assertExpectedVersion(current.version, body.expected_version, '纸片分集');
  const activeRun = db.prepare("SELECT id FROM paper_studio_runs WHERE paper_episode_id = ? AND deleted_at IS NULL AND status NOT IN ('cancelled','stale') LIMIT 1").get(Number(episodeId));
  if (activeRun) throw new PaperStudioError('PAPER_STUDIO_EPISODE_HAS_PRODUCTION', '纸片分集已有生产历史，不能删除；可以改为归档', { paper_episode_id: Number(episodeId), run_id: Number(activeRun.id) }, 409);
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE paper_storyboards SET deleted_at = ?, updated_at = ? WHERE paper_episode_id = ? AND deleted_at IS NULL').run(now, now, Number(episodeId));
    db.prepare('UPDATE paper_studio_episodes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, now, Number(episodeId));
  });
  transaction();
  if (log) log.info('Paper studio episode deleted', { paper_episode_id: Number(episodeId) });
  return { id: Number(episodeId), deleted: true };
}

module.exports = { rowToEpisode, get, list, create, update, remove };
