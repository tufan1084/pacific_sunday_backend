const { prisma } = require('./src/config/db');

async function testGolfSettings() {
  try {
    console.log('Testing Golf Settings...');
    
    // Try to get or create settings
    let settings = await prisma.golfSettings.findFirst();
    
    if (!settings) {
      console.log('Creating default golf settings...');
      settings = await prisma.golfSettings.create({
        data: {
          leaderboardSyncInterval: 15,
          enabled: true
        }
      });
      console.log('Created:', settings);
    } else {
      console.log('Existing settings:', settings);
    }
    
    console.log('✓ Golf settings working correctly');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

testGolfSettings();
