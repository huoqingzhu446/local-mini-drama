const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const express = require('express');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const schemaService = require('../src/services/paper-studio/paperStudioSchemaService');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const doctorService = require('../src/services/paper-studio/paperStudioDoctorService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function makeMigratedDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function seedDrama(db) {
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare(
    `INSERT INTO dramas
      (id, title, description, active_visual_style_version_id,
       active_visual_style_signature, created_at, updated_at)
     VALUES (1, '沉船断路', '四镜纸片动画测试', 7, 'style:ink-paper-v1', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO episodes
      (id, drama_id, episode_number, title, script_content, created_at, updated_at)
     VALUES (10, 1, 1, '第一集', '渡河时船体断裂', ?, ?)`,
  ).run(now, now);
  const insert = db.prepare(
    `INSERT INTO storyboards
      (id, episode_id, storyboard_number, title, description, action, duration,
       image_url, created_at, updated_at)
     VALUES (?, 10, ?, ?, ?, ?, 4, ?, ?, ?)`,
  );
  [101, 102, 103, 104].forEach((id, index) => {
    insert.run(
      id,
      index + 1,
      `分镜 ${index + 1}`,
      `沉船断路阶段 ${index + 1}`,
      ['船身受撞', '士卒失衡', '船体下沉', '水花吞没船舷'][index],
      `/static/storyboards/${id}.png`,
      now,
      now,
    );
  });
}

test('migration 31 creates the isolated v3 domain on an empty database', () => {
  const db = makeMigratedDb();
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  for (const table of doctorService.REQUIRED_TABLES) assert.equal(tables.has(table), true, table);

  const imageColumns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  const videoColumns = new Set(db.prepare('PRAGMA table_info(video_generations)').all().map((row) => row.name));
  assert.equal(imageColumns.has('paper_asset_version_id'), true);
  assert.equal(imageColumns.has('request_fingerprint'), true);
  assert.equal(videoColumns.has('paper_studio_shot_id'), true);
  assert.equal(videoColumns.has('paper_snapshot_id'), true);
  db.close();
});

test('migration self-heals a legacy database with partial shared tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE image_generations (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT);
  `);
  runMigrationsAndEnsure(db);
  const dramaColumns = new Set(db.prepare('PRAGMA table_info(dramas)').all().map((row) => row.name));
  const imageColumns = new Set(db.prepare('PRAGMA table_info(image_generations)').all().map((row) => row.name));
  assert.equal(dramaColumns.has('deleted_at'), true);
  assert.equal(imageColumns.has('generation_kind'), true);
  assert.equal(imageColumns.has('paper_asset_version_id'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'paper_studio_runs'").get().count, 1);
  db.close();
});

test('Ajv rejects duplicate shots and unsupported quality tiers', () => {
  const duplicate = schemaService.validate('apiRunCreate', {
    request_id: randomUUID(),
    project_id: 1,
    episode_id: 10,
    storyboard_ids: [101, 101],
    quality_tier: 'balanced',
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((error) => error.code === 'uniqueItems'));

  const invalidTier = schemaService.validate('apiRunCreate', {
    request_id: randomUUID(),
    project_id: 1,
    episode_id: 10,
    storyboard_ids: [101],
    quality_tier: 'camera-only',
  });
  assert.equal(invalidTier.valid, false);
  assert.ok(invalidTier.errors.some((error) => error.path === '/quality_tier'));
});

test('project CRUD uses optimistic locking and remains drama-scoped', () => {
  const db = makeMigratedDb();
  seedDrama(db);
  const created = projectService.create(db, log, 1, {
    request_id: randomUUID(),
    default_tier: 'balanced',
    config: { fps: 30, preview_scale: 0.5 },
  });
  assert.equal(created.created, true);
  assert.equal(created.project.drama_id, 1);
  assert.deepEqual(created.project.config_json, { fps: 30, preview_scale: 0.5 });

  const deduplicated = projectService.create(db, log, 1, { request_id: randomUUID() });
  assert.equal(deduplicated.deduplicated, true);
  assert.equal(deduplicated.project.id, created.project.id);

  const updated = projectService.update(db, log, created.project.id, {
    request_id: randomUUID(),
    expected_version: 1,
    default_tier: 'full-depth',
  });
  assert.equal(updated.default_tier, 'full-depth');
  assert.equal(updated.version, 2);
  assert.throws(
    () => projectService.update(db, log, created.project.id, {
      request_id: randomUUID(), expected_version: 1, default_tier: 'draft',
    }),
    (error) => error.code === 'PAPER_STUDIO_VERSION_CONFLICT' && error.status === 409,
  );
  db.close();
});

test('one episode and four storyboards create an immutable draft run idempotently', () => {
  const db = makeMigratedDb();
  seedDrama(db);
  const project = projectService.create(db, log, 1, {
    request_id: randomUUID(),
    default_tier: 'balanced',
  }).project;
  const requestId = randomUUID();
  const body = {
    request_id: requestId,
    project_id: project.id,
    episode_id: 10,
    storyboard_ids: [104, 101, 103, 102],
    quality_tier: 'balanced',
    budget: { max_images: 24, max_auto_retries_per_slot: 2 },
  };
  const result = runService.create(db, log, body);
  assert.equal(result.created, true);
  assert.equal(result.run.status, 'draft');
  assert.equal(result.run.next_action.type, 'analyze_run');
  assert.match(result.run.source_revision_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.run.selection_json.storyboard_ids, [101, 102, 103, 104]);
  assert.deepEqual(result.run.shots.map((shot) => shot.storyboard_id), [101, 102, 103, 104]);
  assert.deepEqual(result.run.shots.map((shot) => shot.shot_index), [0, 1, 2, 3]);
  assert.ok(result.run.shots.every((shot) => /^sha256:[0-9a-f]{64}$/.test(shot.source_revision_hash)));

  const duplicate = runService.create(db, log, body);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.run.id, result.run.id);
  assert.equal(runService.list(db, { project_id: project.id, episode_id: 10 }).length, 1);
  db.close();
});

test('run creation rejects storyboards outside the selected episode', () => {
  const db = makeMigratedDb();
  seedDrama(db);
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare(
    `INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at)
     VALUES (11, 1, 2, '第二集', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO storyboards
      (id, episode_id, storyboard_number, title, created_at, updated_at)
     VALUES (201, 11, 1, '其它分集', ?, ?)`,
  ).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  assert.throws(
    () => runService.create(db, log, {
      request_id: randomUUID(),
      project_id: project.id,
      episode_id: 10,
      storyboard_ids: [101, 201],
    }),
    (error) => error.code === 'PAPER_STUDIO_STORYBOARD_OWNERSHIP_MISMATCH' && error.status === 409,
  );
  db.close();
});

test('phase 0 doctor verifies migrations, schemas and writable storage', () => {
  const db = makeMigratedDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-studio-doctor-'));
  const report = doctorService.doctor(db, {
    storage: { local_path: root },
    paper_studio: { enabled: true, legacy_v2_enabled: true },
  });
  assert.equal(report.ok, true);
  assert.equal(report.phase, 1);
  assert.equal(report.checks.migrations.ok, true);
  assert.equal(report.checks.schema.ok, true);
  assert.equal(report.checks.storage.ok, true);
  assert.ok(['ready', 'runtime_incomplete'].includes(report.checks.renderer.status));
  db.close();
});

test('paper studio HTTP API creates a project and a four-shot run', async () => {
  const db = makeMigratedDb();
  seedDrama(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-studio-api-'));
  const cfg = {
    storage: { local_path: root },
    paper_studio: { enabled: true, legacy_v2_enabled: true },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter(cfg, db, log));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const projectResponse = await fetch(`${base}/paper-studio/projects/1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: randomUUID(), default_tier: 'balanced' }),
    });
    assert.equal(projectResponse.status, 201);
    const projectPayload = await projectResponse.json();
    assert.equal(projectPayload.success, true);
    const project = projectPayload.data.project;

    const runResponse = await fetch(`${base}/paper-studio/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: randomUUID(),
        project_id: project.id,
        episode_id: 10,
        storyboard_ids: [101, 102, 103, 104],
        quality_tier: 'balanced',
      }),
    });
    assert.equal(runResponse.status, 201);
    const runPayload = await runResponse.json();
    assert.equal(runPayload.data.run.shots.length, 4);
    assert.equal(runPayload.data.run.next_action.type, 'analyze_run');

    const listResponse = await fetch(`${base}/paper-studio/runs?project_id=${project.id}&episode_id=10`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.equal(listPayload.data.runs.length, 1);

    const doctorResponse = await fetch(`${base}/paper-studio/doctor`);
    const doctorPayload = await doctorResponse.json();
    assert.equal(doctorPayload.data.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
