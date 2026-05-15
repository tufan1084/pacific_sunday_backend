-- Step 1: Drop the unique constraint if it exists
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

-- Step 2: Update all existing users with unique usernames
DO $$
DECLARE
    user_record RECORD;
    base_username TEXT;
    new_username TEXT;
    random_suffix INT;
BEGIN
    FOR user_record IN SELECT id, email FROM users WHERE username IS NULL OR username = ''
    LOOP
        base_username := LOWER(REGEXP_REPLACE(SPLIT_PART(user_record.email, '@', 1), '[^a-z0-9]', '', 'g'));
        random_suffix := FLOOR(1000 + RANDOM() * 9000)::INT;
        new_username := base_username || random_suffix::TEXT;
        
        UPDATE users SET username = new_username WHERE id = user_record.id;
    END LOOP;
END $$;

-- Step 3: Make username NOT NULL
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- Step 4: Add unique constraint back
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
