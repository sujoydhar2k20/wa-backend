/**
 * Calling eligibility diagnostic (READ-ONLY).
 *
 * This script performs 4 read-only GET operations to diagnose calling prerequisites.
 * NO SETTINGS ARE MODIFIED. All checks are informational only.
 *
 * Uses access tokens stored in MongoDB WABA records (same source as production).
 * Does not print or expose tokens.
 *
 * Checks performed for each phone number:
 *   1. Phone Number Settings - calling object and restrictions
 *   2. Access Token Validity - app_id, is_valid, scopes, expiry
 *   3. WABA Messaging Tier/Limit - check minimum 2000 requirement
 *   4. Phone Number Status - is_on_biz_app, messaging_limit_tier, platform_type
 *
 * Usage:
 *   node scripts/diagnose-calling-toggle-standalone.js
 *   node scripts/diagnose-calling-toggle-standalone.js [WABA_ID_1] [WABA_ID_2] ...
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const Waba = require('../src/models/Waba');
const config = require('../src/config');

const API_VERSION = config.meta.apiVersion || 'v26.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const DEFAULT_WABA_IDS = ['1002721328785441', '1598866321335111'];

async function getWithToken(path, token, params = {}) {
  try {
    const r = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 20000,
    });
    return { ok: true, data: r.data };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status,
      error: e.response?.data || { message: e.message },
    };
  }
}

function sanitizeResponse(obj, tokenFieldNames = ['access_token', 'sip_user_password']) {
  if (typeof obj !== 'object' || obj === null) return obj;
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key in sanitized) {
    if (tokenFieldNames.includes(key)) {
      sanitized[key] = 'REDACTED_TOKEN';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeResponse(sanitized[key], tokenFieldNames);
    }
  }
  return sanitized;
}

(async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log('CALLING ELIGIBILITY DIAGNOSTIC (READ-ONLY)');
  console.log('No settings will be modified. All checks are informational only.');
  console.log(`API Version: ${API_VERSION}`);
  console.log(`Base URL: ${BASE}`);
  console.log(`MongoDB: Fetching WABA records and access tokens from DB`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    await connectDB();
    console.log('✓ MongoDB connected\n');
  } catch (e) {
    console.error('✗ FATAL: Cannot connect to MongoDB:', e.message);
    console.error('Ensure MONGODB_URI environment variable is set and reachable.');
    process.exit(1);
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
    console.log('ERROR: No WABAs found in database.');
    console.log('Ensure MongoDB contains WABA records with stored access tokens.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Found ${wabas.length} WABA record(s) in database.\n`);

  for (const waba of wabas) {
    const token = waba.accessToken;
    if (!token) {
      console.log(`${'='.repeat(80)}`);
      console.log(`WABA: ${waba.wabaId} (${waba.businessName || 'unnamed'})`);
      console.log('✗ ERROR: No access token stored for this WABA.');
      console.log(`${'='.repeat(80)}\n`);
      continue;
    }

    const phoneNumbers = waba.phoneNumbers || [];
    if (!phoneNumbers.length) {
      console.log(`${'='.repeat(80)}`);
      console.log(`WABA: ${waba.wabaId} (${waba.businessName || 'unnamed'})`);
      console.log('ℹ️  No phone numbers registered for this WABA.');
      console.log(`${'='.repeat(80)}\n`);
      continue;
    }

    for (const phone of phoneNumbers) {
      console.log(`${'='.repeat(80)}`);
      console.log(`WABA: ${waba.wabaId} (${waba.businessName || 'unnamed'})`);
      console.log(`Phone: ${phone.phoneNumber} (${phone.phoneNumberId})`);
      console.log(`Display Name: ${phone.displayName || 'N/A'}`);
      console.log(`${'='.repeat(80)}\n`);

      // 1) Phone Number Settings
      console.log('--- 1. Phone Number Settings (calling object and restrictions)');
      const settings = await getWithToken(`/${phone.phoneNumberId}/settings`, token);
      if (settings.ok) {
        console.log('Status: ✓ OK (HTTP 200)');
        const sanitized = sanitizeResponse(settings.data);
        console.log(JSON.stringify(sanitized, null, 2));
        if (settings.data?.calling) {
          console.log('\nCalling object extracted:');
          console.log(JSON.stringify(sanitizeResponse(settings.data.calling), null, 2));
        } else {
          console.log('\nℹ️  No calling object in settings response.');
        }
      } else {
        console.log(`Status: ✗ FAILED (HTTP ${settings.status})`);
        console.log('Error:');
        console.log(JSON.stringify(sanitizeResponse(settings.error), null, 2));
      }

      // 2) Token Debug
      console.log('\n--- 2. Access Token Validity & Permissions');
      const debugRes = await getWithToken('/debug_token', token, {
        input_token: token,
      });
      if (debugRes.ok) {
        console.log('Status: ✓ OK (HTTP 200)');
        const data = debugRes.data?.data || {};
        console.log(JSON.stringify({
          app_id: data.app_id || 'REDACTED',
          type: data.type,
          application: data.application,
          is_valid: data.is_valid,
          issued_at: data.issued_at,
          expires_at: data.expires_at,
          data_access_expires_at: data.data_access_expires_at,
          scopes: data.scopes || [],
          granular_scopes: (data.granular_scopes || []).map((g) => ({ scope: g.scope })),
        }, null, 2));
        if (!data.is_valid) {
          console.log('\n⚠️  BLOCKER: Access token is not valid or has expired.');
        }
      } else {
        console.log(`Status: ✗ FAILED (HTTP ${debugRes.status})`);
        console.log('Error:');
        console.log(JSON.stringify(sanitizeResponse(debugRes.error), null, 2));
      }

      // 3) Messaging Tier/Limit
      console.log('\n--- 3. WABA Messaging Tier & Limit');
      const wabaInfo = await getWithToken(`/${waba.wabaId}`, token, {
        fields: 'messaging_limit_tier,messaging_limit,status',
      });
      if (wabaInfo.ok) {
        console.log('Status: ✓ OK (HTTP 200)');
        console.log(JSON.stringify(wabaInfo.data, null, 2));
        const limit = wabaInfo.data?.messaging_limit;
        console.log('\nAnalysis:');
        if (typeof limit === 'number') {
          if (limit < 2000) {
            console.log(`⚠️  BLOCKER: Messaging limit ${limit} < 2000 (calling requires >= 2000)`);
          } else {
            console.log(`✓ Messaging limit ${limit} >= 2000 (calling-eligible)`);
          }
        } else {
          console.log(`ℹ️  Messaging limit: ${limit} (type: ${typeof limit})`);
        }
      } else {
        console.log(`Status: ✗ FAILED (HTTP ${wabaInfo.status})`);
        console.log('Error:');
        console.log(JSON.stringify(sanitizeResponse(wabaInfo.error), null, 2));
      }

      // 4) Phone Number Detail
      console.log('\n--- 4. Phone Number Detailed Status');
      const numDetail = await getWithToken(`/${phone.phoneNumberId}`, token, {
        fields: 'display_phone_number,platform_type,is_on_biz_app,messaging_limit_tier,status,quality_rating,verified_name',
      });
      if (numDetail.ok) {
        console.log('Status: ✓ OK (HTTP 200)');
        console.log(JSON.stringify(numDetail.data, null, 2));
        console.log('\nAnalysis:');
        if (numDetail.data?.is_on_biz_app === true) {
          console.log('⚠️  BLOCKER: is_on_biz_app=true (coexistence with Business app - calling not supported)');
        } else {
          console.log(`✓ is_on_biz_app=${numDetail.data?.is_on_biz_app} (Cloud API only)`);
        }
        const tier = numDetail.data?.messaging_limit_tier || '';
        if (/TIER_(50|250)$/i.test(tier)) {
          console.log(`⚠️  BLOCKER: messaging_limit_tier=${tier} (too low for calling)`);
        } else {
          console.log(`ℹ️  messaging_limit_tier=${tier}`);
        }
      } else {
        console.log(`Status: ✗ FAILED (HTTP ${numDetail.status})`);
        console.log('Error:');
        console.log(JSON.stringify(sanitizeResponse(numDetail.error), null, 2));
      }

      console.log('\n');
    }
  }

  console.log('='.repeat(80));
  console.log('Diagnostic complete.');
  console.log('SUMMARY: No settings were modified. This diagnostic only read configuration data.');
  console.log('='.repeat(80) + '\n');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
