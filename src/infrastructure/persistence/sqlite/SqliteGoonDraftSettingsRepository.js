"use strict";
const { GOON_ID } = require("./goonDraftTiming");
const { repositoryError } = require("./SqliteRepositoryError");

function createSqliteGoonDraftSettingsRepository({ database }) {
  function read({ leagueId, fadId }) {
    if (leagueId !== GOON_ID) throw repositoryError("FREE_AGENT_DRAFT_NOT_FOUND", "Draft not found.");
    const row = database.prepare(`SELECT id,version,status,candidate_deadline_at_ms,
      auction_creation_cutoff_minutes,rollover_interval_minutes FROM free_agent_drafts
      WHERE league_id=? AND id=?`).get(leagueId, fadId);
    if (!row) throw repositoryError("FREE_AGENT_DRAFT_NOT_FOUND", "Draft not found.");
    return { leagueId, fadId: row.id, version: row.version,
      rolloverIntervalMinutes: row.rollover_interval_minutes,
      auctionCreationCutoffMinutes: row.auction_creation_cutoff_minutes,
      editable: row.status === "cards_open" && row.candidate_deadline_at_ms === null };
  }
  function update(input, authorize) {
    return database.transaction(() => {
      authorize();
      const current = read(input);
      if (!current.editable) throw repositoryError("FAD_SEASON_CLOSED", "Timing is frozen after scheduling.");
      if (current.version !== input.expectedVersion) throw repositoryError("REPOSITORY_VERSION_CONFLICT", "Draft changed.");
      if (current.rolloverIntervalMinutes === input.rolloverIntervalMinutes &&
          current.auctionCreationCutoffMinutes === input.auctionCreationCutoffMinutes) return current;
      database.prepare(`UPDATE free_agent_drafts SET rollover_interval_minutes=?,auction_creation_cutoff_minutes=?,
        updated_at_ms=?,version=version+1 WHERE league_id=? AND id=? AND version=?`).run(
        input.rolloverIntervalMinutes,input.auctionCreationCutoffMinutes,input.nowMs,input.leagueId,input.fadId,input.expectedVersion);
      return read(input);
    }).immediate();
  }
  return Object.freeze({ read, update });
}
module.exports = { createSqliteGoonDraftSettingsRepository };
