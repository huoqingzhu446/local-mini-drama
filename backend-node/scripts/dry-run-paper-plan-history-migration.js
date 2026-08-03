#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

const sourcePath = path.resolve(process.cwd(), process.argv[2] || 'data/drama_generator.db');
const targetPath = path.join(os.tmpdir(), `local-mini-drama-paper-history-${process.pid}-${Date.now()}.db`);
const trackedTables = [
  'paper_studio_shots',
  'paper_source_families',
  'paper_asset_slots',
  'paper_asset_versions',
  'paper_composition_nodes',
  'paper_motion_plans',
  'paper_job_steps',
];

function counts(db) {
  return Object.fromEntries(trackedTables.map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
  ]));
}

function integrity(db) {
  return {
    missing_current_plan: Number(db.prepare(
      'SELECT COUNT(*) AS count FROM paper_studio_shots WHERE current_plan_revision_id IS NULL',
    ).get().count),
    orphan_asset_slots: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_asset_slots pas
       LEFT JOIN paper_source_families psf ON psf.id = pas.family_id
       WHERE psf.id IS NULL`,
    ).get().count),
    orphan_asset_versions: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_asset_versions pav
       LEFT JOIN paper_asset_slots pas ON pas.id = pav.slot_id
       WHERE pas.id IS NULL`,
    ).get().count),
    current_family_scope_mismatch: Number(db.prepare(
      `SELECT COUNT(*) AS count FROM paper_studio_shots pss
       JOIN paper_source_families psf ON psf.shot_id = pss.id
       WHERE psf.status != 'superseded'
         AND psf.plan_revision_id != pss.current_plan_revision_id`,
    ).get().count),
    sqlite_integrity: db.pragma('integrity_check', { simple: true }),
  };
}

async function main() {
  if (!fs.existsSync(sourcePath)) throw new Error(`Database not found: ${sourcePath}`);
  const source = new Database(sourcePath, { readonly: true });
  const before = counts(source);
  await source.backup(targetPath);
  source.close();
  const copy = new Database(targetPath);
  runMigrationsAndEnsure(copy);
  const after = counts(copy);
  runMigrationsAndEnsure(copy);
  const afterIdempotencyReplay = counts(copy);
  const report = {
    dry_run: true,
    source_database: sourcePath,
    temporary_database: targetPath,
    before,
    after,
    after_idempotency_replay: afterIdempotencyReplay,
    non_decreasing: Object.fromEntries(trackedTables.map((table) => [table, after[table] >= before[table]])),
    idempotency_stable: Object.fromEntries(trackedTables.map((table) => [table, afterIdempotencyReplay[table] === after[table]])),
    integrity: integrity(copy),
    plan_revisions: Number(copy.prepare('SELECT COUNT(*) AS count FROM paper_plan_revisions').get().count),
    reuse_fingerprinted_slots: Number(copy.prepare(
      "SELECT COUNT(*) AS count FROM paper_asset_slots WHERE reuse_fingerprint LIKE 'sha256:%'",
    ).get().count),
  };
  copy.close();
  fs.unlinkSync(targetPath);
  process.stdout.write(`${JSON.stringify({ ...report, temporary_database: 'removed_after_verification' }, null, 2)}\n`);
  if (!Object.values(report.non_decreasing).every(Boolean)
      || !Object.values(report.idempotency_stable).every(Boolean)
      || report.integrity.sqlite_integrity !== 'ok'
      || report.integrity.orphan_asset_slots
      || report.integrity.orphan_asset_versions
      || report.integrity.missing_current_plan) process.exitCode = 1;
}

main().catch((error) => {
  try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch (_) { /* best effort */ }
  console.error(error);
  process.exitCode = 1;
});
