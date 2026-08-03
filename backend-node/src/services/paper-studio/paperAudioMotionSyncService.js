const storyboardAudioService = require('./paperStoryboardAudioService');
const sourceService = require('./paperStudioSourceService');
const blueprintCompiler = require('./paperBlueprintCompilerService');
const schemaService = require('./paperStudioSchemaService');
const { CURRENT_PLANNER_VERSION } = require('./paperStudioPlannerVersion');
const {
  canonicalJson,
  nowIso,
  sha256,
} = require('./paperStudioUtils');

function scaleFrame(frame, oldDuration, newDuration) {
  const oldFinal = Math.max(1, Number(oldDuration || 1) - 1);
  const newFinal = Math.max(1, Number(newDuration || 1) - 1);
  return Math.max(0, Math.min(newFinal, Math.round((Number(frame || 0) / oldFinal) * newFinal)));
}

function scalePlan(plan, newDuration) {
  const next = JSON.parse(JSON.stringify(plan || {}));
  const oldDuration = Math.max(1, Number(next.duration_frames || 1));
  next.duration_frames = Number(newDuration);
  for (const track of [
    ...(next.subject_tracks || []),
    ...(next.camera_tracks || []),
    ...(next.scene_tracks || []),
    ...(next.transition_tracks || []),
  ]) {
    const original = track.keyframes || [];
    const byFrame = new Map();
    for (const keyframe of original) {
      const scaled = scaleFrame(keyframe.frame, oldDuration, newDuration);
      byFrame.set(scaled, { ...keyframe, frame: scaled });
    }
    if (byFrame.size < 2 && original.length >= 2) {
      const finalFrame = Math.max(1, Number(newDuration) - 1);
      byFrame.set(0, { ...original[0], frame: 0 });
      byFrame.set(finalFrame, { ...original.at(-1), frame: finalFrame });
    }
    track.keyframes = [...byFrame.values()].sort((left, right) => left.frame - right.frame);
  }
  for (const cue of next.cues || []) cue.frame = scaleFrame(cue.frame, oldDuration, newDuration);
  for (const beat of next.visual_beats || []) {
    beat.start_frame = scaleFrame(beat.start_frame, oldDuration, newDuration);
    beat.peak_frame = scaleFrame(beat.peak_frame, oldDuration, newDuration);
    beat.end_frame = scaleFrame(beat.end_frame, oldDuration, newDuration);
    if (beat.minimum_hold_frames != null) beat.minimum_hold_frames = Math.max(1, scaleFrame(beat.minimum_hold_frames, oldDuration, newDuration));
  }
  for (const transition of next.transition_contracts || []) {
    transition.start_frame = scaleFrame(transition.start_frame, oldDuration, newDuration);
    transition.end_frame = scaleFrame(transition.end_frame, oldDuration, newDuration);
  }
  return next;
}

function scaleProofTargets(targets, oldDuration, newDuration) {
  return (targets || []).map((target) => ({
    ...target,
    frame: scaleFrame(target.frame, oldDuration, newDuration),
  }));
}

function scaleSemanticContract(contract, oldDuration, newDuration) {
  const next = JSON.parse(JSON.stringify(contract || {}));
  for (const beat of next.action_beats || []) {
    beat.start_frame = scaleFrame(beat.start_frame, oldDuration, newDuration);
    beat.peak_frame = scaleFrame(beat.peak_frame, oldDuration, newDuration);
    beat.end_frame = scaleFrame(beat.end_frame, oldDuration, newDuration);
  }
  for (const beat of next.visual_beats || []) {
    beat.start_frame = scaleFrame(beat.start_frame, oldDuration, newDuration);
    beat.peak_frame = scaleFrame(beat.peak_frame, oldDuration, newDuration);
    beat.end_frame = scaleFrame(beat.end_frame, oldDuration, newDuration);
  }
  for (const transition of next.transition_contracts || []) {
    transition.start_frame = scaleFrame(transition.start_frame, oldDuration, newDuration);
    transition.end_frame = scaleFrame(transition.end_frame, oldDuration, newDuration);
  }
  return next;
}

function sync(db, shot, config = {}) {
  if (!shot?.paper_storyboard_id || !shot.motion_plan?.plan_json) return { changed: false, reason: 'not_paper_or_motion_missing' };
  const fps = Number(config.fps || shot.motion_plan.plan_json.fps || 30);
  const baseContext = sourceService.context(db, shot);
  const context = storyboardAudioService.applyTimingToContext(db, baseContext, fps);
  const requiredFrames = Number(context.audio_timing?.effective_duration_frames || shot.motion_plan.plan_json.duration_frames);
  const oldDuration = Number(shot.motion_plan.plan_json.duration_frames || requiredFrames);
  let motionPlan;
  let semanticContract;
  let summary;

  if (shot.blueprint?.blueprint_json && Object.keys(shot.blueprint.blueprint_json).length) {
    const compiled = blueprintCompiler.compile(shot.blueprint.blueprint_json, context, { ...config, fps });
    motionPlan = compiled.motionPlan;
    semanticContract = compiled.semanticContract;
    summary = { ...shot.plan_summary_json, ...compiled.summary };
  } else {
    motionPlan = scalePlan(shot.motion_plan.plan_json, requiredFrames);
    semanticContract = scaleSemanticContract(shot.semantic_contract_json, oldDuration, requiredFrames);
    summary = {
      ...shot.plan_summary_json,
      proof_targets: scaleProofTargets(shot.plan_summary_json?.proof_targets, oldDuration, requiredFrames),
    };
  }

  summary = {
    ...summary,
    planner_version: CURRENT_PLANNER_VERSION,
    authored_duration_seconds: context.audio_timing.authored_duration_seconds,
    effective_duration_seconds: context.audio_timing.effective_duration_seconds,
    speech_end_seconds: context.audio_timing.speech_end_seconds,
    audio_driven_duration: Boolean(context.audio_timing.duration_adjusted),
    audio_duration_extended: Boolean(context.audio_timing.duration_extended),
    audio_duration_shortened: Boolean(context.audio_timing.duration_shortened),
  };
  schemaService.assertValid('semanticContract', semanticContract, '声音同步后的镜头语义合同不符合 Schema');
  schemaService.assertValid('motionPlan', motionPlan, '声音同步后的动作计划不符合 Schema');
  (summary.proof_targets || []).forEach((target) => schemaService.assertValid('proofTarget', target, `声音同步后的动态证明 ${target.key} 不符合 Schema`));

  const unchanged = canonicalJson(motionPlan) === canonicalJson(shot.motion_plan.plan_json)
    && canonicalJson(summary) === canonicalJson(shot.plan_summary_json);
  if (unchanged) return { changed: false, profile: context.audio_timing, duration_frames: requiredFrames };

  const now = nowIso();
  const timingHash = sha256(canonicalJson({ fps: motionPlan.fps, duration_frames: motionPlan.duration_frames, cues: motionPlan.cues || [] }));
  const planHash = sha256(canonicalJson({
    source_revision_hash: shot.source_revision_hash,
    audio_versions: context.audio_timing.tracks,
    motion_plan: motionPlan,
    summary,
  }));
  summary.plan_hash = planHash;
  db.transaction(() => {
    db.prepare(
      `UPDATE paper_motion_plans
       SET semantic_contract_hash = ?, timing_hash = ?, plan_json = ?, compiled_tracks_json = '{}',
           status = 'confirmed', version = version + 1, updated_at = ?
       WHERE shot_id = ? AND plan_revision_id = ?`,
    ).run(sha256(canonicalJson(semanticContract)), timingHash, JSON.stringify(motionPlan), now, Number(shot.id), Number(shot.current_plan_revision_id));
    db.prepare(
      `UPDATE paper_studio_shots
       SET semantic_contract_json = ?, plan_summary_json = ?, last_error_json = '{}',
           version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(semanticContract), JSON.stringify(summary), now, Number(shot.id));
  })();
  return {
    changed: true,
    old_duration_frames: oldDuration,
    duration_frames: Number(motionPlan.duration_frames),
    profile: context.audio_timing,
    plan_hash: planHash,
  };
}

module.exports = {
  scaleFrame,
  scalePlan,
  scaleProofTargets,
  sync,
};
