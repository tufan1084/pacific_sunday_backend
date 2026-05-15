const { prisma } = require('../config/db');
const logger = require('../config/logger');
const {
  getPlatformSettings,
  updatePlatformSettings,
} = require('../services/platformSettingsService');

// Number of days with no registered bag + no posts before an account is
// considered "inactive" and eligible for purge.
const INACTIVE_DAYS = 90;

/**
 * GET /api/admin/platform-settings
 */
exports.getSettings = async (req, res) => {
  try {
    const settings = await getPlatformSettings({ fresh: true });
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error(`getPlatformSettings error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
};

/**
 * PUT /api/admin/platform-settings
 * Body: { appName?, appDescription?, maintenanceMode?, maxH2HWager? }
 */
exports.updateSettings = async (req, res) => {
  try {
    const { appName, appDescription, maintenanceMode, maxH2HWager } = req.body || {};
    const data = {};

    if (appName !== undefined) {
      const v = String(appName).trim();
      if (!v) return res.status(400).json({ success: false, message: 'App name cannot be empty' });
      data.appName = v.slice(0, 120);
    }
    if (appDescription !== undefined) {
      data.appDescription = String(appDescription).trim().slice(0, 500);
    }
    if (maintenanceMode !== undefined) {
      data.maintenanceMode = Boolean(maintenanceMode);
    }
    if (maxH2HWager !== undefined) {
      const n = Number(maxH2HWager);
      if (!Number.isInteger(n) || n < 1 || n > 1000000) {
        return res.status(400).json({ success: false, message: 'Max H2H wager must be between 1 and 1,000,000' });
      }
      data.maxH2HWager = n;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    const updated = await updatePlatformSettings(data);

    req.audit?.({
      action: 'PLATFORM_SETTINGS_UPDATE',
      category: 'ADMIN',
      entityType: 'PlatformSettings',
      entityId: updated.id,
      metadata: { changed: data },
    });

    res.json({ success: true, data: updated, message: 'Platform settings saved' });
  } catch (error) {
    logger.error(`updatePlatformSettings error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to save settings' });
  }
};

// ─── Danger Zone ───────────────────────────────────────────────────────────

/**
 * POST /api/admin/danger/reset-points  (superadmin only)
 * Zeroes every wallet's balance + heldBalance and writes a reversing
 * PointsTransaction per affected wallet so the action is itself auditable in
 * the points ledger. Irreversible at the wallet level.
 */
exports.resetAllPoints = async (req, res) => {
  try {
    const wallets = await prisma.userPointsWallet.findMany({
      where: { OR: [{ balance: { not: 0 } }, { heldBalance: { not: 0 } }] },
      select: { id: true, userId: true, balance: true },
    });

    if (wallets.length === 0) {
      return res.json({ success: true, data: { walletsReset: 0 }, message: 'All wallets were already at zero' });
    }

    await prisma.$transaction([
      ...wallets.map((w) =>
        prisma.pointsTransaction.create({
          data: {
            walletId: w.id,
            userId: w.userId,
            amount: -w.balance,
            type: 'admin_reset',
            description: 'Admin reset all points to zero',
            metadata: { previousBalance: w.balance },
          },
        }),
      ),
      prisma.userPointsWallet.updateMany({ data: { balance: 0, heldBalance: 0 } }),
    ]);

    req.audit?.({
      action: 'DANGER_RESET_ALL_POINTS',
      category: 'ADMIN',
      metadata: { walletsReset: wallets.length },
    });

    logger.warn(`[danger] Admin ${req.admin?.email} reset points on ${wallets.length} wallets`);
    res.json({ success: true, data: { walletsReset: wallets.length }, message: `Reset ${wallets.length} wallet(s) to zero` });
  } catch (error) {
    logger.error(`resetAllPoints error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to reset points' });
  }
};

// Build the WHERE clause that defines an "inactive" account: created more
// than INACTIVE_DAYS ago, with zero registered bags and zero posts.
const inactiveWhere = () => {
  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);
  return {
    createdAt: { lt: cutoff },
    bags: { none: { registered: true } },
    posts: { none: {} },
  };
};

/**
 * GET /api/admin/danger/inactive-count
 * Preview how many accounts the purge would remove (no deletion).
 */
exports.previewInactiveUsers = async (req, res) => {
  try {
    const count = await prisma.user.count({ where: inactiveWhere() });
    res.json({ success: true, data: { count, inactiveDays: INACTIVE_DAYS } });
  } catch (error) {
    logger.error(`previewInactiveUsers error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to count inactive users' });
  }
};

/**
 * POST /api/admin/danger/purge-inactive  (superadmin only)
 * Permanently deletes inactive accounts and all their data. Capped per call
 * so a single request can't run unbounded.
 */
exports.purgeInactiveUsers = async (req, res) => {
  try {
    const MAX_PER_RUN = 500;
    const users = await prisma.user.findMany({
      where: inactiveWhere(),
      select: { id: true },
      take: MAX_PER_RUN,
    });

    if (users.length === 0) {
      return res.json({ success: true, data: { purged: 0 }, message: 'No inactive accounts to purge' });
    }

    const ids = users.map((u) => u.id);

    // Mirror the full cascade used by adminController.deleteUser, applied to
    // the whole batch in one transaction.
    await prisma.$transaction([
      prisma.messageReaction.deleteMany({ where: { userId: { in: ids } } }),
      prisma.messageDelivery.deleteMany({ where: { userId: { in: ids } } }),
      prisma.message.deleteMany({ where: { senderId: { in: ids } } }),
      prisma.conversationParticipant.deleteMany({ where: { userId: { in: ids } } }),
      prisma.dismissedAnnouncement.deleteMany({ where: { userId: { in: ids } } }),
      prisma.rewardRedemption.deleteMany({ where: { userId: { in: ids } } }),
      prisma.userChallengeCompletion.deleteMany({ where: { userId: { in: ids } } }),
      prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: ids } }, { referredUserId: { in: ids } }] } }),
      prisma.pointsTransaction.deleteMany({ where: { userId: { in: ids } } }),
      prisma.userPointsWallet.deleteMany({ where: { userId: { in: ids } } }),
      prisma.challengePick.deleteMany({ where: { userId: { in: ids } } }),
      prisma.challenge.deleteMany({ where: { OR: [{ challengerId: { in: ids } }, { opponentId: { in: ids } }] } }),
      prisma.userPick.deleteMany({ where: { userId: { in: ids } } }),
      prisma.hiddenPost.deleteMany({ where: { userId: { in: ids } } }),
      prisma.savedPost.deleteMany({ where: { userId: { in: ids } } }),
      prisma.savedPostCategory.deleteMany({ where: { userId: { in: ids } } }),
      prisma.userPostPin.deleteMany({ where: { userId: { in: ids } } }),
      prisma.postReport.deleteMany({ where: { userId: { in: ids } } }),
      prisma.postComment.deleteMany({ where: { userId: { in: ids } } }),
      prisma.postLike.deleteMany({ where: { userId: { in: ids } } }),
      prisma.post.deleteMany({ where: { userId: { in: ids } } }),
      prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: ids } }, { followingId: { in: ids } }] } }),
      prisma.followRequest.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { receiverId: { in: ids } }] } }),
      prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] } }),
      prisma.teamMember.deleteMany({ where: { userId: { in: ids } } }),
      prisma.teamJoinRequest.deleteMany({ where: { userId: { in: ids } } }),
      prisma.teamInvite.deleteMany({ where: { userId: { in: ids } } }),
      prisma.userDevice.deleteMany({ where: { userId: { in: ids } } }),
      prisma.deviceVerificationOtp.deleteMany({ where: { userId: { in: ids } } }),
      prisma.nfcLoginToken.deleteMany({ where: { userId: { in: ids } } }),
      // Unclaim any bags so they can be re-registered.
      prisma.bag.updateMany({ where: { userId: { in: ids } }, data: { userId: null, registered: false } }),
      prisma.golfPassport.deleteMany({ where: { profile: { userId: { in: ids } } } }),
      prisma.userProfile.deleteMany({ where: { userId: { in: ids } } }),
      prisma.user.deleteMany({ where: { id: { in: ids } } }),
    ]);

    req.audit?.({
      action: 'DANGER_PURGE_INACTIVE_USERS',
      category: 'ADMIN',
      metadata: { purged: ids.length, inactiveDays: INACTIVE_DAYS, ids },
    });

    logger.warn(`[danger] Admin ${req.admin?.email} purged ${ids.length} inactive accounts`);
    res.json({
      success: true,
      data: { purged: ids.length, cappedAt: MAX_PER_RUN },
      message: `Permanently removed ${ids.length} inactive account(s)`,
    });
  } catch (error) {
    logger.error(`purgeInactiveUsers error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to purge inactive users' });
  }
};
