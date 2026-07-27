const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const runControlService = require('../src/services/paper-studio/paperRunControlService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare(`INSERT INTO dramas
    (id, title, active_visual_style_version_id, active_visual_style_signature, created_at, updated_at)
    VALUES (1, '沉船断路', 7, 'style:ink-paper-v1', ?, ?)`
  ).run(now, now);
  db.prepare(`INSERT INTO episodes
    (id, drama_id, episode_number, title, created_at, updated_at)
    VALUES (10, 1, 1, '第一集', ?, ?)`
  ).run(now, now);
  db.prepare(`INSERT INTO scenes
    (id, drama_id, episode_id, location, time, prompt, created_at, updated_at)
    VALUES (8, 1, 10, '漳河北岸浅滩', '寒雾清晨', '无人、无船的干净漳河背景', ?, ?)`
  ).run(now, now);
  db.prepare(`INSERT INTO props
    (id, drama_id, episode_id, name, type, description, local_path, created_at, updated_at)
    VALUES (20, 1, 10, '楚军渡河木船', '军用舟具', '秦末窄长木船', 'props/boat.png', ?, ?)`
  ).run(now, now);
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, scene_id, storyboard_number, title, description, action,
     result, duration, created_at, updated_at)
    VALUES (101, 10, 8, 1, '沉船断路', '楚军凿沉最后一艘船',
      '士卒推船，破口进水，船尾翘起并沉入河水', '只剩断桅和气泡', 10, ?, ?)`
  ).run(now, now);
  db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (101, 20)').run();
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const run = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, episode_id: 10,
    storyboard_ids: [101], quality_tier: 'balanced',
  }).run;
  return { db, project, run };
}

test('a supported subject crossing a registered boundary uses generic primitives and a recoverable DAG', () => {
  const { db, run } = setup();
  const result = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 });
  assert.equal(result.run.status, 'plan_review');
  assert.equal(result.run.progress, 10);
  assert.equal(result.run.shots[0].status, 'analyzed');
  assert.equal(result.analyzed[0].catalog_key, 'supported-boundary-transition-v1');

  const detail = shotService.get(db, result.run.shots[0].id);
  assert.equal(detail.plan_summary_json.camera_only, false);
  assert.deepEqual(detail.plan_summary_json.actor_states, ['engage', 'destabilize', 'separate']);
  assert.equal(detail.plan_summary_json.peak_rotation_degrees >= 8, true);
  assert.equal(detail.plan_summary_json.final_front_occlusion_ratio >= 0.5, true);
  assert.ok(detail.plan_summary_json.semantic_primitives.includes('supported_subject'));
  assert.ok(detail.plan_summary_json.semantic_primitives.includes('front_occlusion'));
  assert.deepEqual(detail.families.map((family) => family.family_key), [
    'registered_environment', 'supported_subject_family', 'transition_effect_family',
  ]);
  assert.equal(detail.families.find((family) => family.family_key === 'supported_subject_family').slots.length, 5);
  assert.ok(detail.composition_nodes.some((node) => node.node_key === 'boundary_front'));
  assert.equal(detail.motion_plan.plan_json.camera_only, false);
  assert.ok(detail.motion_plan.plan_json.subject_tracks.some((track) => (
    track.target === 'supported_group' && track.property === 'rotation'
      && Math.max(...track.keyframes.map((keyframe) => keyframe.value)) >= 8
  )));
  assert.equal(detail.steps.length, 15);
  assert.deepEqual(detail.steps.slice(0, 2).map((step) => step.status), ['completed', 'completed']);
  assert.ok(detail.steps.some((step) => step.step_key === 'dynamic_gate'));
  db.close();
});

test('confirm-plan freezes the analyzed graph and enforces run optimistic locking', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  assert.throws(
    () => analyzerService.confirmPlan(db, log, run.id, {
      request_id: randomUUID(), expected_version: run.version,
    }),
    (error) => error.code === 'PAPER_STUDIO_VERSION_CONFLICT' && error.status === 409,
  );
  const confirmed = analyzerService.confirmPlan(db, log, run.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  });
  assert.equal(confirmed.run.status, 'awaiting_generation_authorization');
  assert.equal(confirmed.run.attention_required, 'authorize_generation');
  assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE shot_id = ? AND step_key = 'generate_layout_master'").get(confirmed.run.shots[0].id).status, 'blocked_user_authorization');
  assert.equal(confirmed.run.shots[0].status, 'plan_confirmed');
  assert.equal(db.prepare('SELECT status FROM paper_motion_plans WHERE shot_id = ?').get(confirmed.run.shots[0].id).status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_composition_nodes WHERE shot_id = ? AND status != ?').get(confirmed.run.shots[0].id, 'confirmed').count, 0);
  db.close();
});

test('generic analyzer still requires three subject states and rejects camera-only plans', () => {
  const context = {
    storyboard: { id: 77, title: '军令落定', action: '将军放下令箭', duration: 4 },
    scene: { id: 2, prompt: '无人军帐干净背景' },
    props: [{ id: 9, name: '令箭', description: '秦末木制令箭' }],
  };
  const plan = analyzerService.buildPlan(context, { fps: 24 });
  assert.equal(plan.catalog_key, 'generic-subject-v1');
  assert.equal(plan.motionPlan.camera_only, false);
  assert.equal(plan.motionPlan.subject_tracks.filter((track) => track.target === 'primary_subject').length, 3);
  assert.deepEqual(plan.semanticContract.subjects[0].required_states, ['start', 'action', 'settle']);
});

test('run recovery requeues only retryable work and cancel is persisted', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, { request_id: randomUUID(), expected_version: analyzed.version }).run;
  const shotId = confirmed.shots[0].id;
  db.prepare("UPDATE paper_studio_shots SET status = 'asset_failed' WHERE id = ?").run(shotId);
  db.prepare("UPDATE paper_studio_runs SET status = 'partial' WHERE id = ?").run(run.id);
  db.prepare("UPDATE paper_job_steps SET status = 'failed_retryable' WHERE run_id = ? AND shot_id = ? AND step_key = 'generate_required_slots'").run(run.id, shotId);
  const recoverable = runService.get(db, run.id);
  const recovered = runControlService.recover(db, log, run.id, { request_id: randomUUID(), expected_version: recoverable.version, shot_ids: [shotId] });
  assert.equal(recovered.run.status, 'awaiting_generation_authorization');
  assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE run_id = ? AND shot_id = ? AND step_key = 'generate_layout_master'").get(run.id, shotId).status, 'blocked_user_authorization');
  assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE run_id = ? AND shot_id = ? AND step_key = 'generate_required_slots'").get(run.id, shotId).status, 'queued');
  const cancelled = runControlService.cancel(db, log, run.id, { request_id: randomUUID(), expected_version: recovered.run.version });
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.shots[0].status, 'cancelled');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_job_steps WHERE run_id = ? AND status NOT IN ('completed','cancelled')").get(run.id).count, 0);
  db.close();
});
