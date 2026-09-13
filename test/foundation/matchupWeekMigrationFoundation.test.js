const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { openDatabase } = require("../../src/infrastructure/database/connection");
const { applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

describe("M6-03 matchup lifecycle migration", () => {
  test("maps every legacy state and preserves pairing display context", (t) => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-03-migration-"));
    const connection = openDatabase({
      databasePath: path.join(temporaryRoot, "migration.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });
    const database = connection.database;
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    applyMigrations({
      database,
      migrations: migrations.slice(0, 15),
      applicationBuildId: "m6-03-before",
      now: () => 1,
    });
    database.prepare(
      "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, 'Legacy League', 'legacy league', 'active', 'America/Vancouver', 1, 1, 1)"
    ).run(uuid(1));
    database.prepare(
      "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
    ).run(uuid(2), uuid(1));
    const insertTeam = database.prepare(
      "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
    );
    insertTeam.run(uuid(3), uuid(1), "Home", "home");
    insertTeam.run(uuid(4), uuid(1), "Away", "away");
    const statuses = ["scheduled", "open", "locked", "finalizing", "finalized", "rolled_over", "failed"];
    const insertWeek = database.prepare(
      "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, " +
        "baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)"
    );
    const insertMatchup = database.prepare(
      "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
        "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'Home snapshot', 'Away snapshot', ?, 1, 1, 1)"
    );
    statuses.forEach((status, index) => {
      const weekId = uuid(20 + index);
      const start = 1000 + index * 2000;
      insertWeek.run(
        weekId, uuid(1), uuid(2), `week-${index + 1}`, index + 1, start,
        start + 100, start + 200, start + 1000, start + 1100, status
      );
      insertMatchup.run(
        uuid(40 + index), uuid(1), uuid(2), weekId, uuid(3), uuid(4),
        index === 1 ? "active" : index === 4 ? "finalized" : "scheduled"
      );
    });

    applyMigrations({
      database,
      migrations: migrations.slice(0, 16),
      applicationBuildId: "m6-03-after",
      now: () => 2,
    });
    assert.equal(database.pragma("user_version", { simple: true }), 16);
    assert.deepEqual(
      database.prepare("SELECT status FROM matchup_weeks ORDER BY sequence").all().map(({ status }) => status),
      ["scheduled", "baseline_ready", "live", "awaiting_data", "final", "final", "correction_required"]
    );
    const matchups = database.prepare(
      "SELECT status, home_team_name, away_team_name FROM matchups ORDER BY id"
    ).all();
    assert.equal(matchups[1].status, "live");
    assert.equal(matchups[4].status, "final");
    assert.equal(matchups.every((row) => row.home_team_name === "Home snapshot"), true);
    assert.equal(matchups.every((row) => row.away_team_name === "Away snapshot"), true);
    assert.equal(
      database.prepare("SELECT metadata_value FROM application_metadata WHERE metadata_key = 'data_model_version'").get().metadata_value,
      "16"
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });
});
