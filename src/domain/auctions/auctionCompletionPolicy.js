const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const AUCTION_COMPLETION_CODES = Object.freeze({
  inputInvalid: "AUCTION_COMPLETION_INPUT_INVALID",
  stableIdInvalid: "AUCTION_COMPLETION_STABLE_ID_INVALID",
  seasonInvalid: "AUCTION_COMPLETION_SEASON_INVALID",
  seasonConflict: "AUCTION_COMPLETION_SEASON_CONFLICT",
  termInvalid: "AUCTION_COMPLETION_TERM_INVALID",
  timestampInvalid: "AUCTION_COMPLETION_TIMESTAMP_INVALID",
});

class AuctionCompletionPolicyError extends Error {
  constructor(reasonCode) {
    super("The auction completion input is invalid.");
    this.name = "AuctionCompletionPolicyError";
    this.code = AUCTION_COMPLETION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new AuctionCompletionPolicyError(reasonCode);
}

function exactObject(input, expectedKeys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("|") !==
      [...expectedKeys].sort().join("|")
  ) {
    fail(AUCTION_COMPLETION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(AUCTION_COMPLETION_CODES.stableIdInvalid);
  }
  return value;
}

function timestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    fail(AUCTION_COMPLETION_CODES.timestampInvalid);
  }
  return value;
}

function season(input, leagueId) {
  exactObject(input, ["id", "label", "nhlSeasonKey", "status"]);
  if (
    !/^\d{4}$/.test(input.label) ||
    !/^\d{8}$/.test(input.nhlSeasonKey) ||
    !["planned", "active", "completed", "cancelled"].includes(input.status)
  ) {
    fail(AUCTION_COMPLETION_CODES.seasonInvalid);
  }
  const startYear = Number(input.label);
  if (input.nhlSeasonKey !== `${startYear}${startYear + 1}`) {
    fail(AUCTION_COMPLETION_CODES.seasonInvalid);
  }
  return Object.freeze({
    id: stableId(input.id),
    leagueId,
    label: input.label,
    nhlSeasonKey: input.nhlSeasonKey,
    status: input.status,
  });
}

function planAuctionContractSeasons(input) {
  exactObject(input, [
    "leagueId",
    "currentSeason",
    "existingSeasons",
    "futureSeasonIds",
    "termYears",
    "nowMs",
  ]);
  const leagueId = stableId(input.leagueId);
  const currentSeason = season(input.currentSeason, leagueId);
  if (currentSeason.status !== "active") {
    fail(AUCTION_COMPLETION_CODES.seasonInvalid);
  }
  if (
    !Number.isSafeInteger(input.termYears) ||
    input.termYears < 1 ||
    input.termYears > 3
  ) {
    fail(AUCTION_COMPLETION_CODES.termInvalid);
  }
  const nowMs = timestamp(input.nowMs);
  if (
    !Array.isArray(input.existingSeasons) ||
    !Array.isArray(input.futureSeasonIds) ||
    input.futureSeasonIds.length !== 2
  ) {
    fail(AUCTION_COMPLETION_CODES.inputInvalid);
  }
  const existing = input.existingSeasons.map((value) =>
    season(value, leagueId)
  );
  const generatedIds = input.futureSeasonIds.map(stableId);
  const allIds = [currentSeason.id, ...existing.map(({ id }) => id)];
  if (
    new Set(existing.map(({ id }) => id)).size !== existing.length ||
    new Set(existing.map(({ nhlSeasonKey }) => nhlSeasonKey)).size !==
      existing.length ||
    new Set(existing.map(({ label }) => label)).size !== existing.length ||
    new Set(generatedIds).size !== generatedIds.length ||
    generatedIds.some((id) => allIds.includes(id))
  ) {
    fail(AUCTION_COMPLETION_CODES.seasonConflict);
  }
  const persistedCurrent = existing.find(
    ({ id }) => id === currentSeason.id
  );
  if (
    !persistedCurrent ||
    persistedCurrent.label !== currentSeason.label ||
    persistedCurrent.nhlSeasonKey !== currentSeason.nhlSeasonKey ||
    persistedCurrent.status !== currentSeason.status
  ) {
    fail(AUCTION_COMPLETION_CODES.seasonConflict);
  }

  const startYear = Number(currentSeason.label);
  const seasonIds = [currentSeason.id];
  const seasonsToCreate = [];
  let generatedIndex = 0;
  for (let offset = 1; offset < input.termYears; offset += 1) {
    const label = String(startYear + offset);
    const nhlSeasonKey = `${startYear + offset}${startYear + offset + 1}`;
    const byKey = existing.find(
      (candidate) => candidate.nhlSeasonKey === nhlSeasonKey
    );
    const byLabel = existing.find(
      (candidate) => candidate.label === label
    );
    if (byKey && byLabel && byKey.id !== byLabel.id) {
      fail(AUCTION_COMPLETION_CODES.seasonConflict);
    }
    const matched = byKey || byLabel || null;
    if (matched) {
      if (
        matched.label !== label ||
        matched.nhlSeasonKey !== nhlSeasonKey ||
        matched.status === "completed"
      ) {
        fail(AUCTION_COMPLETION_CODES.seasonConflict);
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
        label,
        nhlSeasonKey,
        status: "planned",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
    );
  }

  return Object.freeze({
    seasonIds: Object.freeze(seasonIds),
    seasonsToCreate: Object.freeze(seasonsToCreate),
  });
}

module.exports = {
  AUCTION_COMPLETION_CODES,
  AuctionCompletionPolicyError,
  planAuctionContractSeasons,
};
