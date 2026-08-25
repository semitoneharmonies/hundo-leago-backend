const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  TRADE_LIFECYCLE_CODES,
  TradeLifecyclePolicyError,
  assertTradeAcceptancePreviewState,
  assertTradeExpiryState,
  assertTradeLifecycleState,
  buildTradeExpiryOccurrenceKey,
  expectedManagerTeamId,
  validateTradeExpiryCommand,
  validateTradeAcceptancePreviewCommand,
  validateTradeAcceptancePreviewInput,
  validateTradeLifecycleCommand,
  validateTradeLifecycleInput,
} = require("../../src/domain/trades/tradeLifecyclePolicy");

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
const NOW_MS = 1_000;
const DEADLINE_MS = 2_000;

function command(overrides = {}) {
  return validateTradeLifecycleCommand({
    tradeId: IDS.trade,
    eventId: IDS.event,
    idempotencyRequestId: IDS.request,
    leagueId: IDS.league,
    seasonId: IDS.season,
    proposingTeamId: IDS.proposingTeam,
    receivingTeamId: IDS.receivingTeam,
    expectedVersion: 1,
    action: "reject",
    actorUserId: IDS.actor,
    actorMembershipId: IDS.membership,
    actorAuthority: "manager",
    occurredAtMs: NOW_MS,
    effectiveDeadlineAtMs: DEADLINE_MS,
    idempotencyKey: "lifecycle-1",
    idempotencyExpiresAtMs: NOW_MS + 10_000,
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
    trade_version: 1,
    effective_deadline_at_ms: DEADLINE_MS,
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
    is_platform_administrator: 0,
    has_future_considerations: 1,
    ...overrides,
  };
}

function acceptanceCommand(overrides = {}) {
  return validateTradeAcceptancePreviewCommand({
    tradeId: IDS.trade,
    leagueId: IDS.league,
    seasonId: IDS.season,
    proposingTeamId: IDS.proposingTeam,
    receivingTeamId: IDS.receivingTeam,
    expectedVersion: 1,
    actorUserId: IDS.actor,
    actorMembershipId: IDS.membership,
    actorAuthority: "manager",
    occurredAtMs: NOW_MS,
    effectiveDeadlineAtMs: DEADLINE_MS,
    ...overrides,
  });
}

function assertReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeLifecyclePolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-07 trade lifecycle policy", () => {
  test("requires exact reject-or-cancel input and canonical command evidence", () => {
    assert.deepEqual(
      validateTradeLifecycleInput({ tradeId: IDS.trade, action: "reject" }),
      { tradeId: IDS.trade, action: "reject" }
    );
    assertReason(
      () =>
        validateTradeLifecycleInput({
          tradeId: IDS.trade,
          action: "accept",
        }),
      TRADE_LIFECYCLE_CODES.actionInvalid
    );
    assertReason(
      () =>
        validateTradeLifecycleInput({
          tradeId: IDS.trade,
          action: "cancel",
          reason: "client supplied",
        }),
      TRADE_LIFECYCLE_CODES.inputInvalid
    );
    assert.equal(command().expectedVersion, 1);
  });

  test("maps reject to the receiver and cancel to the proposer", () => {
    assert.equal(expectedManagerTeamId(command()), IDS.receivingTeam);
    assert.equal(
      expectedManagerTeamId(command({ action: "cancel" })),
      IDS.proposingTeam
    );
    assert.equal(
      assertTradeLifecycleState({ command: command(), context: context() }),
      true
    );
    assert.equal(
      assertTradeLifecycleState({
        command: command({ action: "cancel" }),
        context: context({ assignment_team_id: IDS.proposingTeam }),
      }),
      true
    );
  });

  test("denies commissioner decline and cancellation authority", () => {
    const commissioner = command({ actorAuthority: "commissioner" });
    assertReason(
      () =>
        assertTradeLifecycleState({
          command: commissioner,
          context: context({
            commissioner_membership_id: IDS.membership,
            membership_permission: "commissioner",
          }),
        }),
      TRADE_LIFECYCLE_CODES.roleDenied
    );
    assertReason(
      () =>
        assertTradeLifecycleState({
          command: command({
            action: "cancel",
            actorAuthority: "commissioner",
          }),
          context: context({
            league_status: "frozen",
            commissioner_membership_id: IDS.membership,
            membership_permission: "commissioner",
            assignment_team_id: null,
            assignment_status: null,
            assignment_accepted_at_ms: null,
          }),
        }),
      TRADE_LIFECYCLE_CODES.roleDenied
    );
    assertReason(
      () =>
        assertTradeLifecycleState({
          command: command(),
          context: context({ league_status: "frozen" }),
        }),
      TRADE_LIFECYCLE_CODES.roleDenied
    );
  });

  test("rejects terminal proposals and the exact effective deadline", () => {
    assert.equal(
      assertTradeLifecycleState({
        command: command(),
        context: context({
          trade_status: "awaiting_commissioner_approval",
        }),
      }),
      true
    );
    assertReason(
      () =>
        assertTradeLifecycleState({
          command: command(),
          context: context({ trade_status: "declined" }),
        }),
      TRADE_LIFECYCLE_CODES.notPending
    );
    assertReason(
      () =>
        assertTradeLifecycleState({
          command: command({ occurredAtMs: DEADLINE_MS }),
          context: context(),
        }),
      TRADE_LIFECYCLE_CODES.windowClosed
    );
  });

  test("uses one stable expiry occurrence and never expires early", () => {
    const occurrenceKey = buildTradeExpiryOccurrenceKey({
      tradeId: IDS.trade,
      effectiveDeadlineAtMs: DEADLINE_MS,
    });
    assert.equal(occurrenceKey, `trade-expiry:${IDS.trade}:${DEADLINE_MS}`);
    const expiry = validateTradeExpiryCommand({
      tradeId: IDS.trade,
      eventId: IDS.event,
      leagueId: IDS.league,
      seasonId: IDS.season,
      expectedVersion: 1,
      effectiveDeadlineAtMs: DEADLINE_MS,
      occurredAtMs: DEADLINE_MS,
      occurrenceKey,
    });
    assert.equal(
      assertTradeExpiryState({ command: expiry, context: context() }),
      true
    );
    assert.equal(
      assertTradeExpiryState({
        command: expiry,
        context: context({
          trade_status: "awaiting_commissioner_approval",
        }),
      }),
      true
    );
    assertReason(
      () =>
        validateTradeExpiryCommand({
          ...expiry,
          occurredAtMs: DEADLINE_MS - 1,
        }),
      TRADE_LIFECYCLE_CODES.windowClosed
    );
  });

  test("limits executable acceptance preview to the receiving manager", () => {
    assert.deepEqual(validateTradeAcceptancePreviewInput({ tradeId: IDS.trade }), {
      tradeId: IDS.trade,
    });
    assert.equal(
      assertTradeAcceptancePreviewState({
        command: acceptanceCommand(),
        context: context(),
      }),
      true
    );
    assertReason(
      () =>
        assertTradeAcceptancePreviewState({
          command: acceptanceCommand(),
          context: context({ assignment_team_id: IDS.proposingTeam }),
        }),
      TRADE_LIFECYCLE_CODES.roleDenied
    );
    assertReason(
      () =>
        assertTradeAcceptancePreviewState({
          command: acceptanceCommand({ actorAuthority: "commissioner" }),
          context: context({
            commissioner_membership_id: IDS.membership,
            membership_permission: "commissioner",
          }),
        }),
      TRADE_LIFECYCLE_CODES.roleDenied
    );
    assert.equal(
      assertTradeAcceptancePreviewState({
        command: acceptanceCommand(),
        context: context({ membership_permission: "commissioner" }),
      }),
      true
    );
    assertReason(
      () =>
        assertTradeAcceptancePreviewState({
          command: acceptanceCommand({ occurredAtMs: DEADLINE_MS }),
          context: context(),
        }),
      TRADE_LIFECYCLE_CODES.windowClosed
    );
  });
});
