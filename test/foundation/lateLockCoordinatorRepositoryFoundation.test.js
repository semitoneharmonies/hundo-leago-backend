const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLateLockCoordinatorRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLateLockCoordinatorRepository");
const {
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const WEEK_START_MS = 2_000_000_000;
const BASELINE_MS = WEEK_START_MS + 3_600_000;
const LOCK_MS = WEEK_START_MS + 57_600_000;
const WEEK_END_MS = WEEK_START_MS + 604_800_000;
const STAT_SOURCE_ID = uuid(90_001);
const STAT_REFRESH_ID = uuid(90_002);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seedStatistics(database) {
  database.prepare(
    "INSERT INTO stat_sources " +
      "(id, provider, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'late-lock-target-test', 'active', 1, 1, 1)"
  ).run(STAT_SOURCE_ID);
  database.prepare(
    "INSERT INTO stat_refreshes " +
      "(id, stat_source_id, nhl_season_key, source_version, status, " +
      "started_at_ms, completed_at_ms, player_count, version) " +
      "VALUES (?, ?, '20262027', 'target-v1', 'succeeded', 1, 2, 0, 1)"
  ).run(STAT_REFRESH_ID, STAT_SOURCE_ID);
}

function insertTeam(database, ids, base, ownershipVersion) {
  const teamName = `Coordinator Team ${base}`;
  const playerName = `Coordinator Player ${base}`;
  database.prepare(
    "INSERT INTO teams " +
      "(id, league_id, name, name_normalized, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(
    ids.teamId,
    ids.leagueId,
    teamName,
    teamName.toLowerCase()
  );
  database.prepare(
    "INSERT INTO players " +
      "(id, first_name, last_name, full_name, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, 'Coordinator', ?, ?, " +
      "'active', 1, 1, 1)"
  ).run(ids.playerId, `Player ${base}`, playerName);
  database.prepare(
    "INSERT INTO player_ownerships " +
      "(id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, " +
      "acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', 'Active', 'F', 1, " +
      "'late_lock_target_test', 1, 1, ?)"
  ).run(
    ids.ownershipId,
    ids.leagueId,
    ids.seasonId,
    ids.playerId,
    ids.teamId,
    ownershipVersion
  );
}

function insertLock(
  database,
  ids,
  { legal = false, lockType = "normal" } = {}
) {
  if (legal) {
    database.prepare(
      "INSERT INTO stat_snapshots " +
        "(id, stat_source_id, source_refresh_id, league_id, season_id, " +
        "matchup_week_id, intended_use, completeness_status, " +
        "freshness_status, captured_at_ms, committed, created_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'matchup_baseline', 'complete', " +
        "'fresh', ?, 1, ?)"
    ).run(
      ids.snapshotId,
      STAT_SOURCE_ID,
      STAT_REFRESH_ID,
      ids.leagueId,
      ids.seasonId,
      ids.weekId,
      LOCK_MS + 1,
      LOCK_MS + 1
    );
  }
  database.prepare(
    "INSERT INTO matchup_roster_locks " +
      "(id, league_id, season_id, matchup_week_id, team_id, lock_type, " +
      "legal, legality_reason_code, locked_at_ms, baseline_snapshot_id, " +
      "source_freshness_status, created_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    ids.lockId,
    ids.leagueId,
    ids.seasonId,
    ids.weekId,
    ids.teamId,
    lockType,
    legal ? 1 : 0,
    legal ? null : "ACTIVE_FORWARD_COUNT",
    legal ? LOCK_MS + 1 : LOCK_MS,
    legal ? ids.snapshotId : null,
    legal ? "fresh" : "unknown",
    legal ? LOCK_MS + 1 : LOCK_MS,
    legal ? 2 : 1
  );
}

function seedScope(
  database,
  base,
  {
    legal = false,
    lockType = "normal",
    ownershipVersion = 3,
    weekStatus = "live",
  } = {}
) {
  const ids = {
    leagueId: uuid(base + 1),
    seasonId: uuid(base + 2),
    teamId: uuid(base + 3),
    playerId: uuid(base + 4),
    ownershipId: uuid(base + 5),
    weekId: uuid(base + 6),
    lockId: uuid(base + 7),
    snapshotId: uuid(base + 8),
  };
  const leagueName = `Coordinator League ${base}`;
  database.prepare(
    "INSERT INTO leagues " +
      "(id, name, name_normalized, status, timezone, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, 'active', " +
      "'America/Vancouver', 1, 1, 1)"
  ).run(ids.leagueId, leagueName, leagueName.toLowerCase());
  database.prepare(
    "INSERT INTO seasons " +
      "(id, league_id, label, nhl_season_key, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, '2026-27', '20262027', " +
      "'active', 1, 1, 1)"
  ).run(ids.seasonId, ids.leagueId);
  insertTeam(database, ids, base, ownershipVersion);
  database.prepare(
    "INSERT INTO matchup_weeks " +
      "(id, league_id, season_id, week_key, sequence, starts_at_ms, " +
      "baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, " +
      "status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, ?, ?, ?, ?, ?, 1, 1, 2)"
  ).run(
    ids.weekId,
    ids.leagueId,
    ids.seasonId,
    WEEK_START_MS,
    BASELINE_MS,
    LOCK_MS,
    WEEK_END_MS,
    WEEK_END_MS,
    weekStatus
  );
  insertLock(database, ids, { legal, lockType });
  return Object.freeze({
    ...ids,
    ownershipVersion,
  });
}

function seedAdditionalOwnership(
  database,
  scope,
  base,
  ownershipVersion = 4
) {
  const playerId = uuid(base + 1);
  const ownershipId = uuid(base + 2);
  const playerName = `Witness Player ${base}`;
  database.prepare(
    "INSERT INTO players " +
      "(id, first_name, last_name, full_name, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, 'Witness', ?, ?, " +
      "'active', 1, 1, 1)"
  ).run(playerId, `Player ${base}`, playerName);
  database.prepare(
    "INSERT INTO player_ownerships " +
      "(id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, " +
      "acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', 'Active', 'F', 2, " +
      "'late_lock_target_test', 1, 1, ?)"
  ).run(
    ownershipId,
    scope.leagueId,
    scope.seasonId,
    playerId,
    scope.teamId,
    ownershipVersion
  );
  return Object.freeze({ ownershipId, ownershipVersion });
}

function seedAdditionalTeam(
  database,
  scope,
  base,
  {
    legal = false,
    lockType = "normal",
    ownershipVersion = 3,
  } = {}
) {
  const ids = {
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    weekId: scope.weekId,
    teamId: uuid(base + 1),
    playerId: uuid(base + 2),
    ownershipId: uuid(base + 3),
    lockId: uuid(base + 4),
    snapshotId: uuid(base + 5),
  };
  insertTeam(database, ids, base, ownershipVersion);
  insertLock(database, ids, { legal, lockType });
  return Object.freeze({
    ...ids,
    ownershipVersion,
  });
}

function witness(ownership, overrides = {}) {
  return {
    ownershipId: ownership.ownershipId,
    ownershipVersion: ownership.ownershipVersion,
    state: "present",
    ...overrides,
  };
}

function insertDeletionEvidence(
  database,
  scope,
  {
    eventId,
    eventType,
    sourceType,
    before,
    after,
  }
) {
  database.prepare(
    "INSERT INTO ownership_events (" +
      "id, league_id, season_id, player_id, team_id, ownership_id, " +
      "event_type, actor_user_id, source_type, source_id, " +
      "before_metadata_json, after_metadata_json, reason, " +
      "occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, " +
      "'late_lock_deletion_test', ?)"
  ).run(
    eventId,
    scope.leagueId,
    scope.seasonId,
    scope.playerId,
    scope.teamId,
    scope.ownershipId,
    eventType,
    sourceType,
    eventId,
    JSON.stringify(before),
    JSON.stringify(after),
    LOCK_MS
  );
}

function simpleDeletionMetadata(scope) {
  return {
    before: {
      ownershipKind: "Rostered",
      rosterCategory: "Active",
      version: scope.ownershipVersion,
    },
    after: { owned: false },
  };
}

function tradeTenureDeletionMetadata(scope) {
  return {
    before: {
      schemaVersion: 2,
      exists: true,
      ownership: {
        id: scope.ownershipId,
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        playerId: scope.playerId,
        teamId: scope.teamId,
        ownershipKind: "Rostered",
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
        version: scope.ownershipVersion,
      },
    },
    after: {
      schemaVersion: 2,
      exists: false,
      destinationOwnershipId: uuid(999_999),
    },
  };
}

function commissionerDeletionMetadata(scope) {
  return {
    before: {
      ownership: {
        id: scope.ownershipId,
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        playerId: scope.playerId,
        teamId: scope.teamId,
        ownershipKind: "Rostered",
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
        version: scope.ownershipVersion,
      },
      contract: null,
    },
    after: { ownership: null, contract: null },
  };
}

function rolloverDeletionMetadata(scope) {
  const before = {
    exists: true,
    id: scope.ownershipId,
    seasonId: scope.seasonId,
    playerId: scope.playerId,
    teamId: scope.teamId,
    ownershipKind: "Rostered",
    rosterCategory: "Active",
    positionGroup: "F",
    slotNumber: 1,
    version: scope.ownershipVersion,
  };
  return {
    before,
    after: {
      ...before,
      exists: false,
      seasonId: null,
      version: null,
    },
  };
}

function committedInput(
  scope,
  {
    nowMs = LOCK_MS + 1,
    ownershipWitnesses = [witness(scope)],
    team = {},
  } = {}
) {
  return {
    mode: "committed_team",
    team: {
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      teamId: scope.teamId,
      ownershipWitnesses,
      ...team,
    },
    nowMs,
  };
}

function scheduledInput(scope, overrides = {}) {
  return {
    mode: "scheduled_occurrence",
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    weekId: scope.weekId,
    nowMs: LOCK_MS + 1,
    ...overrides,
  };
}

function expectedTarget(scope) {
  return {
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    weekId: scope.weekId,
    teamId: scope.teamId,
    lockId: scope.lockId,
  };
}

function assertRepositoryError(callback, code, messagePattern) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-late-lock-target-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "late-lock-target.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "late-lock-target-foundation",
    now: () => 1,
  });
  assert.equal(
    connection.database
      .prepare(
        "SELECT MAX(migration_id) AS migration_id " +
          "FROM schema_migrations"
      )
      .get().migration_id,
    51
  );
  seedStatistics(connection.database);
  const repository =
    createSqliteLateLockCoordinatorRepository({
      database: connection.database,
    });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return { database: connection.database, repository };
}

describe("FAD-05 late-lock coordinator target repository", () => {
  test("accepts a canonical multi-ownership receipt and performs no write", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 1_000);
    const second = seedAdditionalOwnership(
      database,
      scope,
      1_100
    );
    database.pragma("query_only = ON");
    const beforeChanges = database
      .prepare("SELECT total_changes() AS value")
      .get().value;

    const targets = repository.listEligibleLateLocks(
      committedInput(scope, {
        ownershipWitnesses: [
          witness(scope),
          witness(second),
        ],
      })
    );

    const afterChanges = database
      .prepare("SELECT total_changes() AS value")
      .get().value;
    assert.deepEqual(targets, [expectedTarget(scope)]);
    assert.equal(Object.isFrozen(targets), true);
    assert.equal(Object.isFrozen(targets[0]), true);
    assert.equal(afterChanges, beforeChanges);
  });

  test("accepts an affected empty-roster team without inventing an ownership witness", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 1_500);
    database.prepare(
      "DELETE FROM player_ownerships WHERE id = ?"
    ).run(scope.ownershipId);
    const beforeChanges = database
      .prepare("SELECT total_changes() AS value")
      .get().value;

    const targets = repository.listEligibleLateLocks(
      committedInput(scope, { ownershipWitnesses: [] })
    );

    assert.deepEqual(targets, [expectedTarget(scope)]);
    assert.equal(
      database.prepare("SELECT total_changes() AS value").get().value,
      beforeChanges
    );
  });

  test("fails closed when any present ownership ID, scope, or version is not current", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 2_000);
    const second = seedAdditionalOwnership(
      database,
      scope,
      2_100
    );
    const other = seedScope(database, 3_000);

    for (const invalidWitness of [
      witness(second, {
        ownershipVersion: second.ownershipVersion - 1,
      }),
      witness(second, { ownershipId: uuid(99_999) }),
      witness(other),
    ]) {
      assertRepositoryError(
        () =>
          repository.listEligibleLateLocks(
            committedInput(scope, {
              ownershipWitnesses: [
                witness(scope),
                invalidWitness,
              ],
            })
          ),
        REPOSITORY_ERROR_CODES.versionConflict,
        /no longer current/u
      );
    }
  });

  test("validates every receipt before returning a valid no-target result", (t) => {
    const { database, repository } = createRuntime(t);
    const legal = seedScope(database, 4_000, {
      legal: true,
      lockType: "normal",
    });

    assert.deepEqual(
      repository.listEligibleLateLocks(committedInput(legal)),
      []
    );
    assertRepositoryError(
      () =>
        repository.listEligibleLateLocks(
          committedInput(legal, {
            ownershipWitnesses: [
              witness(legal, {
                ownershipVersion: legal.ownershipVersion + 1,
              }),
            ],
          })
        ),
      REPOSITORY_ERROR_CODES.versionConflict,
      /no longer current/u
    );
  });

  test("requires deleted ownership absence and exact durable pre-delete evidence", (t) => {
    const { database, repository } = createRuntime(t);
    const present = seedScope(database, 5_000);
    const deletedInput = committedInput(present, {
      ownershipWitnesses: [
        witness(present, { state: "deleted" }),
      ],
    });
    assertRepositoryError(
      () =>
        repository.listEligibleLateLocks(deletedInput),
      REPOSITORY_ERROR_CODES.versionConflict,
      /still present/u
    );

    database.prepare(
      "DELETE FROM player_ownerships WHERE id = ?"
    ).run(present.ownershipId);
    assertRepositoryError(
      () => repository.listEligibleLateLocks(deletedInput),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );

    const metadata = simpleDeletionMetadata(present);
    insertDeletionEvidence(database, present, {
      eventId: uuid(95_001),
      eventType: "player_released_by_buyout",
      sourceType: "buyout",
      ...metadata,
    });
    assert.deepEqual(
      repository.listEligibleLateLocks(deletedInput),
      [expectedTarget(present)]
    );
  });

  test("accepts every approved append-only ownership deletion shape", (t) => {
    const { database, repository } = createRuntime(t);
    const cases = [
      {
        base: 5_100,
        eventType: "fantasy_elc_declined",
        sourceType: "prospect_decision",
        metadata: simpleDeletionMetadata,
      },
      {
        base: 5_200,
        eventType: "unsigned_prospect_rights_released",
        sourceType: "prospect_decision",
        metadata: simpleDeletionMetadata,
      },
      {
        base: 5_300,
        eventType: "commissioner_player_removed",
        sourceType: "commissioner_correction",
        metadata: commissionerDeletionMetadata,
      },
      {
        base: 5_400,
        eventType: "player_released_by_contract_expiration",
        sourceType: "season_rollover",
        metadata: rolloverDeletionMetadata,
      },
      {
        base: 5_410,
        eventType: "trade_transfer_out",
        sourceType: "trade",
        metadata: tradeTenureDeletionMetadata,
      },
      {
        base: 5_420,
        eventType: "trade_reversal_out",
        sourceType: "trade_reversal",
        metadata: tradeTenureDeletionMetadata,
      },
      {
        base: 5_430,
        eventType: "commissioner_roster_transfer_out",
        sourceType: "commissioner_correction",
        metadata: tradeTenureDeletionMetadata,
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const evidence = cases[index];
      const scope = seedScope(database, evidence.base);
      insertDeletionEvidence(database, scope, {
        eventId: uuid(95_100 + index),
        eventType: evidence.eventType,
        sourceType: evidence.sourceType,
        ...evidence.metadata(scope),
      });
      database.prepare(
        "DELETE FROM player_ownerships WHERE id = ?"
      ).run(scope.ownershipId);
      assert.deepEqual(
        repository.listEligibleLateLocks(
          committedInput(scope, {
            ownershipWitnesses: [
              witness(scope, { state: "deleted" }),
            ],
          })
        ),
        [expectedTarget(scope)],
        evidence.eventType
      );
    }
  });

  test("rejects malformed trade-tenure deletion evidence", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 5_450);
    const metadata = tradeTenureDeletionMetadata(scope);
    insertDeletionEvidence(database, scope, {
      eventId: uuid(95_150),
      eventType: "trade_transfer_out",
      sourceType: "trade",
      before: metadata.before,
      after: {
        ...metadata.after,
        destinationOwnershipId: scope.ownershipId,
      },
    });
    database.prepare(
      "DELETE FROM player_ownerships WHERE id = ?"
    ).run(scope.ownershipId);
    const input = committedInput(scope, {
      ownershipWitnesses: [witness(scope, { state: "deleted" })],
    });
    assertRepositoryError(
      () => repository.listEligibleLateLocks(input),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );
    database.prepare(
      "UPDATE ownership_events SET before_metadata_json = ?, " +
        "after_metadata_json = ? WHERE id = ?"
    ).run(
      JSON.stringify({
        ...metadata.before,
        ownership: {
          ...metadata.before.ownership,
          version: scope.ownershipVersion + 1,
        },
      }),
      JSON.stringify(metadata.after),
      uuid(95_150)
    );
    assertRepositoryError(
      () => repository.listEligibleLateLocks(input),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );
  });

  test("requires the exact commissioner transfer-out event and source pairing", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 5_460);
    const metadata = tradeTenureDeletionMetadata(scope);
    const eventId = uuid(95_160);
    insertDeletionEvidence(database, scope, {
      eventId,
      eventType: "commissioner_roster_transfer_out",
      sourceType: "trade",
      ...metadata,
    });
    database.prepare(
      "DELETE FROM player_ownerships WHERE id = ?"
    ).run(scope.ownershipId);
    const input = committedInput(scope, {
      ownershipWitnesses: [witness(scope, { state: "deleted" })],
    });
    assertRepositoryError(
      () => repository.listEligibleLateLocks(input),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );

    database.prepare(
      "UPDATE ownership_events SET source_type = ? WHERE id = ?"
    ).run("commissioner_correction", eventId);
    assert.deepEqual(
      repository.listEligibleLateLocks(input),
      [expectedTarget(scope)]
    );
  });

  test("rejects an arbitrary or malformed older ownership event as deletion proof", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 5_500);
    const metadata = simpleDeletionMetadata(scope);
    const eventId = uuid(95_200);
    insertDeletionEvidence(database, scope, {
      eventId,
      eventType: "roster_moved",
      sourceType: "roster_move",
      ...metadata,
    });
    database.prepare(
      "DELETE FROM player_ownerships WHERE id = ?"
    ).run(scope.ownershipId);
    const deletedInput = committedInput(scope, {
      ownershipWitnesses: [
        witness(scope, { state: "deleted" }),
      ],
    });

    assertRepositoryError(
      () => repository.listEligibleLateLocks(deletedInput),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );
    database.prepare(
      "UPDATE ownership_events SET event_type = ?, source_type = ?, " +
        "after_metadata_json = ? WHERE id = ?"
    ).run(
      "player_released_by_buyout",
      "buyout",
      JSON.stringify({ owned: true }),
      eventId
    );
    assertRepositoryError(
      () => repository.listEligibleLateLocks(deletedInput),
      REPOSITORY_ERROR_CODES.versionConflict,
      /lacks exact durable deletion evidence/u
    );
  });

  test("rejects duplicate, unordered, or non-exact witness receipts", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 6_000);
    const second = seedAdditionalOwnership(
      database,
      scope,
      6_100
    );
    const invalidReceipts = [
      [witness(scope), witness(scope)],
      [witness(second), witness(scope)],
      [{ ...witness(scope), unexpected: true }],
    ];
    for (const ownershipWitnesses of invalidReceipts) {
      assertRepositoryError(
        () =>
          repository.listEligibleLateLocks(
            committedInput(scope, { ownershipWitnesses })
          ),
        REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
    assertRepositoryError(
      () =>
        repository.listEligibleLateLocks({
          ...committedInput(scope),
          unexpected: true,
        }),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );
    assertRepositoryError(
      () =>
        repository.listEligibleLateLocks(
          committedInput(scope, {
            team: { unexpected: true },
          })
        ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );
  });

  test("uses exclusive lock and week-end boundaries", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 7_000);

    assert.deepEqual(
      repository.listEligibleLateLocks(
        committedInput(scope, { nowMs: LOCK_MS })
      ),
      []
    );
    assert.deepEqual(
      repository.listEligibleLateLocks(
        committedInput(scope, { nowMs: LOCK_MS + 1 })
      ),
      [expectedTarget(scope)]
    );
    assert.deepEqual(
      repository.listEligibleLateLocks(
        committedInput(scope, {
          nowMs: WEEK_END_MS - 1,
        })
      ),
      [expectedTarget(scope)]
    );
    assert.deepEqual(
      repository.listEligibleLateLocks(
        committedInput(scope, { nowMs: WEEK_END_MS })
      ),
      []
    );
  });

  test("excludes legal, late, non-live, and noncanonical normal-lock rows", (t) => {
    const { database, repository } = createRuntime(t);
    const legal = seedScope(database, 8_000, {
      legal: true,
      lockType: "normal",
    });
    const late = seedScope(database, 9_000, {
      legal: true,
      lockType: "late",
    });
    const nonLive = seedScope(database, 10_000, {
      weekStatus: "baseline_ready",
    });
    const noncanonical = seedScope(database, 11_000);
    database.prepare(
      "UPDATE matchup_roster_locks SET locked_at_ms = ? " +
        "WHERE id = ?"
    ).run(LOCK_MS + 1, noncanonical.lockId);

    for (const scope of [legal, late, nonLive, noncanonical]) {
      assert.deepEqual(
        repository.listEligibleLateLocks(
          committedInput(scope)
        ),
        []
      );
    }
  });

  test("isolates committed-team targets from other teams in the same week", (t) => {
    const { database, repository } = createRuntime(t);
    const first = seedScope(database, 12_000);
    const second = seedAdditionalTeam(
      database,
      first,
      12_100
    );

    assert.deepEqual(
      repository.listEligibleLateLocks(committedInput(first)),
      [expectedTarget(first)]
    );
    assert.deepEqual(
      repository.listEligibleLateLocks(committedInput(second)),
      [expectedTarget(second)]
    );
  });

  test("scheduled mode requires and isolates one exact occurrence scope", (t) => {
    const { database, repository } = createRuntime(t);
    const occurrence = seedScope(database, 13_000);
    const secondTeam = seedAdditionalTeam(
      database,
      occurrence,
      13_100
    );
    seedAdditionalTeam(database, occurrence, 13_200, {
      legal: true,
      lockType: "normal",
    });
    seedAdditionalTeam(database, occurrence, 13_300, {
      legal: true,
      lockType: "late",
    });
    const otherOccurrence = seedScope(database, 14_000);

    const targets = repository.listEligibleLateLocks(
      scheduledInput(occurrence)
    );
    assert.deepEqual(targets, [
      expectedTarget(occurrence),
      expectedTarget(secondTeam),
    ]);
    assert.equal(Object.isFrozen(targets), true);
    assert.equal(Object.isFrozen(targets[0]), true);
    assert.deepEqual(
      repository.listEligibleLateLocks(
        scheduledInput(occurrence, {
          weekId: otherOccurrence.weekId,
        })
      ),
      []
    );
    assert.deepEqual(
      repository.listEligibleLateLocks(
        scheduledInput(otherOccurrence)
      ),
      [expectedTarget(otherOccurrence)]
    );
  });

  test("rejects obsolete global and partially scoped scheduled lookups", (t) => {
    const { database, repository } = createRuntime(t);
    const scope = seedScope(database, 15_000);
    const invalidLookups = [
      {
        mode: "scheduled_occurrence",
        nowMs: LOCK_MS + 1,
      },
      {
        mode: "scheduled_occurrence",
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        nowMs: LOCK_MS + 1,
      },
      {
        teamIds: null,
        committedRoster: null,
        nowMs: LOCK_MS + 1,
      },
    ];
    for (const lookup of invalidLookups) {
      assertRepositoryError(
        () => repository.listEligibleLateLocks(lookup),
        REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
  });
});
