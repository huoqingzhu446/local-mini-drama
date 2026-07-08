const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const generationStyleService = require('../src/services/generationStyleService');
const {
  mergeCfgStyleWithDrama,
  resolvedStreamStyleFromDrama,
  scopedStyleTextsFromStyleObject,
} = require('../src/utils/dramaStyleMerge');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE generation_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT,
      style_prompt_zh TEXT,
      style_prompt_en TEXT,
      visual_bible TEXT,
      visual_bible_struct TEXT,
      character_style_prompt_zh TEXT,
      character_style_prompt_en TEXT,
      scene_style_prompt_zh TEXT,
      scene_style_prompt_en TEXT,
      prop_style_prompt_zh TEXT,
      prop_style_prompt_en TEXT,
      video_style_prompt_zh TEXT,
      video_style_prompt_en TEXT,
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

test('generation style CRUD persists visual bible and advanced overrides', () => {
  const db = createDb();

  const created = generationStyleService.createStyle(db, {
    name: '新中式悬疑写实',
    description: '适合都市悬疑与现实题材。',
    style_prompt_zh: '冷青灰电影感，真实皮肤纹理，克制高光。',
    style_prompt_en: 'cool cyan-gray cinematic realism, real skin texture, restrained highlights',
    visual_bible_struct: {
      palette: '冷青灰 + 暗金',
      lighting: '克制硬侧光',
      negative: '禁止塑料皮肤',
    },
    character_style_prompt_en: 'subtle facial detail, grounded expressions',
    scene_style_prompt_en: 'weathered architecture, humid air perspective',
    video_style_prompt_en: 'measured camera breathing, continuous spatial logic',
  });

  assert.equal(created.name, '新中式悬疑写实');
  assert.match(created.visual_bible, /Palette: 冷青灰 \+ 暗金/);
  assert.equal(created.character_style_prompt_en, 'subtle facial detail, grounded expressions');
  assert.equal(generationStyleService.listStyles(db).length, 1);

  const updated = generationStyleService.updateStyle(db, created.id, {
    enabled: false,
    prop_style_prompt_zh: '单道具棚拍主图，突出材质与真实比例。',
  });

  assert.equal(updated.enabled, false);
  assert.equal(updated.prop_style_prompt_zh, '单道具棚拍主图，突出材质与真实比例。');

  assert.equal(generationStyleService.deleteStyle(db, created.id), true);
  assert.equal(generationStyleService.listStyles(db).length, 0);
});

test('scoped style merge keeps advanced overrides for character and video flows', () => {
  const dramaRow = {
    style: 'cinematic',
    metadata: {
      style_prompt_zh: '电影级写实，胶片颗粒，克制戏剧布光',
      style_prompt_en: 'cinematic realism, film grain, restrained dramatic lighting',
      visual_bible: {
        palette: '冷青灰',
        lighting: '边缘光克制',
      },
      character_style_prompt_en: 'subtle facial pores, grounded wardrobe realism',
      video_style_prompt_en: 'camera breathing, continuous blocking, restrained motion language',
    },
  };

  const merged = mergeCfgStyleWithDrama({}, dramaRow);
  const charScoped = scopedStyleTextsFromStyleObject(merged.style, 'character');

  assert.match(charScoped.en, /cinematic realism/);
  assert.match(charScoped.en, /grounded wardrobe realism/);
  assert.ok(merged.style.character_style_signature);
  assert.ok(merged.style.video_style_signature);

  const explicitVideoStyle = resolvedStreamStyleFromDrama('ink wash', dramaRow, 'video');
  assert.match(explicitVideoStyle, /traditional Chinese ink wash painting|guohua style/);
  assert.match(explicitVideoStyle, /continuous blocking/);
});
