const { prisma } = require('../config/db');
const { getBagsByUser } = require('../services/bagService');
const { getWeatherFor } = require('../services/weatherService');
const {
  profileCompletionPercent,
  countMonthlyTaps,
  NFC_TAP_MONTHLY_THRESHOLD,
} = require('../services/challengeService');
const logger = require('../config/logger');

/**
 * GET /dashboard
 * Existing endpoint — returns the user's bags + scan history. Kept as-is
 * for callers that already depend on this shape.
 */
const getDashboard = async (req, res, next) => {
  try {
    const userId = req.user.id;
    logger.info(`Dashboard request: userId=${userId}`);
    const bags = await getBagsByUser(userId);
    const totalScans = bags.reduce((sum, bag) => sum + bag.scans.length, 0);
    return res.status(200).json({
      success: true,
      data: {
        user: req.user,
        summary: { totalBags: bags.length, totalScans },
        bags,
      },
      message: 'Dashboard data retrieved successfully.',
    });
  } catch (error) {
    logger.error(`getDashboard error: ${error.message}`);
    next(error);
  }
};

// ─── /dashboard/overview ───────────────────────────────────────────────────
// Single roll-up that powers the home dashboard. Built so the front-end
// makes ONE request instead of 8 — easier to cache, fewer round-trips, and
// lets us share intermediate computations (e.g. leaderboard rank derivation).

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the leaderboard once and return: full sorted list, the user's rank,
 * and the rank-1 entry. Mirrors the logic in leaderboardController so both
 * surfaces agree on rankings without one calling into the other's HTTP
 * layer.
 */
async function buildLeaderboard(currentUserId) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      createdAt: true,
      profile: { 
        select: { 
          name: true, 
          country: true,
          golfPassport: { select: { photoUrl: true } }
        } 
      },
      bags: {
        take: 1,
        orderBy: { registeredAt: 'asc' },
        select: { bagType: { select: { name: true } } },
      },
    },
  });

  const wallets = await prisma.userPointsWallet.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { userId: true, balance: true },
  });
  const walletMap = new Map(wallets.map((w) => [w.userId, w.balance]));

  const userIndex = new Map(users.map((u) => [u.id, u]));

  const rows = users
    .map((u) => ({
      userId: u.id,
      username: u.username,
      name: u.profile?.name || u.username,
      country: u.profile?.country || null,
      bagName: u.bags?.[0]?.bagType?.name || null,
      photoUrl: u.profile?.golfPassport?.photoUrl || null,
      points: walletMap.get(u.id) || 0,
      isCurrentUser: u.id === currentUserId,
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return (
        new Date(userIndex.get(a.userId).createdAt).getTime() -
        new Date(userIndex.get(b.userId).createdAt).getTime()
      );
    })
    .map((row, i) => ({ ...row, rank: i + 1 }));

  return rows;
}

function initialsOf(name) {
  if (!name) return '??';
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatCountdown(targetDate) {
  if (!targetDate) return null;
  const ms = new Date(targetDate).getTime() - Date.now();
  if (ms <= 0) return 'Now';
  const days = Math.floor(ms / (24 * 3600 * 1000));
  const hrs = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}, ${hrs} hr${hrs === 1 ? '' : 's'}`;
  const mins = Math.floor((ms % (3600 * 1000)) / 60000);
  return `${hrs} hr${hrs === 1 ? '' : 's'}, ${mins} min`;
}

/**
 * Pick the most "relevant" challenge to show on the dashboard:
 *   1. Locked challenges with the highest progress < 100 (encourages action)
 *   2. Fallback: most recently unlocked (so an empty page still has flair)
 *   3. Fallback: first active challenge (catalog default)
 */
function pickFeaturedChallenge(challenges, completionsByChallengeId, profileGolfPassport, monthlyTaps, registeredBags, h2hWins, redemptionCount, referralCount) {
  const computeProgress = (c) => {
    if (completionsByChallengeId.has(c.id)) return 100;
    switch (c.triggerType) {
      case 'profile_completed':
        return profileCompletionPercent(profileGolfPassport);
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

  const enriched = challenges.map((c) => ({
    challenge: c,
    progress: computeProgress(c),
    unlocked: completionsByChallengeId.has(c.id),
    unlockedAt: completionsByChallengeId.get(c.id) || null,
  }));

  const inProgress = enriched
    .filter((e) => !e.unlocked && e.progress < 100)
    .sort((a, b) => b.progress - a.progress);
  if (inProgress.length > 0) return inProgress[0];

  const recentlyUnlocked = enriched
    .filter((e) => e.unlocked && e.unlockedAt)
    .sort((a, b) => new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime());
  if (recentlyUnlocked.length > 0) return recentlyUnlocked[0];

  return enriched[0] || null;
}

const getDashboardOverview = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - ONE_WEEK_MS);

    const [
      user,
      walletRow,
      activeChallenges,
      completions,
      weeklyDeltaSum,
      registeredBags,
      monthlyTaps,
      h2hWins,
      redemptionCount,
      referralCount,
      activeTournaments,
      leaderboardRows,
      recentPosts,
      announcement,
      dismissedAnnouncementIds,
      hiddenPostIds,
      reportedPostIds,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          createdAt: true,
          profile: {
            select: { name: true, country: true, golfPassport: true },
          },
        },
      }),
      prisma.userPointsWallet.findUnique({
        where: { userId },
        select: { balance: true },
      }),
      prisma.achievementChallenge.findMany({
        where: { isActive: true },
        orderBy: { id: 'asc' },
      }),
      prisma.userChallengeCompletion.findMany({
        where: { userId },
        select: { challengeId: true, completedAt: true },
      }),
      prisma.pointsTransaction.aggregate({
        where: { userId, amount: { gt: 0 }, createdAt: { gte: weekAgo } },
        _sum: { amount: true },
      }),
      prisma.bag.count({ where: { userId, registered: true } }),
      countMonthlyTaps(userId),
      prisma.challenge.count({ where: { winnerId: userId, status: 'COMPLETED' } }),
      prisma.rewardRedemption.count({ where: { userId } }),
      prisma.referral.count({ where: { referrerId: userId } }),
      // Active tournaments: get all upcoming and live tournaments with field available
      prisma.tournament.findMany({
        where: { 
          status: { in: ['upcoming', 'live'] },
          fieldAvailable: true
        },
        orderBy: [{ status: 'asc' }, { startDate: 'asc' }],
        take: 3,
      }),
      buildLeaderboard(userId),
      prisma.post.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              profile: {
                select: { name: true, golfPassport: { select: { photoUrl: true } } },
              },
            },
          },
          originalPost: {
            include: {
              user: {
                select: {
                  username: true,
                  profile: { select: { name: true } },
                },
              },
            },
          },
          _count: { select: { likes: true, comments: true } },
        },
      }),
      prisma.announcement.findFirst({
        where: {
          status: 'Published',
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
        },
        orderBy: [{ scheduledAt: 'desc' }, { updatedAt: 'desc' }],
      }),
      prisma.dismissedAnnouncement.findMany({
        where: { userId },
        select: { announcementId: true },
      }),
      prisma.hiddenPost.findMany({
        where: { userId },
        select: { postId: true },
      }),
      prisma.postReport.findMany({
        where: { userId },
        select: { postId: true },
      }),
    ]);


    logger.info(`Announcement query result: ${announcement ? `Found: ${announcement.title} (status: ${announcement.status})` : 'None found'}`);

    // Filter out dismissed announcements
    const dismissedIds = new Set(dismissedAnnouncementIds.map(d => d.announcementId));
    const visibleAnnouncement = announcement && !dismissedIds.has(announcement.id) ? announcement : null;

    // ── User summary ─────────────────────────────────────────────────────
    const me = leaderboardRows.find((r) => r.isCurrentUser);
    const weeksRegistered = user
      ? Math.max(0, Math.floor((now.getTime() - new Date(user.createdAt).getTime()) / ONE_WEEK_MS))
      : 0;

    // ── Picks (for all active tournaments) ──────────────────────────────────
    const tournamentsWithPicks = [];
    for (const tournament of activeTournaments) {
      // Get tiers from TournamentPlayer table
      const tournamentPlayers = await prisma.tournamentPlayer.findMany({
        where: { tournamentId: tournament.id },
        include: {
          player: true,
        },
        orderBy: [
          { tier: 'asc' },
          { tierRank: 'asc' },
        ],
      });

      if (tournamentPlayers.length === 0) {
        logger.info(`Skipping tournament ${tournament.name} - no players data`);
        continue;
      }

      // Group players by tier
      const tierMap = new Map();
      for (const tp of tournamentPlayers) {
        if (!tierMap.has(tp.tier)) {
          tierMap.set(tp.tier, []);
        }
        tierMap.get(tp.tier).push({
          playerId: tp.player.playerId,
          id: tp.player.playerId,
          fullName: `${tp.player.firstName} ${tp.player.lastName}`,
          firstName: tp.player.firstName,
          lastName: tp.player.lastName,
          name: `${tp.player.firstName} ${tp.player.lastName}`,
        });
      }

      // Build tiers array
      const tiers = Array.from(tierMap.entries()).map(([tier, players]) => ({
        tier,
        players,
      }));

      logger.info(`Tournament ${tournament.name} has ${tiers.length} tiers with ${tournamentPlayers.length} total players`);

      // Query picks using the tournament's database ID
      const lockedPick = await prisma.userPick.findUnique({
        where: { 
          userId_tournamentId: { 
            userId: userId, 
            tournamentId: tournament.id 
          } 
        },
      });
      
      const playerScores = new Map();
      const lb = tournament.leaderboard?.rows || [];
      for (const row of lb) {
        if (row.playerId) playerScores.set(String(row.playerId), row.score);
      }
      
      // Get actual tier names from the tiers data
      const tierNames = tiers.map(t => t.tier).filter(Boolean);
      const userPicks = lockedPick?.picks || {};

      const playerNameMap = new Map();
      for (const t of tiers) {
        if (Array.isArray(t.players)) {
          for (const p of t.players) {
            const id = String(p.playerId ?? p.id);
            const name =
              p.fullName ||
              p.name ||
              [p.firstName, p.lastName].filter(Boolean).join(' ') ||
              null;
            if (id && name) playerNameMap.set(id, name);
          }
        }
      }

      // Use actual tier names from the data
      const picks = tierNames.map((tierName) => {
        const playerId = userPicks[tierName];
        const hasPick = playerId !== null && playerId !== undefined && playerId !== '';
        // Extract short tier name (e.g., "T1" from "T1 Elite")
        const shortTier = tierName.split(' ')[0] || tierName;
        return {
          tier: shortTier,
          golfer: hasPick ? playerNameMap.get(String(playerId)) || null : null,
          score: hasPick ? playerScores.get(String(playerId)) ?? null : null,
          status: hasPick ? 'picked' : 'not_picked',
        };
      });
      
      const filled = picks.filter(p => p.status === 'picked').length;
      const picksRemaining = tierNames.length - filled;

      // Fetch weather for this tournament
      let tournamentWeather = null;
      if (tournament.city) {
        try {
          tournamentWeather = await getWeatherFor({
            city: tournament.city,
            state: tournament.state,
            country: tournament.country,
          });
        } catch (err) {
          logger.warn(`Weather lookup failed for ${tournament.name}: ${err.message}`);
        }
      }

      tournamentsWithPicks.push({
        tournament,
        picks,
        picksRemaining,
        weather: tournamentWeather,
      });
    }

    // ── Achievements summary ─────────────────────────────────────────────
    const completionsByChallengeId = new Map(
      completions.map((c) => [c.challengeId, c.completedAt]),
    );
    const earned = completions.length;
    const totalChallenges = activeChallenges.length;
    const newThisWeek = completions.filter(
      (c) => new Date(c.completedAt).getTime() >= weekAgo.getTime(),
    ).length;

    // Build all challenges with progress instead of just picking one
    const computeProgress = (c) => {
      if (completionsByChallengeId.has(c.id)) return 100;
      switch (c.triggerType) {
        case 'profile_completed':
          return profileCompletionPercent(user?.profile?.golfPassport);
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

    const allChallenges = activeChallenges.map((c) => ({
      id: c.id,
      triggerType: c.triggerType,
      title: c.title,
      description: c.description,
      points: c.points,
      progress: computeProgress(c),
      unlocked: completionsByChallengeId.has(c.id),
      unlockedAt: completionsByChallengeId.get(c.id) || null,
    }));

    // Sort: in-progress first (by highest progress), then completed (by most recent)
    const sortedChallenges = allChallenges.sort((a, b) => {
      const aCompleted = a.unlocked;
      const bCompleted = b.unlocked;
      
      if (!aCompleted && !bCompleted) {
        return b.progress - a.progress;
      }
      if (aCompleted && !bCompleted) return 1;
      if (!aCompleted && bCompleted) return -1;
      
      return new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime();
    });

    // ── Leaderboard (top 6 + slim shape for dashboard) ───────────────────
    const leaderboardTop = leaderboardRows.map((r) => ({
      rank: r.rank,
      initials: initialsOf(r.name),
      name: r.name,
      club: r.bagName || '—',
      score: r.points,
      photoUrl: r.photoUrl || null,
    }));

    // ── Recent posts (shape for the dashboard CommunityFeed) ─────────────
    const hiddenIds = new Set(hiddenPostIds.map(h => h.postId));
    const reportedIds = new Set(reportedPostIds.map(r => r.postId));
    const filteredPosts = recentPosts.filter(p => !hiddenIds.has(p.id) && !reportedIds.has(p.id)).slice(0, 3);

    const posts = filteredPosts.map((p) => ({
      id: p.id,
      author: p.user?.profile?.name || p.user?.username || 'Anonymous',
      authorPhotoUrl: p.user?.profile?.golfPassport?.photoUrl || null,
      badge: 'Owner',
      isPinned: false,
      timeAgo: relativeTimeAgo(p.createdAt),
      content: p.content,
      postType: p.postType,
      mediaUrls: p.mediaUrls,
      isReshare: !!p.originalPostId,
      reshareComment: p.reshareComment || null,
      originalPost: p.originalPost ? {
        id: p.originalPost.id,
        author: p.originalPost.user?.profile?.name || p.originalPost.user?.username || 'Anonymous',
        content: p.originalPost.content,
        postType: p.originalPost.postType,
        mediaUrls: p.originalPost.mediaUrls,
      } : null,
      likes: p._count?.likes ?? 0,
      replies: p._count?.comments ?? 0,
    }));

    // Weather is now included in each tournament object

    // Format tournaments for welcome section - show live and upcoming tournaments with field available
    const tournaments = tournamentsWithPicks
      .map((t) => ({
        id: t.tournament.id,
        tournId: t.tournament.tournId,
        year: t.tournament.year,
        name: t.tournament.name,
        status: t.tournament.status,
        startDate: t.tournament.startDate,
        endDate: t.tournament.endDate,
        isMajor: !!t.tournament.isMajor,
        courseName: t.tournament.courseName,
        city: t.tournament.city,
        state: t.tournament.state,
        country: t.tournament.country,
        h2hMultiplier: t.tournament.h2hMultiplier,
        countdown: formatCountdown(t.tournament.startDate),
        picksRemaining: t.picksRemaining,
        picks: t.picks,
        weather: t.weather,
      }));

    // Use first tournament's picks for backward compatibility
    const picks = tournamentsWithPicks[0]?.picks || [];
    const picksRemaining = tournamentsWithPicks[0]?.picksRemaining || null;

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user?.id,
          name: user?.profile?.name || user?.username || 'Player',
          rank: me?.rank ?? null,
          points: walletRow?.balance ?? me?.points ?? 0,
          weeksRegistered,
          memberSince: user?.createdAt ?? null,
        },
        weeklyDelta: {
          points: weeklyDeltaSum._sum.amount || 0,
          // Rank delta would need a snapshot table; leaving null for now.
          rank: null,
        },
        achievements: {
          earned,
          total: totalChallenges,
          newThisWeek,
        },
        activeTournament: tournaments[0] || null,
        tournaments,
        picks,
        picksRemaining,
        featuredChallenge: sortedChallenges.length > 0 ? sortedChallenges[0] : null,
        allChallenges: sortedChallenges,
        leaderboardTop,
        posts,
        announcement: visibleAnnouncement
          ? {
              id: visibleAnnouncement.id,
              title: visibleAnnouncement.title,
              description: visibleAnnouncement.message,
              ctaText: visibleAnnouncement.ctaText || null,
              ctaHref: visibleAnnouncement.ctaHref || null,
            }
          : null,
      },
      message: 'Dashboard overview retrieved.',
    });
  } catch (err) {
    logger.error(`getDashboardOverview error: ${err.message}`);
    next(err);
  }
};

function relativeTimeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const dismissAnnouncement = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { announcementId } = req.body;

    if (!announcementId) {
      return res.status(400).json({ success: false, message: 'Announcement ID required' });
    }

    await prisma.dismissedAnnouncement.upsert({
      where: { userId_announcementId: { userId, announcementId } },
      create: { userId, announcementId },
      update: { dismissedAt: new Date() },
    });

    return res.status(200).json({ success: true, message: 'Announcement dismissed' });
  } catch (err) {
    logger.error(`dismissAnnouncement error: ${err.message}`);
    next(err);
  }
};

module.exports = { getDashboard, getDashboardOverview, dismissAnnouncement };
