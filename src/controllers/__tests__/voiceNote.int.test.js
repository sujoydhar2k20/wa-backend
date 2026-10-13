/**
 * F7 voice notes: a staff-recorded voice note is sent to WhatsApp as an OGG/OPUS file with
 * `audio.voice: true`; an ordinary audio attachment is not. Real ffmpeg, in-memory MongoDB, mocked Meta.
 */
jest.setTimeout(90000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const db = require('../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));
jest.mock('axios');
const axios = require('axios');

const { Waba, Contact, Chat, Message } = require('../../models');
const messages = require('../messages.controller');

let recording; // what an Android/web recorder produces (AAC in M4A here)
let uploads;
let sends;

function makeRecording(seconds) {
  const out = path.join(os.tmpdir(), `voice_test_${process.pid}_${seconds}.m4a`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', '-b:a', '96k', out]);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  return buf;
}

async function readForm(form) {
  // form-data stream -> Buffer, to inspect what was uploaded to Meta
  return new Promise((resolve, reject) => {
    const chunks = [];
    form.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    form.on('end', () => resolve(Buffer.concat(chunks)));
    form.on('error', reject);
    form.resume();
  });
}

beforeAll(async () => {
  await db.start();
  recording = makeRecording(5);
});
afterAll(async () => { await db.stop(); });

let chat;
beforeEach(async () => {
  await db.clear();
  uploads = [];
  sends = [];
  axios.mockReset();
  axios.get = jest.fn(async () => ({ data: recording, headers: { 'content-type': 'audio/mp4' } }));
  axios.post = jest.fn(async (_url, form, opts) => {
    const raw = await readForm(form);
    uploads.push({ raw, contentType: /Content-Type: (\S+)/.exec(raw.toString('latin1'))?.[1], headers: opts.headers });
    return { data: { id: `MEDIA${uploads.length}` } };
  });
  axios.mockImplementation(async (opts) => {
    sends.push(opts.data);
    return { data: { messages: [{ id: `wamid.OUT${sends.length}` }] } };
  });
  const waba = await Waba.create({ wabaId: 'W1', businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: 'pn-1', phoneNumber: '919000000000' }] });
  const contact = await Contact.create({ phoneNumber: '919800000001', waId: '919800000001', name: 'Rina' });
  chat = await Chat.create({ wabaId: waba._id, phoneNumberId: 'pn-1', phoneNumber: '919800000001', waId: '919800000001', contactId: contact._id, sessionExpiresAt: new Date(Date.now() + 3600e3) });
});

async function send(body) {
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let error;
  await messages.send({ body: { chatId: String(chat._id), ...body }, user: { _id: chat._id } }, res, (e) => { error = e; });
  if (error) throw error;
  return res;
}

describe('voice notes (F7)', () => {
  test('recorded voice note -> OGG/OPUS upload, audio.voice:true, under 512 KB, recorded as voice', async () => {
    const res = await send({ type: 'audio', mediaUrl: 'https://cdn.example/rec.m4a', voice: true });
    expect(res.statusCode).toBe(201);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe('audio/ogg');
    const raw = uploads[0].raw;
    expect(raw.includes(Buffer.from('OggS'))).toBe(true);
    expect(raw.includes(Buffer.from('OpusHead'))).toBe(true);
    expect(raw.length).toBeLessThan(messages.VOICE_PLAY_ICON_MAX_BYTES);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ messaging_product: 'whatsapp', to: '919800000001', type: 'audio', audio: { id: 'MEDIA1', voice: true } });
    expect(sends[0].audio.caption).toBeUndefined();
    const m = await Message.findOne({ messageId: 'wamid.OUT1' }).lean();
    expect(m.type).toBe('audio');
    expect(m.metadata.voice).toBe(true);
    expect(m.mediaUrl).toBe('https://cdn.example/rec.m4a'); // staff playback keeps the original
  });

  test('picked audio file stays an ordinary audio attachment (no voice flag, AAC/M4A)', async () => {
    const res = await send({ type: 'audio', mediaUrl: 'https://cdn.example/song.m4a' });
    expect(res.statusCode).toBe(201);
    expect(uploads[0].contentType).toBe('audio/mp4');
    expect(sends[0].audio).toEqual({ id: 'MEDIA1' });
    const m = await Message.findOne({ messageId: 'wamid.OUT1' }).lean();
    expect(m.metadata.voice).toBe(false);
  });

  test('voice flag is ignored for non-audio types', async () => {
    axios.get = jest.fn(async () => ({ data: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json')), headers: { 'content-type': 'application/pdf' } }));
    await send({ type: 'document', mediaUrl: 'https://cdn.example/a.pdf', voice: true });
    expect(sends[0].type).toBe('document');
    expect(sends[0].document.voice).toBeUndefined();
  });

  test('long recording is re-encoded at a lower bitrate to stay under the 512 KB play-icon limit', async () => {
    const long = makeRecording(150);
    const { buffer, oversize } = await messages.convertVoiceNoteForMeta(long);
    expect(buffer.slice(0, 4).toString()).toBe('OggS');
    expect(buffer.length).toBeLessThanOrEqual(messages.VOICE_PLAY_ICON_MAX_BYTES);
    expect(oversize).toBe(false);
  });

  test('unconvertible input is an error, never a fake success', async () => {
    await expect(messages.convertVoiceNoteForMeta(Buffer.from('not audio at all'))).rejects.toThrow();
  });

  test('retry of a failed voice note is re-sent as a voice note', async () => {
    const failed = await Message.create({ chatId: chat._id, direction: 'outbound', type: 'audio', mediaUrl: 'https://cdn.example/rec.m4a', status: 'failed', metadata: { voice: true } });
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let err;
    await messages.retry({ params: { id: String(failed._id) }, user: { _id: chat._id } }, res, (e) => { err = e; });
    expect(err).toBeUndefined();
    expect(uploads[0].contentType).toBe('audio/ogg');
    expect(sends[0].audio).toEqual({ id: 'MEDIA1', voice: true });
  });
});
