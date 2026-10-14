jest.setTimeout(60000);
const db = require('../../../testutils/memoryDb');
const announcer = require('../announcer');

let manifest;
const fetch = async () => announcer.parseManifest(manifest);
let sent;
let sendImpl;
const send = async (m) => { sent.push(m); return sendImpl(m); };

beforeAll(async () => {
  require('../../../models');
  await db.start();
});
afterAll(() => db.stop());
beforeEach(async () => {
  await db.clear();
  sent = [];
  sendImpl = async () => 'projects/x/messages/1';
  manifest = { versionCode: 10, versionName: '1.0.10', mandatory: false, message: 'Faster media' };
  delete process.env.APP_UPDATE_ANNOUNCE;
});

test('first run records a baseline and notifies nobody', async () => {
  const r = await announcer.checkAndAnnounce({ fetch, send });
  expect(r.action).toBe('baseline');
  expect(sent).toHaveLength(0);
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('known');
  expect(sent).toHaveLength(0);
});

test('a new version is announced exactly once', async () => {
  await announcer.checkAndAnnounce({ fetch, send });
  manifest = { ...manifest, versionCode: 11, versionName: '1.0.11', mandatory: true };
  const r = await announcer.checkAndAnnounce({ fetch, send });
  expect(r.action).toBe('announced');
  expect(sent).toEqual([{ versionCode: 11, versionName: '1.0.11', mandatory: true, message: 'Faster media' }]);
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('known');
  expect(sent).toHaveLength(1);
});

test('two processes at once send one notification', async () => {
  await announcer.checkAndAnnounce({ fetch, send });
  manifest = { ...manifest, versionCode: 12 };
  const results = await Promise.all([1, 2, 3].map(() => announcer.checkAndAnnounce({ fetch, send })));
  expect(results.filter((r) => r.action === 'announced')).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

test('a failed send is retried on the next run, then given up after the limit', async () => {
  await announcer.checkAndAnnounce({ fetch, send });
  manifest = { ...manifest, versionCode: 13 };
  sendImpl = async () => { throw new Error('FCM unavailable'); };
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('send-failed');
  sendImpl = async () => 'id-2';
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('announced');

  manifest = { ...manifest, versionCode: 14 };
  sendImpl = async () => { throw new Error('down'); };
  for (let i = 0; i < announcer.MAX_ATTEMPTS; i++) await announcer.checkAndAnnounce({ fetch, send });
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('gave-up');
});

test('Firebase not configured: nothing counted as sent, tried again later', async () => {
  await announcer.checkAndAnnounce({ fetch, send });
  manifest = { ...manifest, versionCode: 15 };
  sendImpl = async () => null;
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('not-sent');
  sendImpl = async () => 'id';
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('announced');
});

test('a rollback to an older version is not announced', async () => {
  await announcer.checkAndAnnounce({ fetch, send });
  manifest = { ...manifest, versionCode: 9 };
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('older');
  expect(sent).toHaveLength(0);
});

test('APP_UPDATE_ANNOUNCE=false turns it off; --force re-sends the current version', async () => {
  process.env.APP_UPDATE_ANNOUNCE = 'false';
  expect((await announcer.checkAndAnnounce({ fetch, send })).action).toBe('disabled');
  delete process.env.APP_UPDATE_ANNOUNCE;
  await announcer.checkAndAnnounce({ fetch, send }); // baseline
  expect((await announcer.checkAndAnnounce({ fetch, send, force: true })).action).toBe('announced');
  expect(sent).toHaveLength(1);
});

test('invalid manifests are rejected', () => {
  expect(() => announcer.parseManifest(null)).toThrow();
  expect(() => announcer.parseManifest({ versionCode: 'abc' })).toThrow();
  expect(() => announcer.parseManifest({ versionCode: -1 })).toThrow();
  expect(announcer.parseManifest({ versionCode: 3 })).toEqual({ versionCode: 3, versionName: '', mandatory: false, message: '' });
});

test('sendDataToTopic sends a high-priority data message with string values', async () => {
  jest.isolateModules(() => {
    const send = jest.fn(async () => 'mid');
    jest.doMock('firebase-admin', () => ({
      initializeApp: jest.fn(),
      credential: { cert: jest.fn(() => ({})) },
      messaging: () => ({ send }),
    }));
    process.env.FIREBASE_PROJECT_ID = 'p';
    process.env.FIREBASE_CLIENT_EMAIL = 'e@x';
    process.env.FIREBASE_PRIVATE_KEY = 'k';
    const push = require('../../push.service');
    return push.sendDataToTopic('bjs_app_updates', { type: 'app_update', versionCode: 11, mandatory: false }).then((id) => {
      expect(id).toBe('mid');
      expect(send).toHaveBeenCalledWith({
        topic: 'bjs_app_updates',
        data: { type: 'app_update', versionCode: '11', mandatory: 'false' },
        android: { priority: 'high', ttl: 3 * 24 * 3600 * 1000 },
      });
    });
  });
});
