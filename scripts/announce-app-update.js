#!/usr/bin/env node
/**
 * Check the Android update manifest now and announce a new version to the phones
 * (same as the 5-minute job 'app-update:announce'; see src/services/appUpdate/announcer.js).
 *
 *   node scripts/announce-app-update.js           announce if version.json has a version not seen before
 *   node scripts/announce-app-update.js --status  only show what was recorded / announced
 *   node scripts/announce-app-update.js --force   send the notification for the current version again
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const args = process.argv.slice(2);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system');
  const { AppRelease } = require('../src/models');
  const announcer = require('../src/services/appUpdate/announcer');
  try {
    const m = await announcer.fetchManifest();
    console.log(`version.json: ${m.versionName} (${m.versionCode})${m.mandatory ? ' [required]' : ''}`);
    if (!args.includes('--status')) {
      const r = await announcer.checkAndAnnounce({ force: args.includes('--force') });
      console.log('result:', r);
    }
    const rows = await AppRelease.find({}).sort({ versionCode: -1 }).limit(10).lean();
    console.table(rows.map((r) => ({
      versionCode: r.versionCode,
      versionName: r.versionName,
      baseline: r.baseline,
      announcedAt: r.announcedAt ? r.announcedAt.toISOString() : '',
      attempts: r.attempts,
      lastError: r.lastError,
    })));
  } finally {
    await mongoose.disconnect();
    // firebase-admin keeps the process alive
    setTimeout(() => process.exit(0), 200).unref();
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
