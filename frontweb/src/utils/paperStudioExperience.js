const CONTEXT_VERSION = 1
const VALID_STAGES = new Set(['authoring', 'delivery', 'production'])

function positiveId(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

export function paperStudioContextKey(dramaId) {
  return `local-mini-drama:paper-studio:${positiveId(dramaId) || 'unknown'}:context`
}

export function paperStudioOnboardingKey(dramaId) {
  return `local-mini-drama:paper-studio:${positiveId(dramaId) || 'unknown'}:onboarding-seen`
}

export function normalizePaperStudioContext(value = {}) {
  const stage = VALID_STAGES.has(value.stage) ? value.stage : 'authoring'
  return {
    version: CONTEXT_VERSION,
    paper_episode_id: positiveId(value.paper_episode_id),
    paper_storyboard_id: positiveId(value.paper_storyboard_id),
    run_id: positiveId(value.run_id),
    shot_id: positiveId(value.shot_id),
    stage,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date().toISOString(),
  }
}

export function loadPaperStudioContext(storage, dramaId) {
  if (!storage) return null
  try {
    const raw = storage.getItem(paperStudioContextKey(dramaId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (Number(parsed?.version) !== CONTEXT_VERSION) return null
    const context = normalizePaperStudioContext(parsed)
    return context.paper_episode_id || context.paper_storyboard_id || context.run_id ? context : null
  } catch (_) {
    return null
  }
}

export function savePaperStudioContext(storage, dramaId, value = {}) {
  if (!storage) return null
  const context = normalizePaperStudioContext({ ...value, updated_at: new Date().toISOString() })
  try {
    storage.setItem(paperStudioContextKey(dramaId), JSON.stringify(context))
    return context
  } catch (_) {
    return null
  }
}

export function hasExplicitPaperRoute(query = {}) {
  return Boolean(query.paper_episode || query.episode || query.storyboard || query.run || query.shot || query.stage)
}

export function buildPaperRestoreLabel(context, lookup = {}) {
  if (!context) return ''
  const parts = []
  if (lookup.episodeTitle) parts.push(lookup.episodeTitle)
  if (context.run_id) parts.push(lookup.runLabel || `生产版本 #${context.run_id}`)
  else if (lookup.storyboardTitle) parts.push(lookup.storyboardTitle)
  if (context.shot_id && lookup.shotLabel) parts.push(lookup.shotLabel)
  parts.push({ authoring: '分镜创作', delivery: '分集交付', production: '正式制作' }[context.stage])
  return parts.filter(Boolean).join(' · ')
}
