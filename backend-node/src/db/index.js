const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

const STARTUP_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_BACKUP_LIMIT = 12;

function absoluteDbPath(configuredPath) {
  if (configuredPath === ':memory:') return configuredPath;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
}

function projectStorageHasFiles(dbPath) {
  if (dbPath === ':memory:') return false;
  const projectsDir = path.join(path.dirname(dbPath), 'storage', 'projects');
  if (!fs.existsSync(projectsDir)) return false;
  return fs.readdirSync(projectsDir, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

function startupSafetyError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertSafeToOpen(dbPath) {
  if (dbPath === ':memory:') return;
  const exists = fs.existsSync(dbPath);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (!exists && (fs.existsSync(walPath) || fs.existsSync(shmPath))) {
    throw startupSafetyError(
      'DATABASE_MAIN_MISSING_WITH_WAL',
      '数据库主文件缺失，但 WAL/SHM 仍然存在；已拒绝创建空数据库，请先执行恢复',
      { db_path: dbPath, wal_exists: fs.existsSync(walPath), shm_exists: fs.existsSync(shmPath) },
    );
  }
  if (!exists && projectStorageHasFiles(dbPath)) {
    throw startupSafetyError(
      'DATABASE_MAIN_MISSING_WITH_PROJECT_STORAGE',
      '数据库主文件缺失，但项目素材目录仍有内容；已拒绝创建空数据库，请先执行恢复',
      { db_path: dbPath },
    );
  }
}

function assertDatabaseMatchesStorage(database, dbPath) {
  if (dbPath === ':memory:' || !projectStorageHasFiles(dbPath)) return;
  const dramasTable = database.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'dramas'",
  ).get();
  const dramaCount = dramasTable
    ? Number(database.prepare('SELECT COUNT(*) AS count FROM dramas').get().count || 0)
    : 0;
  if (!dramaCount) {
    throw startupSafetyError(
      'DATABASE_EMPTY_WITH_PROJECT_STORAGE',
      '数据库没有任何项目记录，但项目素材目录仍有内容；已拒绝启动，防止空库覆盖恢复现场',
      { db_path: dbPath },
    );
  }
}

function sqliteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createStartupBackup(database, dbPath) {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const backupDir = path.join(path.dirname(dbPath), 'backups', 'startup');
  fs.mkdirSync(backupDir, { recursive: true });
  const existing = fs.readdirSync(backupDir)
    .filter((name) => /^drama_generator\.startup-.*\.db$/.test(name))
    .map((name) => ({ name, full: path.join(backupDir, name) }))
    .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs);
  if (existing[0] && Date.now() - fs.statSync(existing[0].full).mtimeMs < STARTUP_BACKUP_INTERVAL_MS) {
    return existing[0].full;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `drama_generator.startup-${stamp}.db`);
  database.exec(`VACUUM INTO ${sqliteLiteral(destination)}`);
  const after = fs.readdirSync(backupDir)
    .filter((name) => /^drama_generator\.startup-.*\.db$/.test(name))
    .map((name) => path.join(backupDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const stale of after.slice(STARTUP_BACKUP_LIMIT)) fs.unlinkSync(stale);
  return destination;
}

function getDb(config) {
  if (db) return db;
  const dbPath = absoluteDbPath(config.path);
  assertSafeToOpen(dbPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath, {
    verbose: config.type === 'sqlite' && process.env.DEBUG ? console.log : undefined,
  });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  try {
    assertDatabaseMatchesStorage(db, dbPath);
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw startupSafetyError(
        'DATABASE_INTEGRITY_CHECK_FAILED',
        `数据库完整性检查失败：${integrity}`,
        { db_path: dbPath, integrity },
      );
    }
    createStartupBackup(db, dbPath);
  } catch (error) {
    db.close();
    db = null;
    throw error;
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  closeDb,
  absoluteDbPath,
  assertSafeToOpen,
  assertDatabaseMatchesStorage,
  createStartupBackup,
};
