const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const revisionService = require('../src/services/paper-studio/paperSourceRevisionService');
const legacySyncService = require('../src/services/paper-studio/paperLegacySyncService');
const episodeMergeService = require('../src/services/paper-studio/paperEpisodeMergeService');
const archiveService = require('../src/services/paper-studio/paperStudioArchiveService');
const videoMergeService = require('../src/services/videoMergeService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare(
    `INSERT INTO dramas
      (id, title, description, active_visual_style_signature, created_at, updated_at)
     VALUES (1, '独立纸片项目', '没有旧分集和旧分镜', 'style:paper-independent-v1', ?, ?)`,
  ).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID(), default_tier: 'balanced' }).project;
  return { db, project };
}

test('migration 33 creates the independent paper authoring domain', () => {
  const { db } = setup();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ['paper_studio_episodes', 'paper_storyboards', 'paper_storyboard_revisions']) assert.equal(tables.has(name), true, name);
  const runColumns = new Set(db.prepare('PRAGMA table_info(paper_studio_runs)').all().map((row) => row.name));
  const shotColumns = new Set(db.prepare('PRAGMA table_info(paper_studio_shots)').all().map((row) => row.name));
  assert.equal(runColumns.has('paper_episode_id'), true);
  assert.equal(shotColumns.has('paper_storyboard_revision_id'), true);
  db.close();
});

test('paper episodes and storyboards can be authored without legacy records', () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, {
    request_id: randomUUID(), title: '纸片第一集', aspect_ratio: '16:9', fps: 30, default_duration: 8,
  }).episode;
  const first = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '雾中启程', description: '空旷渡口与远处人物', action: '角色从画面左侧走向渡口', duration: 8,
  }).storyboard;
  const second = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '越过边界', description: '主体进入另一空间', action: '主体穿过前景边界并被遮挡', duration: 7,
  }).storyboard;

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM episodes').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storyboards').get().count, 0);
  assert.equal(first.current_revision_id > 0, true);
  assert.equal(second.shot_number, 2);

  const updated = storyboardService.update(db, log, first.id, {
    request_id: randomUUID(), expected_version: first.version, action: '角色加速走向渡口并停在水边',
  });
  assert.equal(updated.version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_storyboard_revisions WHERE paper_storyboard_id = ?').get(first.id).count, 2);

  const reordered = storyboardService.reorder(db, log, episode.id, {
    request_id: randomUUID(), storyboard_ids: [second.id, first.id],
  });
  assert.deepEqual(reordered.map((item) => item.id), [second.id, first.id]);
  storyboardService.remove(db, log, second.id, {
    request_id: randomUUID(), expected_version: storyboardService.get(db, second.id).version,
  });
  const compacted = storyboardService.list(db, episode.id);
  assert.deepEqual(compacted.map((item) => [item.id, item.shot_number]), [[first.id, 1]]);
  db.close();
});

test('independent paper run freezes revisions and never requires a legacy storyboard', () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '纸片第一集' }).episode;
  const first = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '动作一', description: '人物站在空旷地面', action: '人物抬起手臂', duration: 6,
  }).storyboard;
  const second = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '动作二', description: '人物靠近门框', action: '人物穿过门框进入室内', duration: 6,
  }).storyboard;

  const result = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
    paper_storyboard_ids: [first.id, second.id], quality_tier: 'balanced',
    expected_paper_storyboard_revisions: {
      [first.id]: first.current_revision_id,
      [second.id]: second.current_revision_id,
    },
  });
  assert.equal(result.run.paper_episode_id, episode.id);
  assert.deepEqual(result.run.selection_json.paper_storyboard_ids, [first.id, second.id]);
  assert.equal(result.run.shots.every((shot) => shot.source_kind === 'paper'), true);
  assert.equal(result.run.shots.every((shot) => shot.paper_storyboard_revision_id > 0), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storyboards').get().count, 0);

  const detail = shotService.get(db, result.run.shots[0].id);
  assert.equal(detail.storyboard.title, '动作一');
  assert.equal(revisionService.assertShotCurrent(db, detail.id).pass, true);

  storyboardService.update(db, log, first.id, {
    request_id: randomUUID(), expected_version: storyboardService.get(db, first.id).version, title: '动作一（新草稿）',
  });
  const frozen = shotService.get(db, detail.id);
  assert.equal(frozen.storyboard.title, '动作一');
  assert.equal(revisionService.assertShotCurrent(db, detail.id).pass, true);

  const analyzed = analyzerService.analyzeRun(db, log, result.run.id, {
    request_id: randomUUID(), expected_version: result.run.version,
  }, { fps: 30 });
  assert.equal(analyzed.run.shots.every((shot) => shot.status === 'analyzed'), true);
  db.close();
});

test('independent run compatibility ids cannot collide with legacy run keys', () => {
  const { db, project } = setup();
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at)
    VALUES (1, 1, 1, '旧分集', ?, ?)`)
    .run(now, now);
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, storyboard_number, title, duration, created_at, updated_at)
    VALUES (1, 1, 1, '旧分镜', 6, ?, ?)`)
    .run(now, now);
  const legacy = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, episode_id: 1,
    storyboard_ids: [1], quality_tier: 'balanced',
  }).run;
  assert.equal(legacy.episode_id, 1);
  assert.equal(legacy.run_number, 1);

  const episode = episodeService.create(db, log, project.id, {
    request_id: randomUUID(), title: '独立纸片分集',
  }).episode;
  assert.equal(episode.id, 1);
  const paper = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '独立纸片分镜', description: '独立纸片场景', action: '角色进入画面',
  }).storyboard;
  const independent = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id,
    paper_episode_id: episode.id, paper_storyboard_ids: [paper.id],
    expected_paper_storyboard_revisions: { [paper.id]: paper.current_revision_id },
  }).run;

  assert.equal(independent.paper_episode_id, episode.id);
  assert.equal(independent.episode_id, -episode.id);
  assert.equal(independent.run_number, 1);
  assert.equal(independent.shots[0].storyboard_id, -paper.id);
  assert.equal(independent.shots[0].paper_storyboard_id, paper.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_studio_runs').get().count, 2);
  db.close();
});

test('legacy synchronization is explicit and targets the confirmed legacy episode', () => {
  const { db, project } = setup();
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at)
    VALUES (10, 1, 1, '旧工作台第一集', ?, ?)`).run(now, now);
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '纸片独立第一集' }).episode;
  const paper = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '独立镜头', description: '纸片场景', action: '角色跨过门槛', dialogue: '走吧', duration: 7,
  }).storyboard;
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storyboards').get().count, 0);
  assert.throws(
    () => legacySyncService.sync(db, log, paper.id, {
      request_id: randomUUID(), expected_version: paper.version, legacy_episode_id: 10, confirmed: false,
    }),
    (error) => error.code === 'PAPER_STUDIO_SCHEMA_INVALID',
  );
  const synced = legacySyncService.sync(db, log, paper.id, {
    request_id: randomUUID(), expected_version: paper.version, legacy_episode_id: 10, confirmed: true,
  });
  assert.equal(synced.created, true);
  assert.equal(synced.legacy_storyboard.episode_id, 10);
  assert.equal(synced.legacy_storyboard.title, '独立镜头');
  assert.equal(synced.storyboard.legacy_storyboard_id, synced.legacy_storyboard.id);
  db.close();
});

test('paper episode merge refuses incomplete published videos', () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '待合并分集' }).episode;
  storyboardService.create(db, log, episode.id, { request_id: randomUUID(), title: '还没有正式视频' });
  assert.throws(
    () => episodeMergeService.create(db, {}, log, episode.id, {
      request_id: randomUUID(), expected_version: episodeService.get(db, episode.id).version,
    }),
    (error) => error.code === 'PAPER_EPISODE_VIDEOS_INCOMPLETE',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM video_merges').get().count, 0);
  db.close();
});

test('delivery board presents the real next step for an unstarted environment shot', () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '环境镜头分集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '漳河寒雾', description: '漳河两岸被寒雾覆盖',
    action: '', environment_only: true, duration: 10,
  }).storyboard;
  db.prepare("UPDATE paper_storyboards SET audio_mode = 'silent', audio_status = 'ready' WHERE id = ?").run(storyboard.id);
  const board = episodeMergeService.deliveryBoard(db, {}, episode.id);
  assert.equal(board.items[0].production_status, 'not_started');
  assert.equal(board.items[0].environment_only, true);
  assert.deepEqual(board.items[0].blockers, [{ key: 'production', label: '开始制作环境视频' }]);
  db.close();
});

test('editing a published paper storyboard invalidates its current video and episode merge only when the frozen revision changes', () => {
  const { db, project } = setup();
  const now = '2026-07-26T01:00:00.000Z';
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '已发布纸片分集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '已发布分镜', description: '初始画面', action: '主体向前移动', duration: 6,
  }).storyboard;
  const videoId = Number(db.prepare(`INSERT INTO video_generations
    (drama_id,storyboard_id,provider,model,duration,aspect_ratio,video_url,local_path,status,generation_kind,created_at,updated_at,completed_at)
    VALUES (1,?,'local-remotion','paper-studio-v3',6,'16:9','/static/paper/final.mp4','paper/final.mp4','completed','paper_studio',?,?,?)`)
    .run(-storyboard.id, now, now, now).lastInsertRowid);
  db.prepare("UPDATE paper_storyboards SET published_video_generation_id = ?, status = 'published' WHERE id = ?").run(videoId, storyboard.id);
  const mergeId = Number(db.prepare(`INSERT INTO video_merges
    (episode_id,paper_episode_id,drama_id,title,provider,status,scenes,merged_url,created_at,completed_at)
    VALUES (?,?,1,'旧整集','ffmpeg','completed','[]','paper/episode.mp4',?,?)`)
    .run(-episode.id, episode.id, now, now).lastInsertRowid);

  const unchanged = storyboardService.update(db, log, storyboard.id, {
    request_id: randomUUID(), expected_version: storyboardService.get(db, storyboard.id).version, title: storyboard.title,
  });
  assert.equal(unchanged.published_video_generation_id, videoId);
  assert.equal(db.prepare('SELECT status FROM video_merges WHERE id = ?').get(mergeId).status, 'completed');

  const changed = storyboardService.update(db, log, storyboard.id, {
    request_id: randomUUID(), expected_version: unchanged.version, action: '主体转身并离开画面',
  });
  assert.equal(changed.published_video_generation_id, null);
  assert.equal(changed.status, 'draft');
  assert.equal(db.prepare('SELECT status FROM video_merges WHERE id = ?').get(mergeId).status, 'stale');
  assert.equal(episodeService.get(db, episode.id).published_storyboard_count, 0);
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = ?').get(videoId).status, 'completed');
  assert.throws(
    () => episodeMergeService.create(db, {}, log, episode.id, {
      request_id: randomUUID(), expected_version: episodeService.get(db, episode.id).version,
    }),
    (error) => error.code === 'PAPER_EPISODE_VIDEOS_INCOMPLETE',
  );
  db.close();
});

test('paper merge records remain paper-scoped when processing fails', async () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '合并隔离测试' }).episode;
  const created = videoMergeService.createPaper(db, log, {
    paper_episode_id: episode.id, drama_id: 1, title: '纸片整集', scenes: [{ video_url: '/missing-paper-video.mp4' }],
  });
  assert.equal(created.paper_episode_id, episode.id);
  await videoMergeService.processVideoMerge(db, log, created.merge_id, 'http://localhost:5679/static');
  assert.equal(videoMergeService.getById(db, created.merge_id).status, 'failed');
  assert.equal(episodeService.get(db, episode.id).status, 'merge_failed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM episodes').get().count, 0);
  db.close();
});

test('independent paper episodes, revisions and runs survive archive import', () => {
  const { db, project } = setup();
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '可归档纸片集' }).episode;
  const paper = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '归档分镜', description: '独立纸片源', action: '角色转身', duration: 5,
  }).storyboard;
  runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id, paper_storyboard_ids: [paper.id],
    expected_paper_storyboard_revisions: { [paper.id]: paper.current_revision_id },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-independent-archive-'));
  const cfg = { storage: { local_path: root } };
  const zip = { addFile() {} };
  const manifest = archiveService.exportToZip(db, cfg, log, 1, zip);
  assert.equal(manifest.paper_episodes.length, 1);
  assert.equal(manifest.paper_episodes[0].storyboards[0].revisions.length, 1);

  const target = new Database(':memory:');
  runMigrationsAndEnsure(target);
  const now = '2026-07-26T00:00:00.000Z';
  target.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (2, ?, ?, ?)').run('导入目标', now, now);
  const imported = archiveService.importFromManifest(target, cfg, log, {
    manifest, files: new Map(), drama_id: 2, episode_id_map: new Map(), storyboard_id_map: new Map(),
    drama_row: target.prepare('SELECT * FROM dramas WHERE id = 2').get(),
  });
  assert.equal(imported.paper_episodes, 1);
  assert.equal(imported.paper_storyboards, 1);
  assert.equal(imported.runs, 1);
  const importedRun = target.prepare('SELECT * FROM paper_studio_runs WHERE project_id = ?').get(imported.project_id);
  assert.equal(importedRun.paper_episode_id > 0, true);
  const importedShot = target.prepare('SELECT * FROM paper_studio_shots WHERE run_id = ?').get(importedRun.id);
  assert.equal(importedShot.source_kind, 'paper');
  assert.equal(importedShot.paper_storyboard_revision_id > 0, true);
  target.close();
  db.close();
});
