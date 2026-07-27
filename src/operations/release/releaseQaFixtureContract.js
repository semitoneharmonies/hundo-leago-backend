const crypto = require("node:crypto");

const FIXTURE_VERSION = 9;
const FIXTURE_BUILD_ID = "m7-release-qa-fixture-v9";
const FIXTURE_ID_NAMESPACE = "m7-release-qa-fixture-v1";
const FIXTURE_CREATED_AT = "2026-07-25T12:00:00.000Z";
const FIXTURE_NOW_MS = Date.parse(FIXTURE_CREATED_AT);
const FIXTURE_ENVIRONMENT_ID = "test:release-qa";
const FIXTURE_DATABASE_ID = "m7-release-qa-fixture";
const INVALID_CAP_BUYOUT_PENALTY_CENTS = 9_250;

const ACCOUNT_ALIASES = Object.freeze([
  "platformAdmin",
  "leagueACommissioner",
  "leagueBCommissioner",
  "leagueAManagerOne",
  "leagueAManagerTwo",
  "leagueBManagerOne",
  "verifiedWithoutMembership",
  "pendingVerification",
  "deactivated",
]);

const ACCOUNT_EMAILS = Object.freeze({
  platformAdmin: "admin@release-qa.example.test",
  leagueACommissioner: "comm.a@release-qa.example.test",
  leagueBCommissioner: "comm.b@release-qa.example.test",
  leagueAManagerOne: "man.a.leag.a@release-qa.example.test",
  leagueAManagerTwo: "man.b.leag.a@release-qa.example.test",
  leagueBManagerOne: "man.a.leag.b@release-qa.example.test",
  verifiedWithoutMembership: "no.league@release-qa.example.test",
  pendingVerification: "pending@release-qa.example.test",
  deactivated: "deactivated@release-qa.example.test",
});

const LEAGUE_ALIASES = Object.freeze(["leagueA", "leagueB"]);
const TEAM_NAMES_BY_LEAGUE = Object.freeze({
  leagueA: Object.freeze([
    "Alpha Owls",
    "Alpha Ravens",
    "Alpha Wolves",
    "Alpha Orcas",
    "Alpha Bears",
    "Alpha Foxes",
  ]),
  leagueB: Object.freeze([
    "Beta Comets",
    "Beta Vipers",
    "Beta Falcons",
    "Beta Kraken",
    "Beta Lynx",
    "Beta Mustangs",
  ]),
});
const BETA_PLAYER_TEAM_NUMBERS = Object.freeze({
  unsignedProspect: 5,
  team5Prospect2: 4,
  signedProspect: 6,
  team6Prospect1: 5,
});

const CORE_PLAYER_BLUEPRINTS = [
  ...Array.from({ length: 12 }, (_, index) => Object.freeze({
    alias: `activeForward${index + 1}`,
    position: "F",
    rosterCategory: "Active",
    slotNumber: Math.floor(index / 6) + 1,
    teamNumber: (index % 6) + 1,
    ownershipKind: "Rostered",
    contract: true,
  })),
  ...Array.from({ length: 6 }, (_, index) => Object.freeze({
    alias: `activeDefence${index + 1}`,
    position: "D",
    rosterCategory: "Active",
    slotNumber: 1,
    teamNumber: index + 1,
    ownershipKind: "Rostered",
    contract: true,
  })),
  Object.freeze({
    alias: "benchForward",
    position: "F",
    rosterCategory: "Bench",
    slotNumber: 1,
    teamNumber: 1,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 350,
  }),
  Object.freeze({
    alias: "benchDefence",
    position: "D",
    rosterCategory: "Bench",
    slotNumber: 1,
    teamNumber: 2,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 375,
  }),
  Object.freeze({
    alias: "injuredReserveForward",
    position: "F",
    rosterCategory: "Injured Reserve",
    slotNumber: 1,
    teamNumber: 3,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 450,
    injuredReserveEligible: true,
  }),
  Object.freeze({
    alias: "unsignedProspect",
    position: "F",
    rosterCategory: "Prospect",
    slotNumber: null,
    teamNumber: 4,
    ownershipKind: "Prospect Right",
    contract: false,
    requiresUnder19: true,
  }),
  Object.freeze({
    alias: "signedProspect",
    position: "D",
    rosterCategory: "Prospect",
    slotNumber: null,
    teamNumber: 5,
    ownershipKind: "Prospect Right",
    contract: true,
    contractType: "fantasy_elc",
    aavCents: 100,
    requiresUnder19: true,
  }),
  Object.freeze({ alias: "freeAgentForward", position: "F" }),
  Object.freeze({ alias: "freeAgentDefence", position: "D" }),
  Object.freeze({ alias: "boughtOutForward", position: "F" }),
];

const ACTIVE_FILLERS = Array.from({ length: 6 }, (_, teamIndex) => [
  ...Array.from({ length: 10 }, (_, index) => Object.freeze({
    alias: `team${teamIndex + 1}ActiveForward${index + 3}`,
    position: "F",
    rosterCategory: "Active",
    slotNumber: index + 3,
    teamNumber: teamIndex + 1,
    ownershipKind: "Rostered",
    contract: true,
  })),
  ...Array.from({ length: 5 }, (_, index) => Object.freeze({
    alias: `team${teamIndex + 1}ActiveDefence${index + 2}`,
    position: "D",
    rosterCategory: "Active",
    slotNumber: index + 2,
    teamNumber: teamIndex + 1,
    ownershipKind: "Rostered",
    contract: true,
  })),
]).flat();

const BENCH_TARGETS = Object.freeze([1, 2, 3, 4, 1, 2]);
const BENCH_FILLERS = Array.from({ length: 6 }, (_, teamIndex) => {
  const existing = teamIndex < 2 ? 1 : 0;
  return Array.from(
    { length: BENCH_TARGETS[teamIndex] - existing },
    (_, index) => Object.freeze({
      alias: `team${teamIndex + 1}Bench${index + existing + 1}`,
      position: (teamIndex + index) % 2 === 0 ? "F" : "D",
      rosterCategory: "Bench",
      slotNumber: index + existing + 1,
      teamNumber: teamIndex + 1,
      ownershipKind: "Rostered",
      contract: true,
      aavCents: 350 + ((teamIndex + index) % 2) * 25,
    })
  );
}).flat();

const INJURED_RESERVE_FILLERS = [
  Object.freeze({
    alias: "team1InjuredReserve1",
    position: "F",
    rosterCategory: "Injured Reserve",
    slotNumber: 1,
    teamNumber: 1,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 400,
    injuredReserveEligible: true,
  }),
  Object.freeze({
    alias: "team3InjuredReserve2",
    position: "D",
    rosterCategory: "Injured Reserve",
    slotNumber: 2,
    teamNumber: 3,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 400,
    injuredReserveEligible: true,
  }),
  Object.freeze({
    alias: "team5InjuredReserve1",
    position: "F",
    rosterCategory: "Injured Reserve",
    slotNumber: 1,
    teamNumber: 5,
    ownershipKind: "Rostered",
    contract: true,
    aavCents: 400,
    injuredReserveEligible: true,
  }),
];

const PROSPECT_FILLERS = Array.from({ length: 6 }, (_, teamIndex) => {
  const existing = teamIndex === 3 || teamIndex === 4 ? 1 : 0;
  return Array.from({ length: 3 - existing }, (_, index) => {
    const signed = (teamIndex + index + existing) % 2 === 0;
    return Object.freeze({
      alias: `team${teamIndex + 1}Prospect${index + existing + 1}`,
      position: (teamIndex + index) % 2 === 0 ? "F" : "D",
      rosterCategory: "Prospect",
      slotNumber: null,
      teamNumber: teamIndex + 1,
      ownershipKind: "Prospect Right",
      contract: signed,
      contractType: signed ? "fantasy_elc" : undefined,
      aavCents: signed ? 100 : undefined,
      requiresUnder19: true,
    });
  });
}).flat();

const PLAYER_BLUEPRINTS = Object.freeze([
  ...CORE_PLAYER_BLUEPRINTS,
  ...ACTIVE_FILLERS,
  ...BENCH_FILLERS,
  ...INJURED_RESERVE_FILLERS,
  ...PROSPECT_FILLERS,
]);

function fixtureId(label) {
  const bytes = crypto.createHash("sha256")
    .update(`hundo-leago:${FIXTURE_ID_NAMESPACE}:${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fixtureEmail(accountAlias) {
  if (!ACCOUNT_ALIASES.includes(accountAlias)) {
    throw new TypeError("The release-QA account alias is invalid.");
  }
  return ACCOUNT_EMAILS[accountAlias];
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checksumManifest(manifest) {
  const payload = { ...manifest };
  delete payload.manifestChecksum;
  return crypto.createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex");
}

module.exports = {
  ACCOUNT_ALIASES,
  BETA_PLAYER_TEAM_NUMBERS,
  FIXTURE_BUILD_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_ID_NAMESPACE,
  FIXTURE_NOW_MS,
  FIXTURE_VERSION,
  INVALID_CAP_BUYOUT_PENALTY_CENTS,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  TEAM_NAMES_BY_LEAGUE,
  canonicalize,
  checksumManifest,
  fixtureEmail,
  fixtureId,
};
