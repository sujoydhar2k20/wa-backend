const { ApiKey, Waba } = require('../models');
const { logger } = require('../utils/logger');

const externalAuth = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'];

        if (!apiKey) {
            return res.status(401).json({ error: 'X-API-KEY header is missing' });
        }

        const keyDoc = await ApiKey.findOne({ key: apiKey, isActive: true }).populate('wabaId');

        if (!keyDoc) {
            return res.status(401).json({ error: 'Invalid or inactive API key' });
        }

        // Check if WABA is still active
        if (!keyDoc.wabaId || !keyDoc.wabaId.isActive) {
            return res.status(403).json({ error: 'Associated WABA is inactive' });
        }

        // Attach authorized info to request
        req.external = {
            apiKey: keyDoc.key,
            waba: keyDoc.wabaId,
            phoneNumberId: keyDoc.phoneNumberId,
            name: keyDoc.name
        };

        // Update last used timestamp (async, don't block)
        ApiKey.updateOne({ _id: keyDoc._id }, { lastUsedAt: new Date() }).catch(err => {
            logger.error(`Error updating API key lastUsedAt: ${err.message}`);
        });

        next();
    } catch (error) {
        logger.error('External API Auth Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = externalAuth;
