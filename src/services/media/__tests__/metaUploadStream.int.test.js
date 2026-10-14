/**
 * uploadMediaFile streams the file to Meta: exact multipart Content-Length, the whole file arrives
 * (no truncation), and the file is not copied into JS memory. Real axios + a local HTTP server
 * standing in for graph.facebook.com.
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const v8 = require('v8');
const vm = require('vm');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

let server;
let received;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let n = 0;
    const hash = crypto.createHash('sha256');
    const chunks = [];
    req.on('data', (c) => { n += c.length; hash.update(c); if (chunks.length < 1) chunks.push(Buffer.from(c.subarray(0, 600))); });
    req.on('end', () => {
      received = { bytes: n, contentLength: Number(req.headers['content-length']), head: Buffer.concat(chunks).subarray(0, 600).toString('latin1'), auth: req.headers.authorization };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'MEDIA-STREAM-1' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(() => server.close());

test('30 MB file is streamed with a correct Content-Length and little extra memory', async () => {
  const file = path.join(os.tmpdir(), `meta_stream_${process.pid}.mp4`);
  const size = 30 * 1024 * 1024;
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < 30; i++) fs.writeSync(fd, crypto.randomBytes(1024 * 1024));
  fs.closeSync(fd);

  jest.resetModules();
  jest.doMock('../../../models/Waba', () => ({ findById: async () => ({ accessToken: 'tok' }) }));
  const svc = require('../../whatsapp.service');
  // Point the service at the local server instead of graph.facebook.com.
  const axios = require('axios');
  const realPost = axios.post.bind(axios);
  const spy = jest.spyOn(axios, 'post').mockImplementation((url, data, opts) =>
    realPost(url.replace(/^https:\/\/graph\.facebook\.com\/[^/]+/, `http://127.0.0.1:${server.address().port}`), data, opts));

  gc();
  const before = process.memoryUsage().arrayBuffers;
  let peak = before;
  const sampler = setInterval(() => { gc(); peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 20);
  const id = await svc.uploadMediaFile('W', 'PN', file, 'video/mp4', size);
  clearInterval(sampler);
  const grew = peak - before;
  spy.mockRestore();
  fs.unlinkSync(file);

  expect(id).toBe('MEDIA-STREAM-1');
  expect(received.bytes).toBe(received.contentLength);
  expect(received.bytes).toBeGreaterThan(size); // whole file + multipart framing
  expect(received.bytes - size).toBeLessThan(1024);
  expect(received.head).toContain('name="type"');
  expect(received.head).toContain('video/mp4');
  expect(received.auth).toBe('Bearer tok');
  // A buffered implementation would hold >= 30 MB of ArrayBuffer memory at once.
  expect(grew).toBeLessThan(15 * 1024 * 1024);
});
