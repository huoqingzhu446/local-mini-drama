const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const tracks = require('../src/paper-studio-renderer/motion/trackResolver.cjs');
const renderService = require('../src/services/paper-studio/paperStudioRenderService');
const stateService = require('../src/services/paper-studio/paperStudioStateService');
const orchestratorService = require('../src/services/paper-studio/paperOrchestratorService');

const motionPlan = {
  subject_tracks: [
    { target: 'supported_group', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: 60, value: 13, easing: 'ease-out' }, { frame: 100, value: 9 }] },
    { target: 'supported_group', property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: 100, value: 0.24, easing: 'ease-in' }] },
    { target: 'actors', property: 'state', keyframes: [{ frame: 0, value: 'engage' }, { frame: 40, value: 'destabilize' }, { frame: 60, value: 'separate' }, { frame: 100, value: 'separate' }] },
    { target: 'boundary_front', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.16 }, { frame: 100, value: 0.58 }] },
  ],
  camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: 100, value: 1.03 }] }],
};

test('track resolver is deterministic, frame-driven and holds categorical states', () => {
  const peakA = tracks.resolveTargetMotion(motionPlan, 'supported_group', 60);
  const peakB = tracks.resolveTargetMotion(motionPlan, 'supported_group', 60);
  assert.deepEqual(peakA, peakB);
  assert.equal(peakA.rotation, 13);
  assert.equal(tracks.resolveTargetMotion(motionPlan, 'actors', 39).state, 'engage');
  assert.equal(tracks.resolveTargetMotion(motionPlan, 'actors', 40).state, 'destabilize');
  assert.equal(tracks.resolveTargetMotion(motionPlan, 'actors', 61).state, 'separate');
  assert.equal(tracks.distinctStates(motionPlan.subject_tracks[2]), 3);
});

test('motion semantic gate rejects camera-only plans and accepts a moving subject', () => {
  const semantics = tracks.motionSemantics(motionPlan);
  assert.equal(semantics.camera_only, false);
  assert.ok(semantics.visible_subject_track_count >= 3);
  const cameraOnly = tracks.motionSemantics({
    subject_tracks: [{ target: 'paper_texture', property: 'x', keyframes: [{ frame: 0, value: 0 }, { frame: 60, value: 0.001 }] }],
    camera_tracks: motionPlan.camera_tracks,
  });
  assert.equal(cameraOnly.camera_only, true);
});

test('render media duration gate requires both video and audio streams to cover the frozen snapshot', () => {
  const snapshot = {
    composition: { fps: 30, duration_frames: 510 },
    audio: [{ from_frame: 0, duration_frames: 474 }],
  };
  const pass = renderService.validateRenderedMedia(snapshot, {
    has_video: true, has_audio: true,
    video_duration_seconds: 17,
    audio_duration_seconds: 15.8,
    format_duration_seconds: 17,
  });
  assert.equal(pass.pass, true);
  const truncated = renderService.validateRenderedMedia(snapshot, {
    has_video: true, has_audio: true,
    video_duration_seconds: 10,
    audio_duration_seconds: 10.05,
    format_duration_seconds: 10.05,
  });
  assert.equal(truncated.pass, false);
  assert.deepEqual(truncated.failures.map((item) => item.key), ['video_truncated', 'audio_truncated']);
  const excessivePostroll = renderService.validateRenderedMedia({
    composition: { fps: 30, duration_frames: 360 },
    audio: [{ from_frame: 0, duration_frames: 180 }],
  }, {
    has_video: true, has_audio: true,
    video_duration_seconds: 12,
    audio_duration_seconds: 6,
    format_duration_seconds: 12,
  });
  assert.equal(excessivePostroll.pass, false);
  assert.deepEqual(excessivePostroll.failures.map((item) => item.key), ['excessive_silent_postroll']);
});

test('v3 renderer is isolated and uses Img/staticFile, recursive nodes and registered foreground z-order', () => {
  const root = path.join(__dirname, '..', 'src', 'paper-studio-renderer');
  const composition = fs.readFileSync(path.join(root, 'PaperStudioComposition.jsx'), 'utf8');
  const recursive = fs.readFileSync(path.join(root, 'RecursiveNode.jsx'), 'utf8');
  const asset = fs.readFileSync(path.join(root, 'AssetNode.jsx'), 'utf8');
  const procedural = fs.readFileSync(path.join(root, 'ProceduralLayer.jsx'), 'utf8');
  assert.match(composition, /useCurrentFrame/);
  assert.match(composition, /RecursiveNode/);
  assert.match(recursive, /supported-subject/);
  assert.match(recursive, /registered-environment/);
  assert.match(asset, /<Img/);
  assert.match(asset, /staticFile/);
  assert.match(procedural, /procedural-boundary-front/);
  assert.match(procedural, /maskMode: 'luminance'/);
  assert.match(procedural, /data-boundary-mask/);
  assert.doesNotMatch(procedural, /amount \* 42/);
  assert.match(recursive, /assetMap=\{assetMap\} snapshot=\{snapshot\}/);
  assert.match(procedural, /procedural-atmosphere/);
  assert.match(procedural, /procedural-path-reveal/);
  assert.match(procedural, /procedural-label-card/);
  assert.match(procedural, /const LabelCard/);
  assert.match(procedural, /procedural-crowd-formation/);
  assert.match(procedural, /const CrowdFormation/);
  assert.match(procedural, /procedural-ember-drift/);
  assert.match(procedural, /'route-reveal': 'path-reveal'/);
  assert.match(procedural, /'map-title-card': 'label-card'/);
  assert.match(procedural, /'army-formation': 'crowd-formation'/);
  assert.match(procedural, /'ember-field': 'ember-drift'/);
  assert.match(procedural, /theme\?\.palette\?\.accent/);
  assert.match(procedural, /const lineWidth = encirclement \? 7 : 5/);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-paper-studio.mjs'), 'utf8');
  assert.match(worker, /PROOF_REPEAT_SPARSE_OUTLIER_RATIO = 0\.0002/);
  assert.match(composition, /cameraOverscanScale/);
  assert.match(recursive, /snapshot\.visual_style/);
  assert.match(recursive, /state_contact_anchors/);
  assert.match(recursive, /contact_lock/);
  assert.match(recursive, /secondary = \{ \.\.\.secondary, y: 0 \}/);
  assert.match(asset, /contactAnchor/);
  assert.doesNotMatch(composition, /PaperComposition/);
  for (const source of [composition, recursive, asset, procedural]) {
    assert.doesNotMatch(source, /animation\s*:/);
    assert.doesNotMatch(source, /transition\s*:/);
  }
});

test('proof renderer reuses a bounded browser batch and retries one target after browser failure', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-paper-studio.mjs'), 'utf8');
  assert.match(worker, /proofTargetsPerBrowser.*\|\| 5/);
  assert.match(worker, /targetsInSession >= proofTargetsPerBrowser/);
  assert.match(worker, /Date\.now\(\) - sessionStartedAt >= 60_000/);
  assert.match(worker, /await renderTarget\(true\)/);
  assert.match(worker, /await proofBrowser\.close\(\{ silent: true \}\)/);
  assert.match(worker, /mode === 'proof' \? null : await openRenderBrowser\(\)/);
  assert.match(worker, /delayRender\|timed\?\\s\*out\|timeout/);
});

test('preview and formal renderers use bounded timeouts and restart with one render tab', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-paper-studio.mjs'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paper-studio', 'paperStudioRenderService.js'), 'utf8');
  assert.match(worker, /args\['timeout-ms'\]/);
  assert.match(worker, /mode === 'preview' \? Math\.min\(2, configuredConcurrency\) : configuredConcurrency/);
  assert.match(worker, /timeoutInMilliseconds: renderTimeoutMs/);
  assert.match(service, /preview_render_concurrency \|\| 2/);
  assert.match(service, /preview_frame_timeout_ms \|\| 120_000/);
  assert.match(service, /formal_render_concurrency/);
  assert.match(service, /formal_component_timeout_ms \|\| 180_000/);
  assert.match(service, /formal_retry_timeout_ms \|\| 300_000/);
  assert.match(service, /restarting worker with one render tab/);
  assert.match(service, /mode === 'preview' \|\| mode === 'formal'/);
  assert.match(service, /else args\.push\('--concurrency', String\(concurrency\)\)/);
  assert.match(service, /concurrency: 1/);
  assert.match(service, /Math\.max\(firstTimeoutMs, Number/);
  assert.match(service, /plan_revision_id = \?[\s\S]*step_key = 'render_formal'/);
  assert.match(service, /plan_revision_id = \?[\s\S]*step_key = 'publish_video'/);
});

test('preview render failure keeps passed proof reusable and exposes the correct retry action', () => {
  assert.equal(orchestratorService.ACTIONS.render_preview.failureState, 'proof_ready');
  assert.deepEqual(
    stateService.nextActionForShot('proof_ready', { step_key: 'render_preview' }),
    { type: 'render_preview', label: '重试预览渲染', blocking: true },
  );
  assert.deepEqual(
    stateService.nextActionForShot('proof_failed', { step_key: 'render_preview' }),
    { type: 'render_preview', label: '重试预览渲染', blocking: true },
  );
  assert.deepEqual(
    stateService.nextActionForShot('proof_failed', { step_key: 'render_proof' }),
    { type: 'inspect_evidence', label: '检查动态证据', blocking: true },
  );
});

test('renderer publishes a first bundle atomically behind a cross-process lock', async () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-paper-studio.mjs'), 'utf8');
  assert.match(worker, /ensureBundleCache/);
  assert.match(worker, /bundle_lock_waited: bundleResult\.waitedForLock/);
  const { ensureBundleCache, validBundleDirectory } = await import('../src/services/paper-studio/paperStudioBundleCache.mjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lmd-paper-bundle-cache-'));
  const cacheDirectory = path.join(root, 'same-key');
  let builds = 0;
  const build = async (temporaryDirectory) => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    fs.writeFileSync(path.join(temporaryDirectory, 'index.html'), '<!doctype html>');
  };
  try {
    const results = await Promise.all([
      ensureBundleCache({ cacheDirectory, build, pollMilliseconds: 5 }),
      ensureBundleCache({ cacheDirectory, build, pollMilliseconds: 5 }),
    ]);
    assert.equal(builds, 1);
    assert.equal(validBundleDirectory(cacheDirectory), true);
    assert.equal(results.filter((result) => result.cacheHit).length, 1);
    assert.equal(results.some((result) => result.waitedForLock), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('proof repeat gate tolerates only sub-pixel browser rasterization drift and records evidence', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-paper-studio.mjs'), 'utf8');
  assert.match(worker, /PROOF_REPEAT_MAX_CHANGED_RATIO = 0\.0005/);
  assert.match(worker, /PROOF_REPEAT_MAX_MEAN_DELTA = 0\.05/);
  assert.match(worker, /PROOF_REPEAT_MAX_CHANNEL_DELTA = 32/);
  assert.match(worker, /PROOF_REPEAT_SPARSE_OUTLIER_RATIO = 0\.0002/);
  assert.match(worker, /PROOF_REPEAT_SPARSE_OUTLIER_MAX_CHANNEL_DELTA = 64/);
  assert.match(worker, /sparse_outlier_tolerance_applied/);
  assert.match(worker, /repeat_comparison: repeatComparison/);
  assert.match(worker, /if \(!repeatComparison\.pass\)/);
});

test('proof service rejects a second concurrent render for the same frozen snapshot', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE paper_proof_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shot_id INTEGER NOT NULL,
    snapshot_id INTEGER NOT NULL,
    run_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.prepare("INSERT INTO paper_proof_runs (shot_id, snapshot_id, run_kind, status, created_at) VALUES (30, 16, 'motion_proof', 'running', ?)")
    .run('2026-07-27T10:02:30.000Z');
  assert.throws(
    () => renderService.assertNoActiveProofRun(db, 30, 16),
    (error) => error.code === 'PAPER_STUDIO_PROOF_ALREADY_RUNNING' && error.details.proof_run_id === 1,
  );
  assert.doesNotThrow(() => renderService.assertNoActiveProofRun(db, 30, 17));
  db.close();
});
