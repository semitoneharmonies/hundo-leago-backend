"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID,
  FREE_AGENT_DRAFT_ACTIVITY_TYPES,
  FreeAgentDraftActivityContractError,
  createFreeAgentDraftActivityContract,
  validateFreeAgentDraftActivityMetadata,
  validateFreeAgentDraftActivityType,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftActivityContracts"
);

const IDS = Object.freeze({
  fad: "00000000-0000-4000-8000-000000000001",
  player: "00000000-0000-4000-8000-000000000002",
  team: "00000000-0000-4000-8000-000000000003",
  season: "00000000-0000-4000-8000-000000000004",
  exemption: "00000000-0000-4000-8000-000000000005",
  migrationReport:
    "00000000-0000-4000-8000-000000000006",
});

function contractError(reasonCode) {
  return (error) => {
    assert.ok(
      error instanceof FreeAgentDraftActivityContractError
    );
    assert.equal(
      error.code,
      FREE_AGENT_DRAFT_ACTIVITY_CONTRACT_INVALID
    );
    assert.equal(error.reasonCode, reasonCode);
    return true;
  };
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

describe("FAD-14 League Activity contracts", () => {
  it("closes the registry over the exact eleven approved activity types", () => {
    assert.deepEqual(FREE_AGENT_DRAFT_ACTIVITY_TYPES, [
      "free_agent_draft_started",
      "free_agent_draft_cards_published",
      "free_agent_draft_player_awarded",
      "free_agent_draft_restricted_created",
      "free_agent_draft_restricted_fallback_opened",
      "free_agent_draft_auction_no_winner",
      "free_agent_draft_player_invalid",
      "free_agent_draft_corrected",
      "free_agent_draft_week1_recovered",
      "free_agent_draft_completed",
      "fad_setup_exemption_authorized",
    ]);
    assert.equal(
      Object.isFrozen(FREE_AGENT_DRAFT_ACTIVITY_TYPES),
      true
    );
    for (const type of FREE_AGENT_DRAFT_ACTIVITY_TYPES) {
      assert.equal(
        validateFreeAgentDraftActivityType(type),
        type
      );
    }
    for (const type of [
      "free_agent_draft_allocation_corrected",
      "fad_cards_opened",
      "auction_resolved",
      "free_agent_draft_started ",
      null,
    ]) {
      assert.throws(
        () => validateFreeAgentDraftActivityType(type),
        contractError("activity_type_invalid")
      );
    }
  });

  it("canonicalizes bounded common safe metadata and deep-freezes a detached clone", () => {
    const input = {
      teamId: IDS.team,
      schemaVersion: 1,
      explanation: {
        winningContract: {
          totalValueCents: 600,
          termYears: 2,
          aavCents: 300,
        },
        rankingCodes: [
          "highest_total",
          "highest_equal_total_aav",
        ],
        exactTie: false,
      },
      playerId: IDS.player,
      fadId: IDS.fad,
      optional: null,
    };
    const metadata =
      validateFreeAgentDraftActivityMetadata(
        "free_agent_draft_player_awarded",
        input
      );

    assert.deepEqual(Object.keys(metadata), [
      "explanation",
      "fadId",
      "optional",
      "playerId",
      "schemaVersion",
      "teamId",
    ]);
    assert.deepEqual(metadata, input);
    assert.notEqual(metadata, input);
    assert.notEqual(metadata.explanation, input.explanation);
    assert.notEqual(
      metadata.explanation.rankingCodes,
      input.explanation.rankingCodes
    );
    assertDeepFrozen(metadata);

    input.explanation.winningContract.aavCents = 999;
    input.explanation.rankingCodes.push("changed");
    assert.equal(
      metadata.explanation.winningContract.aavCents,
      300
    );
    assert.deepEqual(metadata.explanation.rankingCodes, [
      "highest_total",
      "highest_equal_total_aav",
    ]);
  });

  it("creates an exact frozen activity contract for every approved type", () => {
    for (const eventType of FREE_AGENT_DRAFT_ACTIVITY_TYPES) {
      const metadata =
        eventType === "fad_setup_exemption_authorized"
          ? {
              exemptionId: IDS.exemption,
              seasonId: IDS.season,
              migrationReportId: IDS.migrationReport,
            }
          : {
              fadId: IDS.fad,
              schemaVersion: 1,
            };
      const contract = createFreeAgentDraftActivityContract({
        eventType,
        metadata,
      });
      assert.deepEqual(contract, {
        eventType,
        metadata,
      });
      assertDeepFrozen(contract);
    }

    assert.throws(
      () =>
        createFreeAgentDraftActivityContract({
          eventType: FREE_AGENT_DRAFT_ACTIVITY_TYPES[0],
          metadata: {},
          displaySummary: "extra",
        }),
      contractError("activity_contract_fields_invalid")
    );
  });

  it("enforces the exact safe setup-exemption metadata boundary", () => {
    const metadata = {
      exemptionId: IDS.exemption,
      seasonId: IDS.season,
      migrationReportId: IDS.migrationReport,
    };
    const contract = createFreeAgentDraftActivityContract({
      eventType: "fad_setup_exemption_authorized",
      metadata,
    });
    assert.deepEqual(contract.metadata, metadata);
    assertDeepFrozen(contract);

    for (const field of Object.keys(metadata)) {
      const missing = { ...metadata };
      delete missing[field];
      assert.throws(
        () =>
          validateFreeAgentDraftActivityMetadata(
            "fad_setup_exemption_authorized",
            missing
          ),
        contractError("activity_metadata_fields_invalid")
      );
    }
    for (const [field, value, reasonCode] of [
      ["reason", "private reason", "activity_metadata_fields_invalid"],
      ["playerId", IDS.player, "activity_metadata_fields_invalid"],
      ["exemptionId", "not-a-uuid", "activity_metadata_id_invalid"],
    ]) {
      assert.throws(
        () =>
          validateFreeAgentDraftActivityMetadata(
            "fad_setup_exemption_authorized",
            { ...metadata, [field]: value }
          ),
        contractError(reasonCode)
      );
    }
  });

  it("rejects private Candidate data from the opening activity while allowing post-publication explanatory ranking metadata", () => {
    for (const field of [
      "cardId",
      "playerId",
      "candidateOffer",
      "slotKey",
      "helpRequest",
      "contractValueCents",
      "activeBidValueCents",
    ]) {
      assert.throws(
        () =>
          validateFreeAgentDraftActivityMetadata(
            "free_agent_draft_started",
            {
              fadId: IDS.fad,
              [field]: "private",
            }
          ),
        contractError("activity_metadata_field_invalid")
      );
    }
    const published =
      validateFreeAgentDraftActivityMetadata(
        "free_agent_draft_player_awarded",
        {
          playerId: IDS.player,
          rankedOffers: [
            {
              totalValueCents: 600,
              aavCents: 300,
            },
          ],
        }
      );
    assert.equal(published.playerId, IDS.player);
    assert.equal(
      published.rankedOffers[0].totalValueCents,
      600
    );
  });

  it("rejects operational secrets, raw locations, unsafe values, exotic properties, and cycles", () => {
    const validate = (metadata) =>
      validateFreeAgentDraftActivityMetadata(
        "free_agent_draft_completed",
        metadata
      );

    for (const field of [
      "password",
      "sessionToken",
      "clientSecret",
      "sqlDetail",
      "exceptionStack",
      "helpMessage",
      "frontendUrl",
      "filesystemPath",
    ]) {
      assert.throws(
        () => validate({ [field]: "redacted" }),
        contractError("activity_metadata_field_invalid")
      );
    }
    for (const unsafe of [
      "https://example.test/leagues/one",
      "www.example.test/card",
      "/api/v1/leagues/one",
      "C:\\private\\fad.json",
      "line\nbreak",
      "\ud800",
    ]) {
      assert.throws(
        () => validate({ value: unsafe }),
        contractError("activity_metadata_string_invalid")
      );
    }
    for (const unsafe of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () => validate({ value: unsafe }),
        contractError("activity_metadata_number_invalid")
      );
    }
    for (const unsafe of [
      new Date(0),
      new Map(),
      /unsafe/u,
      undefined,
      1n,
      Symbol("unsafe"),
      () => {},
    ]) {
      assert.throws(
        () => validate({ value: unsafe }),
        contractError(
          typeof unsafe === "object"
            ? "activity_metadata_object_invalid"
            : "activity_metadata_value_invalid"
        )
      );
    }

    const accessor = {};
    Object.defineProperty(accessor, "fadId", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    assert.throws(
      () => validate(accessor),
      contractError("activity_metadata_object_invalid")
    );

    const symbol = { fadId: IDS.fad };
    symbol[Symbol("private")] = "secret";
    assert.throws(
      () => validate(symbol),
      contractError("activity_metadata_object_invalid")
    );

    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
      () => validate(cyclic),
      contractError("activity_metadata_cycle_invalid")
    );
  });

  it("rejects excessive depth, collection size, and serialized byte size", () => {
    const validate = (metadata) =>
      validateFreeAgentDraftActivityMetadata(
        "free_agent_draft_completed",
        metadata
      );
    let deep = { value: true };
    for (let index = 0; index < 9; index += 1) {
      deep = { child: deep };
    }
    assert.throws(
      () => validate(deep),
      contractError("activity_metadata_depth_invalid")
    );
    assert.throws(
      () =>
        validate({
          values: Array.from(
            { length: 101 },
            (_, index) => index
          ),
        }),
      contractError("activity_metadata_array_invalid")
    );
    assert.throws(
      () =>
        validate(
          Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [
              `field${index}`,
              index,
            ])
          )
        ),
      contractError("activity_metadata_size_invalid")
    );
    assert.throws(
      () =>
        validate({
          values: Array.from({ length: 100 }, () =>
            "x".repeat(500)
          ),
        }),
      contractError("activity_metadata_size_invalid")
    );
  });
});
