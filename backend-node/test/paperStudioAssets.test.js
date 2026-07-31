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
const runService = require('../src/services/paper-studio/paperStudioRunService');
const shotService = require('../src/services/paper-studio/paperStudioShotService');
const analyzerService = require('../src/services/paper-studio/paperStudioAnalyzerService');
const assetService = require('../src/services/paper-studio/paperAssetProductionService');
const assetReviewService = require('../src/services/paper-studio/paperAssetReviewService');
const motionGateService = require('../src/services/paper-studio/paperMotionGateService');
const snapshotService = require('../src/services/paper-studio/paperSnapshotService');
const schemaService = require('../src/services/paper-studio/paperStudioSchemaService');
const renderService = require('../src/services/paper-studio/paperStudioRenderService');
const authorizationService = require('../src/services/paper-studio/paperGenerationAuthorizationService');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

async function setup() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-assets-'));
  fs.mkdirSync(path.join(storage, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(storage, 'props'), { recursive: true });
  await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 92, g: 113, b: 118, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg width="640" height="360"><path d="M0 230 Q180 210 360 235 T640 220 V360 H0Z" fill="#526a70"/></svg>'), top: 0, left: 0 }])
    .png().toFile(path.join(storage, 'scenes', 'river.png'));
  await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 244, g: 241, b: 231, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg width="640" height="360"><path d="M90 185 Q320 130 550 185 L505 245 L130 245Z" fill="#4f382b"/><path d="M130 180 L145 135 M500 180 L485 130" stroke="#31231c" stroke-width="10"/></svg>'), top: 0, left: 0 }])
    .png().toFile(path.join(storage, 'props', 'boat.png'));
  const soldierPng = await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="640" height="360"><g fill="#493c35"><circle cx="250" cy="100" r="32"/><path d="M210 135 L290 135 L310 285 L185 285Z"/><circle cx="380" cy="105" r="30"/><path d="M340 140 L420 140 L455 285 L330 285Z"/></g></svg>'), top: 0, left: 0 }])
    .png().toBuffer();

  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-24T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,'沉船断路',?,?)").run(now, now);
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (10,1,1,'第一集',?,?)").run(now, now);
  db.prepare("INSERT INTO scenes (id,drama_id,episode_id,location,prompt,local_path,created_at,updated_at) VALUES (8,1,10,'漳河','无人河岸','scenes/river.png',?,?)").run(now, now);
  db.prepare("INSERT INTO props (id,drama_id,episode_id,name,type,description,local_path,created_at,updated_at) VALUES (20,1,10,'楚军渡河木船','军用舟具','秦末木船','props/boat.png',?,?)").run(now, now);
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at) VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','[\"gpt-image-2\"]','gpt-image-2',1,1,?,?)").run(now, now);
  db.prepare("INSERT INTO storyboards (id,episode_id,scene_id,storyboard_number,title,description,action,result,duration,local_path,created_at,updated_at) VALUES (101,10,8,1,'沉船断路','凿沉木船','士卒推船，船尾翘起并沉入河水','只剩气泡',4,'props/boat.png',?,?)").run(now, now);
  db.prepare('INSERT INTO storyboard_props (storyboard_id,prop_id) VALUES (101,20)').run();
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const draft = runService.create(db, log, { request_id: randomUUID(), project_id: project.id, episode_id: 10, storyboard_ids: [101] }).run;
  const analyzed = analyzerService.analyzeRun(db, log, draft.id, { request_id: randomUUID(), expected_version: draft.version }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, draft.id, { request_id: randomUUID(), expected_version: analyzed.version }).run;
  return { db, storage, run: confirmed, soldierPng, riverPng: fs.readFileSync(path.join(storage, 'scenes', 'river.png')) };
}

async function setupIndependentEnvironment() {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-environment-'));
  fs.mkdirSync(path.join(storage, 'references'), { recursive: true });
  const referencePath = 'references/zhanghe-cold-mist.png';
  const referencePng = await sharp({
    create: { width: 640, height: 360, channels: 4, background: { r: 52, g: 58, b: 57, alpha: 1 } },
  }).composite([{
    input: Buffer.from('<svg width="640" height="360"><path d="M0 240 Q210 180 640 215 V360 H0Z" fill="#697879"/><path d="M330 155 L430 155 L455 235 L305 235Z" fill="#252725"/><path d="M470 225 L540 170 L610 225Z" fill="#8a4e35"/></svg>'),
    top: 0,
    left: 0,
  }]).png().toBuffer();
  fs.writeFileSync(path.join(storage, referencePath), referencePng);

  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = '2026-07-27T00:00:00.000Z';
  db.prepare("INSERT INTO dramas (id,title,style,metadata,created_at,updated_at) VALUES (1,'漳河寒雾','custom:1',?, ?, ?)")
    .run(JSON.stringify({ style_prompt_en: 'photorealistic RAW photo marker', scene_style_prompt_en: 'generic bright landscape marker' }), now, now);
  db.prepare(`INSERT INTO ai_service_configs
    (id,service_type,provider,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at)
    VALUES (1,'image','openai','测试图片模型','https://example.invalid','test-key','["gpt-image-2"]','gpt-image-2',1,1,?,?)`).run(now, now);
  const project = projectService.create(db, log, 1, { request_id: randomUUID() }).project;
  const episode = episodeService.create(db, log, project.id, { request_id: randomUUID(), title: '漳河之战' }).episode;
  const storyboard = storyboardService.create(db, log, episode.id, {
    request_id: randomUUID(),
    title: '漳河寒雾',
    description: '漳河两岸被寒雾覆盖，远处城池、焚毁营帐、船只与废墟若隐若现',
    visual_prompt: '阴冷战争遗迹，深灰矿物颜料和旧纸肌理',
    action: '',
    environment_only: true,
    duration: 10,
    reference_local_path: referencePath,
  }).storyboard;
  const draft = runService.create(db, log, {
    request_id: randomUUID(), project_id: project.id, paper_episode_id: episode.id,
    paper_storyboard_ids: [storyboard.id],
    expected_paper_storyboard_revisions: { [storyboard.id]: storyboard.current_revision_id },
    image_provider_config_id: 1,
  }).run;
  const analyzed = analyzerService.analyzeRun(db, log, draft.id, {
    request_id: randomUUID(), expected_version: draft.version,
  }, { fps: 30 }).run;
  const confirmed = analyzerService.confirmPlan(db, log, analyzed.id, {
    request_id: randomUUID(), expected_version: analyzed.version,
  }).run;
  return { db, storage, run: confirmed, storyboard, referencePath, referencePng };
}

function authorizeGeneration(db, runId) {
  const run = runService.get(db, runId);
  const quote = authorizationService.buildQuote(db, run.id, { request_id: randomUUID(), expected_version: run.version });
  const authorization = authorizationService.authorize(db, log, run.id, {
    request_id: randomUUID(), expected_version: run.version, quote_fingerprint: quote.quote_fingerprint, confirmed: true,
  }).authorization;
  authorizationService.execute(db, log, authorization.id, { request_id: randomUUID(), expected_version: authorization.version });
  return authorization.id;
}

function approveAllCurrentAssets(db, shotId) {
  const ids = assetReviewService.currentVersions(db, shotId).map((row) => Number(row.id));
  let result = { shot: shotService.get(db, shotId) };
  for (const assetVersionId of ids) {
    result = assetReviewService.review(db, log, shotId, {
      request_id: randomUUID(), expected_version: result.shot.version,
      action: 'approve', asset_version_ids: [assetVersionId],
    });
  }
  return result;
}

test('asset production generates clean transparent layers from reusable references and writes immutable accepted versions', async () => {
  const { db, storage, run, soldierPng, riverPng } = await setup();
  const original = imageClient.callImageApi;
  let apiCalls = 0;
  const actorReferenceSets = [];
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => {
    apiCalls += 1;
    if (opts.prompt.includes('Subject: 士卒')) actorReferenceSets.push(opts.reference_image_urls || []);
    const image = /clean plate/i.test(opts.prompt) ? riverPng : soldierPng;
    return { image_url: `data:image/png;base64,${image.toString('base64')}` };
  };
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const before = shotService.get(db, run.shots[0].id);
    const result = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: before.version, authorization_id: authorizationId,
    });
    assert.equal(apiCalls, 5);
    assert.equal(actorReferenceSets.length, 3);
    assert.ok(actorReferenceSets.every((references) => references.every((reference) => !reference.includes('support_body'))));
    const cleanReferences = assetService.referenceImagesForSlot(db, result.shot, result.shot.families.flatMap((family) => family.slots).find((slot) => slot.slot_key === 'clean_plate'), {
      capabilities: { reference_images: true, max_reference_images: 4 },
    });
    assert.equal(cleanReferences.length, 0);
    assert.ok(cleanReferences.every((reference) => !reference.includes('boundary_front_mask')));
    assert.ok(cleanReferences.every((reference) => !reference.includes('boat.png')));
    assert.equal(result.shot.status, 'asset_review');
    assert.equal(runService.get(db, run.id).status, 'assets_processing');
    const accepted = db.prepare("SELECT * FROM paper_asset_versions WHERE status = 'accepted' ORDER BY id").all();
    assert.equal(accepted.length, 7);
    assert.ok(accepted.every((version) => version.source_hash?.startsWith('sha256:')));
    assert.equal(accepted.filter((version) => version.derivation_kind === 'image_api').length, 5);
    assert.equal(accepted.filter((version) => version.derivation_kind === 'image_api' && version.alpha_local_path).length, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE generation_kind = 'paper_studio_asset' AND status = 'completed'").get().count, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_slots WHERE required_for_gate = 1 AND status != 'ready'").get().count, 0);
    assert.ok(accepted.every((version) => fs.existsSync(path.join(storage, version.source_local_path))));

    const approvedAssets = approveAllCurrentAssets(db, result.shot.id);
    assert.equal(approvedAssets.shot.status, 'asset_ready');
    assert.equal(runService.get(db, run.id).status, 'motion_planning');
    const motion = motionGateService.planMotion(db, { storage: { local_path: storage }, paper_studio: { renderer_version: 'paper-studio-v3', proof_rule_version: 'paper-proof-v3' } }, log, result.shot.id, {
      request_id: randomUUID(), expected_version: approvedAssets.shot.version,
    });
    assert.equal(motion.shot.status, 'motion_ready');
    assert.equal(motion.gate.camera_only, false);
    assert.equal(motion.gate.assertions.every((assertion) => assertion.pass), true);
    assert.match(motion.snapshot.snapshot_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(motion.snapshot.render_hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(storage, motion.snapshot.local_path)));
    const frozen = snapshotService.get(db, motion.snapshot.id).snapshot_json;
    assert.equal(schemaService.validate('renderSnapshotV3', frozen).valid, true);
    const actors = frozen.root.children.find((node) => node.key === 'supported_group').children.find((node) => node.key === 'actors');
    assert.deepEqual(Object.keys(actors.relation.state_asset_version_ids), ['engage', 'destabilize', 'separate']);
    const repeated = snapshotService.compile(db, { storage: { local_path: storage }, paper_studio: { renderer_version: 'paper-studio-v3', proof_rule_version: 'paper-proof-v3' } }, result.shot.id);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.render_hash, motion.snapshot.render_hash);
  } finally {
    imageClient.callImageApi = original;
    db.close();
  }
});

test('independent environment plate reuses the selected composition reference without an image call', async () => {
  const { db, storage, run, referencePath } = await setupIndependentEnvironment();
  const original = imageClient.callImageApi;
  let apiCalls = 0;
  imageClient.callImageApi = async () => {
    apiCalls += 1;
    throw new Error('environment reference reuse must not call the image API');
  };
  try {
    const before = shotService.get(db, run.shots[0].id);
    const cleanSlot = before.families[0].slots.find((slot) => slot.slot_key === 'clean_plate');
    const references = assetService.referenceImagesForSlot(db, before, cleanSlot, {
      capabilities: { reference_images: true, max_reference_images: 4 },
    });
    assert.deepEqual(references, [referencePath]);
    const prompt = assetService.promptForSlot(db, before, cleanSlot);
    assert.match(prompt, /SELECTED STORYBOARD REFERENCE — highest priority/);
    assert.match(prompt, /漳河两岸被寒雾覆盖/);
    assert.match(prompt, /焚毁营帐、船只与废墟/);
    assert.match(prompt, /selected reference overrides that conflict/);
    assert.doesNotMatch(prompt, /Do not visualize anything from the storyboard/);

    const quote = authorizationService.buildQuote(db, run.id, {
      request_id: randomUUID(), expected_version: run.version,
    });
    assert.equal(quote.estimated_image_count, 0);
    assert.deepEqual(quote.slots, []);
    const authorizationId = authorizeGeneration(db, run.id);
    const readyToGenerate = shotService.get(db, before.id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: readyToGenerate.version, authorization_id: authorizationId,
    });
    assert.equal(apiCalls, 0);
    const version = generated.shot.families[0].slots.find((slot) => slot.slot_key === 'clean_plate').current_version;
    assert.equal(version.derivation_kind, 'source_import');
    assert.equal(version.provenance_json.source_kind, 'storyboard_reference');
    assert.equal(version.provenance_json.local_path, referencePath);
    assert.equal(version.quality_report_json.width, 640);
    assert.equal(version.quality_report_json.height, 360);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_generations WHERE paper_asset_version_id = ?').get(version.id).count, 0);
    const approved = assetReviewService.review(db, log, before.id, {
      request_id: randomUUID(), expected_version: generated.shot.version,
      action: 'approve', asset_version_ids: [Number(version.id)],
    });
    assert.equal(approved.shot.status, 'asset_ready');
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('explicit environment plate regeneration remains opt-in and keeps the composition reference gate', async () => {
  const { db, storage, run, referencePath, referencePng } = await setupIndependentEnvironment();
  const original = imageClient.callImageApi;
  let request = null;
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => {
    request = opts;
    return { image_url: `data:image/png;base64,${referencePng.toString('base64')}` };
  };
  try {
    const before = shotService.get(db, run.shots[0].id);
    const cleanSlot = before.families[0].slots.find((slot) => slot.slot_key === 'clean_plate');
    const quote = authorizationService.buildQuote(db, run.id, {
      request_id: randomUUID(), expected_version: run.version,
      shot_ids: [before.id], slot_ids: [cleanSlot.id],
    });
    assert.equal(quote.estimated_image_count, 1);
    assert.equal(quote.slots[0].force_regeneration, true);
    const authorization = authorizationService.authorize(db, log, run.id, {
      request_id: randomUUID(), expected_version: run.version,
      quote_fingerprint: quote.quote_fingerprint, confirmed: true,
      shot_ids: quote.shot_ids, slot_ids: quote.requested_slot_ids,
    }).authorization;
    authorizationService.execute(db, log, authorization.id, {
      request_id: randomUUID(), expected_version: authorization.version,
    });
    const readyToGenerate = shotService.get(db, before.id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: readyToGenerate.version, authorization_id: authorization.id,
    });
    assert.deepEqual(request.reference_image_urls, [referencePath]);
    assert.match(request.system_prompt, /selected storyboard reference and the primary visual authority/);
    assert.match(request.user_negative_prompt, /changed era/);
    const version = generated.shot.families[0].slots.find((slot) => slot.slot_key === 'clean_plate').current_version;
    assert.equal(version.derivation_kind, 'image_api');
    assert.equal(version.quality_report_json.reference_count, 1);
    assert.equal(version.quality_report_json.reference_required, true);
    assert.equal(version.quality_report_json.reference_gate_passed, true);
    assert.equal(version.provenance_json.reference_evidence[0].local_path, referencePath);
    assert.match(version.provenance_json.reference_evidence[0].content_hash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('optional procedural state is free, auto-adopted, and repairs an already stuck motion run', async () => {
  const { db, storage, run, soldierPng, riverPng } = await setup();
  const original = imageClient.callImageApi;
  let apiCalls = 0;
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => {
    apiCalls += 1;
    const image = /clean plate/i.test(opts.prompt) ? riverPng : soldierPng;
    return { image_url: `data:image/png;base64,${image.toString('base64')}` };
  };
  try {
    const before = shotService.get(db, run.shots[0].id);
    const stateSlots = before.families.flatMap((family) => family.slots)
      .filter((slot) => slot.constraints_json?.state);
    assert.ok(stateSlots.length >= 3);
    const transitionSlot = stateSlots[1];
    db.prepare('UPDATE paper_asset_slots SET required_for_gate = 0, constraints_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...transitionSlot.constraints_json, fallback: 'procedural' }), transitionSlot.id);

    const authorizationId = authorizeGeneration(db, run.id);
    const readyToGenerate = shotService.get(db, before.id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: readyToGenerate.version, authorization_id: authorizationId,
    });
    assert.equal(apiCalls, 4);
    const automatic = generated.shot.families.flatMap((family) => family.slots)
      .find((slot) => Number(slot.id) === Number(transitionSlot.id)).current_version;
    assert.equal(automatic.derivation_kind, 'procedural_state_fallback');
    assert.equal(automatic.latest_review_decision.reviewer, 'system_procedural_fallback');
    assert.equal(automatic.quality_report_json.auto_accepted, true);

    // Simulate a production version created before this fix: the optional state
    // was skipped, while all visible/paid assets were already approved.
    db.prepare('DELETE FROM paper_asset_review_decisions WHERE asset_version_id = ?').run(automatic.id);
    db.prepare('UPDATE paper_asset_slots SET current_version_id = NULL, status = \'planned\' WHERE id = ?').run(transitionSlot.id);
    db.prepare('DELETE FROM paper_asset_versions WHERE id = ?').run(automatic.id);
    let liveShot = shotService.get(db, before.id);
    const pendingReviewIds = assetReviewService.currentVersions(db, before.id)
      .filter((row) => row.latest_review_decision?.decision !== 'approved')
      .map((row) => Number(row.id));
    for (const assetVersionId of pendingReviewIds) {
      const reviewed = assetReviewService.review(db, log, before.id, {
        request_id: randomUUID(), expected_version: liveShot.version,
        action: 'approve', asset_version_ids: [assetVersionId],
      });
      liveShot = reviewed.shot;
    }
    assert.equal(liveShot.status, 'asset_ready');
    db.prepare("UPDATE paper_studio_shots SET status = 'motion_failed', last_error_json = ?, version = version + 1 WHERE id = ?")
      .run(JSON.stringify({ code: 'PAPER_STUDIO_STATE_ASSET_MISSING', message: '动作状态缺少正式素材版本' }), before.id);
    liveShot = shotService.get(db, before.id);
    const motion = motionGateService.planMotion(db, {
      storage: { local_path: storage },
      paper_studio: { renderer_version: 'paper-studio-v3', proof_rule_version: 'paper-proof-v3' },
    }, log, before.id, { request_id: randomUUID(), expected_version: liveShot.version });
    assert.equal(motion.shot.status, 'motion_ready');
    assert.equal(motion.fallback_repair.repaired_count, 1);
    const repairedSlot = motion.shot.families.flatMap((family) => family.slots)
      .find((slot) => Number(slot.id) === Number(transitionSlot.id));
    assert.equal(repairedSlot.status, 'ready');
    assert.equal(repairedSlot.current_version.derivation_kind, 'procedural_state_fallback');
    assert.equal(repairedSlot.current_version.latest_review_decision.reviewer, 'system_procedural_fallback');
    const frozen = snapshotService.get(db, motion.snapshot.id).snapshot_json;
    const stack = [frozen.root];
    let repairedMapping = null;
    while (stack.length) {
      const current = stack.pop();
      if (current.relation?.state_asset_version_ids
        && Object.values(current.relation.state_asset_version_ids).includes(repairedSlot.current_version.id)) {
        repairedMapping = current.relation.state_asset_version_ids;
        break;
      }
      stack.push(...(current.children || []));
    }
    assert.ok(repairedMapping);
  } finally {
    imageClient.callImageApi = original;
    db.close();
  }
});

test('safe storage resolver rejects traversal before reading or writing assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-path-'));
  assert.throws(
    () => assetService.safeStorageFile({ storage: { local_path: root } }, '../outside.png'),
    (error) => error.code === 'PAPER_STUDIO_ASSET_PATH_INVALID',
  );
});

test('semantic asset review rejects one current version and retries only that slot', async () => {
  const { db, storage, run, soldierPng, riverPng } = await setup();
  const original = imageClient.callImageApi;
  let apiCalls = 0;
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => {
    apiCalls += 1;
    return { image_url: `data:image/png;base64,${(/clean plate/i.test(opts.prompt) ? riverPng : soldierPng).toString('base64')}` };
  };
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const before = shotService.get(db, run.shots[0].id);
    const generated = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, { request_id: randomUUID(), expected_version: before.version, authorization_id: authorizationId });
    assert.equal(apiCalls, 5);
    const cleanSlot = generated.shot.families.flatMap((family) => family.slots).find((slot) => slot.slot_key === 'clean_plate');
    const cleanVersionId = Number(cleanSlot.current_version.id);
    const rejected = assetReviewService.review(db, log, before.id, {
      request_id: randomUUID(), expected_version: generated.shot.version, action: 'reject',
      asset_version_ids: [cleanVersionId], reason: '背景仍包含应当独立生成的船体和关键道具',
    });
    assert.equal(rejected.shot.status, 'asset_failed');
    assert.equal(rejected.shot.families.flatMap((family) => family.slots).find((slot) => slot.slot_key === 'clean_plate').current_version, null);
    assert.equal(db.prepare('SELECT status FROM paper_asset_versions WHERE id = ?').get(cleanVersionId).status, 'rejected');
    const retryAuthorizationId = authorizeGeneration(db, run.id);
    const retryShot = shotService.get(db, before.id);
    const retried = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, { request_id: randomUUID(), expected_version: retryShot.version, authorization_id: retryAuthorizationId });
    assert.equal(retried.shot.status, 'asset_review');
    assert.equal(apiCalls, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_versions WHERE status = 'accepted'").get().count, 7);
  } finally {
    imageClient.callImageApi = original;
    db.close();
  }
});

test('layered clean-plate prompt preserves atmosphere while explicitly removing independent subjects', async () => {
  const { db, storage, run } = await setup();
  try {
    db.prepare("UPDATE storyboards SET atmosphere = 'NARRATIVE_PROP_MARKER 陶片与粮袋散落前景' WHERE id = 101").run();
    const shot = shotService.get(db, run.shots[0].id);
    const cleanSlot = shot.families.flatMap((family) => family.slots).find((slot) => slot.slot_key === 'clean_plate');
    const prompt = assetService.promptForSlot(db, shot, cleanSlot);
    assert.match(prompt, /Preserve fixed terrain, shoreline, water, sky/);
    assert.match(prompt, /Remove only the characters or movable hero props/);
    assert.match(prompt, /Keep the storyboard atmosphere and environmental description/);
    assert.doesNotMatch(prompt, /秦末木船/);
    assert.match(prompt, /NARRATIVE_PROP_MARKER|陶片与粮袋散落前景/);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('prop state overrides damaged source identity for intact, fracture and broken assets', () => {
  assert.match(assetService.propStateInstruction('intact'), /fully intact and unbroken/);
  assert.match(assetService.propStateInstruction('intact'), /overrides any damaged, cracked, broken or shattered wording/);
  assert.match(assetService.propStateInstruction('fracture'), /still mostly whole/);
  assert.match(assetService.propStateInstruction('broken'), /fully broken after impact/);
});

test('paper studio prompts use the project global, scoped and visual-bible style instead of the custom style id', async () => {
  const { db, storage, run } = await setup();
  try {
    db.prepare('UPDATE dramas SET style = ?, metadata = ? WHERE id = 1').run('custom:5', JSON.stringify({
      style_prompt_zh: '全局中文手绘风格标记',
      style_prompt_en: 'GLOBAL HAND-PAINTED STYLE MARKER',
      scene_style_prompt_zh: '场景底板风格标记',
      scene_style_prompt_en: 'SCENE PLATE STYLE MARKER',
      character_style_prompt_zh: '角色纸片风格标记',
      character_style_prompt_en: 'CHARACTER CUTOUT STYLE MARKER',
      prop_style_prompt_zh: '道具纸片风格标记',
      prop_style_prompt_en: 'PROP CUTOUT STYLE MARKER',
      visual_bible_struct: {
        palette: 'VISUAL BIBLE PALETTE MARKER',
        negative: 'VISUAL BIBLE NEGATIVE MARKER',
      },
    }));
    const shot = shotService.get(db, run.shots[0].id);
    const slots = shot.families.flatMap((family) => family.slots);
    const cleanPrompt = assetService.promptForSlot(db, shot, slots.find((slot) => slot.slot_key === 'clean_plate'));
    const characterPrompt = assetService.promptForSlot(db, shot, slots.find((slot) => slot.slot_key === 'actor_engage'));
    const propPrompt = assetService.promptForSlot(db, shot, slots.find((slot) => slot.slot_key === 'support_body'));

    for (const prompt of [cleanPrompt, characterPrompt, propPrompt]) {
      assert.match(prompt, /GLOBAL HAND-PAINTED STYLE MARKER/);
      assert.match(prompt, /全局中文手绘风格标记/);
      assert.match(prompt, /VISUAL BIBLE PALETTE MARKER/);
      assert.match(prompt, /VISUAL BIBLE NEGATIVE MARKER/);
      assert.match(prompt, /Never output photography, live action/);
      assert.doesNotMatch(prompt, /custom:5/);
    }
    assert.match(cleanPrompt, /SCENE PLATE STYLE MARKER/);
    assert.doesNotMatch(cleanPrompt, /CHARACTER CUTOUT STYLE MARKER|PROP CUTOUT STYLE MARKER/);
    assert.match(characterPrompt, /CHARACTER CUTOUT STYLE MARKER/);
    assert.doesNotMatch(characterPrompt, /SCENE PLATE STYLE MARKER|PROP CUTOUT STYLE MARKER/);
    assert.match(propPrompt, /PROP CUTOUT STYLE MARKER/);
    assert.doesNotMatch(propPrompt, /SCENE PLATE STYLE MARKER|CHARACTER CUTOUT STYLE MARKER/);
  } finally {
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('cutout generation falls back to an opaque chroma matte when the provider rejects transparent output', async () => {
  const { db, storage, run, riverPng, soldierPng } = await setup();
  const original = imageClient.callImageApi;
  const backgrounds = [];
  const opaqueCutout = await sharp({
    create: { width: 640, height: 360, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
  }).composite([{ input: soldierPng }]).png().toBuffer();
  db.prepare('UPDATE ai_service_configs SET model = ?, default_model = ? WHERE id = 1')
    .run('["gpt-image-test-local-matte"]', 'gpt-image-test-local-matte');
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => {
    backgrounds.push(opts.background);
    if (opts.background === 'transparent') {
      return { error: 'Transparent background is not supported for this model.' };
    }
    const image = /clean plate/i.test(opts.prompt) ? riverPng : opaqueCutout;
    return { image_url: `data:image/png;base64,${image.toString('base64')}` };
  };
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const before = shotService.get(db, run.shots[0].id);
    const result = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, before.id, {
      request_id: randomUUID(), expected_version: before.version, authorization_id: authorizationId,
    });
    assert.deepEqual(backgrounds, ['opaque', 'transparent', 'opaque', 'opaque', 'opaque', 'opaque']);
    const generated = db.prepare(`
      SELECT pav.processing_json, ig.prompt
      FROM paper_asset_versions pav
      JOIN image_generations ig ON ig.id = pav.image_generation_id
      JOIN paper_asset_slots pas ON pas.id = pav.slot_id
      WHERE pas.family_id IN (SELECT id FROM paper_source_families WHERE shot_id = ?)
        AND pas.asset_type != 'environment' AND pav.status = 'accepted'
      ORDER BY pav.id
    `).all(Number(result.shot.id));
    assert.equal(generated.length, 4);
    assert.ok(generated.every((row) => JSON.parse(row.processing_json).local_matte_fallback === true));
    assert.ok(generated.every((row) => row.prompt.includes('technical chroma-green matte (#00FF00)')));

    const currentCutout = db.prepare(`
      SELECT pas.current_version_id
      FROM paper_asset_slots pas
      JOIN paper_source_families psf ON psf.id = pas.family_id
      WHERE psf.shot_id = ? AND pas.asset_type = 'character-cutout'
      ORDER BY pas.id LIMIT 1
    `).get(Number(result.shot.id));
    const imageCount = db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE generation_kind = 'paper_studio_asset'").get().count;
    const rematted = await assetService.rematteAssets(db, { storage: { local_path: storage } }, log, result.shot.id, {
      request_id: randomUUID(),
      expected_version: result.shot.version,
      asset_version_ids: [Number(currentCutout.current_version_id)],
    });
    assert.equal(rematted.shot.status, 'asset_review');
    assert.equal(rematted.rematted.length, 1);
    assert.equal(rematted.rematted[0].parent_version_id, Number(currentCutout.current_version_id));
    assert.equal(rematted.rematted[0].report.defringe.chroma_green, true);
    assert.ok(rematted.rematted[0].report.residual_key_edge_ratio <= 0.02);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE generation_kind = 'paper_studio_asset'").get().count, imageCount);
    const refined = db.prepare('SELECT * FROM paper_asset_versions WHERE id = ?').get(rematted.rematted[0].asset_version_id);
    assert.equal(refined.derivation_kind, 'matte_refinement');
    assert.equal(Number(refined.parent_version_id), Number(currentCutout.current_version_id));
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('local chroma matte removes RGB green spill as well as creating alpha', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-defringe-'));
  const inputPath = path.join(root, 'green-source.png');
  const outputPath = path.join(root, 'cutout.png');
  const width = 96;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0; pixels[offset + 1] = 255; pixels[offset + 2] = 0; pixels[offset + 3] = 255;
      if (x >= 20 && x <= 75 && y >= 12 && y <= 51) {
        const outer = x === 20 || x === 75 || y === 12 || y === 51;
        const inner = x === 21 || x === 74 || y === 13 || y === 50;
        if (outer) {
          pixels[offset] = 40; pixels[offset + 1] = 210; pixels[offset + 2] = 20;
        } else if (inner) {
          pixels[offset] = 70; pixels[offset + 1] = 150; pixels[offset + 2] = 30;
        } else {
          pixels[offset] = 105; pixels[offset + 1] = 70; pixels[offset + 2] = 40;
        }
      }
    }
  }
  try {
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(inputPath);
    const report = await assetService.alphaReport(inputPath, outputPath, { requireAlpha: true });
    assert.equal(report.pass, true);
    assert.equal(report.matte_method, 'border_matte_v2');
    assert.equal(report.defringe.chroma_green, true);
    assert.ok(report.defringe.despilled_pixels > 0);
    assert.ok(report.residual_key_edge_ratio <= 0.02);

    const output = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelAt = (x, y) => Array.from(output.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    const outer = pixelAt(20, 32);
    const inner = pixelAt(21, 32);
    const center = pixelAt(48, 32);
    assert.ok(outer[3] > 0 && outer[3] < 255);
    assert.ok(outer[1] <= Math.max(outer[0], outer[2]) + 12);
    assert.ok(inner[1] <= Math.max(inner[0], inner[2]) + 12);
    assert.deepEqual(center, [105, 70, 40, 255]);
    assert.deepEqual(pixelAt(0, 0), [0, 0, 0, 0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider alpha cleanup removes diffuse low-alpha checkerboard noise', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-paper-alpha-noise-'));
  const inputPath = path.join(root, 'checker-alpha-source.png');
  const outputPath = path.join(root, 'cutout.png');
  const width = 96;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      pixels[offset] = checker ? 72 : 48;
      pixels[offset + 1] = checker ? 70 : 46;
      pixels[offset + 2] = checker ? 68 : 44;
      pixels[offset + 3] = checker ? 20 : 35;
      if (x >= 22 && x <= 73 && y >= 12 && y <= 55) {
        pixels[offset] = 105;
        pixels[offset + 1] = 70;
        pixels[offset + 2] = 40;
        pixels[offset + 3] = 255;
      }
    }
  }
  try {
    await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(inputPath);
    const report = await assetService.alphaReport(inputPath, outputPath, { requireAlpha: true });
    assert.equal(report.pass, true);
    assert.equal(report.matte_method, 'provider_alpha');
    assert.equal(report.defringe.version, 'edge-defringe-v2');
    assert.equal(report.defringe.low_alpha_cleanup.applied, true);
    assert.ok(report.defringe.low_alpha_cleanup.cleared_pixels > 3000);
    assert.ok(report.transparent_ratio > 0.6);

    const output = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelAt = (x, y) => Array.from(output.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    assert.deepEqual(pixelAt(0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(48, 32), [105, 70, 40, 255]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual preview rejection supersedes the snapshot and requeues compilation without discarding assets', async () => {
  const { db, storage, run, soldierPng, riverPng } = await setup();
  const original = imageClient.callImageApi;
  imageClient.callImageApi = async (unusedDb, unusedLog, opts) => ({
    image_url: `data:image/png;base64,${(/clean plate/i.test(opts.prompt) ? riverPng : soldierPng).toString('base64')}`,
  });
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const initial = shotService.get(db, run.shots[0].id);
    const assets = await assetService.generateAssets(db, { storage: { local_path: storage } }, log, initial.id, {
      request_id: randomUUID(), expected_version: initial.version, authorization_id: authorizationId,
    });
    const reviewed = approveAllCurrentAssets(db, initial.id);
    const motion = motionGateService.planMotion(db, {
      storage: { local_path: storage }, paper_studio: { renderer_version: 'paper-studio-v3', proof_rule_version: 'paper-proof-v3' },
    }, log, initial.id, { request_id: randomUUID(), expected_version: reviewed.shot.version });
    db.prepare("UPDATE paper_studio_shots SET status = 'preview_ready', version = version + 1 WHERE id = ?").run(Number(initial.id));
    const beforeReject = shotService.get(db, initial.id);
    const rejected = renderService.rejectPreview(db, { storage: { local_path: storage } }, log, initial.id, {
      request_id: randomUUID(), expected_version: beforeReject.version, reason: '程序层风格与项目视觉规范不一致',
    });
    assert.equal(rejected.shot.status, 'asset_ready');
    assert.equal(rejected.shot.current_snapshot_id, null);
    assert.equal(rejected.shot.last_error_json.code, 'PAPER_STUDIO_PREVIEW_REJECTED');
    assert.equal(db.prepare('SELECT status FROM paper_render_snapshots WHERE id = ?').get(motion.snapshot.id).status, 'superseded');
    assert.equal(db.prepare('SELECT status FROM paper_motion_plans WHERE shot_id = ?').get(initial.id).status, 'confirmed');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_job_steps WHERE shot_id = ? AND step_key IN ('plan_motion','compile_snapshot','render_proof','render_preview') AND status = 'queued'").get(initial.id).count, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_slots WHERE required_for_gate = 1 AND status = 'ready'").get().count, 7);
  } finally {
    imageClient.callImageApi = original;
    db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('provider quota failure preserves accepted assets and exposes a retryable domain error', async () => {
  const { db, storage, run, riverPng } = await setup();
  const original = imageClient.callImageApi;
  let call = 0;
  imageClient.callImageApi = async () => {
    call += 1;
    if (call === 1) return { image_url: `data:image/png;base64,${riverPng.toString('base64')}` };
    throw new Error('图片生成请求失败: 429 - {"error":{"type":"usage_limit_reached"}}');
  };
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const shot = shotService.get(db, run.shots[0].id);
    await assert.rejects(
      () => assetService.generateAssets(db, { storage: { local_path: storage } }, log, shot.id, { request_id: randomUUID(), expected_version: shot.version, authorization_id: authorizationId }),
      (error) => error.code === 'PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED' && error.status === 429,
    );
    const failed = shotService.get(db, shot.id);
    assert.equal(failed.status, 'asset_failed');
    assert.equal(failed.last_error_json.code, 'PAPER_STUDIO_PROVIDER_QUOTA_EXHAUSTED');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_asset_versions WHERE status = 'accepted'").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_job_steps WHERE status = 'failed_retryable'").get().count >= 1, true);
  } finally {
    imageClient.callImageApi = original;
    db.close();
  }
});

test('v3 Remotion worker renders deterministic proof frames from the frozen snapshot', {
  skip: process.env.PAPER_STUDIO_RENDER_INTEGRATION !== '1',
}, async () => {
  const { db, storage, run, soldierPng } = await setup();
  const original = imageClient.callImageApi;
  imageClient.callImageApi = async () => ({ image_url: `data:image/png;base64,${soldierPng.toString('base64')}` });
  const cfg = {
    storage: { local_path: storage },
    paper_studio: {
      renderer_version: 'paper-studio-v3', proof_rule_version: 'paper-proof-v3', preview_scale: 0.5,
      render: { crf_preview: 28, crf_formal: 20 },
    },
  };
  try {
    const authorizationId = authorizeGeneration(db, run.id);
    const before = shotService.get(db, run.shots[0].id);
    const assets = await assetService.generateAssets(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: before.version, authorization_id: authorizationId });
    const approvedAssets = approveAllCurrentAssets(db, before.id);
    const motion = motionGateService.planMotion(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: approvedAssets.shot.version });
    let proof;
    try {
      proof = await renderService.proof(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: motion.shot.version });
    } catch (error) {
      console.error('paper studio render integration failure', error.details || error);
      throw error;
    }
    assert.equal(proof.shot.status, 'proof_ready');
    assert.equal(proof.proof.report.pass, true);
    assert.equal(proof.proof.report.camera_only, false);
    assert.equal(proof.proof.report.evidence.length, 3);
    assert.ok(proof.proof.report.evidence.every((item) => item.artifact.deterministic));
    assert.ok(proof.proof.report.evidence.slice(1).every((item) => item.metrics.changed_pixel_ratio >= 0.01));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paper_proof_evidence WHERE status = 'passed'").get().count, 3);
    const preview = await renderService.preview(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: proof.shot.version });
    assert.equal(preview.shot.status, 'preview_ready');
    assert.equal(preview.preview.render_hash, motion.snapshot.render_hash);
    assert.ok(fs.existsSync(path.join(storage, preview.preview.local_path)));
    const approval = renderService.approvePreview(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: preview.shot.version });
    assert.equal(approval.shot.status, 'approved');
    assert.equal(approval.approval.render_hash, motion.snapshot.render_hash);
    const formal = await renderService.renderFormal(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: approval.shot.version });
    assert.equal(formal.shot.status, 'rendered');
    assert.equal(formal.video_generation.render_hash, motion.snapshot.render_hash);
    assert.ok(fs.existsSync(path.join(storage, formal.video_generation.local_path)));
    const published = renderService.publish(db, cfg, log, before.id, { request_id: randomUUID(), expected_version: formal.shot.version });
    assert.equal(published.shot.status, 'published');
    assert.equal(runService.get(db, run.id).status, 'delivered');
    assert.equal(db.prepare('SELECT video_render_mode FROM storyboards WHERE id = 101').get().video_render_mode, 'paper_studio_v3');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_generations WHERE generation_kind = 'paper_studio' AND status = 'completed'").get().count, 1);
  } finally {
    imageClient.callImageApi = original;
    db.close();
  }
});
