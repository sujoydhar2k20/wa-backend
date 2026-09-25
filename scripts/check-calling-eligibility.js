/**
 * READ-ONLY WhatsApp Calling eligibility check (only GET requests, nothing is changed).
 *
 * For every active WABA / phone number in the database it reports what Meta says about:
 *   - platform_type / is_on_biz_app  -> whether the number is Cloud-API-only or a coexistence
 *                                       (WhatsApp Business app + API) number. Meta does NOT support
 *                                       calling for coexistence numbers.
 *   - messaging limit tier           -> calling needs a limit of at least 2,000 unique users / 24 h
 *   - quality rating / status
 *   - webhook subscription of the app to the WABA (the `calls` field must be subscribed)
 *   - current calling settings
 * Access tokens are never printed.
 *
 * Usage: node scripts/check-calling-eligibility.js
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
    return { ok: false, error: e.response?.data?.error?.message || e.message };
  }
};

(async () => {
  await connectDB();
  const wabas = await Waba.find({ isActive: { $ne: false } });
  for (const w of wabas) {
    console.log(`\n=== WABA ${w.wabaId} (${w.businessName || 'unnamed'})`);
    const subs = await get(`/${w.wabaId}/subscribed_apps`, w.accessToken);
    console.log('  webhook subscription:', subs.ok ? JSON.stringify(subs.data.data?.map((a) => ({ app: a.whatsapp_business_api_data?.name || a.id, subscribed_fields: a.subscribed_fields })) ?? subs.data) : `ERROR ${subs.error}`);

    for (const p of w.phoneNumbers || []) {
      console.log(`  --- phone ${p.phoneNumber} (id ${p.phoneNumberId})`);
      const base = await get(`/${p.phoneNumberId}`, w.accessToken, { fields: 'display_phone_number,platform_type,quality_rating,messaging_limit_tier,status' });
      console.log('    core:', base.ok ? JSON.stringify(base.data) : `ERROR ${base.error}`);
      const biz = await get(`/${p.phoneNumberId}`, w.accessToken, { fields: 'is_on_biz_app' });
      console.log('    is_on_biz_app:', biz.ok ? JSON.stringify(biz.data.is_on_biz_app) : `(not available: ${biz.error})`);
      const st = await get(`/${p.phoneNumberId}/settings`, w.accessToken);
      console.log('    calling settings:', st.ok ? JSON.stringify(st.data.calling ?? st.data) : `(not readable: ${st.error})`);

      const tier = base.ok ? base.data.messaging_limit_tier : null;
      const coexist = biz.ok && biz.data.is_on_biz_app === true;
      const verdict = [];
      if (coexist) verdict.push('BLOCKER: coexistence number (Meta: calling unsupported)');
      if (tier && /TIER_(50|250)$/.test(tier)) verdict.push(`BLOCKER: messaging limit ${tier} < 2000`);
      if (!verdict.length) verdict.push('no blocker detected by this check (still verify webhook `calls` field is subscribed)');
      console.log('    verdict:', verdict.join('; '));
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
