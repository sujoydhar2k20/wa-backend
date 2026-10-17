/**
 * Numbers typed or imported without the country code ("9874085669") must reach the same customer,
 * contact and chat as WhatsApp's full number ("919874085669").
 * Unit tests for the rules + integration tests (in-memory MongoDB) for broadcast sending,
 * list / contact import and "start chat with phone".
 */
jest.setTimeout(90000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('../../jobs/agenda', () => ({ getAgenda: () => null }));
jest.mock('../whatsapp.service', () => ({
  sendTemplateMessage: jest.fn(async (_w, _p, to) => ({ messages: [{ id: `wamid.OUT.${to}.${Math.random()}` }] })),
  getTemplateHeaderImageUrl: jest.fn(async () => null),
  withHostedHeaderImage: jest.fn((c) => c),
  resolveMessagingLimit: jest.fn(() => 100000),
}));

const mongoose = require('mongoose');
const {
  Waba, Chat, Contact, User, Template, Broadcast, BroadcastBatch, BroadcastMessage, BroadcastList, BroadcastListMember, Message,
} = require('../../models');
const whatsapp = require('../whatsapp.service');
const { normalizePhone, phoneVariants } = require('../../utils/waIdentity');

const FULL = '919874085669';
const NATIONAL = '9874085669';

describe('normalizePhone / phoneVariants (pure)', () => {
  test.each([
    ['9874085669', '919874085669'],
    ['09874085669', '919874085669'],
    ['+91 98740 85669', '919874085669'],
    ['91-9874085669', '919874085669'],
    ['0091 98740 85669', '919874085669'],
    ['919874085669', '919874085669'],
    ['6291234567', '916291234567'],
  ])('%s -> %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  test.each([
    ['03322334455', '03322334455'],          // Kolkata landline with STD 0: not a mobile, unchanged
    ['14155550123', '14155550123'],          // already international (US)
    ['447911123456', '447911123456'],        // UK
    ['5874085669', '5874085669'],            // 10 digits but not an Indian mobile: unchanged
    ['12345', '12345'],
  ])('%s stays %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  test('BSUIDs, empty and odd values', () => {
    expect(normalizePhone('US.13491208655302741918')).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone(9874085669)).toBe(FULL); // numbers from spreadsheets / JSON
  });

  test('another default country (DEFAULT_COUNTRY_CODE) is applied to bare 10-digit numbers', () => {
    expect(normalizePhone('4155550123', '1')).toBe('14155550123');
    expect(normalizePhone('14155550123', '1')).toBe('14155550123');
  });

  test('variants cover both stored forms', () => {
    expect(phoneVariants(NATIONAL).sort()).toEqual([FULL, NATIONAL].sort());
    expect(phoneVariants(FULL).sort()).toEqual([FULL, NATIONAL].sort());
    expect(phoneVariants('14155550123')).toEqual(['14155550123']);
    expect(phoneVariants(undefined)).toEqual([]);
  });
});

describe('with a database', () => {
  let waba; let template; let staff; let creator;

  beforeAll(async () => { await db.start(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => {
    await db.clear();
    jest.clearAllMocks();
    waba = await Waba.create({ wabaId: 'W-PN', businessName: 'BJS', accessToken: 't', phoneNumbers: [{ phoneNumberId: 'pn1', phoneNumber: '919000000000', messagingLimitTier: 'UNLIMITED', messagingLimit: 1e9 }] });
    template = await Template.create({ wabaId: waba._id, name: 'offer', language: 'en', components: [{ type: 'BODY', text: 'Diwali offer' }] });
    staff = await User.create({ phone: '1111111111', name: 'Rina', role: 'staff', assignedWabaId: waba._id });
    creator = await User.create({ phone: '2222222222', name: 'Admin', role: 'admin' });
  });

  async function runBroadcast({ listPhones = [], tagIds = [] } = {}) {
    let list = null;
    if (listPhones.length) {
      list = await BroadcastList.create({ name: 'L', wabaId: waba._id });
      for (const p of listPhones) {
        const c = await Contact.findOne({ phoneNumber: p });
        await BroadcastListMember.create({ broadcastListId: list._id, phoneNumber: p, contactId: c?._id });
      }
    }
    const b = await Broadcast.create({ name: 'Diwali', wabaId: waba._id, phoneNumberId: 'pn1', templateId: template._id, createdBy: creator._id, broadcastListId: list?._id, tagIds });
    const ctrl = require('../../controllers/broadcasts.controller');
    const res = { body: null, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { this.body = j; return this; } };
    let error = null;
    await ctrl.send({ params: { id: b._id }, body: {}, user: creator }, res, (e) => { error = e; });
    if (error) throw error;
    // the controller processes batch 1 on setImmediate; run any pending batch deterministically
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50; i++) {
      const pending = await BroadcastBatch.countDocuments({ broadcastId: b._id, status: { $in: ['pending', 'sending'] } });
      if (!pending) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { broadcast: b, res, list };
  }

  test('a list holding the bare number reaches the customer\'s EXISTING chat; its staff assignment is kept', async () => {
    const real = await Contact.create({ phoneNumber: FULL, waId: FULL, name: 'Real' });
    const chat = await Chat.create({ wabaId: waba._id, phoneNumberId: 'pn1', waId: FULL, phoneNumber: FULL, contactId: real._id, assignedTo: staff._id });
    await Contact.create({ phoneNumber: NATIONAL, waId: NATIONAL, name: 'Old import' }); // duplicate from an old CSV

    const { broadcast, res } = await runBroadcast({ listPhones: [NATIONAL] });
    expect(res.body.total).toBe(1);

    expect(whatsapp.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendTemplateMessage.mock.calls[0][2]).toBe(FULL); // sent to the full number
    expect(await Chat.countDocuments({})).toBe(1);                       // no second chat
    const after = await Chat.findById(chat._id).lean();
    expect(String(after.assignedTo)).toBe(String(staff._id));
    expect(await Message.countDocuments({ chatId: chat._id, direction: 'outbound' })).toBe(1); // history in the real chat
    const bm = await BroadcastMessage.findOne({ broadcastId: broadcast._id }).lean();
    expect(bm).toMatchObject({ phoneNumber: FULL, status: 'sent' });
    expect((await BroadcastListMember.findOne({ phoneNumber: NATIONAL }).lean()).status).toBe('sent');
  });

  test('the same customer stored both ways in a list gets ONE message', async () => {
    await Contact.create({ phoneNumber: FULL, waId: FULL });
    await Contact.create({ phoneNumber: NATIONAL, waId: NATIONAL });
    await Contact.create({ phoneNumber: '919830011111', waId: '919830011111' });
    const { res } = await runBroadcast({ listPhones: [NATIONAL, FULL, '919830011111'] });
    expect(res.body.total).toBe(2);
    expect(whatsapp.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(whatsapp.sendTemplateMessage.mock.calls.map((c) => c[2]).sort()).toEqual([FULL, '919830011111'].sort());
  });

  test('tag broadcast: block/opt-out of the REAL (full-number) contact wins over an unblocked duplicate', async () => {
    const tagId = new mongoose.Types.ObjectId();
    await Contact.create({ phoneNumber: FULL, waId: FULL, isBlocked: true });             // real customer, blocked
    await Contact.create({ phoneNumber: NATIONAL, waId: NATIONAL, tags: [tagId] });      // tagged old duplicate
    await runBroadcast({ tagIds: [tagId] });
    expect(whatsapp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(await BroadcastMessage.findOne({}).lean()).toMatchObject({ phoneNumber: FULL, status: 'skipped' });
  });

  test('contacts without any phone (WhatsApp user ID only) are skipped instead of failing', async () => {
    const tagId = new mongoose.Types.ObjectId();
    await Contact.create({ bsuid: 'IN.1234567890', tags: [tagId] });
    await Contact.create({ phoneNumber: FULL, waId: FULL, tags: [tagId] });
    const { res } = await runBroadcast({ tagIds: [tagId] });
    expect(res.body.total).toBe(1);
    expect(await BroadcastMessage.countDocuments({ status: 'failed' })).toBe(0);
  });

  test('adding list members by hand stores the full number and links the existing customer', async () => {
    const real = await Contact.create({ phoneNumber: FULL, waId: FULL, name: 'Real' });
    const list = await BroadcastList.create({ name: 'L', wabaId: waba._id });
    const ctrl = require('../../controllers/broadcastLists.controller');
    const res = { json(j) { this.body = j; return this; }, status() { return this; } };
    await ctrl.addMembers({ params: { id: list._id }, body: { members: [{ name: 'Real', phoneNumber: '098740 85669' }, { phoneNumber: '+91 98300 11111' }] } }, res, (e) => { throw e; });
    const members = await BroadcastListMember.find({ broadcastListId: list._id }).lean();
    expect(members.map((m) => m.phoneNumber).sort()).toEqual(['919830011111', FULL].sort());
    expect(String(members.find((m) => m.phoneNumber === FULL).contactId)).toBe(String(real._id));
    expect(await Contact.countDocuments({ phoneNumber: NATIONAL })).toBe(0); // no duplicate contact
  });

  test('CSV list import stores full numbers', async () => {
    const list = await BroadcastList.create({ name: 'L', wabaId: waba._id });
    const ctrl = require('../../controllers/broadcastLists.controller');
    const res = { json(j) { this.body = j; return this; }, status() { return this; } };
    const csv = 'phone,name\n9874085669,Asha\n+91 98300 11111,Bina\n919874085669,Asha again\n';
    await ctrl.importMembers({ params: { id: list._id }, body: { phoneColumn: '0', nameColumn: '1' }, file: { buffer: Buffer.from(csv) } }, res, (e) => { throw e; });
    const phones = (await BroadcastListMember.find({ broadcastListId: list._id }).lean()).map((m) => m.phoneNumber).sort();
    expect(phones).toEqual(['919830011111', FULL].sort()); // the two forms of one number are one member
  });

  test('"Import existing contacts" adds every contact with the country code, one member per customer', async () => {
    const real = await Contact.create({ phoneNumber: FULL, waId: FULL, name: 'Real' });
    await Contact.create({ phoneNumber: NATIONAL, waId: NATIONAL, name: 'Old import' });   // same customer, bare number
    await Contact.create({ phoneNumber: '9830011111', name: 'Bare only' });                 // only a bare number
    await Contact.create({ phoneNumber: '14155550123', name: 'US' });                        // foreign, unchanged
    await Contact.create({ waId: '919812312345', name: 'waId only' });                       // no phoneNumber field
    await Contact.create({ bsuid: 'IN.999', name: 'User ID only' });                          // no phone at all
    const list = await BroadcastList.create({ name: 'L', wabaId: waba._id });
    const ctrl = require('../../controllers/broadcastLists.controller');
    const res = { json(j) { this.body = j; return this; }, status() { return this; } };
    await ctrl.importCustomers({ params: { id: list._id } }, res, (e) => { throw e; });

    const members = await BroadcastListMember.find({ broadcastListId: list._id }).lean();
    expect(members.map((m) => m.phoneNumber).sort()).toEqual(['14155550123', '919812312345', '919830011111', FULL].sort());
    expect(String(members.find((m) => m.phoneNumber === FULL).contactId)).toBe(String(real._id)); // linked to the real contact
    expect(res.body).toMatchObject({ total: 6, imported: 4, duplicates: 1, failed: 1, memberCount: 4 });

    // Running it again adds nothing; a member that an older import stored as a bare number also counts.
    await BroadcastListMember.create({ broadcastListId: list._id, phoneNumber: '9877700000' });
    await Contact.create({ phoneNumber: '919877700000' });
    await ctrl.importCustomers({ params: { id: list._id } }, res, (e) => { throw e; });
    expect(res.body.imported).toBe(0);
    expect(await BroadcastListMember.countDocuments({ broadcastListId: list._id })).toBe(5);
  });

  test('contacts CSV import stores full numbers', async () => {
    const ctrl = require('../../controllers/contacts.controller');
    const res = { json(j) { this.body = j; return this; }, status() { return this; } };
    let err = null;
    await ctrl.import({ file: { buffer: Buffer.from('phone,name\n9874085669,Asha\n') }, user: creator, body: {} }, res, (e) => { err = e; });
    expect(err).toBeNull();
    expect(await Contact.exists({ phoneNumber: FULL })).toBeTruthy();
    expect(await Contact.exists({ phoneNumber: NATIONAL })).toBeFalsy();
  });

  test('"start chat with phone" with a bare number opens the customer\'s existing chat', async () => {
    const real = await Contact.create({ phoneNumber: FULL, waId: FULL });
    const chat = await Chat.create({ wabaId: waba._id, phoneNumberId: 'pn1', waId: FULL, phoneNumber: FULL, contactId: real._id, assignedTo: staff._id });
    const ctrl = require('../../controllers/chats.controller');
    const res = { json(j) { this.body = j; return this; }, status(c) { this.statusCode = c; return this; } };
    await ctrl.startWithPhone({ body: { phoneNumber: NATIONAL, wabaId: String(waba._id) }, user: creator }, res, (e) => { throw e; });
    expect(await Chat.countDocuments({})).toBe(1);
    expect(JSON.stringify(res.body)).toContain(String(chat._id));
  });
});
