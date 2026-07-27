const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const snapshotService = require('./paperSnapshotService');
const runAggregateService = require('./paperRunAggregateService');
const actionCatalogService = require('./paperActionCatalogService');
const revisionService = require('./paperSourceRevisionService');
const {
  PaperStudioError,
  assertExpectedVersion,
  nowIso,
} = require('./paperStudioUtils');
const {
  distinctStates,
  motionSemantics,
  numericRange,
  orderedKeyframes,
  resolveTrackValue,
} = require('../../paper-studio-renderer/motion/trackResolver.cjs');

function finalNumericValue(track) {
  const keyframes = orderedKeyframes(track);
  const value = keyframes[keyframes.length - 1]?.value;
  return typeof value === 'number' ? value : null;
}

function evaluate(plan, summary = {}) {
  const semantics = motionSemantics(plan);
  const catalogReport = actionCatalogService.validatePlan(plan);
  const assertions = [
    { key: 'camera_only_false', pass: plan.camera_only === false && semantics.camera_only === false, actual: semantics.camera_only, expected: false },
    { key: 'visible_subject_tracks', pass: semantics.visible_subject_track_count >= 1, actual: semantics.visible_subject_track_count, min: 1 },
    ...catalogReport.assertions,
  ];
  for (const requirement of plan.gate_requirements || []) {
    const targetTrack = [...(plan.subject_tracks || []), ...(plan.camera_tracks || [])].find((track) => (
      track.target === requirement.target && track.property === requirement.property
    ));
    let actual = null;
    let pass = false;
    if (requirement.metric === 'numeric_range') {
      actual = numericRange(targetTrack);
      pass = actual >= Number(requirement.min || 0);
    } else if (requirement.metric === 'distinct_states') {
      actual = distinctStates(targetTrack);
      pass = actual >= Number(requirement.min || 0);
    } else if (requirement.metric === 'initial_value') {
      actual = resolveTrackValue(targetTrack, 0);
      pass = typeof actual === 'number'
        && (requirement.min == null || actual >= Number(requirement.min))
        && (requirement.max == null || actual <= Number(requirement.max));
    } else if (requirement.metric === 'final_value') {
      actual = finalNumericValue(targetTrack);
      pass = actual != null
        && (requirement.min == null || actual >= Number(requirement.min))
        && (requirement.max == null || actual <= Number(requirement.max));
    } else if (requirement.metric === 'cue_value') {
      const cue = (plan.cues || []).find((item) => item.key === requirement.cue);
      actual = cue ? resolveTrackValue(targetTrack, Number(cue.frame)) : null;
      pass = typeof actual === 'number'
        && (requirement.min == null || actual >= Number(requirement.min))
        && (requirement.max == null || actual <= Number(requirement.max));
    } else if (requirement.metric === 'cue_exists') {
      actual = (plan.cues || []).map((cue) => cue.key);
      pass = actual.includes(requirement.cue);
    }
    assertions.push({
      key: requirement.key,
      metric: requirement.metric,
      pass,
      actual,
      ...(requirement.min == null ? {} : { min: Number(requirement.min) }),
      ...(requirement.max == null ? {} : { max: Number(requirement.max) }),
      ...(requirement.cue ? { expected: requirement.cue } : {}),
    });
  }
  return { pass: assertions.every((assertion) => assertion.pass), camera_only: semantics.camera_only, semantics, catalog: catalogReport.action, assertions };
}

function planMotion(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '规划主体动作的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['asset_ready', 'motion_failed'].includes(shot.status)) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头状态不允许编译动作', { shot_id: shot.id, status: shot.status }, 409);
  }
  const report = evaluate(shot.motion_plan?.plan_json || {}, shot.plan_summary_json || {});
  if (!report.pass) {
    const failure = { code: 'PAPER_STUDIO_MOTION_GATE_FAILED', message: '主体动作没有达到语义门禁', report, at: nowIso() };
    db.prepare("UPDATE paper_studio_shots SET status = 'motion_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(failure), nowIso(), Number(shot.id));
    runAggregateService.sync(db, shot.run_id);
    throw new PaperStudioError(failure.code, failure.message, report, 422);
  }
  db.prepare("UPDATE paper_motion_plans SET status = 'compiled', compiled_tracks_json = ?, version = version + 1, updated_at = ? WHERE shot_id = ?").run(JSON.stringify({ subject_tracks: shot.motion_plan.plan_json.subject_tracks, camera_tracks: shot.motion_plan.plan_json.camera_tracks, gate: report }), nowIso(), Number(shot.id));
  const snapshot = snapshotService.compile(db, cfg, shot.id);
  db.prepare("UPDATE paper_studio_shots SET status = 'motion_ready', current_snapshot_id = ?, last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?").run(snapshot.snapshot_id, nowIso(), Number(shot.id));
  db.prepare("UPDATE paper_studio_runs SET status = 'proofing', progress = 55, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.run_id));
  db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key IN ('plan_motion','compile_snapshot')").run(JSON.stringify({ snapshot_id: snapshot.snapshot_id, snapshot_hash: snapshot.snapshot_hash, render_hash: snapshot.render_hash, gate: report }), nowIso(), nowIso(), Number(shot.run_id), Number(shot.id));
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio motion compiled', { shot_id: Number(shot.id), snapshot_id: snapshot.snapshot_id, render_hash: snapshot.render_hash });
  return { shot: shotService.get(db, shot.id), snapshot: { id: snapshot.snapshot_id, snapshot_hash: snapshot.snapshot_hash, render_hash: snapshot.render_hash, local_path: snapshot.local_path, reused: snapshot.reused }, gate: report };
}

module.exports = { evaluate, planMotion };
