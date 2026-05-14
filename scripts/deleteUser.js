/**
 * Permanently delete a user and ALL associated data.
 * Usage: node scripts/deleteUser.js <email_or_id>
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function deleteUser() {
  const [,, identifier] = process.argv;

  if (!identifier) {
    console.error('Usage: node scripts/deleteUser.js <email_or_id>');
    process.exit(1);
  }

  const userId = parseInt(identifier);
  const where = !isNaN(userId) ? { id: userId } : { email: identifier };

  const user = await prisma.user.findUnique({
    where,
    select: { id: true, email: true, username: true }
  });

  if (!user) {
    console.error('❌ User not found');
    process.exit(1);
  }

  const uid = user.id;
  console.log(`\nDeleting user: ${user.username} (${user.email}) [id=${uid}]\n`);

  try {
    // 1. Raw userId tables (no Prisma cascade)
    await prisma.userChallengeCompletion.deleteMany({ where: { userId: uid } });
    console.log('✅ userChallengeCompletion');

    await prisma.userPointsWallet.deleteMany({ where: { userId: uid } });
    console.log('✅ userPointsWallet');

    await prisma.rewardRedemption.deleteMany({ where: { userId: uid } });
    console.log('✅ rewardRedemption');

    await prisma.dismissedAnnouncement.deleteMany({ where: { userId: uid } });
    console.log('✅ dismissedAnnouncement');

    await prisma.referral.deleteMany({
      where: { OR: [{ referrerId: uid }, { referredUserId: uid }] }
    });
    console.log('✅ referral');

    await prisma.userPick.deleteMany({ where: { userId: uid } });
    console.log('✅ userPick');

    await prisma.passwordResetOtp.deleteMany({ where: { email: user.email } });
    await prisma.emailVerificationOtp.deleteMany({ where: { email: user.email } });
    console.log('✅ OTPs');

    // 2. Teams created by this user (cascades members, posts, invites, join requests)
    await prisma.team.deleteMany({ where: { creatorId: uid } });
    console.log('✅ teams (and cascaded data)');

    // 3. Golf passport + profile
    const profile = await prisma.userProfile.findUnique({ where: { userId: uid } });
    if (profile) {
      await prisma.golfPassport.deleteMany({ where: { profileId: profile.id } });
      await prisma.userProfile.delete({ where: { id: profile.id } });
      console.log('✅ profile + golf passport');
    }

    // 4. Delete user — cascades everything else
    await prisma.user.delete({ where: { id: uid } });
    console.log(`\n✅ User ${user.email} fully deleted.\n`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

deleteUser();
