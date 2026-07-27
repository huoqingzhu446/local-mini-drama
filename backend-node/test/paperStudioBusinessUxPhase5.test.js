const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const taskCenterService = require('../src/services/paper-studio/paperTaskCenterService');
const productEventService = require('../src/services/paper-studio/paperProductEventService');
const exampleDraftService = require('../src/services/paper-studio/paperExampleDraftService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'Phase 5 体验闭环',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, {
    request_id: randomUUID(), title: '任务中心验收分集', fps: 30, default_duration: 4,
  }).episode;
  const storyboards = Array.from({ length: 4 }, (_, index) => storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: `分镜 ${index + 1}`,
    description: `角色位于测试场景 ${index + 1}`,
    action: `角色完成通用动作 ${index + 1}`,
    duration: 4,
  }).storyboard);
  const run = runService.create(db, log, {
    request_id: randomUUID(),
    project_id: project.id,
    paper_episode_id: episode.id,
    paper_storyboard_ids: storyboards.map((item) => item.id),
    expected_paper_storyboard_revisions: Object.fromEntries(storyboards.map((item) => [item.id, item.current_revision_id])),
  }).run;
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  return { db, project, episode, storyboards, run: analyzed };
}

test('migration 40 creates the local product-event table and query indexes', () => {
  const { db } = setup();
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_studio_product_events'").get();
    assert.equal(table.name, 'paper_studio_product_events');
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'paper_studio_product_events'").all().map((row) => row.name));
    assert.equal(indexes.has('idx_paper_product_events_project'), true);
    assert.equal(indexes.has('idx_paper_product_events_funnel'), true);
  } finally {
    db.close();
  }
});

test('task center groups the latest paper shots by attention, processing, failure and completion', () => {
  const { db, project, run } = setup();
  try {
    const statuses = ['asset_review', 'rendering', 'proof_failed', 'published'];
    run.shots.forEach((shot, index) => {
      db.prepare('UPDATE paper_studio_shots SET status = ?, updated_at = ? WHERE id = ?')
        .run(statuses[index], `2026-07-26T00:0${index}:00.000Z`, shot.id);
    });
    const center = taskCenterService.build(db, project.id);
    assert.deepEqual(center.summary, { attention: 1, processing: 1, failed: 1, completed: 1, total: 4 });
    assert.equal(center.groups.attention[0].next_action.type, 'review_assets');
    assert.ok(center.groups.attention[0].required_asset_count > 0);
    assert.ok(center.groups.attention[0].active_slot?.slot_key);
    assert.equal(center.groups.attention[0].image_api_call_count, 0);
    assert.equal(center.groups.attention[0].controls.can_pause, true);
    assert.equal(center.groups.processing[0].status, 'rendering');
    assert.equal(center.groups.failed[0].next_action.type, 'inspect_evidence');
    assert.equal(center.groups.completed[0].label, '正式视频已发布');
  } finally {
    db.close();
  }
});

test('task center includes independent storyboards that have not entered a run yet', () => {
  const { db, project } = setup();
  try {
    const episode = episodeService.create(db, log, project.id, {
      request_id: randomUUID(), title: '尚未制作的分集', fps: 30, default_duration: 4,
    }).episode;
    const storyboard = storyboardService.create(db, log, episode.id, {
      request_id: randomUUID(), title: '待补齐分镜', description: '', action: '', duration: 4,
    }).storyboard;
    const center = taskCenterService.build(db, project.id);
    const task = center.groups.attention.find((item) => item.paper_storyboard_id === storyboard.id);
    assert.ok(task);
    assert.equal(task.run_id, null);
    assert.equal(task.shot_id, null);
    assert.equal(task.status, 'authoring_incomplete');
    assert.deepEqual(task.missing_fields, ['description', 'action']);
    assert.equal(task.next_action.type, 'edit_storyboard');
    assert.equal(center.summary.total, 5);
  } finally {
    db.close();
  }
});

test('task center keeps the newest run number authoritative when an older run is touched later', () => {
  const { db, project, episode, storyboards, run: firstRun } = setup();
  try {
    const secondRun = runService.create(db, log, {
      request_id: randomUUID(),
      project_id: project.id,
      paper_episode_id: episode.id,
      paper_storyboard_ids: storyboards.map((item) => item.id),
      expected_paper_storyboard_revisions: Object.fromEntries(storyboards.map((item) => [item.id, item.current_revision_id])),
    }).run;
    db.prepare("UPDATE paper_studio_shots SET status = 'published' WHERE run_id = ?").run(secondRun.id);
    db.prepare("UPDATE paper_studio_runs SET status = 'delivered', progress = 100, updated_at = '2026-07-26T01:00:00.000Z' WHERE id = ?")
      .run(secondRun.id);
    db.prepare("UPDATE paper_studio_shots SET status = 'proof_failed' WHERE run_id = ?").run(firstRun.id);
    db.prepare("UPDATE paper_studio_runs SET status = 'failed', updated_at = '2026-07-27T01:00:00.000Z' WHERE id = ?")
      .run(firstRun.id);

    const center = taskCenterService.build(db, project.id);
    assert.deepEqual(center.summary, { attention: 0, processing: 0, failed: 0, completed: 4, total: 4 });
    assert.equal(center.groups.completed.every((item) => item.run_id === secondRun.id), true);
  } finally {
    db.close();
  }
});

test('first-run example creates four generic drafts atomically with zero production or image calls', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'空白示例项目',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  try {
    const requestId = randomUUID();
    const result = exampleDraftService.create(db, log, project.id, { request_id: requestId, confirmed: true });
    assert.equal(result.created, true);
    assert.equal(result.storyboards.length, 4);
    assert.equal(result.external_image_calls, 0);
    assert.equal(result.run_created, false);
    assert.equal(result.storyboards.some((item) => /船|水面/.test(`${item.title}${item.description}${item.action}`)), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_studio_runs').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_generation_authorizations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations').get().count, 0);
    const center = taskCenterService.build(db, project.id);
    assert.deepEqual(center.summary, { attention: 4, processing: 0, failed: 0, completed: 0, total: 4 });
    assert.equal(center.groups.attention.every((item) => item.status === 'ready_for_run' && item.run_id === null), true);

    const repeated = exampleDraftService.create(db, log, project.id, { request_id: requestId, confirmed: true });
    assert.equal(repeated.deduplicated, true);
    assert.equal(repeated.storyboards.length, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_studio_episodes').get().count, 1);
  } finally {
    db.close();
  }
});

test('task center reports executed image authorization separately from actual API assets', () => {
  const { db, project, run } = setup();
  try {
    const now = '2026-07-26T01:00:00.000Z';
    db.prepare(`INSERT INTO paper_generation_authorizations
      (run_id,request_id,source_revision_hash,quote_fingerprint,shot_scope_json,slot_scope_json,
       provider,model,estimated_image_count,max_attempts,status,version,authorized_at,executed_at,created_at,updated_at)
      VALUES (?,?,?,?, '[]','[]','openai','gpt-image-2',5,1,'consumed',1,?,?,?,?)`)
      .run(run.id, randomUUID(), run.source_revision_hash, `sha256:${'a'.repeat(64)}`, now, now, now, now);
    const slot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas
      JOIN paper_source_families psf ON psf.id = pas.family_id
      WHERE psf.shot_id = ? ORDER BY pas.id LIMIT 1`).get(run.shots[0].id);
    const first = Number(db.prepare(`INSERT INTO paper_asset_versions
      (slot_id,source_family_id,attempt_index,derivation_kind,status,created_at)
      VALUES (?,?,1,'image_api','accepted',?)`).run(slot.id, slot.family_id, now).lastInsertRowid);
    db.prepare("INSERT INTO paper_asset_versions (slot_id,source_family_id,attempt_index,derivation_kind,status,created_at) VALUES (?,?,2,'image_api','rejected',?)")
      .run(slot.id, slot.family_id, now);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(first, slot.id);

    const costs = taskCenterService.build(db, project.id).costs;
    assert.equal(costs.estimated_calls, 5);
    assert.equal(costs.max_authorized_calls, 5);
    assert.equal(costs.remaining_authorized_calls, 3);
    assert.equal(costs.generated_versions, 2);
    assert.equal(costs.accepted_versions, 1);
    assert.equal(costs.failed_versions, 1);
    assert.equal(costs.adopted_versions, 1);
    assert.equal(costs.unused_versions, 1);
    assert.equal(costs.slot_usage.length, 1);
    assert.equal(costs.authorizations[0].provider, 'openai');
  } finally {
    db.close();
  }
});

test('product events keep only approved scalar funnel context and reject invalid event names', () => {
  const { db, project, episode, storyboards, run } = setup();
  try {
    const result = productEventService.record(db, project.id, {
      paper_episode_id: episode.id,
      paper_storyboard_id: storyboards[0].id,
      run_id: run.id,
      shot_id: run.shots[0].id,
      event_name: 'task_center_opened',
      context: {
        surface: 'paper_studio', stage: 'assets', resumed: true, item_count: 4,
        prompt: 'must not persist', api_key: 'secret', media_url: '/private/file.png',
        nested: { secret: true },
      },
    });
    assert.equal(result.recorded, true);
    const row = db.prepare('SELECT * FROM paper_studio_product_events WHERE id = ?').get(result.id);
    assert.deepEqual(JSON.parse(row.context_json), {
      surface: 'paper_studio', stage: 'assets', resumed: true, item_count: 4,
    });
    assert.equal(JSON.stringify(row).includes('must not persist'), false);
    assert.equal(JSON.stringify(row).includes('secret'), false);
    assert.throws(
      () => productEventService.record(db, project.id, { event_name: 'Bad Event Name!' }),
      (error) => error.code === 'PAPER_PRODUCT_EVENT_INVALID' && error.status === 400,
    );
  } finally {
    db.close();
  }
});
