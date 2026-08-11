const crypto = require("node:crypto");

const {
  canonicalize,
} = require("../../../infrastructure/migration/sourceInventory");
const {
  readResetOriginalLeagueContinuityCommitProjection,
} = require("../../../infrastructure/migration/verifyResetOriginalLeagueBootstrapContinuity");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES =
  Object.freeze({
    continuityInvalid:
      "RESET_MIGRATION_REPORT_COMMIT_CONTINUITY_INVALID",
    inputInvalid:
      "RESET_MIGRATION_REPORT_COMMIT_INPUT_INVALID",
    persistenceFailed:
      "RESET_MIGRATION_REPORT_COMMIT_PERSISTENCE_FAILED",
  });

class ResetMigrationReportCommitError
  extends Error {
  constructor(code, options = {}) {
    super(
      "The reset migration report commit cannot be completed.",
      options
    );
    this.name =
      "ResetMigrationReportCommitError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetMigrationReportCommitError(
    code,
    options
  );
}

function exactObject(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !keys.includes(key)
    )
  ) {
    fail(
      RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
        .inputInvalid
    );
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `reset migration report commit requires ${description}`
    );
  }
}

function rowHash(row) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(row))
    .digest("hex");
}

function createResetMigrationReportCommitService({
  database,
  repositoryContext,
  migrationReportRepository,
  verifyContinuity,
  clock,
  secureRandom,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "reset migration report commit requires an opened SQLite database"
    );
  }
  requireMethod(
    repositoryContext,
    "transaction",
    "the SQLite repository context"
  );
  requireMethod(
    migrationReportRepository,
    "commitSucceededResetEvidence",
    "the insert-only migration report repository"
  );
  if (typeof verifyContinuity !== "function") {
    throw new TypeError(
      "reset migration report commit requires trusted continuity verification"
    );
  }
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function commit(input = {}) {
    exactObject(input, []);
    try {
      return repositoryContext.transaction(() => {
        const nowMs = clock.nowMs();
        const reportId = secureRandom.id();
        if (
          !Number.isSafeInteger(nowMs) ||
          nowMs < 0 ||
          !UUID_PATTERN.test(reportId || "")
        ) {
          fail(
            RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
              .inputInvalid
          );
        }
        let continuity;
        let projection;
        try {
          continuity = verifyContinuity();
          projection =
            readResetOriginalLeagueContinuityCommitProjection({
              continuity,
              database,
            });
        } catch (error) {
          fail(
            RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
              .continuityInvalid,
            { cause: error }
          );
        }

        let persisted;
        try {
          persisted =
            migrationReportRepository
              .commitSucceededResetEvidence({
            id: reportId,
            leagueId: continuity.leagueId,
            projection,
            startedAtMs: nowMs,
            completedAtMs: nowMs,
          });
        } catch (error) {
          fail(
            RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
              .persistenceFailed,
            { cause: error }
          );
        }
        const { row } = persisted || {};
        if (
          persisted.replayed !== false ||
          !row ||
          row.id !== reportId ||
          row.league_id !== continuity.leagueId ||
          row.source_bundle_id !==
            projection.sourceBundleId ||
          row.reset_manifest_id !==
            projection.resetManifestId ||
          row.database_schema_version !==
            projection.databaseSchemaVersion ||
          row.status !== "succeeded" ||
          row.started_at_ms !== nowMs ||
          row.completed_at_ms !== nowMs ||
          row.created_at_ms !== nowMs
        ) {
          fail(
            RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
              .persistenceFailed
          );
        }
        return Object.freeze({
          bootstrapStateHash:
            continuity.stateHash,
          createdAtMs: row.created_at_ms,
          databaseSchemaVersion:
            row.database_schema_version,
          leagueId: row.league_id,
          migrationReportId: row.id,
          reportRowHash: rowHash(row),
          resetManifestId:
            row.reset_manifest_id,
          sourceBundleId: row.source_bundle_id,
          startedAtMs: row.started_at_ms,
          completedAtMs: row.completed_at_ms,
          status: row.status,
        });
      });
    } catch (error) {
      if (
        error instanceof
        ResetMigrationReportCommitError
      ) {
        throw error;
      }
      if (
        error?.cause instanceof
        ResetMigrationReportCommitError
      ) {
        throw error.cause;
      }
      fail(
        RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES
          .persistenceFailed,
        { cause: error }
      );
    }
  }

  return Object.freeze({ commit });
}

module.exports = {
  RESET_MIGRATION_REPORT_COMMIT_ERROR_CODES,
  ResetMigrationReportCommitError,
  createResetMigrationReportCommitService,
};
