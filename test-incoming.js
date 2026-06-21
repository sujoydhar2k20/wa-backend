require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
        id: '914954660914373', // Your real WABA ID
        changes: [{
            value: {
                messaging_product: 'whatsapp',
                metadata: {
                    display_phone_number: '+91 98044 92738',
                    phone_number_id: '1042635532257802' // Your real Phone Number ID
                },
                contacts: [{ profile: { name: 'Test Customer' }, wa_id: '919876543210' }],
                messages: [{
                    from: '919876543210', // Simulated customer number
                    id: 'wamid.test_' + Date.now(),
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: 'Hello! This is a test incoming message.' },
                    type: 'text'
                }]
            },
            field: 'messages'
        }]
    }]
});

const hmac = crypto.createHmac('sha256', process.env.META_APP_SECRET);
hmac.update(payload);
const signature = `sha256=${hmac.digest('hex')}`;

axios.post(`http://localhost:${process.env.PORT || 5001}/api/webhooks/whatsapp`, payload, {
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }
}).then(res => {
    console.log('✅ Webhook accepted:', res.status, res.data);
    console.log('\nNow check your admin panel inbox — a new chat from "Test Customer" should appear!');
}).catch(e => {
    console.error('❌ Failed:', e.response?.status, e.response?.data || e.message);
});
