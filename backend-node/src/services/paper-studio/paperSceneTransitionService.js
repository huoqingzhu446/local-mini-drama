const TRANSITION_POLICIES = Object.freeze({
  soft_crossfade: { min_seconds: 0.3, default_seconds: 0.5, distance: 0.035, blur: 4 },
  dust_whip_pan: { min_seconds: 0.5, default_seconds: 0.6, distance: 0.08, blur: 12 },
  color_dip: { min_seconds: 0.5, default_seconds: 0.65, distance: 0.02, blur: 5 },
  soft_dissolve: { min_seconds: 0.4, default_seconds: 0.6, distance: 0.02, blur: 4 },
  hard_cut: { min_seconds: 0, default_seconds: 0, distance: 0, blur: 0 },
});

function policyFor(kind, relation = 'subject_change') {
  if (TRANSITION_POLICIES[kind]) return TRANSITION_POLICIES[kind];
  if (relation === 'location_change') return TRANSITION_POLICIES.dust_whip_pan;
  if (relation === 'time_jump') return TRANSITION_POLICIES.color_dip;
  return TRANSITION_POLICIES.soft_crossfade;
}

function secondsToFrames(seconds, fps, minimum = 1) {
  return Math.max(minimum, Math.round(Number(seconds || 0) * Math.max(1, Number(fps || 30))));
}

function durationFramesFor(intent, fps) {
  const policy = policyFor(intent?.kind, intent?.relation);
  const requested = intent?.duration_seconds == null ? policy.default_seconds : Number(intent.duration_seconds);
  return secondsToFrames(Math.max(policy.min_seconds, requested), fps, intent?.kind === 'hard_cut' ? 0 : 1);
}

function hardCutAuthorized(transition = {}, plan = {}) {
  if (transition.kind !== 'hard_cut' && transition.relation !== 'explicit_hard_cut') return false;
  return transition.hard_cut_allowed === true
    && String(transition.hard_cut_reason || '').trim().length >= 4
    && plan.motion_profile === 'hard_cut';
}

function transitionLabel(transition = {}) {
  const from = transition.from_scene_key || '前一场景';
  const to = transition.to_scene_key || '后一场景';
  return `${from} → ${to}`;
}

module.exports = {
  TRANSITION_POLICIES,
  policyFor,
  secondsToFrames,
  durationFramesFor,
  hardCutAuthorized,
  transitionLabel,
};
