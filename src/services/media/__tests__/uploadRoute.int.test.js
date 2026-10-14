/**
 * POST /upload/file writes the file straight to disk (no memory storage), keeps the response contract,
 * and leaves no partial ".part" file behind. Real express + multer + supertest; DB model mocked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-upload-'));
process.env.VPS_UPLOAD_DIR = root;
process.env.VPS_UPLOAD_URL = 'https://upload.example.test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
process.env.MAX_FILE_SIZE = String(2 * 1024 * 1024);

jest.mock('../../../middleware/auth.middleware', () => ({ authenticate: (req, res, next) => { req.user = { _id: 'u1' }; next(); } }));
jest.mock('../../media.service', () => ({ saveMediaMetadata: jest.fn(async (m) => ({ _id: 'media1', type: m.type })) }));

const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../../middleware/errorHandler.middleware');

const app = express();
app.use('/api/upload', require('../../../routes/upload.routes'));
app.use(errorHandler);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('file is saved to the upload folder and the URL maps back to it', async () => {
  const body = Buffer.alloc(300 * 1024, 9);
  const res = await request(app).post('/api/upload/file').attach('file', body, { filename: 'photo 1.JPG', contentType: 'image/jpeg' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, mediaId: 'media1', type: 'image', size: body.length });
  expect(res.body.url).toMatch(/^https:\/\/upload\.example\.test\/uploads\/\d+_[a-f0-9]{16}\.jpg$/);
  const name = res.body.url.split('/').pop();
  const saved = path.join(root, 'uploads', name);
  expect(fs.readFileSync(saved).equals(body)).toBe(true);
  expect(fs.readdirSync(path.join(root, 'uploads')).filter((n) => n.endsWith('.part'))).toHaveLength(0);
  const { resolveLocalUploadPath } = require('../source');
  expect((await resolveLocalUploadPath(res.body.url)).path).toBe(fs.realpathSync(saved));
});

test('oversized upload is refused with 413 and leaves no partial file', async () => {
  const res = await request(app).post('/api/upload/file').attach('file', Buffer.alloc(3 * 1024 * 1024, 1), { filename: 'big.mp4', contentType: 'video/mp4' });
  expect(res.status).toBe(413);
  const left = fs.readdirSync(path.join(root, 'uploads')).filter((n) => n.includes('big') || n.endsWith('.part'));
  expect(left).toHaveLength(0);
});

test('unsafe extensions are not used for the stored name', async () => {
  const res = await request(app).post('/api/upload/file').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'a.p$hp', contentType: 'application/pdf' });
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/\.pdf$/);
});
