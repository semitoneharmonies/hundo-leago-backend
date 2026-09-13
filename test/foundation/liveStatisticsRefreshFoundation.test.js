const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  normalizeStatisticsRows,
} = require("../../src/domain/statistics/statisticsPolicy");
const {
  LIVE_STATISTICS_CODES,
  PLAYER_GAME_COVERAGE_CODES,
  createLiveStatisticsService,
} = require(
  "../../src/application/services/statistics/createLiveStatisticsService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
  repositoryError,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
const {
  createSqliteStatisticsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-10-12T08:00:00.000Z");
const CAPTURED_AT_MS = NOW_MS + 100;
const GAME_START_MS = NOW_MS + 10_000;
const SOURCE_UPDATED_AT_MS = NOW_MS + 50;
const LIVE_PROVIDER = "nhl-live";
const PLAYER_IDENTITY_PROVIDER = "nhl-catalog";
const REQUIREMENTS_SHA256 =
  "861588ac14315a916976323781b48c4528179a91dacf25d461b57a06b5dcb8ad";
const COVERAGE_SHA256 = "c".repeat(64);
const EVIDENCE_SHA256 = "e".repeat(64);

function uuid(value) {
  return (
    "20000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function idFactory(start = 100) {
  let value = start;
  return () => uuid(value++);
}

function clock(start = NOW_MS) {
  let value = start;
  return () => value++;
}

function occurrenceExecution(overrides = {}) {
  return Object.freeze({
    bindingId: uuid(710),
    claimedJobVersion: 2,
    jobType: "matchup:statistics_refresh",
    leagueId: uuid(700),
    leaseExpiresAtMs: NOW_MS + 60_000,
    leaseOwner: "live-statistics-test",
    leaseToken: "live-statistics-test-token",
    occurrenceKey: "matchup-statistics-refresh:test",
    runId: uuid(711),
    scheduleOperationId: uuid(712),
    scheduleVersion: 1,
    scheduledForMs: NOW_MS,
    seasonId: uuid(701),
    weekId: uuid(702),
    ...overrides,
  });
}

function emptyCoverageSnapshot(overrides = {}) {
  return snapshot({
    playerGameRows: [],
    playerGameCoverage: {
      schemaVersion: 1,
      throughAtMs: CAPTURED_AT_MS,
      players: [],
    },
    ...overrides,
  });
}

function createSqliteRuntime(
  t,
  { occurrenceExecutionGuard } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad05-live-statistics-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "statistics.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad05-live-statistics-guard-foundation",
    now: () => NOW_MS,
  });
  connection.database.prepare(
    "INSERT INTO leagues " +
      "(id, name, name_normalized, status, timezone, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, 'Live Guard League', " +
      "'live guard league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(uuid(700));
  connection.database.prepare(
    "INSERT INTO seasons " +
      "(id, league_id, label, nhl_season_key, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, '2026-27', '20262027', " +
      "'active', 1, 1, 1)"
  ).run(uuid(701), uuid(700));
  const insertPlayer = connection.database.prepare(
    "INSERT INTO players " +
      "(id, first_name, last_name, full_name, birth_date, status, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, 'Player', ?, ?, " +
      "'2000-01-01', 'active', 1, 1, 1)"
  );
  const insertIdentity = connection.database.prepare(
    "INSERT INTO player_external_ids " +
      "(id, player_id, provider, external_value, created_at_ms) " +
      "VALUES (?, ?, ?, ?, 1)"
  );
  for (let value = 1; value <= 3; value += 1) {
    insertPlayer.run(
      uuid(value),
      String(value),
      `Player ${value}`
    );
    insertIdentity.run(
      uuid(20 + value),
      uuid(value),
      PLAYER_IDENTITY_PROVIDER,
      String(100 + value)
    );
  }
  const repository = createSqliteStatisticsRepository({
    database: connection.database,
    createId: idFactory(5_000),
    ...(occurrenceExecutionGuard === undefined
      ? {}
      : { occurrenceExecutionGuard }),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    repository,
  });
}

function prepareLiveCompletion(
  runtime,
  {
    base = 800,
    execution,
    nhlSeasonKey = "20262027",
    refreshId,
  } = {}
) {
  const source = runtime.repository.ensureSource({
    id: uuid(base),
    provider: LIVE_PROVIDER,
    nowMs: NOW_MS,
  });
  const started = runtime.repository.startRefresh({
    id: uuid(base + 1),
    statSourceId: source.id,
    nhlSeasonKey,
    startedAtMs: NOW_MS,
  });
  const requirements =
    runtime.repository.readPlayerGameCoverageRequirements({
      nhlSeasonKey,
      playerIdentityProvider: PLAYER_IDENTITY_PROVIDER,
    });
  return Object.freeze({
    command: {
      refreshId: refreshId ?? started.id,
      statSourceId: source.id,
      provider: LIVE_PROVIDER,
      playerIdentityProvider: PLAYER_IDENTITY_PROVIDER,
      nhlSeasonKey,
      sourceVersion: "live-statistics-guard-v1",
      completedAtMs: CAPTURED_AT_MS,
      rows: normalizeStatisticsRows({
        rows: snapshot().totalsRows,
        minimumPlayerCount: 3,
        sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
      }),
      playerGameRows: [],
      requiredPlayers: requirements.requiredPlayers,
      requiredPlayerGames: requirements.requiredPlayerGames,
      requirementsSha256: requirements.requirementsSha256,
      playerGameCoverage: [],
      ...(execution === undefined
        ? {}
        : { occurrenceExecution: execution }),
    },
    refreshId: started.id,
  });
}

function assertNoSealedRefreshWrites(
  database,
  refreshId,
  expectedStatus = "started"
) {
  assert.deepEqual(
    database.prepare(
      "SELECT status, source_version FROM stat_refreshes WHERE id = ?"
    ).get(refreshId),
    { status: expectedStatus, source_version: null }
  );
  for (const table of [
    "player_stat_totals",
    "stat_refresh_player_game_coverage_entries",
    "player_game_stat_observations",
    "stat_refresh_player_game_sets",
  ]) {
    assert.equal(
      database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE refresh_id = ?`
      ).get(refreshId).count,
      0,
      `${table} retained a partial guarded completion`
    );
  }
}

const REQUIRED_PLAYERS = Object.freeze([
  Object.freeze({
    playerId: uuid(1),
    providerPlayerId: "101",
  }),
  Object.freeze({
    playerId: uuid(2),
    providerPlayerId: "102",
  }),
  Object.freeze({
    playerId: uuid(3),
    providerPlayerId: "103",
  }),
]);
const REQUIRED_PLAYER_GAMES = Object.freeze([
  Object.freeze({
    playerId: uuid(1),
    providerPlayerId: "101",
    providerTeamId: "10",
    nhlGameId: "9001",
    nhlGameScheduledStartsAtMs: GAME_START_MS,
  }),
]);

function providerCoveragePlayer(overrides = {}) {
  return {
    playerId: uuid(1),
    providerPlayerId: "101",
    providerTeamId: "10",
    disposition: "expected_game",
    games: [{
      providerTeamId: "10",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_START_MS,
      observedGameState: "scheduled",
    }],
    ...overrides,
  };
}

function noDueGameCoveragePlayer(overrides = {}) {
  return {
    playerId: uuid(2),
    providerPlayerId: "102",
    providerTeamId: "20",
    disposition: "no_due_game",
    games: [],
    ...overrides,
  };
}

function noTeamCoveragePlayer(overrides = {}) {
  return {
    playerId: uuid(3),
    providerPlayerId: "103",
    providerTeamId: null,
    disposition: "no_team",
    games: [],
    ...overrides,
  };
}

function playerGameRow(overrides = {}) {
  return {
    playerId: 101,
    nhlGameId: 9001,
    nhlGameScheduledStartsAtMs: GAME_START_MS,
    observedGameState: "scheduled",
    goals: 0,
    assists: 0,
    sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    provider: LIVE_PROVIDER,
    sourceVersion: "nhl-live-2026-10-12T08:00:00.100Z",
    capturedAtMs: CAPTURED_AT_MS,
    totalsSourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    totalsRows: [
      {
        playerId: 101,
        gamesPlayed: 1,
        goals: 0,
        assists: 0,
      },
      {
        playerId: 102,
        gamesPlayed: 1,
        goals: 1,
        assists: 2,
      },
      {
        playerId: 103,
        gamesPlayed: 0,
        goals: 0,
        assists: 0,
      },
    ],
    playerGameRows: [playerGameRow()],
    playerGameCoverage: {
      schemaVersion: 1,
      throughAtMs: CAPTURED_AT_MS,
      players: [
        noTeamCoveragePlayer(),
        providerCoveragePlayer(),
        noDueGameCoveragePlayer(),
      ],
    },
    ...overrides,
  };
}

function createRepository({
  requirements = [
    REQUIRED_PLAYERS[2],
    REQUIRED_PLAYERS[0],
    REQUIRED_PLAYERS[1],
  ],
  requiredPlayerGames = REQUIRED_PLAYER_GAMES,
  requirementsSha256 = REQUIREMENTS_SHA256,
  readError = null,
  completeError = null,
  events = [],
} = {}) {
  const calls = Object.seal({
    ensureSource: [],
    startRefresh: [],
    readRequirements: [],
    completeLiveRefresh: [],
    rejectRefresh: [],
  });
  let authoritativeRefreshId = "previous-successful-refresh";

  const repository = {
    ensureSource(command) {
      events.push("ensure-source");
      calls.ensureSource.push(command);
      return Object.freeze({
        id: command.id,
        provider: command.provider,
      });
    },
    startRefresh(command) {
      events.push("start-refresh");
      calls.startRefresh.push(command);
      return Object.freeze({ id: command.id, status: "started" });
    },
    readPlayerGameCoverageRequirements(command) {
      events.push("read-requirements");
      calls.readRequirements.push(command);
      if (readError) throw readError;
      return {
        schemaVersion: 1,
        nhlSeasonKey: command.nhlSeasonKey,
        playerIdentityProvider: command.playerIdentityProvider,
        requiredPlayers: structuredClone(requirements),
        requiredPlayerGames:
          structuredClone(requiredPlayerGames),
        requirementsSha256,
      };
    },
    completeLiveRefresh(command) {
      events.push("complete-refresh");
      calls.completeLiveRefresh.push(command);
      if (completeError) throw completeError;
      authoritativeRefreshId = command.refreshId;
      return Object.freeze({
        refresh: Object.freeze({
          id: command.refreshId,
          status: "succeeded",
          player_count: command.rows.length,
          source_version: command.sourceVersion,
        }),
        playerGameSet: Object.freeze({
          required_player_count: command.requiredPlayers.length,
          coverage_entry_count: command.playerGameCoverage.length,
          expected_player_game_count:
            command.playerGameCoverage.filter(
              (entry) => entry.disposition === "expected_game"
            ).length,
          coverage_sha256: COVERAGE_SHA256,
          observation_count: command.playerGameRows.length,
          evidence_sha256: EVIDENCE_SHA256,
          captured_at_ms: command.completedAtMs,
        }),
      });
    },
    rejectRefresh(command) {
      events.push("reject-refresh");
      calls.rejectRefresh.push(command);
      return Object.freeze({
        id: command.refreshId,
        status: command.status,
      });
    },
  };

  return Object.freeze({
    repository,
    calls,
    events,
    getAuthoritativeRefreshId() {
      return authoritativeRefreshId;
    },
  });
}

function service(repository, provider, options = {}) {
  return createLiveStatisticsService({
    repository,
    provider,
    nhlSeasonKey: "20262027",
    providerName: LIVE_PROVIDER,
    playerIdentityProvider:
      Object.hasOwn(options, "playerIdentityProvider")
        ? options.playerIdentityProvider
        : PLAYER_IDENTITY_PROVIDER,
    minimumPlayerCount: 3,
    createId: options.createId || idFactory(100),
    nowMs: options.nowMs || clock(),
  });
}

function successfulProvider({ events = [], result = snapshot() } = {}) {
  return Object.freeze({
    async fetchLiveSnapshot(input) {
      events.push("provider-fetch");
      return typeof result === "function" ? result(input) : result;
    },
  });
}

async function captureRejection(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the live statistics refresh to reject.");
}

describe("FAD-05 live statistics refresh service", () => {
  test("requires the exact player-game requirement repository boundary", () => {
    const fixture = createRepository();
    const incompleteRepository = {
      ...fixture.repository,
    };
    delete incompleteRepository.readPlayerGameCoverageRequirements;

    assert.throws(
      () => service(
        incompleteRepository,
        successfulProvider()
      ),
      {
        name: "TypeError",
        message:
          "live statistics requires a complete live statistics repository",
      }
    );
  });

  test("reads, fetches, validates, and persists one exact coverage set", async () => {
    const events = [];
    const fixture = createRepository({ events });
    let providerInput;
    const provider = successfulProvider({
      events,
      result(input) {
        providerInput = input;
        assert.deepEqual(input, {
          nhlSeasonKey: "20262027",
          requiredPlayers: REQUIRED_PLAYERS,
          requiredPlayerGames: REQUIRED_PLAYER_GAMES,
          requirementsSha256: REQUIREMENTS_SHA256,
        });
        assert.equal(Object.isFrozen(input.requiredPlayers), true);
        assert.equal(
          Object.isFrozen(input.requiredPlayerGames),
          true
        );
        return snapshot();
      },
    });
    const target = service(fixture.repository, provider);

    const result = await target.refresh();

    assert.deepEqual(events, [
      "ensure-source",
      "start-refresh",
      "read-requirements",
      "provider-fetch",
      "complete-refresh",
    ]);
    assert.deepEqual(fixture.calls.readRequirements, [{
      nhlSeasonKey: "20262027",
      playerIdentityProvider: PLAYER_IDENTITY_PROVIDER,
    }]);
    assert.equal(fixture.calls.completeLiveRefresh.length, 1);
    const completion = fixture.calls.completeLiveRefresh[0];
    assert.equal(
      completion.requiredPlayers,
      providerInput.requiredPlayers
    );
    assert.deepEqual(completion.requiredPlayers, REQUIRED_PLAYERS);
    assert.equal(
      completion.requiredPlayerGames,
      providerInput.requiredPlayerGames
    );
    assert.deepEqual(
      completion.requiredPlayerGames,
      REQUIRED_PLAYER_GAMES
    );
    assert.equal(
      completion.requirementsSha256,
      providerInput.requirementsSha256
    );
    assert.equal(
      completion.requirementsSha256,
      REQUIREMENTS_SHA256
    );
    assert.equal(completion.provider, LIVE_PROVIDER);
    assert.equal(
      completion.playerIdentityProvider,
      PLAYER_IDENTITY_PROVIDER
    );
    assert.deepEqual(completion.playerGameCoverage, [
      {
        playerId: uuid(1),
        providerPlayerId: "101",
        providerTeamId: "10",
        disposition: "expected_game",
        nhlGameId: "9001",
        nhlGameScheduledStartsAtMs: GAME_START_MS,
        observedGameState: "scheduled",
      },
      {
        playerId: uuid(2),
        providerPlayerId: "102",
        providerTeamId: "20",
        disposition: "no_due_game",
        nhlGameId: null,
        nhlGameScheduledStartsAtMs: null,
        observedGameState: null,
      },
      {
        playerId: uuid(3),
        providerPlayerId: "103",
        providerTeamId: null,
        disposition: "no_team",
        nhlGameId: null,
        nhlGameScheduledStartsAtMs: null,
        observedGameState: null,
      },
    ]);
    assert.deepEqual(completion.playerGameRows, [{
      externalPlayerId: "101",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_START_MS,
      observedGameState: "scheduled",
      goals: 0,
      assists: 0,
      nhlPoints: 0,
      fantasyPointsHundredths: 0,
      sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    }]);
    assert.deepEqual(result, {
      refreshId: uuid(101),
      status: "succeeded",
      playerCount: 3,
      playerGameObservationCount: 1,
      playerGameEvidenceSha256: EVIDENCE_SHA256,
      playerGameRequiredPlayerCount: 3,
      playerGameCoverageEntryCount: 3,
      playerGameExpectedPlayerGameCount: 1,
      playerGameCoverageSha256: COVERAGE_SHA256,
      sourceVersion: "nhl-live-2026-10-12T08:00:00.100Z",
      capturedAtMs: CAPTURED_AT_MS,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      fixture.getAuthoritativeRefreshId(),
      result.refreshId
    );
    assert.equal(fixture.calls.rejectRefresh.length, 0);
  });

  test("carries the exact scheduled occurrence execution object to persistence", async () => {
    const fixture = createRepository();
    const execution = occurrenceExecution();
    const target = service(
      fixture.repository,
      successfulProvider()
    );

    await target.refresh({ occurrenceExecution: execution });

    assert.equal(fixture.calls.completeLiveRefresh.length, 1);
    assert.equal(
      fixture.calls.completeLiveRefresh[0].occurrenceExecution,
      execution
    );
  });

  test("requires an explicit canonical player identity provider", () => {
    const fixture = createRepository();

    assert.throws(
      () => service(
        fixture.repository,
        successfulProvider(),
        { playerIdentityProvider: undefined }
      ),
      {
        name: "TypeError",
        message:
          "live statistics requires a canonical player identity provider",
      }
    );
  });

  test("rejects safely when exact requirement mappings cannot be read", async () => {
    const readError = Object.assign(
      new Error("provider mapping is missing"),
      { code: "STATISTICS_PLAYER_MAPPING_MISSING" }
    );
    const fixture = createRepository({ readError });
    let providerCalled = false;
    const target = service(fixture.repository, {
      async fetchLiveSnapshot() {
        providerCalled = true;
        return snapshot();
      },
    });

    const error = await captureRejection(() => target.refresh());

    assert.equal(error.code, LIVE_STATISTICS_CODES.persistenceFailed);
    assert.equal(error.cause, readError);
    assert.equal(providerCalled, false);
    assert.equal(fixture.calls.completeLiveRefresh.length, 0);
    assert.deepEqual(fixture.calls.rejectRefresh, [{
      refreshId: uuid(101),
      status: "rejected",
      errorCode: LIVE_STATISTICS_CODES.persistenceFailed,
      completedAtMs: NOW_MS + 1,
    }]);
    assert.equal(
      fixture.getAuthoritativeRefreshId(),
      "previous-successful-refresh"
    );
  });

  test("rejects a malformed requirement snapshot before provider access", async () => {
    const fixture = createRepository({
      requirementsSha256: "b".repeat(64),
    });
    let providerCalled = false;
    const target = service(fixture.repository, {
      async fetchLiveSnapshot() {
        providerCalled = true;
        return snapshot();
      },
    });

    const error = await captureRejection(() => target.refresh());

    assert.equal(error.code, LIVE_STATISTICS_CODES.persistenceFailed);
    assert.equal(providerCalled, false);
    assert.equal(fixture.calls.completeLiveRefresh.length, 0);
    assert.equal(
      fixture.calls.rejectRefresh[0].errorCode,
      LIVE_STATISTICS_CODES.persistenceFailed
    );
  });

  test("rejects a forged historical-game requirement snapshot before provider access", async () => {
    const fixture = createRepository({
      requiredPlayerGames: [{
        ...REQUIRED_PLAYER_GAMES[0],
        providerTeamId: "11",
      }],
    });
    let providerCalled = false;
    const target = service(fixture.repository, {
      async fetchLiveSnapshot() {
        providerCalled = true;
        return snapshot();
      },
    });

    const error = await captureRejection(() => target.refresh());

    assert.equal(error.code, LIVE_STATISTICS_CODES.persistenceFailed);
    assert.equal(providerCalled, false);
    assert.equal(fixture.calls.completeLiveRefresh.length, 0);
    assert.equal(
      fixture.calls.rejectRefresh[0].errorCode,
      LIVE_STATISTICS_CODES.persistenceFailed
    );
    assert.equal(
      fixture.getAuthoritativeRefreshId(),
      "previous-successful-refresh"
    );
  });

  test("preserves malformed requirement-set policy errors", async () => {
    const fixture = createRepository({
      requirements: [{
        playerId: uuid(1),
        providerPlayerId: null,
      }],
    });
    let providerCalled = false;
    const target = service(fixture.repository, {
      async fetchLiveSnapshot() {
        providerCalled = true;
        return snapshot();
      },
    });

    const error = await captureRejection(() => target.refresh());

    assert.equal(error.code, PLAYER_GAME_COVERAGE_CODES.inputInvalid);
    assert.equal(providerCalled, false);
    assert.equal(
      fixture.calls.rejectRefresh[0].errorCode,
      PLAYER_GAME_COVERAGE_CODES.inputInvalid
    );
  });

  test("preserves exact malformed and incomplete coverage error codes", async (t) => {
    const cases = [
      {
        name: "missing required coverage player",
        playerGameCoverage: {
          ...snapshot().playerGameCoverage,
          players: [
            providerCoveragePlayer(),
            noDueGameCoveragePlayer(),
          ],
        },
        code: PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
      },
      {
        name: "invalid terminal disposition shape",
        playerGameCoverage: {
          ...snapshot().playerGameCoverage,
          players: [
            providerCoveragePlayer(),
            noDueGameCoveragePlayer({ providerTeamId: null }),
            noTeamCoveragePlayer(),
          ],
        },
        code: PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      },
    ];

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const fixture = createRepository();
        const target = service(
          fixture.repository,
          successfulProvider({
            result: snapshot({
              playerGameCoverage: candidate.playerGameCoverage,
            }),
          })
        );

        const error = await captureRejection(() => target.refresh());

        assert.equal(error.code, candidate.code);
        assert.equal(
          fixture.calls.rejectRefresh[0].errorCode,
          candidate.code
        );
        assert.equal(fixture.calls.completeLiveRefresh.length, 0);
        assert.equal(
          fixture.getAuthoritativeRefreshId(),
          "previous-successful-refresh"
        );
      });
    }
  });

  test("rejects a missing or mismatched snapshot provider without replacing authority", async (t) => {
    for (const [name, providerValue] of [
      ["missing provider", undefined],
      ["mismatched provider", "other-live-provider"],
    ]) {
      await t.test(name, async () => {
        const providerSnapshot = snapshot();
        if (providerValue === undefined) {
          delete providerSnapshot.provider;
        } else {
          providerSnapshot.provider = providerValue;
        }
        const fixture = createRepository();
        const target = service(
          fixture.repository,
          successfulProvider({ result: providerSnapshot })
        );

        const error = await captureRejection(() => target.refresh());

        assert.equal(error.code, LIVE_STATISTICS_CODES.snapshotInvalid);
        assert.equal(fixture.calls.completeLiveRefresh.length, 0);
        assert.equal(fixture.calls.rejectRefresh.length, 1);
        assert.equal(
          fixture.calls.rejectRefresh[0].errorCode,
          LIVE_STATISTICS_CODES.snapshotInvalid
        );
        assert.equal(
          fixture.getAuthoritativeRefreshId(),
          "previous-successful-refresh"
        );
      });
    }
  });

  test("never turns a missing, extra, or equal-count-wrong row into zero", async (t) => {
    const cases = [
      {
        name: "missing expected row",
        playerGameRows: [],
      },
      {
        name: "extra row",
        playerGameRows: [
          playerGameRow(),
          playerGameRow({
            playerId: 102,
            nhlGameId: 9002,
          }),
        ],
      },
      {
        name: "equal count but wrong identity",
        playerGameRows: [playerGameRow({
          playerId: 102,
        })],
      },
    ];

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const fixture = createRepository();
        const target = service(
          fixture.repository,
          successfulProvider({
            result: snapshot({
              playerGameRows: candidate.playerGameRows,
            }),
          })
        );

        const error = await captureRejection(() => target.refresh());

        assert.equal(
          error.code,
          PLAYER_GAME_COVERAGE_CODES.responseIncomplete
        );
        assert.equal(
          fixture.calls.rejectRefresh[0].errorCode,
          PLAYER_GAME_COVERAGE_CODES.responseIncomplete
        );
        assert.equal(fixture.calls.completeLiveRefresh.length, 0);
      });
    }
  });

  test("records provider failure without exposing provider details", async () => {
    const fixture = createRepository();
    const target = service(fixture.repository, {
      async fetchLiveSnapshot() {
        throw new Error("provider secret");
      },
    });

    await assert.rejects(
      target.refresh(),
      {
        code: LIVE_STATISTICS_CODES.providerFailed,
        message: "The live statistics provider refresh failed.",
      }
    );
    assert.deepEqual(fixture.calls.rejectRefresh, [{
      refreshId: uuid(101),
      status: "failed",
      errorCode: LIVE_STATISTICS_CODES.providerFailed,
      completedAtMs: NOW_MS + 1,
    }]);
    assert.equal(fixture.calls.completeLiveRefresh.length, 0);
  });

  test("preserves the previous authority when persistence CAS conflicts", async () => {
    const persistenceConflict = Object.assign(
      new Error("requirements changed"),
      { code: "STATISTICS_REQUIREMENTS_VERSION_CONFLICT" }
    );
    const fixture = createRepository({
      completeError: persistenceConflict,
    });
    const target = service(
      fixture.repository,
      successfulProvider()
    );

    const error = await captureRejection(() => target.refresh());

    assert.equal(error.code, LIVE_STATISTICS_CODES.persistenceFailed);
    assert.equal(error.cause, persistenceConflict);
    assert.equal(fixture.calls.completeLiveRefresh.length, 1);
    assert.equal(
      fixture.calls.rejectRefresh[0].errorCode,
      LIVE_STATISTICS_CODES.persistenceFailed
    );
    assert.equal(
      fixture.getAuthoritativeRefreshId(),
      "previous-successful-refresh"
    );
  });

  test("revalidates persistence authority before sealing the snapshot", async () => {
    const fixture = createRepository();
    const target = service(
      fixture.repository,
      successfulProvider()
    );
    const authorityError = Object.assign(
      new Error("authority changed"),
      { code: "LIVE_STATISTICS_AUTHORITY_CHANGED" }
    );
    let checks = 0;

    await assert.rejects(
      target.refresh({
        authorizePersist: async () => {
          checks += 1;
          if (checks === 2) throw authorityError;
        },
      }),
      authorityError
    );

    assert.equal(checks, 2);
    assert.equal(fixture.calls.completeLiveRefresh.length, 0);
    assert.equal(
      fixture.calls.rejectRefresh[0].errorCode,
      LIVE_STATISTICS_CODES.persistenceFailed
    );
    assert.equal(
      fixture.getAuthoritativeRefreshId(),
      "previous-successful-refresh"
    );
  });
});

describe("FAD-05 generation-safe live statistics persistence", () => {
  test("validates the optional occurrence execution guard", (t) => {
    const runtime = createSqliteRuntime(t);

    assert.throws(
      () => createSqliteStatisticsRepository({
        database: runtime.database,
        occurrenceExecutionGuard: {},
      }),
      {
        name: "TypeError",
        message:
          "statistics occurrenceExecutionGuard must assert current execution",
      }
    );
  });

  test("keeps manual context-free live refresh completion unchanged", (t) => {
    const runtime = createSqliteRuntime(t);
    const prepared = prepareLiveCompletion(runtime);

    const result = runtime.repository.completeLiveRefresh(
      prepared.command
    );

    assert.equal(result.refresh.status, "succeeded");
    assert.equal(result.refresh.player_count, 3);
    assert.equal(result.playerGameSet.required_player_count, 0);
    assert.equal(result.playerGameSet.observation_count, 0);
  });

  test("guards the exact execution first, binds its NHL season, and fails a completion replay closed", (t) => {
    let database;
    const guardCalls = [];
    const guard = Object.freeze({
      assertCurrent(execution) {
        assert.equal(database.inTransaction, true);
        guardCalls.push(execution);
      },
    });
    const runtime = createSqliteRuntime(t, {
      occurrenceExecutionGuard: guard,
    });
    database = runtime.database;
    const execution = occurrenceExecution();
    const prepared = prepareLiveCompletion(runtime, {
      execution,
    });

    const result = runtime.repository.completeLiveRefresh(
      prepared.command
    );
    assert.equal(result.refresh.status, "succeeded");
    assert.deepEqual(guardCalls, [execution]);
    assert.equal(guardCalls[0], execution);

    assert.throws(
      () => runtime.repository.completeLiveRefresh(
        prepared.command
      ),
      { code: REPOSITORY_ERROR_CODES.versionConflict }
    );
    assert.deepEqual(guardCalls, [execution, execution]);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM player_stat_totals " +
          "WHERE refresh_id = ?"
      ).get(prepared.refreshId).count,
      3
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM stat_refresh_player_game_sets " +
          "WHERE refresh_id = ?"
      ).get(prepared.refreshId).count,
      1
    );
  });

  test("invokes the guard before reading even an unavailable refresh", (t) => {
    let database;
    const sentinel = repositoryError(
      REPOSITORY_ERROR_CODES.versionConflict,
      "The scheduled generation was superseded.",
      {
        details: {
          reasonCode:
            "MATCHUP_OCCURRENCE_GENERATION_SUPERSEDED",
        },
      }
    );
    let guardedExecution;
    const runtime = createSqliteRuntime(t, {
      occurrenceExecutionGuard: {
        assertCurrent(execution) {
          assert.equal(database.inTransaction, true);
          guardedExecution = execution;
          throw sentinel;
        },
      },
    });
    database = runtime.database;
    const execution = occurrenceExecution();
    const prepared = prepareLiveCompletion(runtime, {
      execution,
      refreshId: uuid(9_999),
    });

    assert.throws(
      () => runtime.repository.completeLiveRefresh(
        prepared.command
      ),
      (error) => error === sentinel
    );
    assert.equal(guardedExecution, execution);
    assertNoSealedRefreshWrites(
      database,
      prepared.refreshId
    );
  });

  test("requires a guard for scheduled completion and leaves no partial sealed rows", (t) => {
    const runtime = createSqliteRuntime(t);
    const prepared = prepareLiveCompletion(runtime, {
      execution: occurrenceExecution(),
    });

    assert.throws(
      () => runtime.repository.completeLiveRefresh(
        prepared.command
      ),
      { code: REPOSITORY_ERROR_CODES.scopeRequired }
    );
    assertNoSealedRefreshWrites(
      runtime.database,
      prepared.refreshId
    );
  });

  test("rejects non-statistics and wrong-NHL-season scopes only after the guard", async (t) => {
    for (const candidate of [
      {
        name: "non-statistics occurrence",
        execution: occurrenceExecution({ jobType: "matchup:lock" }),
      },
      {
        name: "occurrence season does not exist",
        execution: occurrenceExecution({ seasonId: uuid(799) }),
      },
    ]) {
      await t.test(candidate.name, (subtest) => {
        let database;
        let guardedExecution;
        const runtime = createSqliteRuntime(subtest, {
          occurrenceExecutionGuard: {
            assertCurrent(execution) {
              assert.equal(database.inTransaction, true);
              guardedExecution = execution;
            },
          },
        });
        database = runtime.database;
        const prepared = prepareLiveCompletion(runtime, {
          execution: candidate.execution,
        });

        assert.throws(
          () => runtime.repository.completeLiveRefresh(
            prepared.command
          ),
          { code: REPOSITORY_ERROR_CODES.scopeRequired }
        );
        assert.equal(guardedExecution, candidate.execution);
        assertNoSealedRefreshWrites(
          database,
          prepared.refreshId
        );
      });
    }
  });

  test("preserves superseded and lost-lease guard reasons without partial writes", async (t) => {
    for (const reasonCode of [
      "MATCHUP_OCCURRENCE_GENERATION_SUPERSEDED",
      "MATCHUP_OCCURRENCE_LEASE_LOST",
    ]) {
      await t.test(reasonCode, (subtest) => {
        let database;
        const guardedError = repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The scheduled occurrence is no longer current.",
          { details: { reasonCode } }
        );
        const runtime = createSqliteRuntime(subtest, {
          occurrenceExecutionGuard: {
            assertCurrent() {
              assert.equal(database.inTransaction, true);
              throw guardedError;
            },
          },
        });
        database = runtime.database;
        const prepared = prepareLiveCompletion(runtime, {
          execution: occurrenceExecution(),
        });

        assert.throws(
          () => runtime.repository.completeLiveRefresh(
            prepared.command
          ),
          (error) =>
            error === guardedError &&
            error.details.reasonCode === reasonCode
        );
        assertNoSealedRefreshWrites(
          database,
          prepared.refreshId
        );
      });
    }
  });

  test("rechecks the scheduled generation after provider work before sealing", async (t) => {
    let database;
    let generationState = "current";
    const guardError = repositoryError(
      REPOSITORY_ERROR_CODES.versionConflict,
      "The scheduled generation was superseded after provider work.",
      {
        details: {
          reasonCode:
            "MATCHUP_OCCURRENCE_GENERATION_SUPERSEDED",
        },
      }
    );
    const events = [];
    const runtime = createSqliteRuntime(t, {
      occurrenceExecutionGuard: {
        assertCurrent(execution) {
          assert.equal(database.inTransaction, true);
          events.push(["guard", execution]);
          if (generationState !== "current") throw guardError;
        },
      },
    });
    database = runtime.database;
    const execution = occurrenceExecution();
    const target = service(
      runtime.repository,
      {
        async fetchLiveSnapshot() {
          events.push(["provider"]);
          generationState = "superseded";
          return emptyCoverageSnapshot();
        },
      },
      { createId: idFactory(900) }
    );
    let authorizationChecks = 0;

    const error = await captureRejection(() => target.refresh({
      occurrenceExecution: execution,
      authorizePersist: async () => {
        authorizationChecks += 1;
      },
    }));

    assert.equal(error.code, LIVE_STATISTICS_CODES.persistenceFailed);
    assert.equal(error.cause, guardError);
    assert.equal(authorizationChecks, 2);
    assert.deepEqual(events, [
      ["provider"],
      ["guard", execution],
    ]);
    assertNoSealedRefreshWrites(
      database,
      uuid(901),
      "rejected"
    );
  });
});
