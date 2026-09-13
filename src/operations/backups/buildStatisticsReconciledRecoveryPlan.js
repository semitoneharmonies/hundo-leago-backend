const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryReconciliationPlan } = require("./buildRecoveryReconciliationPlan");
const { readVerifiedRecoveryParent } = require("./buildRecoveryReconciliationLineage");
const { createSqliteStatisticsRepository } = require("../../infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const { PROVIDER_NAME, PLAYER_IDENTITY_PROVIDER } = require("../../infrastructure/nhl/NhlCompletedGameAdapter");
const { assertNhlSeasonKey, normalizeStatisticsRows } = require("../../domain/statistics/statisticsPolicy");
const { createPlayerGameObservationSetEvidence } = require("../../domain/statistics/playerGameStatisticsPolicy");
const { createPlayerGameCoverageSetEvidence } = require("../../domain/statistics/playerGameCoveragePolicy");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left,right) => canonicalize(left) === canonicalize(right);
const fingerprint = rows => ({ count: rows.length,sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STAT_TABLES = ["stat_sources","stat_refreshes","player_stat_totals","player_game_stat_observations",
  "stat_refresh_player_game_sets","stat_refresh_player_game_coverage_entries"];
const time = value => Number.isSafeInteger(value) && value >= 0;
class StatisticsReconciledRecoveryPlanError extends Error {
  constructor(code) {
    super("Statistics recovery review requires the exact original and reconciled held candidates.");
    this.name = "StatisticsReconciledRecoveryPlanError"; this.code = code;
  }
}
function fail(code) { throw new StatisticsReconciledRecoveryPlanError(code); }
function unchanged(database,digest) {
  if (hash(fs.readFileSync(database.name)) !== digest ||
      (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`)) fail("RECOVERY_STATISTICS_PLAN_SOURCE_CHANGED");
}

function verifyStatistics(database,before,after,receipt) {
  const result = receipt.result;
  const refresh = after.stat_refreshes.find(row => row.id === result.refreshId);
  const source = after.stat_sources.find(row => row.id === refresh?.stat_source_id);
  const sets = after.stat_refresh_player_game_sets.filter(row => row.refresh_id === result.refreshId);
  if (!refresh || !source || sets.length !== 1 || source.provider !== PROVIDER_NAME || source.status !== "active" ||
      refresh.nhl_season_key !== receipt.decision.nhlSeasonKey || refresh.status !== "succeeded" || refresh.version !== 2 ||
      refresh.error_code !== null || refresh.metadata_json !== null || refresh.source_version !== result.sourceVersion ||
      refresh.player_count !== result.playerCount || refresh.completed_at_ms !== result.capturedAtMs ||
      !time(refresh.started_at_ms) || refresh.started_at_ms < receipt.executedAtMs || refresh.started_at_ms > result.capturedAtMs ||
      !time(result.capturedAtMs) || result.capturedAtMs > receipt.completedAtMs) fail("RECOVERY_STATISTICS_PLAN_REFRESH_INVALID");
  const oldSource = before.stat_sources.find(row => row.id === source.id);
  const expectedSources = oldSource ? before.stat_sources : [...before.stat_sources,source];
  if ((oldSource && !same(source,oldSource)) || (!oldSource && (source.version !== 1 || !time(source.created_at_ms) ||
      source.created_at_ms < receipt.executedAtMs || source.created_at_ms > receipt.completedAtMs || source.updated_at_ms !== source.created_at_ms)) ||
      !same(fingerprint(expectedSources),fingerprint(after.stat_sources))) fail("RECOVERY_STATISTICS_PLAN_DELTA_INVALID");
  for (const name of STAT_TABLES.filter(name => name !== "stat_sources")) {
    const field = name === "stat_refreshes" ? "id" : "refresh_id";
    if (!same(fingerprint(before[name]),fingerprint(after[name].filter(row => row[field] !== result.refreshId)))) fail("RECOVERY_STATISTICS_PLAN_DELTA_INVALID");
  }
  const set = sets[0],totals = after.player_stat_totals.filter(row => row.refresh_id === result.refreshId);
  const observations = after.player_game_stat_observations.filter(row => row.refresh_id === result.refreshId);
  const coverage = after.stat_refresh_player_game_coverage_entries.filter(row => row.refresh_id === result.refreshId);
  if (set.provider !== PROVIDER_NAME || set.source_version !== result.sourceVersion || set.captured_at_ms !== result.capturedAtMs ||
      [set,...totals,...observations,...coverage].some(row => row.stat_source_id !== source.id || row.nhl_season_key !== receipt.decision.nhlSeasonKey ||
        row.created_at_ms !== result.capturedAtMs) || [set,...observations,...coverage].some(row => row.version !== 1) ||
      [...observations,...coverage].some(row => row.observation_set_id !== set.id) || set.coverage_schema_version !== 1 || set.evidence_schema_version !== 1) {
    fail("RECOVERY_STATISTICS_PLAN_REFRESH_INVALID");
  }
  const repository = createSqliteStatisticsRepository({ database });
  const required = repository.readPlayerGameCoverageRequirements({
    nhlSeasonKey: receipt.decision.nhlSeasonKey,playerIdentityProvider: PLAYER_IDENTITY_PROVIDER });
  // Season totals may include catalogue players outside the league-specific
  // game-coverage requirement set. Resolve totals against the full NHL map.
  const catalog = repository.readNhlCatalogPlayers();
  const players = new Map(catalog.map(row => [row.playerId,row.providerPlayerId]));
  if (players.size !== catalog.length || new Set(players.values()).size !== catalog.length) fail("RECOVERY_STATISTICS_PLAN_TOTALS_INVALID");
  const totalsSourceUpdatedAtMs = totals[0]?.source_updated_at_ms;
  if (!time(totalsSourceUpdatedAtMs) || totalsSourceUpdatedAtMs < refresh.started_at_ms || totalsSourceUpdatedAtMs > result.capturedAtMs) {
    fail("RECOVERY_STATISTICS_PLAN_TOTALS_INVALID");
  }
  const normalized = normalizeStatisticsRows({ minimumPlayerCount: receipt.minimumPlayerCount,sourceUpdatedAtMs: totalsSourceUpdatedAtMs,
    rows: totals.map(row => ({ playerId: players.get(row.player_id),gamesPlayed: row.games_played,goals: row.goals,assists: row.assists })) });
  if (totals.length !== result.playerCount || required.requiredPlayers.some(row => !totals.some(total => total.player_id === row.playerId)) || normalized.some((row,index) =>
    row.nhlPoints !== totals[index].nhl_points || row.fantasyPointsHundredths !== totals[index].fantasy_points_hundredths ||
    row.sourceUpdatedAtMs !== totals[index].source_updated_at_ms)) fail("RECOVERY_STATISTICS_PLAN_TOTALS_INVALID");
  const context = { setId: set.id,statSourceId: source.id,refreshId: refresh.id,nhlSeasonKey: refresh.nhl_season_key,
    provider: set.provider,sourceVersion: set.source_version,capturedAtMs: set.captured_at_ms };
  const games = createPlayerGameObservationSetEvidence({ ...context,observations: observations.map(row => ({
    observationId: row.id,playerId: row.player_id,nhlGameId: row.nhl_game_id,nhlGameScheduledStartsAtMs: row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,goals: row.goals,assists: row.assists,nhlPoints: row.nhl_points,
    fantasyPointsHundredths: row.fantasy_points_hundredths,sourceUpdatedAtMs: row.source_updated_at_ms })) });
  const covered = createPlayerGameCoverageSetEvidence({ ...context,requiredPlayers: required.requiredPlayers,coverage: coverage.map(row => ({
    coverageEntryId: row.id,playerId: row.player_id,providerPlayerId: row.provider_player_id,providerTeamId: row.provider_team_id,
    disposition: row.disposition,nhlGameId: row.nhl_game_id,nhlGameScheduledStartsAtMs: row.nhl_game_scheduled_starts_at_ms })) });
  if (games.evidenceSha256 !== set.evidence_sha256 || games.evidenceSha256 !== result.playerGameEvidenceSha256 ||
      games.observationCount !== set.observation_count || games.observationCount !== result.playerGameObservationCount ||
      covered.coverageSha256 !== set.coverage_sha256 || covered.coverageSha256 !== result.playerGameCoverageSha256 ||
      covered.requiredPlayerCount !== set.required_player_count || covered.requiredPlayerCount !== result.playerGameRequiredPlayerCount ||
      covered.coverageEntryCount !== set.coverage_entry_count || covered.coverageEntryCount !== result.playerGameCoverageEntryCount ||
      covered.expectedPlayerGameCount !== set.expected_player_game_count || covered.expectedPlayerGameCount !== result.playerGameExpectedPlayerGameCount ||
      covered.expectedPlayerGameCount !== games.observationCount) fail("RECOVERY_STATISTICS_PLAN_EVIDENCE_INVALID");
  const expectedGames = coverage.filter(row => row.disposition === "expected_game");
  if (observations.some(row => !expectedGames.some(entry => entry.player_id === row.player_id && entry.nhl_game_id === row.nhl_game_id &&
      entry.nhl_game_scheduled_starts_at_ms === row.nhl_game_scheduled_starts_at_ms)) ||
      required.requiredPlayerGames.some(row => !expectedGames.some(entry => entry.player_id === row.playerId && entry.nhl_game_id === row.nhlGameId &&
        entry.provider_team_id === row.providerTeamId && entry.nhl_game_scheduled_starts_at_ms === row.nhlGameScheduledStartsAtMs))) fail("RECOVERY_STATISTICS_PLAN_EVIDENCE_INVALID");
}

// Recomputes the recorded statistics evidence and exact allowed database delta.
// This read-only next plan never grants replay, delivery or activation authority.
function buildStatisticsReconciledRecoveryPlan({ preparedDatabase,reconciledDatabase,credentialPreparation,
  originalPlan,statisticsReconciliation,observedAtMs,parentProof } = {}) {
  if ([preparedDatabase,reconciledDatabase].some(database => !database?.open || database.readonly !== true || database.inTransaction ||
      !path.isAbsolute(database.name || "")) || !time(observedAtMs) || (parentProof === undefined && originalPlan?.planVersion !== 2) ||
      statisticsReconciliation?.reportVersion !== 1 || statisticsReconciliation.status !== "statistics-reconciled-held" ||
      statisticsReconciliation.activationReady !== false || statisticsReconciliation.normalRuntime !== "blocked-by-durable-recovery-hold" ||
      statisticsReconciliation.reviewEvidence !== "operator-supplied-not-current-authentication" ||
      statisticsReconciliation.providerEvidence !== "fetched-through-nhl-completed-game-adapter" ||
      statisticsReconciliation.otherJobs !== "unchanged-and-held" || statisticsReconciliation.messages !== "unchanged-and-held" ||
      ![statisticsReconciliation.reconciledPlaintextSha256,statisticsReconciliation.reportChecksum].every(value => DIGEST.test(value || ""))) fail("RECOVERY_STATISTICS_PLAN_INPUT_INVALID");
  try {
    if (fs.realpathSync(preparedDatabase.name) === fs.realpathSync(reconciledDatabase.name)) fail("RECOVERY_STATISTICS_PLAN_INPUT_INVALID");
    const parent = parentProof !== undefined ? readVerifiedRecoveryParent({ parentProof,database: preparedDatabase,originalPlan,credentialPreparation }) : buildRecoveryReconciliationPlan({ database: preparedDatabase,credentialPreparation,observedAtMs: originalPlan.observedAtMs,
      expectedEnvironmentId: originalPlan.databaseIdentity?.environmentId,expectedDatabaseId: originalPlan.databaseIdentity?.databaseId });
    if (!same(parent,originalPlan)) fail("RECOVERY_STATISTICS_PLAN_PARENT_INVALID");
    const { reconciledDatabasePath,inspection,reportChecksum,...receipt } = statisticsReconciliation;
    const decision = receipt.decision;
    if (hash(canonicalize(receipt)) !== reportChecksum || receipt.planChecksum !== parent.planChecksum ||
        receipt.sourcePlaintextSha256 !== parent.preparedPlaintextSha256 || receipt.sourceDatabase !== "unchanged" ||
        receipt.recoveryId !== parent.recoveryId || !same(receipt.recoveryEpoch,parent.recoveryEpoch) ||
        !time(receipt.executedAtMs) || receipt.executedAtMs < parent.observedAtMs || !time(receipt.completedAtMs) ||
        receipt.completedAtMs < receipt.executedAtMs || receipt.completedAtMs > observedAtMs ||
        !Number.isSafeInteger(receipt.minimumPlayerCount) || receipt.minimumPlayerCount < 1 || !decision ||
        Object.keys(decision).sort().join(",") !== "evidenceSha256,jobId,nhlSeasonKey,occurrenceKeySha256,reasonCode,reconciliationId,reviewedByUserId,rowSha256" ||
        ![decision.jobId,decision.reconciliationId,decision.reviewedByUserId,receipt.result?.refreshId].every(value => UUID.test(value || "")) ||
        ![decision.evidenceSha256,decision.rowSha256,decision.occurrenceKeySha256].every(value => DIGEST.test(value || "")) ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(decision.reasonCode || "") || hash(canonicalize(decision)) !== receipt.decisionChecksum ||
        receipt.completedJobId !== decision.jobId || receipt.result.status !== "succeeded") fail("RECOVERY_STATISTICS_PLAN_RECEIPT_INVALID");
    assertNhlSeasonKey(decision.nhlSeasonKey);
    unchanged(reconciledDatabase,receipt.reconciledPlaintextSha256);
    const initialChanges = reconciledDatabase.prepare("SELECT total_changes() n").get().n;
    const plan = reconciledDatabase.transaction(() => {
      const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      if (!same(reconciledDatabase.pragma("integrity_check"),[{ integrity_check: "ok" }]) || reconciledDatabase.pragma("foreign_key_check").length !== 0 ||
          reconciledDatabase.pragma("user_version",{ simple: true }) !== parent.schemaVersion ||
          !same(preparedDatabase.prepare(schemaSql).all(),reconciledDatabase.prepare(schemaSql).all())) fail("RECOVERY_STATISTICS_PLAN_SCHEMA_INVALID");
      const names = Object.keys(parent.tableSnapshots).sort();
      const rows = database => Object.fromEntries(names.map(name => {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_STATISTICS_PLAN_SCHEMA_INVALID");
        return [name,database.prepare(`SELECT * FROM "${name}"`).all()];
      }));
      const before = rows(preparedDatabase),after = rows(reconciledDatabase);
      if (!preparedDatabase.prepare("SELECT 1 FROM users u JOIN platform_roles r ON r.user_id=u.id WHERE u.id=? AND u.status='active' AND r.role='platform_administrator' AND r.status='active'").get(decision.reviewedByUserId)) fail("RECOVERY_STATISTICS_PLAN_REVIEWER_INVALID");
      const originalJob = before.job_runs.find(row => row.id === decision.jobId),completed = after.job_runs.find(row => row.id === decision.jobId);
      if (!originalJob || !completed || originalJob.league_id !== null || originalJob.season_id !== null || originalJob.job_type !== "statistics:completed_games" ||
          !["pending","running","failed"].includes(originalJob.status) || originalJob.updated_at_ms > receipt.executedAtMs ||
          originalJob.scheduled_for_ms > receipt.executedAtMs || originalJob.occurrence_key !== `${decision.nhlSeasonKey}:${originalJob.scheduled_for_ms}` ||
          (originalJob.lease_expires_at_ms !== null && originalJob.lease_expires_at_ms > receipt.executedAtMs) ||
          hash(canonicalize(originalJob)) !== decision.rowSha256 || hash(canonicalize([null,originalJob.job_type,originalJob.occurrence_key])) !== decision.occurrenceKeySha256 ||
          !same(JSON.parse(completed.result_json),receipt.result) || hash(canonicalize(completed)) !== receipt.completedJobRowSha256) fail("RECOVERY_STATISTICS_PLAN_JOB_INVALID");
      const expectedJob = { ...originalJob,status: "succeeded",attempt_count: originalJob.attempt_count+1,lease_owner: null,lease_expires_at_ms: null,
        started_at_ms: receipt.executedAtMs,completed_at_ms: receipt.completedAtMs,updated_at_ms: receipt.completedAtMs,version: originalJob.version+2,
        result_json: completed.result_json,last_error_code: null };
      const metadata = { metadata_key: `recovery_statistics_review:${decision.reconciliationId}`,metadata_value: canonicalize({ recoveryId: parent.recoveryId,
        planChecksum: parent.planChecksum,decisionChecksum: receipt.decisionChecksum,decision,minimumPlayerCount: receipt.minimumPlayerCount,
        executedAtMs: receipt.executedAtMs,completedAtMs: receipt.completedAtMs,refreshId: receipt.result.refreshId }),
        created_at_ms: receipt.completedAtMs,updated_at_ms: receipt.completedAtMs };
      const audit = { id: decision.reconciliationId,event_type: "recovery.statistics_reconciled",outcome: "success",actor_user_id: decision.reviewedByUserId,
        target_user_id: null,league_id: null,session_id: null,request_correlation_id: parent.recoveryId,reason_code: `statistics_${receipt.decisionChecksum}`,
        network_key_version: null,network_metadata_digest: null,unknown_account_digest: null,client_metadata_json: '{"networkSourceCategory":"local"}',occurred_at_ms: receipt.completedAtMs };
      const expected = { ...before,job_runs: before.job_runs.map(row => row.id === originalJob.id ? expectedJob : row),
        application_metadata: [...before.application_metadata,metadata],security_audit_events: [...before.security_audit_events,audit] };
      const tableSnapshots = Object.fromEntries(names.map(name => [name,fingerprint(after[name])]));
      if (names.some(name => !STAT_TABLES.includes(name) && !same(fingerprint(expected[name]),tableSnapshots[name])) ||
          !same(tableSnapshots,receipt.tableSnapshots) || receipt.protectedTableCount !== names.length-9 ||
          receipt.unresolvedJobs !== parent.unresolvedJobs-1 || receipt.unresolvedMessages !== parent.unresolvedMessages) fail("RECOVERY_STATISTICS_PLAN_DELTA_INVALID");
      verifyStatistics(reconciledDatabase,before,after,receipt);
      const jobs = parent.jobs.map(row => row.id !== decision.jobId ? row : { ...row,status: completed.status,version: completed.version,
        rowSha256: hash(canonicalize(completed)),leaseExpired: null,disposition: "preserve-recorded-result",executionPermitted: false });
      const { planChecksum,...original } = parent;
      return { ...original,planVersion: 4,observedAtMs,previousPlanChecksum: planChecksum,credentialPreparedPlaintextSha256: credentialPreparation.preparedPlaintextSha256,
        preparedPlaintextSha256: receipt.reconciledPlaintextSha256,statisticsReconciliationChecksum: reportChecksum,
        tableSnapshots,snapshotSha256: hash(canonicalize(tableSnapshots)),jobs,unresolvedJobs: receipt.unresolvedJobs,activationReady: false,executable: false };
    }).deferred();
    unchanged(preparedDatabase,parent.preparedPlaintextSha256);unchanged(reconciledDatabase,receipt.reconciledPlaintextSha256);
    if (reconciledDatabase.prepare("SELECT total_changes() n").get().n !== initialChanges) fail("RECOVERY_STATISTICS_PLAN_WRITE_DETECTED");
    return Object.freeze({ ...plan,planChecksum: hash(canonicalize(plan)) });
  } catch (error) {
    if (error instanceof StatisticsReconciledRecoveryPlanError) throw error;
    fail("RECOVERY_STATISTICS_PLAN_VERIFICATION_FAILED");
  }
}

module.exports = { StatisticsReconciledRecoveryPlanError,buildStatisticsReconciledRecoveryPlan };
