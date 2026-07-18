const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const service = require('../src/services/referencePackService');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT,
      image_url TEXT, local_path TEXT, reference_grid_image_url TEXT, reference_grid_local_path TEXT,
      ref_image TEXT, extra_images TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, action TEXT, dialogue TEXT, narration TEXT, result TEXT,
      characters TEXT, image_url TEXT, local_path TEXT, first_frame_image_id INTEGER, deleted_at TEXT
    );
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, local_path TEXT, ref_image TEXT, extra_images TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE storyboard_characters (storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE image_generations (id INTEGER PRIMARY KEY, storyboard_id INTEGER, character_id INTEGER, local_path TEXT, image_url TEXT, frame_type TEXT, status TEXT, deleted_at TEXT);
  `);
  db.exec('ALTER TABLE props ADD COLUMN drama_id INTEGER');
  return db;
}

test('storyboard pack locks first-frame layout and keeps scene/character/prop references deduplicated', () => {
  const db = makeDb();
  db.prepare('INSERT INTO episodes VALUES (7, 4, NULL)').run();
  db.prepare('INSERT INTO scenes VALUES (46, 4, 7, \'城门\', \'夜\', \'/static/scene.png\', \'projects/scene.png\', \'/static/grid.png\', \'projects/grid.png\', NULL, NULL, NULL)').run();
  db.prepare('INSERT INTO storyboards VALUES (165, 7, 46, 1, \'冲锋\', \'士兵逼近城门\', \'冲锋\', NULL, NULL, NULL, ?, NULL, NULL, 900, NULL)').run(JSON.stringify([{ id: 10, name: '将军' }]));
  db.prepare('INSERT INTO image_generations VALUES (900, 165, NULL, \'projects/first.png\', \'/static/first.png\', \'storyboard_first\', \'completed\', NULL)').run();
  db.prepare('INSERT INTO characters VALUES (10, 4, \'将军\', \'/static/char.png\', \'projects/char.png\', NULL)').run();
  db.prepare('INSERT INTO props (id, name, image_url, local_path, drama_id) VALUES (20, \'战旗\', \'/static/prop.png\', \'projects/prop.png\', 4)').run();
  db.prepare('INSERT INTO storyboard_props VALUES (165, 20)').run();

  const pack = service.buildReferencePack(db, {
    entity_type: 'storyboard', entity_id: 165, frame_type: 'last',
    limits: { total: 4, maxCharacters: 2, maxObjects: 3 },
  });
  assert.equal(pack.references[0].role, 'first_frame_layout_lock');
  assert.equal(pack.references[0].value, 'projects/first.png');
  assert.deepEqual(pack.reference_images, ['projects/first.png', 'projects/scene.png', 'projects/grid.png', 'projects/char.png']);
  assert.equal(new Set(pack.reference_images).size, pack.reference_images.length);

  db.prepare('UPDATE storyboards SET characters = \'[]\' WHERE id = 165').run();
  const empty = service.buildReferencePack(db, { entity_type: 'storyboard', entity_id: 165, frame_type: 'main', limits: { total: 8 } });
  assert.doesNotMatch(JSON.stringify(empty.references), /char\.png/);
  db.close();
});

test('scene reference-grid pack uses the current scene main image only', () => {
  const db = makeDb();
  db.prepare('INSERT INTO scenes VALUES (46, 4, 7, \'城门\', \'夜\', \'/static/scene.png\', \'projects/scene.png\', NULL, NULL, NULL, NULL, NULL)').run();
  const pack = service.buildReferencePack(db, { entity_type: 'scene', entity_id: 46, frame_type: 'reference_grid' });
  assert.deepEqual(pack.reference_images, ['projects/scene.png']);
  assert.equal(pack.references[0].role, 'scene_main');
  db.close();
});

test('V2 projects skip legacy generated references unless explicitly allowed', () => {
  const db = makeDb();
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT,
      active_visual_style_version_id INTEGER, active_visual_style_signature TEXT,
      deleted_at TEXT
    );
    CREATE TABLE drama_visual_style_versions (
      id INTEGER PRIMARY KEY, drama_id INTEGER, version INTEGER, status TEXT,
      name TEXT, style_prompt_zh TEXT, style_prompt_en TEXT, visual_bible TEXT,
      visual_bible_struct TEXT, scope_overrides TEXT, prompt_style_ids TEXT,
      style_family TEXT, medium TEXT, signature TEXT, compiler_version TEXT,
      source TEXT, created_at TEXT, activated_at TEXT, superseded_at TEXT
    );
  `);
  db.prepare('INSERT INTO dramas VALUES (4, ?, ?, ?, 5, ?, NULL)').run(
    '战争', '旧风格', JSON.stringify({ style_version: 5 }), 'sig-v5'
  );
  db.prepare(`INSERT INTO drama_visual_style_versions
    (id, drama_id, version, status, name, style_prompt_en, signature, compiler_version, created_at)
    VALUES (5, 4, 5, 'active', 'v5', 'impasto', 'sig-v5', 'v2', 'now')`).run();
  db.prepare('INSERT INTO episodes VALUES (7, 4, NULL)').run();
  db.prepare('INSERT INTO scenes VALUES (46, 4, 7, \'城门\', \'夜\', \'/static/scene.png\', \'projects/scene.png\', NULL, NULL, NULL, NULL, NULL)').run();
  db.prepare('INSERT INTO storyboards VALUES (165, 7, 46, 1, \'冲锋\', \'士兵\', \'冲锋\', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)').run(JSON.stringify([{ id: 10, name: '将军' }]));
  db.prepare('INSERT INTO characters VALUES (10, 4, \'将军\', \'/static/char.png\', \'projects/char.png\', NULL)').run();
  db.prepare('INSERT INTO props (id, name, image_url, local_path, drama_id) VALUES (20, \'战旗\', \'/static/prop.png\', \'projects/prop.png\', 4)').run();
  db.prepare('INSERT INTO storyboard_props VALUES (165, 20)').run();
  db.prepare('INSERT INTO storyboard_characters VALUES (165, 10)').run();

  const filtered = service.buildReferencePack(db, { entity_type: 'storyboard', entity_id: 165, frame_type: 'main' });
  assert.equal(filtered.reference_images.length, 0);
  assert.equal(filtered.diagnostics.filter((item) => item.code === 'STALE_REFERENCE').length, 3);

  const allowed = service.buildReferencePack(db, { entity_type: 'storyboard', entity_id: 165, frame_type: 'main', allow_stale_references: true });
  assert.deepEqual(allowed.reference_images, ['projects/scene.png', 'projects/char.png', 'projects/prop.png']);
  db.close();
});
