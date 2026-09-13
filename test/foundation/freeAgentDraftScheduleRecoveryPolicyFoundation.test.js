const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES,
  FreeAgentDraftScheduleRecoveryPolicyError,
  planFreeAgentDraftCompletionScheduleRecovery,
  planFreeAgentDraftPreOpenScheduleRecovery,
  planFreeAgentDraftRolloverExtensions,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryPolicy"
);

const VANCOUVER = "America/Vancouver";
const CREATION_CUTOFF_MS = 60 * 60 * 1000;

function uuid(number) {
  return (
    "00000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

function at(isoTimestamp) {
  return Date.parse(isoTimestamp);
}

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftScheduleRecoveryPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function preOpenInput(overrides = {}) {
  return {
    readinessAtMs: at(
      "2026-09-20T07:00:00.000Z"
    ),
    firstWeekStartsAtMs: at(
      "2026-09-28T07:00:00.000Z"
    ),
    fantasyPlayoffsStartAtMs: at(
      "2026-11-02T08:00:00.000Z"
    ),
    timeZone: VANCOUVER,
    ...overrides,
  };
}

function completionInput(overrides = {}) {
  const weekOne = at(
    "2026-09-28T07:00:00.000Z"
  );
  return {
    proposedCompletionAtMs: at(
      "2026-09-27T20:00:00.000Z"
    ),
    frozenFadFirstMatchupStartsAtMs:
      weekOne,
    competitionFirstMatchupStartsAtMs:
      weekOne,
    fantasyPlayoffsStartAtMs: at(
      "2026-11-02T08:00:00.000Z"
    ),
    timeZone: VANCOUVER,
    ...overrides,
  };
}

function rolloverAt(
  candidateDeadlineAtMs,
  sequence
) {
  return (
    candidateDeadlineAtMs +
    sequence * FREE_AGENT_DRAFT_DAY_MS
  );
}

describe(
  "Free Agent Draft schedule recovery policy",
  () => {
    test(
      "keeps a valid pre-open Week 1 and proves the complete initial window",
      () => {
        const result =
          planFreeAgentDraftPreOpenScheduleRecovery(
            preOpenInput()
          );

        assert.deepEqual(result, {
          recoveryKind: "pre_open",
          recoveryRequired: false,
          reasonCode:
            "pre_open_week_one_unchanged",
          readinessAtMs: at(
            "2026-09-20T07:00:00.000Z"
          ),
          timeZone: VANCOUVER,
          fantasyPlayoffsStartAtMs: at(
            "2026-11-02T08:00:00.000Z"
          ),
          previousFirstWeekStartsAtMs: at(
            "2026-09-28T07:00:00.000Z"
          ),
          firstWeekStartsAtMs: at(
            "2026-09-28T07:00:00.000Z"
          ),
          candidateDeadlineAtMs: at(
            "2026-09-21T07:00:00.000Z"
          ),
          initialPeriodEndsAtMs: at(
            "2026-09-28T07:00:00.000Z"
          ),
          initialRolloverCount: 7,
          mondayAdvanceCount: 0,
          removedRegularSeasonWeekCount: 0,
        });
        assert.ok(
          result.candidateDeadlineAtMs >
            result.readinessAtMs
        );
        assert.equal(
          result.initialPeriodEndsAtMs -
            result.candidateDeadlineAtMs,
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
        );
        assert.equal(
          Object.isFrozen(result),
          true
        );
      }
    );

    test(
      "advances one whole local Monday when readiness is exactly at the deadline",
      () => {
        const result =
          planFreeAgentDraftPreOpenScheduleRecovery(
            preOpenInput({
              readinessAtMs: at(
                "2026-09-21T07:00:00.000Z"
              ),
            })
          );

        assert.equal(
          result.recoveryRequired,
          true
        );
        assert.equal(
          result.firstWeekStartsAtMs,
          at("2026-10-05T07:00:00.000Z")
        );
        assert.equal(
          result.candidateDeadlineAtMs,
          at("2026-09-28T07:00:00.000Z")
        );
        assert.equal(result.mondayAdvanceCount, 1);
        assert.equal(
          result.removedRegularSeasonWeekCount,
          1
        );
      }
    );

    test(
      "advances by multiple whole Mondays to the earliest future-facing deadline",
      () => {
        const readinessAtMs = at(
          "2026-10-04T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftPreOpenScheduleRecovery(
            preOpenInput({ readinessAtMs })
          );

        assert.equal(
          result.firstWeekStartsAtMs,
          at("2026-10-12T07:00:00.000Z")
        );
        assert.equal(
          result.candidateDeadlineAtMs,
          at("2026-10-05T07:00:00.000Z")
        );
        assert.ok(
          result.candidateDeadlineAtMs >
            readinessAtMs
        );
        assert.equal(result.mondayAdvanceCount, 2);
      }
    );

    test(
      "accepts a 167-hour spring-forward pair of league-local Mondays",
      () => {
        const previousWeekOne = at(
          "2027-03-08T08:00:00.000Z"
        );
        const result =
          planFreeAgentDraftPreOpenScheduleRecovery({
            readinessAtMs: at(
              "2027-03-01T08:00:00.000Z"
            ),
            firstWeekStartsAtMs:
              previousWeekOne,
            fantasyPlayoffsStartAtMs: at(
              "2027-04-12T07:00:00.000Z"
            ),
            timeZone: VANCOUVER,
          });

        assert.equal(
          result.firstWeekStartsAtMs,
          at("2027-03-15T07:00:00.000Z")
        );
        assert.equal(
          result.firstWeekStartsAtMs -
            previousWeekOne,
          167 * 60 * 60 * 1000
        );
        assert.equal(
          result.candidateDeadlineAtMs,
          at("2027-03-08T07:00:00.000Z")
        );
      }
    );

    test(
      "accepts a 169-hour fall-back pair of league-local Mondays",
      () => {
        const previousWeekOne = at(
          "2026-10-26T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftPreOpenScheduleRecovery({
            readinessAtMs: at(
              "2026-10-19T07:00:00.000Z"
            ),
            firstWeekStartsAtMs:
              previousWeekOne,
            fantasyPlayoffsStartAtMs: at(
              "2026-12-07T08:00:00.000Z"
            ),
            timeZone: VANCOUVER,
          });

        assert.equal(
          result.firstWeekStartsAtMs,
          at("2026-11-02T08:00:00.000Z")
        );
        assert.equal(
          result.firstWeekStartsAtMs -
            previousWeekOne,
          169 * 60 * 60 * 1000
        );
        assert.equal(
          result.candidateDeadlineAtMs,
          at("2026-10-26T08:00:00.000Z")
        );
      }
    );

    test(
      "fails with a stable recovery error when no pre-playoff Monday remains",
      () => {
        assertPolicyError(
          () =>
            planFreeAgentDraftPreOpenScheduleRecovery({
              readinessAtMs: at(
                "2026-10-19T07:00:00.000Z"
              ),
              firstWeekStartsAtMs: at(
                "2026-10-26T07:00:00.000Z"
              ),
              fantasyPlayoffsStartAtMs: at(
                "2026-11-02T08:00:00.000Z"
              ),
              timeZone: VANCOUVER,
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .recoveryUnavailable,
            reasonCode:
              "pre_open_monday_unavailable",
          }
        );
      }
    );

    test(
      "does not shift competition when completion is before Week 1",
      () => {
        const result =
          planFreeAgentDraftCompletionScheduleRecovery(
            completionInput()
          );

        assert.equal(
          result.recoveryRequired,
          false
        );
        assert.equal(
          result.reasonCode,
          "completion_before_week_one"
        );
        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          result
            .previousCompetitionFirstMatchupStartsAtMs
        );
        assert.equal(result.mondayAdvanceCount, 0);
        assert.equal(
          result.historicalFadClockPreserved,
          true
        );
      }
    );

    test(
      "preserves an already recovered future Week 1 when completion is before it",
      () => {
        const recoveredWeekOne = at(
          "2026-10-12T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery(
            completionInput({
              proposedCompletionAtMs: at(
                "2026-10-05T07:00:00.001Z"
              ),
              competitionFirstMatchupStartsAtMs:
                recoveredWeekOne,
            })
          );

        assert.deepEqual(
          {
            recoveryRequired: result.recoveryRequired,
            reasonCode: result.reasonCode,
            previousCompetitionFirstMatchupStartsAtMs:
              result.previousCompetitionFirstMatchupStartsAtMs,
            competitionFirstMatchupStartsAtMs:
              result.competitionFirstMatchupStartsAtMs,
            historicalFadClockPreserved:
              result.historicalFadClockPreserved,
            mondayAdvanceCount: result.mondayAdvanceCount,
          },
          {
            recoveryRequired: false,
            reasonCode: "completion_before_week_one",
            previousCompetitionFirstMatchupStartsAtMs:
              recoveredWeekOne,
            competitionFirstMatchupStartsAtMs:
              recoveredWeekOne,
            historicalFadClockPreserved: true,
            mondayAdvanceCount: 0,
          }
        );
      }
    );

    test(
      "advances from an already recovered Week 1 when completion reaches it",
      () => {
        const recoveredWeekOne = at(
          "2026-10-12T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery(
            completionInput({
              proposedCompletionAtMs: recoveredWeekOne,
              competitionFirstMatchupStartsAtMs:
                recoveredWeekOne,
            })
          );

        assert.equal(result.recoveryRequired, true);
        assert.equal(
          result.reasonCode,
          "completion_week_one_advanced"
        );
        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          at("2026-10-19T07:00:00.000Z")
        );
        assert.equal(result.mondayAdvanceCount, 1);
        assert.equal(
          result.historicalFadClockPreserved,
          true
        );
      }
    );

    test(
      "moves completion at Week 1 to the first later valid Monday",
      () => {
        const weekOne = at(
          "2026-09-28T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery(
            completionInput({
              proposedCompletionAtMs: weekOne,
            })
          );

        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          at("2026-10-05T07:00:00.000Z")
        );
        assert.ok(
          result.competitionFirstMatchupStartsAtMs >
            result.proposedCompletionAtMs
        );
        assert.equal(result.mondayAdvanceCount, 1);
        assert.equal(
          result.frozenFadFirstMatchupStartsAtMs,
          weekOne
        );
      }
    );

    test(
      "moves an overrun by multiple Mondays while preserving the frozen FAD clock",
      () => {
        const frozenWeekOne = at(
          "2026-09-28T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery(
            completionInput({
              proposedCompletionAtMs: at(
                "2026-10-13T00:00:00.000Z"
              ),
            })
          );

        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          at("2026-10-19T07:00:00.000Z")
        );
        assert.equal(result.mondayAdvanceCount, 3);
        assert.equal(
          result.frozenFadFirstMatchupStartsAtMs,
          frozenWeekOne
        );
      }
    );

    test(
      "completion recovery follows the 167-hour spring-forward local-Monday boundary",
      () => {
        const weekOne = at(
          "2027-03-08T08:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery({
            proposedCompletionAtMs: weekOne,
            frozenFadFirstMatchupStartsAtMs:
              weekOne,
            competitionFirstMatchupStartsAtMs:
              weekOne,
            fantasyPlayoffsStartAtMs: at(
              "2027-04-12T07:00:00.000Z"
            ),
            timeZone: VANCOUVER,
          });

        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          at("2027-03-15T07:00:00.000Z")
        );
        assert.equal(
          result.competitionFirstMatchupStartsAtMs -
            weekOne,
          167 * 60 * 60 * 1000
        );
      }
    );

    test(
      "completion recovery follows the 169-hour fall-back local-Monday boundary",
      () => {
        const weekOne = at(
          "2026-10-26T07:00:00.000Z"
        );
        const result =
          planFreeAgentDraftCompletionScheduleRecovery({
            proposedCompletionAtMs: weekOne,
            frozenFadFirstMatchupStartsAtMs:
              weekOne,
            competitionFirstMatchupStartsAtMs:
              weekOne,
            fantasyPlayoffsStartAtMs: at(
              "2026-12-07T08:00:00.000Z"
            ),
            timeZone: VANCOUVER,
          });

        assert.equal(
          result.competitionFirstMatchupStartsAtMs,
          at("2026-11-02T08:00:00.000Z")
        );
        assert.equal(
          result.competitionFirstMatchupStartsAtMs -
            weekOne,
          169 * 60 * 60 * 1000
        );
      }
    );

    test(
      "completion recovery fails safely when a later scoring week cannot fit",
      () => {
        const weekOne = at(
          "2026-10-26T07:00:00.000Z"
        );
        assertPolicyError(
          () =>
            planFreeAgentDraftCompletionScheduleRecovery({
              proposedCompletionAtMs: weekOne,
              frozenFadFirstMatchupStartsAtMs:
                weekOne,
              competitionFirstMatchupStartsAtMs:
                weekOne,
              fantasyPlayoffsStartAtMs: at(
                "2026-11-02T08:00:00.000Z"
              ),
              timeZone: VANCOUVER,
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .recoveryUnavailable,
            reasonCode:
              "completion_monday_unavailable",
          }
        );
      }
    );

    test(
      "plans no extension for roster state alone and rejects roster illegality as a cause",
      () => {
        const candidateDeadlineAtMs =
          10_000_000_000;
        const noWork =
          planFreeAgentDraftRolloverExtensions({
            candidateDeadlineAtMs,
            existingRolloverCount:
              FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
            requirements: [],
          });

        assert.equal(
          noWork.extensionRequired,
          false
        );
        assert.deepEqual(noWork.extensions, []);

        assertPolicyError(
          () =>
            planFreeAgentDraftRolloverExtensions({
              candidateDeadlineAtMs,
              existingRolloverCount:
                FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
              requirements: [
                {
                  reason: "roster_illegal",
                  sourceId: uuid(1),
                  requiredRolloverAtMs:
                    rolloverAt(
                      candidateDeadlineAtMs,
                      8
                    ),
                },
              ],
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .extensionInvalid,
            reasonCode:
              "extension_reason_invalid",
          }
        );
      }
    );

    test(
      "plans one contiguous extension for a following-cycle requirement",
      () => {
        const candidateDeadlineAtMs =
          10_000_000_000;
        const result =
          planFreeAgentDraftRolloverExtensions({
            candidateDeadlineAtMs,
            existingRolloverCount: 7,
            requirements: [
              {
                reason: "queued_nomination",
                sourceId: uuid(2),
                requiredRolloverAtMs:
                  rolloverAt(
                    candidateDeadlineAtMs,
                    8
                  ),
              },
            ],
          });

        assert.equal(
          result.extensionRequired,
          true
        );
        assert.equal(result.extensionCount, 1);
        assert.deepEqual(result.extensions[0], {
          sequence: 8,
          windowKind: "extension",
          opensAtMs: rolloverAt(
            candidateDeadlineAtMs,
            7
          ),
          creationCutoffAtMs:
            rolloverAt(
              candidateDeadlineAtMs,
              8
            ) - CREATION_CUTOFF_MS,
          rollsOverAtMs: rolloverAt(
            candidateDeadlineAtMs,
            8
          ),
          requiredBy: [
            {
              reason: "queued_nomination",
              sourceId: uuid(2),
              requiredRolloverAtMs:
                rolloverAt(
                  candidateDeadlineAtMs,
                  8
                ),
              requiredSequence: 8,
            },
          ],
        });
      }
    );

    test(
      "plans multiple contiguous elapsed-day extensions from canonicalized requirements",
      () => {
        const candidateDeadlineAtMs =
          10_000_000_000;
        const input = {
          candidateDeadlineAtMs,
          existingRolloverCount: 7,
          requirements: [
            {
              reason: "recovery",
              sourceId: uuid(4),
              requiredRolloverAtMs:
                rolloverAt(
                  candidateDeadlineAtMs,
                  10
                ),
            },
            {
              reason: "fallback_auction",
              sourceId: uuid(3),
              requiredRolloverAtMs:
                rolloverAt(
                  candidateDeadlineAtMs,
                  8
                ),
            },
          ],
        };
        const first =
          planFreeAgentDraftRolloverExtensions(
            input
          );
        const second =
          planFreeAgentDraftRolloverExtensions(
            input
          );

        assert.deepEqual(first, second);
        assert.equal(first.extensionCount, 3);
        assert.deepEqual(
          first.extensions.map(
            ({
              sequence,
              opensAtMs,
              rollsOverAtMs,
            }) => ({
              sequence,
              opensAtMs,
              rollsOverAtMs,
            })
          ),
          [8, 9, 10].map((sequence) => ({
            sequence,
            opensAtMs: rolloverAt(
              candidateDeadlineAtMs,
              sequence - 1
            ),
            rollsOverAtMs: rolloverAt(
              candidateDeadlineAtMs,
              sequence
            ),
          }))
        );
        assert.deepEqual(
          first.requirements.map(
            ({ reason }) => reason
          ),
          ["fallback_auction", "recovery"]
        );
        assert.equal(
          first.extensions[1]
            .rollsOverAtMs -
            first.extensions[0].rollsOverAtMs,
          FREE_AGENT_DRAFT_DAY_MS
        );
        assert.equal(
          first.extensions[2]
            .rollsOverAtMs -
            first.extensions[1].rollsOverAtMs,
          FREE_AGENT_DRAFT_DAY_MS
        );
        assert.equal(Object.isFrozen(first), true);
        assert.equal(
          Object.isFrozen(first.requirements),
          true
        );
        assert.equal(
          Object.isFrozen(
            first.extensions[0].requiredBy
          ),
          true
        );
      }
    );

    test(
      "does not recreate an already persisted fair rollover on replay",
      () => {
        const candidateDeadlineAtMs =
          10_000_000_000;
        const result =
          planFreeAgentDraftRolloverExtensions({
            candidateDeadlineAtMs,
            existingRolloverCount: 9,
            requirements: [
              {
                reason: "restricted_auction",
                sourceId: uuid(5),
                requiredRolloverAtMs:
                  rolloverAt(
                    candidateDeadlineAtMs,
                    8
                  ),
              },
            ],
          });

        assert.equal(
          result.extensionRequired,
          false
        );
        assert.equal(result.extensionCount, 0);
        assert.equal(
          result.latestRequiredRolloverSequence,
          9
        );
        assert.deepEqual(result.extensions, []);
      }
    );

    test(
      "rejects non-contiguous extension clocks and fewer than seven initial rollovers",
      () => {
        const candidateDeadlineAtMs =
          10_000_000_000;
        assertPolicyError(
          () =>
            planFreeAgentDraftRolloverExtensions({
              candidateDeadlineAtMs,
              existingRolloverCount: 7,
              requirements: [
                {
                  reason: "recovery",
                  sourceId: uuid(6),
                  requiredRolloverAtMs:
                    rolloverAt(
                      candidateDeadlineAtMs,
                      8
                    ) + 1,
                },
              ],
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .extensionInvalid,
            reasonCode:
              "required_rollover_not_contiguous",
          }
        );

        assertPolicyError(
          () =>
            planFreeAgentDraftRolloverExtensions({
              candidateDeadlineAtMs,
              existingRolloverCount: 6,
              requirements: [],
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .extensionInvalid,
            reasonCode:
              "seven_initial_rollovers_required",
          }
        );
      }
    );

    test(
      "uses stable validation errors for malformed inputs and impossible clocks",
      () => {
        assertPolicyError(
          () =>
            planFreeAgentDraftPreOpenScheduleRecovery({
              ...preOpenInput(),
              rosterIsLegal: false,
            }),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .inputInvalid,
            reasonCode:
              "pre_open_fields_invalid",
          }
        );
        assertPolicyError(
          () =>
            planFreeAgentDraftPreOpenScheduleRecovery(
              preOpenInput({
                timeZone: "Mars/Olympus",
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .inputInvalid,
            reasonCode: "time_zone_invalid",
          }
        );
        assertPolicyError(
          () =>
            planFreeAgentDraftCompletionScheduleRecovery(
              completionInput({
                competitionFirstMatchupStartsAtMs:
                  at(
                    "2026-09-29T07:00:00.000Z"
                  ),
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .calendarInvalid,
            reasonCode:
              "first_week_not_local_monday",
          }
        );
        assertPolicyError(
          () =>
            planFreeAgentDraftCompletionScheduleRecovery(
              completionInput({
                competitionFirstMatchupStartsAtMs:
                  at(
                    "2026-09-21T07:00:00.000Z"
                  ),
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_CODES
                .calendarInvalid,
            reasonCode:
              "competition_week_one_already_recovered",
          }
        );
      }
    );

    test(
      "remains a pure domain policy with no runtime clock, persistence, transport, or network dependency",
      () => {
        const source = fs.readFileSync(
          path.join(
            __dirname,
            "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryPolicy.js"
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
            `unexpected pure-policy dependency: ${forbidden}`
          );
        }
      }
    );
  }
);
