const { prisma } = require('../config/db');

// Short in-memory cache so the maintenance middleware (runs on every request)
// and h2h challenge creation don't hit the DB each time. Invalidated on write.
let cache = null;
let cacheAt = 0;
const TTL_MS = 15 * 1000;

/**
 * Singleton fetch/create for PlatformSettings. Cached for TTL_MS.
 */
async function getPlatformSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL_MS) {
    return cache;
  }
  let row = await prisma.platformSettings.findFirst({ orderBy: { id: 'asc' } });
  if (!row) {
    row = await prisma.platformSettings.create({ data: {} });
  }
  cache = row;
  cacheAt = Date.now();
  return row;
}

async function updatePlatformSettings(patch) {
  const current = await getPlatformSettings({ fresh: true });
  const updated = await prisma.platformSettings.update({
    where: { id: current.id },
    data: patch,
  });
  cache = updated;
  cacheAt = Date.now();
  return updated;
}

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

module.exports = { getPlatformSettings, updatePlatformSettings, invalidateCache };
