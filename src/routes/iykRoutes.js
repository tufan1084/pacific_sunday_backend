const express = require('express');
const router = express.Router();
const iykController = require('../controllers/iykController');

// GET /api/iyk/verify?e=XX&c=XX&d=XX
router.get('/verify', iykController.verifyChip);

module.exports = router;
