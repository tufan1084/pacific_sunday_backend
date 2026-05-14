const { Router } = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} = require('../controllers/notificationController');

const router = Router();

router.get('/', authenticate, listNotifications);
router.get('/unread-count', authenticate, unreadCount);
router.post('/read-all', authenticate, markAllRead);
router.post('/:id/read', authenticate, markRead);
router.delete('/:id', authenticate, deleteNotification);

module.exports = router;
