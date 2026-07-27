export const PAPER_TRANSPARENT_ASSET_TYPES = new Set([
  'cutout',
  'rig_part',
  'prop_state',
  'mask',
])

export const MIN_REVIEWABLE_TRANSPARENT_RATIO = 0.005

export function parsePaperAssetJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return fallback
  try { return JSON.parse(value) } catch (_) { return fallback }
}

export function paperAssetNeedsAlpha(asset) {
  return PAPER_TRANSPARENT_ASSET_TYPES.has(String(asset?.asset_type || ''))
}

export function paperAssetHasSource(asset) {
  return !!String(asset?.local_path || '').trim()
}

export function paperAssetHasReviewableAlpha(asset) {
  const processing = parsePaperAssetJson(asset?.processing_json, {})
  const transparentRatio = Number(processing.transparent_ratio)
  const visibleRatio = Number(processing.visible_ratio)
  if (Number.isFinite(transparentRatio)) {
    return transparentRatio >= MIN_REVIEWABLE_TRANSPARENT_RATIO
      && (!Number.isFinite(visibleRatio) || visibleRatio > 0.001)
  }
  if (processing.has_alpha === false) return false
  return Boolean(
    String(asset?.cutout_local_path || '').trim()
    || String(asset?.cutout_url || '').trim()
    || processing.has_alpha === true
  )
}

export function canManuallyApprovePaperAsset(asset) {
  if (!asset || asset.status !== 'needs_review' || !paperAssetNeedsAlpha(asset)) return false
  if (!paperAssetHasReviewableAlpha(asset)) return false
  return ['pass', 'warning', 'manual_pass'].includes(String(asset.matte_quality || ''))
}

export function paperAssetReviewState(asset) {
  if (!asset) return { tone: 'info', label: '无素材', message: '请先生成或上传纸片素材。' }
  const processing = parsePaperAssetJson(asset.processing_json, {})
  const transparentRatio = Number(processing.transparent_ratio)
  if (paperAssetNeedsAlpha(asset) && Number.isFinite(transparentRatio) && transparentRatio < MIN_REVIEWABLE_TRANSPARENT_RATIO) {
    return { tone: 'danger', label: '抠图失败', message: '透明像素过少，禁止人工通过；请更换抠图方式或上传真正的透明 PNG。' }
  }
  if (asset.status === 'ready' || asset.status === 'manual_pass') {
    return { tone: 'success', label: '审核通过', message: '该素材已满足正式渲染状态要求。' }
  }
  if (!paperAssetHasSource(asset)) {
    return { tone: 'warning', label: '缺少源图', message: '请先使用 Codex 生成候选或上传透明 PNG。' }
  }
  if (paperAssetHasReviewableAlpha(asset)) {
    return { tone: 'warning', label: '等待确认', message: '请放大检查透明边缘，确认无白边、残底和主体缺损后人工通过。' }
  }
  return { tone: 'warning', label: '需要抠图', message: '源图没有可用 Alpha，请选择白底或绿幕抠图。' }
}
