const { Waba, Chat, CallLog } = require('../models');
const whatsappService = require('./whatsapp.service');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const config = require('../config');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { createMetaCalls } = require('./calls/metaCalls');
const { createBridgeClient } = require('./calls/bridgeClient');
const { parseCallsChange } = require('./calls/webhookParser');

const BASE_URL = `https://graph.facebook.com/${config.meta.apiVersion}`;

let cachedMetaCalls;
let cachedBridgeClient;

function getMetaCalls() {
  if (!cachedMetaCalls) {
    cachedMetaCalls = createMetaCalls({
      getToken: whatsappService.getAccessToken,
      apiVersion: config.meta.apiVersion,
    });
  }
  return cachedMetaCalls;
}

function getBridgeClient() {
  if (cachedBridgeClient) return cachedBridgeClient;
  const baseUrl = process.env.BRIDGE_BASE_URL || process.env.BRIDGE_URL || 'http://127.0.0.1:8090';
  const secret = process.env.BRIDGE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('BRIDGE_SECRET must be configured (min 32 chars) to use calling media bridge');
  }
  cachedBridgeClient = createBridgeClient({ baseUrl, secret });
  return cachedBridgeClient;
}

function getLiveKitConfig() {
  const livekitUrl = process.env.LIVEKIT_URL;
  const livekitApiKey = process.env.LIVEKIT_API_KEY;
  const livekitApiSecret = process.env.LIVEKIT_API_SECRET;
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required for web call audio');
  }
  return { livekitUrl, livekitApiKey, livekitApiSecret };
}

function emitCallEvent(name, payload, userId) {
  try {
    const io = getIO();
    if (userId) {
      io.to(`user:${String(userId)}`).emit(name, payload);
    } else {
      io.emit(name, payload);
    }
  } catch (e) {
    logger.warn(`Socket emit failed for ${name}: ${e.message}`);
  }
}

function normalizeMetaError(error) {
  const metaMessage = error?.response?.data?.error?.message;
  const message = metaMessage || error.message || 'Meta API request failed';
  const status = error?.response?.status || 500;
  return { message, status, raw: error?.response?.data || error.message };
}

async function graphGet(token, path, params = {}) {
  const res = await axios.get(`${BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 20000,
  });
  return res.data;
}

function toMetaDirection(direction) {
  const v = String(direction || '').toUpperCase();
  if (v === 'USER_INITIATED') return 'inbound';
  if (v === 'BUSINESS_INITIATED') return 'outbound';
  return null;
}

async function resolveCallLog(callId, callbackData) {
  let callLog = null;
  if (callId) callLog = await CallLog.findOne({ callId });
  if (!callLog && callbackData) {
    try {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(callbackData)) {
        callLog = await CallLog.findById(callbackData);
      }
    } catch (_) {}
  }
  return callLog;
}

/**
 * Check if a WABA number is ready for Cloud API calling.
 * This is used by the frontend to explain Meta error 2593151 with actionable details.
 */
async function getCallingReadiness(wabaId, phoneNumberId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');

  const token = await whatsappService.getAccessToken(wabaId);
  const checks = {
    wabaSubscribedToApp: null,
    callsFieldSubscribed: null,
    cloudApiOnly: null,
    messagingLimitEligible: null,
    callingEnabled: null,
    messagingPermission: null,
  };
  const blockers = [];
  const warnings = [];
  const diagnostics = {};

  let subscribedApps;
  try {
    subscribedApps = await graphGet(token, `${waba.wabaId}/subscribed_apps`);
    const apps = Array.isArray(subscribedApps?.data) ? subscribedApps.data : [];
    const appMatch = apps.find((a) => {
      const appId = a?.whatsapp_business_api_data?.id || a?.id;
      return config.meta.appId ? String(appId) === String(config.meta.appId) : true;
    });

    checks.wabaSubscribedToApp = !!appMatch;
    if (!checks.wabaSubscribedToApp) {
      blockers.push('App is not subscribed to this WhatsApp Business Account.');
      logger.warn(`WABA ${wabaId}: App ${config.meta.appId} not subscribed. Available apps: ${apps.map(a => a?.id).join(', ')}`);
    }

    const fields = appMatch?.subscribed_fields || [];
    checks.callsFieldSubscribed = fields.includes('calls');
    
    if (!checks.callsFieldSubscribed) {
      // IMPORTANT: Don't hard-fail on this. The subscription might be delayed or the API might be returning stale data.
      // Instead, only warn if we're sure it's missing. Allow to proceed if we have any evidence of success.
      const callsFieldWarning = `Webhook field "calls" not currently visible in subscribed_fields: [${fields.join(', ')}]`;
      if (fields.length === 0) {
        // Only block if there are NO subscribed fields (likely unsubscribed)
        blockers.push(callsFieldWarning);
      } else {
        // If other fields are there, just warn - calls might be in progress
        warnings.push(callsFieldWarning);
      }
      logger.warn(`WABA ${wabaId}: Calls field check - subscribed: ${fields.join(', ')}`);
    } else {
      logger.info(`WABA ${wabaId}: Calls field successfully subscribed`);
    }

    diagnostics.subscribedApps = apps.map((a) => ({
      app: a?.whatsapp_business_api_data?.name || a?.id,
      appId: a?.whatsapp_business_api_data?.id || a?.id,
      fields: a?.subscribed_fields || [],
    }));
  } catch (error) {
    const e = normalizeMetaError(error);
    warnings.push(`Could not verify subscribed apps: ${e.message}`);
    logger.warn(`WABA ${wabaId}: Failed to check subscribed apps: ${e.message}`);
  }

  try {
    const info = await graphGet(token, `${phoneNumberId}`, {
      fields: 'platform_type,is_on_biz_app,messaging_limit_tier,status,quality_rating,display_phone_number',
    });
    diagnostics.phoneInfo = info;
    const coexistence = info.is_on_biz_app === true;
    checks.cloudApiOnly = !coexistence;
    if (!checks.cloudApiOnly) {
      blockers.push('This number is in WhatsApp Business App coexistence mode. Calling requires Cloud API-only number.');
      logger.warn(`Phone ${phoneNumberId}: In coexistence mode (is_on_biz_app=true)`);
    }
    const tier = String(info.messaging_limit_tier || '');
    // TIER_1K, TIER_10K, TIER_100K are eligible; TIER_50, TIER_250 are not
    checks.messagingLimitEligible = /TIER_(1K|10K|100K|UNLIMITED)$/i.test(tier);
    if (!checks.messagingLimitEligible) {
      blockers.push(`Messaging limit tier "${tier}" is below calling requirement (needs TIER_1K or higher).`);
      logger.warn(`Phone ${phoneNumberId}: Messaging tier ${tier} insufficient for calling`);
    } else {
      logger.info(`Phone ${phoneNumberId}: Messaging tier ${tier} supports calling`);
    }
  } catch (error) {
    const e = normalizeMetaError(error);
    warnings.push(`Could not verify phone number status: ${e.message}`);
    logger.warn(`Phone ${phoneNumberId}: Failed to check status: ${e.message}`);
  }

  try {
    const settings = await graphGet(token, `${phoneNumberId}/settings`);
    const status = settings?.calling?.status || settings?.status || null;
    checks.callingEnabled = String(status || '').toUpperCase() === 'ENABLED';
    diagnostics.callingSettings = settings?.calling || settings;
    if (!checks.callingEnabled) {
      blockers.push(`Calling is currently disabled (status: ${status}). Enable it in phone number settings.`);
      logger.warn(`Phone ${phoneNumberId}: Calling disabled, status=${status}`);
    } else {
      logger.info(`Phone ${phoneNumberId}: Calling enabled`);
    }
  } catch (error) {
    const e = normalizeMetaError(error);
    warnings.push(`Could not read calling settings: ${e.message}`);
    logger.warn(`Phone ${phoneNumberId}: Failed to check calling settings: ${e.message}`);
  }

  try {
    await graphGet(token, `${phoneNumberId}`, { fields: 'id' });
    checks.messagingPermission = true;
    logger.info(`WABA ${wabaId}: Has messaging permission for phone ${phoneNumberId}`);
  } catch (error) {
    const e = normalizeMetaError(error);
    checks.messagingPermission = false;
    blockers.push(`Missing app permission to access this number: ${e.message}`);
    logger.error(`WABA ${wabaId}: Missing permission for phone ${phoneNumberId}: ${e.message}`);
  }

  // Allow calling if core checks pass, even if some metadata is unavailable
  const essentialChecksPassed = 
    checks.wabaSubscribedToApp === true &&
    checks.cloudApiOnly === true &&
    checks.messagingPermission === true;
  
  const ready = essentialChecksPassed && checks.messagingLimitEligible !== false && checks.callingEnabled !== false;
  
  return {
    ready,
    checks,
    blockers: ready ? [] : blockers,
    warnings,
    metaErrorHint: ready
      ? null
      : 'Error 2593151: Ensure webhook "calls" field is subscribed, calling is enabled on the phone, and number meets messaging tier requirements.',
    docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api/calling#step-1-prerequisites',
    diagnostics,
  };
}

async function requestCallPermission(wabaId, phoneNumberId, to, userId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');

  const chat = await Chat.findOne({ wabaId, waId: to });
  const callLog = await CallLog.create({
    chatId: chat?._id,
    wabaId,
    phoneNumberId,
    waId: to,
    direction: 'outbound',
    status: 'permission_requested',
    initiatedBy: userId,
    startedAt: new Date(),
  });

  try {
    const res = await getMetaCalls().requestPermission(wabaId, phoneNumberId, {
      to,
      text: 'We would like to call you to assist with your inquiry. Please grant permission to receive our call.',
    });
    logger.info(`Call permission request sent to ${to}, response: ${JSON.stringify(res)}`);
    emitCallEvent('call:permission_requested', {
      chatId: chat?._id?.toString(),
      callLog,
    });
    return callLog;
  } catch (error) {
    callLog.status = 'failed';
    callLog.metadata = { error: error.response?.data || error.message };
    await callLog.save();
    logger.error(`Call permission request failed for ${to}:`, error.response?.data || error.message);
    throw error;
  }
}

async function initiateCall(wabaId, phoneNumberId, to, userId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');

  const chat = await Chat.findOne({ wabaId, waId: to });
  const callLog = await CallLog.create({
    chatId: chat?._id,
    wabaId,
    phoneNumberId,
    waId: to,
    direction: 'outbound',
    status: 'ringing',
    initiatedBy: userId,
    startedAt: new Date(),
  });

  try {
    const bridge = getBridgeClient();
    const bridgeSessionId = callLog._id.toString();
    const sdpOffer = await bridge.outbound(bridgeSessionId);
    const res = await getMetaCalls().connect(wabaId, phoneNumberId, {
      to,
      sdpOffer,
      bizData: bridgeSessionId,
    });

    const callId = res?.calls?.[0]?.id || res?.id;
    if (callId) callLog.callId = callId;
    callLog.metadata = {
      ...(callLog.metadata || {}),
      bridgeSessionId,
      room: bridge.roomFor(bridgeSessionId),
      signaling: 'graph-webhook',
    };
    await callLog.save();

    logger.info(`Outbound call initiated to ${to}, callId: ${callId || 'pending'}`);
    emitCallEvent('call:outgoing', {
      chatId: chat?._id?.toString(),
      callLog,
    });
    return callLog;
  } catch (error) {
    callLog.status = 'failed';
    callLog.metadata = { error: error.response?.data || error.message };
    await callLog.save();
    logger.error(`Outbound call failed to ${to}:`, error.response?.data || error.message);
    throw error;
  }
}

async function terminateCall(wabaId, phoneNumberId, callId) {
  try {
    await getMetaCalls().terminate(wabaId, phoneNumberId, { callId });

    const callLog = await CallLog.findOneAndUpdate(
      { callId },
      { $set: { status: 'terminated', endedAt: new Date() } },
      { new: true }
    );

    if (callLog?.answeredAt) {
      callLog.duration = Math.round((callLog.endedAt - callLog.answeredAt) / 1000);
      await callLog.save();
    }

    const bridgeSessionId = callLog?.metadata?.bridgeSessionId || callId;
    try {
      await getBridgeClient().terminate(bridgeSessionId);
    } catch (bridgeErr) {
      logger.warn(`Bridge terminate failed for ${bridgeSessionId}: ${bridgeErr.message}`);
    }

    emitCallEvent('call:terminated', {
      chatId: callLog?.chatId?.toString(),
      callLog,
    });
    return callLog;
  } catch (error) {
    logger.error(`Failed to terminate call ${callId}:`, error.response?.data || error.message);
    throw error;
  }
}

async function processCallWebhook(entry) {
  try {
    const wabaIdMeta = entry.id;
    const waba = await Waba.findOne({ wabaId: wabaIdMeta });
    if (!waba) {
      logger.warn(`WABA not found for call webhook, ID: ${wabaIdMeta}`);
      return;
    }

    for (const change of entry?.changes || []) {
      if (change?.field !== 'calls') continue;
      const events = parseCallsChange(change);
      for (const ev of events) {
        await handleCallEvent(waba, ev.phoneNumberId, ev.raw, ev);
      }
    }
  } catch (error) {
    logger.error('Error processing call webhook:', error);
  }
}

async function handleCallEvent(waba, phoneNumberId, call, parsedEvent = null) {
  const callId = call.id || call.call_id;
  const from = call.from;
  const to = call.to;
  const status = call.status;
  const direction = parsedEvent?.direction || toMetaDirection(call.direction);
  const callbackData = call.biz_opaque_callback_data;
  const eventType = String(call.event || parsedEvent?.type || '').toLowerCase();
  const sdp = call.session?.sdp || parsedEvent?.sdp || null;

  logger.info(`Call webhook event: callId=${callId}, event=${eventType || 'status'}, status=${status}, direction=${direction}, from=${from}`);

  let callLog = await resolveCallLog(callId, callbackData);
  const customerWaId = direction === 'inbound' ? from : to;
  const chat = await Chat.findOne({ wabaId: waba._id, waId: customerWaId });

  if (!callLog) {
    callLog = await CallLog.create({
      chatId: chat?._id,
      wabaId: waba._id,
      phoneNumberId,
      callId,
      waId: customerWaId,
      direction: direction || 'inbound',
      status: mapMetaStatus(status),
      startedAt: new Date(),
      metadata: callbackData ? { bridgeSessionId: callbackData } : undefined,
    });
  } else {
    if (callId && !callLog.callId) callLog.callId = callId;
    if (status) callLog.status = mapMetaStatus(status);
  }

  const bridgeSessionId = callLog?.metadata?.bridgeSessionId || callbackData || callId;
  const lowerStatus = String(status || '').toLowerCase();

  if (eventType === 'connect' && direction === 'inbound') {
    try {
      const bridge = getBridgeClient();
      if (!sdp) {
        logger.warn(`No SDP in connect event for call ${callId}; attempting bridge setup with empty SDP payload`);
      }
      const answer = await bridge.inbound(bridgeSessionId, sdp);
      await getMetaCalls().preAccept(waba._id, phoneNumberId, { callId, sdpAnswer: answer });
      await getMetaCalls().accept(waba._id, phoneNumberId, { callId, sdpAnswer: answer, bizData: bridgeSessionId });
      callLog.status = 'ringing';
      callLog.metadata = {
        ...(callLog.metadata || {}),
        bridgeSessionId,
        room: bridge.roomFor(bridgeSessionId),
        signaling: 'graph-webhook',
        autoAnsweredByBridge: true,
      };
    } catch (err) {
      callLog.status = 'failed';
      callLog.metadata = {
        ...(callLog.metadata || {}),
        bridgeSessionId,
        connectError: err.message,
      };
      logger.error(`Inbound connect handling failed for ${callId}: ${err.message}`);
    }
  }

  if (eventType === 'connect' && direction === 'outbound' && sdp) {
    try {
      await getBridgeClient().answer(bridgeSessionId, sdp);
      callLog.metadata = {
        ...(callLog.metadata || {}),
        bridgeSessionId,
      };
    } catch (err) {
      logger.warn(`Outbound SDP answer apply failed for ${bridgeSessionId}: ${err.message}`);
      callLog.metadata = {
        ...(callLog.metadata || {}),
        bridgeSessionId,
        answerApplyError: err.message,
      };
    }
  }

  switch (lowerStatus) {
    case 'ringing':
      if (!callLog.startedAt) callLog.startedAt = new Date();
      break;
    case 'accepted':
    case 'in_progress':
      callLog.answeredAt = new Date();
      break;
    case 'terminated':
    case 'ended':
    case 'completed':
      callLog.endedAt = new Date();
      if (callLog.answeredAt) {
        callLog.duration = Math.round((callLog.endedAt - callLog.answeredAt) / 1000);
      }
      break;
    case 'rejected':
    case 'missed':
    case 'no_answer':
      callLog.endedAt = new Date();
      callLog.duration = 0;
      break;
  }

  if (eventType === 'terminate' || ['terminated', 'ended', 'completed', 'rejected', 'missed', 'no_answer'].includes(lowerStatus)) {
    try {
      await getBridgeClient().terminate(bridgeSessionId);
    } catch (err) {
      logger.warn(`Bridge cleanup failed for ${bridgeSessionId}: ${err.message}`);
    }
  }

  callLog.metadata = {
    ...(callLog.metadata || {}),
    bridgeSessionId,
    lastEventType: eventType || null,
    lastEvent: status,
    rawPayload: call,
  };

  await callLog.save();

  const eventData = {
    chatId: chat?._id?.toString(),
    callLog: callLog.toObject(),
  };
  if (lowerStatus === 'ringing' && (direction === 'inbound' || !direction)) {
    emitCallEvent('call:incoming', eventData);
  } else if (['terminated', 'ended', 'completed', 'rejected', 'missed', 'no_answer'].includes(lowerStatus) || eventType === 'terminate') {
    emitCallEvent('call:terminated', eventData);
  } else {
    emitCallEvent('call:status', eventData);
  }
}

function mapMetaStatus(metaStatus) {
  if (!metaStatus) return 'ringing';
  const map = {
    ringing: 'ringing',
    accepted: 'accepted',
    in_progress: 'accepted',
    rejected: 'rejected',
    terminated: 'terminated',
    ended: 'terminated',
    completed: 'terminated',
    missed: 'missed',
    no_answer: 'missed',
    failed: 'failed',
  };
  return map[String(metaStatus).toLowerCase()] || 'ringing';
}

async function acceptIncomingCall(callLogId, user) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog) throw new Error('Call log not found');
  if (callLog.direction !== 'inbound') throw new Error('Only inbound calls can be accepted from staff UI');
  if (['rejected', 'terminated', 'missed', 'failed'].includes(callLog.status)) {
    throw new Error(`Cannot accept call in ${callLog.status} state`);
  }

  callLog.status = 'accepted';
  callLog.answeredAt = callLog.answeredAt || new Date();
  callLog.metadata = {
    ...(callLog.metadata || {}),
    answeredBy: user?._id?.toString() || null,
    answeredByName: user?.name || null,
  };
  await callLog.save();

  emitCallEvent('call:status', {
    chatId: callLog.chatId?.toString(),
    callLog: callLog.toObject(),
  });
  return callLog;
}

async function rejectIncomingCall(callLogId) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog) throw new Error('Call log not found');
  if (callLog.direction !== 'inbound') throw new Error('Only inbound calls can be rejected from staff UI');

  if (callLog.callId) {
    try {
      await getMetaCalls().reject(callLog.wabaId, callLog.phoneNumberId, { callId: callLog.callId });
    } catch (err) {
      logger.warn(`Meta reject failed for ${callLog.callId}: ${err.message}`);
    }
  }
  try {
    const bridgeSessionId = callLog?.metadata?.bridgeSessionId || callLog.callId;
    if (bridgeSessionId) await getBridgeClient().terminate(bridgeSessionId);
  } catch (err) {
    logger.warn(`Bridge reject cleanup failed for ${callLog.callId}: ${err.message}`);
  }

  callLog.status = 'rejected';
  callLog.endedAt = new Date();
  callLog.duration = 0;
  await callLog.save();

  emitCallEvent('call:terminated', {
    chatId: callLog.chatId?.toString(),
    callLog: callLog.toObject(),
  });
  return callLog;
}

async function createMediaSession(callLogId, user) {
  const callLog = await CallLog.findById(callLogId);
  if (!callLog) throw new Error('Call log not found');

  const bridgeSessionId = callLog?.metadata?.bridgeSessionId || callLog.callId;
  if (!bridgeSessionId) {
    throw new Error('Bridge session is not initialized for this call yet');
  }

  const { livekitUrl, livekitApiKey, livekitApiSecret } = getLiveKitConfig();
  const identity = `staff-${String(user?._id || 'unknown')}`;
  const room = `call-${bridgeSessionId}`;
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: livekitApiKey,
      sub: identity,
      nbf: now - 10,
      exp: now + 60 * 60,
      video: {
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
      metadata: JSON.stringify({ callLogId: callLog._id.toString(), userId: String(user?._id || '') }),
    },
    livekitApiSecret,
    { algorithm: 'HS256' }
  );

  return {
    room,
    livekitUrl,
    token,
    identity,
  };
}

async function getCallLogsByChat(chatId, options = {}) {
  const { page = 1, limit = 50 } = options;
  const skip = (page - 1) * limit;
  const [logs, total] = await Promise.all([
    CallLog.find({ chatId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('initiatedBy', 'name')
      .lean(),
    CallLog.countDocuments({ chatId }),
  ]);
  return { logs, total, page, limit };
}

async function getAllCallLogs(options = {}) {
  const { page = 1, limit = 50, wabaId, direction, status } = options;
  const skip = (page - 1) * limit;
  const filter = {};
  if (wabaId) filter.wabaId = wabaId;
  if (direction) filter.direction = direction;
  if (status) filter.status = status;

  const [logs, total] = await Promise.all([
    CallLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('chatId', 'waId phoneNumber')
      .populate('initiatedBy', 'name')
      .lean(),
    CallLog.countDocuments(filter),
  ]);
  return { logs, total, page, limit };
}

module.exports = {
  getCallingReadiness,
  requestCallPermission,
  initiateCall,
  terminateCall,
  processCallWebhook,
  acceptIncomingCall,
  rejectIncomingCall,
  createMediaSession,
  getCallLogsByChat,
  getAllCallLogs,
};
