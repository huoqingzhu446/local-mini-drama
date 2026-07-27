const { randomUUID } = require('crypto');
const projectService = require('./paperStudioProjectService');
const episodeService = require('./paperStudioEpisodeService');
const storyboardService = require('./paperStoryboardService');
const schemaService = require('./paperStudioSchemaService');
const { PaperStudioError } = require('./paperStudioUtils');

const EXAMPLE_STORYBOARDS = Object.freeze([
  {
    title: '收到来信',
    description: '傍晚的纸艺书房里，主角站在木桌前，桌上放着一封带红色封印的信。',
    action: '主角伸手拿起信封，拆开封印并低头阅读。',
    narration: '一封没有署名的信，改变了这个平静的傍晚。',
    duration: 6,
    shot_type: '中景',
    camera_motion: '静态机位',
  },
  {
    title: '穿过街巷',
    description: '暖色路灯照亮层叠的纸片街巷，主角手持信件站在画面左侧。',
    action: '主角从左向右快步穿过街巷，信件始终跟随手部移动。',
    narration: '信里的线索，把他引向城市的另一端。',
    duration: 6,
    shot_type: '全景',
    camera_motion: '轻微横向跟随',
  },
  {
    title: '发现线索',
    description: '安静的旧车站候车区，长椅下露出一只折纸小鸟，主角停在长椅旁。',
    action: '主角蹲下拾起折纸小鸟，展开后发现藏在里面的第二张纸条。',
    narration: '第二条线索，藏在一只被遗忘的纸鸟里。',
    duration: 6,
    shot_type: '中近景',
    camera_motion: '缓慢推近',
  },
  {
    title: '递出答案',
    description: '清晨的纸艺广场上，主角与等待的人隔着几步相对站立，晨光从建筑之间落下。',
    action: '主角走向等待的人并递出信件，对方接过信后两人相视点头。',
    dialogue: '我想，这封信应该交给你。',
    duration: 6,
    shot_type: '双人中景',
    camera_motion: '静态机位',
  },
]);

function create(db, log, projectId, body = {}) {
  schemaService.assertValid('apiPaperExampleDraft', body, '创建示例草稿的参数无效');
  const project = projectService.get(db, projectId);
  const existing = db.prepare(
    'SELECT id FROM paper_studio_episodes WHERE project_id = ? AND request_id = ? AND deleted_at IS NULL',
  ).get(Number(project.id), body.request_id);
  if (existing) {
    return {
      episode: episodeService.get(db, existing.id),
      storyboards: storyboardService.list(db, existing.id),
      created: false,
      deduplicated: true,
      external_image_calls: 0,
      run_created: false,
    };
  }
  const episodeCount = Number(db.prepare(
    'SELECT COUNT(*) AS count FROM paper_studio_episodes WHERE project_id = ? AND deleted_at IS NULL',
  ).get(Number(project.id))?.count || 0);
  if (episodeCount > 0) {
    throw new PaperStudioError(
      'PAPER_EXAMPLE_DRAFT_REQUIRES_EMPTY_PROJECT',
      '示例草稿只用于首次空项目；当前项目已有纸片分集',
      { project_id: Number(project.id), episode_count: episodeCount },
      409,
    );
  }

  let episode;
  let storyboards;
  db.transaction(() => {
    episode = episodeService.create(db, log, project.id, {
      request_id: body.request_id,
      title: '示例故事：未署名的信',
      description: '四镜通用纸片动画草稿。可以直接改写，不包含任何生产版本或图片调用。',
      aspect_ratio: '16:9',
      fps: Number(project.config_json?.fps || 30),
      default_duration: 6,
    }).episode;
    for (const item of EXAMPLE_STORYBOARDS) {
      storyboardService.create(db, log, episode.id, {
        request_id: randomUUID(),
        ...item,
        visual_prompt: '层叠手工纸张、可见纸纤维、清晰主体轮廓、适合拆分为背景与独立角色道具层',
        negative_prompt: '分格漫画、拼图、文字、水印、标志',
        source_kind: 'paper',
      });
    }
    storyboards = storyboardService.list(db, episode.id);
  })();
  episode = episodeService.get(db, episode.id);

  if (log) log.info('Paper studio example draft created', {
    project_id: Number(project.id), paper_episode_id: Number(episode.id), storyboard_count: storyboards.length,
  });
  return {
    episode,
    storyboards,
    created: true,
    deduplicated: false,
    external_image_calls: 0,
    run_created: false,
  };
}

module.exports = { EXAMPLE_STORYBOARDS, create };
