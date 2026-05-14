const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const {
  applyAutoTagsForPost,
  setManualTagsForPost,
} = require('../services/tagService');

const prisma = new PrismaClient();

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// GET /api/admin/tags — list tags with keyword & post counts for the table.
exports.listTags = async (_req, res) => {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      include: {
        keywords: { select: { id: true, keyword: true }, orderBy: { keyword: 'asc' } },
        _count: { select: { posts: true } },
      },
    });

    const data = tags.map(t => ({
      id: t.id,
      slug: t.slug,
      label: t.label,
      description: t.description,
      isActive: t.isActive,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      keywordCount: t.keywords.length,
      postCount: t._count.posts,
      keywords: t.keywords,
    }));

    res.json({ success: true, data });
  } catch (error) {
    logger.error(`admin.listTags error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/tags — create a new tag (label required; slug auto-derived).
exports.createTag = async (req, res) => {
  try {
    const { label, description, isActive = true, sortOrder = 0 } = req.body || {};
    if (!label || typeof label !== 'string') {
      return res.status(400).json({ success: false, message: 'Label is required' });
    }
    const slug = req.body?.slug ? slugify(req.body.slug) : slugify(label);
    if (!slug) {
      return res.status(400).json({ success: false, message: 'Invalid tag label' });
    }

    const existing = await prisma.tag.findUnique({ where: { slug } });
    if (existing) {
      return res.status(409).json({ success: false, message: `Tag "${slug}" already exists` });
    }

    const tag = await prisma.tag.create({
      data: {
        slug,
        label: label.trim(),
        description: description?.trim() || null,
        isActive: !!isActive,
        sortOrder: Number.isFinite(+sortOrder) ? +sortOrder : 0,
      },
    });

    logger.info(`Admin created tag ${tag.slug} (id=${tag.id})`);
    res.status(201).json({ success: true, data: tag });
  } catch (error) {
    logger.error(`admin.createTag error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/admin/tags/:id — edit label, description, active, sortOrder.
// Slug is deliberately not editable (it's referenced by existing posts).
exports.updateTag = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { label, description, isActive, sortOrder } = req.body || {};

    const data = {};
    if (label !== undefined) data.label = String(label).trim();
    if (description !== undefined) data.description = description ? String(description).trim() : null;
    if (isActive !== undefined) data.isActive = !!isActive;
    if (sortOrder !== undefined && Number.isFinite(+sortOrder)) data.sortOrder = +sortOrder;

    const tag = await prisma.tag.update({ where: { id }, data });
    logger.info(`Admin updated tag ${id}`);
    res.json({ success: true, data: tag });
  } catch (error) {
    logger.error(`admin.updateTag error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/tags/:id — removes the tag (cascades to keywords + post_tags).
exports.deleteTag = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.tag.delete({ where: { id } });
    logger.info(`Admin deleted tag ${id}`);
    res.json({ success: true, message: 'Tag deleted' });
  } catch (error) {
    logger.error(`admin.deleteTag error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/tags/:id/keywords — add one keyword to a tag.
// body: { keyword: string } — lowercased and deduped via the unique constraint.
exports.addKeyword = async (req, res) => {
  try {
    const tagId = parseInt(req.params.id);
    const raw = (req.body?.keyword || '').toString().trim().toLowerCase();
    if (!raw) {
      return res.status(400).json({ success: false, message: 'Keyword is required' });
    }

    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });

    // upsert-style: if the keyword already exists on this tag we return the
    // existing row rather than erroring — admins adding the same word twice
    // shouldn't get a failure.
    const kw = await prisma.tagKeyword.upsert({
      where: { tagId_keyword: { tagId, keyword: raw } },
      create: { tagId, keyword: raw },
      update: {},
    });

    logger.info(`Admin added keyword "${raw}" to tag ${tagId}`);
    res.status(201).json({ success: true, data: kw });
  } catch (error) {
    logger.error(`admin.addKeyword error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/admin/keywords/:keywordId — remove a single keyword row.
exports.deleteKeyword = async (req, res) => {
  try {
    const id = parseInt(req.params.keywordId);
    await prisma.tagKeyword.delete({ where: { id } });
    logger.info(`Admin deleted keyword ${id}`);
    res.json({ success: true, message: 'Keyword removed' });
  } catch (error) {
    logger.error(`admin.deleteKeyword error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/admin/posts/:id/tags — manual override of tags on a post.
// body: { slugs: string[], mode?: "override" | "replace", rescan?: boolean }
//   - override (default): replace manual rows; keep auto rows that don't conflict
//   - replace: wipe both manual + auto and set only the given slugs
//   - rescan: also re-run keyword detection on the post content first
exports.setPostTags = async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { slugs = [], mode = 'override', rescan = false } = req.body || {};

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, content: true },
    });
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });

    if (rescan) await applyAutoTagsForPost(postId, post.content);
    await setManualTagsForPost(postId, slugs, mode);

    const updated = await prisma.postTag.findMany({
      where: { postId },
      include: { tag: { select: { id: true, slug: true, label: true } } },
    });

    logger.info(`Admin set tags on post ${postId}: [${slugs.join(',')}] mode=${mode}`);
    res.json({
      success: true,
      data: {
        postId,
        tags: updated.map(pt => ({ slug: pt.tag.slug, label: pt.tag.label, source: pt.source })),
      },
    });
  } catch (error) {
    logger.error(`admin.setPostTags error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/posts/:id/tags — used by the "edit tags" modal to prefill.
exports.getPostTags = async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const rows = await prisma.postTag.findMany({
      where: { postId },
      include: { tag: { select: { id: true, slug: true, label: true } } },
    });
    res.json({
      success: true,
      data: rows.map(pt => ({
        id: pt.id,
        slug: pt.tag.slug,
        label: pt.tag.label,
        source: pt.source,
      })),
    });
  } catch (error) {
    logger.error(`admin.getPostTags error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
