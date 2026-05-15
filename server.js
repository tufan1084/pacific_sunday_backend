require('dotenv').config();

const http = require('http');
const app = require('./src/app');
const { connectDB, startKeepAlive } = require('./src/config/db');
const { startCrons, bootSync } = require('./src/services/golfCronService');
const { startAuditRetentionCron } = require('./src/services/auditCronService');
const { initializeSocket } = require('./src/config/socket');
const logger = require('./src/config/logger');

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Establish database connection before accepting traffic
    await connectDB();
    startKeepAlive();

    // Golf data pipeline: boot sync (fire-and-forget) + scheduled cron jobs
    startCrons();
    bootSync().catch((err) => logger.warn(`[cron] boot sync failed: ${err.message}`));

    // Audit log retention sweep — daily 03:15 ET
    startAuditRetentionCron();

    // Create HTTP server and initialize Socket.IO
    const server = http.createServer(app);
    const io = initializeSocket(server);
    app.set('io', io); // Make io available to controllers

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    });

    // ─── Graceful Shutdown ──────────────────────────────────────────────────
    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          const { prisma } = require('./src/config/db');
          await prisma.$disconnect();
          logger.info('Database connection closed');
        } catch (err) {
          logger.error(`Error closing database connection: ${err.message}`);
        }

        process.exit(0);
      });

      // Force exit after 10 seconds if graceful shutdown stalls
      setTimeout(() => {
        logger.error('Forcefully shutting down after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      logger.error(`Unhandled Promise Rejection: ${reason}`);
    });

    process.on('uncaughtException', (err) => {
      logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
      process.exit(1);
    });
  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
