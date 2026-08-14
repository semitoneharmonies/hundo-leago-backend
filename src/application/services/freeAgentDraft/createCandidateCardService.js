"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  CANONICAL_UUID_PATTERN,
  CANDIDATE_CARD_SLOT_KEYS,
} = require(
  "../../../domain/freeAgentDraft/candidateCardPolicy"
);
const {
  normalizeCandidateEligiblePlayerName,
  normalizeCandidateEligiblePlayerQuery,
} = require(
  "../../../domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);
const {
  normalizeCandidateCardRevisionPreviewAction,
} = require(
  "../../../domain/freeAgentDraft/candidateCardRevisionPreviewPolicy"
);
const {
  normalizeCandidateCardExpectedVersion,
  normalizeCandidateCardIdempotencyKey,
  normalizeCandidateCardMutationAction,
  normalizeCandidateCardWholeSave,
} = require(
  "../../../domain/freeAgentDraft/candidateCardMutationPolicy"
);
const {
  normalizeCandidateCardHelpBody,
  normalizeCandidateCardHelpIdempotencyKey,
  normalizeCandidateCardHelpMessage,
} = require(
  "../../../domain/freeAgentDraft/candidateCardHelpPolicy"
);

const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1_000;
const HELP_RESULT_KEYS = Object.freeze([
  "helpRequestId",
  "leagueId",
  "seasonId",
  "fadId",
  "cardId",
  "teamId",
  "status",
  "message",
  "requestedByUserId",
  "requestedByDisplayName",
  "requestedAtMs",
  "expiresAtMs",
  "version",
]);
const PRIVATE_CARD_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "fadId",
  "teamId",
  "cardId",
  "cardVersion",
  "phase",
  "visibilityMode",
  "accessReason",
  "authorizationEvidence",
  "lifecycleStatus",
  "completeness",
  "capProjection",
  "capStatus",
  "allocationEligibility",
  "allocationExclusionReason",
  "slots",
  "conflicts",
  "helpContext",
  "commissionerInterventions",
  "capabilities",
]);
const PRIVATE_SLOT_KEYS = Object.freeze([
  "slotKey",
  "slotGroup",
  "required",
  "occupantKind",
  "entryId",
  "entryVersion",
  "player",
  "authoritativeRosterCategory",
  "locked",
  "totalValueCents",
  "termYears",
  "aavCents",
  "remainingYears",
  "validation",
  "outcome",
  "lastEditedAtMs",
  "lastEditedBy",
  "capabilities",
]);
const ACTION_CAPABILITY_KEYS = Object.freeze([
  "allowed",
  "reasonCode",
]);
const ACTION_REASON_CODES = new Set([
  "NOT_AUTHORIZED",
  "HELP_NOT_GRANTED",
  "PHASE_CLOSED",
  "DEADLINE_PASSED",
  "LEAGUE_FROZEN",
  "SLOT_LOCKED",
  "SLOT_OCCUPIED",
  "ENTRY_NOT_EDITABLE",
  "PLAYER_INELIGIBLE",
  "TEAM_NOT_PARTICIPANT",
  "COOLDOWN_ACTIVE",
  "EDIT_LIMIT_REACHED",
  "PLAYER_QUARANTINED",
  "RECOVERY_NOT_AVAILABLE",
  "PREVIEW_ONLY",
]);
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;
const PREVIEW_WARNING_MESSAGES = Object.freeze({
  CANDIDATE_CARD_OVER_CAP:
    "The projected Candidate Card exceeds the salary cap.",
  CANDIDATE_CARD_STRUCTURAL_CONFLICT:
    "The projected Candidate Card has an unresolved carried-roster structural conflict.",
  candidate:
    "The projected Candidate entry requires attention.",
});

class CandidateCardNotFoundError extends Error {
  constructor() {
    super(
      "The Candidate Card was not found in the current private scope."
    );
    this.name = "CandidateCardNotFoundError";
    this.code = "CANDIDATE_CARD_NOT_FOUND";
  }
}

function inputInvalid(message) {
  const error = new TypeError(message);
  error.code = "CANDIDATE_CARD_INPUT_INVALID";
  throw error;
}

function assertMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `Candidate Card service requires ${description}`
    );
  }
}

function exactKeys(value, keys) {
  const prototype =
    value !== null &&
    typeof value === "object"
      ? Object.getPrototypeOf(value)
      : undefined;
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(
      prototype
    ) &&
    Object.getOwnPropertySymbols(value).length ===
      0 &&
    Object.getOwnPropertyNames(value)
      .sort()
      .join("|") ===
      [...keys].sort().join("|")
  );
}

function exactInput(input) {
  if (
    !exactKeys(input, [
      "authenticated",
      "leagueId",
      "fadId",
      "teamId",
    ])
  ) {
    inputInvalid(
      "An exact private Candidate Card read request is required."
    );
  }
  return input;
}

function exactEligiblePlayersInput(input) {
  if (
    !exactKeys(input, [
      "authenticated",
      "leagueId",
      "fadId",
      "teamId",
      "query",
    ])
  ) {
    inputInvalid(
      "An exact Candidate eligible-player read request is required."
    );
  }
  return input;
}

function exactRevisionPreviewInput(input) {
  if (
    !exactKeys(input, [
      "authenticated",
      "leagueId",
      "fadId",
      "teamId",
      "action",
    ])
  ) {
    inputInvalid(
      "An exact Candidate Card revision-preview request is required."
    );
  }
  return input;
}

function exactMutationInput(
  input,
  fields,
  description
) {
  if (!exactKeys(input, fields)) {
    inputInvalid(
      `An exact Candidate Card ${description} request is required.`
    );
  }
  return input;
}

function exactMutationBody(
  input,
  fields,
  description
) {
  if (!exactKeys(input, fields)) {
    inputInvalid(
      `An exact Candidate Card ${description} body is required.`
    );
  }
  return input;
}

function nonnegativeInteger(value) {
  return (
    Number.isSafeInteger(value) && value >= 0
  );
}

function actionCapability(value) {
  return (
    exactKeys(value, ACTION_CAPABILITY_KEYS) &&
    typeof value.allowed === "boolean" &&
    (
      value.allowed
        ? value.reasonCode === null
        : ACTION_REASON_CODES.has(
            value.reasonCode
          )
    )
  );
}

function exactCapabilities(value, fields) {
  return (
    exactKeys(value, fields) &&
    fields.every((field) =>
      actionCapability(value[field])
    )
  );
}

function safePlayer(value) {
  return (
    exactKeys(value, [
      "playerId",
      "fullName",
      "positionGroup",
    ]) &&
    CANONICAL_UUID_PATTERN.test(value.playerId || "") &&
    typeof value.fullName === "string" &&
    value.fullName.length > 0 &&
    ["F", "D"].includes(value.positionGroup)
  );
}

function safeEditor(value) {
  if (value === null) return true;
  if (
    !exactKeys(value, [
      "userId",
      "displayName",
      "authority",
    ])
  ) {
    return false;
  }
  if (value.authority === "system") {
    return (
      value.userId === null &&
      value.displayName === null
    );
  }
  return (
    CANONICAL_UUID_PATTERN.test(value.userId || "") &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    [
      "manager",
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(value.authority)
  );
}

function safeValidation(value) {
  return (
    exactKeys(value, ["status", "codes"]) &&
    ["valid", "warning", "invalid"].includes(
      value.status
    ) &&
    Array.isArray(value.codes) &&
    value.codes.every(
      (code) =>
        typeof code === "string" &&
        code.length > 0
    ) &&
    new Set(value.codes).size ===
      value.codes.length
  );
}

function nullableMoney(value) {
  return value === null || nonnegativeInteger(value);
}

function nullablePositiveMoney(value) {
  return (
    value === null ||
    (Number.isSafeInteger(value) && value > 0)
  );
}

function nullableCandidateTerm(value) {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 3)
  );
}

function safePrivateSlot(slot, index) {
  if (
    !exactKeys(slot, PRIVATE_SLOT_KEYS) ||
    slot.slotKey !==
      CANDIDATE_CARD_SLOT_KEYS[index] ||
    slot.slotGroup !== slot.slotKey[0] ||
    slot.required !==
      (slot.slotGroup !== "B") ||
    ![
      "empty",
      "carryover",
      "candidate",
    ].includes(slot.occupantKind) ||
    typeof slot.locked !== "boolean" ||
    !safeValidation(slot.validation) ||
    slot.outcome !== null ||
    !exactCapabilities(slot.capabilities, [
      "addCandidate",
      "editCandidate",
      "moveCandidate",
      "moveCarryover",
      "removeCandidate",
    ])
  ) {
    return false;
  }
  if (slot.occupantKind === "empty") {
    return (
      slot.entryId === null &&
      slot.entryVersion === null &&
      slot.player === null &&
      slot.authoritativeRosterCategory ===
        null &&
      slot.locked === false &&
      slot.totalValueCents === null &&
      slot.termYears === null &&
      slot.aavCents === null &&
      slot.remainingYears === null &&
      slot.lastEditedAtMs === null &&
      slot.lastEditedBy === null
    );
  }
  if (
    !CANONICAL_UUID_PATTERN.test(slot.entryId || "") ||
    !Number.isSafeInteger(slot.entryVersion) ||
    slot.entryVersion < 1 ||
    !safePlayer(slot.player) ||
    !nullableMoney(slot.totalValueCents) ||
    !nullableMoney(slot.aavCents) ||
    !nonnegativeInteger(slot.lastEditedAtMs) ||
    !safeEditor(slot.lastEditedBy)
  ) {
    return false;
  }
  if (slot.occupantKind === "carryover") {
    return (
      [
        "Active",
        "Bench",
        "Injured Reserve",
      ].includes(
        slot.authoritativeRosterCategory
      ) &&
      slot.locked === true &&
      Number.isSafeInteger(slot.termYears) &&
      slot.termYears >= 1 &&
      Number.isSafeInteger(slot.remainingYears) &&
      slot.remainingYears >= 1
    );
  }
  const incomplete =
    slot.totalValueCents === null ||
    slot.termYears === null;
  return (
    slot.authoritativeRosterCategory === null &&
    slot.locked === false &&
    nullablePositiveMoney(
      slot.totalValueCents
    ) &&
    nullableCandidateTerm(slot.termYears) &&
    slot.remainingYears === null &&
    (
      incomplete
        ? (
            slot.aavCents === null &&
            slot.validation.status ===
              "invalid" &&
            slot.validation.codes.length === 1 &&
            slot.validation.codes[0] ===
              "CANDIDATE_CONTRACT_INCOMPLETE"
          )
        : (
            Number.isSafeInteger(
              slot.aavCents
            ) &&
            slot.aavCents > 0 &&
            !slot.validation.codes.includes(
              "CANDIDATE_CONTRACT_INCOMPLETE"
            )
          )
    )
  );
}

function safeCompleteness(value) {
  const fields = [
    "code",
    "filledMandatoryCount",
    "missingMandatoryCount",
    "filledBenchCount",
    "emptyBenchCount",
    "blockingValidationCount",
    "structuralConflictCount",
    "carriedRosterStructuralConflictCount",
  ];
  return (
    exactKeys(value, fields) &&
    ["complete", "incomplete", "conflicted"].includes(
      value.code
    ) &&
    fields
      .filter((field) => field !== "code")
      .every((field) =>
        nonnegativeInteger(value[field])
      )
  );
}

function safeCapProjection(value) {
  const fields = [
    "capLimitCents",
    "carriedActivePlayerAmountCents",
    "retentionObligationCents",
    "buyoutPenaltyCents",
    "carriedCapUsageCents",
    "proposedCandidateAavCents",
    "maximumPossibleCapCents",
    "maximumCapSpaceCents",
  ];
  return (
    exactKeys(value, fields) &&
    fields.every((field) =>
      Number.isSafeInteger(value[field])
    ) &&
    fields
      .filter(
        (field) =>
          field !== "maximumCapSpaceCents"
      )
      .every((field) => value[field] >= 0)
  );
}

function safeAuthorizationEvidence(value) {
  return (
    exactKeys(value, ["kind", "id"]) &&
    ["manager_assignment", "help_request"].includes(
      value.kind
    ) &&
    CANONICAL_UUID_PATTERN.test(value.id || "")
  );
}

function safeHelpContext(value) {
  return (
    value === null ||
    (
      exactKeys(value, [
        "helpRequestId",
        "status",
        "message",
        "requestedByUserId",
        "requestedByDisplayName",
        "requestedAtMs",
        "expiresAtMs",
      ]) &&
      CANONICAL_UUID_PATTERN.test(
        value.helpRequestId || ""
      ) &&
      ["active", "expired"].includes(
        value.status
      ) &&
      (
        value.message === null ||
        typeof value.message === "string"
      ) &&
      CANONICAL_UUID_PATTERN.test(
        value.requestedByUserId || ""
      ) &&
      typeof value.requestedByDisplayName ===
        "string" &&
      value.requestedByDisplayName.length > 0 &&
      nonnegativeInteger(value.requestedAtMs) &&
      nonnegativeInteger(value.expiresAtMs)
    )
  );
}

function safeConflict(value) {
  return (
    exactKeys(value, [
      "entryId",
      "entryVersion",
      "player",
      "intendedSlotKey",
      "conflictCode",
      "validation",
      "lastEditedBy",
    ]) &&
    CANONICAL_UUID_PATTERN.test(value.entryId || "") &&
    Number.isSafeInteger(value.entryVersion) &&
    value.entryVersion >= 1 &&
    safePlayer(value.player) &&
    CANDIDATE_CARD_SLOT_KEYS.includes(
      value.intendedSlotKey
    ) &&
    typeof value.conflictCode === "string" &&
    value.conflictCode.length > 0 &&
    safeValidation(value.validation) &&
    safeEditor(value.lastEditedBy)
  );
}

function safeIntervention(value) {
  return (
    exactKeys(value, [
      "revisionId",
      "entryId",
      "action",
      "actorUserId",
      "actorDisplayName",
      "authority",
      "occurredAtMs",
    ]) &&
    CANONICAL_UUID_PATTERN.test(value.revisionId || "") &&
    (
      value.entryId === null ||
      CANONICAL_UUID_PATTERN.test(value.entryId || "")
    ) &&
    typeof value.action === "string" &&
    value.action.length > 0 &&
    CANONICAL_UUID_PATTERN.test(value.actorUserId || "") &&
    typeof value.actorDisplayName === "string" &&
    value.actorDisplayName.length > 0 &&
    [
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(value.authority) &&
    nonnegativeInteger(value.occurredAtMs)
  );
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    inputInvalid(
      "A canonical Candidate Card identifier is required."
    );
  }
  return value;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new TypeError(
      "Candidate Card reads require a safe UTC timestamp."
    );
  }
  return nowMs;
}

function safeMutationTiming(clock) {
  const nowMs = safeNow(clock);
  if (
    nowMs >
    MAXIMUM_TIMESTAMP_MS -
      CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "Candidate Card mutations require an overflow-safe UTC timestamp."
    );
  }
  return Object.freeze({
    nowMs,
    expiresAtMs:
      nowMs +
      CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
  });
}

function secureId(secureRandom, allocatedIds) {
  const value = secureRandom.id();
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value) ||
    allocatedIds.has(value)
  ) {
    throw new TypeError(
      "Candidate Card mutations require unique secure UUIDv4 identifiers."
    );
  }
  allocatedIds.add(value);
  return value;
}

function viewer(authority) {
  if (
    !authority ||
    !CANONICAL_UUID_PATTERN.test(
      authority.actorUserId || ""
    ) ||
    !CANONICAL_UUID_PATTERN.test(
      authority.membershipId || ""
    )
  ) {
    throw new TypeError(
      "Candidate Card reads require canonical membership authority."
    );
  }
  return Object.freeze({
    userId: authority.actorUserId,
    membershipId: authority.membershipId,
  });
}

function canonicalPrivateCard(
  result,
  { leagueId, fadId, teamId }
) {
  if (
    !exactKeys(result, PRIVATE_CARD_KEYS) ||
    result.leagueId !== leagueId ||
    result.fadId !== fadId ||
    result.teamId !== teamId ||
    !CANONICAL_UUID_PATTERN.test(result.seasonId || "") ||
    !CANONICAL_UUID_PATTERN.test(result.cardId || "") ||
    !Number.isSafeInteger(result.cardVersion) ||
    result.cardVersion < 1 ||
    ![
      "cards_open",
      "help_window",
      "deadline_processing",
    ].includes(result.phase) ||
    ![
      "private_editable",
      "private_read_only",
    ].includes(result.visibilityMode) ||
    ![
      "team_manager",
      "help_grant_commissioner",
      "help_grant_platform_administrator",
    ].includes(result.accessReason) ||
    !safeAuthorizationEvidence(
      result.authorizationEvidence
    ) ||
    (
      result.accessReason === "team_manager"
        ? result.authorizationEvidence.kind !==
          "manager_assignment"
        : result.authorizationEvidence.kind !==
          "help_request"
    ) ||
    result.lifecycleStatus !== "open" ||
    !safeCompleteness(result.completeness) ||
    !safeCapProjection(result.capProjection) ||
    !["compliant", "over_cap"].includes(
      result.capStatus
    ) ||
    ![
      "eligible",
      "excluded_structural_conflict",
      "excluded_over_cap",
    ].includes(result.allocationEligibility) ||
    (
      result.allocationEligibility === "eligible"
        ? result.allocationExclusionReason !== null
        : typeof result.allocationExclusionReason !==
          "string"
    ) ||
    !Array.isArray(result.slots) ||
    result.slots.length !==
      CANDIDATE_CARD_SLOT_KEYS.length ||
    result.slots.some(
      (slot, index) =>
        !safePrivateSlot(slot, index)
    ) ||
    !Array.isArray(result.conflicts) ||
    !result.conflicts.every(safeConflict) ||
    !safeHelpContext(result.helpContext) ||
    !Array.isArray(
      result.commissionerInterventions
    ) ||
    !result.commissionerInterventions.every(
      safeIntervention
    ) ||
    !exactCapabilities(result.capabilities, [
      "editCard",
      "requestHelp",
      "viewPublishedHistory",
    ]) ||
    (
      result.visibilityMode === "private_editable"
        ? result.capabilities.editCard.allowed !==
          true
        : result.capabilities.editCard.allowed !==
          false
    ) ||
    (
      result.phase === "deadline_processing" &&
      result.visibilityMode !== "private_read_only"
    )
  ) {
    throw new TypeError(
      "The canonical private Candidate Card projection is unavailable."
    );
  }
  return result;
}

function previewCapabilitiesOnly(card) {
  return [
    ...Object.values(card.capabilities),
    ...card.slots.flatMap((slot) =>
      Object.values(slot.capabilities)
    ),
  ].every(
    (capability) =>
      capability.allowed === false &&
      capability.reasonCode ===
        "PREVIEW_ONLY"
  );
}

function projectedEntryLocations(
  card,
  entryId
) {
  return [
    ...card.slots
      .filter((slot) => slot.entryId === entryId)
      .map((slot) => ({
        kind: "slot",
        slotKey: slot.slotKey,
        value: slot,
      })),
    ...card.conflicts
      .filter(
        (conflict) =>
          conflict.entryId === entryId
      )
      .map((conflict) => ({
        kind: "conflict",
        slotKey:
          conflict.intendedSlotKey,
        value: conflict,
      })),
  ];
}

function warningOrder(left, right) {
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }
  if (left.resourceId === right.resourceId) {
    return 0;
  }
  if (left.resourceId === null) return -1;
  if (right.resourceId === null) return 1;
  return left.resourceId < right.resourceId
    ? -1
    : 1;
}

function safePreviewWarnings(warnings, card) {
  if (!Array.isArray(warnings)) return false;
  const entries = new Map();
  for (const slot of card.slots) {
    if (slot.entryId !== null) {
      entries.set(slot.entryId, {
        candidate:
          slot.occupantKind ===
          "candidate",
        validation: slot.validation,
      });
    }
  }
  for (const conflict of card.conflicts) {
    entries.set(conflict.entryId, {
      candidate: true,
      validation: conflict.validation,
    });
  }
  const required = new Set();
  if (
    card.completeness
      .carriedRosterStructuralConflictCount > 0
  ) {
    required.add(
      `CANDIDATE_CARD_STRUCTURAL_CONFLICT\u0000${card.cardId}`
    );
  }
  if (card.capStatus === "over_cap") {
    required.add(
      `CANDIDATE_CARD_OVER_CAP\u0000${card.cardId}`
    );
  }
  for (const [entryId, entry] of entries) {
    if (
      entry.candidate &&
      entry.validation.status === "warning"
    ) {
      for (const code of entry.validation.codes) {
        required.add(`${code}\u0000${entryId}`);
      }
    }
  }

  const seen = new Set();
  let previous = null;
  for (const warning of warnings) {
    if (
      !exactKeys(warning, [
        "code",
        "message",
        "resourceId",
      ]) ||
      !SAFE_CODE_PATTERN.test(
        warning.code || ""
      ) ||
      !CANONICAL_UUID_PATTERN.test(
        warning.resourceId || ""
      ) ||
      (
        previous !== null &&
        warningOrder(previous, warning) >= 0
      )
    ) {
      return false;
    }
    const key = `${warning.code}\u0000${warning.resourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    previous = warning;

    if (
      warning.code ===
      "CANDIDATE_CARD_STRUCTURAL_CONFLICT"
    ) {
      if (
        card.completeness
          .carriedRosterStructuralConflictCount < 1 ||
        warning.resourceId !== card.cardId ||
        warning.message !==
          PREVIEW_WARNING_MESSAGES[
            warning.code
          ]
      ) {
        return false;
      }
      continue;
    }
    if (
      warning.code ===
      "CANDIDATE_CARD_OVER_CAP"
    ) {
      if (
        card.capStatus !== "over_cap" ||
        warning.resourceId !== card.cardId ||
        warning.message !==
          PREVIEW_WARNING_MESSAGES[
            warning.code
          ]
      ) {
        return false;
      }
      continue;
    }
    const entry = entries.get(
      warning.resourceId
    );
    if (
      !entry?.candidate ||
      warning.message !==
        PREVIEW_WARNING_MESSAGES.candidate ||
      !entry.validation.codes.includes(
        warning.code
      )
    ) {
      return false;
    }
  }
  return [...required].every((key) =>
    seen.has(key)
  );
}

function canonicalRevisionPreview(
  result,
  { leagueId, fadId, teamId, action }
) {
  if (
    !exactKeys(result, [
      "baseCardVersion",
      "action",
      "projectedCard",
      "projectedSlot",
      "warnings",
    ]) ||
    !Number.isSafeInteger(
      result.baseCardVersion
    ) ||
    result.baseCardVersion < 1 ||
    result.baseCardVersion >=
      Number.MAX_SAFE_INTEGER ||
    !isDeepStrictEqual(result.action, action)
  ) {
    throw new TypeError(
      "The canonical Candidate Card revision preview is unavailable."
    );
  }
  const card = canonicalPrivateCard(
    result.projectedCard,
    { leagueId, fadId, teamId }
  );
  if (
    card.cardVersion !==
      result.baseCardVersion + 1 ||
    !["cards_open", "help_window"].includes(
      card.phase
    ) ||
    card.visibilityMode !==
      "private_read_only" ||
    !previewCapabilitiesOnly(card) ||
    !safePreviewWarnings(
      result.warnings,
      card
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card revision preview is unavailable."
    );
  }

  if (action.type === "remove") {
    if (
      result.projectedSlot !== null ||
      projectedEntryLocations(
        card,
        action.entryId
      ).length !== 0
    ) {
      throw new TypeError(
        "The canonical Candidate Card revision preview is unavailable."
      );
    }
    return result;
  }

  let targetSlotKey;
  if (
    action.type === "add" ||
    action.type === "move"
  ) {
    targetSlotKey = action.slotKey;
  } else {
    const locations = projectedEntryLocations(
      card,
      action.entryId
    );
    if (locations.length !== 1) {
      throw new TypeError(
        "The canonical Candidate Card revision preview is unavailable."
      );
    }
    targetSlotKey = locations[0].slotKey;
  }
  const canonicalSlot = card.slots.find(
    ({ slotKey }) => slotKey === targetSlotKey
  );
  if (
    !canonicalSlot ||
    !isDeepStrictEqual(
      result.projectedSlot,
      canonicalSlot
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card revision preview is unavailable."
    );
  }
  if (
    action.type === "add" &&
    (
      canonicalSlot.occupantKind !==
        "candidate" ||
      canonicalSlot.entryVersion !== 1 ||
      canonicalSlot.player?.playerId !==
        action.playerId ||
      canonicalSlot.totalValueCents !==
        action.totalValueCents ||
      canonicalSlot.termYears !==
        action.termYears
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card revision preview is unavailable."
    );
  }
  if (
    action.type === "move" &&
    canonicalSlot.entryId !== action.entryId
  ) {
    throw new TypeError(
      "The canonical Candidate Card revision preview is unavailable."
    );
  }
  return result;
}

function canonicalMutationResult(
  result,
  {
    leagueId,
    fadId,
    teamId,
    expectedCardVersion,
    action,
  }
) {
  if (
    !exactKeys(result, [
      "card",
      "revisionId",
      "changedEntryId",
    ]) ||
    !CANONICAL_UUID_PATTERN.test(
      result.revisionId || ""
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card mutation result is unavailable."
    );
  }
  const card = canonicalPrivateCard(
    result.card,
    { leagueId, fadId, teamId }
  );
  if (
    card.cardVersion !==
      expectedCardVersion + 1 ||
    (
      action.type === "add" &&
      !CANONICAL_UUID_PATTERN.test(
        result.changedEntryId || ""
      )
    ) ||
    (
      ["edit", "move"].includes(
        action.type
      ) &&
      result.changedEntryId !== action.entryId
    ) ||
    (
      action.type === "remove" &&
      result.changedEntryId !== null
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card mutation result is unavailable."
    );
  }
  return Object.freeze({
    card,
    revisionId: result.revisionId,
    changedEntryId: result.changedEntryId,
  });
}

function canonicalWholeSaveResult(
  result,
  {
    leagueId,
    fadId,
    teamId,
    expectedCardVersion,
  }
) {
  if (
    !exactKeys(result, [
      "card",
      "revisionId",
      "changedEntryIds",
    ]) ||
    !CANONICAL_UUID_PATTERN.test(
      result.revisionId || ""
    ) ||
    !Array.isArray(result.changedEntryIds) ||
    result.changedEntryIds.some(
      (entryId) =>
        !CANONICAL_UUID_PATTERN.test(
          entryId || ""
        )
    ) ||
    new Set(result.changedEntryIds).size !==
      result.changedEntryIds.length ||
    result.changedEntryIds.some(
      (entryId, index, values) =>
        index > 0 &&
        values[index - 1] >= entryId
    )
  ) {
    throw new TypeError(
      "The canonical whole-card save result is unavailable."
    );
  }
  const card = canonicalPrivateCard(
    result.card,
    { leagueId, fadId, teamId }
  );
  if (
    card.cardVersion !==
      expectedCardVersion + 1
  ) {
    throw new TypeError(
      "The canonical whole-card save result is unavailable."
    );
  }
  return Object.freeze({
    card,
    revisionId: result.revisionId,
    changedEntryIds: Object.freeze([
      ...result.changedEntryIds,
    ]),
  });
}

function canonicalHelpCommandResult(
  result,
  {
    leagueId,
    fadId,
    teamId,
    viewer: authority,
    requestedMessage,
  }
) {
  if (
    !exactKeys(result, ["httpStatus", "data"]) ||
    ![200, 201].includes(result.httpStatus) ||
    !exactKeys(result.data, HELP_RESULT_KEYS)
  ) {
    throw new TypeError(
      "The canonical Candidate Card help result is unavailable."
    );
  }
  const data = result.data;
  let normalizedMessage;
  try {
    normalizedMessage =
      normalizeCandidateCardHelpMessage(
        data.message
      );
  } catch (error) {
    throw new TypeError(
      "The canonical Candidate Card help result is unavailable."
    );
  }
  if (
    !CANONICAL_UUID_PATTERN.test(
      data.helpRequestId || ""
    ) ||
    data.leagueId !== leagueId ||
    !CANONICAL_UUID_PATTERN.test(data.seasonId || "") ||
    data.fadId !== fadId ||
    !CANONICAL_UUID_PATTERN.test(data.cardId || "") ||
    data.teamId !== teamId ||
    data.status !== "active" ||
    normalizedMessage !== data.message ||
    !CANONICAL_UUID_PATTERN.test(
      data.requestedByUserId || ""
    ) ||
    typeof data.requestedByDisplayName !==
      "string" ||
    data.requestedByDisplayName.length < 1 ||
    data.requestedByDisplayName.trim() !==
      data.requestedByDisplayName ||
    !nonnegativeInteger(data.requestedAtMs) ||
    !nonnegativeInteger(data.expiresAtMs) ||
    data.requestedAtMs >= data.expiresAtMs ||
    data.version !== 1 ||
    (
      result.httpStatus === 201 &&
      (
        data.requestedByUserId !==
          authority.userId ||
        data.message !== requestedMessage
      )
    )
  ) {
    throw new TypeError(
      "The canonical Candidate Card help result is unavailable."
    );
  }
  return Object.freeze({
    httpStatus: result.httpStatus,
    data: Object.freeze({ ...data }),
  });
}

function safeEligiblePlayerItem(
  item,
  query
) {
  if (
    !exactKeys(item, [
      "player",
      "effectivePositionGroup",
      "activeState",
      "benchEligible",
      "eligibilityCode",
      "contractLimits",
    ]) ||
    !safePlayer(item.player) ||
    item.effectivePositionGroup !==
      item.player.positionGroup ||
    !["F", "D"].includes(
      item.effectivePositionGroup
    ) ||
    (
      query.slotKey[0] !== "B" &&
      item.effectivePositionGroup !==
        query.slotKey[0]
    ) ||
    item.activeState !== "active" ||
    item.benchEligible !== true ||
    item.eligibilityCode !== "eligible" ||
    !exactKeys(item.contractLimits, [
      "allowedTermsYears",
      "minimumTotalValueCentsByTerm",
      "maximumBenchAavCents",
    ]) ||
    !Array.isArray(
      item.contractLimits.allowedTermsYears
    ) ||
    item.contractLimits.allowedTermsYears
      .join("|") !== "1|2|3" ||
    !exactKeys(
      item.contractLimits
        .minimumTotalValueCentsByTerm,
      ["1", "2", "3"]
    ) ||
    item.contractLimits
      .minimumTotalValueCentsByTerm[1] !==
      100 ||
    item.contractLimits
      .minimumTotalValueCentsByTerm[2] !==
      200 ||
    item.contractLimits
      .minimumTotalValueCentsByTerm[3] !==
      300 ||
    item.contractLimits
      .maximumBenchAavCents !==
      (query.slotKey[0] === "B" ? 400 : null)
  ) {
    return false;
  }
  let normalizedName;
  try {
    normalizedName =
      normalizeCandidateEligiblePlayerName(
        item.player.fullName
      );
  } catch (error) {
    return false;
  }
  return (
    query.q === "" ||
    normalizedName.includes(query.q)
  );
}

function canonicalEligiblePlayerPage(
  result,
  query
) {
  if (
    !exactKeys(result, ["data", "page"]) ||
    !Array.isArray(result.data) ||
    result.data.length > query.limit ||
    !result.data.every((item) =>
      safeEligiblePlayerItem(item, query)
    ) ||
    !exactKeys(result.page, [
      "nextCursor",
      "hasMore",
    ]) ||
    typeof result.page.hasMore !== "boolean" ||
    (
      result.page.hasMore
        ? (
            result.data.length !== query.limit ||
            typeof result.page.nextCursor !==
              "string" ||
            result.page.nextCursor.length < 1
          )
        : result.page.nextCursor !== null
    )
  ) {
    throw new TypeError(
      "The canonical Candidate eligible-player page is unavailable."
    );
  }
  const seen = new Set();
  let previous = null;
  for (const item of result.data) {
    let sortName;
    try {
      sortName =
        normalizeCandidateEligiblePlayerName(
          item.player.fullName
        );
    } catch (error) {
      throw new TypeError(
        "The canonical Candidate eligible-player page is unavailable."
      );
    }
    const tuple = {
      sortName,
      playerId: item.player.playerId,
    };
    const nameOrder =
      previous === null
        ? 1
        : Buffer.compare(
            Buffer.from(
              tuple.sortName,
              "utf8"
            ),
            Buffer.from(
              previous.sortName,
              "utf8"
            )
          );
    if (
      seen.has(tuple.playerId) ||
      (
        previous !== null &&
        (
          nameOrder < 0 ||
          (
            nameOrder === 0 &&
            tuple.playerId <= previous.playerId
          )
        )
      )
    ) {
      throw new TypeError(
        "The canonical Candidate eligible-player page is unavailable."
      );
    }
    seen.add(tuple.playerId);
    previous = tuple;
  }
  if (result.page.hasMore) {
    let decoded;
    try {
      decoded =
        normalizeCandidateEligiblePlayerQuery(
          {
            slotKey: query.slotKey,
            q: query.q,
            limit: query.limit,
            cursor:
              result.page.nextCursor,
          },
          {
            leagueId: query.leagueId,
            fadId: query.fadId,
            teamId: query.teamId,
          }
        ).cursor;
    } catch (error) {
      throw new TypeError(
        "The canonical Candidate eligible-player page is unavailable."
      );
    }
    if (
      previous === null ||
      decoded.sortName !==
        previous.sortName ||
      decoded.playerId !==
        previous.playerId
    ) {
      throw new TypeError(
        "The canonical Candidate eligible-player page is unavailable."
      );
    }
  }
  return result;
}

function createCandidateCardService({
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league membership authorization"
  );
  assertMethod(
    repository,
    "readPrivateCurrent",
    "the canonical Candidate Card repository"
  );
  assertMethod(
    repository,
    "readEligiblePlayersCurrent",
    "the canonical Candidate eligible-player repository"
  );
  assertMethod(
    repository,
    "previewRevisionCurrent",
    "the canonical Candidate revision-preview repository"
  );
  assertMethod(
    repository,
    "mutateCurrent",
    "the canonical Candidate Card mutation repository"
  );
  assertMethod(
    repository,
    "saveCurrent",
    "the canonical whole-card save repository"
  );
  assertMethod(
    repository,
    "requestHelpCurrent",
    "the canonical Candidate Card help repository"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  function privateCard(input = {}) {
    const command = exactInput(input);
    const leagueId = stableId(
      command.leagueId
    );
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const result = repository.readPrivateCurrent({
      leagueId,
      fadId,
      teamId,
      viewer: authority,
      nowMs: safeNow(clock),
    });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    return canonicalPrivateCard(result, {
      leagueId,
      fadId,
      teamId,
    });
  }

  function eligiblePlayers(input = {}) {
    const command =
      exactEligiblePlayersInput(input);
    const leagueId = stableId(
      command.leagueId
    );
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const query =
      normalizeCandidateEligiblePlayerQuery(
        command.query,
        { leagueId, fadId, teamId }
      );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const result =
      repository.readEligiblePlayersCurrent({
        query,
        viewer: authority,
        nowMs: safeNow(clock),
      });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    return canonicalEligiblePlayerPage(
      result,
      query
    );
  }

  function previewRevision(input = {}) {
    const command =
      exactRevisionPreviewInput(input);
    const leagueId = stableId(
      command.leagueId
    );
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const action =
      normalizeCandidateCardRevisionPreviewAction(
        command.action
      );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const result =
      repository.previewRevisionCurrent({
        leagueId,
        fadId,
        teamId,
        viewer: authority,
        nowMs: safeNow(clock),
        action,
      });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    return canonicalRevisionPreview(result, {
      leagueId,
      fadId,
      teamId,
      action,
    });
  }

  function mutateCandidateCard({
    command,
    leagueId,
    fadId,
    teamId,
    action,
    expectedCardVersion,
    idempotencyKey,
    httpStatus,
  }) {
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const timing = safeMutationTiming(clock);
    const allocatedIds = new Set();
    const requestId = secureId(
      secureRandom,
      allocatedIds
    );
    const revisionId = secureId(
      secureRandom,
      allocatedIds
    );
    const repositoryAction =
      action.type === "add"
        ? Object.freeze({
            ...action,
            entryId: secureId(
              secureRandom,
              allocatedIds
            ),
          })
        : action;
    const result = repository.mutateCurrent({
      leagueId,
      fadId,
      teamId,
      viewer: authority,
      expectedCardVersion,
      nowMs: timing.nowMs,
      idempotency: Object.freeze({
        requestId,
        clientKey: idempotencyKey,
        expiresAtMs: timing.expiresAtMs,
      }),
      revisionId,
      action: repositoryAction,
    });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    const data = canonicalMutationResult(
      result,
      {
        leagueId,
        fadId,
        teamId,
        expectedCardVersion,
        action,
      }
    );
    return Object.freeze({
      httpStatus,
      data,
    });
  }

  function addCandidate(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "slotKey",
        "input",
        "expectedCardVersion",
        "idempotencyKey",
      ],
      "add-candidate"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const body = exactMutationBody(
      command.input,
      [
        "playerId",
        "totalValueCents",
        "termYears",
      ],
      "add-candidate"
    );
    const action =
      normalizeCandidateCardMutationAction({
        type: "add",
        slotKey: command.slotKey,
        playerId: body.playerId,
        totalValueCents:
          body.totalValueCents,
        termYears: body.termYears,
      });
    return mutateCandidateCard({
      command,
      leagueId,
      fadId,
      teamId,
      action,
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          command.expectedCardVersion
        ),
      idempotencyKey:
        normalizeCandidateCardIdempotencyKey(
          command.idempotencyKey
        ),
      httpStatus: 201,
    });
  }

  function saveCard(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "input",
        "expectedCardVersion",
        "idempotencyKey",
      ],
      "whole-card save"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const desired =
      normalizeCandidateCardWholeSave(
        command.input
      );
    const expectedCardVersion =
      normalizeCandidateCardExpectedVersion(
        command.expectedCardVersion
      );
    const idempotencyKey =
      normalizeCandidateCardIdempotencyKey(
        command.idempotencyKey
      );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const timing = safeMutationTiming(clock);
    const allocatedIds = new Set();
    const requestId = secureId(
      secureRandom,
      allocatedIds
    );
    const revisionId = secureId(
      secureRandom,
      allocatedIds
    );
    const entryIds = desired.slots.map((slot) =>
      slot.candidate === null
        ? null
        : secureId(
            secureRandom,
            allocatedIds
          )
    );
    const result = repository.saveCurrent({
      leagueId,
      fadId,
      teamId,
      viewer: authority,
      expectedCardVersion,
      nowMs: timing.nowMs,
      idempotency: Object.freeze({
        requestId,
        clientKey: idempotencyKey,
        expiresAtMs: timing.expiresAtMs,
      }),
      revisionId,
      slots: desired.slots,
      entryIds: Object.freeze(entryIds),
    });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    return Object.freeze({
      httpStatus: 200,
      data: canonicalWholeSaveResult(
        result,
        {
          leagueId,
          fadId,
          teamId,
          expectedCardVersion,
        }
      ),
    });
  }

  function editCandidate(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "entryId",
        "input",
        "expectedCardVersion",
        "idempotencyKey",
      ],
      "edit-candidate"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const body = exactMutationBody(
      command.input,
      ["totalValueCents", "termYears"],
      "edit-candidate"
    );
    const action =
      normalizeCandidateCardMutationAction({
        type: "edit",
        entryId: command.entryId,
        totalValueCents:
          body.totalValueCents,
        termYears: body.termYears,
      });
    return mutateCandidateCard({
      command,
      leagueId,
      fadId,
      teamId,
      action,
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          command.expectedCardVersion
        ),
      idempotencyKey:
        normalizeCandidateCardIdempotencyKey(
          command.idempotencyKey
        ),
      httpStatus: 200,
    });
  }

  function moveEntry(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "entryId",
        "input",
        "expectedCardVersion",
        "idempotencyKey",
      ],
      "move-entry"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const body = exactMutationBody(
      command.input,
      ["slotKey"],
      "move-entry"
    );
    const action =
      normalizeCandidateCardMutationAction({
        type: "move",
        entryId: command.entryId,
        slotKey: body.slotKey,
      });
    return mutateCandidateCard({
      command,
      leagueId,
      fadId,
      teamId,
      action,
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          command.expectedCardVersion
        ),
      idempotencyKey:
        normalizeCandidateCardIdempotencyKey(
          command.idempotencyKey
        ),
      httpStatus: 200,
    });
  }

  function removeCandidate(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "entryId",
        "expectedCardVersion",
        "idempotencyKey",
      ],
      "remove-candidate"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const action =
      normalizeCandidateCardMutationAction({
        type: "remove",
        entryId: command.entryId,
      });
    return mutateCandidateCard({
      command,
      leagueId,
      fadId,
      teamId,
      action,
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          command.expectedCardVersion
        ),
      idempotencyKey:
        normalizeCandidateCardIdempotencyKey(
          command.idempotencyKey
        ),
      httpStatus: 200,
    });
  }

  function requestHelp(input = {}) {
    const command = exactMutationInput(
      input,
      [
        "authenticated",
        "leagueId",
        "fadId",
        "teamId",
        "input",
        "idempotencyKey",
      ],
      "help"
    );
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const teamId = stableId(command.teamId);
    const body = normalizeCandidateCardHelpBody(
      command.input
    );
    const idempotencyKey =
      normalizeCandidateCardHelpIdempotencyKey(
        command.idempotencyKey
      );
    const authority = viewer(
      leagueAuthorization.requireActiveMembership(
        command.authenticated,
        leagueId
      )
    );
    const timing = safeMutationTiming(clock);
    const allocatedIds = new Set();
    const requestId = secureId(
      secureRandom,
      allocatedIds
    );
    const helpRequestId = secureId(
      secureRandom,
      allocatedIds
    );
    const result = repository.requestHelpCurrent({
      leagueId,
      fadId,
      teamId,
      viewer: authority,
      nowMs: timing.nowMs,
      idempotency: Object.freeze({
        requestId,
        clientKey: idempotencyKey,
        expiresAtMs: timing.expiresAtMs,
      }),
      helpRequestId,
      message: body.message,
    });
    if (result === null) {
      throw new CandidateCardNotFoundError();
    }
    return canonicalHelpCommandResult(result, {
      leagueId,
      fadId,
      teamId,
      viewer: authority,
      requestedMessage: body.message,
    });
  }

  return Object.freeze({
    addCandidate,
    editCandidate,
    eligiblePlayers,
    moveEntry,
    privateCard,
    previewRevision,
    removeCandidate,
    requestHelp,
    saveCard,
  });
}

module.exports = {
  CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
  CandidateCardNotFoundError,
  createCandidateCardService,
};
