const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const imageClient = require('../src/services/imageClient');
const projectService = require('../src/services/paper-studio/paperStudioProjectService');
const episodeService = require('../src/services/paper-studio/paperStudioEpisodeService');
const storyboardService = require('../src/services/paper-studio/paperStoryboardService');
const referenceService = require('../src/services/paper-studio/paperStoryboardReferenceService');
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const authorizationService = require('../src/services/paper-studio/paperGenerationAuthorizationService');
const assetService = require('../src/services/paper-studio/paperAssetProductionService');
const assetReviewService = require('../src/services/paper-studio/paperAssetReviewService');
const assetWorkspaceService = require('../src/services/paper-studio/paperAssetWorkspaceService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

async function png({ transparent = true, color = { r: 151, g: 65, b: 54 } } = {}) {
  const background = transparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : { r: 235, g: 228, b: 210, alpha: 1 };
  return sharp({ create: { width: 320, height: 180, channels: 4, background } })
    .composite([{ input: Buffer.from(`<svg width="320" height="180"><rect x="100" y="32" width="120" height="130" rx="18" fill="rgb(${color.r},${color.g},${color.b})"/></svg>`) }])
    .png().toBuffer();
}

async function setup(storyboardOverrides = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-ux2-'));
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-26T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'素材闭环',?,?)").run(now, now);
  db.prepare(`INSERT INTO ai_service_configs
    (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
    VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '纸片第一集' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(), title: '抵达候车区', description: '旧车站候车区全景，画面右侧有长椅',
    action: '人物提起行李箱，从左走到右侧长椅并坐下', duration: 6,
    ...storyboardOverrides,
  }).storyboard;
  return { db, storage, project, episode, storyboard };
}

function createConfirmedRun(db, project, episode, storyboard) {
  const draft = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
    paper_storyboard_ids: [storyboard.id],
    expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
    image_provider_config_id: 1,
  }).run;
  const analyzed = analyzerService.analyzeRun(db, log, draft.id, {
    request_id: randomUUID(), expected_version: draft.version,
  }, { fps: 30 }).run;
  return analyzerService.confirmPlan(db, log, draft.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  }).run;
}

function authorize(db, runId, { shotIds = null, slotIds = null } = {}) {
  const run = runService.get(db, runId);
  const quote = authorizationService.buildQuote(db, run.id, {
    request_id: randomUUID(), expected_version: run.version,
    ...(shotIds ? { shot_ids: shotIds } : {}),
    ...(slotIds ? { slot_ids: slotIds } : {}),
  });
  const authorization = authorizationService.authorize(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version,
    quote_fingerprint: quote.quote_fingerprint, confirmed: true,
    shot_ids: quote.shot_ids,
    ...(slotIds ? { slot_ids: slotIds } : {}),
  }).authorization;
  authorizationService.execute(db, log, authorization.id, {
    request_id: randomUUID(), expected_version: authorization.version,
  });
  return { quote, authorization: authorizationService.get(db, authorization.id) };
}

test('uploaded reference candidates keep history, can be selected, and freeze composition constraints', async () => {
  const { db, storage, storyboard } = await setup();
  try {
    const firstBuffer = await png({ transparent: false, color: { r: 92, g: 105, b: 120 } });
    const first = await referenceService.upload(db, { storage: { local_path: storage } }, log, storyboard.id, {
      request_id: randomUUID(), expected_version: storyboard.version, select: true,
    }, { buffer: firstBuffer, originalname: 'reference-a.png', mimetype: 'image/png', size: firstBuffer.length });
    assert.equal(first.references.length, 1);
    assert.equal(first.reference.status, 'selected');
    assert.equal(first.storyboard.current_reference_version_id, first.reference.id);

    const secondBuffer = await png({ transparent: false, color: { r: 170, g: 116, b: 72 } });
    const second = await referenceService.upload(db, { storage: { local_path: storage } }, log, storyboard.id, {
      request_id: randomUUID(), expected_version: first.storyboard.version, select: false,
    }, { buffer: secondBuffer, originalname: 'reference-b.png', mimetype: 'image/png', size: secondBuffer.length });
    assert.equal(second.references.length, 2);
    assert.equal(second.reference.status, 'candidate');
    const selected = referenceService.select(db, log, storyboard.id, second.reference.id, {
      request_id: randomUUID(), expected_version: second.storyboard.version,
    });
    assert.equal(selected.storyboard.current_reference_version_id, second.reference.id);
    assert.equal(selected.references.find((item) => item.id === first.reference.id).status, 'candidate');

    const constrained = referenceService.updateConstraints(db, log, storyboard.id, second.reference.id, {
      request_id: randomUUID(), expected_version: selected.storyboard.version,
      constraints: {
        subject_boxes: [{ key: 'actor_1', label: '人物', x: 0.08, y: 0.16, width: 0.22, height: 0.66 }],
        movement_boxes: [{ key: 'actor_path', label: '可移动区域', x: 0.06, y: 0.12, width: 0.78, height: 0.72 }],
        subtitle_safe_area: { x: 0.08, y: 0.8, width: 0.84, height: 0.14 },
      },
    });
    assert.equal(constrained.storyboard.reference_constraints_json.subject_boxes[0].key, 'actor_1');
    const revision = db.prepare('SELECT content_json FROM paper_storyboard_revisions WHERE id = ?').get(constrained.storyboard.current_revision_id);
    assert.equal(JSON.parse(revision.content_json).reference_constraints.subject_boxes[0].key, 'actor_1');
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('a confirmed blueprint can be completed entirely with local uploads before any image authorization', async () => {
  const { db, storage, project, episode, storyboard } = await setup({
    title: '本地素材制作',
    description: '人物站在画面左侧，右侧留出移动空间',
    action: '人物提起道具箱，从画面左侧走到右侧停下，再将道具箱放到地面',
  });
  const run = createConfirmedRun(db, project, episode, storyboard);
  const opaque = await png({ transparent: false });
  const cutout = await png();
  try {
    let latest = shotService.get(db, run.shots[0].id);
    const slots = latest.families.flatMap((family) => family.slots);
    assert.equal(slots.length, 5);
    assert.equal(latest.status, 'plan_confirmed');
    for (const slot of slots) {
      const buffer = slot.asset_type === 'environment' ? opaque : cutout;
      const uploaded = await assetWorkspaceService.uploadReplacement(db, { storage: { local_path: storage } }, log, latest.id, slot.id, {
        request_id: randomUUID(), expected_version: latest.version,
      }, { buffer, originalname: `${slot.slot_key}.png`, mimetype: 'image/png', size: buffer.length });
      latest = uploaded.shot;
    }
    assert.equal(latest.status, 'asset_review');
    assert.equal(latest.asset_review_progress.total, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_generation_authorizations WHERE run_id = ?').get(run.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_versions WHERE derivation_kind = 'image_api'").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('asset review is per current version and only opens motion after every visible material is approved', async () => {
  const { db, storage, project, episode, storyboard } = await setup();
  const run = createConfirmedRun(db, project, episode, storyboard);
  const original = imageClient.callImageApi;
  const opaque = await png({ transparent: false, color: { r: 72, g: 83, b: 91 } });
  const cutout = await png();
  imageClient.callImageApi = async (unusedDb, unusedLog, options) => ({
    image_url: `data:image/png;base64,${(/clean plate/i.test(options.prompt) ? opaque : cutout).toString('base64')}`,
  });
  try {
    const { authorization } = authorize(db, run.id);
    const before = shotService.get(db, run.shots[0].id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: before.version, authorization_id: authorization.id,
    });
    const ids = assetReviewService.currentVersions(db, before.id).map((row) => Number(row.id));
    assert.equal(ids.length >= 5, true);
    let latest = generated.shot;
    for (let index = 0; index < ids.length; index += 1) {
      const result = assetReviewService.review(db, log, before.id, {
        request_id: randomUUID(), expected_version: latest.version,
        action: 'approve', asset_version_ids: [ids[index]],
      });
      latest = result.shot;
      assert.equal(result.progress.approved, index + 1);
      assert.equal(latest.status, index === ids.length - 1 ? 'asset_ready' : 'asset_review');
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_review_decisions WHERE decision = 'approved'").get().count, ids.length);
    assert.equal(latest.asset_review_progress.complete, true);
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('slot-scoped authorization regenerates only one image slot and preserves every other current version', async () => {
  const { db, storage, project, episode, storyboard } = await setup();
  const run = createConfirmedRun(db, project, episode, storyboard);
  const original = imageClient.callImageApi;
  const opaque = await png({ transparent: false });
  const cutout = await png();
  let calls = 0;
  imageClient.callImageApi = async (unusedDb, unusedLog, options) => {
    calls += 1;
    return { image_url: `data:image/png;base64,${(/clean plate/i.test(options.prompt) ? opaque : cutout).toString('base64')}` };
  };
  try {
    const initialAuthorization = authorize(db, run.id).authorization;
    const before = shotService.get(db, run.shots[0].id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: before.version, authorization_id: initialAuthorization.id,
    });
    const slotsBefore = new Map(generated.shot.families.flatMap((family) => family.slots).map((slot) => [slot.id, slot.current_version?.id || null]));
    const target = generated.shot.families.flatMap((family) => family.slots)
      .find((slot) => slot.current_version?.derivation_kind === 'image_api' && slot.asset_type !== 'environment');
    const scoped = authorize(db, run.id, { shotIds: [before.id], slotIds: [target.id] });
    assert.equal(scoped.quote.estimated_image_count, 1);
    assert.deepEqual(scoped.quote.requested_slot_ids, [target.id]);
    assert.equal(scoped.quote.slots[0].force_regeneration, true);
    const live = shotService.get(db, before.id);
    const regenerated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: live.version, authorization_id: scoped.authorization.id,
    });
    assert.equal(calls, 6);
    for (const slot of regenerated.shot.families.flatMap((family) => family.slots)) {
      if (slot.id === target.id) assert.notEqual(slot.current_version.id, slotsBefore.get(slot.id));
      else assert.equal(slot.current_version?.id || null, slotsBefore.get(slot.id));
    }
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('transparent upload replacement and point Mask patch create auditable local versions without image API', async () => {
  const { db, storage, project, episode, storyboard } = await setup();
  const run = createConfirmedRun(db, project, episode, storyboard);
  const original = imageClient.callImageApi;
  const opaque = await png({ transparent: false });
  const cutout = await png();
  let calls = 0;
  imageClient.callImageApi = async (unusedDb, unusedLog, options) => {
    calls += 1;
    return { image_url: `data:image/png;base64,${(/clean plate/i.test(options.prompt) ? opaque : cutout).toString('base64')}` };
  };
  try {
    const authorization = authorize(db, run.id).authorization;
    const before = shotService.get(db, run.shots[0].id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: before.version, authorization_id: authorization.id,
    });
    const target = generated.shot.families.flatMap((family) => family.slots)
      .find((slot) => slot.asset_type.includes('character') || slot.asset_type.includes('subject'));
    await assert.rejects(
      () => assetWorkspaceService.uploadReplacement(db, { storage: { local_path: storage } }, log, before.id, target.id, {
        request_id: randomUUID(), expected_version: generated.shot.version,
      }, { buffer: opaque, originalname: 'opaque.png', mimetype: 'image/png', size: opaque.length }),
      (error) => error.code === 'PAPER_STUDIO_ASSET_UPLOAD_ALPHA_REQUIRED',
    );
    const replacement = await assetWorkspaceService.uploadReplacement(db, { storage: { local_path: storage } }, log, before.id, target.id, {
      request_id: randomUUID(), expected_version: generated.shot.version,
    }, { buffer: cutout, originalname: 'transparent.png', mimetype: 'image/png', size: cutout.length });
    assert.equal(replacement.shot.status, 'asset_review');
    assert.equal(replacement.report.pass, true);
    assert.equal(calls, 5);
    const patched = await assetWorkspaceService.patchMask(db, { storage: { local_path: storage } }, log, before.id, replacement.asset_version_id, {
      request_id: randomUUID(), expected_version: replacement.shot.version,
      feather: 0.4,
      points: [
        { kind: 'background', x: 0.5, y: 0.15, radius: 0.08, strength: 1 },
        { kind: 'foreground', x: 0.5, y: 0.55, radius: 0.05, strength: 0.7 },
      ],
    });
    assert.notEqual(patched.asset_version_id, replacement.asset_version_id);
    assert.equal(patched.shot.status, 'asset_review');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM paper_asset_mask_edits').get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_review_decisions WHERE decision = 'replaced'").get().count >= 2, true);
    assert.equal(calls, 5);
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});
