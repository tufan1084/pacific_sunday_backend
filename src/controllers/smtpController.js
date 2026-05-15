const { prisma } = require('../config/db');
const logger = require('../config/logger');
const emailService = require('../services/emailService');

const MASK = '••••••••';

const maskConfig = (config) => {
  if (!config) return null;
  return {
    id: config.id,
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    password: config.password ? MASK : '',
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    superadminEmail: config.superadminEmail,
    enabled: config.enabled,
    updatedAt: config.updatedAt,
  };
};

// GET /api/admin/smtp-config
exports.getSmtpConfig = async (req, res) => {
  try {
    const config = await emailService.getSmtpConfig();
    return res.json({ success: true, data: maskConfig(config) });
  } catch (error) {
    logger.error(`getSmtpConfig error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/admin/smtp-config
exports.upsertSmtpConfig = async (req, res) => {
  try {
    const { host, port, secure, username, password, fromEmail, fromName, superadminEmail, enabled } = req.body;

    if (!host || !username || !fromEmail) {
      return res.status(400).json({
        success: false,
        message: 'host, username, and fromEmail are required.',
      });
    }

    const existing = await emailService.getSmtpConfig();

    // If password not provided (or is the mask), reuse the existing password
    const passwordToStore =
      !password || password === MASK ? existing?.password : password;

    if (!passwordToStore) {
      return res.status(400).json({
        success: false,
        message: 'password is required when creating the SMTP configuration.',
      });
    }

    const data = {
      host,
      port: port ? parseInt(port, 10) : 587,
      secure: Boolean(secure),
      username,
      password: passwordToStore,
      fromEmail,
      fromName: fromName || null,
      superadminEmail: superadminEmail || null,
      enabled: enabled === undefined ? true : Boolean(enabled),
    };

    const saved = existing
      ? await prisma.smtpConfig.update({ where: { id: existing.id }, data })
      : await prisma.smtpConfig.create({ data });

    emailService.invalidateCache();
    logger.info(`SMTP config ${existing ? 'updated' : 'created'} (id=${saved.id})`);
    return res.json({ success: true, data: maskConfig(saved), message: 'SMTP configuration saved.' });
  } catch (error) {
    logger.error(`upsertSmtpConfig error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/smtp-config/test
// Body may contain a testEmail; if password is missing or mask, reuse stored password
exports.testSmtp = async (req, res) => {
  try {
    const { host, port, secure, username, password, fromEmail, fromName, testEmail } = req.body;
    const existing = await emailService.getSmtpConfig();

    const passwordToUse = !password || password === MASK ? existing?.password : password;

    if (!host || !username || !passwordToUse || !fromEmail) {
      return res.status(400).json({
        success: false,
        message: 'host, username, password, and fromEmail are required to test SMTP.',
      });
    }

    const cfg = {
      host,
      port: port ? parseInt(port, 10) : 587,
      secure: Boolean(secure),
      username,
      password: passwordToUse,
      fromEmail,
      fromName: fromName || null,
    };

    await emailService.verifySmtpConfig(cfg);

    if (testEmail) {
      const transporter = require('nodemailer').createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.username, pass: cfg.password },
      });
      const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
      await transporter.sendMail({
        from,
        to: testEmail,
        subject: 'Pacific Sunday — SMTP Test',
        text: 'This is a test email from your Pacific Sunday admin panel. SMTP is configured correctly.',
        html: '<p>This is a test email from your <strong>Pacific Sunday</strong> admin panel. SMTP is configured correctly.</p>',
      });
    }

    return res.json({
      success: true,
      message: testEmail
        ? `SMTP connection verified and test email sent to ${testEmail}.`
        : 'SMTP connection verified successfully.',
    });
  } catch (error) {
    logger.error(`testSmtp error: ${error.message}`);
    return res.status(400).json({ success: false, message: error.message });
  }
};
