const paperAssetService = require('./paperAssetService');
const paperRigService = require('./paperRigService');
const {
  PaperError,
  PAPER_RENDERER_VERSION,
  PAPER_SCHEMA_VERSION,
  PAPER_MAX_LAYERS,
  canonicalJson,
  sha256,
  parseJson,
  clamp,
  normalizeRelativePath,
} = require('./paperUtils');

function phaseByName(phases, name, fallback) {
  return phases.find((phase) => phase.name === name) || fallback;
}

/**
 * Timing can be written by the planner as {timing: {...}} or by the timing
 * locker as top-level {cues, source, ...}.  The latter must win when both
 * shapes are present; otherwise a stale planner draft silently controls the
 * render snapshot.
 */
function resolveTiming(audio) {
  const nested = audio && audio.timing && typeof audio.timing === 'object' ? audio.timing : {};
  const topLevel = audio && typeof audio === 'object' ? audio : {};
  return {
    ...nested,
    ...topLevel,
    phases: Array.isArray(topLevel.phases) ? topLevel.phases : nested.phases,
    cues: Array.isArray(topLevel.cues) ? topLevel.cues : nested.cues,
    source: topLevel.source || nested.source,
    timing_hash: topLevel.timing_hash || nested.timing_hash,
  };
}

function normalizePhases(composition) {
  const audio = parseJson(composition.audio_json, {});
  const timing = resolveTiming(audio);
  const rawDuration = Number(composition.duration_frames);
  const duration = Math.max(1, Number.isFinite(rawDuration) ? Math.round(rawDuration) : 1);
  const phases = Array.isArray(timing.phases) ? timing.phases.map((phase) => {
    const start = clamp(Math.round(Number(phase.start_frame) || 0), 0, duration);
    return {
      name: String(phase.name),
      start_frame: start,
      end_frame: clamp(Math.max(start, Math.round(Number(phase.end_frame) || 0)), 0, duration),
    };
  }) : [];
  if (phases.length) return phases;
  const names = ['anticipation', 'entry', 'action', 'peak', 'settle', 'hold', 'exit'];
  if (duration < names.length) {
    const shortNames = duration === 1 ? ['hold'] : ['anticipation', 'action', 'peak', 'settle', 'hold', 'exit'].slice(0, duration);
    return shortNames.map((name, index) => ({ name, start_frame: index, end_frame: index + 1 }));
  }
  const ratios = [0.08, 0.14, 0.34, 0.11, 0.14, 0.15, 0.04];
  let cursor = 0;
  let ratioCursor = 0;
  const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
  return names.map((name, index) => {
    ratioCursor += ratios[index];
    const end = index === names.length - 1
      ? duration
      : clamp(Math.round(duration * ratioCursor / ratioTotal), cursor, duration);
    const item = { name, start_frame: cursor, end_frame: end };
    cursor = item.end_frame;
    return item;
  });
}

function phaseRange(phases, name, fallbackStart = 0, fallbackEnd = 1) {
  const found = phaseByName(phases, name, null);
  return found || { start_frame: fallbackStart, end_frame: fallbackEnd };
}

function clampFrame(value, durationFrames, fallback = 0) {
  const rawDuration = Number(durationFrames);
  const duration = Math.max(1, Number.isFinite(rawDuration) ? Math.round(rawDuration) : 1);
  const numeric = Number(value);
  const frame = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return clamp(frame, 0, duration - 1);
}

/**
 * Proof frames are part of the render contract, not renderer defaults. Phase
 * ranges are half-open [start_frame, end_frame), therefore phase-end proofs
 * sample end_frame - 1 and exact_final always samples duration - 1.
 */
function compileProofFrames({ phases, timing, duration_frames }) {
  const rawDuration = Number(duration_frames);
  const duration = Math.max(1, Number.isFinite(rawDuration) ? Math.round(rawDuration) : 1);
  const exactFinal = duration - 1;
  const anticipation = phaseRange(phases, 'anticipation', 0, Math.min(duration, 1));
  const peak = phaseRange(phases, 'peak', 0, duration);
  const settle = phaseRange(phases, 'settle', peak.end_frame, duration);
  const hold = phaseByName(phases, 'hold', null);

  const peakStart = Number.isFinite(Number(peak.start_frame)) ? Number(peak.start_frame) : 0;
  const peakEnd = Number.isFinite(Number(peak.end_frame)) ? Number(peak.end_frame) : duration;
  const peakMidpoint = Math.floor((peakStart + peakEnd) / 2);
  const cues = Array.isArray(timing?.cues) ? timing.cues : [];
  // A speech_peak cue is an explicit editorial decision and takes priority
  // over the geometric phase midpoint. Only the exact semantic cue kind is
  // accepted so unrelated manual cues cannot move the proof accidentally.
  const speechPeak = cues.find((cue) => String(cue?.kind || '').trim().toLowerCase() === 'speech_peak');
  const speechPeakFrame = Number(speechPeak?.frame);
  const peakFrame = Number.isFinite(speechPeakFrame) ? speechPeakFrame : peakMidpoint;
  const holdStart = Number(hold?.start_frame);
  const finalMinusHold = hold && Number.isFinite(holdStart) ? holdStart - 1 : exactFinal - 1;

  return {
    first: 0,
    anticipation: clampFrame(Number(anticipation.end_frame) - 1, duration),
    peak: clampFrame(peakFrame, duration, peakMidpoint),
    settle: clampFrame(Number(settle.end_frame) - 1, duration, exactFinal),
    final_minus_hold: clampFrame(finalMinusHold, duration, exactFinal),
    exact_final: exactFinal,
  };
}

function trackToLegacyMotion(animation, phases) {
  const tracks = Array.isArray(animation.tracks) ? animation.tracks : [];
  const entryPhase = phaseRange(phases, 'entry', 0, 1);
  const layerTracks = tracks.filter((track) => track.target === 'layer' || !track.target);
  const entry = layerTracks.find((track) => track.phase === 'entry' || track.property === 'entry');
  const motion = {};
  if (entry) {
    const from = entry.from ?? entry.keyframes?.[0]?.value ?? 0;
    const to = entry.to ?? entry.keyframes?.[entry.keyframes.length - 1]?.value ?? 0;
    motion.entry = {
      start_frame: entry.start_frame ?? entryPhase.start_frame,
      end_frame: entry.end_frame ?? entryPhase.end_frame,
      from_x: entry.property === 'x' ? from : entry.from_x || 0,
      to_x: entry.property === 'x' ? to : entry.to_x || 0,
      from_y: entry.property === 'y' ? from : entry.from_y || 0,
      to_y: entry.property === 'y' ? to : entry.to_y || 0,
      from_scale: entry.property === 'scale' ? from : entry.from_scale ?? 1,
      to_scale: entry.property === 'scale' ? to : entry.to_scale ?? 1,
      from_rotation: entry.property === 'rotation' ? from : entry.from_rotation || 0,
      to_rotation: entry.property === 'rotation' ? to : entry.to_rotation || 0,
      from_opacity: entry.property === 'opacity' ? from : entry.from_opacity ?? 1,
      to_opacity: entry.property === 'opacity' ? to : entry.to_opacity ?? 1,
      ease: entry.ease || 'power3.out',
    };
  }
  const ambient = animation.ambient;
  if (ambient) {
    const hold = phaseRange(phases, ambient.phase || 'hold', 0, 1);
    motion.ambient = {
      start_frame: hold.start_frame,
      end_frame: hold.end_frame,
      period_frames: ambient.period_frames || 100,
      x: ambient.x || 0,
      y: ambient.amplitude ?? ambient.y ?? 0,
      rotation: ambient.rotation || 0,
      scale: ambient.scale || 0,
      phase: ambient.phase_offset || 0,
    };
  }
  const neutralFor = (property) => (property === 'scale' || property === 'opacity' ? 1 : 0);
  motion.tracks = layerTracks
    .filter((track) => track !== entry && ['x', 'y', 'scale', 'rotation', 'opacity'].includes(String(track.property || '')))
    .map((track) => {
      const range = phaseRange(phases, track.phase || 'action', 0, 1);
      const endFrame = Math.max(range.start_frame, range.end_frame - 1);
      const authored = Array.isArray(track.keyframes) && track.keyframes.length
        ? track.keyframes.map((keyframe) => ({ ...keyframe }))
        : [
          ...(range.start_frame > 0 ? [{ frame: range.start_frame - 1, value: neutralFor(track.property) }] : []),
          { frame: range.start_frame, value: Number(track.from ?? neutralFor(track.property)) },
          { frame: endFrame, value: Number(track.to ?? neutralFor(track.property)), ease: track.ease },
        ];
      return { property: track.property, ease: track.ease || 'linear', keyframes: authored };
    });
  return motion;
}

function buildLayerSnapshot(db, cfg, row, phases, assetCache, rigCache) {
  const transform = { ...parseJson(row.transform_json, {}) };
  const animation = { ...parseJson(row.animation_json, {}) };
  const occlusion = { ...parseJson(row.occlusion_json, {}) };
  let asset = null;
  if (row.paper_asset_id != null) {
    asset = assetCache.get(row.paper_asset_id) || paperAssetService.resolveAssetForRender(db, cfg, row.paper_asset_id);
    assetCache.set(row.paper_asset_id, asset);
  }
  let rig = null;
  if (row.rig_id != null) {
    rig = rigCache.get(row.rig_id) || paperRigService.get(db, row.rig_id);
    if (!rig) throw new PaperError('PAPER_RIG_MISSING', '图层引用的 rig 不存在', { layer_id: row.id, rig_id: row.rig_id }, 422);
    rigCache.set(row.rig_id, rig);
  }
  const out = {
    id: row.id,
    key: row.layer_key,
    type: row.layer_type,
    role: row.role,
    z_index: Number(row.z_index || 0),
    depth: Number(row.depth ?? 0.5),
    src: asset?.resolved_local_path || null,
    asset_hash: asset?.asset_hash || null,
    transform: {
      x: Number(transform.x ?? 0.5), y: Number(transform.y ?? 0.5), width: Number(transform.width ?? 1),
      anchor_x: Number(transform.anchor_x ?? 0.5), anchor_y: Number(transform.anchor_y ?? 0.5),
      scale: Number(transform.scale ?? 1), rotation: Number(transform.rotation ?? 0), opacity: Number(transform.opacity ?? 1),
    },
    motion: trackToLegacyMotion(animation, phases),
    animation,
    occlusion,
    rig_id: rig?.id || null,
  };
  const maskAssetId = occlusion.mask_asset_id != null ? occlusion.mask_asset_id : row.mask_asset_id;
  if (maskAssetId != null) {
    const mask = assetCache.get(maskAssetId) || paperAssetService.resolveAssetForRender(db, cfg, maskAssetId);
    assetCache.set(maskAssetId, mask);
    out.occlusion = { ...occlusion, mask_asset_id: maskAssetId, mask_src: mask.resolved_local_path, mask_hash: mask.asset_hash };
  }
  if (rig) {
    out.rig = {
      id: rig.id,
      root: rig.root_part_key,
      parts: rig.parts.map((part) => {
        const partAsset = assetCache.get(part.asset_id) || paperAssetService.resolveAssetForRender(db, cfg, part.asset_id);
        assetCache.set(part.asset_id, partAsset);
        const processing = partAsset.processing_json || {};
        const width = Number(part.width || (part.key === 'torso' ? 1 : part.key === 'head' ? 0.62 : 0.78));
        const aspect = Number(part.aspect_ratio || (processing.width && processing.height ? processing.width / processing.height : 1));
        return {
          ...part,
          src: partAsset.resolved_local_path,
          asset_hash: partAsset.asset_hash,
          processing_json: partAsset.processing_json || {},
          content_bbox_json: partAsset.content_bbox_json || {},
          alpha_bbox_json: partAsset.alpha_bbox_json || {},
          width,
          aspect_ratio: aspect || 1,
          offset: [Number(part.initial_transform?.x || 0), Number(part.initial_transform?.y || 0)],
          initial_rotation: Number(part.initial_transform?.rotation || 0),
        };
      }),
      tracks: Array.isArray(animation.tracks) ? animation.tracks.filter((track) => String(track.target || '').startsWith('rig.')).map((track) => ({
        target: String(track.target).replace(/^rig\.[^.]+\./, ''),
        property: track.property,
        ease: track.ease,
        keyframes: track.keyframes || [
          { frame: phaseRange(phases, track.phase || 'action', 0, 1).start_frame, value: Number(track.from ?? 0) },
          { frame: phaseRange(phases, track.phase || 'action', 0, 1).end_frame, value: Number(track.to ?? 0), ease: track.ease },
        ],
      })) : [],
    };
  }
  return out;
}

function loadCompositionGraph(db, compositionId) {
  const composition = db.prepare('SELECT * FROM paper_compositions WHERE id = ? AND deleted_at IS NULL').get(Number(compositionId));
  if (!composition) throw new PaperError('PAPER_NOT_FOUND', '纸片合成不存在', { composition_id: compositionId }, 404);
  const storyboard = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(composition.storyboard_id));
  const layers = db.prepare('SELECT * FROM paper_layers WHERE composition_id = ? AND deleted_at IS NULL ORDER BY z_index, layer_key').all(Number(compositionId));
  return { composition, storyboard, layers };
}

function compile(db, cfg, compositionId, options = {}) {
  const graph = loadCompositionGraph(db, compositionId);
  const { composition } = graph;
  if (!options.skipStatusCheck && composition.audio_timing_status !== 'locked' && !options.allowProvisional) {
    throw new PaperError('PAPER_TIMING_NOT_LOCKED', '正式渲染前必须锁定音频时序', { composition_id: compositionId }, 409);
  }
  if (graph.layers.length > PAPER_MAX_LAYERS) throw new PaperError('PAPER_LIMIT_EXCEEDED', `图层不能超过 ${PAPER_MAX_LAYERS}`, { count: graph.layers.length }, 413);
  const phases = normalizePhases(composition);
  const audio = parseJson(composition.audio_json, {});
  const timing = resolveTiming(audio);
  const assetCache = new Map();
  const rigCache = new Map();
  const layers = graph.layers.map((row) => buildLayerSnapshot(db, cfg, row, phases, assetCache, rigCache));
  const rigs = [...rigCache.values()].map((rig) => {
    const layer = layers.find((item) => item.rig_id === rig.id);
    return layer?.rig || { id: rig.id, root: rig.root_part_key, parts: [] };
  });
  const camera = parseJson(composition.camera_json, { start: { x: 0.5, y: 0.5, scale: 1, rotation: 0 }, end: { x: 0.5, y: 0.5, scale: 1, rotation: 0 }, ease: 'sine.inOut' });
  const snapshot = {
    schema_version: PAPER_SCHEMA_VERSION,
    composition: {
      id: composition.id,
      storyboard_id: composition.storyboard_id,
      sequence_id: composition.sequence_id,
      sequence_index: composition.sequence_index,
      template: composition.template_key,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      duration_frames: composition.duration_frames,
      aspect_ratio: `${composition.width}:${composition.height}`,
    },
    timing: {
      status: composition.audio_timing_status,
      source: timing.source || 'manual',
      phases,
      cues: Array.isArray(timing.cues) ? timing.cues : [],
      timing_hash: composition.audio_timing_hash || timing.timing_hash || null,
    },
    proof_frames: compileProofFrames({
      phases,
      timing,
      duration_frames: composition.duration_frames,
    }),
    camera,
    layers,
    rigs,
    audio: {
      timing_hash: composition.audio_timing_hash || null,
      sources: Array.isArray(timing.sources) ? timing.sources : (Array.isArray(audio.sources) ? audio.sources : []),
      cues: Array.isArray(timing.cues) ? timing.cues : (Array.isArray(audio.cues) ? audio.cues : []),
      enforce_audio_track: audio.enforce_audio_track !== false,
      sample_rate: Number(audio.sample_rate || 48000),
    },
    provenance: {
      storyboard_id: composition.storyboard_id,
      compiler_version: 'paper-spec-v2',
      renderer_version: PAPER_RENDERER_VERSION,
      style_signature: null,
    },
    limits: { max_layers: PAPER_MAX_LAYERS, allow_bleed: false, seed: Number(composition.storyboard_id || composition.id) },
  };
  const specHash = sha256(canonicalJson(snapshot));
  snapshot.provenance.spec_hash = specHash;
  snapshot.provenance.render_hash = sha256(canonicalJson({ snapshot, renderer_version: PAPER_RENDERER_VERSION }));
  return { snapshot, spec_hash: specHash, render_hash: snapshot.provenance.render_hash, graph };
}

module.exports = {
  compile,
  loadCompositionGraph,
  normalizePhases,
  trackToLegacyMotion,
  resolveTiming,
  clampFrame,
  compileProofFrames,
};
