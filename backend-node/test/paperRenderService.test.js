const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const paperRenderService = require('../src/services/paperRenderService');
const videoService = require('../src/services/videoService');

test('proof-only render opts into provisional timing while formal render does not', () => {
  assert.deepEqual(paperRenderService.compileOptionsForRender({ proofOnly: true }), { allowProvisional: true });
  assert.deepEqual(paperRenderService.compileOptionsForRender({ proofOnly: false, preview: false }), { allowProvisional: false });
});
const { PAPER_PROOF_KINDS, sha256File } = require('../src/services/paperUtils');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, metadata TEXT, deleted_at TEXT, updated_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, video_url TEXT, local_path TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE paper_compositions (
      id INTEGER PRIMARY KEY, drama_id INTEGER, storyboard_id INTEGER, status TEXT,
      last_proof_hash TEXT, renderer_version TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE paper_render_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, composition_id INTEGER, render_hash TEXT,
      proof_kind TEXT, frame INTEGER, local_path TEXT, image_hash TEXT,
      diagnostics_json TEXT, status TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(composition_id, render_hash, proof_kind)
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY, drama_id INTEGER, storyboard_id INTEGER,
      provider TEXT, prompt TEXT, model TEXT, duration REAL, aspect_ratio TEXT,
      resolution TEXT, status TEXT, task_id TEXT, generation_kind TEXT,
      paper_composition_id INTEGER, render_snapshot TEXT, render_hash TEXT,
      renderer_version TEXT, video_url TEXT, local_path TEXT, completed_at TEXT,
      updated_at TEXT, deleted_at TEXT, error_msg TEXT
    );
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER, message TEXT,
      error TEXT, result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT,
      completed_at TEXT, deleted_at TEXT
    );
  `);
  db.prepare('INSERT INTO dramas (id, title, created_at, metadata) VALUES (1, ?, ?, ?)')
    .run('Render Test', '2026-07-21T00:00:00.000Z', '{}');
  db.prepare('INSERT INTO storyboards (id) VALUES (10)').run();
  db.prepare('INSERT INTO paper_compositions (id, drama_id, storyboard_id, status) VALUES (1, 1, 10, ?)').run('rendering');
  return db;
}

function makeManifest(root, frames = { first: 0, anticipation: 9, peak: 50, settle: 74, final_minus_hold: 89, exact_final: 119 }) {
  const proofs = {};
  for (const kind of PAPER_PROOF_KINDS) {
    const file = path.join(root, `${kind}.png`);
    fs.writeFileSync(file, Buffer.from(`proof-${kind}`));
    proofs[kind] = {
      frame: frames[kind],
      path: file,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    };
  }
  return {
    deterministic_proofs: true,
    snapshot: { proof_frames: frames },
    proofs,
    video: null,
  };
}

test('publishProofs is idempotent and manifest proof frames are checked', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-proof-'));
  const cfg = { storage: { local_path: path.join(tmp, 'storage') } };
  fs.mkdirSync(cfg.storage.local_path, { recursive: true });
  const db = makeDb();
  const manifest = makeManifest(tmp);
  const originalCopy = fs.copyFileSync;
  let copyCount = 0;
  fs.copyFileSync = (...args) => {
    copyCount += 1;
    return originalCopy(...args);
  };
  try {
    const first = paperRenderService.publishProofs(db, 1, 'sha256:test-render', manifest, cfg);
    const rowsAfterFirst = db.prepare('SELECT * FROM paper_render_proofs ORDER BY proof_kind').all();
    const second = paperRenderService.publishProofs(db, 1, 'sha256:test-render', manifest, cfg);
    const rowsAfterSecond = db.prepare('SELECT * FROM paper_render_proofs ORDER BY proof_kind').all();
    assert.equal(copyCount, PAPER_PROOF_KINDS.length);
    assert.equal(rowsAfterFirst.length, PAPER_PROOF_KINDS.length);
    assert.deepEqual(second, first);
    assert.deepEqual(rowsAfterSecond, rowsAfterFirst);
    assert.doesNotThrow(() => paperRenderService.assertManifestProofFrames({ proof_frames: manifest.snapshot.proof_frames }, manifest));
    assert.doesNotThrow(() => paperRenderService.assertManifestProofFrames({ proof_frames: manifest.snapshot.proof_frames }, { proofs: manifest.proofs }));
    assert.throws(
      () => paperRenderService.assertManifestProofFrames({ proof_frames: { ...manifest.snapshot.proof_frames, peak: 51 } }, manifest),
      (error) => error.code === 'PAPER_PROOF_FRAME_MISMATCH'
    );
  } finally {
    fs.copyFileSync = originalCopy;
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('formal local video finalization is atomic and idempotent', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-finalize-'));
  const cfg = { storage: { local_path: path.join(tmp, 'storage') } };
  fs.mkdirSync(cfg.storage.local_path, { recursive: true });
  const db = makeDb();
  const taskId = 'task-paper-finalize';
  const renderHash = 'sha256:render-finalize';
  const now = '2026-07-21T00:00:00.000Z';
  db.prepare(`INSERT INTO async_tasks (id, type, status, progress, resource_id, created_at, updated_at)
    VALUES (?, 'paper_render', 'processing', 90, '1', ?, ?)`).run(taskId, now, now);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, status, task_id, generation_kind, paper_composition_id, render_hash, updated_at)
    VALUES (7, 1, 10, 'processing', ?, 'paper_layered', 1, ?, ?)`).run(taskId, renderHash, now);

  const source = path.join(tmp, 'rendered.mp4');
  fs.writeFileSync(source, Buffer.from('deterministic-mp4')); // test artifact, not a real video
  const snapshot = {
    composition: { duration_frames: 120 },
    proof_frames: { first: 0, anticipation: 9, peak: 50, settle: 74, final_minus_hold: 89, exact_final: 119 },
    provenance: { render_hash: renderHash },
  };
  const proof = { proof_hash: 'sha256:proof-finalize' };
  const manifest = { video: { path: source }, snapshot: { proof_frames: snapshot.proof_frames } };
  const log = { info() {} };
  const first = await paperRenderService.finalizePaperVideo({
    db, cfg, log, compositionId: 1, videoGenerationId: 7, snapshot, manifest, proof,
  });
  assert.equal(first.idempotent, undefined);
  assert.equal(fs.existsSync(path.join(cfg.storage.local_path, first.video_rel)), true);
  const rowAfterFirst = db.prepare('SELECT * FROM video_generations WHERE id = 7').get();
  const compAfterFirst = db.prepare('SELECT * FROM paper_compositions WHERE id = 1').get();
  const storyboardAfterFirst = db.prepare('SELECT * FROM storyboards WHERE id = 10').get();
  const taskAfterFirst = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
  assert.equal(rowAfterFirst.status, 'completed');
  assert.equal(rowAfterFirst.render_hash, renderHash);
  assert.equal(compAfterFirst.status, 'rendered');
  assert.equal(compAfterFirst.last_proof_hash, proof.proof_hash);
  assert.equal(storyboardAfterFirst.local_path, first.video_rel);
  assert.equal(taskAfterFirst.status, 'completed');
  assert.equal(JSON.parse(taskAfterFirst.result).proof_hash, proof.proof_hash);

  // A retry gets a fresh temporary file but must preserve the already
  // committed artifact and DB timestamps.
  const retrySource = path.join(tmp, 'retry.mp4');
  fs.writeFileSync(retrySource, Buffer.from('retry-artifact'));
  const retry = await paperRenderService.finalizePaperVideo({
    db, cfg, log, compositionId: 1, videoGenerationId: 7, snapshot,
    manifest: { video: { path: retrySource }, snapshot: { proof_frames: snapshot.proof_frames } }, proof,
  });
  assert.equal(retry.idempotent, true);
  assert.equal(fs.existsSync(retrySource), false);
  const rowAfterRetry = db.prepare('SELECT * FROM video_generations WHERE id = 7').get();
  assert.equal(rowAfterRetry.updated_at, rowAfterFirst.updated_at);
  assert.equal(rowAfterRetry.completed_at, rowAfterFirst.completed_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 1);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('local video finalizer rolls back every DB pointer when a downstream write fails', () => {
  const db = makeDb();
  const taskId = 'task-paper-rollback';
  const now = '2026-07-21T00:00:00.000Z';
  db.prepare(`INSERT INTO async_tasks (id, type, status, progress, resource_id, created_at, updated_at)
    VALUES (?, 'paper_render', 'processing', 90, '1', ?, ?)`).run(taskId, now, now);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, status, task_id, generation_kind, paper_composition_id, render_hash, updated_at)
    VALUES (8, 1, 10, 'processing', ?, 'paper_layered', 1, 'sha256:rollback', ?)`).run(taskId, now);
  // Force the second write in the transaction to fail after the video row's
  // UPDATE statement has already run.
  db.exec('DROP TABLE storyboards');
  assert.throws(() => videoService.finalizeLocalVideoGeneration(db, { info() {} }, {
    video_generation_id: 8,
    paper_composition_id: 1,
    video_url: '/static/rollback.mp4',
    local_path: 'rollback.mp4',
    render_snapshot: { provenance: { render_hash: 'sha256:rollback' } },
    render_hash: 'sha256:rollback',
    renderer_version: 'paper-layer-v1',
    last_proof_hash: 'sha256:proof-rollback',
  }));
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = 8').get().status, 'processing');
  assert.equal(db.prepare('SELECT status FROM paper_compositions WHERE id = 1').get().status, 'rendering');
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId).status, 'failed');
  db.close();
});
