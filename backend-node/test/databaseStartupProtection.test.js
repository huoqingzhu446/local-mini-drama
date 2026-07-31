const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { closeDb, getDb } = require('../src/db');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-db-'));
}

test.afterEach(() => closeDb());

test('refuses to create a database when WAL remains without the main file', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'drama_generator.db');
  fs.writeFileSync(`${dbPath}-wal`, 'orphaned wal');
  assert.throws(
    () => getDb({ type: 'sqlite', path: dbPath }),
    (error) => error.code === 'DATABASE_MAIN_MISSING_WITH_WAL',
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('refuses to create an empty database while project storage still exists', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'drama_generator.db');
  fs.mkdirSync(path.join(root, 'storage', 'projects', '0001_existing-project'), { recursive: true });
  assert.throws(
    () => getDb({ type: 'sqlite', path: dbPath }),
    (error) => error.code === 'DATABASE_MAIN_MISSING_WITH_PROJECT_STORAGE',
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('creates a standalone startup backup for a valid existing database', () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'drama_generator.db');
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO dramas (id,title) VALUES (1,\'恢复测试\')');
  seed.close();
  fs.mkdirSync(path.join(root, 'storage', 'projects', '0001_existing-project'), { recursive: true });

  const opened = getDb({ type: 'sqlite', path: dbPath });
  assert.equal(opened.prepare('SELECT title FROM dramas WHERE id = 1').get().title, '恢复测试');
  const backupDir = path.join(root, 'backups', 'startup');
  const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.db'));
  assert.equal(backups.length, 1);
  const backup = new Database(path.join(backupDir, backups[0]), { readonly: true });
  assert.equal(backup.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
  assert.equal(backup.prepare('SELECT title FROM dramas WHERE id = 1').get().title, '恢复测试');
  backup.close();
});
