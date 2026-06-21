require('dotenv').config();
const mongoose = require('mongoose');
const { Waba } = require('./src/models');
const axios = require('axios');

async function goLive() {
    await mongoose.connect(process.env.MONGODB_URI);
    const waba = await Waba.findOne({ wabaId: '914954660914373' });
    const phoneId = '1042635532257802';

    const url = `https://graph.facebook.com/v20.0/${phoneId}/register`;
    
    console.log(`Setting 2FA Pin and bringing ${phoneId} online...`);
    try {
        const res = await axios.post(url, {
            messaging_product: 'whatsapp',
            pin: '123456' // Sets your brand new 6-digit pin for this number on your WABA
        }, { 
            headers: { Authorization: `Bearer ${waba.accessToken}` } 
        });
        
        console.log('✅ Success! The number is now Connected and LIVE!');
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error('❌ Failed to go live:', e.response?.data || e.message);
    }
    process.exit(0);
}
goLive();

