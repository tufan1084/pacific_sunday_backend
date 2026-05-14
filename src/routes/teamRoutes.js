const { Router } = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/optionalAuth');
const { validate } = require('../middleware/validate');
const { uploadImage: uploadTeamImage } = require('../config/multerMemory');
const {
  listTeams,
  getTeam,
  createTeam,
  joinTeam,
  leaveTeam,
  searchUsers,
  getJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  inviteToTeam,
  getMyInvites,
  acceptInvite,
  declineInvite,
  updateTeam,
  promoteMember,
  removeMember,
  deleteTeam,
  uploadTeamImageHandler,
} = require('../controllers/teamController');

const router = Router();

/**
 * GET /teams — list teams (annotated with isMember for current user if auth)
 */
router.get('/', optionalAuth, listTeams);

/**
 * GET /teams/users/search?q=... — search users for invite (authenticated)
 * Note: mounted under /teams for now to keep related surface together
 */
router.get('/users/search', authenticate, searchUsers);

/**
 * POST /teams/upload-image — upload a team avatar to S3 (authenticated)
 * Returns { imageUrl } so the client can pass it into create/update.
 * MUST be before /:teamId so the path isn't parsed as a team id.
 */
router.post('/upload-image', authenticate, uploadTeamImage.single('image'), uploadTeamImageHandler);

/**
 * GET /teams/invites/my — get my pending invites (MUST be before /:teamId)
 */
router.get('/invites/my', authenticate, getMyInvites);

/**
 * POST /teams/invites/:inviteId/accept — accept invite
 */
router.post('/invites/:inviteId/accept', authenticate, acceptInvite);

/**
 * POST /teams/invites/:inviteId/decline — decline invite
 */
router.post('/invites/:inviteId/decline', authenticate, declineInvite);

/**
 * GET /teams/:teamId — single team with members
 */
router.get('/:teamId', optionalAuth, getTeam);

/**
 * POST /teams — create a new team
 */
router.post(
  '/',
  authenticate,
  [
    body('name').isString().trim().isLength({ min: 3, max: 50 }),
    body('description').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('imageUrl').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('privacy').optional().isIn(['public', 'private']),
    body('memberIds').optional().isArray(),
  ],
  validate,
  createTeam
);

/**
 * POST /teams/:teamId/join — join a public team
 */
router.post('/:teamId/join', authenticate, joinTeam);

/**
 * POST /teams/:teamId/leave — leave a team
 */
router.post('/:teamId/leave', authenticate, leaveTeam);

/**
 * PUT /teams/:teamId — update team info (admin only)
 */
router.put(
  '/:teamId',
  authenticate,
  [
    body('name').optional().isString().trim().isLength({ min: 3, max: 50 }),
    body('description').optional({ nullable: true }).isString().trim().isLength({ max: 200 }),
    body('imageUrl').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
    body('privacy').optional().isIn(['public', 'private']),
  ],
  validate,
  updateTeam
);

/**
 * GET /teams/:teamId/join-requests — get pending join requests (admin only)
 */
router.get('/:teamId/join-requests', authenticate, getJoinRequests);

/**
 * POST /teams/:teamId/join-requests/:requestId/approve — approve join request (admin only)
 */
router.post('/:teamId/join-requests/:requestId/approve', authenticate, approveJoinRequest);

/**
 * POST /teams/:teamId/join-requests/:requestId/reject — reject join request (admin only)
 */
router.post('/:teamId/join-requests/:requestId/reject', authenticate, rejectJoinRequest);

/**
 * POST /teams/:teamId/invite — invite users to team (admin only)
 */
router.post(
  '/:teamId/invite',
  authenticate,
  [body('userIds').isArray().notEmpty()],
  validate,
  inviteToTeam
);

/**
 * POST /teams/:teamId/members/:memberId/promote — promote member to admin (admin only)
 */
router.post('/:teamId/members/:memberId/promote', authenticate, promoteMember);

/**
 * DELETE /teams/:teamId/members/:memberId — remove member (admin only)
 */
router.delete('/:teamId/members/:memberId', authenticate, removeMember);

/**
 * DELETE /teams/:teamId — delete team (creator only)
 */
router.delete('/:teamId', authenticate, deleteTeam);

module.exports = router;
