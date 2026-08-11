const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
} = require(
  "../../src/domain/drafts/entryDraftSchedulePolicy"
);
const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  buildSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);
const {
  ENTRY_DRAFT_SCHEDULE_RESULT_TYPE,
  IDEMPOTENCY_LIFETIME_MS,
  INITIAL_HTTP_STATUS,
  INITIAL_RESULT_CODE,
  RESCHEDULE_HTTP_STATUS,
  RESCHEDULE_RESULT_CODE,
  RESULT_KEYS,
  EntryDraftScheduleServiceError,
  createEntryDraftScheduleService,
} = require(
  "../../src/application/services/drafts/createEntryDraftScheduleService"
);

const NOW_MS = Date.parse(
  "2026-07-29T16:00:00.000Z"
);
const DAY_MS = 24 * 60 * 60 * 1000;
const STARTS_AT_MS = NOW_MS + 7 * DAY_MS;
const SOURCE_SEASON_ENDS_AT_MS =
  NOW_MS - 60 * DAY_MS;
const LEAGUE_ID = id(1);
const ENTRY_DRAFT_ID = id(2);
const SOURCE_SEASON_ID = id(3);
const TARGET_SEASON_ID = id(4);
const TARGET_SCHEDULE_ID = id(5);
const WEEK_ONE_MATCHUP_WEEK_ID = id(11);
const FINALIZATION_ID = id(12);
const STANDINGS_SNAPSHOT_ID = id(13);
const COMMISSIONER_USER_ID = id(6);
const COMMISSIONER_MEMBERSHIP_ID = id(7);
const MEMBER_ADMIN_USER_ID = id(8);
const MEMBER_ADMIN_MEMBERSHIP_ID = id(9);
const OTHER_MEMBER_USER_ID = id(10);

function id(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function scheduleInput(
  overrides = {}
) {
  return {
    action: ENTRY_DRAFT_SCHEDULE_ACTION,
    scheduledStartsAtMs: STARTS_AT_MS,
    confirmation:
      ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
    ...overrides,
  };
}

function rescheduleInput(
  overrides = {}
) {
  return {
    action: ENTRY_DRAFT_RESCHEDULE_ACTION,
    scheduledStartsAtMs:
      STARTS_AT_MS + DAY_MS,
    confirmation:
      ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
    reason: "Move to the confirmed league date.",
    ...overrides,
  };
}

function rescheduleCommand(
  overrides = {}
) {
  return command({
    input: rescheduleInput(),
    expectedEntryDraftVersion: 5,
    ...overrides,
  });
}

function scheduledBinding(
  overrides = {}
) {
  const occurrenceId = id(30);
  const scheduledStartsAtMs =
    STARTS_AT_MS;
  const occurrenceKey =
    buildSeasonRolloverOccurrenceKey({
      leagueId: LEAGUE_ID,
      entryDraftId: ENTRY_DRAFT_ID,
      rolloverOccurrenceId: occurrenceId,
      scheduledForMs:
        scheduledStartsAtMs,
    });
  const base = {
    id: id(31),
    version: 2,
    leagueId: LEAGUE_ID,
    entryDraftId: ENTRY_DRAFT_ID,
    entryDraftVersion: 5,
    sourceSeasonId: SOURCE_SEASON_ID,
    sourceSeasonVersion: 11,
    targetSeasonId: TARGET_SEASON_ID,
    targetSeasonVersion: 3,
    targetScheduleId: TARGET_SCHEDULE_ID,
    targetScheduleVersion: 5,
    weekOneMatchupWeekId:
      WEEK_ONE_MATCHUP_WEEK_ID,
    weekOneStartsAtMs:
      NOW_MS + 60 * DAY_MS,
    status: "scheduled",
    selectionGateStatus: "locked",
    tradingGateStatus: "locked",
    occurrenceId,
    occurrenceKey,
    scheduledStartsAtMs,
    rolloverAttemptCount: 0,
    rolloverId: null,
    job: {
      id: id(32),
      version: 1,
      jobType:
        ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
      status: "pending",
      occurrenceKey,
      scheduledForMs:
        scheduledStartsAtMs,
      startedAtMs: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtMs: null,
      completedAtMs: null,
    },
  };
  const next = {
    ...base,
    ...overrides,
    job: {
      ...base.job,
      ...(overrides.job || {}),
    },
  };
  if (
    overrides.scheduledStartsAtMs !==
      undefined &&
    overrides.occurrenceKey === undefined
  ) {
    next.occurrenceKey =
      buildSeasonRolloverOccurrenceKey({
        leagueId: LEAGUE_ID,
        entryDraftId: ENTRY_DRAFT_ID,
        rolloverOccurrenceId:
          next.occurrenceId,
        scheduledForMs:
          next.scheduledStartsAtMs,
      });
    next.job.occurrenceKey =
      next.occurrenceKey;
    next.job.scheduledForMs =
      next.scheduledStartsAtMs;
  }
  return next;
}

function baseContext(
  overrides = {}
) {
  const context = {
    leagueId: LEAGUE_ID,
    entryDraftId: ENTRY_DRAFT_ID,
    entryDraftVersion: 4,
    entryDraftStatus: "lottery_ready",
    sourceSeason: {
      id: SOURCE_SEASON_ID,
      leagueId: LEAGUE_ID,
      version: 11,
      status: "active",
      isCurrent: true,
      nhlRegularSeasonEndsAtMs:
        SOURCE_SEASON_ENDS_AT_MS,
      completionEvidence: {
        competitionCompletedAtMs:
          SOURCE_SEASON_ENDS_AT_MS,
        finalizationId: FINALIZATION_ID,
        standingsSnapshotId:
          STANDINGS_SNAPSHOT_ID,
        standingsSnapshotVersion: 1,
        seasonVersion: 11,
        standingsRuleVersion: 1,
        resultSetHash: "a".repeat(64),
        expectedMatchupCount: 72,
        includedResultCount: 72,
        participantCount: 10,
        finalizedAtMs:
          SOURCE_SEASON_ENDS_AT_MS +
          DAY_MS,
      },
    },
    targetSeason: {
      id: TARGET_SEASON_ID,
      leagueId: LEAGUE_ID,
      version: 3,
      status: "planned",
      leagueTimezone: "America/Vancouver",
      calendar: {
        nhlRegularSeasonStartsAtMs:
          NOW_MS + 60 * DAY_MS,
        firstWeekStartsAtMs:
          NOW_MS + 60 * DAY_MS,
        fantasyPlayoffsStartAtMs:
          NOW_MS + 200 * DAY_MS,
        fantasyPlayoffsEndAtMs:
          NOW_MS + 228 * DAY_MS,
        nhlRegularSeasonEndsAtMs:
          NOW_MS + 228 * DAY_MS,
      },
    },
    targetSchedule: {
      id: TARGET_SCHEDULE_ID,
      leagueId: LEAGUE_ID,
      seasonId: TARGET_SEASON_ID,
      version: 5,
      status: "selected",
      complete: true,
      weekOneMatchupWeekId:
        WEEK_ONE_MATCHUP_WEEK_ID,
      weekOneStartsAtMs:
        NOW_MS + 60 * DAY_MS,
    },
    readiness: {
      setupConfirmed: true,
      orderConfirmed: true,
      eligibilityConfirmed: true,
      pickOwnersConfirmed: true,
    },
    scheduledBinding: null,
    notificationRecipientUserIds: [
      COMMISSIONER_USER_ID,
      OTHER_MEMBER_USER_ID,
    ],
  };
  return {
    ...context,
    ...overrides,
    sourceSeason: {
      ...context.sourceSeason,
      ...(overrides.sourceSeason || {}),
      completionEvidence: {
        ...context.sourceSeason
          .completionEvidence,
        ...(overrides.sourceSeason
          ?.completionEvidence || {}),
      },
    },
    targetSeason: {
      ...context.targetSeason,
      ...(overrides.targetSeason || {}),
      calendar: {
        ...context.targetSeason.calendar,
        ...(overrides.targetSeason
          ?.calendar || {}),
      },
    },
    targetSchedule: {
      ...context.targetSchedule,
      ...(overrides.targetSchedule || {}),
    },
    readiness: {
      ...context.readiness,
      ...(overrides.readiness || {}),
    },
    scheduledBinding:
      overrides.scheduledBinding === undefined
        ? context.scheduledBinding
        : overrides.scheduledBinding,
  };
}

function expectedReplayResult(
  overrides = {}
) {
  return {
    operationId: id(60),
    entryDraftId: ENTRY_DRAFT_ID,
    entryDraftVersion: 5,
    rolloverBindingId: id(61),
    rolloverBindingVersion: 1,
    rolloverOccurrenceId: id(62),
    scheduledStartsAtMs: STARTS_AT_MS,
    jobRunId: id(63),
    action: ENTRY_DRAFT_SCHEDULE_ACTION,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const events = [];
  const plans = [];
  const durableResults = new Map();
  const state = {
    applied: [],
    durableResults,
  };
  let sequence = 100;
  const authority =
    overrides.authority || {
      leagueId: LEAGUE_ID,
      actorUserId:
        COMMISSIONER_USER_ID,
      membershipId:
        COMMISSIONER_MEMBERSHIP_ID,
      authority: "commissioner",
    };
  const repository = {
    findIdempotency(command) {
      events.push({
        name: "findIdempotency",
        command,
      });
      return overrides.idempotency ?? null;
    },
    findScheduleResult(command) {
      events.push({
        name: "findScheduleResult",
        command,
      });
      if (
        overrides.replayResult !==
        undefined
      ) {
        return overrides.replayResult;
      }
      return (
        durableResults.get(
          command.operationId
        ) || null
      );
    },
    readScheduleContext(command) {
      events.push({
        name: "readScheduleContext",
        command,
      });
      if (overrides.contextError) {
        throw overrides.contextError;
      }
      return overrides.context === undefined
        ? baseContext()
        : overrides.context;
    },
    applySchedulePlan(plan) {
      events.push({
        name: "applySchedulePlan",
      });
      plans.push(plan);
      state.applied.push(plan.result.operationId);
      if (overrides.applyError) {
        throw overrides.applyError;
      }
      const persisted =
        overrides.persistedResult ||
        plan.result;
      durableResults.set(
        plan.result.operationId,
        persisted
      );
      return overrides.applyResult || {
        applied: true,
      };
    },
  };
  const repositoryContext = {
    transaction(callback) {
      events.push({ name: "transaction.begin" });
      const appliedSnapshot = [
        ...state.applied,
      ];
      const resultSnapshot = new Map(
        durableResults
      );
      try {
        const result = callback();
        events.push({
          name: "transaction.commit",
        });
        return result;
      } catch (error) {
        state.applied = appliedSnapshot;
        durableResults.clear();
        for (const [key, value] of resultSnapshot) {
          durableResults.set(key, value);
        }
        events.push({
          name: "transaction.rollback",
        });
        throw error;
      }
    },
  };
  const leagueAuthorization = {
    requireCommissioner(
      authenticated,
      leagueId
    ) {
      events.push({
        name: "requireCommissioner",
        authenticated,
        leagueId,
      });
      if (overrides.authorityError) {
        throw overrides.authorityError;
      }
      return authority;
    },
  };
  const clock = {
    nowMs() {
      events.push({ name: "clock.nowMs" });
      if (overrides.clockError) {
        throw overrides.clockError;
      }
      return overrides.nowMs ?? NOW_MS;
    },
  };
  const secureRandom = {
    id() {
      events.push({ name: "secureRandom.id" });
      sequence += 1;
      return id(sequence);
    },
  };
  const service =
    createEntryDraftScheduleService({
      repositoryContext,
      leagueAuthorization,
      entryDraftScheduleRepository:
        repository,
      clock,
      secureRandom,
    });
  return {
    events,
    plans,
    repository,
    service,
    state,
  };
}

function command(overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    entryDraftId: ENTRY_DRAFT_ID,
    input: scheduleInput(),
    expectedEntryDraftVersion: 4,
    idempotencyKey: "schedule-entry-draft",
    authenticated: {
      valid: true,
      user: {
        id: COMMISSIONER_USER_ID,
      },
      session: {
        id: id(70),
        userId: COMMISSIONER_USER_ID,
      },
    },
    auditContext: {
      requestCorrelationId: id(71),
      networkKeyVersion: 1,
      networkMetadataDigest: "a".repeat(64),
    },
    ...overrides,
  };
}

function assertServiceError(
  callback,
  code
) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function eventNames(evidence) {
  return evidence.events.map(
    ({ name }) => name
  );
}

describe("T-037 Entry Draft scheduling service", () => {
  test("schedules once as commissioner with a 201 result and one server-derived atomic plan", () => {
    const evidence = harness();
    const result = evidence.service.schedule(
      command()
    );

    assert.deepEqual(
      Object.keys(result).sort(),
      [...RESULT_KEYS]
    );
    assert.equal(result.action, "schedule");
    assert.equal(result.entryDraftVersion, 5);
    assert.equal(
      result.rolloverBindingVersion,
      1
    );
    assert.equal(
      result.scheduledStartsAtMs,
      STARTS_AT_MS
    );
    assert.equal(
      result.httpStatus,
      INITIAL_HTTP_STATUS
    );
    assert.equal(
      result.resultCode,
      INITIAL_RESULT_CODE
    );
    assert.equal(result.replayed, false);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(
        result,
        "httpStatus"
      ),
      {
        configurable: false,
        enumerable: false,
        value: 201,
        writable: false,
      }
    );

    assert.equal(evidence.plans.length, 1);
    const [plan] = evidence.plans;
    assert.equal(Object.isFrozen(plan), true);
    assert.deepEqual(plan.actor, {
      leagueId: LEAGUE_ID,
      actorUserId:
        COMMISSIONER_USER_ID,
      membershipId:
        COMMISSIONER_MEMBERSHIP_ID,
      authority: "commissioner",
    });
    assert.deepEqual(plan.entryDraft, {
      id: ENTRY_DRAFT_ID,
      status: "lottery_ready",
      expectedVersion: 4,
    });
    assert.deepEqual(
      plan.serverBinding,
      {
        sourceSeason: {
          id: SOURCE_SEASON_ID,
          leagueId: LEAGUE_ID,
          version: 11,
          status: "active",
          isCurrent: true,
          nhlRegularSeasonEndsAtMs:
            SOURCE_SEASON_ENDS_AT_MS,
          completionEvidence: {
            competitionCompletedAtMs:
              SOURCE_SEASON_ENDS_AT_MS,
            finalizationId:
              FINALIZATION_ID,
            standingsSnapshotId:
              STANDINGS_SNAPSHOT_ID,
            standingsSnapshotVersion: 1,
            seasonVersion: 11,
            standingsRuleVersion: 1,
            resultSetHash: "a".repeat(64),
            expectedMatchupCount: 72,
            includedResultCount: 72,
            participantCount: 10,
            finalizedAtMs:
              SOURCE_SEASON_ENDS_AT_MS +
              DAY_MS,
          },
        },
        targetSeason: {
          id: TARGET_SEASON_ID,
          leagueId: LEAGUE_ID,
          version: 3,
          status: "planned",
          leagueTimezone:
            "America/Vancouver",
          calendar: {
            nhlRegularSeasonStartsAtMs:
              NOW_MS + 60 * DAY_MS,
            firstWeekStartsAtMs:
              NOW_MS + 60 * DAY_MS,
            fantasyPlayoffsStartAtMs:
              NOW_MS + 200 * DAY_MS,
            fantasyPlayoffsEndAtMs:
              NOW_MS + 228 * DAY_MS,
            nhlRegularSeasonEndsAtMs:
              NOW_MS + 228 * DAY_MS,
          },
        },
        targetSchedule: {
          id: TARGET_SCHEDULE_ID,
          leagueId: LEAGUE_ID,
          seasonId: TARGET_SEASON_ID,
          version: 5,
          status: "selected",
          complete: true,
          weekOneMatchupWeekId:
            WEEK_ONE_MATCHUP_WEEK_ID,
          weekOneStartsAtMs:
            NOW_MS + 60 * DAY_MS,
        },
      }
    );
    assert.equal(plan.replacement, null);
    assert.equal(
      plan.job.jobType,
      ENTRY_DRAFT_ROLLOVER_JOB_TYPE
    );
    assert.equal(
      plan.job.scheduledForMs,
      STARTS_AT_MS
    );
    assert.match(
      plan.job.occurrenceKey,
      new RegExp(
        `^${ENTRY_DRAFT_ROLLOVER_JOB_TYPE}:`
      )
    );
    assert.equal(
      plan.idempotency.operation,
      ENTRY_DRAFT_SCHEDULE_OPERATION
    );
    assert.equal(
      plan.idempotency.resultType,
      ENTRY_DRAFT_SCHEDULE_RESULT_TYPE
    );
    assert.match(
      plan.idempotency.requestHash,
      /^[0-9a-f]{64}$/
    );
    assert.equal(
      plan.idempotency.expiresAtMs,
      NOW_MS + IDEMPOTENCY_LIFETIME_MS
    );
    assert.deepEqual(
      plan.ids.notificationIds.map(
        ({ userId }) => userId
      ),
      [
        COMMISSIONER_USER_ID,
        OTHER_MEMBER_USER_ID,
      ]
    );
    assert.deepEqual(
      eventNames(evidence).filter(
        (name) =>
          ![
            "secureRandom.id",
          ].includes(name)
      ),
      [
        "transaction.begin",
        "requireCommissioner",
        "findIdempotency",
        "clock.nowMs",
        "readScheduleContext",
        "applySchedulePlan",
        "findScheduleResult",
        "transaction.commit",
      ]
    );
  });

  test("reschedules once as an inherited member platform administrator and returns 200", () => {
    const prior = scheduledBinding();
    const evidence = harness({
      authority: {
        leagueId: LEAGUE_ID,
        actorUserId:
          MEMBER_ADMIN_USER_ID,
        membershipId:
          MEMBER_ADMIN_MEMBERSHIP_ID,
        authority:
          "platform_administrator",
      },
      context: baseContext({
        entryDraftVersion: 5,
        entryDraftStatus: "ready",
        scheduledBinding: prior,
      }),
    });
    const input = rescheduleInput();
    const result = evidence.service.schedule(
      rescheduleCommand({
        input,
        authenticated: {
          valid: true,
          user: {
            id: MEMBER_ADMIN_USER_ID,
          },
          session: {
            id: id(72),
            userId:
              MEMBER_ADMIN_USER_ID,
          },
        },
      })
    );

    assert.equal(
      result.httpStatus,
      RESCHEDULE_HTTP_STATUS
    );
    assert.equal(
      result.resultCode,
      RESCHEDULE_RESULT_CODE
    );
    assert.equal(result.replayed, false);
    assert.equal(
      result.rolloverBindingId,
      prior.id
    );
    assert.equal(
      result.rolloverBindingVersion,
      prior.version + 1
    );
    assert.notEqual(
      result.rolloverOccurrenceId,
      prior.occurrenceId
    );
    assert.notEqual(
      result.jobRunId,
      prior.job.id
    );
    assert.equal(
      result.scheduledStartsAtMs,
      input.scheduledStartsAtMs
    );
    const [plan] = evidence.plans;
    assert.equal(
      plan.actor.authority,
      "platform_administrator_as_commissioner"
    );
    assert.deepEqual(
      plan.replacement,
      prior
    );
    assert.equal(
      plan.reason,
      input.reason
    );
  });

  test("authorizes before replay and replays before time, context, version, or identifier work", () => {
    const replay = expectedReplayResult();
    const input = scheduleInput({
      scheduledStartsAtMs: NOW_MS,
    });
    const requestHash = require(
      "../../src/domain/drafts/entryDraftSchedulePolicy"
    ).entryDraftScheduleRequestHash({
      leagueId: LEAGUE_ID,
      entryDraftId: ENTRY_DRAFT_ID,
      input,
    });
    const evidence = harness({
      idempotency: {
        leagueId: LEAGUE_ID,
        actorUserId:
          COMMISSIONER_USER_ID,
        operation:
          ENTRY_DRAFT_SCHEDULE_OPERATION,
        clientKey: "schedule-entry-draft",
        requestHash,
        status: "completed",
        resultType:
          ENTRY_DRAFT_SCHEDULE_RESULT_TYPE,
        resultId: replay.operationId,
        completedAtMs: NOW_MS - 1,
      },
      replayResult: replay,
      clockError: new Error(
        "replay must not read time"
      ),
      contextError: new Error(
        "replay must not read mutable context"
      ),
    });
    const result = evidence.service.schedule(
      command({
        input,
        expectedEntryDraftVersion: 999,
      })
    );

    assert.deepEqual(
      { ...result },
      replay
    );
    assert.equal(result.replayed, true);
    assert.equal(result.httpStatus, 201);
    assert.deepEqual(
      eventNames(evidence),
      [
        "transaction.begin",
        "requireCommissioner",
        "findIdempotency",
        "findScheduleResult",
        "transaction.commit",
      ]
    );
    assert.equal(evidence.plans.length, 0);

    const denied = new Error(
      "current commissioner required"
    );
    denied.code =
      "LEAGUE_COMMISSIONER_REQUIRED";
    const noAuthority = harness({
      authorityError: denied,
    });
    assertServiceError(
      () =>
        noAuthority.service.schedule(
          command({
            input,
          })
        ),
      "LEAGUE_COMMISSIONER_REQUIRED"
    );
    assert.deepEqual(
      eventNames(noAuthority),
      [
        "transaction.begin",
        "requireCommissioner",
        "transaction.rollback",
      ]
    );
  });

  test("rejects changed-input key reuse before every mutable check", () => {
    const evidence = harness({
      idempotency: {
        leagueId: LEAGUE_ID,
        actorUserId:
          COMMISSIONER_USER_ID,
        operation:
          ENTRY_DRAFT_SCHEDULE_OPERATION,
        clientKey: "schedule-entry-draft",
        requestHash: "f".repeat(64),
        status: "completed",
        resultType:
          ENTRY_DRAFT_SCHEDULE_RESULT_TYPE,
        resultId: id(80),
        completedAtMs: NOW_MS,
      },
      clockError: new Error(
        "key reuse must not read time"
      ),
      contextError: new Error(
        "key reuse must not read context"
      ),
    });
    assertServiceError(
      () =>
        evidence.service.schedule(
          command()
        ),
      "IDEMPOTENCY_KEY_REUSED"
    );
    assert.deepEqual(
      eventNames(evidence),
      [
        "transaction.begin",
        "requireCommissioner",
        "findIdempotency",
        "transaction.rollback",
      ]
    );
  });

  test("requires a future start and current draft version without writing", () => {
    const due = harness();
    assertServiceError(
      () =>
        due.service.schedule(
          command({
            input: scheduleInput({
              scheduledStartsAtMs: NOW_MS,
            }),
          })
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE"
    );
    assert.equal(due.plans.length, 0);
    assert.equal(
      eventNames(due).includes(
        "readScheduleContext"
      ),
      false
    );

    const stale = harness();
    assert.throws(
      () =>
        stale.service.schedule(
          command({
            expectedEntryDraftVersion: 3,
          })
        ),
      (error) => {
        assert.ok(
          error instanceof
            EntryDraftScheduleServiceError
        );
        assert.equal(
          error.code,
          "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED"
        );
        assert.deepEqual(error.details, {
          currentVersion: 4,
          refetch: true,
        });
        return true;
      }
    );
    assert.equal(stale.plans.length, 0);
  });

  test("requires the Entry Draft start inside the source-end and target-start window", () => {
    const futureSourceEnd =
      NOW_MS + 10 * DAY_MS;
    const beforeSourceEnd = harness({
      context: baseContext({
        sourceSeason: {
          nhlRegularSeasonEndsAtMs:
            futureSourceEnd,
          completionEvidence: {
            competitionCompletedAtMs:
              futureSourceEnd,
            finalizedAtMs:
              futureSourceEnd + DAY_MS,
          },
        },
      }),
    });
    assertServiceError(
      () =>
        beforeSourceEnd.service.schedule(
          command({
            input: scheduleInput({
              scheduledStartsAtMs:
                NOW_MS + 5 * DAY_MS,
            }),
          })
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.equal(
      beforeSourceEnd.plans.length,
      0
    );

    const atTargetStart = harness();
    assertServiceError(
      () =>
        atTargetStart.service.schedule(
          command({
            input: scheduleInput({
              scheduledStartsAtMs:
                NOW_MS + 60 * DAY_MS,
            }),
          })
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.equal(
      atTargetStart.plans.length,
      0
    );
  });

  test("rejects an idempotency-expiry timestamp overflow before context or identifier work", () => {
    const overflowNow =
      Number.MAX_SAFE_INTEGER -
      IDEMPOTENCY_LIFETIME_MS +
      1;
    const evidence = harness({
      nowMs: overflowNow,
    });
    assert.throws(
      () =>
        evidence.service.schedule(
          command({
            input: scheduleInput({
              scheduledStartsAtMs:
                overflowNow + 1,
            }),
          })
        ),
      {
        name: "TypeError",
        message:
          "Entry Draft scheduling requires a safe idempotency expiry",
      }
    );
    assert.deepEqual(
      eventNames(evidence),
      [
        "transaction.begin",
        "requireCommissioner",
        "findIdempotency",
        "clock.nowMs",
        "transaction.rollback",
      ]
    );
    assert.equal(evidence.plans.length, 0);
  });

  test("rejects exhausted draft and binding versions before identifier generation or writes", () => {
    const exhaustedDraft = harness({
      context: baseContext({
        entryDraftVersion:
          Number.MAX_SAFE_INTEGER,
      }),
    });
    assertServiceError(
      () =>
        exhaustedDraft.service.schedule(
          command({
            expectedEntryDraftVersion:
              Number.MAX_SAFE_INTEGER,
          })
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.equal(
      eventNames(exhaustedDraft).includes(
        "secureRandom.id"
      ),
      false
    );
    assert.equal(
      exhaustedDraft.plans.length,
      0
    );

    const exhaustedBinding = harness({
      context: baseContext({
        entryDraftVersion: 5,
        entryDraftStatus: "ready",
        scheduledBinding:
          scheduledBinding({
            version:
              Number.MAX_SAFE_INTEGER,
          }),
      }),
    });
    assertServiceError(
      () =>
        exhaustedBinding.service.schedule(
          rescheduleCommand()
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.equal(
      eventNames(exhaustedBinding).includes(
        "secureRandom.id"
      ),
      false
    );
    assert.equal(
      exhaustedBinding.plans.length,
      0
    );
  });

  test("replaces only one untouched future scheduled occurrence", () => {
    const invalidBindings = [
      scheduledBinding({
        leagueId: id(81),
      }),
      scheduledBinding({
        entryDraftId: id(82),
      }),
      scheduledBinding({
        entryDraftVersion: 4,
      }),
      scheduledBinding({
        sourceSeasonId: id(83),
      }),
      scheduledBinding({
        sourceSeasonVersion: 12,
      }),
      scheduledBinding({
        targetSeasonId: id(84),
      }),
      scheduledBinding({
        targetSeasonVersion: 4,
      }),
      scheduledBinding({
        targetScheduleId: id(85),
      }),
      scheduledBinding({
        targetScheduleVersion: 6,
      }),
      scheduledBinding({
        weekOneMatchupWeekId: id(86),
      }),
      scheduledBinding({
        weekOneStartsAtMs:
          NOW_MS + 61 * DAY_MS,
      }),
      scheduledBinding({
        selectionGateStatus: "open",
      }),
      scheduledBinding({
        tradingGateStatus: "open",
      }),
      scheduledBinding({
        status: "blocked",
      }),
      scheduledBinding({
        scheduledStartsAtMs: NOW_MS,
      }),
      scheduledBinding({
        rolloverAttemptCount: 1,
      }),
      scheduledBinding({
        rolloverId: id(81),
      }),
      scheduledBinding({
        job: {
          status: "leased",
          leaseOwner: "worker-1",
          leaseToken: id(82),
          leaseExpiresAtMs:
            NOW_MS + DAY_MS,
        },
      }),
      scheduledBinding({
        job: {
          status: "running",
          startedAtMs: NOW_MS,
        },
      }),
      scheduledBinding({
        job: {
          status: "succeeded",
          completedAtMs: NOW_MS,
        },
      }),
    ];
    for (const binding of invalidBindings) {
      const evidence = harness({
        context: baseContext({
          entryDraftVersion: 5,
          entryDraftStatus: "ready",
          scheduledBinding: binding,
        }),
      });
      assertServiceError(
        () =>
          evidence.service.schedule(
            rescheduleCommand()
          ),
        "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
      );
      assert.equal(
        evidence.plans.length,
        0
      );
    }

    const unchanged = harness({
      context: baseContext({
        entryDraftVersion: 5,
        entryDraftStatus: "ready",
        scheduledBinding:
          scheduledBinding(),
      }),
    });
    assertServiceError(
      () =>
        unchanged.service.schedule(
          rescheduleCommand({
            input: rescheduleInput({
              scheduledStartsAtMs:
                STARTS_AT_MS,
            }),
          })
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.equal(unchanged.plans.length, 0);
  });

  test("rejects incomplete server prerequisites and lifecycle/action mismatches", () => {
    const invalidContexts = [
      baseContext({
        entryDraftStatus: "ready",
      }),
      baseContext({
        entryDraftStatus: "live",
      }),
      baseContext({
        scheduledBinding:
          scheduledBinding(),
      }),
      baseContext({
        readiness: {
          orderConfirmed: false,
        },
      }),
      baseContext({
        sourceSeason: {
          status: "completed",
        },
      }),
      baseContext({
        sourceSeason: {
          isCurrent: false,
        },
      }),
      baseContext({
        sourceSeason: {
          completionEvidence: {
            resultSetHash: "not-a-digest",
          },
        },
      }),
      baseContext({
        sourceSeason: {
          completionEvidence: {
            seasonVersion: 10,
          },
        },
      }),
      baseContext({
        sourceSeason: {
          completionEvidence: {
            competitionCompletedAtMs:
              SOURCE_SEASON_ENDS_AT_MS -
              DAY_MS,
          },
        },
      }),
      baseContext({
        targetSeason: {
          status: "active",
        },
      }),
      baseContext({
        targetSchedule: {
          complete: false,
        },
      }),
      baseContext({
        targetSchedule: {
          weekOneMatchupWeekId:
            "week-one",
        },
      }),
      baseContext({
        targetSchedule: {
          weekOneStartsAtMs:
            NOW_MS + 61 * DAY_MS,
        },
      }),
      baseContext({
        targetSeason: {
          calendar: {
            firstWeekStartsAtMs:
              NOW_MS + 230 * DAY_MS,
          },
        },
      }),
    ];
    for (const context of invalidContexts) {
      const evidence = harness({ context });
      assertServiceError(
        () =>
          evidence.service.schedule(
            command()
          ),
        "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
      );
      assert.equal(evidence.plans.length, 0);
    }
  });

  test("rejects client season, calendar, schedule, actor, or occurrence authority before authorization", () => {
    for (const extra of [
      {
        sourceSeasonId:
          SOURCE_SEASON_ID,
      },
      {
        targetSeasonId:
          TARGET_SEASON_ID,
      },
      {
        targetScheduleId:
          TARGET_SCHEDULE_ID,
      },
      {
        targetCalendar: {
          firstWeekStartsAtMs:
            STARTS_AT_MS,
        },
      },
      {
        actorAuthority:
          "platform_administrator",
      },
      {
        rolloverOccurrenceId:
          id(90),
      },
    ]) {
      const evidence = harness();
      assertServiceError(
        () =>
          evidence.service.schedule(
            command({
              input: {
                ...scheduleInput(),
                ...extra,
              },
            })
          ),
        "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID"
      );
      assert.deepEqual(evidence.events, []);
      assert.equal(evidence.plans.length, 0);
    }
  });

  test("hands off one atomic plan and rolls back a failed repository application", () => {
    const failure = new Error(
      "injected write failure"
    );
    const evidence = harness({
      applyError: failure,
    });
    assert.throws(
      () =>
        evidence.service.schedule(
          command()
        ),
      failure
    );
    assert.equal(evidence.plans.length, 1);
    assert.deepEqual(
      evidence.state.applied,
      []
    );
    assert.equal(
      eventNames(evidence).filter(
        (name) =>
          name === "applySchedulePlan"
      ).length,
      1
    );
    assert.equal(
      eventNames(evidence).at(-1),
      "transaction.rollback"
    );
  });

  test("fails closed on an unavailable durable result and maps repository races", () => {
    const unavailable = harness({
      persistedResult:
        expectedReplayResult({
          operationId: id(95),
        }),
    });
    assertServiceError(
      () =>
        unavailable.service.schedule(
          command()
        ),
      "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE"
    );
    assert.deepEqual(
      unavailable.state.applied,
      []
    );
    assert.equal(
      unavailable.state.durableResults.size,
      0
    );

    const versionConflict = new Error(
      "lost compare-and-swap"
    );
    versionConflict.code =
      "REPOSITORY_VERSION_CONFLICT";
    const raced = harness({
      applyError: versionConflict,
    });
    assertServiceError(
      () =>
        raced.service.schedule(
          command()
        ),
      "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED"
    );
    assert.deepEqual(raced.state.applied, []);

    const constraint = new Error(
      "binding no longer replaceable"
    );
    constraint.code =
      "REPOSITORY_CONSTRAINT";
    constraint.details = {
      tableName:
        "entry_draft_rollover_bindings",
    };
    const blocked = harness({
      applyError: constraint,
    });
    assertServiceError(
      () =>
        blocked.service.schedule(
          command()
        ),
      "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED"
    );
    assert.deepEqual(blocked.state.applied, []);
  });
});
