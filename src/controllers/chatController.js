const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../config/logger');

// Get all conversations for current user
exports.getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

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

    res.json(formatted);
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
        deletedAt: null
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
              select: { id: true, username: true }
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

    // Create message
    const message = await prisma.message.create({
      data: {
        conversationId: parseInt(conversationId),
        senderId: userId,
        content: content.trim(),
        messageType: 'TEXT',
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
        reactions: true,
        replyTo: {
          select: {
            id: true,
            content: true,
            messageType: true,
            sender: { select: { id: true, username: true } }
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

    // Emit socket event (handled in socket setup)
    req.app.get('io')?.to(`conversation_${conversationId}`).emit('new_message', message);

    res.json(message);
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

    // Emit socket event
    req.app.get('io')?.to(`conversation_${conversationId}`).emit('new_message', message);

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

    // Update deliveries to READ
    await prisma.messageDelivery.updateMany({
      where: {
        userId,
        message: {
          conversationId: parseInt(conversationId)
        },
        status: { not: 'READ' }
      },
      data: {
        status: 'READ',
        timestamp: new Date()
      }
    });

    // Reset unread count
    await prisma.conversationParticipant.updateMany({
      where: {
        conversationId: parseInt(conversationId),
        userId
      },
      data: {
        unreadCount: 0,
        lastReadAt: new Date()
      }
    });

    // Emit socket event for read receipts
    req.app.get('io')?.to(`conversation_${conversationId}`).emit('messages_read', {
      conversationId: parseInt(conversationId),
      userId
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
};

// Delete a message
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

    // Soft delete
    await prisma.message.update({
      where: { id: parseInt(messageId) },
      data: { deletedAt: new Date() }
    });

    // Emit socket event
    req.app.get('io')?.to(`conversation_${message.conversationId}`).emit('message_deleted', {
      messageId: parseInt(messageId),
      conversationId: message.conversationId
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
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

    const result = await prisma.conversationParticipant.aggregate({
      where: { userId },
      _sum: { unreadCount: true }
    });

    res.json({ unreadCount: result._sum.unreadCount || 0 });
  } catch (error) {
    logger.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
};
