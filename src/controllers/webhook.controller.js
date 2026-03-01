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
            const changes = body.entry?.[0]?.changes?.[0];
            const value = changes?.value;
            const field = changes?.field;

            if (field === 'message_template_status_update' && value) {
                logger.info(`Template status update received: ${value.message_template_name} is now ${value.event}`);
                require('../services/webhook.service').processTemplateStatusWebhook(body.entry[0])
                    .catch(e => logger.error('Error in template status webhook service:', e));
                return res.status(200).send('EVENT_RECEIVED');
            }

            if (value && (
                (value.messages && value.messages.length > 0) ||
                (value.statuses && value.statuses.length > 0)
            )) {
                // Process the webhook asynchronously
                require('../services/webhook.service').processWebhook(body.entry[0])
                    .catch(e => logger.error('Error in webhook service:', e));

                logger.info('Received a valid message/status via webhook');
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
