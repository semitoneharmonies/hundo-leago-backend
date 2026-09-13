function getPlayerId(player) {
  if (!player) return null;

  if (player.playerId != null) {
    return String(player.playerId);
  }
  if (player.id != null) return String(player.id);
  if (player.pid != null) return String(player.pid);
  if (player.player?.playerId != null) {
    return String(player.player.playerId);
  }
  if (player.player?.id != null) {
    return String(player.player.id);
  }

  const token =
    player.auctionKey != null
      ? String(player.auctionKey)
      : player.player != null
        ? String(player.player)
        : player.key != null
          ? String(player.key)
          : null;
  const match = token?.match(/^id:(\d+)$/i);
  return match ? match[1] : null;
}

function fantasyPoints(row) {
  if (!row) return 0;
  const goals = Number(row.goals || 0);
  const assists = Number(row.assists || 0);
  return goals * 1.25 + assists;
}

function calculateWeeklyScore({
  state,
  statsJson,
  nowMs,
}) {
  const matchups = state.matchups;
  const currentWeekIndex = Number(
    matchups.currentWeekIndex ?? -1
  );
  const weeks = Array.isArray(matchups.scheduleWeeks)
    ? matchups.scheduleWeeks
    : [];
  const week = weeks[currentWeekIndex];

  if (!week || !week.weekId) {
    return {
      ok: true,
      nowMs,
      weekId: null,
      baselineCaptured: false,
      teams: [],
      note: "No current week configured.",
    };
  }

  const weekId = String(week.weekId);
  const baseline =
    matchups.baselineByWeekId?.[weekId] || null;
  const baselineCaptured = Boolean(baseline);
  const baselineCapturedAtMs =
    baseline?.capturedAtMs ?? null;
  const baselineStatsLastUpdatedAt =
    baseline?.statsLastUpdatedAt ?? null;
  const currentStatsLastUpdatedAt =
    statsJson?.lastUpdatedAt ?? null;
  const currentByPlayerId =
    statsJson?.byPlayerId || {};

  function currentFantasyPoints(playerId) {
    return fantasyPoints(currentByPlayerId?.[playerId]);
  }

  function baselineFantasyPoints(playerId) {
    if (!baseline) return 0;

    if (
      baseline.fpByPlayerId &&
      baseline.fpByPlayerId[playerId] != null
    ) {
      return Number(
        baseline.fpByPlayerId[playerId] || 0
      );
    }

    const row = baseline.byPlayerId?.[playerId];
    if (!row) return 0;
    if (row.fp != null) return Number(row.fp || 0);
    return fantasyPoints(row);
  }

  const locksByTeam = matchups.locksByTeam || {};
  const teams = Array.isArray(state.teams)
    ? state.teams
    : [];
  const perTeam = teams.map((team) => {
    const teamName = String(team?.name || "");
    const lock = locksByTeam?.[teamName] || {};
    const roster = Array.isArray(team?.roster)
      ? team.roster
      : [];
    const locked =
      Number.isFinite(Number(lock.lockedAtMs)) &&
      Number(lock.weekIndex) === currentWeekIndex;

    if (!locked) {
      return {
        teamName,
        locked: false,
        lockedAtMs: lock.lockedAtMs ?? null,
        baselineCaptured,
        weeklyFP: 0,
        playersCount: roster.length,
      };
    }

    if (!baselineCaptured) {
      return {
        teamName,
        locked: true,
        lockedAtMs: lock.lockedAtMs ?? null,
        baselineCaptured: false,
        weeklyFP: null,
        playersCount: roster.length,
      };
    }

    let sum = 0;
    let countedPlayers = 0;
    let missingIdCount = 0;

    for (const player of roster) {
      const playerId = getPlayerId(player);
      if (!playerId) {
        missingIdCount += 1;
        continue;
      }

      let delta =
        currentFantasyPoints(playerId) -
        baselineFantasyPoints(playerId);
      if (delta < 0) delta = 0;
      sum += delta;
      countedPlayers += 1;
    }

    return {
      teamName,
      locked: true,
      lockedAtMs: lock.lockedAtMs ?? null,
      baselineCaptured: true,
      weeklyFP: Math.round(sum * 100) / 100,
      playersCount: roster.length,
      countedPlayers,
      missingIdCount,
    };
  });

  let sample = null;
  for (const team of teams) {
    const roster = Array.isArray(team?.roster)
      ? team.roster
      : [];
    const first = roster.find((player) =>
      getPlayerId(player)
    );
    if (!first) continue;

    const playerId = getPlayerId(first);
    let delta =
      currentFantasyPoints(playerId) -
      baselineFantasyPoints(playerId);
    if (delta < 0) delta = 0;
    sample = {
      playerId,
      fpBaseline: baselineFantasyPoints(playerId),
      fpNow: currentFantasyPoints(playerId),
      delta: Math.round(delta * 100) / 100,
    };
    break;
  }

  return {
    ok: true,
    nowMs,
    weekId,
    weekWindow: {
      weekStartAtMs: week.weekStartAtMs,
      baselineAtMs: week.baselineAtMs,
      lockAtMs: week.lockAtMs,
      weekEndAtMs: week.weekEndAtMs,
      rolloverAtMs: week.rolloverAtMs,
    },
    sample,
    baselineMeta: {
      baselineCapturedAtMs,
      baselineStatsLastUpdatedAt,
      currentStatsLastUpdatedAt,
      statsChangedSinceBaseline:
        baselineStatsLastUpdatedAt != null &&
        currentStatsLastUpdatedAt != null &&
        Number(currentStatsLastUpdatedAt) !==
          Number(baselineStatsLastUpdatedAt),
    },
    baselineCaptured,
    statsReady:
      Boolean(statsJson?.ok) &&
      statsJson?.ready !== false,
    teams: perTeam,
    note: !baselineCaptured
      ? "Baseline not captured yet; locked teams return weeklyFP=null until captured."
      : undefined,
  };
}

module.exports = {
  calculateWeeklyScore,
  fantasyPoints,
  getPlayerId,
};
