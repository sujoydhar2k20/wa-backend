const fs = require('fs');
const path = require('path');
const { BroadcastList, BroadcastListMember, Contact } = require('../models');

async function list(req, res, next) {
    try {
        const { page = 1, limit = 20, wabaId } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        const [lists, total] = await Promise.all([
            BroadcastList.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)),
            BroadcastList.countDocuments(filter),
        ]);
        res.json({ data: lists, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const broadcastList = new BroadcastList(req.body);
        await broadcastList.save();
        res.status(201).json(broadcastList);
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const broadcastList = await BroadcastList.findById(req.params.id);
        if (!broadcastList) return res.status(404).json({ success: false, message: 'Broadcast list not found' });
        res.json(broadcastList);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const broadcastList = await BroadcastList.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!broadcastList) return res.status(404).json({ success: false, message: 'Broadcast list not found' });
        res.json(broadcastList);
    } catch (e) {
        next(e);
    }
}

async function remove(req, res, next) {
    try {
        const broadcastList = await BroadcastList.findByIdAndDelete(req.params.id);
        if (!broadcastList) return res.status(404).json({ success: false, message: 'Broadcast list not found' });
        await BroadcastListMember.deleteMany({ broadcastListId: req.params.id });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function importMembers(req, res, next) {
    try {
        const broadcastList = await BroadcastList.findById(req.params.id);
        if (!broadcastList) return res.status(404).json({ success: false, message: 'Broadcast list not found' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const filePath = req.file.path;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);

        // Skip header row if present; detect by checking if first line has a letter
        const dataLines = /[a-zA-Z]/.test(lines[0]?.split(',')[0]) ? lines.slice(1) : lines;

        // Get column indices from frontend mapping (if provided)
        const phoneColIdx = req.body.phoneColumn !== undefined ? parseInt(req.body.phoneColumn, 10) : 0;
        const nameColIdx = req.body.nameColumn !== undefined ? parseInt(req.body.nameColumn, 10) : -1;

        let importedCount = 0;
        const ops = [];
        for (const line of dataLines) {
            const cols = line.split(',');
            if (cols.length <= phoneColIdx) continue;

            const phoneNumber = cols[phoneColIdx]?.trim().replace(/\D/g, '');
            if (!phoneNumber || phoneNumber.length < 7) continue;

            let contact = await Contact.findOne({ phoneNumber });

            // Auto-create or update Contact if Name column was mapped
            if (nameColIdx !== -1 && cols.length > nameColIdx) {
                const name = cols[nameColIdx]?.trim();
                if (name) {
                    if (contact) {
                        // Optionally update name if blank, but typically we keep existing 
                        if (!contact.name || contact.name === phoneNumber) {
                            contact.name = name;
                            await contact.save();
                        }
                    } else {
                        // Create brand new contact
                        contact = new Contact({
                            phoneNumber,
                            waId: phoneNumber,
                            name,
                        });
                        await contact.save();
                    }
                }
            }

            ops.push({
                updateOne: {
                    filter: { broadcastListId: broadcastList._id, phoneNumber },
                    update: {
                        $set: {
                            broadcastListId: broadcastList._id,
                            phoneNumber,
                            ...(contact ? { contactId: contact._id } : {}),
                        },
                    },
                    upsert: true,
                },
            });
            importedCount++;
        }

        if (ops.length > 0) await BroadcastListMember.bulkWrite(ops);

        const memberCount = await BroadcastListMember.countDocuments({ broadcastListId: broadcastList._id });
        await BroadcastList.findByIdAndUpdate(broadcastList._id, { memberCount, importedFile: req.file.originalname, source: 'import' });

        // Clean up uploaded file
        try { fs.unlinkSync(filePath); } catch (_) { }

        res.json({ success: true, imported: importedCount, total: memberCount });
    } catch (e) {
        next(e);
    }
}

async function getMembers(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { broadcastListId: req.params.id };
        const [members, total] = await Promise.all([
            BroadcastListMember.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name phoneNumber profilePicture'),
            BroadcastListMember.countDocuments(filter),
        ]);
        res.json({ data: members, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, get, update, remove, importMembers, getMembers };
