/**
 * F3 ad referral tracking and F8 local + WhatsApp blocking, with an in-memory MongoDB and a mocked Meta.
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('../whatsapp.service', () => ({
  downloadMedia: jest.fn(async () => Buffer.from('x')),
  markMessageAsRead: jest.fn(async () => ({})),
  setUserBlocked: jest.fn(async () => ({ ok: true })),
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
const { Waba, Message, Chat, Contact, BlockAudit, ChatActivity } = require('../../models');
const webhook = require('../webhook.service');
const whatsapp = require('../whatsapp.service');
const { parseReferral } = require('../inboundMessage');
const { report } = require('../../controllers/referrals.controller');
const chatsController = require('../../controllers/chats.controller');
const { blockChat, blockStatus } = require('../../controllers/block.controller');
const contactsController = require('../../controllers/contacts.controller');

const WABA_META = '1000000001';
const PNID = 'pn-1';
const PHONE = '919800000003';
let n = 0;
const ts = (offsetSec = 0) => String(Math.floor(Date.now() / 1000) + offsetSec);
const nextId = () => `wamid.REF${++n}`;
const AD1 = { source_url: 'https://fb.me/ad1', source_id: '120000000001', source_type: 'ad', body: 'Gold offer', headline: 'Diwali gold', media_type: 'image', image_url: 'https://scontent.example/a.jpg', ctwa_clid: 'ARAkLk', welcome_message: { text: 'Hi! How can we help?' } };
const AD2 = { source_url: 'https://fb.me/ad2', source_id: '120000000002', source_type: 'ad', headline: 'Silver sale' };

function text(body, referral, phone = PHONE, offset = 0) {
  return { id: WABA_META, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID }, contacts: [{ profile: { name: 'Asha' }, wa_id: phone }], messages: [{ from: phone, id: nextId(), timestamp: ts(offset), type: 'text', text: { body }, ...(referral ? { referral } : {}) }] } }] };
}
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
async function call(fn, req) { const r = res(); let err; await fn(req, r, (e) => { err = e; }); if (err) throw err; return r; }
const admin = { _id: new mongoose.Types.ObjectId(), role: 'admin' };

beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.clear();
  jest.clearAllMocks();
  whatsapp.setUserBlocked.mockImplementation(async () => ({ ok: true }));
  await Waba.create({ wabaId: WABA_META, businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: PNID, phoneNumber: '919000000000' }] });
});

describe('ad referral tracking', () => {
  test('parser keeps documented fields, drops non-http URLs, ignores empty referrals', () => {
    expect(parseReferral(AD1)).toEqual({ sourceType: 'ad', sourceId: '120000000001', sourceUrl: 'https://fb.me/ad1', headline: 'Diwali gold', body: 'Gold offer', mediaType: 'image', imageUrl: 'https://scontent.example/a.jpg', ctwaClid: 'ARAkLk', welcomeMessage: 'Hi! How can we help?' });
    expect(parseReferral({ source_id: '1', source_url: 'javascript:alert(1)' }).sourceUrl).toBeUndefined();
    expect(parseReferral({})).toBeNull();
    expect(parseReferral(undefined)).toBeNull();
  });

  test('first referral is kept, later referrals update last + count, each message keeps its own', async () => {
    await webhook.processWebhook(text('Hi from ad 1', AD1));
    await webhook.processWebhook(text('plain message'));
    await webhook.processWebhook(text('Hi from ad 2', AD2, PHONE, 5));
    const chat = await Chat.findOne().lean();
    expect(chat.firstReferral).toMatchObject({ sourceId: AD1.source_id, headline: 'Diwali gold', ctwaClid: 'ARAkLk' });
    expect(chat.lastReferral).toMatchObject({ sourceId: AD2.source_id, headline: 'Silver sale' });
    expect(chat.referralCount).toBe(2);
    const msgs = await Message.find().sort({ timestamp: 1 }).lean();
    expect(msgs.map((m) => m.metadata?.referral?.sourceId)).toEqual([AD1.source_id, undefined, AD2.source_id]);
    expect(msgs[0].text).toBe('Hi from ad 1');
  });

  test('report counts clicks, chats and new chats per ad; admins only route; list filter', async () => {
    await webhook.processWebhook(text('a', AD1));
    await webhook.processWebhook(text('b', AD1, '919800000004'));
    await webhook.processWebhook(text('c', AD2, '919800000004', 5));
    await webhook.processWebhook(text('no ad', null, '919800000005'));
    const r = await call(report, { query: {} });
    const byId = Object.fromEntries(r.body.rows.map((x) => [x.sourceId, x]));
    expect(byId[AD1.source_id]).toMatchObject({ clicks: 2, chats: 2, newChats: 2, headline: 'Diwali gold' });
    expect(byId[AD2.source_id]).toMatchObject({ clicks: 1, chats: 1, newChats: 0 });
    expect(r.body.totals).toMatchObject({ clicks: 3, newChats: 2, sources: 2 });

    const all = await call(chatsController.list, { query: { source: 'ad' }, user: admin });
    expect(all.body.total).toBe(2);
    const one = await call(chatsController.list, { query: { adId: AD2.source_id }, user: admin });
    expect(one.body.total).toBe(1);
  });

  test('report rejects a bad date range', async () => {
    await expect(call(report, { query: { from: 'nope' } })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('blocking (local + WhatsApp)', () => {
  async function chatFor(phone = PHONE) {
    await webhook.processWebhook(text('hello', null, phone));
    return Chat.findOne({ waId: phone });
  }

  test('blocks locally and on WhatsApp, audits it, and inbound messages are ignored afterwards', async () => {
    const chat = await chatFor();
    const r = await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: admin });
    expect(r.body).toMatchObject({ success: true, blocked: true, local: 'applied', remote: { status: 'blocked', action: 'block' } });
    expect(whatsapp.setUserBlocked).toHaveBeenCalledWith(chat.wabaId, PNID, PHONE, true);
    const contact = await Contact.findOne({ waId: PHONE }).lean();
    expect(contact.isBlocked).toBe(true);
    expect(contact.remoteBlock.status).toBe('blocked');
    const audit = await BlockAudit.find().lean();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'block', local: 'applied', remote: 'blocked', role: 'admin', identity: 'phone …0003' });
    expect(await ChatActivity.countDocuments({ type: 'blocked' })).toBe(1);

    await webhook.processWebhook(text('after block'));
    expect(await Message.countDocuments({ text: 'after block' })).toBe(0);
  });

  test('WhatsApp refusal is reported, never faked; local block still applies', async () => {
    whatsapp.setUserBlocked.mockResolvedValue({ ok: false, code: 131047, message: 'WhatsApp only allows blocking customers who messaged in the last 24 hours.' });
    const chat = await chatFor();
    const r = await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: admin });
    expect(r.body.remote).toMatchObject({ status: 'failed', errorCode: 131047 });
    expect(r.body.message).toMatch(/BJS Connect only/);
    expect((await Contact.findOne({ waId: PHONE }).lean()).isBlocked).toBe(true);
    expect((await BlockAudit.findOne().lean()).remote).toBe('failed');
  });

  test('Meta unreachable: local block works', async () => {
    whatsapp.setUserBlocked.mockResolvedValue({ ok: false, code: 'NETWORK', message: 'connect ETIMEDOUT' });
    const chat = await chatFor();
    const r = await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: admin });
    expect(r.body.local).toBe('applied');
    expect(r.body.remote.status).toBe('failed');
    expect(r.body.remote.errorCode).toBeUndefined();
  });

  test('unblock and status endpoint', async () => {
    const chat = await chatFor();
    await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: admin });
    const r = await call(blockChat, { params: { id: String(chat._id) }, body: { blocked: false }, user: admin });
    expect(r.body.remote.status).toBe('unblocked');
    expect(whatsapp.setUserBlocked).toHaveBeenLastCalledWith(chat.wabaId, PNID, PHONE, false);
    const st = await call(blockStatus, { params: { id: String(chat._id) }, user: admin });
    expect(st.body.isBlocked).toBe(false);
    expect(st.body.history.map((h) => h.action)).toEqual(['unblock', 'block']);
  });

  test('permissions: unassigned staff refused (chat and contacts endpoints); assigned staff allowed', async () => {
    const chat = await chatFor();
    const staff = { _id: new mongoose.Types.ObjectId(), role: 'staff' };
    expect((await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: staff })).code).toBe(403);
    expect((await call(contactsController.block, { params: { id: String(chat.contactId) }, body: {}, user: staff })).code).toBe(403);
    expect(whatsapp.setUserBlocked).not.toHaveBeenCalled();
    expect(await BlockAudit.countDocuments()).toBe(0);
    await Chat.updateOne({ _id: chat._id }, { assignedTo: staff._id });
    expect((await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: staff })).body.remote.status).toBe('blocked');
  });

  test('contacts endpoint keeps returning the contact (older clients) plus the result', async () => {
    const chat = await chatFor();
    const r = await call(contactsController.block, { params: { id: String(chat.contactId) }, body: { blocked: true }, user: admin });
    expect(r.body.isBlocked).toBe(true);
    expect(r.body.blockResult.remote.status).toBe('blocked');
  });

  test('BSUID-only customer is blocked by user id', async () => {
    const BSUID = 'IN.13491208655302741918';
    await webhook.processWebhook({ id: WABA_META, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID }, contacts: [{ profile: { name: 'M' }, user_id: BSUID }], messages: [{ from_user_id: BSUID, id: nextId(), timestamp: ts(), type: 'text', text: { body: 'hi' } }] } }] });
    const chat = await Chat.findOne({ bsuid: BSUID });
    await call(blockChat, { params: { id: String(chat._id) }, body: {}, user: admin });
    expect(whatsapp.setUserBlocked).toHaveBeenCalledWith(chat.wabaId, PNID, BSUID, true);
    expect((await Contact.findOne({ bsuid: BSUID }).lean()).isBlocked).toBe(true);
  });
});
