'use strict';

/**
 * "New version available" announcement for the Android app.
 *
 * Every 5 minutes (Agenda job 'app-update:announce') the update manifest that the app itself reads
 * (APP_UPDATE_MANIFEST_URL, default https://cdn.biswakarmagold.com/update/version.json) is fetched.
 * When its versionCode is higher than any version seen before, one data push is sent to the FCM topic
 * 'bjs_app_updates': { type: 'app_update', versionCode, versionName, mandatory, message }.
 * The phones show "BJS Connect update available - tap to download and install" (AppUpdateNotifications.kt);
 * a phone that already has that version shows nothing.
 *
 *  - First run after deploy: the current version is only recorded (baseline), nobody is notified.
 *  - Each version is announced once (unique versionCode; safe with several server processes).
 *  - A failed send is retried on the next runs (up to 5 attempts).
 *  - A lower versionCode (rollback) is never announced.
 *  - APP_UPDATE_ANNOUNCE=false turns this off.
 */
const axios = require('axios');
const { logger } = require('../../utils/logger');

const TOPIC = 'bjs_app_updates';
const DEFAULT_MANIFEST_URL = 'https://cdn.biswakarmagold.com/update/version.json';
const MAX_ATTEMPTS = 5;

function manifestUrl() {
  return process.env.APP_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

function enabled() {
  return String(process.env.APP_UPDATE_ANNOUNCE || 'true').toLowerCase() !== 'false';
}

/** Reads the fields we need; throws when the manifest is not usable. */
function parseManifest(json) {
  if (!json || typeof json !== 'object') throw new Error('manifest is not a JSON object');
  const versionCode = Number(json.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error('manifest has no valid versionCode');
  return {
    versionCode,
    versionName: typeof json.versionName === 'string' ? json.versionName.slice(0, 40) : '',
    mandatory: json.mandatory === true,
    message: typeof json.message === 'string' ? json.message.slice(0, 300) : '',
  };
}

async function fetchManifest(url = manifestUrl()) {
  const res = await axios.get(url, {
    params: { t: Date.now() }, // never an old cached copy
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', Accept: 'application/json' },
    timeout: 10000,
    maxContentLength: 64 * 1024,
    responseType: 'json',
  });
  return parseManifest(typeof res.data === 'string' ? JSON.parse(res.data) : res.data);
}

function defaultSend(release) {
  const { sendDataToTopic } = require('../push.service');
  return sendDataToTopic(TOPIC, {
    type: 'app_update',
    versionCode: release.versionCode,
    versionName: release.versionName,
    mandatory: release.mandatory ? 'true' : 'false',
    message: release.message,
  });
}

/**
 * One check. Returns { action, versionCode } where action is one of
 * 'disabled' | 'baseline' | 'known' | 'older' | 'announced' | 'send-failed' | 'gave-up' | 'not-sent'.
 * `force` re-announces the current version (manual script).
 */
async function checkAndAnnounce({ fetch = fetchManifest, send = defaultSend, force = false } = {}) {
  if (!enabled() && !force) return { action: 'disabled' };
  const { AppRelease } = require('../../models');
  const m = await fetch();

  const newest = await AppRelease.findOne({}).sort({ versionCode: -1 }).lean();
  if (!newest && !force) {
    try {
      await AppRelease.create({ ...m, baseline: true });
      logger.info(`[app-update] baseline recorded: version ${m.versionName || ''} (${m.versionCode}); not announced`);
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    return { action: 'baseline', versionCode: m.versionCode };
  }

  let doc = await AppRelease.findOne({ versionCode: m.versionCode });
  if (!doc) {
    if (newest && m.versionCode < newest.versionCode && !force) {
      return { action: 'older', versionCode: m.versionCode };
    }
    try {
      doc = await AppRelease.create({ ...m });
    } catch (e) {
      if (e.code !== 11000) throw e;
      return { action: 'known', versionCode: m.versionCode }; // another process took it
    }
  } else if (!force) {
    if (doc.baseline || doc.announcedAt) return { action: 'known', versionCode: m.versionCode };
    if (doc.attempts >= MAX_ATTEMPTS) return { action: 'gave-up', versionCode: m.versionCode };
  }

  // Claim this attempt (only one process sends).
  const claimFilter = force ? { _id: doc._id } : { _id: doc._id, announcedAt: null, attempts: doc.attempts };
  const claimed = await AppRelease.findOneAndUpdate(
    claimFilter,
    { $inc: { attempts: 1 }, $set: { versionName: m.versionName, mandatory: m.mandatory, message: m.message } },
    { returnDocument: 'after' }
  );
  if (!claimed) return { action: 'known', versionCode: m.versionCode };

  try {
    const id = await send(m);
    if (!id) {
      // Firebase not configured on this server: nothing was sent; try again later.
      await AppRelease.updateOne({ _id: doc._id }, { $set: { lastError: 'FCM not configured' }, $inc: { attempts: -1 } });
      return { action: 'not-sent', versionCode: m.versionCode };
    }
    await AppRelease.updateOne({ _id: doc._id }, { $set: { announcedAt: new Date(), fcmMessageId: String(id), lastError: '' } });
    logger.info(`[app-update] announced version ${m.versionName || ''} (${m.versionCode}) to topic ${TOPIC}`);
    return { action: 'announced', versionCode: m.versionCode, messageId: String(id) };
  } catch (e) {
    await AppRelease.updateOne({ _id: doc._id }, { $set: { lastError: String(e.message || e).slice(0, 300) } });
    logger.error(`[app-update] announcing ${m.versionCode} failed: ${e.message}`);
    return { action: 'send-failed', versionCode: m.versionCode, error: e.message };
  }
}

function defineJobs(agenda) {
  agenda.define('app-update:announce', { lockLifetime: 60 * 1000 }, async () => {
    try {
      await checkAndAnnounce();
    } catch (e) {
      // Manifest unreachable or invalid: try again on the next run.
      logger.warn(`[app-update] check failed: ${e.message}`);
    }
  });
}

module.exports = { checkAndAnnounce, fetchManifest, parseManifest, defineJobs, TOPIC, MAX_ATTEMPTS };
