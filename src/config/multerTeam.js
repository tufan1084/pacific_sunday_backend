const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const { s3Client, bucket } = require('./s3');

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  }
  return cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
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
    cb(null, `community/team/team-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

module.exports = upload;
