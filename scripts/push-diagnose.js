/**
 * Diagnose "staff do not get notifications for customer messages".
 * READ-ONLY unless --test-user is given (then it sends ONE test notification to that staff member's
 * own phones, nothing to customers). Never prints tokens.
 *
 *   node scripts/push-diagnose.js                      # overview
 *   node scripts/push-diagnose.js --test-user 9800000000   # also send a test push to that staff phone
 *
 * Reading the result:
 *   - "Firebase NOT initialised"              -> FIREBASE_* variables in .env are missing/broken
 *   - staff with 0 phone tokens               -> their app never registered (or was logged out); open
 *                                                the app and log in again, then re-run
 *   - recent chats "assigned to X" + X has 0 tokens -> exactly the staff who get nothing
 *   - test push "failure" with a code         -> Firebase rejected it (code says why)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const { User, Chat, Notification } = require('../src/models');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const mask = (t) => (t ? `…${String(t).slice(-6)}` : '');

(async () => {
  await connectDB();
  const push = require('../src/services/push.service'); // initialises Firebase from .env
  const admin = require('firebase-admin');
  const firebaseReady = admin.apps.length > 0;
  console.log(`\nFirebase: ${firebaseReady ? 'initialised' : 'NOT initialised (check FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY in .env)'}`);

  const users = await User.find({ isActive: true }).select('name phone role fcmTokens isDnd updatedAt').lean();
  console.log('\nActive users and registered phones/browsers:');
  for (const u of users.sort((a, b) => a.role.localeCompare(b.role))) {
    const n = (u.fcmTokens || []).length;
    console.log(`  ${n ? 'OK  ' : 'NONE'}  ${u.role.padEnd(10)} ${String(u.name).padEnd(22)} tokens=${n} ${n ? `(${u.fcmTokens.map(mask).join(', ')})` : ''}${u.isDnd ? '  [DND ON: pushes skipped]' : ''}`);
  }

  const since = new Date(Date.now() - 24 * 3600e3);
  const recent = await Notification.aggregate([
    { $match: { createdAt: { $gte: since }, type: { $in: ['new_chat', 'unread_reminder'] } } },
    { $group: { _id: '$recipientId', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
  ]);
  console.log('\nMessage notifications created in the last 24 h (per recipient):');
  if (!recent.length) console.log('  none — the server did not create any (are customer messages arriving? is the webhook working?)');
  for (const r of recent) {
    const u = users.find((x) => String(x._id) === String(r._id));
    console.log(`  ${String(u?.name || r._id).padEnd(22)} ${r.count} notification(s), last ${r.last.toISOString()}${u && !(u.fcmTokens || []).length ? '  <-- no phone registered, push cannot reach them' : ''}`);
  }

  const chats = await Chat.find({ lastCustomerMessageAt: { $gte: since } }).select('assignedTo isDnd').populate('assignedTo', 'name fcmTokens').lean();
  const unassigned = chats.filter((c) => !c.assignedTo).length;
  const dnd = chats.filter((c) => c.isDnd).length;
  console.log(`\nChats with customer messages in 24 h: ${chats.length} (unassigned -> admins notified: ${unassigned}, chat DND on: ${dnd})`);

  const testPhone = opt('test-user');
  if (testPhone) {
    const u = users.find((x) => String(x.phone).replace(/\D/g, '').endsWith(String(testPhone).replace(/\D/g, '')));
    if (!u) { console.log(`\nTest: no active user with phone ${testPhone}`); }
    else if (!(u.fcmTokens || []).length) { console.log(`\nTest: ${u.name} has no registered phone — nothing to send to.`); }
    else {
      const recentChat = await Chat.findOne({ assignedTo: u._id }).sort({ lastMessageAt: -1 }).select('_id').lean();
      console.log(`\nTest: sending one test notification to ${u.name} (${u.fcmTokens.length} device(s))…`);
      await push.sendPushNotificationToUsers([String(u._id)], {
        title: 'BJS Connect test', body: 'If you can see this, notifications work on this phone.',
        data: { type: 'new_chat', chatId: String(recentChat?._id || 'test'), senderName: 'BJS Connect test' },
      });
      console.log('  sent — see "FCM Send results" above; check the phone.');
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('Diagnosis failed:', e.message); process.exit(1); });
