const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const pointsService = require('../services/pointsService');

const prisma = new PrismaClient();

// ─── Admin: Get all points ranges ───────────────────────────────────────────
exports.getPointsRanges = async (req, res) => {
  try {
    const ranges = await prisma.pointsRange.findMany({
      orderBy: [{ sortOrder: 'asc' }, { minScore: 'desc' }],
    });

    res.json({ success: true, data: { ranges } });
  } catch (error) {
    logger.error(`getPointsRanges error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Admin: Create points range ─────────────────────────────────────────────
exports.createPointsRange = async (req, res) => {
  try {
    const { name, minScore, maxScore, points, sortOrder } = req.body;

    if (!name || minScore === undefined || maxScore === undefined || points === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (minScore > maxScore) {
      return res.status(400).json({ success: false, message: 'minScore must be less than or equal to maxScore' });
    }

    const range = await prisma.pointsRange.create({
      data: {
        name,
        minScore: parseInt(minScore),
        maxScore: parseInt(maxScore),
        points: parseInt(points),
        sortOrder: sortOrder !== undefined ? parseInt(sortOrder) : 0,
      },
    });

    logger.info(`Points range created: ${range.id}`);
    res.json({ success: true, data: { range }, message: 'Points range created' });
  } catch (error) {
    logger.error(`createPointsRange error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Admin: Update points range ─────────────────────────────────────────────
exports.updatePointsRange = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, minScore, maxScore, points, isActive, sortOrder } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (minScore !== undefined) updateData.minScore = parseInt(minScore);
    if (maxScore !== undefined) updateData.maxScore = parseInt(maxScore);
    if (points !== undefined) updateData.points = parseInt(points);
    if (isActive !== undefined) updateData.isActive = isActive;
    if (sortOrder !== undefined) updateData.sortOrder = parseInt(sortOrder);

    if (updateData.minScore !== undefined && updateData.maxScore !== undefined) {
      if (updateData.minScore > updateData.maxScore) {
        return res.status(400).json({ success: false, message: 'minScore must be less than or equal to maxScore' });
      }
    }

    const range = await prisma.pointsRange.update({
      where: { id: parseInt(id) },
      data: updateData,
    });

    logger.info(`Points range updated: ${range.id}`);
    res.json({ success: true, data: { range }, message: 'Points range updated' });
  } catch (error) {
    logger.error(`updatePointsRange error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Admin: Delete points range ─────────────────────────────────────────────
exports.deletePointsRange = async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.pointsRange.delete({
      where: { id: parseInt(id) },
    });

    logger.info(`Points range deleted: ${id}`);
    res.json({ success: true, message: 'Points range deleted' });
  } catch (error) {
    logger.error(`deletePointsRange error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Calculate points for a tournament (Admin trigger) ──────────────────────
exports.calculateTournamentPoints = async (req, res) => {
  try {
    const { tournId } = req.params;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const forceRecalculate = req.query.force === 'true';

    const tournament = await prisma.tournament.findUnique({
      where: { tournId_year: { tournId: String(tournId), year } },
    });
    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    // Reset pointsAwarded if force recalculate
    if (forceRecalculate) {
      await prisma.userPick.updateMany({
        where: { tournamentId: tournament.id, lockedAt: { not: null } },
        data: { pointsAwarded: null, pointsCalculatedAt: null, scoring: null },
      });
      logger.info(`Force recalculate: reset points for tournament ${tournId}/${year}`);
    }

    const result = await pointsService.awardTournamentPoints(tournament.id);
    res.json({
      success: true,
      message: `Points calculated for ${result.processed} users (${result.skipped} already awarded)`,
      data: result,
    });
  } catch (error) {
    logger.error(`calculateTournamentPoints error: ${error.message}`);
    const msg = error.message || 'Failed to calculate points';
    const status = /not completed|no leaderboard|no active points ranges/i.test(msg) ? 400 : 500;
    res.status(status).json({ success: false, message: msg });
  }
};

// ─── Get user wallet ─────────────────────────────────────────────────────────
exports.getUserWallet = async (req, res) => {
  try {
    const userId = req.user.id;

    let wallet = await prisma.userPointsWallet.findUnique({
      where: { userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!wallet) {
      wallet = await prisma.userPointsWallet.create({
        data: { userId, balance: 0 },
        include: { transactions: true },
      });
    }

    res.json({ success: true, data: { wallet } });
  } catch (error) {
    logger.error(`getUserWallet error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get user's platform rank ───────────────────────────────────────────────
// Ranks every user by wallet balance (DESC); ties broken by earliest
// registration date (oldest account wins). Users without a wallet row count
// as balance 0 so new signups still appear at the bottom of the ladder.
exports.getUserRank = async (req, res) => {
  try {
    const userId = req.user.id;
    const rows = await prisma.$queryRaw`
      WITH ranked AS (
        SELECT u.id,
               ROW_NUMBER() OVER (
                 ORDER BY COALESCE(w.balance, 0) DESC, u."createdAt" ASC
               )::int AS rank,
               COALESCE(w.balance, 0)::int AS balance
        FROM users u
        LEFT JOIN user_points_wallets w ON w."userId" = u.id
      )
      SELECT r.rank, r.balance, (SELECT COUNT(*)::int FROM users) AS total
      FROM ranked r
      WHERE r.id = ${userId}
    `;
    const row = Array.isArray(rows) && rows[0];
    if (!row) {
      return res.json({ success: true, data: { rank: null, total: 0, balance: 0 } });
    }
    res.json({ success: true, data: { rank: row.rank, total: row.total, balance: row.balance } });
  } catch (error) {
    logger.error(`getUserRank error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Get user's points history with tournament details ─────────────────────
exports.getPointsHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { year, month, type } = req.query;

    // Build date filter
    let dateFilter = {};
    if (year) {
      const startDate = new Date(`${year}-01-01`);
      const endDate = new Date(`${year}-12-31T23:59:59`);
      dateFilter = { gte: startDate, lte: endDate };
      
      if (month) {
        const monthStart = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
        const monthEnd = new Date(monthStart);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        monthEnd.setDate(0);
        monthEnd.setHours(23, 59, 59);
        dateFilter = { gte: monthStart, lte: monthEnd };
      }
    }

    // Get wallet summary
    let wallet = await prisma.userPointsWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      wallet = await prisma.userPointsWallet.create({
        data: { userId, balance: 0 },
      });
    }

    // Get transactions
    const transactions = await prisma.pointsTransaction.findMany({
      where: {
        userId,
        ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
        ...(type && type !== 'all' ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Calculate totals
    const allTransactions = await prisma.pointsTransaction.findMany({
      where: { userId },
    });
    const totalEarned = allTransactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const totalSpent = Math.abs(allTransactions.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));

    // Enrich tournament transactions with pick details
    const enrichedTransactions = await Promise.all(
      transactions.map(async (transaction) => {
        if (transaction.type === 'tournament_reward' && transaction.metadata) {
          const metadata = transaction.metadata;
          const tournamentId = metadata.tournamentId;
          
          if (tournamentId) {
            // Get tournament details
            const tournament = await prisma.tournament.findUnique({
              where: { id: tournamentId },
              select: {
                id: true,
                tournId: true,
                year: true,
                name: true,
                startDate: true,
                endDate: true,
                courseName: true,
              },
            });

            // Get user pick with scoring details
            const userPick = await prisma.userPick.findUnique({
              where: {
                userId_tournamentId: {
                  userId,
                  tournamentId,
                },
              },
              select: {
                picks: true,
                scoring: true,
                pointsAwarded: true,
              },
            });

            return {
              ...transaction,
              metadata: {
                ...metadata,
                tournament,
                pickDetails: userPick?.scoring || null,
              },
            };
          }
        }
        return transaction;
      })
    );

    logger.info(`Points history fetched for user: ${userId}`);

    res.json({
      success: true,
      data: {
        summary: {
          currentBalance: wallet.balance,
          totalEarned,
          totalSpent,
        },
        transactions: enrichedTransactions,
      },
    });
  } catch (error) {
    logger.error(`getPointsHistory error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getPointsRanges: exports.getPointsRanges,
  createPointsRange: exports.createPointsRange,
  updatePointsRange: exports.updatePointsRange,
  deletePointsRange: exports.deletePointsRange,
  calculateTournamentPoints: exports.calculateTournamentPoints,
  getUserWallet: exports.getUserWallet,
  getUserRank: exports.getUserRank,
  getPointsHistory: exports.getPointsHistory,
};
