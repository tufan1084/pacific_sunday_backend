const { Server } = require('socket.io');
const logger = require('./logger');

let io = null;

// Must stay in sync with the Express CORS allowlist in src/app.js. Before this
// matched, production browsers were blocked from opening the socket so real-time
// post:liked / comment:added events never reached clients — likes/comments only
// updated after a full page refresh.
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5000',
  'https://pacific-sunday.vercel.app',
  'https://pacific-sunday-admin.vercel.app',
  'http://47.129.165.80:3010',
  'http://47.129.165.80:3012',
];

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // native apps / server-to-server
        if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
          return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) return callback(null, true);
        logger.warn(`[socket] blocked CORS origin: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    // Clients send { userId } after login so we can target per-user events
    // (notifications, personal invites). Untrusted — used only for room routing.
    socket.on('user:identify', ({ userId }) => {
      const uid = parseInt(userId);
      if (Number.isInteger(uid) && uid > 0) {
        socket.join(`user:${uid}`);
        logger.info(`Socket ${socket.id} joined room user:${uid}`);
      }
    });

    // ─── Chat Events ────────────────────────────────────────────────────────
    
    // Join conversation room
    socket.on('chat:join', ({ conversationId }) => {
      const cid = parseInt(conversationId);
      if (Number.isInteger(cid) && cid > 0) {
        socket.join(`conversation_${cid}`);
        logger.info(`Socket ${socket.id} joined conversation_${cid}`);
      }
    });

    // Leave conversation room
    socket.on('chat:leave', ({ conversationId }) => {
      const cid = parseInt(conversationId);
      if (Number.isInteger(cid) && cid > 0) {
        socket.leave(`conversation_${cid}`);
        logger.info(`Socket ${socket.id} left conversation_${cid}`);
      }
    });

    // Typing indicator
    socket.on('chat:typing', ({ conversationId, userId, isTyping }) => {
      const cid = parseInt(conversationId);
      if (Number.isInteger(cid) && cid > 0) {
        socket.to(`conversation_${cid}`).emit('chat:typing', {
          conversationId: cid,
          userId: parseInt(userId),
          isTyping
        });
      }
    });

    // User online status
    socket.on('chat:online', ({ userId }) => {
      const uid = parseInt(userId);
      if (Number.isInteger(uid) && uid > 0) {
        io.emit('user:online', { userId: uid, isOnline: true });
        logger.info(`User ${uid} is online`);
      }
    });

    socket.on('chat:offline', ({ userId }) => {
      const uid = parseInt(userId);
      if (Number.isInteger(uid) && uid > 0) {
        io.emit('user:online', { userId: uid, isOnline: false });
        logger.info(`User ${uid} is offline`);
      }
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

// Emit events to all connected clients
const emitPostLiked = (postId, likeCount, userId) => {
  if (io) {
    io.emit('post:liked', { postId, likeCount, userId });
    logger.info(`Emitted post:liked event for post ${postId}`);
  }
};

const emitPostUnliked = (postId, likeCount, userId) => {
  if (io) {
    io.emit('post:unliked', { postId, likeCount, userId });
    logger.info(`Emitted post:unliked event for post ${postId}`);
  }
};

const emitPostCreated = (post) => {
  if (io) {
    io.emit('post:created', post);
    logger.info(`Emitted post:created event for post ${post.id}`);
  }
};

const emitCommentAdded = (postId, commentCount, comment) => {
  if (io) {
    io.emit('comment:added', { postId, commentCount, comment });
    logger.info(`Emitted comment:added event for post ${postId}`);
  }
};

const emitCommentDeleted = (postId, commentId, commentCount) => {
  if (io) {
    io.emit('comment:deleted', { postId, commentId, commentCount });
    logger.info(`Emitted comment:deleted event for post ${postId} (commentId=${commentId})`);
  }
};

const emitCommentEdited = (postId, comment) => {
  if (io) {
    io.emit('comment:edited', { postId, comment });
    logger.info(`Emitted comment:edited event for post ${postId} (commentId=${comment.id})`);
  }
};

const emitPostPinned = (postId, isPinned, userId) => {
  if (io) {
    io.emit('post:pinned', { postId, isPinned, userId });
    logger.info(`Emitted post:pinned event for post ${postId} (isPinned=${isPinned})`);
  }
};

const emitPostDeleted = (postId, userId) => {
  if (io) {
    io.emit('post:deleted', { postId, userId });
    logger.info(`Emitted post:deleted event for post ${postId}`);
  }
};

const emitPostHidden = (postId, isHidden) => {
  if (io) {
    io.emit('post:hidden', { postId, isHidden });
    logger.info(`Emitted post:hidden (${isHidden}) for post ${postId}`);
  }
};

const emitPostShared = (postId, shareCount) => {
  if (io) {
    io.emit('post:shared', { postId, shareCount });
    logger.info(`Emitted post:shared event for post ${postId} (shareCount=${shareCount})`);
  }
};

const emitTeamCreated = (team) => {
  if (io) {
    io.emit('team:created', team);
    logger.info(`Emitted team:created event for team ${team.id}`);
  }
};

const emitTeamMemberChanged = (teamId, memberCount, userId, action) => {
  if (io) {
    io.emit('team:memberChanged', { teamId, memberCount, userId, action });
    logger.info(`Emitted team:memberChanged (${action}) teamId=${teamId}`);
  }
};

const emitTeamUpdated = (teamId, team) => {
  if (io) {
    io.emit('team:updated', { teamId, team });
    logger.info(`Emitted team:updated event for team ${teamId}`);
  }
};

const emitTeamJoinRequest = (teamId, userId, action) => {
  if (io) {
    io.emit('team:joinRequest', { teamId, userId, action });
    logger.info(`Emitted team:joinRequest (${action}) teamId=${teamId}`);
  }
};

const emitTeamInvite = (teamId, userId, action) => {
  if (io) {
    io.emit('team:invite', { teamId, userId, action });
    logger.info(`Emitted team:invite (${action}) teamId=${teamId}`);
  }
};

const emitNotification = (userId, notification) => {
  if (io) {
    io.to(`user:${userId}`).emit('notification:new', notification);
    logger.info(`Emitted notification:new to user:${userId} (${notification.type})`);
  }
};

const emitFollowChanged = (followerId, followingId, action) => {
  if (io) {
    io.emit('user:followChanged', { followerId, followingId, action });
    logger.info(`Emitted user:followChanged (${action}) ${followerId}→${followingId}`);
  }
};

// ─── Chat Emit Functions ────────────────────────────────────────────────────────

const emitNewMessage = (conversationId, message) => {
  if (io) {
    io.to(`conversation_${conversationId}`).emit('new_message', message);
    logger.info(`Emitted new_message to conversation_${conversationId}`);
  }
};

const emitMessageDeleted = (conversationId, messageId) => {
  if (io) {
    io.to(`conversation_${conversationId}`).emit('message_deleted', { messageId, conversationId });
    logger.info(`Emitted message_deleted for message ${messageId}`);
  }
};

const emitMessageReaction = (conversationId, messageId, reaction) => {
  if (io) {
    io.to(`conversation_${conversationId}`).emit('message_reaction', { messageId, reaction });
    logger.info(`Emitted message_reaction for message ${messageId}`);
  }
};

const emitMessagesRead = (conversationId, userId) => {
  if (io) {
    io.to(`conversation_${conversationId}`).emit('messages_read', { conversationId, userId });
    logger.info(`Emitted messages_read for conversation ${conversationId} by user ${userId}`);
  }
};

const emitUserOnline = (userId, isOnline) => {
  if (io) {
    io.emit('user:online', { userId, isOnline });
    logger.info(`Emitted user:online for user ${userId} (${isOnline})`);
  }
};

const emitH2HTeamsLocked = (challengeId, challengerUserId, opponentUserId) => {
  if (io) {
    const payload = { challengeId };
    io.to(`user:${challengerUserId}`).emit('h2h:bothLocked', payload);
    io.to(`user:${opponentUserId}`).emit('h2h:bothLocked', payload);
    logger.info(`Emitted h2h:bothLocked for challenge ${challengeId}`);
  }
};

const emitH2HChallengeUpdated = (challengeId, challengerUserId, opponentUserId, action, status) => {
  if (io) {
    const payload = { challengeId, action, status };
    io.to(`user:${challengerUserId}`).emit('h2h:challengeUpdated', payload);
    io.to(`user:${opponentUserId}`).emit('h2h:challengeUpdated', payload);
    logger.info(`Emitted h2h:challengeUpdated (${action}) for challenge ${challengeId}`);
  }
};

module.exports = {
  initializeSocket,
  getIO,
  emitPostLiked,
  emitPostUnliked,
  emitPostCreated,
  emitCommentAdded,
  emitCommentDeleted,
  emitCommentEdited,
  emitPostPinned,
  emitPostDeleted,
  emitPostHidden,
  emitPostShared,
  emitTeamCreated,
  emitTeamMemberChanged,
  emitTeamUpdated,
  emitTeamJoinRequest,
  emitTeamInvite,
  emitNotification,
  emitFollowChanged,
  // Chat functions
  emitNewMessage,
  emitMessageDeleted,
  emitMessageReaction,
  emitMessagesRead,
  emitUserOnline,
  emitH2HTeamsLocked,
  emitH2HChallengeUpdated,
};
