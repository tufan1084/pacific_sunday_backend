const { Router } = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');
const { search } = require('../controllers/searchController');

const router = Router();

router.get('/', optionalAuth, search);

module.exports = router;
