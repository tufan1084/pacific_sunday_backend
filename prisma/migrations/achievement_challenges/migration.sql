-- CreateEnum
CREATE TYPE "ChallengeTrigger" AS ENUM (
  'bag_registered',
  'profile_completed',
  'h2h_won',
  'reward_redeemed',
  'nfc_tap_5x_month',
  'referral'
);

-- CreateTable
CREATE TABLE "achievement_challenges" (
  "id"          SERIAL NOT NULL,
  "triggerType" "ChallengeTrigger" NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "points"      INTEGER NOT NULL,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "achievement_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "achievement_challenges_triggerType_key"
  ON "achievement_challenges"("triggerType");

-- CreateTable
CREATE TABLE "user_challenge_completions" (
  "id"          SERIAL NOT NULL,
  "userId"      INTEGER NOT NULL,
  "challengeId" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_challenge_completions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_challenge_completions_userId_challengeId_key"
  ON "user_challenge_completions"("userId", "challengeId");

CREATE INDEX "user_challenge_completions_userId_idx"
  ON "user_challenge_completions"("userId");

ALTER TABLE "user_challenge_completions"
  ADD CONSTRAINT "user_challenge_completions_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "achievement_challenges"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "referrals" (
  "id"             SERIAL NOT NULL,
  "referrerId"     INTEGER NOT NULL,
  "referredUserId" INTEGER NOT NULL,
  "code"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referrals_referredUserId_key"
  ON "referrals"("referredUserId");

CREATE INDEX "referrals_referrerId_idx"
  ON "referrals"("referrerId");

-- CreateTable
CREATE TABLE "reward_redemptions" (
  "id"         SERIAL NOT NULL,
  "userId"     INTEGER NOT NULL,
  "rewardName" TEXT NOT NULL,
  "pointsCost" INTEGER NOT NULL,
  "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reward_redemptions_userId_redeemedAt_idx"
  ON "reward_redemptions"("userId", "redeemedAt");

-- Seed the 6 fixed challenges
INSERT INTO "achievement_challenges" ("triggerType", "title", "description", "points", "isActive", "updatedAt") VALUES
  ('bag_registered',    'First Bag Owner',  'Register your first bag',                       100, true, CURRENT_TIMESTAMP),
  ('profile_completed', 'Profile Complete', 'Complete your profile',                          50, true, CURRENT_TIMESTAMP),
  ('h2h_won',           'First Victory',    'Win your first Head-to-Head',                   150, true, CURRENT_TIMESTAMP),
  ('reward_redeemed',   'Reward Hunter',    'Redeem your first reward',                       75, true, CURRENT_TIMESTAMP),
  ('nfc_tap_5x_month',  'NFC Tapper',       'Tap your NFC bag 5 times this month',            80, true, CURRENT_TIMESTAMP),
  ('referral',          'Refer a Friend',   'Invite a friend who joins the platform',        200, true, CURRENT_TIMESTAMP)
ON CONFLICT ("triggerType") DO NOTHING;
