/**
 * Image preparation rules: acceptable JPEG/PNG pass through byte-for-byte; everything else is
 * auto-oriented, resized to <= 2048 px and re-encoded (PNG kept when transparency is used).
 */
jest.setTimeout(60000);
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { prepareImage, inspectImage } = require('../imagePrep');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprep-'));
const f = (name) => path.join(dir, name);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function solid(w, h, file, fmt = 'jpeg', opts = {}) {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  p = fmt === 'png' ? p.png() : p.jpeg({ quality: 85, ...opts });
  await p.toFile(file);
  return file;
}

async function noisePng(w, h, file) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24; // deterministic noise
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toFile(file);
  return file;
}

const sameBytes = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

test('acceptable phone JPEG passes through without re-encoding', async () => {
  const src = await solid(1600, 1200, f('phone.jpg'));
  const r = await prepareImage(src, f('out1'));
  expect(r.action).toBe('passthrough');
  expect(r.path).toBe(src);
  expect(r.mimeType).toBe('image/jpeg');
  expect(fs.existsSync(f('out1'))).toBe(false); // nothing written
  expect(sameBytes(r.path, src)).toBe(true);
});

test('acceptable PNG passes through without re-encoding', async () => {
  const src = await solid(1280, 720, f('shot.png'), 'png');
  const r = await prepareImage(src, f('out2'));
  expect(r.action).toBe('passthrough');
  expect(r.mimeType).toBe('image/png');
  expect(sameBytes(r.path, src)).toBe(true);
});

test('image above 2048 px is resized proportionally to JPEG q80', async () => {
  const src = await solid(4000, 3000, f('big.jpg'));
  const r = await prepareImage(src, f('out3.jpg'));
  expect(r.action).toBe('transformed');
  expect(r.reasons).toContain('dimensions');
  const m = await sharp(r.path).metadata();
  expect(m.format).toBe('jpeg');
  expect(m.width).toBe(2048);
  expect(m.height).toBe(1536);
});

test('file over 5 MB is compressed below the WhatsApp limit', async () => {
  const src = await noisePng(2000, 2000, f('noise.png'));
  expect(fs.statSync(src).size).toBeGreaterThan(5 * 1024 * 1024);
  const r = await prepareImage(src, f('out4'));
  expect(r.action).toBe('transformed');
  expect(r.reasons).toContain('size');
  expect(r.size).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(fs.statSync(r.path).size).toBe(r.size);
});

test('EXIF orientation is applied (pixels rotated) when a transform is needed', async () => {
  const src = f('rot.jpg');
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#336699' } })
    .jpeg().withMetadata({ orientation: 6 }).toFile(src);
  const info = await inspectImage(src);
  expect(info.reasons).toContain('orientation');
  const r = await prepareImage(src, f('out5.jpg'));
  const m = await sharp(r.path).metadata();
  expect([m.width, m.height]).toEqual([200, 400]);
  expect(m.orientation === undefined || m.orientation === 1).toBe(true);
});

test('transparent PNG keeps its transparency (stays PNG)', async () => {
  const src = f('logo.png');
  await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="1000" height="600"><circle cx="500" cy="300" r="250" fill="red"/></svg>'), left: 1000, top: 200 }])
    .png().toFile(src);
  const r = await prepareImage(src, f('out6'));
  expect(r.action).toBe('transformed');
  expect(r.mimeType).toBe('image/png');
  const m = await sharp(r.path).metadata();
  expect(m.hasAlpha).toBe(true);
  expect(m.width).toBe(2048);
  const { data } = await sharp(r.path).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  expect(data[3]).toBe(0); // corner is still transparent
});

test('WebP and CMYK JPEG are converted to sRGB JPEG', async () => {
  const webp = f('a.webp');
  await sharp({ create: { width: 300, height: 300, channels: 3, background: '#00ff00' } }).webp().toFile(webp);
  const r1 = await prepareImage(webp, f('out7'));
  expect(r1.mimeType).toBe('image/jpeg');
  expect((await sharp(r1.path).metadata()).format).toBe('jpeg');

  const cmyk = f('cmyk.jpg');
  await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ff0000' } }).toColorspace('cmyk').jpeg().toFile(cmyk);
  expect((await sharp(cmyk).metadata()).space).toBe('cmyk');
  const r2 = await prepareImage(cmyk, f('out8'));
  expect(r2.action).toBe('transformed');
  expect((await sharp(r2.path).metadata()).space).toBe('srgb');
});

test('corrupt or non-image file fails cleanly', async () => {
  const bad = f('bad.jpg');
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg')]));
  await expect(prepareImage(bad, f('out9'))).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
  const txt = f('notes.txt');
  fs.writeFileSync(txt, 'hello');
  await expect(prepareImage(txt, f('out10'))).rejects.toMatchObject({ code: 'IMAGE_UNREADABLE' });
});
