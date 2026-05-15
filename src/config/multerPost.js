const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const { s3Client, bucket } = require('./s3');

const fileFilter = (req, file, cb) => {
  const allowedImageTypes = /jpeg|jpg|png|gif|webp/;
  const allowedVideoTypes = /mp4|mov|avi|mkv|webm/;
  const extname = path.extname(file.originalname).toLowerCase();

  if (file.mimetype.startsWith('image/')) {
    if (allowedImageTypes.test(extname.slice(1))) return cb(null, true);
  } else if (file.mimetype.startsWith('video/')) {
    if (allowedVideoTypes.test(extname.slice(1))) return cb(null, true);
  }

  return cb(new Error('Invalid file type. Only images and videos allowed.'));
};

const storage = multerS3({
  s3: s3Client,
  bucket,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  metadata: (req, file, cb) => {
    cb(null, { userId: String(req.user?.id || 'anonymous') });
  },
  key: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const folder = file.mimetype.startsWith('image/')
      ? 'community/posts/image'
      : 'community/posts/video';
    const prefix = file.mimetype.startsWith('image/') ? 'post-img-' : 'post-vid-';
    cb(null, `${folder}/${prefix}${unique}${ext}`);
  },
});

const uploadPostMedia = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter,
});

module.exports = uploadPostMedia;
