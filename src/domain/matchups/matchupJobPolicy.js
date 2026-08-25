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

function buildMatchupOccurrenceKey({
  jobType,
  leagueId,
  seasonId,
  weekId,
  scheduleOperationId,
  scheduleVersion,
  scheduledForMs,
} = {}) {
  if (!M6_JOB_TYPES.includes(jobType)) invalid("An approved M6 job type is required.");
  for (const [label, value] of [
    ["league", leagueId],
    ["season", seasonId],
    ["week", weekId],
    ["schedule operation", scheduleOperationId],
  ]) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`A stable ${label} ID is required.`);
  }
  if (!Number.isSafeInteger(scheduleVersion) || scheduleVersion < 1) {
    invalid("A positive safe schedule version is required.");
  }
  if (!Number.isSafeInteger(scheduledForMs) || scheduledForMs < 0) {
    invalid("A safe scheduled instant is required.");
  }
  return `${jobType}:${leagueId}:${seasonId}:${weekId}:${scheduleOperationId}:${scheduleVersion}:${scheduledForMs}`;
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
  const segments = occurrenceKey.slice(prefix.length).split(":");
  if (segments.length === 2) {
    const [weekId, timestamp] = segments;
    if (
      !UUID_PATTERN.test(weekId) ||
      timestamp !== String(scheduledForMs) ||
      `${prefix}${weekId}:${scheduledForMs}` !== occurrenceKey
    ) {
      invalid("The matchup occurrence key is not canonical.");
    }
    return Object.freeze({
      jobType,
      leagueId,
      seasonId,
      weekId,
      scheduleOperationId: null,
      scheduleVersion: null,
      scheduledForMs,
    });
  }
  if (segments.length !== 4) {
    invalid("The matchup occurrence key is not canonical.");
  }
  const [
    weekId,
    scheduleOperationId,
    scheduleVersionText,
    timestamp,
  ] = segments;
  const scheduleVersion = Number(scheduleVersionText);
  if (
    !UUID_PATTERN.test(weekId) ||
    !UUID_PATTERN.test(scheduleOperationId) ||
    !Number.isSafeInteger(scheduleVersion) ||
    scheduleVersion < 1 ||
    scheduleVersionText !== String(scheduleVersion) ||
    timestamp !== String(scheduledForMs) ||
    buildMatchupOccurrenceKey({
      jobType,
      leagueId,
      seasonId,
      weekId,
      scheduleOperationId,
      scheduleVersion,
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
    scheduleOperationId,
    scheduleVersion,
    scheduledForMs,
  });
}

function parseQualifiedMatchupOccurrenceKey(input = {}) {
  const parsed = parseMatchupOccurrenceKey(input);
  if (
    parsed.scheduleOperationId === null ||
    parsed.scheduleVersion === null
  ) {
    invalid(
      "A generation-qualified matchup occurrence key is required."
    );
  }
  return parsed;
}

function isMatchupJobWeekSlot({
  jobType,
  scheduledForMs,
  startsAtMs,
  baselineAtMs,
  locksAtMs,
  endsAtMs,
  rollsOverAtMs,
} = {}) {
  if (!M6_JOB_TYPES.includes(jobType)) {
    invalid("An approved M6 job type is required.");
  }
  for (const value of [
    scheduledForMs,
    startsAtMs,
    baselineAtMs,
    locksAtMs,
    endsAtMs,
    rollsOverAtMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      invalid("Safe matchup job and week instants are required.");
    }
  }
  if (jobType === "matchup:statistics_refresh") {
    return (
      scheduledForMs === startsAtMs ||
      scheduledForMs === endsAtMs
    );
  }
  if (jobType === "matchup:baseline") {
    return scheduledForMs === baselineAtMs;
  }
  if (jobType === "matchup:lock") {
    return scheduledForMs === locksAtMs;
  }
  if (jobType === "matchup:finalize") {
    return scheduledForMs === endsAtMs;
  }
  return scheduledForMs === rollsOverAtMs;
}

module.exports = {
  M6_JOB_TYPES,
  MATCHUP_JOB_CODES,
  buildMatchupOccurrenceKey,
  isMatchupJobWeekSlot,
  parseMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
};
