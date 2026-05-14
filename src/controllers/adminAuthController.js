const { prisma } = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../config/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// In-memory store for view tokens (expires after 5 minutes)
const viewTokens = new Map();

// Clean up expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of viewTokens.entries()) {
    if (data.expiresAt < now) {
      viewTokens.delete(token);
    }
  }
}, 60000);

/**
 * POST /api/admin/auth/login
 * Admin login - separate from user login
 */
exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find admin by email
    const admin = await prisma.admin.findUnique({
      where: { email }
    });

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, admin.password);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: admin.id, 
        email: admin.email,
        username: admin.username,
        role: admin.role,
        isAdmin: true
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    logger.info(`Admin login successful: ${admin.email} (${admin.role})`);

    res.json({
      success: true,
      data: {
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          username: admin.username,
          role: admin.role
        }
      },
      message: 'Login successful'
    });

  } catch (error) {
    logger.error(`Admin login error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
};

/**
 * GET /api/admin/auth/me
 * Get current admin info from token
 */
exports.getAdminMe = async (req, res) => {
  try {
    const adminId = req.admin.id;

    const admin = await prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    res.json({
      success: true,
      data: { admin }
    });

  } catch (error) {
    logger.error(`Get admin me error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Failed to get admin info'
    });
  }
};

/**
 * POST /api/admin/auth/change-password
 * Change admin password
 */
exports.changeAdminPassword = async (req, res) => {
  try {
    const adminId = req.admin.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters'
      });
    }

    // Get admin with password
    const admin = await prisma.admin.findUnique({
      where: { id: adminId }
    });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, admin.password);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await prisma.admin.update({
      where: { id: adminId },
      data: { password: hashedPassword }
    });

    logger.info(`Admin password changed: ${admin.email}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    logger.error(`Change admin password error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
};

/**
 * POST /api/admin/auth/generate-view-token
 * Generate a temporary token for viewing posts (expires in 5 minutes)
 * Requires admin authentication
 */
exports.generateViewToken = async (req, res) => {
  try {
    const adminId = req.admin.id;
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({
        success: false,
        message: 'Post ID is required'
      });
    }

    // Generate a cryptographically secure random token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Store token with expiration (5 minutes)
    const expiresAt = Date.now() + (5 * 60 * 1000);
    viewTokens.set(token, {
      adminId,
      postId: parseInt(postId),
      expiresAt,
      used: false
    });

    logger.info(`Admin view token generated: adminId=${adminId}, postId=${postId}`);

    res.json({
      success: true,
      data: { token, expiresAt },
      message: 'View token generated'
    });

  } catch (error) {
    logger.error(`Generate view token error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Failed to generate view token'
    });
  }
};

/**
 * Verify and consume a view token
 * This is exported for use in postController
 */
exports.verifyViewToken = (token, postId) => {
  const tokenData = viewTokens.get(token);
  
  if (!tokenData) {
    return false;
  }
  
  // Check if token is expired
  if (tokenData.expiresAt < Date.now()) {
    viewTokens.delete(token);
    return false;
  }
  
  // Check if token is for the correct post
  if (tokenData.postId !== parseInt(postId)) {
    return false;
  }
  
  // Check if token was already used
  if (tokenData.used) {
    return false;
  }
  
  // Mark token as used (single-use)
  tokenData.used = true;
  
  // Delete token after use
  setTimeout(() => viewTokens.delete(token), 1000);
  
  return true;
};
