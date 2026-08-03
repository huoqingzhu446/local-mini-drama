const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const historyService = require('../src/services/paper-studio/paperStoryboardHistoryService');
const reuseService = require('../src/services/paper-studio/paperAssetReuseService');
const continuityRepairService = require('../src/services/paper-studio/paperContinuityRepairService');
const fingerprintService = require('../src/services/paper-studio/paperAssetReuseFingerprintService');
const { sha256 } = require('../src/services/paper-studio/paperStudioUtils');

const log = { info() {}, warn() {}, error() {} };

function setup() {
  const db = new Database(':memory:');
  const originalLog = console.log;
  console.log = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; }
  const now = '2026-08-01T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'历史复用验收',?,?)").run(now, now);
  db.prepare(`INSERT INTO ai_service_configs
    (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
    VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '第一集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: '女孩到达候车区',
    description: '旧车站候车区全景，右侧有一张长椅',
    action: '女孩提起行李箱走向长椅',
    duration: 6,
  }).storyboard;
  const run = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
    paper_storyboard_ids: [storyboard.id],
    expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
    image_provider_config_id: 1,
  }).run;
  return { db, project, episode, storyboard, run };
}

test('同一镜头连续持久化计划只追加历史结构，当前指针切到最新版', () => {
  const { db, run } = setup();
  const first = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
  }, { fps: 30 }).run;
  const shotId = Number(first.shots[0].id);
  const before = Object.fromEntries(['paper_plan_revisions', 'paper_source_families', 'paper_asset_slots', 'paper_composition_nodes', 'paper_motion_plans', 'paper_job_steps']
    .map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'paper_asset_slots' ? 'family_id IN (SELECT id FROM paper_source_families WHERE shot_id = ?)' : table === 'paper_job_steps' ? 'shot_id = ?' : 'shot_id = ?'}`).get(shotId).count)]));
  const firstPlanId = Number(first.shots[0].current_plan_revision_id);
  const second = analyzerService.analyzeRun(db, log, run.id, {
    request_id: randomUUID(), expected_version: first.version,
  }, { fps: 30 }).run;
  const afterShot = shotService.get(db, shotId);
  const after = Object.fromEntries(Object.keys(before).map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'paper_asset_slots' ? 'family_id IN (SELECT id FROM paper_source_families WHERE shot_id = ?)' : table === 'paper_job_steps' ? 'shot_id = ?' : 'shot_id = ?'}`).get(shotId).count)]));
  assert.notEqual(afterShot.current_plan_revision_id, firstPlanId);
  assert.equal(Number(second.shots[0].current_plan_revision_id), Number(afterShot.current_plan_revision_id));
  for (const table of Object.keys(before)) assert.equal(after[table] > before[table], true, `${table} should append`);
  assert.equal(db.prepare('SELECT status FROM paper_plan_revisions WHERE id = ?').get(firstPlanId).status, 'superseded');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_asset_slots pas JOIN paper_source_families psf ON psf.id = pas.family_id WHERE psf.plan_revision_id = ?').get(firstPlanId).count > 0, true);
  db.close();
});

test('历史查询返回全部计划和图片，精确复用不增加 provider 调用', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-history-reuse-'));
  const cfg = { storage: { local_path: storageRoot }, paper_studio: { fps: 30 } };
  const { db, storyboard, run } = setup();
  try {
    const first = analyzerService.analyzeRun(db, log, run.id, {
      request_id: randomUUID(), expected_version: run.version,
    }, { fps: 30 }).run;
    const firstShot = shotService.get(db, first.shots[0].id);
    const sourceSlot = firstShot.families.flatMap((family) => family.slots).find((slot) => slot.asset_type === 'environment');
    const relative = 'projects/1/paper-studio/history/source.png';
    const absolute = path.join(storageRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from('approved-history-image'));
    const hash = sha256(fs.readFileSync(absolute));
    const createdAt = '2026-08-01T01:00:00.000Z';
    const version = db.prepare(
      `INSERT INTO paper_asset_versions
        (slot_id, source_family_id, attempt_index, derivation_kind, source_local_path,
         source_hash, reuse_fingerprint, processing_json, registration_json,
         provenance_json, quality_report_json, status, created_at, accepted_at)
       VALUES (?, ?, 1, 'image_api', ?, ?, ?, '{}', '{}', '{}', '{"pass":true}', 'accepted', ?, ?)`,
    ).run(Number(sourceSlot.id), Number(sourceSlot.family_id), relative, hash, sourceSlot.reuse_fingerprint, createdAt, createdAt);
    const sourceVersionId = Number(version.lastInsertRowid);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?").run(sourceVersionId, Number(sourceSlot.id));
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'approved', 'local_user', ?, ?)`,
    ).run(Number(firstShot.id), Number(sourceSlot.id), sourceVersionId, randomUUID(), createdAt);

    const second = analyzerService.analyzeRun(db, log, run.id, {
      request_id: randomUUID(), expected_version: first.version,
    }, { fps: 30 }).run;
    const confirmed = analyzerService.confirmPlan(db, log, run.id, {
      request_id: randomUUID(), expected_version: second.version,
    }).run;
    const beforeCalls = reuseService.providerCallCount(db, run.id);
    db.prepare('UPDATE paper_asset_versions SET reuse_fingerprint = ? WHERE id = ?')
      .run('sha256:review-required', sourceVersionId);
    const reviewPreview = reuseService.buildReusePreview(db, cfg, run.id, {
      expected_version: confirmed.version,
      shot_ids: [Number(confirmed.shots[0].id)],
    });
    assert.equal(reviewPreview.history_review_count >= 1, true);
    assert.equal(reviewPreview.slots.some((slot) => slot.source_kind === 'history_review_required' && slot.calls === 1), true);
    assert.equal(reviewPreview.estimated_image_count >= reviewPreview.history_review_count, true);
    db.prepare('UPDATE paper_asset_versions SET reuse_fingerprint = ? WHERE id = ?')
      .run(sourceSlot.reuse_fingerprint, sourceVersionId);
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'rejected', '暂不采用', 'local_owner', ?, ?)`,
    ).run(Number(firstShot.id), Number(sourceSlot.id), sourceVersionId, randomUUID(), '2026-08-01T01:10:00.000Z');
    const blockedPreview = reuseService.buildReusePreview(db, cfg, run.id, {
      expected_version: confirmed.version,
      shot_ids: [Number(confirmed.shots[0].id)],
    });
    assert.equal(blockedPreview.blocked_history_count >= 1, true);
    assert.equal(blockedPreview.slots.some((slot) => slot.source_kind === 'needs_image_api' && slot.match_kind === 'blocked' && slot.calls === 1), true);
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'approved', '重新确认', 'local_owner', ?, ?)`,
    ).run(Number(firstShot.id), Number(sourceSlot.id), sourceVersionId, randomUUID(), '2026-08-01T01:20:00.000Z');
    const preview = reuseService.buildReusePreview(db, cfg, run.id, {
      expected_version: confirmed.version,
      shot_ids: [Number(confirmed.shots[0].id)],
    });
    assert.equal(preview.history_reuse_count >= 1, true);
    const exact = preview.slots.find((slot) => slot.source_kind === 'historical_reuse' && slot.source_asset_version_id === sourceVersionId);
    assert.ok(exact);
    await assert.rejects(
      reuseService.applyReusePreview(db, cfg, log, run.id, {
        request_id: randomUUID(), expected_version: confirmed.version,
        reuse_preview_fingerprint: preview.reuse_preview_fingerprint,
        shot_ids: [Number(confirmed.shots[0].id)],
        slot_ids: [Number(exact.slot_id)],
      }),
      (error) => error.code === 'PAPER_STUDIO_REUSE_USER_CONFIRMATION_REQUIRED',
    );
    const applied = await reuseService.applyReusePreview(db, cfg, log, run.id, {
      request_id: randomUUID(), expected_version: confirmed.version,
      reuse_preview_fingerprint: preview.reuse_preview_fingerprint,
      shot_ids: [Number(confirmed.shots[0].id)],
      slot_ids: [Number(exact.slot_id)],
      confirmation: {
        actor: 'local_owner',
        reason: 'historical_exact_reuse_confirmed',
        source_asset_version_ids: [sourceVersionId],
      },
    });
    assert.equal(applied.provider_call_delta, 0);
    assert.equal(reuseService.providerCallCount(db, run.id), beforeCalls);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_asset_reuse_links WHERE source_asset_version_id = ?').get(sourceVersionId).count, 1);
    const targetVersionId = Number(applied.reused[0].target_asset_version_id);
    const targetReview = reuseService.latestReviewDecision(db, targetVersionId);
    assert.equal(targetReview.decision, 'approved');
    assert.equal(targetReview.reviewer, 'local_owner');
    assert.match(targetReview.reason, /historical_exact_reuse_confirmed/);
    const link = db.prepare('SELECT * FROM paper_asset_reuse_links WHERE target_asset_version_id = ?').get(targetVersionId);
    const compatibility = JSON.parse(link.compatibility_report_json);
    assert.equal(compatibility.fingerprint_match, true);
    assert.equal(compatibility.file_verified, true);
    assert.equal(link.preview_fingerprint, preview.reuse_preview_fingerprint);

    const summary = historyService.list(db, storyboard.id, { limit: 20 });
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.total_run_count, 1);
    assert.equal(summary.timezone, 'Asia/Shanghai');
    assert.equal(summary.runs[0].plan_revision_count, 2);
    const scriptHistory = historyService.revisionDetail(db, storyboard.id, storyboard.current_revision_id);
    assert.equal(scriptHistory.content.title, storyboard.title);
    assert.equal(scriptHistory.related_runs.length, 1);
    assert.deepEqual(scriptHistory.diff_from_current.changed_fields, []);
    const detail = historyService.runDetail(db, storyboard.id, run.id);
    assert.equal(detail.plan_revisions.length, 2);
    assert.equal(detail.plan_revisions.some((plan) => plan.families.some((family) => family.slots.some((slot) => slot.versions.some((item) => item.id === sourceVersionId)))), true);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('复用指纹排除纯 timing/对白并按素材类型处理环境变化', () => {
  const base = {
    run: { project_id: 1, style_signature: 'style-a' },
    shot: { paper_storyboard_id: 9 },
    family: { pattern: 'subject', contract_json: { identity: 'girl', duration_frames: 180 }, registration_canvas_json: { width: 1, height: 1 } },
    slot: { slot_key: 'girl', asset_type: 'character-cutout', generation_purpose: 'character', constraints_json: { identity: 'girl', state: 'standing', background: 'station', dialogue: '你好' } },
  };
  const characterA = fingerprintService.computeReuseFingerprint(base);
  const characterTiming = fingerprintService.computeReuseFingerprint({
    ...base,
    slot: { ...base.slot, constraints_json: { ...base.slot.constraints_json, background: 'park', dialogue: '再见', duration_frames: 300 } },
  });
  assert.equal(characterTiming, characterA);
  const environmentBase = { ...base, slot: { ...base.slot, asset_type: 'environment', generation_purpose: 'clean_plate' } };
  const environmentA = fingerprintService.computeReuseFingerprint(environmentBase);
  const environmentB = fingerprintService.computeReuseFingerprint({
    ...environmentBase,
    slot: { ...environmentBase.slot, constraints_json: { ...environmentBase.slot.constraints_json, background: 'park' } },
  });
  assert.notEqual(environmentA, environmentB);
  assert.notEqual(fingerprintService.computeReuseFingerprint({ ...base, run: { ...base.run, style_signature: 'style-b' } }), characterA);
  assert.notEqual(fingerprintService.computeReuseFingerprint({ ...base, shot: { paper_storyboard_id: 10 } }), characterA);
});

test('历史复用只认最新审核决定，后续拒绝会撤销旧批准资格', () => {
  const { db, run } = setup();
  try {
    const analyzed = analyzerService.analyzeRun(db, log, run.id, {
      request_id: randomUUID(), expected_version: run.version,
    }, { fps: 30 }).run;
    const shot = shotService.get(db, analyzed.shots[0].id);
    const slot = shot.families.flatMap((family) => family.slots).find((item) => item.required_for_gate);
    const now = '2026-08-01T03:00:00.000Z';
    const versionId = Number(db.prepare(
      `INSERT INTO paper_asset_versions
        (slot_id, source_family_id, attempt_index, derivation_kind, reuse_fingerprint,
         processing_json, registration_json, provenance_json, quality_report_json,
         status, created_at, accepted_at)
       VALUES (?, ?, 1, 'image_api', ?, '{}', '{}', '{}', '{}', 'accepted', ?, ?)`,
    ).run(Number(slot.id), Number(slot.family_id), slot.reuse_fingerprint, now, now).lastInsertRowid);
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'approved', 'first', 'local_owner', ?, ?)`,
    ).run(Number(shot.id), Number(slot.id), versionId, randomUUID(), now);
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'rejected', 'later rejection', 'local_owner', ?, ?)`,
    ).run(Number(shot.id), Number(slot.id), versionId, randomUUID(), now);
    const latest = reuseService.latestReviewDecision(db, versionId);
    assert.equal(latest.decision, 'rejected');
    assert.equal(latest.reason, 'later rejection');
  } finally {
    db.close();
  }
});

test('连续性修复只克隆已批准完整素材并记录真实校验与用户确认', () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-continuity-reuse-'));
  const cfg = { storage: { local_path: storageRoot }, paper_studio: { fps: 30, motion_quality: false } };
  const { db, run } = setup();
  try {
    const analyzed = analyzerService.analyzeRun(db, log, run.id, {
      request_id: randomUUID(), expected_version: run.version,
    }, { fps: 30 }).run;
    let shot = shotService.get(db, analyzed.shots[0].id);
    const slot = shot.families.flatMap((family) => family.slots).find((item) => item.required_for_gate);
    const relative = 'projects/1/paper-studio/continuity/source.png';
    const absolute = path.join(storageRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from('continuity-approved-image'));
    const hash = sha256(fs.readFileSync(absolute));
    const now = '2026-08-01T04:00:00.000Z';
    const sourceVersionId = Number(db.prepare(
      `INSERT INTO paper_asset_versions
        (slot_id, source_family_id, attempt_index, derivation_kind, source_local_path,
         source_hash, reuse_fingerprint, processing_json, registration_json,
         provenance_json, quality_report_json, status, created_at, accepted_at)
       VALUES (?, ?, 1, 'image_api', ?, ?, ?, '{}', '{}', '{}', '{}', 'accepted', ?, ?)`,
    ).run(Number(slot.id), Number(slot.family_id), relative, hash, slot.reuse_fingerprint, now, now).lastInsertRowid);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?")
      .run(sourceVersionId, Number(slot.id));
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'approved', '人工已确认', 'local_owner', ?, ?)`,
    ).run(Number(shot.id), Number(slot.id), sourceVersionId, randomUUID(), now);
    db.prepare("UPDATE paper_studio_shots SET status = 'rendering' WHERE id = ?").run(Number(shot.id));
    shot = shotService.get(db, shot.id);
    db.prepare(
      `INSERT INTO paper_job_steps
        (run_id, shot_id, plan_revision_id, step_key, input_hash, depends_on_json,
         status, attempt, max_attempts, result_json, error_json, created_at, updated_at)
       SELECT run_id, shot_id, plan_revision_id, step_key, input_hash || ':legacy-duplicate',
              depends_on_json, status, attempt, max_attempts, result_json, error_json,
              created_at, updated_at
       FROM paper_job_steps
       WHERE shot_id = ? AND plan_revision_id = ? AND step_key = 'technical_asset_gate'
       ORDER BY id LIMIT 1`,
    ).run(Number(shot.id), Number(shot.current_plan_revision_id));
    const motionPlan = JSON.parse(JSON.stringify(shot.motion_plan.plan_json));
    const editableTracks = [
      ...(motionPlan.tracks || []),
      ...(motionPlan.subject_tracks || []),
      ...(motionPlan.camera_tracks || []),
    ];
    for (const track of editableTracks.filter((item) => ['actor_1', 'prop_1'].includes(item.target) && item.property === 'x')) {
      const origin = Number(track.keyframes[0].value || 0);
      track.keyframes = track.keyframes.map((keyframe) => ({
        ...keyframe,
        value: origin + (Number(keyframe.value || 0) - origin) * 0.8,
      }));
    }
    const activeVideoId = Number(db.prepare(
      `INSERT INTO video_generations
        (drama_id, status, generation_kind, paper_studio_shot_id, created_at, updated_at)
       VALUES (1, 'processing', 'paper_studio', ?, ?, ?)`,
    ).run(Number(shot.id), now, now).lastInsertRowid);
    const blockedPreview = continuityRepairService.preview(db, cfg, shot.id, {
      expected_version: shot.version,
      motion_plan: motionPlan,
    });
    assert.equal(blockedPreview.repairability.pass, false);
    assert.equal(blockedPreview.repairability.code, 'PAPER_STUDIO_CONTINUITY_REPAIR_RENDER_ACTIVE');
    assert.equal(blockedPreview.can_apply_zero_call, false);
    db.prepare("UPDATE video_generations SET status = 'failed', updated_at = ? WHERE id = ?")
      .run(now, activeVideoId);
    const preview = continuityRepairService.preview(db, cfg, shot.id, {
      expected_version: shot.version,
      motion_plan: motionPlan,
    });
    assert.equal(preview.repairability.pass, true);
    assert.equal(preview.repairability.recovered_stranded_render, true);
    const gateFailures = [
      ...(preview.gate.assertions || []),
      ...(preview.gate.spatial?.assertions || []),
    ].filter((item) => item.pass === false);
    assert.equal(preview.can_apply_zero_call, true, JSON.stringify(gateFailures));
    const inspected = preview.asset_diff.slots.find((item) => item.asset_version_id === sourceVersionId);
    assert.equal(inspected.reusable, true);
    assert.equal(inspected.fingerprint_match, true);
    assert.equal(inspected.file.pass, true);
    const requestId = randomUUID();
    assert.throws(
      () => continuityRepairService.apply(db, cfg, log, shot.id, {
        request_id: requestId,
        expected_version: shot.version,
        preview_fingerprint: preview.preview_fingerprint,
        motion_plan: motionPlan,
      }),
      (error) => error.code === 'PAPER_STUDIO_CONTINUITY_REPAIR_CONFIRMATION_REQUIRED',
    );
    const applied = continuityRepairService.apply(db, cfg, log, shot.id, {
      request_id: requestId,
      expected_version: shot.version,
      preview_fingerprint: preview.preview_fingerprint,
      motion_plan: motionPlan,
      confirmation: {
        actor: 'local_owner',
        reason: 'continuity_exact_reuse_confirmed',
        source_asset_version_ids: [sourceVersionId],
      },
    });
    assert.equal(applied.provider_call_delta, 0);
    assert.equal(applied.shot.published_video_generation_id, null);
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS count FROM paper_job_steps WHERE plan_revision_id = ? AND step_key = 'technical_asset_gate'",
    ).get(Number(applied.target_plan_revision_id)).count, 1);
    const link = db.prepare(
      'SELECT * FROM paper_asset_reuse_links WHERE source_asset_version_id = ? AND request_id = ?',
    ).get(sourceVersionId, requestId);
    assert.ok(link);
    assert.equal(link.preview_fingerprint, preview.preview_fingerprint);
    const compatibility = JSON.parse(link.compatibility_report_json);
    assert.equal(compatibility.fingerprint_match, true);
    assert.equal(compatibility.file_verified, true);
    assert.equal(compatibility.source_approved, true);
    const targetReview = reuseService.latestReviewDecision(db, link.target_asset_version_id);
    assert.equal(targetReview.reviewer, 'local_owner');
    assert.match(targetReview.reason, /continuity_exact_reuse_confirmed/);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
