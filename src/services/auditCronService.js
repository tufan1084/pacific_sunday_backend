const cron = require('node-cron');
const { purgeExpiredLogs } = require('./auditService');
const logger = require('../config/logger');

const TZ = 'America/New_York';

/**
 * Schedule the daily audit-log retention sweep. Runs at 03:15 server time
 * (low traffic window) and deletes anything older than AuditSettings
 * .retentionDays. The settings row is read inside purgeExpiredLogs each time
 * so admins can change retention from the UI without a server restart.
 */
const startAuditRetentionCron = () => {
  cron.schedule(
    '15 3 * * *',
    async () => {
      try {
        const result = await purgeExpiredLogs();
        logger.info(
          `[cron:audit] purge complete — deleted=${result.deleted} retentionDays=${result.retentionDays} cutoff=${result.cutoff.toISOString()}`,
        );
      } catch (err) {
        logger.error(`[cron:audit] purge failed: ${err.message}`);
      }
    },
    { timezone: TZ },
  );

  logger.info('[cron:audit] daily retention cleanup scheduled (03:15 ET)');
};

module.exports = { startAuditRetentionCron };
