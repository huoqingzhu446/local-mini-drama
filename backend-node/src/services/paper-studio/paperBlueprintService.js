const schemaService = require('./paperStudioSchemaService');
const {
  PaperStudioError,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');

function rowToBlueprint(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    shot_id: Number(row.shot_id),
    paper_storyboard_revision_id: row.paper_storyboard_revision_id == null ? null : Number(row.paper_storyboard_revision_id),
    revision_number: Number(row.revision_number),
    version: Number(row.version || 1),
    blueprint_json: parseJson(row.blueprint_json, {}),
  };
}

function getRevision(db, revisionId) {
  const row = db.prepare('SELECT * FROM paper_blueprint_revisions WHERE id = ?').get(Number(revisionId));
  if (!row) throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_NOT_FOUND', '生产蓝图版本不存在', { blueprint_revision_id: Number(revisionId) }, 404);
  const blueprint = rowToBlueprint(row);
  const entities = db.prepare(
    'SELECT * FROM paper_storyboard_entities WHERE blueprint_revision_id = ? ORDER BY id',
  ).all(blueprint.id).map((entity) => ({
    ...entity,
    id: Number(entity.id),
    shot_id: Number(entity.shot_id),
    paper_storyboard_id: entity.paper_storyboard_id == null ? null : Number(entity.paper_storyboard_id),
    paper_storyboard_revision_id: entity.paper_storyboard_revision_id == null ? null : Number(entity.paper_storyboard_revision_id),
    blueprint_revision_id: Number(entity.blueprint_revision_id),
    identity_version_id: entity.identity_version_id == null ? null : Number(entity.identity_version_id),
    source_library_id: entity.source_library_id == null ? null : Number(entity.source_library_id),
    independent_layer: Boolean(entity.independent_layer),
    reusable: Boolean(entity.reusable),
    version: Number(entity.version || 1),
    attributes_json: parseJson(entity.attributes_json, {}),
  }));
  const actionRow = db.prepare(
    'SELECT * FROM paper_action_contracts WHERE blueprint_revision_id = ?',
  ).get(blueprint.id);
  const actionContract = actionRow ? {
    ...actionRow,
    id: Number(actionRow.id),
    shot_id: Number(actionRow.shot_id),
    blueprint_revision_id: Number(actionRow.blueprint_revision_id),
    paper_storyboard_revision_id: actionRow.paper_storyboard_revision_id == null ? null : Number(actionRow.paper_storyboard_revision_id),
    version: Number(actionRow.version || 1),
    contract_json: parseJson(actionRow.contract_json, {}),
  } : null;
  return { ...blueprint, entities, action_contract: actionContract };
}

function getForShot(db, shotId) {
  const shot = db.prepare(
    'SELECT id, blueprint_revision_id FROM paper_studio_shots WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(shotId));
  if (!shot) throw new PaperStudioError('PAPER_STUDIO_SHOT_NOT_FOUND', '纸片工作室分镜不存在', { shot_id: Number(shotId) }, 404);
  if (!shot.blueprint_revision_id) {
    throw new PaperStudioError('PAPER_STUDIO_BLUEPRINT_NOT_READY', '当前镜头还没有生产蓝图，请先分析镜头', { shot_id: Number(shotId) }, 409);
  }
  return getRevision(db, shot.blueprint_revision_id);
}

function insertEntities(db, shot, blueprintRevisionId, blueprint, now) {
  const insert = db.prepare(
    `INSERT INTO paper_storyboard_entities
      (shot_id, paper_storyboard_id, paper_storyboard_revision_id, blueprint_revision_id,
       entity_key, entity_type, display_name, role, identity_version_id,
       source_library_type, source_library_id, independent_layer, reusable,
       attributes_json, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const entity of blueprint.entities) {
    insert.run(
      Number(shot.id), shot.paper_storyboard_id == null ? null : Number(shot.paper_storyboard_id),
      shot.paper_storyboard_revision_id == null ? null : Number(shot.paper_storyboard_revision_id),
      Number(blueprintRevisionId), entity.key, entity.type, entity.name, entity.role,
      entity.identity_version_id == null ? null : Number(entity.identity_version_id),
      entity.source_library_type || null,
      entity.source_library_id == null ? null : Number(entity.source_library_id),
      entity.independent_layer ? 1 : 0, entity.reusable ? 1 : 0,
      JSON.stringify({ states: entity.states, ...(entity.attributes || {}) }), now, now,
    );
  }
}

function persist(db, shot, blueprint, compiledPlanHash, createdFrom = 'analysis') {
  schemaService.assertValid('paperBlueprint', blueprint, '保存的生产蓝图不符合 Schema');
  const now = nowIso();
  const blueprintHash = sha256(canonicalJson({ source_revision_hash: shot.source_revision_hash, blueprint }));
  const existing = db.prepare(
    'SELECT id, status FROM paper_blueprint_revisions WHERE shot_id = ? AND blueprint_hash = ?',
  ).get(Number(shot.id), blueprintHash);
  if (existing) {
    const existingContract = db.prepare('SELECT id FROM paper_action_contracts WHERE blueprint_revision_id = ?').get(Number(existing.id));
    if (existing.status !== 'draft') {
      db.prepare(
        `UPDATE paper_blueprint_revisions
         SET status = 'superseded', superseded_at = ?
         WHERE shot_id = ? AND id != ? AND status IN ('draft','confirmed')`,
      ).run(now, Number(shot.id), Number(existing.id));
      db.prepare(
        `UPDATE paper_action_contracts
         SET status = 'superseded', superseded_at = ?
         WHERE shot_id = ? AND blueprint_revision_id != ? AND status IN ('draft','confirmed')`,
      ).run(now, Number(shot.id), Number(existing.id));
      db.prepare(
        `UPDATE paper_blueprint_revisions
         SET status = 'draft', confirmed_at = NULL, superseded_at = NULL,
             compiled_plan_hash = ?, created_from = 'restored', version = version + 1
         WHERE id = ?`,
      ).run(compiledPlanHash, Number(existing.id));
      db.prepare(
        `UPDATE paper_action_contracts
         SET status = 'draft', confirmed_at = NULL, superseded_at = NULL, version = version + 1
         WHERE blueprint_revision_id = ?`,
      ).run(Number(existing.id));
    }
    db.prepare('UPDATE paper_studio_shots SET blueprint_revision_id = ?, action_contract_id = ? WHERE id = ?')
      .run(Number(existing.id), existingContract?.id || null, Number(shot.id));
    return getRevision(db, existing.id);
  }
  const next = db.prepare(
    'SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM paper_blueprint_revisions WHERE shot_id = ?',
  ).get(Number(shot.id));
  db.prepare(
    `UPDATE paper_blueprint_revisions
     SET status = 'superseded', superseded_at = ?
     WHERE shot_id = ? AND status IN ('draft','confirmed')`,
  ).run(now, Number(shot.id));
  db.prepare(
    `UPDATE paper_action_contracts
     SET status = 'superseded', superseded_at = ?
     WHERE shot_id = ? AND status IN ('draft','confirmed')`,
  ).run(now, Number(shot.id));
  const result = db.prepare(
    `INSERT INTO paper_blueprint_revisions
      (shot_id, paper_storyboard_revision_id, revision_number, source_revision_hash,
       blueprint_json, blueprint_hash, compiled_plan_hash, status, created_from,
       version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?)`,
  ).run(
    Number(shot.id), shot.paper_storyboard_revision_id == null ? null : Number(shot.paper_storyboard_revision_id),
    Number(next.revision_number), shot.source_revision_hash, JSON.stringify(blueprint), blueprintHash,
    compiledPlanHash, createdFrom, now,
  );
  const blueprintRevisionId = Number(result.lastInsertRowid);
  insertEntities(db, shot, blueprintRevisionId, blueprint, now);
  const contractHash = sha256(canonicalJson(blueprint.action_contract));
  const contractResult = db.prepare(
    `INSERT INTO paper_action_contracts
      (shot_id, paper_storyboard_revision_id, blueprint_revision_id, contract_json,
       contract_hash, status, version, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', 1, ?)`,
  ).run(
    Number(shot.id), shot.paper_storyboard_revision_id == null ? null : Number(shot.paper_storyboard_revision_id),
    blueprintRevisionId, JSON.stringify(blueprint.action_contract), contractHash, now,
  );
  db.prepare('UPDATE paper_studio_shots SET blueprint_revision_id = ?, action_contract_id = ? WHERE id = ?')
    .run(blueprintRevisionId, Number(contractResult.lastInsertRowid), Number(shot.id));
  return getRevision(db, blueprintRevisionId);
}

function confirm(db, shotId) {
  const current = getForShot(db, shotId);
  const now = nowIso();
  db.prepare(
    "UPDATE paper_blueprint_revisions SET status = 'confirmed', confirmed_at = ?, version = version + 1 WHERE id = ? AND status = 'draft'",
  ).run(now, current.id);
  db.prepare(
    "UPDATE paper_action_contracts SET status = 'confirmed', confirmed_at = ?, version = version + 1 WHERE blueprint_revision_id = ? AND status = 'draft'",
  ).run(now, current.id);
  return getRevision(db, current.id);
}

module.exports = { rowToBlueprint, getRevision, getForShot, persist, confirm };
