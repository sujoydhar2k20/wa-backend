const { Notification, User } = require('../models');

async function list(req, res, next) {
    try {
        const userId = req.user._id;
        const { page = 1, limit = 20, type, isRead } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        
        const filter = { recipientId: userId };
        if (type) filter.type = type;
        if (isRead !== undefined) filter.isRead = isRead === 'true';

        // 1. Fetch paginated notifications
        const [notifications, total] = await Promise.all([
            Notification.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .lean(),
            Notification.countDocuments(filter),
        ]);

        // 2. Fetch unread counts per type to feed the tab badges (e.g. All (15), New Chat (5), Escalations (3))
        const unreadCountsGroup = await Notification.aggregate([
            { $match: { recipientId: userId, isRead: false } },
            { $group: { _id: '$type', count: { $sum: 1 } } }
        ]);

        const counts = {
            all: await Notification.countDocuments({ recipientId: userId, isRead: false }),
            new_chat: 0,
            escalation: 0,
            unread_reminder: 0,
            repeated_notification: 0
        };

        unreadCountsGroup.forEach(group => {
            if (group._id in counts) {
                counts[group._id] = group.count;
            }
        });

        // 3. Fetch User profile to return current global DND state
        const user = await User.findById(userId).select('isDnd');

        res.json({
            data: notifications,
            total,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            counts,
            isDnd: !!user?.isDnd
        });
    } catch (e) {
        next(e);
    }
}

async function markRead(req, res, next) {
    try {
        const userId = req.user._id;
        const { id, all } = req.body;

        if (all === true || id === 'all') {
            // Mark all notifications for this user as read
            await Notification.updateMany(
                { recipientId: userId, isRead: false },
                { $set: { isRead: true } }
            );
            return res.json({ success: true, message: 'All notifications marked as read' });
        }

        if (!id) {
            return res.status(400).json({ success: false, message: 'Notification id or all: true is required' });
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: id, recipientId: userId },
            { $set: { isRead: true } },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        res.json({ success: true, data: notification });
    } catch (e) {
        next(e);
    }
}

async function toggleDnd(req, res, next) {
    try {
        const userId = req.user._id;
        const { isDnd } = req.body;

        if (isDnd === undefined) {
            return res.status(400).json({ success: false, message: 'isDnd boolean value is required' });
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: { isDnd: !!isDnd } },
            { new: true }
        ).select('name phone role isDnd');

        res.json({ success: true, isDnd: user.isDnd, user });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    list,
    markRead,
    toggleDnd,
};
