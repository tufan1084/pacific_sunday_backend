const { prisma } = require('../config/db');
const sync = require('../services/golfSyncService');
const logger = require('../config/logger');

// Picks lock at midnight PT of the tournament start date (same moment it flips to "live").
// Gives users until Wed 11:59 PM PT to finalize; locks ~5h before Thursday's first tee.
const picksLocked = (tournament) => {
  if (!tournament?.startDate) return false;
  if (tournament.status === 'live' || tournament.status === 'completed') return true;
  return new Date() >= new Date(tournament.startDate);
};

const currentYear = (req) => Number(req.query.year) || new Date().getFullYear();

// BigInt → string for JSON serialization
const bigToStr = (v) => (v == null ? null : typeof v === 'bigint' ? v.toString() : v);

const serializeTournament = (t) => ({
  id: t.id,
  tournId: t.tournId,
  year: t.year,
  name: t.name,
  status: t.status,
  startDate: t.startDate ? t.startDate.toISOString() : null,
  endDate: t.endDate ? t.endDate.toISOString() : null,
  courseName: t.courseName,
  city: t.city,
  state: t.state,
  country: t.country,
  purse: bigToStr(t.purse),
  fedexCupPoints: t.fedexPoints,
  isMajor: t.isMajor,
  fieldAvailable: t.fieldAvailable,
  h2hMultiplier: t.h2hMultiplier,
  h2hBonusDescription: t.h2hBonusDescription,
});

// ─── GET /api/golf/tournaments?year=2026 ─────────────────────────────────────
// Groups by status. Refreshes status from date before returning.
exports.getTournaments = async (req, res) => {
  try {
    const year = currentYear(req);
    await sync.refreshStatuses(year);

    const all = await prisma.tournament.findMany({
      where: { year },
      orderBy: { startDate: 'asc' },
    });

    const out = { live: [], upcoming: [], completed: [] };
    for (const t of all) out[t.status].push(serializeTournament(t));
    out.completed.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

    res.json({ success: true, data: out });
  } catch (error) {
    logger.error(`getTournaments failed: ${error.message}`);
    res.json({ success: false, data: { live: [], upcoming: [], completed: [] }, message: error.message });
  }
};

// ─── GET /api/golf/tournament/:tournId/fantasy?year=2026 ────────────────────
// SINGLE-CALL endpoint for the tournament detail page.
// Returns tournament meta + tiers (field + OWGR-based quintiles) + leaderboard if live/completed.
// Lazy-syncs field/tiers if missing — ensures any tournament user clicks loads its field.
exports.getTournamentFantasy = async (req, res) => {
  try {
    const { tournId } = req.params;
    const year = currentYear(req);

    let t = await prisma.tournament.findUnique({
      where: { tournId_year: { tournId: String(tournId), year } },
    });
    if (!t) {
      return res.json({ success: false, message: `Tournament ${tournId}/${year} not found` });
    }

    // Lazy-sync field + tiers if missing (tournament outside the 10-day cron window, or first visit)
    const tiersArr = Array.isArray(t.tiers) ? t.tiers : [];
    const hasTiers = tiersArr.length > 0 && tiersArr.some((x) => x?.players?.length > 0);
    if (!hasTiers && t.status !== 'completed') {
      try {
        await sync.syncFieldAndTiers(tournId, year);
        t = await prisma.tournament.findUnique({
          where: { tournId_year: { tournId: String(tournId), year } },
        });
      } catch (err) {
        logger.warn(`lazy syncFieldAndTiers ${tournId}/${year} failed: ${err.message}`);
      }
    }

    // Lazy-sync leaderboard for live tournaments so the UI self-heals between
    // cron ticks (and recovers if a prior cron landed in a placeholder-rows
    // window). Throttled to the same 3-min TTL as the upstream API cache —
    // repeat visits inside that window reuse whatever is already in the DB.
    if (t.status === 'live') {
      const existingRows = Array.isArray(t.leaderboard?.rows) ? t.leaderboard.rows : [];
      const ageMs = t.leaderboard?.updatedAt
        ? Date.now() - new Date(t.leaderboard.updatedAt).getTime()
        : Infinity;
      if (existingRows.length === 0 || ageMs > 3 * 60 * 1000) {
        try {
          await sync.syncLeaderboard(tournId, year);
          t = await prisma.tournament.findUnique({
            where: { tournId_year: { tournId: String(tournId), year } },
          });
        } catch (err) {
          logger.warn(`lazy syncLeaderboard ${tournId}/${year} failed: ${err.message}`);
        }
      }
    }

    // Frontend expects `leaderboard` to be a flat array of player rows (it does
     //  Array.isArray(leaderboard) && .slice(0, 20)). The DB stores a wrapper object
     //  { rows, roundId, roundStatus, updatedAt } — flatten to just rows here.
    // Filter out pre-tee NOT_STARTED placeholder rows (empty playerId + name) in
    // case they slipped into storage from an older sync build — the UI should fall
    // back to "no leaderboard yet" rather than show 74 blank rows.
    const leaderboardRows = Array.isArray(t.leaderboard?.rows)
      ? t.leaderboard.rows.filter((r) => r && (r.playerId || r.name))
      : [];
    res.json({
      success: true,
      data: {
        tournament: serializeTournament(t),
        tiers: Array.isArray(t.tiers) ? t.tiers : [],
        leaderboard: leaderboardRows.length > 0 ? leaderboardRows : null,
        leaderboardUpdatedAt: t.leaderboard?.updatedAt || null,
        tiersComputedAt: t.tiersComputedAt ? t.tiersComputedAt.toISOString() : null,
      },
    });
  } catch (error) {
    logger.error(`getTournamentFantasy failed: ${error.message}`);
    res.json({ success: false, message: error.message });
  }
};

// ─── Picks (protected — requires authenticate middleware) ───────────────────
// All three endpoints: user scoped via req.user.id

const pickLockedError = (res) =>
  res.status(409).json({ success: false, message: 'Picks are locked for this tournament' });

// GET /api/golf/tournament/:tournId/picks?year=2026
exports.getMyPicks = async (req, res) => {
  try {
    const { tournId } = req.params;
    const year = currentYear(req);
    const t = await prisma.tournament.findUnique({
      where: { tournId_year: { tournId: String(tournId), year } },
      select: { id: true },
    });
    if (!t) return res.json({ success: false, message: 'Tournament not found' });

    const row = await prisma.userPick.findUnique({
      where: { userId_tournamentId: { userId: req.user.id, tournamentId: t.id } },
    });
    res.json({
      success: true,
      data: row
        ? {
            picks: row.picks,
            submittedAt: row.submittedAt.toISOString(),
            lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
            pointsAwarded: row.pointsAwarded,
            scoring: row.scoring,
            pointsCalculatedAt: row.pointsCalculatedAt ? row.pointsCalculatedAt.toISOString() : null,
          }
        : null,
    });
  } catch (error) {
    logger.error(`getMyPicks failed: ${error.message}`);
    res.json({ success: false, message: error.message });
  }
};

// PUT /api/golf/tournament/:tournId/picks  body: { picks: { "T1 Elite": "playerId", ... } }
exports.savePicks = async (req, res) => {
  try {
    const { tournId } = req.params;
    const year = currentYear(req);
    const { picks } = req.body || {};
    if (!picks || typeof picks !== 'object') {
      return res.status(400).json({ success: false, message: 'picks object required' });
    }

    const t = await prisma.tournament.findUnique({
      where: { tournId_year: { tournId: String(tournId), year } },
      select: { id: true, startDate: true, status: true },
    });
    if (!t) return res.status(404).json({ success: false, message: 'Tournament not found' });

    if (picksLocked(t)) return pickLockedError(res);

    // User-initiated lock already persisted?
    const existing = await prisma.userPick.findUnique({
      where: { userId_tournamentId: { userId: req.user.id, tournamentId: t.id } },
      select: { lockedAt: true },
    });
    if (existing?.lockedAt) return pickLockedError(res);

    const row = await prisma.userPick.upsert({
      where: { userId_tournamentId: { userId: req.user.id, tournamentId: t.id } },
      update: { picks, submittedAt: new Date() },
      create: { userId: req.user.id, tournamentId: t.id, picks },
    });
    res.json({
      success: true,
      data: {
        picks: row.picks,
        submittedAt: row.submittedAt.toISOString(),
        lockedAt: row.lockedAt ? row.lockedAt.toISOString() : null,
      },
    });
  } catch (error) {
    logger.error(`savePicks failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/golf/tournament/:tournId/picks/lock  body: { picks }
// Lock is irreversible. Must provide the final picks payload.
exports.lockPicks = async (req, res) => {
  try {
    const { tournId } = req.params;
    const year = currentYear(req);
    const { picks } = req.body || {};
    if (!picks || typeof picks !== 'object') {
      return res.status(400).json({ success: false, message: 'picks object required' });
    }

    const t = await prisma.tournament.findUnique({
      where: { tournId_year: { tournId: String(tournId), year } },
      select: { id: true, startDate: true, status: true },
    });
    if (!t) return res.status(404).json({ success: false, message: 'Tournament not found' });

    if (picksLocked(t)) return pickLockedError(res);

    const existing = await prisma.userPick.findUnique({
      where: { userId_tournamentId: { userId: req.user.id, tournamentId: t.id } },
      select: { lockedAt: true },
    });
    if (existing?.lockedAt) return pickLockedError(res);

    const now = new Date();
    const row = await prisma.userPick.upsert({
      where: { userId_tournamentId: { userId: req.user.id, tournamentId: t.id } },
      update: { picks, submittedAt: now, lockedAt: now },
      create: { userId: req.user.id, tournamentId: t.id, picks, lockedAt: now },
    });
    res.json({
      success: true,
      data: {
        picks: row.picks,
        submittedAt: row.submittedAt.toISOString(),
        lockedAt: row.lockedAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error(`lockPicks failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/golf/sync/:target — manual trigger (admin/dev) ───────────────
// targets: schedule | owgr | field/:tournId | leaderboard/:tournId
exports.triggerSync = async (req, res) => {
  try {
    const { target } = req.params;
    const year = currentYear(req);
    const tournId = req.query.tournId || req.params.tournId;
    let result;

    switch (target) {
      case 'schedule':    result = await sync.syncSchedule(year); break;
      case 'owgr':        result = await sync.syncWorldRanking(year); break;
      case 'field':       result = await sync.syncFieldAndTiers(tournId, year); break;
      case 'leaderboard': result = await sync.syncLeaderboard(tournId, year); break;
      case 'status':      result = await sync.refreshStatuses(year); break;
      case 'all-completed-leaderboards': result = await sync.syncAllCompletedLeaderboards(year); break;
      default: return res.status(400).json({ success: false, message: `Unknown target: ${target}` });
    }

    res.json({ success: true, target, year, tournId: tournId || null, result });
  } catch (error) {
    logger.error(`triggerSync failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
