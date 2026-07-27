const projectService = require('./paperStudioProjectService');
const { nextActionForShot } = require('./paperStudioStateService');
const { parseJson } = require('./paperStudioUtils');

const PROCESSING_STATES = new Set(['asset_pending', 'rendering']);
const FAILED_STATES = new Set(['asset_failed', 'motion_failed', 'proof_failed', 'render_failed', 'stale', 'cancelled']);
const TERMINAL_RUN_STATES = new Set(['delivered', 'cancelled', 'stale']);

function taskCategory(status) {
  if (FAILED_STATES.has(status)) return 'failed';
  if (status === 'published') return 'completed';
  if (PROCESSING_STATES.has(status)) return 'processing';
  return 'attention';
}

function statusLabel(status) {
  return {
    authoring_incomplete: '等待补齐并保存脚本',
    ready_for_run: '脚本已就绪，等待创建生产版本',
    pending: '等待镜头分析',
    analyzed: '等待确认生产蓝图',
    plan_confirmed: '等待上传素材或生成授权',
    asset_pending: '正在生成或处理素材',
    asset_review: '等待逐张审核素材',
    asset_ready: '等待动作规划',
    motion_ready: '等待执行动态门禁',
    proof_ready: '等待渲染预览',
    preview_ready: '等待批准预览',
    approved: '等待正式渲染',
    rendering: '正在渲染正式视频',
    rendered: '等待发布正式视频',
    published: '正式视频已发布',
    asset_failed: '素材生产需要处理',
    motion_failed: '动作规划需要处理',
    proof_failed: '动态门禁需要处理',
    render_failed: '正式渲染需要处理',
    stale: '生产版本已失效',
    cancelled: '生产版本已取消',
  }[status] || status;
}

function listStoryboardRows(db, projectId) {
  return db.prepare(
    `WITH latest_shots AS (
       SELECT ps.id AS shot_id, ps.run_id, ps.shot_index, ps.paper_storyboard_id,
              ps.status AS shot_status, ps.attention_required, ps.updated_at AS shot_updated_at,
              pr.run_number, pr.status AS run_status, pr.progress AS run_progress,
              pr.paused_at, pr.updated_at AS run_updated_at,
              ROW_NUMBER() OVER (
                PARTITION BY ps.paper_storyboard_id
                ORDER BY pr.run_number DESC, pr.id DESC, ps.id DESC
              ) AS latest_rank
       FROM paper_studio_shots ps
       JOIN paper_studio_runs pr ON pr.id = ps.run_id AND pr.deleted_at IS NULL
       WHERE pr.project_id = ? AND pr.paper_episode_id IS NOT NULL
         AND ps.paper_storyboard_id IS NOT NULL AND ps.deleted_at IS NULL
     )
     SELECT pb.id AS paper_storyboard_id, pb.title AS storyboard_title,
            pb.shot_number, pb.description, pb.action, pb.environment_only,
            pb.status AS storyboard_status, pb.updated_at AS storyboard_updated_at,
            pe.id AS paper_episode_id, pe.title AS episode_title, pe.episode_number,
            ls.shot_id, ls.run_id, ls.shot_index, ls.shot_status, ls.attention_required,
            ls.shot_updated_at, ls.run_number, ls.run_status, ls.run_progress,
            ls.paused_at, ls.run_updated_at
     FROM paper_storyboards pb
     JOIN paper_studio_episodes pe ON pe.id = pb.paper_episode_id AND pe.deleted_at IS NULL
     LEFT JOIN latest_shots ls ON ls.paper_storyboard_id = pb.id AND ls.latest_rank = 1
     WHERE pe.project_id = ? AND pb.deleted_at IS NULL
     ORDER BY pe.episode_number ASC, pe.id ASC, pb.shot_number ASC, pb.id ASC`,
  ).all(Number(projectId), Number(projectId));
}

function authoringState(row) {
  const missing = [];
  if (!String(row.storyboard_title || '').trim()) missing.push('title');
  if (!String(row.description || '').trim()) missing.push('description');
  if (!Boolean(row.environment_only) && !String(row.action || '').trim()) missing.push('action');
  return {
    status: missing.length ? 'authoring_incomplete' : 'ready_for_run',
    missing_fields: missing,
  };
}

function shotTaskDetails(db, shotId, runId) {
  const slots = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN pas.required_for_gate = 1 THEN 1 ELSE 0 END) AS required_count,
            SUM(CASE WHEN pas.required_for_gate = 1 AND pas.status = 'ready' THEN 1 ELSE 0 END) AS ready_count
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id AND psf.deleted_at IS NULL
     WHERE psf.shot_id = ? AND pas.deleted_at IS NULL`,
  ).get(Number(shotId));
  const pendingSlot = db.prepare(
    `SELECT pas.id, pas.slot_key, pas.asset_type, pas.status
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id AND psf.deleted_at IS NULL
     WHERE psf.shot_id = ? AND pas.deleted_at IS NULL
       AND pas.required_for_gate = 1 AND pas.status != 'ready'
     ORDER BY CASE WHEN pas.status = 'failed' THEN 0 ELSE 1 END, pas.id
     LIMIT 1`,
  ).get(Number(shotId));
  const calls = db.prepare(
    `SELECT COUNT(*) AS count
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id AND pas.deleted_at IS NULL
     JOIN paper_source_families psf ON psf.id = pas.family_id AND psf.deleted_at IS NULL
     WHERE psf.shot_id = ? AND pav.derivation_kind = 'image_api'`,
  ).get(Number(shotId));
  const lastEvent = db.prepare(
    `SELECT event_type, severity, title, message, created_at
     FROM paper_studio_events
     WHERE shot_id = ? OR (shot_id IS NULL AND run_id = ?)
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(shotId), Number(runId));
  return {
    asset_total_count: Number(slots?.total || 0),
    required_asset_count: Number(slots?.required_count || 0),
    ready_asset_count: Number(slots?.ready_count || 0),
    active_slot: pendingSlot ? {
      id: Number(pendingSlot.id),
      slot_key: pendingSlot.slot_key,
      asset_type: pendingSlot.asset_type,
      status: pendingSlot.status,
    } : null,
    image_api_call_count: Number(calls?.count || 0),
    last_event: lastEvent || null,
  };
}

function runControls(row) {
  if (!row.run_id || TERMINAL_RUN_STATES.has(row.run_status)) {
    return { can_pause: false, can_resume: false, can_cancel: false };
  }
  const paused = Boolean(row.paused_at);
  return { can_pause: !paused, can_resume: paused, can_cancel: true };
}

function toTask(db, row) {
  const common = {
    id: `storyboard:${Number(row.paper_storyboard_id)}`,
    project_scope: 'paper',
    paper_episode_id: Number(row.paper_episode_id),
    paper_storyboard_id: Number(row.paper_storyboard_id),
    episode_number: Number(row.episode_number || 0),
    shot_number: Number(row.shot_number || 0),
    episode_title: row.episode_title || `纸片分集 ${row.episode_number || ''}`,
    title: row.storyboard_title || `分镜 ${row.shot_number || ''}`,
  };
  if (!row.shot_id) {
    const authoring = authoringState(row);
    const nextAction = authoring.status === 'authoring_incomplete'
      ? { type: 'edit_storyboard', label: '补齐并保存脚本', blocking: true }
      : { type: 'create_run', label: '创建生产版本', blocking: false };
    return {
      ...common,
      category: 'attention',
      run_id: null,
      shot_id: null,
      run_number: null,
      status: authoring.status,
      label: statusLabel(authoring.status),
      next_action: nextAction,
      progress: 0,
      missing_fields: authoring.missing_fields,
      asset_total_count: 0,
      required_asset_count: 0,
      ready_asset_count: 0,
      active_slot: null,
      image_api_call_count: 0,
      last_event: null,
      controls: { can_pause: false, can_resume: false, can_cancel: false },
      updated_at: row.storyboard_updated_at,
    };
  }
  const details = shotTaskDetails(db, row.shot_id, row.run_id);
  return {
    ...common,
    category: taskCategory(row.shot_status),
    run_id: Number(row.run_id),
    shot_id: Number(row.shot_id),
    run_number: Number(row.run_number),
    status: row.shot_status,
    label: statusLabel(row.shot_status),
    next_action: nextActionForShot(row.shot_status),
    progress: Number(row.run_progress || 0),
    run_status: row.run_status,
    run_paused: Boolean(row.paused_at),
    controls: runControls(row),
    updated_at: row.shot_updated_at || row.run_updated_at || row.storyboard_updated_at,
    ...details,
  };
}

function slotUsage(db, projectId) {
  return db.prepare(
    `SELECT pas.id AS slot_id, pas.slot_key, pas.asset_type,
            pb.id AS paper_storyboard_id, pb.title AS storyboard_title,
            pe.id AS paper_episode_id, pe.title AS episode_title,
            COUNT(pav.id) AS generated_versions,
            SUM(CASE WHEN pav.status = 'accepted' THEN 1 ELSE 0 END) AS accepted_versions,
            SUM(CASE WHEN pav.status IN ('rejected','failed') THEN 1 ELSE 0 END) AS failed_versions,
            SUM(CASE WHEN pas.current_version_id = pav.id THEN 1 ELSE 0 END) AS adopted_versions
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id AND pas.deleted_at IS NULL
     JOIN paper_source_families psf ON psf.id = pas.family_id AND psf.deleted_at IS NULL
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id AND pss.deleted_at IS NULL
     JOIN paper_studio_runs pr ON pr.id = pss.run_id AND pr.deleted_at IS NULL
     LEFT JOIN paper_storyboards pb ON pb.id = pss.paper_storyboard_id AND pb.deleted_at IS NULL
     LEFT JOIN paper_studio_episodes pe ON pe.id = pb.paper_episode_id AND pe.deleted_at IS NULL
     WHERE pr.project_id = ? AND pav.derivation_kind = 'image_api'
     GROUP BY pas.id
     ORDER BY MAX(pav.created_at) DESC, pas.id DESC`,
  ).all(Number(projectId)).map((row) => ({
    ...row,
    slot_id: Number(row.slot_id),
    paper_storyboard_id: row.paper_storyboard_id == null ? null : Number(row.paper_storyboard_id),
    paper_episode_id: row.paper_episode_id == null ? null : Number(row.paper_episode_id),
    generated_versions: Number(row.generated_versions || 0),
    accepted_versions: Number(row.accepted_versions || 0),
    failed_versions: Number(row.failed_versions || 0),
    adopted_versions: Number(row.adopted_versions || 0),
  }));
}

function authorizationSummary(db, projectId) {
  const rows = db.prepare(
    `SELECT pga.*
     FROM paper_generation_authorizations pga
     JOIN paper_studio_runs pr ON pr.id = pga.run_id AND pr.deleted_at IS NULL
     WHERE pr.project_id = ? AND pga.deleted_at IS NULL
     ORDER BY pga.created_at DESC`,
  ).all(Number(projectId)).map((row) => ({
    id: Number(row.id),
    run_id: Number(row.run_id),
    provider: row.provider,
    model: row.model,
    status: row.status,
    estimated_image_count: Number(row.estimated_image_count || 0),
    max_attempts: Number(row.max_attempts || 0),
    shot_scope: parseJson(row.shot_scope_json, []),
    slot_scope: parseJson(row.slot_scope_json, []),
    authorized_at: row.authorized_at,
    executed_at: row.executed_at,
    cancelled_at: row.cancelled_at,
  }));
  const billable = rows.filter((row) => ['executing', 'consumed'].includes(row.status));
  const generated = db.prepare(
    `SELECT COUNT(*) AS count,
            SUM(CASE WHEN pav.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN pav.status IN ('rejected','failed') THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN pas.current_version_id = pav.id THEN 1 ELSE 0 END) AS adopted
     FROM paper_asset_versions pav
     JOIN paper_asset_slots pas ON pas.id = pav.slot_id AND pas.deleted_at IS NULL
     JOIN paper_source_families psf ON psf.id = pas.family_id AND psf.deleted_at IS NULL
     JOIN paper_studio_shots pss ON pss.id = psf.shot_id AND pss.deleted_at IS NULL
     JOIN paper_studio_runs pr ON pr.id = pss.run_id AND pr.deleted_at IS NULL
     WHERE pr.project_id = ? AND pav.derivation_kind = 'image_api'`,
  ).get(Number(projectId));
  const estimatedCalls = billable.reduce((total, row) => total + row.estimated_image_count, 0);
  const maxAuthorizedCalls = billable.reduce(
    (total, row) => total + (row.estimated_image_count * Math.max(1, row.max_attempts)),
    0,
  );
  const generatedCount = Number(generated?.count || 0);
  return {
    estimated_calls: estimatedCalls,
    max_authorized_calls: maxAuthorizedCalls,
    remaining_authorized_calls: Math.max(0, maxAuthorizedCalls - generatedCount),
    generated_versions: generatedCount,
    accepted_versions: Number(generated?.accepted || 0),
    failed_versions: Number(generated?.failed || 0),
    adopted_versions: Number(generated?.adopted || 0),
    unused_versions: Math.max(0, generatedCount - Number(generated?.adopted || 0)),
    cancelled_authorizations: rows.filter((row) => ['cancelled', 'expired'].includes(row.status)).length,
    authorizations: rows,
    slot_usage: slotUsage(db, projectId),
  };
}

function build(db, projectId) {
  const project = projectService.get(db, projectId);
  const tasks = listStoryboardRows(db, project.id).map((row) => toTask(db, row));
  const groups = {
    attention: tasks.filter((task) => task.category === 'attention'),
    processing: tasks.filter((task) => task.category === 'processing'),
    failed: tasks.filter((task) => task.category === 'failed'),
    completed: tasks.filter((task) => task.category === 'completed'),
  };
  const costs = authorizationSummary(db, project.id);
  return {
    project_id: Number(project.id),
    summary: {
      attention: groups.attention.length,
      processing: groups.processing.length,
      failed: groups.failed.length,
      completed: groups.completed.length,
      total: tasks.length,
    },
    costs,
    groups,
    updated_at: new Date().toISOString(),
  };
}

module.exports = { build, taskCategory, statusLabel, authoringState };
