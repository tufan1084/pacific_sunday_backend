const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('./logger');

const region = process.env.AWS_REGION;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const isConfigured = Boolean(region && bucket && accessKeyId && secretAccessKey);

if (!isConfigured) {
  logger.warn(
    'S3 is not configured. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env to enable community image uploads.'
  );
}

const s3Client = isConfigured
  ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
  : null;

// Delete an object by its full public URL (best-effort; swallows errors).
const deleteS3Object = async (url) => {
  if (!s3Client || !url || typeof url !== 'string') return;
  try {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!key) return;
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // swallow — deletion is best-effort
  }
};

module.exports = { s3Client, bucket, deleteS3Object, isConfigured };
