const crypto = require("node:crypto");

const {
  AUCTION_BID_CODES,
  AuctionBidPolicyError,
  COOLDOWN_MS,
  assertAuctionBidState,
  validateAuctionBidCommand,
} = require("../../../domain/auctions/auctionBidPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const OPERATION = "auction.bid.put";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function freeze(value) {
  return Object.freeze(value);
}

function policyFail(reasonCode) {
  throw new AuctionBidPolicyError(reasonCode);
}

function canonicalReadInput(input, { detail = false } = {}) {
  const keys = detail
    ? ["auctionId", "leagueId", "viewerMembershipId", "viewerUserId"]
    : ["leagueId", "viewerMembershipId", "viewerUserId"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("|") !== keys.sort().join("|") ||
    keys.some((key) => !UUID_PATTERN.test(input[key] || ""))
  ) {
    policyFail(AUCTION_BID_CODES.inputInvalid);
  }
  return freeze({ ...input });
}

function createRequestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        auctionId: command.auctionId,
        teamId: command.teamId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
        totalValueCents: command.totalValueCents,
        termYears: command.termYears,
        expectedBidVersion: command.expectedBidVersion,
      }),
      "utf8"
    )
    .digest("hex");
}

function roundedAav(totalValueCents, termYears) {
  const whole = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return whole + (remainder * 2 >= termYears ? 1 : 0);
}

function createSqliteAuctionBidRepository({ database } = {}) {
  let findIdempotency;
  let findAuthority;
  let findAuction;
  let findCurrentTeamBid;
  let findBidById;
  let insertIdempotency;
  let insertBid;
  let updateBid;
  let insertEvent;
  let completeIdempotency;
  let findResultBid;
  let findReadAuthority;
  let listManagedTeams;
  let listOpenAuctions;
  let findOpenAuction;
  let listParticipants;
  let putTransaction;

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

  function safeWriteResult(row, replayed, eventType = null) {
    if (!row) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The auction bid aggregate is unavailable."
      );
    }
    return freeze({
      replayed,
      action: eventType ||
        (row.bid_version === 1 && row.edit_count === 0
          ? "submitted"
          : "edited"),
      auction: freeze({
        id: row.auction_id,
        leagueId: row.league_id,
        seasonId: row.season_id,
        status: row.auction_status,
        openedAtMs: row.opened_at_ms,
        bidClosesAtMs: row.resolves_at_ms,
      }),
      bid: freeze({
        id: row.bid_id,
        teamId: row.team_id,
        totalValueCents: row.total_value_cents,
        termYears: row.term_years,
        aavCents: roundedAav(row.total_value_cents, row.term_years),
        firstSubmittedAtMs: row.first_submitted_at_ms,
        lastEditedAtMs: row.last_edited_at_ms,
        editCount: row.edit_count,
        status: row.bid_status,
        version: row.bid_version,
      }),
    });
  }

  function requireReadAuthority(input) {
    const authority = unique(
      findReadAuthority,
      input,
      "Auction read membership is not unique."
    );
    if (
      !authority ||
      authority.league_status === "deleted" ||
      authority.membership_status !== "active"
    ) {
      policyFail(AUCTION_BID_CODES.authorizationDenied);
    }
    return authority;
  }

  function projectAuction(row, participants, managedTeamIds) {
    const ownRow = participants.find(({ team_id: teamId }) =>
      managedTeamIds.has(teamId)
    );
    const ownBidIsStarter = ownRow
      ? ownRow.first_submitted_at_ms === row.opened_at_ms
      : false;
    const ownBidManagerEditLimit = ownBidIsStarter ? 2 : 1;
    return freeze({
      id: row.auction_id,
      leagueId: row.league_id,
      seasonId: row.season_id,
      player: freeze({
        id: row.player_id,
        fullName: row.player_full_name,
        positionGroup: row.position_group,
      }),
      status: row.auction_status === "open" ? "Active" : row.auction_status,
      openedAtMs: row.opened_at_ms,
      bidClosesAtMs: row.resolves_at_ms,
      participantCount: participants.length,
      participants: freeze(
        participants.map((participant) =>
          freeze({
            teamId: participant.team_id,
            teamName: participant.team_name,
          })
        )
      ),
      ownBid: ownRow
        ? freeze({
            id: ownRow.bid_id,
            teamId: ownRow.team_id,
            totalValueCents: ownRow.total_value_cents,
            termYears: ownRow.term_years,
            aavCents: roundedAav(
              ownRow.total_value_cents,
              ownRow.term_years
            ),
            firstSubmittedAtMs: ownRow.first_submitted_at_ms,
            lastEditedAtMs: ownRow.last_edited_at_ms,
            editCount: ownRow.edit_count,
            remainingManagerEdits: Math.max(
              0,
              ownBidManagerEditLimit - ownRow.edit_count
            ),
            cooldownEndsAtMs: ownRow.last_edited_at_ms + COOLDOWN_MS,
            version: ownRow.bid_version,
          })
        : null,
    });
  }

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
        leagues.commissioner_membership_id AS commissioner_membership_id,
        league_memberships.permission_category AS membership_permission,
        league_memberships.status AS membership_status,
        teams.id AS team_id,
        teams.status AS team_status,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.ended_at_ms AS assignment_ended_at_ms
      FROM leagues
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
    findAuction = database.prepare(`
      SELECT * FROM auctions
      WHERE league_id = @leagueId
        AND id = @auctionId
      LIMIT 2
    `);
    findCurrentTeamBid = database.prepare(`
      SELECT * FROM auction_bids
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND team_id = @teamId
        AND status = 'active'
      LIMIT 2
    `);
    findBidById = database.prepare(`
      SELECT * FROM auction_bids
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @bidId
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
    insertBid = database.prepare(`
      INSERT INTO auction_bids (
        id, league_id, season_id, auction_id, team_id,
        submitted_by_user_id, total_value_cents, term_years,
        lowest_offered_aav_cents,
        first_submitted_at_ms, last_edited_at_ms, edit_count,
        status, idempotency_request_id, version
      ) VALUES (
        @effectiveBidId, @leagueId, @seasonId, @auctionId, @teamId,
        @actorUserId, @totalValueCents, @termYears,
        @lowestOfferedAavCents,
        @firstSubmittedAtMs, @lastEditedAtMs, @editCount,
        'active', @idempotencyRequestId, @nextVersion
      )
    `);
    updateBid = database.prepare(`
      UPDATE auction_bids
      SET total_value_cents = @totalValueCents,
        term_years = @termYears,
        lowest_offered_aav_cents = @lowestOfferedAavCents,
        last_edited_at_ms = @lastEditedAtMs,
        edit_count = @editCount,
        idempotency_request_id = @idempotencyRequestId,
        version = @nextVersion
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @effectiveBidId
        AND team_id = @teamId
        AND status = 'active'
        AND version = @expectedBidVersion
    `);
    insertEvent = database.prepare(`
      INSERT INTO auction_events (
        id, league_id, season_id, auction_id, bid_id, team_id,
        actor_user_id, event_type, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @auctionId, @effectiveBidId,
        @teamId, @actorUserId, @eventType, @metadataJson, @occurredAtMs
      )
    `);
    completeIdempotency = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'auction_bid',
        result_id = @effectiveBidId, completed_at_ms = @occurredAtMs
      WHERE id = @idempotencyRequestId
        AND league_id = @leagueId
        AND status = 'started'
    `);
    findResultBid = database.prepare(`
      SELECT
        auctions.id AS auction_id,
        auctions.league_id AS league_id,
        auctions.season_id AS season_id,
        auctions.status AS auction_status,
        auctions.opened_at_ms AS opened_at_ms,
        auctions.resolves_at_ms AS resolves_at_ms,
        auction_bids.id AS bid_id,
        auction_bids.team_id AS team_id,
        auction_bids.total_value_cents AS total_value_cents,
        auction_bids.term_years AS term_years,
        auction_bids.first_submitted_at_ms AS first_submitted_at_ms,
        auction_bids.last_edited_at_ms AS last_edited_at_ms,
        auction_bids.edit_count AS edit_count,
        auction_bids.status AS bid_status,
        auction_bids.version AS bid_version
      FROM auction_bids
      JOIN auctions
        ON auctions.league_id = auction_bids.league_id
       AND auctions.id = auction_bids.auction_id
      WHERE auction_bids.league_id = @leagueId
        AND auction_bids.id = @effectiveBidId
      LIMIT 2
    `);
    findReadAuthority = database.prepare(`
      SELECT
        leagues.status AS league_status,
        league_memberships.status AS membership_status,
        league_memberships.permission_category AS membership_permission
      FROM leagues
      JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = @viewerMembershipId
       AND league_memberships.user_id = @viewerUserId
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    listManagedTeams = database.prepare(`
      SELECT team_manager_assignments.team_id AS team_id
      FROM team_manager_assignments
      JOIN teams
        ON teams.league_id = team_manager_assignments.league_id
       AND teams.id = team_manager_assignments.team_id
      WHERE team_manager_assignments.league_id = @leagueId
        AND team_manager_assignments.user_id = @viewerUserId
        AND team_manager_assignments.membership_id = @viewerMembershipId
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.accepted_at_ms IS NOT NULL
        AND team_manager_assignments.ended_at_ms IS NULL
        AND teams.status = 'active'
      ORDER BY team_manager_assignments.team_id
    `);
    const auctionProjectionSql = `
      SELECT
        auctions.id AS auction_id,
        auctions.league_id AS league_id,
        auctions.season_id AS season_id,
        auctions.player_id AS player_id,
        auctions.status AS auction_status,
        auctions.opened_at_ms AS opened_at_ms,
        auctions.resolves_at_ms AS resolves_at_ms,
        players.full_name AS player_full_name,
        COALESCE(
          (
            SELECT league_player_positions.position_group
            FROM league_player_positions
            WHERE league_player_positions.league_id = auctions.league_id
              AND league_player_positions.player_id = auctions.player_id
              AND league_player_positions.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT CASE
              WHEN COUNT(DISTINCT player_source_state.normalized_position) = 1
              THEN MAX(player_source_state.normalized_position)
              ELSE NULL
            END
            FROM player_source_state
            WHERE player_source_state.player_id = auctions.player_id
              AND player_source_state.ended_at_ms IS NULL
              AND player_source_state.active = 1
              AND player_source_state.normalized_position IN ('F', 'D')
          )
        ) AS position_group
      FROM auctions
      JOIN players ON players.id = auctions.player_id
    `;
    listOpenAuctions = database.prepare(`
      ${auctionProjectionSql}
      WHERE auctions.league_id = @leagueId
        AND auctions.status = 'open'
      ORDER BY auctions.resolves_at_ms, auctions.id
    `);
    findOpenAuction = database.prepare(`
      ${auctionProjectionSql}
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
        AND auctions.status = 'open'
      LIMIT 2
    `);
    listParticipants = database.prepare(`
      SELECT
        auction_bids.id AS bid_id,
        auction_bids.team_id AS team_id,
        teams.name AS team_name,
        auction_bids.total_value_cents AS total_value_cents,
        auction_bids.term_years AS term_years,
        auction_bids.first_submitted_at_ms AS first_submitted_at_ms,
        auction_bids.last_edited_at_ms AS last_edited_at_ms,
        auction_bids.edit_count AS edit_count,
        auction_bids.version AS bid_version
      FROM auction_bids
      JOIN teams
        ON teams.league_id = auction_bids.league_id
       AND teams.id = auction_bids.team_id
      WHERE auction_bids.league_id = @leagueId
        AND auction_bids.auction_id = @auctionId
        AND auction_bids.status = 'active'
      ORDER BY auction_bids.first_submitted_at_ms, auction_bids.id
    `);

    putTransaction = database.transaction((command) => {
      const requestHash = createRequestHash(command);
      const idempotency = unique(
        findIdempotency,
        command,
        "Auction bid idempotency scope is not unique."
      );
      if (idempotency) {
        if (
          idempotency.request_hash !== requestHash ||
          idempotency.status !== "completed" ||
          idempotency.result_type !== "auction_bid" ||
          !idempotency.result_id
        ) {
          policyFail(AUCTION_BID_CODES.idempotencyConflict);
        }
        return safeWriteResult(
          unique(
            findResultBid,
            {
              leagueId: command.leagueId,
              effectiveBidId: idempotency.result_id,
            },
            "An idempotent auction bid aggregate is not unique."
          ),
          true
        );
      }

      const auction = unique(
        findAuction,
        command,
        "An auction identifier is not unique within its league."
      );
      const authority = unique(
        findAuthority,
        command,
        "Auction bid authority is not unique."
      );
      const currentTeamBid = unique(
        findCurrentTeamBid,
        command,
        "A team has multiple current bids in one auction."
      );
      let existingBid = currentTeamBid;
      if (command.actorAuthority === "commissioner") {
        const targetBid = unique(
          findBidById,
          command,
          "A commissioner bid target is not unique."
        );
        if (
          (targetBid && targetBid.team_id !== command.teamId) ||
          (targetBid && currentTeamBid && targetBid.id !== currentTeamBid.id) ||
          (!targetBid && currentTeamBid)
        ) {
          policyFail(AUCTION_BID_CODES.bidConflict);
        }
        existingBid = targetBid;
      }
      const state = assertAuctionBidState({
        command,
        authority,
        auction,
        existingBid,
      });
      const effectiveBidId = existingBid?.id || command.bidId;
      const persisted = {
        ...command,
        ...state,
        effectiveBidId,
        seasonId: auction.season_id,
      };
      const eventType = state.action === "submitted" ? "bid_submitted" : "bid_edited";
      const metadataJson = JSON.stringify({
        actorAuthority: command.actorAuthority,
        actorMembershipId: command.actorMembershipId,
        before: existingBid
          ? {
              totalValueCents: existingBid.total_value_cents,
              termYears: existingBid.term_years,
              lowestOfferedAavCents: existingBid.lowest_offered_aav_cents,
              editCount: existingBid.edit_count,
              version: existingBid.version,
            }
          : null,
        after: {
          totalValueCents: state.totalValueCents,
          termYears: state.termYears,
          aavCents: state.aavCents,
          lowestOfferedAavCents: state.lowestOfferedAavCents,
          editCount: state.editCount,
          version: state.nextVersion,
        },
      });

      insertIdempotency.run({ ...persisted, requestHash });
      if (existingBid) {
        if (updateBid.run(persisted).changes !== 1) {
          policyFail(AUCTION_BID_CODES.versionConflict);
        }
      } else {
        insertBid.run(persisted);
      }
      insertEvent.run({ ...persisted, eventType, metadataJson });
      if (completeIdempotency.run(persisted).changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "Auction bid idempotency could not be completed."
        );
      }
      return safeWriteResult(
        unique(
          findResultBid,
          persisted,
          "An auction bid aggregate is not unique."
        ),
        false,
        state.action
      );
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareAuctionBidRepository",
      tableName: "auction_bids",
    });
  }

  return freeze({
    putBid(input) {
      const command = validateAuctionBidCommand(input);
      try {
        return putTransaction.immediate(command);
      } catch (error) {
        if (error instanceof AuctionBidPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "putAuctionBid",
          tableName: "auction_bids",
        });
      }
    },

    listActive(input) {
      const canonical = canonicalReadInput(input);
      try {
        const authority = requireReadAuthority(canonical);
        const managedTeamIds =
          authority.membership_permission === "manager"
            ? new Set(
                listManagedTeams
                  .all(canonical)
                  .map(({ team_id: teamId }) => teamId)
              )
            : new Set();
        return freeze(
          listOpenAuctions.all(canonical).map((row) =>
            projectAuction(
              row,
              listParticipants.all({
                leagueId: canonical.leagueId,
                auctionId: row.auction_id,
              }),
              managedTeamIds
            )
          )
        );
      } catch (error) {
        if (error instanceof AuctionBidPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "listActiveAuctions",
          tableName: "auctions",
        });
      }
    },

    readActive(input) {
      const canonical = canonicalReadInput(input, { detail: true });
      try {
        const authority = requireReadAuthority(canonical);
        const row = unique(
          findOpenAuction,
          canonical,
          "An active auction detail is not unique."
        );
        if (!row) return null;
        const managedTeamIds =
          authority.membership_permission === "manager"
            ? new Set(
                listManagedTeams
                  .all(canonical)
                  .map(({ team_id: teamId }) => teamId)
              )
            : new Set();
        return projectAuction(
          row,
          listParticipants.all(canonical),
          managedTeamIds
        );
      } catch (error) {
        if (error instanceof AuctionBidPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "readActiveAuction",
          tableName: "auctions",
        });
      }
    },
  });
}

module.exports = { createSqliteAuctionBidRepository };
