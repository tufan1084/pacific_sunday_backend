# Profile Privacy System - Database Migration

## Overview
This migration adds Instagram-like profile privacy features to the platform.

## Changes
1. Adds `isPrivate` boolean field to users table (default: false)
2. Creates `follow_requests` table with status tracking (pending/accepted/rejected)
3. Adds new notification types for follow requests

## Running the Migration

### Option 1: Using Prisma Migrate (Recommended)
```bash
cd backend
npx prisma migrate dev --name add_profile_privacy
npx prisma generate
```

### Option 2: Manual SQL Execution
If you prefer to run the SQL directly:

```bash
cd backend
psql $DATABASE_URL -f prisma/migrations/add_profile_privacy/migration.sql
npx prisma generate
```

### Option 3: Using Prisma DB Push (Development Only)
```bash
cd backend
npx prisma db push
npx prisma generate
```

## Verification

After running the migration, verify the changes:

```sql
-- Check users table has isPrivate column
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'isPrivate';

-- Check follow_requests table exists
SELECT table_name 
FROM information_schema.tables 
WHERE table_name = 'follow_requests';

-- Check indexes
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'follow_requests';
```

## Rollback (if needed)

If you need to rollback this migration:

```sql
-- Drop follow_requests table
DROP TABLE IF EXISTS "follow_requests" CASCADE;

-- Remove isPrivate column
ALTER TABLE "users" DROP COLUMN IF EXISTS "isPrivate";
```

## Post-Migration Steps

1. Restart the backend server to load new Prisma client
2. Test the follow request flow:
   - Set a user profile to private
   - Try following from another account
   - Accept/reject requests
   - Verify privacy enforcement

## API Endpoints Added

- `POST /users/:userId/follow` - Send follow request (private) or follow directly (public)
- `DELETE /users/:userId/follow` - Unfollow or cancel request
- `GET /users/follow-requests` - Get pending follow requests
- `POST /users/follow-requests/:requestId/accept` - Accept follow request
- `POST /users/follow-requests/:requestId/reject` - Reject follow request
- `DELETE /users/:userId/follower` - Remove a follower
- `PATCH /profile/privacy` - Toggle profile privacy

## Frontend Components Added

- `FollowRequestsDropdown.tsx` - Header dropdown for managing follow requests
- `PrivacySettings.tsx` - Privacy toggle in profile settings
- Updated user profile page with privacy UI

## Notes

- All existing users will have `isPrivate = false` by default (public profiles)
- Follow requests are only created for private profiles
- When a user switches from private to public, existing pending requests remain but new follows are direct
- Accepted follow requests create a Follow relationship
- Rejected requests can be resent by the requester
