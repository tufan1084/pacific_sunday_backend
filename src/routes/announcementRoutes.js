const { Router } = require('express');
const { getActiveAnnouncement } = require('../controllers/announcementController');

const router = Router();

router.get('/active', getActiveAnnouncement);

module.exports = router;
