/**
 * F5: customers known only by a business-scoped user ID (BSUID / WhatsApp username), end to end through
 * the webhook with an in-memory MongoDB. Payload shapes follow Meta's BSUID webhook reference:
 * contacts[].user_id (always), contacts[].wa_id and messages[].from may be omitted, messages[].from_user_id.
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('../whatsapp.service', () => ({
  downloadMedia: jest.fn(async () => Buffer.from('x')),
  markMessageAsRead: jest.fn(async () => ({})),
  sendInteractiveMessage: jest.fn(async () => ({ messages: [{ id: 'wamid.OUT_REQ' }] })),
}));
jest.mock('../../utils/vpsUpload', () => ({ uploadToVPS: jest.fn(async () => 'https://cdn.example/x') }));
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
const { Waba, Message, Chat, Contact, User } = require('../../models');
const webhook = require('../webhook.service');
const whatsapp = require('../whatsapp.service');
const notifications = require('../notification.service');

const WABA_META = '1000000001';
const PNID = 'pn-1';
const PHONE = '919800000002';
const BSUID = 'IN.13491208655302741918';
const BSUID2 = 'IN.99991208655302749999';
const NEW_BSUID = 'IN.55551208655302745555';
let n = 0;
const ts = () => String(Math.floor(Date.now() / 1000));
const nextId = () => `wamid.BSUID${++n}`;

function entry(messages, contacts) {
  return { id: WABA_META, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts, messages } }] };
}
/** Message from a customer WhatsApp did not share the phone number of. */
function bsuidOnly(text, userId = BSUID, extra = {}) {
  return entry(
    [{ from_user_id: userId, id: nextId(), timestamp: ts(), type: 'text', text: { body: text }, ...extra }],
    [{ profile: { name: 'Mita', username: 'mita.k' }, user_id: userId }],
  );
}
function both(text, phone = PHONE, userId = BSUID) {
  return entry(
    [{ from: phone, from_user_id: userId, id: nextId(), timestamp: ts(), type: 'text', text: { body: text } }],
    [{ profile: { name: 'Mita' }, wa_id: phone, user_id: userId }],
  );
}

let waba;
beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.clear();
  jest.clearAllMocks();
  mockIo.events.length = 0;
  waba = await Waba.create({ wabaId: WABA_META, businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: PNID, phoneNumber: '919000000000' }] });
});

describe('BSUID-only customers', () => {
  test('first message creates ONE contact and chat with the BSUID; no phone number is invented', async () => {
    await webhook.processWebhook(bsuidOnly('Hello'));
    const chats = await Chat.find().lean();
    expect(chats).toHaveLength(1);
    expect(chats[0].bsuid).toBe(BSUID);
    expect(chats[0].waId).toBeUndefined();
    expect(chats[0].phoneNumber).toBeUndefined();
    const contacts = await Contact.find().lean();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ bsuid: BSUID, username: 'mita.k', name: 'Mita' });
    expect(contacts[0].phoneNumber).toBeUndefined();
    expect(contacts[0].waId).toBeUndefined();
    const m = await Message.findOne().lean();
    expect(m.bsuid).toBe(BSUID);
    expect(m.waId).toBeUndefined();
    expect(m.text).toBe('Hello');
    // The BSUID never ends up in a phone field anywhere (digits of it would look like a number).
    const digits = BSUID.replace(/\D/g, '');
    for (const doc of [...chats, ...contacts, m]) {
      expect(String(doc.phoneNumber || '')).not.toContain(digits);
      expect(String(doc.waId || '')).not.toContain(digits);
    }
  });

  test('later messages reuse the same chat; two different BSUID-only customers get separate chats', async () => {
    await webhook.processWebhook(bsuidOnly('one'));
    await webhook.processWebhook(bsuidOnly('two'));
    await webhook.processWebhook(bsuidOnly('other customer', BSUID2));
    const chats = await Chat.find().sort({ createdAt: 1 }).lean();
    expect(chats.map((c) => c.bsuid)).toEqual([BSUID, BSUID2]);
    expect(await Message.countDocuments({ chatId: chats[0]._id })).toBe(2);
    expect(await Contact.countDocuments()).toBe(2);
  });

  test('statuses carrying only recipient_user_id update the outbound message', async () => {
    await webhook.processWebhook(bsuidOnly('hi'));
    const chat = await Chat.findOne().lean();
    await Message.create({ chatId: chat._id, wabaId: chat.wabaId, messageId: 'wamid.OUT1', bsuid: BSUID, direction: 'outbound', type: 'text', text: 'Reply', status: 'sent' });
    await webhook.processWebhook({ id: WABA_META, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID }, statuses: [{ id: 'wamid.OUT1', status: 'read', timestamp: ts(), recipient_user_id: BSUID }] } }] });
    expect((await Message.findOne({ messageId: 'wamid.OUT1' }).lean()).status).toBe('read');
  });

  test('a blocked BSUID-only customer is ignored', async () => {
    await webhook.processWebhook(bsuidOnly('first'));
    await Contact.updateOne({ bsuid: BSUID }, { isBlocked: true });
    await webhook.processWebhook(bsuidOnly('second'));
    expect(await Message.countDocuments()).toBe(1);
  });

  test('notification title uses the WhatsApp name/username, never a fake number', async () => {
    await User.create({ name: 'Admin', phone: '9000000001', password: 'x'.repeat(12), role: 'admin', isActive: true });
    await webhook.processWebhook(entry(
      [{ from_user_id: BSUID, id: nextId(), timestamp: ts(), type: 'text', text: { body: 'Price?' } }],
      [{ profile: { username: 'mita.k' }, user_id: BSUID }],
    ));
    const calls = notifications.notifyMultipleUsers.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const text = JSON.stringify(calls[0]);
    expect(text).toContain('@mita.k');
    expect(text).not.toContain(BSUID.replace(/\D/g, ''));
  });
});

describe('customers with both identities', () => {
  test('existing phone chat learns the BSUID; no second chat', async () => {
    await webhook.processWebhook(entry([{ from: PHONE, id: nextId(), timestamp: ts(), type: 'text', text: { body: 'old style' } }], [{ profile: { name: 'Mita' }, wa_id: PHONE }]));
    await webhook.processWebhook(both('new style'));
    const chats = await Chat.find().lean();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ waId: PHONE, phoneNumber: PHONE, bsuid: BSUID });
    expect(await Contact.countDocuments({ mergedInto: null })).toBe(1);
  });

  test('a BSUID-only chat is folded into the phone chat once both are known (messages kept, assignment kept)', async () => {
    const staffA = new mongoose.Types.ObjectId();
    const staffB = new mongoose.Types.ObjectId();
    await webhook.processWebhook(entry([{ from: PHONE, id: nextId(), timestamp: ts(), type: 'text', text: { body: 'by phone' } }], [{ profile: { name: 'Mita' }, wa_id: PHONE }]));
    await webhook.processWebhook(bsuidOnly('by username'));
    expect(await Chat.countDocuments()).toBe(2);
    const phoneChat = await Chat.findOne({ waId: PHONE });
    const bsuidChat = await Chat.findOne({ bsuid: BSUID });
    await Chat.updateOne({ _id: phoneChat._id }, { assignedTo: staffA });
    await Chat.updateOne({ _id: bsuidChat._id }, { assignedTo: staffB });

    await webhook.processWebhook(both('now both'));

    const visible = await Chat.find({ mergedInto: null }).lean();
    expect(visible).toHaveLength(1);
    expect(String(visible[0]._id)).toBe(String(phoneChat._id));
    expect(visible[0].bsuid).toBe(BSUID);
    expect(String(visible[0].assignedTo)).toBe(String(staffA)); // assignment unchanged
    expect(await Message.countDocuments({ chatId: phoneChat._id })).toBe(3);
    const folded = await Chat.findById(bsuidChat._id).lean();
    expect(String(folded.mergedInto)).toBe(String(phoneChat._id)); // kept for audit, not deleted
    expect(await Message.countDocuments()).toBe(3); // nothing lost
  });

  test('reply to "share your phone number" adds the phone to the BSUID-only customer', async () => {
    await webhook.processWebhook(bsuidOnly('hi'));
    await webhook.processWebhook(entry(
      [{ from_user_id: BSUID, id: nextId(), timestamp: ts(), type: 'contacts', contacts: [{ origin: 'contact_request', name: { formatted_name: 'Mita' }, phones: [{ phone: '+91 98000 00002', wa_id: PHONE, type: 'CELL' }] }] }],
      [{ profile: { name: 'Mita' }, user_id: BSUID }],
    ));
    const chats = await Chat.find().lean();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ bsuid: BSUID, waId: PHONE, phoneNumber: PHONE });
    expect((await Contact.findOne({ bsuid: BSUID }).lean()).waId).toBe(PHONE);
  });

  test('a contact card the customer merely forwards is NOT taken as their own number', async () => {
    await webhook.processWebhook(bsuidOnly('hi'));
    await webhook.processWebhook(entry(
      [{ from_user_id: BSUID, id: nextId(), timestamp: ts(), type: 'contacts', contacts: [{ origin: 'other', name: { formatted_name: 'Friend' }, phones: [{ phone: '+91 98000 00099', wa_id: '919800000099' }] }] }],
      [{ profile: { name: 'Mita' }, user_id: BSUID }],
    ));
    const chat = await Chat.findOne().lean();
    expect(chat.waId).toBeUndefined();
  });
});

describe('BSUID changes', () => {
  test('system message user_changed_user_id moves the new BSUID onto the same customer', async () => {
    await webhook.processWebhook(bsuidOnly('hi'));
    await webhook.processWebhook(entry(
      [{ from_user_id: BSUID, id: nextId(), timestamp: ts(), type: 'system', system: { body: 'User A changed from IN.1 to IN.2', user_id: NEW_BSUID, type: 'user_changed_user_id' } }],
      [{ profile: { name: 'Mita' }, user_id: BSUID }],
    ));
    const chats = await Chat.find().lean();
    expect(chats).toHaveLength(1);
    expect(chats[0].bsuid).toBe(NEW_BSUID);
    const contact = await Contact.findOne().lean();
    expect(contact.bsuid).toBe(NEW_BSUID);
    expect(contact.previousBsuids).toContain(BSUID);
    // Next message under the new id lands in the same chat.
    await webhook.processWebhook(bsuidOnly('after change', NEW_BSUID));
    expect(await Chat.countDocuments()).toBe(1);
  });

  test('user_id_update webhook field updates the stored BSUID', async () => {
    await webhook.processWebhook(both('hi'));
    await webhook.processWebhook({ id: WABA_META, changes: [{ field: 'user_id_update', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, user_id_update: [{ wa_id: PHONE, user_id: { previous: BSUID, current: NEW_BSUID }, timestamp: ts() }] } }] });
    expect((await Chat.findOne().lean()).bsuid).toBe(NEW_BSUID);
    expect((await Contact.findOne().lean()).bsuid).toBe(NEW_BSUID);
  });
});

describe('request contact info endpoint', () => {
  const { requestContactInfo } = require('../../controllers/messages.controller');
  const call = async (chatId, user) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let err;
    await requestContactInfo({ params: { chatId: String(chatId) }, body: {}, user }, res, (e) => { err = e; });
    if (err) throw err;
    return res;
  };
  const admin = { _id: new mongoose.Types.ObjectId(), role: 'admin' };

  test('sends the interactive request to the BSUID (recipient), stores it in the chat', async () => {
    await webhook.processWebhook(bsuidOnly('hi'));
    const chat = await Chat.findOne();
    const res = await call(chat._id, admin);
    expect(res.code).toBe(201);
    expect(whatsapp.sendInteractiveMessage).toHaveBeenCalledWith(chat.wabaId, PNID, BSUID, expect.objectContaining({ type: 'request_contact_info', action: { name: 'request_contact_info' } }));
    expect(await Message.countDocuments({ direction: 'outbound', 'metadata.kind': 'request_contact_info' })).toBe(1);
  });

  test('refused when the phone number is already known, and for staff not assigned to the chat', async () => {
    await webhook.processWebhook(both('hi'));
    const chat = await Chat.findOne();
    expect((await call(chat._id, admin)).code).toBe(400);
    expect((await call(chat._id, { _id: new mongoose.Types.ObjectId(), role: 'staff' })).code).toBe(403);
    expect(whatsapp.sendInteractiveMessage).not.toHaveBeenCalled();
  });
});
