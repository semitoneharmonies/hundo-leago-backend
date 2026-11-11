const JOB_TYPE = "encrypted_database_backup";
const TWICE_WEEKLY_CADENCE = "twice-weekly";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Vancouver uses UTC-07:00 year-round from March 2026. Each UTC anchor
// represents an occurrence of the requested local weekday and time.
const FRIDAY_MORNING = Date.UTC(2026, 10, 13, 15);
const SUNDAY_EVENING = Date.UTC(2026, 10, 16, 3);

function latestTwiceWeeklyOccurrence(nowMs) {
  function latestAt(anchor) {
    return anchor + Math.floor((nowMs - anchor) / WEEK_MS) * WEEK_MS;
  }
  return Math.max(latestAt(FRIDAY_MORNING), latestAt(SUNDAY_EVENING));
}

module.exports = { JOB_TYPE, TWICE_WEEKLY_CADENCE, latestTwiceWeeklyOccurrence };
