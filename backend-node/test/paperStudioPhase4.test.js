const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const advanceService = require('../src/services/paper-studio/paperRunAdvanceService');
const aggregateService = require('../src/services/paper-studio/paperRunAggregateService');
const recoveryService = require('../src/services/paper-studio/paperStudioRecoveryService');
const { CURRENT_PLANNER_VERSION } = require('../src/services/paper-studio/paperStudioPlannerVersion');
const providerService = require('../src/services/paper-studio/paperProviderCapabilityService');
const reportService = require('../src/services/paper-studio/paperRunReportService');
const orchestratorService = require('../src/services/paper-studio/paperOrchestratorService');
const sourceRevisionService = require('../src/services/paper-studio/paperSourceRevisionService');
const authorizationService = require('../src/services/paper-studio/paperGenerationAuthorizationService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'四镜纸片测试',?,?)").run(now, now);
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (10,1,1,'第一集',?,?)").run(now, now);
  db.prepare("INSERT INTO characters (id,drama_id,name,appearance,created_at,updated_at) VALUES (1,1,'测试主体','黑色纸片剪影',?,?)").run(now, now);
  const insert = db.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,title,description,action,characters,duration,created_at,updated_at) VALUES (?,10,?,?,?,?,?,4,?,?)");
  [101, 102, 103, 104].forEach((id, index) => insert.run(id, index + 1, `镜头${index + 1}`, `独立主体动作${index + 1}`, `主体完成动作${index + 1}`, '[1]', now, now));
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,is_default,is_active,settings,created_at,updated_at) VALUES (1,'image','openai','openai','GPT Image','https://example.invalid','test-key','[\"gpt-image-2\"]','gpt-image-2',1,1,'{}',?,?)").run(now, now);
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,is_default,is_active,settings,created_at,updated_at) VALUES (2,'image','custom','openai','纯文本图片模型','https://example.invalid','test-key','[\"plain-image-v1\"]','plain-image-v1',0,1,'{}',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const run = runService.create(db, log, { request_id: randomUUID(), project_id: project.id, episode_id: 10, storyboard_ids: [101, 102, 103, 104], image_provider_config_id: 1 }).run;
  return { db, run };
}

test('provider capability catalog exposes explicit production warnings without leaking credentials', () => {
  const { db } = setup();
  const providers = providerService.list(db);
  assert.equal(providers.length, 2);
  assert.equal(providers[0].capabilities.reference_images, true);
  assert.equal(providers[0].capabilities.transparent_background, true);
  assert.equal(providers[1].capabilities.reference_images, false);
  assert.ok(providers[1].warnings.some((item) => item.code === 'REFERENCE_IMAGES_UNSUPPORTED'));
  assert.equal(Object.hasOwn(providers[0], 'api_key'), false);
  db.close();
});

test('batch advance analyzes and confirms all four shots as one recoverable stage at a time', async () => {
  const { db, run } = setup();
  const analyzed = await advanceService.advance(db, { paper_studio: { fps: 30 } }, log, run.id, { request_id: randomUUID(), expected_version: run.version });
  assert.equal(analyzed.stage, 'analyze');
  assert.equal(analyzed.run.status, 'plan_review');
  assert.ok(analyzed.run.shots.every((shot) => shot.status === 'analyzed'));
  assert.ok(analyzed.run.shots.every((shot) => shot.plan_summary_json.planner_version === CURRENT_PLANNER_VERSION));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_job_steps WHERE run_id = ?').get(run.id).count, 60);

  const confirmed = await advanceService.advance(db, {}, log, run.id, { request_id: randomUUID(), expected_version: analyzed.run.version });
  assert.equal(confirmed.stage, 'confirm_plan');
  assert.equal(confirmed.run.status, 'awaiting_generation_authorization');
  assert.ok(confirmed.run.shots.every((shot) => shot.status === 'plan_confirmed'));
  db.close();
});

test('run aggregation reports the earliest unfinished stage and never lets one shot advance the whole run', () => {
  const { db, run } = setup();
  db.prepare("UPDATE paper_studio_shots SET status = CASE WHEN shot_index < 2 THEN 'asset_ready' ELSE 'plan_confirmed' END WHERE run_id = ?").run(run.id);
  let aggregate = aggregateService.sync(db, run.id);
  assert.equal(aggregate.status, 'awaiting_generation_authorization');
  assert.equal(runService.get(db, run.id).progress, 29);

  const failedId = db.prepare('SELECT id FROM paper_studio_shots WHERE run_id = ? ORDER BY shot_index LIMIT 1').get(run.id).id;
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_failed', last_error_json = '{\"code\":\"QUOTA\"}' WHERE id = ?").run(failedId);
  aggregate = aggregateService.sync(db, run.id);
  assert.equal(aggregate.status, 'partial');
  assert.equal(runService.get(db, run.id).last_error_json.code, 'QUOTA');
  db.close();
});

test('startup recovery blocks an unknown paid provider attempt instead of silently charging again', async () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, { request_id: randomUUID(), expected_version: analyzed.version }).run;
  const shot = confirmed.shots[0];
  const slot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas JOIN paper_source_families psf ON psf.id = pas.family_id WHERE psf.shot_id = ? AND pas.required_for_gate = 1 ORDER BY pas.id LIMIT 1`).get(shot.id);
  const version = db.prepare("INSERT INTO paper_asset_versions (slot_id,source_family_id,attempt_index,derivation_kind,status,created_at) VALUES (?,?,1,'image_api','candidate',?)").run(slot.id, slot.family_id, '2026-07-24T00:01:00.000Z').lastInsertRowid;
  db.prepare("INSERT INTO image_generations (storyboard_id,drama_id,status,generation_kind,paper_asset_version_id,created_at,updated_at) VALUES (101,1,'processing','paper_studio_asset',?,?,?)").run(version, '2026-07-24T00:01:00.000Z', '2026-07-24T00:01:00.000Z');
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_pending' WHERE id = ?").run(shot.id);
  db.prepare("UPDATE paper_job_steps SET status = 'running', lease_owner = 'dead-worker', lease_expires_at = '2026-07-24T00:00:00.000Z' WHERE shot_id = ? AND step_key = 'generate_required_slots'").run(shot.id);

  const report = recoveryService.recoverOnStartup(db, log);
  assert.equal(report.blocked, 1);
  assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE shot_id = ? AND step_key = 'generate_required_slots'").get(shot.id).status, 'blocked_unknown');
  assert.equal(db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(shot.id).status, 'asset_failed');
  assert.equal(runService.get(db, run.id).status, 'partial');
  db.close();
});

test('startup recovery supersedes orphan preview rows and requeues deterministic local render even after retry count', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, { request_id: randomUUID(), expected_version: analyzed.version }).run;
  const shot = confirmed.shots[0];
  const now = '2026-07-24T00:01:00.000Z';
  const hash = `sha256:${'a'.repeat(64)}`;
  const snapshotId = db.prepare(`INSERT INTO paper_render_snapshots
    (shot_id,schema_version,renderer_version,source_revision_hash,snapshot_json,snapshot_hash,render_hash,status,created_at)
    VALUES (?,3,'paper-studio-v3',?,'{}',?,?,'compiled',?)`)
    .run(shot.id, shot.source_revision_hash, hash, hash, now).lastInsertRowid;
  db.prepare("UPDATE paper_studio_shots SET status = 'proof_ready', current_snapshot_id = ? WHERE id = ?")
    .run(snapshotId, shot.id);
  db.prepare("UPDATE paper_job_steps SET status = 'failed_terminal', attempt = 7, max_attempts = 2, error_json = '{\"code\":\"OLD_RESTART\"}' WHERE shot_id = ? AND step_key = 'render_preview'")
    .run(shot.id);
  const proofRunId = db.prepare(`INSERT INTO paper_proof_runs
    (shot_id,snapshot_id,run_kind,scale,status,report_json,created_at)
    VALUES (?,?,'preview',0.5,'running','{}',?)`).run(shot.id, snapshotId, now).lastInsertRowid;

  const report = recoveryService.recoverOnStartup(db, log);
  assert.equal(report.orphan_proof_runs, 1);
  assert.ok(report.requeued >= 1);
  assert.equal(db.prepare('SELECT status FROM paper_proof_runs WHERE id = ?').get(proofRunId).status, 'superseded');
  const step = db.prepare("SELECT status, attempt, error_json FROM paper_job_steps WHERE shot_id = ? AND step_key = 'render_preview'").get(shot.id);
  assert.equal(step.status, 'queued');
  assert.equal(Number(step.attempt), 8);
  assert.equal(step.error_json, '{}');
  db.close();
});

test('startup recovery stops old scene-shaped plans and requires a new generic run', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 }).run;
  for (const shot of analyzed.shots) {
    db.prepare('UPDATE paper_studio_shots SET plan_summary_json = ? WHERE id = ?').run(JSON.stringify({ ...shot.plan_summary_json, planner_version: CURRENT_PLANNER_VERSION - 1 }), Number(shot.id));
  }

  const report = recoveryService.recoverOnStartup(db, log);
  assert.equal(report.stale_plans, 4);
  assert.equal(runService.get(db, run.id).status, 'stale');
  assert.ok(runService.get(db, run.id).shots.every((shot) => shot.status === 'stale'));
  assert.equal(runService.get(db, run.id).last_error_json.code, 'PAPER_STUDIO_PLAN_VERSION_STALE');
  db.close();
});

test('generation quote rejects an old planner version before image authorization', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  }).run;
  const shot = confirmed.shots[0];
  db.prepare('UPDATE paper_studio_shots SET plan_summary_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...shot.plan_summary_json, planner_version: CURRENT_PLANNER_VERSION - 1 }), Number(shot.id));
  assert.throws(
    () => authorizationService.buildQuote(db, confirmed.id, {
      request_id: randomUUID(), expected_version: confirmed.version,
    }),
    (error) => error.code === 'PAPER_STUDIO_PLAN_VERSION_STALE'
      && error.details.expected_planner_version === CURRENT_PLANNER_VERSION,
  );
  db.close();
});

test('run report is stable, complete and redacts credentials from nested production evidence', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(),
    expected_version: run.version,
  }, { fps: 30 }).run;
  const shot = analyzed.shots[0];
  const now = '2026-07-24T00:10:00.000Z';
  const slot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas
    JOIN paper_source_families psf ON psf.id = pas.family_id
    WHERE psf.shot_id = ? ORDER BY pas.id LIMIT 1`).get(shot.id);
  const assetVersionId = db.prepare(`INSERT INTO paper_asset_versions
    (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,source_hash,provenance_json,status,created_at,accepted_at)
    VALUES (?,?,1,'image_api','paper-studio/test.png',?,?, 'accepted',?,?)`)
    .run(slot.id, slot.family_id, `sha256:${'a'.repeat(64)}`, JSON.stringify({
      api_key: 'nested-production-secret',
      request_url: 'https://image.example/v1?token=also-secret',
      authorization: 'Bearer provider-secret',
    }), now, now).lastInsertRowid;
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(assetVersionId, slot.id);
  db.prepare(`INSERT INTO image_generations
    (storyboard_id,drama_id,provider,model,status,generation_kind,generation_purpose,paper_asset_version_id,created_at,updated_at,completed_at)
    VALUES (101,1,'openai','gpt-image-2','completed','paper_studio_asset','clean_plate',?,?,?,?)`)
    .run(assetVersionId, now, now, now);

  const motionPlanId = db.prepare('SELECT id FROM paper_motion_plans WHERE shot_id = ?').get(shot.id).id;
  db.prepare(`INSERT INTO paper_motion_revisions
    (shot_id,motion_plan_id,request_id,instruction,intent_json,before_hash,after_hash,patch_json,gate_report_json,status,created_at)
    VALUES (?,?,?,'主体动作快一点','{}',?,?,'{}','{"pass":true}','applied',?)`)
    .run(shot.id, motionPlanId, randomUUID(), `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, now);
  db.prepare(`INSERT INTO paper_continuity_contracts
    (run_id,source_shot_id,target_shot_id,continuity_key,subject_signature,contract_json,report_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'{"type":"subject_identity_handoff"}','{"pass":true}','satisfied',?,?)`)
    .run(run.id, analyzed.shots[0].id, analyzed.shots[1].id, 'fixture_identity', 'generic-subject', now, now);

  const renderHash = `sha256:${'d'.repeat(64)}`;
  const snapshotId = db.prepare(`INSERT INTO paper_render_snapshots
    (shot_id,schema_version,renderer_version,source_revision_hash,snapshot_json,snapshot_hash,render_hash,local_path,status,approved_at,created_at)
    VALUES (?,3,'paper-studio-v3',?,'{}',?,?,?,'approved',?,?)`)
    .run(shot.id, shot.source_revision_hash, renderHash, renderHash, 'paper-studio/snapshot.json', now, now).lastInsertRowid;
  const proofRunId = db.prepare(`INSERT INTO paper_proof_runs
    (shot_id,snapshot_id,run_kind,scale,status,preview_local_path,report_json,proof_hash,created_at,completed_at)
    VALUES (?,?,'motion_gate',0.5,'passed','paper-studio/proof.mp4','{"pass":true}',?,?,?)`)
    .run(shot.id, snapshotId, `sha256:${'e'.repeat(64)}`, now, now).lastInsertRowid;
  db.prepare(`INSERT INTO paper_proof_evidence
    (proof_run_id,target_key,frame,full_local_path,metrics_json,assertion_json,status,created_at)
    VALUES (?,'primary_subject',30,'paper-studio/frame-30.png','{"pixel_delta":0.3}','[{"pass":true}]','generated',?)`)
    .run(proofRunId, now);
  db.prepare(`INSERT INTO video_generations
    (drama_id,storyboard_id,provider,model,duration,video_url,local_path,status,generation_kind,render_hash,renderer_version,paper_studio_shot_id,paper_snapshot_id,created_at,updated_at,completed_at)
    VALUES (1,101,'local','remotion',4,'/static/paper-studio/final.mp4','paper-studio/final.mp4','completed','paper_studio_v3',?,'paper-studio-v3',?,?,?, ?,?)`)
    .run(renderHash, shot.id, snapshotId, now, now, now);

  const first = reportService.build(db, run.id);
  const second = reportService.build(db, run.id);
  assert.equal(first.report_hash, second.report_hash);
  assert.equal(first.summary.image_attempt_statuses.completed, 1);
  assert.equal(first.summary.asset_version_statuses.accepted, 1);
  assert.equal(first.summary.continuity_statuses.satisfied, 1);
  assert.equal(first.motion_revisions.length, 1);
  assert.equal(first.proof_runs.length, 1);
  assert.equal(first.proof_evidence.length, 1);
  assert.equal(first.summary.published_video_count, 1);
  const serialized = JSON.stringify(first);
  for (const secret of ['test-key', 'nested-production-secret', 'also-secret', 'provider-secret']) {
    assert.equal(serialized.includes(secret), false, `run report leaked credential: ${secret}`);
  }
  assert.ok(serialized.includes('[REDACTED]'));
  db.close();
});

test('persistent orchestrator claims one dependency-ready step with an exclusive lease', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(),
    expected_version: run.version,
  }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, {
    request_id: randomUUID(),
    expected_version: analyzed.version,
  }).run;
  const quote = authorizationService.buildQuote(db, run.id, {
    request_id: randomUUID(), expected_version: confirmed.version, shot_ids: [confirmed.shots[0].id],
  });
  const authorization = authorizationService.authorize(db, log, run.id, {
    request_id: randomUUID(), expected_version: confirmed.version, quote_fingerprint: quote.quote_fingerprint,
    confirmed: true, shot_ids: [confirmed.shots[0].id],
  }).authorization;
  authorizationService.execute(db, log, authorization.id, {
    request_id: randomUUID(), expected_version: authorization.version,
  });
  const shot = confirmed.shots[0];
  const first = db.prepare("SELECT * FROM paper_job_steps WHERE shot_id = ? AND step_key = 'generate_layout_master'").get(shot.id);
  const downstream = db.prepare("SELECT * FROM paper_job_steps WHERE shot_id = ? AND step_key = 'generate_required_slots'").get(shot.id);

  assert.equal(orchestratorService.dependenciesCompleted(db, first), true);
  assert.equal(orchestratorService.dependenciesCompleted(db, downstream), false);
  const lease = orchestratorService.claim(db, first.id, 'worker-a', 60_000);
  assert.equal(lease.lease_owner, 'worker-a');
  assert.equal(orchestratorService.claim(db, first.id, 'worker-b', 60_000), null);
  const stored = db.prepare('SELECT status, lease_owner, lease_expires_at FROM paper_job_steps WHERE id = ?').get(first.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.lease_owner, 'worker-a');
  assert.ok(Date.parse(stored.lease_expires_at) > Date.now());
  assert.equal(orchestratorService.claim(db, downstream.id, 'worker-b', 60_000), null);
  db.close();
});

test('lazy source revision gate marks the historical run stale before any expensive step', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(),
    expected_version: run.version,
  }, { fps: 30 }).run;
  const shot = analyzed.shots[0];
  db.prepare("UPDATE storyboards SET action = '源分镜动作已修改', updated_at = ? WHERE id = ?")
    .run('2026-07-24T00:20:00.000Z', shot.storyboard_id);
  assert.throws(
    () => sourceRevisionService.assertShotCurrent(db, shot.id),
    (error) => error.code === 'PAPER_STUDIO_SOURCE_STALE',
  );
  assert.equal(db.prepare('SELECT status FROM paper_studio_shots WHERE id = ?').get(shot.id).status, 'stale');
  assert.equal(runService.get(db, run.id).status, 'stale');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_job_steps WHERE shot_id = ? AND status = 'running'").get(shot.id).count, 0);
  db.close();
});
