const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  FANTASY_PLAYOFF_DURATION_MS,
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  LEAGUE_LIFECYCLE_TRANSITION_CODES,
  LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
  LeagueLifecycleTransitionPolicyError,
  MAXIMUM_EXEMPTION_REASON_LENGTH,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  deriveCanonicalNextNhlSeason,
  leagueLifecycleTransitionRequestHash,
  serializeLeagueLifecycleTransitionRequest,
  validateCanonicalConsecutiveNhlSeason,
  validateLeagueLifecycleTransitionExpectedVersion,
  validateLeagueLifecycleTransitionIdempotencyKey,
  validateLeagueLifecycleTransitionInput,
  validateScheduledEntryDraftRolloverInput,
  validateSeasonRolloverCalendar,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const LEAGUE_ID = uuid(1);
const OTHER_LEAGUE_ID = uuid(2);
const ACTOR_USER_ID = uuid(3);
const OTHER_ACTOR_USER_ID = uuid(4);
const SOURCE_SEASON_ID = uuid(10);
const ENTRY_DRAFT_ID = uuid(20);
const OTHER_ENTRY_DRAFT_ID = uuid(21);
const OCCURRENCE_ID = uuid(30);
const OTHER_OCCURRENCE_ID = uuid(31);
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAGUE_TIME_ZONE = "America/Vancouver";
const SOURCE_REGULAR_STARTS_AT_MS =
  Date.UTC(2026, 9, 5);
const SOURCE_PLAYOFFS_START_AT_MS =
  Date.UTC(2027, 2, 8);
const SOURCE_ENDS_AT_MS =
  SOURCE_PLAYOFFS_START_AT_MS +
  FANTASY_PLAYOFF_DURATION_MS;
const ENTRY_DRAFT_STARTS_AT_MS =
  Date.UTC(2027, 6, 15);
const TARGET_REGULAR_STARTS_AT_MS =
  Date.UTC(2027, 9, 1);
const TARGET_PLAYOFFS_START_AT_MS =
  Date.UTC(2028, 2, 6, 8);
const TARGET_ENDS_AT_MS =
  TARGET_PLAYOFFS_START_AT_MS +
  FANTASY_PLAYOFF_DURATION_MS;
const WEEK_ONE_STARTS_AT_MS =
  Date.UTC(2027, 9, 4, 7);

function retryInput(overrides = {}) {
  return {
    transitionType:
      RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
    entryDraftId: ENTRY_DRAFT_ID,
    rolloverOccurrenceId: OCCURRENCE_ID,
    ...overrides,
  };
}

function scheduledInput(overrides = {}) {
  return {
    transitionType:
      EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
    entryDraftId: ENTRY_DRAFT_ID,
    rolloverOccurrenceId: OCCURRENCE_ID,
    ...overrides,
  };
}

function exemptionInput(overrides = {}) {
  return {
    transitionType:
      INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
    seasonId: SOURCE_SEASON_ID,
    reason:
      "The Entry Draft is unavailable for this one transition.",
    confirmation:
      INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
    ...overrides,
  };
}

function sourceCalendar(overrides = {}) {
  return {
    nhlSeasonKey: "20262027",
    nhlRegularSeasonStartsAtMs:
      SOURCE_REGULAR_STARTS_AT_MS,
    nhlRegularSeasonEndsAtMs:
      SOURCE_ENDS_AT_MS,
    fantasyPlayoffsStartAtMs:
      SOURCE_PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      SOURCE_ENDS_AT_MS,
    ...overrides,
  };
}

function targetCalendar(overrides = {}) {
  return {
    nhlSeasonKey: "20272028",
    nhlRegularSeasonStartsAtMs:
      TARGET_REGULAR_STARTS_AT_MS,
    nhlRegularSeasonEndsAtMs:
      TARGET_ENDS_AT_MS,
    fantasyPlayoffsStartAtMs:
      TARGET_PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      TARGET_ENDS_AT_MS,
    ...overrides,
  };
}

function rolloverCalendar(overrides = {}) {
  return {
    leagueTimeZone: LEAGUE_TIME_ZONE,
    source: sourceCalendar(),
    target: targetCalendar(),
    entryDraftStartsAtMs:
      ENTRY_DRAFT_STARTS_AT_MS,
    attemptedAtMs: ENTRY_DRAFT_STARTS_AT_MS,
    weekOneStartsAtMs: WEEK_ONE_STARTS_AT_MS,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    actorUserId: ACTOR_USER_ID,
    leagueId: LEAGUE_ID,
    input: retryInput(),
    expectedDraftVersion: 7,
    ...overrides,
  };
}

function omit(value, key) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([candidate]) => candidate !== key
    )
  );
}

function assertPolicyError(
  action,
  code,
  reasonCode
) {
  assert.throws(action, (error) => {
    assert.ok(
      error instanceof
        LeagueLifecycleTransitionPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function assertInputError(action, reasonCode) {
  assertPolicyError(
    action,
    LEAGUE_LIFECYCLE_TRANSITION_CODES.inputInvalid,
    reasonCode
  );
}

describe(
  "T-037 scheduled Entry Draft-start rollover policy",
  () => {
    test("accepts only the persisted retry identity on the public lifecycle route", () => {
      const input = retryInput();
      const before = JSON.stringify(input);
      assert.deepEqual(
        validateLeagueLifecycleTransitionInput(input),
        input
      );
      assert.equal(JSON.stringify(input), before);
      assert.equal(
        Object.isFrozen(
          validateLeagueLifecycleTransitionInput(
            input
          )
        ),
        true
      );

      for (const invalid of [
        scheduledInput(),
        {
          transitionType:
            "complete_and_roll_over_season",
          fromSeasonId: SOURCE_SEASON_ID,
        },
        {
          ...retryInput(),
          targetSeasonId: uuid(40),
        },
        {
          ...retryInput(),
          attemptedAtMs:
            ENTRY_DRAFT_STARTS_AT_MS,
        },
        {
          ...retryInput(),
          confirmation:
            "COMPLETE SEASON AND ROLL OVER",
        },
      ]) {
        assertInputError(
          () =>
            validateLeagueLifecycleTransitionInput(
              invalid
            ),
          invalid.transitionType ===
            RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
            ? "body_invalid"
            : "transition_type_invalid"
        );
      }
    });

    test("accepts the scheduled identity only through the internal validator", () => {
      const input = scheduledInput();
      assert.deepEqual(
        validateScheduledEntryDraftRolloverInput(
          input
        ),
        input
      );
      for (const invalid of [
        retryInput(),
        omit(input, "entryDraftId"),
        omit(input, "rolloverOccurrenceId"),
        { ...input, calendar: targetCalendar() },
      ]) {
        assertInputError(
          () =>
            validateScheduledEntryDraftRolloverInput(
              invalid
            ),
          invalid.transitionType !==
            EXECUTE_SCHEDULED_ENTRY_DRAFT_ROLLOVER
            ? "transition_type_invalid"
            : "body_invalid"
        );
      }
    });

    test("validates exact draft and occurrence UUIDs", () => {
      for (const key of [
        "entryDraftId",
        "rolloverOccurrenceId",
      ]) {
        for (const value of [
          undefined,
          null,
          "",
          "not-a-uuid",
          uuid(1).replace(/^0/, "A"),
        ]) {
          assertInputError(
            () =>
              validateLeagueLifecycleTransitionInput(
                retryInput({ [key]: value })
              ),
            key === "entryDraftId"
              ? "entry_draft_id_invalid"
              : "rollover_occurrence_id_invalid"
          );
        }
      }
    });

    test("retains the exact one-time Season 2 exemption command", () => {
      const input = exemptionInput();
      assert.deepEqual(
        validateLeagueLifecycleTransitionInput(input),
        input
      );
      for (const value of [
        omit(input, "reason"),
        { ...input, extra: true },
      ]) {
        assertInputError(
          () =>
            validateLeagueLifecycleTransitionInput(
              value
            ),
          "body_invalid"
        );
      }
      for (const reason of [
        "",
        " ",
        " padded",
        "padded ",
        "unsafe\nreason",
        "\uD800",
        "x".repeat(
          MAXIMUM_EXEMPTION_REASON_LENGTH + 1
        ),
      ]) {
        assertInputError(
          () =>
            validateLeagueLifecycleTransitionInput(
              exemptionInput({ reason })
            ),
          "reason_invalid"
        );
      }
    });

    test("requires draft If-Match for retry and forbids it for the exemption", () => {
      assert.equal(
        validateLeagueLifecycleTransitionExpectedVersion(
          7,
          RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
        ),
        7
      );
      assert.equal(
        validateLeagueLifecycleTransitionExpectedVersion(
          null,
          INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
        ),
        null
      );
      for (const version of [
        undefined,
        null,
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        assertInputError(
          () =>
            validateLeagueLifecycleTransitionExpectedVersion(
              version,
              RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER
            ),
          "expected_draft_version_invalid"
        );
      }
      assertInputError(
        () =>
          validateLeagueLifecycleTransitionExpectedVersion(
            1,
            INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
          ),
        "if_match_forbidden"
      );
    });

    test("validates bounded opaque idempotency keys", () => {
      assert.equal(
        validateLeagueLifecycleTransitionIdempotencyKey(
          "retry-occurrence-1"
        ),
        "retry-occurrence-1"
      );
      assert.equal(
        validateLeagueLifecycleTransitionIdempotencyKey(
          "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH)
        ).length,
        MAXIMUM_IDEMPOTENCY_KEY_LENGTH
      );
      for (const key of [
        undefined,
        null,
        "",
        " ",
        " padded",
        "padded ",
        "unsafe\nkey",
        "k".repeat(
          MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1
        ),
      ]) {
        assertInputError(
          () =>
            validateLeagueLifecycleTransitionIdempotencyKey(
              key
            ),
          "idempotency_key_invalid"
        );
      }
    });

    test("validates persisted calendars at or after the scheduled occurrence without a Candidate lead rule", () => {
      const value = rolloverCalendar({
        attemptedAtMs:
          ENTRY_DRAFT_STARTS_AT_MS + DAY_MS,
      });
      const before = JSON.stringify(value);
      const result =
        validateSeasonRolloverCalendar(value);
      assert.deepEqual(result, {
        leagueTimeZone: LEAGUE_TIME_ZONE,
        source: sourceCalendar(),
        target: targetCalendar(),
        targetIdentity: {
          nhlSeasonKey: "20272028",
          label: "2027-28",
        },
        entryDraftStartsAtMs:
          ENTRY_DRAFT_STARTS_AT_MS,
        attemptedAtMs:
          ENTRY_DRAFT_STARTS_AT_MS + DAY_MS,
        weekOneStartsAtMs:
          WEEK_ONE_STARTS_AT_MS,
      });
      assert.equal(JSON.stringify(value), before);
      assert.equal(Object.isFrozen(result), true);
    });

    test("rejects early execution, pre-end drafts, overlapping targets, and invalid Week 1 boundaries", () => {
      const cases = [
        {
          value: rolloverCalendar({
            attemptedAtMs:
              ENTRY_DRAFT_STARTS_AT_MS - 1,
          }),
          reason: "scheduled_occurrence_not_due",
        },
        {
          value: rolloverCalendar({
            entryDraftStartsAtMs:
              SOURCE_ENDS_AT_MS - 1,
            attemptedAtMs:
              SOURCE_ENDS_AT_MS - 1,
          }),
          reason:
            "entry_draft_precedes_source_end",
        },
        {
          value: rolloverCalendar({
            target: targetCalendar({
              nhlRegularSeasonStartsAtMs:
                SOURCE_ENDS_AT_MS,
            }),
          }),
          reason:
            "target_calendar_overlaps_transition",
        },
        {
          value: rolloverCalendar({
            entryDraftStartsAtMs:
              TARGET_REGULAR_STARTS_AT_MS,
            attemptedAtMs:
              TARGET_REGULAR_STARTS_AT_MS,
          }),
          reason:
            "target_calendar_overlaps_transition",
        },
        {
          value: rolloverCalendar({
            weekOneStartsAtMs:
              WEEK_ONE_STARTS_AT_MS + DAY_MS,
          }),
          reason:
            "target_week_one_boundary_invalid",
        },
        {
          value: rolloverCalendar({
            weekOneStartsAtMs:
              TARGET_PLAYOFFS_START_AT_MS,
          }),
          reason: "target_week_one_not_feasible",
        },
      ];
      for (const { value, reason } of cases) {
        assertPolicyError(
          () =>
            validateSeasonRolloverCalendar(value),
          LEAGUE_LIFECYCLE_TRANSITION_CODES
            .rolloverNotReady,
          reason
        );
      }
    });

    test("validates canonical consecutive season identity", () => {
      assert.deepEqual(
        deriveCanonicalNextNhlSeason("20262027"),
        {
          nhlSeasonKey: "20272028",
          label: "2027-28",
        }
      );
      assert.deepEqual(
        validateCanonicalConsecutiveNhlSeason({
          sourceNhlSeasonKey: "20992100",
          targetNhlSeasonKey: "21002101",
        }),
        {
          nhlSeasonKey: "21002101",
          label: "2100-01",
        }
      );
      assertPolicyError(
        () =>
          validateCanonicalConsecutiveNhlSeason({
            sourceNhlSeasonKey: "20262027",
            targetNhlSeasonKey: "20282029",
          }),
        LEAGUE_LIFECYCLE_TRANSITION_CODES
          .rolloverNotReady,
        "target_nhl_season_key_not_consecutive"
      );
    });

    test("hashes only the actor, route, persisted retry identity, and draft version", () => {
      const value = binding();
      const serialized =
        serializeLeagueLifecycleTransitionRequest(
          value
        );
      const expected = JSON.stringify({
        actorUserId: ACTOR_USER_ID,
        expectedDraftVersion: 7,
        input: retryInput(),
        leagueId: LEAGUE_ID,
        operation:
          LEAGUE_LIFECYCLE_TRANSITION_OPERATION,
      });
      assert.equal(serialized, expected);
      assert.equal(
        leagueLifecycleTransitionRequestHash(value),
        crypto
          .createHash("sha256")
          .update(expected, "utf8")
          .digest("hex")
      );
      const variants = [
        binding({
          actorUserId: OTHER_ACTOR_USER_ID,
        }),
        binding({ leagueId: OTHER_LEAGUE_ID }),
        binding({ expectedDraftVersion: 8 }),
        binding({
          input: retryInput({
            entryDraftId: OTHER_ENTRY_DRAFT_ID,
          }),
        }),
        binding({
          input: retryInput({
            rolloverOccurrenceId:
              OTHER_OCCURRENCE_ID,
          }),
        }),
      ];
      for (const variant of variants) {
        assert.notEqual(
          leagueLifecycleTransitionRequestHash(
            variant
          ),
          leagueLifecycleTransitionRequestHash(
            value
          )
        );
      }
    });

    test("rejects partial or header-confused request bindings", () => {
      for (const value of [
        omit(binding(), "actorUserId"),
        omit(binding(), "leagueId"),
        omit(binding(), "input"),
        omit(binding(), "expectedDraftVersion"),
        {
          ...binding(),
          idempotencyKey: "not-hashed-here",
        },
        {
          ...binding(),
          expectedSeasonVersion: 7,
        },
      ]) {
        assertInputError(
          () =>
            leagueLifecycleTransitionRequestHash(
              value
            ),
          "request_binding_invalid"
        );
      }
    });
  }
);
