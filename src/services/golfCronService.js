const cron = require('node-cron');
const { prisma } = require('../config/db');
const sync = require('./golfSyncService');
const points = require('./pointsService');
const h2hService = require('./h2hService');
const logger = require('../config/logger');

const TZ = 'America/New_York';
let liveLeaderboardJob = null; // Store the dynamic cron job
const run = async (label, fn) => {
  try {
    logger.info(`[cron:${label}] starting`);
    await fn();
    logger.info(`[cron:${label}] done`);
  } catch (err) {
    logger.error(`[cron:${label}] failed: ${err.message}`);
  }
};

const currentYear = () => new Date().getFullYear();

// Fetch field + tiers for upcoming tournaments:
//   - Always the next 2 (so homepage + detail are always ready)
//   - Plus anything starting in the next 21 days
const syncUpcomingFields = async () => {
  const now = new Date();
  const threeWeeks = new Date(now.getTime() + 21 * 86400000);
  const windowed = await prisma.tournament.findMany({
    where: {
      year: currentYear(),
      status: 'upcoming',
      startDate: { gte: now, lte: threeWeeks },
    },
    orderBy: { startDate: 'asc' },
  });
  const nextTwo = await prisma.tournament.findMany({
    where: { year: currentYear(), status: 'upcoming', startDate: { gte: now } },
    orderBy: { startDate: 'asc' },
    take: 2,
  });
  const byId = new Map();
  for (const t of [...windowed, ...nextTwo]) byId.set(t.id, t);
  for (const t of byId.values()) {
    try { await sync.syncFieldAndTiers(t.tournId, t.year); }
    catch (err) { logger.warn(`[cron:field] ${t.tournId}: ${err.message}`); }
  }
};

// Refresh leaderboard for any live tournament
const syncLiveLeaderboards = async () => {
  await sync.refreshStatuses(currentYear());
  await h2hService.expirePendingChallengesPastLockDeadline();
  const live = await prisma.tournament.findMany({
    where: { year: currentYear(), status: 'live' },
  });
  for (const t of live) {
    try {
      // Skip if recently synced (within last interval) and has data
      const lastSync = t.lastSyncedAt ? new Date(t.lastSyncedAt) : null;
      const hasLeaderboard = t.leaderboard?.rows?.length > 0;
      const settings = await prisma.golfSettings.findFirst();
      const interval = (settings?.leaderboardSyncInterval || 15) * 60 * 1000;
      
      if (lastSync && hasLeaderboard && (Date.now() - lastSync.getTime() < interval)) {
        logger.info(`[cron:lb] ${t.tournId}: skipping, synced ${Math.floor((Date.now() - lastSync.getTime()) / 60000)} min ago`);
        continue;
      }
      
      await sync.syncLeaderboard(t.tournId, t.year);
      // Also capture round snapshots for tournaments nearing completion
      await sync.captureRoundSnapshots(t.tournId, t.year);
    }
    catch (err) { logger.warn(`[cron:lb] ${t.tournId}: ${err.message}`); }
  }
};

// Final leaderboard pull + status flip + points award for any tournaments that
// just ended. Points award is idempotent (skips picks already scored) so
// re-runs are safe.
const syncCompletedLeaderboards = async () => {
  await sync.refreshStatuses(currentYear());
  await h2hService.expirePendingChallengesPastLockDeadline();
  const now = new Date();
  const justEnded = await prisma.tournament.findMany({
    where: {
      year: currentYear(),
      status: { in: ['live', 'completed'] },
      endDate: { gte: new Date(now.getTime() - 48 * 3600000), lte: now },
    },
  });
  for (const t of justEnded) {
    try { await sync.syncLeaderboard(t.tournId, t.year); }
    catch (err) { logger.warn(`[cron:final] ${t.tournId}: ${err.message}`); continue; }

    // Re-read to pick up the fresh leaderboard + any status flip from the sync.
    const fresh = await prisma.tournament.findUnique({ where: { id: t.id } });
    if (fresh?.status === 'completed') {
      try { await points.awardTournamentPoints(fresh.id); }
      catch (err) { logger.warn(`[cron:award] ${t.tournId}: ${err.message}`); }

      // Settle every LOCKED H2H challenge for this tournament. Idempotent —
      // already-settled challenges are skipped, so re-runs after partial
      // failures are safe.
      try { await h2hService.settleChallenges(fresh.id); }
      catch (err) { logger.warn(`[cron:h2h-settle] ${t.tournId}: ${err.message}`); }
    }
  }
};

// Start the dynamic live leaderboard cron job
const startLiveLeaderboardCron = async () => {
  // Get the interval from settings
  const settings = await prisma.golfSettings.findFirst();
  const interval = settings?.leaderboardSyncInterval || 15;
  
  // Stop existing job if running
  if (liveLeaderboardJob) {
    liveLeaderboardJob.stop();
  }
  
  // Create cron expression: */interval 6-21 * * 4-6,0 (Thu-Sun 6am-9pm PT with 1hr buffer)
  const cronExpression = `*/${interval} 6-21 * * 4-6,0`;
  
  liveLeaderboardJob = cron.schedule(
    cronExpression,
    () => run('live-leaderboard', syncLiveLeaderboards),
    { timezone: 'America/Los_Angeles' }
  );
  
  logger.info(`[cron] live leaderboard job started with ${interval} min interval`);
};

exports.startCrons = async () => {
  // 6:00 AM ET daily → refresh schedule + statuses
  cron.schedule('0 6 * * *', () =>
    run('daily-schedule', async () => {
      await sync.syncSchedule(currentYear());
      await sync.refreshStatuses(currentYear());
      await h2hService.expirePendingChallengesPastLockDeadline();
    }), { timezone: TZ });

  cron.schedule('* * * * *', () =>
    run('h2h-expiry', async () => {
      await sync.refreshStatuses(currentYear());
      await h2hService.expirePendingChallengesPastLockDeadline();
    }), { timezone: 'America/Los_Angeles' });

  // 7:00 AM ET Monday → refresh OWGR (published weekly)
  cron.schedule('0 7 * * 1', () =>
    run('weekly-owgr', () => sync.syncWorldRanking(currentYear())), { timezone: TZ });

  // Every 2 hours between Fri 6pm and Wed 6pm → pull entry lists as they publish
  cron.schedule('0 */2 * * *', () => run('field-sweep', syncUpcomingFields), { timezone: TZ });

  // Dynamic live leaderboard sync (configurable interval)
  await startLiveLeaderboardCron();

  // Mon 8am ET → final pull for tournaments that ended Sunday
  cron.schedule('0 8 * * 1', () => run('weekly-wrapup', syncCompletedLeaderboards), { timezone: TZ });

  logger.info('[cron] golf cron jobs registered (America/New_York)');
};

// Export function to update the live leaderboard interval dynamically
exports.updateLiveLeaderboardInterval = async () => {
  await startLiveLeaderboardCron();
};

// Run once at boot (idempotent — uses cache if fresh)
exports.bootSync = async () => {
  await run('boot:schedule', () => sync.syncSchedule(currentYear()));
  await run('boot:owgr', () => sync.syncWorldRanking(currentYear()));
  await run('boot:field', syncUpcomingFields);
  await run('boot:status', () => sync.refreshStatuses(currentYear()));
  await run('boot:h2h-expiry', () => h2hService.expirePendingChallengesPastLockDeadline());
  // Without this, restarting on a tournament day leaves the UI stale until the
  // next hourly cron fire. Pull live leaderboards immediately on boot.
  await run('boot:live-leaderboard', syncLiveLeaderboards);
};
