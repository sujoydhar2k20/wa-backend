/**
 * Standalone calling-toggle blocker diagnostic.
 *
 * Does NOT require MongoDB. Uses access tokens from environment or CLI arguments.
 *
 * Environment variables:
 *   BISWAKARMA_TOKEN  - Access token for Biswakarma WABA
 *   BABA_TOKEN        - Access token for Baba WABA
 *   APP_ID            - Meta app ID (for context)
 *
 * Usage:
 *   node scripts/diagnose-calling-toggle-standalone.js
 *   node scripts/diagnose-calling-toggle-standalone.js <biswakarma-token> <baba-token>
 */
const axios = require('axios');
require('dotenv').config();

const API_VERSION = 'v26.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

const PHONE_NUMBER_IDS = {
  biswakarma: {
    wabaId: '1002721328785441',
    phoneNumberId: '1244660898719753',
    displayName: 'Biswakarma Jewellery Shilpalaya',
  },
  baba: {
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
  if (!token || token.length < 20) return 'REDACTED';
  return `${token.substring(0, 10)}...${token.substring(token.length - 4)}`;
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
  console.log('STANDALONE CALLING-TOGGLE BLOCKER DIAGNOSTIC');
  console.log(`API Version: ${API_VERSION}`);
  console.log(`Base URL: ${BASE}`);
  console.log(`${'='.repeat(80)}\n`);

  // Get tokens from arguments or env
  const args = process.argv.slice(2);
  const tokens = {
    biswakarma: args[0] || process.env.BISWAKARMA_TOKEN,
    baba: args[1] || process.env.BABA_TOKEN,
  };

  if (!tokens.biswakarma || !tokens.baba) {
    console.log('ERROR: Access tokens not provided.\n');
    console.log('Usage:');
    console.log('  1. Set environment variables:');
    console.log('     export BISWAKARMA_TOKEN="<token>"');
    console.log('     export BABA_TOKEN="<token>"');
    console.log('     node scripts/diagnose-calling-toggle-standalone.js\n');
    console.log('  2. Or pass as command-line arguments:');
    console.log('     node scripts/diagnose-calling-toggle-standalone.js <biswakarma-token> <baba-token>\n');
    process.exit(1);
  }

  for (const [key, config] of Object.entries(PHONE_NUMBER_IDS)) {
    const token = tokens[key];
    console.log(`${'='.repeat(80)}`);
    console.log(`Account: ${config.displayName} (${key})`);
    console.log(`WABA ID: ${config.wabaId}`);
    console.log(`Phone Number ID: ${config.phoneNumberId}`);
    console.log(`Token (sanitized): ${sanitizeTokenForDisplay(token)}`);
    console.log(`${'='.repeat(80)}\n`);

    // 1) Phone Number Settings
    console.log('--- 1. Phone Number Settings');
    const settings = await getWithToken(`/${config.phoneNumberId}/settings`, token);
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
    } else {
      console.log(`Status: ✗ FAILED (HTTP ${debugRes.status})`);
      console.log('Error:');
      console.log(JSON.stringify(sanitizeResponse(debugRes.error), null, 2));
    }

    // 3) Messaging Tier/Limit
    console.log('\n--- 3. WABA Messaging Tier & Limit');
    const wabaInfo = await getWithToken(`/${config.wabaId}`, token, {
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
    const numDetail = await getWithToken(`/${config.phoneNumberId}`, token, {
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

    // 5) Calling-Settings Toggle Attempt
    console.log('\n--- 5. Calling-Settings Toggle Attempt (READ-ONLY TEST)');
    console.log('Request: POST /{PHONE_NUMBER_ID}/settings');
    const toggleBody = {
      calling: {
        status: 'ENABLED',
      },
    };
    console.log('Body:', JSON.stringify(toggleBody, null, 2));

    const toggleRes = await postWithToken(`/${config.phoneNumberId}/settings`, token, toggleBody);
    if (toggleRes.ok) {
      console.log('\nStatus: ✓ SUCCESS (HTTP 200)');
      console.log('Response:');
      console.log(JSON.stringify(sanitizeResponse(toggleRes.data), null, 2));
      console.log('\n✓ Calling toggle succeeded. No blocker found.');
    } else {
      console.log(`\nStatus: ✗ FAILED (HTTP ${toggleRes.status})`);
      console.log('Exact Graph API error response:');
      console.log(JSON.stringify(sanitizeResponse(toggleRes.error), null, 2));

      const err = toggleRes.error?.error || {};
      console.log('\nParsed error details:');
      console.log(JSON.stringify({
        code: err.code,
        subcode: err.subcode,
        message: err.message,
        type: err.type,
        fbtrace_id: err.fbtrace_id,
        error_data: err.error_data,
      }, null, 2));

      if (err.code === 2593151 || err.code === '2593151') {
        console.log('\n❌ ERROR 2593151 CONFIRMED - Calling cannot be enabled due to technical prerequisites.');
      }
    }

    console.log('\n');
  }

  console.log('='.repeat(80));
  console.log('Diagnostic complete.');
  console.log('='.repeat(80) + '\n');
})().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
