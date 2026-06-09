const { AiSetting } = require('../models');

// We use a singleton pattern for Settings. There should only be one document.

async function getAiSettings(req, res, next) {
    try {
        let settings = await AiSetting.findOne();
        if (!settings) {
            settings = await AiSetting.create({});
        }
        res.json({ success: true, data: settings });
    } catch (e) {
        next(e);
    }
}

async function updateAiSettings(req, res, next) {
    try {
        const { isAiFallbackEnabled, isTestingMode, testPhoneNumber, allowlist, blocklist, systemPrompt, blockedPhoneNumbers } = req.body;
        
        let settings = await AiSetting.findOne();
        if (!settings) {
            settings = new AiSetting({});
        }

        if (isAiFallbackEnabled !== undefined) settings.isAiFallbackEnabled = isAiFallbackEnabled;
        if (isTestingMode !== undefined) settings.isTestingMode = isTestingMode;
        if (testPhoneNumber !== undefined) settings.testPhoneNumber = testPhoneNumber;
        if (allowlist !== undefined) settings.allowlist = allowlist;
        if (blocklist !== undefined) settings.blocklist = blocklist;
        if (systemPrompt !== undefined) settings.systemPrompt = systemPrompt;
        if (blockedPhoneNumbers !== undefined) settings.blockedPhoneNumbers = blockedPhoneNumbers;

        await settings.save();
        res.json({ success: true, data: settings });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    getAiSettings,
    updateAiSettings
};
