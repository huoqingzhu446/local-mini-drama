const RUN_STATES = Object.freeze([
  'draft', 'analyzing', 'plan_review', 'awaiting_generation_authorization', 'assets_generating', 'assets_processing',
  'motion_planning', 'proofing', 'preview_ready', 'approved', 'rendering',
  'delivered', 'partial', 'failed', 'cancelled', 'stale',
]);

const SHOT_STATES = Object.freeze([
  'pending', 'analyzed', 'plan_confirmed', 'asset_pending', 'asset_review', 'asset_ready',
  'motion_ready', 'proof_ready', 'preview_ready', 'approved', 'rendering', 'rendered',
  'published', 'asset_failed', 'motion_failed', 'proof_failed', 'render_failed',
  'stale', 'cancelled',
]);

const runActions = {
  draft: { type: 'analyze_run', label: '分析所选分镜', blocking: false },
  analyzing: { type: 'wait_for_analysis', label: '正在分析分镜', blocking: true },
  plan_review: { type: 'confirm_plan', label: '确认素材与动作计划', blocking: true },
  awaiting_generation_authorization: { type: 'authorize_generation', label: '查看费用并授权生成', blocking: true },
  assets_generating: { type: 'wait_for_assets', label: '正在生成纸片素材', blocking: true },
  assets_processing: { type: 'wait_for_asset_gate', label: '正在处理并审核素材', blocking: true },
  motion_planning: { type: 'wait_for_motion', label: '正在规划主体动作', blocking: true },
  proofing: { type: 'wait_for_proof', label: '正在执行动态门禁', blocking: true },
  preview_ready: { type: 'review_preview', label: '查看并批准预览', blocking: true },
  approved: { type: 'render_formal', label: '渲染正式视频', blocking: false },
  rendering: { type: 'wait_for_render', label: '正在渲染正式视频', blocking: true },
  delivered: { type: 'delivered', label: '已发布', blocking: false },
  partial: { type: 'resolve_failed_shots', label: '处理失败分镜', blocking: true },
  failed: { type: 'recover_run', label: '恢复生产', blocking: true },
  cancelled: { type: 'duplicate_run', label: '新建生产版本', blocking: false },
  stale: { type: 'review_source_changes', label: '新建通用生产版本', blocking: true },
};

const shotActions = {
  pending: { type: 'analyze_shot', label: '分析镜头', blocking: false },
  analyzed: { type: 'confirm_shot_plan', label: '确认镜头计划', blocking: true },
  plan_confirmed: { type: 'authorize_generation', label: '查看费用并授权生成', blocking: true },
  asset_pending: { type: 'wait_for_assets', label: '正在准备素材', blocking: true },
  asset_review: { type: 'review_assets', label: '审核独立素材', blocking: true },
  asset_ready: { type: 'plan_motion', label: '规划主体动作', blocking: false },
  motion_ready: { type: 'run_proof', label: '执行动态门禁', blocking: false },
  proof_ready: { type: 'render_preview', label: '渲染预览', blocking: false },
  preview_ready: { type: 'approve_preview', label: '批准预览', blocking: true },
  approved: { type: 'render_formal', label: '渲染正式视频', blocking: false },
  rendering: { type: 'wait_for_render', label: '正在渲染正式视频', blocking: true },
  rendered: { type: 'publish_video', label: '发布到分镜', blocking: false },
  published: { type: 'published', label: '已发布', blocking: false },
  asset_failed: { type: 'authorize_generation', label: '查看重试费用并授权', blocking: true },
  motion_failed: { type: 'revise_motion', label: '修订动作计划', blocking: true },
  proof_failed: { type: 'inspect_evidence', label: '检查动态证据', blocking: true },
  render_failed: { type: 'retry_render', label: '重试渲染', blocking: true },
  stale: { type: 'review_source_changes', label: '新建通用生产版本', blocking: true },
  cancelled: { type: 'cancelled', label: '已取消', blocking: false },
};

function nextActionForRun(status) {
  return runActions[status] || { type: 'inspect_run', label: '检查运行状态', blocking: true };
}

function nextActionForShot(status) {
  return shotActions[status] || { type: 'inspect_shot', label: '检查分镜状态', blocking: true };
}

module.exports = { RUN_STATES, SHOT_STATES, nextActionForRun, nextActionForShot };
