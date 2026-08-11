const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_HELP_WINDOW_MS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
  FREE_AGENT_DRAFT_POLICY_CODES,
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
  FREE_AGENT_DRAFT_STATUSES,
  FREE_AGENT_DRAFT_VIEWER_PHASES,
  FreeAgentDraftPolicyError,
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
  validateFreeAgentDraftStatusTransition,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);

const CANDIDATE_DEADLINE_AT_MS =
  10_000_000_000;
const FIRST_MATCHUP_STARTS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS +
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
const EARLY_CARDS_OPENED_AT_MS =
  CANDIDATE_DEADLINE_AT_MS -
  10 * FREE_AGENT_DRAFT_DAY_MS;

function uuid(number) {
  return (
    "00000000-0000-4000-8000-" +
    String(number).padStart(12, "0")
  );
}

const LEAGUE_ID = uuid(1);
const SEASON_ID = uuid(2);
const TRIGGER_RESOURCE_ID = uuid(3);
const FAD_ID = uuid(4);
const PLAYER_ID = uuid(5);
const SOURCE_OPERATION_ID = uuid(6);
const ALLOCATION_ID = uuid(7);
const QUEUE_ID = uuid(8);
const EXTENSION_SOURCE_ID = uuid(9);

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof FreeAgentDraftPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function clockFor(openedAtMs = EARLY_CARDS_OPENED_AT_MS) {
  return createFreeAgentDraftClock({
    cardsOpenedAtMs: openedAtMs,
    firstMatchupStartsAtMs:
      FIRST_MATCHUP_STARTS_AT_MS,
  });
}

function persistedInitialRollovers({
  statuses = Array(
    FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
  ).fill("completed"),
} = {}) {
  return clockFor().initialRollovers.map(
    (rollover, index) => ({
      id: uuid(100 + index),
      sequence: rollover.sequence,
      windowKind: rollover.windowKind,
      predecessorRolloverId:
        index === 0
          ? null
          : uuid(100 + index - 1),
      extensionReason: null,
      extensionSourceId: null,
      opensAtMs: rollover.opensAtMs,
      creationCutoffAtMs:
        rollover.creationCutoffAtMs,
      rollsOverAtMs: rollover.rollsOverAtMs,
      status: statuses[index],
    })
  );
}

function completionInput(overrides = {}) {
  return {
    status: "rapid",
    nowMs: FIRST_MATCHUP_STARTS_AT_MS,
    candidateDeadlineAtMs:
      CANDIDATE_DEADLINE_AT_MS,
    rollovers: persistedInitialRollovers(),
    cardStatuses: [
      "locked_complete",
      "locked_incomplete",
      "locked_conflicted",
    ],
    allocationStatuses: [
      "automatic_award",
      "restricted_resolved",
      "fallback_open_resolved",
      "no_valid_offer",
      "invalid",
    ],
    nominationStatuses: ["opened", "invalid"],
    auctionStatuses: [
      "resolved",
      "no_winner",
      "cancelled",
    ],
    recoveryStatuses: ["resolved"],
    unaccountedPathCount: 0,
    quarantinedPlayerCount: 0,
    ...overrides,
  };
}

describe(
  "Free Agent Draft lifecycle and clock policy foundation",
  () => {
    test(
      "models the exact persisted statuses and forward-only transitions",
      () => {
        assert.deepEqual(
          FREE_AGENT_DRAFT_STATUSES,
          [
            "cards_open",
            "deadline_locked",
            "allocating",
            "rapid",
            "completed",
          ]
        );
        assert.deepEqual(
          FREE_AGENT_DRAFT_VIEWER_PHASES,
          [
            "inactive",
            "cards_open",
            "help_window",
            "deadline_processing",
            "allocating",
            "rapid",
            "completed",
          ]
        );

        const allowed = [
          [null, "cards_open"],
          ["cards_open", "deadline_locked"],
          ["deadline_locked", "allocating"],
          ["deadline_locked", "rapid"],
          ["allocating", "rapid"],
          ["rapid", "completed"],
        ];
        for (const [fromStatus, toStatus] of allowed) {
          const result =
            validateFreeAgentDraftStatusTransition({
              fromStatus,
              toStatus,
            });
          assert.deepEqual(result, {
            fromStatus,
            toStatus,
          });
          assert.equal(Object.isFrozen(result), true);
        }
      }
    );

    test(
      "rejects skipped, backward, same-state, reopen, and post-completion transitions",
      () => {
        for (const [fromStatus, toStatus] of [
          [null, "rapid"],
          ["cards_open", "allocating"],
          ["rapid", "cards_open"],
          ["rapid", "rapid"],
        ]) {
          assertPolicyError(
            () =>
              validateFreeAgentDraftStatusTransition({
                fromStatus,
                toStatus,
              }),
            {
              code:
                FREE_AGENT_DRAFT_POLICY_CODES
                  .statusTransitionInvalid,
              reasonCode:
                "status_transition_invalid",
            }
          );
        }
        assertPolicyError(
          () =>
            validateFreeAgentDraftStatusTransition({
              fromStatus: "completed",
              toStatus: "rapid",
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .statusTransitionInvalid,
            reasonCode:
              "completed_status_terminal",
          }
        );
      }
    );

    test(
      "derives the exact 168-hour deadline and seven exact 24-hour initial rollovers",
      () => {
        const clock = clockFor();

        assert.equal(
          clock.candidateDeadlineAtMs,
          CANDIDATE_DEADLINE_AT_MS
        );
        assert.equal(
          clock.firstMatchupStartsAtMs -
            clock.candidateDeadlineAtMs,
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
        );
        assert.equal(
          clock.helpOpensAtMs,
          CANDIDATE_DEADLINE_AT_MS -
            FREE_AGENT_DRAFT_HELP_WINDOW_MS
        );
        assert.equal(
          clock.reminderAtMs,
          CANDIDATE_DEADLINE_AT_MS -
            FREE_AGENT_DRAFT_REMINDER_LEAD_MS
        );
        assert.equal(
          clock.initialRollovers.length,
          7
        );
        for (
          let index = 0;
          index < clock.initialRollovers.length;
          index += 1
        ) {
          const rollover =
            clock.initialRollovers[index];
          assert.deepEqual(rollover, {
            sequence: index + 1,
            windowKind: "initial",
            opensAtMs:
              CANDIDATE_DEADLINE_AT_MS +
              index * FREE_AGENT_DRAFT_DAY_MS,
            creationCutoffAtMs:
              CANDIDATE_DEADLINE_AT_MS +
              (index + 1) *
                FREE_AGENT_DRAFT_DAY_MS -
              FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
            rollsOverAtMs:
              CANDIDATE_DEADLINE_AT_MS +
              (index + 1) *
                FREE_AGENT_DRAFT_DAY_MS,
          });
        }
        assert.equal(
          clock.initialRollovers.at(-1)
            .rollsOverAtMs,
          FIRST_MATCHUP_STARTS_AT_MS
        );
        assert.equal(Object.isFrozen(clock), true);
        assert.equal(
          Object.isFrozen(clock.initialRollovers),
          true
        );
        assert.equal(
          Object.isFrozen(
            clock.initialRollovers[0]
          ),
          true
        );
        assert.throws(
          () => clock.initialRollovers.push({}),
          TypeError
        );
      }
    );

    test(
      "opens help at the normal boundary or adaptively at a late card opening",
      () => {
        const normalHelpAt =
          CANDIDATE_DEADLINE_AT_MS -
          FREE_AGENT_DRAFT_HELP_WINDOW_MS;
        const before = clockFor(
          normalHelpAt - 1
        );
        const exact = clockFor(normalHelpAt);
        const late = clockFor(normalHelpAt + 1);

        assert.equal(
          before.helpOpensAtMs,
          normalHelpAt
        );
        assert.equal(
          exact.helpOpensAtMs,
          normalHelpAt
        );
        assert.equal(
          late.helpOpensAtMs,
          normalHelpAt + 1
        );
        assert.equal(
          deriveFreeAgentDraftViewerPhase({
            status: "cards_open",
            nowMs: late.cardsOpenedAtMs,
            cardsOpenedAtMs:
              late.cardsOpenedAtMs,
            helpOpensAtMs: late.helpOpensAtMs,
            candidateDeadlineAtMs:
              late.candidateDeadlineAtMs,
          }),
          "help_window"
        );
      }
    );

    test(
      "rejects non-exact clock input, unsafe time, and opening at the deadline",
      () => {
        assertPolicyError(
          () =>
            createFreeAgentDraftClock({
              cardsOpenedAtMs:
                EARLY_CARDS_OPENED_AT_MS,
              firstMatchupStartsAtMs:
                FIRST_MATCHUP_STARTS_AT_MS,
              browserNowMs: 1,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .inputInvalid,
            reasonCode: "input_fields_invalid",
          }
        );
        assertPolicyError(
          () =>
            createFreeAgentDraftClock({
              cardsOpenedAtMs:
                Number.MAX_SAFE_INTEGER,
              firstMatchupStartsAtMs:
                Number.MAX_SAFE_INTEGER,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .clockInvalid,
            reasonCode:
              "cards_must_open_before_candidate_deadline",
          }
        );
        assertPolicyError(
          () =>
            createFreeAgentDraftClock({
              cardsOpenedAtMs:
                CANDIDATE_DEADLINE_AT_MS,
              firstMatchupStartsAtMs:
                FIRST_MATCHUP_STARTS_AT_MS,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .clockInvalid,
            reasonCode:
              "cards_must_open_before_candidate_deadline",
          }
        );
      }
    );

    test(
      "derives inactive, preparation, help, deadline-processing, allocation, rapid, and completed phases at exact boundaries",
      () => {
        assert.equal(
          deriveFreeAgentDraftViewerPhase({
            status: null,
            nowMs: 0,
            cardsOpenedAtMs: null,
            helpOpensAtMs: null,
            candidateDeadlineAtMs: null,
          }),
          "inactive"
        );
        const clock = clockFor();
        const phase = (status, nowMs) =>
          deriveFreeAgentDraftViewerPhase({
            status,
            nowMs,
            cardsOpenedAtMs:
              clock.cardsOpenedAtMs,
            helpOpensAtMs:
              clock.helpOpensAtMs,
            candidateDeadlineAtMs:
              clock.candidateDeadlineAtMs,
          });

        assert.equal(
          phase(
            "cards_open",
            clock.helpOpensAtMs - 1
          ),
          "cards_open"
        );
        assert.equal(
          phase(
            "cards_open",
            clock.helpOpensAtMs
          ),
          "help_window"
        );
        assert.equal(
          phase(
            "cards_open",
            clock.candidateDeadlineAtMs - 1
          ),
          "help_window"
        );
        assert.equal(
          phase(
            "cards_open",
            clock.candidateDeadlineAtMs
          ),
          "deadline_processing"
        );
        assert.equal(
          phase(
            "deadline_locked",
            clock.candidateDeadlineAtMs
          ),
          "allocating"
        );
        assert.equal(
          phase(
            "allocating",
            clock.candidateDeadlineAtMs
          ),
          "allocating"
        );
        assert.equal(
          phase(
            "rapid",
            clock.candidateDeadlineAtMs
          ),
          "rapid"
        );
        assert.equal(
          phase(
            "completed",
            FIRST_MATCHUP_STARTS_AT_MS
          ),
          "completed"
        );
      }
    );

    test(
      "rejects inconsistent viewer clocks and post-deadline state before the deadline",
      () => {
        const clock = clockFor();
        assertPolicyError(
          () =>
            deriveFreeAgentDraftViewerPhase({
              status: "cards_open",
              nowMs: clock.cardsOpenedAtMs,
              cardsOpenedAtMs:
                clock.cardsOpenedAtMs,
              helpOpensAtMs:
                clock.helpOpensAtMs + 1,
              candidateDeadlineAtMs:
                clock.candidateDeadlineAtMs,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .clockInvalid,
            reasonCode: "help_open_time_invalid",
          }
        );
        assertPolicyError(
          () =>
            deriveFreeAgentDraftViewerPhase({
              status: "rapid",
              nowMs:
                clock.candidateDeadlineAtMs -
                1,
              cardsOpenedAtMs:
                clock.cardsOpenedAtMs,
              helpOpensAtMs:
                clock.helpOpensAtMs,
              candidateDeadlineAtMs:
                clock.candidateDeadlineAtMs,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .clockInvalid,
            reasonCode:
              "post_deadline_status_before_deadline",
          }
        );
      }
    );

    test(
      "remains a pure policy with no runtime clock, network, database, or module dependency",
      () => {
        const source = fs.readFileSync(
          path.join(
            __dirname,
            "..",
            "..",
            "src",
            "domain",
            "freeAgentDraft",
            "freeAgentDraftPolicy.js"
          ),
          "utf8"
        );
        assert.doesNotMatch(
          source,
          /\brequire\s*\(/
        );
        assert.doesNotMatch(
          source,
          /\bDate\.now\s*\(/
        );
        assert.doesNotMatch(
          source,
          /\bnew\s+Date\s*\(/
        );
        assert.doesNotMatch(
          source,
          /\b(fetch|XMLHttpRequest|WebSocket)\b/
        );
        assert.doesNotMatch(
          source,
          /\b(sqlite|database|repository)\b/i
        );
      }
    );
  }
);

describe(
  "Free Agent Draft rapid rollover policy foundation",
  () => {
    test(
      "opens nominations before the cutoff and queues them privately at and after the exact cutoff",
      () => {
        const rollover = clockFor()
          .initialRollovers[0];
        const classify = (acceptedAtMs) =>
          classifyFreeAgentDraftNominationTiming({
            acceptedAtMs,
            opensAtMs: rollover.opensAtMs,
            creationCutoffAtMs:
              rollover.creationCutoffAtMs,
            rollsOverAtMs:
              rollover.rollsOverAtMs,
          });

        assert.deepEqual(
          classify(
            rollover.creationCutoffAtMs - 1
          ),
          {
            disposition: "open_immediately",
            acceptedAtMs:
              rollover.creationCutoffAtMs - 1,
            auctionOpensAtMs:
              rollover.creationCutoffAtMs - 1,
            resolutionRolloverAtMs:
              rollover.rollsOverAtMs,
            requiresFollowingRollover: false,
          }
        );
        assert.deepEqual(
          classify(
            rollover.creationCutoffAtMs
          ),
          {
            disposition: "queue_private",
            acceptedAtMs:
              rollover.creationCutoffAtMs,
            auctionOpensAtMs:
              rollover.rollsOverAtMs,
            resolutionRolloverAtMs:
              rollover.rollsOverAtMs +
              FREE_AGENT_DRAFT_DAY_MS,
            requiresFollowingRollover: true,
          }
        );
        assert.equal(
          classify(
            rollover.rollsOverAtMs - 1
          ).disposition,
          "queue_private"
        );
      }
    );

    test(
      "rejects nominations before the cycle and exactly at or after rollover",
      () => {
        const rollover = clockFor()
          .initialRollovers[0];
        const classify = (acceptedAtMs) =>
          classifyFreeAgentDraftNominationTiming({
            acceptedAtMs,
            opensAtMs: rollover.opensAtMs,
            creationCutoffAtMs:
              rollover.creationCutoffAtMs,
            rollsOverAtMs:
              rollover.rollsOverAtMs,
          });

        assertPolicyError(
          () => classify(rollover.opensAtMs - 1),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .nominationWindowUnavailable,
            reasonCode:
              "nomination_before_window_open",
          }
        );
        for (const acceptedAtMs of [
          rollover.rollsOverAtMs,
          rollover.rollsOverAtMs + 1,
        ]) {
          assertPolicyError(
            () => classify(acceptedAtMs),
            {
              code:
                FREE_AGENT_DRAFT_POLICY_CODES
                  .nominationWindowUnavailable,
              reasonCode:
                "nomination_at_or_after_rollover",
            }
          );
        }
      }
    );

    test(
      "validates a restart-loaded initial rollover chain and freezes a detached result",
      () => {
        const rows = persistedInitialRollovers();
        const result =
          validateFreeAgentDraftRolloverSequence({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: rows,
          });

        assert.deepEqual(result, rows);
        assert.notEqual(result, rows);
        assert.notEqual(result[0], rows[0]);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(
          Object.isFrozen(result[0]),
          true
        );
        rows[0].status = "scheduled";
        assert.equal(result[0].status, "completed");
      }
    );

    test(
      "rejects missing, gapped, mistimed, and predecessor-mismatched rollover chains",
      () => {
        assertPolicyError(
          () =>
            validateFreeAgentDraftRolloverSequence({
              candidateDeadlineAtMs:
                CANDIDATE_DEADLINE_AT_MS,
              rollovers:
                persistedInitialRollovers().slice(
                  0,
                  6
                ),
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .rolloverSequenceInvalid,
            reasonCode:
              "seven_initial_rollovers_required",
          }
        );

        const cases = [
          {
            index: 3,
            change: {
              sequence: 5,
            },
            reason:
              "rollover_sequences_not_contiguous",
          },
          {
            index: 3,
            change: {
              rollsOverAtMs:
                CANDIDATE_DEADLINE_AT_MS +
                4 * FREE_AGENT_DRAFT_DAY_MS +
                1,
            },
            reason:
              "rollover_clock_not_contiguous",
          },
          {
            index: 3,
            change: {
              predecessorRolloverId: uuid(999),
            },
            reason:
              "rollover_predecessor_mismatch",
          },
        ];
        for (const fixture of cases) {
          const rows =
            persistedInitialRollovers().map(
              (row) => ({ ...row })
            );
          rows[fixture.index] = {
            ...rows[fixture.index],
            ...fixture.change,
          };
          assertPolicyError(
            () =>
              validateFreeAgentDraftRolloverSequence({
                candidateDeadlineAtMs:
                  CANDIDATE_DEADLINE_AT_MS,
                rollovers: rows,
              }),
            {
              code:
                FREE_AGENT_DRAFT_POLICY_CODES
                  .rolloverSequenceInvalid,
              reasonCode: fixture.reason,
            }
          );
        }

        const extensionRows =
          persistedInitialRollovers();
        extensionRows.at(-1).status = "scheduled";
        extensionRows.push({
          id: uuid(107),
          sequence: 8,
          windowKind: "extension",
          predecessorRolloverId:
            extensionRows.at(-1).id,
          extensionReason: "recovery",
          extensionSourceId:
            EXTENSION_SOURCE_ID,
          opensAtMs:
            FIRST_MATCHUP_STARTS_AT_MS,
          creationCutoffAtMs:
            FIRST_MATCHUP_STARTS_AT_MS +
            FREE_AGENT_DRAFT_DAY_MS -
            FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
          rollsOverAtMs:
            FIRST_MATCHUP_STARTS_AT_MS +
            FREE_AGENT_DRAFT_DAY_MS,
          status: "scheduled",
        });
        assertPolicyError(
          () =>
            validateFreeAgentDraftRolloverSequence({
              candidateDeadlineAtMs:
                CANDIDATE_DEADLINE_AT_MS,
              rollovers: extensionRows,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .rolloverSequenceInvalid,
            reasonCode:
              "extension_predecessor_status_invalid",
          }
        );
      }
    );

    test(
      "returns no extension without durable fair-window work and plans the next exact contiguous extension when required",
      () => {
        const initial =
          persistedInitialRollovers();
        const notRequired =
          planNextFreeAgentDraftExtensionRollover({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: initial,
            requirement: null,
          });
        assert.deepEqual(notRequired, {
          required: false,
          reasonCode:
            "no_fair_window_required",
          rollover: null,
        });

        const required =
          planNextFreeAgentDraftExtensionRollover({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: initial,
            requirement: {
              reason: "queued_nomination",
              sourceId: EXTENSION_SOURCE_ID,
            },
          });
        assert.deepEqual(required, {
          required: true,
          reasonCode: "fair_window_required",
          rollover: {
            sequence: 8,
            windowKind: "extension",
            predecessorRolloverId:
              initial.at(-1).id,
            extensionReason:
              "queued_nomination",
            extensionSourceId:
              EXTENSION_SOURCE_ID,
            opensAtMs:
              FIRST_MATCHUP_STARTS_AT_MS,
            creationCutoffAtMs:
              FIRST_MATCHUP_STARTS_AT_MS +
              FREE_AGENT_DRAFT_DAY_MS -
              FREE_AGENT_DRAFT_CREATION_CUTOFF_MS,
            rollsOverAtMs:
              FIRST_MATCHUP_STARTS_AT_MS +
              FREE_AGENT_DRAFT_DAY_MS,
            status: "scheduled",
          },
        });
        assert.equal(
          Object.isFrozen(required),
          true
        );
        assert.equal(
          Object.isFrozen(required.rollover),
          true
        );
      }
    );

    test(
      "validates one and multiple extension rows and preserves exact 24-hour contiguity",
      () => {
        const rows =
          persistedInitialRollovers();
        const plan8 =
          planNextFreeAgentDraftExtensionRollover({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: rows,
            requirement: {
              reason: "fallback_auction",
              sourceId: uuid(200),
            },
          });
        rows.push({
          id: uuid(107),
          ...plan8.rollover,
          status: "completed",
        });
        const plan9 =
          planNextFreeAgentDraftExtensionRollover({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: rows,
            requirement: {
              reason: "recovery",
              sourceId: uuid(201),
            },
          });
        rows.push({
          id: uuid(108),
          ...plan9.rollover,
          status: "processing",
        });

        const validated =
          validateFreeAgentDraftRolloverSequence({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers: rows,
          });
        assert.equal(validated.length, 9);
        assert.equal(
          validated[7].rollsOverAtMs -
            validated[6].rollsOverAtMs,
          FREE_AGENT_DRAFT_DAY_MS
        );
        assert.equal(
          validated[8].rollsOverAtMs -
            validated[7].rollsOverAtMs,
          FREE_AGENT_DRAFT_DAY_MS
        );
      }
    );

    test(
      "rejects extension creation from a merely scheduled predecessor and malformed requirements",
      () => {
        assertPolicyError(
          () =>
            planNextFreeAgentDraftExtensionRollover({
              candidateDeadlineAtMs:
                CANDIDATE_DEADLINE_AT_MS,
              rollovers:
                persistedInitialRollovers({
                  statuses: Array(7).fill(
                    "scheduled"
                  ),
                }),
              requirement: {
                reason: "recovery",
                sourceId: EXTENSION_SOURCE_ID,
              },
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .extensionInvalid,
            reasonCode:
              "extension_predecessor_status_invalid",
          }
        );
        assertPolicyError(
          () =>
            planNextFreeAgentDraftExtensionRollover({
              candidateDeadlineAtMs:
                CANDIDATE_DEADLINE_AT_MS,
              rollovers:
                persistedInitialRollovers(),
              requirement: {
                reason: "ordinary_weekly",
                sourceId: EXTENSION_SOURCE_ID,
              },
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .extensionInvalid,
            reasonCode: "extension_reason_invalid",
          }
        );
      }
    );
  }
);

describe(
  "Free Agent Draft completion policy foundation",
  () => {
    test(
      "becomes eligible at the exact seventh completed rollover when every path is terminal",
      () => {
        const result =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput()
          );
        assert.deepEqual(result, {
          eligible: true,
          evaluatedAtMs:
            FIRST_MATCHUP_STARTS_AT_MS,
          seventhInitialRolloverAtMs:
            FIRST_MATCHUP_STARTS_AT_MS,
          latestRolloverAtMs:
            FIRST_MATCHUP_STARTS_AT_MS,
          reasonCodes: [],
        });
        assert.equal(Object.isFrozen(result), true);
        assert.equal(
          Object.isFrozen(result.reasonCodes),
          true
        );
      }
    );

    test(
      "does not complete one millisecond before the full seven-day window",
      () => {
        const result =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput({
              nowMs:
                FIRST_MATCHUP_STARTS_AT_MS -
                1,
            })
        );
        assert.equal(result.eligible, false);
        assert.deepEqual(result.reasonCodes, [
          "initial_window_not_elapsed",
        ]);
      }
    );

    test(
      "waits for each contiguous extension to elapse and complete",
      () => {
        const rollovers =
          persistedInitialRollovers();
        const extension =
          planNextFreeAgentDraftExtensionRollover({
            candidateDeadlineAtMs:
              CANDIDATE_DEADLINE_AT_MS,
            rollovers,
            requirement: {
              reason: "restricted_auction",
              sourceId: EXTENSION_SOURCE_ID,
            },
          }).rollover;
        rollovers.push({
          id: uuid(107),
          ...extension,
          status: "completed",
        });

        const before =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput({
              nowMs:
                extension.rollsOverAtMs - 1,
              rollovers,
            })
          );
        assert.deepEqual(before.reasonCodes, [
          "latest_rollover_not_elapsed",
        ]);

        const at =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput({
              nowMs: extension.rollsOverAtMs,
              rollovers,
            })
          );
        assert.equal(at.eligible, true);
        assert.equal(
          at.latestRolloverAtMs,
          extension.rollsOverAtMs
        );
      }
    );

    test(
      "reports every non-terminal lifecycle path in stable order",
      () => {
        const rollovers =
          persistedInitialRollovers();
        rollovers.at(-1).status =
          "recovery_required";
        const result =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput({
              status: "allocating",
              rollovers,
              cardStatuses: ["open"],
              allocationStatuses: [
                "restricted_active",
              ],
              nominationStatuses: ["queued"],
              auctionStatuses: ["failed"],
              recoveryStatuses: [
                "correction_required",
              ],
              unaccountedPathCount: 2,
              quarantinedPlayerCount: 1,
            })
          );

        assert.deepEqual(result.reasonCodes, [
          "fad_not_rapid",
          "rollover_not_completed",
          "card_not_locked",
          "allocation_not_terminal",
          "nomination_not_terminal",
          "auction_not_terminal",
          "recovery_not_resolved",
          "operational_path_not_accounted",
          "player_quarantined",
        ]);
        assert.equal(result.eligible, false);
      }
    );

    test(
      "treats completed as terminal rather than a second completion transition",
      () => {
        const result =
          evaluateFreeAgentDraftCompletionEligibility(
            completionInput({
              status: "completed",
            })
          );
        assert.deepEqual(result.reasonCodes, [
          "fad_already_completed",
        ]);
      }
    );

    test(
      "rejects unknown statuses and non-exact completion summaries",
      () => {
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftCompletionEligibility(
              completionInput({
                auctionStatuses: ["expired"],
              })
            ),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .inputInvalid,
            reasonCode: "auction_statuses_invalid",
          }
        );
        assertPolicyError(
          () =>
            evaluateFreeAgentDraftCompletionEligibility({
              ...completionInput(),
              hiddenPendingPath: false,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .inputInvalid,
            reasonCode: "input_fields_invalid",
          }
        );
      }
    );
  }
);

describe(
  "Free Agent Draft stable occurrence-key policy foundation",
  () => {
    test(
      "builds every approved FAD-owned occurrence form and parses it back immutably",
      () => {
        const cases = [
          {
            key:
              buildFreeAgentDraftReadinessOccurrenceKey({
                leagueId: LEAGUE_ID,
                seasonId: SEASON_ID,
                triggerResourceId:
                  TRIGGER_RESOURCE_ID,
              }),
            expectedKey:
              `fad-readiness:${LEAGUE_ID}:` +
              `${SEASON_ID}:${TRIGGER_RESOURCE_ID}`,
            expectedParsed: {
              type: "readiness",
              leagueId: LEAGUE_ID,
              seasonId: SEASON_ID,
              triggerResourceId:
                TRIGGER_RESOURCE_ID,
            },
          },
          {
            key:
              buildFreeAgentDraftEligibilityOccurrenceKey({
                fadId: FAD_ID,
                playerId: PLAYER_ID,
                sourceOperationId:
                  SOURCE_OPERATION_ID,
              }),
            expectedKey:
              `fad:${FAD_ID}:eligibility-revalidate:` +
              `${PLAYER_ID}:${SOURCE_OPERATION_ID}`,
            expectedParsed: {
              type: "eligibility_revalidate",
              fadId: FAD_ID,
              playerId: PLAYER_ID,
              sourceOperationId:
                SOURCE_OPERATION_ID,
            },
          },
          {
            key:
              buildFreeAgentDraftReminderOccurrenceKey({
                fadId: FAD_ID,
                reminderAtMs: 100,
              }),
            expectedKey:
              `fad:${FAD_ID}:reminder:100`,
            expectedParsed: {
              type: "reminder",
              fadId: FAD_ID,
              reminderAtMs: 100,
            },
          },
          {
            key:
              buildFreeAgentDraftDeadlineOccurrenceKey({
                fadId: FAD_ID,
                deadlineAtMs: 200,
              }),
            expectedKey:
              `fad:${FAD_ID}:deadline:200`,
            expectedParsed: {
              type: "deadline",
              fadId: FAD_ID,
              deadlineAtMs: 200,
            },
          },
          {
            key:
              buildFreeAgentDraftAllocationOccurrenceKey({
                fadId: FAD_ID,
                playerId: PLAYER_ID,
              }),
            expectedKey:
              `fad:${FAD_ID}:allocate:${PLAYER_ID}`,
            expectedParsed: {
              type: "allocate",
              fadId: FAD_ID,
              playerId: PLAYER_ID,
            },
          },
          {
            key:
              buildFreeAgentDraftRestrictedActivationOccurrenceKey({
                fadId: FAD_ID,
                allocationId: ALLOCATION_ID,
                activationAtMs: 300,
              }),
            expectedKey:
              `fad:${FAD_ID}:restricted-activate:` +
              `${ALLOCATION_ID}:300`,
            expectedParsed: {
              type: "restricted_activate",
              fadId: FAD_ID,
              allocationId: ALLOCATION_ID,
              activationAtMs: 300,
            },
          },
          {
            key:
              buildFreeAgentDraftFallbackActivationOccurrenceKey({
                fadId: FAD_ID,
                allocationId: ALLOCATION_ID,
                activationAtMs: 400,
              }),
            expectedKey:
              `fad:${FAD_ID}:fallback-activate:` +
              `${ALLOCATION_ID}:400`,
            expectedParsed: {
              type: "fallback_activate",
              fadId: FAD_ID,
              allocationId: ALLOCATION_ID,
              activationAtMs: 400,
            },
          },
          {
            key:
              buildFreeAgentDraftNominationOpenOccurrenceKey({
                fadId: FAD_ID,
                queueId: QUEUE_ID,
                rolloverAtMs: 500,
              }),
            expectedKey:
              `fad:${FAD_ID}:nomination-open:` +
              `${QUEUE_ID}:500`,
            expectedParsed: {
              type: "nomination_open",
              fadId: FAD_ID,
              queueId: QUEUE_ID,
              rolloverAtMs: 500,
            },
          },
          {
            key:
              buildFreeAgentDraftRolloverOccurrenceKey({
                fadId: FAD_ID,
                sequence: 7,
                rolloverAtMs: 600,
              }),
            expectedKey:
              `fad:${FAD_ID}:rollover:7:600`,
            expectedParsed: {
              type: "rollover",
              fadId: FAD_ID,
              sequence: 7,
              rolloverAtMs: 600,
            },
          },
          {
            key:
              buildFreeAgentDraftCompletionOccurrenceKey({
                fadId: FAD_ID,
              }),
            expectedKey:
              `fad:${FAD_ID}:complete`,
            expectedParsed: {
              type: "complete",
              fadId: FAD_ID,
            },
          },
        ];

        for (const fixture of cases) {
          assert.equal(
            fixture.key,
            fixture.expectedKey
          );
          const first =
            parseFreeAgentDraftOccurrenceKey(
              fixture.key
            );
          const afterRestart =
            parseFreeAgentDraftOccurrenceKey(
              `${fixture.key}`
            );
          assert.deepEqual(
            first,
            fixture.expectedParsed
          );
          assert.deepEqual(afterRestart, first);
          assert.equal(Object.isFrozen(first), true);
        }
      }
    );

    test(
      "rejects noncanonical numbers, uppercase IDs, unsupported forms, and unsafe builder inputs",
      () => {
        const invalidKeys = [
          {
            key:
              `fad:${FAD_ID}:rollover:07:600`,
            reasonCode:
              "rollover_sequence_invalid",
          },
          {
            key:
              "fad:AAAAAAAA-0000-4000-8000-" +
              "000000000004:complete",
            reasonCode: "fad_id_invalid",
          },
          {
            key: `fad:${FAD_ID}:weekly:1`,
            reasonCode:
              "occurrence_key_shape_invalid",
          },
        ];
        for (const fixture of invalidKeys) {
          assertPolicyError(
            () =>
              parseFreeAgentDraftOccurrenceKey(
                fixture.key
              ),
            {
              code:
                FREE_AGENT_DRAFT_POLICY_CODES
                  .occurrenceKeyInvalid,
              reasonCode: fixture.reasonCode,
            }
          );
        }

        assertPolicyError(
          () =>
            buildFreeAgentDraftCompletionOccurrenceKey({
              fadId: FAD_ID,
              retry: 1,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .occurrenceKeyInvalid,
            reasonCode:
              "occurrence_input_fields_invalid",
          }
        );
        assertPolicyError(
          () =>
            buildFreeAgentDraftRolloverOccurrenceKey({
              fadId: FAD_ID,
              sequence: 1,
              rolloverAtMs:
                Number.MAX_SAFE_INTEGER + 1,
            }),
          {
            code:
              FREE_AGENT_DRAFT_POLICY_CODES
                .occurrenceKeyInvalid,
            reasonCode:
              "rollover_at_ms_invalid",
          }
        );
      }
    );
  }
);
