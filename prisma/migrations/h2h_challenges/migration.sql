-- ─── Head-to-Head Challenges ────────────────────────────────────────────────

-- AlterEnum: add H2H notification types
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_OPPONENT_LOCKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_FIELD_AVAILABLE';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'H2H_CHALLENGE_RESULT';

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'LOCKED',
  'LIVE',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
  'REFUNDED'
);

-- AlterTable: held balance for open challenges
ALTER TABLE "user_points_wallets"
  ADD COLUMN IF NOT EXISTS "heldBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: tournament-level H2H multiplier (admin-controlled)
ALTER TABLE "tournaments"
  ADD COLUMN IF NOT EXISTS "h2hMultiplier" DOUBLE PRECISION DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "h2hBonusDescription" TEXT;

-- CreateTable: challenges
CREATE TABLE "challenges" (
    "id" SERIAL NOT NULL,
    "challengerId" INTEGER NOT NULL,
    "opponentId" INTEGER NOT NULL,
    "tournamentId" INTEGER NOT NULL,
    "wager" INTEGER NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "effectiveWager" INTEGER NOT NULL,
    "trashTalk" TEXT,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "challengerLockedAt" TIMESTAMP(3),
    "opponentLockedAt" TIMESTAMP(3),
    "challengerStrokes" INTEGER,
    "opponentStrokes" INTEGER,
    "winnerId" INTEGER,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "challenges_challengerId_status_idx" ON "challenges"("challengerId", "status");
CREATE INDEX "challenges_opponentId_status_idx"   ON "challenges"("opponentId", "status");
CREATE INDEX "challenges_tournamentId_status_idx" ON "challenges"("tournamentId", "status");

ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challengerId_fkey"
  FOREIGN KEY ("challengerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_opponentId_fkey"
  FOREIGN KEY ("opponentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_winnerId_fkey"
  FOREIGN KEY ("winnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_tournamentId_fkey"
  FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: challenge_picks
CREATE TABLE "challenge_picks" (
    "id" SERIAL NOT NULL,
    "challengeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "playerIds" JSONB NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),

    CONSTRAINT "challenge_picks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "challenge_picks_challengeId_userId_key" ON "challenge_picks"("challengeId", "userId");
CREATE INDEX "challenge_picks_userId_idx" ON "challenge_picks"("userId");

ALTER TABLE "challenge_picks" ADD CONSTRAINT "challenge_picks_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "challenge_picks" ADD CONSTRAINT "challenge_picks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
