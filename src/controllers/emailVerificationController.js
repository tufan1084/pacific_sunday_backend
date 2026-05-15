const bcrypt = require('bcryptjs');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const emailService = require('../services/emailService');

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

// POST /api/auth/send-verification-otp
// Body: { email }
exports.sendVerificationOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Invalidate previous unused OTPs for this email
    await prisma.emailVerificationOtp.updateMany({
      where: { email: normalizedEmail, used: false },
      data: { used: true },
    });

    await prisma.emailVerificationOtp.create({
      data: { email: normalizedEmail, otpHash, expiresAt },
    });

    // Try to send email, but don't fail if SMTP is not configured
    try {
      await emailService.sendVerificationOtpEmail(normalizedEmail, otp);
      logger.info(`Verification OTP sent to ${normalizedEmail}`);
    } catch (mailErr) {
      logger.warn(`Failed to send verification OTP email (SMTP not configured): ${mailErr.message}`);
      // Continue anyway - we'll return the OTP in the response for development
    }

    // TEMPORARY: Return OTP in response for development (remove in production)
    return res.json({
      success: true,
      message: 'Verification code generated.',
      data: { otp }, // Include OTP in response for development
    });
  } catch (error) {
    logger.error(`sendVerificationOtp error: ${error.message}`);
    next(error);
  }
};

// POST /api/auth/verify-email-otp
// Body: { email, otp }
exports.verifyEmailOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const record = await prisma.emailVerificationOtp.findFirst({
      where: { email: normalizedEmail, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code.' });
    }

    if (record.expiresAt < new Date()) {
      await prisma.emailVerificationOtp.update({ where: { id: record.id }, data: { used: true } });
      return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await prisma.emailVerificationOtp.update({ where: { id: record.id }, data: { used: true } });
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const isMatch = await bcrypt.compare(String(otp), record.otpHash);
    if (!isMatch) {
      await prisma.emailVerificationOtp.update({
        where: { id: record.id },
        data: { attempts: record.attempts + 1 },
      });
      return res.status(400).json({ success: false, message: 'Invalid code. Please try again.' });
    }

    // Mark this OTP as verified
    await prisma.emailVerificationOtp.update({ where: { id: record.id }, data: { used: true } });

    logger.info(`Email verified: ${normalizedEmail}`);

    return res.json({
      success: true,
      message: 'Email verified successfully.',
    });
  } catch (error) {
    logger.error(`verifyEmailOtp error: ${error.message}`);
    next(error);
  }
};
