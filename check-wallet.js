const { prisma } = require('./src/config/db');

async function checkUserWallet() {
  try {
    const userId = 2; // The user from the diagnostic
    
    console.log('\n=== Checking User Wallet ===\n');
    
    // Get wallet
    const wallet = await prisma.userPointsWallet.findUnique({
      where: { userId }
    });
    
    if (!wallet) {
      console.log('❌ No wallet found for user 2');
      return;
    }
    
    console.log('Wallet:');
    console.log(`  Balance: ${wallet.balance}`);
    console.log(`  Held Balance: ${wallet.heldBalance}`);
    console.log(`  Available: ${wallet.balance - wallet.heldBalance}`);
    console.log(`  Updated: ${wallet.updatedAt}\n`);
    
    // Get recent transactions
    const transactions = await prisma.pointsTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    
    console.log(`Recent Transactions: ${transactions.length}\n`);
    
    transactions.forEach(t => {
      console.log(`${t.createdAt.toISOString()}`);
      console.log(`  Type: ${t.type}`);
      console.log(`  Amount: ${t.amount > 0 ? '+' : ''}${t.amount}`);
      console.log(`  Description: ${t.description || 'N/A'}`);
      if (t.metadata) {
        console.log(`  Metadata: ${JSON.stringify(t.metadata)}`);
      }
      console.log();
    });
    
    // Check user picks
    const picks = await prisma.userPick.findMany({
      where: { userId },
      include: {
        tournament: {
          select: { name: true, tournId: true, status: true }
        }
      },
      orderBy: { submittedAt: 'desc' }
    });
    
    console.log(`\nUser Picks: ${picks.length}\n`);
    
    picks.forEach(p => {
      console.log(`${p.tournament.name} (${p.tournament.tournId})`);
      console.log(`  Status: ${p.tournament.status}`);
      console.log(`  Locked: ${p.lockedAt ? 'Yes' : 'No'}`);
      console.log(`  Points Awarded: ${p.pointsAwarded !== null ? p.pointsAwarded : 'PENDING'}`);
      console.log(`  Calculated At: ${p.pointsCalculatedAt || 'N/A'}`);
      console.log();
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUserWallet();
