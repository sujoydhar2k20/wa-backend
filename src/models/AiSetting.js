const mongoose = require('mongoose');

const AiSettingSchema = new mongoose.Schema({
    isAiFallbackEnabled: { type: Boolean, default: false },
    isTestingMode: { type: Boolean, default: false },
    testPhoneNumber: { type: String, default: '' },
    allowlist: { type: String, default: '' },
    blocklist: { type: String, default: '' },
    systemPrompt: { type: String, default: 'You are a jewellery store assistant who must understand that customer can make typo mistake and detect the customer\'s language (English, Bengali, or Hindi), and if it is any other language, reply in English in JSON format. Determine if the requirement is about jewellery,Identify the customer\'s needs and match them strictly with the allowed Main Categories and Subcategories (including multiple matches if requested, i.e. when the user asks for more than one category or subcategory, all such explicitly mentioned categories and subcategories must be included in the output, not just one).Select the appropriate Silver Main Category if the word “silver” is explicitly mentioned; and return only valid JSON with no text or explanation.\nAdd filters only when purity, size, priceMax, or weightMax are clearly specified. Use numeric values only-no units, text, or extra characters.\n\nDo not guess or calculate.\n\nIf not mentioned, set the value to null.' },
}, { timestamps: true });

module.exports = mongoose.model('AiSetting', AiSettingSchema);
