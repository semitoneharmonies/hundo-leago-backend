const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  LATE_LOCK_MUTATION_WRITER_REGISTRY,
  createLateLockCoordinator,
} = require("../../src/application/services/matchups/createLateLockCoordinator");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");

const CURRENT_AUTHORITATIVE_ROSTER_WRITERS = Object.freeze([
  Object.freeze({
    path: "src/application/services/leagues/createRosterActionService.js",
    mutationKinds: Object.freeze([
      "roster_move",
      "injured_reserve_move",
      "buyout",
    ]),
  }),
  Object.freeze({
    path: "src/application/services/auctions/createAuctionResolutionService.js",
    mutationKinds: Object.freeze(["auction_resolution"]),
  }),
  Object.freeze({
    path: "src/application/services/trades/acceptTradeProposalService.js",
    mutationKinds: Object.freeze(["trade_acceptance"]),
  }),
  Object.freeze({
    path: "src/application/services/trades/createTradeReversalService.js",
    mutationKinds: Object.freeze(["trade_reversal"]),
  }),
  Object.freeze({
    path: "src/application/services/leagues/createCommissionerCorrectionService.js",
    mutationKinds: Object.freeze([
      "commissioner_addition",
      "commissioner_removal",
      "commissioner_correction",
      "contract_correction",
    ]),
  }),
  Object.freeze({
    path: "src/application/services/leagues/createLeagueLifecycleTransitionService.js",
    mutationKinds: Object.freeze(["contract_rollover"]),
  }),
]);

const TRADE_BLOCK_MUTATION_KIND = "team_workspace_trade_block";
const TRADE_BLOCK_WRITABLE_COLUMNS = Object.freeze([
  "trade_blocked",
  "updated_at_ms",
  "version",
]);

function source(relativePath) {
  return readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

function tradeBlockUpdateSql(repositorySource) {
  const preparedStatement = repositorySource.match(
    /updateTradeBlockStatement\s*=\s*database\.prepare\(\s*`([\s\S]*?)`\s*\);/u
  );
  assert.ok(preparedStatement, "the trade-block update statement must remain explicit");
  return preparedStatement[1];
}

describe("FAD-05 authoritative roster-writer registry classification", () => {
  test("registers every current authoritative roster-legality writer", () => {
    for (const writer of CURRENT_AUTHORITATIVE_ROSTER_WRITERS) {
      const writerSource = source(writer.path);
      assert.match(
        writerSource,
        /coordinateCommittedRoster/u,
        `${writer.path} must coordinate its committed roster mutation`
      );
      for (const mutationKind of writer.mutationKinds) {
        assert.equal(
          LATE_LOCK_MUTATION_WRITER_REGISTRY.includes(mutationKind),
          true,
          `${mutationKind} must be registered`
        );
        assert.equal(
          writerSource.includes(`"${mutationKind}"`),
          true,
          `${writer.path} must identify ${mutationKind} explicitly`
        );
      }
    }
  });

  test("classifies the trade-block toggle as legality-neutral ownership metadata", () => {
    const repositorySource = source(
      "src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository.js"
    );
    const serviceSource = source(
      "src/application/services/leagues/createTeamWorkspaceService.js"
    );
    const sql = tradeBlockUpdateSql(repositorySource);
    const setClause = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/u);
    assert.ok(setClause, "the trade-block update must have a bounded SET clause");
    const writableColumns = Array.from(
      setClause[1].matchAll(/^\s*([a-z][a-z0-9_]*)\s*=/gmu),
      (match) => match[1]
    );

    assert.deepEqual(writableColumns, TRADE_BLOCK_WRITABLE_COLUMNS);
    assert.equal(
      LATE_LOCK_MUTATION_WRITER_REGISTRY.includes(TRADE_BLOCK_MUTATION_KIND),
      false
    );
    assert.doesNotMatch(serviceSource, /coordinateCommittedRoster/u);
  });

  test("rejects the unregistered trade-block metadata kind before target reads", async () => {
    let targetReads = 0;
    const coordinator = createLateLockCoordinator({
      targetRepository: {
        listEligibleLateLocks() {
          targetReads += 1;
          return [];
        },
      },
      legalityService: {
        async lockLate() {
          throw new Error("unreachable");
        },
      },
      statisticsService: {
        async refresh() {
          throw new Error("unreachable");
        },
      },
      provider: "sportsdataio",
      clock: { nowMs: () => 1_000 },
    });

    assert.deepEqual(
      await coordinator.coordinateCommittedRoster({
        mutationKind: TRADE_BLOCK_MUTATION_KIND,
        teams: [
          {
            leagueId: "00000000-0000-4000-8000-000000000001",
            seasonId: "00000000-0000-4000-8000-000000000002",
            teamId: "00000000-0000-4000-8000-000000000003",
            ownershipWitnesses: [],
          },
        ],
      }),
      { status: "awaiting_data" }
    );
    assert.equal(targetReads, 0);
  });
});
