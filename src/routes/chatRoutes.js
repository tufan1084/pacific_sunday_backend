const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const chatController = require('../controllers/chatController');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { s3Client, bucket, isConfigured } = require('../config/s3');
const path = require('path');

// Configure multer for chat media uploads
const uploadChatMedia = isConfigured
  ? multer({
      storage: multerS3({
        s3: s3Client,
        bucket: bucket,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
          const folder = file.mimetype.startsWith('image/') ? 'chat/images' : 'chat/videos';
          const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
          cb(null, `${folder}/${filename}`);
        }
      }),
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
      fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) {
          return cb(null, true);
        }
        cb(new Error('Only images and videos are allowed'));
      }
    })
  : multer({ dest: 'uploads/chat/' });

// Get all conversations for current user
router.get('/conversations', authenticate, chatController.getConversations);

// Get or create conversation with another user
router.post('/conversations', authenticate, chatController.getOrCreateConversation);

// Get messages in a conversation
router.get('/conversations/:conversationId/messages', authenticate, chatController.getMessages);

// Send a text message
router.post('/conversations/:conversationId/messages', authenticate, chatController.sendMessage);

// Upload media and send message
router.post('/conversations/:conversationId/media', authenticate, uploadChatMedia.array('media', 5), chatController.sendMediaMessage);

// Mark messages as read
router.post('/conversations/:conversationId/read', authenticate, chatController.markAsRead);

// Delete a message ("delete for everyone" — sender only, turns into tombstone)
router.delete('/messages/:messageId', authenticate, chatController.deleteMessage);

// Hide a message from only the current user's view ("delete for me")
router.post('/messages/:messageId/hide', authenticate, chatController.deleteMessageForMe);

// Edit a message (sender only, text only, within the 15-min window)
router.patch('/messages/:messageId', authenticate, chatController.editMessage);

// React to a message
router.post('/messages/:messageId/react', authenticate, chatController.reactToMessage);

// Search conversations
router.get('/search', authenticate, chatController.searchConversations);

// Get unread count
router.get('/unread-count', authenticate, chatController.getUnreadCount);

module.exports = router;
