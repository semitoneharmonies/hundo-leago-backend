const crypto = require("node:crypto");

const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  calculateStandingsResultSetHash,
} = require(
  "../../../domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  hashCanonicalJsonV1,
  hashSeasonRolloverItem,
  hashSeasonRolloverManifest,
  hashSeasonRolloverSourceReadiness,
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LIFECYCLE_OPERATION =
  "league.lifecycle.transition.v2";
const SETUP_EXEMPTION_KIND =
  "initial_season2_transition";
const RESET_MANIFEST_ID =
  "2026-season-1-reset-v1";
const RESET_BOOTSTRAP_OPERATION =
  "admin.league.bootstrap_reset_original.v1";

const REPOSITORY_METHODS = Object.freeze([
  "findIdempotencyRequest",
  "findDurableSeasonRolloverAttempt",
  "findDurableSeasonRolloverResult",
  "findDurableSeasonRolloverOwnershipReceipt",
  "findDurableSetupExemptionResult",
  "findRolloverBindingByOccurrence",
  "findSeasonRolloverAttemptByIdempotencyRequest",
  "findLatestSeasonRolloverAttempt",
  "validateScheduledRolloverJobLease",
  "beginSeasonRolloverAttempt",
  "readSeasonRolloverContext",
  "blockSeasonRolloverAttempt",
  "commitSeasonRolloverAndOpenDraft",
  "readInitialSeason2ExemptionContext",
  "verifyInitialSeason2Evidence",
  "insertStartedIdempotencyRequest",
  "appendSetupExemptionEvidence",
  "insertSetupExemption",
  "verifySetupExemptionEvidence",
  "completeIdempotencyRequest",
]);

const SUMMARY_KEYS = Object.freeze([
  "contractsAdvanced",
  "contractsExpired",
  "ownershipsCarried",
  "ownershipsReleased",
  "retentionYearsAdvanced",
  "retentionObligationsCompleted",
  "buyoutYearsAdvanced",
  "buyoutObligationsCompleted",
  "tradesCancelled",
]);

const SOURCE_COLLECTIONS = Object.freeze([
  [
    "freeAgentDraftTeams",
    "free_agent_draft_teams",
    "fad_id = @fadId",
    "team_id, id",
  ],
  [
    "candidateCards",
    "candidate_cards",
    "fad_id = @fadId",
    "team_id, id",
  ],
  [
    "candidateCardEntries",
    "candidate_card_entries",
    "fad_id = @fadId",
    "card_id, requested_slot_group, requested_slot_number, id",
  ],
  [
    "candidateCardRevisions",
    "candidate_card_revisions",
    "fad_id = @fadId",
    "card_id, resulting_card_version, id",
  ],
  [
    "candidateCardHelpRequests",
    "candidate_card_help_requests",
    "fad_id = @fadId",
    "card_id, requested_at_ms, id",
  ],
  [
    "candidateCardSnapshots",
    "candidate_card_snapshots",
    "fad_id = @fadId",
    "team_id, id",
  ],
  [
    "candidateCardSnapshotEntries",
    "candidate_card_snapshot_entries",
    "fad_id = @fadId",
    "snapshot_id, slot_group, slot_number, id",
  ],
  [
    "freeAgentDraftPlayerAllocations",
    "free_agent_draft_player_allocations",
    "fad_id = @fadId",
    "player_id, id",
  ],
  [
    "freeAgentDraftAllocationEvents",
    "free_agent_draft_allocation_events",
    "fad_id = @fadId",
    "allocation_id, occurred_at_ms, id",
  ],
  [
    "freeAgentDraftRollovers",
    "free_agent_draft_rollovers",
    "fad_id = @fadId",
    "sequence, id",
  ],
  [
    "freeAgentDraftNominationQueue",
    "free_agent_draft_nomination_queue",
    "fad_id = @fadId",
    "accepted_at_ms, id",
  ],
  [
    "freeAgentDraftRecoveries",
    "free_agent_draft_recoveries",
    "fad_id = @fadId",
    "created_at_ms, id",
  ],
  [
    "auctionContexts",
    "auction_contexts",
    "season_id = @seasonId",
    "auction_id, id",
  ],
  [
    "freeAgentDraftAuctionParticipants",
    "free_agent_draft_auction_participants",
    "fad_id = @fadId",
    "auction_id, team_id, id",
  ],
  [
    "freeAgentDraftDraws",
    "free_agent_draft_draws",
    "fad_id = @fadId",
    "auction_id, id",
  ],
  [
    "matchupWeeks",
    "matchup_weeks",
    "season_id = @seasonId",
    "sequence, id",
  ],
  [
    "matchups",
    "matchups",
    "season_id = @seasonId",
    "matchup_week_id, id",
  ],
  [
    "matchupResults",
    "matchup_results",
    "season_id = @seasonId",
    "matchup_id, id",
  ],
  [
    "matchupResultVersions",
    "matchup_result_versions",
    "season_id = @seasonId",
    "matchup_result_id, version_number, id",
  ],
  [
    "matchupOperations",
    "matchup_operations",
    "season_id = @seasonId",
    "started_at_ms, id",
  ],
  [
    "standingsOperations",
    "standings_operations",
    "season_id = @seasonId",
    "started_at_ms, id",
  ],
  [
    "jobRuns",
    "job_runs",
    "season_id = @seasonId",
    "job_type, occurrence_key, id",
  ],
  [
    "trades",
    "trades",
    "season_id = @seasonId",
    "id",
  ],
  [
    "tradeAssets",
    "trade_assets",
    "trade_id IN (SELECT id FROM trades WHERE league_id = @leagueId AND season_id = @seasonId)",
    "trade_id, sequence, id",
  ],
]);

const EFFECT_ORDINALS = Object.freeze({
  contract_advanced: 1,
  contract_expired: 2,
  ownership_carried: 3,
  ownership_released: 4,
  retention_year_advanced: 5,
  retention_obligation_completed: 6,
  buyout_year_advanced: 7,
  buyout_obligation_completed: 8,
  trade_cancelled: 9,
});

const EFFECT_ENTITY_TYPES = Object.freeze({
  contract_advanced: "contract",
  contract_expired: "contract",
  ownership_carried: "player_ownership",
  ownership_released: "player_ownership",
  retention_year_advanced: "retention_obligation",
  retention_obligation_completed:
    "retention_obligation",
  buyout_year_advanced: "buyout_obligation",
  buyout_obligation_completed:
    "buyout_obligation",
  trade_cancelled: "trade",
});

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
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

function exactObject(value, keys, message) {
  if (!isPlainObject(value)) invalid(message);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    invalid(message);
  }
  return value;
}

function stableId(value, description = "identifier") {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function nullableId(value, description) {
  return value === null
    ? null
    : stableId(value, description);
}

function safeTimestamp(
  value,
  description = "timestamp"
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveInteger(
  value,
  description = "integer"
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(`A positive ${description} is required.`);
  }
  return value;
}

function nonnegativeInteger(
  value,
  description = "integer"
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A nonnegative ${description} is required.`
    );
  }
  return value;
}

function boundedText(
  value,
  maximum,
  description = "text"
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(
      value
    )
  ) {
    invalid(`Canonical ${description} is required.`);
  }
  return value;
}

function nullableBoundedText(
  value,
  maximum,
  description
) {
  return value === null
    ? null
    : boundedText(value, maximum, description);
}

function digest(value, description = "digest") {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      `Stored ${description} is invalid JSON.`
    );
  }
}

function requireUnique(
  rows,
  description,
  tableName
) {
  if (rows.length > 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      `${description} is not unique.`,
      { details: { tableName } }
    );
  }
  return rows[0] ?? null;
}

function requireChanged(result, message) {
  if (result.changes !== 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.versionConflict,
      message
    );
  }
}

function mapIdempotency(row) {
  if (!row) return null;
  return deepFreeze({
    id: row.id,
    leagueId: row.league_id,
    actorUserId: row.actor_user_id,
    operation: row.operation,
    clientKey: row.client_key,
    requestHash: row.request_hash,
    status: row.status,
    resultType: row.result_type,
    resultId: row.result_id,
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
    expiresAtMs: row.expires_at_ms,
  });
}

function mapAttempt(row) {
  if (!row) return null;
  return deepFreeze({
    attemptId: row.id,
    bindingId: row.binding_id,
    leagueId: row.league_id,
    entryDraftId: row.entry_draft_id,
    rolloverOccurrenceId:
      row.rollover_occurrence_id,
    fromSeasonId: row.from_season_id,
    toSeasonId: row.to_season_id,
    attemptNumber: row.attempt_number,
    triggerKind: row.trigger_kind,
    scheduledJobRunId:
      row.scheduled_job_run_id,
    retryIdempotencyRequestId:
      row.retry_idempotency_request_id,
    retryActorUserId: row.retry_by_user_id,
    retryActorMembershipId:
      row.retry_by_membership_id,
    retryAuthority: row.retry_authority,
    status: row.status,
    blockers: parseJson(
      row.blockers_json,
      "rollover blockers"
    ),
    rolloverId: row.season_rollover_id,
    startedAtMs: row.started_at_ms,
    terminalAtMs: row.terminal_at_ms,
    observedSourceSeasonVersion:
      row.source_season_version_observed,
    observedTargetSeasonVersion:
      row.target_season_version_observed,
    observedEntryDraftVersion:
      row.entry_draft_version_observed,
    targetScheduleId: row.target_schedule_id,
    targetScheduleVersion:
      row.target_schedule_version,
    weekOneMatchupWeekId:
      row.week_one_matchup_week_id,
    weekOneStartsAtMs:
      row.week_one_starts_at_ms,
    version: row.version,
  });
}

function summaryFromRow(row) {
  return deepFreeze({
    contractsAdvanced: row.contracts_advanced,
    contractsExpired: row.contracts_expired,
    ownershipsCarried: row.ownerships_carried,
    ownershipsReleased:
      row.ownerships_released,
    retentionYearsAdvanced:
      row.retention_years_advanced,
    retentionObligationsCompleted:
      row.retention_obligations_completed,
    buyoutYearsAdvanced:
      row.buyout_years_advanced,
    buyoutObligationsCompleted:
      row.buyout_obligations_completed,
    tradesCancelled: row.trades_cancelled,
  });
}

function receiptFromRow(row) {
  if (!row) return null;
  return deepFreeze({
    rolloverId: row.id,
    rolloverAttemptId: row.rollover_attempt_id,
    leagueId: row.league_id,
    fromSeasonId: row.from_season_id,
    toSeasonId: row.to_season_id,
    fromSeasonStatus: "completed",
    toSeasonStatus: "active",
    targetNhlSeasonKey:
      row.target_nhl_season_key,
    nhlRegularSeasonStartsAtMs:
      row.nhl_regular_season_starts_at_ms,
    nhlRegularSeasonEndsAtMs:
      row.nhl_regular_season_ends_at_ms,
    fantasyPlayoffsStartAtMs:
      row.fantasy_playoffs_start_at_ms,
    fantasyPlayoffsEndAtMs:
      row.fantasy_playoffs_end_at_ms,
    sourceFadId: row.source_fad_id,
    sourceFinalizationRootId:
      row.source_finalization_root_id,
    sourceFinalizationId:
      row.source_finalization_id,
    sourceStandingsSnapshotId:
      row.source_standings_snapshot_id,
    sourceStandingsOperationId:
      row.source_standings_operation_id,
    sourceReadinessSchemaVersion:
      row.source_readiness_schema_version,
    sourceReadinessSha256:
      row.source_readiness_sha256,
    entryDraftId: row.entry_draft_id,
    entryDraftRolloverBindingId:
      row.binding_id,
    rolloverOccurrenceId:
      row.rollover_occurrence_id,
    scheduledStartsAtMs:
      row.entry_draft_scheduled_starts_at_ms,
    occurrenceKey: row.occurrence_key,
    targetScheduleId: row.target_schedule_id,
    targetScheduleVersion:
      row.target_schedule_version,
    weekOneMatchupWeekId:
      row.week_one_matchup_week_id,
    weekOneStartsAtMs:
      row.week_one_starts_at_ms,
    trigger: row.execution_trigger,
    leagueVersion: row.league_version_after,
    fromSeasonVersion:
      row.from_season_version_after,
    toSeasonVersion:
      row.to_season_version_after,
    entryDraftVersion:
      row.entry_draft_version_after,
    firstPickClockId: row.first_pick_clock_id,
    completedAtMs: row.completed_at_ms,
    retryAuthorizedByUserId:
      row.execution_trigger ===
      "commissioner_retry"
        ? row.executed_by_user_id
        : null,
    retryAuthorizedAuthority:
      row.execution_trigger ===
      "commissioner_retry"
        ? row.executed_authority
        : null,
    summary: summaryFromRow(row),
    version: row.version,
  });
}

function mapExemption(row) {
  if (!row) return null;
  const isConsumed = row.consumed_fad_id !== null;
  if (
    (
      !isConsumed &&
      (row.consumed_at_ms !== null || row.version !== 1)
    ) ||
    (
      isConsumed &&
      (row.consumed_at_ms === null || row.version !== 2)
    )
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The FAD setup-exemption consumption state is inconsistent."
    );
  }
  return deepFreeze({
    exemptionId: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    exemptionKind: row.exemption_kind,
    reason: row.reason,
    authorizedByUserId:
      row.authorized_by_user_id,
    authorizedAuthority:
      row.authorized_authority,
    authorizedAtMs: row.authorized_at_ms,
    consumed: false,
    migrationReportId:
      row.migration_report_id,
    version: 1,
  });
}

function camelContract(row, years) {
  return {
    id: row.id,
    playerId: row.player_id,
    currentTeamId: row.current_team_id,
    contractType: row.contract_type,
    originalTotalValueCents:
      row.original_total_value_cents,
    originalTermYears: row.original_term_years,
    aavCents: row.aav_cents,
    startSeasonId: row.start_season_id,
    status: row.status,
    acquisitionSourceType:
      row.acquisition_source_type,
    acquisitionSourceId:
      row.acquisition_source_id,
    auctionBuyoutLockExpiresAtMs:
      row.auction_buyout_lock_expires_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    years: years.map((year) => ({
      id: year.id,
      seasonId: year.season_id,
      yearNumber: year.year_number,
      aavCents: year.aav_cents,
      status: year.status,
      rolloverAtMs: year.rollover_at_ms,
      createdAtMs: year.created_at_ms,
    })),
  };
}

function camelOwnership(row, displayOrderEntries) {
  return {
    exists: true,
    id: row.id,
    seasonId: row.season_id,
    playerId: row.player_id,
    teamId: row.team_id,
    ownershipKind: row.ownership_kind,
    rosterCategory: row.roster_category,
    positionGroup: row.position_group,
    slotNumber: row.slot_number,
    acquiredTransactionType:
      row.acquired_transaction_type,
    acquiredTransactionId:
      row.acquired_transaction_id,
    tradeBlocked: row.trade_blocked === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    displayOrderEntries:
      displayOrderEntries.map((entry) => ({
        id: entry.id,
        leagueId: entry.league_id,
        orderSetId: entry.order_set_id,
        ownershipId: entry.ownership_id,
        positionGroup: entry.position_group,
        displayOrder: entry.display_order,
        createdAtMs: entry.created_at_ms,
      })),
  };
}

function camelObligation(row, years, kind) {
  const common = {
    id: row.id,
    contractId: row.contract_id,
    playerId: row.player_id,
    originatingTeamId: row.originating_team_id,
    responsibleTeamId: row.responsible_team_id,
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    years: years.map((year) => ({
      id: year.id,
      seasonId: year.season_id,
      amountCents:
        kind === "retention"
          ? year.retained_aav_cents
          : year.penalty_cents,
      status: year.status,
      createdAtMs: year.created_at_ms,
    })),
  };
  return kind === "retention"
    ? {
        ...common,
        retainedAavCents: row.retained_aav_cents,
        creationTradeId: row.creation_trade_id,
      }
    : {
        ...common,
        annualPenaltyBasisCents:
          row.annual_penalty_basis_cents,
        buyoutTransactionId:
          row.buyout_transaction_id,
      };
}

function camelTrade(row, assets) {
  return {
    id: row.id,
    seasonId: row.season_id,
    proposingTeamId: row.proposing_team_id,
    receivingTeamId: row.receiving_team_id,
    proposingUserId: row.proposing_user_id,
    creatingMembershipId:
      row.creating_membership_id,
    creatingAuthority: row.creating_authority,
    status: row.status,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    effectiveDeadlineAtMs:
      row.effective_deadline_at_ms,
    respondedAtMs: row.responded_at_ms,
    completedAtMs: row.completed_at_ms,
    commissionerCompletionReference:
      row.commissioner_completion_reference,
    proposalModelVersion:
      row.proposal_model_version,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    assets: assets.map((asset) => ({
      id: asset.id,
      leagueId: asset.league_id,
      tradeId: asset.trade_id,
      direction: asset.direction,
      sourceTeamId: asset.source_team_id,
      destinationTeamId:
        asset.destination_team_id,
      assetType: asset.asset_type,
      contractId: asset.contract_id,
      playerId: asset.player_id,
      draftPickId: asset.draft_pick_id,
      retentionObligationId:
        asset.retention_obligation_id,
      buyoutObligationId:
        asset.buyout_obligation_id,
      futureConsiderationId:
        asset.future_consideration_id,
      requestedRetentionContractId:
        asset.requested_retention_contract_id,
      requestedRetentionCents:
        asset.requested_retention_cents,
      futureConsiderationDescription:
        asset.future_consideration_description,
      proposalSnapshotJson:
        asset.proposal_snapshot_json,
      assetModelVersion:
        asset.asset_model_version,
      sequence: asset.sequence,
      createdAtMs: asset.created_at_ms,
    })),
  };
}

function auditRecord(audit) {
  return {
    id: audit.id,
    event_type: audit.eventType,
    outcome: audit.outcome,
    actor_user_id: audit.actorUserId,
    target_user_id: audit.targetUserId,
    league_id: audit.leagueId,
    session_id: audit.sessionId,
    request_correlation_id:
      audit.requestCorrelationId,
    reason_code: audit.reasonCode,
    network_key_version: audit.networkKeyVersion,
    network_metadata_digest:
      audit.networkMetadataDigest,
    client_metadata_json:
      audit.clientMetadataJson,
    unknown_account_digest:
      audit.unknownAccountDigest,
    occurred_at_ms: audit.occurredAtMs,
  };
}

function activityRecord(activity) {
  return {
    id: activity.id,
    league_id: activity.leagueId,
    season_id: activity.seasonId,
    event_type: activity.eventType,
    actor_user_id: activity.actorUserId,
    actor_authority: activity.actorAuthority,
    team_id: activity.teamId,
    player_id: activity.playerId,
    related_type: activity.relatedType,
    related_id: activity.relatedId,
    display_summary: activity.displaySummary,
    reason: activity.reason,
    metadata_json: serializeCanonicalJsonV1(
      activity.metadata
    ),
    occurred_at_ms: activity.occurredAtMs,
  };
}

function validateSetupExemptionPublicationPlan(plan) {
  let activityContract;
  let notificationContract;
  try {
    activityContract =
      createFreeAgentDraftActivityContract({
        eventType: plan.activity?.eventType,
        metadata: plan.activity?.metadata,
      });
    notificationContract =
      createFreeAgentDraftNotificationContract({
        type: plan.notification?.type,
        recipientUserId:
          plan.notification?.userId,
        messageData:
          plan.notification?.messageData,
      });
  } catch {
    invalid(
      "Canonical setup-exemption Activity and notification contracts are required."
    );
  }
  if (
    activityContract.eventType !==
      "fad_setup_exemption_authorized" ||
    activityContract.metadata.exemptionId !==
      plan.exemptionId ||
    activityContract.metadata.seasonId !==
      plan.seasonId ||
    activityContract.metadata.migrationReportId !==
      plan.migrationReportId ||
    notificationContract.type !==
      "fad_setup_exemption_authorized" ||
    notificationContract.messageData.leagueId !==
      plan.leagueId ||
    notificationContract.messageData.seasonId !==
      plan.seasonId ||
    notificationContract.messageData.exemptionId !==
      plan.exemptionId ||
    notificationContract.deduplicationKey !==
      plan.notification.deduplicationKey ||
    plan.notification.relatedFeature !==
      "free_agent_draft_setup" ||
    plan.notification.relatedRecordId !==
      plan.exemptionId ||
    plan.notification.status !== "pending" ||
    plan.notification.createdAtMs !==
      plan.authorizedAtMs ||
    plan.notification.version !== 1 ||
    plan.outbox?.eventType !== "league.changed" ||
    plan.outbox.aggregateType !== "league" ||
    plan.outbox.aggregateId !== plan.leagueId ||
    plan.outbox.scope !== "league" ||
    plan.outbox.leagueId !== plan.leagueId ||
    plan.outbox.changedAtMs !==
      plan.authorizedAtMs ||
    plan.activityOutbox?.eventType !==
      "activity.created" ||
    plan.activityOutbox.aggregateType !==
      "activity" ||
    plan.activityOutbox.aggregateId !==
      plan.activity.id ||
    plan.activityOutbox.scope !== "league" ||
    plan.activityOutbox.leagueId !==
      plan.leagueId ||
    plan.activityOutbox.changedAtMs !==
      plan.authorizedAtMs ||
    plan.activityOutbox.reasonCode !==
      "setup_exemption_authorized" ||
    plan.activityOutbox.version !== 1 ||
    plan.notificationOutbox?.eventType !==
      "notification.created" ||
    plan.notificationOutbox.aggregateType !==
      "notification" ||
    plan.notificationOutbox.aggregateId !==
      plan.notification.id ||
    plan.notificationOutbox.scope !== "user" ||
    plan.notificationOutbox.userId !==
      notificationContract.recipientUserId ||
    plan.notificationOutbox.leagueId !==
      plan.leagueId ||
    plan.notificationOutbox.changedAtMs !==
      plan.authorizedAtMs ||
    plan.notificationOutbox.reasonCode !==
      "setup_exemption_authorized" ||
    plan.notificationOutbox.version !== 1
  ) {
    invalid(
      "Canonical setup-exemption publication evidence is required."
    );
  }
  return Object.freeze({
    activityContract,
    notificationContract,
  });
}

function createSqliteLeagueLifecycleTransitionRepository({
  database,
  leagueOutboxWriter,
  notificationWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "createSqliteLeagueLifecycleTransitionRepository requires a database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "league-lifecycle beforeCommit must be a function"
    );
  }

  const statementCache = new Map();
  let resolvedOutboxWriter;
  let resolvedNotificationWriter;

  function statement(key, sql) {
    if (!statementCache.has(key)) {
      statementCache.set(key, database.prepare(sql));
    }
    return statementCache.get(key);
  }

  function outboxWriter() {
    if (!resolvedOutboxWriter) {
      resolvedOutboxWriter =
        resolveSqliteLeagueOutboxWriter({
          database,
          leagueOutboxWriter,
        });
    }
    return resolvedOutboxWriter;
  }

  function notifications() {
    if (!resolvedNotificationWriter) {
      resolvedNotificationWriter =
        resolveSqliteNotificationWriter({
          database,
          notificationWriter,
        });
    }
    return resolvedNotificationWriter;
  }

  function mapped(operation, tableName, callback) {
    try {
      return callback();
    } catch (error) {
      throw mapRepositoryError(error, {
        operation,
        tableName,
      });
    }
  }

  function hook(operation) {
    if (beforeCommit) beforeCommit(operation);
  }

  function selectAll(
    key,
    tableName,
    predicate,
    orderBy,
    params
  ) {
    return statement(
      key,
      `SELECT * FROM ${tableName}
       WHERE league_id = @leagueId
         AND ${predicate}
       ORDER BY ${orderBy}`
    ).all(params);
  }

  function findIdempotencyRequest(query = {}) {
    exactObject(
      query,
      ["leagueId", "operation", "clientKey"],
      "An exact idempotency lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      operation: boundedText(
        query.operation,
        100,
        "idempotency operation"
      ),
      clientKey: boundedText(
        query.clientKey,
        200,
        "idempotency client key"
      ),
    };
    return mapped(
      "findLifecycleIdempotencyRequest",
      "idempotency_requests",
      () =>
        mapIdempotency(
          requireUnique(
            statement(
              "find-idempotency",
              `SELECT *
               FROM idempotency_requests
               WHERE league_id = @leagueId
                 AND operation = @operation
                 AND client_key = @clientKey
               LIMIT 2`
            ).all(params),
            "Lifecycle idempotency tuple",
            "idempotency_requests"
          )
        )
    );
  }

  function findDurableSeasonRolloverAttempt(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "attemptId"],
      "An exact rollover-attempt lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      attemptId: stableId(
        query.attemptId,
        "rollover-attempt ID"
      ),
    };
    return mapped(
      "findDurableSeasonRolloverAttempt",
      "season_rollover_attempts",
      () =>
        mapAttempt(
          requireUnique(
            statement(
              "find-attempt-id",
              `SELECT *
               FROM season_rollover_attempts
               WHERE league_id = @leagueId
                 AND id = @attemptId
               LIMIT 2`
            ).all(params),
            "Rollover attempt ID",
            "season_rollover_attempts"
          )
        )
    );
  }

  function readRolloverItems({
    leagueId,
    rolloverId,
  }) {
    return statement(
      "find-rollover-items",
      `SELECT *
       FROM season_rollover_items
       WHERE league_id = @leagueId
         AND rollover_id = @rolloverId`
    )
      .all({ leagueId, rolloverId })
      .map((row) => {
        const projection = {
          itemId: row.id,
          leagueId: row.league_id,
          rolloverId: row.rollover_id,
          rolloverAttemptId:
            row.rollover_attempt_id,
          idempotencyRequestId:
            row.idempotency_request_id,
          fromSeasonId: row.from_season_id,
          toSeasonId: row.to_season_id,
          effectKind: row.effect_kind,
          entityType: row.entity_type,
          entityId: row.entity_id,
          before: parseCanonicalJsonV1(
            row.before_json
          ),
          after: parseCanonicalJsonV1(
            row.after_json
          ),
          contractEventId: row.contract_event_id,
          ownershipEventId:
            row.ownership_event_id,
          tradeEventId: row.trade_event_id,
          leagueActivityId:
            row.league_activity_id,
          causalAssets: parseCanonicalJsonV1(
            row.causal_assets_json
          ),
          occurredAtMs: row.occurred_at_ms,
        };
        if (
          hashSeasonRolloverItem(projection) !==
          row.payload_sha256
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A rollover item payload hash is invalid.",
            {
              details: {
                tableName: "season_rollover_items",
                itemId: row.id,
              },
            }
          );
        }
        return {
          ...projection,
          payloadSha256: row.payload_sha256,
        };
      })
      .sort(
        (left, right) =>
          EFFECT_ORDINALS[left.effectKind] -
            EFFECT_ORDINALS[right.effectKind] ||
          left.entityId.localeCompare(right.entityId)
      );
  }

  function manifestFromRoot(row, items) {
    return {
      leagueId: row.league_id,
      rolloverId: row.id,
      rolloverAttemptId: row.rollover_attempt_id,
      idempotencyRequestId:
        row.idempotency_request_id,
      entryDraftId: row.entry_draft_id,
      entryDraftRolloverBindingId:
        row.binding_id,
      rolloverOccurrenceId:
        row.rollover_occurrence_id,
      entryDraftScheduledStartsAtMs:
        row.entry_draft_scheduled_starts_at_ms,
      occurrenceKey: row.occurrence_key,
      targetScheduleId: row.target_schedule_id,
      targetScheduleVersion:
        row.target_schedule_version,
      weekOneMatchupWeekId:
        row.week_one_matchup_week_id,
      weekOneStartsAtMs:
        row.week_one_starts_at_ms,
      executionTrigger: row.execution_trigger,
      scheduledJobRunId:
        row.scheduled_job_run_id,
      fromSeasonId: row.from_season_id,
      fromSeasonLabel: row.from_season_label,
      fromNhlSeasonKey: row.from_nhl_season_key,
      toSeasonId: row.to_season_id,
      toSeasonLabel: row.to_season_label,
      targetNhlSeasonKey:
        row.target_nhl_season_key,
      nhlRegularSeasonStartsAtMs:
        row.nhl_regular_season_starts_at_ms,
      nhlRegularSeasonEndsAtMs:
        row.nhl_regular_season_ends_at_ms,
      fantasyPlayoffsStartAtMs:
        row.fantasy_playoffs_start_at_ms,
      fantasyPlayoffsEndAtMs:
        row.fantasy_playoffs_end_at_ms,
      sourceFadId: row.source_fad_id,
      sourceFinalizationRootId:
        row.source_finalization_root_id,
      sourceFinalizationId:
        row.source_finalization_id,
      sourceStandingsSnapshotId:
        row.source_standings_snapshot_id,
      sourceStandingsOperationId:
        row.source_standings_operation_id,
      sourceReadinessSchemaVersion:
        row.source_readiness_schema_version,
      sourceReadinessSha256:
        row.source_readiness_sha256,
      targetSeasonReused: true,
      leagueVersionBefore:
        row.league_version_before,
      leagueVersionAfter: row.league_version_after,
      fromSeasonVersionBefore:
        row.from_season_version_before,
      fromSeasonVersionAfter:
        row.from_season_version_after,
      toSeasonVersionBefore:
        row.to_season_version_before,
      toSeasonVersionAfter:
        row.to_season_version_after,
      entryDraftVersionBefore:
        row.entry_draft_version_before,
      entryDraftVersionAfter:
        row.entry_draft_version_after,
      entryDraftScheduledByUserId:
        row.entry_draft_scheduled_by_user_id,
      entryDraftScheduledByAuthority:
        row.entry_draft_scheduled_by_authority,
      executedByUserId: row.executed_by_user_id,
      executedAuthority: row.executed_authority,
      firstPickClockId: row.first_pick_clock_id,
      completedAtMs: row.completed_at_ms,
      aggregateActivityId:
        row.aggregate_activity_id,
      securityAuditEventId:
        row.security_audit_event_id,
      outboxEventId: row.outbox_event_id,
      summary: summaryFromRow(row),
      items,
    };
  }

  function verifyDurableRollover(row) {
    const projection = parseCanonicalJsonV1(
      row.source_readiness_json
    );
    if (
      row.source_readiness_schema_version !== 1 ||
      serializeSeasonRolloverSourceReadiness(
        projection
      ) !== row.source_readiness_json ||
      hashSeasonRolloverSourceReadiness(
        projection
      ) !== row.source_readiness_sha256
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "Stored rollover source-readiness evidence is invalid.",
        {
          details: {
            tableName: "season_rollovers",
            rolloverId: row.id,
          },
        }
      );
    }
    const items = readRolloverItems({
      leagueId: row.league_id,
      rolloverId: row.id,
    });
    if (
      row.manifest_schema_version !== 1 ||
      hashSeasonRolloverManifest(
        manifestFromRoot(row, items)
      ) !== row.manifest_sha256
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "Stored rollover manifest evidence is invalid.",
        {
          details: {
            tableName: "season_rollovers",
            rolloverId: row.id,
          },
        }
      );
    }
    return Object.freeze({
      sourceReadiness: projection,
      items,
    });
  }

  function findDurableSeasonRolloverResult(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "rolloverId"],
      "An exact season-rollover lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      rolloverId: stableId(
        query.rolloverId,
        "season-rollover ID"
      ),
    };
    return mapped(
      "findDurableSeasonRolloverResult",
      "season_rollovers",
      () => {
        const row = requireUnique(
          statement(
            "find-rollover-id",
            `SELECT *
             FROM season_rollovers
             WHERE league_id = @leagueId
               AND id = @rolloverId
             LIMIT 2`
          ).all(params),
          "Season rollover ID",
          "season_rollovers"
        );
        if (!row) return null;
        verifyDurableRollover(row);
        return receiptFromRow(row);
      }
    );
  }

  function findDurableSeasonRolloverOwnershipReceipt(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "rolloverId"],
      "An exact season-rollover ownership-receipt lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      rolloverId: stableId(
        query.rolloverId,
        "season-rollover ID"
      ),
    };
    return mapped(
      "findDurableSeasonRolloverOwnershipReceipt",
      "season_rollover_items",
      () => {
        const row = requireUnique(
          statement(
            "find-rollover-ownership-receipt-root",
            `SELECT *
             FROM season_rollovers
             WHERE league_id = @leagueId
               AND id = @rolloverId
             LIMIT 2`
          ).all(params),
          "Season rollover ID",
          "season_rollovers"
        );
        if (!row) return null;
        const { sourceReadiness, items } =
          verifyDurableRollover(row);
        const evidenceError = (
          message,
          tableName,
          details = {}
        ) =>
          repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            message,
            {
              details: {
                tableName,
                rolloverId: row.id,
                ...details,
              },
            }
          );
        const expectedEffectCounts = {
          contract_advanced: row.contracts_advanced,
          contract_expired: row.contracts_expired,
          ownership_carried: row.ownerships_carried,
          ownership_released: row.ownerships_released,
          retention_year_advanced:
            row.retention_years_advanced,
          retention_obligation_completed:
            row.retention_obligations_completed,
          buyout_year_advanced:
            row.buyout_years_advanced,
          buyout_obligation_completed:
            row.buyout_obligations_completed,
          trade_cancelled: row.trades_cancelled,
        };
        const actualEffectCounts = Object.fromEntries(
          Object.keys(expectedEffectCounts).map((key) => [
            key,
            0,
          ])
        );
        for (const item of items) {
          if (
            !Object.hasOwn(
              expectedEffectCounts,
              item.effectKind
            ) ||
            item.entityType !==
              EFFECT_ENTITY_TYPES[item.effectKind] ||
            !UUID_PATTERN.test(item.itemId || "") ||
            !UUID_PATTERN.test(item.entityId || "") ||
            item.leagueId !== row.league_id ||
            item.rolloverId !== row.id ||
            item.rolloverAttemptId !==
              row.rollover_attempt_id ||
            item.idempotencyRequestId !==
              row.idempotency_request_id ||
            item.fromSeasonId !== row.from_season_id ||
            item.toSeasonId !== row.to_season_id ||
            item.occurredAtMs !== row.completed_at_ms
          ) {
            throw evidenceError(
              "Stored rollover item binding evidence is invalid.",
              "season_rollover_items",
              { itemId: item.itemId }
            );
          }
          actualEffectCounts[item.effectKind] += 1;
        }
        if (
          Object.entries(expectedEffectCounts).some(
            ([effectKind, expected]) =>
              !Number.isSafeInteger(expected) ||
              expected < 0 ||
              actualEffectCounts[effectKind] !== expected
          )
        ) {
          throw evidenceError(
            "Stored rollover effect totals are invalid.",
            "season_rollovers"
          );
        }

        if (
          !isPlainObject(sourceReadiness) ||
          sourceReadiness.leagueId !== row.league_id ||
          sourceReadiness.fromSeasonId !==
            row.from_season_id ||
          !isSafeStoredTimestamp(
            sourceReadiness.observedAtMs
          ) ||
          sourceReadiness.sourceFadId !==
            row.source_fad_id ||
          sourceReadiness.sourceFinalizationRootId !==
            row.source_finalization_root_id ||
          sourceReadiness.sourceFinalizationId !==
            row.source_finalization_id ||
          sourceReadiness.sourceStandingsSnapshotId !==
            row.source_standings_snapshot_id ||
          sourceReadiness.sourceStandingsOperationId !==
            row.source_standings_operation_id
        ) {
          throw evidenceError(
            "Stored rollover source binding evidence is invalid.",
            "season_rollovers"
          );
        }

        const byTeamScope = new Map();
        const ensureTeamScope = (seasonId, teamId) => {
          const scope =
            `${row.league_id}\u0000${seasonId}\u0000${teamId}`;
          if (!byTeamScope.has(scope)) {
            byTeamScope.set(scope, {
              leagueId: row.league_id,
              seasonId,
              teamId,
              ownershipWitnesses: [],
            });
          }
          return byTeamScope.get(scope);
        };
        for (const item of items) {
          const teamField =
            item.entityType === "contract"
              ? "currentTeamId"
              : [
                    "retention_obligation",
                    "buyout_obligation",
                  ].includes(item.entityType)
                ? "responsibleTeamId"
                : null;
          if (teamField === null) continue;
          if (
            !isPlainObject(item.before) ||
            !isPlainObject(item.after) ||
            item.before.id !== item.entityId ||
            item.after.id !== item.entityId ||
            !UUID_PATTERN.test(
              item.before[teamField] || ""
            ) ||
            item.after[teamField] !==
              item.before[teamField] ||
            !Number.isSafeInteger(item.before.version) ||
            item.before.version < 1 ||
            item.after.version !==
              item.before.version + 1 ||
            item.after.updatedAtMs !==
              row.completed_at_ms
          ) {
            throw evidenceError(
              "Stored rollover team-effect evidence is invalid.",
              "season_rollover_items",
              { itemId: item.itemId }
            );
          }
        }

        const ownershipItems = items.filter(
          ({ entityType }) =>
            entityType === "player_ownership"
        );
        const ownershipIds = new Set();
        for (const item of ownershipItems) {
          const carried =
            item.effectKind ===
            "ownership_carried";
          const before = item.before;
          const after = item.after;
          const expectedSeasonId = carried
            ? row.to_season_id
            : row.from_season_id;
          const expectedEventType = carried
            ? "ownership_carried_to_season"
            : "player_released_by_contract_expiration";
          const validBefore =
            isPlainObject(before) &&
            before.exists === true &&
            before.id === item.entityId &&
            UUID_PATTERN.test(before.id || "") &&
            before.seasonId === row.from_season_id &&
            UUID_PATTERN.test(before.playerId || "") &&
            UUID_PATTERN.test(before.teamId || "") &&
            Number.isSafeInteger(before.version) &&
            before.version >= 1;
          const validAfter =
            isPlainObject(after) &&
            after.id === item.entityId &&
            after.playerId === before?.playerId &&
            after.teamId === before?.teamId &&
            after.updatedAtMs === row.completed_at_ms &&
            (carried
              ? after.exists === true &&
                after.seasonId === row.to_season_id &&
                Number.isSafeInteger(after.version) &&
                after.version === before?.version + 1
              : after.exists === false &&
                after.seasonId === null &&
                after.version === null);
          if (
            !validBefore ||
            !validAfter ||
            ownershipIds.has(item.entityId) ||
            !UUID_PATTERN.test(
              item.ownershipEventId || ""
            ) ||
            item.contractEventId !== null ||
            item.tradeEventId !== null
          ) {
            throw evidenceError(
              "Stored rollover ownership evidence is invalid.",
              "season_rollover_items",
              { ownershipId: item.entityId }
            );
          }
          ownershipIds.add(item.entityId);

          const event = requireUnique(
            statement(
              "find-rollover-ownership-receipt-event",
              `SELECT *
               FROM ownership_events
               WHERE league_id = @leagueId
                 AND id = @ownershipEventId
               LIMIT 2`
            ).all({
              leagueId: row.league_id,
              ownershipEventId:
                item.ownershipEventId,
            }),
            "Rollover ownership-event ID",
            "ownership_events"
          );
          if (
            !event ||
            event.season_id !== expectedSeasonId ||
            event.player_id !== before.playerId ||
            event.team_id !== before.teamId ||
            event.ownership_id !== item.entityId ||
            event.event_type !== expectedEventType ||
            event.actor_user_id !== null ||
            event.source_type !== "season_rollover" ||
            event.source_id !== row.id ||
            event.before_metadata_json !==
              serializeCanonicalJsonV1(before) ||
            event.after_metadata_json !==
              serializeCanonicalJsonV1(after) ||
            event.reason !== "season_rollover" ||
            event.occurred_at_ms !==
              row.completed_at_ms
          ) {
            throw evidenceError(
              "Stored rollover ownership-event evidence is invalid.",
              "ownership_events",
              { ownershipId: item.entityId }
            );
          }

          if (!carried) {
            ensureTeamScope(
              row.to_season_id,
              before.teamId
            );
          }
          ensureTeamScope(
            expectedSeasonId,
            before.teamId
          ).ownershipWitnesses.push({
            ownershipId: item.entityId,
            ownershipVersion: carried
              ? after.version
              : before.version,
            state: carried ? "present" : "deleted",
          });
        }

        const teams = [...byTeamScope.entries()]
          .sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
          .map(([, team]) => ({
            ...team,
            ownershipWitnesses:
              team.ownershipWitnesses.sort(
                (left, right) =>
                  left.ownershipId <
                  right.ownershipId
                    ? -1
                    : left.ownershipId >
                        right.ownershipId
                      ? 1
                      : 0
              ),
          }));
        return deepFreeze({
          rolloverId: row.id,
          leagueId: row.league_id,
          fromSeasonId: row.from_season_id,
          toSeasonId: row.to_season_id,
          teams,
        });
      }
    );
  }

  function findDurableSetupExemptionResult(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "exemptionId"],
      "An exact setup-exemption lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      exemptionId: stableId(
        query.exemptionId,
        "setup-exemption ID"
      ),
    };
    return mapped(
      "findDurableSetupExemptionResult",
      "free_agent_draft_setup_exemptions",
      () => {
        const row = requireUnique(
          statement(
            "find-exemption-id",
            `SELECT *
             FROM free_agent_draft_setup_exemptions
             WHERE league_id = @leagueId
               AND id = @exemptionId
             LIMIT 2`
          ).all(params),
          "FAD setup-exemption ID",
          "free_agent_draft_setup_exemptions"
        );
        if (!row) return null;
        requireSetupExemptionPublicationEvidence(row);
        return mapExemption(row);
      }
    );
  }

  function findRolloverBindingByOccurrence(
    query = {}
  ) {
    exactObject(
      query,
      [
        "leagueId",
        "entryDraftId",
        "rolloverOccurrenceId",
      ],
      "An exact rollover-occurrence lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      entryDraftId: stableId(
        query.entryDraftId,
        "Entry Draft ID"
      ),
      rolloverOccurrenceId: stableId(
        query.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
    };
    return mapped(
      "findRolloverBindingByOccurrence",
      "entry_draft_rollover_bindings",
      () => {
        const row = requireUnique(
          statement(
            "find-binding-occurrence",
            `SELECT
               binding.id AS binding_id,
               binding.league_id,
               binding.entry_draft_id,
               occurrence.id AS rollover_occurrence_id,
               occurrence.from_season_id,
               occurrence.to_season_id,
               occurrence.scheduled_starts_at_ms,
               occurrence.occurrence_key,
               occurrence.target_schedule_id,
               occurrence.target_schedule_version,
               occurrence.week_one_matchup_week_id,
               occurrence.week_one_starts_at_ms,
               occurrence.status AS occurrence_status,
               binding.selection_gate_status,
               binding.trading_gate_status,
               occurrence.source_season_version_at_schedule,
               occurrence.target_season_version_at_schedule,
               occurrence.entry_draft_version_at_schedule,
               binding.version AS binding_version,
               binding.current_rollover_occurrence_id,
               binding.current_scheduled_job_run_id,
               binding.current_schedule_operation_id,
               occurrence.scheduled_job_run_id,
               occurrence.schedule_operation_id
             FROM season_rollover_occurrences AS occurrence
             JOIN entry_draft_rollover_bindings AS binding
               ON binding.league_id = occurrence.league_id
              AND binding.id = occurrence.binding_id
              AND binding.entry_draft_id =
                  occurrence.entry_draft_id
             WHERE occurrence.league_id = @leagueId
               AND occurrence.entry_draft_id =
                   @entryDraftId
               AND occurrence.id =
                   @rolloverOccurrenceId
             LIMIT 2`
          ).all(params),
          "Rollover occurrence",
          "season_rollover_occurrences"
        );
        if (!row) return null;
        const current =
          row.current_rollover_occurrence_id ===
          row.rollover_occurrence_id;
        if (
          current &&
          (row.current_scheduled_job_run_id !==
            row.scheduled_job_run_id ||
            row.current_schedule_operation_id !==
              row.schedule_operation_id)
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The current rollover occurrence disagrees with its stable binding.",
            {
              details: {
                tableName:
                  "entry_draft_rollover_bindings",
              },
            }
          );
        }
        if (
          !current &&
          row.occurrence_status !== "superseded"
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A non-current rollover occurrence is not superseded.",
            {
              details: {
                tableName:
                  "season_rollover_occurrences",
              },
            }
          );
        }
        return deepFreeze({
          bindingId: row.binding_id,
          leagueId: row.league_id,
          entryDraftId: row.entry_draft_id,
          rolloverOccurrenceId:
            row.rollover_occurrence_id,
          fromSeasonId: row.from_season_id,
          toSeasonId: row.to_season_id,
          scheduledStartsAtMs:
            row.scheduled_starts_at_ms,
          occurrenceKey: row.occurrence_key,
          targetScheduleId:
            row.target_schedule_id,
          targetScheduleVersion:
            row.target_schedule_version,
          weekOneMatchupWeekId:
            row.week_one_matchup_week_id,
          weekOneStartsAtMs:
            row.week_one_starts_at_ms,
          status: row.occurrence_status,
          selectionGateStatus:
            row.selection_gate_status,
          tradingGateStatus:
            row.trading_gate_status,
          sourceSeasonVersion:
            row.source_season_version_at_schedule,
          targetSeasonVersion:
            row.target_season_version_at_schedule,
          entryDraftVersion:
            row.entry_draft_version_at_schedule,
          version: row.binding_version,
        });
      }
    );
  }

  function findSeasonRolloverAttemptByIdempotencyRequest(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "idempotencyRequestId"],
      "An exact retry-attempt lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      idempotencyRequestId: stableId(
        query.idempotencyRequestId,
        "idempotency-request ID"
      ),
    };
    return mapped(
      "findSeasonRolloverAttemptByIdempotencyRequest",
      "season_rollover_attempts",
      () =>
        mapAttempt(
          requireUnique(
            statement(
              "find-attempt-idempotency",
              `SELECT *
               FROM season_rollover_attempts
               WHERE league_id = @leagueId
                 AND retry_idempotency_request_id =
                     @idempotencyRequestId
               LIMIT 2`
            ).all(params),
            "Retry idempotency attempt",
            "season_rollover_attempts"
          )
        )
    );
  }

  function findLatestSeasonRolloverAttempt(
    query = {}
  ) {
    exactObject(
      query,
      [
        "leagueId",
        "bindingId",
        "rolloverOccurrenceId",
      ],
      "An exact latest-attempt lookup is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      bindingId: stableId(
        query.bindingId,
        "rollover-binding ID"
      ),
      rolloverOccurrenceId: stableId(
        query.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
    };
    return mapped(
      "findLatestSeasonRolloverAttempt",
      "season_rollover_attempts",
      () => {
        const rows = statement(
          "find-latest-attempt",
          `SELECT *
           FROM season_rollover_attempts
           WHERE league_id = @leagueId
             AND binding_id = @bindingId
             AND rollover_occurrence_id =
                 @rolloverOccurrenceId
             AND attempt_number = (
               SELECT MAX(latest.attempt_number)
               FROM season_rollover_attempts AS latest
               WHERE latest.league_id = @leagueId
                 AND latest.binding_id = @bindingId
                 AND latest.rollover_occurrence_id =
                     @rolloverOccurrenceId
             )
           LIMIT 2`
        ).all(params);
        return mapAttempt(
          requireUnique(
            rows,
            "Latest rollover attempt",
            "season_rollover_attempts"
          )
        );
      }
    );
  }

  function validateScheduledRolloverJobLease(
    command = {}
  ) {
    exactObject(
      command,
      [
        "leagueId",
        "bindingId",
        "entryDraftId",
        "rolloverOccurrenceId",
        "scheduledJob",
      ],
      "An exact scheduled-rollover lease validation is required."
    );
    exactObject(
      command.scheduledJob,
      [
        "runId",
        "occurrenceKey",
        "scheduledForMs",
        "leaseOwner",
        "leaseToken",
        "expectedVersion",
      ],
      "An exact scheduled job lease is required."
    );
    const params = {
      leagueId: stableId(command.leagueId, "league ID"),
      bindingId: stableId(
        command.bindingId,
        "rollover-binding ID"
      ),
      entryDraftId: stableId(
        command.entryDraftId,
        "Entry Draft ID"
      ),
      rolloverOccurrenceId: stableId(
        command.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
      runId: stableId(
        command.scheduledJob.runId,
        "scheduled-job run ID"
      ),
      occurrenceKey: boundedText(
        command.scheduledJob.occurrenceKey,
        500,
        "occurrence key"
      ),
      scheduledForMs: safeTimestamp(
        command.scheduledJob.scheduledForMs,
        "scheduled-job timestamp"
      ),
      leaseOwner: boundedText(
        command.scheduledJob.leaseOwner,
        200,
        "lease owner"
      ),
      leaseToken: boundedText(
        command.scheduledJob.leaseToken,
        500,
        "lease token"
      ),
      expectedVersion: positiveInteger(
        command.scheduledJob.expectedVersion,
        "scheduled-job version"
      ),
    };
    return mapped(
      "validateScheduledRolloverJobLease",
      "job_runs",
      () => {
        const row = requireUnique(
          statement(
            "validate-rollover-lease",
            `SELECT run.id, run.version
             FROM entry_draft_rollover_bindings AS binding
             JOIN season_rollover_occurrences AS occurrence
               ON occurrence.league_id = binding.league_id
              AND occurrence.binding_id = binding.id
              AND occurrence.id =
                  binding.current_rollover_occurrence_id
              AND occurrence.scheduled_job_run_id =
                  binding.current_scheduled_job_run_id
              AND occurrence.schedule_operation_id =
                  binding.current_schedule_operation_id
             JOIN job_runs AS run
               ON run.league_id = occurrence.league_id
              AND run.id = occurrence.scheduled_job_run_id
             WHERE binding.league_id = @leagueId
               AND binding.id = @bindingId
               AND binding.entry_draft_id = @entryDraftId
               AND occurrence.id =
                   @rolloverOccurrenceId
               AND occurrence.status IN ('scheduled', 'blocked')
               AND run.id = @runId
               AND run.job_type =
                   'league:entry_draft_rollover'
               AND run.occurrence_key = @occurrenceKey
               AND run.scheduled_for_ms = @scheduledForMs
               AND run.status IN ('leased', 'running')
               AND run.attempt_count >= 1
               AND run.lease_owner = @leaseOwner
               AND run.lease_token = @leaseToken
               AND run.version = @expectedVersion
             LIMIT 2`
          ).all(params),
          "Scheduled rollover lease",
          "job_runs"
        );
        if (!row) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The scheduled rollover job lease changed."
          );
        }
        return deepFreeze({
          valid: true,
        });
      }
    );
  }

  function beginSeasonRolloverAttempt(
    command = {}
  ) {
    exactObject(
      command,
      [
        "attemptId",
        "bindingId",
        "leagueId",
        "entryDraftId",
        "rolloverOccurrenceId",
        "fromSeasonId",
        "toSeasonId",
        "targetScheduleId",
        "targetScheduleVersion",
        "weekOneMatchupWeekId",
        "weekOneStartsAtMs",
        "expectedBindingVersion",
        "expectedPriorAttemptId",
        "expectedPriorAttemptNumber",
        "triggerKind",
        "scheduledJob",
        "retryIdempotencyRequestId",
        "retryActorUserId",
        "retryActorMembershipId",
        "retryAuthority",
        "startedAtMs",
        "observedSourceSeasonVersion",
        "observedTargetSeasonVersion",
        "observedEntryDraftVersion",
      ],
      "An exact rollover-attempt command is required."
    );
    if (
      ![
        "scheduled_job",
        "commissioner_retry",
      ].includes(command.triggerKind)
    ) {
      invalid(
        "A supported rollover-attempt trigger is required."
      );
    }
    const scheduled =
      command.triggerKind === "scheduled_job";
    if (
      (scheduled &&
        (!isPlainObject(command.scheduledJob) ||
          command.retryIdempotencyRequestId !== null ||
          command.retryActorUserId !== null ||
          command.retryActorMembershipId !== null ||
          command.retryAuthority !== null)) ||
      (!scheduled &&
        (command.scheduledJob !== null ||
          command.retryIdempotencyRequestId === null ||
          command.retryActorUserId === null ||
          command.retryActorMembershipId === null ||
          ![
            "commissioner",
            "platform_administrator_as_commissioner",
          ].includes(command.retryAuthority)))
    ) {
      invalid(
        "Rollover-attempt trigger evidence is inconsistent."
      );
    }
    if (scheduled) {
      exactObject(
        command.scheduledJob,
        [
          "runId",
          "occurrenceKey",
          "scheduledForMs",
          "leaseOwner",
          "leaseToken",
          "expectedVersion",
        ],
        "An exact scheduled job lease is required."
      );
    }
    const params = {
      attemptId: stableId(
        command.attemptId,
        "rollover-attempt ID"
      ),
      bindingId: stableId(
        command.bindingId,
        "rollover-binding ID"
      ),
      leagueId: stableId(command.leagueId, "league ID"),
      entryDraftId: stableId(
        command.entryDraftId,
        "Entry Draft ID"
      ),
      rolloverOccurrenceId: stableId(
        command.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
      fromSeasonId: stableId(
        command.fromSeasonId,
        "source-season ID"
      ),
      toSeasonId: stableId(
        command.toSeasonId,
        "target-season ID"
      ),
      targetScheduleId: stableId(
        command.targetScheduleId,
        "target-schedule ID"
      ),
      targetScheduleVersion: positiveInteger(
        command.targetScheduleVersion,
        "target-schedule version"
      ),
      weekOneMatchupWeekId: stableId(
        command.weekOneMatchupWeekId,
        "Week 1 matchup-week ID"
      ),
      weekOneStartsAtMs: safeTimestamp(
        command.weekOneStartsAtMs,
        "Week 1 timestamp"
      ),
      expectedBindingVersion: positiveInteger(
        command.expectedBindingVersion,
        "rollover-binding version"
      ),
      expectedPriorAttemptId: nullableId(
        command.expectedPriorAttemptId,
        "prior rollover-attempt ID"
      ),
      expectedPriorAttemptNumber:
        nonnegativeInteger(
          command.expectedPriorAttemptNumber,
          "prior rollover-attempt number"
        ),
      triggerKind: command.triggerKind,
      scheduledJobRunId: scheduled
        ? stableId(
            command.scheduledJob.runId,
            "scheduled-job run ID"
          )
        : null,
      retryIdempotencyRequestId: nullableId(
        command.retryIdempotencyRequestId,
        "retry idempotency-request ID"
      ),
      retryActorUserId: nullableId(
        command.retryActorUserId,
        "retry actor-user ID"
      ),
      retryActorMembershipId: nullableId(
        command.retryActorMembershipId,
        "retry actor-membership ID"
      ),
      retryAuthority: command.retryAuthority,
      startedAtMs: safeTimestamp(
        command.startedAtMs,
        "attempt start timestamp"
      ),
      observedSourceSeasonVersion:
        positiveInteger(
          command.observedSourceSeasonVersion,
          "observed source-season version"
        ),
      observedTargetSeasonVersion:
        positiveInteger(
          command.observedTargetSeasonVersion,
          "observed target-season version"
        ),
      observedEntryDraftVersion:
        positiveInteger(
          command.observedEntryDraftVersion,
          "observed Entry Draft version"
        ),
    };
    return mapped(
      "beginSeasonRolloverAttempt",
      "season_rollover_attempts",
      () => {
        const result = statement(
          "insert-rollover-attempt",
          `INSERT INTO season_rollover_attempts (
             id, league_id, binding_id,
             rollover_occurrence_id, entry_draft_id,
             from_season_id, to_season_id,
             target_schedule_id, target_schedule_version,
             week_one_matchup_week_id, week_one_starts_at_ms,
             scheduled_starts_at_ms, occurrence_key,
             attempt_number, trigger_kind,
             scheduled_job_run_id,
             retry_idempotency_request_id,
             retry_by_user_id, retry_by_membership_id,
             retry_authority, status, blockers_json,
             season_rollover_id,
             source_season_version_observed,
             target_season_version_observed,
             entry_draft_version_observed,
             started_at_ms, terminal_at_ms,
             created_at_ms, updated_at_ms, version
           )
           SELECT
             @attemptId, binding.league_id, binding.id,
             occurrence.id, occurrence.entry_draft_id,
             occurrence.from_season_id,
             occurrence.to_season_id,
             occurrence.target_schedule_id,
             occurrence.target_schedule_version,
             occurrence.week_one_matchup_week_id,
             occurrence.week_one_starts_at_ms,
             occurrence.scheduled_starts_at_ms,
             occurrence.occurrence_key,
             @expectedPriorAttemptNumber + 1,
             @triggerKind, @scheduledJobRunId,
             @retryIdempotencyRequestId,
             @retryActorUserId,
             @retryActorMembershipId,
             @retryAuthority, 'started', '[]', NULL,
             @observedSourceSeasonVersion,
             @observedTargetSeasonVersion,
             @observedEntryDraftVersion,
             @startedAtMs, NULL,
             @startedAtMs, @startedAtMs, 1
           FROM entry_draft_rollover_bindings AS binding
           JOIN season_rollover_occurrences AS occurrence
             ON occurrence.league_id = binding.league_id
            AND occurrence.binding_id = binding.id
            AND occurrence.id =
                binding.current_rollover_occurrence_id
            AND occurrence.schedule_operation_id =
                binding.current_schedule_operation_id
           WHERE binding.league_id = @leagueId
             AND binding.id = @bindingId
             AND binding.entry_draft_id = @entryDraftId
             AND occurrence.id =
                 @rolloverOccurrenceId
             AND occurrence.from_season_id =
                 @fromSeasonId
             AND occurrence.to_season_id = @toSeasonId
             AND occurrence.target_schedule_id =
                 @targetScheduleId
             AND occurrence.target_schedule_version =
                 @targetScheduleVersion
             AND occurrence.week_one_matchup_week_id =
                 @weekOneMatchupWeekId
             AND occurrence.week_one_starts_at_ms =
                 @weekOneStartsAtMs
             AND binding.version =
                 @expectedBindingVersion
             AND binding.status IN ('scheduled', 'blocked')
             AND occurrence.status IN ('scheduled', 'blocked')
             AND binding.selection_gate_status = 'locked'
             AND binding.trading_gate_status = 'locked'
             AND binding.source_season_version_at_schedule =
                 @observedSourceSeasonVersion
             AND binding.target_season_version_at_schedule =
                 @observedTargetSeasonVersion
             AND binding.entry_draft_version_at_schedule =
                 @observedEntryDraftVersion
             AND @expectedPriorAttemptNumber = COALESCE((
               SELECT MAX(prior.attempt_number)
               FROM season_rollover_attempts AS prior
               WHERE prior.league_id = binding.league_id
                 AND prior.binding_id = binding.id
                 AND prior.rollover_occurrence_id =
                     occurrence.id
             ), 0)
             AND (
               (
                 @expectedPriorAttemptNumber = 0
                 AND @expectedPriorAttemptId IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM season_rollover_attempts AS prior
                 WHERE prior.league_id = binding.league_id
                   AND prior.binding_id = binding.id
                   AND prior.rollover_occurrence_id =
                       occurrence.id
                   AND prior.id =
                       @expectedPriorAttemptId
                   AND prior.attempt_number =
                       @expectedPriorAttemptNumber
                   AND prior.status = 'blocked'
               )
             )`
        ).run(params);
        requireChanged(
          result,
          "The rollover occurrence or prior attempt changed."
        );
        const inserted =
          findDurableSeasonRolloverAttempt({
            leagueId: params.leagueId,
            attemptId: params.attemptId,
          });
        if (!inserted) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The inserted rollover attempt is unavailable."
          );
        }
        return inserted;
      }
    );
  }

  function canonicalBlockers(blockers) {
    if (
      !Array.isArray(blockers) ||
      blockers.length < 1
    ) {
      invalid(
        "At least one canonical rollover blocker is required."
      );
    }
    for (const blocker of blockers) {
      exactObject(
        blocker,
        [
          "code",
          "field",
          "resourceType",
          "resourceId",
          "message",
        ],
        "An exact rollover blocker is required."
      );
      if (
        typeof blocker.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(
          blocker.code
        )
      ) {
        invalid(
          "A canonical rollover blocker code is required."
        );
      }
      nullableBoundedText(
        blocker.field,
        100,
        "blocker field"
      );
      nullableBoundedText(
        blocker.resourceType,
        100,
        "blocker resource type"
      );
      nullableId(
        blocker.resourceId,
        "blocker resource ID"
      );
      boundedText(
        blocker.message,
        500,
        "blocker message"
      );
    }
    return serializeCanonicalJsonV1(blockers);
  }

  function blockSeasonRolloverAttempt(
    command = {}
  ) {
    exactObject(
      command,
      [
        "attemptId",
        "bindingId",
        "leagueId",
        "entryDraftId",
        "rolloverOccurrenceId",
        "expectedBindingVersion",
        "expectedSourceSeasonVersion",
        "expectedTargetSeasonVersion",
        "expectedEntryDraftVersion",
        "triggerKind",
        "scheduledJob",
        "retryIdempotencyRequestId",
        "blockers",
        "blockedAtMs",
      ],
      "An exact blocked-rollover command is required."
    );
    const params = {
      attemptId: stableId(
        command.attemptId,
        "rollover-attempt ID"
      ),
      bindingId: stableId(
        command.bindingId,
        "rollover-binding ID"
      ),
      leagueId: stableId(command.leagueId, "league ID"),
      entryDraftId: stableId(
        command.entryDraftId,
        "Entry Draft ID"
      ),
      rolloverOccurrenceId: stableId(
        command.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
      expectedBindingVersion: positiveInteger(
        command.expectedBindingVersion,
        "rollover-binding version"
      ),
      expectedSourceSeasonVersion:
        positiveInteger(
          command.expectedSourceSeasonVersion,
          "source-season version"
        ),
      expectedTargetSeasonVersion:
        positiveInteger(
          command.expectedTargetSeasonVersion,
          "target-season version"
        ),
      expectedEntryDraftVersion:
        positiveInteger(
          command.expectedEntryDraftVersion,
          "Entry Draft version"
        ),
      triggerKind: command.triggerKind,
      retryIdempotencyRequestId: nullableId(
        command.retryIdempotencyRequestId,
        "retry idempotency-request ID"
      ),
      blockersJson: canonicalBlockers(
        command.blockers
      ),
      blockedAtMs: safeTimestamp(
        command.blockedAtMs,
        "blocked timestamp"
      ),
    };
    if (
      ![
        "scheduled_job",
        "commissioner_retry",
      ].includes(params.triggerKind) ||
      (params.triggerKind ===
        "commissioner_retry") !==
        (params.retryIdempotencyRequestId !== null)
    ) {
      invalid(
        "Blocked-attempt trigger evidence is inconsistent."
      );
    }
    return mapped(
      "blockSeasonRolloverAttempt",
      "season_rollover_attempts",
      () => {
        requireChanged(
          statement(
            "block-rollover-attempt",
            `UPDATE season_rollover_attempts
             SET status = 'blocked',
                 blockers_json = @blockersJson,
                 terminal_at_ms = @blockedAtMs,
                 updated_at_ms = @blockedAtMs,
                 version = version + 1
             WHERE league_id = @leagueId
               AND id = @attemptId
               AND binding_id = @bindingId
               AND rollover_occurrence_id =
                   @rolloverOccurrenceId
               AND entry_draft_id = @entryDraftId
               AND trigger_kind = @triggerKind
               AND retry_idempotency_request_id IS
                   @retryIdempotencyRequestId
               AND status = 'started'
               AND source_season_version_observed =
                   @expectedSourceSeasonVersion
               AND target_season_version_observed =
                   @expectedTargetSeasonVersion
               AND entry_draft_version_observed =
                   @expectedEntryDraftVersion`
          ).run(params),
          "The started rollover attempt changed."
        );
        const occurrenceChange = statement(
          "block-rollover-occurrence",
          `UPDATE season_rollover_occurrences
           SET status = 'blocked',
               updated_at_ms = @blockedAtMs,
               version = version + 1
           WHERE league_id = @leagueId
             AND id = @rolloverOccurrenceId
             AND binding_id = @bindingId
             AND entry_draft_id = @entryDraftId
             AND status = 'scheduled'`
        ).run(params);
        if (occurrenceChange.changes === 0) {
          const alreadyBlocked = statement(
            "find-already-blocked-occurrence",
            `SELECT COUNT(*) AS count
             FROM season_rollover_occurrences
             WHERE league_id = @leagueId
               AND id = @rolloverOccurrenceId
               AND binding_id = @bindingId
               AND entry_draft_id = @entryDraftId
               AND status = 'blocked'
               AND successful_rollover_id IS NULL
               AND terminal_at_ms IS NULL`
          ).get(params).count;
          if (alreadyBlocked !== 1) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.versionConflict,
              "The rollover occurrence changed."
            );
          }
        }
        requireChanged(
          statement(
            "block-rollover-binding",
            `UPDATE entry_draft_rollover_bindings
             SET status = 'blocked',
                 updated_at_ms = @blockedAtMs,
                 version = version + 1
             WHERE league_id = @leagueId
               AND id = @bindingId
               AND entry_draft_id = @entryDraftId
               AND current_rollover_occurrence_id =
                   @rolloverOccurrenceId
               AND status IN ('scheduled', 'blocked')
               AND selection_gate_status = 'locked'
               AND trading_gate_status = 'locked'
               AND source_season_version_at_schedule =
                   @expectedSourceSeasonVersion
               AND target_season_version_at_schedule =
                   @expectedTargetSeasonVersion
               AND entry_draft_version_at_schedule =
                   @expectedEntryDraftVersion
               AND version = @expectedBindingVersion`
          ).run(params),
          "The rollover binding changed."
        );
        hook("blockSeasonRolloverAttempt");
        return findDurableSeasonRolloverAttempt({
          leagueId: params.leagueId,
          attemptId: params.attemptId,
        });
      }
    );
  }

  function currentFinalizationLineage({
    leagueId,
    seasonId,
  }) {
    const all = selectAll(
      "source-finalizations",
      "standings_snapshot_finalizations",
      "season_id = @seasonId",
      "finalization_version, id",
      { leagueId, seasonId }
    );
    const current = all.filter(
      (row) =>
        row.status === "final" &&
        row.superseded_by_snapshot_id === null
    );
    if (current.length !== 1) return null;
    const byId = new Map(
      all.map((row) => [row.id, row])
    );
    const reverse = [];
    const seen = new Set();
    let cursor = current[0];
    while (cursor) {
      if (seen.has(cursor.id)) return null;
      reverse.push(cursor);
      seen.add(cursor.id);
      cursor =
        cursor.replaces_finalization_id === null
          ? null
          : byId.get(
              cursor.replaces_finalization_id
            );
      if (
        cursor === undefined ||
        reverse.length > all.length
      ) {
        return null;
      }
    }
    const lineage = reverse.reverse();
    if (
      lineage.length !== all.length ||
      lineage.some(
        (row, index) =>
          row.finalization_version !== index + 1
      )
    ) {
      return null;
    }
    return {
      root: lineage[0],
      current: current[0],
      rows: lineage,
    };
  }

  function projectTeamIdentities(rows) {
    return rows.map((row) => {
      const {
        logo_content_bytes: bytes,
        ...projection
      } = row;
      if (bytes === null) {
        if (
          row.logo_byte_length !== null ||
          row.logo_content_sha256 !== null
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A standings logo identity is inconsistent."
          );
        }
      } else {
        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length !== row.logo_byte_length ||
          crypto
            .createHash("sha256")
            .update(bytes)
            .digest("hex") !==
            row.logo_content_sha256
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A standings logo identity digest is invalid."
          );
        }
      }
      return projection;
    });
  }

  function uniqueRowsBy(rows, key) {
    const result = new Map();
    for (const row of rows) {
      if (result.has(row[key])) return null;
      result.set(row[key], row);
    }
    return result;
  }

  function sameStoredIds(left, right) {
    if (left.length !== right.length) return false;
    const expected = [...left].sort();
    const actual = [...right].sort();
    return expected.every(
      (value, index) => value === actual[index]
    );
  }

  function isSafeStoredTimestamp(value) {
    return (
      Number.isSafeInteger(value) && value >= 0
    );
  }

  function isTerminalAuctionEvidence(
    collections,
    fad
  ) {
    const contextsByAuction = uniqueRowsBy(
      collections.auctionContexts,
      "auction_id"
    );
    const auctionsById = uniqueRowsBy(
      collections.auctions,
      "id"
    );
    if (
      contextsByAuction === null ||
      auctionsById === null ||
      contextsByAuction.size !==
        auctionsById.size
    ) {
      return false;
    }
    const resolutionsByAuction = new Map();
    for (const resolution of
      collections.auctionResolutions) {
      if (
        resolutionsByAuction.has(
          resolution.auction_id
        )
      ) {
        return false;
      }
      resolutionsByAuction.set(
        resolution.auction_id,
        resolution
      );
    }
    const bidsByAuction = new Map();
    for (const bid of collections.auctionBids) {
      if (!bidsByAuction.has(bid.auction_id)) {
        bidsByAuction.set(bid.auction_id, []);
      }
      bidsByAuction.get(bid.auction_id).push(bid);
    }
    const drawsByAuction = new Map();
    for (const draw of
      collections.freeAgentDraftDraws) {
      if (drawsByAuction.has(draw.auction_id)) {
        return false;
      }
      drawsByAuction.set(draw.auction_id, draw);
    }

    for (const auction of collections.auctions) {
      const context = contextsByAuction.get(
        auction.id
      );
      const resolution =
        resolutionsByAuction.get(auction.id);
      if (
        !context ||
        !resolution ||
        context.id !== auction.id ||
        context.league_id !== auction.league_id ||
        context.season_id !== auction.season_id ||
        resolution.league_id !==
          auction.league_id ||
        resolution.season_id !==
          auction.season_id ||
        !["resolved", "no_winner", "cancelled"].includes(
          auction.status
        ) ||
        ![
          "resolved",
          "no_bids",
          "no_winner",
          "cancelled",
          "recovered",
        ].includes(resolution.status) ||
        (bidsByAuction.get(auction.id) ?? []).some(
          ({ status }) => status === "active"
        )
      ) {
        return false;
      }
      if (
        (auction.status === "resolved" &&
          !["resolved", "recovered"].includes(
            resolution.status
          )) ||
        (auction.status === "no_winner" &&
          ![
            "no_bids",
            "no_winner",
            "recovered",
          ].includes(resolution.status)) ||
        (auction.status === "cancelled" &&
          !["cancelled", "recovered"].includes(
            resolution.status
          ))
      ) {
        return false;
      }
      const fadLinked =
        context.source_kind !== "ordinary_weekly";
      if (
        fadLinked
          ? context.fad_id !== fad.id
          : context.fad_id !== null
      ) {
        return false;
      }
      if (
        fadLinked &&
        !drawsByAuction.has(auction.id)
      ) {
        return false;
      }
    }
    return (
      collections.auctionResolutions.length ===
        collections.auctions.length &&
      [...resolutionsByAuction.keys()].every(
        (auctionId) =>
          auctionsById.has(auctionId)
      ) &&
      [...bidsByAuction.keys()].every(
        (auctionId) =>
          auctionsById.has(auctionId)
      )
    );
  }

  function isClosedFadEvidence(
    fad,
    readinessOperation,
    collections
  ) {
    const teamIds =
      collections.freeAgentDraftTeams.map(
        ({ team_id: id }) => id
      );
    const cardTeamIds =
      collections.candidateCards.map(
        ({ team_id: id }) => id
      );
    const snapshotTeamIds =
      collections.candidateCardSnapshots.map(
        ({ team_id: id }) => id
      );
    if (
      readinessOperation.id !==
        fad.readiness_operation_id ||
      readinessOperation.status !== "succeeded" ||
      readinessOperation.created_fad_id !==
        fad.id ||
      !isSafeStoredTimestamp(
        readinessOperation.terminal_at_ms
      ) ||
      fad.status !== "completed" ||
      !isSafeStoredTimestamp(
        fad.deadline_locked_at_ms
      ) ||
      !isSafeStoredTimestamp(
        fad.allocation_completed_at_ms
      ) ||
      !isSafeStoredTimestamp(fad.completed_at_ms) ||
      collections.freeAgentDraftTeams.length !==
        fad.participating_team_count ||
      new Set(teamIds).size !== teamIds.length ||
      !sameStoredIds(teamIds, cardTeamIds) ||
      !sameStoredIds(teamIds, snapshotTeamIds) ||
      collections.candidateCards.some(
        (card) =>
          ![
            "locked_complete",
            "locked_incomplete",
            "locked_conflicted",
          ].includes(card.status) ||
          !isSafeStoredTimestamp(card.locked_at_ms)
      ) ||
      collections.candidateCardSnapshots.some(
        (snapshot) =>
          ![
            "locked_complete",
            "locked_incomplete",
            "locked_conflicted",
          ].includes(snapshot.locked_status)
      ) ||
      collections.freeAgentDraftPlayerAllocations.some(
        (allocation) =>
          ![
            "automatic_award",
            "restricted_resolved",
            "fallback_open_resolved",
            "no_valid_offer",
            "invalid",
          ].includes(allocation.status) ||
          !isSafeStoredTimestamp(
            allocation.accounted_at_ms
          )
      ) ||
      collections.freeAgentDraftRollovers.length <
        7 ||
      collections.freeAgentDraftRollovers.some(
        (rollover, index) =>
          rollover.sequence !== index + 1 ||
          rollover.status !== "completed" ||
          !isSafeStoredTimestamp(
            rollover.completed_at_ms
          )
      ) ||
      collections.freeAgentDraftNominationQueue.some(
        (nomination) =>
          !["opened", "invalid"].includes(
            nomination.status
          ) ||
          !isSafeStoredTimestamp(
            nomination.terminal_at_ms
          )
      ) ||
      collections.freeAgentDraftRecoveries.some(
        (recovery) =>
          recovery.status !== "resolved" ||
          !isSafeStoredTimestamp(
            recovery.resolved_at_ms
          )
      )
    ) {
      return false;
    }
    const snapshotsByCard = uniqueRowsBy(
      collections.candidateCardSnapshots,
      "card_id"
    );
    if (
      snapshotsByCard === null ||
      collections.candidateCards.some(
        (card) =>
          snapshotsByCard.get(card.id)?.team_id !==
          card.team_id
      )
    ) {
      return false;
    }
    const allocationEventsByAllocation =
      new Map();
    for (const event of
      collections.freeAgentDraftAllocationEvents) {
      if (
        !allocationEventsByAllocation.has(
          event.allocation_id
        )
      ) {
        allocationEventsByAllocation.set(
          event.allocation_id,
          []
        );
      }
      allocationEventsByAllocation
        .get(event.allocation_id)
        .push(event);
    }
    if (
      collections.freeAgentDraftPlayerAllocations.some(
        (allocation) =>
          !(
            allocationEventsByAllocation.get(
              allocation.id
            ) ?? []
          ).some(
            (event) =>
              event.resulting_allocation_status ===
              allocation.status
          )
      )
    ) {
      return false;
    }
    const auctionIds = new Set(
      collections.auctions.map(({ id }) => id)
    );
    if (
      collections.freeAgentDraftNominationQueue.some(
        (nomination) =>
          nomination.status === "opened" &&
          !auctionIds.has(
            nomination.opened_auction_id
          )
      )
    ) {
      return false;
    }
    return isTerminalAuctionEvidence(
      collections,
      fad
    );
  }

  function isTerminalCompetitionEvidence(
    collections
  ) {
    const weeksById = uniqueRowsBy(
      collections.matchupWeeks,
      "id"
    );
    const matchupsById = uniqueRowsBy(
      collections.matchups,
      "id"
    );
    const resultsByMatchup = uniqueRowsBy(
      collections.matchupResults,
      "matchup_id"
    );
    if (
      weeksById === null ||
      matchupsById === null ||
      resultsByMatchup === null ||
      collections.matchupWeeks.length < 1 ||
      collections.matchups.length < 1 ||
      collections.matchupWeeks.some(
        (week, index) =>
          week.sequence !== index + 1 ||
          week.status !== "final"
      ) ||
      collections.matchups.some(
        (matchup) =>
          matchup.status !== "final" ||
          !weeksById.has(matchup.matchup_week_id)
      ) ||
      collections.matchupResults.length !==
        collections.matchups.length
    ) {
      return false;
    }
    const versionsByResult = new Map();
    for (const version of
      collections.matchupResultVersions) {
      if (
        !versionsByResult.has(
          version.matchup_result_id
        )
      ) {
        versionsByResult.set(
          version.matchup_result_id,
          []
        );
      }
      versionsByResult
        .get(version.matchup_result_id)
        .push(version);
    }
    for (const matchup of collections.matchups) {
      const result = resultsByMatchup.get(matchup.id);
      const versions =
        versionsByResult.get(result?.id) ?? [];
      if (
        !result ||
        !["official", "corrected"].includes(
          result.status
        ) ||
        !isSafeStoredTimestamp(
          result.finalized_at_ms
        ) ||
        versions.length < 1 ||
        versions.some(
          (version, index) =>
            version.version_number !== index + 1 ||
            version.home_team_id !==
              matchup.home_team_id ||
            version.away_team_id !==
              matchup.away_team_id
        ) ||
        versions.at(-1).id !==
          result.current_version_id
      ) {
        return false;
      }
    }
    const matchupOperationTypes = new Set([
      "schedule_generate",
      "week_transition",
      "result_finalize",
      "result_correct",
      "matchup_recovery_route",
    ]);
    if (
      collections.matchupOperations.some(
        (operation) =>
          !matchupOperationTypes.has(
            operation.operation_type
          ) ||
          !["succeeded", "skipped"].includes(
            operation.status
          ) ||
          !isSafeStoredTimestamp(
            operation.completed_at_ms
          )
      )
    ) {
      return false;
    }
    const standingsOperationTypes = new Set([
      "finalize_regular_season",
      "correction_propagation",
    ]);
    return !collections.standingsOperations.some(
      (operation) =>
        !standingsOperationTypes.has(
          operation.operation_type
        ) ||
        operation.status !== "succeeded" ||
        !isSafeStoredTimestamp(
          operation.completed_at_ms
        )
    );
  }

  function isCanonicalFinalizationEvidence({
    leagueId,
    seasonId,
    lineage,
    collections,
  }) {
    if (
      collections.finalStandingsFinalizations
        .length !== lineage.rows.length ||
      lineage.rows.length < 1
    ) {
      return false;
    }
    const snapshotsById = uniqueRowsBy(
      collections.standingsSnapshots,
      "id"
    );
    const operationsById = uniqueRowsBy(
      collections.standingsOperations,
      "id"
    );
    const idempotencyById = uniqueRowsBy(
      collections.finalizationIdempotencyRequests,
      "id"
    );
    if (
      snapshotsById === null ||
      operationsById === null ||
      idempotencyById === null
    ) {
      return false;
    }
    for (const [index, finalization] of
      lineage.rows.entries()) {
      const last =
        index === lineage.rows.length - 1;
      const prior =
        index === 0
          ? null
          : lineage.rows[index - 1];
      const next = last
        ? null
        : lineage.rows[index + 1];
      const snapshot = snapshotsById.get(
        finalization.standings_snapshot_id
      );
      const operation = operationsById.get(
        finalization.standings_operation_id
      );
      const idempotency = idempotencyById.get(
        finalization.idempotency_request_id
      );
      if (
        finalization.league_id !== leagueId ||
        finalization.season_id !== seasonId ||
        finalization.evidence_schema_version !== 1 ||
        finalization.result_set_hash_version !== 1 ||
        finalization.completeness_status !==
          "complete" ||
        finalization.finalized_matchup_count !==
          finalization.expected_matchup_count ||
        finalization.weeks_counted !==
          finalization.expected_week_count ||
        finalization.standings_row_count !==
          finalization.participant_count ||
        finalization.finalization_version !==
          index + 1 ||
        (last
          ? finalization.status !== "final"
          : finalization.status !==
            "superseded") ||
        (index === 0
          ? finalization.cause !==
              "regular_season_completion" ||
            finalization.replaces_finalization_id !==
              null
          : finalization.cause !==
              "result_correction" ||
            finalization.replaces_finalization_id !==
              prior.id) ||
        !snapshot ||
        snapshot.snapshot_version !==
          finalization.finalization_version ||
        snapshot.status !== "final" ||
        snapshot.calculated_at_ms !==
          finalization.finalized_at_ms ||
        !operation ||
        operation.standings_snapshot_id !==
          snapshot.id ||
        operation.status !== "succeeded" ||
        operation.operation_type !==
          (index === 0
            ? "finalize_regular_season"
            : "correction_propagation") ||
        !idempotency ||
        idempotency.status !== "completed" ||
        idempotency.operation !==
          (index === 0
            ? "standings.finalize_regular_season.v1"
            : "matchup.result.correct.v1") ||
        idempotency.result_type !==
          (index === 0
            ? "standings_finalization"
            : "matchup_result_correction") ||
        (index === 0 &&
          idempotency.result_id !==
            finalization.id)
      ) {
        return false;
      }
      if (
        next &&
        (finalization.superseded_by_snapshot_id !==
          next.standings_snapshot_id ||
          finalization.superseded_by_operation_id !==
            next.standings_operation_id ||
          finalization.superseded_by_user_id !==
            next.authorized_by_user_id ||
          finalization
            .superseded_by_membership_id !==
            next.authorized_by_membership_id ||
          finalization.superseded_by_authority !==
            next.authorized_authority)
      ) {
        return false;
      }
    }

    const active = lineage.current;
    const activeSnapshot = snapshotsById.get(
      active.standings_snapshot_id
    );
    if (!activeSnapshot) return false;
    const activeRows =
      collections.standingsRows.filter(
        (row) =>
          row.standings_snapshot_id ===
          activeSnapshot.id
      );
    const activeIdentities =
      collections.standingsSnapshotTeamIdentities.filter(
        (row) =>
          row.standings_snapshot_id ===
          activeSnapshot.id
      );
    const activeLinks =
      collections.standingsSnapshotResultVersions.filter(
        (row) =>
          row.standings_snapshot_id ===
          activeSnapshot.id
      );
    const resultById = uniqueRowsBy(
      collections.matchupResults,
      "id"
    );
    const versionById = uniqueRowsBy(
      collections.matchupResultVersions,
      "id"
    );
    if (
      !activeSnapshot ||
      resultById === null ||
      versionById === null ||
      active.expected_matchup_count !==
        collections.matchups.length ||
      active.expected_week_count !==
        collections.matchupWeeks.length ||
      activeRows.length !==
        active.participant_count ||
      activeIdentities.length !==
        active.participant_count ||
      activeLinks.length !==
        active.expected_matchup_count ||
      !sameStoredIds(
        activeRows.map(({ team_id: id }) => id),
        activeIdentities.map(
          ({ team_id: id }) => id
        )
      )
    ) {
      return false;
    }
    const matchupIds = new Set(
      collections.matchups.map(({ id }) => id)
    );
    let sourceResultVersion = 0;
    const descriptors = [];
    for (const link of activeLinks) {
      const result = resultById.get(
        link.matchup_result_id
      );
      const version = versionById.get(
        link.matchup_result_version_id
      );
      if (
        !matchupIds.has(link.matchup_id) ||
        !result ||
        result.matchup_id !== link.matchup_id ||
        result.current_version_id !== version?.id ||
        version.matchup_result_id !== result.id ||
        version.version_number !==
          link.result_version_number
      ) {
        return false;
      }
      sourceResultVersion +=
        link.result_version_number;
      if (
        !Number.isSafeInteger(
          sourceResultVersion
        )
      ) {
        return false;
      }
      descriptors.push({
        matchupId: link.matchup_id,
        matchupResultId:
          link.matchup_result_id,
        resultVersionId:
          link.matchup_result_version_id,
        resultVersion:
          link.result_version_number,
      });
    }
    return (
      new Set(
        activeLinks.map(
          ({ matchup_id: id }) => id
        )
      ).size === matchupIds.size &&
      sourceResultVersion ===
        activeSnapshot.source_result_version &&
      calculateStandingsResultSetHash({
        leagueId,
        seasonId,
        standingsRuleVersion: String(
          active.standings_rule_version
        ),
        results: descriptors,
      }) === active.result_set_hash
    );
  }

  function recoveryCoversFailedJob(
    job,
    fad,
    collections
  ) {
    const recoveries =
      collections.freeAgentDraftRecoveries.filter(
        (recovery) =>
          recovery.job_run_id === job.id
      );
    if (
      recoveries.length < 1 ||
      recoveries.some(
        (recovery) =>
          recovery.status !== "resolved"
      )
    ) {
      return false;
    }
    const allocations = new Map(
      collections.freeAgentDraftPlayerAllocations.map(
        (allocation) => [
          allocation.id,
          allocation,
        ]
      )
    );
    const rollovers = new Map(
      collections.freeAgentDraftRollovers.map(
        (rollover) => [
          rollover.id,
          rollover,
        ]
      )
    );
    const auctions = new Map(
      collections.auctions.map((auction) => [
        auction.id,
        auction,
      ])
    );
    return recoveries.every((recovery) => {
      if (
        recovery.allocation_id !== null &&
        ![
          "automatic_award",
          "restricted_resolved",
          "fallback_open_resolved",
          "no_valid_offer",
          "invalid",
        ].includes(
          allocations.get(recovery.allocation_id)
            ?.status
        )
      ) {
        return false;
      }
      if (
        recovery.rollover_id !== null &&
        rollovers.get(recovery.rollover_id)
          ?.status !== "completed"
      ) {
        return false;
      }
      if (
        recovery.auction_id !== null &&
        !["resolved", "no_winner", "cancelled"].includes(
          auctions.get(recovery.auction_id)?.status
        )
      ) {
        return false;
      }
      return (
        recovery.fad_id === fad.id &&
        isSafeStoredTimestamp(
          recovery.resolved_at_ms
        )
      );
    });
  }

  function isUntouchedSupersededMatchupJob({
    job,
    leagueId,
    seasonId,
    scheduleEvidence,
  }) {
    if (
      job.league_id !== leagueId ||
      job.season_id !== seasonId ||
      typeof job.job_type !== "string" ||
      !job.job_type.startsWith("matchup:") ||
      job.attempt_count !== 0 ||
      job.lease_owner !== null ||
      job.lease_token !== null ||
      job.lease_expires_at_ms !== null ||
      job.started_at_ms !== null ||
      job.completed_at_ms !== null ||
      job.result_json !== null ||
      job.last_error_code !== null ||
      job.next_attempt_at_ms !== null
    ) {
      return false;
    }
    const bindings =
      scheduleEvidence.bindings.filter(
        (binding) =>
          binding.job_run_id === job.id
      );
    if (bindings.length !== 1) return false;
    const [binding] = bindings;
    if (
      binding.league_id !== leagueId ||
      binding.season_id !== seasonId ||
      binding.job_type !== job.job_type ||
      binding.version !== 1 ||
      binding.created_at_ms !== job.created_at_ms
    ) {
      return false;
    }
    const boundGenerations =
      scheduleEvidence.generations.filter(
        (generation) =>
          generation.league_id === leagueId &&
          generation.season_id === seasonId &&
          generation.schedule_operation_id ===
            binding.schedule_operation_id &&
          generation.schedule_version ===
            binding.schedule_version
      );
    if (boundGenerations.length !== 1) {
      return false;
    }
    const [boundGeneration] = boundGenerations;
    if (
      boundGeneration.status !== "superseded" ||
      !isSafeStoredTimestamp(
        boundGeneration.created_at_ms
      ) ||
      !isSafeStoredTimestamp(
        boundGeneration.superseded_at_ms
      ) ||
      boundGeneration.superseded_at_ms <
        boundGeneration.created_at_ms
    ) {
      return false;
    }
    const currentGenerations =
      scheduleEvidence.generations.filter(
        (generation) =>
          generation.league_id === leagueId &&
          generation.season_id === seasonId &&
          generation.status === "current"
      );
    if (currentGenerations.length !== 1) {
      return false;
    }
    const [currentGeneration] =
      currentGenerations;
    return (
      currentGeneration.superseded_at_ms ===
        null &&
      isSafeStoredTimestamp(
        currentGeneration.created_at_ms
      ) &&
      currentGeneration.schedule_version >
        boundGeneration.schedule_version &&
      currentGeneration.schedule_operation_id !==
        boundGeneration.schedule_operation_id &&
      currentGeneration.created_at_ms >=
        boundGeneration.superseded_at_ms
    );
  }

  function isTerminalJobEvidence({
    fad,
    leagueId,
    seasonId,
    collections,
    scheduleEvidence,
  }) {
    return collections.jobRuns.every((job) => {
      const noLease =
        job.lease_owner === null &&
        job.lease_token === null &&
        job.lease_expires_at_ms === null;
      if (!noLease) return false;
      if (job.status === "succeeded") {
        if (
          !isSafeStoredTimestamp(job.started_at_ms) ||
          !isSafeStoredTimestamp(
            job.completed_at_ms
          ) ||
          job.next_attempt_at_ms !== null ||
          job.last_error_code !== null
        ) {
          return false;
        }
      } else if (job.status === "skipped") {
        if (
          !isUntouchedSupersededMatchupJob({
            job,
            leagueId,
            seasonId,
            scheduleEvidence,
          })
        ) {
          return false;
        }
      } else if (job.status === "failed") {
        if (
          !isSafeStoredTimestamp(job.started_at_ms) ||
          !isSafeStoredTimestamp(
            job.completed_at_ms
          ) ||
          typeof job.last_error_code !== "string" ||
          !recoveryCoversFailedJob(
            job,
            fad,
            collections
          )
        ) {
          return false;
        }
      } else {
        return false;
      }
      if (job.result_json !== null) {
        try {
          JSON.parse(job.result_json);
        } catch {
          return false;
        }
      }
      return true;
    });
  }

  function isClosedSourceReadiness({
    leagueId,
    seasonId,
    fad,
    readinessOperation,
    lineage,
    collections,
    scheduleEvidence,
  }) {
    return (
      isClosedFadEvidence(
        fad,
        readinessOperation,
        collections
      ) &&
      isTerminalCompetitionEvidence(
        collections
      ) &&
      isCanonicalFinalizationEvidence({
        leagueId,
        seasonId,
        lineage,
        collections,
      }) &&
      isTerminalJobEvidence({
        fad,
        leagueId,
        seasonId,
        collections,
        scheduleEvidence,
      })
    );
  }

  function buildSourceReadiness({
    leagueId,
    seasonId,
    observedAtMs,
  }) {
    const fad = requireUnique(
      statement(
        "source-completed-fad",
        `SELECT *
         FROM free_agent_drafts
         WHERE league_id = @leagueId
           AND season_id = @seasonId
           AND status = 'completed'
           AND completed_at_ms IS NOT NULL
         ORDER BY completed_at_ms DESC, id
         LIMIT 2`
      ).all({ leagueId, seasonId }),
      "Completed source FAD",
      "free_agent_drafts"
    );
    const lineage = currentFinalizationLineage({
      leagueId,
      seasonId,
    });
    if (!fad || !lineage) return null;
    const readinessOperation = requireUnique(
      statement(
        "source-readiness-operation",
        `SELECT *
         FROM free_agent_draft_readiness_operations
         WHERE league_id = @leagueId
           AND season_id = @seasonId
           AND id = @readinessOperationId
           AND status = 'succeeded'
         LIMIT 2`
      ).all({
        leagueId,
        seasonId,
        readinessOperationId:
          fad.readiness_operation_id,
      }),
      "Source FAD readiness operation",
      "free_agent_draft_readiness_operations"
    );
    if (!readinessOperation) return null;

    const params = {
      leagueId,
      seasonId,
      fadId: fad.id,
    };
    const collections = {};
    for (const [
      key,
      tableName,
      predicate,
      orderBy,
    ] of SOURCE_COLLECTIONS) {
      collections[key] = selectAll(
        `source-${tableName}`,
        tableName,
        predicate,
        orderBy,
        params
      );
    }
    collections.auctions = selectAll(
      "source-auctions",
      "auctions",
      "season_id = @seasonId",
      "id",
      params
    );
    collections.auctionBids = selectAll(
      "source-auction-bids",
      "auction_bids",
      "season_id = @seasonId",
      "auction_id, team_id, id",
      params
    );
    collections.auctionResolutions =
      selectAll(
        "source-auction-resolutions",
        "auction_resolutions",
        "season_id = @seasonId",
        "auction_id, id",
        params
      );
    const scheduleEvidence = {
      bindings: selectAll(
        "source-matchup-schedule-job-bindings",
        "matchup_schedule_job_bindings",
        "season_id = @seasonId",
        "job_run_id, id",
        params
      ),
      generations: selectAll(
        "source-matchup-schedule-generations",
        "season_matchup_schedule_generations",
        "season_id = @seasonId",
        "schedule_version, schedule_operation_id",
        params
      ),
    };

    const finalizationIds = new Set(
      lineage.rows.map(({ id }) => id)
    );
    const snapshotIds = new Set(
      lineage.rows.map(
        ({ standings_snapshot_id: id }) => id
      )
    );
    const operationIds = new Set(
      lineage.rows.map(
        ({ standings_operation_id: id }) => id
      )
    );
    const idempotencyIds = new Set(
      lineage.rows.map(
        ({ idempotency_request_id: id }) => id
      )
    );
    collections.finalStandingsFinalizations =
      lineage.rows;
    collections.standingsSnapshots = selectAll(
      "source-standings-snapshots",
      "standings_snapshots",
      "season_id = @seasonId",
      "snapshot_version, id",
      params
    ).filter((row) => snapshotIds.has(row.id));
    collections.standingsRows = selectAll(
      "source-standings-rows",
      "standings_rows",
      "season_id = @seasonId",
      "standings_snapshot_id, rank, team_id, id",
      params
    ).filter((row) =>
      snapshotIds.has(row.standings_snapshot_id)
    );
    collections.standingsSnapshotTeamIdentities =
      projectTeamIdentities(
        selectAll(
          "source-standings-identities",
          "standings_snapshot_team_identities",
          "season_id = @seasonId",
          "standings_snapshot_id, team_id, id",
          params
        ).filter((row) =>
          snapshotIds.has(
            row.standings_snapshot_id
          )
        )
      );
    collections.standingsSnapshotResultVersions =
      selectAll(
        "source-standings-result-links",
        "standings_snapshot_result_versions",
        "season_id = @seasonId",
        "standings_snapshot_id, matchup_id, id",
        params
      ).filter((row) =>
        snapshotIds.has(row.standings_snapshot_id)
      );
    collections.finalizationIdempotencyRequests =
      statement(
        "source-finalization-idempotency",
        `SELECT *
         FROM idempotency_requests
         WHERE league_id = @leagueId
         ORDER BY id`
      )
        .all(params)
        .filter((row) =>
          idempotencyIds.has(row.id)
        );

    if (
      !finalizationIds.has(lineage.current.id) ||
      !snapshotIds.has(
        lineage.current.standings_snapshot_id
      ) ||
      !operationIds.has(
        lineage.current.standings_operation_id
      )
    ) {
      return null;
    }
    if (
      !isClosedSourceReadiness({
        leagueId,
        seasonId,
        fad,
        readinessOperation,
        lineage,
        collections,
        scheduleEvidence,
      })
    ) {
      return null;
    }
    const projection = {
      leagueId,
      fromSeasonId: seasonId,
      observedAtMs,
      sourceFadId: fad.id,
      sourceFadCompletedAtMs:
        fad.completed_at_ms,
      sourceFinalizationRootId:
        lineage.root.id,
      sourceFinalizationId:
        lineage.current.id,
      sourceStandingsSnapshotId:
        lineage.current.standings_snapshot_id,
      sourceStandingsOperationId:
        lineage.current.standings_operation_id,
      recognizedSeasonOperationTables: [
        "matchup_operations",
        "standings_operations",
      ],
      freeAgentDraft: fad,
      freeAgentDraftReadinessOperation:
        readinessOperation,
      ...collections,
    };
    const projectionJson =
      serializeSeasonRolloverSourceReadiness(
        projection
      );
    return deepFreeze({
      schemaVersion: 1,
      projection,
      projectionJson,
      projectionSha256:
        hashSeasonRolloverSourceReadiness(
          projection
        ),
    });
  }

  function buildRolloverMatrix({
    leagueId,
    sourceSeasonId,
    targetSeasonId,
  }) {
    const violations = [];
    const allContractRows = statement(
      "matrix-all-contracts",
      `SELECT *
       FROM contracts
       WHERE league_id = @leagueId
       ORDER BY id`
    ).all({ leagueId });
    const contractRows = allContractRows.filter(
      ({ status }) => status === "active"
    );
    const ownershipRows = statement(
      "matrix-ownerships",
      `SELECT *
       FROM player_ownerships
       WHERE league_id = @leagueId
         AND season_id = @sourceSeasonId
       ORDER BY id`
    ).all({ leagueId, sourceSeasonId });
    const allRetentionRows = statement(
      "matrix-all-retentions",
      `SELECT *
       FROM retention_obligations
       WHERE league_id = @leagueId
       ORDER BY id`
    ).all({ leagueId });
    const retentionRows = allRetentionRows.filter(
      ({ status }) => status === "active"
    );
    const allBuyoutRows = statement(
      "matrix-all-buyouts",
      `SELECT *
       FROM buyout_obligations
       WHERE league_id = @leagueId
       ORDER BY id`
    ).all({ leagueId });
    const buyoutRows = allBuyoutRows.filter(
      ({ status }) => status === "active"
    );
    const displaySetRows = statement(
      "matrix-display-order-sets",
      `SELECT *
       FROM roster_display_order_sets
       WHERE league_id = @leagueId
       ORDER BY id`
    ).all({ leagueId });
    const displayRows = statement(
      "matrix-display-order",
      `SELECT *
       FROM roster_display_order_entries
       WHERE league_id = @leagueId
       ORDER BY order_set_id, id`
    ).all({ leagueId });
    const contractYears = statement(
      "matrix-contract-years",
      `SELECT *
       FROM contract_years
       WHERE league_id = @leagueId
       ORDER BY contract_id, year_number, id`
    ).all({ leagueId });
    const retentionYears = statement(
      "matrix-retention-years",
      `SELECT *
       FROM retention_years
       WHERE league_id = @leagueId
       ORDER BY retention_obligation_id, season_id, id`
    ).all({ leagueId });
    const buyoutYears = statement(
      "matrix-buyout-years",
      `SELECT *
       FROM buyout_years
       WHERE league_id = @leagueId
       ORDER BY buyout_obligation_id, season_id, id`
    ).all({ leagueId });
    const contractsById = new Map(
      allContractRows.map((row) => [
        row.id,
        row,
      ])
    );
    const contractYearsById = new Map();
    for (const year of contractYears) {
      if (!contractYearsById.has(year.contract_id)) {
        contractYearsById.set(
          year.contract_id,
          []
        );
      }
      contractYearsById
        .get(year.contract_id)
        .push(year);
    }
    for (const contract of allContractRows) {
      const years =
        contractYearsById.get(contract.id) ?? [];
      const ordered = [...years].sort(
        (left, right) =>
          left.year_number -
            right.year_number ||
          left.id.localeCompare(right.id)
      );
      const sourceYears = years.filter(
        (year) =>
          year.season_id === sourceSeasonId &&
          year.status === "current"
      );
      const targetYears = years.filter(
        (year) =>
          year.season_id === targetSeasonId
      );
      if (
        years.length !==
          contract.original_term_years ||
        ordered.some(
          (year, index) =>
            year.year_number !== index + 1 ||
            year.aav_cents !==
              contract.aav_cents
        ) ||
        ordered[0]?.season_id !==
          contract.start_season_id
      ) {
        violations.push(
          `contract:${contract.id}:schedule`
        );
        continue;
      }
      if (contract.status !== "active") {
        if (
          years.some(({ status }) =>
            ["current", "future"].includes(
              status
            )
          )
        ) {
          violations.push(
            `contract:${contract.id}:terminal`
          );
        }
        continue;
      }
      if (
        sourceYears.length !== 1 ||
        targetYears.length > 1
      ) {
        violations.push(
          `contract:${contract.id}:years`
        );
        continue;
      }
      const sourceYear = sourceYears[0];
      const targetYear = targetYears[0] ?? null;
      if (
        ordered.some((year) => {
          if (
            year.year_number <
            sourceYear.year_number
          ) {
            return year.status !== "completed";
          }
          if (
            year.year_number ===
            sourceYear.year_number
          ) {
            return (
              year.status !== "current" ||
              year.rollover_at_ms !== null
            );
          }
          return (
            year.status !== "future" ||
            year.rollover_at_ms !== null
          );
        }) ||
        (sourceYear.year_number <
        contract.original_term_years
          ? !targetYear ||
            targetYear.year_number !==
              sourceYear.year_number + 1 ||
            targetYear.status !== "future"
          : targetYear !== null)
      ) {
        violations.push(
          `contract:${contract.id}:sequence`
        );
      }
    }

    const displaySetsById = new Map(
      displaySetRows.map((row) => [
        row.id,
        row,
      ])
    );
    const sourceOwnershipsById = new Map(
      ownershipRows.map((row) => [
        row.id,
        row,
      ])
    );
    for (const entry of displayRows) {
      const ownership =
        sourceOwnershipsById.get(
          entry.ownership_id
        );
      const orderSet = displaySetsById.get(
        entry.order_set_id
      );
      if (
        !ownership ||
        !orderSet ||
        orderSet.season_id !== sourceSeasonId ||
        orderSet.team_id !== ownership.team_id ||
        entry.position_group !==
          ownership.position_group
      ) {
        violations.push(
          `display-order:${entry.id}:closure`
        );
      }
    }

    function validateObligationRows(
      rows,
      years,
      kind
    ) {
      const parentColumn =
        kind === "retention"
          ? "retention_obligation_id"
          : "buyout_obligation_id";
      const amountColumn =
        kind === "retention"
          ? "retained_aav_cents"
          : "penalty_cents";
      const parentAmount =
        kind === "retention"
          ? "retained_aav_cents"
          : "annual_penalty_basis_cents";
      for (const row of rows) {
        const contract =
          contractsById.get(row.contract_id);
        const rowYears = years.filter(
          (year) =>
            year[parentColumn] === row.id
        );
        const sourceYears = rowYears.filter(
          (year) =>
            year.season_id === sourceSeasonId &&
            year.status === "current"
        );
        const targetYears = rowYears.filter(
          (year) =>
            year.season_id === targetSeasonId
        );
        if (
          !contract ||
          contract.player_id !== row.player_id ||
          rowYears.some(
            (year) =>
              year[amountColumn] !==
              row[parentAmount]
          )
        ) {
          violations.push(
            `${kind}:${row.id}:contract`
          );
          continue;
        }
        if (row.status !== "active") {
          if (
            rowYears.some(({ status }) =>
              ["current", "future"].includes(
                status
              )
            )
          ) {
            violations.push(
              `${kind}:${row.id}:terminal`
            );
          }
          continue;
        }
        if (
          sourceYears.length !== 1 ||
          targetYears.length > 1 ||
          (targetYears.length === 0 &&
            rowYears.some(
              ({ status }) => status === "future"
            )) ||
          (kind === "retention"
            ? !["active", "eliminated"].includes(
                contract.status
              )
            : contract.status !== "eliminated")
        ) {
          violations.push(
            `${kind}:${row.id}:schedule`
          );
          continue;
        }
        const contractYearIds = new Set(
          (
            contractYearsById.get(contract.id) ??
            []
          )
            .filter((year) =>
              contract.status === "active"
                ? ["current", "future"].includes(
                    year.status
                  )
                : year.status === "eliminated"
            )
            .map(({ season_id: id }) => id)
        );
        if (
          rowYears
            .filter(({ status }) =>
              ["current", "future"].includes(
                status
              )
            )
            .some(
              ({ season_id: id }) =>
                !contractYearIds.has(id)
            )
        ) {
          violations.push(
            `${kind}:${row.id}:term`
          );
        }
      }
    }
    validateObligationRows(
      allRetentionRows,
      retentionYears,
      "retention"
    );
    validateObligationRows(
      allBuyoutRows,
      buyoutYears,
      "buyout"
    );
    const contractEffects = [];
    const contractById = new Map();
    const ownershipById = new Map();
    const ownershipByPlayerTeam = new Map();

    for (const ownership of ownershipRows) {
      ownershipById.set(ownership.id, ownership);
      const key =
        `${ownership.player_id}:` +
        ownership.team_id;
      if (!ownershipByPlayerTeam.has(key)) {
        ownershipByPlayerTeam.set(key, []);
      }
      ownershipByPlayerTeam.get(key).push(ownership);
    }
    for (const row of contractRows) {
      const years = contractYears.filter(
        (year) => year.contract_id === row.id
      );
      const sourceYears = years.filter(
        (year) =>
          year.season_id === sourceSeasonId &&
          year.status === "current"
      );
      const targetYears = years.filter(
        (year) =>
          year.season_id === targetSeasonId
      );
      const ownerships =
        ownershipByPlayerTeam.get(
          `${row.player_id}:${row.current_team_id}`
        ) ?? [];
      if (
        sourceYears.length !== 1 ||
        targetYears.length > 1 ||
        ownerships.length !== 1
      ) {
        violations.push(
          `contract:${row.id}:closure`
        );
        continue;
      }
      const effectKind =
        targetYears.length === 1 &&
        targetYears[0].status === "future"
          ? "contract_advanced"
          : "contract_expired";
      const effect = {
        entityId: row.id,
        effectKind,
        ownershipId: ownerships[0].id,
        before: camelContract(row, years),
      };
      contractEffects.push(effect);
      contractById.set(row.id, effect);
    }

    const ownershipEffects = [];
    const releasedOwnershipByPlayer = new Map();
    for (const row of ownershipRows) {
      const rosteredCategory = [
        "Active",
        "Bench",
        "Injured Reserve",
      ].includes(row.roster_category);
      if (
        (row.ownership_kind === "Rostered") !==
          rosteredCategory ||
        (row.ownership_kind ===
          "Prospect Right") !==
          (row.roster_category === "Prospect")
      ) {
        violations.push(
          `ownership:${row.id}:shape`
        );
        continue;
      }
      const matchingContracts = contractRows.filter(
        (contract) =>
          contract.player_id === row.player_id &&
          contract.current_team_id === row.team_id
      );
      let contractId = null;
      if (row.ownership_kind === "Rostered") {
        if (matchingContracts.length !== 1) {
          violations.push(
            `ownership:${row.id}:contract`
          );
          continue;
        }
        contractId = matchingContracts[0].id;
      } else if (
        row.ownership_kind === "Prospect Right"
      ) {
        if (
          matchingContracts.length > 1 ||
          (matchingContracts.length === 1 &&
            matchingContracts[0].contract_type !==
              "fantasy_elc")
        ) {
          violations.push(
            `ownership:${row.id}:prospect`
          );
          continue;
        }
        contractId =
          matchingContracts[0]?.id ?? null;
      } else {
        violations.push(
          `ownership:${row.id}:kind`
        );
        continue;
      }
      const contractEffect =
        contractId === null
          ? null
          : contractById.get(contractId);
      if (
        contractId !== null &&
        !contractEffect
      ) {
        violations.push(
          `ownership:${row.id}:matrix`
        );
        continue;
      }
      const effectKind =
        contractEffect?.effectKind ===
        "contract_expired"
          ? "ownership_released"
          : "ownership_carried";
      const effect = {
        entityId: row.id,
        effectKind,
        contractId,
        before: camelOwnership(
          row,
          displayRows.filter(
            (entry) =>
              entry.ownership_id === row.id
          )
        ),
      };
      ownershipEffects.push(effect);
      if (effectKind === "ownership_released") {
        if (
          releasedOwnershipByPlayer.has(
            row.player_id
          )
        ) {
          violations.push(
            `ownership:${row.player_id}:duplicate`
          );
        }
        releasedOwnershipByPlayer.set(
          row.player_id,
          effect
        );
      }
    }

    function obligationEffects(
      rows,
      years,
      kind
    ) {
      return rows.flatMap((row) => {
        const rowYears = years.filter(
          (year) =>
            year[
              kind === "retention"
                ? "retention_obligation_id"
                : "buyout_obligation_id"
            ] === row.id
        );
        const sourceYears = rowYears.filter(
          (year) =>
            year.season_id === sourceSeasonId &&
            year.status === "current"
        );
        const targetYears = rowYears.filter(
          (year) =>
            year.season_id === targetSeasonId
        );
        if (
          sourceYears.length !== 1 ||
          targetYears.length > 1
        ) {
          violations.push(
            `${kind}:${row.id}:years`
          );
          return [];
        }
        const prefix =
          kind === "retention"
            ? "retention"
            : "buyout";
        return [
          {
            entityId: row.id,
            effectKind:
              targetYears.length === 1 &&
              targetYears[0].status === "future"
                ? `${prefix}_year_advanced`
                : `${prefix}_obligation_completed`,
            before: camelObligation(
              row,
              rowYears,
              kind
            ),
          },
        ];
      });
    }

    const retentionEffects = obligationEffects(
      retentionRows,
      retentionYears,
      "retention"
    );
    const buyoutEffects = obligationEffects(
      buyoutRows,
      buyoutYears,
      "buyout"
    );
    const retentionById = new Map(
      retentionEffects.map((effect) => [
        effect.entityId,
        effect,
      ])
    );
    const buyoutById = new Map(
      buyoutEffects.map((effect) => [
        effect.entityId,
        effect,
      ])
    );
    const allTradeRows = statement(
      "matrix-all-trades",
      `SELECT *
       FROM trades
       WHERE league_id = @leagueId
         AND season_id = @sourceSeasonId
       ORDER BY id`
    ).all({ leagueId, sourceSeasonId });
    const tradeRows = allTradeRows.filter(
      ({ status }) => status === "proposed"
    );
    const tradeAssets = statement(
      "matrix-trade-assets",
      `SELECT *
       FROM trade_assets
       WHERE league_id = @leagueId
         AND trade_id IN (
           SELECT id
           FROM trades
           WHERE league_id = @leagueId
             AND season_id = @sourceSeasonId
             AND status = 'proposed'
         )
       ORDER BY trade_id, sequence, id`
    ).all({ leagueId, sourceSeasonId });
    const tradeEffects = [];
    for (const row of tradeRows) {
      const assets = tradeAssets.filter(
        (asset) => asset.trade_id === row.id
      );
      const causalEffects = [];
      for (const asset of assets) {
        let effect = null;
        if (asset.asset_type === "contract") {
          effect = contractById.get(
            asset.contract_id
          );
          if (
            effect?.effectKind !==
            "contract_expired"
          ) {
            effect = null;
          }
        } else if (
          asset.asset_type ===
          "requested_retention"
        ) {
          effect = contractById.get(
            asset.requested_retention_contract_id
          );
          if (
            effect?.effectKind !==
            "contract_expired"
          ) {
            effect = null;
          }
        } else if (
          asset.asset_type === "prospect_right"
        ) {
          effect =
            releasedOwnershipByPlayer.get(
              asset.player_id
            ) ?? null;
        } else if (
          asset.asset_type ===
          "retention_obligation"
        ) {
          effect = retentionById.get(
            asset.retention_obligation_id
          );
          if (
            effect?.effectKind !==
            "retention_obligation_completed"
          ) {
            effect = null;
          }
        } else if (
          asset.asset_type ===
          "buyout_obligation"
        ) {
          effect = buyoutById.get(
            asset.buyout_obligation_id
          );
          if (
            effect?.effectKind !==
            "buyout_obligation_completed"
          ) {
            effect = null;
          }
        }
        if (effect) {
          causalEffects.push({
            tradeAssetSequence: asset.sequence,
            tradeAssetType: asset.asset_type,
            effectKind: effect.effectKind,
            entityId: effect.entityId,
          });
        }
      }
      if (causalEffects.length > 0) {
        tradeEffects.push({
          entityId: row.id,
          effectKind: "trade_cancelled",
          causalEffects,
          before: camelTrade(row, assets),
        });
      }
    }
    const qualifyingTradeIds = new Set(
      tradeEffects.map(
        ({ entityId: id }) => id
      )
    );
    for (const row of allTradeRows) {
      if (
        ["accepted", "correction_required"].includes(
          row.status
        ) ||
        (row.status === "proposed" &&
          !qualifyingTradeIds.has(row.id)) ||
        ![
          "proposed",
          "declined",
          "cancelled",
          "expired",
          "completed",
          "reversed",
          "accepted",
          "correction_required",
        ].includes(row.status)
      ) {
        violations.push(
          `trade:${row.id}:terminal`
        );
      }
    }

    return deepFreeze({
      violations,
      totals: {
        activeContractIds: contractRows.map(
          ({ id }) => id
        ),
        liveOwnershipIds: ownershipRows.map(
          ({ id }) => id
        ),
        activeRetentionIds: retentionRows.map(
          ({ id }) => id
        ),
        activeBuyoutIds: buyoutRows.map(
          ({ id }) => id
        ),
        qualifyingTradeIds: tradeEffects.map(
          ({ entityId }) => entityId
        ),
      },
      contractEffects,
      ownershipEffects,
      retentionEffects,
      buyoutEffects,
      tradeEffects,
    });
  }

  function targetDisallowedStateCount({
    leagueId,
    targetSeasonId,
    entryDraftId,
    bindingId,
    rolloverOccurrenceId,
  }) {
    const params = {
      leagueId,
      targetSeasonId,
      entryDraftId,
      bindingId,
      rolloverOccurrenceId,
    };
    const row = statement(
      "target-disallowed-count",
      `SELECT
         (SELECT COUNT(*) FROM player_ownerships
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM free_agent_drafts
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM free_agent_draft_readiness_operations
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM free_agent_draft_setup_exemptions
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM auctions
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM season_rollovers
          WHERE league_id = @leagueId
            AND (
              from_season_id = @targetSeasonId
              OR to_season_id = @targetSeasonId
            ))
       + (SELECT COUNT(*) FROM season_rollover_attempts
          WHERE league_id = @leagueId
            AND (
              from_season_id = @targetSeasonId
              OR to_season_id = @targetSeasonId
            )
            AND (
              binding_id <> @bindingId
              OR rollover_occurrence_id <>
                @rolloverOccurrenceId
            ))
       + (SELECT COUNT(*) FROM matchup_weeks
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId
            AND status <> 'scheduled')
       + (SELECT COUNT(*) FROM matchups
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId
            AND status <> 'scheduled')
       + (SELECT COUNT(*) FROM matchup_results
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM matchup_result_versions
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM matchup_roster_locks
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM matchup_roster_players
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM matchup_roster_game_exclusions
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM standings_snapshots
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM standings_snapshot_finalizations
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM standings_operations
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM matchup_operations
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId
            AND NOT EXISTS (
              SELECT 1
              FROM season_matchup_schedule_generations
              WHERE season_matchup_schedule_generations.league_id =
                  matchup_operations.league_id
                AND season_matchup_schedule_generations.season_id =
                  matchup_operations.season_id
                AND season_matchup_schedule_generations.schedule_operation_id =
                  matchup_operations.id
                AND matchup_operations.operation_type =
                  'schedule_generate'
                AND matchup_operations.status =
                  'succeeded'
                AND matchup_operations.completed_at_ms IS NOT NULL
            ))
       + (SELECT COUNT(*) FROM job_runs
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId
            AND NOT EXISTS (
              SELECT 1
              FROM season_rollover_occurrences
              WHERE season_rollover_occurrences.league_id =
                  job_runs.league_id
                AND season_rollover_occurrences.binding_id =
                  @bindingId
                AND season_rollover_occurrences.scheduled_job_run_id =
                  job_runs.id
            ))
       + (SELECT COUNT(*) FROM trades
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM future_considerations
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM trade_events
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM ownership_events
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM entry_draft_pick_clocks
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM entry_draft_on_clock_trades
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM roster_display_order_sets
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM commissioner_corrections
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM operational_events
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM stat_snapshots
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM league_activity
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId)
       + (SELECT COUNT(*) FROM entry_drafts
          WHERE league_id = @leagueId
            AND season_id = @targetSeasonId
            AND id <> @entryDraftId)
         AS disallowed_count`
    ).get(params);
    return row.disallowed_count;
  }

  function readSeasonRolloverContext(
    command = {}
  ) {
    exactObject(
      command,
      [
        "leagueId",
        "bindingId",
        "entryDraftId",
        "rolloverOccurrenceId",
        "fromSeasonId",
        "toSeasonId",
        "targetScheduleId",
        "observedAtMs",
      ],
      "An exact rollover-context query is required."
    );
    const params = {
      leagueId: stableId(command.leagueId, "league ID"),
      bindingId: stableId(
        command.bindingId,
        "rollover-binding ID"
      ),
      entryDraftId: stableId(
        command.entryDraftId,
        "Entry Draft ID"
      ),
      rolloverOccurrenceId: stableId(
        command.rolloverOccurrenceId,
        "rollover-occurrence ID"
      ),
      fromSeasonId: stableId(
        command.fromSeasonId,
        "source-season ID"
      ),
      toSeasonId: stableId(
        command.toSeasonId,
        "target-season ID"
      ),
      targetScheduleId: stableId(
        command.targetScheduleId,
        "target-schedule ID"
      ),
      observedAtMs: safeTimestamp(
        command.observedAtMs,
        "rollover observation timestamp"
      ),
    };
    return mapped(
      "readSeasonRolloverContext",
      "entry_draft_rollover_bindings",
      () => {
        const row = requireUnique(
          statement(
            "rollover-context-aggregate",
            `SELECT
               league.id AS league_id,
               league.status AS league_status,
               league.timezone AS league_timezone,
               league.version AS league_version,
               league.current_season_id,
               source.status AS source_status,
               source.version AS source_version,
               source.label AS source_label,
               source.nhl_season_key AS source_nhl_season_key,
               source.regular_season_starts_at_ms AS source_regular_starts_at_ms,
               source.regular_season_ends_at_ms AS source_regular_ends_at_ms,
               source.fantasy_playoffs_start_at_ms AS source_playoffs_starts_at_ms,
               source.fantasy_playoffs_end_at_ms AS source_playoffs_ends_at_ms,
               source.free_agent_draft_completed_at_ms AS source_fad_completed_at_ms,
               target.id AS target_id,
               target.status AS target_status,
               target.version AS target_version,
               target.label AS target_label,
               target.nhl_season_key AS target_nhl_season_key,
               target.regular_season_starts_at_ms AS target_regular_starts_at_ms,
               target.regular_season_ends_at_ms AS target_regular_ends_at_ms,
               target.fantasy_playoffs_start_at_ms AS target_playoffs_starts_at_ms,
               target.fantasy_playoffs_end_at_ms AS target_playoffs_ends_at_ms,
               target.free_agent_draft_completed_at_ms AS target_fad_completed_at_ms,
               binding.target_schedule_version,
               binding.week_one_matchup_week_id,
               binding.week_one_starts_at_ms,
               binding.selection_gate_status,
               binding.trading_gate_status,
               binding.scheduled_by_user_id,
               binding.scheduled_by_membership_id,
               binding.scheduled_by_authority,
               draft.status AS draft_status,
               draft.version AS draft_version,
               draft.starts_at_ms,
               draft.pick_clock_seconds
             FROM entry_draft_rollover_bindings AS binding
             JOIN season_rollover_occurrences AS occurrence
               ON occurrence.league_id = binding.league_id
              AND occurrence.binding_id = binding.id
              AND occurrence.id =
                  binding.current_rollover_occurrence_id
              AND occurrence.schedule_operation_id =
                  binding.current_schedule_operation_id
             JOIN leagues AS league
               ON league.id = binding.league_id
             JOIN seasons AS source
               ON source.league_id = binding.league_id
              AND source.id = binding.from_season_id
             JOIN seasons AS target
               ON target.league_id = binding.league_id
              AND target.id = binding.to_season_id
             JOIN entry_drafts AS draft
               ON draft.league_id = binding.league_id
              AND draft.id = binding.entry_draft_id
             WHERE binding.league_id = @leagueId
               AND binding.id = @bindingId
               AND binding.entry_draft_id =
                   @entryDraftId
               AND binding.current_rollover_occurrence_id =
                   @rolloverOccurrenceId
               AND binding.from_season_id =
                   @fromSeasonId
               AND binding.to_season_id =
                   @toSeasonId
               AND binding.target_schedule_id =
                   @targetScheduleId
               AND binding.status IN ('scheduled', 'blocked')
               AND occurrence.status IN ('scheduled', 'blocked')
             LIMIT 2`
          ).all(params),
          "Rollover context",
          "entry_draft_rollover_bindings"
        );
        if (!row) return null;
        const firstPick = requireUnique(
          statement(
            "rollover-first-pick",
            `SELECT *
             FROM draft_picks
             WHERE league_id = @leagueId
               AND draft_id = @entryDraftId
               AND target_season_id = @toSeasonId
               AND status = 'unused'
               AND NOT EXISTS (
                 SELECT 1
                 FROM draft_picks AS earlier
                 WHERE earlier.league_id = @leagueId
                   AND earlier.draft_id = @entryDraftId
                   AND earlier.target_season_id =
                       @toSeasonId
                   AND earlier.status = 'unused'
                   AND (
                     earlier.round_number <
                       draft_picks.round_number
                     OR (
                       earlier.round_number =
                         draft_picks.round_number
                       AND earlier.position_number <
                         draft_picks.position_number
                     )
                   )
               )
             LIMIT 2`
          ).all(params),
          "First unused Entry Draft pick",
          "draft_picks"
        );
        if (!firstPick) return null;
        const sourceReadiness =
          buildSourceReadiness({
            leagueId: params.leagueId,
            seasonId: params.fromSeasonId,
            observedAtMs: params.observedAtMs,
          });
        if (!sourceReadiness) return null;
        const sourceRolloverCount =
          statement(
            "source-rollover-count",
            `SELECT COUNT(*) AS count
             FROM season_rollovers
             WHERE league_id = @leagueId
               AND from_season_id = @fromSeasonId`
          ).get(params).count;
        const targetRolloverCount =
          statement(
            "target-rollover-count",
            `SELECT COUNT(*) AS count
             FROM season_rollovers
             WHERE league_id = @leagueId
               AND to_season_id = @toSeasonId`
          ).get(params).count;
        const targetIdentities =
          statement(
            "target-identity-count",
            `SELECT
               SUM(CASE
                 WHEN id = @toSeasonId THEN 1 ELSE 0
               END) AS identity_count,
               COUNT(DISTINCT id) AS distinct_count
             FROM seasons
             WHERE league_id = @leagueId
               AND (
                 nhl_season_key =
                   (SELECT nhl_season_key
                    FROM seasons
                    WHERE league_id = @leagueId
                      AND id = @toSeasonId)
                 OR label =
                   (SELECT label
                    FROM seasons
                    WHERE league_id = @leagueId
                      AND id = @toSeasonId)
               )`
          ).get(params);
        const scheduleReady =
          statement(
            "target-schedule-ready",
            `SELECT COUNT(*) AS count
             FROM season_matchup_schedule_generations
             WHERE league_id = @leagueId
               AND season_id = @toSeasonId
               AND schedule_operation_id =
                   @targetScheduleId
               AND schedule_version =
                   @targetScheduleVersion
               AND week_one_matchup_week_id =
                   @weekOneMatchupWeekId
               AND week_one_starts_at_ms =
                   @weekOneStartsAtMs
               AND status = 'current'`
          ).get({
            ...params,
            targetScheduleVersion:
              row.target_schedule_version,
            weekOneMatchupWeekId:
              row.week_one_matchup_week_id,
            weekOneStartsAtMs:
              row.week_one_starts_at_ms,
          }).count;
        const aggregate = {
          leagueId: row.league_id,
          leagueStatus: row.league_status,
          leagueTimeZone: row.league_timezone,
          leagueVersion: row.league_version,
          currentSeasonId: row.current_season_id,
          sourceSeasonId: params.fromSeasonId,
          sourceSeasonStatus: row.source_status,
          sourceSeasonVersion: row.source_version,
          sourceSeasonLabel: row.source_label,
          sourceNhlSeasonKey:
            row.source_nhl_season_key,
          sourceNhlRegularSeasonStartsAtMs:
            row.source_regular_starts_at_ms,
          sourceNhlRegularSeasonEndsAtMs:
            row.source_regular_ends_at_ms,
          sourceFantasyPlayoffsStartAtMs:
            row.source_playoffs_starts_at_ms,
          sourceFantasyPlayoffsEndAtMs:
            row.source_playoffs_ends_at_ms,
          sourceFreeAgentDraftCompletedAtMs:
            row.source_fad_completed_at_ms,
          sourceRolloverCount,
          targetRolloverCount,
          targetIdentityCount:
            targetIdentities.identity_count ?? 0,
          targetIdentityConflict:
            (targetIdentities.distinct_count ?? 0) !==
            1,
          targetSeason: {
            id: row.target_id,
            leagueId: row.league_id,
            label: row.target_label,
            nhlSeasonKey:
              row.target_nhl_season_key,
            status: row.target_status,
            version: row.target_version,
            nhlRegularSeasonStartsAtMs:
              row.target_regular_starts_at_ms,
            nhlRegularSeasonEndsAtMs:
              row.target_regular_ends_at_ms,
            fantasyPlayoffsStartAtMs:
              row.target_playoffs_starts_at_ms,
            fantasyPlayoffsEndAtMs:
              row.target_playoffs_ends_at_ms,
            freeAgentDraftCompletedAtMs:
              row.target_fad_completed_at_ms,
            targetScheduleId:
              params.targetScheduleId,
            targetScheduleVersion:
              row.target_schedule_version,
            weekOneMatchupWeekId:
              row.week_one_matchup_week_id,
            weekOneStartsAtMs:
              row.week_one_starts_at_ms,
            scheduleReady: scheduleReady === 1,
            disallowedStateCount:
              targetDisallowedStateCount({
                leagueId: params.leagueId,
                targetSeasonId:
                  params.toSeasonId,
                entryDraftId:
                  params.entryDraftId,
                bindingId: params.bindingId,
                rolloverOccurrenceId:
                  params.rolloverOccurrenceId,
              }),
          },
        };
        const entryDraft = {
          id: params.entryDraftId,
          leagueId: params.leagueId,
          targetSeasonId: params.toSeasonId,
          status: row.draft_status,
          version: row.draft_version,
          startsAtMs: row.starts_at_ms,
          pickClockSeconds:
            row.pick_clock_seconds,
          selectionGateStatus:
            row.selection_gate_status,
          tradingGateStatus:
            row.trading_gate_status,
          scheduleAuthorizingUserId:
            row.scheduled_by_user_id,
          scheduleAuthorizingMembershipId:
            row.scheduled_by_membership_id,
          scheduleAuthorizingAuthority:
            row.scheduled_by_authority,
          targetScheduleId:
            params.targetScheduleId,
          targetScheduleVersion:
            row.target_schedule_version,
          weekOneMatchupWeekId:
            row.week_one_matchup_week_id,
          weekOneStartsAtMs:
            row.week_one_starts_at_ms,
          firstUnusedPick: {
            id: firstPick.id,
            owningTeamId:
              firstPick.current_owner_team_id,
            roundNumber: firstPick.round_number,
            positionNumber:
              firstPick.position_number,
            version: firstPick.version,
            status: firstPick.status,
          },
        };
        return deepFreeze({
          aggregate,
          sourceReadiness,
          matrix: buildRolloverMatrix({
            leagueId: params.leagueId,
            sourceSeasonId:
              params.fromSeasonId,
            targetSeasonId:
              params.toSeasonId,
          }),
          entryDraft,
        });
      }
    );
  }

  function projectMigrationReport(row) {
    let sourceHashes;
    let counts;
    let totals;
    let warnings;
    let rejects;
    let shapeValid = true;
    try {
      sourceHashes = JSON.parse(
        row.source_hashes_json
      );
      counts = JSON.parse(row.counts_json);
      totals = JSON.parse(row.totals_json);
      warnings = JSON.parse(row.warnings_json);
      rejects = JSON.parse(row.rejects_json);
      shapeValid =
        isPlainObject(sourceHashes) &&
        isPlainObject(counts) &&
        isPlainObject(totals) &&
        Array.isArray(warnings) &&
        Array.isArray(rejects) &&
        rejects.length === 0;
    } catch {
      shapeValid = false;
      sourceHashes = null;
      counts = null;
      totals = null;
      warnings = null;
      rejects = null;
    }
    const hashProjection = {
      domain:
        "hundo-leago.initial-season2-reset-report",
      schemaVersion: 1,
      id: row.id,
      leagueId: row.league_id,
      sourceBundleId: row.source_bundle_id,
      resetManifestId: row.reset_manifest_id,
      databaseSchemaVersion:
        row.database_schema_version,
      status: row.status,
      sourceHashes,
      counts,
      totals,
      warnings,
      rejects,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      createdAtMs: row.created_at_ms,
    };
    return {
      id: row.id,
      leagueId: row.league_id,
      sourceBundleId: row.source_bundle_id,
      resetManifestId: row.reset_manifest_id,
      databaseSchemaVersion:
        row.database_schema_version,
      status: row.status,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      createdAtMs: row.created_at_ms,
      projectionSha256:
        hashCanonicalJsonV1(hashProjection),
      shapeValid,
      hashProjection,
    };
  }

  function bootstrapProjection({
    league,
    season,
    idempotency,
    activity,
    audit,
  }) {
    const metadata = parseJson(
      activity.metadata_json,
      "bootstrap activity metadata"
    );
    const clientMetadata =
      audit.client_metadata_json === null
        ? null
        : parseJson(
            audit.client_metadata_json,
            "bootstrap audit client metadata"
          );
    return {
      domain:
        "hundo-leago.initial-season2-bootstrap-identity",
      schemaVersion: 1,
      bootstrapActorUserId:
        idempotency.actor_user_id,
      createdAtMs: league.created_at_ms,
      league: {
        id: league.id,
        currentSeasonId:
          league.current_season_id,
        createdAtMs: league.created_at_ms,
      },
      season: {
        id: season.id,
        leagueId: season.league_id,
        label: season.label,
        nhlSeasonKey: season.nhl_season_key,
        createdAtMs: season.created_at_ms,
      },
      idempotency: {
        id: idempotency.id,
        leagueId: idempotency.league_id,
        actorUserId:
          idempotency.actor_user_id,
        operation: idempotency.operation,
        clientKey: idempotency.client_key,
        requestHash: idempotency.request_hash,
        status: idempotency.status,
        resultType: idempotency.result_type,
        resultId: idempotency.result_id,
        createdAtMs:
          idempotency.created_at_ms,
        completedAtMs:
          idempotency.completed_at_ms,
        expiresAtMs:
          idempotency.expires_at_ms,
      },
      activity: {
        id: activity.id,
        leagueId: activity.league_id,
        seasonId: activity.season_id,
        eventType: activity.event_type,
        actorUserId: activity.actor_user_id,
        actorAuthority:
          activity.actor_authority,
        teamId: activity.team_id,
        playerId: activity.player_id,
        relatedType: activity.related_type,
        relatedId: activity.related_id,
        displaySummary:
          activity.display_summary,
        reason: activity.reason,
        metadata,
        occurredAtMs:
          activity.occurred_at_ms,
      },
      securityAudit: {
        id: audit.id,
        eventType: audit.event_type,
        outcome: audit.outcome,
        actorUserId: audit.actor_user_id,
        targetUserId: audit.target_user_id,
        leagueId: audit.league_id,
        sessionId: audit.session_id,
        requestCorrelationId:
          audit.request_correlation_id,
        reasonCode: audit.reason_code,
        networkKeyVersion:
          audit.network_key_version,
        networkMetadataDigest:
          audit.network_metadata_digest,
        clientMetadata,
        unknownAccountDigest:
          audit.unknown_account_digest,
        occurredAtMs: audit.occurred_at_ms,
      },
    };
  }

  function loadBootstrapEvidence({
    leagueId,
    seasonId,
    idempotencyRequestId = null,
  }) {
    const params = {
      leagueId,
      seasonId,
      idempotencyRequestId,
      operation: RESET_BOOTSTRAP_OPERATION,
    };
    const league = requireUnique(
      statement(
        "exemption-bootstrap-league",
        `SELECT *
         FROM leagues
         WHERE id = @leagueId
           AND current_season_id = @seasonId
         LIMIT 2`
      ).all(params),
      "Reset bootstrap league",
      "leagues"
    );
    const season = requireUnique(
      statement(
        "exemption-bootstrap-season",
        `SELECT *
         FROM seasons
         WHERE league_id = @leagueId
           AND id = @seasonId
         LIMIT 2`
      ).all(params),
      "Reset bootstrap season",
      "seasons"
    );
    const idempotencies = statement(
      "exemption-bootstrap-idempotency",
      `SELECT *
       FROM idempotency_requests
       WHERE league_id = @leagueId
         AND operation = @operation
         AND status = 'completed'
         AND result_type = 'league'
         AND result_id = @leagueId
         AND (
           @idempotencyRequestId IS NULL
           OR id = @idempotencyRequestId
         )
       ORDER BY id
       LIMIT 2`
    ).all(params);
    const idempotency = requireUnique(
      idempotencies,
      "Reset bootstrap idempotency",
      "idempotency_requests"
    );
    if (!league || !season || !idempotency) {
      return null;
    }
    const activities = statement(
      "exemption-bootstrap-activity",
      `SELECT *
       FROM league_activity
       WHERE league_id = @leagueId
         AND season_id = @seasonId
         AND event_type = 'league_created'
         AND actor_user_id = @actorUserId
         AND related_type = 'league'
         AND related_id = @leagueId
         AND occurred_at_ms = @createdAtMs
       ORDER BY id
       LIMIT 2`
    ).all({
      ...params,
      actorUserId: idempotency.actor_user_id,
      createdAtMs: idempotency.created_at_ms,
    });
    const audits = statement(
      "exemption-bootstrap-audit",
      `SELECT *
       FROM security_audit_events
       WHERE league_id = @leagueId
         AND event_type =
             'system_bootstrap.reset_original_league_created'
         AND outcome = 'success'
         AND actor_user_id = @actorUserId
         AND reason_code =
             'closed_write_reset_handoff'
         AND occurred_at_ms = @createdAtMs
       ORDER BY id
       LIMIT 2`
    ).all({
      ...params,
      actorUserId: idempotency.actor_user_id,
      createdAtMs: idempotency.created_at_ms,
    });
    const activity = requireUnique(
      activities,
      "Reset bootstrap activity",
      "league_activity"
    );
    const audit = requireUnique(
      audits,
      "Reset bootstrap Security Audit",
      "security_audit_events"
    );
    if (!activity || !audit) return null;
    const projection = bootstrapProjection({
      league,
      season,
      idempotency,
      activity,
      audit,
    });
    const createdAtMs = league.created_at_ms;
    const valid =
      season.created_at_ms === createdAtMs &&
      idempotency.created_at_ms === createdAtMs &&
      idempotency.completed_at_ms === createdAtMs &&
      activity.occurred_at_ms === createdAtMs &&
      audit.occurred_at_ms === createdAtMs &&
      season.label === "2026" &&
      season.nhl_season_key === "20262027" &&
      idempotency.actor_user_id ===
        activity.actor_user_id &&
      idempotency.actor_user_id ===
        audit.actor_user_id &&
      activity.actor_authority ===
        "platform_administrator";
    return {
      valid,
      projection,
      projectionSha256:
        hashCanonicalJsonV1(projection),
      idempotencyRequestId: idempotency.id,
      activityId: activity.id,
      securityAuditEventId: audit.id,
      actorUserId: idempotency.actor_user_id,
    };
  }

  function readInitialSeason2ExemptionContext(
    query = {}
  ) {
    exactObject(
      query,
      ["leagueId", "seasonId", "observedAtMs"],
      "An exact Season 2 exemption-context query is required."
    );
    const params = {
      leagueId: stableId(query.leagueId, "league ID"),
      seasonId: stableId(
        query.seasonId,
        "season ID"
      ),
      observedAtMs: safeTimestamp(
        query.observedAtMs,
        "Season 2 exemption observation timestamp"
      ),
    };
    return mapped(
      "readInitialSeason2ExemptionContext",
      "free_agent_draft_setup_exemptions",
      () => {
        const aggregate = requireUnique(
          statement(
            "exemption-aggregate",
            `SELECT
               league.id AS league_id,
               league.status AS league_status,
               league.current_season_id,
               season.id AS season_id,
               season.status AS season_status,
               season.label AS season_label,
               season.nhl_season_key,
               league.commissioner_membership_id,
               membership.user_id AS commissioner_user_id,
               membership.permission_category AS commissioner_permission_category,
               membership.status AS commissioner_membership_status,
               membership.joined_at_ms AS commissioner_joined_at_ms,
               membership.ended_at_ms AS commissioner_ended_at_ms,
               user.status AS commissioner_user_status,
               (SELECT COUNT(*) FROM seasons
                WHERE league_id = @leagueId) AS season_count,
               (SELECT COUNT(*) FROM entry_drafts
                WHERE league_id = @leagueId
                  AND season_id = @seasonId) AS entry_draft_count,
               (SELECT COUNT(*) FROM free_agent_drafts
                WHERE league_id = @leagueId
                  AND season_id = @seasonId) AS fad_count,
               (SELECT COUNT(*) FROM free_agent_draft_setup_exemptions
                WHERE league_id = @leagueId
                  AND season_id = @seasonId) AS exemption_count,
               (SELECT COUNT(*) FROM free_agent_draft_readiness_operations
                WHERE league_id = @leagueId
                  AND season_id = @seasonId) AS fad_setup_count,
               (SELECT COUNT(*) FROM matchup_weeks
                WHERE league_id = @leagueId
                  AND season_id = @seasonId
                  AND sequence = 1) AS week_one_count,
               (SELECT MIN(starts_at_ms) FROM matchup_weeks
                WHERE league_id = @leagueId
                  AND season_id = @seasonId
                  AND sequence = 1) AS week_one_starts_at_ms,
               (SELECT COUNT(*)
                FROM league_memberships AS current_membership
                JOIN users AS current_user
                  ON current_user.id = current_membership.user_id
                WHERE current_membership.league_id = @leagueId
                  AND current_membership.id =
                      league.commissioner_membership_id
                  AND current_membership.permission_category =
                      'commissioner'
                  AND current_membership.status = 'active'
                  AND current_membership.joined_at_ms <=
                      @observedAtMs
                  AND current_membership.ended_at_ms IS NULL
                  AND current_user.status = 'active') AS commissioner_membership_count
             FROM leagues AS league
             JOIN seasons AS season
               ON season.league_id = league.id
              AND season.id = @seasonId
             LEFT JOIN league_memberships AS membership
               ON membership.league_id = league.id
              AND membership.id =
                  league.commissioner_membership_id
             LEFT JOIN users AS user
               ON user.id = membership.user_id
             WHERE league.id = @leagueId
             LIMIT 2`
          ).all(params),
          "Season 2 exemption aggregate",
          "leagues"
        );
        if (!aggregate) return null;
        const reportRows = statement(
          "exemption-migration-reports",
          `SELECT *
           FROM migration_reports
           WHERE league_id = @leagueId
           ORDER BY created_at_ms, id`
        ).all(params);
        const bootstrap =
          loadBootstrapEvidence(params);
        const placeholder =
          "00000000-0000-4000-8000-000000000000";
        return deepFreeze({
          aggregate: {
            leagueId: aggregate.league_id,
            leagueStatus:
              aggregate.league_status,
            currentSeasonId:
              aggregate.current_season_id,
            seasonCount: aggregate.season_count,
            seasonId: aggregate.season_id,
            seasonStatus:
              aggregate.season_status,
            seasonLabel: aggregate.season_label,
            nhlSeasonKey:
              aggregate.nhl_season_key,
            entryDraftCount:
              aggregate.entry_draft_count,
            fadCount: aggregate.fad_count,
            exemptionCount:
              aggregate.exemption_count,
            fadSetupCount:
              aggregate.fad_setup_count,
            weekOneCount:
              aggregate.week_one_count,
            weekOneStartsAtMs:
              aggregate.week_one_starts_at_ms,
            commissionerMembershipCount:
              aggregate.commissioner_membership_count,
            commissionerMembershipId:
              aggregate.commissioner_membership_id,
            commissionerUserId:
              aggregate.commissioner_user_id,
            commissionerPermissionCategory:
              aggregate.commissioner_permission_category,
            commissionerMembershipStatus:
              aggregate.commissioner_membership_status,
            commissionerJoinedAtMs:
              aggregate.commissioner_joined_at_ms,
            commissionerEndedAtMs:
              aggregate.commissioner_ended_at_ms,
            commissionerUserStatus:
              aggregate.commissioner_user_status,
            commissionerNotificationEligible:
              aggregate.commissioner_user_status ===
              "active",
          },
          migrationReports: reportRows.map(
            (row) => {
              const {
                hashProjection: _projection,
                ...result
              } = projectMigrationReport(row);
              return result;
            }
          ),
          bootstrap: bootstrap
            ? {
                valid: bootstrap.valid,
                projectionSha256:
                  bootstrap.projectionSha256,
                idempotencyRequestId:
                  bootstrap.idempotencyRequestId,
                activityId:
                  bootstrap.activityId,
                securityAuditEventId:
                  bootstrap.securityAuditEventId,
                actorUserId:
                  bootstrap.actorUserId,
              }
            : {
                valid: false,
                projectionSha256: "0".repeat(64),
                idempotencyRequestId:
                  placeholder,
                activityId: placeholder,
                securityAuditEventId:
                  placeholder,
                actorUserId: placeholder,
              },
        });
      }
    );
  }

  function verifyInitialSeason2Evidence(
    command = {}
  ) {
    exactObject(
      command,
      [
        "leagueId",
        "seasonId",
        "migrationReportId",
        "bootstrapIdempotencyRequestId",
      ],
      "An exact Season 2 evidence verification is required."
    );
    const params = {
      leagueId: stableId(command.leagueId, "league ID"),
      seasonId: stableId(
        command.seasonId,
        "season ID"
      ),
      migrationReportId: stableId(
        command.migrationReportId,
        "migration-report ID"
      ),
      bootstrapIdempotencyRequestId: stableId(
        command.bootstrapIdempotencyRequestId,
        "bootstrap idempotency-request ID"
      ),
    };
    return mapped(
      "verifyInitialSeason2Evidence",
      "migration_reports",
      () => {
        const report = requireUnique(
          statement(
            "verify-exemption-report",
            `SELECT *
             FROM migration_reports
             WHERE league_id = @leagueId
               AND id = @migrationReportId
             LIMIT 2`
          ).all(params),
          "Reset migration report",
          "migration_reports"
        );
        const bootstrap = loadBootstrapEvidence({
          leagueId: params.leagueId,
          seasonId: params.seasonId,
          idempotencyRequestId:
            params.bootstrapIdempotencyRequestId,
        });
        if (
          !report ||
          !bootstrap ||
          !bootstrap.valid
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The reset evidence is no longer eligible."
          );
        }
        const projected = projectMigrationReport(
          report
        );
        if (
          !projected.shapeValid ||
          report.status !== "succeeded" ||
          report.reset_manifest_id !==
            RESET_MANIFEST_ID
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The reset migration report is not eligible."
          );
        }
        return deepFreeze({
          migrationReportSha256:
            projected.projectionSha256,
          bootstrapIdentitySha256:
            bootstrap.projectionSha256,
        });
      }
    );
  }

  function insertStartedIdempotencyRequest(
    command = {}
  ) {
    exactObject(
      command,
      [
        "id",
        "leagueId",
        "actorUserId",
        "operation",
        "clientKey",
        "requestHash",
        "createdAtMs",
        "expiresAtMs",
      ],
      "An exact started idempotency command is required."
    );
    const record = {
      id: stableId(
        command.id,
        "idempotency-request ID"
      ),
      leagueId: stableId(command.leagueId, "league ID"),
      actorUserId: stableId(
        command.actorUserId,
        "idempotency actor-user ID"
      ),
      operation: boundedText(
        command.operation,
        100,
        "idempotency operation"
      ),
      clientKey: boundedText(
        command.clientKey,
        200,
        "idempotency client key"
      ),
      requestHash: digest(
        command.requestHash,
        "request hash"
      ),
      createdAtMs: safeTimestamp(
        command.createdAtMs,
        "idempotency creation timestamp"
      ),
      expiresAtMs: safeTimestamp(
        command.expiresAtMs,
        "idempotency expiry timestamp"
      ),
    };
    if (
      record.operation !== LIFECYCLE_OPERATION ||
      record.expiresAtMs <= record.createdAtMs
    ) {
      invalid(
        "Canonical lifecycle idempotency evidence is required."
      );
    }
    return mapped(
      "insertStartedLifecycleIdempotencyRequest",
      "idempotency_requests",
      () => {
        statement(
          "insert-lifecycle-idempotency",
          `INSERT INTO idempotency_requests (
             id, league_id, actor_user_id,
             operation, client_key, request_hash,
             status, result_type, result_id,
             created_at_ms, completed_at_ms,
             expires_at_ms
           ) VALUES (
             @id, @leagueId, @actorUserId,
             @operation, @clientKey, @requestHash,
             'started', NULL, NULL,
             @createdAtMs, NULL, @expiresAtMs
           )`
        ).run(record);
      }
    );
  }

  function insertActivity(activity) {
    statement(
      "insert-lifecycle-activity",
      `INSERT INTO league_activity (
         id, league_id, season_id, event_type,
         actor_user_id, actor_authority,
         team_id, player_id, related_type,
         related_id, display_summary, reason,
         metadata_json, occurred_at_ms
       ) VALUES (
         @id, @league_id, @season_id, @event_type,
         @actor_user_id, @actor_authority,
         @team_id, @player_id, @related_type,
         @related_id, @display_summary, @reason,
         @metadata_json, @occurred_at_ms
       )`
    ).run(activityRecord(activity));
  }

  function insertAudit(audit) {
    statement(
      "insert-lifecycle-audit",
      `INSERT INTO security_audit_events (
         id, event_type, outcome, actor_user_id,
         target_user_id, league_id, session_id,
         request_correlation_id, reason_code,
         network_key_version,
         network_metadata_digest,
         client_metadata_json,
         unknown_account_digest, occurred_at_ms
       ) VALUES (
         @id, @event_type, @outcome, @actor_user_id,
         @target_user_id, @league_id, @session_id,
         @request_correlation_id, @reason_code,
         @network_key_version,
         @network_metadata_digest,
         @client_metadata_json,
         @unknown_account_digest, @occurred_at_ms
       )`
    ).run(auditRecord(audit));
  }

  function writeOutbox(outbox, version) {
    const committedVersion =
      version === undefined
        ? outbox.version ?? requireUnique(
            statement(
              "read-lifecycle-outbox-league-version",
              `SELECT version
               FROM leagues
               WHERE id = @leagueId
               LIMIT 2`
            ).all({ leagueId: outbox.leagueId }),
            "The lifecycle outbox league",
            "leagues"
          )?.version
        : version;
    const isLeagueChange =
      outbox.eventType === "league.changed" &&
      outbox.aggregateType === "league" &&
      outbox.aggregateId === outbox.leagueId &&
      outbox.scope === "league";
    const isActivityPublication =
      outbox.eventType === "activity.created" &&
      outbox.aggregateType === "activity" &&
      outbox.scope === "league" &&
      outbox.version === 1 &&
      outbox.reasonCode ===
        "setup_exemption_authorized";
    const isNotificationPublication =
      outbox.eventType === "notification.created" &&
      outbox.aggregateType === "notification" &&
      outbox.scope === "user" &&
      outbox.version === 1 &&
      outbox.reasonCode ===
        "setup_exemption_authorized" &&
      UUID_PATTERN.test(outbox.userId || "");
    if (
      !isLeagueChange &&
      !isActivityPublication &&
      !isNotificationPublication
    ) {
      invalid("A supported lifecycle outbox is required.");
    }
    const payload = createSocketEventMetadata({
      eventType: outbox.eventType,
      version: positiveInteger(
        committedVersion,
        "lifecycle outbox resource version"
      ),
      reasonCode:
        outbox.reasonCode ?? "league_changed",
      occurredAtMs: outbox.changedAtMs,
      related: createEmptySocketRelated(),
    });
    const result = outboxWriter().write({
      id: outbox.id,
      leagueId: outbox.leagueId,
      eventType: outbox.eventType,
      aggregateType: outbox.aggregateType,
      aggregateId: outbox.aggregateId,
      payload,
      occurredAtMs: outbox.changedAtMs,
      audiences: isNotificationPublication
        ? [{ kind: "user", userId: outbox.userId }]
        : [{ kind: "league" }],
    });
    if (result && typeof result.then === "function") {
      invalid("Lifecycle outbox writes must be synchronous.");
    }
    return result;
  }

  function setupEvidenceInvalid(message) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      message
    );
  }

  function requireSetupExemptionOutboxEvidence({
    root,
    expectedOutboxId,
    eventType,
    aggregateType,
    aggregateId,
    reasonCode,
    version,
    audienceKind,
    audienceUserId,
  }) {
    const event = requireUnique(
      statement(
        `setup-exemption-${eventType}-outbox`,
        `SELECT *
         FROM outbox_events
         WHERE league_id = @leagueId
           AND event_type = @eventType
           AND aggregate_type = @aggregateType
           AND aggregate_id = @aggregateId
           AND created_at_ms = @authorizedAtMs
         LIMIT 2`
      ).all({
        leagueId: root.league_id,
        eventType,
        aggregateType,
        aggregateId,
        authorizedAtMs: root.authorized_at_ms,
      }),
      `setup-exemption ${eventType} outbox event`,
      "outbox_events"
    );
    if (!event) {
      setupEvidenceInvalid(
        "Stored setup-exemption publication evidence is incomplete."
      );
    }
    const outboxId = event.id;
    let payload;
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      setupEvidenceInvalid(
        "Stored setup-exemption publication metadata is invalid."
      );
    }
    const authoritativeVersion =
      version ?? payload?.version;
    let expectedPayload;
    try {
      expectedPayload = createSocketEventEnvelope({
        eventId: outboxId,
        type: eventType,
        leagueId: root.league_id,
        resourceId: aggregateId,
        version: authoritativeVersion,
        reasonCode,
        occurredAt: root.authorized_at_ms,
        related: createEmptySocketRelated(),
      });
    } catch {
      setupEvidenceInvalid(
        "Stored setup-exemption publication metadata is invalid."
      );
    }
    const audiences = statement(
      `setup-exemption-${eventType}-audiences`,
      `SELECT audience_kind, team_id, user_id, created_at_ms
       FROM outbox_event_audiences
       WHERE league_id = @leagueId
         AND outbox_event_id = @outboxId
       ORDER BY id`
    ).all({
      leagueId: root.league_id,
      outboxId,
    });
    const audience = audiences[0];
    if (
      event.id !== outboxId ||
      (expectedOutboxId !== null &&
        event.id !== expectedOutboxId) ||
      event.league_id !== root.league_id ||
      event.event_type !== eventType ||
      event.aggregate_type !== aggregateType ||
      event.aggregate_id !== aggregateId ||
      event.created_at_ms !==
        root.authorized_at_ms ||
      event.available_at_ms !==
        root.authorized_at_ms ||
      JSON.stringify(payload) !==
        JSON.stringify(expectedPayload) ||
      audiences.length !== 1 ||
      audience.audience_kind !== audienceKind ||
      audience.team_id !== null ||
      audience.user_id !== audienceUserId ||
      audience.created_at_ms !==
        root.authorized_at_ms
    ) {
      setupEvidenceInvalid(
        "Stored setup-exemption publication evidence is inconsistent."
      );
    }
    return outboxId;
  }

  function requireSetupExemptionPublicationEvidence(
    root
  ) {
    const activity = requireUnique(
      statement(
        "setup-exemption-activity-evidence",
        `SELECT *
         FROM league_activity
         WHERE league_id = @leagueId
           AND id = @activityId
         LIMIT 2`
      ).all({
        leagueId: root.league_id,
        activityId: root.authorization_activity_id,
      }),
      "setup-exemption Activity evidence",
      "league_activity"
    );
    const audit = requireUnique(
      statement(
        "setup-exemption-audit-evidence",
        `SELECT *
         FROM security_audit_events
         WHERE league_id = @leagueId
           AND id = @auditId
         LIMIT 2`
      ).all({
        leagueId: root.league_id,
        auditId:
          root.authorization_security_audit_event_id,
      }),
      "setup-exemption security-audit evidence",
      "security_audit_events"
    );
    const notification = requireUnique(
      statement(
        "setup-exemption-notification-evidence",
        `SELECT *
         FROM notifications
         WHERE league_id = @leagueId
           AND id = @notificationId
         LIMIT 2`
      ).all({
        leagueId: root.league_id,
        notificationId:
          root.commissioner_notification_id,
      }),
      "setup-exemption notification evidence",
      "notifications"
    );
    if (!activity || !audit || !notification) {
      setupEvidenceInvalid(
        "Stored setup-exemption evidence is incomplete."
      );
    }
    let storedActivityContract;
    let expectedActivityContract;
    let storedNotificationContract;
    let expectedNotificationContract;
    try {
      storedActivityContract =
        createFreeAgentDraftActivityContract({
          eventType: activity.event_type,
          metadata: parseCanonicalJsonV1(
            activity.metadata_json
          ),
        });
      expectedActivityContract =
        createFreeAgentDraftActivityContract({
          eventType:
            "fad_setup_exemption_authorized",
          metadata: {
            exemptionId: root.id,
            seasonId: root.season_id,
            migrationReportId:
              root.migration_report_id,
          },
        });
      const notificationMessage =
        parseCanonicalJsonV1(
          notification.message_data_json
        );
      storedNotificationContract =
        createFreeAgentDraftNotificationContract({
          type: notification.event_type,
          recipientUserId: notification.user_id,
          messageData: notificationMessage,
        });
      expectedNotificationContract =
        createFreeAgentDraftNotificationContract({
          type: "fad_setup_exemption_authorized",
          recipientUserId: notification.user_id,
          messageData: {
            leagueId: root.league_id,
            seasonId: root.season_id,
            exemptionId: root.id,
            destination: {
              kind: "commissioner_fad",
              leagueId: root.league_id,
              seasonId: root.season_id,
            },
          },
        });
    } catch {
      setupEvidenceInvalid(
        "Stored setup-exemption Activity or notification evidence violates its contract."
      );
    }
    if (
      activity.id !== root.authorization_activity_id ||
      activity.league_id !== root.league_id ||
      activity.season_id !== root.season_id ||
      activity.actor_user_id !==
        root.authorized_by_user_id ||
      activity.actor_authority !==
        root.authorized_authority ||
      activity.team_id !== null ||
      activity.player_id !== null ||
      activity.related_type !== "season" ||
      activity.related_id !== root.season_id ||
      activity.display_summary !==
        "Initial Season 2 Free Agent Draft exemption authorized." ||
      activity.reason !== null ||
      activity.occurred_at_ms !==
        root.authorized_at_ms ||
      JSON.stringify(storedActivityContract) !==
        JSON.stringify(expectedActivityContract) ||
      audit.id !==
        root.authorization_security_audit_event_id ||
      audit.event_type !==
        "fad.setup_exemption_authorized" ||
      audit.outcome !== "success" ||
      audit.actor_user_id !==
        root.authorized_by_user_id ||
      audit.target_user_id !== null ||
      audit.league_id !== root.league_id ||
      audit.reason_code !==
        "initial_season2_no_draft_authorized" ||
      audit.occurred_at_ms !==
        root.authorized_at_ms ||
      notification.id !==
        root.commissioner_notification_id ||
      notification.league_id !== root.league_id ||
      notification.related_feature !==
        "free_agent_draft_setup" ||
      notification.related_record_id !== root.id ||
      notification.created_at_ms !==
        root.authorized_at_ms ||
      notification.deduplication_key !==
        storedNotificationContract.deduplicationKey ||
      JSON.stringify(storedNotificationContract) !==
        JSON.stringify(expectedNotificationContract)
    ) {
      setupEvidenceInvalid(
        "Stored setup-exemption Activity, audit, or notification evidence is inconsistent."
      );
    }
    const leagueOutboxId =
      requireSetupExemptionOutboxEvidence({
      root,
      expectedOutboxId: root.outbox_event_id,
      eventType: "league.changed",
      aggregateType: "league",
      aggregateId: root.league_id,
      reasonCode: "league_changed",
      version: null,
      audienceKind: "league",
      audienceUserId: null,
    });
    const activityOutboxId =
      requireSetupExemptionOutboxEvidence({
      root,
      expectedOutboxId: null,
      eventType: "activity.created",
      aggregateType: "activity",
      aggregateId: activity.id,
      reasonCode: "setup_exemption_authorized",
      version: 1,
      audienceKind: "league",
      audienceUserId: null,
    });
    const notificationOutboxId =
      requireSetupExemptionOutboxEvidence({
      root,
      expectedOutboxId: null,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notification.id,
      reasonCode: "setup_exemption_authorized",
      version: 1,
      audienceKind: "user",
      audienceUserId: notification.user_id,
    });
    return Object.freeze({
      activityOutboxId,
      leagueOutboxId,
      notificationOutboxId,
    });
  }

  function appendSetupExemptionEvidence(
    command = {}
  ) {
    exactObject(
      command,
      ["plan"],
      "An exact setup-exemption evidence command is required."
    );
    const { plan } = command;
    if (
      !isPlainObject(plan) ||
      plan.exemptionKind !==
        SETUP_EXEMPTION_KIND ||
      !isPlainObject(plan.activity) ||
      !isPlainObject(plan.securityAudit) ||
      !isPlainObject(plan.notification) ||
      !isPlainObject(plan.outbox) ||
      !isPlainObject(plan.activityOutbox) ||
      !isPlainObject(plan.notificationOutbox)
    ) {
      invalid(
        "A canonical setup-exemption plan is required."
      );
    }
    validateSetupExemptionPublicationPlan(plan);
    stableId(plan.leagueId, "league ID");
    stableId(plan.seasonId, "season ID");
    return mapped(
      "appendSetupExemptionEvidence",
      "free_agent_draft_setup_exemptions",
      () => {
        insertActivity(plan.activity);
        insertAudit(plan.securityAudit);
        const notificationResult = notifications().insert({
          id: plan.notification.id,
          userId: plan.notification.userId,
          leagueId: plan.leagueId,
          eventType: plan.notification.type,
          messageDataJson:
            serializeCanonicalJsonV1(
              plan.notification.messageData
            ),
          relatedFeature:
            plan.notification.relatedFeature,
          relatedRecordId:
            plan.notification.relatedRecordId,
          deliveryStatus:
            plan.notification.status,
          createdAtMs:
            plan.notification.createdAtMs,
          deliveredAtMs: null,
          deduplicationKey:
            plan.notification.deduplicationKey,
        });
        if (
          notificationResult &&
          typeof notificationResult.then === "function"
        ) {
          invalid(
            "Lifecycle notification writes must be synchronous."
          );
        }
        const persistedNotification =
          notificationResult?.notification;
        if (
          notificationResult?.replayed !== false ||
          persistedNotification?.id !==
            plan.notification.id ||
          persistedNotification.user_id !==
            plan.notification.userId ||
          persistedNotification.league_id !==
            plan.leagueId ||
          persistedNotification.event_type !==
            plan.notification.type ||
          persistedNotification.message_data_json !==
            serializeCanonicalJsonV1(
              plan.notification.messageData
            ) ||
          persistedNotification.related_feature !==
            plan.notification.relatedFeature ||
          persistedNotification.related_record_id !==
            plan.notification.relatedRecordId ||
          persistedNotification.delivery_status !==
            plan.notification.status ||
          persistedNotification.created_at_ms !==
            plan.notification.createdAtMs ||
          persistedNotification.read_at_ms !== null ||
          persistedNotification.delivered_at_ms !== null ||
          persistedNotification.version !==
            plan.notification.version ||
          persistedNotification.deduplication_key !==
            plan.notification.deduplicationKey
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The setup-exemption notification evidence is incomplete."
          );
        }
        writeOutbox(plan.outbox);
        writeOutbox(plan.activityOutbox);
        writeOutbox(plan.notificationOutbox);
        hook("appendSetupExemptionEvidence");
      }
    );
  }

  function insertSetupExemption(command = {}) {
    exactObject(
      command,
      ["plan"],
      "An exact setup-exemption insert is required."
    );
    const { plan } = command;
    if (
      !isPlainObject(plan) ||
      plan.exemptionKind !==
        SETUP_EXEMPTION_KIND
    ) {
      invalid(
        "A canonical setup-exemption plan is required."
      );
    }
    const row = {
      id: stableId(
        plan.exemptionId,
        "setup-exemption ID"
      ),
      league_id: stableId(
        plan.leagueId,
        "league ID"
      ),
      season_id: stableId(
        plan.seasonId,
        "season ID"
      ),
      exemption_kind: SETUP_EXEMPTION_KIND,
      migration_report_id: stableId(
        plan.migrationReportId,
        "migration-report ID"
      ),
      reason: boundedText(
        plan.reason,
        500,
        "setup-exemption reason"
      ),
      authorized_by_user_id: stableId(
        plan.authorizedByUserId,
        "authorization user ID"
      ),
      authorized_by_membership_id: stableId(
        plan.authorizedByMembershipId,
        "authorization membership ID"
      ),
      authorized_authority:
        plan.authorizedAuthority,
      authorized_at_ms: safeTimestamp(
        plan.authorizedAtMs,
        "authorization timestamp"
      ),
      consumed_fad_id: null,
      consumed_at_ms: null,
      created_at_ms: plan.authorizedAtMs,
      updated_at_ms: plan.authorizedAtMs,
      version: 1,
      idempotency_request_id: stableId(
        plan.idempotencyRequestId,
        "idempotency-request ID"
      ),
      migration_report_sha256: digest(
        plan.migrationReportSha256,
        "migration-report digest"
      ),
      bootstrap_identity_sha256: digest(
        plan.bootstrapIdentitySha256,
        "bootstrap-identity digest"
      ),
      bootstrap_idempotency_request_id:
        stableId(
          plan.bootstrapIdempotencyRequestId,
          "bootstrap idempotency-request ID"
        ),
      bootstrap_activity_id: stableId(
        plan.bootstrapActivityId,
        "bootstrap activity ID"
      ),
      bootstrap_security_audit_event_id:
        stableId(
          plan.bootstrapSecurityAuditEventId,
          "bootstrap audit ID"
        ),
      bootstrap_actor_user_id: stableId(
        plan.bootstrapActorUserId,
        "bootstrap actor-user ID"
      ),
      authorization_activity_id: stableId(
        plan.activity.id,
        "authorization activity ID"
      ),
      authorization_security_audit_event_id:
        stableId(
          plan.securityAudit.id,
          "authorization audit ID"
        ),
      commissioner_notification_id: stableId(
        plan.notification.id,
        "commissioner notification ID"
      ),
      outbox_event_id: stableId(
        plan.outbox.id,
        "outbox-event ID"
      ),
    };
    if (
      row.authorized_authority !==
      "platform_administrator_as_commissioner"
    ) {
      invalid(
        "Platform-administrator-as-commissioner authority is required."
      );
    }
    return mapped(
      "insertSetupExemption",
      "free_agent_draft_setup_exemptions",
      () => {
        statement(
          "insert-setup-exemption",
          `INSERT INTO free_agent_draft_setup_exemptions (
             id, league_id, season_id, exemption_kind,
             migration_report_id, reason,
             authorized_by_user_id,
             authorized_by_membership_id,
             authorized_authority, authorized_at_ms,
             consumed_fad_id, consumed_at_ms,
             created_at_ms, updated_at_ms, version,
             idempotency_request_id,
             migration_report_sha256,
             bootstrap_identity_sha256,
             bootstrap_idempotency_request_id,
             bootstrap_activity_id,
             bootstrap_security_audit_event_id,
             bootstrap_actor_user_id,
             authorization_activity_id,
             authorization_security_audit_event_id,
             commissioner_notification_id,
             outbox_event_id
           ) VALUES (
             @id, @league_id, @season_id,
             @exemption_kind, @migration_report_id,
             @reason, @authorized_by_user_id,
             @authorized_by_membership_id,
             @authorized_authority, @authorized_at_ms,
             @consumed_fad_id, @consumed_at_ms,
             @created_at_ms, @updated_at_ms, @version,
             @idempotency_request_id,
             @migration_report_sha256,
             @bootstrap_identity_sha256,
             @bootstrap_idempotency_request_id,
             @bootstrap_activity_id,
             @bootstrap_security_audit_event_id,
             @bootstrap_actor_user_id,
             @authorization_activity_id,
             @authorization_security_audit_event_id,
             @commissioner_notification_id,
             @outbox_event_id
           )`
        ).run(row);
        hook("insertSetupExemption");
      }
    );
  }

  function verifySetupExemptionEvidence(
    command = {}
  ) {
    exactObject(
      command,
      ["plan"],
      "An exact setup-exemption verification is required."
    );
    const { plan } = command;
    if (!isPlainObject(plan)) {
      invalid(
        "A canonical setup-exemption plan is required."
      );
    }
    const params = {
      leagueId: stableId(plan.leagueId, "league ID"),
      seasonId: stableId(plan.seasonId, "season ID"),
      exemptionId: stableId(
        plan.exemptionId,
        "setup-exemption ID"
      ),
    };
    return mapped(
      "verifySetupExemptionEvidence",
      "free_agent_draft_setup_exemptions",
      () => {
        const row = requireUnique(
          statement(
            "verify-setup-exemption",
            `SELECT *
             FROM free_agent_draft_setup_exemptions
             WHERE league_id = @leagueId
               AND season_id = @seasonId
               AND id = @exemptionId
             LIMIT 2`
          ).all(params),
          "FAD setup exemption",
          "free_agent_draft_setup_exemptions"
        );
        if (!row) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The setup exemption is unavailable."
          );
        }
        const report = requireUnique(
          statement(
            "verify-stored-exemption-report",
            `SELECT *
             FROM migration_reports
             WHERE league_id = @leagueId
               AND id = @migrationReportId
             LIMIT 2`
          ).all({
            ...params,
            migrationReportId:
              row.migration_report_id,
          }),
          "Stored exemption migration report",
          "migration_reports"
        );
        const bootstrap = loadBootstrapEvidence({
          leagueId: params.leagueId,
          seasonId: params.seasonId,
          idempotencyRequestId:
            row.bootstrap_idempotency_request_id,
        });
        if (!report || !bootstrap) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "Stored setup-exemption evidence is incomplete."
          );
        }
        const reportHash =
          projectMigrationReport(
            report
          ).projectionSha256;
        if (
          reportHash !==
            row.migration_report_sha256 ||
          bootstrap.projectionSha256 !==
            row.bootstrap_identity_sha256 ||
          row.bootstrap_activity_id !==
            bootstrap.activityId ||
          row.bootstrap_security_audit_event_id !==
            bootstrap.securityAuditEventId ||
          row.bootstrap_actor_user_id !==
            bootstrap.actorUserId
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "Stored setup-exemption hashes do not match their evidence."
          );
        }
        validateSetupExemptionPublicationPlan(plan);
        if (
          row.authorization_activity_id !==
            plan.activity.id ||
          row.authorization_security_audit_event_id !==
            plan.securityAudit.id ||
          row.commissioner_notification_id !==
            plan.notification.id ||
          row.outbox_event_id !== plan.outbox.id
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "Stored setup-exemption publication links are incomplete."
          );
        }
        const publicationIds =
          requireSetupExemptionPublicationEvidence(row);
        if (
          publicationIds.activityOutboxId !==
            plan.activityOutbox.id ||
          publicationIds.notificationOutboxId !==
            plan.notificationOutbox.id
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "Stored setup-exemption publication IDs are inconsistent."
          );
        }
        return deepFreeze({
          migrationReportSha256: reportHash,
          bootstrapIdentitySha256:
            bootstrap.projectionSha256,
        });
      }
    );
  }

  function completeIdempotencyRequest(
    command = {}
  ) {
    exactObject(
      command,
      [
        "id",
        "leagueId",
        "resultType",
        "resultId",
        "completedAtMs",
      ],
      "An exact idempotency completion is required."
    );
    const params = {
      id: stableId(
        command.id,
        "idempotency-request ID"
      ),
      leagueId: stableId(command.leagueId, "league ID"),
      resultType: boundedText(
        command.resultType,
        100,
        "idempotency result type"
      ),
      resultId: stableId(
        command.resultId,
        "idempotency result ID"
      ),
      completedAtMs: safeTimestamp(
        command.completedAtMs,
        "idempotency completion timestamp"
      ),
    };
    if (
      ![
        "season_rollover",
        "season_rollover_attempt",
        "free_agent_draft_setup_exemption",
      ].includes(params.resultType)
    ) {
      invalid(
        "A supported lifecycle result type is required."
      );
    }
    return mapped(
      "completeLifecycleIdempotencyRequest",
      "idempotency_requests",
      () => {
        requireChanged(
          statement(
            "complete-lifecycle-idempotency",
            `UPDATE idempotency_requests
             SET status = 'completed',
                 result_type = @resultType,
                 result_id = @resultId,
                 completed_at_ms = @completedAtMs
             WHERE league_id = @leagueId
               AND id = @id
               AND operation =
                   'league.lifecycle.transition.v2'
               AND status = 'started'
               AND result_type IS NULL
               AND result_id IS NULL
               AND completed_at_ms IS NULL
               AND created_at_ms <= @completedAtMs`
          ).run(params),
          "The lifecycle idempotency request changed."
        );
        hook("completeIdempotencyRequest");
      }
    );
  }

  function itemProjection(plan, effect) {
    return {
      itemId: effect.itemId,
      leagueId: plan.leagueId,
      rolloverId: plan.rolloverId,
      rolloverAttemptId: plan.attemptId,
      idempotencyRequestId:
        plan.idempotencyRequestId,
      fromSeasonId: plan.source.id,
      toSeasonId: plan.target.id,
      effectKind: effect.effectKind,
      entityType:
        EFFECT_ENTITY_TYPES[effect.effectKind],
      entityId: effect.entityId,
      before: effect.before,
      after: effect.after,
      contractEventId:
        EFFECT_ENTITY_TYPES[effect.effectKind] ===
        "contract"
          ? effect.eventId
          : null,
      ownershipEventId:
        EFFECT_ENTITY_TYPES[effect.effectKind] ===
        "player_ownership"
          ? effect.eventId
          : null,
      tradeEventId:
        EFFECT_ENTITY_TYPES[effect.effectKind] ===
        "trade"
          ? effect.eventId
          : null,
      leagueActivityId:
        effect.leagueActivityId,
      causalAssets: effect.causalAssets ?? [],
      occurredAtMs: plan.completedAtMs,
    };
  }

  function insertRolloverItem(plan, effect) {
    const projection = itemProjection(
      plan,
      effect
    );
    statement(
      "insert-rollover-item",
      `INSERT INTO season_rollover_items (
         id, league_id, rollover_id, binding_id,
         rollover_occurrence_id,
         rollover_attempt_id,
         idempotency_request_id,
         from_season_id, to_season_id,
         effect_kind, entity_type, entity_id,
         before_json, after_json, payload_sha256,
         contract_event_id, ownership_event_id,
         trade_event_id, league_activity_id,
         causal_assets_json, occurred_at_ms,
         created_at_ms, version
       ) VALUES (
         @id, @leagueId, @rolloverId, @bindingId,
         @rolloverOccurrenceId, @attemptId,
         @idempotencyRequestId,
         @fromSeasonId, @toSeasonId,
         @effectKind, @entityType, @entityId,
         @beforeJson, @afterJson, @payloadSha256,
         @contractEventId, @ownershipEventId,
         @tradeEventId, @leagueActivityId,
         @causalAssetsJson, @occurredAtMs,
         @occurredAtMs, 1
       )`
    ).run({
      id: projection.itemId,
      leagueId: projection.leagueId,
      rolloverId: projection.rolloverId,
      bindingId: plan.bindingId,
      rolloverOccurrenceId:
        plan.rolloverOccurrenceId,
      attemptId: projection.rolloverAttemptId,
      idempotencyRequestId:
        projection.idempotencyRequestId,
      fromSeasonId: projection.fromSeasonId,
      toSeasonId: projection.toSeasonId,
      effectKind: projection.effectKind,
      entityType: projection.entityType,
      entityId: projection.entityId,
      beforeJson: serializeCanonicalJsonV1(
        projection.before
      ),
      afterJson: serializeCanonicalJsonV1(
        projection.after
      ),
      payloadSha256:
        hashSeasonRolloverItem(projection),
      contractEventId:
        projection.contractEventId,
      ownershipEventId:
        projection.ownershipEventId,
      tradeEventId: projection.tradeEventId,
      leagueActivityId:
        projection.leagueActivityId,
      causalAssetsJson:
        serializeCanonicalJsonV1(
          projection.causalAssets
        ),
      occurredAtMs: projection.occurredAtMs,
    });
  }

  function applyContractEffect(plan, effect) {
    const sourceYear = effect.before.years.find(
      ({ id }) => id === effect.sourceYearId
    );
    const afterSourceYear =
      effect.after.years.find(
        ({ id }) => id === effect.sourceYearId
      );
    if (!sourceYear || !afterSourceYear) {
      invalid(
        "The contract effect lacks its source year."
      );
    }
    requireChanged(
      statement(
        "rollover-contract-source-year",
        `UPDATE contract_years
         SET status = @status,
             rollover_at_ms = @rolloverAtMs
         WHERE league_id = @leagueId
           AND id = @id
           AND contract_id = @contractId
           AND season_id = @fromSeasonId
           AND status = @priorStatus
           AND rollover_at_ms IS @priorRolloverAtMs`
      ).run({
        leagueId: plan.leagueId,
        id: sourceYear.id,
        contractId: effect.entityId,
        fromSeasonId: plan.source.id,
        status: afterSourceYear.status,
        rolloverAtMs:
          afterSourceYear.rolloverAtMs,
        priorStatus: sourceYear.status,
        priorRolloverAtMs:
          sourceYear.rolloverAtMs,
      }),
      "A source contract year changed."
    );
    if (effect.targetYearId !== null) {
      const targetYear = effect.before.years.find(
        ({ id }) => id === effect.targetYearId
      );
      const afterTargetYear =
        effect.after.years.find(
          ({ id }) => id === effect.targetYearId
        );
      requireChanged(
        statement(
          "rollover-contract-target-year",
          `UPDATE contract_years
           SET status = @status,
               rollover_at_ms = @rolloverAtMs
           WHERE league_id = @leagueId
             AND id = @id
             AND contract_id = @contractId
             AND season_id = @toSeasonId
             AND status = @priorStatus
             AND rollover_at_ms IS @priorRolloverAtMs`
        ).run({
          leagueId: plan.leagueId,
          id: targetYear.id,
          contractId: effect.entityId,
          toSeasonId: plan.target.id,
          status: afterTargetYear.status,
          rolloverAtMs:
            afterTargetYear.rolloverAtMs,
          priorStatus: targetYear.status,
          priorRolloverAtMs:
            targetYear.rolloverAtMs,
        }),
        "A target contract year changed."
      );
    }
    requireChanged(
      statement(
        "rollover-contract-parent",
        `UPDATE contracts
         SET status = @status,
             updated_at_ms = @updatedAtMs,
             version = @versionAfter
         WHERE league_id = @leagueId
           AND id = @contractId
           AND player_id = @playerId
           AND current_team_id = @teamId
           AND status = @statusBefore
           AND version = @versionBefore`
      ).run({
        leagueId: plan.leagueId,
        contractId: effect.entityId,
        playerId: effect.before.playerId,
        teamId: effect.before.currentTeamId,
        status: effect.after.status,
        updatedAtMs: plan.completedAtMs,
        versionAfter: effect.after.version,
        statusBefore: effect.before.status,
        versionBefore: effect.before.version,
      }),
      "A rollover contract changed."
    );
    const metadata = {
      schemaVersion: 1,
      rolloverId: plan.rolloverId,
      rolloverItemId: effect.itemId,
      fromSeasonId: plan.source.id,
      toSeasonId: plan.target.id,
      before: effect.before,
      after: effect.after,
    };
    statement(
      "insert-rollover-contract-event",
      `INSERT INTO contract_events (
         id, league_id, contract_id, player_id,
         team_id, actor_user_id, event_type,
         source_type, source_id, metadata_json,
         reason, occurred_at_ms
       ) VALUES (
         @id, @leagueId, @contractId, @playerId,
         @teamId, NULL, @eventType,
         'season_rollover', @rolloverId,
         @metadataJson, 'season_rollover',
         @occurredAtMs
       )`
    ).run({
      id: effect.eventId,
      leagueId: plan.leagueId,
      contractId: effect.entityId,
      playerId: effect.before.playerId,
      teamId: effect.before.currentTeamId,
      eventType:
        effect.effectKind ===
        "contract_advanced"
          ? "contract_year_advanced"
          : "contract_expired",
      rolloverId: plan.rolloverId,
      metadataJson:
        serializeCanonicalJsonV1(metadata),
      occurredAtMs: plan.completedAtMs,
    });
    if (
      effect.effectKind === "contract_expired"
    ) {
      insertActivity({
        id: effect.leagueActivityId,
        eventType: "contract_expired",
        leagueId: plan.leagueId,
        seasonId: plan.source.id,
        actorUserId: null,
        actorAuthority: "system",
        teamId: effect.before.currentTeamId,
        playerId: effect.before.playerId,
        relatedType: "contract",
        relatedId: effect.entityId,
        displaySummary:
          "Contract expired; player released.",
        reason: null,
        metadata: {
          rolloverId: plan.rolloverId,
          contractId: effect.entityId,
          ownershipId: effect.ownershipId,
          expiredAavCents:
            effect.before.aavCents,
          originalTermYears:
            effect.before.originalTermYears,
          rosterRemoval: "released",
        },
        occurredAtMs: plan.completedAtMs,
      });
    }
    insertRolloverItem(plan, effect);
  }

  function deleteDisplayOrderEntries(
    plan,
    effect
  ) {
    for (const entry of
      effect.before.displayOrderEntries) {
      requireChanged(
        statement(
          "delete-rollover-display-entry",
          `DELETE FROM roster_display_order_entries
           WHERE league_id = @leagueId
             AND id = @id
             AND order_set_id = @orderSetId
             AND ownership_id = @ownershipId
             AND position_group = @positionGroup
             AND display_order = @displayOrder
             AND created_at_ms = @createdAtMs`
        ).run({
          leagueId: plan.leagueId,
          id: entry.id,
          orderSetId: entry.orderSetId,
          ownershipId: effect.entityId,
          positionGroup: entry.positionGroup,
          displayOrder: entry.displayOrder,
          createdAtMs: entry.createdAtMs,
        }),
        "A roster display-order entry changed."
      );
    }
    const remaining = statement(
      "remaining-rollover-display-entry",
      `SELECT COUNT(*) AS count
       FROM roster_display_order_entries
       WHERE league_id = @leagueId
         AND ownership_id = @ownershipId`
    ).get({
      leagueId: plan.leagueId,
      ownershipId: effect.entityId,
    }).count;
    if (remaining !== 0) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The ownership display-order projection changed."
      );
    }
  }

  function applyOwnershipEffect(plan, effect) {
    deleteDisplayOrderEntries(plan, effect);
    const carried =
      effect.effectKind === "ownership_carried";
    if (carried) {
      requireChanged(
        statement(
          "carry-rollover-ownership",
          `UPDATE player_ownerships
           SET season_id = @toSeasonId,
               updated_at_ms = @updatedAtMs,
               version = @versionAfter
           WHERE league_id = @leagueId
             AND id = @ownershipId
             AND season_id = @fromSeasonId
             AND player_id = @playerId
             AND team_id = @teamId
             AND version = @versionBefore`
        ).run({
          leagueId: plan.leagueId,
          ownershipId: effect.entityId,
          fromSeasonId: plan.source.id,
          toSeasonId: plan.target.id,
          playerId: effect.before.playerId,
          teamId: effect.before.teamId,
          updatedAtMs: plan.completedAtMs,
          versionBefore: effect.before.version,
          versionAfter: effect.after.version,
        }),
        "A carried ownership changed."
      );
    }
    statement(
      "insert-rollover-ownership-event",
      `INSERT INTO ownership_events (
         id, league_id, season_id, player_id,
         team_id, ownership_id, event_type,
         actor_user_id, source_type, source_id,
         before_metadata_json, after_metadata_json,
         reason, occurred_at_ms
       ) VALUES (
         @id, @leagueId, @seasonId, @playerId,
         @teamId, @ownershipId, @eventType,
         NULL, 'season_rollover', @rolloverId,
         @beforeJson, @afterJson,
         'season_rollover', @occurredAtMs
       )`
    ).run({
      id: effect.eventId,
      leagueId: plan.leagueId,
      seasonId: carried
        ? plan.target.id
        : plan.source.id,
      playerId: effect.before.playerId,
      teamId: effect.before.teamId,
      ownershipId: effect.entityId,
      eventType: carried
        ? "ownership_carried_to_season"
        : "player_released_by_contract_expiration",
      rolloverId: plan.rolloverId,
      beforeJson: serializeCanonicalJsonV1(
        effect.before
      ),
      afterJson: serializeCanonicalJsonV1(
        effect.after
      ),
      occurredAtMs: plan.completedAtMs,
    });
    insertRolloverItem(plan, effect);
    if (!carried) {
      requireChanged(
        statement(
          "release-rollover-ownership",
          `DELETE FROM player_ownerships
           WHERE league_id = @leagueId
             AND id = @ownershipId
             AND season_id = @fromSeasonId
             AND player_id = @playerId
             AND team_id = @teamId
             AND version = @versionBefore`
        ).run({
          leagueId: plan.leagueId,
          ownershipId: effect.entityId,
          fromSeasonId: plan.source.id,
          playerId: effect.before.playerId,
          teamId: effect.before.teamId,
          versionBefore: effect.before.version,
        }),
        "A released ownership changed."
      );
    }
  }

  function applyObligationEffect(
    plan,
    effect,
    kind
  ) {
    const retention = kind === "retention";
    const tableName = retention
      ? "retention_obligations"
      : "buyout_obligations";
    const yearsTable = retention
      ? "retention_years"
      : "buyout_years";
    const parentColumn = retention
      ? "retention_obligation_id"
      : "buyout_obligation_id";
    const sourceYear = effect.before.years.find(
      ({ id }) => id === effect.sourceYearId
    );
    const afterSourceYear =
      effect.after.years.find(
        ({ id }) => id === effect.sourceYearId
      );
    requireChanged(
      statement(
        `rollover-${kind}-source-year`,
        `UPDATE ${yearsTable}
         SET status = @status
         WHERE league_id = @leagueId
           AND id = @id
           AND ${parentColumn} = @obligationId
           AND season_id = @fromSeasonId
           AND status = @priorStatus`
      ).run({
        leagueId: plan.leagueId,
        id: sourceYear.id,
        obligationId: effect.entityId,
        fromSeasonId: plan.source.id,
        status: afterSourceYear.status,
        priorStatus: sourceYear.status,
      }),
      `A source ${kind} year changed.`
    );
    if (effect.targetYearId !== null) {
      const targetYear = effect.before.years.find(
        ({ id }) => id === effect.targetYearId
      );
      const afterTargetYear =
        effect.after.years.find(
          ({ id }) => id === effect.targetYearId
        );
      requireChanged(
        statement(
          `rollover-${kind}-target-year`,
          `UPDATE ${yearsTable}
           SET status = @status
           WHERE league_id = @leagueId
             AND id = @id
             AND ${parentColumn} = @obligationId
             AND season_id = @toSeasonId
             AND status = @priorStatus`
        ).run({
          leagueId: plan.leagueId,
          id: targetYear.id,
          obligationId: effect.entityId,
          toSeasonId: plan.target.id,
          status: afterTargetYear.status,
          priorStatus: targetYear.status,
        }),
        `A target ${kind} year changed.`
      );
    }
    requireChanged(
      statement(
        `rollover-${kind}-parent`,
        `UPDATE ${tableName}
         SET status = @status,
             updated_at_ms = @updatedAtMs,
             version = @versionAfter
         WHERE league_id = @leagueId
           AND id = @obligationId
           AND status = @statusBefore
           AND version = @versionBefore`
      ).run({
        leagueId: plan.leagueId,
        obligationId: effect.entityId,
        status: effect.after.status,
        statusBefore: effect.before.status,
        updatedAtMs: plan.completedAtMs,
        versionBefore: effect.before.version,
        versionAfter: effect.after.version,
      }),
      `A rollover ${kind} obligation changed.`
    );
    insertRolloverItem(plan, effect);
  }

  function applyTradeEffect(plan, effect) {
    requireChanged(
      statement(
        "cancel-rollover-trade",
        `UPDATE trades
         SET status = 'cancelled',
             responded_at_ms = @completedAtMs,
             updated_at_ms = @completedAtMs,
             version = @versionAfter
         WHERE league_id = @leagueId
           AND id = @tradeId
           AND season_id = @fromSeasonId
           AND status = 'proposed'
           AND responded_at_ms IS NULL
           AND completed_at_ms IS NULL
           AND commissioner_completion_reference IS NULL
           AND version = @versionBefore`
      ).run({
        leagueId: plan.leagueId,
        tradeId: effect.entityId,
        fromSeasonId: plan.source.id,
        completedAtMs: plan.completedAtMs,
        versionBefore: effect.before.version,
        versionAfter: effect.after.version,
      }),
      "A rollover-cancelled trade changed."
    );
    const metadata = {
      schemaVersion: 1,
      rolloverId: plan.rolloverId,
      rolloverItemId: effect.itemId,
      fromSeasonId: plan.source.id,
      toSeasonId: plan.target.id,
      before: effect.before,
      after: effect.after,
      causalAssets: effect.causalAssets,
    };
    statement(
      "insert-rollover-trade-event",
      `INSERT INTO trade_events (
         id, league_id, season_id, trade_id,
         actor_user_id, event_type, reason,
         metadata_json, occurred_at_ms
       ) VALUES (
         @id, @leagueId, @fromSeasonId, @tradeId,
         NULL, 'proposal_auto_cancelled',
         'asset_expired_during_season_rollover',
         @metadataJson, @occurredAtMs
       )`
    ).run({
      id: effect.eventId,
      leagueId: plan.leagueId,
      fromSeasonId: plan.source.id,
      tradeId: effect.entityId,
      metadataJson:
        serializeCanonicalJsonV1(metadata),
      occurredAtMs: plan.completedAtMs,
    });
    insertActivity({
      id: effect.leagueActivityId,
      eventType:
        "trade_proposal_automatically_cancelled",
      leagueId: plan.leagueId,
      seasonId: plan.source.id,
      actorUserId: null,
      actorAuthority: "system",
      teamId: null,
      playerId: null,
      relatedType: "trade",
      relatedId: effect.entityId,
      displaySummary:
        "Trade proposal automatically cancelled.",
      reason: null,
      metadata: {
        rolloverId: plan.rolloverId,
        proposalId: effect.entityId,
        fromStatus: "Pending",
        toStatus: "Automatically Cancelled",
        reasonCode:
          "asset_expired_during_season_rollover",
        causalAssets: effect.causalAssets,
      },
      occurredAtMs: plan.completedAtMs,
    });
    insertRolloverItem(plan, effect);
  }

  function rootRecordFromPlan(
    plan,
    manifestSha256
  ) {
    const source =
      plan.sourceReadiness.projection;
    return {
      id: plan.rolloverId,
      league_id: plan.leagueId,
      binding_id: plan.bindingId,
      rollover_occurrence_id:
        plan.rolloverOccurrenceId,
      rollover_attempt_id: plan.attemptId,
      entry_draft_id: plan.entryDraft.id,
      target_schedule_id:
        plan.targetSchedule.id,
      target_schedule_version:
        plan.targetSchedule.version,
      week_one_matchup_week_id:
        plan.targetSchedule.weekOneMatchupWeekId,
      week_one_starts_at_ms:
        plan.targetSchedule.weekOneStartsAtMs,
      first_pick_clock_id:
        plan.firstPickClock.id,
      entry_draft_scheduled_starts_at_ms:
        plan.scheduledStartsAtMs,
      occurrence_key: plan.occurrenceKey,
      from_season_id: plan.source.id,
      to_season_id: plan.target.id,
      status: "succeeded",
      execution_trigger: plan.triggerKind,
      scheduled_job_run_id:
        plan.scheduledJobRunId,
      idempotency_request_id:
        plan.idempotencyRequestId,
      executed_by_user_id:
        plan.authorizedByUserId,
      executed_by_membership_id:
        plan.authorizedByMembershipId,
      executed_authority:
        plan.authorizedAuthority,
      entry_draft_scheduled_by_user_id:
        plan.scheduleAuthorizedByUserId,
      entry_draft_scheduled_by_membership_id:
        plan.scheduleAuthorizedByMembershipId,
      entry_draft_scheduled_by_authority:
        plan.scheduleAuthorizedAuthority,
      league_version_before:
        plan.leagueVersionBefore,
      league_version_after:
        plan.leagueVersionAfter,
      from_season_version_before:
        plan.source.versionBefore,
      from_season_version_after:
        plan.source.versionAfter,
      to_season_version_before:
        plan.target.versionBefore,
      to_season_version_after:
        plan.target.versionAfter,
      entry_draft_version_before:
        plan.entryDraft.versionBefore,
      entry_draft_version_after:
        plan.entryDraft.versionAfter,
      target_season_reused: 1,
      from_season_label: plan.source.label,
      from_nhl_season_key:
        plan.source.nhlSeasonKey,
      to_season_label: plan.target.label,
      target_nhl_season_key:
        plan.target.nhlSeasonKey,
      nhl_regular_season_starts_at_ms:
        plan.target.nhlRegularSeasonStartsAtMs,
      nhl_regular_season_ends_at_ms:
        plan.target.nhlRegularSeasonEndsAtMs,
      fantasy_playoffs_start_at_ms:
        plan.target.fantasyPlayoffsStartAtMs,
      fantasy_playoffs_end_at_ms:
        plan.target.fantasyPlayoffsEndAtMs,
      source_fad_id: source.sourceFadId,
      source_finalization_root_id:
        source.sourceFinalizationRootId,
      source_finalization_id:
        source.sourceFinalizationId,
      source_standings_snapshot_id:
        source.sourceStandingsSnapshotId,
      source_standings_operation_id:
        source.sourceStandingsOperationId,
      source_readiness_json:
        plan.sourceReadiness.projectionJson,
      source_readiness_schema_version:
        plan.sourceReadiness.schemaVersion,
      source_readiness_sha256:
        plan.sourceReadiness.projectionSha256,
      aggregate_activity_id:
        plan.aggregateActivity.id,
      security_audit_event_id:
        plan.securityAudit.id,
      outbox_event_id: plan.outbox.id,
      completed_at_ms: plan.completedAtMs,
      contracts_advanced:
        plan.summary.contractsAdvanced,
      contracts_expired:
        plan.summary.contractsExpired,
      ownerships_carried:
        plan.summary.ownershipsCarried,
      ownerships_released:
        plan.summary.ownershipsReleased,
      retention_years_advanced:
        plan.summary.retentionYearsAdvanced,
      retention_obligations_completed:
        plan.summary
          .retentionObligationsCompleted,
      buyout_years_advanced:
        plan.summary.buyoutYearsAdvanced,
      buyout_obligations_completed:
        plan.summary
          .buyoutObligationsCompleted,
      trades_cancelled:
        plan.summary.tradesCancelled,
      manifest_schema_version: 1,
      manifest_sha256: manifestSha256,
      created_at_ms: plan.completedAtMs,
      version: 1,
    };
  }

  function commitSeasonRolloverAndOpenDraft(
    command = {}
  ) {
    exactObject(
      command,
      ["plan", "scheduledJob"],
      "An exact season-rollover commit is required."
    );
    const { plan } = command;
    if (
      !isPlainObject(plan) ||
      !isPlainObject(plan.source) ||
      !isPlainObject(plan.target) ||
      !isPlainObject(plan.targetSchedule) ||
      !isPlainObject(plan.entryDraft) ||
      !isPlainObject(plan.firstPickClock) ||
      !isPlainObject(plan.sourceReadiness) ||
      !isPlainObject(plan.summary) ||
      !isPlainObject(plan.effects) ||
      !isPlainObject(plan.aggregateActivity) ||
      !isPlainObject(plan.securityAudit) ||
      !isPlainObject(plan.outbox)
    ) {
      invalid(
        "A canonical season-rollover plan is required."
      );
    }
    for (const key of SUMMARY_KEYS) {
      nonnegativeInteger(
        plan.summary[key],
        `rollover ${key} count`
      );
    }
    const allEffects = [
      ...(plan.effects.contracts ?? []),
      ...(plan.effects.ownerships ?? []),
      ...(plan.effects.retentions ?? []),
      ...(plan.effects.buyouts ?? []),
      ...(plan.effects.trades ?? []),
    ];
    const actualSummary = {
      contractsAdvanced: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "contract_advanced"
      ).length,
      contractsExpired: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "contract_expired"
      ).length,
      ownershipsCarried: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "ownership_carried"
      ).length,
      ownershipsReleased: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "ownership_released"
      ).length,
      retentionYearsAdvanced: allEffects.filter(
        ({ effectKind }) =>
          effectKind ===
          "retention_year_advanced"
      ).length,
      retentionObligationsCompleted:
        allEffects.filter(
          ({ effectKind }) =>
            effectKind ===
            "retention_obligation_completed"
        ).length,
      buyoutYearsAdvanced: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "buyout_year_advanced"
      ).length,
      buyoutObligationsCompleted:
        allEffects.filter(
          ({ effectKind }) =>
            effectKind ===
            "buyout_obligation_completed"
        ).length,
      tradesCancelled: allEffects.filter(
        ({ effectKind }) =>
          effectKind === "trade_cancelled"
      ).length,
    };
    if (
      SUMMARY_KEYS.some(
        (key) =>
          actualSummary[key] !==
          plan.summary[key]
      ) ||
      new Set(
        allEffects.map(
          (effect) =>
            `${effect.effectKind}:${effect.entityId}`
        )
      ).size !== allEffects.length
    ) {
      invalid(
        "The rollover summary does not match its effects."
      );
    }
    const ids = [
      plan.rolloverId,
      plan.attemptId,
      plan.bindingId,
      plan.leagueId,
      plan.entryDraft.id,
      plan.rolloverOccurrenceId,
      plan.source.id,
      plan.target.id,
      plan.targetSchedule.id,
      plan.targetSchedule.weekOneMatchupWeekId,
      plan.firstPickClock.id,
      plan.firstPickClock.draftPickId,
      plan.firstPickClock.owningTeamId,
      plan.aggregateActivity.id,
      plan.securityAudit.id,
      plan.outbox.id,
    ];
    ids.forEach((id) =>
      stableId(id, "rollover plan ID")
    );
    if (
      plan.target.created !== false ||
      plan.entryDraft.statusBefore !==
        "ready" ||
      plan.entryDraft.statusAfter !==
        "active" ||
      plan.entryDraft.selectionGateStatusBefore !==
        "locked" ||
      plan.entryDraft.selectionGateStatusAfter !==
        "open" ||
      plan.entryDraft.tradingGateStatusBefore !==
        "locked" ||
      plan.entryDraft.tradingGateStatusAfter !==
        "open" ||
      plan.firstPickClock.fullClockSeconds !==
        300 ||
      plan.firstPickClock.expiresAtMs !==
        plan.firstPickClock.startsAtMs +
          300_000 ||
      plan.firstPickClock.startsAtMs !==
        plan.completedAtMs ||
      plan.sourceReadiness.schemaVersion !== 1 ||
      serializeSeasonRolloverSourceReadiness(
        plan.sourceReadiness.projection
      ) !==
        plan.sourceReadiness.projectionJson ||
      hashSeasonRolloverSourceReadiness(
        plan.sourceReadiness.projection
      ) !==
        plan.sourceReadiness.projectionSha256
    ) {
      invalid(
        "The rollover plan contains inconsistent frozen evidence."
      );
    }
    if (
      (plan.triggerKind === "scheduled_job" &&
        (!isPlainObject(command.scheduledJob) ||
          plan.scheduledJobRunId !==
            command.scheduledJob.runId ||
          plan.authorizedByUserId !== null ||
          plan.authorizedByMembershipId !== null ||
          plan.authorizedAuthority !==
            "system" ||
          plan.idempotencyRequestId !== null)) ||
      (plan.triggerKind ===
        "commissioner_retry" &&
        (command.scheduledJob !== null ||
          plan.scheduledJobRunId !== null ||
          plan.idempotencyRequestId === null))
    ) {
      invalid(
        "The rollover execution evidence is inconsistent."
      );
    }

    return mapped(
      "commitSeasonRolloverAndOpenDraft",
      "season_rollovers",
      () => {
        const guard = statement(
          "rollover-success-guard",
          `SELECT COUNT(*) AS count
           FROM entry_draft_rollover_bindings AS binding
           JOIN season_rollover_occurrences AS occurrence
             ON occurrence.league_id = binding.league_id
            AND occurrence.binding_id = binding.id
            AND occurrence.id =
                binding.current_rollover_occurrence_id
            AND occurrence.schedule_operation_id =
                binding.current_schedule_operation_id
           JOIN season_rollover_attempts AS attempt
             ON attempt.league_id = binding.league_id
            AND attempt.binding_id = binding.id
            AND attempt.rollover_occurrence_id =
                occurrence.id
           JOIN entry_drafts AS draft
             ON draft.league_id = binding.league_id
            AND draft.id = binding.entry_draft_id
           JOIN draft_picks AS pick
             ON pick.league_id = binding.league_id
            AND pick.id = @draftPickId
            AND pick.draft_id = draft.id
           WHERE binding.league_id = @leagueId
             AND binding.id = @bindingId
             AND binding.current_rollover_occurrence_id =
                 @rolloverOccurrenceId
             AND binding.entry_draft_id =
                 @entryDraftId
             AND binding.status IN ('scheduled', 'blocked')
             AND binding.selection_gate_status = 'locked'
             AND binding.trading_gate_status = 'locked'
             AND binding.version =
                 @bindingVersionBefore
             AND occurrence.status IN ('scheduled', 'blocked')
             AND attempt.id = @attemptId
             AND attempt.status = 'started'
             AND draft.status = 'ready'
             AND draft.version =
                 @entryDraftVersionBefore
             AND pick.target_season_id = @toSeasonId
             AND pick.current_owner_team_id =
                 @owningTeamId
             AND pick.status = 'unused'
             AND pick.version =
                 @draftPickVersionBefore`
        ).get({
          leagueId: plan.leagueId,
          bindingId: plan.bindingId,
          rolloverOccurrenceId:
            plan.rolloverOccurrenceId,
          entryDraftId: plan.entryDraft.id,
          bindingVersionBefore:
            plan.bindingVersionBefore,
          attemptId: plan.attemptId,
          entryDraftVersionBefore:
            plan.entryDraft.versionBefore,
          draftPickId:
            plan.firstPickClock.draftPickId,
          toSeasonId: plan.target.id,
          owningTeamId:
            plan.firstPickClock.owningTeamId,
          draftPickVersionBefore:
            plan.firstPickClock
              .draftPickVersionBefore,
        }).count;
        if (guard !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The rollover success observation changed."
          );
        }

        requireChanged(
          statement(
            "complete-rollover-source-season",
            `UPDATE seasons
             SET status = 'completed',
                 updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE league_id = @leagueId
               AND id = @seasonId
               AND status = 'active'
               AND version = @versionBefore`
          ).run({
            leagueId: plan.leagueId,
            seasonId: plan.source.id,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.source.versionBefore,
            versionAfter:
              plan.source.versionAfter,
          }),
          "The source season changed."
        );
        requireChanged(
          statement(
            "activate-rollover-target-season",
            `UPDATE seasons
             SET status = 'active',
                 updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE league_id = @leagueId
               AND id = @seasonId
               AND status = 'planned'
               AND version = @versionBefore
               AND free_agent_draft_completed_at_ms IS NULL`
          ).run({
            leagueId: plan.leagueId,
            seasonId: plan.target.id,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.target.versionBefore,
            versionAfter:
              plan.target.versionAfter,
          }),
          "The target season changed."
        );
        requireChanged(
          statement(
            "advance-rollover-league",
            `UPDATE leagues
             SET current_season_id = @toSeasonId,
                 updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE id = @leagueId
               AND current_season_id =
                   @fromSeasonId
               AND version = @versionBefore`
          ).run({
            leagueId: plan.leagueId,
            fromSeasonId: plan.source.id,
            toSeasonId: plan.target.id,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.leagueVersionBefore,
            versionAfter:
              plan.leagueVersionAfter,
          }),
          "The league season pointer changed."
        );

        for (const effect of
          plan.effects.contracts) {
          applyContractEffect(plan, effect);
        }
        for (const effect of
          plan.effects.ownerships) {
          applyOwnershipEffect(plan, effect);
        }
        for (const effect of
          plan.effects.retentions) {
          applyObligationEffect(
            plan,
            effect,
            "retention"
          );
        }
        for (const effect of
          plan.effects.buyouts) {
          applyObligationEffect(
            plan,
            effect,
            "buyout"
          );
        }
        for (const effect of
          plan.effects.trades) {
          applyTradeEffect(plan, effect);
        }

        insertActivity(plan.aggregateActivity);
        insertAudit(plan.securityAudit);
        writeOutbox(
          plan.outbox,
          plan.leagueVersionAfter
        );
        requireChanged(
          statement(
            "touch-rollover-first-pick",
            `UPDATE draft_picks
             SET updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE league_id = @leagueId
               AND id = @draftPickId
               AND draft_id = @entryDraftId
               AND target_season_id = @toSeasonId
               AND current_owner_team_id =
                   @owningTeamId
               AND status = 'unused'
               AND version = @versionBefore`
          ).run({
            leagueId: plan.leagueId,
            draftPickId:
              plan.firstPickClock.draftPickId,
            entryDraftId: plan.entryDraft.id,
            toSeasonId: plan.target.id,
            owningTeamId:
              plan.firstPickClock.owningTeamId,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.firstPickClock
                .draftPickVersionBefore,
            versionAfter:
              plan.firstPickClock
                .draftPickVersionAfter,
          }),
          "The first unused Entry Draft pick changed."
        );
        statement(
          "insert-rollover-first-clock",
          `INSERT INTO entry_draft_pick_clocks (
             id, league_id, season_id, binding_id,
             rollover_occurrence_id,
             rollover_attempt_id, season_rollover_id,
             entry_draft_id, draft_pick_id,
             owning_team_id, clock_generation,
             prior_clock_id, on_clock_trade_id,
             pick_sequence, status, starts_at_ms,
             deadline_at_ms, completed_at_ms,
             created_at_ms, updated_at_ms, version
           ) VALUES (
             @id, @leagueId, @seasonId, @bindingId,
             @rolloverOccurrenceId, @attemptId,
             @rolloverId, @entryDraftId, @draftPickId,
             @owningTeamId, 1, NULL, NULL, 1,
             'prepared', @startsAtMs, @deadlineAtMs,
             NULL, @startsAtMs, @startsAtMs, 1
           )`
        ).run({
          id: plan.firstPickClock.id,
          leagueId: plan.leagueId,
          seasonId: plan.target.id,
          bindingId: plan.bindingId,
          rolloverOccurrenceId:
            plan.rolloverOccurrenceId,
          attemptId: plan.attemptId,
          rolloverId: plan.rolloverId,
          entryDraftId: plan.entryDraft.id,
          draftPickId:
            plan.firstPickClock.draftPickId,
          owningTeamId:
            plan.firstPickClock.owningTeamId,
          startsAtMs:
            plan.firstPickClock.startsAtMs,
          deadlineAtMs:
            plan.firstPickClock.expiresAtMs,
        });

        const persistedItems =
          readRolloverItems({
            leagueId: plan.leagueId,
            rolloverId: plan.rolloverId,
          });
        if (
          persistedItems.length !==
          allEffects.length
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The rollover item manifest is incomplete."
          );
        }
        const provisionalRoot =
          rootRecordFromPlan(
            plan,
            "0".repeat(64)
          );
        const manifestSha256 =
          hashSeasonRolloverManifest(
            manifestFromRoot(
              provisionalRoot,
              persistedItems
            )
          );
        const root = rootRecordFromPlan(
          plan,
          manifestSha256
        );
        statement(
          "insert-season-rollover-root",
          `INSERT INTO season_rollovers (
             id, league_id, binding_id,
             rollover_occurrence_id,
             rollover_attempt_id, entry_draft_id,
             target_schedule_id,
             target_schedule_version,
             week_one_matchup_week_id,
             week_one_starts_at_ms,
             first_pick_clock_id,
             entry_draft_scheduled_starts_at_ms,
             occurrence_key, from_season_id,
             to_season_id, status,
             execution_trigger, scheduled_job_run_id,
             idempotency_request_id,
             executed_by_user_id,
             executed_by_membership_id,
             executed_authority,
             entry_draft_scheduled_by_user_id,
             entry_draft_scheduled_by_membership_id,
             entry_draft_scheduled_by_authority,
             league_version_before,
             league_version_after,
             from_season_version_before,
             from_season_version_after,
             to_season_version_before,
             to_season_version_after,
             entry_draft_version_before,
             entry_draft_version_after,
             target_season_reused,
             from_season_label,
             from_nhl_season_key,
             to_season_label,
             target_nhl_season_key,
             nhl_regular_season_starts_at_ms,
             nhl_regular_season_ends_at_ms,
             fantasy_playoffs_start_at_ms,
             fantasy_playoffs_end_at_ms,
             source_fad_id,
             source_finalization_root_id,
             source_finalization_id,
             source_standings_snapshot_id,
             source_standings_operation_id,
             source_readiness_json,
             source_readiness_schema_version,
             source_readiness_sha256,
             aggregate_activity_id,
             security_audit_event_id,
             outbox_event_id, completed_at_ms,
             contracts_advanced, contracts_expired,
             ownerships_carried, ownerships_released,
             retention_years_advanced,
             retention_obligations_completed,
             buyout_years_advanced,
             buyout_obligations_completed,
             trades_cancelled,
             manifest_schema_version,
             manifest_sha256, created_at_ms, version
           ) VALUES (
             @id, @league_id, @binding_id,
             @rollover_occurrence_id,
             @rollover_attempt_id, @entry_draft_id,
             @target_schedule_id,
             @target_schedule_version,
             @week_one_matchup_week_id,
             @week_one_starts_at_ms,
             @first_pick_clock_id,
             @entry_draft_scheduled_starts_at_ms,
             @occurrence_key, @from_season_id,
             @to_season_id, @status,
             @execution_trigger, @scheduled_job_run_id,
             @idempotency_request_id,
             @executed_by_user_id,
             @executed_by_membership_id,
             @executed_authority,
             @entry_draft_scheduled_by_user_id,
             @entry_draft_scheduled_by_membership_id,
             @entry_draft_scheduled_by_authority,
             @league_version_before,
             @league_version_after,
             @from_season_version_before,
             @from_season_version_after,
             @to_season_version_before,
             @to_season_version_after,
             @entry_draft_version_before,
             @entry_draft_version_after,
             @target_season_reused,
             @from_season_label,
             @from_nhl_season_key,
             @to_season_label,
             @target_nhl_season_key,
             @nhl_regular_season_starts_at_ms,
             @nhl_regular_season_ends_at_ms,
             @fantasy_playoffs_start_at_ms,
             @fantasy_playoffs_end_at_ms,
             @source_fad_id,
             @source_finalization_root_id,
             @source_finalization_id,
             @source_standings_snapshot_id,
             @source_standings_operation_id,
             @source_readiness_json,
             @source_readiness_schema_version,
             @source_readiness_sha256,
             @aggregate_activity_id,
             @security_audit_event_id,
             @outbox_event_id, @completed_at_ms,
             @contracts_advanced, @contracts_expired,
             @ownerships_carried, @ownerships_released,
             @retention_years_advanced,
             @retention_obligations_completed,
             @buyout_years_advanced,
             @buyout_obligations_completed,
             @trades_cancelled,
             @manifest_schema_version,
             @manifest_sha256, @created_at_ms, @version
           )`
        ).run(root);
        requireChanged(
          statement(
            "succeed-rollover-attempt",
            `UPDATE season_rollover_attempts
             SET status = 'succeeded',
                 blockers_json = '[]',
                 season_rollover_id = @rolloverId,
                 terminal_at_ms = @completedAtMs,
                 updated_at_ms = @completedAtMs,
                 version = version + 1
             WHERE league_id = @leagueId
               AND id = @attemptId
               AND binding_id = @bindingId
               AND rollover_occurrence_id =
                   @rolloverOccurrenceId
               AND status = 'started'`
          ).run({
            leagueId: plan.leagueId,
            attemptId: plan.attemptId,
            bindingId: plan.bindingId,
            rolloverOccurrenceId:
              plan.rolloverOccurrenceId,
            rolloverId: plan.rolloverId,
            completedAtMs: plan.completedAtMs,
          }),
          "The rollover attempt changed before completion."
        );
        requireChanged(
          statement(
            "succeed-rollover-occurrence",
            `UPDATE season_rollover_occurrences
             SET status = 'succeeded',
                 successful_rollover_id = @rolloverId,
                 terminal_at_ms = @completedAtMs,
                 updated_at_ms = @completedAtMs,
                 version = version + 1
             WHERE league_id = @leagueId
               AND id = @rolloverOccurrenceId
               AND binding_id = @bindingId
               AND status IN ('scheduled', 'blocked')`
          ).run({
            leagueId: plan.leagueId,
            rolloverOccurrenceId:
              plan.rolloverOccurrenceId,
            bindingId: plan.bindingId,
            rolloverId: plan.rolloverId,
            completedAtMs: plan.completedAtMs,
          }),
          "The rollover occurrence changed before completion."
        );
        requireChanged(
          statement(
            "succeed-rollover-binding",
            `UPDATE entry_draft_rollover_bindings
             SET status = 'succeeded',
                 successful_rollover_id = @rolloverId,
                 selection_gate_status = 'open',
                 trading_gate_status = 'open',
                 updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE league_id = @leagueId
               AND id = @bindingId
               AND current_rollover_occurrence_id =
                   @rolloverOccurrenceId
               AND status IN ('scheduled', 'blocked')
               AND selection_gate_status = 'locked'
               AND trading_gate_status = 'locked'
               AND version = @versionBefore`
          ).run({
            leagueId: plan.leagueId,
            bindingId: plan.bindingId,
            rolloverOccurrenceId:
              plan.rolloverOccurrenceId,
            rolloverId: plan.rolloverId,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.bindingVersionBefore,
            versionAfter:
              plan.bindingVersionAfter,
          }),
          "The rollover binding changed before completion."
        );
        requireChanged(
          statement(
            "activate-rollover-entry-draft",
            `UPDATE entry_drafts
             SET status = 'active',
                 updated_at_ms = @completedAtMs,
                 version = @versionAfter
             WHERE league_id = @leagueId
               AND id = @entryDraftId
               AND season_id = @toSeasonId
               AND status = 'ready'
               AND version = @versionBefore`
          ).run({
            leagueId: plan.leagueId,
            entryDraftId: plan.entryDraft.id,
            toSeasonId: plan.target.id,
            completedAtMs: plan.completedAtMs,
            versionBefore:
              plan.entryDraft.versionBefore,
            versionAfter:
              plan.entryDraft.versionAfter,
          }),
          "The Entry Draft changed before activation."
        );
        hook("commitSeasonRolloverAndOpenDraft");
        const durable =
          findDurableSeasonRolloverResult({
            leagueId: plan.leagueId,
            rolloverId: plan.rolloverId,
          });
        if (!durable) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "The committed rollover result is unavailable."
          );
        }
        return durable;
      }
    );
  }

  const repository = {
    findIdempotencyRequest,
    findDurableSeasonRolloverAttempt,
    findDurableSeasonRolloverResult,
    findDurableSeasonRolloverOwnershipReceipt,
    findDurableSetupExemptionResult,
    findRolloverBindingByOccurrence,
    findSeasonRolloverAttemptByIdempotencyRequest,
    findLatestSeasonRolloverAttempt,
    validateScheduledRolloverJobLease,
    beginSeasonRolloverAttempt,
    readSeasonRolloverContext,
    blockSeasonRolloverAttempt,
    commitSeasonRolloverAndOpenDraft,
    readInitialSeason2ExemptionContext,
    verifyInitialSeason2Evidence,
    insertStartedIdempotencyRequest,
    appendSetupExemptionEvidence,
    insertSetupExemption,
    verifySetupExemptionEvidence,
    completeIdempotencyRequest,
  };
  if (
    Object.keys(repository).length !==
      REPOSITORY_METHODS.length ||
    REPOSITORY_METHODS.some(
      (method) =>
        typeof repository[method] !== "function"
    )
  ) {
    throw new TypeError(
      "The lifecycle repository surface is incomplete."
    );
  }
  return Object.freeze(repository);
}

module.exports = {
  REPOSITORY_METHODS,
  createSqliteLeagueLifecycleTransitionRepository,
};
