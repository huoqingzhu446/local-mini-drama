'use strict';

/**
 * Shared, framework-neutral helpers for resolving paper-rig animation tracks.
 *
 * Database animation rows historically used both of these target spellings:
 *   rig.<rig-key>.<part-key>
 *   rig.<part-key>
 *
 * Compiled snapshots normally contain the shortened part-key form. Keeping
 * the normalizer here means the validator, compiler fixtures and Remotion
 * renderer all agree on what constitutes a real rig-part track.
 */

const RIG_MOTION_PROPERTIES = new Set(['x', 'y', 'rotation', 'scale', 'opacity']);

function partKeysFor(rig) {
  return new Set((rig?.parts || []).map((part) => String(part?.key || '').trim()).filter(Boolean));
}

function targetTokens(target) {
  return String(target || '').trim().split('.').filter(Boolean);
}

/**
 * Return the rig part named by a track target, or null when it is not a rig
 * part target. `partKeys` can be supplied to reject malformed/unknown names.
 */
function normalizeRigPartTarget(target, rigKey, partKeys) {
  const keys = partKeys instanceof Set ? partKeys : new Set(partKeys || []);
  const raw = String(target || '').trim();
  if (!raw) return null;

  // Snapshot tracks are already normalized and may simply be "arm_front".
  if (!raw.includes('.')) return keys.size === 0 || keys.has(raw) ? raw : null;

  const tokens = targetTokens(raw);
  if (tokens[0] !== 'rig') return null;
  const rest = tokens.slice(1);
  if (!rest.length) return null;

  // Legacy short form: rig.arm_front
  if (rest.length === 1) return keys.size === 0 || keys.has(rest[0]) ? rest[0] : null;

  // Preferred DB form: rig.<rig-key>.<part-key>. Rig keys are opaque and may
  // contain hyphens, so compare the first segment when it is available.
  if (rigKey && rest[0] === String(rigKey)) {
    const part = rest.slice(1).join('.');
    return keys.size === 0 || keys.has(part) ? part : null;
  }

  // When a rig key is known, do not let a track addressed to another rig
  // silently animate this one. The fallback below is only for snapshots that
  // intentionally omit rig_key altogether.
  if (rigKey && rest.length > 1) return null;

  // Be liberal for snapshots that omit rig_key: the final segment is the
  // part key, but only accept it when it exists in the rig.
  const candidate = rest[rest.length - 1];
  return keys.size === 0 || keys.has(candidate) ? candidate : null;
}

function tracksForPart(rig, partKey, property) {
  const parts = partKeysFor(rig);
  const rigKey = rig?.rig_key || rig?.key || rig?.rigKey || null;
  return (Array.isArray(rig?.tracks) ? rig.tracks : []).filter((track) => {
    if (!track || !RIG_MOTION_PROPERTIES.has(String(track.property || ''))) return false;
    if (property && String(track.property) !== String(property)) return false;
    return normalizeRigPartTarget(track.target, rigKey, parts) === String(partKey);
  });
}

function firstTrackForPart(rig, partKey, property) {
  return tracksForPart(rig, partKey, property)[0] || null;
}

function numericTrackValues(track) {
  if (!track) return [];
  const values = [];
  if (Array.isArray(track.keyframes)) {
    for (const keyframe of track.keyframes) {
      const value = Number(keyframe?.value);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  for (const value of [track.from, track.to]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values.push(numeric);
  }
  return values;
}

function trackHasSpatialChange(track, epsilon = 1e-6) {
  const values = numericTrackValues(track);
  if (values.length < 2) return false;
  const first = values[0];
  return values.some((value) => Math.abs(value - first) > epsilon);
}

function rigMotionTracks(rig, animation) {
  const candidate = {
    ...(rig || {}),
    tracks: Array.isArray(animation?.tracks)
      ? animation.tracks
      : (Array.isArray(rig?.tracks) ? rig.tracks : []),
  };
  const parts = partKeysFor(candidate);
  return candidate.tracks.filter((track) => {
    if (!track || !RIG_MOTION_PROPERTIES.has(String(track.property || ''))) return false;
    return Boolean(normalizeRigPartTarget(track.target, candidate.rig_key || candidate.key, parts));
  });
}

module.exports = {
  RIG_MOTION_PROPERTIES,
  normalizeRigPartTarget,
  tracksForPart,
  firstTrackForPart,
  numericTrackValues,
  trackHasSpatialChange,
  rigMotionTracks,
};
