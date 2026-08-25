const {
  parseFreeAgentDraftOccurrenceKey,
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
  FreeAgentDraftReadinessPolicyError,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
  validateFreeAgentDraftReadinessRetryReceipt,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE =
  Object.freeze({
    readiness: "fad_readiness",
    eligibility_revalidate:
      "fad_eligibility_revalidation",
    reminder: "fad_deadline_reminder",
    deadline: "fad_deadline",
    allocate: "fad_allocation",
    restricted_activate:
      "fad_restricted_activation",
    fallback_activate:
      "fad_fallback_activation",
    nomination_open:
      "fad_queued_nomination_activation",
    rollover: "fad_rollover",
    complete: "fad_completion",
  });

const FREE_AGENT_DRAFT_JOB_TYPES = Object.freeze(
  Object.values(
    FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE
  )
);

const FREE_AGENT_DRAFT_JOB_REPOSITORY_METHODS =
  Object.freeze([
    "listDue",
    "claim",
    "findReadinessRetryReplay",
    "requeueReadiness",
    "succeed",
    "fail",
  ]);

const FREE_AGENT_DRAFT_READINESS_RETRY_RESULT_TYPE =
  "free_agent_draft_readiness_retry_receipt";

const FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied: "NOT_AUTHORIZED",
    idempotencyKeyReused:
      "IDEMPOTENCY_KEY_REUSED",
    idempotencyRequestUnavailable:
      "IDEMPOTENCY_REQUEST_UNAVAILABLE",
    notFound: "FREE_AGENT_DRAFT_NOT_FOUND",
    notReady: "FAD_READINESS_NOT_READY",
    preconditionFailed:
      "FAD_READINESS_PRECONDITION_FAILED",
  });

const JOB_ORDER = Object.freeze(
  new Map(
    FREE_AGENT_DRAFT_JOB_TYPES.map(
      (jobType, index) => [
        jobType,
        index + 1,
      ]
    )
  )
);

const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ERROR_CODE_PATTERN =
  /^[A-Z][A-Z0-9_]{0,99}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_RESULT_JSON_LENGTH = 100_000;
const FAD_DAY_MS = 86_400_000;
const REMINDER_LEAD_MS = 259_200_000;

class FreeAgentDraftReadinessRetryRepositoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name =
      "FreeAgentDraftReadinessRetryRepositoryError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({
        ...details,
      });
    }
  }
}

function failReadinessRetry(
  code,
  message,
  details
) {
  throw new FreeAgentDraftReadinessRetryRepositoryError(
    code,
    message,
    details
  );
}

function invalid(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    cause === undefined
      ? undefined
      : { cause }
  );
}

function conflict(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message
  );
}

function incompatible(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    cause === undefined
      ? undefined
      : { cause }
  );
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`
    );
  }
  return value;
}

function nullableStableId(
  value,
  description
) {
  if (value === null) return null;
  return stableId(value, description);
}

function boundedText(
  value,
  maximumLength,
  description
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid(
      `A bounded ${description} is required.`
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
      `A safe ${description} is required.`
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
      `A positive ${description} is required.`
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

function exactObject(value, fields, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    invalid(
      `An exact ${description} is required.`
    );
  }
}

function parseOccurrence(
  occurrenceKey,
  jobType
) {
  boundedText(
    occurrenceKey,
    400,
    "FAD occurrence key"
  );
  let parsed;
  try {
    parsed =
      parseFreeAgentDraftOccurrenceKey(
        occurrenceKey
      );
  } catch (error) {
    invalid(
      "A canonical FAD occurrence key is required.",
      error
    );
  }
  if (
    FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE[
      parsed.type
    ] !== jobType
  ) {
    invalid(
      "The FAD job type and occurrence key do not agree."
    );
  }
  return parsed;
}

function normalizeJobType(value) {
  boundedText(value, 100, "FAD job type");
  if (
    !FREE_AGENT_DRAFT_JOB_TYPES.includes(
      value
    )
  ) {
    invalid(
      "An approved FAD job type is required."
    );
  }
  return value;
}

function resultJson(value) {
  let encoded;
  try {
    encoded = serializeCanonicalJsonV1(
      value
    );
  } catch (error) {
    invalid(
      "The FAD job result must be canonical JSON.",
      error
    );
  }
  if (
    encoded.length >
    MAXIMUM_RESULT_JSON_LENGTH
  ) {
    invalid(
      "The FAD job result is too large."
    );
  }
  return encoded;
}

function errorCode(value) {
  if (
    typeof value !== "string" ||
    !ERROR_CODE_PATTERN.test(value)
  ) {
    invalid(
      "A canonical FAD job error code is required."
    );
  }
  return value;
}

function one(rows) {
  return rows.length === 1 ? rows[0] : null;
}

function exactKeys(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") ===
      [...fields].sort().join("|")
  );
}

function canonicalOptionalId(value) {
  return (
    value === null ||
    (
      typeof value === "string" &&
      UUID_PATTERN.test(value)
    )
  );
}

function canonicalPositionGroup(value) {
  return (
    value === null ||
    value === "F" ||
    value === "D"
  );
}

const PLAYER_CATALOG_EVENT_DETAIL_FIELDS =
  Object.freeze([
    "schemaVersion",
    "code",
    "sourceOperationId",
    "provider",
    "capturedAtMs",
    "appliedAtMs",
    "requestSha256",
    "rowCount",
    "createdPlayerCount",
    "updatedPlayerCount",
    "sourceStateChangeCount",
    "eligibilityChangedPlayerCount",
    "eligibilityRevalidationOccurrenceCount",
  ]);

function canonicalEligibilityBinding({
  row,
  parsed,
  fadId,
  source,
}) {
  let details;
  try {
    details = JSON.parse(
      source.source_event_details_json
    );
  } catch {
    return null;
  }
  const positiveVersion = (value) =>
    Number.isSafeInteger(value) && value >= 1;
  const nonnegativeInteger = (value) =>
    Number.isSafeInteger(value) && value >= 0;
  const statusChanged =
    source.player_status_before !==
    source.player_status_after;
  const effectivePositionChanged =
    source.effective_position_group_before !==
    source.effective_position_group_after;
  const versionTransitionValid =
    source.player_version_after ===
      source.player_version_before ||
    source.player_version_after ===
      source.player_version_before + 1;
  const overrideProjectionValid =
    source.league_position_override_id === null
      ? (
          source.effective_position_group_before ===
            source.source_resolved_position_group_before &&
          source.effective_position_group_after ===
            source.source_resolved_position_group_after
        )
      : (
          source.effective_position_group_before !== null &&
          source.effective_position_group_before ===
            source.effective_position_group_after
        );
  if (
    !UUID_PATTERN.test(source.id || "") ||
    source.league_id !== row.league_id ||
    source.season_id !== row.season_id ||
    source.fad_id !== fadId ||
    source.player_id !== parsed.playerId ||
    source.source_operation_id !==
      parsed.sourceOperationId ||
    source.job_run_id !== row.id ||
    source.occurrence_key !==
      row.occurrence_key ||
    source.scheduled_for_ms !==
      row.scheduled_for_ms ||
    source.created_at_ms !==
      row.created_at_ms ||
    source.created_at_ms !==
      source.scheduled_for_ms ||
    source.version !== 1 ||
    typeof source.source_provider !== "string" ||
    source.source_provider.length < 1 ||
    source.source_provider.length > 80 ||
    source.source_provider.trim() !==
      source.source_provider ||
    !positiveVersion(
      source.player_version_before
    ) ||
    !positiveVersion(
      source.player_version_after
    ) ||
    !versionTransitionValid ||
    (
      statusChanged &&
      source.player_version_after !==
        source.player_version_before + 1
    ) ||
    !["active", "historical"].includes(
      source.player_status_before
    ) ||
    !["active", "historical"].includes(
      source.player_status_after
    ) ||
    !canonicalOptionalId(
      source.source_state_before_id
    ) ||
    !UUID_PATTERN.test(
      source.source_state_after_id || ""
    ) ||
    !canonicalOptionalId(
      source.league_position_override_id
    ) ||
    !canonicalPositionGroup(
      source
        .source_resolved_position_group_before
    ) ||
    !canonicalPositionGroup(
      source
        .source_resolved_position_group_after
    ) ||
    !canonicalPositionGroup(
      source.effective_position_group_before
    ) ||
    !canonicalPositionGroup(
      source.effective_position_group_after
    ) ||
    !overrideProjectionValid ||
    (!statusChanged && !effectivePositionChanged) ||
    !SHA256_PATTERN.test(
      source.eligibility_delta_sha256 || ""
    ) ||
    source.source_event_type !==
      "player_catalog_applied" ||
    source.source_event_feature !==
      "player_data_provider" ||
    source.source_event_outcome !==
      "succeeded" ||
    source.source_event_actor_user_id !== null ||
    source.source_event_reason_code !==
      "provider_catalog_import" ||
    source.source_event_occurred_at_ms !==
      source.created_at_ms ||
    !exactKeys(
      details,
      PLAYER_CATALOG_EVENT_DETAIL_FIELDS
    ) ||
    details.schemaVersion !== 1 ||
    details.code !== "PLAYER_CATALOG_APPLIED" ||
    details.sourceOperationId !==
      source.source_operation_id ||
    details.provider !== source.source_provider ||
    typeof details.provider !== "string" ||
    details.provider.trim() !== details.provider ||
    details.provider.length < 1 ||
    details.provider.length > 80 ||
    !nonnegativeInteger(details.capturedAtMs) ||
    details.capturedAtMs >
      source.source_event_occurred_at_ms ||
    details.appliedAtMs !==
      source.source_event_occurred_at_ms ||
    !SHA256_PATTERN.test(
      details.requestSha256 || ""
    ) ||
    !Number.isSafeInteger(details.rowCount) ||
    details.rowCount < 1 ||
    !nonnegativeInteger(
      details.createdPlayerCount
    ) ||
    !nonnegativeInteger(
      details.updatedPlayerCount
    ) ||
    details.createdPlayerCount +
        details.updatedPlayerCount >
      details.rowCount ||
    !nonnegativeInteger(
      details.sourceStateChangeCount
    ) ||
    details.sourceStateChangeCount >
      details.rowCount ||
    !nonnegativeInteger(
      details.eligibilityChangedPlayerCount
    ) ||
    details.eligibilityChangedPlayerCount >
      details.rowCount ||
    !Number.isSafeInteger(
      source.sealed_occurrence_count
    ) ||
    source.sealed_occurrence_count < 1 ||
    details
      .eligibilityRevalidationOccurrenceCount !==
      source.sealed_occurrence_count ||
    !Number.isSafeInteger(
      source.sealed_player_count
    ) ||
    source.sealed_player_count < 1 ||
    details.eligibilityChangedPlayerCount <
      source.sealed_player_count
  ) {
    return null;
  }
  return deepFreeze({
    type: parsed.type,
    resourceType:
      "eligibility_revalidation_occurrence",
    resourceId: source.id,
    fadId,
    occurrenceId: source.id,
    playerId: source.player_id,
    sourceOperationId:
      source.source_operation_id,
    sourceProvider: source.source_provider,
    sourceOperationEventType:
      source.source_event_type,
    sourceOperationOccurredAtMs:
      source.source_event_occurred_at_ms,
    playerVersionBefore:
      source.player_version_before,
    playerVersionAfter:
      source.player_version_after,
    playerStatusBefore:
      source.player_status_before,
    playerStatusAfter:
      source.player_status_after,
    sourceStateBeforeId:
      source.source_state_before_id,
    sourceStateAfterId:
      source.source_state_after_id,
    sourceResolvedPositionGroupBefore:
      source
        .source_resolved_position_group_before,
    sourceResolvedPositionGroupAfter:
      source
        .source_resolved_position_group_after,
    leaguePositionOverrideId:
      source.league_position_override_id,
    effectivePositionGroupBefore:
      source.effective_position_group_before,
    effectivePositionGroupAfter:
      source.effective_position_group_after,
    eligibilityDeltaSha256:
      source.eligibility_delta_sha256,
  });
}

function canonicalNonterminalState(row) {
  if (
    row.status === "pending"
  ) {
    return (
      row.lease_owner === null &&
      row.lease_token === null &&
      row.lease_expires_at_ms === null &&
      row.started_at_ms === null &&
      row.completed_at_ms === null &&
      row.result_json === null &&
      row.last_error_code === null
    );
  }
  if (row.status === "failed") {
    return (
      row.lease_owner === null &&
      row.lease_token === null &&
      row.lease_expires_at_ms === null &&
      row.started_at_ms !== null &&
      row.completed_at_ms !== null &&
      row.result_json === null &&
      typeof row.last_error_code ===
        "string" &&
      ERROR_CODE_PATTERN.test(
        row.last_error_code
      ) &&
      Number.isSafeInteger(
        row.next_attempt_at_ms
      ) &&
      row.next_attempt_at_ms >
        row.completed_at_ms
    );
  }
  if (
    row.status === "leased" ||
    row.status === "running"
  ) {
    return (
      typeof row.lease_owner === "string" &&
      row.lease_owner.length > 0 &&
      typeof row.lease_token === "string" &&
      row.lease_token.length > 0 &&
      Number.isSafeInteger(
        row.lease_expires_at_ms
      ) &&
      row.lease_expires_at_ms >= 0 &&
      (
        row.status === "leased" ||
        Number.isSafeInteger(
          row.started_at_ms
        )
      ) &&
      row.completed_at_ms === null &&
      row.result_json === null &&
      row.last_error_code === null &&
      row.next_attempt_at_ms === null
    );
  }
  return false;
}

function canonicalPersistedJob(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.id || "") ||
    !UUID_PATTERN.test(
      row.league_id || ""
    ) ||
    !UUID_PATTERN.test(
      row.season_id || ""
    ) ||
    !FREE_AGENT_DRAFT_JOB_TYPES.includes(
      row.job_type
    ) ||
    typeof row.occurrence_key !==
      "string" ||
    !Number.isSafeInteger(
      row.scheduled_for_ms
    ) ||
    row.scheduled_for_ms < 0 ||
    !Number.isSafeInteger(
      row.attempt_count
    ) ||
    row.attempt_count < 0 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  ) {
    return false;
  }
  if (
    [
      "pending",
      "failed",
      "leased",
      "running",
    ].includes(row.status)
  ) {
    return canonicalNonterminalState(row);
  }
  if (
    row.status === "succeeded" ||
    row.status === "skipped"
  ) {
    if (
      row.lease_owner !== null ||
      row.lease_token !== null ||
      row.lease_expires_at_ms !== null ||
      !Number.isSafeInteger(
        row.started_at_ms
      ) ||
      !Number.isSafeInteger(
        row.completed_at_ms
      ) ||
      row.completed_at_ms <
        row.started_at_ms ||
      row.last_error_code !== null ||
      row.next_attempt_at_ms !== null ||
      typeof row.result_json !== "string"
    ) {
      return false;
    }
    try {
      const decoded = JSON.parse(
        row.result_json
      );
      return (
        serializeCanonicalJsonV1(decoded) ===
        row.result_json
      );
    } catch {
      return false;
    }
  }
  return false;
}

function isDue(row, nowMs) {
  if (row.status === "pending") {
    return (
      (
        row.next_attempt_at_ms ??
        row.scheduled_for_ms
      ) <= nowMs
    );
  }
  if (row.status === "failed") {
    return (
      Number.isSafeInteger(
        row.next_attempt_at_ms
      ) &&
      row.next_attempt_at_ms <= nowMs
    );
  }
  return (
    (
      row.status === "leased" ||
      row.status === "running"
    ) &&
    row.lease_expires_at_ms <= nowMs
  );
}

function normalizeExactClaim(input) {
  const leagueId = stableId(
    input.leagueId,
    "league ID"
  );
  const seasonId = stableId(
    input.seasonId,
    "season ID"
  );
  const runId = stableId(
    input.runId,
    "job-run ID"
  );
  const jobType = normalizeJobType(
    input.jobType
  );
  const occurrenceKey = boundedText(
    input.occurrenceKey,
    400,
    "FAD occurrence key"
  );
  const parsed = parseOccurrence(
    occurrenceKey,
    jobType
  );
  const fadId = nullableStableId(
    input.fadId,
    "FAD ID"
  );
  if (
    (
      parsed.type === "readiness" &&
      fadId !== null
    ) ||
    (
      parsed.type !== "readiness" &&
      fadId !== parsed.fadId
    )
  ) {
    invalid(
      "The FAD occurrence and aggregate scope do not agree."
    );
  }
  return Object.freeze({
    leagueId,
    seasonId,
    fadId,
    runId,
    jobType,
    occurrenceKey,
    scheduledForMs: safeTimestamp(
      input.scheduledForMs,
      "scheduled timestamp"
    ),
    expectedVersion: positiveInteger(
      input.expectedVersion,
      "job-run version"
    ),
    parsed,
  });
}

function leaseIdentity(input) {
  return {
    leaseOwner: boundedText(
      input.leaseOwner,
      128,
      "lease owner"
    ),
    leaseToken: boundedText(
      input.leaseToken,
      200,
      "lease token"
    ),
  };
}

const READINESS_RETRY_PUBLIC_INPUT_FIELDS =
  Object.freeze([
    "actorMembershipId",
    "actorUserId",
    "body",
    "clientKey",
    "expectedVersion",
    "leagueId",
  ]);

const READINESS_RETRY_WRITE_INPUT_FIELDS =
  Object.freeze([
    ...READINESS_RETRY_PUBLIC_INPUT_FIELDS,
    "acceptedAtMs",
    "idempotencyExpiresAtMs",
    "idempotencyRequestId",
    "retryReceiptId",
  ]);

function normalizeReadinessRetryIdentity(
  input
) {
  exactObject(
    input,
    READINESS_RETRY_PUBLIC_INPUT_FIELDS,
    "FAD readiness-retry replay input"
  );
  let request;
  try {
    request =
      createFreeAgentDraftReadinessRetryRequest({
        actorUserId: input.actorUserId,
        body: input.body,
        clientKey: input.clientKey,
        expectedVersion:
          input.expectedVersion,
        leagueId: input.leagueId,
      });
  } catch (error) {
    if (
      error instanceof
      FreeAgentDraftReadinessPolicyError
    ) {
      invalid(
        "The FAD readiness-retry request is invalid.",
        error
      );
    }
    throw error;
  }
  return deepFreeze({
    request,
    actorMembershipId: stableId(
      input.actorMembershipId,
      "actor membership ID"
    ),
  });
}

function normalizeReadinessRetryWrite(input) {
  exactObject(
    input,
    READINESS_RETRY_WRITE_INPUT_FIELDS,
    "FAD readiness-retry write input"
  );
  const identity =
    normalizeReadinessRetryIdentity(
      Object.fromEntries(
        READINESS_RETRY_PUBLIC_INPUT_FIELDS.map(
          (field) => [field, input[field]]
        )
      )
    );
  const acceptedAtMs = safeTimestamp(
    input.acceptedAtMs,
    "readiness-retry acceptance timestamp"
  );
  const idempotencyExpiresAtMs =
    safeTimestamp(
      input.idempotencyExpiresAtMs,
      "readiness-retry idempotency expiry"
    );
  if (idempotencyExpiresAtMs <= acceptedAtMs) {
    invalid(
      "The FAD readiness-retry idempotency request must expire after acceptance."
    );
  }
  return deepFreeze({
    ...identity,
    acceptedAtMs,
    idempotencyExpiresAtMs,
    idempotencyRequestId: stableId(
      input.idempotencyRequestId,
      "idempotency-request ID"
    ),
    retryReceiptId: stableId(
      input.retryReceiptId,
      "readiness-retry receipt ID"
    ),
  });
}

function createSqliteFreeAgentDraftJobRepository({
  database,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftJobRepository requires a database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD-job beforeCommit must be a function"
    );
  }

  let dueStatement;
  let byIdStatement;
  let currentScopeStatement;
  let readinessStatement;
  let readinessRetryAuthorityStatement;
  let readinessRetryIdempotencyStatement;
  let readinessRetryReceiptStatement;
  let readinessRetryOperationStatement;
  let rootStatement;
  let eligibilitySourceStatement;
  let allocationStatement;
  let allocationByPlayerStatement;
  let rolloverStatement;
  let predecessorStatement;
  let nominationStatement;
  let restrictedStatement;
  let fallbackStatement;
  let fallbackRecoveryStatement;
  let seventhRolloverStatement;
  let claimStatement;
  let claimReadinessJobStatement;
  let claimReadinessOperationStatement;
  let reclaimReadinessJobStatement;
  let reclaimReadinessOperationStatement;
  let insertReadinessRetryIdempotencyStatement;
  let requeueReadinessStatement;
  let insertReadinessRetryReceiptStatement;
  let advanceReadinessRetryOperationStatement;
  let completeReadinessRetryIdempotencyStatement;
  let succeedStatement;
  let failStatement;
  let readinessRetryPreparationError = null;

  try {
    dueStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE job_type IN (
        ${FREE_AGENT_DRAFT_JOB_TYPES
          .map(() => "?")
          .join(", ")}
      )
        AND NOT (
          job_type = 'fad_readiness'
          AND status = 'failed'
        )
        AND (
          (
            status = 'pending'
            AND COALESCE(
              next_attempt_at_ms,
              scheduled_for_ms
            ) <= ?
          )
          OR (
            status = 'failed'
            AND next_attempt_at_ms IS NOT NULL
            AND next_attempt_at_ms <= ?
          )
          OR (
            status IN ('leased', 'running')
            AND lease_expires_at_ms <= ?
          )
        )
      ORDER BY
        CASE job_type
          ${FREE_AGENT_DRAFT_JOB_TYPES
            .map(
              (jobType) =>
                `WHEN '${jobType}' THEN ` +
                JOB_ORDER.get(jobType)
            )
            .join("\n          ")}
          ELSE 999
        END,
        COALESCE(
          next_attempt_at_ms,
          scheduled_for_ms
        ),
        scheduled_for_ms,
        id
      LIMIT ?
    `);
    byIdStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND id = @runId
      LIMIT 2
    `);
    currentScopeStatement =
      database.prepare(`
        SELECT
          season.id AS season_id
        FROM leagues AS league
        JOIN seasons AS season
          ON season.league_id = league.id
         AND season.id =
           league.current_season_id
        WHERE league.id = @leagueId
          AND season.id = @seasonId
        LIMIT 2
      `);
    readinessStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND job_run_id = @runId
        AND readiness_occurrence_key =
          @occurrenceKey
      LIMIT 2
    `);
    try {
      readinessRetryAuthorityStatement =
        database.prepare(`
        SELECT
          leagues.commissioner_membership_id,
          users.status AS user_status,
          league_memberships.status
            AS membership_status,
          league_memberships.permission_category
            AS membership_permission,
          CASE WHEN EXISTS (
            SELECT 1
            FROM platform_roles
            WHERE platform_roles.user_id =
                @actorUserId
              AND platform_roles.role =
                'platform_administrator'
              AND platform_roles.status = 'active'
              AND platform_roles.ended_at_ms IS NULL
          ) THEN 1 ELSE 0 END
            AS is_platform_administrator
        FROM leagues
        JOIN users
          ON users.id = @actorUserId
        JOIN league_memberships
          ON league_memberships.league_id =
              leagues.id
         AND league_memberships.id =
              @actorMembershipId
         AND league_memberships.user_id =
              @actorUserId
         AND league_memberships.status = 'active'
         AND league_memberships.joined_at_ms IS NOT NULL
         AND league_memberships.ended_at_ms IS NULL
        WHERE leagues.id = @leagueId
        LIMIT 2
        `);
      readinessRetryIdempotencyStatement =
        database.prepare(`
        SELECT *
        FROM idempotency_requests
        WHERE league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
        LIMIT 2
        `);
      readinessRetryReceiptStatement =
        database.prepare(`
        SELECT *
        FROM free_agent_draft_readiness_retry_receipts
        WHERE league_id = @leagueId
          AND id = @retryReceiptId
        LIMIT 2
        `);
      readinessRetryOperationStatement =
        database.prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @readinessOperationId
        LIMIT 2
        `);
    } catch (error) {
      readinessRetryPreparationError = error;
      readinessRetryAuthorityStatement = null;
      readinessRetryIdempotencyStatement = null;
      readinessRetryReceiptStatement = null;
      readinessRetryOperationStatement = null;
    }
    rootStatement = database.prepare(`
      SELECT
        draft.*,
        readiness.id AS bound_readiness_id,
        readiness.status
          AS bound_readiness_status,
        readiness.created_fad_id
          AS bound_created_fad_id,
        readiness.reminder_job_run_id
          AS bound_reminder_job_run_id,
        readiness.deadline_job_run_id
          AS bound_deadline_job_run_id
      FROM free_agent_drafts AS draft
      JOIN free_agent_draft_readiness_operations
        AS readiness
        ON readiness.league_id =
            draft.league_id
       AND readiness.season_id =
            draft.season_id
       AND readiness.id =
            draft.readiness_operation_id
       AND readiness.readiness_occurrence_key =
            draft.readiness_occurrence_key
       AND readiness.status = 'succeeded'
       AND readiness.created_fad_id =
            draft.id
      WHERE draft.league_id = @leagueId
        AND draft.season_id = @seasonId
        AND draft.id = @fadId
      LIMIT 2
    `);
    eligibilitySourceStatement =
      database.prepare(`
        SELECT
          occurrence.*,
          event.event_type
            AS source_event_type,
          event.feature
            AS source_event_feature,
          event.outcome
            AS source_event_outcome,
          event.actor_user_id
            AS source_event_actor_user_id,
          event.reason_code
            AS source_event_reason_code,
          event.details_json
            AS source_event_details_json,
          event.occurred_at_ms
            AS source_event_occurred_at_ms,
          (
            SELECT COUNT(*)
            FROM free_agent_draft_eligibility_revalidation_occurrences
              AS sealed_occurrence
            WHERE sealed_occurrence.source_operation_id =
              occurrence.source_operation_id
          ) AS sealed_occurrence_count,
          (
            SELECT COUNT(DISTINCT sealed_player.player_id)
            FROM free_agent_draft_eligibility_revalidation_occurrences
              AS sealed_player
            WHERE sealed_player.source_operation_id =
              occurrence.source_operation_id
          ) AS sealed_player_count
        FROM free_agent_draft_eligibility_revalidation_occurrences
          AS occurrence
        JOIN operational_events AS event
          ON event.id =
            occurrence.source_operation_id
        WHERE occurrence.league_id =
              @leagueId
          AND occurrence.season_id =
              @seasonId
          AND occurrence.fad_id = @fadId
          AND occurrence.player_id =
              @playerId
          AND occurrence.source_operation_id =
              @sourceOperationId
          AND occurrence.job_run_id =
              @runId
          AND occurrence.occurrence_key =
              @occurrenceKey
          AND occurrence.scheduled_for_ms =
              @scheduledForMs
          AND occurrence.created_at_ms =
              @jobCreatedAtMs
          AND occurrence.version = 1
          AND event.league_id IS NULL
          AND event.season_id IS NULL
          AND event.actor_user_id IS NULL
          AND event.event_type =
              'player_catalog_applied'
          AND event.feature =
              'player_data_provider'
          AND event.outcome = 'succeeded'
          AND event.reason_code =
              'provider_catalog_import'
          AND event.occurred_at_ms =
              @jobCreatedAtMs
          AND json_valid(event.details_json) = 1
          AND json_type(event.details_json) =
              'object'
        LIMIT 2
      `);
    allocationStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_player_allocations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
        LIMIT 2
      `);
    allocationByPlayerStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_player_allocations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND player_id = @playerId
        LIMIT 2
      `);
    rolloverStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND sequence = @sequence
        AND rolls_over_at_ms =
          @rolloverAtMs
      LIMIT 2
    `);
    predecessorStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_rollovers
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @predecessorId
          AND sequence =
            @predecessorSequence
          AND rolls_over_at_ms =
            @predecessorRolloverAtMs
        LIMIT 2
      `);
    nominationStatement =
      database.prepare(`
        SELECT
          queue.*,
          rollover.sequence
            AS target_rollover_sequence,
          rollover.rolls_over_at_ms
            AS target_rollover_at_ms
        FROM free_agent_draft_nomination_queue
          AS queue
        JOIN free_agent_draft_rollovers
          AS rollover
          ON rollover.league_id =
              queue.league_id
         AND rollover.season_id =
              queue.season_id
         AND rollover.fad_id =
              queue.fad_id
         AND rollover.id =
              queue.target_opening_rollover_id
        WHERE queue.league_id = @leagueId
          AND queue.season_id = @seasonId
          AND queue.fad_id = @fadId
          AND queue.id = @queueId
        LIMIT 2
      `);
    restrictedStatement =
      database.prepare(`
        SELECT
          allocation.*,
          auction.player_id
            AS auction_player_id,
          auction.opened_at_ms
            AS auction_opened_at_ms,
          auction.resolves_at_ms
            AS auction_resolves_at_ms,
          context.fad_rollover_id,
          rollover.opens_at_ms
            AS rollover_opens_at_ms,
          rollover.rolls_over_at_ms
            AS rollover_rolls_over_at_ms
        FROM free_agent_draft_player_allocations
          AS allocation
        JOIN auctions AS auction
          ON auction.league_id =
              allocation.league_id
         AND auction.season_id =
              allocation.season_id
         AND auction.id =
              allocation.restricted_auction_id
         AND auction.player_id =
              allocation.player_id
        JOIN auction_contexts AS context
          ON context.league_id =
              auction.league_id
         AND context.season_id =
              auction.season_id
         AND context.auction_id =
              auction.id
         AND context.source_kind =
              'fad_restricted'
         AND context.fad_id =
              allocation.fad_id
         AND context.fad_allocation_id =
              allocation.id
         AND context.fad_origin =
              'candidate_tie_restricted'
        JOIN free_agent_draft_rollovers
          AS rollover
          ON rollover.league_id =
              context.league_id
         AND rollover.season_id =
              context.season_id
         AND rollover.fad_id =
              context.fad_id
         AND rollover.id =
              context.fad_rollover_id
        WHERE allocation.league_id =
            @leagueId
          AND allocation.season_id =
            @seasonId
          AND allocation.fad_id = @fadId
          AND allocation.id = @allocationId
        LIMIT 2
      `);
    fallbackStatement =
      database.prepare(`
        SELECT
          allocation.*,
          auction.player_id
            AS auction_player_id,
          auction.opened_at_ms
            AS auction_opened_at_ms,
          auction.resolves_at_ms
            AS auction_resolves_at_ms,
          context.fad_rollover_id,
          rollover.opens_at_ms
            AS rollover_opens_at_ms,
          rollover.rolls_over_at_ms
            AS rollover_rolls_over_at_ms
        FROM free_agent_draft_player_allocations
          AS allocation
        JOIN auctions AS auction
          ON auction.league_id =
              allocation.league_id
         AND auction.season_id =
              allocation.season_id
         AND auction.id =
              allocation.fallback_open_auction_id
         AND auction.player_id =
              allocation.player_id
        JOIN auction_contexts AS context
          ON context.league_id =
              auction.league_id
         AND context.season_id =
              auction.season_id
         AND context.auction_id =
              auction.id
         AND context.source_kind =
              'fad_open_rapid'
         AND context.fad_id =
              allocation.fad_id
         AND context.fad_allocation_id =
              allocation.id
         AND context.fad_origin =
              'restricted_no_improvement_fallback'
        JOIN free_agent_draft_rollovers
          AS rollover
          ON rollover.league_id =
              context.league_id
         AND rollover.season_id =
              context.season_id
         AND rollover.fad_id =
              context.fad_id
         AND rollover.id =
              context.fad_rollover_id
        WHERE allocation.league_id =
            @leagueId
          AND allocation.season_id =
            @seasonId
          AND allocation.fad_id = @fadId
          AND allocation.id = @allocationId
        LIMIT 2
      `);
    fallbackRecoveryStatement =
      database.prepare(`
        SELECT
          recovery.*,
          allocation.player_id
            AS allocation_player_id,
          rollover.opens_at_ms
            AS rollover_opens_at_ms
        FROM free_agent_draft_recoveries
          AS recovery
        JOIN free_agent_draft_player_allocations
          AS allocation
          ON allocation.league_id =
              recovery.league_id
         AND allocation.season_id =
              recovery.season_id
         AND allocation.fad_id =
              recovery.fad_id
         AND allocation.id =
              recovery.allocation_id
         AND allocation.player_id =
              recovery.player_id
        JOIN free_agent_draft_rollovers
          AS rollover
          ON rollover.league_id =
              recovery.league_id
         AND rollover.season_id =
              recovery.season_id
         AND rollover.fad_id =
              recovery.fad_id
         AND rollover.id =
              recovery.rollover_id
        WHERE recovery.league_id =
            @leagueId
          AND recovery.season_id =
            @seasonId
          AND recovery.fad_id = @fadId
          AND recovery.allocation_id =
            @allocationId
          AND recovery.job_run_id =
            @runId
          AND recovery.kind =
            'fallback_activation'
        LIMIT 2
      `);
    seventhRolloverStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_rollovers
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND sequence = 7
          AND window_kind = 'initial'
        LIMIT 2
      `);
    claimStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          lease_owner = @leaseOwner,
          lease_token = @leaseToken,
          lease_expires_at_ms =
            @leaseExpiresAtMs,
          started_at_ms = @nowMs,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = @jobType
        AND occurrence_key =
          @occurrenceKey
        AND scheduled_for_ms =
          @scheduledForMs
        AND version = @expectedVersion
    `);
    claimReadinessJobStatement =
      database.prepare(`
        UPDATE job_runs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = @leaseOwner,
            lease_token = @leaseToken,
            lease_expires_at_ms = @leaseExpiresAtMs,
            started_at_ms = @nowMs,
            completed_at_ms = NULL,
            result_json = NULL,
            last_error_code = NULL,
            next_attempt_at_ms = NULL,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE id = @runId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND job_type = 'fad_readiness'
          AND occurrence_key = @occurrenceKey
          AND scheduled_for_ms = @scheduledForMs
          AND status = 'pending'
          AND attempt_count = @oldAttemptCount
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at_ms IS NULL
          AND started_at_ms IS NULL
          AND completed_at_ms IS NULL
          AND result_json IS NULL
          AND last_error_code IS NULL
          AND next_attempt_at_ms IS @oldNextAttemptAtMs
          AND updated_at_ms = @oldJobUpdatedAtMs
          AND version = @expectedVersion
      `);
    claimReadinessOperationStatement =
      database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = @leaseOwner,
            lease_token = @leaseToken,
            lease_expires_at_ms = @leaseExpiresAtMs,
            blockers_json = '[]',
            started_at_ms = @nowMs,
            next_retry_at_ms = NULL,
            terminal_at_ms = NULL,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE id = @readinessOperationId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND readiness_occurrence_key = @occurrenceKey
          AND job_run_id = @runId
          AND status = @oldReadinessStatus
          AND status IN ('pending', 'blocked')
          AND attempt_count = @oldAttemptCount
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at_ms IS NULL
          AND updated_at_ms = @oldReadinessUpdatedAtMs
          AND version = @oldReadinessVersion
          AND EXISTS (
            SELECT 1
            FROM job_runs
            WHERE job_runs.league_id = @leagueId
              AND job_runs.season_id = @seasonId
              AND job_runs.id = @runId
              AND job_runs.job_type = 'fad_readiness'
              AND job_runs.occurrence_key = @occurrenceKey
              AND job_runs.scheduled_for_ms = @scheduledForMs
              AND job_runs.status = 'running'
              AND job_runs.attempt_count = @newAttemptCount
              AND job_runs.lease_owner = @leaseOwner
              AND job_runs.lease_token = @leaseToken
              AND job_runs.lease_expires_at_ms = @leaseExpiresAtMs
              AND job_runs.started_at_ms = @nowMs
              AND job_runs.updated_at_ms = @nowMs
              AND job_runs.version = @newVersion
          )
      `);
    reclaimReadinessJobStatement =
      database.prepare(`
        UPDATE job_runs
        SET lease_owner = @leaseOwner,
            lease_token = @leaseToken,
            lease_expires_at_ms = @leaseExpiresAtMs,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE id = @runId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND job_type = 'fad_readiness'
          AND occurrence_key = @occurrenceKey
          AND scheduled_for_ms = @scheduledForMs
          AND status = 'running'
          AND attempt_count = @oldAttemptCount
          AND lease_owner = @oldLeaseOwner
          AND lease_token = @oldLeaseToken
          AND lease_expires_at_ms = @oldLeaseExpiresAtMs
          AND lease_expires_at_ms <= @nowMs
          AND started_at_ms = @oldStartedAtMs
          AND completed_at_ms IS NULL
          AND result_json IS NULL
          AND last_error_code IS NULL
          AND next_attempt_at_ms IS NULL
          AND updated_at_ms = @oldJobUpdatedAtMs
          AND version = @expectedVersion
      `);
    reclaimReadinessOperationStatement =
      database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET lease_owner = @leaseOwner,
            lease_token = @leaseToken,
            lease_expires_at_ms = @leaseExpiresAtMs,
            updated_at_ms = @nowMs,
            version = version + 1
        WHERE id = @readinessOperationId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND readiness_occurrence_key = @occurrenceKey
          AND job_run_id = @runId
          AND status = 'running'
          AND attempt_count = @oldAttemptCount
          AND lease_owner = @oldLeaseOwner
          AND lease_token = @oldLeaseToken
          AND lease_expires_at_ms = @oldLeaseExpiresAtMs
          AND lease_expires_at_ms <= @nowMs
          AND started_at_ms = @oldStartedAtMs
          AND updated_at_ms = @oldReadinessUpdatedAtMs
          AND version = @oldReadinessVersion
      `);
    if (
      readinessRetryPreparationError ===
      null
    ) {
      try {
        insertReadinessRetryIdempotencyStatement =
          database.prepare(`
        INSERT INTO idempotency_requests (
          id, league_id, actor_user_id,
          operation, client_key, request_hash,
          status, result_type, result_id,
          created_at_ms, completed_at_ms,
          expires_at_ms
        ) VALUES (
          @idempotencyRequestId, @leagueId,
          @actorUserId, @operation, @clientKey,
          @requestSha256, 'started', NULL, NULL,
          @acceptedAtMs, NULL,
          @idempotencyExpiresAtMs
        )
          `);
        requeueReadinessStatement =
          database.prepare(`
        UPDATE job_runs
        SET status = 'pending',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            started_at_ms = NULL,
            completed_at_ms = NULL,
            result_json = NULL,
            last_error_code = NULL,
            next_attempt_at_ms = @acceptedAtMs,
            updated_at_ms = @acceptedAtMs,
            version = version + 1
        WHERE id = @jobRunId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND job_type = 'fad_readiness'
          AND occurrence_key = @occurrenceKey
          AND scheduled_for_ms = @scheduledForMs
          AND created_at_ms = @scheduledForMs
          AND status = 'failed'
          AND attempt_count = @attemptCount
          AND attempt_count >= 1
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at_ms IS NULL
          AND started_at_ms = @oldStartedAtMs
          AND completed_at_ms = @oldCompletedAtMs
          AND completed_at_ms < @acceptedAtMs
          AND result_json IS NULL
          AND last_error_code =
            'FAD_READINESS_BLOCKED'
          AND next_attempt_at_ms =
            @oldNextAttemptAtMs
          AND next_attempt_at_ms >
            completed_at_ms
          AND updated_at_ms = @oldJobUpdatedAtMs
          AND updated_at_ms <= @acceptedAtMs
          AND version = @oldJobVersion
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_operations
              AS readiness
            WHERE readiness.league_id =
                job_runs.league_id
              AND readiness.season_id =
                job_runs.season_id
              AND readiness.id =
                @readinessOperationId
              AND readiness.job_run_id = job_runs.id
              AND readiness.readiness_occurrence_key =
                job_runs.occurrence_key
              AND readiness.created_at_ms =
                job_runs.scheduled_for_ms
              AND readiness.status = 'blocked'
              AND readiness.attempt_count =
                job_runs.attempt_count
              AND readiness.version =
                @acceptedFromVersion
          )
          `);
        insertReadinessRetryReceiptStatement =
          database.prepare(`
        INSERT INTO free_agent_draft_readiness_retry_receipts (
          id, league_id, season_id,
          readiness_operation_id,
          idempotency_request_id,
          actor_user_id, actor_membership_id,
          actor_authority, request_sha256,
          accepted_from_version,
          resulting_readiness_version,
          retry_attempt_number, job_run_id,
          occurrence_key, accepted_at_ms,
          response_http_status, response_json,
          response_sha256, version
        ) VALUES (
          @id, @leagueId, @seasonId,
          @readinessOperationId,
          @idempotencyRequestId,
          @actorUserId, @actorMembershipId,
          @actorAuthority, @requestSha256,
          @acceptedFromVersion,
          @resultingReadinessVersion,
          @retryAttemptNumber, @jobRunId,
          @occurrenceKey, @acceptedAtMs,
          @responseHttpStatus, @responseJson,
          @responseSha256, @version
        )
          `);
        advanceReadinessRetryOperationStatement =
          database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET next_retry_at_ms = @acceptedAtMs,
            updated_at_ms = @acceptedAtMs,
            version = version + 1
        WHERE id = @readinessOperationId
          AND league_id = @leagueId
          AND season_id = @seasonId
          AND readiness_occurrence_key =
            @occurrenceKey
          AND job_run_id = @jobRunId
          AND created_at_ms = @scheduledForMs
          AND status = 'blocked'
          AND attempt_count = @attemptCount
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND lease_expires_at_ms IS NULL
          AND blockers_json = @oldBlockersJson
          AND matchup_schedule_version_before IS
            @oldScheduleVersionBefore
          AND matchup_schedule_version_after IS
            @oldScheduleVersionAfter
          AND schedule_recovery_id IS
            @oldScheduleRecoveryId
          AND created_fad_id IS NULL
          AND reminder_job_run_id IS NULL
          AND deadline_job_run_id IS NULL
          AND cards_opened_activity_id IS NULL
          AND cards_opened_outbox_event_id IS NULL
          AND started_at_ms = @oldStartedAtMs
          AND next_retry_at_ms =
            @oldNextAttemptAtMs
          AND terminal_at_ms = @oldCompletedAtMs
          AND updated_at_ms =
            @oldReadinessUpdatedAtMs
          AND version = @acceptedFromVersion
          AND EXISTS (
            SELECT 1
            FROM free_agent_draft_readiness_retry_receipts
              AS receipt
            WHERE receipt.league_id =
                @leagueId
              AND receipt.id = @retryReceiptId
              AND receipt.readiness_operation_id =
                @readinessOperationId
              AND receipt.idempotency_request_id =
                @idempotencyRequestId
              AND receipt.accepted_from_version =
                @acceptedFromVersion
              AND receipt.resulting_readiness_version =
                @resultingReadinessVersion
              AND receipt.retry_attempt_number =
                @retryAttemptNumber
              AND receipt.job_run_id = @jobRunId
              AND receipt.occurrence_key =
                @occurrenceKey
              AND receipt.accepted_at_ms =
                @acceptedAtMs
          )
          `);
        completeReadinessRetryIdempotencyStatement =
          database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type =
              '${FREE_AGENT_DRAFT_READINESS_RETRY_RESULT_TYPE}',
            result_id = @retryReceiptId,
            completed_at_ms = @acceptedAtMs
        WHERE id = @idempotencyRequestId
          AND league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = @operation
          AND client_key = @clientKey
          AND request_hash = @requestSha256
          AND status = 'started'
          AND result_type IS NULL
          AND result_id IS NULL
          AND created_at_ms = @acceptedAtMs
          AND completed_at_ms IS NULL
          AND expires_at_ms =
            @idempotencyExpiresAtMs
          `);
      } catch (error) {
        readinessRetryPreparationError = error;
        insertReadinessRetryIdempotencyStatement =
          null;
        requeueReadinessStatement = null;
        insertReadinessRetryReceiptStatement =
          null;
        advanceReadinessRetryOperationStatement =
          null;
        completeReadinessRetryIdempotencyStatement =
          null;
      }
    }
    succeedStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms =
            @completedAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = @jobType
        AND occurrence_key =
          @occurrenceKey
        AND scheduled_for_ms =
          @scheduledForMs
        AND status = 'running'
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms >
          @completedAtMs
        AND version = @expectedVersion
    `);
    failStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms =
            @completedAtMs,
          result_json = NULL,
          last_error_code = @errorCode,
          next_attempt_at_ms =
            @nextAttemptAtMs,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = @jobType
        AND occurrence_key =
          @occurrenceKey
        AND scheduled_for_ms =
          @scheduledForMs
        AND status = 'running'
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms >
          @completedAtMs
        AND version = @expectedVersion
    `);
  } catch (error) {
    incompatible(
      "The SQLite schema does not support FAD job leasing.",
      error
    );
  }

  function requireReadinessRetryStorage() {
    if (
      readinessRetryPreparationError !==
        null ||
      !readinessRetryAuthorityStatement ||
      !readinessRetryIdempotencyStatement ||
      !readinessRetryReceiptStatement ||
      !readinessRetryOperationStatement ||
      !insertReadinessRetryIdempotencyStatement ||
      !requeueReadinessStatement ||
      !insertReadinessRetryReceiptStatement ||
      !advanceReadinessRetryOperationStatement ||
      !completeReadinessRetryIdempotencyStatement
    ) {
      incompatible(
        "The SQLite schema does not support FAD readiness retries.",
        readinessRetryPreparationError
      );
    }
  }

  function unique(
    statement,
    parameters,
    message
  ) {
    const rows = statement.all(parameters);
    if (rows.length > 1) {
      incompatible(message);
    }
    return rows[0] || null;
  }

  function readinessRetryParameters(command) {
    return {
      actorMembershipId:
        command.actorMembershipId,
      actorUserId:
        command.request.actorUserId,
      clientKey: command.request.clientKey,
      expectedVersion:
        command.request.expectedVersion,
      leagueId: command.request.leagueId,
      operation:
        FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
      readinessOperationId:
        command.request
          .readinessOperationId,
      requestSha256:
        command.request.requestSha256,
      seasonId: command.request.seasonId,
    };
  }

  function requireReadinessRetryAuthority(
    command
  ) {
    const parameters =
      readinessRetryParameters(command);
    const row = unique(
      readinessRetryAuthorityStatement,
      parameters,
      "FAD readiness-retry authority is not unique."
    );
    if (
      !row ||
      row.user_status !== "active" ||
      row.membership_status !== "active"
    ) {
      failReadinessRetry(
        FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
          .authorizationDenied,
        "Current FAD readiness-retry authority is required."
      );
    }
    if (
      row.commissioner_membership_id ===
        command.actorMembershipId &&
      row.membership_permission ===
        "commissioner"
    ) {
      return "commissioner";
    }
    if (
      row.is_platform_administrator === 1
    ) {
      return "platform_administrator_as_commissioner";
    }
    failReadinessRetry(
      FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
        .authorizationDenied,
      "Current FAD readiness-retry authority is required."
    );
  }

  function storedReadinessRetryReceipt(row) {
    return validateFreeAgentDraftReadinessRetryReceipt(
      {
        acceptedAtMs: row.accepted_at_ms,
        acceptedFromVersion:
          row.accepted_from_version,
        actorAuthority: row.actor_authority,
        actorMembershipId:
          row.actor_membership_id,
        actorUserId: row.actor_user_id,
        id: row.id,
        idempotencyRequestId:
          row.idempotency_request_id,
        jobRunId: row.job_run_id,
        leagueId: row.league_id,
        occurrenceKey: row.occurrence_key,
        readinessOperationId:
          row.readiness_operation_id,
        requestSha256: row.request_sha256,
        responseHttpStatus:
          row.response_http_status,
        responseJson: row.response_json,
        responseSha256: row.response_sha256,
        resultingReadinessVersion:
          row.resulting_readiness_version,
        retryAttemptNumber:
          row.retry_attempt_number,
        seasonId: row.season_id,
        version: row.version,
      }
    );
  }

  function safeReadinessRetryResult(
    receipt,
    replayed
  ) {
    return deepFreeze({
      replayed,
      httpStatus: receipt.responseHttpStatus,
      data: receipt.data,
      evidence: receipt,
    });
  }

  function readinessRetryUnavailable() {
    failReadinessRetry(
      FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
        .idempotencyRequestUnavailable,
      "The completed FAD readiness-retry request has no available immutable result."
    );
  }

  function findReadinessRetryReplayResult(
    command
  ) {
    const parameters =
      readinessRetryParameters(command);
    const idempotency = unique(
      readinessRetryIdempotencyStatement,
      parameters,
      "FAD readiness-retry idempotency scope is not unique."
    );
    if (!idempotency) return null;
    if (
      idempotency.request_hash !==
        command.request.requestSha256
    ) {
      failReadinessRetry(
        FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
          .idempotencyKeyReused,
        "The idempotency key was already used with different input."
      );
    }
    if (
      idempotency.status !== "completed" ||
      idempotency.result_type !==
        FREE_AGENT_DRAFT_READINESS_RETRY_RESULT_TYPE ||
      typeof idempotency.result_id !==
        "string" ||
      !UUID_PATTERN.test(
        idempotency.result_id
      ) ||
      !Number.isSafeInteger(
        idempotency.completed_at_ms
      )
    ) {
      readinessRetryUnavailable();
    }
    const receiptRows =
      readinessRetryReceiptStatement.all({
        leagueId: command.request.leagueId,
        retryReceiptId:
          idempotency.result_id,
      });
    if (receiptRows.length !== 1) {
      readinessRetryUnavailable();
    }
    let receipt;
    try {
      receipt = storedReadinessRetryReceipt(
        receiptRows[0]
      );
    } catch {
      readinessRetryUnavailable();
    }
    if (
      receipt.id !== idempotency.result_id ||
      receipt.idempotencyRequestId !==
        idempotency.id ||
      receipt.actorUserId !==
        command.request.actorUserId ||
      receipt.leagueId !==
        command.request.leagueId ||
      receipt.seasonId !==
        command.request.seasonId ||
      receipt.readinessOperationId !==
        command.request
          .readinessOperationId ||
      receipt.acceptedFromVersion !==
        command.request.expectedVersion ||
      receipt.requestSha256 !==
        command.request.requestSha256 ||
      receipt.acceptedAtMs !==
        idempotency.created_at_ms ||
      receipt.acceptedAtMs !==
        idempotency.completed_at_ms
    ) {
      readinessRetryUnavailable();
    }
    return safeReadinessRetryResult(
      receipt,
      true
    );
  }

  function currentScope(scope) {
    return one(
      currentScopeStatement.all(scope)
    );
  }

  function readRoot(scope) {
    return one(rootStatement.all(scope));
  }

  function canonicalRollover(
    rollover,
    scope
  ) {
    if (
      !rollover ||
      rollover.opens_at_ms !==
        rollover.rolls_over_at_ms -
          FAD_DAY_MS ||
      rollover.creation_cutoff_at_ms !==
        rollover.rolls_over_at_ms -
          3_600_000 ||
      (
        rollover.sequence === 1 &&
        rollover.predecessor_rollover_id !==
          null
      ) ||
      (
        rollover.sequence > 1 &&
        !UUID_PATTERN.test(
          rollover
            .predecessor_rollover_id ||
            ""
        )
      ) ||
      (
        rollover.window_kind ===
          "initial" &&
        (
          rollover.sequence < 1 ||
          rollover.sequence > 7
        )
      ) ||
      (
        rollover.window_kind ===
          "extension" &&
        rollover.sequence < 8
      ) ||
      (
        !["initial", "extension"].includes(
          rollover.window_kind
        )
      )
    ) {
      return false;
    }
    if (rollover.sequence === 1) {
      return true;
    }
    return Boolean(
      one(
        predecessorStatement.all({
          ...scope,
          predecessorId:
            rollover
              .predecessor_rollover_id,
          predecessorSequence:
            rollover.sequence - 1,
          predecessorRolloverAtMs:
            rollover.opens_at_ms,
        })
      )
    );
  }

  function proveBinding(row, parsed) {
    const scope = {
      leagueId: row.league_id,
      seasonId: row.season_id,
      runId: row.id,
      occurrenceKey:
        row.occurrence_key,
    };
    if (!currentScope(scope)) return null;

    if (parsed.type === "readiness") {
      if (
        parsed.leagueId !==
          row.league_id ||
        parsed.seasonId !==
          row.season_id
      ) {
        return null;
      }
      const readiness = one(
        readinessStatement.all(scope)
      );
      if (!readiness) return null;
      const triggerMatches =
        (
          readiness.trigger_kind ===
            "entry_draft_completed" &&
          readiness.entry_draft_id ===
            parsed.triggerResourceId &&
          readiness.setup_exemption_id ===
            null
        ) ||
        (
          readiness.trigger_kind ===
            "no_draft_initial_season2" &&
          readiness.setup_exemption_id ===
            parsed.triggerResourceId &&
          readiness.entry_draft_id ===
            null
        ) ||
        (
          readiness.trigger_kind ===
            "no_draft_inaugural" &&
          readiness.entry_draft_id ===
            null &&
          readiness.setup_exemption_id ===
            null
        );
      if (!triggerMatches) return null;
      if (
        readiness.created_fad_id !==
        null
      ) {
        const created = readRoot({
          ...scope,
          fadId:
            readiness.created_fad_id,
        });
        if (
          !created ||
          created.bound_readiness_id !==
            readiness.id
        ) {
          return null;
        }
      }
      return deepFreeze({
        type: parsed.type,
        resourceType:
          "readiness_operation",
        resourceId: readiness.id,
        fadId: null,
        triggerResourceId:
          parsed.triggerResourceId,
        createdFadId:
          readiness.created_fad_id,
        readinessExecution: {
          operationId: readiness.id,
          status: readiness.status,
          attemptCount:
            readiness.attempt_count,
          leaseExpiresAtMs:
            readiness.lease_expires_at_ms,
          startedAtMs:
            readiness.started_at_ms,
          updatedAtMs:
            readiness.updated_at_ms,
          version: readiness.version,
        },
      });
    }

    const fadId = parsed.fadId;
    const root = readRoot({
      ...scope,
      fadId,
    });
    if (!root) return null;

    if (
      parsed.type ===
      "eligibility_revalidate"
    ) {
      const sourceOperation = one(
        eligibilitySourceStatement.all({
          ...scope,
          fadId,
          playerId: parsed.playerId,
          sourceOperationId:
            parsed.sourceOperationId,
          scheduledForMs:
            row.scheduled_for_ms,
          jobCreatedAtMs:
            row.created_at_ms,
        })
      );
      if (!sourceOperation) {
        return null;
      }
      return canonicalEligibilityBinding({
        row,
        parsed,
        fadId,
        source: sourceOperation,
      });
    }

    if (parsed.type === "reminder") {
      if (
        parsed.reminderAtMs !==
          root.candidate_deadline_at_ms -
            REMINDER_LEAD_MS ||
        row.scheduled_for_ms !==
          parsed.reminderAtMs ||
        root.bound_reminder_job_run_id !==
          row.id
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType:
          "free_agent_draft",
        resourceId: fadId,
        fadId,
        reminderAtMs:
          parsed.reminderAtMs,
      });
    }

    if (parsed.type === "deadline") {
      if (
        parsed.deadlineAtMs !==
          root.candidate_deadline_at_ms ||
        row.scheduled_for_ms !==
          parsed.deadlineAtMs ||
        root.bound_deadline_job_run_id !==
          row.id
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType:
          "free_agent_draft",
        resourceId: fadId,
        fadId,
        deadlineAtMs:
          parsed.deadlineAtMs,
      });
    }

    if (parsed.type === "allocate") {
      const exactAllocation = one(
        allocationByPlayerStatement.all({
          ...scope,
          fadId,
          playerId: parsed.playerId,
        })
      );
      if (
        !exactAllocation ||
        exactAllocation.player_id !==
          parsed.playerId ||
        row.scheduled_for_ms !==
          root.candidate_deadline_at_ms
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType: "allocation",
        resourceId: exactAllocation.id,
        fadId,
        playerId: parsed.playerId,
        allocationId:
          exactAllocation.id,
      });
    }

    if (
      parsed.type ===
      "restricted_activate"
    ) {
      const restricted = one(
        restrictedStatement.all({
          ...scope,
          fadId,
          allocationId:
            parsed.allocationId,
        })
      );
      if (
        !restricted ||
        row.scheduled_for_ms !==
          parsed.activationAtMs ||
        restricted.auction_opened_at_ms !==
          parsed.activationAtMs ||
        restricted.rollover_opens_at_ms !==
          parsed.activationAtMs ||
        restricted.auction_resolves_at_ms !==
          restricted
            .rollover_rolls_over_at_ms
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType: "allocation",
        resourceId:
          parsed.allocationId,
        fadId,
        playerId:
          restricted.player_id,
        allocationId:
          parsed.allocationId,
        auctionId:
          restricted
            .restricted_auction_id,
        rolloverId:
          restricted.fad_rollover_id,
        activationAtMs:
          parsed.activationAtMs,
      });
    }

    if (
      parsed.type === "fallback_activate"
    ) {
      const command = {
        ...scope,
        fadId,
        allocationId:
          parsed.allocationId,
      };
      const fallback = one(
        fallbackStatement.all(command)
      );
      const recovery = fallback
        ? null
        : one(
            fallbackRecoveryStatement.all(
              command
            )
          );
      const fallbackMatches = Boolean(
        fallback &&
        fallback.auction_opened_at_ms ===
          parsed.activationAtMs &&
        fallback.rollover_opens_at_ms ===
          parsed.activationAtMs &&
        fallback.auction_resolves_at_ms ===
          fallback
            .rollover_rolls_over_at_ms
      );
      const recoveryMatches = Boolean(
        recovery &&
        recovery.earliest_activation_at_ms ===
          parsed.activationAtMs &&
        recovery.rollover_opens_at_ms ===
          parsed.activationAtMs
      );
      if (
        row.scheduled_for_ms !==
          parsed.activationAtMs ||
        (
          !fallbackMatches &&
          !recoveryMatches
        )
      ) {
        return null;
      }
      const evidence =
        fallback || recovery;
      return deepFreeze({
        type: parsed.type,
        resourceType: "allocation",
        resourceId:
          parsed.allocationId,
        fadId,
        playerId:
          evidence.player_id ??
          evidence.allocation_player_id,
        allocationId:
          parsed.allocationId,
        auctionId:
          fallback
            ?.fallback_open_auction_id ??
          recovery?.auction_id ??
          null,
        rolloverId:
          fallback?.fad_rollover_id ??
          recovery?.rollover_id ??
          null,
        recoveryId:
          recovery?.id ?? null,
        activationAtMs:
          parsed.activationAtMs,
      });
    }

    if (parsed.type === "nomination_open") {
      const nomination = one(
        nominationStatement.all({
          ...scope,
          fadId,
          queueId: parsed.queueId,
        })
      );
      if (
        !nomination ||
        nomination.source_rollover_id !==
          nomination
            .target_opening_rollover_id ||
        nomination.target_rollover_at_ms !==
          parsed.rolloverAtMs ||
        row.scheduled_for_ms !==
          parsed.rolloverAtMs
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType:
          "nomination_queue",
        resourceId: parsed.queueId,
        fadId,
        playerId:
          nomination.player_id,
        queueId: parsed.queueId,
        rolloverId:
          nomination
            .target_opening_rollover_id,
        rolloverAtMs:
          parsed.rolloverAtMs,
      });
    }

    if (parsed.type === "rollover") {
      const rollover = one(
        rolloverStatement.all({
          ...scope,
          fadId,
          sequence: parsed.sequence,
          rolloverAtMs:
            parsed.rolloverAtMs,
        })
      );
      const processingBindingMatches =
        rollover &&
        (
          (
            rollover.status ===
              "scheduled" &&
            rollover
              .processing_job_run_id ===
              null
          ) ||
          (
            [
              "processing",
              "completed",
              "recovery_required",
            ].includes(rollover.status) &&
            rollover
              .processing_job_run_id ===
              row.id
          )
        );
      if (
        !processingBindingMatches ||
        row.scheduled_for_ms !==
          parsed.rolloverAtMs ||
        !canonicalRollover(
          rollover,
          {
            ...scope,
            fadId,
          }
        )
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType: "rollover",
        resourceId: rollover.id,
        fadId,
        rolloverId: rollover.id,
        sequence: parsed.sequence,
        rolloverAtMs:
          parsed.rolloverAtMs,
      });
    }

    if (parsed.type === "complete") {
      const seventh = one(
        seventhRolloverStatement.all({
          ...scope,
          fadId,
        })
      );
      if (
        !seventh ||
        row.scheduled_for_ms !==
          seventh.rolls_over_at_ms ||
        !canonicalRollover(
          seventh,
          {
            ...scope,
            fadId,
          }
        )
      ) {
        return null;
      }
      return deepFreeze({
        type: parsed.type,
        resourceType:
          "free_agent_draft",
        resourceId: fadId,
        fadId,
        initialWindowEndsAtMs:
          seventh.rolls_over_at_ms,
      });
    }

    return null;
  }

  function descriptor(row, parsed, binding) {
    return deepFreeze({
      runId: row.id,
      leagueId: row.league_id,
      seasonId: row.season_id,
      fadId: binding.fadId,
      jobType: row.job_type,
      occurrenceKey:
        row.occurrence_key,
      scheduledForMs:
        row.scheduled_for_ms,
      status: row.status,
      attemptCount:
        row.attempt_count,
      nextAttemptAtMs:
        row.next_attempt_at_ms,
      leaseExpiresAtMs:
        row.lease_expires_at_ms,
      startedAtMs:
        row.started_at_ms,
      completedAtMs:
        row.completed_at_ms,
      resultJson: row.result_json,
      lastErrorCode:
        row.last_error_code,
      version: row.version,
      parsedOccurrence: parsed,
      binding,
    });
  }

  function describePersisted(row) {
    if (!canonicalPersistedJob(row)) {
      return null;
    }
    let parsed;
    try {
      parsed =
        parseFreeAgentDraftOccurrenceKey(
          row.occurrence_key
        );
    } catch {
      return null;
    }
    if (
      FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE[
        parsed.type
      ] !== row.job_type
    ) {
      return null;
    }
    const binding = proveBinding(
      row,
      parsed
    );
    return binding
      ? descriptor(row, parsed, binding)
      : null;
  }

  function loadExact(command) {
    const row = one(
      byIdStatement.all(command)
    );
    if (
      !row ||
      row.season_id !==
        command.seasonId ||
      row.job_type !== command.jobType ||
      row.occurrence_key !==
        command.occurrenceKey ||
      row.scheduled_for_ms !==
        command.scheduledForMs ||
      row.version !==
        command.expectedVersion
    ) {
      return null;
    }
    const described =
      describePersisted(row);
    if (
      !described ||
      described.fadId !== command.fadId
    ) {
      return null;
    }
    return {
      row,
      described,
    };
  }

  function readinessIdentityMatches(
    job,
    readiness
  ) {
    return Boolean(
      readiness &&
      readiness.league_id === job.league_id &&
      readiness.season_id === job.season_id &&
      readiness.job_run_id === job.id &&
      readiness.readiness_occurrence_key ===
        job.occurrence_key &&
      readiness.created_at_ms ===
        job.scheduled_for_ms &&
      job.created_at_ms === job.scheduled_for_ms &&
      readiness.attempt_count ===
        job.attempt_count &&
      readiness.version === job.version &&
      readiness.updated_at_ms ===
        job.updated_at_ms
    );
  }

  function hasNoReadinessLease(row) {
    return (
      row.lease_owner === null &&
      row.lease_token === null &&
      row.lease_expires_at_ms === null
    );
  }

  function canonicalPersistedLease(
    value,
    maximumLength
  ) {
    return (
      typeof value === "string" &&
      value.length >= 1 &&
      value.length <= maximumLength &&
      value.trim() === value &&
      !CONTROL_PATTERN.test(value)
    );
  }

  function hasNoReadinessOpeningEvidence(row) {
    return (
      row.created_fad_id === null &&
      row.reminder_job_run_id === null &&
      row.deadline_job_run_id === null &&
      row.cards_opened_activity_id === null &&
      row.cards_opened_outbox_event_id === null
    );
  }

  function hasCanonicalBlockers(value, empty) {
    try {
      const blockers = JSON.parse(value);
      return (
        Array.isArray(blockers) &&
        (empty
          ? blockers.length === 0
          : blockers.length >= 1) &&
        JSON.stringify(blockers) === value
      );
    } catch {
      return false;
    }
  }

  function hasCanonicalReadinessRetryBlockers(
    value
  ) {
    try {
      const parsed = JSON.parse(value);
      const normalized =
        normalizeFreeAgentDraftReadinessInternalDiagnostics(
          parsed
        );
      return (
        normalized.length >= 1 &&
        serializeCanonicalJsonV1(normalized) ===
          value
      );
    } catch {
      return false;
    }
  }

  function readinessCanStart(
    job,
    readiness,
    nowMs
  ) {
    if (
      !readinessIdentityMatches(job, readiness) ||
      job.status !== "pending" ||
      !hasNoReadinessLease(job) ||
      job.started_at_ms !== null ||
      job.completed_at_ms !== null ||
      job.result_json !== null ||
      job.last_error_code !== null ||
      job.updated_at_ms > nowMs ||
      !hasNoReadinessLease(readiness) ||
      readiness.updated_at_ms > nowMs ||
      !hasNoReadinessOpeningEvidence(readiness)
    ) {
      return false;
    }
    if (readiness.status === "pending") {
      return (
        job.next_attempt_at_ms === null &&
        readiness.started_at_ms === null &&
        readiness.next_retry_at_ms === null &&
        readiness.terminal_at_ms === null &&
        hasCanonicalBlockers(
          readiness.blockers_json,
          true
        )
      );
    }
    return (
      readiness.status === "blocked" &&
      Number.isSafeInteger(
        job.next_attempt_at_ms
      ) &&
      job.next_attempt_at_ms <= nowMs &&
      readiness.next_retry_at_ms ===
        job.next_attempt_at_ms &&
      Number.isSafeInteger(
        readiness.started_at_ms
      ) &&
      Number.isSafeInteger(
        readiness.terminal_at_ms
      ) &&
      readiness.terminal_at_ms >=
        readiness.started_at_ms &&
      readiness.next_retry_at_ms >
        readiness.terminal_at_ms &&
      hasCanonicalBlockers(
        readiness.blockers_json,
        false
      )
    );
  }

  function readinessCanReclaim(
    job,
    readiness,
    command
  ) {
    return (
      readinessIdentityMatches(job, readiness) &&
      job.status === "running" &&
      readiness.status === "running" &&
      canonicalPersistedLease(
        job.lease_owner,
        128
      ) &&
      canonicalPersistedLease(
        job.lease_token,
        200
      ) &&
      readiness.lease_owner ===
        job.lease_owner &&
      readiness.lease_token ===
        job.lease_token &&
      readiness.lease_expires_at_ms ===
        job.lease_expires_at_ms &&
      readiness.started_at_ms ===
        job.started_at_ms &&
      Number.isSafeInteger(job.started_at_ms) &&
      job.started_at_ms <=
        job.updated_at_ms &&
      Number.isSafeInteger(
        job.lease_expires_at_ms
      ) &&
      job.lease_expires_at_ms >
        job.started_at_ms &&
      job.lease_expires_at_ms <=
        command.nowMs &&
      command.leaseToken !== job.lease_token &&
      job.completed_at_ms === null &&
      job.result_json === null &&
      job.last_error_code === null &&
      job.next_attempt_at_ms === null &&
      readiness.next_retry_at_ms === null &&
      readiness.terminal_at_ms === null &&
      hasNoReadinessOpeningEvidence(readiness) &&
      hasCanonicalBlockers(
        readiness.blockers_json,
        true
      )
    );
  }

  function readinessEvidence(row) {
    return [
      row.blockers_json,
      row.matchup_schedule_version_before,
      row.matchup_schedule_version_after,
      row.schedule_recovery_id,
      row.created_fad_id,
      row.reminder_job_run_id,
      row.deadline_job_run_id,
      row.cards_opened_activity_id,
      row.cards_opened_outbox_event_id,
      row.next_retry_at_ms,
      row.terminal_at_ms,
    ];
  }

  function readinessClaimParameters(
    command,
    job,
    readiness,
    reclaim
  ) {
    return {
      ...command,
      readinessOperationId: readiness.id,
      oldReadinessStatus: readiness.status,
      oldAttemptCount: job.attempt_count,
      oldNextAttemptAtMs:
        job.next_attempt_at_ms,
      oldJobUpdatedAtMs: job.updated_at_ms,
      oldReadinessUpdatedAtMs:
        readiness.updated_at_ms,
      oldReadinessVersion:
        readiness.version,
      oldLeaseOwner: job.lease_owner,
      oldLeaseToken: job.lease_token,
      oldLeaseExpiresAtMs:
        job.lease_expires_at_ms,
      oldStartedAtMs: job.started_at_ms,
      newAttemptCount:
        job.attempt_count + (reclaim ? 0 : 1),
      newVersion: job.version + 1,
    };
  }

  const claimTransaction =
    database.transaction((command) => {
      const exact = loadExact(command);
      if (!exact) {
        return deepFreeze({
          acquired: false,
          occurrence: null,
        });
      }
      if (
        command.parsed.type === "readiness"
      ) {
        const readiness = one(
          readinessStatement.all(command)
        );
        if (
          exact.row.status === "failed" ||
          !readiness ||
          command.nowMs <
            exact.row.updated_at_ms
        ) {
          return deepFreeze({
            acquired: false,
            occurrence: exact.described,
          });
        }
        const reclaim =
          exact.row.status === "running";
        const claimable = reclaim
          ? readinessCanReclaim(
              exact.row,
              readiness,
              command
            )
          : readinessCanStart(
              exact.row,
              readiness,
              command.nowMs
            ) && isDue(exact.row, command.nowMs);
        if (!claimable) {
          return deepFreeze({
            acquired: false,
            occurrence: exact.described,
          });
        }
        const parameters =
          readinessClaimParameters(
            command,
            exact.row,
            readiness,
            reclaim
          );
        const priorEvidence =
          readinessEvidence(readiness);
        const jobStatement = reclaim
          ? reclaimReadinessJobStatement
          : claimReadinessJobStatement;
        if (
          jobStatement.run(parameters)
            .changes !== 1
        ) {
          return deepFreeze({
            acquired: false,
            occurrence: exact.described,
          });
        }
        if (beforeCommit) {
          beforeCommit(
            "claimReadinessJob"
          );
        }
        const operationStatement = reclaim
          ? reclaimReadinessOperationStatement
          : claimReadinessOperationStatement;
        if (
          operationStatement.run(parameters)
            .changes !== 1
        ) {
          conflict(
            "The FAD readiness operation changed during job claim."
          );
        }
        const claimed = one(
          byIdStatement.all(command)
        );
        const claimedReadiness = one(
          readinessStatement.all(command)
        );
        const expectedStartedAtMs = reclaim
          ? exact.row.started_at_ms
          : command.nowMs;
        const described =
          describePersisted(claimed);
        if (
          !described ||
          !readinessIdentityMatches(
            claimed,
            claimedReadiness
          ) ||
          claimed.status !== "running" ||
          claimed.attempt_count !==
            parameters.newAttemptCount ||
          claimed.version !==
            parameters.newVersion ||
          claimed.lease_owner !==
            command.leaseOwner ||
          claimed.lease_token !==
            command.leaseToken ||
          claimed.lease_expires_at_ms !==
            command.leaseExpiresAtMs ||
          claimed.started_at_ms !==
            expectedStartedAtMs ||
          claimed.updated_at_ms !==
            command.nowMs ||
          claimedReadiness.status !==
            "running" ||
          claimedReadiness.lease_owner !==
            command.leaseOwner ||
          claimedReadiness.lease_token !==
            command.leaseToken ||
          claimedReadiness.lease_expires_at_ms !==
            command.leaseExpiresAtMs ||
          claimedReadiness.started_at_ms !==
            expectedStartedAtMs ||
          claimedReadiness.updated_at_ms !==
            command.nowMs ||
          (
            reclaim &&
            JSON.stringify(
              readinessEvidence(
                claimedReadiness
              )
            ) !== JSON.stringify(priorEvidence)
          )
        ) {
          incompatible(
            "The claimed FAD readiness job and operation lost alignment."
          );
        }
        if (beforeCommit) {
          beforeCommit("claim");
        }
        return deepFreeze({
          acquired: true,
          occurrence: described,
        });
      }
      if (
        ![
          "pending",
          "failed",
          "leased",
          "running",
        ].includes(exact.row.status) ||
        !isDue(exact.row, command.nowMs) ||
        command.nowMs <
          exact.row.updated_at_ms
      ) {
        return deepFreeze({
          acquired: false,
          occurrence: exact.described,
        });
      }
      if (
        claimStatement.run(command)
          .changes !== 1
      ) {
        return deepFreeze({
          acquired: false,
          occurrence: exact.described,
        });
      }
      if (beforeCommit) {
        beforeCommit("claim");
      }
      const claimed = one(
        byIdStatement.all(command)
      );
      const described =
        describePersisted(claimed);
      if (!described) {
        incompatible(
          "The claimed FAD job lost its persisted binding."
        );
      }
      return deepFreeze({
        acquired: true,
        occurrence: described,
      });
    });

  function normalizeMutation(
    input,
    operation
  ) {
    const command = {
      ...normalizeExactClaim(input),
      ...leaseIdentity(input),
      completedAtMs: safeTimestamp(
        input.completedAtMs,
        "completion timestamp"
      ),
    };
    if (
      operation === "succeed"
    ) {
      command.resultJson = resultJson(
        Object.prototype.hasOwnProperty.call(
          input,
          "result"
        )
          ? input.result
          : null
      );
    } else {
      command.errorCode = errorCode(
        input.errorCode
      );
      command.nextAttemptAtMs =
        safeTimestamp(
          input.nextAttemptAtMs,
          "next-attempt timestamp"
        );
      if (
        command.nextAttemptAtMs <=
        command.completedAtMs
      ) {
        invalid(
          "The next FAD job attempt must follow failure."
        );
      }
    }
    return command;
  }

  function readinessRetryNotReady() {
    failReadinessRetry(
      FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
        .notReady,
      "The blocked FAD readiness occurrence is not available for retry."
    );
  }

  function requireReadinessRetryOperation(
    command
  ) {
    const parameters =
      readinessRetryParameters(command);
    const readiness = unique(
      readinessRetryOperationStatement,
      parameters,
      "FAD readiness-operation identity is not unique within its league season."
    );
    if (!readiness) {
      failReadinessRetry(
        FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
          .notFound,
        "The FAD readiness operation was not found."
      );
    }
    if (
      !Number.isSafeInteger(
        readiness.version
      ) ||
      readiness.version < 1
    ) {
      incompatible(
        "The FAD readiness operation has an invalid persisted version."
      );
    }
    if (
      readiness.version !==
        command.request.expectedVersion
    ) {
      failReadinessRetry(
        FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES
          .preconditionFailed,
        "The FAD readiness operation changed; refetch it and try again.",
        {
          currentVersion: readiness.version,
          refetch: true,
        }
      );
    }
    return readiness;
  }

  function requireReadinessRetryJob(
    command,
    readiness
  ) {
    const job = unique(
      byIdStatement,
      {
        leagueId: command.request.leagueId,
        runId: readiness.job_run_id,
      },
      "FAD readiness job identity is not unique within its league."
    );
    const described = describePersisted(job);
    if (
      !job ||
      !described ||
      described.binding.resourceId !==
        readiness.id ||
      !readinessIdentityMatches(
        job,
        readiness
      ) ||
      readiness.status !== "blocked" ||
      !Number.isSafeInteger(
        readiness.attempt_count
      ) ||
      readiness.attempt_count < 1 ||
      !hasNoReadinessLease(readiness) ||
      !hasNoReadinessOpeningEvidence(
        readiness
      ) ||
      !hasCanonicalReadinessRetryBlockers(
        readiness.blockers_json
      ) ||
      readiness
          .matchup_schedule_version_before !==
        null ||
      readiness
          .matchup_schedule_version_after !==
        null ||
      readiness.schedule_recovery_id !==
        null ||
      !Number.isSafeInteger(
        readiness.started_at_ms
      ) ||
      !Number.isSafeInteger(
        readiness.terminal_at_ms
      ) ||
      readiness.terminal_at_ms <
        readiness.started_at_ms ||
      !Number.isSafeInteger(
        readiness.next_retry_at_ms
      ) ||
      readiness.next_retry_at_ms <=
        readiness.terminal_at_ms ||
      readiness.updated_at_ms !==
        readiness.terminal_at_ms ||
      job.season_id !==
        command.request.seasonId ||
      job.job_type !== "fad_readiness" ||
      job.id !== readiness.job_run_id ||
      job.occurrence_key !==
        readiness.readiness_occurrence_key ||
      job.scheduled_for_ms !==
        readiness.created_at_ms ||
      job.created_at_ms !==
        readiness.created_at_ms ||
      job.status !== "failed" ||
      job.attempt_count !==
        readiness.attempt_count ||
      job.lease_owner !== null ||
      job.lease_token !== null ||
      job.lease_expires_at_ms !== null ||
      job.started_at_ms !==
        readiness.started_at_ms ||
      job.completed_at_ms !==
        readiness.terminal_at_ms ||
      job.result_json !== null ||
      job.last_error_code !==
        "FAD_READINESS_BLOCKED" ||
      job.next_attempt_at_ms !==
        readiness.next_retry_at_ms ||
      job.updated_at_ms !==
        readiness.updated_at_ms ||
      command.acceptedAtMs <=
        job.completed_at_ms
    ) {
      readinessRetryNotReady();
    }
    return job;
  }

  function readinessRetryWriteParameters({
    actorAuthority,
    command,
    job,
    readiness,
    receipt,
  }) {
    return {
      ...readinessRetryParameters(command),
      ...receipt,
      acceptedAtMs: command.acceptedAtMs,
      actorAuthority,
      actorMembershipId:
        command.actorMembershipId,
      actorUserId:
        command.request.actorUserId,
      attemptCount: readiness.attempt_count,
      clientKey: command.request.clientKey,
      idempotencyExpiresAtMs:
        command.idempotencyExpiresAtMs,
      idempotencyRequestId:
        command.idempotencyRequestId,
      jobRunId: job.id,
      occurrenceKey: job.occurrence_key,
      oldBlockersJson:
        readiness.blockers_json,
      oldCompletedAtMs:
        job.completed_at_ms,
      oldJobUpdatedAtMs:
        job.updated_at_ms,
      oldJobVersion: job.version,
      oldNextAttemptAtMs:
        job.next_attempt_at_ms,
      oldReadinessUpdatedAtMs:
        readiness.updated_at_ms,
      oldScheduleRecoveryId:
        readiness.schedule_recovery_id,
      oldScheduleVersionAfter:
        readiness
          .matchup_schedule_version_after,
      oldScheduleVersionBefore:
        readiness
          .matchup_schedule_version_before,
      oldStartedAtMs: job.started_at_ms,
      operation:
        FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
      readinessOperationId: readiness.id,
      requestSha256:
        command.request.requestSha256,
      retryReceiptId:
        command.retryReceiptId,
      scheduledForMs: job.scheduled_for_ms,
      seasonId: readiness.season_id,
    };
  }

  function requireReadinessRetryPostconditions({
    command,
    expectedReceipt,
    idempotency,
    job,
    priorJob,
    priorReadiness,
    readiness,
    receipt,
  }) {
    const expectedJob = {
      ...priorJob,
      status: "pending",
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      started_at_ms: null,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      next_attempt_at_ms:
        command.acceptedAtMs,
      updated_at_ms:
        command.acceptedAtMs,
      version: priorJob.version + 1,
    };
    const expectedReadiness = {
      ...priorReadiness,
      next_retry_at_ms:
        command.acceptedAtMs,
      updated_at_ms:
        command.acceptedAtMs,
      version: priorReadiness.version + 1,
    };
    const expectedIdempotency = {
      id: command.idempotencyRequestId,
      league_id: command.request.leagueId,
      actor_user_id:
        command.request.actorUserId,
      operation:
        FREE_AGENT_DRAFT_READINESS_RETRY_OPERATION,
      client_key: command.request.clientKey,
      request_hash:
        command.request.requestSha256,
      status: "completed",
      result_type:
        FREE_AGENT_DRAFT_READINESS_RETRY_RESULT_TYPE,
      result_id: command.retryReceiptId,
      created_at_ms: command.acceptedAtMs,
      completed_at_ms: command.acceptedAtMs,
      expires_at_ms:
        command.idempotencyExpiresAtMs,
    };
    let validatedReceipt;
    try {
      validatedReceipt =
        storedReadinessRetryReceipt(receipt);
    } catch (error) {
      incompatible(
        "The persisted FAD readiness-retry receipt is invalid.",
        error
      );
    }
    const described = describePersisted(job);
    if (
      JSON.stringify(job) !==
        JSON.stringify(expectedJob) ||
      JSON.stringify(readiness) !==
        JSON.stringify(expectedReadiness) ||
      JSON.stringify(idempotency) !==
        JSON.stringify(expectedIdempotency) ||
      JSON.stringify(validatedReceipt) !==
        JSON.stringify(expectedReceipt) ||
      !described ||
      described.binding.resourceId !==
        readiness.id ||
      !readinessIdentityMatches(
        job,
        readiness
      )
    ) {
      incompatible(
        "The accepted FAD readiness retry lost its atomic persisted postconditions."
      );
    }
    return validatedReceipt;
  }

  const readinessRetryReplayTransaction =
    database.transaction((command) => {
      requireReadinessRetryAuthority(command);
      return findReadinessRetryReplayResult(
        command
      );
    });

  const requeueReadinessTransaction =
    database.transaction((command) => {
      const actorAuthority =
        requireReadinessRetryAuthority(
          command
        );
      const replay =
        findReadinessRetryReplayResult(
          command
        );
      if (replay) return replay;

      const readiness =
        requireReadinessRetryOperation(
          command
        );
      const job = requireReadinessRetryJob(
        command,
        readiness
      );
      let receipt;
      try {
        receipt =
          createFreeAgentDraftReadinessRetryReceipt(
            {
              acceptedAtMs:
                command.acceptedAtMs,
              acceptedFromVersion:
                readiness.version,
              actorAuthority,
              actorMembershipId:
                command.actorMembershipId,
              actorUserId:
                command.request.actorUserId,
              id: command.retryReceiptId,
              idempotencyRequestId:
                command.idempotencyRequestId,
              jobRunId: job.id,
              leagueId:
                readiness.league_id,
              occurrenceKey:
                job.occurrence_key,
              readinessOperationId:
                readiness.id,
              requestSha256:
                command.request.requestSha256,
              resultingReadinessVersion:
                readiness.version + 1,
              retryAttemptNumber:
                readiness.attempt_count + 1,
              seasonId:
                readiness.season_id,
            }
          );
      } catch (error) {
        incompatible(
          "The persisted FAD readiness state cannot produce a canonical retry receipt.",
          error
        );
      }
      const parameters =
        readinessRetryWriteParameters({
          actorAuthority,
          command,
          job,
          readiness,
          receipt,
        });

      if (
        insertReadinessRetryIdempotencyStatement.run(
          parameters
        ).changes !== 1
      ) {
        incompatible(
          "The FAD readiness-retry idempotency request was not started."
        );
      }
      if (
        requeueReadinessStatement.run(
          parameters
        ).changes !== 1
      ) {
        incompatible(
          "The canonical FAD readiness job was not reset to pending."
        );
      }
      if (
        insertReadinessRetryReceiptStatement.run(
          parameters
        ).changes !== 1
      ) {
        incompatible(
          "The immutable FAD readiness-retry receipt was not persisted."
        );
      }
      if (
        advanceReadinessRetryOperationStatement.run(
          parameters
        ).changes !== 1
      ) {
        incompatible(
          "The blocked FAD readiness operation was not advanced."
        );
      }
      if (
        completeReadinessRetryIdempotencyStatement.run(
          parameters
        ).changes !== 1
      ) {
        incompatible(
          "The FAD readiness-retry idempotency request was not completed."
        );
      }

      const persistedJob = unique(
        byIdStatement,
        {
          leagueId: command.request.leagueId,
          runId: job.id,
        },
        "The requeued FAD readiness job identity is not unique."
      );
      const persistedReadiness = unique(
        readinessRetryOperationStatement,
        readinessRetryParameters(command),
        "The advanced FAD readiness-operation identity is not unique."
      );
      const persistedIdempotency = unique(
        readinessRetryIdempotencyStatement,
        readinessRetryParameters(command),
        "The completed FAD readiness-retry idempotency scope is not unique."
      );
      const persistedReceipt = unique(
        readinessRetryReceiptStatement,
        {
          leagueId: command.request.leagueId,
          retryReceiptId:
            command.retryReceiptId,
        },
        "The FAD readiness-retry receipt identity is not unique."
      );
      if (
        !persistedJob ||
        !persistedReadiness ||
        !persistedIdempotency ||
        !persistedReceipt
      ) {
        incompatible(
          "The accepted FAD readiness retry is missing persisted evidence."
        );
      }
      const validatedReceipt =
        requireReadinessRetryPostconditions({
          command,
          expectedReceipt: receipt,
          idempotency:
            persistedIdempotency,
          job: persistedJob,
          priorJob: job,
          priorReadiness: readiness,
          readiness: persistedReadiness,
          receipt: persistedReceipt,
        });
      if (beforeCommit) {
        beforeCommit("requeueReadiness");
      }
      return safeReadinessRetryResult(
        validatedReceipt,
        false
      );
    });

  function guardedMutation(
    statement,
    command,
    operation
  ) {
    return database
      .transaction((input) => {
        const exact = loadExact(input);
        if (
          !exact ||
          exact.row.status !== "running" ||
          exact.row.lease_owner !==
            input.leaseOwner ||
          exact.row.lease_token !==
            input.leaseToken ||
          exact.row.lease_expires_at_ms <=
            input.completedAtMs ||
          exact.row.started_at_ms >
            input.completedAtMs ||
          exact.row.updated_at_ms >
            input.completedAtMs
        ) {
          conflict(
            "The FAD job lease token, version, or binding changed."
          );
        }
        if (
          statement.run(input).changes !==
          1
        ) {
          conflict(
            "The FAD job lease token or version changed."
          );
        }
        if (beforeCommit) {
          beforeCommit(operation);
        }
        const updated = one(
          byIdStatement.all(input)
        );
        const described =
          describePersisted(updated);
        if (!described) {
          incompatible(
            "The completed FAD job lost its persisted binding."
          );
        }
        return described;
      })
      .immediate(command);
  }

  return Object.freeze({
    listDue({
      nowMs,
      limit = 25,
    } = {}) {
      const observedAtMs = safeTimestamp(
        nowMs,
        "due-query timestamp"
      );
      const boundedLimit = positiveInteger(
        limit,
        "due-query limit"
      );
      if (boundedLimit > 100) {
        invalid(
          "The FAD due-query limit is too large."
        );
      }
      try {
        const rows = dueStatement.all(
          ...FREE_AGENT_DRAFT_JOB_TYPES,
          observedAtMs,
          observedAtMs,
          observedAtMs,
          boundedLimit + 1
        );
        const due = [];
        let malformed = null;
        for (const row of rows) {
          const described =
            describePersisted(row);
          if (!described && !malformed) {
            malformed = row;
          } else if (described) {
            due.push(described);
          }
        }
        if (malformed) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES
              .schemaIncompatible,
            "A due FAD job has invalid persisted lifecycle or source binding.",
            {
              details: {
                runId:
                  typeof malformed?.id ===
                  "string"
                    ? malformed.id
                    : null,
                jobType:
                  typeof malformed
                    ?.job_type === "string"
                    ? malformed.job_type
                    : null,
                occurrenceKey:
                  typeof malformed
                    ?.occurrence_key ===
                  "string"
                    ? malformed
                        .occurrence_key
                    : null,
                schedulerBlocked: true,
                blockedValidRunIds:
                  Object.freeze(
                    due.map(
                      ({ runId }) => runId
                    )
                  ),
              },
            }
          );
        }
        return Object.freeze(
          due.slice(0, boundedLimit)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listDueFadJobs",
          tableName: "job_runs",
        });
      }
    },

    claim(input = {}) {
      const exact =
        normalizeExactClaim(input);
      const nowMs = safeTimestamp(
        input.nowMs,
        "claim timestamp"
      );
      const leaseExpiresAtMs =
        safeTimestamp(
          input.leaseExpiresAtMs,
          "lease-expiry timestamp"
        );
      if (leaseExpiresAtMs <= nowMs) {
        invalid(
          "The FAD job lease expiry must follow the claim."
        );
      }
      const command = {
        ...exact,
        ...leaseIdentity(input),
        nowMs,
        leaseExpiresAtMs,
      };
      try {
        return claimTransaction.immediate(
          command
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "claimFadJob",
          tableName: "job_runs",
        });
      }
    },

    findReadinessRetryReplay(input = {}) {
      const command =
        normalizeReadinessRetryIdentity(
          input
        );
      try {
        requireReadinessRetryStorage();
        return readinessRetryReplayTransaction.deferred(
          command
        );
      } catch (error) {
        if (
          error instanceof
          FreeAgentDraftReadinessRetryRepositoryError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "findFadReadinessRetryReplay",
          tableName:
            "free_agent_draft_readiness_retry_receipts",
        });
      }
    },

    requeueReadiness(input = {}) {
      const command =
        normalizeReadinessRetryWrite(input);
      try {
        requireReadinessRetryStorage();
        return requeueReadinessTransaction.immediate(
          command
        );
      } catch (error) {
        if (
          error instanceof
          FreeAgentDraftReadinessRetryRepositoryError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "requeueFadReadinessJob",
          tableName: "job_runs",
        });
      }
    },

    succeed(input = {}) {
      const command = normalizeMutation(
        input,
        "succeed"
      );
      try {
        return guardedMutation(
          succeedStatement,
          command,
          "succeed"
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "succeedFadJob",
          tableName: "job_runs",
        });
      }
    },

    fail(input = {}) {
      const command = normalizeMutation(
        input,
        "fail"
      );
      try {
        return guardedMutation(
          failStatement,
          command,
          "fail"
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "failFadJob",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_JOB_REPOSITORY_METHODS,
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
  FREE_AGENT_DRAFT_JOB_TYPES,
  FREE_AGENT_DRAFT_READINESS_RETRY_REPOSITORY_CODES,
  FREE_AGENT_DRAFT_READINESS_RETRY_RESULT_TYPE,
  FreeAgentDraftReadinessRetryRepositoryError,
  createSqliteFreeAgentDraftJobRepository,
};
