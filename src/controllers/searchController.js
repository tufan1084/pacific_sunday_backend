const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

/**
 * GET /search?q=...&type=[all|users|teams]
 * Unified search — returns matching users and teams.
 * Private teams ARE returned (discovery path); non-members only get limited
 * metadata and can send a join request via POST /teams/:teamId/join.
 */
const search = async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const type = (req.query.type || 'all').toString();
    const viewerId = req.user?.id || null;

    if (q.length < 2) {
      return res.status(200).json({ success: true, data: { users: [], teams: [] } });
    }

    const promises = {};

    if (type === 'all' || type === 'users') {
      promises.users = prisma.user.findMany({
        where: {
          AND: [
            viewerId ? { NOT: { id: viewerId } } : {},
            {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { profile: { name: { contains: q, mode: 'insensitive' } } },
              ],
            },
          ],
        },
        select: {
          id: true,
          username: true,
          profile: {
            select: {
              name: true,
              golfPassport: { select: { photoUrl: true } },
            },
          },
        },
        take: 10,
      });
    }

    if (type === 'all' || type === 'teams') {
      promises.teams = prisma.team.findMany({
        where: {
          name: { contains: q, mode: 'insensitive' },
        },
        include: {
          _count: { select: { members: true } },
          members: viewerId ? { where: { userId: viewerId }, select: { id: true, role: true } } : false,
        },
        take: 10,
      });
    }

    const resolved = await Promise.all(Object.values(promises));
    const keys = Object.keys(promises);
    const results = Object.fromEntries(keys.map((k, i) => [k, resolved[i]]));

    const users = (results.users || []).map(u => ({
      id: u.id,
      username: u.username,
      name: u.profile?.name || u.username,
      photoUrl: u.profile?.golfPassport?.photoUrl || null,
    }));

    const teams = (results.teams || []).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      imageUrl: t.imageUrl,
      privacy: t.privacy,
      creatorId: t.creatorId,
      memberCount: t._count.members,
      isMember: viewerId && Array.isArray(t.members) ? t.members.length > 0 : false,
      role: viewerId && Array.isArray(t.members) && t.members.length > 0 ? t.members[0].role : null,
    }));

    return res.status(200).json({
      success: true,
      data: { users, teams },
    });
  } catch (error) {
    logger.error(`search error: ${error.message}`);
    next(error);
  }
};

module.exports = { search };
