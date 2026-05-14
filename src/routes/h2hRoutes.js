const { Router } = require('express');
const h2h = require('../controllers/h2hController');
const { authenticate } = require('../middleware/authMiddleware');

const router = Router();

router.use(authenticate);

router.get('/stats',          h2h.getStats);
router.get('/challenges',     h2h.listChallenges);
router.post('/challenges',    h2h.createChallenge);

router.get('/challenges/:id',                h2h.getChallenge);
router.get('/challenges/:id/field',          h2h.getChallengeField);
router.post('/challenges/:id/accept',        h2h.acceptChallenge);
router.post('/challenges/:id/decline',       h2h.declineChallenge);
router.post('/challenges/:id/cancel',        h2h.cancelChallenge);
router.put('/challenges/:id/picks',          h2h.savePicks);
router.post('/challenges/:id/picks/lock',    h2h.lockPicks);

module.exports = router;
