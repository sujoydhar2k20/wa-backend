/**
 * Integration tests: inbound WhatsApp webhook -> database, with a real (in-memory) MongoDB and mocked
 * Meta / storage / socket / bot services. Payload shapes follow the Cloud API webhook reference.
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
const io = mockIo;
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('../whatsapp.service', () => ({
  downloadMedia: jest.fn(async () => Buffer.from('RIFFxxxxWEBPVP8 ')),
  markMessageAsRead: jest.fn(async () => ({})),
}));
jest.mock('../../utils/vpsUpload', () => ({ uploadToVPS: jest.fn(async () => 'https://cdn.example/inbound/file.webp') }));
jest.mock('../bot.service', () => ({
  processIncomingMessage: jest.fn(async () => {}),
  processOpenConversation: jest.fn(async () => {}),
  cancelStaleExecutions: jest.fn(async () => {}),
}));
jest.mock('../aiFallback.service', () => ({ handleAiFallback: jest.fn(async () => {}) }));
jest.mock('../ocr.service', () => ({ extractTextFromImageBuffer: jest.fn(async () => ({ text: '' })) }));
jest.mock('../notification.service', () => ({ notifyMultipleUsers: jest.fn(async () => {}), createNotification: jest.fn(async () => {}) }));
jest.mock('../media.service', () => ({ saveMediaMetadata: jest.fn(async () => ({})) }));

const { Waba, Message, Chat, WebhookFailure } = require('../../models');
const webhook = require('../webhook.service');
const bot = require('../bot.service');
const notifications = require('../notification.service');
const whatsapp = require('../whatsapp.service');
const vps = require('../../utils/vpsUpload');

const WABA_META = '1000000001';
const PNID = 'pn-1';
const CUSTOMER = '919800000001';
let n = 0;
const ts = () => String(Math.floor(Date.now() / 1000));
const nextId = () => `wamid.TEST${++n}`;

function entry(messages, contacts = [{ profile: { name: 'Rina' }, wa_id: CUSTOMER }]) {
  return { id: WABA_META, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts, messages } }] };
}
const base = (type, extra) => ({ from: CUSTOMER, id: nextId(), timestamp: ts(), type, ...extra });

beforeAll(async () => {
  await db.start();
});
afterAll(async () => {
  await db.stop();
});
beforeEach(async () => {
  await db.clear();
  jest.clearAllMocks();
  io.events.length = 0;
  await Waba.create({ wabaId: WABA_META, businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: PNID, phoneNumber: '919000000000' }] });
});

async function only(filter = {}) {
  const all = await Message.find(filter).lean();
  expect(all).toHaveLength(1);
  return all[0];
}

describe('template quick-reply button replies (regression: were silently dropped)', () => {
  test('stored as a readable message, once, with the template context', async () => {
    const msg = base('button', { context: { from: '919000000000', id: 'wamid.TEMPLATE1' }, button: { payload: 'Interested', text: 'Interested' } });
    await webhook.processWebhook(entry([msg]));
    const m = await only();
    expect(m.type).toBe('button');
    expect(m.text).toBe('Interested');
    expect(m.direction).toBe('inbound');
    expect(m.messageId).toBe(msg.id);
    expect(m.metadata).toMatchObject({ kind: 'template_button_reply', button: { text: 'Interested', payload: 'Interested' }, contextMessageId: 'wamid.TEMPLATE1' });
    const chat = await Chat.findById(m.chatId).lean();
    expect(chat.waId).toBe(CUSTOMER);
    expect(chat.isUnread).toBe(true);
    expect(chat.lastMessageText).toBe('Interested');
    expect(io.events.map((e) => e.event)).toContain('message:new');
    expect(bot.processIncomingMessage).toHaveBeenCalledTimes(1);
    expect(bot.processIncomingMessage.mock.calls[0][0].text).toBe('Interested');
    expect(notifications.notifyMultipleUsers).toHaveBeenCalledTimes(0); // no staff in this test DB; see next test

    // Meta retries the same webhook: no duplicate message, no second bot run.
    await webhook.processWebhook(entry([msg]));
    await only();
    expect(bot.processIncomingMessage).toHaveBeenCalledTimes(1);
  });

  test('a reply never changes the existing assignment', async () => {
    const first = base('button', { button: { payload: 'Yes', text: 'Yes' } });
    await webhook.processWebhook(entry([first]));
    const chat = await Chat.findOne({ waId: CUSTOMER });
    const staffId = new (require('mongoose').Types.ObjectId)();
    chat.assignedTo = staffId;
    await chat.save();
    await webhook.processWebhook(entry([base('button', { button: { payload: 'No', text: 'No' } })]));
    const after = await Chat.findOne({ waId: CUSTOMER }).lean();
    expect(String(after.assignedTo)).toBe(String(staffId));
    expect(await Message.countDocuments()).toBe(2);
  });
});

describe('contacts, orders, unsupported and unknown types are kept', () => {
  test('shared contact card', async () => {
    await webhook.processWebhook(entry([base('contacts', { contacts: [{ name: { formatted_name: 'Asha Sen' }, phones: [{ phone: '+91 98300 11111', wa_id: '919830011111', type: 'CELL' }] }] })]));
    const m = await only();
    expect(m.type).toBe('contacts');
    expect(m.text).toContain('Asha Sen');
    expect(m.metadata.contacts[0].phones[0].wa_id).toBe('919830011111');
  });

  test('catalog order', async () => {
    await webhook.processWebhook(entry([base('order', { order: { catalog_id: 'cat1', text: 'please pack', product_items: [{ product_retailer_id: 'R1', quantity: 2, item_price: 1500, currency: 'INR' }] } })]));
    const m = await only();
    expect(m.type).toBe('order');
    expect(m.text).toBe('🛒 Order: 2 items · INR 3000 — please pack');
    expect(m.metadata.order.product_items[0].product_retailer_id).toBe('R1');
  });

  test('unsupported (poll) and an unknown future type become readable placeholders', async () => {
    await webhook.processWebhook(entry([
      base('unsupported', { unsupported: { type: 'poll_creation' }, errors: [{ code: 131051, title: 'Message type unknown' }] }),
      base('brand_new_type', {}),
    ]));
    const all = await Message.find().sort({ createdAt: 1 }).lean();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.type)).toEqual(['unsupported', 'unsupported']);
    expect(all[0].metadata).toMatchObject({ originalType: 'poll_creation' });
    expect(all[0].text).toContain('a poll');
    expect(all[1].metadata.originalType).toBe('brand_new_type');
    expect(bot.processIncomingMessage).toHaveBeenCalledTimes(2); // existing rule: every customer message reaches the bot
  });
});

describe('location and sticker', () => {
  test('location keeps coordinates; invalid coordinates still keep the message', async () => {
    await webhook.processWebhook(entry([base('location', { location: { latitude: 22.7246, longitude: 88.4789, name: 'BJS', address: 'Barasat', url: 'https://example.com' } })]));
    let m = await only();
    expect(m.location).toMatchObject({ latitude: 22.7246, longitude: 88.4789, name: 'BJS', address: 'Barasat', url: 'https://example.com' });
    expect(m.text).toBe('📍 BJS, Barasat');
    await db.clear();
    await Waba.create({ wabaId: WABA_META, businessName: 'BJS', accessToken: 't', phoneNumbers: [{ phoneNumberId: PNID, phoneNumber: '919000000000' }] });
    await webhook.processWebhook(entry([base('location', { location: { latitude: 'abc', longitude: 200 } })]));
    m = await only();
    expect(m.location).toBeUndefined();
    expect(m.text).toContain('coordinates missing');
  });

  test('sticker media is downloaded and stored; a failed download can be retried', async () => {
    await webhook.processWebhook(entry([base('sticker', { sticker: { id: 'media-1', mime_type: 'image/webp', animated: true, sha256: 'x' } })]));
    let m = await only();
    expect(m.type).toBe('sticker');
    expect(m.mediaUrl).toBe('https://cdn.example/inbound/file.webp');
    expect(m.metadata).toMatchObject({ kind: 'sticker', animated: true });
    expect(whatsapp.downloadMedia).toHaveBeenCalledWith(expect.anything(), 'media-1');

    vps.uploadToVPS.mockImplementationOnce(async () => null); // storage failure
    await webhook.processWebhook(entry([base('sticker', { sticker: { id: 'media-2', mime_type: 'image/webp', animated: false } })]));
    m = await Message.findOne({ mediaId: 'media-2' });
    expect(m.mediaUrl).toBeFalsy();
    expect(m.metadata.mediaPending).toBe(true);

    const { retryMedia } = require('../../controllers/messages.controller');
    const res = { status: jest.fn(() => res), json: jest.fn() };
    await retryMedia({ params: { id: String(m._id) }, user: { role: 'admin', _id: 'u' } }, res, (e) => { throw e; });
    const fixed = await Message.findById(m._id).lean();
    expect(fixed.mediaUrl).toBe('https://cdn.example/inbound/file.webp');
    expect(fixed.metadata.mediaPending).toBe(false);
    expect(io.events.map((e) => e.event)).toContain('message:update');
  });
});

describe('WhatsApp system notices', () => {
  test('stored, but no bot, no notification and the chat is not marked unread', async () => {
    await webhook.processWebhook(entry([base('text', { text: { body: 'hello' } })]));
    const chat = await Chat.findOne({ waId: CUSTOMER });
    chat.isUnread = false;
    await chat.save();
    bot.processIncomingMessage.mockClear();
    await webhook.processWebhook(entry([base('system', { system: { body: 'User Rina changed from 919800000001 to 919800000002', wa_id: '919800000002', type: 'user_changed_number' } })], []));
    const sys = await Message.findOne({ type: 'system' }).lean();
    expect(sys.text).toContain('changed from');
    expect(sys.metadata).toMatchObject({ kind: 'whatsapp_system', systemType: 'user_changed_number' });
    expect(bot.processIncomingMessage).not.toHaveBeenCalled();
    expect((await Chat.findOne({ waId: CUSTOMER }).lean()).isUnread).toBe(false);
  });
});

describe('temporary failures are recorded and retried safely', () => {
  test('a database error is kept as a WebhookFailure and processed by the retry job, once', async () => {
    const spy = jest.spyOn(Message, 'create').mockImplementationOnce(async () => { const e = new Error('connection reset'); e.name = 'MongoNetworkError'; throw e; });
    const msg = base('button', { button: { payload: 'Call me', text: 'Call me' } });
    await webhook.processWebhook(entry([msg]));
    expect(await Message.countDocuments()).toBe(0);
    const f = await WebhookFailure.findOne({ messageId: msg.id }).lean();
    expect(f).toBeTruthy();
    expect(f.error).toContain('MongoNetworkError');
    expect(JSON.stringify(f.error)).not.toContain('Call me'); // no message content in the error text
    spy.mockRestore();

    await WebhookFailure.updateOne({ _id: f._id }, { nextAttemptAt: new Date(Date.now() - 1000) });
    const r = await webhook.retryFailedMessages();
    expect(r).toEqual({ checked: 1, resolved: 1 });
    expect((await only()).text).toBe('Call me');
    // running it again does nothing
    expect((await webhook.retryFailedMessages()).checked).toBe(0);
  });
});

describe('outgoing message statuses (incl. voice "played") only move forward', () => {
  async function outbound(status) {
    const chat = (await Chat.findOne({ waId: CUSTOMER })) || await Chat.create({ wabaId: (await Waba.findOne())._id, phoneNumberId: PNID, phoneNumber: CUSTOMER, waId: CUSTOMER });
    return Message.create({ chatId: chat._id, direction: 'outbound', type: 'audio', messageId: nextId(), status });
  }
  const st = (id, status) => webhook.handleStatusUpdate({ id, status, timestamp: ts(), recipient_id: CUSTOMER });

  test('read -> played is applied and broadcast to clients', async () => {
    const m = await outbound('read');
    await st(m.messageId, 'played');
    expect((await Message.findById(m._id).lean()).status).toBe('played');
    expect(io.events.find((e) => e.event === 'message:status').payload.status).toBe('played');
  });

  test('late or duplicate events never move a message backwards', async () => {
    const m = await outbound('played');
    await st(m.messageId, 'delivered');
    await st(m.messageId, 'read');
    expect((await Message.findById(m._id).lean()).status).toBe('played');
    const d = await outbound('delivered');
    await st(d.messageId, 'failed');
    expect((await Message.findById(d._id).lean()).status).toBe('delivered');
    const s = await outbound('sent');
    await st(s.messageId, 'failed');
    expect((await Message.findById(s._id).lean()).status).toBe('failed');
  });
});
