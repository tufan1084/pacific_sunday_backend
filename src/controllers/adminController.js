const { prisma } = require('../config/db');
const iykService = require('../services/iykService');
const logger = require('../config/logger');
const { dispatchPostingStatusEmail } = require('../services/userModerationEmailService');

// GET /api/admin/dashboard-stats
exports.getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await prisma.user.count();
    const totalBags = await prisma.bag.count({ where: { registered: true } });
    const totalScans = await prisma.scan.count();
    const communityPosts = await prisma.post.count();
    const activeUsers = await prisma.user.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      }
    });
    const rewardsRedeemed = await prisma.rewardRedemption.count();

    // Get recent users (last 5)
    const recentUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        profile: { select: { name: true } },
        _count: { select: { bags: true } }
      }
    });

    // Get recent posts (last 5)
    const recentPosts = await prisma.post.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true, profile: { select: { name: true } } } },
        _count: { select: { likes: true, comments: true } },
        reports: { where: { status: 'pending' } }
      }
    });

    // Get recent redemptions (last 5)
    const recentRedemptions = await prisma.rewardRedemption.findMany({
      take: 5,
      orderBy: { redeemedAt: 'desc' }
    });

    const stats = {
      totalUsers,
      totalBags,
      totalScans,
      communityPosts,
      activeUsers,
      rewardsRedeemed,
      recentUsers: recentUsers.map(u => ({
        id: u.id,
        name: u.profile?.name || u.username,
        email: u.email,
        bags: u._count.bags,
        joinedAt: u.createdAt
      })),
      recentPosts: recentPosts.map(p => ({
        id: p.id,
        author: p.user.profile?.name || p.user.username,
        content: p.content,
        likes: p._count.likes,
        replies: p._count.comments,
        reports: p.reports.length,
        status: p.isHidden ? 'Hidden' : p.reports.length > 0 ? 'Flagged' : 'Active',
        createdAt: p.createdAt
      })),
      recentRedemptions: recentRedemptions.map(r => ({
        id: r.id,
        userId: r.userId,
        rewardName: r.rewardName,
        pointsCost: r.pointsCost,
        redeemedAt: r.redeemedAt
      }))
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error(`getDashboardStats error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── H2H Tournament Bonus Configuration ────────────────────────────────────
// Admin-controlled per-tournament multiplier for head-to-head challenges.
// Read by H2H challenge creation (POST /api/h2h/challenges) — every new
// challenge snapshots the current multiplier so admin tweaks don't change
// stakes for already-pending matches.

exports.getTournamentYears = async (req, res) => {
  try {
    const years = await prisma.tournament.findMany({
      select: { year: true },
      distinct: ['year'],
      orderBy: { year: 'desc' },
    });
    res.json({ success: true, data: { years: years.map(t => t.year) } });
  } catch (error) {
    logger.error(`getTournamentYears error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.listTournamentsH2H = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const tournaments = await prisma.tournament.findMany({
      where: { year },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        tournId: true,
        year: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        isMajor: true,
        h2hMultiplier: true,
        h2hBonusDescription: true,
      },
    });
    res.json({ success: true, data: { tournaments } });
  } catch (error) {
    logger.error(`listTournamentsH2H error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateTournamentH2H = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    logger.info(`[updateTournamentH2H] id=${id}, body=${JSON.stringify(req.body)}`);
    
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const { h2hMultiplier, h2hBonusDescription } = req.body || {};
    const data = {};

    if (h2hMultiplier !== undefined) {
      // Allow null to remove the multiplier
      if (h2hMultiplier === null) {
        data.h2hMultiplier = null;
      } else {
        const m = Number(h2hMultiplier);
        if (!Number.isFinite(m) || m <= 0 || m > 10) {
          return res.status(400).json({ success: false, message: 'Multiplier must be between 0 and 10' });
        }
        data.h2hMultiplier = m;
      }
    }
    if (h2hBonusDescription !== undefined) {
      data.h2hBonusDescription = h2hBonusDescription
        ? String(h2hBonusDescription).slice(0, 500)
        : null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    logger.info(`[updateTournamentH2H] updating with data=${JSON.stringify(data)}`);
    const updated = await prisma.tournament.update({
      where: { id },
      data,
      select: {
        id: true, tournId: true, year: true, name: true,
        h2hMultiplier: true, h2hBonusDescription: true,
      },
    });
    logger.info(`H2H bonus updated: tournament ${id} → ${updated.h2hMultiplier}x`);
    res.json({ success: true, data: { tournament: updated } });
  } catch (error) {
    logger.error(`updateTournamentH2H error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/sync-bags
// Fetches all bag types + chips from IYK API, inserts only new records
exports.syncBags = async (req, res) => {
  try {
    const items = await iykService.fetchAllItems();
    if (!Array.isArray(items)) {
      return res.status(502).json({ success: false, message: 'Invalid response from IYK API' });
    }

    let newBagTypes = 0;
    let newBags = 0;
    let skippedBagTypes = 0;
    let skippedBags = 0;

    for (const item of items) {
      // Check if bag type already exists
      const existing = await prisma.bagType.findUnique({
        where: { iykItemId: item.id }
      });

      let bagTypeId;

      if (existing) {
        skippedBagTypes++;
        bagTypeId = existing.id;
      } else {
        // Insert new bag type
        const collection = item.attributes?.find(a => a.name === 'Collection')?.values?.[0] || null;
        const created = await prisma.bagType.create({
          data: {
            iykItemId: item.id,
            name: item.name,
            description: item.description || null,
            imageUrl: item.imageUrl || null,
            collection,
            contractAddress: item.contract?.address || null,
            chainId: item.contract?.chainId || null,
            totalChips: 0,
            createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
            syncedAt: new Date(),
          }
        });
        bagTypeId = created.id;
        newBagTypes++;
      }

      // Fetch chips for this item
      let chips = [];
      try {
        chips = await iykService.fetchChipsForItem(item.id);
        if (!Array.isArray(chips)) chips = [];
      } catch {
        // If chips fetch fails, continue with next item
        continue;
      }

      // Insert only new chips
      for (const chip of chips) {
        const existingChip = await prisma.bag.findUnique({
          where: { uid: chip.uid }
        });

        if (existingChip) {
          skippedBags++;
          continue;
        }

        await prisma.bag.create({
          data: {
            uid: chip.uid,
            bagTypeId,
            tokenId: chip.linkedToken?.tokenId || null,
          }
        });
        newBags++;
      }

      // Update totalChips count on the bag type
      const totalChips = await prisma.bag.count({ where: { bagTypeId } });
      await prisma.bagType.update({
        where: { id: bagTypeId },
        data: { totalChips, syncedAt: new Date() }
      });
    }

    res.json({
      success: true,
      message: 'Sync complete',
      data: { newBagTypes, newBags, skippedBagTypes, skippedBags }
    });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ success: false, message: error.message || 'Sync failed' });
  }
};

// GET /api/admin/users
// Returns all users with profiles and bag counts
exports.getUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        profile: true,
        bags: { select: { id: true, uid: true, tokenId: true }, where: { registered: true } },
        _count: { select: { bags: true } }
      }
    });

    const wallets = await prisma.userPointsWallet.findMany({
      select: { userId: true, balance: true }
    });
    const walletMap = new Map(wallets.map(w => [w.userId, w.balance]));

    const data = users.map(u => ({
      id: u.id,
      name: u.profile?.name || '—',
      email: u.email,
      username: u.username,
      country: u.profile?.country || '—',
      // "Banned" here means blocked from posting/commenting in the community.
      // Other moderation states can be added later (full account suspend etc.).
      status: u.postingBlocked ? 'Banned' : 'Active',
      postingBlocked: u.postingBlocked,
      postingBlockedAt: u.postingBlockedAt,
      postingBlockedReason: u.postingBlockedReason,
      points: walletMap.get(u.id) || 0,
      bags: u._count.bags,
      bagSerials: u.bags.length > 0 ? u.bags.map(b => b.tokenId || '—').join(', ') : '—',
      joinedAt: u.createdAt,
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/admin/users/:userId/posting-block
 * body { blocked: boolean, reason?: string }
 * Toggle posting/commenting block for a user. Superadmin only.
 */
exports.setUserPostingBlock = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    const { blocked, reason } = req.body || {};
    if (typeof blocked !== 'boolean') {
      return res.status(400).json({ success: false, message: '`blocked` (boolean) is required' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const safeReason = typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 200)
      : null;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: blocked
        ? {
            postingBlocked: true,
            postingBlockedAt: new Date(),
            postingBlockedReason: safeReason,
          }
        : {
            postingBlocked: false,
            postingBlockedAt: null,
            postingBlockedReason: null,
          },
      select: { id: true, postingBlocked: true, postingBlockedAt: true, postingBlockedReason: true },
    });

    // Email the user about the status change. Fire-and-forget so the admin
    // request returns instantly; SMTP failures are logged but never bubble up.
    setImmediate(() => {
      dispatchPostingStatusEmail({ userId, blocked, reason: safeReason })
        .catch((err) => logger.warn(`[setUserPostingBlock] email dispatch error: ${err.message}`));
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/users/:userId
// Permanently deletes a user and all their associated data. Superadmin only.
exports.deleteUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await prisma.$transaction([
      prisma.messageReaction.deleteMany({ where: { userId } }),
      prisma.messageDelivery.deleteMany({ where: { userId } }),
      prisma.message.deleteMany({ where: { senderId: userId } }),
      prisma.conversationParticipant.deleteMany({ where: { userId } }),
      prisma.dismissedAnnouncement.deleteMany({ where: { userId } }),
      prisma.rewardRedemption.deleteMany({ where: { userId } }),
      prisma.userChallengeCompletion.deleteMany({ where: { userId } }),
      prisma.referral.deleteMany({ where: { OR: [{ referrerId: userId }, { referredUserId: userId }] } }),
      prisma.pointsTransaction.deleteMany({ where: { userId } }),
      prisma.userPointsWallet.deleteMany({ where: { userId } }),
      prisma.challengePick.deleteMany({ where: { userId } }),
      prisma.challenge.deleteMany({ where: { OR: [{ challengerId: userId }, { opponentId: userId }] } }),
      prisma.userPick.deleteMany({ where: { userId } }),
      prisma.hiddenPost.deleteMany({ where: { userId } }),
      prisma.savedPost.deleteMany({ where: { userId } }),
      prisma.savedPostCategory.deleteMany({ where: { userId } }),
      prisma.userPostPin.deleteMany({ where: { userId } }),
      prisma.postReport.deleteMany({ where: { userId } }),
      prisma.postComment.deleteMany({ where: { userId } }),
      prisma.postLike.deleteMany({ where: { userId } }),
      prisma.post.deleteMany({ where: { userId } }),
      prisma.notification.deleteMany({ where: { OR: [{ userId }, { actorId: userId }] } }),
      prisma.followRequest.deleteMany({ where: { OR: [{ senderId: userId }, { receiverId: userId }] } }),
      prisma.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } }),
      prisma.teamInvite.deleteMany({ where: { userId } }),
      prisma.teamJoinRequest.deleteMany({ where: { userId } }),
      prisma.teamMember.deleteMany({ where: { userId } }),
      prisma.passwordResetOtp.deleteMany({ where: { email: user.email } }),
      prisma.emailVerificationOtp.deleteMany({ where: { email: user.email } }),
      prisma.bag.updateMany({ where: { userId }, data: { userId: null, registered: false, registeredAt: null } }),
      prisma.golfPassport.deleteMany({ where: { profile: { userId } } }),
      prisma.userProfile.deleteMany({ where: { userId } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);

    logger.info(`Admin deleted user: ${user.email} (id: ${userId})`);
    res.json({ success: true, message: 'User and all associated data permanently deleted' });
  } catch (error) {
    logger.error(`deleteUser error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/bag-types
// Returns all bag types with bag counts from DB
exports.getBagTypes = async (req, res) => {
  try {
    const bagTypes = await prisma.bagType.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { bags: true } } }
    });

    res.json({ success: true, data: bagTypes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/bag-types/:id/bags
// Returns all bags (chips) for a specific bag type
exports.getBagsByType = async (req, res) => {
  try {
    const { id } = req.params;
    const bags = await prisma.bag.findMany({
      where: { bagTypeId: parseInt(id) },
      include: { user: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ success: true, data: bags });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
