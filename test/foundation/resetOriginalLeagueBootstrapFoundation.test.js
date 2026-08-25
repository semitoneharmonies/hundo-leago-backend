const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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
  captureResetOriginalLeagueContinuityBaseline,
} = require("../../src/infrastructure/migration/resetOriginalLeagueContinuityEvidence");
const {
  tableSemanticHash,
} = require("../../src/infrastructure/migration/runJsonImport");
const {
  createActionTokenDeliveryEnvelope,
} = require("../../src/infrastructure/security/createActionTokenDeliveryEnvelope");
const {
  createOpaqueActionTokens,
} = require("../../src/infrastructure/security/createOpaqueActionTokens");
const {
  RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
  RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID,
  REQUIRED_APPLICATION_TABLE_COUNT,
  REQUIRED_SCHEMA_VERSION,
  createSqliteResetOriginalLeagueBootstrapRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteResetOriginalLeagueBootstrapRepository");
const {
  createSqliteLeagueCreationRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueCreationRepository");
const {
  createSqliteSecurityAuditRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  REPOSITORY_CATALOG,
} = require("../../src/infrastructure/persistence/sqlite/repositoryCatalog");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(
  ROOT,
  "database",
  "migrations"
);
const FIRST_ADMINISTRATOR_SCRIPT = path.join(
  ROOT,
  "scripts",
  "bootstrap-first-platform-administrator.js"
);
const DELIVERY_KEY = Buffer.alloc(32, 0x71)
  .toString("base64url");
const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";
const BOOTSTRAP_LEAGUE_NAME =
  "Original Hundo League";
const BOOTSTRAP_LEAGUE_NAME_NORMALIZED =
  "original hundo league";
const BOOTSTRAP_VERIFICATION_HASH =
  "b".repeat(64);
const BOOTSTRAP_REQUEST_HASH =
  "c".repeat(64);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function tableCount(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM "${tableName}"`
    )
    .get().count;
}

function createRuntime(t, suffix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `hundo-fad-04-reset-bootstrap-guard-${suffix}-`
    )
  );
  const databasePath = path.join(
    temporaryRoot,
    "reset.sqlite3"
  );
  const initial = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: initial.database,
    migrationsDirectory: MIGRATIONS,
    applicationBuildId:
      "fad-04-reset-bootstrap-guard-test",
    now: () =>
      Date.parse("2026-07-29T12:00:00.000Z"),
  });
  initial.database
    .prepare(
      "INSERT INTO players (" +
        "id, first_name, last_name, full_name, " +
        "birth_date, status, created_at_ms, " +
        "updated_at_ms, version" +
      ") VALUES (?, 'Evidence', 'Player', " +
        "'Evidence Player', '2000-01-01', " +
        "'active', 1, 1, 1)"
    )
    .run(uuid(800));
  initial.database
    .prepare(
      "INSERT INTO player_external_ids (" +
        "id, player_id, provider, external_value, " +
        "created_at_ms" +
      ") VALUES (?, ?, 'nhl', 'reset-evidence-800', 1)"
    )
    .run(uuid(801), uuid(800));
  initial.database
    .prepare(
      "INSERT INTO player_source_state (" +
        "id, player_id, provider, source_position, " +
        "normalized_position, nhl_team_abbreviation, " +
        "active, source_version, source_payload_json, " +
        "effective_at_ms, ended_at_ms, created_at_ms" +
      ") VALUES (?, ?, 'nhl', 'C', 'F', 'VAN', 1, " +
        "'reset-evidence-v1', " +
        "'{\"source\":\"reset-evidence\"}', 1, NULL, 1)"
    )
    .run(uuid(802), uuid(800));
  const continuityBaseline =
    captureResetOriginalLeagueContinuityBaseline({
      database: initial.database,
    });
  initial.database.close();

  const administratorIdentity = Object.freeze({
    displayName: `Reset ${suffix}`,
    displayNameNormalized:
      `reset ${suffix}`.toLowerCase(),
    emailDisplay:
      `reset.${suffix}@example.test`,
    emailNormalized:
      `reset.${suffix}@example.test`,
  });
  const bootstrap = spawnSync(
    process.execPath,
    [
      FIRST_ADMINISTRATOR_SCRIPT,
      "--app-env",
      "test",
      "--confirm-app-env",
      "test",
      "--database",
      databasePath,
      "--migrations",
      MIGRATIONS,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        BOOTSTRAP_ADMIN_EMAIL:
          administratorIdentity.emailDisplay,
        BOOTSTRAP_ADMIN_DISPLAY_NAME:
          administratorIdentity.displayName,
        PUBLIC_FRONTEND_ORIGIN:
          PUBLIC_FRONTEND_ORIGIN,
        ACTION_TOKEN_DELIVERY_KEY:
          DELIVERY_KEY,
      },
      encoding: "utf8",
    }
  );
  assert.equal(
    bootstrap.status,
    0,
    bootstrap.stderr
  );
  const bootstrapSummary = JSON.parse(
    bootstrap.stdout
  );
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return {
    administratorIdentity,
    continuityBaseline,
    context: createSqliteRepositoryContext({
      database: connection.database,
    }),
    database: connection.database,
    databasePath,
    leagueCreationRepository:
      createSqliteLeagueCreationRepository({
        database: connection.database,
      }),
    repository:
      createSqliteResetOriginalLeagueBootstrapRepository({
        database: connection.database,
      }),
    securityAuditRepository:
      createSqliteSecurityAuditRepository({
        database: connection.database,
      }),
    userId: bootstrapSummary.userId,
  };
}

function stateError(error) {
  return (
    error?.code ===
    RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID
  );
}

function expectedTargetTables(database) {
  return [
    "players",
    "player_external_ids",
    "player_source_state",
  ].map((table) => {
    const count = tableCount(database, table);
    return {
      table,
      plannedRowCount: count,
      validatedRowCount: count,
      postRollbackRowCount: null,
      semanticHash: tableSemanticHash(
        database,
        table
      ),
    };
  });
}

function expectedMigrationLedger(database) {
  return database
    .prepare(
      "SELECT migration_id AS id, " +
        "file_name AS fileName, checksum " +
        "FROM schema_migrations " +
        "ORDER BY migration_id ASC"
    )
    .all();
}

function authenticateDelivery({
  outbox,
  payload,
  token,
  user,
}) {
  const secureRandom = {
    bytes() {
      throw new Error(
        "read-only authentication cannot generate bytes"
      );
    },
  };
  const delivery =
    createActionTokenDeliveryEnvelope({
      encodedKey: DELIVERY_KEY,
      keyVersion: 1,
      secureRandom,
    });
  const opaqueTokens = createOpaqueActionTokens({
    secureRandom,
  });
  const opened = delivery.open({
    envelope: payload.envelope,
    binding: {
      outboxEventId: outbox.id,
      publicFrontendOrigin:
        PUBLIC_FRONTEND_ORIGIN,
      purpose: payload.purpose,
      tokenId: token.id,
      userId: user.id,
    },
  });
  return opaqueTokens.matches(
    opened.rawToken,
    token.token_digest
  );
}

function guardOptions(runtime, overrides = {}) {
  return {
    authenticateDelivery,
    expectedAdministratorIdentity:
      runtime.administratorIdentity,
    expectedContinuityBaseline:
      runtime.continuityBaseline,
    expectedMigrationLedger:
      expectedMigrationLedger(runtime.database),
    expectedUserId: runtime.userId,
    expectedTargetTables:
      expectedTargetTables(runtime.database),
    nowMs: Date.now(),
    ...overrides,
  };
}

function runGuard(runtime, options = guardOptions(runtime)) {
  return runtime.context.transaction(() =>
    runtime.repository
      .assertPristineFirstAdministratorState(
        options
      )
  );
}

function bootstrapBinding(overrides = {}) {
  return {
    leagueId: uuid(100),
    leagueName: BOOTSTRAP_LEAGUE_NAME,
    leagueNameNormalized:
      BOOTSTRAP_LEAGUE_NAME_NORMALIZED,
    requestHash: BOOTSTRAP_REQUEST_HASH,
    seasonId: uuid(101),
    verificationHash:
      BOOTSTRAP_VERIFICATION_HASH,
    ...overrides,
  };
}

function completionOptions(
  runtime,
  {
    binding = bootstrapBinding(),
    expectedMigrationLedger: ledger =
      expectedMigrationLedger(runtime.database),
    expectedTargetTables: targets =
      expectedTargetTables(runtime.database),
    pristineState = null,
  } = {}
) {
  return {
    authenticateDelivery,
    binding,
    expectedAdministratorIdentity:
      runtime.administratorIdentity,
    expectedContinuityBaseline:
      runtime.continuityBaseline,
    expectedMigrationLedger: ledger,
    expectedTargetTables: targets,
    expectedUserId: runtime.userId,
    pristineState,
  };
}

function bootstrapCreatedAtMs(runtime) {
  return (
    runtime.database
      .prepare(
        "SELECT created_at_ms FROM account_action_tokens"
      )
      .get().created_at_ms + 1
  );
}

function writeCompletedBootstrap(
  runtime,
  {
    binding = bootstrapBinding(),
    createdAtMs = bootstrapCreatedAtMs(runtime),
  } = {}
) {
  runtime.leagueCreationRepository
    .insertStartedIdempotency({
      id: uuid(102),
      actorUserId: runtime.userId,
      operation:
        RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
      clientKey: binding.verificationHash,
      requestHash: binding.requestHash,
      createdAtMs,
      expiresAtMs:
        createdAtMs +
        RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
    });
  const insertedLeague =
    runtime.leagueCreationRepository
      .insertSetupLeague({
        id: binding.leagueId,
        name: binding.leagueName,
        nameNormalized:
          binding.leagueNameNormalized,
        nowMs: createdAtMs,
      });
  runtime.leagueCreationRepository
    .insertInitialSettings({
      leagueId: binding.leagueId,
      nowMs: createdAtMs,
    });
  runtime.leagueCreationRepository
    .insertPlannedSeason({
      id: binding.seasonId,
      leagueId: binding.leagueId,
      label:
        RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
      nhlSeasonKey:
        RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
      nowMs: createdAtMs,
    });
  runtime.leagueCreationRepository
    .setCurrentSeason({
      leagueId: binding.leagueId,
      seasonId: binding.seasonId,
      expectedVersion: insertedLeague.version,
      nowMs: createdAtMs,
    });
  runtime.leagueCreationRepository
    .appendCreationActivity({
      id: uuid(103),
      leagueId: binding.leagueId,
      seasonId: binding.seasonId,
      actorUserId: runtime.userId,
      displaySummary:
        `${binding.leagueName} was created in Setup.`,
      metadataJson:
        RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
      nowMs: createdAtMs,
    });
  runtime.securityAuditRepository.append({
    id: uuid(1),
    event_type:
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
    outcome: "success",
    actor_user_id: runtime.userId,
    target_user_id: null,
    league_id: binding.leagueId,
    session_id: null,
    request_correlation_id: null,
    reason_code:
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: createdAtMs,
  });
  runtime.leagueCreationRepository
    .completeIdempotency({
      id: uuid(102),
      leagueId: binding.leagueId,
      completedAtMs: createdAtMs,
    });
}

function createCompletedBootstrap(runtime) {
  const binding = bootstrapBinding();
  const evidence = {
    expectedMigrationLedger:
      expectedMigrationLedger(runtime.database),
    expectedTargetTables:
      expectedTargetTables(runtime.database),
  };
  return runtime.context.transaction(() => {
    const pristineState =
      runtime.repository
        .assertPristineFirstAdministratorState({
          ...guardOptions(runtime),
          ...evidence,
          nowMs: bootstrapCreatedAtMs(runtime),
        });
    writeCompletedBootstrap(runtime, { binding });
    const changesBeforeVerifier =
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count;
    const completedState =
      runtime.repository
        .assertCompletedBootstrapState(
          completionOptions(runtime, {
            binding,
            ...evidence,
            pristineState,
          })
        );
    assert.equal(
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count,
      changesBeforeVerifier
    );
    return {
      binding,
      completedState,
      evidence,
      pristineState,
    };
  });
}

describe("FAD-04 reset original-league bootstrap guard", () => {
  test("pins the bootstrap guard to the complete schema-54 application catalog", () => {
    assert.equal(REQUIRED_SCHEMA_VERSION, 54);
    assert.equal(REQUIRED_APPLICATION_TABLE_COUNT, 133);
    assert.equal(
      REPOSITORY_CATALOG.length,
      REQUIRED_APPLICATION_TABLE_COUNT
    );
  });

  test("accepts only the genuine pristine-plus-first-administrator state without writing", (t) => {
    const runtime = createRuntime(t, "exact");
    const changesBefore =
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count;
    assert.throws(
      () =>
        runtime.repository
          .assertPristineFirstAdministratorState(
            guardOptions(runtime)
          ),
      stateError
    );
    const result = runGuard(runtime);

    assert.deepEqual(result, {
      actorUserId: runtime.userId,
      schemaVersion: 54,
      stateHash: result.stateHash,
    });
    assert.match(result.stateHash, /^[a-f0-9]{64}$/);
    assert.equal(
      Object.keys(result).includes("snapshot"),
      false
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      Object.isFrozen(result.snapshot),
      true
    );
    assert.equal(
      Object.isFrozen(
        result.snapshot.protectedHashes
      ),
      true
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count,
      changesBefore
    );
    assert.equal(
      tableCount(runtime.database, "leagues"),
      0
    );
    assert.equal(
      tableCount(
        runtime.database,
        "migration_reports"
      ),
      0
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("rejects a wrong operator-confirmed administrator and every contaminated prerequisite", (t) => {
    const wrong = createRuntime(t, "wrong-id");
    assert.throws(
      () =>
        runGuard(
          wrong,
          guardOptions(wrong, {
              expectedUserId: uuid(900),
          })
        ),
      stateError
    );

    const consumed = createRuntime(
      t,
      "consumed-token"
    );
    consumed.database
      .prepare(
        "UPDATE account_action_tokens " +
          "SET status = 'consumed', " +
          "consumed_at_ms = expires_at_ms, " +
          "version = version + 1"
      )
      .run();
    assert.throws(
      () =>
        runGuard(consumed),
      stateError
    );

    const delivered = createRuntime(
      t,
      "delivered-outbox"
    );
    delivered.database
      .prepare(
        "UPDATE outbox_events " +
          "SET status = 'published', " +
          "published_at_ms = available_at_ms, " +
          "updated_at_ms = available_at_ms, " +
          "version = version + 1"
      )
      .run();
    assert.throws(
      () =>
        runGuard(delivered),
      stateError
    );

    const forbidden = createRuntime(
      t,
      "forbidden-row"
    );
    forbidden.database
      .prepare(
        "INSERT INTO account_events (" +
          "id, user_id, actor_user_id, event_type, " +
          "outcome, reason_code, metadata_json, " +
          "occurred_at_ms" +
        ") VALUES (?, ?, NULL, ?, ?, NULL, NULL, 1)"
      )
      .run(
        uuid(901),
        forbidden.userId,
        "synthetic.contamination",
        "success"
      );
    assert.throws(
      () =>
        runGuard(forbidden),
      stateError
    );

    const existingLeague = createRuntime(
      t,
      "existing-league"
    );
    existingLeague.database
      .prepare(
        "INSERT INTO leagues (" +
          "id, name, name_normalized, status, timezone, " +
          "commissioner_membership_id, current_season_id, " +
          "created_at_ms, updated_at_ms, version" +
        ") VALUES (?, 'Existing', 'existing', 'setup', " +
          "'America/Vancouver', NULL, NULL, 1, 1, 1)"
      )
      .run(uuid(902));
    assert.throws(
      () =>
        runGuard(existingLeague),
      stateError
    );

    const importedDrift = createRuntime(
      t,
      "imported-drift"
    );
    const boundTargets =
      guardOptions(importedDrift);
    importedDrift.database
      .prepare(
        "INSERT INTO players (" +
          "id, first_name, last_name, full_name, " +
          "birth_date, status, created_at_ms, " +
          "updated_at_ms, version" +
        ") VALUES (?, 'Drift', 'Player', " +
          "'Drift Player', NULL, 'active', 1, 1, 1)"
      )
      .run(uuid(904));
    assert.throws(
      () =>
        runGuard(importedDrift, boundTargets),
      stateError
    );

    const malformedEnvelope = createRuntime(
      t,
      "malformed-envelope"
    );
    const outbox = malformedEnvelope.database
      .prepare(
        "SELECT id, payload_json FROM outbox_events"
      )
      .get();
    const payload = JSON.parse(outbox.payload_json);
    payload.envelope.nonce = "AA";
    malformedEnvelope.database
      .prepare(
        "UPDATE outbox_events " +
          "SET payload_json = ? WHERE id = ?"
      )
      .run(JSON.stringify(payload), outbox.id);
    assert.throws(
      () =>
        runGuard(malformedEnvelope),
      stateError
    );

    const forgedDigest = createRuntime(
      t,
      "forged-digest"
    );
    forgedDigest.database
      .prepare(
        "UPDATE account_action_tokens " +
          "SET token_digest = ?"
      )
      .run("a".repeat(64));
    assert.throws(
      () =>
        runGuard(forgedDigest),
      stateError
    );

    const expired = createRuntime(
      t,
      "expired-token"
    );
    const expiresAtMs = expired.database
      .prepare(
        "SELECT expires_at_ms FROM account_action_tokens"
      )
      .get().expires_at_ms;
    assert.throws(
      () =>
        runGuard(
          expired,
          guardOptions(expired, {
              nowMs: expiresAtMs,
          })
        ),
      stateError
    );
  });

  test("rejects ambiguous first-bootstrap identity history", (t) => {
    const runtime = createRuntime(t, "ambiguous");
    runtime.database
      .prepare(
        "INSERT INTO users (" +
          "id, email_normalized, email_display, " +
          "display_name, display_name_normalized, " +
          "status, created_at_ms, updated_at_ms, version" +
        ") VALUES (?, ?, ?, ?, ?, " +
          "'pending_credential_setup', 1, 1, 1)"
      )
      .run(
        uuid(903),
        "second@example.test",
        "second@example.test",
        "Second",
        "second"
      );
    assert.throws(
      () =>
        runGuard(runtime),
      stateError
    );
  });
});

describe("FAD-04 reset original-league bootstrap postcondition", () => {
  test("proves the exact completed state and independently replays read-only after reopen", (t) => {
    const runtime = createRuntime(
      t,
      "completed-exact"
    );
    const {
      binding,
      completedState,
      evidence,
      pristineState,
    } = createCompletedBootstrap(runtime);

    assert.deepEqual(completedState, {
      actorUserId: runtime.userId,
      leagueId: binding.leagueId,
      schemaVersion: 54,
      seasonId: binding.seasonId,
      stateHash: completedState.stateHash,
    });
    assert.deepEqual(
      Object.keys(completedState),
      [
        "actorUserId",
        "leagueId",
        "schemaVersion",
        "seasonId",
        "stateHash",
      ]
    );
    assert.equal(Object.isFrozen(completedState), true);
    assert.equal(
      Object.isFrozen(completedState.snapshot),
      true
    );
    assert.equal(
      JSON.stringify(completedState).includes(
        "snapshot"
      ),
      false
    );
    assert.deepEqual(
      completedState.snapshot.protectedHashes,
      pristineState.snapshot.protectedHashes
    );

    const exactCounts = {
      account_action_tokens: 1,
      application_metadata: 2,
      idempotency_requests: 1,
      league_activity: 1,
      league_settings: 1,
      leagues: 1,
      outbox_events: 1,
      platform_roles: 1,
      player_external_ids: 1,
      player_source_state: 1,
      players: 1,
      seasons: 1,
      security_audit_events: 2,
      users: 1,
    };
    for (const { tableName } of REPOSITORY_CATALOG) {
      assert.equal(
        tableCount(runtime.database, tableName),
        exactCounts[tableName] || 0,
        tableName
      );
    }
    assert.deepEqual(
      runtime.database
        .prepare(
          "SELECT nhl_season_key FROM seasons WHERE id = ?"
        )
        .get(binding.seasonId),
      { nhl_season_key: "20262027" }
    );
    for (const tableName of [
      "stat_sources",
      "stat_refreshes",
      "player_stat_totals",
    ]) {
      assert.equal(
        tableCount(runtime.database, tableName),
        0,
        `new-season ${tableName}`
      );
    }
    assert.deepEqual(
      runtime.database
        .prepare(
          "SELECT status, published_at_ms, " +
            "last_error_code, attempt_count, version " +
            "FROM outbox_events"
        )
        .get(),
      {
        attempt_count: 0,
        last_error_code: null,
        published_at_ms: null,
        status: "pending",
        version: 1,
      }
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );

    assert.throws(
      () =>
        runtime.repository
          .assertCompletedBootstrapState(
            completionOptions(runtime, {
              binding,
              ...evidence,
              pristineState: null,
            })
          ),
      stateError
    );

    runtime.database.close();
    const reopened = openDatabase({
      databasePath: runtime.databasePath,
      environment: "test",
    });
    try {
      const replayRuntime = {
        administratorIdentity:
          runtime.administratorIdentity,
        continuityBaseline:
          runtime.continuityBaseline,
        context: createSqliteRepositoryContext({
          database: reopened.database,
        }),
        database: reopened.database,
        repository:
          createSqliteResetOriginalLeagueBootstrapRepository({
            database: reopened.database,
          }),
        userId: runtime.userId,
      };
      const changesBeforeReplay =
        replayRuntime.database.prepare(
          "SELECT total_changes() AS count"
        ).get().count;
      const replayed =
        replayRuntime.context.transaction(() =>
          replayRuntime.repository
            .assertCompletedBootstrapState(
              completionOptions(
                replayRuntime,
                {
                  binding,
                  ...evidence,
                  pristineState: null,
                }
              )
            )
        );
      assert.deepEqual(replayed, completedState);
      assert.equal(
        replayed.stateHash,
        completedState.stateHash
      );
      assert.equal(
        replayRuntime.database.prepare(
          "SELECT total_changes() AS count"
        ).get().count,
        changesBeforeReplay
      );
    } finally {
      reopened.database.close();
    }
  });

  test("rejects protected-row drift and rolls every league-side write back", (t) => {
    const runtime = createRuntime(
      t,
      "protected-rollback"
    );
    const binding = bootstrapBinding();
    const evidence = {
      expectedMigrationLedger:
        expectedMigrationLedger(runtime.database),
      expectedTargetTables:
        expectedTargetTables(runtime.database),
    };
    const originalUser = runtime.database
      .prepare("SELECT * FROM users")
      .get();

    assert.throws(
      () =>
        runtime.context.transaction(() => {
          const pristineState =
            runtime.repository
              .assertPristineFirstAdministratorState({
                ...guardOptions(runtime),
                ...evidence,
                nowMs:
                  bootstrapCreatedAtMs(runtime),
              });
          writeCompletedBootstrap(runtime, {
            binding,
          });
          runtime.database
            .prepare(
              "UPDATE users SET " +
                "email_normalized = ?, " +
                "email_display = ? WHERE id = ?"
            )
            .run(
              "changed@example.test",
              "changed@example.test",
              runtime.userId
            );
          runtime.repository
            .assertCompletedBootstrapState(
              completionOptions(runtime, {
                binding,
                ...evidence,
                pristineState,
              })
            );
        }),
      stateError
    );

    for (const tableName of [
      "idempotency_requests",
      "league_activity",
      "league_settings",
      "leagues",
      "seasons",
    ]) {
      assert.equal(
        tableCount(runtime.database, tableName),
        0,
        tableName
      );
    }
    assert.equal(
      tableCount(
        runtime.database,
        "security_audit_events"
      ),
      1
    );
    assert.deepEqual(
      runtime.database
        .prepare("SELECT * FROM users")
        .get(),
      originalUser
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("rejects every completed-state contract family without retaining tampering", (t) => {
    const runtime = createRuntime(
      t,
      "completed-tampering"
    );
    const { binding, evidence } =
      createCompletedBootstrap(runtime);
    const options = completionOptions(runtime, {
      binding,
      ...evidence,
      pristineState: null,
    });
    const cases = [
      () =>
        runtime.database
          .prepare(
            "UPDATE leagues SET timezone = 'UTC'"
          )
          .run(),
      () =>
        runtime.database
          .prepare(
            "UPDATE league_settings " +
              "SET salary_cap_cents = salary_cap_cents + 1"
          )
          .run(),
      () => {
        runtime.database.exec(
          "DROP TRIGGER " +
            "seasons_fad_completion_marker_guard"
        );
        runtime.database
          .prepare(
            "UPDATE seasons SET " +
              "free_agent_draft_completed_at_ms = created_at_ms"
          )
          .run();
      },
      () =>
        runtime.database
          .prepare(
            "UPDATE league_activity SET metadata_json = ?"
          )
          .run(
            '{"seasonStatus":"planned","leagueStatus":"setup"}'
          ),
      () => {
        const shiftedAtMs = runtime.database
          .prepare(
            "SELECT expires_at_ms FROM account_action_tokens"
          )
          .get().expires_at_ms;
        runtime.database
          .prepare(
            "UPDATE leagues SET created_at_ms = ?, " +
              "updated_at_ms = ?"
          )
          .run(shiftedAtMs, shiftedAtMs);
        runtime.database
          .prepare(
            "UPDATE league_settings SET created_at_ms = ?, " +
              "updated_at_ms = ?"
          )
          .run(shiftedAtMs, shiftedAtMs);
        runtime.database
          .prepare(
            "UPDATE seasons SET created_at_ms = ?, " +
              "updated_at_ms = ?"
          )
          .run(shiftedAtMs, shiftedAtMs);
        runtime.database
          .prepare(
            "UPDATE league_activity SET occurred_at_ms = ?"
          )
          .run(shiftedAtMs);
        runtime.database
          .prepare(
            "UPDATE idempotency_requests SET " +
              "created_at_ms = ?, completed_at_ms = ?, " +
              "expires_at_ms = ?"
          )
          .run(
            shiftedAtMs,
            shiftedAtMs,
            shiftedAtMs +
              RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS
          );
        runtime.database
          .prepare(
            "UPDATE security_audit_events SET " +
              "occurred_at_ms = ? WHERE event_type = ?"
          )
          .run(
            shiftedAtMs,
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT
          );
      },
      () =>
        runtime.database
          .prepare(
            "UPDATE idempotency_requests " +
              "SET expires_at_ms = expires_at_ms + 1"
          )
          .run(),
      () =>
        runtime.database
          .prepare(
            "UPDATE security_audit_events " +
              "SET reason_code = 'changed' " +
              "WHERE event_type = ?"
          )
          .run(
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT
          ),
      () =>
        runtime.database
          .prepare(
            "UPDATE players SET full_name = 'Drift Player'"
          )
          .run(),
      () =>
        runtime.database
          .prepare(
            "INSERT INTO account_events (" +
              "id, user_id, actor_user_id, event_type, " +
              "outcome, reason_code, metadata_json, " +
              "occurred_at_ms" +
            ") VALUES (?, ?, NULL, " +
              "'synthetic.contamination', 'success', " +
              "NULL, NULL, 1)"
          )
          .run(uuid(700), runtime.userId),
      () =>
        runtime.database
          .prepare(
            "CREATE TABLE unexpected_bootstrap_state (" +
              "id TEXT PRIMARY KEY" +
            ") STRICT"
          )
          .run(),
    ];

    for (const mutate of cases) {
      assert.throws(
        () =>
          runtime.context.transaction(() => {
            mutate();
            runtime.repository
              .assertCompletedBootstrapState(
                options
              );
          }),
        stateError
      );
      const verified =
        runtime.context.transaction(() =>
          runtime.repository
            .assertCompletedBootstrapState(options)
        );
      assert.equal(
        verified.stateHash.length,
        64
      );
    }
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count " +
          "FROM sqlite_schema " +
          "WHERE type = 'trigger' AND name = ?"
      ).get(
        "seasons_fad_completion_marker_guard"
      ).count,
      1
    );
  });

  test("rejects mismatched caller and artifact bindings read-only", (t) => {
    const runtime = createRuntime(
      t,
      "completed-binding"
    );
    const { binding, evidence } =
      createCompletedBootstrap(runtime);
    const base = completionOptions(runtime, {
      binding,
      ...evidence,
      pristineState: null,
    });
    const changedTargetTables =
      evidence.expectedTargetTables.map(
        (target, index) => ({
          ...target,
          semanticHash:
            index === 0
              ? "d".repeat(64)
              : target.semanticHash,
        })
      );
    const changedLedger =
      evidence.expectedMigrationLedger.map(
        (entry, index) => ({
          ...entry,
          checksum:
            index === 0
              ? "e".repeat(64)
              : entry.checksum,
        })
      );
    const cases = [
      {
        ...base,
        expectedUserId: uuid(900),
      },
      {
        ...base,
        binding: bootstrapBinding({
          leagueId: uuid(901),
        }),
      },
      {
        ...base,
        binding: bootstrapBinding({
          seasonId: uuid(902),
        }),
      },
      {
        ...base,
        binding: bootstrapBinding({
          verificationHash: "d".repeat(64),
        }),
      },
      {
        ...base,
        binding: bootstrapBinding({
          requestHash: "d".repeat(64),
        }),
      },
      {
        ...base,
        binding: bootstrapBinding({
          leagueName: "Changed League",
          leagueNameNormalized:
            "changed league",
        }),
      },
      {
        ...base,
        expectedTargetTables:
          changedTargetTables,
      },
      {
        ...base,
        expectedMigrationLedger: changedLedger,
      },
    ];
    const changesBefore =
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count;
    for (const options of cases) {
      assert.throws(
        () =>
          runtime.context.transaction(() =>
            runtime.repository
              .assertCompletedBootstrapState(
                options
              )
          ),
        stateError
      );
    }
    assert.equal(
      runtime.database.prepare(
        "SELECT total_changes() AS count"
      ).get().count,
      changesBefore
    );
  });
});
