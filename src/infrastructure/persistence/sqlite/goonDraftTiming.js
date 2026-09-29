"use strict";

const GOON_ID = "48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03";

function readGoonDraftTiming(database, leagueId) {
  if (leagueId !== GOON_ID) return { cutoffMs: 3_600_000, intervalMs: 86_400_000 };
  const row = database.prepare(`SELECT auction_creation_cutoff_minutes,rollover_interval_minutes
    FROM free_agent_drafts WHERE league_id=? ORDER BY created_at_ms DESC LIMIT 1`).get(leagueId);
  if (!row) throw new Error("GOON_DRAFT_TIMING_UNAVAILABLE");
  return { cutoffMs: row.auction_creation_cutoff_minutes * 60_000,
    intervalMs: row.rollover_interval_minutes * 60_000 };
}

module.exports = { GOON_ID, readGoonDraftTiming };
