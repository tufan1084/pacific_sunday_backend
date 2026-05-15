const { prisma } = require('../config/db');
const logger = require('../config/logger');

const MAX_CATEGORIES_PER_USER = 20;

// ─── Categories ──────────────────────────────────────────────────────────────

// GET /api/saved-categories
// Returns the current user's categories with the count of posts in each.
exports.listCategories = async (req, res) => {
  try {
    const userId = req.user.id;
    const cats = await prisma.savedPostCategory.findMany({
      where: { userId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { savedPosts: true } } },
    });
    const uncategorizedCount = await prisma.savedPost.count({
      where: { userId, categoryId: null },
    });
    res.json({
      success: true,
      data: {
        categories: cats.map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          createdAt: c.createdAt.toISOString(),
          postCount: c._count.savedPosts,
        })),
        uncategorizedCount,
      },
    });
  } catch (error) {
    logger.error(`listCategories error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/saved-categories — body { name }
exports.createCategory = async (req, res) => {
  try {
    const userId = req.user.id;
    const name = (req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }
    if (name.length > 50) {
      return res.status(400).json({ success: false, message: 'Category name too long (max 50 characters)' });
    }

    const count = await prisma.savedPostCategory.count({ where: { userId } });
    if (count >= MAX_CATEGORIES_PER_USER) {
      return res.status(400).json({
        success: false,
        message: `Category limit reached (${MAX_CATEGORIES_PER_USER}). Delete one to create another.`,
      });
    }

    try {
      const cat = await prisma.savedPostCategory.create({
        data: { userId, name, sortOrder: count },
      });
      res.json({
        success: true,
        data: { category: { id: cat.id, name: cat.name, sortOrder: cat.sortOrder, postCount: 0, createdAt: cat.createdAt.toISOString() } },
      });
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(409).json({ success: false, message: 'You already have a category with that name' });
      }
      throw e;
    }
  } catch (error) {
    logger.error(`createCategory error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/saved-categories/:id — body { name?, sortOrder? }
exports.updateCategory = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid category id' });
    }

    const cat = await prisma.savedPostCategory.findUnique({ where: { id } });
    if (!cat || cat.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    const updateData = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: 'Name cannot be empty' });
      if (name.length > 50) return res.status(400).json({ success: false, message: 'Name too long (max 50)' });
      updateData.name = name;
    }
    if (req.body?.sortOrder !== undefined) {
      const so = parseInt(req.body.sortOrder);
      if (Number.isInteger(so)) updateData.sortOrder = so;
    }

    try {
      const updated = await prisma.savedPostCategory.update({ where: { id }, data: updateData });
      res.json({ success: true, data: { category: { id: updated.id, name: updated.name, sortOrder: updated.sortOrder } } });
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(409).json({ success: false, message: 'Another category already has that name' });
      }
      throw e;
    }
  } catch (error) {
    logger.error(`updateCategory error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/saved-categories/:id
// Posts in the category are NOT deleted — categoryId is set to null
// (handled by Prisma's onDelete: SetNull on the relation).
exports.deleteCategory = async (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'Invalid category id' });
    }

    const cat = await prisma.savedPostCategory.findUnique({ where: { id } });
    if (!cat || cat.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    await prisma.savedPostCategory.delete({ where: { id } });
    res.json({ success: true, message: 'Category deleted; saved posts moved to uncategorized' });
  } catch (error) {
    logger.error(`deleteCategory error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Save / Unsave ───────────────────────────────────────────────────────────

// POST /api/posts/:postId/save — body { categoryId? }
// Idempotent. If already saved, updates the categoryId. If categoryId is
// null/undefined, the post is saved without a category.
exports.savePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ success: false, message: 'Invalid post id' });
    }

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    let categoryId = null;
    if (req.body?.categoryId !== undefined && req.body.categoryId !== null) {
      categoryId = parseInt(req.body.categoryId);
      if (!Number.isInteger(categoryId)) {
        return res.status(400).json({ success: false, message: 'Invalid categoryId' });
      }
      const cat = await prisma.savedPostCategory.findUnique({ where: { id: categoryId } });
      if (!cat || cat.userId !== userId) {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }
    }

    const saved = await prisma.savedPost.upsert({
      where: { userId_postId: { userId, postId } },
      create: { userId, postId, categoryId },
      update: { categoryId },
    });

    res.json({
      success: true,
      data: { savedPost: { id: saved.id, postId, categoryId: saved.categoryId, createdAt: saved.createdAt.toISOString() } },
    });
  } catch (error) {
    logger.error(`savePost error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/posts/:postId/save — unsave (no-op if wasn't saved)
exports.unsavePost = async (req, res) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ success: false, message: 'Invalid post id' });
    }
    await prisma.savedPost.deleteMany({ where: { userId, postId } });
    res.json({ success: true });
  } catch (error) {
    logger.error(`unsavePost error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/posts/saved?categoryId=N|uncategorized
// Lists the user's saved posts with full post payloads matching the shape
// returned by GET /posts (so PostCard's like / pin / tag features work
// uniformly). Query param filters to one category; absent = all saves.
exports.listSavedPosts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { categoryId } = req.query;

    console.log('[listSavedPosts] userId:', userId, 'categoryId:', categoryId);

    const where = { userId };
    if (categoryId === 'uncategorized') {
      where.categoryId = null;
    } else if (categoryId) {
      const cid = parseInt(categoryId);
      if (Number.isInteger(cid)) where.categoryId = cid;
    }

    console.log('[listSavedPosts] where:', JSON.stringify(where));

    const saves = await prisma.savedPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        post: {
          include: {
            user: {
              select: {
                id: true, username: true,
                profile: { select: { name: true, golfPassport: { select: { photoUrl: true } } } },
              },
            },
            team: { select: { id: true, name: true, privacy: true } },
            _count: { select: { likes: true, comments: true } },
            tags: { include: { tag: { select: { slug: true, label: true, isActive: true } } } },
          },
        },
        category: { select: { id: true, name: true } },
      },
    });

    console.log('[listSavedPosts] Found saves:', saves.length);

    // Filter out saves where post is null (deleted) or hidden
    const visible = saves.filter((s) => s.post && s.post.id && !s.post.isHidden);
    console.log('[listSavedPosts] Visible after filter:', visible.length);
    const postIds = visible.map((s) => s.post.id);

    // Batch fetch the user's likes + pins for these posts so PostCard's
    // heart / pin states render correctly without N+1 round-trips.
    const [likes, pins] = await Promise.all([
      postIds.length
        ? prisma.postLike.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : [],
      postIds.length
        ? prisma.userPostPin.findMany({ where: { userId, postId: { in: postIds } }, select: { postId: true } })
        : [],
    ]);
    const likedSet = new Set(likes.map((l) => l.postId));
    const pinnedSet = new Set(pins.map((p) => p.postId));

    const items = visible.map((s) => {
      const tagSlugs = (s.post.tags || [])
        .filter((t) => t.tag && t.tag.isActive !== false)
        .map((t) => t.tag.slug);
      return {
        savedAt: s.createdAt.toISOString(),
        category: s.category ? { id: s.category.id, name: s.category.name } : null,
        post: {
          id: s.post.id,
          userId: s.post.userId,
          teamId: s.post.teamId,
          content: s.post.content,
          postType: s.post.postType,
          mediaUrls: s.post.mediaUrls,
          shareCount: s.post.shareCount,
          createdAt: s.post.createdAt.toISOString(),
          updatedAt: s.post.updatedAt.toISOString(),
          user: {
            id: s.post.user.id,
            username: s.post.user.username,
            profile: s.post.user.profile,
          },
          team: s.post.team || null,
          _count: s.post._count,
          tagSlugs,
          // PostCard reads `_computedTags` for the tag-filter UI
          _computedTags: tagSlugs,
          isLikedByUser: likedSet.has(s.post.id),
          isPinned: pinnedSet.has(s.post.id),
          isSavedByMe: true,
          myCategoryId: s.categoryId,
        },
      };
    });

    res.json({ success: true, data: { savedPosts: items } });
  } catch (error) {
    logger.error(`listSavedPosts error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
