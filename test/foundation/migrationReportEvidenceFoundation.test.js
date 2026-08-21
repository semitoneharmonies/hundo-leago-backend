const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  finalizeImportReport,
} = require("../../src/infrastructure/migration/importReport");
const {
  RESET_MIGRATION_REPORT_EVIDENCE_CODES,
  ResetMigrationReportEvidenceError,
  findExactResetEvidenceCandidate,
  projectSanitizedSourceBundleEvidence,
  projectSucceededResetMigrationReport,
  validateSucceededResetMigrationReportRow,
} = require("../../src/infrastructure/migration/migrationReportEvidence");
const {
  calculateBundleChecksum,
  calculateSourceBundleId,
  canonicalize,
  inventorySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  createResetManifest,
} = require("../../src/infrastructure/migration/resetManifest");
const {
  verifyStagingImport,
  verificationHash,
} = require("../../src/infrastructure/migration/verifyStagingImport");
const {
  runStagingImport,
} = require("../../src/infrastructure/migration/runStagingImport");
const {
  serializeStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");

const ROOT = path.resolve(__dirname, "..", "..");
const RESET_MANIFEST_PATH = path.join(
  ROOT,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);

function sourceFile({
  label,
  name,
  byteSize,
  sha256,
}) {
  return {
    sourceRelativePath: name,
    copiedPath: `files/${label}/${name}`,
    byteSize,
    modifiedAtMs: 900,
    sha256,
    json: {
      parseStatus: "parsed",
      topLevelShape: name === "players.json"
        ? "array"
        : "object",
      topLevelArrayCount:
        name === "players.json" ? 2 : null,
      directArrayCounts: {},
      errorCode: null,
    },
  };
}

function sourceManifest() {
  const playersFile = sourceFile({
    label: "players",
    name: "players.json",
    byteSize: 20,
    sha256: "b".repeat(64),
  });
  const leagueFile = sourceFile({
    label: "league_state",
    name: "league-state.json",
    byteSize: 30,
    sha256: "a".repeat(64),
  });
  const payload = {
    manifestVersion: 1,
    capturedAtMs: 1_000,
    applicationBuildId: "fad-04-evidence-test",
    sourceGitCommit: "0123456789abcdef",
    sources: [
      {
        label: "players",
        absolutePath:
          "C:\\private\\season-reset\\players.json",
        kind: "file",
        byteSize: 20,
        modifiedAtMs: 900,
        files: [playersFile],
      },
      {
        label: "league_state",
        absolutePath:
          "C:\\private\\season-reset\\league-state.json",
        kind: "file",
        byteSize: 30,
        modifiedAtMs: 900,
        files: [leagueFile],
      },
    ],
  };
  const sourceBundleId = calculateSourceBundleId(payload);
  const withId = { ...payload, sourceBundleId };
  return {
    ...withId,
    bundleChecksum: calculateBundleChecksum(withId),
  };
}

function importReport(
  manifest,
  resetManifest = createResetManifest()
) {
  return finalizeImportReport({
    importerVersion: 1,
    status: "valid",
    dryRun: false,
    importedRowsRetained: true,
    environment: "staging",
    stagingDescriptor: {
      descriptorVersion: 1,
      environment: "staging",
      resourceIds: {
        service: "staging-service",
        disk: "staging-disk",
        database: "staging-database",
        sourceBundle: "staging-source-bundle",
        reports: "staging-reports",
        backups: "staging-backups",
      },
      applicationAuthority: "json",
      sqliteApplicationAuthorityEnabled: false,
      productionStorageAccessible: false,
      productionSecretsAccessible: false,
    },
    sourceBundle: {
      id: manifest.sourceBundleId,
      checksum: manifest.bundleChecksum,
      manifestVersion: manifest.manifestVersion,
      capturedAtMs: manifest.capturedAtMs,
      sourceCount: manifest.sources.length,
      fileCount: 2,
      byteSize: 50,
    },
    resetManifest: {
      id: resetManifest.manifestId,
      version: resetManifest.manifestVersion,
      checksum: resetManifest.checksum,
    },
    schema: {
      userVersion: 2,
      migrationCount: 2,
      migrationLedger: [
        {
          id: 1,
          fileName: "0001_initial.sql",
          checksum: "d".repeat(64),
        },
        {
          id: 2,
          fileName: "0002_second.sql",
          checksum: "e".repeat(64),
        },
      ],
    },
    sourceShapes: {
      league_state: "legacy-league-state-v1",
      players: "legacy-players-v1",
    },
    sourceCollectionCounts: {
      players: 2,
      teams: 1,
      roster_entries: 1,
      buyout_entries: 0,
      league_activity: 0,
      trade_proposals: 0,
      matchup_weeks: 0,
      recovery_evidence_files: 0,
      ignored_metadata_records: 2,
      never_import_credential_records: 0,
    },
    targetTables: [
      {
        table: "players",
        plannedRowCount: 2,
        validatedRowCount: 2,
        postRollbackRowCount: null,
        semanticHash: "f".repeat(64),
      },
      {
        table: "player_external_ids",
        plannedRowCount: 2,
        validatedRowCount: 2,
        postRollbackRowCount: null,
        semanticHash: "1".repeat(64),
      },
      {
        table: "player_source_state",
        plannedRowCount: 2,
        validatedRowCount: 2,
        postRollbackRowCount: null,
        semanticHash: "2".repeat(64),
      },
    ],
    resetOmissions: resetManifest.omissionFamilies.map(
      (family) => ({
        familyId: family.familyId,
        sourceCount:
          family.familyId === "season_1_rosters"
            ? 1
            : 0,
        countTreatment: family.countTreatment,
        targetTreatment: family.targetTreatment,
        validatedTargetRowCount: 0,
        reconciled: true,
      })
    ),
    protectedFamilies: [],
    neverImportFamilies: [],
    mappingEntries: [],
    money: {
      sourceCount: 1,
      sourceSumCents: 600,
      importedCount: 0,
      importedSumCents: 0,
      omittedCount: 1,
      omittedSumCents: 600,
      reconciled: true,
      families: [
        {
          familyId: "season_1_contracts",
          sourceCount: 1,
          sourceSumCents: 600,
          importedCount: 0,
          importedSumCents: 0,
          omittedCount: 1,
          omittedSumCents: 600,
          reconciled: true,
        },
        {
          familyId: "season_1_buyouts",
          sourceCount: 0,
          sourceSumCents: 0,
          importedCount: 0,
          importedSumCents: 0,
          omittedCount: 0,
          omittedSumCents: 0,
          reconciled: true,
        },
        {
          familyId: "season_1_trades",
          sourceCount: 0,
          sourceSumCents: 0,
          importedCount: 0,
          importedSumCents: 0,
          omittedCount: 0,
          omittedSumCents: 0,
          reconciled: true,
        },
        {
          familyId: "season_1_retention",
          sourceCount: 0,
          sourceSumCents: 0,
          importedCount: 0,
          importedSumCents: 0,
          omittedCount: 0,
          omittedSumCents: 0,
          reconciled: true,
        },
      ],
    },
    ownership: {
      sourceCount: 1,
      importedCount: 0,
      omittedCount: 1,
      duplicateTargetPlayerCount: 0,
      reconciled: true,
    },
    checks: {
      integrity: "ok",
      foreignKeyViolationCount: 0,
      stablePlayerExternalIdsPreserved: true,
      importedRowsRolledBack: false,
      committedRowsVerified: true,
    },
    rejects: [],
    quarantine: [],
    repairs: [],
    defaults: [],
    warnings: [],
  });
}

function refinalize(report, changes) {
  const { semanticReportHash, ...payload } = report;
  return finalizeImportReport({
    ...payload,
    ...changes,
  });
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function verifiedImportEvidence(report) {
  const canonicalReport = `${canonicalize(report)}\n`;
  const withoutHash = {
    verificationVersion: 1,
    status: "verified",
    environment: "staging",
    sourceBundle: report.sourceBundle,
    resetManifest: report.resetManifest,
    database: {
      sha256: "3".repeat(64),
      bytes: 4_096,
      userVersion: report.schema.userVersion,
      migrationLedger: report.schema.migrationLedger,
      targetTables: report.targetTables,
      seededApplicationMetadataRowCount: 2,
      emptyApplicationTableCount: 90,
    },
    importReport: {
      sha256: sha256(canonicalReport),
      bytes: Buffer.byteLength(canonicalReport),
      semanticReportHash: report.semanticReportHash,
    },
    reconciliation: {
      omissionFamilyCount: report.resetOmissions.length,
      protectedFamilyCount:
        report.protectedFamilies.length,
      neverImportFamilyCount:
        report.neverImportFamilies.length,
      mappingEntryCount: report.mappingEntries.length,
      mappingSha256: sha256(
        canonicalize(report.mappingEntries)
      ),
      money: report.money,
      ownership: report.ownership,
    },
    checks: {
      integrity: "ok",
      foreignKeyViolationCount: 0,
      stablePlayerExternalIdsPreserved: true,
      sourceBundleVerified: true,
      resetManifestVerified: true,
      canonicalImportReportVerified: true,
      allApplicationTableCountsVerified: true,
      semanticHashesVerified: true,
      applicationAuthority: "json",
      sqliteApplicationAuthorityEnabled: false,
      productionStorageAccessible: false,
      productionSecretsAccessible: false,
      inputsUnchanged: true,
    },
  };
  return {
    ...withoutHash,
    verificationHash: verificationHash(withoutHash),
  };
}

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function project(overrides = {}) {
  const manifest =
    overrides.sourceBundleManifest || sourceManifest();
  const reset =
    overrides.resetManifest || createResetManifest();
  const report =
    overrides.importReport ||
    importReport(manifest, reset);
  const verification =
    overrides.verificationEvidence ||
    verifiedImportEvidence(report);
  return projectSucceededResetMigrationReport({
    sourceBundleManifest: manifest,
    resetManifest: reset,
    importReport: report,
    verificationEvidence: verification,
  });
}

function migrationReportRow(overrides = {}) {
  const projected = project();
  return {
    id: uuid(1),
    league_id: uuid(2),
    source_bundle_id: projected.sourceBundleId,
    reset_manifest_id: projected.resetManifestId,
    database_schema_version:
      projected.databaseSchemaVersion,
    status: projected.status,
    source_hashes_json: projected.sourceHashesJson,
    counts_json: projected.countsJson,
    totals_json: projected.totalsJson,
    warnings_json: projected.warningsJson,
    rejects_json: projected.rejectsJson,
    started_at_ms: 2_000,
    completed_at_ms: 2_100,
    created_at_ms: 2_100,
    ...overrides,
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof ResetMigrationReportEvidenceError &&
    error.code === code;
}

function syntheticLeagueState() {
  return {
    schemaVersion: 1,
    meta: { createdAt: "synthetic" },
    teams: [{
      name: "Team One",
      roster: [{
        name: "Player One",
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
    fullName: "Player One",
    firstName: "Player",
    lastName: "One",
    position: "F",
    teamAbbrev: "AAA",
    birthDate: "2000-01-01",
    active: true,
  }];
}

function createVerifiedImportAttempt(t) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-04-staging-evidence-"
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
  const playersPath = path.join(inputs, "players.json");
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
      service: "fad-04-staging-service",
      disk: "fad-04-staging-disk",
      database: "fad-04-staging-database",
      sourceBundle: "fad-04-staging-source",
      reports: "fad-04-staging-reports",
      backups: "fad-04-staging-backups",
    },
    paths: {
      persistentRoot: root,
      database: databasePath,
      sourceBundles: sourceRoot,
      reports: reportsRoot,
      backups: backupsRoot,
    },
    backupNamespace: "hundo-leago/staging",
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
  const importOptions = {
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST_PATH,
    reportDirectory,
    operatingMode: "OFFSEASON_RESET",
  };
  runStagingImport(importOptions);
  const importReportPath = path.join(
    reportDirectory,
    "import-report.json"
  );
  const verificationEvidence = verifyStagingImport({
    descriptorPath,
    sourceBundleDirectory,
    databasePath,
    resetManifestPath: RESET_MANIFEST_PATH,
    importReportPath,
    operatingMode: "OFFSEASON_RESET",
  });
  return {
    sourceBundleManifest: JSON.parse(
      fs.readFileSync(
        path.join(
          sourceBundleDirectory,
          "source-bundle.json"
        ),
        "utf8"
      )
    ),
    resetManifest: JSON.parse(
      fs.readFileSync(RESET_MANIFEST_PATH, "utf8")
    ),
    importReport: JSON.parse(
      fs.readFileSync(importReportPath, "utf8")
    ),
    verificationEvidence,
  };
}

describe("FAD-04 reset migration-report evidence projection", () => {
  test("projects verified source evidence without private source metadata", () => {
    const evidence = projectSanitizedSourceBundleEvidence(
      sourceManifest()
    );

    assert.deepEqual(Object.keys(evidence), [
      "id",
      "checksum",
      "manifestVersion",
      "capturedAtMs",
      "sourceCount",
      "fileCount",
      "byteSize",
      "sourceFiles",
    ]);
    assert.equal(evidence.manifestVersion, 1);
    assert.equal(evidence.capturedAtMs, 1_000);
    assert.equal(evidence.sourceCount, 2);
    assert.equal(evidence.fileCount, 2);
    assert.equal(evidence.byteSize, 50);
    assert.deepEqual(evidence.sourceFiles, [
      {
        sourceLabel: "league_state",
        copiedPath:
          "files/league_state/league-state.json",
        byteSize: 30,
        sha256: "a".repeat(64),
      },
      {
        sourceLabel: "players",
        copiedPath: "files/players/players.json",
        byteSize: 20,
        sha256: "b".repeat(64),
      },
    ]);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.sourceFiles), true);
    assert.equal(
      evidence.sourceFiles.every(Object.isFrozen),
      true
    );

    const serialized = JSON.stringify(evidence);
    for (const privateValue of [
      "C:\\private",
      "absolutePath",
      "sourceRelativePath",
      "modifiedAtMs",
      "applicationBuildId",
      "sourceGitCommit",
      "directArrayCounts",
    ]) {
      assert.equal(
        serialized.includes(privateValue),
        false
      );
    }
  });

  test("projects exact canonical succeeded evidence without private source paths or payloads", () => {
    const projected = project();

    assert.deepEqual(
      Object.keys(projected),
      [
        "sourceBundleId",
        "resetManifestId",
        "databaseSchemaVersion",
        "status",
        "sourceHashesJson",
        "countsJson",
        "totalsJson",
        "warningsJson",
        "rejectsJson",
      ]
    );
    assert.equal(
      projected.resetManifestId,
      "2026-season-1-reset-v1"
    );
    assert.equal(projected.databaseSchemaVersion, 2);
    assert.equal(projected.status, "succeeded");
    assert.equal(projected.warningsJson, "[]");
    assert.equal(projected.rejectsJson, "[]");

    const hashes = JSON.parse(projected.sourceHashesJson);
    assert.deepEqual(
      hashes.sourceFiles.map(
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
    assert.equal(hashes.evidenceVersion, 1);
    assert.equal(
      hashes.importReport.semanticHash.length,
      64
    );

    const counts = JSON.parse(projected.countsJson);
    assert.equal(counts.blockingRejectCount, 0);
    assert.equal(counts.warningCount, 0);
    assert.deepEqual(counts.sourceCollections, {
      buyout_entries: 0,
      ignored_metadata_records: 2,
      league_activity: 0,
      matchup_weeks: 0,
      never_import_credential_records: 0,
      players: 2,
      recovery_evidence_files: 0,
      roster_entries: 1,
      teams: 1,
      trade_proposals: 0,
    });
    assert.deepEqual(counts.targetTables, [
      {
        plannedRowCount: 2,
        semanticHash: "f".repeat(64),
        table: "players",
        validatedRowCount: 2,
      },
      {
        plannedRowCount: 2,
        semanticHash: "1".repeat(64),
        table: "player_external_ids",
        validatedRowCount: 2,
      },
      {
        plannedRowCount: 2,
        semanticHash: "2".repeat(64),
        table: "player_source_state",
        validatedRowCount: 2,
      },
    ]);

    for (const field of [
      "sourceHashesJson",
      "countsJson",
      "totalsJson",
      "warningsJson",
      "rejectsJson",
    ]) {
      assert.equal(
        projected[field],
        canonicalize(JSON.parse(projected[field]))
      );
    }
    const serialized = JSON.stringify(projected);
    assert.equal(serialized.includes("C:\\private"), false);
    assert.equal(serialized.includes("absolutePath"), false);
    assert.equal(serialized.includes("directArrayCounts"), false);
  });

  test("projects genuine import and independent-verification artifacts under schema 54", (t) => {
    const artifacts = createVerifiedImportAttempt(t);
    const projected =
      projectSucceededResetMigrationReport(artifacts);
    const hashes = JSON.parse(
      projected.sourceHashesJson
    );

    assert.equal(projected.databaseSchemaVersion, 54);
    assert.equal(projected.status, "succeeded");
    assert.equal(projected.rejectsJson, "[]");
    assert.equal(hashes.sourceBundle.manifestVersion, 1);
    assert.equal(
      artifacts.sourceBundleManifest.applicationBuildId,
      null
    );
    assert.equal(
      artifacts.sourceBundleManifest.sourceGitCommit,
      null
    );
    assert.equal(
      artifacts.importReport.schema.migrationLedger.every(
        ({ id }) => Number.isSafeInteger(id)
      ),
      true
    );
  });

  test("rejects a tampered source manifest before projection", () => {
    const manifest = sourceManifest();
    assert.throws(
      () =>
        project({
          sourceBundleManifest: {
            ...manifest,
            bundleChecksum: "0".repeat(64),
          },
          importReport: importReport(manifest),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .sourceManifestInvalid
      )
    );
  });

  test("accepts the source inventory's approved null build provenance", () => {
    const original = sourceManifest();
    const {
      bundleChecksum,
      sourceBundleId,
      ...payload
    } = original;
    const nullablePayload = {
      ...payload,
      applicationBuildId: null,
      sourceGitCommit: null,
    };
    const nullableId =
      calculateSourceBundleId(nullablePayload);
    const manifest = {
      ...nullablePayload,
      sourceBundleId: nullableId,
    };
    manifest.bundleChecksum =
      calculateBundleChecksum(manifest);

    assert.equal(
      project({
        sourceBundleManifest: manifest,
        importReport: importReport(manifest),
      }).sourceBundleId,
      nullableId
    );
  });

  test("rejects a report whose source identity does not match the verified manifest", () => {
    const manifest = sourceManifest();
    const report = importReport(manifest);
    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          importReport: refinalize(report, {
            sourceBundle: {
              ...report.sourceBundle,
              checksum: "0".repeat(64),
            },
          }),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .importReportInvalid
      )
    );
  });

  test("rejects wrong reset evidence and nonempty reject or quarantine arrays", () => {
    const manifest = sourceManifest();
    const report = importReport(manifest);
    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          importReport: refinalize(report, {
            resetManifest: {
              ...report.resetManifest,
              id: "another-reset",
            },
          }),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .resetManifestMismatch
      )
    );
    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          importReport: refinalize(report, {
            resetManifest: {
              ...report.resetManifest,
              checksum: "0".repeat(64),
            },
          }),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .resetManifestMismatch
      )
    );

    for (const changed of [
      { rejects: [{ code: "BLOCKING" }] },
      { quarantine: [{ code: "AMBIGUOUS" }] },
      {
        warnings: [{
          code: "PRIVATE_PATH",
          detail: "C:\\private\\source.json",
        }],
      },
    ]) {
      assert.throws(
        () =>
          project({
            sourceBundleManifest: manifest,
            importReport: refinalize(report, changed),
          }),
        hasCode(
          RESET_MIGRATION_REPORT_EVIDENCE_CODES
            .importReportInvalid
        )
      );
    }
  });

  test("rejects semantic tampering and unapproved extra fields", () => {
    const manifest = sourceManifest();
    const report = importReport(manifest);
    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          importReport: {
            ...report,
            status: "changed-after-finalization",
          },
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .importReportInvalid
      )
    );
    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          importReport: refinalize(report, {
            unexpectedEvidence: true,
          }),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .importReportInvalid
      )
    );
  });

  test("requires internally valid independent canonical-import verification evidence", () => {
    const manifest = sourceManifest();
    const resetManifest = createResetManifest();
    const report = importReport(manifest, resetManifest);
    const verification = verifiedImportEvidence(report);
    const changed = {
      ...verification,
      checks: {
        ...verification.checks,
        inputsUnchanged: false,
      },
    };
    changed.verificationHash = verificationHash(changed);

    assert.throws(
      () =>
        project({
          sourceBundleManifest: manifest,
          resetManifest,
          importReport: report,
          verificationEvidence: changed,
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .importReportInvalid
      )
    );
  });

  test("requires an exact projection request", () => {
    const manifest = sourceManifest();
    const resetManifest = createResetManifest();
    const report = importReport(
      manifest,
      resetManifest
    );
    assert.throws(
      () =>
        projectSucceededResetMigrationReport({
          sourceBundleManifest: manifest,
          resetManifest,
          importReport: report,
          verificationEvidence:
            verifiedImportEvidence(report),
          leagueId: "not-part-of-pure-projection",
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .argumentInvalid
      )
    );
  });

  test("validates and parses one exact canonical succeeded row", () => {
    const row = migrationReportRow();
    const parsed =
      validateSucceededResetMigrationReportRow(row);

    assert.equal(parsed.id, row.id);
    assert.equal(parsed.leagueId, row.league_id);
    assert.equal(
      parsed.sourceBundleId,
      row.source_bundle_id
    );
    assert.equal(parsed.status, "succeeded");
    assert.equal(parsed.counts.blockingRejectCount, 0);
    assert.deepEqual(parsed.rejects, []);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.sourceHashes), true);
  });

  test("rejects noncanonical, malformed, or internally inconsistent persisted JSON", () => {
    const row = migrationReportRow();
    const noncanonical = JSON.stringify(
      JSON.parse(row.counts_json),
      null,
      2
    );
    assert.throws(
      () =>
        validateSucceededResetMigrationReportRow({
          ...row,
          counts_json: noncanonical,
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );

    const hashes = JSON.parse(row.source_hashes_json);
    assert.throws(
      () =>
        validateSucceededResetMigrationReportRow({
          ...row,
          source_hashes_json: canonicalize({
            ...hashes,
            unexpected: true,
          }),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );
    assert.throws(
      () =>
        validateSucceededResetMigrationReportRow({
          ...row,
          source_bundle_id:
            `source-bundle-v1-${"0".repeat(64)}`,
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );

    const warnings = [{ code: "REVIEWED_WARNING" }];
    assert.throws(
      () =>
        validateSucceededResetMigrationReportRow({
          ...row,
          warnings_json: canonicalize(warnings),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );
    assert.throws(
      () =>
        validateSucceededResetMigrationReportRow({
          ...row,
          rejects_json: canonicalize([
            { code: "BLOCKING" },
          ]),
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );
  });

  test("selects exactly one qualifying same-league candidate while ignoring nonmatching history", () => {
    const qualifying = migrationReportRow();
    const parsed = findExactResetEvidenceCandidate({
      leagueId: qualifying.league_id,
      rows: [
        {
          ...qualifying,
          id: uuid(3),
          status: "failed",
          completed_at_ms: null,
        },
        {
          ...qualifying,
          id: uuid(4),
          league_id: uuid(5),
        },
        qualifying,
      ],
    });
    assert.equal(parsed.id, qualifying.id);
  });

  test("fails closed for zero, wrong-league, wrong-manifest, failed, or multiple candidates", () => {
    const row = migrationReportRow();
    const nonmatchingSets = [
      [],
      [{ ...row, league_id: uuid(9) }],
      [{ ...row, reset_manifest_id: "wrong-reset" }],
      [{ ...row, status: "failed" }],
    ];
    for (const rows of nonmatchingSets) {
      assert.throws(
        () =>
          findExactResetEvidenceCandidate({
            leagueId: row.league_id,
            rows,
          }),
        hasCode(
          RESET_MIGRATION_REPORT_EVIDENCE_CODES
            .candidateMissing
        )
      );
    }
    assert.throws(
      () =>
        findExactResetEvidenceCandidate({
          leagueId: row.league_id,
          rows: [row, { ...row, id: uuid(10) }],
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .candidateAmbiguous
      )
    );
  });

  test("rejects a single scalar-matching candidate whose exact evidence is malformed", () => {
    const row = migrationReportRow({
      counts_json: "{}",
    });
    assert.throws(
      () =>
        findExactResetEvidenceCandidate({
          leagueId: row.league_id,
          rows: [row],
        }),
      hasCode(
        RESET_MIGRATION_REPORT_EVIDENCE_CODES.rowInvalid
      )
    );
  });
});
