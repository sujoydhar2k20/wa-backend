'use strict';

const { canTransition, isTerminal, mapMetaCallStatus } = require('../callStates');
const { buildRingPlan, totalRingMs } = require('../ringPlan');
const { parseCallWebhookBody, parsePermissionReply } = require('../webhookParser');
const { createMetaCalls } = require('../metaCalls');
const { createBridgeClient } = require('../bridgeClient');

describe('call state machine', () => {
  test('valid inbound flow', () => {
    expect(canTransition('ringing', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'terminated')).toBe(true);
    expect(canTransition('ringing', 'missed')).toBe(true);
  });
  test('terminal states never change (no double answer / resurrect)', () => {
    for (const s of ['rejected', 'terminated', 'missed', 'failed']) {
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, 'accepted')).toBe(false);
    }
    expect(canTransition('accepted', 'accepted')).toBe(false);
  });
  test('outbound needs permission before ringing', () => {
    expect(canTransition('permission_requested', 'ringing')).toBe(false);
    expect(canTransition('permission_requested', 'permission_granted')).toBe(true);
    expect(canTransition('permission_granted', 'ringing')).toBe(true);
  });
  test('maps Meta statuses', () => {
    expect(mapMetaCallStatus('RINGING')).toBe('ringing');
    expect(mapMetaCallStatus('completed')).toBe('terminated');
    expect(mapMetaCallStatus('weird')).toBeNull();
  });
});

describe('ring plan (25s assigned, then 25s all online)', () => {
  const u = (id, role = 'staff') => ({ id, role });
  test('assigned online + others online -> two stages', () => {
    const plan = buildRingPlan({ assignedTo: 'a', onlineUsers: [u('a'), u('b'), u('c', 'admin')] });
    expect(plan.map((s) => s.stage)).toEqual(['assigned', 'all']);
    expect(plan[0].userIds).toEqual(['a']);
    expect(plan[1].userIds).toEqual(['a', 'b', 'c']);
    expect(totalRingMs(plan)).toBe(50000);
  });
  test('assigned offline -> straight to all online (no wasted 25s)', () => {
    const plan = buildRingPlan({ assignedTo: 'a', onlineUsers: [u('b')] });
    expect(plan).toHaveLength(1);
    expect(plan[0].stage).toBe('all');
  });
  test('only the assigned user online -> one continuous ring', () => {
    const plan = buildRingPlan({ assignedTo: 'a', onlineUsers: [u('a')] });
    expect(plan).toEqual([{ stage: 'assigned', userIds: ['a'], durationMs: 50000 }]);
  });
  test('nobody online -> empty plan (missed call)', () => {
    expect(buildRingPlan({ assignedTo: 'a', onlineUsers: [] })).toEqual([]);
  });
  test('unassigned chat rings all online; inactive and unknown roles are excluded', () => {
    const plan = buildRingPlan({
      assignedTo: null,
      onlineUsers: [u('b'), { id: 'x', role: 'staff', isActive: false }, { id: 'y', role: 'guest' }],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].userIds).toEqual(['b']);
  });
  test('timings are configurable', () => {
    const plan = buildRingPlan({ assignedTo: 'a', onlineUsers: [u('a'), u('b')], timings: { assignedMs: 10000, allMs: 15000 } });
    expect(totalRingMs(plan)).toBe(25000);
  });
});

describe('webhook parser', () => {
  const body = {
    entry: [
      { id: 'WABA1', changes: [{ field: 'calls', value: {
        metadata: { phone_number_id: 'PN1' },
        contacts: [{ profile: { name: 'Riya' }, wa_id: '919812345678' }],
        calls: [{ id: 'wacid.A', from: '919812345678', to: '919804492738', event: 'connect',
          direction: 'USER_INITIATED', timestamp: '1700000000', session: { sdp_type: 'offer', sdp: 'v=0...' } }],
      } }] },
      { id: 'WABA2', changes: [{ field: 'calls', value: {
        metadata: { phone_number_id: 'PN2' },
        calls: [{ id: 'wacid.B', from: '919804492738', to: '919811112222', event: 'terminate',
          direction: 'BUSINESS_INITIATED', status: 'COMPLETED', start_time: '1700000010', end_time: '1700000070', duration: 60 }],
        statuses: [{ id: 'wacid.B', type: 'call', status: 'RINGING', recipient_id: '919811112222', timestamp: '1700000005' }],
      } }] },
      { id: 'WABA3', changes: [{ field: 'messages', value: {} }] },
    ],
  };
  test('parses every entry, not only the first', () => {
    const evs = parseCallWebhookBody(body);
    expect(evs.map((e) => `${e.type}:${e.callId}`)).toEqual(['connect:wacid.A', 'terminate:wacid.B', 'status:wacid.B']);
  });
  test('inbound connect carries SDP and customer number', () => {
    const [c] = parseCallWebhookBody(body);
    expect(c).toMatchObject({ direction: 'inbound', customerWaId: '919812345678', phoneNumberId: 'PN1', sdp: 'v=0...', wabaMetaId: 'WABA1' });
  });
  test('outbound terminate uses "to" as customer and reads duration', () => {
    const t = parseCallWebhookBody(body)[1];
    expect(t).toMatchObject({ direction: 'outbound', customerWaId: '919811112222', status: 'COMPLETED', duration: 60 });
  });
  test('permission reply', () => {
    const r = parsePermissionReply({ from: '91 98123 45678', interactive: { call_permission_reply: { response: 'accept', is_permanent: false, expiration_timestamp: '1700100000' } } });
    expect(r).toMatchObject({ customerWaId: '919812345678', granted: true, permanent: false });
    expect(parsePermissionReply({ interactive: {} })).toBeNull();
  });
  test('empty or odd bodies do not throw', () => {
    expect(parseCallWebhookBody(undefined)).toEqual([]);
    expect(parseCallWebhookBody({ entry: [{ changes: [{ field: 'calls', value: {} }] }] })).toEqual([]);
  });
});

describe('meta client', () => {
  test('pre_accept / accept / terminate request shapes', async () => {
    const http = { post: jest.fn().mockResolvedValue({ data: { success: true } }) };
    const m = createMetaCalls({ getToken: async () => 'TKN', apiVersion: 'v25.0', http });
    await m.preAccept('w', 'PN', { callId: 'wacid.A', sdpAnswer: 'ANS' });
    await m.accept('w', 'PN', { callId: 'wacid.A', sdpAnswer: 'ANS', bizData: 'log123' });
    await m.terminate('w', 'PN', { callId: 'wacid.A' });
    const [pre, acc, term] = http.post.mock.calls;
    expect(pre[0]).toBe('https://graph.facebook.com/v25.0/PN/calls');
    expect(pre[1]).toEqual({ messaging_product: 'whatsapp', call_id: 'wacid.A', action: 'pre_accept', session: { sdp_type: 'answer', sdp: 'ANS' } });
    expect(acc[1].biz_opaque_callback_data).toBe('log123');
    expect(term[1].action).toBe('terminate');
    expect(pre[2].headers.Authorization).toBe('Bearer TKN');
  });
  test('connect sends offer and cleans phone number', async () => {
    const http = { post: jest.fn().mockResolvedValue({ data: {} }) };
    const m = createMetaCalls({ getToken: async () => 'T', apiVersion: 'v25.0', http });
    await m.connect('w', 'PN', { to: '+91 98111 12222', sdpOffer: 'OFF', bizData: 'x'.repeat(600) });
    const body = http.post.mock.calls[0][1];
    expect(body.to).toBe('919811112222');
    expect(body.session).toEqual({ sdp_type: 'offer', sdp: 'OFF' });
    expect(body.biz_opaque_callback_data).toHaveLength(512);
  });
  test('permission request uses interactive call_permission_request', async () => {
    const http = { post: jest.fn().mockResolvedValue({ data: {} }) };
    const m = createMetaCalls({ getToken: async () => 'T', apiVersion: 'v25.0', http });
    await m.requestPermission('w', 'PN', { to: '919811112222' });
    expect(http.post.mock.calls[0][0]).toMatch(/\/PN\/messages$/);
    expect(http.post.mock.calls[0][1].interactive.type).toBe('call_permission_request');
  });
});

describe('bridge client', () => {
  const secret = 's'.repeat(32);
  test('rejects a weak secret', () => {
    expect(() => createBridgeClient({ baseUrl: 'http://x', secret: 'short' })).toThrow();
  });
  test('inbound returns the SDP answer and sends the secret', async () => {
    const http = { post: jest.fn().mockResolvedValue({ data: { sdp: 'ANSWER' } }), delete: jest.fn().mockResolvedValue({}) };
    const b = createBridgeClient({ baseUrl: 'http://127.0.0.1:8090', secret, http });
    expect(await b.inbound('wacid.A', 'OFFER')).toBe('ANSWER');
    const [url, body, opts] = http.post.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8090/v1/sessions/inbound');
    expect(body).toEqual({ callId: 'wacid.A', room: 'call-wacid.A', sdp: 'OFFER' });
    expect(opts.headers['X-Bridge-Secret']).toBe(secret);
    await b.terminate('wacid.A');
    expect(http.delete.mock.calls[0][0]).toBe('http://127.0.0.1:8090/v1/sessions/wacid.A');
  });
});
