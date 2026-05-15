const { prisma } = require('./src/config/db');

async function checkAutoAwardSetup() {
  try {
    console.log('\n=== Checking Auto-Award Setup ===\n');
    
    const year = new Date().getFullYear();
    
    // Check all completed tournaments
    const completed = await prisma.tournament.findMany({
      where: { 
        year,
        status: 'completed'
      },
      orderBy: { endDate: 'desc' },
      select: {
        id: true,
        tournId: true,
        name: true,
        status: true,
        endDate: true,
        lastSyncedAt: true,
        _count: {
          select: {
            picks: {
              where: {
                lockedAt: { not: null },
                pointsAwarded: null
              }
            }
          }
        }
      }
    });
    
    console.log(`Total completed tournaments: ${completed.length}\n`);
    
    for (const t of completed) {
      const pendingAwards = t._count.picks;
      const status = pendingAwards > 0 ? '⚠️  PENDING' : '✓ AWARDED';
      
      console.log(`${status} - ${t.name}`);
      console.log(`  TournId: ${t.tournId}`);
      console.log(`  Ended: ${t.endDate}`);
      console.log(`  Last Synced: ${t.lastSyncedAt}`);
      console.log(`  Pending awards: ${pendingAwards}\n`);
    }
    
    // Check when the cron job runs
    console.log('=== Cron Job Schedule ===');
    console.log('The system should automatically award points when:');
    console.log('1. Tournament status changes to "completed"');
    console.log('2. Weekly cron runs (Monday 8am ET)');
    console.log('3. Manual trigger via /api/golf/sync/all-completed-leaderboards\n');
    
    // Check if there are any tournaments that ended recently but not synced
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    
    const recentlyEnded = completed.filter(t => {
      const endDate = new Date(t.endDate);
      return endDate >= twoDaysAgo && endDate <= now;
    });
    
    if (recentlyEnded.length > 0) {
      console.log('=== Recently Ended Tournaments ===');
      recentlyEnded.forEach(t => {
        const hoursSinceEnd = Math.floor((now - new Date(t.endDate)) / (1000 * 60 * 60));
        console.log(`${t.name}: ended ${hoursSinceEnd} hours ago`);
      });
      console.log();
    }
    
    console.log('=== Recommendation ===');
    if (completed.some(t => t._count.picks > 0)) {
      console.log('⚠️  Some tournaments have pending point awards.');
      console.log('Run: node diagnose-points.js');
      console.log('Or manually trigger: POST /api/golf/sync/all-completed-leaderboards');
    } else {
      console.log('✓ All completed tournaments have been awarded points.');
    }
    console.log();
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkAutoAwardSetup();
