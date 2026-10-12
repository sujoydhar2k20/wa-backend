const mongoose = require('mongoose');

/**
 * Load a chat in the exact shape the web panel and Android app expect in
 * `chat:update` socket events: ownership fields (assignedTo, collaborators) and
 * the other relations are populated, never bare ObjectIds.
 *
 * Clients merge this payload into their local copy of the chat. Emitting a chat
 * whose `assignedTo` is an unpopulated id makes them render the chat as
 * "Unassigned" even though the database still holds the assignment.
 */
async function loadChatForSocket(chatId) {
  const Chat = mongoose.model('Chat');
  return Chat.findById(chatId)
    .populate('contactId', 'name nameOnWhatsApp nickname profilePicture isOptedOut isBlocked customFields')
    .populate('assignedTo', 'name phone')
    .populate('wabaId', 'businessName phoneNumbers')
    .populate('collaborators', 'name phone')
    .populate('tags', 'name color')
    .lean();
}

module.exports = { loadChatForSocket };
