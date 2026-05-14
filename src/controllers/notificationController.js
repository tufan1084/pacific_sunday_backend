const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { serializeNotification } = require('../services/notificationService');

const prisma = new PrismaClient();

/**
 * GET /notifications?limit=20&cursor=<id>
 * List notifications for current user. Newest first.
 */
const listNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;

    const where = { userId };
    const notifications = await prisma.notification.findMany({
      where,
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            profile: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = notifications.length > limit;
    const items = hasMore ? notifications.slice(0, limit) : notifications;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    const unreadCount = await prisma.notification.count({
      where: { userId, read: false },
    });

    return res.status(200).json({
      success: true,
      data: {
        notifications: items.map(serializeNotification),
        nextCursor,
        unreadCount,
      },
    });
  } catch (error) {
    logger.error(`listNotifications error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /notifications/unread-count
 */
const unreadCount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const count = await prisma.notification.count({
      where: { userId, read: false },
    });
    return res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    logger.error(`unreadCount error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /notifications/:id/read
 */
const markRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id);
    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification || notification.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    await prisma.notification.update({ where: { id }, data: { read: true } });
    return res.status(200).json({ success: true, message: 'Marked as read' });
  } catch (error) {
    logger.error(`markRead error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /notifications/read-all
 */
const markAllRead = async (req, res, next) => {
  try {
    const userId = req.user.id;
    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return res.status(200).json({ success: true, message: 'All notifications marked read' });
  } catch (error) {
    logger.error(`markAllRead error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /notifications/:id
 * Permanently remove the authenticated user's notification. Owner-only.
 */
const deleteNotification = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid notification id' });
    }
    const notification = await prisma.notification.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!notification || notification.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    await prisma.notification.delete({ where: { id } });
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`deleteNotification error: ${error.message}`);
    next(error);
  }
};

module.exports = { listNotifications, unreadCount, markRead, markAllRead, deleteNotification };
