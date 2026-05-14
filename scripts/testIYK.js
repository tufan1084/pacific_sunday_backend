require('dotenv').config();
const axios = require('axios');

const IYK_API_BASE = 'https://api.iyk.app';
const IYK_API_KEY = process.env.IYK_SESSION_KEY;

async function testIYKConnection() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           Testing IYK API Connection');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  console.log('API Base URL:', IYK_API_BASE);
  console.log('API Key:', IYK_API_KEY ? '✓ Found' : '✗ Missing');
  console.log('-----------------------------------\n');

  if (!IYK_API_KEY) {
    console.error('❌ IYK_SESSION_KEY not found in .env file');
    return;
  }

  const headers = {
    'x-iyk-api-key': IYK_API_KEY,
    'Content-Type': 'application/json'
  };

  // Test 1: GET /chips/find with sample params
  console.log('Test 1: GET /chips/find?e=XX&c=XX&d=XX\n');
  console.log('Testing with sample parameters...');
  
  try {
    // Using sample values with correct types
    const response = await axios.get(`${IYK_API_BASE}/chips/find`, {
      params: {
        e: 'test',
        c: 'test',
        d: 12345
      },
      headers
    });
    
    console.log('✅ SUCCESS - Endpoint exists!');
    console.log('Status:', response.status);
    console.log('Data:', JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    if (error.response) {
      console.log('Status:', error.response.status);
      
      if (error.response.status === 401 || error.response.status === 403) {
        console.log('❌ UNAUTHORIZED - API Key invalid');
        console.log('Error:', error.response.data);
      } else if (error.response.status === 404) {
        console.log('⚠️  Chip not found (expected with test params)');
        console.log('✅ But endpoint exists and API key works!');
        console.log('Error:', error.response.data);
      } else if (error.response.status === 400) {
        console.log('⚠️  Bad request - invalid parameters');
        console.log('✅ But endpoint exists and API key works!');
        console.log('Error:', error.response.data);
      } else {
        console.log('Response:', error.response.data);
      }
    } else {
      console.log('❌ Network Error:', error.message);
    }
  }

  console.log('\n-----------------------------------');
  console.log('\n📋 WHAT ARE e, c, d PARAMETERS?\n');
  console.log('These are likely chip identifiers from NFC scan:');
  console.log('  e = ? (possibly encryption/encoding)');
  console.log('  c = ? (possibly chip ID)');
  console.log('  d = ? (possibly data/signature)\n');
  console.log('When user scans NFC tag, the tag URL contains these params.');
  console.log('Example: https://your-app.com/scan?e=abc&c=123&d=xyz\n');
  console.log('Your frontend should:');
  console.log('1. Capture e, c, d from URL query params');
  console.log('2. Call GET /chips/find?e=XX&c=XX&d=XX');
  console.log('3. Get chip/user data from response');
  console.log('4. Display profile\n');
  console.log('═══════════════════════════════════════════════════════════');
}

testIYKConnection();
