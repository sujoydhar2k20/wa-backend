'use strict';

/**
 * Regression tests: broadcasting must never change a customer's staff assignment.
 * Uses an in-memory fake of the Chat collection, so the exact update documents the
 * broadcast code sends are inspected and applied with real $set / $setOnInsert semantics.
 */

const chats = new Map();
const mockChats = chats; // key `${wabaId}:${waId}` -> doc
const writes = [];       // every update document sent to Chat
let nextId = 1;
const emitted = [];
const mockEmitted = emitted;

const mockFakeChat = {
  findOneAndUpdate: jest.fn(async (filter, update, opts = {}) => {
    writes.push({ op: 'findOneAndUpdate', update });
    const key = `${filter.wabaId}:${filter.waId}`;
    let doc = chats.get(key);
    if (!doc && opts.upsert) {
      doc = { _id: `c${nextId++}`, assignedTo: null, collaborators: [], ...update.$setOnInsert };
      chats.set(key, doc);
    }
    return doc;
  }),
  findByIdAndUpdate: jest.fn(async (id, update) => {
    writes.push({ op: 'findByIdAndUpdate', update });
    const doc = [...chats.values()].find((c) => c._id === id);
    if (doc && update.$set) Object.assign(doc, update.$set);
    return doc;
  }),
};

jest.mock('../../models', () => ({
  Broadcast: {}, BroadcastBatch: {}, BroadcastMessage: {}, BroadcastListMember: {}, Waba: {}, Contact: {},
  Template: {},
  Chat: mockFakeChat,
  Message: { create: jest.fn(async (d) => ({ _id: 'm1', ...d })) },
}));
jest.mock('../whatsapp.service', () => ({
  getTemplateHeaderImageUrl: jest.fn(async () => null),
  withHostedHeaderImage: jest.fn((c) => c),
}));
jest.mock('../../websocket/socket.server', () => ({
  getIO: () => ({ emit: (ev, payload) => mockEmitted.push({ ev, payload }) }),
}));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock('../../utils/chatSocket', () => ({
  loadChatForSocket: jest.fn(async (id) => {
    const doc = [...mockChats.values()].find((c) => c._id === id);
    // mimic populate: assignedTo becomes an object
    return { ...doc, assignedTo: doc.assignedTo ? { _id: doc.assignedTo, name: 'Staff' } : null };
  }),
}));

const { recordBroadcastInChat } = require('../broadcast.service');

const broadcast = { _id: { toString: () => 'b1' }, wabaId: 'W1', phoneNumberId: 'P1' };
const template = { name: 'promo', language: 'en' };
const run = (phone, extra = {}) =>
  recordBroadcastInChat({ broadcast, template, phoneNumber: phone, contactId: 'ct1', messageId: 'wamid', contactResolvedText: 'hi', resolvedTemplateComponents: [], ...extra });

const seed = (waId, fields) => chats.set(`W1:${waId}`, { _id: `c${nextId++}`, waId, assignedTo: null, collaborators: [], ...fields });

beforeEach(() => { chats.clear(); writes.length = 0; emitted.length = 0; });

const OWNERSHIP = ['assignedTo', 'collaborators'];
const touchesOwnership = (u) => JSON.stringify(u).match(/assignedTo|collaborators/);

describe('broadcast never changes staff assignment', () => {
  test('chat assigned to one staff member stays assigned', async () => {
    seed('911', { assignedTo: 'staffA' });
    await run('+911');
    expect(chats.get('W1:911').assignedTo).toBe('staffA');
  });

  test('chat with assignee + collaborators keeps all of them', async () => {
    seed('912', { assignedTo: 'staffA', collaborators: ['staffB', 'staffC'] });
    await run('+912');
    const c = chats.get('W1:912');
    expect(c.assignedTo).toBe('staffA');
    expect(c.collaborators).toEqual(['staffB', 'staffC']);
  });

  test('unassigned chat stays unassigned (also when freshly created)', async () => {
    seed('913', {});
    await run('+913');
    await run('+914'); // no chat yet -> created
    expect(chats.get('W1:913').assignedTo).toBeNull();
    expect(chats.get('W1:914').assignedTo).toBeNull();
    expect(chats.get('W1:914').status).toBe('closed');
  });

  test('no update sent to Chat ever contains an ownership field', async () => {
    seed('915', { assignedTo: 'staffA', collaborators: ['staffB'] });
    await run('+915');
    await run('+916');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(touchesOwnership(w.update)).toBeNull();
  });

  test('retry / duplicate processing leaves assignment untouched and creates one chat', async () => {
    seed('917', { assignedTo: 'staffA', collaborators: ['staffB'] });
    for (let i = 0; i < 3; i++) await run('+917');
    for (let i = 0; i < 3; i++) await run('+918');
    expect(chats.get('W1:917').assignedTo).toBe('staffA');
    expect(chats.get('W1:917').collaborators).toEqual(['staffB']);
    expect([...chats.keys()].filter((k) => k.endsWith(':918'))).toHaveLength(1);
  });

  test('bulk processing of many recipients preserves every assignment', async () => {
    const expected = {};
    for (let i = 0; i < 500; i++) {
      const owner = i % 3 === 0 ? null : `staff${i % 5}`;
      seed(`9${1000 + i}`, { assignedTo: owner });
      expected[`9${1000 + i}`] = owner;
    }
    for (const waId of Object.keys(expected)) await run(`+${waId}`);
    for (const [waId, owner] of Object.entries(expected)) expect(chats.get(`W1:${waId}`).assignedTo).toBe(owner);
  });

  test('a concurrent assignment made while the broadcast is running is not overwritten', async () => {
    seed('919', {});
    const doc = chats.get('W1:919');
    // Staff claims the chat in the middle of broadcast processing (before the timestamp update lands).
    const original = mockFakeChat.findByIdAndUpdate.getMockImplementation();
    mockFakeChat.findByIdAndUpdate.mockImplementationOnce(async (id, update) => {
      doc.assignedTo = 'staffNew';
      return original(id, update);
    });
    await run('+919');
    expect(doc.assignedTo).toBe('staffNew');
  });

  test('failure while mirroring into the chat (failed broadcast path) does not alter assignment', async () => {
    seed('920', { assignedTo: 'staffA' });
    mockFakeChat.findByIdAndUpdate.mockImplementationOnce(async () => { throw new Error('db down'); });
    await expect(run('+920')).resolves.toBeUndefined();
    expect(chats.get('W1:920').assignedTo).toBe('staffA');
  });

  test('socket chat:update payload carries a populated assignee, not a bare id', async () => {
    seed('921', { assignedTo: 'staffA' });
    await run('+921');
    const upd = emitted.find((e) => e.ev === 'chat:update');
    expect(typeof upd.payload.chat.assignedTo).toBe('object');
    expect(upd.payload.chat.assignedTo.name).toBe('Staff');
  });
});
