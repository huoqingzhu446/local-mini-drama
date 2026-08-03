const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const storageLayout = require('../storageLayout');
const schemaService = require('./paperStudioSchemaService');
const shotService = require('./paperStudioShotService');
const snapshotService = require('./paperSnapshotService');
const spatialContractService = require('./paperSpatialContractService');
const motionGateService = require('./paperMotionGateService');
const transitionGateService = require('./paperTransitionGateService');
const { CURRENT_PLANNER_VERSION } = require('./paperStudioPlannerVersion');
const runAggregateService = require('./paperRunAggregateService');
const sourceService = require('./paperStudioSourceService');
const revisionService = require('./paperSourceRevisionService');
const { ffprobeMediaInfo } = require('../mergedEpisodePostProcess');
const { safeStorageFile, storageRoot } = require('./paperAssetProductionService');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');
const {
  distinctStates,
  numericRange,
  resolveTargetMotion,
} = require('../../paper-studio-renderer/motion/trackResolver.cjs');

const backendRoot = path.resolve(__dirname, '..', '..', '..');
const workerScript = path.join(backendRoot, 'scripts', 'render-paper-studio.mjs');

function toRelative(cfg, absolutePath) {
  const root = storageRoot(cfg);
  const resolved = path.resolve(absolutePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new PaperStudioError('PAPER_STUDIO_RENDER_PATH_INVALID', '渲染产物不在本地存储目录内', { path: absolutePath }, 500);
  }
  return path.relative(root, resolved).replace(/\\/g, '/');
}

function outputDirectory(db, cfg, shot, snapshot, mode) {
  const projectDir = storageLayout.getProjectStorageSubdir(db, shot.drama_id);
  const hash = String(snapshot.render_hash).replace('sha256:', '');
  const relative = `${projectDir}/paper-studio/runs/${shot.run_id}/shots/${shot.id}/renders/${hash}/${mode}`.replace(/\\/g, '/');
  const absolute = safeStorageFile(cfg, relative);
  fs.mkdirSync(absolute, { recursive: true });
  return { relative, absolute };
}

function validateRenderedMedia(snapshotJson, mediaInfo) {
  const fps = Math.max(1, Number(snapshotJson?.composition?.fps || 30));
  const expectedVideoSeconds = Number(snapshotJson?.composition?.duration_frames || 0) / fps;
  const expectedSpeechEndSeconds = (snapshotJson?.audio || []).reduce((max, source) => (
    Math.max(max, (Number(source.from_frame || 0) + Number(source.duration_frames || 0)) / fps)
  ), 0);
  const tolerance = Math.max(0.15, 2 / fps);
  const minimumTimelineSeconds = 5;
  const allowedPostrollSeconds = expectedSpeechEndSeconds > 0
    ? Math.max(1.5, minimumTimelineSeconds - expectedSpeechEndSeconds)
    : Infinity;
  const failures = [];
  if (!mediaInfo?.has_video) failures.push({ key: 'video_stream_missing' });
  if (Number(mediaInfo?.video_duration_seconds || mediaInfo?.format_duration_seconds || 0) + tolerance < expectedVideoSeconds) {
    failures.push({ key: 'video_truncated', expected_seconds: expectedVideoSeconds, actual_seconds: mediaInfo?.video_duration_seconds || mediaInfo?.format_duration_seconds || 0 });
  }
  if (expectedSpeechEndSeconds > 0 && !mediaInfo?.has_audio) failures.push({ key: 'audio_stream_missing' });
  if (expectedSpeechEndSeconds > 0 && Number(mediaInfo?.audio_duration_seconds || 0) + tolerance < expectedSpeechEndSeconds) {
    failures.push({ key: 'audio_truncated', expected_seconds: expectedSpeechEndSeconds, actual_seconds: mediaInfo?.audio_duration_seconds || 0 });
  }
  if (expectedSpeechEndSeconds > 0 && expectedVideoSeconds - expectedSpeechEndSeconds > allowedPostrollSeconds + tolerance) {
    failures.push({
      key: 'excessive_silent_postroll',
      speech_end_seconds: expectedSpeechEndSeconds,
      video_end_seconds: expectedVideoSeconds,
      actual_postroll_seconds: Number((expectedVideoSeconds - expectedSpeechEndSeconds).toFixed(3)),
      max_postroll_seconds: Number(allowedPostrollSeconds.toFixed(3)),
    });
  }
  return {
    pass: failures.length === 0,
    expected_video_seconds: Number(expectedVideoSeconds.toFixed(3)),
    expected_speech_end_seconds: Number(expectedSpeechEndSeconds.toFixed(3)),
    media: mediaInfo || null,
    failures,
  };
}

function assertRenderedMedia(snapshotJson, videoPath) {
  const report = validateRenderedMedia(snapshotJson, ffprobeMediaInfo(videoPath));
  if (!report.pass) {
    throw new PaperStudioError(
      'PAPER_STUDIO_RENDER_MEDIA_DURATION_MISMATCH',
      '渲染结果没有覆盖完整画面或语音，已阻止进入审核和发布',
      report,
      422,
    );
  }
  return report;
}

function runWorkerAttempt(cfg, log, {
  snapshotPath, output, mode, scale, crf, concurrency, timeoutMs, attempt,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      workerScript, '--snapshot', snapshotPath, '--output', output,
      '--public-dir', storageRoot(cfg), '--mode', mode, '--scale', String(scale),
      '--timeout-ms', String(timeoutMs),
    ];
    if (crf != null) args.push('--crf', String(crf));
    if (mode === 'proof') args.push('--proof-targets-per-browser', String(Math.max(1, Number(cfg?.paper_studio?.proof_browser_targets_per_session || 5))));
    else args.push('--concurrency', String(concurrency));
    const child = spawn(process.execPath, args, { cwd: backendRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (log) log.info('[paper-studio-render]', { mode, output: text.trim().slice(-500) });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new PaperStudioError('PAPER_STUDIO_RENDER_WORKER_FAILED', `纸片渲染进程失败（exit ${code}）`, {
        mode, attempt, concurrency, timeout_ms: timeoutMs,
        stderr: stderr.slice(-4000), stdout: stdout.slice(-2000),
      }, 500));
      const manifestPath = path.join(output, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return reject(new PaperStudioError('PAPER_STUDIO_RENDER_MANIFEST_MISSING', '纸片渲染进程未生成 manifest', { mode, output }, 500));
      try { resolve(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))); }
      catch (error) { reject(new PaperStudioError('PAPER_STUDIO_RENDER_MANIFEST_INVALID', '纸片渲染 manifest 无法解析', { error: error.message }, 500)); }
    });
  });
}

async function runWorker(cfg, log, { snapshotPath, output, mode, scale, crf }) {
  const previewConcurrency = Math.max(1, Math.min(2, Number(cfg?.paper_studio?.preview_render_concurrency || 2)));
  const formalConcurrency = Math.max(1, Number(cfg?.paper_studio?.formal_render_concurrency || cfg?.paper_studio?.render_concurrency || 1));
  const firstConcurrency = mode === 'preview' ? previewConcurrency : mode === 'formal' ? formalConcurrency : 1;
  const firstTimeoutMs = mode === 'preview'
    ? Math.max(30_000, Number(cfg?.paper_studio?.preview_frame_timeout_ms || 120_000))
    : mode === 'formal'
      ? Math.max(60_000, Number(cfg?.paper_studio?.formal_component_timeout_ms || 180_000))
      : 180_000;
  try {
    return await runWorkerAttempt(cfg, log, {
      snapshotPath, output, mode, scale, crf,
      concurrency: firstConcurrency,
      timeoutMs: firstTimeoutMs,
      attempt: 1,
    });
  } catch (error) {
    const stderr = String(error?.details?.stderr || '');
    const retryableDelay = error?.code === 'PAPER_STUDIO_RENDER_WORKER_FAILED'
      && /delayRender|timed?\s*out|timeout/i.test(stderr);
    const retryableMode = mode === 'preview' || mode === 'formal';
    if (!retryableMode || !retryableDelay) throw error;
    const retryTimeoutMs = mode === 'formal'
      ? Math.max(firstTimeoutMs, Number(cfg?.paper_studio?.formal_retry_timeout_ms || 300_000))
      : Math.max(firstTimeoutMs, 180_000);
    if (mode === 'preview' && firstConcurrency === 1 && retryTimeoutMs === firstTimeoutMs) throw error;
    if (log) log.warn(`Paper studio ${mode} stalled; restarting worker with one render tab`, {
      output, first_concurrency: firstConcurrency, retry_concurrency: 1,
      first_timeout_ms: firstTimeoutMs, retry_timeout_ms: retryTimeoutMs,
    });
    return runWorkerAttempt(cfg, log, {
      snapshotPath, output, mode, scale, crf, concurrency: 1,
      timeoutMs: retryTimeoutMs, attempt: 2,
    });
  }
}

async function pixelDifference(baselinePath, comparisonPath) {
  const baseline = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const comparison = await sharp(comparisonPath).resize(baseline.info.width, baseline.info.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let changed = 0;
  let absolute = 0;
  const pixels = baseline.info.width * baseline.info.height;
  for (let index = 0; index < baseline.data.length; index += 4) {
    const delta = (
      Math.abs(baseline.data[index] - comparison.data[index])
      + Math.abs(baseline.data[index + 1] - comparison.data[index + 1])
      + Math.abs(baseline.data[index + 2] - comparison.data[index + 2])
    ) / 3;
    absolute += delta;
    if (delta >= 12) changed += 1;
  }
  const [baselineStats, stats] = await Promise.all([sharp(baselinePath).stats(), sharp(comparisonPath).stats()]);
  const luminance = (input) => (input.channels || []).slice(0, 3).reduce((sum, channel) => sum + Number(channel.mean || 0), 0) / 3;
  const baselineLuminance = luminance(baselineStats);
  const comparisonLuminance = luminance(stats);
  return {
    changed_pixel_ratio: Number((changed / pixels).toFixed(6)),
    mean_absolute_difference: Number((absolute / pixels).toFixed(4)),
    entropy: Number((stats.entropy || 0).toFixed(6)),
    baseline_luminance: Number(baselineLuminance.toFixed(4)),
    mean_luminance: Number(comparisonLuminance.toFixed(4)),
    luminance_delta_ratio: Number((Math.abs(comparisonLuminance - baselineLuminance) / 255).toFixed(6)),
    width: baseline.info.width,
    height: baseline.info.height,
  };
}

function track(plan, target, property) {
  return [
    ...(plan.subject_tracks || []),
    ...(plan.camera_tracks || []),
    ...(plan.scene_tracks || []),
    ...(plan.transition_tracks || []),
  ].find((item) => item.target === target && item.property === property);
}

function assertSnapshotContinuity(snapshot, { requireCurrent = false } = {}) {
  const plannerVersion = Number(snapshot?.provenance?.planner_version || 0);
  if (requireCurrent && (plannerVersion !== CURRENT_PLANNER_VERSION || Number(snapshot?.schema_version || 0) < 4)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PLANNER_VERSION_STALE',
      '该成片来自旧版场景规划，只能继续查看；正式渲染或发布前请新建当前版本并重新通过预览',
      { actual_planner_version: plannerVersion, expected_planner_version: CURRENT_PLANNER_VERSION, snapshot_schema_version: Number(snapshot?.schema_version || 0) },
      409,
    );
  }
  return transitionGateService.assertPlan(snapshot.motion_plan || {}, {
    planner_version: plannerVersion,
    visual_scenes: snapshot.visual_scenes || [],
    transition_contracts: snapshot.transition_contracts || [],
    root: snapshot.root,
    source_families: snapshot.source_families || [],
    spatial_contract: snapshot.spatial_contract || {},
    visual_beats: snapshot.visual_beats || [],
    captions: snapshot.captions || [],
  }, '渲染前场景连续性复检未通过');
}

function findNode(root, key) {
  if (!root) return null;
  if (root.key === key) return root;
  for (const child of root.children || []) {
    const found = findNode(child, key);
    if (found) return found;
  }
  return null;
}

function assertionResult(assertion, target, plan, motionReport, root) {
  let actual;
  let pass = false;
  switch (assertion.type) {
    case 'subject_visible':
      actual = target.metrics.entropy;
      pass = actual >= 1;
      break;
    case 'state_equals':
      actual = resolveTargetMotion(plan, assertion.target || target.target_node_key, target.frame).state;
      pass = actual === assertion.value;
      break;
    case 'rotation_delta':
      actual = numericRange(track(plan, target.target_node_key, 'rotation'));
      pass = actual >= Number(assertion.min || 0);
      break;
    case 'camera_only':
      actual = motionReport.camera_only;
      pass = actual === Boolean(assertion.expected);
      break;
    case 'state_distinct_count':
      actual = distinctStates(track(plan, assertion.target || target.target_node_key, 'state'));
      pass = actual >= Number(assertion.min || 0);
      break;
    case 'track_range':
      actual = numericRange(track(plan, assertion.target || target.target_node_key, assertion.property));
      pass = actual >= Number(assertion.min || 0);
      break;
    case 'track_value_at_frame':
      actual = resolveTargetMotion(plan, assertion.target || target.target_node_key, target.frame)[assertion.property];
      pass = typeof actual === 'number'
        && (assertion.min == null || actual >= Number(assertion.min))
        && (assertion.max == null || actual <= Number(assertion.max));
      break;
    case 'final_track_value': {
      const selected = track(plan, assertion.target || target.target_node_key, assertion.property);
      const frames = selected?.keyframes || [];
      actual = frames.length ? frames[frames.length - 1].value : null;
      pass = typeof actual === 'number'
        && (assertion.min == null || actual >= Number(assertion.min))
        && (assertion.max == null || actual <= Number(assertion.max));
      break;
    }
    case 'relation_exists': {
      const node = findNode(root, assertion.node || target.target_node_key);
      actual = node ? {
        node: node.key,
        role: node.relation?.role || null,
        predicate: node.relation?.predicate || null,
        object: node.relation?.object || null,
      } : null;
      pass = Boolean(node)
        && (assertion.role == null || node.relation?.role === assertion.role)
        && (assertion.predicate == null || node.relation?.predicate === assertion.predicate)
        && (assertion.object == null || node.relation?.object === assertion.object);
      break;
    }
    default:
      actual = null;
      pass = false;
  }
  return { ...assertion, actual, pass };
}

async function evaluateProof(snapshot, manifest) {
  const motionReport = motionGateService.evaluate(snapshot.motion_plan, {
    catalog_key: snapshot.provenance?.catalog_key || 'capability-plan-v1',
    planner_version: Number(snapshot.provenance?.planner_version || 0),
    spatial_contract: snapshot.spatial_contract || {},
    visual_scenes: snapshot.visual_scenes || [],
    transition_contracts: snapshot.transition_contracts || [],
    root: snapshot.root,
    families: snapshot.source_families || [],
    visual_beats: snapshot.visual_beats || [],
    captions: snapshot.captions || [],
  });
  const targets = snapshot.proof_targets || [];
  const baselineArtifact = manifest.proofs[targets[0]?.key];
  const evidence = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const artifact = manifest.proofs[target.key];
    if (!artifact) throw new PaperStudioError('PAPER_STUDIO_PROOF_ARTIFACT_MISSING', '动态证明缺少目标帧', { target_key: target.key }, 500);
    const transitionTargets = target.transition_key
      ? targets.filter((item) => item.transition_key === target.transition_key)
      : [];
    const transitionIndex = transitionTargets.findIndex((item) => item.key === target.key);
    const previousTransitionTarget = transitionIndex > 0 ? transitionTargets[transitionIndex - 1] : null;
    const comparisonArtifact = previousTransitionTarget ? manifest.proofs[previousTransitionTarget.key] : baselineArtifact;
    const metrics = index === 0 || (target.transition_key && transitionIndex === 0)
      ? { changed_pixel_ratio: 0, mean_absolute_difference: 0, ...(await pixelDifference(artifact.crop_path, artifact.crop_path)) }
      : await pixelDifference(comparisonArtifact.crop_path, artifact.crop_path);
    if (target.transition_key) {
      metrics.transition_key = target.transition_key;
      metrics.transition_phase = target.transition_phase;
      metrics.transition_gate_pass = snapshot.transition_gate?.pass !== false;
      metrics.spatial_gate_pass = motionReport.spatial?.pass !== false;
    }
    const enriched = { ...target, metrics };
    const assertions = target.assertions.map((assertion) => assertionResult(assertion, enriched, snapshot.motion_plan, motionReport, snapshot.root));
    if (!target.transition_key && index > 0) assertions.push({ type: 'subject_pixel_change', min: 0.01, actual: metrics.changed_pixel_ratio, pass: metrics.changed_pixel_ratio >= 0.01 });
    const transitionContract = target.transition_key
      ? (snapshot.transition_contracts || []).find((item) => item.key === target.transition_key)
      : null;
    const hardCut = transitionContract?.kind === 'hard_cut' || transitionContract?.relation === 'explicit_hard_cut';
    if (target.transition_key && ((!hardCut && ['mid', 'end'].includes(target.transition_phase)) || (hardCut && target.transition_phase === 'start'))) {
      assertions.push({ type: 'transition_visual_change', min: 0.005, actual: metrics.changed_pixel_ratio, pass: metrics.changed_pixel_ratio >= 0.005 });
    }
    if (target.transition_key) {
      assertions.push({ type: 'transition_luminance_continuity', max: 0.32, actual: metrics.luminance_delta_ratio, pass: metrics.luminance_delta_ratio <= 0.32 });
      assertions.push({ type: 'transition_plan_gate', expected: true, actual: metrics.transition_gate_pass, pass: metrics.transition_gate_pass === true });
      if (!hardCut && ['start', 'post'].includes(target.transition_phase)) {
        assertions.push({ type: 'transition_endpoint_stability', max: 0.2, actual: metrics.changed_pixel_ratio, pass: metrics.changed_pixel_ratio <= 0.2 });
      }
      if (target.transition_phase === 'post') {
        assertions.push({ type: 'transition_spatial_gate', expected: true, actual: metrics.spatial_gate_pass, pass: metrics.spatial_gate_pass === true });
        assertions.push({ type: 'transition_caption_continuity', expected: 'global_overlay', actual: transitionContract?.caption_policy || null, pass: transitionContract?.caption_policy === 'global_overlay' });
        assertions.push({ type: 'transition_audio_continuity', expected: 'continuous', actual: transitionContract?.audio_policy || null, pass: transitionContract?.audio_policy === 'continuous' });
      }
    }
    evidence.push({ target, artifact, metrics, assertions, pass: assertions.every((assertion) => assertion.pass) && artifact.deterministic === true });
  }
  return { pass: motionReport.pass && evidence.every((item) => item.pass), camera_only: motionReport.camera_only, motion_gate: motionReport, evidence };
}

function createProofRun(db, shotId, snapshotId, kind, scale) {
  const result = db.prepare(
    `INSERT INTO paper_proof_runs
      (shot_id, snapshot_id, run_kind, scale, status, report_json, created_at)
     VALUES (?, ?, ?, ?, 'running', '{}', ?)`,
  ).run(Number(shotId), Number(snapshotId), kind, Number(scale), nowIso());
  return Number(result.lastInsertRowid);
}

function assertNoActiveProofRun(db, shotId, snapshotId) {
  const active = db.prepare(
    `SELECT id, created_at FROM paper_proof_runs
     WHERE shot_id = ? AND snapshot_id = ? AND run_kind = 'motion_proof' AND status = 'running'
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(shotId), Number(snapshotId));
  if (!active) return;
  throw new PaperStudioError(
    'PAPER_STUDIO_PROOF_ALREADY_RUNNING',
    '当前镜头的环境动态证据已经在检查中，请等待完成',
    { shot_id: Number(shotId), snapshot_id: Number(snapshotId), proof_run_id: Number(active.id), created_at: active.created_at },
    409,
  );
}

function assertSnapshotManifest(snapshotRow, manifest) {
  if (manifest.snapshot_hash !== snapshotRow.snapshot_hash || manifest.render_hash !== snapshotRow.render_hash) {
    throw new PaperStudioError('PAPER_STUDIO_SNAPSHOT_RENDER_MISMATCH', '渲染产物与冻结 snapshot 不一致', { expected: { snapshot_hash: snapshotRow.snapshot_hash, render_hash: snapshotRow.render_hash }, actual: { snapshot_hash: manifest.snapshot_hash, render_hash: manifest.render_hash } }, 409);
  }
}

function persistedRenderFailure(error, extra = {}) {
  return {
    code: error?.code || 'PAPER_STUDIO_RENDER_FAILED',
    message: error?.message || '纸片渲染失败',
    ...extra,
    details: error?.details || null,
    at: nowIso(),
  };
}

async function proof(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '执行动态门禁的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['motion_ready', 'proof_failed'].includes(shot.status)) throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头状态不允许执行动态门禁', { shot_id: shot.id, status: shot.status }, 409);
  const snapshot = snapshotService.get(db, shot.current_snapshot_id);
  spatialContractService.assertSnapshot(snapshot.snapshot_json);
  assertSnapshotContinuity(snapshot.snapshot_json);
  assertNoActiveProofRun(db, shot.id, snapshot.id);
  const scale = Number(cfg?.paper_studio?.preview_scale || 0.5);
  const proofRunId = createProofRun(db, shot.id, snapshot.id, 'motion_proof', scale);
  const output = outputDirectory(db, cfg, shot, snapshot, `proof-${proofRunId}`);
  try {
    const manifest = await runWorker(cfg, log, { snapshotPath: safeStorageFile(cfg, snapshot.local_path), output: output.absolute, mode: 'proof', scale });
    assertSnapshotManifest(snapshot, manifest);
    const report = await evaluateProof(snapshot.snapshot_json, manifest);
    const insertEvidence = db.prepare(
      `INSERT INTO paper_proof_evidence
        (proof_run_id, target_key, frame, full_local_path, crop_local_path,
         debug_local_path, metrics_json, assertion_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of report.evidence) {
      insertEvidence.run(proofRunId, item.target.key, Number(item.target.frame), toRelative(cfg, item.artifact.full_path), toRelative(cfg, item.artifact.crop_path), toRelative(cfg, item.artifact.debug_path), JSON.stringify(item.metrics), JSON.stringify(item.assertions), item.pass ? 'passed' : 'failed', nowIso());
    }
    const proofHash = sha256(canonicalJson({ snapshot_hash: snapshot.snapshot_hash, render_hash: snapshot.render_hash, artifacts: report.evidence.map((item) => item.artifact.full_hash), report: { pass: report.pass, camera_only: report.camera_only, evidence: report.evidence.map((item) => ({ key: item.target.key, metrics: item.metrics, assertions: item.assertions, pass: item.pass })) } }));
    db.prepare("UPDATE paper_proof_runs SET status = ?, preview_local_path = ?, report_json = ?, proof_hash = ?, completed_at = ? WHERE id = ?").run(report.pass ? 'passed' : 'failed', output.relative, JSON.stringify({ ...report, evidence: report.evidence.map((item) => ({ target: item.target, metrics: item.metrics, assertions: item.assertions, pass: item.pass })) }), proofHash, nowIso(), proofRunId);
    if (!report.pass) {
      const failure = { code: 'PAPER_STUDIO_DYNAMIC_GATE_FAILED', message: '动态证明未通过，不能渲染预览', proof_run_id: proofRunId, proof_hash: proofHash };
      db.prepare("UPDATE paper_studio_shots SET status = 'proof_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(failure), nowIso(), Number(shot.id));
      runAggregateService.sync(db, shot.run_id);
      throw new PaperStudioError(failure.code, failure.message, { proof_run_id: proofRunId, report }, 422);
    }
    db.prepare("UPDATE paper_studio_shots SET status = 'proof_ready', last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = 'proofing', progress = 68, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.run_id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key IN ('render_proof','dynamic_gate')").run(JSON.stringify({ proof_run_id: proofRunId, proof_hash: proofHash, snapshot_id: snapshot.id }), nowIso(), nowIso(), Number(shot.run_id), Number(shot.id));
    runAggregateService.sync(db, shot.run_id);
    return { shot: shotService.get(db, shot.id), proof: { id: proofRunId, proof_hash: proofHash, report } };
  } catch (error) {
    const row = db.prepare('SELECT status FROM paper_proof_runs WHERE id = ?').get(proofRunId);
    const failure = persistedRenderFailure(error, { step_key: 'render_proof', proof_run_id: proofRunId });
    if (row?.status === 'running') db.prepare("UPDATE paper_proof_runs SET status = 'failed', report_json = ?, completed_at = ? WHERE id = ?").run(JSON.stringify(failure), nowIso(), proofRunId);
    const latest = db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(Number(shot.id));
    if (['motion_ready', 'proof_failed'].includes(String(latest?.status || ''))) {
      db.prepare("UPDATE paper_studio_shots SET status = 'proof_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(failure), nowIso(), Number(shot.id));
    }
    runAggregateService.sync(db, shot.run_id);
    throw error;
  }
}

async function preview(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '渲染纸片预览的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  const snapshot = snapshotService.get(db, shot.current_snapshot_id);
  const previewRetry = shot.status === 'proof_failed'
    && shot.last_error_json?.step_key === 'render_preview'
    && Boolean(db.prepare(
      `SELECT 1 AS ok FROM paper_proof_runs
       WHERE shot_id = ? AND snapshot_id = ? AND run_kind = 'motion_proof' AND status = 'passed'
       ORDER BY id DESC LIMIT 1`,
    ).get(Number(shot.id), Number(snapshot.id)));
  if (shot.status !== 'proof_ready' && !previewRetry) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头尚未通过动态门禁', { shot_id: shot.id, status: shot.status }, 409);
  }
  assertSnapshotContinuity(snapshot.snapshot_json);
  const scale = Number(cfg?.paper_studio?.preview_scale || 0.5);
  const runId = createProofRun(db, shot.id, snapshot.id, 'preview', scale);
  const output = outputDirectory(db, cfg, shot, snapshot, `preview-${runId}`);
  try {
    const manifest = await runWorker(cfg, log, { snapshotPath: safeStorageFile(cfg, snapshot.local_path), output: output.absolute, mode: 'preview', scale, crf: cfg?.paper_studio?.render?.crf_preview || 28 });
    assertSnapshotManifest(snapshot, manifest);
    const mediaDuration = assertRenderedMedia(snapshot.snapshot_json, manifest.video.path);
    const videoPath = toRelative(cfg, manifest.video.path);
    db.prepare("UPDATE paper_proof_runs SET status = 'completed', preview_local_path = ?, report_json = ?, proof_hash = ?, completed_at = ? WHERE id = ?").run(videoPath, JSON.stringify({ manifest, media_duration: mediaDuration, snapshot_id: snapshot.id, render_hash: snapshot.render_hash }), manifest.video.hash, nowIso(), runId);
    db.prepare("UPDATE paper_studio_shots SET status = 'preview_ready', last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = 'preview_ready', progress = 78, updated_at = ? WHERE id = ?").run(nowIso(), Number(shot.run_id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, error_json = '{}', completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key = 'render_preview'").run(JSON.stringify({ proof_run_id: runId, preview_local_path: videoPath, artifact_hash: manifest.video.hash, snapshot_id: snapshot.id, render_hash: snapshot.render_hash }), nowIso(), nowIso(), Number(shot.run_id), Number(shot.id));
    runAggregateService.sync(db, shot.run_id);
    return { shot: shotService.get(db, shot.id), preview: { proof_run_id: runId, local_path: videoPath, url: `/static/${videoPath}`, artifact_hash: manifest.video.hash, snapshot_id: snapshot.id, render_hash: snapshot.render_hash } };
  } catch (error) {
    const failure = persistedRenderFailure(error, { step_key: 'render_preview', proof_run_id: runId });
    const now = nowIso();
    db.prepare("UPDATE paper_proof_runs SET status = 'failed', report_json = ?, completed_at = ? WHERE id = ?")
      .run(JSON.stringify(failure), now, runId);
    db.prepare("UPDATE paper_studio_shots SET status = 'proof_ready', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(failure), now, Number(shot.id));
    runAggregateService.sync(db, shot.run_id);
    throw error;
  }
}

function approvePreview(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '批准纸片预览的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (shot.status !== 'preview_ready') throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头没有待批准预览', { shot_id: shot.id, status: shot.status }, 409);
  const previewRow = db.prepare("SELECT * FROM paper_proof_runs WHERE shot_id = ? AND snapshot_id = ? AND run_kind = 'preview' AND status = 'completed' ORDER BY id DESC LIMIT 1").get(Number(shot.id), Number(shot.current_snapshot_id));
  if (!previewRow?.preview_local_path || !fs.existsSync(safeStorageFile(cfg, previewRow.preview_local_path))) throw new PaperStudioError('PAPER_STUDIO_PREVIEW_MISSING', '预览文件不存在，不能批准', { shot_id: shot.id }, 409);
  const snapshot = snapshotService.get(db, shot.current_snapshot_id);
  spatialContractService.assertSnapshot(snapshot.snapshot_json);
  assertSnapshotContinuity(snapshot.snapshot_json);
  const now = nowIso();
  const approve = db.transaction(() => {
    db.prepare("UPDATE paper_render_snapshots SET status = 'approved', approved_at = ? WHERE id = ?").run(now, Number(snapshot.id));
    db.prepare("UPDATE paper_studio_shots SET status = 'approved', approved_snapshot_id = ?, version = version + 1, updated_at = ? WHERE id = ?").run(Number(snapshot.id), now, Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = 'approved', progress = 84, updated_at = ? WHERE id = ?").run(now, Number(shot.run_id));
    db.prepare("UPDATE paper_job_steps SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND shot_id = ? AND step_key = 'wait_preview_approval'").run(JSON.stringify({ snapshot_id: snapshot.id, render_hash: snapshot.render_hash, preview_artifact_hash: previewRow.proof_hash, approved_at: now }), now, now, Number(shot.run_id), Number(shot.id));
  });
  approve();
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio preview approved', { shot_id: Number(shot.id), snapshot_id: Number(snapshot.id), preview_artifact_hash: previewRow.proof_hash });
  return { shot: shotService.get(db, shot.id), approval: { snapshot_id: Number(snapshot.id), render_hash: snapshot.render_hash, preview_artifact_hash: previewRow.proof_hash, approved_at: now } };
}

function rejectPreview(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiPreviewReject', body, '退回纸片预览的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (shot.status !== 'preview_ready') {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头没有待退回的预览', { shot_id: shot.id, status: shot.status }, 409);
  }
  const snapshotId = Number(shot.current_snapshot_id || 0);
  const now = nowIso();
  const rejection = {
    code: 'PAPER_STUDIO_PREVIEW_REJECTED',
    message: String(body.reason || '').trim(),
    request_id: body.request_id,
    snapshot_id: snapshotId,
    rejected_at: now,
  };
  const transaction = db.transaction(() => {
    db.prepare("UPDATE paper_render_snapshots SET status = 'superseded' WHERE id = ? AND shot_id = ? AND status IN ('compiled','approved')")
      .run(snapshotId, Number(shot.id));
    db.prepare("UPDATE paper_proof_runs SET status = 'superseded' WHERE shot_id = ? AND snapshot_id = ? AND status IN ('passed','completed')")
      .run(Number(shot.id), snapshotId);
    db.prepare("UPDATE paper_motion_plans SET status = 'confirmed', compiled_tracks_json = '{}', version = version + 1, updated_at = ? WHERE shot_id = ?")
      .run(now, Number(shot.id));
    db.prepare(`UPDATE paper_studio_shots
      SET status = 'asset_ready', current_snapshot_id = NULL, approved_snapshot_id = NULL,
          last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(rejection), now, Number(shot.id));
    db.prepare(`UPDATE paper_job_steps
      SET status = 'queued', attempt = 1, result_json = '{}', error_json = '{}',
          lease_owner = NULL, lease_expires_at = NULL, started_at = NULL,
          completed_at = NULL, updated_at = ?
      WHERE run_id = ? AND shot_id = ? AND step_key IN
        ('plan_motion','compile_snapshot','render_proof','dynamic_gate','render_preview','wait_preview_approval','render_formal','publish_video')`)
      .run(now, Number(shot.run_id), Number(shot.id));
    db.prepare("UPDATE paper_studio_runs SET status = 'motion_planning', progress = 45, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(rejection), now, Number(shot.run_id));
  });
  transaction();
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio preview rejected', { shot_id: Number(shot.id), snapshot_id: snapshotId, reason: rejection.message });
  return { shot: shotService.get(db, shot.id), rejection };
}

function selectExistingFormalRender(db, shot, snapshot) {
  return db.prepare(
    `SELECT * FROM video_generations
     WHERE paper_studio_shot_id = ? AND paper_snapshot_id = ? AND render_hash = ?
       AND generation_kind = 'paper_studio' AND status IN ('processing', 'completed')
       AND deleted_at IS NULL
     ORDER BY CASE status WHEN 'completed' THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
  ).get(Number(shot.id), Number(snapshot.id), snapshot.render_hash);
}

function claimFormalRender(db, shot, snapshot) {
  const claim = db.transaction(() => {
    const existing = selectExistingFormalRender(db, shot, snapshot);
    if (existing) {
      if (existing.status === 'processing' && shot.status !== 'rendering') {
        const now = nowIso();
        db.prepare(
          `UPDATE paper_studio_shots
           SET status = 'rendering', last_error_json = '{}', version = version + 1, updated_at = ?
           WHERE id = ? AND status IN ('approved', 'render_failed')`,
        ).run(now, Number(shot.id));
      }
      return {
        id: Number(existing.id),
        owner: false,
        reused: true,
        in_progress: existing.status === 'processing',
        row: existing,
      };
    }

    const now = nowIso();
    const result = db.prepare(
      `INSERT OR IGNORE INTO video_generations
        (drama_id, storyboard_id, paper_storyboard_id, provider, prompt, model, duration, aspect_ratio,
         status, generation_kind, render_hash, renderer_version, paper_studio_shot_id,
         paper_snapshot_id, created_at, updated_at)
       VALUES (?, ?, ?, 'local-remotion', ?, ?, ?, '16:9', 'processing', 'paper_studio', ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(shot.drama_id),
      sourceService.legacyStoryboardId(shot),
      shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id),
      `Paper Studio v3 snapshot ${snapshot.id}`,
      snapshot.renderer_version,
      Number(snapshot.snapshot_json.composition.duration_frames) / Number(snapshot.snapshot_json.composition.fps),
      snapshot.render_hash,
      snapshot.renderer_version,
      Number(shot.id),
      Number(snapshot.id),
      now,
      now,
    );
    if (result.changes !== 1) {
      const raced = selectExistingFormalRender(db, shot, snapshot);
      if (!raced) throw new PaperStudioError('PAPER_STUDIO_FORMAL_RENDER_CLAIM_FAILED', '正式渲染任务未能建立或复用', { shot_id: Number(shot.id), snapshot_id: Number(snapshot.id) }, 409);
      return { id: Number(raced.id), owner: false, reused: true, in_progress: raced.status === 'processing', row: raced };
    }

    db.prepare(
      `UPDATE paper_studio_shots
       SET status = 'rendering', last_error_json = '{}', version = version + 1, updated_at = ?
       WHERE id = ? AND status IN ('approved', 'render_failed')`,
    ).run(now, Number(shot.id));
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?,
           user_visible_status = '正在渲染正式视频'
       WHERE run_id = ? AND shot_id = ? AND step_key = 'render_formal'
         AND status IN ('queued', 'failed_retryable')`,
    ).run(now, now, Number(shot.run_id), Number(shot.id));
    return { id: Number(result.lastInsertRowid), owner: true, reused: false, in_progress: true };
  });
  return claim.immediate();
}

async function renderFormal(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '渲染正式纸片视频的参数无效');
  const shot = shotService.get(db, shotId);
  if (!shot.approved_snapshot_id) throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '正式渲染前必须批准同一 snapshot 的预览', { shot_id: shot.id, status: shot.status }, 409);
  const snapshot = snapshotService.get(db, shot.approved_snapshot_id);
  spatialContractService.assertSnapshot(snapshot.snapshot_json);
  assertSnapshotContinuity(snapshot.snapshot_json, { requireCurrent: true });
  if (Number(snapshot.id) !== Number(shot.current_snapshot_id) || snapshot.status !== 'approved') throw new PaperStudioError('PAPER_STUDIO_SNAPSHOT_APPROVAL_MISMATCH', '当前 snapshot 与已批准 snapshot 不一致', { current_snapshot_id: shot.current_snapshot_id, approved_snapshot_id: shot.approved_snapshot_id }, 409);
  const existing = selectExistingFormalRender(db, shot, snapshot);
  if (existing?.status === 'processing') {
    if (shot.status !== 'rendering') {
      db.prepare("UPDATE paper_studio_shots SET status = 'rendering', last_error_json = '{}', version = version + 1, updated_at = ? WHERE id = ? AND status IN ('approved', 'render_failed')").run(nowIso(), Number(shot.id));
      runAggregateService.sync(db, shot.run_id);
    }
    return {
      shot: shotService.get(db, shot.id),
      video_generation: { ...existing, id: Number(existing.id), reused: true, in_progress: true },
    };
  }
  if (existing?.status === 'completed') {
    if (!['rendered', 'published'].includes(shot.status)) {
      db.prepare("UPDATE paper_studio_shots SET status = 'rendered', published_video_generation_id = ?, version = version + 1, updated_at = ? WHERE id = ?").run(Number(existing.id), nowIso(), Number(shot.id));
    }
    runAggregateService.sync(db, shot.run_id);
    return { shot: shotService.get(db, shot.id), video_generation: { ...existing, id: Number(existing.id), reused: true, in_progress: false } };
  }
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['approved', 'render_failed'].includes(shot.status)) throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '正式渲染前必须批准同一 snapshot 的预览', { shot_id: shot.id, status: shot.status }, 409);
  const video = claimFormalRender(db, shot, snapshot);
  if (!video.owner) {
    runAggregateService.sync(db, shot.run_id);
    return {
      shot: shotService.get(db, shot.id),
      video_generation: { ...video.row, id: video.id, reused: true, in_progress: video.in_progress },
    };
  }
  runAggregateService.sync(db, shot.run_id);
  const output = outputDirectory(db, cfg, shot, snapshot, `formal-vg-${video.id}`);
  try {
    const manifest = await runWorker(cfg, log, { snapshotPath: safeStorageFile(cfg, snapshot.local_path), output: output.absolute, mode: 'formal', scale: 1, crf: cfg?.paper_studio?.render?.crf_formal || 20 });
    assertSnapshotManifest(snapshot, manifest);
    const mediaDuration = assertRenderedMedia(snapshot.snapshot_json, manifest.video.path);
    const localPath = toRelative(cfg, manifest.video.path);
    const url = `/static/${localPath}`;
    const now = nowIso();
    const finish = db.transaction(() => {
      db.prepare("UPDATE video_generations SET video_url = ?, local_path = ?, status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(url, localPath, now, now, video.id);
      db.prepare(
        `UPDATE paper_studio_shots
         SET status = 'rendered', published_video_generation_id = ?, last_error_json = '{}',
             version = version + 1, updated_at = ?
         WHERE id = ? AND status != 'published'`,
      ).run(video.id, now, Number(shot.id));
      db.prepare(
        `UPDATE paper_job_steps
         SET status = 'completed', result_json = ?, error_json = '{}',
             lease_owner = NULL, lease_expires_at = NULL,
             completed_at = ?, updated_at = ?
         WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ?
           AND step_key = 'render_formal' AND status = 'running'`,
      ).run(
        JSON.stringify({ video_generation_id: video.id, snapshot_id: snapshot.id, render_hash: snapshot.render_hash, artifact_hash: manifest.video.hash, local_path: localPath, media_duration: mediaDuration }),
        now, now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id),
      );
    });
    finish();
    runAggregateService.sync(db, shot.run_id);
    return { shot: shotService.get(db, shot.id), video_generation: { id: video.id, generation_kind: 'paper_studio', local_path: localPath, video_url: url, artifact_hash: manifest.video.hash, snapshot_id: snapshot.id, render_hash: snapshot.render_hash, reused: false } };
  } catch (error) {
    const now = nowIso();
    const failure = persistedRenderFailure(error, { step_key: 'render_formal', video_generation_id: video.id });
    db.prepare("UPDATE video_generations SET status = 'failed', error_msg = ?, updated_at = ? WHERE id = ?").run(error.message, now, video.id);
    db.prepare("UPDATE paper_studio_shots SET status = 'render_failed', last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(failure), now, Number(shot.id));
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'failed_retryable', error_json = ?, updated_at = ?
       WHERE run_id = ? AND shot_id = ? AND step_key = 'render_formal'
         AND status = 'running' AND lease_owner IS NULL`,
    ).run(JSON.stringify(failure), now, Number(shot.run_id), Number(shot.id));
    runAggregateService.sync(db, shot.run_id);
    throw error;
  }
}

function publish(db, cfg, log, shotId, body = {}) {
  revisionService.assertShotCurrent(db, shotId);
  schemaService.assertValid('apiShotAction', body, '发布纸片视频的参数无效');
  const shot = shotService.get(db, shotId);
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (shot.status !== 'rendered') throw new PaperStudioError('PAPER_STUDIO_SHOT_STATE_CONFLICT', '当前镜头没有可发布的正式视频', { shot_id: shot.id, status: shot.status }, 409);
  const video = db.prepare("SELECT * FROM video_generations WHERE id = ? AND paper_studio_shot_id = ? AND paper_snapshot_id = ? AND generation_kind = 'paper_studio' AND status = 'completed' AND deleted_at IS NULL").get(Number(shot.published_video_generation_id), Number(shot.id), Number(shot.approved_snapshot_id));
  if (!video?.local_path || !fs.existsSync(safeStorageFile(cfg, video.local_path))) throw new PaperStudioError('PAPER_STUDIO_FORMAL_ARTIFACT_MISSING', '正式渲染文件不存在，不能发布', { video_generation_id: video?.id }, 409);
  const snapshot = snapshotService.get(db, shot.approved_snapshot_id);
  spatialContractService.assertSnapshot(snapshot.snapshot_json);
  assertSnapshotContinuity(snapshot.snapshot_json, { requireCurrent: true });
  if (video.render_hash !== snapshot.render_hash) throw new PaperStudioError('PAPER_STUDIO_FORMAL_HASH_MISMATCH', '正式视频不是来自已批准 snapshot', { video_render_hash: video.render_hash, approved_render_hash: snapshot.render_hash }, 409);
  const now = nowIso();
  const transaction = db.transaction(() => {
    if (sourceService.isPaperShot(shot)) {
      const storyboard = db.prepare('SELECT paper_episode_id FROM paper_storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(shot.paper_storyboard_id));
      if (!storyboard) throw new PaperStudioError('PAPER_STORYBOARD_NOT_FOUND', '纸片分镜不存在', { paper_storyboard_id: Number(shot.paper_storyboard_id) }, 404);
      require('./paperStoryboardService').invalidateEpisodeMerges(db, storyboard.paper_episode_id, { now });
      db.prepare("UPDATE paper_storyboards SET published_video_generation_id = ?, status = 'published', version = version + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(Number(video.id), now, Number(shot.paper_storyboard_id));
    } else {
      db.prepare("UPDATE storyboards SET video_url = ?, video_render_mode = 'paper_studio_v3', updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(video.video_url, now, Number(shot.legacy_storyboard_id || shot.storyboard_id));
    }
    db.prepare("UPDATE paper_studio_shots SET status = 'published', version = version + 1, updated_at = ? WHERE id = ?").run(now, Number(shot.id));
    db.prepare(
      `UPDATE paper_job_steps
       SET status = 'completed', result_json = ?, error_json = '{}',
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE run_id = ? AND shot_id = ? AND plan_revision_id = ?
         AND step_key = 'publish_video' AND status IN ('queued','running','failed_retryable')`,
    ).run(
      JSON.stringify({ video_generation_id: Number(video.id), video_url: video.video_url, snapshot_id: snapshot.id, render_hash: snapshot.render_hash }),
      now, now, Number(shot.run_id), Number(shot.id), Number(shot.current_plan_revision_id),
    );
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM paper_studio_shots WHERE run_id = ? AND deleted_at IS NULL AND status != 'published'").get(Number(shot.run_id));
    db.prepare('UPDATE paper_studio_runs SET status = ?, progress = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(Number(remaining.count) === 0 ? 'delivered' : 'partial', Number(remaining.count) === 0 ? 100 : 95, Number(remaining.count) === 0 ? now : null, now, Number(shot.run_id));
  });
  transaction();
  runAggregateService.sync(db, shot.run_id);
  if (log) log.info('Paper studio video published', { shot_id: Number(shot.id), storyboard_id: sourceService.legacyStoryboardId(shot), paper_storyboard_id: shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id), video_generation_id: Number(video.id), render_hash: video.render_hash });
  return { shot: shotService.get(db, shot.id), video_generation: { ...video, id: Number(video.id) } };
}

module.exports = {
  runWorker,
  validateRenderedMedia,
  assertRenderedMedia,
  pixelDifference,
  assertionResult,
  evaluateProof,
  assertSnapshotContinuity,
  assertNoActiveProofRun,
  proof,
  preview,
  approvePreview,
  rejectPreview,
  selectExistingFormalRender,
  claimFormalRender,
  renderFormal,
  publish,
};
