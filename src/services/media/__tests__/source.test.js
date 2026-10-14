/**
 * Own-upload URLs are read from disk safely; anything else is downloaded. Real files, real HTTP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-'));
process.env.VPS_UPLOAD_DIR = root;
process.env.VPS_UPLOAD_URL = 'https://upload.example.test';

const { resolveLocalUploadPath, openMediaSource } = require('../source');
const { Semaphore } = require('../semaphore');

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
beforeAll(() => {
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads', 'a b.jpg'), 'jpegbytes');
  fs.writeFileSync(path.join(outside, 'passwd'), 'secret');
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(root, 'uploads', 'link.jpg'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('own upload URL maps to the file on disk', async () => {
  const r = await resolveLocalUploadPath('https://upload.example.test/uploads/a%20b.jpg');
  expect(r.path).toBe(fs.realpathSync(path.join(root, 'uploads', 'a b.jpg')));
  expect(r.size).toBe(9);
  const src = await openMediaSource('https://upload.example.test/uploads/a%20b.jpg');
  expect(src.local).toBe(true);
  await src.cleanup();
  expect(fs.existsSync(path.join(root, 'uploads', 'a b.jpg'))).toBe(true); // cleanup never deletes uploads
});

test('other hosts / schemes are not mapped to files', async () => {
  expect(await resolveLocalUploadPath('https://evil.example/uploads/a%20b.jpg')).toBeNull();
  expect(await resolveLocalUploadPath('http://upload.example.test/uploads/a%20b.jpg')).toBeNull();
  expect(await resolveLocalUploadPath('https://upload.example.test/uploads/a%20b.jpg?x=1')).toBeNull();
  expect(await resolveLocalUploadPath('blob:https://dash.example/1234')).toBeNull();
  expect(await resolveLocalUploadPath('file:///etc/passwd')).toBeNull();
});

test('path traversal, encoded separators and symlink escapes are rejected', async () => {
  for (const u of [
    'https://upload.example.test/uploads/%2e%2e/%2e%2e/etc/passwd',
    'https://upload.example.test/uploads/..%2F..%2Fetc%2Fpasswd',
    'https://upload.example.test/uploads/a%5Cb.jpg',
    'https://upload.example.test/uploads/%00.jpg',
    'https://upload.example.test/uploads/link.jpg',
    'https://upload.example.test/uploads/',
  ]) {
    await expect(resolveLocalUploadPath(u)).rejects.toMatchObject({ code: expect.stringMatching(/MEDIA_PATH_INVALID|MEDIA_FILE_MISSING/) });
  }
  await expect(resolveLocalUploadPath('https://upload.example.test/uploads/link.jpg')).rejects.toMatchObject({ code: 'MEDIA_PATH_INVALID' });
});

test('missing own file gives a clear error', async () => {
  await expect(resolveLocalUploadPath('https://upload.example.test/uploads/gone.jpg')).rejects.toMatchObject({ code: 'MEDIA_FILE_MISSING' });
});

test('external URL is streamed to a temp file and cleaned up', async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 7);
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'video/mp4'); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const src = await openMediaSource(`http://127.0.0.1:${port}/x.mp4`);
    expect(src.local).toBe(false);
    expect(src.size).toBe(body.length);
    expect(src.headerMime).toBe('video/mp4');
    expect(fs.readFileSync(src.path).equals(body)).toBe(true);
    await src.cleanup();
    expect(fs.existsSync(src.path)).toBe(false);
    // size cap
    const { downloadToTemp } = require('../source');
    await expect(downloadToTemp(`http://127.0.0.1:${port}/x.mp4`, { maxBytes: 1000 })).rejects.toBeTruthy();
  } finally {
    server.close();
  }
});

test('semaphore never runs more than max at once', async () => {
  const s = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const task = () => s.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
  });
  await Promise.all(Array.from({ length: 7 }, task));
  expect(peak).toBe(2);
  expect(s.active).toBe(0);
});
