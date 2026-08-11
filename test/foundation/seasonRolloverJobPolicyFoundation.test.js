const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
  SEASON_ROLLOVER_JOB_CODES,
  buildSeasonRolloverOccurrenceKey,
  parseSeasonRolloverOccurrenceKey,
} = require(
  "../../src/domain/leagues/seasonRolloverJobPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const LEAGUE_ID = uuid(1);
const ENTRY_DRAFT_ID = uuid(2);
const OCCURRENCE_ID = uuid(3);
const SCHEDULED_FOR_MS =
  Date.parse("2027-07-15T16:00:00.000Z");

function input(overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    entryDraftId: ENTRY_DRAFT_ID,
    rolloverOccurrenceId: OCCURRENCE_ID,
    scheduledForMs: SCHEDULED_FOR_MS,
    ...overrides,
  };
}

function assertInvalid(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TypeError);
    assert.equal(
      error.code,
      SEASON_ROLLOVER_JOB_CODES.inputInvalid
    );
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe(
  "T-037 season-rollover job occurrence policy",
  () => {
    test("builds and round-trips one immutable canonical occurrence", () => {
      const occurrenceKey =
        buildSeasonRolloverOccurrenceKey(input());
      assert.equal(
        occurrenceKey,
        [
          ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
          LEAGUE_ID,
          ENTRY_DRAFT_ID,
          OCCURRENCE_ID,
          SCHEDULED_FOR_MS,
        ].join(":")
      );
      const parsed =
        parseSeasonRolloverOccurrenceKey({
          leagueId: LEAGUE_ID,
          entryDraftId: ENTRY_DRAFT_ID,
          rolloverOccurrenceId:
            OCCURRENCE_ID,
          occurrenceKey,
          scheduledForMs:
            SCHEDULED_FOR_MS,
        });
      assert.deepEqual(parsed, {
        jobType:
          ENTRY_DRAFT_ROLLOVER_JOB_TYPE,
        leagueId: LEAGUE_ID,
        entryDraftId: ENTRY_DRAFT_ID,
        rolloverOccurrenceId:
          OCCURRENCE_ID,
        scheduledForMs:
          SCHEDULED_FOR_MS,
      });
      assert.equal(Object.isFrozen(parsed), true);
    });

    test("binds league, draft, occurrence, and scheduled instant", () => {
      const occurrenceKey =
        buildSeasonRolloverOccurrenceKey(input());
      for (const candidate of [
        {
          leagueId: uuid(4),
          entryDraftId: ENTRY_DRAFT_ID,
          rolloverOccurrenceId:
            OCCURRENCE_ID,
          occurrenceKey,
          scheduledForMs:
            SCHEDULED_FOR_MS,
          reason:
            "occurrence_key_scope_mismatch",
        },
        {
          leagueId: LEAGUE_ID,
          entryDraftId: ENTRY_DRAFT_ID,
          rolloverOccurrenceId:
            OCCURRENCE_ID,
          occurrenceKey,
          scheduledForMs:
            SCHEDULED_FOR_MS + 1,
          reason:
            "occurrence_key_time_mismatch",
        },
        {
          leagueId: LEAGUE_ID,
          entryDraftId: ENTRY_DRAFT_ID,
          rolloverOccurrenceId:
            OCCURRENCE_ID,
          occurrenceKey:
            occurrenceKey.replace(
              ENTRY_DRAFT_ID,
              uuid(5)
            ),
          scheduledForMs:
            SCHEDULED_FOR_MS,
          reason:
            "occurrence_key_scope_mismatch",
        },
      ]) {
        assertInvalid(
          () =>
            parseSeasonRolloverOccurrenceKey(
              candidate
            ),
          candidate.reason
        );
      }
    });

    test("rejects malformed identifiers, timestamps, and key framing", () => {
      for (const [key, value, reason] of [
        ["leagueId", "league", "league_id_invalid"],
        [
          "entryDraftId",
          null,
          "entry_draft_id_invalid",
        ],
        [
          "rolloverOccurrenceId",
          "",
          "rollover_occurrence_id_invalid",
        ],
        [
          "scheduledForMs",
          -1,
          "scheduled_for_ms_invalid",
        ],
      ]) {
        assertInvalid(
          () =>
            buildSeasonRolloverOccurrenceKey(
              input({ [key]: value })
            ),
          reason
        );
      }

      for (const { occurrenceKey, reason } of [
        {
          occurrenceKey: "",
          reason: "occurrence_key_invalid",
        },
        {
          occurrenceKey: "bad",
          reason:
            "occurrence_key_scope_mismatch",
        },
        {
          occurrenceKey:
            `${ENTRY_DRAFT_ROLLOVER_JOB_TYPE}:` +
            LEAGUE_ID,
          reason:
            "occurrence_key_scope_mismatch",
        },
        {
          occurrenceKey:
            `${ENTRY_DRAFT_ROLLOVER_JOB_TYPE}:` +
            `${LEAGUE_ID}:${ENTRY_DRAFT_ID}:` +
            `bad:${SCHEDULED_FOR_MS}`,
          reason:
            "rollover_occurrence_id_invalid",
        },
      ]) {
        assertInvalid(
          () =>
            parseSeasonRolloverOccurrenceKey({
              leagueId: LEAGUE_ID,
              entryDraftId: ENTRY_DRAFT_ID,
              rolloverOccurrenceId:
                OCCURRENCE_ID,
              occurrenceKey,
              scheduledForMs:
                SCHEDULED_FOR_MS,
            }),
          reason
        );
      }
    });
  }
);
