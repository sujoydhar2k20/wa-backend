const { Tag, Contact, Chat } = require('../models');

/**
 * Checks if the "monthly" tag exists and retrieves its ID.
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - rethrow database errors instead of answering "no tag".
 *   Callers that would otherwise act on a customer (e.g. automatic assignment) use strict mode so a
 *   failed lookup never makes a monthly customer look untagged.
 * @returns {Promise<string|null>} The Tag ID as string, or null.
 */
async function getMonthlyTagId({ strict = false } = {}) {
    try {
        const tag = await Tag.findOne({ name: { $regex: /^monthly$/i } });
        return tag ? tag._id.toString() : null;
    } catch (err) {
        if (strict) throw err;
        return null;
    }
}

/**
 * Checks if a chat or contact has the "monthly" tag.
 * @param {Object} params
 * @param {Object} [params.chat] - Chat mongoose document or object.
 * @param {Object} [params.contact] - Contact mongoose document or object.
 * @param {Object} [options] - { strict }: see getMonthlyTagId.
 * @returns {Promise<boolean>}
 */
async function isMonthly(params = {}, { strict = false } = {}) {
    const { chat, contact } = params;
    const monthlyTagId = await getMonthlyTagId({ strict });
    if (!monthlyTagId) return false;

    // Helper to check if tags array contains monthlyTagId
    const hasTag = (tagsArray) => {
        if (!tagsArray || !Array.isArray(tagsArray)) return false;
        return tagsArray.some(t => {
            if (!t) return false;
            // Handle if t is populated (object with _id or name) or ObjectId
            const id = t._id ? t._id.toString() : t.toString();
            return id === monthlyTagId;
        });
    };

    if (chat && hasTag(chat.tags)) return true;
    if (contact && hasTag(contact.tags)) return true;

    // If chat is provided but contact is not, and contactId is a ref, check contact tags.
    // NOTE: a populated contact is an object with a `tags` array; a raw ObjectId is ALSO
    // `typeof 'object'`, so we must detect the populated case by the presence of a tags
    // array — otherwise we'd read `.tags` off an ObjectId (undefined) and skip the DB lookup.
    if (chat && chat.contactId && !contact) {
        const ref = chat.contactId;
        if (ref && typeof ref === 'object' && Array.isArray(ref.tags)) {
            if (hasTag(ref.tags)) return true;
        } else {
            const dbContact = await Contact.findById(ref).select('tags').lean();
            if (dbContact && hasTag(dbContact.tags)) return true;
        }
    }

    // If contact is provided but chat is not, check if we have a chat for this contact with the tag
    if (contact && !chat) {
        const dbChat = await Chat.findOne({ contactId: contact._id }).select('tags').lean();
        if (dbChat && hasTag(dbChat.tags)) return true;
    }

    return false;
}

module.exports = {
    getMonthlyTagId,
    isMonthly
};
