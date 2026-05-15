const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function migrateUserData() {
  try {
    console.log('Starting user data migration...');

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        profile: true,
      },
    });

    console.log(`Found ${users.length} users`);

    for (const user of users) {
      if (!user.profile) {
        console.log(`Creating profile for user ${user.id} (${user.email})`);
        
        await prisma.userProfile.create({
          data: {
            userId: user.id,
            name: user.email.split('@')[0],
            country: null,
          },
        });
        
        console.log(`✓ Profile created for user ${user.id}`);
      } else {
        console.log(`✓ User ${user.id} already has a profile`);
      }
    }

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

migrateUserData();
