'use strict';

const crypto = require('crypto');
const { resolveStylePreset } = require('../constants/generationStylePresets');

const SCOPE_META_FIELD_MAP = {
  character: ['character_style_prompt_zh', 'character_style_prompt_en'],
  scene: ['scene_style_prompt_zh', 'scene_style_prompt_en'],
  prop: ['prop_style_prompt_zh', 'prop_style_prompt_en'],
  video: ['video_style_prompt_zh', 'video_style_prompt_en'],
};

/**
 * 从剧集行解析画风：优先使用 metadata 里由前端写入的完整提示词（与 styleOptions 一致），
 * 否则退回 dramas.style（选项 value 时会展开为完整中英文提示词，与 frontweb styleOptions 一致）。
 */

function parseDramaMetadata(dramaRow) {
  if (!dramaRow?.metadata) return {};
  try {
    return typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
  } catch (_) {
    return {};
  }
}

function trimText(value) {
  return value != null ? String(value).trim() : '';
}

function styleFieldsFromDramaRow(dramaRow) {
  if (!dramaRow) {
    return {
      zh: '',
      en: '',
      legacy: '',
      characterZh: '',
      characterEn: '',
      sceneZh: '',
      sceneEn: '',
      propZh: '',
      propEn: '',
      videoZh: '',
      videoEn: '',
    };
  }
  const meta = parseDramaMetadata(dramaRow);
  const zh = trimText(meta.style_prompt_zh);
  const en = trimText(meta.style_prompt_en);
  const legacy = trimText(dramaRow.style);
  return {
    zh,
    en,
    legacy,
    characterZh: trimText(meta.character_style_prompt_zh || meta.character_style_zh || meta.character_style_prompt),
    characterEn: trimText(meta.character_style_prompt_en || meta.character_style_en),
    sceneZh: trimText(meta.scene_style_prompt_zh || meta.scene_style_zh || meta.scene_style_prompt),
    sceneEn: trimText(meta.scene_style_prompt_en || meta.scene_style_en),
    propZh: trimText(meta.prop_style_prompt_zh || meta.prop_style_zh || meta.prop_style_prompt),
    propEn: trimText(meta.prop_style_prompt_en || meta.prop_style_en),
    videoZh: trimText(meta.video_style_prompt_zh || meta.video_style_zh || meta.video_style_prompt),
    videoEn: trimText(meta.video_style_prompt_en || meta.video_style_en),
  };
}

function normalizeVisualBible(input) {
  if (input == null) return '';
  if (typeof input === 'string') {
    return input
      .split(/\r?\n/g)
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof input !== 'object') return String(input || '').trim();
  const entries = [
    ['Palette', input.palette || input.colors || input.color_palette],
    ['Lighting', input.lighting || input.light],
    ['Texture', input.texture || input.rendering || input.materials],
    ['Composition', input.composition || input.framing],
    ['Negative', input.negative || input.forbidden || input.avoid],
    ['Notes', input.notes || input.misc],
  ];
  return entries
    .map(([label, value]) => {
      const text = value != null ? String(value).trim() : '';
      return text ? `${label}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readVisualBibleFromDramaRow(dramaRow) {
  const meta = parseDramaMetadata(dramaRow);
  return normalizeVisualBible(meta.visual_bible || meta.visual_bible_text || '');
}

function readStyleVersionFromDramaRow(dramaRow) {
  const meta = parseDramaMetadata(dramaRow);
  const n = Number(meta.style_version);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function scopeFieldsForStyleObj(styleObj, scope) {
  const pair = SCOPE_META_FIELD_MAP[scope];
  if (!pair) return { zhKey: '', enKey: '' };
  return { zhKey: pair[0], enKey: pair[1] };
}

function joinStyleParts(parts, lang) {
  const seen = new Set();
  const out = [];
  for (const part of parts || []) {
    const text = trimText(part);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (!out.length) return '';
  return out.join(lang === 'zh' ? '，' : ', ');
}

function scopedStyleTextsFromStyleObject(styleObj, scope) {
  const baseZh = trimText(styleObj?.default_style_zh || styleObj?.default_style);
  const baseEn = trimText(styleObj?.default_style_en || styleObj?.default_style);
  const { zhKey, enKey } = scopeFieldsForStyleObj(styleObj, scope);
  const extraZh = zhKey ? trimText(styleObj?.[zhKey]) : '';
  const extraEn = enKey ? trimText(styleObj?.[enKey]) : '';
  return {
    zh: joinStyleParts([baseZh, extraZh], 'zh'),
    en: joinStyleParts([baseEn, extraEn], 'en'),
  };
}

function computeScopedStyleSignatureFromStyleObject(styleObj, scope) {
  const { zh, en } = scopedStyleTextsFromStyleObject(styleObj, scope);
  const visualBible = normalizeVisualBible(styleObj?.visual_bible || '');
  const payload = JSON.stringify({ scope, zh, en, visual_bible: visualBible });
  if (!zh && !en && !visualBible) return '';
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function computeVisualStyleSignatureFromSlots(styleObj) {
  const zh = trimText(styleObj?.default_style_zh || styleObj?.default_style);
  const en = trimText(styleObj?.default_style_en || styleObj?.default_style);
  const visualBible = normalizeVisualBible(styleObj?.visual_bible || '');
  const payload = JSON.stringify({
    zh,
    en,
    visual_bible: visualBible,
    character_zh: trimText(styleObj?.character_style_prompt_zh),
    character_en: trimText(styleObj?.character_style_prompt_en),
    scene_zh: trimText(styleObj?.scene_style_prompt_zh),
    scene_en: trimText(styleObj?.scene_style_prompt_en),
    prop_zh: trimText(styleObj?.prop_style_prompt_zh),
    prop_en: trimText(styleObj?.prop_style_prompt_en),
    video_zh: trimText(styleObj?.video_style_prompt_zh),
    video_en: trimText(styleObj?.video_style_prompt_en),
  });
  if (!zh && !en && !visualBible &&
    !trimText(styleObj?.character_style_prompt_zh) &&
    !trimText(styleObj?.character_style_prompt_en) &&
    !trimText(styleObj?.scene_style_prompt_zh) &&
    !trimText(styleObj?.scene_style_prompt_en) &&
    !trimText(styleObj?.prop_style_prompt_zh) &&
    !trimText(styleObj?.prop_style_prompt_en) &&
    !trimText(styleObj?.video_style_prompt_zh) &&
    !trimText(styleObj?.video_style_prompt_en)
  ) return '';
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function attachVisualStyleMetadata(styleObj, dramaRow) {
  const o = { ...(styleObj || {}) };
  const fields = styleFieldsFromDramaRow(dramaRow);
  const visualBible = readVisualBibleFromDramaRow(dramaRow);
  if (visualBible) o.visual_bible = visualBible;
  else delete o.visual_bible;
  if (fields.characterZh) o.character_style_prompt_zh = fields.characterZh;
  else delete o.character_style_prompt_zh;
  if (fields.characterEn) o.character_style_prompt_en = fields.characterEn;
  else delete o.character_style_prompt_en;
  if (fields.sceneZh) o.scene_style_prompt_zh = fields.sceneZh;
  else delete o.scene_style_prompt_zh;
  if (fields.sceneEn) o.scene_style_prompt_en = fields.sceneEn;
  else delete o.scene_style_prompt_en;
  if (fields.propZh) o.prop_style_prompt_zh = fields.propZh;
  else delete o.prop_style_prompt_zh;
  if (fields.propEn) o.prop_style_prompt_en = fields.propEn;
  else delete o.prop_style_prompt_en;
  if (fields.videoZh) o.video_style_prompt_zh = fields.videoZh;
  else delete o.video_style_prompt_zh;
  if (fields.videoEn) o.video_style_prompt_en = fields.videoEn;
  else delete o.video_style_prompt_en;
  o.style_version = readStyleVersionFromDramaRow(dramaRow);
  o.style_signature = computeVisualStyleSignatureFromSlots(o);
  o.character_style_signature = computeScopedStyleSignatureFromStyleObject(o, 'character');
  o.scene_style_signature = computeScopedStyleSignatureFromStyleObject(o, 'scene');
  o.prop_style_signature = computeScopedStyleSignatureFromStyleObject(o, 'prop');
  o.video_style_signature = computeScopedStyleSignatureFromStyleObject(o, 'video');
  return o;
}

function refreshCfgVisualStyleMetadata(cfg) {
  const nextStyle = attachVisualStyleMetadata(cfg?.style || {}, {
    metadata: {
      visual_bible: cfg?.style?.visual_bible || '',
      style_version: cfg?.style?.style_version,
      character_style_prompt_zh: cfg?.style?.character_style_prompt_zh || '',
      character_style_prompt_en: cfg?.style?.character_style_prompt_en || '',
      scene_style_prompt_zh: cfg?.style?.scene_style_prompt_zh || '',
      scene_style_prompt_en: cfg?.style?.scene_style_prompt_en || '',
      prop_style_prompt_zh: cfg?.style?.prop_style_prompt_zh || '',
      prop_style_prompt_en: cfg?.style?.prop_style_prompt_en || '',
      video_style_prompt_zh: cfg?.style?.video_style_prompt_zh || '',
      video_style_prompt_en: cfg?.style?.video_style_prompt_en || '',
    },
  });
  return { ...(cfg || {}), style: nextStyle };
}

function visualStyleStateFromDramaRow(dramaRow) {
  const {
    zh,
    en,
    legacy,
    characterZh,
    characterEn,
    sceneZh,
    sceneEn,
    propZh,
    propEn,
    videoZh,
    videoEn,
  } = styleFieldsFromDramaRow(dramaRow);
  let resolvedZh = zh;
  let resolvedEn = en;
  if (!resolvedZh && !resolvedEn && legacy) {
    const preset = resolveStylePreset(legacy);
    if (preset) {
      resolvedZh = preset.zh;
      resolvedEn = preset.en;
    } else {
      resolvedZh = legacy;
      resolvedEn = legacy;
    }
  }
  const visualBible = readVisualBibleFromDramaRow(dramaRow);
  const styleVersion = readStyleVersionFromDramaRow(dramaRow);
  const styleSignature = computeVisualStyleSignatureFromSlots({
    default_style_zh: resolvedZh,
    default_style_en: resolvedEn || resolvedZh,
    default_style: resolvedEn || resolvedZh,
    visual_bible: visualBible,
    character_style_prompt_zh: characterZh,
    character_style_prompt_en: characterEn,
    scene_style_prompt_zh: sceneZh,
    scene_style_prompt_en: sceneEn,
    prop_style_prompt_zh: propZh,
    prop_style_prompt_en: propEn,
    video_style_prompt_zh: videoZh,
    video_style_prompt_en: videoEn,
  });
  return {
    style_prompt_zh: resolvedZh,
    style_prompt_en: resolvedEn,
    visual_bible: visualBible,
    character_style_prompt_zh: characterZh,
    character_style_prompt_en: characterEn,
    scene_style_prompt_zh: sceneZh,
    scene_style_prompt_en: sceneEn,
    prop_style_prompt_zh: propZh,
    prop_style_prompt_en: propEn,
    video_style_prompt_zh: videoZh,
    video_style_prompt_en: videoEn,
    style_version: styleVersion,
    style_signature: styleSignature,
  };
}

function buildVisualStyleConstraintBlock(cfg, options = {}) {
  const visualBible = normalizeVisualBible(cfg?.style?.visual_bible || '');
  if (!visualBible) return '';
  const lang = options.language || (cfg?.app?.language === 'en' ? 'en' : 'zh');
  if (lang === 'en') {
    const heading = options.heading || 'VISUAL BIBLE (must follow)';
    return `${heading}\n${visualBible}`;
  }
  const heading = options.heading || '【统一视觉风格圣经（必须遵守）】';
  return `${heading}\n${visualBible}`;
}

function isStyleSignatureCurrent(cachedSignature, currentSignature) {
  const cached = String(cachedSignature || '').trim();
  const current = String(currentSignature || '').trim();
  return !!cached && !!current && cached === current;
}

/**
 * 若仅有 default_style 且为前端下拉 value（如 cartoon），展开为 zh/en 长文案；已有 zh/en 则不处理。
 */
function expandStyleSlotIfPresetKey(styleObj) {
  if (!styleObj || typeof styleObj !== 'object') return styleObj;
  const o = { ...styleObj };
  const zh = trimText(o.default_style_zh);
  const en = trimText(o.default_style_en);
  if (zh || en) return o;
  const d = trimText(o.default_style);
  if (!d) return o;
  const preset = resolveStylePreset(d);
  if (!preset) return o;
  o.default_style_zh = preset.zh;
  o.default_style_en = preset.en;
  o.default_style = preset.en || preset.zh;
  return o;
}

/**
 * 将剧集画风合并进 cfg.style（不修改原 cfg 引用外的对象）
 * @param {object} cfg
 * @param {{ style?: string, metadata?: string|object }|null|undefined} dramaRow
 */
function mergeCfgStyleWithDrama(cfg, dramaRow) {
  const { zh, en, legacy } = styleFieldsFromDramaRow(dramaRow);
  const base = { ...(cfg?.style || {}) };
  const hasMeta = !!(zh || en);
  if (hasMeta) {
    if (zh) base.default_style_zh = zh;
    else delete base.default_style_zh;
    if (en) base.default_style_en = en;
    else delete base.default_style_en;
    base.default_style = en || zh;
  } else if (legacy) {
    const preset = resolveStylePreset(legacy);
    if (preset) {
      base.default_style_zh = preset.zh;
      base.default_style_en = preset.en;
      base.default_style = preset.en || preset.zh;
    } else {
      // 自定义整段文案：双语槽位都写入，避免下游只读到「半句 key」
      base.default_style_zh = legacy;
      base.default_style_en = legacy;
      base.default_style = legacy;
    }
  }
  return { ...cfg, style: attachVisualStyleMetadata(expandStyleSlotIfPresetKey(base), dramaRow) };
}

/**
 * 分镜流式保存等：显式请求参数优先，否则用剧集 metadata/legacy，最后兜底 realistic
 */
function resolvedStreamStyleFromDrama(styleParam, dramaRow, scope = 'global') {
  const s = (styleParam && String(styleParam).trim()) || '';
  let merged = mergeCfgStyleWithDrama({}, dramaRow || {});
  if (s) {
    const p = resolveStylePreset(s);
    const explicit = p ? (p.en || p.zh) : s;
    merged = refreshCfgVisualStyleMetadata({
      ...merged,
      style: {
        ...(merged?.style || {}),
        default_style_zh: explicit,
        default_style_en: explicit,
        default_style: explicit,
      },
    });
  }
  const scoped = scopedStyleTextsFromStyleObject(merged?.style || {}, scope);
  return scoped.en || scoped.zh || 'realistic';
}

module.exports = {
  mergeCfgStyleWithDrama,
  styleFieldsFromDramaRow,
  resolvedStreamStyleFromDrama,
  parseDramaMetadata,
  normalizeVisualBible,
  readVisualBibleFromDramaRow,
  readStyleVersionFromDramaRow,
  computeVisualStyleSignatureFromSlots,
  computeScopedStyleSignatureFromStyleObject,
  scopedStyleTextsFromStyleObject,
  refreshCfgVisualStyleMetadata,
  visualStyleStateFromDramaRow,
  buildVisualStyleConstraintBlock,
  isStyleSignatureCurrent,
};
