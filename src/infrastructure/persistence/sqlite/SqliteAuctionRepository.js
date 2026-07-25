const crypto = require("node:crypto");

const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
  assertAuctionStartState,
  getAuctionCreationWindow,
  validateAuctionCreationCommand,
} = require("../../../domain/auctions/auctionCreationPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const OPERATION = "auction.start";

function createAuctionRequestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        teamId: command.teamId,
        playerId: command.playerId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
        totalValueCents: command.totalValueCents,
        termYears: command.termYears,
      }),
      "utf8"
    )
    .digest("hex");
}

function freeze(value) {
  return Object.freeze(value);
}

function policyFail(reasonCode) {
  throw new AuctionCreationPolicyError(reasonCode);
}

function createSqliteAuctionRepository({ database } = {}) {
  let findIdempotency;
  let findAuthority;
  let findPlayer;
  let findPositionCorrection;
  let listSourcePositions;
  let findOwnership;
  let findReleasedRights;
  let findActiveAuction;
  let insertIdempotency;
  let insertAuction;
  let insertBid;
  let insertEvent;
  let completeIdempotency;
  let findAggregate;
  let startTransaction;

  try {
    findIdempotency = database.prepare(`
      SELECT * FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = '${OPERATION}'
        AND client_key = @idempotencyKey
      LIMIT 2
    `);
    findAuthority = database.prepare(`
      SELECT
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        leagues.current_season_id AS current_season_id,
        seasons.status AS season_status,
        seasons.regular_season_starts_at_ms AS regular_season_starts_at_ms,
        seasons.regular_season_ends_at_ms AS regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms AS fantasy_playoffs_start_at_ms,
        seasons.free_agent_draft_completed_at_ms AS free_agent_draft_completed_at_ms,
        teams.status AS team_status,
        league_memberships.permission_category AS membership_permission,
        league_memberships.status AS membership_status,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.ended_at_ms AS assignment_ended_at_ms
      FROM leagues
      JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = @seasonId
      JOIN teams
        ON teams.league_id = leagues.id
       AND teams.id = @teamId
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = @actorMembershipId
       AND league_memberships.user_id = @actorUserId
      LEFT JOIN team_manager_assignments
        ON team_manager_assignments.league_id = leagues.id
       AND team_manager_assignments.team_id = teams.id
       AND team_manager_assignments.user_id = @actorUserId
       AND team_manager_assignments.membership_id = @actorMembershipId
       AND team_manager_assignments.status = 'accepted'
       AND team_manager_assignments.accepted_at_ms IS NOT NULL
       AND team_manager_assignments.ended_at_ms IS NULL
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findPlayer = database.prepare(`
      SELECT id, status AS player_status
      FROM players
      WHERE id = @playerId
      LIMIT 2
    `);
    findPositionCorrection = database.prepare(`
      SELECT position_group
      FROM league_player_positions
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND ended_at_ms IS NULL
      LIMIT 2
    `);
    listSourcePositions = database.prepare(`
      SELECT DISTINCT normalized_position AS position_group
      FROM player_source_state
      WHERE player_id = @playerId
        AND ended_at_ms IS NULL
        AND active = 1
        AND normalized_position IN ('F', 'D')
      ORDER BY normalized_position
    `);
    findOwnership = database.prepare(`
      SELECT id AS ownership_id
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND player_id = @playerId
      LIMIT 2
    `);
    findReleasedRights = database.prepare(`
      SELECT 1 AS released_rights_excluded
      FROM ownership_events
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND event_type IN (
          'fantasy_elc_declined',
          'unsigned_prospect_rights_released'
        )
      LIMIT 1
    `);
    findActiveAuction = database.prepare(`
      SELECT id AS active_auction_id
      FROM auctions
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND status IN ('open', 'resolving')
      LIMIT 2
    `);
    insertIdempotency = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId, @actorUserId, '${OPERATION}',
        @idempotencyKey, @requestHash, 'started', NULL, NULL,
        @occurredAtMs, NULL, @idempotencyExpiresAtMs
      )
    `);
    insertAuction = database.prepare(`
      INSERT INTO auctions (
        id, league_id, season_id, player_id, status,
        opened_at_ms, resolves_at_ms, opened_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @auctionId, @leagueId, @seasonId, @playerId, 'open',
        @occurredAtMs, @bidClosesAtMs, @actorUserId,
        @occurredAtMs, @occurredAtMs, 1
      )
    `);
    insertBid = database.prepare(`
      INSERT INTO auction_bids (
        id, league_id, season_id, auction_id, team_id,
        submitted_by_user_id, total_value_cents, term_years,
        lowest_offered_aav_cents,
        first_submitted_at_ms, last_edited_at_ms, edit_count,
        status, idempotency_request_id, version
      ) VALUES (
        @bidId, @leagueId, @seasonId, @auctionId, @teamId,
        @actorUserId, @totalValueCents, @termYears,
        @aavCents,
        @occurredAtMs, @occurredAtMs, 0,
        'active', @idempotencyRequestId, 1
      )
    `);
    insertEvent = database.prepare(`
      INSERT INTO auction_events (
        id, league_id, season_id, auction_id, bid_id, team_id,
        actor_user_id, event_type, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @auctionId, @bidId, @teamId,
        @actorUserId, 'auction_started', @metadataJson, @occurredAtMs
      )
    `);
    completeIdempotency = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'auction',
        result_id = @auctionId, completed_at_ms = @occurredAtMs
      WHERE id = @idempotencyRequestId
        AND league_id = @leagueId
        AND status = 'started'
    `);
    findAggregate = database.prepare(`
      SELECT
        auctions.id AS auction_id,
        auctions.league_id AS league_id,
        auctions.season_id AS season_id,
        auctions.player_id AS player_id,
        auctions.status AS auction_status,
        auctions.opened_at_ms AS opened_at_ms,
        auctions.resolves_at_ms AS resolves_at_ms,
        auctions.opened_by_user_id AS opened_by_user_id,
        auctions.version AS auction_version,
        auction_bids.id AS bid_id,
        auction_bids.team_id AS team_id,
        auction_bids.submitted_by_user_id AS submitted_by_user_id,
        auction_bids.total_value_cents AS total_value_cents,
        auction_bids.term_years AS term_years,
        auction_bids.lowest_offered_aav_cents AS lowest_offered_aav_cents,
        auction_bids.first_submitted_at_ms AS first_submitted_at_ms,
        auction_bids.last_edited_at_ms AS last_edited_at_ms,
        auction_bids.edit_count AS edit_count,
        auction_bids.status AS bid_status,
        auction_bids.version AS bid_version,
        auction_events.id AS event_id,
        auction_events.occurred_at_ms AS event_occurred_at_ms
      FROM auctions
      JOIN auction_bids
        ON auction_bids.league_id = auctions.league_id
       AND auction_bids.auction_id = auctions.id
       AND auction_bids.first_submitted_at_ms = auctions.opened_at_ms
      JOIN auction_events
        ON auction_events.league_id = auctions.league_id
       AND auction_events.auction_id = auctions.id
       AND auction_events.bid_id = auction_bids.id
       AND auction_events.event_type = 'auction_started'
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
      LIMIT 2
    `);

    function unique(statement, parameters, message) {
      const rows = statement.all(parameters);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          message
        );
      }
      return rows[0] || null;
    }

    function safeAggregate(row, replayed) {
      if (!row) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The auction creation aggregate is unavailable."
        );
      }
      return freeze({
        replayed,
        auction: freeze({
          id: row.auction_id,
          leagueId: row.league_id,
          seasonId: row.season_id,
          playerId: row.player_id,
          status: row.auction_status === "open" ? "Active" : row.auction_status,
          openedAtMs: row.opened_at_ms,
          bidClosesAtMs: row.resolves_at_ms,
          scheduledResolutionAtMs: row.resolves_at_ms,
          openedByUserId: row.opened_by_user_id,
          version: row.auction_version,
        }),
        openingBid: freeze({
          id: row.bid_id,
          teamId: row.team_id,
          submittedByUserId: row.submitted_by_user_id,
          totalValueCents: row.total_value_cents,
          termYears: row.term_years,
          aavCents: Math.floor(row.total_value_cents / row.term_years) +
            ((row.total_value_cents % row.term_years) * 2 >= row.term_years ? 1 : 0),
          firstSubmittedAtMs: row.first_submitted_at_ms,
          lastEditedAtMs: row.last_edited_at_ms,
          editCount: row.edit_count,
          status: row.bid_status,
          version: row.bid_version,
        }),
        event: freeze({
          id: row.event_id,
          type: "auction_started",
          occurredAtMs: row.event_occurred_at_ms,
        }),
      });
    }

    startTransaction = database.transaction((command) => {
      const requestHash = createAuctionRequestHash(command);
      const idempotency = unique(
        findIdempotency,
        command,
        "Auction creation idempotency scope is not unique."
      );
      if (idempotency) {
        if (
          idempotency.request_hash !== requestHash ||
          idempotency.status !== "completed" ||
          idempotency.result_type !== "auction" ||
          !idempotency.result_id
        ) {
          policyFail(AUCTION_CREATION_CODES.idempotencyConflict);
        }
        return safeAggregate(
          unique(
            findAggregate,
            { leagueId: command.leagueId, auctionId: idempotency.result_id },
            "An auction creation aggregate is not unique."
          ),
          true
        );
      }

      const authority = unique(
        findAuthority,
        command,
        "Auction creation authority is not unique."
      );
      const window = getAuctionCreationWindow({
        nowMs: command.occurredAtMs,
        timeZone: authority?.league_timezone || "America/Vancouver",
      });
      const basePlayer = unique(
        findPlayer,
        command,
        "A stable player record is not unique."
      );
      const correction = unique(
        findPositionCorrection,
        command,
        "A league player has multiple current position corrections."
      );
      const sourcePositions = listSourcePositions.all(command);
      const positionGroup = correction?.position_group ||
        (sourcePositions.length === 1 ? sourcePositions[0].position_group : null);
      const ownership = unique(
        findOwnership,
        command,
        "A player has multiple current league ownerships."
      );
      const activeAuction = unique(
        findActiveAuction,
        command,
        "A player has multiple active league auctions."
      );
      const player = basePlayer
        ? {
            ...basePlayer,
            position_group: positionGroup,
            ownership_id: ownership?.ownership_id || null,
            released_rights_excluded:
              findReleasedRights.get(command)?.released_rights_excluded || 0,
            active_auction_id: activeAuction?.active_auction_id || null,
          }
        : null;
      assertAuctionStartState({ command, authority, player, window });

      insertIdempotency.run({ ...command, requestHash });
      insertAuction.run({ ...command, bidClosesAtMs: window.bidClosesAtMs });
      insertBid.run(command);
      insertEvent.run({
        ...command,
        metadataJson: JSON.stringify({
          openingTeamId: command.teamId,
          actorMembershipId: command.actorMembershipId,
          actorAuthority: command.actorAuthority,
          playerPosition: positionGroup,
          newAuctionCutoffAtMs: window.newAuctionCutoffAtMs,
          bidClosesAtMs: window.bidClosesAtMs,
          totalValueCents: command.totalValueCents,
          termYears: command.termYears,
          aavCents: command.aavCents,
        }),
      });
      if (completeIdempotency.run(command).changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "Auction creation idempotency could not be completed."
        );
      }
      return safeAggregate(
        unique(
          findAggregate,
          command,
          "An auction creation aggregate is not unique."
        ),
        false
      );
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareAuctionRepository",
      tableName: "auctions",
    });
  }

  return freeze({
    startAuction(input) {
      const command = validateAuctionCreationCommand(input);
      try {
        return startTransaction.immediate(command);
      } catch (error) {
        if (error instanceof AuctionCreationPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "startAuction",
          tableName: "auctions",
        });
      }
    },
  });
}

module.exports = { createSqliteAuctionRepository };
