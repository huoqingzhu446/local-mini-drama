const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const paperUtils = require('../src/services/paperUtils');
const paperAssetService = require('../src/services/paperAssetService');
const paperRigService = require('../src/services/paperRigService');
const paperPlanner = require('../src/services/paperLayerPlannerService');
const paperValidation = require('../src/services/paperValidationService');
const paperComposition = require('../src/services/paperCompositionService');

function makePng({ alpha = true } = {}) {
  // A valid 1x1 PNG is enough for the synchronous metadata gate. The actual
  // upload/matte tests use sharp separately; keeping this fixture tiny makes
  // service tests fast and deterministic.
  if (alpha) return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/Scx7WQAAAABJRU5ErkJggg==', 'base64');
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+QP9KQAAAABJRU5ErkJggg==', 'base64');
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, metadata TEXT, created_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, duration REAL, action TEXT, dialogue TEXT, narration TEXT, movement TEXT,
      characters TEXT, shot_type TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT,
      audio_local_path TEXT, narration_audio_local_path TEXT, image_url TEXT, local_path TEXT,
      video_url TEXT, deleted_at TEXT, updated_at TEXT
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT,
      image_url TEXT, local_path TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, appearance TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, name TEXT, description TEXT, prompt TEXT, negative_prompt TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_props (id INTEGER PRIMARY KEY AUTOINCREMENT, storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE async_tasks (id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER, message TEXT, resource_id TEXT, result TEXT, error TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY, drama_id INTEGER, storyboard_id INTEGER, provider TEXT, prompt TEXT,
      model TEXT, duration REAL, aspect_ratio TEXT, resolution TEXT, status TEXT, task_id TEXT,
      generation_kind TEXT DEFAULT 'ai', paper_composition_id INTEGER, render_snapshot TEXT,
      render_hash TEXT, renderer_version TEXT, video_url TEXT, local_path TEXT, completed_at TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
  `);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '30_paper_layer_animation.sql'), 'utf8');
  for (const statement of migration.split(';').map((item) => item.trim()).filter(Boolean)) {
    if (/^CREATE\s+(?:TABLE|INDEX)/i.test(statement)) db.exec(`${statement};`);
  }
  return db;
}

function cfg(root) {
  return { storage: { local_path: root } };
}

function seedDrama(db, { action = '夏桀抬手举杯，妺喜回头', localPath } = {}) {
  db.prepare('INSERT INTO dramas (id, title, metadata, created_at) VALUES (1, ?, ?, ?)')
    .run('纸片测试剧', JSON.stringify({ aspect_ratio: '16:9' }), '2026-07-01T00:00:00.000Z');
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number) VALUES (1, 1, 2)').run();
  db.prepare(`INSERT INTO scenes (id, drama_id, episode_id, location, time, local_path, image_url)
              VALUES (1, 1, 1, '宫殿', '夜', ?, ?)`).run(localPath || null, localPath ? `/static/${localPath}` : null);
  db.prepare(`INSERT INTO characters (id, drama_id, name, appearance) VALUES (10, 1, '夏桀', '帝王'), (11, 1, '妺喜', '妃子')`).run();
  db.prepare(`INSERT INTO props (id, drama_id, episode_id, name, description) VALUES (20, 1, 1, '青铜酒杯', '夏桀手中的酒杯')`).run();
  db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (165, 20)').run();
  db.prepare(`INSERT INTO storyboards
      (id, episode_id, scene_id, storyboard_number, title, duration, action, dialogue, narration, movement, characters, shot_type, angle_h, angle_v, angle_s)
      VALUES (165, 1, 1, 165, '测试镜头', 4, ?, '', '', '', ?, 'medium', 'front', 'eye_level', 'medium')`)
    .run(action, JSON.stringify([10, 11]));
}

test('paperUtils normalizes public paths and rejects traversal/remote paths', () => {
  assert.equal(paperUtils.normalizeRelativePath('/static/projects/a.png'), 'projects/a.png');
  assert.equal(paperUtils.normalizeRelativePath('data/storage/projects/a.png'), 'projects/a.png');
  assert.equal(paperUtils.normalizeRelativePath('../outside.png'), null);
  assert.equal(paperUtils.normalizeRelativePath('/etc/passwd'), null);
  assert.equal(paperUtils.normalizeRelativePath('https://example.com/a.png'), null);
});

test('paperAssetService enforces hash, dimensions and storyboard-reference prohibition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-asset-'));
  const db = makeDb();
  const rel = 'projects/asset.png';
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makePng());
  const asset = paperAssetService.create(db, {
    drama_id: 1, asset_key: 'asset', asset_type: 'cutout', status: 'ready',
    source_entity_type: 'character', source_entity_id: 10, local_path: rel,
    matte_quality: 'pass', content_bbox_json: { x: 0, y: 0, width: 1, height: 1 }, alpha_bbox_json: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.throws(() => paperAssetService.resolveAssetForRender(db, cfg(root), asset.id), (error) => error.code === 'PAPER_ASSET_HASH_MISSING');
  const reconciled = paperAssetService.refreshFileMetadata(db, cfg(root), asset.id, { status: 'ready' });
  assert.equal(reconciled.processing_json.width, 1);
  const resolved = paperAssetService.resolveAssetForRender(db, cfg(root), asset.id);
  assert.equal(resolved.resolved_local_path, rel);

  const reference = paperAssetService.create(db, {
    drama_id: 1, asset_key: 'storyboard-ref', asset_type: 'decoration', status: 'ready',
    source_entity_type: 'storyboard', source_entity_id: 165, local_path: rel,
    asset_hash: resolved.asset_hash, processing_json: { width: 1, height: 1 }, content_bbox_json: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.throws(() => paperAssetService.resolveAssetForRender(db, cfg(root), reference.id), (error) => error.code === 'PAPER_SCHEMA_INVALID');
  db.close();
});

test('rig validation rejects missing roots and cycles', () => {
  assert.throws(() => paperRigService.validateParts([
    { key: 'root', parent: null, pivot: [0.5, 0.5] },
    { key: 'arm', parent: 'missing', pivot: [0.5, 0.5] },
  ], 'root'), (error) => error.code === 'PAPER_RIG_PARENT_MISSING');
  assert.throws(() => paperRigService.validateParts([
    { key: 'root', parent: 'arm', pivot: [0.5, 0.5] },
    { key: 'arm', parent: 'root', pivot: [0.5, 0.5] },
  ], 'root'), (error) => error.code === 'PAPER_RIG_ROOT_INVALID' || error.code === 'PAPER_RIG_CYCLE');
});

test('planner refreshes an existing scene asset and emits real rig action tracks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-plan-'));
  const db = makeDb();
  const sceneRel = 'projects/scene-bg.png';
  const sceneFile = path.join(root, sceneRel);
  fs.mkdirSync(path.dirname(sceneFile), { recursive: true });
  fs.writeFileSync(sceneFile, makePng({ alpha: false }));
  seedDrama(db, { localPath: sceneRel });
  const log = { info() {}, warn() {}, error() {} };
  const planned = paperComposition.createOrPlan(db, cfg(root), log, 165, {});
  assert.equal(planned.composition.storyboard_id, 165);
  const background = db.prepare("SELECT * FROM paper_assets WHERE asset_type = 'background_plate'").get();
  assert.equal(background.status, 'ready');
  assert.match(background.asset_hash, /^sha256:/);
  const characterLayer = db.prepare("SELECT * FROM paper_layers WHERE role = 'primary'").get();
  const animation = JSON.parse(characterLayer.animation_json);
  assert.ok(animation.tracks.some((track) => String(track.target).includes('arm_front') && track.property === 'rotation'));
  assert.ok(animation.tracks.some((track) => String(track.target).includes('head') && track.property === 'rotation'));
  const propLayer = db.prepare("SELECT * FROM paper_layers WHERE layer_type = 'prop'").get();
  assert.ok(propLayer);
  assert.equal(db.prepare('SELECT source_entity_type FROM paper_assets WHERE id = ?').get(propLayer.paper_asset_id).source_entity_type, 'prop');
  const validation = paperValidation.validate(db, cfg(root), planned.composition.id, { readOnly: true, allowProvisional: true });
  assert.equal(validation.ok, false);
  assert.ok(validation.blocking.some((item) => item.code === 'MISSING_SEMANTIC_ASSET'));
  db.close();
});

test('validation does not mistake a layer settle track for rig action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-motion-gate-'));
  const db = makeDb();
  seedDrama(db, { localPath: null });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO paper_compositions
    (id, drama_id, episode_id, storyboard_id, version, schema_version, template_key, fps, width, height, duration_frames,
     camera_json, continuity_json, audio_json, audio_timing_status, status, created_at, updated_at)
    VALUES (1, 1, 1, 165, 1, 2, 'paper_history_v1', 30, 1920, 1080, 120, '{}', '{}', ?, 'locked', 'draft', ?, ?)`)
    .run(JSON.stringify({ timing: { phases: [{ name: 'action', start_frame: 20, end_frame: 70 }] }, cues: [] }), now, now);
  const rig = paperRigService.create(db, { drama_id: 1, subject_type: 'character', subject_id: 10, rig_key: 'character-10-front', root_part_key: 'root', parts: [{ key: 'root', parent: null, pivot: [0.5, 0.5], asset_id: 1 }] });
  db.prepare(`INSERT INTO paper_layers
    (composition_id, rig_id, layer_key, layer_type, role, transform_json, animation_json, occlusion_json, status, created_at, updated_at)
    VALUES (1, ?, 'hero', 'character', 'primary', ?, ?, '{}', 'ready', ?, ?)`)
    .run(rig.id, JSON.stringify({ x: 0.5, y: 0.8, width: 0.3, opacity: 1 }), JSON.stringify({ intentional_hold: false, tracks: [{ target: 'layer', property: 'y', from: 0.01, to: 0 }] }), now, now);
  const result = paperValidation.validate(db, cfg(root), 1, { readOnly: true, allowProvisional: true });
  assert.ok(result.blocking.some((item) => item.code === 'MOTION_COVERAGE_MISSING'));
  db.close();
});

test('composition response includes drama-scoped assets referenced by a rig', () => {
  const db = makeDb();
  const now = new Date().toISOString();
  const asset = paperAssetService.create(db, {
    drama_id: 1,
    asset_scope: 'drama',
    asset_key: 'hero-head',
    asset_type: 'rig_part',
    status: 'needs_review',
  });
  const rig = paperRigService.create(db, {
    drama_id: 1,
    subject_type: 'character',
    subject_id: 10,
    rig_key: 'hero-front',
    root_part_key: 'head',
    parts: [{ key: 'head', parent: null, pivot: [0.5, 0.5], asset_id: asset.id }],
  });
  db.prepare(`INSERT INTO paper_compositions
    (id, drama_id, episode_id, storyboard_id, version, schema_version, template_key, fps, width, height, duration_frames,
     camera_json, continuity_json, audio_json, audio_timing_status, status, created_at, updated_at)
    VALUES (1, 1, 1, 165, 1, 2, 'paper_history_v1', 30, 1920, 1080, 120, '{}', '{}', '{}', 'unlocked', 'draft', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO paper_layers
    (composition_id, rig_id, layer_key, layer_type, role, transform_json, animation_json, occlusion_json, status, created_at, updated_at)
    VALUES (1, ?, 'hero', 'character', 'primary', '{}', '{}', '{}', 'missing', ?, ?)`).run(rig.id, now, now);

  const response = paperComposition.get(db, 1);
  assert.ok(response.assets.some((item) => item.id === asset.id));
  assert.equal(response.assets.find((item) => item.id === asset.id).status, 'needs_review');
  paperAssetService.update(db, asset.id, { status: 'stale' }, asset.version);
  assert.equal(db.prepare('SELECT status FROM paper_compositions WHERE id = 1').get().status, 'stale');
  db.close();
});
