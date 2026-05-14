const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const fs = require('fs');
const path = require('path');
const { deleteS3Object } = require('../config/s3');
const { processAndUploadImage } = require('../utils/imageProcessor');
const {
  checkAndAwardChallenge,
  isProfileComplete,
} = require('../services/challengeService');

const prisma = new PrismaClient();

/**
 * GET /profile
 * Get authenticated user's profile data with all related information
 */
const getProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        createdAt: true,
        isPrivate: true,
        profile: {
          select: {
            name: true,
            country: true,
            createdAt: true,
            golfPassport: true,
          },
        },
        bags: {
          select: {
            id: true,
            uid: true,
            tokenId: true,
            tapCount: true,
            registeredAt: true,
            lastTappedAt: true,
            createdAt: true,
            bagType: {
              select: {
                name: true,
                description: true,
                imageUrl: true,
                collection: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User not found',
      });
    }

    if (!user.profile) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'User profile not found. Please contact support.',
      });
    }

    // Get user points wallet and transactions
    let wallet = await prisma.userPointsWallet.findUnique({
      where: { userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!wallet) {
      wallet = await prisma.userPointsWallet.create({
        data: { userId, balance: 0 },
        include: { transactions: true },
      });
    }

    // Get user rank from leaderboard
    const allUsers = await prisma.user.findMany({
      select: { id: true, createdAt: true },
    });
    const wallets = await prisma.userPointsWallet.findMany({
      select: { userId: true, balance: true },
    });
    const walletMap = new Map(wallets.map(w => [w.userId, w.balance]));
    const leaderboard = allUsers
      .map(u => ({ userId: u.id, points: walletMap.get(u.id) || 0, createdAt: u.createdAt }))
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    const userRank = leaderboard.findIndex(u => u.userId === userId) + 1;

    // Calculate weeks registered
    const weeksRegistered = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000));

    logger.info(`Profile fetched for user: ${userId}`);

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.profile.name,
          username: user.username,
          email: user.email,
          country: user.profile.country,
          memberSince: user.createdAt,
          totalBags: user.bags.length,
          isPrivate: user.isPrivate,
        },
        bags: user.bags,
        golfPassport: user.profile.golfPassport,
        stats: {
          userPoints: wallet.balance,
          userRank: userRank || null,
          weeksRegistered: Math.max(0, weeksRegistered),
        },
        transactions: wallet.transactions,
      },
      message: 'Profile retrieved successfully',
    });
  } catch (error) {
    logger.error(`getProfile error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /profile/bags
 * Get all bags owned by authenticated user
 */
const getUserBags = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const bags = await prisma.bag.findMany({
      where: { userId },
      select: {
        id: true,
        uid: true,
        tokenId: true,
        tapCount: true,
        registeredAt: true,
        lastTappedAt: true,
        createdAt: true,
        bagType: {
          select: {
            name: true,
            description: true,
            imageUrl: true,
            collection: true,
          },
        },
        scans: {
          select: {
            id: true,
            scanTime: true,
            deviceLabel: true,
          },
          orderBy: {
            scanTime: 'desc',
          },
          // Was 10. Bumped so the scrollable my-bag history panel actually
          // has more than one viewport-worth of data on power-user accounts.
          take: 50,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get user points
    const wallet = await prisma.userPointsWallet.findUnique({
      where: { userId },
      select: { balance: true },
    });
    const userPoints = wallet?.balance || 0;

    // Get user rank from leaderboard
    const allUsers = await prisma.user.findMany({
      select: { id: true, createdAt: true },
    });
    const wallets = await prisma.userPointsWallet.findMany({
      select: { userId: true, balance: true },
    });
    const walletMap = new Map(wallets.map(w => [w.userId, w.balance]));
    const leaderboard = allUsers
      .map(u => ({ userId: u.id, points: walletMap.get(u.id) || 0, createdAt: u.createdAt }))
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    const userRank = leaderboard.findIndex(u => u.userId === userId) + 1;

    // Calculate weeks registered
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    const weeksRegistered = user
      ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000))
      : 0;

    logger.info(`Fetched ${bags.length} bags for user: ${userId}`);

    return res.status(200).json({
      success: true,
      data: { 
        bags,
        userPoints,
        userRank: userRank || null,
        weeksRegistered: Math.max(0, weeksRegistered),
      },
      message: 'Bags retrieved successfully',
    });
  } catch (error) {
    logger.error(`getUserBags error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /profile/bags/:serial/scans
 * Get scan history for a specific bag
 */
const getBagScans = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const bagId = parseInt(req.params.bagId, 10);

    // Verify bag belongs to user
    const bag = await prisma.bag.findFirst({
      where: {
        id: bagId,
        userId,
      },
      include: {
        bagType: {
          select: { name: true, collection: true },
        },
      },
    });

    if (!bag) {
      return res.status(404).json({
        success: false,
        data: null,
        message: 'Bag not found or does not belong to you',
      });
    }

    const scans = await prisma.scan.findMany({
      where: { bagId },
      orderBy: {
        scanTime: 'desc',
      },
      take: 50,
    });

    logger.info(`Fetched ${scans.length} scans for bag: ${bagId}`);

    return res.status(200).json({
      success: true,
      data: {
        bag: {
          id: bag.id,
          uid: bag.uid,
          name: bag.bagType?.name,
          collection: bag.bagType?.collection,
        },
        scans,
        totalScans: scans.length,
      },
      message: 'Scan history retrieved successfully',
    });
  } catch (error) {
    logger.error(`getBagScans error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /profile/golf-passport
 * Get user's golf passport data
 */
const getGolfPassport = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        profile: {
          select: {
            id: true,
            golfPassport: true,
          },
        },
      },
    });

    const passport = user?.profile?.golfPassport || null;

    logger.info(`Golf passport fetched for user: ${userId}`);

    return res.status(200).json({
      success: true,
      data: { golfPassport: passport },
      message: 'Golf passport retrieved successfully',
    });
  } catch (error) {
    logger.error(`getGolfPassport error: ${error.message}`);
    next(error);
  }
};

/**
 * PUT /profile/golf-passport
 * Update user's golf passport data
 */
const updateGolfPassport = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { fullName, nickname, handicap, bestScore, yearsPlaying, homeCourse, golfCountry, bio, photoUrl } = req.body;

    // Single nested write: update UserProfile (name + country sync) + upsert
    // GolfPassport in one round trip. The display name on the profile card,
    // header, leaderboard, etc. all read from UserProfile.name — so when the
    // user types a new fullName in the passport editor, mirror it onto the
    // profile so every surface stays in sync without a second save.
    const trimmedFullName = typeof fullName === 'string' ? fullName.trim() : null;
    const updatedProfile = await prisma.userProfile.update({
      where: { userId },
      data: {
        ...(trimmedFullName ? { name: trimmedFullName } : {}),
        ...(golfCountry !== undefined ? { country: golfCountry } : {}),
        golfPassport: {
          upsert: {
            update: { fullName, nickname, handicap, bestScore, yearsPlaying, homeCourse, golfCountry, bio, photoUrl },
            create: { fullName, nickname, handicap, bestScore, yearsPlaying, homeCourse, golfCountry, bio, photoUrl },
          },
        },
      },
      include: { golfPassport: true },
    });

    logger.info(`Golf passport updated for user: ${userId}`);

    // Achievement trigger — fire when the required passport fields are now filled.
    if (isProfileComplete(updatedProfile.golfPassport)) {
      checkAndAwardChallenge(userId, 'profile_completed').catch((err) =>
        logger.error(`Challenge trigger (profile_completed) failed: ${err.message}`),
      );
    }

    return res.status(200).json({
      success: true,
      data: { golfPassport: updatedProfile.golfPassport },
      message: 'Golf passport updated successfully',
    });
  } catch (error) {
    logger.error(`updateGolfPassport error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /profile/upload-photo
 * Upload profile photo
 */
const uploadProfilePhoto = async (req, res, next) => {
  try {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'No file uploaded',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        profile: {
          select: {
            id: true,
            golfPassport: {
              select: {
                photoUrl: true,
              },
            },
          },
        },
      },
    });

    // Delete old photo if exists (handle both S3 URLs and legacy local paths)
    const oldPhotoUrl = user?.profile?.golfPassport?.photoUrl;
    if (oldPhotoUrl) {
      if (/^https?:\/\//i.test(oldPhotoUrl)) {
        await deleteS3Object(oldPhotoUrl);
      } else {
        const oldPhotoPath = path.join(__dirname, '../../', oldPhotoUrl);
        if (fs.existsSync(oldPhotoPath)) {
          fs.unlinkSync(oldPhotoPath);
        }
      }
    }

    // Memory-buffer multer + WebP conversion via the shared image pipeline.
    if (!req.file.buffer) {
      return res.status(400).json({ success: false, message: 'Empty upload' });
    }
    // Match the original IAM-whitelisted prefix so PutObject is allowed.
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const out = await processAndUploadImage({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalName: req.file.originalname,
      keyPrefix: `community/profile/profile-${unique}`,
    });
    const photoUrl = out.location;

    logger.info(`Profile photo upload — userId: ${userId}, profileId: ${user?.profile?.id}, photoUrl: ${photoUrl}`);

    // Persist photoUrl immediately so it survives a refresh without requiring a separate "Save".
    if (user?.profile?.id) {
      const saved = await prisma.golfPassport.upsert({
        where: { profileId: user.profile.id },
        update: { photoUrl },
        create: { profileId: user.profile.id, photoUrl },
      });
      logger.info(`GolfPassport upsert ok — id: ${saved.id}, photoUrl in row: ${saved.photoUrl}`);
    } else {
      logger.warn(`Skipped GolfPassport upsert — user.profile is missing for userId ${userId}`);
    }

    return res.status(200).json({
      success: true,
      data: { photoUrl },
      message: 'Photo uploaded successfully',
    });
  } catch (error) {
    logger.error(`uploadProfilePhoto error: ${error.message}`);
    next(error);
  }
};

/**
 * PATCH /profile/privacy
 * Toggle profile privacy (public/private)
 */
const updatePrivacy = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { isPrivate } = req.body;

    if (typeof isPrivate !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isPrivate must be a boolean',
      });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isPrivate },
      select: { id: true, isPrivate: true },
    });

    logger.info(`Privacy updated for user ${userId}: isPrivate=${isPrivate}`);

    return res.status(200).json({
      success: true,
      data: { isPrivate: user.isPrivate },
      message: `Profile is now ${isPrivate ? 'private' : 'public'}`,
    });
  } catch (error) {
    logger.error(`updatePrivacy error: ${error.message}`);
    next(error);
  }
};

module.exports = {
  getProfile,
  getUserBags,
  getBagScans,
  getGolfPassport,
  updateGolfPassport,
  uploadProfilePhoto,
  updatePrivacy,
};
