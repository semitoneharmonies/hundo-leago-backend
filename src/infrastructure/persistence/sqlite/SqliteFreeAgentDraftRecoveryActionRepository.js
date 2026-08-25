"use strict";

const {
  FreeAgentDraftRecoveryPolicyError,
  getFreeAgentDraftRecoveryActionPolicy,
  hashFreeAgentDraftRecoveryAcceptedOperation,
  hashFreeAgentDraftRecoveryActionRequest,
  normalizeFreeAgentDraftRecoveryActionBody,
  projectFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryActionRequest,
  validateFreeAgentDraftRecoveryIdempotencyKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  parseFreeAgentDraftOccurrenceKey,
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  buildAuctionResolutionOccurrenceKey,
} = require(
  "../../../domain/auctions/auctionResolutionPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const IDEMPOTENCY_OPERATION =
  "free_agent_draft.recovery.action";
const RESULT_TYPE =
  "free_agent_draft_recovery_action_command_result";
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied: "NOT_AUTHORIZED",
    fadNotFound: "FREE_AGENT_DRAFT_NOT_FOUND",
    idempotencyConflict: "IDEMPOTENCY_KEY_REUSED",
    recoveryNotAvailable: "RECOVERY_NOT_AVAILABLE",
  });

class FreeAgentDraftRecoveryActionRepositoryError
  extends Error {
  constructor(code, message) {
    super(message);
    this.name =
      "FreeAgentDraftRecoveryActionRepositoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FreeAgentDraftRecoveryActionRepositoryError(
    code,
    message
  );
}

function invalid(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function incompatible(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function exactObject(value, expectedFields, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).sort().join("|") !==
      [...expectedFields].sort().join("|")
  ) {
    invalid(`An exact ${description} is required.`);
  }
  return value;
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function lowercaseSha256(value, description) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value)
  ) {
    invalid(`A lowercase ${description} is required.`);
  }
  return value;
}

function normalizeAuthority(value) {
  if (
    value !== "commissioner" &&
    value !==
      "platform_administrator_as_commissioner"
  ) {
    invalid("A canonical recovery actor authority is required.");
  }
  return value;
}

function normalizeIdentity(input) {
  exactObject(
    input,
    [
      "actorAuthority",
      "actorMembershipId",
      "actorUserId",
      "body",
      "clientKey",
      "fadId",
      "leagueId",
      "requestJson",
      "requestSha256",
    ],
    "FAD recovery-action replay input"
  );
  let body;
  let clientKey;
  try {
    body = normalizeFreeAgentDraftRecoveryActionBody(
      input.body
    );
    clientKey =
      validateFreeAgentDraftRecoveryIdempotencyKey(
        input.clientKey
      );
  } catch (error) {
    if (
      error instanceof FreeAgentDraftRecoveryPolicyError
    ) {
      invalid("The FAD recovery-action identity is invalid.", error);
    }
    throw error;
  }
  const leagueId = stableId(input.leagueId, "league ID");
  const fadId = stableId(input.fadId, "FAD ID");
  const request = { body, fadId, leagueId };
  const requestJson =
    serializeFreeAgentDraftRecoveryActionRequest(request);
  const requestSha256 =
    hashFreeAgentDraftRecoveryActionRequest(request);
  if (
    input.requestJson !== requestJson ||
    lowercaseSha256(
      input.requestSha256,
      "recovery request hash"
    ) !== requestSha256
  ) {
    invalid(
      "The FAD recovery-action request evidence is not canonical."
    );
  }
  const policy =
    getFreeAgentDraftRecoveryActionPolicy(body.action);
  const resourceKind =
    policy.resourceType === "free_agent_draft"
      ? "fad"
      : policy.resourceType;
  return deepFreeze({
    actorAuthority: normalizeAuthority(
      input.actorAuthority
    ),
    actorMembershipId: stableId(
      input.actorMembershipId,
      "actor membership ID"
    ),
    actorUserId: stableId(
      input.actorUserId,
      "actor user ID"
    ),
    action: body.action,
    body,
    clientKey,
    fadId,
    leagueId,
    policy,
    publicResourceId: body.resourceId,
    reason: body.reason,
    recoveryKind: policy.recoveryKind,
    requestJson,
    requestSha256,
    resourceId:
      resourceKind === "fad"
        ? fadId
        : body.resourceId,
    resourceKind,
    jobType: policy.jobType,
  });
}

function normalizeReplayInput(input) {
  return normalizeIdentity(input);
}

function normalizeWriteInput(input) {
  exactObject(
    input,
    [
      "acceptedAtMs",
      "actorAuthority",
      "actorMembershipId",
      "actorUserId",
      "body",
      "clientKey",
      "commandResultId",
      "fadId",
      "idempotencyExpiresAtMs",
      "idempotencyRequestId",
      "leagueId",
      "requestJson",
      "requestSha256",
    ],
    "FAD recovery-action write input"
  );
  const identity = normalizeIdentity({
    actorAuthority: input.actorAuthority,
    actorMembershipId: input.actorMembershipId,
    actorUserId: input.actorUserId,
    body: input.body,
    clientKey: input.clientKey,
    fadId: input.fadId,
    leagueId: input.leagueId,
    requestJson: input.requestJson,
    requestSha256: input.requestSha256,
  });
  const acceptedAtMs = safeTimestamp(
    input.acceptedAtMs,
    "recovery acceptance timestamp"
  );
  const idempotencyExpiresAtMs = safeTimestamp(
    input.idempotencyExpiresAtMs,
    "recovery idempotency expiry"
  );
  if (idempotencyExpiresAtMs <= acceptedAtMs) {
    invalid(
      "FAD recovery idempotency must expire after acceptance."
    );
  }
  return deepFreeze({
    ...identity,
    acceptedAtMs,
    commandResultId: stableId(
      input.commandResultId,
      "recovery command-result ID"
    ),
    idempotencyExpiresAtMs,
    idempotencyRequestId: stableId(
      input.idempotencyRequestId,
      "idempotency-request ID"
    ),
  });
}

function unique(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} is not unique.`);
  }
  return rows[0] || null;
}

function parseFadOccurrence(row, command) {
  let parsed;
  try {
    parsed = parseFreeAgentDraftOccurrenceKey(
      row.occurrence_key
    );
  } catch (error) {
    incompatible(
      "The FAD recovery job occurrence is not canonical.",
      error
    );
  }
  if (
    parsed.fadId !== command.fadId ||
    parsed.type !== command.policy.occurrenceType
  ) {
    incompatible(
      "The FAD recovery job occurrence is outside its action scope."
    );
  }
  return parsed;
}

function requireCanonicalRecoveryBinding(row, command) {
  if (
    !row ||
    row.recovery_job_run_id === null ||
    row.recovery_job_run_id !==
      row.created_by_operation_id ||
    row.job_id !== row.recovery_job_run_id ||
    row.job_league_id !== command.leagueId ||
    row.job_season_id !== row.season_id ||
    row.job_type !== command.policy.jobType ||
    row.recovery_kind !== command.policy.recoveryKind
  ) {
    incompatible(
      "The FAD recovery is not bound to its canonical durable job."
    );
  }

  if (
    command.policy.occurrenceType ===
    "auction_resolution"
  ) {
    if (
      row.auction_id !== command.resourceId ||
      row.auction_fad_id !== command.fadId ||
      row.auction_player_id !== row.player_id ||
      row.auction_resolves_at_ms === null
    ) {
      incompatible(
        "The FAD auction recovery resource binding is invalid."
      );
    }
    let expectedOccurrence;
    try {
      expectedOccurrence =
        buildAuctionResolutionOccurrenceKey({
          auctionId: command.resourceId,
          dueAtMs: row.auction_resolves_at_ms,
        });
    } catch (error) {
      incompatible(
        "The FAD auction recovery occurrence is invalid.",
        error
      );
    }
    if (
      row.occurrence_key !== expectedOccurrence ||
      row.job_scheduled_for_ms !==
        row.auction_resolves_at_ms
    ) {
      incompatible(
        "The FAD auction recovery job changed its canonical schedule."
      );
    }
    return;
  }

  const parsed = parseFadOccurrence(row, command);
  if (command.body.action === "retry_deadline") {
    if (
      parsed.deadlineAtMs !==
        row.candidate_deadline_at_ms ||
      row.job_scheduled_for_ms !==
        row.candidate_deadline_at_ms
    ) {
      incompatible(
        "The FAD deadline recovery job changed its canonical schedule."
      );
    }
    return;
  }
  if (command.body.action === "retry_allocation") {
    if (
      row.allocation_id !== command.resourceId ||
      row.allocation_player_id !== row.player_id ||
      parsed.playerId !== row.player_id ||
      row.job_scheduled_for_ms !==
        row.candidate_deadline_at_ms
    ) {
      incompatible(
        "The FAD allocation recovery resource binding is invalid."
      );
    }
    return;
  }
  if (
    command.body.action === "activate_restricted" ||
    command.body.action === "activate_fallback"
  ) {
    if (
      row.allocation_id !== command.resourceId ||
      row.allocation_player_id !== row.player_id ||
      parsed.allocationId !== command.resourceId ||
      parsed.activationAtMs !==
        row.earliest_activation_at_ms ||
      row.job_scheduled_for_ms !==
        row.earliest_activation_at_ms
    ) {
      incompatible(
        "The FAD activation recovery resource binding is invalid."
      );
    }
    return;
  }
  if (
    command.body.action ===
    "activate_queued_nomination"
  ) {
    if (
      row.nomination_queue_id !== command.resourceId ||
      row.queue_player_id !== row.player_id ||
      row.queue_rollover_id !== row.rollover_id ||
      parsed.queueId !== command.resourceId ||
      parsed.rolloverAtMs !==
        row.queue_rollover_at_ms ||
      row.job_scheduled_for_ms !==
        row.queue_rollover_at_ms
    ) {
      incompatible(
        "The queued-nomination recovery resource binding is invalid."
      );
    }
    return;
  }
  if (command.body.action === "finalize_rollover") {
    if (
      row.rollover_id !== command.resourceId ||
      parsed.sequence !== row.rollover_sequence ||
      parsed.rolloverAtMs !== row.rollover_at_ms ||
      row.job_scheduled_for_ms !== row.rollover_at_ms
    ) {
      incompatible(
        "The FAD rollover recovery resource binding is invalid."
      );
    }
  }
}

function createSqliteFreeAgentDraftRecoveryActionRepository({
  database,
  beforeCommit = () => {},
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteFreeAgentDraftRecoveryActionRepository requires an opened database"
    );
  }
  if (typeof beforeCommit !== "function") {
    throw new TypeError(
      "FAD recovery-action beforeCommit must be a function"
    );
  }

  let findAuthority;
  let findFad;
  let findIdempotency;
  let findResult;
  let findRecoveries;
  let findJobById;
  let insertIdempotency;
  let resetFailedJob;
  let restartCorrectionRecovery;
  let insertResult;
  let completeIdempotency;
  let replayTransaction;
  let acceptTransaction;

  function requireAuthority(command) {
    const row = unique(
      findAuthority,
      command,
      "FAD recovery-action authority"
    );
    if (
      !row ||
      row.user_status !== "active" ||
      row.membership_status !== "active"
    ) {
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .authorizationDenied,
        "Current FAD recovery authority is required."
      );
    }
    if (
      row.commissioner_membership_id ===
        command.actorMembershipId
    ) {
      return "commissioner";
    }
    if (row.is_platform_administrator === 1) {
      return "platform_administrator_as_commissioner";
    }
    fail(
      FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
        .authorizationDenied,
      "Current FAD recovery authority is required."
    );
  }

  function safeStoredResult(row, command, replayed) {
    if (
      !row ||
      row.league_id !== command.leagueId ||
      row.fad_id !== command.fadId ||
      row.idempotency_request_id !==
        command.idempotencyId ||
      row.actor_user_id !== command.actorUserId ||
      row.actor_membership_id !==
        command.actorMembershipId ||
      row.action !== command.body.action ||
      row.resource_kind !== command.resourceKind ||
      row.resource_id !== command.resourceId ||
      row.request_json !== command.requestJson ||
      row.request_sha256 !== command.requestSha256 ||
      row.response_http_status !== 202 ||
      row.version !== 1
    ) {
      incompatible(
        "The completed FAD recovery action has no exact immutable result."
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(row.response_json);
    } catch (error) {
      incompatible(
        "The stored FAD recovery response is not JSON.",
        error
      );
    }
    let data;
    try {
      data =
        projectFreeAgentDraftRecoveryAcceptedOperation(
          parsed
        );
    } catch (error) {
      incompatible(
        "The stored FAD recovery response is invalid.",
        error
      );
    }
    if (
      serializeFreeAgentDraftRecoveryAcceptedOperation(
        data
      ) !== row.response_json ||
      hashFreeAgentDraftRecoveryAcceptedOperation(data) !==
        row.response_sha256 ||
      data.action !== command.body.action ||
      data.resourceId !== command.publicResourceId ||
      data.pollDescriptor.leagueId !==
        command.leagueId ||
      data.pollDescriptor.fadId !== command.fadId ||
      data.operationId !== row.operation_id ||
      data.occurrenceKey !== row.occurrence_key ||
      data.acceptedAtMs !== row.accepted_at_ms ||
      data.status !== row.accepted_status
    ) {
      incompatible(
        "The stored FAD recovery response evidence is inconsistent."
      );
    }
    return deepFreeze({
      data,
      httpStatus: 202,
      replayed,
    });
  }

  function findReplay(command) {
    const idempotency = unique(
      findIdempotency,
      {
        actorUserId: command.actorUserId,
        clientKey: command.clientKey,
        leagueId: command.leagueId,
      },
      "FAD recovery-action idempotency scope"
    );
    if (!idempotency) return null;
    if (
      idempotency.request_hash !==
        command.requestSha256
    ) {
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .idempotencyConflict,
        "The idempotency key was already used with different input."
      );
    }
    if (
      idempotency.status !== "completed" ||
      idempotency.result_type !== RESULT_TYPE ||
      !UUID_PATTERN.test(
        idempotency.result_id || ""
      )
    ) {
      incompatible(
        "The FAD recovery-action idempotency request is incomplete."
      );
    }
    const replayCommand = {
      ...command,
      idempotencyId: idempotency.id,
    };
    const row = unique(
      findResult,
      {
        leagueId: command.leagueId,
        resultId: idempotency.result_id,
      },
      "FAD recovery-action result"
    );
    return safeStoredResult(
      row,
      replayCommand,
      true
    );
  }

  function requireFad(command) {
    const row = unique(
      findFad,
      command,
      "FAD recovery-action aggregate"
    );
    if (!row) {
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .fadNotFound,
        "The Free Agent Draft was not found."
      );
    }
    return row;
  }

  function requireRecovery(command, fad) {
    const rows = findRecoveries.all(command);
    const open = rows.filter(
      (row) => row.recovery_status !== "resolved"
    );
    if (open.length > 1) {
      incompatible(
        "More than one active FAD recovery exists for the action resource."
      );
    }
    const row = open[0] || rows[0] || null;
    if (!row) {
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .recoveryNotAvailable,
        "No recovery is available for this FAD action."
      );
    }
    if (
      row.season_id !== fad.season_id ||
      row.fad_id !== command.fadId
    ) {
      incompatible(
        "The FAD recovery escaped its aggregate scope."
      );
    }
    requireCanonicalRecoveryBinding(row, command);
    return row;
  }

  function acceptedStatus(recovery) {
    if (recovery.recovery_status === "resolved") {
      if (recovery.job_status === "succeeded") {
        return "already_succeeded";
      }
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .recoveryNotAvailable,
        "The terminal recovery has no retryable job."
      );
    }
    if (
      ["pending", "leased", "running"].includes(
        recovery.job_status
      ) &&
      ["pending", "ready", "running"].includes(
        recovery.recovery_status
      )
    ) {
      return "pending";
    }
    if (
      recovery.job_status === "failed" &&
      [
        "pending",
        "ready",
        "running",
        "correction_required",
      ].includes(recovery.recovery_status)
    ) {
      return "pending";
    }
    incompatible(
      "The FAD recovery and durable job states are inconsistent."
    );
  }

  function persist(command, actorAuthority, recovery) {
    if (recovery.job_updated_at_ms > command.acceptedAtMs) {
      fail(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES
          .recoveryNotAvailable,
        "The recovery job changed after this request was accepted."
      );
    }
    const status = acceptedStatus(recovery);
    const data =
      projectFreeAgentDraftRecoveryAcceptedOperation({
        acceptedAtMs: command.acceptedAtMs,
        action: command.body.action,
        occurrenceKey: recovery.occurrence_key,
        operationId: recovery.job_id,
        pollDescriptor: {
          fadId: command.fadId,
          kind: "fad_recovery",
          leagueId: command.leagueId,
        },
        resourceId: command.publicResourceId,
        status,
      });
    const responseJson =
      serializeFreeAgentDraftRecoveryAcceptedOperation(
        data
      );
    const responseSha256 =
      hashFreeAgentDraftRecoveryAcceptedOperation(data);
    const parameters = {
      ...command,
      acceptedStatus: status,
      actorAuthority,
      jobRunId: recovery.job_id,
      jobScheduledForMs:
        recovery.job_scheduled_for_ms,
      jobVersion: recovery.job_version,
      occurrenceKey: recovery.occurrence_key,
      recoveryId: recovery.recovery_id,
      recoveryVersion: recovery.recovery_version,
      responseJson,
      responseSha256,
      seasonId: recovery.season_id,
    };
    if (insertIdempotency.run(parameters).changes !== 1) {
      incompatible(
        "The FAD recovery idempotency request was not started."
      );
    }
    if (recovery.job_status === "failed") {
      if (resetFailedJob.run(parameters).changes !== 1) {
        incompatible(
          "The failed FAD recovery job was not requeued."
        );
      }
    }
    if (
      recovery.recovery_status ===
      "correction_required"
    ) {
      if (
        restartCorrectionRecovery.run(parameters)
          .changes !== 1
      ) {
        incompatible(
          "The correction-required FAD recovery was not restarted."
        );
      }
    }
    if (insertResult.run(parameters).changes !== 1) {
      incompatible(
        "The immutable FAD recovery result was not persisted."
      );
    }
    if (
      completeIdempotency.run(parameters).changes !== 1
    ) {
      incompatible(
        "The FAD recovery idempotency request was not completed."
      );
    }

    const persistedIdempotency = unique(
      findIdempotency,
      {
        actorUserId: command.actorUserId,
        clientKey: command.clientKey,
        leagueId: command.leagueId,
      },
      "persisted FAD recovery idempotency scope"
    );
    const persistedResult = unique(
      findResult,
      {
        leagueId: command.leagueId,
        resultId: command.commandResultId,
      },
      "persisted FAD recovery result"
    );
    const persistedJob = unique(
      findJobById,
      {
        jobRunId: recovery.job_id,
        leagueId: command.leagueId,
      },
      "persisted FAD recovery job"
    );
    if (
      !persistedIdempotency ||
      persistedIdempotency.status !== "completed" ||
      persistedIdempotency.result_type !== RESULT_TYPE ||
      persistedIdempotency.result_id !==
        command.commandResultId ||
      persistedIdempotency.completed_at_ms !==
        command.acceptedAtMs ||
      !persistedJob ||
      persistedJob.id !== recovery.job_id ||
      persistedJob.job_type !== recovery.job_type ||
      persistedJob.occurrence_key !==
        recovery.occurrence_key ||
      persistedJob.scheduled_for_ms !==
        recovery.job_scheduled_for_ms ||
      (
        recovery.job_status === "failed" &&
        (
          persistedJob.status !== "pending" ||
          persistedJob.version !==
            recovery.job_version + 1 ||
          persistedJob.next_attempt_at_ms !==
            command.acceptedAtMs ||
          persistedJob.lease_owner !== null ||
          persistedJob.lease_token !== null ||
          persistedJob.lease_expires_at_ms !== null ||
          persistedJob.started_at_ms !== null ||
          persistedJob.completed_at_ms !== null ||
          persistedJob.result_json !== null ||
          persistedJob.last_error_code !== null
        )
      ) ||
      (
        recovery.job_status !== "failed" &&
        (
          persistedJob.status !== recovery.job_status ||
          persistedJob.version !== recovery.job_version
        )
      )
    ) {
      incompatible(
        "The accepted FAD recovery lost its atomic persisted postconditions."
      );
    }
    const resultCommand = {
      ...command,
      idempotencyId: command.idempotencyRequestId,
    };
    const result = safeStoredResult(
      persistedResult,
      resultCommand,
      false
    );
    beforeCommit("acceptRecoveryAction", result);
    return result;
  }

  try {
    findAuthority = database.prepare(`
      SELECT
        leagues.commissioner_membership_id,
        users.status AS user_status,
        league_memberships.status AS membership_status,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = @actorUserId
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
            AND platform_roles.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM leagues
      JOIN users ON users.id = @actorUserId
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = @actorMembershipId
       AND league_memberships.user_id = @actorUserId
       AND league_memberships.status = 'active'
       AND league_memberships.joined_at_ms IS NOT NULL
       AND league_memberships.ended_at_ms IS NULL
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findFad = database.prepare(`
      SELECT season_id
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND id = @fadId
      LIMIT 2
    `);
    findIdempotency = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = '${IDEMPOTENCY_OPERATION}'
        AND client_key = @clientKey
      LIMIT 2
    `);
    findResult = database.prepare(`
      SELECT *
      FROM free_agent_draft_recovery_action_command_results
      WHERE league_id = @leagueId
        AND id = @resultId
      LIMIT 2
    `);
    findRecoveries = database.prepare(`
      SELECT
        recovery.id AS recovery_id,
        recovery.league_id,
        recovery.season_id,
        recovery.fad_id,
        recovery.player_id,
        recovery.allocation_id,
        recovery.rollover_id,
        recovery.auction_id,
        recovery.nomination_queue_id,
        recovery.job_run_id AS recovery_job_run_id,
        recovery.created_by_operation_id,
        recovery.kind AS recovery_kind,
        recovery.status AS recovery_status,
        recovery.earliest_activation_at_ms,
        recovery.created_at_ms AS recovery_created_at_ms,
        recovery.version AS recovery_version,
        job.id AS job_id,
        job.league_id AS job_league_id,
        job.season_id AS job_season_id,
        job.job_type,
        job.occurrence_key,
        job.scheduled_for_ms AS job_scheduled_for_ms,
        job.status AS job_status,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version,
        allocation.player_id AS allocation_player_id,
        rollover.sequence AS rollover_sequence,
        rollover.rolls_over_at_ms AS rollover_at_ms,
        queue.player_id AS queue_player_id,
        queue.target_opening_rollover_id AS queue_rollover_id,
        queue_rollover.rolls_over_at_ms AS queue_rollover_at_ms,
        auction.player_id AS auction_player_id,
        auction.resolves_at_ms AS auction_resolves_at_ms,
        context.fad_id AS auction_fad_id,
        fad.candidate_deadline_at_ms
      FROM free_agent_draft_recoveries AS recovery
      JOIN free_agent_drafts AS fad
        ON fad.league_id = recovery.league_id
       AND fad.season_id = recovery.season_id
       AND fad.id = recovery.fad_id
      LEFT JOIN job_runs AS job
        ON job.league_id = recovery.league_id
       AND job.season_id = recovery.season_id
       AND job.id = recovery.job_run_id
      LEFT JOIN free_agent_draft_player_allocations AS allocation
        ON allocation.league_id = recovery.league_id
       AND allocation.season_id = recovery.season_id
       AND allocation.fad_id = recovery.fad_id
       AND allocation.id = recovery.allocation_id
      LEFT JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = recovery.league_id
       AND rollover.season_id = recovery.season_id
       AND rollover.fad_id = recovery.fad_id
       AND rollover.id = recovery.rollover_id
      LEFT JOIN free_agent_draft_nomination_queue AS queue
        ON queue.league_id = recovery.league_id
       AND queue.season_id = recovery.season_id
       AND queue.fad_id = recovery.fad_id
       AND queue.id = recovery.nomination_queue_id
      LEFT JOIN free_agent_draft_rollovers AS queue_rollover
        ON queue_rollover.league_id = queue.league_id
       AND queue_rollover.season_id = queue.season_id
       AND queue_rollover.fad_id = queue.fad_id
       AND queue_rollover.id = queue.target_opening_rollover_id
      LEFT JOIN auctions AS auction
        ON auction.league_id = recovery.league_id
       AND auction.season_id = recovery.season_id
       AND auction.id = recovery.auction_id
      LEFT JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
       AND context.fad_id = recovery.fad_id
      WHERE recovery.league_id = @leagueId
        AND recovery.fad_id = @fadId
        AND recovery.kind = @recoveryKind
        AND (
          (@resourceKind = 'fad')
          OR (
            @resourceKind = 'allocation'
            AND recovery.allocation_id = @resourceId
          )
          OR (
            @resourceKind = 'nomination_queue'
            AND recovery.nomination_queue_id = @resourceId
          )
          OR (
            @resourceKind = 'auction'
            AND recovery.auction_id = @resourceId
          )
          OR (
            @resourceKind = 'rollover'
            AND recovery.rollover_id = @resourceId
          )
        )
      ORDER BY
        CASE WHEN recovery.status = 'resolved'
          THEN 1 ELSE 0 END,
        recovery.created_at_ms DESC,
        recovery.id DESC
    `);
    findJobById = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND id = @jobRunId
      LIMIT 2
    `);
    insertIdempotency = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation,
        client_key, request_hash, status,
        result_type, result_id, created_at_ms,
        completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId,
        @actorUserId, '${IDEMPOTENCY_OPERATION}',
        @clientKey, @requestSha256, 'started',
        NULL, NULL, @acceptedAtMs, NULL,
        @idempotencyExpiresAtMs
      )
    `);
    resetFailedJob = database.prepare(`
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
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @jobRunId
        AND job_type = @jobType
        AND occurrence_key = @occurrenceKey
        AND scheduled_for_ms = @jobScheduledForMs
        AND status = 'failed'
        AND version = @jobVersion
    `);
    restartCorrectionRecovery = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'running',
          commissioner_reason = @reason,
          updated_at_ms = @acceptedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @recoveryId
        AND status = 'correction_required'
        AND version = @recoveryVersion
    `);
    insertResult = database.prepare(`
      INSERT INTO free_agent_draft_recovery_action_command_results (
        id, league_id, season_id, fad_id, recovery_id,
        idempotency_request_id, action, resource_kind,
        resource_id, operation_id, job_run_id,
        occurrence_key, actor_user_id,
        actor_membership_id, actor_authority,
        commissioner_reason, request_json,
        request_sha256, accepted_status, accepted_at_ms,
        response_http_status, response_json,
        response_sha256, version
      ) VALUES (
        @commandResultId, @leagueId, @seasonId, @fadId,
        @recoveryId, @idempotencyRequestId, @action,
        @resourceKind, @resourceId, @jobRunId, @jobRunId,
        @occurrenceKey, @actorUserId, @actorMembershipId,
        @actorAuthority, @reason, @requestJson,
        @requestSha256, @acceptedStatus, @acceptedAtMs,
        202, @responseJson, @responseSha256, 1
      )
    `);
    completeIdempotency = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = '${RESULT_TYPE}',
          result_id = @commandResultId,
          completed_at_ms = @acceptedAtMs
      WHERE league_id = @leagueId
        AND id = @idempotencyRequestId
        AND status = 'started'
    `);

    replayTransaction = database.transaction((command) => {
      requireAuthority(command);
      return findReplay(command);
    });
    acceptTransaction = database.transaction((command) => {
      const actorAuthority = requireAuthority(command);
      const replay = findReplay(command);
      if (replay) return replay;
      const fad = requireFad(command);
      const recovery = requireRecovery(command, fad);
      return persist(command, actorAuthority, recovery);
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftRecoveryActionRepository",
      tableName:
        "free_agent_draft_recovery_action_command_results",
    });
  }

  return Object.freeze({
    findRecoveryActionReplay(input = {}) {
      const command = normalizeReplayInput(input);
      try {
        return replayTransaction.deferred(command);
      } catch (error) {
        if (
          error instanceof
            FreeAgentDraftRecoveryActionRepositoryError ||
          error instanceof FreeAgentDraftRecoveryPolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "findFadRecoveryActionReplay",
          tableName:
            "free_agent_draft_recovery_action_command_results",
        });
      }
    },
    acceptRecoveryAction(input = {}) {
      const command = normalizeWriteInput(input);
      try {
        return acceptTransaction.immediate(command);
      } catch (error) {
        if (
          error instanceof
            FreeAgentDraftRecoveryActionRepositoryError ||
          error instanceof FreeAgentDraftRecoveryPolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "acceptFadRecoveryAction",
          tableName:
            "free_agent_draft_recovery_action_command_results",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_RECOVERY_ACTION_REPOSITORY_CODES,
  FreeAgentDraftRecoveryActionRepositoryError,
  IDEMPOTENCY_OPERATION,
  RESULT_TYPE,
  createSqliteFreeAgentDraftRecoveryActionRepository,
};
