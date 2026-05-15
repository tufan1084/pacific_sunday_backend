const { prisma } = require('../config/db');
const logger = require('../config/logger');
const {
  debitPointsFromWallet,
  InsufficientFundsError,
} = require('../services/pointsService');
const { checkAndAwardChallenge } = require('../services/challengeService');

/**
 * POST /rewards/redeem
 * Body: { rewardName, pointsCost }
 *
 * Minimal redemption flow — debits the user's wallet, logs the redemption,
 * and fires the `reward_redeemed` achievement on their first one. A real
 * reward catalog (with stock, fulfillment, etc.) can hook into this same
 * endpoint later.
 */
const redeemReward = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { rewardName, pointsCost } = req.body || {};

    const cost = Number(pointsCost);
    if (!rewardName || !Number.isInteger(cost) || cost <= 0) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'rewardName and a positive integer pointsCost are required.',
      });
    }

    try {
      await debitPointsFromWallet(userId, cost, {
        type: 'reward_redemption',
        description: `Redeemed: ${rewardName}`,
        metadata: { rewardName },
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Not enough points to redeem this reward.',
        });
      }
      throw err;
    }

    const redemption = await prisma.rewardRedemption.create({
      data: { userId, rewardName, pointsCost: cost },
    });

    // Achievement trigger — fires on the user's first ever redemption.
    checkAndAwardChallenge(userId, 'reward_redeemed', {
      redemptionId: redemption.id,
      rewardName,
    }).catch((err) =>
      logger.error(`Challenge trigger (reward_redeemed) failed: ${err.message}`),
    );

    return res.status(201).json({
      success: true,
      data: { redemption },
      message: 'Reward redeemed successfully.',
    });
  } catch (err) {
    logger.error(`redeemReward error: ${err.message}`);
    next(err);
  }
};

/**
 * GET /rewards/my-redemptions
 */
const listMyRedemptions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const redemptions = await prisma.rewardRedemption.findMany({
      where: { userId },
      orderBy: { redeemedAt: 'desc' },
    });
    return res.status(200).json({
      success: true,
      data: { redemptions },
      message: 'Redemptions retrieved.',
    });
  } catch (err) {
    logger.error(`listMyRedemptions error: ${err.message}`);
    next(err);
  }
};

module.exports = { redeemReward, listMyRedemptions };
