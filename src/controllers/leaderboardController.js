const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

/**
 * GET /leaderboard
 * Returns all users ranked by their points balance
 */
exports.getLeaderboard = async (req, res, next) => {
  try {
    const currentUserId = req.user?.id;

    // Get all users with their profile and bag information
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            country: true,
          },
        },
        bags: {
          take: 1,
          orderBy: { registeredAt: 'asc' },
          select: {
            bagType: {
              select: { name: true },
            },
          },
        },
      },
    });

    // Get all wallets
    const wallets = await prisma.userPointsWallet.findMany({
      select: {
        userId: true,
        balance: true,
      },
    });

    // Create wallet map for quick lookup
    const walletMap = new Map();
    wallets.forEach(wallet => {
      walletMap.set(wallet.userId, wallet.balance);
    });

    // Get tournament participation for streak calculation
    const userIds = users.map(u => u.id);
    const picks = await prisma.userPick.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        submittedAt: true,
        tournament: {
          select: {
            startDate: true,
            endDate: true,
          },
        },
      },
      orderBy: { submittedAt: 'desc' },
    });

    // Calculate streaks for each user
    const streakMap = new Map();
    userIds.forEach(userId => {
      const userPicks = picks
        .filter(p => p.userId === userId)
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());

      let streak = 0;
      let lastWeek = null;

      for (const pick of userPicks) {
        const pickDate = new Date(pick.submittedAt);
        const weekNumber = getWeekNumber(pickDate);

        if (lastWeek === null) {
          // First pick
          streak = 1;
          lastWeek = weekNumber;
        } else if (weekNumber === lastWeek - 1) {
          // Consecutive week
          streak++;
          lastWeek = weekNumber;
        } else {
          // Gap found, stop counting
          break;
        }
      }

      streakMap.set(userId, streak);
    });

    // Build leaderboard entries with points from wallet (0 if no wallet)
    const leaderboardData = users.map(user => {
      const createdAt = new Date(user.createdAt);
      const now = new Date();
      const weeksRegistered = Math.floor((now.getTime() - createdAt.getTime()) / (7 * 24 * 60 * 60 * 1000));
      const points = walletMap.get(user.id) || 0;

      return {
        userId: user.id,
        username: user.username,
        name: user.profile?.name || user.username,
        country: user.profile?.country || null,
        bagName: user.bags?.[0]?.bagType?.name || null,
        points,
        weeksRegistered: Math.max(0, weeksRegistered),
        streak: streakMap.get(user.id) || 0,
        isCurrentUser: currentUserId ? user.id === currentUserId : false,
      };
    });

    // Sort by points (descending), then by createdAt (ascending - older users first)
    leaderboardData.sort((a, b) => {
      if (b.points !== a.points) {
        return b.points - a.points; // Higher points first
      }
      // Same points: older user (earlier createdAt) gets better rank
      return new Date(users.find(u => u.id === a.userId).createdAt).getTime() - 
             new Date(users.find(u => u.id === b.userId).createdAt).getTime();
    });
    const leaderboard = leaderboardData.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

    // Get total owners count (users with bags)
    const totalOwners = await prisma.user.count({
      where: {
        bags: {
          some: {},
        },
      },
    });

    // Find current user's data
    const currentUserData = leaderboard.find(entry => entry.isCurrentUser);
    const rank1Data = leaderboard[0];

    logger.info(`Leaderboard fetched: ${leaderboard.length} users`);

    return res.status(200).json({
      success: true,
      data: { 
        leaderboard,
        totalOwners,
        userRank: currentUserData?.rank || null,
        userPoints: currentUserData?.points || 0,
        rank1Points: rank1Data?.points || 0,
      },
    });
  } catch (error) {
    logger.error(`getLeaderboard error: ${error.message}`);
    next(error);
  }
};

// Helper function to get week number of the year
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
