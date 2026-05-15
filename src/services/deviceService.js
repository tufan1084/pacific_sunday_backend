const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const emailService = require('./emailService');

const OTP_EXPIRY_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

/**
 * Best-effort label derived from a user-agent string. Doesn't need to be
 * pretty — the user can rename devices later from Settings.
 */
function deriveDeviceLabel(userAgent) {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.toLowerCase();
  let platform = 'Device';
  if (ua.includes('iphone')) platform = 'iPhone';
  else if (ua.includes('ipad')) platform = 'iPad';
  else if (ua.includes('android')) platform = 'Android';
  else if (ua.includes('mac')) platform = 'Mac';
  else if (ua.includes('windows')) platform = 'Windows';
  else if (ua.includes('linux')) platform = 'Linux';

  let browser = '';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome/') && !ua.includes('edg/')) browser = 'Chrome';
  else if (ua.includes('firefox/')) browser = 'Firefox';
  else if (ua.includes('safari/') && !ua.includes('chrome/')) browser = 'Safari';

  return browser ? `${browser} on ${platform}` : platform;
}

function extractRequestMeta(req) {
  const userAgent = req?.headers?.['user-agent'] || null;
  // Trust the first XFF entry if behind a proxy; otherwise fall back to socket.
  const xff = req?.headers?.['x-forwarded-for'];
  const ipAddress = (xff && xff.split(',')[0].trim()) || req?.ip || null;
  return { userAgent, ipAddress };
}

/** Look up a non-revoked device for this user by fingerprint. */
async function findTrustedDevice(userId, fingerprintHash) {
  if (!fingerprintHash) return null;
  return prisma.userDevice.findFirst({
    where: { userId, fingerprintHash, revokedAt: null },
  });
}

/**
 * Record (or upsert) a trusted device. Updates lastSeenAt + meta on repeat
 * sightings; creates a new row on first sight.
 */
async function upsertDevice({ userId, fingerprintHash, userAgent, ipAddress, label }) {
  const existing = await prisma.userDevice.findUnique({
    where: { userId_fingerprintHash: { userId, fingerprintHash } },
  });
  const deriveLabel = label || deriveDeviceLabel(userAgent);

  if (existing) {
    return prisma.userDevice.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        userAgent: userAgent ?? existing.userAgent,
        ipAddress: ipAddress ?? existing.ipAddress,
        revokedAt: null, // re-trust if it was revoked
      },
    });
  }
  return prisma.userDevice.create({
    data: {
      userId,
      fingerprintHash,
      label: deriveLabel,
      userAgent,
      ipAddress,
    },
  });
}

async function listDevices(userId) {
  return prisma.userDevice.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
  });
}

async function revokeDevice(userId, deviceId) {
  const device = await prisma.userDevice.findFirst({
    where: { id: deviceId, userId },
  });
  if (!device) return null;
  return prisma.userDevice.update({
    where: { id: device.id },
    data: { revokedAt: new Date() },
  });
}

// ───── Device verification OTP (used when an unknown device tries to log in)

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Creates an OTP record tied to (userId, fingerprint, nfcToken). The caller
 * surfaces the OTP to the user via email (and on-screen during dev until SMTP
 * is wired up). Returns the OTP itself so the controller can include it in
 * the response for the dev-fallback path.
 */
async function issueDeviceOtp({ userId, fingerprintHash, userAgent, ipAddress, nfcTokenId, email }) {
  // Invalidate previous unused OTPs for this user/device combo so a fresh
  // attempt always supersedes a stale one.
  await prisma.deviceVerificationOtp.updateMany({
    where: { userId, fingerprintHash, used: false },
    data: { used: true },
  });

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  const row = await prisma.deviceVerificationOtp.create({
    data: { userId, fingerprintHash, userAgent, ipAddress, otpHash, nfcTokenId, expiresAt },
  });

  // Fire-and-forget email; controller will fall back to returning the OTP in
  // the response body during dev (matches the existing forgot-PIN behaviour).
  if (email) {
    emailService
      .sendDeviceVerificationEmail(email, otp, deriveDeviceLabel(userAgent))
      .then(() => logger.info(`Device verification OTP sent to ${email}`))
      .catch((err) => logger.warn(`Failed to send device OTP email: ${err.message}`));
  }

  return { otp, challengeId: row.id, expiresAt };
}

async function verifyDeviceOtp({ challengeId, otp, expectedUserId }) {
  const record = await prisma.deviceVerificationOtp.findUnique({
    where: { id: challengeId },
  });
  if (!record) return { error: 'OTP_INVALID' };
  if (record.userId !== expectedUserId) return { error: 'OTP_MISMATCH' };
  if (record.used) return { error: 'OTP_USED' };
  if (record.expiresAt < new Date()) return { error: 'OTP_EXPIRED' };
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.deviceVerificationOtp.update({
      where: { id: record.id },
      data: { used: true },
    });
    return { error: 'OTP_TOO_MANY_ATTEMPTS' };
  }
  const match = await bcrypt.compare(String(otp), record.otpHash);
  if (!match) {
    await prisma.deviceVerificationOtp.update({
      where: { id: record.id },
      data: { attempts: record.attempts + 1 },
    });
    return { error: 'OTP_WRONG' };
  }
  await prisma.deviceVerificationOtp.update({
    where: { id: record.id },
    data: { used: true },
  });
  return { row: record };
}

module.exports = {
  deriveDeviceLabel,
  extractRequestMeta,
  findTrustedDevice,
  upsertDevice,
  listDevices,
  revokeDevice,
  issueDeviceOtp,
  verifyDeviceOtp,
};
