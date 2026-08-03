const fs = require('fs');
const motionNaturalizer = require('./paperMotionNaturalizerService');
const { resolveTrackValue } = require('../../paper-studio-renderer/motion/trackResolver.cjs');
const path = require('path');
const storageLayout = require('../storageLayout');
const schemaService = require('./paperStudioSchemaService');
const revisionService = require('./paperSourceRevisionService');
const storyboardAudioService = require('./paperStoryboardAudioService');
const shotService = require('./paperStudioShotService');
const sourceService = require('./paperStudioSourceService');
const spatialContractService = require('./paperSpatialContractService');
const transitionGateService = require('./paperTransitionGateService');
const { safeStorageFile } = require('./paperAssetProductionService');
const {
  PaperStudioError,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

const RENDERER_VERSION = 'paper-studio-v3.1';

function colorNearLabel(text, labels, fallback) {
  const source = String(text || '');
  const lower = source.toLowerCase();
  for (const label of labels) {
    const index = lower.indexOf(String(label).toLowerCase());
    if (index < 0) continue;
    const match = source.slice(index, index + 120).match(/#[0-9a-fA-F]{6}/);
    if (match) return match[0].toUpperCase();
  }
  return fallback;
}

function visualStyleForSnapshot(db, dramaId) {
  const drama = db.prepare('SELECT style, metadata, active_visual_style_signature FROM dramas WHERE id = ?').get(Number(dramaId));
  const metadata = parseJson(drama?.metadata, {});
  const bible = parseJson(metadata.visual_bible_struct, metadata.visual_bible_struct) || {};
  const paletteText = typeof bible === 'object' ? bible.palette : '';
  return {
    style_signature: String(drama?.active_visual_style_signature || metadata.style_signature || ''),
    medium: 'tactile-2d-paper-animation',
    palette: {
      paper: colorNearLabel(paletteText, ['绢本米白', '米白', 'paper', 'ivory'], '#D8C9A7'),
      ink: colorNearLabel(paletteText, ['墨褐', '墨色', 'ink brown', 'ink'], '#241C16'),
      accent: colorNearLabel(paletteText, ['朱砂红', '强调色', 'cinnabar', 'accent'], '#A3322B'),
      secondary: colorNearLabel(paletteText, ['旧金', 'aged gold', 'secondary'], '#B38A4A'),
    },
    texture: typeof bible === 'object' ? String(bible.texture || '') : '',
    lighting: typeof bible === 'object' ? String(bible.lighting || '') : '',
  };
}

function acceptedAssets(db, shotId) {
  return db.prepare(
    `SELECT pav.*, pas.slot_key, pas.asset_type, pas.generation_purpose, pas.constraints_json,
            pas.required_for_gate, psf.family_key, psf.pattern
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     LEFT JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ?
       AND psf.plan_revision_id = (SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?)
       AND psf.deleted_at IS NULL AND pas.deleted_at IS NULL
     ORDER BY psf.id, pas.id`,
  ).all(Number(shotId), Number(shotId));
}

function assertAssetVersions(cfg, rows) {
  const missing = rows.filter((row) => Number(row.required_for_gate) && (!row.id || row.status !== 'accepted'));
  if (missing.length) {
    throw new PaperStudioError('PAPER_STUDIO_REQUIRED_ASSET_MISSING', '仍有必需素材未通过正式素材门禁', { slots: missing.map((row) => `${row.family_key}.${row.slot_key}`) }, 409);
  }
  const resolved = [];
  for (const row of rows.filter((item) => item.id && item.status === 'accepted')) {
    const localPath = row.alpha_local_path || row.source_local_path;
    const hash = row.alpha_hash || row.source_hash;
    const absolute = safeStorageFile(cfg, localPath);
    if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== hash) {
      throw new PaperStudioError('PAPER_STUDIO_ASSET_HASH_MISMATCH', '素材文件缺失或哈希与已接受版本不一致', { asset_version_id: Number(row.id), local_path: localPath }, 409);
    }
    resolved.push({ ...row, resolved_local_path: localPath, resolved_hash: hash });
  }
  return resolved;
}

function familySpecs(detail) {
  return detail.families.map((family) => ({
    family_key: family.family_key,
    pattern: family.pattern,
    registration_canvas: Object.keys(family.registration_canvas_json || {}).length ? family.registration_canvas_json : null,
    slots: family.slots.map((slot) => ({
      slot_key: slot.slot_key,
      asset_type: slot.asset_type,
      generation_purpose: slot.generation_purpose,
      required_for_gate: Boolean(slot.required_for_gate),
      constraints: slot.constraints_json || {},
    })),
    contract: family.contract_json || {},
  }));
}

function compositionTree(detail, versions) {
  const byId = new Map(detail.composition_nodes.map((node) => [Number(node.id), node]));
  const children = new Map();
  for (const node of detail.composition_nodes) {
    const parent = node.parent_node_id == null ? null : Number(node.parent_node_id);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const bySlot = new Map(versions.map((version) => [`${version.family_key}:${version.slot_key}`, version]));
  const convert = (node) => {
    const relation = { ...(node.relation_json || {}) };
    const familyKey = relation.family_key;
    const direct = node.slot && familyKey ? bySlot.get(`${familyKey}:${node.slot}`) : null;
    if (relation.state_slots && familyKey) {
      relation.state_asset_version_ids = Object.fromEntries(
        Object.entries(relation.state_slots).map(([state, slotKey]) => {
          const version = bySlot.get(`${familyKey}:${slotKey}`);
          if (!version) throw new PaperStudioError('PAPER_STUDIO_STATE_ASSET_MISSING', '动作状态缺少正式素材版本', { node_key: node.node_key, state, slot_key: slotKey }, 409);
          return [state, Number(version.id)];
        }),
      );
    }
    return {
      key: node.node_key,
      kind: node.node_kind,
      pattern: node.pattern || undefined,
      slot: node.slot || null,
      asset_version_id: direct ? Number(direct.id) : (node.asset_version_id == null ? null : Number(node.asset_version_id)),
      transform: node.transform_json || {},
      relation,
      clip: node.clip_json || {},
      local_z: Number(node.local_z || 0),
      children: (children.get(Number(node.id)) || []).sort((a, b) => Number(a.local_z || 0) - Number(b.local_z || 0)).map(convert),
    };
  };
  const roots = children.get(null) || [];
  if (roots.length !== 1 || !byId.has(Number(roots[0].id))) {
    throw new PaperStudioError('PAPER_STUDIO_COMPOSITION_ROOT_INVALID', '递归组合树必须只有一个根节点', { root_count: roots.length }, 409);
  }
  return convert(roots[0]);
}

function audioSources(db, cfg, detail) {
  const storyboard = sourceService.storyboard(db, detail);
  const candidates = [
    ['narration', storyboard?.narration_audio_local_path],
    ['dialogue', storyboard?.audio_local_path],
  ];
  const seen = new Set();
  const result = [];
  for (const [kind, localPath] of candidates) {
    if (!localPath || seen.has(localPath)) continue;
    seen.add(localPath);
    const absolute = safeStorageFile(cfg, localPath);
    if (!fs.existsSync(absolute)) continue;
    result.push({ kind, local_path: String(localPath).replace(/\\/g, '/'), hash: sha256(fs.readFileSync(absolute)), from_frame: 0, duration_frames: detail.motion_plan.plan_json.duration_frames, volume: 1 });
  }
  return result;
}

function assertSourceCurrent(db, detail, run) {
  revisionService.assertShotCurrent(db, detail.id);
}

function compile(db, cfg, shotId, options = {}) {
  const detail = shotService.get(db, shotId);
  const run = db.prepare('SELECT * FROM paper_studio_runs WHERE id = ? AND deleted_at IS NULL').get(Number(detail.run_id));
  if (!run) throw new PaperStudioError('PAPER_STUDIO_RUN_NOT_FOUND', '纸片动画生产版本不存在', { run_id: detail.run_id }, 404);
  if (!detail.motion_plan || !['confirmed', 'compiled'].includes(detail.motion_plan.status)) {
    throw new PaperStudioError('PAPER_STUDIO_MOTION_PLAN_NOT_READY', '动作计划尚未确认', { shot_id: detail.id }, 409);
  }
  assertSourceCurrent(db, detail, run);
  const versions = assertAssetVersions(cfg, acceptedAssets(db, detail.id));
  const root = spatialContractService.enrichComposition(compositionTree(detail, versions), versions);
  // M1/M5 运动自然化：仅作用于 snapshot 拷贝；配置关闭或历史 snapshot 保持旧行为
  const motionQuality = options.motionQuality === undefined
    ? motionNaturalizer.motionQualityFromConfig(cfg)
    : options.motionQuality;
  const motionPlan = options.motionPlan || motionNaturalizer.naturalize(detail.motion_plan.plan_json, motionQuality, resolveTrackValue);
  const sourceFamilies = familySpecs(detail);
  const proofTargets = detail.plan_summary_json?.proof_targets || [];
  const timingHash = detail.motion_plan.timing_hash || sha256(canonicalJson({ fps: motionPlan.fps, duration_frames: motionPlan.duration_frames, cues: motionPlan.cues || [] }));
  const audioBundle = detail.paper_storyboard_id
    ? storyboardAudioService.snapshotBundle(db, cfg, detail)
    : { sources: audioSources(db, cfg, detail), captions: [] };
  const requiredAudioFrames = Number(audioBundle.readiness?.effective_duration_frames || 0);
  if (requiredAudioFrames > Number(motionPlan.duration_frames || 0)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_AUDIO_DURATION_OVERFLOW',
      '完整语音长于当前动作时间轴，请先按声音自动延长画面',
      {
        shot_id: Number(detail.id),
        motion_duration_frames: Number(motionPlan.duration_frames || 0),
        required_duration_frames: requiredAudioFrames,
        authored_duration_seconds: audioBundle.readiness.authored_duration_seconds,
        speech_end_seconds: audioBundle.readiness.speech_end_seconds,
        effective_duration_seconds: audioBundle.readiness.effective_duration_seconds,
      },
      409,
    );
  }
  const speechEndFrame = Number(audioBundle.readiness?.speech_end_frame || 0);
  if (speechEndFrame > 0 && requiredAudioFrames !== Number(motionPlan.duration_frames || 0)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_AUDIO_TIMELINE_MISMATCH',
      '动作时间轴没有按当前语音时长收束；请重新规划动作后再冻结快照',
      {
        shot_id: Number(detail.id),
        motion_duration_frames: Number(motionPlan.duration_frames || 0),
        required_duration_frames: requiredAudioFrames,
        speech_end_frame: speechEndFrame,
        authored_duration_seconds: audioBundle.readiness.authored_duration_seconds,
        effective_duration_seconds: audioBundle.readiness.effective_duration_seconds,
      },
      409,
    );
  }
  const plannerVersion = Number(detail.plan_summary_json?.planner_version || 0);
  const snapshotVersion = plannerVersion >= 9 && Number(motionPlan.schema_version || 1) >= 2 ? 4 : 3;
  const transitionGate = transitionGateService.assertPlan(motionPlan, {
    planner_version: plannerVersion,
    visual_scenes: detail.plan_summary_json?.visual_scenes || detail.semantic_contract_json?.visual_scenes || [],
    transition_contracts: detail.plan_summary_json?.transition_contracts || motionPlan.transition_contracts || [],
    semantic_contract: detail.semantic_contract_json,
    root,
    source_families: sourceFamilies,
    spatial_contract: detail.plan_summary_json?.spatial_contract || {},
    visual_beats: detail.plan_summary_json?.visual_beats || motionPlan.visual_beats || [],
    captions: audioBundle.captions || [],
  }, '自然化后的冻结时间轴未通过场景连续性门禁');
  const snapshot = {
    schema_version: snapshotVersion,
    renderer_version: cfg?.paper_studio?.renderer_version || RENDERER_VERSION,
    source_revision_hash: detail.source_revision_hash,
    composition: { width: 1920, height: 1080, fps: Number(motionPlan.fps), duration_frames: Number(motionPlan.duration_frames) },
    timing: { timing_hash: timingHash, cues: motionPlan.cues || [] },
    visual_style: visualStyleForSnapshot(db, detail.drama_id),
    source_families: sourceFamilies,
    assets: versions.map((version) => ({
      version_id: Number(version.id),
      family_key: version.family_key,
      slot_key: version.slot_key,
      local_path: version.resolved_local_path,
      hash: version.resolved_hash,
      derivation_kind: version.derivation_kind,
      registration: spatialContractService.rawRegistration(version),
      width: Number(parseJson(version.quality_report_json, {}).width || 0),
      height: Number(parseJson(version.quality_report_json, {}).height || 0),
    })),
    root,
    motion_plan: motionPlan,
    spatial_contract: detail.plan_summary_json?.spatial_contract || { placement_regions: [], nodes: [] },
    ...(snapshotVersion >= 4 ? {
      visual_scenes: detail.plan_summary_json?.visual_scenes || detail.semantic_contract_json?.visual_scenes || [],
      visual_beats: detail.plan_summary_json?.visual_beats || motionPlan.visual_beats || [],
      transition_contracts: detail.plan_summary_json?.transition_contracts || motionPlan.transition_contracts || [],
      transition_gate: transitionGate,
    } : {}),
    ...(motionQuality ? { motion_quality: motionQuality } : {}),
    audio: audioBundle.sources,
    captions: audioBundle.captions,
    proof_targets: proofTargets,
    provenance: {
      shot_id: Number(detail.id), run_id: Number(detail.run_id), storyboard_id: Number(detail.storyboard_id),
      paper_storyboard_id: detail.paper_storyboard_id == null ? null : Number(detail.paper_storyboard_id),
      paper_storyboard_revision_id: detail.paper_storyboard_revision_id == null ? null : Number(detail.paper_storyboard_revision_id),
      catalog_key: detail.plan_summary_json?.catalog_key || null,
      planner_version: Number(detail.plan_summary_json?.planner_version || 0),
      renderer_version: cfg?.paper_studio?.renderer_version || RENDERER_VERSION,
      proof_rule_version: cfg?.paper_studio?.proof_rule_version || 'paper-proof-v3',
    },
    limits: { seed: 1701, deterministic: true, max_nodes: 80, max_proof_targets: 20 },
  };
  spatialContractService.assertSnapshot(snapshot);
  const contentHash = sha256(canonicalJson(snapshot));
  snapshot.provenance.snapshot_hash = contentHash;
  const renderHash = sha256(canonicalJson({
    snapshot_hash: contentHash,
    renderer_version: snapshot.renderer_version,
    asset_hashes: snapshot.assets.map((asset) => asset.hash),
    audio_hashes: snapshot.audio.map((audio) => audio.hash),
    captions_hash: sha256(canonicalJson(snapshot.captions || [])),
    timing_hash: timingHash,
    proof_rule_version: snapshot.provenance.proof_rule_version,
  }));
  snapshot.provenance.render_hash = renderHash;
  schemaService.assertValid('renderSnapshotV3', snapshot, `冻结渲染快照不符合 v${snapshotVersion} Schema`);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  const maxBytes = Number(cfg?.paper_studio?.max_snapshot_bytes || 5 * 1024 * 1024);
  if (bytes > maxBytes) throw new PaperStudioError('PAPER_STUDIO_SNAPSHOT_TOO_LARGE', '渲染快照超过大小限制', { bytes, max_bytes: maxBytes }, 422);

  const existing = db.prepare('SELECT * FROM paper_render_snapshots WHERE shot_id = ? AND render_hash = ?').get(Number(detail.id), renderHash);
  if (existing) return { snapshot_id: Number(existing.id), snapshot: parseJson(existing.snapshot_json, snapshot), snapshot_hash: existing.snapshot_hash, render_hash: existing.render_hash, reused: true, local_path: existing.local_path };
  const projectDir = storageLayout.getProjectStorageSubdir(db, detail.drama_id);
  const relative = `${projectDir}/paper-studio/runs/${detail.run_id}/shots/${detail.id}/snapshots/${renderHash.replace('sha256:', '')}.json`.replace(/\\/g, '/');
  const absolute = safeStorageFile(cfg, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(snapshot, null, 2)}\n`);
  const result = db.prepare(
    `INSERT INTO paper_render_snapshots
      (shot_id, schema_version, renderer_version, source_revision_hash, timing_hash,
       snapshot_json, snapshot_hash, render_hash, local_path, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'compiled', ?)`,
  ).run(Number(detail.id), snapshotVersion, snapshot.renderer_version, detail.source_revision_hash, timingHash, JSON.stringify(snapshot), contentHash, renderHash, relative, nowIso());
  return { snapshot_id: Number(result.lastInsertRowid), snapshot, snapshot_hash: contentHash, render_hash: renderHash, reused: false, local_path: relative };
}

function get(db, snapshotId) {
  const row = db.prepare('SELECT * FROM paper_render_snapshots WHERE id = ?').get(Number(snapshotId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_SNAPSHOT_NOT_FOUND', '冻结渲染快照不存在', { snapshot_id: Number(snapshotId) }, 404);
  return { ...row, id: Number(row.id), shot_id: Number(row.shot_id), snapshot_json: parseJson(row.snapshot_json, {}) };
}

module.exports = { RENDERER_VERSION, acceptedAssets, compositionTree, visualStyleForSnapshot, compile, get };
