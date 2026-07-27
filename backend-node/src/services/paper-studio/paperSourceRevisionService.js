const {
  PaperStudioError,
  canonicalJson,
  nowIso,
  parseJson,
  sha256,
} = require('./paperStudioUtils');
const sourceService = require('./paperStudioSourceService');

const SOURCE_REVISION_VERSION = 4;

function storyboardSource(storyboard) {
  return {
    id: Number(storyboard.id),
    storyboard_number: Number(storyboard.storyboard_number || 0),
    scene_id: storyboard.scene_id == null ? null : Number(storyboard.scene_id),
    title: storyboard.title || '',
    description: storyboard.description || '',
    location: storyboard.location || '',
    time: storyboard.time || '',
    layout_description: storyboard.layout_description || '',
    action: storyboard.action || '',
    dialogue: storyboard.dialogue || '',
    narration: storyboard.narration || '',
    movement: storyboard.movement || '',
    characters: storyboard.characters || '',
    duration: Number(storyboard.duration || 0),
    image_url: storyboard.image_url || '',
    local_path: storyboard.local_path || '',
    audio_local_path: storyboard.audio_local_path || '',
    narration_audio_local_path: storyboard.narration_audio_local_path || '',
    updated_at: storyboard.updated_at || '',
  };
}

function entitySource(row, fields) {
  if (!row) return null;
  return Object.fromEntries(fields.map((field) => [field, row[field] == null ? null : row[field]]));
}

function parseIds(raw) {
  const values = parseJson(raw, []);
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
}

function relatedSources(db, storyboard) {
  const characterIds = parseIds(storyboard.characters);
  const characters = characterIds.length
    ? db.prepare(`SELECT * FROM characters WHERE id IN (${characterIds.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY id`).all(...characterIds)
    : [];
  const props = db.prepare(`SELECT p.* FROM props p
    JOIN storyboard_props sp ON sp.prop_id = p.id
    WHERE sp.storyboard_id = ? AND p.deleted_at IS NULL ORDER BY p.id`).all(Number(storyboard.id));
  const scene = storyboard.scene_id == null ? null : db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.scene_id));
  return {
    scene: entitySource(scene, ['id', 'location', 'time', 'prompt', 'polished_prompt', 'image_url', 'local_path', 'updated_at']),
    characters: characters.map((row) => entitySource(row, ['id', 'name', 'role', 'appearance', 'polished_prompt', 'image_url', 'local_path', 'ref_image', 'updated_at'])),
    props: props.map((row) => entitySource(row, ['id', 'name', 'type', 'description', 'prompt', 'image_url', 'local_path', 'ref_image', 'updated_at'])),
  };
}

function providerSignature(db, providerConfigId) {
  if (!providerConfigId) return null;
  const row = db.prepare(`SELECT id, service_type, provider, api_protocol, base_url,
      model, default_model, settings, is_active FROM ai_service_configs WHERE id = ?`).get(Number(providerConfigId));
  if (!row) return null;
  return sha256(canonicalJson({
    id: Number(row.id),
    service_type: row.service_type,
    provider: row.provider,
    api_protocol: row.api_protocol,
    base_url: row.base_url,
    model: row.model,
    default_model: row.default_model,
    settings: parseJson(row.settings, {}),
    is_active: Boolean(row.is_active),
  }));
}

function contextForRun(db, run) {
  const selection = parseJson(run.selection_json, {});
  return {
    style_version_id: run.style_version_id || null,
    style_signature: run.style_signature || null,
    quality_tier: run.quality_tier || null,
    provider_signature: providerSignature(db, selection.image_provider_config_id),
  };
}

function hashStoryboard(storyboard, context = {}) {
  return sha256(canonicalJson({
    schema_version: 3,
    storyboard: storyboardSource(storyboard),
    style_version_id: context.style_version_id || null,
    style_signature: context.style_signature || null,
  }));
}

function hashShot(db, storyboard, context = {}) {
  return sha256(canonicalJson({
    source_revision_version: SOURCE_REVISION_VERSION,
    storyboard: storyboardSource(storyboard),
    related: relatedSources(db, storyboard),
    style_version_id: context.style_version_id || null,
    style_signature: context.style_signature || null,
    quality_tier: context.quality_tier || null,
    provider_signature: context.provider_signature || null,
  }));
}

function hashRun({ db, drama, episode, storyboards, style_version_id, style_signature, quality_tier, provider_signature }) {
  const context = { style_version_id, style_signature, quality_tier, provider_signature };
  return sha256(canonicalJson({
    source_revision_version: SOURCE_REVISION_VERSION,
    drama_id: Number(drama.id),
    drama_updated_at: drama.updated_at || '',
    episode_id: Number(episode.id),
    episode_updated_at: episode.updated_at || '',
    style_version_id: style_version_id || null,
    style_signature: style_signature || null,
    quality_tier: quality_tier || null,
    provider_signature: provider_signature || null,
    shots: storyboards.map((storyboard) => hashShot(db, storyboard, context)),
  }));
}

function hashPaperRevision(revision, context = {}) {
  return sha256(canonicalJson({
    source_revision_version: SOURCE_REVISION_VERSION,
    source_kind: 'paper',
    paper_storyboard_id: Number(revision.paper_storyboard_id),
    paper_storyboard_revision_id: Number(revision.id),
    revision_number: Number(revision.revision_number),
    content_hash: revision.content_hash,
    content: revision.content,
    style_version_id: context.style_version_id || null,
    style_signature: context.style_signature || null,
    quality_tier: context.quality_tier || null,
    provider_signature: context.provider_signature || null,
  }));
}

function hashPaperRun({ drama, episode, revisions, style_version_id, style_signature, quality_tier, provider_signature }) {
  const context = { style_version_id, style_signature, quality_tier, provider_signature };
  return sha256(canonicalJson({
    source_revision_version: SOURCE_REVISION_VERSION,
    source_kind: 'paper',
    drama_id: Number(drama.id),
    paper_episode_id: Number(episode.id),
    episode: {
      episode_number: Number(episode.episode_number),
      title: episode.title || '',
      aspect_ratio: episode.aspect_ratio || '16:9',
      fps: Number(episode.fps || 30),
    },
    style_version_id: style_version_id || null,
    style_signature: style_signature || null,
    quality_tier: quality_tier || null,
    provider_signature: provider_signature || null,
    shots: revisions.map((revision) => hashPaperRevision(revision, context)),
  }));
}

function markAffectedStale(db, {
  drama_id,
  storyboard_id,
  scene_id,
  character_id,
  prop_id,
  reason = '纸片动画源数据已变化',
  code = 'PAPER_STUDIO_SOURCE_STALE',
} = {}) {
  const conditions = [];
  const params = [];
  if (storyboard_id != null) {
    conditions.push('storyboard_id = ?');
    params.push(Number(storyboard_id));
  }
  if (drama_id != null) {
    conditions.push('drama_id = ?');
    params.push(Number(drama_id));
  }
  if (scene_id != null) {
    conditions.push('storyboard_id IN (SELECT id FROM storyboards WHERE scene_id = ?)');
    params.push(Number(scene_id));
  }
  if (character_id != null) {
    conditions.push(`storyboard_id IN (
      SELECT storyboard_id FROM storyboard_characters WHERE character_id = ?
      UNION
      SELECT s.id FROM storyboards s, json_each(CASE WHEN json_valid(s.characters) THEN s.characters ELSE '[]' END) jc
      WHERE CAST(jc.value AS INTEGER) = ?
    )`);
    params.push(Number(character_id), Number(character_id));
  }
  if (prop_id != null) {
    conditions.push('storyboard_id IN (SELECT storyboard_id FROM storyboard_props WHERE prop_id = ?)');
    params.push(Number(prop_id));
  }
  if (!conditions.length) return { shots: 0, runs: 0 };
  const shots = db.prepare(`SELECT id, run_id FROM paper_studio_shots
    WHERE (${conditions.join(' OR ')}) AND deleted_at IS NULL
      AND COALESCE(source_kind, 'legacy') != 'paper'
      AND status NOT IN ('cancelled','stale')`).all(...params);
  if (!shots.length) return { shots: 0, runs: 0 };
  const now = nowIso();
  const error = { code, message: reason, at: now };
  const runIds = [...new Set(shots.map((shot) => Number(shot.run_id)))];
  const transaction = db.transaction(() => {
    for (const shot of shots) {
      db.prepare(`UPDATE paper_studio_shots
        SET status = 'stale', current_snapshot_id = NULL, approved_snapshot_id = NULL,
            last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(error), now, Number(shot.id));
      db.prepare(`UPDATE paper_job_steps SET status = 'cancelled', lease_owner = NULL,
        lease_expires_at = NULL, error_json = ?, updated_at = ?
        WHERE shot_id = ? AND status NOT IN ('completed','cancelled')`)
        .run(JSON.stringify(error), now, Number(shot.id));
      db.prepare("UPDATE paper_render_snapshots SET status = CASE WHEN status = 'approved' THEN 'approval_invalidated' ELSE 'superseded' END WHERE shot_id = ? AND status NOT IN ('superseded','approval_invalidated')")
        .run(Number(shot.id));
    }
  });
  transaction();
  const aggregateService = require('./paperRunAggregateService');
  runIds.forEach((runId) => aggregateService.sync(db, runId));
  return { shots: shots.length, runs: runIds.length, run_ids: runIds };
}

function currentShotRevision(db, shotId) {
  const shot = db.prepare('SELECT * FROM paper_studio_shots WHERE id = ? AND deleted_at IS NULL').get(Number(shotId));
  if (!shot) throw new PaperStudioError('PAPER_STUDIO_SHOT_NOT_FOUND', '纸片动画镜头不存在', { shot_id: Number(shotId) }, 404);
  const run = db.prepare('SELECT * FROM paper_studio_runs WHERE id = ? AND deleted_at IS NULL').get(Number(shot.run_id));
  if (sourceService.isPaperShot(shot)) {
    if (!run) throw new PaperStudioError('PAPER_STUDIO_SOURCE_MISSING', '纸片动画生产版本不存在', { shot_id: Number(shotId) }, 409);
    const revision = sourceService.paperRevision(db, shot);
    const current = hashPaperRevision(revision, contextForRun(db, run));
    return { shot, run, storyboard: sourceService.paperStoryboardFromRevision(revision), revision, current, expected: shot.source_revision_hash, pass: current === shot.source_revision_hash };
  }
  const storyboard = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(shot.storyboard_id));
  if (!run || !storyboard) throw new PaperStudioError('PAPER_STUDIO_SOURCE_MISSING', '纸片动画源分镜或生产版本不存在', { shot_id: Number(shotId) }, 409);
  const current = hashShot(db, storyboard, contextForRun(db, run));
  return { shot, run, storyboard, current, expected: shot.source_revision_hash, pass: current === shot.source_revision_hash };
}

function assertShotCurrent(db, shotId) {
  const report = currentShotRevision(db, shotId);
  if (report.pass) return report;
  if (sourceService.isPaperShot(report.shot)) {
    const now = nowIso();
    const error = { code: 'PAPER_STUDIO_SOURCE_STALE', message: '纸片分镜冻结修订版校验失败', at: now };
    db.prepare("UPDATE paper_studio_shots SET status = 'stale', current_snapshot_id = NULL, approved_snapshot_id = NULL, last_error_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(error), now, Number(report.shot.id));
    require('./paperRunAggregateService').sync(db, report.shot.run_id);
    throw new PaperStudioError('PAPER_STUDIO_SOURCE_STALE', '纸片分镜冻结修订版校验失败，当前生产版本不能继续', { shot_id: Number(shotId), expected: report.expected, current: report.current }, 409);
  }
  markAffectedStale(db, {
    storyboard_id: report.storyboard.id,
    reason: '分镜、关联角色/道具/场景、视觉风格或生产配置已变化；请新建生产版本重新分析',
  });
  throw new PaperStudioError('PAPER_STUDIO_SOURCE_STALE', '纸片动画源数据已变化，当前生产版本不能继续', {
    shot_id: Number(shotId), expected: report.expected, current: report.current,
  }, 409);
}

module.exports = {
  SOURCE_REVISION_VERSION,
  storyboardSource,
  relatedSources,
  providerSignature,
  contextForRun,
  hashStoryboard,
  hashShot,
  hashRun,
  hashPaperRevision,
  hashPaperRun,
  markAffectedStale,
  currentShotRevision,
  assertShotCurrent,
};
