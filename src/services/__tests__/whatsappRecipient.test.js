/**
 * Outbound addressing: phone numbers go in `to`, business-scoped user IDs in `recipient` (never both,
 * never a BSUID stripped to digits). Meta error 131062 is explained to staff.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

jest.mock('axios', () => jest.fn());
jest.mock('../../models/Waba', () => ({ findById: jest.fn(async () => ({ accessToken: 'tok' })) }));
jest.mock('../../models/Template', () => ({}));
const mockContactFindOne = jest.fn();
jest.mock('../../models/Contact', () => ({ findOne: (...a) => ({ select: () => ({ lean: async () => mockContactFindOne(...a) }) }) }));

const axios = require('axios');
const wa = require('../whatsapp.service');
const { recipientFields, addressOf, isBsuid, phoneDigits, displayIdentity } = require('../../utils/waIdentity');

const BSUID = 'US.13491208655302741918';

beforeEach(() => {
  axios.mockReset();
  axios.mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } });
  mockContactFindOne.mockReset();
  mockContactFindOne.mockResolvedValue(null);
});

describe('identity helpers', () => {
  test('BSUID detection and phone digits', () => {
    expect(isBsuid(BSUID)).toBe(true);
    expect(isBsuid('US.ENT.11815799212886844830')).toBe(true);
    expect(isBsuid('919800000001')).toBe(false);
    expect(phoneDigits(BSUID)).toBe(''); // never turned into a phone number
    expect(phoneDigits('+91 98000 00001')).toBe('919800000001');
  });
  test('recipientFields', () => {
    expect(recipientFields(BSUID)).toEqual({ recipient: BSUID });
    expect(recipientFields('+91 98000 00001')).toEqual({ to: '919800000001' });
    expect(() => recipientFields('')).toThrow(/no phone number or WhatsApp user ID/);
  });
  test('addressOf prefers the phone, falls back to the BSUID', () => {
    expect(addressOf({ waId: '919800000001', bsuid: BSUID })).toBe('919800000001');
    expect(addressOf({ bsuid: BSUID })).toBe(BSUID);
    expect(addressOf({})).toBe('');
  });
  test('displayIdentity', () => {
    expect(displayIdentity({ waId: '919800000001' })).toBe('+919800000001');
    expect(displayIdentity({ username: 'mita.k', bsuid: BSUID })).toBe('@mita.k');
    expect(displayIdentity({ bsuid: BSUID })).toBe('WhatsApp user 741918');
  });
});

describe('send requests', () => {
  test('text to a BSUID uses recipient and no to', async () => {
    await wa.sendTextMessage('w1', 'pn1', BSUID, 'Hello');
    const body = axios.mock.calls[0][0].data;
    expect(body.recipient).toBe(BSUID);
    expect(body.to).toBeUndefined();
    expect(body.recipient_type).toBe('individual');
  });
  test('text to a phone uses to and no recipient', async () => {
    await wa.sendTextMessage('w1', 'pn1', '919800000001', 'Hello');
    const body = axios.mock.calls[0][0].data;
    expect(body.to).toBe('919800000001');
    expect(body.recipient).toBeUndefined();
  });
  test('voice note to a BSUID', async () => {
    await wa.sendMediaMessage('w1', 'pn1', BSUID, 'audio', 'MEDIA1', '', null, { voice: true });
    expect(axios.mock.calls[0][0].data).toMatchObject({ recipient: BSUID, type: 'audio', audio: { id: 'MEDIA1', voice: true } });
  });
  test('blocked BSUID contact: nothing is sent', async () => {
    mockContactFindOne.mockResolvedValue({ isBlocked: true });
    await expect(wa.sendTextMessage('w1', 'pn1', BSUID, 'Hello')).rejects.toThrow(/blocked/);
    expect(mockContactFindOne).toHaveBeenCalledWith({ bsuid: BSUID });
    expect(axios).not.toHaveBeenCalled();
  });
  test('Meta 131062 gets a clear message', async () => {
    axios.mockRejectedValue({ response: { status: 400, data: { error: { code: 131062, message: 'Business-scoped User ID (BSUID) recipient not supported' } } } });
    await expect(wa.sendTextMessage('w1', 'pn1', BSUID, 'x')).rejects.toMatchObject({ statusCode: 400, metaCode: 131062, message: expect.stringMatching(/share their phone number/) });
  });
});

describe('Meta Block Users API', () => {
  test('block by phone: POST with user "+digits"; ok only when Meta lists it as added', async () => {
    axios.mockResolvedValue({ data: { messaging_product: 'whatsapp', block_users: { added_users: [{ input: '+919800000001', wa_id: '919800000001' }] } } });
    await expect(wa.setUserBlocked('w1', 'pn1', '919800000001', true)).resolves.toEqual({ ok: true });
    expect(axios.mock.calls[0][0]).toMatchObject({ method: 'POST', url: expect.stringMatching(/\/pn1\/block_users$/), data: { messaging_product: 'whatsapp', block_users: [{ user: '+919800000001' }] } });
  });
  test('unblock by BSUID: DELETE with user_id', async () => {
    axios.mockResolvedValue({ data: { block_users: { removed_users: [{ input: BSUID }] } } });
    await expect(wa.setUserBlocked('w1', 'pn1', BSUID, false)).resolves.toEqual({ ok: true });
    expect(axios.mock.calls[0][0]).toMatchObject({ method: 'DELETE', data: { block_users: [{ user_id: BSUID }] } });
  });
  test('parent BSUID refused without calling Meta', async () => {
    await expect(wa.setUserBlocked('w1', 'pn1', 'US.ENT.11815799212886844830', true)).resolves.toMatchObject({ ok: false, code: 'PARENT_ID' });
    expect(axios).not.toHaveBeenCalled();
  });
  test('failed_users (131047) reported, not success', async () => {
    axios.mockRejectedValue({ response: { status: 400, data: { block_users: { failed_users: [{ input: '+919800000001', errors: [{ code: 131047, message: 'Re-engagement message', error_data: { details: 'x' } }] }] }, error: { code: 139100, message: 'Failed to block/unblock users' } } } });
    await expect(wa.setUserBlocked('w1', 'pn1', '919800000001', true)).resolves.toMatchObject({ ok: false, code: 131047, message: expect.stringMatching(/24 hours/) });
  });
  test('network failure reported', async () => {
    axios.mockRejectedValue(new Error('connect ETIMEDOUT'));
    await expect(wa.setUserBlocked('w1', 'pn1', '919800000001', true)).resolves.toMatchObject({ ok: false, code: 'NETWORK' });
  });
  test('200 without added_users is NOT success', async () => {
    axios.mockResolvedValue({ data: { block_users: { added_users: [] } } });
    await expect(wa.setUserBlocked('w1', 'pn1', '919800000001', true)).resolves.toMatchObject({ ok: false, code: 'UNCONFIRMED' });
  });
});
