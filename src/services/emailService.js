const nodemailer = require('nodemailer');
const { prisma } = require('../config/db');
const logger = require('../config/logger');

let cachedTransporter = null;
let cachedConfigId = null;
let cachedUpdatedAt = null;

const getSmtpConfig = async () => {
  return prisma.smtpConfig.findFirst({ orderBy: { id: 'desc' } });
};

// family: 4 forces IPv4 DNS resolution. Many Linux servers have IPv6 "available"
// but no real outbound v6 path to the SMTP host — Node tries AAAA first and the
// TCP SYN black-holes for the full connectionTimeout. Forcing v4 avoids that.
const buildTransporter = (config, { family } = {}) => {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    ...(family ? { family } : {}),
  });
};

const isTimeoutError = (err) => {
  if (!err) return false;
  const code = err.code || '';
  return code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timeout/i.test(err.message || '');
};

const decorateSmtpError = (err, config) => {
  const where = `${config.host}:${config.port}`;
  if (isTimeoutError(err)) {
    err.message =
      `Connection timeout reaching SMTP host ${where}. ` +
      `The server cannot open an outbound TCP connection to this host/port. ` +
      `Check: (1) cloud provider outbound port block (AWS/GCP/Azure/DO commonly block 25/465/587), ` +
      `(2) host firewall (ufw/iptables/security group), (3) try the other port (587 STARTTLS vs 465 SSL).`;
  } else {
    err.message = `${err.message} [smtp=${where}]`;
  }
  return err;
};

const getTransporter = async () => {
  const config = await getSmtpConfig();
  if (!config) throw new Error('SMTP is not configured. Please configure it in the admin panel.');
  if (!config.enabled) throw new Error('SMTP is currently disabled.');

  const updatedAtMs = new Date(config.updatedAt).getTime();
  if (!cachedTransporter || cachedConfigId !== config.id || cachedUpdatedAt !== updatedAtMs) {
    cachedTransporter = buildTransporter(config);
    cachedConfigId = config.id;
    cachedUpdatedAt = updatedAtMs;
  }

  return { transporter: cachedTransporter, config };
};

const sendMail = async ({ to, subject, html, text }) => {
  const { transporter, config } = await getTransporter();
  const from = config.fromName ? `"${config.fromName}" <${config.fromEmail}>` : config.fromEmail;
  const message = { from, to, subject, html, text };

  try {
    const info = await transporter.sendMail(message);
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    // If the first attempt timed out, retry once over IPv4 only. This rescues
    // the common "broken IPv6 path on Linux server" failure mode.
    if (isTimeoutError(err)) {
      logger.warn(`SMTP timeout against ${config.host}:${config.port}; retrying with IPv4-only resolution`);
      try {
        const v4Transporter = buildTransporter(config, { family: 4 });
        const info = await v4Transporter.sendMail(message);
        // Promote the working transporter to the cache so subsequent sends use v4
        cachedTransporter = v4Transporter;
        logger.info(`Email sent to ${to} (IPv4 fallback): ${info.messageId}`);
        return info;
      } catch (retryErr) {
        throw decorateSmtpError(retryErr, config);
      }
    }
    throw decorateSmtpError(err, config);
  }
};

const sendOtpEmail = async (to, otp) => {
  const subject = 'Your Password Reset Code';
  const text = `Your password reset code is: ${otp}\n\nThis code will expire in 10 minutes. If you did not request this, please ignore this email.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background:#0b1326; color:#fff; border-radius:8px;">
      <h2 style="color:#E6C36A; margin-top:0;">Password Reset</h2>
      <p style="color:#cbd5e1;">Use the code below to reset your Pacific Sunday password:</p>
      <div style="font-size:32px; font-weight:bold; letter-spacing:8px; text-align:center; padding:16px; background:#13192A; border-radius:6px; color:#E6C36A; margin:20px 0;">
        ${otp}
      </div>
      <p style="color:#94A3B8; font-size:13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendMail({ to, subject, html, text });
};

const sendDeviceVerificationEmail = async (to, otp, deviceLabel) => {
  const labelLine = deviceLabel ? ` from <strong>${deviceLabel}</strong>` : '';
  const subject = 'New device sign-in — verify it was you';
  const text = `A new device${deviceLabel ? ` (${deviceLabel})` : ''} is trying to sign in to your Pacific Sunday account. If this was you, enter this code to continue: ${otp}\n\nThe code expires in 10 minutes. If this wasn't you, change your PIN and revoke the device from Settings.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background:#0b1326; color:#fff; border-radius:8px;">
      <h2 style="color:#E6C36A; margin-top:0;">New device sign-in</h2>
      <p style="color:#cbd5e1;">A sign-in attempt was made${labelLine}. If that was you, enter the code below to finish signing in:</p>
      <div style="font-size:32px; font-weight:bold; letter-spacing:8px; text-align:center; padding:16px; background:#13192A; border-radius:6px; color:#E6C36A; margin:20px 0;">
        ${otp}
      </div>
      <p style="color:#94A3B8; font-size:13px;">This code expires in 10 minutes. If this wasn't you, change your PIN immediately and revoke the device from Settings.</p>
    </div>
  `;
  return sendMail({ to, subject, html, text });
};

const sendVerificationOtpEmail = async (to, otp) => {
  const subject = 'Verify Your Email Address';
  const text = `Your email verification code is: ${otp}\n\nThis code will expire in 10 minutes. If you did not request this, please ignore this email.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background:#0b1326; color:#fff; border-radius:8px;">
      <h2 style="color:#E6C36A; margin-top:0;">Email Verification</h2>
      <p style="color:#cbd5e1;">Use the code below to verify your email address for Pacific Sunday:</p>
      <div style="font-size:32px; font-weight:bold; letter-spacing:8px; text-align:center; padding:16px; background:#13192A; border-radius:6px; color:#E6C36A; margin:20px 0;">
        ${otp}
      </div>
      <p style="color:#94A3B8; font-size:13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
  return sendMail({ to, subject, html, text });
};

const verifySmtpConfig = async (config) => {
  try {
    const transporter = buildTransporter(config);
    await transporter.verify();
    return true;
  } catch (err) {
    if (isTimeoutError(err)) {
      // Retry verification over IPv4 before giving up
      try {
        const v4Transporter = buildTransporter(config, { family: 4 });
        await v4Transporter.verify();
        return true;
      } catch (retryErr) {
        throw decorateSmtpError(retryErr, config);
      }
    }
    throw decorateSmtpError(err, config);
  }
};

const invalidateCache = () => {
  cachedTransporter = null;
  cachedConfigId = null;
  cachedUpdatedAt = null;
};

module.exports = {
  sendMail,
  sendOtpEmail,
  sendDeviceVerificationEmail,
  sendVerificationOtpEmail,
  verifySmtpConfig,
  invalidateCache,
  getSmtpConfig,
};
