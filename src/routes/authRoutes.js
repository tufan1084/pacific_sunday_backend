const { Router } = require('express');
const { body } = require('express-validator');
const {
  register,
  login,
  quickLogin,
  verifyDeviceOtp,
  listDevices,
  revokeDevice,
  getMe,
} = require('../controllers/authController');
const { googleAuth } = require('../controllers/googleAuthController');
const {
  forgotPassword,
  verifyOtp,
  resetPassword,
} = require('../controllers/passwordResetController');
const {
  sendVerificationOtp,
  verifyEmailOtp,
} = require('../controllers/emailVerificationController');
const { authenticate } = require('../middleware/authMiddleware');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate } = require('../middleware/validate');

const router = Router();

/**
 * POST /auth/send-verification-otp
 * Body: { email }
 * Sends a verification code to the email for registration.
 */
router.post(
  '/send-verification-otp',
  authLimiter,
  [
    body('email')
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('A valid email address is required')
      .normalizeEmail(),
  ],
  validate,
  sendVerificationOtp
);

/**
 * POST /auth/verify-email-otp
 * Body: { email, otp }
 * Verifies the email OTP during registration.
 */
router.post(
  '/verify-email-otp',
  authLimiter,
  [
    body('email')
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('A valid email address is required')
      .normalizeEmail(),
    body('otp')
      .notEmpty().withMessage('OTP is required')
      .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  validate,
  verifyEmailOtp
);

/**
 * POST /auth/google
 * Body: { credential, bagUid }
 * Authenticates user with Google OAuth.
 */
router.post(
  '/google',
  authLimiter,
  [
    body('credential')
      .notEmpty()
      .withMessage('Google credential is required'),
    body('nfcToken').optional().isString().trim(),
    body('deviceFingerprint').optional().isString().trim(),
    body('bagUid').optional().isString().trim(),
  ],
  validate,
  googleAuth
);

/**
 * POST /auth/register
 * Creates a new user account and links the scanned bag.
 */
router.post(
  '/register',
  authLimiter,
  [
    body('name')
      .notEmpty()
      .withMessage('Name is required')
      .isString()
      .withMessage('Name must be a string')
      .isLength({ min: 2, max: 100 })
      .withMessage('Name must be between 2 and 100 characters')
      .trim(),

    body('email')
      .notEmpty()
      .withMessage('Email is required')
      .isEmail()
      .withMessage('A valid email address is required')
      .normalizeEmail(),

    body('mpin')
      .notEmpty().withMessage('M-PIN is required')
      .isLength({ min: 4, max: 4 }).withMessage('M-PIN must be exactly 4 digits')
      .isNumeric().withMessage('M-PIN must contain only digits'),

    body('bagUid')
      .notEmpty()
      .withMessage('Bag UID is required')
      .isString()
      .withMessage('Bag UID must be a string')
      .trim(),

    body('deviceFingerprint').optional().isString().trim(),
  ],
  validate,
  register
);

/**
 * POST /auth/login
 * Authenticates a user and returns a JWT.
 * Body: { email, mpin, nfcToken, deviceFingerprint? }
 */
router.post(
  '/login',
  authLimiter,
  [
    body('email')
      .notEmpty()
      .withMessage('Username or email is required')
      .isString()
      .withMessage('Username or email must be a string')
      .trim(),

    body('mpin')
      .notEmpty().withMessage('M-PIN is required')
      .isLength({ min: 4, max: 4 }).withMessage('M-PIN must be exactly 4 digits')
      .isNumeric().withMessage('M-PIN must contain only digits'),

    body('nfcToken').optional().isString().trim(),
    body('deviceFingerprint').optional().isString().trim(),
  ],
  validate,
  login
);

/**
 * POST /auth/quick-login
 * Fast re-login on a trusted device — no NFC tap needed.
 * Body: { userId, mpin, deviceFingerprint }
 */
router.post(
  '/quick-login',
  authLimiter,
  [
    body('userId').notEmpty().withMessage('userId is required').isInt(),
    body('mpin')
      .notEmpty().withMessage('M-PIN is required')
      .isLength({ min: 4, max: 4 }).withMessage('M-PIN must be 4 digits')
      .isNumeric().withMessage('M-PIN must contain only digits'),
    body('deviceFingerprint').notEmpty().withMessage('deviceFingerprint is required').isString().trim(),
  ],
  validate,
  quickLogin
);

/**
 * POST /auth/verify-device-otp
 * Completes login from an unknown device by confirming the email OTP.
 */
router.post(
  '/verify-device-otp',
  authLimiter,
  [
    body('challengeId').notEmpty().withMessage('challengeId is required').isInt(),
    body('otp')
      .notEmpty().withMessage('OTP is required')
      .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  validate,
  verifyDeviceOtp
);

/**
 * GET /auth/devices — list trusted devices for the current user.
 * DELETE /auth/devices/:id — revoke a trusted device.
 */
router.get('/devices', authenticate, listDevices);
router.delete('/devices/:id', authenticate, revokeDevice);

/**
 * GET /auth/me
 * Returns the currently authenticated user's profile (JWT required).
 */
router.get('/me', authenticate, getMe);

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Sends a one-time code to the user's email.
 */
router.post(
  '/forgot-password',
  authLimiter,
  [
    body('email')
      .notEmpty().withMessage('Username or email is required')
      .isString().withMessage('Username or email must be a string')
      .trim(),
    body('nfcToken').optional().isString().trim(),
  ],
  validate,
  forgotPassword
);

/**
 * POST /auth/verify-otp
 * Body: { email, otp }
 * Verifies the OTP and returns a short-lived reset token.
 */
router.post(
  '/verify-otp',
  authLimiter,
  [
    body('email')
      .notEmpty().withMessage('Username or email is required')
      .isString().withMessage('Username or email must be a string')
      .trim(),
    body('otp')
      .notEmpty().withMessage('OTP is required')
      .isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  validate,
  verifyOtp
);

/**
 * POST /auth/reset-password
 * Body: { resetToken, newPin } (newMpin/newPassword/mpin/pin accepted as aliases)
 * Sets a new 4-digit PIN using the reset token from verify-otp. Users log in
 * with a PIN, not a password — strict 4-digit validation is done in the
 * controller so any of the accepted field names works.
 */
router.post(
  '/reset-password',
  authLimiter,
  [
    body('resetToken').notEmpty().withMessage('Reset token is required'),
    body().custom((value) => {
      const v = value?.newPin ?? value?.newMpin ?? value?.newPassword ?? value?.mpin ?? value?.pin;
      if (v === undefined || v === null || String(v).trim() === '') {
        throw new Error('New PIN is required');
      }
      if (!/^\d{4}$/.test(String(v).trim())) {
        throw new Error('PIN must be exactly 4 digits');
      }
      return true;
    }),
  ],
  validate,
  resetPassword
);

module.exports = router;
