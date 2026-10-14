'use strict';

/**
 * Outgoing message status progression. Meta can deliver status webhooks late, twice or out of order
 * (e.g. "delivered" after "read"); a status may only move a message forward.
 *   queued < sent < delivered < read < played   ("played": first play of a voice message)
 *   failed: only replaces queued/sent (a delivered/read message cannot become failed later).
 */
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3, played: 4 };
const KNOWN = new Set([...Object.keys(RANK), 'failed']);

function isKnownStatus(status) {
  return KNOWN.has(status);
}

/** Statuses a message may currently have for `next` to be applied (null/missing is always allowed). */
function allowedPreviousStatuses(next) {
  if (next === 'failed') return ['queued', 'sent', 'failed'];
  const rank = RANK[next];
  if (rank == null) return [];
  return Object.keys(RANK).filter((s) => RANK[s] < rank).concat(['failed', next]);
}

function canApply(current, next) {
  if (!isKnownStatus(next)) return false;
  if (current == null || current === '') return true;
  return allowedPreviousStatuses(next).includes(current);
}

/** Mongo filter part: the message's current status allows `next`. */
function statusGuard(next) {
  return { $or: [{ status: { $in: allowedPreviousStatuses(next) } }, { status: null }, { status: { $exists: false } }] };
}

module.exports = { RANK, isKnownStatus, allowedPreviousStatuses, canApply, statusGuard };
