'use strict';

function normalizeAffectedPartKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((key) => String(key || '').trim()).filter(Boolean))];
}

function normalizeClipPath(value) {
  if (typeof value === 'string') {
    const clip = value.trim();
    // Only CSS clip-path functions are accepted; declarations, URLs and
    // separators are rejected so a snapshot cannot inject arbitrary styles.
    if (!clip || clip.length > 4096 || !/^(?:polygon|path|circle|ellipse|inset)\s*\(/i.test(clip) || /[;{}]/.test(clip)) return null;
    return clip;
  }
  // Authoring tools may send normalized polygon points even though the
  // snapshot contract primarily stores a CSS clip-path string.
  if (Array.isArray(value) && value.length >= 3 && value.every((point) => {
    if (!Array.isArray(point) || point.length < 2) return false;
    const x = Number(point[0]);
    const y = Number(point[1]);
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
  })) {
    const points = value.map(([x, y]) => `${Number(x) * 100}% ${Number(y) * 100}%`);
    return `polygon(${points.join(', ')})`;
  }
  return null;
}

function normalizeMaskSrc(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/');
  // The storage/path gate runs before a snapshot reaches the renderer. Keep
  // this guard as a second line of defence for hand-authored snapshots.
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

function resolveOcclusion(occlusion = {}, partKey = null) {
  const affectedPartKeys = normalizeAffectedPartKeys(occlusion.affected_part_keys);
  const clipPath = normalizeClipPath(occlusion.clip_path);
  const maskSrc = normalizeMaskSrc(occlusion.mask_src);
  const hasMask = Boolean(maskSrc);
  const hasClip = Boolean(clipPath);
  // On a rig, an explicit affected list is required to avoid masking every
  // part by accident. For a standalone layer, an empty list means the whole
  // layer is affected.
  const appliesToPart = partKey == null
    ? affectedPartKeys.length === 0
    : affectedPartKeys.includes(String(partKey));
  return {
    enabled: appliesToPart && (hasMask || hasClip),
    affected_part_keys: affectedPartKeys,
    clip_path: clipPath,
    mask_src: maskSrc,
    feather_px: Math.max(0, Number(occlusion.feather_px) || 0),
    invert: occlusion.invert === true,
    group: occlusion.group || null,
    occluder_layer_key: occlusion.occluder_layer_key || null,
  };
}

module.exports = {
  normalizeAffectedPartKeys,
  normalizeClipPath,
  normalizeMaskSrc,
  resolveOcclusion,
};
