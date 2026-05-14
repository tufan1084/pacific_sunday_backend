const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { checkAndAwardChallenge } = require('./challengeService');

/**
 * Referral codes are derived from the referrer's username — no separate
 * code-issuance flow needed. A user shares their username; the new signup
 * sends `referralCode: "<username>"` and we link them.
 *
 * Each new user can be the *referredUser* on at most one referral (DB
 * uniqueness on referredUserId). The referrer gets the `referral`
 * achievement on their first successful referral.
 */
async function recordReferral(referralCode, referredUserId) {
  if (!referralCode || !referredUserId) return null;

  const trimmed = String(referralCode).trim();
  if (!trimmed) return null;

  const referrer = await prisma.user.findUnique({ where: { username: trimmed } });
  if (!referrer) {
    logger.warn(`Referral ignored: unknown code "${trimmed}"`);
    return null;
  }
  if (referrer.id === referredUserId) {
    logger.warn(`Referral ignored: self-referral userId=${referredUserId}`);
    return null;
  }

  try {
    await prisma.referral.create({
      data: {
        referrerId: referrer.id,
        referredUserId,
        code: trimmed,
      },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      logger.info(`Referral skipped: userId=${referredUserId} already referred`);
      return null;
    }
    throw err;
  }

  // Fire achievement for the referrer (first referral only — service handles
  // the duplicate guard via unique completion row).
  await checkAndAwardChallenge(referrer.id, 'referral', {
    referredUserId,
    code: trimmed,
  });

  logger.info(`Referral recorded: referrerId=${referrer.id} → newUserId=${referredUserId}`);
  return { referrerId: referrer.id, referredUserId };
}

module.exports = { recordReferral };
