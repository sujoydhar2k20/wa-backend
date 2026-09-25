/**
 * READ-ONLY pre-deployment check for the "OTP is mandatory for everyone" change.
 *
 * Lists active users who will NOT be able to log in because their stored phone is not a
 * deliverable Indian mobile number (10 digits, or 12 digits starting with 91).
 * Also lists active superadmins so you can confirm at least one can still log in.
 *
 * Usage: node scripts/audit-login-phones.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { connectDB } = require('../src/config/database');

const isIndian = (p) => /^\d{10}$/.test(p) || /^91\d{10}$/.test(p);

(async () => {
  await connectDB();
  const users = await User.find({ isActive: true }).select('phone role name').lean();
  const blocked = users.filter((u) => !isIndian(String(u.phone || '')));
  const superadmins = users.filter((u) => u.role === 'superadmin');

  console.log(`Active users: ${users.length}`);
  console.log(`\nActive superadmins (${superadmins.length}):`);
  superadmins.forEach((u) => console.log(`  ${isIndian(u.phone) ? 'OK     ' : 'BLOCKED'} ${u.phone}  ${u.name || ''}`));
  console.log(`\nUsers who CANNOT receive an OTP (${blocked.length}):`);
  blocked.forEach((u) => console.log(`  ${u.role.padEnd(10)} ${u.phone}  ${u.name || ''}`));
  if (blocked.length) {
    console.log('\nFix: update the phone to a real Indian mobile (admin UI), or create a replacement with');
    console.log('  node scripts/create-superadmin.js +91XXXXXXXXXX "Name"');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
