/**
 * clean-test-data.js
 * Deletes all user/social/test data while preserving:
 *   - Tournament, Player, TournamentPlayer (player/field data)
 *   - BagType (bag templates)
 *   - AchievementChallenge (challenge definitions)
 *   - PointsRange (points config)
 *   - Admin, SmtpConfig, GolfSettings (system config)
 *   - Tag, TagKeyword (tags)
 */

const { prisma } = require('../src/config/db');

async function cleanTestData() {
  console.log('Starting cleanup — preserving tournament/player data...\n');

  // Delete in dependency order (children before parents)

  // Messages
  const msgReactions = await prisma.messageReaction.deleteMany({});
  console.log(`Deleted ${msgReactions.count} message reactions`);

  const msgDeliveries = await prisma.messageDelivery.deleteMany({});
  console.log(`Deleted ${msgDeliveries.count} message deliveries`);

  const messages = await prisma.message.deleteMany({});
  console.log(`Deleted ${messages.count} messages`);

  const convParticipants = await prisma.conversationParticipant.deleteMany({});
  console.log(`Deleted ${convParticipants.count} conversation participants`);

  const conversations = await prisma.conversation.deleteMany({});
  console.log(`Deleted ${conversations.count} conversations`);

  // Posts & social
  const hiddenPosts = await prisma.hiddenPost.deleteMany({});
  console.log(`Deleted ${hiddenPosts.count} hidden posts`);

  const savedPosts = await prisma.savedPost.deleteMany({});
  console.log(`Deleted ${savedPosts.count} saved posts`);

  const savedCategories = await prisma.savedPostCategory.deleteMany({});
  console.log(`Deleted ${savedCategories.count} saved post categories`);

  const postTags = await prisma.postTag.deleteMany({});
  console.log(`Deleted ${postTags.count} post tags`);

  const postReports = await prisma.postReport.deleteMany({});
  console.log(`Deleted ${postReports.count} post reports`);

  const postPins = await prisma.userPostPin.deleteMany({});
  console.log(`Deleted ${postPins.count} post pins`);

  const postComments = await prisma.postComment.deleteMany({});
  console.log(`Deleted ${postComments.count} post comments`);

  const postLikes = await prisma.postLike.deleteMany({});
  console.log(`Deleted ${postLikes.count} post likes`);

  const posts = await prisma.post.deleteMany({});
  console.log(`Deleted ${posts.count} posts`);

  // Teams
  const teamInvites = await prisma.teamInvite.deleteMany({});
  console.log(`Deleted ${teamInvites.count} team invites`);

  const teamJoinRequests = await prisma.teamJoinRequest.deleteMany({});
  console.log(`Deleted ${teamJoinRequests.count} team join requests`);

  const teamMembers = await prisma.teamMember.deleteMany({});
  console.log(`Deleted ${teamMembers.count} team members`);

  const teams = await prisma.team.deleteMany({});
  console.log(`Deleted ${teams.count} teams`);

  // H2H Challenges
  const challengePicks = await prisma.challengePick.deleteMany({});
  console.log(`Deleted ${challengePicks.count} challenge picks`);

  const challenges = await prisma.challenge.deleteMany({});
  console.log(`Deleted ${challenges.count} H2H challenges`);

  // Fantasy picks (user picks only — NOT tournament/player data)
  const userPicks = await prisma.userPick.deleteMany({});
  console.log(`Deleted ${userPicks.count} user fantasy picks`);

  // Points
  const pointsTransactions = await prisma.pointsTransaction.deleteMany({});
  console.log(`Deleted ${pointsTransactions.count} points transactions`);

  const pointsWallets = await prisma.userPointsWallet.deleteMany({});
  console.log(`Deleted ${pointsWallets.count} points wallets`);

  // Rewards
  const rewardRedemptions = await prisma.rewardRedemption.deleteMany({});
  console.log(`Deleted ${rewardRedemptions.count} reward redemptions`);

  // Achievements (user completions only — NOT challenge definitions)
  const challengeCompletions = await prisma.userChallengeCompletion.deleteMany({});
  console.log(`Deleted ${challengeCompletions.count} challenge completions`);

  // Referrals
  const referrals = await prisma.referral.deleteMany({});
  console.log(`Deleted ${referrals.count} referrals`);

  // Notifications
  const notifications = await prisma.notification.deleteMany({});
  console.log(`Deleted ${notifications.count} notifications`);

  // Follows
  const followRequests = await prisma.followRequest.deleteMany({});
  console.log(`Deleted ${followRequests.count} follow requests`);

  const follows = await prisma.follow.deleteMany({});
  console.log(`Deleted ${follows.count} follows`);

  // Announcements dismissals
  const dismissals = await prisma.dismissedAnnouncement.deleteMany({});
  console.log(`Deleted ${dismissals.count} dismissed announcements`);

  // OTPs
  const resetOtps = await prisma.passwordResetOtp.deleteMany({});
  console.log(`Deleted ${resetOtps.count} password reset OTPs`);

  const emailOtps = await prisma.emailVerificationOtp.deleteMany({});
  console.log(`Deleted ${emailOtps.count} email verification OTPs`);

  // Bags (unregister — keep bag types)
  const scans = await prisma.scan.deleteMany({});
  console.log(`Deleted ${scans.count} bag scans`);

  // Reset bags to unregistered state (keep the bag records for NFC chips)
  const bagsReset = await prisma.bag.updateMany({
    data: {
      registered: false,
      userId: null,
      registeredAt: null,
      tapCount: 0,
      lastTappedAt: null,
    },
  });
  console.log(`Reset ${bagsReset.count} bags to unregistered`);

  // User profiles & golf passports
  const golfPassports = await prisma.golfPassport.deleteMany({});
  console.log(`Deleted ${golfPassports.count} golf passports`);

  const userProfiles = await prisma.userProfile.deleteMany({});
  console.log(`Deleted ${userProfiles.count} user profiles`);

  // Users
  const users = await prisma.user.deleteMany({});
  console.log(`Deleted ${users.count} users`);

  console.log('\n✅ Cleanup complete!');
  console.log('✅ Preserved: Tournament, Player, TournamentPlayer, BagType, AchievementChallenge, PointsRange, Admin, SmtpConfig, GolfSettings, Tag, TagKeyword');

  await prisma.$disconnect();
}

cleanTestData().catch((e) => {
  console.error('❌ Cleanup failed:', e.message);
  prisma.$disconnect();
  process.exit(1);
});
