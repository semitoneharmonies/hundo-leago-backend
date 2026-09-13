const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ENTRY_DRAFT_RESCHEDULE_ACTION,
  ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
  ENTRY_DRAFT_SCHEDULE_OPERATION,
  EntryDraftSchedulePolicyError,
  entryDraftScheduleRequestHash,
  serializeEntryDraftScheduleRequest,
  validateEntryDraftScheduleDraftId,
  validateEntryDraftScheduleExpectedVersion,
  validateEntryDraftScheduleFuture,
  validateEntryDraftScheduleIdempotencyKey,
  validateEntryDraftScheduleInput,
  validateEntryDraftScheduleLeagueId,
} = require(
  "../../src/domain/drafts/entryDraftSchedulePolicy"
);

const LEAGUE_ID =
  "00000000-0000-4000-8000-000000000001";
const DRAFT_ID =
  "00000000-0000-4000-8000-000000000002";
const NOW_MS = Date.parse(
  "2026-07-29T16:00:00.000Z"
);
const STARTS_AT_MS =
  NOW_MS + 7 * 24 * 60 * 60 * 1000;

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof EntryDraftSchedulePolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("Entry Draft schedule policy foundation", () => {
  test("accepts the exact initial schedule body", () => {
    assert.deepEqual(
      validateEntryDraftScheduleInput({
        action: ENTRY_DRAFT_SCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
      }),
      {
        action: ENTRY_DRAFT_SCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        reason: null,
      }
    );
  });

  test("accepts the exact reschedule body and bounded reason", () => {
    assert.deepEqual(
      validateEntryDraftScheduleInput({
        action: ENTRY_DRAFT_RESCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
        reason: "Move to the confirmed league date.",
      }),
      {
        action: ENTRY_DRAFT_RESCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_RESCHEDULE_CONFIRMATION,
        reason: "Move to the confirmed league date.",
      }
    );
  });

  test("rejects unknown, missing, and mismatched body fields", () => {
    for (const [value, reasonCode] of [
      [null, "body_invalid"],
      [
        {
          action: ENTRY_DRAFT_SCHEDULE_ACTION,
          scheduledStartsAtMs: STARTS_AT_MS,
        },
        "body_fields_invalid",
      ],
      [
        {
          action: ENTRY_DRAFT_SCHEDULE_ACTION,
          scheduledStartsAtMs: STARTS_AT_MS,
          confirmation:
            ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
          sourceSeasonId: LEAGUE_ID,
        },
        "body_fields_invalid",
      ],
      [
        {
          action: "start",
          scheduledStartsAtMs: STARTS_AT_MS,
          confirmation:
            ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        },
        "action_invalid",
      ],
      [
        {
          action: ENTRY_DRAFT_RESCHEDULE_ACTION,
          scheduledStartsAtMs: STARTS_AT_MS,
          confirmation:
            ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        },
        "confirmation_invalid",
      ],
      [
        {
          action: ENTRY_DRAFT_SCHEDULE_ACTION,
          scheduledStartsAtMs: -1,
          confirmation:
            ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        },
        "scheduled_starts_at_ms_invalid",
      ],
      [
        {
          action: ENTRY_DRAFT_SCHEDULE_ACTION,
          scheduledStartsAtMs: STARTS_AT_MS,
          confirmation:
            ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
          reason: " padded ",
        },
        "reason_invalid",
      ],
    ]) {
      assertPolicyError(
        () => validateEntryDraftScheduleInput(value),
        {
          code:
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
          reasonCode,
        }
      );
    }
  });

  test("validates path IDs, draft version, and idempotency key", () => {
    assert.equal(
      validateEntryDraftScheduleLeagueId(LEAGUE_ID),
      LEAGUE_ID
    );
    assert.equal(
      validateEntryDraftScheduleDraftId(DRAFT_ID),
      DRAFT_ID
    );
    assert.equal(
      validateEntryDraftScheduleExpectedVersion(3),
      3
    );
    assert.equal(
      validateEntryDraftScheduleIdempotencyKey(
        "schedule-2027"
      ),
      "schedule-2027"
    );

    for (const [callback, reasonCode] of [
      [
        () =>
          validateEntryDraftScheduleLeagueId(
            "not-a-uuid"
          ),
        "league_id_invalid",
      ],
      [
        () =>
          validateEntryDraftScheduleDraftId(
            "not-a-uuid"
          ),
        "entry_draft_id_invalid",
      ],
      [
        () =>
          validateEntryDraftScheduleExpectedVersion(0),
        "expected_version_invalid",
      ],
      [
        () =>
          validateEntryDraftScheduleIdempotencyKey(
            " padded "
          ),
        "idempotency_key_invalid",
      ],
    ]) {
      assertPolicyError(callback, {
        code: "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
        reasonCode,
      });
    }
  });

  test("requires a strictly future scheduled instant", () => {
    assert.equal(
      validateEntryDraftScheduleFuture({
        scheduledStartsAtMs: STARTS_AT_MS,
        nowMs: NOW_MS,
      }),
      STARTS_AT_MS
    );

    for (const scheduledStartsAtMs of [
      NOW_MS,
      NOW_MS - 1,
    ]) {
      assertPolicyError(
        () =>
          validateEntryDraftScheduleFuture({
            scheduledStartsAtMs,
            nowMs: NOW_MS,
          }),
        {
          code: "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE",
          reasonCode:
            "scheduled_starts_at_ms_not_future",
        }
      );
    }
  });

  test("serializes and hashes one stable scoped request", () => {
    const request = {
      leagueId: LEAGUE_ID,
      entryDraftId: DRAFT_ID,
      input: {
        action: ENTRY_DRAFT_SCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
      },
    };
    assert.equal(
      serializeEntryDraftScheduleRequest(request),
      JSON.stringify({
        operation: ENTRY_DRAFT_SCHEDULE_OPERATION,
        leagueId: LEAGUE_ID,
        entryDraftId: DRAFT_ID,
        action: ENTRY_DRAFT_SCHEDULE_ACTION,
        scheduledStartsAtMs: STARTS_AT_MS,
        confirmation:
          ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        reason: null,
      })
    );
    const hash = entryDraftScheduleRequestHash(request);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(
      entryDraftScheduleRequestHash(request),
      hash
    );
    assert.notEqual(
      entryDraftScheduleRequestHash({
        ...request,
        input: {
          ...request.input,
          scheduledStartsAtMs: STARTS_AT_MS + 1,
        },
      }),
      hash
    );
  });
});
