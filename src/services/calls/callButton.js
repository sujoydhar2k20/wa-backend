'use strict';

/** Staff-sent "Call on WhatsApp" button (same interactive message as the missed-call message). */
const { CallLog, Message } = require('../../models');
const whatsappService = require('../whatsapp.service');
const callingConfig = require('./config');
const routing = require('./routing');

const DEFAULT_TEXT = 'You can call us on WhatsApp using the button below.';
const MAX_TEXT = 1024; // WhatsApp interactive body limit

/** When did the customer last open the 24 h window (message or call), and when did we last send a button? */
async function windowInfo(chat) {
  const [lastCall, lastButton] = await Promise.all([
    CallLog.findOne({ chatId: chat._id, direction: 'inbound' }).sort({ createdAt: -1 }).select('createdAt').lean(),
    Message.findOne({ chatId: chat._id, 'metadata.kind': 'call_button' }).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);
  const times = [chat.lastCustomerMessageAt, lastCall?.createdAt].filter(Boolean).map((d) => new Date(d).getTime());
  return {
    lastCustomerAt: times.length ? new Date(Math.max(...times)) : null,
    lastSentAt: lastButton?.createdAt || null,
  };
}

async function status(chat) {
  if (!callingConfig.get().phoneNumberIds.includes(chat.phoneNumberId)) {
    return { ok: false, reason: 'WhatsApp calling is not enabled on this business number.', defaultText: DEFAULT_TEXT };
  }
  return { ...routing.callButtonAllowed(await windowInfo(chat)), defaultText: DEFAULT_TEXT };
}

/** Throws {statusCode, message} when not allowed. Returns the stored chat message. */
async function send({ chat, user, text }) {
  const st = await status(chat);
  if (!st.ok) { const e = new Error(st.reason); e.statusCode = 409; throw e; }
  const body = String(text || '').trim() || DEFAULT_TEXT;
  if (body.length > MAX_TEXT) { const e = new Error(`Message is too long (max ${MAX_TEXT} characters).`); e.statusCode = 400; throw e; }
  const res = await whatsappService.sendInteractiveMessage(chat.wabaId, chat.phoneNumberId, chat.waId, {
    type: 'voice_call',
    body: { text: body },
    action: { name: 'voice_call', parameters: { display_text: 'Call on WhatsApp', ttl_minutes: 1440 } },
  });
  return Message.create({
    chatId: chat._id, wabaId: chat.wabaId, phoneNumberId: chat.phoneNumberId, waId: chat.waId,
    messageId: res?.messages?.[0]?.id, direction: 'outbound', type: 'interactive', status: 'sent', sentBy: user._id,
    text: body, metadata: { kind: 'call_button' },
  });
}

module.exports = { status, send, DEFAULT_TEXT };
