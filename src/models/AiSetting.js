const mongoose = require('mongoose');

const AiSettingSchema = new mongoose.Schema({
    isAiFallbackEnabled: { type: Boolean, default: false },
    isTestingMode: { type: Boolean, default: false },
    testPhoneNumber: { type: String, default: '' },
    allowlist: { type: String, default: '' },
    blocklist: { type: String, default: '' },
    blockedPhoneNumbers: { type: String, default: '' },
    systemPrompt: { type: String, default: '' },
    
    // Filters and language configurations
    filterParameters: { type: [String], default: ['&purity=', '&size=', '&priceMax=', '&weightMax='] },
    
    englishGreeting: { type: String, default: '✨ Here are the results for your search:' },
    englishViewText: { type: String, default: '👉 View' },
    
    hindiGreeting: { type: String, default: '✨ यहाँ आपकी खोज के नतीजे हैं:' },
    hindiViewText: { type: String, default: '👉 देखें' },
    
    bengaliGreeting: { type: String, default: '✨ আপনার অনুসন্ধানের ফলাফল এখানে:' },
    bengaliViewText: { type: String, default: '👉 দেখুন' }
}, { timestamps: true });

module.exports = mongoose.model('AiSetting', AiSettingSchema);
