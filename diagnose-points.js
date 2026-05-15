const { prisma } = require('./src/config/db');
const pointsService = require('./src/services/pointsService');

async function diagnoseLastTournament() {
  try {
    const year = new Date().getFullYear();
    
    console.log('\n=== Checking Last Completed Tournament ===\n');
    
    // Get the last completed tournament
    const lastCompleted = await prisma.tournament.findFirst({
      where: { 
        year,
        status: 'completed'
      },
      orderBy: { endDate: 'desc' }
    });
    
    if (!lastCompleted) {
      console.log('No completed tournaments found');
      return;
    }
    
    console.log(`Tournament: ${lastCompleted.name}`);
    console.log(`ID: ${lastCompleted.id}`);
    console.log(`TournId: ${lastCompleted.tournId}`);
    console.log(`Status: ${lastCompleted.status}`);
    console.log(`End Date: ${lastCompleted.endDate}`);
    console.log(`Last Synced: ${lastCompleted.lastSyncedAt}\n`);
    
    // Check leaderboard data
    const leaderboard = lastCompleted.leaderboard?.rows || [];
    console.log(`Leaderboard rows: ${leaderboard.length}`);
    if (leaderboard.length > 0) {
      console.log(`Sample player: ${leaderboard[0].name} - Score: ${leaderboard[0].score}`);
      console.log(`Rounds: ${JSON.stringify(leaderboard[0].rounds)}\n`);
    } else {
      console.log('⚠️  NO LEADERBOARD DATA!\n');
    }
    
    // Check locked picks
    const lockedPicks = await prisma.userPick.findMany({
      where: { 
        tournamentId: lastCompleted.id,
        lockedAt: { not: null }
      },
      include: {
        tournament: { select: { name: true } }
      }
    });
    
    console.log(`Locked picks: ${lockedPicks.length}`);
    
    if (lockedPicks.length === 0) {
      console.log('⚠️  NO LOCKED PICKS - Users need to lock their teams before tournament starts!\n');
      return;
    }
    
    // Check which picks have been awarded
    const awarded = lockedPicks.filter(p => p.pointsAwarded !== null);
    const pending = lockedPicks.filter(p => p.pointsAwarded === null);
    
    console.log(`Already awarded: ${awarded.length}`);
    console.log(`Pending award: ${pending.length}\n`);
    
    if (awarded.length > 0) {
      console.log('Sample awarded pick:');
      console.log(`  User ID: ${awarded[0].userId}`);
      console.log(`  Points: ${awarded[0].pointsAwarded}`);
      console.log(`  Calculated at: ${awarded[0].pointsCalculatedAt}\n`);
    }
    
    if (pending.length > 0) {
      console.log('Sample pending pick:');
      console.log(`  User ID: ${pending[0].userId}`);
      console.log(`  Locked at: ${pending[0].lockedAt}`);
      console.log(`  Picks: ${JSON.stringify(pending[0].picks)}\n`);
    }
    
    // Check points ranges configuration
    const ranges = await prisma.pointsRange.findMany({
      where: { isActive: true },
      orderBy: { minScore: 'desc' }
    });
    
    console.log(`Active points ranges: ${ranges.length}`);
    if (ranges.length === 0) {
      console.log('⚠️  NO ACTIVE POINTS RANGES CONFIGURED!\n');
      console.log('You need to configure points ranges in the admin panel.\n');
    } else {
      console.log('Points ranges:');
      ranges.forEach(r => {
        console.log(`  ${r.name}: ${r.minScore} to ${r.maxScore} = ${r.points} points`);
      });
      console.log();
    }
    
    // Try to award points if pending
    if (pending.length > 0 && leaderboard.length > 0 && ranges.length > 0) {
      console.log('=== Attempting to Award Points ===\n');
      try {
        const result = await pointsService.awardTournamentPoints(lastCompleted.id);
        console.log(`✓ Success!`);
        console.log(`  Processed: ${result.processed}`);
        console.log(`  Skipped: ${result.skipped}`);
        
        if (result.results.length > 0) {
          console.log(`\nSample result:`);
          const sample = result.results[0];
          console.log(`  User ID: ${sample.userId}`);
          console.log(`  Total Points: ${sample.totalPoints}`);
          console.log(`  Player Scores: ${sample.playerScores.length}`);
        }
      } catch (error) {
        console.error(`✗ Failed: ${error.message}`);
        console.error(`Stack: ${error.stack}`);
      }
    } else {
      console.log('=== Cannot Award Points ===');
      if (pending.length === 0) console.log('  - All picks already awarded');
      if (leaderboard.length === 0) console.log('  - No leaderboard data');
      if (ranges.length === 0) console.log('  - No points ranges configured');
    }
    
    console.log('\n=== Diagnosis Complete ===\n');
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

diagnoseLastTournament();
