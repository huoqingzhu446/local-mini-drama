'use strict';

const crypto = require('crypto');
const { parseDramaMetadata, normalizeVisualBible } = require('../utils/dramaStyleMerge');
const promptStyleService = require('./promptStyleService');

const COMPILER_VERSION = 'v2';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
  catch (_) { return new Set(); }
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS drama_visual_style_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    name TEXT NOT NULL DEFAULT '',
    style_prompt_zh TEXT,
    style_prompt_en TEXT,
    visual_bible TEXT,
    visual_bible_struct TEXT,
    scope_overrides TEXT,
    prompt_style_ids TEXT,
    style_family TEXT,
    medium TEXT,
    signature TEXT NOT NULL,
    compiler_version TEXT NOT NULL DEFAULT 'v2',
    source TEXT,
    created_at TEXT NOT NULL,
    activated_at TEXT,
    superseded_at TEXT,
    UNIQUE(drama_id, version)
  )`);
  const dramaCols = tableColumns(db, 'dramas');
  if (!dramaCols.has('active_visual_style_version_id')) {
    try { db.exec('ALTER TABLE dramas ADD COLUMN active_visual_style_version_id INTEGER'); } catch (_) {}
  }
  if (!dramaCols.has('active_visual_style_signature')) {
    try { db.exec('ALTER TABLE dramas ADD COLUMN active_visual_style_signature TEXT'); } catch (_) {}
  }
}

function normalizeIds(ids) {
  return promptStyleService.normalizeIds(ids);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

function hashObject(value, length = 16) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex').slice(0, length);
}

function promptModuleSnapshots(db, ids) {
  let styles = [];
  try {
    styles = promptStyleService.getEnabledStylesByIds(db, ids);
  } catch (_) {
    // 旧库可能尚未创建 prompt_styles；版本仍可从项目级风格正常启动。
    styles = [];
  }
  return styles.map((style) => ({
    id: Number(style.id),
    name: style.name || '',
    role: style.role || 'constraint',
    medium: style.medium || '',
    priority: Number(style.priority) || 50,
    compatibility_tags: Array.isArray(style.compatibility_tags)
      ? style.compatibility_tags
      : parseJson(style.compatibility_tags, []),
    content: style.content || '',
    content_hash: hashObject({ content: style.content || '', updated_at: style.updated_at || '' }),
  }));
}

function scopeOverridesFromMetadata(meta = {}) {
  return {
    character: {
      zh: String(meta.character_style_prompt_zh || '').trim(),
      en: String(meta.character_style_prompt_en || '').trim(),
    },
    scene: {
      zh: String(meta.scene_style_prompt_zh || '').trim(),
      en: String(meta.scene_style_prompt_en || '').trim(),
    },
    prop: {
      zh: String(meta.prop_style_prompt_zh || '').trim(),
      en: String(meta.prop_style_prompt_en || '').trim(),
    },
    storyboard: {
      zh: String(meta.storyboard_style_prompt_zh || '').trim(),
      en: String(meta.storyboard_style_prompt_en || '').trim(),
    },
    video: {
      zh: String(meta.video_style_prompt_zh || '').trim(),
      en: String(meta.video_style_prompt_en || '').trim(),
    },
  };
}

function payloadFromDrama(db, drama) {
  const meta = parseDramaMetadata(drama || {});
  const ids = normalizeIds(meta.storyboard_prompt_style_ids || []);
  return {
    name: String(meta.generation_style_name || drama?.style || '项目视觉方案').trim(),
    style_prompt_zh: String(meta.style_prompt_zh || '').trim(),
    style_prompt_en: String(meta.style_prompt_en || meta.style_prompt_zh || drama?.style || '').trim(),
    visual_bible: normalizeVisualBible(meta.visual_bible || ''),
    visual_bible_struct: parseJson(meta.visual_bible_struct, null),
    scope_overrides: scopeOverridesFromMetadata(meta),
    prompt_style_ids: ids,
    prompt_modules: promptModuleSnapshots(db, ids),
    style_family: String(meta.style_family || meta.generation_style_name || drama?.style || '').trim(),
    medium: String(meta.style_medium || '').trim(),
    source: String(meta.generation_style_source || 'legacy_drama_metadata'),
  };
}

function normalizePayload(db, body = {}, fallback = {}) {
  const ids = normalizeIds(body.prompt_style_ids !== undefined ? body.prompt_style_ids : fallback.prompt_style_ids);
  const scopeOverrides = body.scope_overrides !== undefined
    ? (parseJson(body.scope_overrides, {}) || {})
    : (fallback.scope_overrides || {});
  const visualBibleStruct = body.visual_bible_struct !== undefined
    ? parseJson(body.visual_bible_struct, null)
    : (fallback.visual_bible_struct || null);
  return {
    name: String(body.name !== undefined ? body.name : (fallback.name || '项目视觉方案')).trim(),
    style_prompt_zh: String(body.style_prompt_zh !== undefined ? body.style_prompt_zh : (fallback.style_prompt_zh || '')).trim(),
    style_prompt_en: String(body.style_prompt_en !== undefined ? body.style_prompt_en : (fallback.style_prompt_en || '')).trim(),
    visual_bible: normalizeVisualBible(body.visual_bible !== undefined ? body.visual_bible : (fallback.visual_bible || '')),
    visual_bible_struct: visualBibleStruct,
    scope_overrides: scopeOverrides,
    prompt_style_ids: ids,
    prompt_modules: promptModuleSnapshots(db, ids),
    style_family: String(body.style_family !== undefined ? body.style_family : (fallback.style_family || '')).trim(),
    medium: String(body.medium !== undefined ? body.medium : (fallback.medium || '')).trim(),
    source: String(body.source !== undefined ? body.source : (fallback.source || 'project')).trim(),
  };
}

function signatureForPayload(payload) {
  return hashObject({
    compiler_version: COMPILER_VERSION,
    style_prompt_zh: payload.style_prompt_zh || '',
    style_prompt_en: payload.style_prompt_en || '',
    visual_bible: payload.visual_bible || '',
    visual_bible_struct: payload.visual_bible_struct || null,
    scope_overrides: payload.scope_overrides || {},
    style_family: payload.style_family || '',
    medium: payload.medium || '',
    prompt_modules: (payload.prompt_modules || []).map((item) => ({
      id: item.id,
      role: item.role,
      medium: item.medium,
      priority: item.priority,
      content_hash: item.content_hash,
    })),
  });
}

function rowToVersion(db, row) {
  if (!row) return null;
  const ids = normalizeIds(parseJson(row.prompt_style_ids, []));
  return {
    id: Number(row.id),
    drama_id: Number(row.drama_id),
    version: Number(row.version),
    status: row.status || 'draft',
    name: row.name || '',
    style_prompt_zh: row.style_prompt_zh || '',
    style_prompt_en: row.style_prompt_en || '',
    visual_bible: row.visual_bible || '',
    visual_bible_struct: parseJson(row.visual_bible_struct, null),
    scope_overrides: parseJson(row.scope_overrides, {}) || {},
    prompt_style_ids: ids,
    prompt_modules: promptModuleSnapshots(db, ids),
    style_family: row.style_family || '',
    medium: row.medium || '',
    signature: row.signature || '',
    compiler_version: row.compiler_version || COMPILER_VERSION,
    source: row.source || '',
    created_at: row.created_at,
    activated_at: row.activated_at,
    superseded_at: row.superseded_at,
  };
}

function getDrama(db, dramaId) {
  return db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId)) || null;
}

function getVersion(db, id) {
  ensureSchema(db);
  return rowToVersion(db, db.prepare('SELECT * FROM drama_visual_style_versions WHERE id = ?').get(Number(id)));
}

function listVersions(db, dramaId) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM drama_visual_style_versions WHERE drama_id = ? ORDER BY version DESC').all(Number(dramaId)).map((row) => rowToVersion(db, row));
}

function nextVersion(db, dramaId, preferred) {
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM drama_visual_style_versions WHERE drama_id = ?').get(Number(dramaId));
  const max = Number(current?.n) || 0;
  const p = Number(preferred);
  return Number.isFinite(p) && p > max ? Math.floor(p) : max + 1;
}

function insertVersion(db, dramaId, payload, status, preferredVersion) {
  ensureSchema(db);
  const version = nextVersion(db, dramaId, preferredVersion);
  const signature = signatureForPayload(payload);
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO drama_visual_style_versions (
    drama_id, version, status, name, style_prompt_zh, style_prompt_en,
    visual_bible, visual_bible_struct, scope_overrides, prompt_style_ids,
    style_family, medium, signature, compiler_version, source, created_at, activated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(dramaId), version, status, payload.name || '', payload.style_prompt_zh || null, payload.style_prompt_en || null,
    payload.visual_bible || null, payload.visual_bible_struct ? JSON.stringify(payload.visual_bible_struct) : null,
    JSON.stringify(payload.scope_overrides || {}), JSON.stringify(payload.prompt_style_ids || []),
    payload.style_family || null, payload.medium || null, signature, COMPILER_VERSION, payload.source || null,
    now, status === 'active' ? now : null
  );
  return getVersion(db, info.lastInsertRowid);
}

function ensureActiveVersion(db, dramaId) {
  ensureSchema(db);
  const drama = getDrama(db, dramaId);
  if (!drama) return null;
  if (drama.active_visual_style_version_id) {
    const selected = getVersion(db, drama.active_visual_style_version_id);
    if (selected) return selected;
  }
  const active = db.prepare("SELECT * FROM drama_visual_style_versions WHERE drama_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(Number(dramaId));
  if (active) {
    const result = rowToVersion(db, active);
    db.prepare('UPDATE dramas SET active_visual_style_version_id = ?, active_visual_style_signature = ? WHERE id = ?').run(result.id, result.signature, Number(dramaId));
    return result;
  }
  const meta = parseDramaMetadata(drama);
  const payload = payloadFromDrama(db, drama);
  const created = insertVersion(db, dramaId, payload, 'active', meta.style_version);
  db.prepare('UPDATE dramas SET active_visual_style_version_id = ?, active_visual_style_signature = ? WHERE id = ?').run(created.id, created.signature, Number(dramaId));
  return created;
}

function createDraft(db, dramaId, body = {}) {
  const drama = getDrama(db, dramaId);
  if (!drama) return null;
  const active = body.skip_bootstrap ? null : ensureActiveVersion(db, dramaId);
  const payload = normalizePayload(db, body, active || payloadFromDrama(db, drama));
  return insertVersion(db, dramaId, payload, 'draft', body.version || body.preferred_version || body.preferredVersion);
}

function updateDraft(db, dramaId, versionId, body = {}) {
  ensureSchema(db);
  const existing = getVersion(db, versionId);
  if (!existing || existing.drama_id !== Number(dramaId) || existing.status !== 'draft') return null;
  const payload = normalizePayload(db, body, existing);
  const signature = signatureForPayload(payload);
  db.prepare(`UPDATE drama_visual_style_versions SET
    name = ?, style_prompt_zh = ?, style_prompt_en = ?, visual_bible = ?, visual_bible_struct = ?,
    scope_overrides = ?, prompt_style_ids = ?, style_family = ?, medium = ?, signature = ?, source = ?
    WHERE id = ? AND drama_id = ? AND status = 'draft'`
  ).run(
    payload.name || '', payload.style_prompt_zh || null, payload.style_prompt_en || null, payload.visual_bible || null,
    payload.visual_bible_struct ? JSON.stringify(payload.visual_bible_struct) : null,
    JSON.stringify(payload.scope_overrides || {}), JSON.stringify(payload.prompt_style_ids || []),
    payload.style_family || null, payload.medium || null, signature, payload.source || null,
    Number(versionId), Number(dramaId)
  );
  return getVersion(db, versionId);
}

function mirrorVersionIntoMetadata(drama, version) {
  const meta = parseDramaMetadata(drama || {});
  meta.style_version = version.version;
  meta.style_prompt_zh = version.style_prompt_zh || '';
  meta.style_prompt_en = version.style_prompt_en || '';
  if (version.visual_bible) meta.visual_bible = version.visual_bible;
  else delete meta.visual_bible;
  if (version.visual_bible_struct) meta.visual_bible_struct = version.visual_bible_struct;
  else delete meta.visual_bible_struct;
  meta.storyboard_prompt_style_ids = version.prompt_style_ids || [];
  meta.style_family = version.style_family || undefined;
  meta.style_medium = version.medium || undefined;
  meta.generation_style_name = version.name || meta.generation_style_name || '';
  meta.generation_style_source = version.source || meta.generation_style_source || 'visual_style_version';
  const scope = version.scope_overrides || {};
  for (const key of ['character', 'scene', 'prop', 'storyboard', 'video']) {
    const prefix = `${key}_style_prompt`;
    if (scope[key]?.zh) meta[`${prefix}_zh`] = scope[key].zh;
    else delete meta[`${prefix}_zh`];
    if (scope[key]?.en) meta[`${prefix}_en`] = scope[key].en;
    else delete meta[`${prefix}_en`];
  }
  return meta;
}

function markProjectStale(db, dramaId, reason) {
  const now = new Date().toISOString();
  const storyboardCols = tableColumns(db, 'storyboards');
  const sceneCols = tableColumns(db, 'scenes');
  const characterCols = tableColumns(db, 'characters');
  const propCols = tableColumns(db, 'props');
  if (storyboardCols.has('prompt_state')) {
    const updatedAt = storyboardCols.has('updated_at') ? ', updated_at = ?' : '';
    const hasDeleted = storyboardCols.has('deleted_at');
    const episodeCols = tableColumns(db, 'episodes');
    const episodeDeleted = episodeCols.has('deleted_at') ? ' AND deleted_at IS NULL' : '';
    const params = updatedAt ? [now, Number(dramaId)] : [Number(dramaId)];
    db.prepare(`UPDATE storyboards SET prompt_state = 'stale_style'${updatedAt}
      WHERE episode_id IN (SELECT id FROM episodes WHERE drama_id = ?${episodeDeleted})${hasDeleted ? ' AND deleted_at IS NULL' : ''}`
    ).run(...params);
  }
  if (sceneCols.has('prompt_state')) {
    const updatedAt = sceneCols.has('updated_at') ? ', updated_at = ?' : '';
    const hasDeleted = sceneCols.has('deleted_at');
    const params = updatedAt ? [now, Number(dramaId)] : [Number(dramaId)];
    db.prepare(`UPDATE scenes SET prompt_state = 'stale_style'${updatedAt} WHERE drama_id = ?${hasDeleted ? ' AND deleted_at IS NULL' : ''}`).run(...params);
  }
  if (characterCols.has('prompt_state')) {
    const updatedAt = characterCols.has('updated_at') ? ', updated_at = ?' : '';
    const hasDeleted = characterCols.has('deleted_at');
    const params = updatedAt ? [now, Number(dramaId)] : [Number(dramaId)];
    db.prepare(`UPDATE characters SET prompt_state = 'stale_style'${updatedAt} WHERE drama_id = ?${hasDeleted ? ' AND deleted_at IS NULL' : ''}`).run(...params);
  }
  if (propCols.has('prompt_state')) {
    const updatedAt = propCols.has('updated_at') ? ', updated_at = ?' : '';
    const hasDeleted = propCols.has('deleted_at');
    const params = updatedAt ? [now, Number(dramaId)] : [Number(dramaId)];
    db.prepare(`UPDATE props SET prompt_state = 'stale_style'${updatedAt} WHERE drama_id = ?${hasDeleted ? ' AND deleted_at IS NULL' : ''}`).run(...params);
  }
  const jobCols = tableColumns(db, 'codex_image_jobs');
  if (jobCols.size) {
    const staleExpr = jobCols.has('stale_reason') ? ', stale_reason = ?' : '';
    const params = jobCols.has('stale_reason') ? [reason, now, reason, Number(dramaId)] : [reason, now, Number(dramaId)];
    db.prepare(`UPDATE codex_image_jobs SET status = 'cancelled', error_msg = ?, updated_at = ?${staleExpr}
      WHERE drama_id = ? AND deleted_at IS NULL AND status IN ('pending', 'generating', 'completed')`
    ).run(...params);
  }
}

function activateVersion(db, log, dramaId, versionId) {
  ensureSchema(db);
  const drama = getDrama(db, dramaId);
  const version = getVersion(db, versionId);
  if (!drama || !version || version.drama_id !== Number(dramaId)) return null;
  const now = new Date().toISOString();
  const reason = `项目统一视觉风格已更新至 v${version.version}，请重新编译或生成`;
  const tx = db.transaction(() => {
    db.prepare("UPDATE drama_visual_style_versions SET status = 'archived', superseded_at = ? WHERE drama_id = ? AND status = 'active' AND id != ?")
      .run(now, Number(dramaId), Number(versionId));
    db.prepare("UPDATE drama_visual_style_versions SET status = 'active', activated_at = ?, superseded_at = NULL WHERE id = ? AND drama_id = ?")
      .run(now, Number(versionId), Number(dramaId));
    const metadata = mirrorVersionIntoMetadata(drama, version);
    db.prepare(`UPDATE dramas SET style = ?, metadata = ?, active_visual_style_version_id = ?, active_visual_style_signature = ?, updated_at = ? WHERE id = ?`)
      .run(version.name || drama.style || '', JSON.stringify(metadata), Number(versionId), version.signature, now, Number(dramaId));
    markProjectStale(db, dramaId, reason);
  });
  tx();
  log?.info?.('[视觉风格] 已激活版本', { drama_id: Number(dramaId), version: version.version, signature: version.signature });
  return getVersion(db, versionId);
}

function impact(db, dramaId) {
  const did = Number(dramaId);
  const scenes = db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').get(did)?.n || 0;
  const storyboards = db.prepare(`SELECT COUNT(*) AS n FROM storyboards WHERE deleted_at IS NULL AND episode_id IN
    (SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL)`).get(did)?.n || 0;
  const stalePrompts = db.prepare(`SELECT COUNT(*) AS n FROM storyboards WHERE deleted_at IS NULL AND episode_id IN
    (SELECT id FROM episodes WHERE drama_id = ? AND deleted_at IS NULL) AND COALESCE(prompt_state, 'current') != 'current'`).get(did)?.n || 0;
  const pendingJobs = tableColumns(db, 'codex_image_jobs').size
    ? (db.prepare("SELECT COUNT(*) AS n FROM codex_image_jobs WHERE drama_id = ? AND deleted_at IS NULL AND status IN ('pending','generating')").get(did)?.n || 0)
    : 0;
  return { scenes: Number(scenes), storyboards: Number(storyboards), stale_prompts: Number(stalePrompts), pending_jobs: Number(pendingJobs) };
}

module.exports = {
  COMPILER_VERSION,
  ensureSchema,
  signatureForPayload,
  payloadFromDrama,
  ensureActiveVersion,
  getVersion,
  listVersions,
  createDraft,
  updateDraft,
  activateVersion,
  impact,
  markProjectStale,
  promptModuleSnapshots,
};
