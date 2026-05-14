const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { processAndUploadImage } = require('../utils/imageProcessor');
const {
  emitTeamCreated,
  emitTeamMemberChanged,
  emitTeamUpdated,
  emitTeamJoinRequest,
  emitTeamInvite,
} = require('../config/socket');
const { createNotification, notifyTeamAdmins } = require('../services/notificationService');

const prisma = new PrismaClient();

/**
 * GET /teams
 * List all teams, annotated with memberCount and isMember for the current user.
 */
const listTeams = async (req, res, next) => {
  try {
    const userId = req.user?.id || null;

    // Dropdown is "teams I've joined" — non-members see nothing here.
    // Public team discovery happens via search; joining a public team is instant.
    if (!userId) {
      return res.status(200).json({ success: true, data: { teams: [] } });
    }
    const where = { members: { some: { userId } } };

    const teams = await prisma.team.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { members: true } },
        members: userId ? { where: { userId }, select: { id: true, role: true } } : false,
      },
    });

    const data = teams.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      imageUrl: t.imageUrl,
      privacy: t.privacy,
      creatorId: t.creatorId,
      memberCount: t._count.members,
      isMember: userId ? t.members.length > 0 : false,
      role: userId && t.members.length > 0 ? t.members[0].role : null,
      createdAt: t.createdAt,
    }));

    return res.status(200).json({ success: true, data: { teams: data } });
  } catch (error) {
    logger.error(`listTeams error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /teams/:teamId
 * Get single team with members list. Private teams only visible to members.
 */
const getTeam = async (req, res, next) => {
  try {
    const teamId = parseInt(req.params.teamId);
    const userId = req.user?.id || null;

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        _count: { select: { members: true } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                profile: {
                  select: {
                    name: true,
                    golfPassport: { select: { photoUrl: true } },
                  },
                },
              },
            },
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });

    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    const isMember = userId ? team.members.some(m => m.userId === userId) : false;

    // Private non-members get a limited preview so they can decide whether to
    // request access. Full member list is hidden until they join.
    if (team.privacy === 'private' && !isMember) {
      let hasPendingRequest = false;
      if (userId) {
        const existing = await prisma.teamJoinRequest.findUnique({
          where: { teamId_userId: { teamId, userId } },
        });
        hasPendingRequest = existing?.status === 'pending';
      }

      return res.status(200).json({
        success: true,
        data: {
          team: {
            id: team.id,
            name: team.name,
            description: team.description,
            imageUrl: team.imageUrl,
            privacy: team.privacy,
            creatorId: team.creatorId,
            memberCount: team._count.members,
            isMember: false,
            isPreview: true,
            hasPendingRequest,
            createdAt: team.createdAt,
            members: [],
          },
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        team: {
          id: team.id,
          name: team.name,
          description: team.description,
          imageUrl: team.imageUrl,
          privacy: team.privacy,
          creatorId: team.creatorId,
          memberCount: team._count.members,
          isMember,
          isPreview: false,
          createdAt: team.createdAt,
          members: team.members.map(m => ({
            id: m.user.id,
            username: m.user.username,
            name: m.user.profile?.name || m.user.username,
            avatarUrl: m.user.profile?.golfPassport?.photoUrl || null,
            role: m.role,
            joinedAt: m.joinedAt,
          })),
        },
      },
    });
  } catch (error) {
    logger.error(`getTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams
 * Create a new team. Creator becomes the first admin member.
 * Optionally invite other users by id.
 */
const createTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, description, imageUrl, privacy = 'public', memberIds = [] } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Team name must be at least 3 characters' });
    }
    if (!['public', 'private'].includes(privacy)) {
      return res.status(400).json({ success: false, message: 'Invalid privacy value' });
    }

    const trimmedName = name.trim();

    const existing = await prisma.team.findUnique({ where: { name: trimmedName } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A team with this name already exists' });
    }

    const uniqueInviteIds = Array.from(new Set((memberIds || []).map(Number).filter(n => Number.isInteger(n) && n !== userId)));

    const team = await prisma.team.create({
      data: {
        name: trimmedName,
        description: description?.trim() || null,
        imageUrl: imageUrl?.trim() || null,
        privacy,
        creatorId: userId,
        members: {
          create: [
            { userId, role: 'admin' },
            ...uniqueInviteIds.map(id => ({ userId: id, role: 'member' })),
          ],
        },
      },
      include: {
        _count: { select: { members: true } },
      },
    });

    const responsePayload = {
      id: team.id,
      name: team.name,
      description: team.description,
      imageUrl: team.imageUrl,
      privacy: team.privacy,
      creatorId: team.creatorId,
      memberCount: team._count.members,
      isMember: true,
      role: 'admin',
      createdAt: team.createdAt,
    };

    // Broadcast payload is user-agnostic — include memberIds so each client
    // can decide whether to show the team and compute its own isMember/role.
    const broadcastPayload = {
      id: team.id,
      name: team.name,
      description: team.description,
      imageUrl: team.imageUrl,
      privacy: team.privacy,
      creatorId: team.creatorId,
      memberCount: team._count.members,
      memberIds: [userId, ...uniqueInviteIds],
      createdAt: team.createdAt,
    };

    logger.info(`Team created: id=${team.id} name=${team.name} by userId=${userId}`);
    emitTeamCreated(broadcastPayload);

    return res.status(201).json({ success: true, data: { team: responsePayload } });
  } catch (error) {
    logger.error(`createTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/join
 * Join a public team OR request to join a private team
 */
const joinTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Already a member of this team' });
    }

    // Private team - create join request
    if (team.privacy === 'private') {
      const existingRequest = await prisma.teamJoinRequest.findUnique({
        where: { teamId_userId: { teamId, userId } },
      });
      if (existingRequest) {
        return res.status(409).json({ success: false, message: 'Join request already sent' });
      }

      const joinRequest = await prisma.teamJoinRequest.create({
        data: { teamId, userId, status: 'pending' },
      });

      emitTeamJoinRequest(teamId, userId, 'created');

      // Notify every admin of this team
      await notifyTeamAdmins({
        teamId,
        type: 'TEAM_JOIN_REQUEST',
        actorId: userId,
        entityType: 'team',
        entityId: teamId,
        data: { teamName: team.name, requestId: joinRequest.id },
      });

      return res.status(200).json({
        success: true,
        message: 'Join request sent',
      });
    }

    // Public team - join immediately
    await prisma.teamMember.create({ data: { teamId, userId, role: 'member' } });
    const memberCount = await prisma.teamMember.count({ where: { teamId } });

    emitTeamMemberChanged(teamId, memberCount, userId, 'joined');

    return res.status(200).json({
      success: true,
      data: { teamId, memberCount, isMember: true },
      message: 'Joined team',
    });
  } catch (error) {
    logger.error(`joinTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/leave
 * Leave a team. Creator cannot leave their own team.
 */
const leaveTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }
    if (team.creatorId === userId) {
      return res.status(400).json({ success: false, message: 'Team creator cannot leave their own team' });
    }

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Not a member of this team' });
    }

    await prisma.teamMember.delete({ where: { id: existing.id } });
    const memberCount = await prisma.teamMember.count({ where: { teamId } });

    emitTeamMemberChanged(teamId, memberCount, userId, 'left');

    return res.status(200).json({
      success: true,
      data: { teamId, memberCount, isMember: false },
      message: 'Left team',
    });
  } catch (error) {
    logger.error(`leaveTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /users/search?q=...
 * Search users by username or profile name — used by Add Team invite step.
 */
const searchUsers = async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) {
      return res.status(200).json({ success: true, data: { users: [] } });
    }
    const currentUserId = req.user?.id;
    const users = await prisma.user.findMany({
      where: {
        AND: [
          currentUserId ? { NOT: { id: currentUserId } } : {},
          {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { profile: { name: { contains: q, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        username: true,
        profile: { select: { name: true } },
      },
      take: 10,
    });

    const data = users.map(u => ({
      id: u.id,
      username: u.username,
      name: u.profile?.name || u.username,
    }));
    return res.status(200).json({ success: true, data: { users: data } });
  } catch (error) {
    logger.error(`searchUsers error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /teams/:teamId/join-requests
 * Get pending join requests for a team (admin only)
 */
const getJoinRequests = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);

    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member || member.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const requests = await prisma.teamJoinRequest.findMany({
      where: { teamId, status: 'pending' },
      include: {
        team: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const userIds = requests.map(r => r.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        profile: { select: { name: true } },
      },
    });

    const data = requests.map(r => {
      const user = users.find(u => u.id === r.userId);
      return {
        id: r.id,
        userId: r.userId,
        username: user?.username,
        name: user?.profile?.name || user?.username,
        createdAt: r.createdAt,
      };
    });

    return res.status(200).json({ success: true, data: { requests: data } });
  } catch (error) {
    logger.error(`getJoinRequests error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/join-requests/:requestId/approve
 * Approve a join request (admin only)
 */
const approveJoinRequest = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const requestId = parseInt(req.params.requestId);

    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member || member.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const request = await prisma.teamJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.teamId !== teamId) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }

    await prisma.$transaction([
      prisma.teamJoinRequest.update({
        where: { id: requestId },
        data: { status: 'approved' },
      }),
      prisma.teamMember.create({
        data: { teamId, userId: request.userId, role: 'member' },
      }),
    ]);

    const memberCount = await prisma.teamMember.count({ where: { teamId } });
    emitTeamMemberChanged(teamId, memberCount, request.userId, 'joined');
    emitTeamJoinRequest(teamId, request.userId, 'approved');

    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    await createNotification({
      userId: request.userId,
      type: 'TEAM_JOIN_APPROVED',
      actorId: userId,
      entityType: 'team',
      entityId: teamId,
      teamId,
      data: { teamName: team?.name },
    });

    return res.status(200).json({
      success: true,
      data: { memberCount },
      message: 'Join request approved',
    });
  } catch (error) {
    logger.error(`approveJoinRequest error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/join-requests/:requestId/reject
 * Reject a join request (admin only)
 */
const rejectJoinRequest = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const requestId = parseInt(req.params.requestId);

    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member || member.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const request = await prisma.teamJoinRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.teamId !== teamId) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request already processed' });
    }

    await prisma.teamJoinRequest.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    emitTeamJoinRequest(teamId, request.userId, 'rejected');

    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    await createNotification({
      userId: request.userId,
      type: 'TEAM_JOIN_REJECTED',
      actorId: userId,
      entityType: 'team',
      entityId: teamId,
      teamId,
      data: { teamName: team?.name },
    });

    return res.status(200).json({
      success: true,
      message: 'Join request rejected',
    });
  } catch (error) {
    logger.error(`rejectJoinRequest error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/invite
 * Invite users to team (admin only)
 */
const inviteToTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'userIds array required' });
    }

    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member || member.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const invites = [];
    for (const inviteeId of userIds) {
      // Check if already a member
      const existing = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: inviteeId } },
      });
      if (existing) {
        logger.info(`Skipping invite for userId=${inviteeId} - already a member`);
        continue;
      }

      // Delete old invites (accepted/declined) FIRST to avoid unique constraint issues
      const oldInvites = await prisma.teamInvite.findMany({
        where: { teamId, userId: inviteeId },
      });
      
      if (oldInvites.length > 0) {
        const oldStatuses = oldInvites.map(i => i.status).join(', ');
        logger.info(`Found ${oldInvites.length} old invite(s) for userId=${inviteeId} with status: ${oldStatuses}`);
        
        // If there's a pending invite, skip
        if (oldInvites.some(i => i.status === 'pending')) {
          logger.info(`Skipping invite for userId=${inviteeId} - pending invite already exists`);
          continue;
        }
        
        // Delete old processed invites
        const deleted = await prisma.teamInvite.deleteMany({
          where: { teamId, userId: inviteeId },
        });
        logger.info(`Deleted ${deleted.count} old processed invite(s) for userId=${inviteeId}`);
      }

      // Create new invite
      const invite = await prisma.teamInvite.create({
        data: { teamId, userId: inviteeId, invitedBy: userId, status: 'pending' },
      });
      invites.push(invite);
      logger.info(`Created invite id=${invite.id} for userId=${inviteeId}`);
      emitTeamInvite(teamId, inviteeId, 'created');

      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
      await createNotification({
        userId: inviteeId,
        type: 'TEAM_INVITED',
        actorId: userId,
        entityType: 'team',
        entityId: teamId,
        teamId,
        data: { teamName: team?.name, inviteId: invite.id },
      });
    }

    return res.status(200).json({
      success: true,
      data: { inviteCount: invites.length },
      message: `${invites.length} invite(s) sent`,
    });
  } catch (error) {
    logger.error(`inviteToTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /teams/invites
 * Get pending invites for current user
 */
const getMyInvites = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const invites = await prisma.teamInvite.findMany({
      where: { userId, status: 'pending' },
      include: {
        team: { select: { id: true, name: true, description: true, privacy: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = invites.map(i => ({
      id: i.id,
      teamId: i.teamId,
      teamName: i.team.name,
      teamDescription: i.team.description,
      teamPrivacy: i.team.privacy,
      invitedBy: i.invitedBy,
      createdAt: i.createdAt,
    }));

    return res.status(200).json({ success: true, data: { invites: data } });
  } catch (error) {
    logger.error(`getMyInvites error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/invites/:inviteId/accept
 * Accept a team invite
 */
const acceptInvite = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const inviteId = parseInt(req.params.inviteId);

    const invite = await prisma.teamInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite || invite.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Invite already processed' });
    }

    await prisma.$transaction([
      prisma.teamInvite.update({
        where: { id: inviteId },
        data: { status: 'accepted' },
      }),
      prisma.teamMember.create({
        data: { teamId: invite.teamId, userId, role: 'member' },
      }),
    ]);

    const memberCount = await prisma.teamMember.count({ where: { teamId: invite.teamId } });
    emitTeamMemberChanged(invite.teamId, memberCount, userId, 'joined');
    emitTeamInvite(invite.teamId, userId, 'accepted');

    return res.status(200).json({
      success: true,
      data: { teamId: invite.teamId, memberCount },
      message: 'Invite accepted',
    });
  } catch (error) {
    logger.error(`acceptInvite error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/invites/:inviteId/decline
 * Decline a team invite
 */
const declineInvite = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const inviteId = parseInt(req.params.inviteId);

    const invite = await prisma.teamInvite.findUnique({
      where: { id: inviteId },
    });
    if (!invite || invite.userId !== userId) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Invite already processed' });
    }

    await prisma.teamInvite.update({
      where: { id: inviteId },
      data: { status: 'declined' },
    });

    emitTeamInvite(invite.teamId, userId, 'declined');

    return res.status(200).json({
      success: true,
      message: 'Invite declined',
    });
  } catch (error) {
    logger.error(`declineInvite error: ${error.message}`);
    next(error);
  }
};

/**
 * PUT /teams/:teamId
 * Update team info (admin only)
 */
const updateTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const { name, description, imageUrl, privacy } = req.body;

    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member || member.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const updateData = {};
    if (name && name.trim().length >= 3) {
      const existing = await prisma.team.findFirst({
        where: { name: name.trim(), NOT: { id: teamId } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Team name already taken' });
      }
      updateData.name = name.trim();
    }
    if (description !== undefined) {
      updateData.description = description?.trim() || null;
    }
    if (imageUrl !== undefined) {
      updateData.imageUrl = imageUrl?.trim() || null;
    }
    if (privacy && ['public', 'private'].includes(privacy)) {
      updateData.privacy = privacy;
    }

    const team = await prisma.team.update({
      where: { id: teamId },
      data: updateData,
    });

    emitTeamUpdated(teamId, team);

    return res.status(200).json({
      success: true,
      data: { team },
      message: 'Team updated',
    });
  } catch (error) {
    logger.error(`updateTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/:teamId/members/:memberId/promote
 * Promote member to admin (admin only)
 */
const promoteMember = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const memberId = parseInt(req.params.memberId);

    const adminMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!adminMember || adminMember.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const targetMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberId } },
    });
    if (!targetMember) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }
    if (targetMember.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Already an admin' });
    }

    await prisma.teamMember.update({
      where: { id: targetMember.id },
      data: { role: 'admin' },
    });

    emitTeamMemberChanged(teamId, null, memberId, 'promoted');

    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    await createNotification({
      userId: memberId,
      type: 'TEAM_ROLE_CHANGED',
      actorId: userId,
      entityType: 'team',
      entityId: teamId,
      teamId,
      data: { teamName: team?.name, newRole: 'admin' },
    });

    return res.status(200).json({
      success: true,
      message: 'Member promoted to admin',
    });
  } catch (error) {
    logger.error(`promoteMember error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /teams/:teamId/members/:memberId
 * Remove member from team (admin only)
 */
const removeMember = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);
    const memberId = parseInt(req.params.memberId);

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }
    if (team.creatorId === memberId) {
      return res.status(400).json({ success: false, message: 'Cannot remove team creator' });
    }

    const adminMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!adminMember || adminMember.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const targetMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberId } },
    });
    if (!targetMember) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    await prisma.teamMember.delete({ where: { id: targetMember.id } });
    const memberCount = await prisma.teamMember.count({ where: { teamId } });

    emitTeamMemberChanged(teamId, memberCount, memberId, 'removed');

    await createNotification({
      userId: memberId,
      type: 'TEAM_REMOVED',
      actorId: userId,
      entityType: 'team',
      entityId: teamId,
      teamId,
      data: { teamName: team.name },
    });

    return res.status(200).json({
      success: true,
      data: { memberCount },
      message: 'Member removed',
    });
  } catch (error) {
    logger.error(`removeMember error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /teams/:teamId
 * Delete team (creator only)
 */
const deleteTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const teamId = parseInt(req.params.teamId);

    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found' });
    }

    // Only team creator can delete the team
    if (team.creatorId !== userId) {
      return res.status(403).json({ success: false, message: 'Only team creator can delete the team' });
    }

    // Delete team (cascade will handle members, posts, invites, join requests)
    await prisma.team.delete({ where: { id: teamId } });

    logger.info(`Team deleted: id=${teamId} name=${team.name} by userId=${userId}`);

    // Emit team deleted event
    const { getIO } = require('../config/socket');
    try {
      const io = getIO();
      io.emit('team:deleted', { teamId });
      logger.info(`Emitted team:deleted event for team ${teamId}`);
    } catch (socketError) {
      logger.warn(`Failed to emit team:deleted event: ${socketError.message}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Team deleted successfully',
    });
  } catch (error) {
    logger.error(`deleteTeam error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /teams/upload-image
 * Upload a team avatar. Returns { imageUrl } (S3 location) for the client
 * to pass into createTeam / updateTeam. Does not persist anything on its own.
 */
const uploadTeamImageHandler = async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const out = await processAndUploadImage({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalName: req.file.originalname,
      keyPrefix: `community/team/team-${unique}`,
    });
    return res.status(200).json({
      success: true,
      data: { imageUrl: out.location },
    });
  } catch (error) {
    logger.error(`uploadTeamImageHandler error: ${error.message}`);
    next(error);
  }
};

module.exports = {
  listTeams,
  getTeam,
  createTeam,
  joinTeam,
  leaveTeam,
  searchUsers,
  getJoinRequests,
  approveJoinRequest,
  rejectJoinRequest,
  inviteToTeam,
  getMyInvites,
  acceptInvite,
  declineInvite,
  updateTeam,
  promoteMember,
  removeMember,
  deleteTeam,
  uploadTeamImageHandler,
};
