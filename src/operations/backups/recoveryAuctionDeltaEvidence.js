const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildRecoveryAuctionReview } = require("./buildRecoveryAuctionReview");
const { createTargetRepositories } = require("../../bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../infrastructure/security/createSecureRandom");
const { evaluateAuctionResolution } = require("../../domain/auctions/auctionResolutionPolicy");
const { planContractSeasons } = require("../../domain/contracts/contractSeasonPlanner");
const { createNormalContractAggregate } = require("../../domain/contracts/contractPolicy");
const { calculateTeamCap } = require("../../domain/contracts/capPolicy");
const { createRosterAssignmentRecord } = require("../../domain/rosters/rosterAssignmentPolicy");
const { evaluateStructuralRosterLegality } = require("../../domain/rosters/rosterMovementPolicy");
const { createSocketEventEnvelope, createEmptySocketRelated } = require("../../domain/leagues/socketInvalidation");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID_FIELDS = "activityId,auctionEventId,contractEventId,contractId,contractYearIds,futureSeasonIds,outboxEventId,ownershipEventId,ownershipId,resolutionId";
const CHANGED_TABLES = Object.freeze(["auctions", "auction_bids", "job_runs", "seasons", "contracts", "contract_years",
  "contract_events", "player_ownerships", "ownership_events", "auction_events", "auction_resolutions", "league_activity",
  "outbox_events", "outbox_event_audiences"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalize(left) === canonicalize(right);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const fingerprint = rows => ({ count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
const snapshots = rows => Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, fingerprint(values)]));
class RecoveryAuctionDeltaError extends Error {
  constructor(code) {
    super("Auction recovery requires an independently verified domain result in a separate held copy.");
    this.name = "RecoveryAuctionDeltaError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryAuctionDeltaError(code); }
function readRows(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_AUCTION_DELTA_SCHEMA_INVALID");
    return [name, database.prepare(`SELECT * FROM "${name}"`).all()];
  }));
}
function effectivePosition(rows, leagueId, playerId) {
  const corrections = rows.league_player_positions.filter(row => row.league_id === leagueId && row.player_id === playerId && row.ended_at_ms === null);
  if (corrections.length > 1) fail("RECOVERY_AUCTION_DELTA_POSITION_INVALID");
  if (corrections.length === 1) return corrections[0].position_group;
  const positions = [...new Set(rows.player_source_state.filter(row => row.player_id === playerId && row.ended_at_ms === null &&
    row.active === 1 && ["F", "D"].includes(row.normalized_position)).map(row => row.normalized_position))];
  return positions.length === 1 ? positions[0] : null;
}
function winnerLegality(rows, leagueId, seasonId, teamId) {
  const roster = rows.player_ownerships.filter(row => row.league_id === leagueId && row.season_id === seasonId && row.team_id === teamId)
    .sort((a, b) => a.player_id.localeCompare(b.player_id));
  const structural = evaluateStructuralRosterLegality({ leagueId, seasonId, teamId,
    assignments: roster.map(row => ({ leagueId, seasonId, teamId, playerId: row.player_id,
      rosterCategory: row.roster_category, assignedPositionGroup: row.position_group })),
    effectivePositions: roster.map(row => ({ playerId: row.player_id, positionGroup: effectivePosition(rows, leagueId, row.player_id) })) });
  const activePlayers = [], issues = [];
  for (const ownership of roster.filter(row => row.ownership_kind === "Rostered" && row.roster_category === "Active")) {
    const contracts = rows.contracts.filter(row => row.league_id === leagueId && row.player_id === ownership.player_id && row.status === "active");
    if (contracts.length > 1) fail("RECOVERY_AUCTION_DELTA_CONTRACT_INVALID");
    const contract = contracts[0];
    if (!contract || contract.current_team_id !== teamId) {
      issues.push({ code: !contract ? "ACTIVE_CONTRACT_MISSING" : "ACTIVE_CONTRACT_TEAM_MISMATCH",
        playerId: ownership.player_id, ownershipId: ownership.id });
    } else {
      const retained = rows.retention_obligations.filter(row => row.league_id === leagueId && row.contract_id === contract.id && row.status === "active");
      const retainedAavCents = rows.retention_years.filter(row => row.league_id === leagueId && row.season_id === seasonId &&
        row.status === "current" && retained.some(item => item.id === row.retention_obligation_id))
        .reduce((sum, row) => sum + row.retained_aav_cents, 0);
      activePlayers.push({ playerId: ownership.player_id, ownershipId: ownership.id, contractId: contract.id,
        aavCents: contract.aav_cents, retainedAavCents });
    }
  }
  const obligations = (table, yearsTable, foreignKey, idKey, amountKey) => rows[table]
    .filter(row => row.league_id === leagueId && row.responsible_team_id === teamId && row.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id)).flatMap(row => rows[yearsTable]
      .filter(year => year.league_id === leagueId && year[foreignKey] === row.id && year.season_id === seasonId && year.status === "current")
      .map(year => ({ [idKey]: row.id, contractId: row.contract_id, playerId: row.player_id, amountCents: year[amountKey] })));
  const settings = rows.league_settings.filter(row => row.league_id === leagueId);
  if (settings.length !== 1) fail("RECOVERY_AUCTION_DELTA_RULES_INVALID");
  const cap = calculateTeamCap({ leagueId, seasonId, teamId, salaryCapCents: settings[0].salary_cap_cents, activePlayers, issues,
    retentionObligations: obligations("retention_obligations", "retention_years", "retention_obligation_id", "retentionId", "retained_aav_cents"),
    buyoutObligations: obligations("buyout_obligations", "buyout_years", "buyout_obligation_id", "buyoutId", "penalty_cents") });
  const warnings = [...structural.reasons.map(reason => ({ ...reason, teamId })), ...cap.issues.map(issue => ({ ...issue, teamId })),
    ...(cap.overCap ? [{ code: "TEAM_OVER_CAP", teamId }] : [])];
  return { warnings, generalIllegal: warnings.length > 0, cap };
}

// Independently models rows using pure domain policies and the actual read-only
// candidate reader. It never calls a completion writer or claims a job. This
// first supported case is an ordinary winner with no recorded loss and no open
// Candidate Cards/live matchup weeks. Other contexts remain explicitly held.
function expectedRecoveryAuctionDelta({ reviewOptions, identifiers } = {}) {
  try {
    const review = buildRecoveryAuctionReview(reviewOptions), database = reviewOptions.preparedDatabase;
    const changes = database.prepare("SELECT total_changes() n").get().n, before = readRows(database);
    if (!identifiers || Object.keys(identifiers).sort().join(",") !== ID_FIELDS ||
        !Array.isArray(identifiers.contractYearIds) || identifiers.contractYearIds.length !== 3 ||
        !Array.isArray(identifiers.futureSeasonIds) || identifiers.futureSeasonIds.length !== 2) fail("RECOVERY_AUCTION_DELTA_IDS_INVALID");
    const ids = JSON.parse(JSON.stringify(identifiers)), generated = Object.values(ids).flat();
    if (!generated.every(value => UUID.test(value || "")) || new Set(generated).size !== generated.length ||
        Object.values(before).some(rows => rows.some(row => generated.includes(row.id)))) fail("RECOVERY_AUCTION_DELTA_IDS_INVALID");
    const { auctionId, leagueId, seasonId, jobId, observedAtMs: nowMs } = review;
    if (!safeTime(nowMs + 14 * 24 * 60 * 60 * 1000) || review.lossWindow.changedRecords !== 0 ||
        review.requiredReview !== "league-rules-loss-window-and-domain-effects") fail("RECOVERY_AUCTION_DELTA_LOSS_REVIEW_REQUIRED");
    const callbacks = review.contextEvidence.callbacks;
    if (callbacks.openCandidateCardsInLeague !== 0 || callbacks.liveMatchupWeeksInLeague !== 0) fail("RECOVERY_AUCTION_DELTA_CALLBACK_SCOPE_UNSUPPORTED");
    const beforeSnapshots = snapshots(before);
    if (hash(canonicalize(beforeSnapshots)) !== review.contextEvidence.preparedSnapshotSha256) fail("RECOVERY_AUCTION_DELTA_SOURCE_CHANGED");
    const auction = before.auctions.find(row => row.id === auctionId), season = before.seasons.find(row => row.id === seasonId),
      league = before.leagues.find(row => row.id === leagueId), player = before.players.find(row => row.id === auction.player_id),
      job = before.job_runs.find(row => row.id === jobId);
    const position = effectivePosition(before, leagueId, player.id);
    if (league.current_season_id !== seasonId || season.status !== "active" ||
        (season.regular_season_ends_at_ms !== null && nowMs >= season.regular_season_ends_at_ms) ||
        player.status !== "active" || !["F", "D"].includes(position) ||
        before.player_ownerships.some(row => row.league_id === leagueId && row.player_id === player.id) ||
        before.contracts.some(row => row.league_id === leagueId && row.player_id === player.id && row.status === "active") ||
        before.ownership_events.some(row => row.league_id === leagueId && row.player_id === player.id &&
          ["fantasy_elc_declined", "unsigned_prospect_rights_released"].includes(row.event_type)) ||
        before.auction_resolutions.some(row => row.league_id === leagueId && (row.auction_id === auctionId || row.scheduled_occurrence_key === job.occurrence_key))) {
      fail("RECOVERY_AUCTION_DELTA_COMPLETION_UNSUPPORTED");
    }
    const repository = createTargetRepositories({ database, secureRandom: createSecureRandom() }).auctionResolutions;
    const candidate = repository.loadCandidate({ leagueId, auctionId, nowMs });
    const decision = evaluateAuctionResolution({ auction: candidate.auction, bids: candidate.bids, bidHistory: candidate.bidHistory });
    if (decision.outcome !== "winner" || !same(decision, review.pricingPreview.decision) ||
        !Number.isSafeInteger(auction.version + 1) || !Number.isSafeInteger(job.version + 2) ||
        !Number.isSafeInteger(job.attempt_count + 1)) fail("RECOVERY_AUCTION_DELTA_COMPLETION_UNSUPPORTED");
    const winner = decision.winner, teamId = winner.teamId;
    const seasonIdentity = row => ({ id: row.id, leagueId: row.league_id, label: row.label, nhlSeasonKey: row.nhl_season_key, status: row.status });
    const schedule = planContractSeasons({ leagueId, targetSeason: seasonIdentity(season),
      existingSeasons: before.seasons.filter(row => row.league_id === leagueId).map(seasonIdentity),
      futureSeasonIds: ids.futureSeasonIds, termYears: (winner.finalTermYears ?? winner.submittedTermYears), nowMs });
    const contract = createNormalContractAggregate({ contractId: ids.contractId, contractYearIds: ids.contractYearIds.slice(0, (winner.finalTermYears ?? winner.submittedTermYears)),
      contractEventId: ids.contractEventId, leagueId, playerId: player.id, teamId, originalTotalValueCents: winner.finalTotalValueCents,
      termYears: (winner.finalTermYears ?? winner.submittedTermYears), startSeasonId: seasonId, seasonIds: schedule.seasonIds,
      acquisitionSourceType: "auction_resolution", acquisitionSourceId: ids.resolutionId,
      auctionBuyoutLockExpiresAtMs: nowMs + 14 * 24 * 60 * 60 * 1000, actorUserId: null, occurredAtMs: nowMs });
    const occupied = new Set(before.player_ownerships.filter(row => row.league_id === leagueId && row.season_id === seasonId && row.team_id === teamId &&
      row.ownership_kind === "Rostered" && row.roster_category === "Active" && row.position_group === position).map(row => row.slot_number));
    let slotNumber = null;
    for (let slot = 1; slot <= (position === "F" ? 12 : 6); slot += 1) if (!occupied.has(slot)) { slotNumber = slot; break; }
    const ownership = createRosterAssignmentRecord({ id: ids.ownershipId, leagueId, seasonId, playerId: player.id, teamId,
      ownershipKind: "Rostered", rosterCategory: "Active", positionGroup: position, slotNumber,
      acquiredTransactionType: "auction_resolution", acquiredTransactionId: ids.resolutionId, createdAtMs: nowMs, updatedAtMs: nowMs });
    const expected = { ...before, contracts: [...before.contracts, contract.contract], contract_years: [...before.contract_years, ...contract.years],
      contract_events: [...before.contract_events, contract.event], player_ownerships: [...before.player_ownerships, { ...ownership, trade_blocked: 0 }],
      seasons: [...before.seasons, ...schedule.seasonsToCreate.map(row => ({ id: row.id, league_id: leagueId, label: row.label,
        nhl_season_key: row.nhlSeasonKey, status: "planned", regular_season_starts_at_ms: null, regular_season_ends_at_ms: null,
        fantasy_playoffs_start_at_ms: null, fantasy_playoffs_end_at_ms: null, free_agent_draft_completed_at_ms: null,
        created_at_ms: nowMs, updated_at_ms: nowMs, version: 1 }))] };
    const { warnings, generalIllegal, cap } = winnerLegality(expected, leagueId, seasonId, teamId);
    const eligible = new Set(decision.rankedBids.map(row => row.bidId));
    expected.auctions = before.auctions.map(row => row.id === auctionId ? { ...row, status: "resolved", updated_at_ms: nowMs, version: row.version + 1 } : row);
    expected.auction_bids = before.auction_bids.map(row => {
      if (row.league_id !== leagueId || row.auction_id !== auctionId || row.status !== "active") return row;
      if (!Number.isSafeInteger(row.version + 1)) fail("RECOVERY_AUCTION_DELTA_COMPLETION_UNSUPPORTED");
      return { ...row, status: row.id === winner.bidId ? "won" : eligible.has(row.id) ? "lost" : "invalid", version: row.version + 1 };
    });
    const completedJob = { ...job, status: "succeeded", attempt_count: job.attempt_count + 1, lease_owner: null, lease_expires_at_ms: null,
      started_at_ms: nowMs, completed_at_ms: nowMs, result_json: JSON.stringify({ auctionId, outcome: "resolved" }),
      last_error_code: null, updated_at_ms: nowMs, version: job.version + 2 };
    expected.job_runs = before.job_runs.map(row => row.id === jobId ? completedJob : row);
    const add = (table, row) => { expected[table] = [...before[table], row]; };
    add("ownership_events", { id: ids.ownershipEventId, league_id: leagueId, season_id: seasonId, player_id: player.id, team_id: teamId,
      ownership_id: ids.ownershipId, event_type: "auction_player_acquired", actor_user_id: null, source_type: "auction_resolution",
      source_id: ids.resolutionId, before_metadata_json: null, after_metadata_json: JSON.stringify({ ownershipKind: "Rostered",
        rosterCategory: "Active", positionGroup: position, slotNumber }), reason: null, occurred_at_ms: nowMs });
    add("auction_events", { id: ids.auctionEventId, league_id: leagueId, season_id: seasonId, auction_id: auctionId,
      bid_id: winner.bidId, team_id: teamId, actor_user_id: null, event_type: "auction_resolved",
      metadata_json: JSON.stringify({ resolutionId: ids.resolutionId, outcome: "winner", winner, skippedBids: decision.skippedBids, generalIllegal, warnings }), occurred_at_ms: nowMs });
    add("auction_resolutions", { id: ids.resolutionId, league_id: leagueId, season_id: seasonId, auction_id: auctionId,
      scheduled_occurrence_key: job.occurrence_key, outcome_code: "winner", winning_team_id: teamId, winning_bid_id: winner.bidId,
      highest_bid_cents: winner.submittedTotalValueCents, second_price_input_cents: winner.highestCompetingTotalValueCents,
      final_contract_value_cents: winner.finalTotalValueCents, winning_term_years: (winner.finalTermYears ?? winner.submittedTermYears), final_aav_cents: winner.finalAavCents,
      general_illegal: generalIllegal ? 1 : 0, warnings_json: JSON.stringify(warnings), contract_id: ids.contractId, ownership_id: ids.ownershipId,
      trigger_type: "automatic", triggered_by_user_id: null, idempotency_key: job.occurrence_key, status: "resolved", resolved_at_ms: nowMs });
    const bidHistory = before.auction_events.filter(row => row.league_id === leagueId && row.auction_id === auctionId && eligible.has(row.bid_id) &&
      ["auction_started", "bid_submitted", "bid_edited"].includes(row.event_type)).sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.id.localeCompare(b.id)).map(row => {
      let metadata = null; try { metadata = JSON.parse(row.metadata_json); } catch { /* Preserve the domain's bounded history projection. */ }
      const values = row.event_type === "auction_started" ? metadata : metadata?.after;
      return { bidId: row.bid_id, teamId: row.team_id, eventType: row.event_type, totalValueCents: values?.totalValueCents ?? null,
        termYears: values?.termYears ?? null, aavCents: values?.aavCents ?? null, editCount: values?.editCount ?? 0, occurredAtMs: row.occurred_at_ms };
    });
    add("league_activity", { id: ids.activityId, league_id: leagueId, season_id: seasonId, event_type: "auction_signing_completed",
      actor_user_id: null, actor_authority: "system", team_id: teamId, player_id: player.id, related_type: "auction_resolution",
      related_id: ids.resolutionId, display_summary: `${player.full_name} signed through auction.`, reason: null,
      metadata_json: JSON.stringify({ auctionId, resolutionId: ids.resolutionId, playerId: player.id, playerDisplayName: player.full_name, teamId,
        bidId: winner.bidId, contractId: ids.contractId, ownershipId: ids.ownershipId, submittedWinningTotalValueCents: winner.submittedTotalValueCents,
        submittedWinningTermYears: winner.submittedTermYears, submittedWinningAavCents: winner.submittedAavCents,
        finalTotalValueCents: winner.finalTotalValueCents, finalAavCents: winner.finalAavCents, contractTermYears: (winner.finalTermYears ?? winner.submittedTermYears),
        remainingYears: (winner.finalTermYears ?? winner.submittedTermYears), assignmentCategory: "Active", assignmentPositionGroup: position, assignmentSlotNumber: slotNumber,
        generalIllegal, rankedBids: decision.rankedBids, bidHistory }), occurred_at_ms: nowMs });
    add("outbox_events", { id: ids.outboxEventId, league_id: leagueId, event_type: "auction.changed", aggregate_type: "auction", aggregate_id: auctionId,
      payload_json: JSON.stringify(createSocketEventEnvelope({ eventId: ids.outboxEventId, type: "auction.changed", leagueId, resourceId: auctionId,
        version: auction.version + 1, reasonCode: "auction_changed", occurredAt: nowMs, related: createEmptySocketRelated({ auctionId }) })),
      status: "pending", attempt_count: 0, available_at_ms: nowMs, published_at_ms: null, last_error_code: null, created_at_ms: nowMs, updated_at_ms: nowMs, version: 1 });
    add("outbox_event_audiences", { id: ids.outboxEventId, outbox_event_id: ids.outboxEventId, league_id: leagueId,
      audience_kind: "league", team_id: null, user_id: null, created_at_ms: nowMs });
    if (database.prepare("SELECT total_changes() n").get().n !== changes || !same(snapshots(readRows(database)), beforeSnapshots)) fail("RECOVERY_AUCTION_DELTA_SOURCE_CHANGED");
    return { review, identifiers: ids, before, expected, tableSnapshots: snapshots(expected), completedJob, cap,
      expectedCallbacks: { candidateCardsAffected: 0, candidateCardsChanged: 0, lateLockStatus: "not_applicable" } };
  } catch (error) {
    if (error instanceof RecoveryAuctionDeltaError) throw error;
    fail("RECOVERY_AUCTION_DELTA_EVIDENCE_INVALID");
  }
}

// Verifies the worker's domain delta only. An operator action still needs its
// own attribution, elapsed-lease check, receipt, lineage and reopening gates.
// A checksum supplied by the caller never substitutes for rebuilding evidence.
function verifyRecoveryAuctionDelta({ reviewOptions, identifiers, completedDatabase } = {}) {
  try {
    const evidence = expectedRecoveryAuctionDelta({ reviewOptions, identifiers });
    const database = completedDatabase;
    if (!database?.open || database.readonly !== true || database.inTransaction || !path.isAbsolute(database.name || "") ||
        fs.lstatSync(database.name).isSymbolicLink() || !fs.statSync(database.name).isFile() || fs.statSync(database.name).nlink !== 1 ||
        (fs.existsSync(`${database.name}-wal`) && fs.statSync(`${database.name}-wal`).size !== 0) || fs.existsSync(`${database.name}-journal`) ||
        [reviewOptions.preparedDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase]
          .some(reader => fs.realpathSync(reader.name) === fs.realpathSync(database.name))) fail("RECOVERY_AUCTION_DELTA_OUTPUT_INVALID");
    const digest = hash(fs.readFileSync(database.name)), changes = database.prepare("SELECT total_changes() n").get().n;
    const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    if (!same(database.prepare(schemaSql).all(), reviewOptions.preparedDatabase.prepare(schemaSql).all()) ||
        database.pragma("user_version", { simple: true }) !== reviewOptions.preparedDatabase.pragma("user_version", { simple: true }) ||
        !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }]) || database.pragma("foreign_key_check").length !== 0) fail("RECOVERY_AUCTION_DELTA_SCHEMA_INVALID");
    if (!same(snapshots(readRows(database)), evidence.tableSnapshots)) fail("RECOVERY_AUCTION_DELTA_MISMATCH");
    if (hash(fs.readFileSync(database.name)) !== digest || database.prepare("SELECT total_changes() n").get().n !== changes) fail("RECOVERY_AUCTION_DELTA_SOURCE_CHANGED");
    const report = { reportVersion: 1, status: "auction-domain-delta-verified-held", reviewChecksum: evidence.review.reportChecksum,
      preparedPlaintextSha256: evidence.review.preparedPlaintextSha256, completedPlaintextSha256: digest,
      auctionId: evidence.review.auctionId, leagueId: evidence.review.leagueId, jobId: evidence.review.jobId,
      executedAtMs: evidence.review.observedAtMs, identifiers: evidence.identifiers, tableSnapshots: evidence.tableSnapshots,
      completedJobRowSha256: hash(canonicalize(evidence.completedJob)), createdPendingMessages: 1,
      expectedCallbacks: evidence.expectedCallbacks, callbackExecutionVerified: false, operatorAuthenticated: false,
      completeLossWindowEvidence: false, leaseElapsedVerified: false, activationReady: false, executable: false };
    return Object.freeze({ ...report, reportChecksum: hash(canonicalize(report)) });
  } catch (error) {
    if (error instanceof RecoveryAuctionDeltaError) throw error;
    fail("RECOVERY_AUCTION_DELTA_VERIFICATION_FAILED");
  }
}
module.exports = { RecoveryAuctionDeltaError, expectedRecoveryAuctionDelta, verifyRecoveryAuctionDelta, CHANGED_TABLES, readRows, snapshots };
