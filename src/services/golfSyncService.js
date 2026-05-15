const { prisma } = require('../config/db');
const slashGolf = require('./slashGolfService');
const logger = require('../config/logger');
const pointsService = require('./pointsService');
const { createNotification } = require('./notificationService');

const TIER_NAMES = ['T1 Elite', 'T2 Contender', 'T3 Rising', 'T4 Sleeper', 'T5 Wildcard'];
const TIER_COUNT = 5;
const MAJOR_NAMES = ['masters', 'u.s. open', 'us open', 'pga championship', 'open championship', 'the open'];
const isMajor = (n) => MAJOR_NAMES.some((m) => (n || '').toLowerCase().includes(m));

const parseDate = (s, timeZone) => {
  if (!s) return null;
  const str = String(s);
  const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(str);
  if (hasTz) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  // No timezone in string — interpret in the provided timezone (or UTC fallback)
  const dateTimePart = str.length > 10 ? str : `${str}T00:00:00`;
  if (timeZone) {
    // Find UTC offset for this datetime in the given timezone
    const probe = new Date(dateTimePart + 'Z'); // treat as UTC first
    const localStr = probe.toLocaleString('en-US', { timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Parse back to get the offset
    const [datePart, timePart] = localStr.split(', ');
    const [mo, dy, yr] = datePart.split('/');
    const localAsUtc = new Date(`${yr}-${mo}-${dy}T${timePart}Z`);
    const offsetMs = localAsUtc - probe; // how far local is ahead of UTC
    // The actual UTC time = dateTimePart interpreted in timezone
    const naive = new Date(dateTimePart + 'Z');
    return new Date(naive.getTime() - offsetMs);
  }
  const d = new Date(`${dateTimePart}Z`);
  return isNaN(d.getTime()) ? null : d;
};

const PT_TZ = 'America/Los_Angeles';
const startOfPTDay = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const probeHour = parseInt(
    probe.toLocaleString('en-US', { timeZone: PT_TZ, hour: '2-digit', hour12: false }), 10
  );
  const offsetHours = 12 - probeHour;
  return new Date(`${dateStr}T${String(offsetHours).padStart(2, '0')}:00:00Z`);
};

const computeStatus = (start, end) => {
  if (!start) return 'upcoming';
  const now = new Date();
  const liveFrom = new Date(start);
  const endBase = end ? new Date(end) : new Date(start.getTime() + 3 * 86400000);
  const liveUntil = new Date(endBase.getTime() + 48 * 3600 * 1000); // end of end date + buffer
  if (now >= liveUntil) return 'completed';
  if (now >= liveFrom) return 'live';
  return 'upcoming';
};

exports.startOfPTDay = startOfPTDay;
exports.computeStatus = computeStatus;

const parseScoreToNum = (s) => {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str || str === '-') return null;
  if (/^[Ee]$/.test(str)) return 0;
  const n = parseFloat(str.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};

const formatScoreToPar = (n) => {
  if (n == null || !Number.isFinite(n)) return '-';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : String(n);
};

exports.syncSchedule = async (year = new Date().getFullYear()) => {
  const data = await slashGolf.getSchedule(year);
  const events = data?.schedule || [];
  let upserts = 0;

  for (const ev of events) {
    const start = parseDate(ev.date?.start);
    const end = parseDate(ev.date?.end);
    const course = ev.courses?.[0] || {};
    const loc = course.location || {};
    const status = computeStatus(start, end);

    await prisma.tournament.upsert({
      where: { tournId_year: { tournId: String(ev.tournId), year: Number(year) } },
      update: {
        name: ev.name || '',
        status,
        startDate: start,
        endDate: end,
        courseName: course.courseName || null,
        city: loc.city || null,
        state: loc.state || null,
        country: loc.country || null,
        purse: ev.purse ? BigInt(String(ev.purse).replace(/\D/g, '') || 0) : null,
        fedexPoints: ev.fedexCupPoints ? Number(ev.fedexCupPoints) : null,
        isMajor: isMajor(ev.name),
        lastSyncedAt: new Date(),
        raw: ev,
      },
      create: {
        tournId: String(ev.tournId),
        year: Number(year),
        name: ev.name || '',
        status,
        startDate: start,
        endDate: end,
        courseName: course.courseName || null,
        city: loc.city || null,
        state: loc.state || null,
        country: loc.country || null,
        purse: ev.purse ? BigInt(String(ev.purse).replace(/\D/g, '') || 0) : null,
        fedexPoints: ev.fedexCupPoints ? Number(ev.fedexCupPoints) : null,
        isMajor: isMajor(ev.name),
        raw: ev,
      },
    });
    upserts++;
  }
  logger.info(`[sync:schedule] ${year}: ${upserts} tournaments upserted`);
  return upserts;
};

exports.syncWorldRanking = async (year = new Date().getFullYear()) => {
  const { list } = await slashGolf.getWorldRanking(year);
  const snapshotAt = new Date();
  let updated = 0;

  for (const r of list) {
    await prisma.player.upsert({
      where: { playerId: r.playerId },
      update: {
        firstName: r.firstName,
        lastName: r.lastName,
        country: r.country || null,
        owgrRank: r.rank,
        owgrUpdated: snapshotAt,
      },
      create: {
        playerId: r.playerId,
        firstName: r.firstName,
        lastName: r.lastName,
        country: r.country || null,
        owgrRank: r.rank,
        owgrUpdated: snapshotAt,
      },
    });
    updated++;
  }

  const top = list.filter((r) => r.rank <= 500);
  if (top.length > 0) {
    await prisma.playerRanking.createMany({
      data: top.map((r) => ({
        playerId: r.playerId,
        name: `${r.firstName} ${r.lastName}`.trim(),
        country: r.country || null,
        rank: r.rank,
        snapshotAt,
      })),
      skipDuplicates: true,
    });
  }
  logger.info(`[sync:owgr] ${year}: ${updated} players updated, ${top.length} snapshotted`);
  return updated;
};

exports.syncFieldAndTiers = async (tournId, year = new Date().getFullYear()) => {
  const t = await prisma.tournament.findUnique({
    where: { tournId_year: { tournId: String(tournId), year: Number(year) } },
  });
  if (!t) throw new Error(`Tournament ${tournId}/${year} not in DB — run syncSchedule first`);

  const data = await slashGolf.getTournament(tournId, year);
  
  // Extract location data from tournament endpoint
  const course = data?.courses?.[0] || {};
  const loc = course.location || {};
  const locationData = {
    courseName: course.courseName || t.courseName,
    city: loc.city || t.city,
    state: loc.state || t.state,
    country: loc.country || t.country,
  };
  
  const entries = data?.players || data?.entryList || data?.entries || [];
  if (!Array.isArray(entries) || entries.length === 0) {
    logger.info(`[sync:field] ${tournId}/${year}: field not yet available (${entries.length} entries)`);
    await prisma.tournament.update({
      where: { id: t.id },
      data: { 
        fieldAvailable: false, 
        lastSyncedAt: new Date(),
        ...locationData, // Update location even if field not available
      },
    });
    return 0;
  }

  const { byPlayerId: rankMap } = await slashGolf.getWorldRanking(year);

  const ranked = entries.map((p) => {
    const playerId = String(p.playerId || '');
    const rank = rankMap[playerId] ?? null;
    return {
      playerId,
      firstName: p.firstName || '',
      lastName: p.lastName || '',
      country: p.country || null,
      isAmateur: !!p.isAmateur,
      rank,
      sortKey: rank == null ? Number.MAX_SAFE_INTEGER : rank,
    };
  }).filter((p) => p.playerId);

  ranked.sort((a, b) => a.sortKey - b.sortKey);

  const n = ranked.length;
  const chunkSize = Math.ceil(n / TIER_COUNT);
  const tiers = Array.from({ length: TIER_COUNT }, (_, i) => ({
    name: TIER_NAMES[i],
    players: ranked.slice(i * chunkSize, (i + 1) * chunkSize),
  }));

  for (const p of ranked) {
    await prisma.player.upsert({
      where: { playerId: p.playerId },
      update: {
        firstName: p.firstName,
        lastName: p.lastName,
        country: p.country,
        isAmateur: p.isAmateur,
        ...(p.rank != null && { owgrRank: p.rank }),
      },
      create: {
        playerId: p.playerId,
        firstName: p.firstName,
        lastName: p.lastName,
        country: p.country,
        isAmateur: p.isAmateur,
        owgrRank: p.rank,
      },
    });
  }

  const dbPlayers = await prisma.player.findMany({
    where: { playerId: { in: ranked.map((p) => p.playerId) } },
    select: { id: true, playerId: true },
  });
  const idMap = new Map(dbPlayers.map((x) => [x.playerId, x.id]));

  const tpRows = [];
  tiers.forEach((tier) => {
    tier.players.forEach((p, idxInTier) => {
      const pid = idMap.get(p.playerId);
      if (!pid) return;
      tpRows.push({
        tournamentId: t.id,
        playerId: pid,
        tier: tier.name,
        tierRank: idxInTier + 1,
        entryOwgr: p.rank,
      });
    });
  });

  const tiersBlob = tiers.map((tier) => ({
    name: tier.name,
    rankRange: tier.players.length
      ? `OWGR ${tier.players[0].rank ?? '—'}–${tier.players[tier.players.length - 1].rank ?? '—'}`
      : '',
    players: tier.players.map((p) => ({
      playerId: p.playerId,
      name: `${p.firstName} ${p.lastName}`.trim(),
      firstName: p.firstName,
      lastName: p.lastName,
      country: p.country,
      worldRank: p.rank,
      isAmateur: p.isAmateur,
    })),
  }));

  await prisma.$transaction([
    prisma.tournamentPlayer.deleteMany({ where: { tournamentId: t.id } }),
    ...(tpRows.length > 0 ? [prisma.tournamentPlayer.createMany({ data: tpRows })] : []),
    prisma.tournament.update({
      where: { id: t.id },
      data: {
        fieldAvailable: true,
        tiers: tiersBlob,
        tiersComputedAt: new Date(),
        lastSyncedAt: new Date(),
        ...locationData,
      },
    }),
  ]);

  // Notify users with active H2H challenges that the field is now available
  if (!t.fieldAvailable) {
    try {
      const challenges = await prisma.challenge.findMany({
        where: {
          tournamentId: t.id,
          status: { in: ['ACCEPTED'] },
        },
        select: { id: true, challengerId: true, opponentId: true },
      });
      const userIds = [...new Set(challenges.flatMap(c => [c.challengerId, c.opponentId]))];
      await Promise.all(userIds.map(userId =>
        createNotification({
          userId,
          type: 'H2H_CHALLENGE_FIELD_AVAILABLE',
          data: { tournamentId: t.id, tournId, tournamentName: t.name },
        })
      ));
      if (userIds.length > 0)
        logger.info(`[sync:field] notified ${userIds.length} users: field available for ${t.name}`);
    } catch (err) {
      logger.warn(`[sync:field] field-available notify failed for ${tournId}: ${err.message}`);
    }
  }

  logger.info(`[sync:field] ${tournId}/${year}: ${ranked.length} players split into 5 tiers, location: ${locationData.city}, ${locationData.state}`);
  return ranked.length;
};

// NEW: Capture round snapshots proactively
exports.captureRoundSnapshots = async (tournId, year = new Date().getFullYear()) => {
  const t = await prisma.tournament.findUnique({
    where: { tournId_year: { tournId: String(tournId), year: Number(year) } },
  });
  if (!t || t.status !== 'live') return;

  const cachedSnapshots = t.leaderboard?.roundSnapshots || {};
  
  const lb = await slashGolf.getLeaderboard(tournId, year);
  const rows = lb?.leaderboardRows || [];
  
  let currentRound = 1;
  for (const r of rows) {
    const cr = Number(r.currentRound) || 0;
    if (cr > currentRound) currentRound = cr;
  }
  
  const maxRoundToCapture = Math.min(currentRound, 4);
  let captured = 0;
  
  for (let r = 1; r <= maxRoundToCapture; r++) {
    if (cachedSnapshots[`round${r}`]) continue;
    
    try {
      const snap = await slashGolf.getLeaderboard(tournId, year, r);
      const snapRows = snap?.leaderboardRows || [];
      
      if (snapRows.length === 0) continue;
      
      const roundData = {};
      for (const sr of snapRows) {
        const isTeam = Array.isArray(sr.players) && sr.players.length > 0;
        const pid = isTeam
          ? `team:${sr.teamId || sr.players.map((x) => x.playerId).join('-')}`
          : String(sr.playerId || '');
        if (!pid) continue;
        const cum = parseScoreToNum(sr.total);
        if (cum != null) {
          roundData[pid] = cum;
        }
      }
      
      if (Object.keys(roundData).length > 0) {
        cachedSnapshots[`round${r}`] = roundData;
        captured++;
      }
    } catch (err) {
      logger.warn(`[capture-rounds] ${tournId}/${year}: round ${r} failed: ${err.message}`);
    }
  }
  
  if (captured > 0) {
    const updatedLeaderboard = {
      ...(t.leaderboard || {}),
      roundSnapshots: cachedSnapshots
    };
    
    await prisma.tournament.update({
      where: { id: t.id },
      data: { leaderboard: updatedLeaderboard }
    });
    
    logger.info(`[capture-rounds] ${tournId}/${year}: captured ${captured} new round snapshots`);
  }
};

exports.syncLeaderboard = async (tournId, year = new Date().getFullYear()) => {
  const t = await prisma.tournament.findUnique({
    where: { tournId_year: { tournId: String(tournId), year: Number(year) } },
  });
  if (!t) throw new Error(`Tournament ${tournId}/${year} not in DB`);

  const lb = await slashGolf.getLeaderboard(tournId, year);
  const rows = lb?.leaderboardRows || [];
  if (rows.length === 0) {
    logger.info(`[sync:leaderboard] ${tournId}/${year}: no rows`);
    return 0;
  }

  const existingRoundsById = new Map();
  if (Array.isArray(t.leaderboard?.rows)) {
    for (const r of t.leaderboard.rows) {
      if (r?.playerId && Array.isArray(r.rounds)) existingRoundsById.set(r.playerId, r.rounds);
    }
  }

  // Load cached round snapshots
  const cachedSnapshots = t.leaderboard?.roundSnapshots || {};

  const isLeaderboardOfficial = (lb?.status || '').toLowerCase().includes('official');
  const maxCompletedRound = (() => {
    if (isLeaderboardOfficial) return 4;
    let maxCurrent = 0;
    for (const r of rows) {
      const cr = Number(r.currentRound) || 0;
      if (cr > maxCurrent) maxCurrent = cr;
    }
    return Math.max(0, maxCurrent - 1);
  })();

  const cumulativeByPid = new Map();
  
  // First load from cache
  for (let r = 1; r <= 4; r++) {
    if (cachedSnapshots[`round${r}`]) {
      for (const [pid, total] of Object.entries(cachedSnapshots[`round${r}`])) {
        let arr = cumulativeByPid.get(pid);
        if (!arr) { arr = []; cumulativeByPid.set(pid, arr); }
        arr[r - 1] = total;
      }
    }
  }
  
  // For completed tournaments, ensure we fetch ALL rounds (1-4)
  const roundsToFetch = isLeaderboardOfficial ? 4 : maxCompletedRound;
  
  // Then fetch missing rounds
  for (let r = 1; r <= roundsToFetch; r++) {
    if (cachedSnapshots[`round${r}`]) continue;
    
    try {
      const snap = await slashGolf.getLeaderboard(tournId, year, r);
      const snapRows = snap?.leaderboardRows || [];
      for (const sr of snapRows) {
        const isTeam = Array.isArray(sr.players) && sr.players.length > 0;
        const pid = isTeam
          ? `team:${sr.teamId || sr.players.map((x) => x.playerId).join('-')}`
          : String(sr.playerId || '');
        if (!pid) continue;
        const cum = parseScoreToNum(sr.total);
        if (cum == null) continue;
        let arr = cumulativeByPid.get(pid);
        if (!arr) { arr = []; cumulativeByPid.set(pid, arr); }
        arr[r - 1] = cum;
      }
    } catch (err) {
      logger.warn(`[sync:leaderboard] ${tournId}/${year}: round ${r} snapshot failed: ${err.message}`);
    }
  }

  const compact = rows
    .map((p) => {
      const isTeam = Array.isArray(p.players) && p.players.length > 0;
      const id = isTeam
        ? `team:${p.teamId || p.players.map((x) => x.playerId).join('-')}`
        : String(p.playerId || '');
      const name = isTeam
        ? p.players.map((x) => `${x.firstName || ''} ${x.lastName || ''}`.trim()).filter(Boolean).join(' / ')
        : `${p.firstName || ''} ${p.lastName || ''}`.trim();
      const country = isTeam ? (p.players[0]?.country || '') : (p.country || '');

      const apiRounds = Array.isArray(p.rounds) ? p.rounds : [];
      const currentRound = Number(p.currentRound) || 0;
      const currentRoundScore = p.currentRoundScore || '';
      const prevRounds = existingRoundsById.get(id) || [];
      const cumulative = cumulativeByPid.get(id) || [];
      const roundScores = [];
      for (let i = 0; i < 4; i++) {
        const r = apiRounds[i];
        if (r && (r.scoreToPar || r.strokes)) {
          roundScores.push(r.scoreToPar ? String(r.scoreToPar) : String(r.strokes));
          continue;
        }
        const cumThis = cumulative[i];
        const cumPrev = i === 0 ? 0 : cumulative[i - 1];
        if (cumThis != null && cumPrev != null) {
          roundScores.push(formatScoreToPar(cumThis - cumPrev));
          continue;
        }
        if (currentRound > 0 && i === currentRound - 1 && currentRoundScore) {
          roundScores.push(String(currentRoundScore));
          continue;
        }
        if (prevRounds[i] && prevRounds[i] !== '-') {
          roundScores.push(prevRounds[i]);
          continue;
        }
        roundScores.push('-');
      }

      return {
        playerId: id,
        position: p.position || '-',
        name,
        country,
        score: p.total || 'E',
        status: p.status || 'active',
        thru: p.thru || (p.roundComplete ? 'F' : '-'),
        currentRoundScore,
        rounds: roundScores,
        totalStrokes: p.totalStrokesFromCompletedRounds || '',
      };
    })
    .filter((r) => r.playerId || r.name);

  const isOfficial = (lb?.status || '').toLowerCase().includes('official');
  let newStatus = t.status;
  const wasCompleted = t.status === 'completed';
  if (isOfficial) newStatus = 'completed';
  else if (compact.length > 0) newStatus = 'live';

  const lbPayload = compact.length > 0
    ? { 
        rows: compact, 
        roundId: lb?.roundId || '', 
        roundStatus: lb?.roundStatus || '', 
        updatedAt: new Date().toISOString(),
        roundSnapshots: (() => {
          const snapshots = {};
          for (let r = 1; r <= 4; r++) {
            const roundData = {};
            for (const [pid, totals] of cumulativeByPid.entries()) {
              if (totals[r - 1] != null) {
                roundData[pid] = totals[r - 1];
              }
            }
            if (Object.keys(roundData).length > 0) {
              snapshots[`round${r}`] = roundData;
            }
          }
          return snapshots;
        })()
      }
    : (t.leaderboard ?? null);

  await prisma.tournament.update({
    where: { id: t.id },
    data: {
      leaderboard: lbPayload,
      status: newStatus,
      lastSyncedAt: new Date(),
    },
  });
  if (compact.length > 0) {
    logger.info(`[sync:leaderboard] ${tournId}/${year}: ${compact.length} rows (status=${newStatus})`);
  } else {
    logger.info(`[sync:leaderboard] ${tournId}/${year}: 0 usable rows — preserved existing leaderboard`);
  }

  if (newStatus === 'completed' && !wasCompleted) {
    try {
      logger.info(`[sync:leaderboard] ${tournId}/${year}: tournament completed, auto-calculating points`);
      const result = await pointsService.awardTournamentPoints(t.id);
      logger.info(`[sync:leaderboard] ${tournId}/${year}: points awarded to ${result.processed} users (${result.skipped} already awarded)`);
    } catch (err) {
      logger.error(`[sync:leaderboard] ${tournId}/${year}: auto points calculation failed: ${err.message}`);
    }
  }

  return compact.length;
};

exports.refreshStatuses = async (year = new Date().getFullYear()) => {
  const all = await prisma.tournament.findMany({ where: { year: Number(year) } });
  let changed = 0;
  for (const t of all) {
    const s = computeStatus(t.startDate, t.endDate);
    if (s !== t.status) {
      await prisma.tournament.update({ where: { id: t.id }, data: { status: s } });
      changed++;
      // Notify users with picks when tournament goes live
      if (s === 'live') {
        try {
          const picks = await prisma.userPick.findMany({
            where: { tournamentId: t.id },
            select: { userId: true },
          });
          await Promise.all(picks.map(p =>
            createNotification({
              userId: p.userId,
              type: 'FANTASY_TOURNAMENT_LIVE',
              data: { tournamentId: t.id, tournId: t.tournId, tournamentName: t.name },
            })
          ));
          logger.info(`[sync:status] notified ${picks.length} users: ${t.name} is live`);
        } catch (err) {
          logger.warn(`[sync:status] live notify failed for ${t.tournId}: ${err.message}`);
        }
      }
    }
  }
  if (changed > 0) logger.info(`[sync:status] ${changed} tournaments updated`);
  return changed;
};

exports.syncAllCompletedLeaderboards = async (year = new Date().getFullYear()) => {
  const completed = await prisma.tournament.findMany({
    where: { year: Number(year), status: 'completed' },
    select: { tournId: true, year: true, name: true },
  });

  if (completed.length === 0) {
    logger.info(`[sync:all-completed] ${year}: no completed tournaments`);
    return { synced: 0, failed: 0, total: 0 };
  }

  let synced = 0;
  let failed = 0;
  const errors = [];

  for (const t of completed) {
    try {
      await exports.syncLeaderboard(t.tournId, t.year);
      synced++;
      logger.info(`[sync:all-completed] ${t.tournId}/${t.year} (${t.name}): success`);
    } catch (err) {
      failed++;
      errors.push({ tournId: t.tournId, name: t.name, error: err.message });
      logger.error(`[sync:all-completed] ${t.tournId}/${t.year} (${t.name}): ${err.message}`);
    }
  }

  logger.info(`[sync:all-completed] ${year}: ${synced}/${completed.length} synced, ${failed} failed`);
  return { synced, failed, total: completed.length, errors: errors.length > 0 ? errors : undefined };
};
