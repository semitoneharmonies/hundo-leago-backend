"use strict";

const {
  buildAuctionResolutionOccurrenceKey,
  calculateAavCents,
} = require("../../../domain/auctions/auctionResolutionPolicy");
const {
  FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);

const FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_AUCTION_RESOLUTION_INPUT_INVALID",
    stateInvalid:
      "FAD_AUCTION_RESOLUTION_STATE_INVALID",
  });
const INPUT_FIELDS = Object.freeze([
  "allocationId",
  "auctionId",
  "expectedAllocationVersion",
  "expectedAuctionVersion",
  "fadId",
  "jobExecution",
  "leagueId",
  "occurrenceKey",
  "playerId",
  "resolvesAtMs",
  "rolloverId",
  "seasonId",
]);
const JOB_EXECUTION_FIELDS = Object.freeze([
  "attemptCount",
  "expectedVersion",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "runId",
  "startedAtMs",
]);
const COMMITTED_RESOLUTION_INPUT_FIELDS = Object.freeze([
  "allocationId",
  "auctionId",
  "fadId",
  "leagueId",
  "occurrenceKey",
  "resolution",
  "resolvesAtMs",
  "rolloverId",
  "seasonId",
]);
const TERMINAL_FIELDS = Object.freeze([
  "allocationId",
  "allocationVersion",
  "auctionId",
  "auctionVersion",
  "committedRoster",
  "completed",
  "drawReveal",
  "evidence",
  "fadId",
  "fallbackAuctionId",
  "jobRunId",
  "jobRunVersion",
  "leagueId",
  "occurrenceKey",
  "outcome",
  "replayed",
  "resolutionId",
  "resolvedAtMs",
  "rolloverId",
  "seasonId",
]);
const WINNER_TERMINAL_FIELDS = Object.freeze([
  ...TERMINAL_FIELDS,
  "winner",
]);
const LEGACY_WINNER_FIELDS = Object.freeze([
  "bidId",
  "contractId",
  "finalAavCents",
  "finalTotalValueCents",
  "highestCompetingAavCents",
  "lowestOfferedAavCents",
  "ownershipId",
  "persistedSecondPriceInputCents",
  "submittedTermYears",
  "submittedTotalValueCents",
  "teamId",
]);
const TOTAL_FIRST_WINNER_FIELDS = Object.freeze([
  ...LEGACY_WINNER_FIELDS,
  "highestCompetingTotalValueCents",
  "lowestOfferedTotalValueCents",
  "requiredWinningAavCents",
  "requiredWinningTotalValueCents",
  "submittedAavCents",
]);
const DRAW_FIELDS = Object.freeze([
  "algorithmVersion",
  "counter",
  "digestHex",
  "nonceHex",
  "orderedBidIds",
  "orderedTeamIds",
  "selectedBidId",
  "selectedIndex",
  "selectedTeamId",
  "selectionUsed",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "activityId",
  "clonedOfferEventIds",
  "notificationIds",
  "outboxEventIds",
  "stateEventId",
]);
const COMMITTED_ROSTER_FIELDS = Object.freeze([
  "leagueId",
  "ownershipWitnesses",
  "seasonId",
  "teamId",
]);
const OWNERSHIP_WITNESS_FIELDS = Object.freeze([
  "ownershipId",
  "ownershipVersion",
  "state",
]);
const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAXIMUM_DRAW_COUNTER = 0xffff_ffff;
const AWAITING_DATA_LATE_LOCK = Object.freeze({
  status: "awaiting_data",
});

class FreeAgentDraftAuctionResolutionServiceError
  extends Error {
  constructor(code, reasonCode) {
    super(
      "The Free Agent Draft auction resolution could not be completed."
    );
    this.name =
      "FreeAgentDraftAuctionResolutionServiceError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftAuctionResolutionServiceError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES
      .inputInvalid,
    reasonCode
  );
}

function failState(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES
      .stateInvalid,
    reasonCode
  );
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

function hasExactOwnProperties(value, fields) {
  if (!isPlainObject(value)) return false;
  const actual = Reflect.ownKeys(value)
    .filter((field) => typeof field === "string")
    .sort();
  const expected = [...fields].sort();
  return (
    Reflect.ownKeys(value).length === actual.length &&
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function canonicalId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function boundedText(
  value,
  maximumLength,
  reasonCode
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failInput(reasonCode);
  }
  return value;
}

function validAllocationBinding(allocationId, allocationVersion) {
  return allocationId === null
    ? allocationVersion === 0
    : UUID_PATTERN.test(allocationId || "") &&
        Number.isSafeInteger(allocationVersion) &&
        allocationVersion >= 1;
}

function normalizeAllocationBinding(
  allocationId,
  allocationVersion
) {
  if (!validAllocationBinding(allocationId, allocationVersion)) {
    failInput("allocation_binding_invalid");
  }
  return Object.freeze({ allocationId, allocationVersion });
}

function normalizeExecution(input) {
  if (!hasExactOwnProperties(input, INPUT_FIELDS)) {
    failInput("execution_fields_invalid");
  }
  if (
    !hasExactOwnProperties(
      input.jobExecution,
      JOB_EXECUTION_FIELDS
    )
  ) {
    failInput("job_execution_fields_invalid");
  }
  const auctionId = canonicalId(
    input.auctionId,
    "auction_id_invalid"
  );
  const resolvesAtMs = safeTimestamp(
    input.resolvesAtMs,
    "resolution_due_timestamp_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    500,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildAuctionResolutionOccurrenceKey({
        auctionId,
        dueAtMs: resolvesAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (occurrenceKey !== canonicalOccurrenceKey) {
    failInput("occurrence_scope_invalid");
  }
  const startedAtMs = safeTimestamp(
    input.jobExecution.startedAtMs,
    "started_timestamp_invalid"
  );
  const leaseExpiresAtMs = safeTimestamp(
    input.jobExecution.leaseExpiresAtMs,
    "lease_expiry_invalid"
  );
  if (
    startedAtMs < resolvesAtMs ||
    leaseExpiresAtMs <= startedAtMs
  ) {
    failInput("job_execution_chronology_invalid");
  }
  const allocation = normalizeAllocationBinding(
    input.allocationId,
    input.expectedAllocationVersion
  );
  return Object.freeze({
    leagueId: canonicalId(
      input.leagueId,
      "league_id_invalid"
    ),
    seasonId: canonicalId(
      input.seasonId,
      "season_id_invalid"
    ),
    fadId: canonicalId(input.fadId, "fad_id_invalid"),
    allocationId: allocation.allocationId,
    playerId: canonicalId(
      input.playerId,
      "player_id_invalid"
    ),
    rolloverId: canonicalId(
      input.rolloverId,
      "rollover_id_invalid"
    ),
    auctionId,
    resolvesAtMs,
    occurrenceKey,
    expectedAuctionVersion: positiveInteger(
      input.expectedAuctionVersion,
      "auction_version_invalid"
    ),
    expectedAllocationVersion: allocation.allocationVersion,
    jobExecution: Object.freeze({
      runId: canonicalId(
        input.jobExecution.runId,
        "job_run_id_invalid"
      ),
      expectedVersion: positiveInteger(
        input.jobExecution.expectedVersion,
        "job_version_invalid"
      ),
      leaseOwner: boundedText(
        input.jobExecution.leaseOwner,
        128,
        "lease_owner_invalid"
      ),
      leaseToken: canonicalId(
        input.jobExecution.leaseToken,
        "lease_token_invalid"
      ),
      leaseExpiresAtMs,
      startedAtMs,
      attemptCount: positiveInteger(
        input.jobExecution.attemptCount,
        "attempt_count_invalid"
      ),
    }),
  });
}

function normalizeCommittedResolution(input) {
  if (
    !hasExactOwnProperties(
      input,
      COMMITTED_RESOLUTION_INPUT_FIELDS
    )
  ) {
    failInput("committed_resolution_fields_invalid");
  }
  const auctionId = canonicalId(
    input.auctionId,
    "auction_id_invalid"
  );
  const resolvesAtMs = safeTimestamp(
    input.resolvesAtMs,
    "resolution_due_timestamp_invalid"
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    500,
    "occurrence_key_invalid"
  );
  let canonicalOccurrenceKey = null;
  try {
    canonicalOccurrenceKey =
      buildAuctionResolutionOccurrenceKey({
        auctionId,
        dueAtMs: resolvesAtMs,
      });
  } catch {
    failInput("occurrence_key_invalid");
  }
  const result = input.resolution;
  const inputAllocationId = input.allocationId === null
    ? null
    : canonicalId(
        input.allocationId,
        "allocation_id_invalid"
      );
  if (
    occurrenceKey !== canonicalOccurrenceKey ||
    !isPlainObject(result) ||
    result.replayed !== true ||
    !Number.isSafeInteger(result.resolvedAtMs) ||
    result.resolvedAtMs < 0 ||
    result.resolvedAtMs >= Number.MAX_SAFE_INTEGER ||
    !validAllocationBinding(
      result.allocationId,
      result.allocationVersion
    ) ||
    result.allocationId !== inputAllocationId ||
    (result.allocationId !== null &&
      result.allocationVersion < 2) ||
    !Number.isSafeInteger(result.auctionVersion) ||
    result.auctionVersion < 2 ||
    !Number.isSafeInteger(result.jobRunVersion) ||
    result.jobRunVersion < 2 ||
    !UUID_PATTERN.test(result.jobRunId || "")
  ) {
    failInput("committed_resolution_identity_invalid");
  }
  return Object.freeze({
    result,
    execution: Object.freeze({
      leagueId: canonicalId(
        input.leagueId,
        "league_id_invalid"
      ),
      seasonId: canonicalId(
        input.seasonId,
        "season_id_invalid"
      ),
      fadId: canonicalId(
        input.fadId,
        "fad_id_invalid"
      ),
      allocationId: inputAllocationId,
      rolloverId: canonicalId(
        input.rolloverId,
        "rollover_id_invalid"
      ),
      auctionId,
      resolvesAtMs,
      occurrenceKey,
      expectedAllocationVersion:
        result.allocationId === null
          ? 0
          : result.allocationVersion - 1,
      expectedAuctionVersion:
        result.auctionVersion - 1,
      jobExecution: Object.freeze({
        runId: result.jobRunId,
        expectedVersion:
          result.jobRunVersion - 1,
        leaseOwner: "committed-resolution-replay",
        leaseToken: result.jobRunId,
        startedAtMs: result.resolvedAtMs,
        leaseExpiresAtMs: result.resolvedAtMs + 1,
        attemptCount: 1,
      }),
    }),
  });
}

function canonicalIdArray(
  value,
  { exactLength = null, minimumLength = 0 } = {}
) {
  return (
    Array.isArray(value) &&
    (exactLength === null ||
      value.length === exactLength) &&
    value.length >= minimumLength &&
    value.every(
      (item) =>
        typeof item === "string" &&
        UUID_PATTERN.test(item)
    ) &&
    new Set(value).size === value.length
  );
}

function safePositiveMoney(value) {
  return (
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function safeDrawReveal(value, winner) {
  if (
    !hasExactOwnProperties(value, DRAW_FIELDS) ||
    value.algorithmVersion !==
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION ||
    !HEX_64_PATTERN.test(value.nonceHex || "") ||
    typeof value.selectionUsed !== "boolean" ||
    !canonicalIdArray(value.orderedBidIds) ||
    !canonicalIdArray(value.orderedTeamIds) ||
    value.orderedBidIds.length !==
      value.orderedTeamIds.length
  ) {
    failState("draw_reveal_invalid");
  }
  if (!value.selectionUsed) {
    if (
      value.orderedBidIds.length !== 0 ||
      value.counter !== null ||
      value.digestHex !== null ||
      value.selectedIndex !== null ||
      value.selectedBidId !== null ||
      value.selectedTeamId !== null
    ) {
      failState("draw_reveal_invalid");
    }
  } else if (
    !winner ||
    value.orderedBidIds.length < 2 ||
    !Number.isSafeInteger(value.counter) ||
    value.counter < 0 ||
    value.counter > MAXIMUM_DRAW_COUNTER ||
    !HEX_64_PATTERN.test(value.digestHex || "") ||
    !Number.isSafeInteger(value.selectedIndex) ||
    value.selectedIndex < 0 ||
    value.selectedIndex >= value.orderedBidIds.length ||
    value.selectedBidId !==
      value.orderedBidIds[value.selectedIndex] ||
    value.selectedTeamId !==
      value.orderedTeamIds[value.selectedIndex] ||
    value.selectedBidId !== winner.bidId ||
    value.selectedTeamId !== winner.teamId
  ) {
    failState("draw_reveal_invalid");
  }
  return Object.freeze({
    algorithmVersion: value.algorithmVersion,
    nonceHex: value.nonceHex,
    selectionUsed: value.selectionUsed,
    orderedBidIds: Object.freeze([
      ...value.orderedBidIds,
    ]),
    orderedTeamIds: Object.freeze([
      ...value.orderedTeamIds,
    ]),
    counter: value.counter,
    digestHex: value.digestHex,
    selectedIndex: value.selectedIndex,
    selectedBidId: value.selectedBidId,
    selectedTeamId: value.selectedTeamId,
  });
}

function safeWinner(value) {
  const legacyWinner = hasExactOwnProperties(
    value,
    LEGACY_WINNER_FIELDS
  );
  const totalFirstWinner = hasExactOwnProperties(
    value,
    TOTAL_FIRST_WINNER_FIELDS
  );
  if (
    (!legacyWinner && !totalFirstWinner) ||
    !UUID_PATTERN.test(value.bidId || "") ||
    !UUID_PATTERN.test(value.teamId || "") ||
    !UUID_PATTERN.test(value.contractId || "") ||
    !UUID_PATTERN.test(value.ownershipId || "") ||
    !safePositiveMoney(value.submittedTotalValueCents) ||
    !Number.isSafeInteger(value.submittedTermYears) ||
    value.submittedTermYears < 1 ||
    value.submittedTermYears > 3 ||
    !safePositiveMoney(value.lowestOfferedAavCents) ||
    !safePositiveMoney(value.finalTotalValueCents) ||
    !safePositiveMoney(value.finalAavCents) ||
    !Number.isSafeInteger(
      value.persistedSecondPriceInputCents
    ) ||
    value.persistedSecondPriceInputCents < 0 ||
    (
      value.highestCompetingAavCents !== null &&
      !safePositiveMoney(
        value.highestCompetingAavCents
      )
    )
  ) {
    failState("winner_invalid");
  }
  let submittedAavCents;
  let finalAavCents;
  try {
    submittedAavCents = calculateAavCents(
      value.submittedTotalValueCents,
      value.submittedTermYears
    );
    finalAavCents = calculateAavCents(
      value.finalTotalValueCents,
      value.submittedTermYears
    );
  } catch {
    failState("winner_invalid");
  }
  if (
    value.finalAavCents !== finalAavCents ||
    value.finalTotalValueCents >
      value.submittedTotalValueCents ||
    value.lowestOfferedAavCents > submittedAavCents ||
    value.finalAavCents > submittedAavCents ||
    (legacyWinner && (
      value.finalAavCents <
        value.lowestOfferedAavCents ||
      (
        value.highestCompetingAavCents === null
          ? value.persistedSecondPriceInputCents !== 0
          : value.persistedSecondPriceInputCents !==
              value.highestCompetingAavCents ||
            value.highestCompetingAavCents >
              submittedAavCents ||
            value.finalAavCents <
              value.highestCompetingAavCents
      )
    ))
  ) {
    failState("winner_pricing_invalid");
  }
  if (totalFirstWinner) {
    const highestCompetingTotalValueCents =
      value.highestCompetingTotalValueCents;
    const legacySubmittedPrice =
      value.requiredWinningTotalValueCents ===
        value.submittedTotalValueCents &&
      (
        value.submittedTotalValueCents %
          value.submittedTermYears !== 0 ||
        (
          value.submittedTotalValueCents /
            value.submittedTermYears
        ) % 25 !== 0
      );
    const expectedRequiredAavCents = legacySubmittedPrice
      ? submittedAavCents
      : Math.max(
          100,
          Math.ceil(
            value.requiredWinningTotalValueCents /
              value.submittedTermYears /
              25
          ) * 25
        );
    const expectedFinalTotalValueCents = legacySubmittedPrice
      ? value.submittedTotalValueCents
      : expectedRequiredAavCents * value.submittedTermYears;
    if (
      value.submittedAavCents !== submittedAavCents ||
      !safePositiveMoney(value.lowestOfferedTotalValueCents) ||
      value.lowestOfferedTotalValueCents >
        value.submittedTotalValueCents ||
      (
        highestCompetingTotalValueCents !== null &&
        !safePositiveMoney(highestCompetingTotalValueCents)
      ) ||
      (
        highestCompetingTotalValueCents === null
      ) !== (value.highestCompetingAavCents === null) ||
      value.persistedSecondPriceInputCents !==
        (highestCompetingTotalValueCents ?? 0) ||
      !safePositiveMoney(value.requiredWinningTotalValueCents) ||
      value.requiredWinningTotalValueCents !==
        (highestCompetingTotalValueCents === null
          ? value.submittedTotalValueCents
          : Math.max(
              value.lowestOfferedTotalValueCents,
              highestCompetingTotalValueCents
            )) ||
      value.requiredWinningAavCents !==
        expectedRequiredAavCents ||
      value.finalTotalValueCents !==
        expectedFinalTotalValueCents
    ) {
      failState("winner_pricing_invalid");
    }
  }
  return Object.freeze({ ...value });
}

function safeEvidence(value, outcome, allocationId) {
  const standaloneOpen = allocationId === null;
  const restrictedFallback =
    outcome === "restricted_fallback";
  const delayedFallback =
    restrictedFallback && value?.activityId === null;
  const notificationIdsAreSafe = canonicalIdArray(
    value?.notificationIds
  );
  const expectedOutboxCount = delayedFallback
    ? 1
    : (restrictedFallback ? 4 : 3) +
      (notificationIdsAreSafe
        ? value.notificationIds.length
        : 0);
  if (
    !hasExactOwnProperties(value, EVIDENCE_FIELDS) ||
    (standaloneOpen
      ? !canonicalIdArray(value.clonedOfferEventIds, {
          exactLength: 0,
        }) || value.stateEventId !== null
      : !canonicalIdArray(value.clonedOfferEventIds, {
          minimumLength: 1,
        }) ||
        !UUID_PATTERN.test(value.stateEventId || "")) ||
    !notificationIdsAreSafe ||
    !canonicalIdArray(value.outboxEventIds, {
      exactLength: expectedOutboxCount,
    }) ||
    (
      delayedFallback
        ? value.activityId !== null ||
          value.notificationIds.length !== 0
        : !UUID_PATTERN.test(value.activityId || "")
    )
  ) {
    failState("resolution_evidence_invalid");
  }
  return Object.freeze({
    clonedOfferEventIds: Object.freeze([
      ...value.clonedOfferEventIds,
    ]),
    stateEventId: value.stateEventId,
    activityId: value.activityId,
    notificationIds: Object.freeze([
      ...value.notificationIds,
    ]),
    outboxEventIds: Object.freeze([
      ...value.outboxEventIds,
    ]),
  });
}

function safeCommittedRoster(result, execution, winner) {
  const descriptor = Object.getOwnPropertyDescriptor(
    result,
    "committedRoster"
  );
  if (
    !descriptor ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false ||
    descriptor.writable !== false ||
    !Object.hasOwn(descriptor, "value")
  ) {
    failState("committed_roster_descriptor_invalid");
  }
  if (!winner) {
    if (descriptor.value !== null) {
      failState("committed_roster_invalid");
    }
    return null;
  }
  const roster = descriptor.value;
  const witnesses = roster?.ownershipWitnesses;
  const witness = witnesses?.[0];
  if (
    !hasExactOwnProperties(
      roster,
      COMMITTED_ROSTER_FIELDS
    ) ||
    roster.leagueId !== execution.leagueId ||
    roster.seasonId !== execution.seasonId ||
    roster.teamId !== winner.teamId ||
    !Array.isArray(witnesses) ||
    witnesses.length !== 1 ||
    !hasExactOwnProperties(
      witness,
      OWNERSHIP_WITNESS_FIELDS
    ) ||
    witness.ownershipId !== winner.ownershipId ||
    witness.ownershipVersion !== 1 ||
    witness.state !== "present"
  ) {
    failState("committed_roster_invalid");
  }
  return Object.freeze({
    leagueId: roster.leagueId,
    seasonId: roster.seasonId,
    teamId: roster.teamId,
    ownershipWitnesses: Object.freeze([
      Object.freeze({ ...witness }),
    ]),
  });
}

function safeTerminalResult(
  result,
  execution,
  observedAtMs
) {
  const winnerOutcome = result?.outcome === "winner";
  const expectedFields = winnerOutcome
    ? WINNER_TERMINAL_FIELDS
    : TERMINAL_FIELDS;
  if (
    !hasExactOwnProperties(result, expectedFields) ||
    result.completed !== true ||
    !["winner", "no_winner", "restricted_fallback"]
      .includes(result.outcome) ||
    typeof result.replayed !== "boolean" ||
    result.leagueId !== execution.leagueId ||
    result.seasonId !== execution.seasonId ||
    result.fadId !== execution.fadId ||
    result.allocationId !== execution.allocationId ||
    result.auctionId !== execution.auctionId ||
    result.rolloverId !== execution.rolloverId ||
    result.occurrenceKey !== execution.occurrenceKey ||
    result.jobRunId !== execution.jobExecution.runId ||
    result.allocationVersion !==
      (execution.allocationId === null
        ? 0
        : execution.expectedAllocationVersion + 1) ||
    result.auctionVersion !==
      execution.expectedAuctionVersion + 1 ||
    result.jobRunVersion !==
      execution.jobExecution.expectedVersion + 1 ||
    !UUID_PATTERN.test(result.resolutionId || "") ||
    !Number.isSafeInteger(result.resolvedAtMs) ||
    result.resolvedAtMs < execution.resolvesAtMs ||
    result.resolvedAtMs <
      execution.jobExecution.startedAtMs ||
    result.resolvedAtMs >=
      execution.jobExecution.leaseExpiresAtMs ||
    result.resolvedAtMs > observedAtMs ||
    (!result.replayed &&
      result.resolvedAtMs !== observedAtMs) ||
    (
      result.outcome === "restricted_fallback"
        ? !UUID_PATTERN.test(
            result.fallbackAuctionId || ""
          ) ||
          result.fallbackAuctionId === result.auctionId
        : result.fallbackAuctionId !== null
    )
  ) {
    failState("terminal_result_invalid");
  }
  const winner = winnerOutcome
    ? safeWinner(result.winner)
    : null;
  const drawReveal = safeDrawReveal(
    result.drawReveal,
    winner
  );
  if (
    !winnerOutcome &&
    drawReveal.selectionUsed
  ) {
    failState("draw_reveal_invalid");
  }
  const evidence = safeEvidence(
    result.evidence,
    result.outcome,
    execution.allocationId
  );
  const committedRoster = safeCommittedRoster(
    result,
    execution,
    winner
  );
  return Object.freeze({
    completed: true,
    replayed: result.replayed,
    outcome: result.outcome,
    leagueId: result.leagueId,
    seasonId: result.seasonId,
    fadId: result.fadId,
    allocationId: result.allocationId,
    allocationVersion: result.allocationVersion,
    auctionId: result.auctionId,
    auctionVersion: result.auctionVersion,
    rolloverId: result.rolloverId,
    occurrenceKey: result.occurrenceKey,
    resolvedAtMs: result.resolvedAtMs,
    resolutionId: result.resolutionId,
    fallbackAuctionId: result.fallbackAuctionId,
    jobRunId: result.jobRunId,
    jobRunVersion: result.jobRunVersion,
    drawReveal,
    evidence,
    ...(winner ? { winner } : {}),
    committedRoster,
  });
}

function safeLateLockProjection(value) {
  if (
    !hasExactOwnProperties(
      value,
      Object.hasOwn(value || {}, "lockId")
        ? ["lockId", "status"]
        : ["status"]
    ) ||
    !LATE_LOCK_STATUSES.has(value.status) ||
    (
      Object.hasOwn(value, "lockId") &&
      (
        value.status !== "completed" ||
        !UUID_PATTERN.test(value.lockId || "")
      )
    )
  ) {
    throw new TypeError(
      "FAD auction resolution received an unsafe late-lock result"
    );
  }
  return Object.freeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId")
      ? { lockId: value.lockId }
      : {}),
  });
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD auction resolution requires ${description}`
    );
  }
}

function createFreeAgentDraftAuctionResolutionService({
  repository,
  clock,
  lateLockCoordinator,
} = {}) {
  requireMethod(
    repository,
    "executeClaimed",
    "an atomic resolution repository"
  );
  requireMethod(clock, "nowMs", "a UTC clock");
  requireMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );

  async function projectAndCoordinate(terminal) {
    if (!terminal.committedRoster) {
      const {
        committedRoster: ignored,
        ...projection
      } = terminal;
      return Object.freeze(projection);
    }

    let lateLock = AWAITING_DATA_LATE_LOCK;
    try {
      lateLock = safeLateLockProjection(
        await lateLockCoordinator.coordinateCommittedRoster(
          Object.freeze({
            mutationKind: "fad_auction_resolution",
            teams: Object.freeze([
              terminal.committedRoster,
            ]),
          })
        )
      );
    } catch {
      lateLock = AWAITING_DATA_LATE_LOCK;
    }
    const {
      committedRoster: ignored,
      ...projection
    } = terminal;
    return Object.freeze({
      ...projection,
      lateLock,
    });
  }

  return Object.freeze({
    async executeClaimedResolution(input = {}) {
      const execution = normalizeExecution(input);
      const resolvedAtMs = clock.nowMs();
      if (
        !Number.isSafeInteger(resolvedAtMs) ||
        resolvedAtMs < 0
      ) {
        failState("clock_timestamp_invalid");
      }
      if (resolvedAtMs < execution.resolvesAtMs) {
        failState("auction_not_due");
      }
      if (
        resolvedAtMs <
          execution.jobExecution.startedAtMs ||
        resolvedAtMs >=
          execution.jobExecution.leaseExpiresAtMs
      ) {
        failState("claimed_lease_expired");
      }
      const result = repository.executeClaimed({
        leagueId: execution.leagueId,
        seasonId: execution.seasonId,
        fadId: execution.fadId,
        allocationId: execution.allocationId,
        playerId: execution.playerId,
        rolloverId: execution.rolloverId,
        auctionId: execution.auctionId,
        occurrenceKey: execution.occurrenceKey,
        expectedAuctionVersion:
          execution.expectedAuctionVersion,
        expectedAllocationVersion:
          execution.expectedAllocationVersion,
        expectedJobVersion:
          execution.jobExecution.expectedVersion,
        resolvedAtMs,
        jobExecution: {
          runId: execution.jobExecution.runId,
          leaseOwner:
            execution.jobExecution.leaseOwner,
          leaseToken:
            execution.jobExecution.leaseToken,
          leaseExpiresAtMs:
            execution.jobExecution.leaseExpiresAtMs,
        },
      });
      if (result && typeof result.then === "function") {
        failState("repository_must_be_synchronous");
      }
      const terminal = safeTerminalResult(
        result,
        execution,
        resolvedAtMs
      );
      return projectAndCoordinate(terminal);
    },

    async coordinateCommittedResolution(input = {}) {
      const { execution, result } =
        normalizeCommittedResolution(input);
      const terminal = safeTerminalResult(
        result,
        execution,
        result.resolvedAtMs
      );
      return projectAndCoordinate(terminal);
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_AUCTION_RESOLUTION_SERVICE_CODES,
  FreeAgentDraftAuctionResolutionServiceError,
  createFreeAgentDraftAuctionResolutionService,
};
