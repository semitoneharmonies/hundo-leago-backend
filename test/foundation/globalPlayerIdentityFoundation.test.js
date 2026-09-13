const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  PLAYER_IDENTITY_CODES,
  createGlobalPlayerRecord,
  createPlayerExternalIdRecord,
} = require(
  "../../src/domain/players/playerIdentityPolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqlitePlayerRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T20:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-leago-m4-01-player-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "players.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-01-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  const players = createSqlitePlayerRepository({
    database: connection.database,
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    context,
    database: connection.database,
    players,
  };
}

function player(value, overrides = {}) {
  return {
    id: uuid(value),
    firstName: "Player",
    lastName: String(value),
    fullName: `Player ${value}`,
    birthDate: "2000-01-02",
    status: "active",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

function externalId(value, playerId, overrides = {}) {
  return {
    id: uuid(value),
    playerId,
    provider: "nhl",
    externalValue: `player-${value}`,
    createdAtMs: NOW_MS,
    ...overrides,
  };
}

describe("M4-01 global player identity policy", () => {
  test("creates immutable records with stable IDs and text external identifiers", () => {
    const playerRecord = createGlobalPlayerRecord(player(1));
    const externalRecord = createPlayerExternalIdRecord(
      externalId(2, playerRecord.id, { externalValue: "00123" })
    );
    assert.equal(playerRecord.id, uuid(1));
    assert.equal(playerRecord.full_name, "Player 1");
    assert.equal(externalRecord.player_id, uuid(1));
    assert.equal(externalRecord.external_value, "00123");
    assert.equal(Object.isFrozen(playerRecord), true);
    assert.equal(Object.isFrozen(externalRecord), true);
  });

  test("rejects invalid dates, timestamps, identifiers, and unknown fields", () => {
    assert.throws(
      () => createGlobalPlayerRecord(player(1, { birthDate: "2026-02-29" })),
      { code: PLAYER_IDENTITY_CODES.inputInvalid }
    );
    assert.throws(
      () => createGlobalPlayerRecord(player(1, { updatedAtMs: NOW_MS - 1 })),
      { code: PLAYER_IDENTITY_CODES.inputInvalid }
    );
    assert.throws(
      () => createPlayerExternalIdRecord({
        ...externalId(2, uuid(1)),
        provider: " nhl",
      }),
      { code: PLAYER_IDENTITY_CODES.inputInvalid }
    );
    assert.throws(
      () => createGlobalPlayerRecord({ ...player(1), extra: true }),
      { code: PLAYER_IDENTITY_CODES.inputInvalid }
    );
  });
});

describe("M4-01 SQLite player repository", () => {
  test("creates and resolves distinct same-name players through stable provider identifiers", (t) => {
    const runtime = createRuntime(t);
    const first = runtime.players.create({
      player: player(1, { fullName: "Alex Smith" }),
      externalId: externalId(11, uuid(1), { externalValue: "00123" }),
    });
    const second = runtime.players.create({
      player: player(2, { fullName: "Alex Smith" }),
      externalId: externalId(12, uuid(2), { externalValue: "00456" }),
    });

    assert.equal(first.player.id, uuid(1));
    assert.equal(second.player.id, uuid(2));
    assert.equal(
      runtime.players.findByExternalIdentifier({
        provider: "nhl",
        externalValue: "00123",
      }).id,
      uuid(1)
    );
    assert.equal(
      runtime.players.findByExternalIdentifier({
        provider: "nhl",
        externalValue: "00456",
      }).id,
      uuid(2)
    );
    assert.equal(Object.isFrozen(first.player), true);
    assert.equal(Object.isFrozen(second.externalId), true);
  });

  test("allows the same text identifier in independent provider namespaces", (t) => {
    const runtime = createRuntime(t);
    runtime.players.create({
      player: player(1),
      externalId: externalId(11, uuid(1), { externalValue: "00123" }),
    });
    runtime.players.create({
      player: player(2),
      externalId: externalId(12, uuid(2), {
        provider: "secondary-provider",
        externalValue: "00123",
      }),
    });

    assert.equal(
      runtime.players.findByExternalIdentifier({
        provider: "secondary-provider",
        externalValue: "00123",
      }).id,
      uuid(2)
    );
  });

  test("rolls back the player when its provider identifier duplicates an existing record", (t) => {
    const runtime = createRuntime(t);
    runtime.players.create({
      player: player(1),
      externalId: externalId(11, uuid(1), { externalValue: "00123" }),
    });
    const before = runtime.database.serialize();

    assert.throws(
      () => runtime.players.create({
        player: player(2),
        externalId: externalId(12, uuid(2), { externalValue: "00123" }),
      }),
      { code: REPOSITORY_ERROR_CODES.constraint }
    );

    assert.equal(runtime.players.findById(uuid(2)), null);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("keeps missing and invalid reads read-only", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    assert.equal(runtime.players.findById(uuid(1)), null);
    assert.equal(
      runtime.players.findByExternalIdentifier({
        provider: "nhl",
        externalValue: "missing",
      }),
      null
    );
    assert.throws(
      () => runtime.players.findByExternalIdentifier({
        provider: " nhl",
        externalValue: "missing",
      }),
      { code: PLAYER_IDENTITY_CODES.inputInvalid }
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("uses the existing immutable M2 migration ledger in an isolated database", (t) => {
    const runtime = createRuntime(t);
    const ledger = runtime.database.prepare(
      "SELECT file_name, checksum FROM schema_migrations WHERE file_name = ?"
    ).get("0001_initial.sql");
    assert.equal(ledger.file_name, "0001_initial.sql");
    assert.match(ledger.checksum, /^[a-f0-9]{64}$/);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('players', 'player_external_ids')"
      ).get().count,
      2
    );
  });
});
