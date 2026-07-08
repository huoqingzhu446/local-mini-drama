'use strict';

const crypto = require('crypto');
const { resolveStylePreset } = require('../constants/generationStylePresets');

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

function styleFieldsFromDramaRow(dramaRow) {
  if (!dramaRow) return { zh: '', en: '', legacy: '' };
  const meta = parseDramaMetadata(dramaRow);
  const zh = meta.style_prompt_zh != null ? String(meta.style_prompt_zh).trim() : '';
  const en = meta.style_prompt_en != null ? String(meta.style_prompt_en).trim() : '';
  const legacy = dramaRow.style != null ? String(dramaRow.style).trim() : '';
  return { zh, en, legacy };
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

function computeVisualStyleSignatureFromSlots(styleObj) {
  const zh = (styleObj?.default_style_zh || '').toString().trim();
  const en = (styleObj?.default_style_en || styleObj?.default_style || '').toString().trim();
  const visualBible = normalizeVisualBible(styleObj?.visual_bible || '');
  const payload = JSON.stringify({ zh, en, visual_bible: visualBible });
  if (!zh && !en && !visualBible) return '';
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function attachVisualStyleMetadata(styleObj, dramaRow) {
  const o = { ...(styleObj || {}) };
  const visualBible = readVisualBibleFromDramaRow(dramaRow);
  if (visualBible) o.visual_bible = visualBible;
  else delete o.visual_bible;
  o.style_version = readStyleVersionFromDramaRow(dramaRow);
  o.style_signature = computeVisualStyleSignatureFromSlots(o);
  return o;
}

function refreshCfgVisualStyleMetadata(cfg) {
  const nextStyle = attachVisualStyleMetadata(cfg?.style || {}, {
    metadata: {
      visual_bible: cfg?.style?.visual_bible || '',
      style_version: cfg?.style?.style_version,
    },
  });
  return { ...(cfg || {}), style: nextStyle };
}

function visualStyleStateFromDramaRow(dramaRow) {
  const { zh, en, legacy } = styleFieldsFromDramaRow(dramaRow);
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
  });
  return {
    style_prompt_zh: resolvedZh,
    style_prompt_en: resolvedEn,
    visual_bible: visualBible,
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
  const zh = (o.default_style_zh || '').toString().trim();
  const en = (o.default_style_en || '').toString().trim();
  if (zh || en) return o;
  const d = (o.default_style || '').toString().trim();
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
function resolvedStreamStyleFromDrama(styleParam, dramaRow) {
  const s = (styleParam && String(styleParam).trim()) || '';
  if (s) {
    const p = resolveStylePreset(s);
    return p ? (p.en || p.zh) : s;
  }
  const { zh, en, legacy } = styleFieldsFromDramaRow(dramaRow);
  if (en || zh) return en || zh;
  if (legacy) {
    const p = resolveStylePreset(legacy);
    return p ? (p.en || p.zh) : legacy;
  }
  return 'realistic';
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
  refreshCfgVisualStyleMetadata,
  visualStyleStateFromDramaRow,
  buildVisualStyleConstraintBlock,
  isStyleSignatureCurrent,
};
