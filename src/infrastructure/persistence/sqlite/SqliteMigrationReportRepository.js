const {
  ResetMigrationReportEvidenceError,
  findExactResetEvidenceCandidate,
  validateSucceededResetMigrationReportRow,
} = require("../../migration/migrationReportEvidence");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_BUNDLE_ID_PATTERN =
  /^source-bundle-v1-[a-f0-9]{64}$/;

const MIGRATION_REPORT_REPOSITORY_CODES = Object.freeze({
  argumentInvalid:
    "MIGRATION_REPORT_REPOSITORY_ARGUMENT_INVALID",
  evidenceInvalid:
    "MIGRATION_REPORT_REPOSITORY_EVIDENCE_INVALID",
  evidenceConflict:
    "MIGRATION_REPORT_REPOSITORY_EVIDENCE_CONFLICT",
  leagueMissing:
    "MIGRATION_REPORT_REPOSITORY_LEAGUE_MISSING",
  schemaMismatch:
    "MIGRATION_REPORT_REPOSITORY_SCHEMA_MISMATCH",
  operationFailed:
    "MIGRATION_REPORT_REPOSITORY_OPERATION_FAILED",
});

class MigrationReportRepositoryError extends Error {
  constructor(code, { cause } = {}) {
    super(
      "The reset migration report repository operation failed.",
      cause === undefined ? undefined : { cause }
    );
    this.name = "MigrationReportRepositoryError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new MigrationReportRepositoryError(code, options);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, expectedKeys) {
  if (!isPlainObject(value)) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  return value;
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  return value;
}

function sourceBundleId(value) {
  if (
    typeof value !== "string" ||
    !SOURCE_BUNDLE_ID_PATTERN.test(value)
  ) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function projectionFieldsMatch(row, projection, leagueId) {
  return (
    row.league_id === leagueId &&
    row.source_bundle_id === projection.sourceBundleId &&
    row.reset_manifest_id === projection.resetManifestId &&
    row.database_schema_version ===
      projection.databaseSchemaVersion &&
    row.status === projection.status &&
    row.source_hashes_json === projection.sourceHashesJson &&
    row.counts_json === projection.countsJson &&
    row.totals_json === projection.totalsJson &&
    row.warnings_json === projection.warningsJson &&
    row.rejects_json === projection.rejectsJson
  );
}

function freshCommitFieldsMatch(row, normalized) {
  return (
    row.id === normalized.id &&
    projectionFieldsMatch(
      row,
      normalized.projection,
      normalized.leagueId
    ) &&
    row.started_at_ms === normalized.startedAtMs &&
    row.completed_at_ms === normalized.completedAtMs &&
    row.created_at_ms === normalized.completedAtMs
  );
}

function qualifyingScalar(row, leagueId) {
  return (
    row.league_id === leagueId &&
    row.status === "succeeded" &&
    row.completed_at_ms !== null &&
    row.reset_manifest_id ===
      "2026-season-1-reset-v1" &&
    Number.isSafeInteger(row.database_schema_version) &&
    row.database_schema_version >= 1
  );
}

function normalizeCommitOptions(options) {
  exactObject(options, [
    "id",
    "leagueId",
    "projection",
    "startedAtMs",
    "completedAtMs",
  ]);
  const projection = exactObject(options.projection, [
    "sourceBundleId",
    "resetManifestId",
    "databaseSchemaVersion",
    "status",
    "sourceHashesJson",
    "countsJson",
    "totalsJson",
    "warningsJson",
    "rejectsJson",
  ]);
  const startedAtMs = safeTimestamp(
    options.startedAtMs
  );
  const completedAtMs = safeTimestamp(
    options.completedAtMs
  );
  if (
    completedAtMs < startedAtMs ||
    projection.status !== "succeeded"
  ) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }

  return Object.freeze({
    id: stableId(options.id),
    leagueId: stableId(options.leagueId),
    projection: Object.freeze({
      ...projection,
      sourceBundleId: sourceBundleId(
        projection.sourceBundleId
      ),
      databaseSchemaVersion: positiveInteger(
        projection.databaseSchemaVersion
      ),
    }),
    startedAtMs,
    completedAtMs,
  });
}

function createSqliteMigrationReportRepository({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function" ||
    typeof database.pragma !== "function"
  ) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.argumentInvalid
    );
  }

  let findLeague;
  let findBySourceAndSchema;
  let listByLeague;
  let insertEvidence;
  try {
    findLeague = database.prepare(
      "SELECT id FROM leagues WHERE id = @leagueId LIMIT 2"
    );
    findBySourceAndSchema = database.prepare(`
      SELECT *
      FROM migration_reports
      WHERE source_bundle_id = @sourceBundleId
        AND database_schema_version = @databaseSchemaVersion
      ORDER BY created_at_ms ASC, id ASC
      LIMIT 2
    `);
    listByLeague = database.prepare(`
      SELECT *
      FROM migration_reports
      WHERE league_id = @leagueId
      ORDER BY created_at_ms ASC, id ASC
    `);
    insertEvidence = database.prepare(`
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
        @league_id,
        @source_bundle_id,
        @reset_manifest_id,
        @database_schema_version,
        @status,
        @source_hashes_json,
        @counts_json,
        @totals_json,
        @warnings_json,
        @rejects_json,
        @started_at_ms,
        @completed_at_ms,
        @created_at_ms
      )
    `);
  } catch (error) {
    fail(
      MIGRATION_REPORT_REPOSITORY_CODES.operationFailed,
      { cause: error }
    );
  }

  function listRows(leagueId) {
    const id = stableId(leagueId);
    try {
      return Object.freeze(
        listByLeague
          .all({ leagueId: id })
          .map(freezeRow)
      );
    } catch (error) {
      if (error instanceof MigrationReportRepositoryError) {
        throw error;
      }
      fail(
        MIGRATION_REPORT_REPOSITORY_CODES.operationFailed,
        { cause: error }
      );
    }
  }

  const commitTransaction = database.transaction(
    (normalized) => {
      const {
        id,
        leagueId,
        projection,
        startedAtMs,
        completedAtMs,
      } = normalized;
      const leagues = findLeague.all({ leagueId });
      if (leagues.length !== 1) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES.leagueMissing
        );
      }

      const sourceMatches = findBySourceAndSchema.all({
        sourceBundleId: projection.sourceBundleId,
        databaseSchemaVersion:
          projection.databaseSchemaVersion,
      });
      if (sourceMatches.length > 1) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .evidenceConflict
        );
      }
      const leagueRows = listByLeague.all({ leagueId });
      if (sourceMatches.length === 1) {
        const existing = sourceMatches[0];
        try {
          validateSucceededResetMigrationReportRow(
            existing
          );
        } catch (error) {
          if (
            error instanceof
            ResetMigrationReportEvidenceError
          ) {
            fail(
              MIGRATION_REPORT_REPOSITORY_CODES
                .evidenceConflict,
              { cause: error }
            );
          }
          throw error;
        }
        if (
          !projectionFieldsMatch(
            existing,
            projection,
            leagueId
          )
        ) {
          fail(
            MIGRATION_REPORT_REPOSITORY_CODES
              .evidenceConflict
          );
        }
        const qualifyingLeagueRows = leagueRows.filter(
          (row) => qualifyingScalar(row, leagueId)
        );
        if (
          qualifyingLeagueRows.length !== 1 ||
          qualifyingLeagueRows[0].id !== existing.id
        ) {
          fail(
            MIGRATION_REPORT_REPOSITORY_CODES
              .evidenceConflict
          );
        }
        return Object.freeze({
          row: freezeRow(existing),
          replayed: true,
        });
      }

      const actualSchemaVersion = database.pragma(
        "user_version",
        { simple: true }
      );
      if (
        actualSchemaVersion !==
        projection.databaseSchemaVersion
      ) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .schemaMismatch
        );
      }
      if (
        leagueRows.some((row) =>
          qualifyingScalar(row, leagueId)
        )
      ) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .evidenceConflict
        );
      }

      const row = {
        id,
        league_id: leagueId,
        source_bundle_id: projection.sourceBundleId,
        reset_manifest_id: projection.resetManifestId,
        database_schema_version:
          projection.databaseSchemaVersion,
        status: projection.status,
        source_hashes_json:
          projection.sourceHashesJson,
        counts_json: projection.countsJson,
        totals_json: projection.totalsJson,
        warnings_json: projection.warningsJson,
        rejects_json: projection.rejectsJson,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        created_at_ms: completedAtMs,
      };
      try {
        validateSucceededResetMigrationReportRow(row);
      } catch (error) {
        if (
          error instanceof ResetMigrationReportEvidenceError
        ) {
          fail(
            MIGRATION_REPORT_REPOSITORY_CODES
              .evidenceInvalid,
            { cause: error }
          );
        }
        throw error;
      }

      insertEvidence.run(row);
      let exactCandidate;
      let persistedLeagueRows;
      let persistedSourceMatches;
      try {
        persistedLeagueRows = listByLeague.all({
          leagueId,
        });
        exactCandidate =
          findExactResetEvidenceCandidate({
            leagueId,
            rows: persistedLeagueRows,
          });
        persistedSourceMatches =
          findBySourceAndSchema.all({
            sourceBundleId:
              projection.sourceBundleId,
            databaseSchemaVersion:
              projection.databaseSchemaVersion,
          });
      } catch (error) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .operationFailed,
          { cause: error }
        );
      }
      const inserted = persistedLeagueRows.filter(
        (candidate) => candidate.id === id
      );
      if (
        exactCandidate.id !== id ||
        exactCandidate.leagueId !== leagueId ||
        exactCandidate.sourceBundleId !==
          projection.sourceBundleId ||
        inserted.length !== 1 ||
        !freshCommitFieldsMatch(
          inserted[0],
          normalized
        ) ||
        persistedSourceMatches.length !== 1 ||
        !freshCommitFieldsMatch(
          persistedSourceMatches[0],
          normalized
        )
      ) {
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .operationFailed
        );
      }
      return Object.freeze({
        row: freezeRow(inserted[0]),
        replayed: false,
      });
    }
  );

  return Object.freeze({
    commitSucceededResetEvidence(options) {
      const normalized = normalizeCommitOptions(options);
      try {
        return commitTransaction.immediate(normalized);
      } catch (error) {
        if (
          error instanceof MigrationReportRepositoryError
        ) {
          throw error;
        }
        if (
          error instanceof
          ResetMigrationReportEvidenceError
        ) {
          fail(
            MIGRATION_REPORT_REPOSITORY_CODES
              .evidenceInvalid,
            { cause: error }
          );
        }
        fail(
          MIGRATION_REPORT_REPOSITORY_CODES
            .operationFailed,
          { cause: error }
        );
      }
    },
    findExactSucceededResetEvidence(options) {
      exactObject(options, ["leagueId"]);
      return findExactResetEvidenceCandidate({
        leagueId: stableId(options.leagueId),
        rows: listRows(options.leagueId),
      });
    },
    listResetEvidenceCandidates(options) {
      exactObject(options, ["leagueId"]);
      return listRows(options.leagueId);
    },
  });
}

module.exports = {
  MIGRATION_REPORT_REPOSITORY_CODES,
  MigrationReportRepositoryError,
  createSqliteMigrationReportRepository,
};
