/**
 * Register a PENDING migrated phone number with WhatsApp Cloud API.
 * Uses v25.0 which supports data_localization_region directly in the register body.
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

    // Register with data_localization_region directly in body (v25.0)
    console.log(`📱 Registering phone ${PHONE_NUMBER_ID} with v25.0 + data_localization_region: IN...`);
    try {
        const res = await axios.post(`${BASE}/${PHONE_NUMBER_ID}/register`, {
            messaging_product: 'whatsapp',
            pin: PIN,
            data_localization_region: 'IN'
        }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        console.log('   ✅ Registered!', JSON.stringify(res.data));
    } catch (err) {
        console.log('   ❌ Failed:', JSON.stringify(err.response?.data || err.message));
    }

    // Check status
    console.log('\n🔍 Checking phone status...');
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