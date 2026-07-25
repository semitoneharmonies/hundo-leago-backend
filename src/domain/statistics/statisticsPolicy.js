const STATISTICS_CODES = Object.freeze({
  inputInvalid: "STATISTICS_INPUT_INVALID",
  responseIncomplete: "STATISTICS_RESPONSE_INCOMPLETE",
});

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

class StatisticsPolicyError extends Error {
  constructor(code, message, { details } = {}) {
    super(message);
    this.name = "StatisticsPolicyError";
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new StatisticsPolicyError(code, message, { details });
}

function assertNhlSeasonKey(value) {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) {
    fail(STATISTICS_CODES.inputInvalid, "An NHL season key is required.");
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    fail(STATISTICS_CODES.inputInvalid, "The NHL season key is not consecutive.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail(STATISTICS_CODES.inputInvalid, "A safe source timestamp is required.");
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(STATISTICS_CODES.inputInvalid, `${field} must be a non-negative integer.`);
  }
  return value;
}

function providerPlayerId(value) {
  const normalized = typeof value === "number" ? String(value) : value;
  if (
    typeof normalized !== "string" ||
    !/^\d{1,20}$/.test(normalized) ||
    normalized === "0"
  ) {
    fail(STATISTICS_CODES.inputInvalid, "A stable NHL player identifier is required.");
  }
  return normalized;
}

function normalizeStatisticsRows({ rows, minimumPlayerCount, sourceUpdatedAtMs } = {}) {
  if (!Array.isArray(rows)) {
    fail(STATISTICS_CODES.inputInvalid, "Statistics rows must be an array.");
  }
  if (!Number.isSafeInteger(minimumPlayerCount) || minimumPlayerCount < 1) {
    fail(STATISTICS_CODES.inputInvalid, "A positive minimum player count is required.");
  }
  const updatedAtMs = safeTimestamp(sourceUpdatedAtMs);
  const seen = new Set();
  const normalized = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail(STATISTICS_CODES.inputInvalid, "Each statistics row must be an object.");
    }
    const externalPlayerId = providerPlayerId(row.playerId);
    if (seen.has(externalPlayerId)) {
      fail(STATISTICS_CODES.inputInvalid, "Statistics rows contain a duplicate player.", {
        externalPlayerId,
      });
    }
    seen.add(externalPlayerId);
    const gamesPlayed = nonNegativeInteger(row.gamesPlayed, "gamesPlayed");
    const goals = nonNegativeInteger(row.goals, "goals");
    const assists = nonNegativeInteger(row.assists, "assists");
    return Object.freeze({
      externalPlayerId,
      gamesPlayed,
      goals,
      assists,
      nhlPoints: goals + assists,
      fantasyPointsHundredths: goals * 125 + assists * 100,
      sourceUpdatedAtMs: updatedAtMs,
    });
  });
  if (normalized.length < minimumPlayerCount) {
    fail(
      STATISTICS_CODES.responseIncomplete,
      "The statistics response did not contain the required player count.",
      { actualPlayerCount: normalized.length, minimumPlayerCount }
    );
  }
  return Object.freeze(normalized);
}

module.exports = {
  STATISTICS_CODES,
  StatisticsPolicyError,
  assertNhlSeasonKey,
  normalizeStatisticsRows,
};
