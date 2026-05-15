const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for the /bag NFC scan endpoint.
 * Allows 30 requests per minute per IP address.
 */
const bagLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    message: 'Too many scan requests from this IP. Please try again in a minute.',
  },
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Rate limiter for /auth routes.
 * Allows 10 requests per minute per IP address.
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    message: 'Too many authentication attempts from this IP. Please try again in a minute.',
  },
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

module.exports = { bagLimiter, authLimiter };
