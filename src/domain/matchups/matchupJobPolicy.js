const M6_JOB_TYPES = Object.freeze([
  "matchup:statistics_refresh",
  "matchup:baseline",
  "matchup:lock",
  "matchup:finalize",
  "matchup:rollover",
]);
const MATCHUP_JOB_CODES = Object.freeze({
  inputInvalid: "MATCHUP_JOB_INPUT_INVALID",
});
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function invalid(message) {
  const error = new TypeError(message);
  error.code = MATCHUP_JOB_CODES.inputInvalid;
  throw error;
}

function buildMatchupOccurrenceKey({ jobType, leagueId, seasonId, weekId, scheduledForMs } = {}) {
  if (!M6_JOB_TYPES.includes(jobType)) invalid("An approved M6 job type is required.");
  for (const [label, value] of [["league", leagueId], ["season", seasonId], ["week", weekId]]) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`A stable ${label} ID is required.`);
  }
  if (!Number.isSafeInteger(scheduledForMs) || scheduledForMs < 0) {
    invalid("A safe scheduled instant is required.");
  }
  return `${jobType}:${leagueId}:${seasonId}:${weekId}:${scheduledForMs}`;
}

function parseMatchupOccurrenceKey({
  jobType,
  leagueId,
  seasonId,
  occurrenceKey,
  scheduledForMs,
} = {}) {
  if (!M6_JOB_TYPES.includes(jobType)) invalid("An approved M6 job type is required.");
  for (const [label, value] of [["league", leagueId], ["season", seasonId]]) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      invalid(`A stable ${label} ID is required.`);
    }
  }
  if (!Number.isSafeInteger(scheduledForMs) || scheduledForMs < 0) {
    invalid("A safe scheduled instant is required.");
  }
  const prefix = `${jobType}:${leagueId}:${seasonId}:`;
  if (typeof occurrenceKey !== "string" || !occurrenceKey.startsWith(prefix)) {
    invalid("The matchup occurrence key does not match its scope.");
  }
  const suffix = occurrenceKey.slice(prefix.length);
  const separator = suffix.lastIndexOf(":");
  const weekId = suffix.slice(0, separator);
  const timestamp = suffix.slice(separator + 1);
  if (
    separator < 1 ||
    !UUID_PATTERN.test(weekId) ||
    timestamp !== String(scheduledForMs) ||
    buildMatchupOccurrenceKey({
      jobType,
      leagueId,
      seasonId,
      weekId,
      scheduledForMs,
    }) !== occurrenceKey
  ) {
    invalid("The matchup occurrence key is not canonical.");
  }
  return Object.freeze({
    jobType,
    leagueId,
    seasonId,
    weekId,
    scheduledForMs,
  });
}

module.exports = {
  M6_JOB_TYPES,
  MATCHUP_JOB_CODES,
  buildMatchupOccurrenceKey,
  parseMatchupOccurrenceKey,
};
