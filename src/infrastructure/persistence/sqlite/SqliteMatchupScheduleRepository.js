const {
  MATCHUP_SCHEDULE_COMMAND_CODE,
  MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS,
  MATCHUP_SCHEDULE_COMMAND_OPERATION,
  MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
  MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
} = require(
  "../../../domain/matchups/matchupScheduleCommandPolicy"
);
const {
  createFreeAgentDraftReadinessMissingScheduleBlocker,
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../../domain/leagues/socketInvalidation"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRows(rows) {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({ ...row })
    )
  );
}

function canonicalParticipantTeamIds(value) {
  if (!Array.isArray(value) || value.length < 2) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "At least two schedule participant identifiers are required."
    );
  }
  const ids = value.map(stableId).sort();
  if (new Set(ids).size !== ids.length) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Schedule participant identifiers must be unique."
    );
  }
  return Object.freeze(ids);
}

function requireSingle(rows, description) {
  if (rows.length > 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      `${description} is ambiguous.`
    );
  }
  return rows[0] || null;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safePositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function hasNoLease(row) {
  return (
    row.lease_owner === null &&
    row.lease_token === null &&
    row.lease_expires_at_ms === null
  );
}

function hasNoOpeningEvidence(row) {
  return (
    row.created_fad_id === null &&
    row.reminder_job_run_id === null &&
    row.deadline_job_run_id === null &&
    row.cards_opened_activity_id === null &&
    row.cards_opened_outbox_event_id === null
  );
}

function canonicalJson(value) {
  try {
    const parsed = JSON.parse(value);
    return serializeCanonicalJsonV1(parsed) ===
      value
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function jsonMatches(value, expected) {
  try {
    return (
      serializeCanonicalJsonV1(JSON.parse(value)) ===
      serializeCanonicalJsonV1(expected)
    );
  } catch {
    return false;
  }
}

function openingPublicationsAreCanonical(
  readiness,
  evidence
) {
  const cards = evidence?.cards;
  const notifications = evidence?.notifications;
  const publicationRows = evidence?.publicationRows;
  if (
    !Array.isArray(cards) ||
    !Array.isArray(notifications) ||
    !Array.isArray(publicationRows) ||
    !safePositiveInteger(
      evidence.fad_participating_team_count
    ) ||
    !safePositiveInteger(evidence.fad_version) ||
    evidence.fad_team_count !==
      evidence.fad_participating_team_count ||
    evidence.card_count !==
      evidence.fad_participating_team_count ||
    cards.length !== evidence.card_count ||
    evidence.notification_count !==
      evidence.fad_participating_team_count ||
    notifications.length !==
      evidence.notification_count ||
    evidence.legacy_outbox_count !== 0
  ) {
    return false;
  }

  const cardById = new Map();
  const cardTeamIds = new Set();
  for (const card of cards) {
    if (
      !UUID_PATTERN.test(card.card_id || "") ||
      !UUID_PATTERN.test(card.team_id || "") ||
      !safePositiveInteger(card.version) ||
      cardById.has(card.card_id) ||
      cardTeamIds.has(card.team_id)
    ) {
      return false;
    }
    cardById.set(card.card_id, card);
    cardTeamIds.add(card.team_id);
  }

  const notificationIds = new Set();
  const notificationTargets = new Set();
  const expectedPublications = [
    {
      eventId:
        readiness.cards_opened_outbox_event_id,
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: readiness.created_fad_id,
      version: evidence.fad_version,
      reasonCode: "cards_opened",
      related: createEmptySocketRelated({
        fadId: readiness.created_fad_id,
      }),
      audienceKind: "league",
      teamId: null,
      userId: null,
    },
    {
      eventId: null,
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId:
        readiness.cards_opened_activity_id,
      version: 1,
      reasonCode: "cards_opened",
      related: createEmptySocketRelated({
        fadId: readiness.created_fad_id,
      }),
      audienceKind: "league",
      teamId: null,
      userId: null,
    },
    ...cards.map((card) => ({
      eventId: null,
      eventType: "candidate_card.changed",
      aggregateType: "candidate_card",
      aggregateId: card.card_id,
      version: card.version,
      reasonCode: "card_changed",
      related: createEmptySocketRelated({
        fadId: readiness.created_fad_id,
        teamId: card.team_id,
        cardId: card.card_id,
      }),
      audienceKind: "team",
      teamId: card.team_id,
      userId: null,
    })),
  ];

  for (const notification of notifications) {
    let messageData;
    try {
      messageData = JSON.parse(
        notification.message_data_json
      );
    } catch {
      return false;
    }
    const card = cardById.get(messageData?.cardId);
    const notificationTarget =
      `${notification.user_id}\u0000` +
      `${messageData?.teamId}\u0000` +
      messageData?.cardId;
    if (
      !UUID_PATTERN.test(
        notification.notification_id || ""
      ) ||
      !UUID_PATTERN.test(notification.user_id || "") ||
      !safePositiveInteger(notification.version) ||
      notificationIds.has(
        notification.notification_id
      ) ||
      notificationTargets.has(notificationTarget) ||
      messageData?.leagueId !== readiness.league_id ||
      messageData?.seasonId !== readiness.season_id ||
      messageData?.fadId !== readiness.created_fad_id ||
      !card ||
      messageData?.teamId !== card.team_id
    ) {
      return false;
    }
    notificationIds.add(notification.notification_id);
    notificationTargets.add(notificationTarget);
    expectedPublications.push({
      eventId: null,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notification.notification_id,
      version: notification.version,
      reasonCode: "cards_opened",
      related: createEmptySocketRelated({
        fadId: readiness.created_fad_id,
        teamId: card.team_id,
        cardId: card.card_id,
      }),
      audienceKind: "user",
      teamId: null,
      userId: notification.user_id,
    });
  }

  const publicationsById = new Map();
  for (const row of publicationRows) {
    let publication = publicationsById.get(
      row.event_id
    );
    if (!publication) {
      publication = {
        eventId: row.event_id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payloadJson: row.payload_json,
        createdAtMs: row.created_at_ms,
        audiences: [],
      };
      publicationsById.set(row.event_id, publication);
    }
    if (row.audience_id !== null) {
      publication.audiences.push({
        kind: row.audience_kind,
        teamId: row.audience_team_id,
        userId: row.audience_user_id,
        createdAtMs: row.audience_created_at_ms,
      });
    }
  }
  if (
    publicationsById.size !==
    expectedPublications.length
  ) {
    return false;
  }

  const matchedPublicationIds = new Set();
  for (const expected of expectedPublications) {
    const matches = [...publicationsById.values()].filter(
      (publication) =>
        publication.eventType === expected.eventType &&
        publication.aggregateType ===
          expected.aggregateType &&
        publication.aggregateId === expected.aggregateId
    );
    if (
      matches.length !== 1 ||
      (expected.eventId !== null &&
        matches[0].eventId !== expected.eventId)
    ) {
      return false;
    }
    const publication = matches[0];
    if (
      matchedPublicationIds.has(publication.eventId) ||
      publication.createdAtMs !==
        readiness.terminal_at_ms ||
      !jsonMatches(
        publication.payloadJson,
        createSocketEventEnvelope({
          eventId: publication.eventId,
          type: expected.eventType,
          leagueId: readiness.league_id,
          resourceId: expected.aggregateId,
          version: expected.version,
          reasonCode: expected.reasonCode,
          occurredAt: readiness.terminal_at_ms,
          related: expected.related,
        })
      ) ||
      publication.audiences.length !== 1 ||
      publication.audiences[0].kind !==
        expected.audienceKind ||
      publication.audiences[0].teamId !==
        expected.teamId ||
      publication.audiences[0].userId !==
        expected.userId ||
      publication.audiences[0].createdAtMs !==
        readiness.terminal_at_ms
    ) {
      return false;
    }
    matchedPublicationIds.add(publication.eventId);
  }
  return (
    matchedPublicationIds.size ===
    publicationsById.size
  );
}

function canonicalReadinessBlockers(value) {
  try {
    const parsed = JSON.parse(value);
    const normalized =
      normalizeFreeAgentDraftReadinessInternalDiagnostics(
        parsed
      );
    return serializeCanonicalJsonV1(normalized) ===
      value
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function hasCanonicalLease(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !CONTROL_PATTERN.test(value)
  );
}

function readinessIdentityIsAligned(
  readiness,
  job,
  { leagueId, seasonId }
) {
  return Boolean(
    readiness &&
      job &&
      UUID_PATTERN.test(readiness.id || "") &&
      UUID_PATTERN.test(readiness.job_run_id || "") &&
      readiness.league_id === leagueId &&
      readiness.season_id === seasonId &&
      readiness.entry_draft_id === null &&
      readiness.setup_exemption_id === null &&
      readiness.readiness_occurrence_key ===
        `fad-readiness:${leagueId}:${seasonId}:${seasonId}` &&
      job.id === readiness.job_run_id &&
      job.league_id === leagueId &&
      job.season_id === seasonId &&
      job.job_type === "fad_readiness" &&
      job.occurrence_key ===
        readiness.readiness_occurrence_key &&
      job.scheduled_for_ms ===
        readiness.created_at_ms &&
      job.created_at_ms ===
        readiness.created_at_ms &&
      job.attempt_count ===
        readiness.attempt_count &&
      job.version === readiness.version &&
      job.updated_at_ms ===
        readiness.updated_at_ms &&
      safeTimestamp(readiness.created_at_ms) &&
      safeTimestamp(readiness.updated_at_ms) &&
      readiness.updated_at_ms >=
        readiness.created_at_ms &&
      safePositiveInteger(readiness.version)
  );
}

function terminalAttemptIsAligned(
  attempt,
  readiness,
  blockers,
  outcome,
  observedReadinessVersion
) {
  if (
    !attempt ||
    attempt.league_id !== readiness.league_id ||
    attempt.season_id !== readiness.season_id ||
    attempt.readiness_operation_id !==
      readiness.id ||
    attempt.job_run_id !==
      readiness.job_run_id ||
    attempt.attempt_number !==
      readiness.attempt_count ||
    attempt.observed_readiness_version !==
      observedReadinessVersion ||
    attempt.outcome !== outcome ||
    !safeTimestamp(attempt.observed_at_ms) ||
    attempt.recorded_at_ms !==
      readiness.terminal_at_ms ||
    attempt.recorded_at_ms <
      attempt.observed_at_ms ||
    attempt.version !== 1 ||
    !DIGEST_PATTERN.test(
      attempt.projection_sha256 || ""
    )
  ) {
    return false;
  }
  const projection = canonicalJson(
    attempt.projection_json
  );
  if (
    !projection ||
    hashCanonicalJsonV1(projection) !==
      attempt.projection_sha256 ||
    !Array.isArray(projection.blockers) ||
    projection.blockers.length !==
      blockers.length
  ) {
    return false;
  }
  return blockers.every((blocker, index) => {
    const projected = projection.blockers[index];
    return Boolean(
      projected &&
        projected.code === blocker.code &&
        projected.message === blocker.message &&
        projected.resourceId ===
          blocker.resourceId
    );
  });
}

function attemptHistoryIsCanonical(
  attempts,
  readiness,
  terminalOutcome,
  expectedLength
) {
  if (attempts.length !== expectedLength) {
    return false;
  }
  let priorObservedVersion = 0;
  let priorRecordedAtMs = 0;
  return attempts.every((attempt, index) => {
    const expectedNumber = index + 1;
    const outcome =
      expectedNumber === expectedLength &&
      terminalOutcome === "succeeded"
        ? "succeeded"
        : "blocked";
    const projection = canonicalJson(
      attempt.projection_json
    );
    const valid = Boolean(
      attempt.league_id ===
        readiness.league_id &&
        attempt.season_id ===
          readiness.season_id &&
        attempt.readiness_operation_id ===
          readiness.id &&
        attempt.job_run_id ===
          readiness.job_run_id &&
        attempt.attempt_number ===
          expectedNumber &&
        safePositiveInteger(
          attempt.observed_readiness_version
        ) &&
        attempt.observed_readiness_version >
          priorObservedVersion &&
        attempt.observed_readiness_version <
          readiness.version &&
        attempt.outcome === outcome &&
        safeTimestamp(attempt.observed_at_ms) &&
        safeTimestamp(attempt.recorded_at_ms) &&
        attempt.recorded_at_ms >=
          attempt.observed_at_ms &&
        attempt.recorded_at_ms >=
          priorRecordedAtMs &&
        attempt.version === 1 &&
        projection &&
        hashCanonicalJsonV1(projection) ===
          attempt.projection_sha256 &&
        Array.isArray(projection.blockers) &&
        (outcome === "blocked"
          ? projection.blockers.length >= 1
          : projection.blockers.length === 0)
    );
    if (valid) {
      priorObservedVersion =
        attempt.observed_readiness_version;
      priorRecordedAtMs =
        attempt.recorded_at_ms;
    }
    return valid;
  });
}

function initialPendingReadinessIsValid(
  readiness,
  job,
  attempts
) {
  return (
    readiness.status === "pending" &&
    job.status === "pending" &&
    readiness.attempt_count === 0 &&
    readiness.version === 1 &&
    hasNoLease(readiness) &&
    hasNoLease(job) &&
    readiness.blockers_json === "[]" &&
    hasNoOpeningEvidence(readiness) &&
    readiness.matchup_schedule_version_before ===
      null &&
    readiness.matchup_schedule_version_after ===
      null &&
    readiness.schedule_recovery_id === null &&
    readiness.started_at_ms === null &&
    readiness.next_retry_at_ms === null &&
    readiness.terminal_at_ms === null &&
    readiness.updated_at_ms ===
      readiness.created_at_ms &&
    job.started_at_ms === null &&
    job.completed_at_ms === null &&
    job.result_json === null &&
    job.last_error_code === null &&
    job.next_attempt_at_ms === null &&
    attempts.length === 0
  );
}

function runningReadinessIsValid(
  readiness,
  job,
  attempts
) {
  return (
    readiness.status === "running" &&
    job.status === "running" &&
    safePositiveInteger(
      readiness.attempt_count
    ) &&
    hasCanonicalLease(
      readiness.lease_owner,
      128
    ) &&
    hasCanonicalLease(
      readiness.lease_token,
      200
    ) &&
    readiness.lease_owner === job.lease_owner &&
    readiness.lease_token === job.lease_token &&
    readiness.lease_expires_at_ms ===
      job.lease_expires_at_ms &&
    safeTimestamp(
      readiness.lease_expires_at_ms
    ) &&
    readiness.lease_expires_at_ms >
      readiness.updated_at_ms &&
    readiness.blockers_json === "[]" &&
    hasNoOpeningEvidence(readiness) &&
    readiness.matchup_schedule_version_before ===
      null &&
    readiness.matchup_schedule_version_after ===
      null &&
    readiness.schedule_recovery_id === null &&
    safeTimestamp(readiness.started_at_ms) &&
    readiness.started_at_ms ===
      job.started_at_ms &&
    readiness.started_at_ms <=
      readiness.updated_at_ms &&
    readiness.next_retry_at_ms === null &&
    readiness.terminal_at_ms === null &&
    job.completed_at_ms === null &&
    job.result_json === null &&
    job.last_error_code === null &&
    job.next_attempt_at_ms === null &&
    attemptHistoryIsCanonical(
      attempts,
      readiness,
      null,
      readiness.attempt_count - 1
    )
  );
}

function blockedFailedReadinessIsValid(
  readiness,
  job,
  attempts,
  blockers
) {
  const latestAttempt = attempts.at(-1) || null;
  return (
    readiness.status === "blocked" &&
    job.status === "failed" &&
    safePositiveInteger(
      readiness.attempt_count
    ) &&
    Array.isArray(blockers) &&
    blockers.length >= 1 &&
    hasNoLease(readiness) &&
    hasNoLease(job) &&
    hasNoOpeningEvidence(readiness) &&
    readiness.matchup_schedule_version_before ===
      null &&
    readiness.matchup_schedule_version_after ===
      null &&
    readiness.schedule_recovery_id === null &&
    safeTimestamp(readiness.started_at_ms) &&
    readiness.started_at_ms ===
      job.started_at_ms &&
    safeTimestamp(readiness.terminal_at_ms) &&
    readiness.terminal_at_ms >=
      readiness.started_at_ms &&
    readiness.terminal_at_ms ===
      job.completed_at_ms &&
    safeTimestamp(readiness.next_retry_at_ms) &&
    readiness.next_retry_at_ms >
      readiness.terminal_at_ms &&
    readiness.next_retry_at_ms ===
      job.next_attempt_at_ms &&
    readiness.updated_at_ms ===
      readiness.terminal_at_ms &&
    job.result_json === null &&
    job.last_error_code ===
      "FAD_READINESS_BLOCKED" &&
    attemptHistoryIsCanonical(
      attempts,
      readiness,
      "blocked",
      readiness.attempt_count
    ) &&
    terminalAttemptIsAligned(
      latestAttempt,
      readiness,
      blockers,
      "blocked",
      readiness.version - 1
    )
  );
}

function retryReceiptIsAligned(
  receipt,
  readiness,
  attempts
) {
  const latestAttempt = attempts.at(-1) || null;
  if (
    !receipt ||
    receipt.league_id !== readiness.league_id ||
    receipt.season_id !== readiness.season_id ||
    receipt.readiness_operation_id !==
      readiness.id ||
    receipt.job_run_id !==
      readiness.job_run_id ||
    receipt.occurrence_key !==
      readiness.readiness_occurrence_key ||
    receipt.accepted_from_version !==
      readiness.version - 1 ||
    receipt.resulting_readiness_version !==
      readiness.version ||
    receipt.retry_attempt_number !==
      readiness.attempt_count + 1 ||
    receipt.accepted_at_ms !==
      readiness.updated_at_ms ||
    receipt.response_http_status !== 202 ||
    receipt.version !== 1 ||
    receipt.request_operation !==
      "free_agent_draft.readiness.retry.v1" ||
    receipt.request_status !== "completed" ||
    receipt.request_result_type !==
      "free_agent_draft_readiness_retry_receipt" ||
    receipt.request_result_id !== receipt.id ||
    receipt.request_completed_at_ms !==
      receipt.accepted_at_ms ||
    !DIGEST_PATTERN.test(
      receipt.response_sha256 || ""
    )
  ) {
    return false;
  }
  const response = canonicalJson(
    receipt.response_json
  );
  if (
    !response ||
    hashCanonicalJsonV1(response) !==
      receipt.response_sha256
  ) {
    return false;
  }
  const blockers = canonicalReadinessBlockers(
    readiness.blockers_json
  );
  return (
    Array.isArray(blockers) &&
    blockers.length >= 1 &&
    attemptHistoryIsCanonical(
      attempts,
      readiness,
      "blocked",
      readiness.attempt_count
    ) &&
    terminalAttemptIsAligned(
      latestAttempt,
      readiness,
      blockers,
      "blocked",
      receipt.accepted_from_version - 1
    )
  );
}

function blockedPendingReadinessIsValid(
  readiness,
  job,
  attempts,
  receipt
) {
  return (
    readiness.status === "blocked" &&
    job.status === "pending" &&
    safePositiveInteger(
      readiness.attempt_count
    ) &&
    hasNoLease(readiness) &&
    hasNoLease(job) &&
    hasNoOpeningEvidence(readiness) &&
    readiness.matchup_schedule_version_before ===
      null &&
    readiness.matchup_schedule_version_after ===
      null &&
    readiness.schedule_recovery_id === null &&
    safeTimestamp(readiness.started_at_ms) &&
    safeTimestamp(readiness.terminal_at_ms) &&
    readiness.terminal_at_ms >=
      readiness.started_at_ms &&
    safeTimestamp(readiness.next_retry_at_ms) &&
    readiness.next_retry_at_ms >
      readiness.terminal_at_ms &&
    readiness.next_retry_at_ms ===
      job.next_attempt_at_ms &&
    readiness.updated_at_ms ===
      readiness.next_retry_at_ms &&
    job.started_at_ms === null &&
    job.completed_at_ms === null &&
    job.result_json === null &&
    job.last_error_code === null &&
    retryReceiptIsAligned(
      receipt,
      readiness,
      attempts
    )
  );
}

function succeededReadinessIsValid(
  readiness,
  job,
  attempts,
  evidence
) {
  const projectionBlockers = [];
  const latestAttempt = attempts.at(-1) || null;
  const scheduleVersionBefore =
    readiness.matchup_schedule_version_before;
  const scheduleVersionAfter =
    readiness.matchup_schedule_version_after;
  const scheduleEvidenceValid =
    safePositiveInteger(scheduleVersionBefore) &&
    safePositiveInteger(scheduleVersionAfter) &&
    scheduleVersionAfter >= scheduleVersionBefore &&
    (scheduleVersionAfter === scheduleVersionBefore
      ? readiness.schedule_recovery_id === null &&
        evidence?.recovery_count === 0
      : UUID_PATTERN.test(
          readiness.schedule_recovery_id || ""
        ) && evidence?.recovery_count === 1);
  return (
    readiness.status === "succeeded" &&
    job.status === "succeeded" &&
    safePositiveInteger(
      readiness.attempt_count
    ) &&
    hasNoLease(readiness) &&
    hasNoLease(job) &&
    readiness.blockers_json === "[]" &&
    UUID_PATTERN.test(
      readiness.created_fad_id || ""
    ) &&
    UUID_PATTERN.test(
      readiness.reminder_job_run_id || ""
    ) &&
    UUID_PATTERN.test(
      readiness.deadline_job_run_id || ""
    ) &&
    UUID_PATTERN.test(
      readiness.cards_opened_activity_id || ""
    ) &&
    UUID_PATTERN.test(
      readiness.cards_opened_outbox_event_id ||
        ""
    ) &&
    safeTimestamp(readiness.started_at_ms) &&
    readiness.started_at_ms ===
      job.started_at_ms &&
    safeTimestamp(readiness.terminal_at_ms) &&
    readiness.terminal_at_ms >=
      readiness.started_at_ms &&
    readiness.terminal_at_ms ===
      job.completed_at_ms &&
    readiness.updated_at_ms ===
      readiness.terminal_at_ms &&
    readiness.next_retry_at_ms === null &&
    canonicalJson(job.result_json) !== null &&
    job.last_error_code === null &&
    job.next_attempt_at_ms === null &&
    scheduleEvidenceValid &&
    evidence?.fad_count === 1 &&
    evidence?.reminder_count === 1 &&
    evidence?.deadline_count === 1 &&
    evidence?.activity_count === 1 &&
    openingPublicationsAreCanonical(
      readiness,
      evidence
    ) &&
    attemptHistoryIsCanonical(
      attempts,
      readiness,
      "succeeded",
      readiness.attempt_count
    ) &&
    terminalAttemptIsAligned(
      latestAttempt,
      readiness,
      projectionBlockers,
      "succeeded",
      readiness.version - 1
    )
  );
}

function hasExactMissingScheduleBlocker(
  blockers,
  seasonId
) {
  const expected = serializeCanonicalJsonV1(
    createFreeAgentDraftReadinessMissingScheduleBlocker({
      seasonId,
    })
  );
  return blockers.some(
    (blocker) =>
      serializeCanonicalJsonV1(blocker) === expected
  );
}

function mapIdempotency(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    actorUserId: row.actor_user_id,
    operation: row.operation,
    clientKey: row.client_key,
    requestHash: row.request_hash,
    status: row.status,
    resultType: row.result_type,
    resultId: row.result_id,
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
    expiresAtMs: row.expires_at_ms,
  });
}

function mapCommandResult(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    action: row.action,
    idempotencyRequestId:
      row.idempotency_request_id,
    idempotencyOperation:
      row.idempotency_operation,
    requestSha256: row.request_sha256,
    matchupOperationId:
      row.matchup_operation_id,
    actorUserId: row.actor_user_id,
    actorMembershipId:
      row.actor_membership_id,
    actorAuthority: row.actor_authority,
    oldScheduleOperationId:
      row.old_schedule_operation_id,
    oldScheduleVersion:
      row.old_schedule_version,
    newScheduleOperationId:
      row.new_schedule_operation_id,
    newScheduleVersion:
      row.new_schedule_version,
    seasonVersionBefore:
      row.season_version_before,
    seasonVersionAfter:
      row.season_version_after,
    weekOneMatchupWeekId:
      row.week_one_matchup_week_id,
    weekVersionBefore:
      row.week_version_before,
    weekVersionAfter:
      row.week_version_after,
    previousFirstWeekStartsAtMs:
      row.previous_first_week_starts_at_ms,
    firstWeekStartsAtMs:
      row.first_week_starts_at_ms,
    lastWeekEndsAtMs:
      row.last_week_ends_at_ms,
    nhlRegularSeasonStartsAtMs:
      row.nhl_regular_season_starts_at_ms,
    nhlRegularSeasonEndsAtMs:
      row.nhl_regular_season_ends_at_ms,
    fantasyPlayoffsStartAtMs:
      row.fantasy_playoffs_start_at_ms,
    fantasyPlayoffsEndAtMs:
      row.fantasy_playoffs_end_at_ms,
    calendarPersisted: row.calendar_persisted,
    participantCount: row.participant_count,
    weekCount: row.week_count,
    matchupCount: row.matchup_count,
    byeCount: row.bye_count,
    shiftedWeekCount:
      row.shifted_week_count,
    replacedJobOccurrenceCount:
      row.replaced_job_occurrence_count,
    responseHttpStatus:
      row.response_http_status,
    responseCode: row.response_code,
    resultSchemaVersion:
      row.result_schema_version,
    createdAtMs: row.created_at_ms,
    version: row.version,
  });
}

function mapShiftGeneration(row) {
  if (!row) return null;
  return Object.freeze({
    leagueId: row.league_id,
    seasonId: row.season_id,
    scheduleVersion: row.schedule_version,
    scheduleOperationId:
      row.schedule_operation_id,
    weekOneMatchupWeekId:
      row.week_one_matchup_week_id,
    weekOneStartsAtMs:
      row.week_one_starts_at_ms,
    status: row.status,
    supersededAtMs: row.superseded_at_ms,
    version: row.version,
  });
}

function mapShiftMatchup(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    weekId: row.matchup_week_id,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    status: row.status,
    version: row.version,
  });
}

function mapShiftBye(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    weekId: row.matchup_week_id,
    teamId: row.team_id,
  });
}

function mapShiftJob(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    weekId: row.owning_matchup_week_id,
    jobType: row.job_type,
    occurrenceKey: row.occurrence_key,
    scheduledForMs: row.scheduled_for_ms,
    status: row.status,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    resultJson: row.result_json,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    nextAttemptAtMs: row.next_attempt_at_ms,
    bindingId: row.binding_id,
    bindingJobType: row.binding_job_type,
    bindingScheduleOperationId:
      row.binding_schedule_operation_id,
    bindingScheduleVersion:
      row.binding_schedule_version,
    bindingOwningMatchupWeekId:
      row.binding_owning_matchup_week_id,
    bindingOwningMatchupId:
      row.binding_owning_matchup_id,
    bindingCreatedAtMs:
      row.binding_created_at_ms,
    bindingVersion: row.binding_version,
  });
}

function createSqliteMatchupScheduleRepository({
  database,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteMatchupScheduleRepository requires a database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "matchup schedule beforeCommit must be a function"
    );
  }

  const contextStatement = database.prepare(`
    SELECT
      leagues.id AS league_id,
      leagues.timezone,
      leagues.commissioner_membership_id,
      seasons.id AS season_id,
      seasons.status AS season_status,
      seasons.version AS season_version,
      seasons.nhl_season_key,
      seasons.regular_season_starts_at_ms,
      seasons.regular_season_ends_at_ms,
      seasons.fantasy_playoffs_start_at_ms,
      seasons.fantasy_playoffs_end_at_ms,
      league_settings.scoring_rule_version,
      league_memberships.user_id
        AS commissioner_user_id
    FROM seasons
    JOIN leagues
      ON leagues.id = seasons.league_id
    JOIN league_settings
      ON league_settings.league_id = leagues.id
    LEFT JOIN league_memberships
      ON league_memberships.id =
          leagues.commissioner_membership_id
     AND league_memberships.league_id =
          leagues.id
     AND league_memberships.status = 'active'
    WHERE seasons.league_id = @leagueId
      AND seasons.id = @seasonId
    LIMIT 2
  `);
  const teamsStatement = database.prepare(`
    SELECT
      id,
      name,
      primary_colour,
      secondary_colour,
      logo_reference,
      version
    FROM teams
    WHERE league_id = @leagueId
      AND status = 'active'
    ORDER BY id
  `);
  const existingScheduleStatement =
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
    `);
  const existingGenerationStatement =
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM season_matchup_schedule_generations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
    `);
  const fadCountStatement = database.prepare(`
    SELECT COUNT(*) AS count
    FROM free_agent_drafts
    WHERE league_id = @leagueId
      AND season_id = @seasonId
  `);
  const currentGenerationsStatement =
    database.prepare(`
      SELECT *
      FROM season_matchup_schedule_generations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND status = 'current'
      ORDER BY schedule_version, schedule_operation_id
    `);
  const currentGenerationJobsStatement =
    database.prepare(`
      SELECT
        job_runs.*,
        matchup_schedule_job_bindings.id
          AS binding_id,
        matchup_schedule_job_bindings.job_type
          AS binding_job_type,
        matchup_schedule_job_bindings.schedule_operation_id
          AS binding_schedule_operation_id,
        matchup_schedule_job_bindings.schedule_version
          AS binding_schedule_version,
        matchup_schedule_job_bindings.owning_matchup_week_id,
        matchup_schedule_job_bindings.owning_matchup_week_id
          AS binding_owning_matchup_week_id,
        matchup_schedule_job_bindings.owning_matchup_id
          AS binding_owning_matchup_id,
        matchup_schedule_job_bindings.created_at_ms
          AS binding_created_at_ms,
        matchup_schedule_job_bindings.version
          AS binding_version
      FROM matchup_schedule_job_bindings
      JOIN job_runs
        ON job_runs.league_id =
            matchup_schedule_job_bindings.league_id
       AND job_runs.id =
            matchup_schedule_job_bindings.job_run_id
      WHERE matchup_schedule_job_bindings.league_id =
          @leagueId
        AND matchup_schedule_job_bindings.season_id =
          @seasonId
        AND matchup_schedule_job_bindings.schedule_operation_id =
          @scheduleOperationId
        AND matchup_schedule_job_bindings.schedule_version =
          @scheduleVersion
      ORDER BY
        matchup_schedule_job_bindings.owning_matchup_week_id,
        job_runs.scheduled_for_ms,
        job_runs.job_type,
        job_runs.id
    `);
  const unboundMatchupJobCountStatement =
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM job_runs
      WHERE job_runs.league_id = @leagueId
        AND job_runs.season_id = @seasonId
        AND job_runs.job_type LIKE 'matchup:%'
        AND NOT EXISTS (
          SELECT 1
          FROM matchup_schedule_job_bindings
          WHERE matchup_schedule_job_bindings.league_id =
              job_runs.league_id
            AND matchup_schedule_job_bindings.job_run_id =
              job_runs.id
        )
    `);
  const idempotencyByScopeStatement =
    database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = @operation
        AND client_key = @clientKey
      LIMIT 2
    `);
  const commandResultByIdStatement =
    database.prepare(`
      SELECT *
      FROM matchup_schedule_command_results
      WHERE league_id = @leagueId
        AND id = @resultId
      LIMIT 2
    `);
  const correctiveReadinessStatement =
    database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
  const correctiveReadinessJobStatement =
    database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND id = @jobRunId
      LIMIT 2
    `);
  const correctiveReadinessJobInventoryStatement =
    database.prepare(`
      SELECT id
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = 'fad_readiness'
      ORDER BY id
    `);
  const correctiveReadinessAttemptsStatement =
    database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_attempts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND readiness_operation_id =
          @readinessOperationId
      ORDER BY attempt_number
    `);
  const correctiveRetryReceiptStatement =
    database.prepare(`
      SELECT
        receipt.*,
        request.operation AS request_operation,
        request.status AS request_status,
        request.result_type AS request_result_type,
        request.result_id AS request_result_id,
        request.completed_at_ms
          AS request_completed_at_ms
      FROM free_agent_draft_readiness_retry_receipts
        AS receipt
      JOIN idempotency_requests AS request
        ON request.league_id = receipt.league_id
       AND request.id =
         receipt.idempotency_request_id
      WHERE receipt.league_id = @leagueId
        AND receipt.season_id = @seasonId
        AND receipt.readiness_operation_id =
          @readinessOperationId
        AND receipt.resulting_readiness_version =
          @readinessVersion
      LIMIT 2
    `);
  const correctiveSucceededEvidenceStatement =
    database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM free_agent_drafts AS fad
          WHERE fad.league_id = @leagueId
            AND fad.season_id = @seasonId
            AND fad.id = @fadId
            AND fad.readiness_operation_id =
              @readinessOperationId
            AND fad.readiness_occurrence_key =
              @occurrenceKey
            AND fad.setup_path =
              'no_draft_inaugural'
            AND fad.entry_draft_id IS NULL
            AND fad.setup_exemption_id IS NULL
            AND fad.schedule_recovery_id IS
              @scheduleRecoveryId
            AND fad.opened_at_ms = @terminalAtMs
            AND fad.status = 'cards_open'
        ) AS fad_count,
        (
          SELECT fad.participating_team_count
          FROM free_agent_drafts AS fad
          WHERE fad.league_id = @leagueId
            AND fad.season_id = @seasonId
            AND fad.id = @fadId
        ) AS fad_participating_team_count,
        (
          SELECT fad.version
          FROM free_agent_drafts AS fad
          WHERE fad.league_id = @leagueId
            AND fad.season_id = @seasonId
            AND fad.id = @fadId
        ) AS fad_version,
        (
          SELECT COUNT(*)
          FROM job_runs AS reminder
          WHERE reminder.league_id = @leagueId
            AND reminder.season_id = @seasonId
            AND reminder.id = @reminderJobRunId
            AND reminder.job_type =
              'fad_deadline_reminder'
        ) AS reminder_count,
        (
          SELECT COUNT(*)
          FROM job_runs AS deadline
          WHERE deadline.league_id = @leagueId
            AND deadline.season_id = @seasonId
            AND deadline.id = @deadlineJobRunId
            AND deadline.job_type = 'fad_deadline'
        ) AS deadline_count,
        (
          SELECT COUNT(*)
          FROM league_activity AS activity
          WHERE activity.league_id = @leagueId
            AND activity.season_id = @seasonId
            AND activity.id = @activityId
            AND activity.event_type =
              'free_agent_draft_started'
            AND activity.actor_user_id IS NULL
            AND activity.actor_authority = 'system'
            AND activity.related_type =
              'free_agent_draft'
            AND activity.related_id = @fadId
            AND activity.occurred_at_ms =
              @terminalAtMs
        ) AS activity_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_teams AS participant
          WHERE participant.league_id = @leagueId
            AND participant.season_id = @seasonId
            AND participant.fad_id = @fadId
        ) AS fad_team_count,
        (
          SELECT COUNT(*)
          FROM candidate_cards AS card
          WHERE card.league_id = @leagueId
            AND card.season_id = @seasonId
            AND card.fad_id = @fadId
        ) AS card_count,
        (
          SELECT COUNT(*)
          FROM notifications AS notification
          WHERE notification.league_id = @leagueId
            AND notification.event_type =
              'fad_cards_opened'
            AND notification.related_feature =
              'free_agent_draft'
            AND notification.related_record_id = @fadId
            AND notification.created_at_ms =
              @terminalAtMs
        ) AS notification_count,
        (
          SELECT COUNT(*)
          FROM outbox_events AS legacy_event
          WHERE legacy_event.league_id = @leagueId
            AND legacy_event.event_type =
              'fad_cards_opened'
            AND legacy_event.aggregate_type =
              'free_agent_draft'
            AND legacy_event.aggregate_id = @fadId
            AND legacy_event.created_at_ms =
              @terminalAtMs
        ) AS legacy_outbox_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_schedule_recoveries
            AS recovery
          WHERE recovery.league_id = @leagueId
            AND recovery.season_id = @seasonId
            AND recovery.id = @scheduleRecoveryId
            AND recovery.fad_id = @fadId
        ) AS recovery_count
    `);
  const correctiveSucceededCardsStatement =
    database.prepare(`
      SELECT
        card.id AS card_id,
        card.team_id,
        card.version
      FROM candidate_cards AS card
      JOIN free_agent_draft_teams AS participant
        ON participant.league_id = card.league_id
       AND participant.season_id = card.season_id
       AND participant.fad_id = card.fad_id
       AND participant.team_id = card.team_id
      WHERE card.league_id = @leagueId
        AND card.season_id = @seasonId
        AND card.fad_id = @fadId
      ORDER BY card.id
    `);
  const correctiveSucceededNotificationsStatement =
    database.prepare(`
      SELECT
        notification.id AS notification_id,
        notification.user_id,
        notification.message_data_json,
        notification.version
      FROM notifications AS notification
      WHERE notification.league_id = @leagueId
        AND notification.event_type =
          'fad_cards_opened'
        AND notification.related_feature =
          'free_agent_draft'
        AND notification.related_record_id = @fadId
        AND notification.created_at_ms =
          @terminalAtMs
      ORDER BY notification.id
    `);
  const correctiveSucceededPublicationsStatement =
    database.prepare(`
      SELECT
        event.id AS event_id,
        event.event_type,
        event.aggregate_type,
        event.aggregate_id,
        event.payload_json,
        event.created_at_ms,
        audience.id AS audience_id,
        audience.audience_kind,
        audience.team_id AS audience_team_id,
        audience.user_id AS audience_user_id,
        audience.created_at_ms AS audience_created_at_ms
      FROM outbox_events AS event
      LEFT JOIN outbox_event_audiences AS audience
        ON audience.league_id = event.league_id
       AND audience.outbox_event_id = event.id
      WHERE event.league_id = @leagueId
        AND (
          event.id = @outboxEventId
          OR (
            event.created_at_ms = @terminalAtMs
            AND (
              (
                event.event_type IN (
                  'free_agent_draft.changed',
                  'fad_cards_opened'
                )
                AND event.aggregate_id = @fadId
              )
              OR (
                event.event_type = 'activity.created'
                AND event.aggregate_id = @activityId
              )
              OR (
                event.event_type =
                  'candidate_card.changed'
                AND EXISTS (
                  SELECT 1
                  FROM candidate_cards AS card
                  WHERE card.league_id = @leagueId
                    AND card.season_id = @seasonId
                    AND card.fad_id = @fadId
                    AND card.id = event.aggregate_id
                )
              )
              OR (
                event.event_type =
                  'notification.created'
                AND EXISTS (
                  SELECT 1
                  FROM notifications AS notification
                  WHERE notification.league_id =
                    @leagueId
                    AND notification.event_type =
                      'fad_cards_opened'
                    AND notification.related_feature =
                      'free_agent_draft'
                    AND notification.related_record_id =
                      @fadId
                    AND notification.created_at_ms =
                      @terminalAtMs
                    AND notification.id =
                      event.aggregate_id
                )
              )
            )
          )
        )
      ORDER BY event.id, audience.id
    `);
  const insertCorrectiveRequeue =
    database.prepare(`
      INSERT INTO free_agent_draft_readiness_corrective_requeues (
        id,
        league_id,
        season_id,
        readiness_operation_id,
        readiness_attempt_id,
        job_run_id,
        occurrence_key,
        correction_kind,
        matchup_schedule_command_result_id,
        schedule_operation_id,
        schedule_version,
        attempt_count,
        readiness_version_before,
        readiness_version_after,
        job_version_before,
        job_version_after,
        blockers_json,
        blocked_at_ms,
        previous_next_retry_at_ms,
        requeued_at_ms,
        version
      ) VALUES (
        @correctiveRequeueId,
        @leagueId,
        @seasonId,
        @readinessOperationId,
        @readinessAttemptId,
        @jobRunId,
        @occurrenceKey,
        'matchup_schedule_created',
        @commandResultId,
        @operationId,
        1,
        @attemptCount,
        @readinessVersionBefore,
        @readinessVersionAfter,
        @jobVersionBefore,
        @jobVersionAfter,
        @blockersJson,
        @blockedAtMs,
        @previousNextRetryAtMs,
        @nowMs,
        1
      )
    `);
  const resetCorrectiveReadinessJob =
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
          next_attempt_at_ms = @nowMs,
          updated_at_ms = @nowMs,
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
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND started_at_ms = @startedAtMs
        AND completed_at_ms = @blockedAtMs
        AND result_json IS NULL
        AND last_error_code =
          'FAD_READINESS_BLOCKED'
        AND next_attempt_at_ms =
          @previousNextRetryAtMs
        AND updated_at_ms = @blockedAtMs
        AND version = @jobVersionBefore
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_corrective_requeues
            AS correction
          WHERE correction.league_id = @leagueId
            AND correction.id =
              @correctiveRequeueId
            AND correction.readiness_operation_id =
              @readinessOperationId
            AND correction.readiness_attempt_id =
              @readinessAttemptId
            AND correction.job_run_id = job_runs.id
            AND correction.occurrence_key =
              job_runs.occurrence_key
            AND correction.matchup_schedule_command_result_id =
              @commandResultId
            AND correction.schedule_operation_id =
              @operationId
            AND correction.schedule_version = 1
            AND correction.attempt_count =
              job_runs.attempt_count
            AND correction.job_version_before =
              job_runs.version
            AND correction.job_version_after =
              job_runs.version + 1
            AND correction.requeued_at_ms = @nowMs
        )
    `);
  const advanceCorrectiveReadiness =
    database.prepare(`
      UPDATE free_agent_draft_readiness_operations
      SET next_retry_at_ms = @nowMs,
          updated_at_ms = @nowMs,
          version = version + 1
      WHERE id = @readinessOperationId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND readiness_occurrence_key =
          @occurrenceKey
        AND trigger_kind = 'no_draft_inaugural'
        AND entry_draft_id IS NULL
        AND setup_exemption_id IS NULL
        AND job_run_id = @jobRunId
        AND status = 'blocked'
        AND attempt_count = @attemptCount
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND blockers_json = @blockersJson
        AND matchup_schedule_version_before IS NULL
        AND matchup_schedule_version_after IS NULL
        AND schedule_recovery_id IS NULL
        AND created_fad_id IS NULL
        AND reminder_job_run_id IS NULL
        AND deadline_job_run_id IS NULL
        AND cards_opened_activity_id IS NULL
        AND cards_opened_outbox_event_id IS NULL
        AND started_at_ms = @startedAtMs
        AND next_retry_at_ms =
          @previousNextRetryAtMs
        AND terminal_at_ms = @blockedAtMs
        AND created_at_ms = @scheduledForMs
        AND updated_at_ms = @blockedAtMs
        AND version = @readinessVersionBefore
        AND EXISTS (
          SELECT 1
          FROM free_agent_draft_readiness_corrective_requeues
            AS correction
          WHERE correction.league_id = @leagueId
            AND correction.id =
              @correctiveRequeueId
            AND correction.readiness_operation_id =
              free_agent_draft_readiness_operations.id
            AND correction.readiness_attempt_id =
              @readinessAttemptId
            AND correction.job_run_id = @jobRunId
            AND correction.occurrence_key =
              free_agent_draft_readiness_operations
                .readiness_occurrence_key
            AND correction.matchup_schedule_command_result_id =
              @commandResultId
            AND correction.schedule_operation_id =
              @operationId
            AND correction.schedule_version = 1
            AND correction.attempt_count =
              free_agent_draft_readiness_operations
                .attempt_count
            AND correction.readiness_version_before =
              free_agent_draft_readiness_operations
                .version
            AND correction.readiness_version_after =
              free_agent_draft_readiness_operations
                .version + 1
            AND correction.requeued_at_ms = @nowMs
        )
        AND EXISTS (
          SELECT 1
          FROM job_runs
          WHERE job_runs.league_id = @leagueId
            AND job_runs.season_id = @seasonId
            AND job_runs.id = @jobRunId
            AND job_runs.job_type = 'fad_readiness'
            AND job_runs.occurrence_key =
              @occurrenceKey
            AND job_runs.scheduled_for_ms =
              @scheduledForMs
            AND job_runs.status = 'pending'
            AND job_runs.attempt_count =
              @attemptCount
            AND job_runs.lease_owner IS NULL
            AND job_runs.lease_token IS NULL
            AND job_runs.lease_expires_at_ms IS NULL
            AND job_runs.started_at_ms IS NULL
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms =
              @nowMs
            AND job_runs.created_at_ms =
              @scheduledForMs
            AND job_runs.updated_at_ms = @nowMs
            AND job_runs.version =
              @jobVersionAfter
        )
    `);
  const insertIdempotency =
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
        @idempotencyRequestId,
        @leagueId,
        @actorUserId,
        @idempotencyOperation,
        @idempotencyKey,
        @requestHash,
        'started',
        NULL,
        NULL,
        @nowMs,
        NULL,
        @idempotencyExpiresAtMs
      )
    `);
  const updateSeason = database.prepare(`
    UPDATE seasons
    SET
      regular_season_starts_at_ms =
        CASE
          WHEN @calendarPersisted = 1
            THEN @nhlRegularSeasonStartsAtMs
          ELSE regular_season_starts_at_ms
        END,
      regular_season_ends_at_ms =
        CASE
          WHEN @calendarPersisted = 1
            THEN @nhlRegularSeasonEndsAtMs
          ELSE regular_season_ends_at_ms
        END,
      fantasy_playoffs_start_at_ms =
        CASE
          WHEN @calendarPersisted = 1
            THEN @fantasyPlayoffsStartAtMs
          ELSE fantasy_playoffs_start_at_ms
        END,
      fantasy_playoffs_end_at_ms =
        CASE
          WHEN @calendarPersisted = 1
            THEN @fantasyPlayoffsEndAtMs
          ELSE fantasy_playoffs_end_at_ms
        END,
      updated_at_ms = @nowMs,
      version = version + 1
    WHERE league_id = @leagueId
      AND id = @seasonId
      AND version = @seasonVersionBefore
      AND status IN ('planned', 'active')
      AND NOT EXISTS (
        SELECT 1
        FROM matchup_weeks
        WHERE matchup_weeks.league_id =
            seasons.league_id
          AND matchup_weeks.season_id =
            seasons.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM season_matchup_schedule_generations
        WHERE season_matchup_schedule_generations
            .league_id = seasons.league_id
          AND season_matchup_schedule_generations
            .season_id = seasons.id
      )
      AND (
        (
          @calendarPersisted = 1
          AND regular_season_starts_at_ms IS NULL
          AND regular_season_ends_at_ms IS NULL
          AND fantasy_playoffs_start_at_ms IS NULL
          AND fantasy_playoffs_end_at_ms IS NULL
        )
        OR (
          @calendarPersisted = 0
          AND regular_season_starts_at_ms =
            @nhlRegularSeasonStartsAtMs
          AND regular_season_ends_at_ms =
            @nhlRegularSeasonEndsAtMs
          AND fantasy_playoffs_start_at_ms =
            @fantasyPlayoffsStartAtMs
          AND fantasy_playoffs_end_at_ms =
            @fantasyPlayoffsEndAtMs
        )
      )
  `);
  const insertWeek = database.prepare(`
    INSERT INTO matchup_weeks (
      id,
      league_id,
      season_id,
      week_key,
      sequence,
      starts_at_ms,
      baseline_at_ms,
      locks_at_ms,
      ends_at_ms,
      rolls_over_at_ms,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @weekKey,
      @sequence,
      @startsAtMs,
      @baselineAtMs,
      @locksAtMs,
      @endsAtMs,
      @rollsOverAtMs,
      'scheduled',
      @nowMs,
      @nowMs,
      1
    )
  `);
  const insertMatchup = database.prepare(`
    INSERT INTO matchups (
      id,
      league_id,
      season_id,
      matchup_week_id,
      home_team_id,
      away_team_id,
      home_team_name,
      away_team_name,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @weekId,
      @homeTeamId,
      @awayTeamId,
      @homeTeamName,
      @awayTeamName,
      'scheduled',
      @nowMs,
      @nowMs,
      1
    )
  `);
  const insertBye = database.prepare(`
    INSERT INTO matchup_byes (
      id,
      league_id,
      season_id,
      matchup_week_id,
      team_id,
      team_display_name,
      created_at_ms
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @weekId,
      @teamId,
      @teamDisplayName,
      @nowMs
    )
  `);
  const insertOperation = database.prepare(`
    INSERT INTO matchup_operations (
      id,
      league_id,
      season_id,
      matchup_week_id,
      matchup_id,
      actor_user_id,
      operation_type,
      status,
      reason,
      metadata_json,
      started_at_ms,
      completed_at_ms
    ) VALUES (
      @operationId,
      @leagueId,
      @seasonId,
      NULL,
      NULL,
      @actorUserId,
      'schedule_generate',
      'succeeded',
      NULL,
      @metadataJson,
      @nowMs,
      @nowMs
    )
  `);
  const insertScheduleGeneration =
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      ) VALUES (
        @leagueId,
        @seasonId,
        1,
        @operationId,
        @firstWeekId,
        @firstWeekStartsAtMs,
        'current',
        @nowMs,
        NULL,
        1
      )
    `);
  const updateSeasonForWeekOneShift =
    database.prepare(`
      UPDATE seasons
      SET
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND version = @seasonVersionBefore
        AND status IN ('planned', 'active')
        AND regular_season_starts_at_ms =
          @nhlRegularSeasonStartsAtMs
        AND regular_season_ends_at_ms =
          @nhlRegularSeasonEndsAtMs
        AND fantasy_playoffs_start_at_ms =
          @fantasyPlayoffsStartAtMs
        AND fantasy_playoffs_end_at_ms =
          @fantasyPlayoffsEndAtMs
        AND NOT EXISTS (
          SELECT 1
          FROM free_agent_drafts
          WHERE free_agent_drafts.league_id =
              seasons.league_id
            AND free_agent_drafts.season_id =
              seasons.id
        )
    `);
  const updateWeekForWeekOneShift =
    database.prepare(`
      UPDATE matchup_weeks
      SET
        starts_at_ms = @startsAtMs,
        baseline_at_ms = @baselineAtMs,
        locks_at_ms = @locksAtMs,
        ends_at_ms = @endsAtMs,
        rolls_over_at_ms = @rollsOverAtMs,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND week_key = @weekKey
        AND sequence = @sequence
        AND starts_at_ms = @previousStartsAtMs
        AND baseline_at_ms = @previousBaselineAtMs
        AND locks_at_ms = @previousLocksAtMs
        AND ends_at_ms = @previousEndsAtMs
        AND rolls_over_at_ms =
          @previousRollsOverAtMs
        AND status = 'scheduled'
        AND version = @expectedVersion
    `);
  const skipReplacedJobOccurrence =
    database.prepare(`
      UPDATE job_runs
      SET
        status = 'skipped',
        next_attempt_at_ms = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @replacedJobRunId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = @jobType
        AND occurrence_key =
          @replacedOccurrenceKey
        AND scheduled_for_ms =
          @previousScheduledForMs
        AND status = 'pending'
        AND attempt_count = 0
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND started_at_ms IS NULL
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms =
          scheduled_for_ms
        AND updated_at_ms = created_at_ms
        AND version = @replacedJobVersion
        AND EXISTS (
          SELECT 1
          FROM matchup_schedule_job_bindings
          WHERE matchup_schedule_job_bindings.league_id =
              job_runs.league_id
            AND matchup_schedule_job_bindings.season_id =
              job_runs.season_id
            AND matchup_schedule_job_bindings.job_run_id =
              job_runs.id
            AND matchup_schedule_job_bindings.job_type =
              job_runs.job_type
            AND matchup_schedule_job_bindings.schedule_operation_id =
              @oldScheduleOperationId
            AND matchup_schedule_job_bindings.schedule_version =
              @oldScheduleVersion
            AND matchup_schedule_job_bindings.owning_matchup_week_id =
              @weekId
            AND matchup_schedule_job_bindings.owning_matchup_id
              IS NULL
            AND matchup_schedule_job_bindings.created_at_ms =
              job_runs.created_at_ms
            AND matchup_schedule_job_bindings.version = 1
        )
    `);
  const verifyUnchangedMatchup =
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM matchups
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND matchup_week_id = @weekId
        AND home_team_id = @homeTeamId
        AND away_team_id = @awayTeamId
        AND status = @status
        AND version = @version
    `);
  const verifyUnchangedBye = database.prepare(`
    SELECT COUNT(*) AS count
    FROM matchup_byes
    WHERE id = @id
      AND league_id = @leagueId
      AND season_id = @seasonId
      AND matchup_week_id = @weekId
      AND team_id = @teamId
  `);
  const countWeekScheduleChildren =
    database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM matchups
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND matchup_week_id = @weekId
        ) AS matchup_count,
        (
          SELECT COUNT(*)
          FROM matchup_byes
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND matchup_week_id = @weekId
        ) AS bye_count
    `);
  const supersedeScheduleGeneration =
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET
        status = 'superseded',
        superseded_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND schedule_operation_id =
          @oldScheduleOperationId
        AND schedule_version =
          @oldScheduleVersion
        AND week_one_matchup_week_id = @weekId
        AND week_one_starts_at_ms =
          @previousFirstWeekStartsAtMs
        AND status = 'current'
        AND superseded_at_ms IS NULL
        AND version = @currentGenerationVersion
    `);
  const insertReplacementScheduleGeneration =
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      ) VALUES (
        @leagueId,
        @seasonId,
        @newScheduleVersion,
        @operationId,
        @weekId,
        @firstWeekStartsAtMs,
        'current',
        @nowMs,
        NULL,
        1
      )
    `);
  const insertJobOccurrence = database.prepare(`
    INSERT INTO job_runs (
      id,
      league_id,
      season_id,
      job_type,
      occurrence_key,
      scheduled_for_ms,
      status,
      attempt_count,
      lease_owner,
      lease_expires_at_ms,
      started_at_ms,
      completed_at_ms,
      result_json,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version,
      lease_token,
      next_attempt_at_ms
    ) VALUES (
      @runId,
      @leagueId,
      @seasonId,
      @jobType,
      @occurrenceKey,
      @scheduledForMs,
      'pending',
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      @nowMs,
      @nowMs,
      1,
      NULL,
      @scheduledForMs
    )
  `);
  const insertJobBinding = database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id,
      league_id,
      season_id,
      job_run_id,
      job_type,
      schedule_operation_id,
      schedule_version,
      owning_matchup_week_id,
      owning_matchup_id,
      created_at_ms,
      version
    ) VALUES (
      @runId,
      @leagueId,
      @seasonId,
      @runId,
      @jobType,
      @operationId,
      1,
      @weekId,
      NULL,
      @nowMs,
      1
    )
  `);
  const insertReplacementJobBinding =
    database.prepare(`
      INSERT INTO matchup_schedule_job_bindings (
        id,
        league_id,
        season_id,
        job_run_id,
        job_type,
        schedule_operation_id,
        schedule_version,
        owning_matchup_week_id,
        owning_matchup_id,
        created_at_ms,
        version
      ) VALUES (
        @runId,
        @leagueId,
        @seasonId,
        @runId,
        @jobType,
        @operationId,
        @newScheduleVersion,
        @weekId,
        NULL,
        @nowMs,
        1
      )
    `);
  const insertCommandResult = database.prepare(`
    INSERT INTO matchup_schedule_command_results (
      id,
      league_id,
      season_id,
      action,
      idempotency_request_id,
      idempotency_operation,
      request_sha256,
      matchup_operation_id,
      actor_user_id,
      actor_membership_id,
      actor_authority,
      old_schedule_operation_id,
      old_schedule_version,
      new_schedule_operation_id,
      new_schedule_version,
      season_version_before,
      season_version_after,
      week_one_matchup_week_id,
      week_version_before,
      week_version_after,
      previous_first_week_starts_at_ms,
      first_week_starts_at_ms,
      last_week_ends_at_ms,
      nhl_regular_season_starts_at_ms,
      nhl_regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      calendar_persisted,
      participant_count,
      week_count,
      matchup_count,
      bye_count,
      shifted_week_count,
      replaced_job_occurrence_count,
      response_http_status,
      response_code,
      result_schema_version,
      created_at_ms,
      version
    ) VALUES (
      @commandResultId,
      @leagueId,
      @seasonId,
      'generate',
      @idempotencyRequestId,
      @idempotencyOperation,
      @requestHash,
      @operationId,
      @actorUserId,
      @actorMembershipId,
      @actorAuthority,
      NULL,
      NULL,
      @operationId,
      1,
      @seasonVersionBefore,
      @seasonVersionAfter,
      @firstWeekId,
      NULL,
      1,
      NULL,
      @firstWeekStartsAtMs,
      @lastWeekEndsAtMs,
      @nhlRegularSeasonStartsAtMs,
      @nhlRegularSeasonEndsAtMs,
      @fantasyPlayoffsStartAtMs,
      @fantasyPlayoffsEndAtMs,
      @calendarPersisted,
      @participantCount,
      @weekCount,
      @matchupCount,
      @byeCount,
      NULL,
      NULL,
      @responseHttpStatus,
      @responseCode,
      @resultSchemaVersion,
      @nowMs,
      1
    )
  `);
  const insertWeekOneShiftCommandResult =
    database.prepare(`
      INSERT INTO matchup_schedule_command_results (
        id,
        league_id,
        season_id,
        action,
        idempotency_request_id,
        idempotency_operation,
        request_sha256,
        matchup_operation_id,
        actor_user_id,
        actor_membership_id,
        actor_authority,
        old_schedule_operation_id,
        old_schedule_version,
        new_schedule_operation_id,
        new_schedule_version,
        season_version_before,
        season_version_after,
        week_one_matchup_week_id,
        week_version_before,
        week_version_after,
        previous_first_week_starts_at_ms,
        first_week_starts_at_ms,
        last_week_ends_at_ms,
        nhl_regular_season_starts_at_ms,
        nhl_regular_season_ends_at_ms,
        fantasy_playoffs_start_at_ms,
        fantasy_playoffs_end_at_ms,
        calendar_persisted,
        participant_count,
        week_count,
        matchup_count,
        bye_count,
        shifted_week_count,
        replaced_job_occurrence_count,
        response_http_status,
        response_code,
        result_schema_version,
        created_at_ms,
        version
      ) VALUES (
        @commandResultId,
        @leagueId,
        @seasonId,
        @shiftAction,
        @idempotencyRequestId,
        @idempotencyOperation,
        @requestHash,
        @operationId,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        @oldScheduleOperationId,
        @oldScheduleVersion,
        @operationId,
        @newScheduleVersion,
        @seasonVersionBefore,
        @seasonVersionAfter,
        @weekId,
        @weekVersionBefore,
        @weekVersionAfter,
        @previousFirstWeekStartsAtMs,
        @firstWeekStartsAtMs,
        @lastWeekEndsAtMs,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @shiftedWeekCount,
        @replacedJobOccurrenceCount,
        @responseHttpStatus,
        NULL,
        @resultSchemaVersion,
        @nowMs,
        1
      )
    `);
  const completeIdempotency =
    database.prepare(`
      UPDATE idempotency_requests
      SET
        status = 'completed',
        result_type = @resultType,
        result_id = @commandResultId,
        completed_at_ms = @nowMs
      WHERE id = @idempotencyRequestId
        AND league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = @idempotencyOperation
        AND client_key = @idempotencyKey
        AND request_hash = @requestHash
        AND status = 'started'
        AND result_type IS NULL
        AND result_id IS NULL
        AND completed_at_ms IS NULL
    `);
  const countScheduleRows = database.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM matchup_weeks
        WHERE league_id = @leagueId
          AND season_id = @seasonId
      ) AS week_count,
      (
        SELECT COUNT(*)
        FROM matchups
        WHERE league_id = @leagueId
          AND season_id = @seasonId
      ) AS matchup_count,
      (
        SELECT COUNT(*)
        FROM matchup_byes
        WHERE league_id = @leagueId
          AND season_id = @seasonId
      ) AS bye_count,
      (
        SELECT COUNT(*)
        FROM matchup_schedule_job_bindings
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND schedule_operation_id =
            @operationId
          AND schedule_version = 1
      ) AS binding_count,
      (
        SELECT COUNT(*)
        FROM job_runs
        JOIN matchup_schedule_job_bindings
          ON matchup_schedule_job_bindings
              .league_id = job_runs.league_id
         AND matchup_schedule_job_bindings
              .job_run_id = job_runs.id
        WHERE job_runs.league_id = @leagueId
          AND job_runs.season_id = @seasonId
          AND matchup_schedule_job_bindings
              .schedule_operation_id =
                @operationId
          AND matchup_schedule_job_bindings
              .schedule_version = 1
      ) AS bound_job_count,
      (
        SELECT COUNT(*)
        FROM job_runs
        WHERE job_runs.league_id = @leagueId
          AND job_runs.season_id = @seasonId
          AND job_runs.job_type LIKE 'matchup:%'
          AND job_runs.created_at_ms = @nowMs
          AND NOT EXISTS (
            SELECT 1
            FROM matchup_schedule_job_bindings
            WHERE matchup_schedule_job_bindings
                .league_id = job_runs.league_id
              AND matchup_schedule_job_bindings
                .job_run_id = job_runs.id
          )
      ) AS unbound_job_count
  `);
  const countWeekOneShiftRows =
    database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM matchup_weeks
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS week_count,
        (
          SELECT COUNT(*)
          FROM matchups
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS matchup_count,
        (
          SELECT COUNT(*)
          FROM matchup_byes
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS bye_count,
        (
          SELECT COUNT(*)
          FROM season_matchup_schedule_generations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND schedule_operation_id =
              @oldScheduleOperationId
            AND schedule_version =
              @oldScheduleVersion
            AND status = 'superseded'
            AND superseded_at_ms = @nowMs
            AND version =
              @supersededGenerationVersion
        ) AS superseded_generation_count,
        (
          SELECT COUNT(*)
          FROM season_matchup_schedule_generations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND schedule_operation_id =
              @operationId
            AND schedule_version =
              @newScheduleVersion
            AND week_one_matchup_week_id =
              @weekId
            AND week_one_starts_at_ms =
              @firstWeekStartsAtMs
            AND status = 'current'
            AND superseded_at_ms IS NULL
            AND version = 1
        ) AS current_generation_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          JOIN matchup_schedule_job_bindings
            ON matchup_schedule_job_bindings.league_id =
                job_runs.league_id
           AND matchup_schedule_job_bindings.job_run_id =
                job_runs.id
          WHERE job_runs.league_id = @leagueId
            AND job_runs.season_id = @seasonId
            AND matchup_schedule_job_bindings.schedule_operation_id =
              @oldScheduleOperationId
            AND matchup_schedule_job_bindings.schedule_version =
              @oldScheduleVersion
            AND job_runs.status = 'skipped'
            AND job_runs.attempt_count = 0
            AND job_runs.lease_owner IS NULL
            AND job_runs.lease_token IS NULL
            AND job_runs.lease_expires_at_ms IS NULL
            AND job_runs.started_at_ms IS NULL
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms IS NULL
            AND job_runs.updated_at_ms = @nowMs
        ) AS skipped_old_job_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          JOIN matchup_schedule_job_bindings
            ON matchup_schedule_job_bindings.league_id =
                job_runs.league_id
           AND matchup_schedule_job_bindings.job_run_id =
                job_runs.id
          WHERE job_runs.league_id = @leagueId
            AND job_runs.season_id = @seasonId
            AND matchup_schedule_job_bindings.schedule_operation_id =
              @operationId
            AND matchup_schedule_job_bindings.schedule_version =
              @newScheduleVersion
            AND job_runs.status = 'pending'
            AND job_runs.attempt_count = 0
            AND job_runs.lease_owner IS NULL
            AND job_runs.lease_token IS NULL
            AND job_runs.lease_expires_at_ms IS NULL
            AND job_runs.started_at_ms IS NULL
            AND job_runs.completed_at_ms IS NULL
            AND job_runs.result_json IS NULL
            AND job_runs.last_error_code IS NULL
            AND job_runs.next_attempt_at_ms =
              job_runs.scheduled_for_ms
            AND job_runs.created_at_ms = @nowMs
            AND job_runs.updated_at_ms = @nowMs
            AND job_runs.version = 1
            AND matchup_schedule_job_bindings.created_at_ms =
              @nowMs
            AND matchup_schedule_job_bindings.version = 1
        ) AS replacement_job_count,
        (
          SELECT COUNT(*)
          FROM free_agent_drafts
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS fad_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          WHERE job_runs.league_id = @leagueId
            AND job_runs.season_id = @seasonId
            AND job_runs.job_type LIKE 'matchup:%'
            AND NOT EXISTS (
              SELECT 1
              FROM matchup_schedule_job_bindings
              WHERE matchup_schedule_job_bindings.league_id =
                  job_runs.league_id
                AND matchup_schedule_job_bindings.job_run_id =
                  job_runs.id
            )
        ) AS unbound_job_count
    `);
  const weeksRead = database.prepare(`
    SELECT *
    FROM matchup_weeks
    WHERE league_id = @leagueId
      AND season_id = @seasonId
    ORDER BY sequence
  `);
  const matchupsRead = database.prepare(`
    SELECT *
    FROM matchups
    WHERE league_id = @leagueId
      AND season_id = @seasonId
    ORDER BY matchup_week_id, id
  `);
  const byesRead = database.prepare(`
    SELECT *
    FROM matchup_byes
    WHERE league_id = @leagueId
      AND season_id = @seasonId
    ORDER BY matchup_week_id, team_id
  `);

  function readContext({ leagueId, seasonId }) {
    try {
      const scope = {
        leagueId: stableId(leagueId),
        seasonId: stableId(seasonId),
      };
      const row = requireSingle(
        contextStatement.all(scope),
        "The matchup schedule context"
      );
      if (!row) return null;
      return Object.freeze({
        ...row,
        teams: freezeRows(
          teamsStatement.all(scope)
        ),
        existingWeekCount:
          existingScheduleStatement.get(scope)
            .count,
        existingGenerationCount:
          existingGenerationStatement.get(scope)
            .count,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readMatchupScheduleContext",
        tableName: "matchup_weeks",
      });
    }
  }

  function readShiftContext({
    leagueId,
    seasonId,
  } = {}) {
    try {
      const scope = {
        leagueId: stableId(leagueId),
        seasonId: stableId(seasonId),
      };
      const row = requireSingle(
        contextStatement.all(scope),
        "The matchup schedule shift context"
      );
      if (!row) return null;

      const generationRows =
        currentGenerationsStatement.all(scope);
      const currentGeneration =
        generationRows.length === 1
          ? mapShiftGeneration(
              generationRows[0]
            )
          : null;
      const matchupRows =
        matchupsRead.all(scope);
      const byeRows = byesRead.all(scope);
      const matchupsByWeek = new Map();
      for (const matchupRow of matchupRows) {
        const rows =
          matchupsByWeek.get(
            matchupRow.matchup_week_id
          ) || [];
        rows.push(mapShiftMatchup(matchupRow));
        matchupsByWeek.set(
          matchupRow.matchup_week_id,
          rows
        );
      }
      const byesByWeek = new Map();
      for (const byeRow of byeRows) {
        const rows =
          byesByWeek.get(
            byeRow.matchup_week_id
          ) || [];
        rows.push(mapShiftBye(byeRow));
        byesByWeek.set(
          byeRow.matchup_week_id,
          rows
        );
      }
      const weeks = weeksRead
        .all(scope)
        .map((weekRow) => {
          const weekByes =
            byesByWeek.get(weekRow.id) || [];
          return Object.freeze({
            id: weekRow.id,
            leagueId: weekRow.league_id,
            seasonId: weekRow.season_id,
            weekKey: weekRow.week_key,
            sequence: weekRow.sequence,
            startsAtMs: weekRow.starts_at_ms,
            baselineAtMs:
              weekRow.baseline_at_ms,
            locksAtMs: weekRow.locks_at_ms,
            endsAtMs: weekRow.ends_at_ms,
            rollsOverAtMs:
              weekRow.rolls_over_at_ms,
            status: weekRow.status,
            version: weekRow.version,
            matchups: Object.freeze(
              matchupsByWeek.get(weekRow.id) ||
                []
            ),
            bye:
              weekByes.length === 1
                ? weekByes[0]
                : weekByes.length === 0
                  ? null
                  : Object.freeze({
                      invalidDuplicateCount:
                        weekByes.length,
                    }),
          });
        });
      const jobs = currentGeneration
        ? currentGenerationJobsStatement
            .all({
              ...scope,
              scheduleOperationId:
                currentGeneration
                  .scheduleOperationId,
              scheduleVersion:
                currentGeneration
                  .scheduleVersion,
            })
            .map(mapShiftJob)
        : [];

      return Object.freeze({
        leagueId: row.league_id,
        seasonId: row.season_id,
        timeZone: row.timezone,
        seasonStatus: row.season_status,
        seasonVersion: row.season_version,
        nhlSeasonKey: row.nhl_season_key,
        nhlRegularSeasonStartsAtMs:
          row.regular_season_starts_at_ms,
        nhlRegularSeasonEndsAtMs:
          row.regular_season_ends_at_ms,
        fantasyPlayoffsStartAtMs:
          row.fantasy_playoffs_start_at_ms,
        fantasyPlayoffsEndAtMs:
          row.fantasy_playoffs_end_at_ms,
        fadCount:
          fadCountStatement.get(scope).count,
        teams: freezeRows(
          teamsStatement.all(scope)
        ),
        currentGenerationCount:
          generationRows.length,
        currentGeneration,
        weeks: Object.freeze(weeks),
        jobs: Object.freeze(jobs),
        unboundJobCount:
          unboundMatchupJobCountStatement.get(
            scope
          ).count,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readMatchupScheduleShiftContext",
        tableName:
          "season_matchup_schedule_generations",
      });
    }
  }

  function findIdempotency({
    leagueId,
    actorUserId,
    operation,
    clientKey,
  } = {}) {
    try {
      const parameters = {
        leagueId: stableId(leagueId),
        actorUserId: stableId(actorUserId),
        operation,
        clientKey,
      };
      if (
        ![
          MATCHUP_SCHEDULE_COMMAND_OPERATION,
          MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
        ].includes(operation) ||
        typeof clientKey !== "string" ||
        clientKey.length < 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "An exact matchup schedule idempotency scope is required."
        );
      }
      return mapIdempotency(
        requireSingle(
          idempotencyByScopeStatement.all(
            parameters
          ),
          "The matchup schedule idempotency scope"
        )
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "findMatchupScheduleIdempotency",
        tableName: "idempotency_requests",
      });
    }
  }

  function findCommandResult({
    leagueId,
    resultId,
  } = {}) {
    try {
      return mapCommandResult(
        requireSingle(
          commandResultByIdStatement.all({
            leagueId: stableId(leagueId),
            resultId: stableId(resultId),
          }),
          "The matchup schedule command result"
        )
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "findMatchupScheduleCommandResult",
        tableName:
          "matchup_schedule_command_results",
      });
    }
  }

  function incompatibleCorrectiveReadiness() {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The inaugural FAD readiness state is not safe for matchup-schedule correction."
    );
  }

  function classifyCorrectiveReadiness(
    parameters
  ) {
    const readiness = requireSingle(
      correctiveReadinessStatement.all(
        parameters
      ),
      "The matchup-schedule FAD readiness operation"
    );
    if (!readiness) return null;
    if (
      readiness.trigger_kind !==
      "no_draft_inaugural"
    ) {
      return null;
    }

    let job = null;
    if (
      UUID_PATTERN.test(
        readiness.job_run_id || ""
      )
    ) {
      job = requireSingle(
        correctiveReadinessJobStatement.all({
          ...parameters,
          jobRunId: readiness.job_run_id,
        }),
        "The matchup-schedule FAD readiness job"
      );
    }
    const readinessJobInventory =
      correctiveReadinessJobInventoryStatement.all(
        parameters
      );
    const attempts =
      correctiveReadinessAttemptsStatement.all({
        ...parameters,
        readinessOperationId: readiness.id,
      });
    if (
      readinessJobInventory.length !== 1 ||
      readinessJobInventory[0].id !==
        readiness.job_run_id ||
      !readinessIdentityIsAligned(
        readiness,
        job,
        parameters
      )
    ) {
      incompatibleCorrectiveReadiness();
    }

    if (
      initialPendingReadinessIsValid(
        readiness,
        job,
        attempts
      ) ||
      runningReadinessIsValid(
        readiness,
        job,
        attempts
      )
    ) {
      return null;
    }

    if (readiness.status === "succeeded") {
      const succeededEvidenceParameters = {
        ...parameters,
        activityId:
          readiness.cards_opened_activity_id,
        deadlineJobRunId:
          readiness.deadline_job_run_id,
        fadId: readiness.created_fad_id,
        occurrenceKey:
          readiness.readiness_occurrence_key,
        outboxEventId:
          readiness.cards_opened_outbox_event_id,
        readinessOperationId: readiness.id,
        reminderJobRunId:
          readiness.reminder_job_run_id,
        scheduleRecoveryId:
          readiness.schedule_recovery_id,
        terminalAtMs: readiness.terminal_at_ms,
      };
      const succeededEvidence = {
        ...correctiveSucceededEvidenceStatement.get(
          succeededEvidenceParameters
        ),
        cards:
          correctiveSucceededCardsStatement.all(
            succeededEvidenceParameters
          ),
        notifications:
          correctiveSucceededNotificationsStatement.all(
            succeededEvidenceParameters
          ),
        publicationRows:
          correctiveSucceededPublicationsStatement.all(
            succeededEvidenceParameters
          ),
      };
      if (
        succeededReadinessIsValid(
          readiness,
          job,
          attempts,
          succeededEvidence
        )
      ) {
        return null;
      }
      incompatibleCorrectiveReadiness();
    }

    if (
      readiness.status === "blocked" &&
      job.status === "pending"
    ) {
      const receipt = requireSingle(
        correctiveRetryReceiptStatement.all({
          ...parameters,
          readinessOperationId: readiness.id,
          readinessVersion:
            readiness.version,
        }),
        "The matchup-schedule FAD readiness retry receipt"
      );
      if (
        blockedPendingReadinessIsValid(
          readiness,
          job,
          attempts,
          receipt
        )
      ) {
        return null;
      }
      incompatibleCorrectiveReadiness();
    }

    const blockers =
      canonicalReadinessBlockers(
        readiness.blockers_json
      );
    if (
      !blockedFailedReadinessIsValid(
        readiness,
        job,
        attempts,
        blockers
      )
    ) {
      incompatibleCorrectiveReadiness();
    }
    if (
      !hasExactMissingScheduleBlocker(
        blockers,
        parameters.seasonId
      )
    ) {
      return null;
    }
    if (
      parameters.nowMs <=
      readiness.terminal_at_ms
    ) {
      incompatibleCorrectiveReadiness();
    }

    return {
      ...parameters,
      attemptCount:
        readiness.attempt_count,
      blockersJson:
        readiness.blockers_json,
      blockedAtMs:
        readiness.terminal_at_ms,
      jobRunId: job.id,
      jobVersionBefore: job.version,
      jobVersionAfter: job.version + 1,
      occurrenceKey:
        readiness.readiness_occurrence_key,
      previousNextRetryAtMs:
        readiness.next_retry_at_ms,
      readinessAttemptId:
        attempts.at(-1).id,
      readinessOperationId: readiness.id,
      readinessVersionBefore:
        readiness.version,
      readinessVersionAfter:
        readiness.version + 1,
      scheduledForMs: job.scheduled_for_ms,
      startedAtMs: job.started_at_ms,
    };
  }

  function applyCorrectiveReadinessRequeue(
    parameters
  ) {
    const correction =
      classifyCorrectiveReadiness(parameters);
    if (correction === null) return;
    if (
      insertCorrectiveRequeue.run(correction)
        .changes !== 1
    ) {
      incompatibleCorrectiveReadiness();
    }
    if (beforeCommit) {
      beforeCommit("after_corrective_evidence");
    }
    if (
      resetCorrectiveReadinessJob.run(
        correction
      ).changes !== 1
    ) {
      incompatibleCorrectiveReadiness();
    }
    if (beforeCommit) {
      beforeCommit("after_job_reset");
    }
    if (
      advanceCorrectiveReadiness.run(
        correction
      ).changes !== 1
    ) {
      incompatibleCorrectiveReadiness();
    }
    if (beforeCommit) {
      beforeCommit("after_readiness_advance");
    }
  }

  function applyConfirmedSchedulePlan(plan) {
    try {
      if (database.inTransaction !== true) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Confirmed matchup scheduling requires an immediate outer transaction."
        );
      }
      if (!plan || typeof plan !== "object") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A confirmed matchup schedule plan is required."
        );
      }
      const participantTeamIds =
        canonicalParticipantTeamIds(
          plan.participantTeamIds
        );
      const {
        actor,
        idempotency,
        result,
      } = plan;
      const parameters = {
        actorAuthority: actor?.authority,
        actorMembershipId: stableId(
          actor?.membershipId
        ),
        actorUserId: stableId(
          actor?.actorUserId
        ),
        byeCount: result?.byeCount,
        calendarPersisted:
          plan.calendarPersisted === true
            ? 1
            : 0,
        commandResultId: stableId(
          plan.commandResultId
        ),
        correctiveRequeueId: stableId(
          plan.correctiveRequeueId
        ),
        fantasyPlayoffsEndAtMs:
          result?.fantasyPlayoffsEndAtMs,
        fantasyPlayoffsStartAtMs:
          result?.fantasyPlayoffsStartAtMs,
        firstWeekId: stableId(
          result?.firstWeekId
        ),
        firstWeekStartsAtMs:
          result?.firstWeekStartsAtMs,
        idempotencyExpiresAtMs:
          idempotency?.expiresAtMs,
        idempotencyKey:
          idempotency?.clientKey,
        idempotencyOperation:
          idempotency?.operation,
        idempotencyRequestId: stableId(
          idempotency?.id
        ),
        lastWeekEndsAtMs:
          result?.lastWeekEndsAtMs,
        leagueId: stableId(plan.leagueId),
        matchupCount: result?.matchupCount,
        nhlRegularSeasonEndsAtMs:
          result?.nhlRegularSeasonEndsAtMs,
        nhlRegularSeasonStartsAtMs:
          result?.nhlRegularSeasonStartsAtMs,
        nowMs: plan.nowMs,
        operationId: stableId(
          plan.operationId
        ),
        participantCount:
          result?.participantCount,
        requestHash:
          idempotency?.requestHash,
        responseCode:
          MATCHUP_SCHEDULE_COMMAND_CODE,
        responseHttpStatus:
          MATCHUP_SCHEDULE_COMMAND_HTTP_STATUS,
        resultSchemaVersion:
          MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
        resultType:
          MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
        seasonId: stableId(plan.seasonId),
        seasonVersionAfter:
          result?.seasonVersion,
        seasonVersionBefore:
          plan.expectedSeasonVersion,
        weekCount: result?.weekCount,
      };
      if (
        ![
          "commissioner",
          "platform_administrator_as_commissioner",
        ].includes(parameters.actorAuthority) ||
        parameters.idempotencyOperation !==
          MATCHUP_SCHEDULE_COMMAND_OPERATION ||
        !DIGEST_PATTERN.test(
          parameters.requestHash || ""
        ) ||
        !Number.isSafeInteger(
          parameters.nowMs
        ) ||
        parameters.nowMs < 0 ||
        !Number.isSafeInteger(
          parameters.idempotencyExpiresAtMs
        ) ||
        parameters.idempotencyExpiresAtMs <=
          parameters.nowMs ||
        !Number.isSafeInteger(
          parameters.seasonVersionBefore
        ) ||
        parameters.seasonVersionBefore < 1 ||
        parameters.seasonVersionAfter !==
          parameters.seasonVersionBefore + 1 ||
        parameters.participantCount !==
          participantTeamIds.length ||
        !Array.isArray(plan.weeks) ||
        plan.weeks.length !==
          parameters.weekCount ||
        parameters.firstWeekId !==
          plan.weeks[0]?.id ||
        parameters.firstWeekStartsAtMs !==
          plan.weeks[0]?.startsAtMs ||
        parameters.lastWeekEndsAtMs !==
          plan.weeks.at(-1)?.endsAtMs
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The confirmed matchup schedule plan is inconsistent."
        );
      }

      insertIdempotency.run(parameters);
      if (updateSeason.run(parameters).changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The matchup schedule season context changed."
        );
      }
      if (beforeCommit) beforeCommit("after_season_cas");
      for (const week of plan.weeks) {
        insertWeek.run(week);
        for (const matchup of week.matchups) {
          insertMatchup.run(matchup);
        }
        if (week.bye) insertBye.run(week.bye);
      }
      if (beforeCommit) {
        beforeCommit("after_schedule_children");
      }
      insertOperation.run({
        ...parameters,
        metadataJson: JSON.stringify({
          participantCount:
            parameters.participantCount,
          participantTeamIds,
          weekCount: parameters.weekCount,
          matchupCount:
            parameters.matchupCount,
          jobOccurrenceCount:
            plan.weeks.reduce(
              (sum, week) =>
                sum +
                week.occurrences.length,
              0
            ),
        }),
      });
      insertScheduleGeneration.run(parameters);
      for (const week of plan.weeks) {
        for (const occurrence of week.occurrences) {
          insertJobOccurrence.run(occurrence);
          insertJobBinding.run({
            ...occurrence,
            operationId:
              parameters.operationId,
            weekId: week.id,
          });
        }
      }
      if (beforeCommit) {
        beforeCommit("after_jobs_and_bindings");
      }
      const expectedJobCount =
        plan.weeks.reduce(
          (sum, week) =>
            sum + week.occurrences.length,
          0
        );
      const counts =
        countScheduleRows.get(parameters);
      if (
        counts.week_count !==
          parameters.weekCount ||
        counts.matchup_count !==
          parameters.matchupCount ||
        counts.bye_count !==
          parameters.byeCount ||
        counts.binding_count !==
          expectedJobCount ||
        counts.bound_job_count !==
          expectedJobCount ||
        counts.unbound_job_count !== 0
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The confirmed matchup schedule rows did not reconcile."
        );
      }
      insertCommandResult.run(parameters);
      if (beforeCommit) {
        beforeCommit("after_command_result");
      }
      applyCorrectiveReadinessRequeue(
        parameters
      );
      if (
        completeIdempotency.run(parameters)
          .changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The matchup schedule idempotency result changed."
        );
      }
      if (beforeCommit) {
        beforeCommit(
          "after_idempotency_completion"
        );
      }
      return Object.freeze({ applied: true });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "applyConfirmedMatchupSchedulePlan",
        tableName:
          "matchup_schedule_command_results",
      });
    }
  }

  function applyWeekOneShiftPlan(plan) {
    try {
      if (database.inTransaction !== true) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Week 1 shifting requires an immediate outer transaction."
        );
      }
      if (!plan || typeof plan !== "object") {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A Week 1 shift plan is required."
        );
      }

      const participantTeamIds =
        canonicalParticipantTeamIds(
          plan.participantTeamIds
        );
      const {
        actor,
        calendar,
        idempotency,
        result,
      } = plan;
      const parameters = {
        actorAuthority: actor?.authority,
        actorMembershipId: stableId(
          actor?.membershipId
        ),
        actorUserId: stableId(
          actor?.actorUserId
        ),
        commandResultId: stableId(
          plan.commandResultId
        ),
        currentGenerationVersion:
          plan.currentGenerationVersion,
        fantasyPlayoffsEndAtMs:
          calendar?.fantasyPlayoffsEndAtMs,
        fantasyPlayoffsStartAtMs:
          calendar?.fantasyPlayoffsStartAtMs,
        firstWeekStartsAtMs:
          result?.firstWeekStartsAtMs,
        idempotencyExpiresAtMs:
          idempotency?.expiresAtMs,
        idempotencyKey:
          idempotency?.clientKey,
        idempotencyOperation:
          idempotency?.operation,
        idempotencyRequestId: stableId(
          idempotency?.id
        ),
        lastWeekEndsAtMs:
          result?.lastWeekEndsAtMs,
        leagueId: stableId(plan.leagueId),
        newScheduleVersion:
          plan.newScheduleVersion,
        nhlRegularSeasonEndsAtMs:
          calendar?.nhlRegularSeasonEndsAtMs,
        nhlRegularSeasonStartsAtMs:
          calendar?.nhlRegularSeasonStartsAtMs,
        nowMs: plan.nowMs,
        oldScheduleOperationId: stableId(
          plan.oldScheduleOperationId
        ),
        oldScheduleVersion:
          plan.oldScheduleVersion,
        operationId: stableId(
          plan.operationId
        ),
        previousFirstWeekStartsAtMs:
          result?.previousFirstWeekStartsAtMs,
        replacedJobOccurrenceCount:
          result?.replacedJobOccurrenceCount,
        requestHash:
          idempotency?.requestHash,
        responseHash: plan.responseHash,
        responseHttpStatus:
          MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
        resultSchemaVersion:
          MATCHUP_SCHEDULE_COMMAND_SCHEMA_VERSION,
        resultType:
          MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE,
        seasonId: stableId(plan.seasonId),
        seasonVersionAfter:
          result?.seasonVersion,
        seasonVersionBefore:
          plan.expectedSeasonVersion,
        shiftAction:
          MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
        shiftedWeekCount:
          result?.shiftedWeekCount,
        supersededGenerationVersion:
          plan.currentGenerationVersion + 1,
        weekId: stableId(result?.weekId),
        weekVersionAfter:
          result?.weekVersion,
        weekVersionBefore:
          plan.expectedWeekVersion,
      };
      const safeTimestamp = (value) =>
        Number.isSafeInteger(value) &&
        value >= 0;
      const safeVersion = (value) =>
        Number.isSafeInteger(value) &&
        value >= 1 &&
        value < Number.MAX_SAFE_INTEGER;
      if (
        ![
          "commissioner",
          "platform_administrator_as_commissioner",
        ].includes(parameters.actorAuthority) ||
        parameters.idempotencyOperation !==
          MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION ||
        idempotency?.resultType !==
          MATCHUP_SCHEDULE_COMMAND_RESULT_TYPE ||
        !DIGEST_PATTERN.test(
          parameters.requestHash || ""
        ) ||
        !DIGEST_PATTERN.test(
          parameters.responseHash || ""
        ) ||
        typeof parameters.idempotencyKey !==
          "string" ||
        parameters.idempotencyKey.length < 1 ||
        !safeTimestamp(parameters.nowMs) ||
        !safeTimestamp(
          parameters.idempotencyExpiresAtMs
        ) ||
        parameters.idempotencyExpiresAtMs <=
          parameters.nowMs ||
        ![
          parameters.nhlRegularSeasonStartsAtMs,
          parameters.nhlRegularSeasonEndsAtMs,
          parameters.fantasyPlayoffsStartAtMs,
          parameters.fantasyPlayoffsEndAtMs,
          parameters.previousFirstWeekStartsAtMs,
          parameters.firstWeekStartsAtMs,
          parameters.lastWeekEndsAtMs,
        ].every(safeTimestamp) ||
        parameters.nhlRegularSeasonStartsAtMs >=
          parameters.fantasyPlayoffsStartAtMs ||
        parameters.fantasyPlayoffsStartAtMs >=
          parameters.fantasyPlayoffsEndAtMs ||
        parameters.nhlRegularSeasonEndsAtMs !==
          parameters.fantasyPlayoffsEndAtMs ||
        parameters.previousFirstWeekStartsAtMs ===
          parameters.firstWeekStartsAtMs ||
        parameters.firstWeekStartsAtMs >=
          parameters.lastWeekEndsAtMs ||
        parameters.operationId ===
          parameters.oldScheduleOperationId ||
        !safeVersion(
          parameters.seasonVersionBefore
        ) ||
        parameters.seasonVersionAfter !==
          parameters.seasonVersionBefore + 1 ||
        !safeVersion(
          parameters.currentGenerationVersion
        ) ||
        !safeVersion(
          parameters.oldScheduleVersion
        ) ||
        parameters.newScheduleVersion !==
          parameters.oldScheduleVersion + 1 ||
        !safeVersion(
          parameters.weekVersionBefore
        ) ||
        parameters.weekVersionAfter !==
          parameters.weekVersionBefore + 1 ||
        result?.operationId !==
          parameters.operationId ||
        result?.seasonId !==
          parameters.seasonId ||
        !Array.isArray(plan.weeks) ||
        plan.weeks.length < 1 ||
        parameters.shiftedWeekCount !==
          plan.weeks.length ||
        parameters.replacedJobOccurrenceCount !==
          plan.weeks.length * 6 ||
        plan.weeks[0]?.id !==
          parameters.weekId ||
        plan.weeks[0]?.expectedVersion !==
          parameters.weekVersionBefore ||
        plan.weeks[0]?.version !==
          parameters.weekVersionAfter ||
        plan.weeks[0]?.previousStartsAtMs !==
          parameters.previousFirstWeekStartsAtMs ||
        plan.weeks[0]?.startsAtMs !==
          parameters.firstWeekStartsAtMs ||
        plan.weeks.at(-1)?.endsAtMs !==
          parameters.lastWeekEndsAtMs
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The Week 1 shift plan is inconsistent."
        );
      }

      const activeTeamIds = teamsStatement
        .all({
          leagueId: parameters.leagueId,
        })
        .map(({ id }) => stableId(id))
        .sort();
      if (
        activeTeamIds.length !==
          participantTeamIds.length ||
        activeTeamIds.some(
          (id, index) =>
            id !== participantTeamIds[index]
        )
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The active matchup schedule participants changed."
        );
      }

      const weekIds = new Set();
      const weekKeys = new Set();
      const replacementRunIds = new Set();
      const replacedRunIds = new Set();
      const replacementOccurrenceKeys =
        new Set();
      const replacedOccurrenceKeys =
        new Set();
      let expectedMatchupCount = 0;
      let expectedByeCount = 0;
      for (
        let index = 0;
        index < plan.weeks.length;
        index += 1
      ) {
        const week = plan.weeks[index];
        stableId(week?.id);
        if (
          week.leagueId !==
            parameters.leagueId ||
          week.seasonId !==
            parameters.seasonId ||
          typeof week.weekKey !== "string" ||
          week.weekKey.length < 1 ||
          week.sequence !== index + 1 ||
          weekIds.has(week.id) ||
          weekKeys.has(week.weekKey) ||
          !safeVersion(week.expectedVersion) ||
          week.version !==
            week.expectedVersion + 1 ||
          week.nowMs !== parameters.nowMs ||
          ![
            week.previousStartsAtMs,
            week.previousBaselineAtMs,
            week.previousLocksAtMs,
            week.previousEndsAtMs,
            week.previousRollsOverAtMs,
            week.startsAtMs,
            week.baselineAtMs,
            week.locksAtMs,
            week.endsAtMs,
            week.rollsOverAtMs,
          ].every(safeTimestamp) ||
          !(
            week.previousStartsAtMs <
              week.previousBaselineAtMs &&
            week.previousBaselineAtMs <
              week.previousLocksAtMs &&
            week.previousLocksAtMs <
              week.previousEndsAtMs &&
            week.previousRollsOverAtMs ===
              week.previousEndsAtMs &&
            week.startsAtMs <
              week.baselineAtMs &&
            week.baselineAtMs <
              week.locksAtMs &&
            week.locksAtMs <
              week.endsAtMs &&
            week.rollsOverAtMs ===
              week.endsAtMs
          ) ||
          week.previousStartsAtMs ===
            week.startsAtMs ||
          !Array.isArray(week.matchups) ||
          week.matchups.length < 1 ||
          !Array.isArray(week.occurrences) ||
          week.occurrences.length !== 6
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "A shifted matchup week is inconsistent."
          );
        }
        weekIds.add(week.id);
        weekKeys.add(week.weekKey);

        const weekTeamIds = [];
        const matchupIds = new Set();
        for (const matchup of week.matchups) {
          stableId(matchup?.id);
          stableId(matchup?.homeTeamId);
          stableId(matchup?.awayTeamId);
          if (
            matchup.leagueId !==
              parameters.leagueId ||
            matchup.seasonId !==
              parameters.seasonId ||
            matchup.weekId !== week.id ||
            matchup.status !== "scheduled" ||
            !safeVersion(matchup.version) ||
            matchup.homeTeamId ===
              matchup.awayTeamId ||
            matchupIds.has(matchup.id)
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.argumentInvalid,
              "A preserved matchup is inconsistent."
            );
          }
          matchupIds.add(matchup.id);
          weekTeamIds.push(
            matchup.homeTeamId,
            matchup.awayTeamId
          );
        }
        if (week.bye !== null) {
          stableId(week.bye?.id);
          stableId(week.bye?.teamId);
          if (
            week.bye.leagueId !==
              parameters.leagueId ||
            week.bye.seasonId !==
              parameters.seasonId ||
            week.bye.weekId !== week.id
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.argumentInvalid,
              "A preserved matchup bye is inconsistent."
            );
          }
          weekTeamIds.push(week.bye.teamId);
          expectedByeCount += 1;
        }
        weekTeamIds.sort();
        if (
          weekTeamIds.length !==
            participantTeamIds.length ||
          new Set(weekTeamIds).size !==
            weekTeamIds.length ||
          weekTeamIds.some(
            (id, teamIndex) =>
              id !==
              participantTeamIds[teamIndex]
          )
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "A shifted week changed schedule participants."
          );
        }
        expectedMatchupCount +=
          week.matchups.length;

        const expectedNewSignatures = [
          `matchup:statistics_refresh\u0000${week.startsAtMs}`,
          `matchup:baseline\u0000${week.baselineAtMs}`,
          `matchup:lock\u0000${week.locksAtMs}`,
          `matchup:statistics_refresh\u0000${week.endsAtMs}`,
          `matchup:finalize\u0000${week.endsAtMs}`,
          `matchup:rollover\u0000${week.rollsOverAtMs}`,
        ].sort();
        const expectedOldSignatures = [
          `matchup:statistics_refresh\u0000${week.previousStartsAtMs}`,
          `matchup:baseline\u0000${week.previousBaselineAtMs}`,
          `matchup:lock\u0000${week.previousLocksAtMs}`,
          `matchup:statistics_refresh\u0000${week.previousEndsAtMs}`,
          `matchup:finalize\u0000${week.previousEndsAtMs}`,
          `matchup:rollover\u0000${week.previousRollsOverAtMs}`,
        ].sort();
        const actualNewSignatures = [];
        const actualOldSignatures = [];
        for (const occurrence of week.occurrences) {
          stableId(occurrence?.runId);
          stableId(
            occurrence?.replacedJobRunId
          );
          if (
            occurrence.leagueId !==
              parameters.leagueId ||
            occurrence.seasonId !==
              parameters.seasonId ||
            occurrence.weekId !== week.id ||
            occurrence.nowMs !==
              parameters.nowMs ||
            typeof occurrence.jobType !==
              "string" ||
            !occurrence.jobType.startsWith(
              "matchup:"
            ) ||
            typeof occurrence.occurrenceKey !==
              "string" ||
            occurrence.occurrenceKey.length <
              1 ||
            typeof occurrence
              .replacedOccurrenceKey !==
              "string" ||
            occurrence.replacedOccurrenceKey
              .length < 1 ||
            !safeTimestamp(
              occurrence.scheduledForMs
            ) ||
            !safeTimestamp(
              occurrence.previousScheduledForMs
            ) ||
            !safeVersion(
              occurrence.replacedJobVersion
            ) ||
            occurrence.runId ===
              occurrence.replacedJobRunId ||
            replacementRunIds.has(
              occurrence.runId
            ) ||
            replacedRunIds.has(
              occurrence.replacedJobRunId
            ) ||
            replacementOccurrenceKeys.has(
              occurrence.occurrenceKey
            ) ||
            replacedOccurrenceKeys.has(
              occurrence.replacedOccurrenceKey
            )
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.argumentInvalid,
              "A replacement matchup job occurrence is inconsistent."
            );
          }
          replacementRunIds.add(
            occurrence.runId
          );
          replacedRunIds.add(
            occurrence.replacedJobRunId
          );
          replacementOccurrenceKeys.add(
            occurrence.occurrenceKey
          );
          replacedOccurrenceKeys.add(
            occurrence.replacedOccurrenceKey
          );
          actualNewSignatures.push(
            `${occurrence.jobType}\u0000${occurrence.scheduledForMs}`
          );
          actualOldSignatures.push(
            `${occurrence.jobType}\u0000${occurrence.previousScheduledForMs}`
          );
        }
        actualNewSignatures.sort();
        actualOldSignatures.sort();
        if (
          actualNewSignatures.some(
            (signature, occurrenceIndex) =>
              signature !==
              expectedNewSignatures[
                occurrenceIndex
              ]
          ) ||
          actualOldSignatures.some(
            (signature, occurrenceIndex) =>
              signature !==
              expectedOldSignatures[
                occurrenceIndex
              ]
          )
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.argumentInvalid,
            "A replacement matchup job calendar is inconsistent."
          );
        }
      }

      insertIdempotency.run(parameters);
      if (beforeCommit) {
        beforeCommit(
          "after_idempotency_started"
        );
      }
      if (
        updateSeasonForWeekOneShift.run(
          parameters
        ).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The Week 1 shift season context changed."
        );
      }
      if (beforeCommit) {
        beforeCommit("after_season_cas");
      }
      for (const week of plan.weeks) {
        if (
          updateWeekForWeekOneShift.run(
            week
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "A matchup week changed before shifting."
          );
        }
      }
      if (beforeCommit) {
        beforeCommit("after_week_updates");
      }
      for (const week of plan.weeks) {
        for (const occurrence of week.occurrences) {
          if (
            skipReplacedJobOccurrence.run({
              ...occurrence,
              oldScheduleOperationId:
                parameters
                  .oldScheduleOperationId,
              oldScheduleVersion:
                parameters.oldScheduleVersion,
            }).changes !== 1
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.versionConflict,
              "A replaced matchup job occurrence changed."
            );
          }
        }
      }
      if (beforeCommit) {
        beforeCommit("after_old_jobs_skipped");
      }
      if (
        supersedeScheduleGeneration.run(
          parameters
        ).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The current matchup schedule generation changed."
        );
      }
      if (beforeCommit) {
        beforeCommit(
          "after_old_generation_superseded"
        );
      }
      insertOperation.run({
        ...parameters,
        metadataJson: JSON.stringify({
          action:
            MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
          oldScheduleOperationId:
            parameters.oldScheduleOperationId,
          oldScheduleVersion:
            parameters.oldScheduleVersion,
          newScheduleVersion:
            parameters.newScheduleVersion,
          previousFirstWeekStartsAtMs:
            parameters
              .previousFirstWeekStartsAtMs,
          firstWeekStartsAtMs:
            parameters.firstWeekStartsAtMs,
          shiftedWeekCount:
            parameters.shiftedWeekCount,
          replacedJobOccurrenceCount:
            parameters
              .replacedJobOccurrenceCount,
          participantTeamIds,
          responseSha256:
            parameters.responseHash,
        }),
      });
      insertReplacementScheduleGeneration.run(
        parameters
      );
      if (beforeCommit) {
        beforeCommit("after_new_generation");
      }
      for (const week of plan.weeks) {
        for (const occurrence of week.occurrences) {
          insertJobOccurrence.run(occurrence);
          insertReplacementJobBinding.run({
            ...occurrence,
            newScheduleVersion:
              parameters.newScheduleVersion,
            operationId:
              parameters.operationId,
          });
        }
      }
      if (beforeCommit) {
        beforeCommit("after_jobs_and_bindings");
      }

      for (const week of plan.weeks) {
        const childCounts =
          countWeekScheduleChildren.get({
            leagueId: parameters.leagueId,
            seasonId: parameters.seasonId,
            weekId: week.id,
          });
        if (
          childCounts.matchup_count !==
            week.matchups.length ||
          childCounts.bye_count !==
            (week.bye === null ? 0 : 1)
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A shifted matchup week changed its schedule children."
          );
        }
        for (const matchup of week.matchups) {
          if (
            verifyUnchangedMatchup.get(
              matchup
            ).count !== 1
          ) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.schemaIncompatible,
              "A shifted matchup changed unexpectedly."
            );
          }
        }
        if (
          week.bye !== null &&
          verifyUnchangedBye.get(week.bye)
            .count !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A shifted matchup bye changed unexpectedly."
          );
        }
      }
      const counts =
        countWeekOneShiftRows.get(parameters);
      if (
        counts.week_count !==
          plan.weeks.length ||
        counts.matchup_count !==
          expectedMatchupCount ||
        counts.bye_count !==
          expectedByeCount ||
        counts.superseded_generation_count !==
          1 ||
        counts.current_generation_count !== 1 ||
        counts.skipped_old_job_count !==
          parameters
            .replacedJobOccurrenceCount ||
        counts.replacement_job_count !==
          parameters
            .replacedJobOccurrenceCount ||
        counts.fad_count !== 0 ||
        counts.unbound_job_count !== 0
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The Week 1 shift rows did not reconcile."
        );
      }

      insertWeekOneShiftCommandResult.run(
        parameters
      );
      if (beforeCommit) {
        beforeCommit("after_command_result");
      }
      if (
        completeIdempotency.run(parameters)
          .changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The Week 1 shift idempotency result changed."
        );
      }
      if (beforeCommit) {
        beforeCommit(
          "after_idempotency_completion"
        );
      }
      return Object.freeze({ applied: true });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "applyMatchupScheduleWeekOneShiftPlan",
        tableName:
          "matchup_schedule_command_results",
      });
    }
  }

  function readSchedule({ leagueId, seasonId }) {
    const scope = {
      leagueId: stableId(leagueId),
      seasonId: stableId(seasonId),
    };
    return Object.freeze({
      weeks: freezeRows(weeksRead.all(scope)),
      matchups: freezeRows(
        matchupsRead.all(scope)
      ),
      byes: freezeRows(byesRead.all(scope)),
    });
  }

  return Object.freeze({
    applyConfirmedSchedulePlan,
    applyWeekOneShiftPlan,
    findCommandResult,
    findIdempotency,
    readContext,
    readSchedule,
    readShiftContext,
  });
}

module.exports = {
  createSqliteMatchupScheduleRepository,
};
