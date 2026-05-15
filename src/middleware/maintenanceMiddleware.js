const { getPlatformSettings } = require('../services/platformSettingsService');
const logger = require('../config/logger');

// Paths that must keep working even during maintenance so admins can turn it
// back off and monitoring/login still functions.
const ALLOW_PREFIXES = [
  '/api/admin',   // entire admin panel (incl. admin login + settings)
  '/api/health',  // health checks / uptime probes
];

/**
 * When PlatformSettings.maintenanceMode is on, reject all non-admin API
 * traffic with 503 so end users see a maintenance state while admins can
 * still operate. Read traffic is blocked too — maintenance means the whole
 * user-facing API is paused.
 *
 * Fails open: if the settings lookup throws, we let the request through
 * rather than hard-down the whole API on a transient DB hiccup.
 */
const maintenanceGuard = async (req, res, next) => {
  try {
    if (ALLOW_PREFIXES.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const settings = await getPlatformSettings();
    if (!settings.maintenanceMode) {
      return next();
    }

    return res.status(503).json({
      success: false,
      data: null,
      code: 'MAINTENANCE_MODE',
      message: 'The platform is temporarily down for maintenance. Please check back shortly.',
    });
  } catch (err) {
    logger.warn(`maintenanceGuard skipped (lookup failed): ${err.message}`);
    next();
  }
};

module.exports = { maintenanceGuard };
