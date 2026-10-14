#!/usr/bin/env node
/**
 * Before/after benchmark of server-side media preparation (no network, no Meta, no database).
 *   before = the previous rules: every image -> sharp JPEG q90; every video -> libx264 preset fast crf 28
 *   after  = services/media imagePrep / videoPrep (pass-through, remux, or transcode only when needed)
 * Usage: node scripts/bench-media-prep.js [runs=3]
 * Prints a JSON summary. Run it on the VPS itself for production-relevant numbers (CPU differs).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const sharp = require('sharp');
const { prepareImage } = require('../src/services/media/imagePrep');
const { prepareVideo } = require('../src/services/media/videoPrep');

const RUNS = Number(process.argv[2]) || 3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-media-'));
const f = (n) => path.join(dir, n);

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

async function makeSamples() {
  // Photo-like content (noise + gradient) so JPEG sizes are realistic.
  const photo = async (w, h, q, out) => {
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const n = ((x * 7919 + y * 104729) % 61) - 30;
      raw[i] = Math.max(0, Math.min(255, (x * 255) / w + n));
      raw[i + 1] = Math.max(0, Math.min(255, (y * 255) / h + n));
      raw[i + 2] = Math.max(0, Math.min(255, 128 + n * 2));
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: q }).toFile(out);
    return out;
  };
  const s = {};
  s.smallJpeg = await photo(1600, 1200, 85, f('small.jpg'));       // phone photo after image_picker q85
  s.largeJpeg = await photo(4000, 3000, 92, f('large.jpg'));       // camera original from web upload
  s.pngShot = f('shot.png');
  await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#f4f4f4' } })
    .composite([{ input: Buffer.from(`<svg width="1080" height="2400"><rect x="40" y="200" width="1000" height="300" fill="#2a7"/><text x="60" y="800" font-size="60">BJS order #1234</text></svg>`) }])
    .png().toFile(s.pngShot);
  s.h264 = f('phone_h264.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=15', '-f', 'lavfi', '-i', 'sine=duration=15',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', s.h264]);
  s.hevc = f('phone_hevc.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=duration=10',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-b:v', '5M', '-tag:v', 'hvc1', '-c:a', 'aac', s.hevc]);
  s.largeH264 = f('large_h264.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=45', '-f', 'lavfi', '-i', 'sine=duration=45',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '7M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', s.largeH264]);
  return s;
}

async function oldImage(src) {
  const t = Date.now();
  const out = await sharp(fs.readFileSync(src)).jpeg({ quality: 90 }).toBuffer();
  return { ms: Date.now() - t, bytes: out.length };
}

function oldVideo(src) {
  const out = f(`old_${Date.now()}.mp4`);
  const t = Date.now();
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { timeout: 600000 }, (err) => {
      if (err) return reject(err);
      const bytes = fs.statSync(out).size;
      fs.unlinkSync(out);
      resolve({ ms: Date.now() - t, bytes });
    });
  });
}

async function newPrep(kind, src) {
  const out = f(`new_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const t = Date.now();
  const r = kind === 'image' ? await prepareImage(src, out) : await prepareVideo(src, `${out}.mp4`);
  const res = { ms: Date.now() - t, bytes: r.size, action: r.action };
  if (r.path !== src) fs.unlinkSync(r.path);
  return res;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const s = await makeSamples();
  const cases = [
    ['small phone JPEG', 'image', s.smallJpeg],
    ['large camera JPEG', 'image', s.largeJpeg],
    ['PNG screenshot', 'image', s.pngShot],
    ['compatible H.264/AAC 1080p 15s', 'video', s.h264],
    ['HEVC 1080p 10s', 'video', s.hevc],
    ['large H.264 1080p 45s', 'video', s.largeH264],
  ];
  const results = [];
  for (const [name, kind, src] of cases) {
    const before = [];
    const after = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
      before.push(kind === 'image' ? await oldImage(src) : await oldVideo(src));
      last = await newPrep(kind, src);
      after.push(last);
    }
    results.push({
      case: name,
      inputBytes: fs.statSync(src).size,
      before: { medianMs: median(before.map((r) => r.ms)), outBytes: before[0].bytes },
      after: { medianMs: median(after.map((r) => r.ms)), outBytes: last.bytes, action: last.action },
    });
  }
  console.log(JSON.stringify({ host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, node: process.version }, runs: RUNS, results }, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
