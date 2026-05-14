const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');

const prisma = new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'event',
      level: 'error',
    },
    {
      emit: 'event',
      level: 'warn',
    },
  ],
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    logger.debug(`Prisma Query: ${e.query} | Duration: ${e.duration}ms`);
  });
}

prisma.$on('error', (e) => {
  logger.error(`Prisma Error: ${e.message}`);
});

prisma.$on('warn', (e) => {
  logger.warn(`Prisma Warning: ${e.message}`);
});

const connectDB = async () => {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000; // 3 seconds between retries (Neon cold start takes ~3-7s)

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        logger.info(`Retry ${attempt}/${MAX_RETRIES} — waiting ${RETRY_DELAY_MS / 1000}s for Neon to wake up...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      // Sync database schema with Prisma schema (generate client so new models are callable).
      const { execSync } = require('child_process');
      logger.info('Syncing database schema...');
      execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
      logger.info('Database schema synced successfully');

      await prisma.$connect();
      logger.info('PostgreSQL database connected via Prisma');
      return; // success — exit the loop
    } catch (error) {
      logger.warn(`Connection attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);

      if (attempt === MAX_RETRIES) {
        logger.error('All connection attempts failed. Exiting.');
        process.exit(1);
      }
    }
  }
};

// Keep Neon alive — ping every 4 minutes to prevent cold sleep
const startKeepAlive = () => {
  const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

  setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      logger.warn(`Keep-alive ping failed: ${err.message}`);
    }
  }, INTERVAL_MS);

  logger.info('Neon keep-alive started (every 4 min)');
};

module.exports = { prisma, connectDB, startKeepAlive };
