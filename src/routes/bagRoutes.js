const { Router } = require('express');
const { query } = require('express-validator');
const { handleScan } = require('../controllers/bagController');
const { bagLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');

const router = Router();

/**
 * GET /bag?iykRef=
 *
 * Validates an NFC tap and returns bag details + registration status.
 * For dev bypass: iykRef=DEV-UID-XXXX
 */
router.get(
  '/',
  bagLimiter,
  [
    query('iykRef')
      .notEmpty()
      .withMessage('iykRef is required')
      .isString()
      .withMessage('iykRef must be a string')
      .trim(),
  ],
  validate,
  handleScan
);

module.exports = router;
