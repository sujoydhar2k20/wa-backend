require('dotenv').config();
const mongoose = require('mongoose');
const { Waba, Chat, Message } = require('./src/models');
const webhookService = require('./src/services/webhook.service');
const { connectDB } = require('./src/config/database');

async function test() {
    try {
        await connectDB();
        console.log('Connected to DB');

        // Find a WABA to use
        const waba = await Waba.findOne();
        if (!waba) {
            console.error('No WABA found in DB. Please add one first.');
            process.exit(1);
        }

        const entry = {
            id: waba.wabaId,
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '123456789', phone_number_id: waba.phoneNumbers[0].phoneNumberId },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: '923154239421' }],
                    messages: [{
                        from: '923154239421',
                        id: 'test-msg-' + Date.now(),
                        timestamp: Math.floor(Date.now() / 1000),
                        type: 'audio',
                        audio: {
                            id: '558533B0053E593C6D', // Mock ID
                            mime_type: 'audio/ogg'
                        }
                    }]
                }
            }]
        };

        console.log('Processing mock webhook...');
        // Note: downloadMedia will fail in a real way if the ID is invalid, 
        // but we want to see if it reaches that point and handles the flow.
        await webhookService.processWebhook(entry);

        console.log('Webhook processing triggered (async). Waiting a few seconds...');
        await new Promise(r => setTimeout(r, 5000));

        const msg = await Message.findOne({ waId: '923154239421' }).sort({ createdAt: -1 });
        console.log('Last message status:', msg ? {
            id: msg.messageId,
            type: msg.type,
            mediaId: msg.mediaId,
            mediaUrl: msg.mediaUrl
        } : 'No message found');

        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

test();
