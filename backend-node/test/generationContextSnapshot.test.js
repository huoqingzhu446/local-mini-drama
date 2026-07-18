const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const service = require('../src/services/generationContextService');

test('generation context snapshots are immutable and preserve hashes/reference provenance', () => {
  const db = new Database(':memory:');
  const first = service.createSnapshot(db, {
    drama_id: 4, episode_id: 7, scene_id: 46, storyboard_id: 165,
    entity_type: 'storyboard', entity_id: 165, frame_type: 'main',
    style_version_id: 5, style_signature: 'sig5', prompt_source: 'image_prompt',
    source_prompt: '冲锋', compiled_prompt: 'compiled prompt', compiled_negative_prompt: 'no text',
    reference_pack: { references: [{ value: 'projects/scene.png' }] }, source_snapshot: { legacy: true },
    diagnostics: [{ code: 'INFO' }],
  });
  assert.match(first.id, /^gctx_/);
  assert.equal(first.prompt_hash, service.hashValue('compiled prompt'));
  assert.equal(first.reference_pack.references[0].value, 'projects/scene.png');
  assert.deepEqual(first.diagnostics, [{ code: 'INFO' }]);
  assert.equal(service.latestSnapshot(db, 'storyboard', 165, 'main').id, first.id);
  assert.equal(service.listSnapshots(db, { drama_id: 4 }).length, 1);
  assert.throws(() => service.createSnapshot(db, { entity_type: 'storyboard', entity_id: 165 }), /compiled_prompt is required/);
  db.close();
});
