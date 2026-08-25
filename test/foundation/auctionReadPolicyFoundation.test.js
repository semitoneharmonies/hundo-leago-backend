"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  AUCTION_READ_INPUT_INVALID,
  AuctionReadPolicyError,
  encodeAuctionReadCursor,
  normalizeAuctionListQuery,
} = require(
  "../../src/domain/auctions/auctionReadPolicy"
);

const FAD_ID =
  "00000000-0000-4000-8000-000000000001";
const AUCTION_ID =
  "00000000-0000-4000-8000-000000000002";

function assertInvalid(invoke, reasonCode) {
  assert.throws(
    invoke,
    (error) =>
      error instanceof AuctionReadPolicyError &&
      error.code === AUCTION_READ_INPUT_INVALID &&
      error.reasonCode === reasonCode
  );
}

describe("FAD-06 auction read query policy", () => {
  test("defaults to the exact active page and freezes the normalized filter", () => {
    const query = normalizeAuctionListQuery();
    assert.deepEqual(query, {
      sourceKind: null,
      fadId: null,
      statuses: ["active"],
      q: "",
      limit: 50,
      order: "resolves_asc",
      cursor: null,
    });
    assert.equal(Object.isFrozen(query), true);
    assert.equal(Object.isFrozen(query.statuses), true);
  });

  test("deduplicates and canonical-sorts repeatable statuses and selects the exact order", () => {
    const terminal = normalizeAuctionListQuery({
      status: [
        "cancelled",
        "resolved",
        "cancelled",
      ],
    });
    assert.deepEqual(
      terminal.statuses,
      ["resolved", "cancelled"]
    );
    assert.equal(terminal.order, "resolved_desc");

    const mixed = normalizeAuctionListQuery({
      status: ["no_winner", "active"],
    });
    assert.deepEqual(
      mixed.statuses,
      ["active", "no_winner"]
    );
    assert.equal(mixed.order, "updated_desc");
  });

  test("normalizes bounded player text and accepts only the approved context filters and limits", () => {
    const query = normalizeAuctionListQuery({
      sourceKind: "fad_restricted",
      fadId: FAD_ID,
      q: "  Connor   McDAVID  ",
      limit: "100",
    });
    assert.deepEqual(query, {
      sourceKind: "fad_restricted",
      fadId: FAD_ID,
      statuses: ["active"],
      q: "connor mcdavid",
      limit: 100,
      order: "resolves_asc",
      cursor: null,
    });
  });

  test("rejects unknown fields, arrays outside status, comma status syntax, invalid context pairs, text, and limits", () => {
    const cases = [
      [
        () => normalizeAuctionListQuery({ extra: "x" }),
        "query_fields_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ sourceKind: ["ordinary_weekly"] }),
        "source_kind_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ status: "active,resolved" }),
        "status_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ status: [] }),
        "status_invalid",
      ],
      [
        () => normalizeAuctionListQuery({
          sourceKind: "ordinary_weekly",
          fadId: FAD_ID,
        }),
        "fad_id_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ q: "bad\u0000text" }),
        "query_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ q: "x".repeat(201) }),
        "query_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ limit: "0" }),
        "limit_invalid",
      ],
      [
        () => normalizeAuctionListQuery({ limit: "101" }),
        "limit_invalid",
      ],
    ];
    for (const [invoke, reasonCode] of cases) {
      assertInvalid(invoke, reasonCode);
    }
  });

  test("round-trips one opaque cursor bound to every normalized filter and its order", () => {
    const query = normalizeAuctionListQuery({
      sourceKind: "fad_open_rapid",
      fadId: FAD_ID,
      status: ["active", "resolved"],
      q: "goalie",
      limit: "75",
    });
    const cursor = encodeAuctionReadCursor(query, {
      sortMs: 1_800_000_000_000,
      auctionId: AUCTION_ID,
    });
    assert.equal(
      cursor,
      "eyJhdWN0aW9uSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJmaWx0ZXJTaGEyNTYiOiJkMWIyMjFiNjk1ZmI4MjU0ZWQxZTViNDA5NjQzOTYzZTViMGZlOGZhMjNjM2ZkMzZjOGFiMDNkN2FmNDkxYzA1Iiwib3JkZXIiOiJ1cGRhdGVkX2Rlc2MiLCJzb3J0TXMiOjE4MDAwMDAwMDAwMDAsInZlcnNpb24iOjF9"
    );
    const replay = normalizeAuctionListQuery({
      sourceKind: "fad_open_rapid",
      fadId: FAD_ID,
      status: ["resolved", "active", "active"],
      q: "  GOALIE ",
      limit: 75,
      cursor,
    });
    assert.deepEqual(replay.cursor, {
      sortMs: 1_800_000_000_000,
      auctionId: AUCTION_ID,
    });
    assert.equal(Object.isFrozen(replay.cursor), true);
  });

  test("rejects malformed, noncanonical, and cross-filter cursor reuse", () => {
    const query = normalizeAuctionListQuery({
      status: "resolved",
    });
    const cursor = encodeAuctionReadCursor(query, {
      sortMs: 1_700_000_000_000,
      auctionId: AUCTION_ID,
    });
    for (const invoke of [
      () => normalizeAuctionListQuery({ cursor: "!" }),
      () => normalizeAuctionListQuery({
        status: "resolved",
        cursor: `${cursor}=`,
      }),
      () => normalizeAuctionListQuery({
        status: "cancelled",
        cursor,
      }),
      () => normalizeAuctionListQuery({
        status: ["active", "resolved"],
        cursor,
      }),
    ]) {
      assertInvalid(invoke, "cursor_invalid");
    }
  });
});
