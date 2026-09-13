"use strict";

// Daily-auction staging also contains deliberately paused historical FAD
// fixtures. A commissioner-confirmed timetable enrolls a season in the full
// draft lifecycle. Keep that enrollment through later schedule recoveries.
function freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly = false, alias }) {
  if (typeof configuredSeasonsOnly !== "boolean") {
    throw new TypeError("FAD scheduler scope must be a boolean");
  }
  if (!/^[a-z_]+$/.test(alias)) {
    throw new TypeError("FAD scheduler scope requires a SQL alias");
  }
  if (!configuredSeasonsOnly) return "1";
  const supportsTiming = database.prepare(
    "SELECT name FROM pragma_table_info('season_matchup_schedule_generations') WHERE name = 'fad_timing_json'"
  ).get();
  if (!supportsTiming) return "0";
  return `EXISTS (
    SELECT 1 FROM season_matchup_schedule_generations AS enrolled_schedule
    WHERE enrolled_schedule.league_id = ${alias}.league_id
      AND enrolled_schedule.season_id = ${alias}.season_id
      AND enrolled_schedule.fad_timing_json IS NOT NULL
  )`;
}

module.exports = { freeAgentDraftSchedulerScopeSql };
