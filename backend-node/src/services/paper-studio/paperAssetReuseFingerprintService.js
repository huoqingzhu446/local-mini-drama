const { canonicalJson, parseJson, sha256 } = require('./paperStudioUtils');

const VOLATILE_KEY = /(?:^|_)(?:run|shot|revision|authorization|request|audio|dialogue|narration|caption|subtitle|timing|duration|frame|frames|cue|easing|transition)(?:_|$)/i;
const ENVIRONMENT_KEY = /(?:^|_)(?:background|environment|location|place|scene|weather|time_of_day|lighting)(?:_|$)/i;

function normalizedValue(value, { includeEnvironment }) {
  if (Array.isArray(value)) return value.map((item) => normalizedValue(item, { includeEnvironment }));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VOLATILE_KEY.test(key))
    .filter(([key]) => includeEnvironment || !ENVIRONMENT_KEY.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizedValue(item, { includeEnvironment })]));
}

function buildVisualContract({ run = {}, shot = {}, family = {}, slot = {} }) {
  const assetType = String(slot.asset_type || '');
  const includeEnvironment = assetType === 'environment';
  const constraints = parseJson(slot.constraints_json, slot.constraints_json || {});
  const familyContract = parseJson(family.contract_json, family.contract_json || {});
  const registrationCanvas = parseJson(family.registration_canvas_json, family.registration_canvas_json || {});
  return {
    contract_version: 1,
    project_id: Number(run.project_id || shot.drama_id || 0),
    paper_storyboard_id: Number(shot.paper_storyboard_id || 0),
    asset_type: assetType,
    generation_purpose: String(slot.generation_purpose || ''),
    family_pattern: String(family.pattern || ''),
    subject_identity: String(
      constraints.identity_version_id
      || constraints.identity
      || constraints.entity_id
      || constraints.subject_identity
      || slot.slot_key
      || '',
    ),
    visual_style_signature: String(run.style_signature || ''),
    registration_canvas: normalizedValue(registrationCanvas, { includeEnvironment: true }),
    constraints: normalizedValue(constraints, { includeEnvironment }),
    family_contract: normalizedValue(familyContract, { includeEnvironment }),
  };
}

function computeReuseFingerprint(input) {
  return `sha256:${sha256(canonicalJson(buildVisualContract(input)))}`;
}

function backfillReuseFingerprints(db) {
  const rows = db.prepare(
    `SELECT pas.id AS slot_id, pas.slot_key, pas.asset_type, pas.generation_purpose,
            pas.constraints_json, pas.reuse_fingerprint,
            psf.family_key, psf.pattern, psf.registration_canvas_json, psf.contract_json,
            ps.id AS shot_id, ps.drama_id, ps.paper_storyboard_id,
            psr.project_id, psr.style_signature
     FROM paper_asset_slots pas
     JOIN paper_source_families psf ON psf.id = pas.family_id
     JOIN paper_studio_shots ps ON ps.id = psf.shot_id
     JOIN paper_studio_runs psr ON psr.id = ps.run_id
     WHERE pas.reuse_fingerprint IS NULL OR pas.reuse_fingerprint = ''`,
  ).all();
  const updateSlot = db.prepare('UPDATE paper_asset_slots SET reuse_fingerprint = ? WHERE id = ?');
  const updateVersions = db.prepare(
    `UPDATE paper_asset_versions SET reuse_fingerprint = ?
     WHERE slot_id = ? AND (reuse_fingerprint IS NULL OR reuse_fingerprint = '')`,
  );
  const transaction = db.transaction(() => {
    for (const row of rows) {
      const fingerprint = computeReuseFingerprint({
        run: row,
        shot: row,
        family: row,
        slot: row,
      });
      updateSlot.run(fingerprint, Number(row.slot_id));
      updateVersions.run(fingerprint, Number(row.slot_id));
    }
  });
  transaction();
  return { updated_slots: rows.length };
}

module.exports = {
  buildVisualContract,
  computeReuseFingerprint,
  backfillReuseFingerprints,
  normalizedValue,
};
