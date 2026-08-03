const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  ensurePaperHistoryForkSchema,
  runMigrationsAndEnsure,
} = require('../src/db/migrate');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const forkService = require('../src/services/paper-studio/paperStoryboardHistoryForkService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const reuseService = require('../src/services/paper-studio/paperAssetReuseService');
const { sha256 } = require('../src/services/paper-studio/paperStudioUtils');

const log = { info() {}, warn() {}, error() {} };

function migrateBase(db) {
  const originalLog = console.log;
  console.log = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; }
}

function setup({ migration45 = true } = {}) {
  const db = new Database(':memory:');
  migrateBase(db);
  if (migration45) ensurePaperHistoryForkSchema(db);
  const now = '2026-08-01T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'历史派生测试',?,?)").run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '第一集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: '旧标题',
    description: '旧车站候车区',
    action: '女孩走向长椅',
    dialogue: '第一版对白',
    duration: 6,
  }).storyboard;
  return { db, project, episode, storyboard };
}

test('migration 45 在单一事务中回填工作副本基线并可幂等重放', () => {
  const { db, storyboard } = setup({ migration45: false });
  try {
    const first = ensurePaperHistoryForkSchema(db);
    const second = ensurePaperHistoryForkSchema(db);
    assert.equal(first.migration_id, '45_paper_storyboard_history_fork');
    assert.equal(second.storyboard_count, first.storyboard_count);
    const row = db.prepare('SELECT * FROM paper_storyboards WHERE id = ?').get(storyboard.id);
    assert.equal(Number(row.working_copy_base_revision_id), Number(row.current_revision_id));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_schema_migrations WHERE migration_id = '45_paper_storyboard_history_fork'").get().count, 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});

test('migration 45 完整性断言失败时回滚 DDL、回填和完成标记', () => {
  const { db, episode, storyboard } = setup({ migration45: false });
  try {
    const other = storyboardService.create(db, log, episode.id, {
      request_id: randomUUID(), title: '另一个分镜', description: '另一处', action: '另一动作', duration: 6,
    }).storyboard;
    db.prepare('UPDATE paper_storyboards SET current_revision_id = ? WHERE id = ?')
      .run(Number(other.current_revision_id), Number(storyboard.id));
    assert.throws(() => ensurePaperHistoryForkSchema(db), /cross_storyboard_base=1/);
    const columns = new Set(db.prepare('PRAGMA table_info(paper_storyboards)').all().map((row) => row.name));
    assert.equal(columns.has('working_copy_base_revision_id'), false);
    assert.equal(Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'paper_history_fork_audits'").get()), false);
    assert.equal(Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'paper_schema_migrations'").get()), false);
  } finally {
    db.close();
  }
});

test('基于任意历史 S 创建工作副本不伪造修订，真实修改后才生成新 S', () => {
  const { db, storyboard } = setup();
  try {
    const sourceRevisionId = Number(storyboard.current_revision_id);
    const sourceRevision = db.prepare('SELECT * FROM paper_storyboard_revisions WHERE id = ?').get(sourceRevisionId);
    const current = storyboardService.update(db, log, storyboard.id, {
      request_id: randomUUID(),
      expected_version: storyboard.version,
      title: '当前标题',
      description: '当前版本的新场景',
      action: '女孩离开长椅',
      dialogue: '第二版对白',
    });
    db.prepare("UPDATE paper_storyboards SET published_video_generation_id = 987, status = 'published' WHERE id = ?")
      .run(Number(storyboard.id));
    const published = storyboardService.get(db, storyboard.id);
    const beforeRevisionCount = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM paper_storyboard_revisions WHERE paper_storyboard_id = ?',
    ).get(storyboard.id).count);
    const beforeCalls = forkService.providerCallCount(db, storyboard.id);
    const preview = forkService.buildPreview(db, storyboard.id, {
      source: { kind: 'revision', id: sourceRevisionId },
      target_mode: 'working_copy',
      expected_version: published.version,
    });
    assert.equal(preview.source_content_hash, sourceRevision.content_hash);
    assert.equal(preview.published_video_will_be_invalidated, true);
    assert.equal(preview.provider_call_max, 0);
    assert.throws(() => forkService.forkDraft(db, log, storyboard.id, {
      request_id: randomUUID(),
      source_revision_id: sourceRevisionId,
      expected_version: published.version,
      preview_fingerprint: preview.preview_fingerprint,
      confirmation: { actor: 'local_owner', reason: 'history_working_copy_confirmed' },
    }), (error) => error.code === 'PAPER_HISTORY_PUBLISHED_VIDEO_CONFIRMATION_REQUIRED');

    const requestId = randomUUID();
    const forked = forkService.forkDraft(db, log, storyboard.id, {
      request_id: requestId,
      source_revision_id: sourceRevisionId,
      expected_version: published.version,
      preview_fingerprint: preview.preview_fingerprint,
      confirmation: {
        actor: 'local_owner',
        reason: 'history_working_copy_confirmed',
        published_video_invalidation: true,
      },
    });
    assert.equal(forked.created, true);
    assert.equal(forked.provider_call_delta, 0);
    assert.equal(forked.storyboard.title, '旧标题');
    assert.equal(forked.storyboard.dialogue, '第一版对白');
    assert.equal(forked.storyboard.current_revision_id, sourceRevisionId);
    assert.equal(forked.storyboard.working_copy_base_revision_id, sourceRevisionId);
    assert.equal(forked.storyboard.published_video_generation_id, null);
    assert.equal(forkService.providerCallCount(db, storyboard.id), beforeCalls);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_storyboard_revisions WHERE paper_storyboard_id = ?').get(storyboard.id).count, beforeRevisionCount);

    const duplicate = forkService.forkDraft(db, log, storyboard.id, {
      request_id: requestId,
      source_revision_id: sourceRevisionId,
      expected_version: published.version,
      preview_fingerprint: preview.preview_fingerprint,
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.audit.id, forked.audit.id);

    const saved = storyboardService.update(db, log, storyboard.id, {
      request_id: randomUUID(),
      expected_version: forked.storyboard.version,
      dialogue: '从旧版继续写出的第三版对白',
    });
    assert.notEqual(saved.current_revision_id, sourceRevisionId);
    const newRevision = db.prepare('SELECT * FROM paper_storyboard_revisions WHERE id = ?').get(saved.current_revision_id);
    assert.equal(newRevision.created_from, 'history_fork_edit');
    const audit = db.prepare('SELECT * FROM paper_history_fork_audits WHERE id = ?').get(forked.audit.id);
    assert.equal(Number(audit.target_storyboard_revision_id), Number(saved.current_revision_id));
    assert.equal(Number(audit.provider_call_count_before), Number(audit.provider_call_count_after));
  } finally {
    db.close();
  }
});

test('复制历史 R 只创建当前分镜生产副本并在确认后零调用复用旧图', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-history-fork-run-'));
  const cfg = { storage: { local_path: storageRoot }, paper_studio: { fps: 30 } };
  const { db, project, episode, storyboard } = setup();
  try {
    db.prepare(`INSERT INTO ai_service_configs
      (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
      VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`)
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    const sourceRun = runService.create(db, log, {
      request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
      paper_storyboard_ids: [storyboard.id],
      expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
      image_provider_config_id: 1,
    }).run;
    const analyzed = analyzerService.analyzeRun(db, log, sourceRun.id, {
      request_id: randomUUID(), expected_version: sourceRun.version,
    }, { fps: 30 }).run;
    const sourceShot = shotService.get(db, analyzed.shots[0].id);
    const sourceSlot = sourceShot.families.flatMap((family) => family.slots).find((slot) => slot.required_for_gate);
    const relative = 'projects/1/paper-studio/fork-run/source.png';
    const absolute = path.join(storageRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from('fork-run-approved-image'));
    const hash = sha256(fs.readFileSync(absolute));
    const now = '2026-08-01T05:00:00.000Z';
    const sourceVersionId = Number(db.prepare(
      `INSERT INTO paper_asset_versions
        (slot_id, source_family_id, attempt_index, derivation_kind, source_local_path,
         source_hash, reuse_fingerprint, processing_json, registration_json,
         provenance_json, quality_report_json, status, created_at, accepted_at)
       VALUES (?, ?, 1, 'image_api', ?, ?, ?, '{}', '{}', '{}', '{}', 'accepted', ?, ?)`,
    ).run(Number(sourceSlot.id), Number(sourceSlot.family_id), relative, hash, sourceSlot.reuse_fingerprint, now, now).lastInsertRowid);
    db.prepare("UPDATE paper_asset_slots SET current_version_id = ?, status = 'ready' WHERE id = ?")
      .run(sourceVersionId, Number(sourceSlot.id));
    db.prepare(
      `INSERT INTO paper_asset_review_decisions
        (shot_id, slot_id, asset_version_id, decision, reason, reviewer, request_id, created_at)
       VALUES (?, ?, ?, 'approved', '源图已确认', 'local_owner', ?, ?)`,
    ).run(Number(sourceShot.id), Number(sourceSlot.id), sourceVersionId, randomUUID(), now);

    const currentStoryboard = storyboardService.get(db, storyboard.id);
    const preview = forkService.buildPreview(db, storyboard.id, {
      source: { kind: 'run', id: sourceRun.id, plan_revision_id: sourceShot.current_plan_revision_id },
      target_mode: 'production_copy',
      expected_version: currentStoryboard.version,
    }, { cfg });
    assert.equal(preview.scope, 'storyboard_only');
    assert.equal(preview.asset_impact.exact_reuse_count >= 1, true);
    assert.equal(preview.provider_call_count_before, forkService.providerCallCount(db, storyboard.id));
    const requestId = randomUUID();
    const forked = forkService.forkRun(db, cfg, log, storyboard.id, {
      request_id: requestId,
      source_run_id: sourceRun.id,
      source_plan_revision_id: sourceShot.current_plan_revision_id,
      scope: 'storyboard_only',
      expected_version: currentStoryboard.version,
      preview_fingerprint: preview.preview_fingerprint,
      confirmation: { actor: 'local_owner', reason: 'history_production_copy_confirmed' },
    });
    assert.equal(forked.provider_call_delta, 0);
    assert.notEqual(forked.run.id, sourceRun.id);
    assert.equal(forked.run.shots.length, 1);
    assert.equal(Number(forked.run.shots[0].paper_storyboard_revision_id), Number(storyboard.current_revision_id));
    assert.equal(forked.run.status, 'plan_review');
    const targetShot = shotService.get(db, forked.run.shots[0].id);
    assert.ok(targetShot.current_plan_revision_id);
    assert.equal(targetShot.families.flatMap((family) => family.slots).every((slot) => slot.current_version_id == null), true);
    assert.equal(forkService.providerCallCount(db, storyboard.id), preview.provider_call_count_before);

    const confirmed = analyzerService.confirmPlan(db, log, forked.run.id, {
      request_id: randomUUID(), expected_version: forked.run.version,
    }).run;
    const reusePreview = reuseService.buildReusePreview(db, cfg, confirmed.id, {
      expected_version: confirmed.version,
      shot_ids: [Number(confirmed.shots[0].id)],
    });
    const exact = reusePreview.slots.find((slot) => slot.source_kind === 'historical_reuse' && slot.source_asset_version_id === sourceVersionId);
    assert.ok(exact);
    db.prepare('UPDATE paper_asset_slots SET reuse_fingerprint = ? WHERE id = ?')
      .run('sha256:requires-human-review', Number(exact.slot_id));
    const reviewPreview = reuseService.buildReusePreview(db, cfg, confirmed.id, {
      expected_version: confirmed.version,
      shot_ids: [Number(confirmed.shots[0].id)],
    });
    const reviewCandidate = reviewPreview.slots.find((slot) => slot.source_kind === 'history_review_required' && slot.source_asset_version_id === sourceVersionId);
    assert.ok(reviewCandidate);
    await assert.rejects(
      reuseService.applyReviewDecisions(db, cfg, log, confirmed.id, {
        request_id: randomUUID(), expected_version: confirmed.version,
        reuse_preview_fingerprint: reviewPreview.reuse_preview_fingerprint,
        shot_ids: [Number(confirmed.shots[0].id)],
        review_decisions: [{
          slot_id: Number(reviewCandidate.slot_id),
          source_asset_version_id: sourceVersionId,
          decision: 'accepted',
        }],
      }),
      (error) => error.code === 'PAPER_STUDIO_REUSE_USER_CONFIRMATION_REQUIRED',
    );
    const applied = await reuseService.applyReviewDecisions(db, cfg, log, confirmed.id, {
      request_id: randomUUID(),
      expected_version: confirmed.version,
      reuse_preview_fingerprint: reviewPreview.reuse_preview_fingerprint,
      shot_ids: [Number(confirmed.shots[0].id)],
      review_decisions: [{
        slot_id: Number(reviewCandidate.slot_id),
        source_asset_version_id: sourceVersionId,
        decision: 'accepted',
      }],
      confirmation: {
        actor: 'local_owner', reason: 'historical_review_reuse_confirmed',
      },
    });
    assert.equal(applied.provider_call_delta, 0);
    const reviewedLink = db.prepare(
      "SELECT * FROM paper_asset_reuse_links WHERE source_asset_version_id = ? AND match_kind = 'review' ORDER BY id DESC LIMIT 1",
    ).get(sourceVersionId);
    assert.ok(reviewedLink);
    assert.equal(reuseService.latestReviewDecision(db, reviewedLink.target_asset_version_id).reviewer, 'local_owner');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
