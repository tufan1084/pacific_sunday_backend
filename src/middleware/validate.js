const { validationResult } = require('express-validator');

/**
 * Middleware that reads express-validator results and short-circuits
 * the request with a 422 response if any validation errors exist.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path || err.param,
      message: err.msg,
    }));

    return res.status(422).json({
      success: false,
      data: { errors: formattedErrors },
      message: 'Validation failed. Please check your inputs.',
    });
  }

  next();
};

module.exports = { validate };
