const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const continuityService = require('../src/services/paper-studio/paperContinuityService');
const revisionService = require('../src/services/paper-studio/paperMotionRevisionService');
const actionCatalogService = require('../src/services/paper-studio/paperActionCatalogService');
const { numericRange } = require('../src/paper-studio-renderer/motion/trackResolver.cjs');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-25T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'通用连续性测试',?,?)").run(now, now);
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (10,1,1,'第一集',?,?)").run(now, now);
  db.prepare("INSERT INTO characters (id,drama_id,name,appearance,local_path,created_at,updated_at) VALUES (1,1,'主角','黑衣、短发、红色腰带','characters/hero.png',?,?)").run(now, now);
  const insert = db.prepare(`INSERT INTO storyboards
    (id,episode_id,storyboard_number,title,description,action,characters,duration,created_at,updated_at)
    VALUES (?,10,?,?,?,?,?,5,?,?)`);
  insert.run(101, 1, '起身动作', '主角从静止状态起身', '主角起身并停下', '[1]', now, now);
  insert.run(102, 2, '转身动作', '同一主角继续完成动作', '主角转身后站定', '[1]', now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const run = runService.create(db, log, { request_id: randomUUID(), project_id: project.id, episode_id: 10, storyboard_ids: [101, 102] }).run;
  const analyzed = analyzerService.analyzeRun(db, log, run.id, { request_id: randomUUID(), expected_version: run.version }, { fps: 30 });
  return { db, run: analyzed.run };
}

test('action catalog rejects unknown actions and unsafe or out-of-range keyframes', () => {
  const valid = {
    schema_version: 1,
    fps: 30,
    duration_frames: 90,
    primary_action: 'subject_settle',
    camera_only: false,
    subject_tracks: [{ target: 'primary_subject', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: 89, value: 8 }] }],
    camera_tracks: [],
    cues: [{ key: 'peak', frame: 60 }],
  };
  assert.equal(actionCatalogService.validatePlan(valid).pass, true);
  assert.equal(actionCatalogService.validatePlan({ ...valid, primary_action: 'execute_arbitrary_code' }).pass, false);
  const unsafe = structuredClone(valid);
  unsafe.subject_tracks[0].keyframes[1] = { frame: 120, value: 999 };
  const report = actionCatalogService.validatePlan(unsafe);
  assert.equal(report.pass, false);
  assert.ok(report.assertions.some((item) => !item.pass && item.key.includes('frames')));
  assert.ok(report.assertions.some((item) => !item.pass && item.key.includes('values')));
});

test('action catalog exposes only compiler-supported neutral actions for blueprint selection', () => {
  const actions = actionCatalogService.list();
  const selectable = actions.filter((action) => action.user_selectable && action.blueprint_supported);
  assert.ok(selectable.some((action) => action.key === 'transport_move' && action.label === '接地运输移动'));
  assert.equal(actions.some((action) => action.key === 'map_route_reveal'), false);
  assert.equal(actions.some((action) => action.key === 'siege_supply_sequence'), false);
  assert.ok(actions.every((action) => typeof action.label === 'string' && typeof action.user_selectable === 'boolean'));
});

test('legacy action, blueprint id, procedural kind and appearance aliases remain read-only compatible', () => {
  assert.equal(actionCatalogService.normalizeAction('map_route_reveal'), 'path_reveal');
  assert.equal(actionCatalogService.normalizeAction('siege_supply_sequence'), 'multi_beat_grounded_sequence');
  assert.equal(actionCatalogService.normalizeBlueprintId('map-route-reveal-v1'), 'path-reveal-v1');
  assert.equal(actionCatalogService.normalizeBlueprintId('blueprint-map-route-reveal-v2'), 'blueprint-path-reveal-v1');
  assert.equal(actionCatalogService.normalizeBlueprintId('siege-supply-sequence-v3'), 'multi-beat-grounded-sequence-v1');
  assert.equal(actionCatalogService.normalizeProceduralKind('route-reveal'), 'path-reveal');
  assert.equal(actionCatalogService.normalizeProceduralKind('map-title-card'), 'label-card');
  assert.equal(actionCatalogService.normalizeProceduralKind('army-formation'), 'crowd-formation');
  assert.equal(actionCatalogService.normalizeProceduralKind('ember-field'), 'ember-drift');
  assert.equal(actionCatalogService.normalizeAppearance('qin-silhouette'), 'neutral-silhouette');
  assert.equal(actionCatalogService.isPathRevealSummary({ catalog_key: 'blueprint-map-route-reveal-v2' }), true);
});

test('natural-language revision changes only safe motion primitives and invalidates old snapshots', () => {
  const { db, run } = setup();
  let shot = shotService.get(db, run.shots[0].id);
  const rotationBefore = numericRange(shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'primary_subject' && track.property === 'rotation'));
  const requestId = randomUUID();
  const revised = revisionService.revise(db, {}, log, shot.id, {
    request_id: requestId,
    expected_version: shot.version,
    instruction: '主体旋转多一点',
  });
  const rotationAfter = numericRange(revised.shot.motion_plan.plan_json.subject_tracks.find((track) => track.target === 'primary_subject' && track.property === 'rotation'));
  assert.ok(rotationAfter > rotationBefore);
  assert.equal(revised.revision.intent_json.source, 'deterministic-rule');
  assert.equal(revised.gate.pass, true);
  assert.equal(revisionService.revise(db, {}, log, shot.id, { request_id: requestId, expected_version: shot.version, instruction: '主体旋转多一点' }).deduplicated, true);

  shot = shotService.get(db, shot.id);
  const hash = `sha256:${'a'.repeat(64)}`;
  const snapshotId = db.prepare(`INSERT INTO paper_render_snapshots
    (shot_id,schema_version,renderer_version,source_revision_hash,snapshot_json,snapshot_hash,render_hash,status,created_at)
    VALUES (?,3,'test',?,'{}',?,?,'compiled',?)`).run(shot.id, shot.source_revision_hash, hash, hash, '2026-07-25T00:01:00.000Z').lastInsertRowid;
  db.prepare("UPDATE paper_studio_shots SET status = 'proof_ready', current_snapshot_id = ? WHERE id = ?").run(snapshotId, shot.id);
  const proofRunId = db.prepare(`INSERT INTO paper_proof_runs
    (shot_id,snapshot_id,run_kind,scale,status,report_json,created_at)
    VALUES (?,?,'preview',0.5,'completed','{}',?)`).run(shot.id, snapshotId, '2026-07-25T00:01:30.000Z').lastInsertRowid;
  shot = shotService.get(db, shot.id);
  const relationRevision = revisionService.revise(db, {}, log, shot.id, {
    request_id: randomUUID(),
    expected_version: shot.version,
    instruction: '主体放到前景后面',
  });
  assert.equal(relationRevision.shot.status, 'asset_ready');
  assert.equal(relationRevision.shot.current_snapshot_id, null);
  assert.equal(db.prepare('SELECT status FROM paper_render_snapshots WHERE id = ?').get(snapshotId).status, 'superseded');
  assert.equal(db.prepare('SELECT status FROM paper_proof_runs WHERE id = ?').get(proofRunId).status, 'superseded');
  const subject = relationRevision.shot.composition_nodes.find((node) => node.node_key === 'primary_subject');
  assert.equal(subject.relation_json.predicate, 'behind');
  assert.equal(subject.relation_json.object_key, 'foreground');
  assert.throws(
    () => revisionService.revise(db, {}, log, shot.id, { request_id: randomUUID(), expected_version: relationRevision.shot.version, instruction: '给我做得更好看' }),
    (error) => error.code === 'PAPER_STUDIO_REVISION_INTENT_UNSUPPORTED',
  );
  db.close();
});

test('continuity contracts propagate accepted identity assets to the next shot', () => {
  const { db, run } = setup();
  assert.equal(run.continuity.length, 1);
  const contract = run.continuity[0];
  assert.equal(contract.contract_json.type, 'subject_identity_handoff');
  assert.equal(contract.contract_json.identity.includes('主角'), true);

  const sourceShot = run.shots[0];
  const targetShot = run.shots[1];
  const sourceSlot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas
    JOIN paper_source_families psf ON psf.id = pas.family_id
    WHERE psf.shot_id = ? AND pas.slot_key = 'subject_start'`).get(sourceShot.id);
  const sourceVersion = db.prepare(`INSERT INTO paper_asset_versions
    (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,alpha_local_path,source_hash,alpha_hash,provenance_json,status,created_at,accepted_at)
    VALUES (?,?,1,'source_import','characters/hero.png','characters/hero.png',?,?, '{}','accepted',?,?)`)
    .run(sourceSlot.id, sourceSlot.family_id, `sha256:${'b'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, '2026-07-25T00:02:00.000Z', '2026-07-25T00:02:00.000Z').lastInsertRowid;
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(sourceVersion, sourceSlot.id);

  const targetSlot = db.prepare(`SELECT pas.* FROM paper_asset_slots pas
    JOIN paper_source_families psf ON psf.id = pas.family_id
    WHERE psf.shot_id = ? AND pas.slot_key = 'subject_action'`).get(targetShot.id);
  targetSlot.constraints_json = JSON.parse(targetSlot.constraints_json);
  const refs = continuityService.referencePathsForSlot(db, { id: targetShot.id }, targetSlot);
  assert.deepEqual(refs, ['characters/hero.png']);
  assert.equal(continuityService.assertIncomingSourcesReady(db, targetShot.id).pass, true);

  const targetVersion = db.prepare(`INSERT INTO paper_asset_versions
    (slot_id,source_family_id,attempt_index,derivation_kind,source_local_path,alpha_local_path,source_hash,alpha_hash,provenance_json,status,created_at,accepted_at)
    VALUES (?,?,1,'image_api','generated/hero-action.png','generated/hero-action.png',?,?,?,'accepted',?,?)`)
    .run(targetSlot.id, targetSlot.family_id, `sha256:${'c'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, JSON.stringify({ reference_images: refs }), '2026-07-25T00:03:00.000Z', '2026-07-25T00:03:00.000Z').lastInsertRowid;
  db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(targetVersion, targetSlot.id);
  const report = continuityService.evaluateForShot(db, targetShot.id);
  assert.equal(report.pass, true);
  assert.equal(continuityService.listForRun(db, run.id)[0].status, 'satisfied');
  db.close();
});
