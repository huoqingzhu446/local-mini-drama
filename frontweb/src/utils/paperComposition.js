export const PAPER_PROOF_KINDS = ['first', 'anticipation', 'peak', 'settle', 'final_minus_hold', 'exact_final']

export function proofLabel(kind) {
  return {
    first: '首帧',
    anticipation: '预备',
    peak: '动作峰值',
    settle: '稳定',
    final_minus_hold: '尾帧前保持',
    exact_final: '精确末帧',
  }[kind] || kind
}

export function parsePaperJson(value, fallback = {}) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch (_) { return fallback }
}

export function paperStatusLabel(status) {
  return {
    draft: '草稿', assets_pending: '待补素材', ready: '可渲染', rendering: '渲染中', rendered: '已完成', stale: '需重验', failed: '失败',
  }[status] || status || '未知'
}

export function paperAssetUrl(asset) {
  if (!asset) return ''
  return asset.cutout_url || asset.image_url || (asset.local_path ? `/static/${String(asset.local_path).replace(/^\/+/, '')}` : '')
}
