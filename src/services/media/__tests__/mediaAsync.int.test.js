/**
 * Background media sends end to end: POST /messages/send (async) -> durable message + job -> worker
 * (local file read, preparation, streamed Meta upload, ordered send) -> persisted status + socket events.
 * In-memory MongoDB, real sharp/ffmpeg, mocked Meta (axios) and a fake Agenda that records saved jobs.
 */
jest.setTimeout(120000);
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-async-'));
process.env.VPS_UPLOAD_DIR = root;
process.env.VPS_UPLOAD_URL = 'https://upload.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../../testutils/memoryDb');

const mockIo = db.fakeIO();
jest.mock('../../../websocket/socket.server', () => ({ getIO: () => mockIo }));
const mockAgenda = {
  saved: [], later: [], available: true,
  create(name, data) {
    const job = {
      attrs: { name, data },
      unique() { return job; },
      schedule() { return job; },
      async save() {
        if (!mockAgenda.available) throw new Error('mongo down');
        // record whether the message already existed when the job was stored
        const { Message } = require('../../../models');
        const exists = await Message.exists({ _id: data.messageId });
        const dupe = mockAgenda.saved.find((j) => j.name === name && j.data.messageId === data.messageId && !j.done);
        if (!dupe) mockAgenda.saved.push({ name, data, messageExisted: Boolean(exists) });
        return job;
      },
    };
    return job;
  },
  async schedule(when, name, data) { mockAgenda.later.push({ when, name, data }); },
};
jest.mock('../../../jobs/agenda', () => ({ getAgenda: () => (mockAgenda.available === 'none' ? undefined : mockAgenda) }));
jest.mock('axios');
const axios = require('axios');

const { Waba, Contact, Chat, Message, SendRequest } = require('../../../models');
const messages = require('../../../controllers/messages.controller');
const svc = require('../mediaMessageService');
const webhook = require('../../webhook.service');

let uploads;
let sends;
let sendBehaviour; // per-call override
let chat;
let waba;

function readForm(form) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    form.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    form.on('end', () => resolve(Buffer.concat(chunks)));
    form.on('error', reject);
    form.resume();
  });
}

function uploadFile(name, buf) {
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads', name), buf);
  return `https://upload.example.test/uploads/${name}`;
}

async function jpeg(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#c08040' } }).jpeg({ quality: 85 }).toBuffer();
}

beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); fs.rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.clear();
  mockIo.events.length = 0;
  mockAgenda.saved = []; mockAgenda.later = []; mockAgenda.available = true;
  uploads = []; sends = []; sendBehaviour = [];
  axios.mockReset();
  axios.get = jest.fn(async () => { throw new Error('own files must not be downloaded over HTTP'); });
  axios.post = jest.fn(async (_url, form, opts) => {
    const raw = await readForm(form);
    uploads.push({ raw, length: raw.length, contentLength: opts.headers['Content-Length'] });
    return { data: { id: `MEDIA${uploads.length}` } };
  });
  axios.mockImplementation(async (opts) => {
    const b = sendBehaviour.shift();
    if (b) return b(opts);
    sends.push(opts.data);
    return { data: { messages: [{ id: `wamid.OUT${sends.length}` }] } };
  });
  waba = await Waba.create({ wabaId: 'W1', businessName: 'BJS', accessToken: 'test-token', phoneNumbers: [{ phoneNumberId: 'pn-1', phoneNumber: '919000000000' }] });
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

const events = (name) => mockIo.events.filter((e) => e.event === name).map((e) => e.payload);

describe('accepting a background media send', () => {
  test('202 only after the message and its job are stored; job created once per message', async () => {
    const url = uploadFile('p1.jpg', await jpeg(800, 600));
    const res = await send({ type: 'image', mediaUrl: url, async: true, clientMessageId: 'c-1', clientTimings: { uploadMs: 2400, uploadBytes: 12345 } });
    expect(res.statusCode).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.pipeline).toMatchObject({ mode: 'async', stage: 'queued', active: true });
    expect(res.body.pipeline.timings.client).toMatchObject({ uploadMs: 2400, uploadBytes: 12345 });
    expect(res.body.mediaWork).toBeUndefined(); // server-only data is not sent to clients
    expect(mockAgenda.saved).toHaveLength(1);
    expect(mockAgenda.saved[0].messageExisted).toBe(true);
    expect(sends).toHaveLength(0); // nothing sent before the worker runs

    // the same request again (client retry) -> same message, no second job
    const again = await send({ type: 'image', mediaUrl: url, async: true, clientMessageId: 'c-1' });
    expect([200, 202]).toContain(again.statusCode);
    expect(String(again.body._id)).toBe(String(res.body._id));
    expect(await Message.countDocuments({})).toBe(1);
    expect(mockAgenda.saved).toHaveLength(1);
  });

  test('queue unavailable -> 503 and the message is marked failed (no fake acceptance)', async () => {
    mockAgenda.available = false;
    const url = uploadFile('p2.jpg', await jpeg(800, 600));
    const res = await send({ type: 'image', mediaUrl: url, async: true });
    expect(res.statusCode).toBe(503);
    const m = await Message.findById(res.body.messageId).lean();
    expect(m.status).toBe('failed');
  });

  test('a blob:/local preview URL is rejected, never treated as a Meta media id', async () => {
    const res = await send({ type: 'image', mediaUrl: 'blob:https://dash.example/abc', async: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('LOCAL_MEDIA_REF');
    const legacy = await send({ type: 'image', mediaUrl: 'blob:https://dash.example/abc' });
    expect(legacy.statusCode).toBe(400);
    expect(sends).toHaveLength(0);
  });
});

describe('worker', () => {
  test('acceptable JPEG: read from disk, uploaded byte-for-byte, sent with callback data, persisted + emitted', async () => {
    const buf = await jpeg(1200, 900);
    const url = uploadFile('p3.jpg', buf);
    const res = await send({ type: 'image', mediaUrl: url, caption: 'Ring', async: true });
    await svc.processMessage(res.body._id);

    expect(axios.get).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].raw.includes(buf)).toBe(true); // original bytes, not re-encoded
    expect(uploads[0].length).toBe(uploads[0].contentLength);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ type: 'image', image: { id: 'MEDIA1', caption: 'Ring' } });
    expect(sends[0].biz_opaque_callback_data).toBe(`bjs:${res.body._id}:1`);

    const m = await Message.findById(res.body._id).lean();
    expect(m.status).toBe('sent');
    expect(m.messageId).toBe('wamid.OUT1');
    expect(m.pipeline).toMatchObject({ stage: 'sent', active: false, prepareAction: 'passthrough' });
    for (const k of ['acceptedAt', 'prepareStartedAt', 'prepareEndedAt', 'metaUploadMs', 'sendMs', 'sentAt']) {
      expect(m.pipeline.timings[k]).toBeDefined();
    }
    expect(m.pipeline.timings.sourceLocal).toBe(true);
    const stages = events('message:pipeline').filter((e) => e.messageId === String(res.body._id)).map((e) => e.pipeline.stage);
    expect(stages).toEqual(['preparing', 'uploading_media', 'ready', 'sending', 'sent']);
    const versions = events('message:pipeline').map((e) => e.pipeline.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions); // monotonic -> clients can drop stale events
    expect(events('message:status').pop()).toMatchObject({ messageId: String(res.body._id), status: 'sent', waMessageId: 'wamid.OUT1' });
    // no temp files left behind for this message
    const tmpDir = path.join(os.tmpdir(), 'bjs-media');
    const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    expect(leftovers).toHaveLength(0);
  });

  test('a chat\'s media go out in the order they were sent, even if a later one is ready first', async () => {
    const a = await send({ type: 'image', mediaUrl: uploadFile('o1.jpg', await jpeg(700, 500)), async: true, clientMessageId: 'o-1' });
    const b = await send({ type: 'image', mediaUrl: uploadFile('o2.jpg', await jpeg(701, 500)), async: true, clientMessageId: 'o-2' });
    await svc.processMessage(b.body._id); // the second finishes preparing first
    expect(sends).toHaveLength(0);
    const mb = await Message.findById(b.body._id).lean();
    expect(mb.pipeline.stage).toBe('ready');
    expect(mb.pipeline.waitingForEarlier).toBe(true);
    await svc.processMessage(a.body._id);
    expect(sends.map((s) => s.image.id)).toEqual(['MEDIA2', 'MEDIA1']); // a used upload #2, b upload #1
    const [ma, mb2] = await Promise.all([Message.findById(a.body._id).lean(), Message.findById(b.body._id).lean()]);
    expect(ma.messageId).toBe('wamid.OUT1');
    expect(mb2.messageId).toBe('wamid.OUT2');
  });

  test('Meta rejects one message: only that message fails, the next one is still sent', async () => {
    const a = await send({ type: 'image', mediaUrl: uploadFile('f1.jpg', await jpeg(600, 400)), async: true });
    const b = await send({ type: 'image', mediaUrl: uploadFile('f2.jpg', await jpeg(600, 401)), async: true });
    sendBehaviour.push(async () => {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { code: 131051, message: 'Unsupported message type' } } };
      throw e;
    });
    await svc.processMessage(a.body._id);
    await svc.processMessage(b.body._id);
    const [ma, mb] = await Promise.all([Message.findById(a.body._id).lean(), Message.findById(b.body._id).lean()]);
    expect(ma.status).toBe('failed');
    expect(ma.errorMessage).toMatch(/Unsupported message type/);
    expect(ma.pipeline.error.stage).toBe('send');
    expect(mb.status).toBe('sent');
  });

  test('send timeout is never re-sent automatically; webhook callback data reconciles it', async () => {
    const r = await send({ type: 'image', mediaUrl: uploadFile('t1.jpg', await jpeg(600, 400)), async: true });
    sendBehaviour.push(async (opts) => {
      sends.push(opts.data);
      const e = new Error('timeout of 30000ms exceeded');
      e.code = 'ECONNABORTED';
      throw e;
    });
    await svc.processMessage(r.body._id);
    expect(sends).toHaveLength(1); // exactly one attempt
    let m = await Message.findById(r.body._id).lean();
    expect(m.status).toBe('queued');
    expect(m.pipeline.stage).toBe('unconfirmed');
    await svc.sweep();
    expect(sends).toHaveLength(1); // the sweep does not re-send

    // Meta's status webhook for the lost send carries our callback data
    await webhook.processWebhook({ id: 'W1', changes: [{ value: { statuses: [{ id: 'wamid.LOST', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919800000001', biz_opaque_callback_data: `bjs:${r.body._id}:1` }] } }] });
    m = await Message.findById(r.body._id).lean();
    expect(m.messageId).toBe('wamid.LOST');
    expect(m.status).toBe('delivered');
    expect(m.pipeline.stage).toBe('sent');
    expect(m.statusTimes.delivered).toBeDefined();
  });

  test('unconfirmed with no webhook becomes failed with an honest message after the wait', async () => {
    const r = await send({ type: 'image', mediaUrl: uploadFile('t2.jpg', await jpeg(600, 400)), async: true });
    sendBehaviour.push(async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; });
    await svc.processMessage(r.body._id);
    await Message.updateOne({ _id: r.body._id }, { $set: { 'pipeline.stageAt': new Date(Date.now() - 10 * 60e3) } });
    await svc.sweep();
    const m = await Message.findById(r.body._id).lean();
    expect(m.status).toBe('failed');
    expect(m.errorMessage).toMatch(/may still have reached the customer/);
  });

  test('retry after a send failure reuses the Meta media id (no new conversion or upload)', async () => {
    const r = await send({ type: 'image', mediaUrl: uploadFile('r1.jpg', await jpeg(600, 400)), async: true });
    sendBehaviour.push(async () => { const e = new Error('bad'); e.response = { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } }; throw e; });
    await svc.processMessage(r.body._id);
    expect(uploads).toHaveLength(1);
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let err;
    await messages.retry({ params: { id: String(r.body._id) }, body: { async: true }, user: { _id: chat._id } }, res, (e) => { err = e; });
    expect(err).toBeUndefined();
    expect(res.statusCode).toBe(202);
    expect(uploads).toHaveLength(1); // not uploaded again
    const m = await Message.findById(r.body._id).lean();
    expect(m.status).toBe('sent');
    expect(m.pipeline.retries).toBe(1);
    expect(m.pipeline.timings.metaUploadReused).toBe(true);
    expect(m.pipeline.timings.firstAcceptedAt).toBeDefined();
  });

  test('preparation failure (corrupt image) fails only that message, nothing is uploaded or sent', async () => {
    const r = await send({ type: 'image', mediaUrl: uploadFile('bad.jpg', Buffer.from('not an image')), async: true });
    await svc.processMessage(r.body._id);
    const m = await Message.findById(r.body._id).lean();
    expect(m.status).toBe('failed');
    expect(m.pipeline.error.stage).toBe('prepare');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  test('transient Meta upload error is retried; a converted file is kept for the next attempt', async () => {
    const big = await jpeg(3000, 2000); // needs resizing -> converted file is kept between attempts
    const r = await send({ type: 'image', mediaUrl: uploadFile('big.jpg', big), async: true });
    let calls = 0;
    axios.post = jest.fn(async (_u, form) => {
      calls += 1;
      await readForm(form);
      const e = new Error('Service unavailable'); e.response = { status: 503, data: {} }; throw e;
    });
    await svc.processMessage(r.body._id);
    expect(calls).toBe(3); // uploadWithRetry: 3 tries
    let m = await Message.findById(r.body._id).select('+mediaWork').lean();
    expect(m.pipeline.stage).toBe('queued'); // job will retry later
    expect(m.pipeline.error.willRetry).toBe(true);
    expect(mockAgenda.later[0].data).toMatchObject({ kind: 'process', messageId: String(r.body._id) });
    expect(fs.existsSync(m.mediaWork.preparedPath)).toBe(true);
    // next attempt succeeds and uses the kept file (no second conversion), then removes it
    axios.post = jest.fn(async (_u, form) => { const raw = await readForm(form); uploads.push({ raw }); return { data: { id: 'MEDIA9' } }; });
    await svc.processMessage(r.body._id);
    m = await Message.findById(r.body._id).select('+mediaWork').lean();
    expect(m.status).toBe('sent');
    expect(m.mediaWork.preparedPath).toBeUndefined();
    const out = await sharp(uploads[0].raw.subarray(uploads[0].raw.indexOf(Buffer.from([0xff, 0xd8, 0xff])))).metadata().catch(() => null);
    expect(out && out.width).toBe(2048);
  }, 60000);

  test('three photos processed concurrently: each sent exactly once, in order', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await send({ type: 'image', mediaUrl: uploadFile(`c${i}.jpg`, await jpeg(600 + i, 400)), async: true, clientMessageId: `cc-${i}` });
      ids.push(String(r.body._id));
    }
    await Promise.all([...ids].reverse().map((id) => svc.processMessage(id)));
    await svc.sweep(); // nothing left to do, must not resend
    expect(sends).toHaveLength(3);
    const ms = await Message.find({ _id: { $in: ids } }).lean();
    const byId = Object.fromEntries(ms.map((m) => [String(m._id), m]));
    expect(ids.map((id) => byId[id].status)).toEqual(['sent', 'sent', 'sent']);
    expect(ids.map((id) => byId[id].messageId)).toEqual(['wamid.OUT1', 'wamid.OUT2', 'wamid.OUT3']);
  });

  test('HEVC video in the background job is transcoded to H.264 MP4 before upload', async () => {
    const { execFileSync } = require('child_process');
    const src = path.join(root, 'uploads', 'v.mp4');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'aac', src]);
    const r = await send({ type: 'video', mediaUrl: 'https://upload.example.test/uploads/v.mp4', async: true });
    await svc.processMessage(r.body._id);
    const m = await Message.findById(r.body._id).lean();
    expect(m.status).toBe('sent');
    expect(m.pipeline.prepareAction).toBe('transcode');
    expect(m.pipeline.timings.convertMs).toBeGreaterThan(0);
    expect(uploads[0].raw.toString('latin1')).toContain('video/mp4');
    expect(sends[0]).toMatchObject({ type: 'video', video: { id: 'MEDIA1' } });
  }, 60000);

  test('stale queued message without a running job is re-enqueued by the sweep (restart safety)', async () => {
    const r = await send({ type: 'image', mediaUrl: uploadFile('s1.jpg', await jpeg(600, 400)), async: true });
    mockAgenda.saved = [];
    await Message.updateOne({ _id: r.body._id }, { $set: { 'pipeline.stageAt': new Date(Date.now() - 5 * 60e3) } });
    await svc.sweep();
    expect(mockAgenda.saved.map((j) => j.data.messageId)).toEqual([String(r.body._id)]);
  });

  test('back-pressure: over the pending limit the API answers 503 instead of queueing forever', async () => {
    const { MAX_PENDING_MEDIA } = require('../limits');
    await Message.insertMany(Array.from({ length: MAX_PENDING_MEDIA }, () => ({
      chatId: chat._id, direction: 'outbound', type: 'image', status: 'queued', pipeline: { mode: 'async', stage: 'queued', active: true },
    })));
    const res = await send({ type: 'image', mediaUrl: uploadFile('bp.jpg', Buffer.from('x')), async: true });
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('MEDIA_QUEUE_FULL');
  });
});

describe('legacy (synchronous) clients and bulk use the same rules', () => {
  test('sync send: 201, own file read from disk, passthrough, timings stored', async () => {
    const buf = await jpeg(900, 700);
    const res = await send({ type: 'image', mediaUrl: uploadFile('sy.jpg', buf) });
    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('sent');
    expect(axios.get).not.toHaveBeenCalled();
    expect(uploads[0].raw.includes(buf)).toBe(true);
    expect(res.body.pipeline).toMatchObject({ mode: 'sync', stage: 'sent', prepareAction: 'passthrough' });
    expect(sends[0].biz_opaque_callback_data).toBe(`bjs:${res.body._id}:1`);
  });

  test('external URL still works (streamed download)', async () => {
    const buf = await jpeg(500, 500);
    axios.get = jest.fn(async () => ({ data: buf, headers: { 'content-type': 'image/jpeg' } }));
    const res = await send({ type: 'image', mediaUrl: 'https://cdn.example/x.jpg' });
    expect(res.statusCode).toBe(201);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][1].responseType).toBe('stream');
  });

  test('bulk product send: same pass-through rule, pacing job sends each with callback data', async () => {
    const buf = await jpeg(1000, 1000);
    const big = await jpeg(4000, 3000);
    const req = { body: { chatId: String(chat._id), items: [
      { type: 'image', mediaUrl: uploadFile('b1.jpg', buf), caption: 'A' },
      { type: 'image', mediaUrl: uploadFile('b2.jpg', big), caption: 'B' },
    ] }, user: { _id: chat._id } };
    const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let jobFn;
    mockAgenda.now = async (name, data) => { mockAgenda.saved.push({ name, data }); };
    await messages.sendBulk(req, res, (e) => { throw e; });
    expect(res.statusCode).toBe(201);
    const fakeAgenda = { define: (n, fn) => { if (n === 'send-bulk-messages') jobFn = fn; } };
    require('../../../jobs/bulkSend.jobs')(fakeAgenda);
    await jobFn({ attrs: { data: mockAgenda.saved.find((j) => j.name === 'send-bulk-messages').data } });
    expect(uploads[0].raw.includes(buf)).toBe(true);        // passthrough
    expect(uploads[1].raw.includes(big)).toBe(false);       // resized
    expect(sends).toHaveLength(2);
    expect(sends[0].biz_opaque_callback_data).toMatch(/^bjs:/);
    const ms = await Message.find({ chatId: chat._id }).sort({ createdAt: 1 }).lean();
    expect(ms.map((m) => m.status)).toEqual(['sent', 'sent']);
    expect(ms.map((m) => m.pipeline.prepareAction)).toEqual(['passthrough', 'transformed']);
    // re-running the job never sends again
    await jobFn({ attrs: { data: mockAgenda.saved.find((j) => j.name === 'send-bulk-messages').data } });
    expect(sends).toHaveLength(2);
  }, 60000);

  test('text messages are unaffected and are not held behind pending media', async () => {
    await send({ type: 'image', mediaUrl: uploadFile('h1.jpg', await jpeg(600, 400)), async: true });
    const t = await send({ type: 'text', text: 'hello' });
    expect(t.statusCode).toBe(201);
    expect(sends).toEqual([expect.objectContaining({ type: 'text', text: { body: 'hello' } })]);
  });
});

void SendRequest;
