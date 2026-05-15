const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { createNotification } = require('../services/notificationService');
const { emitFollowChanged } = require('../config/socket');

const prisma = new PrismaClient();

/**
 * POST /users/:userId/follow
 * For public profiles: directly follow
 * For private profiles: send follow request
 */
const followUser = async (req, res, next) => {
  try {
    const followerId = req.user.id;
    const followingId = parseInt(req.params.userId);

    if (followerId === followingId) {
      return res.status(400).json({ success: false, message: 'You cannot follow yourself' });
    }

    const target = await prisma.user.findUnique({ where: { id: followingId } });
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Already following' });
    }

    // Check if target has private profile
    if (target.isPrivate) {
      // Check for existing request
      const existingRequest = await prisma.followRequest.findUnique({
        where: { senderId_receiverId: { senderId: followerId, receiverId: followingId } },
      });

      if (existingRequest) {
        if (existingRequest.status === 'pending') {
          return res.status(409).json({ success: false, message: 'Request already sent' });
        }
        // If rejected, allow resending
        await prisma.followRequest.update({
          where: { id: existingRequest.id },
          data: { status: 'pending', updatedAt: new Date() },
        });
      } else {
        // Create new follow request
        await prisma.followRequest.create({
          data: { senderId: followerId, receiverId: followingId },
        });
      }

      await createNotification({
        userId: followingId,
        type: 'FOLLOW_REQUEST_RECEIVED',
        actorId: followerId,
        entityType: 'user',
        entityId: followerId,
      });

      return res.status(200).json({
        success: true,
        data: { isFollowing: false, requestSent: true },
        message: 'Follow request sent',
      });
    }

    // Public profile - direct follow
    await prisma.follow.create({
      data: { followerId, followingId },
    });

    emitFollowChanged(followerId, followingId, 'followed');

    await createNotification({
      userId: followingId,
      type: 'USER_FOLLOWED',
      actorId: followerId,
      entityType: 'user',
      entityId: followerId,
    });

    return res.status(200).json({
      success: true,
      data: { isFollowing: true, requestSent: false },
      message: 'Now following',
    });
  } catch (error) {
    logger.error(`followUser error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /users/:userId/follow
 * Also cancels pending follow request if exists
 */
const unfollowUser = async (req, res, next) => {
  try {
    const followerId = req.user.id;
    const followingId = parseInt(req.params.userId);

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
    });

    if (existing) {
      await prisma.follow.delete({ where: { id: existing.id } });
      emitFollowChanged(followerId, followingId, 'unfollowed');
      return res.status(200).json({
        success: true,
        data: { isFollowing: false, requestSent: false },
        message: 'Unfollowed',
      });
    }

    // Check for pending request
    const request = await prisma.followRequest.findUnique({
      where: { senderId_receiverId: { senderId: followerId, receiverId: followingId } },
    });

    if (request && request.status === 'pending') {
      await prisma.followRequest.delete({ where: { id: request.id } });
      return res.status(200).json({
        success: true,
        data: { isFollowing: false, requestSent: false },
        message: 'Request cancelled',
      });
    }

    return res.status(404).json({ success: false, message: 'Not following' });
  } catch (error) {
    logger.error(`unfollowUser error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /users/:userId/followers
 */
const getFollowers = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    const follows = await prisma.follow.findMany({
      where: { followingId: userId },
      include: {
        follower: {
          select: {
            id: true,
            username: true,
            profile: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const data = follows.map(f => ({
      id: f.follower.id,
      username: f.follower.username,
      name: f.follower.profile?.name || f.follower.username,
    }));

    return res.status(200).json({ success: true, data: { users: data } });
  } catch (error) {
    logger.error(`getFollowers error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /users/:userId/following
 */
const getFollowing = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    const follows = await prisma.follow.findMany({
      where: { followerId: userId },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            profile: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const data = follows.map(f => ({
      id: f.following.id,
      username: f.following.username,
      name: f.following.profile?.name || f.following.username,
    }));

    return res.status(200).json({ success: true, data: { users: data } });
  } catch (error) {
    logger.error(`getFollowing error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /users/:userId — public user profile with follower/following counts
 * Enforces privacy rules
 */
const getUserProfile = async (req, res, next) => {
  try {
    const viewerId = req.user?.id || null;
    const userId = parseInt(req.params.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        createdAt: true,
        isPrivate: true,
        profile: { 
          select: { 
            name: true, 
            country: true,
            golfPassport: {
              select: {
                photoUrl: true,
                bio: true,
              },
            },
          } 
        },
      },
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const [followerCount, followingCount] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
    ]);

    let isFollowing = false;
    let requestSent = false;
    let canViewPosts = !user.isPrivate || viewerId === userId;

    if (viewerId && viewerId !== userId) {
      const [follow, request] = await Promise.all([
        prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: userId } },
        }),
        prisma.followRequest.findUnique({
          where: { senderId_receiverId: { senderId: viewerId, receiverId: userId } },
        }),
      ]);

      isFollowing = !!follow;
      requestSent = request?.status === 'pending';
      canViewPosts = !user.isPrivate || isFollowing || viewerId === userId;
    }

    const postCount = canViewPosts ? await prisma.post.count({ where: { userId } }) : 0;

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.profile?.name || user.username,
          country: user.profile?.country || null,
          photoUrl: user.profile?.golfPassport?.photoUrl || null,
          bio: user.profile?.golfPassport?.bio || null,
          createdAt: user.createdAt,
          isPrivate: user.isPrivate,
          followerCount,
          followingCount,
          postCount,
          isFollowing,
          requestSent,
          canViewPosts,
          isSelf: viewerId === userId,
        },
      },
    });
  } catch (error) {
    logger.error(`getUserProfile error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /users/follow-requests — get pending follow requests for current user
 */
const getFollowRequests = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const requests = await prisma.followRequest.findMany({
      where: { receiverId: userId, status: 'pending' },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profile: {
              select: {
                name: true,
                golfPassport: { select: { photoUrl: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = requests.map(r => ({
      id: r.id,
      senderId: r.sender.id,
      username: r.sender.username,
      name: r.sender.profile?.name || r.sender.username,
      photoUrl: r.sender.profile?.golfPassport?.photoUrl || null,
      createdAt: r.createdAt,
    }));

    return res.status(200).json({ success: true, data: { requests: data } });
  } catch (error) {
    logger.error(`getFollowRequests error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /users/follow-requests/:requestId/accept
 */
const acceptFollowRequest = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const requestId = parseInt(req.params.requestId);

    const request = await prisma.followRequest.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }

    // Create follow relationship
    await prisma.follow.create({
      data: { followerId: request.senderId, followingId: userId },
    });

    // Update request status
    await prisma.followRequest.update({
      where: { id: requestId },
      data: { status: 'accepted' },
    });

    emitFollowChanged(request.senderId, userId, 'followed');

    await createNotification({
      userId: request.senderId,
      type: 'FOLLOW_REQUEST_ACCEPTED',
      actorId: userId,
      entityType: 'user',
      entityId: userId,
    });

    return res.status(200).json({ success: true, message: 'Request accepted' });
  } catch (error) {
    logger.error(`acceptFollowRequest error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /users/follow-requests/:requestId/reject
 */
const rejectFollowRequest = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const requestId = parseInt(req.params.requestId);

    const request = await prisma.followRequest.findUnique({ where: { id: requestId } });
    if (!request || request.receiverId !== userId) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }

    await prisma.followRequest.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    return res.status(200).json({ success: true, message: 'Request rejected' });
  } catch (error) {
    logger.error(`rejectFollowRequest error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /users/:userId/follower — remove a follower
 */
const removeFollower = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const followerId = parseInt(req.params.userId);

    const follow = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId: userId } },
    });

    if (!follow) {
      return res.status(404).json({ success: false, message: 'Not a follower' });
    }

    await prisma.follow.delete({ where: { id: follow.id } });

    return res.status(200).json({ success: true, message: 'Follower removed' });
  } catch (error) {
    logger.error(`removeFollower error: ${error.message}`);
    next(error);
  }
};

module.exports = { 
  followUser, 
  unfollowUser, 
  getFollowers, 
  getFollowing, 
  getUserProfile,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
  removeFollower,
};
