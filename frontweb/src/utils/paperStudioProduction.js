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
    confirm_shot_plan: '确认只生成干净环境底板，寒雾和空气流动由本地程序动画完成。',
    authorize_generation: '确认环境底板使用的图片模型、数量和费用；环境动态本身不产生图片费用。',
    review_assets: '只需检查最终会进入视频的环境底板；自动环境层不要求逐张审核。',
    plan_motion: '生成寒雾漂移、空气流动和轻微运镜，并冻结当前声音与画面的渲染快照。',
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
