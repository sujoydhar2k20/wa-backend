require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

// 1. Generate a mock incoming message payload
const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
        id: '1234567890',
        changes: [{
            value: {
                messaging_product: 'whatsapp',
                metadata: {
                    display_phone_number: '1234567890',
                    phone_number_id: '1234567890'
                },
                contacts: [{ profile: { name: 'Test User' }, wa_id: '919804492738' }],
                messages: [{
                    from: '919804492738',
                    id: 'wamid.HBgLOTE5ODA0NDkyNzM4FQIAEhgWMzBFMDEzMTk4NDQ2NDNGMTJDOTkA',
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: 'This is a test message from script' },
                    type: 'text'
                }]
            },
            field: 'messages'
        }]
    }]
});

// 2. Hash the payload with the exact App Secret from your production .env
const appSecret = process.env.META_APP_SECRET;
if (!appSecret) {
    console.error('❌ ERROR: META_APP_SECRET is not set in your .env file!');
    process.exit(1);
}

const hmac = crypto.createHmac('sha256', appSecret);
hmac.update(payload);
const signature = `sha256=${hmac.digest('hex')}`;

// 3. Send the webhook to the local port (assuming it's running on port 5001 internally)
// Alternatively, change this to 'https://backend.biswakarmagold.com/api/webhooks/whatsapp' 
// to test the full external routing
const webhookUrl = `http://localhost:${process.env.PORT || 5001}/api/webhooks/whatsapp`;

async function testWebhook() {
    console.log(`Sending test webhook to: ${webhookUrl}`);
    console.log(`Using Signature: ${signature}`);
    
    try {
        const response = await axios.post(webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-hub-signature-256': signature // Meta's security header
            }
        });
        
        console.log('\n✅ Success! The backend accepted the webhook.');
        console.log('Status:', response.status);
        console.log('Response:', response.data);
        console.log('\nNow check your PM2 / server logs. You should see "Incoming WhatsApp Webhook".');
        
    } catch (error) {
        console.error('\n❌ Failed to send webhook.');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Response Data:', error.response.data);
            
            if (error.response.status === 403) {
                console.error('\n⚠️ A 403 Forbidden usually means the META_APP_SECRET in your .env does not match what the payload was signed with.');
            } else if (error.response.status === 404) {
                console.error('\n⚠️ A 404 Not Found means the correct route /api/webhooks/whatsapp is missing or inaccessible.');
            }
        } else {
            console.error('Error Message:', error.message);
        }
    }
}

testWebhook();
