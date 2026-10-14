'use strict';

process.env.JWT_SECRET = 'x'.repeat(40);

const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------- token revocation
describe('token revocation (REVOKED_TOKEN_SHA256)', () => {
  const rev = require('../../utils/tokenRevocation');
  const token = jwt.sign({ userId: '0123456789abcdef01234567' }, process.env.JWT_SECRET);
  const other = jwt.sign({ userId: '0123456789abcdef01234568' }, process.env.JWT_SECRET);

  afterEach(() => { delete process.env.REVOKED_TOKEN_SHA256; rev.reset(); });

  test('nothing is revoked by default', () => {
    rev.reset();
    expect(rev.isRevoked(token)).toBe(false);
  });

  test('exactly the listed token is revoked, others keep working', () => {
    process.env.REVOKED_TOKEN_SHA256 = ` ${rev.hashToken(token).toUpperCase()} , not-a-hash`;
    rev.reset();
    expect(rev.isRevoked(token)).toBe(true);
    expect(rev.isRevoked(other)).toBe(false);
    expect(rev.isRevoked('')).toBe(false);
  });

  test('REST middleware answers 401 for a revoked token before touching the database', async () => {
    process.env.REVOKED_TOKEN_SHA256 = rev.hashToken(token);
    rev.reset();
    const { authenticate } = require('../../middleware/auth.middleware');
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const next = jest.fn();
    await authenticate({ headers: { authorization: `Bearer ${token}` } }, res, next);
    expect(res.code).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- send idempotency
describe('sendGuard (message idempotency)', () => {
  let store;
  beforeEach(() => {
    jest.resetModules();
    store = new Map();
    jest.doMock('../../models/SendRequest', () => ({
      create: jest.fn(async (doc) => {
        if (store.has(doc.key)) { const e = new Error('dup'); e.code = 11000; throw e; }
        store.set(doc.key, { ...doc });
        return doc;
      }),
      findOne: jest.fn(({ key }) => ({ lean: async () => (store.has(key) ? { ...store.get(key) } : null) })),
      findOneAndUpdate: jest.fn(async (q, u) => {
        const row = store.get(q.key);
        if (!row || row.status !== q.status || +new Date(row.claimedAt) !== +new Date(q.claimedAt)) return null;
        Object.assign(row, u.$set);
        return row;
      }),
      updateOne: jest.fn(async ({ key }, u) => { if (store.has(key)) Object.assign(store.get(key), u.$set); }),
      deleteOne: jest.fn(async ({ key, status }) => { if (store.get(key)?.status === status) store.delete(key); }),
    }));
  });

  test('client ids are validated', () => {
    const g = require('../sendGuard.service');
    expect(g.normalizeClientId('local_1728800000000')).toBe('local_1728800000000');
    expect(g.normalizeClientId('')).toBeNull();
    expect(g.normalizeClientId('bad id with spaces')).toBeNull();
    expect(g.normalizeClientId('x'.repeat(101))).toBeNull();
  });

  test('first request claims; a parallel retry is told it is in progress; after success the retry gets the same message', async () => {
    const g = require('../sendGuard.service');
    const chatId = 'c'.repeat(24);
    const a = await g.claim({ chatId, clientMessageId: 'm1', userId: 'u1' });
    expect(a.claimed).toBe(true);
    const b = await g.claim({ chatId, clientMessageId: 'm1', userId: 'u1' });
    expect(b.inProgress).toBe(true);
    await g.complete(a.key, 'msg-123');
    const c = await g.claim({ chatId, clientMessageId: 'm1', userId: 'u1' });
    expect(c.existing).toBe('msg-123');
  });

  test('a failed send releases the claim so a retry can send', async () => {
    const g = require('../sendGuard.service');
    const chatId = 'c'.repeat(24);
    const a = await g.claim({ chatId, clientMessageId: 'm2', userId: 'u1' });
    await g.release(a.key);
    const b = await g.claim({ chatId, clientMessageId: 'm2', userId: 'u1' });
    expect(b.claimed).toBe(true);
  });

  test('a claim left pending by a crash can be taken over after 5 minutes', async () => {
    const g = require('../sendGuard.service');
    const chatId = 'c'.repeat(24);
    const t0 = new Date('2026-10-13T10:00:00Z');
    await g.claim({ chatId, clientMessageId: 'm3', userId: 'u1', now: t0 });
    const early = await g.claim({ chatId, clientMessageId: 'm3', userId: 'u1', now: new Date(t0.getTime() + 60e3) });
    expect(early.inProgress).toBe(true);
    const late = await g.claim({ chatId, clientMessageId: 'm3', userId: 'u1', now: new Date(t0.getTime() + 6 * 60e3) });
    expect(late.claimed).toBe(true);
  });

  test('the same client id in another chat is independent', async () => {
    const g = require('../sendGuard.service');
    expect((await g.claim({ chatId: 'a'.repeat(24), clientMessageId: 'same', userId: 'u' })).claimed).toBe(true);
    expect((await g.claim({ chatId: 'b'.repeat(24), clientMessageId: 'same', userId: 'u' })).claimed).toBe(true);
  });
});

// ---------------------------------------------------------------- assign on answer
describe('assign customer to the person who answers', () => {
  const { decide, assignmentTexts, assignChatToAnswerer } = require('../calls/assignOnAnswer');
  const A = 'a'.repeat(24);
  const B = 'b'.repeat(24);
  const CHAT = 'c'.repeat(24);

  test('decision rules', () => {
    expect(decide({ chat: { assignedTo: A }, answeredBy: A }).action).toBe('none');
    expect(decide({ chat: { assignedTo: A }, answeredBy: B }).action).toBe('assign');
    expect(decide({ chat: { assignedTo: null }, answeredBy: B }).action).toBe('assign');
    expect(decide({ chat: { assignedTo: A }, answeredBy: B, isMonthlyChat: true }).reason).toBe('monthly-chat');
    expect(decide({ chat: null, answeredBy: B }).action).toBe('none');
  });

  function fakeModels(chat) {
    const emitted = [];
    const created = { activity: [], message: [] };
    const models = {
      Chat: {
        findById: jest.fn(() => {
          const q = { select: () => ({ lean: async () => ({ ...chat }) }), populate: () => q, then: (r) => r({ ...chat }) };
          return q;
        }),
        findOneAndUpdate: jest.fn(async (filter, update) => {
          if (String(filter.assignedTo || null) !== String(chat.assignedTo || null)) return null;
          chat.assignedTo = update.$set.assignedTo;
          return { ...chat };
        }),
      },
      ChatActivity: { create: jest.fn(async (d) => created.activity.push(d)) },
      Message: { create: jest.fn(async (d) => { created.message.push(d); return { _id: 'm', ...d }; }) },
      User: { findById: (id) => ({ select: () => ({ lean: async () => ({ name: id === A ? 'Staff A' : 'Staff B' }) }) }) },
    };
    const meEvents = [];
    const io = { emit: (e) => emitted.push(e), to: () => ({ emit: (e, p) => { emitted.push(`me:${e}`); meEvents.push(p); } }) };
    const notified = [];
    return { models, created, emitted, meEvents, notified, notify: async (n) => notified.push(n), getIO: () => io };
  }

  test('staff B answers an escalated call: chat moves from A to B, activity + system message + socket events', async () => {
    const chat = { _id: CHAT, assignedTo: A, wabaId: 'w' };
    const f = fakeModels(chat);
    const r = await assignChatToAnswerer(
      { _id: 'call1', direction: 'inbound', chatId: CHAT, answeredBy: B, metadata: { contactName: 'Rina Das' } },
      { models: f.models, isMonthly: async () => false, getIO: f.getIO, notify: f.notify },
    );
    expect(r.action).toBe('assign');
    expect(chat.assignedTo).toBe(B);
    expect(f.created.activity[0].details.reason).toBe('call_answered:call1');
    expect(f.created.message[0].text).toBe('Staff B answered a WhatsApp call and was assigned this chat (previously assigned to Staff A)');
    expect(f.created.message[0].metadata.previousAssignee).toEqual({ id: A, name: 'Staff A' });
    expect(f.emitted).toEqual(expect.arrayContaining(['chat:assigned', 'chat:update', 'message:new', 'me:chat:assigned:me']));
    expect(f.meEvents[0].previousAssigneeName).toBe('Staff A');
    // the new assignee learns who had the customer; the previous assignee learns who took over
    expect(f.notified).toHaveLength(2);
    expect(f.notified[0]).toMatchObject({ recipientId: B, title: 'Chat assigned to you' });
    expect(f.notified[0].body).toMatch(/Rina Das.*previously handled by Staff A/);
    expect(f.notified[1]).toMatchObject({ recipientId: A, title: 'Chat reassigned' });
    expect(f.notified[1].body).toMatch(/Staff B answered Rina Das's call/);
  });

  test('unassigned chat: says nobody had it, only the answerer is notified', async () => {
    const chat = { _id: CHAT, assignedTo: null, wabaId: 'w' };
    const f = fakeModels(chat);
    await assignChatToAnswerer({ _id: 'c', direction: 'inbound', chatId: CHAT, answeredBy: B, waId: '919800000000' },
      { models: f.models, isMonthly: async () => false, getIO: f.getIO, notify: f.notify });
    expect(f.created.message[0].text).toMatch(/not assigned to anyone before/);
    expect(f.notified).toHaveLength(1);
    expect(f.notified[0].body).toMatch(/\+919800000000's call/);
  });

  test('handover texts', () => {
    const t = assignmentTexts({ answererName: 'Priya', previousName: 'Rahul', customerName: 'Mr Sen' });
    expect(t.systemMessage).toBe('Priya answered a WhatsApp call and was assigned this chat (previously assigned to Rahul)');
    expect(t.toPreviousAssignee.body).toBe("Priya answered Mr Sen's call and is now handling this customer.");
    expect(assignmentTexts({ answererName: 'Priya', previousName: null }).toPreviousAssignee).toBeNull();
  });

  test('assigned staff answers: nothing changes', async () => {
    const chat = { _id: CHAT, assignedTo: A };
    const f = fakeModels(chat);
    const r = await assignChatToAnswerer({ _id: 'c', direction: 'inbound', chatId: CHAT, answeredBy: A }, { models: f.models, isMonthly: async () => false, getIO: f.getIO });
    expect(r.reason).toBe('already-assigned');
    expect(f.models.Chat.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('monthly chat keeps its assignee', async () => {
    const chat = { _id: CHAT, assignedTo: A };
    const f = fakeModels(chat);
    const r = await assignChatToAnswerer({ _id: 'c', direction: 'inbound', chatId: CHAT, answeredBy: B }, { models: f.models, isMonthly: async () => true, getIO: f.getIO });
    expect(r.reason).toBe('monthly-chat');
    expect(chat.assignedTo).toBe(A);
  });

  test('a manual reassignment at the same moment is not overwritten', async () => {
    const chat = { _id: CHAT, assignedTo: A };
    const f = fakeModels(chat);
    // someone reassigns to C between our read and our conditional write
    f.models.Chat.findOneAndUpdate.mockImplementationOnce(async () => null);
    const r = await assignChatToAnswerer({ _id: 'c', direction: 'inbound', chatId: CHAT, answeredBy: B }, { models: f.models, isMonthly: async () => false, getIO: f.getIO });
    expect(r.reason).toBe('changed-meanwhile');
    expect(f.created.activity).toHaveLength(0);
  });

  test('outbound calls and calls without chat are ignored', async () => {
    const f = fakeModels({ _id: CHAT, assignedTo: A });
    expect((await assignChatToAnswerer({ direction: 'outbound', chatId: CHAT, answeredBy: B }, { models: f.models })).action).toBe('none');
    expect((await assignChatToAnswerer({ direction: 'inbound', answeredBy: B }, { models: f.models })).action).toBe('none');
  });
});

// ---------------------------------------------------------------- logout safety
describe('logout never deletes other users\' sessions', () => {
  beforeEach(() => jest.resetModules());
  test('anonymous logout without refresh token is rejected; with token deletes only that session', async () => {
    const deleteMany = jest.fn();
    const deleteOne = jest.fn();
    jest.doMock('../../models/Session', () => ({ deleteMany, deleteOne }));
    const auth = require('../auth.service');
    await expect(auth.logout(undefined, undefined)).rejects.toThrow('Refresh token required');
    expect(deleteMany).not.toHaveBeenCalled();
    await auth.logout(undefined, 'rt-1');
    expect(deleteOne).toHaveBeenCalledWith({ $or: [{ refreshToken: 'rt-1' }, { previousRefreshToken: 'rt-1' }] });
    await auth.logout('u1');
    expect(deleteMany).toHaveBeenCalledWith({ userId: 'u1' });
  });
});
