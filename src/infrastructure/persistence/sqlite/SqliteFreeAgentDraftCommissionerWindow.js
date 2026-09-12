"use strict";

const { repositoryError } = require("./SqliteRepositoryError");

const FAD_SEASON_CLOSED_MESSAGE =
  "Free Agent Draft changes are closed during the season. They become available for next season after the Entry Draft is complete.";

// Read inside the caller's transaction immediately before a human FAD write.
// League activation is deliberately not the competition-start boundary: it
// creates the inaugural readiness handoff before the first matchup begins.
function readFreeAgentDraftCommissionerWindow(database, { leagueId, seasonId, nowMs }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw repositoryError("REPOSITORY_ARGUMENT_INVALID", "A current server timestamp is required.");
  }
  const season = database.prepare(`
    SELECT season.status, season.free_agent_draft_completed_at_ms,
      (SELECT MIN(starts_at_ms) FROM matchup_weeks
        WHERE league_id = season.league_id AND season_id = season.id) AS first_week_at_ms,
      EXISTS(SELECT 1 FROM matchup_weeks
        WHERE league_id = season.league_id AND season_id = season.id
          AND status IN ('baseline_ready', 'live', 'awaiting_data', 'final')) AS started_week,
      EXISTS(SELECT 1 FROM matchups
        WHERE league_id = season.league_id AND season_id = season.id
          AND status IN ('baseline_ready', 'live', 'awaiting_data', 'final')) AS started_matchup,
      EXISTS(SELECT 1 FROM seasons prior
        WHERE prior.league_id = season.league_id
          AND prior.nhl_season_key < season.nhl_season_key) AS has_prior_season,
      EXISTS(SELECT 1 FROM entry_drafts
        WHERE league_id = season.league_id AND season_id = season.id
          AND status = 'completed' AND completed_at_ms IS NOT NULL
          AND completed_at_ms <= @nowMs) AS entry_draft_completed,
      EXISTS(SELECT 1 FROM free_agent_draft_readiness_operations
        WHERE league_id = season.league_id AND season_id = season.id
          AND trigger_kind = 'no_draft_initial_season2'
          AND setup_exemption_id IS NOT NULL) AS initial_season_exemption
    FROM seasons season JOIN leagues league ON league.id = season.league_id
    WHERE season.league_id = @leagueId AND season.id = @seasonId
      AND league.status <> 'deleted'
  `).get({ leagueId, seasonId, nowMs });
  const closed = !season || ["completed", "cancelled"].includes(season.status) ||
    season.started_week === 1 || season.started_matchup === 1 ||
    (season.free_agent_draft_completed_at_ms !== null &&
      season.first_week_at_ms !== null && season.first_week_at_ms <= nowMs);
  const waitingForEntryDraft = season?.has_prior_season === 1 &&
    season.entry_draft_completed !== 1 && season.initial_season_exemption !== 1;
  return Object.freeze({
    allowed: !closed && !waitingForEntryDraft,
    reasonCode: closed ? "FAD_SEASON_CLOSED" : waitingForEntryDraft ? "FAD_ENTRY_DRAFT_REQUIRED" : null,
  });
}

function requireFreeAgentDraftCommissionerWindow(database, scope) {
  const capability = readFreeAgentDraftCommissionerWindow(database, scope);
  if (!capability.allowed) {
    throw repositoryError(capability.reasonCode, FAD_SEASON_CLOSED_MESSAGE);
  }
  return capability;
}

module.exports = {
  FAD_SEASON_CLOSED_MESSAGE,
  readFreeAgentDraftCommissionerWindow,
  requireFreeAgentDraftCommissionerWindow,
};
