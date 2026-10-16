/**
 * Many media files at once through the real worker code: the shared limit (default 5) holds across the
 * background job, the retry job, inline sends and bulk sends; failures and duplicate job runs are safe;
 * several chats do not interfere. In-memory MongoDB, real sharp/ffmpeg, mocked Meta (axios).
 */
jest.setTimeout(170000);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-conc-'));
process.env.VPS_UPLOAD_DIR = root;
process.env.VPS_UPLOAD_URL = 'https://upload.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
delete process.env.MEDIA_MAX_CONCURRENT;
delete process.env.MEDIA_JOB_CONCURRENCY;

const db = require('../../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../../websocket/socket.server', () => ({ getIO: () => mockIo }));
const mockAgenda = {
  later: [],
  create(name, data) {
    const job = { attrs: { name, data }, unique() { return job; }, schedule() { return job; }, async save() { return job; } };
    return job;
  },
  async schedule(when, name, data) { mockAgenda.later.push({ when, name, data }); },
};
jest.mock('../../../jobs/agenda', () => ({ getAgenda: () => mockAgenda }));
jest.mock('axios');
const axios = require('axios');

const { Waba, Contact, Chat, Message } = require('../../../models');
const messages = require('../../../controllers/messages.controller');
const svc = require('../mediaMessageService');
const pipe = require('../mediaPipeline');
const { CONCURRENCY } = require('../limits');

let sends;
let failUploadFor; // file names whose upload must fail
let uploadDelayMs;
let inflightUploads;
let maxInflightUploads;
let inflightTasks;
let maxInflightTasks;
let maxSlotsHeld; // most media task slots held at the same moment (the real concurrency)
let chatA;
let chatB;
const handlers = {};
const defs = {};

function readForm(form) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    form.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    form.on('end', () => resolve(Buffer.concat(chunks)));
    form.on('error', reject);
    form.resume();
  });
}

function putFile(name, buf) {
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads', name), buf);
  return `https://upload.example.test/uploads/${name}`;
}
async function jpeg(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#80a040' } }).jpeg({ quality: 85 }).toBuffer();
}
function ffmpegFile(name, args) {
  const out = path.join(root, 'uploads', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, out]);
  return `https://upload.example.test/uploads/${name}`;
}

/** One file of each supported kind, cycling; unique bytes so nothing is reused between messages. */
let seq = 0;
async function makeMedia(kind) {
  seq += 1;
  switch (kind) {
    case 'image': return { type: 'image', mediaUrl: putFile(`i${seq}.jpg`, await jpeg(600 + seq, 400)) };
    case 'document': return { type: 'document', mediaUrl: putFile(`d${seq}.pdf`, Buffer.from(`%PDF-1.4\n% doc ${seq}\n%%EOF\n`)) };
    case 'video': return { type: 'video', mediaUrl: ffmpegFile(`v${seq}.mp4`, ['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=1`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']) };
    case 'audio': return { type: 'audio', mediaUrl: ffmpegFile(`a${seq}.mp3`, ['-f', 'lavfi', '-i', `sine=frequency=${300 + seq}:duration=1`]) };
    default: throw new Error(kind);
  }
}
const KINDS = ['image', 'document', 'video', 'audio'];

async function accept(chat, kind, extra = {}) {
  const m = await makeMedia(kind);
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let error;
  await messages.send({ body: { chatId: String(chat._id), async: true, clientMessageId: `c-${seq}`, ...m, ...extra }, user: { _id: chat._id } }, res, (e) => { error = e; });
  if (error) throw error;
  expect(res.statusCode).toBe(202);
  return String(res.body._id);
}

const jobFor = (id) => ({ attrs: { data: { messageId: id } }, remove: async () => {} });
const runProcessJob = (id) => handlers[svc.JOB_PROCESS](jobFor(id));
const runLaterJob = (id) => handlers[svc.JOB_LATER]({ attrs: { data: { kind: 'process', messageId: id } }, remove: async () => {} });

beforeAll(async () => {
  await db.start();
  svc.defineJobs({ define(name, opts, fn) { handlers[name] = fn; defs[name] = opts; } });
  // Count media files being processed at the same time, at the real entry of the processing code.
  const realPrepare = pipe.prepareMedia;
  const realAcquire = pipe.mediaTaskSlots.acquire.bind(pipe.mediaTaskSlots);
  jest.spyOn(pipe.mediaTaskSlots, 'acquire').mockImplementation(async () => {
    await realAcquire();
    maxSlotsHeld = Math.max(maxSlotsHeld, pipe.mediaTaskSlots.active);
  });
  jest.spyOn(pipe, 'prepareMedia').mockImplementation(async (...a) => {
    inflightTasks += 1;
    maxInflightTasks = Math.max(maxInflightTasks, inflightTasks);
    try {
      await new Promise((r) => setTimeout(r, 40)); // make overlap observable
      return await realPrepare(...a);
    } finally { inflightTasks -= 1; }
  });
});
afterAll(async () => { await db.stop(); fs.rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.clear();
  mockAgenda.later = [];
  sends = []; failUploadFor = new Set(); uploadDelayMs = 60;
  inflightUploads = 0; maxInflightUploads = 0; inflightTasks = 0; maxInflightTasks = 0; maxSlotsHeld = 0;
  axios.mockReset();
  axios.get = jest.fn(async () => { throw new Error('own files must not be downloaded over HTTP'); });
  axios.post = jest.fn(async (_url, form) => {
    inflightUploads += 1;
    maxInflightUploads = Math.max(maxInflightUploads, inflightUploads);
    try {
      const raw = await readForm(form);
      await new Promise((r) => setTimeout(r, uploadDelayMs));
      const text = raw.toString('latin1');
      for (const name of failUploadFor) {
        if (text.includes(name)) {
          const e = new Error('Request failed with status code 400');
          e.response = { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } };
          throw e;
        }
      }
      return { data: { id: `MEDIA-${raw.length}-${Math.random().toString(36).slice(2, 8)}` } };
    } finally { inflightUploads -= 1; }
  });
  axios.mockImplementation(async (opts) => {
    sends.push(opts.data);
    return { data: { messages: [{ id: `wamid.${sends.length}` }] } };
  });
  const waba = await Waba.create({ wabaId: 'W1', businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: 'pn-1', phoneNumber: '919000000000' }] });
  const mk = async (n) => {
    const c = await Contact.create({ phoneNumber: `9198000000${n}`, waId: `9198000000${n}`, name: `C${n}` });
    return Chat.create({ wabaId: waba._id, phoneNumberId: 'pn-1', phoneNumber: `9198000000${n}`, waId: `9198000000${n}`, contactId: c._id, sessionExpiresAt: new Date(Date.now() + 3600e3) });
  };
  chatA = await mk('01'); chatB = await mk('02');
});

afterEach(() => {
  expect(pipe.mediaTaskSlots.active).toBe(0); // every slot was handed back, whatever happened
  expect(pipe.mediaTaskSlots.waiting).toBe(0);
});

describe('limit of 5', () => {
  test('the default limit is 5 and both Agenda job types use it', () => {
    expect(CONCURRENCY.tasks).toBe(5);
    expect(pipe.mediaTaskSlots.max).toBe(5);
    expect(defs[svc.JOB_PROCESS].concurrency).toBe(5);
    expect(defs[svc.JOB_LATER].concurrency).toBe(5);
  });

  test('14 mixed files (image, document, video, audio) started at once: 5 at a time, all sent once', async () => {
    const ids = [];
    for (let i = 0; i < 14; i += 1) ids.push(await accept(i % 2 ? chatA : chatB, KINDS[i % KINDS.length]));
    await Promise.all(ids.map(runProcessJob)); // worst case: Agenda hands over every job at the same instant
    expect(maxSlotsHeld).toBe(5);
    expect(maxInflightTasks).toBeLessThanOrEqual(5);
    expect(maxInflightUploads).toBeLessThanOrEqual(5);
    const docs = await Message.find({ _id: { $in: ids } }).lean();
    expect(docs.every((m) => m.status === 'sent' && m.pipeline.stage === 'sent')).toBe(true);
    expect(sends).toHaveLength(14); // exactly one WhatsApp send per message
    expect(new Set(sends.map((s) => s.biz_opaque_callback_data)).size).toBe(14);
  });

  test('retry job and normal job share ONE limit (not 5 + 5)', async () => {
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(await accept(chatA, i % 2 ? 'image' : 'document'));
    await Promise.all(ids.map((id, i) => (i % 2 ? runLaterJob(id) : runProcessJob(id))));
    expect(maxSlotsHeld).toBe(5);
    expect(maxInflightTasks).toBeLessThanOrEqual(5);
    const docs = await Message.find({ _id: { $in: ids } }).lean();
    expect(docs.every((m) => m.status === 'sent')).toBe(true);
  });

  test('inline (legacy), bulk-style and background sends together still stay within 5', async () => {
    const bg = [];
    for (let i = 0; i < 5; i += 1) bg.push(await accept(chatA, 'image'));
    const inline = [];
    for (let i = 0; i < 5; i += 1) {
      const m = await makeMedia('image');
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      inline.push(messages.send({ body: { chatId: String(chatB._id), ...m }, user: { _id: chatB._id } }, res, (e) => { throw e; }).then(() => res));
    }
    const results = await Promise.all([...bg.map(runProcessJob), ...inline]);
    expect(maxSlotsHeld).toBe(5);
    expect(maxInflightTasks).toBeLessThanOrEqual(5);
    for (const r of results.slice(5)) expect(r.statusCode).toBe(201);
    expect(sends).toHaveLength(10);
  });

  test('a failing file fails alone: the rest of a 9-file batch is still sent, no slot is lost', async () => {
    const ids = [];
    for (let i = 0; i < 9; i += 1) ids.push(await accept(chatA, KINDS[i % KINDS.length]));
    // make the 4th message permanently unprocessable: its file disappears before the worker reads it
    const victim = await Message.findById(ids[3]).lean();
    fs.rmSync(path.join(root, 'uploads', path.basename(victim.mediaUrl)));
    await Promise.all(ids.map(runProcessJob));
    const docs = await Message.find({ _id: { $in: ids } }).lean();
    const byId = Object.fromEntries(docs.map((m) => [String(m._id), m]));
    expect(byId[ids[3]].status).toBe('failed');
    expect(byId[ids[3]].pipeline.active).toBe(false);
    for (const id of ids.filter((_, i) => i !== 3)) expect(byId[id].status).toBe('sent');
    expect(sends).toHaveLength(8);
    expect(maxInflightTasks).toBeLessThanOrEqual(5);
  });

  test('a transient Meta failure frees the slot and is retried later through the retry job', async () => {
    let failures = 0;
    const realPost = axios.post.getMockImplementation();
    axios.post.mockImplementation(async (...a) => {
      if (failures < 3) { failures += 1; await readForm(a[1]); const e = new Error('x'); e.response = { status: 503, data: {} }; throw e; }
      return realPost(...a);
    });
    const id = await accept(chatA, 'image');
    await runProcessJob(id); // 3 uploads fail -> back to 'queued' + a retry job is scheduled
    let m = await Message.findById(id).lean();
    expect(m.status).toBe('queued');
    expect(m.pipeline.stage).toBe('queued');
    expect(m.pipeline.error.willRetry).toBe(true);
    expect(mockAgenda.later.some((j) => j.data.kind === 'process' && j.data.messageId === id)).toBe(true);
    expect(pipe.mediaTaskSlots.active).toBe(0); // the waiting retry holds no slot
    await runLaterJob(id);
    m = await Message.findById(id).lean();
    expect(m.status).toBe('sent');
    expect(sends).toHaveLength(1);
  });

  test('the same job delivered twice at once (Agenda lock expiry) processes and sends the message once', async () => {
    const id = await accept(chatA, 'video');
    await Promise.all([runProcessJob(id), runProcessJob(id), runLaterJob(id)]);
    const m = await Message.findById(id).lean();
    expect(m.status).toBe('sent');
    expect(sends).toHaveLength(1);
    expect(m.pipeline.attempts).toBe(1);
  });

  test('two chats at once: each message goes to its own chat and each chat keeps its own order', async () => {
    const a = []; const b = [];
    for (let i = 0; i < 4; i += 1) { a.push(await accept(chatA, KINDS[i])); b.push(await accept(chatB, KINDS[(i + 1) % 4])); }
    await Promise.all([...a, ...b].reverse().map(runProcessJob)); // reverse: later messages try first
    const docs = await Message.find({ _id: { $in: [...a, ...b] } }).sort({ 'pipeline.timings.sentAt': 1 }).lean();
    expect(docs.every((m) => m.status === 'sent')).toBe(true);
    for (const [ids, chat] of [[a, chatA], [b, chatB]]) {
      const mine = docs.filter((m) => String(m.chatId) === String(chat._id));
      expect(mine.map((m) => String(m._id))).toEqual(ids); // sent in creation order within the chat
    }
    // every send went to the number of the chat the message belongs to
    const recipient = Object.fromEntries(docs.map((m) => [String(m._id), String(m.chatId)]));
    for (const s of sends) {
      const msgId = s.biz_opaque_callback_data.split(':')[1];
      const chat = recipient[msgId] === String(chatA._id) ? chatA : chatB;
      expect(String(s.to)).toBe(String(chat.waId));
    }
  });

  test('more files than slots: the first 5 start first, the rest wait as queued and start as slots free up', async () => {
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push(await accept(chatA, 'image'));
    const all = Promise.all(ids.map(runProcessJob));
    await new Promise((r) => setTimeout(r, 25)); // first wave is inside its slots, the second is still waiting
    expect(pipe.mediaTaskSlots.active).toBe(5);
    expect(pipe.mediaTaskSlots.waiting).toBe(3);
    const stages = Object.fromEntries((await Message.find({ _id: { $in: ids } }).lean()).map((m) => [String(m._id), m.pipeline.stage]));
    for (const id of ids.slice(5)) expect(stages[id]).toBe('queued'); // honest status while waiting
    await all;
    expect((await Message.find({ _id: { $in: ids } }).lean()).every((m) => m.status === 'sent')).toBe(true);
  });
});
