const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function updateExistingUsernames() {
  try {
    const users = await prisma.user.findMany({
      include: { profile: true }
    });

    for (const user of users) {
      const name = user.profile?.name || user.email.split('@')[0];
      const baseUsername = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const username = `${baseUsername}${randomSuffix}`;

      await prisma.user.update({
        where: { id: user.id },
        data: { username }
      });

      console.log(`Updated user ${user.id} with username: ${username}`);
    }

    console.log('All users updated successfully');
  } catch (error) {
    console.error('Error updating usernames:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateExistingUsernames();
