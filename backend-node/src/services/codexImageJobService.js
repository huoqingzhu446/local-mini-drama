const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const storageLayout = require('./storageLayout');
const seedance2AssetGuards = require('../utils/seedance2AssetGuards');
const {
  mergeCfgStyleWithDrama,
  parseDramaMetadata,
  refreshCfgVisualStyleMetadata,
  buildVisualStyleConstraintBlock,
} = require('../utils/dramaStyleMerge');

const ENABLED_ENTITY_TYPES = new Set(['character', 'prop', 'scene', 'storyboard']);
const ACTIVE_STATUSES = new Set(['pending', 'generating', 'completed']);
const CATEGORY_BY_ENTITY = {
  character: 'characters',
  prop: 'props',
  scene: 'scenes',
  storyboard: 'storyboards',
};

function ensureCodexImageJobsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_image_jobs (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    drama_id INTEGER,
    episode_id INTEGER,
    frame_type TEXT DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'pending',
    prompt TEXT,
    negative_prompt TEXT,
    aspect_ratio TEXT,
    style TEXT,
    style_signature TEXT,
    source_snapshot TEXT,
    candidates TEXT,
    selected_candidate_id TEXT,
    applied_image_url TEXT,
    applied_local_path TEXT,
    error_msg TEXT,
    manifest_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    used_at TEXT,
    deleted_at TEXT
  )`);
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(codex_image_jobs)').all().map((row) => row.name));
    if (!cols.has('style_signature')) {
      db.exec('ALTER TABLE codex_image_jobs ADD COLUMN style_signature TEXT');
    }
  } catch (_) {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_entity ON codex_image_jobs(entity_type, entity_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_codex_image_jobs_drama ON codex_image_jobs(drama_id, status, updated_at)');
}

function storageBasePath(cfg) {
  const raw = cfg?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function codexJobsDir(cfg) {
  const dbPath = cfg?.database?.path || './data/drama_generator.db';
  const absDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  return path.join(path.dirname(absDbPath), 'codex-image-jobs');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return fallback;
  }
}

function stringifyJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch (_) {
    return new Set();
  }
}

function columnOrNull(columns, name) {
  return columns.has(name) ? name : `NULL AS ${name}`;
}

function normalizeFrameType(frameType) {
  let ft = String(frameType || 'main').trim();
  if (ft === 'storyboard_first' || ft === 'first_frame' || ft === 'head') ft = 'first';
  if (ft === 'storyboard_last' || ft === 'last_frame' || ft === 'tail') ft = 'last';
  return ft || 'main';
}

function frameTypeForImageGeneration(frameType) {
  const ft = normalizeFrameType(frameType);
  if (ft === 'first') return 'storyboard_first';
  if (ft === 'last') return 'storyboard_last';
  return ft;
}

function normalizeStorageRelPath(input) {
  if (input == null) return '';
  let s = String(input).trim();
  if (!s) return '';
  if (s.startsWith('/static/')) s = s.slice('/static/'.length);
  s = s.replace(/^[/\\]+/, '').replace(/\\/g, '/').split('?')[0];
  return s;
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function toStorageRelPath(storageBase, maybePath) {
  const raw = String(maybePath || '').trim();
  if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith('data:')) return '';
  if (raw.startsWith('/static/')) return normalizeStorageRelPath(raw);
  const normalizedRaw = normalizeStorageRelPath(raw);
  const asStorageRel = path.join(storageBase, normalizedRaw);
  if (fs.existsSync(asStorageRel)) return normalizedRaw;

  const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (fs.existsSync(abs) && isPathInside(storageBase, abs)) {
    return path.relative(storageBase, abs).replace(/\\/g, '/');
  }
  const dataStorageIdx = normalizedRaw.indexOf('data/storage/');
  if (dataStorageIdx >= 0) {
    const rel = normalizedRaw.slice(dataStorageIdx + 'data/storage/'.length);
    if (fs.existsSync(path.join(storageBase, rel))) return rel;
  }
  return '';
}

function candidateUrl(candidate) {
  if (!candidate) return '';
  const lp = normalizeStorageRelPath(candidate.local_path || '');
  if (lp) return `/static/${lp}`;
  return candidate.image_url || '';
}

function rowToJob(row) {
  if (!row) return null;
  const sourceSnapshot = parseJson(row.source_snapshot, null);
  const candidates = parseJson(row.candidates, []);
  const candidateList = Array.isArray(candidates)
    ? candidates.map((c) => ({ ...c, url: candidateUrl(c) }))
    : [];
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    drama_id: row.drama_id,
    episode_id: row.episode_id,
    frame_type: row.frame_type || 'main',
    status: row.status,
    prompt: row.prompt || '',
    negative_prompt: row.negative_prompt || '',
    aspect_ratio: row.aspect_ratio || '',
    style: row.style || '',
    style_signature: row.style_signature || '',
    source_snapshot: sourceSnapshot,
    candidates: candidateList,
    selected_candidate_id: row.selected_candidate_id || null,
    applied_image_url: row.applied_image_url || null,
    applied_local_path: row.applied_local_path || null,
    error_msg: row.error_msg || null,
    manifest_path: row.manifest_path || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    used_at: row.used_at,
  };
}

function listJobs(db, query = {}) {
  ensureCodexImageJobsTable(db);
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (query.drama_id != null && query.drama_id !== '') {
    where.push('drama_id = ?');
    params.push(Number(query.drama_id));
  }
  if (query.episode_id != null && query.episode_id !== '') {
    where.push('episode_id = ?');
    params.push(Number(query.episode_id));
  }
  if (query.entity_type) {
    where.push('entity_type = ?');
    params.push(String(query.entity_type));
  }
  if (query.entity_id != null && query.entity_id !== '') {
    where.push('entity_id = ?');
    params.push(Number(query.entity_id));
  }
  if (query.frame_type) {
    where.push('frame_type = ?');
    params.push(normalizeFrameType(query.frame_type));
  }
  if (query.status) {
    const statuses = String(query.status).split(',').map((x) => x.trim()).filter(Boolean);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size) || 50));
  const offset = (page - 1) * pageSize;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM codex_image_jobs WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM codex_image_jobs
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);
  return { items: rows.map(rowToJob), total, page, pageSize };
}

function getJobById(db, id) {
  ensureCodexImageJobsTable(db);
  const row = db.prepare('SELECT * FROM codex_image_jobs WHERE id = ? AND deleted_at IS NULL').get(String(id));
  return rowToJob(row);
}

function getDramaRow(db, dramaId) {
  const id = Number(dramaId);
  if (!id) return null;
  return db.prepare('SELECT id, title, style, metadata, created_at FROM dramas WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

function styleFromDrama(cfg, dramaRow, styleOverride) {
  const explicit = styleOverride != null ? String(styleOverride).trim() : '';
  if (explicit) return explicit;
  const merged = mergeCfgStyleWithDrama(cfg, dramaRow || {});
  return (
    merged?.style?.default_style_en ||
    merged?.style?.default_style ||
    merged?.style?.default_style_zh ||
    ''
  ).toString().trim();
}

function cfgWithStyleOverride(cfg, styleOverride) {
  const explicit = styleOverride != null ? String(styleOverride).trim() : '';
  if (!explicit) return cfg;
  return refreshCfgVisualStyleMetadata({
    ...cfg,
    style: {
      ...(cfg?.style || {}),
      default_style_zh: explicit,
      default_style_en: explicit,
      default_style: explicit,
    },
  });
}

function mergedDramaStyleCfg(cfg, dramaRow, styleOverride) {
  return cfgWithStyleOverride(mergeCfgStyleWithDrama(cfg, dramaRow || {}), styleOverride);
}

function styleSignatureFromDrama(cfg, dramaRow, styleOverride) {
  return (mergedDramaStyleCfg(cfg, dramaRow, styleOverride)?.style?.style_signature || '').toString().trim();
}

function aspectRatioFromDrama(cfg, dramaRow) {
  const meta = parseDramaMetadata(dramaRow || {});
  return (
    meta.aspect_ratio ||
    cfg?.style?.default_image_ratio ||
    cfg?.style?.default_video_ratio ||
    '16:9'
  ).toString();
}

function loadEntity(db, entityType, entityId) {
  const id = Number(entityId);
  if (!id) return null;
  if (entityType === 'character') {
    return db.prepare(
      `SELECT id, drama_id, name, role, description, personality, appearance, polished_prompt,
              negative_prompt, image_url, local_path, extra_images, ref_image
       FROM characters WHERE id = ? AND deleted_at IS NULL`
    ).get(id) || null;
  }
  if (entityType === 'prop') {
    return db.prepare(
      `SELECT id, drama_id, episode_id, name, type, description, prompt, negative_prompt,
              image_url, local_path, extra_images, ref_image
       FROM props WHERE id = ? AND deleted_at IS NULL`
    ).get(id) || null;
  }
  if (entityType === 'scene') {
    const columns = tableColumns(db, 'scenes');
    return db.prepare(
      `SELECT id, drama_id, episode_id, location, time, prompt,
              ${columnOrNull(columns, 'polished_prompt')},
              ${columnOrNull(columns, 'polished_prompt_single')},
              ${columnOrNull(columns, 'negative_prompt')},
              image_url, local_path,
              ${columnOrNull(columns, 'extra_images')},
              ${columnOrNull(columns, 'ref_image')}
       FROM scenes WHERE id = ? AND deleted_at IS NULL`
    ).get(id) || null;
  }
  if (entityType === 'storyboard') {
    const columns = tableColumns(db, 'storyboards');
    const sbCol = (name) => (columns.has(name) ? `sb.${name}` : `NULL AS ${name}`);
    return db.prepare(
      `SELECT sb.id, sb.episode_id, ep.drama_id, sb.scene_id, sb.storyboard_number,
              ${sbCol('title')}, ${sbCol('description')}, ${sbCol('location')}, ${sbCol('time')}, ${sbCol('duration')},
              ${sbCol('dialogue')}, ${sbCol('narration')}, ${sbCol('action')}, ${sbCol('result')}, ${sbCol('atmosphere')},
              ${sbCol('shot_type')}, ${sbCol('angle')}, ${sbCol('angle_h')}, ${sbCol('angle_v')}, ${sbCol('angle_s')}, ${sbCol('movement')},
              ${sbCol('image_prompt')}, ${sbCol('polished_prompt')}, ${sbCol('video_prompt')}, ${sbCol('layout_description')},
              ${sbCol('image_url')}, ${sbCol('local_path')}, ${sbCol('last_frame_image_url')}, ${sbCol('last_frame_local_path')},
              (SELECT fp.prompt FROM frame_prompts fp
               WHERE fp.storyboard_id = sb.id AND fp.frame_type IN ('first', 'storyboard_first', 'first_frame')
               ORDER BY fp.updated_at DESC, fp.created_at DESC LIMIT 1) AS first_frame_prompt,
              (SELECT fp.prompt FROM frame_prompts fp
               WHERE fp.storyboard_id = sb.id AND fp.frame_type IN ('last', 'storyboard_last', 'last_frame')
               ORDER BY fp.updated_at DESC, fp.created_at DESC LIMIT 1) AS last_frame_prompt
       FROM storyboards sb
       LEFT JOIN episodes ep ON ep.id = sb.episode_id AND ep.deleted_at IS NULL
       WHERE sb.id = ? AND sb.deleted_at IS NULL`
    ).get(id) || null;
  }
  return null;
}

function entityDisplayName(entityType, row) {
  if (entityType === 'character') return row.name || `character ${row.id}`;
  if (entityType === 'prop') return row.name || `prop ${row.id}`;
  if (entityType === 'scene') return [row.location, row.time].filter(Boolean).join(' ') || `scene ${row.id}`;
  if (entityType === 'storyboard') {
    const n = row.storyboard_number != null ? `#${row.storyboard_number}` : `#${row.id}`;
    return [n, row.title, row.location].filter(Boolean).join(' ');
  }
  return `${entityType} ${row.id}`;
}

function compactStoryboardText(row, frameType) {
  const ft = normalizeFrameType(frameType);
  const camera = [row.angle_h, row.angle_v, row.angle_s].filter(Boolean).join(', ') || row.angle;
  const fields = [
    ['Shot number', row.storyboard_number],
    ['Title', row.title],
    ['Description', row.description],
    ['Location', row.location],
    ['Time', row.time],
    ['Shot type', row.shot_type],
    ['Camera', camera],
    ['Movement', row.movement],
    ['Action', row.action],
    ['Dialogue', row.dialogue],
    ['Narration', row.narration],
    ['Result', row.result],
    ['Atmosphere', row.atmosphere],
    ['Layout anchor', row.layout_description],
  ];
  const lines = fields
    .map(([label, value]) => {
      const text = value != null ? String(value).trim() : '';
      return text ? `${label}: ${text}` : null;
    })
    .filter(Boolean);
  if (ft === 'first') lines.unshift('Frame role: FIRST FRAME / opening static image before the action evolves.');
  else if (ft === 'last') lines.unshift('Frame role: LAST FRAME / final static image after the action result.');
  else lines.unshift('Frame role: MAIN STORYBOARD REFERENCE IMAGE.');
  return lines.join('\n');
}

function pickPromptSource(entityType, row, opts = {}) {
  if (entityType === 'character') {
    if (row.polished_prompt && String(row.polished_prompt).trim()) return { key: 'polished_prompt', text: String(row.polished_prompt).trim() };
    if (row.appearance && String(row.appearance).trim()) return { key: 'appearance', text: String(row.appearance).trim() };
    if (row.description && String(row.description).trim()) return { key: 'description', text: String(row.description).trim() };
    return { key: 'name', text: row.name || '' };
  }
  if (entityType === 'prop') {
    if (row.prompt && String(row.prompt).trim()) return { key: 'prompt', text: String(row.prompt).trim() };
    if (row.description && String(row.description).trim()) return { key: 'description', text: String(row.description).trim() };
    return { key: 'name', text: row.name || '' };
  }
  if (entityType === 'scene') {
    if (row.polished_prompt_single && String(row.polished_prompt_single).trim()) return { key: 'polished_prompt_single', text: String(row.polished_prompt_single).trim() };
    if (row.prompt && String(row.prompt).trim()) return { key: 'prompt', text: String(row.prompt).trim() };
    return {
      key: 'location_time',
      text: [row.location ? `Location: ${row.location}` : '', row.time ? `Time: ${row.time}` : ''].filter(Boolean).join('\n'),
    };
  }
  if (entityType === 'storyboard') {
    const ft = normalizeFrameType(opts.frame_type);
    if (ft === 'first' && row.first_frame_prompt && String(row.first_frame_prompt).trim()) {
      return { key: 'first_frame_prompt', text: String(row.first_frame_prompt).trim() };
    }
    if (ft === 'last' && row.last_frame_prompt && String(row.last_frame_prompt).trim()) {
      return { key: 'last_frame_prompt', text: String(row.last_frame_prompt).trim() };
    }
    if (ft === 'main' && row.polished_prompt && String(row.polished_prompt).trim()) {
      return { key: 'polished_prompt', text: String(row.polished_prompt).trim() };
    }
    if (row.image_prompt && String(row.image_prompt).trim()) {
      return { key: 'image_prompt', text: String(row.image_prompt).trim() };
    }
    const text = compactStoryboardText(row, ft);
    return { key: `${ft}_storyboard_fields`, text: text || row.title || '' };
  }
  return { key: 'unknown', text: '' };
}

function buildCodexPrompt(entityType, row, dramaRow, cfg, opts = {}) {
  const source = pickPromptSource(entityType, row, opts);
  const style = styleFromDrama(cfg, dramaRow, opts.style);
  const styleCfg = mergedDramaStyleCfg(cfg, dramaRow, opts.style);
  const visualBibleBlock = buildVisualStyleConstraintBlock(styleCfg, { language: 'en', heading: 'Visual bible (must follow exactly):' });
  const aspectRatio = opts.aspect_ratio || aspectRatioFromDrama(cfg, dramaRow);
  const name = entityDisplayName(entityType, row);
  const frameType = normalizeFrameType(opts.frame_type);
  const assetKind = entityType === 'character' ? 'short drama character concept asset'
    : entityType === 'prop' ? 'short drama prop asset'
      : entityType === 'scene' ? 'short drama scene/background asset'
        : `short drama storyboard ${frameType} frame asset`;
  const lines = [
    `Use case: illustration-story`,
    `Asset type: ${assetKind}`,
    `Subject name: ${name}`,
    entityType === 'storyboard' ? `Storyboard frame type: ${frameType}` : '',
    dramaRow?.title ? `Drama title: ${dramaRow.title}` : '',
    style ? `Visual style: ${style}` : '',
    visualBibleBlock || '',
    `Aspect ratio: ${aspectRatio}`,
    '',
    'Primary request:',
    source.text || name,
    '',
    'Production constraints:',
    'Create a clean, high-quality concept image suitable for a local short-drama asset library.',
    'Keep the main subject clear, recognizable, and centered with enough framing margin.',
    entityType === 'storyboard' ? 'Render one cinematic frame only; no collage, no split screen, no storyboard grid, no multiple panels.' : '',
    'No visible subtitles, labels, watermarks, UI, logos, signature, or random text.',
    'Avoid extra unrelated characters or objects unless explicitly required by the description.',
  ].filter((line) => line !== null && line !== undefined);
  return {
    prompt: lines.join('\n'),
    prompt_source: source.key,
    style,
    style_signature: (styleCfg?.style?.style_signature || '').toString().trim(),
    aspect_ratio: aspectRatio,
  };
}

function activeJobForEntity(db, entityType, entityId, frameType, styleSignature) {
  const styleSig = String(styleSignature || '').trim();
  const row = db.prepare(
    `SELECT * FROM codex_image_jobs
     WHERE entity_type = ? AND entity_id = ? AND frame_type = ? AND deleted_at IS NULL
       AND status IN ('pending', 'generating', 'completed')
       ${styleSig ? 'AND style_signature = ?' : ''}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  ).get(...[entityType, Number(entityId), normalizeFrameType(frameType)].concat(styleSig ? [styleSig] : []));
  return rowToJob(row);
}

function jobManifestItem(job) {
  return {
    id: job.id,
    entity_type: job.entity_type,
    entity_id: job.entity_id,
    drama_id: job.drama_id,
    episode_id: job.episode_id,
    frame_type: job.frame_type,
    prompt: job.prompt,
    negative_prompt: job.negative_prompt || undefined,
    aspect_ratio: job.aspect_ratio || undefined,
    style: job.style || undefined,
    style_signature: job.style_signature || undefined,
    target_category: CATEGORY_BY_ENTITY[job.entity_type] || job.entity_type,
    status: job.status,
  };
}

function pendingJobs(db) {
  const rows = db.prepare(
    `SELECT * FROM codex_image_jobs
     WHERE deleted_at IS NULL AND status IN ('pending', 'generating')
     ORDER BY created_at ASC`
  ).all();
  return rows.map(rowToJob);
}

function writeJobsManifest(db, cfg) {
  ensureCodexImageJobsTable(db);
  const dir = codexJobsDir(cfg);
  ensureDir(dir);
  const manifestPath = path.join(dir, 'jobs.json');
  const jobs = pendingJobs(db);
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    storage_root: storageBasePath(cfg),
    result_import_hint: 'After generating images, write results.json and import it through /api/v1/codex-image-jobs/import-results or npm run codex:import-image-results -- --file <path>.',
    jobs: jobs.map(jobManifestItem),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
  db.prepare(
    `UPDATE codex_image_jobs SET manifest_path = ?, updated_at = ?
     WHERE deleted_at IS NULL AND status IN ('pending', 'generating')`
  ).run(manifestPath, new Date().toISOString());
  return { manifest_path: manifestPath, jobs: payload.jobs };
}

function createJob(db, log, cfg, req = {}) {
  ensureCodexImageJobsTable(db);
  const entityType = String(req.entity_type || '').trim();
  if (!ENABLED_ENTITY_TYPES.has(entityType)) {
    return { ok: false, error: 'entity_type must be character, prop, scene, or storyboard' };
  }
  const entityId = Number(req.entity_id);
  if (!entityId) return { ok: false, error: 'entity_id is required' };
  const frameType = normalizeFrameType(req.frame_type);
  const row = loadEntity(db, entityType, entityId);
  if (!row) return { ok: false, error: `${entityType} not found` };
  const dramaId = Number(req.drama_id || row.drama_id || 0) || null;
  const episodeId = req.episode_id != null ? Number(req.episode_id) || null : (row.episode_id != null ? Number(row.episode_id) : null);
  const dramaRow = getDramaRow(db, dramaId);
  const built = buildCodexPrompt(entityType, row, dramaRow, cfg, {
    style: req.style,
    aspect_ratio: req.aspect_ratio,
    frame_type: frameType,
  });
  const styleSignature = built.style_signature || '';
  if (!req.force) {
    const existing = activeJobForEntity(db, entityType, entityId, frameType, styleSignature);
    if (existing) {
      const manifest = writeJobsManifest(db, cfg);
      return { ok: true, job: existing, reused: true, manifest };
    }
  }
  const now = new Date().toISOString();
  const id = `cij_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const sourceSnapshot = {
    entity: row,
    drama: dramaRow ? { id: dramaRow.id, title: dramaRow.title, style: dramaRow.style, metadata: parseDramaMetadata(dramaRow) } : null,
    prompt_source: built.prompt_source,
    style_signature: styleSignature,
  };
  db.prepare(
    `INSERT INTO codex_image_jobs
     (id, entity_type, entity_id, drama_id, episode_id, frame_type, status, prompt, negative_prompt,
      aspect_ratio, style, style_signature, source_snapshot, candidates, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
  ).run(
    id,
    entityType,
    entityId,
    dramaId,
    episodeId,
    frameType,
    built.prompt,
    row.negative_prompt || null,
    built.aspect_ratio,
    built.style || null,
    styleSignature || null,
    stringifyJson(sourceSnapshot),
    now,
    now
  );
  const job = getJobById(db, id);
  const manifest = writeJobsManifest(db, cfg);
  log?.info?.('[Codex生图] 任务已加入队列', { id, entity_type: entityType, entity_id: entityId });
  return { ok: true, job, reused: false, manifest };
}

function invalidateJobsForDrama(db, log, cfg, dramaId, reason) {
  ensureCodexImageJobsTable(db);
  const why = String(reason || '项目视觉风格已变更，请重新生成').trim();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE codex_image_jobs
     SET status = 'cancelled', error_msg = ?, updated_at = ?
     WHERE drama_id = ? AND deleted_at IS NULL
       AND status IN ('pending', 'generating', 'completed')`
  ).run(why, now, Number(dramaId));
  if (result.changes > 0) {
    writeJobsManifest(db, cfg);
    log?.info?.('[Codex生图] 已失效旧风格任务', { drama_id: dramaId, count: result.changes });
  }
  return result.changes;
}

function candidateStorageDir(db, cfg, job, category) {
  const storageBase = storageBasePath(cfg);
  const projectSubdir = storageLayout.getProjectStorageSubdir(db, job.drama_id);
  return path.join(storageBase, projectSubdir, 'codex-candidates', category);
}

function finalStorageDir(db, cfg, job, category) {
  const storageBase = storageBasePath(cfg);
  const projectSubdir = storageLayout.getProjectStorageSubdir(db, job.drama_id);
  return path.join(storageBase, projectSubdir, category);
}

function copyIntoCandidateStorage(db, cfg, job, sourcePath, idx) {
  const category = CATEGORY_BY_ENTITY[job.entity_type] || job.entity_type;
  const dir = candidateStorageDir(db, cfg, job, category);
  ensureDir(dir);
  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const filename = `${job.id}_v${idx + 1}${ext}`;
  const dest = path.join(dir, filename);
  fs.copyFileSync(sourcePath, dest);
  return path.relative(storageBasePath(cfg), dest).replace(/\\/g, '/');
}

function normalizeCandidate(db, cfg, job, rawCandidate, idx) {
  const c = rawCandidate || {};
  const storageBase = storageBasePath(cfg);
  let localPath = toStorageRelPath(storageBase, c.local_path || c.path || c.file || '');
  const rawPath = String(c.path || c.file || '').trim();
  if (!localPath && rawPath && !/^https?:\/\//i.test(rawPath) && !rawPath.startsWith('data:')) {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    if (fs.existsSync(abs)) {
      localPath = copyIntoCandidateStorage(db, cfg, job, abs, idx);
    }
  }
  const imageUrl = c.image_url || c.url || (localPath ? `/static/${localPath}` : '');
  return {
    id: c.id || `${job.id}_c${idx + 1}`,
    local_path: localPath || null,
    image_url: imageUrl || null,
    prompt: c.prompt || job.prompt,
    width: c.width ?? null,
    height: c.height ?? null,
    created_at: c.created_at || new Date().toISOString(),
  };
}

function importResults(db, log, cfg, req = {}) {
  ensureCodexImageJobsTable(db);
  const items = Array.isArray(req.results) ? req.results
    : Array.isArray(req.jobs) ? req.jobs
      : Array.isArray(req.items) ? req.items
        : [req];
  const imported = [];
  const errors = [];
  const now = new Date().toISOString();
  for (const item of items) {
    const jobId = item?.job_id || item?.id;
    if (!jobId) {
      errors.push({ error: 'missing job_id' });
      continue;
    }
    const job = getJobById(db, jobId);
    if (!job) {
      errors.push({ job_id: jobId, error: 'job not found' });
      continue;
    }
    if (item.status === 'failed' || item.error || item.error_msg) {
      db.prepare(
        `UPDATE codex_image_jobs SET status = 'failed', error_msg = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`
      ).run(String(item.error || item.error_msg || 'Codex generation failed').slice(0, 1000), now, now, job.id);
      imported.push(getJobById(db, job.id));
      continue;
    }
    const rawCandidates = Array.isArray(item.candidates) ? item.candidates
      : Array.isArray(item.images) ? item.images
        : [{ local_path: item.local_path, path: item.path, image_url: item.image_url || item.url, prompt: item.prompt }];
    const candidates = rawCandidates
      .map((c, idx) => normalizeCandidate(db, cfg, job, c, idx))
      .filter((c) => c.local_path || c.image_url);
    if (!candidates.length) {
      errors.push({ job_id: job.id, error: 'no usable candidates' });
      continue;
    }
    db.prepare(
      `UPDATE codex_image_jobs
       SET status = 'completed', candidates = ?, error_msg = NULL, updated_at = ?, completed_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(candidates), now, now, job.id);
    imported.push(getJobById(db, job.id));
  }
  const manifest = writeJobsManifest(db, cfg);
  log?.info?.('[Codex生图] 导入结果完成', { imported: imported.length, errors: errors.length });
  return { imported, errors, manifest };
}

function parseExtraImages(raw) {
  const parsed = parseJson(raw, []);
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

function appendOldPrimaryToExtras(row, nextLocalPath, nextImageUrl) {
  const extras = parseExtraImages(row?.extra_images);
  const old = row?.local_path || row?.image_url || '';
  const next = nextLocalPath || nextImageUrl || '';
  if (old && old !== next && !extras.includes(old)) extras.push(old);
  return extras.length ? JSON.stringify(extras) : null;
}

function copyCandidateToFinal(db, cfg, job, candidate) {
  const category = CATEGORY_BY_ENTITY[job.entity_type] || job.entity_type;
  const localPath = normalizeStorageRelPath(candidate.local_path || '');
  if (!localPath) return { local_path: null, image_url: candidate.image_url || null };
  const storageBase = storageBasePath(cfg);
  const src = path.join(storageBase, localPath);
  if (!fs.existsSync(src)) return { local_path: localPath, image_url: candidate.image_url || `/static/${localPath}` };
  const dir = finalStorageDir(db, cfg, job, category);
  ensureDir(dir);
  const ext = path.extname(src).toLowerCase() || '.png';
  const filename = `codex_${job.entity_type}_${job.entity_id}_${Date.now()}${ext}`;
  const dest = path.join(dir, filename);
  if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  const rel = path.relative(storageBase, dest).replace(/\\/g, '/');
  return { local_path: rel, image_url: `/static/${rel}` };
}

function applyToCharacter(db, log, job, localPath, imageUrl) {
  const row = db.prepare('SELECT id, local_path, image_url, extra_images, seedance2_asset FROM characters WHERE id = ? AND deleted_at IS NULL').get(job.entity_id);
  if (!row) return { ok: false, error: 'character not found' };
  try {
    seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, row, { local_path: localPath, image_url: imageUrl });
  } catch (_) {}
  const extraJson = appendOldPrimaryToExtras(row, localPath, imageUrl);
  db.prepare(
    'UPDATE characters SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?'
  ).run(imageUrl || null, localPath || null, extraJson, new Date().toISOString(), job.entity_id);
  return { ok: true };
}

function applyToProp(db, job, localPath, imageUrl) {
  const row = db.prepare('SELECT id, local_path, image_url, extra_images FROM props WHERE id = ? AND deleted_at IS NULL').get(job.entity_id);
  if (!row) return { ok: false, error: 'prop not found' };
  const extraJson = appendOldPrimaryToExtras(row, localPath, imageUrl);
  db.prepare(
    'UPDATE props SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?'
  ).run(imageUrl || null, localPath || null, extraJson, new Date().toISOString(), job.entity_id);
  return { ok: true };
}

function applyToScene(db, job, localPath, imageUrl) {
  const row = db.prepare('SELECT id, local_path, image_url, extra_images FROM scenes WHERE id = ? AND deleted_at IS NULL').get(job.entity_id);
  if (!row) return { ok: false, error: 'scene not found' };
  const extraJson = appendOldPrimaryToExtras(row, localPath, imageUrl);
  db.prepare(
    "UPDATE scenes SET image_url = ?, local_path = ?, extra_images = ?, status = 'generated', updated_at = ? WHERE id = ?"
  ).run(imageUrl || null, localPath || null, extraJson, new Date().toISOString(), job.entity_id);
  return { ok: true };
}

function applyToStoryboard(db, log, job, localPath, imageUrl) {
  const row = db.prepare(
    `SELECT sb.id, sb.episode_id, ep.drama_id
     FROM storyboards sb
     LEFT JOIN episodes ep ON ep.id = sb.episode_id AND ep.deleted_at IS NULL
     WHERE sb.id = ? AND sb.deleted_at IS NULL`
  ).get(job.entity_id);
  if (!row) return { ok: false, error: 'storyboard not found' };
  if (!localPath && !imageUrl) return { ok: false, error: 'storyboard image path missing' };
  const imageService = require('./imageService');
  const uploaded = imageService.upload(db, log, {
    storyboard_id: job.entity_id,
    drama_id: job.drama_id || row.drama_id || null,
    prompt: job.prompt || '',
    image_url: imageUrl || (localPath ? `/static/${localPath}` : ''),
    local_path: localPath || null,
    frame_type: frameTypeForImageGeneration(job.frame_type),
  });
  if (!uploaded?.id) return { ok: false, error: 'failed to bind storyboard image' };
  return { ok: true, image_generation_id: uploaded.id };
}

function useCandidate(db, log, cfg, jobId, req = {}) {
  ensureCodexImageJobsTable(db);
  const job = getJobById(db, jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (job.status !== 'completed') return { ok: false, error: 'job is not completed' };
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  const candidateId = req.candidate_id || req.candidateId;
  const candidate = candidateId
    ? candidates.find((c) => c.id === candidateId || c.local_path === candidateId)
    : candidates[0];
  if (!candidate) return { ok: false, error: 'candidate not found' };
  const copied = copyCandidateToFinal(db, cfg, job, candidate);
  const localPath = copied.local_path || normalizeStorageRelPath(candidate.local_path || '');
  const imageUrl = copied.image_url || candidate.image_url || (localPath ? `/static/${localPath}` : null);
  let applied;
  if (job.entity_type === 'character') applied = applyToCharacter(db, log, job, localPath, imageUrl);
  else if (job.entity_type === 'prop') applied = applyToProp(db, job, localPath, imageUrl);
  else if (job.entity_type === 'scene') applied = applyToScene(db, job, localPath, imageUrl);
  else if (job.entity_type === 'storyboard') applied = applyToStoryboard(db, log, job, localPath, imageUrl);
  else applied = { ok: false, error: 'unsupported entity_type' };
  if (!applied.ok) return applied;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE codex_image_jobs
     SET status = 'used', selected_candidate_id = ?, applied_image_url = ?, applied_local_path = ?,
         updated_at = ?, used_at = ?
     WHERE id = ?`
  ).run(candidate.id, imageUrl, localPath, now, now, job.id);
  const manifest = writeJobsManifest(db, cfg);
  log?.info?.('[Codex生图] 候选图已应用', { job_id: job.id, entity_type: job.entity_type, entity_id: job.entity_id, local_path: localPath });
  return {
    ok: true,
    job: getJobById(db, job.id),
    image_url: imageUrl,
    local_path: localPath,
    image_generation_id: applied.image_generation_id || null,
    manifest,
  };
}

function cancelJob(db, cfg, jobId) {
  ensureCodexImageJobsTable(db);
  const job = getJobById(db, jobId);
  if (!job) return { ok: false, error: 'job not found' };
  if (!ACTIVE_STATUSES.has(job.status)) return { ok: false, error: 'job cannot be cancelled' };
  db.prepare(
    `UPDATE codex_image_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), job.id);
  const manifest = writeJobsManifest(db, cfg);
  return { ok: true, job: getJobById(db, job.id), manifest };
}

function exportPending(db, cfg) {
  ensureCodexImageJobsTable(db);
  return writeJobsManifest(db, cfg);
}

module.exports = {
  ensureCodexImageJobsTable,
  listJobs,
  getJobById,
  createJob,
  invalidateJobsForDrama,
  importResults,
  useCandidate,
  cancelJob,
  exportPending,
};
