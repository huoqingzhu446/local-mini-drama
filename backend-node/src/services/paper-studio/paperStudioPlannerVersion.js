// Version 9 keeps v8 entity/spatial safeguards and adds explicit visual-scene
// groups, transition contracts, per-scene environments, and continuity gates.
const CURRENT_PLANNER_VERSION = 9;

function isCurrentPlannerVersion(summary = {}) {
  return Number(summary?.planner_version || 0) === CURRENT_PLANNER_VERSION;
}

module.exports = { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion };
