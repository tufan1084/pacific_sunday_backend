const { Router } = require('express');
const gifController = require('../controllers/gifController');
const { authenticate } = require('../middleware/authMiddleware');

const router = Router();

// Authentication required — GIF picker is a logged-in-only feature, and
// gating prevents the proxy from being used as a free anonymous Giphy relay.
router.get('/search', authenticate, gifController.search);
router.get('/featured', authenticate, gifController.featured);

module.exports = router;
