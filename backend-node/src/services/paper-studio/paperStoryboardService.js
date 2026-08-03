const { randomUUID } = require('crypto');
const episodeService = require('./paperStudioEpisodeService');
const projectService = require('./paperStudioProjectService');
const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  placeholders,
  sha256,
} = require('./paperStudioUtils');

const CONTENT_FIELDS = [
  'title', 'description', 'action', 'dialogue', 'narration', 'duration',
  'shot_type', 'camera_motion', 'visual_prompt', 'negative_prompt',
  'environment_only',
  'reference_image_url', 'reference_local_path',
];

const EPISODE_MERGE_STALE_REASON = '纸片分镜内容或顺序已更新，请重新合并整集';

function invalidateEpisodeMerges(db, episodeId, { now = nowIso(), reason = EPISODE_MERGE_STALE_REASON } = {}) {
  const paperEpisodeId = Number(episodeId);
  const activeMerges = db.prepare(
    `SELECT id, task_id, status FROM video_merges
     WHERE paper_episode_id = ? AND deleted_at IS NULL
       AND status IN ('pending','processing','completed')`,
  ).all(paperEpisodeId);
  if (activeMerges.length) {
    db.prepare(
      `UPDATE video_merges
       SET status = 'stale', error_msg = ?, completed_at = COALESCE(completed_at, ?)
       WHERE paper_episode_id = ? AND deleted_at IS NULL
         AND status IN ('pending','processing','completed')`,
    ).run(reason, now, paperEpisodeId);
    const taskService = require('../taskService');
    for (const merge of activeMerges) {
      if (merge.task_id && ['pending', 'processing'].includes(merge.status)) {
        taskService.updateTaskError(db, merge.task_id, reason);
      }
    }
  }
  db.prepare(
    `UPDATE paper_studio_episodes
     SET status = CASE WHEN status = 'archived' THEN status ELSE 'draft' END,
         version = version + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(now, paperEpisodeId);
  return { invalidated_merge_ids: activeMerges.map((merge) => Number(merge.id)) };
}

function rowToStoryboard(row) {
  if (!row) return null;
  const preview = row.reference_local_path
    ? `/static/${String(row.reference_local_path).replace(/^\/+/, '')}`
    : row.reference_image_url || null;
  return {
    ...row,
    id: Number(row.id),
    paper_episode_id: Number(row.paper_episode_id),
    shot_number: Number(row.shot_number),
    duration: Number(row.duration || 6),
    current_revision_id: row.current_revision_id == null ? null : Number(row.current_revision_id),
    working_copy_base_revision_id: row.working_copy_base_revision_id == null ? null : Number(row.working_copy_base_revision_id),
    working_copy_base_revision_number: row.working_copy_base_revision_number == null ? null : Number(row.working_copy_base_revision_number),
    working_copy_fork_audit_id: row.working_copy_fork_audit_id == null ? null : Number(row.working_copy_fork_audit_id),
    current_reference_version_id: row.current_reference_version_id == null ? null : Number(row.current_reference_version_id),
    current_dialogue_audio_version_id: row.current_dialogue_audio_version_id == null ? null : Number(row.current_dialogue_audio_version_id),
    current_narration_audio_version_id: row.current_narration_audio_version_id == null ? null : Number(row.current_narration_audio_version_id),
    reference_image_generation_id: row.reference_image_generation_id == null ? null : Number(row.reference_image_generation_id),
    published_video_generation_id: row.published_video_generation_id == null ? null : Number(row.published_video_generation_id),
    legacy_storyboard_id: row.legacy_storyboard_id == null ? null : Number(row.legacy_storyboard_id),
    version: Number(row.version || 1),
    environment_only: Boolean(row.environment_only),
    reference_constraints_json: parseJson(row.reference_constraints_json, {}),
    audio_mix_json: parseJson(row.audio_mix_json, {}),
    preview_url: preview,
  };
}

function get(db, storyboardId, { includeDeleted = false } = {}) {
  const row = db.prepare(
    `SELECT ps.*, pe.project_id, pe.episode_number, pe.title AS episode_title,
            psp.drama_id, vg.video_url AS published_video_url, vg.local_path AS published_video_local_path
     FROM paper_storyboards ps
     JOIN paper_studio_episodes pe ON pe.id = ps.paper_episode_id
     JOIN paper_studio_projects psp ON psp.id = pe.project_id
     LEFT JOIN video_generations vg ON vg.id = ps.published_video_generation_id AND vg.deleted_at IS NULL
     WHERE ps.id = ? ${includeDeleted ? '' : 'AND ps.deleted_at IS NULL'} AND pe.deleted_at IS NULL`,
  ).get(Number(storyboardId));
  if (!row) throw new PaperStudioError('PAPER_STORYBOARD_NOT_FOUND', '纸片分镜不存在', { paper_storyboard_id: Number(storyboardId) }, 404);
  if (row && row.working_copy_base_revision_id != null) {
    row.working_copy_base_revision_number = db.prepare(
      'SELECT revision_number FROM paper_storyboard_revisions WHERE id = ? AND paper_storyboard_id = ?',
    ).get(Number(row.working_copy_base_revision_id), Number(row.id))?.revision_number || null;
  }
  return rowToStoryboard(row);
}

function list(db, episodeId) {
  episodeService.get(db, episodeId);
  return db.prepare(
    `SELECT ps.*, vg.video_url AS published_video_url, vg.local_path AS published_video_local_path
     FROM paper_storyboards ps
     LEFT JOIN video_generations vg ON vg.id = ps.published_video_generation_id AND vg.deleted_at IS NULL
     WHERE ps.paper_episode_id = ? AND ps.deleted_at IS NULL
     ORDER BY ps.shot_number, ps.id`,
  ).all(Number(episodeId)).map((row) => {
    if (row.working_copy_base_revision_id != null) {
      row.working_copy_base_revision_number = db.prepare(
        'SELECT revision_number FROM paper_storyboard_revisions WHERE id = ? AND paper_storyboard_id = ?',
      ).get(Number(row.working_copy_base_revision_id), Number(row.id))?.revision_number || null;
    }
    return rowToStoryboard(row);
  });
}

function revisionContent(storyboard) {
  return {
    schema_version: 1,
    paper_storyboard_id: Number(storyboard.id),
    paper_episode_id: Number(storyboard.paper_episode_id),
    shot_number: Number(storyboard.shot_number),
    title: storyboard.title || '',
    description: storyboard.description || '',
    action: storyboard.action || '',
    dialogue: storyboard.dialogue || '',
    narration: storyboard.narration || '',
    duration: Number(storyboard.duration || 6),
    shot_type: storyboard.shot_type || '',
    camera_motion: storyboard.camera_motion || '',
    visual_prompt: storyboard.visual_prompt || '',
    negative_prompt: storyboard.negative_prompt || '',
    environment_only: Boolean(storyboard.environment_only),
    reference_image_url: storyboard.reference_image_url || '',
    reference_local_path: storyboard.reference_local_path || '',
    current_reference_version_id: storyboard.current_reference_version_id == null ? null : Number(storyboard.current_reference_version_id),
    reference_constraints: storyboard.reference_constraints_json || {},
    source_kind: storyboard.source_kind || 'paper',
    legacy_storyboard_id: storyboard.legacy_storyboard_id == null ? null : Number(storyboard.legacy_storyboard_id),
  };
}

function ensureRevision(db, storyboardId, createdFrom = 'manual') {
  const storyboard = get(db, storyboardId);
  const content = revisionContent(storyboard);
  const hash = sha256(canonicalJson(content));
  let row = db.prepare('SELECT * FROM paper_storyboard_revisions WHERE paper_storyboard_id = ? AND content_hash = ?').get(Number(storyboardId), hash);
  if (!row) {
    const next = db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_number FROM paper_storyboard_revisions WHERE paper_storyboard_id = ?').get(Number(storyboardId));
    const result = db.prepare(
      `INSERT INTO paper_storyboard_revisions
        (paper_storyboard_id, revision_number, content_json, content_hash, created_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(Number(storyboardId), Number(next.next_number), canonicalJson(content), hash, createdFrom, nowIso());
    row = db.prepare('SELECT * FROM paper_storyboard_revisions WHERE id = ?').get(Number(result.lastInsertRowid));
  }
  if (Number(storyboard.current_revision_id || 0) !== Number(row.id)) {
    db.prepare('UPDATE paper_storyboards SET current_revision_id = ? WHERE id = ?').run(Number(row.id), Number(storyboardId));
  }
  return {
    ...row,
    id: Number(row.id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    revision_number: Number(row.revision_number),
    content,
  };
}

function productionReadiness(storyboard) {
  const missing = [];
  if (!String(storyboard?.title || '').trim()) missing.push('title');
  if (!String(storyboard?.description || '').trim()) missing.push('description');
  if (!Boolean(storyboard?.environment_only) && !String(storyboard?.action || '').trim()) missing.push('action');
  return {
    ready: missing.length === 0,
    paper_storyboard_id: Number(storyboard?.id || 0),
    missing_fields: missing,
    environment_only: Boolean(storyboard?.environment_only),
  };
}

function create(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardCreate', body, '创建纸片分镜的参数无效');
  const episode = episodeService.get(db, episodeId);
  const existing = db.prepare('SELECT id FROM paper_storyboards WHERE paper_episode_id = ? AND request_id = ? AND deleted_at IS NULL').get(Number(episodeId), body.request_id);
  if (existing) return { storyboard: get(db, existing.id), created: false, deduplicated: true };
  const number = body.shot_number == null
    ? Number(db.prepare('SELECT COALESCE(MAX(shot_number), 0) + 1 AS next_number FROM paper_storyboards WHERE paper_episode_id = ? AND deleted_at IS NULL').get(Number(episodeId)).next_number)
    : Number(body.shot_number);
  const now = nowIso();
  let result;
  try {
    result = db.prepare(
      `INSERT INTO paper_storyboards
        (paper_episode_id, request_id, shot_number, title, description, action, dialogue,
         narration, duration, shot_type, camera_motion, visual_prompt, negative_prompt,
         reference_image_url, reference_local_path, environment_only, legacy_storyboard_id, source_kind,
         status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
    ).run(
      Number(episodeId), body.request_id, number, body.title.trim(), body.description || '',
      body.action || '', body.dialogue || '', body.narration || '',
      Number(body.duration || episode.default_duration || 6), body.shot_type || null,
      body.camera_motion || null, body.visual_prompt || '', body.negative_prompt || '',
      body.reference_image_url || null, body.reference_local_path || null,
      body.environment_only ? 1 : 0, body.legacy_storyboard_id || null, body.source_kind || 'paper', now, now,
    );
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new PaperStudioError('PAPER_STORYBOARD_NUMBER_CONFLICT', '纸片分镜序号已存在', { paper_episode_id: Number(episodeId), shot_number: number }, 409);
    throw error;
  }
  const id = Number(result.lastInsertRowid);
  ensureRevision(db, id, body.source_kind || 'manual');
  invalidateEpisodeMerges(db, episodeId, { now });
  const storyboard = get(db, id);
  if (log) log.info('Paper storyboard created', { paper_storyboard_id: id, paper_episode_id: Number(episodeId) });
  return { storyboard, created: true, deduplicated: false };
}

function update(db, log, storyboardId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardUpdate', body, '更新纸片分镜的参数无效');
  const current = get(db, storyboardId);
  assertExpectedVersion(current.version, body.expected_version, '纸片分镜');
  const fields = [];
  const values = [];
  for (const key of [...CONTENT_FIELDS, 'status']) {
    if (body[key] === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(key === 'duration' ? Number(body[key]) : key === 'environment_only' ? (body[key] ? 1 : 0) : body[key]);
  }
  const now = nowIso();
  fields.push('version = version + 1', 'updated_at = ?');
  values.push(now, Number(storyboardId), current.version);
  let storyboard;
  const transaction = db.transaction(() => {
    const result = db.prepare(`UPDATE paper_storyboards SET ${fields.join(', ')} WHERE id = ? AND version = ? AND deleted_at IS NULL`).run(...values);
    if (!result.changes) throw new PaperStudioError('PAPER_STUDIO_VERSION_CONFLICT', '纸片分镜已被更新，请刷新后重试', { paper_storyboard_id: Number(storyboardId) }, 409);
    const pendingForkAudit = current.working_copy_fork_audit_id == null ? null : db.prepare(
      `SELECT id FROM paper_history_fork_audits
       WHERE id = ? AND paper_storyboard_id = ? AND target_storyboard_revision_id IS NULL`,
    ).get(Number(current.working_copy_fork_audit_id), Number(storyboardId));
    const revision = ensureRevision(db, storyboardId, pendingForkAudit ? 'history_fork_edit' : 'manual');
    if (pendingForkAudit && Number(revision.id) !== Number(current.current_revision_id || 0)) {
      db.prepare(
        `UPDATE paper_history_fork_audits
         SET target_storyboard_revision_id = ?, completed_at = COALESCE(completed_at, ?)
         WHERE id = ? AND target_storyboard_revision_id IS NULL`,
      ).run(Number(revision.id), now, Number(pendingForkAudit.id));
    }
    const changedContent = get(db, storyboardId);
    require('./paperStoryboardAudioService').invalidateChangedText(db, storyboardId, current, changedContent, now);
    if (Number(revision.id) !== Number(current.current_revision_id || 0)) {
      db.prepare("UPDATE paper_storyboards SET published_video_generation_id = NULL, status = 'draft' WHERE id = ? AND deleted_at IS NULL")
        .run(Number(storyboardId));
      invalidateEpisodeMerges(db, current.paper_episode_id, { now });
    }
    storyboard = get(db, storyboardId);
  });
  transaction();
  if (log) log.info('Paper storyboard updated', { paper_storyboard_id: storyboard.id, version: storyboard.version });
  return storyboard;
}

function remove(db, log, storyboardId, body = {}) {
  schemaService.assertValid('apiShotAction', body, '删除纸片分镜的参数无效');
  const current = get(db, storyboardId);
  assertExpectedVersion(current.version, body.expected_version, '纸片分镜');
  const active = db.prepare("SELECT id, run_id FROM paper_studio_shots WHERE paper_storyboard_id = ? AND deleted_at IS NULL AND status NOT IN ('published','cancelled','stale') LIMIT 1").get(Number(storyboardId));
  if (active) throw new PaperStudioError('PAPER_STORYBOARD_HAS_ACTIVE_PRODUCTION', '当前分镜仍在生产中，不能删除', { paper_storyboard_id: Number(storyboardId), run_id: Number(active.run_id) }, 409);
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare('UPDATE paper_storyboards SET shot_number = -id, deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(now, now, Number(storyboardId));
    const remaining = db.prepare('SELECT id FROM paper_storyboards WHERE paper_episode_id = ? AND deleted_at IS NULL ORDER BY shot_number, id')
      .all(Number(current.paper_episode_id));
    remaining.forEach((item, index) => {
      db.prepare('UPDATE paper_storyboards SET shot_number = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(index + 1, now, Number(item.id));
    });
  });
  transaction();
  invalidateEpisodeMerges(db, current.paper_episode_id, { now });
  if (log) log.info('Paper storyboard deleted', { paper_storyboard_id: Number(storyboardId) });
  return { id: Number(storyboardId), deleted: true };
}

function duplicate(db, log, storyboardId, body = {}) {
  schemaService.assertValid('apiShotAction', body, '复制纸片分镜的参数无效');
  const source = get(db, storyboardId);
  assertExpectedVersion(source.version, body.expected_version, '纸片分镜');
  const payload = Object.fromEntries(CONTENT_FIELDS.map((key) => [key, source[key]]));
  return create(db, log, source.paper_episode_id, {
    request_id: body.request_id,
    ...payload,
    title: `${source.title} 副本`,
    source_kind: 'duplicate',
  });
}

function reorder(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardReorder', body, '纸片分镜排序参数无效');
  const existing = list(db, episodeId);
  const actual = existing.map((item) => Number(item.id)).sort((a, b) => a - b);
  const wanted = body.storyboard_ids.map(Number);
  const sortedWanted = [...wanted].sort((a, b) => a - b);
  if (actual.length !== sortedWanted.length || actual.some((id, index) => id !== sortedWanted[index])) {
    throw new PaperStudioError('PAPER_STORYBOARD_REORDER_MISMATCH', '排序列表必须包含当前分集的全部纸片分镜', { paper_episode_id: Number(episodeId), expected_ids: actual }, 409);
  }
  const now = nowIso();
  const orderChanged = existing.some((item, index) => Number(item.id) !== Number(wanted[index]));
  const transaction = db.transaction(() => {
    db.prepare('UPDATE paper_storyboards SET shot_number = shot_number + 1000000, updated_at = ? WHERE paper_episode_id = ? AND deleted_at IS NULL').run(now, Number(episodeId));
    wanted.forEach((id, index) => db.prepare('UPDATE paper_storyboards SET shot_number = ?, version = version + 1, updated_at = ? WHERE id = ? AND paper_episode_id = ?').run(index + 1, now, id, Number(episodeId)));
  });
  transaction();
  if (orderChanged) invalidateEpisodeMerges(db, episodeId, { now });
  if (log) log.info('Paper storyboards reordered', { paper_episode_id: Number(episodeId), count: wanted.length });
  return list(db, episodeId);
}

function importLegacy(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperImportLegacy', body, '导入旧分镜的参数无效');
  const paperEpisode = episodeService.get(db, episodeId);
  const project = projectService.get(db, paperEpisode.project_id);
  const legacyEpisode = db.prepare('SELECT * FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(body.legacy_episode_id), Number(project.drama_id));
  if (!legacyEpisode) throw new PaperStudioError('PAPER_STUDIO_LEGACY_EPISODE_NOT_FOUND', '旧工作台分集不存在或不属于当前项目', { legacy_episode_id: Number(body.legacy_episode_id) }, 404);
  const ids = body.storyboard_ids?.map(Number) || [];
  const legacy = ids.length
    ? db.prepare(`SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids)}) ORDER BY storyboard_number, id`).all(Number(legacyEpisode.id), ...ids)
    : db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number, id').all(Number(legacyEpisode.id));
  if (ids.length && legacy.length !== ids.length) throw new PaperStudioError('PAPER_STUDIO_LEGACY_STORYBOARD_MISMATCH', '部分旧分镜不存在或不属于所选分集', { legacy_episode_id: Number(legacyEpisode.id) }, 409);
  const imported = [];
  const skipped = [];
  for (const item of legacy) {
    const exists = db.prepare('SELECT id FROM paper_storyboards WHERE paper_episode_id = ? AND legacy_storyboard_id = ? AND deleted_at IS NULL').get(Number(episodeId), Number(item.id));
    if (exists) {
      skipped.push(Number(exists.id));
      continue;
    }
    const result = create(db, log, episodeId, {
      request_id: randomUUID(),
      title: item.title || `分镜 ${item.storyboard_number || imported.length + 1}`,
      description: item.description || '',
      action: item.action || '',
      dialogue: item.dialogue || '',
      narration: item.narration || '',
      duration: Number(item.duration || paperEpisode.default_duration || 6),
      shot_type: item.shot_type || null,
      camera_motion: item.movement || null,
      visual_prompt: item.prompt || '',
      reference_image_url: item.image_url || null,
      reference_local_path: item.local_path || null,
      legacy_storyboard_id: Number(item.id),
      source_kind: 'legacy_import',
    });
    imported.push(result.storyboard.id);
  }
  return { imported, skipped, storyboards: list(db, episodeId) };
}

module.exports = {
  CONTENT_FIELDS,
  EPISODE_MERGE_STALE_REASON,
  rowToStoryboard,
  get,
  list,
  revisionContent,
  ensureRevision,
  productionReadiness,
  invalidateEpisodeMerges,
  create,
  update,
  remove,
  duplicate,
  reorder,
  importLegacy,
};
