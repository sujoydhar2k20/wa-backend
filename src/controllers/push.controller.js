const { User } = require('../models');
const { logger } = require('../utils/logger');

exports.getVapidPublicKey = (req, res) => {
    try {
        if (!process.env.VAPID_PUBLIC_KEY) {
            return res.status(500).json({ error: 'VAPID public key not configured' });
        }
        res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    } catch (error) {
        logger.error(`Error getting VAPID public key: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.subscribe = async (req, res) => {
    try {
        const userId = req.user.id;
        const subscription = req.body;

        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ error: 'Invalid subscription object' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if subscription already exists
        const exists = user.pushSubscriptions.some(sub => sub.endpoint === subscription.endpoint);
        if (!exists) {
            user.pushSubscriptions.push(subscription);
            await user.save();
        }

        res.status(201).json({ message: 'Subscription added' });
    } catch (error) {
        logger.error(`Error adding push subscription: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.unsubscribe = async (req, res) => {
    try {
        const userId = req.user.id;
        const { endpoint } = req.body;

        if (!endpoint) {
            return res.status(400).json({ error: 'Endpoint is required' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        user.pushSubscriptions = user.pushSubscriptions.filter(sub => sub.endpoint !== endpoint);
        await user.save();

        res.status(200).json({ message: 'Subscription removed' });
    } catch (error) {
        logger.error(`Error removing push subscription: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};
