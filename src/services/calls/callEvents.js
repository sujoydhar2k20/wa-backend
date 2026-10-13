'use strict';

/**
 * Messages that WhatsApp generates because of a call, not because the customer wrote something.
 *
 * When a customer calls the business, Meta also delivers a "messages" webhook (an automatic
 * call_permission_reply: calling the business grants call permission). Those are stored in the chat
 * for the record, but must not start bot flows, the open-conversation bot, product-code replies or
 * the AI fallback - the staff member is answering the call.
 */
const { CallLog } = require('../../models');

const RECENT_CALL_MS = 3 * 60 * 1000;

/** Pure: is this webhook message call-generated? [recentInboundCall] = an inbound call to this customer is live or just happened. */
function isCallGeneratedMessage({ msg, messageData, recentInboundCall = false }) {
  if (!msg) return false;
  if (messageData?.metadata?.kind === 'call_permission_reply') return true;
  if (msg.type === 'interactive' && msg.interactive?.type === 'call_permission_reply') return true;
  if (msg.type === 'call') return true;
  // Placeholders Meta may send around a call (no customer text): only while/just after a call.
  if (recentInboundCall && (msg.type === 'unsupported' || msg.type === 'system')) return true;
  return false;
}

async function hasRecentInboundCall({ phoneNumberId, waId, now = Date.now() }) {
  if (!waId) return false;
  try {
    const since = new Date(now - RECENT_CALL_MS);
    const found = await CallLog.exists({
      waId: String(waId).replace(/\D/g, ''),
      ...(phoneNumberId ? { phoneNumberId } : {}),
      direction: 'inbound',
      $or: [{ status: { $in: ['ringing', 'accepted'] }, endedAt: null }, { createdAt: { $gte: since } }, { endedAt: { $gte: since } }],
    });
    return !!found;
  } catch (_) {
    return false;
  }
}

module.exports = { isCallGeneratedMessage, hasRecentInboundCall, RECENT_CALL_MS };
