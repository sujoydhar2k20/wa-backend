'use strict';

/** Customer call permissions: stored from WhatsApp's call_permission_reply, requested within Meta's limits. */
const CallPermission = require('../../models/CallPermission');
const Message = require('../../models/Message');
const whatsappService = require('../whatsapp.service');
const { logger } = require('../../utils/logger');
const { permissionValid, permissionRequestAllowed } = require('./routing');

async function getPermission(phoneNumberId, waId) {
  return CallPermission.findOne({ phoneNumberId, waId }).lean();
}

/** Called from the messages webhook when interactive.type === 'call_permission_reply'. */
async function recordReply({ wabaId, phoneNumberId, waId, reply }) {
  if (!reply || !phoneNumberId || !waId) return null;
  const accepted = String(reply.response).toLowerCase() === 'accept';
  const exp = reply.expiration_timestamp ? new Date(Number(reply.expiration_timestamp) * 1000) : undefined;
  const doc = await CallPermission.findOneAndUpdate(
    { phoneNumberId, waId },
    {
      $set: {
        wabaId,
        status: accepted ? 'granted' : 'declined',
        isPermanent: accepted && !!reply.is_permanent,
        expiresAt: accepted ? exp : undefined,
        source: reply.response_source || 'user_action',
        lastReplyAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  logger.info(`[calls] permission ${doc.status} for ${waId} on ${phoneNumberId} (${doc.source}${doc.isPermanent ? ', permanent' : ''})`);
  return doc;
}

function describe(perm) {
  if (permissionValid(perm)) {
    return { status: 'granted', isPermanent: !!perm.isPermanent, expiresAt: perm.expiresAt || null };
  }
  if (perm?.status === 'declined') return { status: 'declined' };
  if (perm?.status === 'granted') return { status: 'expired', expiresAt: perm.expiresAt || null };
  return { status: 'none' };
}

/** Send the WhatsApp "allow calls" request to the chat's customer. Throws {statusCode, message} on refusal. */
async function requestPermission({ chat, user, bodyText }) {
  const perm = await getPermission(chat.phoneNumberId, chat.waId);
  if (permissionValid(perm)) { const e = new Error('The customer has already allowed calls.'); e.statusCode = 409; throw e; }
  const allowed = permissionRequestAllowed(perm?.requests || []);
  if (!allowed.ok) { const e = new Error(allowed.reason); e.statusCode = 429; throw e; }

  const text = bodyText || 'We would like to call you on WhatsApp. Please allow calls from us.';
  const res = await whatsappService.sendInteractiveMessage(chat.wabaId, chat.phoneNumberId, chat.waId, {
    type: 'call_permission_request',
    action: { name: 'call_permission_request' },
    body: { text },
  });
  const messageId = res?.messages?.[0]?.id;
  await CallPermission.findOneAndUpdate(
    { phoneNumberId: chat.phoneNumberId, waId: chat.waId },
    { $set: { wabaId: chat.wabaId }, $push: { requests: { at: new Date(), by: user._id, messageId } } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  const msg = await Message.create({
    chatId: chat._id, wabaId: chat.wabaId, phoneNumberId: chat.phoneNumberId, waId: chat.waId,
    messageId, direction: 'outbound', type: 'interactive', status: 'sent', sentBy: user._id,
    text: `📞 Call permission request: ${text}`,
    metadata: { kind: 'call_permission_request' },
  });
  return msg;
}

module.exports = { getPermission, recordReply, requestPermission, describe };
