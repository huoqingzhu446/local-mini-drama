// 分镜：create, update, delete；帧提示词 get/save

/**
 * 将分镜勾选的角色（dramas.characters 表 id）同步到 storyboard_characters（角色库 id），
 * 便于帧提示词与图生参考图与 UI 一致；按角色名匹配本剧或全局角色库。
 */
function parseDramaCharacterIds(charactersValue) {
  if (charactersValue === undefined || charactersValue === null) return null;
  if (Array.isArray(charactersValue)) {
    return charactersValue
      .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof charactersValue === 'string') {
    try {
      const arr = JSON.parse(charactersValue);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
        .filter((n) => Number.isFinite(n));
    } catch (_) {
      return [];
    }
  }
  return [];
}

function syncStoryboardCharacterLinks(db, storyboardId, dramaCharacterIds) {
  const sid = Number(storyboardId);
  db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id = ?').run(sid);
  const ids = Array.isArray(dramaCharacterIds) ? dramaCharacterIds.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  if (ids.length === 0) return;
  const sb = db.prepare(
    `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sid);
  const dramaId = sb?.drama_id != null ? Number(sb.drama_id) : null;
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
  for (const cid of ids.slice(0, 20)) {
    const crow = db.prepare('SELECT name FROM characters WHERE id = ? AND deleted_at IS NULL').get(cid);
    const name = (crow?.name || '').trim();
    if (!name) continue;
    let lib = null;
    if (dramaId) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id = ? AND TRIM(name) = ? LIMIT 1'
      ).get(dramaId, name);
    }
    if (!lib) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id IS NULL AND TRIM(name) = ? LIMIT 1'
      ).get(name);
    }
    if (lib) ins.run(sid, lib.id, now);
  }
}

function createStoryboard(db, log, req) {
  const now = new Date().toISOString();
  const episodeId = Number(req.episode_id);
  const num = Number(req.storyboard_number ?? 0) || 0;
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, result, atmosphere, image_prompt, video_prompt, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    episodeId,
    req.scene_id ?? null,
    num,
    req.title ?? null,
    req.description ?? null,
    req.location ?? null,
    req.time ?? null,
    req.duration ?? 0,
    req.dialogue ?? null,
    req.action ?? null,
    req.result ?? null,
    req.atmosphere ?? null,
    req.image_prompt ?? null,
    req.video_prompt ?? null,
    now,
    now
  );
  log.info('Storyboard created', { id: info.lastInsertRowid, episode_id: episodeId });
  return getStoryboardById(db, info.lastInsertRowid);
}

function updateStoryboard(db, log, id, req) {
  const row = db.prepare('SELECT id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  const sbRow = db.prepare(
    `SELECT e.drama_id
     FROM storyboards s
     LEFT JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(Number(id));
  const storyboardCols = new Set((() => {
    try {
      return db.prepare('PRAGMA table_info(storyboards)').all().map((c) => c.name);
    } catch (_) {
      return [];
    }
  })());
  const allowed = ['title', 'description', 'location', 'time', 'duration', 'dialogue', 'narration', 'action', 'result', 'atmosphere', 'image_prompt', 'polished_prompt', 'video_prompt', 'scene_id', 'characters', 'composed_image', 'image_url', 'local_path', 'main_panel_idx', 'video_url', 'audio_local_path', 'narration_audio_local_path', 'status', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s', 'movement', 'segment_index', 'segment_title', 'creation_mode', 'universal_segment_text', 'layout_description', 'first_frame_image_id', 'last_frame_image_id', 'last_frame_image_url', 'last_frame_local_path', 'prompt_state', 'video_render_mode'];
  const updates = [];
  const params = [];
  let contentChanged = false;
  // 前端可能传 character_ids，与 characters 统一：存为 JSON 字符串
  const charactersValue = req.character_ids !== undefined ? req.character_ids : req.characters;
  let parsedDramaCharIdsForSync = null;
  if (charactersValue !== undefined) {
    updates.push('characters = ?');
    const jsonStr = Array.isArray(charactersValue) ? JSON.stringify(charactersValue) : (typeof charactersValue === 'string' ? charactersValue : '[]');
    params.push(jsonStr);
    parsedDramaCharIdsForSync = parseDramaCharacterIds(charactersValue) ?? [];
  }
  for (const key of allowed) {
    if (key === 'characters') continue;
    if (req[key] !== undefined) {
      updates.push(key + ' = ?');
      const val = req[key];
      params.push(val);
      if (['image_prompt', 'description', 'action', 'dialogue', 'narration', 'result', 'atmosphere', 'location', 'time', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s', 'movement', 'layout_description'].includes(key)) {
        contentChanged = true;
      }
      if (key === 'video_render_mode' && !['ai_video', 'paper_layered'].includes(String(val))) {
        throw new Error('video_render_mode 只能是 ai_video 或 paper_layered');
      }
      if (key === 'polished_prompt' && storyboardCols.has('polished_prompt_style_signature')) {
        const dramaRow = sbRow?.drama_id
          ? db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(sbRow.drama_id)
          : null;
        let signature = null;
        try {
          const styleVersionService = require('./visualStyleVersionService');
          signature = styleVersionService.ensureActiveVersion(db, Number(sbRow?.drama_id)).signature || null;
        } catch (_) {
          const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
          signature = mergeCfgStyleWithDrama({}, dramaRow || {}).style?.style_signature || null;
        }
        updates.push('polished_prompt_style_signature = ?');
        params.push(signature);
      }
    }
  }
  if (storyboardCols.has('prompt_state') && req.prompt_state === undefined) {
    if (req.polished_prompt !== undefined) {
      updates.push('prompt_state = ?');
      params.push('manual_override');
    } else if (contentChanged) {
      updates.push('prompt_state = ?');
      params.push('stale_scene');
    }
  }
  if (updates.length === 0 && req.prop_ids === undefined) return getStoryboardById(db, id);
  if (updates.length > 0) {
    params.push(new Date().toISOString(), id);
    db.prepare('UPDATE storyboards SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
    if (storyboardCols.has('video_render_mode') && (contentChanged || req.audio_local_path !== undefined || req.narration_audio_local_path !== undefined || req.duration !== undefined || req.characters !== undefined || req.props !== undefined || req.prop_ids !== undefined)) {
      try {
        const compositionRows = db.prepare('SELECT id FROM paper_compositions WHERE storyboard_id = ? AND deleted_at IS NULL').all(Number(id));
        db.prepare(`UPDATE paper_compositions SET status = CASE WHEN status = 'rendering' THEN 'rendering' ELSE 'stale' END,
          audio_timing_status = CASE WHEN audio_timing_status = 'locked' THEN 'stale' ELSE audio_timing_status END,
          audio_timing_hash = NULL, last_validation_json = '{}', last_proof_hash = NULL, updated_at = ?
          WHERE storyboard_id = ? AND deleted_at IS NULL`).run(new Date().toISOString(), Number(id));
        const removeProofs = db.prepare('DELETE FROM paper_render_proofs WHERE composition_id = ?');
        for (const composition of compositionRows) removeProofs.run(composition.id);
      } catch (_) {}
    }
  }
  // 角色勾选变更：只同步 storyboard_characters，不删除 frame_prompts。
  // 用户手动保存的首/尾帧提示词应保留；图生时 framePromptSanitize 会按当前勾选剔除未出场角色名。
  if (parsedDramaCharIdsForSync !== null) {
    try {
      syncStoryboardCharacterLinks(db, id, parsedDramaCharIdsForSync);
    } catch (e) {
      log.warn('syncStoryboardCharacterLinks failed', { id, message: e.message });
    }
  }
  // 道具关联：写入 storyboard_props 表
  if (req.prop_ids !== undefined) {
    const propIds = Array.isArray(req.prop_ids) ? req.prop_ids : [];
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(Number(id));
    const ins = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const pid of propIds) ins.run(Number(id), Number(pid));
  }
  log.info('Storyboard updated', { id });
  return getStoryboardById(db, id);
}

function deleteStoryboard(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  if (result.changes === 0) return false;
  log.info('Storyboard deleted', { id });
  return true;
}

function getStoryboardById(db, id) {
  const r = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  let characters = [];
  if (r.characters) {
    if (typeof r.characters === 'string') {
      try { characters = JSON.parse(r.characters); } catch (_) {}
    } else if (Array.isArray(r.characters)) characters = r.characters;
  }
  let propIds = [];
  try {
    const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(Number(id));
    propIds = propLinks.map((p) => p.prop_id);
  } catch (_) {}
  return {
    id: r.id,
    episode_id: r.episode_id,
    scene_id: r.scene_id,
    storyboard_number: r.storyboard_number,
    title: r.title,
    description: r.description,
    location: r.location,
    time: r.time,
    duration: r.duration ?? 0,
    dialogue: r.dialogue,
    narration: r.narration ?? null,
    action: r.action,
    result: r.result ?? null,
    atmosphere: r.atmosphere,
    image_prompt: r.image_prompt,
    polished_prompt: r.polished_prompt ?? null,
    video_prompt: r.video_prompt,
    shot_type: r.shot_type,
    angle: r.angle,
    angle_h: r.angle_h ?? null,
    angle_v: r.angle_v ?? null,
    angle_s: r.angle_s ?? null,
    movement: r.movement,
    segment_index: r.segment_index ?? 0,
    segment_title: r.segment_title ?? null,
    creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
    universal_segment_text: r.universal_segment_text ?? null,
    prompt_state: r.prompt_state || 'current',
    polished_prompt_style_signature: r.polished_prompt_style_signature || null,
    layout_description: r.layout_description ?? null,
    first_frame_image_id: r.first_frame_image_id ?? null,
    last_frame_image_id: r.last_frame_image_id ?? null,
    last_frame_image_url: r.last_frame_image_url ?? null,
    last_frame_local_path: r.last_frame_local_path ?? null,
    video_render_mode: r.video_render_mode === 'paper_layered' ? 'paper_layered' : 'ai_video',
    characters,
    prop_ids: propIds,
    composed_image: r.composed_image,
    image_url: r.image_url ?? null,
    local_path: r.local_path ?? null,
    main_panel_idx: r.main_panel_idx != null ? Number(r.main_panel_idx) : null,
    video_url: r.video_url,
    audio_local_path: r.audio_local_path ?? null,
    narration_audio_local_path: r.narration_audio_local_path ?? null,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getFramePrompts(db, storyboardId) {
  const rows = db.prepare(
    'SELECT * FROM frame_prompts WHERE storyboard_id = ? ORDER BY created_at ASC'
  ).all(Number(storyboardId));
  return rows.map((r) => ({
    id: r.id,
    storyboard_id: r.storyboard_id,
    frame_type: r.frame_type,
    prompt: r.prompt,
    description: r.description,
    layout: r.layout,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function saveFramePrompt(db, log, storyboardId, frameType, prompt, description, layout) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM frame_prompts WHERE storyboard_id = ? AND frame_type = ?').get(Number(storyboardId), frameType);
  if (existing) {
    db.prepare('UPDATE frame_prompts SET prompt = ?, description = ?, layout = ?, updated_at = ? WHERE id = ?').run(
      prompt,
      description ?? null,
      layout ?? null,
      now,
      existing.id
    );
    return getFramePrompts(db, storyboardId);
  }
  db.prepare(
    `INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(storyboardId), frameType, prompt, description ?? null, layout ?? null, now, now);
  log.info('Frame prompt saved', { storyboard_id: storyboardId, frame_type: frameType });
  return getFramePrompts(db, storyboardId);
}

/** 在指定分镜前插入一个空白分镜：先把同 episode 中 number >= target 的全部 +1，再创建新分镜 */
function insertBeforeStoryboard(db, log, targetId) {
  const target = db.prepare(
    'SELECT id, episode_id, storyboard_number, segment_index, segment_title FROM storyboards WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(targetId));
  if (!target) return null;

  db.prepare(
    'UPDATE storyboards SET storyboard_number = storyboard_number + 1, updated_at = ? WHERE episode_id = ? AND storyboard_number >= ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), target.episode_id, target.storyboard_number);

  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, segment_index, segment_title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(target.episode_id, target.storyboard_number, target.segment_index ?? null, target.segment_title ?? null, now, now);

  log.info('Storyboard inserted before', { new_id: info.lastInsertRowid, before_id: targetId });
  return getStoryboardById(db, info.lastInsertRowid);
}

module.exports = {
  createStoryboard,
  insertBeforeStoryboard,
  updateStoryboard,
  deleteStoryboard,
  getStoryboardById,
  getFramePrompts,
  saveFramePrompt,
};
