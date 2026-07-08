const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const dramaService = require('../src/services/dramaService');

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      video_url TEXT,
      thumbnail TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      composed_image TEXT,
      main_panel_idx INTEGER,
      video_url TEXT,
      audio_local_path TEXT,
      narration_audio_local_path TEXT,
      first_frame_image_id INTEGER,
      last_frame_image_id INTEGER,
      last_frame_image_url TEXT,
      last_frame_local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      four_view_image_url TEXT,
      extra_images TEXT,
      ref_image TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      extra_images TEXT,
      ref_image TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      extra_images TEXT,
      ref_image TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_id INTEGER,
      storyboard_id INTEGER,
      scene_id INTEGER,
      character_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      storyboard_id INTEGER,
      image_url TEXT,
      first_frame_url TEXT,
      last_frame_url TEXT,
      reference_image_urls TEXT,
      video_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_merges (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      merged_url TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE codex_image_jobs (
      id TEXT PRIMARY KEY,
      drama_id INTEGER,
      candidates TEXT,
      selected_candidate_id TEXT,
      applied_image_url TEXT,
      applied_local_path TEXT,
      manifest_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE character_libraries (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      four_view_image_url TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE scene_libraries (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE prop_libraries (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

test('deleteDrama optionally removes generated project media and storage directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-delete-drama-'));
  const db = createDb(path.join(tmpDir, 'drama_generator.db'));
  const storageRoot = path.join(tmpDir, 'storage');
  const cfg = { storage: { local_path: storageRoot } };
  const createdAt = '2026-07-08T02:46:43.333Z';
  const projectSubdir = 'projects/0003_20260708_100场战争';
  const writeMedia = (relPath) => {
    const absPath = path.join(storageRoot, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'media');
  };

  db.prepare(
    `INSERT INTO dramas (id, title, metadata, created_at, updated_at)
     VALUES (3, '100场战争', ?, ?, ?)`
  ).run(JSON.stringify({ storage_folder_label: '100场战争' }), createdAt, createdAt);
  db.prepare(
    `INSERT INTO episodes (id, drama_id, video_url, thumbnail, updated_at)
     VALUES (11, 3, '/static/${projectSubdir}/videos/episode.mp4', '/static/${projectSubdir}/thumbs/episode.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO storyboards (id, episode_id, image_url, local_path, video_url, audio_local_path, narration_audio_local_path, first_frame_image_id, last_frame_image_id, last_frame_image_url, last_frame_local_path, updated_at)
     VALUES (21, 11, '/static/${projectSubdir}/storyboards/main.png', '${projectSubdir}/storyboards/main.png', '/static/${projectSubdir}/videos/storyboard.mp4', '${projectSubdir}/audio/a.mp3', '${projectSubdir}/audio/n.mp3', 301, 302, '/static/${projectSubdir}/storyboards/last.png', '${projectSubdir}/storyboards/last.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO characters (id, drama_id, image_url, local_path, four_view_image_url, extra_images, updated_at)
     VALUES (31, 3, '/static/${projectSubdir}/characters/main.png', '${projectSubdir}/characters/main.png', '/static/${projectSubdir}/characters/four.png', ?, ?)`
  ).run(JSON.stringify([`${projectSubdir}/characters/extra.png`]), createdAt);
  db.prepare(
    `INSERT INTO scenes (id, drama_id, image_url, local_path, extra_images, updated_at)
     VALUES (41, 3, '/static/${projectSubdir}/scenes/main.png', '${projectSubdir}/scenes/main.png', ?, ?)`
  ).run(JSON.stringify([`${projectSubdir}/scenes/extra.png`]), createdAt);
  db.prepare(
    `INSERT INTO props (id, drama_id, image_url, local_path, extra_images, updated_at)
     VALUES (51, 3, '/static/${projectSubdir}/props/main.png', '${projectSubdir}/props/main.png', ?, ?)`
  ).run(JSON.stringify([`${projectSubdir}/props/extra.png`]), createdAt);
  db.prepare(
    `INSERT INTO image_generations (id, drama_id, episode_id, storyboard_id, scene_id, character_id, image_url, local_path, updated_at)
     VALUES (301, 3, 11, 21, 41, 31, '/static/${projectSubdir}/images/gen.png', '${projectSubdir}/images/gen.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO video_generations (id, drama_id, storyboard_id, image_url, first_frame_url, last_frame_url, reference_image_urls, video_url, local_path, updated_at)
     VALUES (401, 3, 21, '/static/${projectSubdir}/images/poster.png', '/static/${projectSubdir}/storyboards/main.png', '/static/${projectSubdir}/storyboards/last.png', '[]', '/static/${projectSubdir}/videos/gen.mp4', '${projectSubdir}/videos/gen.mp4', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO video_merges (id, drama_id, merged_url, updated_at)
     VALUES (501, 3, '/static/${projectSubdir}/videos/merged.mp4', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO assets (id, drama_id, url, local_path, updated_at)
     VALUES (601, 3, '/static/${projectSubdir}/images/asset.png', '${projectSubdir}/images/asset.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO codex_image_jobs (id, drama_id, candidates, selected_candidate_id, applied_image_url, applied_local_path, manifest_path, updated_at)
     VALUES ('job-1', 3, '[]', 'cand-1', '/static/${projectSubdir}/codex-candidates/characters/cand.png', '${projectSubdir}/codex-candidates/characters/cand.png', '${projectSubdir}/codex-image-jobs/jobs.json', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO character_libraries (id, drama_id, image_url, local_path, four_view_image_url, updated_at)
     VALUES (701, 3, '/static/${projectSubdir}/characters/library.png', '${projectSubdir}/characters/library.png', '/static/${projectSubdir}/characters/library-four.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO scene_libraries (id, drama_id, image_url, local_path, updated_at)
     VALUES (801, 3, '/static/${projectSubdir}/scenes/library.png', '${projectSubdir}/scenes/library.png', ?)`
  ).run(createdAt);
  db.prepare(
    `INSERT INTO prop_libraries (id, drama_id, image_url, local_path, updated_at)
     VALUES (901, 3, '/static/${projectSubdir}/props/library.png', '${projectSubdir}/props/library.png', ?)`
  ).run(createdAt);

  writeMedia(`${projectSubdir}/storyboards/main.png`);
  writeMedia(`${projectSubdir}/storyboards/last.png`);
  writeMedia(`${projectSubdir}/characters/main.png`);
  writeMedia(`${projectSubdir}/characters/extra.png`);
  writeMedia(`${projectSubdir}/scenes/main.png`);
  writeMedia(`${projectSubdir}/props/main.png`);
  writeMedia(`${projectSubdir}/videos/gen.mp4`);
  writeMedia(`${projectSubdir}/codex-candidates/characters/cand.png`);

  const result = dramaService.deleteDrama(db, { info() {}, warn() {} }, cfg, 3, {
    delete_generated_media: true,
  });

  assert.equal(result.deleted_generated_media, true);
  assert.equal(result.media_cleanup.project_directory_removed, true);
  assert.equal(fs.existsSync(path.join(storageRoot, projectSubdir)), false);

  const dramaRow = db.prepare('SELECT deleted_at FROM dramas WHERE id = 3').get();
  assert.ok(dramaRow.deleted_at);

  const storyboardRow = db.prepare(
    'SELECT image_url, local_path, video_url, audio_local_path, narration_audio_local_path, first_frame_image_id, last_frame_image_id FROM storyboards WHERE id = 21'
  ).get();
  assert.equal(storyboardRow.image_url, null);
  assert.equal(storyboardRow.local_path, null);
  assert.equal(storyboardRow.video_url, null);
  assert.equal(storyboardRow.audio_local_path, null);
  assert.equal(storyboardRow.narration_audio_local_path, null);
  assert.equal(storyboardRow.first_frame_image_id, null);
  assert.equal(storyboardRow.last_frame_image_id, null);

  const imageGenRow = db.prepare(
    'SELECT local_path, image_url, deleted_at FROM image_generations WHERE id = 301'
  ).get();
  assert.equal(imageGenRow.local_path, null);
  assert.equal(imageGenRow.image_url, null);
  assert.ok(imageGenRow.deleted_at);

  const videoGenRow = db.prepare(
    'SELECT local_path, video_url, deleted_at FROM video_generations WHERE id = 401'
  ).get();
  assert.equal(videoGenRow.local_path, null);
  assert.equal(videoGenRow.video_url, null);
  assert.ok(videoGenRow.deleted_at);

  const assetRow = db.prepare('SELECT url, local_path, deleted_at FROM assets WHERE id = 601').get();
  assert.equal(assetRow.url, null);
  assert.equal(assetRow.local_path, null);
  assert.ok(assetRow.deleted_at);

  const jobRow = db.prepare(
    'SELECT applied_local_path, manifest_path, deleted_at FROM codex_image_jobs WHERE id = ?'
  ).get('job-1');
  assert.equal(jobRow.applied_local_path, null);
  assert.equal(jobRow.manifest_path, null);
  assert.ok(jobRow.deleted_at);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
