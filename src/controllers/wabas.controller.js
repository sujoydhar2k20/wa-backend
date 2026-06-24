const { Waba, Template } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const broadcastService = require('../services/broadcast.service');

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

async function createTemplate(req, res, next) {
    try {
        const { name, category, language, components } = req.body;
        const wabaId = req.params.id;

        if (!name || !category || !language || !components) {
            return res.status(400).json({ success: false, message: 'Missing required fields for template creation' });
        }

        const templateResponse = await whatsappService.createTemplate(wabaId, name, category, language, components);
        
        // Save the pending template to DB
        const template = new Template({
            wabaId,
            templateId: templateResponse.id,
            name,
            language,
            category,
            status: templateResponse.status || 'PENDING',
            components,
            metaData: templateResponse
        });
        await template.save();

        res.status(201).json({ success: true, template });
    } catch (e) {
        // More descriptive error for Meta API template creation failures
        if (e.response && e.response.data && e.response.data.error) {
            const metaError = e.response.data.error;
            return res.status(400).json({ 
                success: false, 
                message: metaError.error_user_msg || metaError.message || 'Failed to create template with Meta API',
                metaError 
            });
        }
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
        const { accessToken: rawToken, code, wabaId: sessionWabaId, phoneNumberId: sessionPhoneNumberId, tokenMode } = req.body;
        if (!rawToken && !code) {
            return res.status(400).json({ success: false, message: 'Access token or code is required' });
        }

        let accessToken;
        if (code) {
            try {
                // If tokenMode is 'short', we might still want to exchange for the initial token, 
                // but Meta Embedded Signup code exchange usually returns the best possible token for the config.
                const tokenResponse = await whatsappService.exchangeEmbeddedSignupCode(code);
                accessToken = tokenResponse.access_token;
                console.log('[EmbeddedSignup] Successfully exchanged code for token.');
            } catch (exchangeErr) {
                console.error('[EmbeddedSignup] Code exchange failed:', exchangeErr.response?.data || exchangeErr.message);
                return res.status(400).json({ success: false, message: 'Failed to exchange code for access token' });
            }
        } else {
            // Exchange the short-lived FB JS SDK token (~1-2 hours) for a long-lived token (~60 days)
            // Skip this exchange if the user explicitly requested 'short-lived' tokens
            if (tokenMode === 'short') {
                accessToken = rawToken;
                console.log('[EmbeddedSignup] Using short-lived token as requested.');
            } else {
                try {
                    accessToken = await whatsappService.getLongLivedToken(rawToken);
                    console.log(`[EmbeddedSignup] Successfully exchanged short-lived token for ${tokenMode === 'permanent' ? 'permanent-style' : 'long-lived'} token.`);
                } catch (exchangeErr) {
                    console.warn('[EmbeddedSignup] Token exchange failed, using raw token:', exchangeErr.response?.data || exchangeErr.message);
                    accessToken = rawToken;
                }
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
        const registrationWarnings = [];

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

            // 5. Register Phone Numbers
            // NOTE: With Embedded Signup v3+, Meta may auto-register the phone number.
            // We still attempt registration to handle edge cases, but gracefully skip
            // if the number is already registered (error 133004 or #100).
            let hasCriticalError = false;
            for (const pn of phoneNumbers) {
                try {
                    const dummyPin = Math.floor(100000 + Math.random() * 900000).toString();

                    // Step A: Set storage configuration for Indian numbers (must be done while unregistered)
                    if (pn.phoneNumber && pn.phoneNumber.replace(/\s/g, '').startsWith('+91')) {
                        try {
                            await whatsappService.setStorageConfiguration(pn.phoneNumberId, 'IN', accessToken);
                            console.log(`[EmbeddedSignup] Set storage configuration to IN for ${pn.phoneNumber}`);
                        } catch (settingsErr) {
                            const settingsError = settingsErr.response?.data?.error || {};
                            // If storage config fails because number is already registered, that's OK
                            console.warn(`[EmbeddedSignup] Storage config for ${pn.phoneNumber}:`, settingsError.message || settingsErr.message);
                        }
                    }

                    // Step B: Register the phone number (without data_localization_region for v21+)
                    await whatsappService.registerPhoneNumber(pn.phoneNumberId, dummyPin, accessToken);
                    console.log(`[EmbeddedSignup] Registered phone ${pn.phoneNumber}`);
                } catch (registerErr) {
                    const errorData = registerErr.response?.data?.error || {};
                    const errorCode = errorData.code;
                    const errorDetails = errorData.error_data?.details || '';

                    if (errorCode === 133016) {
                        console.error(`[EmbeddedSignup] Registration failed due to RATE LIMIT for ${pn.phoneNumber}. Stopping further attempts.`);
                        registrationWarnings.push(`Phone ${pn.phoneNumber}: Rate limited. Please wait 72 hours before trying again.`);
                        hasCriticalError = true;
                        break; 
                    } else if (errorCode === 133004) {
                        // Already registered on Cloud API — this is fine
                        console.log(`[EmbeddedSignup] Phone ${pn.phoneNumber} is already registered. Treating as success.`);
                    } else if (errorCode === 100) {
                        // Check if it's a payment method issue or just "already registered via ES v3"
                        if (errorDetails.toLowerCase().includes('payment')) {
                            console.error(`[EmbeddedSignup] Phone ${pn.phoneNumber}: Payment method required. Details: ${errorDetails}`);
                            registrationWarnings.push(
                                `Phone ${pn.phoneNumber}: ${errorDetails}. Please add a payment method in Meta Business Manager → WhatsApp Accounts → Payment Settings, then reconnect.`
                            );
                            hasCriticalError = true;
                        } else {
                            // Generic code 100 — likely already registered via Embedded Signup v3+
                            console.log(`[EmbeddedSignup] Phone ${pn.phoneNumber} is already registered (code: ${errorCode}). Treating as success.`);
                        }
                    } else {
                        console.error(`[EmbeddedSignup] Failed to register phone ${pn.phoneNumber}:`, errorData.message || registerErr.message);
                        registrationWarnings.push(`Phone ${pn.phoneNumber}: ${errorData.message || registerErr.message}`);
                    }
                }
            }

            // If a critical error occurred (e.g. missing payment method), remove the saved WABA from DB
            if (hasCriticalError) {
                console.error(`[EmbeddedSignup] Critical error for WABA ${wabaData.wabaId}. Removing from DB.`);
                await Waba.deleteOne({ wabaId: wabaDetails.id });
                continue;
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

        const response = { success: true, wabas: savedWabas };
        if (registrationWarnings.length > 0) {
            response.warnings = registrationWarnings;
        }
        res.json(response);
    } catch (e) {
        console.error('Embedded Signup Error:', e.response?.data || e.message);
        next(e);
    }
}

/**
 * Get the messaging quota for a WABA phone number.
 * Returns daily limit (from WhatsApp tier), sent today count, and remaining.
 */
async function getQuota(req, res, next) {
    try {
        const wabaId = req.params.id;
        const { phoneNumberId } = req.query;

        if (!phoneNumberId) {
            // If no specific phone number, get the first one
            const waba = await Waba.findById(wabaId);
            if (!waba) return res.status(404).json({ success: false, message: 'WABA not found' });
            const firstPhone = waba.phoneNumbers?.[0];
            if (!firstPhone) return res.status(400).json({ success: false, message: 'No phone numbers found' });
            req.query.phoneNumberId = firstPhone.phoneNumberId;
        }

        const { messagingLimit, messagingLimitTier } = await broadcastService.getMessagingLimit(wabaId, req.query.phoneNumberId);
        const sentToday = await broadcastService.getSentTodayCount(wabaId);
        const remaining = messagingLimit === Infinity ? 'Unlimited' : Math.max(0, messagingLimit - sentToday);

        res.json({
            success: true,
            dailyLimit: messagingLimit === Infinity ? 'Unlimited' : messagingLimit,
            messagingLimitTier: messagingLimitTier || 'TIER_100K',
            sentToday,
            remaining,
            phoneNumberId: req.query.phoneNumberId,
        });
    } catch (e) {
        next(e);
    }
}

async function uploadTemplateHeaderImage(req, res, next) {
    try {
        const { wabaId: wabaIdParam, templateName } = req.params;
        const { Waba, Template } = require('../models');
        const { logger } = require('../utils/logger');

        // Validate input
        if (!wabaIdParam || !templateName || !req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'wabaId, templateName, and image file are required' 
            });
        }

        // Get WABA to access phoneNumberId
        const waba = await Waba.findById(wabaIdParam);
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }

        // Get template from database
        const template = await Template.findOne({ wabaId: wabaIdParam, name: templateName });
        if (!template) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }

        // Upload image to Meta
        const whatsappService = require('../services/whatsapp.service');
        const phoneNumberId = waba.phoneNumbers?.[0]?.phoneNumberId;
        if (!phoneNumberId) {
            return res.status(400).json({ success: false, message: 'No phone number configured' });
        }

        const mediaId = await whatsappService.uploadMedia(wabaIdParam, phoneNumberId, req.file.buffer, req.file.mimetype);
        console.log(`[DEBUG] Uploaded custom header image for template ${templateName}, mediaId: ${mediaId}`);

        // Update template with custom image mediaId
        const headerComponent = template.components?.find(c => (c.type || '').toUpperCase() === 'HEADER');
        if (headerComponent) {
            headerComponent.imageMediaId = mediaId;
            // Optionally clear the pre-approved imageUrl since we're using custom
            // headerComponent.imageUrl = null; // Uncomment if you want to replace
        }
        await template.save();

        res.json({
            success: true,
            message: 'Custom header image uploaded successfully',
            mediaId,
            template
        });
    } catch (e) {
        console.error('[ERROR] Failed to upload template header image:', e.message);
        if (e.response?.data?.error) {
            return res.status(400).json({
                success: false,
                message: 'Failed to upload image to Meta: ' + (e.response.data.error.message || e.message),
            });
        }
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
    createTemplate,
    getQuota,
    uploadTemplateHeaderImage,
};
