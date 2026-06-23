const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  latitude: Number,
  longitude: Number,
  name: String,
  address: String,
}, { _id: false });

const reactionSchema = new mongoose.Schema({
  messageId: String,
  emoji: String,
}, { _id: false });

const quotedMessageSchema = new mongoose.Schema({
  messageId: String,          // WhatsApp message ID of the quoted message
  text: String,               // Preview text of the quoted message
  type: String,               // Message type (text, image, video, audio, document, etc)
  waId: String,               // Sender's phone number
  senderName: String,         // Display name of the sender
  caption: String,            // Caption if it's a media message
  mediaUrl: String,           // Media URL for preview (image/video thumbnails)
}, { _id: false });

const messageSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', index: true },
    phoneNumberId: { type: String },
    messageId: { type: String, index: true, unique: true, sparse: true },
    waId: { type: String },
    direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'sticker', 'reaction', 'note', 'system', 'template', 'interactive'], default: 'text' },
    text: { type: String },
    mediaUrl: { type: String },
    mediaId: { type: String },
    mimeType: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    caption: { type: String },
    location: locationSchema,
    reactions: [{
      emoji: String,
      by: String // waId or Staff ID representing who reacted
    }],
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed'] },
    statusTimestamp: { type: Date },
    errorCode: { type: Number },
    errorMessage: { type: String },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentByBot: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed },
    replyToMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    quotedMessage: quotedMessageSchema,
  },
  { timestamps: true }
);

messageSchema.index({ chatId: 1, createdAt: -1 });

messageSchema.post('save', async function(doc) {
  try {
    const Chat = mongoose.model('Chat');
    const chat = await Chat.findById(doc.chatId);
    if (!chat) return;

    // Check if there is any message in the chat that has a later createdAt time
    // If not, this is the latest message and we should update the chat fields.
    const Message = mongoose.model('Message');
    const newerMessageExists = await Message.findOne({
      chatId: doc.chatId,
      createdAt: { $gt: doc.createdAt || new Date() }
    }).select('_id');

    if (!newerMessageExists) {
      // Format the snippet text based on the message type
      let snippet = '';
      switch (doc.type) {
        case 'text':
          snippet = doc.text || '';
          break;
        case 'image':
          snippet = doc.caption || '📷 Photo';
          break;
        case 'video':
          snippet = doc.caption || '🎥 Video';
          break;
        case 'audio':
          snippet = '🎙️ Voice Message';
          break;
        case 'document':
          snippet = doc.fileName ? `📄 ${doc.fileName}` : '📄 Document';
          break;
        case 'location':
          snippet = '📍 Location';
          break;
        case 'sticker':
          snippet = '🖼️ Sticker';
          break;
        case 'note':
          snippet = `📝 Note: ${doc.text || ''}`;
          break;
        case 'system':
          snippet = doc.text || '';
          break;
        case 'template':
          snippet = doc.text || '📄 Template Message';
          break;
        case 'interactive':
          snippet = doc.text || '🔘 Interactive Message';
          break;
        default:
          snippet = doc.text || '';
      }

      const updateData = {
        lastMessageText: snippet,
        lastMessageDirection: doc.direction,
        lastMessageStatus: doc.status,
        lastMessageAt: doc.createdAt || new Date(),
      };

      if (doc.direction === 'inbound') {
        updateData.lastCustomerMessageAt = doc.createdAt || new Date();
      } else if (doc.direction === 'outbound') {
        updateData.lastStaffMessageAt = doc.createdAt || new Date();
      }

      // Update Chat in database
      const updatedChat = await Chat.findByIdAndUpdate(
        doc.chatId,
        { $set: updateData },
        { new: true }
      )
      .populate('contactId', 'name nameOnWhatsApp nickname profilePicture isOptedOut isBlocked customFields')
      .populate('assignedTo', 'name phone')
      .populate('wabaId', 'businessName phoneNumbers')
      .populate('collaborators', 'name phone')
      .populate('tags', 'name color')
      .lean();

      if (updatedChat) {
        try {
          const { getIO } = require('../websocket/socket.server');
          const io = getIO();
          io.emit('chat:update', {
            chatId: doc.chatId.toString(),
            chat: {
              ...updatedChat,
              lastMessage: doc.toObject ? doc.toObject() : doc
            }
          });
        } catch (socketErr) {
          // Socket might not be initialized yet (e.g. in some server contexts / testing)
          console.warn('Socket emit failed in Message post-save hook:', socketErr.message);
        }
      }
    }
  } catch (err) {
    console.error('Error in Message post-save hook:', err);
  }
});

module.exports = mongoose.model('Message', messageSchema);
