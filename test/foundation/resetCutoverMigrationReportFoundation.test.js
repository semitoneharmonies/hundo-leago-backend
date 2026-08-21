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
  RESET_MIGRATION_REPORT_EVIDENCE_CODES,
} = require("../../src/infrastructure/migration/migrationReportEvidence");
const {
  canonicalize,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  RESET_OMISSION_POLICY,
  createResetManifest,
} = require("../../src/infrastructure/migration/resetManifest");
const {
  MIGRATION_REPORT_REPOSITORY_CODES,
  MigrationReportRepositoryError,
  createSqliteMigrationReportRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMigrationReportRepository");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(
  ROOT,
  "database",
  "migrations"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function sourceBundleId(character = "a") {
  return `source-bundle-v1-${character.repeat(64)}`;
}

function zeroMoneyFamily(familyId) {
  return {
    familyId,
    sourceCount: 0,
    sourceSumCents: 0,
    importedCount: 0,
    importedSumCents: 0,
    omittedCount: 0,
    omittedSumCents: 0,
    reconciled: true,
  };
}

function projection({
  bundleId = sourceBundleId(),
  schemaVersion = 54,
  targetHash = "b".repeat(64),
} = {}) {
  const reset = createResetManifest();
  const sourceHashes = {
    evidenceVersion: 1,
    sourceBundle: {
      id: bundleId,
      checksum: "c".repeat(64),
      manifestVersion: 1,
    },
    sourceFiles: [{
      sourceLabel: "league_state",
      copiedPath:
        "files/league_state/league-state.json",
      byteSize: 100,
      sha256: "d".repeat(64),
    }],
    resetManifest: {
      id: reset.manifestId,
      version: reset.manifestVersion,
      checksum: reset.checksum,
    },
    importReport: {
      reportVersion: 1,
      importerVersion: 1,
      semanticHash: "e".repeat(64),
    },
  };
  const counts = {
    evidenceVersion: 1,
    sourceCollections: {
      players: 0,
      teams: 0,
      roster_entries: 0,
      buyout_entries: 0,
      league_activity: 0,
      trade_proposals: 0,
      matchup_weeks: 0,
      recovery_evidence_files: 0,
      ignored_metadata_records: 0,
      never_import_credential_records: 0,
    },
    targetTables: [
      {
        table: "players",
        plannedRowCount: 0,
        validatedRowCount: 0,
        semanticHash: targetHash,
      },
      {
        table: "player_external_ids",
        plannedRowCount: 0,
        validatedRowCount: 0,
        semanticHash: "f".repeat(64),
      },
      {
        table: "player_source_state",
        plannedRowCount: 0,
        validatedRowCount: 0,
        semanticHash: "1".repeat(64),
      },
    ],
    resetOmissions: RESET_OMISSION_POLICY.map(
      (family) => ({
        familyId: family.familyId,
        sourceCount: 0,
        countTreatment: family.countTreatment,
        targetTreatment: family.targetTreatment,
        validatedTargetRowCount: 0,
        reconciled: true,
      })
    ),
    blockingRejectCount: 0,
    warningCount: 0,
  };
  const totals = {
    evidenceVersion: 1,
    money: {
      sourceCount: 0,
      sourceSumCents: 0,
      importedCount: 0,
      importedSumCents: 0,
      omittedCount: 0,
      omittedSumCents: 0,
      reconciled: true,
      families: [
        zeroMoneyFamily("season_1_contracts"),
        zeroMoneyFamily("season_1_buyouts"),
        zeroMoneyFamily("season_1_trades"),
        zeroMoneyFamily("season_1_retention"),
      ],
    },
    ownership: {
      sourceCount: 0,
      importedCount: 0,
      omittedCount: 0,
      duplicateTargetPlayerCount: 0,
      reconciled: true,
    },
  };
  return {
    sourceBundleId: bundleId,
    resetManifestId: reset.manifestId,
    databaseSchemaVersion: schemaVersion,
    status: "succeeded",
    sourceHashesJson: canonicalize(sourceHashes),
    countsJson: canonicalize(counts),
    totalsJson: canonicalize(totals),
    warningsJson: "[]",
    rejectsJson: "[]",
  };
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
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
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS,
    applicationBuildId: "fad-04-report-writer-test",
    now: () => 1_000,
  });
  return {
    ...connection,
    repository: createSqliteMigrationReportRepository({
      database: connection.database,
    }),
  };
}

function seedLeague(database, id, name) {
  database.prepare(`
    INSERT INTO leagues (
      id,
      name,
      name_normalized,
      status,
      timezone,
      commissioner_membership_id,
      current_season_id,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @name,
      @nameNormalized,
      'setup',
      'America/Vancouver',
      NULL,
      NULL,
      1,
      1,
      1
    )
  `).run({
    id,
    name,
    nameNormalized: name.toLowerCase(),
  });
}

function commitOptions({
  id = uuid(1),
  leagueId = uuid(2),
  report = projection(),
  startedAtMs = 2_000,
  completedAtMs = 2_100,
} = {}) {
  return {
    id,
    leagueId,
    projection: report,
    startedAtMs,
    completedAtMs,
  };
}

function repositoryCode(code) {
  return (error) =>
    error instanceof MigrationReportRepositoryError &&
    error.code === code;
}

function count(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    )
    .get().count;
}

function insertMigrationReport(
  database,
  {
    id,
    leagueId,
    report,
    startedAtMs,
    completedAtMs,
  }
) {
  database.prepare(`
    INSERT INTO migration_reports (
      id,
      league_id,
      source_bundle_id,
      reset_manifest_id,
      database_schema_version,
      status,
      source_hashes_json,
      counts_json,
      totals_json,
      warnings_json,
      rejects_json,
      started_at_ms,
      completed_at_ms,
      created_at_ms
    ) VALUES (
      @id,
      @leagueId,
      @sourceBundleId,
      @resetManifestId,
      @databaseSchemaVersion,
      @status,
      @sourceHashesJson,
      @countsJson,
      @totalsJson,
      @warningsJson,
      @rejectsJson,
      @startedAtMs,
      @completedAtMs,
      @completedAtMs
    )
  `).run({
    id,
    leagueId,
    ...report,
    startedAtMs,
    completedAtMs,
  });
}

describe("FAD-04 committed reset migration-report repository", () => {
  test("fresh insert proves the exact one league and source candidate", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-exact-one-"
    );
    seedLeague(runtime.database, uuid(2), "Original");
    const options = commitOptions();

    const created =
      runtime.repository.commitSucceededResetEvidence(
        options
      );
    const leagueCandidates =
      runtime.repository.listResetEvidenceCandidates({
        leagueId: options.leagueId,
      });
    const sourceCandidates = runtime.database
      .prepare(`
        SELECT *
        FROM migration_reports
        WHERE source_bundle_id = @sourceBundleId
          AND database_schema_version =
            @databaseSchemaVersion
        ORDER BY created_at_ms ASC, id ASC
      `)
      .all({
        sourceBundleId:
          options.projection.sourceBundleId,
        databaseSchemaVersion:
          options.projection.databaseSchemaVersion,
      });

    assert.equal(created.replayed, false);
    assert.equal(leagueCandidates.length, 1);
    assert.equal(sourceCandidates.length, 1);
    assert.deepEqual(leagueCandidates[0], created.row);
    assert.deepEqual(sourceCandidates[0], created.row);
    assert.equal(
      runtime.repository.findExactSucceededResetEvidence({
        leagueId: options.leagueId,
      }).id,
      options.id
    );
  });

  test("commits one exact row and returns the original row on exact replay", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-commit-"
    );
    seedLeague(
      runtime.database,
      uuid(2),
      "Original League"
    );

    const created =
      runtime.repository.commitSucceededResetEvidence(
        commitOptions()
      );
    assert.equal(created.replayed, false);
    assert.equal(created.row.id, uuid(1));
    assert.equal(created.row.league_id, uuid(2));
    assert.equal(created.row.status, "succeeded");
    assert.equal(count(runtime.database, "migration_reports"), 1);

    const replay =
      runtime.repository.commitSucceededResetEvidence(
        commitOptions({
          id: uuid(3),
          startedAtMs: 3_000,
          completedAtMs: 3_100,
        })
      );
    assert.equal(replay.replayed, true);
    assert.equal(replay.row.id, uuid(1));
    assert.equal(count(runtime.database, "migration_reports"), 1);

    const found =
      runtime.repository.findExactSucceededResetEvidence({
        leagueId: uuid(2),
      });
    assert.equal(found.id, uuid(1));
    assert.equal(found.databaseSchemaVersion, 54);

    runtime.database.pragma("user_version = 41");
    const postMigrationReplay =
      runtime.repository.commitSucceededResetEvidence(
        commitOptions({
          id: uuid(3),
          startedAtMs: 3_000,
          completedAtMs: 3_100,
        })
      );
    assert.equal(postMigrationReplay.replayed, true);
    assert.equal(postMigrationReplay.row.id, uuid(1));
    assert.equal(count(runtime.database, "migration_reports"), 1);

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

  test("rejects missing league, schema mismatch, and malformed evidence without writes", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-reject-"
    );
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions()
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES.leagueMissing
      )
    );
    seedLeague(runtime.database, uuid(2), "Original");
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            report: projection({ schemaVersion: 26 }),
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .schemaMismatch
      )
    );
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            report: {
              ...projection(),
              warningsJson: '[{"code":"PRIVATE"}]',
            },
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .evidenceInvalid
      )
    );
    assert.equal(count(runtime.database, "migration_reports"), 0);
  });

  test("rejects changed replay, cross-league reuse, and a second qualifying league report", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-conflict-"
    );
    seedLeague(runtime.database, uuid(2), "First");
    seedLeague(runtime.database, uuid(3), "Second");
    runtime.repository.commitSucceededResetEvidence(
      commitOptions()
    );

    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            id: uuid(4),
            report: projection({
              targetHash: "9".repeat(64),
            }),
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .evidenceConflict
      )
    );
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            id: uuid(5),
            leagueId: uuid(3),
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .evidenceConflict
      )
    );
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            id: uuid(6),
            report: projection({
              bundleId: sourceBundleId("9"),
            }),
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .evidenceConflict
      )
    );
    assert.equal(count(runtime.database, "migration_reports"), 1);

    insertMigrationReport(runtime.database, {
      id: uuid(7),
      leagueId: uuid(2),
      report: projection({
        bundleId: sourceBundleId("8"),
      }),
      startedAtMs: 4_000,
      completedAtMs: 4_100,
    });
    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions({
            id: uuid(8),
            startedAtMs: 5_000,
            completedAtMs: 5_100,
          })
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .evidenceConflict
      )
    );
    assert.equal(count(runtime.database, "migration_reports"), 2);
  });

  test("rolls back a late SQLite failure and leaves every related table unchanged", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-rollback-"
    );
    seedLeague(runtime.database, uuid(2), "Original");
    runtime.database.exec(`
      CREATE TRIGGER migration_report_test_abort
      AFTER INSERT ON migration_reports
      BEGIN
        SELECT RAISE(ABORT, 'synthetic late failure');
      END;
    `);
    const before = {
      reports: count(runtime.database, "migration_reports"),
      exemptions: count(
        runtime.database,
        "free_agent_draft_setup_exemptions"
      ),
      activity: count(runtime.database, "league_activity"),
      notifications: count(
        runtime.database,
        "notifications"
      ),
      outbox: count(runtime.database, "outbox_events"),
    };

    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions()
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .operationFailed
      )
    );
    const after = {
      reports: count(runtime.database, "migration_reports"),
      exemptions: count(
        runtime.database,
        "free_agent_draft_setup_exemptions"
      ),
      activity: count(runtime.database, "league_activity"),
      notifications: count(
        runtime.database,
        "notifications"
      ),
      outbox: count(runtime.database, "outbox_events"),
    };
    assert.deepEqual(after, before);
    assert.equal(runtime.database.inTransaction, false);
  });

  test("rolls back when a fresh insert creates ambiguous league evidence", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-ambiguous-"
    );
    seedLeague(runtime.database, uuid(2), "Original");
    runtime.database.exec(`
      CREATE TRIGGER migration_report_test_ambiguous
      AFTER INSERT ON migration_reports
      WHEN NEW.id = '${uuid(1)}'
      BEGIN
        INSERT INTO migration_reports (
          id,
          league_id,
          source_bundle_id,
          reset_manifest_id,
          database_schema_version,
          status,
          source_hashes_json,
          counts_json,
          totals_json,
          warnings_json,
          rejects_json,
          started_at_ms,
          completed_at_ms,
          created_at_ms
        ) VALUES (
          '${uuid(9)}',
          NEW.league_id,
          '${sourceBundleId("8")}',
          NEW.reset_manifest_id,
          NEW.database_schema_version,
          NEW.status,
          NEW.source_hashes_json,
          NEW.counts_json,
          NEW.totals_json,
          NEW.warnings_json,
          NEW.rejects_json,
          NEW.started_at_ms,
          NEW.completed_at_ms,
          NEW.created_at_ms
        );
      END;
    `);

    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions()
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .operationFailed
      )
    );
    assert.equal(count(runtime.database, "migration_reports"), 0);
    assert.equal(runtime.database.inTransaction, false);
  });

  test("rolls back when a fresh persisted candidate differs from the commit", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-mismatch-"
    );
    seedLeague(runtime.database, uuid(2), "Original");
    runtime.database.exec(`
      CREATE TRIGGER migration_report_test_mismatch
      AFTER INSERT ON migration_reports
      WHEN NEW.id = '${uuid(1)}'
      BEGIN
        UPDATE migration_reports
        SET completed_at_ms = NEW.completed_at_ms + 1
        WHERE id = NEW.id;
      END;
    `);

    assert.throws(
      () =>
        runtime.repository.commitSucceededResetEvidence(
          commitOptions()
        ),
      repositoryCode(
        MIGRATION_REPORT_REPOSITORY_CODES
          .operationFailed
      )
    );
    assert.equal(count(runtime.database, "migration_reports"), 0);
    assert.equal(runtime.database.inTransaction, false);
  });

  test("exact lookup is read-only and zero evidence fails closed", (t) => {
    const runtime = createRuntime(
      t,
      "hundo-fad-04-report-read-"
    );
    seedLeague(runtime.database, uuid(2), "Original");
    assert.throws(
      () =>
        runtime.repository.findExactSucceededResetEvidence({
          leagueId: uuid(2),
        }),
      (error) =>
        error?.code ===
        RESET_MIGRATION_REPORT_EVIDENCE_CODES
          .candidateMissing
    );
    runtime.repository.commitSucceededResetEvidence(
      commitOptions()
    );
    const before = runtime.database
      .prepare(
        "SELECT * FROM migration_reports ORDER BY id"
      )
      .all();
    const candidates =
      runtime.repository.listResetEvidenceCandidates({
        leagueId: uuid(2),
      });
    runtime.repository.findExactSucceededResetEvidence({
      leagueId: uuid(2),
    });
    const after = runtime.database
      .prepare(
        "SELECT * FROM migration_reports ORDER BY id"
      )
      .all();
    assert.deepEqual(after, before);
    assert.equal(Object.isFrozen(candidates), true);
    assert.equal(Object.isFrozen(candidates[0]), true);
  });
});
