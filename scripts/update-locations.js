require('dotenv').config();
const { syncFieldAndTiers } = require('../src/services/golfSyncService');

async function updateLocations() {
  try {
    console.log('Updating tournament locations...\n');
    
    // Sync the two tournaments we have cached data for
    const tournaments = [
      { tournId: '553', year: 2026, name: 'ONEflight Myrtle Beach Classic' },
      { tournId: '480', year: 2026, name: 'Truist Championship' }
    ];
    
    for (const t of tournaments) {
      console.log(`Syncing ${t.name}...`);
      try {
        await syncFieldAndTiers(t.tournId, t.year);
        console.log(`✓ Success\n`);
      } catch (err) {
        console.log(`✗ Error: ${err.message}\n`);
      }
    }
    
    console.log('Done! Location data should now be populated.');
  } catch (error) {
    console.error('Error:', error.message);
  }
  process.exit(0);
}

updateLocations();
