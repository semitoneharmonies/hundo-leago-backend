const { hashCanonicalJsonV1, serializeCanonicalJsonV1, compareUnicodeScalarStrings } = require("../leagues/seasonRolloverEvidencePolicy");
const { assertNhlSeasonKey } = require("./statisticsPolicy");
const { OBSERVED_GAME_STATES } = require("./playerGameStatisticsPolicy");
const { EXPANDED_SCORING_VERSION, CATEGORY_KEYS, normalizeScoringStats, calculateExpandedScore } = require("./expandedScoringPolicy");

const DOMAIN = "hundo-leago.shared-game-evidence.v1";
const KEYS = ["playerId", "providerPlayerId", "providerTeamId", "nhlGameId", "scheduledStartsAtMs", "gameState", "gamesPlayed", "goals", "assists", "scoringRuleVersion", "scoringStats"];
const SORTED_KEYS = Object.freeze([...KEYS].sort());
const SORTED_CATEGORY_KEYS = Object.freeze([...CATEGORY_KEYS].sort());
const preparedEntries = new WeakSet();
function invalid(message) { throw new TypeError(message); }
function stableId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) invalid("A canonical evidence identifier is required.");
  return value;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > 8_640_000_000_000_000) invalid("A safe evidence timestamp is required.");
  return value;
}
function text(value, maximum) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid("A canonical game identifier is required.");
  serializeCanonicalJsonV1(value); // Also rejects malformed Unicode scalars.
  return value;
}
function number(value) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) invalid("Game statistics must be nonnegative integers.");
  return value;
}
function gameKey(record) { return `${record.playerId}\u0000${record.nhlGameId}`; }

function normalizeGameRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))) invalid("Shared game evidence has an unexpected shape.");
  if (!/^[1-9][0-9]{0,19}$/.test(value.providerPlayerId) || typeof value.providerPlayerId !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(value.providerTeamId) || typeof value.providerTeamId !== "string") invalid("Provider player and team identities are required.");
  if (!OBSERVED_GAME_STATES.includes(value.gameState) || ![0, 1].includes(value.gamesPlayed)) invalid("Invalid game state or participation.");
  number(value.gamesPlayed);
  const goals = number(value.goals), assists = number(value.assists);
  if (!Number.isSafeInteger(goals + assists) || !Number.isSafeInteger(goals * 125 + assists * 100)) invalid("Game points exceed exact arithmetic.");
  if ((value.gameState !== "final" && value.gamesPlayed !== 0) || (value.gamesPlayed === 0 && (goals !== 0 || assists !== 0))) invalid("Unplayed games cannot contain scoring statistics.");
  let scoringStats = null;
  if (value.scoringRuleVersion === null) {
    if (value.scoringStats !== null) invalid("Base game evidence cannot contain expanded categories.");
  } else {
    if (value.scoringRuleVersion !== EXPANDED_SCORING_VERSION) invalid("Unsupported game scoring rule.");
    scoringStats = normalizeScoringStats(value.scoringStats);
    Object.values(scoringStats).forEach(number);
    if (scoringStats.evenStrengthGoals + scoringStats.powerPlayGoals + scoringStats.shortHandedGoals !== goals ||
        scoringStats.primaryAssists + scoringStats.secondaryAssists !== assists ||
        (value.gamesPlayed === 0 && Object.values(scoringStats).some(count => count !== 0))) invalid("Game categories do not reconcile with participation and totals.");
    calculateExpandedScore(scoringStats, "F"); calculateExpandedScore(scoringStats, "D");
  }
  return Object.freeze({ playerId: stableId(value.playerId), providerPlayerId: value.providerPlayerId,
    providerTeamId: value.providerTeamId, nhlGameId: text(value.nhlGameId, 200),
    scheduledStartsAtMs: timestamp(value.scheduledStartsAtMs), gameState: value.gameState,
    gamesPlayed: value.gamesPlayed, goals, assists, scoringRuleVersion: value.scoringRuleVersion, scoringStats });
}

function prepareGameRecord(value) {
  const record = normalizeGameRecord(value);
  // This fixed schema has only safe integers, validated strings and plain data.
  // Sorted ASCII field names produce the existing canonical-json-v1 bytes.
  const ordered = Object.fromEntries(SORTED_KEYS.map(key => [key, key === "scoringStats" && record.scoringStats !== null
    ? Object.fromEntries(SORTED_CATEGORY_KEYS.map(category => [category, record.scoringStats[category]])) : record[key]]));
  const payload = JSON.stringify(ordered);
  const entry = Object.freeze({ record, key: gameKey(record), payload, sha256: createHash("sha256").update(payload).digest("hex") });
  preparedEntries.add(entry);
  return entry;
}

function finishGameCapture({ statSourceId, nhlSeasonKey }, entries) {
  stableId(statSourceId); assertNhlSeasonKey(nhlSeasonKey);
  if (!Array.isArray(entries) || entries.some(entry => !preparedEntries.has(entry))) invalid("Validated game evidence is required.");
  const sorted = [...entries].sort((a, b) => a.record.playerId === b.record.playerId
    ? compareUnicodeScalarStrings(a.record.nhlGameId, b.record.nhlGameId) : a.record.playerId < b.record.playerId ? -1 : 1);
  const hash = createHash("sha256");
  hash.update(`{"domain":${JSON.stringify(DOMAIN)},"nhlSeasonKey":${JSON.stringify(nhlSeasonKey)},"records":[`);
  for (let n = 0; n < sorted.length; n++) {
    if (n > 0 && sorted[n - 1].key === sorted[n].key) invalid("Duplicate player-game evidence.");
    if (n > 0) hash.update(",");
    hash.update(sorted[n].payload);
  }
  hash.update(`],"statSourceId":${JSON.stringify(statSourceId)}}`);
  return Object.freeze({ entries: Object.freeze(sorted), records: Object.freeze(sorted.map(entry => entry.record)), evidenceSha256: hash.digest("hex") });
}

function prepareGameCapture(command) {
  if (!Array.isArray(command?.records)) invalid("Complete game evidence records are required.");
  return finishGameCapture(command, command.records.map(prepareGameRecord));
}

async function prepareGameCaptureAsync(command) {
  if (!Array.isArray(command?.records)) invalid("Complete game evidence records are required.");
  const scope = { statSourceId: stableId(command.statSourceId), nhlSeasonKey: assertNhlSeasonKey(command.nhlSeasonKey) };
  // Take ownership before yielding so caller mutations cannot mix observations.
  const records = command.records.map(row => row && typeof row === "object" && !Array.isArray(row)
    ? { ...row, scoringStats: row.scoringStats && typeof row.scoringStats === "object" && !Array.isArray(row.scoringStats) ? { ...row.scoringStats } : row.scoringStats } : row);
  const entries = [];
  for (let n = 0; n < records.length; n++) {
    entries.push(prepareGameRecord(records[n]));
    if ((n + 1) % 256 === 0) await yieldToEventLoop();
  }
  return finishGameCapture(scope, entries);
}

function normalizeGameCapture(command) {
  const { records, evidenceSha256 } = prepareGameCapture(command);
  return Object.freeze({ records, evidenceSha256 });
}

// Observation time belongs to the capture. It is not an NHL game correction.
module.exports = { normalizeGameRecord, normalizeGameCapture, prepareGameRecord, prepareGameCapture, prepareGameCaptureAsync,
  finishGameCapture, gameKey, stableId, timestamp, hashCanonicalJsonV1, serializeCanonicalJsonV1 };
const { createHash } = require("node:crypto");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
