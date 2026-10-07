'use strict';

/**
 * Turns Meta webhook payloads into simple events. Field names follow Meta's calling docs;
 * anything not confirmed against a real payload is handled tolerantly and flagged in `raw`.
 * VERIFY against real webhooks during the spike (raw payloads are always kept).
 *
 * Returns an array of events:
 *  { type: 'connect'|'terminate'|'status', callId, direction: 'inbound'|'outbound', customerWaId,
 *    sdp?, status?, startTime?, endTime?, duration?, bizData?, errors?, timestamp, raw }
 */
function toDirection(d) {
  const v = String(d || '').toUpperCase();
  if (v === 'USER_INITIATED') return 'inbound';
  if (v === 'BUSINESS_INITIATED') return 'outbound';
  return null;
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function parseCallsChange(change) {
  const value = change?.value || {};
  const phoneNumberId = value.metadata?.phone_number_id || null;
  const events = [];

  for (const call of value.calls || []) {
    const direction = toDirection(call.direction);
    const event = String(call.event || '').toLowerCase();
    // For user-initiated calls the customer is "from"; for business-initiated they are "to".
    const customerWaId = digits(direction === 'outbound' ? call.to : call.from) ||
      digits(value.contacts?.[0]?.wa_id);
    const base = {
      callId: call.id,
      direction,
      customerWaId,
      phoneNumberId,
      bizData: call.biz_opaque_callback_data || null,
      timestamp: call.timestamp ? Number(call.timestamp) * 1000 : Date.now(),
      customerName: value.contacts?.[0]?.profile?.name || null,
      raw: call,
    };
    if (event === 'connect') {
      events.push({ ...base, type: 'connect', sdp: call.session?.sdp || null, sdpType: call.session?.sdp_type || null });
    } else if (event === 'terminate') {
      events.push({
        ...base,
        type: 'terminate',
        status: call.status || null,
        startTime: call.start_time ? Number(call.start_time) * 1000 : null,
        endTime: call.end_time ? Number(call.end_time) * 1000 : null,
        duration: Number.isFinite(Number(call.duration)) ? Number(call.duration) : null,
        errors: call.errors || null,
      });
    } else {
      events.push({ ...base, type: 'unknown', event });
    }
  }

  for (const st of value.statuses || []) {
    if (st.type !== 'call') continue;
    events.push({
      type: 'status',
      callId: st.id,
      status: st.status || null, // RINGING | ACCEPTED | REJECTED
      customerWaId: digits(st.recipient_id),
      phoneNumberId,
      direction: 'outbound',
      bizData: st.biz_opaque_callback_data || null,
      timestamp: st.timestamp ? Number(st.timestamp) * 1000 : Date.now(),
      raw: st,
    });
  }
  return events;
}

/** Customer's answer to a call-permission request (arrives on the messages webhook). Shape to be verified live. */
function parsePermissionReply(message) {
  const reply = message?.interactive?.call_permission_reply;
  if (!reply) return null;
  const response = String(reply.response || '').toLowerCase();
  return {
    customerWaId: digits(message.from),
    granted: response === 'accept',
    permanent: !!reply.is_permanent,
    expiresAt: reply.expiration_timestamp ? Number(reply.expiration_timestamp) * 1000 : null,
    source: reply.response_source || null,
    raw: reply,
  };
}

/** Walk a full webhook body and return every call event across all entries/changes (not just entry[0]). */
function parseCallWebhookBody(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'calls') continue;
      for (const ev of parseCallsChange(change)) out.push({ ...ev, wabaMetaId: entry.id });
    }
  }
  return out;
}

module.exports = { parseCallWebhookBody, parseCallsChange, parsePermissionReply, toDirection };
