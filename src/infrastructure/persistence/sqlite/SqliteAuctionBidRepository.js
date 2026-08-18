const crypto = require("node:crypto");

const {
  AUCTION_BID_CODES,
  AuctionBidPolicyError,
  assertAuctionBidState,
  validateAuctionBidCommand,
} = require("../../../domain/auctions/auctionBidPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const OPERATION = "auction.bid.put";

function freeze(value) {
  return Object.freeze(value);
}

function policyFail(reasonCode) {
  throw new AuctionBidPolicyError(reasonCode);
}

function isFadContext(auction) {
  return ["fad_open_rapid", "fad_restricted"].includes(
    auction?.source_kind
  );
}

function isNominatedOpenRapidBidContext(auction) {
  if (
    auction?.source_kind !== "fad_open_rapid" ||
    !["manager_nomination", "queued_nomination"].includes(
      auction.fad_origin
    ) ||
    auction.fad_allocation_id !== null ||
    auction.fad_started_event_count !== 1 ||
    auction.fad_starter_bid_count !== 1 ||
    !auction.fad_starter_bid_id ||
    !auction.fad_starter_team_id
  ) {
    return false;
  }
  return auction.fad_origin === "manager_nomination"
    ? (
        auction.queued_starter_count === 0 &&
        auction.queued_starter_bid_id === null &&
        auction.queued_starter_team_id === null
      )
    : (
        auction.queued_starter_count === 1 &&
        auction.queued_starter_bid_id ===
          auction.fad_starter_bid_id &&
        auction.queued_starter_team_id ===
          auction.fad_starter_team_id
      );
}

function isSupportedFadBidContext(auction) {
  return isNominatedOpenRapidBidContext(auction) || (
    auction?.source_kind === "fad_restricted" &&
    auction.fad_origin === "candidate_tie_restricted" &&
    auction.allocation_status === "restricted_active" &&
    auction.restricted_auction_id === auction.id
  ) || (
    auction?.source_kind === "fad_open_rapid" &&
    auction.fad_origin ===
      "restricted_no_improvement_fallback" &&
    auction.allocation_status === "restricted_fallback_open" &&
    auction.fallback_open_auction_id === auction.id
  );
}

function isReplayableFadBidContext(auction) {
  return isNominatedOpenRapidBidContext(auction) || (
    auction?.source_kind === "fad_restricted" &&
    auction.fad_origin === "candidate_tie_restricted" &&
    auction.fad_allocation_id !== null &&
    auction.restricted_auction_id === auction.id
  ) || (
    auction?.source_kind === "fad_open_rapid" &&
    auction.fad_origin ===
      "restricted_no_improvement_fallback" &&
    auction.fad_allocation_id !== null &&
    auction.fallback_open_auction_id === auction.id
  );
}

function createRequestHash(command, auction) {
  const payload = {
    leagueId: command.leagueId,
    auctionId: command.auctionId,
    teamId: command.teamId,
    actorUserId: command.actorUserId,
    actorMembershipId: command.actorMembershipId,
    actorAuthority: command.actorAuthority,
    aavCents: command.aavCents,
    termYears: command.termYears,
    expectedBidVersion: command.expectedBidVersion,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
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
  let findParticipant;
  let findCurrentTeamBid;
  let insertIdempotency;
  let insertBid;
  let updateBid;
  let insertEvent;
  let completeBidIdempotency;
  let findResultBid;
  let findReplayEvents;
  let updateParticipant;
  let findParticipantById;
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

  function requireCurrentAuthority(command) {
    const authority = unique(
      findAuthority,
      command,
      "Auction bid authority is not unique."
    );
    if (
      !authority ||
      authority.user_status !== "active" ||
      authority.league_status !== "active" ||
      authority.membership_status !== "active" ||
      authority.membership_permission !== "manager" ||
      !Number.isSafeInteger(authority.membership_joined_at_ms) ||
      authority.membership_joined_at_ms > command.occurredAtMs ||
      authority.membership_ended_at_ms !== null ||
      authority.assignment_status !== "accepted" ||
      !Number.isSafeInteger(authority.assignment_accepted_at_ms) ||
      authority.assignment_accepted_at_ms > command.occurredAtMs ||
      authority.assignment_ended_at_ms !== null ||
      authority.team_id !== command.teamId ||
      authority.team_status !== "active" ||
      command.actorAuthority !== "manager"
    ) {
      policyFail(AUCTION_BID_CODES.authorizationDenied);
    }
    return authority;
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

  function replayMetadata(row, command, idempotency, auction) {
    let metadata;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The replayed auction bid event metadata is invalid."
      );
    }
    const action = command.expectedBidVersion === null
      ? "submitted"
      : "edited";
    const eventType = action === "submitted"
      ? "bid_submitted"
      : "bid_edited";
    const after = metadata?.after;
    const before = metadata?.before;
    if (
      row.auction_id !== command.auctionId ||
      row.season_id !== auction.season_id ||
      row.team_id !== command.teamId ||
      row.event_type !== eventType ||
      metadata?.actorAuthority !== command.actorAuthority ||
      metadata?.actorMembershipId !== command.actorMembershipId ||
      !after ||
      after.totalValueCents !== command.totalValueCents ||
      after.termYears !== command.termYears ||
      after.aavCents !== roundedAav(
        command.totalValueCents,
        command.termYears
      ) ||
      after.version !== (command.expectedBidVersion ?? 0) + 1 ||
      !Number.isSafeInteger(after.lowestOfferedAavCents) ||
      !Number.isSafeInteger(after.editCount) ||
      (action === "submitted" && before !== null) ||
      (
        action === "edited" &&
        before?.version !== command.expectedBidVersion
      ) ||
      !Number.isSafeInteger(row.first_submitted_at_ms) ||
      row.first_submitted_at_ms > idempotency.created_at_ms ||
      idempotency.completed_at_ms !== idempotency.created_at_ms
    ) {
      return null;
    }
    return freeze({
      action,
      after,
      firstSubmittedAtMs: row.first_submitted_at_ms,
    });
  }

  function replayResult(command, idempotency, auction) {
    const matches = findReplayEvents
      .all({
        leagueId: command.leagueId,
        effectiveBidId: idempotency.result_id,
        actorUserId: command.actorUserId,
        occurredAtMs: idempotency.created_at_ms,
      })
      .map((row) => ({
        row,
        metadata: replayMetadata(
          row,
          command,
          idempotency,
          auction
        ),
      }))
      .filter(({ metadata }) => metadata !== null);
    if (matches.length !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The replayed auction bid event is unavailable or ambiguous."
      );
    }
    const { row, metadata } = matches[0];
    return freeze({
      replayed: true,
      action: metadata.action,
      auction: freeze({
        id: auction.id,
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        status: "open",
        openedAtMs: auction.opened_at_ms,
        bidClosesAtMs: auction.resolves_at_ms,
      }),
      bid: freeze({
        id: idempotency.result_id,
        teamId: row.team_id,
        totalValueCents: metadata.after.totalValueCents,
        termYears: metadata.after.termYears,
        aavCents: metadata.after.aavCents,
        firstSubmittedAtMs: metadata.firstSubmittedAtMs,
        lastEditedAtMs: idempotency.created_at_ms,
        editCount: metadata.after.editCount,
        status: "active",
        version: metadata.after.version,
      }),
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
        users.status AS user_status,
        league_memberships.permission_category AS membership_permission,
        league_memberships.status AS membership_status,
        league_memberships.joined_at_ms AS membership_joined_at_ms,
        league_memberships.ended_at_ms AS membership_ended_at_ms,
        teams.id AS team_id,
        teams.status AS team_status,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.accepted_at_ms
          AS assignment_accepted_at_ms,
        team_manager_assignments.ended_at_ms AS assignment_ended_at_ms
      FROM leagues
      JOIN users
        ON users.id = @actorUserId
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
      SELECT
        auctions.*,
        auction_contexts.source_kind,
        auction_contexts.fad_id,
        auction_contexts.fad_rollover_id,
        auction_contexts.fad_allocation_id,
        auction_contexts.fad_origin,
        free_agent_draft_player_allocations.status
          AS allocation_status,
        free_agent_draft_player_allocations.restricted_auction_id,
        free_agent_draft_player_allocations.fallback_open_auction_id,
        free_agent_draft_player_allocations
          .restricted_minimum_total_cents,
        free_agent_draft_player_allocations
          .restricted_minimum_aav_cents,
        (
          SELECT COUNT(*)
          FROM auction_events AS started_event
          WHERE started_event.league_id = auctions.league_id
            AND started_event.season_id = auctions.season_id
            AND started_event.auction_id = auctions.id
            AND started_event.event_type = 'auction_started'
        ) AS fad_started_event_count,
        (
          SELECT COUNT(*)
          FROM auction_events AS started_event
          JOIN auction_bids AS starter_bid
            ON starter_bid.league_id = started_event.league_id
           AND starter_bid.season_id = started_event.season_id
           AND starter_bid.auction_id = started_event.auction_id
           AND starter_bid.id = started_event.bid_id
           AND starter_bid.team_id = started_event.team_id
          WHERE started_event.league_id = auctions.league_id
            AND started_event.season_id = auctions.season_id
            AND started_event.auction_id = auctions.id
            AND started_event.event_type = 'auction_started'
        ) AS fad_starter_bid_count,
        (
          SELECT started_event.bid_id
          FROM auction_events AS started_event
          WHERE started_event.league_id = auctions.league_id
            AND started_event.season_id = auctions.season_id
            AND started_event.auction_id = auctions.id
            AND started_event.event_type = 'auction_started'
            AND started_event.occurred_at_ms = auctions.opened_at_ms
          ORDER BY started_event.id
          LIMIT 1
        ) AS fad_starter_bid_id,
        (
          SELECT started_event.team_id
          FROM auction_events AS started_event
          WHERE started_event.league_id = auctions.league_id
            AND started_event.season_id = auctions.season_id
            AND started_event.auction_id = auctions.id
            AND started_event.event_type = 'auction_started'
            AND started_event.occurred_at_ms = auctions.opened_at_ms
          ORDER BY started_event.id
          LIMIT 1
        ) AS fad_starter_team_id,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_nomination_queue AS queue
          WHERE queue.league_id = auctions.league_id
            AND queue.opened_auction_id = auctions.id
        ) AS queued_starter_count,
        (
          SELECT queue.opened_starter_bid_id
          FROM free_agent_draft_nomination_queue AS queue
          WHERE queue.league_id = auctions.league_id
            AND queue.season_id = auctions.season_id
            AND queue.fad_id = auction_contexts.fad_id
            AND queue.player_id = auctions.player_id
            AND queue.status = 'opened'
            AND queue.opened_auction_id = auctions.id
            AND queue.opened_at_ms = auctions.opened_at_ms
          ORDER BY queue.id
          LIMIT 1
        ) AS queued_starter_bid_id,
        (
          SELECT queue.team_id
          FROM free_agent_draft_nomination_queue AS queue
          WHERE queue.league_id = auctions.league_id
            AND queue.season_id = auctions.season_id
            AND queue.fad_id = auction_contexts.fad_id
            AND queue.player_id = auctions.player_id
            AND queue.status = 'opened'
            AND queue.opened_auction_id = auctions.id
            AND queue.opened_at_ms = auctions.opened_at_ms
          ORDER BY queue.id
          LIMIT 1
        ) AS queued_starter_team_id
      FROM auctions
      JOIN auction_contexts
        ON auction_contexts.league_id = auctions.league_id
       AND auction_contexts.season_id = auctions.season_id
       AND auction_contexts.auction_id = auctions.id
      LEFT JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id =
            auction_contexts.league_id
       AND free_agent_draft_player_allocations.season_id =
            auction_contexts.season_id
       AND free_agent_draft_player_allocations.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_player_allocations.id =
            auction_contexts.fad_allocation_id
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
      LIMIT 2
    `);
    findParticipant = database.prepare(`
      SELECT *
      FROM free_agent_draft_auction_participants
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND team_id = @teamId
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
        lowest_offered_total_value_cents,
        first_submitted_at_ms, last_edited_at_ms, edit_count,
        status, idempotency_request_id, version
      ) VALUES (
        @effectiveBidId, @leagueId, @seasonId, @auctionId, @teamId,
        @actorUserId, @totalValueCents, @termYears,
        @lowestOfferedAavCents,
        @lowestOfferedTotalValueCents,
        @firstSubmittedAtMs, @lastEditedAtMs, @editCount,
        'active', @idempotencyRequestId, @nextVersion
      )
    `);
    updateBid = database.prepare(`
      UPDATE auction_bids
      SET total_value_cents = @totalValueCents,
        term_years = @termYears,
        lowest_offered_aav_cents = @lowestOfferedAavCents,
        lowest_offered_total_value_cents =
          @lowestOfferedTotalValueCents,
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
    completeBidIdempotency = database.prepare(`
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
    findReplayEvents = database.prepare(`
      SELECT
        auction_events.*,
        COALESCE(
          (
            SELECT queue.binding_confirmed_at_ms
            FROM free_agent_draft_nomination_queue AS queue
            WHERE queue.league_id = auction_events.league_id
              AND queue.opened_auction_id = auction_events.auction_id
              AND queue.opened_starter_bid_id = auction_events.bid_id
              AND queue.team_id = auction_events.team_id
              AND queue.status = 'opened'
            ORDER BY queue.id
            LIMIT 1
          ),
          (
            SELECT MIN(submitted_event.occurred_at_ms)
            FROM auction_events AS submitted_event
            WHERE submitted_event.league_id = auction_events.league_id
              AND submitted_event.season_id = auction_events.season_id
              AND submitted_event.auction_id = auction_events.auction_id
              AND submitted_event.bid_id = auction_events.bid_id
              AND submitted_event.team_id = auction_events.team_id
              AND submitted_event.event_type = 'bid_submitted'
          ),
          (
            SELECT MIN(started_event.occurred_at_ms)
            FROM auction_events AS started_event
            WHERE started_event.league_id = auction_events.league_id
              AND started_event.season_id = auction_events.season_id
              AND started_event.auction_id = auction_events.auction_id
              AND started_event.bid_id = auction_events.bid_id
              AND started_event.team_id = auction_events.team_id
              AND started_event.event_type = 'auction_started'
          )
        ) AS first_submitted_at_ms
      FROM auction_events
      WHERE auction_events.league_id = @leagueId
        AND auction_events.bid_id = @effectiveBidId
        AND auction_events.actor_user_id = @actorUserId
        AND auction_events.occurred_at_ms = @occurredAtMs
        AND auction_events.event_type IN (
          'bid_submitted',
          'bid_edited'
        )
      ORDER BY auction_events.id
    `);
    updateParticipant = database.prepare(`
      UPDATE free_agent_draft_auction_participants
      SET active_improvement_bid_id = @effectiveBidId,
        first_improvement_at_ms = COALESCE(
          first_improvement_at_ms,
          @firstSubmittedAtMs
        ),
        current_cooldown_anchor_at_ms = @lastEditedAtMs,
        improvement_committed_at_ms = @lastEditedAtMs,
        updated_at_ms = @lastEditedAtMs,
        version = version + 1
      WHERE id = @participantId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND auction_id = @auctionId
        AND team_id = @teamId
        AND status = 'active'
        AND version = @participantVersion
        AND (
          (
            @action = 'submitted'
            AND active_improvement_bid_id IS NULL
            AND first_improvement_at_ms IS NULL
            AND current_cooldown_anchor_at_ms IS NULL
            AND improvement_committed_at_ms IS NULL
          )
          OR (
            @action = 'edited'
            AND active_improvement_bid_id = @effectiveBidId
            AND first_improvement_at_ms = @firstSubmittedAtMs
            AND current_cooldown_anchor_at_ms =
              @previousCooldownAnchorAtMs
            AND improvement_committed_at_ms =
              @previousCooldownAnchorAtMs
          )
        )
    `);
    findParticipantById = database.prepare(`
      SELECT *
      FROM free_agent_draft_auction_participants
      WHERE league_id = @leagueId
        AND id = @participantId
      LIMIT 2
    `);
    putTransaction = database.transaction((command) => {
      const auction = unique(
        findAuction,
        command,
        "An auction identifier is not unique within its league."
      );
      const requestHash = createRequestHash(command, auction);
      const idempotency = unique(
        findIdempotency,
        command,
        "Auction bid idempotency scope is not unique."
      );
      if (idempotency) {
        if (idempotency.request_hash !== requestHash) {
          policyFail(AUCTION_BID_CODES.idempotencyKeyReused);
        }
        if (
          idempotency.status !== "completed" ||
          !idempotency.result_id
        ) {
          policyFail(AUCTION_BID_CODES.idempotencyConflict);
        }
        if (idempotency.result_type !== "auction_bid" || !auction) {
          policyFail(AUCTION_BID_CODES.idempotencyConflict);
        }
        if (
          isFadContext(auction) &&
          !isReplayableFadBidContext(auction)
        ) {
          policyFail(AUCTION_BID_CODES.auctionUnavailable);
        }
        requireCurrentAuthority(command);
        return replayResult(command, idempotency, auction);
      }

      if (isFadContext(auction) && !isSupportedFadBidContext(auction)) {
        policyFail(AUCTION_BID_CODES.auctionUnavailable);
      }

      const participant = unique(
        findParticipant,
        command,
        "A restricted auction participant identity is not unique."
      );
      const authority = requireCurrentAuthority(command);
      const currentTeamBid = unique(
        findCurrentTeamBid,
        command,
        "A team has multiple current bids in one auction."
      );
      const existingBid = currentTeamBid;
      const state = assertAuctionBidState({
        command,
        authority,
        auction,
        existingBid,
        participant,
      });
      const effectiveBidId = existingBid?.id || command.bidId;
      const persisted = {
        ...command,
        ...state,
        effectiveBidId,
        seasonId: auction.season_id,
        participantId: participant?.id || null,
        participantVersion: participant?.version || null,
        fadId: auction.fad_id,
        allocationId: auction.fad_allocation_id,
        previousCooldownAnchorAtMs:
          existingBid?.last_edited_at_ms ?? null,
      };
      const eventType = state.action === "submitted" ? "bid_submitted" : "bid_edited";
      const metadata = {
        actorAuthority: command.actorAuthority,
        actorMembershipId: command.actorMembershipId,
        before: existingBid
          ? {
              totalValueCents: existingBid.total_value_cents,
              termYears: existingBid.term_years,
              lowestOfferedAavCents: existingBid.lowest_offered_aav_cents,
              lowestOfferedTotalValueCents:
                existingBid.lowest_offered_total_value_cents,
              editCount: existingBid.edit_count,
              version: existingBid.version,
            }
          : null,
        after: {
          totalValueCents: state.totalValueCents,
          termYears: state.termYears,
          aavCents: state.aavCents,
          lowestOfferedAavCents: state.lowestOfferedAavCents,
          lowestOfferedTotalValueCents:
            state.lowestOfferedTotalValueCents,
          editCount: state.editCount,
          version: state.nextVersion,
        },
      };
      const metadataJson = JSON.stringify(metadata);

      insertIdempotency.run({ ...persisted, requestHash });
      if (existingBid) {
        if (updateBid.run(persisted).changes !== 1) {
          policyFail(AUCTION_BID_CODES.versionConflict);
        }
      } else {
        insertBid.run(persisted);
      }
      if (auction.source_kind === "fad_restricted") {
        if (updateParticipant.run(persisted).changes !== 1) {
          policyFail(AUCTION_BID_CODES.versionConflict);
        }
        const linked = unique(
          findParticipantById,
          persisted,
          "A restricted participant identity is not unique."
        );
        if (
          !linked ||
          linked.status !== "active" ||
          linked.active_improvement_bid_id !== effectiveBidId ||
          linked.first_improvement_at_ms !==
            state.firstSubmittedAtMs ||
          linked.current_cooldown_anchor_at_ms !==
            state.lastEditedAtMs ||
          linked.improvement_committed_at_ms !==
            state.lastEditedAtMs ||
          linked.version !== participant.version + 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The restricted participant bid link was not committed."
          );
        }
      }
      insertEvent.run({ ...persisted, eventType, metadataJson });
      const result = safeWriteResult(
        unique(
          findResultBid,
          persisted,
          "An auction bid aggregate is not unique."
        ),
        false,
        state.action
      );
      if (completeBidIdempotency.run(persisted).changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "Auction bid idempotency could not be completed."
        );
      }
      return result;
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
  });
}

module.exports = { createSqliteAuctionBidRepository };
