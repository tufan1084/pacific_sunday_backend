const { verifyToken, findUserById } = require('../services/authService');
const logger = require('../config/logger');

/**
 * Middleware that validates a JWT from the Authorization header and
 * attaches the authenticated user to req.user.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.slice(7);

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          data: null,
          message: 'Token has expired. Please log in again.',
        });
      }
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid token.',
      });
    }

    const user = await findUserById(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'User associated with this token no longer exists.',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error(`Auth middleware error: ${error.message}`);
    next(error);
  }
};

module.exports = { authenticate };
