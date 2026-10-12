'use strict';

/**
 * WhatsApp call flow driven by Asterisk (private HTTP calls from the dialplan, see routes/internalCalls.routes.js).
 *
 *  inbound:  route -> (stage "all") -> answered -> hangup
 *  outbound: authorizeOutbound -> answered -> hangup
 *
 * The backend decides who rings and records everything; Asterisk carries the audio.
 */
const { User, Waba, Chat, Contact, Message, CallLog } = require('../../models');
const whatsappService = require('../whatsapp.service');
const { logger } = require('../../utils/logger');
const callingConfig = require('./config');
const sip = require('./sipAccounts');
const routing = require('./routing');
const permissions = require('./permissions');
const recordings = require('./recordings');

// ---------- helpers ----------
const ioSafe = () => { try { return require('../../websocket/socket.server').getIO(); } catch (_) { return null; } };
function emitToUsers(userIds, event, payload) {
  const io = ioSafe();
  if (!io) return;
  for (const id of new Set((userIds || []).map(String))) io.to(`user:${id}`).emit(event, payload);
}
function push(userIds, payload) {
  if (!userIds?.length) return;
  try {
    require('../push.service').sendPushNotificationToUsers(userIds, payload).catch(() => {});
  } catch (_) { /* push optional */ }
}
const digits = (v) => String(v || '').replace(/\D/g, '');

async function findWabaForNumber(toNumber) {
  const cfg = callingConfig.get();
  const d = digits(toNumber);
  const wabas = await Waba.find({ 'phoneNumbers.phoneNumberId': { $in: cfg.phoneNumberIds } }).lean();
  for (const w of wabas) {
    const p = (w.phoneNumbers || []).find((x) => cfg.phoneNumberIds.includes(x.phoneNumberId) && (!d || digits(x.phoneNumber) === d));
    if (p) return { waba: w, phoneNumberId: p.phoneNumberId };
  }
  // Single configured number: accept even if the To format differs
  if (wabas.length === 1 && cfg.phoneNumberIds.length === 1) return { waba: wabas[0], phoneNumberId: cfg.phoneNumberIds[0] };
  return null;
}

async function ensureContactAndChat(waba, phoneNumberId, waId) {
  let contact = await Contact.findOne({ waId });
  if (!contact) contact = await Contact.create({ phoneNumber: waId, waId, name: '' });
  let chat = await Chat.findOne({ wabaId: waba._id, waId });
  if (!chat) {
    try {
      chat = await Chat.create({ wabaId: waba._id, phoneNumberId, phoneNumber: waId, waId, contactId: contact._id, status: 'open', isUnread: true });
    } catch (e) {
      if (e.code !== 11000) throw e;
      chat = await Chat.findOne({ wabaId: waba._id, waId });
    }
  }
  return { contact, chat };
}

async function busyUserIds() {
  const since = new Date(Date.now() - 4 * 3600e3);
  const live = await CallLog.find({ status: { $in: ['ringing', 'accepted'] }, endedAt: null, createdAt: { $gt: since } })
    .select('status answeredBy initiatedBy direction').lean();
  const ids = [];
  for (const c of live) {
    if (c.status === 'accepted' && c.answeredBy) ids.push(String(c.answeredBy));
    if (c.direction === 'outbound' && c.initiatedBy) ids.push(String(c.initiatedBy));
  }
  return ids;
}

async function endpointsForUsers(userIds) {
  if (!userIds.length) return [];
  const users = await User.find({ _id: { $in: userIds }, isActive: true }).select('sip.deskPhone sip.androidAppAt').lean();
  const out = [];
  for (const u of users) {
    out.push(sip.endpointFor(u._id));
    if (sip.hasAndroidApp(u)) out.push(sip.appEndpointFor(u._id)); // Asterisk waits for the phone (push) to register
    if (u.sip?.deskPhone) out.push(sip.deskEndpointFor(u._id));
  }
  return out;
}

function contactName(contact, waId) {
  return contact?.name || contact?.nickname || contact?.nameOnWhatsApp || (waId ? `+${waId}` : 'WhatsApp caller');
}

function payloadFor(callLog, extra = {}) {
  return {
    callLogId: String(callLog._id),
    chatId: callLog.chatId ? String(callLog.chatId) : null,
    direction: callLog.direction,
    waId: callLog.waId,
    status: callLog.status,
    ...extra,
  };
}

// ---------- inbound ----------
/**
 * Asterisk: a customer is calling. Returns the ring plan as a pipe string:
 *   ok|<callLogId>|<stage1 endpoints ~ separated or empty>|<stage1 seconds>|<stage2 endpoints>|<stage2 seconds>
 */
async function inboundRoute({ uniqueid, wacid, from, to }) {
  const cfg = callingConfig.get();
  const target = await findWabaForNumber(to);
  if (!target) throw new Error(`no SIP-enabled business number matches ${to}`);
  const { waba, phoneNumberId } = target;
  const waId = routing.digitsOnly(from) || String(from || 'unknown').slice(0, 64);

  let contact = null;
  let chat = null;
  if (routing.digitsOnly(from)) ({ contact, chat } = await ensureContactAndChat(waba, phoneNumberId, waId));

  // Idempotency: Asterisk may retry the request
  let callLog = uniqueid ? await CallLog.findOne({ asteriskUniqueId: uniqueid }) : null;
  const users = await User.find({ isActive: true, role: { $in: sip.CALL_ROLES } }).select('role isActive assignedWabaId name').lean();
  const plan = routing.buildRingPlan({
    users, wabaId: waba._id, assignedTo: chat?.assignedTo, busyUserIds: await busyUserIds(),
    firstSeconds: cfg.ringFirstSeconds, allSeconds: cfg.ringAllSeconds,
  });

  if (!callLog) {
    callLog = await CallLog.create({
      chatId: chat?._id, wabaId: waba._id, phoneNumberId, waId, direction: 'inbound', status: 'ringing',
      callId: wacid || undefined, asteriskUniqueId: uniqueid || undefined, startedAt: new Date(),
      stage: plan.first ? 'assigned' : 'all',
      ringTargets: (plan.first ? plan.first.userIds : plan.all.userIds),
      metadata: { plan: { first: plan.first?.userIds || [], all: plan.all.userIds }, contactName: contactName(contact, waId) },
    });
  }

  const firstStage = plan.first || plan.all;
  const notice = payloadFor(callLog, { contactName: contactName(contact, waId), wabaName: waba.businessName, stage: firstStage.stage, ringSeconds: firstStage.seconds });
  emitToUsers(firstStage.userIds, 'call:incoming', notice);
  push(firstStage.userIds, { title: 'Incoming WhatsApp call', body: `${notice.contactName} is calling`, data: { type: 'incoming_call', ...notice, sentAt: Date.now() }, ttlSeconds: 45 });

  const firstEps = plan.first ? await endpointsForUsers(plan.first.userIds) : [];
  const allEps = await endpointsForUsers(plan.all.userIds);
  logger.info(`[calls] inbound ${callLog._id} from ${waId} wacid=${wacid || '-'}: stage1=${firstEps.length} endpoints, all=${allEps.length}`);
  return ['ok', callLog._id, firstEps.join('~'), plan.first ? plan.first.seconds : 0, allEps.join('~'), plan.all.seconds].join('|');
}

/**
 * Asterisk: stage 1 (assigned staff) finished without answer, now ringing everyone.
 * Returns "ok|<endpoints ~ separated>": everyone in the plan except users who declined this call.
 */
async function stageAll({ callLogId }) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog || callLog.status !== 'ringing') return 'ok|';
  const declined = (callLog.metadata?.declinedBy || []).map(String);
  const allIds = (callLog.metadata?.plan?.all || []).map(String).filter((id) => !declined.includes(id));
  callLog.stage = 'all';
  callLog.ringTargets = Array.from(new Set([...(callLog.ringTargets || []).map(String), ...allIds]));
  await callLog.save();
  const fresh = allIds.filter((id) => !(callLog.metadata?.plan?.first || []).map(String).includes(id));
  const notice = payloadFor(callLog, { contactName: callLog.metadata?.contactName, stage: 'all', ringSeconds: callingConfig.get().ringAllSeconds });
  emitToUsers(allIds, 'call:incoming', notice);
  push(fresh, { title: 'Incoming WhatsApp call', body: `${notice.contactName || 'A customer'} is calling`, data: { type: 'incoming_call', ...notice, sentAt: Date.now() }, ttlSeconds: 45 });
  const eps = await endpointsForUsers(allIds);
  return `ok|${eps.join('~')}`;
}

/**
 * A staff member declined a ringing call (web/app). Stops ringing on all of that user's devices.
 * If they were the assigned staff member in stage 1, Asterisk moves on to ringing everyone at once;
 * a user who declined is not rung again for this call.
 */
async function decline({ callLogId, user }) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog || callLog.direction !== 'inbound') return { ok: false, status: 404, error: 'Call not found' };
  if (callLog.status !== 'ringing') return { ok: true, alreadyEnded: true };
  const uid = String(user._id);
  const targeted = [...(callLog.ringTargets || []), ...(callLog.metadata?.plan?.all || [])].map(String).includes(uid);
  if (!targeted) return { ok: false, status: 403, error: 'This call is not ringing for you' };
  await CallLog.updateOne({ _id: callLog._id }, { $addToSet: { 'metadata.declinedBy': user._id } });
  emitToUsers([uid], 'call:dismissed', { callLogId: String(callLog._id), reason: 'declined' });
  let hungUp = 0;
  try {
    hungUp = await hangupUserLegs(uid);
  } catch (e) {
    logger.error(`[calls] decline: could not stop ringing for ${uid}: ${e.message}`);
  }
  logger.info(`[calls] ${user.name || uid} declined ${callLog._id} (stage ${callLog.stage}, ${hungUp} device legs stopped)`);
  return { ok: true, stoppedDevices: hungUp };
}

/**
 * Hang up every ringing Asterisk channel of this user's devices (PJSIP/u<id>-..., -desk, -app) and the
 * "waiting for the phone" leg (Local/u<id>-app@app-wait), so a phone that registers later does not ring.
 */
async function hangupUserLegs(userId) {
  const cfg = callingConfig.get();
  const { amiCommand } = require('./ami');
  const out = await amiCommand(cfg.ami, 'core show channels concise');
  const ep = sip.endpointFor(userId);
  const names = out.split('\n').map((l) => l.split('!')[0])
    .filter((n) => n.startsWith(`PJSIP/${ep}-`) || n.startsWith(`Local/${ep}-app@app-wait-`));
  let n = 0;
  for (const name of names) {
    if (!/^PJSIP\/u[0-9a-f]{24}(-desk|-app)?-[0-9a-f]+$/.test(name) && !/^Local\/u[0-9a-f]{24}-app@app-wait-[0-9a-f]+;[12]$/.test(name)) continue;
    await amiCommand(cfg.ami, `channel request hangup ${name}`);
    n += 1;
  }
  return n;
}

// ---------- answered (both directions) ----------
/** Asterisk: the call was answered. endpoint = staff endpoint (inbound) or "whatsapp" (outbound: customer answered). */
async function answered({ callLogId, endpoint }) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog) return 'ok';
  const now = new Date();
  const update = { status: 'accepted', answeredAt: now };
  if (callLog.direction === 'inbound') {
    const who = sip.userIdFromEndpoint(endpoint);
    if (who) { update.answeredBy = who.userId; update.answeredDevice = who.device; }
  } else {
    update.answeredBy = callLog.initiatedBy;
  }
  // Atomic: only the first answer wins
  const res = await CallLog.findOneAndUpdate({ _id: callLogId, status: 'ringing' }, { $set: update }, { new: true });
  if (!res) return 'ok';
  const answeredBy = res.answeredBy ? await User.findById(res.answeredBy).select('name').lean() : null;
  const payload = payloadFor(res, { answeredBy: answeredBy ? { id: String(answeredBy._id), name: answeredBy.name } : null });
  const targets = res.direction === 'inbound' ? res.ringTargets : [res.initiatedBy];
  emitToUsers(targets, 'call:answered', payload);
  if (res.direction === 'inbound') push((res.ringTargets || []).map(String).filter((id) => id !== String(res.answeredBy)), { title: '', body: '', data: { type: 'call_answered_elsewhere', callLogId: String(res._id) }, ttlSeconds: 120 });
  return 'ok';
}

// ---------- hangup (both directions) ----------
async function createChatEntry(callLog) {
  if (!callLog.chatId) return null;
  const chat = await Chat.findById(callLog.chatId).select('wabaId phoneNumberId waId').lean();
  if (!chat) return null;
  const who = callLog.answeredBy ? await User.findById(callLog.answeredBy).select('name').lean() : null;
  const caller = callLog.initiatedBy ? await User.findById(callLog.initiatedBy).select('name').lean() : null;
  const dur = routing.formatDuration(callLog.duration);
  let text;
  if (callLog.direction === 'inbound') {
    text = callLog.status === 'terminated' && callLog.answeredAt
      ? `📞 Incoming WhatsApp call · ${dur}${who ? ` · answered by ${who.name}` : ''}`
      : '📞 Missed WhatsApp call';
  } else {
    text = callLog.answeredAt
      ? `📞 Outgoing WhatsApp call${caller ? ` by ${caller.name}` : ''} · ${dur}`
      : `📞 Outgoing WhatsApp call${caller ? ` by ${caller.name}` : ''} · not answered`;
  }
  const msg = await Message.create({
    chatId: callLog.chatId, wabaId: callLog.wabaId, phoneNumberId: callLog.phoneNumberId, waId: callLog.waId,
    direction: 'internal', type: 'system', text, sentBy: callLog.initiatedBy || callLog.answeredBy || undefined,
    metadata: { kind: 'call', callLogId: String(callLog._id), direction: callLog.direction, status: callLog.status, duration: callLog.duration },
  });
  const io = ioSafe();
  if (io) io.emit('message:new', { chatId: String(callLog.chatId), message: msg });
  return msg;
}

async function sendMissedCallMessage(callLog) {
  const cfg = callingConfig.get();
  if (!callLog.chatId || !routing.digitsOnly(callLog.waId)) return;
  const last = await CallLog.findOne({ chatId: callLog.chatId, missedMessageSentAt: { $ne: null } }).sort({ missedMessageSentAt: -1 }).select('missedMessageSentAt').lean();
  if (!routing.shouldSendMissedMessage(last?.missedMessageSentAt, cfg.missedMessageCooldownMin)) {
    logger.info(`[calls] missed-call message for chat ${callLog.chatId} skipped (sent within ${cfg.missedMessageCooldownMin} min)`);
    return;
  }
  try {
    const res = await whatsappService.sendInteractiveMessage(callLog.wabaId, callLog.phoneNumberId, callLog.waId, {
      type: 'voice_call',
      body: { text: cfg.missedMessageText },
      action: { name: 'voice_call', parameters: { display_text: 'Call on WhatsApp', ttl_minutes: 1440 } },
    });
    await CallLog.updateOne({ _id: callLog._id }, { $set: { missedMessageSentAt: new Date() } });
    const msg = await Message.create({
      chatId: callLog.chatId, wabaId: callLog.wabaId, phoneNumberId: callLog.phoneNumberId, waId: callLog.waId,
      messageId: res?.messages?.[0]?.id, direction: 'outbound', type: 'interactive', status: 'sent', sentByBot: true,
      text: cfg.missedMessageText, metadata: { kind: 'missed_call_message', callLogId: String(callLog._id) },
    });
    const io = ioSafe();
    if (io) io.emit('message:new', { chatId: String(callLog.chatId), message: msg });
  } catch (e) {
    logger.error(`[calls] missed-call message failed for ${callLog._id}: ${e.message}`);
  }
}

/**
 * Asterisk: the call is over. dialstatus = Asterisk DIALSTATUS of the last Dial
 * (ANSWER, NOANSWER, BUSY, CHANUNAVAIL, CONGESTION, CANCEL, ...).
 */
async function hangup({ callLogId, dialstatus, answeredtime, recfile, cause }) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog || callLog.endedAt) return 'ok';
  const now = new Date();
  const wasAnswered = !!callLog.answeredAt || String(dialstatus).toUpperCase() === 'ANSWER';
  callLog.endedAt = now;
  if (wasAnswered) {
    callLog.status = 'terminated';
    if (!callLog.answeredAt) callLog.answeredAt = now;
    const talked = Number(answeredtime);
    callLog.duration = Number.isFinite(talked) && talked > 0 ? Math.round(talked) : Math.round((now - callLog.answeredAt) / 1000);
  } else {
    const ds = String(dialstatus || '').toUpperCase();
    callLog.status = callLog.direction === 'inbound' ? 'missed' : (ds === 'BUSY' ? 'rejected' : (ds === 'NOANSWER' || ds === 'CANCEL' ? 'missed' : 'failed'));
    callLog.duration = 0;
  }
  callLog.endReason = String(dialstatus || (String(cause) === '19' ? 'NO_DEVICE_ONLINE' : cause) || '').slice(0, 40) || undefined;
  await callLog.save();

  const msg = await createChatEntry(callLog).catch((e) => { logger.error(`[calls] chat entry failed: ${e.message}`); return null; });
  if (msg) await CallLog.updateOne({ _id: callLog._id }, { $set: { chatMessageId: msg._id } });

  const targets = callLog.direction === 'inbound' ? callLog.ringTargets : [callLog.initiatedBy];
  emitToUsers(targets, 'call:ended', payloadFor(callLog, { duration: callLog.duration, endReason: callLog.endReason }));
  if (callLog.direction === 'inbound' && !wasAnswered) {
    // Phones stop ringing and show "Missed WhatsApp call from <name>" (tap opens the chat).
    // People who declined it get outcome 'declined' (no missed-call notification for them).
    const declined = (callLog.metadata?.declinedBy || []).map(String);
    const base = {
      type: 'call_ended', callLogId: String(callLog._id), chatId: callLog.chatId ? String(callLog.chatId) : '',
      waId: callLog.waId || '', contactName: callLog.metadata?.contactName || (callLog.waId ? `+${callLog.waId}` : 'WhatsApp caller'),
      endedAt: Date.now(),
    };
    const all = (targets || []).map(String);
    const missedTo = all.filter((id) => !declined.includes(id));
    const declinedTo = all.filter((id) => declined.includes(id));
    if (missedTo.length) push(missedTo, { title: '', body: '', data: { ...base, outcome: 'missed' }, ttlSeconds: 3600 });
    if (declinedTo.length) push(declinedTo, { title: '', body: '', data: { ...base, outcome: 'declined' }, ttlSeconds: 120 });
  }

  if (callLog.direction === 'inbound' && callLog.status === 'missed') await sendMissedCallMessage(callLog);
  if (!wasAnswered && recfile) recordings.discardRecording(recfile);
  if (wasAnswered && recfile) recordings.processRecording(callLog._id, recfile).then(() => {
    emitToUsers([...(targets || []), callLog.answeredBy].filter(Boolean), 'call:recording', { callLogId: String(callLog._id) });
  });
  logger.info(`[calls] ${callLog.direction} ${callLog._id} ended: ${callLog.status} ${callLog.duration}s (${callLog.endReason || '-'})`);
  return 'ok';
}

// ---------- outbound ----------
async function resolveOutboundChat(target) {
  const t = String(target || '');
  const m = /^chat-([0-9a-f]{24})$/i.exec(t);
  if (m) return Chat.findById(m[1]);
  const d = routing.digitsOnly(t);
  if (!d) return null;
  const cfg = callingConfig.get();
  return Chat.findOne({ waId: d, phoneNumberId: { $in: cfg.phoneNumberIds } }).sort({ lastMessageAt: -1 });
}

/** Explain why a user may not call a chat right now (null = allowed). Used by the API and by Asterisk. */
async function outboundBlockReason(user, chat) {
  const cfg = callingConfig.get();
  if (!cfg.enabled) return 'WhatsApp calling is not enabled.';
  if (!chat) return 'Chat not found.';
  if (!cfg.phoneNumberIds.includes(chat.phoneNumberId)) return 'WhatsApp calling is not enabled on this business number.';
  if (!routing.canUserCallChat(user, chat)) return 'You can call only chats assigned to you.';
  if (!routing.digitsOnly(chat.waId)) return 'This customer has no phone number to call.';
  const contact = await Contact.findOne({ $or: [{ waId: chat.waId }, { phoneNumber: chat.waId }], $and: [{ $or: [{ isBlocked: true }, { isOptedOut: true }] }] }).select('_id').lean();
  if (contact) return 'This contact is blocked or opted out.';
  const perm = await permissions.getPermission(chat.phoneNumberId, chat.waId);
  if (!routing.permissionValid(perm)) return 'The customer has not allowed WhatsApp calls. Ask for call permission first.';
  return null;
}

/** Asterisk: a staff device dialled out. Returns "ok|<callLogId>|+<number>" or "deny|<reason>". */
async function authorizeOutbound({ endpoint, target, uniqueid }) {
  const who = sip.userIdFromEndpoint(endpoint);
  if (!who) return 'deny|Unknown caller device.';
  const user = await User.findById(who.userId).select('role isActive name').lean();
  if (!user || !user.isActive) return 'deny|User is not active.';
  const chat = await resolveOutboundChat(target);
  const reason = await outboundBlockReason(user, chat);
  if (reason) {
    emitToUsers([user._id], 'call:blocked', { chatId: chat ? String(chat._id) : null, reason });
    logger.info(`[calls] outbound by ${user.name} to ${target} blocked: ${reason}`);
    return `deny|${reason.replace(/\|/g, '/')}`;
  }
  let callLog = uniqueid ? await CallLog.findOne({ asteriskUniqueId: uniqueid }) : null;
  if (!callLog) {
    callLog = await CallLog.create({
      chatId: chat._id, wabaId: chat.wabaId, phoneNumberId: chat.phoneNumberId, waId: chat.waId,
      direction: 'outbound', status: 'ringing', initiatedBy: user._id, startedAt: new Date(),
      asteriskUniqueId: uniqueid || undefined, answeredDevice: who.device,
    });
  }
  emitToUsers([user._id], 'call:outgoing', payloadFor(callLog));
  return `ok|${callLog._id}|+${chat.waId}`;
}

module.exports = {
  inboundRoute, stageAll, decline, answered, hangup, authorizeOutbound, outboundBlockReason,
  // exported for tests
  _internals: { findWabaForNumber, ensureContactAndChat, busyUserIds, createChatEntry, sendMissedCallMessage, resolveOutboundChat },
};
