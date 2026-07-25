const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MAX_ASSETS_PER_SIDE,
  TRADE_ASSET_CODES,
  TRADE_ASSET_TYPES,
  TradeAssetPolicyError,
  boundedIdempotencyKey,
  createTradeAssetCommands,
  validateTradeAssetInput,
  validateTradeProposalCreationCommand,
  validateTradeProposalCreationInput,
} = require("../../src/domain/trades/tradeAssetPolicy");
const {
  TRADE_PROPOSAL_LIFETIME_MS,
} = require("../../src/domain/trades/tradeProposalPolicy");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  proposingTeam: uuid(3),
  receivingTeam: uuid(4),
  actor: uuid(5),
  membership: uuid(6),
  contract: uuid(10),
  player: uuid(11),
  draftPick: uuid(12),
  retention: uuid(13),
  buyout: uuid(14),
  futureConsideration: uuid(15),
});
const NOW_MS = 1_000_000;

function assetInput() {
  return {
    proposingTeamId: IDS.proposingTeam,
    receivingTeamId: IDS.receivingTeam,
    proposingAssets: [
      { type: "contract", contractId: IDS.contract },
      {
        type: "requested_retention",
        contractId: IDS.contract,
        retainedAavCents: 100,
      },
      { type: "prospect_right", playerId: IDS.player },
      { type: "draft_pick", draftPickId: IDS.draftPick },
    ],
    receivingAssets: [
      {
        type: "retention_obligation",
        retentionObligationId: IDS.retention,
      },
      { type: "buyout_obligation", buyoutObligationId: IDS.buyout },
      {
        type: "future_consideration",
        futureConsiderationId: IDS.futureConsideration,
      },
      {
        type: "future_consideration_instruction",
        description: "Conditional 2028 fourth-round pick",
      },
    ],
  };
}

function assertReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeAssetPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-06 typed trade-asset policy", () => {
  test("accepts exactly every approved typed asset and canonicalizes its shape", () => {
    const normalized = validateTradeProposalCreationInput(assetInput());
    assert.deepEqual(
      normalized.proposingAssets.map(({ inputType }) => inputType),
      ["contract", "requested_retention", "prospect_right", "draft_pick"]
    );
    assert.deepEqual(
      normalized.receivingAssets.map(({ inputType }) => inputType),
      [
        "retention_obligation",
        "buyout_obligation",
        "future_consideration",
        "future_consideration_instruction",
      ]
    );
    assert.deepEqual(TRADE_ASSET_TYPES, [
      "contract",
      "prospect_right",
      "draft_pick",
      "retention_obligation",
      "buyout_obligation",
      "future_consideration",
      "future_consideration_instruction",
      "requested_retention",
    ]);
  });

  test("requires exact shapes, stable IDs, safe descriptions, and bounded counts", () => {
    assertReason(
      () => validateTradeAssetInput({ type: "cash", amount: 100 }),
      TRADE_ASSET_CODES.typeUnsupported
    );
    assertReason(
      () =>
        validateTradeAssetInput({
          type: "contract",
          contractId: IDS.contract,
          clientSnapshot: {},
        }),
      TRADE_ASSET_CODES.inputInvalid
    );
    assertReason(
      () => validateTradeAssetInput({ type: "contract", contractId: "10" }),
      TRADE_ASSET_CODES.stableIdInvalid
    );
    assertReason(
      () =>
        validateTradeAssetInput({
          type: "future_consideration_instruction",
          description: " leading space",
        }),
      TRADE_ASSET_CODES.descriptionInvalid
    );
    const input = assetInput();
    input.proposingAssets = Array.from(
      { length: MAX_ASSETS_PER_SIDE + 1 },
      (_, index) => ({ type: "contract", contractId: uuid(100 + index) })
    );
    assertReason(
      () => validateTradeProposalCreationInput(input),
      TRADE_ASSET_CODES.assetCountInvalid
    );
  });

  test("requires a real contributed asset on both sides and links retention to its contract", () => {
    const noContribution = assetInput();
    noContribution.receivingAssets = [
      {
        type: "requested_retention",
        contractId: uuid(90),
        retainedAavCents: 50,
      },
    ];
    assertReason(
      () => validateTradeProposalCreationInput(noContribution),
      TRADE_ASSET_CODES.minimumContributionRequired
    );
    const unlinkedRetention = assetInput();
    unlinkedRetention.proposingAssets[1] = {
      type: "requested_retention",
      contractId: uuid(91),
      retainedAavCents: 50,
    };
    assertReason(
      () => validateTradeProposalCreationInput(unlinkedRetention),
      TRADE_ASSET_CODES.retentionInvalid
    );
    const zeroRetention = assetInput();
    zeroRetention.proposingAssets[1].retainedAavCents = 0;
    assertReason(
      () => validateTradeProposalCreationInput(zeroRetention),
      TRADE_ASSET_CODES.retentionInvalid
    );
  });

  test("rejects duplicate and cross-side conflicting asset identities", () => {
    const sameSide = assetInput();
    sameSide.proposingAssets.push({
      type: "contract",
      contractId: IDS.contract,
    });
    assertReason(
      () => validateTradeProposalCreationInput(sameSide),
      TRADE_ASSET_CODES.duplicate
    );
    const crossSide = assetInput();
    crossSide.receivingAssets = [
      { type: "prospect_right", playerId: IDS.player },
    ];
    assertReason(
      () => validateTradeProposalCreationInput(crossSide),
      TRADE_ASSET_CODES.duplicate
    );
  });

  test("derives authoritative directions, sequence, timing, and idempotency", () => {
    const input = validateTradeProposalCreationInput(assetInput());
    const assetIds = Array.from(
      { length: input.proposingAssets.length + input.receivingAssets.length },
      (_, index) => uuid(200 + index)
    );
    const assets = createTradeAssetCommands({
      input,
      assetIds,
      createdAtMs: NOW_MS,
    });
    assert.equal(assets[0].direction, "proposing_to_receiving");
    assert.equal(assets[3].sequence, 4);
    assert.equal(assets[4].direction, "receiving_to_proposing");
    assert.equal(assets[7].destinationTeamId, IDS.proposingTeam);
    const rawCommand = {
      tradeId: uuid(300),
      eventId: uuid(301),
      idempotencyRequestId: uuid(302),
      leagueId: IDS.league,
      seasonId: IDS.season,
      proposingTeamId: IDS.proposingTeam,
      receivingTeamId: IDS.receivingTeam,
      actorUserId: IDS.actor,
      actorMembershipId: IDS.membership,
      actorAuthority: "manager",
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + TRADE_PROPOSAL_LIFETIME_MS,
      effectiveDeadlineAtMs: NOW_MS + 10_000,
      idempotencyKey: boundedIdempotencyKey("proposal-1"),
      idempotencyExpiresAtMs: NOW_MS + 20_000,
      assets,
    };
    const command = validateTradeProposalCreationCommand(rawCommand);
    assert.equal(command.assets.length, 8);
    assert.equal(command.tradeId, uuid(300));
    const staleDirection = { ...rawCommand, assets: [...rawCommand.assets] };
    staleDirection.assets[0] = {
      ...staleDirection.assets[0],
      destinationTeamId: IDS.proposingTeam,
    };
    assertReason(
      () => validateTradeProposalCreationCommand(staleDirection),
      TRADE_ASSET_CODES.conflict
    );
    assertReason(
      () => boundedIdempotencyKey(" "),
      TRADE_ASSET_CODES.idempotencyInvalid
    );
  });
});
