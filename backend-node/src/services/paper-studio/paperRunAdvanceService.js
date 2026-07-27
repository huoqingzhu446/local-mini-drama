const { randomUUID } = require('crypto');
const schemaService = require('./paperStudioSchemaService');
const runService = require('./paperStudioRunService');
const analyzerService = require('./paperStudioAnalyzerService');
const assetService = require('./paperAssetProductionService');
const motionService = require('./paperMotionGateService');
const renderService = require('./paperStudioRenderService');
const aggregateService = require('./paperRunAggregateService');
const { PaperStudioError, assertExpectedVersion } = require('./paperStudioUtils');

function selectedShots(run, body) {
  if (!body.shot_ids?.length) return run.shots;
  const wanted = new Set(body.shot_ids.map(Number));
  const selected = run.shots.filter((shot) => wanted.has(Number(shot.id)));
  if (selected.length !== wanted.size) throw new PaperStudioError('PAPER_STUDIO_SHOT_OWNERSHIP_MISMATCH', '部分镜头不属于当前生产版本', { run_id: run.id, shot_ids: body.shot_ids }, 409);
  return selected;
}

const ACTIONS = [
  { key: 'plan_motion', states: new Set(['asset_ready', 'motion_failed']), run: (db, cfg, log, shot) => motionService.planMotion(db, cfg, log, shot.id, { request_id: randomUUID(), expected_version: shot.version }) },
  { key: 'render_proof', states: new Set(['motion_ready', 'proof_failed']), run: (db, cfg, log, shot) => renderService.proof(db, cfg, log, shot.id, { request_id: randomUUID(), expected_version: shot.version }) },
  { key: 'render_preview', states: new Set(['proof_ready']), run: (db, cfg, log, shot) => renderService.preview(db, cfg, log, shot.id, { request_id: randomUUID(), expected_version: shot.version }) },
  { key: 'render_formal', states: new Set(['approved', 'render_failed']), run: (db, cfg, log, shot) => renderService.renderFormal(db, cfg, log, shot.id, { request_id: randomUUID(), expected_version: shot.version }) },
  { key: 'publish_video', states: new Set(['rendered']), run: (db, cfg, log, shot) => renderService.publish(db, cfg, log, shot.id, { request_id: randomUUID(), expected_version: shot.version }) },
];

async function advance(db, cfg, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '批量推进纸片生产的参数无效');
  let run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  let shots = selectedShots(run, body);

  if (run.status === 'draft' || shots.some((shot) => shot.status === 'pending')) {
    return { stage: 'analyze', ...(analyzerService.analyzeRun(db, log, run.id, { ...body, expected_version: run.version }, { fps: cfg?.paper_studio?.fps || 30 })) };
  }
  if (shots.some((shot) => shot.status === 'analyzed')) {
    return { stage: 'confirm_plan', ...(analyzerService.confirmPlan(db, log, run.id, { ...body, expected_version: run.version })) };
  }
  const authorizationTargets = shots.filter((shot) => ['plan_confirmed', 'asset_failed'].includes(shot.status));
  if (authorizationTargets.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_GENERATION_AUTHORIZATION_REQUIRED',
      '批量流程已停在图片生成授权点；请先查看模型、数量和费用，再明确开始生成',
      { run_id: run.id, shot_ids: authorizationTargets.map((shot) => Number(shot.id)) },
      409,
    );
  }

  const action = ACTIONS.find((candidate) => shots.some((shot) => candidate.states.has(shot.status)));
  if (!action) {
    const assetReview = shots.filter((shot) => shot.status === 'asset_review').map((shot) => Number(shot.id));
    if (assetReview.length) throw new PaperStudioError('PAPER_STUDIO_ASSET_REVIEW_REQUIRED', '批量流程已停在独立素材语义审核点', { shot_ids: assetReview }, 409);
    const waiting = shots.filter((shot) => shot.status === 'preview_ready').map((shot) => Number(shot.id));
    if (waiting.length) throw new PaperStudioError('PAPER_STUDIO_PREVIEW_APPROVAL_REQUIRED', '批量流程已停在人工预览批准点', { shot_ids: waiting }, 409);
    throw new PaperStudioError('PAPER_STUDIO_RUN_NO_ACTIONABLE_SHOTS', '当前没有可批量推进的镜头', { run_id: run.id, statuses: shots.map((shot) => ({ shot_id: shot.id, status: shot.status })) }, 409);
  }

  const targets = shots.filter((shot) => action.states.has(shot.status));
  const completed = [];
  const failed = [];
  for (const initial of targets) {
    try {
      const latest = require('./paperStudioShotService').get(db, initial.id);
      const result = await action.run(db, cfg, log, latest);
      completed.push({ shot_id: Number(initial.id), status: result.shot?.status || null });
    } catch (error) {
      failed.push({ shot_id: Number(initial.id), code: error.code || 'PAPER_STUDIO_STAGE_FAILED', message: error.message });
      if (error.code === 'PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED') break;
    }
  }
  aggregateService.sync(db, run.id);
  run = runService.get(db, run.id);
  if (log) log.info('Paper studio run stage advanced', { run_id: Number(run.id), stage: action.key, completed, failed });
  return { stage: action.key, run, completed, failed };
}

module.exports = { ACTIONS, advance };
