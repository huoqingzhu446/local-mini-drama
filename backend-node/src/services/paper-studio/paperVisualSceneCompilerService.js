const transitionService = require('./paperSceneTransitionService');

const SCENE_CHANGE_PATTERN = /(?:镜头|画面)(?:随即|随后|突然|缓缓)?(?:切换|切|转向|移向|转到|切至|切到)(?:到|至|向)?|(?:^|[，。；])(?:切到|切至|转到|与此同时|同一时间|另一边|另一处)(?=[^，。；])/g;
const LOCATION_WORDS = [
  '城内', '城外', '室内', '室外', '营帐', '军营', '战场', '甬道', '街道', '巷道', '宫殿',
  '院内', '院外', '屋内', '屋外', '山上', '山下', '河岸', '岸边', '地图', '仓廒', '城墙',
];
const DEFAULT_TRANSITION_SECONDS = 0.6;
const MIN_TRANSITION_SECONDS = 0.3;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSceneKey(value, index) {
  const key = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || `scene_${index + 1}`;
}

function sceneSegments(storyboard = {}) {
  const source = [storyboard.description, storyboard.action]
    .filter(Boolean)
    .join('；')
    .trim();
  if (!source) return [];
  const marked = source.replace(SCENE_CHANGE_PATTERN, (match) => `\n<<<SCENE>>>${match}`);
  const explicit = marked
    .split(/\n<<<SCENE>>>/)
    .map((item) => item.replace(/^[，。；\s]+|[，。；\s]+$/g, '').trim())
    .filter((item) => item.length >= 2);
  if (explicit.length >= 2) return explicit;
  const clauses = source.split(/[。；\n]+/).map((item) => item.trim()).filter((item) => item.length >= 2);
  const grouped = [];
  for (const clause of clauses) {
    const location = LOCATION_WORDS.find((word) => clause.includes(word)) || null;
    const previous = grouped[grouped.length - 1];
    if (previous && location && previous.location && location !== previous.location) {
      grouped.push({ location, text: clause });
    } else if (previous) {
      previous.text = `${previous.text}；${clause}`;
      if (!previous.location && location) previous.location = location;
    } else {
      grouped.push({ location, text: clause });
    }
  }
  return grouped.map((item) => item.text);
}

function locationFor(text, fallback) {
  return LOCATION_WORDS.find((word) => String(text || '').includes(word)) || fallback;
}

function inferVisualScenes(storyboard = {}) {
  const segments = sceneSegments(storyboard);
  if (segments.length < 2) {
    const description = [storyboard.description, storyboard.action, storyboard.title].find((item) => String(item || '').trim()) || '当前视觉场景';
    return [{
      key: 'scene_main', label: storyboard.title || '主场景', description,
      location: locationFor(description, storyboard.location || '当前地点'),
      time_context: 'continuous', camera_signature: storyboard.camera_motion || 'static',
      subject_keys: [], source_caption_keys: [], confidence: 0.7,
      environment_family_key: 'clean_environment',
    }];
  }
  let previousLocation = storyboard.location || '起始地点';
  let previousEnvironment = 'clean_environment';
  return segments.map((description, index) => {
    const location = locationFor(description, index === 0 ? storyboard.location || '起始地点' : previousLocation);
    const sameLocation = index > 0 && location === previousLocation;
    const key = normalizeSceneKey(`scene_${index + 1}_${location}`, index);
    const result = {
      key,
      label: location,
      description,
      location,
      time_context: /多年后|数日后|三日后|翌日|次日|后来|闪回|回忆/.test(description)
        ? 'time_jump'
        : /与此同时|同一时间/.test(description) ? 'parallel' : 'continuous',
      camera_signature: storyboard.camera_motion || 'static',
      subject_keys: [], source_caption_keys: [], confidence: 0.86,
      environment_family_key: index === 0 || sameLocation ? previousEnvironment : `${key}_environment`,
    };
    previousLocation = location;
    previousEnvironment = result.environment_family_key;
    return result;
  });
}

function inferredRelation(previous, scene) {
  const text = `${previous?.description || ''} ${scene?.description || ''}`;
  if (/硬切|撞击切|闪切|快速蒙太奇/.test(text)) return 'explicit_hard_cut';
  if (scene?.time_context === 'time_jump' || /多年后|数日后|三日后|翌日|次日|后来|闪回|回忆/.test(scene?.description || '')) return 'time_jump';
  if (previous?.location !== scene?.location) return 'location_change';
  if ((previous?.subject_keys || []).join('|') !== (scene?.subject_keys || []).join('|')) return 'subject_change';
  return 'camera_change';
}

function orderedCaptionMatch(captions, matcher, options = {}) {
  const patterns = (Array.isArray(matcher) ? matcher : [matcher])
    .filter(Boolean)
    .map((value) => value instanceof RegExp
      ? value
      : new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const afterFrame = Math.max(-1, Number(options.after_frame == null ? -1 : options.after_frame));
  const excluded = new Set((options.exclude_caption_keys || []).map(String));
  const afterKey = options.after_caption_key == null ? null : String(options.after_caption_key);
  let afterKeySeen = afterKey == null;
  const ordered = [...(captions || [])].sort((left, right) => Number(left.start_frame || 0) - Number(right.start_frame || 0));
  for (const caption of ordered) {
    const key = String(caption.key || '');
    if (!afterKeySeen) {
      if (key === afterKey) afterKeySeen = true;
      continue;
    }
    if (excluded.has(key) || Number(caption.end_frame || 0) <= afterFrame) continue;
    const matched = patterns.findIndex((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(String(caption.text || ''));
    });
    if (matched >= 0) {
      const edge = options.edge === 'start' ? 'start_frame' : 'end_frame';
      return {
        frame: Number(caption[edge]), caption_key: caption.key || null,
        caption, confidence: matched === 0 ? 1 : Math.max(0.72, 0.94 - matched * 0.08),
      };
    }
  }
  return {
    frame: Number(options.fallback_frame || 0), caption_key: null, caption: null, confidence: 0.45,
  };
}

function normalizeVisualScenes(blueprint, storyboard) {
  const source = Array.isArray(blueprint?.visual_scenes) && blueprint.visual_scenes.length
    ? clone(blueprint.visual_scenes)
    : inferVisualScenes(storyboard);
  return source.map((scene, index) => ({
    key: normalizeSceneKey(scene.key, index),
    label: scene.label || scene.location || `场景 ${index + 1}`,
    description: scene.description || storyboard.description || storyboard.title || `场景 ${index + 1}`,
    location: scene.location || locationFor(scene.description, `场景 ${index + 1}`),
    time_context: scene.time_context || 'continuous',
    camera_signature: scene.camera_signature || storyboard.camera_motion || 'static',
    subject_keys: [...new Set((scene.subject_keys || []).map(String))],
    source_caption_keys: [...new Set((scene.source_caption_keys || []).map(String))],
    placement_regions: clone(scene.placement_regions || blueprint?.environment?.placement_regions || []),
    confidence: Number(scene.confidence == null ? 0.85 : scene.confidence),
    environment_family_key: scene.environment_family_key
      || (index === 0 ? 'clean_environment' : `${normalizeSceneKey(scene.key, index)}_environment`),
  }));
}

function boundaryFramesForScenes(scenes, plan, captions, durationFrames) {
  const explicit = (plan.sceneBoundaryFrames || []).map(Number).filter(Number.isFinite);
  const orderedCaptions = [...(captions || [])].sort((left, right) => Number(left.start_frame || 0) - Number(right.start_frame || 0));
  return scenes.slice(1).map((scene, index) => {
    if (Number.isFinite(explicit[index])) return Math.max(1, Math.min(durationFrames - 2, Math.round(explicit[index])));
    const sceneCaption = orderedCaptions.find((caption) => scene.source_caption_keys.includes(String(caption.key || '')));
    if (sceneCaption) return Math.max(1, Math.min(durationFrames - 2, Math.round(Number(sceneCaption.start_frame || 0))));
    if (orderedCaptions.length >= scenes.length) {
      const captionIndex = Math.min(orderedCaptions.length - 1, Math.floor((orderedCaptions.length * (index + 1)) / scenes.length));
      return Math.max(1, Math.min(durationFrames - 2, Math.round(Number(orderedCaptions[captionIndex].start_frame || 0))));
    }
    return Math.max(1, Math.min(durationFrames - 2, Math.round((durationFrames * (index + 1)) / scenes.length)));
  });
}

function buildTransitionContracts(scenes, blueprint, plan, captions, fps, durationFrames) {
  if (scenes.length < 2) return [];
  const intents = Array.isArray(blueprint?.transition_contracts) ? blueprint.transition_contracts : [];
  const boundaries = boundaryFramesForScenes(scenes, plan, captions, durationFrames);
  return scenes.slice(1).map((scene, index) => {
    const previous = scenes[index];
    const intent = intents.find((item) => item.from_scene_key === previous.key && item.to_scene_key === scene.key)
      || intents[index]
      || {};
    const relation = intent.relation || inferredRelation(previous, scene);
    const kind = intent.kind || (relation === 'location_change'
      ? 'dust_whip_pan'
      : relation === 'time_jump' ? 'color_dip' : relation === 'explicit_hard_cut' ? 'hard_cut' : 'soft_crossfade');
    const duration = transitionService.durationFramesFor({ ...intent, relation, kind }, fps);
    const anchorRatio = Number(intent.anchor_ratio);
    const boundary = Number.isFinite(anchorRatio)
      ? Math.max(1, Math.min(durationFrames - 2, Math.round((durationFrames - 1) * anchorRatio)))
      : boundaries[index];
    const start = Math.max(0, boundary - Math.floor(duration / 2));
    const end = Math.min(durationFrames - 1, start + duration);
    return {
      key: intent.key || `transition_${index + 1}`,
      from_scene_key: previous.key,
      to_scene_key: scene.key,
      relation,
      kind,
      start_frame: start,
      end_frame: end,
      direction: intent.direction || 'left',
      easing_out: intent.easing_out || 'ease-in',
      easing_in: intent.easing_in || 'ease-out',
      requires_new_plate: intent.requires_new_plate == null ? relation === 'location_change' : Boolean(intent.requires_new_plate),
      audio_policy: 'continuous',
      caption_policy: 'global_overlay',
      hard_cut_allowed: intent.hard_cut_allowed == null ? relation === 'explicit_hard_cut' : Boolean(intent.hard_cut_allowed),
      hard_cut_reason: intent.hard_cut_reason || (relation === 'explicit_hard_cut' ? '剧本明确要求快速切镜' : null),
      source_caption_key: intent.source_caption_key || scene.source_caption_keys[0] || null,
      confidence: Number(intent.confidence == null ? Math.min(previous.confidence, scene.confidence) : intent.confidence),
      motion_profile: intent.motion_profile || (relation === 'explicit_hard_cut' ? 'hard_cut' : 'normal'),
    };
  });
}

function frameKeyframes(items) {
  return uniqueBy(items.sort((left, right) => Number(left.frame) - Number(right.frame)), (item) => Number(item.frame));
}

function sceneTracks(scenes, transitions, durationFrames) {
  const tracks = [];
  scenes.forEach((scene, index) => {
    const incoming = index > 0 ? transitions[index - 1] : null;
    const outgoing = index < transitions.length ? transitions[index] : null;
    const hardIncoming = incoming?.kind === 'hard_cut' || incoming?.relation === 'explicit_hard_cut';
    const hardOutgoing = outgoing?.kind === 'hard_cut' || outgoing?.relation === 'explicit_hard_cut';
    const direction = outgoing?.direction || incoming?.direction || 'left';
    const sign = ['right', 'from_right'].includes(direction) ? 1 : -1;
    const policy = transitionService.policyFor(outgoing?.kind || incoming?.kind, outgoing?.relation || incoming?.relation);
    const travel = Number(policy.distance || 0.035);
    const blurAmount = Number(policy.blur || 4);
    const opacity = [];
    const x = [];
    const blur = [];
    if (!incoming) {
      opacity.push({ frame: 0, value: 1 });
      x.push({ frame: 0, value: 0 });
      blur.push({ frame: 0, value: 0 });
    } else if (hardIncoming) {
      opacity.push({ frame: 0, value: 0 }, { frame: Math.max(0, incoming.start_frame - 1), value: 0 }, { frame: incoming.start_frame, value: 1 });
      x.push({ frame: 0, value: 0 }, { frame: durationFrames - 1, value: 0 });
      blur.push({ frame: 0, value: 0 }, { frame: durationFrames - 1, value: 0 });
    } else {
      opacity.push({ frame: 0, value: 0 }, { frame: incoming.start_frame, value: 0 }, { frame: incoming.end_frame, value: 1, easing: 'linear' });
      x.push({ frame: 0, value: -sign * travel }, { frame: incoming.start_frame, value: -sign * travel }, { frame: incoming.end_frame, value: 0, easing: incoming.easing_in });
      blur.push({ frame: 0, value: blurAmount }, { frame: incoming.start_frame, value: blurAmount }, { frame: incoming.end_frame, value: 0, easing: incoming.easing_in });
    }
    if (hardOutgoing) {
      opacity.push({ frame: Math.max(0, outgoing.start_frame - 1), value: 1 }, { frame: outgoing.start_frame, value: 0 }, { frame: durationFrames - 1, value: 0 });
      if (!incoming) {
        x.push({ frame: durationFrames - 1, value: 0 });
        blur.push({ frame: durationFrames - 1, value: 0 });
      }
    } else if (outgoing) {
      opacity.push({ frame: outgoing.start_frame, value: 1 }, { frame: outgoing.end_frame, value: 0, easing: 'linear' }, { frame: durationFrames - 1, value: 0 });
      x.push({ frame: outgoing.start_frame, value: 0 }, { frame: outgoing.end_frame, value: sign * travel, easing: outgoing.easing_out }, { frame: durationFrames - 1, value: sign * travel });
      blur.push({ frame: outgoing.start_frame, value: 0 }, { frame: outgoing.end_frame, value: blurAmount, easing: outgoing.easing_out }, { frame: durationFrames - 1, value: blurAmount });
    } else {
      opacity.push({ frame: durationFrames - 1, value: 1 });
      x.push({ frame: durationFrames - 1, value: 0 });
      blur.push({ frame: durationFrames - 1, value: 0 });
    }
    tracks.push(
      { target: scene.key, property: 'opacity', keyframes: frameKeyframes(opacity) },
      { target: scene.key, property: 'x', keyframes: frameKeyframes(x) },
      { target: scene.key, property: 'blur', keyframes: frameKeyframes(blur) },
    );
  });
  return tracks;
}

function transitionTracks(transitions) {
  return transitions.flatMap((transition) => {
    if (transition.kind === 'hard_cut' || transition.relation === 'explicit_hard_cut') {
      return [{
        target: `${transition.key}_overlay`, property: 'procedural_amount',
        keyframes: [{ frame: 0, value: 0 }, { frame: Math.max(1, transition.end_frame), value: 0 }],
      }];
    }
    const midpoint = Math.round((transition.start_frame + transition.end_frame) / 2);
    return [{
      target: `${transition.key}_overlay`, property: 'procedural_amount',
      keyframes: frameKeyframes([
        { frame: Math.max(0, transition.start_frame - 1), value: 0 },
        { frame: transition.start_frame, value: 0 },
        { frame: midpoint, value: 1, easing: 'ease-in-out' },
        { frame: transition.end_frame, value: 0, easing: 'ease-in-out' },
      ]),
    }];
  });
}

function visualBeats(scenes, transitions, durationFrames, fps = 30) {
  return scenes.map((scene, index) => ({
    key: `beat_${scene.key}`,
    scene_key: scene.key,
    subject_keys: scene.subject_keys,
    source_caption_keys: scene.source_caption_keys,
    start_frame: index === 0 ? 0 : transitions[index - 1].start_frame,
    peak_frame: index === 0
      ? Math.max(1, Math.round((transitions[0]?.start_frame || durationFrames - 1) * 0.7))
      : Math.round(((transitions[index - 1]?.end_frame || 0) + (transitions[index]?.start_frame || durationFrames - 1)) / 2),
    end_frame: transitions[index]?.end_frame || durationFrames - 1,
    minimum_hold_frames: Math.max(1, Math.round(fps * 0.3)),
    motion_verb: index === 0 ? 'establish_and_resolve' : 'enter_and_continue',
  }));
}

function cloneEnvironmentFamily(baseFamily, scene, index) {
  const family = clone(baseFamily);
  family.family_key = scene.environment_family_key;
  family.contract = {
    ...(family.contract || {}), scene_key: scene.key, description: scene.description,
    placement_regions: clone(scene.placement_regions || family.contract?.placement_regions || []),
  };
  family.slots = (family.slots || []).map((slot) => ({
    ...slot,
    constraints: {
      ...(slot.constraints || {}),
      label: slot.constraints?.label || `${scene.label} · 环境底图`,
      environment_description: scene.description,
      scene_key: scene.key,
      ...(index > 0
        ? { allow_source_import: false, source_storyboard_reference: false, use_storyboard_composition_reference: false, reference_role: 'style_only' }
        : { use_storyboard_composition_reference: true, reference_role: 'composition_and_style' }),
    },
  }));
  return family;
}

function mapNodeKeys(root, suffix) {
  const mapping = new Map();
  const collect = (node) => {
    mapping.set(node.key, `${node.key}__${suffix}`);
    (node.children || []).forEach(collect);
  };
  collect(root);
  const rewrite = (node) => {
    node.key = mapping.get(node.key);
    for (const field of ['object', 'subject_key', 'support_key', 'target_node_key']) {
      if (node.relation?.[field] && mapping.has(node.relation[field])) node.relation[field] = mapping.get(node.relation[field]);
    }
    (node.children || []).forEach(rewrite);
  };
  const result = clone(root);
  rewrite(result);
  return { node: result, mapping };
}

function collectIdentityMapping(node, mapping) {
  mapping.set(node.key, node.key);
  (node.children || []).forEach((child) => collectIdentityMapping(child, mapping));
}

function rewriteSceneReferences(node, mapping) {
  for (const field of ['object', 'subject_key', 'support_key', 'target_node_key']) {
    if (node.relation?.[field] && mapping.has(node.relation[field])) node.relation[field] = mapping.get(node.relation[field]);
  }
  if (Array.isArray(node.relation?.occludes)) {
    node.relation.occludes = node.relation.occludes.map((key) => mapping.get(key) || key);
  }
  (node.children || []).forEach((child) => rewriteSceneReferences(child, mapping));
}

function rewriteFamily(node, familyKey) {
  if (node.relation?.family_key) node.relation.family_key = familyKey;
  (node.children || []).forEach((child) => rewriteFamily(child, familyKey));
}

function tagScene(node, sceneKey) {
  node.relation = { ...(node.relation || {}), scene_key: sceneKey };
  (node.children || []).forEach((child) => tagScene(child, sceneKey));
}

function entitySceneIndexes(node, blueprint, scenes) {
  if (node.relation?.scene_key) {
    const explicit = scenes.findIndex((scene) => scene.key === node.relation.scene_key);
    if (explicit >= 0) return [explicit];
  }
  const entity = (blueprint.entities || []).find((item) => item.key === node.key);
  if (entity?.attributes?.scene_key) {
    const explicit = scenes.findIndex((scene) => scene.key === entity.attributes.scene_key);
    if (explicit >= 0) return [explicit];
  }
  const explicitScenes = scenes.map((scene, index) => scene.subject_keys.includes(node.key) ? index : -1).filter((index) => index >= 0);
  if (explicitScenes.length) return explicitScenes;
  if (entity?.name) {
    const mentioned = scenes.map((scene, index) => String(scene.description || '').includes(entity.name) ? index : -1).filter((index) => index >= 0);
    if (mentioned.length) return mentioned;
  }
  return scenes.map((_, index) => index);
}

function cloneTracksForMapping(plan, mapping) {
  for (const field of ['subject_tracks', 'camera_tracks']) {
    const additions = [];
    for (const track of plan.motionPlan[field] || []) {
      if (mapping.has(track.target)) additions.push({ ...clone(track), target: mapping.get(track.target) });
    }
    plan.motionPlan[field] = [...(plan.motionPlan[field] || []), ...additions];
  }
}

function transitionProofTargets(transitions, durationFrames) {
  return transitions.flatMap((transition) => {
    const midpoint = Math.round((transition.start_frame + transition.end_frame) / 2);
    const pre = Math.max(0, transition.start_frame - 1);
    const post = Math.min(durationFrames - 1, transition.end_frame + 1);
    const crop = { x: 0, y: 0, width: 1, height: 1 };
    if (transition.kind === 'hard_cut' || transition.relation === 'explicit_hard_cut') {
      return [
        { key: `${transition.key}_pre`, frame: pre, target_node_key: transition.from_scene_key, transition_key: transition.key, transition_phase: 'pre', crop, assertions: [{ type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', max: 0.05 }] },
        { key: `${transition.key}_start`, frame: transition.start_frame, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'start', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
        { key: `${transition.key}_mid`, frame: midpoint, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'mid', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
        { key: `${transition.key}_end`, frame: transition.end_frame, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'end', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
        { key: `${transition.key}_post`, frame: post, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'post', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
      ];
    }
    return [
      { key: `${transition.key}_pre`, frame: pre, target_node_key: transition.from_scene_key, transition_key: transition.key, transition_phase: 'pre', crop, assertions: [{ type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', max: 0.05 }] },
      { key: `${transition.key}_start`, frame: transition.start_frame, target_node_key: transition.from_scene_key, transition_key: transition.key, transition_phase: 'start', crop, assertions: [{ type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', max: 0.05 }] },
      { key: `${transition.key}_mid`, frame: midpoint, target_node_key: `${transition.key}_overlay`, transition_key: transition.key, transition_phase: 'mid', crop, assertions: [{ type: 'track_value_at_frame', target: `${transition.key}_overlay`, property: 'procedural_amount', min: 0.8 }] },
      { key: `${transition.key}_end`, frame: transition.end_frame, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'end', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
      { key: `${transition.key}_post`, frame: post, target_node_key: transition.to_scene_key, transition_key: transition.key, transition_phase: 'post', crop, assertions: [{ type: 'track_value_at_frame', target: transition.to_scene_key, property: 'opacity', min: 0.9 }, { type: 'track_value_at_frame', target: transition.from_scene_key, property: 'opacity', max: 0.05 }] },
    ];
  });
}

function wrapMultiScenePlan(plan, blueprint, scenes, transitions) {
  if (scenes.length < 2 || !transitions.length) return plan;
  const environmentIndex = (plan.root.children || []).findIndex((node) => node.kind === 'registered-environment');
  const baseFamilyIndex = (plan.families || []).findIndex((family) => family.pattern === 'registered-environment' && (family.slots || []).some((slot) => slot.asset_type === 'environment'));
  if (environmentIndex < 0 || baseFamilyIndex < 0) return plan;
  const baseEnvironmentNode = plan.root.children[environmentIndex];
  const baseFamily = plan.families[baseFamilyIndex];
  const contentNodes = plan.root.children.filter((_, index) => index !== environmentIndex);
  const groups = scenes.map((scene, sceneIndex) => {
    let environmentNode;
    if (sceneIndex === 0) {
      environmentNode = clone(baseEnvironmentNode);
      rewriteFamily(environmentNode, scene.environment_family_key);
      plan.families[baseFamilyIndex] = cloneEnvironmentFamily(baseFamily, scene, sceneIndex);
    } else {
      const clonedEnvironment = mapNodeKeys(baseEnvironmentNode, scene.key);
      environmentNode = clonedEnvironment.node;
      rewriteFamily(environmentNode, scene.environment_family_key);
      if (!plan.families.some((family) => family.family_key === scene.environment_family_key)) {
        plan.families.push(cloneEnvironmentFamily(baseFamily, scene, sceneIndex));
      }
    }
    const sceneContent = [];
    const sceneMapping = new Map();
    contentNodes.forEach((node) => {
      const indexes = entitySceneIndexes(node, blueprint, scenes);
      if (!indexes.includes(sceneIndex)) return;
      if (indexes[0] === sceneIndex) {
        const copied = clone(node);
        sceneContent.push(copied);
        collectIdentityMapping(node, sceneMapping);
      } else {
        const cloned = mapNodeKeys(node, scene.key);
        sceneContent.push(cloned.node);
        for (const [source, target] of cloned.mapping.entries()) sceneMapping.set(source, target);
        cloneTracksForMapping(plan, cloned.mapping);
      }
    });
    sceneContent.forEach((node) => rewriteSceneReferences(node, sceneMapping));
    tagScene(environmentNode, scene.key);
    sceneContent.forEach((node) => tagScene(node, scene.key));
    return {
      key: scene.key, kind: 'group', pattern: 'free', slot: null, asset_version_id: null,
      transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
      relation: { scene_key: scene.key, scene_role: 'visual_scene', environment_family_key: scene.environment_family_key },
      clip: { overflow: 'hidden' }, local_z: sceneIndex * 10,
      children: [environmentNode, ...sceneContent],
    };
  });
  const overlays = transitions.map((transition, index) => ({
    key: `${transition.key}_overlay`, kind: 'procedural', pattern: 'free', slot: null, asset_version_id: null,
    transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 },
    relation: { procedural_kind: 'scene-transition-dust', transition_key: transition.key, transition_kind: transition.kind, direction: transition.direction },
    clip: { overflow: 'hidden' }, local_z: 80 + index, children: [],
  }));
  plan.root.children = [...groups, ...overlays];
  plan.motionPlan.scene_tracks = sceneTracks(scenes, transitions, plan.motionPlan.duration_frames);
  plan.motionPlan.transition_tracks = transitionTracks(transitions);
  return plan;
}

function annotateSingleScenePlan(plan, scene) {
  const familyIndex = (plan.families || []).findIndex((family) => family.pattern === 'registered-environment' && (family.slots || []).some((slot) => slot.asset_type === 'environment'));
  if (familyIndex >= 0) {
    const base = plan.families[familyIndex];
    plan.families[familyIndex] = cloneEnvironmentFamily(base, scene, 0);
    const visit = (node) => {
      if (node.kind === 'registered-environment') rewriteFamily(node, scene.environment_family_key);
      else (node.children || []).forEach(visit);
    };
    visit(plan.root);
  }
  tagScene(plan.root, scene.key);
}

function applySceneContinuity(plan, blueprint, context = {}) {
  const storyboard = context.storyboard || {};
  const fps = Number(plan.motionPlan?.fps || 30);
  const durationFrames = Math.max(2, Number(plan.motionPlan?.duration_frames || 2));
  const captions = Array.isArray(storyboard.audio_captions) ? storyboard.audio_captions : [];
  const scenes = normalizeVisualScenes(blueprint, storyboard);
  const transitions = buildTransitionContracts(scenes, blueprint, plan, captions, fps, durationFrames);
  if (plan.timingAlignment?.cart && transitions[0]) {
    transitions[0].confidence = Math.min(Number(transitions[0].confidence || 1), Number(plan.timingAlignment.cart.confidence || 0));
  }
  const beats = Array.isArray(plan.visualBeats) && plan.visualBeats.length
    ? clone(plan.visualBeats)
    : visualBeats(scenes, transitions, durationFrames, fps);
  plan.visualScenes = scenes;
  plan.transitionContracts = transitions;
  plan.visualBeats = beats;
  plan.motionPlan = {
    ...plan.motionPlan,
    schema_version: 2,
    visual_beats: beats,
    transition_contracts: transitions,
    scene_tracks: plan.motionPlan.scene_tracks || [],
    transition_tracks: plan.motionPlan.transition_tracks || [],
    motion_profile: plan.motionPlan.motion_profile || (transitions.some((item) => item.kind === 'hard_cut' || item.relation === 'explicit_hard_cut') ? 'hard_cut' : 'normal'),
    exceptions: plan.motionPlan.exceptions || [],
  };
  plan.semanticContract = {
    ...plan.semanticContract,
    schema_version: 4,
    visual_scenes: scenes,
    visual_beats: beats,
    transition_contracts: transitions,
  };
  if (scenes.length === 1) annotateSingleScenePlan(plan, scenes[0]);
  else wrapMultiScenePlan(plan, blueprint, scenes, transitions);
  plan.proofTargets = [
    ...(plan.proofTargets || []),
    ...transitionProofTargets(transitions, durationFrames),
  ];
  plan.summary = {
    ...(plan.summary || {}),
    visual_scenes: scenes,
    visual_beats: beats,
    transition_contracts: transitions,
    scene_continuity: {
      scene_count: scenes.length,
      transition_count: transitions.length,
      location_change_count: transitions.filter((item) => item.relation === 'location_change').length,
      requires_multiple_environments: transitions.some((item) => item.requires_new_plate),
      timing_alignment: clone(plan.timingAlignment || null),
    },
    source_family_count: plan.families.length,
    required_asset_count: plan.families.flatMap((family) => family.slots || []).filter((slot) => slot.required_for_gate !== false).length,
    proof_targets: plan.proofTargets,
  };
  return plan;
}

function withBlueprintSceneContracts(blueprint, plan) {
  return {
    ...blueprint,
    visual_scenes: clone(plan.visualScenes || []),
    transition_contracts: clone(plan.transitionContracts || []),
  };
}

module.exports = {
  SCENE_CHANGE_PATTERN,
  LOCATION_WORDS,
  DEFAULT_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  sceneSegments,
  inferVisualScenes,
  orderedCaptionMatch,
  normalizeVisualScenes,
  buildTransitionContracts,
  sceneTracks,
  transitionTracks,
  visualBeats,
  transitionProofTargets,
  inferredRelation,
  applySceneContinuity,
  withBlueprintSceneContracts,
};
