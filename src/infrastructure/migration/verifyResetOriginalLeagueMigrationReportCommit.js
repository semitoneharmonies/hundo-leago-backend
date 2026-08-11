const crypto = require("node:crypto");

const {
  canonicalize,
} = require("./sourceInventory");
const {
  findExactResetEvidenceCandidate,
} = require("./migrationReportEvidence");
const {
  verifyResetOriginalLeagueBootstrapStateAfterMigrationReport,
} = require("./verifyResetOriginalLeagueBootstrapContinuity");
const {
  createSqliteRepositoryContext,
} = require("../persistence/sqlite/createSqliteRepositoryContext");

const RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_VERSION =
  1;
const VERIFIED_REPORT_COMMITS = new WeakSet();
const RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES =
  Object.freeze({
    evidenceInvalid:
      "RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_EVIDENCE_INVALID",
    verificationFailed:
      "RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_FAILED",
  });

class ResetOriginalLeagueReportVerificationError
  extends Error {
  constructor(code, options = {}) {
    super(
      "The reset original-league migration report verification failed.",
      options
    );
    this.name =
      "ResetOriginalLeagueReportVerificationError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetOriginalLeagueReportVerificationError(
    code,
    options
  );
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex");
}

function verifyResetOriginalLeagueMigrationReportCommit(
  options
) {
  if (
    !options?.database ||
    options.database.inTransaction !== false
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
        .verificationFailed
    );
  }

  let safeEvidence;
  try {
    const repositoryContext =
      createSqliteRepositoryContext({
        database: options.database,
      });
    safeEvidence =
      repositoryContext.transaction(() => {
        let bootstrap;
        try {
          bootstrap =
            verifyResetOriginalLeagueBootstrapStateAfterMigrationReport(
              options
            );
        } catch (error) {
          fail(
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
              .verificationFailed,
            { cause: error }
          );
        }

        let candidate;
        let row;
        try {
          const rows = options.database.prepare(
            "SELECT * FROM migration_reports " +
              "WHERE league_id = ? " +
              "ORDER BY created_at_ms ASC, id ASC"
          ).all(bootstrap.leagueId);
          if (rows.length !== 1) {
            fail(
              RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
                .evidenceInvalid
            );
          }
          [row] = rows;
          candidate =
            findExactResetEvidenceCandidate({
              leagueId: bootstrap.leagueId,
              rows,
            });
        } catch (error) {
          if (
            error instanceof
            ResetOriginalLeagueReportVerificationError
          ) {
            throw error;
          }
          fail(
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
              .evidenceInvalid,
            { cause: error }
          );
        }

        const projection =
          bootstrap.migrationReportProjection;
        if (
          candidate.id !== row.id ||
          candidate.leagueId !==
            bootstrap.leagueId ||
          candidate.sourceBundleId !==
            projection.sourceBundleId ||
          candidate.resetManifestId !==
            projection.resetManifestId ||
          candidate.databaseSchemaVersion !==
            projection.databaseSchemaVersion ||
          candidate.status !== projection.status ||
          canonicalize(candidate.sourceHashes) !==
            projection.sourceHashesJson ||
          canonicalize(candidate.counts) !==
            projection.countsJson ||
          canonicalize(candidate.totals) !==
            projection.totalsJson ||
          canonicalize(candidate.warnings) !==
            projection.warningsJson ||
          canonicalize(candidate.rejects) !==
            projection.rejectsJson ||
          candidate.startedAtMs !==
            candidate.completedAtMs ||
          candidate.completedAtMs !==
            candidate.createdAtMs
        ) {
          fail(
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
              .evidenceInvalid
          );
        }

        return Object.freeze({
          actorUserId: bootstrap.actorUserId,
          bootstrapStateHash:
            bootstrap.stateHash,
          continuityHash:
            bootstrap.continuityHash,
          createdAtMs: candidate.createdAtMs,
          databaseResourceId:
            bootstrap.databaseResourceId,
          databaseSchemaVersion:
            candidate.databaseSchemaVersion,
          leagueId: candidate.leagueId,
          migrationReportId: candidate.id,
          reportRowHash: hash(row),
          resetManifestId:
            candidate.resetManifestId,
          schemaFingerprint:
            bootstrap.schemaFingerprint,
          seasonId: bootstrap.seasonId,
          sourceBundleId:
            candidate.sourceBundleId,
          stagingDescriptorSha256:
            bootstrap.stagingDescriptorSha256,
          startedAtMs:
            candidate.startedAtMs,
          completedAtMs:
            candidate.completedAtMs,
          verificationHash:
            bootstrap.verificationHash,
          verificationVersion:
            RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_VERSION,
        });
      });
  } catch (error) {
    if (
      error instanceof
      ResetOriginalLeagueReportVerificationError
    ) {
      throw error;
    }
    if (
      error?.cause instanceof
      ResetOriginalLeagueReportVerificationError
    ) {
      throw error.cause;
    }
    fail(
      RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES
        .verificationFailed,
      { cause: error }
    );
  }

  const result = Object.freeze({
    ...safeEvidence,
    postCommitHash: hash(safeEvidence),
    status: "verified",
  });
  VERIFIED_REPORT_COMMITS.add(result);
  return result;
}

function isVerifiedResetOriginalLeagueMigrationReportCommit(
  value
) {
  return (
    value !== null &&
    (typeof value === "object" ||
      typeof value === "function") &&
    VERIFIED_REPORT_COMMITS.has(value)
  );
}

module.exports = {
  RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_ERROR_CODES,
  RESET_ORIGINAL_LEAGUE_REPORT_VERIFICATION_VERSION,
  ResetOriginalLeagueReportVerificationError,
  isVerifiedResetOriginalLeagueMigrationReportCommit,
  verifyResetOriginalLeagueMigrationReportCommit,
};
