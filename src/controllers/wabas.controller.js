const { Waba, Template } = require('../models');
const whatsappService = require('../services/whatsapp.service');

async function list(req, res, next) {
    try {
        const wabas = await Waba.find().sort({ createdAt: -1 });
        res.json(wabas);
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const waba = new Waba(req.body);
        await waba.save();
        res.status(201).json(waba);
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const waba = await Waba.findById(req.params.id);
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }
        res.json(waba);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const waba = await Waba.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }
        res.json(waba);
    } catch (e) {
        next(e);
    }
}

async function syncTemplates(req, res, next) {
    try {
        const templates = await whatsappService.syncTemplates(req.params.id);
        res.json({ success: true, count: templates.length });
    } catch (e) {
        next(e);
    }
}

async function getTemplates(req, res, next) {
    try {
        const templates = await Template.find({ wabaId: req.params.id }).sort({ name: 1 });
        res.json(templates);
    } catch (e) {
        next(e);
    }
}

async function embeddedSignup(req, res, next) {
    try {
        const { accessToken } = req.body;
        if (!accessToken) {
            return res.status(400).json({ success: false, message: 'Access token is required' });
        }

        // Access token comes directly from the FB JS SDK - no code exchange needed

        // 2. Fetch WABA IDs associated with the token
        const wabaIds = await whatsappService.getWabasFromToken(accessToken);
        if (!wabaIds || wabaIds.length === 0) {
            return res.status(404).json({ success: false, message: 'No WhatsApp Business Accounts found for this token' });
        }

        const savedWabas = [];

        // 3. Process each WABA
        for (const wabaId of wabaIds) {
            const wabaDetails = await whatsappService.getWabaDetails(wabaId, accessToken);

            // Format phone numbers
            const phoneNumbers = (wabaDetails.phone_numbers?.data || []).map(pn => ({
                phoneNumberId: pn.id,
                phoneNumber: pn.display_phone_number,
                verifiedName: pn.verified_name,
                qualityRating: pn.quality_rating
            }));

            const wabaData = {
                wabaId: wabaDetails.id,
                businessName: wabaDetails.name || 'WhatsApp Business',
                accessToken: accessToken,
                phoneNumbers: phoneNumbers,
                isActive: true
            };

            // 4. Update or Create WABA in DB
            const waba = await Waba.findOneAndUpdate(
                { wabaId: wabaDetails.id },
                wabaData,
                { new: true, upsert: true, runValidators: true }
            );

            // 5. Optionally Register Phone Numbers
            for (const pn of phoneNumbers) {
                try {
                    // Using a dummy pin since we assume new registration.
                    // If the number is already registered, this might throw but it's fine.
                    const dummyPin = Math.floor(100000 + Math.random() * 900000).toString();
                    await whatsappService.registerPhoneNumber(pn.phoneNumberId, dummyPin, accessToken);
                } catch (registerErr) {
                    console.error('Failed to register phone number (may already be registered):', registerErr.response?.data || registerErr.message);
                }
            }

            savedWabas.push(waba);
        }

        res.json({ success: true, wabas: savedWabas });
    } catch (e) {
        console.error('Embedded Signup Error:', e.response?.data || e.message);
        next(e);
    }
}

module.exports = {
    list,
    create,
    get,
    update,
    syncTemplates,
    getTemplates,
    embeddedSignup,
};
