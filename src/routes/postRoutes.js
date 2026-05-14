const { Router } = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/optionalAuth');
const { validate } = require('../middleware/validate');
const { uploadAny } = require('../config/multerMemory');
const { uploadMedia } = require('../controllers/mediaController');
const {
  createPost,
  getPosts,
  getPostById,
  likePost,
  addComment,
  editComment,
  deleteComment,
  getComments,
  togglePin,
  editPost,
  deletePost,
  sharePost,
  resharePost,
  getPublicPost,
  reportPost,
  hidePost,
  unhidePost,
} = require('../controllers/postController');
const savedPosts = require('../controllers/savedPostsController');

const router = Router();

/**
 * POST /posts/upload-media
 * Upload media files (authenticated)
 */
router.post(
  '/upload-media',
  authenticate,
  uploadAny.array('media', 5),
  uploadMedia
);

/**
 * POST /posts
 * Create a new post (authenticated)
 */
router.post(
  '/',
  authenticate,
  [
    body('content')
      .optional()
      .isString()
      .withMessage('Content must be a string')
      .trim()
      .isLength({ max: 5000 })
      .withMessage('Content must be less than 5000 characters'),
    body('postType')
      .optional()
      .isIn(['TEXT', 'IMAGE', 'VIDEO', 'MIXED'])
      .withMessage('Invalid post type'),
    body('mediaUrls')
      .optional()
      .isArray()
      .withMessage('Media URLs must be an array'),
  ],
  validate,
  createPost
);

/**
 * GET /posts
 * Get all posts (optionally authenticated)
 */
router.get('/', optionalAuth, getPosts);

// Saved posts (must come before /:postId routes so "saved" isn't matched as a postId)
router.get('/saved', authenticate, savedPosts.listSavedPosts);
router.post('/:postId/save', authenticate, savedPosts.savePost);
router.delete('/:postId/save', authenticate, savedPosts.unsavePost);

/**
 * GET /posts/:postId
 * Get a single post (authenticated)
 */
router.get('/:postId', authenticate, getPostById);

/**
 * POST /posts/:postId/like
 * Like/unlike a post (authenticated)
 */
router.post('/:postId/like', authenticate, likePost);

/**
 * POST /posts/:postId/comments
 * Add comment to post (authenticated)
 */
router.post(
  '/:postId/comments',
  authenticate,
  [
    body('content')
      .optional()
      .isString()
      .withMessage('Content must be a string')
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Comment must be less than 1000 characters'),
    body('mediaUrl')
      .optional()
      .isString()
      .withMessage('Media URL must be a string'),
  ],
  validate,
  addComment
);

/**
 * GET /posts/:postId/public
 * Get a single post for public viewing (no auth required)
 */
router.get('/:postId/public', getPublicPost);

/**
 * GET /posts/:postId/comments
 * Get comments for a post (public)
 */
router.get('/:postId/comments', getComments);

// Edit / delete the authenticated user's own comment. Owner-only check is
// enforced inside the controllers. Replies cascade on delete.
router.patch('/comments/:commentId', authenticate, editComment);
router.delete('/comments/:commentId', authenticate, deleteComment);

/**
 * POST /posts/:postId/pin
 * Toggle pin state (owner only)
 */
router.post('/:postId/pin', authenticate, togglePin);

/**
 * PATCH /posts/:postId
 * Edit a post (owner only)
 */
router.patch(
  '/:postId',
  authenticate,
  [
    body('content')
      .notEmpty()
      .withMessage('Content is required')
      .isString()
      .withMessage('Content must be a string')
      .trim()
      .isLength({ max: 5000 })
      .withMessage('Content must be less than 5000 characters'),
  ],
  validate,
  editPost
);

/**
 * DELETE /posts/:postId
 * Delete a post (owner only)
 */
router.delete('/:postId', authenticate, deletePost);

/**
 * POST /posts/:postId/share
 * Increment share counter (public)
 */
router.post('/:postId/share', sharePost);

/**
 * POST /posts/:postId/reshare
 * Reshare a post to your own feed (authenticated)
 */
router.post(
  '/:postId/reshare',
  authenticate,
  [
    body('comment').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  resharePost
);

// Per-user hide. Auth-required; idempotent. Affects only this user's feed.
router.post('/:postId/hide', authenticate, hidePost);
router.delete('/:postId/hide', authenticate, unhidePost);

/**
 * POST /posts/:postId/report
 * Report a post (authenticated)
 */
router.post(
  '/:postId/report',
  authenticate,
  [
    body('reason').notEmpty().withMessage('Reason is required').isString().trim(),
    body('details').optional().isString().trim().isLength({ max: 500 }),
  ],
  validate,
  reportPost
);

module.exports = router;
