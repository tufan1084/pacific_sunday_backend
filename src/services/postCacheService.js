const { cache } = require('../config/redis');
const logger = require('../config/logger');

const CACHE_TTL = {
  POSTS: 300,        // 5 minutes
  POST_LIKES: 600,   // 10 minutes
  POST_COMMENTS: 300, // 5 minutes
};

class PostCacheService {
  static keys = {
    posts: (limit, offset) => `posts:${limit}:${offset}`,
    postLikes: (postId) => `post:${postId}:likes`,
    postLikedBy: (postId) => `post:${postId}:liked_by`,
    userLikedPost: (userId, postId) => `user:${userId}:liked:${postId}`,
    postComments: (postId) => `post:${postId}:comments`,
    postShares: (postId) => `post:${postId}:shares`,
  };

  static async getPosts(limit, offset) {
    return await cache.get(this.keys.posts(limit, offset));
  }

  static async setPosts(limit, offset, posts) {
    await cache.set(this.keys.posts(limit, offset), posts, CACHE_TTL.POSTS);
  }

  static async invalidatePosts() {
    await cache.delPattern('posts:*');
  }

  static async getLikeCount(postId) {
    const count = await cache.get(this.keys.postLikes(postId));
    return count !== null ? parseInt(count) : null;
  }

  static async setLikeCount(postId, count) {
    await cache.set(this.keys.postLikes(postId), count, CACHE_TTL.POST_LIKES);
  }

  static async incrementLikes(postId) {
    const key = this.keys.postLikes(postId);
    const newCount = await cache.incr(key);
    if (newCount === 1) {
      const client = require('../config/redis').getRedisClient();
      if (client) await client.expire(key, CACHE_TTL.POST_LIKES);
    }
    return newCount;
  }

  static async decrementLikes(postId) {
    return await cache.decr(this.keys.postLikes(postId));
  }

  static async hasUserLiked(userId, postId) {
    return await cache.sismember(this.keys.postLikedBy(postId), userId.toString());
  }

  static async addUserLike(userId, postId) {
    const key = this.keys.postLikedBy(postId);
    await cache.sadd(key, userId.toString());
    const client = require('../config/redis').getRedisClient();
    if (client) await client.expire(key, CACHE_TTL.POST_LIKES);
  }

  static async removeUserLike(userId, postId) {
    await cache.srem(this.keys.postLikedBy(postId), userId.toString());
  }

  static async invalidatePost(postId) {
    await cache.del(this.keys.postLikes(postId));
    await cache.del(this.keys.postLikedBy(postId));
    await cache.del(this.keys.postShares(postId));
    await this.invalidatePosts();
  }

  static async getCommentsCount(postId) {
    const count = await cache.get(this.keys.postComments(postId));
    return count !== null ? parseInt(count) : null;
  }

  static async setCommentsCount(postId, count) {
    await cache.set(this.keys.postComments(postId), count, CACHE_TTL.POST_COMMENTS);
  }

  static async incrementComments(postId) {
    const key = this.keys.postComments(postId);
    const newCount = await cache.incr(key);
    if (newCount === 1) {
      const client = require('../config/redis').getRedisClient();
      if (client) await client.expire(key, CACHE_TTL.POST_COMMENTS);
    }
    return newCount;
  }

  static async decrementComments(postId) {
    return await cache.decr(this.keys.postComments(postId));
  }

  static async getShareCount(postId) {
    const count = await cache.get(this.keys.postShares(postId));
    return count !== null ? parseInt(count) : null;
  }

  static async setShareCount(postId, count) {
    await cache.set(this.keys.postShares(postId), count, CACHE_TTL.POSTS);
  }

  static async incrementShares(postId) {
    const key = this.keys.postShares(postId);
    const newCount = await cache.incr(key);
    if (newCount === 1) {
      const client = require('../config/redis').getRedisClient();
      if (client) await client.expire(key, CACHE_TTL.POSTS);
    }
    return newCount;
  }
}

module.exports = PostCacheService;
