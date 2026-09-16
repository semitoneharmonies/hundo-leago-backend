const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryPlanFromLineage } = require("./buildRecoveryReconciliationLineage");
const { compareRecoveryLossWindow } = require("./compareRecoveryLossWindow");
const { inspectRecoveryInventory } = require("./inspectRecoveryInventory");
const { inspectRecoveryFinancialConsistency } = require("./inspectRecoveryFinancialConsistency");
const { createSqliteCapReadRepository } = require("../../infrastructure/persistence/sqlite/SqliteCapReadRepository");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalize(left) === canonicalize(right);
const DIGEST = /^[a-f0-9]{64}$/;
class RecoveryCompletionReviewError extends Error {
  constructor(code) {
    super("Recovery completion review requires unchanged offline copies and their complete verified recovery history.");
    this.name = "RecoveryCompletionReviewError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryCompletionReviewError(code); }
function assertReader(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction ||
      !path.isAbsolute(database.name || "") || !DIGEST.test(digest || "")) fail("RECOVERY_COMPLETION_INPUT_INVALID");
  const stat = fs.lstatSync(database.name);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`) || hash(fs.readFileSync(database.name)) !== digest) {
    fail("RECOVERY_COMPLETION_SOURCE_INVALID");
  }
}

// Both comparisons are rebuilt from the three actual read-only copies below.
// Hash convergence describes stored rows only. A preserved row can itself need
// correction, credentials must remain revoked, and delivery needs outside proof.
function recordedLossProgress(lossWindow, candidateChanges) {
  const counts = { matchesPreserved: 0, stillAtBackupState: 0, differentFromBoth: 0 };
  const tables = {};
  let candidateOnlyChangedRecords = 0;
  for (const [table, loss] of Object.entries(lossWindow.tables)) {
    const candidate = new Map(candidateChanges.tables[table].changes.map(row => [row.keySha256, row]));
    const lostKeys = new Set(loss.changes.map(row => row.keySha256));
    candidateOnlyChangedRecords += [...candidate.keys()].filter(key => !lostKeys.has(key)).length;
    if (loss.changes.length === 0) continue;
    tables[table] = loss.changes.map(row => {
      // An unchanged candidate row does not appear in the candidate delta.
      // Null means the row is absent, including a reconstructed deletion.
      const candidateRowSha256 = candidate.has(row.keySha256) ? candidate.get(row.keySha256).preservedRowSha256 : row.restoredRowSha256;
      const status = candidateRowSha256 === row.preservedRowSha256 ? "matchesPreserved"
        : candidateRowSha256 === row.restoredRowSha256 ? "stillAtBackupState" : "differentFromBoth";
      counts[status] += 1;
      return { keySha256: row.keySha256, kind: row.kind, restoredRowSha256: row.restoredRowSha256,
        preservedRowSha256: row.preservedRowSha256, candidateRowSha256, status,
        credentialBoundaryApplies: ["sessions", "account_action_tokens"].includes(table),
        externalOutcomeEvidenceRequired: ["job_runs", "outbox_events"].includes(table) };
    });
  }
  return { scope: "recorded-row-convergence-only", lossComparisonChecksum: lossWindow.reportChecksum,
    candidateComparisonChecksum: candidateChanges.reportChecksum, totalChangedRecords: lossWindow.changedRecords,
    counts, tables, candidateOnlyChangedRecords,
    allRecordedRowsMatchPreserved: counts.matchesPreserved === lossWindow.changedRecords,
    preservedStateIsApproved: false, completeLossWindowEvidence: false, activationReady: false, executable: false };
}

// This projection uses the application's current-season cap policy. An over-cap
// roster is a reported warning, not permission to erase a binding transaction.
// Other financial/ownership invariants still require the full recovery review.
function currentCaps(database) {
  return database.transaction(() => {
    const repository = createSqliteCapReadRepository({ database });
    const leagues = database.prepare("SELECT id,current_season_id FROM leagues ORDER BY id").all();
    const results = leagues.map(league => {
      const teams = database.prepare("SELECT id FROM teams WHERE league_id=? ORDER BY id").all(league.id);
      if (league.current_season_id === null) return { leagueId: league.id, seasonId: null,
        teamCount: teams.length, issue: "CURRENT_SEASON_NOT_CONFIGURED", teams: [] };
      const season = database.prepare("SELECT id FROM seasons WHERE id=? AND league_id=?").get(league.current_season_id, league.id);
      if (!season) fail("RECOVERY_COMPLETION_SEASON_INVALID");
      return { leagueId: league.id, seasonId: season.id, teamCount: teams.length, issue: null,
        teams: teams.map(team => {
          const result = repository.calculate({ leagueId: league.id, seasonId: season.id, teamId: team.id });
          return { teamId: team.id, capLimitCents: result.capLimitCents, capUsageCents: result.capUsageCents,
            capSpaceCents: result.capSpaceCents, overCap: result.overCap, complete: result.complete,
            breakdown: result.breakdown, activePlayerCount: result.activePlayers.length,
            retentionCount: result.retentionObligations.length, buyoutCount: result.buyoutObligations.length,
            issues: result.issues.map(issue => ({ code: issue.code, recordSha256: hash(canonicalize(issue)) })),
            calculationSha256: hash(canonicalize(result)) };
        }) };
    });
    return { scope: "current-season-cap-policy", unit: "integer-cents", leagues: results,
      unconfiguredLeagues: results.filter(row => row.issue !== null).length,
      incompleteTeams: results.flatMap(row => row.teams).filter(row => !row.complete).length,
      overCapTeams: results.flatMap(row => row.teams).filter(row => row.overCap).length,
      completeFinancialReconciliation: false };
  }).deferred();
}

// A read-only evidence assembly, never an activation receipt. In particular,
// equal copies do not prove that all evidence from the loss window was preserved.
function buildRecoveryCompletionReview({ candidateDatabase, restoredDatabase, preservedDatabase,
  credentialPreparation, plan, preservedPlaintextSha256, expectedEnvironmentId, expectedDatabaseId,
  observedAtMs, lineage = null } = {}) {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 ||
      !Number.isSafeInteger(plan?.observedAtMs) || observedAtMs < plan.observedAtMs) fail("RECOVERY_COMPLETION_INPUT_INVALID");
  try {
    const readers = [candidateDatabase, restoredDatabase, preservedDatabase];
    const digests = [plan.preparedPlaintextSha256, credentialPreparation?.sourcePlaintextSha256, preservedPlaintextSha256];
    readers.forEach((reader, index) => assertReader(reader, digests[index]));
    if (new Set(readers.map(reader => fs.realpathSync(reader.name))).size !== readers.length) fail("RECOVERY_COMPLETION_SOURCE_REUSED");
    const changes = readers.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    const verified = buildRecoveryPlanFromLineage({ database: candidateDatabase, credentialPreparation, lineage,
      observedAtMs: plan.observedAtMs, expectedEnvironmentId, expectedDatabaseId });
    if (!same(verified, plan)) fail("RECOVERY_COMPLETION_PLAN_INVALID");
    const comparison = { restoredDatabase, restoredPlaintextSha256: credentialPreparation.sourcePlaintextSha256,
      sourceBackupId: verified.sourceBackupId, expectedEnvironmentId, expectedDatabaseId, observedAtMs,
      includeFinancialState: true, includeJobEvidence: true };
    const lossWindow = compareRecoveryLossWindow({ ...comparison, preservedDatabase, preservedPlaintextSha256 });
    const candidateChanges = compareRecoveryLossWindow({ ...comparison, preservedDatabase: candidateDatabase,
      preservedPlaintextSha256: verified.preparedPlaintextSha256 });
    const lossProgress = recordedLossProgress(lossWindow, candidateChanges);
    const inventory = inspectRecoveryInventory({ database: candidateDatabase, expectedEnvironmentId, expectedDatabaseId, observedAtMs });
    const caps = currentCaps(candidateDatabase);
    const financialConsistency = Object.fromEntries([
      ["restored", restoredDatabase, digests[1]], ["preserved", preservedDatabase, digests[2]], ["candidate", candidateDatabase, digests[0]],
    ].map(([name, database, plaintextSha256]) => [name, inspectRecoveryFinancialConsistency({
      database, plaintextSha256, expectedEnvironmentId, expectedDatabaseId, observedAtMs,
    })]));
    const unresolvedJobs = verified.jobs.filter(row => row.disposition === "held-awaiting-occurrence-evidence");
    const unresolvedMessages = verified.outbox.filter(row => row.disposition === "held-awaiting-delivery-evidence");
    if (unresolvedJobs.length !== verified.unresolvedJobs || unresolvedMessages.length !== verified.unresolvedMessages ||
        inventory.sessions.active !== 0 || Object.values(inventory.activeActionTokens).some(count => count !== 0)) {
      fail("RECOVERY_COMPLETION_STATE_INVALID");
    }
    const report = { reviewVersion: 1, status: "recovery-completion-reviewed-held", observedAtMs,
      recoveryId: verified.recoveryId, recoveryEpoch: verified.recoveryEpoch, sourceBackupId: verified.sourceBackupId,
      databaseIdentity: verified.databaseIdentity, schemaVersion: verified.schemaVersion,
      planChecksum: verified.planChecksum, candidateSnapshotSha256: verified.snapshotSha256,
      candidatePlaintextSha256: digests[0], restoredPlaintextSha256: digests[1], preservedPlaintextSha256,
      lineageVerified: true, credentialBoundaryVerified: true, inventory, lossWindow, candidateChanges, recordedLossProgress: lossProgress,
      currentCaps: caps, financialConsistency,
      dispositions: { unresolvedJobs: unresolvedJobs.length, unresolvedMessages: unresolvedMessages.length,
        jobs: unresolvedJobs.map(row => ({ id: row.id, leagueId: row.leagueId, jobType: row.jobType,
          status: row.status, rowSha256: row.rowSha256 })),
        messages: unresolvedMessages.map(row => ({ id: row.id, leagueId: row.leagueId,
          eventType: row.eventType, channel: row.channel, status: row.status, rowSha256: row.rowSha256 })),
        terminalRecordsAreExternalOutcomeProof: false },
      gates: [
        { id: "exact-job-and-outbox-dispositions", status: unresolvedJobs.length + unresolvedMessages.length === 0 ? "no-held-records" : "pending",
          externalOutcomeEvidenceVerified: false },
        { id: "financial-and-league-state-reconciliation", status: "pending",
          recordedTotalsCompared: true, currentCapsCalculated: true,
          recordedRelationsChecked: true, candidateFindingCount: financialConsistency.candidate.findings.length },
        { id: "loss-window-and-preservation-evidence", status: "pending", recordedChangedRecords: lossWindow.changedRecords,
          recordedRowsMatchingPreserved: lossProgress.counts.matchesPreserved,
          recordedRowsNotMatchingPreserved: lossProgress.counts.stillAtBackupState + lossProgress.counts.differentFromBoth },
        { id: "authenticated-maintenance-and-isolation", status: "pending" },
        { id: "verified-post-recovery-offsite-backup", status: "pending" },
        { id: "controlled-reopening-and-monitoring", status: "pending" },
        { id: "administrator-incident-closeout", status: "pending" },
      ], evidenceScope: "verified-offline-candidate-and-recorded-comparisons",
      completeLossWindowEvidence: false, completeFinancialReconciliation: false,
      preservationProvenanceVerified: false, authenticatedMaintenanceVerified: false,
      postRecoveryOffsiteBackupVerified: false, operatorAuthenticated: false, activationReady: false, executable: false };
    readers.forEach((reader, index) => {
      assertReader(reader, digests[index]);
      if (reader.prepare("SELECT total_changes() n").get().n !== changes[index]) fail("RECOVERY_COMPLETION_WRITE_DETECTED");
    });
    return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
  } catch (error) {
    if (error instanceof RecoveryCompletionReviewError) throw error;
    fail("RECOVERY_COMPLETION_VERIFICATION_FAILED");
  }
}
module.exports = { RecoveryCompletionReviewError, buildRecoveryCompletionReview };
