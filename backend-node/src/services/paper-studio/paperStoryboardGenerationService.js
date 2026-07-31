// P4：剧本 + 实体库 → 纸片分镜草稿（预览-应用两段式，BR-014：应用前不落库）。
// 只调文本模型，0 图片调用；每镜结构化绑定实体库 id。
const crypto = require('crypto');
const aiClient = require('../aiClient');
const { safeParseAIJSON } = require('../../utils/safeJson');
const schemaService = require('./paperStudioSchemaService');
const episodeService = require('./paperStudioEpisodeService');
const projectService = require('./paperStudioProjectService');
const scriptService = require('./paperScriptService');
const libraryService = require('./paperLibraryService');
const storyboardService = require('./paperStoryboardService');
const { PaperStudioError, nowIso } = require('./paperStudioUtils');

const MAX_SCRIPT_CHARS = 30000;
const MAX_REPAIR_ATTEMPTS = 2;

async function generateTextWithRetry(db, log, prompt, systemPrompt, options, attempts = 3, onAttempt = null) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (onAttempt) onAttempt(attempt);
      return await aiClient.generateText(db, log, 'text', prompt, systemPrompt, options);
    } catch (error) {
      lastError = error;
      const transient = /(?:EOF|502|503|504|timeout|ECONNRESET|socket hang up|upstream)/i.test(error.message || '');
      if (!transient || attempt === attempts) break;
      if (log) log.warn('Paper studio text model transient failure, retrying', { attempt, error: error.message });
      await new Promise((resolve) => { setTimeout(resolve, attempt * 1500); });
    }
  }
  throw lastError;
}


function systemPrompt(entities, targetShotCount, defaultDuration) {
  const listByType = (type, label) => {
    const items = entities.filter((item) => item.entity_type === type);
    if (!items.length) return `${label}：（无）`;
    return `${label}：${items.map((item) => `「${item.name}」`).join('、')}`;
  };
  return `你是短剧纸片动画的分镜师。请把剧本拆解为 ${targetShotCount} 个左右的分镜，输出严格 JSON（不要解释、不要 markdown 代码块）：

{
  "shots": [{
    "title": "分镜标题（10字内）",
    "description": "画面描述：谁在哪里、构图与光线，60-120字，可直接用于生成画面",
    "action": "主体动作：这一镜里主体做了什么具体动作，30-80字；纯空镜写空字符串",
    "dialogue": "本镜对白原文，无则空字符串",
    "narration": "本镜旁白，无则空字符串",
    "duration": ${defaultDuration},
    "shot_type": "远景|全景|中景|近景|特写 之一",
    "camera_motion": "固定|推近|拉远|左移|右移|上摇|下摇 之一",
    "environment_only": false,
    "scene": "本镜所在场景名，必须从下面场景清单中选",
    "characters": ["出场角色名，必须从角色清单中选"],
    "props": ["本镜关键道具名，必须从道具清单中选，没有给空数组"]
  }]
}

可用实体清单（分镜里只能引用这些名称，一字不差）：
${listByType('character', '角色')}
${listByType('scene', '场景')}
${listByType('prop', '道具')}

规则：
1. 按剧情顺序覆盖整个剧本，重要转折必须有独立分镜。
2. environment_only 为 true 时 characters 必须为空数组、action 为空字符串。
3. 每镜 duration 在 3-12 秒之间。
4. 对白照抄剧本原文，不改写。只输出 JSON。`;
}

function entityIndex(entities) {
  const index = new Map();
  const normalize = (value) => String(value || '').normalize('NFKC').trim().toLowerCase();
  for (const entity of entities) {
    index.set(`${entity.entity_type}:${normalize(entity.name)}`, entity);
    for (const alias of entity.aliases || []) index.set(`${entity.entity_type}:${normalize(alias)}`, entity);
  }
  return { index, normalize };
}

function normalizeShot(raw, order, entities, defaultDuration, warnings) {
  const title = String(raw?.title || '').trim().slice(0, 160) || `分镜 ${order}`;
  const { index, normalize } = entityIndex(entities);
  const resolve = (type, name) => {
    const entity = index.get(`${type}:${normalize(name)}`);
    if (!entity) warnings.push(`分镜「${title}」引用了不在库中的${type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'}「${name}」，已降级为纯文本`);
    return entity || null;
  };
  const scene = raw?.scene ? resolve('scene', raw.scene) : null;
  const characters = (Array.isArray(raw?.characters) ? raw.characters : []).map((name) => resolve('character', name)).filter(Boolean);
  const props = (Array.isArray(raw?.props) ? raw.props : []).map((name) => resolve('prop', name)).filter(Boolean);
  const environmentOnly = Boolean(raw?.environment_only) || characters.length === 0;
  const duration = Number(raw?.duration);
  return {
    title,
    description: String(raw?.description || '').trim().slice(0, 8000),
    action: environmentOnly ? '' : String(raw?.action || '').trim().slice(0, 8000),
    dialogue: String(raw?.dialogue || '').trim().slice(0, 8000),
    narration: String(raw?.narration || '').trim().slice(0, 8000),
    duration: Number.isFinite(duration) && duration >= 1 && duration <= 120 ? Math.round(duration * 10) / 10 : defaultDuration,
    shot_type: String(raw?.shot_type || '').trim().slice(0, 120) || null,
    camera_motion: String(raw?.camera_motion || '').trim().slice(0, 120) || null,
    environment_only: environmentOnly,
    scene_entity_id: scene?.id || null,
    scene_entity_name: scene?.name || (raw?.scene ? String(raw.scene) : null),
    character_entity_ids: characters.map((item) => item.id),
    character_entity_names: characters.map((item) => item.name),
    prop_entity_ids: props.map((item) => item.id),
    prop_entity_names: props.map((item) => item.name),
  };
}

function scanDraftIssues(shots = []) {
  return shots.flatMap((shot, index) => {
    const missingFields = [];
    if (!String(shot?.description || '').trim()) missingFields.push('description');
    if (!Boolean(shot?.environment_only) && !String(shot?.action || '').trim()) missingFields.push('action');
    if (!missingFields.length) return [];
    return [{
      shot_index: index,
      shot_number: index + 1,
      title: String(shot?.title || `分镜 ${index + 1}`),
      missing_fields: missingFields,
      environment_only: Boolean(shot?.environment_only),
    }];
  });
}

function repairSystemPrompt() {
  return `你是短剧纸片动画的分镜修复助手。只补全明确标记为缺失的字段，不得改写其他内容。

输出严格 JSON（不要解释、不要 markdown 代码块）：
{
  "repairs": [{
    "shot_number": 1,
    "description": "仅在要求补画面描述时填写，60-120字",
    "action": "仅在要求补主体动作时填写，30-80字"
  }]
}

规则：
1. 每个待修复镜头都必须返回，shot_number 与输入完全一致。
2. 主体动作要写清谁或什么对象做了什么，以及状态如何变化；地图箭头、车辆、道具和图形也可以是主体。
3. 推近、拉远、摇移等运镜不能冒充主体动作。
4. 画面描述要包含地点、主体位置、前中后景和关键构图，可直接用于生成单张参考图。
5. 不得返回未要求修复的字段，不得修改对白、旁白、时长、景别、运镜和实体绑定。`;
}

function repairUserPrompt(script, entities, shots, issues) {
  const issuePayload = issues.map((issue) => {
    const shot = shots[issue.shot_index] || {};
    return {
      shot_number: issue.shot_number,
      missing_fields: issue.missing_fields,
      title: shot.title || '',
      description: shot.description || '',
      action: shot.action || '',
      dialogue: shot.dialogue || '',
      narration: shot.narration || '',
      duration: shot.duration || 0,
      shot_type: shot.shot_type || '',
      camera_motion: shot.camera_motion || '',
      scene: shot.scene_entity_name || '',
      characters: shot.character_entity_names || [],
      props: shot.prop_entity_names || [],
    };
  });
  const entityPayload = entities.map((item) => ({ type: item.entity_type, name: item.name }));
  return `【剧本内容】\n${String(script.content || '').slice(0, MAX_SCRIPT_CHARS)}\n\n【可用实体】\n${JSON.stringify(entityPayload)}\n\n【只修复以下缺失字段】\n${JSON.stringify(issuePayload)}`;
}

function mergeRepairCandidates(shots, issues, candidates, patches) {
  const allowed = new Map(issues.map((issue) => [issue.shot_number, new Set(issue.missing_fields)]));
  let changed = false;
  for (const candidate of candidates) {
    const shotNumber = Number(candidate?.shot_number);
    const allowedFields = allowed.get(shotNumber);
    const shot = shots[shotNumber - 1];
    if (!allowedFields || !shot) continue;
    for (const field of ['description', 'action']) {
      if (!allowedFields.has(field)) continue;
      if (field === 'action' && Boolean(shot.environment_only)) continue;
      if (String(shot[field] || '').trim()) continue;
      const next = String(candidate?.[field] || '').trim().slice(0, 8000);
      if (!next) continue;
      shot[field] = next;
      patches.push({
        shot_index: shotNumber - 1,
        shot_number: shotNumber,
        title: String(shot.title || `分镜 ${shotNumber}`),
        field,
        before: '',
        after: next,
      });
      changed = true;
    }
  }
  return changed;
}

async function generate(db, cfg, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardGenerate', body, '生成纸片分镜的参数无效');
  const episode = episodeService.get(db, episodeId);
  const project = projectService.get(db, episode.project_id);
  const script = body.script_version_id
    ? scriptService.getForEpisode(db, episode.id, body.script_version_id)
    : scriptService.latest(db, episode.id);
  if (!script || !String(script.content || '').trim()) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_MISSING', '当前分集还没有已保存的剧本版本，请先保存剧本', { paper_episode_id: episode.id }, 409);
  }
  const entities = libraryService.listEntities(db, project.id).filter((item) => item.status !== 'archived');
  if (!entities.length) {
    throw new PaperStudioError('PAPER_STUDIO_LIBRARY_EMPTY', '实体库为空；请先提取并确认人物/场景/道具，分镜才能绑定实体', { project_id: project.id }, 409);
  }

  let content = String(script.content).trim();
  let truncated = false;
  if (content.length > MAX_SCRIPT_CHARS) {
    content = content.slice(0, MAX_SCRIPT_CHARS);
    truncated = true;
  }
  const targetShotCount = Number(body.target_shot_count || 0) || Math.max(4, Math.min(12, Math.round(content.length / 400)));
  const defaultDuration = Number(body.default_duration || episode.default_duration || 6);

  let responseText;
  try {
    // 输出预算按镜数收紧：每镜约 400 token，响应越短、上游中转越不容易断流
    const maxTokens = Math.max(3000, Math.min(8000, 1500 + targetShotCount * 420));
    responseText = await generateTextWithRetry(db, log, `【剧本内容】\n${content}`, systemPrompt(entities, targetShotCount, defaultDuration), {
      scene_key: 'paper_storyboard_generation',
      max_tokens: maxTokens,
      temperature: 0.4,
      deepseek_thinking: 'disabled',
    });
  } catch (error) {
    throw new PaperStudioError('PAPER_STUDIO_STORYBOARD_GENERATION_AI_FAILED', `文本模型生成分镜失败：${error.message || '未知错误'}`, { paper_episode_id: episode.id, script_id: script.id }, 502);
  }

  let parsed;
  try {
    parsed = safeParseAIJSON(responseText, log);
  } catch (_) {
    parsed = null;
  }
  const rawShots = Array.isArray(parsed?.shots) ? parsed.shots : (Array.isArray(parsed) ? parsed : null);
  if (!rawShots || !rawShots.length) {
    throw new PaperStudioError('PAPER_STUDIO_STORYBOARD_GENERATION_PARSE_FAILED', '文本模型返回的分镜 JSON 无法解析，请重试一次', { script_id: script.id }, 502);
  }

  const warnings = [];
  const shots = rawShots.slice(0, 48).map((raw, index) => normalizeShot(raw, index + 1, entities, defaultDuration, warnings));
  const issues = scanDraftIssues(shots);
  if (truncated) warnings.unshift('剧本较长，本次只分析了前 3 万字');
  if (log) log.info('Paper storyboards generated (draft)', {
    paper_episode_id: episode.id,
    script_id: script.id,
    shot_count: shots.length,
    warnings: warnings.length,
    incomplete_shots: issues.length,
  });
  return {
    script: { id: script.id, version_number: script.version_number },
    shots,
    warnings,
    issues,
  };
}

async function repair(db, cfg, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardsRepair', body, 'AI 补全分镜草稿的参数无效');
  const episode = episodeService.get(db, episodeId);
  const script = body.script_version_id
    ? scriptService.getForEpisode(db, episode.id, body.script_version_id)
    : scriptService.latest(db, episode.id);
  if (!script || !String(script.content || '').trim()) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_MISSING', '当前分集还没有可用于补全的剧本版本', { paper_episode_id: episode.id }, 409);
  }
  const entities = libraryService.listEntities(db, episode.project_id).filter((item) => item.status !== 'archived');
  const shots = body.shots.map((shot) => ({ ...shot }));
  const originalIssues = scanDraftIssues(shots);
  if (!originalIssues.length) {
    return { shots, patches: [], issues: [], repaired_shot_count: 0, text_model_calls: 0 };
  }

  const patches = [];
  let issues = originalIssues;
  let textModelCalls = 0;
  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS && issues.length; attempt += 1) {
    let responseText;
    try {
      responseText = await generateTextWithRetry(
        db,
        log,
        repairUserPrompt(script, entities, shots, issues),
        repairSystemPrompt(),
        {
          scene_key: 'paper_storyboard_repair',
          max_tokens: Math.max(1800, Math.min(6000, 800 + issues.length * 420)),
          temperature: 0.3,
          deepseek_thinking: 'disabled',
        },
        3,
        () => { textModelCalls += 1; },
      );
    } catch (error) {
      throw new PaperStudioError(
        'PAPER_STUDIO_STORYBOARD_REPAIR_AI_FAILED',
        `文本模型补全分镜失败：${error.message || '未知错误'}`,
        { paper_episode_id: episode.id, script_id: script.id, issues },
        502,
      );
    }

    let parsed;
    try {
      parsed = safeParseAIJSON(responseText, log);
    } catch (_) {
      parsed = null;
    }
    const candidates = Array.isArray(parsed?.repairs) ? parsed.repairs : (Array.isArray(parsed) ? parsed : null);
    if (!candidates?.length) {
      lastFailure = '模型没有返回可识别的 repairs 数组';
      continue;
    }
    const changed = mergeRepairCandidates(shots, issues, candidates, patches);
    issues = scanDraftIssues(shots);
    if (!changed) lastFailure = '模型返回的补全内容仍为空或镜头编号不匹配';
  }

  if (!patches.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STORYBOARD_REPAIR_INCOMPLETE',
      'AI 没有生成可用的补全内容，请重试或手动填写',
      { issues, reason: lastFailure, text_model_calls: textModelCalls },
      422,
    );
  }
  if (log) log.info('Paper storyboards repaired (preview)', {
    paper_episode_id: episode.id,
    script_id: script.id,
    repaired_shots: new Set(patches.map((item) => item.shot_number)).size,
    repaired_fields: patches.length,
    remaining_issues: issues.length,
    text_model_calls: textModelCalls,
  });
  return {
    script: { id: script.id, version_number: script.version_number },
    shots,
    patches,
    issues,
    repaired_shot_count: new Set(patches.map((item) => item.shot_number)).size,
    text_model_calls: textModelCalls,
  };
}

function apply(db, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperStoryboardsApply', body, '应用生成分镜的参数无效');
  const episode = episodeService.get(db, episodeId);
  const issues = scanDraftIssues(body.shots);
  if (issues.length) {
    throw new PaperStudioError(
      'PAPER_STUDIO_STORYBOARD_INCOMPLETE',
      `还有 ${issues.length} 个分镜缺少画面描述或主体动作，不能应用`,
      { storyboards: issues },
      409,
    );
  }
  const now = nowIso();
  const replaced = { count: 0 };
  const created = [];

  const transaction = db.transaction(() => {
    if (body.mode === 'replace') {
      const rows = db.prepare(
        'SELECT id FROM paper_storyboards WHERE paper_episode_id = ? AND deleted_at IS NULL AND published_video_generation_id IS NULL',
      ).all(episode.id);
      for (const row of rows) {
        db.prepare('UPDATE paper_storyboards SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(now, now, Number(row.id));
        replaced.count += 1;
      }
    }
    for (const shot of body.shots) {
      const result = storyboardService.create(db, log, episode.id, {
        request_id: crypto.randomUUID(),
        title: shot.title,
        description: shot.description || '',
        action: shot.action || '',
        dialogue: shot.dialogue || '',
        narration: shot.narration || '',
        duration: Number(shot.duration || episode.default_duration || 6),
        shot_type: shot.shot_type || null,
        camera_motion: shot.camera_motion || null,
        environment_only: Boolean(shot.environment_only),
        source_kind: 'paper',
      });
      const storyboardId = Number(result.storyboard.id);
      const links = [
        ...(shot.scene_entity_id ? [{ entity_id: Number(shot.scene_entity_id), role: 'scene', sort: 0 }] : []),
        ...((shot.character_entity_ids || []).map((id, index) => ({ entity_id: Number(id), role: 'subject', sort: index }))),
        ...((shot.prop_entity_ids || []).map((id, index) => ({ entity_id: Number(id), role: 'static_prop', sort: index }))),
      ];
      for (const link of links) {
        const entity = libraryService.getEntity(db, link.entity_id);
        if (entity.project_id !== episode.project_id) {
          throw new PaperStudioError('PAPER_STUDIO_LIBRARY_ENTITY_MISMATCH', '分镜绑定的实体不属于当前项目', { entity_id: entity.id }, 409);
        }
        db.prepare(
          `INSERT OR IGNORE INTO paper_storyboard_entity_links
             (paper_storyboard_id, entity_id, role, binding_json, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, ?)`,
        ).run(storyboardId, entity.id, link.role, link.sort, now, now);
      }
      created.push(storyboardId);
    }
  });
  transaction();

  if (log) log.info('Paper storyboards applied', { paper_episode_id: episode.id, created: created.length, replaced: replaced.count, mode: body.mode });
  return {
    created_count: created.length,
    replaced_count: replaced.count,
    storyboards: storyboardService.list(db, episode.id),
  };
}

function listEntityLinks(db, storyboardId) {
  return db.prepare(
    `SELECT link.*, ple.name AS entity_name, ple.entity_type
     FROM paper_storyboard_entity_links link
     JOIN paper_library_entities ple ON ple.id = link.entity_id
     WHERE link.paper_storyboard_id = ? AND ple.deleted_at IS NULL
     ORDER BY CASE link.role WHEN 'scene' THEN 0 WHEN 'subject' THEN 1 ELSE 2 END, link.sort_order, link.id`,
  ).all(Number(storyboardId)).map((row) => ({
    id: Number(row.id),
    entity_id: Number(row.entity_id),
    role: row.role,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
  }));
}

module.exports = { generate, repair, apply, listEntityLinks, scanDraftIssues, MAX_SCRIPT_CHARS };
