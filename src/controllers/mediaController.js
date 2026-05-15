const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('../config/logger');
const { processAndUploadImage } = require('../utils/imageProcessor');
const { s3Client, bucket } = require('../config/s3');

// Stream a video buffer straight through to S3 — videos aren't re-encoded;
// only images go through the WebP pipeline.
const uploadVideoBuffer = async (file) => {
  const ext = path.extname(file.originalname).toLowerCase() || '.bin';
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
  const key = `community/posts/video/post-vid-${unique}${ext}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `https://${bucket}.s3.amazonaws.com/${key}`;
};

/**
 * POST /posts/upload-media
 * Accepts mixed image + video uploads (multer.memoryStorage). Images are
 * re-encoded to WebP and resized; videos are uploaded as-is.
 */
const uploadMedia = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }
    if (!s3Client) {
      return res.status(500).json({ success: false, message: 'S3 not configured' });
    }

    const results = await Promise.all(
      req.files.map(async (file) => {
        if (file.mimetype.startsWith('image/')) {
          const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const out = await processAndUploadImage({
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalName: file.originalname,
            keyPrefix: `community/posts/image/post-img-${unique}`,
          });
          return out.location;
        }
        if (file.mimetype.startsWith('video/')) {
          return uploadVideoBuffer(file);
        }
        throw new Error(`Unsupported file type: ${file.mimetype}`);
      })
    );

    logger.info(`Media uploaded to S3: ${results.length} files`);
    return res.status(200).json({
      success: true,
      data: { mediaUrls: results },
      message: 'Media uploaded successfully',
    });
  } catch (error) {
    logger.error(`uploadMedia error: ${error.message}`);
    next(error);
  }
};

module.exports = { uploadMedia };
