const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// Return the Tag slugs whose keywords appear in the given text.
// Keywords match on word boundaries (case-insensitive) so e.g. "club"
// doesn't match "clubhouse" unless "clubhouse" is its own keyword.
async function detectTagSlugs(content) {
  if (!content || typeof content !== 'string') return [];

  const keywords = await prisma.tagKeyword.findMany({
    where: { tag: { isActive: true } },
    select: { keyword: true, tag: { select: { slug: true } } },
  });

  const lower = content.toLowerCase();
  const matched = new Set();
  for (const { keyword, tag } of keywords) {
    const kw = (keyword || '').toLowerCase().trim();
    if (!kw) continue;
    const re = new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(kw)}(?:[^a-z0-9_]|$)`, 'i');
    if (re.test(lower)) matched.add(tag.slug);
  }
  return Array.from(matched);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Look up tag ids for an array of slugs (ignoring unknown/inactive).
async function tagIdsFromSlugs(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return [];
  const tags = await prisma.tag.findMany({
    where: { slug: { in: slugs }, isActive: true },
    select: { id: true },
  });
  return tags.map(t => t.id);
}

// Run keyword detection against the post content and persist the result
// as PostTag rows with source="auto". Wipes any existing auto rows first so
// edits stay in sync; manual rows are preserved.
async function applyAutoTagsForPost(postId, content) {
  try {
    const slugs = await detectTagSlugs(content);
    const tagIds = await tagIdsFromSlugs(slugs);

    await prisma.postTag.deleteMany({ where: { postId, source: 'auto' } });
    if (tagIds.length === 0) return [];

    // Skip tags that already have a manual override for this post —
    // manual wins over auto.
    const existingManual = await prisma.postTag.findMany({
      where: { postId, source: 'manual' },
      select: { tagId: true },
    });
    const manualSet = new Set(existingManual.map(r => r.tagId));

    const toInsert = tagIds
      .filter(id => !manualSet.has(id))
      .map(tagId => ({ postId, tagId, source: 'auto' }));

    if (toInsert.length > 0) {
      await prisma.postTag.createMany({ data: toInsert, skipDuplicates: true });
    }
    return slugs;
  } catch (error) {
    logger.error(`applyAutoTagsForPost error (postId=${postId}): ${error.message}`);
    return [];
  }
}

// Replace the manual tags on a post with the given slug list.
// `mode` controls what happens to auto tags:
//   - "override": keep auto rows untouched
//   - "replace":  also delete auto rows (admin took full control)
async function setManualTagsForPost(postId, slugs, mode = 'override') {
  const tagIds = await tagIdsFromSlugs(slugs || []);

  await prisma.postTag.deleteMany({ where: { postId, source: 'manual' } });
  if (mode === 'replace') {
    await prisma.postTag.deleteMany({ where: { postId, source: 'auto' } });
  } else {
    // Drop any auto rows that conflict with new manual rows so we end up with
    // exactly one row per (post, tag) and the source reflects admin intent.
    if (tagIds.length > 0) {
      await prisma.postTag.deleteMany({
        where: { postId, tagId: { in: tagIds }, source: 'auto' },
      });
    }
  }

  if (tagIds.length > 0) {
    await prisma.postTag.createMany({
      data: tagIds.map(tagId => ({ postId, tagId, source: 'manual' })),
      skipDuplicates: true,
    });
  }
}

// Shape used when returning a post to the client — flat list of slugs.
function serializePostTags(post) {
  if (!post || !Array.isArray(post.tags)) return [];
  return post.tags.map(pt => pt.tag?.slug).filter(Boolean);
}

module.exports = {
  detectTagSlugs,
  applyAutoTagsForPost,
  setManualTagsForPost,
  serializePostTags,
};
