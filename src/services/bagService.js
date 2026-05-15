const { prisma } = require('../config/db');
const logger = require('../config/logger');

/**
 * Finds a bag by its NFC chip UID, including bagType details and user.
 */
const findBagByUid = async (uid) => {
  try {
    const bag = await prisma.bag.findUnique({
      where: { uid },
      include: {
        bagType: true,
        user: { include: { profile: true } },
      },
    });
    return bag;
  } catch (error) {
    logger.error(`Failed to find bag by uid=${uid}: ${error.message}`);
    throw new Error('Failed to look up bag');
  }
};

/**
 * Links a bag to a user by setting registered=true, userId, registeredAt.
 */
const linkBagToUser = async (uid, userId) => {
  try {
    const bag = await prisma.bag.update({
      where: { uid },
      data: {
        registered: true,
        userId,
        registeredAt: new Date(),
      },
    });

    logger.info(`Bag linked: uid=${uid}, userId=${userId}`);
    return bag;
  } catch (error) {
    logger.error(`Failed to link bag uid=${uid} to userId=${userId}: ${error.message}`);
    throw new Error('Failed to register bag to user');
  }
};

/**
 * Retrieves all bags for a given user, including bag type and scan history.
 */
const getBagsByUser = async (userId) => {
  try {
    const bags = await prisma.bag.findMany({
      where: { userId },
      include: {
        bagType: true,
        scans: { orderBy: { scanTime: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return bags;
  } catch (error) {
    logger.error(`Failed to fetch bags for userId=${userId}: ${error.message}`);
    throw new Error('Failed to retrieve user bags');
  }
};

module.exports = {
  findBagByUid,
  linkBagToUser,
  getBagsByUser,
};
