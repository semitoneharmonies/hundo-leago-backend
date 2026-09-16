const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryPlanFromLineage, readVerifiedRecoveryParent } = require("./buildRecoveryReconciliationLineage");
const { compareRecoveryLossWindow } = require("./compareRecoveryLossWindow");
const { buildAuctionResolutionOccurrenceKey, evaluateAuctionResolution } = require("../../domain/auctions/auctionResolutionPolicy");
const { createTargetRepositories } = require("../../bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../infrastructure/security/createSecureRandom");
const { JOB_TYPE } = require("../../infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalize(left) === canonicalize(right);
const fingerprint = rows => ({ count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
class RecoveryAuctionReviewError extends Error {
  constructor(code) {
    super("Auction recovery review requires an exact held candidate, occurrence and two preserved offline copies.");
    this.name = "RecoveryAuctionReviewError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryAuctionReviewError(code); }
function assertReader(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !DIGEST.test(digest || "") || !fs.statSync(database.name).isFile() || fs.statSync(database.name).nlink !== 1 ||
      fs.lstatSync(database.name).isSymbolicLink() ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`) || hash(fs.readFileSync(database.name)) !== digest) fail("RECOVERY_AUCTION_REVIEW_SOURCE_INVALID");
}
function readAuctionEvidence(database, auctionId, leagueId) {
  const auction = database.prepare("SELECT * FROM auctions WHERE id=? AND league_id=?").get(auctionId, leagueId);
  if (!auction) return { auction: null, bids: [], bidHistory: fingerprint([]), resolutions: [] };
  const bidRows = database.prepare("SELECT * FROM auction_bids WHERE auction_id=? AND league_id=? ORDER BY id").all(auctionId, leagueId);
  const events = database.prepare("SELECT * FROM auction_events WHERE auction_id=? AND league_id=? ORDER BY id").all(auctionId, leagueId);
  const resolutions = database.prepare("SELECT * FROM auction_resolutions WHERE auction_id=? AND league_id=? ORDER BY id").all(auctionId, leagueId);
  const linked = (table, id) => {
    if (id === null) return null;
    const row = database.prepare(`SELECT * FROM ${table} WHERE id=? AND league_id=?`).get(id, leagueId);
    return { id, rowSha256: row ? hash(canonicalize(row)) : null };
  };
  return {
    auction: { id: auction.id, leagueId, seasonId: auction.season_id, playerId: auction.player_id, status: auction.status,
      version: auction.version, resolvesAtMs: auction.resolves_at_ms, rowSha256: hash(canonicalize(auction)) },
    bids: bidRows.map(row => ({ id: row.id, teamId: row.team_id, status: row.status, version: row.version,
      totalValueCents: row.total_value_cents, termYears: row.term_years, rowSha256: hash(canonicalize(row)) })),
    bidHistory: fingerprint(events),
    resolutions: resolutions.map(row => ({ id: row.id, rowSha256: hash(canonicalize(row)), status: row.status,
      outcomeCode: row.outcome_code, resolvedAtMs: row.resolved_at_ms,
      occurrenceKeySha256: hash(canonicalize([row.league_id, JOB_TYPE, row.scheduled_occurrence_key])),
      contract: linked("contracts", row.contract_id), ownership: linked("player_ownerships", row.ownership_id) })),
  };
}

// Builds evidence only. It cannot select a replay disposition, claim a job,
// deliver an event, authenticate an operator, or activate the held database.
function buildRecoveryAuctionReview({ preparedDatabase, restoredDatabase, preservedDatabase, credentialPreparation,
  plan, jobId, auctionId, leagueId, preservedPlaintextSha256, observedAtMs, lineage = null, parentProof } = {}) {
  if (![jobId, auctionId, leagueId].every(value => UUID.test(value || "")) || !safeTime(observedAtMs) ||
      !safeTime(plan?.observedAtMs) || observedAtMs < plan.observedAtMs) fail("RECOVERY_AUCTION_REVIEW_INPUT_INVALID");
  try {
    const readers = [preparedDatabase, restoredDatabase, preservedDatabase];
    const digests = [plan.preparedPlaintextSha256, credentialPreparation?.sourcePlaintextSha256, preservedPlaintextSha256];
    readers.forEach((database, index) => assertReader(database, digests[index]));
    if (new Set(readers.map(database => fs.realpathSync(database.name))).size !== 3) fail("RECOVERY_AUCTION_REVIEW_SOURCE_REUSED");
    const changes = readers.map(database => database.prepare("SELECT total_changes() n").get().n);
    if (parentProof !== undefined && lineage !== null) fail("RECOVERY_AUCTION_REVIEW_PLAN_INVALID");
    const parent = parentProof !== undefined ? readVerifiedRecoveryParent({ parentProof, database: preparedDatabase, originalPlan: plan, credentialPreparation }) :
      buildRecoveryPlanFromLineage({ database: preparedDatabase, credentialPreparation, lineage,
      observedAtMs: plan.observedAtMs, expectedEnvironmentId: plan.databaseIdentity?.environmentId,
      expectedDatabaseId: plan.databaseIdentity?.databaseId });
    if (!same(parent, plan)) fail("RECOVERY_AUCTION_REVIEW_PLAN_INVALID");
    const selected = parent.jobs.find(row => row.id === jobId);
    const job = preparedDatabase.prepare("SELECT * FROM job_runs WHERE id=?").get(jobId);
    const auction = preparedDatabase.prepare("SELECT * FROM auctions WHERE id=? AND league_id=?").get(auctionId, leagueId);
    const context = preparedDatabase.prepare("SELECT * FROM auction_contexts WHERE auction_id=? AND league_id=?").get(auctionId, leagueId);
    const season = auction && preparedDatabase.prepare("SELECT * FROM seasons WHERE id=? AND league_id=?").get(auction.season_id, leagueId);
    if (!auction || !season || !context || context.source_kind !== "ordinary_weekly" ||
        [context.fad_id, context.fad_rollover_id, context.fad_allocation_id, context.fad_origin].some(value => value !== null) ||
        context.season_id !== auction.season_id || auction.status !== "open") fail("RECOVERY_AUCTION_REVIEW_CONTEXT_INVALID");
    if (!job || job.league_id !== leagueId || job.season_id !== auction.season_id ||
        job.job_type !== JOB_TYPE || selected?.disposition !== "held-awaiting-occurrence-evidence" ||
        selected.rowSha256 !== hash(canonicalize(job)) || !["pending", "leased", "running", "failed"].includes(job.status) ||
        !safeTime(job.scheduled_for_ms) || job.scheduled_for_ms > observedAtMs || job.updated_at_ms > observedAtMs ||
        (job.lease_expires_at_ms !== null && job.lease_expires_at_ms > observedAtMs)) fail("RECOVERY_AUCTION_REVIEW_OCCURRENCE_INVALID");
    const dueAtMs = season.fantasy_playoffs_start_at_ms !== null && season.fantasy_playoffs_start_at_ms <= observedAtMs
      ? season.fantasy_playoffs_start_at_ms : auction.resolves_at_ms;
    if (job.scheduled_for_ms !== dueAtMs || job.occurrence_key !== buildAuctionResolutionOccurrenceKey({ auctionId, dueAtMs })) {
      fail("RECOVERY_AUCTION_REVIEW_DEADLINE_INVALID");
    }
    const lossWindow = compareRecoveryLossWindow({ restoredDatabase, preservedDatabase,
      restoredPlaintextSha256: credentialPreparation.sourcePlaintextSha256, preservedPlaintextSha256,
      sourceBackupId: parent.sourceBackupId, expectedEnvironmentId: parent.databaseIdentity.environmentId,
      expectedDatabaseId: parent.databaseIdentity.databaseId, observedAtMs, includeFinancialState: true, includeJobEvidence: true });
    const occurrence = lossWindow.jobEvidence.occurrences.find(row => row.jobId === jobId);
    if (!occurrence?.restored || occurrence.leagueId !== leagueId || occurrence.seasonId !== auction.season_id ||
        occurrence.scheduledForMs !== dueAtMs || occurrence.occurrenceKeySha256 !== hash(canonicalize([leagueId, job.job_type, job.occurrence_key]))) {
      fail("RECOVERY_AUCTION_REVIEW_LOSS_WINDOW_INVALID");
    }
    const candidateState = readAuctionEvidence(preparedDatabase, auctionId, leagueId);
    const restoredState = readAuctionEvidence(restoredDatabase, auctionId, leagueId);
    const preservedState = readAuctionEvidence(preservedDatabase, auctionId, leagueId);
    if (!restoredState.auction || restoredState.auction.seasonId !== auction.season_id) fail("RECOVERY_AUCTION_REVIEW_LOSS_WINDOW_INVALID");
    // Production repositories are composed against the read-only connection;
    // constructors and the candidate reader cannot claim or complete anything.
    const repository = createTargetRepositories({ database: preparedDatabase, secureRandom: createSecureRandom() }).auctionResolutions;
    const candidate = repository.loadCandidate({ leagueId, auctionId, nowMs: observedAtMs });
    if (!candidate) fail("RECOVERY_AUCTION_REVIEW_CANDIDATE_INVALID");
    const pricing = evaluateAuctionResolution({ auction: candidate.auction, bids: candidate.bids });
    const rules = preparedDatabase.prepare("SELECT * FROM league_settings WHERE league_id=? ORDER BY league_id").all(leagueId);
    const callbacks = {
      openCandidateCardsInLeague: preparedDatabase.prepare("SELECT COUNT(*) n FROM candidate_cards c JOIN free_agent_drafts f " +
        "ON f.id=c.fad_id AND f.league_id=c.league_id AND f.season_id=c.season_id WHERE c.league_id=? AND c.status='open' AND f.status='cards_open'").get(leagueId).n,
      liveMatchupWeeksInLeague: preparedDatabase.prepare("SELECT COUNT(*) n FROM matchup_weeks WHERE league_id=? AND status='live'").get(leagueId).n,
      effectsEvaluated: false,
    };
    const contextEvidence = { preparedSnapshotSha256: parent.snapshotSha256, auctionContextRowSha256: hash(canonicalize(context)),
      seasonRowSha256: hash(canonicalize(season)), leagueRules: fingerprint(rules), candidateState, callbacks };
    const recordedCompletion = occurrence.recordedCompletionAfterBackup || occurrence.terminalConflict ||
      preservedState.resolutions.length > 0 || (preservedState.auction !== null && preservedState.auction.status !== "open");
    const report = { reviewVersion: 1, status: "auction-recovery-reviewed-held", recoveryId: parent.recoveryId,
      recoveryEpoch: parent.recoveryEpoch, planChecksum: parent.planChecksum, observedAtMs,
      sourceBackupId: parent.sourceBackupId, preparedPlaintextSha256: parent.preparedPlaintextSha256,
      restoredPlaintextSha256: credentialPreparation.sourcePlaintextSha256, preservedPlaintextSha256,
      auctionId, leagueId, seasonId: auction.season_id, jobId, jobRowSha256: selected.rowSha256,
      occurrenceKeySha256: occurrence.occurrenceKeySha256, originalDeadlineAtMs: auction.resolves_at_ms, dueAtMs,
      contextEvidence, contextSha256: hash(canonicalize(contextEvidence)), restoredState, preservedState,
      bidAuthority: candidate.bids.map(row => ({ bidId: row.id, historicalAuthorityValid: row.authorityValid })),
      pricingPreview: { decision: pricing, completionEligibilityVerified: false, financialEffectsVerified: false },
      lossWindow, lossWindowReportChecksum: lossWindow.reportChecksum,
      requiredReview: recordedCompletion ? "recorded-outcome-and-loss-reconciliation" :
        occurrence.preserved === null || preservedState.auction === null ? "missing-preserved-occurrence-evidence" : "league-rules-loss-window-and-domain-effects",
      completeLossWindowEvidence: false, operatorAuthenticated: false, replayPermitted: false, activationReady: false, executable: false };
    readers.forEach((database, index) => {
      assertReader(database, digests[index]);
      if (database.prepare("SELECT total_changes() n").get().n !== changes[index]) fail("RECOVERY_AUCTION_REVIEW_WRITE_DETECTED");
    });
    return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
  } catch (error) {
    if (error instanceof RecoveryAuctionReviewError) throw error;
    fail("RECOVERY_AUCTION_REVIEW_FAILED");
  }
}
module.exports = { RecoveryAuctionReviewError, buildRecoveryAuctionReview };
