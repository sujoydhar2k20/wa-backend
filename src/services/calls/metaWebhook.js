'use strict';

/**
 * Meta "calls" webhooks for SIP-enabled numbers (webhook_delivery ENABLED):
 *   event "call_created" when a call is attempted, event "terminate" when it ends.
 * They are informational: Asterisk drives the call. We use them to attach Meta's call id (wacid)
 * and Meta's own duration/status/errors to our CallLog.
 */
const { Waba, CallLog } = require('../../models');
const { logger } = require('../../utils/logger');

const ts = (v) => (v ? new Date(Number(v) * 1000) : undefined);
const digits = (v) => String(v || '').replace(/\D/g, '');

async function findCallLog(call, phoneNumberId) {
  if (call.id) {
    const byId = await CallLog.findOne({ callId: call.id });
    if (byId) return byId;
  }
  // Business-initiated calls: Asterisk does not see the wacid, so match the latest outbound call to that customer.
  const customer = digits(call.direction === 'BUSINESS_INITIATED' ? call.to : call.from);
  if (!customer) return null;
  const since = new Date(Date.now() - 15 * 60e3);
  return CallLog.findOne({
    phoneNumberId,
    waId: customer,
    direction: call.direction === 'BUSINESS_INITIATED' ? 'outbound' : 'inbound',
    createdAt: { $gt: since },
    $or: [{ callId: null }, { callId: { $exists: false } }, { callId: call.id }],
  }).sort({ createdAt: -1 });
}

async function processCallsChange(waba, value) {
  const phoneNumberId = value?.metadata?.phone_number_id;
  for (const call of value?.calls || []) {
    const callLog = await findCallLog(call, phoneNumberId);
    if (!callLog) {
      logger.info(`[calls] Meta ${call.event} for ${call.id} (${call.direction}) has no matching call log yet`);
      continue;
    }
    if (call.id && !callLog.callId) callLog.callId = call.id;
    if (call.event === 'terminate') {
      callLog.meta = {
        ...(callLog.meta || {}),
        status: call.status,
        duration: call.duration != null ? Number(call.duration) : undefined,
        startTime: ts(call.start_time),
        endTime: ts(call.end_time),
        errors: value.errors || undefined,
      };
    }
    await callLog.save();
  }
  for (const st of value?.statuses || []) {
    if (st.type !== 'call') continue;
    logger.info(`[calls] Meta call status ${st.status} for ${st.id}`);
  }
}

/** Entry point from the webhook controller for field === 'calls'. Handles every entry/change. */
async function processCallsWebhook(body) {
  for (const entry of body?.entry || []) {
    const waba = await Waba.findOne({ wabaId: entry.id }).select('_id').lean();
    if (!waba) { logger.warn(`[calls] calls webhook for unknown WABA ${entry.id}`); continue; }
    for (const change of entry.changes || []) {
      if (change.field !== 'calls') continue;
      try { await processCallsChange(waba, change.value); } catch (e) { logger.error(`[calls] calls webhook error: ${e.message}`); }
    }
  }
}

module.exports = { processCallsWebhook, _internals: { findCallLog } };
