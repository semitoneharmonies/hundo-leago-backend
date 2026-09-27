const { calculateTeamCap } = require("./capPolicy");

// A projection of saved commitments, holding roster categories and the cap fixed.
// Reading this projection never advances a contract year or creates a season.
function buildCapOutlook({ scope, players, cap, seasons, contractYears, retentionYears, buyoutYears }) {
  const startYear = Number(scope.nhl_season_key.slice(0, 4));
  if (!/^\d{8}$/.test(scope.nhl_season_key) || !Number.isInteger(startYear)) {
    return null;
  }
  const columns = Array.from({ length: 3 }, (_, offset) => {
    const year = startYear + offset;
    const key = `${year}${year + 1}`;
    const saved = seasons.find((season) => season.nhl_season_key === key);
    return {
      key,
      label: offset === 0 ? scope.season_label : saved?.label || `${year}–${String(year + 1).slice(-2)}`,
      offset,
      seasonId: offset === 0 ? scope.season_id : saved?.id || null,
    };
  });
  const inColumn = (year, column) => year.season_id === column.seasonId &&
    year.status === (column.offset === 0 ? "current" : "future");
  const rows = players.map((player) => ({
    id: player.ownership_id,
    ownershipId: player.ownership_id,
    playerId: player.player_id,
    name: player.full_name,
    category: player.roster_category === "Active"
      ? player.position_group === "F" ? "Forwards" : "Defence"
      : player.roster_category,
    amountsCents: columns.map((column) => {
      const year = contractYears.find((item) => item.contract_id === player.contract_id && inColumn(item, column));
      if (!year) return null;
      const retained = retentionYears
        .filter((item) => item.contract_id === player.contract_id && inColumn(item, column))
        .reduce((sum, item) => sum + item.amount_cents, 0);
      return year.aav_cents - retained;
    }),
  }));
  for (const [category, years] of [["Retained salary", retentionYears.filter((year) => year.responsible_team_id === scope.team_id)], ["Buyouts", buyoutYears]]) {
    for (const id of new Set(years.map((year) => year.obligation_id))) {
      const savedYears = years.filter((year) => year.obligation_id === id);
      rows.push({
        id,
        ownershipId: null,
        playerId: savedYears[0].player_id,
        name: savedYears[0].player_name,
        category,
        amountsCents: columns.map((column) => savedYears.find((year) => inColumn(year, column))?.amount_cents ?? null),
      });
    }
  }
  const total = (category, index) => rows.filter((row) => row.category === category)
    .reduce((sum, row) => sum + (row.amountsCents[index] ?? 0), 0);
  const projectedSeasons = columns.map((column, index) => {
    const activePlayers = players.filter((player) => player.roster_category === "Active").flatMap((player) => {
      const year = contractYears.find((item) => item.contract_id === player.contract_id && inColumn(item, column));
      if (!year) return [];
      return [{
        playerId: player.player_id, ownershipId: player.ownership_id, contractId: player.contract_id,
        aavCents: year.aav_cents,
        retainedAavCents: retentionYears.filter((item) => item.contract_id === player.contract_id && inColumn(item, column))
          .reduce((sum, item) => sum + item.amount_cents, 0),
      }];
    });
    const obligations = (years, idKey) => years.filter((year) => inColumn(year, column)).map((year) => ({
      [idKey]: year.obligation_id, contractId: year.contract_id, playerId: year.player_id, amountCents: year.amount_cents,
    }));
    const projected = calculateTeamCap({
      leagueId: scope.league_id,
      seasonId: column.seasonId || scope.season_id,
      teamId: scope.team_id,
      salaryCapCents: cap.capLimitCents,
      activePlayers,
      retentionObligations: obligations(retentionYears.filter((year) => year.responsible_team_id === scope.team_id), "retentionId"),
      buyoutObligations: obligations(buyoutYears, "buyoutId"),
      issues: cap.issues,
    });
    return {
      key: column.key, label: column.label, offset: column.offset,
      complete: cap.complete && (index !== 0 || projected.capUsageCents === cap.capUsageCents),
      limitCents: projected.capLimitCents,
      usageCents: projected.capUsageCents,
      spaceCents: projected.capSpaceCents,
      forwardCents: total("Forwards", index),
      defenceCents: total("Defence", index),
      retainedSalaryCents: projected.breakdown.retentionCents,
      buyoutPenaltyCents: projected.breakdown.buyoutCents,
      benchCents: total("Bench", index),
      injuredReserveCents: total("Injured Reserve", index),
      prospectCents: total("Prospect", index),
    };
  });
  // A mismatch with the authoritative current cap makes the basis of the
  // entire outlook uncertain, including its future columns.
  if (!projectedSeasons[0].complete) {
    for (const season of projectedSeasons) season.complete = false;
  }
  return { seasons: projectedSeasons, rows };
}

module.exports = { buildCapOutlook };
