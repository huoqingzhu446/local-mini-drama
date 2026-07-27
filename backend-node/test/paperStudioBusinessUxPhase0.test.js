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
const authorizationService = require('../src/services/paper-studio/paperGenerationAuthorizationService');
const assetService = require('../src/services/paper-studio/paperAssetProductionService');
const runControlService = require('../src/services/paper-studio/paperRunControlService');
const orchestratorService = require('../src/services/paper-studio/paperOrchestratorService');
const recoveryService = require('../src/services/paper-studio/paperStudioRecoveryService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup({ complete = true } = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'Phase 0 验收',?,?)").run(now, now);
  db.prepare(`INSERT INTO ai_service_configs
    (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
    VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '纸片第一集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: '角色进入车站',
    description: complete ? '旧车站全景，角色位于画面左侧' : '',
    action: complete ? '角色提着行李从左走到长椅并坐下' : '',
    duration: 6,
  }).storyboard;
  return { db, project, episode, storyboard };
}

function createRun(db, project, episode, storyboard) {
  return runService.create(db, log, {
    request_id: randomUUID(),
    project_id: project.id,
    paper_episode_id: episode.id,
    paper_storyboard_ids: [storyboard.id],
    expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
    image_provider_config_id: 1,
  }).run;
}

function confirmedRun(context) {
  const draft = createRun(context.db, context.project, context.episode, context.storyboard);
  const analyzed = analyzerService.analyzeRun(context.db, log, draft.id, {
    request_id: randomUUID(), expected_version: draft.version,
  }, { fps: 30 }).run;
  return analyzerService.confirmPlan(context.db, log, draft.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  }).run;
}

test('migration 34 creates paid-generation authorization and pause gates', () => {
  const { db } = setup();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.equal(tables.has('paper_generation_authorizations'), true);
  assert.equal(tables.has('paper_studio_events'), true);
  const steps = new Set(db.prepare('PRAGMA table_info(paper_job_steps)').all().map((row) => row.name));
  assert.equal(steps.has('authorization_id'), true);
  assert.equal(steps.has('blocked_reason'), true);
  db.close();
});

test('run creation rejects an unsaved revision and an incomplete storyboard', () => {
  const complete = setup();
  assert.throws(
    () => runService.create(complete.db, log, {
      request_id: randomUUID(), project_id: complete.project.id,
      paper_episode_id: complete.episode.id, paper_storyboard_ids: [complete.storyboard.id],
      expected_paper_storyboard_revisions: { [complete.storyboard.id]: complete.storyboard.current_revision_id + 99 },
      image_provider_config_id: 1,
    }),
    (error) => error.code === 'PAPER_STUDIO_DRAFT_NOT_SAVED',
  );
  complete.db.close();

  const incomplete = setup({ complete: false });
  assert.throws(
    () => createRun(incomplete.db, incomplete.project, incomplete.episode, incomplete.storyboard),
    (error) => error.code === 'PAPER_STUDIO_STORYBOARD_INCOMPLETE'
      && error.details.storyboards[0].missing_fields.includes('description')
      && error.details.storyboards[0].missing_fields.includes('action'),
  );
  incomplete.db.close();
});

test('confirming a plan never queues or claims a paid image step', () => {
  const context = setup();
  const run = confirmedRun(context);
  assert.equal(run.status, 'awaiting_generation_authorization');
  assert.equal(run.attention_required, 'authorize_generation');
  const step = context.db.prepare("SELECT * FROM paper_job_steps WHERE run_id = ? AND step_key = 'generate_layout_master'").get(run.id);
  assert.equal(step.status, 'blocked_user_authorization');
  assert.equal(step.authorization_id, null);
  assert.equal(orchestratorService.runnableSteps(context.db).length, 0);
  assert.equal(orchestratorService.claim(context.db, step.id, 'test-worker'), null);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE generation_kind = 'paper_studio_asset'").get().count, 0);
  context.db.close();
});

test('only a matching quote and explicit authorization can release image generation', () => {
  const context = setup();
  const run = confirmedRun(context);
  const quote = authorizationService.buildQuote(context.db, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  });
  assert.equal(quote.estimated_image_count, 5);
  assert.equal(quote.provider_config_id, 1);
  assert.match(quote.quote_fingerprint, /^sha256:[0-9a-f]{64}$/);

  const authorized = authorizationService.authorize(context.db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
    quote_fingerprint: quote.quote_fingerprint, confirmed: true,
  }).authorization;
  assert.equal(authorized.status, 'authorized');
  assert.equal(orchestratorService.runnableSteps(context.db).length, 0);

  const executed = authorizationService.execute(context.db, log, authorized.id, {
    request_id: randomUUID(), expected_version: authorized.version,
  });
  assert.equal(executed.authorization.status, 'executing');
  const runnable = orchestratorService.runnableSteps(context.db);
  assert.equal(runnable.length, 1);
  assert.equal(Number(runnable[0].authorization_id), authorized.id);
  context.db.close();
});

test('direct generation without authorization is rejected and pause prevents claims', async () => {
  const context = setup();
  const run = confirmedRun(context);
  const shot = run.shots[0];
  await assert.rejects(
    () => assetService.generateAssets(context.db, {}, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version,
    }),
    (error) => error.code === 'PAPER_STUDIO_GENERATION_AUTHORIZATION_REQUIRED',
  );

  const quote = authorizationService.buildQuote(context.db, run.id, { request_id: randomUUID(), expected_version: run.version });
  const authorization = authorizationService.authorize(context.db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version, quote_fingerprint: quote.quote_fingerprint, confirmed: true,
  }).authorization;
  const executed = authorizationService.execute(context.db, log, authorization.id, {
    request_id: randomUUID(), expected_version: authorization.version,
  });
  const paused = runControlService.pause(context.db, log, run.id, {
    request_id: randomUUID(), expected_version: executed.run.version,
  }).run;
  assert.equal(paused.paused, true);
  assert.equal(orchestratorService.runnableSteps(context.db).length, 0);
  const resumed = runControlService.resume(context.db, log, run.id, {
    request_id: randomUUID(), expected_version: paused.version,
  }).run;
  assert.equal(resumed.paused, false);
  assert.equal(orchestratorService.runnableSteps(context.db).length, 1);
  context.db.close();
});

test('service restart expires an executing paid authorization instead of auto-resuming it', () => {
  const context = setup();
  const run = confirmedRun(context);
  const quote = authorizationService.buildQuote(context.db, run.id, { request_id: randomUUID(), expected_version: run.version });
  const authorization = authorizationService.authorize(context.db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version, quote_fingerprint: quote.quote_fingerprint, confirmed: true,
  }).authorization;
  authorizationService.execute(context.db, log, authorization.id, {
    request_id: randomUUID(), expected_version: authorization.version,
  });
  assert.equal(orchestratorService.runnableSteps(context.db).length, 1);
  const recovery = recoveryService.recoverOnStartup(context.db, log);
  assert.equal(recovery.interrupted_authorizations, 1);
  assert.equal(authorizationService.get(context.db, authorization.id).status, 'expired');
  const step = context.db.prepare("SELECT * FROM paper_job_steps WHERE run_id = ? AND step_key = 'generate_layout_master'").get(run.id);
  assert.equal(step.status, 'blocked_user_authorization');
  assert.equal(step.authorization_id, null);
  assert.equal(orchestratorService.runnableSteps(context.db).length, 0);
  context.db.close();
});
