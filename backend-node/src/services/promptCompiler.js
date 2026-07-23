'use strict';

const crypto = require('crypto');
const { normalizeVisualBible, parseDramaMetadata } = require('../utils/dramaStyleMerge');
const { normalizeImageQuality, codexQualityInstruction } = require('../utils/imageQuality');
const promptStyleService = require('./promptStyleService');
const visualStyleVersionService = require('./visualStyleVersionService');
const referencePackService = require('./referencePackService');
const generationContextService = require('./generationContextService');

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

function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch (_) { return null; }
}

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params) || []; } catch (_) { return []; }
}

function normalizeFrameType(frameType) {
  return referencePackService.normalizeFrameType(frameType);
}

function scopeForEntity(entityType) {
  if (entityType === 'character') return 'character';
  if (entityType === 'scene') return 'scene';
  if (entityType === 'prop') return 'prop';
  if (entityType === 'storyboard') return 'storyboard';
  return 'global';
}

function loadDrama(db, dramaId) {
  if (!Number(dramaId)) return null;
  const columns = tableColumns(db, 'dramas');
  if (!columns.size) return null;
  return safeGet(db, `SELECT * FROM dramas WHERE id = ?${columns.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(dramaId)]);
}

function selectFields(db, table, names) {
  const columns = tableColumns(db, table);
  return names.map((name) => columns.has(name) ? name : `NULL AS ${name}`).join(', ');
}

function loadEntity(db, entityType, entityId, frameType = 'main') {
  const id = Number(entityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (entityType === 'character') {
    const cols = tableColumns(db, 'characters');
    if (!cols.size) return null;
    return safeGet(db, `SELECT ${selectFields(db, 'characters', [
      'id', 'drama_id', 'name', 'role', 'description', 'personality', 'appearance', 'polished_prompt',
      'polished_prompt_style_signature', 'prompt_state', 'negative_prompt', 'image_url', 'local_path', 'extra_images', 'ref_image',
    ])} FROM characters WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [id]);
  }
  if (entityType === 'prop') {
    const cols = tableColumns(db, 'props');
    if (!cols.size) return null;
    return safeGet(db, `SELECT ${selectFields(db, 'props', [
      'id', 'drama_id', 'episode_id', 'name', 'type', 'description', 'prompt', 'prompt_style_signature', 'prompt_state',
      'negative_prompt', 'image_url', 'local_path', 'extra_images', 'ref_image',
    ])} FROM props WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [id]);
  }
  if (entityType === 'scene') {
    const cols = tableColumns(db, 'scenes');
    if (!cols.size) return null;
    return safeGet(db, `SELECT ${selectFields(db, 'scenes', [
      'id', 'drama_id', 'episode_id', 'location', 'time', 'prompt', 'polished_prompt', 'polished_prompt_style_signature',
      'polished_prompt_single', 'polished_prompt_single_style_signature', 'polished_prompt_nine', 'polished_prompt_nine_style_signature',
      'prompt_state', 'negative_prompt', 'image_url', 'local_path', 'reference_grid_image_url', 'reference_grid_local_path', 'extra_images', 'ref_image',
    ])} FROM scenes WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [id]);
  }
  if (entityType === 'storyboard') {
    const cols = tableColumns(db, 'storyboards');
    if (!cols.size) return null;
    const base = safeGet(db, `SELECT ${selectFields(db, 'storyboards', [
      'id', 'episode_id', 'scene_id', 'storyboard_number', 'title', 'description', 'location', 'time', 'duration',
      'dialogue', 'narration', 'action', 'result', 'atmosphere', 'characters', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s',
      'movement', 'lighting_style', 'depth_of_field', 'image_prompt', 'polished_prompt', 'polished_prompt_style_signature',
      'video_prompt', 'layout_description', 'continuity_snapshot', 'prompt_state', 'image_url', 'local_path', 'first_frame_image_id',
      'last_frame_image_url', 'last_frame_local_path',
    ])} FROM storyboards WHERE id = ?${cols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [id]);
    if (!base) return null;
    const epCols = tableColumns(db, 'episodes');
    const ep = safeGet(db, `SELECT ${selectFields(db, 'episodes', ['drama_id'])} FROM episodes WHERE id = ?${epCols.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`, [Number(base.episode_id)]);
    base.drama_id = ep?.drama_id || null;
    if (frameType === 'first' || frameType === 'last') {
      const fpCols = tableColumns(db, 'frame_prompts');
      if (fpCols.size) {
        const types = frameType === 'first' ? ['first', 'storyboard_first', 'first_frame'] : ['last', 'storyboard_last', 'last_frame'];
        const placeholders = types.map(() => '?').join(',');
        const fp = safeGet(db, `SELECT prompt FROM frame_prompts WHERE storyboard_id = ? AND frame_type IN (${placeholders}) ORDER BY updated_at DESC, created_at DESC LIMIT 1`, [id, ...types]);
        base[frameType === 'first' ? 'first_frame_prompt' : 'last_frame_prompt'] = fp?.prompt || '';
      }
    }
    return base;
  }
  return null;
}

function entityDramaId(entityType, row, fallback) {
  if (row?.drama_id) return Number(row.drama_id);
  if (entityType === 'storyboard' && row?.episode_id) {
    return Number(row.drama_id || fallback || 0) || null;
  }
  return Number(fallback) || null;
}

function compactStoryboardText(row, frameType) {
  const camera = [row.angle_h, row.angle_v, row.angle_s].filter(Boolean).join(', ') || row.angle || '';
  const fields = [
    ['Shot number', row.storyboard_number], ['Title', row.title], ['Description', row.description],
    ['Location', row.location], ['Time', row.time], ['Shot type', row.shot_type], ['Camera', camera],
    ['Movement', row.movement], ['Action', row.action], ['Dialogue', row.dialogue], ['Narration', row.narration],
    ['Result', row.result], ['Atmosphere', row.atmosphere], ['Layout anchor', row.layout_description],
  ];
  const lines = fields.map(([label, value]) => {
    const text = value == null ? '' : String(value).trim();
    return text ? `${label}: ${text}` : '';
  }).filter(Boolean);
  lines.unshift(`Frame role: ${frameType === 'first' ? 'FIRST FRAME / opening static image' : frameType === 'last' ? 'LAST FRAME / final static image' : 'MAIN STORYBOARD REFERENCE IMAGE'}.`);
  return lines.join('\n');
}

const LEGACY_STYLE_MARKERS = [
  /traditional\s+chinese\s+ink\s+wash/i,
  /sumi[- ]?e/i,
  /xuan\s+paper/i,
  /guohua/i,
  /国潮史诗厚涂/,
  /水墨/,
  /厚涂/,
  /塑料平滑数字渲染/,
  /AI工业CG/,
  /手绘原画质感/,
  /亚麻画布粗粝肌理/,
  /手工油画颜料堆叠笔触/,
  /中式工笔线条融合厚重油画大色块塑造/,
  /恢弘东方史诗叙事氛围感/,
  /电影级(?:全景|中景|宽幅)镜头/,
  /大透视张力构图/,
  /丁达尔自然体积光/,
  /烟尘云雾氛围感/,
  /实体油画扫描稿/,
  /胶片颗粒质感/,
  /8K超高清/,
  /轻微手绘自然瑕疵/,
  /艺术家原创手绘插画/,
  /弱化AI工业CG感/,
];

function hasLegacyStyleMarker(value) {
  return LEGACY_STYLE_MARKERS.some((pattern) => pattern.test(String(value || '')));
}

function cleanLegacyStyleClause(value) {
  let cleaned = String(value || '');
  for (const pattern of LEGACY_STYLE_MARKERS) cleaned = cleaned.replace(pattern, '');
  return cleaned.replace(/(?:无AI流水线模板感|无塑料平滑数字渲染|拒绝AI同质化完美建模|无机械对称布景)/g, '').trim();
}

/**
 * 从旧版“风格 + 内容”混合 prompt 中提取事实内容。
 * 旧项目把水墨、厚涂、CG 等媒介词直接拼进 image_prompt/prompt；
 * 这些字段不能再作为新版本的艺术方向来源。只清理已识别的旧风格
 * 片段，保留地点、人物、动作、道具和空间事实。
 */
function stripLegacyStyleLanguage(text, options = {}) {
  let value = String(text || '').trim();
  if (!value) return '';

  // 英文水墨模板常是一个连续长尾，先整体移除，避免逐词清理后残留。
  value = value.replace(/traditional\s+chinese\s+ink\s+wash[\s\S]*?guohua\s+style/ig, '');
  value = value.replace(/sumi[- ]?e\s+style[\s\S]*?guohua\s+style/ig, '');

  // 场景旧提示词的明确分区：取“场景”事实段，丢弃后面的旧色彩/画质
  // 风格段。reference_grid 也复用这个规则，避免九宫格把旧媒介带回分镜。
  if (options.scene) {
    const sceneStart = value.search(/(?:^|[。！？\n])\s*场景[：:]/);
    if (sceneStart >= 0) value = value.slice(sceneStart).replace(/^[。！？\n\s]+/, '');
    value = value.replace(/(?:[。！？\n]\s*)?(?:色彩光影|画质|美术风格|视觉风格|style\s*direction|color\s*and\s*lighting)[：:][\s\S]*$/i, '');
  }

  // 按短句/逗号拆分，只删除包含明确旧风格标记的片段；不删除“青铜、
  // 烟尘、火光”等本身属于故事事实或当前视觉圣经的词。
  const clauses = value
    .split(/[\n,，;；。！？]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(cleanLegacyStyleClause)
    .filter(Boolean);
  value = clauses.join('，');

  // 清理旧模板残留的纯背景/否定样式尾巴，但保留“无人场景”这一事实。
  value = value.replace(/(?:无AI流水线模板感|无塑料平滑数字渲染|拒绝AI同质化完美建模|无机械对称布景)/g, '');
  return value.replace(/[，,；;：:]\s*(?=[，,；;：:])/g, '').replace(/^[，,；;：:\s]+|[，,；;：:\s]+$/g, '').trim();
}

function sceneContentText(row, frameType) {
  const source = frameType === 'reference_grid'
    ? (row.polished_prompt_nine || row.polished_prompt_single || row.polished_prompt || row.prompt || '')
    : (row.prompt || row.location || '');
  return stripLegacyStyleLanguage(source, { scene: true }) || [row.location, row.time].filter(Boolean).join('，');
}

function storyboardContentText(row, frameType) {
  const structured = compactStoryboardText(row, frameType);
  const supplemental = stripLegacyStyleLanguage(row.image_prompt || '');
  // 结构化字段是事实来源；仅在它们不足以描述镜头时补充清理后的旧 image_prompt。
  if (supplemental && !structured.includes(supplemental)) {
    return `${structured}\nVisual content detail: ${supplemental}`;
  }
  return structured;
}

function rawSource(entityType, row, frameType) {
  if (!row) return { key: 'missing', text: '', cached: false, state: 'missing' };
  if (entityType === 'character') {
    if (row.polished_prompt) return { key: 'polished_prompt', text: String(row.polished_prompt).trim(), signature: row.polished_prompt_style_signature, state: row.prompt_state || 'current', cached: true };
    return { key: row.appearance ? 'appearance' : 'description', text: String(row.appearance || row.description || row.name || '').trim(), cached: false, state: row.prompt_state || 'current' };
  }
  if (entityType === 'prop') {
    return {
      key: row.prompt ? 'prompt' : 'description',
      text: String(row.prompt || row.description || row.name || '').trim(),
      signature: row.prompt_style_signature,
      state: row.prompt_state || 'current',
      // 道具 prompt 同样可能是旧视觉版本润色结果；有 prompt 时按缓存处理，
      // 让活动版本签名不一致时回退到 description/name，而不是把旧画风
      // 继续带入新生成请求。
      cached: !!row.prompt,
    };
  }
  if (entityType === 'paper_asset') {
    return {
      key: row.prompt ? 'paper_asset_prompt' : 'paper_asset_key',
      text: String(row.prompt || `${row.asset_type || 'paper asset'} ${row.asset_key || row.id || ''}`).trim(),
      state: 'current',
      cached: false,
    };
  }
  if (entityType === 'scene') {
    if (frameType === 'reference_grid' && row.polished_prompt_nine) return { key: 'polished_prompt_nine', text: String(row.polished_prompt_nine).trim(), signature: row.polished_prompt_nine_style_signature, state: row.prompt_state || 'current', cached: true };
    if (row.polished_prompt_single) return { key: 'polished_prompt_single', text: String(row.polished_prompt_single).trim(), signature: row.polished_prompt_single_style_signature, state: row.prompt_state || 'current', cached: true };
    if (row.polished_prompt) return { key: 'polished_prompt', text: String(row.polished_prompt).trim(), signature: row.polished_prompt_style_signature, state: row.prompt_state || 'current', cached: true };
    return {
      key: 'prompt',
      text: [row.location ? `Location: ${row.location}` : '', row.time ? `Time: ${row.time}` : '', sceneContentText(row, frameType)].filter(Boolean).join('\n').trim(),
      state: row.prompt_state || 'current', cached: false,
    };
  }
  if (entityType === 'storyboard') {
    const frameKey = frameType === 'first' ? 'first_frame_prompt' : frameType === 'last' ? 'last_frame_prompt' : '';
    if (frameKey && row[frameKey]) return { key: frameKey, text: stripLegacyStyleLanguage(row[frameKey]) || String(row[frameKey]).trim(), state: 'manual_override', cached: false, dedicated: true };
    if (row.polished_prompt) return { key: 'polished_prompt', text: String(row.polished_prompt).trim(), signature: row.polished_prompt_style_signature, state: row.prompt_state || 'current', cached: true };
    return { key: `${frameType}_storyboard_fields`, text: storyboardContentText(row, frameType), state: row.prompt_state || 'current', cached: false };
  }
  return { key: 'unknown', text: '', cached: false, state: 'missing' };
}

function positiveStyleClauses(text) {
  // 风格版本通常把排除项写在同一段 visual bible 中（例如
  // "impasto; Negative: no ink wash, no CGI"）。排除项不能被当成
  // 当前媒介，否则会把“禁止水墨”误报为“使用水墨”。按标点拆分后
  // 丢弃明确的 negative/avoid/no/禁止子句，同时保留前面的正向描述。
  return String(text || '')
    .split(/[\n,，;；。|]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !/^(?:negative|avoid|do not|don't|no\b|without\b|禁止|不要|不得|避免|无\b)/i.test(clause))
    .map((clause) => clause
      .replace(/\b(?:no|without|avoid|do not|don't)\b[^,，;；。|]*/ig, '')
      .replace(/(?:禁止|不要|不得|避免|无)[^,，;；。|]*/g, '')
      .trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function mediumTokens(text) {
  const value = positiveStyleClauses(text);
  const found = new Set();
  const patterns = [
    ['ink_wash', /ink\s*wash|水墨|水彩|国画|guohua|水墨画/],
    ['impasto', /impasto|厚涂|油画|oil\s*paint|painted\s*concept|手绘概念/],
    ['photoreal', /photoreal|photo[- ]?real|写实摄影|真实摄影|live[- ]?action/],
    ['cgi', /cgi|3d\s*(render|art)|塑料|octane|unreal\s*engine|blender/],
    ['anime', /anime|manga|二次元|赛璐璐|cel\s*shad/],
  ];
  for (const [key, pattern] of patterns) if (pattern.test(value)) found.add(key);
  return [...found];
}

function mediumConflict(active, candidate) {
  const a = new Set(active || []);
  const c = new Set(candidate || []);
  if (!a.size || !c.size) return false;
  const incompatible = [
    ['ink_wash', 'impasto'], ['ink_wash', 'photoreal'], ['ink_wash', 'cgi'], ['ink_wash', 'anime'],
    ['photoreal', 'anime'], ['photoreal', 'cgi'], ['impasto', 'cgi'],
  ];
  return incompatible.some(([x, y]) => (a.has(x) && c.has(y)) || (a.has(y) && c.has(x)));
}

function inferStyleMedium(version) {
  const explicit = mediumTokens(version?.medium || '');
  if (explicit.length) return explicit;
  return mediumTokens([
    version?.style_prompt_en, version?.style_prompt_zh, version?.visual_bible,
    version?.style_family, version?.name,
  ].filter(Boolean).join('\n'));
}

function normalizeScopeOverride(version, scope) {
  const item = version?.scope_overrides?.[scope] || {};
  return [item.en, item.zh].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
}

function moduleList(db, version) {
  if (Array.isArray(version?.prompt_modules)) return version.prompt_modules.slice();
  try { return promptStyleService.getEnabledStylesByIds(db, version?.prompt_style_ids || []); } catch (_) { return []; }
}

function stylePayloadFromConfig(cfg, dramaRow) {
  const meta = parseDramaMetadata(dramaRow || {});
  const style = cfg?.style || {};
  return {
    style_prompt_zh: meta.style_prompt_zh || style.default_style_zh || style.default_style || dramaRow?.style || '',
    style_prompt_en: meta.style_prompt_en || style.default_style_en || style.default_style || dramaRow?.style || '',
    visual_bible: normalizeVisualBible(meta.visual_bible || style.visual_bible || ''),
    scope_overrides: {},
    style_family: meta.style_family || '',
    medium: meta.style_medium || '',
    prompt_modules: [],
    signature: style.style_signature || '',
    id: null,
    version: Number(meta.style_version) || 0,
    compiler_version: COMPILER_VERSION,
    name: dramaRow?.style || 'legacy style',
  };
}

function resolveVersion(db, dramaId, cfg, options = {}) {
  if (Number(options.style_version_id)) {
    const selected = visualStyleVersionService.getVersion(db, Number(options.style_version_id));
    if (selected && (!dramaId || selected.drama_id === Number(dramaId))) return selected;
  }
  if (Number(dramaId)) {
    try {
      const active = visualStyleVersionService.ensureActiveVersion(db, Number(dramaId));
      if (active) return active;
    } catch (_) {}
  }
  return stylePayloadFromConfig(cfg, loadDrama(db, dramaId));
}

function storyboardContinuity(db, row) {
  if (!row?.episode_id || row.storyboard_number == null) return null;
  const previous = safeGet(db, `SELECT action, location, time, continuity_snapshot FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1`, [Number(row.episode_id), Number(row.storyboard_number)]);
  const next = safeGet(db, `SELECT action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1`, [Number(row.episode_id), Number(row.storyboard_number)]);
  return {
    previous: previous ? { action: previous.action || '', location: previous.location || '', time: previous.time || '', continuity_snapshot: parseJson(previous.continuity_snapshot, null) } : null,
    next: next ? { action: next.action || '', location: next.location || '', time: next.time || '' } : null,
  };
}

function contentBlock(entityType, row, source, frameType) {
  const lines = [`CONTENT / ACTION (use as factual story content; do not replace the art direction):`, source.text || ''];
  if (entityType === 'character' && row.name) lines.push(`Subject name: ${String(row.name).trim()}`);
  if (entityType === 'prop' && row.name) lines.push(`Object name: ${String(row.name).trim()}`);
  if (entityType === 'paper_asset') {
    if (row.asset_type) lines.push(`Paper asset type: ${String(row.asset_type).trim()}`);
    if (row.asset_key) lines.push(`Paper asset key: ${String(row.asset_key).trim()}`);
  }
  if (entityType === 'scene' && row.location) lines.push(`Scene location: ${String(row.location).trim()}`);
  if (entityType === 'storyboard') {
    const fields = [
      ['Action', row.action], ['Dialogue', row.dialogue], ['Narration', row.narration], ['Result', row.result],
      ['Atmosphere', row.atmosphere], ['Shot type', row.shot_type],
      ['Camera angle', [row.angle_h, row.angle_v, row.angle_s].filter(Boolean).join(', ') || row.angle],
      ['Movement', row.movement], ['Layout', row.layout_description],
    ];
    for (const [label, value] of fields) if (value) lines.push(`${label}: ${String(value).trim()}`);
    lines.push(`Frame role: ${frameType}`);
  }
  return lines.filter(Boolean).join('\n');
}

function negativeBlock(row, version, entityType, frameType, diagnostics) {
  const negatives = [];
  if (row?.negative_prompt) negatives.push(String(row.negative_prompt).trim());
  const vb = version?.visual_bible_struct || parseJson(version?.visual_bible_struct, null);
  if (vb?.negative) negatives.push(String(vb.negative).trim());
  if (entityType === 'storyboard') negatives.push('no collage, no split screen, no storyboard grid, no multiple panels, no camera-motion blur, no visible subtitles, no watermark, no logo, no random text');
  else if (entityType === 'scene' && frameType === 'reference_grid') negatives.push('no people, no characters, no human silhouettes, no readable text, no borders, no divider lines, no watermark');
  else negatives.push('no visible subtitles, no labels, no watermark, no logo, no random text');
  return [...new Set(negatives.filter(Boolean))].join(', ');
}

function compilePrompt(db, cfg, options = {}) {
  const entityType = String(options.entity_type || options.entityType || '').trim();
  const entityId = Number(options.entity_id ?? options.entityId);
  const frameType = normalizeFrameType(options.frame_type ?? options.frameType);
  if (!entityType || !Number.isFinite(entityId) || entityId <= 0) {
    return { ok: false, error: 'entity_type and entity_id are required' };
  }
  const row = options.entity || loadEntity(db, entityType, entityId, frameType);
  if (!row) return { ok: false, error: `${entityType} not found` };
  const dramaId = entityDramaId(entityType, row, options.drama_id);
  const drama = options.drama || loadDrama(db, dramaId);
  const version = resolveVersion(db, dramaId, cfg, options);
  const activeMedium = inferStyleMedium(version);
  const source = options.prompt != null && String(options.prompt).trim()
    ? { key: 'request_prompt', text: String(options.prompt).trim(), state: 'manual_override', cached: false, dedicated: true }
    : rawSource(entityType, row, frameType);
  const diagnostics = [];
  const expectedSignature = String(version?.signature || '').trim();
  const cachedSignature = String(source.signature || '').trim();
  const cacheCurrent = !!source.cached && !!cachedSignature && !!expectedSignature && cachedSignature === expectedSignature;
  const manualOverride = source.state === 'manual_override' || row.prompt_state === 'manual_override';
  const staleContentState = !!source.state && !['current', 'compiled_v2'].includes(source.state) && !manualOverride;
  let sourceForCompile = source;
  if (source.cached && ((expectedSignature && !cacheCurrent) || staleContentState) && !manualOverride) {
    diagnostics.push({ code: 'STALE_POLISHED_PROMPT', severity: 'warning', message: staleContentState ? '缓存润色提示词对应的内容或引用已过期，已降级为结构化原始字段。' : '缓存润色提示词对应旧视觉版本，已降级为原始内容字段。', cached_signature: cachedSignature || null, current_signature: expectedSignature || null });
    sourceForCompile = rawSourceWithoutCache(entityType, row, frameType);
  } else if (source.cached && !cachedSignature && expectedSignature) {
    diagnostics.push({ code: 'UNSIGNED_POLISHED_PROMPT', severity: 'warning', message: '缓存润色提示词没有版本签名，已降级为原始内容字段。' });
    sourceForCompile = rawSourceWithoutCache(entityType, row, frameType);
  }
  if (manualOverride) diagnostics.push({ code: 'MANUAL_CONTENT_OVERRIDE', severity: 'info', message: '手动覆盖内容被保留，但仍置于当前项目视觉风格之下。' });
  if (source.state && source.state !== 'current' && !manualOverride) {
    diagnostics.push({ code: 'PROMPT_STATE_STALE', severity: 'warning', message: `实体提示词状态为 ${source.state}。` });
  }

  const styleGlobal = [version?.style_prompt_en, version?.style_prompt_zh, options.style].filter(Boolean).map((item) => String(item).trim()).filter(Boolean).join('\n').trim();
  const scopeText = normalizeScopeOverride(version, scopeForEntity(entityType));
  const modules = moduleList(db, version).sort((a, b) => (Number(a.priority) || 50) - (Number(b.priority) || 50));
  const moduleBlocks = [];
  for (const module of modules) {
    const text = String(module.content || '').trim();
    if (!text) continue;
    const candidateMedium = mediumTokens([module.medium, ...(module.compatibility_tags || []), text].join('\n'));
    if (mediumConflict(activeMedium, candidateMedium)) {
      diagnostics.push({ code: 'MEDIUM_CONFLICT', severity: 'warning', module_id: module.id, module_name: module.name, active_medium: activeMedium, module_medium: candidateMedium, message: `已跳过与当前主媒介冲突的风格模块：${module.name || module.id}` });
      continue;
    }
    const role = module.role || 'constraint';
    moduleBlocks.push(`MODULE [${role}] ${module.name || `#${module.id}`}\n${text}`);
  }

  const referencePack = referencePackService.buildReferencePack(db, {
    entity_type: entityType,
    entity_id: entityId,
    frame_type: frameType,
    limits: options.reference_limits || options.limits,
    reference_images: options.reference_images || options.referenceImages,
    use_first_frame_layout_lock: options.use_first_frame_layout_lock,
    allow_stale_references: options.allow_stale_references || options.allowStaleReferences,
  });
  diagnostics.push(...(referencePack.diagnostics || []));
  const continuity = entityType === 'storyboard' ? storyboardContinuity(db, row) : null;
  const blocks = [];
  const contract = entityType === 'scene' && frameType === 'reference_grid'
    ? 'OUTPUT CONTRACT: Create one 3x3 scene reference board with exactly nine equal landscape views of the same physical scene.'
    : entityType === 'scene' && ['scene_four_view', 'four_view'].includes(frameType)
      ? 'OUTPUT CONTRACT: Create one 2x2 scene reference board with exactly four equal landscape views of the same physical scene; no characters and no unrelated locations.'
      : entityType === 'character' && ['character_four_view', 'four_view'].includes(frameType)
        ? 'OUTPUT CONTRACT: Create one 2x2 character turnaround reference sheet with exactly four consistent views of the same character; preserve identity, costume, body proportions, palette, and material across all views.'
    : entityType === 'storyboard'
      ? `OUTPUT CONTRACT: Create exactly one cinematic ${frameType} storyboard frame, one continuous full image, never a collage or multi-panel layout.`
      : 'OUTPUT CONTRACT: Create one clean production asset image suitable for a local short-drama visual library.';
  blocks.push(contract);
  if (entityType === 'scene' && frameType === 'reference_grid') {
    blocks.push(`SCENE REFERENCE BOARD LAYOUT:\n1. ultra-wide establishing view; 2. main activity zone; 3. entrance or transition path; 4. reverse angle; 5. hero master view; 6. signature material detail; 7. elevated spatial layout; 8. low-angle depth view; 9. atmospheric empty view. Keep one identical architecture, period, palette, lighting logic, and material language across all nine panels. No people.`);
  }
  if (entityType === 'scene' && ['scene_four_view', 'four_view'].includes(frameType)) {
    blocks.push('SCENE FOUR-VIEW LAYOUT: top-left establishing front view; top-right reverse view; bottom-left elevated spatial view; bottom-right low-angle depth view. Keep one identical architecture, period, weather, palette, lighting, and material language. No people, no labels, no panel borders.');
  }
  if (entityType === 'character' && ['character_four_view', 'four_view'].includes(frameType)) {
    blocks.push('CHARACTER FOUR-VIEW LAYOUT: top-left front full body; top-right three-quarter full body; bottom-left side full body; bottom-right back full body. Same person, facial identity, hairstyle, costume, accessories, proportions, and neutral studio scale in every panel. No labels or panel borders.');
  }
  if (styleGlobal) blocks.push(`GLOBAL ART DIRECTION (authoritative across the entire drama):\n${styleGlobal}`);
  if (version?.visual_bible) blocks.push(`VISUAL BIBLE (authoritative; preserve across characters, props, scenes, and shots):\n${version.visual_bible}`);
  if (scopeText) blocks.push(`SCOPE OVERLAY (${scopeForEntity(entityType)}):\n${scopeText}`);
  if (moduleBlocks.length) blocks.push(`PROMPT STYLE MODULES (apply only compatible modules):\n${moduleBlocks.join('\n\n')}`);
  if (entityType === 'storyboard' && row.scene_id) {
    const scene = safeGet(db, `SELECT location, time, prompt, image_url, local_path FROM scenes WHERE id = ? AND deleted_at IS NULL`, [Number(row.scene_id)]);
    if (scene) blocks.push(`SCENE CONTINUITY (the storyboard must belong to this established space):\nLocation: ${scene.location || row.location || ''}\nTime: ${scene.time || row.time || ''}\n${stripLegacyStyleLanguage(scene.prompt || '', { scene: true })}`.trim());
  }
  if (continuity) {
    const prev = continuity.previous ? JSON.stringify(continuity.previous) : '(first shot)';
    const next = continuity.next ? JSON.stringify(continuity.next) : '(last shot)';
    blocks.push(`SHOT CONTINUITY:\nPrevious shot: ${prev}\nNext shot: ${next}`);
  }
  blocks.push(contentBlock(entityType, row, sourceForCompile, frameType));
  if (options.aspect_ratio || cfg?.style?.default_image_ratio) blocks.push(`ASPECT RATIO: ${options.aspect_ratio || cfg?.style?.default_image_ratio}`);
  if (options.quality) blocks.push(codexQualityInstruction(normalizeImageQuality(options.quality)));
  blocks.push(`STYLE LOCK: The current project art direction and visual bible outrank any style words embedded in the content. Keep the same medium, palette, lighting logic, material language, historical period, and rendering discipline across the asset set.`);
  const compiledPrompt = blocks.filter(Boolean).join('\n\n').trim();
  const compiledNegativePrompt = [
    negativeBlock(row, version, entityType, frameType, diagnostics),
    options.negative_prompt ? String(options.negative_prompt).trim() : '',
  ].filter(Boolean).join(', ');
  const promptHash = generationContextService.hashValue(compiledPrompt);
  const sourceSnapshot = {
    entity: row,
    drama: drama ? { id: drama.id, title: drama.title, style: drama.style, metadata: parseDramaMetadata(drama) } : null,
    style_version: version ? { id: version.id || null, version: version.version || 0, signature: version.signature || '', name: version.name || '' } : null,
    source_key: sourceForCompile.key,
    source_state: sourceForCompile.state || 'current',
    cache_current: cacheCurrent,
    manual_override: manualOverride,
  };
  return {
    ok: true,
    entity_type: entityType,
    entity_id: entityId,
    drama_id: dramaId,
    episode_id: row.episode_id == null ? null : Number(row.episode_id),
    scene_id: entityType === 'scene' ? entityId : (row.scene_id == null ? null : Number(row.scene_id)),
    storyboard_id: entityType === 'storyboard' ? entityId : null,
    frame_type: frameType,
    prompt: compiledPrompt,
    compiled_prompt: compiledPrompt,
    negative_prompt: compiledNegativePrompt,
    compiled_negative_prompt: compiledNegativePrompt,
    prompt_source: sourceForCompile.key,
    source_prompt: sourceForCompile.text || '',
    style: styleGlobal,
    style_signature: expectedSignature,
    style_version_id: version?.id || null,
    style_version: version?.version || 0,
    style_state: version?.status || 'legacy',
    prompt_state: sourceForCompile.state || 'current',
    aspect_ratio: options.aspect_ratio || cfg?.style?.default_image_ratio || '16:9',
    quality: normalizeImageQuality(options.quality),
    reference_pack: referencePack,
    reference_images: referencePack.reference_images,
    reference_hash: referencePack.hash,
    prompt_hash: promptHash,
    compiler_version: COMPILER_VERSION,
    diagnostics,
    blocks,
    source_snapshot: sourceSnapshot,
  };
}

function rawSourceWithoutCache(entityType, row, frameType) {
  const clone = { ...row };
  if (entityType === 'character') clone.polished_prompt = '';
  if (entityType === 'scene') {
    // 九宫格提示词主要承载空间分区和镜头清单；即使旧版本没有签名，也保留其
    // 场景事实细节，并由后面的 STYLE LOCK 明确禁止它改写当前媒介。
    if (frameType === 'reference_grid' && row.polished_prompt_nine) {
      return { key: 'legacy_scene_reference_grid_content', text: stripLegacyStyleLanguage(row.polished_prompt_nine, { scene: true }), state: row.prompt_state || 'stale_style', cached: false, legacy_content: true };
    }
    clone.polished_prompt = '';
    clone.polished_prompt_single = '';
    clone.polished_prompt_nine = '';
  }
  if (entityType === 'prop') clone.prompt = '';
  if (entityType === 'storyboard') clone.polished_prompt = '';
  return rawSource(entityType, clone, frameType);
}

function validateCachedPrompt(row, styleSignature, field = 'polished_prompt_style_signature') {
  const prompt = String(row?.polished_prompt || '').trim();
  const signature = String(row?.[field] || '').trim();
  return !!prompt && !!signature && !!styleSignature && signature === String(styleSignature).trim();
}

module.exports = {
  COMPILER_VERSION,
  parseJson,
  positiveStyleClauses,
  stripLegacyStyleLanguage,
  sceneContentText,
  storyboardContentText,
  tableColumns,
  loadDrama,
  loadEntity,
  normalizeFrameType,
  mediumTokens,
  mediumConflict,
  resolveVersion,
  validateCachedPrompt,
  compile: compilePrompt,
  compilePrompt,
};
