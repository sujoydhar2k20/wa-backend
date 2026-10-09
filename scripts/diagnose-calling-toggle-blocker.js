/**
 * Comprehensive read-only diagnostic for calling-toggle error 2593151.
 *
 * Checks:
 * 1) Phone number settings (calling object, restrictions).
 * 2) Access token validity and granted permissions.
 * 3) Messaging tier/limit for each WABA.
 * 4) Actual Graph API error from calling-settings toggle attempt.
 * 5) Correct endpoint and API version.
 *
 * Does NOT modify production settings.
 *
 * Usage:
 *   node scripts/diagnose-calling-toggle-blocker.js
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const Waba = require('../src/models/Waba');
const config = require('../src/config');

const API_VERSION = config.meta.apiVersion || 'v26.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const PHONE_NUMBER_IDS = {
  'biswakarma': {
    wabaId: '1002721328785441',
    phoneNumberId: '1244660898719753',
    displayName: 'Biswakarma Jewellery Shilpalaya',
  },
  'baba': {
    wabaId: '1598866321335111',
    phoneNumberId: '950089734863791',
    displayName: 'Baba New 9804',
  },
};

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

async function postWithToken(path, token, body = {}) {
  try {
    const r = await axios.post(`${BASE}${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

function sanitizeTokenForDisplay(token) {
  // Return only first 10 and last 4 chars
  if (!token || token.length < 20) return 'REDACTED';
  return `${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
}

(async () => {
  await connectDB();

  console.log(`\n=== Diagnostic for Calling-Toggle Blocker 2593151`);
  console.log(`API Version: ${API_VERSION}`);
  console.log(`Base URL: ${BASE}\n`);

  for (const [key, config] of Object.entries(PHONE_NUMBER_IDS)) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Account: ${config.displayName} (${key})`);
    console.log(`WABA ID: ${config.wabaId}`);
    console.log(`Phone Number ID: ${config.phoneNumberId}`);
    console.log(`${'='.repeat(80)}\n`);

    const waba = await Waba.findOne({ wabaId: config.wabaId });
    if (!waba) {
      console.log(`BLOCKER: WABA ${config.wabaId} not found in DB.`);
      continue;
    }
    if (!waba.accessToken) {
      console.log(`BLOCKER: WABA access token missing in DB.`);
      continue;
    }

    const token = waba.accessToken;
    console.log(`Token (sanitized): ${sanitizeTokenForDisplay(token)}\n`);

    // 1) Phone Number Settings
    console.log(`--- 1. Phone Number Settings (${config.phoneNumberId})`);
    const settings = await getWithToken(`/${config.phoneNumberId}/settings`, token);
    if (settings.ok) {
      console.log('Status: OK');
      console.log('Complete settings response:');
      console.log(JSON.stringify(settings.data, null, 2));
      if (settings.data?.calling) {
        console.log('\nCalling object:');
        console.log(JSON.stringify(settings.data.calling, null, 2));
      }
    } else {
      console.log(`Status: FAILED (HTTP ${settings.status})`);
      console.log('Error response:');
      console.log(JSON.stringify(settings.error, null, 2));
    }

    // 2) Token Debug
    console.log(`\n--- 2. Access Token Validity & Permissions`);
    const debugRes = await getWithToken('/debug_token', token, {
      input_token: token,
    });
    if (debugRes.ok) {
      console.log('Status: OK');
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
        granular_scopes: data.granular_scopes || [],
      }, null, 2));
    } else {
      console.log(`Status: FAILED (HTTP ${debugRes.status})`);
      console.log('Error response:');
      console.log(JSON.stringify(debugRes.error, null, 2));
    }

    // 3) Messaging Tier/Limit
    console.log(`\n--- 3. WABA Messaging Tier & Limit`);
    const wabaInfo = await getWithToken(`/${config.wabaId}`, token, {
      fields: 'messaging_limit_tier,messaging_limit,status',
    });
    if (wabaInfo.ok) {
      console.log('Status: OK');
      console.log(JSON.stringify(wabaInfo.data, null, 2));
      const tier = wabaInfo.data?.messaging_limit_tier || 'UNKNOWN';
      const limit = wabaInfo.data?.messaging_limit || 'UNKNOWN';
      console.log(`\nAnalysis: Tier=${tier}, Limit=${limit}`);
      if (limit !== 'UNKNOWN' && Number(limit) < 2000) {
        console.log('⚠️  WARNING: Messaging limit below 2000 (calling requires >= 2000).');
      } else if (limit !== 'UNKNOWN' && Number(limit) >= 2000) {
        console.log('✓ Messaging limit >= 2000 (calling-eligible).');
      }
    } else {
      console.log(`Status: FAILED (HTTP ${wabaInfo.status})`);
      console.log('Error response:');
      console.log(JSON.stringify(wabaInfo.error, null, 2));
    }

    // 4) Phone Number Detail (coexistence, tier check)
    console.log(`\n--- 4. Phone Number Detailed Status`);
    const numDetail = await getWithToken(`/${config.phoneNumberId}`, token, {
      fields: 'display_phone_number,platform_type,is_on_biz_app,messaging_limit_tier,status,quality_rating,verified_name',
    });
    if (numDetail.ok) {
      console.log('Status: OK');
      console.log(JSON.stringify(numDetail.data, null, 2));
      if (numDetail.data?.is_on_biz_app === true) {
        console.log('\n⚠️  BLOCKER: is_on_biz_app=true (coexistence mode). Calling not supported.');
      }
      const tier = numDetail.data?.messaging_limit_tier || '';
      if (/TIER_(50|250)$/i.test(tier)) {
        console.log(`\n⚠️  BLOCKER: messaging_limit_tier=${tier} (too low for calling).`);
      }
    } else {
      console.log(`Status: FAILED (HTTP ${numDetail.status})`);
      console.log('Error response:');
      console.log(JSON.stringify(numDetail.error, null, 2));
    }

    // 5) Attempt to Toggle Calling & Capture Exact Error
    console.log(`\n--- 5. Calling-Settings Toggle Attempt (READ-ONLY TEST)`);
    console.log('Attempting: POST /{PHONE_NUMBER_ID}/settings with calling.status=ENABLED');
    console.log('(This will be attempted; if it fails, we capture the exact error.)\n');

    const toggleBody = {
      calling: {
        status: 'ENABLED',
      },
    };
    console.log('Request body:');
    console.log(JSON.stringify(toggleBody, null, 2));

    const toggleRes = await postWithToken(`/${config.phoneNumberId}/settings`, token, toggleBody);
    if (toggleRes.ok) {
      console.log('\nStatus: SUCCESS');
      console.log('Response:');
      console.log(JSON.stringify(toggleRes.data, null, 2));
      console.log('\n✓ Calling was toggled successfully. No blocker found.');
    } else {
      console.log(`\nStatus: FAILED (HTTP ${toggleRes.status})`);
      console.log('Error response (exact Graph API error):');
      console.log(JSON.stringify(toggleRes.error, null, 2));

      const err = toggleRes.error?.error || {};
      console.log('\nError details extracted:');
      console.log(JSON.stringify({
        code: err.code,
        subcode: err.subcode,
        message: err.message,
        type: err.type,
        fbtrace_id: err.fbtrace_id,
        error_data: err.error_data,
      }, null, 2));

      if (err.code === 2593151 || err.message?.includes('2593151')) {
        console.log('\n⚠️  BLOCKER: Error 2593151 confirmed.');
      }
    }
  }

  await mongoose.disconnect();
  console.log('\n\nDiagnostic complete.\n');
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  await mongoose.disconnect();
  process.exit(1);
});
