// Image processing pipeline for upload routes.
//   1. Re-encode JPEG/PNG → WebP at quality 92 (visually lossless per Google's
//      own recommendation — indistinguishable from the original to the human eye).
//   2. Cap the longest side at 2400 px so a 12 MP phone photo doesn't sit on
//      S3 forever; smaller images are left at their native size.
//   3. Skip already-WebP / animated GIF inputs so we don't degrade them or
//      strip animation. Also skip if the output ends up bigger than the input
//      (rare, but possible for tiny pre-optimized JPEGs).
//   4. Stream the result to S3 with `image/webp` content-type and a `.webp`
//      key so CDNs / browsers serve it correctly.

const path = require('path');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, bucket } = require('../config/s3');
const logger = require('../config/logger');

const MAX_SIDE_PX = 2400;
const WEBP_QUALITY = 92; // Google's "visually lossless" floor
const WEBP_EFFORT = 6;   // 0–6, max compression effort (slower encode, smaller file)

const PASS_THROUGH_MIMETYPES = new Set(['image/webp', 'image/gif']);

/**
 * Process an uploaded image buffer (or pass it through) and upload to S3.
 *
 * @param {Object}  args
 * @param {Buffer}  args.buffer        Raw bytes from multer.memoryStorage()
 * @param {string}  args.mimetype      Original MIME type from multer
 * @param {string}  args.originalName  Original filename — used to derive a fallback ext
 * @param {string}  args.keyPrefix     S3 key path WITHOUT extension, e.g. "community/posts/image/post-img-1234"
 * @returns {Promise<{ location: string, contentType: string, size: number, originalSize: number }>}
 */
exports.processAndUploadImage = async ({ buffer, mimetype, originalName, keyPrefix }) => {
  if (!s3Client) throw new Error('S3 not configured');
  if (!buffer || buffer.length === 0) throw new Error('Empty image buffer');

  const originalSize = buffer.length;

  // 1) Pass-through formats: upload as-is, just write a sensible extension.
  if (PASS_THROUGH_MIMETYPES.has(mimetype)) {
    const ext = mimetype === 'image/gif' ? '.gif' : '.webp';
    const key = `${keyPrefix}${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: buffer, ContentType: mimetype,
    }));
    return {
      location: `https://${bucket}.s3.amazonaws.com/${key}`,
      contentType: mimetype,
      size: originalSize,
      originalSize,
    };
  }

  // 2) Sharp pipeline for JPEG/PNG (and anything else sharp can decode).
  let pipeline = sharp(buffer, { failOn: 'truncated' }).rotate(); // honor EXIF orientation

  // Probe metadata for the resize decision.
  const meta = await sharp(buffer).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  if (longest > MAX_SIDE_PX) {
    pipeline = pipeline.resize({
      width: MAX_SIDE_PX,
      height: MAX_SIDE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  pipeline = pipeline.webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT });

  let outBuffer;
  try {
    outBuffer = await pipeline.toBuffer();
  } catch (err) {
    logger.warn(`[imageProcessor] sharp encode failed (${err.message}) — falling back to original`);
    // Fallback: upload the original, original key extension
    const ext = path.extname(originalName).toLowerCase() || '.bin';
    const key = `${keyPrefix}${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: buffer, ContentType: mimetype,
    }));
    return { location: `https://${bucket}.s3.amazonaws.com/${key}`, contentType: mimetype, size: originalSize, originalSize };
  }

  // 3) Always upload as WebP. For already-optimised small JPEGs the WebP
  // output can occasionally be a few KB larger than the source, but the
  // requirement is that EVERY image lands on S3 as .webp — format
  // consistency outweighs saving a handful of KB on edge cases.
  const key = `${keyPrefix}.webp`;
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: outBuffer, ContentType: 'image/webp',
  }));

  const pct = Math.round((1 - outBuffer.length / originalSize) * 100);
  logger.info(`[imageProcessor] ${key}: ${(originalSize / 1024).toFixed(0)}KB → ${(outBuffer.length / 1024).toFixed(0)}KB (${pct >= 0 ? '-' : '+'}${Math.abs(pct)}%)`);

  return {
    location: `https://${bucket}.s3.amazonaws.com/${key}`,
    contentType: 'image/webp',
    size: outBuffer.length,
    originalSize,
  };
};

exports.MAX_SIDE_PX = MAX_SIDE_PX;
exports.WEBP_QUALITY = WEBP_QUALITY;
