/**
 * Register a PENDING migrated phone number with WhatsApp Cloud API.
 * Two-step flow for Indian numbers:
 *   1. POST /{PHONE_NUMBER_ID}/settings — set storage_configuration
 *   2. POST /{PHONE_NUMBER_ID}/register — register without data_localization_region
 * 
 * Usage: node register-phone.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const PHONE_NUMBER_ID = '1069429599593165';
const WABA_ID = '1874918729815134';
const PIN = '123456';
const API_VERSION = 'v25.0';

async function main() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB\n');

    const Waba = require('./src/models/Waba');
    const waba = await Waba.findOne({ wabaId: WABA_ID });

    if (!waba) {
        console.log('❌ WABA not found');
        await mongoose.disconnect();
        return;
    }

    const token = waba.accessToken;
    const BASE = `https://graph.facebook.com/${API_VERSION}`;

    // Step 1: Set storage configuration (data localization)
    console.log('🌍 Step 1: Setting storage configuration to IN (India)...');
    try {
        const res = await axios.post(`${BASE}/${PHONE_NUMBER_ID}/settings`, {
            storage_configuration: {
                status: 'in_country_storage_enabled',
                enabled: true,
                region: 'in'
            }
        }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        console.log('   ✅ Success:', JSON.stringify(res.data));
    } catch (err) {
        console.log('   ❌ Failed:', JSON.stringify(err.response?.data || err.message));
    }

    // Step 2: Register WITHOUT data_localization_region
    console.log('\n📱 Step 2: Registering phone number...');
    try {
        const res = await axios.post(`${BASE}/${PHONE_NUMBER_ID}/register`, {
            messaging_product: 'whatsapp',
            pin: PIN
        }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        console.log('   ✅ Registered!', JSON.stringify(res.data));
    } catch (err) {
        console.log('   ❌ Failed:', JSON.stringify(err.response?.data || err.message));
    }

    // Step 3: Check status
    console.log('\n🔍 Step 3: Checking phone status...');
    try {
        const statusRes = await axios.get(`${BASE}/${PHONE_NUMBER_ID}`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,display_phone_number,verified_name,quality_rating,status,platform_type' }
        });
        console.log(`   Status:   ${statusRes.data.status}`);
        console.log(`   Phone:    ${statusRes.data.display_phone_number}`);
        console.log(`   Name:     ${statusRes.data.verified_name}`);
        console.log(`   Platform: ${statusRes.data.platform_type}`);
    } catch (err) {
        console.log('   ❌ Error:', err.response?.data || err.message);
    }

    await mongoose.disconnect();
    console.log('\nDone!');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});