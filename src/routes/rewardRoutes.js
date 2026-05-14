const { Router } = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { redeemReward, listMyRedemptions } = require('../controllers/rewardController');

const router = Router();

router.post('/redeem', authenticate, redeemReward);
router.get('/my-redemptions', authenticate, listMyRedemptions);

module.exports = router;
