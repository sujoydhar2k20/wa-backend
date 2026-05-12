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

        // Log incoming webhook for debugging (winston doesn't support %o)
        logger.info(`Incoming WhatsApp Webhook: ${JSON.stringify(body).substring(0, 500)}`);

        if (body.object) {
            const changes = body.entry?.[0]?.changes?.[0];
            const value = changes?.value;
            const field = changes?.field;

            logger.info(`Webhook field: ${field}, has messages: ${!!(value?.messages?.length)}, has statuses: ${!!(value?.statuses?.length)}, WABA ID: ${body.entry?.[0]?.id}`);

            if (field === 'message_template_status_update' && value) {
                logger.info(`Template status update received: ${value.message_template_name} is now ${value.event}`);
                require('../services/webhook.service').processTemplateStatusWebhook(body.entry[0])
                    .catch(e => logger.error('Error in template status webhook service:', e));
                return res.status(200).send('EVENT_RECEIVED');
            }

            // Handle call webhook events
            if (field === 'calls' && value) {
                logger.info(`Call webhook received: ${JSON.stringify(value).substring(0, 300)}`);
                require('../services/call.service').processCallWebhook(body.entry[0])
                    .catch(e => logger.error('Error in call webhook service:', e));
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
            logger.warn(`Webhook received with no body.object: ${JSON.stringify(body).substring(0, 300)}`);
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
