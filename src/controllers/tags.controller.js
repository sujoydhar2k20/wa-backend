const { Tag, Chat, ChatActivity, Message } = require('../models');

async function list(req, res, next) {
    try {
        const { search, q } = req.query;
        const query = {};
        const searchTerm = search || q;
        if (searchTerm) {
            query.name = { $regex: searchTerm, $options: 'i' };
        }
        const tags = await Tag.find(query).sort({ name: 1 });
        res.json(tags);
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const { name, color, description } = req.body;
        if (!name || !color) return res.status(400).json({ success: false, message: 'name and color are required' });

        const tag = new Tag({ name, color, description });
        await tag.save();
        res.status(201).json(tag);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const tag = await Tag.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });
        res.json(tag);
    } catch (e) {
        next(e);
    }
}

async function remove(req, res, next) {
    try {
        const tag = await Tag.findByIdAndDelete(req.params.id);
        if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });

        // Remove this tag from all chats that have it
        await Chat.updateMany({ tags: tag._id }, { $pull: { tags: tag._id } });

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function addToChat(req, res, next) {
    try {
        const { chatId, tagId } = req.params;

        const [chat, tag] = await Promise.all([
            Chat.findById(chatId),
            Tag.findById(tagId),
        ]);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });

        // Only add if not already present
        if (!chat.tags.includes(tag._id)) {
            if (tag.name && tag.name.toLowerCase() === 'monthly' && req.user.role !== 'superadmin') {
                return res.status(403).json({ success: false, message: 'Only superadmins can assign the monthly tag.' });
            }
            chat.tags.push(tag._id);
            await chat.save();

            await ChatActivity.create({
                chatId: chat._id,
                type: 'tag_added',
                performedBy: req.user._id,
                details: { tagId: tag._id, tagName: tag.name },
            });

            const sysMessage = await Message.create({
                chatId: chat._id,
                wabaId: chat.wabaId,
                phoneNumberId: chat.phoneNumberId,
                waId: chat.waId,
                direction: 'internal',
                type: 'system',
                text: `[Tag] ${tag.name}`,
                status: 'sent',
                sentBy: req.user._id,
            });

            const { getIO } = require('../websocket/socket.server');
            getIO().emit('message:new', {
                chatId: chat._id,
                message: await sysMessage.populate('sentBy', 'name phone')
            });
        }

        res.json({ success: true, chat: await chat.populate('tags', 'name color') });
    } catch (e) {
        next(e);
    }
}

async function removeFromChat(req, res, next) {
    try {
        const { chatId, tagId } = req.params;

        const [chat, tag] = await Promise.all([
            Chat.findById(chatId),
            Tag.findById(tagId),
        ]);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });

        const before = chat.tags.length;
        if (tag.name && tag.name.toLowerCase() === 'monthly' && req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'Only superadmins can remove the monthly tag.' });
        }
        chat.tags = chat.tags.filter((t) => t.toString() !== tagId);
        if (chat.tags.length < before) {
            await chat.save();

            await ChatActivity.create({
                chatId: chat._id,
                type: 'tag_removed',
                performedBy: req.user._id,
                details: { tagId: tag._id, tagName: tag.name },
            });

            const sysMessage = await Message.create({
                chatId: chat._id,
                wabaId: chat.wabaId,
                phoneNumberId: chat.phoneNumberId,
                waId: chat.waId,
                direction: 'internal',
                type: 'system',
                text: `[Removed Tag] ${tag.name}`,
                status: 'sent',
                sentBy: req.user._id,
            });

            const { getIO } = require('../websocket/socket.server');
            getIO().emit('message:new', {
                chatId: chat._id,
                message: await sysMessage.populate('sentBy', 'name phone')
            });
        }

        res.json({ success: true, chat: await chat.populate('tags', 'name color') });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, update, remove, addToChat, removeFromChat };
