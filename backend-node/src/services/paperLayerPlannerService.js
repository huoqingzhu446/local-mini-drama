const paperAssetService = require('./paperAssetService');
const paperRigService = require('./paperRigService');
const paperSequenceService = require('./paperSequenceService');
const {
  PaperError,
  parseJson,
  parseEntityIds,
  nowIso,
  asPublicStaticPath,
  normalizeRelativePath,
} = require('./paperUtils');

const PHASE_RATIOS = [
  ['anticipation', 0.08],
  ['entry', 0.14],
  ['action', 0.34],
  ['peak', 0.11],
  ['settle', 0.14],
  ['hold', 0.15],
  ['exit', 0.04],
];

function aspectForDrama(drama) {
  let meta = parseJson(drama?.metadata, {});
  const ratio = String(meta.aspect_ratio || '16:9').replace(/：/g, ':');
  if (ratio === '9:16') return { aspect_ratio: ratio, width: 1080, height: 1920 };
  if (ratio === '1:1') return { aspect_ratio: ratio, width: 1080, height: 1080 };
  return { aspect_ratio: '16:9', width: 1920, height: 1080 };
}

function compilePhases(durationFrames) {
  const frames = Math.max(1, Number(durationFrames));
  if (frames < PHASE_RATIOS.length) {
    const shortNames = frames === 1
      ? ['hold']
      : ['anticipation', 'action', 'peak', 'settle', 'hold', 'exit'].slice(0, frames);
    return shortNames.map((name, index) => ({ name, start_frame: index, end_frame: index + 1 }));
  }
  const result = [];
  let cursor = 0;
  PHASE_RATIOS.forEach(([name, ratio], index) => {
    const end = index === PHASE_RATIOS.length - 1 ? frames : Math.min(frames, cursor + Math.max(1, Math.round(frames * ratio)));
    result.push({ name, start_frame: cursor, end_frame: Math.max(cursor + 1, end) });
    cursor = end;
  });
  result[result.length - 1].end_frame = frames;
  // Ensure monotonically increasing boundaries for very short shots.
  for (let i = 1; i < result.length; i += 1) {
    result[i].start_frame = Math.min(frames - 1, Math.max(result[i - 1].start_frame, result[i - 1].end_frame));
    result[i].end_frame = Math.max(result[i].start_frame + 1, Math.min(frames, result[i].end_frame));
  }
  result[result.length - 1].end_frame = frames;
  return result;
}

function deriveActionVerb(storyboard) {
  const text = [storyboard.action, storyboard.dialogue, storyboard.narration, storyboard.movement].filter(Boolean).join(' ');
  const patterns = [
    [/升起|上升|拉升/, '镜头升起'],
    [/推向|推进|推近/, '镜头推进'],
    [/横摇|横移|扫过/, '镜头横摇'],
    [/环绕|旋转/, '镜头环绕'],
    [/抬手|举起|高举/, '抬手'],
    [/指向|指着/, '指向'],
    [/撕扯|撕裂/, '撕扯绸缎'],
    [/跪/, '跪地'],
    [/走向|走出|快步/, '行走'],
    [/回头|抬头|低头/, '转头'],
  ];
  const found = patterns.find(([regex]) => regex.test(text));
  return found ? found[1] : (storyboard.movement ? `镜头${storyboard.movement}` : '镜头呼吸');
}

function parseCharacterRows(db, storyboard, dramaId) {
  let ids = parseEntityIds(storyboard.characters);
  if (!ids.length) {
    try {
      ids = db.prepare('SELECT character_id AS id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id').all(Number(storyboard.id));
    } catch (_) {}
  }
  return ids.map(({ id, name }) => {
    const row = db.prepare('SELECT * FROM characters WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(id, dramaId);
    return row || { id, drama_id: dramaId, name, description: '', appearance: '' };
  });
}

function parsePropRows(db, storyboard, dramaId) {
  let ids = parseEntityIds(storyboard.props);
  if (!ids.length) {
    try { ids = db.prepare('SELECT prop_id AS id FROM storyboard_props WHERE storyboard_id = ? ORDER BY id').all(Number(storyboard.id)); } catch (_) {}
  }
  return ids.map(({ id, name }) => {
    try {
      return db.prepare('SELECT * FROM props WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(id), Number(dramaId))
        || { id, drama_id: dramaId, name, description: '', prompt: '' };
    } catch (_) {
      return { id, drama_id: dramaId, name, description: '', prompt: '' };
    }
  });
}

function ensureAsset(db, input, cfg) {
  let asset = paperAssetService.create(db, input);
  const patch = {};
  const normalizedInputPath = normalizeRelativePath(input.local_path);
  if (normalizedInputPath && String(asset.local_path || '') !== normalizedInputPath) patch.local_path = normalizedInputPath;
  if (input.image_url && String(asset.image_url || '') !== String(input.image_url || '')) patch.image_url = input.image_url;
  if (input.status === 'ready' && asset.status !== 'ready') patch.status = 'ready';
  if (Object.keys(patch).length) {
    asset = paperAssetService.update(db, asset.id, patch, asset.version);
  }
  if (cfg && (asset.local_path || asset.cutout_local_path)) {
    try {
      asset = paperAssetService.refreshFileMetadata(db, cfg, asset.id, { status: input.status || asset.status });
    } catch (_) {
      // The requirement returned by the planner remains blocking.  Do not
      // fabricate a ready asset when the source is missing or malformed.
    }
  }
  return asset;
}

function ensureCharacterRig(db, dramaId, character, storyboard, options = {}) {
  const base = `character-${character.id}-${options.variant_key || 'front'}`;
  const partSpecs = [
    ['torso', null, [0.5, 1], 2, { x: 0, y: 0, rotation: 0, scale: 1 }],
    ['head', 'torso', [0.5, 0.6], 4, { x: 0, y: -1.2, rotation: -3, scale: 1 }],
    ['arm_front', 'torso', [0.12, 0.5], 6, { x: 0.28, y: -0.78, rotation: -28, scale: 1 }],
  ];
  const parts = partSpecs.map(([key, parent, pivot, z, initialTransform]) => {
    const asset = ensureAsset(db, {
      drama_id: dramaId,
      episode_id: storyboard.episode_id,
      scene_id: storyboard.scene_id,
      storyboard_id: storyboard.id,
      asset_scope: 'storyboard',
      asset_key: `${base}:${key}`,
      asset_type: 'rig_part',
      variant_key: options.variant_key || 'front',
      rig_key: base,
      source_entity_type: 'character',
      source_entity_id: character.id,
      local_path: null,
      image_url: null,
      status: 'missing',
      matte_quality: 'unknown',
    }, options.cfg);
    return {
      key,
      asset_id: asset.id,
      parent,
      pivot,
      initial_transform: initialTransform,
      width: key === 'torso' ? 1 : key === 'head' ? 0.62 : 0.78,
      aspect_ratio: key === 'torso' ? 0.62 : key === 'head' ? 0.9 : 2.5,
      z_index: z,
    };
  });
  const existing = db.prepare('SELECT * FROM paper_rigs WHERE subject_type = ? AND subject_id = ? AND rig_key = ? AND deleted_at IS NULL').get('character', character.id, base);
  if (existing) return paperRigService.rowToRig(existing);
  return paperRigService.create(db, {
    drama_id: dramaId,
    subject_type: 'character',
    subject_id: character.id,
    rig_key: base,
    root_part_key: 'torso',
    parts,
    status: 'draft',
  });
}

function plan(db, log, storyboardId, options = {}) {
  const storyboard = db.prepare(
    `SELECT sb.*, e.drama_id, e.episode_number, d.title AS drama_title, d.metadata AS drama_metadata
     FROM storyboards sb JOIN episodes e ON e.id = sb.episode_id
     JOIN dramas d ON d.id = e.drama_id
     WHERE sb.id = ? AND sb.deleted_at IS NULL`
  ).get(Number(storyboardId));
  if (!storyboard) throw new PaperError('PAPER_NOT_FOUND', '分镜不存在', { storyboard_id: storyboardId }, 404);
  const existing = db.prepare('SELECT * FROM paper_compositions WHERE storyboard_id = ? AND deleted_at IS NULL').get(Number(storyboardId));
  if (existing && options.rebuild_layers !== true) {
    // A scene may have received its formal background after the first plan.
    // Reconcile that source without rewriting hand-edited layer transforms or
    // timing. New semantic layers require the explicit "rebuild" action.
    try {
      if (storyboard.scene_id != null) {
        const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.scene_id));
        const layer = db.prepare("SELECT paper_asset_id FROM paper_layers WHERE composition_id = ? AND layer_key = 'background_plate' AND deleted_at IS NULL").get(existing.id);
        if (scene && layer?.paper_asset_id) {
          ensureAsset(db, {
            drama_id: storyboard.drama_id, episode_id: storyboard.episode_id, scene_id: scene.id, storyboard_id: storyboard.id,
            asset_key: `scene:${scene.id}:background:${storyboard.angle_s || 'wide'}`, asset_type: 'background_plate',
            source_entity_type: 'scene', source_entity_id: scene.id, local_path: scene.local_path || null,
            image_url: scene.image_url || asPublicStaticPath(scene.local_path), status: scene.local_path ? 'ready' : 'missing', matte_quality: 'pass',
          }, options.cfg);
        }
      }
    } catch (_) {}
    return { composition: existing, reused: true, requirements: [] };
  }
  const dimensions = aspectForDrama({ metadata: storyboard.drama_metadata });
  const durationSeconds = Number(storyboard.duration) > 0 ? Number(storyboard.duration) : 5;
  const durationFrames = Math.max(1, Math.round(durationSeconds * 30));
  const actionVerb = deriveActionVerb(storyboard);
  const sequence = paperSequenceService.getOrCreateForStoryboard(db, { ...storyboard, drama_id: storyboard.drama_id });
  const phaseJson = { status: 'unlocked', source: 'manual', phases: compilePhases(durationFrames), cues: [], timing_hash: null };
  const movement = String(storyboard.movement || '').toLowerCase();
  const cameraEnd = /push|推进|推近/.test(movement + storyboard.action) ? { x: 0.505, y: 0.5, scale: 1.045, rotation: 0 }
    : /pull|拉远|拉升|升起/.test(movement + storyboard.action) ? { x: 0.495, y: 0.49, scale: 0.97, rotation: 0 }
      : /pan|横摇|横移|扫过/.test(movement + storyboard.action) ? { x: 0.53, y: 0.5, scale: 1.02, rotation: 0 }
        : { x: 0.5, y: 0.5, scale: 1.015, rotation: 0 };
  const cameraJson = {
    signature: { shot: storyboard.shot_type || 'medium', angle_h: storyboard.angle_h || 'front', angle_v: storyboard.angle_v || 'eye_level', movement: storyboard.movement || 'static' },
    start: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    end: cameraEnd,
    ease: 'sine.inOut',
  };
  const compositionInput = {
    drama_id: storyboard.drama_id,
    episode_id: storyboard.episode_id,
    storyboard_id: storyboard.id,
    sequence_id: sequence?.id || null,
    sequence_index: Number(storyboard.storyboard_number || 1),
    version: 1,
    schema_version: 2,
    template_key: options.template_key || 'paper_history_v1',
    fps: 30,
    width: dimensions.width,
    height: dimensions.height,
    duration_frames: durationFrames,
    camera_json: cameraJson,
    continuity_json: sequence?.continuity_json || {},
    audio_json: { timing: phaseJson },
    audio_timing_status: 'unlocked',
    status: 'draft',
  };
  let compositionId;
  const now = nowIso();
  const tx = db.transaction(() => {
    if (existing) {
      compositionId = existing.id;
      db.prepare(
        `UPDATE paper_compositions SET sequence_id = ?, sequence_index = ?, template_key = ?, fps = ?, width = ?, height = ?, duration_frames = ?, camera_json = ?, continuity_json = ?, audio_json = ?, audio_timing_status = 'unlocked', status = 'draft', version = version + 1, last_validation_json = '{}', last_proof_hash = NULL, updated_at = ? WHERE id = ?`
      ).run(sequence?.id || null, compositionInput.sequence_index, compositionInput.template_key, 30, dimensions.width, dimensions.height, durationFrames, JSON.stringify(cameraJson), JSON.stringify(compositionInput.continuity_json), JSON.stringify(compositionInput.audio_json), now, existing.id);
      if (options.rebuild_layers) db.prepare('UPDATE paper_layers SET deleted_at = ?, updated_at = ? WHERE composition_id = ? AND deleted_at IS NULL').run(now, now, existing.id);
    } else {
      const result = db.prepare(
        `INSERT INTO paper_compositions (drama_id, episode_id, storyboard_id, sequence_id, sequence_index, version, schema_version, template_key, fps, width, height, duration_frames, camera_json, continuity_json, audio_json, audio_timing_status, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 2, ?, 30, ?, ?, ?, ?, ?, ?, 'unlocked', 'draft', ?, ?)`
      ).run(storyboard.drama_id, storyboard.episode_id, storyboard.id, sequence?.id || null, compositionInput.sequence_index, compositionInput.template_key, dimensions.width, dimensions.height, durationFrames, JSON.stringify(cameraJson), JSON.stringify(compositionInput.continuity_json), JSON.stringify(compositionInput.audio_json), now, now);
      compositionId = result.lastInsertRowid;
    }
  });
  tx();

  const requirements = [];
  const layerDrafts = [];
  const scene = storyboard.scene_id == null ? null : db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.scene_id));
  if (scene) {
    const sceneAsset = ensureAsset(db, {
      drama_id: storyboard.drama_id, episode_id: storyboard.episode_id, scene_id: scene.id, storyboard_id: storyboard.id,
      asset_scope: 'scene', asset_key: `scene:${scene.id}:background:${storyboard.angle_s || 'wide'}`,
      asset_type: 'background_plate', source_entity_type: 'scene', source_entity_id: scene.id,
      local_path: scene.local_path || null, image_url: scene.image_url || asPublicStaticPath(scene.local_path),
      status: scene.local_path ? 'ready' : 'missing', matte_quality: 'pass',
    }, options.cfg);
    layerDrafts.push({ layer_key: 'background_plate', layer_type: 'background', role: 'atmosphere', paper_asset_id: sceneAsset.id, z_index: 0, depth: 0.05,
      transform_json: { x: 0.5, y: 0.5, width: 1.08, anchor_x: 0.5, anchor_y: 0.5, scale: 1, rotation: 0, opacity: 1 },
      animation_json: { action_verb: actionVerb, intentional_hold: false, tracks: [], ambient: null }, status: sceneAsset.status === 'ready' ? 'ready' : 'missing' });
    requirements.push({ layer_key: 'background_plate', semantic_role: 'atmosphere', asset_type: 'background_plate', required: true, source_entity_type: 'scene', source_entity_id: scene.id, action_verb: actionVerb, needs_rig: false, blocking_reason: sceneAsset.status === 'ready' ? null : '缺少独立场景底板' });
  } else {
    requirements.push({ layer_key: 'background_plate', semantic_role: 'atmosphere', asset_type: 'background_plate', required: true, source_entity_type: 'scene', action_verb: actionVerb, blocking_reason: '分镜未关联场景' });
  }

  const characters = parseCharacterRows(db, storyboard, storyboard.drama_id);
  const semanticAction = /抬手|举起|高举|指向|挥手|伸手|递|拿|撕扯|撕裂|跪|走向|走出|快步|回头|抬头|低头|转身|击打|喝|写|捡起|放下/.test(
    [storyboard.action, storyboard.dialogue, storyboard.narration, storyboard.movement].filter(Boolean).join(' ')
  );
  characters.forEach((character, index) => {
    const rig = ensureCharacterRig(db, storyboard.drama_id, character, storyboard, { variant_key: storyboard.angle_h || 'front', cfg: options.cfg });
    const peakFrame = Math.max(1, Math.min(durationFrames - 1, Math.floor(durationFrames * 0.56)));
    const rigTracks = semanticAction ? [
      { target: `rig.${rig.rig_key}.arm_front`, property: 'rotation', phase: 'action', from: -8, to: index === 0 ? 16 : 8, ease: 'power2.inOut' },
      { target: `rig.${rig.rig_key}.head`, property: 'rotation', phase: 'peak', from: 0, to: index === 0 ? 5 : -4, ease: 'sine.out' },
    ] : [];
    layerDrafts.push({ layer_key: `character_${character.id}`, layer_type: 'character', role: index === 0 ? 'primary' : 'secondary', rig_id: rig.id, z_index: 30 + index * 10, depth: 0.7 - index * 0.04,
      transform_json: { x: index === 0 ? 0.5 : 0.66, y: 0.88, width: index === 0 ? 0.3 : 0.22, anchor_x: 0.5, anchor_y: 1, scale: 1, rotation: 0, opacity: 1 },
      animation_json: { action_verb: actionVerb, intentional_hold: false, motion_coverage: { load_bearing_track: semanticAction ? `rig.${rig.rig_key}.arm_front.rotation` : null, peak_frame: peakFrame, reaction_tracks: semanticAction ? [`rig.${rig.rig_key}.head.rotation`] : [] }, tracks: [
        ...rigTracks,
        ...(semanticAction ? [{ target: 'layer', property: 'y', phase: 'settle', from: 0.008, to: 0, ease: 'sine.out' }] : []),
      ], ambient: { preset: 'paper_breath_v1', phase: 'hold', amplitude: 0.0012, period_frames: 100 } },
      status: 'missing' });
    requirements.push({ layer_key: `character_${character.id}`, semantic_role: index === 0 ? 'primary' : 'secondary', asset_type: 'rig_part', required: true, source_entity_type: 'character', source_entity_id: character.id, action_verb: actionVerb, needs_rig: true, rig_id: rig.id, blocking_reason: '主角/配角需要独立透明 rig 部件' });
  });

  const props = parsePropRows(db, storyboard, storyboard.drama_id);
  props.forEach((prop, index) => {
    const peakPhase = phaseJson.phases.find((phase) => phase.name === 'peak') || { start_frame: Math.floor(durationFrames * 0.55), end_frame: Math.floor(durationFrames * 0.7) };
    const settlePhase = phaseJson.phases.find((phase) => phase.name === 'settle') || { start_frame: peakPhase.end_frame, end_frame: durationFrames };
    const propReactionFrames = [
      { frame: Math.max(0, peakPhase.start_frame - 1), value: 0 },
      { frame: peakPhase.start_frame, value: -2 },
      { frame: Math.max(peakPhase.start_frame, Math.floor((peakPhase.start_frame + peakPhase.end_frame - 1) / 2)), value: 4 },
      { frame: Math.max(0, Math.min(durationFrames - 1, settlePhase.end_frame - 1)), value: 0 },
    ];
    const propAsset = ensureAsset(db, {
      drama_id: storyboard.drama_id,
      episode_id: storyboard.episode_id,
      scene_id: storyboard.scene_id,
      storyboard_id: storyboard.id,
      asset_scope: 'storyboard',
      asset_key: `storyboard-${storyboard.id}:prop-${prop.id}:active`,
      asset_type: 'prop_state',
      variant_key: 'active',
      source_entity_type: 'prop',
      source_entity_id: prop.id,
      prompt: prop.prompt || prop.description || prop.name || `prop ${prop.id}`,
      negative_prompt: prop.negative_prompt || null,
      // Existing prop concept art is provenance/reference only. It enters as
      // needs_review and cannot become a formal layer until matte + review.
      local_path: prop.local_path || null,
      image_url: prop.image_url || asPublicStaticPath(prop.local_path),
      status: prop.local_path ? 'needs_review' : 'missing',
      matte_quality: 'unknown',
    }, options.cfg);
    layerDrafts.push({
      layer_key: `prop_${prop.id}`,
      layer_type: 'prop',
      role: 'interactive_prop',
      paper_asset_id: propAsset.id,
      z_index: 48 + index,
      depth: 0.76,
      transform_json: { x: 0.58 + index * 0.04, y: 0.72, width: 0.12, anchor_x: 0.5, anchor_y: 0.5, scale: 1, rotation: 0, opacity: 1 },
      animation_json: {
        action_verb: actionVerb,
        intentional_hold: false,
        motion_coverage: { load_bearing_track: null, peak_frame: Math.max(0, Math.min(durationFrames - 1, Math.floor(durationFrames * 0.56))), reaction_tracks: ['layer.rotation'] },
        tracks: semanticAction ? [{ target: 'layer', property: 'rotation', phase: 'peak', keyframes: propReactionFrames, ease: 'sine.out' }] : [],
        ambient: null,
      },
      status: propAsset.status === 'ready' ? 'ready' : 'missing',
    });
    requirements.push({
      layer_key: `prop_${prop.id}`,
      semantic_role: 'interactive_prop',
      asset_type: 'prop_state',
      required: true,
      source_entity_type: 'prop',
      source_entity_id: prop.id,
      action_verb: actionVerb,
      needs_rig: false,
      blocking_reason: propAsset.status === 'ready' ? null : '关键道具需要独立透明状态素材并通过审核',
    });
  });

  // Persist layer drafts after composition exists. Existing hand-edited layers
  // are never overwritten during a normal plan call.
  const layerInsert = db.prepare(
    `INSERT OR IGNORE INTO paper_layers (composition_id, paper_asset_id, rig_id, layer_key, layer_type, role, content_json, z_index, depth, pivot_json, transform_json, animation_json, occlusion_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const draft of layerDrafts) {
    const assetId = draft.paper_asset_id || null;
    const occlusion = draft.layer_type === 'character' ? { group: draft.layer_key, affected_part_keys: ['arm_front'], occluder_layer_key: null, mask_asset_id: null, feather_px: 2 } : {};
    layerInsert.run(compositionId, assetId, draft.rig_id || null, draft.layer_key, draft.layer_type, draft.role || null, JSON.stringify({}), draft.z_index, draft.depth, JSON.stringify({}), JSON.stringify(draft.transform_json), JSON.stringify(draft.animation_json), JSON.stringify(occlusion), draft.status || 'missing', now, now);
  }
  const comp = db.prepare('SELECT * FROM paper_compositions WHERE id = ?').get(Number(compositionId));
  if (log) log.info('Paper composition planned', { composition_id: compositionId, storyboard_id: storyboard.id, requirements: requirements.length });
  return { composition: comp, requirements, layerDrafts, timingDraft: phaseJson, warnings: [] };
}

module.exports = { plan, deriveActionVerb, compilePhases, aspectForDrama, parseCharacterRows, parsePropRows };
