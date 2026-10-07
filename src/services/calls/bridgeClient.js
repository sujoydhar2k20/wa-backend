'use strict';

const axios = require('axios');

/** Client for the private call-bridge service on the same VPS. */
function createBridgeClient({ baseUrl, secret, http = axios }) {
  if (!secret || secret.length < 32) throw new Error('BRIDGE_SECRET must be at least 32 characters');
  const headers = { 'X-Bridge-Secret': secret, 'Content-Type': 'application/json' };
  const opts = { headers, timeout: 12000 };

  const roomFor = (callId) => `call-${callId}`;

  return {
    roomFor,
    async inbound(callId, sdpOffer) {
      const r = await http.post(`${baseUrl}/v1/sessions/inbound`, { callId, room: roomFor(callId), sdp: sdpOffer }, opts);
      return r.data.sdp;
    },
    async outbound(callId) {
      const r = await http.post(`${baseUrl}/v1/sessions/outbound`, { callId, room: roomFor(callId) }, opts);
      return r.data.sdp;
    },
    async answer(callId, sdpAnswer) {
      await http.post(`${baseUrl}/v1/sessions/${encodeURIComponent(callId)}/answer`, { sdp: sdpAnswer }, opts);
    },
    async terminate(callId) {
      await http.delete(`${baseUrl}/v1/sessions/${encodeURIComponent(callId)}`, opts);
    },
  };
}

module.exports = { createBridgeClient };
