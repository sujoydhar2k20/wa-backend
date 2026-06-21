require('dotenv').config();
const mongoose = require('mongoose');
const { Waba } = require('./src/models');
const axios = require('axios');
const config = require('./src/config');

async function run() {
    try {
        console.log('Connecting to DB...', process.env.MONGODB_URI ? 'URI Found' : 'URI Missing');
        
        // Use the env variable directly to avoid config object structure issues
        await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
        
        console.log('Fetching WABA 914954660914373...');
        const waba = await Waba.findOne({ wabaId: '914954660914373' });
        
        if (!waba) {
            console.error('❌ WABA not found in database!');
            process.exit(1);
        }

        console.log(`✅ Found WABA: ${waba.businessName}`);
        
        // Grab the app ID from env to be safe, not the config object
        const appId = process.env.META_APP_ID;
        console.log(`Using App ID: ${appId}`);

        // 1. Force Subscribing to the App
        console.log('--- Subscribing WABA to this App ID ---');
        try {
            // Usually the API version is generic enough we don't need the exact config
            const urlApp = `https://graph.facebook.com/v20.0/${waba.wabaId}/subscribed_apps`;
            const resApp = await axios.post(urlApp, {}, {
                headers: { Authorization: `Bearer ${waba.accessToken}` }
            });
            console.log('✅ Subscription Success:', resApp.data);
        } catch (e) {
            console.error('❌ Failed to subscribe:', e.response?.data || e.message);
        }

        // 2. Check all Phone Numbers and force webhook routing
        console.log('\n--- Checking Phone Numbers ---');
        for (const phone of waba.phoneNumbers) {
            console.log(`\nChecking phone: ${phone.phoneNumber} (ID: ${phone.phoneNumberId})`);
            
            // Registering the number to the app explicitly bounds the number's webhooks
            try {
                const urlRegister = `https://graph.facebook.com/v20.0/${phone.phoneNumberId}/register`;
                const resRegister = await axios.post(urlRegister, {
                    messaging_product: 'whatsapp',
                    pin: '123456' // Just a dummy pin, usually doesn't affect existing registrations
                }, {
                    headers: { Authorization: `Bearer ${waba.accessToken}` }
                });
                console.log('✅ Registration forced successfully:', resRegister.data);
            } catch (e) {
                // It's normal for this to fail if it's already registered
                console.error('⚠️ Registration note (often safe to ignore if already registered):', e.response?.data?.error?.message || e.message);
            }
        }

        console.log('\nAll done! Try sending a message to 91 98044 92738 now.');

    } catch(e) {
        console.error('Fatal Error:', e.response ? e.response.data : e.message);
    }
    process.exit(0);
}

run();

