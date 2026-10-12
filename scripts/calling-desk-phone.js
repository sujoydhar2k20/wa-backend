/**
 * Linphone / desk-phone calling account for one user (TLS + SDES, account name u<userId>-desk).
 *
 *   node scripts/calling-desk-phone.js on   --phone <user's login phone>   enable + show login details
 *   node scripts/calling-desk-phone.js show --phone <user's login phone>   show login details again
 *   node scripts/calling-desk-phone.js off  --phone <user's login phone>   remove the desk account
 *
 * The password is shown once on this server's terminal. Do not paste it into chat or commit it.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const sip = require('../src/services/calls/sipAccounts');
const callingConfig = require('../src/services/calls/config');
const { connectDB } = require('../src/config/database');

const args = process.argv.slice(2);
const cmd = args[0];
const phone = args[args.indexOf('--phone') + 1];

(async () => {
  if (!['on', 'off', 'show'].includes(cmd) || !phone || args.indexOf('--phone') < 0) {
    console.error('usage: node scripts/calling-desk-phone.js on|show|off --phone <user login phone>');
    process.exit(1);
  }
  if (!callingConfig.get().enabled) { console.error('CALLING_ENABLED is not true in .env'); process.exit(1); }
  await connectDB();
  const user = await User.findOne({ phone });
  if (!user) { console.error(`no user with phone ${phone}`); process.exit(1); }
  if (cmd !== 'show') {
    await User.updateOne({ _id: user._id }, { $set: { 'sip.deskPhone': cmd === 'on' } });
    const r = await sip.syncNow();
    console.log(`desk account ${cmd === 'on' ? 'enabled' : 'removed'} for ${user.name} (${r.users} calling users, Asterisk ${r.changed ? 'reloaded' : 'unchanged'})`);
  }
  if (cmd !== 'off') {
    const c = await sip.getCredentials(user._id);
    const cfg = callingConfig.get();
    console.log(`\nLinphone for ${user.name}:\n  username : ${c.username}-desk\n  password : ${c.password}\n  domain   : ${cfg.sipDomain}\n  server   : sip:${cfg.sipDomain};transport=tls  (TLS, ICE off, SRTP-SDES mandatory)`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
