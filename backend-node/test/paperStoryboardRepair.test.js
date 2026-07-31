const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const aiClient = require('../src/services/aiClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const scriptService = require('../src/services/paper-studio/paperScriptService');
const storyboardGenerationService = require('../src/services/paper-studio/paperStoryboardGenerationService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-27T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'AI 补全测试',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, {
    request_id: randomUUID(), title: '补全测试分集', fps: 30, default_duration: 6,
  }).episode;
  const script = scriptService.create(db, log, episode.id, {
    request_id: randomUUID(),
    content: '地图上的黑色箭头向北推进并包围巨鹿。城内守军登上城墙，城外诸侯仍然观望，没有立刻出兵。',
    source_kind: 'manual',
  }).script;
  return { db, project, episode, script };
}

function incompleteShots() {
  return [
    {
      title: '秦军的绞索', description: '', action: '', environment_only: false, duration: 6,
      shot_type: '中景', camera_motion: '固定', scene_entity_name: '巨鹿南面',
      character_entity_names: ['王离'], prop_entity_names: ['战役地图'],
    },
    {
      title: '巨鹿危城', description: '守军站在巨鹿城墙上，城外秦军营帐绵延。', action: '', environment_only: false, duration: 6,
      shot_type: '全景', camera_motion: '推近', character_entity_names: ['王离'], prop_entity_names: [],
    },
    {
      title: '漳河寒雾', description: '漳河两岸被寒雾覆盖。', action: '', environment_only: true, duration: 6,
      shot_type: '远景', camera_motion: '固定', character_entity_names: [], prop_entity_names: [],
    },
  ];
}

test('draft issue scan only requires action for non-environment storyboards', () => {
  assert.deepEqual(storyboardGenerationService.scanDraftIssues(incompleteShots()), [
    {
      shot_index: 0, shot_number: 1, title: '秦军的绞索',
      missing_fields: ['description', 'action'], environment_only: false,
    },
    {
      shot_index: 1, shot_number: 2, title: '巨鹿危城',
      missing_fields: ['action'], environment_only: false,
    },
  ]);
});

test('AI repair fills only missing fields and returns a reviewable patch preview', async () => {
  const context = setup();
  const originalGenerateText = aiClient.generateText;
  let receivedOptions = null;
  aiClient.generateText = async (_db, _log, _type, _prompt, _systemPrompt, options) => {
    receivedOptions = options;
    return JSON.stringify({
      repairs: [
        {
          shot_number: 1,
          description: '俯拍战役地图，定陶、黄河与巨鹿依次位于推进路线两侧，黑色箭头在地图中央形成包围构图。',
          action: '代表秦军的黑色箭头由南向北推进，越过黄河后从两侧向巨鹿合拢，王离剪影在包围完成时定格。',
        },
        {
          shot_number: 2,
          description: '这段内容不得覆盖已有画面描述。',
          action: '王离从城墙一端快步走向中央，抬手示意守军戒备，士卒随后转身面向城外秦军营帐。',
        },
      ],
    });
  };
  try {
    const shots = incompleteShots();
    const originalDescription = shots[1].description;
    const result = await storyboardGenerationService.repair(context.db, {}, log, context.episode.id, {
      request_id: randomUUID(), script_version_id: context.script.id, shots,
    });
    assert.equal(receivedOptions.scene_key, 'paper_storyboard_repair');
    assert.equal(result.issues.length, 0);
    assert.equal(result.repaired_shot_count, 2);
    assert.equal(result.patches.length, 3);
    assert.equal(result.shots[1].description, originalDescription);
    assert.match(result.shots[0].action, /黑色箭头/);
    assert.match(result.shots[1].action, /王离/);
    assert.equal(result.shots[2].action, '');
    assert.equal(shots[0].description, '', 'repair preview must not mutate the submitted draft object');
  } finally {
    aiClient.generateText = originalGenerateText;
    context.db.close();
  }
});

test('applying generated storyboards rejects incomplete non-environment shots before writing', () => {
  const context = setup();
  try {
    assert.throws(
      () => storyboardGenerationService.apply(context.db, log, context.episode.id, {
        request_id: randomUUID(), mode: 'append', shots: incompleteShots(),
      }),
      (error) => error.code === 'PAPER_STUDIO_STORYBOARD_INCOMPLETE'
        && error.details.storyboards.length === 2
        && error.details.storyboards[0].missing_fields.includes('description')
        && error.details.storyboards[0].missing_fields.includes('action'),
    );
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM paper_storyboards').get().count, 0);
  } finally {
    context.db.close();
  }
});
