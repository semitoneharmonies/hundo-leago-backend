const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONFIRMATION,
  FIXTURE_RESET_PROTECTED_TRIGGER_NAMES,
  createStagingFixtureResetService,
  resetFixtureRows,
} = require(
  "../../src/application/services/operations/createStagingFixtureResetService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  StagingMaintenanceExclusionError,
  createStagingMaintenanceExclusionGuard,
} = require(
  "../../src/application/services/operations/createStagingMaintenanceExclusionGuard"
);
const {
  createReleaseQaFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function temporaryRoot() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-staging-reset-test-")
  );
}

function platformAdministrator() {
  return {
    actorUserId: fixtureId("account:platformAdmin"),
    authority: "platform_administrator",
  };
}

function fakeBackup(outputDirectory = "test-backup") {
  return {
    backupId: crypto.randomUUID(),
    outputDirectory,
    plaintextSha256: "a".repeat(64),
  };
}

function resetRequest(key, reason = "Restore deterministic test state.") {
  return {
    input: {
      confirmation: CONFIRMATION,
      reason,
    },
    idempotencyKey: key,
    authenticated: { valid: true },
  };
}

function allowFixtureResetExclusion(onAssert = () => undefined) {
  return Object.freeze({
    assertExclusion(exclusionName) {
      assert.equal(exclusionName, "release_qa_fixture_reset");
      return onAssert();
    },
  });
}

function maintenanceExclusionFailure() {
  return new StagingMaintenanceExclusionError(
    "STAGING_MAINTENANCE_EXCLUSION_MATCHUP_ACTIVE",
    "Injected maintenance-exclusion race."
  );
}

function resetMutationProjection(database) {
  return {
    totalChanges: database
      .prepare("SELECT total_changes() AS count")
      .get().count,
    team: database
      .prepare("SELECT name, version FROM teams WHERE id = ?")
      .get(fixtureId("team:leagueA:1")),
    backupCatalogCount: database
      .prepare("SELECT COUNT(*) AS count FROM backup_catalog")
      .get().count,
    resetEventCount: database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM operational_events
        WHERE event_type = 'staging_fixture_reset'
      `)
      .get().count,
    resetIdempotencyCount: database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM idempotency_requests
        WHERE operation = 'staging_fixture_reset'
      `)
      .get().count,
  };
}

function insertExternalLeague(database) {
  const leagueId = crypto.randomUUID();
  database
    .prepare(`
      INSERT INTO leagues (
        id, name, name_normalized, status, timezone,
        commissioner_membership_id, current_season_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        ?, ?, ?, 'setup', 'UTC', NULL, NULL, ?, ?, 1
      )
    `)
    .run(
      leagueId,
      `External League ${leagueId}`,
      `external league ${leagueId}`,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
  return leagueId;
}

function resetService(target, overrides = {}) {
  const options = {
    database: target.database,
    databasePath: target.databasePath,
    persistentRoot: target.root,
    appEnv: "staging",
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    leagueWriteMode: "closed",
    scheduledJobsEnabled: false,
    platformAuthorization: {
      requireAdministrator() {
        return platformAdministrator();
      },
    },
    clock: { nowMs: () => FIXTURE_NOW_MS + 20_000 },
    createBackup: async ({ outputDirectory }) =>
      fakeBackup(outputDirectory),
    ...overrides,
  };
  if (!Object.hasOwn(options, "maintenanceExclusionGuard")) {
    options.maintenanceExclusionGuard =
      createStagingMaintenanceExclusionGuard({
        database: target.database,
        appEnv: options.appEnv,
        environmentId: options.environmentId,
        databaseId: options.databaseId,
        leagueWriteMode: options.leagueWriteMode,
        scheduledJobsEnabled: options.scheduledJobsEnabled,
      });
  }
  return createStagingFixtureResetService(options);
}

async function runtime(t) {
  const root = temporaryRoot();
  const databasePath = path.join(root, "m7-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: "hundo",
    temporaryRoot: root,
  });
  const connection = openDatabase({
    databasePath,
    environment: "staging",
    persistentRoot: root,
    requirePersistentRoot: true,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    database: connection.database,
    databasePath,
    root,
  };
}

test("M7-10 resets only the exact staging fixture after a verified backup and preserves the imported catalog", async (t) => {
  const target = await runtime(t);
  assert.deepEqual(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES,
    [...FIXTURE_RESET_PROTECTED_TRIGGER_NAMES].sort(),
    "the approved protected-trigger catalogue must remain deterministic"
  );
  assert.deepEqual(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES,
    target.database
      .prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND (
            upper(sql) LIKE '%BEFORE DELETE ON%'
            OR name IN (?, ?)
          )
        ORDER BY name ASC
      `)
      .all(
        "stat_refresh_player_game_coverage_immutable_update",
        "stat_refresh_player_game_coverage_stage_before_set"
      )
      .map(({ name }) => name),
    "the reset must suspend every installed delete guard and coverage write guard exactly"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "auction_administration_command_results_immutable_delete"
    ),
    "the reset must suspend immutable auction-administration replay evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "candidate_card_revision_entry_changes_immutable_delete"
    ),
    "the reset must suspend immutable whole-card revision evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "idempotency_requests_auction_administration_result_delete"
    ),
    "the reset must suspend the auction-administration idempotency guard"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "idempotency_requests_fad_nomination_queue_delete"
    ),
    "the reset must suspend immutable queued-nomination acceptance evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "idempotency_requests_fad_open_rapid_start_delete"
    ),
    "the reset must suspend immutable immediate-start replay evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "fad_auction_events_immutable_delete"
    ),
    "the reset must suspend immutable FAD auction events"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "fad_auction_resolutions_immutable_delete"
    ),
    "the reset must suspend immutable FAD auction resolutions"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "matchup_result_versions_immutable_delete"
    ),
    "the reset must suspend the global append-only result-version guard"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "matchup_operations_schedule_generate_immutable_delete"
    ),
    "the reset must suspend the immutable schedule-root guard"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "idempotency_requests_matchup_schedule_result_delete"
    ),
    "the reset must suspend immutable matchup-schedule replay evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "matchup_operations_result_correct_immutable_delete"
    ),
    "the reset must suspend immutable result-correction evidence"
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "season_rollovers_immutable_delete"
    )
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "free_agent_draft_setup_exemptions_immutable_delete"
    )
  );
  for (const triggerName of [
    "free_agent_draft_readiness_attempts_immutable_delete",
    "free_agent_draft_readiness_corrective_requeues_immutable_delete",
    "free_agent_draft_readiness_retry_receipts_immutable_delete",
  ]) {
    assert.ok(
      FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(triggerName),
      `the reset must suspend and restore ${triggerName}`
    );
  }
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "standings_snapshot_finalizations_immutable_delete"
    )
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "player_game_stat_observations_immutable_delete"
    )
  );
  assert.ok(
    FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(
      "stat_refresh_player_game_sets_immutable_delete"
    )
  );
  for (const triggerName of [
    "stat_refresh_player_game_coverage_immutable_delete",
    "stat_refresh_player_game_coverage_immutable_update",
    "stat_refresh_player_game_coverage_stage_before_set",
  ]) {
    assert.ok(
      FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.includes(triggerName),
      `the reset must suspend and restore ${triggerName}`
    );
  }
  const providerPlayerId = crypto.randomUUID();
  const providerExternalId = crypto.randomUUID();
  target.database
    .prepare(`
      INSERT INTO players (
        id, first_name, last_name, full_name, birth_date, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, 'Provider', 'Player', 'Provider Player', NULL, 'active', ?, ?, 1)
    `)
    .run(providerPlayerId, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
  target.database
    .prepare(`
      INSERT INTO player_external_ids (
        id, player_id, provider, external_value, created_at_ms
      ) VALUES (?, ?, 'sportsdataio-discovery-lab', '123456', ?)
    `)
    .run(providerExternalId, providerPlayerId, FIXTURE_NOW_MS);
  const providerCatalogPlayerCount = target.database
    .prepare(`
      SELECT COUNT(*) AS count
      FROM player_external_ids
      WHERE provider = 'sportsdataio-discovery-lab'
    `)
    .get().count;
  const fixtureStatSourceId = fixtureId("stat-source");
  const fixtureRefresh = target.database
    .prepare(`
      SELECT
        id,
        nhl_season_key,
        source_version,
        completed_at_ms
      FROM stat_refreshes
      WHERE stat_source_id = ?
      ORDER BY id ASC
      LIMIT 1
    `)
    .get(fixtureStatSourceId);
  const scoringRefresh = {
    id: crypto.randomUUID(),
    nhl_season_key: fixtureRefresh.nhl_season_key,
    source_version: "reset-test-player-games",
    completed_at_ms: fixtureRefresh.completed_at_ms + 1,
  };
  target.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status,
      started_at_ms, completed_at_ms, player_count, error_code,
      metadata_json, version
    ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?, 1, NULL, NULL, 1)
  `).run(
    scoringRefresh.id,
    fixtureStatSourceId,
    scoringRefresh.nhl_season_key,
    scoringRefresh.source_version,
    scoringRefresh.completed_at_ms - 1,
    scoringRefresh.completed_at_ms
  );
  const scoringPlayerId = target.database
    .prepare(`
      SELECT player_id
      FROM player_stat_totals
      WHERE refresh_id = ?
      ORDER BY player_id ASC
      LIMIT 1
    `)
    .get(fixtureRefresh.id).player_id;
  const playerGameCoverageId = crypto.randomUUID();
  const playerGameObservationId = crypto.randomUUID();
  const playerGameSetId = crypto.randomUUID();
  target.database.transaction(() => {
    target.database
      .prepare(`
        INSERT INTO stat_refresh_player_game_coverage_entries (
          id,
          stat_source_id,
          refresh_id,
          observation_set_id,
          nhl_season_key,
          player_id,
          provider_player_id,
          provider_team_id,
          disposition,
          nhl_game_id,
          nhl_game_scheduled_starts_at_ms,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          'reset-test-player',
          'reset-test-team',
          'expected_game',
          'reset-test-game',
          ?,
          ?,
          1
        )
      `)
      .run(
        playerGameCoverageId,
        fixtureStatSourceId,
        scoringRefresh.id,
        playerGameSetId,
        scoringRefresh.nhl_season_key,
        scoringPlayerId,
        scoringRefresh.completed_at_ms,
        scoringRefresh.completed_at_ms
      );
    target.database
      .prepare(`
        INSERT INTO player_game_stat_observations (
          id,
          stat_source_id,
          refresh_id,
          observation_set_id,
          nhl_season_key,
          player_id,
          nhl_game_id,
          nhl_game_scheduled_starts_at_ms,
          observed_game_state,
          goals,
          assists,
          nhl_points,
          fantasy_points_hundredths,
          source_updated_at_ms,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          'reset-test-game',
          ?,
          'scheduled',
          0,
          0,
          0,
          0,
          ?,
          ?,
          1
        )
      `)
      .run(
        playerGameObservationId,
        fixtureStatSourceId,
        scoringRefresh.id,
        playerGameSetId,
        scoringRefresh.nhl_season_key,
        scoringPlayerId,
        scoringRefresh.completed_at_ms,
        scoringRefresh.completed_at_ms,
        scoringRefresh.completed_at_ms
      );
    target.database
      .prepare(`
        INSERT INTO stat_refresh_player_game_sets (
          id,
          stat_source_id,
          refresh_id,
          nhl_season_key,
          provider,
          source_version,
          captured_at_ms,
          required_player_count,
          coverage_entry_count,
          expected_player_game_count,
          coverage_schema_version,
          coverage_sha256,
          observation_count,
          evidence_schema_version,
          evidence_sha256,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          'release_qa_fixture',
          ?,
          ?,
          1,
          1,
          1,
          1,
          ?,
          1,
          1,
          ?,
          ?,
          1
        )
      `)
      .run(
        playerGameSetId,
        fixtureStatSourceId,
        scoringRefresh.id,
        scoringRefresh.nhl_season_key,
        scoringRefresh.source_version,
        scoringRefresh.completed_at_ms,
        "b".repeat(64),
        "c".repeat(64),
        scoringRefresh.completed_at_ms
      );
  })();
  target.database
    .prepare(`
      UPDATE teams
      SET name = 'Changed Team', name_normalized = 'changed team',
        updated_at_ms = ?, version = version + 1
      WHERE id = ?
    `)
    .run(
      FIXTURE_NOW_MS + 1,
      fixtureId("team:leagueA:1")
    );
  const protectedTriggerSqlBefore = target.database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name IN (
          ${FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.map(() => "?").join(", ")}
        )
      ORDER BY name ASC
    `)
    .all(...FIXTURE_RESET_PROTECTED_TRIGGER_NAMES);

  let authorizationCalls = 0;
  const service = createStagingFixtureResetService({
    database: target.database,
    databasePath: target.databasePath,
    persistentRoot: target.root,
    appEnv: "staging",
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    leagueWriteMode: "closed",
    scheduledJobsEnabled: false,
    maintenanceExclusionGuard:
      createStagingMaintenanceExclusionGuard({
        database: target.database,
        appEnv: "staging",
        environmentId: FIXTURE_ENVIRONMENT_ID,
        databaseId: FIXTURE_DATABASE_ID,
        leagueWriteMode: "closed",
        scheduledJobsEnabled: false,
      }),
    platformAuthorization: {
      requireAdministrator(authenticated) {
        authorizationCalls += 1;
        assert.equal(authenticated.valid, true);
        return {
          actorUserId: fixtureId("account:platformAdmin"),
          authority: "platform_administrator",
        };
      },
    },
    clock: { nowMs: () => FIXTURE_NOW_MS + 10_000 },
  });
  const request = {
    input: {
      confirmation: CONFIRMATION,
      reason: "Restore deterministic manual-testing state.",
    },
    idempotencyKey: "staging-reset-one",
    authenticated: { valid: true },
  };
  const result = await service.reset(request);
  assert.equal(result.code, "STAGING_FIXTURE_RESET_COMPLETED");
  assert.equal(
    result.providerCatalogPlayerCount,
    providerCatalogPlayerCount
  );
  assert.equal(result.sessionInvalidated, true);
  assert.equal(
    target.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM stat_refresh_player_game_coverage_entries
        WHERE id = ?
      `)
      .get(playerGameCoverageId).count,
    0
  );
  assert.equal(
    target.database
      .prepare("SELECT name FROM teams WHERE id = ?")
      .get(fixtureId("team:leagueA:1")).name,
    "Alpha Owls"
  );
  assert.equal(
    target.database
      .prepare("SELECT COUNT(*) AS count FROM players WHERE id = ?")
      .get(providerPlayerId).count,
    1
  );
  assert.equal(
    target.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM stat_refresh_player_game_sets
        WHERE id = ?
      `)
      .get(playerGameSetId).count,
    0
  );
  assert.equal(
    target.database.pragma("foreign_key_check").length,
    0
  );
  assert.deepEqual(
    target.database
      .prepare(`
        SELECT name, sql
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND name IN (
            ${FIXTURE_RESET_PROTECTED_TRIGGER_NAMES.map(() => "?").join(", ")}
          )
        ORDER BY name ASC
      `)
      .all(...FIXTURE_RESET_PROTECTED_TRIGGER_NAMES),
    protectedTriggerSqlBefore
  );
  assert.equal(
    target.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM auction_contexts
        WHERE source_kind = 'ordinary_weekly'
      `)
      .get().count,
    2
  );
  assert.equal(
    target.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM backup_catalog
        WHERE status = 'verified'
      `)
      .get().count,
    1
  );
  assert.equal(
    fs.readdirSync(path.join(target.root, "backups")).length,
    1
  );

  const replay = await service.reset(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.backupId, result.backupId);
  assert.equal(
    fs.readdirSync(path.join(target.root, "backups")).length,
    1
  );
  assert.equal(authorizationCalls, 3);
});

test("M7-10 does not construct a reset capability for production or a non-fixture identity", () => {
  assert.throws(
    () =>
      createStagingFixtureResetService({
        appEnv: "production",
        environmentId: "production:league",
        databaseId: "production-league",
      }),
    /exact staging fixture identity/
  );
});

test("M7-10 fixture reset requires the closed maintenance window and rejects active matchups before backup", async (t) => {
  const target = await runtime(t);
  assert.throws(
    () =>
      resetService(target, {
        maintenanceExclusionGuard: null,
      }),
    /requires a staging maintenance-exclusion guard/
  );
  for (const override of [
    { leagueWriteMode: "open" },
    { scheduledJobsEnabled: true },
  ]) {
    assert.throws(
      () => resetService(target, override),
      (error) =>
        error instanceof StagingMaintenanceExclusionError &&
        error.code ===
          "STAGING_MAINTENANCE_EXCLUSION_CONFIG_INVALID"
    );
  }

  for (const [tableName, status] of [
    ["matchup_weeks", "live"],
    ["matchup_weeks", "correction_required"],
    ["matchups", "live"],
    ["matchups", "correction_required"],
  ]) {
    const row = target.database
      .prepare(`SELECT id, status FROM ${tableName} ORDER BY id LIMIT 1`)
      .get();
    target.database
      .prepare(`UPDATE ${tableName} SET status = ? WHERE id = ?`)
      .run(status, row.id);
    const before = target.database.serialize();
    let backupCalls = 0;
    let mkdirCalls = 0;
    const service = resetService(target, {
      fsModule: {
        mkdirSync() {
          mkdirCalls += 1;
        },
      },
      async createBackup() {
        backupCalls += 1;
        return fakeBackup();
      },
    });

    await assert.rejects(
      service.reset(
        resetRequest(`maintenance-${tableName}-${status}`)
      ),
      (error) =>
        error instanceof StagingMaintenanceExclusionError &&
        error.code ===
          "STAGING_MAINTENANCE_EXCLUSION_MATCHUP_ACTIVE"
    );
    assert.equal(mkdirCalls, 0);
    assert.equal(backupCalls, 0);
    assert.equal(before.equals(target.database.serialize()), true);

    target.database
      .prepare(`UPDATE ${tableName} SET status = ? WHERE id = ?`)
      .run(row.status, row.id);
  }
});

test("M7-10 fixture reset reasserts maintenance exclusion across every mutation race seam", async (t) => {
  await t.test("before backup", async (child) => {
    const target = await runtime(child);
    const before = resetMutationProjection(target.database);
    const failure = maintenanceExclusionFailure();
    let guardCalls = 0;
    let backupCalls = 0;
    const service = resetService(target, {
      maintenanceExclusionGuard: allowFixtureResetExclusion(() => {
        guardCalls += 1;
        throw failure;
      }),
      async createBackup() {
        backupCalls += 1;
        return fakeBackup();
      },
    });

    await assert.rejects(
      service.reset(resetRequest("guard-before-backup")),
      (error) => error === failure
    );
    assert.equal(guardCalls, 1);
    assert.equal(backupCalls, 0);
    assert.deepEqual(resetMutationProjection(target.database), before);
  });

  await t.test("after awaited backup", async (child) => {
    const target = await runtime(child);
    const before = resetMutationProjection(target.database);
    const failure = maintenanceExclusionFailure();
    let guardCalls = 0;
    let backupArtifactPath;
    const service = resetService(target, {
      maintenanceExclusionGuard: allowFixtureResetExclusion(() => {
        guardCalls += 1;
        if (guardCalls === 2) throw failure;
      }),
      async createBackup({ outputDirectory }) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        backupArtifactPath = path.join(outputDirectory, "backup.marker");
        fs.writeFileSync(backupArtifactPath, "verified backup artifact");
        return fakeBackup(outputDirectory);
      },
    });

    await assert.rejects(
      service.reset(resetRequest("guard-after-backup")),
      (error) => error === failure
    );
    assert.equal(guardCalls, 2);
    assert.equal(fs.existsSync(backupArtifactPath), true);
    assert.deepEqual(resetMutationProjection(target.database), before);
  });

  await t.test("inside immediate transaction", async (child) => {
    const target = await runtime(child);
    const before = resetMutationProjection(target.database);
    const failure = maintenanceExclusionFailure();
    let guardCalls = 0;
    const service = resetService(target, {
      maintenanceExclusionGuard: allowFixtureResetExclusion(() => {
        guardCalls += 1;
        if (guardCalls === 3) {
          assert.equal(target.database.inTransaction, true);
          throw failure;
        }
      }),
    });

    await assert.rejects(
      service.reset(resetRequest("guard-inside-transaction")),
      (error) => error === failure
    );
    assert.equal(guardCalls, 3);
    assert.equal(target.database.inTransaction, false);
    assert.equal(
      target.database.pragma("foreign_keys", { simple: true }),
      1
    );
    assert.deepEqual(resetMutationProjection(target.database), before);
  });
});

test("M7-10 restores the connection foreign-key guard when the reset transaction cannot begin", async (t) => {
  const target = await runtime(t);
  const blocker = openDatabase({
    databasePath: target.databasePath,
    environment: "test",
  });
  const passwordHash = target.database
    .prepare(`
      SELECT password_hash
      FROM user_credentials
      WHERE user_id = ? AND status = 'active'
    `)
    .get(fixtureId("account:platformAdmin")).password_hash;

  try {
    blocker.database.exec("BEGIN IMMEDIATE");
    target.database.pragma("busy_timeout = 0");
    assert.throws(
      () =>
        resetFixtureRows({
          database: target.database,
          maintenanceExclusionGuard:
            allowFixtureResetExclusion(),
          passwordHash,
          actorUserId: fixtureId("account:platformAdmin"),
          backup: fakeBackup(),
          idempotency: {
            id: crypto.randomUUID(),
            key: "blocked-reset",
            requestHash: "b".repeat(64),
          },
          occurredAtMs: FIXTURE_NOW_MS + 30_000,
          createId: crypto.randomUUID,
          reason: "Exercise a blocked reset transaction.",
        }),
      (error) => error?.code === "SQLITE_BUSY"
    );
    assert.equal(
      target.database.pragma("foreign_keys", { simple: true }),
      1
    );
  } finally {
    if (blocker.database.inTransaction) {
      blocker.database.exec("ROLLBACK");
    }
    if (blocker.database.open) blocker.database.close();
  }
});

test("M7-10 rejects fixture player or user references in another league before creating a backup", async (t) => {
  for (const conflict of ["player", "user"]) {
    await t.test(conflict, async (child) => {
      const target = await runtime(child);
      const externalLeagueId = insertExternalLeague(target.database);
      if (conflict === "player") {
        target.database
          .prepare(`
            INSERT INTO league_player_positions (
              id, league_id, player_id, position_group, reason,
              corrected_by_user_id, effective_at_ms, ended_at_ms,
              version
            ) VALUES (?, ?, ?, 'F', 'test', ?, ?, NULL, 1)
          `)
          .run(
            crypto.randomUUID(),
            externalLeagueId,
            fixtureId("player:activeForward1"),
            fixtureId("account:platformAdmin"),
            FIXTURE_NOW_MS
          );
      } else {
        target.database
          .prepare(`
            INSERT INTO league_memberships (
              id, league_id, user_id, permission_category, status,
              joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms,
              version
            ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, 1)
          `)
          .run(
            crypto.randomUUID(),
            externalLeagueId,
            fixtureId("account:platformAdmin"),
            FIXTURE_NOW_MS,
            FIXTURE_NOW_MS,
            FIXTURE_NOW_MS
          );
      }

      let backupCalls = 0;
      const service = resetService(target, {
        async createBackup() {
          backupCalls += 1;
          return fakeBackup();
        },
      });
      await assert.rejects(
        service.reset(resetRequest(`scope-${conflict}`)),
        { code: "STAGING_FIXTURE_RESET_SCOPE_CONFLICT" }
      );
      assert.equal(backupCalls, 0);
    });
  }
});

test("M7-10 revalidates authority, identity, and fixture scope after the awaited backup", async (t) => {
  await t.test("authority", async (child) => {
    const target = await runtime(child);
    let authorizationCalls = 0;
    const service = resetService(target, {
      platformAuthorization: {
        requireAdministrator() {
          authorizationCalls += 1;
          if (authorizationCalls === 2) {
            const error = new Error("authority revoked");
            error.code = "PLATFORM_ADMINISTRATOR_REQUIRED";
            throw error;
          }
          return platformAdministrator();
        },
      },
    });
    await assert.rejects(
      service.reset(resetRequest("post-backup-authority")),
      { code: "PLATFORM_ADMINISTRATOR_REQUIRED" }
    );
    assert.equal(authorizationCalls, 2);
  });

  await t.test("identity", async (child) => {
    const target = await runtime(child);
    const service = resetService(target, {
      async createBackup({ outputDirectory }) {
        target.database
          .prepare(`
            UPDATE application_metadata
            SET metadata_value = ?
            WHERE metadata_key = 'database_id'
          `)
          .run("unexpected-staging-database");
        return fakeBackup(outputDirectory);
      },
    });
    await assert.rejects(
      service.reset(resetRequest("post-backup-identity")),
      { code: "STAGING_MAINTENANCE_EXCLUSION_IDENTITY_INVALID" }
    );
  });

  await t.test("scope", async (child) => {
    const target = await runtime(child);
    target.database
      .prepare(`
        UPDATE teams
        SET name = 'Must Remain Changed',
          name_normalized = 'must remain changed',
          version = version + 1
        WHERE id = ?
      `)
      .run(fixtureId("team:leagueA:1"));
    const service = resetService(target, {
      async createBackup({ outputDirectory }) {
        const externalLeagueId = insertExternalLeague(target.database);
        target.database
          .prepare(`
            INSERT INTO league_memberships (
              id, league_id, user_id, permission_category, status,
              joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms,
              version
            ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, 1)
          `)
          .run(
            crypto.randomUUID(),
            externalLeagueId,
            fixtureId("account:platformAdmin"),
            FIXTURE_NOW_MS,
            FIXTURE_NOW_MS,
            FIXTURE_NOW_MS
          );
        return fakeBackup(outputDirectory);
      },
    });
    await assert.rejects(
      service.reset(resetRequest("post-backup-scope")),
      { code: "STAGING_FIXTURE_RESET_SCOPE_CONFLICT" }
    );
    assert.equal(
      target.database
        .prepare("SELECT name FROM teams WHERE id = ?")
        .get(fixtureId("team:leagueA:1")).name,
      "Must Remain Changed"
    );
    assert.equal(
      target.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM operational_events
          WHERE event_type = 'staging_fixture_reset'
        `)
        .get().count,
      0
    );
  });
});

test("M7-10 preserves global reset idempotency and audit events while keeping reasons out of replay results", async (t) => {
  const target = await runtime(t);
  const providerEventId = crypto.randomUUID();
  target.database.prepare(`
    INSERT INTO operational_events (
      id, league_id, season_id, event_type, feature, outcome,
      actor_user_id, reason_code, details_json, occurred_at_ms
    ) VALUES (
      ?, NULL, NULL, 'staging_sportsdataio_import',
      'player_data_provider', 'succeeded', ?,
      'manual_staging_import', '{"result":{"code":"STAGING_SPORTSDATAIO_IMPORT_COMPLETED"}}',
      ?
    )
  `).run(
    providerEventId,
    fixtureId("account:platformAdmin"),
    FIXTURE_NOW_MS + 100
  );
  target.database.prepare(`
    INSERT INTO idempotency_requests (
      id, league_id, actor_user_id, operation, client_key,
      request_hash, status, result_type, result_id,
      created_at_ms, completed_at_ms, expires_at_ms
    ) VALUES (
      ?, NULL, ?, 'staging_sportsdataio_import',
      'provider-import-before-reset', ?, 'completed',
      'operational_event', ?, ?, ?, ?
    )
  `).run(
    crypto.randomUUID(),
    fixtureId("account:platformAdmin"),
    "a".repeat(64),
    providerEventId,
    FIXTURE_NOW_MS + 100,
    FIXTURE_NOW_MS + 100,
    FIXTURE_NOW_MS + 86_400_000
  );
  let authorizationCalls = 0;
  const service = resetService(target, {
    platformAuthorization: {
      requireAdministrator() {
        authorizationCalls += 1;
        return platformAdministrator();
      },
    },
  });
  const first = await service.reset(
    resetRequest("retained-key-one", "First retained reset reason.")
  );
  const second = await service.reset(
    resetRequest("retained-key-two", "Second retained reset reason.")
  );
  const replay = await service.reset(
    resetRequest("retained-key-one", "First retained reset reason.")
  );

  assert.equal(first.replayed, undefined);
  assert.equal(second.replayed, undefined);
  assert.equal(replay.replayed, true);
  assert.equal(replay.backupId, first.backupId);
  assert.equal(Object.hasOwn(replay, "audit"), false);
  assert.equal(Object.hasOwn(replay, "reason"), false);
  assert.equal(authorizationCalls, 5);
  assert.deepEqual(
    target.database
      .prepare(`
        SELECT client_key
        FROM idempotency_requests
        WHERE league_id IS NULL AND operation = 'staging_fixture_reset'
        ORDER BY client_key ASC
      `)
      .all()
      .map(({ client_key }) => client_key),
    ["retained-key-one", "retained-key-two"]
  );
  const eventDetails = target.database
    .prepare(`
      SELECT details_json
      FROM operational_events
      WHERE league_id IS NULL
        AND event_type = 'staging_fixture_reset'
      ORDER BY id ASC
    `)
    .all()
    .map(({ details_json }) => JSON.parse(details_json));
  assert.equal(eventDetails.length, 2);
  assert.deepEqual(
    new Set(eventDetails.map(({ audit }) => audit.reason)),
    new Set([
      "First retained reset reason.",
      "Second retained reset reason.",
    ])
  );
  assert.equal(
    eventDetails.every(
      ({ result }) =>
        result.code === "STAGING_FIXTURE_RESET_COMPLETED"
    ),
    true
  );
  assert.equal(
    target.database.prepare(`
      SELECT COUNT(*) AS count
      FROM idempotency_requests
      WHERE league_id IS NULL
        AND operation = 'staging_sportsdataio_import'
        AND client_key = 'provider-import-before-reset'
    `).get().count,
    1
  );
  assert.equal(
    target.database.prepare(`
      SELECT COUNT(*) AS count
      FROM operational_events
      WHERE id = ?
        AND event_type = 'staging_sportsdataio_import'
        AND outcome = 'succeeded'
    `).get(providerEventId).count,
    1
  );
});
