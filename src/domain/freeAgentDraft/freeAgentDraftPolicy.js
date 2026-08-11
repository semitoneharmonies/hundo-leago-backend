const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FREE_AGENT_DRAFT_DAY_MS =
  24 * 60 * 60 * 1000;
const FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT = 7;
const FREE_AGENT_DRAFT_INITIAL_WINDOW_MS =
  FREE_AGENT_DRAFT_DAY_MS *
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT;
const FREE_AGENT_DRAFT_HELP_WINDOW_MS =
  48 * 60 * 60 * 1000;
const FREE_AGENT_DRAFT_REMINDER_LEAD_MS =
  72 * 60 * 60 * 1000;
const FREE_AGENT_DRAFT_CREATION_CUTOFF_MS =
  60 * 60 * 1000;
const FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE =
  "FAD_QUEUED_NOMINATION_ACTIVATION_FAILED";
const MAXIMUM_OCCURRENCE_KEY_LENGTH = 400;

const FREE_AGENT_DRAFT_STATUSES = Object.freeze([
  "cards_open",
  "deadline_locked",
  "allocating",
  "rapid",
  "completed",
]);

const FREE_AGENT_DRAFT_VIEWER_PHASES =
  Object.freeze([
    "inactive",
    "cards_open",
    "help_window",
    "deadline_processing",
    "allocating",
    "rapid",
    "completed",
  ]);

const FREE_AGENT_DRAFT_ROLLOVER_STATUSES =
  Object.freeze([
    "scheduled",
    "processing",
    "completed",
    "recovery_required",
  ]);

const FREE_AGENT_DRAFT_EXTENSION_REASONS =
  Object.freeze([
    "queued_nomination",
    "restricted_auction",
    "fallback_auction",
    "recovery",
  ]);

const FREE_AGENT_DRAFT_CARD_STATUSES =
  Object.freeze([
    "open",
    "locked_complete",
    "locked_incomplete",
    "locked_conflicted",
  ]);

const FREE_AGENT_DRAFT_ALLOCATION_STATUSES =
  Object.freeze([
    "pending",
    "automatic_award",
    "restricted_scheduled",
    "restricted_active",
    "restricted_fallback_open",
    "restricted_resolved",
    "fallback_open_resolved",
    "no_valid_offer",
    "invalid",
    "correction_required",
  ]);

const FREE_AGENT_DRAFT_NOMINATION_STATUSES =
  Object.freeze([
    "queued",
    "opened",
    "invalid",
  ]);

const FREE_AGENT_DRAFT_AUCTION_STATUSES =
  Object.freeze([
    "open",
    "resolving",
    "resolved",
    "no_winner",
    "cancelled",
    "failed",
  ]);

const FREE_AGENT_DRAFT_RECOVERY_STATUSES =
  Object.freeze([
    "pending",
    "ready",
    "running",
    "resolved",
    "correction_required",
  ]);

const FREE_AGENT_DRAFT_POLICY_CODES =
  Object.freeze({
    inputInvalid: "FAD_POLICY_INPUT_INVALID",
    clockInvalid: "FAD_CLOCK_INVALID",
    statusTransitionInvalid:
      "FAD_STATUS_TRANSITION_INVALID",
    nominationWindowUnavailable:
      "FAD_NOMINATION_WINDOW_UNAVAILABLE",
    rolloverSequenceInvalid:
      "FAD_ROLLOVER_SEQUENCE_INVALID",
    extensionInvalid: "FAD_EXTENSION_INVALID",
    occurrenceKeyInvalid:
      "FAD_OCCURRENCE_KEY_INVALID",
  });

const TRANSITIONS_BY_STATUS = Object.freeze({
  cards_open: Object.freeze(["deadline_locked"]),
  deadline_locked: Object.freeze([
    "allocating",
    "rapid",
  ]),
  allocating: Object.freeze(["rapid"]),
  rapid: Object.freeze(["completed"]),
  completed: Object.freeze([]),
});

const TERMINAL_CARD_STATUSES = new Set([
  "locked_complete",
  "locked_incomplete",
  "locked_conflicted",
]);
const TERMINAL_ALLOCATION_STATUSES = new Set([
  "automatic_award",
  "restricted_resolved",
  "fallback_open_resolved",
  "no_valid_offer",
  "invalid",
]);
const TERMINAL_NOMINATION_STATUSES = new Set([
  "opened",
  "invalid",
]);
const TERMINAL_AUCTION_STATUSES = new Set([
  "resolved",
  "no_winner",
  "cancelled",
]);
const EXTENSION_PREDECESSOR_STATUSES = new Set([
  "processing",
  "completed",
  "recovery_required",
]);

class FreeAgentDraftPolicyError extends Error {
  constructor(code, reasonCode) {
    super("The Free Agent Draft lifecycle state is invalid.");
    this.name = "FreeAgentDraftPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_POLICY_CODES.inputInvalid,
    reasonCode
  );
}

function failClock(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_POLICY_CODES.clockInvalid,
    reasonCode
  );
}

function failRollover(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_POLICY_CODES
      .rolloverSequenceInvalid,
    reasonCode
  );
}

function failOccurrence(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_POLICY_CODES
      .occurrenceKeyInvalid,
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

function requireExactObject(
  value,
  keys,
  reject = failInput,
  reasonCode = "input_fields_invalid"
) {
  if (!isPlainObject(value)) {
    reject("input_invalid");
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some(
      (key, index) =>
        key !== expectedKeys[index]
    )
  ) {
    reject(reasonCode);
  }
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

function safeTimestamp(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    reject(reasonCode);
  }
  return value;
}

function safePositiveInteger(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    reject(reasonCode);
  }
  return value;
}

function safeCount(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTimestampAdd(
  value,
  delta,
  reasonCode,
  reject
) {
  const result = value + delta;
  if (
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    reject(reasonCode);
  }
  return result;
}

function stableUuid(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    reject(reasonCode);
  }
  return value;
}

function enumValue(
  value,
  acceptedValues,
  reasonCode,
  reject = failInput
) {
  if (
    typeof value !== "string" ||
    !acceptedValues.includes(value)
  ) {
    reject(reasonCode);
  }
  return value;
}

function validateFreeAgentDraftStatus(value) {
  return enumValue(
    value,
    FREE_AGENT_DRAFT_STATUSES,
    "status_invalid"
  );
}

function validateFreeAgentDraftStatusTransition(
  input = {}
) {
  requireExactObject(input, [
    "fromStatus",
    "toStatus",
  ]);
  const fromStatus =
    input.fromStatus === null
      ? null
      : validateFreeAgentDraftStatus(
          input.fromStatus
        );
  const toStatus = validateFreeAgentDraftStatus(
    input.toStatus
  );
  const accepted =
    fromStatus === null
      ? toStatus === "cards_open"
      : TRANSITIONS_BY_STATUS[
          fromStatus
        ].includes(toStatus);
  if (!accepted) {
    fail(
      FREE_AGENT_DRAFT_POLICY_CODES
        .statusTransitionInvalid,
      fromStatus === "completed"
        ? "completed_status_terminal"
        : "status_transition_invalid"
    );
  }
  return Object.freeze({
    fromStatus,
    toStatus,
  });
}

function buildInitialRolloverClock(
  candidateDeadlineAtMs
) {
  const rollovers = [];
  for (
    let sequence = 1;
    sequence <=
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT;
    sequence += 1
  ) {
    const opensAtMs = safeTimestampAdd(
      candidateDeadlineAtMs,
      (sequence - 1) *
        FREE_AGENT_DRAFT_DAY_MS,
      "rollover_time_overflow",
      failClock
    );
    const rollsOverAtMs = safeTimestampAdd(
      candidateDeadlineAtMs,
      sequence * FREE_AGENT_DRAFT_DAY_MS,
      "rollover_time_overflow",
      failClock
    );
    rollovers.push({
      sequence,
      windowKind: "initial",
      opensAtMs,
      creationCutoffAtMs:
        rollsOverAtMs -
        FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
      rollsOverAtMs,
    });
  }
  return rollovers;
}

function createFreeAgentDraftClock(input = {}) {
  requireExactObject(input, [
    "cardsOpenedAtMs",
    "firstMatchupStartsAtMs",
  ]);
  const cardsOpenedAtMs = safeTimestamp(
    input.cardsOpenedAtMs,
    "cards_opened_at_ms_invalid"
  );
  const firstMatchupStartsAtMs = safeTimestamp(
    input.firstMatchupStartsAtMs,
    "first_matchup_starts_at_ms_invalid"
  );
  const candidateDeadlineAtMs =
    safeTimestampAdd(
      firstMatchupStartsAtMs,
      -FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
      "candidate_deadline_underflow",
      failClock
    );
  if (cardsOpenedAtMs >= candidateDeadlineAtMs) {
    failClock(
      "cards_must_open_before_candidate_deadline"
    );
  }
  const reminderAtMs = safeTimestampAdd(
    candidateDeadlineAtMs,
    -FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
    "reminder_time_underflow",
    failClock
  );
  const normalHelpOpensAtMs =
    candidateDeadlineAtMs -
    FREE_AGENT_DRAFT_HELP_WINDOW_MS;
  const helpOpensAtMs = Math.max(
    cardsOpenedAtMs,
    normalHelpOpensAtMs
  );
  const initialRollovers =
    buildInitialRolloverClock(
      candidateDeadlineAtMs
    );
  if (
    initialRollovers.at(-1).rollsOverAtMs !==
    firstMatchupStartsAtMs
  ) {
    failClock(
      "seventh_rollover_must_equal_first_matchup"
    );
  }
  return deepFreeze({
    cardsOpenedAtMs,
    reminderAtMs,
    helpOpensAtMs,
    candidateDeadlineAtMs,
    firstMatchupStartsAtMs,
    initialRollovers,
  });
}

function validateViewerClock({
  cardsOpenedAtMs,
  helpOpensAtMs,
  candidateDeadlineAtMs,
}) {
  const opened = safeTimestamp(
    cardsOpenedAtMs,
    "cards_opened_at_ms_invalid"
  );
  const help = safeTimestamp(
    helpOpensAtMs,
    "help_opens_at_ms_invalid"
  );
  const deadline = safeTimestamp(
    candidateDeadlineAtMs,
    "candidate_deadline_at_ms_invalid"
  );
  if (opened >= deadline) {
    failClock(
      "cards_must_open_before_candidate_deadline"
    );
  }
  if (
    help !==
    Math.max(
      opened,
      deadline -
        FREE_AGENT_DRAFT_HELP_WINDOW_MS
    )
  ) {
    failClock("help_open_time_invalid");
  }
  return { opened, help, deadline };
}

function deriveFreeAgentDraftViewerPhase(
  input = {}
) {
  requireExactObject(input, [
    "status",
    "nowMs",
    "cardsOpenedAtMs",
    "helpOpensAtMs",
    "candidateDeadlineAtMs",
  ]);
  const nowMs = safeTimestamp(
    input.nowMs,
    "now_ms_invalid"
  );
  if (input.status === null) {
    if (
      input.cardsOpenedAtMs !== null ||
      input.helpOpensAtMs !== null ||
      input.candidateDeadlineAtMs !== null
    ) {
      failClock(
        "inactive_phase_cannot_have_fad_clock"
      );
    }
    return "inactive";
  }

  const status = validateFreeAgentDraftStatus(
    input.status
  );
  const { opened, help, deadline } =
    validateViewerClock(input);
  if (nowMs < opened) {
    failClock("viewer_time_before_cards_opened");
  }

  if (status === "cards_open") {
    if (nowMs >= deadline) {
      return "deadline_processing";
    }
    return nowMs >= help
      ? "help_window"
      : "cards_open";
  }

  if (nowMs < deadline) {
    failClock(
      "post_deadline_status_before_deadline"
    );
  }
  if (
    status === "deadline_locked" ||
    status === "allocating"
  ) {
    return "allocating";
  }
  return status;
}

function validateNominationWindow(input) {
  requireExactObject(input, [
    "acceptedAtMs",
    "opensAtMs",
    "creationCutoffAtMs",
    "rollsOverAtMs",
  ]);
  const acceptedAtMs = safeTimestamp(
    input.acceptedAtMs,
    "accepted_at_ms_invalid"
  );
  const opensAtMs = safeTimestamp(
    input.opensAtMs,
    "opens_at_ms_invalid"
  );
  const creationCutoffAtMs = safeTimestamp(
    input.creationCutoffAtMs,
    "creation_cutoff_at_ms_invalid"
  );
  const rollsOverAtMs = safeTimestamp(
    input.rollsOverAtMs,
    "rolls_over_at_ms_invalid"
  );
  if (
    rollsOverAtMs - opensAtMs !==
      FREE_AGENT_DRAFT_DAY_MS ||
    rollsOverAtMs - creationCutoffAtMs !==
      FREE_AGENT_DRAFT_CREATION_CUTOFF_MS
  ) {
    failClock("nomination_rollover_clock_invalid");
  }
  return {
    acceptedAtMs,
    opensAtMs,
    creationCutoffAtMs,
    rollsOverAtMs,
  };
}

function classifyFreeAgentDraftNominationTiming(
  input = {}
) {
  const {
    acceptedAtMs,
    opensAtMs,
    creationCutoffAtMs,
    rollsOverAtMs,
  } = validateNominationWindow(input);
  if (acceptedAtMs < opensAtMs) {
    fail(
      FREE_AGENT_DRAFT_POLICY_CODES
        .nominationWindowUnavailable,
      "nomination_before_window_open"
    );
  }
  if (acceptedAtMs >= rollsOverAtMs) {
    fail(
      FREE_AGENT_DRAFT_POLICY_CODES
        .nominationWindowUnavailable,
      "nomination_at_or_after_rollover"
    );
  }
  if (acceptedAtMs < creationCutoffAtMs) {
    return Object.freeze({
      disposition: "open_immediately",
      acceptedAtMs,
      auctionOpensAtMs: acceptedAtMs,
      resolutionRolloverAtMs:
        rollsOverAtMs,
      requiresFollowingRollover: false,
    });
  }
  return Object.freeze({
    disposition: "queue_private",
    acceptedAtMs,
    auctionOpensAtMs: rollsOverAtMs,
    resolutionRolloverAtMs:
      safeTimestampAdd(
        rollsOverAtMs,
        FREE_AGENT_DRAFT_DAY_MS,
        "following_rollover_time_overflow",
        failClock
      ),
    requiresFollowingRollover: true,
  });
}

function validateRolloverRow(
  row,
  index,
  candidateDeadlineAtMs,
  previousRow
) {
  requireExactObject(
    row,
    [
      "id",
      "sequence",
      "windowKind",
      "predecessorRolloverId",
      "extensionReason",
      "extensionSourceId",
      "opensAtMs",
      "creationCutoffAtMs",
      "rollsOverAtMs",
      "status",
    ],
    failRollover,
    "rollover_fields_invalid"
  );
  const sequence = safePositiveInteger(
    row.sequence,
    "rollover_sequence_invalid",
    failRollover
  );
  if (
    sequence !== index + 1
  ) {
    failRollover(
      "rollover_sequences_not_contiguous"
    );
  }
  const id = stableUuid(
    row.id,
    "rollover_id_invalid",
    failRollover
  );
  const expectedOpensAtMs =
    safeTimestampAdd(
      candidateDeadlineAtMs,
      (sequence - 1) *
        FREE_AGENT_DRAFT_DAY_MS,
      "rollover_time_overflow",
      failRollover
    );
  const expectedRollsOverAtMs =
    safeTimestampAdd(
      candidateDeadlineAtMs,
      sequence *
        FREE_AGENT_DRAFT_DAY_MS,
      "rollover_time_overflow",
      failRollover
    );
  const opensAtMs = safeTimestamp(
    row.opensAtMs,
    "rollover_opens_at_ms_invalid",
    failRollover
  );
  const creationCutoffAtMs = safeTimestamp(
    row.creationCutoffAtMs,
    "rollover_creation_cutoff_at_ms_invalid",
    failRollover
  );
  const rollsOverAtMs = safeTimestamp(
    row.rollsOverAtMs,
    "rollover_rolls_over_at_ms_invalid",
    failRollover
  );
  if (
    opensAtMs !== expectedOpensAtMs ||
    rollsOverAtMs !==
      expectedRollsOverAtMs ||
    creationCutoffAtMs !==
      rollsOverAtMs -
        FREE_AGENT_DRAFT_CREATION_CUTOFF_MS
  ) {
    failRollover(
      "rollover_clock_not_contiguous"
    );
  }
  const status = enumValue(
    row.status,
    FREE_AGENT_DRAFT_ROLLOVER_STATUSES,
    "rollover_status_invalid",
    failRollover
  );

  let windowKind;
  let predecessorRolloverId;
  let extensionReason;
  let extensionSourceId;
  if (
    sequence <=
    FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
  ) {
    if (
      row.windowKind !== "initial" ||
      row.extensionReason !== null ||
      row.extensionSourceId !== null
    ) {
      failRollover(
        "initial_rollover_shape_invalid"
      );
    }
    windowKind = "initial";
    extensionReason = null;
    extensionSourceId = null;
  } else {
    windowKind = enumValue(
      row.windowKind,
      ["extension"],
      "extension_window_kind_invalid",
      failRollover
    );
    extensionReason = enumValue(
      row.extensionReason,
      FREE_AGENT_DRAFT_EXTENSION_REASONS,
      "extension_reason_invalid",
      failRollover
    );
    extensionSourceId = stableUuid(
      row.extensionSourceId,
      "extension_source_id_invalid",
      failRollover
    );
    if (
      previousRow === null ||
      !EXTENSION_PREDECESSOR_STATUSES.has(
        previousRow.status
      )
    ) {
      failRollover(
        "extension_predecessor_status_invalid"
      );
    }
  }

  if (sequence === 1) {
    if (row.predecessorRolloverId !== null) {
      failRollover(
        "first_rollover_has_predecessor"
      );
    }
    predecessorRolloverId = null;
  } else {
    predecessorRolloverId = stableUuid(
      row.predecessorRolloverId,
      "predecessor_rollover_id_invalid",
      failRollover
    );
    if (
      previousRow === null ||
      predecessorRolloverId !==
        previousRow.id
    ) {
      failRollover(
        "rollover_predecessor_mismatch"
      );
    }
  }

  return {
    id,
    sequence,
    windowKind,
    predecessorRolloverId,
    extensionReason,
    extensionSourceId,
    opensAtMs,
    creationCutoffAtMs,
    rollsOverAtMs,
    status,
  };
}

function validateFreeAgentDraftRolloverSequence(
  input = {}
) {
  requireExactObject(input, [
    "candidateDeadlineAtMs",
    "rollovers",
  ]);
  const candidateDeadlineAtMs = safeTimestamp(
    input.candidateDeadlineAtMs,
    "candidate_deadline_at_ms_invalid",
    failRollover
  );
  if (
    !Array.isArray(input.rollovers) ||
    input.rollovers.length <
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
  ) {
    failRollover(
      "seven_initial_rollovers_required"
    );
  }
  const ids = new Set();
  const rollovers = [];
  for (
    let index = 0;
    index < input.rollovers.length;
    index += 1
  ) {
    const previousRow =
      index === 0
        ? null
        : rollovers[index - 1];
    const row = validateRolloverRow(
      input.rollovers[index],
      index,
      candidateDeadlineAtMs,
      previousRow
    );
    if (ids.has(row.id)) {
      failRollover("rollover_id_duplicate");
    }
    ids.add(row.id);
    rollovers.push(row);
  }
  return deepFreeze(rollovers);
}

function validateExtensionRequirement(value) {
  if (value === null) {
    return null;
  }
  requireExactObject(
    value,
    ["reason", "sourceId"],
    (reasonCode) =>
      fail(
        FREE_AGENT_DRAFT_POLICY_CODES
          .extensionInvalid,
        reasonCode
      ),
    "extension_requirement_fields_invalid"
  );
  return {
    reason: enumValue(
      value.reason,
      FREE_AGENT_DRAFT_EXTENSION_REASONS,
      "extension_reason_invalid",
      (reasonCode) =>
        fail(
          FREE_AGENT_DRAFT_POLICY_CODES
            .extensionInvalid,
          reasonCode
        )
    ),
    sourceId: stableUuid(
      value.sourceId,
      "extension_source_id_invalid",
      (reasonCode) =>
        fail(
          FREE_AGENT_DRAFT_POLICY_CODES
            .extensionInvalid,
          reasonCode
        )
    ),
  };
}

function planNextFreeAgentDraftExtensionRollover(
  input = {}
) {
  requireExactObject(input, [
    "candidateDeadlineAtMs",
    "rollovers",
    "requirement",
  ]);
  const rollovers =
    validateFreeAgentDraftRolloverSequence({
      candidateDeadlineAtMs:
        input.candidateDeadlineAtMs,
      rollovers: input.rollovers,
    });
  const requirement =
    validateExtensionRequirement(
      input.requirement
    );
  if (requirement === null) {
    return deepFreeze({
      required: false,
      reasonCode: "no_fair_window_required",
      rollover: null,
    });
  }

  const predecessor = rollovers.at(-1);
  if (
    !EXTENSION_PREDECESSOR_STATUSES.has(
      predecessor.status
    )
  ) {
    fail(
      FREE_AGENT_DRAFT_POLICY_CODES
        .extensionInvalid,
      "extension_predecessor_status_invalid"
    );
  }
  const sequence = safePositiveInteger(
    predecessor.sequence + 1,
    "extension_sequence_invalid",
    (reasonCode) =>
      fail(
        FREE_AGENT_DRAFT_POLICY_CODES
          .extensionInvalid,
        reasonCode
      )
  );
  const opensAtMs = predecessor.rollsOverAtMs;
  const rollsOverAtMs = safeTimestampAdd(
    opensAtMs,
    FREE_AGENT_DRAFT_DAY_MS,
    "extension_rollover_time_overflow",
    (reasonCode) =>
      fail(
        FREE_AGENT_DRAFT_POLICY_CODES
          .extensionInvalid,
        reasonCode
      )
  );
  return deepFreeze({
    required: true,
    reasonCode: "fair_window_required",
    rollover: {
      sequence,
      windowKind: "extension",
      predecessorRolloverId: predecessor.id,
      extensionReason: requirement.reason,
      extensionSourceId: requirement.sourceId,
      opensAtMs,
      creationCutoffAtMs:
        rollsOverAtMs -
        FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
      rollsOverAtMs,
      status: "scheduled",
    },
  });
}

function validateStatusArray({
  value,
  allowed,
  reasonCode,
  requireOne = false,
}) {
  if (
    !Array.isArray(value) ||
    (requireOne && value.length < 1)
  ) {
    failInput(reasonCode);
  }
  return value.map((status) =>
    enumValue(
      status,
      allowed,
      reasonCode
    )
  );
}

function evaluateFreeAgentDraftCompletionEligibility(
  input = {}
) {
  requireExactObject(input, [
    "status",
    "nowMs",
    "candidateDeadlineAtMs",
    "rollovers",
    "cardStatuses",
    "allocationStatuses",
    "nominationStatuses",
    "auctionStatuses",
    "recoveryStatuses",
    "unaccountedPathCount",
    "quarantinedPlayerCount",
  ]);
  const status = validateFreeAgentDraftStatus(
    input.status
  );
  const nowMs = safeTimestamp(
    input.nowMs,
    "now_ms_invalid"
  );
  const candidateDeadlineAtMs = safeTimestamp(
    input.candidateDeadlineAtMs,
    "candidate_deadline_at_ms_invalid"
  );
  const rollovers =
    validateFreeAgentDraftRolloverSequence({
      candidateDeadlineAtMs,
      rollovers: input.rollovers,
    });
  const cardStatuses = validateStatusArray({
    value: input.cardStatuses,
    allowed:
      FREE_AGENT_DRAFT_CARD_STATUSES,
    reasonCode: "card_statuses_invalid",
    requireOne: true,
  });
  const allocationStatuses =
    validateStatusArray({
      value: input.allocationStatuses,
      allowed:
        FREE_AGENT_DRAFT_ALLOCATION_STATUSES,
      reasonCode:
        "allocation_statuses_invalid",
    });
  const nominationStatuses =
    validateStatusArray({
      value: input.nominationStatuses,
      allowed:
        FREE_AGENT_DRAFT_NOMINATION_STATUSES,
      reasonCode:
        "nomination_statuses_invalid",
    });
  const auctionStatuses = validateStatusArray({
    value: input.auctionStatuses,
    allowed:
      FREE_AGENT_DRAFT_AUCTION_STATUSES,
    reasonCode: "auction_statuses_invalid",
  });
  const recoveryStatuses =
    validateStatusArray({
      value: input.recoveryStatuses,
      allowed:
        FREE_AGENT_DRAFT_RECOVERY_STATUSES,
      reasonCode:
        "recovery_statuses_invalid",
    });
  const unaccountedPathCount = safeCount(
    input.unaccountedPathCount,
    "unaccounted_path_count_invalid"
  );
  const quarantinedPlayerCount = safeCount(
    input.quarantinedPlayerCount,
    "quarantined_player_count_invalid"
  );

  const seventhInitialRolloverAtMs =
    rollovers[
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT -
        1
    ].rollsOverAtMs;
  const latestRolloverAtMs =
    rollovers.at(-1).rollsOverAtMs;
  const reasonCodes = [];
  if (status !== "rapid") {
    reasonCodes.push(
      status === "completed"
        ? "fad_already_completed"
        : "fad_not_rapid"
    );
  }
  if (nowMs < seventhInitialRolloverAtMs) {
    reasonCodes.push(
      "initial_window_not_elapsed"
    );
  }
  if (
    latestRolloverAtMs >
      seventhInitialRolloverAtMs &&
    nowMs < latestRolloverAtMs
  ) {
    reasonCodes.push(
      "latest_rollover_not_elapsed"
    );
  }
  if (
    rollovers.some(
      (rollover) =>
        rollover.status !== "completed"
    )
  ) {
    reasonCodes.push(
      "rollover_not_completed"
    );
  }
  if (
    cardStatuses.some(
      (cardStatus) =>
        !TERMINAL_CARD_STATUSES.has(cardStatus)
    )
  ) {
    reasonCodes.push("card_not_locked");
  }
  if (
    allocationStatuses.some(
      (allocationStatus) =>
        !TERMINAL_ALLOCATION_STATUSES.has(
          allocationStatus
        )
    )
  ) {
    reasonCodes.push(
      "allocation_not_terminal"
    );
  }
  if (
    nominationStatuses.some(
      (nominationStatus) =>
        !TERMINAL_NOMINATION_STATUSES.has(
          nominationStatus
        )
    )
  ) {
    reasonCodes.push(
      "nomination_not_terminal"
    );
  }
  if (
    auctionStatuses.some(
      (auctionStatus) =>
        !TERMINAL_AUCTION_STATUSES.has(
          auctionStatus
        )
    )
  ) {
    reasonCodes.push("auction_not_terminal");
  }
  if (
    recoveryStatuses.some(
      (recoveryStatus) =>
        recoveryStatus !== "resolved"
    )
  ) {
    reasonCodes.push(
      "recovery_not_resolved"
    );
  }
  if (unaccountedPathCount > 0) {
    reasonCodes.push(
      "operational_path_not_accounted"
    );
  }
  if (quarantinedPlayerCount > 0) {
    reasonCodes.push("player_quarantined");
  }

  return deepFreeze({
    eligible: reasonCodes.length === 0,
    evaluatedAtMs: nowMs,
    seventhInitialRolloverAtMs,
    latestRolloverAtMs,
    reasonCodes,
  });
}

function requireOccurrenceInput(value, keys) {
  requireExactObject(
    value,
    keys,
    failOccurrence,
    "occurrence_input_fields_invalid"
  );
}

function occurrenceUuid(value, reasonCode) {
  return stableUuid(
    value,
    reasonCode,
    failOccurrence
  );
}

function occurrenceTimestamp(value, reasonCode) {
  return safeTimestamp(
    value,
    reasonCode,
    failOccurrence
  );
}

function buildFreeAgentDraftReadinessOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "leagueId",
    "seasonId",
    "triggerResourceId",
  ]);
  return [
    "fad-readiness",
    occurrenceUuid(
      input.leagueId,
      "league_id_invalid"
    ),
    occurrenceUuid(
      input.seasonId,
      "season_id_invalid"
    ),
    occurrenceUuid(
      input.triggerResourceId,
      "trigger_resource_id_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftEligibilityOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "playerId",
    "sourceOperationId",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "eligibility-revalidate",
    occurrenceUuid(
      input.playerId,
      "player_id_invalid"
    ),
    occurrenceUuid(
      input.sourceOperationId,
      "source_operation_id_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftReminderOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "reminderAtMs",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "reminder",
    occurrenceTimestamp(
      input.reminderAtMs,
      "reminder_at_ms_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftDeadlineOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "deadlineAtMs",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "deadline",
    occurrenceTimestamp(
      input.deadlineAtMs,
      "deadline_at_ms_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftAllocationOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "playerId",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "allocate",
    occurrenceUuid(
      input.playerId,
      "player_id_invalid"
    ),
  ].join(":");
}

function buildTimedAllocationOccurrenceKey({
  input,
  segment,
}) {
  requireOccurrenceInput(input, [
    "fadId",
    "allocationId",
    "activationAtMs",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    segment,
    occurrenceUuid(
      input.allocationId,
      "allocation_id_invalid"
    ),
    occurrenceTimestamp(
      input.activationAtMs,
      "activation_at_ms_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftRestrictedActivationOccurrenceKey(
  input = {}
) {
  return buildTimedAllocationOccurrenceKey({
    input,
    segment: "restricted-activate",
  });
}

function buildFreeAgentDraftFallbackActivationOccurrenceKey(
  input = {}
) {
  return buildTimedAllocationOccurrenceKey({
    input,
    segment: "fallback-activate",
  });
}

function buildFreeAgentDraftNominationOpenOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "queueId",
    "rolloverAtMs",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "nomination-open",
    occurrenceUuid(
      input.queueId,
      "queue_id_invalid"
    ),
    occurrenceTimestamp(
      input.rolloverAtMs,
      "rollover_at_ms_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftRolloverOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, [
    "fadId",
    "sequence",
    "rolloverAtMs",
  ]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "rollover",
    safePositiveInteger(
      input.sequence,
      "rollover_sequence_invalid",
      failOccurrence
    ),
    occurrenceTimestamp(
      input.rolloverAtMs,
      "rollover_at_ms_invalid"
    ),
  ].join(":");
}

function buildFreeAgentDraftCompletionOccurrenceKey(
  input = {}
) {
  requireOccurrenceInput(input, ["fadId"]);
  return [
    "fad",
    occurrenceUuid(input.fadId, "fad_id_invalid"),
    "complete",
  ].join(":");
}

function parseCanonicalOccurrenceInteger(
  value,
  {
    positive = false,
    reasonCode,
  }
) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    failOccurrence(reasonCode);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (positive ? 1 : 0) ||
    String(parsed) !== value
  ) {
    failOccurrence(reasonCode);
  }
  return parsed;
}

function assertOccurrenceKeyShape(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length >
      MAXIMUM_OCCURRENCE_KEY_LENGTH
  ) {
    failOccurrence("occurrence_key_invalid");
  }
  return value;
}

function parseFreeAgentDraftOccurrenceKey(
  occurrenceKey
) {
  const canonicalKey =
    assertOccurrenceKeyShape(occurrenceKey);
  const parts = canonicalKey.split(":");

  if (
    parts[0] === "fad-readiness" &&
    parts.length === 4
  ) {
    const parsed = {
      type: "readiness",
      leagueId: occurrenceUuid(
        parts[1],
        "league_id_invalid"
      ),
      seasonId: occurrenceUuid(
        parts[2],
        "season_id_invalid"
      ),
      triggerResourceId: occurrenceUuid(
        parts[3],
        "trigger_resource_id_invalid"
      ),
    };
    if (
      buildFreeAgentDraftReadinessOccurrenceKey(
        {
          leagueId: parsed.leagueId,
          seasonId: parsed.seasonId,
          triggerResourceId:
            parsed.triggerResourceId,
        }
      ) !== canonicalKey
    ) {
      failOccurrence(
        "occurrence_key_noncanonical"
      );
    }
    return deepFreeze(parsed);
  }

  if (
    parts[0] !== "fad" ||
    parts.length < 3
  ) {
    failOccurrence(
      "occurrence_key_shape_invalid"
    );
  }
  const fadId = occurrenceUuid(
    parts[1],
    "fad_id_invalid"
  );
  const segment = parts[2];
  let parsed;
  let rebuilt;

  if (
    segment === "eligibility-revalidate" &&
    parts.length === 5
  ) {
    parsed = {
      type: "eligibility_revalidate",
      fadId,
      playerId: occurrenceUuid(
        parts[3],
        "player_id_invalid"
      ),
      sourceOperationId: occurrenceUuid(
        parts[4],
        "source_operation_id_invalid"
      ),
    };
    rebuilt =
      buildFreeAgentDraftEligibilityOccurrenceKey({
        fadId: parsed.fadId,
        playerId: parsed.playerId,
        sourceOperationId:
          parsed.sourceOperationId,
      });
  } else if (
    segment === "reminder" &&
    parts.length === 4
  ) {
    parsed = {
      type: "reminder",
      fadId,
      reminderAtMs:
        parseCanonicalOccurrenceInteger(
          parts[3],
          {
            reasonCode:
              "reminder_at_ms_invalid",
          }
        ),
    };
    rebuilt =
      buildFreeAgentDraftReminderOccurrenceKey({
        fadId,
        reminderAtMs: parsed.reminderAtMs,
      });
  } else if (
    segment === "deadline" &&
    parts.length === 4
  ) {
    parsed = {
      type: "deadline",
      fadId,
      deadlineAtMs:
        parseCanonicalOccurrenceInteger(
          parts[3],
          {
            reasonCode:
              "deadline_at_ms_invalid",
          }
        ),
    };
    rebuilt =
      buildFreeAgentDraftDeadlineOccurrenceKey({
        fadId,
        deadlineAtMs: parsed.deadlineAtMs,
      });
  } else if (
    segment === "allocate" &&
    parts.length === 4
  ) {
    parsed = {
      type: "allocate",
      fadId,
      playerId: occurrenceUuid(
        parts[3],
        "player_id_invalid"
      ),
    };
    rebuilt =
      buildFreeAgentDraftAllocationOccurrenceKey({
        fadId,
        playerId: parsed.playerId,
      });
  } else if (
    (
      segment === "restricted-activate" ||
      segment === "fallback-activate"
    ) &&
    parts.length === 5
  ) {
    parsed = {
      type:
        segment === "restricted-activate"
          ? "restricted_activate"
          : "fallback_activate",
      fadId,
      allocationId: occurrenceUuid(
        parts[3],
        "allocation_id_invalid"
      ),
      activationAtMs:
        parseCanonicalOccurrenceInteger(
          parts[4],
          {
            reasonCode:
              "activation_at_ms_invalid",
          }
        ),
    };
    const build =
      segment === "restricted-activate"
        ? buildFreeAgentDraftRestrictedActivationOccurrenceKey
        : buildFreeAgentDraftFallbackActivationOccurrenceKey;
    rebuilt = build({
      fadId,
      allocationId: parsed.allocationId,
      activationAtMs: parsed.activationAtMs,
    });
  } else if (
    segment === "nomination-open" &&
    parts.length === 5
  ) {
    parsed = {
      type: "nomination_open",
      fadId,
      queueId: occurrenceUuid(
        parts[3],
        "queue_id_invalid"
      ),
      rolloverAtMs:
        parseCanonicalOccurrenceInteger(
          parts[4],
          {
            reasonCode:
              "rollover_at_ms_invalid",
          }
        ),
    };
    rebuilt =
      buildFreeAgentDraftNominationOpenOccurrenceKey({
        fadId,
        queueId: parsed.queueId,
        rolloverAtMs: parsed.rolloverAtMs,
      });
  } else if (
    segment === "rollover" &&
    parts.length === 5
  ) {
    parsed = {
      type: "rollover",
      fadId,
      sequence:
        parseCanonicalOccurrenceInteger(
          parts[3],
          {
            positive: true,
            reasonCode:
              "rollover_sequence_invalid",
          }
        ),
      rolloverAtMs:
        parseCanonicalOccurrenceInteger(
          parts[4],
          {
            reasonCode:
              "rollover_at_ms_invalid",
          }
        ),
    };
    rebuilt =
      buildFreeAgentDraftRolloverOccurrenceKey({
        fadId,
        sequence: parsed.sequence,
        rolloverAtMs: parsed.rolloverAtMs,
      });
  } else if (
    segment === "complete" &&
    parts.length === 3
  ) {
    parsed = {
      type: "complete",
      fadId,
    };
    rebuilt =
      buildFreeAgentDraftCompletionOccurrenceKey({
        fadId,
      });
  } else {
    failOccurrence(
      "occurrence_key_shape_invalid"
    );
  }

  if (rebuilt !== canonicalKey) {
    failOccurrence("occurrence_key_noncanonical");
  }
  return deepFreeze(parsed);
}

module.exports = {
  FREE_AGENT_DRAFT_ALLOCATION_STATUSES,
  FREE_AGENT_DRAFT_AUCTION_STATUSES,
  FREE_AGENT_DRAFT_CARD_STATUSES,
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_EXTENSION_REASONS,
  FREE_AGENT_DRAFT_HELP_WINDOW_MS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
  FREE_AGENT_DRAFT_NOMINATION_STATUSES,
  FREE_AGENT_DRAFT_POLICY_CODES,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
  FREE_AGENT_DRAFT_RECOVERY_STATUSES,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
  FREE_AGENT_DRAFT_ROLLOVER_STATUSES,
  FREE_AGENT_DRAFT_STATUSES,
  FREE_AGENT_DRAFT_VIEWER_PHASES,
  FreeAgentDraftPolicyError,
  UUID_PATTERN,
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftCompletionOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftEligibilityOccurrenceKey,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
  buildFreeAgentDraftReadinessOccurrenceKey,
  buildFreeAgentDraftReminderOccurrenceKey,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
  classifyFreeAgentDraftNominationTiming,
  createFreeAgentDraftClock,
  deriveFreeAgentDraftViewerPhase,
  evaluateFreeAgentDraftCompletionEligibility,
  parseFreeAgentDraftOccurrenceKey,
  planNextFreeAgentDraftExtensionRollover,
  validateFreeAgentDraftRolloverSequence,
  validateFreeAgentDraftStatus,
  validateFreeAgentDraftStatusTransition,
};
