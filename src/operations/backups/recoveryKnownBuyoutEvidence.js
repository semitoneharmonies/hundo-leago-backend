const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { inspectDatabase, calculateManifestChecksum, BACKUP_FILE_NAME } = require("../../infrastructure/database/sqliteBackup");
const { readManifest } = require("./restoreEncryptedBackupToCleanPath");
const { buildBackupAad, migrationChecksumSetId } = require("./createEncryptedOffsiteBackup");
const { buildRecoveryPlanFromLineage, readVerifiedRecoveryParent } = require("./buildRecoveryReconciliationLineage");
const { compareRecoveryLossWindow } = require("./compareRecoveryLossWindow");
const { createBuyoutAggregate, validateBuyoutCommand } = require("../../domain/contracts/buyoutPolicy");
const { createSocketEventEnvelope, createEmptySocketRelated } = require("../../domain/leagues/socketInvalidation");
const { readRows, snapshots } = require("./recoveryAuctionDeltaEvidence");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => canonicalize(a) === canonicalize(b);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
class RecoveryKnownBuyoutError extends Error {
  constructor(code) { super("Known buyout recovery requires exact preserved history and a separately reviewed held copy.");
    this.name = "RecoveryKnownBuyoutError"; this.code = code; }
}
function fail(code) { throw new RecoveryKnownBuyoutError(code); }
function assertReader(database, digest) {
  if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
      !DIGEST.test(digest || "") || fs.lstatSync(database.name).isSymbolicLink() || !fs.statSync(database.name).isFile() ||
      fs.statSync(database.name).nlink !== 1 || (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) ||
      fs.existsSync(`${database.name}-journal`) || hash(fs.readFileSync(database.name)) !== digest) fail("RECOVERY_BUYOUT_SOURCE_INVALID");
}
function only(rows) { if (rows.length !== 1) fail("RECOVERY_BUYOUT_HISTORY_INCOMPLETE"); return rows[0]; }

// The original normal-domain command is recovered from actual records, never
// supplied by a caller. The selected backup and preservation manifests bind
// the two offline copies; this is not proof of external custody or all loss.
function buildKnownBuyoutEvidence(options = {}) {
  try {
    const { preparedDatabase, restoredDatabase, preservedDatabase, credentialPreparation, plan, buyoutId, leagueId,
      observedAtMs, backupManifestBytes, preservationManifestBytes, expectedBackupManifestSha256,
      expectedPreservationManifestSha256, preservedPlaintextSha256, lineage = null, parentProof } = options;
    if (![buyoutId, leagueId].every(value => UUID.test(value || "")) || !safeTime(observedAtMs) ||
        !safeTime(plan?.observedAtMs) || observedAtMs < plan.observedAtMs ||
        ![backupManifestBytes, preservationManifestBytes].every(value => Buffer.isBuffer(value) && value.length > 1 && value.length <= 16 * 1024 * 1024) ||
        ![expectedBackupManifestSha256, expectedPreservationManifestSha256].every(value => DIGEST.test(value || "")) ||
        hash(backupManifestBytes) !== expectedBackupManifestSha256 || hash(preservationManifestBytes) !== expectedPreservationManifestSha256) fail("RECOVERY_BUYOUT_INPUT_INVALID");
    const readers = [preparedDatabase, restoredDatabase, preservedDatabase];
    const digests = [plan.preparedPlaintextSha256, credentialPreparation?.sourcePlaintextSha256, preservedPlaintextSha256];
    readers.forEach((reader, index) => assertReader(reader, digests[index]));
    if (new Set(readers.map(reader => fs.realpathSync(reader.name))).size !== 3) fail("RECOVERY_BUYOUT_SOURCE_REUSED");
    const changes = readers.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    if (parentProof !== undefined && lineage !== null) fail("RECOVERY_BUYOUT_PLAN_INVALID");
    const parent = parentProof !== undefined ? readVerifiedRecoveryParent({ parentProof, database: preparedDatabase, originalPlan: plan, credentialPreparation }) :
      buildRecoveryPlanFromLineage({ database: preparedDatabase, credentialPreparation, lineage, observedAtMs: plan.observedAtMs,
        expectedEnvironmentId: plan.databaseIdentity?.environmentId, expectedDatabaseId: plan.databaseIdentity?.databaseId });
    if (!same(parent, plan)) fail("RECOVERY_BUYOUT_PLAN_INVALID");
    const backup = readManifest(backupManifestBytes), preserved = JSON.parse(preservationManifestBytes.toString("utf8"));
    const startsAtMs = Date.parse(backup.completedAt);
    if (preservationManifestBytes.toString("utf8") !== canonicalize(preserved) + "\n" || preserved.manifestVersion !== 1 ||
        calculateManifestChecksum(preserved) !== preserved.manifestChecksum || preserved.reason !== "incident-preservation" ||
        preserved.backupFileName !== BACKUP_FILE_NAME || preserved.backupId !== "backup-v1-" + preservedPlaintextSha256 ||
        preserved.plaintextSha256 !== preservedPlaintextSha256 || preserved.byteSize !== fs.statSync(preservedDatabase.name).size ||
        preserved.environment !== backup.environment || !["staging", "production"].includes(backup.environment) ||
        backup.environmentId !== parent.databaseIdentity.environmentId || backup.databaseId !== parent.databaseIdentity.databaseId ||
        backup.backupId !== parent.sourceBackupId || backup.plainBackupSha256 !== digests[1] || hash(buildBackupAad(backup)) !== backup.aadSha256 ||
        !same(backup.databaseInspection, inspectDatabase(restoredDatabase.name)) || backup.schemaVersion !== backup.databaseInspection.userVersion ||
        backup.migrationChecksumSetId !== migrationChecksumSetId(backup.databaseInspection.migrations) ||
        !same(preserved.databaseInspection, inspectDatabase(preservedDatabase.name)) ||
        !safeTime(Date.parse(backup.createdAt)) || !safeTime(startsAtMs) || Date.parse(backup.createdAt) > startsAtMs ||
        !safeTime(preserved.capturedAtMs) || startsAtMs > preserved.capturedAtMs || observedAtMs < preserved.capturedAtMs) fail("RECOVERY_BUYOUT_MANIFEST_INVALID");
    const lossWindow = compareRecoveryLossWindow({ restoredDatabase, preservedDatabase, restoredPlaintextSha256: digests[1],
      preservedPlaintextSha256, sourceBackupId: parent.sourceBackupId, expectedEnvironmentId: parent.databaseIdentity.environmentId,
      expectedDatabaseId: parent.databaseIdentity.databaseId, observedAtMs, includeFinancialState: true });
    const before = readRows(preparedDatabase), restored = readRows(restoredDatabase), source = readRows(preservedDatabase);
    const activity = only(source.league_activity.filter(row => row.related_type === "buyout_obligation" && row.related_id === buyoutId && row.league_id === leagueId));
    const metadata = JSON.parse(activity.metadata_json), receipt = metadata.buyoutReceipt;
    const contractEvent = only(source.contract_events.filter(row => row.source_type === "buyout" && row.source_id === buyoutId && row.league_id === leagueId));
    const ownershipEvent = only(source.ownership_events.filter(row => row.source_type === "buyout" && row.source_id === buyoutId && row.league_id === leagueId));
    if (!receipt || !Array.isArray(receipt.years) || !same(receipt.automaticallyCancelledTradeIds, []) ||
        activity.event_type !== "contract_bought_out" || activity.actor_authority !== "manager" ||
        activity.occurred_at_ms < startsAtMs || activity.occurred_at_ms > preserved.capturedAtMs) fail("RECOVERY_BUYOUT_HISTORY_UNSUPPORTED");
    const contract = only(restored.contracts.filter(row => row.id === metadata.contractId && row.league_id === leagueId));
    const ownership = only(restored.player_ownerships.filter(row => row.id === metadata.ownershipId && row.league_id === leagueId));
    const years = restored.contract_years.filter(row => row.contract_id === contract.id && row.league_id === leagueId && ["current", "future"].includes(row.status)).sort((a, b) => a.year_number - b.year_number);
    const command = validateBuyoutCommand({ buyoutId, buyoutYearIds: receipt.years.map(row => row.id), contractEventId: contractEvent.id,
      ownershipEventId: ownershipEvent.id, activityId: activity.id, leagueId, seasonId: ownership.season_id, teamId: ownership.team_id,
      playerId: ownership.player_id, contractId: contract.id, ownershipId: ownership.id, expectedContractVersion: contract.version,
      expectedOwnershipVersion: ownership.version, actorUserId: activity.actor_user_id, actorAuthority: activity.actor_authority,
      confirmed: true, reason: activity.reason, occurredAtMs: activity.occurred_at_ms });
    const aggregate = createBuyoutAggregate({ command, contract, ownership, remainingContractYears: years.map(row => ({ contractYearId: row.id, seasonId: row.season_id, status: row.status })) });
    const contractAfter = { ...contract, status: "eliminated", updated_at_ms: command.occurredAtMs, version: contract.version + 1 };
    if (!same(snapshots({ years: before.contract_years.filter(row => row.contract_id === contract.id && row.league_id === leagueId) }),
      snapshots({ years: restored.contract_years.filter(row => row.contract_id === contract.id && row.league_id === leagueId) })) ||
      !same(snapshots({ years: source.buyout_years.filter(row => row.buyout_obligation_id === buyoutId && row.league_id === leagueId) }),
        snapshots({ years: aggregate.years }))) fail("RECOVERY_BUYOUT_RECORD_CHANGED");
    if (!same(receipt, { commandHash: hash(JSON.stringify(command)), contract: contractAfter, obligation: aggregate.obligation,
      years: aggregate.years, releasedOwnership: ownership, automaticallyCancelledTradeIds: [] }) ||
      !same(metadata, { contractId: command.contractId, ownershipId: command.ownershipId, annualPenaltyCents: aggregate.annualPenaltyCents,
        totalScheduledPenaltyCents: aggregate.totalScheduledPenaltyCents, remainingYears: aggregate.years.length,
        automaticallyCancelledTradeIds: [], buyoutReceipt: receipt })) fail("RECOVERY_BUYOUT_RECEIPT_HISTORY_INVALID");
    // Only a manager action with an unchanged, evidenced manager assignment is
    // supported here. No fake authenticated principal or session is created.
    for (const rows of [before, restored]) {
      const user = rows.users.find(row => row.id === command.actorUserId);
      const assignment = rows.team_manager_assignments.filter(row => row.league_id === leagueId && row.team_id === command.teamId &&
        row.user_id === command.actorUserId && row.status === "accepted" && row.ended_at_ms === null &&
        safeTime(row.accepted_at_ms) && row.accepted_at_ms <= command.occurredAtMs && rows.league_memberships.some(member =>
          member.id === row.membership_id && member.league_id === leagueId && member.user_id === command.actorUserId && member.status === "active"));
      const season = rows.seasons.find(row => row.id === command.seasonId && row.league_id === leagueId);
      if (user?.status !== "active" || assignment.length !== 1 || season?.status !== "active" ||
          !rows.leagues.some(row => row.id === leagueId && row.current_season_id === command.seasonId && row.status !== "deleted") ||
          !rows.teams.some(row => row.id === command.teamId && row.league_id === leagueId && row.status !== "erased") ||
          rows.candidate_cards.some(row => row.league_id === leagueId && row.status === "open") ||
          rows.matchup_weeks.some(row => row.league_id === leagueId && row.status === "live") ||
          rows.trades.some(trade => trade.league_id === leagueId && trade.status === "proposed" && rows.trade_assets.some(asset =>
            asset.trade_id === trade.id && asset.league_id === leagueId && ((asset.asset_type === "contract" && asset.contract_id === contract.id) ||
              (asset.asset_type === "prospect_right" && asset.player_id === command.playerId))))) fail("RECOVERY_BUYOUT_CONTEXT_UNSUPPORTED");
    }
    const expected = JSON.parse(JSON.stringify(before)), effects = [];
    function replace(table, id, old, next) {
      const current = before[table].filter(row => row.id === id), original = restored[table].filter(row => row.id === id), preservedRows = source[table].filter(row => row.id === id);
      if (!same(current, old ? [old] : []) || !same(original, old ? [old] : []) || !same(preservedRows, next ? [next] : [])) fail("RECOVERY_BUYOUT_RECORD_CHANGED");
      expected[table] = [...expected[table].filter(row => row.id !== id), ...(next ? [next] : [])];
      effects.push({ table, id, beforeSha256: old ? hash(canonicalize(old)) : null, afterSha256: next ? hash(canonicalize(next)) : null });
    }
    replace("contracts", contract.id, contract, contractAfter);
    replace("player_ownerships", ownership.id, ownership, null);
    for (const year of years) replace("contract_years", year.id, year, { ...year, status: "eliminated", rollover_at_ms: command.occurredAtMs });
    replace("buyout_obligations", buyoutId, null, aggregate.obligation);
    for (const year of aggregate.years) replace("buyout_years", year.id, null, year);
    const eventScope = { league_id: leagueId, player_id: command.playerId, team_id: command.teamId, actor_user_id: command.actorUserId,
      source_type: "buyout", source_id: buyoutId, reason: command.reason, occurred_at_ms: command.occurredAtMs };
    replace("contract_events", contractEvent.id, null, { id: contractEvent.id, contract_id: contract.id, ...eventScope, event_type: "contract_bought_out",
      metadata_json: JSON.stringify({ aavCents: contract.aav_cents, annualPenaltyCents: aggregate.annualPenaltyCents, remainingYears: years.length,
        automaticallyCancelledTradeIds: [], priorStatus: contract.status, resultingStatus: "eliminated" }) });
    replace("ownership_events", ownershipEvent.id, null, { id: ownershipEvent.id, season_id: command.seasonId, ownership_id: ownership.id,
      ...eventScope, event_type: "player_released_by_buyout", before_metadata_json: JSON.stringify({ ownershipKind: ownership.ownership_kind,
        rosterCategory: ownership.roster_category, version: ownership.version }), after_metadata_json: JSON.stringify({ owned: false }) });
    replace("league_activity", activity.id, null, { id: activity.id, league_id: leagueId, season_id: command.seasonId, event_type: "contract_bought_out",
      actor_user_id: command.actorUserId, actor_authority: command.actorAuthority, team_id: command.teamId, player_id: command.playerId,
      related_type: "buyout_obligation", related_id: buyoutId, display_summary: "Contract bought out; player released.", reason: command.reason,
      metadata_json: activity.metadata_json, occurred_at_ms: command.occurredAtMs });
    // The normal buyout writes this notification in the same transaction.
    // Bind its complete pending record and audience to preserved history;
    // reconstruction never implies that the notification was delivered.
    const notificationId = command.contractEventId;
    replace("outbox_events", notificationId, null, { id: notificationId, league_id: leagueId,
      event_type: "contract.changed", aggregate_type: "contract", aggregate_id: contract.id,
      payload_json: JSON.stringify(createSocketEventEnvelope({ eventId: notificationId, type: "contract.changed", leagueId,
        resourceId: contract.id, version: contractAfter.version, reasonCode: "contract_changed", occurredAt: command.occurredAtMs,
        related: createEmptySocketRelated({ teamId: command.teamId }) })),
      status: "pending", attempt_count: 0, available_at_ms: command.occurredAtMs, published_at_ms: null, last_error_code: null,
      created_at_ms: command.occurredAtMs, updated_at_ms: command.occurredAtMs, version: 1 });
    replace("outbox_event_audiences", notificationId, null, { id: notificationId, league_id: leagueId,
      outbox_event_id: notificationId, audience_kind: "league", team_id: null, user_id: null, created_at_ms: command.occurredAtMs });
    const provenance = { selectedBackupId: backup.backupId, backupManifestSha256: expectedBackupManifestSha256,
      preservationManifestSha256: expectedPreservationManifestSha256, preservationManifestChecksum: preserved.manifestChecksum,
      backupCompletedAtMs: startsAtMs, preservedCapturedAtMs: preserved.capturedAtMs, offlineManifestBindingVerified: true, externalCustodyVerified: false };
    const evidenceSha256 = hash(canonicalize({ provenance, commandHash: receipt.commandHash, effects }));
    const report = { reviewVersion: 1, status: "known-buyout-reviewed-held", recoveryId: parent.recoveryId, recoveryEpoch: parent.recoveryEpoch,
      planChecksum: parent.planChecksum, observedAtMs, buyoutId, leagueId, seasonId: command.seasonId, teamId: command.teamId,
      contractId: command.contractId, playerId: command.playerId, historicalActorUserId: command.actorUserId, historicalOccurredAtMs: command.occurredAtMs,
      historicalAuthority: "manager-in-restored-and-candidate-snapshots", preparedPlaintextSha256: digests[0], restoredPlaintextSha256: digests[1],
      preservedPlaintextSha256, provenance, evidenceSha256, effects, originalCommandSha256: receipt.commandHash,
      financialEffect: { annualPenaltyCents: aggregate.annualPenaltyCents, totalScheduledPenaltyCents: aggregate.totalScheduledPenaltyCents, remainingYears: years.length },
      lossWindowReportChecksum: lossWindow.reportChecksum, recordedLossChanges: lossWindow.changedRecords,
      completeLossWindowEvidence: false, operatorAuthenticated: false, activationReady: false, executable: false };
    const review = Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
    readers.forEach((reader, index) => { assertReader(reader, digests[index]);
      if (reader.prepare("SELECT total_changes() n").get().n !== changes[index]) fail("RECOVERY_BUYOUT_WRITE_DETECTED"); });
    return { review, command, before, expected, tableSnapshots: snapshots(expected) };
  } catch (error) { if (error instanceof RecoveryKnownBuyoutError) throw error; fail("RECOVERY_BUYOUT_EVIDENCE_FAILED"); }
}

function attributeKnownBuyout({ evidence, decision }) {
  if (!decision || Object.keys(decision).sort().join(",") !== "action,evidenceSha256,reasonCode,reconciliationId,reviewChecksum,reviewedByUserId" ||
      decision.action !== "reconstruct-known-buyout-held" || !UUID.test(decision.reconciliationId || "") ||
      !UUID.test(decision.reviewedByUserId || "") || !/^[A-Z][A-Z0-9_]{0,79}$/.test(decision.reasonCode || "") ||
      decision.reviewChecksum !== evidence.review.reportChecksum || decision.evidenceSha256 !== evidence.review.evidenceSha256) fail("RECOVERY_BUYOUT_DECISION_INVALID");
  const { before, review } = evidence, user = before.users.find(row => row.id === decision.reviewedByUserId);
  if (user?.status !== "active" || !before.platform_roles.some(row => row.user_id === user.id && row.role === "platform_administrator" && row.status === "active")) fail("RECOVERY_BUYOUT_REVIEWER_INVALID");
  if (before.security_audit_events.some(row => row.id === decision.reconciliationId) ||
      before.application_metadata.some(row => row.metadata_key === `recovery_known_buyout:${decision.reconciliationId}`)) fail("RECOVERY_BUYOUT_DECISION_REUSED");
  const decisionChecksum = hash(canonicalize(decision));
  const metadata = { metadata_key: `recovery_known_buyout:${decision.reconciliationId}`, metadata_value: canonicalize({ decision, decisionChecksum,
    recoveryId: review.recoveryId, reviewChecksum: review.reportChecksum, planChecksum: review.planChecksum, evidenceSha256: review.evidenceSha256,
    historicalActorUserId: review.historicalActorUserId, historicalOccurredAtMs: review.historicalOccurredAtMs, reconstructedAtMs: review.observedAtMs,
    affectedRecords: review.effects, domainSnapshotSha256: hash(canonicalize(evidence.tableSnapshots)) }), created_at_ms: review.observedAtMs, updated_at_ms: review.observedAtMs };
  const audit = { id: decision.reconciliationId, event_type: "recovery.known_buyout_reconstructed", outcome: "success", actor_user_id: decision.reviewedByUserId,
    target_user_id: null, league_id: review.leagueId, session_id: null, request_correlation_id: review.recoveryId,
    reason_code: `known_buyout_${decisionChecksum}`, network_key_version: null, network_metadata_digest: null, unknown_account_digest: null,
    client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: review.observedAtMs };
  const expected = { ...evidence.expected, application_metadata: [...evidence.expected.application_metadata, metadata],
    security_audit_events: [...evidence.expected.security_audit_events, audit] };
  return { metadata, audit, expected, decisionChecksum };
}

module.exports = { RecoveryKnownBuyoutError, fail, hash, same, assertReader, buildKnownBuyoutEvidence, attributeKnownBuyout, readRows, snapshots };
