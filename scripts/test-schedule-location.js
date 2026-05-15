require('dotenv').config();
const { syncSchedule } = require('../src/services/golfSyncService');

async function testScheduleLocation() {
  try {
    console.log('Testing schedule sync to check location data...\n');
    await syncSchedule(2026);
    console.log('\nCheck the logs above to see the location structure');
  } catch (error) {
    console.error('Error:', error.message);
  }
  process.exit(0);
}

testScheduleLocation();
