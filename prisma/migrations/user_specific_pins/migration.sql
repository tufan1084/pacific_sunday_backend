-- CreateTable
CREATE TABLE "user_post_pins" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_post_pins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_post_pins_userId_idx" ON "user_post_pins"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_post_pins_postId_userId_key" ON "user_post_pins"("postId", "userId");

-- AddForeignKey
ALTER TABLE "user_post_pins" ADD CONSTRAINT "user_post_pins_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "posts" DROP COLUMN "isPinned";
