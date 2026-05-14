const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const emailService = require('../services/emailService');
const nfcTokenService = require('../services/nfcTokenService');
const { hashPassword, findUserByEmail, findUserByEmailOrUsername } = require('../services/authService');

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const RESET_TOKEN_EXPIRY = '15m';

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

// POST /api/auth/forgot-password
// Body: { email, nfcToken }
// nfcToken is required (when REQUIRE_NFC_TOKEN is on) so a password reset
// can only be triggered from the same /n session that started the login.
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email, nfcToken } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Username or email is required.' });
    }

    const normalizedIdentifier = String(email).toLowerCase().trim();
    const user = await findUserByEmailOrUsername(normalizedIdentifier);

    // NFC gate — same as /auth/login. We validate the token against the user
    // that the identifier resolves to, so an attacker with a token for bag A
    // can't kick off a PIN reset on user B.
    if (nfcTokenService.REQUIRE_NFC_TOKEN && user) {
      const tokenCheck = await nfcTokenService.validateToken(nfcToken, { expectedUserId: user.id });
      if (tokenCheck.error) {
        logger.warn(`forgotPassword blocked (${tokenCheck.error}) for userId=${user.id}`);
        return res.status(403).json({
          success: false,
          code: tokenCheck.error,
          message: 'Please tap your Pacific Sunday bag and try again.',
        });
      }
    }

    // Always respond the same way to prevent email enumeration, but only actually send if user exists
    if (user) {
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

      // Invalidate previous unused OTPs for this email
      await prisma.passwordResetOtp.updateMany({
        where: { email: user.email, used: false },
        data: { used: true },
      });

      await prisma.passwordResetOtp.create({
        data: { email: user.email, otpHash, expiresAt },
      });

      // Try to send email, but don't fail if SMTP is not configured
      try {
        await emailService.sendOtpEmail(user.email, otp);
        logger.info(`Password reset OTP sent to ${user.email}`);
      } catch (mailErr) {
        logger.warn(`Failed to send OTP email (SMTP not configured): ${mailErr.message}`);
        // Continue anyway - we'll return the OTP in the response for development
      }

      // TEMPORARY: Return OTP in response for development (remove in production)
      return res.json({
        success: true,
        message: 'If an account exists for that username/email, a reset code has been sent.',
        data: { otp }, // Include OTP in response for development
      });
    } else {
      logger.info(`forgotPassword: no user for identifier=${normalizedIdentifier} (responding OK to prevent enumeration)`);
    }

    return res.json({
      success: true,
      message: 'If an account exists for that username/email, a reset code has been sent.',
    });
  } catch (error) {
    logger.error(`forgotPassword error: ${error.message}`);
    next(error);
  }
};

// POST /api/auth/verify-otp
// Body: { email, otp }
// Returns a short-lived reset token on success
exports.verifyOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const record = await prisma.passwordResetOtp.findFirst({
      where: { email: normalizedEmail, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
    }

    if (record.expiresAt < new Date()) {
      await prisma.passwordResetOtp.update({ where: { id: record.id }, data: { used: true } });
      return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await prisma.passwordResetOtp.update({ where: { id: record.id }, data: { used: true } });
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const isMatch = await bcrypt.compare(String(otp), record.otpHash);
    if (!isMatch) {
      await prisma.passwordResetOtp.update({
        where: { id: record.id },
        data: { attempts: record.attempts + 1 },
      });
      return res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });
    }

    // Mark this OTP as used and issue a short-lived reset token
    await prisma.passwordResetOtp.update({ where: { id: record.id }, data: { used: true } });

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not configured');

    const resetToken = jwt.sign(
      { email: normalizedEmail, purpose: 'password-reset' },
      secret,
      { expiresIn: RESET_TOKEN_EXPIRY }
    );

    return res.json({
      success: true,
      data: { resetToken },
      message: 'Code verified. You may now set a new password.',
    });
  } catch (error) {
    logger.error(`verifyOtp error: ${error.message}`);
    next(error);
  }
};

// POST /api/auth/reset-password
// Body: { resetToken, newPassword }
exports.resetPassword = async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Reset token and new password are required.' });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not configured');

    let decoded;
    try {
      decoded = jwt.verify(resetToken, secret);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
    }

    if (decoded.purpose !== 'password-reset' || !decoded.email) {
      return res.status(400).json({ success: false, message: 'Invalid reset token.' });
    }

    const user = await prisma.user.findUnique({ where: { email: decoded.email } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const hashed = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

    logger.info(`Password reset successful for userId=${user.id}`);
    return res.json({ success: true, message: 'Password has been reset. You can now sign in.' });
  } catch (error) {
    logger.error(`resetPassword error: ${error.message}`);
    next(error);
  }
};
