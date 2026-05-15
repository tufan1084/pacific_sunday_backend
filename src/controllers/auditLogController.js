const { prisma } = require('../config/db');
const logger = require('../config/logger');
const auditService = require('../services/auditService');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parseInt10 = (val, fallback) => {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * GET /api/admin/audit-logs
 *
 * Query params (all optional):
 *   actorType   "USER" | "ADMIN" | "SYSTEM"
 *   actorId     numeric
 *   category    one of the CATEGORIES values
 *   action      exact match, e.g. "USER_LOGIN"
 *   entityType  "Tournament" | "User" | ...
 *   entityId    string
 *   status      "SUCCESS" | "FAILED"
 *   from        ISO date string — inclusive lower bound on createdAt
 *   to          ISO date string — inclusive upper bound on createdAt
 *   search      free-text — matched against actorName + action + entityType
 *   page        1-indexed page number (default 1)
 *   limit       page size (default 50, max 200)
 */
exports.listAuditLogs = async (req, res) => {
  try {
    const {
      actorType, actorId, category, action,
      entityType, entityId, status, from, to, search,
    } = req.query;

    const page = Math.max(1, parseInt10(req.query.page, 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt10(req.query.limit, DEFAULT_LIMIT)));
    const skip = (page - 1) * limit;

    const where = {};
    if (actorType) where.actorType = actorType;
    if (actorId) where.actorId = parseInt10(actorId, undefined);
    if (category) where.category = category;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = String(entityId);
    if (status) where.status = status;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    if (search) {
      const s = String(search).trim();
      if (s) {
        where.OR = [
          { actorName: { contains: s, mode: 'insensitive' } },
          { action: { contains: s, mode: 'insensitive' } },
          { entityType: { contains: s, mode: 'insensitive' } },
          { entityId: { contains: s, mode: 'insensitive' } },
        ];
      }
    }

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`List audit logs error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to load audit logs' });
  }
};

/**
 * GET /api/admin/audit-logs/filters
 *
 * Returns the distinct values currently in the table so the admin UI can
 * populate its dropdowns without hard-coding. Categories also include the
 * canonical list so a newly-added category shows up even before its first
 * event is written.
 */
exports.getAuditLogFilters = async (req, res) => {
  try {
    const [actions, categoriesInDb, entityTypes, actorTypes] = await Promise.all([
      prisma.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
        take: 500,
      }),
      prisma.auditLog.findMany({
        distinct: ['category'],
        select: { category: true },
        take: 100,
      }),
      prisma.auditLog.findMany({
        distinct: ['entityType'],
        select: { entityType: true },
        where: { entityType: { not: null } },
        orderBy: { entityType: 'asc' },
        take: 100,
      }),
      prisma.auditLog.findMany({
        distinct: ['actorType'],
        select: { actorType: true },
        take: 10,
      }),
    ]);

    // Merge DB-observed categories with the canonical enum so empty buckets
    // are still selectable.
    const allCategories = new Set([
      ...Object.values(auditService.CATEGORIES),
      ...categoriesInDb.map((c) => c.category).filter(Boolean),
    ]);

    res.json({
      success: true,
      data: {
        actions: actions.map((a) => a.action).filter(Boolean),
        categories: [...allCategories].sort(),
        entityTypes: entityTypes.map((e) => e.entityType).filter(Boolean),
        actorTypes: actorTypes.map((a) => a.actorType).filter(Boolean),
      },
    });
  } catch (err) {
    logger.error(`Get audit log filters error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to load filters' });
  }
};

/**
 * GET /api/admin/audit-settings
 * Returns the singleton retention config row, creating it on first read.
 */
exports.getAuditSettings = async (req, res) => {
  try {
    const settings = await auditService.getOrCreateSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    logger.error(`Get audit settings error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to load audit settings' });
  }
};

/**
 * PUT /api/admin/audit-settings
 * Updates retention. Only the fields actually changing are written.
 */
exports.updateAuditSettings = async (req, res) => {
  try {
    const { retentionDays } = req.body;
    const days = parseInt10(retentionDays, NaN);

    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({
        success: false,
        message: 'retentionDays must be an integer between 1 and 3650',
      });
    }

    const updated = await auditService.updateSettings({ retentionDays: days });

    req.audit?.({
      action: 'AUDIT_SETTINGS_UPDATE',
      category: 'ADMIN',
      entityType: 'AuditSettings',
      entityId: updated.id,
      metadata: { retentionDays: days },
    });

    res.json({ success: true, data: updated, message: 'Audit settings updated' });
  } catch (err) {
    logger.error(`Update audit settings error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to update audit settings' });
  }
};

/**
 * POST /api/admin/audit-logs/purge
 * Manually run the retention cleanup. Returns the count of removed rows.
 */
exports.purgeAuditLogs = async (req, res) => {
  try {
    const result = await auditService.purgeExpiredLogs();

    req.audit?.({
      action: 'AUDIT_LOGS_PURGE',
      category: 'ADMIN',
      metadata: result,
    });

    res.json({ success: true, data: result, message: `Removed ${result.deleted} old log(s)` });
  } catch (err) {
    logger.error(`Purge audit logs error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to purge audit logs' });
  }
};

/**
 * GET /api/admin/audit-logs/export
 * Streams a CSV download of the current filter set (capped to 50k rows so a
 * runaway export doesn't blow up the server).
 */
exports.exportAuditLogsCsv = async (req, res) => {
  try {
    const MAX_EXPORT = 50000;
    const {
      actorType, actorId, category, action,
      entityType, entityId, status, from, to,
    } = req.query;

    const where = {};
    if (actorType) where.actorType = actorType;
    if (actorId) where.actorId = parseInt10(actorId, undefined);
    if (category) where.category = category;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = String(entityId);
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_EXPORT,
    });

    const headers = ['id', 'createdAt', 'actorType', 'actorId', 'actorName', 'category', 'action', 'entityType', 'entityId', 'status', 'ipAddress', 'userAgent', 'metadata'];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.write(headers.join(',') + '\n');
    for (const r of rows) {
      res.write(headers.map((h) => escape(r[h])).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    logger.error(`Export audit logs error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to export audit logs' });
  }
};
