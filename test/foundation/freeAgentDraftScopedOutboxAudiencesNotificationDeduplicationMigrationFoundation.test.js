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
const MIGRATION_FILE_NAME =
  "0027_add_scoped_outbox_audiences_and_notification_deduplication.sql";
const FAD_HISTORY_TABLES = Object.freeze([
  "free_agent_draft_setup_exemptions",
  "free_agent_drafts",
  "free_agent_draft_teams",
  "candidate_cards",
  "candidate_card_revisions",
  "candidate_card_entries",
  "candidate_card_help_requests",
  "candidate_card_snapshots",
  "candidate_card_snapshot_entries",
  "free_agent_draft_player_allocations",
  "free_agent_draft_allocation_events",
  "free_agent_draft_rollovers",
  "free_agent_draft_recoveries",
  "free_agent_draft_auction_participants",
  "free_agent_draft_draws",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrationsThrough(runtime, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumId) continue;
    fs.copyFileSync(
      migration.filePath,
      path.join(runtime.migrationsDirectory, migration.fileName)
    );
  }
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

function seedUser(database, {
  id,
  label,
  status = "active",
}) {
  insert(database, "users", {
    id,
    email_normalized: `${label}@example.test`,
    email_display: `${label}@example.test`,
    display_name: label,
    display_name_normalized: label.toLowerCase(),
    status,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedMembership(database, {
  id,
  leagueId,
  userId,
  status = "active",
}) {
  insert(database, "league_memberships", {
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: "manager",
    status,
    joined_at_ms: 10,
    ended_at_ms: status === "active" ? null : 20,
    created_at_ms: 10,
    updated_at_ms: status === "active" ? 10 : 20,
    version: status === "active" ? 1 : 2,
  });
}

function seedLeague(database, { base }) {
  const ids = {
    user: uuid(base + 1),
    league: uuid(base + 2),
    membership: uuid(base + 3),
    team: uuid(base + 4),
  };

  seedUser(database, {
    id: ids.user,
    label: `manager-${base}`,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `League ${base}`,
    name_normalized: `league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  seedMembership(database, {
    id: ids.membership,
    leagueId: ids.league,
    userId: ids.user,
  });
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `Team ${base}`,
    name_normalized: `team ${base}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });

  return ids;
}

function outboxRecord({
  id,
  leagueId,
  eventType = "league.changed",
  createdAtMs = 100,
}) {
  return {
    id,
    league_id: leagueId,
    event_type: eventType,
    aggregate_type: "league",
    aggregate_id: leagueId ?? "global",
    payload_json: "{}",
    status: "pending",
    attempt_count: 0,
    available_at_ms: createdAtMs,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  };
}

function audienceRecord({
  id,
  leagueId,
  outboxEventId,
  audienceKind,
  teamId = null,
  userId = null,
  createdAtMs = 200,
}) {
  return {
    id,
    league_id: leagueId,
    outbox_event_id: outboxEventId,
    audience_kind: audienceKind,
    team_id: teamId,
    user_id: userId,
    created_at_ms: createdAtMs,
  };
}

function notificationRecord({
  id,
  userId,
  leagueId,
  eventType = "fad_deadline_approaching",
  deduplicationKey,
  createdAtMs = 300,
}) {
  const record = {
    id,
    user_id: userId,
    league_id: leagueId,
    event_type: eventType,
    message_data_json: "{}",
    related_feature: "free_agent_draft",
    related_record_id: null,
    delivery_status: "pending",
    created_at_ms: createdAtMs,
    read_at_ms: null,
    delivered_at_ms: null,
    version: 1,
  };
  if (deduplicationKey !== undefined) {
    record.deduplication_key = deduplicationKey;
  }
  return record;
}

function readOutboxRows(database) {
  return database
    .prepare(`
      SELECT id,
             league_id,
             event_type,
             aggregate_type,
             aggregate_id,
             payload_json,
             status,
             attempt_count,
             available_at_ms,
             published_at_ms,
             last_error_code,
             created_at_ms,
             updated_at_ms,
             version
      FROM outbox_events
      ORDER BY id
    `)
    .all();
}

function readLegacyNotificationRows(database) {
  return database
    .prepare(`
      SELECT id,
             user_id,
             league_id,
             event_type,
             message_data_json,
             related_feature,
             related_record_id,
             delivery_status,
             created_at_ms,
             read_at_ms,
             delivered_at_ms,
             version
      FROM notifications
      ORDER BY id
    `)
    .all();
}

function readFadHistoryCounts(database) {
  return Object.fromEntries(
    FAD_HISTORY_TABLES.map((tableName) => [
      tableName,
      database
        .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
        .get().count,
    ])
  );
}

function assertDatabaseHealthy(database) {
  assert.equal(
    database.pragma("integrity_check", { simple: true }),
    "ok"
  );
  assert.deepEqual(database.pragma("foreign_key_check"), []);
}

describe(
  "FAD-01.5 scoped outbox audiences and notification deduplication migration",
  () => {
    test("installs fresh and deterministically upgrades populated schema 26 without fabricating FAD history", (t) => {
      const fresh = createRuntime(t, "hundo-fad-0027-fresh-");
      copyMigrationsThrough(fresh, 27);
      const freshResult = migrate(fresh, "fad-0027-fresh");

      assert.equal(freshResult.status, "exact");
      assert.equal(freshResult.applied.length, 27);
      assert.equal(
        fresh.database.pragma("user_version", {
          simple: true,
        }),
        27
      );
      assert.equal(
        fresh.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "27"
      );
      assert.deepEqual(
        fresh.database
          .prepare(`
            SELECT migration_id, file_name
            FROM schema_migrations
            ORDER BY migration_id DESC
            LIMIT 1
          `)
          .get(),
        {
          migration_id: 27,
          file_name: MIGRATION_FILE_NAME,
        }
      );
      assert.equal(
        fresh.database
          .pragma("table_list")
          .find(
            ({ name }) => name === "outbox_event_audiences"
          )?.strict,
        1
      );
      assert.deepEqual(
        fresh.database
          .pragma("table_info(outbox_event_audiences)")
          .map(({ name }) => name),
        [
          "id",
          "league_id",
          "outbox_event_id",
          "audience_kind",
          "team_id",
          "user_id",
          "created_at_ms",
        ]
      );
      const deduplicationColumn = fresh.database
        .pragma("table_info(notifications)")
        .find(({ name }) => name === "deduplication_key");
      assert.deepEqual(
        {
          type: deduplicationColumn?.type,
          notnull: deduplicationColumn?.notnull,
          defaultValue: deduplicationColumn?.dflt_value,
        },
        {
          type: "TEXT",
          notnull: 0,
          defaultValue: null,
        }
      );
      assert.equal(
        fresh.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_event_audiences
          `)
          .get().count,
        0
      );
      assert.deepEqual(
        readFadHistoryCounts(fresh.database),
        Object.fromEntries(
          FAD_HISTORY_TABLES.map((tableName) => [
            tableName,
            0,
          ])
        )
      );
      assertDatabaseHealthy(fresh.database);

      const upgrade = createRuntime(
        t,
        "hundo-fad-0027-upgrade-"
      );
      copyMigrationsThrough(upgrade, 26);
      migrate(upgrade, "fad-0027-before");
      const first = seedLeague(upgrade.database, {
        base: 1_000,
      });
      const second = seedLeague(upgrade.database, {
        base: 1_100,
      });
      const firstLeagueEvent = outboxRecord({
        id: uuid(1_200),
        leagueId: first.league,
        createdAtMs: 101,
      });
      const secondLeagueEvent = outboxRecord({
        id: uuid(1_201),
        leagueId: second.league,
        eventType: "auction.changed",
        createdAtMs: 102,
      });
      const globalEvent = outboxRecord({
        id: uuid(1_202),
        leagueId: null,
        eventType: "email.delivery.requested",
        createdAtMs: 103,
      });
      for (const event of [
        firstLeagueEvent,
        secondLeagueEvent,
        globalEvent,
      ]) {
        insert(upgrade.database, "outbox_events", event);
      }
      insert(
        upgrade.database,
        "notifications",
        notificationRecord({
          id: uuid(1_210),
          userId: first.user,
          leagueId: first.league,
          createdAtMs: 110,
        })
      );
      insert(
        upgrade.database,
        "notifications",
        notificationRecord({
          id: uuid(1_211),
          userId: second.user,
          leagueId: null,
          eventType: "account.password_reset",
          createdAtMs: 111,
        })
      );

      const outboxBefore = readOutboxRows(upgrade.database);
      const notificationsBefore =
        readLegacyNotificationRows(upgrade.database);
      const fadBefore = readFadHistoryCounts(upgrade.database);
      const protectedCountsBefore = upgrade.database
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM league_activity)
              AS activity_count,
            (SELECT COUNT(*) FROM job_runs) AS job_count,
            (SELECT COUNT(*) FROM notifications)
              AS notification_count
        `)
        .get();

      copyMigrationsThrough(upgrade, 27);
      const upgradeResult = migrate(
        upgrade,
        "fad-0027-upgrade"
      );

      assert.equal(upgradeResult.status, "exact");
      assert.equal(
        upgrade.database.pragma("user_version", {
          simple: true,
        }),
        27
      );
      assert.equal(
        upgrade.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "27"
      );
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT id,
                   league_id,
                   outbox_event_id,
                   audience_kind,
                   team_id,
                   user_id,
                   created_at_ms
            FROM outbox_event_audiences
            ORDER BY outbox_event_id
          `)
          .all(),
        [
          {
            id: firstLeagueEvent.id,
            league_id: first.league,
            outbox_event_id: firstLeagueEvent.id,
            audience_kind: "league",
            team_id: null,
            user_id: null,
            created_at_ms: firstLeagueEvent.created_at_ms,
          },
          {
            id: secondLeagueEvent.id,
            league_id: second.league,
            outbox_event_id: secondLeagueEvent.id,
            audience_kind: "league",
            team_id: null,
            user_id: null,
            created_at_ms: secondLeagueEvent.created_at_ms,
          },
        ]
      );
      assert.equal(
        upgrade.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_event_audiences
            JOIN outbox_events
              ON outbox_events.id =
                   outbox_event_audiences.outbox_event_id
            WHERE outbox_events.league_id IS NULL
          `)
          .get().count,
        0
      );
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT outbox_events.id,
                   COUNT(outbox_event_audiences.id)
                     AS audience_count
            FROM outbox_events
            LEFT JOIN outbox_event_audiences
              ON outbox_event_audiences.outbox_event_id =
                   outbox_events.id
            WHERE outbox_events.league_id IS NOT NULL
            GROUP BY outbox_events.id
            ORDER BY outbox_events.id
          `)
          .all(),
        [
          {
            id: firstLeagueEvent.id,
            audience_count: 1,
          },
          {
            id: secondLeagueEvent.id,
            audience_count: 1,
          },
        ]
      );
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT id, deduplication_key
            FROM notifications
            ORDER BY id
          `)
          .all(),
        [
          {
            id: uuid(1_210),
            deduplication_key: null,
          },
          {
            id: uuid(1_211),
            deduplication_key: null,
          },
        ]
      );
      assert.deepEqual(
        readOutboxRows(upgrade.database),
        outboxBefore
      );
      assert.deepEqual(
        readLegacyNotificationRows(upgrade.database),
        notificationsBefore
      );
      assert.deepEqual(
        readFadHistoryCounts(upgrade.database),
        fadBefore
      );
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT
              (SELECT COUNT(*) FROM league_activity)
                AS activity_count,
              (SELECT COUNT(*) FROM job_runs) AS job_count,
              (SELECT COUNT(*) FROM notifications)
                AS notification_count
          `)
          .get(),
        protectedCountsBefore
      );
      assertDatabaseHealthy(upgrade.database);
    });

    test("enforces the exact audience matrix, same-league scope, and active user membership on insert and identity update", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0027-audience-scope-"
      );
      copyMigrationsThrough(runtime, 27);
      migrate(runtime, "fad-0027-audience-scope");
      const first = seedLeague(runtime.database, {
        base: 2_000,
      });
      const second = seedLeague(runtime.database, {
        base: 2_100,
      });
      const inactiveUser = uuid(2_201);
      const inactiveMembership = uuid(2_202);
      const noMembershipUser = uuid(2_203);
      seedUser(runtime.database, {
        id: inactiveUser,
        label: "inactive-2201",
      });
      seedMembership(runtime.database, {
        id: inactiveMembership,
        leagueId: first.league,
        userId: inactiveUser,
        status: "ended",
      });
      seedUser(runtime.database, {
        id: noMembershipUser,
        label: "no-membership-2203",
      });

      const firstEvent = outboxRecord({
        id: uuid(2_210),
        leagueId: first.league,
      });
      const secondEvent = outboxRecord({
        id: uuid(2_211),
        leagueId: second.league,
      });
      const globalEvent = outboxRecord({
        id: uuid(2_212),
        leagueId: null,
        eventType: "account.changed",
      });
      for (const event of [
        firstEvent,
        secondEvent,
        globalEvent,
      ]) {
        insert(runtime.database, "outbox_events", event);
      }

      const invalidMatrix = [
        {
          audienceKind: "league",
          teamId: first.team,
        },
        {
          audienceKind: "league",
          userId: first.user,
        },
        {
          audienceKind: "team",
        },
        {
          audienceKind: "team",
          teamId: first.team,
          userId: first.user,
        },
        {
          audienceKind: "user",
        },
        {
          audienceKind: "user",
          teamId: first.team,
          userId: first.user,
        },
        {
          audienceKind: "everyone",
        },
      ];
      invalidMatrix.forEach((overrides, index) => {
        assertConstraint(() => {
          insert(
            runtime.database,
            "outbox_event_audiences",
            audienceRecord({
              id: uuid(2_220 + index),
              leagueId: first.league,
              outboxEventId: firstEvent.id,
              ...overrides,
            })
          );
        });
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audienceRecord({
            id: uuid(2_230),
            leagueId: null,
            outboxEventId: firstEvent.id,
            audienceKind: "league",
          })
        );
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audienceRecord({
            id: uuid(2_231),
            leagueId: first.league,
            outboxEventId: secondEvent.id,
            audienceKind: "team",
            teamId: first.team,
          })
        );
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audienceRecord({
            id: uuid(2_232),
            leagueId: first.league,
            outboxEventId: firstEvent.id,
            audienceKind: "team",
            teamId: second.team,
          })
        );
      });
      for (const [id, userId] of [
        [uuid(2_233), second.user],
        [uuid(2_234), inactiveUser],
        [uuid(2_235), noMembershipUser],
        [uuid(2_236), uuid(9_999)],
      ]) {
        assertConstraint(() => {
          insert(
            runtime.database,
            "outbox_event_audiences",
            audienceRecord({
              id,
              leagueId: first.league,
              outboxEventId: firstEvent.id,
              audienceKind: "user",
              userId,
            })
          );
        });
      }
      assertConstraint(() => {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audienceRecord({
            id: uuid(2_237),
            leagueId: first.league,
            outboxEventId: globalEvent.id,
            audienceKind: "league",
          })
        );
      });
      assertConstraint(() => {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audienceRecord({
            id: uuid(2_238),
            leagueId: first.league,
            outboxEventId: firstEvent.id,
            audienceKind: "league",
            createdAtMs: -1,
          })
        );
      });

      const leagueAudience = audienceRecord({
        id: uuid(2_240),
        leagueId: first.league,
        outboxEventId: firstEvent.id,
        audienceKind: "league",
      });
      const teamAudience = audienceRecord({
        id: uuid(2_241),
        leagueId: first.league,
        outboxEventId: firstEvent.id,
        audienceKind: "team",
        teamId: first.team,
      });
      const userAudience = audienceRecord({
        id: uuid(2_242),
        leagueId: first.league,
        outboxEventId: firstEvent.id,
        audienceKind: "user",
        userId: first.user,
      });
      for (const audience of [
        leagueAudience,
        teamAudience,
        userAudience,
      ]) {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audience
        );
      }

      assertConstraint(() => {
        runtime.database
          .prepare(`
            UPDATE outbox_event_audiences
            SET user_id = ?
            WHERE id = ?
          `)
          .run(second.user, userAudience.id);
      });
      assertConstraint(() => {
        runtime.database
          .prepare(`
            UPDATE outbox_event_audiences
            SET league_id = ?,
                outbox_event_id = ?
            WHERE id = ?
          `)
          .run(
            second.league,
            secondEvent.id,
            userAudience.id
          );
      });
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT league_id,
                   outbox_event_id,
                   audience_kind,
                   team_id,
                   user_id
            FROM outbox_event_audiences
            WHERE id = ?
          `)
          .get(userAudience.id),
        {
          league_id: first.league,
          outbox_event_id: firstEvent.id,
          audience_kind: "user",
          team_id: null,
          user_id: first.user,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            DELETE FROM outbox_event_audiences
            WHERE id = ?
          `)
          .run(teamAudience.id).changes,
        1
      );
      assertDatabaseHealthy(runtime.database);
    });

    test("enforces one partial uniqueness scope for each league, team, and user audience", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0027-audience-unique-"
      );
      copyMigrationsThrough(runtime, 27);
      migrate(runtime, "fad-0027-audience-unique");
      const ids = seedLeague(runtime.database, {
        base: 3_000,
      });
      const otherTeam = uuid(3_010);
      const otherUser = uuid(3_011);
      const otherMembership = uuid(3_012);
      insert(runtime.database, "teams", {
        id: otherTeam,
        league_id: ids.league,
        name: "Other Team 3000",
        name_normalized: "other team 3000",
        status: "active",
        primary_colour: null,
        secondary_colour: null,
        logo_reference: null,
        created_at_ms: 10,
        updated_at_ms: 10,
        version: 1,
      });
      seedUser(runtime.database, {
        id: otherUser,
        label: "other-manager-3000",
      });
      seedMembership(runtime.database, {
        id: otherMembership,
        leagueId: ids.league,
        userId: otherUser,
      });
      const firstEvent = outboxRecord({
        id: uuid(3_020),
        leagueId: ids.league,
      });
      const secondEvent = outboxRecord({
        id: uuid(3_021),
        leagueId: ids.league,
      });
      insert(runtime.database, "outbox_events", firstEvent);
      insert(runtime.database, "outbox_events", secondEvent);

      const baseAudiences = [
        audienceRecord({
          id: uuid(3_030),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "league",
        }),
        audienceRecord({
          id: uuid(3_031),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "team",
          teamId: ids.team,
        }),
        audienceRecord({
          id: uuid(3_032),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "user",
          userId: ids.user,
        }),
      ];
      for (const audience of baseAudiences) {
        insert(
          runtime.database,
          "outbox_event_audiences",
          audience
        );
      }

      for (const duplicate of [
        audienceRecord({
          id: uuid(3_040),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "league",
        }),
        audienceRecord({
          id: uuid(3_041),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "team",
          teamId: ids.team,
        }),
        audienceRecord({
          id: uuid(3_042),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "user",
          userId: ids.user,
        }),
      ]) {
        assertConstraint(() => {
          insert(
            runtime.database,
            "outbox_event_audiences",
            duplicate
          );
        });
      }

      for (const distinctAudience of [
        audienceRecord({
          id: uuid(3_050),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "team",
          teamId: otherTeam,
        }),
        audienceRecord({
          id: uuid(3_051),
          leagueId: ids.league,
          outboxEventId: firstEvent.id,
          audienceKind: "user",
          userId: otherUser,
        }),
        audienceRecord({
          id: uuid(3_052),
          leagueId: ids.league,
          outboxEventId: secondEvent.id,
          audienceKind: "league",
        }),
        audienceRecord({
          id: uuid(3_053),
          leagueId: ids.league,
          outboxEventId: secondEvent.id,
          audienceKind: "team",
          teamId: ids.team,
        }),
        audienceRecord({
          id: uuid(3_054),
          leagueId: ids.league,
          outboxEventId: secondEvent.id,
          audienceKind: "user",
          userId: ids.user,
        }),
      ]) {
        insert(
          runtime.database,
          "outbox_event_audiences",
          distinctAudience
        );
      }

      const uniquePartialIndexes = runtime.database
        .pragma("index_list(outbox_event_audiences)")
        .filter(
          ({ unique, partial }) =>
            unique === 1 && partial === 1
        );
      assert.equal(uniquePartialIndexes.length, 3);
      for (const { name } of uniquePartialIndexes) {
        assert.match(
          runtime.database
            .prepare(`
              SELECT sql
              FROM sqlite_schema
              WHERE type = 'index' AND name = ?
            `)
            .get(name).sql,
          /\bWHERE\b/i
        );
      }
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM outbox_event_audiences
          `)
          .get().count,
        8
      );
      assertDatabaseHealthy(runtime.database);
    });

    test("deduplicates notifications only by user, event type, and bounded non-null key", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0027-notification-dedup-"
      );
      copyMigrationsThrough(runtime, 27);
      migrate(runtime, "fad-0027-notification-dedup");
      const first = seedLeague(runtime.database, {
        base: 4_000,
      });
      const second = seedLeague(runtime.database, {
        base: 4_100,
      });
      const logicalKey =
        "fad:test:deadline-reminder:team:user";
      const original = notificationRecord({
        id: uuid(4_200),
        userId: first.user,
        leagueId: first.league,
        deduplicationKey: logicalKey,
      });
      insert(runtime.database, "notifications", original);

      for (const [id, leagueId] of [
        [uuid(4_201), first.league],
        [uuid(4_202), second.league],
      ]) {
        assertConstraint(() => {
          insert(
            runtime.database,
            "notifications",
            notificationRecord({
              id,
              userId: first.user,
              leagueId,
              deduplicationKey: logicalKey,
            })
          );
        });
      }

      for (const notification of [
        notificationRecord({
          id: uuid(4_210),
          userId: second.user,
          leagueId: second.league,
          deduplicationKey: logicalKey,
        }),
        notificationRecord({
          id: uuid(4_211),
          userId: first.user,
          leagueId: first.league,
          eventType: "fad_cards_opened",
          deduplicationKey: logicalKey,
        }),
        notificationRecord({
          id: uuid(4_212),
          userId: first.user,
          leagueId: first.league,
          deduplicationKey: `${logicalKey}:other`,
        }),
        notificationRecord({
          id: uuid(4_213),
          userId: first.user,
          leagueId: first.league,
          deduplicationKey: null,
        }),
        notificationRecord({
          id: uuid(4_214),
          userId: first.user,
          leagueId: first.league,
          deduplicationKey: null,
        }),
        notificationRecord({
          id: uuid(4_215),
          userId: first.user,
          leagueId: first.league,
          eventType: "fad_key_boundary",
          deduplicationKey: "k".repeat(500),
        }),
      ]) {
        insert(
          runtime.database,
          "notifications",
          notification
        );
      }
      assertConstraint(() => {
        insert(
          runtime.database,
          "notifications",
          notificationRecord({
            id: uuid(4_216),
            userId: first.user,
            leagueId: first.league,
            eventType: "fad_key_too_long",
            deduplicationKey: "k".repeat(501),
          })
        );
      });
      for (const [id, deduplicationKey] of [
        [uuid(4_217), ""],
        [uuid(4_218), "   "],
        [uuid(4_219), " padded-key "],
      ]) {
        assertConstraint(() => {
          insert(
            runtime.database,
            "notifications",
            notificationRecord({
              id,
              userId: first.user,
              leagueId: first.league,
              eventType: "fad_key_not_canonical",
              deduplicationKey,
            })
          );
        });
      }

      const dedupIndexes = runtime.database
        .pragma("index_list(notifications)")
        .filter(
          ({ unique, partial }) =>
            unique === 1 && partial === 1
        )
        .filter(({ name }) => {
          const columns = runtime.database
            .pragma(`index_info(${name})`)
            .map(({ name: columnName }) => columnName);
          return (
            columns.join(",") ===
            "user_id,event_type,deduplication_key"
          );
        });
      assert.equal(dedupIndexes.length, 1);
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM notifications
            WHERE user_id = ?
              AND event_type = ?
              AND deduplication_key IS NULL
          `)
          .get(
            first.user,
            "fad_deadline_approaching"
          ),
        { count: 2 }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM notifications
          `)
          .get().count,
        7
      );
      assertDatabaseHealthy(runtime.database);
    });

    test("rolls back every schema-27 effect when the migration transaction fails", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0027-rollback-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0027-rollback-before");
      const ids = seedLeague(runtime.database, {
        base: 5_000,
      });
      const existingEvent = outboxRecord({
        id: uuid(5_100),
        leagueId: ids.league,
      });
      insert(runtime.database, "outbox_events", existingEvent);
      const outboxBefore = readOutboxRows(runtime.database);
      const fadBefore = readFadHistoryCounts(runtime.database);

      copyMigrationsThrough(runtime, 27);
      fs.appendFileSync(
        path.join(runtime.migrationsDirectory, MIGRATION_FILE_NAME),
        [
          "",
          "INSERT INTO migration_0027_forced_failure",
          "  (missing_column) VALUES (1);",
          "",
        ].join("\n")
      );

      assert.throws(
        () => migrate(runtime, "fad-0027-rollback-failure"),
        (error) => error?.code === "MIGRATION_APPLY_FAILED"
      );
      assert.equal(
        runtime.database.pragma("user_version", {
          simple: true,
        }),
        26
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM schema_migrations
          `)
          .get().count,
        26
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "26"
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
              AND name = 'outbox_event_audiences'
          `)
          .get(),
        undefined
      );
      assert.equal(
        runtime.database
          .pragma("table_info(notifications)")
          .some(({ name }) => name === "deduplication_key"),
        false
      );
      assert.deepEqual(
        readOutboxRows(runtime.database),
        outboxBefore
      );
      assert.deepEqual(
        readFadHistoryCounts(runtime.database),
        fadBefore
      );
      assertDatabaseHealthy(runtime.database);
    });
  }
);
