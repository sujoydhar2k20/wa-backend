require('dotenv').config();
const mongoose = require('mongoose');
const { Waba } = require('./src/models');
const axios = require('axios');

async function migrate() {
    await mongoose.connect(process.env.MONGODB_URI);
    // Get your WABA
    const waba = await Waba.findOne({ wabaId: '914954660914373' });
    
    // We are requesting to add the number to YOUR Waba
    const url = `https://graph.facebook.com/v20.0/${waba.wabaId}/phone_numbers`;
    
    console.log('Requesting SMS OTP to migrate number...');
    try {
        const res = await axios.post(url, {
            cc: "91",
            phone_number: "9804492738", // Ensure no spaces
            type: "SMS",
            verified_name: "Biswakarma Jewellery Shilpalaya" // Exact display name
        }, {
            headers: { Authorization: `Bearer ${waba.accessToken}` }
        });
        
        console.log('✅ Success! SMS OTP sent.');
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error('❌ Failed:', e.response?.data || e.message);
    }
    process.exit(0);
}
migrate();

