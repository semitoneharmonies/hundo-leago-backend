const {
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
  EntryDraftSchedulePolicyError,
  UUID_PATTERN,
  entryDraftScheduleRequestHash,
  validateEntryDraftScheduleDraftId,
  validateEntryDraftScheduleExpectedVersion,
  validateEntryDraftScheduleFuture,
  validateEntryDraftScheduleIdempotencyKey,
  validateEntryDraftScheduleInput,
  validateEntryDraftScheduleLeagueId,
} = require(
  "../../../domain/drafts/entryDraftSchedulePolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
  parseSeasonRolloverOccurrenceKey,
} = require(
  "../../../domain/leagues/seasonRolloverJobPolicy"
);

const IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;
const ENTRY_DRAFT_SCHEDULE_RESULT_TYPE =
  "entry_draft_schedule";
const INITIAL_RESULT_CODE =
  "ENTRY_DRAFT_SCHEDULED";
const RESCHEDULE_RESULT_CODE =
  "ENTRY_DRAFT_RESCHEDULED";
const INITIAL_HTTP_STATUS = 201;
const RESCHEDULE_HTTP_STATUS = 200;

const REPOSITORY_METHODS = Object.freeze([
  "applySchedulePlan",
  "findIdempotency",
  "findScheduleResult",
  "readScheduleContext",
]);

const RESULT_KEYS = Object.freeze([
  "action",
  "entryDraftId",
  "entryDraftVersion",
  "jobRunId",
  "operationId",
  "rolloverBindingId",
  "rolloverBindingVersion",
  "rolloverOccurrenceId",
  "scheduledStartsAtMs",
]);

const CALENDAR_KEYS = Object.freeze([
  "fantasyPlayoffsEndAtMs",
  "fantasyPlayoffsStartAtMs",
  "firstWeekStartsAtMs",
  "nhlRegularSeasonEndsAtMs",
  "nhlRegularSeasonStartsAtMs",
]);
const COMPLETION_EVIDENCE_KEYS =
  Object.freeze([
    "competitionCompletedAtMs",
    "expectedMatchupCount",
    "finalizationId",
    "finalizedAtMs",
    "includedResultCount",
    "participantCount",
    "resultSetHash",
    "seasonVersion",
    "standingsRuleVersion",
    "standingsSnapshotId",
    "standingsSnapshotVersion",
  ]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

class EntryDraftScheduleServiceError extends Error {
  constructor(code, { details } = {}) {
    super("The Entry Draft schedule request could not be completed.");
    this.name = "EntryDraftScheduleServiceError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, options) {
  throw new EntryDraftScheduleServiceError(
    code,
    options
  );
}

function requireMethod(
  value,
  method,
  description
) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `Entry Draft scheduling requires ${description}`
    );
  }
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

function stableId(value) {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value)
  );
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function safeVersionIncrement(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return value + 1;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function secureId(secureRandom) {
  const value = secureRandom.id();
  if (!stableId(value)) {
    throw new TypeError(
      "Entry Draft scheduling requires canonical secure identifiers"
    );
  }
  return value;
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!safeTimestamp(value)) {
    throw new TypeError(
      "Entry Draft scheduling requires a safe UTC timestamp"
    );
  }
  return value;
}

function safeIdempotencyExpiry(nowMs) {
  if (
    nowMs >
    Number.MAX_SAFE_INTEGER -
      IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "Entry Draft scheduling requires a safe idempotency expiry"
    );
  }
  return nowMs + IDEMPOTENCY_LIFETIME_MS;
}

function exactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).sort().length ===
      keys.length &&
    Object.keys(value)
      .sort()
      .every((key, index) => key === keys[index])
  );
}

function safeCalendar(value) {
  if (!exactKeys(value, CALENDAR_KEYS)) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  const calendar = Object.freeze({
    fantasyPlayoffsEndAtMs:
      value.fantasyPlayoffsEndAtMs,
    fantasyPlayoffsStartAtMs:
      value.fantasyPlayoffsStartAtMs,
    firstWeekStartsAtMs:
      value.firstWeekStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      value.nhlRegularSeasonEndsAtMs,
    nhlRegularSeasonStartsAtMs:
      value.nhlRegularSeasonStartsAtMs,
  });
  if (
    Object.values(calendar).some(
      (timestamp) => !safeTimestamp(timestamp)
    ) ||
    !(
      calendar.nhlRegularSeasonStartsAtMs <=
        calendar.firstWeekStartsAtMs &&
      calendar.firstWeekStartsAtMs <
        calendar.fantasyPlayoffsStartAtMs &&
      calendar.fantasyPlayoffsStartAtMs <
        calendar.fantasyPlayoffsEndAtMs &&
      calendar.fantasyPlayoffsEndAtMs ===
        calendar.nhlRegularSeasonEndsAtMs
    )
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return calendar;
}

function safeRecipients(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some((userId) => !stableId(userId)) ||
    new Set(value).size !== value.length
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze([...value]);
}

function safeCompletionEvidence(
  value,
  {
    nhlRegularSeasonEndsAtMs,
    seasonVersion,
  }
) {
  if (
    !exactKeys(
      value,
      COMPLETION_EVIDENCE_KEYS
    ) ||
    !stableId(value.finalizationId) ||
    !stableId(value.standingsSnapshotId) ||
    !safeVersion(
      value.standingsSnapshotVersion
    ) ||
    value.seasonVersion !== seasonVersion ||
    !safeVersion(value.seasonVersion) ||
    !safeVersion(value.standingsRuleVersion) ||
    !DIGEST_PATTERN.test(
      value.resultSetHash || ""
    ) ||
    !Number.isSafeInteger(
      value.expectedMatchupCount
    ) ||
    value.expectedMatchupCount < 1 ||
    value.includedResultCount !==
      value.expectedMatchupCount ||
    !Number.isSafeInteger(
      value.participantCount
    ) ||
    value.participantCount < 2 ||
    value.competitionCompletedAtMs !==
      nhlRegularSeasonEndsAtMs ||
    !safeTimestamp(value.finalizedAtMs) ||
    value.finalizedAtMs <
      value.competitionCompletedAtMs
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    competitionCompletedAtMs:
      value.competitionCompletedAtMs,
    expectedMatchupCount:
      value.expectedMatchupCount,
    finalizationId: value.finalizationId,
    finalizedAtMs: value.finalizedAtMs,
    includedResultCount:
      value.includedResultCount,
    participantCount:
      value.participantCount,
    resultSetHash: value.resultSetHash,
    seasonVersion: value.seasonVersion,
    standingsRuleVersion:
      value.standingsRuleVersion,
    standingsSnapshotId:
      value.standingsSnapshotId,
    standingsSnapshotVersion:
      value.standingsSnapshotVersion,
  });
}

function safeSourceSeason(value, leagueId) {
  if (
    !isPlainObject(value) ||
    !stableId(value.id) ||
    value.leagueId !== leagueId ||
    !safeVersion(value.version) ||
    value.status !== "active" ||
    value.isCurrent !== true ||
    !safeTimestamp(
      value.nhlRegularSeasonEndsAtMs
    )
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    completionEvidence:
      safeCompletionEvidence(
        value.completionEvidence,
        {
          nhlRegularSeasonEndsAtMs:
            value.nhlRegularSeasonEndsAtMs,
          seasonVersion: value.version,
        }
      ),
    id: value.id,
    isCurrent: true,
    leagueId,
    nhlRegularSeasonEndsAtMs:
      value.nhlRegularSeasonEndsAtMs,
    status: "active",
    version: value.version,
  });
}

function safeTargetSeason(value, leagueId) {
  if (
    !isPlainObject(value) ||
    !stableId(value.id) ||
    value.leagueId !== leagueId ||
    !safeVersion(value.version) ||
    value.status !== "planned" ||
    typeof value.leagueTimezone !== "string" ||
    value.leagueTimezone.length < 1 ||
    value.leagueTimezone.length > 100 ||
    value.leagueTimezone !==
      value.leagueTimezone.trim()
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    calendar: safeCalendar(value.calendar),
    id: value.id,
    leagueId,
    leagueTimezone: value.leagueTimezone,
    status: "planned",
    version: value.version,
  });
}

function safeTargetSchedule(
  value,
  {
    firstWeekStartsAtMs,
    leagueId,
    targetSeasonId,
  }
) {
  if (
    !isPlainObject(value) ||
    !stableId(value.id) ||
    value.leagueId !== leagueId ||
    value.seasonId !== targetSeasonId ||
    !safeVersion(value.version) ||
    value.status !== "selected" ||
    value.complete !== true ||
    !stableId(value.weekOneMatchupWeekId) ||
    value.weekOneStartsAtMs !==
      firstWeekStartsAtMs
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    complete: true,
    id: value.id,
    leagueId,
    seasonId: targetSeasonId,
    status: "selected",
    version: value.version,
    weekOneMatchupWeekId:
      value.weekOneMatchupWeekId,
    weekOneStartsAtMs:
      value.weekOneStartsAtMs,
  });
}

function safeReadiness(value) {
  if (
    !isPlainObject(value) ||
    value.setupConfirmed !== true ||
    value.orderConfirmed !== true ||
    value.eligibilityConfirmed !== true ||
    value.pickOwnersConfirmed !== true
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    eligibilityConfirmed: true,
    orderConfirmed: true,
    pickOwnersConfirmed: true,
    setupConfirmed: true,
  });
}

function safeExistingBinding(
  value,
  {
    action,
    entryDraftVersion,
    entryDraftId,
    leagueId,
    nowMs,
    scheduledStartsAtMs,
    sourceSeason,
    targetSchedule,
    targetSeason,
  }
) {
  if (action === ENTRY_DRAFT_SCHEDULE_ACTION) {
    if (value !== null) {
      fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
    }
    return null;
  }
  if (
    !isPlainObject(value) ||
    !stableId(value.id) ||
    !safeVersion(value.version) ||
    value.leagueId !== leagueId ||
    value.entryDraftId !== entryDraftId ||
    value.sourceSeasonId !==
      sourceSeason.id ||
    value.targetSeasonId !==
      targetSeason.id ||
    value.targetScheduleId !==
      targetSchedule.id ||
    value.targetScheduleVersion !==
      targetSchedule.version ||
    value.weekOneMatchupWeekId !==
      targetSchedule.weekOneMatchupWeekId ||
    value.weekOneStartsAtMs !==
      targetSchedule.weekOneStartsAtMs ||
    value.sourceSeasonVersion !==
      sourceSeason.version ||
    value.targetSeasonVersion !==
      targetSeason.version ||
    value.entryDraftVersion !==
      entryDraftVersion ||
    value.status !== "scheduled" ||
    value.selectionGateStatus !== "locked" ||
    value.tradingGateStatus !== "locked" ||
    !stableId(value.occurrenceId) ||
    !safeTimestamp(value.scheduledStartsAtMs) ||
    value.scheduledStartsAtMs <= nowMs ||
    value.scheduledStartsAtMs ===
      scheduledStartsAtMs ||
    typeof value.occurrenceKey !== "string" ||
    !isPlainObject(value.job) ||
    !stableId(value.job.id) ||
    !safeVersion(value.job.version) ||
    value.job.jobType !==
      ENTRY_DRAFT_ROLLOVER_JOB_TYPE ||
    value.job.status !== "pending" ||
    value.job.occurrenceKey !==
      value.occurrenceKey ||
    value.job.scheduledForMs !==
      value.scheduledStartsAtMs ||
    value.job.startedAtMs !== null ||
    value.job.leaseOwner !== null ||
    value.job.leaseToken !== null ||
    value.job.leaseExpiresAtMs !== null ||
    value.job.completedAtMs !== null ||
    value.rolloverAttemptCount !== 0 ||
    value.rolloverId !== null
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  try {
    parseSeasonRolloverOccurrenceKey({
      leagueId,
      entryDraftId,
      rolloverOccurrenceId:
        value.occurrenceId,
      occurrenceKey: value.occurrenceKey,
      scheduledForMs:
        value.scheduledStartsAtMs,
    });
  } catch {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  return Object.freeze({
    id: value.id,
    entryDraftId,
    entryDraftVersion:
      value.entryDraftVersion,
    job: Object.freeze({
      completedAtMs: null,
      id: value.job.id,
      jobType:
        ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
      leaseExpiresAtMs: null,
      leaseOwner: null,
      leaseToken: null,
      occurrenceKey:
        value.occurrenceKey,
      scheduledForMs:
        value.scheduledStartsAtMs,
      startedAtMs: null,
      status: "pending",
      version: value.job.version,
    }),
    leagueId,
    occurrenceId: value.occurrenceId,
    occurrenceKey: value.occurrenceKey,
    rolloverAttemptCount: 0,
    rolloverId: null,
    scheduledStartsAtMs:
      value.scheduledStartsAtMs,
    selectionGateStatus: "locked",
    sourceSeasonId: sourceSeason.id,
    sourceSeasonVersion:
      sourceSeason.version,
    status: "scheduled",
    targetScheduleId:
      targetSchedule.id,
    targetScheduleVersion:
      targetSchedule.version,
    targetSeasonId: targetSeason.id,
    targetSeasonVersion:
      targetSeason.version,
    tradingGateStatus: "locked",
    version: value.version,
    weekOneMatchupWeekId:
      targetSchedule.weekOneMatchupWeekId,
    weekOneStartsAtMs:
      targetSchedule.weekOneStartsAtMs,
  });
}

function inspectScheduleContext({
  context,
  action,
  entryDraftId,
  expectedEntryDraftVersion,
  leagueId,
  nowMs,
  scheduledStartsAtMs,
}) {
  if (
    !isPlainObject(context) ||
    context.leagueId !== leagueId ||
    context.entryDraftId !== entryDraftId
  ) {
    fail("LEAGUE_NOT_FOUND");
  }
  if (
    !safeVersion(context.entryDraftVersion) ||
    !["setup", "lottery_ready", "ready"].includes(
      context.entryDraftStatus
    )
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  if (
    context.entryDraftVersion !==
    expectedEntryDraftVersion
  ) {
    fail(
      "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED",
      {
        details: {
          currentVersion:
            context.entryDraftVersion,
          refetch: true,
        },
      }
    );
  }
  if (
    action === ENTRY_DRAFT_SCHEDULE_ACTION
      ? !["setup", "lottery_ready"].includes(
          context.entryDraftStatus
        )
      : context.entryDraftStatus !== "ready"
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  const sourceSeason = safeSourceSeason(
    context.sourceSeason,
    leagueId
  );
  const targetSeason = safeTargetSeason(
    context.targetSeason,
    leagueId
  );
  if (sourceSeason.id === targetSeason.id) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  const targetSchedule = safeTargetSchedule(
    context.targetSchedule,
    {
      firstWeekStartsAtMs:
        targetSeason.calendar
          .firstWeekStartsAtMs,
      leagueId,
      targetSeasonId: targetSeason.id,
    }
  );
  if (
    scheduledStartsAtMs <
      sourceSeason
        .nhlRegularSeasonEndsAtMs ||
    scheduledStartsAtMs >=
      targetSeason.calendar
        .nhlRegularSeasonStartsAtMs
  ) {
    fail("ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED");
  }
  const readiness =
    safeReadiness(context.readiness);
  const scheduledBinding =
    safeExistingBinding(
      context.scheduledBinding,
      {
        action,
        entryDraftVersion:
          context.entryDraftVersion,
        entryDraftId,
        leagueId,
        nowMs,
        scheduledStartsAtMs,
        sourceSeason,
        targetSchedule,
        targetSeason,
      }
    );
  return Object.freeze({
    entryDraftId,
    entryDraftStatus:
      context.entryDraftStatus,
    entryDraftVersion:
      context.entryDraftVersion,
    leagueId,
    notificationRecipientUserIds:
      safeRecipients(
        context.notificationRecipientUserIds
      ),
    readiness,
    scheduledBinding,
    sourceSeason,
    targetSchedule,
    targetSeason,
  });
}

function safeScheduleResult(value) {
  if (
    !exactKeys(value, RESULT_KEYS) ||
    !stableId(value.operationId) ||
    !stableId(value.entryDraftId) ||
    !safeVersion(value.entryDraftVersion) ||
    !stableId(value.rolloverBindingId) ||
    !safeVersion(value.rolloverBindingVersion) ||
    !stableId(value.rolloverOccurrenceId) ||
    !safeTimestamp(value.scheduledStartsAtMs) ||
    !stableId(value.jobRunId) ||
    ![
      ENTRY_DRAFT_SCHEDULE_ACTION,
      ENTRY_DRAFT_RESCHEDULE_ACTION,
    ].includes(value.action)
  ) {
    fail(
      "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE"
    );
  }
  return Object.freeze({
    operationId: value.operationId,
    entryDraftId: value.entryDraftId,
    entryDraftVersion:
      value.entryDraftVersion,
    rolloverBindingId:
      value.rolloverBindingId,
    rolloverBindingVersion:
      value.rolloverBindingVersion,
    rolloverOccurrenceId:
      value.rolloverOccurrenceId,
    scheduledStartsAtMs:
      value.scheduledStartsAtMs,
    jobRunId: value.jobRunId,
    action: value.action,
  });
}

function internalResult(value, replayed) {
  const result = { ...safeScheduleResult(value) };
  const initial =
    result.action ===
    ENTRY_DRAFT_SCHEDULE_ACTION;
  for (const [name, metadata] of [
    ["httpStatus", initial
      ? INITIAL_HTTP_STATUS
      : RESCHEDULE_HTTP_STATUS],
    ["resultCode", initial
      ? INITIAL_RESULT_CODE
      : RESCHEDULE_RESULT_CODE],
    ["replayed", replayed],
  ]) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: false,
      value: metadata,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function inspectIdempotencyReplay({
  row,
  actorUserId,
  clientKey,
  leagueId,
  requestHash,
}) {
  if (
    !isPlainObject(row) ||
    row.leagueId !== leagueId ||
    row.actorUserId !== actorUserId ||
    row.operation !==
      ENTRY_DRAFT_SCHEDULE_OPERATION ||
    row.clientKey !== clientKey ||
    typeof row.requestHash !== "string"
  ) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  if (row.requestHash !== requestHash) {
    fail("IDEMPOTENCY_KEY_REUSED");
  }
  if (
    row.status !== "completed" ||
    row.resultType !==
      ENTRY_DRAFT_SCHEDULE_RESULT_TYPE ||
    !stableId(row.resultId) ||
    !safeTimestamp(row.completedAtMs)
  ) {
    fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
  }
  return row.resultId;
}

function safeAuthority(value, leagueId) {
  if (
    !isPlainObject(value) ||
    value.leagueId !== leagueId ||
    !stableId(value.actorUserId) ||
    !stableId(value.membershipId) ||
    ![
      "commissioner",
      "platform_administrator",
      "platform_administrator_as_commissioner",
    ].includes(value.authority)
  ) {
    throw new TypeError(
      "Entry Draft scheduling requires canonical league authority"
    );
  }
  return Object.freeze({
    actorUserId: value.actorUserId,
    authority:
      value.authority === "commissioner"
        ? "commissioner"
        : "platform_administrator_as_commissioner",
    leagueId,
    membershipId: value.membershipId,
  });
}

function safeAuditContext(value) {
  if (value === undefined || value === null) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      "Entry Draft scheduling requires safe audit context"
    );
  }
  return Object.freeze({ ...value });
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function createEntryDraftScheduleService({
  repositoryContext,
  leagueAuthorization,
  entryDraftScheduleRepository,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  requireMethod(
    leagueAuthorization,
    "requireCommissioner",
    "current league-commissioner or member-administrator authority"
  );
  for (const method of REPOSITORY_METHODS) {
    requireMethod(
      entryDraftScheduleRepository,
      method,
      `an Entry Draft scheduling repository with ${method}`
    );
  }
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function schedule({
    leagueId,
    entryDraftId,
    input,
    expectedEntryDraftVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId =
      validateEntryDraftScheduleLeagueId(
        leagueId
      );
    const canonicalEntryDraftId =
      validateEntryDraftScheduleDraftId(
        entryDraftId
      );
    const canonicalInput =
      validateEntryDraftScheduleInput(input);
    const expectedVersion =
      validateEntryDraftScheduleExpectedVersion(
        expectedEntryDraftVersion
      );
    const clientKey =
      validateEntryDraftScheduleIdempotencyKey(
        idempotencyKey
      );
    const requestHash =
      entryDraftScheduleRequestHash({
        leagueId: canonicalLeagueId,
        entryDraftId:
          canonicalEntryDraftId,
        input: canonicalInput,
      });
    const audit = safeAuditContext(auditContext);

    try {
      return repositoryContext.transaction(() => {
        const authority = safeAuthority(
          leagueAuthorization
            .requireCommissioner(
              authenticated,
              canonicalLeagueId
            ),
          canonicalLeagueId
        );
        const existing =
          entryDraftScheduleRepository
            .findIdempotency({
              leagueId: canonicalLeagueId,
              actorUserId:
                authority.actorUserId,
              operation:
                ENTRY_DRAFT_SCHEDULE_OPERATION,
              clientKey,
            });
        if (existing !== null) {
          const operationId =
            inspectIdempotencyReplay({
              row: existing,
              actorUserId:
                authority.actorUserId,
              clientKey,
              leagueId:
                canonicalLeagueId,
              requestHash,
            });
          const durable =
            entryDraftScheduleRepository
              .findScheduleResult({
                leagueId:
                  canonicalLeagueId,
                operationId,
              });
          return internalResult(durable, true);
        }

        const nowMs = safeNow(clock);
        const idempotencyExpiresAtMs =
          safeIdempotencyExpiry(nowMs);
        validateEntryDraftScheduleFuture({
          scheduledStartsAtMs:
            canonicalInput
              .scheduledStartsAtMs,
          nowMs,
        });
        const context = inspectScheduleContext({
          context:
            entryDraftScheduleRepository
              .readScheduleContext({
                leagueId:
                  canonicalLeagueId,
                entryDraftId:
                  canonicalEntryDraftId,
              }),
          action: canonicalInput.action,
          entryDraftId:
            canonicalEntryDraftId,
          expectedEntryDraftVersion:
            expectedVersion,
          leagueId: canonicalLeagueId,
          nowMs,
          scheduledStartsAtMs:
            canonicalInput
              .scheduledStartsAtMs,
        });
        const nextEntryDraftVersion =
          safeVersionIncrement(
            context.entryDraftVersion
          );
        const nextRolloverBindingVersion =
          safeVersionIncrement(
            context.scheduledBinding?.version ??
              0
          );

        const operationId =
          secureId(secureRandom);
        const rolloverBindingId =
          context.scheduledBinding?.id ||
          secureId(secureRandom);
        const rolloverOccurrenceId =
          secureId(secureRandom);
        const jobRunId =
          secureId(secureRandom);
        const draftEventId =
          secureId(secureRandom);
        const auditEventId =
          secureId(secureRandom);
        const outboxEventId =
          secureId(secureRandom);
        const notificationIds =
          Object.freeze(
            context
              .notificationRecipientUserIds
              .map((userId) =>
                Object.freeze({
                  id: secureId(secureRandom),
                  userId,
                })
              )
          );
        const occurrenceKey =
          buildSeasonRolloverOccurrenceKey({
            leagueId: canonicalLeagueId,
            entryDraftId:
              canonicalEntryDraftId,
            rolloverOccurrenceId,
            scheduledForMs:
              canonicalInput
                .scheduledStartsAtMs,
          });
        const result = Object.freeze({
          operationId,
          entryDraftId:
            canonicalEntryDraftId,
          entryDraftVersion:
            nextEntryDraftVersion,
          rolloverBindingId,
          rolloverBindingVersion:
            nextRolloverBindingVersion,
          rolloverOccurrenceId,
          scheduledStartsAtMs:
            canonicalInput
              .scheduledStartsAtMs,
          jobRunId,
          action: canonicalInput.action,
        });
        const plan = Object.freeze({
          action: canonicalInput.action,
          actor: authority,
          auditContext: audit,
          entryDraft: Object.freeze({
            id: canonicalEntryDraftId,
            status:
              context.entryDraftStatus,
            expectedVersion:
              context.entryDraftVersion,
          }),
          idempotency: Object.freeze({
            clientKey,
            expiresAtMs:
              idempotencyExpiresAtMs,
            operation:
              ENTRY_DRAFT_SCHEDULE_OPERATION,
            operationId,
            requestHash,
            resultType:
              ENTRY_DRAFT_SCHEDULE_RESULT_TYPE,
          }),
          ids: Object.freeze({
            auditEventId,
            draftEventId,
            jobRunId,
            notificationIds,
            outboxEventId,
            rolloverBindingId,
            rolloverOccurrenceId,
          }),
          job: Object.freeze({
            jobType:
              ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
            occurrenceKey,
            scheduledForMs:
              canonicalInput
                .scheduledStartsAtMs,
          }),
          leagueId: canonicalLeagueId,
          nowMs,
          reason: canonicalInput.reason,
          replacement:
            context.scheduledBinding,
          result,
          serverBinding: Object.freeze({
            sourceSeason:
              context.sourceSeason,
            targetSeason:
              context.targetSeason,
            targetSchedule:
              context.targetSchedule,
          }),
        });

        const applied =
          entryDraftScheduleRepository
            .applySchedulePlan(plan);
        if (
          !isPlainObject(applied) ||
          applied.applied !== true
        ) {
          fail(
            "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE"
          );
        }
        const durable = safeScheduleResult(
          entryDraftScheduleRepository
            .findScheduleResult({
              leagueId:
                canonicalLeagueId,
              operationId,
            })
        );
        if (
          JSON.stringify(durable) !==
          JSON.stringify(result)
        ) {
          fail(
            "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE"
          );
        }
        return internalResult(durable, false);
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            EntryDraftScheduleServiceError ||
          candidate instanceof
            EntryDraftSchedulePolicyError ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) {
        throw applicationError;
      }
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_VERSION_CONFLICT"
        )
      ) {
        fail(
          "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED",
          {
            details: {
              currentVersion: null,
              refetch: true,
            },
          }
        );
      }
      const constraint = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_CONSTRAINT"
      );
      if (
        constraint?.details?.tableName ===
        "idempotency_requests"
      ) {
        fail(
          "IDEMPOTENCY_REQUEST_UNAVAILABLE"
        );
      }
      if (
        constraint ||
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_RECORD_NOT_FOUND"
        )
      ) {
        fail(
          "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
        );
      }
      throw error;
    }
  }

  return Object.freeze({ schedule });
}

module.exports = {
  ENTRY_DRAFT_SCHEDULE_RESULT_TYPE,
  IDEMPOTENCY_LIFETIME_MS,
  INITIAL_HTTP_STATUS,
  INITIAL_RESULT_CODE,
  REPOSITORY_METHODS,
  RESCHEDULE_HTTP_STATUS,
  RESCHEDULE_RESULT_CODE,
  RESULT_KEYS,
  EntryDraftScheduleServiceError,
  createEntryDraftScheduleService,
  safeScheduleResult,
};
