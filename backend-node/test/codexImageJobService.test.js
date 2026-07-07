const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const codexImageJobService = require('../src/services/codexImageJobService');

function makeDb(tmpDir) {
  const db = new Database(path.join(tmpDir, 'drama_generator.db'));
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      style TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      name TEXT,
      role TEXT,
      description TEXT,
      personality TEXT,
      appearance TEXT,
      polished_prompt TEXT,
      negative_prompt TEXT,
      image_url TEXT,
      local_path TEXT,
      extra_images TEXT,
      ref_image TEXT,
      seedance2_asset TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_id INTEGER,
      location TEXT,
      time TEXT,
      prompt TEXT,
      image_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      title TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      scene_id INTEGER,
      storyboard_number INTEGER,
      title TEXT,
      description TEXT,
      location TEXT,
      time TEXT,
      action TEXT,
      result TEXT,
      atmosphere TEXT,
      shot_type TEXT,
      image_prompt TEXT,
      polished_prompt TEXT,
      video_prompt TEXT,
      layout_description TEXT,
      image_url TEXT,
      local_path TEXT,
      first_frame_image_id INTEGER,
      last_frame_image_id INTEGER,
      last_frame_image_url TEXT,
      last_frame_local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE frame_prompts (
      id INTEGER PRIMARY KEY,
      storyboard_id INTEGER,
      frame_type TEXT,
      prompt TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY,
      storyboard_id INTEGER,
      drama_id INTEGER,
      provider TEXT,
      prompt TEXT,
      image_url TEXT,
      local_path TEXT,
      frame_type TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

test('Codex image job queues, imports, and applies a character candidate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-codex-job-'));
  const cfg = {
    database: { path: path.join(tmpDir, 'drama_generator.db') },
    storage: { local_path: path.join(tmpDir, 'storage'), base_url: 'http://localhost:5679/static' },
    style: { default_image_ratio: '16:9', default_style: 'photorealistic short drama still' },
  };
  fs.mkdirSync(cfg.storage.local_path, { recursive: true });
  const db = makeDb(tmpDir);
  db.prepare(
    `INSERT INTO dramas (id, title, style, metadata, created_at)
     VALUES (1, 'Smoke Drama', 'realistic', ?, '2026-07-06T00:00:00.000Z')`
  ).run(JSON.stringify({ aspect_ratio: '16:9' }));
  db.prepare(
    `INSERT INTO characters (id, drama_id, name, appearance)
     VALUES (7, 1, '张将军', '55岁男性军官，深蓝制服，威严沉稳')`
  ).run();

  const created = codexImageJobService.createJob(db, null, cfg, {
    entity_type: 'character',
    entity_id: 7,
    drama_id: 1,
    episode_id: 2,
  });
  assert.equal(created.ok, true);
  assert.equal(created.job.status, 'pending');
  assert.match(created.job.prompt, /张将军/);
  assert.equal(fs.existsSync(created.manifest.manifest_path), true);

  const candidateSource = path.join(tmpDir, 'candidate.png');
  fs.writeFileSync(candidateSource, Buffer.from('fake image bytes'));
  const imported = codexImageJobService.importResults(db, null, cfg, {
    results: [{ job_id: created.job.id, candidates: [{ path: candidateSource }] }],
  });
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.imported.length, 1);
  assert.equal(imported.imported[0].status, 'completed');
  assert.equal(imported.imported[0].candidates.length, 1);

  const used = codexImageJobService.useCandidate(db, null, cfg, created.job.id, {
    candidate_id: imported.imported[0].candidates[0].id,
  });
  assert.equal(used.ok, true);
  assert.match(used.local_path, /projects\/0001_20260706_Smoke_Drama\/characters\/codex_character_7_/);
  assert.equal(fs.existsSync(path.join(cfg.storage.local_path, used.local_path)), true);

  const row = db.prepare('SELECT image_url, local_path FROM characters WHERE id = 7').get();
  assert.equal(row.local_path, used.local_path);
  assert.equal(row.image_url, `/static/${used.local_path}`);
  db.close();
});

test('Codex scene job works with old scenes schema missing polished_prompt_single', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-codex-scene-job-'));
  const cfg = {
    database: { path: path.join(tmpDir, 'drama_generator.db') },
    storage: { local_path: path.join(tmpDir, 'storage'), base_url: 'http://localhost:5679/static' },
    style: { default_image_ratio: '16:9', default_style: 'photorealistic short drama still' },
  };
  fs.mkdirSync(cfg.storage.local_path, { recursive: true });
  const db = makeDb(tmpDir);
  db.prepare(
    `INSERT INTO dramas (id, title, style, metadata, created_at)
     VALUES (1, 'Space Drama', 'realistic', ?, '2026-07-06T00:00:00.000Z')`
  ).run(JSON.stringify({ aspect_ratio: '16:9' }));
  db.prepare(
    `INSERT INTO scenes (id, drama_id, episode_id, location, time, prompt)
     VALUES (9, 1, 1, '太空', '深夜', '无垠深空背景，恒星在远处闪烁，纯太空场景')`
  ).run();

  const created = codexImageJobService.createJob(db, null, cfg, {
    entity_type: 'scene',
    entity_id: 9,
    drama_id: 1,
    episode_id: 1,
  });

  assert.equal(created.ok, true);
  assert.equal(created.job.entity_type, 'scene');
  assert.match(created.job.prompt, /太空/);
  assert.match(created.job.prompt, /无垠深空/);
  db.close();
});

test('Codex storyboard last-frame candidate creates image_generation and binds tail frame', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-codex-storyboard-job-'));
  const cfg = {
    database: { path: path.join(tmpDir, 'drama_generator.db') },
    storage: { local_path: path.join(tmpDir, 'storage'), base_url: 'http://localhost:5679/static' },
    style: { default_image_ratio: '16:9', default_style: 'photorealistic short drama still' },
  };
  fs.mkdirSync(cfg.storage.local_path, { recursive: true });
  const db = makeDb(tmpDir);
  db.prepare(
    `INSERT INTO dramas (id, title, style, metadata, created_at)
     VALUES (1, 'Frame Drama', 'realistic', ?, '2026-07-06T00:00:00.000Z')`
  ).run(JSON.stringify({ aspect_ratio: '16:9' }));
  db.prepare('INSERT INTO episodes (id, drama_id, title) VALUES (2, 1, ?)').run('第一集');
  db.prepare(
    `INSERT INTO storyboards (id, episode_id, storyboard_number, title, action, result, image_prompt)
     VALUES (9, 2, 3, '水滴穿舰', '水滴从舰队中心高速穿过', '战舰残骸在太空中散开', '太空舰队被水滴击穿的电影静帧')`
  ).run();
  db.prepare(
    `INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, created_at, updated_at)
     VALUES (9, 'last', '尾帧：战舰残骸在太空中散开，红色熔融边缘发光', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`
  ).run();

  const created = codexImageJobService.createJob(db, null, cfg, {
    entity_type: 'storyboard',
    entity_id: 9,
    frame_type: 'last',
  });
  assert.equal(created.ok, true);
  assert.equal(created.job.frame_type, 'last');
  assert.match(created.job.prompt, /尾帧/);

  const candidateSource = path.join(tmpDir, 'storyboard-last.png');
  fs.writeFileSync(candidateSource, Buffer.from('fake storyboard image bytes'));
  const imported = codexImageJobService.importResults(db, null, cfg, {
    results: [{ job_id: created.job.id, candidates: [{ path: candidateSource }] }],
  });
  assert.equal(imported.errors.length, 0);

  const used = codexImageJobService.useCandidate(db, null, cfg, created.job.id, {
    candidate_id: imported.imported[0].candidates[0].id,
  });
  assert.equal(used.ok, true);
  assert.match(used.local_path, /projects\/0001_20260706_Frame_Drama\/storyboards\/codex_storyboard_9_/);
  assert.equal(fs.existsSync(path.join(cfg.storage.local_path, used.local_path)), true);
  assert.ok(used.image_generation_id);

  const imageRow = db.prepare('SELECT storyboard_id, frame_type, local_path, status FROM image_generations WHERE id = ?').get(used.image_generation_id);
  assert.equal(imageRow.storyboard_id, 9);
  assert.equal(imageRow.frame_type, 'storyboard_last');
  assert.equal(imageRow.status, 'completed');
  assert.equal(imageRow.local_path, used.local_path);

  const sbRow = db.prepare('SELECT last_frame_image_id, last_frame_image_url, last_frame_local_path FROM storyboards WHERE id = 9').get();
  assert.equal(sbRow.last_frame_image_id, used.image_generation_id);
  assert.equal(sbRow.last_frame_local_path, used.local_path);
  assert.equal(sbRow.last_frame_image_url, `/static/${used.local_path}`);
  db.close();
});
