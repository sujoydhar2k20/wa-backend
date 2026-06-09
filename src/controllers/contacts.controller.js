const fs = require('fs');
const { Contact } = require('../models');

async function list(req, res, next) {
    try {
        const { page = 1, limit = 20, q, isOptedOut, isBlocked } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (q) filter.$or = [
            { name: { $regex: q, $options: 'i' } },
            { phoneNumber: { $regex: q, $options: 'i' } },
        ];
        if (isOptedOut !== undefined) filter.isOptedOut = isOptedOut === 'true';
        if (isBlocked !== undefined) filter.isBlocked = isBlocked === 'true';

        const [contacts, total] = await Promise.all([
            Contact.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('tags', 'name color'),
            Contact.countDocuments(filter),
        ]);
        res.json({ data: contacts, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const contact = await Contact.findById(req.params.id).populate('tags', 'name color');
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
        res.json(contact);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const contact = await Contact.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
        res.json(contact);
    } catch (e) {
        next(e);
    }
}

async function optOut(req, res, next) {
    try {
        const contact = await Contact.findByIdAndUpdate(
            req.params.id,
            { isOptedOut: true, optedOutAt: new Date() },
            { new: true }
        );
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
        res.json(contact);
    } catch (e) {
        next(e);
    }
}

async function optIn(req, res, next) {
    try {
        const contact = await Contact.findByIdAndUpdate(
            req.params.id,
            { isOptedOut: false, optedOutAt: null },
            { new: true }
        );
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
        res.json(contact);
    } catch (e) {
        next(e);
    }
}

async function block(req, res, next) {
    try {
        const { blocked = true } = req.body;
        const contact = await Contact.findByIdAndUpdate(
            req.params.id,
            { isBlocked: blocked, blockedAt: blocked ? new Date() : null },
            { new: true }
        );
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
        res.json(contact);
    } catch (e) {
        next(e);
    }
}

async function importContacts(req, res, next) {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const content = fs.readFileSync(req.file.path, 'utf8');
        const lines = content.split('\n').filter(Boolean);

        // Skip header if first cell is non-numeric
        const dataLines = /[a-zA-Z]/.test(lines[0]?.split(',')[0]) ? lines.slice(1) : lines;

        let importedCount = 0;
        const ops = [];
        for (const line of dataLines) {
            const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
            const phoneNumber = cols[0]?.replace(/\D/g, '');
            if (!phoneNumber || phoneNumber.length < 7) continue;
            ops.push({
                updateOne: {
                    filter: { phoneNumber },
                    update: {
                        $setOnInsert: { phoneNumber },
                        $set: {
                            ...(cols[1] ? { name: cols[1] } : {}),
                            ...(cols[2] ? { waId: cols[2] } : {}),
                        },
                    },
                    upsert: true,
                },
            });
            importedCount++;
        }

        if (ops.length > 0) await Contact.bulkWrite(ops);

        // Clean up file
        try { fs.unlinkSync(req.file.path); } catch (_) { }

        res.json({ success: true, imported: importedCount });
    } catch (e) {
        next(e);
    }
}

async function remove(req, res, next) {
    try {
        const contactId = req.params.id;
        const contact = await Contact.findById(contactId);
        if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

        const { Chat, Message } = require('../models');
        
        // Find all chats for this contact
        const chats = await Chat.find({ contactId });
        const chatIds = chats.map(c => c._id);

        // Cascading delete messages, chats, and finally the contact
        await Message.deleteMany({ chatId: { $in: chatIds } });
        await Chat.deleteMany({ contactId });
        await Contact.findByIdAndDelete(contactId);

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function bulkDelete(req, res, next) {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or empty IDs list' });
        }

        const { Chat, Message } = require('../models');

        // Find all chats for these contacts
        const chats = await Chat.find({ contactId: { $in: ids } });
        const chatIds = chats.map(c => c._id);

        // Cascading delete messages, chats, and finally the contacts
        await Message.deleteMany({ chatId: { $in: chatIds } });
        await Chat.deleteMany({ contactId: { $in: ids } });
        await Contact.deleteMany({ _id: { $in: ids } });

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, get, update, optOut, optIn, block, import: importContacts, remove, bulkDelete };
