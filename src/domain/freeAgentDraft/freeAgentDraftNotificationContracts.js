"use strict";

const {
  CANONICAL_UUID_PATTERN,
  CANDIDATE_CARD_MANDATORY_SLOT_COUNT,
  CANDIDATE_CARD_SLOT_COUNT,
} = require("./candidateCardPolicy");

const FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID =
  "FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID";

const FREE_AGENT_DRAFT_NOTIFICATION_TYPES = Object.freeze([
  "fad_cards_opened",
  "fad_readiness_blocked",
  "fad_deadline_approaching",
  "fad_help_requested",
  "fad_cards_locked",
  "fad_automatic_result",
  "fad_restricted_eligible",
  "fad_restricted_fallback_opened",
  "fad_rapid_auction_result",
  "fad_correction_required",
  "fad_week1_recovered",
  "fad_completed",
  "fad_setup_exemption_authorized",
]);

const FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES =
  Object.freeze([
    "won",
    "lost",
    "invalid",
    "removed",
    "no_winner",
    "cancelled",
    "correction_required",
  ]);

const FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES =
  Object.freeze([
    "complete",
    "incomplete",
    "conflicted",
  ]);

const FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY =
  Object.freeze({
    fad_cards_opened: "Your Candidate Card is ready.",
    fad_readiness_blocked:
      "Free Agent Draft readiness requires commissioner attention.",
    fad_deadline_approaching:
      "Your Candidate Card deadline is approaching.",
    fad_help_requested:
      "A manager has requested Candidate Card help.",
    fad_cards_locked:
      "Candidate Cards are locked and results are available.",
    fad_automatic_result:
      "Your Candidate Card results are available.",
    fad_restricted_eligible:
      "You are eligible to bid in a restricted FAD auction.",
    fad_restricted_fallback_opened:
      "A league-wide Free Agent Draft fallback auction is open.",
    fad_rapid_auction_result:
      "A Free Agent Draft auction has finished.",
    fad_correction_required:
      "Free Agent Draft recovery requires commissioner attention.",
    fad_week1_recovered:
      "Week 1 moved to complete the Free Agent Draft fairly.",
    fad_completed:
      "The Free Agent Draft is complete.",
    fad_setup_exemption_authorized:
      "Initial Season 2 Free Agent Draft exemption authorized.",
  });

const DESTINATION_FIELDS = Object.freeze({
  private_card: Object.freeze([
    "cardId",
    "fadId",
    "kind",
    "leagueId",
    "teamId",
  ]),
  commissioner_fad: Object.freeze([
    "kind",
    "leagueId",
    "seasonId",
  ]),
  fad_results: Object.freeze([
    "fadId",
    "kind",
    "leagueId",
  ]),
  auction: Object.freeze([
    "auctionId",
    "kind",
    "leagueId",
  ]),
  fad_recovery: Object.freeze([
    "fadId",
    "kind",
    "leagueId",
    "recoveryId",
  ]),
  fad_overview: Object.freeze([
    "fadId",
    "kind",
    "leagueId",
  ]),
});

const FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS =
  Object.freeze(Object.keys(DESTINATION_FIELDS));

const FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS =
  deepFreeze({
    fad_cards_opened: {
      messageDataFields: [
        "candidateDeadlineAtMs",
        "cardId",
        "destination",
        "fadId",
        "leagueId",
        "seasonId",
        "teamId",
      ],
      destinationKind: "private_card",
      deduplicationIdentity: [
        "fadId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_cards_opened,
    },
    fad_readiness_blocked: {
      messageDataFields: [
        "destination",
        "errorCodes",
        "leagueId",
        "readinessOperationId",
        "seasonId",
      ],
      destinationKind: "commissioner_fad",
      deduplicationIdentity: [
        "seasonId",
        "readinessOperationId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_readiness_blocked,
    },
    fad_deadline_approaching: {
      messageDataFields: [
        "candidateDeadlineAtMs",
        "cardId",
        "completenessCode",
        "destination",
        "fadId",
        "leagueId",
        "missingMandatoryCount",
        "seasonId",
        "teamId",
      ],
      destinationKind: "private_card",
      deduplicationIdentity: [
        "fadId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_deadline_approaching,
    },
    fad_help_requested: {
      messageDataFields: [
        "cardId",
        "destination",
        "fadId",
        "helpRequestId",
        "leagueId",
        "requestingDisplayName",
        "requestingUserId",
        "seasonId",
        "teamId",
      ],
      destinationKind: "private_card",
      deduplicationIdentity: [
        "fadId",
        "helpRequestId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_help_requested,
    },
    fad_cards_locked: {
      messageDataFields: [
        "destination",
        "fadId",
        "leagueId",
        "seasonId",
      ],
      destinationKind: "fad_results",
      deduplicationIdentity: [
        "fadId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_cards_locked,
    },
    fad_automatic_result: {
      messageDataFields: [
        "automaticWins",
        "destination",
        "fadId",
        "invalidOffers",
        "leagueId",
        "losses",
        "restrictedPending",
        "seasonId",
        "teamId",
      ],
      destinationKind: "fad_results",
      deduplicationIdentity: [
        "fadId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_automatic_result,
    },
    fad_restricted_eligible: {
      messageDataFields: [
        "allocationId",
        "auctionId",
        "destination",
        "fadId",
        "leagueId",
        "playerId",
        "seasonId",
        "teamId",
      ],
      destinationKind: "auction",
      deduplicationIdentity: [
        "fadId",
        "allocationId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_restricted_eligible,
    },
    fad_restricted_fallback_opened: {
      messageDataFields: [
        "allocationId",
        "auctionId",
        "destination",
        "fadId",
        "leagueId",
        "playerId",
        "resolvesAtMs",
        "seasonId",
        "teamId",
      ],
      destinationKind: "auction",
      deduplicationIdentity: [
        "fadId",
        "auctionId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_restricted_fallback_opened,
    },
    fad_rapid_auction_result: {
      messageDataFields: [
        "allocationId",
        "auctionId",
        "destination",
        "fadId",
        "leagueId",
        "outcomeCode",
        "playerId",
        "seasonId",
        "teamId",
      ],
      destinationKind: "auction",
      deduplicationIdentity: [
        "fadId",
        "auctionId",
        "teamId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_rapid_auction_result,
    },
    fad_correction_required: {
      messageDataFields: [
        "allocationId",
        "auctionId",
        "destination",
        "errorCode",
        "fadId",
        "leagueId",
        "playerId",
        "recoveryId",
        "seasonId",
      ],
      destinationKind: "fad_recovery",
      deduplicationIdentity: [
        "fadId",
        "recoveryId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_correction_required,
    },
    fad_week1_recovered: {
      messageDataFields: [
        "competitionFirstMatchupStartsAtMs",
        "destination",
        "fadId",
        "leagueId",
        "scheduleRecoveryOperationId",
        "seasonId",
      ],
      destinationKind: "fad_overview",
      deduplicationIdentity: [
        "fadId",
        "scheduleRecoveryOperationId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_week1_recovered,
    },
    fad_completed: {
      messageDataFields: [
        "completedAtMs",
        "destination",
        "fadId",
        "leagueId",
        "seasonId",
      ],
      destinationKind: "fad_overview",
      deduplicationIdentity: [
        "fadId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_completed,
    },
    fad_setup_exemption_authorized: {
      messageDataFields: [
        "destination",
        "exemptionId",
        "leagueId",
        "seasonId",
      ],
      destinationKind: "commissioner_fad",
      deduplicationIdentity: [
        "leagueId",
        "seasonId",
        "exemptionId",
        "recipientUserId",
      ],
      listCopy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY.fad_setup_exemption_authorized,
    },
  });

const CREATE_DEDUPLICATION_FIELDS = Object.freeze([
  "messageData",
  "recipientUserId",
  "type",
]);
const VALIDATE_DEDUPLICATION_FIELDS = Object.freeze([
  "deduplicationKey",
  "messageData",
  "recipientUserId",
  "type",
]);
const CREATED_CONTRACT_FIELDS = Object.freeze([
  "deduplicationKey",
  "listCopy",
  "messageData",
  "recipientUserId",
  "type",
]);
const SAFE_MACHINE_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,99}$/u;
const CORRECTION_ERROR_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,63}$/u;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const INVALID_UNICODE_SCALAR_PATTERN = /[\ud800-\udfff]/u;
const RAW_LOCATION_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:^|\s)\/(?:api|leagues?|teams?|free-agent-drafts?)\/|[A-Za-z]:\\|\\\\)/iu;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAXIMUM_ERROR_CODES = 100;
const MAXIMUM_DISPLAY_NAME_CODE_POINTS = 50;

class FreeAgentDraftNotificationContractError extends Error {
  constructor(reasonCode) {
    super("The Free Agent Draft notification contract is invalid.");
    this.name = "FreeAgentDraftNotificationContractError";
    this.code =
      FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new FreeAgentDraftNotificationContractError(
    reasonCode
  );
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
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

function requireExactObject(value, fields, reasonCode) {
  if (
    !isPlainObject(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(reasonCode);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    fail(reasonCode);
  }
  for (const field of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      field
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      fail(reasonCode);
    }
  }
}

function requireExactArray(value, reasonCode) {
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(reasonCode);
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    !names.includes("length")
  ) {
    fail(reasonCode);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index)
    );
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      fail(reasonCode);
    }
  }
  return value;
}

function validateFreeAgentDraftNotificationType(value) {
  if (!FREE_AGENT_DRAFT_NOTIFICATION_TYPES.includes(value)) {
    fail("notification_type_invalid");
  }
  return value;
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function nullableStableId(value, reasonCode) {
  if (value === null) return null;
  return stableId(value, reasonCode);
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    fail(reasonCode);
  }
  return value;
}

function nonnegativeInteger(value, reasonCode) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(reasonCode);
  }
  return value;
}

function boundedCount(value, maximum, reasonCode) {
  const count = nonnegativeInteger(value, reasonCode);
  if (count > maximum) fail(reasonCode);
  return count;
}

function safeDisplayName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== value.trim() ||
    Array.from(value).length >
      MAXIMUM_DISPLAY_NAME_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(value) ||
    INVALID_UNICODE_SCALAR_PATTERN.test(value) ||
    RAW_LOCATION_PATTERN.test(value)
  ) {
    fail("requesting_display_name_invalid");
  }
  return value;
}

function safeMachineCode(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !SAFE_MACHINE_CODE_PATTERN.test(value)
  ) {
    fail(reasonCode);
  }
  return value;
}

function errorCodes(value) {
  const source = requireExactArray(
    value,
    "error_codes_invalid"
  );
  if (
    source.length < 1 ||
    source.length > MAXIMUM_ERROR_CODES
  ) {
    fail("error_codes_invalid");
  }
  const result = source.map((code) =>
    safeMachineCode(code, "error_codes_invalid")
  );
  if (new Set(result).size !== result.length) {
    fail("error_codes_invalid");
  }
  return Object.freeze(result);
}

function destination(value, kind, messageData) {
  const fields = DESTINATION_FIELDS[kind];
  requireExactObject(
    value,
    fields,
    "destination_fields_invalid"
  );
  if (value.kind !== kind) {
    fail("destination_kind_invalid");
  }
  const result = { kind };
  for (const field of fields) {
    if (field === "kind") continue;
    const id = stableId(
      value[field],
      "destination_id_invalid"
    );
    if (messageData[field] !== id) {
      fail("destination_identity_mismatch");
    }
    result[field] = id;
  }
  return Object.freeze(result);
}

function commonIds(messageData) {
  return {
    leagueId: stableId(
      messageData.leagueId,
      "league_id_invalid"
    ),
    seasonId: stableId(
      messageData.seasonId,
      "season_id_invalid"
    ),
  };
}

function cardMessageData(messageData, withCompleteness) {
  const result = {
    ...commonIds(messageData),
    fadId: stableId(messageData.fadId, "fad_id_invalid"),
    teamId: stableId(
      messageData.teamId,
      "team_id_invalid"
    ),
    cardId: stableId(
      messageData.cardId,
      "card_id_invalid"
    ),
    candidateDeadlineAtMs: safeTimestamp(
      messageData.candidateDeadlineAtMs,
      "candidate_deadline_invalid"
    ),
  };
  if (withCompleteness) {
    if (
      !FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES.includes(
        messageData.completenessCode
      )
    ) {
      fail("completeness_code_invalid");
    }
    result.completenessCode =
      messageData.completenessCode;
    result.missingMandatoryCount = boundedCount(
      messageData.missingMandatoryCount,
      CANDIDATE_CARD_MANDATORY_SLOT_COUNT,
      "missing_mandatory_count_invalid"
    );
    if (
      result.completenessCode === "complete" &&
      result.missingMandatoryCount !== 0
    ) {
      fail("completeness_summary_invalid");
    }
  }
  return result;
}

function canonicalMessageData(type, messageData) {
  const definition =
    FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS[type];
  requireExactObject(
    messageData,
    definition.messageDataFields,
    "message_data_fields_invalid"
  );
  let result;
  switch (type) {
    case "fad_cards_opened":
      result = cardMessageData(messageData, false);
      break;
    case "fad_readiness_blocked":
      result = {
        ...commonIds(messageData),
        readinessOperationId: stableId(
          messageData.readinessOperationId,
          "readiness_operation_id_invalid"
        ),
        errorCodes: errorCodes(messageData.errorCodes),
      };
      break;
    case "fad_deadline_approaching":
      result = cardMessageData(messageData, true);
      break;
    case "fad_help_requested":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        teamId: stableId(
          messageData.teamId,
          "team_id_invalid"
        ),
        cardId: stableId(
          messageData.cardId,
          "card_id_invalid"
        ),
        helpRequestId: stableId(
          messageData.helpRequestId,
          "help_request_id_invalid"
        ),
        requestingUserId: stableId(
          messageData.requestingUserId,
          "requesting_user_id_invalid"
        ),
        requestingDisplayName: safeDisplayName(
          messageData.requestingDisplayName
        ),
      };
      break;
    case "fad_cards_locked":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
      };
      break;
    case "fad_automatic_result":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        teamId: stableId(
          messageData.teamId,
          "team_id_invalid"
        ),
        automaticWins: boundedCount(
          messageData.automaticWins,
          CANDIDATE_CARD_SLOT_COUNT,
          "automatic_wins_invalid"
        ),
        losses: boundedCount(
          messageData.losses,
          CANDIDATE_CARD_SLOT_COUNT,
          "losses_invalid"
        ),
        restrictedPending: boundedCount(
          messageData.restrictedPending,
          CANDIDATE_CARD_SLOT_COUNT,
          "restricted_pending_invalid"
        ),
        invalidOffers: boundedCount(
          messageData.invalidOffers,
          CANDIDATE_CARD_SLOT_COUNT,
          "invalid_offers_invalid"
        ),
      };
      if (
        result.automaticWins +
          result.losses +
          result.restrictedPending +
          result.invalidOffers >
        CANDIDATE_CARD_SLOT_COUNT
      ) {
        fail("automatic_result_counts_invalid");
      }
      break;
    case "fad_restricted_eligible":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        teamId: stableId(
          messageData.teamId,
          "team_id_invalid"
        ),
        allocationId: stableId(
          messageData.allocationId,
          "allocation_id_invalid"
        ),
        auctionId: stableId(
          messageData.auctionId,
          "auction_id_invalid"
        ),
        playerId: stableId(
          messageData.playerId,
          "player_id_invalid"
        ),
      };
      break;
    case "fad_restricted_fallback_opened":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        teamId: stableId(
          messageData.teamId,
          "team_id_invalid"
        ),
        allocationId: stableId(
          messageData.allocationId,
          "allocation_id_invalid"
        ),
        auctionId: stableId(
          messageData.auctionId,
          "auction_id_invalid"
        ),
        playerId: stableId(
          messageData.playerId,
          "player_id_invalid"
        ),
        resolvesAtMs: safeTimestamp(
          messageData.resolvesAtMs,
          "resolves_at_ms_invalid"
        ),
      };
      break;
    case "fad_rapid_auction_result":
      if (
        !FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES.includes(
          messageData.outcomeCode
        )
      ) {
        fail("outcome_code_invalid");
      }
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        teamId: stableId(
          messageData.teamId,
          "team_id_invalid"
        ),
        allocationId: nullableStableId(
          messageData.allocationId,
          "allocation_id_invalid"
        ),
        auctionId: stableId(
          messageData.auctionId,
          "auction_id_invalid"
        ),
        playerId: stableId(
          messageData.playerId,
          "player_id_invalid"
        ),
        outcomeCode: messageData.outcomeCode,
      };
      break;
    case "fad_correction_required": {
      const allocationId = nullableStableId(
        messageData.allocationId,
        "allocation_id_invalid"
      );
      const auctionId = nullableStableId(
        messageData.auctionId,
        "auction_id_invalid"
      );
      if (allocationId === null && auctionId === null) {
        fail("correction_causality_invalid");
      }
      if (
        typeof messageData.errorCode !== "string" ||
        !CORRECTION_ERROR_CODE_PATTERN.test(
          messageData.errorCode
        )
      ) {
        fail("correction_error_code_invalid");
      }
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        allocationId,
        auctionId,
        recoveryId: stableId(
          messageData.recoveryId,
          "recovery_id_invalid"
        ),
        playerId: stableId(
          messageData.playerId,
          "player_id_invalid"
        ),
        errorCode: messageData.errorCode,
      };
      break;
    }
    case "fad_week1_recovered":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        scheduleRecoveryOperationId: stableId(
          messageData.scheduleRecoveryOperationId,
          "schedule_recovery_operation_id_invalid"
        ),
        competitionFirstMatchupStartsAtMs: safeTimestamp(
          messageData.competitionFirstMatchupStartsAtMs,
          "competition_first_matchup_start_invalid"
        ),
      };
      break;
    case "fad_completed":
      result = {
        ...commonIds(messageData),
        fadId: stableId(
          messageData.fadId,
          "fad_id_invalid"
        ),
        completedAtMs: safeTimestamp(
          messageData.completedAtMs,
          "completed_at_ms_invalid"
        ),
      };
      break;
    case "fad_setup_exemption_authorized":
      result = {
        ...commonIds(messageData),
        exemptionId: stableId(
          messageData.exemptionId,
          "exemption_id_invalid"
        ),
      };
      break;
    default:
      fail("notification_type_invalid");
  }
  result.destination = destination(
    messageData.destination,
    definition.destinationKind,
    result
  );
  return deepFreeze(result);
}

function validateFreeAgentDraftNotificationMessageData(
  type,
  messageData
) {
  const canonicalType =
    validateFreeAgentDraftNotificationType(type);
  return canonicalMessageData(
    canonicalType,
    messageData
  );
}

function canonicalDeduplicationKey(
  type,
  recipientUserId,
  messageData
) {
  switch (type) {
    case "fad_cards_opened":
      return `fad:${messageData.fadId}:cards-opened:${messageData.teamId}:${recipientUserId}`;
    case "fad_readiness_blocked":
      return `fad-readiness:${messageData.seasonId}:blocked:${messageData.readinessOperationId}:${recipientUserId}`;
    case "fad_deadline_approaching":
      return `fad:${messageData.fadId}:deadline-reminder:${messageData.teamId}:${recipientUserId}`;
    case "fad_help_requested":
      return `fad:${messageData.fadId}:help-requested:${messageData.helpRequestId}:${recipientUserId}`;
    case "fad_cards_locked":
      return `fad:${messageData.fadId}:cards-locked:${recipientUserId}`;
    case "fad_automatic_result":
      return `fad:${messageData.fadId}:automatic-result:${messageData.teamId}:${recipientUserId}`;
    case "fad_restricted_eligible":
      return `fad:${messageData.fadId}:restricted-eligible:${messageData.allocationId}:${messageData.teamId}:${recipientUserId}`;
    case "fad_restricted_fallback_opened":
      return `fad:${messageData.fadId}:fallback-opened:${messageData.auctionId}:${messageData.teamId}:${recipientUserId}`;
    case "fad_rapid_auction_result":
      return `fad:${messageData.fadId}:rapid-result:${messageData.auctionId}:${messageData.teamId}:${recipientUserId}`;
    case "fad_correction_required":
      return `fad:${messageData.fadId}:correction-required:${messageData.recoveryId}:${recipientUserId}`;
    case "fad_week1_recovered":
      return `fad:${messageData.fadId}:week1-recovered:${messageData.scheduleRecoveryOperationId}:${recipientUserId}`;
    case "fad_completed":
      return `fad:${messageData.fadId}:completed:${recipientUserId}`;
    case "fad_setup_exemption_authorized":
      return `fad_setup_exemption_authorized:${messageData.leagueId}:${messageData.seasonId}:${messageData.exemptionId}:${recipientUserId}`;
    default:
      fail("notification_type_invalid");
  }
}

function createFreeAgentDraftNotificationDeduplicationKey(
  input = {}
) {
  requireExactObject(
    input,
    CREATE_DEDUPLICATION_FIELDS,
    "deduplication_input_fields_invalid"
  );
  const type = validateFreeAgentDraftNotificationType(
    input.type
  );
  const recipientUserId = stableId(
    input.recipientUserId,
    "recipient_user_id_invalid"
  );
  const messageData =
    validateFreeAgentDraftNotificationMessageData(
      type,
      input.messageData
    );
  return canonicalDeduplicationKey(
    type,
    recipientUserId,
    messageData
  );
}

function validateFreeAgentDraftNotificationDeduplicationKey(
  input = {}
) {
  requireExactObject(
    input,
    VALIDATE_DEDUPLICATION_FIELDS,
    "deduplication_input_fields_invalid"
  );
  const expected =
    createFreeAgentDraftNotificationDeduplicationKey({
      type: input.type,
      recipientUserId: input.recipientUserId,
      messageData: input.messageData,
    });
  if (input.deduplicationKey !== expected) {
    fail("deduplication_key_invalid");
  }
  return expected;
}

function getFreeAgentDraftNotificationListCopy(type) {
  return FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY[
    validateFreeAgentDraftNotificationType(type)
  ];
}

function createFreeAgentDraftNotificationContract(
  input = {}
) {
  requireExactObject(
    input,
    CREATE_DEDUPLICATION_FIELDS,
    "notification_contract_fields_invalid"
  );
  const type = validateFreeAgentDraftNotificationType(
    input.type
  );
  const recipientUserId = stableId(
    input.recipientUserId,
    "recipient_user_id_invalid"
  );
  const messageData =
    validateFreeAgentDraftNotificationMessageData(
      type,
      input.messageData
    );
  return Object.freeze({
    type,
    recipientUserId,
    messageData,
    deduplicationKey: canonicalDeduplicationKey(
      type,
      recipientUserId,
      messageData
    ),
    listCopy:
      FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY[type],
  });
}

function validateFreeAgentDraftNotificationContract(
  input = {}
) {
  requireExactObject(
    input,
    CREATED_CONTRACT_FIELDS,
    "notification_contract_fields_invalid"
  );
  const created = createFreeAgentDraftNotificationContract({
    type: input.type,
    recipientUserId: input.recipientUserId,
    messageData: input.messageData,
  });
  if (
    input.deduplicationKey !==
      created.deduplicationKey ||
    input.listCopy !== created.listCopy
  ) {
    fail("notification_contract_evidence_invalid");
  }
  return created;
}

module.exports = {
  FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES,
  FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID,
  FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS,
  FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS,
  FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY,
  FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES,
  FREE_AGENT_DRAFT_NOTIFICATION_TYPES,
  FreeAgentDraftNotificationContractError,
  createFreeAgentDraftNotificationContract,
  createFreeAgentDraftNotificationDeduplicationKey,
  getFreeAgentDraftNotificationListCopy,
  validateFreeAgentDraftNotificationContract,
  validateFreeAgentDraftNotificationDeduplicationKey,
  validateFreeAgentDraftNotificationMessageData,
  validateFreeAgentDraftNotificationType,
};
