const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const authorizationService = require('../src/services/paper-studio/paperGenerationAuthorizationService');
const motionGateService = require('../src/services/paper-studio/paperMotionGateService');
const doctorService = require('../src/services/paper-studio/paperStudioDoctorService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup(storyboardOverrides = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'蓝图验收',?,?)").run(now, now);
  db.prepare(`INSERT INTO ai_service_configs
    (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
    VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '纸片第一集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: '抵达候车区',
    description: '旧车站候车区全景，画面右侧有一张长椅',
    action: '人物提起行李箱，从左走到右侧长椅并坐下',
    duration: 6,
    ...storyboardOverrides,
  }).storyboard;
  const run = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
    paper_storyboard_ids: [storyboard.id],
    expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
    image_provider_config_id: 1,
  }).run;
  return { db, project, episode, storyboard, run };
}

function range(track) {
  const values = track.keyframes.map((keyframe) => Number(keyframe.value));
  return Math.max(...values) - Math.min(...values);
}

test('migration 35 creates versioned blueprint, entity and action-contract storage', () => {
  const { db } = setup();
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  assert.equal(tables.has('paper_blueprint_revisions'), true);
  assert.equal(tables.has('paper_storyboard_entities'), true);
  assert.equal(tables.has('paper_action_contracts'), true);
  const shotColumns = new Set(db.prepare('PRAGMA table_info(paper_studio_shots)').all().map((row) => row.name));
  assert.equal(shotColumns.has('blueprint_revision_id'), true);
  assert.equal(shotColumns.has('action_contract_id'), true);
  assert.equal(doctorService.REQUIRED_TABLES.includes('paper_blueprint_revisions'), true);
  assert.equal(doctorService.REQUIRED_TABLES.includes('paper_storyboard_entities'), true);
  assert.equal(doctorService.REQUIRED_TABLES.includes('paper_action_contracts'), true);
  db.close();
});

test('independent paper text compiles person, luggage and support into a real compound plan', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 });
  assert.equal(analyzed.analyzed[0].catalog_key, 'compound-carry-move-sit-v1');
  const shot = shotService.get(db, analyzed.run.shots[0].id);
  assert.equal(shot.plan_summary_json.primary_action, 'carry_move_sit');
  assert.notEqual(shot.plan_summary_json.primary_action, 'subject_settle');
  assert.equal(shot.blueprint.revision_number, 1);
  assert.deepEqual(
    shot.blueprint.blueprint_json.entities.map((entity) => [entity.key, entity.type, entity.name]),
    [
      ['actor_1', 'character', '人物'],
      ['prop_1', 'prop', '行李箱'],
      ['support_1', 'environment_anchor', '长椅'],
    ],
  );
  assert.equal(shot.blueprint.blueprint_json.action_contract.primary_action, 'carry_move_sit');
  assert.ok(shot.blueprint.blueprint_json.relations.some((relation) => relation.predicate === 'holds'));
  assert.ok(shot.blueprint.blueprint_json.relations.some((relation) => relation.predicate === 'released_beside'));
  assert.deepEqual(shot.families.map((family) => family.family_key), ['clean_environment', 'actor_family', 'prop_family']);
  assert.ok(shot.composition_nodes.some((node) => node.node_key === 'actor_1'));
  assert.ok(shot.composition_nodes.some((node) => node.node_key === 'prop_1'));
  assert.ok(shot.composition_nodes.some((node) => node.node_key === 'support_front'));
  const actorX = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'actor_1' && track.property === 'x');
  const propX = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'x');
  const actorState = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'actor_1' && track.property === 'state');
  const propState = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'state');
  assert.equal(range(actorX) >= 0.45, true);
  assert.equal(range(propX) >= 0.42, true);
  assert.ok(actorState.keyframes.some((keyframe) => keyframe.value === 'seated'));
  assert.equal(propState.keyframes.at(-1).value, 'released');
  assert.ok(shot.motion_plan.plan_json.cues.some((cue) => cue.key === 'release_prop'));
  assert.equal(motionGateService.evaluate(shot.motion_plan.plan_json, shot.plan_summary_json).pass, true);
  assert.equal(shot.blueprint.blueprint_json.generation_slots.filter((slot) => slot.source === 'image_api').length, 5);
  assert.equal(shot.blueprint.blueprint_json.generation_slots.some((slot) => slot.slot_key === 'support_front_mask' && slot.source === 'local_derivation'), true);
  db.close();
});

test('directed carry and release keeps the prop as an independent generated layer without inventing an action-word support', () => {
  const { db, run } = setup({
    title: '走到画面右侧',
    description: '人物站在画面左侧，右侧留出移动空间',
    action: '人物提起道具箱，从画面左侧走到右侧停下，再将道具箱放到地面',
  });
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 });
  const shot = shotService.get(db, analyzed.run.shots[0].id);
  const blueprint = shot.blueprint.blueprint_json;
  assert.equal(blueprint.action_contract.primary_action, 'directed_move');
  assert.equal(blueprint.action_contract.support_key, null);
  assert.equal(blueprint.entities.some((entity) => entity.type === 'environment_anchor' && /停下/.test(entity.name)), false);
  assert.equal(blueprint.entities.some((entity) => entity.key === 'prop_1' && entity.independent_layer), true);
  assert.equal(blueprint.generation_slots.some((slot) => slot.family_key === 'prop_family' && slot.slot_key === 'prop_cutout' && slot.source === 'image_api'), true);
  assert.ok(shot.families.some((family) => family.family_key === 'prop_family'));
  assert.ok(shot.composition_nodes.some((node) => node.node_key === 'prop_1'));
  const propX = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'x');
  const propState = shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'state');
  assert.equal(range(propX) >= 0.42, true);
  assert.equal(propState.keyframes.at(-1).value, 'released');
  assert.ok(shot.motion_plan.plan_json.cues.some((cue) => cue.key === 'release_prop'));
  assert.equal(motionGateService.evaluate(shot.motion_plan.plan_json, shot.plan_summary_json).pass, true);
  db.close();
});

test('editing a confirmed blueprint recompiles the graph and expires the old image authorization', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, run.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  }).run;
  const quote = authorizationService.buildQuote(db, run.id, {
    request_id: randomUUID(), expected_version: confirmed.version,
  });
  const authorization = authorizationService.authorize(db, log, run.id, {
    request_id: randomUUID(), expected_version: confirmed.version,
    quote_fingerprint: quote.quote_fingerprint, confirmed: true,
  }).authorization;
  const before = shotService.get(db, confirmed.shots[0].id);
  const edited = structuredClone(before.blueprint.blueprint_json);
  edited.entities.find((entity) => entity.key === 'actor_1').name = '红衣女孩';
  edited.action_contract.waypoints.at(-1).x = 0.42;
  const updated = analyzerService.updateBlueprint(db, log, before.id, {
    request_id: randomUUID(), expected_version: before.version, blueprint: edited,
  }, { fps: 30 });
  assert.equal(updated.run.status, 'plan_review');
  assert.equal(updated.run.attention_required, 'review_blueprint');
  assert.equal(authorizationService.get(db, authorization.id).status, 'expired');
  const after = shotService.get(db, before.id);
  assert.equal(after.status, 'analyzed');
  assert.equal(after.blueprint.revision_number, 2);
  assert.equal(after.blueprint.created_from, 'user_edit');
  assert.equal(after.blueprint.blueprint_json.entities.find((entity) => entity.key === 'actor_1').name, '红衣女孩');
  assert.equal(after.semantic_contract_json.subjects.find((subject) => subject.key === 'actor_1').identity, '红衣女孩');
  const actorX = after.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'actor_1' && track.property === 'x');
  assert.equal(range(actorX) >= 0.7, true);
  assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE shot_id = ? AND step_key = 'generate_layout_master'").get(after.id).status, 'blocked_user_authorization');
  const reconfirmed = analyzerService.confirmBlueprint(db, log, after.id, {
    request_id: randomUUID(), expected_version: after.version,
  });
  assert.equal(reconfirmed.run.status, 'awaiting_generation_authorization');
  assert.equal(analyzerService.getBlueprint(db, after.id).status, 'confirmed');
  db.close();
});

test('blueprint updates reject dangling entity relationships before replacing the compiled plan', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  const shot = shotService.get(db, analyzed.shots[0].id);
  const invalid = structuredClone(shot.blueprint.blueprint_json);
  invalid.relations[0].object_key = 'missing_prop';
  assert.throws(
    () => analyzerService.updateBlueprint(db, log, shot.id, {
      request_id: randomUUID(), expected_version: shot.version, blueprint: invalid,
    }, { fps: 30 }),
    (error) => error.code === 'PAPER_STUDIO_BLUEPRINT_RELATION_INVALID',
  );
  assert.equal(shotService.get(db, shot.id).blueprint.revision_number, 1);
  db.close();
});

test('restoring an earlier identical blueprint makes that revision confirmable again', () => {
  const { db, run } = setup();
  const analyzed = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  const originalShot = shotService.get(db, analyzed.shots[0].id);
  const originalBlueprint = structuredClone(originalShot.blueprint.blueprint_json);
  const edited = structuredClone(originalBlueprint);
  edited.entities.find((entity) => entity.key === 'actor_1').name = '红衣女孩';
  const firstUpdate = analyzerService.updateBlueprint(db, log, originalShot.id, {
    request_id: randomUUID(), expected_version: originalShot.version, blueprint: edited,
  }, { fps: 30 });
  const editedShot = shotService.get(db, originalShot.id);
  assert.equal(editedShot.blueprint.revision_number, 2);
  const restored = analyzerService.updateBlueprint(db, log, originalShot.id, {
    request_id: randomUUID(), expected_version: editedShot.version, blueprint: originalBlueprint,
  }, { fps: 30 });
  const restoredShot = shotService.get(db, originalShot.id);
  assert.equal(restoredShot.blueprint.revision_number, 1);
  assert.equal(restoredShot.blueprint.status, 'draft');
  assert.equal(restoredShot.blueprint.created_from, 'restored');
  assert.equal(restoredShot.blueprint.confirmed_at, null);
  assert.equal(restoredShot.blueprint.superseded_at, null);
  assert.equal(restoredShot.blueprint.action_contract.status, 'draft');
  assert.equal(restoredShot.status, 'analyzed');
  assert.equal(restored.run.status, 'plan_review');
  const rows = db.prepare('SELECT revision_number, status FROM paper_blueprint_revisions WHERE shot_id = ? ORDER BY revision_number').all(originalShot.id);
  assert.deepEqual(rows, [
    { revision_number: 1, status: 'draft' },
    { revision_number: 2, status: 'superseded' },
  ]);
  const reconfirmed = analyzerService.confirmBlueprint(db, log, restoredShot.id, {
    request_id: randomUUID(), expected_version: restoredShot.version,
  });
  assert.deepEqual(reconfirmed.confirmed_shot_ids, [restoredShot.id]);
  assert.equal(shotService.get(db, restoredShot.id).blueprint.status, 'confirmed');
  assert.equal(firstUpdate.blueprint.shot_id, restoredShot.id);
  db.close();
});
