const { prisma } = require('../config/db');
const logger = require('../config/logger');

// Categories — single source of truth used both for writing logs and for
// populating the admin filter dropdown.
const CATEGORIES = {
  AUTH: 'AUTH',
  USER: 'USER',
  ADMIN: 'ADMIN',
  TOURNAMENT: 'TOURNAMENT',
  POINTS: 'POINTS',
  H2H: 'H2H',
  REWARD: 'REWARD',
  POST: 'POST',
  TAG: 'TAG',
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  TEAM: 'TEAM',
  BAG: 'BAG',
  SYSTEM: 'SYSTEM',
};

// Header keys + body fields we never want to persist (auth tokens, raw
// passwords, OTPs). Anything matching is replaced with "[REDACTED]" before
// writing to the metadata column.
const SENSITIVE_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'otp',
  'mpin',
  'authorization',
  'cookie',
  'secret',
]);

// Hard cap on metadata size so a freak large request body can never blow up
// the row. ~32KB is plenty for diffs and ordinary admin params.
const MAX_METADATA_BYTES = 32 * 1024;

const redact = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redact(v);
    }
  }
  return out;
};

const clampMetadata = (meta) => {
  if (!meta) return null;
  const safe = redact(meta);
  const serialised = JSON.stringify(safe);
  if (serialised.length <= MAX_METADATA_BYTES) return safe;
  return { truncated: true, preview: serialised.slice(0, MAX_METADATA_BYTES - 200) + '…' };
};

/**
 * Write a single audit log row. Always swallows its own errors — a logging
 * failure must never break the user-facing request.
 *
 * @param {object} event
 * @param {number|null} event.actorId
 * @param {'USER'|'ADMIN'|'SYSTEM'} event.actorType
 * @param {string} [event.actorName]
 * @param {string} event.action       e.g. "USER_LOGIN"
 * @param {string} event.category     One of the CATEGORIES values
 * @param {string} [event.entityType] "Tournament" | "User" | ...
 * @param {string|number} [event.entityId]
 * @param {object} [event.metadata]
 * @param {string} [event.ipAddress]
 * @param {string} [event.userAgent]
 * @param {'SUCCESS'|'FAILED'} [event.status]
 */
const logEvent = async (event) => {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        actorType: event.actorType,
        actorName: event.actorName ?? null,
        action: event.action,
        category: event.category,
        entityType: event.entityType ?? null,
        entityId: event.entityId != null ? String(event.entityId) : null,
        metadata: clampMetadata(event.metadata),
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        status: event.status || 'SUCCESS',
      },
    });
  } catch (err) {
    // Never throw from the audit path — log + move on.
    logger.warn(`[audit] write failed for ${event.action}: ${err.message}`);
  }
};

/**
 * Delete rows older than the configured retention window. Returns the number
 * of rows removed. Called by the daily cron in auditCronService.
 */
const purgeExpiredLogs = async () => {
  const settings = await getOrCreateSettings();
  const cutoff = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return { deleted: result.count, cutoff, retentionDays: settings.retentionDays };
};

/**
 * Singleton fetch/create for AuditSettings. The schema lets multiple rows
 * exist (autoincrement id) but we always use the first row — extra rows
 * would be a bug, not a feature.
 */
const getOrCreateSettings = async () => {
  let row = await prisma.auditSettings.findFirst({ orderBy: { id: 'asc' } });
  if (!row) {
    row = await prisma.auditSettings.create({ data: { retentionDays: 180 } });
  }
  return row;
};

const updateSettings = async (patch) => {
  const current = await getOrCreateSettings();
  return prisma.auditSettings.update({
    where: { id: current.id },
    data: patch,
  });
};

module.exports = {
  CATEGORIES,
  logEvent,
  purgeExpiredLogs,
  getOrCreateSettings,
  updateSettings,
};
