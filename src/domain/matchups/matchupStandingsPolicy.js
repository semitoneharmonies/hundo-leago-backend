const MATCHUP_STANDINGS_CODES = Object.freeze({
  inputInvalid: "MATCHUP_STANDINGS_INPUT_INVALID",
  participantMissing: "MATCHUP_STANDINGS_PARTICIPANT_MISSING",
});

class MatchupStandingsPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupStandingsPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupStandingsPolicyError(code, message);
}

function calculateStandings({ participants, results } = {}) {
  if (!Array.isArray(participants) || !Array.isArray(results)) {
    fail(MATCHUP_STANDINGS_CODES.inputInvalid, "Participants and finalized results are required.");
  }
  const rows = new Map();
  for (const participant of participants) {
    if (
      !participant ||
      typeof participant.team_id !== "string" ||
      typeof participant.team_display_name !== "string" ||
      participant.team_display_name.length < 1 ||
      rows.has(participant.team_id)
    ) {
      fail(MATCHUP_STANDINGS_CODES.inputInvalid, "Participants require unique stable IDs and names.");
    }
    rows.set(participant.team_id, {
      teamId: participant.team_id,
      teamDisplayName: participant.team_display_name,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      standingsPoints: 0,
      pointsPercentageHundredths: 0,
      fantasyPointsForHundredths: 0,
      fantasyPointsAgainstHundredths: 0,
      fantasyPointsDifferentialHundredths: 0,
    });
  }
  for (const result of results) {
    const home = rows.get(result?.home_team_id);
    const away = rows.get(result?.away_team_id);
    if (!home || !away || home === away) {
      fail(MATCHUP_STANDINGS_CODES.participantMissing, "A finalized result references an unknown participant.");
    }
    const homeScore = result.home_score_hundredths;
    const awayScore = result.away_score_hundredths;
    if (
      !Number.isSafeInteger(homeScore) || homeScore < 0 ||
      !Number.isSafeInteger(awayScore) || awayScore < 0
    ) {
      fail(MATCHUP_STANDINGS_CODES.inputInvalid, "Finalized scores must be nonnegative integers.");
    }
    home.gamesPlayed += 1;
    away.gamesPlayed += 1;
    home.fantasyPointsForHundredths += homeScore;
    home.fantasyPointsAgainstHundredths += awayScore;
    away.fantasyPointsForHundredths += awayScore;
    away.fantasyPointsAgainstHundredths += homeScore;
    if (homeScore === awayScore) {
      home.ties += 1;
      away.ties += 1;
      home.standingsPoints += 1;
      away.standingsPoints += 1;
    } else if (homeScore > awayScore) {
      home.wins += 1;
      away.losses += 1;
      home.standingsPoints += 2;
    } else {
      away.wins += 1;
      home.losses += 1;
      away.standingsPoints += 2;
    }
  }
  const sorted = [...rows.values()];
  for (const row of sorted) {
    row.fantasyPointsDifferentialHundredths =
      row.fantasyPointsForHundredths - row.fantasyPointsAgainstHundredths;
    row.pointsPercentageHundredths =
      row.gamesPlayed === 0
        ? 0
        : Math.round(
            (row.standingsPoints * 10_000) / (row.gamesPlayed * 2)
          );
  }
  sorted.sort((left, right) =>
    right.standingsPoints - left.standingsPoints ||
    right.fantasyPointsDifferentialHundredths - left.fantasyPointsDifferentialHundredths ||
    right.fantasyPointsForHundredths - left.fantasyPointsForHundredths ||
    left.teamDisplayName.localeCompare(right.teamDisplayName) ||
    left.teamId.localeCompare(right.teamId)
  );
  let prior = null;
  sorted.forEach((row, index) => {
    const tied = prior &&
      prior.standingsPoints === row.standingsPoints &&
      prior.fantasyPointsDifferentialHundredths === row.fantasyPointsDifferentialHundredths &&
      prior.fantasyPointsForHundredths === row.fantasyPointsForHundredths;
    row.rank = tied ? prior.rank : index + 1;
    prior = row;
  });
  return Object.freeze(sorted.map((row) => Object.freeze({ ...row })));
}

module.exports = {
  MATCHUP_STANDINGS_CODES,
  MatchupStandingsPolicyError,
  calculateStandings,
};
