"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const CANONICAL_MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const PARTICIPANT_TRIGGER =
  "free_agent_draft_auction_participants_forward_update";

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function createRuntime(t, prefix, maximumMigrationId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const migrationsDirectory = path.join(root, "migrations");
  fs.mkdirSync(migrationsDirectory);
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumMigrationId) continue;
    fs.copyFileSync(
      migration.filePath,
      path.join(migrationsDirectory, migration.fileName)
    );
  }
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({ migrationsDirectory }),
    applicationBuildId: `fad-participant-aav-${maximumMigrationId}`,
    now: () => 1_000,
  });
  return {
    database: connection.database,
    migrationsDirectory,
  };
}

function upgradeToSchema42(runtime) {
  const migration = discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  }).find(({ id }) => id === 42);
  assert.ok(migration);
  fs.copyFileSync(
    migration.filePath,
    path.join(runtime.migrationsDirectory, migration.fileName)
  );
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: "fad-participant-aav-upgrade-42",
    now: () => 2_000,
  });
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
  `).run(values);
}

function seedParticipantEvidence(
  database,
  base,
  {
    totalValueCents = 600,
    termYears = 1,
    lowestOfferedAavCents = 233,
  } = {}
) {
  const ids = Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    fad: uuid(base + 3),
    allocation: uuid(base + 4),
    auction: uuid(base + 5),
    team: uuid(base + 6),
    user: uuid(base + 7),
    membership: uuid(base + 8),
    sourceSnapshotEntry: uuid(base + 9),
    candidateRevision: uuid(base + 10),
    bid: uuid(base + 11),
    participant: uuid(base + 12),
  });
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  database.pragma("foreign_keys = OFF");
  database.pragma("ignore_check_constraints = ON");
  try {
    for (const { name } of triggers) {
      database.exec(
        `DROP TRIGGER "${name.replaceAll('"', '""')}"`
      );
    }
    insert(database, "auction_bids", {
      id: ids.bid,
      league_id: ids.league,
      season_id: ids.season,
      auction_id: ids.auction,
      team_id: ids.team,
      submitted_by_user_id: ids.user,
      total_value_cents: totalValueCents,
      term_years: termYears,
      lowest_offered_aav_cents: lowestOfferedAavCents,
      first_submitted_at_ms: 100,
      last_edited_at_ms: 200,
      edit_count: 1,
      status: "active",
      idempotency_request_id: null,
      version: 2,
    });
    insert(database, "free_agent_draft_auction_participants", {
      id: ids.participant,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      allocation_id: ids.allocation,
      auction_id: ids.auction,
      team_id: ids.team,
      status: "active",
      source_snapshot_entry_id: ids.sourceSnapshotEntry,
      originating_candidate_revision_id: ids.candidateRevision,
      minimum_total_value_cents: 600,
      minimum_term_years: 2,
      minimum_aav_cents: 300,
      active_improvement_bid_id: ids.bid,
      manager_edit_limit: 1,
      cooldown_duration_ms: 4_500_000,
      first_improvement_at_ms: 100,
      current_cooldown_anchor_at_ms: 100,
      improvement_committed_at_ms: 100,
      originating_actor_user_id: ids.user,
      originating_actor_membership_id: ids.membership,
      originating_actor_authority: "manager",
      removed_by_user_id: null,
      removed_by_membership_id: null,
      removed_authority: null,
      removal_reason: null,
      removed_at_ms: null,
      created_at_ms: 100,
      updated_at_ms: 100,
      version: 2,
    });
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    for (const { sql } of triggers) database.exec(sql);
    database.pragma("foreign_keys = ON");
  }
  return ids;
}

function participantRow(database, participantId) {
  return database.prepare(`
    SELECT *
    FROM free_agent_draft_auction_participants
    WHERE id = ?
  `).get(participantId);
}

function commitCurrentBidEvidence(
  database,
  participantId,
  { committedAtMs = 200 } = {}
) {
  return database.prepare(`
    UPDATE free_agent_draft_auction_participants
    SET current_cooldown_anchor_at_ms = @committedAtMs,
        improvement_committed_at_ms = @committedAtMs,
        updated_at_ms = @committedAtMs,
        version = version + 1
    WHERE id = @participantId
  `).run({ participantId, committedAtMs });
}

function assertParticipantFence(error) {
  assert.match(
    error.message,
    /restricted participant requires a current strict improvement/i
  );
  return true;
}

test("schema 42 upgrades schema 41 to accept an equal-total offer by its higher current rounded AAV", (t) => {
  const runtime = createRuntime(t, "fad-participant-aav-upgrade-", 41);
  const ids = seedParticipantEvidence(runtime.database, 610_000);

  assert.equal(
    runtime.database.pragma("user_version", { simple: true }),
    41
  );
  assert.throws(
    () => commitCurrentBidEvidence(runtime.database, ids.participant),
    assertParticipantFence
  );

  const migration = upgradeToSchema42(runtime);
  assert.equal(migration.status, "exact");
  assert.equal(
    runtime.database.pragma("user_version", { simple: true }),
    42
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT metadata_value
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `).pluck().get(),
    "42"
  );
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT migration_id, file_name
      FROM schema_migrations
      WHERE migration_id = 42
    `).get(),
    {
      migration_id: 42,
      file_name:
        "0042_use_current_aav_for_restricted_participant_floor.sql",
    }
  );

  assert.equal(
    commitCurrentBidEvidence(runtime.database, ids.participant)
      .changes,
    1
  );
  assert.deepEqual(
    {
      currentCooldownAnchorAtMs:
        participantRow(runtime.database, ids.participant)
          .current_cooldown_anchor_at_ms,
      improvementCommittedAtMs:
        participantRow(runtime.database, ids.participant)
          .improvement_committed_at_ms,
      version:
        participantRow(runtime.database, ids.participant).version,
    },
    {
      currentCooldownAnchorAtMs: 200,
      improvementCommittedAtMs: 200,
      version: 3,
    }
  );
});

test("fresh schema 42 uses current AAV while retaining malformed and lower-floor rollback fences", (t) => {
  const { database } = createRuntime(
    t,
    "fad-participant-aav-fresh-",
    42
  );
  const positive = seedParticipantEvidence(database, 620_000);
  assert.equal(
    commitCurrentBidEvidence(database, positive.participant).changes,
    1
  );
  assert.equal(
    participantRow(database, positive.participant).version,
    3
  );

  const lowerCurrentAav = seedParticipantEvidence(
    database,
    630_000,
    {
      totalValueCents: 600,
      termYears: 3,
      lowestOfferedAavCents: 150,
    }
  );
  const malformedAnchor = seedParticipantEvidence(
    database,
    640_000
  );
  database.exec(
    "CREATE TEMP TABLE participant_floor_rollback_probe (value INTEGER NOT NULL)"
  );

  for (const [ids, committedAtMs] of [
    [lowerCurrentAav, 200],
    [malformedAnchor, 201],
  ]) {
    const before = participantRow(database, ids.participant);
    const attempt = database.transaction(() => {
      database.prepare(`
        INSERT INTO participant_floor_rollback_probe (value)
        VALUES (1)
      `).run();
      commitCurrentBidEvidence(database, ids.participant, {
        committedAtMs,
      });
    });
    assert.throws(attempt, assertParticipantFence);
    assert.deepEqual(
      participantRow(database, ids.participant),
      before
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) FROM participant_floor_rollback_probe
      `).pluck().get(),
      0
    );
  }

  const triggerSql = database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?
  `).pluck().get(PARTICIPANT_TRIGGER);
  assert.match(
    triggerSql,
    /auction_bids\.total_value_cents\s*\/\s*auction_bids\.term_years/
  );
  assert.doesNotMatch(
    triggerSql,
    /auction_bids\.lowest_offered_aav_cents\s*>/
  );
});
