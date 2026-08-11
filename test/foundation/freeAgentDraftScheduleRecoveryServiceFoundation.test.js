const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  planExplicitMatchupSchedule,
} = require(
  "../../src/domain/matchups/matchupSchedulePolicy"
);
const {
  buildMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
} = require(
  "../../src/domain/matchups/matchupJobPolicy"
);
const {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES,
  FreeAgentDraftScheduleRecoveryServiceError,
  createFreeAgentDraftScheduleRecoveryService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService"
);

const SPRING_CALENDAR = Object.freeze({
  nhlSeasonKey: "20262027",
  nhlRegularSeasonStartsAtMs: Date.parse(
    "2026-10-01T07:00:00.000Z"
  ),
  nhlRegularSeasonEndsAtMs: Date.parse(
    "2027-05-10T07:00:00.000Z"
  ),
  fantasyPlayoffsStartAtMs: Date.parse(
    "2027-04-12T07:00:00.000Z"
  ),
  fantasyPlayoffsEndAtMs: Date.parse(
    "2027-05-10T07:00:00.000Z"
  ),
  timeZone: "America/Vancouver",
  firstWeekStartsAtMs: Date.parse(
    "2027-03-08T08:00:00.000Z"
  ),
});

const FALL_CALENDAR = Object.freeze({
  nhlSeasonKey: "20262027",
  nhlRegularSeasonStartsAtMs: Date.parse(
    "2026-10-01T07:00:00.000Z"
  ),
  nhlRegularSeasonEndsAtMs: Date.parse(
    "2027-02-01T08:00:00.000Z"
  ),
  fantasyPlayoffsStartAtMs: Date.parse(
    "2027-01-04T08:00:00.000Z"
  ),
  fantasyPlayoffsEndAtMs: Date.parse(
    "2027-02-01T08:00:00.000Z"
  ),
  timeZone: "America/Vancouver",
  firstWeekStartsAtMs: Date.parse(
    "2026-10-26T07:00:00.000Z"
  ),
});

const SCOPE = Object.freeze({
  leagueId: uuid(1),
  seasonId: uuid(2),
  fadId: uuid(3),
  scheduleOperationId: uuid(4),
});

const SLOT_SPECS = Object.freeze([
  Object.freeze({
    slot: "statistics_refresh_start",
    jobType: "matchup:statistics_refresh",
    timeField: "startsAtMs",
  }),
  Object.freeze({
    slot: "baseline",
    jobType: "matchup:baseline",
    timeField: "baselineAtMs",
  }),
  Object.freeze({
    slot: "lock",
    jobType: "matchup:lock",
    timeField: "locksAtMs",
  }),
  Object.freeze({
    slot: "statistics_refresh_end",
    jobType: "matchup:statistics_refresh",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "finalize",
    jobType: "matchup:finalize",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "rollover",
    jobType: "matchup:rollover",
    timeField: "rollsOverAtMs",
  }),
]);

function uuid(number) {
  return (
    "10000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

function generatedUuid(number) {
  return (
    "90000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

function makeSecureRandom(start = 1) {
  let next = start;
  let calls = 0;
  return {
    id() {
      calls += 1;
      const value = generatedUuid(next);
      next += 1;
      return value;
    },
    get calls() {
      return calls;
    },
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutFirstWeek(calendar) {
  const {
    firstWeekStartsAtMs: unused,
    ...explicitCalendar
  } = calendar;
  return explicitCalendar;
}

function makeContext({
  teamCount = 4,
  calendar = SPRING_CALENDAR,
  recoveryKind = "pre_open",
  recoveryAtMs =
    calendar.firstWeekStartsAtMs -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS -
    1,
} = {}) {
  const teamIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(100 + index)
  );
  const explicitCalendar =
    withoutFirstWeek(calendar);
  const schedule = planExplicitMatchupSchedule({
    teamIds,
    ...explicitCalendar,
    firstWeekStartsAtMs:
      calendar.firstWeekStartsAtMs,
    nowMs: calendar.firstWeekStartsAtMs - 1,
  });
  const createdAtMs =
    calendar.nhlRegularSeasonStartsAtMs;
  const jobs = [];
  const weeks = schedule.weeks.map(
    (plannedWeek, weekIndex) => {
      const weekId = uuid(1_000 + weekIndex);
      const matchups = plannedWeek.pairs
        .map((pair, pairIndex) => ({
          id: uuid(
            2_000 + weekIndex * 10 + pairIndex
          ),
          leagueId: SCOPE.leagueId,
          seasonId: SCOPE.seasonId,
          weekId,
          homeTeamId: pair.homeTeamId,
          awayTeamId: pair.awayTeamId,
          status: "scheduled",
          version: 1,
        }))
        .reverse();
      const week = {
        id: weekId,
        leagueId: SCOPE.leagueId,
        seasonId: SCOPE.seasonId,
        weekKey: plannedWeek.weekKey,
        sequence: plannedWeek.sequence,
        startsAtMs: plannedWeek.startsAtMs,
        baselineAtMs: plannedWeek.baselineAtMs,
        locksAtMs: plannedWeek.locksAtMs,
        endsAtMs: plannedWeek.endsAtMs,
        rollsOverAtMs:
          plannedWeek.rollsOverAtMs,
        status: "scheduled",
        version: 1,
        matchups,
        bye:
          plannedWeek.byeTeamId === null
            ? null
            : {
                id: uuid(3_000 + weekIndex),
                leagueId: SCOPE.leagueId,
                seasonId: SCOPE.seasonId,
                weekId,
                teamId: plannedWeek.byeTeamId,
              },
      };
      SLOT_SPECS.forEach(
        ({ jobType, timeField }, slotIndex) => {
          const scheduledForMs =
            week[timeField];
          const id = uuid(
            4_000 + weekIndex * 10 + slotIndex
          );
          const bindingId = uuid(
            5_000 + weekIndex * 10 + slotIndex
          );
          jobs.push({
            id,
            leagueId: SCOPE.leagueId,
            seasonId: SCOPE.seasonId,
            weekId,
            jobType,
            occurrenceKey:
              buildMatchupOccurrenceKey({
                jobType,
                leagueId: SCOPE.leagueId,
                seasonId: SCOPE.seasonId,
                weekId,
                scheduleOperationId:
                  SCOPE.scheduleOperationId,
                scheduleVersion: 7,
                scheduledForMs,
              }),
            scheduledForMs,
            status: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            startedAtMs: null,
            completedAtMs: null,
            resultJson: null,
            lastErrorCode: null,
            createdAtMs,
            updatedAtMs: createdAtMs,
            version: 1,
            nextAttemptAtMs: scheduledForMs,
            bindingId,
            bindingJobType: jobType,
            bindingScheduleOperationId:
              SCOPE.scheduleOperationId,
            bindingScheduleVersion: 7,
            bindingOwningMatchupWeekId: weekId,
            bindingOwningMatchupId: null,
            bindingCreatedAtMs: createdAtMs,
            bindingVersion: 1,
          });
        }
      );
      return week;
    }
  );
  return {
    leagueId: SCOPE.leagueId,
    seasonId: SCOPE.seasonId,
    fadId: SCOPE.fadId,
    recovery: {
      kind: recoveryKind,
      atMs: recoveryAtMs,
      frozenFadFirstMatchupStartsAtMs:
        recoveryKind === "completion"
          ? calendar.firstWeekStartsAtMs
          : null,
    },
    calendar: explicitCalendar,
    currentGeneration: {
      leagueId: SCOPE.leagueId,
      seasonId: SCOPE.seasonId,
      scheduleVersion: 7,
      scheduleOperationId:
        SCOPE.scheduleOperationId,
      weekOneMatchupWeekId: weeks[0].id,
      weekOneStartsAtMs: weeks[0].startsAtMs,
      status: "current",
      supersededAtMs: null,
      version: 1,
    },
    weeks,
    jobs: jobs.reverse(),
  };
}

function plan(context, secureRandom = makeSecureRandom()) {
  return {
    result:
      createFreeAgentDraftScheduleRecoveryService({
        secureRandom,
      }).planRecovery(context),
    secureRandom,
  };
}

function pairKeys(matchups) {
  return matchups
    .map(
      ({ homeTeamId, awayTeamId }) =>
        `${homeTeamId}:${awayTeamId}`
    )
    .sort();
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

function assertServiceError(
  callback,
  { code, reasonCode = undefined }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftScheduleRecoveryServiceError
    );
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

describe(
  "FAD-05 pure schedule-recovery service",
  () => {
    test(
      "returns an immutable pre-open no-op without allocating identifiers",
      () => {
        const context = makeContext();
        const before = JSON.stringify(context);
        const secureRandom = makeSecureRandom();
        const { result } = plan(
          context,
          secureRandom
        );

        assert.deepEqual(result, {
          action: "no_op",
          recoveryRequired: false,
          recoveryKind: "pre_open",
          decision: result.decision,
        });
        assert.equal(
          result.decision.reasonCode,
          "pre_open_week_one_unchanged"
        );
        assert.equal(secureRandom.calls, 0);
        assert.equal(JSON.stringify(context), before);
        assertDeepFrozen(result);
      }
    );

    test(
      "removes one even-team prefix week and fairly regenerates rather than translating pairings",
      () => {
        const context = makeContext({
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs -
            FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
        });
        const { result } = plan(context);

        assert.equal(result.action, "stage_recovery");
        assert.equal(result.recoveryRequired, true);
        assert.equal(
          result.decision.mondayAdvanceCount,
          1
        );
        assert.equal(result.removals.weeks.length, 1);
        assert.equal(
          result.removals.matchups.length,
          2
        );
        assert.equal(result.removals.byes.length, 0);
        assert.equal(
          result.mappedWeeks.length,
          context.weeks.length - 1
        );
        assert.equal(
          result.mappedWeeks[0].id,
          context.weeks[1].id
        );
        assert.equal(
          result.mappedWeeks[0].previousSequence,
          2
        );
        assert.equal(result.mappedWeeks[0].sequence, 1);
        assert.equal(
          result.mappedWeeks[0].weekKey,
          "regular-01"
        );

        const sourceTranslatedPairs = pairKeys(
          context.weeks[1].matchups
        );
        const regeneratedPairs = pairKeys(
          result.mappedWeeks[0].matchups
        );
        assert.notDeepEqual(
          regeneratedPairs,
          sourceTranslatedPairs
        );
        assert.deepEqual(
          regeneratedPairs,
          pairKeys(context.weeks[0].matchups)
        );

        const sortedRetainedMatchupIds =
          context.weeks[1].matchups
            .map(({ id }) => id)
            .sort();
        assert.deepEqual(
          result.mappedWeeks[0].matchups.map(
            ({ id }) => id
          ),
          sortedRetainedMatchupIds
        );
        assert.equal(
          result.generation.replacement
            .weekOneMatchupWeekId,
          context.weeks[1].id
        );
        assert.equal(
          result.generation.replacement
            .scheduleVersion,
          8
        );
        assert.equal(
          result.generation.superseded.status,
          "superseded"
        );
        assertDeepFrozen(result);
      }
    );

    test(
      "removes exactly a multi-Monday prefix and resets retained week sequences and keys",
      () => {
        const context = makeContext({
          recoveryAtMs: Date.parse(
            "2027-03-08T07:00:00.000Z"
          ),
        });
        const { result } = plan(context);

        assert.equal(
          result.decision.mondayAdvanceCount,
          2
        );
        assert.deepEqual(
          result.removals.weeks.map(
            ({ sequence }) => sequence
          ),
          [1, 2]
        );
        assert.equal(
          result.mappedWeeks[0].id,
          context.weeks[2].id
        );
        assert.deepEqual(
          result.mappedWeeks.map(
            ({ sequence }) => sequence
          ),
          [1, 2, 3]
        );
        assert.deepEqual(
          result.mappedWeeks.map(
            ({ weekKey }) => weekKey
          ),
          ["regular-01", "regular-02", "regular-03"]
        );
        assert.equal(
          result.recovery.removedWeekCount,
          2
        );
        assert.equal(
          result.recovery.cancelledJobCount,
          12
        );
        assert.equal(
          result.recovery.replacedJobCount,
          18
        );
      }
    );

    test(
      "retains stable odd-team bye and matchup identities while resetting the fair rotation",
      () => {
        const context = makeContext({
          teamCount: 5,
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs -
            FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
        });
        const { result } = plan(context);

        assert.equal(result.removals.byes.length, 1);
        assert.equal(
          result.mappedWeeks.every(
            ({ bye }) => bye !== null
          ),
          true
        );
        for (
          let index = 0;
          index < result.mappedWeeks.length;
          index += 1
        ) {
          assert.equal(
            result.mappedWeeks[index].bye.id,
            context.weeks[index + 1].bye.id
          );
        }
        assert.notEqual(
          result.mappedWeeks[0].bye.teamId,
          result.mappedWeeks[0].bye.previousTeamId
        );
        assert.equal(
          result.mappedWeeks[0].bye.teamId,
          context.weeks[0].bye.teamId
        );
        assert.equal(
          result.recovery.removedMatchupCount,
          2
        );
      }
    );

    test(
      "accepts spring-forward and fall-back local-Monday recovery boundaries",
      () => {
        const spring = plan(
          makeContext({
            recoveryAtMs:
              SPRING_CALENDAR.firstWeekStartsAtMs -
              FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
          })
        ).result;
        const fall = plan(
          makeContext({
            calendar: FALL_CALENDAR,
            recoveryAtMs:
              FALL_CALENDAR.firstWeekStartsAtMs -
              FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
          })
        ).result;

        assert.equal(
          spring.recovery.newWeekOneStartsAtMs -
            spring.recovery.oldWeekOneStartsAtMs,
          167 * 60 * 60 * 1000
        );
        assert.equal(
          fall.recovery.newWeekOneStartsAtMs -
            fall.recovery.oldWeekOneStartsAtMs,
          169 * 60 * 60 * 1000
        );
      }
    );

    test(
      "handles completion no-op, exact-boundary recovery, and a multi-Monday overrun",
      () => {
        const beforeWeekOne = makeContext({
          recoveryKind: "completion",
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs - 1,
        });
        const noOpRandom = makeSecureRandom();
        const noOp = plan(
          beforeWeekOne,
          noOpRandom
        ).result;
        assert.equal(noOp.action, "no_op");
        assert.equal(noOpRandom.calls, 0);

        const exact = plan(
          makeContext({
            recoveryKind: "completion",
            recoveryAtMs:
              SPRING_CALENDAR.firstWeekStartsAtMs,
          })
        ).result;
        assert.equal(
          exact.decision.mondayAdvanceCount,
          1
        );
        assert.equal(
          exact.decision.historicalFadClockPreserved,
          true
        );

        const overrun = plan(
          makeContext({
            recoveryKind: "completion",
            recoveryAtMs: Date.parse(
              "2027-03-16T00:00:00.000Z"
            ),
          })
        ).result;
        assert.equal(
          overrun.decision.mondayAdvanceCount,
          2
        );
        assert.equal(
          overrun.recovery.newWeekOneStartsAtMs,
          Date.parse("2027-03-22T07:00:00.000Z")
        );
        assert.equal(
          overrun.decision
            .frozenFadFirstMatchupStartsAtMs,
          SPRING_CALENDAR.firstWeekStartsAtMs
        );
      }
    );

    test(
      "cancels six removed-week jobs and replaces six jobs for every retained week even at identical instants",
      () => {
        const context = makeContext({
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs -
            FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
        });
        const { result } = plan(context);
        const cancelled = result.oldJobCas.filter(
          ({ disposition }) =>
            disposition === "cancelled"
        );
        const replaced = result.oldJobCas.filter(
          ({ disposition }) =>
            disposition === "replaced"
        );

        assert.equal(cancelled.length, 6);
        assert.equal(
          replaced.length,
          (context.weeks.length - 1) * 6
        );
        assert.equal(
          result.replacementJobs.length,
          replaced.length
        );
        assert.equal(
          result.replacementBindings.length,
          replaced.length
        );
        assert.equal(
          result.recoveryChildren.jobs.length,
          context.jobs.length
        );
        assert.equal(
          result.recoveryChildren.jobs.filter(
            ({ disposition }) =>
              disposition === "cancelled"
          ).every(
            (effect) =>
              effect.replacementJobRunId === null &&
              effect.replacementOccurrenceKey === null &&
              effect.replacementScheduleOperationId ===
                null &&
              effect.replacementScheduleVersion === null
          ),
          true
        );

        for (const effect of
          result.recoveryChildren.jobs.filter(
            ({ disposition }) =>
              disposition === "replaced"
          )) {
          const oldJob = context.jobs.find(
            ({ id }) =>
              id === effect.replacedJobRunId
          );
          const replacement =
            result.replacementJobs.find(
              ({ id }) =>
                id === effect.replacementJobRunId
            );
          assert.equal(
            replacement.scheduledForMs,
            oldJob.scheduledForMs
          );
          assert.notEqual(
            replacement.occurrenceKey,
            oldJob.occurrenceKey
          );
          const parsed =
            parseQualifiedMatchupOccurrenceKey({
              jobType: replacement.jobType,
              leagueId: SCOPE.leagueId,
              seasonId: SCOPE.seasonId,
              occurrenceKey:
                replacement.occurrenceKey,
              scheduledForMs:
                replacement.scheduledForMs,
            });
          assert.equal(
            parsed.scheduleOperationId,
            result.operation.id
          );
          assert.equal(parsed.scheduleVersion, 8);
        }
        assert.equal(
          result.oldJobCas.every(
            (oldJob) =>
              oldJob.resultingStatus === "skipped" &&
              oldJob.resultingNextAttemptAtMs === null &&
              oldJob.resultingJobVersion ===
                oldJob.expectedJobVersion + 1
          ),
          true
        );
      }
    );

    test(
      "exposes the exact evidence input, canonical preimage, and digest",
      () => {
        const { result } = plan(
          makeContext({
            recoveryAtMs:
              SPRING_CALENDAR.firstWeekStartsAtMs -
              FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
          })
        );
        const independentlySealed =
          createFreeAgentDraftScheduleRecoveryEvidence(
            result.evidence.input
          );

        assert.deepEqual(
          result.evidence.preimage,
          independentlySealed.preimage
        );
        assert.equal(
          result.evidence.evidenceSha256,
          independentlySealed.evidenceSha256
        );
        assert.equal(
          result.recovery.evidenceSha256,
          result.evidence.evidenceSha256
        );
        assert.equal(
          result.evidence.input.operationId,
          result.operation.id
        );
        assert.equal(
          result.evidence.input.recoveryId,
          result.recovery.id
        );
        assert.equal(
          result.evidence.input.removedWeeks.length,
          result.recovery.removedWeekCount
        );
        assert.equal(
          result.evidence.input.removedMatchups.length,
          result.recovery.removedMatchupCount
        );
        assert.equal(
          result.evidence.input.jobEffects.length,
          result.oldJobCas.length
        );
      }
    );

    test(
      "maps deterministically when matchup and job input arrays use different orders",
      () => {
        const recoveryAtMs =
          SPRING_CALENDAR.firstWeekStartsAtMs -
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
        const firstContext = makeContext({
          teamCount: 5,
          recoveryAtMs,
        });
        const secondContext = jsonClone(firstContext);
        for (const week of secondContext.weeks) {
          week.matchups.reverse();
        }
        secondContext.jobs.reverse();

        const first = plan(
          firstContext,
          makeSecureRandom(200)
        ).result;
        const second = plan(
          secondContext,
          makeSecureRandom(200)
        ).result;

        assert.deepEqual(second, first);
      }
    );

    test(
      "rejects malformed closed context, generation, participant, and untouched-job state",
      () => {
        const base = makeContext({
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs -
            FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
        });
        const cases = [
          {
            reasonCode: "context_fields_invalid",
            mutate(context) {
              context.unexpected = true;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .contextInvalid,
          },
          {
            reasonCode: "calendar_fields_invalid",
            mutate(context) {
              context.calendar.annualDefault = true;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .contextInvalid,
          },
          {
            reasonCode: "generation_not_current",
            mutate(context) {
              context.currentGeneration.status =
                "superseded";
              context.currentGeneration.supersededAtMs =
                context.recovery.atMs;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .stateInvalid,
          },
          {
            reasonCode: "weekly_participant_duplicate",
            mutate(context) {
              context.weeks[0].matchups[1]
                .homeTeamId =
                context.weeks[0].matchups[0]
                  .homeTeamId;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .stateInvalid,
          },
          {
            reasonCode: "job_count_invalid",
            mutate(context) {
              context.jobs.pop();
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .stateInvalid,
          },
          {
            reasonCode: "job_not_untouched_pending",
            mutate(context) {
              context.jobs[0].status = "running";
              context.jobs[0].startedAtMs =
                context.recovery.atMs;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .stateInvalid,
          },
          {
            reasonCode: "job_occurrence_key_invalid",
            mutate(context) {
              const job = context.jobs[0];
              job.occurrenceKey =
                `${job.jobType}:${job.leagueId}:` +
                `${job.seasonId}:${job.weekId}:` +
                `${job.scheduledForMs}`;
            },
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .stateInvalid,
          },
        ];

        for (const fixture of cases) {
          const malformed = jsonClone(base);
          fixture.mutate(malformed);
          assertServiceError(
            () => plan(malformed),
            fixture
          );
        }
      }
    );

    test(
      "requires the completion frozen Week 1 and rejects duplicate generated identifiers",
      () => {
        const missingFrozen = makeContext({
          recoveryKind: "completion",
          recoveryAtMs:
            SPRING_CALENDAR.firstWeekStartsAtMs,
        });
        missingFrozen.recovery
          .frozenFadFirstMatchupStartsAtMs = null;
        assertServiceError(
          () => plan(missingFrozen),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .contextInvalid,
            reasonCode:
              "completion_frozen_week_one_invalid",
          }
        );

        const duplicateId = generatedUuid(700);
        const secureRandom = {
          id() {
            return duplicateId;
          },
        };
        assertServiceError(
          () =>
            plan(
              makeContext({
                recoveryAtMs:
                  SPRING_CALENDAR.firstWeekStartsAtMs -
                  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
              }),
              secureRandom
            ),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_SERVICE_CODES
                .secureIdentifierInvalid,
            reasonCode:
              "secure_identifier_duplicate",
          }
        );
      }
    );

    test(
      "has no persistence, runtime clock, transport, filesystem, or network dependency",
      () => {
        const source = fs.readFileSync(
          path.join(
            __dirname,
            "../../src/application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService.js"
          ),
          "utf8"
        );
        for (const forbidden of [
          "Date.now(",
          "setTimeout(",
          "setInterval(",
          "better-sqlite3",
          "Sqlite",
          "express",
          "fetch(",
          "http:",
          "https:",
          "node:fs",
          "node:net",
        ]) {
          assert.equal(
            source.includes(forbidden),
            false,
            `unexpected planner dependency: ${forbidden}`
          );
        }
      }
    );
  }
);
