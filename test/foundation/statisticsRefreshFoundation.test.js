const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  STATISTICS_CODES,
} = require("../../src/domain/statistics/statisticsPolicy");
const {
  TARGET_STATISTICS_CODES,
  createTargetStatisticsService,
} = require("../../src/application/services/statistics/createTargetStatisticsService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqlitePlayerRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository");
const {
  createSqliteStatisticsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteStatisticsRepository");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-10-12T08:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function idFactory(start = 100) {
  let value = start;
  return () => uuid(value++);
}

function clock(start = NOW_MS) {
  let value = start;
  return () => value++;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-leago-m6-01-statistics-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "statistics.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-01-test",
    now: () => NOW_MS,
  });
  const players = createSqlitePlayerRepository({ database: connection.database });
  const repository = createSqliteStatisticsRepository({
    database: connection.database,
    createId: idFactory(800),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, players, repository };
}

function insertPlayer(players, value, externalValue) {
  players.create({
    player: {
      id: uuid(value),
      firstName: "Player",
      lastName: String(value),
      fullName: `Player ${value}`,
      birthDate: "2000-01-01",
      status: "active",
      createdAtMs: NOW_MS - 1000,
      updatedAtMs: NOW_MS - 1000,
    },
    externalId: {
      id: uuid(value + 100),
      playerId: uuid(value),
      provider: "nhl",
      externalValue,
      createdAtMs: NOW_MS - 1000,
    },
  });
}

function service(repository, provider, options = {}) {
  return createTargetStatisticsService({
    repository,
    provider,
    nhlSeasonKey: "20262027",
    minimumPlayerCount: 2,
    createId: options.createId || idFactory(300),
    nowMs: options.nowMs || clock(),
  });
}

const validRows = Object.freeze([
  Object.freeze({ playerId: 8478402, gamesPlayed: 3, goals: 2, assists: 1 }),
  Object.freeze({ playerId: 8478403, gamesPlayed: 4, goals: 0, assists: 4 }),
]);

describe("M6-01 SQLite target statistics refresh", () => {
  test("atomically persists a complete normalized refresh as the latest season set", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const target = service(runtime.repository, {
      async fetchRows() {
        return {
          rows: validRows,
          sourceVersion: "nhl-2026-10-12",
          sourceUpdatedAtMs: NOW_MS,
        };
      },
    });

    assert.deepEqual(await target.refresh(), {
      refreshId: uuid(301),
      status: "succeeded",
      playerCount: 2,
      sourceVersion: "nhl-2026-10-12",
    });
    const latest = target.readLatest();
    assert.equal(latest.refresh.status, "succeeded");
    assert.deepEqual(latest.totals, [
      {
        player_id: uuid(1),
        games_played: 3,
        goals: 2,
        assists: 1,
        nhl_points: 3,
        fantasy_points_hundredths: 350,
        source_updated_at_ms: NOW_MS,
      },
      {
        player_id: uuid(2),
        games_played: 4,
        goals: 0,
        assists: 4,
        nhl_points: 4,
        fantasy_points_hundredths: 400,
        source_updated_at_ms: NOW_MS,
      },
    ]);
  });

  test("records provider failure without replacing last-valid totals", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const ids = idFactory(300);
    await service(runtime.repository, { fetchRows: async () => validRows }, {
      createId: ids,
    }).refresh();
    const before = service(runtime.repository, { fetchRows: async () => validRows }).readLatest();
    const failing = service(runtime.repository, {
      async fetchRows() { throw new Error("secret provider response"); },
    }, { createId: ids, nowMs: clock(NOW_MS + 100) });

    await assert.rejects(() => failing.refresh(), {
      code: TARGET_STATISTICS_CODES.providerFailed,
    });
    assert.deepEqual(failing.readLatest(), before);
    const failed = runtime.database.prepare(
      "SELECT status, error_code, metadata_json FROM stat_refreshes ORDER BY started_at_ms DESC LIMIT 1"
    ).get();
    assert.deepEqual(failed, {
      status: "failed",
      error_code: TARGET_STATISTICS_CODES.providerFailed,
      metadata_json: null,
    });
  });

  test("rejects an undersized provider response and preserves an empty last-valid state", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    const target = service(runtime.repository, {
      fetchRows: async () => [validRows[0]],
    });
    await assert.rejects(() => target.refresh(), {
      code: STATISTICS_CODES.responseIncomplete,
    });
    assert.equal(target.readLatest(), null);
    assert.deepEqual(
      runtime.database.prepare("SELECT status, error_code FROM stat_refreshes").get(),
      { status: "rejected", error_code: STATISTICS_CODES.responseIncomplete }
    );
  });

  test("rolls back every candidate total when one provider identity is unmapped", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    const target = service(runtime.repository, { fetchRows: async () => validRows });
    await assert.rejects(() => target.refresh(), {
      code: TARGET_STATISTICS_CODES.persistenceFailed,
    });
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM player_stat_totals").get().count,
      0
    );
    assert.deepEqual(
      runtime.database.prepare("SELECT status, error_code FROM stat_refreshes").get(),
      { status: "rejected", error_code: TARGET_STATISTICS_CODES.persistenceFailed }
    );
  });

  test("keeps latest-season reads byte-for-byte read-only and ignores later rejected attempts", async (t) => {
    const runtime = createRuntime(t);
    insertPlayer(runtime.players, 1, "8478402");
    insertPlayer(runtime.players, 2, "8478403");
    const ids = idFactory(300);
    const successful = service(runtime.repository, { fetchRows: async () => validRows }, {
      createId: ids,
    });
    await successful.refresh();
    const rejected = service(runtime.repository, {
      fetchRows: async () => [{ ...validRows[0], goals: -1 }],
    }, { createId: ids, nowMs: clock(NOW_MS + 100) });
    await assert.rejects(() => rejected.refresh(), {
      code: STATISTICS_CODES.inputInvalid,
    });
    const before = runtime.database.serialize();
    const latest = rejected.readLatest();
    assert.equal(latest.refresh.id, uuid(301));
    assert.equal(before.equals(runtime.database.serialize()), true);
  });
});
