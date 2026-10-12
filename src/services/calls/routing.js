'use strict';

/**
 * Pure helpers for who rings, who may call, and Meta-related limits. No database access here,
 * so the rules can be unit-tested directly.
 */

const ROLES = ['superadmin', 'admin', 'staff'];
const isAdmin = (u) => u && (u.role === 'admin' || u.role === 'superadmin');
const sid = (v) => (v == null ? null : String(v._id || v));

/** Users allowed to ring for a call on this WABA: active admins/superadmins, and staff of this WABA (or no WABA). */
function eligibleRingUsers(users, wabaId) {
  return users.filter((u) => u.isActive !== false && ROLES.includes(u.role)
    && (u.role !== 'staff' || !u.assignedWabaId || sid(u.assignedWabaId) === sid(wabaId)));
}

/**
 * Two-stage ring plan.
 *  - assigned user eligible and not busy: stage "assigned" rings only them, then stage "all" rings everyone
 *  - otherwise only stage "all", for the full time
 * Users already on another call are skipped.
 */
function buildRingPlan({ users, wabaId, assignedTo, busyUserIds = [], firstSeconds = 25, allSeconds = 25 }) {
  const busy = new Set(busyUserIds.map(String));
  const everyone = eligibleRingUsers(users, wabaId).filter((u) => !busy.has(sid(u)));
  const assigned = assignedTo ? everyone.find((u) => sid(u) === sid(assignedTo)) : null;
  const allIds = everyone.map(sid);
  if (assigned) {
    return { first: { stage: 'assigned', userIds: [sid(assigned)], seconds: firstSeconds }, all: { stage: 'all', userIds: allIds, seconds: allSeconds } };
  }
  return { first: null, all: { stage: 'all', userIds: allIds, seconds: firstSeconds + allSeconds } };
}

/** Staff may call only chats assigned to them; admins and superadmins any chat. */
function canUserCallChat(user, chat) {
  if (!user || !chat) return false;
  if (isAdmin(user)) return true;
  return user.role === 'staff' && sid(chat.assignedTo) === sid(user);
}

/** Is the customer's call permission currently valid? */
function permissionValid(perm, now = new Date()) {
  if (!perm || perm.status !== 'granted') return false;
  if (perm.isPermanent) return true;
  return !!perm.expiresAt && new Date(perm.expiresAt) > now;
}

/** Meta: max 1 permission request per 24 h and 2 per 7 days, per customer and business number. */
function permissionRequestAllowed(requests = [], now = new Date()) {
  const t = now.getTime();
  const times = requests.map((r) => new Date(r.at || r).getTime());
  const in24h = times.filter((x) => t - x < 24 * 3600e3).length;
  const in7d = times.filter((x) => t - x < 7 * 24 * 3600e3).length;
  if (in24h >= 1) return { ok: false, reason: 'A call permission request was already sent in the last 24 hours.' };
  if (in7d >= 2) return { ok: false, reason: 'Two call permission requests were already sent in the last 7 days.' };
  return { ok: true };
}

/** Send the missed-call message at most once per cooldown window per chat. */
function shouldSendMissedMessage(lastSentAt, cooldownMin = 30, now = new Date()) {
  if (!lastSentAt) return true;
  return now.getTime() - new Date(lastSentAt).getTime() >= cooldownMin * 60e3;
}

/** Normalise a customer number from SIP ("+91 98...", "sip:+91..@") to digits; null if it is not a number (e.g. BSUID). */
function digitsOnly(v) {
  const s = String(v || '').replace(/^sip:/, '').split('@')[0];
  const d = s.replace(/\D/g, '');
  return /^[+\d\s()-]+$/.test(s) && d.length >= 8 && d.length <= 15 ? d : null;
}

/**
 * Staff "Send call button": a free-form interactive message, so only inside WhatsApp's 24-hour customer
 * service window (opened by the customer's last message or call). Also blocks double taps (2 min per chat).
 */
function callButtonAllowed({ lastCustomerAt, lastSentAt, now = new Date() }) {
  const t = now.getTime();
  const last = lastCustomerAt ? new Date(lastCustomerAt).getTime() : 0;
  if (!last || t - last >= 24 * 3600e3) {
    return { ok: false, reason: "The customer hasn't messaged or called in the last 24 hours, so WhatsApp only allows a template." };
  }
  if (lastSentAt && t - new Date(lastSentAt).getTime() < 2 * 60e3) {
    return { ok: false, reason: 'A call button was just sent to this customer. Please wait a moment.' };
  }
  return { ok: true, windowEndsAt: new Date(last + 24 * 3600e3) };
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

module.exports = {
  eligibleRingUsers, buildRingPlan, canUserCallChat, permissionValid,
  permissionRequestAllowed, shouldSendMissedMessage, callButtonAllowed, digitsOnly, formatDuration, isAdmin,
};
