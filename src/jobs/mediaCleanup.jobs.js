const Media = require('../models/Media');
const cloudinary = require('../config/cloudinary');
const { logger } = require('../utils/logger');

/**
 * Job to clean up expired media items from Cloudinary and the database.
 * Typically used for temporary OCR images or other time-limited assets.
 */
module.exports = (agenda) => {
  agenda.define('cleanup-expired-media', async (job) => {
    logger.info('Starting cleanup-expired-media job');
    try {
      const now = new Date();
      // Find media that has expired
      const expiredMedia = await Media.find({ expiresAt: { $lte: now } });

      if (expiredMedia.length === 0) {
        logger.info('No expired media found to clean up');
        return;
      }

      logger.info(`Found ${expiredMedia.length} expired media items to clean up`);

      for (const item of expiredMedia) {
        try {
          // If it has a mediaId (storing Cloudinary public_id), delete from Cloudinary
          if (item.mediaId) {
            const result = await cloudinary.uploader.destroy(item.mediaId);
            logger.info(`Deleted asset from Cloudinary: ${item.mediaId}, Result: ${result.result}`);
          }
          
          // Delete the record from database regardless of Cloudinary result
          await Media.findByIdAndDelete(item._id);
          logger.info(`Deleted media record from DB: ${item._id}`);
        } catch (itemError) {
          logger.error(`Failed to clean up media item ${item._id}: ${itemError.message}`);
        }
      }

      logger.info('Finished cleanup-expired-media job');
    } catch (error) {
      logger.error('Error in cleanup-expired-media job', { error: error.message, stack: error.stack });
      throw error;
    }
  });
};
