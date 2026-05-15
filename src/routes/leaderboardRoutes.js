const express = require('express');
const router = express.Router();
const { getLeaderboard } = require('../controllers/leaderboardController');
const { optionalAuth } = require('../middleware/optionalAuth');

// GET /leaderboard - Get all users ranked by points (optional auth to mark current user)
router.get('/', optionalAuth, getLeaderboard);

module.exports = router;
