const { nowIso, parseJson } = require('./paperStudioUtils');

const PROGRESS = Object.freeze({
  pending: 0,
  analyzed: 10,
  plan_confirmed: 15,
  asset_pending: 25,
  asset_review: 38,
  asset_ready: 42,
  motion_ready: 55,
  proof_ready: 70,
  preview_ready: 78,
  approved: 84,
  rendering: 90,
  rendered: 95,
  published: 100,
  asset_failed: 25,
  motion_failed: 48,
  proof_failed: 62,
  render_failed: 88,
  stale: 0,
  cancelled: 0,
});

const STAGE = Object.freeze({
  pending: ['draft', 0],
  analyzed: ['plan_review', 1],
  plan_confirmed: ['awaiting_generation_authorization', 2],
  asset_pending: ['assets_generating', 2],
  asset_review: ['assets_processing', 3],
  asset_ready: ['motion_planning', 4],
  motion_ready: ['proofing', 5],
  proof_ready: ['proofing', 6],
  preview_ready: ['preview_ready', 7],
  approved: ['approved', 8],
  rendering: ['rendering', 9],
  rendered: ['approved', 9],
  published: ['delivered', 10],
});

const FAILURES = new Set(['asset_failed', 'motion_failed', 'proof_failed', 'render_failed']);

function aggregate(shots) {
  const active = shots.filter((shot) => shot.status !== 'cancelled');
  if (!shots.length) return { status: 'draft', progress: 0, completed: false, last_error: {} };
  if (shots.every((shot) => shot.status === 'cancelled')) return { status: 'cancelled', progress: 0, completed: false, last_error: {} };
  if (active.some((shot) => shot.status === 'stale')) return { status: 'stale', progress: Math.round(active.reduce((sum, shot) => sum + Number(PROGRESS[shot.status] || 0), 0) / active.length), completed: false, last_error: active.find((shot) => shot.status === 'stale')?.last_error_json || {} };
  const failed = active.find((shot) => FAILURES.has(shot.status));
  if (failed) return {
    status: 'partial',
    progress: Math.round(active.reduce((sum, shot) => sum + Number(PROGRESS[shot.status] || 0), 0) / active.length),
    completed: false,
    last_error: failed.last_error_json || {},
  };
  if (active.length && active.every((shot) => shot.status === 'published')) return { status: 'delivered', progress: 100, completed: true, last_error: {} };
  const earliest = active
    .filter((shot) => shot.status !== 'published')
    .map((shot) => STAGE[shot.status] || ['failed', -1])
    .sort((left, right) => left[1] - right[1])[0] || ['delivered', 10];
  return {
    status: earliest[0],
    progress: Math.round(active.reduce((sum, shot) => sum + Number(PROGRESS[shot.status] || 0), 0) / active.length),
    completed: false,
    last_error: {},
  };
}

function sync(db, runId) {
  const run = db.prepare('SELECT * FROM paper_studio_runs WHERE id = ? AND deleted_at IS NULL').get(Number(runId));
  if (!run) return null;
  const shots = db.prepare('SELECT status, last_error_json FROM paper_studio_shots WHERE run_id = ? AND deleted_at IS NULL ORDER BY shot_index, id').all(Number(runId)).map((shot) => ({ ...shot, last_error_json: parseJson(shot.last_error_json, {}) }));
  const next = aggregate(shots);
  if (run.paused_at && !['cancelled', 'delivered', 'stale'].includes(run.status)) {
    next.status = run.status;
  }
  const currentError = parseJson(run.last_error_json, {});
  const changed = run.status !== next.status
    || Number(run.progress || 0) !== Number(next.progress)
    || JSON.stringify(currentError) !== JSON.stringify(next.last_error);
  if (changed) {
    const now = nowIso();
    db.prepare(
      `UPDATE paper_studio_runs
       SET status = ?, progress = ?, last_error_json = ?, completed_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(next.status, next.progress, JSON.stringify(next.last_error), next.completed ? now : null, now, Number(runId));
  }
  return { ...next, changed };
}

module.exports = { PROGRESS, STAGE, FAILURES, aggregate, sync };
