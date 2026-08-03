export function isEnvironmentProductionShot(shot) {
  return Boolean(shot?.storyboard?.environment_only || shot?.plan_summary_json?.environment_only)
}

export function paperProductionActionLabel(shot, fallback = '') {
  const type = shot?.next_action?.type
  if (!isEnvironmentProductionShot(shot)) return fallback || shot?.next_action?.label || ''
  if (shot?.last_error_json?.code === 'PAPER_STUDIO_STATE_ASSET_MISSING') {
    return '自动补齐环境过渡并继续'
  }
  return {
    analyze_shot: '分析环境镜头',
    confirm_shot_plan: '确认环境制作计划',
    authorize_generation: '授权生成环境底板',
    wait_for_assets: '正在生成环境底板',
    review_assets: '审核环境底板',
    plan_motion: '生成环境动态',
    revise_motion: '修复环境动态',
    run_proof: '检查环境动态',
    inspect_evidence: '检查环境动态证据',
    render_preview: '渲染环境预览',
    approve_preview: '批准环境预览',
    render_formal: '渲染正式环境视频',
    retry_render: '重试正式环境视频',
    wait_for_render: '正在渲染正式环境视频',
    publish_video: '发布环境视频到分镜',
  }[type] || fallback || shot?.next_action?.label || ''
}

export function paperProductionActionDescription(shot, fallback = '') {
  if (!isEnvironmentProductionShot(shot)) return fallback
  if (shot?.last_error_json?.code === 'PAPER_STUDIO_STATE_ASSET_MISSING') {
    return '旧生产版本缺少一个零费用的环境过渡状态。系统会复用已批准素材自动补齐并重新冻结快照，不会再次调用图片 API。'
  }
  return {
    analyze_shot: '识别环境层、雾气深度和运镜意图；本步骤不会调用图片 API。',
    confirm_shot_plan: '确认只生成干净环境底板，环境氛围与空气流动由本地程序动画完成。',
    authorize_generation: '确认环境底板使用的图片模型、数量和费用；环境动态本身不产生图片费用。',
    review_assets: '只需检查最终会进入视频的环境底板；自动环境层不要求逐张审核。',
    plan_motion: '生成环境氛围漂移、空气流动和轻微运镜，并冻结当前声音与画面的渲染快照。',
    revise_motion: '系统将修复环境动态的幅度或过渡，不会要求补写人物动作。',
    run_proof: '检查环境变化是否可见、连续，并确认不是静止图片。',
    inspect_evidence: '根据失败证据只修复环境动态，不会删除已批准底板。',
    render_preview: '用同一快照渲染低清有声预览。',
    approve_preview: '播放并确认环境动态、声音和字幕；批准后才允许正式渲染。',
    render_formal: '用已批准快照渲染正式 H.264 视频。',
    retry_render: '复用已批准快照重试，不重新生成图片。',
    wait_for_render: '正式视频正在后台渲染，完成后即可发布到当前分镜。',
    publish_video: '把正式视频绑定到独立纸片分镜，之后可参与整集合并。',
  }[shot?.next_action?.type] || fallback
}

const TERMINAL_RUN_STATUSES = new Set(['delivered', 'cancelled', 'stale'])
const RUN_RESUME_PRIORITY = {
  rendering: 1200,
  approved: 1100,
  preview_ready: 1000,
  proofing: 700,
  motion_planning: 600,
  assets_processing: 500,
  assets_generating: 480,
  awaiting_generation_authorization: 400,
  plan_review: 300,
  analyzing: 200,
  partial: 150,
  failed: 140,
  draft: 100,
}

function sortedIds(value) {
  return (Array.isArray(value) ? value : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

function sameIds(left, right) {
  const a = sortedIds(left)
  const b = sortedIds(right)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function findBestUnpublishedRun(runs, options = {}) {
  const storyboardIds = sortedIds(options.storyboardIds)
  const revisionIds = sortedIds(options.revisionIds)
  return [...(Array.isArray(runs) ? runs : [])]
    .filter((run) => run && !TERMINAL_RUN_STATUSES.has(run.status))
    .filter((run) => !options.paperEpisodeId || Number(run.paper_episode_id) === Number(options.paperEpisodeId))
    .filter((run) => !storyboardIds.length || sameIds(run.selection_json?.paper_storyboard_ids, storyboardIds))
    .filter((run) => !revisionIds.length || sameIds(run.selection_json?.paper_storyboard_revision_ids, revisionIds))
    .sort((left, right) => {
      const priority = Number(RUN_RESUME_PRIORITY[right.status] || 0) - Number(RUN_RESUME_PRIORITY[left.status] || 0)
      if (priority) return priority
      const progress = Number(right.progress || 0) - Number(left.progress || 0)
      if (progress) return progress
      return new Date(right.updated_at || right.created_at || 0).getTime() - new Date(left.updated_at || left.created_at || 0).getTime()
    })[0] || null
}

export function unpublishedRunResumeLabel(run) {
  return {
    preview_ready: '预览视频已生成，等待批准',
    approved: '预览已批准，等待正式渲染',
    rendering: '正式视频正在渲染',
    proofing: '正在生成动态检查与预览',
    motion_planning: '素材已完成，正在处理动作',
    assets_processing: '图片已返回，正在处理正式素材',
    assets_generating: '正式素材正在生成',
    awaiting_generation_authorization: '蓝图已确认，等待生成授权',
    plan_review: '镜头分析已完成，等待确认蓝图',
    analyzing: '正在分析镜头',
    partial: '部分步骤失败，等待继续处理',
    failed: '生产失败，等待检查并重试',
    draft: '版本已保存，等待分析镜头',
  }[run?.status] || '未发布版本等待继续'
}
