const { prisma } = require('./src/config/db');
const sync = require('./src/services/golfSyncService');
const logger = require('./src/config/logger');

async function fixCompletedTournaments() {
  try {
    const year = new Date().getFullYear();
    console.log(`\nFetching completed tournaments for ${year}...`);
    
    const completed = await prisma.tournament.findMany({
      where: { 
        year,
        status: 'completed'
      },
      orderBy: { startDate: 'desc' }
    });
    
    console.log(`Found ${completed.length} completed tournaments\n`);
    
    if (completed.length === 0) {
      console.log('No completed tournaments to sync');
      process.exit(0);
    }
    
    let synced = 0;
    let failed = 0;
    
    for (const t of completed) {
      try {
        console.log(`Syncing: ${t.name} (${t.tournId}/${t.year})...`);
        await sync.syncLeaderboard(t.tournId, t.year);
        synced++;
        console.log(`✓ Success\n`);
      } catch (err) {
        failed++;
        console.error(`✗ Failed: ${err.message}\n`);
      }
    }
    
    console.log(`\n=== Summary ===`);
    console.log(`Total: ${completed.length}`);
    console.log(`Synced: ${synced}`);
    console.log(`Failed: ${failed}`);
    
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

fixCompletedTournaments();
