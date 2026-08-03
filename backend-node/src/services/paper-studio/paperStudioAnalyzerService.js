const schemaService = require('./paperStudioSchemaService');
const runService = require('./paperStudioRunService');
const blueprintCompiler = require('./paperBlueprintCompilerService');
const blueprintService = require('./paperBlueprintService');
const capabilityPlanner = require('./paperStudioTemplateCatalog');
const relationPrimitiveService = require('./paperRelationPrimitiveService');
const continuityService = require('./paperContinuityService');
const sourceService = require('./paperStudioSourceService');
const eventService = require('./paperStudioEventService');
const storyboardAudioService = require('./paperStoryboardAudioService');
const reuseFingerprintService = require('./paperAssetReuseFingerprintService');
const { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion } = require('./paperStudioPlannerVersion');
const {
  PaperStudioError,
  assertExpectedVersion,
  canonicalJson,
  nowIso,
  sha256,
} = require('./paperStudioUtils');

const SUPPORTED_BOUNDARY_TRANSITION_PATTERN = /(?:沉没|下沉|没入|沉入|浸没|坠入|跌入|塌入|陷入|倾覆)|(?:越过|穿过|跨过|进入).{0,12}(?:边界|表面|界面|门框|洞口|窗口|幕帘)|(?:破损|开裂|穿孔|倾斜|失稳).{0,40}(?:沉没|下沉|没入|沉入|坠入|跌入|塌入|陷入|倾覆|越界)/i;

function frameAt(durationFrames, ratio) {
  return Math.max(0, Math.min(durationFrames - 1, Math.round((durationFrames - 1) * ratio)));
}

function storyboardContext(db, shot, config = {}) {
  const context = sourceService.context(db, shot);
  if (context.source_kind !== 'paper') return context;
  return storyboardAudioService.applyTimingToContext(db, context, Number(config.fps || 30));
}

function inferredActorIdentity(context) {
  const named = (context.characters || []).map((character) => [character.name, character.appearance, character.description].filter(Boolean).join('；')).filter(Boolean);
  if (named.length) return named.join('、');
  const text = [context.storyboard.title, context.storyboard.description, context.storyboard.action].filter(Boolean).join(' ');
  const match = text.match(/(士卒|士兵|将士|操作员|参与者|众人|百姓|随从|侍卫|角色群组)/);
  return match?.[1] || '参与当前动作的角色群组';
}

function inferredActorGroupSize(context) {
  const explicitCount = Array.isArray(context.characters) ? context.characters.length : 0;
  if (explicitCount > 1) return [explicitCount, explicitCount];
  const text = [context.storyboard.title, context.storyboard.description, context.storyboard.action, context.storyboard.result]
    .filter(Boolean)
    .join(' ');
  const numeral = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const exact = text.match(/([2-6二两三四五六])(?:名|位|个)?(?:士卒|士兵|将士|操作员|参与者|角色)/);
  if (exact) {
    const count = numeral[exact[1]];
    return [count, count];
  }
  if (/(?:士卒|士兵|将士|操作员|参与者|众人|多人|一行人|队伍).{0,12}(?:合力|共同|一起|成群)|(?:合力|共同|一起|成群).{0,12}(?:士卒|士兵|将士|操作员|参与者|众人|多人|一行人|队伍)/i.test(text)) {
    return [2, 4];
  }
  return [Math.max(1, explicitCount), Math.max(1, explicitCount)];
}

function supportedBoundaryTransitionPlan(context, config = {}) {
  const { storyboard, scene, props = [], characters = [] } = context;
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 4, Math.round(Number(storyboard.duration || 6) * fps));
  const engageFrame = frameAt(durationFrames, 0.24);
  const contactFrame = frameAt(durationFrames, 0.42);
  const peakFrame = frameAt(durationFrames, 0.63);
  const finalFrame = durationFrames - 1;
  const supportProp = props[0] || null;
  const sourceText = [storyboard.title, storyboard.description, storyboard.action, storyboard.result, storyboard.location].filter(Boolean).join(' ');
  const liquidBoundary = /(水|河|湖|海|浪|潮|溪|池|沼)/i.test(sourceText);
  const boundaryDescription = liquidBoundary ? '镜头中的液体表面边界' : '镜头中的前景空间边界';
  const transitionDescription = liquidBoundary ? '主体穿越边界时的液体扰动效果' : '主体穿越边界时的局部过渡效果';
  const supportIdentity = [supportProp?.name, supportProp?.description].filter(Boolean).join('；') || storyboard.title || '承载角色的支撑主体';
  const actorGroupSize = inferredActorGroupSize(context);
  const actorIdentityBase = inferredActorIdentity(context);
  const actorIdentity = actorGroupSize[1] > 1
    ? `${actorIdentityBase}群组（${actorGroupSize[0]}-${actorGroupSize[1]}人）`
    : actorIdentityBase;

  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: {
      description: scene?.prompt || storyboard.location || storyboard.description || '镜头干净背景',
      clean_plate_required: true,
      registered_boundaries: ['primary_boundary'],
    },
    subjects: [
      { key: 'support_subject', kind: 'prop', identity: supportIdentity, support_key: null, required_states: ['stable', 'transitioning', 'settled'] },
      { key: 'actors', kind: 'character', identity: actorIdentity, support_key: 'support_subject', required_states: ['engage', 'destabilize', 'separate'] },
      { key: 'transition_effect', kind: 'effect', identity: transitionDescription, support_key: 'support_subject', required_states: ['hidden', 'peak', 'settle'] },
    ],
    action_beats: [
      { key: 'actor_engagement', start_frame: 0, peak_frame: engageFrame, end_frame: contactFrame, subject_key: 'actors', action: 'engage' },
      { key: 'boundary_contact', start_frame: engageFrame, peak_frame: contactFrame, end_frame: peakFrame, subject_key: 'support_subject', action: 'contact_boundary' },
      { key: 'boundary_transition', start_frame: contactFrame, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'support_subject', action: 'cross_boundary' },
      { key: 'foreground_occlusion', start_frame: contactFrame, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'transition_effect', action: 'increase_occlusion' },
    ],
  };

  const families = [
    {
      family_key: 'registered_environment',
      pattern: 'registered-environment',
      registration_canvas: { width: 1920, height: 1080 },
      slots: [
        {
          slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true,
          constraints: { no_primary_subjects: true, same_canvas: true, aspect_ratio: '16:9', source_scene_id: scene?.id || null },
        },
        {
          slot_key: 'boundary_front_mask', asset_type: 'occlusion-mask', generation_purpose: 'registered_boundary_front_occlusion', required_for_gate: true,
          constraints: { boundary: 'primary_boundary', boundary_description: boundaryDescription, boundary_y: 0.53, fill_direction: 'below', min_final_occlusion_ratio: 0.5, derivation: 'registered_procedural_mask' },
        },
      ],
      contract: { boundaries: ['primary_boundary'], boundary_description: boundaryDescription, origin: [0, 0] },
    },
    {
      family_key: 'supported_subject_family',
      pattern: 'supported-subject',
      registration_canvas: { width: 1920, height: 1080 },
      slots: [
        {
          slot_key: 'support_body', asset_type: 'prop-cutout', generation_purpose: 'supported_subject_body', required_for_gate: true,
          constraints: { transparent_background: true, single_subject: true, allow_source_import: false, subject_key: 'support_subject', ...(supportProp?.id ? { source_prop_id: Number(supportProp.id) } : {}) },
        },
        ...['engage', 'destabilize', 'separate'].map((state) => ({
          slot_key: `actor_${state}`, asset_type: 'character-cutout', generation_purpose: `actor_state_${state}`, required_for_gate: true,
          constraints: { transparent_background: true, subject_key: 'actors', state, support: 'support_body', group_size: actorGroupSize },
        })),
        {
          slot_key: 'support_front_occluder', asset_type: 'occluder-cutout', generation_purpose: 'support_front_occlusion', required_for_gate: true,
          constraints: { transparent_background: true, derivation: 'registered_alpha_band', source_slot: 'support_body', registered_to: 'support_body', semantic_part: 'support_front', band: [0.45, 0.72] },
        },
      ],
      contract: { support_slot: 'support_body', subject_slots: ['actor_engage', 'actor_destabilize', 'actor_separate'], front_slot: 'support_front_occluder', contact_zone: 'support_contact_zone' },
    },
    {
      family_key: 'transition_effect_family',
      pattern: 'free',
      registration_canvas: null,
      slots: [{
        slot_key: 'transition_effect_alpha', asset_type: 'effect-cutout', generation_purpose: 'transition_effect', required_for_gate: false,
        constraints: { transparent_background: true, subject_key: 'transition_effect', appearance: liquidBoundary ? 'liquid' : 'particles', seamless: true, fallback: 'procedural' },
      }],
      contract: { event_cue: 'transition_peak', persistent_contact: false },
    },
  ];

  const root = {
    key: 'root', kind: 'group', pattern: 'free', slot: null, asset_version_id: null,
    transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, relation: {}, clip: {}, local_z: 0,
    children: [
      {
        key: 'registered_environment', kind: 'registered-environment', pattern: 'registered-environment', slot: null, asset_version_id: null,
        transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'registered_environment', boundary: 'primary_boundary' }, clip: {}, local_z: 0,
        children: [
          { key: 'clean_plate', kind: 'asset', pattern: 'registered-environment', slot: 'clean_plate', asset_version_id: null, transform: { x: 0.5, y: 0.5, width: 1, height: 1, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'registered_environment' }, clip: {}, local_z: 0, children: [] },
          { key: 'boundary_back', kind: 'procedural', pattern: 'registered-environment', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.72, width: 1, height: 0.56, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'boundary-back', appearance: liquidBoundary ? 'liquid' : 'neutral', family_key: 'registered_environment' }, clip: { boundary: 'primary_boundary' }, local_z: 5, children: [] },
        ],
      },
      {
        key: 'supported_group', kind: 'supported-subject', pattern: 'supported-subject', slot: null, asset_version_id: null,
        transform: { x: 0.51, y: 0.66, width: 0.62, height: 0.52, anchor_x: 0.5, anchor_y: 0.72 }, relation: { family_key: 'supported_subject_family', support: 'support_body', contact_zone: 'support_contact_zone' }, clip: {}, local_z: 20,
        children: [
          { key: 'support_body', kind: 'asset', pattern: 'supported-subject', slot: 'support_body', asset_version_id: null, transform: { x: 0.5, y: 0.58, width: 1, height: 0.58, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'supported_subject_family', role: 'rear-support' }, clip: {}, local_z: 0, children: [] },
          { key: 'actors', kind: 'asset', pattern: 'supported-subject', slot: 'actor_engage', asset_version_id: null, transform: { x: 0.49, y: 0.34, width: 0.72, height: 0.7, anchor_x: 0.5, anchor_y: 0.82 }, relation: { family_key: 'supported_subject_family', role: 'subject', state_slots: { engage: 'actor_engage', destabilize: 'actor_destabilize', separate: 'actor_separate' } }, clip: {}, local_z: 5, children: [] },
          { key: 'support_front_occluder', kind: 'asset', pattern: 'supported-subject', slot: 'support_front_occluder', asset_version_id: null, transform: { x: 0.5, y: 0.6, width: 1, height: 0.58, anchor_x: 0.5, anchor_y: 0.5 }, relation: { family_key: 'supported_subject_family', role: 'front-occluder' }, clip: {}, local_z: 10, children: [] },
        ],
      },
      { key: 'transition_effect', kind: 'procedural', pattern: 'free', slot: 'transition_effect_alpha', asset_version_id: null, transform: { x: 0.62, y: 0.66, width: 0.32, height: 0.34, anchor_x: 0.5, anchor_y: 0.7 }, relation: { procedural_kind: 'transition-effect', appearance: liquidBoundary ? 'liquid' : 'particles', family_key: 'transition_effect_family' }, clip: {}, local_z: 30, children: [] },
      { key: 'boundary_front', kind: 'procedural', pattern: 'registered-environment', slot: 'boundary_front_mask', asset_version_id: null, transform: { x: 0.5, y: 0.83, width: 1, height: 0.42, anchor_x: 0.5, anchor_y: 0.5 }, relation: { procedural_kind: 'boundary-front', appearance: liquidBoundary ? 'liquid' : 'neutral', family_key: 'registered_environment', role: 'front-occluder', occludes: ['supported_group', 'actors'] }, clip: { boundary: 'primary_boundary' }, local_z: 40, children: [] },
    ],
  };

  const motionPlan = {
    schema_version: 1,
    fps,
    duration_frames: durationFrames,
    primary_action: 'supported_boundary_transition',
    camera_only: false,
    subject_tracks: [
      { target: 'supported_group', property: 'y', keyframes: [{ frame: 0, value: 0 }, { frame: contactFrame, value: 0.02, easing: 'ease-in-out' }, { frame: finalFrame, value: 0.24, easing: 'ease-in' }] },
      { target: 'supported_group', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: contactFrame, value: -2, easing: 'ease-in-out' }, { frame: peakFrame, value: 13, easing: 'ease-out' }, { frame: finalFrame, value: 9, easing: 'ease-in-out' }] },
      { target: 'actors', property: 'state', keyframes: [{ frame: 0, value: 'engage' }, { frame: contactFrame, value: 'destabilize' }, { frame: peakFrame, value: 'separate' }, { frame: finalFrame, value: 'separate' }] },
      { target: 'actors', property: 'rotation', keyframes: [{ frame: 0, value: 0 }, { frame: contactFrame, value: -3, easing: 'ease-in-out' }, { frame: peakFrame, value: 8, easing: 'ease-out' }, { frame: finalFrame, value: 12, easing: 'ease-in' }] },
      { target: 'transition_effect', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0 }, { frame: contactFrame, value: 0 }, { frame: peakFrame, value: 1, easing: 'ease-out' }, { frame: finalFrame, value: 0.16, easing: 'ease-in' }] },
      { target: 'boundary_front', property: 'procedural_amount', keyframes: [{ frame: 0, value: 0.16 }, { frame: contactFrame, value: 0.22, easing: 'ease-in-out' }, { frame: peakFrame, value: 0.38, easing: 'ease-in' }, { frame: finalFrame, value: 0.58, easing: 'ease-in' }] },
    ],
    camera_tracks: [
      { target: 'camera', property: 'x', keyframes: [{ frame: 0, value: -0.018 }, { frame: finalFrame, value: 0.018, easing: 'ease-in-out' }] },
      { target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.035, easing: 'ease-in-out' }] },
    ],
    cues: [
      { key: 'engagement_peak', frame: engageFrame, kind: 'semantic' },
      { key: 'boundary_contact', frame: contactFrame, kind: 'contact' },
      { key: 'transition_peak', frame: peakFrame, kind: 'event' },
      { key: 'transition_final', frame: finalFrame, kind: 'semantic' },
    ],
    gate_requirements: [
      { key: 'support_rotation_delta', metric: 'numeric_range', target: 'supported_group', property: 'rotation', min: 8 },
      { key: 'support_translation_delta', metric: 'numeric_range', target: 'supported_group', property: 'y', min: 0.18 },
      { key: 'actor_state_count', metric: 'distinct_states', target: 'actors', property: 'state', min: 3 },
      { key: 'front_occlusion_final', metric: 'final_value', target: 'boundary_front', property: 'procedural_amount', min: 0.5 },
      { key: 'transition_peak_cue', metric: 'cue_exists', cue: 'transition_peak' },
    ],
  };
  const proofTargets = [
    { key: 'boundary_transition_start', frame: 0, target_node_key: 'supported_group', crop: { x: 0.16, y: 0.32, width: 0.7, height: 0.62 }, assertions: [{ type: 'subject_visible', min_alpha_coverage: 0.08 }, { type: 'state_equals', target: 'actors', value: 'engage' }] },
    { key: 'boundary_transition_peak', frame: peakFrame, target_node_key: 'supported_group', crop: { x: 0.16, y: 0.32, width: 0.7, height: 0.62 }, assertions: [{ type: 'track_range', target: 'supported_group', property: 'rotation', min: 8 }, { type: 'camera_only', expected: false }] },
    { key: 'boundary_transition_final', frame: finalFrame, target_node_key: 'supported_group', crop: { x: 0.16, y: 0.32, width: 0.7, height: 0.66 }, assertions: [{ type: 'final_track_value', target: 'boundary_front', property: 'procedural_amount', min: 0.5 }, { type: 'state_distinct_count', target: 'actors', min: 3 }, { type: 'track_range', target: 'supported_group', property: 'y', min: 0.18 }, { type: 'relation_exists', node: 'support_front_occluder', role: 'front-occluder' }] },
  ];
  const summary = {
    catalog_key: 'supported-boundary-transition-v1',
    primary_action: motionPlan.primary_action,
    camera_only: false,
    clean_plate_required: true,
    source_family_count: families.length,
    required_asset_count: families.flatMap((family) => family.slots).filter((slot) => slot.required_for_gate).length,
    actor_states: ['engage', 'destabilize', 'separate'],
    actor_group_size: actorGroupSize,
    peak_rotation_degrees: 13,
    final_front_occlusion_ratio: 0.58,
    proof_targets: proofTargets,
  };
  return { catalog_key: summary.catalog_key, semanticContract, families, root, motionPlan, proofTargets, summary };
}

function genericPlan(context, config = {}) {
  const { storyboard, scene, props, characters = [] } = context;
  if (!props?.length && !characters.length && context.source_kind !== 'paper') {
    throw new PaperStudioError(
      'PAPER_STUDIO_SEMANTIC_SUBJECT_MISSING',
      '当前分镜没有可作为独立纸片主体的角色或道具，且未匹配环境、地图或信息揭示能力',
      { storyboard_id: Number(storyboard.id), title: storyboard.title || '' },
      422,
    );
  }
  const fps = Number(config.fps || 30);
  const durationFrames = Math.max(fps * 3, Math.round(Number(storyboard.duration || 5) * fps));
  const peakFrame = frameAt(durationFrames, 0.62);
  const finalFrame = durationFrames - 1;
  const prop = props[0] || null;
  const character = characters[0] || null;
  const subjectIdentity = prop?.description || prop?.name
    || [character?.name, character?.appearance, character?.description].filter(Boolean).join('；')
    || inferredActorIdentity(context)
    || storyboard.title || '分镜主体';
  const sourceConstraint = prop?.id
    ? { source_prop_id: Number(prop.id) }
    : character?.id
      ? (character.source_table === 'character_libraries' ? { source_character_library_id: Number(character.id) } : { source_character_id: Number(character.id) })
      : {};
  const environment = scene?.prompt || storyboard.location || storyboard.description || '分镜干净背景';
  const semanticContract = {
    schema_version: 3,
    storyboard_id: Number(storyboard.id),
    environment: { description: environment, clean_plate_required: true, registered_boundaries: ['foreground'] },
    subjects: [{ key: 'primary_subject', kind: prop ? 'prop' : 'character', identity: subjectIdentity, support_key: null, required_states: ['start', 'action', 'settle'] }],
    action_beats: [{ key: 'primary_action', start_frame: 0, peak_frame: peakFrame, end_frame: finalFrame, subject_key: 'primary_subject', action: 'settle' }],
  };
  const families = [
    { family_key: 'clean_environment', pattern: 'registered-environment', registration_canvas: { width: 1920, height: 1080 }, slots: [{ slot_key: 'clean_plate', asset_type: 'environment', generation_purpose: 'clean_background', required_for_gate: true, constraints: { no_people: true, aspect_ratio: '16:9', source_scene_id: scene?.id || null } }, { slot_key: 'foreground_occluder', asset_type: 'occlusion-mask', generation_purpose: 'foreground_occlusion', required_for_gate: false, constraints: { derivation: 'registered_procedural_mask' } }], contract: { boundaries: ['foreground'], origin: [0, 0] } },
    { family_key: 'primary_subject', pattern: 'supported-subject', registration_canvas: { width: 1920, height: 1080 }, slots: [{ slot_key: 'subject_start', asset_type: 'subject-cutout', generation_purpose: 'subject_state_start', required_for_gate: true, constraints: { transparent_background: true, allow_source_import: false, subject_key: 'primary_subject', state: 'start', ...sourceConstraint } }, { slot_key: 'subject_action', asset_type: 'subject-cutout', generation_purpose: 'subject_state_action', required_for_gate: true, constraints: { transparent_background: true, allow_source_import: false, subject_key: 'primary_subject', state: 'action' } }, { slot_key: 'subject_settle', asset_type: 'subject-cutout', generation_purpose: 'subject_state_settle', required_for_gate: true, constraints: { transparent_background: true, allow_source_import: false, subject_key: 'primary_subject', state: 'settle' } }], contract: { subject_key: 'primary_subject', identity: subjectIdentity, subject_slots: ['subject_start', 'subject_action', 'subject_settle'] } },
  ];
  const root = {
    key: 'root', kind: 'group', pattern: 'free', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.5, width: 1, height: 1 }, relation: {}, clip: {}, local_z: 0,
    children: [
      { key: 'clean_environment', kind: 'registered-environment', pattern: 'registered-environment', slot: null, asset_version_id: null, transform: { x: 0.5, y: 0.5, width: 1, height: 1 }, relation: { family_key: 'clean_environment' }, clip: {}, local_z: 0, children: [{ key: 'clean_plate', kind: 'asset', pattern: 'registered-environment', slot: 'clean_plate', asset_version_id: null, transform: { x: 0.5, y: 0.5, width: 1, height: 1 }, relation: { family_key: 'clean_environment' }, clip: {}, local_z: 0, children: [] }] },
      { key: 'primary_subject', kind: 'asset', pattern: 'supported-subject', slot: 'subject_start', asset_version_id: null, transform: { x: 0.52, y: 0.62, width: 0.48, height: 0.62, anchor_x: 0.5, anchor_y: 0.8 }, relation: { family_key: 'primary_subject', state_slots: { start: 'subject_start', action: 'subject_action', settle: 'subject_settle' } }, clip: {}, local_z: 20, children: [] },
      { key: 'foreground', kind: 'procedural', pattern: 'registered-environment', slot: 'foreground_occluder', asset_version_id: null, transform: { x: 0.5, y: 0.92, width: 1, height: 0.18 }, relation: { procedural_kind: 'foreground-layer', appearance: 'paper', role: 'front-occluder' }, clip: {}, local_z: 40, children: [] },
    ],
  };
  const motionPlan = {
    schema_version: 1, fps, duration_frames: durationFrames, primary_action: 'subject_settle', camera_only: false,
    subject_tracks: [
      { target: 'primary_subject', property: 'x', keyframes: [{ frame: 0, value: -0.05 }, { frame: peakFrame, value: 0.025, easing: 'ease-out' }, { frame: finalFrame, value: 0.02, easing: 'ease-in-out' }] },
      { target: 'primary_subject', property: 'rotation', keyframes: [{ frame: 0, value: -5 }, { frame: peakFrame, value: 7, easing: 'ease-out' }, { frame: finalFrame, value: 2, easing: 'ease-in-out' }] },
      { target: 'primary_subject', property: 'state', keyframes: [{ frame: 0, value: 'start' }, { frame: peakFrame, value: 'action' }, { frame: finalFrame, value: 'settle' }] },
    ],
    camera_tracks: [{ target: 'camera', property: 'scale', keyframes: [{ frame: 0, value: 1 }, { frame: finalFrame, value: 1.02, easing: 'ease-in-out' }] }],
    cues: [{ key: 'action_peak', frame: peakFrame, kind: 'semantic' }, { key: 'settle', frame: finalFrame, kind: 'semantic' }],
  };
  const proofTargets = [
    { key: 'subject_start', frame: 0, target_node_key: 'primary_subject', crop: { x: 0.2, y: 0.2, width: 0.65, height: 0.7 }, assertions: [{ type: 'state_equals', value: 'start' }] },
    { key: 'subject_peak', frame: peakFrame, target_node_key: 'primary_subject', crop: { x: 0.2, y: 0.2, width: 0.65, height: 0.7 }, assertions: [{ type: 'rotation_delta', min: 6 }, { type: 'camera_only', expected: false }] },
    { key: 'subject_final', frame: finalFrame, target_node_key: 'primary_subject', crop: { x: 0.2, y: 0.2, width: 0.65, height: 0.7 }, assertions: [{ type: 'state_distinct_count', min: 3 }] },
  ];
  return { catalog_key: 'generic-subject-v1', semanticContract, families, root, motionPlan, proofTargets, summary: { catalog_key: 'generic-subject-v1', primary_action: 'subject_settle', camera_only: false, clean_plate_required: true, source_family_count: families.length, required_asset_count: 4, required_states: ['start', 'action', 'settle'], proof_targets: proofTargets } };
}

function finalizePlan(plan) {
  plan.summary = {
    ...(plan.summary || {}),
    planner_version: CURRENT_PLANNER_VERSION,
    semantic_primitives: relationPrimitiveService.derive(plan),
  };
  if (plan.motionPlan?.primary_action === 'environmental_depth_motion') {
    const generatedEffectSlots = plan.families
      .flatMap((family) => family.slots || [])
      .filter((slot) => slot.asset_type === 'effect-cutout');
    if (generatedEffectSlots.length) {
      throw new PaperStudioError(
        'PAPER_STUDIO_ENVIRONMENT_EFFECT_ASSET_FORBIDDEN',
        '纯环境镜头只能使用环境底图和程序化氛围，不能生成独立效果贴图',
        { slot_keys: generatedEffectSlots.map((slot) => slot.slot_key) },
        422,
      );
    }
  }
  schemaService.assertValid('semanticContract', plan.semanticContract, '镜头语义合同不符合 Schema');
  plan.families.forEach((family) => schemaService.assertValid('sourceFamily', family, `素材族 ${family.family_key} 不符合 Schema`));
  schemaService.assertValid('compositionNode', plan.root, '镜头组合树不符合 Schema');
  schemaService.assertValid('motionPlan', plan.motionPlan, '镜头动作计划不符合 Schema');
  plan.proofTargets.forEach((target) => schemaService.assertValid('proofTarget', target, `动态证明 ${target.key} 不符合 Schema`));
  return plan;
}

function buildPlan(context, config) {
  const sourceText = [context.storyboard.title, context.storyboard.description, context.storyboard.action, context.storyboard.result].filter(Boolean).join('\n');
  const normalizedContext = { characters: [], props: [], ...context };
  if (normalizedContext.source_kind === 'paper') {
    const inferredBlueprint = blueprintCompiler.infer(normalizedContext);
    const plan = finalizePlan(blueprintCompiler.compile(inferredBlueprint, normalizedContext, config));
    if (normalizedContext.audio_timing) {
      plan.summary = {
        ...plan.summary,
        authored_duration_seconds: normalizedContext.audio_timing.authored_duration_seconds,
        effective_duration_seconds: normalizedContext.audio_timing.effective_duration_seconds,
        speech_end_seconds: normalizedContext.audio_timing.speech_end_seconds,
        audio_driven_duration: Boolean(normalizedContext.audio_timing.duration_adjusted),
        audio_duration_extended: Boolean(normalizedContext.audio_timing.duration_extended),
        audio_duration_shortened: Boolean(normalizedContext.audio_timing.duration_shortened),
      };
    }
    plan.blueprint = blueprintCompiler.withGenerationSlots(inferredBlueprint, plan);
    schemaService.assertValid('paperBlueprint', plan.blueprint, '镜头生产蓝图不符合 Schema');
    return plan;
  }
  return finalizePlan(
    capabilityPlanner.buildCapabilityPlan(normalizedContext, config)
      || (SUPPORTED_BOUNDARY_TRANSITION_PATTERN.test(sourceText) ? supportedBoundaryTransitionPlan(normalizedContext, config) : null)
      || genericPlan(normalizedContext, config),
  );
}

function insertNodeTree(db, shotId, planRevisionId, node, parentNodeId, now) {
  const result = db.prepare(
    `INSERT INTO paper_composition_nodes
      (shot_id, plan_revision_id, node_key, parent_node_id, node_kind, pattern, slot, asset_version_id,
       transform_json, relation_json, clip_json, local_z, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
  ).run(
    Number(shotId), Number(planRevisionId), node.key, parentNodeId, node.kind, node.pattern || null,
    node.slot || null, node.asset_version_id || null, JSON.stringify(node.transform || {}),
    JSON.stringify(node.relation || {}), JSON.stringify(node.clip || {}),
    Number(node.local_z || 0), now, now,
  );
  const nodeId = Number(result.lastInsertRowid);
  for (const child of node.children || []) insertNodeTree(db, shotId, planRevisionId, child, nodeId, now);
}

function persistPlan(db, run, shot, plan) {
  const now = nowIso();
  const planHash = sha256(canonicalJson({ source_revision_hash: shot.source_revision_hash, plan }));
  const blueprint = plan.blueprint
    ? blueprintService.persist(db, shot, plan.blueprint, planHash, plan.blueprint_created_from || 'analysis')
    : null;
  const previousPlanRevisionId = shot.current_plan_revision_id == null
    ? db.prepare('SELECT current_plan_revision_id FROM paper_studio_shots WHERE id = ?').get(Number(shot.id))?.current_plan_revision_id
    : shot.current_plan_revision_id;
  const nextRevision = db.prepare(
    'SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM paper_plan_revisions WHERE shot_id = ?',
  ).get(Number(shot.id));
  const revisionResult = db.prepare(
    `INSERT INTO paper_plan_revisions
      (shot_id, revision_number, blueprint_revision_id, plan_hash, status,
       transition_report_json, created_from, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(
    Number(shot.id), Number(nextRevision.revision_number),
    blueprint?.id || shot.blueprint_revision_id || null, planHash,
    JSON.stringify(plan.transition_report || {}), plan.blueprint_created_from || 'analysis', now,
  );
  const planRevisionId = Number(revisionResult.lastInsertRowid);
  if (previousPlanRevisionId) {
    db.prepare(
      `UPDATE paper_plan_revisions
       SET status = 'superseded', superseded_at = ?
       WHERE id = ? AND status != 'superseded'`,
    ).run(now, Number(previousPlanRevisionId));
    const oldFamilies = db.prepare(
      'SELECT id FROM paper_source_families WHERE plan_revision_id = ?',
    ).all(Number(previousPlanRevisionId));
    if (oldFamilies.length) {
      const ids = oldFamilies.map((row) => Number(row.id));
      db.prepare(`UPDATE paper_asset_slots SET status = 'superseded', updated_at = ? WHERE family_id IN (${ids.map(() => '?').join(',')}) AND status != 'superseded'`)
        .run(now, ...ids);
    }
    db.prepare("UPDATE paper_source_families SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ? AND status != 'superseded'")
      .run(now, Number(previousPlanRevisionId));
    db.prepare("UPDATE paper_composition_nodes SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ? AND status != 'superseded'")
      .run(now, Number(previousPlanRevisionId));
    db.prepare("UPDATE paper_motion_plans SET status = 'superseded', updated_at = ? WHERE plan_revision_id = ? AND status != 'superseded'")
      .run(now, Number(previousPlanRevisionId));
    db.prepare("UPDATE paper_job_steps SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE plan_revision_id = ? AND status != 'superseded'")
      .run(now, Number(previousPlanRevisionId));
  }

  for (const family of plan.families) {
    const familyResult = db.prepare(
      `INSERT INTO paper_source_families
        (shot_id, plan_revision_id, family_key, pattern, registration_canvas_json, contract_json,
         status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)`,
    ).run(Number(shot.id), planRevisionId, family.family_key, family.pattern, JSON.stringify(family.registration_canvas || {}), JSON.stringify(family.contract || {}), now, now);
    const familyId = Number(familyResult.lastInsertRowid);
    const insertSlot = db.prepare(
      `INSERT INTO paper_asset_slots
        (family_id, slot_key, asset_type, generation_purpose, constraints_json,
         required_for_gate, reuse_fingerprint, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)`,
    );
    for (const slot of family.slots) {
      const reuseFingerprint = reuseFingerprintService.computeReuseFingerprint({
        run,
        shot,
        family: {
          ...family,
          registration_canvas_json: family.registration_canvas || {},
          contract_json: family.contract || {},
        },
        slot: { ...slot, constraints_json: slot.constraints || {} },
      });
      insertSlot.run(familyId, slot.slot_key, slot.asset_type, slot.generation_purpose, JSON.stringify(slot.constraints || {}), slot.required_for_gate === false ? 0 : 1, reuseFingerprint, now, now);
    }
  }
  insertNodeTree(db, shot.id, planRevisionId, plan.root, null, now);
  db.prepare(
    `INSERT INTO paper_motion_plans
      (shot_id, plan_revision_id, schema_version, semantic_contract_hash, timing_hash, plan_json,
       compiled_tracks_json, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
  ).run(Number(shot.id), planRevisionId, Number(plan.motionPlan.schema_version || 1), sha256(canonicalJson(plan.semanticContract)), sha256(canonicalJson({ fps: plan.motionPlan.fps, duration_frames: plan.motionPlan.duration_frames, cues: plan.motionPlan.cues })), JSON.stringify(plan.motionPlan), JSON.stringify({ subject_tracks: plan.motionPlan.subject_tracks, camera_tracks: plan.motionPlan.camera_tracks, scene_tracks: plan.motionPlan.scene_tracks || [], transition_tracks: plan.motionPlan.transition_tracks || [] }), now, now);

  const steps = [
    ['analyze_shot', [], 'completed'],
    ['plan_families', ['analyze_shot'], 'completed'],
    ['generate_layout_master', ['plan_families'], 'blocked_user_authorization'],
    ['generate_required_slots', ['generate_layout_master'], 'queued'],
    ['matte_assets', ['generate_required_slots'], 'queued'],
    ['register_assets', ['matte_assets'], 'queued'],
    ['technical_asset_gate', ['register_assets'], 'queued'],
    ['asset_gate', ['technical_asset_gate'], 'queued'],
    ['plan_motion', ['asset_gate'], 'queued'],
    ['compile_snapshot', ['plan_motion'], 'queued'],
    ['render_proof', ['compile_snapshot'], 'queued'],
    ['dynamic_gate', ['render_proof'], 'queued'],
    ['render_preview', ['dynamic_gate'], 'queued'],
    ['wait_preview_approval', ['render_preview'], 'queued'],
    ['render_formal', ['wait_preview_approval'], 'queued'],
    ['publish_video', ['render_formal'], 'queued'],
  ];
  const insertStep = db.prepare(
    `INSERT INTO paper_job_steps
      (run_id, shot_id, plan_revision_id, step_key, input_hash, depends_on_json, status, attempt,
       max_attempts, result_json, error_json, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 2, ?, '{}', ?, ?, ?, ?)`,
  );
  for (const [stepKey, dependsOn, status] of steps) {
    const completed = status === 'completed' ? now : null;
    insertStep.run(Number(run.id), Number(shot.id), planRevisionId, stepKey, sha256(canonicalJson({ plan_hash: planHash, step_key: stepKey })), JSON.stringify(dependsOn), status, status === 'completed' ? JSON.stringify({ plan_hash: planHash, catalog_key: plan.catalog_key }) : '{}', completed, completed, now, now);
  }

  db.prepare(
    `UPDATE paper_studio_shots
     SET semantic_contract_json = ?, plan_summary_json = ?, status = 'analyzed',
         current_plan_revision_id = ?,
         current_snapshot_id = NULL, approved_snapshot_id = NULL,
         last_error_json = '{}', version = version + 1, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(plan.semanticContract), JSON.stringify({ ...plan.summary, plan_hash: planHash }), planRevisionId, now, Number(shot.id));
  return planHash;
}

function selectedShots(run, body) {
  if (!body.shot_ids?.length) return run.shots;
  const wanted = new Set(body.shot_ids.map(Number));
  const selected = run.shots.filter((shot) => wanted.has(Number(shot.id)));
  if (selected.length !== wanted.size) {
    throw new PaperStudioError('PAPER_STUDIO_SHOT_OWNERSHIP_MISMATCH', '部分镜头不属于当前生产版本', { run_id: Number(run.id), shot_ids: body.shot_ids }, 409);
  }
  return selected;
}

function withTransitionRecoveryContext(error, shot, context = {}) {
  if (error.code !== 'PAPER_STUDIO_TRANSITION_GATE_FAILED') return error;
  error.details = {
    ...(error.details || {}),
    recovery_context: {
      shot_id: Number(shot.id),
      paper_storyboard_id: Number(shot.paper_storyboard_id || context.storyboard?.id || 0) || null,
      shot_number: Number(shot.shot_index || 0) + 1,
      title: context.storyboard?.title || '',
    },
  };
  return error;
}

function analyzeRun(db, log, runId, body = {}, config = {}) {
  schemaService.assertValid('apiRunAction', body, '分析生产版本的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (!['draft', 'plan_review'].includes(run.status)) {
    throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '当前状态不允许重新分析', { run_id: run.id, status: run.status }, 409);
  }
  const shots = selectedShots(run, body);
  const contexts = shots.map((shot) => ({ shot, context: storyboardContext(db, shot, config) }));
  const incomplete = contexts.map(({ shot, context }) => {
    const storyboard = context.storyboard || {};
    const missing = [];
    if (!String(storyboard.title || '').trim()) missing.push('title');
    if (!String(storyboard.description || '').trim()) missing.push('description');
    if (!Boolean(storyboard.environment_only) && !String(storyboard.action || '').trim()) missing.push('action');
    return { shot_id: Number(shot.id), missing_fields: missing, environment_only: Boolean(storyboard.environment_only) };
  }).filter((item) => item.missing_fields.length);
  if (incomplete.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STORYBOARD_INCOMPLETE',
      '空白或不完整分镜不能进入生产蓝图分析',
      { shots: incomplete },
      422,
    );
  }
  const plans = contexts.map(({ shot, context }) => {
    try {
      return { shot, plan: buildPlan(context, config) };
    } catch (error) {
      throw withTransitionRecoveryContext(error, shot, context);
    }
  });
  const analyze = db.transaction(() => {
    const now = nowIso();
    db.prepare("UPDATE paper_studio_runs SET status = 'analyzing', progress = 2, version = version + 1, updated_at = ? WHERE id = ?").run(now, Number(run.id));
    const results = plans.map(({ shot, plan }) => ({ shot_id: Number(shot.id), catalog_key: plan.catalog_key, plan_hash: persistPlan(db, run, shot, plan) }));
    const continuity = continuityService.rebuildForRun(db, run.id);
    db.prepare("UPDATE paper_studio_runs SET status = 'plan_review', progress = 10, updated_at = ? WHERE id = ?").run(nowIso(), Number(run.id));
    return { results, continuity };
  });
  const outcome = analyze();
  if (log) log.info('Paper studio run analyzed', { run_id: Number(run.id), shot_count: outcome.results.length, catalogs: outcome.results.map((item) => item.catalog_key), continuity_contracts: outcome.continuity.contract_count });
  return { run: runService.get(db, run.id), analyzed: outcome.results, continuity: outcome.continuity };
}

function confirmPlan(db, log, runId, body = {}) {
  schemaService.assertValid('apiRunAction', body, '确认生产计划的参数无效');
  const run = runService.get(db, runId);
  assertExpectedVersion(run.version, body.expected_version, '纸片动画生产版本');
  if (run.status !== 'plan_review') {
    throw new PaperStudioError('PAPER_STUDIO_RUN_STATE_CONFLICT', '当前状态没有可确认的计划', { run_id: run.id, status: run.status }, 409);
  }
  const shots = selectedShots(run, body);
  const invalid = shots.filter((shot) => shot.status !== 'analyzed');
  if (invalid.length) {
    throw new PaperStudioError('PAPER_STUDIO_PLAN_NOT_READY', '部分镜头尚未完成分析', { shot_ids: invalid.map((shot) => shot.id) }, 409);
  }
  const stale = shots.filter((shot) => !isCurrentPlannerVersion(shot.plan_summary_json));
  if (stale.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_PLAN_VERSION_STALE',
      '生产计划版本已经更新，请重新分析后再确认',
      {
        expected_planner_version: CURRENT_PLANNER_VERSION,
        shots: stale.map((shot) => ({
          shot_id: Number(shot.id),
          actual_planner_version: Number(shot.plan_summary_json?.planner_version || 0),
        })),
      },
      409,
    );
  }
  const confirm = db.transaction(() => {
    const now = nowIso();
    const updateShot = db.prepare("UPDATE paper_studio_shots SET status = 'plan_confirmed', version = version + 1, updated_at = ? WHERE id = ?");
    for (const shot of shots) {
      updateShot.run(now, Number(shot.id));
      if (shot.blueprint_revision_id) blueprintService.confirm(db, shot.id);
      db.prepare("UPDATE paper_plan_revisions SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'draft'")
        .run(now, Number(shot.current_plan_revision_id));
      db.prepare("UPDATE paper_source_families SET status = 'confirmed', version = version + 1, updated_at = ? WHERE plan_revision_id = ?").run(now, Number(shot.current_plan_revision_id));
      db.prepare("UPDATE paper_composition_nodes SET status = 'confirmed', version = version + 1, updated_at = ? WHERE plan_revision_id = ?").run(now, Number(shot.current_plan_revision_id));
      db.prepare("UPDATE paper_motion_plans SET status = 'confirmed', version = version + 1, updated_at = ? WHERE plan_revision_id = ?").run(now, Number(shot.current_plan_revision_id));
    }
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM paper_studio_shots WHERE run_id = ? AND deleted_at IS NULL AND status != 'plan_confirmed'").get(Number(run.id));
    const allConfirmed = Number(remaining.count) === 0;
    const status = allConfirmed ? 'awaiting_generation_authorization' : 'plan_review';
    db.prepare("UPDATE paper_job_steps SET status = 'blocked_user_authorization', blocked_reason = 'user_authorization_required', user_visible_status = 'waiting_for_authorization', authorization_id = NULL, updated_at = ? WHERE run_id = ? AND shot_id IN (" + shots.map(() => '?').join(',') + ") AND plan_revision_id IN (" + shots.map(() => '?').join(',') + ") AND step_key = 'generate_layout_master'")
      .run(now, Number(run.id), ...shots.map((shot) => Number(shot.id)), ...shots.map((shot) => Number(shot.current_plan_revision_id)));
    db.prepare("UPDATE paper_studio_shots SET attention_required = 'authorize_generation' WHERE id IN (" + shots.map(() => '?').join(',') + ")")
      .run(...shots.map((shot) => Number(shot.id)));
    db.prepare('UPDATE paper_studio_runs SET status = ?, progress = ?, attention_required = ?, active_authorization_id = NULL, version = version + 1, updated_at = ? WHERE id = ?')
      .run(status, allConfirmed ? 15 : 10, allConfirmed ? 'authorize_generation' : 'review_blueprint', now, Number(run.id));
  });
  confirm();
  eventService.record(db, {
    runId: run.id,
    eventType: 'blueprint_confirmed',
    title: '生产蓝图已确认',
    message: '尚未调用图片 API；请查看模型、数量和费用后单独授权生成',
    recoveryActions: ['review_generation_quote', 'edit_blueprint'],
    details: { shot_ids: shots.map((shot) => Number(shot.id)) },
  });
  if (log) log.info('Paper studio plan confirmed', { run_id: Number(run.id), shot_ids: shots.map((shot) => Number(shot.id)) });
  return { run: runService.get(db, run.id), confirmed_shot_ids: shots.map((shot) => Number(shot.id)) };
}

function getBlueprint(db, shotId) {
  return blueprintService.getForShot(db, shotId);
}

function updateBlueprint(db, log, shotId, body = {}, config = {}) {
  schemaService.assertValid('apiBlueprintUpdate', body, '更新生产蓝图的参数无效');
  const shotRow = db.prepare('SELECT run_id FROM paper_studio_shots WHERE id = ? AND deleted_at IS NULL').get(Number(shotId));
  if (!shotRow) throw new PaperStudioError('PAPER_STUDIO_SHOT_NOT_FOUND', '纸片工作室分镜不存在', { shot_id: Number(shotId) }, 404);
  const run = runService.get(db, shotRow.run_id);
  const shot = run.shots.find((item) => Number(item.id) === Number(shotId));
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  if (!['plan_review', 'awaiting_generation_authorization'].includes(run.status) || !['analyzed', 'plan_confirmed'].includes(shot.status)) {
    throw new PaperStudioError(
      'PAPER_STUDIO_BLUEPRINT_STATE_CONFLICT',
      '只有待确认或等待生成授权的蓝图可以直接编辑；已开始生成时请从脚本创建新生产版本',
      { run_id: run.id, run_status: run.status, shot_id: shot.id, shot_status: shot.status },
      409,
    );
  }
  const context = storyboardContext(db, shot);
  let plan;
  try {
    plan = finalizePlan(blueprintCompiler.compile(body.blueprint, context, config));
  } catch (error) {
    throw withTransitionRecoveryContext(error, shot, context);
  }
  plan.blueprint = blueprintCompiler.withGenerationSlots(body.blueprint, plan);
  plan.blueprint_created_from = 'user_edit';
  schemaService.assertValid('paperBlueprint', plan.blueprint, '更新后的生产蓝图不符合 Schema');
  const transaction = db.transaction(() => {
    const now = nowIso();
    db.prepare(
      `UPDATE paper_generation_authorizations
       SET status = 'expired', version = version + 1, updated_at = ?
       WHERE run_id = ? AND status IN ('authorized','executing')`,
    ).run(now, Number(run.id));
    persistPlan(db, run, shot, plan);
    db.prepare(
      `UPDATE paper_studio_runs
       SET status = 'plan_review', progress = 10, attention_required = 'review_blueprint',
           active_authorization_id = NULL, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(now, Number(run.id));
  });
  transaction();
  eventService.record(db, {
    runId: run.id,
    shotId: shot.id,
    eventType: 'blueprint_revised',
    title: '生产蓝图已更新',
    message: '实体、图层和动作合同已重新编译；旧生成授权已失效',
    recoveryActions: ['review_blueprint', 'confirm_blueprint'],
    details: { request_id: body.request_id },
  });
  if (log) log.info('Paper studio blueprint updated', { run_id: run.id, shot_id: shot.id });
  return { run: runService.get(db, run.id), blueprint: blueprintService.getForShot(db, shot.id) };
}

function confirmBlueprint(db, log, shotId, body = {}) {
  schemaService.assertValid('apiShotAction', body, '确认生产蓝图的参数无效');
  const shotRow = db.prepare('SELECT run_id FROM paper_studio_shots WHERE id = ? AND deleted_at IS NULL').get(Number(shotId));
  if (!shotRow) throw new PaperStudioError('PAPER_STUDIO_SHOT_NOT_FOUND', '纸片工作室分镜不存在', { shot_id: Number(shotId) }, 404);
  const run = runService.get(db, shotRow.run_id);
  const shot = run.shots.find((item) => Number(item.id) === Number(shotId));
  assertExpectedVersion(shot.version, body.expected_version, '纸片动画镜头');
  return confirmPlan(db, log, run.id, {
    request_id: body.request_id,
    expected_version: run.version,
    shot_ids: [Number(shot.id)],
  });
}

module.exports = {
  SUPPORTED_BOUNDARY_TRANSITION_PATTERN,
  storyboardContext,
  buildPlan,
  supportedBoundaryTransitionPlan,
  genericPlan,
  withTransitionRecoveryContext,
  analyzeRun,
  confirmPlan,
  getBlueprint,
  updateBlueprint,
  confirmBlueprint,
};
