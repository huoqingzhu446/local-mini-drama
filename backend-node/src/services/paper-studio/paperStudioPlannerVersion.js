// Version 11 keeps v10 mobility safeguards and makes recorded speech the
// bidirectional timing authority, preventing long silent action tails.
const CURRENT_PLANNER_VERSION = 11;

function isCurrentPlannerVersion(summary = {}) {
  return Number(summary?.planner_version || 0) === CURRENT_PLANNER_VERSION;
}

module.exports = { CURRENT_PLANNER_VERSION, isCurrentPlannerVersion };
