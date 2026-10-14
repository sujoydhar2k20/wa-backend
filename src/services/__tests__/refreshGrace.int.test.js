/**
 * A phone that lost the refresh response retries with its previous refresh token. That must not end
 * the session (the app would log out and unsubscribe the phone from notifications).
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const db = require('../../testutils/memoryDb');
const { Session, User } = require('../../models');
const auth = require('../auth.service');

beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => { await db.clear(); });

async function login() {
  const user = await User.create({ name: 'Staff', phone: '9000000002', role: 'staff', isActive: true });
  await Session.create({ userId: user._id, refreshToken: 'rt-0', expiresAt: new Date(Date.now() + 864e5) });
  return user;
}

test('the previous refresh token works again within the grace period, then not', async () => {
  await login();
  const first = await auth.refresh('rt-0');
  expect(first.refreshToken).toBeTruthy();
  // response lost: phone retries with rt-0
  const retry = await auth.refresh('rt-0');
  expect(retry.accessToken).toBeTruthy();
  // after the grace period rt-0 is refused
  await Session.updateMany({}, { previousValidUntil: new Date(Date.now() - 1000) });
  await expect(auth.refresh('rt-0')).rejects.toMatchObject({ statusCode: 401 });
  // the newest token keeps working
  await expect(auth.refresh(retry.refreshToken)).resolves.toHaveProperty('accessToken');
});

test('an unknown refresh token is refused; a disabled account is refused', async () => {
  const user = await login();
  await expect(auth.refresh('nope')).rejects.toMatchObject({ statusCode: 401 });
  await User.updateOne({ _id: user._id }, { isActive: false });
  await expect(auth.refresh('rt-0')).rejects.toMatchObject({ statusCode: 403 });
});

test('logout with the previous token still ends the session', async () => {
  await login();
  await auth.refresh('rt-0');
  await auth.logout(undefined, 'rt-0');
  expect(await Session.countDocuments()).toBe(0);
});
