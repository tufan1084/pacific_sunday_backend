const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addUsernameField() {
  try {
    console.log('Starting username migration...');

    // Step 1: Drop unique constraint if exists
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
    `);
    console.log('✓ Dropped existing constraint');

    // Step 2: Get all users and update with unique usernames
    const users = await prisma.$queryRaw`SELECT id, email FROM users WHERE username IS NULL OR username = ''`;
    
    for (const user of users) {
      const baseUsername = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const newUsername = `${baseUsername}${randomSuffix}`;
      
      await prisma.$executeRawUnsafe(`
        UPDATE users SET username = '${newUsername}' WHERE id = ${user.id}
      `);
      console.log(`✓ Updated user ${user.id} with username: ${newUsername}`);
    }

    // Step 3: Make username NOT NULL
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ALTER COLUMN username SET NOT NULL;
    `);
    console.log('✓ Set username as NOT NULL');

    // Step 4: Add unique constraint
    await prisma.$executeRawUnsafe(`
      ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
    `);
    console.log('✓ Added unique constraint');

    console.log('\n✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

addUsernameField();
