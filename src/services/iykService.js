const axios = require('axios');

const IYK_API_BASE = 'https://api.iyk.app';
const IYK_API_KEY = process.env.IYK_SESSION_KEY;

// Find chip by e, c, d parameters from NFC scan
exports.findChip = async (e, c, d) => {
  try {
    const response = await axios.get(`${IYK_API_BASE}/chips/find`, {
      params: { e, c, d },
      headers: {
        'x-iyk-api-key': IYK_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(error.response.data.message || 'Chip not found');
    }
    throw error;
  }
};

// Resolve an iykRef (single-use tap reference) to chip details.
// IYK redirects taps to: <baseURL>?iykRef=<id>. Calling this endpoint
// proves the tap is real (single-use) and returns the chip's UID.
// See: https://docs.iyk.app/api-core/refs
exports.findChipByRef = async (iykRef) => {
  try {
    const response = await axios.get(`${IYK_API_BASE}/refs/${encodeURIComponent(iykRef)}`, {
      params: { includeOwner: true, includeMetadata: true },
      headers: {
        'x-iyk-api-key': IYK_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(error.response.data.message || 'iykRef not found or already used');
    }
    throw error;
  }
};

// Fetch all items (bag types) from IYK
exports.fetchAllItems = async () => {
  const response = await axios.get(`${IYK_API_BASE}/items`, {
    headers: { 'x-iyk-api-key': IYK_API_KEY }
  });
  return response.data;
};

// Fetch all chips for a given item
exports.fetchChipsForItem = async (itemId) => {
  const response = await axios.get(`${IYK_API_BASE}/items/${itemId}/chips`, {
    headers: { 'x-iyk-api-key': IYK_API_KEY }
  });
  return response.data;
};
