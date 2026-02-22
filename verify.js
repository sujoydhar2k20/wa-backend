require('dotenv').config();
const fs = require('fs');
const { connectDB } = require('./src/config/database');
const { Message, Chat } = require('./src/models');

async function test() {
    await connectDB();
    const msgs = await Message.find().sort({ createdAt: -1 }).limit(1);
    const chats = await Chat.find().sort({ createdAt: -1 }).limit(1);
    const result = {
        message: msgs[0],
        chat: chats[0]
    };
    fs.writeFileSync('verify.json', JSON.stringify(result, null, 2));
    process.exit(0);
}
test();
