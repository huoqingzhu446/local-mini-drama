const {
  PaperStudioError,
  parseJson,
} = require('./paperStudioUtils');

function isPaperShot(shot) {
  return shot?.source_kind === 'paper' || Number(shot?.paper_storyboard_revision_id || 0) > 0;
}

function paperRevision(db, shot) {
  const revision = db.prepare(
    `SELECT psr.*, ps.paper_episode_id, ps.legacy_storyboard_id, ps.source_kind,
            pe.episode_number, pe.title AS episode_title, pe.project_id,
            psp.drama_id
     FROM paper_storyboard_revisions psr
     JOIN paper_storyboards ps ON ps.id = psr.paper_storyboard_id
     JOIN paper_studio_episodes pe ON pe.id = ps.paper_episode_id
     JOIN paper_studio_projects psp ON psp.id = pe.project_id
     WHERE psr.id = ? AND psr.paper_storyboard_id = ?`,
  ).get(Number(shot.paper_storyboard_revision_id), Number(shot.paper_storyboard_id));
  if (!revision) throw new PaperStudioError('PAPER_STUDIO_SOURCE_REVISION_MISSING', '纸片分镜修订版不存在，生产版本不能继续', { shot_id: Number(shot.id), paper_storyboard_revision_id: Number(shot.paper_storyboard_revision_id) }, 409);
  return {
    ...revision,
    id: Number(revision.id),
    paper_storyboard_id: Number(revision.paper_storyboard_id),
    paper_episode_id: Number(revision.paper_episode_id),
    revision_number: Number(revision.revision_number),
    content: parseJson(revision.content_json, {}),
  };
}

function paperStoryboardFromRevision(revision) {
  const content = revision.content || {};
  return {
    id: Number(revision.paper_storyboard_id),
    paper_storyboard_id: Number(revision.paper_storyboard_id),
    paper_storyboard_revision_id: Number(revision.id),
    episode_id: Number(revision.paper_episode_id),
    storyboard_number: Number(content.shot_number || 0),
    title: content.title || '',
    description: content.description || '',
    action: content.action || '',
    dialogue: content.dialogue || '',
    narration: content.narration || '',
    duration: Number(content.duration || 6),
    shot_type: content.shot_type || '',
    movement: content.camera_motion || '',
    camera_motion: content.camera_motion || '',
    prompt: content.visual_prompt || '',
    visual_prompt: content.visual_prompt || '',
    negative_prompt: content.negative_prompt || '',
    environment_only: Boolean(content.environment_only),
    image_url: content.reference_image_url || '',
    local_path: content.reference_local_path || '',
    location: '',
    time: '',
    layout_description: '',
    characters: '[]',
    scene_id: null,
    audio_local_path: '',
    narration_audio_local_path: '',
    source_kind: content.source_kind || revision.source_kind || 'paper',
    legacy_storyboard_id: content.legacy_storyboard_id || revision.legacy_storyboard_id || null,
    episode_number: Number(revision.episode_number || 0),
    episode_title: revision.episode_title || '',
    drama_id: Number(revision.drama_id),
    revision_content_hash: revision.content_hash,
  };
}

function legacyContext(db, shot) {
  const storyboardId = Number(shot.legacy_storyboard_id || shot.storyboard_id);
  const storyboard = db.prepare(
    `SELECT sb.*, e.drama_id, e.episode_number, e.title AS episode_title
     FROM storyboards sb
     JOIN episodes e ON e.id = sb.episode_id
     WHERE sb.id = ? AND sb.deleted_at IS NULL`,
  ).get(storyboardId);
  if (!storyboard || Number(storyboard.drama_id) !== Number(shot.drama_id)) {
    throw new PaperStudioError('PAPER_STUDIO_STORYBOARD_OWNERSHIP_MISMATCH', '旧分镜源数据已不存在或归属发生变化', { shot_id: Number(shot.id), legacy_storyboard_id: storyboardId }, 409);
  }
  const scene = storyboard.scene_id == null ? null : db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(Number(storyboard.scene_id));
  const props = db.prepare(
    `SELECT p.* FROM props p
     JOIN storyboard_props sp ON sp.prop_id = p.id
     WHERE sp.storyboard_id = ? AND p.deleted_at IS NULL
     ORDER BY p.id`,
  ).all(Number(storyboard.id));
  const characterRefs = parseJson(storyboard.characters, []);
  const characterIds = Array.isArray(characterRefs)
    ? characterRefs.map((item) => Number(typeof item === 'object' && item != null ? item.id : item)).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  let characters = characterIds.length
    ? db.prepare(`SELECT *, 'characters' AS source_table FROM characters WHERE drama_id = ? AND deleted_at IS NULL AND id IN (${characterIds.map(() => '?').join(',')}) ORDER BY sort_order, id`).all(Number(shot.drama_id), ...characterIds)
    : [];
  if (!characters.length) {
    characters = db.prepare(
      `SELECT cl.*, 'character_libraries' AS source_table
       FROM character_libraries cl
       JOIN storyboard_characters sc ON sc.character_id = cl.id
       WHERE sc.storyboard_id = ? AND cl.deleted_at IS NULL
       ORDER BY sc.id, cl.id`,
    ).all(Number(storyboard.id));
  }
  return { storyboard, scene, props, characters, revision: null, source_kind: 'legacy' };
}

function paperEntityLinks(db, paperStoryboardId) {
  try {
    return db.prepare(
      `SELECT link.role, link.sort_order, ple.id AS entity_id, ple.name, ple.description, ple.entity_type,
              ple.aliases_json, ple.scale_anchor_json,
              iv.id AS identity_version_id, iv.source_local_path, iv.alpha_local_path
       FROM paper_storyboard_entity_links link
       JOIN paper_library_entities ple ON ple.id = link.entity_id AND ple.deleted_at IS NULL
       LEFT JOIN paper_library_identity_versions iv
         ON iv.id = ple.current_identity_version_id AND iv.status = 'approved'
       WHERE link.paper_storyboard_id = ?
       ORDER BY link.sort_order, link.id`,
    ).all(Number(paperStoryboardId));
  } catch (_) {
    return [];
  }
}

function linkToEntity(row) {
  return {
    id: Number(row.entity_id),
    name: row.name,
    appearance: row.description || '',
    description: row.description || '',
    prompt: row.description || '',
    source_table: 'paper_library',
    library_entity_id: Number(row.entity_id),
    identity_version_id: row.identity_version_id == null ? null : Number(row.identity_version_id),
    local_path: row.alpha_local_path || row.source_local_path || null,
    scale_anchor: parseJson(row.scale_anchor_json, {}),
  };
}

function context(db, shot) {
  if (!isPaperShot(shot)) return legacyContext(db, shot);
  const revision = paperRevision(db, shot);
  if (Number(revision.drama_id) !== Number(shot.drama_id)) throw new PaperStudioError('PAPER_STUDIO_SOURCE_OWNERSHIP_MISMATCH', '纸片分镜修订版不属于当前项目', { shot_id: Number(shot.id) }, 409);
  const links = paperEntityLinks(db, revision.paper_storyboard_id);
  const sceneLink = links.find((row) => row.entity_type === 'scene') || null;
  return {
    storyboard: paperStoryboardFromRevision(revision),
    scene: sceneLink ? linkToEntity(sceneLink) : null,
    props: links.filter((row) => row.entity_type === 'prop').map(linkToEntity),
    characters: links.filter((row) => row.entity_type === 'character').map(linkToEntity),
    revision,
    source_kind: 'paper',
  };
}

function storyboard(db, shot) {
  return context(db, shot).storyboard;
}

function referenceMedia(db, shot) {
  const item = storyboard(db, shot);
  return item.local_path || item.image_url || null;
}

function legacyStoryboardId(shot) {
  if (isPaperShot(shot)) return shot.legacy_storyboard_id == null ? null : Number(shot.legacy_storyboard_id);
  return Number(shot.legacy_storyboard_id || shot.storyboard_id);
}

module.exports = {
  paperEntityLinks,
  isPaperShot,
  paperRevision,
  paperStoryboardFromRevision,
  legacyContext,
  context,
  storyboard,
  referenceMedia,
  legacyStoryboardId,
};
