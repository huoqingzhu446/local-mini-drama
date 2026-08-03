const RUN_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  analyzing: '分析中',
  plan_review: '计划待确认',
  awaiting_generation_authorization: '等待生成授权',
  assets_generating: '素材生成中',
  assets_processing: '素材处理中',
  motion_planning: '动作规划中',
  proofing: '动态门禁中',
  preview_ready: '预览待批准',
  approved: '已批准',
  rendering: '渲染中',
  delivered: '已发布',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
  stale: '计划已失效',
})

const SHOT_STATUS_LABELS = Object.freeze({
  pending: '待分析',
  analyzed: '已分析',
  plan_confirmed: '计划已确认，等待生成授权',
  asset_pending: '素材生产中',
  asset_review: '素材待人工审核',
  asset_ready: '素材就绪',
  motion_ready: '动作就绪',
  proof_ready: '动态门禁通过',
  preview_ready: '预览待批准',
  approved: '已批准',
  rendering: '渲染中',
  rendered: '已渲染',
  published: '已发布',
  asset_failed: '素材失败',
  motion_failed: '动作门禁失败',
  proof_failed: '动态门禁失败',
  render_failed: '渲染失败',
  stale: '计划版本已失效',
  cancelled: '已取消',
})

const ENVIRONMENT_SHOT_STATUS_LABELS = Object.freeze({
  plan_confirmed: '环境计划已确认，等待生成授权',
  asset_pending: '环境底板生成中',
  asset_review: '环境底板待审核',
  asset_ready: '环境底板已批准',
  motion_ready: '环境动态已就绪',
  proof_ready: '环境动态检查通过',
  motion_failed: '环境动态需要自动修复',
  proof_failed: '环境动态证据未通过',
})

const MERGE_STATUS_LABELS = Object.freeze({
  pending: '等待合并',
  processing: '正在合并',
  failed: '合并失败',
  completed: '可交付',
  stale: '分镜已更新，需要重新合并',
})

const EPISODE_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  merging: '合并中',
  merge_failed: '合并失败',
  published: '已发布',
  archived: '已归档',
})

const STORYBOARD_STATUS_LABELS = Object.freeze({
  draft: '草稿',
  ready: '参考图就绪',
  in_production: '制作中',
  published: '已发布',
  archived: '已归档',
})

const AUDIO_STATUS_LABELS = Object.freeze({
  ready: '当前/可用',
  superseded: '历史版本',
  stale: '文本已变化',
  failed: '失败',
})

const REVISION_SOURCE_LABELS = Object.freeze({
  manual: '手动保存',
  production: '创建生产版本',
  duplicate: '复制分镜',
  legacy_import: '旧工作台导入',
  archive_import: '归档导入',
  history_fork_edit: '基于历史编辑',
})

const ASSET_VERSION_STATUS_LABELS = Object.freeze({
  candidate: '待审核',
  accepted: '已采用',
  rejected: '已拒绝',
  failed: '生成失败',
  cancelled: '已取消',
  superseded: '已淘汰',
})

function labelFrom(labels, status, fallback = '未知') {
  return labels[status] || status || fallback
}

export function runStatusLabel(status) {
  return labelFrom(RUN_STATUS_LABELS, status)
}

export function shotStatusLabel(status, { environmentOnly = false, compact = false } = {}) {
  const label = environmentOnly ? ENVIRONMENT_SHOT_STATUS_LABELS[status] : null
  const resolved = label || labelFrom(SHOT_STATUS_LABELS, status)
  if (!compact) return resolved
  return {
    '计划已确认，等待生成授权': '计划确认',
    '素材生产中': '素材中',
    '素材待人工审核': '待审素材',
    '动态门禁通过': '门禁通过',
    '预览待批准': '待批准',
    '动作门禁失败': '动作失败',
    '动态门禁失败': '门禁失败',
    '计划版本已失效': '已失效',
  }[resolved] || resolved
}

export function mergeStatusLabel(status) {
  return labelFrom(MERGE_STATUS_LABELS, status)
}

export function episodeStatusLabel(status) {
  return labelFrom(EPISODE_STATUS_LABELS, status)
}

export function storyboardStatusLabel(status) {
  return labelFrom(STORYBOARD_STATUS_LABELS, status)
}

export function audioStatusLabel(status) {
  return labelFrom(AUDIO_STATUS_LABELS, status)
}

export function revisionSourceLabel(source) {
  return labelFrom(REVISION_SOURCE_LABELS, source, '历史保存')
}

export function assetVersionStatusLabel(status) {
  return labelFrom(ASSET_VERSION_STATUS_LABELS, status, '历史版本')
}
