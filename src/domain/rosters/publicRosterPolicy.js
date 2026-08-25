const {
  isTeamPatternTemplate,
} = require("../leagues/teamPatternPolicy");

const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITION_GROUPS = Object.freeze(["F", "D"]);
const ROSTER_CATEGORIES = Object.freeze([
  "Active",
  "Bench",
  "Injured Reserve",
  "Prospect",
]);

const PUBLIC_ROSTER_CODES = Object.freeze({
  inputInvalid: "PUBLIC_ROSTER_INPUT_INVALID",
  stableIdInvalid: "PUBLIC_ROSTER_STABLE_ID_INVALID",
  textInvalid: "PUBLIC_ROSTER_TEXT_INVALID",
  dateInvalid: "PUBLIC_ROSTER_DATE_INVALID",
  playerInvalid: "PUBLIC_ROSTER_PLAYER_INVALID",
  amountInvalid: "PUBLIC_ROSTER_AMOUNT_INVALID",
  duplicatePlayer: "PUBLIC_ROSTER_PLAYER_DUPLICATE",
  capInvalid: "PUBLIC_ROSTER_CAP_INVALID",
});

class PublicRosterPolicyError extends Error {
  constructor(reasonCode) {
    super("The public roster projection material is invalid.");
    this.name = "PublicRosterPolicyError";
    this.code = PUBLIC_ROSTER_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new PublicRosterPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(PUBLIC_ROSTER_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(PUBLIC_ROSTER_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    fail(PUBLIC_ROSTER_CODES.stableIdInvalid);
  }
  return value;
}

function text(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    fail(PUBLIC_ROSTER_CODES.textInvalid);
  }
  return value;
}

function nonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(PUBLIC_ROSTER_CODES.amountInvalid);
  }
  return value;
}

function signedInteger(value) {
  if (!Number.isSafeInteger(value)) {
    fail(PUBLIC_ROSTER_CODES.amountInvalid);
  }
  return value;
}

function canonicalDate(value) {
  const match = typeof value === "string" ? value.match(DATE_PATTERN) : null;
  if (!match) fail(PUBLIC_ROSTER_CODES.dateInvalid);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(PUBLIC_ROSTER_CODES.dateInvalid);
  }
  return Object.freeze({ value, year, month, day });
}

function calculateAge(birthDate, asOfDate) {
  if (birthDate === null) return null;
  const birth = canonicalDate(birthDate);
  const asOf = canonicalDate(asOfDate);
  let age = asOf.year - birth.year;
  if (
    asOf.month < birth.month ||
    (asOf.month === birth.month && asOf.day < birth.day)
  ) {
    age -= 1;
  }
  if (age < 0 || age > 150) fail(PUBLIC_ROSTER_CODES.dateInvalid);
  return age;
}

function statistics(value) {
  if (value === null) return null;
  assertExactObject(value, [
    "gamesPlayed",
    "goals",
    "assists",
    "nhlPoints",
    "fantasyPointsHundredths",
  ]);
  const projected = Object.freeze({
    gamesPlayed: nonnegative(value.gamesPlayed),
    goals: nonnegative(value.goals),
    assists: nonnegative(value.assists),
    nhlPoints: nonnegative(value.nhlPoints),
    fantasyPointsHundredths: nonnegative(value.fantasyPointsHundredths),
  });
  if (projected.nhlPoints !== projected.goals + projected.assists) {
    fail(PUBLIC_ROSTER_CODES.playerInvalid);
  }
  return projected;
}

function player(value, asOfDate) {
  assertExactObject(value, [
    "id",
    "name",
    "position",
    "rosterCategory",
    "aavCents",
    "remainingContractYears",
    "birthDate",
    "statistics",
  ]);
  if (!POSITION_GROUPS.includes(value.position)) {
    fail(PUBLIC_ROSTER_CODES.playerInvalid);
  }
  if (!ROSTER_CATEGORIES.includes(value.rosterCategory)) {
    fail(PUBLIC_ROSTER_CODES.playerInvalid);
  }
  if (
    value.aavCents !== null &&
    (!Number.isSafeInteger(value.aavCents) || value.aavCents < 1)
  ) {
    fail(PUBLIC_ROSTER_CODES.amountInvalid);
  }
  const remainingContractYears = nonnegative(value.remainingContractYears);
  if (remainingContractYears > 3) {
    fail(PUBLIC_ROSTER_CODES.playerInvalid);
  }
  return Object.freeze({
    playerReference: stableId(value.id),
    name: text(value.name),
    normalizedPosition: value.position,
    rosterCategory: value.rosterCategory,
    aavCents: value.aavCents,
    remainingContractYears,
    age: calculateAge(value.birthDate, asOfDate),
    seasonStatistics: statistics(value.statistics),
  });
}

function createPublicRosterProjection(input) {
  assertExactObject(input, [
    "asOfDate",
    "league",
    "season",
    "team",
    "players",
    "cap",
    "updatedAt",
  ]);
  canonicalDate(input.asOfDate);
  assertExactObject(input.league, ["id", "name"]);
  assertExactObject(input.season, ["id", "label"]);
  assertExactObject(input.team, [
    "id",
    "name",
    "patternTemplate",
    "primaryColour",
    "secondaryColour",
    "tertiaryColour",
    "logoReference",
  ]);
  if (!isTeamPatternTemplate(input.team.patternTemplate)) {
    fail(PUBLIC_ROSTER_CODES.inputInvalid);
  }
  if (!Array.isArray(input.players)) fail(PUBLIC_ROSTER_CODES.playerInvalid);
  const players = Object.freeze(
    input.players.map((value) => player(value, input.asOfDate))
  );
  const references = players.map((value) => value.playerReference);
  if (new Set(references).size !== references.length) {
    fail(PUBLIC_ROSTER_CODES.duplicatePlayer);
  }
  assertExactObject(input.cap, [
    "capLimitCents",
    "capUsageCents",
    "capSpaceCents",
    "retainedSalaryTotalCents",
    "buyoutPenaltyTotalCents",
  ]);
  const capLimitCents = nonnegative(input.cap.capLimitCents);
  const capUsageCents = nonnegative(input.cap.capUsageCents);
  const capSpaceCents = signedInteger(input.cap.capSpaceCents);
  if (capSpaceCents !== capLimitCents - capUsageCents) {
    fail(PUBLIC_ROSTER_CODES.capInvalid);
  }
  const logoReference = input.team.logoReference;
  if (
    logoReference !== null &&
    (typeof logoReference !== "string" ||
      !logoReference.startsWith("/api/v1/public/leagues/"))
  ) {
    fail(PUBLIC_ROSTER_CODES.inputInvalid);
  }
  return Object.freeze({
    league: Object.freeze({
      id: stableId(input.league.id),
      name: text(input.league.name),
    }),
    season: Object.freeze({
      id: stableId(input.season.id),
      label: text(input.season.label),
    }),
    team: Object.freeze({
      id: stableId(input.team.id),
      name: text(input.team.name),
      patternTemplate: input.team.patternTemplate,
      primaryColour: input.team.primaryColour,
      secondaryColour: input.team.secondaryColour,
      tertiaryColour: input.team.tertiaryColour,
      logoReference,
    }),
    players,
    cap: Object.freeze({
      capLimitCents,
      capUsageCents,
      capSpaceCents,
      retainedSalaryTotalCents: nonnegative(
        input.cap.retainedSalaryTotalCents
      ),
      buyoutPenaltyTotalCents: nonnegative(
        input.cap.buyoutPenaltyTotalCents
      ),
    }),
    updatedAt: nonnegative(input.updatedAt),
  });
}

function validatePublicRosterLookup(input) {
  assertExactObject(input, ["leagueId", "teamId", "asOfDate"]);
  canonicalDate(input.asOfDate);
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    teamId: stableId(input.teamId),
    asOfDate: input.asOfDate,
  });
}

module.exports = {
  PUBLIC_ROSTER_CODES,
  PublicRosterPolicyError,
  calculateAge,
  createPublicRosterProjection,
  validatePublicRosterLookup,
};
