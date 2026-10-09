/**
 * Safe, idempotent subscription helper for BJS Connect app on target WABAs.
 *
 * What this script does:
 * - Verifies app-level webhook fields for whatsapp_business_account include `calls`.
 * - For each target WABA, checks /{WABA_ID}/subscribed_apps for the target app.
 * - If app is missing OR `calls` is not present in subscribed_fields, POSTs /{WABA_ID}/subscribed_apps.
 * - Re-reads /{WABA_ID}/subscribed_apps and prints exact API response slices for verification.
 *
 * Safety guarantees:
 * - No access tokens are logged.
 * - No unsubscribe operations.
 * - No callback URL / verify token mutation.
 * - Idempotent: if already correct, does nothing.
 *
 * Usage:
 *   node scripts/subscribe-bjs-connect-calls.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const Waba = require('../src/models/Waba');
const config = require('../src/config');

const API_VERSION = config.meta.apiVersion || 'v25.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const TARGET_WABA_IDS = [
  '1598866321335111', // Baba New 9804
  '1002721328785441', // Biswakarma Jewellery Shilpalaya
];

function normalizeFieldNames(fields) {
  if (!Array.isArray(fields)) return [];
  return fields
    .map((f) => (typeof f === 'string' ? f : f?.name))
    .filter(Boolean)
    .map((s) => String(s));
}

async function graphGet(path, token, params = {}) {
  const res = await axios.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 20000,
  });
  return res.data;
}

async function graphPost(path, token, body = {}) {
  const res = await axios.post(`${BASE}${path}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
  return res.data;
}

function summarizeSubscribedAppsRows(rows) {
  return (rows || []).map((a) => ({
    app_id: a?.whatsapp_business_api_data?.id || a?.id || null,
    app_name: a?.whatsapp_business_api_data?.name || null,
    subscribed_fields: a?.subscribed_fields || [],
    normalized_subscribed_fields: normalizeFieldNames(a?.subscribed_fields || []),
  }));
}

(async () => {
  await connectDB();

  const appId = process.env.META_APP_ID || config.meta.appId;
  const appSecret = process.env.META_APP_SECRET || config.meta.appSecret;

  if (!appId) {
    throw new Error('META_APP_ID is required');
  }

  console.log(`\n=== App-level webhook check (${appId})`);
  if (!appSecret) {
    console.log('WARN: META_APP_SECRET missing; skipping app-level /subscriptions verification.');
  } else {
    const appToken = `${appId}|${appSecret}`;
    const appSubs = await graphGet(`/${appId}/subscriptions`, appToken);
    const entries = Array.isArray(appSubs?.data) ? appSubs.data : [];
    const wabaObj = entries.find((s) => s.object === 'whatsapp_business_account');
    const rawFields = wabaObj?.fields || [];
    const names = normalizeFieldNames(rawFields);
    console.log('app subscriptions raw fields:', JSON.stringify(rawFields));
    console.log('app subscriptions normalized fields:', JSON.stringify(names));
    if (!names.includes('calls')) {
      console.log('BLOCKER: app-level webhook fields still missing calls. Not safe to proceed.');
      await mongoose.disconnect();
      process.exit(2);
    }
    console.log('OK: app-level webhook fields include calls.');
  }

  for (const wabaId of TARGET_WABA_IDS) {
    console.log(`\n=== WABA ${wabaId}`);

    const waba = await Waba.findOne({ wabaId });
    if (!waba) {
      console.log('BLOCKER: WABA not found in DB. Skipping.');
      continue;
    }
    if (!waba.accessToken) {
      console.log('BLOCKER: WABA access token missing in DB. Skipping.');
      continue;
    }

    let before;
    try {
      before = await graphGet(`/${wabaId}/subscribed_apps`, waba.accessToken);
    } catch (e) {
      console.log('BLOCKER: cannot read subscribed_apps before:', JSON.stringify(e.response?.data || e.message));
      continue;
    }

    const beforeRows = Array.isArray(before?.data) ? before.data : [];
    const beforeSummary = summarizeSubscribedAppsRows(beforeRows);
    console.log('before subscribed_apps:', JSON.stringify(beforeSummary));

    const appEntryBefore = beforeRows.find((a) => String(a?.whatsapp_business_api_data?.id || a?.id || '') === String(appId));
    const needsSubscribe = !appEntryBefore || !normalizeFieldNames(appEntryBefore?.subscribed_fields || []).includes('calls');

    if (!needsSubscribe) {
      console.log('OK: app already subscribed with calls field. No POST needed.');
    } else {
      console.log('Action: POST /subscribed_apps (idempotent subscribe/refresh).');
      try {
        const postRes = await graphPost(`/${wabaId}/subscribed_apps`, waba.accessToken, {});
        console.log('POST response:', JSON.stringify(postRes));
      } catch (e) {
        console.log('ERROR: subscribe POST failed:', JSON.stringify(e.response?.data || e.message));
      }
    }

    let after;
    try {
      after = await graphGet(`/${wabaId}/subscribed_apps`, waba.accessToken);
    } catch (e) {
      console.log('ERROR: cannot read subscribed_apps after:', JSON.stringify(e.response?.data || e.message));
      continue;
    }

    const afterRows = Array.isArray(after?.data) ? after.data : [];
    const afterSummary = summarizeSubscribedAppsRows(afterRows);
    console.log('after subscribed_apps:', JSON.stringify(afterSummary));

    const appEntryAfter = afterRows.find((a) => String(a?.whatsapp_business_api_data?.id || a?.id || '') === String(appId));
    const hasCallsAfter = normalizeFieldNames(appEntryAfter?.subscribed_fields || []).includes('calls');
    if (!appEntryAfter) {
      console.log('BLOCKER: app is still not subscribed to WABA after POST.');
    } else if (!hasCallsAfter) {
      console.log('BLOCKER: app subscribed but calls still absent in subscribed_fields after POST.');
    } else {
      console.log('OK: WABA now shows app subscribed with calls field.');
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  await mongoose.disconnect();
  process.exit(1);
});
