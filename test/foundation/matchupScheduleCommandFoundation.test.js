const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MATCHUP_SCHEDULE_COMMAND_OPERATION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
  hashMatchupScheduleCommandRequest,
  hashMatchupScheduleCommandResponse,
  hashMatchupScheduleShiftWeekOneRequest,
  hashMatchupScheduleShiftWeekOneResponse,
  matchupScheduleShiftWeekOneRequestProjection,
  matchupScheduleShiftWeekOneResponseProjection,
  serializeMatchupScheduleCommandRequest,
  serializeMatchupScheduleCommandResponse,
  serializeMatchupScheduleShiftWeekOneRequest,
  serializeMatchupScheduleShiftWeekOneResponse,
  validateMatchupScheduleCommandExpectedVersion,
  validateMatchupScheduleCommandIdempotencyKey,
  validateMatchupScheduleShiftExpectedWeekVersion,
  validateMatchupScheduleShiftWeekOneInput,
  validateMatchupScheduleShiftWeekOneResult,
  validateMatchupScheduleShiftWeekOneWeekId,
} = require(
  "../../src/domain/matchups/matchupScheduleCommandPolicy"
);
const {
  createMatchupScheduleService,
} = require(
  "../../src/application/services/matchups/createMatchupScheduleService"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const SEASON_ID =
  "22222222-2222-4222-8222-222222222222";
const OPERATION_ID =
  "33333333-3333-4333-8333-333333333333";
const FIRST_WEEK_ID =
  "44444444-4444-4444-8444-444444444444";
const ACTOR_USER_ID =
  "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ID =
  "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_REQUEST_ID =
  "77777777-7777-4777-8777-777777777777";
const COMMAND_RESULT_ID =
  "88888888-8888-4888-8888-888888888888";
const SHIFT_OPERATION_ID =
  "99999999-9999-4999-8999-999999999999";
const IDEMPOTENCY_KEY =
  "summer/2026:matchup-schedule";
const NOW_MS = 1_790_000_000_000;
const INPUT = Object.freeze({
  nhlRegularSeasonStartsAtMs:
    1_788_246_000_000,
  nhlRegularSeasonEndsAtMs:
    1_804_489_200_000,
  fantasyPlayoffsStartAtMs:
    1_802_070_000_000,
  fantasyPlayoffsEndAtMs:
    1_804_489_200_000,
  firstWeekStartsAtMs:
    1_791_183_600_000,
  confirmed: true,
});
const REQUEST = Object.freeze({
  leagueId: LEAGUE_ID,
  seasonId: SEASON_ID,
  expectedSeasonVersion: 7,
  input: INPUT,
});
const RESULT = Object.freeze({
  operationId: OPERATION_ID,
  seasonId: SEASON_ID,
  seasonVersion: 8,
  nhlRegularSeasonStartsAtMs:
    INPUT.nhlRegularSeasonStartsAtMs,
  nhlRegularSeasonEndsAtMs:
    INPUT.nhlRegularSeasonEndsAtMs,
  fantasyPlayoffsStartAtMs:
    INPUT.fantasyPlayoffsStartAtMs,
  fantasyPlayoffsEndAtMs:
    INPUT.fantasyPlayoffsEndAtMs,
  calendarPersisted: false,
  firstWeekId: FIRST_WEEK_ID,
  firstWeekStartsAtMs:
    INPUT.firstWeekStartsAtMs,
  participantCount: 5,
  weekCount: 22,
  matchupCount: 44,
  byeCount: 22,
  lastWeekEndsAtMs:
    INPUT.fantasyPlayoffsStartAtMs,
});
const REQUEST_CANONICAL_JSON =
  '{"body":{"confirmed":true,"fantasyPlayoffsEndAtMs":1804489200000,"fantasyPlayoffsStartAtMs":1802070000000,"firstWeekStartsAtMs":1791183600000,"nhlRegularSeasonEndsAtMs":1804489200000,"nhlRegularSeasonStartsAtMs":1788246000000},"domain":"hundo-leago.matchup-schedule-command-request","leagueId":"11111111-1111-4111-8111-111111111111","operation":"matchup.schedule.generate.v1","precondition":{"kind":"season","version":7},"schemaVersion":1,"seasonId":"22222222-2222-4222-8222-222222222222"}';
const REQUEST_SHA256 =
  "3206f71291fda33d4fc66ffae3b71b6a4e08f12660d7cf45b33504c896a41e66";
const RESPONSE_CANONICAL_JSON =
  '{"data":{"code":"MATCHUP_SCHEDULE_GENERATED","result":{"byeCount":22,"calendarPersisted":false,"fantasyPlayoffsEndAtMs":1804489200000,"fantasyPlayoffsStartAtMs":1802070000000,"firstWeekId":"44444444-4444-4444-8444-444444444444","firstWeekStartsAtMs":1791183600000,"lastWeekEndsAtMs":1802070000000,"matchupCount":44,"nhlRegularSeasonEndsAtMs":1804489200000,"nhlRegularSeasonStartsAtMs":1788246000000,"operationId":"33333333-3333-4333-8333-333333333333","participantCount":5,"seasonId":"22222222-2222-4222-8222-222222222222","seasonVersion":8,"weekCount":22}},"domain":"hundo-leago.matchup-schedule-command-response","httpStatus":201,"schemaVersion":1}';
const RESPONSE_SHA256 =
  "5d92a6e2b58657f59153f5ce797f847819dabb59c1190c7e4a77e8f9931f4f05";
const SHIFT_INPUT = Object.freeze({
  action: "shift_week_one",
  firstWeekStartsAtMs: 1_790_578_800_000,
  confirmation: "CHANGE WEEK 1 START",
});
const SHIFT_REQUEST = Object.freeze({
  leagueId: LEAGUE_ID,
  seasonId: SEASON_ID,
  weekId: FIRST_WEEK_ID,
  expectedWeekVersion: 1,
  input: SHIFT_INPUT,
});
const SHIFT_RESULT = Object.freeze({
  operationId: SHIFT_OPERATION_ID,
  seasonId: SEASON_ID,
  seasonVersion: 9,
  weekId: FIRST_WEEK_ID,
  weekVersion: 2,
  previousFirstWeekStartsAtMs:
    INPUT.firstWeekStartsAtMs,
  firstWeekStartsAtMs:
    SHIFT_INPUT.firstWeekStartsAtMs,
  lastWeekEndsAtMs: 1_801_465_200_000,
  shiftedWeekCount: 22,
  replacedJobOccurrenceCount: 132,
});
const SHIFT_REQUEST_CANONICAL_JSON =
  '{"body":{"action":"shift_week_one","confirmation":"CHANGE WEEK 1 START","firstWeekStartsAtMs":1790578800000},"domain":"hundo-leago.matchup-schedule-command-request","leagueId":"11111111-1111-4111-8111-111111111111","operation":"matchup.schedule.shift_week_one.v1","precondition":{"kind":"week","version":1},"schemaVersion":1,"seasonId":"22222222-2222-4222-8222-222222222222","weekId":"44444444-4444-4444-8444-444444444444"}';
const SHIFT_REQUEST_SHA256 =
  "efe1f25b15790a47f6f42778130ffecdc6afd4966d1a74ba8a1246bab888a4f0";
const SHIFT_RESPONSE_CANONICAL_JSON =
  '{"data":{"firstWeekStartsAtMs":1790578800000,"lastWeekEndsAtMs":1801465200000,"operationId":"99999999-9999-4999-8999-999999999999","previousFirstWeekStartsAtMs":1791183600000,"replacedJobOccurrenceCount":132,"seasonId":"22222222-2222-4222-8222-222222222222","seasonVersion":9,"shiftedWeekCount":22,"weekId":"44444444-4444-4444-8444-444444444444","weekVersion":2},"domain":"hundo-leago.matchup-schedule-command-response","httpStatus":200,"schemaVersion":1}';
const SHIFT_RESPONSE_SHA256 =
  "7831b0d08bfa49a3acc3adc9dc34abb01caa0649a833aefb318ccd5de093c623";

function durableRow(requestHash = REQUEST_SHA256) {
  return Object.freeze({
    id: COMMAND_RESULT_ID,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    action: "generate",
    idempotencyRequestId:
      IDEMPOTENCY_REQUEST_ID,
    idempotencyOperation:
      MATCHUP_SCHEDULE_COMMAND_OPERATION,
    requestSha256: requestHash,
    matchupOperationId: OPERATION_ID,
    actorUserId: ACTOR_USER_ID,
    actorMembershipId: MEMBERSHIP_ID,
    actorAuthority: "commissioner",
    oldScheduleOperationId: null,
    oldScheduleVersion: null,
    newScheduleOperationId: OPERATION_ID,
    newScheduleVersion: 1,
    seasonVersionBefore: 7,
    seasonVersionAfter: 8,
    weekOneMatchupWeekId: FIRST_WEEK_ID,
    weekVersionBefore: null,
    weekVersionAfter: 1,
    previousFirstWeekStartsAtMs: null,
    firstWeekStartsAtMs:
      INPUT.firstWeekStartsAtMs,
    lastWeekEndsAtMs:
      INPUT.fantasyPlayoffsStartAtMs,
    nhlRegularSeasonStartsAtMs:
      INPUT.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs:
      INPUT.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs:
      INPUT.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs:
      INPUT.fantasyPlayoffsEndAtMs,
    calendarPersisted: 0,
    participantCount: 5,
    weekCount: 22,
    matchupCount: 44,
    byeCount: 22,
    shiftedWeekCount: null,
    replacedJobOccurrenceCount: null,
    responseHttpStatus: 201,
    responseCode:
      "MATCHUP_SCHEDULE_GENERATED",
    resultSchemaVersion: 1,
    createdAtMs: NOW_MS,
    version: 1,
  });
}

function replayService({
  storedRequestHash = REQUEST_SHA256,
  resultRow = durableRow(storedRequestHash),
  idempotencyOverrides = {},
  calls,
} = {}) {
  return createMatchupScheduleService({
    repositoryContext: {
      transaction(action) {
        calls.push("transaction");
        return action();
      },
    },
    leagueAuthorization: {
      requireCommissioner() {
        calls.push("authorize");
        return {
          actorUserId: ACTOR_USER_ID,
          membershipId: MEMBERSHIP_ID,
          authority: "commissioner",
          leagueId: LEAGUE_ID,
        };
      },
    },
    repository: {
      findIdempotency() {
        calls.push("findIdempotency");
        return {
          id: IDEMPOTENCY_REQUEST_ID,
          leagueId: LEAGUE_ID,
          actorUserId: ACTOR_USER_ID,
          operation:
            MATCHUP_SCHEDULE_COMMAND_OPERATION,
          clientKey: IDEMPOTENCY_KEY,
          requestHash: storedRequestHash,
          status: "completed",
          resultType:
            "matchup_schedule_command",
          resultId: COMMAND_RESULT_ID,
          createdAtMs: NOW_MS,
          completedAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 1,
          ...idempotencyOverrides,
        };
      },
      findCommandResult() {
        calls.push("findCommandResult");
        return resultRow;
      },
      readContext() {
        throw new Error(
          "replay must not read schedule context"
        );
      },
      readShiftContext() {
        throw new Error(
          "replay must not read shift context"
        );
      },
      applyConfirmedSchedulePlan() {
        throw new Error(
          "replay must not apply a schedule"
        );
      },
      applyWeekOneShiftPlan() {
        throw new Error(
          "replay must not apply a Week 1 shift"
        );
      },
    },
    clock: {
      nowMs() {
        throw new Error(
          "replay must not sample the clock"
        );
      },
    },
    secureRandom: {
      id() {
        throw new Error(
          "replay must not allocate identifiers"
        );
      },
    },
  });
}

function command(overrides = {}) {
  return {
    ...REQUEST,
    idempotencyKey: IDEMPOTENCY_KEY,
    authenticated: { session: true },
    ...overrides,
  };
}

function durableShiftRow(
  requestHash = SHIFT_REQUEST_SHA256
) {
  return Object.freeze({
    id: COMMAND_RESULT_ID,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    action: "shift_week_one",
    idempotencyRequestId:
      IDEMPOTENCY_REQUEST_ID,
    idempotencyOperation:
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
    requestSha256: requestHash,
    matchupOperationId: SHIFT_OPERATION_ID,
    actorUserId: ACTOR_USER_ID,
    actorMembershipId: MEMBERSHIP_ID,
    actorAuthority: "commissioner",
    oldScheduleOperationId: OPERATION_ID,
    oldScheduleVersion: 1,
    newScheduleOperationId:
      SHIFT_OPERATION_ID,
    newScheduleVersion: 2,
    seasonVersionBefore: 8,
    seasonVersionAfter: 9,
    weekOneMatchupWeekId: FIRST_WEEK_ID,
    weekVersionBefore: 1,
    weekVersionAfter: 2,
    previousFirstWeekStartsAtMs:
      INPUT.firstWeekStartsAtMs,
    firstWeekStartsAtMs:
      SHIFT_INPUT.firstWeekStartsAtMs,
    lastWeekEndsAtMs:
      SHIFT_RESULT.lastWeekEndsAtMs,
    nhlRegularSeasonStartsAtMs: null,
    nhlRegularSeasonEndsAtMs: null,
    fantasyPlayoffsStartAtMs: null,
    fantasyPlayoffsEndAtMs: null,
    calendarPersisted: null,
    participantCount: null,
    weekCount: null,
    matchupCount: null,
    byeCount: null,
    shiftedWeekCount: 22,
    replacedJobOccurrenceCount: 132,
    responseHttpStatus: 200,
    responseCode: null,
    resultSchemaVersion: 1,
    createdAtMs: NOW_MS,
    version: 1,
  });
}

function shiftReplayService({
  storedRequestHash = SHIFT_REQUEST_SHA256,
  resultRow = durableShiftRow(
    storedRequestHash
  ),
  idempotencyOverrides = {},
  calls,
} = {}) {
  return createMatchupScheduleService({
    repositoryContext: {
      transaction(action) {
        calls.push("transaction");
        return action();
      },
    },
    leagueAuthorization: {
      requireCommissioner() {
        calls.push("authorize");
        return {
          actorUserId: ACTOR_USER_ID,
          membershipId: MEMBERSHIP_ID,
          authority: "commissioner",
          leagueId: LEAGUE_ID,
        };
      },
    },
    repository: {
      findIdempotency() {
        calls.push("findIdempotency");
        return {
          id: IDEMPOTENCY_REQUEST_ID,
          leagueId: LEAGUE_ID,
          actorUserId: ACTOR_USER_ID,
          operation:
            MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
          clientKey: IDEMPOTENCY_KEY,
          requestHash: storedRequestHash,
          status: "completed",
          resultType:
            "matchup_schedule_command",
          resultId: COMMAND_RESULT_ID,
          createdAtMs: NOW_MS,
          completedAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 1,
          ...idempotencyOverrides,
        };
      },
      findCommandResult() {
        calls.push("findCommandResult");
        return resultRow;
      },
      readContext() {
        throw new Error(
          "shift replay must not read generation context"
        );
      },
      readShiftContext() {
        throw new Error(
          "shift replay must not read shift context"
        );
      },
      applyConfirmedSchedulePlan() {
        throw new Error(
          "shift replay must not generate a schedule"
        );
      },
      applyWeekOneShiftPlan() {
        throw new Error(
          "shift replay must not apply a shift"
        );
      },
    },
    clock: {
      nowMs() {
        throw new Error(
          "shift replay must not sample the clock"
        );
      },
    },
    secureRandom: {
      id() {
        throw new Error(
          "shift replay must not allocate identifiers"
        );
      },
    },
  });
}

function shiftCommand(overrides = {}) {
  return {
    ...SHIFT_REQUEST,
    idempotencyKey: IDEMPOTENCY_KEY,
    authenticated: { session: true },
    ...overrides,
  };
}

describe("T-096 Week 1 shift command contract", () => {
  test("locks canonical-json-v1 request and direct 200 response vectors", () => {
    assert.equal(
      serializeMatchupScheduleShiftWeekOneRequest(
        SHIFT_REQUEST
      ),
      SHIFT_REQUEST_CANONICAL_JSON
    );
    assert.equal(
      hashMatchupScheduleShiftWeekOneRequest(
        SHIFT_REQUEST
      ),
      SHIFT_REQUEST_SHA256
    );
    assert.equal(
      serializeMatchupScheduleShiftWeekOneResponse(
        SHIFT_RESULT
      ),
      SHIFT_RESPONSE_CANONICAL_JSON
    );
    assert.equal(
      hashMatchupScheduleShiftWeekOneResponse(
        SHIFT_RESULT
      ),
      SHIFT_RESPONSE_SHA256
    );
  });

  test("projects the exact operation, Week 1 precondition, literals, and direct response status", () => {
    const projection =
      matchupScheduleShiftWeekOneRequestProjection(
        SHIFT_REQUEST
      );

    assert.equal(
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
      "matchup.schedule.shift_week_one.v1"
    );
    assert.equal(
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_ACTION,
      "shift_week_one"
    );
    assert.equal(
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_CONFIRMATION,
      "CHANGE WEEK 1 START"
    );
    assert.equal(
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_HTTP_STATUS,
      200
    );
    assert.equal(
      projection.operation,
      MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION
    );
    assert.deepEqual(projection.precondition, {
      kind: "week",
      version: 1,
    });
    assert.deepEqual(projection.body, SHIFT_INPUT);
    assert.equal(projection.weekId, FIRST_WEEK_ID);
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(
      Object.isFrozen(projection.precondition),
      true
    );
    assert.equal(
      Object.isFrozen(projection.body),
      true
    );

    const responseProjection =
      matchupScheduleShiftWeekOneResponseProjection(
        SHIFT_RESULT
      );
    assert.deepEqual(responseProjection, {
      domain:
        "hundo-leago.matchup-schedule-command-response",
      schemaVersion: 1,
      httpStatus: 200,
      data: SHIFT_RESULT,
    });
    assert.equal(
      Object.isFrozen(responseProjection),
      true
    );
    assert.equal(
      Object.isFrozen(responseProjection.data),
      true
    );
    assert.equal(
      Object.hasOwn(responseProjection.data, "code"),
      false
    );
    assert.equal(
      Object.hasOwn(responseProjection.data, "result"),
      false
    );
  });

  test("accepts only the exact plain three-field shift body", () => {
    assert.deepEqual(
      validateMatchupScheduleShiftWeekOneInput(
        SHIFT_INPUT
      ),
      SHIFT_INPUT
    );

    const {
      confirmation: _missingConfirmation,
      ...missing
    } = SHIFT_INPUT;
    const inherited = Object.assign(
      Object.create({ inherited: true }),
      SHIFT_INPUT
    );
    for (const input of [
      null,
      [],
      inherited,
      missing,
      { ...SHIFT_INPUT, extra: true },
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneInput(
            input
          ),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode: "shift_body_fields_invalid",
        }
      );
    }
  });

  test("rejects every inexact action or typed confirmation literal", () => {
    for (const [field, value, reasonCode] of [
      [
        "action",
        "shift-week-one",
        "shift_action_invalid",
      ],
      [
        "action",
        "SHIFT_WEEK_ONE",
        "shift_action_invalid",
      ],
      [
        "confirmation",
        "CHANGE WEEK 1 START ",
        "shift_confirmation_invalid",
      ],
      [
        "confirmation",
        "Change Week 1 Start",
        "shift_confirmation_invalid",
      ],
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneInput({
            ...SHIFT_INPUT,
            [field]: value,
          }),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode,
        }
      );
    }
  });

  test("rejects negative, fractional, non-numeric, and unsafe Week 1 timestamps", () => {
    for (const firstWeekStartsAtMs of [
      -1,
      1.5,
      "1790578800000",
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneInput({
            ...SHIFT_INPUT,
            firstWeekStartsAtMs,
          }),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode:
            "first_week_starts_at_ms_invalid",
        }
      );
    }
  });

  test("accepts only incrementable positive safe Week 1 versions", () => {
    assert.equal(
      validateMatchupScheduleShiftExpectedWeekVersion(
        Number.MAX_SAFE_INTEGER - 1
      ),
      Number.MAX_SAFE_INTEGER - 1
    );
    for (const version of [
      0,
      1.5,
      Number.MAX_SAFE_INTEGER,
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftExpectedWeekVersion(
            version
          ),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode:
            "expected_week_version_invalid",
        }
      );
    }
  });

  test("requires a lowercase RFC 4122 version-4 Week 1 identifier", () => {
    assert.equal(
      validateMatchupScheduleShiftWeekOneWeekId(
        FIRST_WEEK_ID
      ),
      FIRST_WEEK_ID
    );
    for (const weekId of [
      "44444444-4444-5444-8444-444444444444",
      "44444444-4444-4444-7444-444444444444",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "week-one",
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneWeekId(
            weekId
          ),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode: "week_id_invalid",
        }
      );
    }
  });

  test("accepts only the exact ten-field shift response result", () => {
    assert.deepEqual(
      validateMatchupScheduleShiftWeekOneResult(
        SHIFT_RESULT
      ),
      SHIFT_RESULT
    );

    const {
      weekVersion: _missingWeekVersion,
      ...missing
    } = SHIFT_RESULT;
    const inherited = Object.assign(
      Object.create({ inherited: true }),
      SHIFT_RESULT
    );
    for (const result of [
      null,
      [],
      inherited,
      missing,
      { ...SHIFT_RESULT, code: "SHIFTED" },
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneResult(
            result
          ),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode:
            "shift_response_result_fields_invalid",
        }
      );
    }
  });

  test("rejects malformed shift response identities, versions, timestamps, counts, and relationships", () => {
    for (const [field, value, reasonCode] of [
      [
        "operationId",
        "99999999-9999-5999-8999-999999999999",
        "shift_response_operation_id_invalid",
      ],
      [
        "seasonId",
        "22222222-2222-5222-8222-222222222222",
        "shift_response_season_id_invalid",
      ],
      [
        "weekId",
        "44444444-4444-5444-8444-444444444444",
        "shift_response_week_id_invalid",
      ],
      [
        "seasonVersion",
        0,
        "shift_response_season_version_invalid",
      ],
      [
        "seasonVersion",
        Number.MAX_SAFE_INTEGER + 1,
        "shift_response_season_version_invalid",
      ],
      [
        "weekVersion",
        1.5,
        "shift_response_week_version_invalid",
      ],
      [
        "previousFirstWeekStartsAtMs",
        -1,
        "shift_response_previous_first_week_starts_at_ms_invalid",
      ],
      [
        "firstWeekStartsAtMs",
        "1790578800000",
        "shift_response_first_week_starts_at_ms_invalid",
      ],
      [
        "lastWeekEndsAtMs",
        Number.MAX_SAFE_INTEGER + 1,
        "shift_response_last_week_ends_at_ms_invalid",
      ],
      [
        "shiftedWeekCount",
        0,
        "shift_response_shifted_week_count_invalid",
      ],
      [
        "replacedJobOccurrenceCount",
        -1,
        "shift_response_replaced_job_occurrence_count_invalid",
      ],
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneResult({
            ...SHIFT_RESULT,
            [field]: value,
          }),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode,
        }
      );
    }

    for (const result of [
      {
        ...SHIFT_RESULT,
        previousFirstWeekStartsAtMs:
          SHIFT_RESULT.firstWeekStartsAtMs,
      },
      {
        ...SHIFT_RESULT,
        lastWeekEndsAtMs:
          SHIFT_RESULT.firstWeekStartsAtMs,
      },
    ]) {
      assert.throws(
        () =>
          validateMatchupScheduleShiftWeekOneResult(
            result
          ),
        {
          code:
            "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
          reasonCode: "shift_response_timing_invalid",
        }
      );
    }
  });

  test("replays the immutable shift result before clock, context, or identifier work", () => {
    const calls = [];
    const service = shiftReplayService({
      calls,
    });

    assert.deepEqual(
      service.shiftWeekOne(shiftCommand()),
      SHIFT_RESULT
    );
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
    ]);
  });

  test("rejects every changed shift replay scope under the same key before mutable work", () => {
    const changedCommands = [
      [
        shiftCommand({
          idempotencyKey: `${IDEMPOTENCY_KEY}:changed`,
        }),
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ],
      [
        shiftCommand({
          input: {
            ...SHIFT_INPUT,
            firstWeekStartsAtMs:
              SHIFT_INPUT.firstWeekStartsAtMs +
              7 * 24 * 60 * 60 * 1000,
          },
        }),
        "IDEMPOTENCY_KEY_REUSED",
      ],
      [
        shiftCommand({
          weekId:
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        "IDEMPOTENCY_KEY_REUSED",
      ],
      [
        shiftCommand({
          seasonId:
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
        "IDEMPOTENCY_KEY_REUSED",
      ],
      [
        shiftCommand({
          expectedWeekVersion: 2,
        }),
        "IDEMPOTENCY_KEY_REUSED",
      ],
    ];
    for (const [
      changedCommand,
      expectedCode,
    ] of changedCommands) {
      const calls = [];
      const service = shiftReplayService({
        calls,
      });
      assert.throws(
        () =>
          service.shiftWeekOne(changedCommand),
        { code: expectedCode }
      );
      assert.deepEqual(calls, [
        "transaction",
        "authorize",
        "findIdempotency",
      ]);
    }
  });

  test("fails closed on an incomplete shift request and mismapped immutable results", () => {
    {
      const calls = [];
      const service = shiftReplayService({
        calls,
        idempotencyOverrides: {
          status: "started",
          resultType: null,
          resultId: null,
          completedAtMs: null,
        },
      });
      assert.throws(
        () =>
          service.shiftWeekOne(shiftCommand()),
        {
          code:
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        }
      );
      assert.deepEqual(calls, [
        "transaction",
        "authorize",
        "findIdempotency",
      ]);
    }

    for (const resultRow of [
      {
        ...durableShiftRow(),
        id:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableShiftRow(),
        leagueId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableShiftRow(),
        seasonId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableShiftRow(),
        weekOneMatchupWeekId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableShiftRow(),
        idempotencyRequestId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableShiftRow(),
        shiftedWeekCount: 0,
      },
      {
        ...durableShiftRow(),
        replacedJobOccurrenceCount: -1,
      },
      {
        ...durableShiftRow(),
        firstWeekStartsAtMs: "1790578800000",
      },
      {
        ...durableShiftRow(),
        previousFirstWeekStartsAtMs:
          SHIFT_INPUT.firstWeekStartsAtMs,
      },
    ]) {
      const calls = [];
      const service = shiftReplayService({
        calls,
        resultRow,
      });
      assert.throws(
        () =>
          service.shiftWeekOne(shiftCommand()),
        {
          code:
            "MATCHUP_SCHEDULE_RESULT_UNAVAILABLE",
        }
      );
      assert.deepEqual(calls, [
        "transaction",
        "authorize",
        "findIdempotency",
        "findCommandResult",
      ]);
    }
  });
});

describe("T-095 matchup schedule command foundation", () => {
  test("locks canonical-json-v1 request and response vectors", () => {
    assert.equal(
      serializeMatchupScheduleCommandRequest(
        REQUEST
      ),
      REQUEST_CANONICAL_JSON
    );
    assert.equal(
      hashMatchupScheduleCommandRequest(REQUEST),
      REQUEST_SHA256
    );
    assert.equal(
      serializeMatchupScheduleCommandResponse(
        RESULT
      ),
      RESPONSE_CANONICAL_JSON
    );
    assert.equal(
      hashMatchupScheduleCommandResponse(RESULT),
      RESPONSE_SHA256
    );
  });

  test("accepts opaque idempotency keys but rejects a version that cannot be incremented safely", () => {
    assert.equal(
      validateMatchupScheduleCommandIdempotencyKey(
        IDEMPOTENCY_KEY
      ),
      IDEMPOTENCY_KEY
    );
    assert.throws(
      () =>
        validateMatchupScheduleCommandExpectedVersion(
          Number.MAX_SAFE_INTEGER
        ),
      {
        code:
          "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
        reasonCode:
          "expected_season_version_invalid",
      }
    );
  });

  test("replays only the immutable scalar result before clock, context, or identifier work", () => {
    const calls = [];
    const service = replayService({ calls });

    assert.deepEqual(service.generate(command()), RESULT);
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
    ]);
    assert.equal(
      Object.hasOwn(
        service.generate(command()),
        "id"
      ),
      false
    );
  });

  test("rejects a changed request under the same key before clock, context, or identifier work", () => {
    const calls = [];
    const service = replayService({ calls });

    assert.throws(
      () =>
        service.generate(
          command({ expectedSeasonVersion: 6 })
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
    ]);
  });

  test("rejects a changed body under the same key before clock, context, or identifier work", () => {
    const calls = [];
    const service = replayService({ calls });

    assert.throws(
      () =>
        service.generate(
          command({
            input: {
              ...INPUT,
              firstWeekStartsAtMs:
                INPUT.firstWeekStartsAtMs +
                7 * 24 * 60 * 60 * 1000,
            },
          })
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
    ]);
  });

  test("rejects a changed season under the same key before clock, context, or identifier work", () => {
    const calls = [];
    const service = replayService({ calls });

    assert.throws(
      () =>
        service.generate(
          command({
            seasonId:
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          })
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
    ]);
  });

  test("fails closed on an incomplete started idempotency request before clock, context, or identifier work", () => {
    const calls = [];
    const service = replayService({
      calls,
      idempotencyOverrides: {
        status: "started",
        resultType: null,
        resultId: null,
        completedAtMs: null,
      },
    });

    assert.throws(
      () => service.generate(command()),
      {
        code: "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      }
    );
    assert.deepEqual(calls, [
      "transaction",
      "authorize",
      "findIdempotency",
    ]);
  });

  test("fails closed when a replay result is mapped to a different identity or scope", () => {
    for (const resultRow of [
      {
        ...durableRow(),
        id:
          "99999999-9999-4999-8999-999999999999",
      },
      {
        ...durableRow(),
        leagueId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        ...durableRow(),
        seasonId:
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ]) {
      const calls = [];
      const service = replayService({
        calls,
        resultRow,
      });
      assert.throws(
        () => service.generate(command()),
        {
          code:
            "MATCHUP_SCHEDULE_RESULT_UNAVAILABLE",
        }
      );
      assert.deepEqual(calls, [
        "transaction",
        "authorize",
        "findIdempotency",
        "findCommandResult",
      ]);
    }
  });

  test("rejects maximum safe expected version before opening a transaction", () => {
    const calls = [];
    const service = replayService({ calls });

    assert.throws(
      () =>
        service.generate(
          command({
            expectedSeasonVersion:
              Number.MAX_SAFE_INTEGER,
          })
        ),
      {
        code:
          "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
      }
    );
    assert.deepEqual(calls, []);
  });
});
