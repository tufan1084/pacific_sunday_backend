const express = require('express');
const router = express.Router();
const pointsController = require('../controllers/pointsController');
const { authenticate } = require('../middleware/authMiddleware');

// User routes (require auth)
router.get('/wallet', authenticate, pointsController.getUserWallet);
router.get('/rank', authenticate, pointsController.getUserRank);
router.get('/history', authenticate, pointsController.getPointsHistory);

// Admin routes (no auth for now, matching admin routes pattern)
router.get('/ranges', pointsController.getPointsRanges);
router.post('/ranges', pointsController.createPointsRange);
router.put('/ranges/:id', pointsController.updatePointsRange);
router.delete('/ranges/:id', pointsController.deletePointsRange);

// Calculate points for completed tournament
router.post('/calculate/:tournId', pointsController.calculateTournamentPoints);

module.exports = router;
