const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');

async function verify(req, res, next) {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        const result = whatsappService.verifyWebhook(mode, token, challenge);
        if (result) {
            logger.info('Webhook verified successfully');
            return res.status(200).send(result);
        } else {
            logger.warn('Webhook verification failed');
            return res.sendStatus(403);
        }
    } catch (e) {
        next(e);
    }
}

async function handle(req, res, next) {
    try {
        const body = req.body;

        // Log incoming webhook for debugging
        logger.info('Incoming WhatsApp Webhook: %o', JSON.stringify(body, null, 2));

        if (body.object) {
            if (
                body.entry &&
                body.entry[0].changes &&
                body.entry[0].changes[0] &&
                body.entry[0].changes[0].value.messages &&
                body.entry[0].changes[0].value.messages[0]
            ) {
                // Here we would typically process the message
                // For now, we return 200 to acknowledge receipt
                logger.info('Received a message via webhook');
            }
            return res.status(200).send('EVENT_RECEIVED');
        } else {
            return res.sendStatus(404);
        }
    } catch (e) {
        next(e);
    }
}

module.exports = {
    verify,
    handle,
};
