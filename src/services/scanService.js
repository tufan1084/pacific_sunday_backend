const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { parseDeviceLabel } = require('../utils/parseDeviceLabel');

/**
 * Records an NFC scan event and updates tap count / lastTappedAt on the bag.
 * Captures the User-Agent + a derived friendly label so the my-bag history
 * can show "iPhone — iOS 17" instead of a generic "Device".
 */
const recordScan = async (bagId, { userAgent } = {}) => {
  try {
    const deviceLabel = parseDeviceLabel(userAgent);
    const [scan] = await prisma.$transaction([
      prisma.scan.create({
        data: {
          bagId,
          userAgent: userAgent || null,
          deviceLabel: deviceLabel || null,
        },
      }),
      prisma.bag.update({
        where: { id: bagId },
        data: {
          tapCount: { increment: 1 },
          lastTappedAt: new Date(),
        },
      }),
    ]);

    logger.info(`Scan recorded: bagId=${bagId}, scanId=${scan.id}, device="${deviceLabel || 'unknown'}"`);
    return scan;
  } catch (error) {
    logger.error(`Failed to record scan for bagId=${bagId}: ${error.message}`);
    throw new Error('Failed to record scan');
  }
};

/**
 * Retrieves all scans for a given bag.
 */
const getScansForBag = async (bagId) => {
  try {
    const scans = await prisma.scan.findMany({
      where: { bagId },
      orderBy: { scanTime: 'desc' },
    });
    return scans;
  } catch (error) {
    logger.error(`Failed to fetch scans for bagId=${bagId}: ${error.message}`);
    throw new Error('Failed to retrieve scan history');
  }
};

module.exports = { recordScan, getScansForBag };
