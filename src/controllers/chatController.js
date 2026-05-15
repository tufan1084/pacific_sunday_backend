const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../config/logger');
const presence = require('../services/presenceService');
const { cache } = require('../config/redis');

// Redis cache keys for the chat list + header badge. TTLs are short on purpose —
// we also invalidate on every mutation, so the TTL is just a safety net.
const convListKey = (userId) => `chat:conv:${userId}`;
const unreadCountKey = (userId) => `chat:unread:${userId}`;
const CONV_LIST_TTL = 60;
const UNREAD_TTL = 30;

// Validate a replyToId before using it in message.create. Returns the id if
// valid (exists, belongs to the same conversation, not deleted), or null.
async function resolveReplyTo(replyToId, conversationId) {
  if (!replyToId) return null;
  const id = parseInt(replyToId);
  if (!id || id < 0) return null;
  try {
    const msg = await prisma.message.findFirst({
      where: { id, conversationId, deletedAt: null },
      select: { id: true },
    });
    return msg ? msg.id : null;
  } catch {
    return null;
  }
}

// Bust the cached conversation list + unread badge for every participant in a
// thread. Called after send/read/delete so the next fetch reflects reality.
async function invalidateForConversation(conversationId) {
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId: parseInt(conversationId) },
      select: { userId: true },
    });
    await Promise.all(
      participants.flatMap((p) => [
        cache.del(convListKey(p.userId)),
        cache.del(unreadCountKey(p.userId)),
      ])
    );
  } catch (err) {
    logger.error(`[chat] invalidate cache error: ${err.message}`);
  }
}

// Get all conversations for current user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    // Try cache first. We still re-fetch presence below since that changes
    // far more often than the conversation list itself.
    const cached = await cache.get(convListKey(userId));
    if (cached && Array.isArray(cached)) {
      const otherIds = cached.map((c) => c.otherUser?.id).filter(Boolean);
      const presenceMap = await presence.getPresenceBulk(otherIds);
      const hydrated = cached.map((c) => ({
        ...c,
        otherUser: {
          ...c.otherUser,
          isOnline: presenceMap[c.otherUser.id]?.isOnline || false,
          lastSeenAt: presenceMap[c.otherUser.id]?.lastSeenAt || null,
        },
      }));
      return res.json(hydrated);
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        participants: {
          some: { userId }
        }
      },
      include: {
        participants: {
          select: {
            userId: true,
            unreadCount: true,
            isTyping: true,
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    name: true,
                    golfPassport: {
                      select: { photoUrl: true }
                    }
                  }
                }
              }
            }
          }
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            messageType: true,
            senderId: true,
            createdAt: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Format and deduplicate conversations (keep the one with latest activity per user)
    const seen = new Map();
    const formatted = [];

    for (const conv of conversations) {
      const otherParticipant = conv.participants.find(p => p.userId !== userId);
      const myParticipant = conv.participants.find(p => p.userId === userId);
      const lastMessage = conv.messages[0] || null;

      if (!otherParticipant) continue;

      const otherUserId = otherParticipant.user.id;

      // Skip duplicate direct conversations with same user (keep first = most recent due to orderBy)
      if (conv.type === 'DIRECT' && seen.has(otherUserId)) continue;
      seen.set(otherUserId, true);

      formatted.push({
        id: conv.id,
        type: conv.type,
        otherUser: {
          id: otherParticipant.user.id,
          username: otherParticipant.user.username,
          name: otherParticipant.user.profile?.name || otherParticipant.user.username,
          photoUrl: otherParticipant.user.profile?.golfPassport?.photoUrl || null,
          isOnline: false,
          lastSeenAt: null,
          isTyping: otherParticipant.isTyping
        },
        lastMessage: lastMessage ? {
          id: lastMessage.id,
          content: lastMessage.content,
          messageType: lastMessage.messageType,
          senderId: lastMessage.senderId,
          createdAt: lastMessage.createdAt
        } : null,
        unreadCount: myParticipant?.unreadCount || 0,
        updatedAt: conv.updatedAt
      });
    }

    // Cache the presence-free shape so we can re-hydrate presence cheaply on hit.
    await cache.set(convListKey(userId), formatted, CONV_LIST_TTL);

    // Hydrate presence for the live response.
    const otherIds = formatted.map((c) => c.otherUser.id);
    const presenceMap = await presence.getPresenceBulk(otherIds);
    const hydrated = formatted.map((c) => ({
      ...c,
      otherUser: {
        ...c.otherUser,
        isOnline: presenceMap[c.otherUser.id]?.isOnline || false,
        lastSeenAt: presenceMap[c.otherUser.id]?.lastSeenAt || null,
      },
    }));

    res.json(hydrated);
  } catch (error) {
    logger.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

// Get or create conversation with another user
exports.getOrCreateConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { otherUserId } = req.body;

    if (!otherUserId) {
      return res.status(400).json({ error: 'otherUserId is required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // Check if conversation already exists
    const existingConv = await prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: otherUserId } } }
        ]
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    name: true,
                    golfPassport: { select: { photoUrl: true } }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (existingConv) {
      const otherParticipant = existingConv.participants.find(p => p.userId === otherUserId);
      return res.json({
        id: existingConv.id,
        otherUser: {
          id: otherParticipant.user.id,
          username: otherParticipant.user.username,
          name: otherParticipant.user.profile?.name || otherParticipant.user.username,
          photoUrl: otherParticipant.user.profile?.golfPassport?.photoUrl || null
        }
      });
    }

    // Create new conversation
    const newConv = await prisma.conversation.create({
      data: {
        type: 'DIRECT',
        participants: {
          create: [
            { userId },
            { userId: otherUserId }
          ]
        }
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    name: true,
                    golfPassport: { select: { photoUrl: true } }
                  }
                }
              }
            }
          }
        }
      }
    });

    const otherParticipant = newConv.participants.find(p => p.userId === otherUserId);
    res.json({
      id: newConv.id,
      otherUser: {
        id: otherParticipant.user.id,
        username: otherParticipant.user.username,
        name: otherParticipant.user.profile?.name || otherParticipant.user.username,
        photoUrl: otherParticipant.user.profile?.golfPassport?.photoUrl || null
      }
    });
  } catch (error) {
    logger.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
};

// Get messages in a conversation
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { page = 0, limit = 50 } = req.query;

    // Verify user is participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId: parseInt(conversationId),
          userId
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId: parseInt(conversationId),
        // Keep soft-deleted messages in the result so the frontend can render
        // a "This message was deleted" tombstone — same as WhatsApp does for
        // "delete for everyone". The frontend reads `deletedAt` to decide.
        // Filter out messages the current user has personally hidden
        // ("delete for me") — `hiddenForUserIds` is per-user opaque.
        NOT: { hiddenForUserIds: { has: userId } }
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profile: {
              select: {
                name: true,
                golfPassport: { select: { photoUrl: true } }
              }
            }
          }
        },
        deliveries: {
          where: { userId: { not: userId } },
          select: { status: true }
        },
        reactions: {
          include: {
            user: {
              select: { id: true, username: true }
            }
          }
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            messageType: true,
            sender: {
              select: {
                id: true,
                username: true,
                profile: { select: { name: true } },
              },
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: parseInt(page) * parseInt(limit),
      take: parseInt(limit)
    });

    res.json(messages.reverse());
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

// Send a text message
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { content, replyToId } = req.body;

    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Message content is required' });
    }

    // Verify user is participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId: parseInt(conversationId),
          userId
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Get other participants
    const otherParticipants = await prisma.conversationParticipant.findMany({
      where: {
        conversationId: parseInt(conversationId),
        userId: { not: userId }
      }
    });

    // Resolve the reply target safely. A bad replyToId (optimistic/negative
    // temp id from the client, a deleted message, or one from another
    // conversation) used to make prisma.message.create throw a foreign-key
    // error → the whole send 500'd and the recipient got nothing. Now we
    // validate it and just drop the link if it's invalid, so the message
    // still goes through.
    const safeReplyToId = await resolveReplyTo(replyToId, parseInt(conversationId));

    // Create message
    const message = await prisma.message.create({
      data: {
        conversationId: parseInt(conversationId),
        senderId: userId,
        content: content.trim(),
        messageType: 'TEXT',
        replyToId: safeReplyToId,
        deliveries: {
          create: otherParticipants.map(p => ({
            userId: p.userId,
            status: 'SENT'
          }))
        }
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profile: {
              select: {
                name: true,
                golfPassport: { select: { photoUrl: true } }
              }
            }
          }
        },
        deliveries: true,
        reactions: true,
        replyTo: {
          select: {
            id: true,
            content: true,
            messageType: true,
            sender: {
              select: {
                id: true,
                username: true,
                profile: { select: { name: true } },
              },
            }
          }
        }
      }
    });

    // Update conversation timestamp
    await prisma.conversation.update({
      where: { id: parseInt(conversationId) },
      data: { updatedAt: new Date() }
    });

    // Increment unread count for other participants
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId: parseInt(conversationId),
        userId: { not: userId }
      },
      data: {
        unreadCount: { increment: 1 }
      }
    });

    // Real-time delivery: emit to each participant's personal user room so they
    // receive the message even if the chat panel isn't open. The conversation
    // room emit stays for anyone actively viewing the thread (kept for parity).
    const io = req.app.get('io');
    const recipientPresence = await presence.getPresenceBulk(otherParticipants.map((p) => p.userId));
    if (io) {
      io.to(`conversation_${conversationId}`).emit('new_message', message);
      for (const p of otherParticipants) {
        io.to(`user:${p.userId}`).emit('new_message', message);
      }
      // Sender also needs the canonical message back via socket so other devices stay in sync.
      io.to(`user:${userId}`).emit('new_message', message);
    }

    // Cache invalidation: the conversation list preview + unread badge changed
    // for every participant, so bust their caches now.
    invalidateForConversation(conversationId);

    res.json({ ...message, recipientPresence });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

// Send media message
exports.sendMediaMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const { content, replyToId } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No media files uploaded' });
    }

    // Verify user is participant
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId: parseInt(conversationId),
          userId
        }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Get media URLs
    const mediaUrls = files.map(file => file.location || `/uploads/chat/${file.filename}`);
    const messageType = files[0].mimetype.startsWith('image/') ? 'IMAGE' : 'VIDEO';

    // Get other participants
    const otherParticipants = await prisma.conversationParticipant.findMany({
      where: {
        conversationId: parseInt(conversationId),
        userId: { not: userId }
      }
    });

    // Create message
    const message = await prisma.message.create({
      data: {
        conversationId: parseInt(conversationId),
        senderId: userId,
        content: content || '',
        messageType: files.length > 1 ? 'MIXED' : messageType,
        mediaUrls,
        replyToId: replyToId ? parseInt(replyToId) : null,
        deliveries: {
          create: otherParticipants.map(p => ({
            userId: p.userId,
            status: 'SENT'
          }))
        }
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profile: {
              select: {
                name: true,
                golfPassport: { select: { photoUrl: true } }
              }
            }
          }
        },
        deliveries: true,
        reactions: true
      }
    });

    // Update conversation
    await prisma.conversation.update({
      where: { id: parseInt(conversationId) },
      data: { updatedAt: new Date() }
    });

    // Increment unread count
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId: parseInt(conversationId),
        userId: { not: userId }
      },
      data: { unreadCount: { increment: 1 } }
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationId}`).emit('new_message', message);
      for (const p of otherParticipants) {
        io.to(`user:${p.userId}`).emit('new_message', message);
      }
      io.to(`user:${userId}`).emit('new_message', message);
    }

    invalidateForConversation(conversationId);

    res.json(message);
  } catch (error) {
    logger.error('Error sending media message:', error);
    res.status(500).json({ error: 'Failed to send media message' });
  }
};

// Mark messages as read
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;
    const cid = parseInt(conversationId);

    // Find which messages are about to flip to READ — we need their senderIds
    // and ids so the senders' UIs can update specific bubbles to blue ticks.
    const flipping = await prisma.messageDelivery.findMany({
      where: {
        userId,
        message: { conversationId: cid },
        status: { not: 'READ' },
      },
      select: { messageId: true, message: { select: { senderId: true } } },
    });

    // Update deliveries to READ
    await prisma.messageDelivery.updateMany({
      where: {
        userId,
        message: { conversationId: cid },
        status: { not: 'READ' }
      },
      data: {
        status: 'READ',
        timestamp: new Date()
      }
    });

    // Reset unread count
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: cid, userId },
      data: { unreadCount: 0, lastReadAt: new Date() }
    });

    const io = req.app.get('io');
    if (io && flipping.length > 0) {
      // Group flipped messages by sender, then notify each sender's user room.
      // This is the event that flips double-grey ticks to blue.
      const bySender = new Map();
      for (const d of flipping) {
        const sid = d.message?.senderId;
        if (!sid) continue;
        if (!bySender.has(sid)) bySender.set(sid, []);
        bySender.get(sid).push(d.messageId);
      }
      for (const [senderId, messageIds] of bySender.entries()) {
        io.to(`user:${senderId}`).emit('message_status_bulk', {
          userId,
          conversationId: cid,
          status: 'read',
          messageIds,
        });
      }
      // Keep the legacy room-scoped event for anyone currently watching the thread.
      io.to(`conversation_${cid}`).emit('messages_read', { conversationId: cid, userId });
    }

    invalidateForConversation(cid);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
};

// Delete a message
// "Delete for everyone" — soft-deletes the message. The frontend renders the
// bubble as a "This message was deleted" tombstone instead of removing it,
// matching WhatsApp's behaviour. Only the sender can do this.
exports.deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: parseInt(messageId) }
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({ error: 'Can only delete your own messages' });
    }

    if (message.deletedAt) {
      return res.json({ success: true }); // already deleted, idempotent
    }

    await prisma.message.update({
      where: { id: parseInt(messageId) },
      data: { deletedAt: new Date() }
    });

    // Notify every participant (conversation room + each user room so it
    // reaches users not currently in the thread). The payload is enough for
    // the client to turn the bubble into a tombstone.
    const io = req.app.get('io');
    if (io) {
      const participants = await prisma.conversationParticipant.findMany({
        where: { conversationId: message.conversationId },
        select: { userId: true }
      });
      const payload = {
        messageId: parseInt(messageId),
        conversationId: message.conversationId,
        deletedAt: new Date().toISOString(),
        scope: 'everyone',
      };
      io.to(`conversation_${message.conversationId}`).emit('message_deleted', payload);
      for (const p of participants) {
        io.to(`user:${p.userId}`).emit('message_deleted', payload);
      }
    }

    invalidateForConversation(message.conversationId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

// "Delete for me" — hides the message from *only* the requesting user's view.
// Everyone else continues to see it. Works for any message, regardless of who
// sent it. Idempotent if called twice.
exports.deleteMessageForMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const mid = parseInt(messageId);

    const message = await prisma.message.findUnique({
      where: { id: mid },
      select: { id: true, conversationId: true, hiddenForUserIds: true }
    });

    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Ensure the user is a participant in the conversation — prevents
    // arbitrary users from hiding messages in chats they don't belong to.
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.conversationId, userId } }
    });
    if (!participant) {
      return res.status(403).json({ error: 'Not a participant in this conversation' });
    }

    // Skip if already hidden — keeps the operation cheap and avoids growing
    // the array with duplicate ids if the client retries.
    if (!message.hiddenForUserIds.includes(userId)) {
      await prisma.message.update({
        where: { id: mid },
        data: { hiddenForUserIds: { push: userId } }
      });
    }

    invalidateForConversation(message.conversationId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting message for me:', error);
    res.status(500).json({ error: 'Failed to hide message' });
  }
};

// Edit a message. Only the sender can edit, only text messages, and only
// within a 15-minute window — same limits WhatsApp uses.
const EDIT_WINDOW_MS = 15 * 60 * 1000;

exports.editMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { content } = req.body;
    const mid = parseInt(messageId);

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'New content is required' });
    }

    const message = await prisma.message.findUnique({ where: { id: mid } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.senderId !== userId) {
      return res.status(403).json({ error: 'Can only edit your own messages' });
    }
    if (message.deletedAt) {
      return res.status(400).json({ error: 'Cannot edit a deleted message' });
    }
    if (message.messageType !== 'TEXT') {
      return res.status(400).json({ error: 'Only text messages can be edited' });
    }
    if (Date.now() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS) {
      return res.status(400).json({ error: 'Edit window has expired' });
    }

    const editedAt = new Date();
    const updated = await prisma.message.update({
      where: { id: mid },
      data: { content: content.trim(), editedAt },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            profile: { select: { name: true, golfPassport: { select: { photoUrl: true } } } }
          }
        }
      }
    });

    const io = req.app.get('io');
    if (io) {
      const participants = await prisma.conversationParticipant.findMany({
        where: { conversationId: message.conversationId },
        select: { userId: true }
      });
      const payload = {
        messageId: mid,
        conversationId: message.conversationId,
        content: updated.content,
        editedAt: editedAt.toISOString(),
      };
      io.to(`conversation_${message.conversationId}`).emit('message_edited', payload);
      for (const p of participants) {
        io.to(`user:${p.userId}`).emit('message_edited', payload);
      }
    }

    invalidateForConversation(message.conversationId);

    res.json(updated);
  } catch (error) {
    logger.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
};

// React to a message
exports.reactToMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    // Check if user already has a reaction on this message
    const existingReaction = await prisma.messageReaction.findUnique({
      where: {
        messageId_userId: {
          messageId: parseInt(messageId),
          userId
        }
      }
    });

    let reaction;
    if (existingReaction) {
      // If same emoji, remove it (toggle off)
      if (existingReaction.emoji === emoji) {
        await prisma.messageReaction.delete({
          where: {
            messageId_userId: {
              messageId: parseInt(messageId),
              userId
            }
          }
        });

        const message = await prisma.message.findUnique({
          where: { id: parseInt(messageId) },
          select: { conversationId: true }
        });

        req.app.get('io')?.to(`conversation_${message.conversationId}`).emit('reaction_removed', {
          messageId: parseInt(messageId),
          userId
        });

        return res.json({ removed: true });
      }

      // Different emoji, update it
      reaction = await prisma.messageReaction.update({
        where: {
          messageId_userId: {
            messageId: parseInt(messageId),
            userId
          }
        },
        data: { emoji },
        include: {
          user: {
            select: { id: true, username: true }
          }
        }
      });
    } else {
      // No existing reaction, create new one
      reaction = await prisma.messageReaction.create({
        data: {
          messageId: parseInt(messageId),
          userId,
          emoji
        },
        include: {
          user: {
            select: { id: true, username: true }
          }
        }
      });
    }

    const message = await prisma.message.findUnique({
      where: { id: parseInt(messageId) },
      select: { conversationId: true }
    });

    req.app.get('io')?.to(`conversation_${message.conversationId}`).emit('message_reaction', {
      messageId: parseInt(messageId),
      reaction
    });

    res.json(reaction);
  } catch (error) {
    logger.error('Error reacting to message:', error);
    res.status(500).json({ error: 'Failed to react to message' });
  }
};

// Search conversations
exports.searchConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.query;

    if (!query) {
      return res.json([]);
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        participants: {
          some: { userId }
        }
      },
      include: {
        participants: {
          where: {
            userId: { not: userId }
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    name: true,
                    golfPassport: { select: { photoUrl: true } }
                  }
                }
              }
            }
          }
        }
      }
    });

    const filtered = conversations.filter(conv => {
      const otherUser = conv.participants[0]?.user;
      if (!otherUser) return false;
      const searchStr = query.toLowerCase();
      return (
        otherUser.username.toLowerCase().includes(searchStr) ||
        otherUser.profile?.name?.toLowerCase().includes(searchStr)
      );
    });

    res.json(filtered.map(conv => ({
      id: conv.id,
      otherUser: {
        id: conv.participants[0].user.id,
        username: conv.participants[0].user.username,
        name: conv.participants[0].user.profile?.name || conv.participants[0].user.username,
        photoUrl: conv.participants[0].user.profile?.golfPassport?.photoUrl || null
      }
    })));
  } catch (error) {
    logger.error('Error searching conversations:', error);
    res.status(500).json({ error: 'Failed to search conversations' });
  }
};

// Get unread count
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = req.user.id;

    // The header badge polls this every 30s, so cache it. Cache is invalidated
    // on every send/read, so a stale value only persists when nothing happens.
    const cached = await cache.get(unreadCountKey(userId));
    if (cached !== null && typeof cached === 'number') {
      return res.json({ unreadCount: cached });
    }

    const result = await prisma.conversationParticipant.aggregate({
      where: { userId },
      _sum: { unreadCount: true }
    });

    const count = result._sum.unreadCount || 0;
    await cache.set(unreadCountKey(userId), count, UNREAD_TTL);

    res.json({ unreadCount: count });
  } catch (error) {
    logger.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
};
