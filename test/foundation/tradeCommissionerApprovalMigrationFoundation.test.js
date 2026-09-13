"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function migrations(maximumId) {
  return discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= maximumId);
}

function apply(database, maximumId, buildId) {
  return applyMigrations({
    database,
    migrations: migrations(maximumId),
    applicationBuildId: buildId,
    now: () => maximumId,
  });
}

function databaseAt52() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  apply(database, 52, "trade-approval-schema52");
  return database;
}

function seedOpenTrade(database) {
  const ids = Object.freeze({
    user: uuid(1),
    league: uuid(2),
    season: uuid(3),
    membership: uuid(4),
    proposingTeam: uuid(5),
    receivingTeam: uuid(6),
    trade: uuid(7),
  });
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms,
      version
    ) VALUES (?, 'manager@example.test', 'manager@example.test',
      'Manager', 'manager', 'active', 1, 1, 1)
  `).run(ids.user);
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, 'League', 'league', 'setup', 'America/Vancouver',
      NULL, NULL, 1, 1, 1)
  `).run(ids.league);
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      regular_season_starts_at_ms, regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms, fantasy_playoffs_end_at_ms,
      created_at_ms, updated_at_ms, version,
      free_agent_draft_completed_at_ms
    ) VALUES (?, ?, '2026-27', '20262027', 'planned',
      NULL, NULL, NULL, NULL, 1, 1, 1, NULL)
  `).run(ids.season, ids.league);
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'manager', 'active', 1, NULL, 1, 1, 1)
  `).run(ids.membership, ids.league, ids.user);
  for (const [teamId, name] of [
    [ids.proposingTeam, "Alpha"],
    [ids.receivingTeam, "Bravo"],
  ]) {
    database.prepare(`
      INSERT INTO teams (
        id, league_id, name, name_normalized, status,
        primary_colour, secondary_colour, logo_reference,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, 1, 1, 1)
    `).run(teamId, ids.league, name, name.toLowerCase());
  }
  database.prepare(`
    INSERT INTO trades (
      id, league_id, season_id, proposing_team_id, receiving_team_id,
      proposing_user_id, creating_membership_id, creating_authority,
      status, created_at_ms, expires_at_ms, effective_deadline_at_ms,
      responded_at_ms, completed_at_ms, commissioner_completion_reference,
      proposal_model_version, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manager', 'proposed',
      1, 1000, 900, NULL, NULL, NULL, 2, 1, 1)
  `).run(
    ids.trade,
    ids.league,
    ids.season,
    ids.proposingTeam,
    ids.receivingTeam,
    ids.user,
    ids.membership
  );
  return ids;
}

test("schema 53 adds durable Future Considerations acceptance evidence without changing an open trade", () => {
  const database = databaseAt52();
  try {
    const ids = seedOpenTrade(database);
    const before = database.prepare(
      "SELECT * FROM trades WHERE id = ?"
    ).get(ids.trade);

    const result = apply(database, 53, "trade-approval-schema53");

    assert.equal(result.userVersion, 53);
    assert.equal(database.pragma("user_version", { simple: true }), 53);
    assert.equal(
      database.prepare(`
        SELECT metadata_value FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get().metadata_value,
      "53"
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM trades WHERE id = ?").get(ids.trade),
      before
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM trade_future_consideration_acceptances
      `).get().count,
      0
    );

    const insert = database.prepare(`
      INSERT INTO trade_future_consideration_acceptances (
        id, league_id, season_id, trade_id, accepted_by_user_id,
        accepted_by_membership_id, accepted_authority, accepted_at_ms,
        trade_version_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 10, 2)
    `);
    insert.run(
      uuid(8),
      ids.league,
      ids.season,
      ids.trade,
      ids.user,
      ids.membership,
      "manager"
    );
    assert.throws(
      () =>
        insert.run(
          uuid(9),
          ids.league,
          ids.season,
          ids.trade,
          ids.user,
          ids.membership,
          "commissioner"
        ),
      (error) => error?.code?.startsWith("SQLITE_CONSTRAINT")
    );
    assert.throws(
      () =>
        database.prepare(`
          UPDATE trade_future_consideration_acceptances
          SET accepted_authority = 'manager_claimed_commissioner'
          WHERE trade_id = ?
        `).run(ids.trade),
      (error) => error?.code?.startsWith("SQLITE_CONSTRAINT")
    );
    assert.equal(
      database.pragma("integrity_check", { simple: true }),
      "ok"
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
