const { Waba, Chat, CallLog } = require('../models');
const whatsappService = require('./whatsapp.service');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const config = require('../config');

const BASE_URL = `https://graph.facebook.com/${config.meta.apiVersion}`;

/**
 * Send a call permission request to the customer.
 * This uses an interactive message asking the customer to allow calls.
 * The customer must approve before the business can place an outbound call.
 */
async function requestCallPermission(wabaId, phoneNumberId, to, userId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');

  // Find or create a CallLog for tracking
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

  // Send the permission request via the calls endpoint
  try {
    const token = await whatsappService.getAccessToken(wabaId);
    const axios = require('axios');
    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/\D/g, ''),
        type: 'interactive',
        interactive: {
          type: 'call_permission_request',
          body: {
            text: 'We would like to call you to assist with your inquiry. Please grant permission to receive our call.',
          },
          action: {
            name: 'call_permission_request',
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info(`Call permission request sent to ${to}, response: ${JSON.stringify(res.data)}`);

    // Emit socket event
    try {
      const io = getIO();
      io.emit('call:permission_requested', {
        chatId: chat?._id?.toString(),
        callLog,
      });
    } catch (e) {
      logger.warn('Socket emit failed for call permission:', e.message);
    }

    return callLog;
  } catch (error) {
    callLog.status = 'failed';
    callLog.metadata = { error: error.response?.data || error.message };
    await callLog.save();
    logger.error(`Call permission request failed for ${to}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Initiate an outbound call to the customer.
 * Requires prior call permission grant.
 */
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
    const token = await whatsappService.getAccessToken(wabaId);
    const axios = require('axios');
    const res = await axios.post(
      `${BASE_URL}/${phoneNumberId}/calls`,
      {
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'voice',
        action: 'connect',
        biz_opaque_callback_data: callLog._id.toString(),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const callId = res.data?.calls?.[0]?.id || res.data?.id;
    if (callId) {
      callLog.callId = callId;
      await callLog.save();
    }

    logger.info(`Outbound call initiated to ${to}, callId: ${callId}`);

    // Emit socket event
    try {
      const io = getIO();
      io.emit('call:outgoing', {
        chatId: chat?._id?.toString(),
        callLog,
      });
    } catch (e) {
      logger.warn('Socket emit failed for outgoing call:', e.message);
    }

    return callLog;
  } catch (error) {
    callLog.status = 'failed';
    callLog.metadata = { error: error.response?.data || error.message };
    await callLog.save();
    logger.error(`Outbound call failed to ${to}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Terminate an active call.
 */
async function terminateCall(wabaId, phoneNumberId, callId) {
  try {
    const token = await whatsappService.getAccessToken(wabaId);
    const axios = require('axios');
    await axios.post(
      `${BASE_URL}/${phoneNumberId}/calls`,
      {
        messaging_product: 'whatsapp',
        action: 'terminate',
        call_id: callId,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Update call log
    const callLog = await CallLog.findOneAndUpdate(
      { callId },
      {
        $set: {
          status: 'terminated',
          endedAt: new Date(),
        },
      },
      { new: true }
    );

    if (callLog?.answeredAt) {
      callLog.duration = Math.round((callLog.endedAt - callLog.answeredAt) / 1000);
      await callLog.save();
    }

    logger.info(`Call ${callId} terminated`);

    // Emit socket event
    try {
      const io = getIO();
      io.emit('call:terminated', {
        chatId: callLog?.chatId?.toString(),
        callLog,
      });
    } catch (e) {
      logger.warn('Socket emit failed for call termination:', e.message);
    }

    return callLog;
  } catch (error) {
    logger.error(`Failed to terminate call ${callId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Process incoming call webhook events from Meta.
 * The `calls` webhook field delivers events for the full call lifecycle.
 */
async function processCallWebhook(entry) {
  try {
    const changes = entry.changes[0];
    const value = changes.value;
    const wabaIdMeta = entry.id;

    const waba = await Waba.findOne({ wabaId: wabaIdMeta });
    if (!waba) {
      logger.warn(`WABA not found for call webhook, ID: ${wabaIdMeta}`);
      return;
    }

    const metadata = value.metadata || {};
    const phoneNumberId = metadata.phone_number_id;
    const callsData = value.calls || [];

    for (const call of callsData) {
      await handleCallEvent(waba, phoneNumberId, call);
    }
  } catch (error) {
    logger.error('Error processing call webhook:', error);
  }
}

/**
 * Handle a single call event from the webhook.
 */
async function handleCallEvent(waba, phoneNumberId, call) {
  const callId = call.id || call.call_id;
  const from = call.from;           // Customer's number (for inbound)
  const to = call.to;               // Business number (for inbound) or customer (for outbound)
  const status = call.status;       // ringing, accepted, rejected, terminated, etc.
  const direction = call.direction; // inbound or outbound
  const callbackData = call.biz_opaque_callback_data;

  logger.info(`Call webhook event: callId=${callId}, status=${status}, direction=${direction}, from=${from}`);

  // Try to find existing call log by callId or callback data
  let callLog = null;
  if (callId) {
    callLog = await CallLog.findOne({ callId });
  }
  if (!callLog && callbackData) {
    // callbackData might be our internal CallLog _id
    try {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(callbackData)) {
        callLog = await CallLog.findById(callbackData);
      }
    } catch (_) {}
  }

  const customerWaId = direction === 'inbound' ? from : to;

  // Find the associated chat
  const chat = await Chat.findOne({ wabaId: waba._id, waId: customerWaId });

  if (!callLog) {
    // New inbound call
    callLog = await CallLog.create({
      chatId: chat?._id,
      wabaId: waba._id,
      phoneNumberId,
      callId,
      waId: customerWaId,
      direction: direction || 'inbound',
      status: mapMetaStatus(status),
      startedAt: new Date(),
    });
  } else {
    // Update existing call log
    if (callId && !callLog.callId) {
      callLog.callId = callId;
    }
    callLog.status = mapMetaStatus(status);
  }

  // Update timestamps based on status
  switch (status?.toLowerCase()) {
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

  // Store any extra metadata
  callLog.metadata = {
    ...(callLog.metadata || {}),
    lastEvent: status,
    rawPayload: call,
  };

  await callLog.save();

  // Emit socket events for real-time UI updates
  try {
    const io = getIO();
    const eventData = {
      chatId: chat?._id?.toString(),
      callLog: callLog.toObject(),
    };

    if (status?.toLowerCase() === 'ringing' && (direction === 'inbound' || !direction)) {
      // Incoming call alert
      io.emit('call:incoming', eventData);
    } else if (['terminated', 'ended', 'completed', 'rejected', 'missed', 'no_answer'].includes(status?.toLowerCase())) {
      io.emit('call:terminated', eventData);
    } else {
      io.emit('call:status', eventData);
    }
  } catch (e) {
    logger.warn('Socket emit failed for call event:', e.message);
  }

  logger.info(`Call event processed: callId=${callId}, status=${callLog.status}, duration=${callLog.duration}s`);
}

/**
 * Map Meta's call status strings to our internal status enum.
 */
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
  return map[metaStatus.toLowerCase()] || 'ringing';
}

/**
 * Get call logs for a specific chat.
 */
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

/**
 * Get all call logs (admin view) with optional filters.
 */
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
  requestCallPermission,
  initiateCall,
  terminateCall,
  processCallWebhook,
  getCallLogsByChat,
  getAllCallLogs,
};
