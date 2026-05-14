const logger = require('../config/logger');

/**
 * 404 handler — called when no route matched.
 */
const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

/**
 * Global error handler — must have 4 arguments for Express to treat it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;

  const isDevelopment = process.env.NODE_ENV === 'development';

  if (statusCode >= 500) {
    logger.error(`[${statusCode}] ${err.message}`, { stack: err.stack, path: req.originalUrl });
  } else {
    logger.warn(`[${statusCode}] ${err.message}`, { path: req.originalUrl });
  }

  const response = {
    success: false,
    data: null,
    message: err.message || 'An unexpected error occurred',
  };

  if (isDevelopment && statusCode >= 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = { notFound, errorHandler };
