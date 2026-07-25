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
  createSocketInvalidation,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function createSqliteTradeReversalRepository({ database } = {}) {
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
  let clearTransferredSlotStatement;
  let reverseOwnershipStatement;
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
  let insertOutboxStatement;

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
    clearTransferredSlotStatement = database.prepare(`
      UPDATE player_ownerships SET slot_number = NULL
      WHERE league_id = @leagueId AND id = @ownershipId
        AND team_id = @destinationTeamId
        AND acquired_transaction_type = 'trade_execution'
        AND acquired_transaction_id = @tradeId
        AND version = @postVersion
    `);
    reverseOwnershipStatement = database.prepare(`
      UPDATE player_ownerships
      SET team_id = @sourceTeamId, ownership_kind = @ownershipKind,
        roster_category = @rosterCategory, position_group = @positionGroup,
        slot_number = @slotNumber,
        acquired_transaction_type = 'trade_reversal',
        acquired_transaction_id = @tradeId, updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId AND id = @ownershipId
        AND team_id = @destinationTeamId
        AND acquired_transaction_type = 'trade_execution'
        AND acquired_transaction_id = @tradeId
        AND version = @postVersion
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
        @historyId, @leagueId, @seasonId, @playerId, @sourceTeamId,
        @ownershipId, 'trade_reversal', @actorUserId, 'trade_reversal',
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
    insertOutboxStatement = database.prepare(`
      INSERT INTO outbox_events (
        id, league_id, event_type, aggregate_type, aggregate_id,
        payload_json, status, attempt_count, available_at_ms,
        published_at_ms, last_error_code, created_at_ms, updated_at_ms,
        version
      ) VALUES (
        @outboxEventId, @leagueId, 'trade.changed', 'trade', @tradeId,
        @payloadJson, 'pending', 0, @occurredAtMs, NULL, NULL,
        @occurredAtMs, @occurredAtMs, 1
      )
    `);
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

  function buildEvaluation(command, context) {
    const completionEvent = unique(
      findCompletionEventStatement,
      command,
      "A completed trade had duplicate acceptance events."
    );
    const completionMetadata = completionEvent
      ? parseObject(completionEvent.metadata_json)
      : null;
    const transfers =
      completionEvent?.occurred_at_ms === context.completed_at_ms &&
      Array.isArray(completionMetadata?.transfers)
      ? new Map(completionMetadata.transfers.map((item) => [item.assetId, item]))
      : new Map();
    const assets = listAssetsStatement.all(command);
    const parsed = assets.map((asset) => ({
      row: asset,
      snapshot:
        asset.asset_model_version === 2
          ? parseObject(asset.proposal_snapshot_json)
          : null,
      transfer: transfers.get(asset.id) || null,
      mismatches: [],
    }));
    const transferredOwnershipIds = new Set(
      parsed
        .map(({ snapshot }) => snapshot?.ownership?.id)
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
      if (!validSnapshotShape(snapshot, asset) || !item.transfer) {
        mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
        continue;
      }
      if (
        item.transfer.sourceTeamId !== asset.source_team_id ||
        item.transfer.destinationTeamId !== asset.destination_team_id
      ) {
        mismatch(TRADE_REVERSAL_REASON_CODES.snapshotInvalid);
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
            snapshot.ownership?.id,
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
              updated_at_ms: context.completed_at_ms,
              version: snapshot.ownership?.version + 1,
            }, [
              ["season_id"], ["player_id"], ["ownership_kind"],
              ["roster_category"], ["position_group"], ["slot_number"],
              ["acquired_transaction_type"], ["acquired_transaction_id"],
              ["updated_at_ms"], ["version"],
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
            snapshot.ownership?.id,
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
            updated_at_ms: context.completed_at_ms,
            version: snapshot.ownership?.version + 1,
          }, [
            ["season_id"], ["player_id"], ["ownership_kind"],
            ["roster_category"], ["position_group"], ["slot_number"],
            ["acquired_transaction_type"], ["acquired_transaction_id"],
            ["updated_at_ms"], ["version"],
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
    return freeze({
      replayed,
      trade,
      event: { ...event, metadata: parseObject(event.metadata_json) },
    });
  }

  function reverseAssets(command, evaluation) {
    for (const { row: asset, snapshot } of evaluation.assets) {
      if (snapshot.type === "contract") {
        requireChange(clearTransferredSlotStatement.run({
          ...command,
          ownershipId: snapshot.ownership.id,
          destinationTeamId: asset.destination_team_id,
          postVersion: snapshot.ownership.version + 1,
        }));
      }
    }
    for (const { row: asset, snapshot, transfer } of evaluation.assets) {
      const base = {
        ...command,
        sourceTeamId: asset.source_team_id,
        destinationTeamId: asset.destination_team_id,
      };
      if (snapshot.type === "contract" || snapshot.type === "prospect_right") {
        requireChange(reverseOwnershipStatement.run({
          ...base,
          ownershipId: snapshot.ownership.id,
          ownershipKind:
            snapshot.type === "contract" ? "Rostered" : "Prospect Right",
          rosterCategory: snapshot.ownership.rosterCategory,
          positionGroup: snapshot.ownership.positionGroup,
          slotNumber: snapshot.ownership.slotNumber ?? null,
          postVersion: snapshot.ownership.version + 1,
        }));
        insertOwnershipEventStatement.run({
          ...base,
          historyId: deterministicUuid(
            `${command.eventId}:ownership:${snapshot.ownership.id}`
          ),
          ownershipId: snapshot.ownership.id,
          playerId: snapshot.player.id,
          beforeMetadataJson: JSON.stringify({
            schemaVersion: 1,
            teamId: asset.destination_team_id,
            rosterCategory: snapshot.ownership.rosterCategory,
            slotNumber: transfer?.plannedRosterSlotNumber ?? null,
          }),
          afterMetadataJson: JSON.stringify({
            schemaVersion: 1,
            teamId: asset.source_team_id,
            rosterCategory: snapshot.ownership.rosterCategory,
            slotNumber: snapshot.ownership.slotNumber ?? null,
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

    if (command.action === "reverse") {
      reverseAssets(command, evaluation);
    }
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
    insertOutboxStatement.run({
      ...command,
      payloadJson: JSON.stringify(
        createSocketInvalidation({
          eventType: "trade.changed",
          scope: "league",
          scopeId: command.leagueId,
          version: command.expectedVersion + 1,
          changedAtMs: command.occurredAtMs,
        })
      ),
    });
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
