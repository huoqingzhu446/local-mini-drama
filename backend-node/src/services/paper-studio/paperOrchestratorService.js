const { randomUUID } = require('node:crypto');

const shotService = require('./paperStudioShotService');
const assetService = require('./paperAssetProductionService');
const continuityService = require('./paperContinuityService');
const motionService = require('./paperMotionGateService');
const renderService = require('./paperStudioRenderService');
const aggregateService = require('./paperRunAggregateService');
const authorizationService = require('./paperGenerationAuthorizationService');
const eventService = require('./paperStudioEventService');
const { nowIso, parseJson } = require('./paperStudioUtils');

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LEASE_MS = 10 * 60 * 1_000;
const TERMINAL_RUN_STATES = new Set(['delivered', 'cancelled', 'stale', 'failed']);

const ACTIONS = Object.freeze({
  generate_layout_master: {
    queue: 'image',
    states: new Set(['plan_confirmed', 'asset_failed']),
    failureState: 'asset_failed',
    run: (db, cfg, log, shot, step) => assetService.generateAssets(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version, authorization_id: Number(step.authorization_id),
    }),
  },
  plan_motion: {
    queue: 'local',
    states: new Set(['asset_ready', 'motion_failed']),
    failureState: 'motion_failed',
    run: (db, cfg, log, shot) => motionService.planMotion(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
  },
  render_proof: {
    queue: 'render',
    states: new Set(['motion_ready', 'proof_failed']),
    failureState: 'proof_failed',
    run: (db, cfg, log, shot) => renderService.proof(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
  },
  render_preview: {
    queue: 'render',
    states: new Set(['proof_ready']),
    failureState: 'proof_failed',
    run: (db, cfg, log, shot) => renderService.preview(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
  },
  render_formal: {
    queue: 'render',
    states: new Set(['approved', 'render_failed']),
    failureState: 'render_failed',
    run: (db, cfg, log, shot) => renderService.renderFormal(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
  },
  publish_video: {
    queue: 'local',
    states: new Set(['rendered']),
    failureState: 'render_failed',
    run: (db, cfg, log, shot) => renderService.publish(db, cfg, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
  },
});

function limits(cfg = {}) {
  return {
    image: Math.max(1, Number(cfg?.paper_studio?.max_image_concurrency || 2)),
    local: 1,
    render: Math.max(1, Number(cfg?.paper_studio?.max_render_concurrency || 1)),
  };
}

function dependenciesCompleted(db, step) {
  const dependencies = parseJson(step.depends_on_json, []);
  if (!dependencies.length) return true;
  const rows = db.prepare(`SELECT step_key, status FROM paper_job_steps
    WHERE run_id = ? AND shot_id = ? AND step_key IN (${dependencies.map(() => '?').join(',')})`)
    .all(Number(step.run_id), Number(step.shot_id), ...dependencies);
  const completed = new Set(rows.filter((row) => row.status === 'completed').map((row) => row.step_key));
  return dependencies.every((key) => completed.has(key));
}

function continuityReady(db, step) {
  if (step.step_key !== 'generate_layout_master') return true;
  return continuityService.assertIncomingSourcesReady(db, step.shot_id).pass;
}

function authorizationReady(db, step) {
  const action = ACTIONS[step.step_key];
  if (action?.queue !== 'image') return true;
  if (!step.authorization_id) return false;
  try {
    authorizationService.assertUsable(db, step.authorization_id, {
      runId: step.run_id,
      shotId: step.shot_id,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function runnableSteps(db) {
  return db.prepare(
    `SELECT pjs.*, pss.status AS shot_status, psr.status AS run_status, psr.paused_at
     FROM paper_job_steps pjs
     JOIN paper_studio_shots pss ON pss.id = pjs.shot_id AND pss.deleted_at IS NULL
     JOIN paper_studio_runs psr ON psr.id = pjs.run_id AND psr.deleted_at IS NULL
     WHERE pjs.status = 'queued' AND psr.paused_at IS NULL
     ORDER BY psr.id, pss.shot_index, pjs.id`,
  ).all().filter((step) => {
    const action = ACTIONS[step.step_key];
    return action
      && !TERMINAL_RUN_STATES.has(step.run_status)
      && action.states.has(step.shot_status)
      && dependenciesCompleted(db, step)
      && continuityReady(db, step)
      && authorizationReady(db, step);
  });
}

function claim(db, stepId, workerId, leaseMs = DEFAULT_LEASE_MS) {
  const transaction = db.transaction(() => {
    const step = db.prepare(
      `SELECT pjs.*, pss.status AS shot_status, psr.status AS run_status, psr.paused_at
       FROM paper_job_steps pjs
       JOIN paper_studio_shots pss ON pss.id = pjs.shot_id AND pss.deleted_at IS NULL
       JOIN paper_studio_runs psr ON psr.id = pjs.run_id AND psr.deleted_at IS NULL
       WHERE pjs.id = ?`,
    ).get(Number(stepId));
    const action = ACTIONS[step?.step_key];
    if (!step || step.status !== 'queued' || !action || TERMINAL_RUN_STATES.has(step.run_status) || step.paused_at) return null;
    if (!action.states.has(step.shot_status) || !dependenciesCompleted(db, step) || !continuityReady(db, step) || !authorizationReady(db, step)) return null;
    const now = nowIso();
    const expires = new Date(Date.now() + Number(leaseMs)).toISOString();
    const updated = db.prepare(
      `UPDATE paper_job_steps
       SET status = 'running', lease_owner = ?, lease_expires_at = ?,
           started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    ).run(workerId, expires, now, now, Number(step.id));
    return updated.changes === 1 ? { ...step, status: 'running', lease_owner: workerId, lease_expires_at: expires } : null;
  });
  return transaction();
}

function renewLease(db, stepId, workerId, leaseMs) {
  const expires = new Date(Date.now() + Number(leaseMs)).toISOString();
  db.prepare(
    `UPDATE paper_job_steps SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(expires, nowIso(), Number(stepId), workerId);
}

function settleUnhandledFailure(db, step, error) {
  const row = db.prepare('SELECT * FROM paper_job_steps WHERE id = ?').get(Number(step.id));
  if (!row || row.status !== 'running') return;
  const action = ACTIONS[row.step_key];
  const exhausted = Number(row.attempt || 1) >= Number(row.max_attempts || 2);
  const status = exhausted ? 'failed_terminal' : 'failed_retryable';
  const failure = {
    code: error.code || 'PAPER_STUDIO_ORCHESTRATED_STEP_FAILED',
    message: error.message || '纸片工作室后台步骤失败',
    step_key: row.step_key,
    attempt: Number(row.attempt || 1),
    at: nowIso(),
  };
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE paper_job_steps SET status = ?, error_json = ?, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'`,
    ).run(status, JSON.stringify(failure), now, Number(row.id));
    if (action?.failureState) {
      db.prepare(
        `UPDATE paper_studio_shots SET status = ?, last_error_json = ?,
                version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(action.failureState, JSON.stringify(failure), now, Number(row.shot_id));
    }
  });
  transaction();
  aggregateService.sync(db, row.run_id);
}

function createOrchestrator(db, cfg, log, options = {}) {
  const workerId = options.workerId || `paper-orchestrator:${process.pid}:${randomUUID()}`;
  const pollMs = Math.max(100, Number(options.pollMs || cfg?.paper_studio?.orchestrator_poll_ms || DEFAULT_POLL_MS));
  const leaseMs = Math.max(5_000, Number(options.leaseMs || cfg?.paper_studio?.orchestrator_lease_ms || DEFAULT_LEASE_MS));
  const queueLimits = { ...limits(cfg), ...(options.limits || {}) };
  const active = new Map();
  let timer = null;
  let stopped = true;
  let ticking = false;

  function countQueue(queue) {
    return [...active.values()].filter((item) => item.queue === queue).length;
  }

  async function execute(step) {
    const action = ACTIONS[step.step_key];
    const heartbeat = setInterval(() => renewLease(db, step.id, workerId, leaseMs), Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const shot = shotService.get(db, step.shot_id);
      await action.run(db, cfg, log, shot, step);
      const unfinished = db.prepare("SELECT status FROM paper_job_steps WHERE id = ?").get(Number(step.id));
      if (unfinished?.status === 'running') {
        const now = nowIso();
        db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = '{}', lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now, now, Number(step.id));
      }
      aggregateService.sync(db, step.run_id);
      authorizationService.markConsumedIfFinished(db, step.authorization_id);
      if (log) log.info('Paper studio orchestrated step completed', { worker_id: workerId, run_id: Number(step.run_id), shot_id: Number(step.shot_id), step_key: step.step_key });
    } catch (error) {
      settleUnhandledFailure(db, step, error);
      authorizationService.markConsumedIfFinished(db, step.authorization_id);
      eventService.record(db, {
        runId: step.run_id,
        shotId: step.shot_id,
        eventType: 'orchestrated_step_failed',
        severity: 'error',
        title: '后台生产步骤失败',
        message: error.message || '纸片工作室后台步骤失败',
        recoveryActions: action?.queue === 'image'
          ? ['review_error', 'authorize_retry', 'upload_replacement']
          : ['review_error', 'retry_step'],
        details: { step_key: step.step_key, code: error.code || null },
      });
      if (log) log.warn('Paper studio orchestrated step stopped', { worker_id: workerId, run_id: Number(step.run_id), shot_id: Number(step.shot_id), step_key: step.step_key, code: error.code, error: error.message });
    } finally {
      clearInterval(heartbeat);
      active.delete(Number(step.id));
      if (!stopped) setImmediate(() => tick());
    }
  }

  async function tick() {
    if (stopped || ticking) return { claimed: 0, active: active.size };
    ticking = true;
    let claimedCount = 0;
    try {
      for (const candidate of runnableSteps(db)) {
        const action = ACTIONS[candidate.step_key];
        if (countQueue(action.queue) >= Number(queueLimits[action.queue] || 1)) continue;
        const step = claim(db, candidate.id, workerId, leaseMs);
        if (!step) continue;
        claimedCount += 1;
        const promise = execute(step);
        active.set(Number(step.id), { queue: action.queue, promise });
      }
      return { claimed: claimedCount, active: active.size };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    timer = setInterval(() => tick(), pollMs);
    timer.unref?.();
    setImmediate(() => tick());
    if (log) log.info('Paper studio orchestrator started', { worker_id: workerId, poll_ms: pollMs, lease_ms: leaseMs, limits: queueLimits });
  }

  async function stop({ wait = false } = {}) {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (wait) await Promise.allSettled([...active.values()].map((item) => item.promise));
  }

  return {
    workerId,
    start,
    stop,
    tick,
    state: () => ({ running: !stopped, active: active.size, limits: queueLimits }),
  };
}

module.exports = {
  ACTIONS,
  DEFAULT_LEASE_MS,
  dependenciesCompleted,
  authorizationReady,
  runnableSteps,
  claim,
  createOrchestrator,
};
