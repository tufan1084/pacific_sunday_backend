const Redis = require('ioredis');
const logger = require('./logger');

let redisClient = null;
let isRedisAvailable = false;

const connectRedis = () => {
  try {
    const redisUrl = process.env.REDIS_URL;
    
    // If no Redis URL, run without Redis (graceful degradation)
    if (!redisUrl || redisUrl === 'redis://localhost:6379') {
      logger.warn('Redis URL not configured. Running without cache (slower performance)');
      isRedisAvailable = false;
      return null;
    }
    
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectTimeout: 10000,
      retryStrategy(times) {
        if (times > 3) {
          logger.error('Redis connection failed after 3 retries. Running without cache.');
          isRedisAvailable = false;
          return null;
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    redisClient.on('connect', () => {
      logger.info('Redis connected successfully');
      isRedisAvailable = true;
    });

    redisClient.on('error', (err) => {
      logger.error(`Redis error: ${err.message}`);
      isRedisAvailable = false;
    });

    redisClient.on('ready', () => {
      logger.info('Redis is ready');
      isRedisAvailable = true;
    });

    return redisClient;
  } catch (error) {
    logger.error(`Failed to connect to Redis: ${error.message}`);
    isRedisAvailable = false;
    return null;
  }
};

const getRedisClient = () => {
  if (!redisClient || !isRedisAvailable) {
    return null;
  }
  return redisClient;
};

// Cache helper functions with fallback
const cacheHelpers = {
  async get(key) {
    try {
      const client = getRedisClient();
      if (!client) return null;
      
      const data = await client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error(`Redis GET error: ${error.message}`);
      return null;
    }
  },

  async set(key, value, ttl = 300) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      await client.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`Redis SET error: ${error.message}`);
      return false;
    }
  },

  async del(key) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      await client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis DEL error: ${error.message}`);
      return false;
    }
  },

  async delPattern(pattern) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(...keys);
      }
      return true;
    } catch (error) {
      logger.error(`Redis DEL pattern error: ${error.message}`);
      return false;
    }
  },

  async incr(key) {
    try {
      const client = getRedisClient();
      if (!client) return null;
      
      return await client.incr(key);
    } catch (error) {
      logger.error(`Redis INCR error: ${error.message}`);
      return null;
    }
  },

  async decr(key) {
    try {
      const client = getRedisClient();
      if (!client) return null;
      
      return await client.decr(key);
    } catch (error) {
      logger.error(`Redis DECR error: ${error.message}`);
      return null;
    }
  },

  async sadd(key, member) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      await client.sadd(key, member);
      return true;
    } catch (error) {
      logger.error(`Redis SADD error: ${error.message}`);
      return false;
    }
  },

  async srem(key, member) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      await client.srem(key, member);
      return true;
    } catch (error) {
      logger.error(`Redis SREM error: ${error.message}`);
      return false;
    }
  },

  async sismember(key, member) {
    try {
      const client = getRedisClient();
      if (!client) return false;
      
      const result = await client.sismember(key, member);
      return result === 1;
    } catch (error) {
      logger.error(`Redis SISMEMBER error: ${error.message}`);
      return false;
    }
  },
};

module.exports = {
  connectRedis,
  getRedisClient,
  cache: cacheHelpers,
  isRedisAvailable: () => isRedisAvailable,
};
