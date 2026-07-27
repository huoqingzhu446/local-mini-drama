const { canonicalJson, nowIso, parseJson, sha256 } = require('./paperStudioUtils');

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 500);
}

function subjectSignature(subject) {
  if (subject?.library_entity_id) {
    return sha256(canonicalJson({ kind: subject.kind || 'unknown', library_entity_id: Number(subject.library_entity_id) }));
  }
  const normalized = normalizeIdentity(subject?.identity);
  return normalized ? sha256(canonicalJson({ kind: subject.kind || 'unknown', identity: normalized })) : null;
}

function rowToContract(row) {
  return {
    ...row,
    id: Number(row.id),
    run_id: Number(row.run_id),
    source_shot_id: Number(row.source_shot_id),
    target_shot_id: Number(row.target_shot_id),
    contract_json: parseJson(row.contract_json, {}),
    report_json: parseJson(row.report_json, {}),
    version: Number(row.version || 1),
  };
}

function listForRun(db, runId) {
  return db.prepare('SELECT * FROM paper_continuity_contracts WHERE run_id = ? ORDER BY source_shot_id, target_shot_id, id').all(Number(runId)).map(rowToContract);
}

function listForShot(db, shotId) {
  return db.prepare('SELECT * FROM paper_continuity_contracts WHERE source_shot_id = ? OR target_shot_id = ? ORDER BY id').all(Number(shotId), Number(shotId)).map(rowToContract);
}

function rebuildForRun(db, runId) {
  const shots = db.prepare(
    `SELECT id, shot_index, semantic_contract_json, plan_summary_json
     FROM paper_studio_shots
     WHERE run_id = ? AND status != 'pending' AND deleted_at IS NULL
     ORDER BY shot_index, id`,
  ).all(Number(runId)).map((shot) => ({
    ...shot,
    id: Number(shot.id),
    shot_index: Number(shot.shot_index),
    semantic: parseJson(shot.semantic_contract_json, {}),
    summary: parseJson(shot.plan_summary_json, {}),
  }));
  db.prepare('DELETE FROM paper_continuity_contracts WHERE run_id = ?').run(Number(runId));
  const occurrences = new Map();
  for (const shot of shots) {
    for (const subject of shot.semantic.subjects || []) {
      if (subject.kind === 'effect') continue;
      const signature = subjectSignature(subject);
      if (!signature) continue;
      if (!occurrences.has(signature)) occurrences.set(signature, []);
      occurrences.get(signature).push({ shot, subject });
    }
  }
  const now = nowIso();
  const insert = db.prepare(
    `INSERT INTO paper_continuity_contracts
      (run_id, source_shot_id, target_shot_id, continuity_key, subject_signature,
       contract_json, report_json, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', 'planned', 1, ?, ?)`,
  );
  let count = 0;
  for (const [signature, items] of occurrences) {
    for (let index = 1; index < items.length; index += 1) {
      const source = items[index - 1];
      const target = items[index];
      const contract = {
        type: 'subject_identity_handoff',
        identity: target.subject.identity,
        kind: target.subject.kind,
        source_subject_key: source.subject.key,
        target_subject_key: target.subject.key,
        rules: ['identity_reference_required', 'palette_consistency', 'silhouette_consistency'],
        source_shot_index: source.shot.shot_index,
        target_shot_index: target.shot.shot_index,
      };
      insert.run(Number(runId), source.shot.id, target.shot.id, `subject:${signature}`, signature, JSON.stringify(contract), now, now);
      count += 1;
    }
  }
  for (const shot of shots) {
    const contractCount = db.prepare('SELECT COUNT(*) AS count FROM paper_continuity_contracts WHERE source_shot_id = ? OR target_shot_id = ?').get(shot.id, shot.id).count;
    db.prepare('UPDATE paper_studio_shots SET plan_summary_json = ? WHERE id = ?').run(JSON.stringify({ ...shot.summary, continuity_contract_count: Number(contractCount) }), shot.id);
  }
  return { run_id: Number(runId), contract_count: count, contracts: listForRun(db, runId) };
}

function acceptedSubjectAssets(db, shotId, subjectKey) {
  const rows = db.prepare(
    `SELECT pas.slot_key, pas.constraints_json, pav.id AS version_id,
            pav.source_local_path, pav.alpha_local_path, pav.source_hash, pav.alpha_hash,
            pav.provenance_json
     FROM paper_source_families psf
     JOIN paper_asset_slots pas ON pas.family_id = psf.id
     JOIN paper_asset_versions pav ON pav.id = pas.current_version_id
     WHERE psf.shot_id = ? AND pav.status = 'accepted' AND pas.deleted_at IS NULL
     ORDER BY pas.id`,
  ).all(Number(shotId));
  return rows.filter((row) => parseJson(row.constraints_json, {}).subject_key === subjectKey).map((row) => ({
    ...row,
    version_id: Number(row.version_id),
    constraints_json: parseJson(row.constraints_json, {}),
    provenance_json: parseJson(row.provenance_json, {}),
    local_path: row.alpha_local_path || row.source_local_path,
    hash: row.alpha_hash || row.source_hash,
  }));
}

function incomingForSubject(db, shotId, targetSubjectKey) {
  return listForShot(db, shotId).filter((contract) => (
    contract.target_shot_id === Number(shotId)
    && contract.contract_json.target_subject_key === targetSubjectKey
  ));
}

function referencePathsForSlot(db, shot, slot) {
  const targetSubjectKey = slot?.constraints_json?.subject_key;
  if (!targetSubjectKey) return [];
  const refs = [];
  for (const contract of incomingForSubject(db, shot.id, targetSubjectKey)) {
    const state = slot.constraints_json?.state || null;
    const sourceAssets = acceptedSubjectAssets(db, contract.source_shot_id, contract.contract_json.source_subject_key)
      .sort((left, right) => Number(right.constraints_json.state === state) - Number(left.constraints_json.state === state));
    for (const asset of sourceAssets) {
      if (asset.local_path && !refs.includes(asset.local_path)) refs.push(asset.local_path);
    }
  }
  return refs;
}

function assertIncomingSourcesReady(db, shotId) {
  const incoming = listForShot(db, shotId).filter((contract) => contract.target_shot_id === Number(shotId));
  const missing = incoming.filter((contract) => (
    acceptedSubjectAssets(db, contract.source_shot_id, contract.contract_json.source_subject_key).length === 0
  ));
  return {
    pass: missing.length === 0,
    incoming_count: incoming.length,
    missing: missing.map((contract) => ({
      contract_id: contract.id,
      source_shot_id: contract.source_shot_id,
      target_shot_id: contract.target_shot_id,
      identity: contract.contract_json.identity,
    })),
  };
}

function evaluateForShot(db, shotId) {
  const incoming = listForShot(db, shotId).filter((contract) => contract.target_shot_id === Number(shotId));
  const reports = [];
  const now = nowIso();
  for (const contract of incoming) {
    const sourceAssets = acceptedSubjectAssets(db, contract.source_shot_id, contract.contract_json.source_subject_key);
    const targetAssets = acceptedSubjectAssets(db, contract.target_shot_id, contract.contract_json.target_subject_key);
    const sourcePaths = new Set(sourceAssets.map((asset) => asset.local_path).filter(Boolean));
    const sourceHashes = new Set(sourceAssets.map((asset) => asset.hash).filter(Boolean));
    const referencedVersions = targetAssets.filter((asset) => {
      const references = asset.provenance_json.reference_images || [];
      return references.some((reference) => sourcePaths.has(reference)) || sourceHashes.has(asset.hash);
    });
    const pass = sourceAssets.length > 0 && targetAssets.length > 0 && referencedVersions.length > 0;
    const report = {
      pass,
      source_asset_version_ids: sourceAssets.map((asset) => asset.version_id),
      target_asset_version_ids: targetAssets.map((asset) => asset.version_id),
      referenced_target_version_ids: referencedVersions.map((asset) => asset.version_id),
      rule: 'identity_reference_required',
    };
    db.prepare('UPDATE paper_continuity_contracts SET status = ?, report_json = ?, version = version + 1, updated_at = ? WHERE id = ?').run(pass ? 'satisfied' : 'failed', JSON.stringify(report), now, contract.id);
    reports.push({ contract_id: contract.id, ...report });
  }
  return { pass: reports.every((report) => report.pass), reports };
}

function failedTargetSubjectKeys(db, shotId) {
  return listForShot(db, shotId)
    .filter((contract) => contract.target_shot_id === Number(shotId) && contract.status === 'failed')
    .map((contract) => contract.contract_json.target_subject_key)
    .filter(Boolean);
}

module.exports = {
  normalizeIdentity,
  subjectSignature,
  listForRun,
  listForShot,
  rebuildForRun,
  acceptedSubjectAssets,
  referencePathsForSlot,
  assertIncomingSourcesReady,
  evaluateForShot,
  failedTargetSubjectKeys,
};
