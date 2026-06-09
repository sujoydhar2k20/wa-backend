const fs = require('fs');
const path = require('path');
const { BroadcastList, BroadcastListMember, Contact } = require('../models');

async function list(req, res, next) {
    try {
        const { page = 1, limit = 20, wabaId, search, q } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        const searchTerm = search || q;
        if (searchTerm) {
            filter.name = { $regex: searchTerm, $options: 'i' };
        }
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

        const content = req.file.buffer.toString('utf8');
        const lines = content.split('\n').filter(Boolean);

        // Skip header row if present; detect by checking if first line has a letter
        const dataLines = /[a-zA-Z]/.test(lines[0]?.split(',')[0]) ? lines.slice(1) : lines;

        // Get column indices from frontend mapping (if provided)
        const phoneColIdx = req.body.phoneColumn !== undefined ? parseInt(req.body.phoneColumn, 10) : 0;
        const nameColIdx = req.body.nameColumn !== undefined ? parseInt(req.body.nameColumn, 10) : -1;

        // Step 1: Parse data lines to extract unique phone numbers and mapped names
        const csvContacts = new Map(); // phoneNumber -> name
        for (const line of dataLines) {
            const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (cols.length <= phoneColIdx) continue;

            const phoneNumber = cols[phoneColIdx]?.replace(/\D/g, '');
            if (!phoneNumber || phoneNumber.length < 7) continue;

            const name = nameColIdx !== -1 && cols.length > nameColIdx ? cols[nameColIdx] : '';

            // If we have a name, prefer to store it. Otherwise, store empty if not present.
            if (!csvContacts.has(phoneNumber) || (name && !csvContacts.get(phoneNumber))) {
                csvContacts.set(phoneNumber, name);
            }
        }

        const phoneNumbers = Array.from(csvContacts.keys());
        if (phoneNumbers.length === 0) {
            const memberCount = await BroadcastListMember.countDocuments({ broadcastListId: broadcastList._id });
            return res.json({ success: true, imported: 0, total: memberCount });
        }

        // Step 2: Fetch existing contacts in a single query
        const existingContacts = await Contact.find({ phoneNumber: { $in: phoneNumbers } });
        const existingContactsMap = new Map(existingContacts.map(c => [c.phoneNumber, c]));

        // Step 3: Prepare bulk operations for Contact model
        const contactOps = [];
        for (const [phoneNumber, name] of csvContacts.entries()) {
            const contact = existingContactsMap.get(phoneNumber);
            if (!contact) {
                // Brand new contact
                contactOps.push({
                    updateOne: {
                        filter: { phoneNumber },
                        update: {
                            $setOnInsert: { phoneNumber, waId: phoneNumber },
                            $set: { name: name || phoneNumber }
                        },
                        upsert: true
                    }
                });
            } else if (name) {
                // Existing contact - update name to match Excel upload (client requirement)
                contactOps.push({
                    updateOne: {
                        filter: { phoneNumber },
                        update: {
                            $set: { name }
                        }
                    }
                });
            }
        }

        if (contactOps.length > 0) {
            await Contact.bulkWrite(contactOps);
        }

        // Step 4: Retrieve all contact IDs (including newly inserted ones) to build contactIdMap
        const allContacts = await Contact.find({ phoneNumber: { $in: phoneNumbers } }).select('_id phoneNumber');
        const contactIdMap = new Map(allContacts.map(c => [c.phoneNumber, c._id]));

        // Step 5: Prepare bulk operations for BroadcastListMember model
        const memberOps = [];
        for (const phoneNumber of phoneNumbers) {
            const contactId = contactIdMap.get(phoneNumber);
            memberOps.push({
                updateOne: {
                    filter: { broadcastListId: broadcastList._id, phoneNumber },
                    update: {
                        $set: {
                            broadcastListId: broadcastList._id,
                            phoneNumber,
                            ...(contactId ? { contactId } : {}),
                        }
                    },
                    upsert: true
                }
            });
        }

        if (memberOps.length > 0) {
            await BroadcastListMember.bulkWrite(memberOps);
        }

        const memberCount = await BroadcastListMember.countDocuments({ broadcastListId: broadcastList._id });
        await BroadcastList.findByIdAndUpdate(broadcastList._id, { memberCount, importedFile: req.file.originalname, source: 'import' });

        res.json({ success: true, imported: phoneNumbers.length, total: memberCount });
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

async function addMembers(req, res, next) {
    try {
        const broadcastList = await BroadcastList.findById(req.params.id);
        if (!broadcastList) return res.status(404).json({ success: false, message: 'Broadcast list not found' });

        const members = req.body.members; // Array of { name, phoneNumber }
        if (!members || !Array.isArray(members)) {
            return res.status(400).json({ success: false, message: 'Invalid payload: expected members array' });
        }

        const inputContacts = new Map(); // phoneNumber -> name
        for (const member of members) {
            const rawPhone = member.phoneNumber;
            if (!rawPhone) continue;

            const phoneNumber = rawPhone.toString().trim().replace(/\D/g, '');
            if (phoneNumber.length < 7) continue;

            const name = member.name?.toString().trim() || '';
            if (!inputContacts.has(phoneNumber) || (name && !inputContacts.get(phoneNumber))) {
                inputContacts.set(phoneNumber, name);
            }
        }

        const phoneNumbers = Array.from(inputContacts.keys());
        if (phoneNumbers.length === 0) {
            const memberCount = await BroadcastListMember.countDocuments({ broadcastListId: broadcastList._id });
            return res.json({ success: true, added: 0, total: memberCount });
        }

        // Fetch existing contacts
        const existingContacts = await Contact.find({ phoneNumber: { $in: phoneNumbers } });
        const existingContactsMap = new Map(existingContacts.map(c => [c.phoneNumber, c]));

        // Prepare Contact bulk operations
        const contactOps = [];
        for (const [phoneNumber, name] of inputContacts.entries()) {
            const contact = existingContactsMap.get(phoneNumber);
            if (!contact) {
                contactOps.push({
                    updateOne: {
                        filter: { phoneNumber },
                        update: {
                            $setOnInsert: { phoneNumber, waId: phoneNumber },
                            $set: { name: name || phoneNumber }
                        },
                        upsert: true
                    }
                });
            } else if (name) {
                // Overwrite name if provided (client requirement)
                contactOps.push({
                    updateOne: {
                        filter: { phoneNumber },
                        update: {
                            $set: { name }
                        }
                    }
                });
            }
        }

        if (contactOps.length > 0) {
            await Contact.bulkWrite(contactOps);
        }

        // Retrieve contact IDs
        const allContacts = await Contact.find({ phoneNumber: { $in: phoneNumbers } }).select('_id phoneNumber');
        const contactIdMap = new Map(allContacts.map(c => [c.phoneNumber, c._id]));

        // Prepare BroadcastListMember bulk operations
        const memberOps = [];
        for (const phoneNumber of phoneNumbers) {
            const contactId = contactIdMap.get(phoneNumber);
            memberOps.push({
                updateOne: {
                    filter: { broadcastListId: broadcastList._id, phoneNumber },
                    update: {
                        $set: {
                            broadcastListId: broadcastList._id,
                            phoneNumber,
                            ...(contactId ? { contactId } : {}),
                        }
                    },
                    upsert: true
                }
            });
        }

        if (memberOps.length > 0) {
            await BroadcastListMember.bulkWrite(memberOps);
        }

        const memberCount = await BroadcastListMember.countDocuments({ broadcastListId: broadcastList._id });
        await BroadcastList.findByIdAndUpdate(broadcastList._id, { memberCount });

        res.json({ success: true, added: phoneNumbers.length, total: memberCount });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, get, update, remove, importMembers, getMembers, addMembers };
