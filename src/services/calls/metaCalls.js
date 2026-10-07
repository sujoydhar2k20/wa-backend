'use strict';

const axios = require('axios');

/**
 * Thin client for Meta's calling endpoints. `getToken(wabaId)` and `apiVersion` are injected
 * so this module stays testable and does not depend on the rest of the backend.
 */
function createMetaCalls({ getToken, apiVersion, http = axios }) {
  const base = `https://graph.facebook.com/${apiVersion}`;

  async function post(wabaId, path, body) {
    const token = await getToken(wabaId);
    const res = await http.post(`${base}/${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return res.data;
  }

  const callsPath = (phoneNumberId) => `${phoneNumberId}/calls`;

  return {
    /** Business-initiated: send our SDP offer. Meta answers later via the connect webhook. */
    connect(wabaId, phoneNumberId, { to, sdpOffer, bizData }) {
      return post(wabaId, callsPath(phoneNumberId), {
        messaging_product: 'whatsapp',
        to: String(to).replace(/\D/g, ''),
        action: 'connect',
        session: { sdp_type: 'offer', sdp: sdpOffer },
        ...(bizData ? { biz_opaque_callback_data: String(bizData).slice(0, 512) } : {}),
      });
    },
    preAccept(wabaId, phoneNumberId, { callId, sdpAnswer }) {
      return post(wabaId, callsPath(phoneNumberId), {
        messaging_product: 'whatsapp', call_id: callId, action: 'pre_accept',
        session: { sdp_type: 'answer', sdp: sdpAnswer },
      });
    },
    accept(wabaId, phoneNumberId, { callId, sdpAnswer, bizData }) {
      return post(wabaId, callsPath(phoneNumberId), {
        messaging_product: 'whatsapp', call_id: callId, action: 'accept',
        session: { sdp_type: 'answer', sdp: sdpAnswer },
        ...(bizData ? { biz_opaque_callback_data: String(bizData).slice(0, 512) } : {}),
      });
    },
    reject(wabaId, phoneNumberId, { callId }) {
      return post(wabaId, callsPath(phoneNumberId), {
        messaging_product: 'whatsapp', call_id: callId, action: 'reject',
      });
    },
    // Must be sent for every call, even if media already ended (Meta requirement / accurate billing).
    terminate(wabaId, phoneNumberId, { callId }) {
      return post(wabaId, callsPath(phoneNumberId), {
        messaging_product: 'whatsapp', call_id: callId, action: 'terminate',
      });
    },
    /** Ask the customer for permission to call them (interactive message). */
    requestPermission(wabaId, phoneNumberId, { to, text }) {
      return post(wabaId, `${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to).replace(/\D/g, ''),
        type: 'interactive',
        interactive: {
          type: 'call_permission_request',
          body: { text: text || 'We would like to call you. Please allow calls from us.' },
          action: { name: 'call_permission_request' },
        },
      });
    },
    /** Enable/disable calling on a number (calling hours stay managed in WhatsApp Manager). */
    setCallingStatus(wabaId, phoneNumberId, enabled) {
      return post(wabaId, `${phoneNumberId}/settings`, {
        calling: { status: enabled ? 'ENABLED' : 'DISABLED' },
      });
    },
  };
}

module.exports = { createMetaCalls };
