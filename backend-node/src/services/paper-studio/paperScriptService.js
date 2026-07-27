const episodeService = require('./paperStudioEpisodeService');
const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  nowIso,
  sha256,
} = require('./paperStudioUtils');

const MAX_VERSIONS_PER_EPISODE = 200;

function rowToScript(row, { withContent = true } = {}) {
  if (!row) return null;
  const script = {
    id: Number(row.id),
    paper_episode_id: Number(row.paper_episode_id),
    version_number: Number(row.version_number),
    content_hash: row.content_hash,
    source_kind: row.source_kind || 'manual',
    content_length: Number(row.content_length != null ? row.content_length : (row.content || '').length),
    created_at: row.created_at,
  };
  if (withContent) script.content = row.content;
  return script;
}

function get(db, scriptId, options = {}) {
  const row = db.prepare('SELECT * FROM paper_scripts WHERE id = ?').get(Number(scriptId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_SCRIPT_NOT_FOUND', '剧本版本不存在', { script_id: Number(scriptId) }, 404);
  return rowToScript(row, options);
}

function getForEpisode(db, episodeId, scriptId, options = {}) {
  const script = get(db, scriptId, options);
  if (script.paper_episode_id !== Number(episodeId)) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_OWNERSHIP_MISMATCH', '剧本版本不属于当前纸片分集', { script_id: Number(scriptId), paper_episode_id: Number(episodeId) }, 409);
  }
  return script;
}

function latest(db, episodeId, options = {}) {
  const row = db.prepare(
    'SELECT * FROM paper_scripts WHERE paper_episode_id = ? ORDER BY version_number DESC LIMIT 1',
  ).get(Number(episodeId));
  return row ? rowToScript(row, options) : null;
}

function list(db, episodeId) {
  episodeService.get(db, episodeId);
  return db.prepare(
    `SELECT id, paper_episode_id, version_number, content_hash, source_kind,
            LENGTH(content) AS content_length, created_at
     FROM paper_scripts
     WHERE paper_episode_id = ?
     ORDER BY version_number DESC`,
  ).all(Number(episodeId)).map((row) => rowToScript(row, { withContent: false }));
}

function create(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperScriptCreate', body, '保存剧本版本的参数无效');
  const episode = episodeService.get(db, episodeId);
  const content = String(body.content || '').replace(/\r\n/g, '\n').trim();
  if (content.length < 20) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_TOO_SHORT', '剧本内容太短，无法作为提取与分镜生成的输入', { content_length: content.length }, 400);
  }
  const contentHash = sha256(content);

  // 幂等：同 request_id 或与最新版本内容一致 → 返回既有版本，不新建
  const byRequest = body.request_id
    ? db.prepare('SELECT * FROM paper_scripts WHERE paper_episode_id = ? AND request_id = ?').get(episode.id, body.request_id)
    : null;
  if (byRequest) return { script: rowToScript(byRequest), created: false, deduplicated: true };
  const latestRow = db.prepare('SELECT * FROM paper_scripts WHERE paper_episode_id = ? ORDER BY version_number DESC LIMIT 1').get(episode.id);
  if (latestRow && latestRow.content_hash === contentHash) {
    return { script: rowToScript(latestRow), created: false, deduplicated: true };
  }

  const versionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM paper_scripts WHERE paper_episode_id = ?').get(episode.id).count);
  if (versionCount >= MAX_VERSIONS_PER_EPISODE) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_VERSION_LIMIT', '剧本版本数已达上限，请清理后再保存', { limit: MAX_VERSIONS_PER_EPISODE }, 409);
  }

  const nextVersion = Number(latestRow?.version_number || 0) + 1;
  const now = nowIso();
  const result = db.prepare(
    `INSERT INTO paper_scripts
       (paper_episode_id, request_id, version_number, content, content_hash, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    episode.id,
    body.request_id || null,
    nextVersion,
    content,
    contentHash,
    body.source_kind || 'manual',
    now,
  );
  const script = get(db, result.lastInsertRowid);
  if (log) log.info('Paper studio script version created', { paper_episode_id: episode.id, script_id: script.id, version_number: script.version_number, content_length: content.length });
  return { script, created: true, deduplicated: false };
}

module.exports = { rowToScript, get, getForEpisode, latest, list, create, MAX_VERSIONS_PER_EPISODE };
