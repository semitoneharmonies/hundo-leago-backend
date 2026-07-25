const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
  assertTradeExecutionState,
  validateTradeExecutionCommand,
  validateTradeExecutionInput,
} = require("../../src/domain/trades/tradeExecutionPolicy");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  trade: uuid(1),
  event: uuid(2),
  request: uuid(3),
  league: uuid(4),
  season: uuid(5),
  proposingTeam: uuid(6),
  receivingTeam: uuid(7),
  actor: uuid(8),
  membership: uuid(9),
});

function command(overrides = {}) {
  return validateTradeExecutionCommand({
    tradeId: IDS.trade,
    eventId: IDS.event,
    idempotencyRequestId: IDS.request,
    leagueId: IDS.league,
    seasonId: IDS.season,
    proposingTeamId: IDS.proposingTeam,
    receivingTeamId: IDS.receivingTeam,
    expectedVersion: 1,
    actorUserId: IDS.actor,
    actorMembershipId: IDS.membership,
    actorAuthority: "manager",
    occurredAtMs: 1_000,
    effectiveDeadlineAtMs: 2_000,
    idempotencyKey: "accept-1",
    idempotencyExpiresAtMs: 10_000,
    ...overrides,
  });
}

function context(overrides = {}) {
  return {
    trade_id: IDS.trade,
    league_id: IDS.league,
    season_id: IDS.season,
    proposing_team_id: IDS.proposingTeam,
    receiving_team_id: IDS.receivingTeam,
    trade_status: "proposed",
    effective_deadline_at_ms: 2_000,
    trade_version: 1,
    proposal_model_version: 2,
    league_status: "active",
    commissioner_membership_id: null,
    season_status: "active",
    membership_user_id: IDS.actor,
    membership_permission: "manager",
    membership_status: "active",
    assignment_team_id: IDS.receivingTeam,
    assignment_status: "accepted",
    assignment_accepted_at_ms: 500,
    assignment_ended_at_ms: null,
    ...overrides,
  };
}

function assertReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeExecutionPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-08 trade-execution policy", () => {
  test("requires exact canonical input and idempotent command evidence", () => {
    assert.deepEqual(validateTradeExecutionInput({ tradeId: IDS.trade }), {
      tradeId: IDS.trade,
    });
    assertReason(
      () => validateTradeExecutionInput({ tradeId: IDS.trade, accepted: true }),
      TRADE_EXECUTION_CODES.inputInvalid
    );
    assert.equal(command().actorAuthority, "manager");
    assertReason(
      () => command({ idempotencyKey: " accept " }),
      TRADE_EXECUTION_CODES.idempotencyInvalid
    );
  });

  test("permits only the receiving manager or explicit current commissioner", () => {
    assert.equal(
      assertTradeExecutionState({ command: command(), context: context() }),
      true
    );
    assertReason(
      () =>
        assertTradeExecutionState({
          command: command(),
          context: context({ assignment_team_id: IDS.proposingTeam }),
        }),
      TRADE_EXECUTION_CODES.roleDenied
    );
    assert.equal(
      assertTradeExecutionState({
        command: command({ actorAuthority: "commissioner" }),
        context: context({
          league_status: "frozen",
          commissioner_membership_id: IDS.membership,
          membership_permission: "commissioner",
          assignment_team_id: null,
          assignment_status: null,
          assignment_accepted_at_ms: null,
        }),
      }),
      true
    );
  });

  test("closes exactly at the deadline and rejects legacy, terminal, or stale state", () => {
    assertReason(
      () =>
        assertTradeExecutionState({
          command: command({ occurredAtMs: 2_000 }),
          context: context(),
        }),
      TRADE_EXECUTION_CODES.windowClosed
    );
    assertReason(
      () =>
        assertTradeExecutionState({
          command: command(),
          context: context({ trade_status: "completed" }),
        }),
      TRADE_EXECUTION_CODES.notPending
    );
    assertReason(
      () =>
        assertTradeExecutionState({
          command: command(),
          context: context({ proposal_model_version: 1 }),
        }),
      TRADE_EXECUTION_CODES.versionConflict
    );
    assertReason(
      () =>
        assertTradeExecutionState({
          command: command(),
          context: context({ trade_version: 2 }),
        }),
      TRADE_EXECUTION_CODES.versionConflict
    );
  });
});
