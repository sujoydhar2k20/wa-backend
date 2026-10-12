'use strict';

/**
 * WhatsApp call reports (admins): totals, per staff member, per day, busy hours and the missed calls
 * nobody has followed up yet. Pure functions (buildReport, toCsv) + a loader that queries MongoDB.
 */
const { CallLog, Message, User } = require('../../models');

const TZ_OFFSET_MIN = 330; // Asia/Kolkata, used for "per day" and "busy hours"
const MAX_RANGE_DAYS = 366;
const ANSWERED = new Set(['accepted', 'terminated']);

const localDate = (d) => {
  const t = new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60e3);
  return t.toISOString().slice(0, 10);
};
const localHour = (d) => new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60e3).getUTCHours();
const secs = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Parse ?from=&to= (ISO or YYYY-MM-DD in IST). Default: last 7 days. */
function parseRange(query = {}, now = new Date()) {
  const parse = (v, endOfDay) => {
    if (!v) return null;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // whole IST day
      const base = new Date(`${s}T00:00:00.000Z`).getTime() - TZ_OFFSET_MIN * 60e3;
      return new Date(endOfDay ? base + 86400e3 - 1 : base);
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let to = parse(query.to, true) || now;
  let from = parse(query.from, false) || new Date(to.getTime() - 7 * 86400e3);
  if (from > to) [from, to] = [to, from];
  if (to - from > MAX_RANGE_DAYS * 86400e3) from = new Date(to.getTime() - MAX_RANGE_DAYS * 86400e3);
  return { from, to };
}

/**
 * calls: CallLog docs (lean) in the range, oldest first or any order.
 * followUps: { [callLogId]: { at, how } } for missed inbound calls that were followed up.
 * users: { [userId]: name }
 */
function buildReport({ calls, followUps = {}, users = {}, from, to }) {
  // Customer calls WhatsApp refused before they reached us (payment, unsupported device...): counted apart
  const failedAtMeta = calls.filter((c) => c.direction === 'inbound' && c.metadata?.failedAtMeta);
  const inbound = calls.filter((c) => c.direction === 'inbound' && c.status !== 'ringing' && !c.metadata?.failedAtMeta);
  const outbound = calls.filter((c) => c.direction === 'outbound' && c.status !== 'ringing');
  const inAnswered = inbound.filter((c) => ANSWERED.has(c.status) && c.answeredAt);
  const inMissed = inbound.filter((c) => !(ANSWERED.has(c.status) && c.answeredAt));
  const outConnected = outbound.filter((c) => c.answeredAt);
  const outBlocked = outbound.filter((c) => c.status === 'blocked');

  const ringToAnswer = inAnswered.map((c) => secs(c.startedAt || c.createdAt, c.answeredAt)).filter((x) => x !== null);
  const talk = [...inAnswered, ...outConnected].map((c) => c.duration || 0);

  const totals = {
    inbound: inbound.length,
    inboundAnswered: inAnswered.length,
    inboundMissed: inMissed.length,
    answerRate: pct(inAnswered.length, inbound.length),
    avgSecondsToAnswer: avg(ringToAnswer),
    answeredWithin25s: pct(ringToAnswer.filter((x) => x <= 25).length, ringToAnswer.length),
    outbound: outbound.length,
    outboundConnected: outConnected.length,
    outboundNotAnswered: outbound.length - outConnected.length - outBlocked.length,
    outboundBlocked: outBlocked.length,
    talkSeconds: talk.reduce((s, x) => s + x, 0),
    avgTalkSeconds: avg(talk.filter((x) => x > 0)),
    missedFollowedUp: inMissed.filter((c) => followUps[String(c._id)]).length,
    missedNotFollowedUp: inMissed.filter((c) => !followUps[String(c._id)]).length,
    failedAtWhatsApp: failedAtMeta.length,
  };
  const failedReasons = {};
  for (const c of failedAtMeta) {
    const e = (c.meta?.errors || [])[0];
    const key = e?.code ? `${e.code}${e.meaning ? ` · ${e.meaning}` : ''}` : 'Unknown (no error code from WhatsApp)';
    failedReasons[key] = (failedReasons[key] || 0) + 1;
  }

  // ---- per staff member
  const staff = new Map();
  const row = (id) => {
    const k = String(id);
    if (!staff.has(k)) {
      staff.set(k, { userId: k, name: users[k] || 'Unknown', answered: 0, missedWhileAssigned: 0, declined: 0,
        outbound: 0, outboundConnected: 0, talkSeconds: 0, _answerSecs: [] });
    }
    return staff.get(k);
  };
  for (const c of inAnswered) {
    if (!c.answeredBy) continue;
    const r = row(c.answeredBy);
    r.answered += 1;
    r.talkSeconds += c.duration || 0;
    const s = secs(c.startedAt || c.createdAt, c.answeredAt);
    if (s !== null) r._answerSecs.push(s);
  }
  for (const c of inMissed) {
    for (const id of c.metadata?.plan?.first || []) row(id).missedWhileAssigned += 1;
  }
  for (const c of inbound) {
    for (const id of c.metadata?.declinedBy || []) row(id).declined += 1;
  }
  for (const c of outbound) {
    if (!c.initiatedBy) continue;
    const r = row(c.initiatedBy);
    r.outbound += 1;
    if (c.answeredAt) {
      r.outboundConnected += 1;
      r.talkSeconds += c.duration || 0;
    }
  }
  const perStaff = [...staff.values()]
    .map(({ _answerSecs, ...r }) => ({ ...r, avgSecondsToAnswer: avg(_answerSecs) }))
    .sort((a, b) => (b.answered + b.outbound) - (a.answered + a.outbound) || a.name.localeCompare(b.name));

  // ---- per day (IST), every day in the range
  const days = new Map();
  for (let t = new Date(localDate(from)).getTime(); t <= new Date(localDate(to)).getTime(); t += 86400e3) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.set(d, { date: d, inboundAnswered: 0, inboundMissed: 0, outbound: 0 });
  }
  const day = (d) => {
    const k = localDate(d);
    if (!days.has(k)) days.set(k, { date: k, inboundAnswered: 0, inboundMissed: 0, outbound: 0 });
    return days.get(k);
  };
  for (const c of inAnswered) day(c.createdAt).inboundAnswered += 1;
  for (const c of inMissed) day(c.createdAt).inboundMissed += 1;
  for (const c of outbound) day(c.createdAt).outbound += 1;
  const perDay = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ---- busy hours (customer calls by IST hour)
  const perHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, inbound: 0, missed: 0 }));
  for (const c of inbound) perHour[localHour(c.createdAt)].inbound += 1;
  for (const c of inMissed) perHour[localHour(c.createdAt)].missed += 1;

  // ---- missed calls not followed up yet (newest first)
  const notFollowedUp = [...inMissed, ...failedAtMeta]
    .filter((c) => !followUps[String(c._id)])
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100)
    .map((c) => ({
      callLogId: String(c._id),
      chatId: c.chatId ? String(c.chatId._id || c.chatId) : null,
      waId: c.waId,
      contactName: c.metadata?.contactName || (c.waId ? `+${c.waId}` : 'Unknown'),
      at: c.createdAt,
      assignedTo: (c.metadata?.plan?.first || []).map((id) => users[String(id)] || 'Unknown'),
      failedAtWhatsApp: !!c.metadata?.failedAtMeta,
    }));

  return { range: { from, to }, totals, failedReasons, perStaff, perDay, perHour, notFollowedUp };
}

/**
 * A missed inbound call counts as followed up when, after it, the business called the customer
 * (any outbound attempt), the customer's next call was answered, or staff sent a message in the chat.
 */
async function findFollowUps(missed) {
  const out = {};
  if (!missed.length) return out;
  const waIds = [...new Set(missed.map((c) => c.waId))];
  const chatIds = [...new Set(missed.map((c) => c.chatId && String(c.chatId._id || c.chatId)).filter(Boolean))];
  const earliest = new Date(Math.min(...missed.map((c) => new Date(c.createdAt).getTime())));
  const [laterCalls, laterMsgs] = await Promise.all([
    CallLog.find({ waId: { $in: waIds }, createdAt: { $gt: earliest } })
      .select('waId direction status answeredAt createdAt').lean(),
    chatIds.length
      ? Message.find({ chatId: { $in: chatIds }, direction: 'outbound', sentBy: { $ne: null }, sentByBot: { $ne: true }, createdAt: { $gt: earliest } })
        .select('chatId createdAt').lean()
      : [],
  ]);
  for (const c of missed) {
    const t = new Date(c.createdAt).getTime();
    const call = laterCalls.find((x) => x.waId === c.waId && new Date(x.createdAt).getTime() > t
      && (x.direction === 'outbound' || (x.direction === 'inbound' && x.answeredAt)));
    const cid = c.chatId && String(c.chatId._id || c.chatId);
    const msg = cid && laterMsgs.find((m) => String(m.chatId) === cid && new Date(m.createdAt).getTime() > t);
    const hits = [call && { at: call.createdAt, how: call.direction === 'outbound' ? 'called back' : 'answered next call' },
      msg && { at: msg.createdAt, how: 'messaged' }].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at));
    if (hits.length) out[String(c._id)] = hits[0];
  }
  return out;
}

async function loadReport({ from, to, wabaId }) {
  const filter = { createdAt: { $gte: from, $lte: to } };
  if (wabaId) filter.wabaId = wabaId;
  const calls = await CallLog.find(filter)
    .select('chatId wabaId waId direction status stage answeredBy initiatedBy duration startedAt answeredAt createdAt meta.errors metadata.plan metadata.declinedBy metadata.contactName metadata.failedAtMeta')
    .lean();
  const missed = calls.filter((c) => c.direction === 'inbound' && c.status !== 'ringing' && !(ANSWERED.has(c.status) && c.answeredAt));
  const ids = new Set();
  for (const c of calls) {
    [c.answeredBy, c.initiatedBy, ...(c.metadata?.plan?.first || []), ...(c.metadata?.declinedBy || [])]
      .filter(Boolean).forEach((x) => ids.add(String(x)));
  }
  const [followUps, userDocs] = await Promise.all([
    findFollowUps(missed),
    User.find({ _id: { $in: [...ids] } }).select('name').lean(),
  ]);
  const users = Object.fromEntries(userDocs.map((u) => [String(u._id), u.name]));
  return buildReport({ calls, followUps, users, from, to });
}

// ---------- CSV ----------
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  // also neutralise spreadsheet formulas
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
// Phone numbers as ="+91..." so Excel keeps the + and does not show 9.19E+11 (digits only, so safe)
class RawCell { constructor(v) { this.v = v; } }
const PHONE = (waId) => {
  const d = String(waId || '').replace(/\D/g, '');
  return d ? new RawCell(`"=""+${d}"""`) : '';
};
const fmtLocal = (d) => (d ? new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60e3).toISOString().replace('T', ' ').slice(0, 19) : '');

function toCsv(calls, users = {}) {
  const head = ['Date (IST)', 'Direction', 'Result', 'Customer', 'Number', 'Staff', 'Seconds to answer', 'Talk time (s)', 'Recording'];
  const lines = [head.join(',')];
  for (const c of calls) {
    const staffId = c.direction === 'inbound' ? c.answeredBy : c.initiatedBy;
    const answered = !!c.answeredAt;
    const result = c.direction === 'inbound'
      ? (c.metadata?.failedAtMeta ? `Failed at WhatsApp${c.meta?.errors?.[0]?.code ? ` (${c.meta.errors[0].code})` : ''}` : answered ? 'Answered' : 'Missed')
      : (c.status === 'blocked' ? 'Not allowed' : answered ? 'Connected' : 'Not answered');
    lines.push([
      fmtLocal(c.createdAt), c.direction === 'inbound' ? 'Incoming' : 'Outgoing', result,
      c.metadata?.contactName || '', PHONE(c.waId), staffId ? users[String(staffId)] || '' : '',
      c.direction === 'inbound' && answered ? secs(c.startedAt || c.createdAt, c.answeredAt) : '',
      c.duration || 0, c.recording?.status === 'ready' ? 'yes' : '',
    ].map((v) => (v instanceof RawCell ? v.v : csvCell(v))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel opens UTF-8 names correctly
}

async function loadCsv({ from, to, wabaId }) {
  const filter = { createdAt: { $gte: from, $lte: to }, status: { $ne: 'ringing' } };
  if (wabaId) filter.wabaId = wabaId;
  const calls = await CallLog.find(filter).sort({ createdAt: 1 }).limit(50000)
    .select('waId direction status answeredBy initiatedBy duration startedAt answeredAt createdAt recording.status meta.errors metadata.contactName metadata.failedAtMeta').lean();
  const ids = [...new Set(calls.flatMap((c) => [c.answeredBy, c.initiatedBy]).filter(Boolean).map(String))];
  const users = Object.fromEntries((await User.find({ _id: { $in: ids } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  return toCsv(calls, users);
}

module.exports = { parseRange, buildReport, toCsv, loadReport, loadCsv, findFollowUps, localDate };
