const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const compiler = require('../src/services/promptCompiler');
const styleVersions = require('../src/services/visualStyleVersionService');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT, prompt TEXT,
      polished_prompt TEXT, polished_prompt_style_signature TEXT, polished_prompt_single TEXT,
      polished_prompt_single_style_signature TEXT, polished_prompt_nine TEXT, polished_prompt_nine_style_signature TEXT,
      prompt_state TEXT, negative_prompt TEXT, image_url TEXT, local_path TEXT, reference_grid_image_url TEXT,
      reference_grid_local_path TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER, title TEXT,
      description TEXT, location TEXT, time TEXT, action TEXT, dialogue TEXT, narration TEXT, result TEXT,
      atmosphere TEXT, characters TEXT, shot_type TEXT, angle TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT,
      movement TEXT, layout_description TEXT, image_prompt TEXT, polished_prompt TEXT, polished_prompt_style_signature TEXT,
      prompt_state TEXT, continuity_snapshot TEXT, deleted_at TEXT
    );
    CREATE TABLE frame_prompts (storyboard_id INTEGER, frame_type TEXT, prompt TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, local_path TEXT, ref_image TEXT, extra_images TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE storyboard_characters (storyboard_id INTEGER, character_id INTEGER);
    CREATE TABLE image_generations (id INTEGER PRIMARY KEY, storyboard_id INTEGER, character_id INTEGER, local_path TEXT, image_url TEXT, frame_type TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE prompt_styles (id INTEGER PRIMARY KEY, name TEXT, content TEXT, enabled INTEGER, sort_order INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE prompt_style_tags (id INTEGER PRIMARY KEY, style_id INTEGER, tag TEXT, created_at TEXT);
  `);
  return db;
}

test('compiler rejects stale polished prompt and incompatible medium module while carrying shared references', () => {
  const db = makeDb();
  db.prepare('INSERT INTO dramas VALUES (1, \'战争\', \'legacy\', ?, NULL)').run(JSON.stringify({
    style_prompt_en: 'cinematic hand-painted impasto Bronze Age concept art',
    visual_bible: 'dark gold bronze palette, torchlight, rough linen and aged bronze',
    style_medium: 'impasto', storyboard_prompt_style_ids: [1],
  }));
  db.prepare('INSERT INTO episodes VALUES (7, 1, NULL)').run();
  db.prepare('INSERT INTO scenes VALUES (46, 1, 7, \'城门\', \'夜\', \'城门前火把与尘土\', NULL, NULL, NULL, NULL, NULL, NULL, \'stale_style\', \'no neon\', \'/static/scene.png\', \'projects/scene.png\', \'/static/grid.png\', \'projects/grid.png\', NULL)').run();
  db.prepare('INSERT INTO storyboards VALUES (165, 7, 46, 1, \'冲锋\', \'旧内容\', \'城门\', \'夜\', \'士兵冲锋\', NULL, NULL, \'战旗倒下\', \'紧张\', ?, \'wide\', NULL, NULL, NULL, NULL, NULL, \'保持左右站位\', \'原始分镜内容\', \'OLD INK WASH POLISHED\', \'old-signature\', \'stale_style\', NULL, NULL)').run(JSON.stringify([{ id: 10, name: '将军' }]));
  db.prepare('INSERT INTO characters VALUES (10, 1, \'将军\', \'/static/char.png\', \'projects/char.png\', NULL)').run();
  db.prepare('INSERT INTO props VALUES (20, \'战旗\', \'/static/prop.png\', \'projects/prop.png\', NULL, NULL, NULL)').run();
  db.prepare('INSERT INTO storyboard_props VALUES (165, 20)').run();
  db.prepare('INSERT INTO prompt_styles VALUES (1, \'水墨模块\', \'pure Chinese ink wash monochrome\', 1, 1, NULL, NULL, NULL)').run();

  const result = compiler.compile(db, { style: { default_image_ratio: '16:9' } }, { entity_type: 'storyboard', entity_id: 165 });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.prompt, /OLD INK WASH POLISHED/);
  assert.match(result.prompt, /cinematic hand-painted impasto/);
  assert.match(result.prompt, /原始分镜内容/);
  assert.match(result.prompt, /城门前火把与尘土/);
  assert.doesNotMatch(result.prompt, /OLD INK WASH POLISHED/);
  assert.doesNotMatch(result.prompt, /pure Chinese ink wash monochrome/);
  assert.ok(result.diagnostics.some((item) => item.code === 'STALE_POLISHED_PROMPT'));
  assert.ok(result.diagnostics.some((item) => item.code === 'MEDIUM_CONFLICT'));
  assert.deepEqual(result.reference_images.slice(0, 4), ['projects/scene.png', 'projects/grid.png', 'projects/char.png', 'projects/prop.png']);
  db.close();
});

test('manual storyboard override is retained as content under the active style lock', () => {
  const db = makeDb();
  db.prepare('INSERT INTO dramas VALUES (1, \'D\', \'legacy\', ?, NULL)').run(JSON.stringify({ style_prompt_en: 'cinematic realism', visual_bible: 'natural light' }));
  db.prepare('INSERT INTO episodes VALUES (7, 1, NULL)').run();
  db.prepare('INSERT INTO scenes VALUES (46, 1, 7, \'室内\', \'夜\', \'房间\', NULL, NULL, NULL, NULL, NULL, NULL, \'current\', NULL, NULL, NULL, NULL, NULL, NULL)').run();
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, scene_id, storyboard_number, title, location, time, layout_description,
     image_prompt, polished_prompt, polished_prompt_style_signature, prompt_state, continuity_snapshot)
    VALUES (165, 7, 46, 1, '手动镜头', '室内', '夜', '手动重写画面',
            'MANUAL STYLE WORDS', 'MANUAL STYLE WORDS', 'old', 'manual_override', NULL)`).run();
  const result = compiler.compile(db, {}, { entity_type: 'storyboard', entity_id: 165 });
  assert.equal(result.ok, true);
  assert.match(result.prompt, /MANUAL STYLE WORDS/);
  assert.match(result.prompt, /cinematic realism/);
  assert.ok(result.diagnostics.some((item) => item.code === 'MANUAL_CONTENT_OVERRIDE'));
  db.close();
});

test('negative medium clauses are not treated as active visual media', () => {
  assert.deepEqual(compiler.mediumTokens('impasto; Negative: no ink wash, no CGI, no anime'), ['impasto']);
  assert.deepEqual(compiler.mediumTokens('禁止水墨，禁止塑料 CGI；厚涂油画'), ['impasto']);
  assert.equal(compiler.mediumConflict(['impasto'], compiler.mediumTokens('no CGI, no ink wash')), false);
});

test('legacy mixed scene and storyboard prompts are reduced to factual content', () => {
  const scene = compiler.stripLegacyStyleLanguage(
    '国潮史诗厚涂，手绘原画质感。场景：青铜宫殿、火把、酒池、远山水墨意境。色彩光影：朱砂红、墨黑。traditional Chinese ink wash painting, sumi-e style, guohua style',
    { scene: true }
  );
  assert.match(scene, /青铜宫殿/);
  assert.doesNotMatch(scene, /厚涂|水墨|ink wash|朱砂红/);

  const storyboard = compiler.storyboardContentText({
    storyboard_number: 1,
    title: '镜头',
    description: '城门前的火把',
    action: '士兵举旗',
    image_prompt: '城门，traditional Chinese ink wash painting, sumi-e style, guohua style，国潮史诗厚涂',
  }, 'main');
  assert.match(storyboard, /士兵举旗/);
  assert.doesNotMatch(storyboard, /ink wash|水墨|厚涂/);
});
