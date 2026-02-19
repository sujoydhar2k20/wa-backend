const { Note, Chat } = require('../models');

async function listByChat(req, res, next) {
    try {
        const { chatId } = req.params;
        const { page = 1, limit = 30 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        const chat = await Chat.findById(chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const [notes, total] = await Promise.all([
            Note.find({ chatId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('createdBy', 'name phone'),
            Note.countDocuments({ chatId }),
        ]);

        res.json({ data: notes, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const { chatId } = req.params;
        const { content } = req.body;
        if (!content) return res.status(400).json({ success: false, message: 'content is required' });

        const chat = await Chat.findById(chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const note = await Note.create({
            chatId,
            content,
            createdBy: req.user._id,
        });

        await note.populate('createdBy', 'name phone');
        res.status(201).json(note);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ success: false, message: 'content is required' });

        const note = await Note.findById(req.params.id);
        if (!note) return res.status(404).json({ success: false, message: 'Note not found' });

        // Only the creator can edit
        if (note.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        note.content = content;
        await note.save();
        await note.populate('createdBy', 'name phone');
        res.json(note);
    } catch (e) {
        next(e);
    }
}

async function remove(req, res, next) {
    try {
        const note = await Note.findById(req.params.id);
        if (!note) return res.status(404).json({ success: false, message: 'Note not found' });

        if (note.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        await note.deleteOne();
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

module.exports = { listByChat, create, update, remove };
