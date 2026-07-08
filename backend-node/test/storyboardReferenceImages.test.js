const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageService = require('../src/services/imageService');
const { buildUniversalSegmentUserPromptBundle } = require('../src/services/universalSegmentPromptBundle');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      storyboard_number INTEGER,
      scene_id INTEGER,
      title TEXT,
      description TEXT,
      location TEXT,
      time TEXT,
      action TEXT,
      dialogue TEXT,
      narration TEXT,
      result TEXT,
      atmosphere TEXT,
      image_prompt TEXT,
      polished_prompt TEXT,
      video_prompt TEXT,
      universal_segment_text TEXT,
      shot_type TEXT,
      angle TEXT,
      angle_h TEXT,
      angle_v TEXT,
      angle_s TEXT,
      movement TEXT,
      lighting_style TEXT,
      depth_of_field TEXT,
      characters TEXT,
      image_url TEXT,
      local_path TEXT,
      composed_image TEXT,
      first_frame_image_id INTEGER,
      duration REAL,
      segment_index INTEGER,
      segment_title TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY,
      storyboard_id INTEGER,
      drama_id INTEGER,
      provider TEXT,
      prompt TEXT,
      quality TEXT,
      image_url TEXT,
      local_path TEXT,
      frame_type TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      title TEXT,
      script_content TEXT,
      deleted_at TEXT
    );
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      genre TEXT,
      style TEXT,
      metadata TEXT,
      deleted_at TEXT
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY,
      location TEXT,
      time TEXT,
      prompt TEXT,
      image_url TEXT,
      local_path TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_props (
      storyboard_id INTEGER,
      prop_id INTEGER
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY,
      name TEXT,
      image_url TEXT,
      local_path TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (
      storyboard_id INTEGER,
      character_id INTEGER,
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY,
      name TEXT,
      image_url TEXT,
      local_path TEXT,
      deleted_at TEXT
    );
    CREATE TABLE character_libraries (
      id INTEGER PRIMARY KEY,
      name TEXT,
      image_url TEXT,
      local_path TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

function insertMainStoryboardImages(db, storyboardId, count) {
  for (let i = 1; i <= count; i++) {
    db.prepare(
      `INSERT INTO image_generations
       (id, storyboard_id, drama_id, provider, prompt, image_url, local_path, frame_type, status, created_at, updated_at)
       VALUES (?, ?, 1, 'test', ?, ?, ?, NULL, 'completed', ?, ?)`
    ).run(
      100 + i,
      storyboardId,
      `图${i}`,
      `/static/storyboards/${storyboardId}_${i}.png`,
      `projects/demo/storyboards/${storyboardId}_${i}.png`,
      `2026-07-08T00:00:0${i}.000Z`,
      `2026-07-08T00:00:0${i}.000Z`
    );
  }
}

test('imageService rejects creating or uploading the 7th storyboard reference image', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO storyboards (id, episode_id, storyboard_number, title, image_url, local_path, first_frame_image_id)
     VALUES (1, 1, 1, '战鼓初响', '/static/storyboards/1_6.png', 'projects/demo/storyboards/1_6.png', 106)`
  ).run();
  insertMainStoryboardImages(db, 1, 6);

  assert.throws(
    () => imageService.create(db, { info() {}, warn() {}, error() {} }, {
      storyboard_id: 1,
      drama_id: 1,
      prompt: '新图',
    }),
    /最多保留 6 张参考图/
  );

  assert.throws(
    () => imageService.upload(db, { info() {}, warn() {}, error() {} }, {
      storyboard_id: 1,
      drama_id: 1,
      image_url: '/static/storyboards/new.png',
      local_path: 'projects/demo/storyboards/new.png',
    }),
    /最多保留 6 张参考图/
  );

  db.close();
});

test('universal segment bundle appends up to 6 storyboard reference slots after scene slot', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO dramas (id, title, genre, style, metadata)
     VALUES (1, '测试剧', '战争', 'cinematic', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO episodes (id, drama_id, title, script_content)
     VALUES (11, 1, '第1集', '战鼓响起，士兵冲锋。')`
  ).run();
  db.prepare(
    `INSERT INTO scenes (id, location, time, prompt, image_url, local_path)
     VALUES (21, '战场', '夜', '火光中的古战场', '/static/scenes/battlefield.png', 'projects/demo/scenes/battlefield.png')`
  ).run();
  db.prepare(
    `INSERT INTO storyboards
     (id, episode_id, storyboard_number, scene_id, title, action, image_prompt, video_prompt, image_url, local_path, first_frame_image_id)
     VALUES (31, 11, 5, 21, '冲锋', '士兵冲向鼓阵', '电影静帧', '鼓声压住呼喊，镜头推进', '/static/storyboards/31_3.png', 'projects/demo/storyboards/31_3.png', 103)`
  ).run();
  insertMainStoryboardImages(db, 31, 7);

  const bundle = buildUniversalSegmentUserPromptBundle(db, 31, {}, {});
  assert.equal(bundle.ok, true);
  assert.match(bundle.userPrompt, /@图片1 = 场景「战场」/);
  const storyboardSlotMatches = bundle.userPrompt.match(/= 分镜图「/g) || [];
  assert.equal(storyboardSlotMatches.length, 6);
  assert.match(bundle.userPrompt, /@图片7 = 分镜图「/);
  assert.doesNotMatch(bundle.userPrompt, /@图片8 = 分镜图「/);

  db.close();
});
