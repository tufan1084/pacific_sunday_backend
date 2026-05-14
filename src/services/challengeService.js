const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { creditPointsToWallet } = require('./pointsService');
const { createNotification } = require('./notificationService');

const NFC_TAP_MONTHLY_THRESHOLD = 5;

/**
 * Core helper: if there is an active AchievementChallenge whose triggerType
 * matches `triggerType` and the user hasn't completed it yet, record the
 * completion and credit the user's wallet.
 *
 * Idempotent — the unique (userId, challengeId) constraint means concurrent
 * triggers for the same achievement collapse to a single completion.
 *
 * Fire-and-forget at call sites: wrap in try/catch and log only, so a
 * challenge-tracking failure never breaks the underlying user action
 * (e.g. registration, scan, profile save).
 *
 * @returns {Promise<{ completed: boolean, awarded?: number, challenge?: object }>}
 */
async function checkAndAwardChallenge(userId, triggerType, metadata = {}) {
  if (!userId || !triggerType) {
    return { completed: false };
  }

  const challenge = await prisma.achievementChallenge.findUnique({
    where: { triggerType },
  });
  if (!challenge || !challenge.isActive) {
    return { completed: false };
  }

  // Already completed?
  const existing = await prisma.userChallengeCompletion.findUnique({
    where: { userId_challengeId: { userId, challengeId: challenge.id } },
  });
  if (existing) {
    return { completed: false };
  }

  try {
    await prisma.userChallengeCompletion.create({
      data: { userId, challengeId: challenge.id },
    });
  } catch (err) {
    // Concurrent insert lost the race — treat as already completed.
    if (err.code === 'P2002') return { completed: false };
    throw err;
  }

  await creditPointsToWallet(userId, challenge.points, {
    type: 'challenge_unlock',
    description: `Challenge unlocked: ${challenge.title}`,
    metadata: { challengeId: challenge.id, triggerType, ...metadata },
  });

  // In-app notification — surfaces in the bell + /notifications page and
  // pushes over socket so the unread count badges in real time.
  // Fire-and-forget: a notification failure must not undo the unlock.
  createNotification({
    userId,
    type: 'CHALLENGE_UNLOCKED',
    data: {
      challengeId: challenge.id,
      title: challenge.title,
      description: challenge.description,
      points: challenge.points,
      triggerType,
    },
  }).catch((err) =>
    logger.error(`createNotification (CHALLENGE_UNLOCKED) failed: ${err.message}`),
  );

  logger.info(
    `Challenge unlocked: userId=${userId} triggerType=${triggerType} +${challenge.points}pts`,
  );

  return { completed: true, awarded: challenge.points, challenge };
}

/**
 * Returns the number of NFC scans the user has had this calendar month
 * (across all of their bags). Used to decide if `nfc_tap_5x_month` should
 * fire after a fresh scan.
 */
async function countMonthlyTaps(userId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return prisma.scan.count({
    where: {
      bag: { userId },
      scanTime: { gte: startOfMonth },
    },
  });
}

/**
 * Convenience: call after a scan. Awards the monthly-tap challenge if the
 * user just crossed the threshold (and hasn't already unlocked it).
 */
async function checkMonthlyTapMilestone(userId) {
  const count = await countMonthlyTaps(userId);
  if (count < NFC_TAP_MONTHLY_THRESHOLD) {
    return { completed: false };
  }
  return checkAndAwardChallenge(userId, 'nfc_tap_5x_month', { tapCount: count });
}

// Every field on the Golf Passport form. The challenge fires only when all
// of these are filled — partial progress is shown to the user as a fraction
// of how many are non-empty.
const PROFILE_FIELDS = [
  'fullName',
  'nickname',
  'handicap',
  'bestScore',
  'yearsPlaying',
  'homeCourse',
  'golfCountry',
  'bio',
];

function profileFilledCount(golfPassport) {
  if (!golfPassport) return 0;
  return PROFILE_FIELDS.reduce(
    (count, field) =>
      golfPassport[field] && String(golfPassport[field]).trim() !== ''
        ? count + 1
        : count,
    0,
  );
}

/**
 * Whole-number percentage 0–100 of how filled the passport is. Used by the
 * challenges list endpoint to render the in-progress bar before unlock.
 */
function profileCompletionPercent(golfPassport) {
  return Math.round((profileFilledCount(golfPassport) / PROFILE_FIELDS.length) * 100);
}

/**
 * Strict completion check — every field on the passport must be non-empty
 * for the `profile_completed` achievement to fire. Matches the user's
 * intuition of "I've fully filled out my profile."
 */
function isProfileComplete(golfPassport) {
  return profileFilledCount(golfPassport) === PROFILE_FIELDS.length;
}

module.exports = {
  checkAndAwardChallenge,
  checkMonthlyTapMilestone,
  countMonthlyTaps,
  isProfileComplete,
  profileCompletionPercent,
  PROFILE_FIELDS,
  NFC_TAP_MONTHLY_THRESHOLD,
};
