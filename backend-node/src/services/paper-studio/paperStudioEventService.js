const { nowIso, parseJson } = require('./paperStudioUtils');

function record(db, {
  runId,
  shotId = null,
  eventType,
  severity = 'info',
  title,
  message = '',
  recoveryActions = [],
  details = {},
}) {
  if (!runId || !eventType || !title) return null;
  const result = db.prepare(
    `INSERT INTO paper_studio_events
      (run_id, shot_id, event_type, severity, title, message,
       recovery_actions_json, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Number(runId), shotId == null ? null : Number(shotId), eventType, severity,
    title, message, JSON.stringify(recoveryActions), JSON.stringify(details), nowIso(),
  );
  return Number(result.lastInsertRowid);
}

function list(db, runId, { limit = 100 } = {}) {
  return db.prepare(
    `SELECT * FROM paper_studio_events
     WHERE run_id = ?
     ORDER BY id DESC LIMIT ?`,
  ).all(Number(runId), Math.max(1, Math.min(500, Number(limit) || 100))).map((row) => ({
    ...row,
    id: Number(row.id),
    run_id: Number(row.run_id),
    shot_id: row.shot_id == null ? null : Number(row.shot_id),
    recovery_actions_json: parseJson(row.recovery_actions_json, []),
    details_json: parseJson(row.details_json, {}),
  }));
}

module.exports = { record, list };
