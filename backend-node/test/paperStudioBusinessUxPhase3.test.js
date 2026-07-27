const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const motionGateService = require('../src/services/paper-studio/paperMotionGateService');
const renderService = require('../src/services/paper-studio/paperStudioRenderService');
const blueprintCompiler = require('../src/services/paper-studio/paperBlueprintCompilerService');
const revisionService = require('../src/services/paper-studio/paperMotionRevisionService');

function directedCarryPlan() {
  return {
    schema_version: 1,
    fps: 30,
    duration_frames: 90,
    primary_action: 'directed_move',
    camera_only: false,
    subject_tracks: [
      { target: 'actor_1', property: 'x', keyframes: [{ frame: 0, value: -0.3 }, { frame: 45, value: 0 }, { frame: 89, value: 0.3 }] },
      { target: 'actor_1', property: 'state', keyframes: [{ frame: 0, value: 'start' }, { frame: 45, value: 'moving' }, { frame: 89, value: 'arrived' }] },
      { target: 'prop_1', property: 'x', keyframes: [{ frame: 0, value: -0.33 }, { frame: 45, value: -0.03 }, { frame: 75, value: 0.38 }, { frame: 89, value: 0.38 }] },
      { target: 'prop_1', property: 'state', keyframes: [{ frame: 0, value: 'held' }, { frame: 45, value: 'carried' }, { frame: 75, value: 'released' }, { frame: 89, value: 'released' }] },
    ],
    camera_tracks: [],
    cues: [{ key: 'grip_prop', frame: 8, kind: 'contact' }, { key: 'release_prop', frame: 75, kind: 'contact' }],
    gate_requirements: [
      { key: 'subject_translation', metric: 'numeric_range', target: 'actor_1', property: 'x', min: 0.45 },
      { key: 'subject_state_progression', metric: 'distinct_states', target: 'actor_1', property: 'state', min: 3 },
      { key: 'action_object_follows_subject', metric: 'numeric_range', target: 'prop_1', property: 'x', min: 0.42 },
      { key: 'action_object_state_progression', metric: 'distinct_states', target: 'prop_1', property: 'state', min: 3 },
      { key: 'release_cue_exists', metric: 'cue_exists', cue: 'release_prop' },
    ],
  };
}

test('directed carry gate fails the exact semantic requirement instead of accepting arbitrary movement', () => {
  const valid = directedCarryPlan();
  assert.equal(motionGateService.evaluate(valid).pass, true);

  const actorDoesNotReach = structuredClone(valid);
  actorDoesNotReach.subject_tracks.find((track) => track.target === 'actor_1' && track.property === 'x').keyframes
    .forEach((keyframe, index) => { keyframe.value = index * 0.04; });
  const actorReport = motionGateService.evaluate(actorDoesNotReach);
  assert.equal(actorReport.pass, false);
  assert.equal(actorReport.assertions.find((item) => item.key === 'subject_translation').pass, false);

  const propDoesNotFollow = structuredClone(valid);
  propDoesNotFollow.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'x').keyframes
    .forEach((keyframe) => { keyframe.value = -0.33; });
  const propReport = motionGateService.evaluate(propDoesNotFollow);
  assert.equal(propReport.pass, false);
  assert.equal(propReport.assertions.find((item) => item.key === 'action_object_follows_subject').pass, false);

  const noRelease = structuredClone(valid);
  noRelease.cues = noRelease.cues.filter((cue) => cue.key !== 'release_prop');
  const releaseReport = motionGateService.evaluate(noRelease);
  assert.equal(releaseReport.pass, false);
  assert.equal(releaseReport.assertions.find((item) => item.key === 'release_cue_exists').pass, false);
});

test('proof relation assertion verifies predicate and object, not only that a node exists', () => {
  const root = {
    key: 'root', relation: {}, children: [{
      key: 'prop_1', relation: { predicate: 'held-by', object: 'actor_1' }, children: [],
    }],
  };
  const target = { target_node_key: 'actor_1', frame: 0, metrics: { entropy: 3 } };
  const held = renderService.assertionResult(
    { type: 'relation_exists', node: 'prop_1', predicate: 'held-by', object: 'actor_1' },
    target, directedCarryPlan(), { camera_only: false }, root,
  );
  assert.equal(held.pass, true);
  assert.equal(held.actual.predicate, 'held-by');
  assert.equal(held.actual.object, 'actor_1');

  const wrongPredicate = renderService.assertionResult(
    { type: 'relation_exists', node: 'prop_1', predicate: 'follows', object: 'actor_1' },
    target, directedCarryPlan(), { camera_only: false }, root,
  );
  assert.equal(wrongPredicate.pass, false);

  const wrongObject = renderService.assertionResult(
    { type: 'relation_exists', node: 'prop_1', predicate: 'held-by', object: 'support_1' },
    target, directedCarryPlan(), { camera_only: false }, root,
  );
  assert.equal(wrongObject.pass, false);
});

test('state transition gate checks posture and state instead of accepting arbitrary horizontal movement', () => {
  const context = {
    source_kind: 'paper',
    storyboard: {
      id: 77,
      title: '原地坐下',
      description: '室内全景，人物站在画面中央',
      action: '人物原地缓慢坐下并保持结束姿态',
      duration: 4,
    },
    characters: [],
    props: [],
  };
  const blueprint = blueprintCompiler.infer(context);
  const compiled = blueprintCompiler.compile(blueprint, context, { fps: 30 });
  assert.equal(compiled.motionPlan.primary_action, 'state_transition');
  assert.equal(compiled.motionPlan.gate_requirements.some((item) => item.key === 'subject_translation'), false);
  assert.equal(compiled.motionPlan.gate_requirements.some((item) => item.key === 'posture_vertical_change' && item.property === 'y'), true);
  assert.equal(motionGateService.evaluate(compiled.motionPlan).pass, true);

  const cameraCannotFakePosture = structuredClone(compiled.motionPlan);
  cameraCannotFakePosture.subject_tracks.find((track) => track.property === 'y').keyframes
    .forEach((keyframe) => { keyframe.value = 0; });
  cameraCannotFakePosture.camera_tracks = [{ target: 'camera', property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: 119, value: 0.4 }] }];
  const report = motionGateService.evaluate(cameraCannotFakePosture);
  assert.equal(report.pass, false);
  assert.equal(report.assertions.find((item) => item.key === 'posture_vertical_change').pass, false);
});

test('compiled directed movement requires most of the planned waypoint distance', () => {
  const context = {
    source_kind: 'paper',
    storyboard: {
      id: 78,
      title: '横穿画面',
      description: '人物位于画面左侧，右侧为空',
      action: '人物从画面左侧走到右侧停下',
      duration: 5,
    },
    characters: [],
    props: [],
  };
  const compiled = blueprintCompiler.compile(blueprintCompiler.infer(context), context, { fps: 30 });
  const requirement = compiled.motionPlan.gate_requirements.find((item) => item.key === 'subject_translation');
  assert.equal(requirement.min >= 0.45, true);
  const tooShort = structuredClone(compiled.motionPlan);
  tooShort.subject_tracks.find((track) => track.target === 'actor_1' && track.property === 'x').keyframes
    .forEach((keyframe, index) => { keyframe.value = -0.3 + (index * 0.1); });
  const report = motionGateService.evaluate(tooShort);
  assert.equal(report.assertions.find((item) => item.key === 'subject_translation').pass, false);
});

test('evidence repair instructions map to safe state and release operations that repair only the failed requirement', () => {
  const noRelease = directedCarryPlan();
  noRelease.cues = noRelease.cues.filter((cue) => cue.key !== 'release_prop');
  const releaseIntent = revisionService.interpretInstruction('只修正放下道具事件：加入明确的释放时刻。', noRelease);
  assert.deepEqual(releaseIntent.operations.map((item) => item.kind), ['release_cue']);
  revisionService.applyIntent({ prepare() { throw new Error('database should not be used'); } }, { composition_nodes: [] }, noRelease, {
    required_states: { actor_1: ['start', 'moving', 'arrived'], prop_1: ['held', 'carried', 'released'] },
  }, releaseIntent);
  assert.equal(motionGateService.evaluate(noRelease).assertions.find((item) => item.key === 'release_cue_exists').pass, true);

  const collapsedStates = directedCarryPlan();
  collapsedStates.subject_tracks.find((track) => track.target === 'prop_1' && track.property === 'state').keyframes
    .forEach((keyframe) => { keyframe.value = 'held'; });
  const collapsedBefore = structuredClone(collapsedStates);
  const stateIntent = revisionService.interpretInstruction('只修正道具状态：补齐手持、携带和释放三个阶段。', collapsedStates);
  assert.deepEqual(stateIntent.operations.map((item) => item.kind), ['state_progression']);
  revisionService.applyIntent({ prepare() { throw new Error('database should not be used'); } }, { composition_nodes: [] }, collapsedStates, {
    required_states: { actor_1: ['start', 'moving', 'arrived'], prop_1: ['held', 'carried', 'released'] },
  }, stateIntent);
  assert.equal(motionGateService.evaluate(collapsedStates).assertions.find((item) => item.key === 'action_object_state_progression').pass, true);

  const changes = revisionService.trackChangeSummary(collapsedBefore, collapsedStates, ['prop_1:state']);
  assert.equal(changes[0].before.distinct_states, 1);
  assert.equal(changes[0].after.distinct_states, 3);
  assert.equal(changes[0].after.final, 'released');
});

test('directed carry relations reference real directed-move phases and invalid phase references are rejected', () => {
  const context = {
    source_kind: 'paper',
    storyboard: {
      id: 79,
      title: '携带道具横穿画面',
      description: '人物位于画面左侧，手里提着箱子',
      action: '人物提着箱子从画面左侧走到右侧停下',
      duration: 4,
    },
    characters: [{ id: 1, name: '旅人' }],
    props: [{ id: 2, name: '箱子' }],
  };
  const blueprint = blueprintCompiler.infer(context);
  assert.equal(blueprint.action_contract.primary_action, 'directed_move');
  assert.deepEqual(blueprint.action_contract.phases.map((item) => item.key), ['start', 'move', 'arrive']);
  assert.equal(blueprint.relations.find((item) => item.key === 'actor_holds_prop').start_phase, 'start');
  assert.doesNotThrow(() => blueprintCompiler.compile(blueprint, context, { fps: 30 }));

  const invalid = structuredClone(blueprint);
  invalid.relations[0].start_phase = 'lift';
  assert.throws(
    () => blueprintCompiler.compile(invalid, context, { fps: 30 }),
    (error) => error.code === 'PAPER_STUDIO_BLUEPRINT_RELATION_INVALID'
      && error.details.invalid_phase_relations[0].start_phase === 'lift',
  );
});

test('formal render claim is idempotent for the same shot, snapshot and render hash', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const now = '2026-07-26T00:00:00.000Z';
    db.prepare(
      `INSERT INTO paper_studio_shots
        (id, run_id, drama_id, episode_id, storyboard_id, shot_index, status,
         current_snapshot_id, approved_snapshot_id, created_at, updated_at)
       VALUES (20, 11, 3, 5, 6, 0, 'approved', 31, 31, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO paper_job_steps
        (run_id, shot_id, step_key, input_hash, depends_on_json, status, attempt, max_attempts,
         result_json, error_json, created_at, updated_at)
       VALUES (11, 20, 'render_formal', 'formal-test', '[]', 'queued', 1, 2, '{}', '{}', ?, ?)`,
    ).run(now, now);
    const shot = {
      id: 20, run_id: 11, drama_id: 3, storyboard_id: 6, paper_storyboard_id: 6,
      status: 'approved',
    };
    const snapshot = {
      id: 31,
      render_hash: `sha256:${'a'.repeat(64)}`,
      renderer_version: 'paper-studio-v3',
      snapshot_json: { composition: { duration_frames: 90, fps: 30 } },
    };

    const first = renderService.claimFormalRender(db, shot, snapshot);
    const repeated = renderService.claimFormalRender(db, shot, snapshot);
    assert.equal(first.owner, true);
    assert.equal(repeated.owner, false);
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.in_progress, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_generations WHERE generation_kind = 'paper_studio' AND status = 'processing'").get().count, 1);
    assert.equal(db.prepare('SELECT status FROM paper_studio_shots WHERE id = 20').get().status, 'rendering');
    assert.equal(db.prepare("SELECT status FROM paper_job_steps WHERE shot_id = 20 AND step_key = 'render_formal'").get().status, 'running');
  } finally {
    db.close();
  }
});

test('a late formal worker cannot move an already published shot back to rendered', () => {
  const statement = `UPDATE paper_studio_shots
         SET status = 'rendered', published_video_generation_id = ?, last_error_json = '{}',
             version = version + 1, updated_at = ?
         WHERE id = ? AND status != 'published'`;
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const now = '2026-07-26T00:00:00.000Z';
    db.prepare(
      `INSERT INTO paper_studio_shots
        (id, run_id, drama_id, episode_id, storyboard_id, shot_index, status,
         published_video_generation_id, created_at, updated_at)
       VALUES (21, 12, 3, 5, 7, 0, 'published', 8, ?, ?)`,
    ).run(now, now);
    const changed = db.prepare(statement).run(9, now, 21);
    assert.equal(changed.changes, 0);
    assert.deepEqual(
      db.prepare('SELECT status, published_video_generation_id FROM paper_studio_shots WHERE id = 21').get(),
      { status: 'published', published_video_generation_id: 8 },
    );
  } finally {
    db.close();
  }
});
