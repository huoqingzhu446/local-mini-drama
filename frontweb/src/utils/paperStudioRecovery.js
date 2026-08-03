const TRANSITION_GATE_CODE = 'PAPER_STUDIO_TRANSITION_GATE_FAILED'

const RECOVERY_RULES = [
  {
    match: /transition_structure_scene_groups|transition_structure_boundaries|adjacent_scenes|scene_reference|new_plate|spatial_contract|:environment$/,
    field: 'description',
    advice: '一个分镜尽量只保留一个地点；如果确实换地点，请拆成两个分镜，并为每个地点分别写清背景。',
  },
  {
    match: /duration|minimum_hold|movement_duration|vehicle_entry_duration/,
    field: 'duration',
    advice: '延长分镜时长，给主体动作和转场留出完整的进入、停留与收势时间。',
  },
  {
    match: /matched_velocity|acceleration|vehicle_speed|rotation_slope|scale_slope|opacity_slope/,
    field: 'action',
    advice: '在主体动作里写明“缓慢进入—稳定移动—自然停下”，避免方向、速度、旋转或缩放瞬间改变。',
  },
  {
    match: /event_density|caption|audio_continuity/,
    field: 'action',
    advice: '错开场景切换、主体动作、字幕和对白变化，不要让多个主要事件挤在同一时刻。',
  },
  {
    match: /incoming_initially_hidden|crossfade_coverage|opacity_duration|hard_cut_authorized/,
    field: 'description',
    advice: '明确使用渐隐渐现并保持前后画面连续；若必须硬切，请在画面描述中写清硬切原因。',
  },
  {
    match: /mobility:|causal_power|formation_cohesion|subject_group|unit_count|visibility/,
    field: 'action',
    advice: '把车辆、牵引者和队列写成同一组持续运动的主体，并让动力来源在动作结束时仍然可见。',
  },
]

function recoveryForFailure(failure = {}) {
  const key = String(failure.key || '')
  const rule = RECOVERY_RULES.find((item) => item.match.test(key))
  return {
    key: key || 'transition_gate',
    message: String(failure.message || '当前场景或主体变化缺少足够的过渡时间。'),
    field: rule?.field || 'description',
    advice: rule?.advice || '简化同一分镜中的地点和主体变化；复杂连续动作建议拆成多个分镜。',
  }
}

export function buildTransitionGateRecovery(errorContext, fallback = {}) {
  if (errorContext?.code !== TRANSITION_GATE_CODE) return null
  const details = errorContext.details || {}
  const rawFailures = Array.isArray(details.failures) ? details.failures : []
  const failures = (rawFailures.length ? rawFailures : [{}]).map(recoveryForFailure)
  const focusPriority = ['duration', 'action', 'description']
  const focusField = focusPriority.find((field) => failures.some((item) => item.field === field)) || 'description'
  return {
    code: TRANSITION_GATE_CODE,
    title: '解决场景或主体切换突兀',
    summary: rawFailures.length
      ? `检测到 ${rawFailures.length} 项连续性问题，生产已安全暂停，尚未调用图片 API。`
      : '连续性门禁没有通过，生产已安全暂停，尚未调用图片 API。',
    failures,
    hiddenFailureCount: Math.max(0, failures.length - 5),
    visibleFailures: failures.slice(0, 5),
    focusField,
    context: {
      shot_id: Number(details.recovery_context?.shot_id || fallback.shot_id || 0) || null,
      paper_storyboard_id: Number(details.recovery_context?.paper_storyboard_id || fallback.paper_storyboard_id || 0) || null,
      shot_number: Number(details.recovery_context?.shot_number || fallback.shot_number || 0) || null,
      title: details.recovery_context?.title || fallback.title || '',
    },
  }
}

export function isTransitionGateError(error) {
  return (error?.apiCode || error?.code) === TRANSITION_GATE_CODE
}

export { TRANSITION_GATE_CODE }
