const { improveMessage } = require('../services/messageImprovement.service');
const { logger } = require('../utils/logger');

/**
 * Improve a staff message using AI
 * POST /messages/improve
 * Body: { text: string }
 */
async function improveMessageHandler(req, res, next) {
    try {
        const { text } = req.body;

        if (!text || typeof text !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Message text is required and must be a string',
            });
        }

        const result = await improveMessage(text);
        return res.json(result);
    } catch (error) {
        logger.error('Message Improvement Handler Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to process message improvement request',
        });
    }
}

module.exports = {
    improveMessageHandler,
};
