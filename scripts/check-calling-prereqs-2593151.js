/**
 * Diagnose Meta WhatsApp Calling prerequisite failures (error 2593151).
 *
 * Checks:
 * 1) App-level webhook subscription fields on whatsapp_business_account object (must include `calls`).
 * 2) WABA-level app subscription via /{wabaId}/subscribed_apps (membership only).
 * 3) Per phone number calling blockers: coexistence mode, low tier, calling settings.
 *
 * Usage:
 *   node scripts/check-calling-prereqs-2593151.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const Waba = require('../src/models/Waba');
const config = require('../src/config');

const API_VERSION = config.meta.apiVersion || 'v25.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const DEFAULT_WABA_IDS = ['1598866321335111', '1002721328785441'];

async function getWithToken(path, token, params = {}) {
  try {
    const r = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 20000,
    });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message };
  }
}

function hasCallsFieldOnAppSubscriptions(subscriptionsData) {
  const list = Array.isArray(subscriptionsData?.data) ? subscriptionsData.data : [];
  const wabaObj = list.find((s) => s.object === 'whatsapp_business_account');
  const rawFields = wabaObj?.fields || [];
  const names = rawFields
    .map((f) => (typeof f === 'string' ? f : f?.name))
    .filter(Boolean)
    .map((s) => String(s));
  return { hasCalls: names.includes('calls'), fields: rawFields, names };
}

(async () => {
  await connectDB();

  const appId = process.env.META_APP_ID || config.meta.appId;
  const appSecret = process.env.META_APP_SECRET || config.meta.appSecret;

  console.log(`\n=== Global App Check (${appId || 'NO_APP_ID'})`);
  if (!appId || !appSecret) {
    console.log('BLOCKER: META_APP_ID / META_APP_SECRET missing in env; cannot verify app webhook fields.');
  } else {
    const appToken = `${appId}|${appSecret}`;
    const appSubs = await getWithToken(`/${appId}/subscriptions`, appToken);
    if (!appSubs.ok) {
      console.log('BLOCKER: cannot read app subscriptions:', JSON.stringify(appSubs.error));
    } else {
      const { hasCalls, fields, names } = hasCallsFieldOnAppSubscriptions(appSubs.data);
      console.log('whatsapp_business_account subscribed fields:', JSON.stringify(fields));
      console.log('normalized field names:', JSON.stringify(names));
      if (!hasCalls) {
        console.log('BLOCKER: app webhook fields do NOT include `calls`.');
      } else {
        console.log('OK: app webhook fields include `calls`.');
      }
    }
  }

  const argIds = process.argv.slice(2).filter(Boolean);
  const targetIds = argIds.length ? argIds : DEFAULT_WABA_IDS;

  let wabas = [];
  if (targetIds.length) {
    wabas = await Waba.find({ wabaId: { $in: targetIds } });
  }
  if (!wabas.length) {
    wabas = await Waba.find({ isActive: { $ne: false } });
  }
  if (!wabas.length) {
    console.log('\nNo active WABAs found in DB.');
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const w of wabas) {
    console.log(`\n=== WABA ${w.wabaId} (${w.businessName || 'unnamed'})`);
    const token = w.accessToken;
    if (!token) {
      console.log('BLOCKER: missing access token on WABA record.');
      continue;
    }

    const subs = await getWithToken(`/${w.wabaId}/subscribed_apps`, token);
    if (!subs.ok) {
      console.log('BLOCKER: cannot read subscribed_apps:', JSON.stringify(subs.error));
    } else {
      const data = Array.isArray(subs.data?.data) ? subs.data.data : [];
      console.log('subscribed_apps:', JSON.stringify(data.map((a) => ({
        app_id: a?.whatsapp_business_api_data?.id || a?.id,
        app_name: a?.whatsapp_business_api_data?.name || null,
        subscribed_fields: a?.subscribed_fields || [],
      }))));

      const appEntry = data.find((a) => {
        const id = a?.whatsapp_business_api_data?.id || a?.id;
        return appId ? String(id) === String(appId) : true;
      });

      if (!appEntry) {
        console.log('BLOCKER: this app is not subscribed to the WABA.');
      } else {
        // For WABA /subscribed_apps, app presence is the signal. Webhook fields (including `calls`)
        // are configured at app-level /{app-id}/subscriptions.
        const rawSubFields = appEntry?.subscribed_fields || [];
        console.log('WABA app entry found for app_id:', String(appEntry?.whatsapp_business_api_data?.id || appEntry?.id || 'unknown'));
        console.log('WABA app entry subscribed_fields (informational):', JSON.stringify(rawSubFields));
        console.log('OK: app is subscribed to WABA (membership verified).');
      }
    }

    for (const p of w.phoneNumbers || []) {
      console.log(`\n  --- phone ${p.phoneNumber} (${p.phoneNumberId})`);

      const numInfo = await getWithToken(`/${p.phoneNumberId}`, token, {
        fields: 'display_phone_number,platform_type,is_on_biz_app,messaging_limit_tier,status,quality_rating',
      });
      if (!numInfo.ok) {
        console.log('  BLOCKER: cannot read number info:', JSON.stringify(numInfo.error));
        continue;
      }

      const info = numInfo.data;
      console.log('  info:', JSON.stringify(info));

      if (info.is_on_biz_app === true) {
        console.log('  BLOCKER: coexistence number (WhatsApp Business app + API). Calling unsupported.');
      }

      const tier = String(info.messaging_limit_tier || '');
      if (/TIER_(50|250)$/i.test(tier)) {
        console.log(`  BLOCKER: messaging limit tier too low for calling (${tier}).`);
      }

      const settings = await getWithToken(`/${p.phoneNumberId}/settings`, token);
      if (!settings.ok) {
        console.log('  WARN: cannot read calling settings:', JSON.stringify(settings.error));
      } else {
        console.log('  calling settings:', JSON.stringify(settings.data?.calling || settings.data));
      }
    }
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  await mongoose.disconnect();
  process.exit(1);
});
