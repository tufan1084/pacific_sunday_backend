const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');

const RAPIDAPI_BASE = 'https://live-golf-data.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'live-golf-data.p.rapidapi.com';

const headers = () => ({
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': RAPIDAPI_HOST,
});

// ─── File-Based Persistent Cache ────────────────────────────────────────────
// Saves API responses to a JSON file so they survive server restarts.
// This prevents wasting limited RapidAPI calls on every restart/deploy.
//
// TTLs (how long cached data stays valid):
//   Schedule:    6 hours  (season schedule rarely changes)
//   Leaderboard: 3 min   (scores change during live rounds)
//   Tournament:  1 hour   (entry list / course info is stable)
//   Scorecard:   5 min    (per-player hole-by-hole detail)

const CACHE_FILE = path.join(__dirname, '..', '..', 'cache', 'golf-api-cache.json');
const CACHE_DIR = path.dirname(CACHE_FILE);

const TTL = {
  schedule:    24 * 60 * 60 * 1000,       // 24 hours (1 call/day)
  leaderboard: 3 * 60 * 1000,             // 3 minutes
  tournament:  60 * 60 * 1000,            // 1 hour
  scorecard:   5 * 60 * 1000,             // 5 minutes
  worldRank:   7 * 24 * 60 * 60 * 1000,   // 7 days (OWGR publishes weekly)
};

// In-memory mirror of the file (avoids reading file on every request)
let memCache = {};

// Load cache from file on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      memCache = JSON.parse(raw);
      // Clean expired entries on load
      const now = Date.now();
      let cleaned = 0;
      for (const key of Object.keys(memCache)) {
        if (now > memCache[key].expiresAt) {
          delete memCache[key];
          cleaned++;
        }
      }
      const active = Object.keys(memCache).length;
      logger.info(`[cache] Loaded ${active} entries from file (cleaned ${cleaned} expired)`);
    }
  } catch (err) {
    logger.warn(`[cache] Could not load cache file: ${err.message}`);
    memCache = {};
  }
}

// Save cache to file (debounced — writes at most once per second)
let saveTimer = null;
function saveCache() {
  if (saveTimer) return; // already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(memCache, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`[cache] Could not save cache file: ${err.message}`);
    }
  }, 1000);
}

function getCached(key) {
  const entry = memCache[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete memCache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs) {
  memCache[key] = { data, expiresAt: Date.now() + ttlMs };
  saveCache(); // persist to file (debounced)
}

// Load on startup
loadCache();

// ─── Admin helpers ──────────────────────────────────────────────────────────
exports.getCacheStats = () => {
  let active = 0;
  let expired = 0;
  const now = Date.now();
  for (const key of Object.keys(memCache)) {
    if (now > memCache[key].expiresAt) expired++;
    else active++;
  }
  return { active, expired, total: Object.keys(memCache).length, file: CACHE_FILE };
};

exports.clearCache = () => {
  memCache = {};
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch (err) { /* ignore */ }
  logger.info('[cache] Cache cleared');
};

// ─── Schedule ────────────────────────────────────────────────────────────────
exports.getSchedule = async (year) => {
  const key = `schedule:${year}`;
  const cached = getCached(key);
  if (cached) {
    logger.info(`[cache hit] ${key}`);
    return cached;
  }

  const response = await axios.get(`${RAPIDAPI_BASE}/schedule`, {
    headers: headers(),
    params: { orgId: '1', year: String(year) },
  });
  setCache(key, response.data, TTL.schedule);
  logger.info(`[cache miss] ${key} — cached for 6h`);
  return response.data;
};

// ─── Tournament Details + Entry List ─────────────────────────────────────────
exports.getTournament = async (tournId, year) => {
  const key = `tournament:${tournId}:${year}`;
  const cached = getCached(key);
  if (cached) {
    logger.info(`[cache hit] ${key}`);
    return cached;
  }

  const response = await axios.get(`${RAPIDAPI_BASE}/tournament`, {
    headers: headers(),
    params: { tournId, year: String(year) },
  });
  setCache(key, response.data, TTL.tournament);
  logger.info(`[cache miss] ${key} — cached for 1h`);
  return response.data;
};

// ─── Leaderboard ─────────────────────────────────────────────────────────────
exports.getLeaderboard = async (tournId, year, roundId) => {
  const roundSuffix = roundId ? `:r${roundId}` : '';
  const key = `leaderboard:${tournId}:${year}${roundSuffix}`;
  const cached = getCached(key);
  if (cached) {
    logger.info(`[cache hit] ${key}`);
    return cached;
  }

  const params = { tournId, year: String(year) };
  if (roundId) params.roundId = String(roundId);
  const response = await axios.get(`${RAPIDAPI_BASE}/leaderboard`, {
    headers: headers(),
    params,
  });
  // Past-round snapshots are immutable once roundStatus === 'Official', so
  // cache them for an hour instead of 3 minutes. Live snapshots stay short.
  const isOfficialPastRound = roundId && (response.data?.roundStatus || '').toLowerCase().includes('official');
  setCache(key, response.data, isOfficialPastRound ? 60 * 60 * 1000 : TTL.leaderboard);
  logger.info(`[cache miss] ${key} — cached for ${isOfficialPastRound ? '1h' : '3min'}`);
  return response.data;
};

// ─── World Ranking (OWGR via Slash Golf statId=186) ─────────────────────────
// Returns ~999 players with current OWGR rank. Same subscription as other endpoints.
// Rank field uses MongoDB extended JSON: { "$numberInt": "1" } — normalize here.
const toInt = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
  if (typeof v === 'object' && '$numberInt' in v) return parseInt(v.$numberInt, 10);
  return null;
};

exports.getWorldRanking = async (year) => {
  const key = `owgr:${year}`;
  const cached = getCached(key);
  if (cached) {
    logger.info(`[cache hit] ${key}`);
    return cached;
  }

  const response = await axios.get(`${RAPIDAPI_BASE}/stats`, {
    headers: headers(),
    params: { statId: '186', orgId: '1', year: String(year) },
  });

  // Normalize: produce { playerId → rank } map + raw list
  const rows = response.data?.rankings || response.data?.stats || response.data || [];
  const list = Array.isArray(rows) ? rows : [];
  const normalized = list.map((r) => ({
    playerId: String(r.playerId || ''),
    firstName: r.firstName || '',
    lastName: r.lastName || '',
    country: r.country || '',
    rank: toInt(r.rank),
  })).filter((r) => r.playerId && r.rank != null);

  const byPlayerId = {};
  for (const r of normalized) byPlayerId[r.playerId] = r.rank;

  const result = { list: normalized, byPlayerId, fetchedAt: new Date().toISOString() };
  setCache(key, result, TTL.worldRank);
  logger.info(`[cache miss] ${key} — ${normalized.length} ranked players, cached for 7d`);
  return result;
};

// ─── Scorecard ───────────────────────────────────────────────────────────────
exports.getScorecard = async (tournId, year, playerId) => {
  const key = `scorecard:${tournId}:${year}:${playerId}`;
  const cached = getCached(key);
  if (cached) {
    logger.info(`[cache hit] ${key}`);
    return cached;
  }

  const response = await axios.get(`${RAPIDAPI_BASE}/scorecard`, {
    headers: headers(),
    params: { tournId, year: String(year), playerId },
  });
  setCache(key, response.data, TTL.scorecard);
  logger.info(`[cache miss] ${key} — cached for 5min`);
  return response.data;
};
