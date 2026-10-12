'use strict';

/**
 * Bulk random assignment of UNASSIGNED chats to eligible staff.
 *
 * Eligibility (same rule the app already uses for auto-assignment in webhook.service /
 * chat.service): User.role === 'staff', isActive, and assignedWabaId === the chat's WABA.
 * Monthly-tagged chats are skipped unless the actor is a superadmin (same rule as /assign).
 *
 * Distribution: chats are shuffled and dealt round-robin over a shuffled staff list, so each
 * eligible staff member receives floor(n/k) or ceil(n/k) chats (e.g. 100 chats / 5 staff = 20
 * each) while *which* chat goes to *whom* is random.
 *
 * Safety: every write is a compare-and-set (`{_id, assignedTo: null}` -> `$set assignedTo`),
 * so a chat claimed by someone else meanwhile is never overwritten (counted as skipped).
 * Only `assignedTo` is written; collaborators, tags, timestamps are never touched.
 */

const DEFAULT_MAX_CHATS = 10000;
const WRITE_CONCURRENCY = 25;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

let inFlight = false;
const recentResults = new Map(); // `${actorId}:${requestId}` -> { at, result }

class BulkAssignError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BulkAssignError';
    this.code = code;
    this.status = status;
  }
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pure: deal chat ids over staff ids as evenly as possible, randomly. Returns [{chatId, staffId}]. */
function distribute(chatIds, staffIds, rng = Math.random) {
  if (!staffIds.length) return [];
  const staff = shuffle(staffIds, rng);
  return shuffle(chatIds, rng).map((chatId, i) => ({ chatId, staffId: staff[i % staff.length] }));
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      await worker(items[my], my);
    }
  });
  await Promise.all(runners);
}

/**
 * @param {object} deps    { Chat, User, ChatActivity, getMonthlyTagId, logger }
 * @param {object} params  { actor, filter, dryRun, expectedCount, requestId, rng }
 */
async function bulkAssignRandom(deps, params) {
  const { Chat, User, ChatActivity, getMonthlyTagId, logger } = deps;
  const { actor, filter = {}, dryRun = false, expectedCount, requestId, rng = Math.random } = params;

  if (!actor || !['admin', 'superadmin'].includes(actor.role)) {
    throw new BulkAssignError('FORBIDDEN', 'Only admins can bulk-assign chats.', 403);
  }

  const cacheKey = requestId ? `${actor._id}:${requestId}` : null;
  if (!dryRun && cacheKey) {
    const now = Date.now();
    for (const [k, v] of recentResults) if (now - v.at > IDEMPOTENCY_TTL_MS) recentResults.delete(k);
    const prior = recentResults.get(cacheKey);
    if (prior) return { ...prior.result, duplicateRequest: true };
  }

  if (!dryRun) {
    if (inFlight) throw new BulkAssignError('ALREADY_RUNNING', 'A bulk assignment is already running. Please wait for it to finish.', 409);
    inFlight = true;
  }

  try {
    // ----- eligible staff, grouped by WABA
    const staff = await User.find({ role: 'staff', isActive: true, assignedWabaId: { $ne: null } })
      .select('_id name assignedWabaId').lean();
    const staffByWaba = new Map();
    for (const s of staff) {
      const k = String(s.assignedWabaId);
      if (!staffByWaba.has(k)) staffByWaba.set(k, []);
      staffByWaba.get(k).push(s);
    }
    const nameById = new Map(staff.map((s) => [String(s._id), s.name]));

    // ----- candidate chats: genuinely unassigned right now, honouring the visible filter
    const conditions = [{ ...filter }, { assignedTo: null }];
    if (actor.role !== 'superadmin') {
      const monthlyTagId = await getMonthlyTagId();
      if (monthlyTagId) conditions.push({ tags: { $ne: monthlyTagId } });
    }
    const cap = Math.min(
      Number.isInteger(expectedCount) && expectedCount > 0 ? expectedCount : DEFAULT_MAX_CHATS,
      DEFAULT_MAX_CHATS
    );
    const query = { $and: conditions };
    const [candidates, totalUnassigned] = await Promise.all([
      Chat.find(query).select('_id wabaId').sort({ _id: 1 }).limit(cap).lean(),
      Chat.countDocuments(query),
    ]);

    const byWaba = new Map();
    for (const c of candidates) {
      const k = String(c.wabaId);
      if (!byWaba.has(k)) byWaba.set(k, []);
      byWaba.get(k).push(String(c._id));
    }

    let assignable = 0;
    let noStaffCount = 0;
    const eligibleStaffIds = new Set();
    for (const [wabaId, ids] of byWaba) {
      const st = staffByWaba.get(wabaId) || [];
      if (!st.length) noStaffCount += ids.length;
      else { assignable += ids.length; st.forEach((s) => eligibleStaffIds.add(String(s._id))); }
    }
    const eligibleStaff = [...eligibleStaffIds].map((id) => ({ _id: id, name: nameById.get(id) }));

    const preview = {
      candidateCount: candidates.length,
      totalUnassigned,
      assignableCount: assignable,
      noEligibleStaffCount: noStaffCount,
      eligibleStaffCount: eligibleStaff.length,
      eligibleStaff,
    };
    if (dryRun) return preview;

    if (candidates.length === 0) throw new BulkAssignError('NO_CHATS', 'There are no unassigned chats to assign.', 409);
    if (assignable === 0) {
      throw new BulkAssignError('NO_ELIGIBLE_STAFF', 'No eligible staff members are available for these chats. Nothing was changed.', 409);
    }

    // ----- plan
    const plan = [];
    for (const [wabaId, ids] of byWaba) {
      const st = (staffByWaba.get(wabaId) || []).map((s) => String(s._id));
      plan.push(...distribute(ids, st, rng));
    }

    // ----- apply (compare-and-set, never overwrite)
    const succeeded = [];
    let skippedConcurrent = 0;
    let failed = 0;
    await runWithConcurrency(plan, WRITE_CONCURRENCY, async ({ chatId, staffId }) => {
      try {
        const r = await Chat.updateOne({ _id: chatId, assignedTo: null }, { $set: { assignedTo: staffId } });
        const modified = r.modifiedCount ?? r.nModified ?? 0;
        if (modified === 1) succeeded.push({ chatId, staffId });
        else skippedConcurrent++;
      } catch (err) {
        failed++;
        logger.warn(`bulk-assign: chat ${chatId} failed: ${err.message}`);
      }
    });

    // ----- audit trail (existing ChatActivity mechanism)
    if (succeeded.length) {
      try {
        await ChatActivity.insertMany(
          succeeded.map(({ chatId, staffId }) => ({
            chatId,
            type: 'assigned',
            performedBy: actor._id,
            details: { assignedTo: staffId, reason: 'bulk_random' },
          })),
          { ordered: false }
        );
      } catch (err) {
        logger.error(`bulk-assign: audit insert failed (assignments were applied): ${err.message}`);
      }
    }

    const perStaffMap = new Map();
    for (const { staffId } of succeeded) perStaffMap.set(staffId, (perStaffMap.get(staffId) || 0) + 1);
    const perStaff = [...perStaffMap].map(([id, count]) => ({ staffId: id, name: nameById.get(id), count }))
      .sort((a, b) => b.count - a.count);

    const result = {
      requested: candidates.length,
      assigned: succeeded.length,
      skippedConcurrent,
      failed,
      noEligibleStaff: noStaffCount,
      remaining: Math.max(totalUnassigned - succeeded.length, 0),
      perStaff,
    };
    logger.info(`bulk-assign by ${actor._id}: assigned=${result.assigned} skipped=${skippedConcurrent} failed=${failed} noStaff=${noStaffCount}`);

    if (cacheKey) recentResults.set(cacheKey, { at: Date.now(), result });
    return result;
  } finally {
    if (!dryRun) inFlight = false;
  }
}

module.exports = { bulkAssignRandom, distribute, shuffle, BulkAssignError, DEFAULT_MAX_CHATS };
