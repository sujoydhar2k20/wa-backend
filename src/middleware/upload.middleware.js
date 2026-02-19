const multer = require('multer');
const config = require('../config');

// Memory storage for file uploads (buffer available in req.file.buffer)
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxFileSize },
});

module.exports = upload;
