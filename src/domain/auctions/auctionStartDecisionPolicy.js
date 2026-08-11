const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
  validateOpeningBid,
} = require("./auctionCreationPolicy");
const {
  FREE_AGENT_DRAFT_POLICY_CODES,
  FreeAgentDraftPolicyError,
  classifyFreeAgentDraftNominationTiming,
} = require("../freeAgentDraft/freeAgentDraftPolicy");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const ORDINARY_START_BODY_FIELDS = Object.freeze([
  "playerId",
  "teamId",
  "totalValueCents",
  "termYears",
]);
const FAD_START_BODY_FIELDS = Object.freeze([
  ...ORDINARY_START_BODY_FIELDS,
  "bindingIllegalityConfirmed",
]);
const START_SOURCE_KINDS = Object.freeze([
  "ordinary_weekly",
  "fad_open_rapid",
]);
const MANAGER_ASSIGNMENT_STATUSES = new Set([
  null,
  "pending",
  "accepted",
  "declined",
  "ended",
]);
const FAD_BINDING_CONFIRMATION_REQUIRED =
  "FAD_BINDING_ILLEGALITY_CONFIRMATION_REQUIRED";

function fail(reasonCode) {
  throw new AuctionCreationPolicyError(reasonCode);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, expectedKeys, reasonCode) {
  if (!isPlainObject(value)) fail(reasonCode);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(reasonCode);
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(AUCTION_CREATION_CODES.stableIdInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    fail(AUCTION_CREATION_CODES.timestampInvalid);
  }
  return value;
}

function nullableTimestamp(value) {
  return value === null ? null : safeTimestamp(value);
}

function validateSourceKindOptions(options) {
  exactObject(
    options,
    ["sourceKind"],
    AUCTION_CREATION_CODES.inputInvalid
  );
  if (!START_SOURCE_KINDS.includes(options.sourceKind)) {
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
  return options.sourceKind;
}

function validateAuctionStartBody(input, options) {
  const sourceKind = validateSourceKindOptions(options);
  if (sourceKind === "ordinary_weekly") {
    exactObject(
      input,
      ORDINARY_START_BODY_FIELDS,
      AUCTION_CREATION_CODES.inputInvalid
    );
  } else {
    if (
      hasExactKeys(input, ORDINARY_START_BODY_FIELDS) ||
      (
        hasExactKeys(input, FAD_START_BODY_FIELDS) &&
        input.bindingIllegalityConfirmed !== true
      )
    ) {
      fail(FAD_BINDING_CONFIRMATION_REQUIRED);
    }
    exactObject(
      input,
      FAD_START_BODY_FIELDS,
      AUCTION_CREATION_CODES.inputInvalid
    );
  }

  const offer = validateOpeningBid(
    input.totalValueCents,
    input.termYears
  );
  const body = {
    playerId: stableId(input.playerId),
    teamId: stableId(input.teamId),
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
  };
  if (sourceKind === "fad_open_rapid") {
    body.bindingIllegalityConfirmed = true;
  }
  return Object.freeze(body);
}

function canonicalRapidContext(value, nowMs) {
  exactObject(
    value,
    [
      "allocationCompletedAtMs",
      "fadId",
      "fadStatus",
      "leagueId",
      "seasonId",
      "seasonStatus",
      "rollover",
    ],
    AUCTION_CREATION_CODES.inputInvalid
  );
  const context = {
    leagueId: stableId(value.leagueId),
    seasonId: stableId(value.seasonId),
    fadId: stableId(value.fadId),
    fadStatus: value.fadStatus,
    seasonStatus: value.seasonStatus,
    allocationCompletedAtMs: safeTimestamp(
      value.allocationCompletedAtMs
    ),
  };
  if (
    context.fadStatus !== "rapid" ||
    context.seasonStatus !== "active" ||
    context.allocationCompletedAtMs > nowMs
  ) {
    fail(AUCTION_CREATION_CODES.seasonUnavailable);
  }

  exactObject(
    value.rollover,
    [
      "creationCutoffAtMs",
      "fadId",
      "id",
      "leagueId",
      "opensAtMs",
      "rollsOverAtMs",
      "seasonId",
      "status",
    ],
    AUCTION_CREATION_CODES.inputInvalid
  );
  const rollover = {
    id: stableId(value.rollover.id),
    leagueId: stableId(value.rollover.leagueId),
    seasonId: stableId(value.rollover.seasonId),
    fadId: stableId(value.rollover.fadId),
    status: value.rollover.status,
    opensAtMs: safeTimestamp(value.rollover.opensAtMs),
    creationCutoffAtMs: safeTimestamp(
      value.rollover.creationCutoffAtMs
    ),
    rollsOverAtMs: safeTimestamp(
      value.rollover.rollsOverAtMs
    ),
  };
  if (
    rollover.leagueId !== context.leagueId ||
    rollover.seasonId !== context.seasonId ||
    rollover.fadId !== context.fadId
  ) {
    fail(AUCTION_CREATION_CODES.seasonUnavailable);
  }
  if (rollover.status !== "scheduled") {
    fail(AUCTION_CREATION_CODES.windowClosed);
  }

  let timing;
  try {
    timing = classifyFreeAgentDraftNominationTiming({
      acceptedAtMs: nowMs,
      opensAtMs: rollover.opensAtMs,
      creationCutoffAtMs:
        rollover.creationCutoffAtMs,
      rollsOverAtMs: rollover.rollsOverAtMs,
    });
  } catch (error) {
    if (!(error instanceof FreeAgentDraftPolicyError)) {
      throw error;
    }
    if (
      error.code ===
      FREE_AGENT_DRAFT_POLICY_CODES
        .nominationWindowUnavailable
    ) {
      fail(AUCTION_CREATION_CODES.windowClosed);
    }
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
  return Object.freeze({
    ...context,
    rollover: Object.freeze(rollover),
    timing,
  });
}

function canonicalAuthority(value, body, nowMs) {
  exactObject(
    value,
    [
      "currentCommissioner",
      "fadTeamParticipating",
      "leagueStatus",
      "managerAssignmentAcceptedAtMs",
      "managerAssignmentEndedAtMs",
      "managerAssignmentStatus",
      "membershipStatus",
      "teamId",
      "teamStatus",
    ],
    AUCTION_CREATION_CODES.inputInvalid
  );
  if (
    typeof value.currentCommissioner !== "boolean" ||
    typeof value.fadTeamParticipating !== "boolean" ||
    !MANAGER_ASSIGNMENT_STATUSES.has(
      value.managerAssignmentStatus
    )
  ) {
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
  const authority = {
    currentCommissioner: value.currentCommissioner,
    fadTeamParticipating: value.fadTeamParticipating,
    leagueStatus: value.leagueStatus,
    managerAssignmentAcceptedAtMs: nullableTimestamp(
      value.managerAssignmentAcceptedAtMs
    ),
    managerAssignmentEndedAtMs: nullableTimestamp(
      value.managerAssignmentEndedAtMs
    ),
    managerAssignmentStatus:
      value.managerAssignmentStatus,
    membershipStatus: value.membershipStatus,
    teamId: stableId(value.teamId),
    teamStatus: value.teamStatus,
  };
  const common =
    authority.membershipStatus === "active" &&
    authority.teamStatus === "active" &&
    authority.teamId === body.teamId &&
    authority.fadTeamParticipating;
  const manager =
    common &&
    authority.leagueStatus === "active" &&
    authority.managerAssignmentStatus === "accepted" &&
    authority.managerAssignmentAcceptedAtMs !== null &&
    authority.managerAssignmentAcceptedAtMs <= nowMs &&
    authority.managerAssignmentEndedAtMs === null;
  const commissioner =
    common &&
    ["active", "frozen"].includes(
      authority.leagueStatus
    ) &&
    authority.currentCommissioner;
  return Object.freeze({ manager, commissioner });
}

function canonicalPlayer(value, body) {
  exactObject(
    value,
    [
      "activeAuctionExists",
      "fadEligible",
      "id",
      "owned",
      "positionGroup",
      "quarantined",
      "status",
    ],
    AUCTION_CREATION_CODES.inputInvalid
  );
  if (
    typeof value.activeAuctionExists !== "boolean" ||
    typeof value.fadEligible !== "boolean" ||
    typeof value.owned !== "boolean" ||
    typeof value.quarantined !== "boolean"
  ) {
    fail(AUCTION_CREATION_CODES.inputInvalid);
  }
  const playerId = stableId(value.id);
  if (
    playerId !== body.playerId ||
    value.status !== "active" ||
    !["F", "D"].includes(value.positionGroup) ||
    !value.fadEligible
  ) {
    fail(AUCTION_CREATION_CODES.playerIneligible);
  }
  if (value.quarantined) {
    fail(AUCTION_CREATION_CODES.fadAllocationQuarantined);
  }
  if (value.owned) {
    fail(AUCTION_CREATION_CODES.playerOwned);
  }
  if (value.activeAuctionExists) {
    fail(AUCTION_CREATION_CODES.activeAuctionExists);
  }
}

function decideFreeAgentDraftAuctionStart(input) {
  exactObject(
    input,
    ["authority", "body", "nowMs", "player", "rapidContext"],
    AUCTION_CREATION_CODES.inputInvalid
  );
  const nowMs = safeTimestamp(input.nowMs);
  const body = validateAuctionStartBody(input.body, {
    sourceKind: "fad_open_rapid",
  });
  const context = canonicalRapidContext(
    input.rapidContext,
    nowMs
  );
  const authority = canonicalAuthority(
    input.authority,
    body,
    nowMs
  );
  const queued =
    context.timing.disposition === "queue_private";
  const actorAuthority = authority.manager
    ? "manager"
    : !queued && authority.commissioner
      ? "commissioner"
      : null;
  if (actorAuthority === null) {
    fail(AUCTION_CREATION_CODES.authorizationDenied);
  }
  canonicalPlayer(input.player, body);

  return Object.freeze({
    kind: queued
      ? "nomination_queued"
      : "auction_opened",
    sourceKind: "fad_open_rapid",
    actorAuthority,
    leagueId: context.leagueId,
    seasonId: context.seasonId,
    fadId: context.fadId,
    sourceRolloverId: context.rollover.id,
    targetOpeningRolloverId: queued
      ? context.rollover.id
      : null,
    resolutionRolloverId: queued
      ? null
      : context.rollover.id,
    acceptedAtMs: context.timing.acceptedAtMs,
    opensAtMs: context.timing.auctionOpensAtMs,
    resolvesAtMs:
      context.timing.resolutionRolloverAtMs,
    bindingIllegalityConfirmedAtMs:
      context.timing.acceptedAtMs,
    body,
  });
}

module.exports = {
  FAD_BINDING_CONFIRMATION_REQUIRED,
  FAD_START_BODY_FIELDS,
  ORDINARY_START_BODY_FIELDS,
  START_SOURCE_KINDS,
  decideFreeAgentDraftAuctionStart,
  validateAuctionStartBody,
};
