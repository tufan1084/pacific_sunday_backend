// In-memory multer for routes where we need to process the bytes (e.g. WebP
// conversion via sharp) before uploading to S3 manually. Same fileFilter +
// limits as multerPost so payload validation matches.

const multer = require('multer');
const path = require('path');

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm',
]);
const ALLOWED_IMAGE_EXT = /jpeg|jpg|png|gif|webp/;
const ALLOWED_VIDEO_EXT = /mp4|mov|avi|mkv|webm/;

// Accept if MIME OR extension is in the allowlist. Clipboard / keyboard-delivered
// files often have generic names ("image.png" with mime image/gif, or no
// extension at all), so trusting MIME alone is correct here — the bytes are
// re-inspected downstream by sharp / S3 ContentType.
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mime = (file.mimetype || '').toLowerCase();

  const isImage = ALLOWED_IMAGE_MIMES.has(mime) || (mime.startsWith('image/') && ALLOWED_IMAGE_EXT.test(ext));
  if (isImage) return cb(null, true);

  const isVideo = ALLOWED_VIDEO_MIMES.has(mime) || (mime.startsWith('video/') && ALLOWED_VIDEO_EXT.test(ext));
  if (isVideo) return cb(null, true);

  return cb(new Error('Invalid file type. Only images and videos allowed.'));
};

const imageOnlyFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mime = (file.mimetype || '').toLowerCase();
  const isImage = ALLOWED_IMAGE_MIMES.has(mime) || (mime.startsWith('image/') && ALLOWED_IMAGE_EXT.test(ext));
  if (isImage) return cb(null, true);
  return cb(new Error('Only image files (JPEG, JPG, PNG, GIF, WEBP) are allowed'));
};

// 50 MB cap — same as before; covers videos too.
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter,
});

// 10 MB cap for image-only routes (team avatar, profile photo, comment image).
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageOnlyFilter,
});

module.exports = { uploadAny, uploadImage };
