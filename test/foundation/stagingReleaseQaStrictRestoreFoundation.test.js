"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  createTargetRuntime,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  REQUIRED_HOLD_VALUES,
} = require("../../src/config/loadStagingMaintenanceHoldConfig");
const {
  createObjectStorageAdapter,
} = require(
  "../../src/infrastructure/backups/createObjectStorageAdapter"
);
const {
  DATABASE_IDENTITY_KEYS,
} = require("../../src/infrastructure/database/databaseIdentity");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);
const {
  createSqliteLeagueOutboxRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository"
);
const {
  createEncryptedOffsiteBackup,
} = require(
  "../../src/operations/backups/createEncryptedOffsiteBackup"
);
const {
  DEFAULT_CONTRACT,
  ERROR_CODES,
  ABORT_EXECUTE_CODE,
  ABORT_PLAN_CODE,
  ABORT_RECEIPT_KIND,
  ABORT_RESTORE_MODE,
  EXECUTE_CODE,
  PLAN_CODE,
  abortConfirmationFor,
  confirmationFor,
  executeAbortReleaseQaStrictRestore,
  executeReleaseQaStrictRestore,
  parseArguments,
  planAbortReleaseQaStrictRestore,
  planReleaseQaStrictRestore,
  receiptPathFor,
  temporaryWorkDirectoryFor,
  verifyAbortStrictSmokeEvidence,
  verifyCompletedStrictSmokeEvidence,
} = require(
  "../../src/operations/release/materializeReleaseQaStrictRestore"
);
const {
  EVENT_TYPE: STRICT_FIXTURE_EVENT_TYPE,
  SIDE_CAR_IDS,
  prepareReleaseQaFadPrivacyGate,
  receiptEventId: strictFixtureReceiptId,
} = require(
  "../../src/operations/release/prepareReleaseQaFadPrivacyGate"
);
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  createReleaseQaRuntime,
} = require("../../src/operations/release/createReleaseQaRuntime");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  runReleaseQaStrictRestoreCommand,
} = require("../../scripts/release-qa-strict-restore-command");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "database", "migrations");
const BACKUP_ID = "2044fcae-24e8-4392-a1ac-4064d9cd2807";
const KEY = Buffer.alloc(32, 0x61);
const FIXED_TIME = Date.parse("2026-08-22T22:40:11.048Z");
const STRICT_FIXTURE_TIME = Date.parse("2026-08-22T09:00:00.000Z");
const SMOKE_TIME = STRICT_FIXTURE_TIME + 60_000;
let baseRoot;
let baseDatabasePath;
let postSmokeDatabasePath;
let strictSourceSnapshots;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath) {
  return hash(fs.readFileSync(filePath));
}

function dropTableTriggers(database, tableName) {
  const triggerNames = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name = ?
  `).all(tableName).map(({ name }) => name);
  for (const name of triggerNames) {
    database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
}

function firstTransferAssignmentId(database) {
  return database.prepare(`
    SELECT id FROM team_manager_assignments
    WHERE league_id = ? AND team_id = ?
      AND replaces_assignment_id IS NOT NULL
    ORDER BY assigned_at_ms, id
    LIMIT 1
  `).get(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[0]).id;
}

function createStorage() {
  const objects = new Map();
  const calls = [];
  const adapter = createObjectStorageAdapter({
    client: {
      async putObject(input) {
        calls.push({ operation: "put", key: input.key });
        objects.set(input.key, {
          body: Buffer.from(input.body),
          metadata: { ...input.metadata },
        });
        return { stored: true };
      },
      async headObject({ key }) {
        calls.push({ operation: "head", key });
        const object = objects.get(key);
        if (!object) return null;
        return {
          byteSize: object.body.length,
          sha256: hash(object.body),
        };
      },
      async getObject({ key }) {
        calls.push({ operation: "get", key });
        const object = objects.get(key);
        if (!object) throw new Error("missing object");
        return { body: Buffer.from(object.body) };
      },
    },
  });
  return { adapter, calls, objects };
}

function insertAudit(database, {
  id,
  eventType,
  correlationId,
  reasonCode,
  occurredAtMs,
  leagueId = null,
}) {
  database.prepare(`
    INSERT INTO security_audit_events (
      id, event_type, outcome, actor_user_id, target_user_id,
      league_id, session_id, request_correlation_id, reason_code,
      network_key_version, network_metadata_digest,
      client_metadata_json, unknown_account_digest, occurred_at_ms
    ) VALUES (?, ?, 'success', NULL, NULL, ?, NULL, ?, ?,
      NULL, NULL, NULL, NULL, ?)
  `).run(
    id,
    eventType,
    leagueId,
    correlationId,
    reasonCode,
    occurredAtMs
  );
}

function seedRealPlayerCatalog(database) {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(ROOT, "players.json"), "utf8")
  );
  const selected = [
    ...catalog.filter(
      ({ active, position }) => active === true && position === "F"
    ).slice(0, 500),
    ...catalog.filter(
      ({ active, position }) => active === true && position === "D"
    ).slice(0, 300),
  ];
  let idCounter = 0;
  const repository = createSqlitePlayerCatalogRepository({
    database,
    createId: () =>
      `30000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    now: () => 1_700_000_000_100,
  });
  repository.applyCatalog({
    sourceOperationId: "20000000-0000-4000-8000-000000000001",
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: selected.map((player) => ({
      providerPlayerId: String(player.id),
      firstName: player.firstName,
      lastName: player.lastName,
      fullName: player.fullName,
      birthDate: player.birthDate,
      status: "active",
      sourcePosition: player.position,
      normalizedPosition: player.position,
      nhlTeamAbbreviation: player.teamAbbrev ?? null,
      active: true,
      sourceVersion: "players-json-2026",
      sourceUpdatedAtMs: 1_700_000_000_000,
    })),
  });
}

function clockedRuntime(runtime) {
  const securityFoundations = createSecurityFoundations({
    loadConfig: () => runtime.securityConfig,
    now: () => SMOKE_TIME,
    loggerSink() {},
  });
  return Object.freeze({
    ...createTargetRuntime({
      database: runtime.database,
      migrationsDirectory: MIGRATIONS,
      securityFoundations,
      currentSeason: Object.freeze({
        label: "2026",
        nhlSeasonKey: "20262027",
      }),
      leagueWriteMode: "open",
      freeAgentDraftRoutesEnabled: true,
      networkSourceResolver() {
        return "127.0.0.1";
      },
    }),
    database: runtime.database,
  });
}

function authenticate(runtime, alias) {
  const userId = fixtureId(`account:${alias}`);
  const issued = runtime.services.sessionService.issueForUser({ userId });
  const authenticated = runtime.services.sessionService
    .resolveWithoutActivity(issued.rawSessionToken);
  assert.equal(authenticated.valid, true);
  return authenticated;
}

function strictTransferActors(runtime) {
  const live = clockedRuntime(runtime);
  const administrator = authenticate(live, "platformAdmin");
  const managerA = authenticate(live, "leagueAManagerOne");
  const managerB = authenticate(live, "leagueAManagerTwo");
  return Object.freeze({
    administrator,
    live,
    managerA,
    managerB,
    service: live.services.league.teamManagerAssignment,
  });
}

function proposeTransferToB(actors) {
  return actors.service.propose({
    leagueId: SIDE_CAR_IDS.leagueId,
    teamId: SIDE_CAR_IDS.teamIds[0],
    input: { userId: fixtureId("account:leagueAManagerTwo") },
    idempotencyKey: `${DEFAULT_CONTRACT.releaseId}-team1-to-b-propose`,
    authenticated: actors.administrator,
  });
}

function acceptTransfer(actors, assignment, alias) {
  return actors.service.accept({
    assignmentId: assignment.id,
    input: {},
    idempotencyKey: `${DEFAULT_CONTRACT.releaseId}-${alias}-accept`,
    authenticated:
      alias === "team1-to-b" ? actors.managerB : actors.managerA,
  });
}

function proposeReturnToA(actors) {
  return actors.service.propose({
    leagueId: SIDE_CAR_IDS.leagueId,
    teamId: SIDE_CAR_IDS.teamIds[0],
    input: { userId: fixtureId("account:leagueAManagerOne") },
    idempotencyKey: `${DEFAULT_CONTRACT.releaseId}-team1-to-a-propose`,
    authenticated: actors.administrator,
  });
}

function transitionPublication(database, assignmentId, outcome, nowMs) {
  const repository = createSqliteLeagueOutboxRepository({ database });
  const event = database.prepare(`
    SELECT id, league_id, version
    FROM outbox_events
    WHERE league_id = ? AND aggregate_id = ?
      AND event_type = 'team.changed'
      AND aggregate_type = 'team_manager_assignment'
  `).get(SIDE_CAR_IDS.leagueId, assignmentId);
  const claimed = repository.claim({
    eventId: event.id,
    leagueId: event.league_id,
    expectedVersion: event.version,
    nowMs,
  });
  assert.equal(claimed.status, "publishing");
  if (outcome === "publishing") return claimed;
  if (outcome === "failed") {
    return repository.markFailed({
      eventId: claimed.id,
      leagueId: claimed.league_id,
      expectedVersion: claimed.version,
      failedAtMs: nowMs,
      availableAtMs: nowMs + 5_000,
      errorCode: "PUBLICATION_FAILED",
    });
  }
  assert.equal(outcome, "published");
  return repository.markPublished({
    eventId: claimed.id,
    leagueId: claimed.league_id,
    expectedVersion: claimed.version,
    publishedAtMs: nowMs,
  });
}

async function derivePublicationSnapshot({
  sourcePath,
  targetPath,
  assignmentId,
  outcome,
  nowMs,
}) {
  fs.copyFileSync(sourcePath, targetPath);
  const opened = openDatabase({
    databasePath: targetPath,
    environment: "test",
  });
  try {
    transitionPublication(
      opened.database,
      assignmentId,
      outcome,
      nowMs
    );
  } finally {
    opened.database.close();
  }
}

before(async () => {
  baseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-strict-restore-base-")
  );
  baseDatabasePath = path.join(baseRoot, "base.sqlite3");
  postSmokeDatabasePath = path.join(baseRoot, "post-smoke.sqlite3");
  strictSourceSnapshots = {
    prepared_only: path.join(baseRoot, "prepared-only.sqlite3"),
    to_b_pending: path.join(baseRoot, "to-b-pending.sqlite3"),
    to_b_accepted_pending: path.join(
      baseRoot,
      "to-b-accepted-pending.sqlite3"
    ),
    to_b_publishing: path.join(baseRoot, "to-b-publishing.sqlite3"),
    to_b_failed: path.join(baseRoot, "to-b-failed.sqlite3"),
    to_b_published: path.join(baseRoot, "to-b-published.sqlite3"),
    return_to_a_pending: path.join(baseRoot, "return-to-a-pending.sqlite3"),
    return_to_a_accepted_pending: path.join(
      baseRoot,
      "return-to-a-accepted-pending.sqlite3"
    ),
    return_to_a_publishing: path.join(
      baseRoot,
      "return-to-a-publishing.sqlite3"
    ),
    return_to_a_failed: path.join(baseRoot, "return-to-a-failed.sqlite3"),
    return_to_a_published: postSmokeDatabasePath,
  };
  const started = await createReleaseQaRuntime({
    frontendOrigin: "http://127.0.0.1:5173",
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS,
    password: "hundo",
    port: 0,
  });
  try {
    seedRealPlayerCatalog(started.runtime.database);
    await createFreeAgentDraftBrowserFixture({
      runtime: started.runtime,
    });
    insertAudit(started.runtime.database, {
      id: "9152f844-d8cd-42f7-b0d5-b12f530ad618",
      eventType: "release_qa.credentials_rotated",
      correlationId: "HL-20260821-2",
      reasonCode: "operator_shared_password_recovery_r9_s0",
      occurredAtMs: STRICT_FIXTURE_TIME - 60_000,
    });
    started.runtime.database.prepare("DELETE FROM sessions").run();
    await started.runtime.database.backup(baseDatabasePath);
    await prepareReleaseQaFadPrivacyGate({
      runtime: started.runtime,
      operationId: DEFAULT_CONTRACT.releaseId,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
      schemaVersion: 54,
      nowMs: STRICT_FIXTURE_TIME,
      assertBinding() {},
    });
    await started.runtime.database.backup(
      strictSourceSnapshots.prepared_only
    );
    assert.equal(
      verifyAbortStrictSmokeEvidence(
        started.runtime.database,
        DEFAULT_CONTRACT
      ).classification,
      "prepared_only"
    );

    const actors = strictTransferActors(started.runtime);
    const toB = proposeTransferToB(actors);
    await started.runtime.database.backup(
      strictSourceSnapshots.to_b_pending
    );
    acceptTransfer(actors, toB.assignment, "team1-to-b");
    await started.runtime.database.backup(
      strictSourceSnapshots.to_b_accepted_pending
    );
    await derivePublicationSnapshot({
      sourcePath: strictSourceSnapshots.to_b_accepted_pending,
      targetPath: strictSourceSnapshots.to_b_publishing,
      assignmentId: toB.assignment.id,
      outcome: "publishing",
      nowMs: SMOKE_TIME + 100,
    });
    await derivePublicationSnapshot({
      sourcePath: strictSourceSnapshots.to_b_accepted_pending,
      targetPath: strictSourceSnapshots.to_b_failed,
      assignmentId: toB.assignment.id,
      outcome: "failed",
      nowMs: SMOKE_TIME + 100,
    });
    transitionPublication(
      started.runtime.database,
      toB.assignment.id,
      "published",
      SMOKE_TIME + 100
    );
    await started.runtime.database.backup(
      strictSourceSnapshots.to_b_published
    );

    const toA = proposeReturnToA(actors);
    await started.runtime.database.backup(
      strictSourceSnapshots.return_to_a_pending
    );
    acceptTransfer(actors, toA.assignment, "team1-to-a");
    await started.runtime.database.backup(
      strictSourceSnapshots.return_to_a_accepted_pending
    );
    await derivePublicationSnapshot({
      sourcePath: strictSourceSnapshots.return_to_a_accepted_pending,
      targetPath: strictSourceSnapshots.return_to_a_publishing,
      assignmentId: toA.assignment.id,
      outcome: "publishing",
      nowMs: SMOKE_TIME + 200,
    });
    await derivePublicationSnapshot({
      sourcePath: strictSourceSnapshots.return_to_a_accepted_pending,
      targetPath: strictSourceSnapshots.return_to_a_failed,
      assignmentId: toA.assignment.id,
      outcome: "failed",
      nowMs: SMOKE_TIME + 200,
    });
    transitionPublication(
      started.runtime.database,
      toA.assignment.id,
      "published",
      SMOKE_TIME + 200
    );
    assert.equal(
      verifyCompletedStrictSmokeEvidence(
        started.runtime.database,
        DEFAULT_CONTRACT
      ).completed,
      true
    );
    await started.runtime.database.backup(postSmokeDatabasePath);
    strictSourceSnapshots = Object.freeze(strictSourceSnapshots);
  } finally {
    started.runtime.close();
    await started.close();
  }
});

after(() => {
  fs.rmSync(baseRoot, { recursive: true, force: true });
});

function planArguments(contract) {
  return [
    "--database", contract.sourceDatabasePath,
    "--target", contract.targetDatabasePath,
    "--environment", contract.environment,
    "--persistent-root", contract.persistentRoot,
    "--service-id", contract.serviceId,
    "--release-id", contract.releaseId,
    "--manifest-object-key", contract.manifestObjectKey,
  ];
}

function executeOptions(contract, plan) {
  return parseArguments([
    ...planArguments(contract),
    "--plan-id", plan.planId,
    "--confirmation", confirmationFor({
      planId: plan.planId,
      contract,
    }),
  ], { execute: true });
}

function abortExecuteOptions(contract, plan) {
  return parseArguments([
    ...planArguments(contract),
    "--plan-id", plan.planId,
    "--confirmation", abortConfirmationFor({
      planId: plan.planId,
      contract,
    }),
  ], { execute: true });
}

function fixtureEnvironment(contract, overrides = {}) {
  return {
    ...REQUIRED_HOLD_VALUES,
    PORT: "10000",
    STAGING_MAINTENANCE_HOLD: "true",
    APP_ENVIRONMENT_ID: contract.environmentId,
    DATABASE_ID: contract.databaseId,
    DATABASE_PATH: contract.sourceDatabasePath,
    PERSISTENT_DATA_ROOT: contract.persistentRoot,
    APP_BUILD_ID: "a".repeat(40),
    FRONTEND_BUILD_ID: contract.frontendBuildId,
    ...overrides,
  };
}

async function runtime(
  t,
  { sourceSnapshot = postSmokeDatabasePath } = {}
) {
  const persistentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-strict-restore-")
  );
  const databaseDirectory = path.join(persistentRoot, "sqlite");
  const localBackupDirectory = path.join(persistentRoot, "backup-local");
  fs.mkdirSync(databaseDirectory);
  fs.mkdirSync(localBackupDirectory);
  const sourceDatabasePath = path.join(
    databaseDirectory,
    "hundo-leago-source.sqlite3"
  );
  const targetDatabasePath = path.join(
    databaseDirectory,
    "hundo-leago-schema54-strict-restore-HL-20260822-1.sqlite3"
  );
  fs.copyFileSync(baseDatabasePath, sourceDatabasePath);

  const storage = createStorage();
  const backupConfig = Object.freeze({
    appEnv: "staging",
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    persistentRoot,
    localDirectory: localBackupDirectory,
    encryption: Object.freeze({
      keyVersion: "staging-test-v1",
      key: Object.freeze({ value: KEY }),
    }),
    objectStorage: Object.freeze({ prefix: "staging/backups/" }),
  });
  const times = [FIXED_TIME, FIXED_TIME + 1_000];
  const backup = await createEncryptedOffsiteBackup({
    databasePath: sourceDatabasePath,
    config: backupConfig,
    objectStorage: storage.adapter,
    reason: "pre-bulk-operation",
    requestedByType: "platform_operation",
    requestedById: "strict-restore-foundation",
    backendBuildId: DEFAULT_CONTRACT.backupBackendBuildId,
    retentionClass: "pre-change",
    expiresAt: "2026-11-21T08:36:34.565Z",
    nowMs: () => times.shift(),
    createId: () => BACKUP_ID,
    randomBytes: () => Buffer.alloc(12, 0x33),
  });
  const manifest = JSON.parse(
    storage.objects.get(backup.manifestObjectKey).body.toString("utf8")
  );
  const contract = Object.freeze({
    ...DEFAULT_CONTRACT,
    persistentRoot,
    sourceDatabasePath,
    targetDatabasePath,
    backupId: backup.backupId,
    manifestObjectKey: backup.manifestObjectKey,
    storageObjectKey: backup.storageObjectKey,
    backupCreatedAt: manifest.createdAt,
    backupReason: manifest.reason,
    backupBackendBuildId: manifest.backendBuildId,
    encryptedArtifactSha256: manifest.encryptedArtifactSha256,
    manifestChecksum: manifest.manifestChecksum,
    plaintextSha256: manifest.plainBackupSha256,
    migrationChecksumSetId: manifest.migrationChecksumSetId,
  });
  fs.copyFileSync(sourceSnapshot, sourceDatabasePath);
  assert.equal(fs.existsSync(`${sourceDatabasePath}-wal`), false);
  assert.equal(fs.existsSync(`${sourceDatabasePath}-shm`), false);

  t.after(() => {
    fs.rmSync(persistentRoot, { recursive: true, force: true });
  });
  return {
    access: Object.freeze({
      objectStorage: storage.adapter,
      keyResolver: async (version) =>
        version === "staging-test-v1" ? KEY : null,
    }),
    contract,
    env: fixtureEnvironment(contract),
    options: parseArguments(planArguments(contract)),
    storage,
  };
}

function operationInput(state, overrides = {}) {
  return {
    options: state.options,
    env: state.env,
    objectStorage: state.access.objectStorage,
    keyResolver: state.access.keyResolver,
    contract: state.contract,
    ...overrides,
  };
}

test("pins the one authorized staging restore handoff and package interfaces", () => {
  assert.deepEqual({
    releaseId: DEFAULT_CONTRACT.releaseId,
    serviceId: DEFAULT_CONTRACT.serviceId,
    environment: DEFAULT_CONTRACT.environment,
    environmentId: DEFAULT_CONTRACT.environmentId,
    databaseId: DEFAULT_CONTRACT.databaseId,
    frontendBuildId: DEFAULT_CONTRACT.frontendBuildId,
    persistentRoot: DEFAULT_CONTRACT.persistentRoot,
    sourceDatabasePath: DEFAULT_CONTRACT.sourceDatabasePath,
    targetDatabasePath: DEFAULT_CONTRACT.targetDatabasePath,
    backupId: DEFAULT_CONTRACT.backupId,
    manifestObjectKey: DEFAULT_CONTRACT.manifestObjectKey,
    storageObjectKey: DEFAULT_CONTRACT.storageObjectKey,
    backupCreatedAt: DEFAULT_CONTRACT.backupCreatedAt,
    backupReason: DEFAULT_CONTRACT.backupReason,
    backupBackendBuildId: DEFAULT_CONTRACT.backupBackendBuildId,
    encryptedArtifactSha256: DEFAULT_CONTRACT.encryptedArtifactSha256,
    manifestChecksum: DEFAULT_CONTRACT.manifestChecksum,
    plaintextSha256: DEFAULT_CONTRACT.plaintextSha256,
    migrationChecksumSetId: DEFAULT_CONTRACT.migrationChecksumSetId,
    schemaVersion: DEFAULT_CONTRACT.schemaVersion,
  }, {
    releaseId: "HL-20260822-1",
    serviceId: "srv-d9eo2turnols73ekb830",
    environment: "staging",
    environmentId: "test:release-qa",
    databaseId: "m7-release-qa-fixture",
    frontendBuildId: "4dfe12d1366314e3d9df722c50771324647743c9",
    persistentRoot: "/opt/render/project/data/hundo-staging",
    sourceDatabasePath:
      "/opt/render/project/data/hundo-staging/sqlite/" +
      "hundo-leago-schema54-strict-restore-HL-20260821-3.sqlite3",
    targetDatabasePath:
      "/opt/render/project/data/hundo-staging/sqlite/" +
      "hundo-leago-schema54-strict-restore-HL-20260822-1.sqlite3",
    backupId: "2044fcae-24e8-4392-a1ac-4064d9cd2807",
    manifestObjectKey:
      "staging/backups/" +
      "hundo-leago_staging_20260822T224011048Z_" +
      "2044fcae-24e8-4392-a1ac-4064d9cd2807.manifest.json",
    storageObjectKey:
      "staging/backups/" +
      "hundo-leago_staging_20260822T224011048Z_" +
      "2044fcae-24e8-4392-a1ac-4064d9cd2807.sqlite3.gz.enc",
    backupCreatedAt: "2026-08-22T22:40:11.048Z",
    backupReason: "incident-preservation",
    backupBackendBuildId: "23971a4d66ee6383c6ad54339e769dbc9a76561e",
    encryptedArtifactSha256:
      "cee039557278c41f59fa9d6a5b09cf4f69f1b9f3589cb3774420ef34be255162",
    manifestChecksum:
      "08e3d3bde81843a683017d9952b30e02dd02978181a8644323cfbd590eca2ac8",
    plaintextSha256:
      "cf3ca07d0500888edf60f2742541ace6f5b7db0e1f2fd9b57f00db56aacacabc",
    migrationChecksumSetId:
      "6032a48eb5126eff1bfa371937c3a086cb629bdbebaddfcb912cb4bb4799ff89",
    schemaVersion: 54,
  });
  assert.equal(
    fixtureId("account:platformAdmin"),
    "dbc0118a-21f9-408c-abf5-b01d9ca05e64"
  );
  const scripts = require("../../package.json").scripts;
  assert.equal(
    scripts["release:qa:strict-restore:plan"],
    "node scripts/release-qa-strict-restore-command.js plan"
  );
  assert.equal(
    scripts["release:qa:strict-restore:execute"],
    "node scripts/release-qa-strict-restore-command.js execute"
  );
  assert.equal(
    scripts["release:qa:strict-restore:abort:plan"],
    "node scripts/release-qa-strict-restore-command.js abort-plan"
  );
  assert.equal(
    scripts["release:qa:strict-restore:abort:execute"],
    "node scripts/release-qa-strict-restore-command.js abort-execute"
  );
  assert.equal(
    ABORT_RESTORE_MODE,
    "aborted-strict-smoke-rollback"
  );
  assert.equal(
    ABORT_PLAN_CODE,
    "RELEASE_QA_STRICT_RESTORE_ABORT_PLANNED"
  );
  assert.equal(
    ABORT_EXECUTE_CODE,
    "RELEASE_QA_STRICT_RESTORE_ABORT_MATERIALIZED"
  );
  assert.equal(
    ABORT_RECEIPT_KIND,
    "release-qa-strict-restore-abort-activation-handoff"
  );
});

test("abort classification derives transfer keys from the supplied release contract", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-strict-custom-release-")
  );
  const databasePath = path.join(root, "source.sqlite3");
  fs.copyFileSync(
    strictSourceSnapshots.to_b_accepted_pending,
    databasePath
  );
  const opened = openDatabase({ databasePath, environment: "test" });
  try {
    const customReleaseId = "HL-20260822-99";
    const contract = Object.freeze({
      ...DEFAULT_CONTRACT,
      releaseId: customReleaseId,
    });
    dropTableTriggers(opened.database, "security_audit_events");
    dropTableTriggers(opened.database, "idempotency_requests");
    opened.database.prepare(`
      UPDATE security_audit_events
      SET id = ?, request_correlation_id = ?
      WHERE id = ?
    `).run(
      strictFixtureReceiptId(contract.databaseId, customReleaseId),
      customReleaseId,
      strictFixtureReceiptId(
        DEFAULT_CONTRACT.databaseId,
        DEFAULT_CONTRACT.releaseId
      )
    );
    opened.database.prepare(`
      UPDATE idempotency_requests
      SET client_key = replace(client_key, ?, ?)
      WHERE league_id = ? AND client_key LIKE ?
    `).run(
      DEFAULT_CONTRACT.releaseId,
      customReleaseId,
      SIDE_CAR_IDS.leagueId,
      `${DEFAULT_CONTRACT.releaseId}-%`
    );
    const evidence = verifyAbortStrictSmokeEvidence(
      opened.database,
      contract
    );
    assert.equal(
      evidence.fixtureReceiptId,
      strictFixtureReceiptId(contract.databaseId, customReleaseId)
    );
    assert.equal(evidence.fixtureLeagueId, SIDE_CAR_IDS.leagueId);
    assert.equal(evidence.classification, "to_b_accepted");
    assert.equal(evidence.phaseOnePublicationState, "pending");
    assert.equal(evidence.returnPublicationState, "none");
    assert.equal(evidence.sourceSemanticChainCompleted, false);
    assert.equal(evidence.smokeCompleted, false);
    assert.equal(evidence.hostedSmokeCompleted, false);
    assert.equal(evidence.releaseBlocked, true);
    assert.equal(evidence.rollbackOnly, true);
  } finally {
    opened.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plans the exact encrypted restore without mutating source or target", async (t) => {
  const state = await runtime(t);
  const beforeBytes = fs.readFileSync(state.contract.sourceDatabasePath);
  const beforeEntries = fs.readdirSync(
    path.dirname(state.contract.targetDatabasePath)
  ).sort();
  const first = await planReleaseQaStrictRestore(operationInput(state));
  const second = await planReleaseQaStrictRestore(operationInput(state));

  assert.equal(first.code, PLAN_CODE);
  assert.equal(first.planId, second.planId);
  assert.equal(first.confirmation, confirmationFor({
    planId: first.planId,
    contract: state.contract,
  }));
  assert.equal(first.authoritativeDatabaseMutationCount, 0);
  assert.equal(first.durableFilesystemMutationCount, 0);
  assert.equal(first.temporaryFilesystemWork.performed, true);
  assert.equal(
    first.temporaryFilesystemWork.plaintextDatabaseMaterialized,
    true
  );
  assert.equal(first.temporaryFilesystemWork.retained, false);
  assert.equal(Object.hasOwn(first, "readOnly"), false);
  assert.equal(Object.hasOwn(first, "filesystemMutationCount"), false);
  assert.equal(first.backupId, BACKUP_ID);
  assert.equal(first.activationHandoff.oldValue,
    state.contract.sourceDatabasePath);
  assert.equal(first.activationHandoff.newValue,
    state.contract.targetDatabasePath);
  assert.equal(first.activationHandoff.renderEnvironmentChanged, false);
  assert.equal(
    first.activationHandoff.requiredExecutionContext,
    "attached-render-service-shell"
  );
  assert.equal(
    first.activationHandoff.renderServiceIdentityIndependentlyVerified,
    false
  );
  assert.equal(first.verification.sourceStrictSmokeCompleted, true);
  assert.deepEqual(
    fs.readFileSync(state.contract.sourceDatabasePath),
    beforeBytes
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(state.contract.targetDatabasePath)).sort(),
    beforeEntries
  );
  assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  assert.equal(
    fs.existsSync(temporaryWorkDirectoryFor(
      state.contract.targetDatabasePath
    )),
    false
  );
});

test("materializes by no-replace publication, preserves source, and replays with zero mutation", async (t) => {
  const state = await runtime(t);
  const sourceBefore = fs.readFileSync(state.contract.sourceDatabasePath);
  const plan = await planReleaseQaStrictRestore(operationInput(state));
  const options = executeOptions(state.contract, plan);
  const first = await executeReleaseQaStrictRestore(operationInput(state, {
    options,
  }));
  assert.equal(first.code, EXECUTE_CODE);
  assert.equal(first.replayed, false);
  assert.equal(first.authoritativeDatabaseMutationCount, 0);
  assert.equal(first.durableFilesystemMutationCount, 2);
  assert.equal(first.temporaryFilesystemWork.performed, true);
  assert.equal(first.sourcePreserved, true);
  assert.equal(first.targetVerified, true);
  assert.equal(
    hashFile(state.contract.targetDatabasePath),
    state.contract.plaintextSha256
  );
  assert.equal(
    fs.existsSync(receiptPathFor(state.contract.targetDatabasePath)),
    true
  );
  const durableReceipt = JSON.parse(fs.readFileSync(
    receiptPathFor(state.contract.targetDatabasePath),
    "utf8"
  ));
  assert.equal(durableReceipt.backendBuildId, state.env.APP_BUILD_ID);
  assert.equal(
    durableReceipt.frontendBuildId,
    state.contract.frontendBuildId
  );
  assert.equal(durableReceipt.schemaVersion, 54);
  assert.equal(
    durableReceipt.migrationChecksumSetId,
    state.contract.migrationChecksumSetId
  );
  assert.equal(durableReceipt.planId, plan.planId);
  assert.equal(durableReceipt.planPayload.releaseId, plan.releaseId);
  assert.match(durableReceipt.planPayload.sourceDevice, /^\d+$/u);
  assert.match(durableReceipt.planPayload.sourceInode, /^\d+$/u);
  assert.match(durableReceipt.planPayload.sourceSizeBytes, /^[1-9]\d*$/u);
  assert.match(durableReceipt.planPayload.sourceMtimeNs, /^\d+$/u);
  assert.equal(
    Object.hasOwn(durableReceipt.planPayload, "sourceMtimeMs"),
    false
  );
  assert.equal(
    durableReceipt.planPayload.sourceStrictSmokeEvidence.completed,
    true
  );
  assert.deepEqual(
    fs.readFileSync(state.contract.sourceDatabasePath),
    sourceBefore
  );
  assert.equal(fs.existsSync(`${state.contract.targetDatabasePath}-wal`), false);
  assert.equal(fs.existsSync(`${state.contract.targetDatabasePath}-shm`), false);

  const targetBefore = fs.readFileSync(state.contract.targetDatabasePath);
  const receiptBefore = fs.readFileSync(
    receiptPathFor(state.contract.targetDatabasePath)
  );
  let mutationAttemptCount = 0;
  const replayFs = Object.create(fs);
  for (const method of [
    "chmodSync",
    "copyFileSync",
    "fsyncSync",
    "linkSync",
    "mkdirSync",
    "openSync",
    "renameSync",
    "rmdirSync",
    "rmSync",
    "unlinkSync",
    "writeFileSync",
  ]) {
    replayFs[method] = () => {
      mutationAttemptCount += 1;
      throw new Error(`replay attempted ${method}`);
    };
  }
  const replay = await executeReleaseQaStrictRestore(operationInput(state, {
    options,
    fsModule: replayFs,
    objectStorage: {
      async getPrivateObject() {
        throw new Error("replay attempted object download");
      },
      async headPrivateObject() {
        throw new Error("replay attempted object head");
      },
    },
    keyResolver: async () => {
      throw new Error("replay attempted key resolution");
    },
    restoreFunction: async () => {
      throw new Error("replay attempted restore");
    },
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.authoritativeDatabaseMutationCount, 0);
  assert.equal(replay.durableFilesystemMutationCount, 0);
  assert.equal(replay.temporaryFilesystemWork.performed, false);
  assert.equal(
    replay.temporaryFilesystemWork.plaintextDatabaseMaterialized,
    false
  );
  assert.equal(mutationAttemptCount, 0);
  assert.deepEqual(
    fs.readFileSync(state.contract.targetDatabasePath),
    targetBefore
  );
  assert.deepEqual(
    fs.readFileSync(receiptPathFor(state.contract.targetDatabasePath)),
    receiptBefore
  );
  assert.equal(fs.existsSync(`${state.contract.targetDatabasePath}-wal`), false);
  assert.equal(fs.existsSync(`${state.contract.targetDatabasePath}-shm`), false);
});

test("source identity uses exact bigint inode and nanosecond evidence", async (t) => {
  function driftedFs(sourcePath, field, values) {
    const injected = Object.create(fs);
    let sourceReadCount = 0;
    injected.lstatSync = (entryPath, options) => {
      const stat = fs.lstatSync(entryPath, options);
      if (
        options?.bigint === true &&
        path.resolve(entryPath) === path.resolve(sourcePath)
      ) {
        const value = values[Math.min(sourceReadCount, values.length - 1)];
        sourceReadCount += 1;
        return new Proxy(stat, {
          get(target, property) {
            if (property === field) return value;
            const result = Reflect.get(target, property, target);
            return typeof result === "function"
              ? result.bind(target)
              : result;
          },
        });
      }
      return stat;
    };
    return injected;
  }

  const inodeCollision = await runtime(t);
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(inodeCollision, {
      fsModule: driftedFs(
        inodeCollision.contract.sourceDatabasePath,
        "ino",
        [9_007_199_254_740_992n, 9_007_199_254_740_993n]
      ),
    })),
    { code: ERROR_CODES.sourceChanged }
  );
  assert.equal(
    fs.existsSync(temporaryWorkDirectoryFor(
      inodeCollision.contract.targetDatabasePath
    )),
    false
  );

  const timestampDrift = await runtime(t);
  const actual = fs.lstatSync(
    timestampDrift.contract.sourceDatabasePath,
    { bigint: true }
  );
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(timestampDrift, {
      fsModule: driftedFs(
        timestampDrift.contract.sourceDatabasePath,
        "mtimeNs",
        [actual.mtimeNs, actual.mtimeNs + 1n]
      ),
    })),
    { code: ERROR_CODES.sourceChanged }
  );
  assert.equal(
    fs.existsSync(temporaryWorkDirectoryFor(
      timestampDrift.contract.targetDatabasePath
    )),
    false
  );
});

test("rejects every drifted hold, target identity, and typed plan before publication", async (t) => {
  // Each remaining case owns a separate fixture so one failure cannot hide
  // mutation from another safety boundary.
  const fields = [
    ["APP_ENV", "production"],
    ["NODE_ENV", "development"],
    ["LEAGUE_WRITE_MODE", "open"],
    ["SCHEDULED_JOBS_ENABLED", "true"],
    ["FREE_AGENT_DRAFT_ROUTES_ENABLED", "true"],
    ["ACCOUNT_EMAIL_DELIVERY_ENABLED", "true"],
    ["DEBUG_ROUTES_ENABLED", "true"],
    ["EMAIL_DELIVERY_MODE", "send"],
    ["BACKUP_SCHEDULE_ENABLED", "true"],
    ["APP_ENVIRONMENT_ID", "test:wrong-environment"],
    ["DATABASE_ID", "wrong-release-qa-database"],
    ["FRONTEND_BUILD_ID", "b".repeat(40)],
    ["APP_BUILD_ID", "not-a-commit"],
    ["DATABASE_PATH", "C:\\wrong\\database.sqlite3"],
    ["PERSISTENT_DATA_ROOT", "C:\\wrong"],
    ["SPORTSDATAIO_NHL_API_KEY", "forbidden"],
  ];
  for (const [field, value] of fields) {
    const state = await runtime(t);
    await assert.rejects(
      planReleaseQaStrictRestore(operationInput(state, {
        env: { ...state.env, [field]: value },
      })),
      { code: ERROR_CODES.environmentUnsafe },
      field
    );
    assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  }
  const initialState = await runtime(t);
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(initialState, {
      env: { ...initialState.env, STAGING_MAINTENANCE_HOLD: "false" },
    })),
    { code: ERROR_CODES.environmentUnsafe }
  );

  const state = await runtime(t);
  for (const [field, value] of [
    ["serviceId", "srv-wrong"],
    ["releaseId", "HL-20260821-99"],
    ["sourceDatabasePath", path.join(
      state.contract.persistentRoot,
      "sqlite",
      "wrong-source.sqlite3"
    )],
    ["targetDatabasePath", path.join(
      state.contract.persistentRoot,
      "sqlite",
      "wrong-target.sqlite3"
    )],
  ]) {
    await assert.rejects(
      planReleaseQaStrictRestore(operationInput(state, {
        options: Object.freeze({ ...state.options, [field]: value }),
      })),
      { code: ERROR_CODES.inputInvalid },
      field
    );
  }
  const plan = await planReleaseQaStrictRestore(operationInput(state));
  for (const overrides of [
    { planId: `release-qa-strict-restore-v1-${"0".repeat(64)}` },
    { confirmation: "MATERIALIZE-WRONG" },
  ]) {
    const options = {
      ...executeOptions(state.contract, plan),
      ...overrides,
    };
    await assert.rejects(
      executeReleaseQaStrictRestore(operationInput(state, { options })),
      { code: ERROR_CODES.planMismatch }
    );
    assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  }
});

test("binds the exact manifest, backup, encrypted hash, plaintext, key, schema, and identity", async (t) => {
  const contractFields = [
    ["backupId", "00000000-0000-4000-8000-000000000999"],
    ["manifestObjectKey", "staging/backups/wrong.manifest.json"],
    ["storageObjectKey", "staging/backups/wrong.sqlite3.gz.enc"],
    ["encryptedArtifactSha256", "1".repeat(64)],
    ["manifestChecksum", "2".repeat(64)],
    ["plaintextSha256", "3".repeat(64)],
    ["migrationChecksumSetId", "4".repeat(64)],
    ["schemaVersion", 53],
  ];
  for (const [field, value] of contractFields) {
    const state = await runtime(t);
    const contract = Object.freeze({ ...state.contract, [field]: value });
    const options = {
      ...state.options,
      ...(field === "manifestObjectKey" ? { manifestObjectKey: value } : {}),
    };
    await assert.rejects(
      planReleaseQaStrictRestore(operationInput(state, {
        contract,
        options,
      })),
      (error) => [
        ERROR_CODES.inputInvalid,
        ERROR_CODES.manifestMismatch,
        ERROR_CODES.sourceInvalid,
      ].includes(error.code),
      field
    );
    assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  }

  const wrongKey = await runtime(t);
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(wrongKey, {
      keyResolver: async () => Buffer.alloc(32, 0x62),
    })),
    { code: ERROR_CODES.candidateInvalid }
  );

  const identity = await runtime(t);
  const connection = openDatabase({
    databasePath: identity.contract.sourceDatabasePath,
    environment: "test",
  });
  connection.database.prepare(`
    UPDATE application_metadata
    SET metadata_value = 'wrong-release-qa-database'
    WHERE metadata_key = ?
  `).run(DATABASE_IDENTITY_KEYS.databaseId);
  connection.database.close();
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(identity)),
    { code: ERROR_CODES.sourceInvalid }
  );

  const schema = await runtime(t);
  const schemaConnection = openDatabase({
    databasePath: schema.contract.sourceDatabasePath,
    environment: "test",
  });
  schemaConnection.database.pragma("user_version = 53");
  schemaConnection.database.close();
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(schema)),
    { code: ERROR_CODES.sourceInvalid }
  );

  const foreignKey = await runtime(t);
  const foreignKeyConnection = openDatabase({
    databasePath: foreignKey.contract.sourceDatabasePath,
    environment: "test",
  });
  foreignKeyConnection.database.pragma("foreign_keys = OFF");
  foreignKeyConnection.database.prepare(`
    INSERT INTO security_audit_events (
      id, event_type, outcome, actor_user_id, target_user_id,
      league_id, session_id, request_correlation_id, reason_code,
      network_key_version, network_metadata_digest,
      client_metadata_json, unknown_account_digest, occurred_at_ms
    ) VALUES (
      '00000000-0000-4000-8000-00000000f398',
      'release_qa.invalid_foreign_key', 'success', NULL, NULL,
      '00000000-0000-4000-8000-00000000ffff', NULL,
      'HL-20260822-1', 'injected', NULL, NULL, NULL, NULL, 30
    )
  `).run();
  foreignKeyConnection.database.close();
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(foreignKey)),
    { code: ERROR_CODES.sourceInvalid }
  );
});

test("rejects unsafe roots, aliases, sidecars, symlinks, and pre-existing targets", async (t) => {
  const wrongRoot = await runtime(t);
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-strict-restore-outside-")
  );
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(wrongRoot, {
      contract: Object.freeze({
        ...wrongRoot.contract,
        persistentRoot: outside,
      }),
      options: Object.freeze({
        ...wrongRoot.options,
        persistentRoot: outside,
      }),
      env: {
        ...wrongRoot.env,
        PERSISTENT_DATA_ROOT: outside,
      },
    })),
    { code: ERROR_CODES.inputInvalid }
  );

  const sidecar = await runtime(t);
  fs.writeFileSync(`${sidecar.contract.sourceDatabasePath}-wal`, "unsafe");
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(sidecar)),
    { code: ERROR_CODES.pathUnsafe }
  );
  assert.equal(
    fs.readFileSync(`${sidecar.contract.sourceDatabasePath}-wal`, "utf8"),
    "unsafe"
  );

  const existing = await runtime(t);
  fs.writeFileSync(existing.contract.targetDatabasePath, "foreign");
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(existing)),
    { code: ERROR_CODES.targetConflict }
  );
  assert.equal(
    fs.readFileSync(existing.contract.targetDatabasePath, "utf8"),
    "foreign"
  );

  const linked = await runtime(t);
  const foreignTarget = path.join(linked.contract.persistentRoot, "foreign");
  fs.writeFileSync(foreignTarget, "foreign");
  let fileSymlinkCreated = false;
  try {
    fs.symlinkSync(foreignTarget, linked.contract.targetDatabasePath, "file");
    fileSymlinkCreated = true;
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) {
      t.diagnostic("symbolic-link capability unavailable on this host");
    } else {
      throw error;
    }
  }
  if (fileSymlinkCreated) {
    await assert.rejects(
      planReleaseQaStrictRestore(operationInput(linked)),
      { code: ERROR_CODES.targetConflict }
    );
  }
  assert.equal(fs.readFileSync(foreignTarget, "utf8"), "foreign");

  const staleWork = await runtime(t);
  const staleWorkDirectory = temporaryWorkDirectoryFor(
    staleWork.contract.targetDatabasePath
  );
  fs.mkdirSync(staleWorkDirectory);
  const staleEvidence = path.join(staleWorkDirectory, "foreign-evidence");
  fs.writeFileSync(staleEvidence, "preserve");
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(staleWork)),
    { code: ERROR_CODES.temporaryConflict }
  );
  assert.equal(fs.readFileSync(staleEvidence, "utf8"), "preserve");

  const alias = await runtime(t);
  const actualParent = path.dirname(alias.contract.targetDatabasePath);
  const aliasParent = path.join(alias.contract.persistentRoot, "sqlite-alias");
  try {
    fs.symlinkSync(actualParent, aliasParent, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) {
      t.diagnostic("directory-link capability unavailable on this host");
      return;
    }
    throw error;
  }
  const aliasTarget = path.join(
    aliasParent,
    path.basename(alias.contract.targetDatabasePath)
  );
  const aliasContract = Object.freeze({
    ...alias.contract,
    targetDatabasePath: aliasTarget,
  });
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(alias, {
      contract: aliasContract,
      options: Object.freeze({
        ...alias.options,
        targetDatabasePath: aliasTarget,
      }),
    })),
    { code: ERROR_CODES.pathUnsafe }
  );
});

test("rolls back receipt and target on partial publication or source drift", async (t) => {
  const temporaryFailure = await runtime(t);
  await assert.rejects(
    planReleaseQaStrictRestore(operationInput(temporaryFailure, {
      async restoreFunction({ targetDatabasePath }) {
        fs.writeFileSync(targetDatabasePath, "owned plaintext");
        throw new Error("injected process-local restore failure");
      },
    })),
    { code: ERROR_CODES.candidateInvalid }
  );
  assert.equal(
    fs.existsSync(temporaryWorkDirectoryFor(
      temporaryFailure.contract.targetDatabasePath
    )),
    false
  );

  const publication = await runtime(t);
  const plan = await planReleaseQaStrictRestore(operationInput(publication));
  const failingFs = Object.create(fs);
  let linkCount = 0;
  failingFs.linkSync = (source, target) => {
    linkCount += 1;
    if (linkCount === 2) {
      const error = new Error("injected target publication failure");
      error.code = "EIO";
      throw error;
    }
    return fs.linkSync(source, target);
  };
  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(publication, {
      options: executeOptions(publication.contract, plan),
      fsModule: failingFs,
    })),
    { code: ERROR_CODES.publicationFailed }
  );
  assert.equal(fs.existsSync(publication.contract.targetDatabasePath), false);
  assert.equal(
    fs.existsSync(receiptPathFor(publication.contract.targetDatabasePath)),
    false
  );

  const changed = await runtime(t);
  const changedPlan = await planReleaseQaStrictRestore(operationInput(changed));
  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(changed, {
      options: executeOptions(changed.contract, changedPlan),
      failureHook(stage) {
        if (stage !== "after-target") return;
        const connection = openDatabase({
          databasePath: changed.contract.sourceDatabasePath,
          environment: "test",
        });
        insertAudit(connection.database, {
          id: "00000000-0000-4000-8000-00000000f399",
          eventType: "release_qa.test_source_changed",
          correlationId: changed.contract.releaseId,
          reasonCode: "injected",
          occurredAtMs: 30,
        });
        connection.database.close();
      },
    })),
    { code: ERROR_CODES.sourceChanged }
  );
  assert.equal(fs.existsSync(changed.contract.targetDatabasePath), false);
  assert.equal(
    fs.existsSync(receiptPathFor(changed.contract.targetDatabasePath)),
    false
  );
});

test("execute requires the exact completed strict fixture boundary", async (t) => {
  const state = await runtime(t);
  const plan = await planReleaseQaStrictRestore(operationInput(state));
  const connection = openDatabase({
    databasePath: state.contract.sourceDatabasePath,
    environment: "test",
  });
  try {
    const triggerNames = connection.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'trigger' AND tbl_name = 'outbox_events'
    `).all().map(({ name }) => name);
    for (const name of triggerNames) {
      connection.database.exec(
        `DROP TRIGGER "${name.replaceAll('"', '""')}"`
      );
    }
    connection.database.prepare(`
      UPDATE outbox_events
      SET aggregate_type = 'tampered_manager_assignment'
      WHERE id = (
        SELECT id FROM outbox_events
        WHERE league_id = ?
          AND event_type = 'team.changed'
          AND aggregate_type = 'team_manager_assignment'
        ORDER BY created_at_ms, id
        LIMIT 1
      )
    `).run(SIDE_CAR_IDS.leagueId);
  } finally {
    connection.database.close();
  }

  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(state, {
      options: executeOptions(state.contract, plan),
    })),
    { code: ERROR_CODES.sourceInvalid }
  );
  assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  assert.equal(
    fs.existsSync(receiptPathFor(state.contract.targetDatabasePath)),
    false
  );
});

test("execute refuses manager-chain, proposer, Team2, auction, and allocation drift", async (t) => {
  const cases = [
    {
      name: "Team1 final manager",
      mutate(database) {
        const managerB = fixtureId("account:leagueAManagerTwo");
        database.prepare(`
          UPDATE team_manager_assignments
          SET user_id = ?, membership_id = (
            SELECT id FROM league_memberships
            WHERE league_id = ? AND user_id = ? AND status = 'active'
          )
          WHERE league_id = ? AND team_id = ?
            AND status = 'accepted' AND ended_at_ms IS NULL
        `).run(
          managerB,
          SIDE_CAR_IDS.leagueId,
          managerB,
          SIDE_CAR_IDS.leagueId,
          SIDE_CAR_IDS.teamIds[0]
        );
      },
    },
    {
      name: "exact platform administrator proposer",
      mutate(database) {
        database.prepare(`
          UPDATE team_manager_assignments
          SET assigned_by_user_id = ?
          WHERE league_id = ? AND team_id = ?
            AND replaces_assignment_id IS NOT NULL
        `).run(
          fixtureId("account:leagueACommissioner"),
          SIDE_CAR_IDS.leagueId,
          SIDE_CAR_IDS.teamIds[0]
        );
      },
    },
    {
      name: "Team2 original assignment",
      mutate(database) {
        database.prepare(`
          UPDATE team_manager_assignments
          SET version = version + 1
          WHERE league_id = ? AND team_id = ?
        `).run(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[1]);
      },
    },
    {
      name: "allocation boundary",
      mutate(database) {
        const triggerNames = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'trigger'
            AND tbl_name = 'free_agent_draft_player_allocations'
        `).all().map(({ name }) => name);
        for (const name of triggerNames) {
          database.exec(
            `DROP TRIGGER "${name.replaceAll('"', '""')}"`
          );
        }
        database.prepare(`
          UPDATE free_agent_draft_player_allocations
          SET updated_at_ms = ?, version = version + 1
          WHERE league_id = ?
        `).run(SMOKE_TIME + 1, SIDE_CAR_IDS.leagueId);
      },
    },
    {
      name: "auction bid boundary",
      mutate(database) {
        const triggerNames = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = 'auction_bids'
        `).all().map(({ name }) => name);
        for (const name of triggerNames) {
          database.exec(
            `DROP TRIGGER "${name.replaceAll('"', '""')}"`
          );
        }
        const auction = database.prepare(`
          SELECT id, season_id FROM auctions
          WHERE league_id = ?
        `).get(SIDE_CAR_IDS.leagueId);
        database.prepare(`
          INSERT INTO auction_bids (
            id, league_id, season_id, auction_id, team_id,
            submitted_by_user_id, total_value_cents, term_years,
            lowest_offered_aav_cents,
            first_submitted_at_ms, last_edited_at_ms, edit_count,
            status, idempotency_request_id, version,
            lowest_offered_total_value_cents
          ) VALUES (
            '00000000-0000-4000-8000-00000000b101', ?, ?, ?, ?,
            ?, 525, 1, 525, ?, ?, 0, 'active', NULL, 1, 525
          )
        `).run(
          SIDE_CAR_IDS.leagueId,
          auction.season_id,
          auction.id,
          SIDE_CAR_IDS.teamIds[0],
          fixtureId("account:leagueAManagerOne"),
          SMOKE_TIME + 1,
          SMOKE_TIME + 1
        );
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const state = await runtime(t);
      const plan = await planReleaseQaStrictRestore(operationInput(state));
      const connection = openDatabase({
        databasePath: state.contract.sourceDatabasePath,
        environment: "test",
      });
      try {
        scenario.mutate(connection.database);
      } finally {
        connection.database.close();
      }
      await assert.rejects(
        executeReleaseQaStrictRestore(operationInput(state, {
          options: executeOptions(state.contract, plan),
        })),
        { code: ERROR_CODES.sourceInvalid }
      );
      assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
      assert.equal(
        fs.existsSync(temporaryWorkDirectoryFor(
          state.contract.targetDatabasePath
        )),
        false
      );
    });
  }
});

test("rejects replay tamper without deleting evidence", async (t) => {
  const state = await runtime(t);
  const plan = await planReleaseQaStrictRestore(operationInput(state));
  const options = executeOptions(state.contract, plan);
  await executeReleaseQaStrictRestore(operationInput(state, { options }));
  fs.appendFileSync(state.contract.targetDatabasePath, "tamper");
  const tampered = fs.readFileSync(state.contract.targetDatabasePath);
  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(state, { options })),
    { code: ERROR_CODES.targetConflict }
  );
  assert.deepEqual(
    fs.readFileSync(state.contract.targetDatabasePath),
    tampered
  );
  assert.equal(
    fs.existsSync(receiptPathFor(state.contract.targetDatabasePath)),
    true
  );

  const receiptState = await runtime(t);
  const receiptPlan = await planReleaseQaStrictRestore(
    operationInput(receiptState)
  );
  const receiptOptions = executeOptions(
    receiptState.contract,
    receiptPlan
  );
  await executeReleaseQaStrictRestore(operationInput(receiptState, {
    options: receiptOptions,
  }));
  const receiptPath = receiptPathFor(
    receiptState.contract.targetDatabasePath
  );
  fs.appendFileSync(receiptPath, "tamper");
  const tamperedReceipt = fs.readFileSync(receiptPath);
  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(receiptState, {
      options: receiptOptions,
    })),
    { code: ERROR_CODES.targetConflict }
  );
  assert.deepEqual(fs.readFileSync(receiptPath), tamperedReceipt);
  assert.equal(fs.existsSync(receiptState.contract.targetDatabasePath), true);
});

test("command output is sanitized and emitted only after success", async (t) => {
  const state = await runtime(t);
  const lines = [];
  const result = await runReleaseQaStrictRestoreCommand({
    mode: "plan",
    argv: planArguments(state.contract),
    env: state.env,
    output: { log(value) { lines.push(value); } },
    backupAccess: state.access,
    contract: state.contract,
  });
  assert.equal(result.code, PLAN_CODE);
  assert.equal(lines.length, 1);
  const serialized = lines[0];
  for (const forbidden of [
    KEY.toString("base64url"),
    "test-secret",
    "password",
    "encryptionIv",
    "encryptionTag",
    "rowCounts",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const failedLines = [];
  await assert.rejects(
    runReleaseQaStrictRestoreCommand({
      mode: "plan",
      argv: planArguments(state.contract),
      env: { ...state.env, LEAGUE_WRITE_MODE: "open" },
      output: { log(value) { failedLines.push(value); } },
      backupAccess: state.access,
      contract: state.contract,
    }),
    { code: ERROR_CODES.environmentUnsafe }
  );
  assert.deepEqual(failedLines, []);
});

test("abort plan recognizes only the finite held strict-smoke states", async (t) => {
  const cases = [
    ["prepared_only", "prepared_only", "none", "none", false],
    ["to_b_pending", "to_b_pending", "none", "none", false],
    [
      "to_b_accepted_pending",
      "to_b_accepted",
      "pending",
      "none",
      false,
    ],
    [
      "to_b_publishing",
      "to_b_accepted",
      "publishing",
      "none",
      false,
    ],
    ["to_b_failed", "to_b_accepted", "failed", "none", false],
    ["to_b_published", "to_b_accepted", "published", "none", false],
    [
      "return_to_a_pending",
      "return_to_a_pending",
      "published",
      "none",
      false,
    ],
    [
      "return_to_a_accepted_pending",
      "return_to_a_accepted",
      "published",
      "pending",
      true,
    ],
    [
      "return_to_a_publishing",
      "return_to_a_accepted",
      "published",
      "publishing",
      true,
    ],
    [
      "return_to_a_failed",
      "return_to_a_accepted",
      "published",
      "failed",
      true,
    ],
    [
      "return_to_a_published",
      "return_to_a_accepted",
      "published",
      "published",
      true,
    ],
  ];
  for (const [
    snapshot,
    classification,
    phaseOnePublicationState,
    returnPublicationState,
    sourceSemanticChainCompleted,
  ] of cases) {
    await t.test(snapshot, async (child) => {
      const state = await runtime(child, {
        sourceSnapshot: strictSourceSnapshots[snapshot],
      });
      const sourceBefore = fs.readFileSync(
        state.contract.sourceDatabasePath
      );
      const plan = await planAbortReleaseQaStrictRestore(
        operationInput(state)
      );
      assert.equal(plan.code, ABORT_PLAN_CODE);
      assert.match(
        plan.planId,
        /^release-qa-strict-restore-abort-v1-[a-f0-9]{64}$/u
      );
      assert.equal(
        plan.confirmation,
        abortConfirmationFor({
          planId: plan.planId,
          contract: state.contract,
        })
      );
      assert.equal(plan.restoreMode, ABORT_RESTORE_MODE);
      assert.equal(plan.smokeCompleted, false);
      assert.equal(plan.hostedSmokeCompleted, false);
      assert.equal(plan.releaseBlocked, true);
      assert.equal(plan.rollbackOnly, true);
      assert.equal(
        plan.sourceStateClassification,
        classification
      );
      assert.equal(
        plan.sourcePhaseOnePublicationState,
        phaseOnePublicationState
      );
      assert.equal(
        plan.sourceReturnPublicationState,
        returnPublicationState
      );
      assert.equal(
        plan.sourceSemanticChainCompleted,
        sourceSemanticChainCompleted
      );
      assert.equal(
        plan.verification.sourcePublishedManagerTransferCount,
        Number(phaseOnePublicationState === "published") +
          Number(returnPublicationState === "published")
      );
      assert.equal(
        Object.hasOwn(
          plan.verification,
          "sourceAcceptedManagerTransferPublicationCount"
        ),
        false
      );
      assert.equal(plan.activationHandoff.releaseBlocked, true);
      assert.equal(plan.activationHandoff.rollbackOnly, true);
      assert.equal(plan.authoritativeDatabaseMutationCount, 0);
      assert.equal(plan.durableFilesystemMutationCount, 0);
      assert.deepEqual(
        fs.readFileSync(state.contract.sourceDatabasePath),
        sourceBefore
      );
      assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
      assert.equal(
        fs.existsSync(temporaryWorkDirectoryFor(
          state.contract.targetDatabasePath
        )),
        false
      );
    });
  }
});

test("abort execute materializes the exact backup and replays with zero mutation", async (t) => {
  const state = await runtime(t, {
    sourceSnapshot: strictSourceSnapshots.prepared_only,
  });
  const sourceBefore = fs.readFileSync(state.contract.sourceDatabasePath);
  const plan = await planAbortReleaseQaStrictRestore(operationInput(state));
  const options = abortExecuteOptions(state.contract, plan);
  const first = await executeAbortReleaseQaStrictRestore(
    operationInput(state, { options })
  );
  assert.equal(first.code, ABORT_EXECUTE_CODE);
  assert.equal(first.replayed, false);
  assert.equal(first.smokeCompleted, false);
  assert.equal(first.hostedSmokeCompleted, false);
  assert.equal(first.sourceSemanticChainCompleted, false);
  assert.equal(first.releaseBlocked, true);
  assert.equal(first.rollbackOnly, true);
  assert.equal(first.sourceStateClassification, "prepared_only");
  assert.equal(first.authoritativeDatabaseMutationCount, 0);
  assert.equal(first.durableFilesystemMutationCount, 2);
  assert.equal(
    hashFile(state.contract.targetDatabasePath),
    state.contract.plaintextSha256
  );
  assert.deepEqual(
    fs.readFileSync(state.contract.sourceDatabasePath),
    sourceBefore
  );
  const receiptPath = receiptPathFor(state.contract.targetDatabasePath);
  const receiptBefore = fs.readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBefore.toString("utf8"));
  assert.equal(receipt.kind, ABORT_RECEIPT_KIND);
  assert.equal(receipt.restoreMode, ABORT_RESTORE_MODE);
  assert.equal(receipt.smokeCompleted, false);
  assert.equal(receipt.hostedSmokeCompleted, false);
  assert.equal(receipt.sourceSemanticChainCompleted, false);
  assert.equal(receipt.releaseBlocked, true);
  assert.equal(receipt.rollbackOnly, true);
  assert.equal(
    receipt.planPayload.sourceAbortEvidence.classification,
    "prepared_only"
  );

  let mutationAttemptCount = 0;
  const replayFs = Object.create(fs);
  for (const method of [
    "chmodSync",
    "copyFileSync",
    "fsyncSync",
    "linkSync",
    "mkdirSync",
    "openSync",
    "renameSync",
    "rmdirSync",
    "rmSync",
    "unlinkSync",
    "writeFileSync",
  ]) {
    replayFs[method] = () => {
      mutationAttemptCount += 1;
      throw new Error(`abort replay attempted ${method}`);
    };
  }
  const replay = await executeAbortReleaseQaStrictRestore(
    operationInput(state, {
      options,
      fsModule: replayFs,
      objectStorage: {
        async getPrivateObject() {
          throw new Error("abort replay attempted object download");
        },
        async headPrivateObject() {
          throw new Error("abort replay attempted object head");
        },
      },
      keyResolver: async () => {
        throw new Error("abort replay attempted key resolution");
      },
      restoreFunction: async () => {
        throw new Error("abort replay attempted restore");
      },
    })
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.authoritativeDatabaseMutationCount, 0);
  assert.equal(replay.durableFilesystemMutationCount, 0);
  assert.equal(replay.temporaryFilesystemWork.performed, false);
  assert.equal(mutationAttemptCount, 0);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBefore);
  assert.deepEqual(
    fs.readFileSync(state.contract.sourceDatabasePath),
    sourceBefore
  );

  const normalPlanId = `release-qa-strict-restore-v1-${"0".repeat(64)}`;
  const normalOptions = parseArguments([
    ...planArguments(state.contract),
    "--plan-id", normalPlanId,
    "--confirmation", confirmationFor({
      planId: normalPlanId,
      contract: state.contract,
    }),
  ], { execute: true });
  await assert.rejects(
    executeReleaseQaStrictRestore(operationInput(state, {
      options: normalOptions,
    })),
    { code: ERROR_CODES.targetConflict }
  );
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBefore);
});

test("abort execute recovers an exact receipt-only publication window", async (t) => {
  const state = await runtime(t, {
    sourceSnapshot: strictSourceSnapshots.to_b_pending,
  });
  const plan = await planAbortReleaseQaStrictRestore(operationInput(state));
  const options = abortExecuteOptions(state.contract, plan);
  const durableReceiptPath = receiptPathFor(
    state.contract.targetDatabasePath
  );
  const crashFs = Object.create(fs);
  crashFs.rmSync = (entryPath, optionsValue) => {
    if (entryPath === durableReceiptPath) return;
    return fs.rmSync(entryPath, optionsValue);
  };
  await assert.rejects(
    executeAbortReleaseQaStrictRestore(operationInput(state, {
      options,
      fsModule: crashFs,
      failureHook(stage) {
        if (stage === "after-receipt") {
          throw new Error("simulated process loss after receipt publication");
        }
      },
    })),
    { code: ERROR_CODES.failed }
  );
  assert.equal(fs.existsSync(durableReceiptPath), true);
  assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);

  const recovered = await executeAbortReleaseQaStrictRestore(
    operationInput(state, { options })
  );
  assert.equal(recovered.replayed, false);
  assert.equal(recovered.durableFilesystemMutationCount, 1);
  assert.equal(recovered.releaseBlocked, true);
  assert.equal(
    hashFile(state.contract.targetDatabasePath),
    state.contract.plaintextSha256
  );
});

test("abort rejects missing, wrong, unclassified, identity, and integrity sources", async (t) => {
  const cases = [
    {
      name: "missing fixture",
      sourceSnapshot: baseDatabasePath,
    },
    {
      name: "wrong receipt",
      sourceSnapshot: strictSourceSnapshots.prepared_only,
      mutate(database) {
        const triggerNames = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'trigger'
            AND tbl_name = 'security_audit_events'
        `).all().map(({ name }) => name);
        for (const name of triggerNames) {
          database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
        }
        database.prepare(`
          UPDATE security_audit_events
          SET reason_code = 'wrong_fixture_receipt'
          WHERE league_id = ? AND event_type = ?
        `).run(SIDE_CAR_IDS.leagueId, STRICT_FIXTURE_EVENT_TYPE);
      },
    },
    {
      name: "wrong league",
      sourceSnapshot: strictSourceSnapshots.prepared_only,
      mutate(database) {
        database.prepare(`
          UPDATE leagues SET name = 'Wrong strict fixture'
          WHERE id = ?
        `).run(SIDE_CAR_IDS.leagueId);
      },
    },
    {
      name: "unclassified assignment drift",
      sourceSnapshot: strictSourceSnapshots.prepared_only,
      mutate(database) {
        database.prepare(`
          UPDATE team_manager_assignments
          SET version = version + 1
          WHERE league_id = ? AND team_id = ?
        `).run(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[1]);
      },
    },
    {
      name: "unapproved publication retry drift",
      sourceSnapshot: strictSourceSnapshots.to_b_failed,
      mutate(database) {
        const triggerNames = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'trigger' AND tbl_name = 'outbox_events'
        `).all().map(({ name }) => name);
        for (const name of triggerNames) {
          database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
        }
        database.prepare(`
          UPDATE outbox_events
          SET attempt_count = 2, version = 5
          WHERE league_id = ?
            AND event_type = 'team.changed'
            AND aggregate_type = 'team_manager_assignment'
        `).run(SIDE_CAR_IDS.leagueId);
      },
    },
    {
      name: "extra publication audience drift",
      sourceSnapshot: strictSourceSnapshots.to_b_accepted_pending,
      mutate(database) {
        const triggerNames = database.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'trigger'
            AND tbl_name = 'outbox_event_audiences'
        `).all().map(({ name }) => name);
        for (const name of triggerNames) {
          database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
        }
        const event = database.prepare(`
          SELECT id, created_at_ms FROM outbox_events
          WHERE league_id = ?
            AND event_type = 'team.changed'
            AND aggregate_type = 'team_manager_assignment'
        `).get(SIDE_CAR_IDS.leagueId);
        database.prepare(`
          INSERT INTO outbox_event_audiences (
            id, league_id, outbox_event_id, audience_kind,
            team_id, user_id, created_at_ms
          ) VALUES (
            '00000000-0000-4000-8000-00000000a999', ?, ?,
            'user', NULL, ?, ?
          )
        `).run(
          SIDE_CAR_IDS.leagueId,
          event.id,
          fixtureId("account:leagueAManagerOne"),
          event.created_at_ms
        );
      },
    },
    ...[
      ["pending", strictSourceSnapshots.to_b_pending],
      ["accepted", strictSourceSnapshots.to_b_accepted_pending],
    ].flatMap(([label, sourceSnapshot]) => [
      {
        name: `${label} wrong idempotency key`,
        sourceSnapshot,
        mutate(database) {
          dropTableTriggers(database, "idempotency_requests");
          const assignmentId = firstTransferAssignmentId(database);
          database.prepare(`
            UPDATE idempotency_requests
            SET client_key = 'HL-20260822-1-wrong-transfer-key'
            WHERE league_id = ? AND result_id = ?
              AND operation = ?
          `).run(
            SIDE_CAR_IDS.leagueId,
            assignmentId,
            label === "accepted"
              ? "league.team_manager_assignment.accept.v1"
              : "league.team_manager_assignment.propose.v1"
          );
        },
      },
      {
        name: `${label} missing proposal notification`,
        sourceSnapshot,
        mutate(database) {
          dropTableTriggers(database, "notifications");
          database.prepare(`
            DELETE FROM notifications
            WHERE related_feature = 'team_manager_assignment'
              AND related_record_id = ?
          `).run(firstTransferAssignmentId(database));
        },
      },
      {
        name: `${label} extra proposal notification`,
        sourceSnapshot,
        mutate(database) {
          dropTableTriggers(database, "notifications");
          const assignmentId = firstTransferAssignmentId(database);
          database.prepare(`
            INSERT INTO notifications (
              id, user_id, league_id, event_type, message_data_json,
              related_feature, related_record_id, delivery_status,
              created_at_ms, read_at_ms, delivered_at_ms, version,
              deduplication_key
            )
            SELECT
              '00000000-0000-4000-8000-00000000a998',
              user_id, league_id, event_type, message_data_json,
              related_feature, related_record_id, delivery_status,
              created_at_ms, read_at_ms, delivered_at_ms, version,
              deduplication_key
            FROM notifications
            WHERE related_feature = 'team_manager_assignment'
              AND related_record_id = ?
          `).run(assignmentId);
        },
      },
    ]),
    {
      name: "database identity drift",
      sourceSnapshot: strictSourceSnapshots.prepared_only,
      mutate(database) {
        database.prepare(`
          UPDATE application_metadata
          SET metadata_value = 'wrong-release-qa-database'
          WHERE metadata_key = ?
        `).run(DATABASE_IDENTITY_KEYS.databaseId);
      },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (child) => {
      const state = await runtime(child, {
        sourceSnapshot: entry.sourceSnapshot,
      });
      if (entry.mutate) {
        const opened = openDatabase({
          databasePath: state.contract.sourceDatabasePath,
          environment: "test",
        });
        try {
          entry.mutate(opened.database);
        } finally {
          opened.database.close();
        }
      }
      await assert.rejects(
        planAbortReleaseQaStrictRestore(operationInput(state)),
        { code: ERROR_CODES.sourceInvalid }
      );
      assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
    });
  }

  await t.test("integrity failure", async (child) => {
    const state = await runtime(child, {
      sourceSnapshot: strictSourceSnapshots.prepared_only,
    });
    fs.writeFileSync(
      state.contract.sourceDatabasePath,
      Buffer.alloc(4_096, 0x7f)
    );
    await assert.rejects(
      planAbortReleaseQaStrictRestore(operationInput(state)),
      { code: ERROR_CODES.sourceInvalid }
    );
    assert.equal(fs.existsSync(state.contract.targetDatabasePath), false);
  });
});

test("normal completion rejects unpublished or audience-drifted manager events", async (t) => {
  for (const assignmentIndex of [0, 1]) {
    for (const publicationState of ["pending", "publishing", "failed"]) {
      await t.test(
        `assignment ${assignmentIndex + 1} ${publicationState}`,
        async (child) => {
          const state = await runtime(child);
          const opened = openDatabase({
            databasePath: state.contract.sourceDatabasePath,
            environment: "test",
          });
          try {
            const rows = opened.database.prepare(`
              SELECT id FROM outbox_events
              WHERE league_id = ?
                AND event_type = 'team.changed'
                AND aggregate_type = 'team_manager_assignment'
              ORDER BY created_at_ms, id
            `).all(SIDE_CAR_IDS.leagueId);
            const triggerNames = opened.database.prepare(`
              SELECT name FROM sqlite_schema
              WHERE type = 'trigger' AND tbl_name = 'outbox_events'
            `).all().map(({ name }) => name);
            for (const name of triggerNames) {
              opened.database.exec(
                `DROP TRIGGER "${name.replaceAll('"', '""')}"`
              );
            }
            const stateValues = {
              pending: [0, null, null, 1],
              publishing: [1, null, null, 2],
              failed: [1, null, "PUBLICATION_FAILED", 3],
            }[publicationState];
            opened.database.prepare(`
              UPDATE outbox_events
              SET status = ?, attempt_count = ?, published_at_ms = ?,
                  last_error_code = ?, version = ?
              WHERE id = ?
            `).run(
              publicationState,
              stateValues[0],
              stateValues[1],
              stateValues[2],
              stateValues[3],
              rows[assignmentIndex].id
            );
          } finally {
            opened.database.close();
          }
          await assert.rejects(
            planReleaseQaStrictRestore(operationInput(state)),
            { code: ERROR_CODES.sourceInvalid }
          );
        }
      );
    }
  }

  await t.test("published audience drift", async (child) => {
    const state = await runtime(child);
    const opened = openDatabase({
      databasePath: state.contract.sourceDatabasePath,
      environment: "test",
    });
    try {
      const event = opened.database.prepare(`
        SELECT id FROM outbox_events
        WHERE league_id = ?
          AND event_type = 'team.changed'
          AND aggregate_type = 'team_manager_assignment'
        ORDER BY created_at_ms, id
        LIMIT 1
      `).get(SIDE_CAR_IDS.leagueId);
      const triggerNames = opened.database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'trigger' AND tbl_name = 'outbox_event_audiences'
      `).all().map(({ name }) => name);
      for (const name of triggerNames) {
        opened.database.exec(
          `DROP TRIGGER "${name.replaceAll('"', '""')}"`
        );
      }
      opened.database.prepare(`
        UPDATE outbox_event_audiences
        SET created_at_ms = created_at_ms + 1
        WHERE league_id = ? AND outbox_event_id = ?
      `).run(SIDE_CAR_IDS.leagueId, event.id);
    } finally {
      opened.database.close();
    }
    await assert.rejects(
      planReleaseQaStrictRestore(operationInput(state)),
      { code: ERROR_CODES.sourceInvalid }
    );
  });
});

test("normal and abort plan namespaces and receipts cannot cross", async (t) => {
  const state = await runtime(t);
  const normalPlan = await planReleaseQaStrictRestore(operationInput(state));
  const normalOptions = executeOptions(state.contract, normalPlan);
  await assert.rejects(
    executeAbortReleaseQaStrictRestore(operationInput(state, {
      options: normalOptions,
    })),
    { code: ERROR_CODES.inputInvalid }
  );
  await executeReleaseQaStrictRestore(operationInput(state, {
    options: normalOptions,
  }));

  const abortPlanId =
    `release-qa-strict-restore-abort-v1-${"0".repeat(64)}`;
  const abortOptions = parseArguments([
    ...planArguments(state.contract),
    "--plan-id", abortPlanId,
    "--confirmation", abortConfirmationFor({
      planId: abortPlanId,
      contract: state.contract,
    }),
  ], { execute: true });
  await assert.rejects(
    executeAbortReleaseQaStrictRestore(operationInput(state, {
      options: abortOptions,
    })),
    { code: ERROR_CODES.targetConflict }
  );
  assert.equal(fs.existsSync(state.contract.targetDatabasePath), true);
});

test("abort command output is sanitized and uses its distinct mode", async (t) => {
  const state = await runtime(t, {
    sourceSnapshot: strictSourceSnapshots.return_to_a_published,
  });
  const lines = [];
  const result = await runReleaseQaStrictRestoreCommand({
    mode: "abort-plan",
    argv: planArguments(state.contract),
    env: state.env,
    output: { log(value) { lines.push(value); } },
    backupAccess: state.access,
    contract: state.contract,
  });
  assert.equal(result.code, ABORT_PLAN_CODE);
  assert.equal(result.smokeCompleted, false);
  assert.equal(result.sourceSemanticChainCompleted, true);
  assert.equal(result.releaseBlocked, true);
  assert.equal(lines.length, 1);
  for (const forbidden of [
    KEY.toString("base64url"),
    "test-secret",
    "password",
    "encryptionIv",
    "encryptionTag",
    "rowCounts",
  ]) {
    assert.equal(lines[0].includes(forbidden), false, forbidden);
  }
});
