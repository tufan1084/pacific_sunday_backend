-- Hybrid post tagging: admin-curated Tags + per-tag Keywords drive auto-tagging;
-- PostTag links posts to tags with a source flag ("auto" | "manual"). Idempotent.

CREATE TABLE IF NOT EXISTS "tags" (
  "id"          SERIAL PRIMARY KEY,
  "slug"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "tags_slug_key" ON "tags"("slug");

CREATE TABLE IF NOT EXISTS "tag_keywords" (
  "id"        SERIAL PRIMARY KEY,
  "tagId"     INTEGER NOT NULL,
  "keyword"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tag_keywords_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "tag_keywords_tagId_keyword_key" ON "tag_keywords"("tagId", "keyword");
CREATE INDEX IF NOT EXISTS "tag_keywords_tagId_idx" ON "tag_keywords"("tagId");
CREATE INDEX IF NOT EXISTS "tag_keywords_keyword_idx" ON "tag_keywords"("keyword");

CREATE TABLE IF NOT EXISTS "post_tags" (
  "id"        SERIAL PRIMARY KEY,
  "postId"    INTEGER NOT NULL,
  "tagId"     INTEGER NOT NULL,
  "source"    TEXT NOT NULL DEFAULT 'auto',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "post_tags_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "post_tags_tagId_fkey"  FOREIGN KEY ("tagId")  REFERENCES "tags"("id")  ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "post_tags_postId_tagId_key" ON "post_tags"("postId", "tagId");
CREATE INDEX IF NOT EXISTS "post_tags_postId_idx" ON "post_tags"("postId");
CREATE INDEX IF NOT EXISTS "post_tags_tagId_idx" ON "post_tags"("tagId");

-- Seed the two built-in tabs so existing community UI continues to work.
INSERT INTO "tags" ("slug", "label", "sortOrder", "updatedAt")
VALUES
  ('fantasy_talk', 'Fantasy Talk', 1, CURRENT_TIMESTAMP),
  ('bag_flex',     'Bag Flex',     2, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- Seed starter keywords (match the old hardcoded TAG_KEYWORDS).
INSERT INTO "tag_keywords" ("tagId", "keyword")
SELECT t."id", kw
FROM "tags" t, unnest(ARRAY[
  'fantasy','picks','leaderboard','tier','pick','ranking','tournament','draft'
]) AS kw
WHERE t."slug" = 'fantasy_talk'
ON CONFLICT ("tagId", "keyword") DO NOTHING;

INSERT INTO "tag_keywords" ("tagId", "keyword")
SELECT t."id", kw
FROM "tags" t, unnest(ARRAY[
  'bag','gear','driver','iron','putter','club','wedge','shaft','grip','ball'
]) AS kw
WHERE t."slug" = 'bag_flex'
ON CONFLICT ("tagId", "keyword") DO NOTHING;
