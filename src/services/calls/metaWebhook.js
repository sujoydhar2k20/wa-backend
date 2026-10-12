'use strict';

/**
 * Meta "calls" webhooks for SIP-enabled numbers (webhook_delivery ENABLED):
 *   event "call_created" when a call is attempted, event "terminate" when it ends; error statuses.
 * Asterisk drives the call; these webhooks are our evidence of what Meta saw:
 *  - every event is stored as a CallEvent (90 days) with Meta's error codes and their meaning
 *  - Meta's call id (wacid), status, duration and errors are attached to our CallLog
 *  - a customer call that Meta ended as FAILED without it ever reaching Asterisk is recorded as a
 *    'failed' CallLog (endReason meta:<code>), so it shows in the Calls page and reports
 */
const { Waba, CallLog, CallEvent, Contact, Chat } = require('../../models');
const { logger } = require('../../utils/logger');
const { normaliseErrors } = require('./metaErrors');

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

const errText = (errors) => errors.map((e) => `${e.code ?? '?'}${e.meaning ? ` (${e.meaning})` : e.message ? ` (${e.message})` : ''}`).join('; ');

/** A customer call Meta failed before it reached us: record it so it is visible and counted. */
async function recordFailedBeforeUs(waba, phoneNumberId, call, errors) {
  const waId = digits(call.from);
  if (!waId) return null;
  const existing = await CallLog.findOne({ callId: call.id });
  if (existing) return existing;
  const chat = await Chat.findOne({ waId, phoneNumberId }).sort({ lastMessageAt: -1 }).select('_id').lean();
  const contact = await Contact.findOne({ waId }).select('name nickname nameOnWhatsApp').lean().catch(() => null);
  const code = errors.find((e) => e.code)?.code;
  return CallLog.create({
    chatId: chat?._id, wabaId: waba._id, phoneNumberId, waId, direction: 'inbound', status: 'failed',
    callId: call.id, startedAt: ts(call.start_time) || ts(call.timestamp) || new Date(), endedAt: ts(call.end_time) || new Date(),
    endReason: code ? `meta:${code}` : 'meta:failed',
    meta: { status: call.status, startTime: ts(call.start_time), endTime: ts(call.end_time), errors },
    metadata: { contactName: contact?.name || contact?.nickname || contact?.nameOnWhatsApp || `+${waId}`, failedAtMeta: true },
  });
}

async function processCallsChange(waba, value) {
  const phoneNumberId = value?.metadata?.phone_number_id;
  const valueErrors = normaliseErrors(value?.errors);
  for (const call of value?.calls || []) {
    const errors = normaliseErrors(call.errors, call.error, valueErrors.length ? value.errors : null);
    let callLog = await findCallLog(call, phoneNumberId);
    const failedAtMeta = !callLog && call.event === 'terminate' && call.direction !== 'BUSINESS_INITIATED'
      && String(call.status || '').toUpperCase() !== 'COMPLETED';
    if (failedAtMeta) callLog = await recordFailedBeforeUs(waba, phoneNumberId, call, errors).catch((e) => {
      logger.error(`[calls][meta] could not record failed call ${call.id}: ${e.message}`);
      return null;
    });

    await CallEvent.create({
      source: 'meta', callLogId: callLog?._id, wacid: call.id, phoneNumberId, waId: digits(call.from || call.to) || undefined,
      direction: call.direction, event: call.event || 'unknown', status: call.status, errorList: errors,
      at: ts(call.timestamp) || new Date(),
    }).catch((e) => logger.warn(`[calls][meta] event not stored: ${e.message}`));

    const line = `[calls][meta] ${call.event} wacid=${call.id || '-'} ${call.direction || ''} status=${call.status || '-'}`
      + `${errors.length ? ` errors=${errText(errors)}` : ''}${callLog ? ` calllog=${callLog._id}` : ' (no call reached our server)'}`;
    if (errors.length || failedAtMeta) logger.warn(line); else logger.info(line);

    if (!callLog || failedAtMeta) continue;
    if (call.id && !callLog.callId) callLog.callId = call.id;
    if (call.event === 'terminate') {
      callLog.meta = {
        ...(callLog.meta || {}),
        status: call.status,
        duration: call.duration != null ? Number(call.duration) : undefined,
        startTime: ts(call.start_time),
        endTime: ts(call.end_time),
        errors: errors.length ? errors : undefined,
      };
    }
    await callLog.save();
  }
  for (const st of value?.statuses || []) {
    if (st.type !== 'call') continue;
    const errors = normaliseErrors(st.errors);
    await CallEvent.create({
      source: 'meta', wacid: st.id, phoneNumberId, waId: digits(st.recipient_id) || undefined,
      event: `status:${st.status}`, status: st.status, errorList: errors, at: ts(st.timestamp) || new Date(),
    }).catch(() => {});
    const line = `[calls][meta] call status ${st.status} for ${st.id}${errors.length ? ` errors=${errText(errors)}` : ''}`;
    if (errors.length) logger.warn(line); else logger.info(line);
  }
  // Errors not attached to a call (e.g. account/payment problems)
  if (!(value?.calls || []).length && !(value?.statuses || []).length && valueErrors.length) {
    await CallEvent.create({ source: 'meta', phoneNumberId, event: 'error', errorList: valueErrors }).catch(() => {});
    logger.warn(`[calls][meta] error webhook: ${errText(valueErrors)}`);
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
