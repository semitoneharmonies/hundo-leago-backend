const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const Database = require("better-sqlite3");

const {
  descriptorSha256,
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  parseArguments,
} = require("../../scripts/db-publish-reset-import-verification");
const {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES,
  parseArguments:
    parseResetOriginalLeagueBootstrapArguments,
  runResetOriginalLeagueBootstrapCommand,
} = require("../../scripts/bootstrap-reset-original-league");
const {
  RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS,
  RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES,
  configureResetMigrationReportBusyTimeout,
  parseArguments:
    parseResetMigrationReportArguments,
  runResetMigrationReportCommand,
} = require("../../scripts/db-commit-reset-migration-report");
const {
  RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX,
  RESET_IMPORT_ARTIFACT_ERROR_CODES,
  RESET_IMPORT_ARTIFACT_MANIFEST_FILE,
  RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
  RESET_IMPORT_ARTIFACT_VERSION,
  ResetImportVerificationArtifactError,
  isValidatedResetImportVerificationArtifact,
  publishResetImportVerificationArtifact,
  readResetImportVerificationArtifact,
} = require("../../src/infrastructure/migration/resetImportVerificationArtifact");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
  resetOriginalLeagueBootstrapRequestHash,
} = require("../../src/domain/leagues/resetOriginalLeagueBootstrapPolicy");
const {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES,
  createResetOriginalLeagueBootstrapService,
} = require("../../src/application/services/leagues/createResetOriginalLeagueBootstrapService");
const {
  RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES,
  createResetMigrationReportCommitService,
} = require("../../src/application/services/migration/createResetMigrationReportCommitService");
const {
  createActionTokenDeliveryEnvelope,
} = require("../../src/infrastructure/security/createActionTokenDeliveryEnvelope");
const {
  createOpaqueActionTokens,
} = require("../../src/infrastructure/security/createOpaqueActionTokens");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteLeagueCreationRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueCreationRepository");
const {
  createSqliteResetOriginalLeagueBootstrapRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteResetOriginalLeagueBootstrapRepository");
const {
  createSqliteSecurityAuditRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const {
  createSqliteMigrationReportRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMigrationReportRepository");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES,
  isVerifiedResetOriginalLeagueContinuity,
  verifyResetOriginalLeagueBootstrapContinuity,
} = require("../../src/infrastructure/migration/verifyResetOriginalLeagueBootstrapContinuity");
const {
  RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES,
  isVerifiedResetOriginalLeagueMigrationReportCommit,
  verifyResetOriginalLeagueMigrationReportCommit,
} = require("../../src/infrastructure/migration/verifyResetOriginalLeagueMigrationReportCommit");
const {
  verificationHash,
} = require("../../src/infrastructure/migration/verifyStagingImport");
const {
  canonicalize,
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");

const ROOT = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST_PATH = path.join(
  ROOT,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT,
  "database",
  "migrations"
);
const FIRST_ADMINISTRATOR_SCRIPT = path.join(
  ROOT,
  "scripts",
  "bootstrap-first-platform-administrator.js"
);
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT =
  path.join(
    ROOT,
    "scripts",
    "bootstrap-reset-original-league.js"
  );
const RESET_MIGRATION_REPORT_SCRIPT = path.join(
  ROOT,
  "scripts",
  "db-commit-reset-migration-report.js"
);
const DELIVERY_KEY = Buffer.alloc(32, 0x5a)
  .toString("base64url");
const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";

function syntheticLeagueState() {
  return {
    schemaVersion: 1,
    meta: { createdAt: "private-source-marker" },
    teams: [{
      name: "Private Team",
      roster: [{
        name: "Private Player",
        playerId: 1,
        salary: 6,
        position: "F",
        onIR: false,
      }],
      buyouts: [],
    }],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],
    matchups: {
      seasonId: "2025-2026",
      scheduleWeeks: [],
      currentWeekIndex: 0,
      currentWeekId: null,
      locksByTeam: {},
      baselineByPlayerId: {},
      baselineByWeekId: {},
      resultsByWeek: {},
      lastRolloverWeekId: null,
    },
    settings: {
      frozen: false,
      managerLoginHistory: [],
      managerLastLogin: {},
    },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
  };
}

function syntheticPlayers() {
  return [{
    id: 1,
    fullName: "Private Player",
    firstName: "Private",
    lastName: "Player",
    position: "F",
    teamAbbrev: "AAA",
    birthDate: "2000-01-01",
    active: true,
  }];
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function sha256Text(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function fixture(t, suffix) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `hundo-fad-04-staging-reset-artifact-${suffix}-`
    )
  );
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const inputs = path.join(root, "inputs");
  const sourceRoot = path.join(root, "sources");
  const databaseRoot = path.join(root, "database");
  const reportsRoot = path.join(root, "reports");
  const backupsRoot = path.join(root, "backups");
  for (const directory of [
    inputs,
    sourceRoot,
    databaseRoot,
    reportsRoot,
    backupsRoot,
  ]) {
    fs.mkdirSync(directory);
  }

  const leaguePath = path.join(
    inputs,
    "league-state.json"
  );
  const playersPath = path.join(
    inputs,
    "players.json"
  );
  fs.writeFileSync(
    leaguePath,
    JSON.stringify(syntheticLeagueState()),
    "utf8"
  );
  fs.writeFileSync(
    playersPath,
    JSON.stringify(syntheticPlayers()),
    "utf8"
  );
  const sourceBundleDirectory = path.join(
    sourceRoot,
    "bundle"
  );
  inventorySourceBundle({
    sources: [
      { label: "league_state", path: leaguePath },
      { label: "players", path: playersPath },
    ],
    outputDirectory: sourceBundleDirectory,
    capturedAtMs: 1_000,
  });

  const databasePath = path.join(
    databaseRoot,
    "league.sqlite3"
  );
  const reportDirectory = path.join(
    reportsRoot,
    "attempt"
  );
  const descriptor = {
    descriptorVersion: 1,
    environment: "staging",
    resourceIds: {
      service: `fad-04-staging-service-${suffix}`,
      disk: `fad-04-staging-disk-${suffix}`,
      database: `fad-04-staging-database-${suffix}`,
      sourceBundle: `fad-04-staging-source-${suffix}`,
      reports: `fad-04-staging-reports-${suffix}`,
      backups: `fad-04-staging-backups-${suffix}`,
    },
    paths: {
      persistentRoot: root,
      database: databasePath,
      sourceBundles: sourceRoot,
      reports: reportsRoot,
      backups: backupsRoot,
    },
    backupNamespace:
      `hundo-leago/staging/${suffix}`,
    secretScope: "staging",
    secretReferences: [
      "AUDIT_METADATA_SECRET",
      "BACKUP_ENCRYPTION_KEY",
      "RATE_LIMIT_KEY_SECRET",
    ],
    applicationAuthority: "json",
    sqliteApplicationAuthorityEnabled: false,
    productionStorageAccessible: false,
    productionSecretsAccessible: false,
  };
  const descriptorPath = path.join(
    root,
    "staging-descriptor.json"
  );
  fs.writeFileSync(
    descriptorPath,
    serializeStagingDescriptor(descriptor),
    "utf8"
  );
  runStagingImport({
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST_PATH,
    reportDirectory,
    operatingMode: "OFFSEASON_RESET",
  });
  const importReportPath = path.join(
    reportDirectory,
    "import-report.json"
  );
  return {
    root,
    reportsRoot,
    descriptor,
    options: {
      descriptorPath,
      sourceBundleDirectory,
      databasePath,
      resetManifestPath: RESET_MANIFEST_PATH,
      importReportPath,
      operatingMode: "OFFSEASON_RESET",
    },
  };
}

function artifactCode(code) {
  return (error) =>
    error instanceof
      ResetImportVerificationArtifactError &&
    error.code === code;
}

function collectStrings(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((child) =>
      collectStrings(child, result)
    );
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((child) =>
      collectStrings(child, result)
    );
  }
  return result;
}

function publicationEntries(reportRoot) {
  return fs
    .readdirSync(reportRoot)
    .filter(
      (name) =>
        name.startsWith(
          RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX
        ) ||
        name.includes(".building-") ||
        name.includes(".publish.lock")
    );
}

function readArtifact(runtime, artifactDirectory) {
  return readResetImportVerificationArtifact({
    ...runtime.options,
    artifactDirectory,
  });
}

function uuid(value) {
  return `10000000-0000-4000-8000-${String(
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

function bootstrapRequest(runtime, overrides = {}) {
  return {
    appEnvironment: "staging",
    artifact: runtime.artifact,
    bootstrapAdministratorIdentity:
      runtime.administratorIdentity,
    bootstrapUserId: runtime.userId,
    confirmation:
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
    databaseResourceId:
      runtime.artifact.binding.databaseResourceId,
    leagueName: "Original Hundo League",
    operatingMode: "OFFSEASON_RESET",
    sourceBundleId:
      runtime.artifact.binding.sourceBundleId,
    verificationHash:
      runtime.artifact.binding.verificationHash,
    ...overrides,
  };
}

function bootstrapCommandArguments(runtime) {
  return [
    "--app-env",
    "staging",
    "--confirm-app-env",
    "staging",
    "--database",
    runtime.staged.options.databasePath,
    "--migrations",
    MIGRATIONS_DIRECTORY,
    "--persistent-root",
    runtime.staged.root,
    "--descriptor",
    runtime.staged.options.descriptorPath,
    "--source-bundle",
    runtime.staged.options
      .sourceBundleDirectory,
    "--reset-manifest",
    runtime.staged.options.resetManifestPath,
    "--import-report",
    runtime.staged.options.importReportPath,
    "--artifact",
    runtime.artifactDirectory,
    "--operating-mode",
    "OFFSEASON_RESET",
    "--database-resource-id",
    runtime.artifact.binding.databaseResourceId,
    "--source-bundle-id",
    runtime.artifact.binding.sourceBundleId,
    "--verification-hash",
    runtime.artifact.binding.verificationHash,
    "--bootstrap-user-id",
    runtime.userId,
    "--confirmation",
    RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
  ];
}

function migrationReportCommandArguments(
  runtime,
  bootstrap
) {
  return [
    "--app-env",
    "staging",
    "--confirm-app-env",
    "staging",
    "--database",
    runtime.staged.options.databasePath,
    "--migrations",
    MIGRATIONS_DIRECTORY,
    "--persistent-root",
    runtime.staged.root,
    "--descriptor",
    runtime.staged.options.descriptorPath,
    "--source-bundle",
    runtime.staged.options
      .sourceBundleDirectory,
    "--reset-manifest",
    runtime.staged.options.resetManifestPath,
    "--import-report",
    runtime.staged.options.importReportPath,
    "--artifact",
    runtime.artifactDirectory,
    "--operating-mode",
    "OFFSEASON_RESET",
    "--database-resource-id",
    runtime.artifact.binding.databaseResourceId,
    "--source-bundle-id",
    runtime.artifact.binding.sourceBundleId,
    "--verification-hash",
    runtime.artifact.binding.verificationHash,
    "--bootstrap-user-id",
    runtime.userId,
    "--league-id",
    bootstrap.leagueId,
    "--season-id",
    bootstrap.seasonId,
    "--confirmation",
    RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION,
  ];
}

function bootstrapCommandEnvironment(
  runtime,
  overrides = {}
) {
  return {
    ...process.env,
    ACTION_TOKEN_DELIVERY_KEY: DELIVERY_KEY,
    BOOTSTRAP_ADMIN_DISPLAY_NAME:
      runtime.administratorIdentity.displayName,
    BOOTSTRAP_ADMIN_EMAIL:
      runtime.administratorIdentity.email,
    BOOTSTRAP_RESET_LEAGUE_NAME:
      "Original Hundo League",
    PUBLIC_FRONTEND_ORIGIN:
      PUBLIC_FRONTEND_ORIGIN,
    ...overrides,
  };
}

function continuityOptions(
  runtime,
  bootstrapResult,
  overrides = {}
) {
  return {
    appEnvironment: "staging",
    artifactDirectory:
      runtime.artifactDirectory,
    bootstrapAdministratorIdentity:
      runtime.administratorIdentity,
    bootstrapUserId: runtime.userId,
    database: runtime.database,
    databasePath:
      runtime.staged.options.databasePath,
    databaseResourceId:
      runtime.artifact.binding.databaseResourceId,
    descriptorPath:
      runtime.staged.options.descriptorPath,
    encodedDeliveryKey: DELIVERY_KEY,
    importReportPath:
      runtime.staged.options.importReportPath,
    leagueId: bootstrapResult.leagueId,
    leagueName: "Original Hundo League",
    migrationsDirectory:
      MIGRATIONS_DIRECTORY,
    operatingMode: "OFFSEASON_RESET",
    publicFrontendOrigin:
      PUBLIC_FRONTEND_ORIGIN,
    resetManifestPath:
      runtime.staged.options.resetManifestPath,
    seasonId: bootstrapResult.seasonId,
    sourceBundleDirectory:
      runtime.staged.options
        .sourceBundleDirectory,
    sourceBundleId:
      runtime.artifact.binding.sourceBundleId,
    verificationHash:
      runtime.artifact.binding.verificationHash,
    ...overrides,
  };
}

function wrapAfter(repository, method, seam) {
  if (seam !== method) {
    return repository;
  }
  return Object.freeze({
    ...repository,
    [method](...args) {
      const result = repository[method](...args);
      throw new Error(`synthetic ${method} failure`);
    },
  });
}

function createBootstrapService(runtime, seam = null) {
  const clockState = { calls: 0 };
  const randomState = { calls: 0 };
  const clock = {
    nowMs() {
      clockState.calls += 1;
      return runtime.bootstrapAtMs;
    },
  };
  const secureRandom = {
    id() {
      randomState.calls += 1;
      return uuid(200 + randomState.calls);
    },
  };
  let bootstrapRepository =
    runtime.bootstrapRepository;
  let leagueCreationRepository =
    runtime.leagueCreationRepository;
  let auditRepository = runtime.auditRepository;
  if (
    seam === "assertCompletedBootstrapState"
  ) {
    bootstrapRepository = wrapAfter(
      bootstrapRepository,
      "assertCompletedBootstrapState",
      seam
    );
  } else if (seam === "appendAudit") {
    auditRepository = wrapAfter(
      auditRepository,
      "append",
      "append"
    );
  } else if (seam !== null) {
    leagueCreationRepository = wrapAfter(
      leagueCreationRepository,
      seam,
      seam
    );
  }
  return {
    clockState,
    randomState,
    service:
      createResetOriginalLeagueBootstrapService({
        repositoryContext: runtime.context,
        bootstrapRepository,
        leagueCreationRepository,
        auditRepository,
        authenticateDelivery,
        clock,
        secureRandom,
      }),
  };
}

function createMigrationReportCommitService(
  runtime,
  {
    bootstrap,
    repository =
      createSqliteMigrationReportRepository({
        database: runtime.database,
      }),
    nowMs = runtime.bootstrapAtMs + 10,
    reportId = uuid(990),
    verifyContinuity,
  } = {}
) {
  const calls = {
    clock: 0,
    random: 0,
    verification: 0,
  };
  const continuities = [];
  const trustedVerifyContinuity =
    verifyContinuity ||
    (() => {
      const continuity =
        verifyResetOriginalLeagueBootstrapContinuity(
          continuityOptions(runtime, bootstrap)
        );
      continuities.push(continuity);
      return continuity;
    });
  return {
    calls,
    continuities,
    nowMs,
    reportId,
    service:
      createResetMigrationReportCommitService({
        database: runtime.database,
        repositoryContext: runtime.context,
        migrationReportRepository:
          repository,
        verifyContinuity() {
          calls.verification += 1;
          return trustedVerifyContinuity();
        },
        clock: {
          nowMs() {
            calls.clock += 1;
            return nowMs;
          },
        },
        secureRandom: {
          id() {
            calls.random += 1;
            return reportId;
          },
        },
      }),
  };
}

function withBootstrapServiceRuntime(
  t,
  suffix,
  callback
) {
  const staged = fixture(t, suffix);
  const published =
    publishResetImportVerificationArtifact(
      staged.options
    );
  const administratorIdentity = Object.freeze({
    displayName:
      "Reset Bootstrap Administrator",
    email: `reset.${suffix}@example.test`,
  });
  const administrator = spawnSync(
    process.execPath,
    [
      FIRST_ADMINISTRATOR_SCRIPT,
      "--app-env",
      "staging",
      "--confirm-app-env",
      "staging",
      "--database",
      staged.options.databasePath,
      "--migrations",
      MIGRATIONS_DIRECTORY,
      "--persistent-root",
      staged.root,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ACTION_TOKEN_DELIVERY_KEY:
          DELIVERY_KEY,
        BOOTSTRAP_ADMIN_DISPLAY_NAME:
          administratorIdentity.displayName,
        BOOTSTRAP_ADMIN_EMAIL:
          administratorIdentity.email,
        PUBLIC_FRONTEND_ORIGIN:
          PUBLIC_FRONTEND_ORIGIN,
      },
      encoding: "utf8",
    }
  );
  assert.equal(
    administrator.status,
    0,
    administrator.stderr
  );
  const summary = JSON.parse(
    administrator.stdout
  );
  const artifact = readArtifact(
    staged,
    published.artifactDirectory
  );
  const connection = openDatabase({
    databasePath: staged.options.databasePath,
    environment: "staging",
    persistentRoot: staged.root,
    requirePersistentRoot: true,
  });
  try {
    const database = connection.database;
    const runtime = {
      administratorIdentity,
      artifact,
      artifactDirectory:
        published.artifactDirectory,
      auditRepository:
        createSqliteSecurityAuditRepository({
          database,
        }),
      bootstrapAtMs:
        database
          .prepare(
            "SELECT created_at_ms " +
              "FROM account_action_tokens"
          )
          .get().created_at_ms + 1,
      bootstrapRepository:
        createSqliteResetOriginalLeagueBootstrapRepository({
          database,
        }),
      context: createSqliteRepositoryContext({
        database,
      }),
      database,
      leagueCreationRepository:
        createSqliteLeagueCreationRepository({
          database,
        }),
      staged,
      userId: summary.userId,
    };
    return callback(runtime);
  } finally {
    if (connection.database.open) {
      connection.database.close();
    }
  }
}

describe("FAD-04 pristine reset verification artifact", () => {
  test("publishes one canonical private artifact and exact replay is read-only", (t) => {
    const runtime = fixture(t, "publish");
    const databaseHashBefore = sha256File(
      runtime.options.databasePath
    );
    const reportHashBefore = sha256File(
      runtime.options.importReportPath
    );
    const sourceManifestPath = path.join(
      runtime.options.sourceBundleDirectory,
      "source-bundle.json"
    );
    const sourceHashBefore = sha256File(
      sourceManifestPath
    );

    const created =
      publishResetImportVerificationArtifact(
        runtime.options
      );
    assert.equal(created.status, "published");
    assert.equal(created.replayed, false);
    assert.equal(
      created.artifactVersion,
      RESET_IMPORT_ARTIFACT_VERSION
    );
    assert.equal(
      path.basename(created.artifactDirectory),
      `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${created.verificationHash}`
    );
    assert.deepEqual(
      fs.readdirSync(created.artifactDirectory).sort(),
      [
        RESET_IMPORT_ARTIFACT_MANIFEST_FILE,
        RESET_IMPORT_ARTIFACT_PAYLOAD_FILE,
      ].sort()
    );

    const payloadPath = path.join(
      created.artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    const manifestPath = path.join(
      created.artifactDirectory,
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE
    );
    const payloadRaw = fs.readFileSync(
      payloadPath,
      "utf8"
    );
    const manifestRaw = fs.readFileSync(
      manifestPath,
      "utf8"
    );
    const payload = JSON.parse(payloadRaw);
    const manifest = JSON.parse(manifestRaw);
    const read = readArtifact(
      runtime,
      created.artifactDirectory
    );
    assert.equal(
      isValidatedResetImportVerificationArtifact(
        read
      ),
      true
    );
    assert.equal(
      isValidatedResetImportVerificationArtifact({
        ...read,
      }),
      false
    );
    assert.deepEqual(read.payload, payload);
    assert.deepEqual(read.manifest, manifest);
    assert.equal(
      read.binding.verificationHash,
      created.verificationHash
    );
    assert.equal(
      read.migrationReportProjection.status,
      "succeeded"
    );
    assert.match(
      read.payload.continuityBaseline
        .migrationLedgerSha256,
      /^[a-f0-9]{64}$/
    );
    assert.deepEqual(
      Object.keys(
        read.payload.continuityBaseline
          .protectedTableHashes
      ).sort(),
      [
        "application_metadata",
        "player_external_ids",
        "player_source_state",
        "players",
      ]
    );
    assert.equal(Object.isFrozen(read), true);
    assert.equal(Object.isFrozen(read.payload), true);
    assert.equal(
      Object.isFrozen(
        read.payload.verification.database.targetTables
      ),
      true
    );
    assert.equal(
      payloadRaw,
      `${canonicalize(payload)}\n`
    );
    assert.equal(
      manifestRaw,
      `${canonicalize(manifest)}\n`
    );
    assert.equal(
      manifest.evidenceBytes,
      Buffer.byteLength(payloadRaw, "utf8")
    );
    assert.equal(
      manifest.evidenceSha256,
      sha256Text(payloadRaw)
    );
    assert.equal(
      manifest.verificationHash,
      manifest.evidenceSha256
    );
    assert.equal(
      manifest.importVerificationHash,
      payload.verification.verificationHash
    );
    assert.equal(
      manifest.stagingDescriptorSha256,
      descriptorSha256(runtime.descriptor)
    );
    assert.equal(
      manifest.databaseResourceId,
      runtime.descriptor.resourceIds.database
    );
    assert.deepEqual(
      payload.stagingDescriptor.resourceIds,
      runtime.descriptor.resourceIds
    );
    assert.equal(
      payload.stagingDescriptor
        .productionStorageAccessible,
      false
    );
    assert.equal(
      payload.stagingDescriptor
        .productionSecretsAccessible,
      false
    );
    assert.deepEqual(
      payload.sourceBundle.sourceFiles.map(
        ({ sourceLabel, copiedPath }) => ({
          sourceLabel,
          copiedPath,
        })
      ),
      [
        {
          sourceLabel: "league_state",
          copiedPath:
            "files/league_state/league-state.json",
        },
        {
          sourceLabel: "players",
          copiedPath: "files/players/players.json",
        },
      ]
    );
    const artifactStrings = collectStrings({
      payload,
      manifest,
    });
    assert.equal(
      artifactStrings.some(
        (value) =>
          value.includes(runtime.root) ||
          value.includes(
            runtime.options.resetManifestPath
          ) ||
          runtime.descriptor.secretReferences.includes(
            value
          ) ||
          value.includes("Private Player") ||
          value.includes("Private Team") ||
          value.includes("private-source-marker")
      ),
      false
    );

    assert.equal(
      sha256File(runtime.options.databasePath),
      databaseHashBefore
    );
    assert.equal(
      sha256File(runtime.options.importReportPath),
      reportHashBefore
    );
    assert.equal(
      sha256File(sourceManifestPath),
      sourceHashBefore
    );

    const beforeReplay = {
      payload: sha256File(payloadPath),
      manifest: sha256File(manifestPath),
      entries: fs.readdirSync(runtime.reportsRoot).sort(),
    };
    const replay =
      publishResetImportVerificationArtifact(
        runtime.options
      );
    assert.equal(replay.replayed, true);
    assert.equal(
      replay.artifactDirectory,
      created.artifactDirectory
    );
    assert.deepEqual(
      {
        payload: sha256File(payloadPath),
        manifest: sha256File(manifestPath),
        entries: fs.readdirSync(runtime.reportsRoot).sort(),
      },
      beforeReplay
    );
  });

  test("rejects a conflicting existing artifact without overwriting it", (t) => {
    const runtime = fixture(t, "conflict");
    const created =
      publishResetImportVerificationArtifact(
        runtime.options
      );
    const payloadPath = path.join(
      created.artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    fs.writeFileSync(
      payloadPath,
      '{"tampered":true}\n',
      "utf8"
    );
    const tampered = fs.readFileSync(payloadPath, "utf8");

    assert.throws(
      () =>
        readArtifact(
          runtime,
          created.artifactDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );
    assert.throws(
      () =>
        publishResetImportVerificationArtifact(
          runtime.options
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .artifactConflict
      )
    );
    assert.equal(
      fs.readFileSync(payloadPath, "utf8"),
      tampered
    );
  });

  test("content address rejects a forged continuity baseline even with a recomputed manifest digest", (t) => {
    const runtime = fixture(
      t,
      "baseline-forgery"
    );
    const created =
      publishResetImportVerificationArtifact(
        runtime.options
      );
    const payloadPath = path.join(
      created.artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    const manifestPath = path.join(
      created.artifactDirectory,
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE
    );
    const payload = JSON.parse(
      fs.readFileSync(payloadPath, "utf8")
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8")
    );
    payload.continuityBaseline
      .migrationLedgerSha256 =
        payload.continuityBaseline
          .migrationLedgerSha256 ===
        "a".repeat(64)
          ? "b".repeat(64)
          : "a".repeat(64);
    const payloadRaw =
      `${canonicalize(payload)}\n`;
    manifest.evidenceBytes =
      Buffer.byteLength(payloadRaw, "utf8");
    manifest.evidenceSha256 =
      sha256Text(payloadRaw);
    fs.writeFileSync(
      payloadPath,
      payloadRaw,
      "utf8"
    );
    fs.writeFileSync(
      manifestPath,
      `${canonicalize(manifest)}\n`,
      "utf8"
    );

    assert.throws(
      () =>
        readArtifact(
          runtime,
          created.artifactDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );
    assert.notEqual(
      manifest.evidenceSha256,
      created.verificationHash
    );
  });

  test("reader rejects extra files and a false content-addressed directory name", (t) => {
    const extraRuntime = fixture(t, "reader-extra");
    const extra =
      publishResetImportVerificationArtifact(
        extraRuntime.options
      );
    fs.writeFileSync(
      path.join(extra.artifactDirectory, "unexpected"),
      "unexpected",
      "utf8"
    );
    assert.throws(
      () =>
        readArtifact(
          extraRuntime,
          extra.artifactDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );

    const nameRuntime = fixture(t, "reader-name");
    const named =
      publishResetImportVerificationArtifact(
        nameRuntime.options
      );
    const falseHash =
      `${
        named.verificationHash.startsWith("a")
          ? "b"
          : "a"
      }${named.verificationHash.slice(1)}`;
    const falseDirectory = path.join(
      nameRuntime.reportsRoot,
      `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${falseHash}`
    );
    fs.renameSync(
      named.artifactDirectory,
      falseDirectory
    );
    assert.throws(
      () =>
        readArtifact(
          nameRuntime,
          falseDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );
  });

  test("reader rejects forged verifier facts, copied-source drift, and an artifact outside the report root", (t) => {
    const forgedRuntime = fixture(
      t,
      "reader-forged"
    );
    const forged =
      publishResetImportVerificationArtifact(
        forgedRuntime.options
      );
    const forgedPayloadPath = path.join(
      forged.artifactDirectory,
      RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
    );
    const forgedManifestPath = path.join(
      forged.artifactDirectory,
      RESET_IMPORT_ARTIFACT_MANIFEST_FILE
    );
    const forgedPayload = JSON.parse(
      fs.readFileSync(forgedPayloadPath, "utf8")
    );
    const forgedManifest = JSON.parse(
      fs.readFileSync(forgedManifestPath, "utf8")
    );
    forgedPayload.verification.checks.integrity =
      "forged";
    forgedPayload.verification.verificationHash =
      verificationHash(forgedPayload.verification);
    const forgedPayloadRaw =
      `${canonicalize(forgedPayload)}\n`;
    forgedManifest.evidenceBytes =
      Buffer.byteLength(forgedPayloadRaw, "utf8");
    forgedManifest.evidenceSha256 =
      sha256Text(forgedPayloadRaw);
    forgedManifest.verificationHash =
      forgedPayload.verification.verificationHash;
    fs.writeFileSync(
      forgedPayloadPath,
      forgedPayloadRaw,
      "utf8"
    );
    fs.writeFileSync(
      forgedManifestPath,
      `${canonicalize(forgedManifest)}\n`,
      "utf8"
    );
    const forgedDirectory = path.join(
      forgedRuntime.reportsRoot,
      `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${forgedManifest.verificationHash}`
    );
    fs.renameSync(
      forged.artifactDirectory,
      forgedDirectory
    );
    assert.throws(
      () =>
        readArtifact(
          forgedRuntime,
          forgedDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );

    const sourceRuntime = fixture(
      t,
      "reader-source"
    );
    const source =
      publishResetImportVerificationArtifact(
        sourceRuntime.options
      );
    const sourcePayload = JSON.parse(
      fs.readFileSync(
        path.join(
          source.artifactDirectory,
          RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
        ),
        "utf8"
      )
    );
    fs.appendFileSync(
      path.join(
        sourceRuntime.options
          .sourceBundleDirectory,
        sourcePayload.sourceBundle
          .sourceFiles[0].copiedPath
      ),
      "drift",
      "utf8"
    );
    assert.throws(
      () =>
        readArtifact(
          sourceRuntime,
          source.artifactDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );

    const outsideRuntime = fixture(
      t,
      "reader-outside"
    );
    const outside =
      publishResetImportVerificationArtifact(
        outsideRuntime.options
      );
    const outsideDirectory = path.join(
      outsideRuntime.root,
      path.basename(outside.artifactDirectory)
    );
    fs.cpSync(
      outside.artifactDirectory,
      outsideDirectory,
      { recursive: true }
    );
    assert.throws(
      () =>
        readArtifact(
          outsideRuntime,
          outsideDirectory
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );
  });

  test("a late publication failure leaves no final or partial artifact", (t) => {
    const runtime = fixture(t, "rollback");
    const failingFs = Object.create(fs);
    failingFs.writeFileSync = (
      filePath,
      value,
      options
    ) => {
      if (
        path.basename(filePath) ===
        RESET_IMPORT_ARTIFACT_MANIFEST_FILE
      ) {
        throw new Error("synthetic manifest write failure");
      }
      return fs.writeFileSync(filePath, value, options);
    };

    assert.throws(
      () =>
        publishResetImportVerificationArtifact({
          ...runtime.options,
          fsModule: failingFs,
        }),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed
      )
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      []
    );
  });

  test("an exclusive-lock race never replaces a nonexact final directory", (t) => {
    const runtime = fixture(t, "race");
    let racedArtifactDirectory = null;
    const racingFs = Object.create(fs);
    racingFs.openSync = (filePath, flags, mode) => {
      if (filePath.endsWith(".publish.lock")) {
        const lockName = path.basename(filePath);
        const artifactName = lockName
          .slice(1)
          .replace(/\.publish\.lock$/, "");
        racedArtifactDirectory = path.join(
          path.dirname(filePath),
          artifactName
        );
        fs.mkdirSync(racedArtifactDirectory);
        const error = new Error(
          "synthetic competing publisher"
        );
        error.code = "EEXIST";
        throw error;
      }
      return fs.openSync(filePath, flags, mode);
    };

    assert.throws(
      () =>
        publishResetImportVerificationArtifact({
          ...runtime.options,
          fsModule: racingFs,
        }),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .artifactConflict
      )
    );
    assert.ok(racedArtifactDirectory);
    assert.deepEqual(
      fs.readdirSync(racedArtifactDirectory),
      []
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      [path.basename(racedArtifactDirectory)]
    );
  });

  test("an active publication lock is preserved while the owned temporary directory is removed", (t) => {
    const runtime = fixture(t, "held-lock");
    let foreignLockPath = null;
    let foreignLockRaw = null;
    const lockedFs = Object.create(fs);
    lockedFs.openSync = (filePath, flags, mode) => {
      if (filePath.endsWith(".publish.lock")) {
        foreignLockPath = filePath;
        const lockName = path.basename(filePath);
        const verificationHash = lockName.slice(
          `.${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}`
            .length,
          -".publish.lock".length
        );
        const activeAtMs =
          Date.now() - 10 * 60 * 1000;
        foreignLockRaw =
          `${canonicalize({
            createdAtMs: activeAtMs,
            hostname:
              os.hostname().trim().toLowerCase(),
            lockVersion: 1,
            nonce: crypto.randomUUID(),
            processId: process.pid,
            verificationHash,
          })}\n`;
        fs.writeFileSync(
          foreignLockPath,
          foreignLockRaw,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          }
        );
        const activeAt = new Date(activeAtMs);
        fs.utimesSync(
          foreignLockPath,
          activeAt,
          activeAt
        );
        const error = new Error(
          "synthetic held publication lock"
        );
        error.code = "EEXIST";
        throw error;
      }
      return fs.openSync(filePath, flags, mode);
    };

    assert.throws(
      () =>
        publishResetImportVerificationArtifact({
          ...runtime.options,
          fsModule: lockedFs,
        }),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed
      )
    );
    assert.ok(foreignLockPath);
    assert.equal(
      fs.readFileSync(foreignLockPath, "utf8"),
      foreignLockRaw
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      [path.basename(foreignLockPath)]
    );
  });

  test("an expired publication lock is quarantined and recovered without leftovers", (t) => {
    const runtime = fixture(t, "stale-lock");
    let staleLockPath = null;
    let injected = false;
    const staleFs = Object.create(fs);
    staleFs.openSync = (filePath, flags, mode) => {
      if (
        filePath.endsWith(".publish.lock") &&
        !injected
      ) {
        injected = true;
        staleLockPath = filePath;
        const lockName = path.basename(filePath);
        const verificationHash = lockName.slice(
          `.${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}`
            .length,
          -".publish.lock".length
        );
        const staleAtMs =
          Date.now() - 10 * 60 * 1000;
        fs.writeFileSync(
          staleLockPath,
          `${canonicalize({
            createdAtMs: staleAtMs,
            hostname:
              os.hostname().trim().toLowerCase(),
            lockVersion: 1,
            nonce: crypto.randomUUID(),
            processId: 2147483647,
            verificationHash,
          })}\n`,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          }
        );
        const staleAt = new Date(staleAtMs);
        fs.utimesSync(
          staleLockPath,
          staleAt,
          staleAt
        );
        const error = new Error(
          "synthetic abandoned publication lock"
        );
        error.code = "EEXIST";
        throw error;
      }
      return fs.openSync(filePath, flags, mode);
    };

    const created =
      publishResetImportVerificationArtifact({
        ...runtime.options,
        fsModule: staleFs,
      });
    assert.equal(created.replayed, false);
    assert.ok(staleLockPath);
    assert.equal(
      isValidatedResetImportVerificationArtifact(
        readArtifact(
          runtime,
          created.artifactDirectory
        )
      ),
      true
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      [path.basename(created.artifactDirectory)]
    );
  });

  test("a delayed owner never removes a replacement publication lock", (t) => {
    const runtime = fixture(t, "replacement-lock");
    let ownedLockPath = null;
    let retiredLockPath = null;
    let replacementRaw = null;
    let thirdOwnerRaw = null;
    let swapped = false;
    let thirdOwnerInserted = false;
    const swappingFs = Object.create(fs);
    swappingFs.openSync = (
      filePath,
      flags,
      mode
    ) => {
      const descriptor = fs.openSync(
        filePath,
        flags,
        mode
      );
      if (filePath.endsWith(".publish.lock")) {
        ownedLockPath = filePath;
      }
      return descriptor;
    };
    swappingFs.closeSync = (descriptor) => {
      fs.closeSync(descriptor);
    };
    swappingFs.renameSync = (
      sourcePath,
      destinationPath
    ) => {
      if (
        sourcePath === ownedLockPath &&
        destinationPath.includes(
          ".publish.lock.release-"
        ) &&
        !swapped
      ) {
        swapped = true;
        const original = JSON.parse(
          fs.readFileSync(
            ownedLockPath,
            "utf8"
          )
        );
        retiredLockPath =
          `${ownedLockPath}.retired`;
        fs.renameSync(
          ownedLockPath,
          retiredLockPath
        );
        replacementRaw =
          `${canonicalize({
            ...original,
            createdAtMs: Date.now(),
            nonce: crypto.randomUUID(),
          })}\n`;
        fs.writeFileSync(
          ownedLockPath,
          replacementRaw,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          }
        );
      }
      return fs.renameSync(
        sourcePath,
        destinationPath
      );
    };
    swappingFs.linkSync = (
      existingPath,
      newPath
    ) => {
      if (
        existingPath.includes(
          ".publish.lock.release-"
        ) &&
        newPath === ownedLockPath &&
        !thirdOwnerInserted
      ) {
        thirdOwnerInserted = true;
        const replacement = JSON.parse(
          replacementRaw
        );
        thirdOwnerRaw =
          `${canonicalize({
            ...replacement,
            createdAtMs: Date.now(),
            nonce: crypto.randomUUID(),
          })}\n`;
        fs.writeFileSync(
          ownedLockPath,
          thirdOwnerRaw,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          }
        );
      }
      return fs.linkSync(existingPath, newPath);
    };

    const created =
      publishResetImportVerificationArtifact({
        ...runtime.options,
        fsModule: swappingFs,
      });
    assert.equal(created.replayed, false);
    assert.equal(swapped, true);
    assert.equal(thirdOwnerInserted, true);
    assert.equal(
      fs.readFileSync(ownedLockPath, "utf8"),
      thirdOwnerRaw
    );
    const releaseQuarantinePath = fs
      .readdirSync(runtime.reportsRoot)
      .map((name) =>
        path.join(runtime.reportsRoot, name)
      )
      .find((entry) =>
        entry.includes(".publish.lock.release-")
      );
    assert.ok(releaseQuarantinePath);
    assert.equal(
      fs.readFileSync(
        releaseQuarantinePath,
        "utf8"
      ),
      replacementRaw
    );
    assert.equal(
      isValidatedResetImportVerificationArtifact(
        readArtifact(
          runtime,
          created.artifactDirectory
        )
      ),
      true
    );

    fs.unlinkSync(ownedLockPath);
    fs.unlinkSync(retiredLockPath);
    fs.unlinkSync(releaseQuarantinePath);
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      [path.basename(created.artifactDirectory)]
    );
  });

  test("tampered pristine inputs fail verification before publication", (t) => {
    const runtime = fixture(t, "tamper");
    fs.appendFileSync(
      runtime.options.importReportPath,
      "\n",
      "utf8"
    );

    assert.throws(
      () =>
        publishResetImportVerificationArtifact(
          runtime.options
        ),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .verificationFailed
      )
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      []
    );
  });

  test("post-rename read-back rejects and removes a corrupt owned final artifact", (t) => {
    const runtime = fixture(t, "readback");
    let finalDirectory = null;
    const corruptingFs = Object.create(fs);
    corruptingFs.renameSync = (
      sourcePath,
      targetPath
    ) => {
      fs.renameSync(sourcePath, targetPath);
      if (
        path.basename(targetPath).startsWith(
          RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX
        )
      ) {
        finalDirectory = targetPath;
        fs.writeFileSync(
          path.join(
            targetPath,
            RESET_IMPORT_ARTIFACT_PAYLOAD_FILE
          ),
          '{"corrupt":true}\n',
          "utf8"
        );
      }
    };

    assert.throws(
      () =>
        publishResetImportVerificationArtifact({
          ...runtime.options,
          fsModule: corruptingFs,
        }),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .publicationFailed
      )
    );
    assert.ok(finalDirectory);
    assert.equal(
      fs.existsSync(finalDirectory),
      false
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      []
    );
  });

  test("CLI publishes and replays with exact content-free summary output", (t) => {
    const runtime = fixture(t, "cli");
    const args = [
      "--descriptor",
      runtime.options.descriptorPath,
      "--source-bundle",
      runtime.options.sourceBundleDirectory,
      "--database",
      runtime.options.databasePath,
      "--reset-manifest",
      runtime.options.resetManifestPath,
      "--import-report",
      runtime.options.importReportPath,
      "--operating-mode",
      runtime.options.operatingMode,
    ];
    assert.deepEqual(
      parseArguments(args),
      runtime.options
    );
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "package.json"),
        "utf8"
      )
    );
    assert.equal(
      packageJson.scripts[
        "db:publish-reset-import-verification"
      ],
      "node scripts/db-publish-reset-import-verification.js"
    );

    const commandPath = path.join(
      ROOT,
      "scripts",
      "db-publish-reset-import-verification.js"
    );
    const first = spawnSync(
      process.execPath,
      [commandPath, ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
      }
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    const created = JSON.parse(first.stdout);
    assert.deepEqual(
      Object.keys(created).sort(),
      [
        "artifactVersion",
        "databaseResourceId",
        "evidenceBytes",
        "evidenceSha256",
        "replayed",
        "sourceBundleId",
        "stagingDescriptorSha256",
        "status",
        "verificationHash",
      ].sort()
    );
    assert.equal(created.status, "published");
    assert.equal(created.replayed, false);
    const outputRaw = JSON.stringify(created);
    assert.equal(
      [
        runtime.root,
        runtime.options.resetManifestPath,
        ...runtime.descriptor.secretReferences,
      ].some((privateValue) =>
        outputRaw.includes(privateValue)
      ),
      false
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      [
        `${RESET_IMPORT_ARTIFACT_DIRECTORY_PREFIX}${created.verificationHash}`,
      ]
    );

    const replay = spawnSync(
      process.execPath,
      [commandPath, ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
      }
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(
      JSON.parse(replay.stdout),
      {
        ...created,
        replayed: true,
      }
    );
  });

  test("CLI rejects incomplete arguments with a generic safe error", () => {
    assert.throws(
      () => parseArguments([]),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .argumentInvalid
      )
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          ROOT,
          "scripts",
          "db-publish-reset-import-verification.js"
        ),
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
      }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(
      JSON.parse(result.stderr),
      {
        error: {
          code:
            RESET_IMPORT_ARTIFACT_ERROR_CODES
              .argumentInvalid,
          message:
            "Reset import verification artifact publication failed safely.",
        },
      }
    );
  });

  test("CLI rejects unknown, duplicate, and wrong-mode inputs", (t) => {
    assert.throws(
      () =>
        parseArguments([
          "--unknown",
          "value",
        ]),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .argumentInvalid
      )
    );
    assert.throws(
      () =>
        parseArguments([
          "--descriptor",
          "first",
          "--descriptor",
          "second",
        ]),
      artifactCode(
        RESET_IMPORT_ARTIFACT_ERROR_CODES
          .argumentInvalid
      )
    );

    const runtime = fixture(t, "cli-mode");
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          ROOT,
          "scripts",
          "db-publish-reset-import-verification.js"
        ),
        "--descriptor",
        runtime.options.descriptorPath,
        "--source-bundle",
        runtime.options.sourceBundleDirectory,
        "--database",
        runtime.options.databasePath,
        "--reset-manifest",
        runtime.options.resetManifestPath,
        "--import-report",
        runtime.options.importReportPath,
        "--operating-mode",
        "ACTIVE",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
      }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      JSON.parse(result.stderr).error.code,
      RESET_IMPORT_ARTIFACT_ERROR_CODES
        .argumentInvalid
    );
    assert.deepEqual(
      publicationEntries(runtime.reportsRoot),
      []
    );
  });
});

describe("FAD-04 reset original-league bootstrap service", () => {
  test("hashes the exact canonical artifact and operator binding", () => {
    const binding = {
      bootstrapUserId: uuid(99),
      databaseResourceId:
        "staging-database-resource",
      leagueNameNormalized:
        "original hundo league",
      sourceBundleId:
        "staging-source-bundle",
      stagingDescriptorSha256:
        "a".repeat(64),
      verificationHash: "b".repeat(64),
    };
    const expected = sha256Text(
      canonicalize({
        operation:
          RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
        verificationHash:
          binding.verificationHash,
        stagingDescriptorSha256:
          binding.stagingDescriptorSha256,
        databaseResourceId:
          binding.databaseResourceId,
        sourceBundleId:
          binding.sourceBundleId,
        bootstrapUserId:
          binding.bootstrapUserId,
        leagueNameNormalized:
          binding.leagueNameNormalized,
        seasonLabel:
          RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
        nhlSeasonKey:
          RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
      })
    );
    assert.equal(
      resetOriginalLeagueBootstrapRequestHash(
        binding
      ),
      expected
    );
    assert.equal(
      resetOriginalLeagueBootstrapRequestHash({
        verificationHash:
          binding.verificationHash,
        leagueNameNormalized:
          binding.leagueNameNormalized,
        bootstrapUserId:
          binding.bootstrapUserId,
        sourceBundleId:
          binding.sourceBundleId,
        databaseResourceId:
          binding.databaseResourceId,
        stagingDescriptorSha256:
          binding.stagingDescriptorSha256,
      }),
      expected
    );
    assert.throws(
      () =>
        resetOriginalLeagueBootstrapRequestHash({
          ...binding,
          extra: true,
        }),
      TypeError
    );
  });

  test("atomically creates the exact aggregate, replays read-only, and rejects changed or forged bindings", (t) => {
    withBootstrapServiceRuntime(
      t,
      "service-exact",
      (runtime) => {
        const request = bootstrapRequest(runtime);
        const outboxBefore = runtime.database
          .prepare(
            "SELECT * FROM outbox_events ORDER BY id"
          )
          .all();
        const { service, clockState, randomState } =
          createBootstrapService(runtime);
        const created = service.bootstrap(request);

        assert.deepEqual(created, {
          actorUserId: runtime.userId,
          code:
            "RESET_ORIGINAL_LEAGUE_BOOTSTRAPPED",
          leagueId: created.leagueId,
          schemaVersion: 49,
          seasonId: created.seasonId,
          stateHash: created.stateHash,
        });
        assert.equal(created.replayed, false);
        assert.equal(Object.isFrozen(created), true);
        assert.match(
          created.stateHash,
          /^[a-f0-9]{64}$/
        );
        assert.equal(clockState.calls, 1);
        assert.equal(randomState.calls, 5);
        assert.equal(
          JSON.stringify(created).includes(
            request.leagueName
          ),
          false
        );
        assert.equal(
          tableCount(
            runtime.database,
            "notifications"
          ),
          0
        );
        assert.equal(
          tableCount(
            runtime.database,
            "outbox_events"
          ),
          1
        );
        assert.deepEqual(
          runtime.database
            .prepare(
              "SELECT * FROM outbox_events ORDER BY id"
            )
            .all(),
          outboxBefore
        );

        const changesBeforeReplay =
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count;
        const replayed = service.bootstrap(request);
        assert.deepEqual(replayed, created);
        assert.equal(replayed.replayed, true);
        assert.equal(clockState.calls, 1);
        assert.equal(randomState.calls, 5);
        assert.equal(
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count,
          changesBeforeReplay
        );

        assert.throws(
          () =>
            service.bootstrap(
              bootstrapRequest(runtime, {
                leagueName: "Changed League",
              })
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
              .conflict
        );
        assert.throws(
          () =>
            service.bootstrap(
              bootstrapRequest(runtime, {
                artifact: {
                  ...runtime.artifact,
                },
              })
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
              .artifactInvalid
        );
        assert.throws(
          () =>
            service.bootstrap(
              bootstrapRequest(runtime, {
                confirmation: "WRONG",
              })
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
              .inputInvalid
        );
        assert.equal(
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count,
          changesBeforeReplay
        );
        assert.equal(
          runtime.database.pragma(
            "integrity_check",
            { simple: true }
          ),
          "ok"
        );
        assert.deepEqual(
          runtime.database.pragma(
            "foreign_key_check"
          ),
          []
        );
      }
    );
  });

  test("rolls back the whole aggregate after every write seam", (t) => {
    withBootstrapServiceRuntime(
      t,
      "service-rollback",
      (runtime) => {
        const protectedTables = [
          "account_action_tokens",
          "application_metadata",
          "outbox_events",
          "platform_roles",
          "player_external_ids",
          "player_source_state",
          "players",
          "security_audit_events",
          "users",
        ];
        const protectedBefore = Object.fromEntries(
          protectedTables.map((tableName) => [
            tableName,
            runtime.database
              .prepare(
                `SELECT * FROM "${tableName}" ORDER BY rowid`
              )
              .all(),
          ])
        );
        const seams = [
          "insertStartedIdempotency",
          "insertSetupLeague",
          "insertInitialSettings",
          "insertPlannedSeason",
          "setCurrentSeason",
          "appendCreationActivity",
          "appendAudit",
          "completeIdempotency",
          "assertCompletedBootstrapState",
        ];
        for (const seam of seams) {
          const { service } =
            createBootstrapService(
              runtime,
              seam
            );
          assert.throws(
            () =>
              service.bootstrap(
                bootstrapRequest(runtime)
              ),
            (error) =>
              error?.cause?.message ===
              `synthetic ${seam === "appendAudit" ? "append" : seam} failure`
          );
          for (const tableName of [
            "idempotency_requests",
            "league_activity",
            "league_settings",
            "leagues",
            "seasons",
          ]) {
            assert.equal(
              tableCount(
                runtime.database,
                tableName
              ),
              0,
              `${seam}:${tableName}`
            );
          }
          for (const tableName of protectedTables) {
            assert.deepEqual(
              runtime.database
                .prepare(
                  `SELECT * FROM "${tableName}" ORDER BY rowid`
                )
                .all(),
              protectedBefore[tableName],
              `${seam}:${tableName}`
            );
          }
          assert.equal(
            runtime.database.pragma(
              "integrity_check",
              { simple: true }
            ),
            "ok"
          );
          assert.deepEqual(
            runtime.database.pragma(
              "foreign_key_check"
            ),
            []
          );
        }

        const completed =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        assert.equal(completed.replayed, false);
        assert.equal(
          tableCount(runtime.database, "leagues"),
          1
        );
      }
    );
  });
});

describe("FAD-04 reset original-league bootstrap continuity", () => {
  test("rereads all evidence and returns a branded read-only continuity capability", (t) => {
    withBootstrapServiceRuntime(
      t,
      "continuity-exact",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const changesBefore =
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count;
        const verified =
          verifyResetOriginalLeagueBootstrapContinuity(
            continuityOptions(
              runtime,
              bootstrap
            )
          );

        assert.equal(verified.status, "verified");
        assert.equal(
          verified.verificationVersion,
          1
        );
        assert.equal(
          verified.actorUserId,
          runtime.userId
        );
        assert.equal(
          verified.leagueId,
          bootstrap.leagueId
        );
        assert.equal(
          verified.seasonId,
          bootstrap.seasonId
        );
        assert.match(
          verified.schemaFingerprint,
          /^[a-f0-9]{64}$/
        );
        assert.match(
          verified.continuityHash,
          /^[a-f0-9]{64}$/
        );
        assert.equal(
          isVerifiedResetOriginalLeagueContinuity(
            verified
          ),
          true
        );
        assert.equal(
          isVerifiedResetOriginalLeagueContinuity({
            ...verified,
          }),
          false
        );
        assert.equal(
          Object.keys(verified).includes(
            "migrationReportProjection"
          ),
          false
        );
        assert.equal(
          verified.migrationReportProjection.status,
          "succeeded"
        );
        const serialized = JSON.stringify(verified);
        for (const forbidden of [
          "migrationReportProjection",
          "Original Hundo League",
          runtime.staged.root,
          "Private Player",
        ]) {
          assert.equal(
            serialized.includes(forbidden),
            false
          );
        }
        assert.equal(
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count,
          changesBefore
        );
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          0
        );

        const replay =
          verifyResetOriginalLeagueBootstrapContinuity(
            continuityOptions(
              runtime,
              bootstrap
            )
          );
        assert.deepEqual(replay, verified);
        assert.equal(
          replay.continuityHash,
          verified.continuityHash
        );
        assert.equal(
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count,
          changesBefore
        );

        runtime.database.close();
        const reopened = openDatabase({
          databasePath:
            runtime.staged.options.databasePath,
          environment: "staging",
          persistentRoot: runtime.staged.root,
          requirePersistentRoot: true,
        });
        try {
          const afterReopen =
            verifyResetOriginalLeagueBootstrapContinuity(
              continuityOptions(
                runtime,
                bootstrap,
                {
                  database: reopened.database,
                }
              )
            );
          assert.deepEqual(afterReopen, verified);
        } finally {
          reopened.database.close();
        }
      }
    );
  });

  test("fails closed for schema drift, physical database mismatch, and changed bindings", (t) => {
    withBootstrapServiceRuntime(
      t,
      "continuity-failures",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const options = continuityOptions(
          runtime,
          bootstrap
        );

        runtime.database.exec(
          "CREATE TRIGGER synthetic_schema_drift " +
            "AFTER INSERT ON players BEGIN SELECT 1; END"
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .schemaMismatch
        );
        runtime.database.exec(
          "DROP TRIGGER synthetic_schema_drift"
        );

        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              databasePath:
                runtime.staged.options
                  .importReportPath,
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .databaseIdentityMismatch
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              databaseResourceId:
                "wrong-database-resource",
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .artifactInvalid
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              leagueName: "Changed League",
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .verificationFailed
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              extra: true,
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .argumentInvalid
        );

        const recovered =
          verifyResetOriginalLeagueBootstrapContinuity(
            options
          );
        assert.equal(recovered.status, "verified");
        assert.equal(
          runtime.database.pragma(
            "integrity_check",
            { simple: true }
          ),
          "ok"
        );
        assert.deepEqual(
          runtime.database.pragma(
            "foreign_key_check"
          ),
          []
        );
      }
    );
  });

  test("rejects full-ledger, administrator-identity, envelope-key, and foreign-key drift", (t) => {
    withBootstrapServiceRuntime(
      t,
      "continuity-protected-drift",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const options = continuityOptions(
          runtime,
          bootstrap
        );
        const ledger = runtime.database
          .prepare(
            "SELECT application_build_id " +
              "FROM schema_migrations " +
              "WHERE migration_id = 1"
          )
          .get();
        runtime.database.prepare(
          "UPDATE schema_migrations " +
            "SET application_build_id = ? " +
            "WHERE migration_id = 1"
        ).run(`${ledger.application_build_id}-drift`);
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .verificationFailed
        );
        runtime.database.prepare(
          "UPDATE schema_migrations " +
            "SET application_build_id = ? " +
            "WHERE migration_id = 1"
        ).run(ledger.application_build_id);

        const user = runtime.database
          .prepare(
            "SELECT * FROM users WHERE id = ?"
          )
          .get(runtime.userId);
        runtime.database.prepare(
          "UPDATE users SET " +
            "email_normalized = ?, " +
            "email_display = ?, " +
            "display_name = ?, " +
            "display_name_normalized = ? " +
            "WHERE id = ?"
        ).run(
          "changed@example.test",
          "changed@example.test",
          "Changed Administrator",
          "changed administrator",
          runtime.userId
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .verificationFailed
        );
        runtime.database.prepare(
          "UPDATE users SET " +
            "email_normalized = ?, " +
            "email_display = ?, " +
            "display_name = ?, " +
            "display_name_normalized = ? " +
            "WHERE id = ?"
        ).run(
          user.email_normalized,
          user.email_display,
          user.display_name,
          user.display_name_normalized,
          runtime.userId
        );

        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              encodedDeliveryKey:
                Buffer.alloc(32, 0x5b)
                  .toString("base64url"),
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .verificationFailed
        );

        runtime.database.pragma(
          "foreign_keys = OFF"
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .verificationFailed
        );
        runtime.database.pragma(
          "foreign_keys = ON"
        );
        assert.equal(
          verifyResetOriginalLeagueBootstrapContinuity(
            options
          ).status,
          "verified"
        );
      }
    );
  });

  test("rejects dependency injection and untrusted migration SQL before execution", (t) => {
    withBootstrapServiceRuntime(
      t,
      "continuity-trust-boundary",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const options = continuityOptions(
          runtime,
          bootstrap
        );
        for (const injected of [
          {
            authenticateDelivery() {
              return true;
            },
          },
          {
            bootstrapRepository: {
              assertCompletedBootstrapState() {
                return {};
              },
            },
          },
          {
            repositoryContext: {
              transaction(callback) {
                return callback();
              },
            },
          },
        ]) {
          assert.throws(
            () =>
              verifyResetOriginalLeagueBootstrapContinuity({
                ...options,
                ...injected,
              }),
            (error) =>
              error?.code ===
              RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
                .argumentInvalid
          );
        }

        const maliciousDirectory = path.join(
          runtime.staged.root,
          "untrusted-migrations"
        );
        const attachedDatabase = path.join(
          runtime.staged.root,
          "must-not-exist.sqlite3"
        );
        fs.mkdirSync(maliciousDirectory);
        fs.writeFileSync(
          path.join(
            maliciousDirectory,
            "0001_malicious.sql"
          ),
          "ATTACH DATABASE " +
            `'${attachedDatabase.replaceAll(
              "'",
              "''"
            )}' AS escaped; ` +
            "CREATE TABLE escaped.proof(value INTEGER);",
          "utf8"
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueBootstrapContinuity({
              ...options,
              migrationsDirectory:
                maliciousDirectory,
            }),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_CONTINUITY_ERROR_CODES
              .schemaMismatch
        );
        assert.equal(
          fs.existsSync(attachedDatabase),
          false
        );
      }
    );
  });
});

describe("FAD-04 committed reset migration report", () => {
  test("commits only a fresh transaction-bound capability and independently verifies the report-only delta", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-commit-exact",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const commitRuntime =
          createMigrationReportCommitService(
            runtime,
            { bootstrap }
          );
        const committed =
          commitRuntime.service.commit({});

        assert.equal(
          committed.migrationReportId,
          commitRuntime.reportId
        );
        assert.equal(
          committed.leagueId,
          bootstrap.leagueId
        );
        assert.equal(
          committed.startedAtMs,
          commitRuntime.nowMs
        );
        assert.equal(
          committed.completedAtMs,
          commitRuntime.nowMs
        );
        assert.equal(
          committed.createdAtMs,
          commitRuntime.nowMs
        );
        assert.deepEqual(commitRuntime.calls, {
          clock: 1,
          random: 1,
          verification: 1,
        });
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          1
        );

        const changesBefore =
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count;
        const verified =
          verifyResetOriginalLeagueMigrationReportCommit(
            continuityOptions(
              runtime,
              bootstrap
            )
          );
        assert.equal(verified.status, "verified");
        assert.equal(
          isVerifiedResetOriginalLeagueMigrationReportCommit(
            verified
          ),
          true
        );
        assert.equal(
          isVerifiedResetOriginalLeagueMigrationReportCommit({
            ...verified,
          }),
          false
        );
        assert.equal(
          verified.migrationReportId,
          committed.migrationReportId
        );
        assert.equal(
          verified.bootstrapStateHash,
          committed.bootstrapStateHash
        );
        assert.equal(
          verified.continuityHash,
          commitRuntime.continuities[0]
            .continuityHash
        );
        assert.match(
          verified.postCommitHash,
          /^[a-f0-9]{64}$/
        );
        assert.equal(
          runtime.database.prepare(
            "SELECT total_changes() AS count"
          ).get().count,
          changesBefore
        );
        const serialized =
          JSON.stringify(verified);
        for (const forbidden of [
          "Original Hundo League",
          runtime.staged.root,
          DELIVERY_KEY,
          runtime.administratorIdentity.email,
          "sourceHashesJson",
        ]) {
          assert.equal(
            serialized.includes(forbidden),
            false
          );
        }
      }
    );
  });

  test("post-commit verification blocks a mixed-snapshot report-row interleave", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-post-snapshot",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        createMigrationReportCommitService(
          runtime,
          { bootstrap }
        ).service.commit({});

        const secondConnection = new Database(
          runtime.staged.options.databasePath
        );
        secondConnection.pragma("busy_timeout = 0");
        const originalPrepare =
          runtime.database.prepare;
        let interleaveAttempted = false;
        let interleaveBlocked = false;
        runtime.database.prepare = function prepare(
          sql
        ) {
          if (
            !interleaveAttempted &&
            typeof sql === "string" &&
            sql.startsWith(
              "SELECT * FROM migration_reports " +
                "WHERE league_id = ?"
            )
          ) {
            interleaveAttempted = true;
            try {
              secondConnection.prepare(
                "UPDATE migration_reports " +
                  "SET started_at_ms = " +
                  "started_at_ms - 1"
              ).run();
            } catch (error) {
              if (error?.code !== "SQLITE_BUSY") {
                throw error;
              }
              interleaveBlocked = true;
            }
          }
          return originalPrepare.call(
            runtime.database,
            sql
          );
        };

        try {
          const verified =
            verifyResetOriginalLeagueMigrationReportCommit(
              continuityOptions(
                runtime,
                bootstrap
              )
            );
          assert.equal(verified.status, "verified");
          assert.equal(interleaveAttempted, true);
          assert.equal(interleaveBlocked, true);
          const row = originalPrepare.call(
            runtime.database,
            "SELECT started_at_ms, " +
              "completed_at_ms " +
              "FROM migration_reports"
          ).get();
          assert.equal(
            row.started_at_ms,
            row.completed_at_ms
          );
        } finally {
          runtime.database.prepare =
            originalPrepare;
          secondConnection.close();
        }
      }
    );
  });

  test("rejects stale or forged capabilities and rolls back a failure after repository insertion", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-commit-rollback",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const stale = runtime.database
          .transaction(() =>
            verifyResetOriginalLeagueBootstrapContinuity(
              continuityOptions(
                runtime,
                bootstrap
              )
            )
          )
          .immediate();
        runtime.database.prepare(
          "UPDATE leagues SET name = name " +
            "WHERE id = ?"
        ).run(bootstrap.leagueId);
        for (const continuity of [
          stale,
          { ...stale },
        ]) {
          const ordinary =
            createMigrationReportCommitService(
              runtime,
              {
                bootstrap,
                verifyContinuity: () =>
                  continuity,
              }
            );
          assert.throws(
            () => ordinary.service.commit({}),
            (error) =>
              error?.code ===
              RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
                .continuityInvalid
          );
        }
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          0
        );

        const realRepository =
          createSqliteMigrationReportRepository({
            database: runtime.database,
          });
        const failing =
          createMigrationReportCommitService(
            runtime,
            {
              bootstrap,
              repository: {
                commitSucceededResetEvidence(
                  options
                ) {
                  realRepository
                    .commitSucceededResetEvidence(
                      options
                    );
                  throw new Error(
                    "synthetic post-insert failure"
                  );
                },
              },
              reportId: uuid(991),
            }
          );
        assert.throws(
          () => failing.service.commit({}),
          (error) =>
            error?.code ===
            RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
              .persistenceFailed
        );
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          0
        );
      }
    );
  });

  test("post-commit verification rejects timestamp and evidence drift", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-post-drift",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const commitRuntime =
          createMigrationReportCommitService(
            runtime,
            {
              bootstrap,
              reportId: uuid(992),
            }
          );
        commitRuntime.service.commit({});
        const options = continuityOptions(
          runtime,
          bootstrap
        );
        const row = runtime.database
          .prepare(
            "SELECT * FROM migration_reports"
          )
          .get();

        runtime.database.prepare(
          "UPDATE migration_reports " +
            "SET started_at_ms = ? WHERE id = ?"
        ).run(row.started_at_ms - 1, row.id);
        assert.throws(
          () =>
            verifyResetOriginalLeagueMigrationReportCommit(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
              .evidenceInvalid
        );
        runtime.database.prepare(
          "UPDATE migration_reports " +
            "SET started_at_ms = ? WHERE id = ?"
        ).run(row.started_at_ms, row.id);

        const sourceHashes = JSON.parse(
          row.source_hashes_json
        );
        sourceHashes.importReport.semanticHash =
          "9".repeat(64);
        runtime.database.prepare(
          "UPDATE migration_reports " +
            "SET source_hashes_json = ? WHERE id = ?"
        ).run(
          canonicalize(sourceHashes),
          row.id
        );
        assert.throws(
          () =>
            verifyResetOriginalLeagueMigrationReportCommit(
              options
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
              .evidenceInvalid
        );
        runtime.database.prepare(
          "UPDATE migration_reports " +
            "SET source_hashes_json = ? WHERE id = ?"
        ).run(row.source_hashes_json, row.id);
        assert.equal(
          verifyResetOriginalLeagueMigrationReportCommit(
            options
          ).status,
          "verified"
        );
      }
    );
  });
});

describe("FAD-04 reset migration report command", () => {
  test("pins and read-back verifies the bounded maintenance lock wait", () => {
    assert.equal(
      RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS,
      60_000
    );
    const calls = [];
    const configured =
      configureResetMigrationReportBusyTimeout({
        pragma(statement, options) {
          calls.push({ statement, options });
          if (statement === "busy_timeout") {
            return RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS;
          }
          return [];
        },
      });
    assert.equal(
      configured,
      RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS
    );
    assert.deepEqual(calls, [
      {
        statement:
          `busy_timeout = ${RESET_MIGRATION_REPORT_BUSY_TIMEOUT_MS}`,
        options: undefined,
      },
      {
        statement: "busy_timeout",
        options: { simple: true },
      },
    ]);
    assert.throws(
      () =>
        configureResetMigrationReportBusyTimeout({
          pragma(statement) {
            return statement === "busy_timeout" ? 5_000 : [];
          },
        }),
      (error) =>
        error?.code ===
        RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
          .stateInvalid
    );
  });

  test("requires the complete staging binding and distinct typed confirmation", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-command-arguments",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const argv =
          migrationReportCommandArguments(
            runtime,
            bootstrap
          );
        const parsed =
          parseResetMigrationReportArguments(
            argv
          );
        assert.equal(
          parsed.confirmation,
          RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION
        );
        assert.equal(
          parsed.leagueId,
          bootstrap.leagueId
        );
        assert.equal(
          parsed.seasonId,
          bootstrap.seasonId
        );
        for (const invalid of [
          argv.slice(0, -2),
          [...argv, "--league-id", bootstrap.leagueId],
          argv.map((value) =>
            value ===
            RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION
              ? "WRONG_CONFIRMATION"
              : value
          ),
          argv.map((value) =>
            value ===
            runtime.staged.options.databasePath
              ? "relative.sqlite3"
              : value
          ),
        ]) {
          assert.throws(
            () =>
              parseResetMigrationReportArguments(
                invalid
              ),
            (error) =>
              error?.code ===
              RESET_MIGRATION_REPORT_COMMAND_ERROR_CODES
                .argumentInvalid
          );
        }
      }
    );
  });

  test("commits and replays in fresh processes with content-free output", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-command-process",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const argv =
          migrationReportCommandArguments(
            runtime,
            bootstrap
          );
        const env =
          bootstrapCommandEnvironment(runtime);
        const created = spawnSync(
          process.execPath,
          [
            RESET_MIGRATION_REPORT_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(
          created.status,
          0,
          created.stderr
        );
        assert.equal(created.stderr, "");
        const first = JSON.parse(created.stdout);
        assert.equal(first.status, "completed");
        assert.equal(first.replayed, false);
        assert.equal(
          first.leagueId,
          bootstrap.leagueId
        );
        assert.match(
          first.postCommitHash,
          /^[a-f0-9]{64}$/
        );
        for (const forbidden of [
          "Original Hundo League",
          runtime.staged.root,
          DELIVERY_KEY,
          runtime.administratorIdentity.email,
          "sourceHashesJson",
        ]) {
          assert.equal(
            created.stdout.includes(forbidden),
            false
          );
        }

        const rowBeforeReplay =
          runtime.database.prepare(
            "SELECT * FROM migration_reports"
          ).get();
        const replay = spawnSync(
          process.execPath,
          [
            RESET_MIGRATION_REPORT_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(
          replay.status,
          0,
          replay.stderr
        );
        const second = JSON.parse(replay.stdout);
        assert.equal(second.replayed, true);
        assert.equal(
          second.migrationReportId,
          first.migrationReportId
        );
        assert.equal(
          second.postCommitHash,
          first.postCommitHash
        );
        assert.deepEqual(
          runtime.database.prepare(
            "SELECT * FROM migration_reports"
          ).get(),
          rowBeforeReplay
        );
      }
    );
  });

  test("simultaneous fresh processes produce one commit and one read-only replay", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-command-concurrent",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const argv =
          migrationReportCommandArguments(
            runtime,
            bootstrap
          );
        const runner = [
          "const { spawn } = require('node:child_process');",
          "const script = process.argv[1];",
          "const argv = JSON.parse(process.argv[2]);",
          "function run() {",
          "  return new Promise((resolve, reject) => {",
          "    const child = spawn(process.execPath, [script, ...argv], {",
          "      cwd: process.cwd(),",
          "      env: process.env,",
          "      stdio: ['ignore', 'pipe', 'pipe'],",
          "    });",
          "    let stdout = '';",
          "    let stderr = '';",
          "    child.stdout.setEncoding('utf8');",
          "    child.stderr.setEncoding('utf8');",
          "    child.stdout.on('data', (chunk) => { stdout += chunk; });",
          "    child.stderr.on('data', (chunk) => { stderr += chunk; });",
          "    child.once('error', reject);",
          "    child.once('close', (code, signal) => {",
          "      resolve({ code, signal, stdout, stderr });",
          "    });",
          "  });",
          "}",
          "Promise.all([run(), run()]).then(",
          "  (results) => process.stdout.write(JSON.stringify(results)),",
          "  (error) => {",
          "    process.stderr.write(error?.stack || String(error));",
          "    process.exitCode = 1;",
          "  }",
          ");",
        ].join("\n");
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            runner,
            RESET_MIGRATION_REPORT_SCRIPT,
            JSON.stringify(argv),
          ],
          {
            cwd: ROOT,
            env:
              bootstrapCommandEnvironment(runtime),
            encoding: "utf8",
          }
        );
        assert.equal(
          result.status,
          0,
          result.stderr
        );
        assert.equal(result.stderr, "");
        const processes = JSON.parse(result.stdout);
        assert.equal(processes.length, 2);
        for (const processResult of processes) {
          assert.equal(
            processResult.code,
            0,
            processResult.stderr
          );
          assert.equal(processResult.signal, null);
          assert.equal(processResult.stderr, "");
        }
        const summaries = processes.map(
          ({ stdout }) => JSON.parse(stdout)
        );
        assert.deepEqual(
          summaries
            .map(({ replayed }) => replayed)
            .sort(),
          [false, true]
        );
        assert.equal(
          summaries[0].migrationReportId,
          summaries[1].migrationReportId
        );
        assert.equal(
          summaries[0].reportRowHash,
          summaries[1].reportRowHash
        );
        assert.equal(
          summaries[0].postCommitHash,
          summaries[1].postCommitHash
        );
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          1
        );
      }
    );
  });

  test("waits through maintenance contention beyond the ordinary connection timeout", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-command-bounded-lock-wait",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const argv =
          migrationReportCommandArguments(
            runtime,
            bootstrap
          );
        const runner = [
          "const { spawn } = require('node:child_process');",
          "const Database = require('better-sqlite3');",
          "const databasePath = process.argv[1];",
          "const script = process.argv[2];",
          "const argv = JSON.parse(process.argv[3]);",
          "const blocker = new Database(databasePath);",
          "blocker.pragma('busy_timeout = 0');",
          "blocker.exec('BEGIN IMMEDIATE');",
          "const lockedAtMs = Date.now();",
          "function run() {",
          "  return new Promise((resolve, reject) => {",
          "    const child = spawn(process.execPath, [script, ...argv], {",
          "      cwd: process.cwd(),",
          "      env: process.env,",
          "      stdio: ['ignore', 'pipe', 'pipe'],",
          "    });",
          "    let stdout = '';",
          "    let stderr = '';",
          "    child.stdout.setEncoding('utf8');",
          "    child.stderr.setEncoding('utf8');",
          "    child.stdout.on('data', (chunk) => { stdout += chunk; });",
          "    child.stderr.on('data', (chunk) => { stderr += chunk; });",
          "    child.once('error', reject);",
          "    child.once('close', (code, signal) => {",
          "      resolve({ code, signal, stdout, stderr });",
          "    });",
          "  });",
          "}",
          "const first = run();",
          "const second = run();",
          "const release = new Promise((resolve, reject) => {",
          "  setTimeout(() => {",
          "    try {",
          "      blocker.exec('COMMIT');",
          "      blocker.close();",
          "      resolve(Date.now() - lockedAtMs);",
          "    } catch (error) {",
          "      reject(error);",
          "    }",
          "  }, 6500);",
          "});",
          "Promise.all([release, first, second]).then(",
          "  ([heldForMs, firstResult, secondResult]) => {",
          "    process.stdout.write(JSON.stringify({",
          "      heldForMs,",
          "      processes: [firstResult, secondResult],",
          "    }));",
          "  },",
          "  (error) => {",
          "    if (blocker.open) blocker.close();",
          "    process.stderr.write(error?.stack || String(error));",
          "    process.exitCode = 1;",
          "  }",
          ");",
        ].join("\n");
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            runner,
            runtime.staged.options.databasePath,
            RESET_MIGRATION_REPORT_SCRIPT,
            JSON.stringify(argv),
          ],
          {
            cwd: ROOT,
            env:
              bootstrapCommandEnvironment(runtime),
            encoding: "utf8",
            timeout: 90_000,
          }
        );
        assert.equal(
          result.status,
          0,
          result.stderr
        );
        assert.equal(result.signal, null);
        assert.equal(result.stderr, "");
        const contention = JSON.parse(result.stdout);
        assert.equal(contention.heldForMs >= 6_000, true);
        assert.equal(contention.processes.length, 2);
        for (const processResult of contention.processes) {
          assert.equal(
            processResult.code,
            0,
            processResult.stderr
          );
          assert.equal(processResult.signal, null);
          assert.equal(processResult.stderr, "");
        }
        const summaries = contention.processes.map(
          ({ stdout }) => JSON.parse(stdout)
        );
        assert.deepEqual(
          summaries
            .map(({ replayed }) => replayed)
            .sort(),
          [false, true]
        );
        for (const field of [
          "migrationReportId",
          "reportRowHash",
          "postCommitHash",
        ]) {
          assert.equal(
            summaries[0][field],
            summaries[1][field]
          );
        }
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          1
        );
      }
    );
  });

  test("recovers read-only after output failure following durable post-verification", (t) => {
    withBootstrapServiceRuntime(
      t,
      "report-command-output-recovery",
      (runtime) => {
        const bootstrap =
          createBootstrapService(
            runtime
          ).service.bootstrap(
            bootstrapRequest(runtime)
          );
        const argv =
          migrationReportCommandArguments(
            runtime,
            bootstrap
          );
        const env =
          bootstrapCommandEnvironment(runtime);
        assert.throws(
          () =>
            runResetMigrationReportCommand({
              argv,
              env,
              output: {
                log() {
                  throw new Error(
                    "synthetic report output failure"
                  );
                },
              },
            }),
          /synthetic report output failure/
        );
        assert.equal(
          tableCount(
            runtime.database,
            "migration_reports"
          ),
          1
        );
        const rowBeforeRecovery =
          runtime.database.prepare(
            "SELECT * FROM migration_reports"
          ).get();
        const recovered = spawnSync(
          process.execPath,
          [
            RESET_MIGRATION_REPORT_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(
          recovered.status,
          0,
          recovered.stderr
        );
        assert.equal(
          JSON.parse(recovered.stdout).replayed,
          true
        );
        assert.deepEqual(
          runtime.database.prepare(
            "SELECT * FROM migration_reports"
          ).get(),
          rowBeforeRecovery
        );
      }
    );
  });
});

describe("FAD-04 reset original-league bootstrap command", () => {
  test("requires every staging-only operator binding exactly once", (t) => {
    withBootstrapServiceRuntime(
      t,
      "command-arguments",
      (runtime) => {
        const argv =
          bootstrapCommandArguments(runtime);
        const parsed =
          parseResetOriginalLeagueBootstrapArguments(
            argv
          );
        assert.equal(parsed.appEnv, "staging");
        assert.equal(
          parsed.confirmedAppEnv,
          "staging"
        );
        assert.equal(
          parsed.bootstrapUserId,
          runtime.userId
        );
        assert.equal(
          parsed.confirmation,
          RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION
        );
        assert.throws(
          () =>
            parseResetOriginalLeagueBootstrapArguments(
              argv.slice(0, -2)
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
              .argumentInvalid
        );
        assert.throws(
          () =>
            parseResetOriginalLeagueBootstrapArguments([
              ...argv.slice(0, -2),
              "--app-env",
              "staging",
            ]),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
              .argumentInvalid
        );
        assert.throws(
          () =>
            parseResetOriginalLeagueBootstrapArguments(
              argv.map((value) =>
                value === "OFFSEASON_RESET"
                  ? "ACTIVE"
                  : value
              )
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
              .argumentInvalid
        );
        assert.throws(
          () =>
            parseResetOriginalLeagueBootstrapArguments(
              argv.map((value) =>
                value ===
                runtime.staged.options.databasePath
                  ? "relative.sqlite3"
                  : value
              )
            ),
          (error) =>
            error?.code ===
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
              .argumentInvalid
        );
      }
    );
  });

  test("runs and replays in fresh processes with content-free output", (t) => {
    withBootstrapServiceRuntime(
      t,
      "command-process",
      (runtime) => {
        const argv =
          bootstrapCommandArguments(runtime);
        const env =
          bootstrapCommandEnvironment(runtime);
        const created = spawnSync(
          process.execPath,
          [
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(
          created.status,
          0,
          created.stderr
        );
        assert.equal(created.stderr, "");
        const first = JSON.parse(created.stdout);
        assert.equal(first.status, "completed");
        assert.equal(first.replayed, false);
        assert.equal(
          first.actorUserId,
          runtime.userId
        );
        assert.match(
          first.stateHash,
          /^[a-f0-9]{64}$/
        );
        for (const forbidden of [
          "Original Hundo League",
          runtime.staged.root,
          DELIVERY_KEY,
          `reset.command-process@example.test`,
        ]) {
          assert.equal(
            created.stdout.includes(forbidden),
            false
          );
        }

        const rowsBeforeReplay =
          runtime.database
            .prepare(
              "SELECT * FROM idempotency_requests"
            )
            .all();
        const replayed = spawnSync(
          process.execPath,
          [
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(
          replayed.status,
          0,
          replayed.stderr
        );
        const second = JSON.parse(
          replayed.stdout
        );
        assert.equal(second.replayed, true);
        assert.equal(second.leagueId, first.leagueId);
        assert.equal(second.seasonId, first.seasonId);
        assert.equal(
          second.stateHash,
          first.stateHash
        );
        assert.deepEqual(
          runtime.database
            .prepare(
              "SELECT * FROM idempotency_requests"
            )
            .all(),
          rowsBeforeReplay
        );

        const wrongKey = spawnSync(
          process.execPath,
          [
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env: bootstrapCommandEnvironment(runtime, {
              ACTION_TOKEN_DELIVERY_KEY:
                Buffer.alloc(32, 0x6b)
                  .toString("base64url"),
            }),
            encoding: "utf8",
          }
        );
        assert.equal(wrongKey.status, 1);
        assert.equal(wrongKey.stdout, "");
        assert.deepEqual(
          JSON.parse(wrongKey.stderr),
          {
            error: {
              code:
                "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID",
              message:
                "Reset original-league bootstrap failed safely.",
            },
          }
        );
        assert.equal(
          wrongKey.stderr.includes(DELIVERY_KEY),
          false
        );
      }
    );
  });

  test("recovers read-only when output fails after commit", (t) => {
    withBootstrapServiceRuntime(
      t,
      "command-output-recovery",
      (runtime) => {
        const argv =
          bootstrapCommandArguments(runtime);
        assert.throws(
          () =>
            runResetOriginalLeagueBootstrapCommand({
              argv,
              env:
                bootstrapCommandEnvironment(runtime),
              output: {
                log() {
                  throw new Error(
                    "synthetic output failure"
                  );
                },
              },
            }),
          /synthetic output failure/
        );
        assert.equal(
          tableCount(runtime.database, "leagues"),
          1
        );
        const rowsBeforeRecovery =
          runtime.database
            .prepare(
              "SELECT * FROM idempotency_requests"
            )
            .all();
        const recovered = spawnSync(
          process.execPath,
          [
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT,
            ...argv,
          ],
          {
            cwd: ROOT,
            env:
              bootstrapCommandEnvironment(runtime),
            encoding: "utf8",
          }
        );
        assert.equal(
          recovered.status,
          0,
          recovered.stderr
        );
        assert.equal(
          JSON.parse(recovered.stdout).replayed,
          true
        );
        assert.deepEqual(
          runtime.database
            .prepare(
              "SELECT * FROM idempotency_requests"
            )
            .all(),
          rowsBeforeRecovery
        );
      }
    );
  });

  test("fails generically before opening SQLite when protected input is absent", (t) => {
    withBootstrapServiceRuntime(
      t,
      "command-protected-input",
      (runtime) => {
        const env =
          bootstrapCommandEnvironment(runtime);
        delete env.BOOTSTRAP_RESET_LEAGUE_NAME;
        const result = spawnSync(
          process.execPath,
          [
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_SCRIPT,
            ...bootstrapCommandArguments(
              runtime
            ),
          ],
          {
            cwd: ROOT,
            env,
            encoding: "utf8",
          }
        );
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.deepEqual(
          JSON.parse(result.stderr),
          {
            error: {
              code:
                RESET_ORIGINAL_LEAGUE_BOOTSTRAP_COMMAND_ERROR_CODES
                  .argumentInvalid,
              message:
                "Reset original-league bootstrap failed safely.",
            },
          }
        );
        assert.equal(
          tableCount(runtime.database, "leagues"),
          0
        );
      }
    );
  });
});
