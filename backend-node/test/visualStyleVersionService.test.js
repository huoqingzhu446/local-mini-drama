const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const service = require('../src/services/visualStyleVersionService');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT,
      active_visual_style_version_id INTEGER, active_visual_style_signature TEXT,
      updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, prompt_state TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, prompt_state TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE codex_image_jobs (
      id TEXT PRIMARY KEY, drama_id INTEGER, status TEXT, error_msg TEXT,
      stale_reason TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE prompt_styles (
      id INTEGER PRIMARY KEY, name TEXT, content TEXT, enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE prompt_style_tags (id INTEGER PRIMARY KEY, style_id INTEGER, tag TEXT, created_at TEXT);
  `);
  return db;
}

test('visual style versions snapshot module content and activation invalidates project prompts/jobs', () => {
  const db = makeDb();
  db.prepare('INSERT INTO dramas (id, title, style, metadata) VALUES (1, ?, ?, ?)').run(
    '历史的战争', 'legacy', JSON.stringify({
      style_prompt_en: 'cinematic impasto bronze concept art',
      visual_bible: 'dark gold, bronze, torchlight',
      storyboard_prompt_style_ids: [1],
    })
  );
  db.prepare('INSERT INTO episodes (id, drama_id) VALUES (7, 1)').run();
  db.prepare('INSERT INTO scenes (id, drama_id, prompt_state) VALUES (46, 1, \'current\')').run();
  db.prepare('INSERT INTO storyboards (id, episode_id, prompt_state) VALUES (165, 7, \'current\')').run();
  db.prepare('INSERT INTO codex_image_jobs (id, drama_id, status) VALUES (\'old\', 1, \'pending\')').run();
  db.prepare('INSERT INTO prompt_styles (id, name, content, enabled, updated_at) VALUES (1, \'世界氛围\', \'dusty bronze atmosphere\', 1, \'a\')').run();

  const active = service.ensureActiveVersion(db, 1);
  assert.equal(active.status, 'active');
  assert.equal(active.prompt_modules[0].content, 'dusty bronze atmosphere');
  const draft = service.createDraft(db, 1, { style_prompt_en: 'cinematic ink wash art' });
  assert.notEqual(draft.signature, active.signature);
  const updated = service.updateDraft(db, 1, draft.id, { visual_bible: null });
  assert.equal(updated.visual_bible, '');

  const activated = service.activateVersion(db, null, 1, draft.id);
  assert.equal(activated.status, 'active');
  assert.equal(db.prepare('SELECT prompt_state FROM scenes WHERE id = 46').get().prompt_state, 'stale_style');
  assert.equal(db.prepare('SELECT prompt_state FROM storyboards WHERE id = 165').get().prompt_state, 'stale_style');
  const job = db.prepare('SELECT status, stale_reason FROM codex_image_jobs WHERE id = \'old\'').get();
  assert.equal(job.status, 'cancelled');
  assert.match(job.stale_reason, /重新编译/);
  db.close();
});

test('style module content changes the version signature even when ids stay the same', () => {
  const db = makeDb();
  db.prepare('INSERT INTO dramas (id, title, metadata) VALUES (1, \'D\', ?)').run(JSON.stringify({ storyboard_prompt_style_ids: [1] }));
  db.prepare('INSERT INTO prompt_styles (id, name, content, enabled, updated_at) VALUES (1, \'M\', \'first\', 1, \'a\')').run();
  const first = service.ensureActiveVersion(db, 1);
  db.prepare('UPDATE prompt_styles SET content = \'second\', updated_at = \'b\' WHERE id = 1').run();
  const draft = service.createDraft(db, 1, {});
  assert.notEqual(first.signature, draft.signature);
  db.close();
});
