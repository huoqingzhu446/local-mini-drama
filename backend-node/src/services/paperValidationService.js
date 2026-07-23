const fs = require('fs');
const paperAssetService = require('./paperAssetService');
const paperRigService = require('./paperRigService');
const {
  PaperError,
  PAPER_MAX_LAYERS,
  PAPER_MAX_RIG_PARTS,
  PAPER_PROOF_KINDS,
  parseJson,
  resolveStorageFile,
} = require('./paperUtils');
const { loadCompositionGraph, normalizePhases } = require('./paperSpecCompiler');
const rigTrackModel = require('../paper-renderer/motion/rigTrackModel.cjs');

function issue(code, path, message, extra = {}) {
  return { code, path, message, ...extra };
}

const SPATIAL_PROPERTIES = new Set(['x', 'y', 'rotation', 'scale', 'position', 'transform']);

function trackIsSemantic(track, { rigKey = null } = {}) {
  if (!track || !SPATIAL_PROPERTIES.has(String(track.property || ''))) return false;
  const target = String(track.target || '');
  if (rigKey) return target === `rig.${rigKey}.${target.split('.').slice(-1)[0]}`
    || target.startsWith(`rig.${rigKey}.`)
    || target.startsWith('rig.');
  return target === 'camera' || target === 'layer' || target === '';
}

function trackHasFrames(track, duration) {
  const keyframes = Array.isArray(track?.keyframes) ? track.keyframes : [];
  if (!keyframes.length) return true;
  return keyframes.every((keyframe) => {
    const frame = Number(keyframe.frame);
    return Number.isInteger(frame) && frame >= 0 && frame < duration && Number.isFinite(Number(keyframe.value));
  });
}

function validatePhases(composition, blocking) {
  const phases = normalizePhases(composition);
  let previousEnd = 0;
  for (const phase of phases) {
    if (phase.start_frame < previousEnd || phase.end_frame <= phase.start_frame || phase.end_frame > composition.duration_frames) {
      blocking.push(issue('PAPER_PHASE_INVALID', `timing.phases.${phase.name}`, 'phase 时间范围无效', { phase }));
    }
    previousEnd = phase.end_frame;
  }
  const peak = phases.find((p) => p.name === 'peak');
  const action = phases.find((p) => p.name === 'action');
  if (peak && action && peak.start_frame < action.start_frame) blocking.push(issue('PAPER_PHASE_ORDER_INVALID', 'timing.phases.peak', 'peak 必须位于 action 之后'));
}

function hasMeaningfulCameraMotion(camera) {
  const start = camera?.start || {};
  const end = camera?.end || {};
  return ['x', 'y', 'scale', 'rotation'].some((key) => Math.abs(Number(start[key] ?? (key === 'scale' ? 1 : 0)) - Number(end[key] ?? (key === 'scale' ? 1 : 0))) > 1e-6);
}

function validate(db, cfg, compositionId, options = {}) {
  const { composition, storyboard, layers } = loadCompositionGraph(db, compositionId);
  const blocking = [];
  const warnings = [];
  if (Number(composition.schema_version) !== 2) blocking.push(issue('PAPER_SCHEMA_INVALID', 'schema_version', '只支持 paper snapshot schema v2'));
  if (!composition.width || !composition.height || !composition.fps || !composition.duration_frames) blocking.push(issue('PAPER_SCHEMA_INVALID', 'composition', '画幅、帧率和时长必须为正数'));
  if (layers.length > PAPER_MAX_LAYERS) blocking.push(issue('PAPER_LIMIT_EXCEEDED', 'layers', `图层数超过 ${PAPER_MAX_LAYERS}`, { count: layers.length }));
  validatePhases(composition, blocking);
  if (composition.audio_timing_status !== 'locked' && !options.allowProvisional) {
    blocking.push(issue('AUDIO_TIMING_UNLOCKED', 'audio_timing_status', '请先锁定对白/旁白或人工 beat 时序'));
  }
  if (composition.audio_timing_status === 'locked' && !String(composition.audio_timing_hash || '').trim()) {
    blocking.push(issue('AUDIO_TIMING_HASH_MISSING', 'audio_timing_hash', '已锁定时序必须包含 timing hash'));
  }
  if (!storyboard) blocking.push(issue('PAPER_STORYBOARD_MISSING', 'storyboard_id', '关联分镜不存在'));
  const layerKeys = new Set(layers.map((layer) => layer.layer_key));
  const assetIds = new Set();
  let readyAssets = 0;
  let visibleSemanticLayers = 0;
  let motionCoverage = { ok: false, peak_frame: null, action_layers: 0 };
  for (const layer of layers) {
    if (layer.layer_type !== 'caption') visibleSemanticLayers += 1;
    const transform = parseJson(layer.transform_json, {});
    for (const [key, value] of Object.entries(transform)) {
      if (['x', 'y', 'width', 'anchor_x', 'anchor_y', 'scale', 'rotation', 'opacity'].includes(key) && !Number.isFinite(Number(value))) {
        blocking.push(issue('PAPER_SCHEMA_INVALID', `layers.${layer.layer_key}.transform.${key}`, 'transform 数值必须为有限数'));
      }
    }
    if (transform.width != null && Number(transform.width) <= 0) blocking.push(issue('PAPER_SCHEMA_INVALID', `layers.${layer.layer_key}.transform.width`, 'width 必须大于 0'));
    if (transform.scale != null && Number(transform.scale) <= 0) blocking.push(issue('PAPER_SCHEMA_INVALID', `layers.${layer.layer_key}.transform.scale`, 'scale 必须大于 0'));
    if (['character', 'character_part', 'prop', 'foreground', 'background', 'distant', 'occluder'].includes(layer.layer_type) && layer.paper_asset_id == null && layer.rig_id == null) {
      blocking.push(issue('MISSING_SEMANTIC_ASSET', `layers.${layer.layer_key}`, '语义图层缺少独立纸片资产', { layer_key: layer.layer_key }));
    }
    if (layer.paper_asset_id != null) {
      assetIds.add(Number(layer.paper_asset_id));
      try {
        const asset = paperAssetService.resolveAssetForRender(db, cfg, layer.paper_asset_id, { allowCandidate: options.allowCandidate });
        if (asset) {
          readyAssets += 1;
          if (['cutout', 'rig_part', 'prop_state', 'mask'].includes(asset.asset_type) && !['pass', 'manual_pass'].includes(asset.matte_quality)) {
            blocking.push(issue('PAPER_MATTE_INVALID', `layers.${layer.layer_key}.paper_asset_id`, '透明纸片资产必须通过抠图审核', { matte_quality: asset.matte_quality }));
          }
        }
        if (asset.source_entity_type === 'storyboard' || String(asset.local_path || '').includes('/storyboards/')) {
          blocking.push(issue('FULL_STORYBOARD_ASSET_FORBIDDEN', `layers.${layer.layer_key}`, '完整分镜图只能作为构图参考，不能作为渲染层', { layer_key: layer.layer_key }));
        }
      } catch (err) {
        blocking.push(issue(err.code || 'PAPER_ASSET_INVALID', `layers.${layer.layer_key}.paper_asset_id`, err.message, { layer_key: layer.layer_key, asset_id: layer.paper_asset_id, details: err.details }));
      }
    }
    let hasMotion = false;
    const animation = parseJson(layer.animation_json, {});
    const tracks = Array.isArray(animation.tracks) ? animation.tracks : [];
    for (const track of tracks) {
      if (!trackHasFrames(track, Number(composition.duration_frames))) {
        blocking.push(issue('PAPER_KEYFRAME_INVALID', `layers.${layer.layer_key}.animation_json.tracks`, '动画 keyframe 必须落在有效帧范围内且值为有限数', { track }));
      }
    }
    const semanticLayerTracks = tracks.filter((track) => trackIsSemantic(track) && rigTrackModel.trackHasSpatialChange(track));
    // A character layer is a rig container.  Its ordinary wrapper track
    // (often a tiny settle/breath offset) cannot satisfy semantic action
    // coverage; only validated rig-part tracks may do so.
    if (!(layer.layer_type === 'character' && layer.rig_id != null) && semanticLayerTracks.length) hasMotion = true;
    if (layer.layer_type === 'character' && layer.rig_id != null) {
      const rig = paperRigService.get(db, layer.rig_id);
      if (!rig) {
        blocking.push(issue('PAPER_RIG_MISSING', `layers.${layer.layer_key}.rig_id`, '角色图层需要有效 rig'));
      } else {
        try { paperRigService.validateParts(rig.parts, rig.root_part_key); } catch (err) { blocking.push(issue(err.code || 'PAPER_RIG_INVALID', `layers.${layer.layer_key}.rig_id`, err.message, { details: err.details })); }
        if (rig.parts.length > PAPER_MAX_RIG_PARTS) blocking.push(issue('PAPER_LIMIT_EXCEEDED', `rigs.${rig.id}.parts`, `rig 部件不能超过 ${PAPER_MAX_RIG_PARTS}`));
        const partKeys = new Set(rig.parts.map((part) => String(part.key)));
        const rigTracks = tracks.filter((track) => String(track.target || '').startsWith('rig.'));
        for (const track of rigTracks) {
          const targetParts = String(track.target).split('.');
          const partKey = targetParts[targetParts.length - 1];
          if (!partKeys.has(partKey)) {
            blocking.push(issue('PAPER_RIG_PART_MISSING', `layers.${layer.layer_key}.animation_json.tracks`, `动画引用的 rig 部件不存在: ${partKey}`, { track }));
          }
        }
        const rigSemanticTracks = rigTracks.filter((track) => trackIsSemantic(track, { rigKey: rig.rig_key }) && rigTrackModel.trackHasSpatialChange(track));
        if (rigSemanticTracks.length) hasMotion = true;
        if (layer.role === 'primary' && animation.intentional_hold !== true && !rigSemanticTracks.length && !options.allowIntentionalHold) {
          blocking.push(issue('MOTION_COVERAGE_MISSING', `layers.${layer.layer_key}.animation_json.motion_coverage`, '主角必须包含真实 rig 局部动作（例如 arm_front.rotation），普通 layer 微移不能替代', { layer_key: layer.layer_key }));
        }
        const loadBearing = animation.motion_coverage?.load_bearing_track;
        if (loadBearing && !rigTracks.some((track) => `${track.target}.${track.property}` === loadBearing || String(track.target).replace(/^rig\.[^.]+\./, 'rig.') + `.${track.property}` === loadBearing)) {
          blocking.push(issue('MOTION_LOAD_BEARING_TRACK_MISSING', `layers.${layer.layer_key}.animation_json.motion_coverage.load_bearing_track`, '声明的 load-bearing rig 轨道未找到', { load_bearing_track: loadBearing }));
        }
        for (const part of rig.parts) {
          if (!part.asset_id) blocking.push(issue('MISSING_SEMANTIC_ASSET', `layers.${layer.layer_key}.rig.${part.key}`, 'rig 部件缺少资产'));
          else {
            try {
              const partAsset = paperAssetService.resolveAssetForRender(db, cfg, part.asset_id, { allowCandidate: options.allowCandidate });
              readyAssets += 1;
              if (!['pass', 'manual_pass'].includes(partAsset.matte_quality)) {
                blocking.push(issue('PAPER_MATTE_INVALID', `layers.${layer.layer_key}.rig.${part.key}`, 'rig 透明部件必须通过抠图审核', { matte_quality: partAsset.matte_quality }));
              }
            }
            catch (err) { blocking.push(issue(err.code || 'PAPER_ASSET_INVALID', `layers.${layer.layer_key}.rig.${part.key}`, err.message, { details: err.details })); }
          }
        }
      }
    }
    if (layer.role === 'primary' || layer.layer_type === 'character') {
      if (hasMotion) { motionCoverage.ok = true; motionCoverage.action_layers += 1; motionCoverage.peak_frame = animation.motion_coverage?.peak_frame ?? motionCoverage.peak_frame; }
      else if (animation.intentional_hold !== true && !options.allowIntentionalHold) {
        blocking.push(issue('MOTION_COVERAGE_MISSING', `layers.${layer.layer_key}.animation_json`, 'primary 图层必须有动作轨道或明确 intentional_hold', { layer_key: layer.layer_key }));
      }
    }
    const opacity = Number(transform.opacity ?? 1);
    if (opacity < 0 || opacity > 1) blocking.push(issue('PAPER_SCHEMA_INVALID', `layers.${layer.layer_key}.transform.opacity`, 'opacity 必须在 0..1'));
    const occlusion = parseJson(layer.occlusion_json, {});
    if (occlusion.occluder_layer_key && !layerKeys.has(occlusion.occluder_layer_key)) blocking.push(issue('OCCLUDER_MISSING', `layers.${layer.layer_key}.occlusion_json.occluder_layer_key`, '遮挡层不存在'));
    if (occlusion.occluder_layer_key && layerKeys.has(occlusion.occluder_layer_key)) {
      const occluder = layers.find((item) => item.layer_key === occlusion.occluder_layer_key);
      if (!['foreground', 'occluder', 'decoration'].includes(occluder?.layer_type)) {
        blocking.push(issue('OCCLUDER_INVALID', `layers.${layer.layer_key}.occlusion_json.occluder_layer_key`, 'occluder 必须引用 foreground/occluder 图层'));
      }
    }
    const maskAssetId = occlusion.mask_asset_id != null ? occlusion.mask_asset_id : layer.mask_asset_id;
    if (maskAssetId != null) {
      try {
        const mask = paperAssetService.resolveAssetForRender(db, cfg, maskAssetId);
        if (mask.asset_type !== 'mask') warnings.push(issue('MASK_ASSET_TYPE_WARNING', `layers.${layer.layer_key}.occlusion_json.mask_asset_id`, '遮挡引用的资产类型不是 mask，请确认其用途'));
      }
      catch (err) { blocking.push(issue(err.code || 'MASK_ASSET_INVALID', `layers.${layer.layer_key}.occlusion_json.mask_asset_id`, err.message, { details: err.details })); }
    }
    if (Array.isArray(occlusion.affected_part_keys) && occlusion.affected_part_keys.length) {
      const rig = layer.rig_id != null ? paperRigService.get(db, layer.rig_id) : null;
      const partKeys = new Set((rig?.parts || []).map((part) => String(part.key)));
      if (!rig) blocking.push(issue('PAPER_RIG_MISSING', `layers.${layer.layer_key}.occlusion_json.affected_part_keys`, '局部遮挡部件必须引用 rig'));
      for (const partKey of occlusion.affected_part_keys) {
        if (!partKeys.has(String(partKey))) blocking.push(issue('PAPER_RIG_PART_MISSING', `layers.${layer.layer_key}.occlusion_json.affected_part_keys`, `遮挡部件不存在: ${partKey}`));
      }
      if (!occlusion.occluder_layer_key && maskAssetId == null && !occlusion.clip_path) {
        blocking.push(issue('OCCLUSION_IMPLEMENTATION_MISSING', `layers.${layer.layer_key}.occlusion_json`, '局部穿插必须配置 occluder_layer_key、mask_asset_id 或 clip_path'));
      }
    }
    const clipPathValid = typeof occlusion.clip_path === 'string'
      ? occlusion.clip_path.length <= 10000 && !/url\s*\(|javascript:|data:/i.test(occlusion.clip_path)
      : Array.isArray(occlusion.clip_path) && occlusion.clip_path.length >= 3 && occlusion.clip_path.every((point) => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1));
    if (occlusion.clip_path != null && !clipPathValid) {
      blocking.push(issue('PAPER_OCCLUSION_INVALID', `layers.${layer.layer_key}.occlusion_json.clip_path`, 'clip_path 只能是受限的本地路径数据'));
    }
    if (transform.allow_bleed) warnings.push(issue('SAFE_AREA_BLEED', `layers.${layer.layer_key}.transform`, '图层允许超出安全区'));
  }
  if (!layers.length) blocking.push(issue('MISSING_SEMANTIC_ASSET', 'layers', '至少需要一个独立背景/主体层'));
  if (!motionCoverage.ok) {
    const camera = parseJson(composition.camera_json, {});
    const hasCameraMotion = hasMeaningfulCameraMotion(camera);
    if (hasCameraMotion) { motionCoverage = { ok: true, action_layers: 0, camera_only: true, peak_frame: null }; }
    else if (!parseJson(composition.continuity_json, {}).intentional_hold) blocking.push(issue('MOTION_COVERAGE_MISSING', 'camera_json', '镜头没有主体动作或有意相机运动'));
  }
  const proofRows = db.prepare('SELECT proof_kind, status FROM paper_render_proofs WHERE composition_id = ? ORDER BY proof_kind').all(Number(compositionId));
  const proofMap = Object.fromEntries(proofRows.map((row) => [row.proof_kind, row.status]));
  const missingProofs = PAPER_PROOF_KINDS.filter((kind) => proofMap[kind] !== 'pass');
  const result = {
    ok: blocking.length === 0,
    composition_id: Number(compositionId),
    version: Number(composition.version),
    status: blocking.length ? 'assets_pending' : (missingProofs.length ? 'ready' : 'rendered'),
    blocking,
    warnings,
    computed: {
      visible_semantic_layers: visibleSemanticLayers,
      ready_assets: readyAssets,
      asset_ids: [...assetIds],
      motion_coverage: motionCoverage,
      proof_frames: { complete: missingProofs.length === 0, missing: missingProofs },
    },
  };
  if (!options.readOnly) {
    db.prepare('UPDATE paper_compositions SET last_validation_json = ?, status = CASE WHEN ? = 1 THEN ? ELSE status END, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(JSON.stringify(result), result.ok ? 1 : 0, result.status, new Date().toISOString(), Number(compositionId));
  }
  return result;
}

function assertCanRender(result, options = {}) {
  const blocking = result.blocking || [];
  if (blocking.length) throw new PaperError('PAPER_RENDER_GATE_FAILED', '纸片合成未通过正式渲染门禁', { blocking, warnings: result.warnings || [], computed: result.computed }, 409);
  if (!options.preview && result.status === 'assets_pending') throw new PaperError('PAPER_RENDER_GATE_FAILED', '纸片合成未通过正式渲染门禁', { blocking }, 409);
}

module.exports = { validate, assertCanRender, issue };
