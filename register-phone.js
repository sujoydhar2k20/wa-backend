/**
 * Register a PENDING phone number with WhatsApp Cloud API.
 * Handles data localization requirement for Indian (+91) numbers.
 * 
 * Usage: node register-phone.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const PHONE_NUMBER_ID = '1069429599593165';
const WABA_ID = '1874918729815134';

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

    // Step 1: Set data localization on the WABA level
    console.log('🌍 Step 1: Setting data localization to IN on WABA...');
    try {
        const res = await axios.post(`${BASE_URL}/${WABA_ID}`, {
            data_localization_region: 'IN'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('   ✅ Done:', JSON.stringify(res.data));
    } catch (err) {
        console.log('   ❌ WABA-level failed:', JSON.stringify(err.response?.data || err.message));
    }

    // Step 2: Also try setting on phone number settings endpoint with correct format
    console.log('\n🌍 Step 2: Setting data localization on phone number settings...');
    try {
        const res = await axios.patch(`${BASE_URL}/${PHONE_NUMBER_ID}/whatsapp_business_profile`, {
            messaging_product: 'whatsapp',
            data_localization_region: 'IN'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('   ✅ Done:', JSON.stringify(res.data));
    } catch (err) {
        console.log('   ❌ Profile-level failed:', JSON.stringify(err.response?.data || err.message));
    }

    // Step 3: Register the phone number
    console.log('\n📱 Step 3: Registering phone number...');
    try {
        const regRes = await axios.post(`${BASE_URL}/${PHONE_NUMBER_ID}/register`, {
            messaging_product: 'whatsapp',
            pin: '123456',
            data_localization_region: 'IN'
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('   ✅ Registration successful:', JSON.stringify(regRes.data));
    } catch (err) {
        console.log('   ❌ Registration failed:', JSON.stringify(err.response?.data || err.message, null, 2));
    }

    // Step 4: Check final status
    console.log('\n🔍 Step 4: Checking phone status...');
    try {
        const statusRes = await axios.get(`${BASE_URL}/${PHONE_NUMBER_ID}`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,display_phone_number,verified_name,quality_rating,status' }
        });
        console.log(`   Status: ${statusRes.data.status}`);
        console.log(`   Phone:  ${statusRes.data.display_phone_number}`);
        console.log(`   Name:   ${statusRes.data.verified_name}`);
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
