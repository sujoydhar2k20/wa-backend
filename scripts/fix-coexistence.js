/**
 * Script to deregister and re-register a phone number WITHOUT coexistence.
 * This fixes the issue where a phone was originally onboarded with coexistence mode
 * and messages aren't being delivered to the webhook.
 *
 * Run: node scripts/fix-coexistence.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
const BASE_URL = 'https://graph.facebook.com/v25.0';

// Target WABA and phone to fix
const TARGET_WABA_ID = '1369041638318880';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const Waba = require('../src/models/Waba');
  const waba = await Waba.findOne({ wabaId: TARGET_WABA_ID }).lean();

  if (!waba) {
    console.error(`WABA ${TARGET_WABA_ID} not found in DB.`);
    process.exit(1);
  }

  const token = waba.accessToken;
  const phone = waba.phoneNumbers?.[0];

  if (!phone) {
    console.error('No phone numbers found for this WABA.');
    process.exit(1);
  }

  const phoneNumberId = phone.phoneNumberId;
  console.log(`Working on phone: ${phone.phoneNumber} (ID: ${phoneNumberId})`);
  console.log(`WABA: ${waba.businessName} (${waba.wabaId})\n`);

  // Step 1: Deregister the phone number
  console.log('Step 1: Deregistering phone number...');
  try {
    const deregRes = await axios.post(`${BASE_URL}/${phoneNumberId}/deregister`, {
      messaging_product: 'whatsapp'
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('  ✅ Deregistered:', JSON.stringify(deregRes.data));
  } catch (err) {
    console.log('  ⚠️ Deregister response:', JSON.stringify(err.response?.data || err.message));
    // Continue anyway — might fail if already deregistered
  }

  // Wait 3 seconds for Meta to process
  console.log('\nWaiting 3 seconds for Meta to process...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Step 2: Set storage configuration for Indian number
  console.log('Step 2: Setting storage configuration (IN)...');
  try {
    const storageRes = await axios.post(`${BASE_URL}/${phoneNumberId}/settings`, {
      storage_configuration: {
        status: 'IN_COUNTRY_STORAGE_ENABLED',
        data_localization_region: 'IN'
      }
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('  ✅ Storage config set:', JSON.stringify(storageRes.data));
  } catch (err) {
    console.log('  ⚠️ Storage config response:', JSON.stringify(err.response?.data || err.message));
  }

  // Step 3: Re-register WITHOUT coexistence (just messaging_product + pin)
  console.log('\nStep 3: Registering phone number (without coexistence)...');
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  try {
    const regRes = await axios.post(`${BASE_URL}/${phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
      pin: pin
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('  ✅ Registered:', JSON.stringify(regRes.data));
  } catch (err) {
    console.log('  ❌ Register failed:', JSON.stringify(err.response?.data || err.message));
  }

  // Step 4: Re-subscribe app to WABA webhooks
  console.log('\nStep 4: Subscribing app to WABA webhooks...');
  try {
    const subRes = await axios.post(`${BASE_URL}/${waba.wabaId}/subscribed_apps`, {}, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log('  ✅ Subscribed:', JSON.stringify(subRes.data));
  } catch (err) {
    console.log('  ❌ Subscribe failed:', JSON.stringify(err.response?.data || err.message));
  }

  console.log('\n🎉 Done! Now send a test message to the number and check PM2 logs.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
