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

async function remove(req, res, next) {
    try {
        const waba = await Waba.findByIdAndDelete(req.params.id);
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }
        res.json({ success: true, message: 'WABA removed successfully' });
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

async function getAllTemplates(req, res, next) {
    try {
        const { wabaId, status, category, search } = req.query;
        let query = {};

        // Handle filter by multiple wabaIds if needed, but for now exact match or array match
        if (wabaId) {
            if (Array.isArray(wabaId)) {
                query.wabaId = { $in: wabaId };
            } else if (wabaId.includes(',')) {
                query.wabaId = { $in: wabaId.split(',') };
            } else {
                query.wabaId = wabaId;
            }
        }

        if (status) query.status = status;
        if (category) query.category = category;
        if (search) query.name = { $regex: search, $options: 'i' };

        // Populate wabaId to get the businessName and phoneNumbers
        const templates = await Template.find(query)
            .populate('wabaId', 'businessName phoneNumbers')
            .sort({ createdAt: -1 });

        res.json(templates);
    } catch (e) {
        next(e);
    }
}

async function embeddedSignup(req, res, next) {
    try {
        const { accessToken: rawToken, code, wabaId: sessionWabaId, phoneNumberId: sessionPhoneNumberId } = req.body;
        if (!rawToken && !code) {
            return res.status(400).json({ success: false, message: 'Access token or code is required' });
        }

        let accessToken;
        if (code) {
            try {
                const tokenResponse = await whatsappService.exchangeEmbeddedSignupCode(code);
                accessToken = tokenResponse.access_token;
                console.log('[EmbeddedSignup] Successfully exchanged code for long-lived token.');
            } catch (exchangeErr) {
                console.error('[EmbeddedSignup] Code exchange failed:', exchangeErr.response?.data || exchangeErr.message);
                return res.status(400).json({ success: false, message: 'Failed to exchange code for access token' });
            }
        } else {
            // Exchange the short-lived FB JS SDK token (~1-2 hours) for a long-lived token (~60 days)
            try {
                accessToken = await whatsappService.getLongLivedToken(rawToken);
                console.log('[EmbeddedSignup] Successfully exchanged short-lived token for long-lived token.');
            } catch (exchangeErr) {
                console.warn('[EmbeddedSignup] Token exchange failed, using raw token:', exchangeErr.response?.data || exchangeErr.message);
                // Fall back to raw token if exchange fails (e.g. already a long-lived token)
                accessToken = rawToken;
            }
        }

        // Determine WABA IDs and phone IDs to process
        let wabaIds = [];
        let phoneIds = [];

        if (sessionWabaId) {
            // Use session info from Facebook embedded signup message event (preferred)
            wabaIds = [sessionWabaId];
            phoneIds = sessionPhoneNumberId ? [sessionPhoneNumberId] : [];
            console.log('[EmbeddedSignup] Using session info - WABA:', sessionWabaId, 'Phone:', sessionPhoneNumberId);
        } else {
            // Fallback: Fetch WABA IDs from debug_token
            const tokenData = await whatsappService.getWabasFromToken(accessToken);
            wabaIds = tokenData.wabaIds || [];
            phoneIds = tokenData.phoneIds || [];
            console.log('[EmbeddedSignup] Using debug_token - WABAs:', wabaIds, 'Phones:', phoneIds);
        }

        if (!wabaIds || wabaIds.length === 0) {
            return res.status(404).json({ success: false, message: 'No WhatsApp Business Accounts found for this token' });
        }

        const savedWabas = [];

        // 3. Process each WABA
        for (const wabaId of wabaIds) {
            const wabaDetails = await whatsappService.getWabaDetails(wabaId, accessToken);

            // Ensure type-safe comparison for phone IDs
            const safePhoneIds = phoneIds.map(String);
            const phoneNumbers = (wabaDetails.phone_numbers?.data || [])
                .filter(pn => safePhoneIds.length > 0 ? safePhoneIds.includes(String(pn.id)) : true)
                .map(pn => ({
                    phoneNumberId: String(pn.id),
                    phoneNumber: pn.display_phone_number,
                    verifiedName: pn.verified_name,
                    qualityRating: pn.quality_rating
                }));

            // Skip saving WABAs that do not have any authorized phone numbers
            // This prevents saving multiple empty/duplicate WABA entries
            if (phoneNumbers.length === 0) {
                console.log(`[EmbeddedSignup] Skipping WABA ${wabaDetails.id} - no authorized phone numbers found.`);
                continue;
            }


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

                    // Meta API v21+ requires data_localization_region for Indian numbers (+91)
                    let region = undefined;
                    const cleanPhone = pn.phoneNumber.replace(/\D/g, '');
                    if (cleanPhone.startsWith('91')) {
                        region = 'IN';
                    }

                    await whatsappService.registerPhoneNumber(pn.phoneNumberId, dummyPin, accessToken, region);
                } catch (registerErr) {
                    console.error('Failed to register phone number (may already be registered):', registerErr.response?.data || registerErr.message);
                }
            }

            // 6. Subscribe App to WABA webhooks
            try {
                await whatsappService.subscribeAppToWaba(wabaData.wabaId, accessToken);
                console.log(`Subscribed app to webhooks for WABA ${wabaData.wabaId}`);
            } catch (subErr) {
                console.error(`Failed to subscribe app to WABA webhooks for ${wabaData.wabaId}:`, subErr.response?.data || subErr.message);
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
    remove,
    syncTemplates,
    getTemplates,
    getAllTemplates,
    embeddedSignup,
};
