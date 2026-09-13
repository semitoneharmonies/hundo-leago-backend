const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_TEXT_PATTERN =
  /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const SEASON_STATUSES = new Set([
  "planned",
  "active",
  "completed",
  "cancelled",
]);

const CONTRACT_SEASON_PLANNER_CODES = Object.freeze({
  inputInvalid: "CONTRACT_SEASON_PLANNER_INPUT_INVALID",
  stableIdInvalid:
    "CONTRACT_SEASON_PLANNER_STABLE_ID_INVALID",
  seasonInvalid: "CONTRACT_SEASON_PLANNER_SEASON_INVALID",
  seasonConflict:
    "CONTRACT_SEASON_PLANNER_SEASON_CONFLICT",
  termInvalid: "CONTRACT_SEASON_PLANNER_TERM_INVALID",
  timestampInvalid:
    "CONTRACT_SEASON_PLANNER_TIMESTAMP_INVALID",
});

class ContractSeasonPlannerError extends Error {
  constructor(reasonCode) {
    super("The contract season plan is invalid.");
    this.name = "ContractSeasonPlannerError";
    this.code =
      CONTRACT_SEASON_PLANNER_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new ContractSeasonPlannerError(reasonCode);
}

function exactObject(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.timestampInvalid);
  }
  return value;
}

function displayLabel(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim() !== value ||
    Array.from(value).length > 100 ||
    !SAFE_TEXT_PATTERN.test(value)
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  return value;
}

function canonicalSeasonKey(value) {
  if (
    typeof value !== "string" ||
    !/^\d{8}$/.test(value)
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  const startYear = Number(value.slice(0, 4));
  const endYear = Number(value.slice(4));
  if (endYear !== startYear + 1) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  return Object.freeze({ value, startYear });
}

function canonicalSeasonIdentity(startYear) {
  const endYear = startYear + 1;
  if (
    !Number.isSafeInteger(startYear) ||
    startYear < 0 ||
    startYear > 9_999 ||
    endYear > 9_999
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  return Object.freeze({
    nhlSeasonKey:
      String(startYear).padStart(4, "0") +
      String(endYear).padStart(4, "0"),
    label:
      `${String(startYear).padStart(4, "0")}-` +
      String(endYear % 100).padStart(2, "0"),
  });
}

function normalizeSeason(input, expectedLeagueId) {
  exactObject(input, [
    "id",
    "leagueId",
    "label",
    "nhlSeasonKey",
    "status",
  ]);
  const leagueId = stableId(input.leagueId);
  if (leagueId !== expectedLeagueId) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
  }
  if (!SEASON_STATUSES.has(input.status)) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  const key = canonicalSeasonKey(input.nhlSeasonKey);
  return Object.freeze({
    id: stableId(input.id),
    leagueId,
    label: displayLabel(input.label),
    nhlSeasonKey: key.value,
    startYear: key.startYear,
    status: input.status,
  });
}

function assertUniqueExistingSeasons(existing) {
  for (const property of ["id", "nhlSeasonKey", "label"]) {
    if (
      new Set(existing.map((season) => season[property])).size !==
      existing.length
    ) {
      fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
    }
  }
}

function assertTargetSeason(targetSeason, existing) {
  if (targetSeason.status !== "active") {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonInvalid);
  }
  const persistedTarget = existing.find(
    ({ id }) => id === targetSeason.id
  );
  if (
    !persistedTarget ||
    persistedTarget.leagueId !== targetSeason.leagueId ||
    persistedTarget.label !== targetSeason.label ||
    persistedTarget.nhlSeasonKey !==
      targetSeason.nhlSeasonKey ||
    persistedTarget.status !== targetSeason.status ||
    existing.filter(({ status }) => status === "active").length !== 1
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
  }
}

function planContractSeasons(input) {
  exactObject(input, [
    "leagueId",
    "targetSeason",
    "existingSeasons",
    "futureSeasonIds",
    "termYears",
    "nowMs",
  ]);
  const leagueId = stableId(input.leagueId);
  if (
    !Number.isSafeInteger(input.termYears) ||
    input.termYears < 1 ||
    input.termYears > 3
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.termInvalid);
  }
  const nowMs = safeTimestamp(input.nowMs);
  if (
    !Array.isArray(input.existingSeasons) ||
    !Array.isArray(input.futureSeasonIds) ||
    input.futureSeasonIds.length !== 2
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.inputInvalid);
  }

  const targetSeason = normalizeSeason(
    input.targetSeason,
    leagueId
  );
  const existing = input.existingSeasons.map((season) =>
    normalizeSeason(season, leagueId)
  );
  assertUniqueExistingSeasons(existing);
  assertTargetSeason(targetSeason, existing);

  const generatedIds = input.futureSeasonIds.map(stableId);
  if (
    new Set(generatedIds).size !== generatedIds.length ||
    generatedIds.some((id) =>
      existing.some((season) => season.id === id)
    )
  ) {
    fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
  }

  const byKey = new Map(
    existing.map((season) => [season.nhlSeasonKey, season])
  );
  const byLabel = new Map(
    existing.map((season) => [season.label, season])
  );
  const seasonIds = [targetSeason.id];
  const seasonsToCreate = [];
  let generatedIndex = 0;

  for (
    let offset = 1;
    offset < input.termYears;
    offset += 1
  ) {
    const identity = canonicalSeasonIdentity(
      targetSeason.startYear + offset
    );
    const keyMatch =
      byKey.get(identity.nhlSeasonKey) || null;
    const labelMatch =
      byLabel.get(identity.label) || null;
    if (
      keyMatch &&
      labelMatch &&
      keyMatch.id !== labelMatch.id
    ) {
      fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
    }
    const matched = keyMatch || labelMatch;
    if (matched) {
      if (
        matched.nhlSeasonKey !== identity.nhlSeasonKey ||
        matched.label !== identity.label ||
        matched.status !== "planned"
      ) {
        fail(CONTRACT_SEASON_PLANNER_CODES.seasonConflict);
      }
      seasonIds.push(matched.id);
      continue;
    }

    const id = generatedIds[generatedIndex];
    generatedIndex += 1;
    seasonIds.push(id);
    seasonsToCreate.push(
      Object.freeze({
        id,
        leagueId,
        label: identity.label,
        nhlSeasonKey: identity.nhlSeasonKey,
        status: "planned",
        regularSeasonStartsAtMs: null,
        regularSeasonEndsAtMs: null,
        fantasyPlayoffsStartAtMs: null,
        fantasyPlayoffsEndAtMs: null,
        freeAgentDraftCompletedAtMs: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        version: 1,
      })
    );
  }

  return Object.freeze({
    seasonIds: Object.freeze(seasonIds),
    seasonsToCreate: Object.freeze(seasonsToCreate),
  });
}

module.exports = {
  CONTRACT_SEASON_PLANNER_CODES,
  ContractSeasonPlannerError,
  planContractSeasons,
};
