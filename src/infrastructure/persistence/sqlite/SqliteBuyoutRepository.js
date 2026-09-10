const crypto = require("node:crypto");
const {
  BuyoutPolicyError,
  createBuyoutAggregate,
  validateBuyoutCommand,
} = require("../../../domain/contracts/buyoutPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");
const {
  resolveSqliteTradeProposalCancellationWriter,
} = require("./SqliteTradeProposalCancellationWriter");

function cancellationEventId(buyoutId, tradeId) {
  const hex = crypto.createHash("sha256").update(`${buyoutId}:auto-cancel:${tradeId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function commandHash(command) {
  return crypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function createSqliteBuyoutRepository({
  database,
  candidateCardSummerSynchronizer,
  leagueOutboxWriter,
  tradePublicationWriter,
  tradeProposalCancellationWriter,
} = {}) {
  if (
    !candidateCardSummerSynchronizer ||
    typeof candidateCardSummerSynchronizer.synchronize !== "function"
  ) {
    throw new TypeError(
      "createSqliteBuyoutRepository requires a Candidate Card summer synchronizer"
    );
  }
  const contracts = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contracts"),
  });
  const contractEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_events"),
  });
  const ownershipEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("ownership_events"),
  });
  const obligations = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("buyout_obligations"),
  });
  const buyoutYears = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("buyout_years"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });

  let contractStatement;
  let ownershipStatement;
  let remainingYearsStatement;
  let pendingTradesStatement;
  let eliminateYearStatement;
  let deleteOwnershipStatement;
  let buyoutTransaction;
  try {
    const cancellationWriter = resolveSqliteTradeProposalCancellationWriter({
      database, leagueOutboxWriter, tradePublicationWriter, tradeProposalCancellationWriter,
    });
    contractStatement = database.prepare(
      "SELECT * FROM contracts " +
        "WHERE id = @contractId AND league_id = @leagueId LIMIT 2"
    );
    ownershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE id = @ownershipId AND league_id = @leagueId LIMIT 2"
    );
    remainingYearsStatement = database.prepare(
      "SELECT id, season_id, status FROM contract_years " +
        "WHERE contract_id = @contractId AND league_id = @leagueId " +
        "AND status IN ('current', 'future') ORDER BY year_number ASC"
    );
    pendingTradesStatement = database.prepare(
      `SELECT DISTINCT trades.id, trades.season_id, trades.version,
        CASE WHEN EXISTS (
          SELECT 1 FROM trade_future_consideration_acceptances AS acceptance
          WHERE acceptance.league_id = trades.league_id AND acceptance.trade_id = trades.id
        ) THEN 'awaiting_commissioner_approval' ELSE 'proposed' END AS trade_status
      FROM trades
      JOIN trade_assets ON trade_assets.league_id = trades.league_id AND trade_assets.trade_id = trades.id
      WHERE trades.league_id = @leagueId AND trades.status = 'proposed'
        AND ((trade_assets.asset_type = 'contract' AND trade_assets.contract_id = @contractId)
          OR (trade_assets.asset_type = 'prospect_right' AND trade_assets.player_id = @playerId))
      ORDER BY trades.id`
    );
    eliminateYearStatement = database.prepare(
      "UPDATE contract_years SET status = 'eliminated', " +
        "rollover_at_ms = @occurredAtMs " +
        "WHERE id = @contractYearId AND league_id = @leagueId " +
        "AND contract_id = @contractId AND status = @expectedStatus"
    );
    deleteOwnershipStatement = database.prepare(
      "DELETE FROM player_ownerships " +
        "WHERE id = @ownershipId AND league_id = @leagueId " +
        "AND version = @expectedOwnershipVersion"
    );

    buyoutTransaction = database.transaction((command) => {
      const existingActivity = activity.findByKey({ key: command.activityId, leagueId: command.leagueId });
      if (existingActivity?.event_type === "contract_bought_out") {
        const metadata = JSON.parse(existingActivity.metadata_json);
        const receipt = metadata.buyoutReceipt;
        if (!receipt || receipt.commandHash !== commandHash(command)) {
          throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict,
            "The buyout receipt belongs to a different command.");
        }
        const contractEvent = contractEvents.requireByKey({ key: command.contractEventId, leagueId: command.leagueId });
        const ownershipEvent = ownershipEvents.requireByKey({ key: command.ownershipEventId, leagueId: command.leagueId });
        return Object.freeze({
          contract: freezeRow(receipt.contract), obligation: freezeRow(receipt.obligation),
          years: freezeRows(receipt.years), releasedOwnership: freezeRow(receipt.releasedOwnership),
          contractEvent: freezeRow(contractEvent), ownershipEvent: freezeRow(ownershipEvent),
          activity: freezeRow(existingActivity),
          automaticallyCancelledTradeIds: Object.freeze(receipt.automaticallyCancelledTradeIds),
          annualPenaltyCents: metadata.annualPenaltyCents,
          totalScheduledPenaltyCents: metadata.totalScheduledPenaltyCents,
        });
      }
      const contractRows = contractStatement.all(command);
      const ownershipRows = ownershipStatement.all(command);
      if (contractRows.length > 1 || ownershipRows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "A buyout target is not unique within its league."
        );
      }
      if (!contractRows[0] || !ownershipRows[0]) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.recordNotFound,
          "The buyout contract or ownership does not exist."
        );
      }
      const contractBefore = freezeRow(contractRows[0]);
      const ownershipBefore = freezeRow(ownershipRows[0]);
      const remainingRows = remainingYearsStatement.all(command);
      const aggregate = createBuyoutAggregate({
        command,
        contract: contractBefore,
        ownership: ownershipBefore,
        remainingContractYears: remainingRows.map((year) => ({
          contractYearId: year.id,
          seasonId: year.season_id,
          status: year.status,
        })),
      });

      const automaticallyCancelledTradeIds = [];
      for (const trade of pendingTradesStatement.all(command)) {
        const cancelled = cancellationWriter.cancelPending({
          eventId: cancellationEventId(command.buyoutId, trade.id),
          leagueId: command.leagueId,
          seasonId: trade.season_id,
          tradeId: trade.id,
          expectedVersion: trade.version,
          fromStatus: trade.trade_status,
          reasonCode: "player_bought_out",
          sourceMetadata: {
            buyoutId: command.buyoutId, playerId: command.playerId,
            contractId: command.contractId, ownershipId: command.ownershipId,
          },
          occurredAtMs: command.occurredAtMs,
        });
        if (!cancelled || typeof cancelled.then === "function") {
          throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict,
            "An affected trade could not be cancelled atomically with the buyout.");
        }
        automaticallyCancelledTradeIds.push(trade.id);
      }

      const contract = freezeRow(
        contracts.updateVersioned({
          key: command.contractId,
          leagueId: command.leagueId,
          expectedVersion: command.expectedContractVersion,
          changes: {
            status: "eliminated",
            updated_at_ms: command.occurredAtMs,
          },
        })
      );
      for (let index = 0; index < remainingRows.length; index += 1) {
        const result = eliminateYearStatement.run({
          contractYearId: remainingRows[index].id,
          leagueId: command.leagueId,
          contractId: command.contractId,
          expectedStatus: remainingRows[index].status,
          occurredAtMs: command.occurredAtMs,
        });
        if (result.changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "A remaining contract year changed before buyout."
          );
        }
      }
      const obligation = freezeRow(
        obligations.insert(aggregate.obligation)
      );
      const years = freezeRows(
        aggregate.years.map((year) => buyoutYears.insert(year))
      );
      const contractEvent = freezeRow(
        contractEvents.insert({
          id: command.contractEventId,
          league_id: command.leagueId,
          contract_id: command.contractId,
          player_id: command.playerId,
          team_id: command.teamId,
          actor_user_id: command.actorUserId,
          event_type: "contract_bought_out",
          source_type: "buyout",
          source_id: command.buyoutId,
          metadata_json: JSON.stringify({
            aavCents: contractBefore.aav_cents,
            annualPenaltyCents: aggregate.annualPenaltyCents,
            remainingYears: aggregate.years.length,
            automaticallyCancelledTradeIds,
            priorStatus: contractBefore.status,
            resultingStatus: contract.status,
          }),
          reason: command.reason,
          occurred_at_ms: command.occurredAtMs,
        })
      );
      const ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: command.ownershipEventId,
          league_id: command.leagueId,
          season_id: command.seasonId,
          player_id: command.playerId,
          team_id: command.teamId,
          ownership_id: command.ownershipId,
          event_type: "player_released_by_buyout",
          actor_user_id: command.actorUserId,
          source_type: "buyout",
          source_id: command.buyoutId,
          before_metadata_json: JSON.stringify({
            ownershipKind: ownershipBefore.ownership_kind,
            rosterCategory: ownershipBefore.roster_category,
            version: ownershipBefore.version,
          }),
          after_metadata_json: JSON.stringify({ owned: false }),
          reason: command.reason,
          occurred_at_ms: command.occurredAtMs,
        })
      );
      const activityRow = freezeRow(
        activity.insert({
          id: command.activityId,
          league_id: command.leagueId,
          season_id: command.seasonId,
          event_type: "contract_bought_out",
          actor_user_id: command.actorUserId,
          actor_authority: command.actorAuthority,
          team_id: command.teamId,
          player_id: command.playerId,
          related_type: "buyout_obligation",
          related_id: command.buyoutId,
          display_summary: "Contract bought out; player released.",
          reason: command.reason,
          metadata_json: JSON.stringify({
            contractId: command.contractId,
            ownershipId: command.ownershipId,
            annualPenaltyCents: aggregate.annualPenaltyCents,
            totalScheduledPenaltyCents:
              aggregate.totalScheduledPenaltyCents,
            remainingYears: aggregate.years.length,
            automaticallyCancelledTradeIds,
            buyoutReceipt: {
              commandHash: commandHash(command), contract, obligation, years,
              releasedOwnership: ownershipBefore, automaticallyCancelledTradeIds,
            },
          }),
          occurred_at_ms: command.occurredAtMs,
        })
      );
      const deleted = deleteOwnershipStatement.run(command);
      if (deleted.changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The owned player changed before release."
        );
      }
      candidateCardSummerSynchronizer.synchronize({
        leagueId: command.leagueId,
        affectedTeamIds: [command.teamId],
        affectedPlayerIds: [command.playerId],
        sourceOperationId: command.buyoutId,
        sourceKind: "buyout",
        nowMs: command.occurredAtMs,
      });
      return Object.freeze({
        contract,
        obligation,
        years,
        contractEvent,
        releasedOwnership: ownershipBefore,
        ownershipEvent,
        activity: activityRow,
        automaticallyCancelledTradeIds: Object.freeze(automaticallyCancelledTradeIds),
        annualPenaltyCents: aggregate.annualPenaltyCents,
        totalScheduledPenaltyCents:
          aggregate.totalScheduledPenaltyCents,
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareBuyoutRepository",
      tableName: "buyout_obligations",
    });
  }

  return Object.freeze({
    buyOut(input) {
      const command = validateBuyoutCommand(input);
      try {
        return buyoutTransaction.immediate(command);
      } catch (error) {
        if (error instanceof BuyoutPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "buyOutContract",
          tableName: "buyout_obligations",
        });
      }
    },
  });
}

module.exports = { createSqliteBuyoutRepository };
