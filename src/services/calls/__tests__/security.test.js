'use strict';

process.env.JWT_SECRET = 'x'.repeat(40);
process.env.CALLING_INTERNAL_SECRET = 'a'.repeat(64);

const { seal, open } = require('../secretBox');
const { internalAuth } = require('../../../middleware/internalAuth');
const recordings = require('../recordings');
const sip = require('../sipAccounts');
const cfg = require('../config');

describe('secretBox', () => {
  test('round trip, and tampering is detected', () => {
    const s = seal('pass-123');
    expect(open(s)).toBe('pass-123');
    const parts = s.split(':');
    parts[3] = Buffer.from('other').toString('base64');
    expect(() => open(parts.join(':'))).toThrow();
  });
});

describe('internalAuth', () => {
  beforeEach(() => cfg.reset());
  const run = ({ secret = 'a'.repeat(64), remote = '127.0.0.1', xff } = {}) => {
    const headers = { 'x-internal-secret': secret, ...(xff ? { 'x-forwarded-for': xff } : {}) };
    const req = { get: (h) => headers[h.toLowerCase()], socket: { remoteAddress: remote } };
    let status = 200; let nextCalled = false;
    const res = { status(s) { status = s; return this; }, type() { return this; }, send() { return this; } };
    internalAuth(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
  };
  test('loopback + correct secret passes', () => expect(run().nextCalled).toBe(true));
  test('wrong secret is rejected', () => expect(run({ secret: 'b'.repeat(64) }).status).toBe(404));
  test('remote address is rejected', () => expect(run({ remote: '10.0.0.5' }).status).toBe(404));
  test('requests through nginx (X-Forwarded-For) are rejected', () => expect(run({ xff: '1.2.3.4' }).status).toBe(404));
});

describe('recording links', () => {
  test('signed token is bound to the call and expires', () => {
    const t = recordings.signToken('c1', 'u1', 60);
    expect(recordings.verifyToken(t, 'c1')).toEqual({ userId: 'u1' });
    expect(recordings.verifyToken(t, 'c2')).toBeNull();
    expect(recordings.verifyToken(recordings.signToken('c1', 'u1', -1), 'c1')).toBeNull();
    expect(recordings.verifyToken(`${t}x`, 'c1')).toBeNull();
  });
  test('paths cannot escape the recordings folder', () => {
    expect(recordings.safeRelative('2026/10/12/in-1.wav')).toBe('2026/10/12/in-1.wav');
    expect(recordings.safeRelative('../etc/passwd')).toBeNull();
    expect(recordings.safeRelative('/etc/passwd')).toBe('etc/passwd');
    expect(recordings.safeRelative('a;b.wav')).toBeNull();
  });
});

describe('generated Asterisk accounts', () => {
  const users = [
    { _id: '64b7f0000000000000000001', name: 'Rina "Boss"; x', role: 'staff', sip: { passwordEnc: seal('pw1'), deskPhone: true } },
    { _id: '64b7f0000000000000000002', name: 'Admin', role: 'admin', sip: { passwordEnc: seal('pw2') } },
  ];
  test('one WebRTC account per user, desk account only when enabled, names sanitised', () => {
    const conf = sip.renderPjsip(users);
    expect(conf).toContain('[u64b7f0000000000000000001](webrtc_user)');
    expect(conf).toContain('[u64b7f0000000000000000001-desk](desk_user)');
    expect(conf).not.toContain('[u64b7f0000000000000000002-desk]');
    expect(conf).toContain('password=pw2');
    expect(conf).toContain('[u64b7f0000000000000000002](user_aor)\nmax_contacts=10');
    expect(conf).toContain('callerid="Rina Boss x" <u64b7f0000000000000000001>');
    expect(conf).not.toMatch(/Rina "Boss"; x/);
  });
  test('fallback ring list and endpoint parsing', () => {
    expect(sip.renderDialplan(users)).toContain('Return(u64b7f0000000000000000001~u64b7f0000000000000000001-desk~u64b7f0000000000000000002)');
    expect(sip.userIdFromEndpoint('u64b7f0000000000000000001-desk')).toEqual({ userId: '64b7f0000000000000000001', device: 'desk' });
    expect(sip.userIdFromEndpoint('whatsapp')).toBeNull();
  });
});
