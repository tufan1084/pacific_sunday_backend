const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// GET /api/tags — public list of active tags (used by community tabs & composer).
exports.listPublicTags = async (_req, res) => {
  try {
    const tags = await prisma.tag.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      select: { id: true, slug: true, label: true, description: true },
    });
    res.json({ success: true, data: { tags } });
  } catch (error) {
    logger.error(`tags.listPublic error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
