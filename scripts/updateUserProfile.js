const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function updateUserProfile() {
  try {
    console.log('Updating user profile...');

    const user = await prisma.user.findUnique({
      where: { email: 'tufan.mandal@highoninnovation.com' },
      include: { profile: true },
    });

    if (user && user.profile) {
      await prisma.userProfile.update({
        where: { id: user.profile.id },
        data: {
          name: 'Tufan Mandal',
          country: 'India',
        },
      });
      console.log('✓ Profile updated: name=Tufan Mandal, country=India');
    } else {
      console.log('User or profile not found');
    }

  } catch (error) {
    console.error('Update failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

updateUserProfile();
