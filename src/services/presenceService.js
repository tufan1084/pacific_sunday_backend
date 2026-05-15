// Tracks which users are currently online by counting their connected sockets.
// Backed by Redis when available so it survives across multiple Node processes;
// falls back to an in-memory Map when Redis is down (single-process only).
//
// Keys:
//   presence:sockets:<userId>  - SET of active socket IDs for that user
//   presence:lastseen:<userId> - ISO timestamp written when last socket disconnects

const { getRedisClient, isRedisAvailable } = require('../config/redis');
const logger = require('../config/logger');

const memorySockets = new Map(); // userId -> Set<socketId>
const memoryLastSeen = new Map(); // userId -> ISO string

const socketsKey = (userId) => `presence:sockets:${userId}`;
const lastSeenKey = (userId) => `presence:lastseen:${userId}`;

// Safety TTL on the per-user socket set. Every add refreshes it. If a
// disconnect event is ever missed (network drop, crashed tab) the set still
// self-heals after this window instead of pinning the user "online" forever.
const SOCKET_SET_TTL_SEC = 2 * 60 * 60; // 2h

const useRedis = () => isRedisAvailable() && getRedisClient();

// Wipe ALL presence state. Called once on server boot: at that moment zero
// sockets are connected, so any `presence:sockets:*` keys left in Redis from
// a previous process are stale and would make everyone show as "online"
// until those phantom socket ids happened to be cleaned up (they never are).
async function clearAllPresence() {
  memorySockets.clear();
  memoryLastSeen.clear();
  if (useRedis()) {
    try {
      const client = getRedisClient();
      // SCAN rather than KEYS so we don't block Redis on large keyspaces.
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', 'presence:sockets:*', 'COUNT', 200);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== '0');
      logger.info('[presence] cleared stale socket sets on boot');
    } catch (err) {
      logger.error(`[presence] clearAllPresence redis error: ${err.message}`);
    }
  }
}

// Add a socket for a user. Returns { wentOnline: boolean } so the caller can
// decide whether to broadcast a transition event.
async function addSocket(userId, socketId) {
  const uid = String(userId);
  if (useRedis()) {
    try {
      const client = getRedisClient();
      const before = await client.scard(socketsKey(uid));
      await client.sadd(socketsKey(uid), socketId);
      // Refresh the safety TTL on every add so an active user's set never
      // expires under them, but an abandoned set eventually does.
      await client.expire(socketsKey(uid), SOCKET_SET_TTL_SEC);
      await client.del(lastSeenKey(uid));
      return { wentOnline: before === 0 };
    } catch (err) {
      logger.error(`[presence] addSocket redis error: ${err.message}`);
    }
  }
  let set = memorySockets.get(uid);
  const wentOnline = !set || set.size === 0;
  if (!set) { set = new Set(); memorySockets.set(uid, set); }
  set.add(socketId);
  memoryLastSeen.delete(uid);
  return { wentOnline };
}

// Remove a socket for a user. Returns { wentOffline: boolean, lastSeenAt: string|null }.
async function removeSocket(userId, socketId) {
  const uid = String(userId);
  const now = new Date().toISOString();
  if (useRedis()) {
    try {
      const client = getRedisClient();
      await client.srem(socketsKey(uid), socketId);
      const remaining = await client.scard(socketsKey(uid));
      if (remaining === 0) {
        await client.set(lastSeenKey(uid), now);
        return { wentOffline: true, lastSeenAt: now };
      }
      return { wentOffline: false, lastSeenAt: null };
    } catch (err) {
      logger.error(`[presence] removeSocket redis error: ${err.message}`);
    }
  }
  const set = memorySockets.get(uid);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) {
      memorySockets.delete(uid);
      memoryLastSeen.set(uid, now);
      return { wentOffline: true, lastSeenAt: now };
    }
  }
  return { wentOffline: false, lastSeenAt: null };
}

async function isUserOnline(userId) {
  const uid = String(userId);
  if (useRedis()) {
    try {
      const count = await getRedisClient().scard(socketsKey(uid));
      return count > 0;
    } catch (err) {
      logger.error(`[presence] isUserOnline redis error: ${err.message}`);
    }
  }
  const set = memorySockets.get(uid);
  return !!(set && set.size > 0);
}

async function getLastSeen(userId) {
  const uid = String(userId);
  if (useRedis()) {
    try {
      return await getRedisClient().get(lastSeenKey(uid));
    } catch (err) {
      logger.error(`[presence] getLastSeen redis error: ${err.message}`);
    }
  }
  return memoryLastSeen.get(uid) || null;
}

// Bulk lookup for the conversations list — one round trip instead of N.
async function getPresenceBulk(userIds) {
  const result = {};
  if (!userIds || userIds.length === 0) return result;
  const uids = userIds.map(String);

  if (useRedis()) {
    try {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      uids.forEach((uid) => {
        pipeline.scard(socketsKey(uid));
        pipeline.get(lastSeenKey(uid));
      });
      const replies = await pipeline.exec();
      uids.forEach((uid, idx) => {
        const count = replies[idx * 2]?.[1] || 0;
        const lastSeen = replies[idx * 2 + 1]?.[1] || null;
        result[uid] = { isOnline: count > 0, lastSeenAt: lastSeen };
      });
      return result;
    } catch (err) {
      logger.error(`[presence] getPresenceBulk redis error: ${err.message}`);
    }
  }
  uids.forEach((uid) => {
    const set = memorySockets.get(uid);
    result[uid] = {
      isOnline: !!(set && set.size > 0),
      lastSeenAt: memoryLastSeen.get(uid) || null,
    };
  });
  return result;
}

module.exports = {
  clearAllPresence,
  addSocket,
  removeSocket,
  isUserOnline,
  getLastSeen,
  getPresenceBulk,
};
