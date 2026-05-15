const { Router } = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/optionalAuth');
const {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  getUserProfile,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
  removeFollower,
} = require('../controllers/followController');
const { listMyChallenges } = require('../controllers/challengeController');

const router = Router();

// My-challenges (list with unlocked flags) — must come before /:userId.
router.get('/my-challenges', authenticate, listMyChallenges);

// Follow requests - must come before /:userId to avoid route conflict
router.get('/follow-requests', authenticate, getFollowRequests);
router.post('/follow-requests/:requestId/accept', authenticate, acceptFollowRequest);
router.post('/follow-requests/:requestId/reject', authenticate, rejectFollowRequest);

// User profile routes
router.get('/:userId', optionalAuth, getUserProfile);
router.get('/:userId/followers', optionalAuth, getFollowers);
router.get('/:userId/following', optionalAuth, getFollowing);
router.post('/:userId/follow', authenticate, followUser);
router.delete('/:userId/follow', authenticate, unfollowUser);
router.delete('/:userId/follower', authenticate, removeFollower);

module.exports = router;
