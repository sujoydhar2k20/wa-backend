/**
 * Integration tests: automatic random staff assignment of incoming customer messages
 * (webhook -> database), with a real in-memory MongoDB and mocked Meta / socket / bot services.
 */
jest.setTimeout(90000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('../whatsapp.service', () => ({
  downloadMedia: jest.fn(async () => Buffer.from('x')),
  markMessageAsRead: jest.fn(async () => ({})),
  getTemplateHeaderImageUrl: jest.fn(async () => null),
  withHostedHeaderImage: jest.fn((c) => c),
}));
jest.mock('../../utils/vpsUpload', () => ({ uploadToVPS: jest.fn(async () => 'https://cdn.example/f') }));
jest.mock('../bot.service', () => ({
  processIncomingMessage: jest.fn(async () => {}),
  processOpenConversation: jest.fn(async () => {}),
  cancelStaleExecutions: jest.fn(async () => {}),
}));
jest.mock('../aiFallback.service', () => ({ handleAiFallback: jest.fn(async () => {}) }));
jest.mock('../ocr.service', () => ({ extractTextFromImageBuffer: jest.fn(async () => ({ text: '' })) }));
jest.mock('../notification.service', () => ({ notifyMultipleUsers: jest.fn(async () => {}), createNotification: jest.fn(async () => {}) }));
jest.mock('../media.service', () => ({ saveMediaMetadata: jest.fn(async () => ({})) }));

const mongoose = require('mongoose');
const { Waba, Message, Chat, Contact, User, Tag, ChatActivity } = require('../../models');
const webhook = require('../webhook.service');
const notifications = require('../notification.service');
const { autoAssignIncomingChat, pickRandom } = require('../autoAssign.service');

const WABA_META = '2000000001';
const OTHER_WABA_META = '2000000002';
const PNID = 'pn-aa';
let n = 0;
let phoneSeq = 0;
const ts = () => String(Math.floor(Date.now() / 1000));
const nextId = () => `wamid.AA${++n}`;
const newPhone = () => `9198${String(++phoneSeq).padStart(8, '0')}`;

let waba;
let otherWaba;

function entry(from, messages, name = 'Customer', meta = WABA_META) {
  return {
    id: meta,
    changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ profile: { name }, wa_id: from }], messages } }],
  };
}
const textMsg = (from, body = 'hello', extra = {}) => ({ from, id: nextId(), timestamp: ts(), type: 'text', text: { body }, ...extra });

let userSeq = 0;
async function makeUser(over = {}) {
  return User.create({ phone: `90000${String(++userSeq).padStart(5, '0')}`, name: `User ${userSeq}`, role: 'staff', isActive: true, assignedWabaId: waba._id, ...over });
}
const chatOf = (waId) => Chat.findOne({ waId }).lean();

beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.clear();
  jest.clearAllMocks();
  mockIo.events.length = 0;
  waba = await Waba.create({ wabaId: WABA_META, businessName: 'BJS', accessToken: 't', phoneNumbers: [{ phoneNumberId: PNID, phoneNumber: '919000000000' }] });
  otherWaba = await Waba.create({ wabaId: OTHER_WABA_META, businessName: 'Other', accessToken: 't', phoneNumbers: [{ phoneNumberId: 'pn-other', phoneNumber: '919000000001' }] });
});

describe('1. new incoming message (customer without "monthly")', () => {
  test('assigned to one eligible staff member, saved, notified, and shown populated in the dashboard event', async () => {
    const staff = [await makeUser(), await makeUser(), await makeUser()];
    const from = newPhone();
    await webhook.processWebhook(entry(from, [textMsg(from)]));

    const chat = await chatOf(from);
    expect(staff.map((s) => String(s._id))).toContain(String(chat.assignedTo));
    expect(await Message.countDocuments({ chatId: chat._id })).toBe(1);

    const act = await ChatActivity.find({ chatId: chat._id }).lean();
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ type: 'assigned', details: { reason: 'auto_random_incoming' } });
    expect(String(act[0].details.assignedTo)).toBe(String(chat.assignedTo));

    // The assignee (not the admins) is notified about the new message.
    expect(notifications.notifyMultipleUsers).toHaveBeenCalledTimes(1);
    expect(notifications.notifyMultipleUsers.mock.calls[0][0]).toEqual([String(chat.assignedTo)]);

    // Staff dashboard: chat:update carries the populated assignee (name), never a bare id.
    const upd = mockIo.events.filter((e) => e.event === 'chat:update').pop();
    expect(upd.payload.chat.assignedTo).toMatchObject({ name: expect.any(String) });
    expect(String(upd.payload.chat.assignedTo._id)).toBe(String(chat.assignedTo));
  });

  test('the choice is random (spread over all eligible staff)', async () => {
    const staff = [await makeUser(), await makeUser(), await makeUser()];
    const counts = new Map(staff.map((s) => [String(s._id), 0]));
    for (let i = 0; i < 45; i++) {
      const from = newPhone();
      await webhook.processWebhook(entry(from, [textMsg(from)]));
      const c = await chatOf(from);
      counts.set(String(c.assignedTo), counts.get(String(c.assignedTo)) + 1);
    }
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(45);
    // With 45 uniform picks over 3 staff, each receiving at least one is near-certain (p of failure < 1e-7).
    for (const v of counts.values()) expect(v).toBeGreaterThan(0);
  });

  test('pickRandom is uniform and safe at the edges', () => {
    expect(pickRandom([], Math.random)).toBeNull();
    expect(pickRandom(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pickRandom(['a', 'b', 'c'], () => 0.9999999)).toBe('c');
    expect(pickRandom(['a', 'b', 'c'], () => 1)).toBe('c'); // misbehaving rng never goes out of range
  });
});

describe('2. reply to a WhatsApp broadcast', () => {
  test('the chat created by the broadcast (unassigned, closed) is assigned when the customer replies', async () => {
    const staff = [await makeUser(), await makeUser()];
    const from = newPhone();
    const contact = await Contact.create({ waId: from, phoneNumber: from, name: 'Bcast Customer' });
    const { recordBroadcastInChat } = require('../broadcast.service');
    const broadcast = { _id: new mongoose.Types.ObjectId(), wabaId: waba._id, phoneNumberId: PNID };
    const template = { name: 'offer', language: 'en' };
    const bmid = 'wamid.BROADCAST1';
    await recordBroadcastInChat({ broadcast, template, phoneNumber: from, contactId: contact._id, messageId: bmid, contactResolvedText: 'Diwali offer', resolvedTemplateComponents: [] });

    const before = await chatOf(from);
    expect(before.assignedTo == null).toBe(true);
    expect(before.status).toBe('closed');

    // Customer taps the template button / replies with context.
    await webhook.processWebhook(entry(from, [{ from, id: nextId(), timestamp: ts(), type: 'button', context: { from: '919000000000', id: bmid }, button: { text: 'Interested', payload: 'Interested' } }]));
    const after = await chatOf(from);
    expect(staff.map((s) => String(s._id))).toContain(String(after.assignedTo));
    expect(after.status).toBe('open');
    expect(await Chat.countDocuments({ waId: from })).toBe(1); // no duplicate conversation
  });

  test('50 of 500 broadcast recipients reply: every replying chat is assigned, the other 450 stay untouched', async () => {
    const staff = [await makeUser(), await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const phones = Array.from({ length: 500 }, newPhone);
    await Chat.insertMany(phones.map((p) => ({ wabaId: waba._id, phoneNumberId: PNID, waId: p, phoneNumber: p, status: 'closed', isUnread: false, lastCustomerMessageAt: new Date(0) })));
    const repliers = phones.slice(0, 50);
    // All 50 webhooks arrive at the same time.
    await Promise.all(repliers.map((p) => webhook.processWebhook(entry(p, [textMsg(p, 'yes please')]))));

    const ids = new Set(staff.map((s) => String(s._id)));
    const replied = await Chat.find({ waId: { $in: repliers } }).lean();
    expect(replied).toHaveLength(50);
    for (const c of replied) expect(ids.has(String(c.assignedTo))).toBe(true);
    expect(await Chat.countDocuments({ waId: { $nin: repliers }, assignedTo: { $ne: null } })).toBe(0);
    expect(await Chat.countDocuments({})).toBe(500); // no duplicates
    expect(await Message.countDocuments({ direction: 'inbound' })).toBe(50);
  });

  test('a reaction to the broadcast also assigns, and the dashboard gets the update', async () => {
    const s = await makeUser();
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, status: 'closed' });
    await Message.create({ chatId: (await chatOf(from))._id, wabaId: waba._id, phoneNumberId: PNID, messageId: 'wamid.B2', waId: from, direction: 'outbound', type: 'template', status: 'sent' });
    await webhook.processWebhook(entry(from, [{ from, id: nextId(), timestamp: ts(), type: 'reaction', reaction: { message_id: 'wamid.B2', emoji: '👍' } }]));
    const c = await chatOf(from);
    expect(String(c.assignedTo)).toBe(String(s._id));
    const upd = mockIo.events.filter((e) => e.event === 'chat:update').pop();
    expect(upd.payload.chat.assignedTo).toMatchObject({ name: s.name });
  });
});

describe('3. customers tagged "monthly" keep the existing behaviour', () => {
  test('contact tag: new chat stays unassigned and admins are notified (as before)', async () => {
    await makeUser();
    const admin = await makeUser({ role: 'admin', assignedWabaId: null });
    const tag = await Tag.create({ name: 'monthly', color: '#888888' });
    const from = newPhone();
    await Contact.create({ waId: from, phoneNumber: from, tags: [tag._id] });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    const c = await chatOf(from);
    expect(c.assignedTo == null).toBe(true);
    expect(await ChatActivity.countDocuments({ chatId: c._id })).toBe(0);
    expect(notifications.notifyMultipleUsers.mock.calls[0][0]).toEqual([String(admin._id)]);
  });

  test('chat tag (any case, as the existing helper matches) on an existing unassigned chat: untouched', async () => {
    await makeUser();
    const tag = await Tag.create({ name: 'Monthly', color: '#888888' });
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, tags: [tag._id] });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect((await chatOf(from)).assignedTo == null).toBe(true);
  });

  test('monthly chat assigned to an inactive user is NOT reassigned (only the existing rules apply)', async () => {
    await makeUser();
    const gone = await makeUser({ isActive: false });
    const tag = await Tag.create({ name: 'monthly', color: '#888888' });
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, tags: [tag._id], assignedTo: gone._id });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(gone._id));
  });

  test('a "monthly" tag check that fails never assigns (fail closed)', async () => {
    await makeUser();
    const from = newPhone();
    const spy = jest.spyOn(Tag, 'findOne').mockImplementation(() => { throw new Error('db hiccup'); });
    try {
      await webhook.processWebhook(entry(from, [textMsg(from)]));
    } finally {
      spy.mockRestore();
    }
    const c = await chatOf(from);
    expect(c.assignedTo == null).toBe(true);
    expect(await Message.countDocuments({ chatId: c._id })).toBe(1); // the message itself is still stored
  });

  test('a similar but different tag ("monthly-old") does not count as monthly', async () => {
    const s = await makeUser();
    const tag = await Tag.create({ name: 'monthly-old', color: '#888888' });
    const from = newPhone();
    await Contact.create({ waId: from, phoneNumber: from, tags: [tag._id] });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(s._id));
  });
});

describe('4. an existing valid assignment is kept', () => {
  test('active staff assignee is never changed', async () => {
    const owner = await makeUser();
    await makeUser(); await makeUser();
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, assignedTo: owner._id });
    for (let i = 0; i < 5; i++) await webhook.processWebhook(entry(from, [textMsg(from, `m${i}`)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(owner._id));
    expect(await ChatActivity.countDocuments({})).toBe(0);
  });

  test('a manual assignment to an admin is kept too', async () => {
    await makeUser();
    const admin = await makeUser({ role: 'admin', assignedWabaId: null });
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, assignedTo: admin._id });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(admin._id));
  });

  test('collaborators, tags and other chat fields are not touched by the assignment', async () => {
    await makeUser();
    const collab = await makeUser();
    const tag = await Tag.create({ name: 'vip', color: '#888888' });
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, collaborators: [collab._id], tags: [tag._id], isDnd: true });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    const c = await chatOf(from);
    expect(c.assignedTo).toBeTruthy();
    expect(c.collaborators.map(String)).toEqual([String(collab._id)]);
    expect(c.tags.map(String)).toEqual([String(tag._id)]);
    expect(c.isDnd).toBe(true);
  });
});

describe('5. inactive or ineligible staff are never selected', () => {
  test('only active staff of the same WABA can be picked', async () => {
    const good = await makeUser();
    await makeUser({ isActive: false });
    await makeUser({ assignedWabaId: otherWaba._id });
    await makeUser({ assignedWabaId: null });
    await makeUser({ role: 'admin' });
    await makeUser({ role: 'superadmin' });
    for (let i = 0; i < 15; i++) {
      const from = newPhone();
      await webhook.processWebhook(entry(from, [textMsg(from)]));
      expect(String((await chatOf(from)).assignedTo)).toBe(String(good._id));
    }
  });

  test('a chat whose assignee was deactivated or deleted is reassigned to an eligible staff member', async () => {
    const good = await makeUser();
    const inactive = await makeUser({ isActive: false });
    const a = newPhone();
    const b = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: a, phoneNumber: a, assignedTo: inactive._id });
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: b, phoneNumber: b, assignedTo: new mongoose.Types.ObjectId() });
    await webhook.processWebhook(entry(a, [textMsg(a)]));
    await webhook.processWebhook(entry(b, [textMsg(b)]));
    expect(String((await chatOf(a)).assignedTo)).toBe(String(good._id));
    expect(String((await chatOf(b)).assignedTo)).toBe(String(good._id));
    const act = await ChatActivity.findOne({ chatId: (await chatOf(a))._id }).lean();
    expect(act).toMatchObject({ type: 'auto_transferred', details: { reason: 'incoming_message:assignee_inactive' } });
    expect(String(act.details.fromStaffId)).toBe(String(inactive._id));
  });
});

describe('6. no eligible staff available', () => {
  test('chat stays unassigned, the message is stored and admins are notified; nothing fails', async () => {
    const admin = await makeUser({ role: 'admin', assignedWabaId: null });
    await makeUser({ isActive: false });
    const from = newPhone();
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    const c = await chatOf(from);
    expect(c.assignedTo == null).toBe(true);
    expect(await Message.countDocuments({ chatId: c._id })).toBe(1);
    expect(notifications.notifyMultipleUsers.mock.calls[0][0]).toEqual([String(admin._id)]);
    const { WebhookFailure } = require('../../models');
    expect(await WebhookFailure.countDocuments()).toBe(0);
  });

  test('inactive assignee with nobody to take over: kept as is (no invalid account written)', async () => {
    const inactive = await makeUser({ isActive: false });
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, assignedTo: inactive._id });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(inactive._id));
  });
});

describe('7. simultaneous messages', () => {
  test('many messages from the SAME new customer at once: one chat, one assignee, one assignment record', async () => {
    await makeUser(); await makeUser(); await makeUser(); await makeUser();
    const from = newPhone();
    const msgs = Array.from({ length: 8 }, (_, i) => textMsg(from, `burst ${i}`));
    await Promise.all(msgs.map((m) => webhook.processWebhook(entry(from, [m]))));
    // Any message that lost the new-chat insert race is queued for retry; run the retry job.
    await webhook.retryFailedMessages({ now: new Date(Date.now() + 3600e3) });

    expect(await Chat.countDocuments({ waId: from })).toBe(1);
    const c = await chatOf(from);
    expect(c.assignedTo).toBeTruthy();
    expect(await Message.countDocuments({ chatId: c._id })).toBe(8);
    expect(await ChatActivity.countDocuments({ chatId: c._id })).toBe(1);
  });

  test('many messages from the same EXISTING unassigned customer at once: exactly one assignment', async () => {
    await makeUser(); await makeUser(); await makeUser(); await makeUser();
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, status: 'closed' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => webhook.processWebhook(entry(from, [textMsg(from, `x${i}`)]))));
    const c = await chatOf(from);
    expect(c.assignedTo).toBeTruthy();
    expect(await ChatActivity.countDocuments({ chatId: c._id })).toBe(1);
    expect(await Message.countDocuments({ chatId: c._id })).toBe(10);
  });

  test('a manual assignment that lands first is never overwritten (compare-and-set)', async () => {
    await makeUser();
    const manual = await makeUser();
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from });
    const stale = await Chat.findOne({ waId: from }); // what the webhook loaded: unassigned
    await Chat.updateOne({ _id: stale._id }, { $set: { assignedTo: manual._id } }); // admin assigns meanwhile
    const r = await autoAssignIncomingChat({ chat: stale, wabaId: waba._id });
    expect(r).toMatchObject({ action: 'none', reason: 'assigned_concurrently' });
    expect(String((await chatOf(from)).assignedTo)).toBe(String(manual._id));
    expect(String(stale.assignedTo)).toBe(String(manual._id)); // in-memory copy adopts the stored value
    expect(stale.isModified('assignedTo')).toBe(false); // a later save cannot revert it
  });
});

describe('8. WhatsApp retries the same webhook event', () => {
  test('same event delivered 3 times (also concurrently): one message, one assignment, no reassignment', async () => {
    await makeUser(); await makeUser(); await makeUser();
    const from = newPhone();
    const msg = textMsg(from);
    await webhook.processWebhook(entry(from, [msg]));
    const first = await chatOf(from);
    await Promise.all([webhook.processWebhook(entry(from, [msg])), webhook.processWebhook(entry(from, [msg]))]);
    const after = await chatOf(from);
    expect(String(after.assignedTo)).toBe(String(first.assignedTo));
    expect(await Message.countDocuments({ chatId: first._id })).toBe(1);
    expect(await ChatActivity.countDocuments({ chatId: first._id })).toBe(1);
    expect(notifications.notifyMultipleUsers).toHaveBeenCalledTimes(1);
  });
});

describe('9. missing or invalid tag / assignment data', () => {
  test('contact without a tags array, chat with a null tag entry, no "monthly" tag defined: assigned normally', async () => {
    const s = await makeUser();
    const from = newPhone();
    await Contact.collection.insertOne({ waId: from, phoneNumber: from, name: 'NoTags' }); // no tags field at all
    await Chat.collection.insertOne({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, tags: [null], status: 'open' });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(s._id));
  });

  test('assignedTo stored as an id of a user that no longer exists: treated as needing a new assignment', async () => {
    const s = await makeUser();
    const from = newPhone();
    await Chat.collection.insertOne({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, assignedTo: new mongoose.Types.ObjectId(), status: 'open' });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(s._id));
  });

  test('assignedTo explicitly null (e.g. after a manual unassign) gets assigned on the next customer message', async () => {
    const s = await makeUser();
    const from = newPhone();
    await Chat.collection.insertOne({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from, assignedTo: null, status: 'open' });
    await webhook.processWebhook(entry(from, [textMsg(from)]));
    expect(String((await chatOf(from)).assignedTo)).toBe(String(s._id));
  });

  test('WhatsApp system notices do not trigger an assignment', async () => {
    await makeUser();
    const from = newPhone();
    await Chat.create({ wabaId: waba._id, phoneNumberId: PNID, waId: from, phoneNumber: from });
    await webhook.processWebhook(entry(from, [{ from, id: nextId(), timestamp: ts(), type: 'system', system: { body: 'changed number', type: 'customer_changed_number' } }]));
    expect((await chatOf(from)).assignedTo == null).toBe(true);
  });

  test('a database error during assignment never stops message processing', async () => {
    await makeUser();
    const from = newPhone();
    const spy = jest.spyOn(User, 'find').mockImplementationOnce(() => { throw new Error('boom'); });
    try {
      await webhook.processWebhook(entry(from, [textMsg(from)]));
    } finally {
      spy.mockRestore();
    }
    const c = await chatOf(from);
    expect(await Message.countDocuments({ chatId: c._id })).toBe(1);
    expect(mockIo.events.map((e) => e.event)).toContain('message:new');
  });
});
