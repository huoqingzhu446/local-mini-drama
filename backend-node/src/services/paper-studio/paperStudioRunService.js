const projectService = require('./paperStudioProjectService');
const shotService = require('./paperStudioShotService');
const schemaService = require('./paperStudioSchemaService');
const revisionService = require('./paperSourceRevisionService');
const continuityService = require('./paperContinuityService');
const episodeService = require('./paperStudioEpisodeService');
const storyboardService = require('./paperStoryboardService');
const { nextActionForRun } = require('./paperStudioStateService');
const {
  PaperStudioError,
  nowIso,
  parseJson,
  placeholders,
} = require('./paperStudioUtils');

function rowToRun(row) {
  if (!row) return null;
  return {
    ...row,
    project_id: Number(row.project_id),
    drama_id: Number(row.drama_id),
    episode_id: Number(row.episode_id),
    paper_episode_id: row.paper_episode_id == null ? null : Number(row.paper_episode_id),
    legacy_episode_id: row.legacy_episode_id == null ? null : Number(row.legacy_episode_id),
    run_number: Number(row.run_number),
    selection_json: parseJson(row.selection_json, {}),
    budget_json: parseJson(row.budget_json, {}),
    last_error_json: parseJson(row.last_error_json, {}),
    progress: Number(row.progress || 0),
    version: Number(row.version || 1),
    paused: Boolean(row.paused_at),
    next_action: nextActionForRun(row.status),
  };
}

function getRow(db, runId) {
  return db.prepare(
    'SELECT * FROM paper_studio_runs WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(runId));
}

function get(db, runId) {
  const row = getRow(db, runId);
  if (!row) {
    throw new PaperStudioError(
      'PAPER_STUDIO_RUN_NOT_FOUND',
      '纸片动画生产版本不存在',
      { run_id: Number(runId) },
      404,
    );
  }
  const run = rowToRun(row);
  return { ...run, shots: shotService.listByRun(db, run.id), continuity: continuityService.listForRun(db, run.id) };
}

function list(db, filters = {}) {
  let sql = `
    SELECT pr.*,
           COUNT(ps.id) AS shot_count,
           SUM(CASE WHEN ps.status = 'published' THEN 1 ELSE 0 END) AS published_shot_count
    FROM paper_studio_runs pr
    LEFT JOIN paper_studio_shots ps ON ps.run_id = pr.id AND ps.deleted_at IS NULL
    WHERE pr.deleted_at IS NULL`;
  const params = [];
  if (filters.project_id != null && filters.project_id !== '') {
    sql += ' AND pr.project_id = ?';
    params.push(Number(filters.project_id));
  }
  if (filters.episode_id != null && filters.episode_id !== '') {
    sql += ' AND pr.episode_id = ?';
    params.push(Number(filters.episode_id));
  }
  if (filters.paper_episode_id != null && filters.paper_episode_id !== '') {
    sql += ' AND pr.paper_episode_id = ?';
    params.push(Number(filters.paper_episode_id));
  }
  sql += ' GROUP BY pr.id ORDER BY pr.updated_at DESC, pr.id DESC';
  return db.prepare(sql).all(...params).map((row) => ({
    ...rowToRun(row),
    shot_count: Number(row.shot_count || 0),
    published_shot_count: Number(row.published_shot_count || 0),
  }));
}

function defaultBudget(tier) {
  if (tier === 'draft') return { max_images: 12, max_auto_retries_per_slot: 1 };
  if (tier === 'full-depth') return { max_images: 48, max_auto_retries_per_slot: 2 };
  return { max_images: 24, max_auto_retries_per_slot: 2 };
}

// paper_studio_runs / paper_studio_shots predate the independent authoring
// domain, so their legacy episode_id / storyboard_id columns are still NOT
// NULL and participate in old UNIQUE constraints.  Keep those compatibility
// values in a disjoint namespace: a paper id must never accidentally collide
// with, or be mistaken for, a real legacy row carrying the same positive id.
function paperCompatibilityId(id) {
  return -Math.abs(Number(id));
}

function createLegacy(db, log, body = {}) {
  schemaService.assertValid('apiRunCreate', body, '创建纸片动画生产版本的参数无效');
  const project = projectService.get(db, body.project_id);
  if (project.status !== 'active') {
    throw new PaperStudioError(
      'PAPER_STUDIO_PROJECT_INACTIVE',
      '纸片工作室项目当前不可创建生产版本',
      { project_id: project.id, status: project.status },
      409,
    );
  }

  const existing = db.prepare(
    `SELECT id FROM paper_studio_runs
     WHERE project_id = ? AND request_id = ? AND deleted_at IS NULL`,
  ).get(project.id, body.request_id);
  if (existing) return { run: get(db, existing.id), created: false, deduplicated: true };

  const episode = db.prepare(
    'SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(body.episode_id));
  if (!episode || Number(episode.drama_id) !== Number(project.drama_id)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_EPISODE_OWNERSHIP_MISMATCH',
      '所选分集不属于当前纸片工作室项目',
      { episode_id: Number(body.episode_id), drama_id: project.drama_id },
      409,
    );
  }

  const ids = body.storyboard_ids.map(Number);
  const storyboards = db.prepare(
    `SELECT * FROM storyboards
     WHERE episode_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids)})
     ORDER BY storyboard_number, id`,
  ).all(Number(episode.id), ...ids);
  if (storyboards.length !== ids.length) {
    const found = new Set(storyboards.map((storyboard) => Number(storyboard.id)));
    throw new PaperStudioError(
      'PAPER_STUDIO_STORYBOARD_OWNERSHIP_MISMATCH',
      '部分分镜不存在或不属于所选分集',
      { missing_storyboard_ids: ids.filter((id) => !found.has(id)), episode_id: Number(episode.id) },
      409,
    );
  }

  const drama = db.prepare(
    'SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(project.drama_id));
  if (!drama) {
    throw new PaperStudioError('PAPER_STUDIO_DRAMA_NOT_FOUND', '剧集项目不存在', null, 404);
  }
  const qualityTier = body.quality_tier || project.default_tier || 'balanced';
  const budget = { ...defaultBudget(qualityTier), ...(body.budget || {}) };
  const styleVersionId = drama.active_visual_style_version_id || null;
  const styleSignature = drama.active_visual_style_signature || null;
  const providerSig = revisionService.providerSignature(db, body.image_provider_config_id || null);
  const runRevisionHash = revisionService.hashRun({
    db,
    drama,
    episode,
    storyboards,
    style_version_id: styleVersionId,
    style_signature: styleSignature,
    quality_tier: qualityTier,
    provider_signature: providerSig,
  });
  const selection = {
    storyboard_ids: storyboards.map((storyboard) => Number(storyboard.id)),
    image_provider_config_id: body.image_provider_config_id || null,
  };

  const insert = db.transaction(() => {
    const next = db.prepare(
      `SELECT COALESCE(MAX(run_number), 0) + 1 AS next_number
       FROM paper_studio_runs WHERE project_id = ? AND episode_id = ?`,
    ).get(project.id, Number(episode.id));
    const now = nowIso();
    const result = db.prepare(
      `INSERT INTO paper_studio_runs
        (project_id, drama_id, episode_id, legacy_episode_id, run_number, request_id, selection_json,
         quality_tier, style_version_id, style_signature, source_revision_hash,
         budget_json, status, progress, last_error_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, '{}', 1, ?, ?)`,
    ).run(
      project.id,
      project.drama_id,
      Number(episode.id),
      Number(episode.id),
      Number(next.next_number),
      body.request_id,
      JSON.stringify(selection),
      qualityTier,
      styleVersionId,
      styleSignature,
      runRevisionHash,
      JSON.stringify(budget),
      now,
      now,
    );
    const runId = Number(result.lastInsertRowid);
    const insertShot = db.prepare(
      `INSERT INTO paper_studio_shots
        (run_id, drama_id, episode_id, storyboard_id, legacy_storyboard_id, source_kind, shot_index, source_revision_hash,
         semantic_contract_json, plan_summary_json, status, last_error_json,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'legacy', ?, ?, '{}', '{}', 'pending', '{}', 1, ?, ?)`,
    );
    storyboards.forEach((storyboard, index) => {
      const shotRevisionHash = revisionService.hashShot(db, storyboard, {
        style_version_id: styleVersionId,
        style_signature: styleSignature,
        quality_tier: qualityTier,
        provider_signature: providerSig,
      });
      insertShot.run(
        runId,
        project.drama_id,
        Number(episode.id),
        Number(storyboard.id),
        Number(storyboard.id),
        index,
        shotRevisionHash,
        now,
        now,
      );
    });
    return runId;
  });

  let runId;
  try {
    runId = insert();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const raced = db.prepare(
        'SELECT id FROM paper_studio_runs WHERE project_id = ? AND request_id = ?',
      ).get(project.id, body.request_id);
      if (raced) return { run: get(db, raced.id), created: false, deduplicated: true };
    }
    throw error;
  }

  const run = get(db, runId);
  if (log) {
    log.info('Paper studio run created', {
      run_id: run.id,
      project_id: project.id,
      episode_id: run.episode_id,
      shot_count: run.shots.length,
    });
  }
  return { run, created: true, deduplicated: false };
}

function createPaper(db, log, body = {}) {
  schemaService.assertValid('apiRunCreate', body, '创建纸片动画生产版本的参数无效');
  const project = projectService.get(db, body.project_id);
  if (project.status !== 'active') throw new PaperStudioError('PAPER_STUDIO_PROJECT_INACTIVE', '纸片工作室项目当前不可创建生产版本', { project_id: project.id, status: project.status }, 409);
  const existing = db.prepare('SELECT id FROM paper_studio_runs WHERE project_id = ? AND request_id = ? AND deleted_at IS NULL').get(project.id, body.request_id);
  if (existing) return { run: get(db, existing.id), created: false, deduplicated: true };

  const episode = episodeService.get(db, body.paper_episode_id);
  if (Number(episode.project_id) !== Number(project.id)) throw new PaperStudioError('PAPER_STUDIO_EPISODE_OWNERSHIP_MISMATCH', '所选纸片分集不属于当前纸片项目', { paper_episode_id: Number(episode.id), project_id: project.id }, 409);
  const ids = body.paper_storyboard_ids.map(Number);
  const selected = db.prepare(
    `SELECT * FROM paper_storyboards
     WHERE paper_episode_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids)})
     ORDER BY shot_number, id`,
  ).all(Number(episode.id), ...ids);
  if (selected.length !== ids.length) {
    const found = new Set(selected.map((item) => Number(item.id)));
    throw new PaperStudioError('PAPER_STUDIO_STORYBOARD_OWNERSHIP_MISMATCH', '部分纸片分镜不存在或不属于所选纸片分集', { missing_paper_storyboard_ids: ids.filter((id) => !found.has(id)), paper_episode_id: Number(episode.id) }, 409);
  }
  const expectedRevisions = body.expected_paper_storyboard_revisions || {};
  const revisionMismatches = selected.filter((item) => Number(expectedRevisions[String(item.id)] || 0) !== Number(item.current_revision_id || 0));
  if (revisionMismatches.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_DRAFT_NOT_SAVED',
      '部分纸片分镜尚未保存到当前版本，请保存后再创建生产版本',
      {
        storyboards: revisionMismatches.map((item) => ({
          paper_storyboard_id: Number(item.id),
          expected_revision_id: Number(expectedRevisions[String(item.id)] || 0),
          current_revision_id: Number(item.current_revision_id || 0),
        })),
      },
      409,
    );
  }
  const invalid = selected.map((item) => storyboardService.productionReadiness(item)).filter((item) => !item.ready);
  if (invalid.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STORYBOARD_INCOMPLETE',
      '所选分镜还缺少正式生产所需内容',
      { storyboards: invalid },
      422,
    );
  }
  const revisions = selected.map((item) => storyboardService.ensureRevision(db, item.id, 'production'));
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(project.drama_id));
  if (!drama) throw new PaperStudioError('PAPER_STUDIO_DRAMA_NOT_FOUND', '剧集项目不存在', null, 404);
  const qualityTier = body.quality_tier || project.default_tier || 'balanced';
  const budget = { ...defaultBudget(qualityTier), ...(body.budget || {}) };
  const styleVersionId = drama.active_visual_style_version_id || null;
  const styleSignature = drama.active_visual_style_signature || null;
  const providerSig = revisionService.providerSignature(db, body.image_provider_config_id || null);
  const context = {
    style_version_id: styleVersionId,
    style_signature: styleSignature,
    quality_tier: qualityTier,
    provider_signature: providerSig,
  };
  const runRevisionHash = revisionService.hashPaperRun({
    drama,
    episode,
    revisions,
    ...context,
  });
  const selection = {
    paper_storyboard_ids: selected.map((item) => Number(item.id)),
    paper_storyboard_revision_ids: revisions.map((item) => Number(item.id)),
    image_provider_config_id: body.image_provider_config_id || null,
    source_kind: 'paper',
  };
  const compatibilityEpisodeId = paperCompatibilityId(episode.id);

  const insert = db.transaction(() => {
    const next = db.prepare('SELECT COALESCE(MAX(run_number), 0) + 1 AS next_number FROM paper_studio_runs WHERE project_id = ? AND paper_episode_id = ?').get(project.id, Number(episode.id));
    const now = nowIso();
    const result = db.prepare(
      `INSERT INTO paper_studio_runs
        (project_id, drama_id, episode_id, paper_episode_id, legacy_episode_id,
         run_number, request_id, selection_json, quality_tier, style_version_id,
         style_signature, source_revision_hash, budget_json, status, progress,
         last_error_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, '{}', 1, ?, ?)`,
    ).run(
      project.id, project.drama_id, compatibilityEpisodeId, Number(episode.id),
      Number(next.next_number), body.request_id, JSON.stringify(selection), qualityTier,
      styleVersionId, styleSignature, runRevisionHash, JSON.stringify(budget), now, now,
    );
    const runId = Number(result.lastInsertRowid);
    const insertShot = db.prepare(
      `INSERT INTO paper_studio_shots
        (run_id, drama_id, episode_id, storyboard_id, paper_storyboard_id,
         paper_storyboard_revision_id, legacy_storyboard_id, source_kind, shot_index,
         source_revision_hash, semantic_contract_json, plan_summary_json, status,
         last_error_json, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'paper', ?, ?, '{}', '{}', 'pending', '{}', 1, ?, ?)`,
    );
    selected.forEach((item, index) => {
      const revision = revisions[index];
      insertShot.run(
        runId, project.drama_id, compatibilityEpisodeId, paperCompatibilityId(item.id), Number(item.id),
        Number(revision.id), index, revisionService.hashPaperRevision(revision, context), now, now,
      );
      db.prepare("UPDATE paper_storyboards SET status = 'in_production', updated_at = ? WHERE id = ? AND status IN ('draft','ready')").run(now, Number(item.id));
    });
    return runId;
  });

  let runId;
  try {
    runId = insert();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const raced = db.prepare('SELECT id FROM paper_studio_runs WHERE project_id = ? AND request_id = ?').get(project.id, body.request_id);
      if (raced) return { run: get(db, raced.id), created: false, deduplicated: true };
    }
    throw error;
  }
  const run = get(db, runId);
  if (log) log.info('Independent paper studio run created', { run_id: run.id, project_id: project.id, paper_episode_id: episode.id, shot_count: run.shots.length });
  return { run, created: true, deduplicated: false };
}

function create(db, log, body = {}) {
  if (body.paper_episode_id != null || body.paper_storyboard_ids != null) return createPaper(db, log, body);
  return createLegacy(db, log, body);
}

module.exports = { rowToRun, get, list, create, createPaper, createLegacy, defaultBudget };
