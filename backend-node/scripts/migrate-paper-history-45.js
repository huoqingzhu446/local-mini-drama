#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ensurePaperHistoryForkSchema } = require('../src/db/migrate');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const apply = process.argv.includes('--apply');
const sourcePath = path.resolve(process.cwd(), argument('--db') || 'data/drama_generator.db');
const temporaryPath = path.join(os.tmpdir(), `local-mini-drama-migration-45-${process.pid}-${Date.now()}.db`);

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function metric(db) {
  const scalar = (sql) => Number(db.prepare(sql).get()?.count || 0);
  return {
    asset_versions: scalar('SELECT COUNT(*) AS count FROM paper_asset_versions'),
    asset_file_references: scalar(`SELECT
      SUM(CASE WHEN source_local_path IS NOT NULL THEN 1 ELSE 0 END)
      + SUM(CASE WHEN alpha_local_path IS NOT NULL THEN 1 ELSE 0 END)
      + SUM(CASE WHEN mask_local_path IS NOT NULL THEN 1 ELSE 0 END) AS count
      FROM paper_asset_versions`),
    plan_revisions: scalar('SELECT COUNT(*) AS count FROM paper_plan_revisions'),
    missing_plan_pointers: scalar(`SELECT COUNT(*) AS count FROM paper_studio_shots
      WHERE current_plan_revision_id IS NULL`),
    provider_calls: scalar('SELECT COALESCE(SUM(provider_call_count), 0) AS count FROM image_generations'),
    storyboards: scalar('SELECT COUNT(*) AS count FROM paper_storyboards'),
    missing_working_copy_base: hasTable(db, 'paper_history_fork_audits')
      ? scalar(`SELECT COUNT(*) AS count FROM paper_storyboards
          WHERE current_revision_id IS NOT NULL AND working_copy_base_revision_id IS NULL`)
      : null,
    fork_audits: hasTable(db, 'paper_history_fork_audits')
      ? scalar('SELECT COUNT(*) AS count FROM paper_history_fork_audits')
      : null,
    sqlite_integrity: db.pragma('integrity_check', { simple: true }),
  };
}

function assertReport(before, after, replay) {
  const nonDecreasing = ['asset_versions', 'asset_file_references', 'plan_revisions', 'storyboards']
    .every((key) => after[key] >= before[key]);
  const stable = JSON.stringify(after) === JSON.stringify(replay);
  const valid = nonDecreasing
    && stable
    && after.sqlite_integrity === 'ok'
    && after.missing_plan_pointers === 0
    && after.missing_working_copy_base === 0
    && after.provider_calls === before.provider_calls;
  return { non_decreasing: nonDecreasing, idempotency_stable: stable, valid };
}

async function migrateCopy() {
  const source = new Database(sourcePath, { readonly: true });
  const before = metric(source);
  await source.backup(temporaryPath);
  source.close();
  const copy = new Database(temporaryPath);
  const migration = ensurePaperHistoryForkSchema(copy);
  const after = metric(copy);
  ensurePaperHistoryForkSchema(copy);
  const replay = metric(copy);
  copy.close();
  fs.unlinkSync(temporaryPath);
  const checks = assertReport(before, after, replay);
  return {
    mode: 'dry-run',
    source_database: sourcePath,
    temporary_database: 'removed_after_verification',
    migration,
    before,
    after,
    replay,
    checks,
  };
}

async function migrateSource() {
  const db = new Database(sourcePath);
  db.pragma('busy_timeout = 5000');
  const before = metric(db);
  const backupDir = path.join(path.dirname(sourcePath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `drama_generator.pre-migration-45-${stamp}.db`);
  await db.backup(backupPath);
  const migration = ensurePaperHistoryForkSchema(db);
  const after = metric(db);
  ensurePaperHistoryForkSchema(db);
  const replay = metric(db);
  db.close();
  const checks = assertReport(before, after, replay);
  if (!checks.valid) throw new Error(`Migration 45 verification failed; backup: ${backupPath}`);
  return {
    mode: 'apply',
    source_database: sourcePath,
    backup_database: backupPath,
    migration,
    before,
    after,
    replay,
    checks,
  };
}

async function main() {
  if (!fs.existsSync(sourcePath)) throw new Error(`Database not found: ${sourcePath}`);
  const report = apply ? await migrateSource() : await migrateCopy();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.checks.valid) process.exitCode = 1;
}

main().catch((error) => {
  try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch (_) { /* best effort */ }
  console.error(error);
  process.exitCode = 1;
});
