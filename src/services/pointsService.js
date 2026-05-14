const { prisma } = require('../config/db');
const logger = require('../config/logger');

// Parse scores like "-18", "E", "+5", "18" into a signed integer (strokes vs par).
function parseLeaderboardScore(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s.toUpperCase() === 'E') return 0;
  if (s.startsWith('+')) return parseInt(s.substring(1), 10) || 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// Atomic: increment wallet balance + append a transaction row. Creates the
// wallet on first use. Callers should treat this as fire-and-forget inside a
// loop — any throw is caught upstream so one bad pick doesn't poison the batch.
async function creditPointsToWallet(userId, amount, { type, description, metadata }) {
  let wallet = await prisma.userPointsWallet.findUnique({ where: { userId } });
  if (!wallet) {
    wallet = await prisma.userPointsWallet.create({ data: { userId, balance: 0 } });
  }

  await prisma.$transaction([
    prisma.userPointsWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    }),
    prisma.pointsTransaction.create({
      data: { walletId: wallet.id, userId, amount, type, description, metadata },
    }),
  ]);

  logger.info(`Credited ${amount} points to user ${userId}`);
}

// Score every locked pick for a completed tournament, write each user's
// pointsAwarded + per-player breakdown, and credit the wallet.
//
// Idempotent: picks that already have pointsAwarded set are skipped, so this
// can be invoked manually by an admin AND automatically by the weekly cron
// without double-crediting.
//
// Returns { processed, skipped, results } — the controller returns this
// directly; the cron uses it for logging only.
async function awardTournamentPoints(tournamentId) {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new Error(`Tournament ${tournamentId} not found`);
  if (tournament.status !== 'completed') {
    throw new Error(`Tournament ${tournament.tournId} is not completed (status=${tournament.status})`);
  }

  const leaderboard = tournament.leaderboard?.rows || [];
  if (leaderboard.length === 0) {
    throw new Error(`Tournament ${tournament.tournId} has no leaderboard data`);
  }

  const lockedPicks = await prisma.userPick.findMany({
    where: { tournamentId: tournament.id, lockedAt: { not: null } },
  });
  if (lockedPicks.length === 0) {
    return { processed: 0, skipped: 0, results: [] };
  }

  const ranges = await prisma.pointsRange.findMany({
    where: { isActive: true },
    orderBy: { minScore: 'desc' },
  });
  if (ranges.length === 0) {
    throw new Error('No active points ranges configured');
  }

  // Zurich Classic (tournId 018) is a team event - need to match by player name
  const isTeamEvent = tournament.tournId === '018';
  let playerIdToNameMap = {};
  
  if (isTeamEvent) {
    const allPlayerIds = lockedPicks.flatMap(pick => Object.values(pick.picks || {})).filter(Boolean);
    const uniquePlayerIds = [...new Set(allPlayerIds)];
    
    if (uniquePlayerIds.length > 0) {
      const players = await prisma.player.findMany({
        where: { playerId: { in: uniquePlayerIds } },
        select: { playerId: true, firstName: true, lastName: true },
      });
      
      playerIdToNameMap = players.reduce((map, p) => {
        map[p.playerId] = `${p.firstName} ${p.lastName}`.trim();
        return map;
      }, {});
    }
  }

  let processed = 0;
  let skipped = 0;
  const results = [];

  for (const pick of lockedPicks) {
    if (pick.pointsAwarded !== null) { skipped++; continue; }

    const picks = pick.picks || {};
    let totalPoints = 0;
    const playerScores = [];

    for (const [tier, playerId] of Object.entries(picks)) {
      if (!playerId) continue;

      let playerResult;
      
      if (isTeamEvent) {
        const playerName = playerIdToNameMap[playerId];
        if (!playerName) continue;
        
        playerResult = leaderboard.find(p => p.name && p.name.includes(playerName));
      } else {
        playerResult = leaderboard.find(p => p.playerId === playerId);
      }
      
      if (!playerResult) continue;

      const score = parseLeaderboardScore(playerResult.score);
      if (score === null) continue;

      const range = ranges.find(r => score >= r.minScore && score <= r.maxScore);
      const points = range ? range.points : 0;

      totalPoints += points;
      playerScores.push({
        tier, playerId,
        playerName: playerResult.name,
        score: playerResult.score,
        points,
      });
    }

    await prisma.userPick.update({
      where: { id: pick.id },
      data: {
        pointsAwarded: totalPoints,
        pointsCalculatedAt: new Date(),
        scoring: { playerScores, totalPoints },
      },
    });

    if (totalPoints > 0) {
      try {
        await creditPointsToWallet(pick.userId, totalPoints, {
          type: 'tournament_reward',
          description: `Points from ${tournament.name}`,
          metadata: {
            tournamentId: tournament.id,
            tournId: tournament.tournId,
            year: tournament.year,
            pickId: pick.id,
            playerScores,
          },
        });
      } catch (err) {
        logger.error(`creditPointsToWallet failed for user ${pick.userId}: ${err.message}`);
      }
    }

    processed++;
    results.push({ userId: pick.userId, totalPoints, playerScores });
  }

  logger.info(`[points] tournament ${tournament.tournId}/${tournament.year}: awarded=${processed} skipped=${skipped}`);
  return { processed, skipped, results };
}

// ─── H2H wallet holds ───────────────────────────────────────────────────────
// `heldBalance` reserves points against open challenges. Spendable balance is
// (balance - heldBalance). All three operations below run inside an interactive
// transaction with a row-level conditional UPDATE, so two concurrent challenges
// that would each individually pass the available-balance check can't both
// succeed and over-commit the wallet.

class InsufficientFundsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

async function holdPoints(userId, amount, { description, metadata } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }

  // Ensure a wallet row exists so the conditional UPDATE has something to hit.
  // New users with 0 balance will fail the available-balance guard below — no
  // free credit, just no foreign key error.
  await prisma.userPointsWallet.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE user_points_wallets
      SET "heldBalance" = "heldBalance" + ${amount}, "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND ("balance" - "heldBalance") >= ${amount}
    `;
    if (updated === 0) {
      throw new InsufficientFundsError('Insufficient available balance');
    }
    const wallet = await tx.userPointsWallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    await tx.pointsTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        amount: -amount, // negative to show points being held
        type: 'h2h_hold',
        description: description || null,
        metadata: { heldAmount: amount, ...(metadata || {}) },
      },
    });
  });

  logger.info(`H2H hold: user ${userId} +${amount} held`);
}

async function releaseHold(userId, amount, { description, metadata } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }

  await prisma.$transaction(async (tx) => {
    // Clamp at zero so a stale duplicate release can't push heldBalance negative.
    await tx.$executeRaw`
      UPDATE user_points_wallets
      SET "heldBalance" = GREATEST("heldBalance" - ${amount}, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `;
    const wallet = await tx.userPointsWallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!wallet) return;
    await tx.pointsTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        amount: amount, // positive to show points being released
        type: 'h2h_release',
        description: description || null,
        metadata: { releasedAmount: amount, ...(metadata || {}) },
      },
    });
  });

  logger.info(`H2H release: user ${userId} -${amount} held`);
}

// Settlement: the loser forfeits their wager to the winner, and the winner's
// own held wager is freed back up. Net: loser balance -= wager (& heldBalance
// -= wager), winner balance += wager (& heldBalance -= wager).
async function transferHeldToWinner({ loserId, winnerId, amount, description, metadata }) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }
  if (loserId === winnerId) {
    throw new Error('loser and winner must differ');
  }

  await Promise.all([
    prisma.userPointsWallet.upsert({
      where: { userId: loserId },
      create: { userId: loserId, balance: 0 },
      update: {},
    }),
    prisma.userPointsWallet.upsert({
      where: { userId: winnerId },
      create: { userId: winnerId, balance: 0 },
      update: {},
    }),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE user_points_wallets
      SET "balance"     = "balance" - ${amount},
          "heldBalance" = GREATEST("heldBalance" - ${amount}, 0),
          "updatedAt"   = NOW()
      WHERE "userId" = ${loserId}
    `;
    await tx.$executeRaw`
      UPDATE user_points_wallets
      SET "balance"     = "balance" + ${amount},
          "heldBalance" = GREATEST("heldBalance" - ${amount}, 0),
          "updatedAt"   = NOW()
      WHERE "userId" = ${winnerId}
    `;

    const [loserWallet, winnerWallet] = await Promise.all([
      tx.userPointsWallet.findUnique({ where: { userId: loserId },  select: { id: true } }),
      tx.userPointsWallet.findUnique({ where: { userId: winnerId }, select: { id: true } }),
    ]);

    await tx.pointsTransaction.createMany({
      data: [
        {
          walletId: loserWallet.id, userId: loserId,
          amount: -amount,
          type: 'h2h_loss',
          description: description || null,
          metadata: metadata || null,
        },
        {
          walletId: winnerWallet.id, userId: winnerId,
          amount: amount,
          type: 'h2h_winnings',
          description: description || null,
          metadata: metadata || null,
        },
      ],
    });
  });

  logger.info(`H2H settle: ${loserId} -${amount} → ${winnerId} +${amount}`);
}

/**
 * Conditional debit: subtracts `amount` from balance only if the user has
 * enough available (balance - heldBalance >= amount). Throws
 * InsufficientFundsError on failure. Records a negative-amount transaction.
 *
 * Used by reward redemption — synchronous, must succeed or fail cleanly so
 * the caller can refuse to grant the reward.
 */
async function debitPointsFromWallet(userId, amount, { type, description, metadata } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }

  await prisma.userPointsWallet.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });

  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE user_points_wallets
      SET "balance" = "balance" - ${amount}, "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND ("balance" - "heldBalance") >= ${amount}
    `;
    if (updated === 0) {
      throw new InsufficientFundsError('Insufficient available balance');
    }
    const wallet = await tx.userPointsWallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    await tx.pointsTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        amount: -amount,
        type: type || 'debit',
        description: description || null,
        metadata: metadata || null,
      },
    });
  });

  logger.info(`Debited ${amount} points from user ${userId}`);
}

async function getAvailableBalance(userId) {
  const w = await prisma.userPointsWallet.findUnique({ where: { userId } });
  if (!w) return { balance: 0, heldBalance: 0, available: 0 };
  return {
    balance: w.balance,
    heldBalance: w.heldBalance,
    available: Math.max(0, w.balance - w.heldBalance),
  };
}

module.exports = {
  awardTournamentPoints,
  creditPointsToWallet,
  debitPointsFromWallet,
  parseLeaderboardScore,
  holdPoints,
  releaseHold,
  transferHeldToWinner,
  getAvailableBalance,
  InsufficientFundsError,
};
