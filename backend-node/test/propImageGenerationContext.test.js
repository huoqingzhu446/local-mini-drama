const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const propImage = require('../src/services/propImageGenerationService');

test('prop image generation record freezes style and reference provenance', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prop_id INTEGER, drama_id INTEGER, provider TEXT, prompt TEXT,
      negative_prompt TEXT, model TEXT, frame_type TEXT, reference_images TEXT,
      size TEXT, quality TEXT, status TEXT, task_id TEXT, image_url TEXT,
      local_path TEXT, style_version_id INTEGER, context_snapshot_id TEXT,
      prompt_hash TEXT, reference_pack TEXT, compiler_version TEXT,
      error_msg TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  const compiled = {
    style_version_id: 5,
    prompt_hash: 'prompt-hash-v5',
    compiler_version: 'v2',
    reference_pack: { hash: 'refs-v5', references: [{ value: 'projects/scene.png' }] },
  };
  const id = propImage.createPropImageGenerationRecord(db, {
    prop_id: 30,
    drama_id: 4,
    provider: 'openai',
    prompt: 'compiled prop prompt',
    negative_prompt: 'no text',
    model: 'image-model',
    size: '1920x1080',
    quality: 'hd',
    reference_images: ['projects/scene.png'],
    compiled,
    context_snapshot_id: 'gctx_prop_v5',
    task_id: 'task_prop_1',
  });
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(id);
  assert.equal(row.prop_id, 30);
  assert.equal(row.style_version_id, 5);
  assert.equal(row.context_snapshot_id, 'gctx_prop_v5');
  assert.equal(row.prompt_hash, 'prompt-hash-v5');
  assert.deepEqual(JSON.parse(row.reference_pack).references[0].value, 'projects/scene.png');

  propImage.updatePropImageGeneration(db, id, {
    status: 'completed', image_url: '/static/props/prop.png', local_path: 'props/prop.png', completed_at: 'now',
  });
  const completed = db.prepare('SELECT status, image_url, local_path FROM image_generations WHERE id = ?').get(id);
  assert.deepEqual(completed, { status: 'completed', image_url: '/static/props/prop.png', local_path: 'props/prop.png' });
  db.close();
});
