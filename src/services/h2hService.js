const { prisma } = require('../config/db');
const logger = require('../config/logger');
const sync = require('./golfSyncService');
const points = require('./pointsService');
const { releaseHold, transferHeldToWinner } = points;
const { createNotification } = require('./notificationService');
const { checkAndAwardChallenge } = require('./challengeService');
const { emitH2HChallengeUpdated } = require('../config/socket');

// Strokes substituted for picks who missed the cut, withdrew, or otherwise have
// no parsed score. Penalty is high enough to swing matches but not so high that
// one MC always wins it — the loser still has a chance if the opponent had a
// disastrous week with the rest of their team.
const MISSED_CUT_STROKES = 20;
const TEAM_SIZE = 10;

// A challenge is past its lock window once we cross midnight PT of the
// tournament's start date — same threshold the fantasy picks use.
function isPastLockDeadline(tournament) {
  if (!tournament?.startDate) return false;
  if (tournament.status === 'live' || tournament.status === 'completed') return true;
  return new Date() >= sync.startOfPTDay(tournament.startDate);
}

// Sum strokes-vs-par for the 10 picked players against the tournament's stored
// leaderboard. Players not on the leaderboard or with unparseable scores get
// the missed-cut penalty so they can't accidentally improve a team's total.
function scorePicks(playerIds, leaderboardRows) {
  const byId = new Map();
  for (const row of leaderboardRows || []) {
    if (row?.playerId) byId.set(String(row.playerId), row);
  }

  let total = 0;
  const breakdown = [];
  for (const pid of playerIds) {
    const row = byId.get(String(pid));
    const parsed = row ? points.parseLeaderboardScore(row.score) : null;
    const strokes = parsed === null ? MISSED_CUT_STROKES : parsed;
    total += strokes;
    breakdown.push({
      playerId: pid,
      name: row?.name || null,
      score: row?.score ?? null,
      strokes,
      missedCut: parsed === null,
    });
  }
  return { total, breakdown };
}

// Settle every LOCKED challenge for a tournament. Idempotent — challenges
// already COMPLETED/REFUNDED are skipped. Called from the cron right after
// awardTournamentPoints when the tournament transitions to `completed`.
async function settleChallenges(tournamentId) {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new Error(`Tournament ${tournamentId} not found`);
  if (tournament.status !== 'completed') {
    throw new Error(`Tournament ${tournament.tournId} is not completed (status=${tournament.status})`);
  }

  const leaderboardRows = Array.isArray(tournament.leaderboard?.rows)
    ? tournament.leaderboard.rows
    : [];

  const open = await prisma.challenge.findMany({
    where: {
      tournamentId,
      status: { in: ['ACCEPTED', 'LOCKED', 'LIVE'] },
    },
    include: { picks: true },
  });

  const results = [];
  for (const ch of open) {
    try {
      const challengerPick = ch.picks.find((p) => p.userId === ch.challengerId);
      const opponentPick   = ch.picks.find((p) => p.userId === ch.opponentId);

      // Either side never locked → refund both holds, no settlement.
      if (!challengerPick?.lockedAt || !opponentPick?.lockedAt) {
        await refundChallenge(ch, 'auto-refund: missing lock at tournament close');
        results.push({ id: ch.id, outcome: 'refunded' });
        continue;
      }

      const cIds = Array.isArray(challengerPick.playerIds) ? challengerPick.playerIds : [];
      const oIds = Array.isArray(opponentPick.playerIds)   ? opponentPick.playerIds   : [];

      const challengerScore = scorePicks(cIds, leaderboardRows);
      const opponentScore   = scorePicks(oIds, leaderboardRows);

      // Lower combined strokes wins (real-golf scoring).
      let winnerId = null;
      if (challengerScore.total < opponentScore.total) winnerId = ch.challengerId;
      else if (opponentScore.total < challengerScore.total) winnerId = ch.opponentId;
      // else tie → null winner, refund both

      if (winnerId === null) {
        await prisma.$transaction([
          prisma.challenge.update({
            where: { id: ch.id },
            data: {
              status: 'REFUNDED',
              challengerStrokes: challengerScore.total,
              opponentStrokes: opponentScore.total,
              settledAt: new Date(),
            },
          }),
        ]);
        await releaseHold(ch.challengerId, ch.effectiveWager, {
          description: `H2H tie refund vs user ${ch.opponentId}`,
          metadata: { challengeId: ch.id, reason: 'tie' },
        });
        await releaseHold(ch.opponentId, ch.effectiveWager, {
          description: `H2H tie refund vs user ${ch.challengerId}`,
          metadata: { challengeId: ch.id, reason: 'tie' },
        });
        await notifyResult(ch, null, challengerScore.total, opponentScore.total);
        results.push({ id: ch.id, outcome: 'tie' });
        continue;
      }

      const loserId = winnerId === ch.challengerId ? ch.opponentId : ch.challengerId;

      // With multiplier bonus:
      // Winner gets: their wager + opponent's wager + bonus (wager * (multiplier - 1))
      // Loser loses: their full wager only
      const bonusAmount = Math.round(ch.effectiveWager * (ch.multiplier - 1));
      
      // Transfer held amounts (winner gets their hold back + loser's hold)
      await transferHeldToWinner({
        loserId,
        winnerId,
        amount: ch.effectiveWager,
        description: `H2H ${ch.tournament?.name || 'tournament'} settlement`,
        metadata: { challengeId: ch.id },
      });

      // Award bonus to winner (extra points from multiplier)
      if (bonusAmount > 0) {
        await points.awardPoints(winnerId, bonusAmount, {
          description: `H2H bonus (${ch.multiplier}x multiplier)`,
          metadata: { challengeId: ch.id, multiplier: ch.multiplier },
        });
      }

      await prisma.challenge.update({
        where: { id: ch.id },
        data: {
          status: 'COMPLETED',
          challengerStrokes: challengerScore.total,
          opponentStrokes: opponentScore.total,
          winnerId,
          settledAt: new Date(),
        },
      });

      // Achievement trigger — winner's first H2H victory.
      checkAndAwardChallenge(winnerId, 'h2h_won', { challengeId: ch.id }).catch((err) =>
        logger.error(`Challenge trigger (h2h_won) failed: ${err.message}`),
      );

      await notifyResult(ch, winnerId, challengerScore.total, opponentScore.total);
      results.push({ id: ch.id, outcome: winnerId === ch.challengerId ? 'challenger' : 'opponent' });
    } catch (err) {
      logger.error(`[h2h:settle] challenge ${ch.id} failed: ${err.message}`);
      results.push({ id: ch.id, outcome: 'error', error: err.message });
    }
  }

  logger.info(`[h2h:settle] tournament ${tournament.tournId}: ${results.length} processed`);
  return results;
}

// Release both sides' held wagers and mark refunded. Used for: tournament
// closing with one side never locked, admin force-refund, or cancelled
// after-the-fact.
async function refundChallenge(challenge, reason) {
  await prisma.challenge.update({
    where: { id: challenge.id },
    data: { status: 'REFUNDED', settledAt: new Date() },
  });
  // If status is still PENDING, only the challenger has a hold. Accepted and
  // later statuses have both sides held.
  await releaseHold(challenge.challengerId, challenge.effectiveWager, {
    description: 'H2H challenge refunded',
    metadata: { challengeId: challenge.id, reason },
  });
  if (challenge.status !== 'PENDING') {
    await releaseHold(challenge.opponentId, challenge.effectiveWager, {
      description: 'H2H challenge refunded',
      metadata: { challengeId: challenge.id, reason },
    });
  }
}

async function expirePendingChallengesPastLockDeadline(userId = null) {
  const where = { status: 'PENDING' };
  if (userId) {
    where.OR = [{ challengerId: userId }, { opponentId: userId }];
  }

  const pending = await prisma.challenge.findMany({
    where,
    include: { tournament: true },
    take: 200,
  });

  let expired = 0;
  for (const challenge of pending) {
    if (!isPastLockDeadline(challenge.tournament)) continue;

    const claimed = await prisma.challenge.updateMany({
      where: { id: challenge.id, status: 'PENDING' },
      data: { status: 'REFUNDED', settledAt: new Date() },
    });
    if (claimed.count === 0) continue;

    await releaseHold(challenge.challengerId, challenge.effectiveWager, {
      description: 'H2H challenge expired',
      metadata: {
        challengeId: challenge.id,
        reason: 'pending challenge reached lock deadline',
      },
    });
    emitH2HChallengeUpdated(
      challenge.id,
      challenge.challengerId,
      challenge.opponentId,
      'expired',
      'REFUNDED',
    );
    expired++;
  }

  if (expired > 0) {
    logger.info(`[h2h:expire] ${expired} pending challenge(s) expired at lock deadline`);
  }
  return expired;
}

async function notifyResult(challenge, winnerId, challengerStrokes, opponentStrokes) {
  const data = {
    challengeId: challenge.id,
    tournamentId: challenge.tournamentId,
    challengerStrokes,
    opponentStrokes,
    effectiveWager: challenge.effectiveWager,
  };
  await Promise.all([
    createNotification({
      userId: challenge.challengerId,
      type: 'H2H_CHALLENGE_RESULT',
      actorId: challenge.opponentId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: { ...data, outcome: winnerId === null ? 'tie' : winnerId === challenge.challengerId ? 'won' : 'lost' },
    }),
    createNotification({
      userId: challenge.opponentId,
      type: 'H2H_CHALLENGE_RESULT',
      actorId: challenge.challengerId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: { ...data, outcome: winnerId === null ? 'tie' : winnerId === challenge.opponentId ? 'won' : 'lost' },
    }),
  ]);
}

module.exports = {
  settleChallenges,
  refundChallenge,
  expirePendingChallengesPastLockDeadline,
  scorePicks,
  isPastLockDeadline,
  MISSED_CUT_STROKES,
  TEAM_SIZE,
};
