const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const codex = require('../src/services/codexImageJobService');

test('Codex paper_asset candidate only updates paper_assets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-codex-'));
  const storage = path.join(tmp, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, style TEXT, metadata TEXT, created_at TEXT, deleted_at TEXT);
    CREATE TABLE paper_assets (
      id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, scene_id INTEGER, storyboard_id INTEGER,
      asset_key TEXT, asset_type TEXT, prompt TEXT, negative_prompt TEXT, image_url TEXT, local_path TEXT,
      cutout_local_path TEXT, style_signature TEXT, status TEXT, matte_quality TEXT, asset_hash TEXT, version INTEGER DEFAULT 1, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, image_url TEXT, local_path TEXT, extra_images TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
  `);
  db.prepare('INSERT INTO dramas (id, title, metadata, created_at) VALUES (1, ?, ?, ?)').run('Codex 纸片剧', '{}', '2026-07-01T00:00:00.000Z');
  db.prepare(`INSERT INTO paper_assets (id, drama_id, asset_key, asset_type, prompt, status, matte_quality, version)
              VALUES (7, 1, 'character-10-arm', 'rig_part', '前景手臂', 'missing', 'unknown', 1)`).run();
  db.prepare(`INSERT INTO characters (id, drama_id, name, image_url, local_path) VALUES (10, 1, '主角', '/static/original.png', 'original.png')`).run();
  const cfg = { database: { path: path.join(tmp, 'db.sqlite') }, storage: { local_path: storage } };
  const created = codex.createJob(db, { info() {}, warn() {} }, cfg, { entity_type: 'paper_asset', entity_id: 7, drama_id: 1, episode_id: 1 });
  assert.equal(created.ok, true);
  assert.equal(created.job.entity_type, 'paper_asset');
  assert.match(created.job.prompt, /前景手臂/);
  const source = path.join(tmp, 'candidate.png');
  fs.writeFileSync(source, Buffer.from('candidate-image'));
  const imported = codex.importResults(db, null, cfg, { results: [{ job_id: created.job.id, candidates: [{ path: source }] }] });
  assert.equal(imported.errors.length, 0);
  const candidate = imported.imported[0].candidates[0];
  const used = codex.useCandidate(db, null, cfg, created.job.id, { candidate_id: candidate.id });
  assert.equal(used.ok, true);
  const asset = db.prepare('SELECT image_url, local_path, cutout_local_path, status, asset_hash FROM paper_assets WHERE id = 7').get();
  assert.equal(asset.status, 'needs_review');
  assert.equal(asset.cutout_local_path, null);
  assert.equal(asset.asset_hash, null);
  assert.match(asset.local_path, /paper-assets/);
  const character = db.prepare('SELECT image_url, local_path FROM characters WHERE id = 10').get();
  assert.equal(character.image_url, '/static/original.png');
  assert.equal(character.local_path, 'original.png');
  db.close();
});
