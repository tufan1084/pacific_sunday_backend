-- AlterTable
ALTER TABLE "users" ADD COLUMN "username" TEXT;

-- Create unique index on username
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- Generate usernames for existing users (if any)
-- This uses email prefix as base username with random suffix
UPDATE "users" 
SET "username" = CONCAT(
  LOWER(REGEXP_REPLACE(SPLIT_PART(email, '@', 1), '[^a-z0-9]', '', 'g')),
  FLOOR(1000 + RANDOM() * 9000)::TEXT
)
WHERE "username" IS NULL;

-- Make username NOT NULL after populating existing records
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
