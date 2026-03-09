/**
 * Script to check and subscribe all WABAs to this app's webhooks.
 * 
 * Usage: node check-waba-subscriptions.js
 * 
 * This will:
 * 1. Connect to MongoDB
 * 2. Fetch all WABAs from the database
 * 3. For each WABA, check if the app is subscribed to its webhooks
 * 4. If not subscribed, it will subscribe automatically
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

async function main() {
    // 1. Connect to DB
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB\n');

    // 2. Load WABA model
    const Waba = require('./src/models/Waba');
    const wabas = await Waba.find({});

    if (wabas.length === 0) {
        console.log('❌ No WABAs found in database.');
        await mongoose.disconnect();
        return;
    }

    console.log(`Found ${wabas.length} WABA(s) in database:\n`);

    for (const waba of wabas) {
        console.log('─'.repeat(60));
        console.log(`📋 Business: ${waba.businessName}`);
        console.log(`   WABA ID:  ${waba.wabaId}`);
        console.log(`   Phones:   ${waba.phoneNumbers.map(p => p.phoneNumber).join(', ')}`);
        console.log(`   Token:    ${waba.accessToken ? waba.accessToken.substring(0, 20) + '...' : '❌ NO TOKEN'}`);

        if (!waba.accessToken) {
            console.log('   ⚠️  Skipping - no access token stored\n');
            continue;
        }

        // 3. Check current subscription status
        try {
            console.log('\n   🔍 Checking webhook subscription...');
            const checkRes = await axios.get(`${BASE_URL}/${waba.wabaId}/subscribed_apps`, {
                headers: { Authorization: `Bearer ${waba.accessToken}` }
            });

            const subscribedApps = checkRes.data.data || [];

            if (subscribedApps.length > 0) {
                console.log(`   ✅ Already subscribed! Apps: ${JSON.stringify(subscribedApps.map(a => a.whatsapp_business_api_data?.id || a.id))}`);
            } else {
                console.log('   ❌ NOT subscribed to webhooks!');

                // 4. Subscribe
                console.log('   📡 Subscribing now...');
                const subRes = await axios.post(`${BASE_URL}/${waba.wabaId}/subscribed_apps`, {}, {
                    headers: { Authorization: `Bearer ${waba.accessToken}` }
                });

                if (subRes.data.success) {
                    console.log('   ✅ Successfully subscribed to webhooks!');
                } else {
                    console.log('   ⚠️  Subscription response:', JSON.stringify(subRes.data));
                }
            }
        } catch (err) {
            console.log(`   ❌ Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        }

        // 5. Check phone number registration status
        for (const phone of waba.phoneNumbers) {
            try {
                console.log(`\n   📱 Checking phone ${phone.phoneNumber} (ID: ${phone.phoneNumberId})...`);
                const phoneRes = await axios.get(`${BASE_URL}/${phone.phoneNumberId}`, {
                    headers: { Authorization: `Bearer ${waba.accessToken}` },
                    params: { fields: 'id,display_phone_number,verified_name,quality_rating,status' }
                });
                console.log(`      Status: ${phoneRes.data.status || 'N/A'}`);
                console.log(`      Verified Name: ${phoneRes.data.verified_name || 'N/A'}`);
                console.log(`      Quality: ${phoneRes.data.quality_rating || 'N/A'}`);
            } catch (err) {
                console.log(`      ❌ Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
            }
        }

        console.log('');
    }

    console.log('─'.repeat(60));
    console.log('Done!');
    await mongoose.disconnect();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
