const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const PostCacheService = require('../services/postCacheService');
const { verifyViewToken } = require('./adminAuthController');
const {
  emitPostLiked,
  emitPostUnliked,
  emitPostCreated,
  emitCommentAdded,
  emitCommentEdited,
  emitCommentDeleted,
  emitPostPinned,
  emitPostDeleted,
  emitPostShared,
  getIO,
} = require('../config/socket');
const { createNotification, notifyTeamMembers } = require('../services/notificationService');
const { dispatchPostReportEmails } = require('../services/postReportEmailService');
const {
  applyAutoTagsForPost,
  setManualTagsForPost,
  serializePostTags,
} = require('../services/tagService');
const prisma = new PrismaClient();

// Consistent shape for the `tags` include used across post queries — keeps
// payloads lean (just slug + source) and avoids pulling full keyword lists.
const TAGS_INCLUDE = {
  select: {
    source: true,
    tag: { select: { id: true, slug: true, label: true } },
  },
};

/**
 * POST /posts
 * Create a new post
 */
const createPost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { content, postType = 'TEXT', mediaUrls, teamId, tags: manualTagSlugs } = req.body;

    // Allow posts with either content or media
    if ((!content || content.trim().length === 0) && (!mediaUrls || mediaUrls.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'Post content or media is required',
      });
    }

    // Posting-block check: superadmin may have suspended this user from
    // creating posts. Read-only access is preserved; only the create path
    // is denied. Reason (if any) is surfaced for the client to display.
    const blockCheck = await prisma.user.findUnique({
      where: { id: userId },
      select: { postingBlocked: true, postingBlockedReason: true },
    });
    if (blockCheck?.postingBlocked) {
      return res.status(403).json({
        success: false,
        message: blockCheck.postingBlockedReason
          ? `You are not allowed to post in the community. Reason: ${blockCheck.postingBlockedReason}`
          : 'You are not allowed to post in the community.',
        code: 'POSTING_BLOCKED',
      });
    }

    // If posting to a team, verify the user is a member
    let resolvedTeamId = null;
    if (teamId) {
      const tid = parseInt(teamId);
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: tid, userId } },
      });
      if (!membership) {
        return res.status(403).json({
          success: false,
          message: 'You must be a member of the team to post in it',
        });
      }
      resolvedTeamId = tid;
    }

    const created = await prisma.post.create({
      data: {
        userId,
        teamId: resolvedTeamId,
        content: content ? content.trim() : '',
        postType,
        mediaUrls: mediaUrls || null,
      },
      select: { id: true },
    });

    // Auto-tag from keyword scan first, then apply any manual tags the author
    // selected in the composer — manual rows win over auto for the same tag.
    if (content && content.trim()) {
      await applyAutoTagsForPost(created.id, content.trim());
    }
    if (Array.isArray(manualTagSlugs) && manualTagSlugs.length > 0) {
      await setManualTagsForPost(created.id, manualTagSlugs, 'override');
    }

    const post = await prisma.post.findUnique({
      where: { id: created.id },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    const response = { ...post, tagSlugs: serializePostTags(post) };

    logger.info(`Post created: postId=${post.id}, userId=${userId}, tags=[${response.tagSlugs.join(',')}]`);

    // Emit real-time event
    emitPostCreated(response);

    // Fan out a notification to every team member (except the author) when the
    // post is scoped to a team, so members hear about activity inside the team.
    if (resolvedTeamId) {
      notifyTeamMembers({
        teamId: resolvedTeamId,
        type: 'TEAM_POST_CREATED',
        actorId: userId,
        entityType: 'post',
        entityId: post.id,
        data: {
          teamName: post.team?.name || null,
          preview: (post.content || '').slice(0, 80),
        },
      }).catch(err => logger.error(`notifyTeamMembers fanout failed: ${err.message}`));
    }

    return res.status(201).json({
      success: true,
      data: { post: response },
      message: 'Post created successfully',
    });
  } catch (error) {
    logger.error(`createPost error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /posts
 * Get all posts (public feed) with Redis caching
 */
const getPosts = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0, teamId, tag, authorId } = req.query;
    const userId = req.user?.id;

    logger.info(`Fetching posts for userId: ${userId} teamId: ${teamId || 'all'} tag: ${tag || 'any'} authorId: ${authorId || 'any'}`);

    // Posts scoped to a team are visible only to members of that team,
    // regardless of the team's privacy setting.
    const where = { isHidden: false };
    if (tag) {
      // Filter to posts that carry this tag (any source — auto or manual).
      where.tags = { some: { tag: { slug: String(tag), isActive: true } } };
    }
    if (authorId) {
      where.userId = parseInt(authorId);
    }
    if (teamId) {
      const tid = parseInt(teamId);
      const team = await prisma.team.findUnique({ where: { id: tid } });
      if (!team) {
        return res.status(404).json({ success: false, message: 'Team not found' });
      }
      if (!userId) {
        return res.status(403).json({ success: false, message: 'Team posts are visible to members only' });
      }
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: tid, userId } },
      });
      if (!membership) {
        return res.status(403).json({ success: false, message: 'Team posts are visible to members only' });
      }
      where.teamId = tid;
    } else {
      // Global feed — team posts only show to members of that team.
      if (userId) {
        where.OR = [
          { teamId: null },
          { team: { members: { some: { userId } } } },
        ];
      } else {
        where.teamId = null;
      }
    }

    // Per-user hidden-post filter. Authenticated users get their personal
    // "don't show me this again" list excluded from the feed.
    if (userId) {
      where.NOT = [
        ...(Array.isArray(where.NOT) ? where.NOT : []),
        { hiddenBy: { some: { userId } } },
      ];
    }

    const posts = await prisma.post.findMany({
      where,
      take: parseInt(limit),
      skip: parseInt(offset),
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        originalPost: {
          include: {
            user: {
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
            _count: {
              select: {
                likes: true,
                comments: true,
              },
            },
            tags: TAGS_INCLUDE,
          },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    // Batch-fetch the current user's SavedPost rows for the posts we just
    // returned, so each card can render its bookmark state without N+1 queries.
    const savedByPostId = new Map();
    if (userId && posts.length > 0) {
      const saves = await prisma.savedPost.findMany({
        where: { userId, postId: { in: posts.map((p) => p.id) } },
        select: { postId: true, categoryId: true },
      });
      for (const s of saves) savedByPostId.set(s.postId, s.categoryId);
    }

    // Check like and pin status for each post
    const postsWithLikeStatus = await Promise.all(posts.map(async (post) => {
      // Get like count from cache or DB
      let likeCount = await PostCacheService.getLikeCount(post.id);
      if (likeCount === null) {
        likeCount = post._count.likes;
        await PostCacheService.setLikeCount(post.id, likeCount);
      }

      // Check if current user liked this post
      let isLikedByUser = false;
      let isPinnedByUser = false;
      if (userId) {
        // Check cache first
        const cachedLike = await PostCacheService.hasUserLiked(userId, post.id);
        
        if (cachedLike) {
          isLikedByUser = true;
          logger.info(`Cache hit: User ${userId} liked post ${post.id}`);
        } else {
          // Check DB
          const dbLike = await prisma.postLike.findUnique({
            where: {
              postId_userId: { postId: post.id, userId },
            },
          });
          
          if (dbLike) {
            isLikedByUser = true;
            // Sync to cache
            await PostCacheService.addUserLike(userId, post.id);
            logger.info(`DB hit: User ${userId} liked post ${post.id}, synced to cache`);
          } else {
            logger.info(`User ${userId} has NOT liked post ${post.id}`);
          }
        }

        // Check if user pinned this post
        const userPin = await prisma.userPostPin.findUnique({
          where: {
            postId_userId: { postId: post.id, userId },
          },
        });
        isPinnedByUser = !!userPin;
      }

      return {
        ...post,
        _count: {
          likes: likeCount,
          comments: post._count.comments,
        },
        isLikedByUser,
        isPinned: isPinnedByUser,
        isSavedByMe: savedByPostId.has(post.id),
        myCategoryId: savedByPostId.get(post.id) ?? null,
        tagSlugs: serializePostTags(post),
        originalPost: post.originalPost
          ? {
              ...post.originalPost,
              tagSlugs: serializePostTags(post.originalPost),
            }
          : null,
      };
    }));

    // Sort: pinned posts first (for current user), then by date
    const sortedPosts = postsWithLikeStatus.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    logger.info(`Fetched ${posts.length} posts from database`);

    return res.status(200).json({
      success: true,
      data: { posts: sortedPosts },
      message: 'Posts retrieved successfully',
    });
  } catch (error) {
    logger.error(`getPosts error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/like
 * Like/unlike a post with Redis caching
 */
const likePost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);

    logger.info(`Like request: postId=${postId}, userId=${userId}`);

    // Verify post exists before touching likes
    const postExists = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!postExists) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Check DB first for accurate state
    const existingLike = await prisma.postLike.findUnique({
      where: {
        postId_userId: { postId, userId },
      },
    });

    if (existingLike) {
      // Unlike - delete from DB first
      await prisma.postLike.delete({
        where: { id: existingLike.id },
      });
      
      logger.info(`Deleted like from DB: postId=${postId}, userId=${userId}`);
      
      // Update cache after successful DB delete
      await PostCacheService.removeUserLike(userId, postId);
      
      // Get actual count from DB and update cache
      const actualCount = await prisma.postLike.count({
        where: { postId },
      });
      await PostCacheService.setLikeCount(postId, actualCount);

      logger.info(`Post ${postId} unliked by user ${userId}, new count: ${actualCount}`);

      // Emit real-time event
      emitPostUnliked(postId, actualCount, userId);

      return res.status(200).json({
        success: true,
        data: { liked: false, likeCount: actualCount },
        message: 'Post unliked',
      });
    }

    // Like - create in DB first
    await prisma.postLike.create({
      data: { postId, userId },
    });
    
    logger.info(`Created like in DB: postId=${postId}, userId=${userId}`);
    
    // Update cache after successful DB insert
    await PostCacheService.addUserLike(userId, postId);
    
    // Get actual count from DB and update cache
    const actualCount = await prisma.postLike.count({
      where: { postId },
    });
    await PostCacheService.setLikeCount(postId, actualCount);

    logger.info(`Post ${postId} liked by user ${userId}, new count: ${actualCount}`);

    // Emit real-time event
    emitPostLiked(postId, actualCount, userId);

    // Notify the post author (createNotification skips self-notifications)
    const postAuthor = await prisma.post.findUnique({
      where: { id: postId },
      select: { userId: true, content: true },
    });
    if (postAuthor) {
      await createNotification({
        userId: postAuthor.userId,
        type: 'POST_LIKED',
        actorId: userId,
        entityType: 'post',
        entityId: postId,
        data: { preview: (postAuthor.content || '').slice(0, 80) },
      });
    }

    return res.status(200).json({
      success: true,
      data: { liked: true, likeCount: actualCount },
      message: 'Post liked',
    });
  } catch (error) {
    logger.error(`likePost error: ${error.message}`);
    logger.error(`Error stack: ${error.stack}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/comments
 * Add comment to post
 */
  const addComment = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    const { content, parentId, mediaUrl } = req.body;

    // Allow either content or mediaUrl (or both)
    if ((!content || content.trim().length === 0) && !mediaUrl) {
      return res.status(400).json({
        success: false,
        message: 'Comment content or image is required',
      });
    }

    // Posting-block check applies to comments + replies too — a blocked user
    // shouldn't be able to route around the gate by commenting instead.
    const blockCheck = await prisma.user.findUnique({
      where: { id: userId },
      select: { postingBlocked: true, postingBlockedReason: true },
    });
    if (blockCheck?.postingBlocked) {
      return res.status(403).json({
        success: false,
        message: blockCheck.postingBlockedReason
          ? `You are not allowed to comment in the community. Reason: ${blockCheck.postingBlockedReason}`
          : 'You are not allowed to comment in the community.',
        code: 'POSTING_BLOCKED',
      });
    }

    const comment = await prisma.postComment.create({
      data: {
        postId,
        userId,
        parentId: parentId ? parseInt(parentId) : null,
        content: content ? content.trim() : '',
        mediaUrl: mediaUrl || null,
      },
      include: {
        user: {
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
    });

    // Update comment count in cache
    await PostCacheService.incrementComments(postId);

    // Get the updated total comment count for this post
    const commentCount = await prisma.postComment.count({ where: { postId } });

    logger.info(`Comment added: postId=${postId}, userId=${userId}, parentId=${parentId}`);

    // Emit real-time event so every open client updates instantly
    emitCommentAdded(postId, commentCount, comment);

    // Notify post author about the comment, or parent-comment author on a reply.
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { userId: true, content: true },
    });
    if (post) {
      await createNotification({
        userId: post.userId,
        type: 'POST_COMMENTED',
        actorId: userId,
        entityType: 'post',
        entityId: postId,
        data: { preview: content ? content.slice(0, 80) : '[Image]', postPreview: (post.content || '').slice(0, 60) },
      });
    }
    if (parentId) {
      const parent = await prisma.postComment.findUnique({
        where: { id: parseInt(parentId) },
        select: { userId: true },
      });
      if (parent && parent.userId !== post?.userId) {
        await createNotification({
          userId: parent.userId,
          type: 'COMMENT_REPLIED',
          actorId: userId,
          entityType: 'post',
          entityId: postId,
          data: { preview: content ? content.slice(0, 80) : '[Image]' },
        });
      }
    }

    return res.status(201).json({
      success: true,
      data: { comment },
      message: 'Comment added',
    });
  } catch (error) {
    logger.error(`addComment error: ${error.message}`);
    next(error);
  }
};

/**
 * PATCH /posts/comments/:commentId — body { content }
 * Edit the authenticated user's own comment. Owner-only.
 */
const editComment = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const commentId = parseInt(req.params.commentId);
    if (!Number.isInteger(commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid comment id' });
    }
    const content = (req.body?.content || '').trim();
    if (!content) {
      return res.status(400).json({ success: false, message: 'Content cannot be empty' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ success: false, message: 'Comment too long (max 2000 chars)' });
    }

    const existing = await prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, postId: true },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ success: false, message: 'You can only edit your own comments' });
    }

    const updated = await prisma.postComment.update({
      where: { id: commentId },
      data: { content },
      include: {
        user: {
          select: {
            id: true, username: true,
            profile: { select: { name: true, golfPassport: { select: { photoUrl: true } } } },
          },
        },
      },
    });

    logger.info(`Comment edited: id=${commentId}, postId=${existing.postId}, userId=${userId}`);
    emitCommentEdited(existing.postId, updated);

    return res.status(200).json({ success: true, data: { comment: updated } });
  } catch (error) {
    logger.error(`editComment error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /posts/comments/:commentId
 * Delete a comment. Allowed for:
 * - Comment author (can delete their own comment)
 * - Post owner (can delete any comment on their post)
 * Replies cascade via Prisma's onDelete: Cascade on the parent relation.
 */
const deleteComment = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const commentId = parseInt(req.params.commentId);
    if (!Number.isInteger(commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid comment id' });
    }

    const comment = await prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, postId: true, post: { select: { userId: true } } },
    });
    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found' });
    }

    // Allow deletion if user is comment author OR post owner
    const isCommentAuthor = comment.userId === userId;
    const isPostOwner = comment.post.userId === userId;
    
    if (!isCommentAuthor && !isPostOwner) {
      return res.status(403).json({ success: false, message: 'You can only delete your own comments or comments on your posts' });
    }

    await prisma.postComment.delete({ where: { id: commentId } });

    // Recompute count from DB (replies were cascaded — can't just decrement by 1).
    const commentCount = await prisma.postComment.count({ where: { postId: comment.postId } });
    await PostCacheService.setCommentsCount(comment.postId, commentCount);

    logger.info(`Comment deleted: id=${commentId}, postId=${comment.postId}, userId=${userId}, isPostOwner=${isPostOwner}`);
    emitCommentDeleted(comment.postId, commentId, commentCount);

    return res.status(200).json({
      success: true,
      data: { commentId, postId: comment.postId, commentCount },
    });
  } catch (error) {
    logger.error(`deleteComment error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/pin
 * Toggle pin state for current user (owner only). Emits real-time event.
 */
const togglePin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Only post owner can pin their own post
    if (post.userId !== userId) {
      return res.status(403).json({ success: false, message: 'You can only pin your own posts' });
    }

    // Check if user already pinned this post
    const existingPin = await prisma.userPostPin.findUnique({
      where: {
        postId_userId: { postId, userId },
      },
    });

    let isPinned;
    if (existingPin) {
      // Unpin
      await prisma.userPostPin.delete({
        where: { id: existingPin.id },
      });
      isPinned = false;
    } else {
      // Pin
      await prisma.userPostPin.create({
        data: { postId, userId },
      });
      isPinned = true;
    }

    logger.info(`Post ${postId} pin toggled to ${isPinned} by user ${userId}`);
    emitPostPinned(postId, isPinned, userId);

    return res.status(200).json({
      success: true,
      data: { isPinned },
      message: isPinned ? 'Post pinned' : 'Post unpinned',
    });
  } catch (error) {
    logger.error(`togglePin error: ${error.message}`);
    next(error);
  }
};

/**
 * PATCH /posts/:postId
 * Edit post (owner only). Content and media can be edited.
 */
const editPost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    const { content, mediaUrls } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Post content is required',
      });
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.userId !== userId) {
      return res.status(403).json({ success: false, message: 'You can only edit your own posts' });
    }

    // Don't allow editing reshares
    if (post.originalPostId) {
      return res.status(400).json({ success: false, message: 'Reshared posts cannot be edited' });
    }

    const updateData = { content: content.trim() };
    if (mediaUrls !== undefined) {
      updateData.mediaUrls = mediaUrls;
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: updateData,
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    // Re-apply auto-tags based on new content
    await prisma.postTag.deleteMany({ where: { postId, source: 'auto' } });
    if (content.trim()) {
      await applyAutoTagsForPost(postId, content.trim());
    }

    // Fetch updated post with new tags
    const postWithTags = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    logger.info(`Post edited: postId=${postId}, userId=${userId}`);

    const finalPost = { ...postWithTags, tagSlugs: serializePostTags(postWithTags) };

    // Emit real-time edit event so all open clients update instantly
    try { getIO().emit('post:edited', { postId, content: finalPost.content, mediaUrls: finalPost.mediaUrls }); } catch {}

    return res.status(200).json({
      success: true,
      data: { post: finalPost },
      message: 'Post updated successfully',
    });
  } catch (error) {
    logger.error(`editPost error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /posts/:postId
 * Delete post (owner only). Emits real-time event.
 */
const deletePost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.userId !== userId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own posts' });
    }

    await prisma.post.delete({ where: { id: postId } });

    logger.info(`Post ${postId} deleted by user ${userId}`);
    emitPostDeleted(postId, userId);

    return res.status(200).json({
      success: true,
      message: 'Post deleted',
    });
  } catch (error) {
    logger.error(`deletePost error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/share
 * Increment share counter. Emits real-time event so every client updates.
 */
const sharePost = async (req, res, next) => {
  try {
    const postId = parseInt(req.params.postId);
    const existing = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Use Redis incr for speed, sync to DB async
    const cachedCount = await PostCacheService.incrementShares(postId);

    // Sync DB in background
    prisma.post.update({
      where: { id: postId },
      data: { shareCount: { increment: 1 } },
      select: { shareCount: true },
    }).then(updated => {
      PostCacheService.setShareCount(postId, updated.shareCount);
    }).catch(err => logger.error(`sharePost DB sync error: ${err.message}`));

    const shareCount = cachedCount;
    emitPostShared(postId, shareCount);

    return res.status(200).json({
      success: true,
      data: { postId, shareCount },
      message: 'Share recorded',
    });
  } catch (error) {
    logger.error(`sharePost error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/reshare
 * Reshare a post to your own feed with optional comment
 * Body: { comment?, teamId? }
 */
const resharePost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const originalPostId = parseInt(req.params.postId);
    const { comment, teamId } = req.body;

    // Check if original post exists
    const originalPost = await prisma.post.findUnique({
      where: { id: originalPostId },
      select: {
        id: true,
        userId: true,
        content: true,
        teamId: true,
        team: { select: { privacy: true } },
      },
    });

    if (!originalPost) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Can't reshare your own post
    if (originalPost.userId === userId) {
      return res.status(400).json({ success: false, message: "You can't reshare your own post" });
    }

    // Can't reshare private team posts
    if (originalPost.teamId && originalPost.team?.privacy === 'private') {
      return res.status(403).json({ success: false, message: "You can't reshare private team posts" });
    }

    // Check if user already reshared this post
    const existingReshare = await prisma.post.findFirst({
      where: {
        userId,
        originalPostId,
      },
    });

    if (existingReshare) {
      return res.status(400).json({ success: false, message: 'You have already reshared this post' });
    }

    // Posting-block check
    const blockCheck = await prisma.user.findUnique({
      where: { id: userId },
      select: { postingBlocked: true, postingBlockedReason: true },
    });
    if (blockCheck?.postingBlocked) {
      return res.status(403).json({
        success: false,
        message: blockCheck.postingBlockedReason
          ? `You are not allowed to post in the community. Reason: ${blockCheck.postingBlockedReason}`
          : 'You are not allowed to post in the community.',
        code: 'POSTING_BLOCKED',
      });
    }

    // If posting to a team, verify membership
    let resolvedTeamId = null;
    if (teamId) {
      const tid = parseInt(teamId);
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: tid, userId } },
      });
      if (!membership) {
        return res.status(403).json({
          success: false,
          message: 'You must be a member of the team to post in it',
        });
      }
      resolvedTeamId = tid;
    }

    // Create reshare post
    const reshare = await prisma.post.create({
      data: {
        userId,
        teamId: resolvedTeamId,
        content: comment ? String(comment).trim().slice(0, 500) : '',
        originalPostId,
        reshareComment: comment ? String(comment).trim().slice(0, 500) : null,
      },
    });

    // Increment share count on original post
    await prisma.post.update({
      where: { id: originalPostId },
      data: { shareCount: { increment: 1 } },
    });

    // Fetch the complete reshare with all relations
    const completeReshare = await prisma.post.findUnique({
      where: { id: reshare.id },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        originalPost: {
          include: {
            user: {
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
            _count: {
              select: {
                likes: true,
                comments: true,
              },
            },
            tags: TAGS_INCLUDE,
          },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    logger.info(`Post reshared: originalPostId=${originalPostId}, reshareId=${reshare.id}, userId=${userId}`);

    // Emit real-time event
    emitPostCreated({
      ...completeReshare,
      tagSlugs: serializePostTags(completeReshare),
      originalPost: completeReshare.originalPost
        ? {
            ...completeReshare.originalPost,
            tagSlugs: serializePostTags(completeReshare.originalPost),
          }
        : null,
    });

    // Notify original post author
    await createNotification({
      userId: originalPost.userId,
      type: 'POST_RESHARED',
      actorId: userId,
      entityType: 'post',
      entityId: originalPostId,
      data: {
        reshareId: reshare.id,
        comment: comment || null,
        preview: (originalPost.content || '').slice(0, 80),
      },
    });

    return res.status(201).json({
      success: true,
      data: { post: completeReshare },
      message: 'Post reshared successfully',
    });
  } catch (error) {
    logger.error(`resharePost error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /posts/:postId/comments
 * Get comments for a post with nested replies (recursive)
 */
const getComments = async (req, res, next) => {
  try {
    const postId = parseInt(req.params.postId);

    // Recursive function to fetch all nested replies
    const fetchRepliesRecursively = async (parentId) => {
      const replies = await prisma.postComment.findMany({
        where: { parentId },
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
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
      });

      // Recursively fetch replies for each reply
      for (const reply of replies) {
        reply.replies = await fetchRepliesRecursively(reply.id);
      }

      return replies;
    };

    // Get top-level comments
    const comments = await prisma.postComment.findMany({
      where: { 
        postId,
        parentId: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
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
    });

    // Fetch nested replies for each top-level comment
    for (const comment of comments) {
      comment.replies = await fetchRepliesRecursively(comment.id);
    }

    return res.status(200).json({
      success: true,
      data: { comments },
      message: 'Comments retrieved',
    });
  } catch (error) {
    logger.error(`getComments error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /posts/:postId
 * Get a single post (authenticated)
 * Query param: viewToken - temporary admin token to bypass team membership check
 */
const getPostById = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const postId = parseInt(req.params.postId);
    const viewToken = req.query.viewToken;

    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid post id' });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        originalPost: {
          include: {
            user: {
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
            _count: {
              select: {
                likes: true,
                comments: true,
              },
            },
            tags: TAGS_INCLUDE,
          },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Check team access - bypass if valid view token is provided
    const isAdminView = viewToken && verifyViewToken(viewToken, postId);
    if (post.teamId && !isAdminView) {
      if (!userId) {
        return res.status(403).json({ success: false, message: 'Team posts are visible to members only' });
      }
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: post.teamId, userId } },
      });
      if (!membership) {
        return res.status(403).json({ success: false, message: 'Team posts are visible to members only' });
      }
    }

    // Check if user liked this post
    let isLikedByUser = false;
    let isPinnedByUser = false;
    if (userId) {
      const like = await prisma.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      isLikedByUser = !!like;

      const pin = await prisma.userPostPin.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      isPinnedByUser = !!pin;
    }

    // Check if saved
    let isSavedByMe = false;
    let myCategoryId = null;
    if (userId) {
      const saved = await prisma.savedPost.findUnique({
        where: { userId_postId: { userId, postId } },
        select: { categoryId: true },
      });
      if (saved) {
        isSavedByMe = true;
        myCategoryId = saved.categoryId;
      }
    }

    logger.info(`Post viewed: postId=${postId}, userId=${userId}, adminView=${isAdminView}`);

    return res.status(200).json({
      success: true,
      data: {
        post: {
          ...post,
          isLikedByUser,
          isPinned: isPinnedByUser,
          isSavedByMe,
          myCategoryId,
          _computedTags: serializePostTags(post),
          tagSlugs: serializePostTags(post),
          originalPost: post.originalPost
            ? {
                ...post.originalPost,
                tagSlugs: serializePostTags(post.originalPost),
              }
            : null,
        },
      },
      message: 'Post retrieved',
    });
  } catch (error) {
    logger.error(`getPostById error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /posts/:postId/public
 * Get a single post for public viewing (no auth required)
 * Only returns posts that are not in private teams
 */
const getPublicPost = async (req, res, next) => {
  try {
    const postId = parseInt(req.params.postId);

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
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
        team: {
          select: { id: true, name: true, privacy: true },
        },
        tags: TAGS_INCLUDE,
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    // Team-scoped posts are members-only and never exposed via the public endpoint.
    if (post.teamId) {
      return res.status(403).json({ success: false, message: 'This post is visible to team members only' });
    }

    logger.info(`Public post viewed: postId=${postId}`);

    return res.status(200).json({
      success: true,
      data: { post: { ...post, isLikedByUser: false, tagSlugs: serializePostTags(post) } },
      message: 'Post retrieved',
    });
  } catch (error) {
    logger.error(`getPublicPost error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/hide
 * Per-user hide: the post no longer shows in this user's feed. Idempotent.
 * Does not affect anyone else and never notifies the author.
 */
const hidePost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ success: false, message: 'Invalid post id' });
    }
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    await prisma.hiddenPost.upsert({
      where: { userId_postId: { userId, postId } },
      create: { userId, postId },
      update: {},
    });
    logger.info(`Post ${postId} hidden by user ${userId}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`hidePost error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /posts/:postId/hide
 * Restore a previously hidden post. No-op if it wasn't hidden.
 */
const unhidePost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ success: false, message: 'Invalid post id' });
    }
    await prisma.hiddenPost.deleteMany({ where: { userId, postId } });
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`unhidePost error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /posts/:postId/report
 * Report a post. One report per (user, post) — re-submitting updates reason.
 */
const reportPost = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const postId = parseInt(req.params.postId);
    const { reason, details } = req.body || {};

    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ success: false, message: 'Reason is required' });
    }

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, userId: true } });
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.userId === userId) {
      return res.status(400).json({ success: false, message: "You can't report your own post" });
    }

    const safeReason = reason.slice(0, 40);
    const safeDetails = (details || null)?.slice(0, 500) || null;

    const report = await prisma.postReport.upsert({
      where: { postId_userId: { postId, userId } },
      create: { postId, userId, reason: safeReason, details: safeDetails },
      update: { reason: safeReason, details: safeDetails, status: 'pending' },
    });

    logger.info(`Post ${postId} reported by user ${userId} (${reason})`);

    // Fire-and-forget: notify author + admins. Run after the response so a
    // slow SMTP call never blocks the API or 500s on email failure.
    setImmediate(() => {
      dispatchPostReportEmails({
        postId, reporterId: userId, reason: safeReason, details: safeDetails,
      }).catch((err) => logger.warn(`[reportPost] email dispatch error: ${err.message}`));
    });

    return res.status(201).json({ success: true, data: { id: report.id }, message: 'Report submitted' });
  } catch (error) {
    logger.error(`reportPost error: ${error.message}`);
    next(error);
  }
};

module.exports = {
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
};
