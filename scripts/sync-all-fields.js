const axios = require('axios');

const API_BASE = process.env.API_URL || 'http://localhost:5000';

async function syncAllUpcomingFields() {
  try {
    console.log('Fetching tournaments...');
    const { data } = await axios.get(`${API_BASE}/api/golf/tournaments?year=2025`);
    
    if (!data.success) {
      console.error('Failed to fetch tournaments:', data.message);
      return;
    }

    const upcoming = data.data.upcoming || [];
    console.log(`Found ${upcoming.length} upcoming tournaments\n`);

    for (const tournament of upcoming) {
      console.log(`Syncing: ${tournament.name} (${tournament.tournId})`);
      
      try {
        const syncRes = await axios.post(
          `${API_BASE}/api/golf/sync/field?tournId=${tournament.tournId}&year=${tournament.year}`
        );
        
        if (syncRes.data.success) {
          console.log(`✓ Success: ${syncRes.data.result} players synced`);
        } else {
          console.log(`✗ Failed: ${syncRes.data.message}`);
        }
      } catch (err) {
        console.log(`✗ Error: ${err.response?.data?.message || err.message}`);
      }
      
      console.log('');
    }

    console.log('Done!');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

syncAllUpcomingFields();
