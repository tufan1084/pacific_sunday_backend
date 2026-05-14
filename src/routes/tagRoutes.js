const { Router } = require('express');
const { listPublicTags } = require('../controllers/tagController');

const router = Router();

// Public tag list — used by the community tabs and composer category picker.
router.get('/', listPublicTags);

module.exports = router;
