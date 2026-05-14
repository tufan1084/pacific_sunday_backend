const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { emitNotification } = require('../config/socket');

const prisma = new PrismaClient();

/**
 * Creates a Notification row and pushes it over socket to the recipient.
 * Silently no-ops when recipient === actor so users don't notify themselves.
 *
 * @param {object} params
 * @param {number} params.userId     Recipient user id
 * @param {string} params.type       NotificationType enum value
 * @param {number=} params.actorId   Actor (who triggered it)
 * @param {string=} params.entityType 'post' | 'comment' | 'team' | 'user'
 * @param {number=} params.entityId
 * @param {number=} params.teamId
 * @param {object=} params.data      Extra context (post title, team name, etc.)
 */
async function createNotification({ userId, type, actorId, entityType, entityId, teamId, data }) {
  try {
    if (!userId || !type) return null;
    if (actorId && actorId === userId) return null; // don't notify yourself

    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        actorId: actorId || null,
        entityType: entityType || null,
        entityId: entityId || null,
        teamId: teamId || null,
        data: data || null,
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            profile: { select: { name: true } },
          },
        },
      },
    });

    const payload = serializeNotification(notification);
    emitNotification(userId, payload);

    return notification;
  } catch (error) {
    logger.error(`createNotification error: ${error.message}`);
    return null;
  }
}

/**
 * Notify every admin of a team (except the actor).
 */
async function notifyTeamAdmins({ teamId, type, actorId, data, entityType, entityId }) {
  try {
    const admins = await prisma.teamMember.findMany({
      where: { teamId, role: 'admin' },
      select: { userId: true },
    });
    await Promise.all(
      admins
        .map(a => a.userId)
        .filter(id => id !== actorId)
        .map(userId => createNotification({ userId, type, actorId, entityType, entityId, teamId, data }))
    );
  } catch (error) {
    logger.error(`notifyTeamAdmins error: ${error.message}`);
  }
}

/**
 * Notify every member of a team (except the actor).
 */
async function notifyTeamMembers({ teamId, type, actorId, data, entityType, entityId }) {
  try {
    const members = await prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    await Promise.all(
      members
        .map(m => m.userId)
        .filter(id => id !== actorId)
        .map(userId => createNotification({ userId, type, actorId, entityType, entityId, teamId, data }))
    );
  } catch (error) {
    logger.error(`notifyTeamMembers error: ${error.message}`);
  }
}

function serializeNotification(n) {
  return {
    id: n.id,
    type: n.type,
    actorId: n.actorId,
    actor: n.actor
      ? {
          id: n.actor.id,
          username: n.actor.username,
          name: n.actor.profile?.name || n.actor.username,
        }
      : null,
    entityType: n.entityType,
    entityId: n.entityId,
    teamId: n.teamId,
    data: n.data,
    read: n.read,
    createdAt: n.createdAt,
  };
}

module.exports = {
  createNotification,
  notifyTeamAdmins,
  notifyTeamMembers,
  serializeNotification,
};
