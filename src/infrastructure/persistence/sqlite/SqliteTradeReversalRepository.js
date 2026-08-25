const crypto = require("node:crypto");

const {
  TRADE_REVERSAL_CODES,
  TRADE_REVERSAL_REASON_CODES,
  TradeReversalPolicyError,
  assertRecoveryActionAllowed,
  assertTradeRecoveryState,
  validateTradeRecoveryCommand,
  validateTradeReversalPreviewCommand,
} = require("../../../domain/trades/tradeReversalPolicy");
const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNERSHIP_TRANSFER_KEYS = Object.freeze([
  "sourceTeamId",
  "destinationTeamId",
  "sourceOwnershipId",
  "sourceOwnershipVersion",
  "destinationOwnershipId",
  "destinationOwnershipVersion",
]);
const REVERSAL_OWNERSHIP_MAPPING_KEYS = Object.freeze([
  "assetId",
  ...OWNERSHIP_TRANSFER_KEYS,
]);
const PUBLIC_TRANSFER_KEYS = Object.freeze([
  "assetId",
  "assetType",
  "sourceTeamId",
  "destinationTeamId",
  "plannedRosterSlotNumber",
]);

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function deterministicUuid(value) {
  const hex = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function requestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        tradeId: command.tradeId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
        action: command.action,
        confirmed: command.confirmed,
      }),
      "utf8"
    )
    .digest("hex");
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freeze(item)])
      )
    );
  }
  return value;
}

function equalFields(row, expected, fields) {
  return (
    row !== null &&
    fields.every(([column, property = column]) => row[column] === expected[property])
  );
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function persistedAggregateFail(message) {
  throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
}

function parsePersistedObject(value, description) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    persistedAggregateFail(`The reversed trade has invalid ${description}.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    persistedAggregateFail(`The reversed trade has invalid ${description}.`);
  }
  return parsed;
}

function exactPersistedObject(value, keys, description) {
  if (!hasExactKeys(value, keys)) {
    persistedAggregateFail(`The reversed trade has invalid ${description}.`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function persistedStableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    persistedAggregateFail(
      `The reversed trade has an invalid ${description}.`
    );
  }
  return value;
}

function persistedPositiveVersion(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) {
    persistedAggregateFail(
      `The reversed trade has an invalid ${description}.`
    );
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicAssetType(asset) {
  return asset.asset_type === "future_consideration" &&
    asset.future_consideration_description !== null
    ? "future_consideration_instruction"
    : asset.asset_type;
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validSnapshotShape(snapshot, asset) {
  if (!snapshot || snapshot.schemaVersion !== 1) return false;
  switch (snapshot.type) {
    case "contract":
      return (
        asset.asset_type === "contract" &&
        UUID_PATTERN.test(snapshot.player?.id || "") &&
        UUID_PATTERN.test(snapshot.ownership?.id || "") &&
        validVersion(snapshot.ownership?.version) &&
        UUID_PATTERN.test(snapshot.contract?.id || "") &&
        validVersion(snapshot.contract?.version) &&
        Array.isArray(snapshot.contract?.years)
      );
    case "prospect_right":
      return (
        asset.asset_type === "prospect_right" &&
        UUID_PATTERN.test(snapshot.player?.id || "") &&
        UUID_PATTERN.test(snapshot.ownership?.id || "") &&
        validVersion(snapshot.ownership?.version) &&
        (snapshot.fantasyElc === null ||
          (UUID_PATTERN.test(snapshot.fantasyElc?.contractId || "") &&
            validVersion(snapshot.fantasyElc?.version)))
      );
    case "draft_pick":
      return asset.asset_type === "draft_pick" &&
        UUID_PATTERN.test(snapshot.id || "") && validVersion(snapshot.version);
    case "retention_obligation":
      return (
        asset.asset_type === "retention_obligation" &&
        UUID_PATTERN.test(snapshot.id || "") &&
        validVersion(snapshot.version) &&
        Array.isArray(snapshot.years)
      );
    case "buyout_obligation":
      return (
        asset.asset_type === "buyout_obligation" &&
        UUID_PATTERN.test(snapshot.id || "") &&
        validVersion(snapshot.version) &&
        Array.isArray(snapshot.years)
      );
    case "requested_retention":
      return (
        asset.asset_type === "requested_retention" &&
        UUID_PATTERN.test(snapshot.contractId || "") &&
        UUID_PATTERN.test(snapshot.playerId || "")
      );
    case "future_consideration_instruction":
      return (
        asset.asset_type === "future_consideration" &&
        asset.future_consideration_description !== null &&
        typeof snapshot.description === "string"
      );
    case "future_consideration":
      return (
        asset.asset_type === "future_consideration" &&
        asset.future_consideration_description === null &&
        UUID_PATTERN.test(snapshot.id || "") &&
        validVersion(snapshot.version)
      );
    default:
      return false;
  }
}

function validAcceptanceTenureMapping(transfer, snapshot, asset, tradeId) {
  if (!["contract", "prospect_right"].includes(asset.asset_type)) return true;
  return (
    transfer !== null &&
    transfer.sourceTeamId === asset.source_team_id &&
    transfer.destinationTeamId === asset.destination_team_id &&
    transfer.sourceOwnershipId === snapshot.ownership?.id &&
    transfer.sourceOwnershipVersion === snapshot.ownership?.version &&
    UUID_PATTERN.test(transfer.destinationOwnershipId || "") &&
    transfer.destinationOwnershipId !== transfer.sourceOwnershipId &&
    transfer.destinationOwnershipId === deterministicUuid(
      `${tradeId}:ownership-tenure:${transfer.sourceOwnershipId}:destination`
    ) &&
    transfer.destinationOwnershipVersion === 1
  );
}

function createSqliteTradeReversalRepository({
  database,
  candidateCardSummerSynchronizer,
  leagueOutboxWriter,
} = {}) {
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteTradeReversalRepository requires a Candidate Card summer synchronizer"
    );
  }
  let findTargetStatement;
  let loadContextStatement;
  let listAssetsStatement;
  let findCompletionEventStatement;
  let findOwnershipStatement;
  let findContractStatement;
  let listContractYearsStatement;
  let findDraftPickStatement;
  let findRetentionStatement;
  let listRetentionYearsStatement;
  let findBuyoutStatement;
  let listBuyoutYearsStatement;
  let findFutureConsiderationStatement;
  let findSlotOccupantStatement;
  let findIdempotencyStatement;
  let insertIdempotencyStatement;
  let completeIdempotencyStatement;
  let findRecoveryEventStatement;
  let listReversalOwnershipEventsStatement;
  let deleteReversalRosterDisplayOrderStatement;
  let deleteReversalOwnershipStatement;
  let insertReversalOwnershipStatement;
  let reverseContractStatement;
  let reverseDraftPickStatement;
  let reverseRetentionStatement;
  let reverseBuyoutStatement;
  let reverseFutureConsiderationStatement;
  let deleteRetentionYearsStatement;
  let deleteRetentionStatement;
  let deleteFutureConsiderationStatement;
  let updateTradeStatement;
  let insertOwnershipEventStatement;
  let insertContractEventStatement;
  let insertDraftPickEventStatement;
  let insertTradeEventStatement;
  let insertCorrectionStatement;
  let insertActivityStatement;
  let outboxWriter;

  try {
    findTargetStatement = database.prepare(`
      SELECT * FROM trades
      WHERE league_id = @leagueId AND id = @tradeId
      LIMIT 2
    `);
    loadContextStatement = database.prepare(`
      SELECT
        trade.id AS trade_id,
        trade.league_id AS league_id,
        trade.season_id AS season_id,
        trade.proposing_team_id AS proposing_team_id,
        trade.receiving_team_id AS receiving_team_id,
        trade.status AS trade_status,
        trade.completed_at_ms AS completed_at_ms,
        trade.proposal_model_version AS proposal_model_version,
        trade.version AS trade_version,
        league.commissioner_membership_id AS commissioner_membership_id,
        membership.user_id AS membership_user_id,
        membership.status AS membership_status,
        membership.permission_category AS membership_permission
      FROM trades AS trade
      JOIN leagues AS league ON league.id = trade.league_id
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = trade.league_id
       AND membership.id = @actorMembershipId
       AND membership.user_id = @actorUserId
      WHERE trade.league_id = @leagueId AND trade.id = @tradeId
      LIMIT 2
    `);
    listAssetsStatement = database.prepare(`
      SELECT * FROM trade_assets
      WHERE league_id = @leagueId AND trade_id = @tradeId
      ORDER BY sequence ASC, id ASC
    `);
    findCompletionEventStatement = database.prepare(`
      SELECT * FROM trade_events
      WHERE league_id = @leagueId AND trade_id = @tradeId
        AND event_type = 'proposal_accepted'
      LIMIT 2
    `);
    findOwnershipStatement = database.prepare(`
      SELECT * FROM player_ownerships
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    findContractStatement = database.prepare(`
      SELECT * FROM contracts
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    listContractYearsStatement = database.prepare(`
      SELECT * FROM contract_years
      WHERE league_id = @leagueId AND contract_id = @id
      ORDER BY year_number ASC, id ASC
    `);
    findDraftPickStatement = database.prepare(`
      SELECT * FROM draft_picks
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    findRetentionStatement = database.prepare(`
      SELECT * FROM retention_obligations
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    listRetentionYearsStatement = database.prepare(`
      SELECT * FROM retention_years
      WHERE league_id = @leagueId AND retention_obligation_id = @id
      ORDER BY season_id ASC, id ASC
    `);
    findBuyoutStatement = database.prepare(`
      SELECT * FROM buyout_obligations
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    listBuyoutYearsStatement = database.prepare(`
      SELECT * FROM buyout_years
      WHERE league_id = @leagueId AND buyout_obligation_id = @id
      ORDER BY season_id ASC, id ASC
    `);
    findFutureConsiderationStatement = database.prepare(`
      SELECT * FROM future_considerations
      WHERE league_id = @leagueId AND id = @id
      LIMIT 2
    `);
    findSlotOccupantStatement = database.prepare(`
      SELECT id FROM player_ownerships
      WHERE league_id = @leagueId AND season_id = @seasonId
        AND team_id = @teamId AND roster_category = @rosterCategory
        AND slot_number = @slotNumber
        AND (
          roster_category <> 'Active' OR position_group = @positionGroup
        )
      LIMIT 2
    `);
    findIdempotencyStatement = database.prepare(`
      SELECT * FROM idempotency_requests
      WHERE league_id = @leagueId AND actor_user_id = @actorUserId
        AND operation = @operation AND client_key = @idempotencyKey
      LIMIT 2
    `);
    insertIdempotencyStatement = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key, request_hash,
        status, result_type, result_id, created_at_ms, completed_at_ms,
        expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId, @actorUserId, @operation,
        @idempotencyKey, @requestHash, 'started', NULL, NULL,
        @occurredAtMs, NULL, @idempotencyExpiresAtMs
      )
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'trade', result_id = @tradeId,
        completed_at_ms = @occurredAtMs
      WHERE league_id = @leagueId AND id = @idempotencyRequestId
        AND status = 'started'
    `);
    findRecoveryEventStatement = database.prepare(`
      SELECT * FROM trade_events
      WHERE league_id = @leagueId AND trade_id = @tradeId
        AND event_type = @eventType
      LIMIT 2
    `);
    listReversalOwnershipEventsStatement = database.prepare(`
      SELECT * FROM ownership_events
      WHERE league_id = @leagueId
        AND source_type = 'trade_reversal'
        AND source_id = @tradeId
        AND event_type IN ('trade_reversal_out', 'trade_reversal_in')
      ORDER BY event_type, ownership_id, id
    `);
    deleteReversalRosterDisplayOrderStatement = database.prepare(`
      DELETE FROM roster_display_order_entries
      WHERE league_id = @leagueId AND ownership_id = @sourceOwnershipId
    `);
    deleteReversalOwnershipStatement = database.prepare(`
      DELETE FROM player_ownerships
      WHERE league_id = @leagueId AND id = @sourceOwnershipId
        AND team_id = @destinationTeamId
        AND acquired_transaction_type = 'trade_execution'
        AND acquired_transaction_id = @tradeId
        AND version = @sourceOwnershipVersion
    `);
    insertReversalOwnershipStatement = database.prepare(`
      INSERT INTO player_ownerships (
        id, league_id, season_id, player_id, team_id, ownership_kind,
        roster_category, position_group, slot_number,
        acquired_transaction_type, acquired_transaction_id,
        created_at_ms, updated_at_ms, version, trade_blocked
      ) VALUES (
        @destinationOwnershipId, @leagueId, @seasonId, @playerId,
        @sourceTeamId, @ownershipKind, @rosterCategory, @positionGroup,
        @slotNumber, 'trade_reversal', @tradeId, @occurredAtMs,
        @occurredAtMs, 1, 0
      )
    `);
    reverseContractStatement = database.prepare(`
      UPDATE contracts
      SET current_team_id = @sourceTeamId, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @contractId
        AND current_team_id = @destinationTeamId AND status = 'active'
        AND version = @postVersion
    `);
    reverseDraftPickStatement = database.prepare(`
      UPDATE draft_picks
      SET current_owner_team_id = @sourceTeamId, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @draftPickId
        AND current_owner_team_id = @destinationTeamId
        AND status = 'unused' AND selection_id IS NULL
        AND version = @postVersion
    `);
    reverseRetentionStatement = database.prepare(`
      UPDATE retention_obligations
      SET responsible_team_id = @sourceTeamId, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @retentionObligationId
        AND responsible_team_id = @destinationTeamId AND status = 'active'
        AND version = @postVersion
    `);
    reverseBuyoutStatement = database.prepare(`
      UPDATE buyout_obligations
      SET responsible_team_id = @sourceTeamId, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @buyoutObligationId
        AND responsible_team_id = @destinationTeamId AND status = 'active'
        AND version = @postVersion
    `);
    reverseFutureConsiderationStatement = database.prepare(`
      UPDATE future_considerations
      SET receiving_team_id = @sourceTeamId, status = 'outstanding',
        resolved_at_ms = NULL, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @futureConsiderationId
        AND receiving_team_id = @postReceivingTeamId
        AND status = @postStatus AND version = @postVersion
    `);
    deleteRetentionYearsStatement = database.prepare(`
      DELETE FROM retention_years
      WHERE league_id = @leagueId AND retention_obligation_id = @id
    `);
    deleteRetentionStatement = database.prepare(`
      DELETE FROM retention_obligations
      WHERE league_id = @leagueId AND id = @id
        AND creation_trade_id = @tradeId AND version = 1
    `);
    deleteFutureConsiderationStatement = database.prepare(`
      DELETE FROM future_considerations
      WHERE league_id = @leagueId AND id = @id
        AND originating_trade_id = @tradeId AND version = 1
    `);
    updateTradeStatement = database.prepare(`
      UPDATE trades
      SET status = @nextStatus, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @tradeId
        AND status = 'completed' AND proposal_model_version = 2
        AND version = @expectedVersion
    `);
    insertOwnershipEventStatement = database.prepare(`
      INSERT INTO ownership_events (
        id, league_id, season_id, player_id, team_id, ownership_id,
        event_type, actor_user_id, source_type, source_id,
        before_metadata_json, after_metadata_json, reason, occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @seasonId, @playerId, @eventTeamId,
        @eventOwnershipId, @ownershipEventType, @actorUserId, 'trade_reversal',
        @tradeId, @beforeMetadataJson, @afterMetadataJson,
        'safe_trade_reversal', @occurredAtMs
      )
    `);
    insertContractEventStatement = database.prepare(`
      INSERT INTO contract_events (
        id, league_id, contract_id, player_id, team_id, actor_user_id,
        event_type, source_type, source_id, metadata_json, reason,
        occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @contractId, @playerId, @sourceTeamId,
        @actorUserId, 'trade_reversal', 'trade_reversal', @tradeId,
        @metadataJson, 'safe_trade_reversal', @occurredAtMs
      )
    `);
    insertDraftPickEventStatement = database.prepare(`
      INSERT INTO draft_pick_ownership_events (
        id, league_id, draft_pick_id, from_team_id, to_team_id,
        trade_id, actor_user_id, event_type, occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @draftPickId, @destinationTeamId,
        @sourceTeamId, @tradeId, @actorUserId, 'trade_reversal',
        @occurredAtMs
      )
    `);
    insertTradeEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id, event_type,
        reason, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @tradeId, @actorUserId,
        @eventType, @reason, @metadataJson, @occurredAtMs
      )
    `);
    insertCorrectionStatement = database.prepare(`
      INSERT INTO commissioner_corrections (
        id, league_id, season_id, feature, feature_record_id,
        actor_user_id, reason, before_snapshot_json, after_snapshot_json,
        corrected_at_ms
      ) VALUES (
        @correctionId, @leagueId, @seasonId, 'trade', @tradeId,
        @actorUserId, @reason, @beforeSnapshotJson, @afterSnapshotJson,
        @occurredAtMs
      )
    `);
    insertActivityStatement = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type, actor_user_id,
        actor_authority, team_id, player_id, related_type, related_id,
        display_summary, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId, @activityEventType,
        @actorUserId, 'commissioner', NULL, NULL, 'trade', @tradeId,
        @displaySummary, @reason, @metadataJson, @occurredAtMs
      )
    `);
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTradeReversalRepository",
      tableName: "trades",
    });
  }

  function unique(statement, parameters, message) {
    const rows = statement.all(parameters);
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
    }
    return rows[0] || null;
  }

  function contextFor(command) {
    return unique(
      loadContextStatement,
      command,
      "A trade recovery state row was not unique."
    );
  }

  function row(statement, command, id, message) {
    return unique(statement, { leagueId: command.leagueId, id }, message);
  }

  function currentYears(statement, command, id) {
    return statement.all({ leagueId: command.leagueId, id });
  }

  function pushMismatch(mismatches, asset, reasonCode) {
    if (!mismatches.some((item) => item.reasonCode === reasonCode)) {
      mismatches.push(
        freeze({
          assetId: asset.id,
          assetType:
            asset.asset_type === "future_consideration" &&
            asset.future_consideration_description !== null
              ? "future_consideration_instruction"
              : asset.asset_type,
          reasonCode,
        })
      );
    }
  }

  function compareRows(current, expected, fields) {
    return (
      current.length === expected.length &&
      current.every((item, index) =>
        equalFields(item, expected[index], fields)
      )
    );
  }

  function validCompletionTransition(metadata) {
    return (
      (metadata?.action === "accept" && metadata?.fromStatus === "proposed") ||
      (
        metadata?.action === "approve" &&
        metadata?.fromStatus === "awaiting_commissioner_approval"
      )
    );
  }

  function buildEvaluation(command, context) {
    const completionEvent = unique(
      findCompletionEventStatement,
      command,
      "A completed trade had duplicate acceptance events."
    );
    const completionMetadata = completionEvent
      ? parseObject(completionEvent.metadata_json)
      : null;
    const assets = listAssetsStatement.all(command);
    let acceptanceMetadataValid =
      completionEvent?.occurred_at_ms === context.completed_at_ms &&
      completionMetadata?.schemaVersion === 1 &&
      validCompletionTransition(completionMetadata) &&
      completionMetadata?.toStatus === "completed" &&
      Array.isArray(completionMetadata?.transfers) &&
      Array.isArray(completionMetadata?.ownershipTransfers) &&
      completionMetadata.transfers.length === assets.length &&
      completionMetadata.ownershipTransfers.length === assets.filter(
        (asset) => ["contract", "prospect_right"].includes(asset.asset_type)
      ).length;
    const transfers = new Map();
    const ownershipTransfers = new Map();
    const seenOwnershipIds = new Set();
    if (acceptanceMetadataValid) {
      for (const transfer of completionMetadata.transfers) {
        if (
          !hasExactKeys(transfer, PUBLIC_TRANSFER_KEYS) ||
          !UUID_PATTERN.test(transfer.assetId || "") ||
          !UUID_PATTERN.test(transfer.sourceTeamId || "") ||
          !UUID_PATTERN.test(transfer.destinationTeamId || "") ||
          transfer.sourceTeamId === transfer.destinationTeamId ||
          transfers.has(transfer.assetId)
        ) {
          acceptanceMetadataValid = false;
          break;
        }
        transfers.set(transfer.assetId, transfer);
      }
    }
    if (acceptanceMetadataValid) {
      let priorSortKey = null;
      for (const transfer of completionMetadata.ownershipTransfers) {
        const sortKey = `${transfer?.sourceOwnershipId || ""}:` +
          `${transfer?.destinationOwnershipId || ""}`;
        if (
          !hasExactKeys(transfer, OWNERSHIP_TRANSFER_KEYS) ||
          !UUID_PATTERN.test(transfer.sourceTeamId || "") ||
          !UUID_PATTERN.test(transfer.destinationTeamId || "") ||
          transfer.sourceTeamId === transfer.destinationTeamId ||
          !UUID_PATTERN.test(transfer.sourceOwnershipId || "") ||
          !validVersion(transfer.sourceOwnershipVersion) ||
          !UUID_PATTERN.test(transfer.destinationOwnershipId || "") ||
          transfer.destinationOwnershipVersion !== 1 ||
          transfer.sourceOwnershipId === transfer.destinationOwnershipId ||
          seenOwnershipIds.has(transfer.sourceOwnershipId) ||
          seenOwnershipIds.has(transfer.destinationOwnershipId) ||
          (priorSortKey !== null && priorSortKey.localeCompare(sortKey) >= 0)
        ) {
          acceptanceMetadataValid = false;
          break;
        }
        priorSortKey = sortKey;
        seenOwnershipIds.add(transfer.sourceOwnershipId);
        seenOwnershipIds.add(transfer.destinationOwnershipId);
        ownershipTransfers.set(transfer.sourceOwnershipId, transfer);
      }
    }
    const parsed = assets.map((asset) => {
      const snapshot =
        asset.asset_model_version === 2
          ? parseObject(asset.proposal_snapshot_json)
          : null;
      const publicTransfer = transfers.get(asset.id) || null;
      const ownershipTransfer = snapshot?.ownership?.id
        ? ownershipTransfers.get(snapshot.ownership.id) || null
        : null;
      return {
        row: asset,
        snapshot,
        transfer:
          acceptanceMetadataValid &&
          publicTransfer &&
          (!["contract", "prospect_right"].includes(asset.asset_type) ||
            ownershipTransfer)
            ? { ...publicTransfer, ...(ownershipTransfer || {}) }
            : null,
        acceptanceMetadataValid,
        mismatches: [],
      };
    });
    const transferredOwnershipIds = new Set(
      parsed
        .map(({ transfer }) => transfer?.destinationOwnershipId)
        .filter((id) => typeof id === "string")
    );
    const contractSnapshots = new Map(
      parsed
        .filter(({ snapshot }) => snapshot?.type === "contract")
        .map(({ snapshot }) => [snapshot.contract.id, snapshot])
    );

    for (const item of parsed) {
      const asset = item.row;
      const snapshot = item.snapshot;
      const mismatch = (code) => pushMismatch(item.mismatches, asset, code);
      if (
        !item.acceptanceMetadataValid ||
        !validSnapshotShape(snapshot, asset) ||
        !item.transfer
      ) {
        mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
        continue;
      }
      if (
        item.transfer.sourceTeamId !== asset.source_team_id ||
        item.transfer.destinationTeamId !== asset.destination_team_id ||
        item.transfer.assetType !== publicAssetType(asset) ||
        !validAcceptanceTenureMapping(
          item.transfer,
          snapshot,
          asset,
          command.tradeId
        )
      ) {
        mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
        continue;
      }

      switch (snapshot.type) {
        case "contract": {
          if (asset.asset_type !== "contract") {
            mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
            break;
          }
          const ownership = row(
            findOwnershipStatement,
            command,
            item.transfer.destinationOwnershipId,
            "A traded ownership row was not unique."
          );
          const contract = row(
            findContractStatement,
            command,
            snapshot.contract?.id,
            "A traded contract row was not unique."
          );
          if (!ownership || !contract) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
            break;
          }
          if (
            ownership.team_id !== asset.destination_team_id ||
            contract.current_team_id !== asset.destination_team_id
          ) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMoved);
          }
          if (
            !equalFields(ownership, {
              season_id: context.season_id,
              player_id: snapshot.player?.id,
              ownership_kind: "Rostered",
              roster_category: snapshot.ownership?.rosterCategory,
              position_group: snapshot.ownership?.positionGroup,
              slot_number: item.transfer.plannedRosterSlotNumber,
              acquired_transaction_type: "trade_execution",
              acquired_transaction_id: command.tradeId,
              created_at_ms: context.completed_at_ms,
              updated_at_ms: context.completed_at_ms,
              version: item.transfer.destinationOwnershipVersion,
            }, [
              ["season_id"], ["player_id"], ["ownership_kind"],
              ["roster_category"], ["position_group"], ["slot_number"],
              ["acquired_transaction_type"], ["acquired_transaction_id"],
              ["created_at_ms"], ["updated_at_ms"], ["version"],
            ]) ||
            !equalFields(contract, {
              player_id: snapshot.player?.id,
              contract_type: snapshot.contract?.type,
              original_total_value_cents: snapshot.contract?.originalTotalValueCents,
              original_term_years: snapshot.contract?.originalTermYears,
              aav_cents: snapshot.contract?.aavCents,
              start_season_id: snapshot.contract?.startSeasonId,
              auction_buyout_lock_expires_at_ms:
                snapshot.contract?.auctionBuyoutLockExpiresAtMs,
              status: "active",
              updated_at_ms: context.completed_at_ms,
              version: snapshot.contract?.version + 1,
            }, [
              ["player_id"], ["contract_type"], ["original_total_value_cents"],
              ["original_term_years"], ["aav_cents"], ["start_season_id"],
              ["auction_buyout_lock_expires_at_ms"], ["status"],
              ["updated_at_ms"], ["version"],
            ]) ||
            !compareRows(
              currentYears(listContractYearsStatement, command, snapshot.contract.id),
              snapshot.contract?.years || [],
              [
                ["season_id"], ["year_number"], ["aav_cents"], ["status"],
              ]
            )
          ) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetChanged);
          }
          if (snapshot.ownership?.slotNumber !== null) {
            const occupant = unique(
              findSlotOccupantStatement,
              {
                leagueId: command.leagueId,
                seasonId: context.season_id,
                teamId: asset.source_team_id,
                rosterCategory: snapshot.ownership?.rosterCategory,
                positionGroup: snapshot.ownership?.positionGroup,
                slotNumber: snapshot.ownership?.slotNumber,
              },
              "A roster slot had duplicate occupants."
            );
            if (occupant && !transferredOwnershipIds.has(occupant.id)) {
              mismatch(TRADE_REVERSAL_REASON_CODES.originalSlotOccupied);
            }
          }
          break;
        }
        case "prospect_right": {
          if (asset.asset_type !== "prospect_right") {
            mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
            break;
          }
          const ownership = row(
            findOwnershipStatement,
            command,
            item.transfer.destinationOwnershipId,
            "A traded prospect ownership row was not unique."
          );
          if (!ownership) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
            break;
          }
          if (ownership.team_id !== asset.destination_team_id) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMoved);
          }
          if (!equalFields(ownership, {
            season_id: context.season_id,
            player_id: snapshot.player?.id,
            ownership_kind: "Prospect Right",
            roster_category: "Prospect",
            position_group: snapshot.ownership?.positionGroup,
            slot_number: null,
            acquired_transaction_type: "trade_execution",
            acquired_transaction_id: command.tradeId,
            created_at_ms: context.completed_at_ms,
            updated_at_ms: context.completed_at_ms,
            version: item.transfer.destinationOwnershipVersion,
          }, [
            ["season_id"], ["player_id"], ["ownership_kind"],
            ["roster_category"], ["position_group"], ["slot_number"],
            ["acquired_transaction_type"], ["acquired_transaction_id"],
            ["created_at_ms"], ["updated_at_ms"], ["version"],
          ])) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetChanged);
          }
          if (snapshot.fantasyElc !== null) {
            const contract = row(
              findContractStatement,
              command,
              snapshot.fantasyElc?.contractId,
              "A traded prospect contract row was not unique."
            );
            if (!contract) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
            } else if (contract.current_team_id !== asset.destination_team_id) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetMoved);
            } else if (!equalFields(contract, {
              player_id: snapshot.player?.id,
              contract_type: "fantasy_elc",
              aav_cents: snapshot.fantasyElc?.aavCents,
              status: "active",
              updated_at_ms: context.completed_at_ms,
              version: snapshot.fantasyElc?.version + 1,
            }, [
              ["player_id"], ["contract_type"], ["aav_cents"],
              ["status"], ["updated_at_ms"], ["version"],
            ])) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetChanged);
            }
          }
          break;
        }
        case "draft_pick": {
          const pick = row(
            findDraftPickStatement,
            command,
            snapshot.id,
            "A traded draft pick was not unique."
          );
          if (!pick) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
          } else {
            if (pick.current_owner_team_id !== asset.destination_team_id) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetMoved);
            }
            if (pick.status !== "unused" || pick.selection_id !== null) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetConsumed);
            }
            if (!equalFields(pick, {
              draft_id: snapshot.draftId,
              target_season_id: snapshot.targetSeasonId,
              round_number: snapshot.roundNumber,
              position_number: snapshot.positionNumber,
              original_team_id: snapshot.originalTeamId,
              updated_at_ms: context.completed_at_ms,
              version: snapshot.version + 1,
            }, [
              ["draft_id"], ["target_season_id"], ["round_number"],
              ["position_number"], ["original_team_id"],
              ["updated_at_ms"], ["version"],
            ])) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetChanged);
            }
          }
          break;
        }
        case "retention_obligation":
        case "buyout_obligation": {
          const isRetention = snapshot.type === "retention_obligation";
          const obligation = row(
            isRetention ? findRetentionStatement : findBuyoutStatement,
            command,
            snapshot.id,
            "A traded cap obligation was not unique."
          );
          const years = obligation
            ? currentYears(
                isRetention ? listRetentionYearsStatement : listBuyoutYearsStatement,
                command,
                snapshot.id
              )
            : [];
          if (!obligation) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
          } else {
            if (obligation.responsible_team_id !== asset.destination_team_id) {
              mismatch(TRADE_REVERSAL_REASON_CODES.assetMoved);
            }
            const common = equalFields(obligation, {
              contract_id: snapshot.contractId,
              player_id: snapshot.player?.id,
              originating_team_id: snapshot.originatingTeamId,
              responsible_team_id: asset.destination_team_id,
              status: "active",
              updated_at_ms: context.completed_at_ms,
              version: snapshot.version + 1,
            }, [
              ["contract_id"], ["player_id"], ["originating_team_id"],
              ["responsible_team_id"], ["status"], ["updated_at_ms"],
              ["version"],
            ]);
            const amount = isRetention
              ? obligation.retained_aav_cents === snapshot.retainedAavCents &&
                obligation.creation_trade_id === snapshot.creationTradeId
              : obligation.annual_penalty_basis_cents ===
                  snapshot.annualPenaltyBasisCents &&
                obligation.buyout_transaction_id === snapshot.buyoutTransactionId;
            if (!common || !amount || !compareRows(
              years,
              [...(snapshot.years || [])].sort((a, b) =>
                a.season_id.localeCompare(b.season_id)
              ),
              [
                ["season_id"],
                [isRetention ? "retained_aav_cents" : "penalty_cents"],
                ["status"],
              ]
            )) {
              mismatch(TRADE_REVERSAL_REASON_CODES.obligationChanged);
            }
          }
          break;
        }
        case "requested_retention": {
          const obligation = row(
            findRetentionStatement,
            command,
            asset.id,
            "A trade-created retention obligation was not unique."
          );
          if (!obligation) {
            mismatch(TRADE_REVERSAL_REASON_CODES.createdObligationMissing);
            break;
          }
          const contractSnapshot = contractSnapshots.get(snapshot.contractId);
          const sourceYears = contractSnapshot?.contract?.years?.filter((year) =>
            ["current", "future"].includes(year.status)
          );
          const expectedYears = sourceYears?.map((year) => ({
            id: deterministicUuid(
              `${command.tradeId}:retention-year:${asset.id}:${year.season_id}`
            ),
            league_id: command.leagueId,
            retention_obligation_id: asset.id,
            season_id: year.season_id,
            retained_aav_cents: snapshot.retainedAavCents,
            status: year.status,
            created_at_ms: context.completed_at_ms,
          }));
          if (!equalFields(obligation, {
            contract_id: snapshot.contractId,
            player_id: snapshot.playerId,
            originating_team_id: asset.source_team_id,
            responsible_team_id: asset.source_team_id,
            retained_aav_cents: snapshot.retainedAavCents,
            creation_trade_id: command.tradeId,
            status: "active",
            created_at_ms: context.completed_at_ms,
            updated_at_ms: context.completed_at_ms,
            version: 1,
          }, [
            ["contract_id"], ["player_id"], ["originating_team_id"],
            ["responsible_team_id"], ["retained_aav_cents"],
            ["creation_trade_id"], ["status"], ["created_at_ms"],
            ["updated_at_ms"], ["version"],
          ]) || !expectedYears || !compareRows(
            currentYears(listRetentionYearsStatement, command, asset.id),
            [...expectedYears].sort((a, b) => a.season_id.localeCompare(b.season_id)),
            [
              ["id"], ["league_id"], ["retention_obligation_id"],
              ["season_id"], ["retained_aav_cents"], ["status"],
              ["created_at_ms"],
            ]
          )) {
            mismatch(TRADE_REVERSAL_REASON_CODES.createdObligationChanged);
          }
          break;
        }
        case "future_consideration_instruction": {
          const consideration = row(
            findFutureConsiderationStatement,
            command,
            asset.id,
            "A trade-created Future Considerations row was not unique."
          );
          if (!consideration) {
            mismatch(TRADE_REVERSAL_REASON_CODES.createdObligationMissing);
          } else if (!equalFields(consideration, {
            season_id: context.season_id,
            originating_trade_id: command.tradeId,
            owing_team_id: asset.source_team_id,
            receiving_team_id: asset.destination_team_id,
            description: snapshot.description,
            status: "outstanding",
            created_at_ms: context.completed_at_ms,
            resolved_at_ms: null,
            updated_at_ms: context.completed_at_ms,
            version: 1,
          }, [
            ["season_id"], ["originating_trade_id"], ["owing_team_id"],
            ["receiving_team_id"], ["description"], ["status"],
            ["created_at_ms"], ["resolved_at_ms"], ["updated_at_ms"],
            ["version"],
          ])) {
            mismatch(TRADE_REVERSAL_REASON_CODES.createdObligationChanged);
          }
          break;
        }
        case "future_consideration": {
          const consideration = row(
            findFutureConsiderationStatement,
            command,
            snapshot.id,
            "A traded Future Considerations row was not unique."
          );
          if (!consideration) {
            mismatch(TRADE_REVERSAL_REASON_CODES.assetMissing);
            break;
          }
          const cancelled = snapshot.owingTeamId === asset.destination_team_id;
          const expected = {
            originating_trade_id: snapshot.originatingTradeId,
            owing_team_id: snapshot.owingTeamId,
            receiving_team_id: cancelled
              ? asset.source_team_id
              : asset.destination_team_id,
            description: snapshot.description,
            status: cancelled ? "cancelled" : "outstanding",
            resolved_at_ms: cancelled ? context.completed_at_ms : null,
            updated_at_ms: context.completed_at_ms,
            version: snapshot.version + 1,
          };
          if (!equalFields(consideration, expected, [
            ["originating_trade_id"], ["owing_team_id"],
            ["receiving_team_id"], ["description"], ["status"],
            ["resolved_at_ms"], ["updated_at_ms"], ["version"],
          ])) {
            mismatch(TRADE_REVERSAL_REASON_CODES.obligationChanged);
          }
          break;
        }
        default:
          mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
      }
    }

    const publicAssets = parsed.map((item) =>
      freeze({
        id: item.row.id,
        assetType:
          item.row.asset_type === "future_consideration" &&
          item.row.future_consideration_description !== null
            ? "future_consideration_instruction"
            : item.row.asset_type,
        sourceTeamId: item.row.source_team_id,
        destinationTeamId: item.row.destination_team_id,
        recoverable: item.mismatches.length === 0,
        mismatches: item.mismatches,
      })
    );
    const mismatches = publicAssets.flatMap((asset) => asset.mismatches);
    return {
      assets: parsed,
      preview: freeze({
        tradeId: command.tradeId,
        leagueId: command.leagueId,
        seasonId: context.season_id,
        status: context.trade_status,
        version: context.trade_version,
        recoverable: mismatches.length === 0,
        mismatches,
        assets: publicAssets,
      }),
    };
  }

  function previewFor(command, context) {
    assertTradeRecoveryState({ command, context });
    return buildEvaluation(command, context);
  }

  function requireChange(result) {
    if (result.changes !== 1) {
      throw new TradeReversalPolicyError(TRADE_REVERSAL_CODES.versionConflict);
    }
  }

  function eventType(action) {
    return action === "reverse" ? "trade_reversed" : "trade_correction_required";
  }

  function operation(action) {
    return action === "reverse" ? "trade.reverse" : "trade.correction_required";
  }

  function reconstructReversalReceipt({ command, trade, event, metadata }) {
    const participantTeamIds = [
      trade.proposing_team_id,
      trade.receiving_team_id,
    ].sort((left, right) => left.localeCompare(right));
    if (
      trade.league_id !== command.leagueId ||
      trade.season_id !== command.seasonId ||
      trade.status !== "reversed" ||
      trade.proposing_team_id === trade.receiving_team_id ||
      participantTeamIds.some((teamId) => !UUID_PATTERN.test(teamId)) ||
      event.league_id !== trade.league_id ||
      event.season_id !== trade.season_id ||
      event.trade_id !== trade.id ||
      event.event_type !== "trade_reversed" ||
      event.actor_user_id !== command.actorUserId ||
      event.reason !== "safe_trade_reversal" ||
      event.occurred_at_ms !== trade.updated_at_ms ||
      !UUID_PATTERN.test(event.id || "")
    ) {
      persistedAggregateFail("The reversed trade scope is inconsistent.");
    }
    exactPersistedObject(
      metadata,
      [
        "schemaVersion",
        "action",
        "actorAuthority",
        "actorMembershipId",
        "fromStatus",
        "toStatus",
        "recoverable",
        "mismatches",
        "assets",
        "ownershipTenureMappings",
        "correctionId",
      ],
      "reversal event metadata"
    );
    if (
      metadata.schemaVersion !== 1 ||
      metadata.action !== "reverse" ||
      metadata.actorAuthority !== command.actorAuthority ||
      metadata.actorMembershipId !== command.actorMembershipId ||
      metadata.fromStatus !== "completed" ||
      metadata.toStatus !== "reversed" ||
      metadata.recoverable !== true ||
      !Array.isArray(metadata.mismatches) ||
      metadata.mismatches.length !== 0 ||
      !Array.isArray(metadata.assets) ||
      !Array.isArray(metadata.ownershipTenureMappings) ||
      !UUID_PATTERN.test(metadata.correctionId || "")
    ) {
      persistedAggregateFail("The reversed trade event metadata is incomplete.");
    }

    const completionEvent = unique(
      findCompletionEventStatement,
      command,
      "A reversed trade had duplicate acceptance events."
    );
    if (
      !completionEvent ||
      completionEvent.occurred_at_ms !== trade.completed_at_ms ||
      completionEvent.league_id !== trade.league_id ||
      completionEvent.season_id !== trade.season_id ||
      completionEvent.trade_id !== trade.id
    ) {
      persistedAggregateFail("The reversed trade acceptance event is incomplete.");
    }
    const completionMetadata = parsePersistedObject(
      completionEvent.metadata_json,
      "acceptance event metadata"
    );
    if (
      completionMetadata.schemaVersion !== 1 ||
      !validCompletionTransition(completionMetadata) ||
      completionMetadata.toStatus !== "completed" ||
      !Array.isArray(completionMetadata.transfers) ||
      !Array.isArray(completionMetadata.ownershipTransfers)
    ) {
      persistedAggregateFail("The reversed trade acceptance receipt is incomplete.");
    }

    const assets = listAssetsStatement.all(command);
    if (completionMetadata.transfers.length !== assets.length) {
      persistedAggregateFail("The reversed trade public transfer receipt is incomplete.");
    }
    const publicTransfersByAssetId = new Map();
    for (const transfer of completionMetadata.transfers) {
      exactPersistedObject(
        transfer,
        PUBLIC_TRANSFER_KEYS,
        "public transfer receipt"
      );
      persistedStableId(transfer.assetId, "public transfer asset identifier");
      persistedStableId(transfer.sourceTeamId, "public transfer source team");
      persistedStableId(
        transfer.destinationTeamId,
        "public transfer destination team"
      );
      if (
        transfer.sourceTeamId === transfer.destinationTeamId ||
        publicTransfersByAssetId.has(transfer.assetId)
      ) {
        persistedAggregateFail(
          "The reversed trade public transfer receipt is inconsistent."
        );
      }
      publicTransfersByAssetId.set(transfer.assetId, transfer);
    }

    const acceptedOwnershipBySourceId = new Map();
    const acceptedOwnershipIds = new Set();
    let priorAcceptedSortKey = null;
    for (const transfer of completionMetadata.ownershipTransfers) {
      exactPersistedObject(
        transfer,
        OWNERSHIP_TRANSFER_KEYS,
        "acceptance ownership-transfer mapping"
      );
      persistedStableId(transfer.sourceTeamId, "acceptance source team");
      persistedStableId(
        transfer.destinationTeamId,
        "acceptance destination team"
      );
      persistedStableId(
        transfer.sourceOwnershipId,
        "acceptance source ownership"
      );
      persistedPositiveVersion(
        transfer.sourceOwnershipVersion,
        "acceptance source ownership version"
      );
      persistedStableId(
        transfer.destinationOwnershipId,
        "acceptance destination ownership"
      );
      persistedPositiveVersion(
        transfer.destinationOwnershipVersion,
        "acceptance destination ownership version"
      );
      const sortKey = `${transfer.sourceOwnershipId}:` +
        `${transfer.destinationOwnershipId}`;
      if (
        transfer.sourceTeamId === transfer.destinationTeamId ||
        transfer.destinationOwnershipVersion !== 1 ||
        transfer.sourceOwnershipId === transfer.destinationOwnershipId ||
        acceptedOwnershipIds.has(transfer.sourceOwnershipId) ||
        acceptedOwnershipIds.has(transfer.destinationOwnershipId) ||
        (priorAcceptedSortKey !== null &&
          priorAcceptedSortKey.localeCompare(sortKey) >= 0)
      ) {
        persistedAggregateFail(
          "The reversed trade acceptance ownership mapping is inconsistent."
        );
      }
      priorAcceptedSortKey = sortKey;
      acceptedOwnershipIds.add(transfer.sourceOwnershipId);
      acceptedOwnershipIds.add(transfer.destinationOwnershipId);
      acceptedOwnershipBySourceId.set(transfer.sourceOwnershipId, transfer);
    }

    const expectedPublicAssets = assets.map((asset) => ({
      id: asset.id,
      assetType: publicAssetType(asset),
      sourceTeamId: asset.source_team_id,
      destinationTeamId: asset.destination_team_id,
      recoverable: true,
      mismatches: [],
    }));
    if (canonicalJson(metadata.assets) !== canonicalJson(expectedPublicAssets)) {
      persistedAggregateFail("The reversed trade asset receipt is inconsistent.");
    }

    const expectedRecords = [];
    for (const asset of assets) {
      const publicTransfer = publicTransfersByAssetId.get(asset.id);
      if (
        !publicTransfer ||
        publicTransfer.assetType !== publicAssetType(asset) ||
        publicTransfer.sourceTeamId !== asset.source_team_id ||
        publicTransfer.destinationTeamId !== asset.destination_team_id ||
        !participantTeamIds.includes(asset.source_team_id) ||
        !participantTeamIds.includes(asset.destination_team_id)
      ) {
        persistedAggregateFail(
          "The reversed trade public transfer asset scope is inconsistent."
        );
      }
      if (!["contract", "prospect_right"].includes(asset.asset_type)) continue;
      const snapshot = parsePersistedObject(
        asset.proposal_snapshot_json,
        "ownership-transfer proposal snapshot"
      );
      if (!validSnapshotShape(snapshot, asset)) {
        persistedAggregateFail(
          "The reversed trade ownership-transfer snapshot is incomplete."
        );
      }
      const acceptedTransfer = acceptedOwnershipBySourceId.get(
        snapshot.ownership.id
      );
      if (
        !validAcceptanceTenureMapping(
          acceptedTransfer,
          snapshot,
          asset,
          command.tradeId
        )
      ) {
        persistedAggregateFail(
          "The reversed trade acceptance ownership mapping is inconsistent."
        );
      }
      const destinationOwnershipId = deterministicUuid(
        `${command.tradeId}:reversal-ownership-tenure:` +
          `${acceptedTransfer.destinationOwnershipId}`
      );
      expectedRecords.push({
        asset,
        snapshot,
        publicTransfer,
        mapping: {
          assetId: asset.id,
          sourceTeamId: asset.destination_team_id,
          destinationTeamId: asset.source_team_id,
          sourceOwnershipId: acceptedTransfer.destinationOwnershipId,
          sourceOwnershipVersion: acceptedTransfer.destinationOwnershipVersion,
          destinationOwnershipId,
          destinationOwnershipVersion: 1,
        },
      });
    }
    expectedRecords.sort((left, right) =>
      left.mapping.assetId.localeCompare(right.mapping.assetId)
    );
    if (
      completionMetadata.ownershipTransfers.length !== expectedRecords.length ||
      metadata.ownershipTenureMappings.length !== expectedRecords.length
    ) {
      persistedAggregateFail(
        "The reversed trade ownership-transfer mapping is incomplete."
      );
    }

    const mappings = [];
    const seenReversalOwnershipIds = new Set();
    for (let index = 0; index < expectedRecords.length; index += 1) {
      const expected = expectedRecords[index].mapping;
      const mapping = exactPersistedObject(
        metadata.ownershipTenureMappings[index],
        REVERSAL_OWNERSHIP_MAPPING_KEYS,
        "reversal ownership-transfer mapping"
      );
      for (const key of ["assetId", "sourceTeamId", "destinationTeamId"]){
        persistedStableId(mapping[key], `reversal ${key}`);
      }
      persistedStableId(
        mapping.sourceOwnershipId,
        "reversal source ownership"
      );
      persistedPositiveVersion(
        mapping.sourceOwnershipVersion,
        "reversal source ownership version"
      );
      persistedStableId(
        mapping.destinationOwnershipId,
        "reversal destination ownership"
      );
      persistedPositiveVersion(
        mapping.destinationOwnershipVersion,
        "reversal destination ownership version"
      );
      if (
        REVERSAL_OWNERSHIP_MAPPING_KEYS.some(
          (key) => mapping[key] !== expected[key]
        ) ||
        mapping.destinationOwnershipVersion !== 1 ||
        mapping.sourceOwnershipId === mapping.destinationOwnershipId ||
        acceptedOwnershipIds.has(mapping.destinationOwnershipId) ||
        seenReversalOwnershipIds.has(mapping.sourceOwnershipId) ||
        seenReversalOwnershipIds.has(mapping.destinationOwnershipId)
      ) {
        persistedAggregateFail(
          "The reversed trade ownership-transfer mapping is inconsistent."
        );
      }
      seenReversalOwnershipIds.add(mapping.sourceOwnershipId);
      seenReversalOwnershipIds.add(mapping.destinationOwnershipId);
      mappings.push(Object.freeze({ ...mapping }));
    }

    const ownershipEvents = listReversalOwnershipEventsStatement.all(command);
    if (ownershipEvents.length !== expectedRecords.length * 2) {
      persistedAggregateFail(
        "The reversed trade ownership-transfer history is incomplete."
      );
    }
    const eventsByTenure = new Map();
    for (const ownershipEvent of ownershipEvents) {
      const key = `${ownershipEvent.event_type}:${ownershipEvent.ownership_id}`;
      if (eventsByTenure.has(key)) {
        persistedAggregateFail(
          "The reversed trade ownership-transfer history is duplicated."
        );
      }
      eventsByTenure.set(key, ownershipEvent);
    }
    for (const record of expectedRecords) {
      const { mapping } = record;
      const sourceEvent = eventsByTenure.get(
        `trade_reversal_out:${mapping.sourceOwnershipId}`
      );
      const destinationEvent = eventsByTenure.get(
        `trade_reversal_in:${mapping.destinationOwnershipId}`
      );
      if (!sourceEvent || !destinationEvent) {
        persistedAggregateFail(
          "The reversed trade ownership-transfer history is incomplete."
        );
      }
      const ownershipKind = record.asset.asset_type === "contract"
        ? "Rostered"
        : "Prospect Right";
      const rosterCategory = record.asset.asset_type === "contract"
        ? record.snapshot.ownership.rosterCategory
        : "Prospect";
      const sourceSlotNumber = record.asset.asset_type === "contract"
        ? record.publicTransfer.plannedRosterSlotNumber
        : null;
      const destinationSlotNumber = record.snapshot.ownership.slotNumber ?? null;
      const sourceOwnership = row(
        findOwnershipStatement,
        command,
        mapping.sourceOwnershipId,
        "A closed reversal source ownership was not unique."
      );
      const destinationOwnership = row(
        findOwnershipStatement,
        command,
        mapping.destinationOwnershipId,
        "A committed reversal destination ownership was not unique."
      );
      if (
        sourceOwnership !== null ||
        destinationOwnership === null ||
        destinationOwnership.season_id !== trade.season_id ||
        destinationOwnership.player_id !== record.snapshot.player.id ||
        destinationOwnership.team_id !== mapping.destinationTeamId ||
        destinationOwnership.ownership_kind !== ownershipKind ||
        destinationOwnership.roster_category !== rosterCategory ||
        destinationOwnership.position_group !==
          record.snapshot.ownership.positionGroup ||
        destinationOwnership.slot_number !== destinationSlotNumber ||
        destinationOwnership.acquired_transaction_type !== "trade_reversal" ||
        destinationOwnership.acquired_transaction_id !== command.tradeId ||
        destinationOwnership.created_at_ms !== event.occurred_at_ms ||
        destinationOwnership.updated_at_ms !== event.occurred_at_ms ||
        destinationOwnership.version !== 1 ||
        destinationOwnership.trade_blocked !== 0
      ) {
        persistedAggregateFail(
          "The reversed trade committed ownership tenure is inconsistent."
        );
      }
      const expectedSourceBefore = {
        schemaVersion: 2,
        exists: true,
        ownership: {
          id: mapping.sourceOwnershipId,
          leagueId: trade.league_id,
          seasonId: trade.season_id,
          playerId: record.snapshot.player.id,
          teamId: mapping.sourceTeamId,
          ownershipKind,
          rosterCategory,
          positionGroup: record.snapshot.ownership.positionGroup,
          slotNumber: sourceSlotNumber,
          version: mapping.sourceOwnershipVersion,
        },
      };
      const expectedSourceAfter = {
        schemaVersion: 2,
        exists: false,
        destinationOwnershipId: mapping.destinationOwnershipId,
      };
      const expectedDestinationBefore = {
        schemaVersion: 2,
        exists: false,
        sourceOwnershipId: mapping.sourceOwnershipId,
      };
      const expectedDestinationAfter = {
        schemaVersion: 2,
        exists: true,
        ownership: {
          id: mapping.destinationOwnershipId,
          leagueId: trade.league_id,
          seasonId: trade.season_id,
          playerId: record.snapshot.player.id,
          teamId: mapping.destinationTeamId,
          ownershipKind,
          rosterCategory,
          positionGroup: record.snapshot.ownership.positionGroup,
          slotNumber: destinationSlotNumber,
          version: mapping.destinationOwnershipVersion,
        },
      };
      if (
        sourceEvent.id !== deterministicUuid(
          `${event.id}:ownership:${mapping.sourceOwnershipId}:out`
        ) ||
        sourceEvent.season_id !== trade.season_id ||
        sourceEvent.player_id !== record.snapshot.player.id ||
        sourceEvent.team_id !== mapping.sourceTeamId ||
        sourceEvent.actor_user_id !== event.actor_user_id ||
        sourceEvent.source_id !== command.tradeId ||
        sourceEvent.reason !== "safe_trade_reversal" ||
        sourceEvent.occurred_at_ms !== event.occurred_at_ms ||
        destinationEvent.id !== deterministicUuid(
          `${event.id}:ownership:${mapping.destinationOwnershipId}:in`
        ) ||
        destinationEvent.season_id !== trade.season_id ||
        destinationEvent.player_id !== record.snapshot.player.id ||
        destinationEvent.team_id !== mapping.destinationTeamId ||
        destinationEvent.actor_user_id !== event.actor_user_id ||
        destinationEvent.source_id !== command.tradeId ||
        destinationEvent.reason !== "safe_trade_reversal" ||
        destinationEvent.occurred_at_ms !== event.occurred_at_ms ||
        canonicalJson(parsePersistedObject(
          sourceEvent.before_metadata_json,
          "reversal source closure history"
        )) !== canonicalJson(expectedSourceBefore) ||
        canonicalJson(parsePersistedObject(
          sourceEvent.after_metadata_json,
          "reversal source closure history"
        )) !== canonicalJson(expectedSourceAfter) ||
        canonicalJson(parsePersistedObject(
          destinationEvent.before_metadata_json,
          "reversal destination acquisition history"
        )) !== canonicalJson(expectedDestinationBefore) ||
        canonicalJson(parsePersistedObject(
          destinationEvent.after_metadata_json,
          "reversal destination acquisition history"
        )) !== canonicalJson(expectedDestinationAfter)
      ) {
        persistedAggregateFail(
          "The reversed trade ownership-transfer history is inconsistent."
        );
      }
    }

    const witnessesByTeam = new Map(
      participantTeamIds.map((teamId) => [teamId, []])
    );
    for (const mapping of mappings) {
      witnessesByTeam.get(mapping.sourceTeamId).push({
        ownershipId: mapping.sourceOwnershipId,
        ownershipVersion: mapping.sourceOwnershipVersion,
        state: "deleted",
      });
      witnessesByTeam.get(mapping.destinationTeamId).push({
        ownershipId: mapping.destinationOwnershipId,
        ownershipVersion: mapping.destinationOwnershipVersion,
        state: "present",
      });
    }
    const committedTeams = participantTeamIds.map((teamId) => {
      const ownershipWitnesses = witnessesByTeam
        .get(teamId)
        .sort((left, right) => left.ownershipId.localeCompare(right.ownershipId))
        .map((witness) => Object.freeze(witness));
      return Object.freeze({
        leagueId: trade.league_id,
        seasonId: trade.season_id,
        teamId,
        ownershipWitnesses: Object.freeze(ownershipWitnesses),
      });
    });
    return Object.freeze({
      mappings: Object.freeze(mappings),
      committedTeams: Object.freeze(committedTeams),
    });
  }

  function aggregate(command, replayed) {
    const trade = unique(
      findTargetStatement,
      command,
      "A recovered trade row was not unique."
    );
    const event = unique(
      findRecoveryEventStatement,
      { ...command, eventType: eventType(command.action) },
      "A trade recovery event was not unique."
    );
    if (!trade || !event) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The recovered trade aggregate is incomplete."
      );
    }
    if (command.action !== "reverse") {
      return freeze({
        replayed,
        trade,
        event: { ...event, metadata: parseObject(event.metadata_json) },
      });
    }
    const metadata = parsePersistedObject(
      event.metadata_json,
      "reversal event metadata"
    );
    const receipt = reconstructReversalReceipt({
      command,
      trade,
      event,
      metadata,
    });
    const result = {
      replayed,
      trade: Object.freeze({ ...trade }),
      event: Object.freeze({
        ...event,
        metadata: Object.freeze({
          ...metadata,
          ownershipTenureMappings: receipt.mappings,
        }),
      }),
    };
    Object.defineProperty(result, "committedTeams", {
      configurable: false,
      enumerable: false,
      value: receipt.committedTeams,
      writable: false,
    });
    return Object.freeze(result);
  }

  function reverseAssets(command, evaluation) {
    const ownershipTenures = new Map();
    for (const { row: asset, snapshot, transfer } of evaluation.assets) {
      if (!["contract", "prospect_right"].includes(snapshot.type)) continue;
      const sourceOwnershipId = transfer.destinationOwnershipId;
      const sourceOwnershipVersion = transfer.destinationOwnershipVersion;
      const destinationOwnershipId = deterministicUuid(
        `${command.tradeId}:reversal-ownership-tenure:${sourceOwnershipId}`
      );
      deleteReversalRosterDisplayOrderStatement.run({
        leagueId: command.leagueId,
        sourceOwnershipId,
      });
      requireChange(deleteReversalOwnershipStatement.run({
        ...command,
        sourceOwnershipId,
        sourceOwnershipVersion,
        destinationTeamId: asset.destination_team_id,
      }));
      ownershipTenures.set(asset.id, Object.freeze({
        assetId: asset.id,
        sourceTeamId: asset.destination_team_id,
        destinationTeamId: asset.source_team_id,
        sourceOwnershipId,
        sourceOwnershipVersion,
        destinationOwnershipId,
        destinationOwnershipVersion: 1,
      }));
    }
    for (const { row: asset, snapshot, transfer } of evaluation.assets) {
      const base = {
        ...command,
        sourceTeamId: asset.source_team_id,
        destinationTeamId: asset.destination_team_id,
      };
      if (snapshot.type === "contract" || snapshot.type === "prospect_right") {
        const tenure = ownershipTenures.get(asset.id);
        insertReversalOwnershipStatement.run({
          ...base,
          destinationOwnershipId: tenure.destinationOwnershipId,
          playerId: snapshot.player.id,
          ownershipKind:
            snapshot.type === "contract" ? "Rostered" : "Prospect Right",
          rosterCategory: snapshot.ownership.rosterCategory,
          positionGroup: snapshot.ownership.positionGroup,
          slotNumber: snapshot.ownership.slotNumber ?? null,
        });
        insertOwnershipEventStatement.run({
          ...base,
          historyId: deterministicUuid(
            `${command.eventId}:ownership:${tenure.sourceOwnershipId}:out`
          ),
          playerId: snapshot.player.id,
          eventTeamId: asset.destination_team_id,
          eventOwnershipId: tenure.sourceOwnershipId,
          ownershipEventType: "trade_reversal_out",
          beforeMetadataJson: JSON.stringify({
            schemaVersion: 2,
            exists: true,
            ownership: {
              id: tenure.sourceOwnershipId,
              leagueId: command.leagueId,
              seasonId: command.seasonId,
              playerId: snapshot.player.id,
              teamId: asset.destination_team_id,
              ownershipKind:
                snapshot.type === "contract" ? "Rostered" : "Prospect Right",
              rosterCategory: snapshot.ownership.rosterCategory,
              positionGroup: snapshot.ownership.positionGroup,
              slotNumber: transfer?.plannedRosterSlotNumber ?? null,
              version: tenure.sourceOwnershipVersion,
            },
          }),
          afterMetadataJson: JSON.stringify({
            schemaVersion: 2,
            exists: false,
            destinationOwnershipId: tenure.destinationOwnershipId,
          }),
        });
        insertOwnershipEventStatement.run({
          ...base,
          historyId: deterministicUuid(
            `${command.eventId}:ownership:${tenure.destinationOwnershipId}:in`
          ),
          playerId: snapshot.player.id,
          eventTeamId: asset.source_team_id,
          eventOwnershipId: tenure.destinationOwnershipId,
          ownershipEventType: "trade_reversal_in",
          beforeMetadataJson: JSON.stringify({
            schemaVersion: 2,
            exists: false,
            sourceOwnershipId: tenure.sourceOwnershipId,
          }),
          afterMetadataJson: JSON.stringify({
            schemaVersion: 2,
            exists: true,
            ownership: {
              id: tenure.destinationOwnershipId,
              leagueId: command.leagueId,
              seasonId: command.seasonId,
              playerId: snapshot.player.id,
              teamId: asset.source_team_id,
              ownershipKind:
                snapshot.type === "contract" ? "Rostered" : "Prospect Right",
              rosterCategory: snapshot.ownership.rosterCategory,
              positionGroup: snapshot.ownership.positionGroup,
              slotNumber: snapshot.ownership.slotNumber ?? null,
              version: tenure.destinationOwnershipVersion,
            },
          }),
        });
        const contractId =
          snapshot.type === "contract"
            ? snapshot.contract.id
            : snapshot.fantasyElc?.contractId;
        const contractVersion =
          snapshot.type === "contract"
            ? snapshot.contract.version
            : snapshot.fantasyElc?.version;
        if (contractId) {
          requireChange(reverseContractStatement.run({
            ...base,
            contractId,
            postVersion: contractVersion + 1,
          }));
          insertContractEventStatement.run({
            ...base,
            historyId: deterministicUuid(`${command.eventId}:contract:${contractId}`),
            contractId,
            playerId: snapshot.player.id,
            metadataJson: JSON.stringify({
              schemaVersion: 1,
              fromTeamId: asset.destination_team_id,
              toTeamId: asset.source_team_id,
              termsUnchanged: true,
              ...(snapshot.type === "prospect_right"
                ? { prospectStatusPreserved: true }
                : {}),
            }),
          });
        }
      } else if (snapshot.type === "draft_pick") {
        requireChange(reverseDraftPickStatement.run({
          ...base,
          draftPickId: snapshot.id,
          postVersion: snapshot.version + 1,
        }));
        insertDraftPickEventStatement.run({
          ...base,
          historyId: deterministicUuid(`${command.eventId}:draft-pick:${snapshot.id}`),
          draftPickId: snapshot.id,
        });
      } else if (snapshot.type === "retention_obligation") {
        requireChange(reverseRetentionStatement.run({
          ...base,
          retentionObligationId: snapshot.id,
          postVersion: snapshot.version + 1,
        }));
      } else if (snapshot.type === "buyout_obligation") {
        requireChange(reverseBuyoutStatement.run({
          ...base,
          buyoutObligationId: snapshot.id,
          postVersion: snapshot.version + 1,
        }));
      } else if (snapshot.type === "requested_retention") {
        deleteRetentionYearsStatement.run({ ...base, id: asset.id });
        requireChange(deleteRetentionStatement.run({ ...base, id: asset.id }));
      } else if (snapshot.type === "future_consideration_instruction") {
        requireChange(deleteFutureConsiderationStatement.run({ ...base, id: asset.id }));
      } else if (snapshot.type === "future_consideration") {
        const cancelled = snapshot.owingTeamId === asset.destination_team_id;
        requireChange(reverseFutureConsiderationStatement.run({
          ...base,
          futureConsiderationId: snapshot.id,
          postReceivingTeamId: cancelled
            ? asset.source_team_id
            : asset.destination_team_id,
          postStatus: cancelled ? "cancelled" : "outstanding",
          postVersion: snapshot.version + 1,
        }));
      }
    }
    return freeze([...ownershipTenures.values()].sort((left, right) =>
      left.assetId.localeCompare(right.assetId)
    ));
  }

  const recoveryTransaction = database.transaction((rawCommand) => {
    const command = validateTradeRecoveryCommand(rawCommand);
    const requestOperation = operation(command.action);
    const hash = requestHash(command);
    const existing = unique(
      findIdempotencyStatement,
      { ...command, operation: requestOperation },
      "A trade recovery idempotency key was not unique."
    );
    if (existing) {
      if (
        existing.request_hash !== hash ||
        existing.status !== "completed" ||
        existing.result_type !== "trade" ||
        existing.result_id !== command.tradeId
      ) {
        throw new TradeReversalPolicyError(
          TRADE_REVERSAL_CODES.idempotencyConflict
        );
      }
      return aggregate(command, true);
    }

    insertIdempotencyStatement.run({
      ...command,
      operation: requestOperation,
      requestHash: hash,
    });
    const context = contextFor(command);
    const evaluation = previewFor(command, context);
    assertRecoveryActionAllowed(command.action, evaluation.preview.recoverable);

    const ownershipTenureMappings = command.action === "reverse"
      ? reverseAssets(command, evaluation)
      : Object.freeze([]);
    const nextStatus =
      command.action === "reverse" ? "reversed" : "correction_required";
    requireChange(updateTradeStatement.run({ ...command, nextStatus }));

    const reason =
      command.action === "reverse"
        ? "safe_trade_reversal"
        : "direct_trade_reversal_unsafe";
    const recoveryEventType = eventType(command.action);
    const evidence = {
      schemaVersion: 1,
      action: command.action,
      actorAuthority: command.actorAuthority,
      actorMembershipId: command.actorMembershipId,
      fromStatus: "completed",
      toStatus: nextStatus,
      recoverable: evaluation.preview.recoverable,
      mismatches: evaluation.preview.mismatches,
      assets: evaluation.preview.assets,
      ...(command.action === "reverse" ? { ownershipTenureMappings } : {}),
      correctionId: command.correctionId,
    };
    insertTradeEventStatement.run({
      ...command,
      eventType: recoveryEventType,
      reason,
      metadataJson: JSON.stringify(evidence),
    });
    insertCorrectionStatement.run({
      ...command,
      reason,
      beforeSnapshotJson: JSON.stringify({
        schemaVersion: 1,
        status: "completed",
        version: command.expectedVersion,
        recoverable: evaluation.preview.recoverable,
        mismatches: evaluation.preview.mismatches,
        assets: evaluation.preview.assets,
      }),
      afterSnapshotJson: JSON.stringify({
        schemaVersion: 1,
        status: nextStatus,
        version: command.expectedVersion + 1,
        assetsRestored: command.action === "reverse",
      }),
    });
    insertActivityStatement.run({
      ...command,
      activityEventType: recoveryEventType,
      displaySummary:
        command.action === "reverse"
          ? "Commissioner reversed a completed trade."
          : "Commissioner marked a completed trade as correction required.",
      reason,
      metadataJson: JSON.stringify(evidence),
    });
    outboxWriter.write({
      id: command.outboxEventId,
      leagueId: command.leagueId,
      eventType: "trade.changed",
      aggregateType: "trade",
      aggregateId: command.tradeId,
      payload: createSocketEventMetadata({
        eventType: "trade.changed",
        version: command.expectedVersion + 1,
        reasonCode: "trade_changed",
        occurredAtMs: command.occurredAtMs,
        related: createEmptySocketRelated(),
      }),
      occurredAtMs: command.occurredAtMs,
    });
    if (command.action === "reverse") {
      candidateCardSummerSynchronizer.synchronize({
        leagueId: command.leagueId,
        affectedTeamIds: [
          ...new Set([
            context.proposing_team_id,
            context.receiving_team_id,
          ]),
        ].sort(),
        affectedPlayerIds: [
          ...new Set(
            evaluation.assets
              .filter(({ snapshot }) =>
                ["contract", "prospect_right"].includes(snapshot.type)
              )
              .map(({ snapshot }) => snapshot.player.id)
          ),
        ].sort(),
        sourceOperationId: command.eventId,
        sourceKind: "trade_reversal",
        nowMs: command.occurredAtMs,
      });
    }
    requireChange(completeIdempotencyStatement.run(command));
    return aggregate(command, false);
  });

  return Object.freeze({
    findRecoveryTarget({ leagueId, tradeId } = {}) {
      try {
        const target = unique(
          findTargetStatement,
          { leagueId: stableId(leagueId), tradeId: stableId(tradeId) },
          "A trade recovery target was not unique."
        );
        return target ? freeze(target) : null;
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findTradeRecoveryTarget",
          tableName: "trades",
        });
      }
    },
    preview(rawCommand) {
      try {
        const previewCommand = validateTradeReversalPreviewCommand(rawCommand);
        const context = contextFor(previewCommand);
        const command = Object.freeze({
          ...previewCommand,
          seasonId: context?.season_id,
          expectedVersion: context?.trade_version,
        });
        return previewFor(command, context).preview;
      } catch (error) {
        if (error instanceof TradeReversalPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "previewTradeReversal",
          tableName: "trades",
        });
      }
    },
    recover(rawCommand) {
      try {
        return recoveryTransaction.immediate(rawCommand);
      } catch (error) {
        if (error instanceof TradeReversalPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "recoverCompletedTrade",
          tableName: "trades",
        });
      }
    },
  });
}

module.exports = { createSqliteTradeReversalRepository };
