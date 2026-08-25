const {
  calculateWeeklyScore,
} = require("../../../domain/matchups/calculateWeeklyScore");
const {
  calculateStandings,
} = require("../../../domain/standings/calculateStandings");

const MATCHUPS_STATE_UNAVAILABLE =
  "MATCHUPS_STATE_UNAVAILABLE";

function isTeamLegalNow(team) {
  if (!team || typeof team !== "object") return false;
  const roster = Array.isArray(team.roster)
    ? team.roster
    : [];
  return roster.length > 0;
}

function currentWeekContext(state, fallbackIndex = 0) {
  const matchups = state?.matchups || {};
  const weeks = Array.isArray(matchups.scheduleWeeks)
    ? matchups.scheduleWeeks
    : [];
  const currentWeekIndex = Number(
    matchups.currentWeekIndex ?? fallbackIndex
  );
  const week = weeks[currentWeekIndex] || null;

  return {
    matchups,
    weeks,
    currentWeekIndex,
    week,
  };
}

function createMatchupReadService({
  leagueStore,
  statisticsRepository,
  statsFile,
  clock = { nowMs: Date.now },
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createMatchupReadService requires a leagueStore"
    );
  }
  if (!statisticsRepository) {
    throw new TypeError(
      "createMatchupReadService requires a statisticsRepository"
    );
  }

  function readStandings() {
    const state = leagueStore.loadLeague();
    return calculateStandings({
      state,
      nowMs: clock.nowMs(),
    });
  }

  function readCurrent() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state);

    return {
      ok: true,
      seasonId: matchups.seasonId || null,
      currentWeekIndex,
      currentWeekId:
        matchups.currentWeekId || week?.weekId || null,
      week,
      serverNowMs: clock.nowMs(),
    };
  }

  function readLocks() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state);

    return {
      ok: true,
      currentWeekIndex,
      currentWeekId:
        matchups.currentWeekId || week?.weekId || null,
      lockAtMs: week?.lockAtMs || null,
      serverNowMs: clock.nowMs(),
      locksByTeam: matchups.locksByTeam || {},
    };
  }

  function readLocksPreview() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state);
    const teams = Array.isArray(state.teams)
      ? state.teams
      : [];
    const locksByTeam = matchups.locksByTeam || {};
    const nowMs = clock.nowMs();
    const lockAtMs = week?.lockAtMs ?? null;
    const currentWeekId =
      matchups.currentWeekId || week?.weekId || null;

    if (!week || !Number.isFinite(lockAtMs)) {
      return {
        ok: true,
        reason: "missingWeekOrLockTime",
        serverNowMs: nowMs,
        currentWeekIndex,
        currentWeekId,
        wouldLock: [],
      };
    }

    if (nowMs < lockAtMs) {
      return {
        ok: true,
        reason: "beforeLockTime",
        serverNowMs: nowMs,
        lockAtMs,
        currentWeekIndex,
        currentWeekId,
        wouldLock: [],
      };
    }

    const wouldLock = [];
    for (const team of teams) {
      const name = team?.name;
      if (!name) continue;
      if (locksByTeam[name]) continue;
      if (!isTeamLegalNow(team)) continue;
      wouldLock.push(name);
    }

    return {
      ok: true,
      reason: "afterLockTime",
      serverNowMs: nowMs,
      lockAtMs,
      currentWeekIndex,
      currentWeekId,
      alreadyLocked: Object.keys(locksByTeam),
      wouldLock,
    };
  }

  function readBaselinePreview() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state);
    const nowMs = clock.nowMs();

    if (
      !week ||
      !week.weekId ||
      !Number.isFinite(week.baselineAtMs)
    ) {
      return {
        ok: true,
        reason: "missingWeekOrBaselineTime",
        serverNowMs: nowMs,
        currentWeekIndex,
        currentWeekId:
          matchups.currentWeekId ||
          week?.weekId ||
          null,
      };
    }

    const weekId = week.weekId;
    const baselineByWeekId =
      matchups.baselineByWeekId || {};
    const alreadyCaptured = Boolean(
      baselineByWeekId[weekId]
    );

    if (!statisticsRepository.cacheExists()) {
      return {
        ok: true,
        reason: "statsCacheMissing",
        serverNowMs: nowMs,
        weekId,
        baselineAtMs: week.baselineAtMs,
        alreadyCaptured,
      };
    }

    const statsJson = statisticsRepository.readCache();
    const byPlayerId =
      statsJson?.byPlayerId &&
      typeof statsJson.byPlayerId === "object"
        ? statsJson.byPlayerId
        : {};
    const snapshotByPlayerId = {};
    let count = 0;

    for (const [playerId, stats] of Object.entries(
      byPlayerId
    )) {
      const goals = Number(stats?.goals) || 0;
      const assists = Number(stats?.assists) || 0;
      const gamesPlayed =
        Number(stats?.gamesPlayed) || 0;
      snapshotByPlayerId[playerId] = {
        goals,
        assists,
        gamesPlayed,
        fp: goals * 1.25 + assists,
      };
      count += 1;
    }

    const sample = Object.entries(snapshotByPlayerId)
      .slice(0, 5)
      .map(([playerId, value]) => ({
        playerId,
        ...value,
      }));

    return {
      ok: true,
      serverNowMs: nowMs,
      currentWeekIndex,
      weekId,
      weekWindow: {
        weekStartAtMs: week.weekStartAtMs,
        baselineAtMs: week.baselineAtMs,
        lockAtMs: week.lockAtMs,
        weekEndAtMs: week.weekEndAtMs,
        rolloverAtMs: week.rolloverAtMs,
      },
      alreadyCaptured,
      statsMeta: {
        seasonId: statsJson?.seasonId ?? null,
        lastUpdatedAt:
          statsJson?.lastUpdatedAt ?? null,
        playerCount: count,
      },
      preview: {
        playerCount: count,
        sample,
      },
    };
  }

  function readBaselineStatus() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state);
    const nowMs = clock.nowMs();

    if (!week) {
      return {
        ok: true,
        canCapture: false,
        reason: "noCurrentWeek",
        nowMs,
        currentWeekIndex,
      };
    }
    if (!week.weekId) {
      return {
        ok: true,
        canCapture: false,
        reason: "missingWeekId",
        nowMs,
        currentWeekIndex,
      };
    }
    if (!Number.isFinite(week.baselineAtMs)) {
      return {
        ok: true,
        canCapture: false,
        reason: "missingBaselineAtMs",
        nowMs,
        currentWeekIndex,
        weekId: week.weekId,
        baselineAtMs: week.baselineAtMs ?? null,
      };
    }

    const weekId = week.weekId;
    const baselineByWeekId =
      matchups.baselineByWeekId || {};
    const alreadyCaptured = Boolean(
      baselineByWeekId[weekId]
    );

    if (alreadyCaptured) {
      const entry = baselineByWeekId[weekId];
      return {
        ok: true,
        canCapture: false,
        reason: "alreadyCaptured",
        nowMs,
        currentWeekIndex,
        weekId,
        baselineAtMs: week.baselineAtMs,
        capturedAtMs: entry?.capturedAtMs ?? null,
        playerCount: entry?.byPlayerId
          ? Object.keys(entry.byPlayerId).length
          : 0,
      };
    }

    if (nowMs < week.baselineAtMs) {
      return {
        ok: true,
        canCapture: false,
        reason: "beforeBaselineTime",
        nowMs,
        currentWeekIndex,
        weekId,
        baselineAtMs: week.baselineAtMs,
        msUntilBaseline: week.baselineAtMs - nowMs,
      };
    }

    if (!statisticsRepository.cacheExists()) {
      return {
        ok: true,
        canCapture: false,
        reason: "statsCacheMissing",
        nowMs,
        currentWeekIndex,
        weekId,
        baselineAtMs: week.baselineAtMs,
        STATS_FILE: statsFile,
      };
    }

    return {
      ok: true,
      canCapture: true,
      reason: "readyToCapture",
      nowMs,
      currentWeekIndex,
      weekId,
      baselineAtMs: week.baselineAtMs,
      STATS_FILE: statsFile,
    };
  }

  async function readScoringPreview() {
    const nowMs = clock.nowMs();
    const state = leagueStore.loadLeague();
    if (!state || !state.matchups) {
      const error = new Error(
        "Matchups state not available."
      );
      error.code = MATCHUPS_STATE_UNAVAILABLE;
      throw error;
    }

    let statsJson = null;
    try {
      statsJson =
        await statisticsRepository.readCacheAsync();
    } catch {
      statsJson = null;
    }

    return calculateWeeklyScore({
      state,
      statsJson,
      nowMs,
    });
  }

  function readRolloverStatus() {
    const state = leagueStore.loadLeague();
    const {
      matchups,
      currentWeekIndex,
      week,
    } = currentWeekContext(state, -1);
    const nowMs = clock.nowMs();
    const weekId = week?.weekId ?? null;
    const resultsExists =
      weekId != null &&
      Boolean(
        matchups.resultsByWeek?.[String(weekId)]
      );
    const canRollover =
      Boolean(week) &&
      Number.isFinite(Number(week.rolloverAtMs)) &&
      nowMs >= Number(week.rolloverAtMs) &&
      !resultsExists &&
      String(matchups.lastRolloverWeekId || "") !==
        String(weekId);

    return {
      ok: true,
      nowMs,
      currentWeekIndex,
      currentWeekId: weekId,
      rolloverAtMs: week?.rolloverAtMs ?? null,
      lastRolloverWeekId:
        matchups.lastRolloverWeekId ?? null,
      resultsExists,
      canRollover,
    };
  }

  return {
    readBaselinePreview,
    readBaselineStatus,
    readCurrent,
    readLocks,
    readLocksPreview,
    readRolloverStatus,
    readScoringPreview,
    readStandings,
  };
}

module.exports = {
  MATCHUPS_STATE_UNAVAILABLE,
  createMatchupReadService,
  currentWeekContext,
  isTeamLegalNow,
};
