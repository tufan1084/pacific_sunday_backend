const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanupDuplicateReactions() {
  console.log('Starting cleanup of duplicate reactions...');

  try {
    // Get all reactions grouped by messageId and userId
    const reactions = await prisma.messageReaction.findMany({
      orderBy: [
        { messageId: 'asc' },
        { userId: 'asc' },
        { createdAt: 'desc' } // Keep the most recent one
      ]
    });

    const seen = new Set();
    const toDelete = [];

    for (const reaction of reactions) {
      const key = `${reaction.messageId}-${reaction.userId}`;
      
      if (seen.has(key)) {
        // This is a duplicate, mark for deletion
        toDelete.push(reaction.id);
      } else {
        // First occurrence, keep it
        seen.add(key);
      }
    }

    if (toDelete.length > 0) {
      console.log(`Found ${toDelete.length} duplicate reactions to delete`);
      
      await prisma.messageReaction.deleteMany({
        where: {
          id: { in: toDelete }
        }
      });
      
      console.log(`Successfully deleted ${toDelete.length} duplicate reactions`);
    } else {
      console.log('No duplicate reactions found');
    }

  } catch (error) {
    console.error('Error cleaning up reactions:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

cleanupDuplicateReactions();
