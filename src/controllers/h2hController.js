const { prisma } = require('../config/db');
const logger = require('../config/logger');
const points = require('../services/pointsService');
const h2h = require('../services/h2hService');
const { createNotification } = require('../services/notificationService');
const { emitH2HTeamsLocked } = require('../config/socket');

const TEAM_SIZE = h2h.TEAM_SIZE;

// ─── Serialization helpers ──────────────────────────────────────────────────
// Picks visibility rule: opponent's team is hidden until BOTH have locked.
// Once both sides are locked, reveal teams immediately.
function serializePick(pick) {
  if (!pick) return null;
  return {
    userId: pick.userId,
    playerIds: Array.isArray(pick.playerIds) ? pick.playerIds : [],
    submittedAt: pick.submittedAt?.toISOString?.() || null,
    lockedAt: pick.lockedAt?.toISOString?.() || null,
  };
}

function serializeChallenge(c, viewerId, { includePicks = false, leaderboardRows = null } = {}) {
  const youAreChallenger = c.challengerId === viewerId;
  const youAreOpponent   = c.opponentId === viewerId;
  const role = youAreChallenger ? 'challenger' : youAreOpponent ? 'opponent' : 'observer';

  const yourPick = c.picks?.find((p) => p.userId === viewerId) || null;
  const theirPick = c.picks?.find((p) => p.userId !== viewerId) || null;

  const bothLocked = !!yourPick?.lockedAt && !!theirPick?.lockedAt;
  const opponentPickVisible = bothLocked;

  const out = {
    id: c.id,
    status: c.status,
    role,
    wager: c.wager,
    multiplier: c.multiplier,
    effectiveWager: c.effectiveWager,
    trashTalk: c.trashTalk,
    createdAt: c.createdAt?.toISOString?.() || null,
    acceptedAt: c.acceptedAt?.toISOString?.() || null,
    declinedAt: c.declinedAt?.toISOString?.() || null,
    cancelledAt: c.cancelledAt?.toISOString?.() || null,
    settledAt: c.settledAt?.toISOString?.() || null,
    challengerStrokes: c.challengerStrokes,
    opponentStrokes: c.opponentStrokes,
    winnerId: c.winnerId,
    challenger: c.challenger ? serializeUser(c.challenger) : null,
    opponent:   c.opponent   ? serializeUser(c.opponent)   : null,
    tournament: c.tournament ? {
      id: c.tournament.id,
      tournId: c.tournament.tournId,
      year: c.tournament.year,
      name: c.tournament.name,
      status: c.tournament.status,
      startDate: c.tournament.startDate?.toISOString?.() || null,
      endDate: c.tournament.endDate?.toISOString?.() || null,
      fieldAvailable: c.tournament.fieldAvailable,
      isMajor: c.tournament.isMajor,
      h2hMultiplier: c.tournament.h2hMultiplier,
      h2hBonusDescription: c.tournament.h2hBonusDescription,
    } : null,
  };

  if (includePicks) {
    out.yourPick = serializePick(yourPick);
    out.opponentPick = opponentPickVisible ? serializePick(theirPick) : (theirPick ? {
      userId: theirPick.userId,
      lockedAt: theirPick.lockedAt?.toISOString?.() || null,
      // Hidden until reveal conditions met
      playerIds: null,
      submittedAt: null,
    } : null);

    // If we have a leaderboard, include scoring breakdown for both teams (when visible).
    if (leaderboardRows && bothLocked) {
      const yourIds = Array.isArray(yourPick?.playerIds) ? yourPick.playerIds : [];
      out.yourScore = h2h.scorePicks(yourIds, leaderboardRows);
      if (opponentPickVisible) {
        const oppIds = Array.isArray(theirPick?.playerIds) ? theirPick.playerIds : [];
        out.opponentScore = h2h.scorePicks(oppIds, leaderboardRows);
      }
    }
  }

  return out;
}

function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.profile?.name || u.username,
    photoUrl: u.profile?.golfPassport?.photoUrl || null,
  };
}

const userInclude = {
  challenger: { select: { id: true, username: true, profile: { select: { name: true, golfPassport: { select: { photoUrl: true } } } } } },
  opponent:   { select: { id: true, username: true, profile: { select: { name: true, golfPassport: { select: { photoUrl: true } } } } } },
  tournament: true,
  picks: true,
};

// ─── POST /api/h2h/challenges ───────────────────────────────────────────────
// Body: { opponentId, tournamentId, wager, trashTalk? }
// Holds the challenger's wager (NOT multiplied — multiplier only affects payout).
exports.createChallenge = async (req, res) => {
  try {
    const challengerId = req.user.id;
    const { opponentId, tournamentId, wager, trashTalk } = req.body || {};

    if (!Number.isInteger(opponentId) || !Number.isInteger(tournamentId)) {
      return res.status(400).json({ success: false, message: 'opponentId and tournamentId required' });
    }
    if (opponentId === challengerId) {
      return res.status(400).json({ success: false, message: "You can't challenge yourself" });
    }
    const wagerInt = parseInt(wager, 10);
    if (!Number.isInteger(wagerInt) || wagerInt < 1) {
      return res.status(400).json({ success: false, message: 'Wager must be a positive integer' });
    }

    const [opponent, tournament] = await Promise.all([
      prisma.user.findUnique({ where: { id: opponentId }, select: { id: true } }),
      prisma.tournament.findUnique({ where: { id: tournamentId } }),
    ]);
    if (!opponent) return res.status(404).json({ success: false, message: 'Opponent not found' });
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found' });
    if (tournament.status !== 'upcoming') {
      return res.status(409).json({ success: false, message: 'Challenges can only be created for upcoming tournaments' });
    }

    const multiplier = tournament.h2hMultiplier && tournament.h2hMultiplier > 0
      ? tournament.h2hMultiplier
      : 1.0;
    // effectiveWager is now just the base wager (both players hold this amount)
    const effectiveWager = wagerInt;

    // Hold first — if it throws InsufficientFundsError, no challenge gets created.
    try {
      await points.holdPoints(challengerId, effectiveWager, {
        description: `H2H challenge wager (vs user ${opponentId})`,
        metadata: { tournamentId, wager: wagerInt, multiplier },
      });
    } catch (err) {
      if (err instanceof points.InsufficientFundsError) {
        return res.status(402).json({ success: false, message: 'Insufficient available balance' });
      }
      throw err;
    }

    let challenge;
    try {
      challenge = await prisma.challenge.create({
        data: {
          challengerId,
          opponentId,
          tournamentId,
          wager: wagerInt,
          multiplier,
          effectiveWager,
          trashTalk: trashTalk || null,
        },
        include: userInclude,
      });
    } catch (err) {
      // Roll back the hold if the challenge row failed to create.
      await points.releaseHold(challengerId, effectiveWager, {
        description: 'H2H challenge create failed',
        metadata: { tournamentId, wager: wagerInt },
      }).catch(() => {});
      throw err;
    }

    await createNotification({
      userId: opponentId,
      type: 'H2H_CHALLENGE_RECEIVED',
      actorId: challengerId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: {
        challengeId: challenge.id,
        tournamentId,
        tournamentName: tournament.name,
        wager: wagerInt,
        effectiveWager,
        multiplier,
        trashTalk: trashTalk || null,
      },
    });

    res.json({ success: true, data: { challenge: serializeChallenge(challenge, challengerId) } });
  } catch (error) {
    logger.error(`createChallenge error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/h2h/challenges?role=incoming|outgoing|active|past&status=... ─
exports.listChallenges = async (req, res) => {
  try {
    const userId = req.user.id;
    const role = (req.query.role || 'all').toString();
    const statusFilter = req.query.status ? String(req.query.status).split(',') : null;

    await h2h.expirePendingChallengesPastLockDeadline(userId);

    const where = { OR: [{ challengerId: userId }, { opponentId: userId }] };

    if (role === 'incoming') {
      where.OR = undefined;
      where.opponentId = userId;
      where.status = 'PENDING';
    } else if (role === 'outgoing') {
      where.OR = undefined;
      where.challengerId = userId;
      where.status = 'PENDING';
    } else if (role === 'active') {
      where.status = { in: ['ACCEPTED', 'LOCKED', 'LIVE'] };
    } else if (role === 'past') {
      where.status = { in: ['COMPLETED', 'DECLINED', 'CANCELLED', 'REFUNDED'] };
    }

    if (statusFilter) {
      where.status = { in: statusFilter };
    }

    const challenges = await prisma.challenge.findMany({
      where,
      include: userInclude,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({
      success: true,
      data: { challenges: challenges.map((c) => serializeChallenge(c, userId)) },
    });
  } catch (error) {
    logger.error(`listChallenges error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/h2h/challenges/:id ───────────────────────────────────────────
exports.getChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });

    const challenge = await prisma.challenge.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.challengerId !== userId && challenge.opponentId !== userId) {
      return res.status(403).json({ success: false, message: 'Not your challenge' });
    }

    const leaderboardRows = Array.isArray(challenge.tournament?.leaderboard?.rows)
      ? challenge.tournament.leaderboard.rows
      : null;

    res.json({
      success: true,
      data: {
        challenge: serializeChallenge(challenge, userId, { includePicks: true, leaderboardRows }),
      },
    });
  } catch (error) {
    logger.error(`getChallenge error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/h2h/challenges/:id/accept ───────────────────────────────────
exports.acceptChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const challenge = await prisma.challenge.findUnique({
      where: { id },
      include: { tournament: true },
    });
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.opponentId !== userId) return res.status(403).json({ success: false, message: 'Only the opponent can accept' });
    if (challenge.status !== 'PENDING') return res.status(409).json({ success: false, message: `Challenge is ${challenge.status}` });
    if (h2h.isPastLockDeadline(challenge.tournament)) {
      await h2h.expirePendingChallengesPastLockDeadline(userId);
      return res.status(409).json({
        success: false,
        message: 'Challenge can no longer be accepted because the tournament is live.',
      });
    }

    // Opponent holds the same base wager amount (not multiplied)
    try {
      await points.holdPoints(userId, challenge.effectiveWager, {
        description: 'H2H challenge accept wager',
        metadata: { challengeId: challenge.id },
      });
    } catch (err) {
      if (err instanceof points.InsufficientFundsError) {
        return res.status(402).json({ success: false, message: 'Insufficient available balance' });
      }
      throw err;
    }

    const updated = await prisma.challenge.update({
      where: { id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
      include: userInclude,
    });

    await createNotification({
      userId: challenge.challengerId,
      type: 'H2H_CHALLENGE_ACCEPTED',
      actorId: userId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: { challengeId: challenge.id },
    });

    res.json({ success: true, data: { challenge: serializeChallenge(updated, userId) } });
  } catch (error) {
    logger.error(`acceptChallenge error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/h2h/challenges/:id/decline ──────────────────────────────────
exports.declineChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.opponentId !== userId) return res.status(403).json({ success: false, message: 'Only the opponent can decline' });
    if (challenge.status !== 'PENDING') return res.status(409).json({ success: false, message: `Challenge is ${challenge.status}` });

    await points.releaseHold(challenge.challengerId, challenge.effectiveWager, {
      description: 'H2H challenge declined',
      metadata: { challengeId: challenge.id },
    });

    const updated = await prisma.challenge.update({
      where: { id },
      data: { status: 'DECLINED', declinedAt: new Date() },
      include: userInclude,
    });

    await createNotification({
      userId: challenge.challengerId,
      type: 'H2H_CHALLENGE_DECLINED',
      actorId: userId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: { challengeId: challenge.id },
    });

    res.json({ success: true, data: { challenge: serializeChallenge(updated, userId) } });
  } catch (error) {
    logger.error(`declineChallenge error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/h2h/challenges/:id/cancel ───────────────────────────────────
// Challenger-only, only while still PENDING.
exports.cancelChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.challengerId !== userId) return res.status(403).json({ success: false, message: 'Only the challenger can cancel' });
    if (challenge.status !== 'PENDING') return res.status(409).json({ success: false, message: `Cannot cancel: ${challenge.status}` });

    await points.releaseHold(userId, challenge.effectiveWager, {
      description: 'H2H challenge cancelled',
      metadata: { challengeId: challenge.id },
    });

    const updated = await prisma.challenge.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: userInclude,
    });

    await createNotification({
      userId: challenge.opponentId,
      type: 'H2H_CHALLENGE_CANCELLED',
      actorId: userId,
      entityType: 'challenge',
      entityId: challenge.id,
      data: { challengeId: challenge.id },
    });

    res.json({ success: true, data: { challenge: serializeChallenge(updated, userId) } });
  } catch (error) {
    logger.error(`cancelChallenge error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── PUT /api/h2h/challenges/:id/picks ─────────────────────────────────────
// Body: { playerIds: string[] } — exactly TEAM_SIZE entries, each in field.
exports.savePicks = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const { playerIds } = req.body || {};

    const validation = await validatePicksOrError(id, userId, playerIds, { requireExact: false });
    if (validation.error) {
      return res.status(validation.status).json({ success: false, message: validation.error });
    }
    const { challenge } = validation;

    const row = await prisma.challengePick.upsert({
      where: { challengeId_userId: { challengeId: id, userId } },
      update: { playerIds, submittedAt: new Date() },
      create: { challengeId: id, userId, playerIds },
    });

    res.json({
      success: true,
      data: {
        pick: serializePick(row),
        challengeStatus: challenge.status,
      },
    });
  } catch (error) {
    logger.error(`savePicks error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/h2h/challenges/:id/picks/lock ───────────────────────────────
// Body: { playerIds: string[] } — must be exactly TEAM_SIZE.
exports.lockPicks = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const { playerIds } = req.body || {};

    const validation = await validatePicksOrError(id, userId, playerIds, { requireExact: true });
    if (validation.error) {
      return res.status(validation.status).json({ success: false, message: validation.error });
    }
    const { challenge } = validation;

    const now = new Date();
    const pick = await prisma.challengePick.upsert({
      where: { challengeId_userId: { challengeId: id, userId } },
      update: { playerIds, submittedAt: now, lockedAt: now },
      create: { challengeId: id, userId, playerIds, lockedAt: now },
    });

    // If both locked, flip challenge to LOCKED.
    const allPicks = await prisma.challengePick.findMany({ where: { challengeId: id } });
    const bothLocked = allPicks.length === 2 && allPicks.every((p) => p.lockedAt);

    let updatedChallenge = challenge;
    if (bothLocked && challenge.status === 'ACCEPTED') {
      updatedChallenge = await prisma.challenge.update({
        where: { id },
        data: {
          status: 'LOCKED',
          challengerLockedAt: allPicks.find((p) => p.userId === challenge.challengerId)?.lockedAt,
          opponentLockedAt:   allPicks.find((p) => p.userId === challenge.opponentId)?.lockedAt,
        },
      });
    } else {
      // Even if not both locked, persist this side's lockedAt timestamp on the challenge.
      const data = userId === challenge.challengerId
        ? { challengerLockedAt: now }
        : { opponentLockedAt: now };
      updatedChallenge = await prisma.challenge.update({ where: { id }, data });
    }

    if (bothLocked) {
      emitH2HTeamsLocked(id, challenge.challengerId, challenge.opponentId);
    }

    // Notify the opponent that you locked.
    const opponentUserId = userId === challenge.challengerId ? challenge.opponentId : challenge.challengerId;
    await createNotification({
      userId: opponentUserId,
      type: 'H2H_CHALLENGE_OPPONENT_LOCKED',
      actorId: userId,
      entityType: 'challenge',
      entityId: id,
      data: { challengeId: id, bothLocked },
    });

    res.json({
      success: true,
      data: {
        pick: serializePick(pick),
        challengeStatus: updatedChallenge.status,
        bothLocked,
      },
    });
  } catch (error) {
    logger.error(`lockPicks error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Shared validation: ownership, status, deadline, field membership, dupes,
// length, lock immutability. Returns { error, status } on failure or
// { challenge, fieldIds } on success.
async function validatePicksOrError(challengeId, userId, playerIds, { requireExact }) {
  if (!Number.isInteger(challengeId)) return { error: 'Invalid id', status: 400 };
  if (!Array.isArray(playerIds)) return { error: 'playerIds must be an array', status: 400 };
  if (requireExact && playerIds.length !== TEAM_SIZE) {
    return { error: `Must lock exactly ${TEAM_SIZE} players`, status: 400 };
  }
  if (playerIds.length > TEAM_SIZE) {
    return { error: `Maximum ${TEAM_SIZE} players`, status: 400 };
  }
  if (new Set(playerIds.map(String)).size !== playerIds.length) {
    return { error: 'Duplicate players in your team', status: 400 };
  }

  const challenge = await prisma.challenge.findUnique({
    where: { id: challengeId },
    include: { tournament: true },
  });
  if (!challenge) return { error: 'Challenge not found', status: 404 };
  if (challenge.challengerId !== userId && challenge.opponentId !== userId) {
    return { error: 'Not your challenge', status: 403 };
  }
  if (!['ACCEPTED', 'LOCKED'].includes(challenge.status)) {
    return { error: `Cannot pick in status ${challenge.status}`, status: 409 };
  }

  // Past lock deadline → no more picks even if challenge is ACCEPTED.
  if (h2h.isPastLockDeadline(challenge.tournament)) {
    return { error: 'Picks are locked for this tournament', status: 409 };
  }

  // Already locked yourself → can't change.
  const existing = await prisma.challengePick.findUnique({
    where: { challengeId_userId: { challengeId, userId } },
  });
  if (existing?.lockedAt) {
    return { error: 'Your team is already locked', status: 409 };
  }

  if (!challenge.tournament?.fieldAvailable) {
    return { error: 'Player field is not yet available — picks open Monday before the tournament', status: 409 };
  }

  // Validate that every playerId is in this tournament's field.
  if (playerIds.length > 0) {
    const tps = await prisma.tournamentPlayer.findMany({
      where: { tournamentId: challenge.tournamentId },
      include: { player: { select: { playerId: true } } },
    });
    const fieldIds = new Set(tps.map((tp) => tp.player.playerId));
    const bad = playerIds.find((pid) => !fieldIds.has(String(pid)));
    if (bad) return { error: `Player ${bad} is not in this tournament's field`, status: 400 };
    return { challenge, fieldIds };
  }

  return { challenge, fieldIds: new Set() };
}

// ─── GET /api/h2h/challenges/:id/field ─────────────────────────────────────
// Convenience — returns the tournament's full player list for the picker UI,
// scoped to the challenge so the frontend doesn't need to know the tournId.
exports.getChallengeField = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id, 10);
    const challenge = await prisma.challenge.findUnique({
      where: { id },
      select: { id: true, challengerId: true, opponentId: true, tournamentId: true },
    });
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    if (challenge.challengerId !== userId && challenge.opponentId !== userId) {
      return res.status(403).json({ success: false, message: 'Not your challenge' });
    }

    const tps = await prisma.tournamentPlayer.findMany({
      where: { tournamentId: challenge.tournamentId },
      include: { player: true },
      orderBy: [{ tier: 'asc' }, { tierRank: 'asc' }],
    });

    const players = tps.map((tp) => ({
      playerId: tp.player.playerId,
      firstName: tp.player.firstName,
      lastName: tp.player.lastName,
      country: tp.player.country,
      owgrRank: tp.player.owgrRank,
      tier: tp.tier,
      tierRank: tp.tierRank,
    }));

    res.json({ success: true, data: { players } });
  } catch (error) {
    logger.error(`getChallengeField error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/h2h/stats ────────────────────────────────────────────────────
// Dashboard stats: W/L, total H2H bonus, active count.
exports.getStats = async (req, res) => {
  try {
    const userId = req.user.id;
    await h2h.expirePendingChallengesPastLockDeadline(userId);

    const [completed, active] = await Promise.all([
      prisma.challenge.findMany({
        where: {
          status: { in: ['COMPLETED', 'REFUNDED'] },
          OR: [{ challengerId: userId }, { opponentId: userId }],
        },
        select: { id: true, winnerId: true, effectiveWager: true, challengerId: true, opponentId: true, status: true },
      }),
      prisma.challenge.count({
        where: {
          status: { in: ['PENDING', 'ACCEPTED', 'LOCKED', 'LIVE'] },
          OR: [{ challengerId: userId }, { opponentId: userId }],
        },
      }),
    ]);

    let wins = 0, losses = 0, ties = 0, bonus = 0;
    for (const c of completed) {
      if (c.status === 'REFUNDED' && c.winnerId === null) {
        ties++;
        continue;
      }
      if (c.winnerId === userId) {
        wins++;
        bonus += c.effectiveWager;
      } else if (c.winnerId !== null) {
        losses++;
        bonus -= c.effectiveWager;
      } else {
        ties++;
      }
    }

    res.json({
      success: true,
      data: { wins, losses, ties, activeCount: active, bonus },
    });
  } catch (error) {
    logger.error(`getStats error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createChallenge: exports.createChallenge,
  listChallenges: exports.listChallenges,
  getChallenge: exports.getChallenge,
  acceptChallenge: exports.acceptChallenge,
  declineChallenge: exports.declineChallenge,
  cancelChallenge: exports.cancelChallenge,
  savePicks: exports.savePicks,
  lockPicks: exports.lockPicks,
  getChallengeField: exports.getChallengeField,
  getStats: exports.getStats,
};
