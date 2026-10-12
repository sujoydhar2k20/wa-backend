'use strict';

const { bulkAssignRandom, distribute, BulkAssignError } = require('../bulkAssign.service');

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
const admin = { _id: 'admin1', role: 'admin', name: 'Admin' };
const superadmin = { _id: 'sa1', role: 'superadmin' };
const staffUser = { _id: 'st1', role: 'staff' };

function seededRng(seed = 1) { // deterministic
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function makeEnv({ chats = [], staff = [], monthlyTagId = null, beforeUpdate } = {}) {
  const store = new Map(chats.map((c) => [String(c._id), { assignedTo: null, collaborators: [], tags: [], ...c }]));
  const activities = [];
  const matchesAnd = (c, query) => {
    const conds = query.$and || [query];
    return conds.every((q) => Object.entries(q).every(([k, v]) => {
      if (k === 'assignedTo') return v === null ? c.assignedTo == null : c.assignedTo === v;
      if (k === 'tags') return v && v.$ne ? !(c.tags || []).includes(v.$ne) : (c.tags || []).includes(v);
      return c[k] === v;
    }));
  };
  const Chat = {
    find: (q) => {
      let rows = [...store.values()].filter((c) => matchesAnd(c, q));
      const chain = { select: () => chain, sort: () => chain, limit: (n) => { rows = rows.slice(0, n); return chain; }, lean: async () => rows.map((r) => ({ ...r })) };
      return chain;
    },
    countDocuments: async (q) => [...store.values()].filter((c) => matchesAnd(c, q)).length,
    updateOne: jest.fn(async (filter, upd) => {
      if (beforeUpdate) beforeUpdate(String(filter._id), store);
      const c = store.get(String(filter._id));
      if (!c || !matchesAnd(c, filter)) return { modifiedCount: 0 };
      Object.assign(c, upd.$set);
      return { modifiedCount: 1 };
    }),
  };
  const User = { find: () => ({ select: () => ({ lean: async () => staff }) }) };
  const ChatActivity = { insertMany: jest.fn(async (docs) => { activities.push(...docs); }) };
  return { deps: { Chat, User, ChatActivity, getMonthlyTagId: async () => monthlyTagId, logger }, store, activities, Chat };
}

const mkChats = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ _id: `c${i}`, wabaId: 'W1', ...extra }));
const mkStaff = (n, waba = 'W1', prefix = 's') => Array.from({ length: n }, (_, i) => ({ _id: `${prefix}${i}`, name: `${prefix}${i}`, assignedWabaId: waba }));
const run = (env, extra = {}) => bulkAssignRandom(env.deps, { actor: admin, confirm: true, rng: seededRng(7), ...extra });

describe('distribute (pure)', () => {
  test('100 chats / 5 staff -> exactly 20 each', () => {
    const out = distribute(mkChats(100).map((c) => c._id), mkStaff(5).map((s) => s._id), seededRng(3));
    const counts = {};
    out.forEach((o) => { counts[o.staffId] = (counts[o.staffId] || 0) + 1; });
    expect(Object.values(counts)).toEqual([20, 20, 20, 20, 20]);
  });
  test('remainder differs by at most 1', () => {
    const out = distribute(mkChats(103).map((c) => c._id), mkStaff(5).map((s) => s._id), seededRng(9));
    const counts = {};
    out.forEach((o) => { counts[o.staffId] = (counts[o.staffId] || 0) + 1; });
    const v = Object.values(counts);
    expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1);
    expect(v.reduce((a, b) => a + b)).toBe(103);
  });
  test('is actually random (different seeds -> different mapping)', () => {
    const ids = mkChats(30).map((c) => c._id); const st = mkStaff(3).map((s) => s._id);
    expect(JSON.stringify(distribute(ids, st, seededRng(1)))).not.toEqual(JSON.stringify(distribute(ids, st, seededRng(2))));
  });
});

describe('bulkAssignRandom', () => {
  test('assigns all unassigned chats evenly and writes audit rows', async () => {
    const env = makeEnv({ chats: mkChats(100), staff: mkStaff(5) });
    const r = await run(env);
    expect(r.assigned).toBe(100);
    expect(r.failed).toBe(0);
    expect(r.perStaff.map((p) => p.count)).toEqual([20, 20, 20, 20, 20]);
    expect(env.activities).toHaveLength(100);
    expect(env.activities[0]).toMatchObject({ type: 'assigned', performedBy: 'admin1', details: { reason: 'bulk_random' } });
  });

  test('empty selection -> NO_CHATS, nothing changed', async () => {
    const env = makeEnv({ chats: [], staff: mkStaff(3) });
    await expect(run(env)).rejects.toMatchObject({ code: 'NO_CHATS' });
    expect(env.Chat.updateOne).not.toHaveBeenCalled();
  });

  test('no eligible staff -> NO_ELIGIBLE_STAFF and zero writes', async () => {
    const env = makeEnv({ chats: mkChats(10), staff: [] });
    await expect(run(env)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_STAFF', status: 409 });
    expect(env.Chat.updateOne).not.toHaveBeenCalled();
    expect([...env.store.values()].every((c) => c.assignedTo === null)).toBe(true);
  });

  test('staff of another WABA are not eligible; chats of WABAs without staff are left alone', async () => {
    const chats = [...mkChats(4), ...Array.from({ length: 3 }, (_, i) => ({ _id: `x${i}`, wabaId: 'W2' }))];
    const env = makeEnv({ chats, staff: mkStaff(2, 'W1') });
    const r = await run(env);
    expect(r.assigned).toBe(4);
    expect(r.noEligibleStaff).toBe(3);
    expect(env.store.get('x0').assignedTo).toBeNull();
  });

  test('permissions: staff role is rejected, admin/superadmin allowed', async () => {
    const env = makeEnv({ chats: mkChats(3), staff: mkStaff(1) });
    await expect(bulkAssignRandom(env.deps, { actor: staffUser })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(bulkAssignRandom(env.deps, { actor: undefined })).rejects.toBeInstanceOf(BulkAssignError);
    await expect(bulkAssignRandom(env.deps, { actor: superadmin, rng: seededRng(1) })).resolves.toMatchObject({ assigned: 3 });
  });

  test('already assigned chats are never touched (incl. collaborators)', async () => {
    const chats = [...mkChats(5), { _id: 'owned', wabaId: 'W1', assignedTo: 'other', collaborators: ['z'] }];
    const env = makeEnv({ chats, staff: mkStaff(2) });
    await run(env);
    expect(env.store.get('owned')).toMatchObject({ assignedTo: 'other', collaborators: ['z'] });
  });

  test('concurrent assignment: chats claimed mid-run are not overwritten and are reported as skipped', async () => {
    const env = makeEnv({
      chats: mkChats(10), staff: mkStaff(2),
      beforeUpdate: (id, store) => { if (id === 'c3' || id === 'c7') store.get(id).assignedTo = 'someoneElse'; },
    });
    const r = await run(env);
    expect(r.assigned).toBe(8);
    expect(r.skippedConcurrent).toBe(2);
    expect(env.store.get('c3').assignedTo).toBe('someoneElse');
    expect(env.store.get('c7').assignedTo).toBe('someoneElse');
    expect(env.activities).toHaveLength(8);
  });

  test('partial failure: failed writes are counted, others succeed, audit only for successes', async () => {
    const env = makeEnv({ chats: mkChats(10), staff: mkStaff(3) });
    const orig = env.Chat.updateOne.getMockImplementation();
    env.Chat.updateOne.mockImplementation(async (f, u) => { if (f._id === 'c2' || f._id === 'c5') throw new Error('boom'); return orig(f, u); });
    const r = await run(env);
    expect(r.failed).toBe(2);
    expect(r.assigned).toBe(8);
    expect(env.activities).toHaveLength(8);
    expect(env.store.get('c2').assignedTo).toBeNull();
  });

  test('large set (5000 chats / 7 staff) is balanced within 1', async () => {
    const env = makeEnv({ chats: mkChats(5000), staff: mkStaff(7) });
    const r = await run(env);
    expect(r.assigned).toBe(5000);
    const counts = r.perStaff.map((p) => p.count);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  test('expectedCount caps the run to what the admin confirmed', async () => {
    const env = makeEnv({ chats: mkChats(50), staff: mkStaff(2) });
    const r = await run(env, { expectedCount: 20 });
    expect(r.assigned).toBe(20);
    expect(r.remaining).toBe(30);
  });

  test('monthly-tagged chats are skipped for admins but included for superadmins', async () => {
    const chats = [...mkChats(3), { _id: 'm1', wabaId: 'W1', tags: ['MONTHLY'] }];
    const a = makeEnv({ chats, staff: mkStaff(2), monthlyTagId: 'MONTHLY' });
    await run(a);
    expect(a.store.get('m1').assignedTo).toBeNull();
    const b = makeEnv({ chats, staff: mkStaff(2), monthlyTagId: 'MONTHLY' });
    await bulkAssignRandom(b.deps, { actor: superadmin, rng: seededRng(1) });
    expect(b.store.get('m1').assignedTo).not.toBeNull();
  });

  test('duplicate submission: same requestId returns the first result without re-running; parallel run is rejected', async () => {
    const env = makeEnv({ chats: mkChats(10), staff: mkStaff(2) });
    const first = await run(env, { requestId: 'req-1' });
    const writes = env.Chat.updateOne.mock.calls.length;
    const again = await run(env, { requestId: 'req-1' });
    expect(again.duplicateRequest).toBe(true);
    expect(again.assigned).toBe(first.assigned);
    expect(env.Chat.updateOne.mock.calls.length).toBe(writes);

    const env2 = makeEnv({ chats: mkChats(300), staff: mkStaff(3) });
    const p1 = run(env2, { requestId: 'a' });
    await expect(run(env2, { requestId: 'b' })).rejects.toMatchObject({ code: 'ALREADY_RUNNING', status: 409 });
    await p1;
  });

  test('dryRun reports counts and eligible staff without writing', async () => {
    const env = makeEnv({ chats: mkChats(12), staff: mkStaff(4) });
    const r = await bulkAssignRandom(env.deps, { actor: admin, dryRun: true });
    expect(r).toMatchObject({ candidateCount: 12, assignableCount: 12, eligibleStaffCount: 4 });
    expect(env.Chat.updateOne).not.toHaveBeenCalled();
  });
});
