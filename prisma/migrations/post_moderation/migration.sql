-- Post moderation: isHidden flag + PostReport table (idempotent)

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "isHidden" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "PostReportStatus" AS ENUM ('pending', 'reviewed', 'dismissed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "post_reports" (
  "id"        SERIAL PRIMARY KEY,
  "postId"    INTEGER NOT NULL,
  "userId"    INTEGER NOT NULL,
  "reason"    TEXT NOT NULL,
  "details"   TEXT,
  "status"    "PostReportStatus" NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "post_reports_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "post_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "post_reports_postId_userId_key" ON "post_reports"("postId", "userId");
CREATE INDEX IF NOT EXISTS "post_reports_postId_idx" ON "post_reports"("postId");
CREATE INDEX IF NOT EXISTS "post_reports_status_idx" ON "post_reports"("status");
