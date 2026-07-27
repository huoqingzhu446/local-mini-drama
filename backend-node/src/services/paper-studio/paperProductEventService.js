const projectService = require('./paperStudioProjectService');
const { PaperStudioError, nowIso } = require('./paperStudioUtils');

const EVENT_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const ALLOWED_CONTEXT_KEYS = new Set([
  'surface', 'action', 'source', 'stage', 'state', 'category', 'outcome',
  'reason_code', 'entry_point', 'destination', 'run_status', 'shot_status',
  'resumed', 'has_audio', 'has_subtitle', 'item_count', 'ready_count',
  'total_count', 'estimated_calls', 'generated_versions', 'adopted_versions',
  'duration_seconds',
]);

function optionalId(value) {
  return value == null || value === '' ? null : Number(value);
}

function record(db, projectId, body = {}) {
  const project = projectService.get(db, projectId);
  const eventName = String(body.event_name || '').trim();
  if (!EVENT_PATTERN.test(eventName)) {
    throw new PaperStudioError('PAPER_PRODUCT_EVENT_INVALID', '产品事件名称无效', { event_name: eventName }, 400);
  }
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? body.context
    : {};
  // UI analytics intentionally excludes free-form prompts, credentials and
  // media. A strict allow-list is safer than trying to identify every possible
  // secret-bearing key after it has already reached this boundary.
  const safeContext = Object.fromEntries(Object.entries(context)
    .filter(([key, value]) => ALLOWED_CONTEXT_KEYS.has(key)
      && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 20)
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 120) : value]));
  const result = db.prepare(
    `INSERT INTO paper_studio_product_events
      (project_id, paper_episode_id, paper_storyboard_id, run_id, shot_id, event_name, context_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Number(project.id),
    optionalId(body.paper_episode_id),
    optionalId(body.paper_storyboard_id),
    optionalId(body.run_id),
    optionalId(body.shot_id),
    eventName,
    JSON.stringify(safeContext),
    nowIso(),
  );
  return { id: Number(result.lastInsertRowid), event_name: eventName, recorded: true };
}

module.exports = { record };
