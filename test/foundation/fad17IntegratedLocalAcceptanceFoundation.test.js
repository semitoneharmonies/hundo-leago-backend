"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_CATALOG,
} = require(
  "../../src/infrastructure/persistence/sqlite/repositoryCatalog"
);
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);
const {
  createTargetRuntime,
  TARGET_ENDPOINTS,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  createSecurityFoundations,
} = require(
  "../../src/bootstrap/createSecurityFoundations"
);
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  createReleaseQaRuntime,
} = require(
  "../../src/operations/release/createReleaseQaRuntime"
);
const {
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const REAL_CATALOG_FORWARD_COUNT = 500;
const REAL_CATALOG_DEFENCE_COUNT = 250;

function seedRealPlayerCatalog(database) {
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIRECTORY, "players.json"),
      "utf8"
    )
  );
  const selected = [
    ...catalog.filter(
      ({ active, position }) =>
        active === true && position === "F"
    ).slice(0, REAL_CATALOG_FORWARD_COUNT),
    ...catalog.filter(
      ({ active, position }) =>
        active === true && position === "D"
    ).slice(0, REAL_CATALOG_DEFENCE_COUNT),
  ];
  assert.equal(
    selected.length,
    REAL_CATALOG_FORWARD_COUNT + REAL_CATALOG_DEFENCE_COUNT
  );
  assert.equal(
    selected.some(({ fullName }) =>
      fullName.toLowerCase().startsWith("fixture player ")
    ),
    false
  );
  let idCounter = 0;
  const repository = createSqlitePlayerCatalogRepository({
    database,
    createId: () =>
      `30000000-0000-4000-8000-${String(
        ++idCounter
      ).padStart(12, "0")}`,
    now: () => 1_700_000_000_100,
  });
  repository.applyCatalog({
    sourceOperationId:
      "20000000-0000-4000-8000-000000000001",
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: selected.map((player) => ({
      providerPlayerId: String(player.id),
      firstName: player.firstName,
      lastName: player.lastName,
      fullName: player.fullName,
      birthDate: player.birthDate,
      status: "active",
      sourcePosition: player.position,
      normalizedPosition: player.position,
      nhlTeamAbbreviation:
        player.teamAbbrev ?? null,
      active: true,
      sourceVersion: "players-json-2026",
      sourceUpdatedAtMs: 1_700_000_000_000,
    })),
  });
}

function createMigrationRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return {
    database: connection.database,
    migrationsDirectory,
  };
}

function copyMigrationRange(
  migrationsDirectory,
  minimumId,
  maximumId
) {
  for (const migration of discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  })) {
    if (
      migration.id < minimumId ||
      migration.id > maximumId
    ) {
      continue;
    }
    fs.copyFileSync(
      migration.filePath,
      path.join(
        migrationsDirectory,
        migration.fileName
      )
    );
  }
}

function migrate(runtime, applicationBuildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory:
        runtime.migrationsDirectory,
    }),
    applicationBuildId,
    now: () => 1_000,
  });
}

function schemaInventory(database) {
  return database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all();
}

function migrationLedger(database) {
  return database.prepare(`
    SELECT migration_id AS migrationId,
           file_name AS fileName,
           checksum
    FROM schema_migrations
    ORDER BY migration_id ASC
  `).all();
}

function applicationTableNames(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'schema_migrations'
    ORDER BY name ASC
  `).all().map(({ name }) => name);
}

function mutableSecurityFoundations(
  now,
  loggerSink = () => {}
) {
  return createSecurityFoundations({
    env: {
      APP_ENV: "local",
      NODE_ENV: "development",
      LOG_LEVEL: "error",
      PUBLIC_FRONTEND_ORIGIN: FRONTEND_ORIGIN,
      FRONTEND_ORIGINS: FRONTEND_ORIGIN,
      EMAIL_DELIVERY_MODE: "capture",
      RATE_LIMIT_KEY_SECRET:
        "fad17-rate-limit-secret-material-0123456789",
      AUDIT_METADATA_SECRET:
        "fad17-audit-secret-material-9876543210",
      ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(
        32,
        0x5a
      ).toString("base64url"),
    },
    now,
    loggerSink,
  });
}

function authenticate(runtime, userId) {
  const issued =
    runtime.services.sessionService.issueForUser({
      userId,
    });
  const authenticated =
    runtime.services.sessionService.resolveWithoutActivity(
      issued.rawSessionToken
    );
  assert.equal(authenticated.valid, true);
  return authenticated;
}

function addRapidAuctionPlayers({
  runtime,
  database,
  leagueId,
  correctedByUserId,
}) {
  const repositories =
    runtime.repositories.context.repositories;
  return database.transaction(() =>
    ["aggregate-one", "aggregate-two", "renomination"].map(
      (alias, index) => {
        const playerId = fixtureId(
          `fad17:rapid-player:${alias}`
        );
        repositories.players.insert({
          id: playerId,
          first_name: "FAD17",
          last_name: `Rapid ${index + 1}`,
          full_name: `FAD17 Rapid ${index + 1}`,
          birth_date: null,
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        repositories.league_player_positions.insert({
          id: fixtureId(
            `fad17:rapid-position:${alias}`
          ),
          league_id: leagueId,
          player_id: playerId,
          position_group: index === 1 ? "D" : "F",
          reason: "FAD-17 integrated local acceptance",
          corrected_by_user_id: correctedByUserId,
          effective_at_ms: 1,
          ended_at_ms: null,
          version: 1,
        });
        return Object.freeze({ alias, playerId });
      }
    )
  ).immediate();
}

test(
  "FAD-17 rehearses exact schema 22 through 54 with fresh schema and repository-catalog agreement",
  (t) => {
    const upgraded = createMigrationRuntime(
      t,
      "hundo-fad17-schema22-upgrade-"
    );
    copyMigrationRange(
      upgraded.migrationsDirectory,
      1,
      22
    );
    assert.equal(
      migrate(upgraded, "fad17-schema22").status,
      "exact"
    );
    assert.equal(
      upgraded.database.pragma("user_version", {
        simple: true,
      }),
      22
    );

    copyMigrationRange(
      upgraded.migrationsDirectory,
      23,
      54
    );
    assert.equal(
      migrate(upgraded, "fad17-schema54-upgrade")
        .status,
      "exact"
    );

    const fresh = createMigrationRuntime(
      t,
      "hundo-fad17-schema54-fresh-"
    );
    copyMigrationRange(
      fresh.migrationsDirectory,
      1,
      54
    );
    assert.equal(
      migrate(fresh, "fad17-schema54-fresh").status,
      "exact"
    );

    for (const runtime of [upgraded, fresh]) {
      assert.equal(
        runtime.database.pragma("user_version", {
          simple: true,
        }),
        54
      );
      assert.deepEqual(
        runtime.database.pragma("foreign_key_check"),
        []
      );
      assert.deepEqual(
        runtime.database.pragma("integrity_check"),
        [{ integrity_check: "ok" }]
      );
      assert.deepEqual(
        applicationTableNames(runtime.database),
        REPOSITORY_CATALOG.map(
          ({ tableName }) => tableName
        ).sort()
      );
    }

    assert.deepEqual(
      schemaInventory(upgraded.database),
      schemaInventory(fresh.database)
    );
    assert.deepEqual(
      migrationLedger(upgraded.database),
      migrationLedger(fresh.database)
    );
    assert.equal(
      migrationLedger(upgraded.database).length,
      54
    );
  }
);

test(
  "FAD-17 keeps Season 2 presentation video absent and nonblocking in the real local fixture",
  async (t) => {
    const started = await createReleaseQaRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "open",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      password: "hundo",
      port: 0,
    });
    t.after(() => started.close());

    seedRealPlayerCatalog(started.runtime.database);
    const manifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: started.runtime,
      });
    assert.deepEqual(
      Object.values(manifest.leagues).map(
        ({ phase }) => phase
      ),
      ["cards_open", "cards_open", "completed"]
    );

    const endpointInventory = TARGET_ENDPOINTS.map(
      ({ method, path: endpointPath }) =>
        `${method} ${endpointPath}`
    );
    const serviceInventory = [
      ...Object.keys(started.runtime.services),
      ...Object.keys(
        started.runtime.services.league ?? {}
      ),
    ];
    assert.equal(
      endpointInventory.some((entry) =>
        /video|presentation/iu.test(entry)
      ),
      false
    );
    assert.equal(
      serviceInventory.some((entry) =>
        /video|presentation/iu.test(entry)
      ),
      false
    );
  }
);

test(
  "FAD-17 resolves concurrent unreserved wins and permits next-cycle renomination after no bid",
  async (t) => {
    const started = await createReleaseQaRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "open",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      password: "hundo",
      port: 0,
    });
    t.after(() => started.close());
    seedRealPlayerCatalog(started.runtime.database);
    const manifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: started.runtime,
      });
    const alpha = manifest.leagues.alpha;
    let currentNowMs = alpha.candidateDeadlineAtMs;
    const runtimeLogs = [];
    const database = started.runtime.database;
    const runtime = createTargetRuntime({
      database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      securityFoundations:
        mutableSecurityFoundations(
          () => currentNowMs,
          (entry) => runtimeLogs.push(entry)
        ),
      currentSeason: {
        label: "2026",
        nhlSeasonKey: "20262027",
      },
      leagueWriteMode: "open",
      networkSourceResolver() {
        return "127.0.0.1";
      },
    });
    const manager = authenticate(
      runtime,
      manifest.accounts.alphaMultiTeamManager.userId
    );
    const commissioner = authenticate(
      runtime,
      manifest.accounts.alphaCommissioner.userId
    );
    const team = alpha.teams.find(
      ({ alias }) => alias === "alphaTeam1"
    );
    const players = addRapidAuctionPlayers({
      runtime,
      database,
      leagueId: alpha.leagueId,
      correctedByUserId:
        manifest.accounts.alphaCommissioner.userId,
    });

    const deadline = await runtime.services.league
      .freeAgentDraftDeadlineJob.run();
    assert.equal(deadline.succeeded, 2);
    const allocation = await runtime.services.league
      .freeAgentDraftAllocationCycleJob.run();
    assert.equal(allocation.status, "succeeded");
    assert.equal(
      database.prepare(`
        SELECT status
        FROM free_agent_drafts
        WHERE id = ?
      `).get(alpha.fadId).status,
      "rapid"
    );

    const openedAuctions = players.map(
      ({ playerId }, index) =>
        runtime.services.league.auction.start({
          leagueId: alpha.leagueId,
          input: {
            playerId,
            teamId: team.teamId,
            aavCents:
              index < 2 ? 6_000 : 100,
            termYears: 1,
          },
          idempotencyKey:
            `fad17-concurrent-start-${index + 1}`,
          authenticated: manager,
        })
    );
    assert.deepEqual(
      openedAuctions.map(({ kind }) => kind),
      ["auction_opened", "auction_opened", "auction_opened"]
    );
    const auctionIds = openedAuctions.map(
      ({ auction }) => auction.auctionId
    );
    const bidRows = database.prepare(`
      SELECT id, auction_id, version
      FROM auction_bids
      WHERE auction_id IN (?, ?, ?)
      ORDER BY auction_id ASC
    `).all(...auctionIds);
    assert.equal(bidRows.length, 3);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_ownerships
        WHERE league_id = ?
          AND player_id IN (?, ?, ?)
      `).get(
        alpha.leagueId,
        ...players.map(({ playerId }) => playerId)
      ).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM contracts
        WHERE league_id = ?
          AND player_id IN (?, ?, ?)
      `).get(
        alpha.leagueId,
        ...players.map(({ playerId }) => playerId)
      ).count,
      0
    );

    const noBidAuctionId = auctionIds[2];
    const noBid = bidRows.find(
      ({ auction_id: auctionId }) =>
        auctionId === noBidAuctionId
    );
    runtime.services.league.auctionAdministration
      .removeBid({
        leagueId: alpha.leagueId,
        auctionId: noBidAuctionId,
        bidId: noBid.id,
        input: {
          confirmation: "REMOVE AUCTION BID",
        },
        expectedBidVersion: noBid.version,
        idempotencyKey:
          "fad17-remove-renomination-starter",
        authenticated: commissioner,
      });

    currentNowMs = Math.max(
      ...openedAuctions.map(
        ({ auction }) => auction.resolvesAtMs
      )
    );
    const resolutionWriter =
      runtime.repositories.freeAgentDraftAuctionResolutionWriter;
    const dueBeforeResolution =
      resolutionWriter.listDue({
        nowMs: currentNowMs,
        limit: 10,
      });
    assert.equal(dueBeforeResolution.length, 3);
    assert.deepEqual(
      dueBeforeResolution
        .map(({ auctionId }) => auctionId)
        .sort(),
      [...auctionIds].sort()
    );
    const resolutions = await runtime.services.league
      .freeAgentDraftAuctionResolutionJob.run();
    assert.equal(
      resolutions.succeeded,
      3,
      JSON.stringify({ resolutions, runtimeLogs })
    );
    const durableReplays = dueBeforeResolution.map(
      (occurrence) =>
        resolutionWriter.findResolution({
          leagueId: occurrence.leagueId,
          auctionId: occurrence.auctionId,
          occurrenceKey: occurrence.occurrenceKey,
        })
    );
    assert.deepEqual(
      durableReplays
        .map(({ outcome }) => outcome)
        .sort(),
      ["no_winner", "winner", "winner"]
    );
    for (const replay of durableReplays) {
      assert.equal(replay.completed, true);
      assert.equal(replay.replayed, true);
      assert.equal(replay.allocationId, null);
      assert.equal(replay.allocationVersion, 0);
      assert.deepEqual(
        replay.evidence.clonedOfferEventIds,
        []
      );
      assert.equal(replay.evidence.stateEventId, null);
      assert.equal(
        replay.evidence.outboxEventIds.length,
        3 + replay.evidence.notificationIds.length
      );
    }
    const winnerOccurrence = dueBeforeResolution.find(
      ({ auctionId }) => auctionId === auctionIds[0]
    );
    const winnerReplay = durableReplays.find(
      ({ auctionId }) => auctionId === auctionIds[0]
    );
    const coordinatedReplay = await runtime.services.league
      .freeAgentDraftAuctionResolution
      .coordinateCommittedResolution({
        leagueId: winnerOccurrence.leagueId,
        seasonId: winnerOccurrence.seasonId,
        fadId: winnerOccurrence.fadId,
        allocationId: winnerOccurrence.allocationId,
        rolloverId: winnerOccurrence.rolloverId,
        auctionId: winnerOccurrence.auctionId,
        resolvesAtMs: winnerOccurrence.resolvesAtMs,
        occurrenceKey: winnerOccurrence.occurrenceKey,
        resolution: winnerReplay,
      });
    assert.equal(coordinatedReplay.completed, true);
    assert.equal(coordinatedReplay.replayed, true);
    assert.equal(coordinatedReplay.outcome, "winner");
    assert.deepEqual(
      coordinatedReplay.evidence,
      winnerReplay.evidence
    );
    assert.deepEqual(
      database.prepare(`
        SELECT id, status
        FROM auctions
        WHERE id IN (?, ?, ?)
        ORDER BY id ASC
      `).all(...auctionIds).map(({ status }) => status).sort(),
      ["no_winner", "resolved", "resolved"]
    );

    const wonPlayerIds = players
      .slice(0, 2)
      .map(({ playerId }) => playerId)
      .sort();
    assert.deepEqual(
      database.prepare(`
        SELECT player_id AS playerId
        FROM player_ownerships
        WHERE league_id = ?
          AND team_id = ?
          AND player_id IN (?, ?)
          AND ownership_kind = 'Rostered'
        ORDER BY player_id ASC
      `).all(
        alpha.leagueId,
        team.teamId,
        ...wonPlayerIds
      ).map(({ playerId }) => playerId),
      wonPlayerIds
    );
    const committedAavCents =
      database.prepare(`
        SELECT SUM(aav_cents) AS total
        FROM contracts
        WHERE league_id = ?
          AND current_team_id = ?
          AND status = 'active'
      `).get(alpha.leagueId, team.teamId).total;
    assert.equal(committedAavCents > 10_000, true);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_ownerships
        WHERE league_id = ?
          AND player_id = ?
      `).get(
        alpha.leagueId,
        players[2].playerId
      ).count,
      0
    );

    const rollover = await runtime.services.league
      .freeAgentDraftRolloverJob.run();
    assert.equal(
      rollover.succeeded,
      2,
      JSON.stringify({ rollover, runtimeLogs })
    );
    currentNowMs += 1;
    const renominated =
      runtime.services.league.auction.start({
        leagueId: alpha.leagueId,
        input: {
          playerId: players[2].playerId,
          teamId: team.teamId,
          aavCents: 100,
          termYears: 1,
        },
        idempotencyKey:
          "fad17-renominate-next-cycle",
        authenticated: manager,
      });
    assert.equal(renominated.kind, "auction_opened");
    assert.notEqual(
      renominated.auction.auctionId,
      noBidAuctionId
    );
    assert.equal(
      renominated.auction.player.playerId,
      players[2].playerId
    );
    assert.deepEqual(
      database.pragma("foreign_key_check"),
      []
    );
    assert.deepEqual(
      database.pragma("integrity_check"),
      [{ integrity_check: "ok" }]
    );
  }
);
