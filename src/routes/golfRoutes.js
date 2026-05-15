const { Router } = require('express');
const golf = require('../controllers/golfController');
const { authenticate } = require('../middleware/authMiddleware');

const router = Router();

// GET /api/golf/tournaments?year=2026
router.get('/tournaments', golf.getTournaments);

// GET /api/golf/tournament/:tournId/fantasy?year=2026
// Single-call endpoint: tournament meta + tiers + leaderboard
router.get('/tournament/:tournId/fantasy', golf.getTournamentFantasy);

// Picks (authenticated)
router.get('/tournament/:tournId/picks', authenticate, golf.getMyPicks);
router.put('/tournament/:tournId/picks', authenticate, golf.savePicks);
router.post('/tournament/:tournId/picks/lock', authenticate, golf.lockPicks);

// Manual sync triggers (dev/admin)
//   POST /api/golf/sync/schedule
//   POST /api/golf/sync/owgr
//   POST /api/golf/sync/status
//   POST /api/golf/sync/field?tournId=018
//   POST /api/golf/sync/leaderboard?tournId=018
router.post('/sync/:target', golf.triggerSync);

module.exports = router;
