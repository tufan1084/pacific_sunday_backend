const { prisma } = require('../config/db');
const logger = require('../config/logger');

const TYPES = ['Banner', 'Push', 'Both'];
const AUDIENCES = ['All', 'Active', 'Premium'];
const STATUSES = ['Draft', 'Scheduled', 'Published'];

// ── Public ──────────────────────────────────────────────────────────────
/**
 * GET /announcements/active
 * Returns the most recent announcement that the dashboard banner should
 * show. "Active" means status = Published AND (scheduledAt is null or
 * already past). Falls back to null when nothing qualifies.
 */
const getActiveAnnouncement = async (_req, res, next) => {
  try {
    const now = new Date();
    const announcement = await prisma.announcement.findFirst({
      where: {
        status: 'Published',
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      },
      orderBy: [{ scheduledAt: 'desc' }, { updatedAt: 'desc' }],
    });
    return res.status(200).json({
      success: true,
      data: { announcement },
      message: announcement ? 'Active announcement found.' : 'No active announcement.',
    });
  } catch (err) {
    logger.error(`getActiveAnnouncement error: ${err.message}`);
    next(err);
  }
};

// ── Admin ───────────────────────────────────────────────────────────────
const adminListAnnouncements = async (_req, res, next) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return res.status(200).json({
      success: true,
      data: { announcements },
      message: 'Announcements retrieved.',
    });
  } catch (err) {
    logger.error(`adminListAnnouncements error: ${err.message}`);
    next(err);
  }
};

function pickFields(body) {
  const out = {};
  if (typeof body.title === 'string') out.title = body.title.trim();
  if (typeof body.message === 'string') out.message = body.message.trim();
  if (TYPES.includes(body.type)) out.type = body.type;
  if (AUDIENCES.includes(body.audience)) out.audience = body.audience;
  if (STATUSES.includes(body.status)) out.status = body.status;
  if (body.scheduledAt === null) {
    out.scheduledAt = null;
  } else if (typeof body.scheduledAt === 'string' && body.scheduledAt.trim()) {
    const d = new Date(body.scheduledAt);
    if (!Number.isNaN(d.getTime())) out.scheduledAt = d;
  }
  if (typeof body.ctaText === 'string') out.ctaText = body.ctaText.trim() || null;
  if (typeof body.ctaHref === 'string') out.ctaHref = body.ctaHref.trim() || null;
  return out;
}

const adminCreateAnnouncement = async (req, res, next) => {
  try {
    const data = pickFields(req.body || {});
    if (!data.title || !data.message) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'title and message are required.',
      });
    }
    const created = await prisma.announcement.create({ data });
    return res.status(201).json({
      success: true,
      data: { announcement: created },
      message: 'Announcement created.',
    });
  } catch (err) {
    logger.error(`adminCreateAnnouncement error: ${err.message}`);
    next(err);
  }
};

const adminUpdateAnnouncement = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid announcement id.',
      });
    }
    const data = pickFields(req.body || {});
    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'No updatable fields supplied.',
      });
    }
    const updated = await prisma.announcement.update({
      where: { id },
      data,
    });
    return res.status(200).json({
      success: true,
      data: { announcement: updated },
      message: 'Announcement updated.',
    });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Announcement not found.',
      });
    }
    logger.error(`adminUpdateAnnouncement error: ${err.message}`);
    next(err);
  }
};

const adminDeleteAnnouncement = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid announcement id.',
      });
    }
    await prisma.announcement.delete({ where: { id } });
    return res.status(200).json({
      success: true,
      data: { id },
      message: 'Announcement deleted.',
    });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Announcement not found.',
      });
    }
    logger.error(`adminDeleteAnnouncement error: ${err.message}`);
    next(err);
  }
};

module.exports = {
  getActiveAnnouncement,
  adminListAnnouncements,
  adminCreateAnnouncement,
  adminUpdateAnnouncement,
  adminDeleteAnnouncement,
};
