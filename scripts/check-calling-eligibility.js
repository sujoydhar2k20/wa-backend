/**
 * READ-ONLY WhatsApp Calling readiness check (GET requests only, nothing is changed at Meta or in the DB).
 *
 * For every active WABA / phone number in the database it reports:
 *   - is_on_biz_app / platform_type -> coexistence (WhatsApp Business app + API) numbers cannot use Calling
 *   - messaging limit tier          -> Calling needs a limit of at least 2,000 (TIER_250 / TIER_1K are blockers)
 *   - quality rating, status, health_status (incl. can_receive_call_sip when Meta returns it)
 *   - apps subscribed to the WABA
 *   - app-level webhook fields: is `calls` subscribed? (missing -> Meta error 2593151 / 138018)
 *   - current calling settings
 * Access tokens and secrets are never printed.
 *
 * Usage (on the server, inside the backend folder):  node scripts/check-calling-eligibility.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const Waba = require('../src/models/Waba');
const config = require('../src/config');
const { connectDB } = require('../src/config/database');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;
const get = async (path, token, params = {}) => {
  try {
    const r = await axios.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, params, timeout: 20000 });
    return { ok: true, data: r.data };
  } catch (e) {
    const err = e.response?.data?.error;
    return { ok: false, error: err ? `${err.message} (code ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})` : e.message };
  }
};

const LOW_TIERS = /^TIER_(50|250|1K)$/;
const checkedApps = new Set();

async function checkAppCallsField(appId, appSecret, label) {
  if (!appId || !appSecret || checkedApps.has(appId)) return;
  checkedApps.add(appId);
  const r = await get(`/${appId}/subscriptions`, `${appId}|${appSecret}`);
  if (!r.ok) { console.log(`  app ${label} webhook fields: (not readable: ${r.error})`); return; }
  const wa = (r.data.data || []).find((s) => s.object === 'whatsapp_business_account');
  if (!wa) { console.log(`  app ${label}: NO whatsapp_business_account webhook configured`); return; }
  const fields = (wa.fields || []).map((f) => f.name);
  console.log(`  app ${label} webhook active=${wa.active} fields: ${fields.join(', ')}`);
  console.log(`  app ${label} 'calls' field subscribed: ${fields.includes('calls') ? 'YES' : 'NO  <-- BLOCKER (causes 2593151 / 138018)'}`);
}

(async () => {
  await connectDB();
  console.log(`Graph API ${config.meta.apiVersion}`);
  await checkAppCallsField(config.meta.appId, config.meta.appSecret, '(from .env)');

  const wabas = await Waba.find({ isActive: { $ne: false } });
  for (const w of wabas) {
    console.log(`\n=== WABA ${w.wabaId} (${w.businessName || 'unnamed'})`);
    if (w.appId && w.appSecret) await checkAppCallsField(w.appId, w.appSecret, `(WABA-specific ${w.appId})`);

    const subs = await get(`/${w.wabaId}/subscribed_apps`, w.accessToken);
    console.log('  apps subscribed to this WABA:', subs.ok
      ? JSON.stringify((subs.data.data || []).map((a) => ({ app: a.whatsapp_business_api_data?.name, id: a.whatsapp_business_api_data?.id, override: a.override_callback_uri ? 'yes' : undefined })))
      : `ERROR ${subs.error}`);

    for (const p of w.phoneNumbers || []) {
      console.log(`  --- phone ${p.phoneNumber} (id ${p.phoneNumberId})`);
      const base = await get(`/${p.phoneNumberId}`, w.accessToken, { fields: 'display_phone_number,verified_name,platform_type,quality_rating,messaging_limit_tier,status,name_status,code_verification_status' });
      console.log('    core:', base.ok ? JSON.stringify(base.data) : `ERROR ${base.error}`);
      const biz = await get(`/${p.phoneNumberId}`, w.accessToken, { fields: 'is_on_biz_app' });
      console.log('    is_on_biz_app (coexistence):', biz.ok ? JSON.stringify(biz.data.is_on_biz_app) : `(not available: ${biz.error})`);
      const health = await get(`/${p.phoneNumberId}`, w.accessToken, { fields: 'health_status' });
      console.log('    health_status:', health.ok ? JSON.stringify(health.data.health_status) : `(not available: ${health.error})`);
      const st = await get(`/${p.phoneNumberId}/settings`, w.accessToken);
      console.log('    calling settings:', st.ok ? JSON.stringify(st.data.calling ?? st.data) : `(not readable: ${st.error})`);

      const tier = base.ok ? base.data.messaging_limit_tier : null;
      const verdict = [];
      if (biz.ok && biz.data.is_on_biz_app === true) verdict.push('BLOCKER: coexistence number (calling unsupported)');
      if (base.ok && base.data.platform_type && base.data.platform_type !== 'CLOUD_API') verdict.push(`BLOCKER: platform_type ${base.data.platform_type}`);
      if (tier && LOW_TIERS.test(tier)) verdict.push(`BLOCKER: messaging limit ${tier} is below 2,000`);
      if (!tier) verdict.push('CHECK: messaging tier not returned');
      if (!verdict.length) verdict.push('no number-level blocker found');
      console.log('    verdict:', verdict.join('; '));
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
