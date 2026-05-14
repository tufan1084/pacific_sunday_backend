-- Add optional team avatar/thumbnail column.
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
