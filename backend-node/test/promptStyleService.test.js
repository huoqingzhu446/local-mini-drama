const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const promptStyleService = require('../src/services/promptStyleService');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE prompt_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      description TEXT,
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE prompt_style_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      style_id INTEGER NOT NULL,
      tag TEXT NOT NULL DEFAULT '',
      created_at TEXT
    );
  `);
  return db;
}

test('prompt style CRUD normalizes tags and soft deletes rows', () => {
  const db = createDb();

  const created = promptStyleService.createStyle(db, {
    name: '去 AI 风',
    content: '避免塑料质感和廉价 HDR。',
    tags: ['去AI', '写实', '去AI', ''],
    enabled: true,
  });

  assert.equal(created.name, '去 AI 风');
  assert.deepEqual(created.tags, ['去AI', '写实']);
  assert.equal(promptStyleService.listTags(db).length, 2);

  const updated = promptStyleService.updateStyle(db, created.id, {
    name: '电影写实',
    content: '强调自然光影和可信材质。',
    tags: '电影,写实，质感',
    enabled: false,
  });

  assert.equal(updated.name, '电影写实');
  assert.deepEqual(updated.tags, ['电影', '写实', '质感']);
  assert.equal(updated.enabled, false);
  assert.equal(promptStyleService.listStyles(db).length, 1);

  assert.equal(promptStyleService.deleteStyle(db, created.id), true);
  assert.equal(promptStyleService.listStyles(db).length, 0);
  assert.equal(promptStyleService.listTags(db).length, 0);
});

test('constraint block only includes enabled selected styles in requested order', () => {
  const db = createDb();
  const first = promptStyleService.createStyle(db, {
    name: '场景细节',
    content: '增加空间层次和真实陈设。',
    tags: ['场景'],
  });
  const disabled = promptStyleService.createStyle(db, {
    name: '停用风格',
    content: '不应出现。',
    enabled: false,
  });
  const second = promptStyleService.createStyle(db, {
    name: '去 AI 风',
    content: '禁止过度磨皮、伪 HDR、水印。',
    tags: ['负面'],
  });

  const block = promptStyleService.buildPromptStyleConstraintBlock(db, [second.id, disabled.id, first.id, second.id]);

  assert.match(block, /去 AI 风/);
  assert.match(block, /场景细节/);
  assert.doesNotMatch(block, /停用风格/);
  assert.ok(block.indexOf('去 AI 风') < block.indexOf('场景细节'));
});
