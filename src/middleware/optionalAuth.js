const jwt = require('jsonwebtoken');
const { findUserById } = require('../services/authService');
const logger = require('../config/logger');

/**
 * Optional authentication middleware
 * Attaches user to req if token is valid, but doesn't block if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided - continue as guest
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      logger.error('JWT_SECRET is not configured');
      req.user = null;
      return next();
    }

    try {
      const decoded = jwt.verify(token, secret);
      const user = await findUserById(decoded.id);

      if (!user) {
        req.user = null;
        return next();
      }

      req.user = user;
      next();
    } catch (err) {
      // Invalid token - continue as guest
      req.user = null;
      next();
    }
  } catch (error) {
    logger.error(`Optional auth error: ${error.message}`);
    req.user = null;
    next();
  }
};

module.exports = { optionalAuth };
