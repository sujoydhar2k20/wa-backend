const mongoose = require('mongoose');

/**
 * Android app versions seen in the update manifest (version.json), so each new version is announced
 * to the phones once ("new version available" notification). See services/appUpdate/announcer.js.
 */
const appReleaseSchema = new mongoose.Schema(
  {
    versionCode: { type: Number, required: true, unique: true },
    versionName: { type: String, default: '' },
    mandatory: { type: Boolean, default: false },
    message: { type: String, default: '' },
    // First version seen after this feature was deployed: recorded, never announced.
    baseline: { type: Boolean, default: false },
    announcedAt: { type: Date, default: null },
    fcmMessageId: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppRelease', appReleaseSchema);
