const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * Middleware to authenticate admin requests
 * Verifies JWT token and checks if user is an admin
 */
exports.authenticateAdmin = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if token is for an admin
    if (!decoded.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }

    // Attach admin info to request
    req.admin = {
      id: decoded.id,
      email: decoded.email,
      username: decoded.username,
      role: decoded.role
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }

    logger.error(`Admin auth middleware error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

/**
 * Middleware to check if admin is a superadmin
 */
exports.requireSuperAdmin = (req, res, next) => {
  if (req.admin.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Superadmin privileges required.'
    });
  }
  next();
};
