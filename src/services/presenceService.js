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

const useRedis = () => isRedisAvailable() && getRedisClient();

// Add a socket for a user. Returns { wentOnline: boolean } so the caller can
// decide whether to broadcast a transition event.
async function addSocket(userId, socketId) {
  const uid = String(userId);
  if (useRedis()) {
    try {
      const client = getRedisClient();
      const before = await client.scard(socketsKey(uid));
      await client.sadd(socketsKey(uid), socketId);
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
  addSocket,
  removeSocket,
  isUserOnline,
  getLastSeen,
  getPresenceBulk,
};
