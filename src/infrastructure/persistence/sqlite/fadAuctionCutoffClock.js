const DEFAULT_GAP_MS=3_600_000;
function createFadAuctionCutoffClock(database) {
  const supported=database.prepare('PRAGMA user_version').get().user_version>=74;
  const read=supported?database.prepare('SELECT gap_ms FROM fad_auction_cutoff_settings WHERE league_id=? AND id=?'):null;
  const hasSavedDefault=database.prepare('PRAGMA table_info(free_agent_drafts)').all().some(c=>c.name==='auction_creation_cutoff_minutes');
  const savedDefault=hasSavedDefault?database.prepare('SELECT auction_creation_cutoff_minutes * 60000 AS gap_ms FROM free_agent_drafts WHERE league_id=? AND id=?'):null;
  const gap=({leagueId,fadId})=>read?.get(leagueId,fadId)?.gap_ms??savedDefault?.get(leagueId,fadId)?.gap_ms??DEFAULT_GAP_MS;
  return {
    gap,
    cutoff(scope,opensAtMs,rollsOverAtMs) { return Math.max(opensAtMs,rollsOverAtMs-gap(scope)); },
  };
}
module.exports={DEFAULT_GAP_MS,createFadAuctionCutoffClock};
