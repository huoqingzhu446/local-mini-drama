// P2：剧本 → 候选实体（人物/场景/道具）提取。
// 只调文本模型，0 图片调用；结果不落库（BR-014），由用户在确认面板逐项决定后走 paperLibraryService.confirm 写入。
const aiClient = require('../aiClient');
const { safeParseAIJSON } = require('../../utils/safeJson');
const schemaService = require('./paperStudioSchemaService');
const episodeService = require('./paperStudioEpisodeService');
const projectService = require('./paperStudioProjectService');
const scriptService = require('./paperScriptService');
const libraryService = require('./paperLibraryService');
const { PaperStudioError } = require('./paperStudioUtils');

const MAX_SCRIPT_CHARS = 30000;

async function generateTextWithRetry(db, log, prompt, systemPrompt, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
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


const SYSTEM_PROMPT = `你是短剧纸片动画的前期美术统筹。请从给定剧本中提取三类实体，输出严格 JSON（不要任何解释文字、不要 markdown 代码块）：

{
  "characters": [{ "name": "角色名", "description": "120-200字的完整人物设定描述", "aliases": ["剧本中出现的别称"], "relative_height": 1.0 }],
  "scenes": [{ "name": "场景名", "description": "80-150字的场景画面描述", "aliases": [] }],
  "props": [{ "name": "道具名", "description": "50-100字的道具画面描述", "aliases": [], "relative_height": 0.3 }]
}

人物 description 必须覆盖（按顺序写全，这是后续生成角色立绘的唯一依据）：
- 年龄段与体型（身高印象、壮硕/清瘦等）
- 发型与冠帽（样式、颜色、材质）
- 面部特征与神态（脸型、胡须、眉眼、气质）
- 服装从内到外：材质、主色与配色、纹样、结构、鞋帽与必要的防护装备
- 标志性配饰与剧情要求的随身物品

题材一致性要求（非常重要）：
- 只根据剧本明确出现的时代、地域、职业和世界观选择服饰、装备与建筑，不得擅自加入战争、历史、奇幻、科幻或现代元素；
- 剧本涉及真实历史人物或明确朝代时才启用历史考据，并贴近该时期的可靠形象；
- 现代、架空或其他题材依据剧本线索合理设定，保持全剧世界观统一。

场景 description 要写：空间结构与地貌、符合题材的建筑和陈设、时间与天气、光线方向与氛围色调。
道具 description 要写：形制、材质、颜色、磨损与细节，符合时代考据。

规则：
1. 只提取对画面有意义的实体：有戏份的角色、发生剧情的场景、被角色使用或推动剧情的道具；一句带过的背景元素不要提取。
2. name 用剧本原文的主要称呼；同一实体的其他称呼放进 aliases。
3. description 是纯视觉描述，可直接用于生成图片，不写剧情、不写心理。
4. relative_height 是相对成年男性身高(=1.0)的比例：儿童约0.6，道具如茶杯0.05、长剑0.7；场景不需要该字段。
5. 每类最多 12 个；没有就给空数组。只输出 JSON。`;

function normalizeName(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function normalizeCandidate(raw, entityType) {
  const name = String(raw?.name || '').trim().slice(0, 120);
  if (!name) return null;
  const aliases = Array.isArray(raw?.aliases)
    ? [...new Set(raw.aliases.map((item) => String(item || '').trim()).filter((item) => item && item !== name))].slice(0, 8)
    : [];
  const relativeHeight = Number(raw?.relative_height);
  return {
    entity_type: entityType,
    name,
    description: String(raw?.description || '').trim().slice(0, 2000),
    aliases,
    relative_height: entityType !== 'scene' && Number.isFinite(relativeHeight) && relativeHeight > 0 && relativeHeight <= 3
      ? Math.round(relativeHeight * 100) / 100
      : null,
  };
}

function attachSuggestions(candidates, existingEntities) {
  const index = new Map();
  for (const entity of existingEntities) {
    index.set(`${entity.entity_type}:${normalizeName(entity.name)}`, entity);
    for (const alias of entity.aliases || []) {
      const key = `${entity.entity_type}:${normalizeName(alias)}`;
      if (!index.has(key)) index.set(key, entity);
    }
  }
  return candidates.map((candidate) => {
    const hit = index.get(`${candidate.entity_type}:${normalizeName(candidate.name)}`)
      || candidate.aliases.map((alias) => index.get(`${candidate.entity_type}:${normalizeName(alias)}`)).find(Boolean)
      || null;
    return {
      ...candidate,
      suggested_action: hit ? 'merge' : 'new',
      merge_into_id: hit ? hit.id : null,
      merge_into_name: hit ? hit.name : null,
    };
  });
}

async function extract(db, cfg, log, episodeId, body = {}) {
  schemaService.assertValid('apiPaperEntityExtract', body, '提取实体的参数无效');
  const episode = episodeService.get(db, episodeId);
  const project = projectService.get(db, episode.project_id);
  const script = body.script_version_id
    ? scriptService.getForEpisode(db, episode.id, body.script_version_id)
    : scriptService.latest(db, episode.id);
  if (!script || !String(script.content || '').trim()) {
    throw new PaperStudioError('PAPER_STUDIO_SCRIPT_MISSING', '当前分集还没有已保存的剧本版本，请先保存剧本', { paper_episode_id: episode.id }, 409);
  }

  let content = String(script.content).trim();
  let truncated = false;
  if (content.length > MAX_SCRIPT_CHARS) {
    content = content.slice(0, MAX_SCRIPT_CHARS);
    truncated = true;
  }

  let responseText;
  try {
    responseText = await generateTextWithRetry(db, log, `【剧本内容】\n${content}`, SYSTEM_PROMPT, {
      scene_key: 'paper_entity_extraction',
      max_tokens: 6000,
      temperature: 0.3,
      deepseek_thinking: 'disabled',
    });
  } catch (error) {
    throw new PaperStudioError('PAPER_STUDIO_ENTITY_EXTRACTION_AI_FAILED', `文本模型提取失败：${error.message || '未知错误'}`, { paper_episode_id: episode.id, script_id: script.id }, 502);
  }

  let parsed;
  try {
    parsed = safeParseAIJSON(responseText, log);
  } catch (_) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaperStudioError('PAPER_STUDIO_ENTITY_EXTRACTION_PARSE_FAILED', '文本模型返回的不是合法 JSON，请重试一次', { script_id: script.id }, 502);
  }

  const candidates = [
    ...(Array.isArray(parsed.characters) ? parsed.characters : []).map((item) => normalizeCandidate(item, 'character')),
    ...(Array.isArray(parsed.scenes) ? parsed.scenes : []).map((item) => normalizeCandidate(item, 'scene')),
    ...(Array.isArray(parsed.props) ? parsed.props : []).map((item) => normalizeCandidate(item, 'prop')),
  ].filter(Boolean);
  if (!candidates.length) {
    throw new PaperStudioError('PAPER_STUDIO_ENTITY_EXTRACTION_EMPTY', '没有提取到任何实体；可以补充剧本细节后重试', { script_id: script.id }, 422);
  }

  const existing = libraryService.listEntities(db, project.id);
  const enriched = attachSuggestions(candidates, existing);
  if (log) log.info('Paper studio entities extracted', { project_id: project.id, paper_episode_id: episode.id, script_id: script.id, candidate_count: enriched.length, truncated });

  return {
    script: { id: script.id, version_number: script.version_number },
    truncated,
    candidates: enriched,
  };
}

module.exports = { extract, SYSTEM_PROMPT, MAX_SCRIPT_CHARS };
