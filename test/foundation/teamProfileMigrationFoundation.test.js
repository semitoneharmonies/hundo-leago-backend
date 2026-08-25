const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-18-profile-migration-")
  );
  const migrationsDirectory = path.join(temporaryRoot, "migrations");
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { ...connection, migrationsDirectory };
}

function copyMigration(fileName, targetDirectory) {
  fs.copyFileSync(
    path.join(CANONICAL_MIGRATIONS, fileName),
    path.join(targetDirectory, fileName)
  );
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function copyThroughManagerTransfer(runtime) {
  for (const fileName of [
    "0001_initial.sql",
    "0002_add_pending_credential_setup_user_status.sql",
    "0003_add_league_invitation_team_workflow.sql",
    "0004_add_manager_transfer_intent.sql",
  ]) {
    copyMigration(fileName, runtime.migrationsDirectory);
  }
}

function seedLeagueAndTeam(database, {
  leagueId = uuid(1),
  teamId = uuid(2),
  logoReference = null,
} = {}) {
  database
    .prepare(`
      INSERT INTO leagues (
        id, name, name_normalized, status, timezone,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'setup', 'America/Vancouver', 10, 10)
    `)
    .run(leagueId, `League ${leagueId}`, `league ${leagueId}`);
  database
    .prepare(`
      INSERT INTO teams (
        id, league_id, name, name_normalized, status,
        primary_colour, secondary_colour, logo_reference,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'setup', NULL, NULL, ?, 10, 10)
    `)
    .run(teamId, leagueId, `Team ${teamId}`, `team ${teamId}`, logoReference);
  return { leagueId, teamId };
}

function insertLogo(database, {
  id = uuid(10),
  leagueId,
  teamId,
  mediaType = "image/png",
  bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  width = 1,
  height = 1,
  digest = "a".repeat(64),
} = {}) {
  database
    .prepare(`
      INSERT INTO team_logo_objects (
        id, league_id, team_id, media_type, byte_length,
        width, height, content_sha256, content_bytes, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 20)
    `)
    .run(
      id,
      leagueId,
      teamId,
      mediaType,
      bytes.byteLength,
      width,
      height,
      digest,
      bytes
    );
}

describe("M3-18 team-logo object migration", () => {
  test("adds immutable BLOB storage without changing existing team rows", (t) => {
    const runtime = createRuntime(t);
    copyThroughManagerTransfer(runtime);
    migrate(runtime, "m3-18-before");
    const ids = seedLeagueAndTeam(runtime.database, {
      logoReference: "legacy-logo-reference",
    });
    const before = runtime.database
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(ids.teamId);

    copyMigration(
      "0005_add_team_logo_objects.sql",
      runtime.migrationsDirectory
    );
    const result = migrate(runtime, "m3-18-upgrade");

    assert.equal(result.applied.length, 5);
    assert.equal(runtime.database.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(
      runtime.database.prepare("SELECT * FROM teams WHERE id = ?").get(ids.teamId),
      before
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT metadata_value FROM application_metadata
          WHERE metadata_key = 'data_model_version'
        `)
        .get().metadata_value,
      "5"
    );
    assert.equal(
      runtime.database.pragma("table_list")
        .find(({ name }) => name === "team_logo_objects").strict,
      1
    );
    assert.equal(runtime.database.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("enforces same-league team ownership and strict media metadata", (t) => {
    const runtime = createRuntime(t);
    copyThroughManagerTransfer(runtime);
    copyMigration(
      "0005_add_team_logo_objects.sql",
      runtime.migrationsDirectory
    );
    migrate(runtime, "m3-18-contract");
    const first = seedLeagueAndTeam(runtime.database);
    const second = seedLeagueAndTeam(runtime.database, {
      leagueId: uuid(3),
      teamId: uuid(4),
    });

    insertLogo(runtime.database, first);
    for (const options of [
      { id: uuid(11), leagueId: first.leagueId, teamId: second.teamId },
      { id: uuid(12), ...first, mediaType: "image/svg+xml" },
      { id: uuid(13), ...first, width: 2049 },
      { id: uuid(14), ...first, digest: "G".repeat(64) },
      { id: uuid(15), ...first, bytes: Buffer.alloc(524289) },
    ]) {
      assert.throws(() => insertLogo(runtime.database, options), /constraint/i);
    }
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM team_logo_objects")
        .get().count,
      1
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });
});
