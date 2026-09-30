function createLeagueAuctionScheduleReader(database) {
 const available=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='league_auction_schedule_changes'").get();
 const statement=available?database.prepare('SELECT close_weekday AS closeWeekday,close_minute_of_day AS closeMinuteOfDay,creation_cutoff_minutes AS creationCutoffMinutes FROM league_auction_schedule_changes WHERE league_id=? ORDER BY revision DESC LIMIT 1'):null;
 return leagueId=>statement?.get(leagueId)||null;
}
module.exports={createLeagueAuctionScheduleReader};

