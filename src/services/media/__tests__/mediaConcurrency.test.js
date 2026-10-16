/**
 * The shared media task limit (default 5): configuration rules and the slot behaviour.
 * No database needed.
 */
const { Semaphore } = require('../semaphore');

function loadLimits(env) {
  const saved = { ...process.env };
  for (const k of ['MEDIA_MAX_CONCURRENT', 'MEDIA_JOB_CONCURRENCY', 'MEDIA_FFMPEG_CONCURRENCY', 'MEDIA_IMAGE_CONCURRENCY', 'MEDIA_META_UPLOAD_CONCURRENCY']) delete process.env[k];
  Object.assign(process.env, env);
  let mod;
  jest.isolateModules(() => { mod = require('../limits'); });
  process.env = saved;
  return mod.CONCURRENCY;
}

describe('configuration', () => {
  test('default limit is 5 and nothing is above it', () => {
    const c = loadLimits({});
    expect(c.tasks).toBe(5);
    expect(c.jobs).toBe(5);
    for (const k of ['ffmpeg', 'image', 'metaUpload']) {
      expect(c[k]).toBeGreaterThanOrEqual(1);
      expect(c[k]).toBeLessThanOrEqual(5);
    }
  });

  test('MEDIA_MAX_CONCURRENT changes the master limit; per-resource settings are clamped to it', () => {
    const c = loadLimits({ MEDIA_MAX_CONCURRENT: '3', MEDIA_IMAGE_CONCURRENCY: '9', MEDIA_META_UPLOAD_CONCURRENCY: '8', MEDIA_FFMPEG_CONCURRENCY: '7' });
    expect(c).toMatchObject({ tasks: 3, jobs: 3, image: 3, metaUpload: 3, ffmpeg: 3 });
  });

  test('the old MEDIA_JOB_CONCURRENCY name still works; garbage falls back to the default', () => {
    expect(loadLimits({ MEDIA_JOB_CONCURRENCY: '2' }).tasks).toBe(2);
    expect(loadLimits({ MEDIA_MAX_CONCURRENT: 'abc' }).tasks).toBe(5);
    expect(loadLimits({ MEDIA_MAX_CONCURRENT: '0' }).tasks).toBe(5);
  });

  test('per-resource settings can narrow the limit', () => {
    const c = loadLimits({ MEDIA_IMAGE_CONCURRENCY: '1', MEDIA_META_UPLOAD_CONCURRENCY: '2' });
    expect(c).toMatchObject({ tasks: 5, image: 1, metaUpload: 2 });
  });
});

describe('the media task slots', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('30 mixed tasks: never more than 5 at once, 5 are reached, the rest start in arrival order', async () => {
    const slots = new Semaphore(5, 'mediaTask');
    let active = 0;
    let max = 0;
    const started = [];
    const kinds = ['image', 'video', 'audio', 'voice', 'document'];
    await Promise.all(Array.from({ length: 30 }, (_, i) => slots.run(async () => {
      started.push(i);
      active += 1;
      max = Math.max(max, active);
      await sleep(5 + ((i * 7) % 20)); // different durations per kind
      active -= 1;
      return kinds[i % kinds.length];
    })));
    expect(max).toBe(5);
    expect(started).toEqual([...Array(30).keys()]);
    expect(slots.active).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  test('failed tasks free their slot and do not block the queue', async () => {
    const slots = new Semaphore(5, 'mediaTask');
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => slots.run(async () => {
      await sleep(3);
      if (i % 3 === 0) throw new Error(`boom ${i}`);
      return i;
    })));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(13);
    expect(slots.active).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  test('synchronous throws are released too', async () => {
    const slots = new Semaphore(2, 'mediaTask');
    await expect(slots.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(slots.active).toBe(0);
  });
});
