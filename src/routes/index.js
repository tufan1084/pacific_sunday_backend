const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const bagRoutes = require('./bagRoutes');
const authRoutes = require('./authRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const profileRoutes = require('./profileRoutes');
const iykRoutes = require('./iykRoutes');
const adminRoutes = require('./adminRoutes');
const golfRoutes = require('./golfRoutes');
const postRoutes = require('./postRoutes');
const teamRoutes = require('./teamRoutes');
const notificationRoutes = require('./notificationRoutes');
const userRoutes = require('./userRoutes');
const searchRoutes = require('./searchRoutes');
const tagRoutes = require('./tagRoutes');
const pointsRoutes = require('./pointsRoutes');
const savedCategoriesRoutes = require('./savedCategoriesRoutes');
const leaderboardRoutes = require('./leaderboardRoutes');
const h2hRoutes = require('./h2hRoutes');
const challengeRoutes = require('./challengeRoutes');
const rewardRoutes = require('./rewardRoutes');
const announcementRoutes = require('./announcementRoutes');
const chatRoutes = require('./chatRoutes');

const router = Router();
const prisma = new PrismaClient();

// Health check endpoint — no auth required
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    },
    message: 'Service is running',
  });
});

// Public community stats — drives the Community Status widget.
//   postsThisWeek : posts created in the last 7 days (rolling)
//   activeOwners  : total registered users on the platform
//   nfcScansToday : bag scans since the start of the current day in Pacific Time
//   totalUsers    : kept for CommunityHeader.tsx (same value as activeOwners)
router.get('/stats/community', async (_req, res, next) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Start of today in America/Los_Angeles. Derive the PT calendar day from
    // `now` and compose that day's 00:00 back as a UTC instant (offset = 7 in
    // PDT, 8 in PST — probed so we don't hardcode DST).
    const ptDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
    const ptProbe = new Date(`${ptDateStr}T12:00:00Z`);
    const ptProbeHour = parseInt(
      ptProbe.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false }),
      10,
    );
    const ptOffsetHours = 12 - ptProbeHour;
    const startOfPTDay = new Date(`${ptDateStr}T${String(ptOffsetHours).padStart(2, '0')}:00:00Z`);

    const [totalUsers, postsThisWeek, nfcScansToday] = await Promise.all([
      prisma.user.count(),
      prisma.post.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.scan.count({ where: { scanTime: { gte: startOfPTDay } } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        postsThisWeek,
        activeOwners: totalUsers,
        nfcScansToday,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Mount feature routers
router.use('/bag', bagRoutes);
router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/profile', profileRoutes);
router.use('/iyk', iykRoutes);
router.use('/admin', adminRoutes);
router.use('/golf', golfRoutes);
router.use('/posts', postRoutes);
router.use('/teams', teamRoutes);
router.use('/notifications', notificationRoutes);
router.use('/users', userRoutes);
router.use('/search', searchRoutes);
router.use('/tags', tagRoutes);
router.use('/points', pointsRoutes);
router.use('/saved-categories', savedCategoriesRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/h2h', h2hRoutes);
router.use('/challenges', challengeRoutes);
router.use('/rewards', rewardRoutes);
router.use('/announcements', announcementRoutes);
router.use('/chat', chatRoutes);

module.exports = router;
