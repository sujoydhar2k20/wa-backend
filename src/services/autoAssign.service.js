'use strict';

/**
 * Automatic assignment of an incoming customer conversation to ONE randomly chosen eligible staff
 * member. Called by webhook.service for every stored inbound customer message (incl. replies to
 * broadcasts, whose chat already exists because the broadcast created it).
 *
 * Rules
 *  - Customers tagged "monthly" (chat tag or contact tag, read from the database) are never touched
 *    here: their existing handling (manual / superadmin-only assignment) stays as it was. If the tag
 *    check itself fails, nothing is assigned (fail closed), so a monthly customer is never assigned
 *    because of a database hiccup.
 *  - A chat "needs an assignment" when it has no assignee, or its assignee no longer exists or has
 *    been deactivated. A chat assigned to an existing, active user (staff, admin or superadmin, e.g. a
 *    manual assignment) is never changed.
 *  - Eligible staff = the same rule the app already uses for auto-assignment and transfers
 *    (chat.service, bulkAssign.service): role "staff", isActive, assignedWabaId === the chat's WABA.
 *  - Choice is uniformly random among eligible staff.
 *  - No eligible staff: the chat stays unassigned (admins are notified as before); never an error.
 *  - The write is a compare-and-set on the value we saw (`{_id, assignedTo: <seen>}`), so concurrent
 *    messages from the same customer, webhook retries and a manual assignment made at the same moment
 *    can never produce two different assignees or overwrite each other: the first writer wins and
 *    everyone else adopts the stored value.
 *  - Only `assignedTo` is written. Never throws: a failure here must not stop message processing.
 */

const mongoose = require('mongoose');
const { Chat, User, ChatActivity } = require('../models');
const { isMonthly } = require('../utils/tag');
const { logger } = require('../utils/logger');

const sid = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/** Mongo filter for staff who may receive automatically assigned chats of a WABA. */
function eligibleStaffFilter(wabaId) {
  return { role: 'staff', isActive: true, assignedWabaId: wabaId };
}

/** Pure: uniform random pick; null for an empty list. */
function pickRandom(list, rng = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  return list[i];
}

/**
 * Does this chat need a (new) assignee? Looks up the current assignee only when there is one.
 * @returns {Promise<{needed: boolean, reason: string}>}
 */
async function assignmentNeed(chat) {
  const current = chat.assignedTo;
  if (!current) return { needed: true, reason: 'unassigned' };
  const id = sid(current);
  if (!mongoose.isValidObjectId(id)) return { needed: true, reason: 'assignee_invalid' };
  const user = await User.findById(id).select('isActive').lean();
  if (!user) return { needed: true, reason: 'assignee_missing' };
  if (user.isActive === false) return { needed: true, reason: 'assignee_inactive' };
  return { needed: false, reason: 'already_assigned' };
}

/**
 * Keep the in-memory chat document in line with the database without marking `assignedTo` as
 * modified (a later `chat.save()` in the webhook must not re-write, and so possibly revert, it).
 */
function adoptAssignee(chat, value) {
  if (typeof chat.set === 'function') {
    chat.set('assignedTo', value || null);
    if (typeof chat.unmarkModified === 'function') chat.unmarkModified('assignedTo');
  } else {
    chat.assignedTo = value || null;
  }
}

/**
 * @param {object} params
 * @param {object} params.chat     the (already saved) Chat mongoose document of the conversation
 * @param {object} [params.contact] the customer's Contact document (tags are checked)
 * @param {*}      params.wabaId   the chat's WABA _id
 * @param {function} [params.rng]  random source (tests)
 * @returns {Promise<{action: 'assigned'|'none'|'skipped'|'error', reason: string, staffId?: string, previous?: string|null}>}
 */
async function autoAssignIncomingChat({ chat, contact, wabaId, rng = Math.random }) {
  if (!chat || !chat._id) return { action: 'none', reason: 'no_chat' };
  try {
    if (await isMonthly({ chat, contact }, { strict: true })) {
      return { action: 'skipped', reason: 'monthly' };
    }

    const need = await assignmentNeed(chat);
    if (!need.needed) return { action: 'none', reason: need.reason };

    const staff = await User.find(eligibleStaffFilter(wabaId || chat.wabaId)).select('_id').lean();
    const previous = chat.assignedTo ? sid(chat.assignedTo) : null;
    const candidates = staff.filter((s) => String(s._id) !== previous);
    const pick = pickRandom(candidates, rng);
    if (!pick) {
      logger.warn(`[auto-assign] chat ${chat._id}: no eligible staff on WABA ${wabaId || chat.wabaId}; left ${previous ? 'with its inactive assignee' : 'unassigned'}`);
      return { action: 'none', reason: 'no_eligible_staff' };
    }

    // Compare-and-set against what we saw. `assignedTo: null` also matches a missing field.
    const res = await Chat.updateOne(
      { _id: chat._id, assignedTo: previous ? chat.assignedTo._id || chat.assignedTo : null },
      { $set: { assignedTo: pick._id } },
    );
    if (!res.modifiedCount) {
      // Someone else (a concurrent message, a retry or a person) assigned it first: adopt theirs.
      const fresh = await Chat.findById(chat._id).select('assignedTo').lean();
      adoptAssignee(chat, fresh?.assignedTo || null);
      return { action: 'none', reason: 'assigned_concurrently' };
    }

    adoptAssignee(chat, pick._id);
    logger.info(`[auto-assign] chat ${chat._id} -> staff ${pick._id} (random of ${candidates.length}; ${need.reason})`);
    try {
      await ChatActivity.create(previous
        ? { chatId: chat._id, type: 'auto_transferred', details: { fromStaffId: previous, toStaffId: pick._id, reason: `incoming_message:${need.reason}` } }
        : { chatId: chat._id, type: 'assigned', details: { assignedTo: pick._id, reason: 'auto_random_incoming' } });
    } catch (e) {
      logger.warn(`[auto-assign] activity log failed for chat ${chat._id}: ${e.message}`);
    }
    return { action: 'assigned', reason: need.reason, staffId: String(pick._id), previous };
  } catch (err) {
    logger.error(`[auto-assign] chat ${chat._id}: skipped after error: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

module.exports = { autoAssignIncomingChat, eligibleStaffFilter, pickRandom, assignmentNeed };
