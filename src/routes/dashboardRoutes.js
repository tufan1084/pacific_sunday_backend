const { Router } = require('express');
const { getDashboard, getDashboardOverview, dismissAnnouncement } = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/authMiddleware');

const router = Router();

/**
 * GET /dashboard
 * Returns the authenticated user's bags and scan history (JWT required).
 */
router.get('/', authenticate, getDashboard);

/**
 * GET /dashboard/overview
 * Aggregated payload powering the home dashboard — user summary, active
 * tournament, picks, leaderboard top 6, featured challenge, achievements,
 * weekly delta, recent posts, announcement, weather.
 */
router.get('/overview', authenticate, getDashboardOverview);

/**
 * POST /dashboard/dismiss-announcement
 * Marks an announcement as dismissed for the current user.
 */
router.post('/dismiss-announcement', authenticate, dismissAnnouncement);

module.exports = router;
