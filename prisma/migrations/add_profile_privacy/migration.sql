-- Add isPrivate field to users table
ALTER TABLE "users" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;

-- Create follow_requests table
CREATE TABLE "follow_requests" (
    "id" SERIAL NOT NULL,
    "senderId" INTEGER NOT NULL,
    "receiverId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_requests_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint
CREATE UNIQUE INDEX "follow_requests_senderId_receiverId_key" ON "follow_requests"("senderId", "receiverId");

-- Create indexes
CREATE INDEX "follow_requests_receiverId_status_idx" ON "follow_requests"("receiverId", "status");
CREATE INDEX "follow_requests_senderId_idx" ON "follow_requests"("senderId");

-- Add foreign keys
ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
