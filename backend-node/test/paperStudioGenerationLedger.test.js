const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetProductionService = require('../src/services/paper-studio/paperAssetProductionService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function insertAttempt(db, values = {}) {
  const now = '2026-07-31T00:00:00.000Z';
  return Number(db.prepare(
    `INSERT INTO image_generations
      (drama_id, provider, status, generation_kind, request_fingerprint,
       paper_studio_run_id, paper_studio_shot_id, paper_asset_slot_id,
       generation_authorization_id, provider_attempted_at, provider_call_count,
       created_at, updated_at)
     VALUES (1, 'test', ?, 'paper_studio_asset', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    values.status || 'processing', values.fingerprint || null,
    Number(values.run_id || 10), Number(values.shot_id || 20), Number(values.slot_id || 30),
    Number(values.authorization_id || 40), values.provider_attempted_at || null,
    Number(values.provider_call_count || 0), now, now,
  ).lastInsertRowid);
}

test('paper studio generation budget uses the durable run ledger before version backfill', () => {
  const db = setup();
  insertAttempt(db, { status: 'processing' });
  insertAttempt(db, { status: 'completed', slot_id: 31 });
  insertAttempt(db, { status: 'failed', slot_id: 32, provider_attempted_at: '2026-07-31T00:01:00.000Z', provider_call_count: 1 });
  insertAttempt(db, { status: 'failed', slot_id: 33 });
  insertAttempt(db, { status: 'completed', run_id: 11, slot_id: 34 });
  assert.equal(assetProductionService.usedImageCount(db, 10), 3);
  assert.equal(assetProductionService.usedImageCount(db, 11), 1);
  db.close();
});

test('provider call reservation enforces the authorized per-slot call limit', () => {
  const db = setup();
  const id = insertAttempt(db, { status: 'processing' });
  assert.equal(assetProductionService.reserveProviderCall(db, id, 2), 1);
  assert.equal(assetProductionService.reserveProviderCall(db, id, 2), 2);
  assert.throws(
    () => assetProductionService.reserveProviderCall(db, id, 2),
    (error) => error.code === 'PAPER_STUDIO_GENERATION_AUTHORIZED_CALLS_EXHAUSTED',
  );
  const row = db.prepare('SELECT provider_call_count, provider_attempted_at FROM image_generations WHERE id = ?').get(id);
  assert.equal(Number(row.provider_call_count), 2);
  assert.ok(row.provider_attempted_at);
  db.close();
});

test('active fingerprint uniqueness is scoped to run and slot and releases after failure', () => {
  const db = setup();
  insertAttempt(db, { status: 'failed', fingerprint: 'same', provider_attempted_at: '2026-07-31T00:01:00.000Z' });
  insertAttempt(db, { status: 'processing', fingerprint: 'same' });
  assert.throws(() => insertAttempt(db, { status: 'processing', fingerprint: 'same' }), /UNIQUE constraint failed/);
  insertAttempt(db, { status: 'processing', fingerprint: 'same', run_id: 11 });
  insertAttempt(db, { status: 'processing', fingerprint: 'same', slot_id: 31 });
  db.close();
});
