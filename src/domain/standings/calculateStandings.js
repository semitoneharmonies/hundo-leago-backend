function calculateStandings({
  state,
  nowMs,
}) {
  const matchups = state?.matchups || {};
  const resultsByWeek = matchups.resultsByWeek || {};
  const scheduleWeeks = Array.isArray(
    matchups.scheduleWeeks
  )
    ? matchups.scheduleWeeks
    : [];
  const teams = Array.isArray(state?.teams)
    ? state.teams
    : [];
  const scheduleByWeekId = new Map();

  scheduleWeeks.forEach((week, index) => {
    const weekId =
      week?.weekId ?? week?.id ?? `week_${index}`;
    scheduleByWeekId.set(weekId, week);
  });

  const table = new Map();
  function ensureRow(teamName) {
    const name = String(teamName || "").trim();
    if (!name) return null;

    if (!table.has(name)) {
      table.set(name, {
        teamName: name,
        GP: 0,
        W: 0,
        L: 0,
        T: 0,
        PTS: 0,
        PF: 0,
        PA: 0,
        DIFF: 0,
      });
    }

    return table.get(name);
  }

  for (const team of teams) {
    ensureRow(team?.name ?? team?.teamName ?? team?.id);
  }

  const countedWeekIds = [];
  for (const weekId of Object.keys(resultsByWeek)) {
    const scheduledWeek = scheduleByWeekId.get(weekId);
    const pairs = Array.isArray(scheduledWeek?.pairs)
      ? scheduledWeek.pairs
      : null;
    if (!pairs || pairs.length === 0) continue;

    const weekResult = resultsByWeek[weekId] || {};
    const perTeam = weekResult.perTeam || {};
    countedWeekIds.push(weekId);

    for (const pair of pairs) {
      const first = Array.isArray(pair) ? pair[0] : null;
      const second = Array.isArray(pair) ? pair[1] : null;
      if (!first || !second) continue;

      const firstRow = ensureRow(first);
      const secondRow = ensureRow(second);
      if (!firstRow || !secondRow) continue;

      const firstPoints =
        Number(perTeam?.[first]?.weeklyFP ?? 0) || 0;
      const secondPoints =
        Number(perTeam?.[second]?.weeklyFP ?? 0) || 0;

      firstRow.GP += 1;
      secondRow.GP += 1;
      firstRow.PF += firstPoints;
      firstRow.PA += secondPoints;
      secondRow.PF += secondPoints;
      secondRow.PA += firstPoints;

      if (firstPoints > secondPoints) {
        firstRow.W += 1;
        firstRow.PTS += 2;
        secondRow.L += 1;
      } else if (secondPoints > firstPoints) {
        secondRow.W += 1;
        secondRow.PTS += 2;
        firstRow.L += 1;
      } else {
        firstRow.T += 1;
        secondRow.T += 1;
        firstRow.PTS += 1;
        secondRow.PTS += 1;
      }
    }
  }

  for (const row of table.values()) {
    row.DIFF = row.PF - row.PA;
  }

  const standings = Array.from(table.values()).sort(
    (left, right) => {
      if (right.PTS !== left.PTS) {
        return right.PTS - left.PTS;
      }
      if (right.DIFF !== left.DIFF) {
        return right.DIFF - left.DIFF;
      }
      if (right.PF !== left.PF) {
        return right.PF - left.PF;
      }
      return String(left.teamName).localeCompare(
        String(right.teamName)
      );
    }
  );

  return {
    ok: true,
    computedAtMs: nowMs,
    weeksCounted: countedWeekIds.length,
    countedWeekIds,
    standings,
  };
}

module.exports = { calculateStandings };
