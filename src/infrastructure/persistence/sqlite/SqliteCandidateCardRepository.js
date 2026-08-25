const {
  createHash,
} = require("node:crypto");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  CANDIDATE_CARD_EDITOR_AUTHORITIES,
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS,
  CANDIDATE_CARD_SLOT_KEYS,
  assertCandidateCardSaveAllowed,
  createCandidateCardOfferContract,
  createCandidateCardPartialOfferContract,
  evaluateCandidateCard,
  evaluateCandidateCardHelpAuthority,
  parseCandidateCardSlotKey,
  planCandidateCardCarryoverAction,
  validateCandidateCardCarryover,
} = require(
  "../../../domain/freeAgentDraft/candidateCardPolicy"
);
const {
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
  encodeCandidateEligiblePlayerCursor,
  normalizeCandidateEligiblePlayerName,
  normalizeCandidateEligiblePlayerSearchText,
  normalizeCandidateEligiblePlayerSortName,
} = require(
  "../../../domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);
const {
  createCandidateCardAddPreviewEntryId,
  normalizeCandidateCardRevisionPreviewAction,
} = require(
  "../../../domain/freeAgentDraft/candidateCardRevisionPreviewPolicy"
);
const {
  normalizeCandidateCardExpectedVersion,
  normalizeCandidateCardIdempotencyKey,
  normalizeCandidateCardWholeSave,
} = require(
  "../../../domain/freeAgentDraft/candidateCardMutationPolicy"
);
const {
  normalizeCandidateCardHelpIdempotencyKey,
  normalizeCandidateCardHelpMessage,
} = require(
  "../../../domain/freeAgentDraft/candidateCardHelpPolicy"
);
const {
  deriveFreeAgentDraftViewerPhase,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;
const IDEMPOTENCY_RESULT_TYPE =
  "candidate_card_revision";
const HELP_RESULT_TYPE =
  "candidate_card_help_command_result";
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
const NORMALIZED_CANDIDATE_PLAYER_NAME_SQL_FUNCTION =
  "hundo_candidate_player_name_v1";
const SUMMER_SOURCE_KIND_PATTERN =
  /^[a-z][a-z0-9_]{0,63}$/;

const CANDIDATE_CARD_OPERATIONS =
  Object.freeze({
    add: "candidate_card.add",
    edit: "candidate_card.edit",
    move: "candidate_card.move",
    remove: "candidate_card.remove",
    save: "candidate_card.save",
    help: "candidate_card.help",
  });
const CANDIDATE_CARD_REVISION_ACTIONS_BY_OPERATION =
  Object.freeze({
    "candidate_card.add": Object.freeze([
      "candidate_added",
    ]),
    "candidate_card.edit": Object.freeze([
      "candidate_edited",
    ]),
    "candidate_card.move": Object.freeze([
      "candidate_moved",
      "carryover_moved",
    ]),
    "candidate_card.remove": Object.freeze([
      "candidate_removed",
    ]),
    "candidate_card.save": Object.freeze([
      "candidate_card_saved",
    ]),
    "candidate_card.carryover_sync":
      Object.freeze([
        "carryover_synchronized",
      ]),
  });

const CARD_SCOPE_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "fadId",
  "cardId",
  "teamId",
]);

function invalid(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    reasonCode === undefined
      ? undefined
      : {
          details: {
            reasonCode,
          },
        }
  );
}

function notFound(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    message,
    {
      details: {
        reasonCode,
      },
    }
  );
}

function conflict(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
  );
}

function incompatible(message, reasonCode, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    {
      cause,
      details: {
        reasonCode,
      },
    }
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

function exactObject(value, keys, description) {
  if (!isPlainObject(value)) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
  return value;
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(
      `A positive ${description} is required.`,
      "INTEGER_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function boundedText(
  value,
  maximum,
  description,
  { nullable = false } = {}
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(
      value
    )
  ) {
    invalid(
      `A bounded ${description} is required.`,
      "TEXT_INVALID"
    );
  }
  return value;
}

function safeCode(value, description) {
  if (
    typeof value !== "string" ||
    !SAFE_CODE_PATTERN.test(value)
  ) {
    invalid(
      `A safe ${description} is required.`,
      "CODE_INVALID"
    );
  }
  return value;
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

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map((child) => canonicalJson(child))
      .join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:` +
          canonicalJson(value[key])
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

function sha256Text(value) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function deterministicUuid(value) {
  const hex = sha256Text(value);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function normalizeScope(scope) {
  exactObject(
    scope,
    CARD_SCOPE_KEYS,
    "Candidate Card scope"
  );
  const normalized = {};
  for (const key of CARD_SCOPE_KEYS) {
    normalized[key] = stableId(
      scope[key],
      key
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
    );
  }
  return Object.freeze(normalized);
}

function normalizeActor(actor) {
  exactObject(
    actor,
    [
      "userId",
      "membershipId",
      "authority",
    ],
    "Candidate Card actor"
  );
  const authority = boundedText(
    actor.authority,
    64,
    "Candidate Card actor authority"
  );
  if (
    !CANDIDATE_CARD_EDITOR_AUTHORITIES.includes(
      authority
    )
  ) {
    invalid(
      "A supported Candidate Card actor authority is required.",
      "ACTOR_AUTHORITY_INVALID"
    );
  }
  return Object.freeze({
    userId: stableId(
      actor.userId,
      "actor-user identifier"
    ),
    membershipId: stableId(
      actor.membershipId,
      "actor-membership identifier"
    ),
    authority,
  });
}

function normalizeViewer(viewer) {
  exactObject(
    viewer,
    ["userId", "membershipId"],
    "Candidate Card viewer"
  );
  return Object.freeze({
    userId: stableId(
      viewer.userId,
      "viewer-user identifier"
    ),
    membershipId: stableId(
      viewer.membershipId,
      "viewer-membership identifier"
    ),
  });
}

function normalizeIdempotency(
  idempotency,
  nowMs
) {
  exactObject(
    idempotency,
    [
      "requestId",
      "clientKey",
      "expiresAtMs",
    ],
    "Candidate Card idempotency intent"
  );
  const expiresAtMs = safeTimestamp(
    idempotency.expiresAtMs,
    "idempotency expiry"
  );
  if (expiresAtMs <= nowMs) {
    invalid(
      "Candidate Card idempotency must expire after the command.",
      "IDEMPOTENCY_EXPIRY_INVALID"
    );
  }
  return Object.freeze({
    requestId: stableId(
      idempotency.requestId,
      "idempotency-request identifier"
    ),
    clientKey: boundedText(
      idempotency.clientKey,
      500,
      "idempotency key"
    ),
    expiresAtMs,
  });
}

function normalizeMutationAction(action) {
  if (!isPlainObject(action)) {
    invalid(
      "An exact Candidate Card action is required.",
      "ACTION_INVALID"
    );
  }
  if (action.type === "add") {
    exactObject(
      action,
      [
        "type",
        "entryId",
        "playerId",
        "slotKey",
        "totalValueCents",
        "aavCents",
        "termYears",
      ],
      "Candidate add action"
    );
    const contract =
      createCandidateCardOfferContract({
        aavCents: action.aavCents,
        termYears: action.termYears,
      });
    if (
      action.totalValueCents !==
      contract.totalValueCents
    ) {
      invalid(
        "The Candidate add action total does not match its AAV and term.",
        "ACTION_INVALID"
      );
    }
    const slot = parseCandidateCardSlotKey(
      action.slotKey
    );
    return Object.freeze({
      type: "add",
      entryId: stableId(
        action.entryId,
        "Candidate entry identifier"
      ),
      playerId: stableId(
        action.playerId,
        "Candidate player identifier"
      ),
      slotKey: slot.slotKey,
      totalValueCents:
        contract.totalValueCents,
      termYears: contract.termYears,
      aavCents: contract.aavCents,
    });
  }
  if (action.type === "edit") {
    exactObject(
      action,
      [
        "type",
        "entryId",
        "totalValueCents",
        "aavCents",
        "termYears",
      ],
      "Candidate edit action"
    );
    const contract =
      createCandidateCardOfferContract({
        aavCents: action.aavCents,
        termYears: action.termYears,
      });
    if (
      action.totalValueCents !==
      contract.totalValueCents
    ) {
      invalid(
        "The Candidate edit action total does not match its AAV and term.",
        "ACTION_INVALID"
      );
    }
    return Object.freeze({
      type: "edit",
      entryId: stableId(
        action.entryId,
        "Candidate entry identifier"
      ),
      totalValueCents:
        contract.totalValueCents,
      termYears: contract.termYears,
      aavCents: contract.aavCents,
    });
  }
  if (action.type === "move") {
    exactObject(
      action,
      ["type", "entryId", "slotKey"],
      "Candidate move action"
    );
    return Object.freeze({
      type: "move",
      entryId: stableId(
        action.entryId,
        "Candidate entry identifier"
      ),
      slotKey:
        parseCandidateCardSlotKey(
          action.slotKey
        ).slotKey,
    });
  }
  if (action.type === "remove") {
    exactObject(
      action,
      ["type", "entryId"],
      "Candidate remove action"
    );
    return Object.freeze({
      type: "remove",
      entryId: stableId(
        action.entryId,
        "Candidate entry identifier"
      ),
    });
  }
  invalid(
    "A supported Candidate Card action is required.",
    "ACTION_INVALID"
  );
}

function normalizeMutationCommand(command) {
  exactObject(
    command,
    [
      "scope",
      "actor",
      "expectedCardVersion",
      "nowMs",
      "idempotency",
      "revisionId",
      "action",
    ],
    "Candidate Card mutation command"
  );
  const nowMs = safeTimestamp(
    command.nowMs,
    "Candidate Card mutation timestamp"
  );
  return Object.freeze({
    scope: normalizeScope(command.scope),
    actor: normalizeActor(command.actor),
    expectedCardVersion: positiveInteger(
      command.expectedCardVersion,
      "expected Candidate Card version"
    ),
    nowMs,
    idempotency: normalizeIdempotency(
      command.idempotency,
      nowMs
    ),
    revisionId: stableId(
      command.revisionId,
      "Candidate Card revision identifier"
    ),
    action: normalizeMutationAction(
      command.action
    ),
  });
}

function publicPreviewAction(action) {
  if (action.type !== "add" && action.type !== "edit") {
    return action;
  }
  const { totalValueCents: _derivedTotalValueCents, ...publicAction } = action;
  return Object.freeze(publicAction);
}

function mutationIntentAction(action) {
  if (action.type === "add") {
    return Object.freeze({
      type: action.type,
      playerId: action.playerId,
      slotKey: action.slotKey,
      aavCents: action.aavCents,
      termYears: action.termYears,
    });
  }
  if (action.type === "edit") {
    return Object.freeze({
      type: action.type,
      entryId: action.entryId,
      aavCents: action.aavCents,
      termYears: action.termYears,
    });
  }
  return action;
}

function uniqueRow(
  statement,
  parameters,
  description
) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(
      `${description} was not unique.`,
      "SCOPE_NOT_UNIQUE"
    );
  }
  return rows[0] || null;
}

function slotKey(group, number) {
  return `${group}${String(number).padStart(
    2,
    "0"
  )}`;
}

function mapEntryRow(row) {
  const common = {
    entryId: row.id,
    entryVersion: row.version,
    entryKind: row.entry_kind,
    playerId: row.player_id,
    effectivePositionGroup:
      row.effective_position_group,
    slotKey: slotKey(
      row.requested_slot_group,
      row.requested_slot_number
    ),
    placementState: row.placement_state,
    conflictCode: row.conflict_code,
    createdByUserId:
      row.created_by_user_id,
    createdByMembershipId:
      row.created_by_membership_id,
    createdByAuthority:
      row.created_by_authority,
    lastEditedByUserId:
      row.last_edited_by_user_id,
    lastEditedByMembershipId:
      row.last_edited_by_membership_id,
    lastEditedByAuthority:
      row.last_edited_by_authority,
    lastAcknowledgementRevisionId:
      row.last_acknowledgement_revision_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
  if (row.entry_kind === "carryover") {
    return Object.freeze({
      ...common,
      ownershipId:
        row.carryover_ownership_id,
      contractId:
        row.carryover_contract_id,
      sourceRosterCategory:
        row.source_roster_category,
      contractType:
        row.carryover_contract_type,
      originalTotalValueCents:
        row
          .carryover_original_total_value_cents,
      originalTermYears:
        row
          .carryover_original_term_years,
      aavCents: row.carryover_aav_cents,
      remainingYears: row.remaining_years,
      totalValueCents: null,
      termYears: null,
      eligibilityStatus: null,
      validationCode: null,
    });
  }
  return Object.freeze({
    ...common,
    ownershipId: null,
    contractId: null,
    sourceRosterCategory: null,
    contractType: "normal",
    originalTotalValueCents: null,
    originalTermYears: null,
    aavCents: row.proposed_aav_cents,
    remainingYears: null,
    totalValueCents:
      row.proposed_total_value_cents,
    termYears: row.proposed_term_years,
    eligibilityStatus:
      row.eligibility_status,
    validationCode: row.validation_code,
  });
}

function domainEntry(entry) {
  if (entry.entryKind === "carryover") {
    return {
      entryId: entry.entryId,
      entryKind: "carryover",
      playerId: entry.playerId,
      ownershipId: entry.ownershipId,
      contractId: entry.contractId,
      effectivePositionGroup:
        entry.effectivePositionGroup,
      slotKey: entry.slotKey,
      placementState:
        entry.placementState,
      conflictCode: entry.conflictCode,
      sourceRosterCategory:
        entry.sourceRosterCategory,
      contractType: entry.contractType,
      originalTotalValueCents:
        entry.originalTotalValueCents,
      originalTermYears:
        entry.originalTermYears,
      aavCents: entry.aavCents,
      remainingYears:
        entry.remainingYears,
    };
  }
  return {
    entryId: entry.entryId,
    entryKind: "candidate",
    playerId: entry.playerId,
    effectivePositionGroup:
      entry.effectivePositionGroup,
    slotKey: entry.slotKey,
    placementState: entry.placementState,
    conflictCode: entry.conflictCode,
    aavCents: entry.aavCents,
    totalValueCents:
      entry.totalValueCents,
    termYears: entry.termYears,
    eligibilityStatus:
      entry.eligibilityStatus,
    validationCode: entry.validationCode,
  };
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftSlot =
      CANDIDATE_CARD_SLOT_KEYS.indexOf(
        left.slotKey
      );
    const rightSlot =
      CANDIDATE_CARD_SLOT_KEYS.indexOf(
        right.slotKey
      );
    return (
      leftSlot - rightSlot ||
      left.placementState.localeCompare(
        right.placementState
      ) ||
      left.entryId.localeCompare(right.entryId)
    );
  });
}

function projectionFromEvaluation({
  context,
  evaluation,
  entries,
  cardVersion,
}) {
  return deepFreeze({
    leagueId: context.league_id,
    seasonId: context.season_id,
    fadId: context.fad_id,
    cardId: context.card_id,
    teamId: context.team_id,
    cardVersion,
    phase: context.fad_status,
    lifecycleStatus: context.card_status,
    helpOpensAtMs: context.help_opens_at_ms,
    candidateDeadlineAtMs:
      context.candidate_deadline_at_ms,
    completeness: {
      code: evaluation.completeness.code,
      filledMandatoryCount:
        evaluation.completeness
          .filledMandatory,
      missingMandatoryCount:
        evaluation.completeness
          .missingMandatory,
      filledBenchCount:
        evaluation.completeness.filledBench,
      emptyBenchCount:
        evaluation.completeness.emptyBench,
      blockingValidationCount:
        evaluation.completeness
          .blockingValidationCount,
      structuralConflictCount:
        evaluation.completeness
          .structuralConflictCount,
      carriedRosterStructuralConflictCount:
        evaluation.completeness
          .carriedRosterStructuralConflictCount,
    },
    capProjection:
      evaluation.capProjection,
    capStatus: evaluation.capStatus,
    allocationEligibility:
      evaluation.allocationEligibility,
    allocationExclusionReason:
      evaluation
        .allocationExclusionReason,
    entries: sortEntries(entries),
  });
}

function warningCodes(evaluation) {
  const warnings = new Set();
  if (evaluation.capStatus === "over_cap") {
    warnings.add("CANDIDATE_CARD_OVER_CAP");
  }
  for (const entry of evaluation.entries) {
    if (
      entry.entryKind === "candidate" &&
      entry.eligibilityStatus === "warning"
    ) {
      warnings.add(entry.validationCode);
    }
  }
  return Object.freeze([...warnings].sort());
}

function previewDiagnostics(
  evaluation,
  cardId
) {
  const diagnostics = [];
  if (
    evaluation.completeness
      .carriedRosterStructuralConflictCount > 0
  ) {
    diagnostics.push({
      code:
        "CANDIDATE_CARD_STRUCTURAL_CONFLICT",
      message:
        "The projected Candidate Card has an unresolved carried-roster structural conflict.",
      resourceId: cardId,
    });
  }
  if (evaluation.capStatus === "over_cap") {
    diagnostics.push({
      code: "CANDIDATE_CARD_OVER_CAP",
      message:
        "The projected Candidate Card exceeds the salary cap.",
      resourceId: cardId,
    });
  }
  for (const entry of evaluation.entries) {
    if (
      entry.entryKind === "candidate" &&
      entry.eligibilityStatus === "warning"
    ) {
      diagnostics.push({
        code: entry.validationCode,
        message:
          "The projected Candidate entry requires attention.",
        resourceId: entry.entryId,
      });
    }
  }
  const unique = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${
      diagnostic.resourceId ?? ""
    }`;
    if (!unique.has(key)) {
      unique.set(
        key,
        Object.freeze(diagnostic)
      );
    }
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) => {
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
    })
  );
}

function actionCapability(allowed, reasonCode = null) {
  return Object.freeze({
    allowed,
    reasonCode: allowed ? null : reasonCode,
  });
}

function candidateValidationProjection(entry) {
  if (!entry) {
    return Object.freeze({
      status: "valid",
      codes: Object.freeze([]),
    });
  }
  if (entry.entryKind === "carryover") {
    const codes = entry.conflictCode
      ? Object.freeze([entry.conflictCode])
      : Object.freeze([]);
    return Object.freeze({
      status: entry.conflictCode
        ? "invalid"
        : "valid",
      codes,
    });
  }
  const codes = [
    entry.conflictCode,
    entry.validationCode,
  ].filter(
    (code, index, values) =>
      code !== null &&
      values.indexOf(code) === index
  );
  return Object.freeze({
    status:
      entry.placementState === "conflict"
        ? "invalid"
        : entry.eligibilityStatus,
    codes: Object.freeze(codes),
  });
}

function candidateLastEditorProjection(
  entry,
  evidence
) {
  if (!entry) return null;
  if (entry.lastEditedByAuthority === "system") {
    return Object.freeze({
      userId: null,
      displayName: null,
      authority: "system",
    });
  }
  if (
    entry.lastEditedByUserId === null ||
    evidence.editorDisplayName === null
  ) {
    incompatible(
      "Candidate Card editor evidence is incomplete.",
      "CANDIDATE_CARD_EDITOR_EVIDENCE_INVALID"
    );
  }
  return Object.freeze({
    userId: entry.lastEditedByUserId,
    displayName: evidence.editorDisplayName,
    authority: entry.lastEditedByAuthority,
  });
}

function compatibleEmptyDestinationExists(
  entry,
  evaluation
) {
  if (
    entry.entryKind === "carryover" &&
    (
      entry.placementState !== "placed" ||
      entry.sourceRosterCategory ===
        "Injured Reserve"
    )
  ) {
    return false;
  }
  return evaluation.slots.some((slot) => {
    if (slot.occupantEntryId !== null) {
      return false;
    }
    if (
      slot.slotGroup !== "B" &&
      slot.slotGroup !==
        entry.effectivePositionGroup
    ) {
      return false;
    }
    if (
      slot.slotGroup === "B" &&
      entry.aavCents >
        CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
    ) {
      return false;
    }
    return true;
  });
}

function candidateSlotCapabilities({
  entry,
  evaluation,
  globalDenialReason,
}) {
  if (globalDenialReason !== null) {
    const denied = actionCapability(
      false,
      globalDenialReason
    );
    return Object.freeze({
      addCandidate: denied,
      editCandidate: denied,
      moveCandidate: denied,
      moveCarryover: denied,
      removeCandidate: denied,
    });
  }
  if (!entry) {
    const unavailable = actionCapability(
      false,
      "ENTRY_NOT_EDITABLE"
    );
    return Object.freeze({
      addCandidate: actionCapability(true),
      editCandidate: unavailable,
      moveCandidate: unavailable,
      moveCarryover: unavailable,
      removeCandidate: unavailable,
    });
  }
  if (entry.entryKind === "candidate") {
    return Object.freeze({
      addCandidate: actionCapability(
        false,
        "SLOT_OCCUPIED"
      ),
      editCandidate: actionCapability(true),
      moveCandidate:
        compatibleEmptyDestinationExists(
          entry,
          evaluation
        )
          ? actionCapability(true)
          : actionCapability(
              false,
              "SLOT_OCCUPIED"
            ),
      moveCarryover: actionCapability(
        false,
        "ENTRY_NOT_EDITABLE"
      ),
      removeCandidate: actionCapability(true),
    });
  }
  const canMove =
    compatibleEmptyDestinationExists(
      entry,
      evaluation
    );
  return Object.freeze({
    addCandidate: actionCapability(
      false,
      "SLOT_OCCUPIED"
    ),
    editCandidate: actionCapability(
      false,
      "SLOT_LOCKED"
    ),
    moveCandidate: actionCapability(
      false,
      "ENTRY_NOT_EDITABLE"
    ),
    moveCarryover: canMove
      ? actionCapability(true)
      : actionCapability(
          false,
          entry.placementState !== "placed" ||
          entry.sourceRosterCategory ===
            "Injured Reserve"
            ? "SLOT_LOCKED"
            : "SLOT_OCCUPIED"
        ),
    removeCandidate: actionCapability(
      false,
      "SLOT_LOCKED"
    ),
  });
}

function parseStoredResult(encoded) {
  if (typeof encoded !== "string") {
    incompatible(
      "Candidate Card revision result evidence is missing.",
      "REVISION_RESULT_INVALID"
    );
  }
  let evidence;
  try {
    evidence = JSON.parse(encoded);
  } catch (error) {
    incompatible(
      "Candidate Card revision result evidence is invalid.",
      "REVISION_RESULT_INVALID",
      error
    );
  }
  if (
    !isPlainObject(evidence) ||
    !isPlainObject(evidence.result)
  ) {
    incompatible(
      "Candidate Card revision result evidence is invalid.",
      "REVISION_RESULT_INVALID"
    );
  }
  return deepFreeze(evidence.result);
}

function assertStoredRevisionResult(
  result,
  scope,
  revision,
  operation
) {
  const expectedActions =
    CANDIDATE_CARD_REVISION_ACTIONS_BY_OPERATION[
      operation
    ];
  const wholeSave =
    operation === "candidate_card.save";
  const expectedChangedEntryId =
    operation === "candidate_card.remove"
      ? null
      : revision.affected_entry_id;
  if (
    !isPlainObject(result) ||
    Object.keys(result).sort().join("|") !==
      (wholeSave
        ? "card|changedEntryIds|revisionId"
        : "card|changedEntryId|revisionId") ||
    !expectedActions ||
    !expectedActions.includes(
      revision.action
    ) ||
    result.revisionId !== revision.id ||
    (
      wholeSave
        ? (
            !Array.isArray(
              result.changedEntryIds
            ) ||
            result.changedEntryIds.some(
              (entryId, index, values) =>
                !UUID_PATTERN.test(
                  entryId || ""
                ) ||
                (
                  index > 0 &&
                  values[index - 1] >= entryId
                )
            )
          )
        : result.changedEntryId !==
          expectedChangedEntryId
    ) ||
    !isPlainObject(result.card) ||
    result.card.cardVersion !==
      revision.resulting_card_version ||
    [
      "leagueId",
      "seasonId",
      "fadId",
      "cardId",
      "teamId",
    ].some(
      (key) =>
        result.card[key] !== scope[key]
    )
  ) {
    incompatible(
      "Candidate Card revision result evidence does not match its persisted scope.",
      "REVISION_RESULT_INVALID"
    );
  }
  return result;
}

function createSqliteCandidateCardRepository({
  database,
  capReadRepository,
  writeMutationSideEffects,
  writeHelpGrantSideEffects,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardRepository requires an opened database"
    );
  }
  if (
    typeof writeMutationSideEffects !==
      "function" ||
    typeof writeHelpGrantSideEffects !==
      "function"
  ) {
    throw new TypeError(
      "Candidate Card writes require transactional side-effect writers"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Candidate Card beforeCommit must be a function"
    );
  }

  const capReader =
    capReadRepository === undefined
      ? createSqliteCapReadRepository({
          database,
        })
      : capReadRepository;
  if (
    !capReader ||
    typeof capReader.calculate !== "function"
  ) {
    throw new TypeError(
      "Candidate Card persistence requires a cap-read repository"
    );
  }

  let routeCardScopeStatement;
  let cardContextStatement;
  let entryRowsStatement;
  let privateEntryEvidenceStatement;
  let activeMembershipStatement;
  let managerAssignmentStatement;
  let helpRequestStatement;
  let commissionerAuthorityStatement;
  let administratorAuthorityStatement;
  let commissionerInterventionsStatement;
  let idempotencyStatement;
  let revisionResultStatement;
  let helpCommandResultStatement;
  let createdHelpCommandResultStatement;
  let insertIdempotencyStatement;
  let completeIdempotencyStatement;
  let insertHelpCommandResultStatement;
  let updateCardStatement;
  let insertRevisionStatement;
  let insertCandidateStatement;
  let updateCandidateContractStatement;
  let updateCandidateMoveStatement;
  let updateCarryoverMoveStatement;
  let deleteCandidateStatement;
  let stageWholeCandidateMoveStatement;
  let updateWholeCandidateStatement;
  let insertRevisionEntryChangeStatement;
  let playerEligibilityStatement;
  let playerOwnershipStatement;
  let playerContractStatement;
  let playerProspectExclusionStatement;
  let playerFadQuarantineStatement;
  let eligiblePlayerPageStatement;
  let carryoverOwnershipStatement;
  let updateCarryoverOwnershipStatement;
  let publishedSnapshotStatement;
  let publishedSnapshotEntriesStatement;
  let insertHelpRequestStatement;
  let authoritativeCarryoversStatement;
  let insertCarryoverStatement;
  let updateSynchronizedCarryoverStatement;
  let updateCandidateConflictStatement;
  let deleteStaleCarryoverStatement;
  let insertSystemRevisionStatement;
  let updateSummerCandidateStatement;
  let updateSummerCarryoverStatement;
  let updateSummerCardStatement;

  try {
    database.function(
      NORMALIZED_CANDIDATE_PLAYER_NAME_SQL_FUNCTION,
      { deterministic: true },
      (value) => {
        try {
          return normalizeCandidateEligiblePlayerName(
            value
          );
        } catch (error) {
          return null;
        }
      }
    );
    routeCardScopeStatement = database.prepare(`
      SELECT
        card.league_id,
        card.season_id,
        card.fad_id,
        card.id AS card_id,
        card.team_id
      FROM candidate_cards AS card
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      JOIN free_agent_draft_teams AS participant
        ON participant.league_id = card.league_id
       AND participant.season_id = card.season_id
       AND participant.fad_id = card.fad_id
       AND participant.team_id = card.team_id
      WHERE card.league_id = @leagueId
        AND card.fad_id = @fadId
        AND card.team_id = @teamId
      LIMIT 2
    `);
    cardContextStatement = database.prepare(`
      SELECT
        card.id AS card_id,
        card.league_id,
        card.season_id,
        card.fad_id,
        card.team_id,
        card.status AS card_status,
        card.completeness_code,
        card.filled_mandatory_count,
        card.missing_mandatory_count,
        card.filled_bench_count,
        card.empty_bench_count,
        card.blocking_validation_count,
        card.structural_conflict_count,
        card.carried_roster_structural_conflict_count,
        card.maximum_possible_cap_cents,
        card.cap_status,
        card.allocation_eligibility,
        card.allocation_exclusion_reason,
        card.locked_at_ms,
        card.created_at_ms,
        card.updated_at_ms,
        card.version AS card_version,
        fad.status AS fad_status,
        fad.opened_at_ms,
        fad.help_opens_at_ms,
        fad.candidate_deadline_at_ms,
        league.status AS league_status
      FROM candidate_cards AS card
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      JOIN leagues AS league
        ON league.id = card.league_id
      WHERE card.league_id = @leagueId
        AND card.season_id = @seasonId
        AND card.fad_id = @fadId
        AND card.id = @cardId
        AND card.team_id = @teamId
      LIMIT 2
    `);
    entryRowsStatement = database.prepare(`
      SELECT
        entry.*,
        contract.contract_type
          AS carryover_contract_type
      FROM candidate_card_entries AS entry
      LEFT JOIN contracts AS contract
        ON contract.league_id = entry.league_id
       AND contract.id =
         entry.carryover_contract_id
      WHERE entry.league_id = @leagueId
        AND entry.season_id = @seasonId
        AND entry.fad_id = @fadId
        AND entry.card_id = @cardId
        AND entry.team_id = @teamId
      ORDER BY
        CASE entry.requested_slot_group
          WHEN 'F' THEN 1
          WHEN 'D' THEN 2
          ELSE 3
        END,
        entry.requested_slot_number,
        entry.placement_state,
        entry.id
    `);
    privateEntryEvidenceStatement =
      database.prepare(`
        SELECT
          entry.id AS entry_id,
          player.full_name AS player_full_name,
          editor.display_name
            AS editor_display_name
        FROM candidate_card_entries AS entry
        JOIN players AS player
          ON player.id = entry.player_id
        LEFT JOIN users AS editor
          ON editor.id =
            entry.last_edited_by_user_id
        WHERE entry.league_id = @leagueId
          AND entry.season_id = @seasonId
          AND entry.fad_id = @fadId
          AND entry.card_id = @cardId
          AND entry.team_id = @teamId
        ORDER BY entry.id
      `);
    activeMembershipStatement =
      database.prepare(`
        SELECT
          membership.id,
          user.display_name
        FROM league_memberships AS membership
        JOIN users AS user
          ON user.id = membership.user_id
        WHERE membership.league_id = @leagueId
          AND membership.id = @membershipId
          AND membership.user_id = @userId
          AND membership.status = 'active'
          AND membership.joined_at_ms IS NOT NULL
          AND membership.ended_at_ms IS NULL
          AND user.status = 'active'
        LIMIT 2
      `);
    managerAssignmentStatement =
      database.prepare(`
        SELECT assignment.id
        FROM team_manager_assignments
          AS assignment
        JOIN league_memberships AS membership
          ON membership.league_id =
            assignment.league_id
         AND membership.id =
            assignment.membership_id
         AND membership.user_id =
            assignment.user_id
        JOIN users AS user
          ON user.id = assignment.user_id
        WHERE assignment.league_id = @leagueId
          AND assignment.team_id = @teamId
          AND assignment.user_id = @userId
          AND assignment.membership_id = @membershipId
          AND assignment.status = 'accepted'
          AND assignment.accepted_at_ms IS NOT NULL
          AND assignment.ended_at_ms IS NULL
          AND membership.status = 'active'
          AND membership.joined_at_ms IS NOT NULL
          AND membership.ended_at_ms IS NULL
          AND user.status = 'active'
        LIMIT 2
      `);
    helpRequestStatement = database.prepare(`
      SELECT
        request.*,
        user.display_name
          AS requested_by_display_name
      FROM candidate_card_help_requests
        AS request
      JOIN users AS user
        ON user.id =
          request.requested_by_user_id
      WHERE request.league_id = @leagueId
        AND request.season_id = @seasonId
        AND request.fad_id = @fadId
        AND request.card_id = @cardId
        AND request.team_id = @teamId
      LIMIT 2
    `);
    commissionerAuthorityStatement =
      database.prepare(`
        SELECT membership.id
        FROM leagues AS league
        JOIN league_memberships AS membership
          ON membership.league_id = league.id
         AND membership.id =
           league.commissioner_membership_id
        JOIN users AS user
          ON user.id = membership.user_id
        WHERE league.id = @leagueId
          AND membership.id = @membershipId
          AND membership.user_id = @userId
          AND membership.permission_category =
            'commissioner'
          AND membership.status = 'active'
          AND membership.joined_at_ms IS NOT NULL
          AND membership.ended_at_ms IS NULL
          AND user.status = 'active'
        LIMIT 2
      `);
    administratorAuthorityStatement =
      database.prepare(`
        SELECT role.id
        FROM platform_roles AS role
        JOIN users AS user
          ON user.id = role.user_id
        JOIN league_memberships AS membership
          ON membership.league_id = @leagueId
         AND membership.id = @membershipId
         AND membership.user_id = role.user_id
         AND membership.status = 'active'
         AND membership.joined_at_ms IS NOT NULL
         AND membership.ended_at_ms IS NULL
        WHERE role.user_id = @userId
          AND role.role =
            'platform_administrator'
          AND role.status = 'active'
          AND role.ended_at_ms IS NULL
          AND user.status = 'active'
        LIMIT 2
      `);
    commissionerInterventionsStatement =
      database.prepare(`
        SELECT
          revision.id,
          revision.affected_entry_id,
          revision.action,
          revision.actor_user_id,
          user.display_name,
          revision.actor_authority,
          revision.occurred_at_ms
        FROM candidate_card_revisions
          AS revision
        LEFT JOIN users AS user
          ON user.id = revision.actor_user_id
        WHERE revision.league_id = @leagueId
          AND revision.season_id = @seasonId
          AND revision.fad_id = @fadId
          AND revision.card_id = @cardId
          AND revision.team_id = @teamId
          AND revision.actor_authority IN (
            'commissioner',
            'platform_administrator_as_commissioner'
          )
        ORDER BY
          revision.occurred_at_ms,
          revision.id
      `);
    idempotencyStatement =
      database.prepare(`
        SELECT *
        FROM idempotency_requests
        WHERE league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
        LIMIT 2
      `);
    revisionResultStatement =
      database.prepare(`
        SELECT
          id,
          action,
          affected_entry_id,
          resulting_card_version,
          after_evidence_json
        FROM candidate_card_revisions
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @resultId
        LIMIT 2
      `);
    helpCommandResultStatement =
      database.prepare(`
        SELECT *
        FROM candidate_card_help_command_results
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @resultId
          AND idempotency_request_id =
            @idempotencyRequestId
        LIMIT 2
      `);
    createdHelpCommandResultStatement =
      database.prepare(`
        SELECT *
        FROM candidate_card_help_command_results
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND help_request_id = @helpRequestId
          AND response_http_status = 201
        LIMIT 2
      `);
    insertIdempotencyStatement =
      database.prepare(`
        INSERT INTO idempotency_requests (
          id,
          league_id,
          actor_user_id,
          operation,
          client_key,
          request_hash,
          status,
          result_type,
          result_id,
          created_at_ms,
          completed_at_ms,
          expires_at_ms
        ) VALUES (
          @requestId,
          @leagueId,
          @actorUserId,
          @operation,
          @clientKey,
          @requestHash,
          'started',
          NULL,
          NULL,
          @nowMs,
          NULL,
          @expiresAtMs
        )
      `);
    insertHelpCommandResultStatement =
      database.prepare(`
        INSERT INTO candidate_card_help_command_results (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          help_request_id,
          idempotency_request_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          manager_assignment_id,
          request_sha256,
          requested_by_display_name,
          response_http_status,
          response_json,
          response_sha256,
          created_at_ms,
          version
        ) VALUES (
          @resultId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          @helpRequestId,
          @idempotencyRequestId,
          @actorUserId,
          @actorMembershipId,
          'manager',
          @managerAssignmentId,
          @requestHash,
          @requestedByDisplayName,
          @httpStatus,
          @responseJson,
          @responseSha256,
          @nowMs,
          1
        )
      `);
    completeIdempotencyStatement =
      database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type = @resultType,
            result_id = @resultId,
            completed_at_ms = @nowMs
        WHERE id = @requestId
          AND league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
          AND request_hash = @requestHash
          AND status = 'started'
          AND result_type IS NULL
          AND result_id IS NULL
          AND completed_at_ms IS NULL
      `);
    updateCardStatement = database.prepare(`
      UPDATE candidate_cards
      SET completeness_code =
            @completenessCode,
          filled_mandatory_count =
            @filledMandatoryCount,
          missing_mandatory_count =
            @missingMandatoryCount,
          filled_bench_count =
            @filledBenchCount,
          empty_bench_count =
            @emptyBenchCount,
          blocking_validation_count =
            @blockingValidationCount,
          structural_conflict_count =
            @structuralConflictCount,
          carried_roster_structural_conflict_count =
            @carriedRosterStructuralConflictCount,
          maximum_possible_cap_cents =
            @maximumPossibleCapCents,
          cap_status = @capStatus,
          allocation_eligibility =
            @allocationEligibility,
          allocation_exclusion_reason =
            @allocationExclusionReason,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @cardId
        AND team_id = @teamId
        AND status = 'open'
        AND version = @expectedCardVersion
        AND @nowMs < (
          SELECT candidate_deadline_at_ms
          FROM free_agent_drafts
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND id = @fadId
            AND status = 'cards_open'
        )
    `);
    updateSummerCardStatement = database.prepare(`
      UPDATE candidate_cards
      SET completeness_code = @completenessCode,
          filled_mandatory_count = @filledMandatoryCount,
          missing_mandatory_count = @missingMandatoryCount,
          filled_bench_count = @filledBenchCount,
          empty_bench_count = @emptyBenchCount,
          blocking_validation_count = @blockingValidationCount,
          structural_conflict_count = @structuralConflictCount,
          carried_roster_structural_conflict_count =
            @carriedRosterStructuralConflictCount,
          maximum_possible_cap_cents =
            @maximumPossibleCapCents,
          cap_status = @capStatus,
          allocation_eligibility = @allocationEligibility,
          allocation_exclusion_reason =
            @allocationExclusionReason,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @cardId
        AND team_id = @teamId
        AND status = 'open'
        AND version = @expectedCardVersion
        AND EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND id = @fadId
            AND status = 'cards_open'
        )
    `);
    insertRevisionStatement =
      database.prepare(`
        INSERT INTO candidate_card_revisions (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          resulting_card_version,
          action,
          affected_entry_id,
          player_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          before_evidence_json,
          after_evidence_json,
          potential_illegality_acknowledged,
          warning_codes_json,
          occurred_at_ms,
          created_at_ms,
          version
        ) VALUES (
          @revisionId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          @resultingCardVersion,
          @action,
          @affectedEntryId,
          @playerId,
          @actorUserId,
          @actorMembershipId,
          @actorAuthority,
          @beforeEvidenceJson,
          @afterEvidenceJson,
          @potentialIllegalityAcknowledged,
          @warningCodesJson,
          @nowMs,
          @nowMs,
          1
        )
      `);
    insertCandidateStatement =
      database.prepare(`
        INSERT INTO candidate_card_entries (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          entry_kind,
          player_id,
          effective_position_group,
          requested_slot_group,
          requested_slot_number,
          placement_state,
          conflict_code,
          carryover_ownership_id,
          carryover_contract_id,
          source_roster_category,
          carryover_original_total_value_cents,
          carryover_original_term_years,
          carryover_aav_cents,
          remaining_years,
          proposed_total_value_cents,
          proposed_term_years,
          proposed_aav_cents,
          eligibility_status,
          validation_code,
          last_acknowledgement_revision_id,
          created_by_user_id,
          created_by_membership_id,
          created_by_authority,
          last_edited_by_user_id,
          last_edited_by_membership_id,
          last_edited_by_authority,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @entryId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          'candidate',
          @playerId,
          @effectivePositionGroup,
          @slotGroup,
          @slotNumber,
          'placed',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @totalValueCents,
          @termYears,
          @aavCents,
          @eligibilityStatus,
          @validationCode,
          @acknowledgementRevisionId,
          @actorUserId,
          @actorMembershipId,
          @actorAuthority,
          @actorUserId,
          @actorMembershipId,
          @actorAuthority,
          @nowMs,
          @nowMs,
          1
        )
      `);
    updateCandidateContractStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET effective_position_group =
              @effectivePositionGroup,
            proposed_total_value_cents =
              @totalValueCents,
            proposed_term_years =
              @termYears,
            proposed_aav_cents = @aavCents,
            eligibility_status =
              @eligibilityStatus,
            validation_code = @validationCode,
            last_acknowledgement_revision_id =
              @acknowledgementRevisionId,
            last_edited_by_user_id =
              @actorUserId,
            last_edited_by_membership_id =
              @actorMembershipId,
            last_edited_by_authority =
              @actorAuthority,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    updateCandidateMoveStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET requested_slot_group = @slotGroup,
            requested_slot_number = @slotNumber,
            placement_state = 'placed',
            conflict_code = NULL,
            last_acknowledgement_revision_id =
              @acknowledgementRevisionId,
            last_edited_by_user_id =
              @actorUserId,
            last_edited_by_membership_id =
              @actorMembershipId,
            last_edited_by_authority =
              @actorAuthority,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    updateCarryoverMoveStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET requested_slot_group = @slotGroup,
            requested_slot_number = @slotNumber,
            source_roster_category =
              @targetRosterCategory,
            last_edited_by_user_id =
              @actorUserId,
            last_edited_by_membership_id =
              @actorMembershipId,
            last_edited_by_authority =
              @actorAuthority,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'carryover'
          AND version = @expectedEntryVersion
          AND carryover_ownership_id =
            @ownershipId
          AND carryover_contract_id =
            @contractId
          AND player_id = @playerId
      `);
    deleteCandidateStatement =
      database.prepare(`
        DELETE FROM candidate_card_entries
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    stageWholeCandidateMoveStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET placement_state = 'conflict',
            conflict_code =
              'CANDIDATE_CARD_SAVE_STAGING',
            last_acknowledgement_revision_id = NULL,
            last_edited_by_user_id = @actorUserId,
            last_edited_by_membership_id =
              @actorMembershipId,
            last_edited_by_authority =
              @actorAuthority,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    updateWholeCandidateStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET effective_position_group =
              @effectivePositionGroup,
            requested_slot_group = @slotGroup,
            requested_slot_number = @slotNumber,
            placement_state = 'placed',
            conflict_code = NULL,
            proposed_total_value_cents =
              @totalValueCents,
            proposed_term_years = @termYears,
            proposed_aav_cents = @aavCents,
            eligibility_status =
              @eligibilityStatus,
            validation_code = @validationCode,
            last_acknowledgement_revision_id = NULL,
            last_edited_by_user_id = @actorUserId,
            last_edited_by_membership_id =
              @actorMembershipId,
            last_edited_by_authority =
              @actorAuthority,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    insertRevisionEntryChangeStatement =
      database.prepare(`
        INSERT INTO candidate_card_revision_entry_changes (
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          revision_id,
          entry_id,
          player_id,
          change_kind,
          before_slot_key,
          after_slot_key,
          before_total_value_cents,
          before_term_years,
          after_total_value_cents,
          after_term_years,
          created_at_ms
        ) VALUES (
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          @revisionId,
          @entryId,
          @playerId,
          @changeKind,
          @beforeSlotKey,
          @afterSlotKey,
          @beforeTotalValueCents,
          @beforeTermYears,
          @afterTotalValueCents,
          @afterTermYears,
          @nowMs
        )
      `);
    playerEligibilityStatement =
      database.prepare(`
        SELECT
          player.id,
          player.full_name,
          player.status,
          override.position_group
            AS override_position_group,
          (
            SELECT CASE
              WHEN COUNT(DISTINCT source.normalized_position) = 1
              THEN MIN(source.normalized_position)
              ELSE NULL
            END
            FROM player_source_state AS source
            WHERE source.player_id = player.id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position
                IN ('F', 'D')
          ) AS source_position_group
        FROM players AS player
        LEFT JOIN league_player_positions
          AS override
          ON override.league_id = @leagueId
         AND override.player_id = player.id
         AND override.ended_at_ms IS NULL
        WHERE player.id = @playerId
        LIMIT 2
      `);
    playerOwnershipStatement =
      database.prepare(`
        SELECT id
        FROM player_ownerships
        WHERE league_id = @leagueId
          AND player_id = @playerId
        LIMIT 2
      `);
    playerContractStatement =
      database.prepare(`
        SELECT id
        FROM contracts
        WHERE league_id = @leagueId
          AND player_id = @playerId
          AND status = 'active'
        LIMIT 2
      `);
    playerProspectExclusionStatement =
      database.prepare(`
        SELECT id
        FROM ownership_events
        WHERE league_id = @leagueId
          AND player_id = @playerId
          AND event_type IN (
            'fantasy_elc_declined',
            'unsigned_prospect_rights_released'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM draft_eligible_players
              AS approved_player
            JOIN draft_eligibility_snapshots
              AS approved_snapshot
              ON approved_snapshot.league_id =
                approved_player.league_id
             AND approved_snapshot.id =
                approved_player.eligibility_snapshot_id
            WHERE approved_player.league_id =
                ownership_events.league_id
              AND approved_player.player_id =
                ownership_events.player_id
              AND approved_player.eligibility_reason =
                'rights_release_reentry'
              AND approved_player.rights_release_event_id =
                ownership_events.id
              AND approved_snapshot.status = 'confirmed'
              AND approved_snapshot.confirmed_at_ms >
                ownership_events.occurred_at_ms
          )
        ORDER BY occurred_at_ms DESC, id DESC
        LIMIT 1
      `);
    playerFadQuarantineStatement =
      database.prepare(`
        SELECT quarantine_kind
        FROM (
          SELECT
            'allocation' AS quarantine_kind,
            allocation.updated_at_ms AS evidence_at_ms,
            allocation.id AS evidence_id
          FROM free_agent_draft_player_allocations
            AS allocation
          WHERE allocation.league_id = @leagueId
            AND allocation.player_id = @playerId
            AND allocation.status IN (
              'pending',
              'restricted_scheduled',
              'restricted_active',
              'restricted_fallback_open',
              'correction_required'
            )

          UNION ALL

          SELECT
            'recovery' AS quarantine_kind,
            recovery.updated_at_ms AS evidence_at_ms,
            recovery.id AS evidence_id
          FROM free_agent_draft_recoveries
            AS recovery
          WHERE recovery.league_id = @leagueId
            AND recovery.player_id = @playerId
            AND recovery.status IN (
              'pending',
              'ready',
              'running',
              'correction_required'
            )

          UNION ALL

          SELECT
            'fad_auction' AS quarantine_kind,
            auction.updated_at_ms AS evidence_at_ms,
            auction.id AS evidence_id
          FROM auctions AS auction
          JOIN auction_contexts AS context
            ON context.league_id = auction.league_id
           AND context.season_id = auction.season_id
           AND context.auction_id = auction.id
           AND context.source_kind IN (
             'fad_open_rapid',
             'fad_restricted'
           )
          WHERE auction.league_id = @leagueId
            AND auction.player_id = @playerId
            AND auction.status IN (
              'open',
              'resolving'
            )
        ) AS quarantine
        ORDER BY
          evidence_at_ms DESC,
          evidence_id DESC
        LIMIT 1
      `);
    eligiblePlayerPageStatement =
      database.prepare(`
        WITH effective_players AS (
          SELECT
            player.id AS player_id,
            player.full_name AS player_full_name,
            ${NORMALIZED_CANDIDATE_PLAYER_NAME_SQL_FUNCTION}(
              player.full_name
            ) AS sort_name,
            COALESCE(
              override.position_group,
              (
                SELECT CASE
                  WHEN COUNT(
                    DISTINCT source.normalized_position
                  ) = 1
                  THEN MIN(source.normalized_position)
                  ELSE NULL
                END
                FROM player_source_state AS source
                WHERE source.player_id = player.id
                  AND source.ended_at_ms IS NULL
                  AND source.active = 1
                  AND source.normalized_position
                    IN ('F', 'D')
              )
            ) AS effective_position_group
          FROM players AS player
          LEFT JOIN league_player_positions
            AS override
            ON override.league_id = @leagueId
           AND override.player_id = player.id
           AND override.ended_at_ms IS NULL
          WHERE player.status = 'active'
        )
        SELECT
          eligible.player_id,
          eligible.player_full_name,
          eligible.sort_name,
          eligible.effective_position_group
        FROM effective_players AS eligible
        WHERE eligible.sort_name IS NOT NULL
          AND eligible.effective_position_group
            IN ('F', 'D')
          AND (
            @slotGroup = 'B'
            OR eligible.effective_position_group =
              @slotGroup
          )
          AND (
            @q = ''
            OR instr(eligible.sort_name, @q) > 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM candidate_card_entries AS entry
            WHERE entry.league_id = @leagueId
              AND entry.season_id = @seasonId
              AND entry.fad_id = @fadId
              AND entry.card_id = @cardId
              AND entry.team_id = @teamId
              AND entry.player_id = eligible.player_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM player_ownerships AS ownership
            WHERE ownership.league_id = @leagueId
              AND ownership.player_id =
                eligible.player_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM contracts AS contract
            WHERE contract.league_id = @leagueId
              AND contract.player_id =
                eligible.player_id
              AND contract.status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ownership_events AS event
            WHERE event.league_id = @leagueId
              AND event.player_id = eligible.player_id
              AND event.event_type IN (
                'fantasy_elc_declined',
                'unsigned_prospect_rights_released'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM draft_eligible_players
                  AS approved_player
                JOIN draft_eligibility_snapshots
                  AS approved_snapshot
                  ON approved_snapshot.league_id =
                    approved_player.league_id
                 AND approved_snapshot.id =
                    approved_player.eligibility_snapshot_id
                WHERE approved_player.league_id =
                    event.league_id
                  AND approved_player.player_id =
                    event.player_id
                  AND approved_player.eligibility_reason =
                    'rights_release_reentry'
                  AND approved_player.rights_release_event_id =
                    event.id
                  AND approved_snapshot.status = 'confirmed'
                  AND approved_snapshot.confirmed_at_ms >
                    event.occurred_at_ms
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM free_agent_draft_player_allocations
              AS allocation
            WHERE allocation.league_id = @leagueId
              AND allocation.player_id =
                eligible.player_id
              AND allocation.status IN (
                'pending',
                'restricted_scheduled',
                'restricted_active',
                'restricted_fallback_open',
                'correction_required'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM free_agent_draft_recoveries AS recovery
            WHERE recovery.league_id = @leagueId
              AND recovery.player_id =
                eligible.player_id
              AND recovery.status IN (
                'pending',
                'ready',
                'running',
                'correction_required'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM auctions AS auction
            JOIN auction_contexts AS context
              ON context.league_id = auction.league_id
             AND context.season_id = auction.season_id
             AND context.auction_id = auction.id
            WHERE auction.league_id = @leagueId
              AND auction.player_id =
                eligible.player_id
              AND auction.status IN ('open', 'resolving')
              AND context.source_kind IN (
                'fad_open_rapid',
                'fad_restricted'
              )
          )
          AND (
            @cursorName IS NULL
            OR eligible.sort_name COLLATE BINARY >
              @cursorName COLLATE BINARY
            OR (
              eligible.sort_name COLLATE BINARY =
                @cursorName COLLATE BINARY
              AND eligible.player_id > @cursorPlayerId
            )
          )
        ORDER BY
          eligible.sort_name COLLATE BINARY ASC,
          eligible.player_id ASC
        LIMIT @limitPlusOne
      `);
    carryoverOwnershipStatement =
      database.prepare(`
        SELECT
          ownership.id,
          ownership.version,
          ownership.roster_category,
          ownership.slot_number,
          ownership.position_group,
          contract.id AS contract_id,
          contract.current_team_id,
          contract.status AS contract_status,
          contract.aav_cents,
          COALESCE((
            SELECT SUM(
              retention_year.retained_aav_cents
            )
            FROM retention_obligations AS retention
            JOIN retention_years AS retention_year
              ON retention_year.league_id =
                retention.league_id
             AND retention_year.retention_obligation_id =
                retention.id
            WHERE retention.league_id =
                ownership.league_id
              AND retention.contract_id =
                contract.id
              AND retention.status = 'active'
              AND retention_year.season_id =
                ownership.season_id
              AND retention_year.status = 'current'
          ), 0) AS retained_aav_cents
        FROM player_ownerships AS ownership
        LEFT JOIN contracts AS contract
          ON contract.league_id = ownership.league_id
         AND contract.id = @contractId
         AND contract.player_id = ownership.player_id
        WHERE ownership.league_id = @leagueId
          AND ownership.season_id = @seasonId
          AND ownership.team_id = @teamId
          AND ownership.id = @ownershipId
          AND ownership.player_id = @playerId
          AND ownership.ownership_kind =
            'Rostered'
        LIMIT 2
      `);
    updateCarryoverOwnershipStatement =
      database.prepare(`
        UPDATE player_ownerships
        SET roster_category =
              @targetRosterCategory,
            slot_number = @slotNumber,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE id = @ownershipId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND team_id = @teamId
          AND player_id = @playerId
          AND ownership_kind = 'Rostered'
          AND version = @expectedOwnershipVersion
      `);
    publishedSnapshotStatement =
      database.prepare(`
        SELECT snapshot.*
        FROM candidate_card_snapshots
          AS snapshot
        JOIN candidate_cards AS card
          ON card.league_id =
            snapshot.league_id
         AND card.season_id =
            snapshot.season_id
         AND card.fad_id = snapshot.fad_id
         AND card.id = snapshot.card_id
         AND card.team_id =
            snapshot.team_id
         AND card.status =
            snapshot.locked_status
        JOIN free_agent_drafts AS fad
          ON fad.league_id =
            snapshot.league_id
         AND fad.season_id =
            snapshot.season_id
         AND fad.id = snapshot.fad_id
         AND fad.status IN (
           'deadline_locked',
           'allocating',
           'rapid',
           'completed'
         )
        WHERE snapshot.league_id = @leagueId
          AND snapshot.season_id = @seasonId
          AND snapshot.fad_id = @fadId
          AND snapshot.card_id = @cardId
          AND snapshot.team_id = @teamId
        LIMIT 2
      `);
    publishedSnapshotEntriesStatement =
      database.prepare(`
        SELECT *
        FROM candidate_card_snapshot_entries
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND snapshot_id = @snapshotId
          AND card_id = @cardId
          AND team_id = @teamId
        ORDER BY
          CASE slot_group
            WHEN 'F' THEN 1
            WHEN 'D' THEN 2
            ELSE 3
          END,
          slot_number,
          row_kind,
          id
      `);
    insertHelpRequestStatement =
      database.prepare(`
        INSERT INTO candidate_card_help_requests (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          status,
          message,
          requested_by_user_id,
          requested_by_membership_id,
          requested_at_ms,
          expires_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @helpRequestId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          'active',
          @message,
          @actorUserId,
          @actorMembershipId,
          @nowMs,
          @candidateDeadlineAtMs,
          @nowMs,
          @nowMs,
          1
        )
      `);
    authoritativeCarryoversStatement =
      database.prepare(`
        SELECT
          ownership.id AS ownership_id,
          ownership.player_id,
          ownership.roster_category,
          ownership.position_group,
          ownership.slot_number,
          contract.id AS contract_id,
          contract.current_team_id,
          contract.status AS contract_status,
          contract.contract_type,
          contract.original_total_value_cents,
          contract.original_term_years,
          contract.aav_cents,
          current_year.id AS current_year_id,
          (
            SELECT COUNT(*)
            FROM contract_years AS remaining
            WHERE remaining.league_id =
              ownership.league_id
              AND remaining.contract_id =
                contract.id
              AND remaining.status IN (
                'current',
                'future'
              )
          ) AS remaining_years
        FROM player_ownerships AS ownership
        LEFT JOIN contracts AS contract
          ON contract.league_id =
            ownership.league_id
         AND contract.player_id =
            ownership.player_id
         AND contract.current_team_id =
            ownership.team_id
         AND contract.status = 'active'
        LEFT JOIN contract_years
          AS current_year
          ON current_year.league_id =
            ownership.league_id
         AND current_year.contract_id =
            contract.id
         AND current_year.season_id =
            ownership.season_id
         AND current_year.status = 'current'
        WHERE ownership.league_id = @leagueId
          AND ownership.season_id = @seasonId
          AND ownership.team_id = @teamId
          AND ownership.ownership_kind =
            'Rostered'
          AND ownership.roster_category IN (
            'Active',
            'Bench',
            'Injured Reserve'
          )
        ORDER BY ownership.id
      `);
    insertCarryoverStatement =
      database.prepare(`
        INSERT INTO candidate_card_entries (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          entry_kind,
          player_id,
          effective_position_group,
          requested_slot_group,
          requested_slot_number,
          placement_state,
          conflict_code,
          carryover_ownership_id,
          carryover_contract_id,
          source_roster_category,
          carryover_original_total_value_cents,
          carryover_original_term_years,
          carryover_aav_cents,
          remaining_years,
          proposed_total_value_cents,
          proposed_term_years,
          proposed_aav_cents,
          eligibility_status,
          validation_code,
          last_acknowledgement_revision_id,
          created_by_user_id,
          created_by_membership_id,
          created_by_authority,
          last_edited_by_user_id,
          last_edited_by_membership_id,
          last_edited_by_authority,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @entryId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          'carryover',
          @playerId,
          @effectivePositionGroup,
          @slotGroup,
          @slotNumber,
          @placementState,
          @conflictCode,
          @ownershipId,
          @contractId,
          @sourceRosterCategory,
          @originalTotalValueCents,
          @originalTermYears,
          @aavCents,
          @remainingYears,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'system',
          NULL,
          NULL,
          'system',
          @nowMs,
          @nowMs,
          1
        )
      `);
    updateSynchronizedCarryoverStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET requested_slot_group = @slotGroup,
            requested_slot_number = @slotNumber,
            placement_state =
              @placementState,
            conflict_code = @conflictCode,
            source_roster_category =
              @sourceRosterCategory,
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id =
              NULL,
            last_edited_by_authority =
              'system',
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'carryover'
          AND player_id = @playerId
          AND carryover_ownership_id =
            @ownershipId
          AND carryover_contract_id =
            @contractId
          AND version = @expectedEntryVersion
      `);
    updateCandidateConflictStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET placement_state = 'conflict',
            conflict_code = @conflictCode,
            eligibility_status = 'invalid',
            validation_code = @conflictCode,
            last_acknowledgement_revision_id =
              NULL,
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id =
              NULL,
            last_edited_by_authority =
              'system',
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    deleteStaleCarryoverStatement =
      database.prepare(`
        DELETE FROM candidate_card_entries
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'carryover'
          AND version = @expectedEntryVersion
      `);
    insertSystemRevisionStatement =
      database.prepare(`
        INSERT INTO candidate_card_revisions (
          id,
          league_id,
          season_id,
          fad_id,
          card_id,
          team_id,
          resulting_card_version,
          action,
          affected_entry_id,
          player_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          before_evidence_json,
          after_evidence_json,
          potential_illegality_acknowledged,
          warning_codes_json,
          occurred_at_ms,
          created_at_ms,
          version
        ) VALUES (
          @revisionId,
          @leagueId,
          @seasonId,
          @fadId,
          @cardId,
          @teamId,
          @resultingCardVersion,
          @action,
          NULL,
          NULL,
          NULL,
          NULL,
          'system',
          @beforeEvidenceJson,
          @afterEvidenceJson,
          0,
          @warningCodesJson,
          @nowMs,
          @nowMs,
          1
        )
      `);
    updateSummerCandidateStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET effective_position_group =
              @effectivePositionGroup,
            placement_state = @placementState,
            conflict_code = @conflictCode,
            eligibility_status =
              @eligibilityStatus,
            validation_code = @validationCode,
            last_acknowledgement_revision_id =
              NULL,
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'candidate'
          AND version = @expectedEntryVersion
      `);
    updateSummerCarryoverStatement =
      database.prepare(`
        UPDATE candidate_card_entries
        SET player_id = @playerId,
            effective_position_group =
              @effectivePositionGroup,
            requested_slot_group = @slotGroup,
            requested_slot_number = @slotNumber,
            placement_state = @placementState,
            conflict_code = @conflictCode,
            carryover_contract_id = @contractId,
            source_roster_category =
              @sourceRosterCategory,
            carryover_original_total_value_cents =
              @originalTotalValueCents,
            carryover_original_term_years =
              @originalTermYears,
            carryover_aav_cents = @aavCents,
            remaining_years = @remainingYears,
            last_acknowledgement_revision_id = NULL,
            last_edited_by_user_id = NULL,
            last_edited_by_membership_id = NULL,
            last_edited_by_authority = 'system',
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND card_id = @cardId
          AND team_id = @teamId
          AND id = @entryId
          AND entry_kind = 'carryover'
          AND carryover_ownership_id = @ownershipId
          AND version = @expectedEntryVersion
      `);
  } catch (error) {
    incompatible(
      "The Candidate Card repository requires migrations 0024, 0030, 0034, and 0035.",
      "CANDIDATE_CARD_SCHEMA_REQUIRED",
      error
    );
  }

  function loadContext(scope) {
    return uniqueRow(
      cardContextStatement,
      scope,
      "Candidate Card scope"
    );
  }

  function resolveRouteScope(routeScope) {
    const row = uniqueRow(
      routeCardScopeStatement,
      routeScope,
      "Candidate Card route scope"
    );
    if (!row) return null;
    return Object.freeze({
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      cardId: row.card_id,
      teamId: row.team_id,
    });
  }

  function loadEntries(scope) {
    const rows =
      entryRowsStatement.all(scope);
    const seenIds = new Set();
    const seenPlayers = new Set();
    for (const row of rows) {
      if (
        seenIds.has(row.id) ||
        seenPlayers.has(row.player_id)
      ) {
        incompatible(
          "Candidate Card entries are not unique.",
          "CANDIDATE_CARD_ENTRY_SCOPE_INVALID"
        );
      }
      seenIds.add(row.id);
      seenPlayers.add(row.player_id);
      if (
        row.entry_kind === "carryover" &&
        row.carryover_contract_type === null
      ) {
        incompatible(
          "A Candidate Card carryover is missing its contract.",
          "CARRYOVER_CONTRACT_MISSING"
        );
      }
    }
    return rows.map(mapEntryRow);
  }

  function loadPrivateEntryEvidence(
    scope,
    entries
  ) {
    const rows =
      privateEntryEvidenceStatement.all(scope);
    const evidenceByEntryId = new Map();
    for (const row of rows) {
      if (evidenceByEntryId.has(row.entry_id)) {
        incompatible(
          "Candidate Card private entry evidence was not unique.",
          "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
        );
      }
      evidenceByEntryId.set(
        row.entry_id,
        Object.freeze({
          playerFullName:
            row.player_full_name,
          editorDisplayName:
            row.editor_display_name,
        })
      );
    }
    if (
      evidenceByEntryId.size !== entries.length ||
      entries.some(
        ({ entryId }) =>
          !evidenceByEntryId.has(entryId)
      )
    ) {
      incompatible(
        "Candidate Card private entry evidence is incomplete.",
        "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
      );
    }
    return evidenceByEntryId;
  }

  function projectedPrivateEntryEvidence({
    scope,
    beforeEntries,
    simulation,
    authority,
  }) {
    const evidenceByEntryId = new Map(
      loadPrivateEntryEvidence(
        scope,
        beforeEntries
      )
    );
    if (
      simulation.changedEntryId === null
    ) {
      evidenceByEntryId.delete(
        simulation.affectedEntryId
      );
    } else {
      const previous = evidenceByEntryId.get(
        simulation.changedEntryId
      );
      const playerFullName =
        simulation.playerFullName ??
        previous?.playerFullName ??
        null;
      if (
        typeof playerFullName !== "string" ||
        playerFullName.length < 1 ||
        typeof authority.actorDisplayName !==
          "string" ||
        authority.actorDisplayName.length < 1
      ) {
        incompatible(
          "Candidate Card preview evidence is incomplete.",
          "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
        );
      }
      evidenceByEntryId.set(
        simulation.changedEntryId,
        Object.freeze({
          playerFullName,
          editorDisplayName:
            authority.actorDisplayName,
        })
      );
    }
    if (
      evidenceByEntryId.size !==
        simulation.entries.length ||
      simulation.entries.some(
        ({ entryId }) =>
          !evidenceByEntryId.has(entryId)
      )
    ) {
      incompatible(
        "Candidate Card projected entry evidence is incomplete.",
        "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
      );
    }
    return evidenceByEntryId;
  }

  function projectedWholeSaveEvidence({
    scope,
    beforeEntries,
    simulation,
    authority,
  }) {
    const evidenceByEntryId = new Map(
      loadPrivateEntryEvidence(
        scope,
        beforeEntries
      )
    );
    for (const change of simulation.changes) {
      if (change.changeKind === "remove") {
        evidenceByEntryId.delete(
          change.entryId
        );
        continue;
      }
      const previous = evidenceByEntryId.get(
        change.entryId
      );
      const playerFullName =
        simulation.playerFullNamesByEntryId.get(
          change.entryId
        ) ?? previous?.playerFullName ?? null;
      if (
        typeof playerFullName !== "string" ||
        playerFullName.length < 1 ||
        typeof authority.actorDisplayName !==
          "string" ||
        authority.actorDisplayName.length < 1
      ) {
        incompatible(
          "Candidate Card whole-save evidence is incomplete.",
          "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
        );
      }
      evidenceByEntryId.set(
        change.entryId,
        Object.freeze({
          playerFullName,
          editorDisplayName:
            authority.actorDisplayName,
        })
      );
    }
    if (
      evidenceByEntryId.size !==
        simulation.entries.length ||
      simulation.entries.some(
        ({ entryId }) =>
          !evidenceByEntryId.has(entryId)
      )
    ) {
      incompatible(
        "Candidate Card projected whole-save evidence is incomplete.",
        "CANDIDATE_CARD_ENTRY_EVIDENCE_INVALID"
      );
    }
    return evidenceByEntryId;
  }

  function calculateEvaluation(
    scope,
    entries,
    {
      activePlayerAdjustmentCents = 0,
    } = {}
  ) {
    const cap = capReader.calculate({
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      teamId: scope.teamId,
    });
    if (!cap.complete) {
      conflict(
        "Candidate Card cap evidence is incomplete.",
        "CANDIDATE_CAP_STATE_INCOMPLETE",
        {
          issueCodes: cap.issues.map(
            ({ code }) => code
          ),
        }
      );
    }
    const carriedActivePlayerAmountCents =
      cap.breakdown.activePlayerCents +
      activePlayerAdjustmentCents;
    if (
      !Number.isSafeInteger(
        activePlayerAdjustmentCents
      ) ||
      !Number.isSafeInteger(
        carriedActivePlayerAmountCents
      ) ||
      carriedActivePlayerAmountCents < 0
    ) {
      incompatible(
        "Candidate Card projected cap evidence is invalid.",
        "CANDIDATE_CAP_PROJECTION_INVALID"
      );
    }
    return evaluateCandidateCard({
      capLimitCents: cap.capLimitCents,
      carriedActivePlayerAmountCents:
        carriedActivePlayerAmountCents,
      retentionObligationCents:
        cap.breakdown.retentionCents,
      buyoutPenaltyCents:
        cap.breakdown.buyoutCents,
      entries: entries.map(domainEntry),
    });
  }

  function assertSummaryMatches(
    context,
    evaluation
  ) {
    const expected = {
      completeness_code:
        evaluation.completeness.code,
      filled_mandatory_count:
        evaluation.completeness
          .filledMandatory,
      missing_mandatory_count:
        evaluation.completeness
          .missingMandatory,
      filled_bench_count:
        evaluation.completeness.filledBench,
      empty_bench_count:
        evaluation.completeness.emptyBench,
      blocking_validation_count:
        evaluation.completeness
          .blockingValidationCount,
      structural_conflict_count:
        evaluation.completeness
          .structuralConflictCount,
      carried_roster_structural_conflict_count:
        evaluation.completeness
          .carriedRosterStructuralConflictCount,
      maximum_possible_cap_cents:
        evaluation.capProjection
          .maximumPossibleCapCents,
      cap_status: evaluation.capStatus,
      allocation_eligibility:
        evaluation.allocationEligibility,
      allocation_exclusion_reason:
        evaluation
          .allocationExclusionReason,
    };
    for (const [key, value] of Object.entries(
      expected
    )) {
      if (context[key] !== value) {
        incompatible(
          "Candidate Card summary does not match its current entries and cap evidence.",
          "CANDIDATE_CARD_SUMMARY_DRIFT"
        );
      }
    }
  }

  function loadAggregate(
    scope,
    {
      requireSummaryMatch = true,
    } = {}
  ) {
    const context = loadContext(scope);
    if (!context) return null;
    const entries = loadEntries(scope);
    const evaluation =
      calculateEvaluation(scope, entries);
    if (requireSummaryMatch) {
      assertSummaryMatches(
        context,
        evaluation
      );
    }
    return Object.freeze({
      context,
      entries: Object.freeze(entries),
      evaluation,
      card: projectionFromEvaluation({
        context,
        evaluation,
        entries,
        cardVersion:
          context.card_version,
      }),
    });
  }

  function membership(scope, actor) {
    return uniqueRow(
      activeMembershipStatement,
      {
        leagueId: scope.leagueId,
        membershipId:
          actor.membershipId,
        userId: actor.userId,
      },
      "Candidate Card membership"
    );
  }

  function managerAssignment(
    scope,
    actor
  ) {
    return uniqueRow(
      managerAssignmentStatement,
      {
        leagueId: scope.leagueId,
        teamId: scope.teamId,
        membershipId:
          actor.membershipId,
        userId: actor.userId,
      },
      "Candidate Card manager assignment"
    );
  }

  function currentHelp(scope) {
    return uniqueRow(
      helpRequestStatement,
      scope,
      "Candidate Card help request"
    );
  }

  function commissionerAuthority(
    scope,
    actor
  ) {
    if (
      actor.authority === "manager"
    ) {
      return null;
    }
    const statement =
      actor.authority ===
      "platform_administrator_as_commissioner"
        ? administratorAuthorityStatement
        : commissionerAuthorityStatement;
    return uniqueRow(
      statement,
      {
        leagueId: scope.leagueId,
        membershipId:
          actor.membershipId,
        userId: actor.userId,
      },
      "Candidate Card commissioner authority"
    );
  }

  function privateAuthority({
    scope,
    actor,
    context,
    nowMs,
  }) {
    const activeMembership =
      membership(scope, actor);
    const assignment =
      managerAssignment(scope, actor);
    const help = currentHelp(scope);
    const currentCommissioner =
      commissionerAuthority(scope, actor);
    const authorityBacked =
      actor.authority === "manager"
        ? assignment !== null
        : currentCommissioner !== null;
    const activeHelp =
      help !== null &&
      help.status === "active" &&
      nowMs >= context.help_opens_at_ms &&
      nowMs < help.expires_at_ms;
    const decision =
      evaluateCandidateCardHelpAuthority({
        actorAuthority: actor.authority,
        activeLeagueMembership:
          activeMembership !== null,
        currentTeamManager:
          assignment !== null &&
          authorityBacked,
        currentCommissionerAuthority:
          currentCommissioner !== null &&
          authorityBacked,
        activeHelpRequest: activeHelp,
        nowMs,
        helpOpensAtMs:
          context.help_opens_at_ms,
        candidateDeadlineAtMs:
          context.candidate_deadline_at_ms,
      });
    if (!decision.canReadPrivateCard) {
      return null;
    }
    if (
      decision.accessSource ===
      "manager_assignment"
    ) {
      return Object.freeze({
        accessReason: "team_manager",
        authorizationEvidence: Object.freeze({
          kind: "manager_assignment",
          id: assignment.id,
        }),
        actorDisplayName:
          activeMembership.display_name,
        decision,
        help,
      });
    }
    return Object.freeze({
      accessReason:
        actor.authority === "commissioner"
          ? "help_grant_commissioner"
          : "help_grant_platform_administrator",
      authorizationEvidence: Object.freeze({
        kind: "help_request",
        id: help.id,
      }),
      actorDisplayName:
        activeMembership.display_name,
      decision,
      help,
    });
  }

  function interventionRows(scope) {
    return commissionerInterventionsStatement
      .all(scope)
      .map((row) =>
        Object.freeze({
          revisionId: row.id,
          entryId:
            row.affected_entry_id,
          action: row.action,
          actorUserId:
            row.actor_user_id,
          actorDisplayName:
            row.display_name,
          authority:
            row.actor_authority,
          occurredAtMs:
            row.occurred_at_ms,
        })
      );
  }

  function projectedInterventionRows({
    scope,
    command,
    simulation,
    authority,
  }) {
    const interventions = [
      ...interventionRows(scope),
    ];
    if (
      command.actor.authority !==
      "manager"
    ) {
      interventions.push(
        Object.freeze({
          revisionId:
            command.revisionId,
          entryId:
            simulation.affectedEntryId,
          action: simulation.actionName,
          actorUserId:
            command.actor.userId,
          actorDisplayName:
            authority.actorDisplayName,
          authority:
            command.actor.authority,
          occurredAtMs: command.nowMs,
        })
      );
    }
    interventions.sort(
      (left, right) =>
        left.occurredAtMs -
          right.occurredAtMs ||
        left.revisionId.localeCompare(
          right.revisionId
        )
    );
    return Object.freeze(interventions);
  }

  function privateHelpProjection(help) {
    if (!help) return null;
    return Object.freeze({
      helpRequestId: help.id,
      status: help.status,
      message: help.message,
      requestedByUserId:
        help.requested_by_user_id,
      requestedByDisplayName:
        help.requested_by_display_name,
      requestedAtMs:
        help.requested_at_ms,
      expiresAtMs: help.expires_at_ms,
      version: help.version,
    });
  }

  function routeViewerActor(scope, viewer) {
    if (!membership(scope, viewer)) {
      return null;
    }
    const managerActor = Object.freeze({
      ...viewer,
      authority: "manager",
    });
    if (managerAssignment(scope, managerActor)) {
      return managerActor;
    }
    const commissionerActor = Object.freeze({
      ...viewer,
      authority: "commissioner",
    });
    if (
      commissionerAuthority(
        scope,
        commissionerActor
      )
    ) {
      return commissionerActor;
    }
    const administratorActor = Object.freeze({
      ...viewer,
      authority:
        "platform_administrator_as_commissioner",
    });
    if (
      commissionerAuthority(
        scope,
        administratorActor
      )
    ) {
      return administratorActor;
    }
    return null;
  }

  function exactPrivateHelpProjection(
    help,
    nowMs
  ) {
    if (!help) return null;
    return Object.freeze({
      helpRequestId: help.id,
      status:
        help.status === "expired" ||
        nowMs >= help.expires_at_ms
          ? "expired"
          : "active",
      message: help.message,
      requestedByUserId:
        help.requested_by_user_id,
      requestedByDisplayName:
        help.requested_by_display_name,
      requestedAtMs: help.requested_at_ms,
      expiresAtMs: help.expires_at_ms,
    });
  }

  function privateMutationDenialReason({
    context,
    authority,
    nowMs,
  }) {
    if (
      nowMs >=
      context.candidate_deadline_at_ms
    ) {
      return "DEADLINE_PASSED";
    }
    if (
      context.league_status === "frozen" &&
      authority.accessReason ===
        "team_manager"
    ) {
      return "LEAGUE_FROZEN";
    }
    if (
      context.fad_status !== "cards_open" ||
      context.card_status !== "open" ||
      (context.league_status !== "active" &&
        !(
          context.league_status ===
            "frozen" &&
          authority.accessReason !==
            "team_manager"
        ))
    ) {
      return "PHASE_CLOSED";
    }
    if (
      !authority.decision
        .canEditCandidateEntries
    ) {
      return "NOT_AUTHORIZED";
    }
    return null;
  }

  function privatePlayerProjection(
    entry,
    evidence
  ) {
    if (
      typeof evidence.playerFullName !==
        "string" ||
      evidence.playerFullName.length < 1
    ) {
      incompatible(
        "Candidate Card player evidence is incomplete.",
        "CANDIDATE_CARD_PLAYER_EVIDENCE_INVALID"
      );
    }
    return Object.freeze({
      playerId: entry.playerId,
      fullName: evidence.playerFullName,
      positionGroup:
        entry.effectivePositionGroup,
    });
  }

  function privateSlotProjection({
    slot,
    entry,
    evidence,
    evaluation,
    globalDenialReason,
  }) {
    if (!entry) {
      return Object.freeze({
        slotKey: slot.slotKey,
        slotGroup: slot.slotGroup,
        required: slot.mandatory,
        occupantKind: "empty",
        entryId: null,
        entryVersion: null,
        player: null,
        authoritativeRosterCategory: null,
        locked: false,
        totalValueCents: null,
        termYears: null,
        aavCents: null,
        remainingYears: null,
        validation:
          candidateValidationProjection(null),
        outcome: null,
        lastEditedAtMs: null,
        lastEditedBy: null,
        capabilities:
          candidateSlotCapabilities({
            entry: null,
            evaluation,
            globalDenialReason,
          }),
      });
    }
    const carryover =
      entry.entryKind === "carryover";
    return Object.freeze({
      slotKey: slot.slotKey,
      slotGroup: slot.slotGroup,
      required: slot.mandatory,
      occupantKind: entry.entryKind,
      entryId: entry.entryId,
      entryVersion: entry.entryVersion,
      player: privatePlayerProjection(
        entry,
        evidence
      ),
      authoritativeRosterCategory: carryover
        ? entry.sourceRosterCategory
        : null,
      locked: carryover,
      totalValueCents: carryover
        ? entry.originalTotalValueCents
        : entry.totalValueCents,
      termYears: carryover
        ? entry.originalTermYears
        : entry.termYears,
      aavCents: entry.aavCents,
      remainingYears: carryover
        ? entry.remainingYears
        : null,
      validation:
        candidateValidationProjection(entry),
      outcome: null,
      lastEditedAtMs: entry.updatedAtMs,
      lastEditedBy:
        candidateLastEditorProjection(
          entry,
          evidence
        ),
      capabilities: candidateSlotCapabilities({
        entry,
        evaluation,
        globalDenialReason,
      }),
    });
  }

  function exactPrivateProjection({
    aggregate,
    authority,
    nowMs,
    evidenceByEntryId,
    scope,
    cardVersion = aggregate.context
      .card_version,
    capabilityDenialReason,
    commissionerInterventions,
  }) {
    const { context, entries, evaluation } =
      aggregate;
    const phase =
      deriveFreeAgentDraftViewerPhase({
        status: context.fad_status,
        nowMs,
        cardsOpenedAtMs:
          context.opened_at_ms,
        helpOpensAtMs:
          context.help_opens_at_ms,
        candidateDeadlineAtMs:
          context.candidate_deadline_at_ms,
      });
    const globalDenialReason =
      capabilityDenialReason === undefined
        ? privateMutationDenialReason({
            context,
            authority,
            nowMs,
          })
        : capabilityDenialReason;
    const entriesById = new Map(
      entries.map((entry) => [
        entry.entryId,
        entry,
      ])
    );
    const slots = evaluation.slots.map((slot) => {
      const entry =
        slot.occupantEntryId === null
          ? null
          : entriesById.get(
              slot.occupantEntryId
            );
      if (
        slot.occupantEntryId !== null &&
        !entry
      ) {
        incompatible(
          "Candidate Card slot evidence is incomplete.",
          "CANDIDATE_CARD_SLOT_EVIDENCE_INVALID"
        );
      }
      return privateSlotProjection({
        slot,
        entry,
        evidence: entry
          ? evidenceByEntryId.get(
              entry.entryId
            )
          : null,
        evaluation,
        globalDenialReason,
      });
    });
    const conflicts = entries
      .filter(
        ({ placementState }) =>
          placementState === "conflict"
      )
      .map((entry) => {
        const evidence =
          evidenceByEntryId.get(entry.entryId);
        return Object.freeze({
          entryId: entry.entryId,
          entryVersion: entry.entryVersion,
          player: privatePlayerProjection(
            entry,
            evidence
          ),
          intendedSlotKey: entry.slotKey,
          conflictCode: entry.conflictCode,
          validation:
            candidateValidationProjection(entry),
          lastEditedBy:
            candidateLastEditorProjection(
              entry,
              evidence
            ),
        });
      });
    const managerAccess =
      authority.accessReason === "team_manager";
    const requestHelp =
      globalDenialReason !== null
        ? actionCapability(
            false,
            globalDenialReason
          )
        : !managerAccess
          ? actionCapability(
              false,
              "NOT_AUTHORIZED"
            )
          : authority.decision.canRequestHelp
            ? actionCapability(true)
            : actionCapability(
                false,
                "PHASE_CLOSED"
              );
    return deepFreeze({
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      fadId: scope.fadId,
      teamId: scope.teamId,
      cardId: scope.cardId,
      cardVersion,
      phase,
      visibilityMode:
        globalDenialReason === null
          ? "private_editable"
          : "private_read_only",
      accessReason: authority.accessReason,
      authorizationEvidence:
        authority.authorizationEvidence,
      lifecycleStatus: context.card_status,
      completeness: {
        code: evaluation.completeness.code,
        filledMandatoryCount:
          evaluation.completeness
            .filledMandatory,
        missingMandatoryCount:
          evaluation.completeness
            .missingMandatory,
        filledBenchCount:
          evaluation.completeness.filledBench,
        emptyBenchCount:
          evaluation.completeness.emptyBench,
        blockingValidationCount:
          evaluation.completeness
            .blockingValidationCount,
        structuralConflictCount:
          evaluation.completeness
            .structuralConflictCount,
        carriedRosterStructuralConflictCount:
          evaluation.completeness
            .carriedRosterStructuralConflictCount,
      },
      capProjection: evaluation.capProjection,
      capStatus: evaluation.capStatus,
      allocationEligibility:
        evaluation.allocationEligibility,
      allocationExclusionReason:
        evaluation.allocationExclusionReason,
      slots,
      conflicts,
      helpContext: exactPrivateHelpProjection(
        authority.help,
        nowMs
      ),
      commissionerInterventions:
        commissionerInterventions ??
        interventionRows(scope),
      capabilities: {
        editCard:
          globalDenialReason === null
            ? actionCapability(true)
            : actionCapability(
                false,
                globalDenialReason
              ),
        requestHelp,
        viewPublishedHistory:
          actionCapability(
            false,
            capabilityDenialReason ===
              undefined
              ? "PHASE_CLOSED"
              : capabilityDenialReason
          ),
      },
    });
  }

  function findIdempotency({
    scope,
    actor,
    operation,
    clientKey,
  }) {
    return uniqueRow(
      idempotencyStatement,
      {
        leagueId: scope.leagueId,
        actorUserId: actor.userId,
        operation,
        clientKey,
      },
      "Candidate Card idempotency request"
    );
  }

  function findRevisionReplay(
    scope,
    resultId,
    operation
  ) {
    const row = uniqueRow(
      revisionResultStatement,
      {
        ...scope,
        resultId,
      },
      "Candidate Card revision replay"
    );
    if (!row) return null;
    return assertStoredRevisionResult(
      parseStoredResult(
        row.after_evidence_json
      ),
      scope,
      row,
      operation
    );
  }

  function replayMutationIfPresent({
    scope,
    actor,
    idempotency,
    operation,
    requestHash,
  }) {
    const row = findIdempotency({
      scope,
      actor,
      operation,
      clientKey:
        idempotency.clientKey,
    });
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      conflict(
        "The Candidate Card idempotency key was reused for a different intent.",
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    if (
      row.status !== "completed" ||
      row.result_type !==
        IDEMPOTENCY_RESULT_TYPE ||
      !UUID_PATTERN.test(row.result_id || "")
    ) {
      conflict(
        "The Candidate Card idempotency request is unavailable.",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE"
      );
    }
    const result = findRevisionReplay(
      scope,
      row.result_id,
      operation
    );
    if (!result) {
      incompatible(
        "The Candidate Card idempotency result is missing.",
        "IDEMPOTENCY_RESULT_MISSING"
      );
    }
    return result;
  }

  function insertStartedIdempotency({
    scope,
    actor,
    idempotency,
    operation,
    requestHash,
    nowMs,
  }) {
    if (
      insertIdempotencyStatement.run({
        requestId:
          idempotency.requestId,
        leagueId: scope.leagueId,
        actorUserId: actor.userId,
        operation,
        clientKey:
          idempotency.clientKey,
        requestHash,
        nowMs,
        expiresAtMs:
          idempotency.expiresAtMs,
      }).changes !== 1
    ) {
      conflict(
        "The Candidate Card idempotency request could not start.",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE"
      );
    }
  }

  function completeIdempotency({
    scope,
    actor,
    idempotency,
    operation,
    requestHash,
    nowMs,
    resultType,
    resultId,
  }) {
    if (
      completeIdempotencyStatement.run({
        requestId:
          idempotency.requestId,
        leagueId: scope.leagueId,
        actorUserId: actor.userId,
        operation,
        clientKey:
          idempotency.clientKey,
        requestHash,
        nowMs,
        resultType,
        resultId,
      }).changes !== 1
    ) {
      conflict(
        "The Candidate Card idempotency request could not complete.",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE"
      );
    }
  }

  function ensureOpenMutationContext(
    context,
    command,
    authority
  ) {
    if (!context) {
      notFound(
        "The Candidate Card does not exist in the requested scope.",
        "CANDIDATE_CARD_NOT_FOUND"
      );
    }
    if (
      context.card_status !== "open" ||
      context.fad_status !== "cards_open"
    ) {
      conflict(
        "The Candidate Card is no longer editable.",
        "FAD_PHASE_CONFLICT"
      );
    }
    if (
      command.nowMs >=
      context.candidate_deadline_at_ms
    ) {
      conflict(
        "The Candidate Card deadline has passed.",
        "FAD_DEADLINE_PASSED",
        {
          candidateDeadlineAtMs:
            context
              .candidate_deadline_at_ms,
        }
      );
    }
    if (
      context.league_status === "frozen" &&
      authority.accessReason ===
        "team_manager"
    ) {
      conflict(
        "The league is operationally frozen.",
        "LEAGUE_FROZEN"
      );
    }
    if (
      context.league_status !== "active" &&
      !(
        context.league_status === "frozen" &&
        authority.accessReason !==
          "team_manager"
      )
    ) {
      conflict(
        "The Candidate Card league is not active.",
        "FAD_PHASE_CONFLICT"
      );
    }
    if (
      context.card_version !==
      command.expectedCardVersion
    ) {
      conflict(
        "The Candidate Card version is stale.",
          "CANDIDATE_CARD_PRECONDITION_FAILED",
          {
            currentVersion:
              context.card_version,
            refetch: true,
          }
        );
    }
    if (
      !authority ||
      !authority.decision
        .canEditCandidateEntries
    ) {
      notFound(
        "The Candidate Card does not exist in the actor's private scope.",
        "CANDIDATE_CARD_NOT_FOUND"
      );
    }
    return authority;
  }

  function inspectSelectablePlayer(
    scope,
    playerId,
    slotKey
  ) {
    const player = uniqueRow(
      playerEligibilityStatement,
      {
        leagueId: scope.leagueId,
        playerId,
      },
      "Candidate player"
    );
    const position =
      player?.override_position_group ??
      player?.source_position_group ??
      null;
    if (
      !player ||
      player.status !== "active" ||
      !["F", "D"].includes(position)
    ) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName:
          player?.full_name ?? null,
        reasonCode:
          "CANDIDATE_PLAYER_INELIGIBLE",
      });
    }
    const slot =
      parseCandidateCardSlotKey(slotKey);
    if (
      slot.slotGroup !== "B" &&
      slot.slotGroup !== position
    ) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName: player.full_name,
        reasonCode: "CANDIDATE_SLOT_INVALID",
      });
    }
    const ownership = uniqueRow(
      playerOwnershipStatement,
      {
        leagueId: scope.leagueId,
        playerId,
      },
      "Candidate player ownership"
    );
    if (ownership) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName: player.full_name,
        reasonCode:
          "CANDIDATE_PLAYER_INELIGIBLE",
      });
    }
    const contract = uniqueRow(
      playerContractStatement,
      {
        leagueId: scope.leagueId,
        playerId,
      },
      "Candidate player active contract"
    );
    if (contract) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName: player.full_name,
        reasonCode:
          "CANDIDATE_PLAYER_INELIGIBLE",
      });
    }
    if (
      playerProspectExclusionStatement.get({
        leagueId: scope.leagueId,
        playerId,
      })
    ) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName: player.full_name,
        reasonCode:
          "CANDIDATE_PLAYER_INELIGIBLE",
      });
    }
    if (
      playerFadQuarantineStatement.get({
        leagueId: scope.leagueId,
        playerId,
      })
    ) {
      return Object.freeze({
        eligible: false,
        effectivePositionGroup: position,
        playerFullName: player.full_name,
        reasonCode:
          "FAD_ALLOCATION_QUARANTINED",
      });
    }
    return Object.freeze({
      eligible: true,
      effectivePositionGroup: position,
      playerFullName: player.full_name,
      reasonCode: null,
    });
  }

  function deriveSelectablePlayer(
    scope,
    playerId,
    slotKey
  ) {
    const inspected = inspectSelectablePlayer(
      scope,
      playerId,
      slotKey
    );
    if (!inspected.eligible) {
      conflict(
        inspected.reasonCode ===
          "CANDIDATE_SLOT_INVALID"
          ? "The Candidate position and slot are incompatible."
          : inspected.reasonCode ===
              "FAD_ALLOCATION_QUARANTINED"
            ? "The player remains quarantined by unresolved Free Agent Draft work."
            : "The player is not eligible for this Candidate Card.",
        inspected.reasonCode
      );
    }
    return Object.freeze({
      effectivePositionGroup:
        inspected.effectivePositionGroup,
      eligibilityStatus: "valid",
      validationCode: null,
      playerFullName:
        inspected.playerFullName,
    });
  }

  function entryById(entries, entryId) {
    return (
      entries.find(
        (entry) =>
          entry.entryId === entryId
      ) || null
    );
  }

  function simulateMutation(
    command,
    currentEntries
  ) {
    const {
      action,
      actor,
      nowMs,
      revisionId,
    } = command;
    const current = action.entryId
      ? entryById(
          currentEntries,
          action.entryId
        )
      : null;
    if (
      action.type !== "add" &&
      current === null
    ) {
      notFound(
        "The Candidate Card entry does not exist.",
        "CANDIDATE_CARD_ENTRY_NOT_FOUND"
      );
    }
    if (action.type === "add") {
      const authoritativePlayer =
        deriveSelectablePlayer(
        command.scope,
        action.playerId,
        action.slotKey
      );
      return Object.freeze({
        actionName: "candidate_added",
        affectedEntryId:
          action.entryId,
        playerId: action.playerId,
        changedEntryId:
          action.entryId,
        currentEntry: null,
        carryoverMove: null,
        playerFullName:
          authoritativePlayer
            .playerFullName,
        entries: [
          ...currentEntries,
          Object.freeze({
            entryId: action.entryId,
            entryVersion: 1,
            entryKind: "candidate",
            playerId: action.playerId,
            effectivePositionGroup:
              authoritativePlayer
                .effectivePositionGroup,
            slotKey: action.slotKey,
            placementState: "placed",
            conflictCode: null,
            ownershipId: null,
            contractId: null,
            sourceRosterCategory: null,
            contractType: "normal",
            originalTotalValueCents:
              null,
            originalTermYears: null,
            aavCents: action.aavCents,
            remainingYears: null,
            totalValueCents:
              action.totalValueCents,
            termYears: action.termYears,
            eligibilityStatus:
              authoritativePlayer
                .eligibilityStatus,
            validationCode:
              authoritativePlayer
                .validationCode,
            createdByUserId: actor.userId,
            createdByMembershipId:
              actor.membershipId,
            createdByAuthority:
              actor.authority,
            lastEditedByUserId:
              actor.userId,
            lastEditedByMembershipId:
              actor.membershipId,
            lastEditedByAuthority:
              actor.authority,
            lastAcknowledgementRevisionId:
              null,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          }),
        ],
      });
    }
    if (
      action.type === "edit" &&
      current.entryKind !== "candidate"
    ) {
      conflict(
        "A carryover contract cannot be edited from the Candidate Card.",
        "CANDIDATE_CARRYOVER_LOCKED"
      );
    }
    if (
      action.type === "remove" &&
      current.entryKind !== "candidate"
    ) {
      conflict(
        "A carryover cannot be removed from the Candidate Card.",
        "CANDIDATE_CARRYOVER_LOCKED"
      );
    }

    let nextEntry = null;
    let actionName;
    let carryoverMove = null;
    if (action.type === "edit") {
      const authoritativePlayer =
        deriveSelectablePlayer(
          command.scope,
          current.playerId,
          current.slotKey
        );
      nextEntry = Object.freeze({
        ...current,
        entryVersion:
          current.entryVersion + 1,
        effectivePositionGroup:
          authoritativePlayer
            .effectivePositionGroup,
        totalValueCents:
          action.totalValueCents,
        termYears: action.termYears,
        aavCents: action.aavCents,
        eligibilityStatus:
          authoritativePlayer
            .eligibilityStatus,
        validationCode:
          authoritativePlayer
            .validationCode,
        lastEditedByUserId:
          actor.userId,
        lastEditedByMembershipId:
          actor.membershipId,
        lastEditedByAuthority:
          actor.authority,
        lastAcknowledgementRevisionId:
          null,
        updatedAtMs: nowMs,
      });
      actionName = "candidate_edited";
    } else if (action.type === "move") {
      if (
        current.entryKind === "carryover"
      ) {
        carryoverMove =
          planCandidateCardCarryoverAction({
            action: "move",
            carryover:
              domainEntry(current),
            targetSlotKey:
              action.slotKey,
          });
        nextEntry = Object.freeze({
          ...current,
          entryVersion:
            current.entryVersion + 1,
          slotKey: action.slotKey,
          sourceRosterCategory:
            carryoverMove
              .targetRosterCategory,
          lastEditedByUserId:
            actor.userId,
          lastEditedByMembershipId:
            actor.membershipId,
          lastEditedByAuthority:
            actor.authority,
          updatedAtMs: nowMs,
        });
        actionName = "carryover_moved";
      } else {
        nextEntry = Object.freeze({
          ...current,
          entryVersion:
            current.entryVersion + 1,
          slotKey: action.slotKey,
          placementState: "placed",
          conflictCode: null,
          lastEditedByUserId:
            actor.userId,
          lastEditedByMembershipId:
            actor.membershipId,
          lastEditedByAuthority:
            actor.authority,
          lastAcknowledgementRevisionId:
            null,
          updatedAtMs: nowMs,
        });
        actionName = "candidate_moved";
      }
    } else {
      actionName = "candidate_removed";
    }

    const entries =
      action.type === "remove"
        ? currentEntries.filter(
            ({ entryId }) =>
              entryId !== action.entryId
          )
        : currentEntries.map((entry) =>
            entry.entryId ===
            action.entryId
              ? nextEntry
              : entry
          );
    return Object.freeze({
      actionName,
      affectedEntryId:
        action.entryId,
      playerId: current.playerId,
      changedEntryId:
        action.type === "remove"
          ? null
          : action.entryId,
      currentEntry: current,
      carryoverMove,
      playerFullName: null,
      entries,
      revisionId,
    });
  }

  function sameCandidateOffer(entry, candidate) {
    return (
      entry.totalValueCents ===
        candidate.totalValueCents &&
      entry.aavCents === candidate.aavCents &&
      entry.termYears === candidate.termYears
    );
  }

  function simulateWholeSave(
    command,
    currentEntries
  ) {
    const carryovers = currentEntries.filter(
      ({ entryKind }) =>
        entryKind === "carryover"
    );
    const currentCandidates =
      currentEntries.filter(
        ({ entryKind }) =>
          entryKind === "candidate"
      );
    const desiredBySlot = new Map(
      command.slots.map((slot, index) => [
        slot.slotKey,
        Object.freeze({
          ...slot,
          allocatedEntryId:
            command.entryIds[index],
        }),
      ])
    );
    for (const carryover of carryovers) {
      if (
        desiredBySlot.get(carryover.slotKey)
          ?.candidate !== null
      ) {
        conflict(
          "A carryover slot must remain server-owned during a whole-card save.",
          "CANDIDATE_CARRYOVER_LOCKED"
        );
      }
    }

    const currentByPlayer = new Map(
      currentCandidates.map((entry) => [
        entry.playerId,
        entry,
      ])
    );
    const preservedIds = new Set();
    const nextCandidates = [];
    const changes = [];
    const playerFullNamesByEntryId =
      new Map();

    for (const desired of command.slots) {
      if (desired.candidate === null) {
        continue;
      }
      const candidate = desired.candidate;
      const contract =
        createCandidateCardPartialOfferContract(
          {
            aavCents: candidate.aavCents,
            termYears: candidate.termYears,
          }
        );
      const authoritativePlayer =
        deriveSelectablePlayer(
          command.scope,
          candidate.playerId,
          desired.slotKey
        );
      const incomplete =
        candidate.aavCents === null ||
        candidate.termYears === null;
      const current = currentByPlayer.get(
        candidate.playerId
      );
      const sameOffer =
        current !== undefined &&
        sameCandidateOffer(
          current,
            contract
        );
      const preserve =
        current !== undefined &&
        current.placementState === "placed" &&
        (
          current.slotKey === desired.slotKey ||
          sameOffer
        );
      const allocatedEntryId =
        desiredBySlot.get(desired.slotKey)
          .allocatedEntryId;
      const entryId = preserve
        ? current.entryId
        : allocatedEntryId;
      if (
        !preserve &&
        currentEntries.some(
          (entry) => entry.entryId === entryId
        )
      ) {
        conflict(
          "A generated Candidate entry identifier already exists.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
      const eligibilityStatus = incomplete
        ? "invalid"
        : authoritativePlayer
            .eligibilityStatus;
      const validationCode = incomplete
        ? "CANDIDATE_CONTRACT_INCOMPLETE"
        : authoritativePlayer.validationCode;
      const moved =
        preserve &&
        current.slotKey !== desired.slotKey;
      const edited =
        preserve &&
        !moved &&
        (
          !sameOffer ||
          current.effectivePositionGroup !==
            authoritativePlayer
              .effectivePositionGroup ||
          current.eligibilityStatus !==
            eligibilityStatus ||
          current.validationCode !==
            validationCode
        );
      const changed = moved || edited;
      const entryVersion = preserve
        ? current.entryVersion +
          (moved ? 2 : edited ? 1 : 0)
        : 1;
      const next = Object.freeze({
        ...(preserve ? current : {}),
        entryId,
        entryVersion,
        entryKind: "candidate",
        playerId: candidate.playerId,
        effectivePositionGroup:
          authoritativePlayer
            .effectivePositionGroup,
        slotKey: desired.slotKey,
        placementState: "placed",
        conflictCode: null,
        ownershipId: null,
        contractId: null,
        sourceRosterCategory: null,
        contractType: "normal",
        originalTotalValueCents: null,
        originalTermYears: null,
        aavCents: contract.aavCents,
        remainingYears: null,
        totalValueCents:
          contract.totalValueCents,
        termYears: candidate.termYears,
        eligibilityStatus,
        validationCode,
        createdByUserId: preserve
          ? current.createdByUserId
          : command.actor.userId,
        createdByMembershipId: preserve
          ? current.createdByMembershipId
          : command.actor.membershipId,
        createdByAuthority: preserve
          ? current.createdByAuthority
          : command.actor.authority,
        lastEditedByUserId: changed || !preserve
          ? command.actor.userId
          : current.lastEditedByUserId,
        lastEditedByMembershipId:
          changed || !preserve
            ? command.actor.membershipId
            : current
                .lastEditedByMembershipId,
        lastEditedByAuthority:
          changed || !preserve
            ? command.actor.authority
            : current.lastEditedByAuthority,
        lastAcknowledgementRevisionId: null,
        createdAtMs: preserve
          ? current.createdAtMs
          : command.nowMs,
        updatedAtMs: changed || !preserve
          ? command.nowMs
          : current.updatedAtMs,
      });
      nextCandidates.push(next);
      playerFullNamesByEntryId.set(
        entryId,
        authoritativePlayer.playerFullName
      );
      if (preserve) {
        preservedIds.add(current.entryId);
        if (changed) {
          changes.push(
            Object.freeze({
              changeKind: moved
                ? "move"
                : "edit",
              entryId,
              playerId: candidate.playerId,
              beforeSlotKey: current.slotKey,
              afterSlotKey: desired.slotKey,
              beforeTotalValueCents:
                current.totalValueCents,
              beforeTermYears:
                current.termYears,
              afterTotalValueCents:
                contract.totalValueCents,
              afterTermYears:
                candidate.termYears,
              currentEntry: current,
              nextEntry: next,
            })
          );
        }
      } else {
        changes.push(
          Object.freeze({
            changeKind: "add",
            entryId,
            playerId: candidate.playerId,
            beforeSlotKey: null,
            afterSlotKey: desired.slotKey,
            beforeTotalValueCents: null,
            beforeTermYears: null,
            afterTotalValueCents:
              contract.totalValueCents,
            afterTermYears:
              candidate.termYears,
            currentEntry: null,
            nextEntry: next,
          })
        );
      }
    }

    for (const current of currentCandidates) {
      if (!preservedIds.has(current.entryId)) {
        changes.push(
          Object.freeze({
            changeKind: "remove",
            entryId: current.entryId,
            playerId: current.playerId,
            beforeSlotKey: current.slotKey,
            afterSlotKey: null,
            beforeTotalValueCents:
              current.totalValueCents,
            beforeTermYears: current.termYears,
            afterTotalValueCents: null,
            afterTermYears: null,
            currentEntry: current,
            nextEntry: null,
          })
        );
      }
    }
    changes.sort((left, right) =>
      left.entryId.localeCompare(right.entryId)
    );
    return Object.freeze({
      actionName: "candidate_card_saved",
      affectedEntryId: null,
      playerId: null,
      entries: Object.freeze([
        ...carryovers,
        ...nextCandidates,
      ]),
      changes: Object.freeze(changes),
      changedEntryIds: Object.freeze(
        changes.map(({ entryId }) => entryId)
      ),
      playerFullNamesByEntryId,
    });
  }

  function updateCard(
    command,
    evaluation,
    statement = updateCardStatement
  ) {
    const result =
      statement.run({
        ...command.scope,
        expectedCardVersion:
          command.expectedCardVersion,
        nowMs: command.nowMs,
        completenessCode:
          evaluation.completeness.code,
        filledMandatoryCount:
          evaluation.completeness
            .filledMandatory,
        missingMandatoryCount:
          evaluation.completeness
            .missingMandatory,
        filledBenchCount:
          evaluation.completeness
            .filledBench,
        emptyBenchCount:
          evaluation.completeness
            .emptyBench,
        blockingValidationCount:
          evaluation.completeness
            .blockingValidationCount,
        structuralConflictCount:
          evaluation.completeness
            .structuralConflictCount,
        carriedRosterStructuralConflictCount:
          evaluation.completeness
            .carriedRosterStructuralConflictCount,
        maximumPossibleCapCents:
          evaluation.capProjection
            .maximumPossibleCapCents,
        capStatus:
          evaluation.capStatus,
        allocationEligibility:
          evaluation
            .allocationEligibility,
        allocationExclusionReason:
          evaluation
            .allocationExclusionReason,
      });
    if (result.changes !== 1) {
      conflict(
        "The Candidate Card version or phase changed.",
        "CANDIDATE_CARD_PRECONDITION_FAILED"
      );
    }
  }

  function insertRevision({
    command,
    simulation,
    beforeCard,
    result,
    warnings,
  }) {
    if (
      insertRevisionStatement.run({
        ...command.scope,
        revisionId: command.revisionId,
        resultingCardVersion:
          command.expectedCardVersion + 1,
        action: simulation.actionName,
        affectedEntryId:
          simulation.affectedEntryId,
        playerId: simulation.playerId,
        actorUserId:
          command.actor.userId,
        actorMembershipId:
          command.actor.membershipId,
        actorAuthority:
          command.actor.authority,
        beforeEvidenceJson:
          canonicalJson({
            card: beforeCard,
          }),
        afterEvidenceJson:
          canonicalJson({
            result,
          }),
        potentialIllegalityAcknowledged: 0,
        warningCodesJson:
          canonicalJson(warnings),
        nowMs: command.nowMs,
      }).changes !== 1
    ) {
      conflict(
        "The Candidate Card revision could not be recorded.",
        "CANDIDATE_CARD_PRECONDITION_FAILED"
      );
    }
  }

  function applyEntryMutation(
    command,
    simulation
  ) {
    const common = {
      ...command.scope,
      actorUserId:
        command.actor.userId,
      actorMembershipId:
        command.actor.membershipId,
      actorAuthority:
        command.actor.authority,
      nowMs: command.nowMs,
    };
    const action = command.action;
    const nextEntry =
      simulation.changedEntryId === null
        ? null
        : entryById(
            simulation.entries,
            simulation.changedEntryId
          );
    const acknowledgementRevisionId =
      nextEntry
        ?.lastAcknowledgementRevisionId ??
      null;
    let result;
    if (action.type === "add") {
      const slot =
        parseCandidateCardSlotKey(
          action.slotKey
        );
      result =
        insertCandidateStatement.run({
          ...common,
          entryId: action.entryId,
          playerId: action.playerId,
          effectivePositionGroup:
            nextEntry
              .effectivePositionGroup,
          slotGroup: slot.slotGroup,
          slotNumber: slot.slotNumber,
          totalValueCents:
            action.totalValueCents,
          termYears: action.termYears,
          aavCents: action.aavCents,
          eligibilityStatus:
            nextEntry.eligibilityStatus,
          validationCode:
            nextEntry.validationCode,
          acknowledgementRevisionId,
        });
    } else if (action.type === "edit") {
      result =
        updateCandidateContractStatement.run({
          ...common,
          entryId: action.entryId,
          expectedEntryVersion:
            simulation.currentEntry
              .entryVersion,
          effectivePositionGroup:
            nextEntry
              .effectivePositionGroup,
          totalValueCents:
            action.totalValueCents,
          termYears: action.termYears,
          aavCents: action.aavCents,
          eligibilityStatus:
            nextEntry.eligibilityStatus,
          validationCode:
            nextEntry.validationCode,
          acknowledgementRevisionId,
        });
    } else if (
      action.type === "move" &&
      simulation.currentEntry
        .entryKind === "candidate"
    ) {
      const slot =
        parseCandidateCardSlotKey(
          action.slotKey
        );
      result =
        updateCandidateMoveStatement.run({
          ...common,
          entryId: action.entryId,
          expectedEntryVersion:
            simulation.currentEntry
              .entryVersion,
          slotGroup: slot.slotGroup,
          slotNumber: slot.slotNumber,
          acknowledgementRevisionId,
        });
    } else if (
      action.type === "move"
    ) {
      const slot =
        parseCandidateCardSlotKey(
          action.slotKey
        );
      result =
        updateCarryoverMoveStatement.run({
          ...common,
          entryId: action.entryId,
          expectedEntryVersion:
            simulation.currentEntry
              .entryVersion,
          slotGroup: slot.slotGroup,
          slotNumber: slot.slotNumber,
          targetRosterCategory:
            simulation.carryoverMove
              .targetRosterCategory,
          ownershipId:
            simulation.currentEntry
              .ownershipId,
          contractId:
            simulation.currentEntry
              .contractId,
          playerId:
            simulation.currentEntry
              .playerId,
        });
    } else {
      result =
        deleteCandidateStatement.run({
          ...common,
          entryId: action.entryId,
          expectedEntryVersion:
            simulation.currentEntry
              .entryVersion,
        });
    }
    if (result.changes !== 1) {
      conflict(
        "The Candidate Card entry changed during the mutation.",
        "CANDIDATE_CARD_PRECONDITION_FAILED"
      );
    }
  }

  function wholeCandidateParameters(
    command,
    entry,
    expectedEntryVersion
  ) {
    const slot = parseCandidateCardSlotKey(
      entry.slotKey
    );
    return {
      ...command.scope,
      entryId: entry.entryId,
      playerId: entry.playerId,
      effectivePositionGroup:
        entry.effectivePositionGroup,
      slotGroup: slot.slotGroup,
      slotNumber: slot.slotNumber,
      totalValueCents:
        entry.totalValueCents,
      termYears: entry.termYears,
      aavCents: entry.aavCents,
      eligibilityStatus:
        entry.eligibilityStatus,
      validationCode: entry.validationCode,
      acknowledgementRevisionId: null,
      actorUserId: command.actor.userId,
      actorMembershipId:
        command.actor.membershipId,
      actorAuthority:
        command.actor.authority,
      nowMs: command.nowMs,
      expectedEntryVersion,
    };
  }

  function applyWholeSaveEntries(
    command,
    simulation
  ) {
    for (const change of simulation.changes) {
      if (change.changeKind !== "remove") {
        continue;
      }
      if (
        deleteCandidateStatement.run({
          ...command.scope,
          entryId: change.entryId,
          expectedEntryVersion:
            change.currentEntry.entryVersion,
        }).changes !== 1
      ) {
        conflict(
          "A Candidate Card entry changed during the whole-card save.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const change of simulation.changes) {
      if (change.changeKind !== "move") {
        continue;
      }
      if (
        stageWholeCandidateMoveStatement.run({
          ...command.scope,
          entryId: change.entryId,
          expectedEntryVersion:
            change.currentEntry.entryVersion,
          actorUserId:
            command.actor.userId,
          actorMembershipId:
            command.actor.membershipId,
          actorAuthority:
            command.actor.authority,
          nowMs: command.nowMs,
        }).changes !== 1
      ) {
        conflict(
          "A Candidate Card move changed during the whole-card save.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const change of simulation.changes) {
      if (
        change.changeKind !== "edit" &&
        change.changeKind !== "move"
      ) {
        continue;
      }
      const expectedEntryVersion =
        change.currentEntry.entryVersion +
        (change.changeKind === "move" ? 1 : 0);
      if (
        updateWholeCandidateStatement.run(
          wholeCandidateParameters(
            command,
            change.nextEntry,
            expectedEntryVersion
          )
        ).changes !== 1
      ) {
        conflict(
          "A Candidate Card entry changed during the whole-card save.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const change of simulation.changes) {
      if (change.changeKind !== "add") {
        continue;
      }
      const parameters =
        wholeCandidateParameters(
          command,
          change.nextEntry,
          0
        );
      if (
        insertCandidateStatement.run(
          parameters
        ).changes !== 1
      ) {
        conflict(
          "A Candidate Card entry could not be added during the whole-card save.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
  }

  function insertWholeSaveChanges(
    command,
    simulation
  ) {
    for (const change of simulation.changes) {
      if (
        insertRevisionEntryChangeStatement.run({
          ...command.scope,
          revisionId: command.revisionId,
          entryId: change.entryId,
          playerId: change.playerId,
          changeKind: change.changeKind,
          beforeSlotKey:
            change.beforeSlotKey,
          afterSlotKey: change.afterSlotKey,
          beforeTotalValueCents:
            change.beforeTotalValueCents,
          beforeTermYears:
            change.beforeTermYears,
          afterTotalValueCents:
            change.afterTotalValueCents,
          afterTermYears:
            change.afterTermYears,
          nowMs: command.nowMs,
        }).changes !== 1
      ) {
        conflict(
          "Candidate Card whole-save provenance could not be recorded.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
  }

  function planCarryoverOwnershipMove(
    command,
    simulation
  ) {
    if (!simulation.carryoverMove) {
      return Object.freeze({
        ownership: null,
        activePlayerAdjustmentCents: 0,
      });
    }
    const current =
      simulation.currentEntry;
    const ownership = uniqueRow(
      carryoverOwnershipStatement,
      {
        ...command.scope,
        ownershipId:
          current.ownershipId,
        playerId: current.playerId,
        contractId:
          current.contractId,
      },
      "Candidate carryover ownership"
    );
    if (
      !ownership ||
      ownership.roster_category !==
        current.sourceRosterCategory ||
      ownership.position_group !==
        current.effectivePositionGroup ||
      ownership.contract_id !==
        current.contractId ||
      ownership.current_team_id !==
        command.scope.teamId ||
      ownership.contract_status !==
        "active" ||
      ownership.aav_cents !==
        current.aavCents
    ) {
      conflict(
        "The carryover ownership changed before the Candidate move.",
        "CANDIDATE_CARRYOVER_LOCKED"
      );
    }
    if (
      !Number.isSafeInteger(
        ownership.retained_aav_cents
      ) ||
      ownership.retained_aav_cents < 0 ||
      ownership.retained_aav_cents >
        ownership.aav_cents
    ) {
      incompatible(
        "The carryover cap evidence is invalid.",
        "CANDIDATE_CAP_PROJECTION_INVALID"
      );
    }
    const currentCountsAgainstCap =
      current.sourceRosterCategory ===
      "Active";
    const targetCountsAgainstCap =
      simulation.carryoverMove
        .targetRosterCategory === "Active";
    const netAavCents =
      ownership.aav_cents -
      ownership.retained_aav_cents;
    return Object.freeze({
      ownership,
      activePlayerAdjustmentCents:
        currentCountsAgainstCap ===
        targetCountsAgainstCap
          ? 0
          : targetCountsAgainstCap
            ? netAavCents
            : -netAavCents,
    });
  }

  function applyCarryoverOwnershipMove(
    command,
    simulation,
    plan
  ) {
    if (!simulation.carryoverMove) return;
    const current =
      simulation.currentEntry;
    const ownership = plan.ownership;
    const slot =
      parseCandidateCardSlotKey(
        command.action.slotKey
      );
    if (
      updateCarryoverOwnershipStatement.run({
        ...command.scope,
        ownershipId:
          current.ownershipId,
        playerId: current.playerId,
        expectedOwnershipVersion:
          ownership.version,
        targetRosterCategory:
          simulation.carryoverMove
            .targetRosterCategory,
        slotNumber: slot.slotNumber,
        nowMs: command.nowMs,
      }).changes !== 1
    ) {
      conflict(
        "The carryover ownership changed before the Candidate move.",
        "CANDIDATE_CARD_PRECONDITION_FAILED"
      );
    }
  }

  function executeMutation(
    command,
    context,
    currentAuthority,
    { exactPrivateResult = false } = {}
  ) {
      const operation =
        CANDIDATE_CARD_OPERATIONS[
          command.action.type
        ];
      const requestHash = sha256({
        scope: command.scope,
        expectedCardVersion:
          command.expectedCardVersion,
        action: mutationIntentAction(
          command.action
        ),
      });
      const replay =
        replayMutationIfPresent({
          scope: command.scope,
          actor: command.actor,
          idempotency:
            command.idempotency,
          operation,
          requestHash,
      });
      if (replay) return replay;

      insertStartedIdempotency({
        scope: command.scope,
        actor: command.actor,
        idempotency:
          command.idempotency,
        operation,
        requestHash,
        nowMs: command.nowMs,
      });

      const before =
        loadAggregate(command.scope);
      const authority =
        ensureOpenMutationContext(
          before?.context ?? null,
          command,
          currentAuthority
        );
      let simulation = simulateMutation(
        command,
        before.entries
      );
      const carryoverMovePlan =
        planCarryoverOwnershipMove(
          command,
          simulation
        );
      applyCarryoverOwnershipMove(
        command,
        simulation,
        carryoverMovePlan
      );
      let evaluation =
        calculateEvaluation(
          command.scope,
          simulation.entries
        );
      assertCandidateCardSaveAllowed(evaluation);
      const warnings =
        warningCodes(evaluation);
      const expectedCard =
        projectionFromEvaluation({
          context: before.context,
          evaluation,
          entries: simulation.entries,
          cardVersion:
            command.expectedCardVersion + 1,
        });
      const responseCard =
        exactPrivateResult
          ? exactPrivateProjection({
              aggregate: Object.freeze({
                context: before.context,
                entries:
                  simulation.entries,
                evaluation,
              }),
              authority,
              nowMs: command.nowMs,
              evidenceByEntryId:
                projectedPrivateEntryEvidence({
                  scope: command.scope,
                  beforeEntries:
                    before.entries,
                  simulation,
                  authority,
                }),
              scope: command.scope,
              cardVersion:
                command.expectedCardVersion +
                1,
              commissionerInterventions:
                projectedInterventionRows({
                  scope: command.scope,
                  command,
                  simulation,
                  authority,
                }),
            })
          : expectedCard;
      const result = deepFreeze({
        card: responseCard,
        revisionId:
          command.revisionId,
        changedEntryId:
          simulation.changedEntryId,
      });

      updateCard(command, evaluation);
      insertRevision({
        command,
        simulation,
        beforeCard: before.card,
        result,
        warnings,
      });
      applyEntryMutation(
        command,
        simulation
      );

      const after =
        loadAggregate(command.scope);
      if (
        after.context.card_version !==
          command.expectedCardVersion + 1 ||
        !isDeepStrictEqual(
          after.card,
          expectedCard
        )
      ) {
        incompatible(
          "Candidate Card persistence did not reproduce its approved projection.",
          "CANDIDATE_CARD_RESULT_DRIFT"
        );
      }
      if (exactPrivateResult) {
        const actualPrivateCard =
          exactPrivateProjection({
            aggregate: after,
            authority,
            nowMs: command.nowMs,
            evidenceByEntryId:
              loadPrivateEntryEvidence(
                command.scope,
                after.entries
              ),
            scope: command.scope,
          });
        if (
          !isDeepStrictEqual(
            actualPrivateCard,
            responseCard
          )
        ) {
          incompatible(
            "Candidate Card persistence did not reproduce its authoritative private projection.",
            "CANDIDATE_CARD_RESULT_DRIFT"
          );
        }
      }
      writeMutationSideEffects({
        kind: "candidate_card_changed",
        scope: command.scope,
        actor: command.actor,
        authority,
        action:
          simulation.actionName,
        revisionId:
          command.revisionId,
        cardVersion:
          after.context.card_version,
        changedAtMs: command.nowMs,
      });
      if (beforeCommit) {
        beforeCommit({
          kind: "candidate_card_mutation",
          result,
        });
      }
      completeIdempotency({
        scope: command.scope,
        actor: command.actor,
        idempotency:
          command.idempotency,
        operation,
        requestHash,
        nowMs: command.nowMs,
        resultType:
          IDEMPOTENCY_RESULT_TYPE,
        resultId:
          command.revisionId,
      });
      return result;
  }

  const mutationTransaction =
    database.transaction((rawCommand) => {
      const command =
        normalizeMutationCommand(
          rawCommand
        );
      const context =
        loadContext(command.scope);
      if (!context) {
        notFound(
          "The Candidate Card does not exist in the requested scope.",
          "CANDIDATE_CARD_NOT_FOUND"
        );
      }
      const currentAuthority = privateAuthority({
        scope: command.scope,
        actor: command.actor,
        context,
        nowMs: command.nowMs,
      });
      if (!currentAuthority) {
        notFound(
          "The Candidate Card does not exist in the actor's private scope.",
          "CANDIDATE_CARD_NOT_FOUND"
        );
      }
      return executeMutation(
        command,
        context,
        currentAuthority
      );
    });

  function normalizeCurrentMutationCommand(
    rawCommand
  ) {
    exactObject(
      rawCommand,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewer",
        "expectedCardVersion",
        "nowMs",
        "idempotency",
        "revisionId",
        "action",
      ],
      "route-scoped Candidate Card mutation command"
    );
    const nowMs = safeTimestamp(
      rawCommand.nowMs,
      "route-scoped Candidate Card mutation timestamp"
    );
    return Object.freeze({
      routeScope: Object.freeze({
        leagueId: stableId(
          rawCommand.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          rawCommand.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          rawCommand.teamId,
          "team identifier"
        ),
      }),
      viewer: normalizeViewer(
        rawCommand.viewer
      ),
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          rawCommand.expectedCardVersion
        ),
      nowMs,
      idempotency: normalizeIdempotency(
        Object.freeze({
          ...rawCommand.idempotency,
          clientKey:
            normalizeCandidateCardIdempotencyKey(
              rawCommand.idempotency
                ?.clientKey
            ),
        }),
        nowMs
      ),
      revisionId: stableId(
        rawCommand.revisionId,
        "Candidate Card revision identifier"
      ),
      action: normalizeMutationAction(
        rawCommand.action
      ),
    });
  }

  const currentMutationTransaction =
    database.transaction((rawCommand) => {
      const current =
        normalizeCurrentMutationCommand(
          rawCommand
        );
      const scope = resolveRouteScope(
        current.routeScope
      );
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = routeViewerActor(
        scope,
        current.viewer
      );
      if (!actor) return null;
      const currentAuthority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: current.nowMs,
      });
      if (!currentAuthority) return null;
      const command = Object.freeze({
        scope,
        actor,
        expectedCardVersion:
          current.expectedCardVersion,
        nowMs: current.nowMs,
        idempotency: current.idempotency,
        revisionId: current.revisionId,
        action: current.action,
      });
      return executeMutation(
        command,
        context,
        currentAuthority,
        { exactPrivateResult: true }
      );
    });

  function normalizeCurrentWholeSaveCommand(
    rawCommand
  ) {
    exactObject(
      rawCommand,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewer",
        "expectedCardVersion",
        "nowMs",
        "idempotency",
        "revisionId",
        "slots",
        "entryIds",
      ],
      "route-scoped Candidate Card whole-save command"
    );
    const nowMs = safeTimestamp(
      rawCommand.nowMs,
      "route-scoped Candidate Card whole-save timestamp"
    );
    const normalized =
      normalizeCandidateCardWholeSave({
        slots: rawCommand.slots,
      });
    if (
      !Array.isArray(rawCommand.entryIds) ||
      rawCommand.entryIds.length !==
        CANDIDATE_CARD_SLOT_KEYS.length
    ) {
      invalid(
        "Candidate Card whole-save entry identifiers are invalid.",
        "ENTRY_IDS_INVALID"
      );
    }
    const entryIds = rawCommand.entryIds.map(
      (entryId, index) => {
        if (
          normalized.slots[index].candidate ===
          null
        ) {
          if (entryId !== null) {
            invalid(
              "Empty Candidate slots cannot allocate entry identifiers.",
              "ENTRY_IDS_INVALID"
            );
          }
          return null;
        }
        return stableId(
          entryId,
          "Candidate entry identifier"
        );
      }
    );
    if (
      new Set(
        entryIds.filter(
          (entryId) => entryId !== null
        )
      ).size !==
      entryIds.filter(
        (entryId) => entryId !== null
      ).length
    ) {
      invalid(
        "Candidate Card entry identifiers must be unique.",
        "ENTRY_IDS_INVALID"
      );
    }
    return Object.freeze({
      routeScope: Object.freeze({
        leagueId: stableId(
          rawCommand.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          rawCommand.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          rawCommand.teamId,
          "team identifier"
        ),
      }),
      viewer: normalizeViewer(rawCommand.viewer),
      expectedCardVersion:
        normalizeCandidateCardExpectedVersion(
          rawCommand.expectedCardVersion
        ),
      nowMs,
      idempotency: normalizeIdempotency(
        Object.freeze({
          ...rawCommand.idempotency,
          clientKey:
            normalizeCandidateCardIdempotencyKey(
              rawCommand.idempotency
                ?.clientKey
            ),
        }),
        nowMs
      ),
      revisionId: stableId(
        rawCommand.revisionId,
        "Candidate Card revision identifier"
      ),
      slots: normalized.slots,
      entryIds: Object.freeze(entryIds),
    });
  }

  function executeWholeSave(
    command,
    currentAuthority
  ) {
    const operation =
      CANDIDATE_CARD_OPERATIONS.save;
    const requestHash = sha256({
      scope: command.scope,
      expectedCardVersion:
        command.expectedCardVersion,
      slots: command.slots,
    });
    const replay = replayMutationIfPresent({
      scope: command.scope,
      actor: command.actor,
      idempotency: command.idempotency,
      operation,
      requestHash,
    });
    if (replay) return replay;

    insertStartedIdempotency({
      scope: command.scope,
      actor: command.actor,
      idempotency: command.idempotency,
      operation,
      requestHash,
      nowMs: command.nowMs,
    });
    const before = loadAggregate(command.scope);
    const authority = ensureOpenMutationContext(
      before?.context ?? null,
      command,
      currentAuthority
    );
    const simulation = simulateWholeSave(
      command,
      before.entries
    );
    const evaluation = calculateEvaluation(
      command.scope,
      simulation.entries
    );
    assertCandidateCardSaveAllowed(evaluation);
    const warnings = warningCodes(evaluation);
    const expectedCard =
      projectionFromEvaluation({
        context: before.context,
        evaluation,
        entries: simulation.entries,
        cardVersion:
          command.expectedCardVersion + 1,
      });
    const responseCard = exactPrivateProjection({
      aggregate: Object.freeze({
        context: before.context,
        entries: simulation.entries,
        evaluation,
      }),
      authority,
      nowMs: command.nowMs,
      evidenceByEntryId:
        projectedWholeSaveEvidence({
          scope: command.scope,
          beforeEntries: before.entries,
          simulation,
          authority,
        }),
      scope: command.scope,
      cardVersion:
        command.expectedCardVersion + 1,
      commissionerInterventions:
        projectedInterventionRows({
          scope: command.scope,
          command,
          simulation,
          authority,
        }),
    });
    const result = deepFreeze({
      card: responseCard,
      revisionId: command.revisionId,
      changedEntryIds:
        simulation.changedEntryIds,
    });

    updateCard(command, evaluation);
    insertRevision({
      command,
      simulation,
      beforeCard: before.card,
      result,
      warnings,
    });
    applyWholeSaveEntries(command, simulation);
    insertWholeSaveChanges(command, simulation);

    const after = loadAggregate(command.scope);
    if (
      after.context.card_version !==
        command.expectedCardVersion + 1 ||
      !isDeepStrictEqual(after.card, expectedCard)
    ) {
      incompatible(
        "Candidate Card whole-save persistence drifted from its approved projection.",
        "CANDIDATE_CARD_RESULT_DRIFT"
      );
    }
    const actualPrivateCard =
      exactPrivateProjection({
        aggregate: after,
        authority,
        nowMs: command.nowMs,
        evidenceByEntryId:
          loadPrivateEntryEvidence(
            command.scope,
            after.entries
          ),
        scope: command.scope,
      });
    if (
      !isDeepStrictEqual(
        actualPrivateCard,
        responseCard
      )
    ) {
      incompatible(
        "Candidate Card whole-save private response drifted after persistence.",
        "CANDIDATE_CARD_RESULT_DRIFT"
      );
    }
    writeMutationSideEffects({
      kind: "candidate_card_changed",
      scope: command.scope,
      actor: command.actor,
      authority,
      action: "candidate_card_saved",
      revisionId: command.revisionId,
      cardVersion:
        after.context.card_version,
      changedAtMs: command.nowMs,
    });
    if (beforeCommit) {
      beforeCommit({
        kind: "candidate_card_mutation",
        result,
      });
    }
    completeIdempotency({
      scope: command.scope,
      actor: command.actor,
      idempotency: command.idempotency,
      operation,
      requestHash,
      nowMs: command.nowMs,
      resultType: IDEMPOTENCY_RESULT_TYPE,
      resultId: command.revisionId,
    });
    return result;
  }

  const currentWholeSaveTransaction =
    database.transaction((rawCommand) => {
      const current =
        normalizeCurrentWholeSaveCommand(
          rawCommand
        );
      const scope = resolveRouteScope(
        current.routeScope
      );
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = routeViewerActor(
        scope,
        current.viewer
      );
      if (!actor) return null;
      const currentAuthority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: current.nowMs,
      });
      if (!currentAuthority) return null;
      const command = Object.freeze({
        scope,
        actor,
        expectedCardVersion:
          current.expectedCardVersion,
        nowMs: current.nowMs,
        idempotency: current.idempotency,
        revisionId: current.revisionId,
        slots: current.slots,
        entryIds: current.entryIds,
      });
      return executeWholeSave(
        command,
        currentAuthority
      );
    });

  function normalizeEligiblePlayersCurrentRead(
    options
  ) {
    exactObject(
      options,
      ["query", "viewer", "nowMs"],
      "Candidate eligible-player read"
    );
    exactObject(
      options.query,
      [
        "leagueId",
        "fadId",
        "teamId",
        "slotKey",
        "q",
        "limit",
        "cursor",
      ],
      "Candidate eligible-player query"
    );
    let slot;
    try {
      slot = parseCandidateCardSlotKey(
        options.query.slotKey
      );
    } catch (error) {
      invalid(
        "A canonical Candidate Card slot key is required.",
        "CANDIDATE_SLOT_INVALID"
      );
    }
    let q;
    try {
      q =
        normalizeCandidateEligiblePlayerSearchText(
          options.query.q
        );
    } catch (error) {
      invalid(
        "A canonical Candidate player query is required.",
        "QUERY_INVALID"
      );
    }
    if (q !== options.query.q) {
      invalid(
        "A canonical Candidate player query is required.",
        "QUERY_INVALID"
      );
    }
    const limit = positiveInteger(
      options.query.limit,
      "Candidate eligible-player page size"
    );
    if (
      limit >
      MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE
    ) {
      invalid(
        "The Candidate eligible-player page size is too large.",
        "PAGE_SIZE_INVALID"
      );
    }
    let cursor = null;
    if (options.query.cursor !== null) {
      exactObject(
        options.query.cursor,
        ["sortName", "playerId"],
        "Candidate eligible-player cursor"
      );
      let sortName;
      try {
        sortName =
          normalizeCandidateEligiblePlayerSortName(
            options.query.cursor.sortName
          );
      } catch (error) {
        invalid(
          "A canonical Candidate eligible-player cursor is required.",
          "CURSOR_INVALID"
        );
      }
      cursor = Object.freeze({
        sortName,
        playerId: stableId(
          options.query.cursor.playerId,
          "Candidate cursor-player identifier"
        ),
      });
    }
    return Object.freeze({
      query: Object.freeze({
        leagueId: stableId(
          options.query.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          options.query.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          options.query.teamId,
          "team identifier"
        ),
        slotKey: slot.slotKey,
        slotGroup: slot.slotGroup,
        q,
        limit,
        cursor,
      }),
      viewer: normalizeViewer(options.viewer),
      nowMs: safeTimestamp(
        options.nowMs,
        "Candidate eligible-player read timestamp"
      ),
    });
  }

  function readEligiblePlayersCurrent(
    rawOptions
  ) {
    const options =
      normalizeEligiblePlayersCurrentRead(
        rawOptions
      );
    try {
      const scope = resolveRouteScope({
        leagueId: options.query.leagueId,
        fadId: options.query.fadId,
        teamId: options.query.teamId,
      });
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = routeViewerActor(
        scope,
        options.viewer
      );
      if (!actor) return null;
      const authority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: options.nowMs,
      });
      if (!authority) return null;
      if (
        context.card_status !== "open" ||
        context.fad_status !== "cards_open"
      ) {
        conflict(
          "Candidate eligible-player search is no longer available.",
          "FAD_PHASE_CONFLICT"
        );
      }
      if (
        options.nowMs >=
        context.candidate_deadline_at_ms
      ) {
        conflict(
          "The Candidate Card deadline has passed.",
          "FAD_DEADLINE_PASSED",
          {
            candidateDeadlineAtMs:
              context.candidate_deadline_at_ms,
          }
        );
      }
      if (
        !["active", "frozen"].includes(
          context.league_status
        )
      ) {
        conflict(
          "Candidate eligible-player search is unavailable in this league phase.",
          "FAD_PHASE_CONFLICT"
        );
      }
      if (
        !authority.decision
          .canEditCandidateEntries
      ) {
        return null;
      }
      const occupied = loadEntries(scope).some(
        (entry) =>
          entry.placementState === "placed" &&
          entry.slotKey ===
            options.query.slotKey
      );
      if (occupied) {
        conflict(
          "The Candidate Card slot is occupied.",
          "CANDIDATE_SLOT_OCCUPIED"
        );
      }
      const rows = eligiblePlayerPageStatement.all({
        ...scope,
        slotGroup: options.query.slotGroup,
        q: options.query.q,
        cursorName:
          options.query.cursor?.sortName ??
          null,
        cursorPlayerId:
          options.query.cursor?.playerId ??
          null,
        limitPlusOne:
          options.query.limit + 1,
      });
      const hasMore =
        rows.length > options.query.limit;
      const pageRows = rows.slice(
        0,
        options.query.limit
      );
      const data = pageRows.map((row) =>
        Object.freeze({
          player: Object.freeze({
            playerId: row.player_id,
            fullName: row.player_full_name,
            positionGroup:
              row.effective_position_group,
          }),
          effectivePositionGroup:
            row.effective_position_group,
          activeState: "active",
          benchEligible: true,
          eligibilityCode: "eligible",
          contractLimits: Object.freeze({
            allowedTermsYears:
              Object.freeze([1, 2, 3]),
            minimumTotalValueCentsByTerm:
              Object.freeze({
                1:
                  CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS,
                2:
                  CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS *
                  2,
                3:
                  CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS *
                  3,
              }),
            maximumBenchAavCents:
              options.query.slotGroup === "B"
                ? CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
                : null,
          }),
        })
      );
      const lastRow =
        hasMore && pageRows.length > 0
          ? pageRows.at(-1)
          : null;
      return deepFreeze({
        data,
        page: {
          nextCursor:
            lastRow === null
              ? null
              : encodeCandidateEligiblePlayerCursor(
                  options.query,
                  {
                    sortName:
                      lastRow.sort_name,
                    playerId:
                      lastRow.player_id,
                  }
                ),
          hasMore,
        },
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readCurrentCandidateEligiblePlayers",
        tableName: "candidate_cards",
      });
    }
  }

  function normalizePrivateCurrentRead(options) {
    exactObject(
      options,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewer",
        "nowMs",
      ],
      "route-scoped private Candidate Card read"
    );
    return Object.freeze({
      routeScope: Object.freeze({
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          options.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          options.teamId,
          "team identifier"
        ),
      }),
      viewer: normalizeViewer(options.viewer),
      nowMs: safeTimestamp(
        options.nowMs,
        "route-scoped private Candidate Card read timestamp"
      ),
    });
  }

  function readPrivateCurrent(rawOptions) {
    const options =
      normalizePrivateCurrentRead(rawOptions);
    try {
      const scope = resolveRouteScope(
        options.routeScope
      );
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = routeViewerActor(
        scope,
        options.viewer
      );
      if (!actor) return null;
      const authority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: options.nowMs,
      });
      if (!authority) return null;
      if (
        context.fad_status !== "cards_open" ||
        context.card_status !== "open"
      ) {
        conflict(
          "The private Candidate Card is no longer available.",
          "FAD_PHASE_CONFLICT"
        );
      }
      const aggregate = loadAggregate(scope);
      const evidenceByEntryId =
        loadPrivateEntryEvidence(
          scope,
          aggregate.entries
        );
      return exactPrivateProjection({
        aggregate,
        authority,
        nowMs: options.nowMs,
        evidenceByEntryId,
        scope,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readCurrentPrivateCandidateCard",
        tableName: "candidate_cards",
      });
    }
  }

  function normalizeRevisionPreviewCurrent(
    options
  ) {
    exactObject(
      options,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewer",
        "nowMs",
        "action",
      ],
      "route-scoped Candidate Card revision preview"
    );
    return Object.freeze({
      routeScope: Object.freeze({
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          options.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          options.teamId,
          "team identifier"
        ),
      }),
      viewer: normalizeViewer(options.viewer),
      nowMs: safeTimestamp(
        options.nowMs,
        "Candidate Card revision-preview timestamp"
      ),
      action:
        normalizeCandidateCardRevisionPreviewAction(
          options.action
        ),
    });
  }

  function previewRevisionCurrent(rawOptions) {
    const options =
      normalizeRevisionPreviewCurrent(
        rawOptions
      );
    try {
      const scope = resolveRouteScope(
        options.routeScope
      );
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = routeViewerActor(
        scope,
        options.viewer
      );
      if (!actor) return null;
      const authority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: options.nowMs,
      });
      if (!authority) return null;
      if (
        context.card_status !== "open" ||
        context.fad_status !== "cards_open"
      ) {
        conflict(
          "The Candidate Card revision preview is closed.",
          "FAD_PHASE_CONFLICT"
        );
      }
      if (
        options.nowMs >=
        context.candidate_deadline_at_ms
      ) {
        conflict(
          "The Candidate Card deadline has passed.",
          "FAD_DEADLINE_PASSED",
          {
            candidateDeadlineAtMs:
              context
                .candidate_deadline_at_ms,
          }
        );
      }
      if (
        !["active", "frozen"].includes(
          context.league_status
        )
      ) {
        conflict(
          "The Candidate Card league is not active.",
          "FAD_PHASE_CONFLICT"
        );
      }

      const before = loadAggregate(scope);
      const previewEntryId =
        options.action.type === "add"
          ? createCandidateCardAddPreviewEntryId({
              cardId: scope.cardId,
              baseCardVersion:
                context.card_version,
              action: {
                type: options.action.type,
                slotKey: options.action.slotKey,
                playerId: options.action.playerId,
                aavCents: options.action.aavCents,
                termYears: options.action.termYears,
              },
              existingEntryIds:
                before.entries.map(
                  ({ entryId }) => entryId
                ),
            })
          : null;
      const action = normalizeMutationAction(
        options.action.type === "add"
          ? {
              ...options.action,
              entryId: previewEntryId,
            }
          : options.action
      );
      const command = Object.freeze({
        scope,
        actor,
        nowMs: options.nowMs,
        revisionId: null,
        action,
      });
      const simulation = simulateMutation(
        command,
        before.entries
      );
      const carryoverMovePlan =
        planCarryoverOwnershipMove(
          command,
          simulation
        );
      const evaluation = calculateEvaluation(
        scope,
        simulation.entries,
        {
          activePlayerAdjustmentCents:
            carryoverMovePlan
              .activePlayerAdjustmentCents,
        }
      );
      const evidenceByEntryId =
        projectedPrivateEntryEvidence({
          scope,
          beforeEntries: before.entries,
          simulation,
          authority,
        });
      const projectedAggregate =
        Object.freeze({
          context: before.context,
          entries: simulation.entries,
          evaluation,
        });
      const projectedCard =
        exactPrivateProjection({
          aggregate: projectedAggregate,
          authority,
          nowMs: options.nowMs,
          evidenceByEntryId,
          scope,
          cardVersion:
            context.card_version + 1,
          capabilityDenialReason:
            "PREVIEW_ONLY",
        });
      const projectedSlotKey =
        options.action.type === "remove"
          ? null
          : options.action.type === "edit"
            ? simulation.currentEntry.slotKey
            : options.action.slotKey;
      const projectedSlot =
        projectedSlotKey === null
          ? null
          : projectedCard.slots.find(
              ({ slotKey: candidateSlotKey }) =>
                candidateSlotKey ===
                projectedSlotKey
            ) ?? null;
      if (
        projectedSlotKey !== null &&
        projectedSlot === null
      ) {
        incompatible(
          "The Candidate Card projected slot is unavailable.",
          "CANDIDATE_CARD_SLOT_EVIDENCE_INVALID"
        );
      }
      return deepFreeze({
        baseCardVersion:
          context.card_version,
        action: publicPreviewAction(options.action),
        projectedCard,
        projectedSlot,
        warnings: previewDiagnostics(
          evaluation,
          scope.cardId
        ),
      });
    } catch (error) {
      if (
        error?.name ===
        "CandidateCardPolicyError"
      ) {
        throw error;
      }
      throw mapRepositoryError(error, {
        operation:
          "previewCurrentCandidateCardRevision",
        tableName: "candidate_cards",
      });
    }
  }

  function normalizePrivateRead(options) {
    exactObject(
      options,
      ["scope", "actor", "nowMs"],
      "private Candidate Card read"
    );
    return Object.freeze({
      scope: normalizeScope(
        options.scope
      ),
      actor: normalizeActor(
        options.actor
      ),
      nowMs: safeTimestamp(
        options.nowMs,
        "private Candidate Card read timestamp"
      ),
    });
  }

  function readPrivate(rawOptions) {
    const options =
      normalizePrivateRead(rawOptions);
    try {
      const context =
        loadContext(options.scope);
      if (
        !context ||
        context.card_status !==
          "open" ||
        context.fad_status !==
          "cards_open" ||
        options.nowMs >=
          context.candidate_deadline_at_ms
      ) {
        return null;
      }
      const authority =
        privateAuthority({
          ...options,
          context,
        });
      if (!authority) return null;
      const aggregate =
        loadAggregate(options.scope);
      return deepFreeze({
        ...aggregate.card,
        visibilityMode:
          "private_editable",
        accessReason:
          authority.accessReason,
        authorizationEvidence:
          authority
            .authorizationEvidence,
        helpContext:
          privateHelpProjection(
            authority.help
          ),
        commissionerInterventions:
          interventionRows(
            options.scope
          ),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readPrivateCandidateCard",
        tableName: "candidate_cards",
      });
    }
  }

  function mapPublishedSnapshot(
    snapshot,
    entries,
    scope
  ) {
    return deepFreeze({
      leagueId: snapshot.league_id,
      seasonId: snapshot.season_id,
      fadId: snapshot.fad_id,
      cardId: snapshot.card_id,
      teamId: snapshot.team_id,
      snapshotId: snapshot.id,
      lockedCardVersion:
        snapshot.locked_card_version,
      visibilityMode:
        "published_history",
      accessReason:
        "published_league_history",
      authorizationEvidence: null,
      lifecycleStatus:
        snapshot.locked_status,
      completeness: {
        code:
          snapshot.completeness_code,
        filledMandatoryCount:
          snapshot
            .filled_mandatory_count,
        missingMandatoryCount:
          snapshot
            .missing_mandatory_count,
        filledBenchCount:
          snapshot.filled_bench_count,
        emptyBenchCount:
          snapshot.empty_bench_count,
        blockingValidationCount:
          snapshot
            .blocking_validation_count,
        structuralConflictCount:
          snapshot
            .structural_conflict_count,
        carriedRosterStructuralConflictCount:
          snapshot
            .carried_roster_structural_conflict_count,
      },
      capProjection: {
        capLimitCents:
          snapshot.cap_limit_cents,
        carriedActivePlayerAmountCents:
          snapshot
            .carried_active_player_amount_cents,
        retentionObligationCents:
          snapshot
            .retention_obligation_cents,
        buyoutPenaltyCents:
          snapshot
            .buyout_penalty_cents,
        carriedCapUsageCents:
          snapshot
            .carried_cap_usage_cents,
        proposedCandidateAavCents:
          snapshot
            .proposed_candidate_aav_cents,
        maximumPossibleCapCents:
          snapshot
            .maximum_possible_cap_cents,
        maximumCapSpaceCents:
          snapshot
            .maximum_cap_space_cents,
      },
      capStatus: snapshot.cap_status,
      allocationEligibility:
        snapshot.allocation_eligibility,
      allocationExclusionReason:
        snapshot
          .allocation_exclusion_reason,
      effectiveDeadlineAtMs:
        snapshot.effective_deadline_at_ms,
      processedAtMs:
        snapshot.processed_at_ms,
      entries: entries.map((row) =>
        Object.freeze({
          snapshotEntryId: row.id,
          rowKind: row.row_kind,
          occupantKind:
            row.occupant_kind,
          slotKey: slotKey(
            row.slot_group,
            row.slot_number
          ),
          sourceEntryId:
            row.source_entry_id,
          sourceEntryVersion:
            row.source_entry_version,
          playerId: row.player_id,
          effectivePositionGroup:
            row
              .effective_position_group,
          conflictCode:
            row.conflict_code,
          ownershipId:
            row.carryover_ownership_id,
          contractId:
            row.carryover_contract_id,
          sourceRosterCategory:
            row.source_roster_category,
          originalTotalValueCents:
            row
              .carryover_original_total_value_cents,
          originalTermYears:
            row
              .carryover_original_term_years,
          aavCents:
            row.carryover_aav_cents ??
            row.proposed_aav_cents,
          remainingYears:
            row.remaining_years,
          totalValueCents:
            row
              .proposed_total_value_cents,
          termYears:
            row.proposed_term_years,
          eligibilityStatus:
            row.eligibility_status,
          validationCode:
            row.validation_code,
          allocationEligibility:
            row.allocation_eligibility,
          allocationExclusionReason:
            row
              .allocation_exclusion_reason,
          lastEditedByUserId:
            row.last_edited_by_user_id,
          lastEditedByMembershipId:
            row
              .last_edited_by_membership_id,
          lastEditedByAuthority:
            row
              .last_edited_by_authority,
          lastEditedAtMs:
            row.last_edited_at_ms,
        })
      ),
      helpContext: null,
      commissionerInterventions:
        interventionRows(scope),
    });
  }

  function readPublished(rawOptions) {
    exactObject(
      rawOptions,
      ["scope", "viewer"],
      "published Candidate Card read"
    );
    const scope = normalizeScope(
      rawOptions.scope
    );
    const viewer = normalizeViewer(
      rawOptions.viewer
    );
    try {
      if (
        !membership(scope, {
          userId: viewer.userId,
          membershipId:
            viewer.membershipId,
        })
      ) {
        return null;
      }
      const snapshot = uniqueRow(
        publishedSnapshotStatement,
        scope,
        "published Candidate Card snapshot"
      );
      if (!snapshot) return null;
      const entries =
        publishedSnapshotEntriesStatement.all({
          ...scope,
          snapshotId: snapshot.id,
        });
      const slotKeys = entries
        .filter(
          ({ row_kind: rowKind }) =>
            rowKind === "slot"
        )
        .map((row) =>
          slotKey(
            row.slot_group,
            row.slot_number
          )
        );
      if (
        slotKeys.length !==
          CANDIDATE_CARD_SLOT_KEYS.length ||
        new Set(slotKeys).size !==
          CANDIDATE_CARD_SLOT_KEYS.length ||
        CANDIDATE_CARD_SLOT_KEYS.some(
          (key) => !slotKeys.includes(key)
        )
      ) {
        incompatible(
          "The published Candidate Card snapshot does not contain the exact 22-slot card shape.",
          "CANDIDATE_CARD_SNAPSHOT_INCOMPLETE"
        );
      }
      return mapPublishedSnapshot(
        snapshot,
        entries,
        scope
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readPublishedCandidateCard",
        tableName:
          "candidate_card_snapshots",
      });
    }
  }

  function helpResult(row) {
    if (!row) return null;
    return deepFreeze({
      helpRequestId: row.id,
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: row.fad_id,
      cardId: row.card_id,
      teamId: row.team_id,
      status: "active",
      message: row.message,
      requestedByUserId:
        row.requested_by_user_id,
      requestedByDisplayName:
        row.requested_by_display_name,
      requestedAtMs:
        row.requested_at_ms,
      expiresAtMs: row.expires_at_ms,
      version: 1,
    });
  }

  function assertStoredHelpData(
    value,
    scope
  ) {
    let normalizedMessage;
    try {
      normalizedMessage =
        normalizeCandidateCardHelpMessage(
          value?.message
        );
    } catch (error) {
      normalizedMessage = undefined;
    }
    if (
      !isPlainObject(value) ||
      Object.keys(value).sort().join("|") !==
        [...HELP_RESULT_KEYS].sort().join("|") ||
      !UUID_PATTERN.test(
        value.helpRequestId || ""
      ) ||
      value.leagueId !== scope.leagueId ||
      value.seasonId !== scope.seasonId ||
      value.fadId !== scope.fadId ||
      value.cardId !== scope.cardId ||
      value.teamId !== scope.teamId ||
      value.status !== "active" ||
      normalizedMessage !== value.message ||
      !UUID_PATTERN.test(
        value.requestedByUserId || ""
      ) ||
      typeof value.requestedByDisplayName !==
        "string" ||
      value.requestedByDisplayName.length < 1 ||
      value.requestedByDisplayName.length > 100 ||
      value.requestedByDisplayName.trim() !==
        value.requestedByDisplayName ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(
        value.requestedByDisplayName
      ) ||
      !Number.isSafeInteger(
        value.requestedAtMs
      ) ||
      value.requestedAtMs < 0 ||
      !Number.isSafeInteger(
        value.expiresAtMs
      ) ||
      value.expiresAtMs <=
        value.requestedAtMs ||
      value.version !== 1
    ) {
      incompatible(
        "The Candidate Card help result is not canonical.",
        "CANDIDATE_CARD_HELP_RESULT_INVALID"
      );
    }
    return deepFreeze(value);
  }

  function parseStoredHelpResult(
    row,
    {
      scope,
      actorUserId,
      requestHash,
      idempotencyRequestId,
      expectedHttpStatus,
    } = {}
  ) {
    if (
      !row ||
      row.league_id !== scope.leagueId ||
      row.season_id !== scope.seasonId ||
      row.fad_id !== scope.fadId ||
      row.card_id !== scope.cardId ||
      row.team_id !== scope.teamId ||
      (
        actorUserId !== undefined &&
        row.actor_user_id !== actorUserId
      ) ||
      (
        requestHash !== undefined &&
        row.request_sha256 !== requestHash
      ) ||
      (
        idempotencyRequestId !== undefined &&
        row.idempotency_request_id !==
          idempotencyRequestId
      ) ||
      (
        expectedHttpStatus !== undefined &&
        row.response_http_status !==
          expectedHttpStatus
      ) ||
      ![200, 201].includes(
        row.response_http_status
      ) ||
      row.actor_authority !== "manager" ||
      row.version !== 1 ||
      typeof row.response_json !== "string" ||
      sha256Text(row.response_json) !==
        row.response_sha256
    ) {
      incompatible(
        "The Candidate Card help receipt is inconsistent.",
        "CANDIDATE_CARD_HELP_RESULT_INVALID"
      );
    }
    let data;
    try {
      data = JSON.parse(row.response_json);
    } catch (error) {
      incompatible(
        "The Candidate Card help response is unreadable.",
        "CANDIDATE_CARD_HELP_RESULT_INVALID",
        error
      );
    }
    data = assertStoredHelpData(data, scope);
    if (
      data.helpRequestId !==
        row.help_request_id ||
      data.requestedByDisplayName !==
        row.requested_by_display_name
    ) {
      incompatible(
        "The Candidate Card help response is inconsistent.",
        "CANDIDATE_CARD_HELP_RESULT_INVALID"
      );
    }
    return deepFreeze({
      httpStatus:
        row.response_http_status,
      data,
    });
  }

  function normalizeHelpCommand(command) {
    exactObject(
      command,
      [
        "scope",
        "actor",
        "nowMs",
        "idempotency",
        "helpRequestId",
        "message",
      ],
      "Candidate Card help command"
    );
    const nowMs = safeTimestamp(
      command.nowMs,
      "Candidate Card help timestamp"
    );
    const actor = normalizeActor(
      command.actor
    );
    if (actor.authority !== "manager") {
      invalid(
        "Only a current manager may request Candidate Card help.",
        "CANDIDATE_CARD_MANAGER_REQUIRED"
      );
    }
    return Object.freeze({
      scope: normalizeScope(
        command.scope
      ),
      actor,
      nowMs,
      idempotency:
        normalizeIdempotency(
          Object.freeze({
            ...command.idempotency,
            clientKey:
              normalizeCandidateCardHelpIdempotencyKey(
                command.idempotency
                  ?.clientKey
              ),
          }),
          nowMs
        ),
      helpRequestId: stableId(
        command.helpRequestId,
        "Candidate Card help-request identifier"
      ),
      message:
        normalizeCandidateCardHelpMessage(
          command.message
        ),
    });
  }

  function normalizeCurrentHelpCommand(
    rawCommand
  ) {
    exactObject(
      rawCommand,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewer",
        "nowMs",
        "idempotency",
        "helpRequestId",
        "message",
      ],
      "route-scoped Candidate Card help command"
    );
    const nowMs = safeTimestamp(
      rawCommand.nowMs,
      "route-scoped Candidate Card help timestamp"
    );
    return Object.freeze({
      routeScope: Object.freeze({
        leagueId: stableId(
          rawCommand.leagueId,
          "league identifier"
        ),
        fadId: stableId(
          rawCommand.fadId,
          "Free Agent Draft identifier"
        ),
        teamId: stableId(
          rawCommand.teamId,
          "team identifier"
        ),
      }),
      viewer: normalizeViewer(
        rawCommand.viewer
      ),
      nowMs,
      idempotency:
        normalizeIdempotency(
          Object.freeze({
            ...rawCommand.idempotency,
            clientKey:
              normalizeCandidateCardHelpIdempotencyKey(
                rawCommand.idempotency
                  ?.clientKey
              ),
          }),
          nowMs
        ),
      helpRequestId: stableId(
        rawCommand.helpRequestId,
        "Candidate Card help-request identifier"
      ),
      message:
        normalizeCandidateCardHelpMessage(
          rawCommand.message
        ),
    });
  }

  function helpRequestHash(
    scope,
    message
  ) {
    return sha256({
      leagueId: scope.leagueId,
      fadId: scope.fadId,
      teamId: scope.teamId,
      message,
    });
  }

  function helpReplayIfPresent({
    command,
    requestHash,
  }) {
    const row = findIdempotency({
      scope: command.scope,
      actor: command.actor,
      operation:
        CANDIDATE_CARD_OPERATIONS.help,
      clientKey:
        command.idempotency.clientKey,
    });
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      conflict(
        "The Candidate Card help idempotency key was reused.",
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    if (
      row.status !== "completed" ||
      row.result_type !== HELP_RESULT_TYPE ||
      !UUID_PATTERN.test(row.result_id || "")
    ) {
      conflict(
        "The Candidate Card help idempotency request is unavailable.",
        "IDEMPOTENCY_REQUEST_UNAVAILABLE"
      );
    }
    const stored = uniqueRow(
      helpCommandResultStatement,
      {
        ...command.scope,
        resultId: row.result_id,
        idempotencyRequestId: row.id,
      },
      "Candidate Card help command result"
    );
    if (!stored) {
      incompatible(
        "The Candidate Card help idempotency result is missing.",
        "IDEMPOTENCY_RESULT_MISSING"
      );
    }
    return parseStoredHelpResult(stored, {
      scope: command.scope,
      actorUserId: command.actor.userId,
      requestHash,
      idempotencyRequestId: row.id,
    });
  }

  function ensureFreshHelpContext(
    context,
    command
  ) {
    if (
      context.card_status !== "open" ||
      context.fad_status !== "cards_open"
    ) {
      conflict(
        "Candidate Card help is unavailable outside the open-card phase.",
        "FAD_PHASE_CONFLICT"
      );
    }
    if (
      command.nowMs <
        context.help_opens_at_ms ||
      command.nowMs >=
        context.candidate_deadline_at_ms
    ) {
      conflict(
        "The Candidate Card help window is closed.",
        "FAD_HELP_WINDOW_CLOSED"
      );
    }
    if (context.league_status === "frozen") {
      conflict(
        "The league is operationally frozen.",
        "LEAGUE_FROZEN"
      );
    }
    if (context.league_status !== "active") {
      conflict(
        "Candidate Card help is unavailable in this league phase.",
        "FAD_PHASE_CONFLICT"
      );
    }
  }

  function helpResponseMatchesRequest(
    data,
    help
  ) {
    return (
      data.helpRequestId === help.id &&
      data.message === help.message &&
      data.requestedByUserId ===
        help.requested_by_user_id &&
      data.requestedAtMs ===
        help.requested_at_ms &&
      data.expiresAtMs ===
        help.expires_at_ms
    );
  }

  function executeHelpCommand(
    command,
    context,
    authority
  ) {
      const requestHash = helpRequestHash(
        command.scope,
        command.message
      );
      const replay = helpReplayIfPresent({
        command,
        requestHash,
      });
      if (replay) return replay;

      ensureFreshHelpContext(
        context,
        command
      );
      insertStartedIdempotency({
        scope: command.scope,
        actor: command.actor,
        idempotency:
          command.idempotency,
        operation:
          CANDIDATE_CARD_OPERATIONS.help,
        requestHash,
        nowMs: command.nowMs,
      });
      let help = currentHelp(command.scope);
      let created = false;
      if (!help) {
        if (
          insertHelpRequestStatement.run({
            ...command.scope,
            helpRequestId:
              command.helpRequestId,
            message: command.message,
            actorUserId:
              command.actor.userId,
            actorMembershipId:
              command.actor.membershipId,
            nowMs: command.nowMs,
            candidateDeadlineAtMs:
              context
                .candidate_deadline_at_ms,
          }).changes !== 1
        ) {
          conflict(
            "Candidate Card help could not be granted.",
            "FAD_HELP_WINDOW_CLOSED"
          );
        }
        help = currentHelp(command.scope);
        created = true;
        writeHelpGrantSideEffects({
          kind:
            "candidate_card_help_requested",
          scope: command.scope,
          actor: command.actor,
          managerAssignmentId:
            authority
              .authorizationEvidence.id,
          helpRequestId: help.id,
          requestedAtMs:
            command.nowMs,
          expiresAtMs:
            help.expires_at_ms,
        });
      } else if (
        help.status !== "active" ||
        command.nowMs >=
          help.expires_at_ms
      ) {
        conflict(
          "The Candidate Card help grant is no longer active.",
          "FAD_HELP_WINDOW_CLOSED"
        );
      }
      let httpStatus;
      let data;
      let responseJson;
      let responseSha256;
      if (created) {
        httpStatus = 201;
        data = helpResult(help);
        responseJson = JSON.stringify(data);
        responseSha256 =
          sha256Text(responseJson);
      } else {
        const createdReceipt = uniqueRow(
          createdHelpCommandResultStatement,
          {
            ...command.scope,
            helpRequestId: help.id,
          },
          "created Candidate Card help result"
        );
        if (!createdReceipt) {
          incompatible(
            "The created Candidate Card help result is missing.",
            "CANDIDATE_CARD_HELP_RESULT_MISSING"
          );
        }
        const original = parseStoredHelpResult(
          createdReceipt,
          {
            scope: command.scope,
            expectedHttpStatus: 201,
          }
        );
        if (
          !helpResponseMatchesRequest(
            original.data,
            help
          )
        ) {
          incompatible(
            "The active Candidate Card help request differs from its immutable result.",
            "CANDIDATE_CARD_HELP_RESULT_INVALID"
          );
        }
        httpStatus = 200;
        data = original.data;
        responseJson =
          createdReceipt.response_json;
        responseSha256 =
          createdReceipt.response_sha256;
      }
      const resultId =
        command.idempotency.requestId;
      if (
        insertHelpCommandResultStatement.run({
          ...command.scope,
          resultId,
          helpRequestId: help.id,
          idempotencyRequestId:
            command.idempotency.requestId,
          actorUserId:
            command.actor.userId,
          actorMembershipId:
            command.actor.membershipId,
          managerAssignmentId:
            authority
              .authorizationEvidence.id,
          requestHash,
          requestedByDisplayName:
            data.requestedByDisplayName,
          httpStatus,
          responseJson,
          responseSha256,
          nowMs: command.nowMs,
        }).changes !== 1
      ) {
        incompatible(
          "The Candidate Card help result could not be recorded.",
          "CANDIDATE_CARD_HELP_RESULT_MISSING"
        );
      }
      const result = deepFreeze({
        httpStatus,
        data,
      });
      if (beforeCommit) {
        beforeCommit({
          kind:
            "candidate_card_help_request",
          created,
          result,
        });
      }
      completeIdempotency({
        scope: command.scope,
        actor: command.actor,
        idempotency:
          command.idempotency,
        operation:
          CANDIDATE_CARD_OPERATIONS.help,
        requestHash,
        nowMs: command.nowMs,
        resultType: HELP_RESULT_TYPE,
        resultId,
      });
      return result;
  }

  const helpTransaction =
    database.transaction((rawCommand) => {
      const command =
        normalizeHelpCommand(rawCommand);
      const context =
        loadContext(command.scope);
      if (!context) {
        notFound(
          "The Candidate Card does not exist in the requested scope.",
          "CANDIDATE_CARD_NOT_FOUND"
        );
      }
      const authority = privateAuthority({
        scope: command.scope,
        actor: command.actor,
        context,
        nowMs: command.nowMs,
      });
      if (
        !authority ||
        authority
          .authorizationEvidence.kind !==
          "manager_assignment"
      ) {
        notFound(
          "The Candidate Card does not exist in the manager's private scope.",
          "CANDIDATE_CARD_NOT_FOUND"
        );
      }
      return executeHelpCommand(
        command,
        context,
        authority
      ).data;
    });

  const currentHelpTransaction =
    database.transaction((rawCommand) => {
      const current =
        normalizeCurrentHelpCommand(
          rawCommand
        );
      const scope = resolveRouteScope(
        current.routeScope
      );
      if (!scope) return null;
      const context = loadContext(scope);
      if (!context) return null;
      const actor = Object.freeze({
        ...current.viewer,
        authority: "manager",
      });
      const authority = privateAuthority({
        scope,
        actor,
        context,
        nowMs: current.nowMs,
      });
      if (
        !authority ||
        authority
          .authorizationEvidence.kind !==
          "manager_assignment"
      ) {
        return null;
      }
      const command = Object.freeze({
        scope,
        actor,
        nowMs: current.nowMs,
        idempotency:
          current.idempotency,
        helpRequestId:
          current.helpRequestId,
        message: current.message,
      });
      return executeHelpCommand(
        command,
        context,
        authority
      );
    });

  function normalizeCarryoverSyncCommand(
    command
  ) {
    exactObject(
      command,
      [
        "scope",
        "expectedCardVersion",
        "nowMs",
        "revisionId",
        "carryovers",
        "candidateConflicts",
        "candidateReplacements",
      ],
      "Candidate Card carryover synchronization command"
    );
    if (
      !Array.isArray(command.carryovers) ||
      !Array.isArray(
        command.candidateConflicts
      ) ||
      !Array.isArray(
        command.candidateReplacements
      )
    ) {
      invalid(
        "Candidate Card carryover synchronization arrays are required.",
        "CARRYOVER_SYNCHRONIZATION_INVALID"
      );
    }
    const carryovers =
      command.carryovers.map((carryover) =>
        validateCandidateCardCarryover(
          carryover
        )
      );
    const candidateConflicts =
      command.candidateConflicts.map(
        (conflictRow) => {
          exactObject(
            conflictRow,
            ["entryId", "conflictCode"],
            "Candidate Card conflict projection"
          );
          return Object.freeze({
            entryId: stableId(
              conflictRow.entryId,
              "conflicted Candidate entry identifier"
            ),
            conflictCode: safeCode(
              conflictRow.conflictCode,
              "Candidate conflict code"
            ),
          });
        }
      );
    const candidateReplacements =
      command.candidateReplacements.map(
        (entryId) =>
          stableId(
            entryId,
            "replaced Candidate entry identifier"
          )
      );
    for (const [description, values] of [
      [
        "carryover entry",
        carryovers.map(
          ({ entryId }) => entryId
        ),
      ],
      [
        "carryover ownership",
        carryovers.map(
          ({ ownershipId }) => ownershipId
        ),
      ],
      [
        "carryover player",
        carryovers.map(
          ({ playerId }) => playerId
        ),
      ],
      [
        "Candidate conflict",
        candidateConflicts.map(
          ({ entryId }) => entryId
        ),
      ],
      [
        "Candidate replacement",
        candidateReplacements,
      ],
    ]) {
      if (
        new Set(values).size !==
        values.length
      ) {
        invalid(
          `Candidate Card ${description} identifiers must be unique.`,
          "CARRYOVER_SYNCHRONIZATION_INVALID"
        );
      }
    }
    const conflicts =
      new Set(
        candidateConflicts.map(
          ({ entryId }) => entryId
        )
      );
    if (
      candidateReplacements.some(
        (entryId) =>
          conflicts.has(entryId)
      )
    ) {
      invalid(
        "A Candidate entry cannot be both conflicted and replaced.",
        "CARRYOVER_SYNCHRONIZATION_INVALID"
      );
    }
    return Object.freeze({
      scope: normalizeScope(command.scope),
      expectedCardVersion:
        positiveInteger(
          command.expectedCardVersion,
          "expected Candidate Card version"
        ),
      nowMs: safeTimestamp(
        command.nowMs,
        "carryover synchronization timestamp"
      ),
      revisionId: stableId(
        command.revisionId,
        "carryover synchronization revision identifier"
      ),
      carryovers: Object.freeze(
        carryovers
      ),
      candidateConflicts:
        Object.freeze(
          candidateConflicts
        ),
      candidateReplacements:
        Object.freeze(
          candidateReplacements
        ),
    });
  }

  function normalizeSummerStateCommand(command) {
    exactObject(
      command,
      [
        "scope",
        "affectedPlayerIds",
        "sourceOperationId",
        "sourceKind",
        "nowMs",
        "revisionId",
      ],
      "Candidate Card summer synchronization command"
    );
    if (
      !Array.isArray(command.affectedPlayerIds) ||
      command.affectedPlayerIds.length > 256
    ) {
      invalid(
        "A bounded affected summer player list is required.",
        "SUMMER_SYNCHRONIZATION_INVALID"
      );
    }
    const affectedPlayerIds =
      command.affectedPlayerIds.map((playerId) =>
        stableId(
          playerId,
          "affected summer player identifier"
        )
      );
    if (
      new Set(affectedPlayerIds).size !==
      affectedPlayerIds.length
    ) {
      invalid(
        "Affected summer players must be unique.",
        "SUMMER_SYNCHRONIZATION_INVALID"
      );
    }
    if (
      typeof command.sourceKind !== "string" ||
      !SUMMER_SOURCE_KIND_PATTERN.test(
        command.sourceKind
      )
    ) {
      invalid(
        "A canonical summer source kind is required.",
        "SUMMER_SYNCHRONIZATION_INVALID"
      );
    }
    return Object.freeze({
      scope: normalizeScope(command.scope),
      affectedPlayerIds: Object.freeze(
        [...affectedPlayerIds].sort()
      ),
      sourceOperationId: stableId(
        command.sourceOperationId,
        "summer source-operation identifier"
      ),
      sourceKind: command.sourceKind,
      nowMs: safeTimestamp(
        command.nowMs,
        "summer synchronization timestamp"
      ),
      revisionId: stableId(
        command.revisionId,
        "summer synchronization revision identifier"
      ),
    });
  }

  function assertAuthoritativeCarryovers(
    command
  ) {
    const rows =
      authoritativeCarryoversStatement.all(
        command.scope
      );
    for (const row of rows) {
      if (
        row.contract_id === null ||
        row.current_team_id !==
          command.scope.teamId ||
        row.contract_status !== "active" ||
        row.current_year_id === null ||
        !Number.isSafeInteger(
          row.remaining_years
        ) ||
        row.remaining_years < 1
      ) {
        conflict(
          "A current roster ownership lacks complete carryover contract evidence.",
          "CARRYOVER_EVIDENCE_INCOMPLETE",
          {
            ownershipId:
              row.ownership_id,
          }
        );
      }
    }
    const desiredByOwnership =
      new Map(
        command.carryovers.map(
          (carryover) => [
            carryover.ownershipId,
            carryover,
          ]
        )
      );
    if (
      desiredByOwnership.size !==
      rows.length
    ) {
      conflict(
        "The Candidate Card carryover projection is not the complete authoritative set.",
        "CARRYOVER_SET_MISMATCH"
      );
    }
    for (const row of rows) {
      const desired =
        desiredByOwnership.get(
          row.ownership_id
        );
      if (!desired) {
        conflict(
          "The Candidate Card carryover projection omitted an authoritative ownership.",
          "CARRYOVER_SET_MISMATCH"
        );
      }
      const desiredSlot =
        parseCandidateCardSlotKey(
          desired.slotKey
        );
      if (
        desired.playerId !==
          row.player_id ||
        desired.contractId !==
          row.contract_id ||
        desired.effectivePositionGroup !==
          row.position_group ||
        desired.sourceRosterCategory !==
          row.roster_category ||
        desired.contractType !==
          row.contract_type ||
        desired.originalTotalValueCents !==
          row.original_total_value_cents ||
        desired.originalTermYears !==
          row.original_term_years ||
        desired.aavCents !==
          row.aav_cents ||
        desired.remainingYears !==
          row.remaining_years ||
        (
          row.slot_number !== null &&
          row.roster_category !==
            "Injured Reserve" &&
          row.slot_number !==
            desiredSlot.slotNumber
        )
      ) {
        conflict(
          "The Candidate Card carryover projection changed authoritative ownership or contract evidence.",
          "CANDIDATE_CARRYOVER_LOCKED",
          {
            ownershipId:
              row.ownership_id,
          }
        );
      }
    }
  }

  function synchronizedCarryoverEntry({
    desired,
    current,
    nowMs,
  }) {
    const descriptor = {
      entryId: desired.entryId,
      entryVersion:
        current
          ? current.entryVersion
          : 1,
      entryKind: "carryover",
      playerId: desired.playerId,
      effectivePositionGroup:
        desired
          .effectivePositionGroup,
      slotKey: desired.slotKey,
      placementState:
        desired.placementState,
      conflictCode:
        desired.conflictCode,
      ownershipId: desired.ownershipId,
      contractId: desired.contractId,
      sourceRosterCategory:
        desired.sourceRosterCategory,
      contractType:
        desired.contractType,
      originalTotalValueCents:
        desired
          .originalTotalValueCents,
      originalTermYears:
        desired.originalTermYears,
      aavCents: desired.aavCents,
      remainingYears:
        desired.remainingYears,
      totalValueCents: null,
      termYears: null,
      eligibilityStatus: null,
      validationCode: null,
      createdByUserId:
        current?.createdByUserId ??
        null,
      createdByMembershipId:
        current
          ?.createdByMembershipId ??
        null,
      createdByAuthority:
        current?.createdByAuthority ??
        "system",
      lastEditedByUserId:
        current?.lastEditedByUserId ??
        null,
      lastEditedByMembershipId:
        current
          ?.lastEditedByMembershipId ??
        null,
      lastEditedByAuthority:
        current
          ?.lastEditedByAuthority ??
        "system",
      lastAcknowledgementRevisionId:
        null,
      createdAtMs:
        current?.createdAtMs ?? nowMs,
      updatedAtMs:
        current?.updatedAtMs ?? nowMs,
    };
    if (
      current &&
      isDeepStrictEqual(
        domainEntry(current),
        domainEntry(descriptor)
      )
    ) {
      return Object.freeze(descriptor);
    }
    return Object.freeze({
      ...descriptor,
      entryVersion:
        current
          ? current.entryVersion + 1
          : 1,
      lastEditedByUserId: null,
      lastEditedByMembershipId: null,
      lastEditedByAuthority: "system",
      updatedAtMs: nowMs,
    });
  }

  function simulateCarryoverSync(
    command,
    currentEntries
  ) {
    const currentCandidates =
      currentEntries.filter(
        ({ entryKind }) =>
          entryKind === "candidate"
      );
    const currentCarryovers =
      currentEntries.filter(
        ({ entryKind }) =>
          entryKind === "carryover"
      );
    const conflicts = new Map(
      command.candidateConflicts.map(
        (row) => [row.entryId, row]
      )
    );
    const replacements = new Set(
      command.candidateReplacements
    );
    const desiredByPlayer = new Map(
      command.carryovers.map(
        (carryover) => [
          carryover.playerId,
          carryover,
        ]
      )
    );
    const desiredPlacedSlots = new Set(
      command.carryovers
        .filter(
          ({ placementState }) =>
            placementState === "placed"
        )
        .map(({ slotKey: key }) => key)
    );
    for (const entryId of replacements) {
      const candidate =
        currentCandidates.find(
          (entry) =>
            entry.entryId === entryId
        );
      if (
        !candidate ||
        !desiredByPlayer.has(
          candidate.playerId
        )
      ) {
        conflict(
          "A replaced Candidate must become the same player's authoritative carryover.",
          "CARRYOVER_REPLACEMENT_INVALID"
        );
      }
    }
    for (const conflictRow of conflicts.values()) {
      const candidate =
        currentCandidates.find(
          (entry) =>
            entry.entryId ===
            conflictRow.entryId
        );
      if (
        !candidate ||
        candidate.placementState !==
          "placed" ||
        !desiredPlacedSlots.has(
          candidate.slotKey
        )
      ) {
        conflict(
          "A Candidate conflict must be caused by an authoritative carryover claiming its exact slot.",
          "CARRYOVER_CONFLICT_INVALID"
        );
      }
    }
    const nextCandidates = [];
    for (const candidate of currentCandidates) {
      if (replacements.has(candidate.entryId)) {
        continue;
      }
      const conflictRow = conflicts.get(
        candidate.entryId
      );
      if (!conflictRow) {
        nextCandidates.push(candidate);
        continue;
      }
      nextCandidates.push(
        Object.freeze({
          ...candidate,
          entryVersion:
            candidate.entryVersion + 1,
          placementState: "conflict",
          conflictCode:
            conflictRow.conflictCode,
          eligibilityStatus: "invalid",
          validationCode:
            conflictRow.conflictCode,
          lastEditedByUserId: null,
          lastEditedByMembershipId: null,
          lastEditedByAuthority:
            "system",
          lastAcknowledgementRevisionId:
            null,
          updatedAtMs: command.nowMs,
        })
      );
    }
    const currentByOwnership = new Map(
      currentCarryovers.map(
        (entry) => [
          entry.ownershipId,
          entry,
        ]
      )
    );
    const nextCarryovers =
      command.carryovers.map((desired) => {
        const current =
          currentByOwnership.get(
            desired.ownershipId
          ) ?? null;
        if (
          current &&
          (
            current.playerId !==
              desired.playerId ||
            current.contractId !==
              desired.contractId ||
            current.entryId !==
              desired.entryId
          )
        ) {
          conflict(
            "A carryover identity or contract cannot be replaced during synchronization.",
            "CANDIDATE_CARRYOVER_LOCKED"
          );
        }
        return synchronizedCarryoverEntry({
          desired,
          current,
          nowMs: command.nowMs,
        });
      });

    for (const next of nextCarryovers) {
      const currentOccupant =
        currentCarryovers.find(
          (entry) =>
            entry.placementState ===
              "placed" &&
            entry.slotKey ===
              next.slotKey &&
            entry.entryId !== next.entryId
        );
      if (
        currentOccupant &&
        command.carryovers.some(
          (desired) =>
            desired.entryId ===
              currentOccupant.entryId
        )
      ) {
        conflict(
          "A multi-carryover slot cycle requires the dedicated roster-reconciliation workflow.",
          "CARRYOVER_SLOT_CYCLE_REQUIRES_RECONCILIATION"
        );
      }
    }
    return Object.freeze({
      entries: Object.freeze([
        ...nextCandidates,
        ...nextCarryovers,
      ]),
      currentCandidates:
        Object.freeze(currentCandidates),
      currentCarryovers:
        Object.freeze(currentCarryovers),
      nextCarryovers:
        Object.freeze(nextCarryovers),
      conflicts,
      replacements,
    });
  }

  function syncReplayIfPresent(
    command,
    requestHash
  ) {
    const row = uniqueRow(
      revisionResultStatement,
      {
        ...command.scope,
        resultId:
          command.revisionId,
      },
      "Candidate Card carryover synchronization replay"
    );
    if (!row) return null;
    if (
      row.action !==
      "carryover_synchronized"
    ) {
      conflict(
        "The Candidate Card revision identifier was reused.",
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    let evidence;
    try {
      evidence = JSON.parse(
        row.after_evidence_json
      );
    } catch (error) {
      incompatible(
        "The carryover synchronization replay evidence is invalid.",
        "REVISION_RESULT_INVALID",
        error
      );
    }
    if (
      !isPlainObject(evidence) ||
      evidence.requestHash !==
        requestHash ||
      !isPlainObject(evidence.result)
    ) {
      conflict(
        "The Candidate Card carryover revision was reused for another intent.",
        "IDEMPOTENCY_KEY_REUSED"
      );
    }
    return assertStoredRevisionResult(
      deepFreeze(evidence.result),
      command.scope,
      row,
      "candidate_card.carryover_sync"
    );
  }

  function applyCarryoverSyncEntries(
    command,
    simulation
  ) {
    for (const conflictRow of command
      .candidateConflicts) {
      const current =
        simulation.currentCandidates.find(
          (entry) =>
            entry.entryId ===
            conflictRow.entryId
        );
      if (
        updateCandidateConflictStatement.run({
          ...command.scope,
          entryId: current.entryId,
          expectedEntryVersion:
            current.entryVersion,
          conflictCode:
            conflictRow.conflictCode,
          nowMs: command.nowMs,
        }).changes !== 1
      ) {
        conflict(
          "A Candidate entry changed during carryover synchronization.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const entryId of command
      .candidateReplacements) {
      const current =
        simulation.currentCandidates.find(
          (entry) =>
            entry.entryId === entryId
        );
      if (
        deleteCandidateStatement.run({
          ...command.scope,
          entryId,
          expectedEntryVersion:
            current.entryVersion,
        }).changes !== 1
      ) {
        conflict(
          "A replaced Candidate changed during carryover synchronization.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    const desiredOwnerships = new Set(
      command.carryovers.map(
        ({ ownershipId }) => ownershipId
      )
    );
    for (const current of simulation
      .currentCarryovers) {
      if (
        desiredOwnerships.has(
          current.ownershipId
        )
      ) {
        continue;
      }
      if (
        deleteStaleCarryoverStatement.run({
          ...command.scope,
          entryId: current.entryId,
          expectedEntryVersion:
            current.entryVersion,
        }).changes !== 1
      ) {
        conflict(
          "A stale carryover could not be removed after its ownership ended.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const desired of command.carryovers) {
      const current =
        simulation.currentCarryovers.find(
          (entry) =>
            entry.ownershipId ===
            desired.ownershipId
        ) ?? null;
      const next =
        simulation.nextCarryovers.find(
          (entry) =>
            entry.ownershipId ===
            desired.ownershipId
        );
      const slot =
        parseCandidateCardSlotKey(
          desired.slotKey
        );
      if (!current) {
        if (
          insertCarryoverStatement.run({
            ...command.scope,
            entryId: desired.entryId,
            playerId:
              desired.playerId,
            effectivePositionGroup:
              desired
                .effectivePositionGroup,
            slotGroup: slot.slotGroup,
            slotNumber: slot.slotNumber,
            placementState:
              desired.placementState,
            conflictCode:
              desired.conflictCode,
            ownershipId:
              desired.ownershipId,
            contractId:
              desired.contractId,
            sourceRosterCategory:
              desired.sourceRosterCategory,
            originalTotalValueCents:
              desired
                .originalTotalValueCents,
            originalTermYears:
              desired
                .originalTermYears,
            aavCents:
              desired.aavCents,
            remainingYears:
              desired.remainingYears,
            nowMs: command.nowMs,
          }).changes !== 1
        ) {
          conflict(
            "An authoritative carryover could not be inserted.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      } else if (
        next.entryVersion !==
        current.entryVersion
      ) {
        if (
          updateSynchronizedCarryoverStatement.run(
            {
              ...command.scope,
              entryId: current.entryId,
              expectedEntryVersion:
                current.entryVersion,
              playerId:
                current.playerId,
              ownershipId:
                current.ownershipId,
              contractId:
                current.contractId,
              slotGroup:
                slot.slotGroup,
              slotNumber:
                slot.slotNumber,
              placementState:
                desired.placementState,
              conflictCode:
                desired.conflictCode,
              sourceRosterCategory:
                desired
                  .sourceRosterCategory,
              nowMs: command.nowMs,
            }
          ).changes !== 1
        ) {
          conflict(
            "An authoritative carryover changed during synchronization.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      }
    }
  }

  const carryoverSyncTransaction =
    database.transaction((rawCommand) => {
      const command =
        normalizeCarryoverSyncCommand(
          rawCommand
        );
      const requestHash = sha256({
        scope: command.scope,
        expectedCardVersion:
          command.expectedCardVersion,
        carryovers: command.carryovers,
        candidateConflicts:
          command.candidateConflicts,
        candidateReplacements:
          command.candidateReplacements,
      });
      const replay =
        syncReplayIfPresent(
          command,
          requestHash
        );
      if (replay) return replay;

      const before =
        loadAggregate(command.scope, {
          requireSummaryMatch: false,
        });
      if (!before) {
        notFound(
          "The Candidate Card does not exist in the requested scope.",
          "CANDIDATE_CARD_NOT_FOUND"
        );
      }
      if (
        before.context.card_status !==
          "open" ||
        before.context.fad_status !==
          "cards_open" ||
        command.nowMs >=
          before.context
            .candidate_deadline_at_ms
      ) {
        conflict(
          "Summer carryover synchronization is closed.",
          "FAD_PHASE_CONFLICT"
        );
      }
      if (
        before.context.league_status ===
          "frozen"
      ) {
        conflict(
          "The league is operationally frozen.",
          "LEAGUE_FROZEN"
        );
      }
      if (
        before.context.card_version !==
        command.expectedCardVersion
      ) {
        conflict(
          "The Candidate Card version is stale.",
          "CANDIDATE_CARD_PRECONDITION_FAILED",
          {
            currentCardVersion:
              before.context.card_version,
          }
        );
      }
      assertAuthoritativeCarryovers(
        command
      );
      const simulation =
        simulateCarryoverSync(
          command,
          before.entries
        );
      const evaluation =
        calculateEvaluation(
          command.scope,
          simulation.entries
        );
      const expectedCard =
        projectionFromEvaluation({
          context: before.context,
          evaluation,
          entries: simulation.entries,
          cardVersion:
            command.expectedCardVersion + 1,
        });
      const result = deepFreeze({
        card: expectedCard,
        revisionId:
          command.revisionId,
        changedEntryId: null,
      });
      updateCard(command, evaluation);
      if (
        insertSystemRevisionStatement.run({
          ...command.scope,
          revisionId:
            command.revisionId,
          resultingCardVersion:
            command.expectedCardVersion +
            1,
          action: "carryover_synchronized",
          beforeEvidenceJson:
            canonicalJson({
              card: before.card,
            }),
          afterEvidenceJson:
            canonicalJson({
              requestHash,
              result,
            }),
          warningCodesJson:
            canonicalJson(
              warningCodes(evaluation)
            ),
          nowMs: command.nowMs,
        }).changes !== 1
      ) {
        conflict(
          "The carryover synchronization revision could not be recorded.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
      applyCarryoverSyncEntries(
        command,
        simulation
      );
      const after =
        loadAggregate(command.scope);
      if (
        after.context.card_version !==
          command.expectedCardVersion + 1 ||
        !isDeepStrictEqual(
          after.card,
          expectedCard
        )
      ) {
        incompatible(
          "Carryover synchronization did not reproduce its approved projection.",
          "CANDIDATE_CARD_RESULT_DRIFT"
        );
      }
      writeMutationSideEffects({
        kind:
          "candidate_card_carryovers_synchronized",
        scope: command.scope,
        actor: Object.freeze({
          userId: null,
          membershipId: null,
          authority: "system",
        }),
        action:
          "carryover_synchronized",
        revisionId:
          command.revisionId,
        cardVersion:
          after.context.card_version,
        changedAtMs: command.nowMs,
      });
      if (beforeCommit) {
        beforeCommit({
          kind:
            "candidate_card_carryover_synchronization",
          result,
        });
      }
      return result;
    });

  function summerSummaryMatches(context, evaluation) {
    return (
      context.completeness_code ===
        evaluation.completeness.code &&
      context.filled_mandatory_count ===
        evaluation.completeness.filledMandatory &&
      context.missing_mandatory_count ===
        evaluation.completeness.missingMandatory &&
      context.filled_bench_count ===
        evaluation.completeness.filledBench &&
      context.empty_bench_count ===
        evaluation.completeness.emptyBench &&
      context.blocking_validation_count ===
        evaluation.completeness.blockingValidationCount &&
      context.structural_conflict_count ===
        evaluation.completeness.structuralConflictCount &&
      context.carried_roster_structural_conflict_count ===
        evaluation.completeness
          .carriedRosterStructuralConflictCount &&
      context.maximum_possible_cap_cents ===
        evaluation.capProjection.maximumPossibleCapCents &&
      context.cap_status === evaluation.capStatus &&
      context.allocation_eligibility ===
        evaluation.allocationEligibility &&
      context.allocation_exclusion_reason ===
        evaluation.allocationExclusionReason
    );
  }

  function summerEffectivePosition(scope, row) {
    const player = uniqueRow(
      playerEligibilityStatement,
      {
        leagueId: scope.leagueId,
        playerId: row.player_id,
      },
      "summer carryover player"
    );
    const position =
      player?.override_position_group ??
      player?.source_position_group ??
      row.position_group;
    if (!["F", "D"].includes(position)) {
      conflict(
        "A summer carryover lacks one effective position.",
        "CARRYOVER_EVIDENCE_INCOMPLETE",
        { ownershipId: row.ownership_id }
      );
    }
    return position;
  }

  function lowestSummerSlot(used, slotGroup) {
    const maximum =
      slotGroup === "F"
        ? 12
        : slotGroup === "D"
          ? 6
          : 4;
    for (let number = 1; number <= maximum; number += 1) {
      const key = slotKey(slotGroup, number);
      if (!used.has(key)) return key;
    }
    return null;
  }

  function summerCarryoverCompatible(entry, row, position) {
    if (!entry || entry.placementState !== "placed") {
      return false;
    }
    const slot = parseCandidateCardSlotKey(entry.slotKey);
    if (
      slot.slotGroup === "B" &&
      row.aav_cents >
        CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
    ) {
      return false;
    }
    if (
      slot.slotGroup !== "B" &&
      slot.slotGroup !== position
    ) {
      return false;
    }
    if (
      row.roster_category === "Bench" &&
      slot.slotGroup !== "B"
    ) {
      return false;
    }
    if (
      row.roster_category === "Active" &&
      slot.slotGroup !== position
    ) {
      return false;
    }
    return true;
  }

  function planSummerCarryovers(command, currentEntries) {
    const rows = authoritativeCarryoversStatement.all(
      command.scope
    );
    const current = currentEntries.filter(
      ({ entryKind }) => entryKind === "carryover"
    );
    const currentByOwnership = new Map(
      current.map((entry) => [entry.ownershipId, entry])
    );
    const used = new Set();
    const desired = [];
    for (const row of rows) {
      if (
        row.contract_id === null ||
        row.current_team_id !== command.scope.teamId ||
        row.contract_status !== "active" ||
        row.current_year_id === null ||
        !Number.isSafeInteger(row.remaining_years) ||
        row.remaining_years < 1
      ) {
        conflict(
          "A current roster ownership lacks complete carryover contract evidence.",
          "CARRYOVER_EVIDENCE_INCOMPLETE",
          { ownershipId: row.ownership_id }
        );
      }
      const position = summerEffectivePosition(
        command.scope,
        row
      );
      const existing =
        currentByOwnership.get(row.ownership_id) ?? null;
      let requestedSlot =
        summerCarryoverCompatible(existing, row, position) &&
        !used.has(existing.slotKey)
          ? existing.slotKey
          : null;
      if (requestedSlot === null) {
        const preferredGroup =
          row.roster_category === "Bench" ? "B" : position;
        const preferred =
          row.roster_category !== "Injured Reserve" &&
          Number.isSafeInteger(row.slot_number)
            ? slotKey(preferredGroup, row.slot_number)
            : null;
        if (
          preferred !== null &&
          CANDIDATE_CARD_SLOT_KEYS.includes(preferred) &&
          !used.has(preferred) &&
          !(
            preferredGroup === "B" &&
            row.aav_cents >
              CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
          )
        ) {
          requestedSlot = preferred;
        } else if (
          preferredGroup !== "B" ||
          row.aav_cents <=
            CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
        ) {
          requestedSlot = lowestSummerSlot(
            used,
            preferredGroup
          );
        }
      }
      const placed = requestedSlot !== null;
      const finalSlot =
        requestedSlot ??
        slotKey(
          row.roster_category === "Bench" ? "B" : position,
          1
        );
      if (placed) used.add(finalSlot);
      const descriptor = {
        entryId:
          existing?.entryId ??
          deterministicUuid(
            `${command.scope.cardId}:carryover:${row.ownership_id}`
          ),
        entryVersion: existing?.entryVersion ?? 1,
        entryKind: "carryover",
        playerId: row.player_id,
        effectivePositionGroup: position,
        slotKey: finalSlot,
        placementState: placed ? "placed" : "conflict",
        conflictCode: placed
          ? null
          : "CARRYOVER_SLOT_CONFLICT",
        ownershipId: row.ownership_id,
        contractId: row.contract_id,
        sourceRosterCategory: row.roster_category,
        contractType: row.contract_type,
        originalTotalValueCents:
          row.original_total_value_cents,
        originalTermYears: row.original_term_years,
        aavCents: row.aav_cents,
        remainingYears: row.remaining_years,
        totalValueCents: null,
        termYears: null,
        eligibilityStatus: null,
        validationCode: null,
        createdByUserId: existing?.createdByUserId ?? null,
        createdByMembershipId:
          existing?.createdByMembershipId ?? null,
        createdByAuthority:
          existing?.createdByAuthority ?? "system",
        lastEditedByUserId:
          existing?.lastEditedByUserId ?? null,
        lastEditedByMembershipId:
          existing?.lastEditedByMembershipId ?? null,
        lastEditedByAuthority:
          existing?.lastEditedByAuthority ?? "system",
        lastAcknowledgementRevisionId: null,
        createdAtMs: existing?.createdAtMs ?? command.nowMs,
        updatedAtMs: existing?.updatedAtMs ?? command.nowMs,
      };
      if (
        existing &&
        !isDeepStrictEqual(
          domainEntry(existing),
          domainEntry(descriptor)
        )
      ) {
        descriptor.entryVersion = existing.entryVersion + 1;
        descriptor.lastEditedByUserId = null;
        descriptor.lastEditedByMembershipId = null;
        descriptor.lastEditedByAuthority = "system";
        descriptor.updatedAtMs = command.nowMs;
      }
      desired.push(Object.freeze(descriptor));
    }
    return Object.freeze({
      current: Object.freeze(current),
      desired: Object.freeze(desired),
      placedSlots: new Set(
        desired
          .filter(({ placementState }) =>
            placementState === "placed"
          )
          .map(({ slotKey: key }) => key)
      ),
      playerIds: new Set(
        desired.map(({ playerId }) => playerId)
      ),
    });
  }

  function planSummerCandidates(
    command,
    currentEntries,
    carryoverPlan
  ) {
    const used = new Set(carryoverPlan.placedSlots);
    const removed = [];
    const desired = [];
    const current = currentEntries.filter(
      ({ entryKind }) => entryKind === "candidate"
    );
    for (const entry of [...current].sort((left, right) =>
      left.entryId.localeCompare(right.entryId)
    )) {
      if (carryoverPlan.playerIds.has(entry.playerId)) {
        removed.push(entry);
        continue;
      }
      const inspected = inspectSelectablePlayer(
        command.scope,
        entry.playerId,
        entry.slotKey
      );
      const observedPositionGroup =
        inspected?.effectivePositionGroup ??
        entry.effectivePositionGroup;
      const slot = parseCandidateCardSlotKey(entry.slotKey);
      const compatible =
        ["F", "D"].includes(observedPositionGroup) &&
        (
          slot.slotGroup === "B" ||
          slot.slotGroup === observedPositionGroup
        );
      const effectivePositionGroup = compatible
        ? observedPositionGroup
        : entry.effectivePositionGroup;
      let placementState = "placed";
      let conflictCode = null;
      if (!compatible) {
        placementState = "conflict";
        conflictCode = "CANDIDATE_SLOT_INCOMPATIBLE";
      } else if (used.has(entry.slotKey)) {
        placementState = "conflict";
        conflictCode = carryoverPlan.placedSlots.has(
          entry.slotKey
        )
          ? "CANDIDATE_SLOT_CLAIMED_BY_CARRYOVER"
          : "CANDIDATE_SLOT_CONFLICT";
      } else {
        used.add(entry.slotKey);
      }
      const eligibilityStatus =
        placementState === "conflict" ||
        inspected?.eligible === false
          ? "invalid"
          : inspected?.eligible === true
            ? "valid"
            : entry.eligibilityStatus;
      const validationCode =
        conflictCode ??
        (inspected?.eligible === false
          ? inspected.reasonCode
          : inspected?.eligible === true
            ? null
            : entry.validationCode);
      const descriptor = {
        ...entry,
        effectivePositionGroup,
        placementState,
        conflictCode,
        eligibilityStatus,
        validationCode,
      };
      if (
        !isDeepStrictEqual(
          domainEntry(entry),
          domainEntry(descriptor)
        )
      ) {
        descriptor.entryVersion = entry.entryVersion + 1;
        descriptor.lastEditedByUserId = null;
        descriptor.lastEditedByMembershipId = null;
        descriptor.lastEditedByAuthority = "system";
        descriptor.lastAcknowledgementRevisionId = null;
        descriptor.updatedAtMs = command.nowMs;
      }
      desired.push(Object.freeze(descriptor));
    }
    return Object.freeze({
      current: Object.freeze(current),
      desired: Object.freeze(desired),
      removed: Object.freeze(removed),
    });
  }

  function logicalEntrySet(entries) {
    return entries
      .map(domainEntry)
      .sort((left, right) =>
        left.entryId.localeCompare(right.entryId)
      );
  }

  function applySummerEntries(
    command,
    carryoverPlan,
    candidatePlan
  ) {
    for (const entry of candidatePlan.removed) {
      if (
        deleteCandidateStatement.run({
          ...command.scope,
          entryId: entry.entryId,
          expectedEntryVersion: entry.entryVersion,
        }).changes !== 1
      ) {
        conflict(
          "A Candidate-to-carryover transition changed concurrently.",
          "CANDIDATE_CARD_PRECONDITION_FAILED"
        );
      }
    }
    for (const next of candidatePlan.desired) {
      const previous = candidatePlan.current.find(
        ({ entryId }) => entryId === next.entryId
      );
      if (
        next.entryVersion !== previous.entryVersion &&
        next.placementState === "conflict"
      ) {
        if (
          updateSummerCandidateStatement.run({
            ...command.scope,
            entryId: next.entryId,
            expectedEntryVersion: previous.entryVersion,
            effectivePositionGroup:
              next.effectivePositionGroup,
            placementState: next.placementState,
            conflictCode: next.conflictCode,
            eligibilityStatus: next.eligibilityStatus,
            validationCode: next.validationCode,
            nowMs: command.nowMs,
          }).changes !== 1
        ) {
          conflict(
            "A Candidate changed during summer synchronization.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      }
    }
    const desiredOwnerships = new Set(
      carryoverPlan.desired.map(({ ownershipId }) => ownershipId)
    );
    for (const previous of carryoverPlan.current) {
      if (!desiredOwnerships.has(previous.ownershipId)) {
        if (
          deleteStaleCarryoverStatement.run({
            ...command.scope,
            entryId: previous.entryId,
            expectedEntryVersion: previous.entryVersion,
          }).changes !== 1
        ) {
          conflict(
            "A stale summer carryover could not be removed.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      }
    }
    for (const next of carryoverPlan.desired) {
      const previous = carryoverPlan.current.find(
        ({ ownershipId }) => ownershipId === next.ownershipId
      );
      const slot = parseCandidateCardSlotKey(next.slotKey);
      if (!previous) {
        if (
          insertCarryoverStatement.run({
            ...command.scope,
            entryId: next.entryId,
            playerId: next.playerId,
            effectivePositionGroup:
              next.effectivePositionGroup,
            slotGroup: slot.slotGroup,
            slotNumber: slot.slotNumber,
            placementState: next.placementState,
            conflictCode: next.conflictCode,
            ownershipId: next.ownershipId,
            contractId: next.contractId,
            sourceRosterCategory:
              next.sourceRosterCategory,
            originalTotalValueCents:
              next.originalTotalValueCents,
            originalTermYears: next.originalTermYears,
            aavCents: next.aavCents,
            remainingYears: next.remainingYears,
            nowMs: command.nowMs,
          }).changes !== 1
        ) {
          conflict(
            "A summer carryover could not be inserted.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      } else if (next.entryVersion !== previous.entryVersion) {
        if (
          updateSummerCarryoverStatement.run({
            ...command.scope,
            entryId: previous.entryId,
            expectedEntryVersion: previous.entryVersion,
            playerId: next.playerId,
            effectivePositionGroup:
              next.effectivePositionGroup,
            slotGroup: slot.slotGroup,
            slotNumber: slot.slotNumber,
            placementState: next.placementState,
            conflictCode: next.conflictCode,
            ownershipId: next.ownershipId,
            contractId: next.contractId,
            sourceRosterCategory:
              next.sourceRosterCategory,
            originalTotalValueCents:
              next.originalTotalValueCents,
            originalTermYears: next.originalTermYears,
            aavCents: next.aavCents,
            remainingYears: next.remainingYears,
            nowMs: command.nowMs,
          }).changes !== 1
        ) {
          conflict(
            "A summer carryover changed concurrently.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      }
    }
    for (const next of candidatePlan.desired) {
      const previous = candidatePlan.current.find(
        ({ entryId }) => entryId === next.entryId
      );
      if (
        next.entryVersion !== previous.entryVersion &&
        next.placementState !== "conflict"
      ) {
        if (
          updateSummerCandidateStatement.run({
            ...command.scope,
            entryId: next.entryId,
            expectedEntryVersion: previous.entryVersion,
            effectivePositionGroup:
              next.effectivePositionGroup,
            placementState: next.placementState,
            conflictCode: next.conflictCode,
            eligibilityStatus: next.eligibilityStatus,
            validationCode: next.validationCode,
            nowMs: command.nowMs,
          }).changes !== 1
        ) {
          conflict(
            "A Candidate changed during summer synchronization.",
            "CANDIDATE_CARD_PRECONDITION_FAILED"
          );
        }
      }
    }
  }

  function executeSummerStateSync(rawCommand) {
    if (database.inTransaction !== true) {
      invalid(
        "Candidate Card summer synchronization requires an existing SQLite transaction.",
        "SUMMER_SYNCHRONIZATION_TRANSACTION_REQUIRED"
      );
    }
    const command = normalizeSummerStateCommand(rawCommand);
    const before = loadAggregate(command.scope, {
      requireSummaryMatch: false,
    });
    if (!before) {
      notFound(
        "The Candidate Card does not exist in the requested scope.",
        "CANDIDATE_CARD_NOT_FOUND"
      );
    }
    if (
      before.context.card_status !== "open" ||
      before.context.fad_status !== "cards_open"
    ) {
      conflict(
        "Candidate Card summer synchronization is closed.",
        "FAD_PHASE_CONFLICT"
      );
    }
    const carryoverPlan = planSummerCarryovers(
      command,
      before.entries
    );
    const candidatePlan = planSummerCandidates(
      command,
      before.entries,
      carryoverPlan
    );
    const nextEntries = Object.freeze([
      ...candidatePlan.desired,
      ...carryoverPlan.desired,
    ]);
    const evaluation = calculateEvaluation(
      command.scope,
      nextEntries
    );
    const carryoverChanged = !isDeepStrictEqual(
      logicalEntrySet(carryoverPlan.current),
      logicalEntrySet(carryoverPlan.desired)
    );
    const eligibilityChanged =
      candidatePlan.removed.length > 0 ||
      !isDeepStrictEqual(
        logicalEntrySet(candidatePlan.current),
        logicalEntrySet(candidatePlan.desired)
      );
    const summaryChanged = !summerSummaryMatches(
      before.context,
      evaluation
    );
    if (
      !carryoverChanged &&
      !eligibilityChanged &&
      !summaryChanged
    ) {
      return Object.freeze({
        changed: false,
        action: null,
        cardVersion: before.context.card_version,
        revisionId: null,
      });
    }
    const action =
      carryoverChanged && eligibilityChanged
        ? "summer_state_synchronized"
        : summaryChanged &&
            !carryoverChanged &&
            !eligibilityChanged
          ? "summer_state_synchronized"
        : eligibilityChanged
          ? "eligibility_revalidated"
          : "carryover_synchronized";
    applySummerEntries(
      command,
      carryoverPlan,
      candidatePlan
    );
    updateCard(
      {
        scope: command.scope,
        expectedCardVersion: before.context.card_version,
        nowMs: command.nowMs,
      },
      evaluation,
      updateSummerCardStatement
    );
    const result = Object.freeze({
      changed: true,
      action,
      cardVersion: before.context.card_version + 1,
      revisionId: command.revisionId,
    });
    if (
      insertSystemRevisionStatement.run({
        ...command.scope,
        revisionId: command.revisionId,
        resultingCardVersion: result.cardVersion,
        action,
        beforeEvidenceJson: canonicalJson({
          card: before.card,
        }),
        afterEvidenceJson: canonicalJson({
          affectedPlayerIds: command.affectedPlayerIds,
          result,
          sourceKind: command.sourceKind,
          sourceOperationId: command.sourceOperationId,
        }),
        warningCodesJson: canonicalJson(
          warningCodes(evaluation)
        ),
        nowMs: command.nowMs,
      }).changes !== 1
    ) {
      conflict(
        "The summer synchronization revision could not be recorded.",
        "CANDIDATE_CARD_PRECONDITION_FAILED"
      );
    }
    const after = loadAggregate(command.scope);
    if (after.context.card_version !== result.cardVersion) {
      incompatible(
        "Summer synchronization did not produce its approved card version.",
        "CANDIDATE_CARD_RESULT_DRIFT"
      );
    }
    const kind =
      action === "carryover_synchronized"
        ? "candidate_card_carryovers_synchronized"
        : action === "eligibility_revalidated"
          ? "candidate_card_eligibility_revalidated"
          : "candidate_card_summer_state_synchronized";
    writeMutationSideEffects({
      kind,
      scope: command.scope,
      actor: Object.freeze({
        userId: null,
        membershipId: null,
        authority: "system",
      }),
      action,
      revisionId: command.revisionId,
      cardVersion: result.cardVersion,
      changedAtMs: command.nowMs,
    });
    if (beforeCommit) {
      beforeCommit({
        kind: "candidate_card_summer_state_synchronization",
        result,
      });
    }
    return result;
  }

  return Object.freeze({
    previewRevisionCurrent,
    readEligiblePlayersCurrent,
    readPrivateCurrent,
    readPrivate,
    readPublished,

    mutateCurrent(rawCommand) {
      try {
        return currentMutationTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "mutateCurrentCandidateCard",
          tableName: "candidate_cards",
        });
      }
    },

    saveCurrent(rawCommand) {
      try {
        return currentWholeSaveTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "saveCurrentCandidateCard",
          tableName: "candidate_cards",
        });
      }
    },

    mutate(rawCommand) {
      try {
        return mutationTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "mutateCandidateCard",
          tableName: "candidate_cards",
        });
      }
    },

    requestHelp(rawCommand) {
      try {
        return helpTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "requestCandidateCardHelp",
          tableName:
            "candidate_card_help_requests",
        });
      }
    },

    requestHelpCurrent(rawCommand) {
      try {
        return currentHelpTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "requestCurrentCandidateCardHelp",
          tableName:
            "candidate_card_help_command_results",
        });
      }
    },

    synchronizeCarryovers(rawCommand) {
      try {
        return carryoverSyncTransaction.immediate(
          rawCommand
        );
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "synchronizeCandidateCardCarryovers",
          tableName:
            "candidate_card_entries",
        });
      }
    },

    synchronizeSummerStateCurrent(rawCommand) {
      try {
        return executeSummerStateSync(rawCommand);
      } catch (error) {
        if (
          error?.name ===
          "CandidateCardPolicyError"
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "synchronizeCurrentCandidateCardSummerState",
          tableName:
            "candidate_card_entries",
        });
      }
    },

    submitBeforeDeadline() {
      conflict(
        "Candidate Cards have no early submission transition.",
        "CANDIDATE_CARD_EARLY_SUBMISSION_UNSUPPORTED"
      );
    },

    lockAtDeadline() {
      incompatible(
        "Candidate Cards must lock through the league-wide FAD deadline repository.",
        "FAD_DEADLINE_REPOSITORY_REQUIRED"
      );
    },
  });
}

module.exports = {
  CANDIDATE_CARD_OPERATIONS,
  createSqliteCandidateCardRepository,
};
