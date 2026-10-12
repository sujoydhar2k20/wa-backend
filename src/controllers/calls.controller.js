'use strict';

const { Chat, CallLog } = require('../models');
const callingConfig = require('../services/calls/config');
const sip = require('../services/calls/sipAccounts');
const permissions = require('../services/calls/permissions');
const recordings = require('../services/calls/recordings');
const flow = require('../services/calls/callFlow');
const routing = require('../services/calls/routing');

async function loadChatForUser(req, res) {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) { res.status(404).json({ success: false, error: 'Chat not found' }); return null; }
  if (!routing.isAdmin(req.user) && String(chat.assignedTo) !== String(req.user._id)) {
    res.status(403).json({ success: false, error: 'Forbidden' }); return null;
  }
  return chat;
}

/** GET /api/calls/me/sip — the logged-in user's calling account for the web/Android softphone. */
async function mySip(req, res, next) {
  try {
    const cfg = callingConfig.get();
    if (!cfg.enabled) return res.json({ success: true, enabled: false });
    const cred = await sip.getCredentials(req.user._id);
    if (!cred) return res.status(403).json({ success: false, error: 'Calling is not available for this user' });
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true, enabled: true,
      wssUrl: cfg.wssUrl, domain: cfg.sipDomain,
      uri: `sip:${cred.username}@${cfg.sipDomain}`,
      username: cred.username, password: cred.password, displayName: cred.displayName,
      iceServers: cfg.iceServers,
    });
  } catch (e) { next(e); }
}

/** GET /api/calls/:chatId/status — can the current user call this chat now? (drives the green/red button) */
async function chatStatus(req, res, next) {
  try {
    const chat = await loadChatForUser(req, res); if (!chat) return;
    const perm = await permissions.getPermission(chat.phoneNumberId, chat.waId);
    const reason = await flow.outboundBlockReason(req.user, chat);
    const p = perm || {};
    res.json({
      success: true,
      canCall: !reason,
      reason,
      dialTarget: `chat-${chat._id}`,
      permission: permissions.describe(perm),
      permissionRequest: routing.permissionValid(perm) ? { allowed: false, reason: 'Already allowed' } : routing.permissionRequestAllowed(p.requests || []),
      callingEnabledOnNumber: callingConfig.get().phoneNumberIds.includes(chat.phoneNumberId),
    });
  } catch (e) { next(e); }
}

/** POST /api/calls/:chatId/request-permission — send WhatsApp's "allow calls" request (Meta limits: 1/day, 2/week). */
async function requestPermission(req, res, next) {
  try {
    const chat = await loadChatForUser(req, res); if (!chat) return;
    if (!callingConfig.get().phoneNumberIds.includes(chat.phoneNumberId)) {
      return res.status(400).json({ success: false, error: 'WhatsApp calling is not enabled on this business number.' });
    }
    const message = await permissions.requestPermission({ chat, user: req.user, bodyText: req.body?.text });
    try { require('../websocket/socket.server').getIO().emit('message:new', { chatId: String(chat._id), message }); } catch (_) { /* ignore */ }
    res.json({ success: true, message });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ success: false, error: e.message });
    next(e);
  }
}

/** POST /api/calls/:chatId/initiate — pre-flight check; the softphone then dials `dialTarget` itself over SIP. */
async function initiate(req, res, next) {
  try {
    const chat = await loadChatForUser(req, res); if (!chat) return;
    const reason = await flow.outboundBlockReason(req.user, chat);
    if (reason) return res.status(409).json({ success: false, error: reason });
    res.json({ success: true, dialTarget: `chat-${chat._id}` });
  } catch (e) { next(e); }
}

/** POST /api/calls/:callLogId/decline — stop ringing on all my devices (assigned staff: everyone rings now). */
async function declineCall(req, res, next) {
  try {
    const r = await flow.decline({ callLogId: req.params.callLogId, user: req.user });
    if (!r.ok) return res.status(r.status || 400).json({ success: false, error: r.error });
    res.json({ success: true, ...r });
  } catch (e) { next(e); }
}

const LOG_POPULATE = [
  { path: 'answeredBy', select: 'name' },
  { path: 'initiatedBy', select: 'name' },
  { path: 'chatId', select: 'waId contactId assignedTo', populate: { path: 'contactId', select: 'name nickname nameOnWhatsApp' } },
];

/** GET /api/calls/:chatId/logs */
async function chatLogs(req, res, next) {
  try {
    const chat = await loadChatForUser(req, res); if (!chat) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const logs = await CallLog.find({ chatId: chat._id }).sort({ createdAt: -1 }).limit(limit)
      .select('-metadata.plan').populate(LOG_POPULATE).lean();
    res.json({ success: true, data: logs });
  } catch (e) { next(e); }
}

/** GET /api/calls/logs — admins: all calls; staff: calls on their chats or that they answered/made. */
async function allLogs(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.wabaId) filter.wabaId = req.query.wabaId;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    if (!routing.isAdmin(req.user)) {
      const myChats = await Chat.find({ assignedTo: req.user._id }).distinct('_id');
      filter.$or = [{ chatId: { $in: myChats } }, { answeredBy: req.user._id }, { initiatedBy: req.user._id }];
    }
    const [data, total] = await Promise.all([
      CallLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-metadata.plan').populate(LOG_POPULATE).lean(),
      CallLog.countDocuments(filter),
    ]);
    res.json({ success: true, data, total, page, limit });
  } catch (e) { next(e); }
}

async function canAccessCallLog(user, callLog) {
  if (routing.isAdmin(user)) return true;
  if ([callLog.answeredBy, callLog.initiatedBy].map(String).includes(String(user._id))) return true;
  if (!callLog.chatId) return false;
  const chat = await Chat.findById(callLog.chatId).select('assignedTo').lean();
  return !!chat && String(chat.assignedTo) === String(user._id);
}

/** GET /api/calls/:callLogId/recording-url — short-lived link for <audio src>. */
async function recordingUrl(req, res, next) {
  try {
    const callLog = await CallLog.findById(req.params.callLogId).lean();
    if (!callLog) return res.status(404).json({ success: false, error: 'Call not found' });
    if (!(await canAccessCallLog(req.user, callLog))) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (callLog.recording?.status !== 'ready') return res.status(404).json({ success: false, error: 'No recording', recordingStatus: callLog.recording?.status || 'none' });
    const token = recordings.signToken(callLog._id, req.user._id);
    res.json({ success: true, url: `/api/calls/recordings/${callLog._id}?t=${encodeURIComponent(token)}`, expiresIn: 3600, durationSec: callLog.recording.durationSec });
  } catch (e) { next(e); }
}

/** GET /api/calls/recordings/:callLogId?t=<token> — streams the file (supports Range). No JWT: the signed token is the auth. */
async function streamRecording(req, res, next) {
  try {
    const ok = recordings.verifyToken(req.query.t, req.params.callLogId);
    if (!ok) return res.status(403).json({ success: false, error: 'Link expired or invalid' });
    const callLog = await CallLog.findById(req.params.callLogId).select('recording').lean();
    const file = callLog?.recording?.path && recordings.resolveFile(callLog.recording.path);
    if (!file) return res.status(404).json({ success: false, error: 'Recording not found' });
    res.set('Cache-Control', 'private, max-age=3600');
    // The web panel (chat.biswakarmagold.com) plays this in an <audio> element (no-cors); Helmet's default
    // Cross-Origin-Resource-Policy: same-origin makes the browser drop it. 'same-site' is not reliable either
    // (Chromium refused it in testing), and access is already guarded by the signed, expiring token in the URL.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(file);
  } catch (e) { next(e); }
}

module.exports = { declineCall, mySip, chatStatus, requestPermission, initiate, chatLogs, allLogs, recordingUrl, streamRecording };
