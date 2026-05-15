const { prisma } = require('../config/db');
const logger = require('../config/logger');
const {
  profileCompletionPercent,
  countMonthlyTaps,
  NFC_TAP_MONTHLY_THRESHOLD,
} = require('../services/challengeService');

const ALLOWED_UPDATE_FIELDS = ['title', 'description', 'points', 'isActive'];

/**
 * GET /challenges
 * Public catalog of active achievement-style challenges.
 */
const listChallenges = async (_req, res, next) => {
  try {
    const challenges = await prisma.achievementChallenge.findMany({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    return res.status(200).json({
      success: true,
      data: { challenges },
      message: 'Challenges retrieved.',
    });
  } catch (err) {
    logger.error(`listChallenges error: ${err.message}`);
    next(err);
  }
};

/**
 * GET /users/my-challenges
 * Returns every active challenge with `unlocked`, `unlockedAt`, and
 * `progress` (0–100) for the authenticated user. `progress` is computed
 * per-challenge so the bar can show partial fill before the unlock fires.
 */
const listMyChallenges = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [challenges, completions, profile, registeredBags, monthlyTaps, h2hWins, redemptionCount, referralCount] =
      await Promise.all([
        prisma.achievementChallenge.findMany({
          where: { isActive: true },
          orderBy: { id: 'asc' },
        }),
        prisma.userChallengeCompletion.findMany({ where: { userId } }),
        prisma.userProfile.findUnique({
          where: { userId },
          include: { golfPassport: true },
        }),
        prisma.bag.count({ where: { userId, registered: true } }),
        countMonthlyTaps(userId),
        prisma.challenge.count({ where: { winnerId: userId, status: 'COMPLETED' } }),
        prisma.rewardRedemption.count({ where: { userId } }),
        prisma.referral.count({ where: { referrerId: userId } }),
      ]);

    const completionMap = new Map(completions.map((c) => [c.challengeId, c.completedAt]));

    const computeProgress = (triggerType, unlocked) => {
      if (unlocked) return 100;
      switch (triggerType) {
        case 'profile_completed':
          return profileCompletionPercent(profile?.golfPassport);
        case 'nfc_tap_5x_month':
          return Math.min(100, Math.round((monthlyTaps / NFC_TAP_MONTHLY_THRESHOLD) * 100));
        case 'bag_registered':
          return registeredBags > 0 ? 100 : 0;
        case 'h2h_won':
          return h2hWins > 0 ? 100 : 0;
        case 'reward_redeemed':
          return redemptionCount > 0 ? 100 : 0;
        case 'referral':
          return referralCount > 0 ? 100 : 0;
        default:
          return 0;
      }
    };

    const data = challenges.map((c) => {
      const unlocked = completionMap.has(c.id);
      return {
        id: c.id,
        triggerType: c.triggerType,
        title: c.title,
        description: c.description,
        points: c.points,
        unlocked,
        unlockedAt: completionMap.get(c.id) || null,
        progress: computeProgress(c.triggerType, unlocked),
      };
    });

    return res.status(200).json({
      success: true,
      data: { challenges: data },
      message: 'My challenges retrieved.',
    });
  } catch (err) {
    logger.error(`listMyChallenges error: ${err.message}`);
    next(err);
  }
};

// ─── Admin ─────────────────────────────────────────────────────────────────

/**
 * GET /admin/challenges
 * Returns all challenges (active + inactive) plus how many users completed each.
 */
const adminListChallenges = async (_req, res, next) => {
  try {
    const challenges = await prisma.achievementChallenge.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { completions: true } } },
    });
    const data = challenges.map((c) => ({
      id: c.id,
      triggerType: c.triggerType,
      title: c.title,
      description: c.description,
      points: c.points,
      isActive: c.isActive,
      completedBy: c._count.completions,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
    return res.status(200).json({
      success: true,
      data: { challenges: data },
      message: 'Admin challenge list retrieved.',
    });
  } catch (err) {
    logger.error(`adminListChallenges error: ${err.message}`);
    next(err);
  }
};

/**
 * PUT /admin/challenges/:id
 * Body: { title?, description?, points?, isActive? }
 *
 * triggerType is intentionally NOT updatable — it is the contract between
 * the catalog row and the call-site that fires its trigger.
 */
const adminUpdateChallenge = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Invalid challenge id.',
      });
    }

    const updates = {};
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'No updatable fields supplied.',
      });
    }
    if (updates.points !== undefined) {
      const n = Number(updates.points);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'points must be a non-negative integer.',
        });
      }
      updates.points = n;
    }

    const updated = await prisma.achievementChallenge.update({
      where: { id },
      data: updates,
    });

    return res.status(200).json({
      success: true,
      data: { challenge: updated },
      message: 'Challenge updated.',
    });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Challenge not found.',
      });
    }
    logger.error(`adminUpdateChallenge error: ${err.message}`);
    next(err);
  }
};

module.exports = {
  listChallenges,
  listMyChallenges,
  adminListChallenges,
  adminUpdateChallenge,
};
