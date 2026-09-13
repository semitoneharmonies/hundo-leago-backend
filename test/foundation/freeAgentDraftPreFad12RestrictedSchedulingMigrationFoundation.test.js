"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  applyMigrations,
  discoverMigrations,
} = require(
  "../../src/infrastructure/database/migrate"
);

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS =
  DEADLINE_AT_MS - 30 * DAY_MS;
const ROLLOVER_ONE_AT_MS =
  DEADLINE_AT_MS + DAY_MS;
const ROLLOVER_TWO_AT_MS =
  DEADLINE_AT_MS + 2 * DAY_MS;
const ROLLOVER_ONE_CUTOFF_AT_MS =
  ROLLOVER_ONE_AT_MS - HOUR_MS;

const OLD_SCHEDULE_GUARD = `                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms >=
                  current_rollover.creation_cutoff_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.rolls_over_at_ms`;
const NEW_SCHEDULE_GUARD = `                AND current_rollover.opens_at_ms <= NEW.updated_at_ms
                AND NEW.updated_at_ms <
                  current_rollover.rolls_over_at_ms`;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function createRuntime(t, prefix) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    root,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrations(runtime, minimumId, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
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
        runtime.migrationsDirectory,
        migration.fileName
      )
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory:
        runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (
      ${columns.join(", ")}
    ) VALUES (
      ${columns
        .map((column) => `@${column}`)
        .join(", ")}
    )
  `).run(values);
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const { sql } of triggers) {
    database.exec(sql);
  }
}

function applicationRows(database) {
  const result = {};
  for (const { name } of database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN (
        'application_metadata',
        'schema_migrations'
      )
    ORDER BY name
  `).all()) {
    result[name] = database.prepare(
      `SELECT * FROM "${name.replaceAll('"', '""')}"`
    ).all();
  }
  return result;
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

function allocationTriggerSql(database) {
  return database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger'
      AND name =
        'free_agent_draft_allocations_forward_update'
  `).get()?.sql;
}

function assertHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", {
      simple: true,
    }),
    "ok"
  );
  assert.deepEqual(
    database.pragma("foreign_key_check"),
    []
  );
}

function fixtureIds(base) {
  return Object.freeze({
    league: uuid(base),
    season: uuid(base + 1),
    week: uuid(base + 2),
    readiness: uuid(base + 3),
    fad: uuid(base + 4),
    player: uuid(base + 5),
    rolloverOne: uuid(base + 6),
    rolloverTwo: uuid(base + 7),
    allocation: uuid(base + 8),
    auction: uuid(base + 9),
  });
}

function seedTransitionFixture(
  database,
  {
    base,
    auctionOpenedAtMs,
    auctionResolvesAtMs,
  }
) {
  const ids = fixtureIds(base);
  const triggers = captureAndDropTriggers(database);
  insert(database, "leagues", {
    id: ids.league,
    name: `FAD 38 League ${base}`,
    name_normalized: `fad 38 league ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: ids.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: `2026${String(base).slice(-4)}`,
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 20 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `2026-W${String(base).slice(-2)}`,
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + HOUR_MS,
    locks_at_ms: WEEK_ONE_AT_MS + 2 * HOUR_MS,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: ids.player,
    first_name: "Scheduled",
    last_name: `Candidate ${base}`,
    full_name: `Scheduled Candidate ${base}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
      id: ids.readiness,
      league_id: ids.league,
      season_id: ids.season,
      readiness_occurrence_key:
        `fad-readiness:${ids.league}:${ids.season}`,
      trigger_kind: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      job_run_id: null,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      blockers_json: "[]",
      matchup_schedule_version_before: null,
      matchup_schedule_version_after: null,
      schedule_recovery_id: null,
      created_fad_id: null,
      reminder_job_run_id: null,
      deadline_job_run_id: null,
      cards_opened_activity_id: null,
      cards_opened_outbox_event_id: null,
      started_at_ms: null,
      next_retry_at_ms: null,
      terminal_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    }
  );
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key:
      `fad-readiness:${ids.league}:${ids.season}`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id:
      ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "allocating",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Migration 38 fixture.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: DEADLINE_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: DEADLINE_AT_MS,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: DEADLINE_AT_MS,
    version: 3,
  });
  for (const rollover of [
    {
      id: ids.rolloverOne,
      sequence: 1,
      predecessor: null,
      opensAtMs: DEADLINE_AT_MS,
      rollsOverAtMs: ROLLOVER_ONE_AT_MS,
    },
    {
      id: ids.rolloverTwo,
      sequence: 2,
      predecessor: ids.rolloverOne,
      opensAtMs: ROLLOVER_ONE_AT_MS,
      rollsOverAtMs: ROLLOVER_TWO_AT_MS,
    },
  ]) {
    insert(database, "free_agent_draft_rollovers", {
      id: rollover.id,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      sequence: rollover.sequence,
      window_kind: "initial",
      predecessor_rollover_id:
        rollover.predecessor,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms: rollover.opensAtMs,
      creation_cutoff_at_ms:
        rollover.rollsOverAtMs - HOUR_MS,
      rolls_over_at_ms: rollover.rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    });
  }
  insert(database, "auctions", {
    id: ids.auction,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status: "open",
    opened_at_ms: auctionOpenedAtMs,
    resolves_at_ms: auctionResolvesAtMs,
    opened_by_user_id: null,
    created_at_ms: auctionOpenedAtMs,
    updated_at_ms: auctionOpenedAtMs,
    version: 1,
  });
  insert(
    database,
    "free_agent_draft_player_allocations",
    {
      id: ids.allocation,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      player_id: ids.player,
      status: "pending",
      decision_code: null,
      winning_snapshot_entry_id: null,
      winning_team_id: null,
      contract_id: null,
      ownership_id: null,
      restricted_auction_id: null,
      fallback_open_auction_id: null,
      restricted_minimum_total_cents: null,
      restricted_minimum_term_years: null,
      restricted_minimum_aav_cents: null,
      accounted_at_ms: null,
      last_error_code: null,
      created_at_ms: DEADLINE_AT_MS,
      updated_at_ms: DEADLINE_AT_MS,
      version: 1,
    }
  );
  restoreTriggers(database, triggers);
  return ids;
}

function transition(
  database,
  ids,
  {
    status,
    updatedAtMs,
  }
) {
  return database.prepare(`
    UPDATE free_agent_draft_player_allocations
    SET status = @status,
        decision_code = 'exact_total_and_term_tie',
        restricted_auction_id = @auctionId,
        restricted_minimum_total_cents = 600,
        restricted_minimum_term_years = 2,
        restricted_minimum_aav_cents = 300,
        updated_at_ms = @updatedAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND id = @allocationId
      AND status = 'pending'
      AND version = 1
  `).run({
    status,
    updatedAtMs,
    auctionId: ids.auction,
    leagueId: ids.league,
    allocationId: ids.allocation,
  });
}

function assertTransitionConstraint(callback) {
  assert.throws(callback, (error) => {
    assert.ok(
      error?.code?.startsWith("SQLITE_CONSTRAINT"),
      error?.stack
    );
    assert.match(
      error.message,
      /allocation may only follow/
    );
    return true;
  });
}

describe(
  "pre-FAD-12 restricted scheduling migration",
  () => {
    test(
      "upgrades exact schema 37 and fresh schema 1 through 38 without changing prior ledger identities, rows, inventory, or any other schema object",
      (t) => {
        const canonical = discoverMigrations({
          migrationsDirectory: CANONICAL_MIGRATIONS,
        });
        const migration38 = canonical.find(
          ({ id }) => id === 38
        );
        assert.equal(
          migration38?.fileName,
          "0038_allow_pre_fad12_restricted_scheduling.sql"
        );

        const upgrade = createRuntime(
          t,
          "hundo-fad-restricted-38-upgrade-"
        );
        copyMigrations(upgrade, 1, 37);
        migrate(upgrade, "fad-restricted-38-before");
        insert(upgrade.database, "users", {
          id: uuid(38_900),
          email_normalized:
            "migration-38@example.test",
          email_display:
            "migration-38@example.test",
          display_name: "Migration 38 Sentinel",
          display_name_normalized:
            "migration 38 sentinel",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        const ledgerBefore = upgrade.database.prepare(`
          SELECT migration_id, file_name, checksum
          FROM schema_migrations
          ORDER BY migration_id
        `).all();
        const rowsBefore = applicationRows(
          upgrade.database
        );
        const schemaBefore = schemaObjects(
          upgrade.database
        );
        const triggerBefore = allocationTriggerSql(
          upgrade.database
        );
        assert.equal(
          triggerBefore.split(OLD_SCHEDULE_GUARD).length,
          2
        );

        copyMigrations(upgrade, 38, 38);
        const upgraded = migrate(
          upgrade,
          "fad-restricted-38-after"
        );
        assert.equal(upgraded.status, "exact");
        assert.equal(
          upgrade.database.pragma("user_version", {
            simple: true,
          }),
          38
        );
        assert.deepEqual(
          upgrade.database.prepare(`
            SELECT metadata_value AS metadataValue,
                   updated_at_ms AS updatedAtMs
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `).get(),
          {
            metadataValue: "38",
            updatedAtMs: 38,
          }
        );
        assert.deepEqual(
          applicationRows(upgrade.database),
          rowsBefore
        );
        const ledgerAfter = upgrade.database.prepare(`
          SELECT migration_id, file_name, checksum
          FROM schema_migrations
          ORDER BY migration_id
        `).all();
        assert.deepEqual(
          ledgerAfter.slice(0, 37),
          ledgerBefore
        );
        assert.deepEqual(ledgerAfter[37], {
          migration_id: 38,
          file_name: migration38.fileName,
          checksum: migration38.checksum,
        });
        const schemaAfter = schemaObjects(
          upgrade.database
        );
        assert.equal(
          schemaAfter.length,
          schemaBefore.length
        );
        const schemaAfterByName = new Map(
          schemaAfter.map((row) => [
            `${row.type}:${row.name}`,
            row,
          ])
        );
        for (const row of schemaBefore) {
          const after = schemaAfterByName.get(
            `${row.type}:${row.name}`
          );
          assert.ok(after, row.name);
          if (
            row.name ===
            "free_agent_draft_allocations_forward_update"
          ) {
            assert.equal(after.type, row.type);
            assert.equal(after.name, row.name);
            assert.equal(after.tableName, row.tableName);
            assert.equal(
              after.sql,
              triggerBefore.replace(
                OLD_SCHEDULE_GUARD,
                NEW_SCHEDULE_GUARD
              )
            );
          } else {
            assert.deepEqual(after, row);
          }
        }
        assertHealthy(upgrade.database);

        const fresh = createRuntime(
          t,
          "hundo-fad-restricted-38-fresh-"
        );
        copyMigrations(fresh, 1, 38);
        const freshResult = migrate(
          fresh,
          "fad-restricted-38-fresh"
        );
        assert.equal(freshResult.status, "exact");
        assert.equal(
          fresh.database.pragma("user_version", {
            simple: true,
          }),
          38
        );
        assert.equal(
          fresh.database.prepare(`
            SELECT COUNT(*) AS count
            FROM schema_migrations
          `).get().count,
          38
        );
        assert.equal(
          allocationTriggerSql(fresh.database),
          allocationTriggerSql(upgrade.database)
        );
        assertHealthy(fresh.database);
      }
    );

    test(
      "permits exact pre-cutoff and final-hour scheduling only against the complete next rollover while retaining immediate compatibility",
      (t) => {
        const runtime = createRuntime(
          t,
          "hundo-fad-restricted-38-window-"
        );
        copyMigrations(runtime, 1, 38);
        migrate(runtime, "fad-restricted-38-window");

        const preCutoff = seedTransitionFixture(
          runtime.database,
          {
            base: 38_000,
            auctionOpenedAtMs: ROLLOVER_ONE_AT_MS,
            auctionResolvesAtMs: ROLLOVER_TWO_AT_MS,
          }
        );
        assert.equal(
          transition(runtime.database, preCutoff, {
            status: "restricted_scheduled",
            updatedAtMs: DEADLINE_AT_MS + 1_000,
          }).changes,
          1
        );

        const finalHour = seedTransitionFixture(
          runtime.database,
          {
            base: 38_100,
            auctionOpenedAtMs: ROLLOVER_ONE_AT_MS,
            auctionResolvesAtMs: ROLLOVER_TWO_AT_MS,
          }
        );
        assert.equal(
          transition(runtime.database, finalHour, {
            status: "restricted_scheduled",
            updatedAtMs: ROLLOVER_ONE_CUTOFF_AT_MS,
          }).changes,
          1
        );

        const immediate = seedTransitionFixture(
          runtime.database,
          {
            base: 38_200,
            auctionOpenedAtMs: DEADLINE_AT_MS + 2_000,
            auctionResolvesAtMs: ROLLOVER_ONE_AT_MS,
          }
        );
        assert.equal(
          transition(runtime.database, immediate, {
            status: "restricted_active",
            updatedAtMs: DEADLINE_AT_MS + 2_000,
          }).changes,
          1
        );
        assertHealthy(runtime.database);
      }
    );

    test(
      "rejects fabricated open times, mismatched resolution windows, and past-due scheduling",
      (t) => {
        const runtime = createRuntime(
          t,
          "hundo-fad-restricted-38-negative-"
        );
        copyMigrations(runtime, 1, 38);
        migrate(runtime, "fad-restricted-38-negative");

        const fabricatedOpen = seedTransitionFixture(
          runtime.database,
          {
            base: 38_300,
            auctionOpenedAtMs: DEADLINE_AT_MS + 1_000,
            auctionResolvesAtMs: ROLLOVER_TWO_AT_MS,
          }
        );
        assertTransitionConstraint(() =>
          transition(runtime.database, fabricatedOpen, {
            status: "restricted_scheduled",
            updatedAtMs: DEADLINE_AT_MS + 1_000,
          })
        );

        const mismatchedResolution =
          seedTransitionFixture(runtime.database, {
            base: 38_400,
            auctionOpenedAtMs: ROLLOVER_ONE_AT_MS,
            auctionResolvesAtMs:
              ROLLOVER_TWO_AT_MS + 1,
          });
        assertTransitionConstraint(() =>
          transition(
            runtime.database,
            mismatchedResolution,
            {
              status: "restricted_scheduled",
              updatedAtMs: DEADLINE_AT_MS + 2_000,
            }
          )
        );

        const pastDue = seedTransitionFixture(
          runtime.database,
          {
            base: 38_500,
            auctionOpenedAtMs: ROLLOVER_ONE_AT_MS,
            auctionResolvesAtMs: ROLLOVER_TWO_AT_MS,
          }
        );
        assertTransitionConstraint(() =>
          transition(runtime.database, pastDue, {
            status: "restricted_scheduled",
            updatedAtMs: ROLLOVER_ONE_AT_MS,
          })
        );
        assertHealthy(runtime.database);
      }
    );
  }
);
