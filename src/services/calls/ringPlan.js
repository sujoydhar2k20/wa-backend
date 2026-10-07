'use strict';

const CALL_ROLES = new Set(['admin', 'superadmin', 'staff']);
const DEFAULT_TIMINGS = { assignedMs: 25000, allMs: 25000 };

/**
 * Decide who rings and for how long.
 *  stage 1 "assigned": the staff member the chat is assigned to (only if online)
 *  stage 2 "all":      every online admin/staff (including the assigned one, whose ring simply continues)
 * Stages with nobody to ring are skipped. An empty plan means nobody is online -> missed call.
 *
 * @param {object} p
 * @param {string|null} p.assignedTo   user id of the assigned staff member
 * @param {Array<{id:string, role:string, isActive?:boolean, isDnd?:boolean}>} p.onlineUsers  users currently connected
 */
function buildRingPlan({ assignedTo, onlineUsers, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  const eligible = (onlineUsers || []).filter(
    (u) => u && CALL_ROLES.has(u.role) && u.isActive !== false
  );
  const eligibleIds = eligible.map((u) => String(u.id));
  const assigned = assignedTo ? String(assignedTo) : null;

  const plan = [];
  if (assigned && eligibleIds.includes(assigned)) {
    plan.push({ stage: 'assigned', userIds: [assigned], durationMs: t.assignedMs });
  }
  const skipAll = plan.length === 1 && eligibleIds.length === 1; // only the assigned user is online
  if (eligibleIds.length > 0 && !skipAll) {
    plan.push({ stage: 'all', userIds: eligibleIds, durationMs: t.allMs });
  } else if (plan.length === 1 && skipAll) {
    // Assigned is the only person online: give them the full window (both stages back to back).
    plan[0].durationMs = t.assignedMs + t.allMs;
  }
  return plan;
}

/** Total time the call may ring; must stay below Meta's answer window (documented as ~30-60 s). */
function totalRingMs(plan) {
  return plan.reduce((sum, s) => sum + s.durationMs, 0);
}

module.exports = { buildRingPlan, totalRingMs, DEFAULT_TIMINGS, CALL_ROLES };
