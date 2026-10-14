/**
 * Video preparation: ffprobe decides passthrough / remux (stream copy) / audio-only / transcode.
 * Real ffmpeg + ffprobe, generated test clips.
 */
jest.setTimeout(180000);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { prepareVideo, probe, decide, budgetKbps } = require('../videoPrep');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidprep-'));
const f = (name) => path.join(dir, name);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function make(name, { size = '640x360', secs = 2, vcodec = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], audio = ['-c:a', 'aac'], extra = [], fmt } = {}) {
  const out = f(name);
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${secs}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`);
  args.push(...vcodec);
  if (audio) args.push(...audio); else args.push('-an');
  args.push(...extra);
  if (fmt) args.push('-f', fmt);
  args.push(out);
  execFileSync('ffmpeg', args);
  return out;
}

test('compatible H.264/AAC MP4 is sent as-is (no ffmpeg run, same file)', async () => {
  const src = make('ok.mp4');
  const r = await prepareVideo(src, f('o1.mp4'));
  expect(r.action).toBe('passthrough');
  expect(r.path).toBe(src);
  expect(r.convertMs).toBe(0);
  expect(fs.existsSync(f('o1.mp4'))).toBe(false);
});

test('compatible video without audio is sent as-is', async () => {
  const src = make('noaudio.mp4', { audio: null });
  const r = await prepareVideo(src, f('o2.mp4'));
  expect(r.action).toBe('passthrough');
});

test('QuickTime (.mov) with H.264/AAC is remuxed by stream copy, not re-encoded', async () => {
  const src = make('clip.mov', { size: '1280x720', fmt: 'mov' });
  const before = await probe(src);
  const r = await prepareVideo(src, f('o3.mp4'));
  expect(r.action).toBe('remux');
  expect(r.reasons.join()).toMatch(/container/);
  const after = await probe(r.path);
  expect(after.video.codec).toBe('h264');
  // stream copy keeps the resolution (a transcode would cap it to 720 short edge anyway, so also check bitrate-free signature)
  expect([after.video.width, after.video.height]).toEqual([before.video.width, before.video.height]);
  expect(Math.abs(after.duration - before.duration)).toBeLessThan(0.2);
});

test('HEVC video is transcoded to H.264 yuv420p, short edge <= 720, aspect kept', async () => {
  const src = make('hevc.mp4', { size: '1920x1080', vcodec: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'] });
  const r = await prepareVideo(src, f('o4.mp4'));
  expect(r.action).toBe('transcode');
  const out = await probe(r.path);
  expect(out.video.codec).toBe('h264');
  expect(out.video.pixFmt).toBe('yuv420p');
  expect(Math.min(out.video.width, out.video.height)).toBe(720);
  expect(out.video.width / out.video.height).toBeCloseTo(16 / 9, 1);
  expect(out.audio[0].codec).toBe('aac');
  expect(r.size).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test('portrait VP9/WebM (no audio) is transcoded keeping portrait orientation', async () => {
  const src = make('portrait.webm', { size: '720x1280', audio: null, vcodec: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'] });
  const r = await prepareVideo(src, f('o5.mp4'));
  expect(r.action).toBe('transcode');
  const out = await probe(r.path);
  expect(out.video.width).toBe(720);
  expect(out.video.height).toBe(1280);
  expect(out.audio).toHaveLength(0);
});

test('H.264 with MP3 audio: video copied, only audio re-encoded', async () => {
  const src = make('mp3audio.mp4', { size: '1280x720', audio: ['-c:a', 'libmp3lame'] });
  const r = await prepareVideo(src, f('o6.mp4'));
  expect(r.action).toBe('audio');
  const out = await probe(r.path);
  expect([out.video.width, out.video.height]).toEqual([1280, 720]); // not scaled -> not re-encoded
  expect(out.audio[0].codec).toBe('aac');
});

test('corrupt video fails with a useful error', async () => {
  const bad = f('bad.mp4');
  fs.writeFileSync(bad, Buffer.from('00000020667479706d703432garbagegarbage', 'hex'));
  await expect(prepareVideo(bad, f('o7.mp4'))).rejects.toMatchObject({ code: 'VIDEO_UNREADABLE' });
  const audioOnly = f('tone.m4a');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'aac', audioOnly]);
  await expect(prepareVideo(audioOnly, f('o8.mp4'))).rejects.toMatchObject({ code: 'VIDEO_NO_STREAM' });
});

describe('decide()', () => {
  const ok = { video: { codec: 'h264', pixFmt: 'yuv420p', profile: 'High' }, videoCount: 1, audio: [{ codec: 'aac' }], otherCount: 0 };
  test('over 16 MB -> transcode even when codecs are fine', () => {
    expect(decide({ info: ok, sniffed: 'video/mp4', size: 17 * 1024 * 1024 }).action).toBe('transcode');
  });
  test('10-bit H.264 -> transcode', () => {
    expect(decide({ info: { ...ok, video: { ...ok.video, pixFmt: 'yuv420p10le', profile: 'High 10' } }, sniffed: 'video/mp4', size: 1e6 }).action).toBe('transcode');
  });
  test('extra data stream / second audio / 3GP -> remux', () => {
    expect(decide({ info: { ...ok, otherCount: 1 }, sniffed: 'video/mp4', size: 1e6 }).action).toBe('remux');
    expect(decide({ info: { ...ok, audio: [{ codec: 'aac' }, { codec: 'aac' }] }, sniffed: 'video/mp4', size: 1e6 }).action).toBe('remux');
    expect(decide({ info: ok, sniffed: 'video/3gpp', size: 1e6 }).action).toBe('remux');
  });
  test('budget keeps a long video inside 16 MB', () => {
    const kbps = budgetKbps(180, true);
    expect(((kbps + 96) * 180) / 8 / 1024).toBeLessThan(16); // MB
    expect(budgetKbps(10, true)).toBe(2500);
  });
});
