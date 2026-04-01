/**
 * Script to check webhook subscription status for all WABAs.
 * Run: node scripts/check-webhook-subscription.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
const BASE_URL = 'https://graph.facebook.com/v25.0';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const Waba = require('../src/models/Waba');
  const wabas = await Waba.find({}).lean();

  console.log(`Found ${wabas.length} WABA(s) in DB:\n`);

  for (const waba of wabas) {
    console.log(`=== WABA: ${waba.businessName || 'Unknown'} ===`);
    console.log(`  WABA ID (Meta): ${waba.wabaId}`);
    console.log(`  Phone Numbers: ${waba.phoneNumbers?.map(p => p.phoneNumber).join(', ') || 'None'}`);
    console.log(`  Has Token: ${!!waba.accessToken}`);

    if (!waba.accessToken) {
      console.log('  ⚠️ No access token, skipping API checks.\n');
      continue;
    }

    const token = waba.accessToken;

    // 1. Check subscribed apps
    try {
      const subRes = await axios.get(`${BASE_URL}/${waba.wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log(`  📡 Subscribed Apps:`, JSON.stringify(subRes.data, null, 4));
    } catch (err) {
      console.log(`  ❌ Failed to get subscriptions:`, err.response?.data?.error?.message || err.message);
    }

    // 2. Check phone number status
    for (const pn of (waba.phoneNumbers || [])) {
      try {
        const phoneRes = await axios.get(`${BASE_URL}/${pn.phoneNumberId}?fields=verified_name,code_verification_status,quality_rating,display_phone_number,name_status,is_official_business_account`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`  📱 Phone ${pn.phoneNumber}:`, JSON.stringify(phoneRes.data, null, 4));
      } catch (err) {
        console.log(`  ❌ Failed to get phone info for ${pn.phoneNumber}:`, err.response?.data?.error?.message || err.message);
      }
    }

    // 3. Check WABA details
    try {
      const wabaRes = await axios.get(`${BASE_URL}/${waba.wabaId}?fields=name,currency,timezone_id,message_template_namespace,account_review_status,on_behalf_of_business_info`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log(`  🏢 WABA Details:`, JSON.stringify(wabaRes.data, null, 4));
    } catch (err) {
      console.log(`  ❌ Failed to get WABA details:`, err.response?.data?.error?.message || err.message);
    }

    console.log('');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
