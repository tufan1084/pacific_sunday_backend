const { Router } = require('express');
const { listChallenges } = require('../controllers/challengeController');

const router = Router();

// Public catalog of active challenges.
router.get('/', listChallenges);

module.exports = router;
