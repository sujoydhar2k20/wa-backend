'use strict';

const r = require('../routing');

const U = (id, role = 'staff', waba = 'W1', extra = {}) => ({ _id: id, role, assignedWabaId: waba, isActive: true, ...extra });
const users = [
  U('s1'), U('s2'), U('s3', 'staff', 'W2'), U('s4', 'staff', null),
  U('a1', 'admin', null), U('sa', 'superadmin', null), U('off', 'staff', 'W1', { isActive: false }),
];

describe('ring plan', () => {
  test('assigned staff first for 25 s, then everyone incl. admins and superadmins for 25 s', () => {
    const p = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 's1' });
    expect(p.first).toEqual({ stage: 'assigned', userIds: ['s1'], seconds: 25 });
    expect(p.all.stage).toBe('all');
    expect(p.all.seconds).toBe(25);
    expect(p.all.userIds.sort()).toEqual(['a1', 's1', 's2', 's4', 'sa'].sort());
  });
  test('staff of another WABA and inactive users never ring', () => {
    const p = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 's1' });
    expect(p.all.userIds).not.toContain('s3');
    expect(p.all.userIds).not.toContain('off');
  });
  test('unassigned chat: everyone for the full 50 s', () => {
    const p = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: null });
    expect(p.first).toBeNull();
    expect(p.all.seconds).toBe(50);
  });
  test('assigned user busy or inactive: straight to everyone for 50 s, busy users skipped', () => {
    const p = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 's1', busyUserIds: ['s1', 'a1'] });
    expect(p.first).toBeNull();
    expect(p.all.seconds).toBe(50);
    expect(p.all.userIds).not.toContain('s1');
    expect(p.all.userIds).not.toContain('a1');
    const q = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 'off' });
    expect(q.first).toBeNull();
  });
  test('assigned staff from another WABA does not get the first stage', () => {
    expect(r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 's3' }).first).toBeNull();
  });
  test('custom timings', () => {
    const p = r.buildRingPlan({ users, wabaId: 'W1', assignedTo: 's2', firstSeconds: 20, allSeconds: 30 });
    expect(p.first.seconds).toBe(20);
    expect(p.all.seconds).toBe(30);
  });
});

describe('who may call a chat', () => {
  test('staff only their assigned chats; admins any', () => {
    expect(r.canUserCallChat({ _id: 's1', role: 'staff' }, { assignedTo: 's1' })).toBe(true);
    expect(r.canUserCallChat({ _id: 's2', role: 'staff' }, { assignedTo: 's1' })).toBe(false);
    expect(r.canUserCallChat({ _id: 's2', role: 'staff' }, { assignedTo: null })).toBe(false);
    expect(r.canUserCallChat({ _id: 'a1', role: 'admin' }, { assignedTo: 's1' })).toBe(true);
    expect(r.canUserCallChat({ _id: 'sa', role: 'superadmin' }, { assignedTo: null })).toBe(true);
  });
});

describe('call permission', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  test('valid when granted and not expired, or permanent', () => {
    expect(r.permissionValid({ status: 'granted', expiresAt: new Date('2026-10-13T00:00:00Z') }, now)).toBe(true);
    expect(r.permissionValid({ status: 'granted', expiresAt: new Date('2026-10-12T09:00:00Z') }, now)).toBe(false);
    expect(r.permissionValid({ status: 'granted', isPermanent: true }, now)).toBe(true);
    expect(r.permissionValid({ status: 'declined', isPermanent: true }, now)).toBe(false);
    expect(r.permissionValid(null, now)).toBe(false);
  });
  test('request limits: 1 per 24 h, 2 per 7 days', () => {
    const h = (x) => new Date(now.getTime() - x * 3600e3);
    expect(r.permissionRequestAllowed([], now).ok).toBe(true);
    expect(r.permissionRequestAllowed([{ at: h(2) }], now).ok).toBe(false);
    expect(r.permissionRequestAllowed([{ at: h(30) }], now).ok).toBe(true);
    expect(r.permissionRequestAllowed([{ at: h(30) }, { at: h(100) }], now).ok).toBe(false);
    expect(r.permissionRequestAllowed([{ at: h(30) }, { at: h(200) }], now).ok).toBe(true);
  });
});

describe('missed-call message cooldown (30 min)', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  test('sent once per 30 minutes', () => {
    expect(r.shouldSendMissedMessage(null, 30, now)).toBe(true);
    expect(r.shouldSendMissedMessage(new Date(now - 10 * 60e3), 30, now)).toBe(false);
    expect(r.shouldSendMissedMessage(new Date(now - 30 * 60e3), 30, now)).toBe(true);
  });
});

describe('helpers', () => {
  test('digitsOnly accepts numbers, rejects BSUIDs', () => {
    expect(r.digitsOnly('+919800000001')).toBe('919800000001');
    expect(r.digitsOnly('sip:+91 98000 00001@wa.meta.vc')).toBe('919800000001');
    expect(r.digitsOnly('IN.1234abcd')).toBeNull();
    expect(r.digitsOnly('')).toBeNull();
  });
  test('formatDuration', () => {
    expect(r.formatDuration(192)).toBe('3:12');
    expect(r.formatDuration(5)).toBe('0:05');
  });
});

describe('callButtonAllowed', () => {
  const { callButtonAllowed } = require('../routing');
  const now = new Date('2026-10-12T10:00:00Z');
  test('allowed inside the 24 h window', () => {
    const r = callButtonAllowed({ lastCustomerAt: new Date(now - 23 * 3600e3), now });
    expect(r.ok).toBe(true);
    expect(r.windowEndsAt.getTime()).toBe(now.getTime() + 3600e3);
  });
  test('refused after 24 h or with no customer contact', () => {
    expect(callButtonAllowed({ lastCustomerAt: new Date(now - 24 * 3600e3), now }).ok).toBe(false);
    expect(callButtonAllowed({ lastCustomerAt: null, now }).ok).toBe(false);
  });
  test('blocks a second send within 2 minutes', () => {
    const lastCustomerAt = new Date(now - 3600e3);
    expect(callButtonAllowed({ lastCustomerAt, lastSentAt: new Date(now - 60e3), now }).ok).toBe(false);
    expect(callButtonAllowed({ lastCustomerAt, lastSentAt: new Date(now - 3 * 60e3), now }).ok).toBe(true);
  });
});
