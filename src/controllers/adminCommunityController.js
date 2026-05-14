const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { emitPostHidden, emitPostDeleted } = require('../config/socket');
const prisma = new PrismaClient();

// Shape one post for the admin table.
// status is derived: Hidden > Flagged (any pending reports) > Published.
function serializePost(p) {
  const pendingReports = (p.reports || []).filter(r => r.status === 'pending').length;
  let status = 'Published';
  if (p.isHidden) status = 'Hidden';
  else if (pendingReports > 0) status = 'Flagged';

  return {
    id: p.id,
    author: p.user?.profile?.name || p.user?.username || '—',
    authorId: p.user?.id,
    authorUsername: p.user?.username || null,
    content: p.content,
    group: p.team?.name || '—',
    teamId: p.team?.id ?? null,
    likes: p._count?.likes ?? 0,
    replies: p._count?.comments ?? 0,
    reports: p._count?.reports ?? 0,
    pendingReports,
    status,
    isHidden: p.isHidden,
    createdAt: p.createdAt,
  };
}

// GET /api/admin/posts — list all posts with moderation metadata
exports.listPosts = async (req, res) => {
  try {
    const posts = await prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, username: true, profile: { select: { name: true } } },
        },
        team: { select: { id: true, name: true } },
        reports: { select: { status: true } },
        _count: { select: { likes: true, comments: true, reports: true } },
      },
    });

    res.json({ success: true, data: posts.map(serializePost) });
  } catch (error) {
    logger.error(`admin.listPosts error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/admin/posts/:id/hide — toggle isHidden
exports.toggleHide = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    const updated = await prisma.post.update({
      where: { id },
      data: { isHidden: !existing.isHidden },
    });

    emitPostHidden(id, updated.isHidden);
    logger.info(`Admin toggled hide on post ${id} → ${updated.isHidden}`);

    res.json({ success: true, data: { id, isHidden: updated.isHidden } });
  } catch (error) {
    logger.error(`admin.toggleHide error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/posts/:id — hard delete (admin override)
exports.deletePost = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    await prisma.post.delete({ where: { id } });
    emitPostDeleted(id, existing.userId);
    logger.info(`Admin deleted post ${id}`);

    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    logger.error(`admin.deletePost error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/posts/:id/reports — all reports for a post
exports.listReports = async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const reports = await prisma.postReport.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, username: true, profile: { select: { name: true } } },
        },
      },
    });

    const data = reports.map(r => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
      reporter: {
        id: r.user.id,
        name: r.user.profile?.name || r.user.username,
        username: r.user.username,
      },
    }));

    res.json({ success: true, data });
  } catch (error) {
    logger.error(`admin.listReports error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/admin/posts/:id/reports/resolve — mark all pending reports reviewed/dismissed
// body: { status: 'reviewed' | 'dismissed' }
exports.resolveReports = async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { status } = req.body || {};
    if (!['reviewed', 'dismissed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const result = await prisma.postReport.updateMany({
      where: { postId, status: 'pending' },
      data: { status },
    });

    res.json({ success: true, data: { updated: result.count } });
  } catch (error) {
    logger.error(`admin.resolveReports error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/users/:userId/moderation — get user moderation info
exports.getUserModeration = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        postingBlocked: true,
        postingBlockedReason: true,
        profile: { select: { name: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get user's post count and report count
    const [postCount, reportCount] = await Promise.all([
      prisma.post.count({ where: { userId } }),
      prisma.postReport.count({ where: { post: { userId } } }),
    ]);

    res.json({
      success: true,
      data: {
        ...user,
        postCount,
        reportCount,
      },
    });
  } catch (error) {
    logger.error(`admin.getUserModeration error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/admin/users/:userId/block-posting — block/unblock user from posting
// body: { blocked: boolean, reason?: string }
exports.togglePostingBlock = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { blocked, reason } = req.body || {};

    if (typeof blocked !== 'boolean') {
      return res.status(400).json({ success: false, message: 'blocked field is required' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        postingBlocked: blocked,
        postingBlockedReason: blocked ? (reason || 'Violated community guidelines') : null,
      },
      select: {
        id: true,
        username: true,
        postingBlocked: true,
        postingBlockedReason: true,
      },
    });

    logger.info(`Admin ${blocked ? 'blocked' : 'unblocked'} user ${userId} from posting`);

    res.json({
      success: true,
      data: updated,
      message: blocked ? 'User blocked from posting' : 'User unblocked',
    });
  } catch (error) {
    logger.error(`admin.togglePostingBlock error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
