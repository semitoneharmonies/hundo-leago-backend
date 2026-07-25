const {
  planAuctionContractSeasons,
} = require("../../../domain/auctions/auctionCompletionPolicy");
const {
  buildAuctionResolutionOccurrenceKey,
  evaluateAuctionResolution,
} = require("../../../domain/auctions/auctionResolutionPolicy");
const {
  createNormalContractAggregate,
} = require("../../../domain/contracts/contractPolicy");
const {
  createSocketInvalidation,
} = require("../../../domain/leagues/socketInvalidation");
const {
  createRosterAssignmentRecord,
} = require("../../../domain/rosters/rosterAssignmentPolicy");
const {
  evaluateStructuralRosterLegality,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const JOB_TYPE = "auction.resolve.target";
const AUCTION_BUYOUT_LOCK_MS = 14 * 24 * 60 * 60 * 1000;
const SUCCESS_OUTCOMES = new Set([
  "resolved",
  "no_winner",
  "cancelled",
]);

function freeze(value) {
  return Object.freeze(value);
}

function exactObject(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("|") !== [...keys].sort().join("|")
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Exact auction-resolution repository input is required."
    );
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe UTC timestamp is required."
    );
  }
  return value;
}

function boundedText(value, maximum = 200) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A bounded canonical string is required."
    );
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A positive expected version is required."
    );
  }
  return value;
}

function stableIds(value, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact stable identifier schedule is required."
    );
  }
  const result = value.map(stableId);
  if (new Set(result).size !== result.length) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Stable identifier schedules must not contain duplicates."
    );
  }
  return result;
}

function validateCompletionCommand(input) {
  exactObject(input, [
    "leagueId",
    "auctionId",
    "occurrenceKey",
    "expectedAuctionVersion",
    "nowMs",
    "resolutionId",
    "contractId",
    "contractYearIds",
    "contractEventId",
    "ownershipId",
    "ownershipEventId",
    "auctionEventId",
    "activityId",
    "outboxEventId",
    "futureSeasonIds",
  ]);
  return freeze({
    leagueId: stableId(input.leagueId),
    auctionId: stableId(input.auctionId),
    occurrenceKey: boundedText(input.occurrenceKey),
    expectedAuctionVersion: positiveVersion(
      input.expectedAuctionVersion
    ),
    nowMs: safeTimestamp(input.nowMs),
    resolutionId: stableId(input.resolutionId),
    contractId: stableId(input.contractId),
    contractYearIds: freeze(stableIds(input.contractYearIds, 3)),
    contractEventId: stableId(input.contractEventId),
    ownershipId: stableId(input.ownershipId),
    ownershipEventId: stableId(input.ownershipEventId),
    auctionEventId: stableId(input.auctionEventId),
    activityId: stableId(input.activityId),
    outboxEventId: stableId(input.outboxEventId),
    futureSeasonIds: freeze(stableIds(input.futureSeasonIds, 2)),
  });
}

function completionStatus(row) {
  if (row.status === "resolved") return "resolved";
  if (["no_bids", "no_winner"].includes(row.status)) {
    return "no_winner";
  }
  if (row.status === "cancelled") return "cancelled";
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    "The persisted auction completion status is not successful."
  );
}

function safeCompletionResult(row, replayed) {
  return freeze({
    completed: true,
    replayed,
    status: completionStatus(row),
    resolutionId: row.id,
    auctionId: row.auction_id,
    outcomeCode: row.outcome_code,
    contractId: row.contract_id,
    ownershipId: row.ownership_id,
    generalIllegal: row.general_illegal === 1,
    warnings: freeze(JSON.parse(row.warnings_json).map((value) => freeze(value))),
  });
}

function createSqliteAuctionResolutionRepository({ database } = {}) {
  let seasonsRepository;
  let contractsRepository;
  let contractYearsRepository;
  let contractEventsRepository;
  let ownershipsRepository;
  let ownershipEventsRepository;
  let auctionEventsRepository;
  let resolutionsRepository;
  let activityRepository;
  let outboxRepository;
  let capRepository;
  let listDueStatement;
  let findAuctionStatement;
  let listBidsStatement;
  let findResolutionStatement;
  let listSeasonsStatement;
  let findPositionCorrectionStatement;
  let listSourcePositionsStatement;
  let findReleasedRightsStatement;
  let listOccupiedSlotsStatement;
  let listRosterRowsStatement;
  let listBidHistoryStatement;
  let updateAuctionStatement;
  let updateBidStatusStatement;
  let findHistoricalMembershipStatement;
  let findHistoricalManagerAssignmentStatement;
  let findRunStatement;
  let insertRunStatement;
  let retryRunStatement;
  let succeedRunStatement;
  let failRunStatement;
  let claimTransaction;
  let completeTransaction;

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

  try {
    seasonsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("seasons"),
    });
    contractsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contracts"),
    });
    contractYearsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contract_years"),
    });
    contractEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("contract_events"),
    });
    ownershipsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("player_ownerships"),
    });
    ownershipEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("ownership_events"),
    });
    auctionEventsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("auction_events"),
    });
    resolutionsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("auction_resolutions"),
    });
    activityRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    outboxRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("outbox_events"),
    });
    capRepository = createSqliteCapReadRepository({ database });
    listDueStatement = database.prepare(`
      SELECT
        auctions.id AS auction_id,
        auctions.league_id AS league_id,
        auctions.season_id AS season_id,
        auctions.version AS auction_version,
        auctions.resolves_at_ms AS resolves_at_ms,
        seasons.fantasy_playoffs_start_at_ms AS playoffs_start_at_ms,
        CASE
          WHEN seasons.fantasy_playoffs_start_at_ms IS NOT NULL
            AND seasons.fantasy_playoffs_start_at_ms <= @nowMs
          THEN seasons.fantasy_playoffs_start_at_ms
          ELSE auctions.resolves_at_ms
        END AS due_at_ms
      FROM auctions
      JOIN seasons
        ON seasons.league_id = auctions.league_id
       AND seasons.id = auctions.season_id
      WHERE auctions.status = 'open'
        AND (
          auctions.resolves_at_ms <= @nowMs
          OR (
            seasons.fantasy_playoffs_start_at_ms IS NOT NULL
            AND seasons.fantasy_playoffs_start_at_ms <= @nowMs
          )
        )
      ORDER BY due_at_ms, auctions.league_id, auctions.id
      LIMIT @limit
    `);
    findAuctionStatement = database.prepare(`
      SELECT
        auctions.id AS auction_id,
        auctions.league_id AS league_id,
        auctions.season_id AS season_id,
        auctions.player_id AS player_id,
        auctions.status AS auction_status,
        auctions.resolves_at_ms AS resolves_at_ms,
        auctions.version AS auction_version,
        leagues.current_season_id AS current_season_id,
        seasons.label AS season_label,
        seasons.nhl_season_key AS nhl_season_key,
        seasons.status AS season_status,
        seasons.regular_season_ends_at_ms AS regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms AS playoffs_start_at_ms,
        players.full_name AS player_full_name,
        players.status AS player_status,
        CASE WHEN player_ownerships.id IS NULL THEN 0 ELSE 1 END AS player_owned
      FROM auctions
      JOIN leagues
        ON leagues.id = auctions.league_id
      JOIN seasons
        ON seasons.league_id = auctions.league_id
       AND seasons.id = auctions.season_id
      JOIN players
        ON players.id = auctions.player_id
      LEFT JOIN player_ownerships
        ON player_ownerships.league_id = auctions.league_id
       AND player_ownerships.player_id = auctions.player_id
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
      LIMIT 2
    `);
    listBidsStatement = database.prepare(`
      SELECT
        auction_bids.id AS bid_id,
        auction_bids.league_id AS league_id,
        auction_bids.auction_id AS auction_id,
        auction_bids.team_id AS team_id,
        auction_bids.submitted_by_user_id AS submitted_by_user_id,
        auction_bids.total_value_cents AS total_value_cents,
        auction_bids.term_years AS term_years,
        auction_bids.lowest_offered_aav_cents AS lowest_offered_aav_cents,
        auction_bids.first_submitted_at_ms AS first_submitted_at_ms,
        auction_bids.status AS bid_status,
        teams.status AS team_status,
        auction_events.actor_user_id AS submission_actor_user_id,
        auction_events.event_type AS submission_event_type,
        auction_events.metadata_json AS submission_metadata_json,
        auction_events.occurred_at_ms AS submission_occurred_at_ms
      FROM auction_bids
      LEFT JOIN teams
        ON teams.league_id = auction_bids.league_id
       AND teams.id = auction_bids.team_id
      LEFT JOIN auction_events
        ON auction_events.id = (
          SELECT submission_event.id
          FROM auction_events AS submission_event
          WHERE submission_event.league_id = auction_bids.league_id
            AND submission_event.auction_id = auction_bids.auction_id
            AND submission_event.bid_id = auction_bids.id
            AND submission_event.event_type IN (
              'auction_started',
              'bid_submitted'
            )
          ORDER BY submission_event.occurred_at_ms, submission_event.id
          LIMIT 1
        )
      WHERE auction_bids.league_id = @leagueId
        AND auction_bids.auction_id = @auctionId
      ORDER BY auction_bids.id
    `);
    findResolutionStatement = database.prepare(`
      SELECT *
      FROM auction_resolutions
      WHERE league_id = @leagueId
        AND (
          auction_id = @auctionId
          OR scheduled_occurrence_key = @occurrenceKey
        )
      ORDER BY id
      LIMIT 3
    `);
    listSeasonsStatement = database.prepare(`
      SELECT id, label, nhl_season_key, status
      FROM seasons
      WHERE league_id = @leagueId
      ORDER BY nhl_season_key, id
    `);
    findPositionCorrectionStatement = database.prepare(`
      SELECT position_group
      FROM league_player_positions
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND ended_at_ms IS NULL
      LIMIT 2
    `);
    listSourcePositionsStatement = database.prepare(`
      SELECT DISTINCT normalized_position AS position_group
      FROM player_source_state
      WHERE player_id = @playerId
        AND ended_at_ms IS NULL
        AND active = 1
        AND normalized_position IN ('F', 'D')
      ORDER BY normalized_position
    `);
    findReleasedRightsStatement = database.prepare(`
      SELECT 1 AS excluded
      FROM ownership_events
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND event_type IN (
          'fantasy_elc_declined',
          'unsigned_prospect_rights_released'
        )
      LIMIT 1
    `);
    listOccupiedSlotsStatement = database.prepare(`
      SELECT slot_number
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND ownership_kind = 'Rostered'
        AND roster_category = 'Active'
        AND position_group = @positionGroup
        AND slot_number IS NOT NULL
      ORDER BY slot_number
    `);
    listRosterRowsStatement = database.prepare(`
      SELECT
        ownership.league_id,
        ownership.season_id,
        ownership.team_id,
        ownership.player_id,
        ownership.roster_category,
        ownership.position_group,
        COALESCE(
          (
            SELECT correction.position_group
            FROM league_player_positions AS correction
            WHERE correction.league_id = ownership.league_id
              AND correction.player_id = ownership.player_id
              AND correction.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT CASE
              WHEN COUNT(DISTINCT source.normalized_position) = 1
              THEN MAX(source.normalized_position)
              ELSE NULL
            END
            FROM player_source_state AS source
            WHERE source.player_id = ownership.player_id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position IN ('F', 'D')
          )
        ) AS effective_position
      FROM player_ownerships AS ownership
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY ownership.player_id
    `);
    listBidHistoryStatement = database.prepare(`
      SELECT
        bid_id,
        team_id,
        event_type,
        metadata_json,
        occurred_at_ms
      FROM auction_events
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND bid_id IS NOT NULL
        AND event_type IN (
          'auction_started',
          'bid_submitted',
          'bid_edited'
        )
      ORDER BY occurred_at_ms, id
    `);
    updateAuctionStatement = database.prepare(`
      UPDATE auctions
      SET status = @status,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @auctionId
        AND status = 'open'
        AND version = @expectedAuctionVersion
    `);
    updateBidStatusStatement = database.prepare(`
      UPDATE auction_bids
      SET status = @status,
        version = version + 1
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @bidId
        AND status = 'active'
    `);
    findHistoricalMembershipStatement = database.prepare(`
      SELECT
        id,
        permission_category,
        joined_at_ms,
        ended_at_ms
      FROM league_memberships
      WHERE league_id = @leagueId
        AND id = @actorMembershipId
        AND user_id = @actorUserId
        AND status IN ('active', 'ended', 'suspended')
        AND joined_at_ms IS NOT NULL
        AND joined_at_ms <= @occurredAtMs
        AND (ended_at_ms IS NULL OR ended_at_ms > @occurredAtMs)
      LIMIT 2
    `);
    findHistoricalManagerAssignmentStatement = database.prepare(`
      SELECT id
      FROM team_manager_assignments
      WHERE league_id = @leagueId
        AND team_id = @teamId
        AND user_id = @actorUserId
        AND membership_id = @actorMembershipId
        AND status IN ('accepted', 'ended')
        AND accepted_at_ms IS NOT NULL
        AND accepted_at_ms <= @occurredAtMs
        AND (ended_at_ms IS NULL OR ended_at_ms > @occurredAtMs)
      LIMIT 2
    `);
    findRunStatement = database.prepare(`
      SELECT * FROM job_runs
      WHERE league_id = @leagueId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    insertRunStatement = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count,
        lease_owner, lease_expires_at_ms,
        started_at_ms, completed_at_ms, result_json, last_error_code,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @jobRunId, @leagueId, @seasonId, '${JOB_TYPE}', @occurrenceKey,
        @scheduledForMs, 'leased', 1,
        @leaseOwner, @leaseExpiresAtMs,
        @nowMs, NULL, NULL, NULL,
        @nowMs, @nowMs, 1
      )
    `);
    retryRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'leased',
        attempt_count = attempt_count + 1,
        lease_owner = @leaseOwner,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @nowMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND version = @expectedVersion
    `);
    succeedRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
        lease_owner = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = @resultJson,
        last_error_code = NULL,
        updated_at_ms = @completedAtMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND status = 'leased'
        AND lease_owner = @leaseOwner
        AND version = @expectedVersion
    `);
    failRunStatement = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
        lease_owner = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = NULL,
        last_error_code = @errorCode,
        updated_at_ms = @completedAtMs,
        version = version + 1
      WHERE id = @runId
        AND league_id = @leagueId
        AND status = 'leased'
        AND lease_owner = @leaseOwner
        AND version = @expectedVersion
    `);

    claimTransaction = database.transaction((command) => {
      const existing = unique(
        findRunStatement,
        command,
        "An auction resolution job occurrence is not unique."
      );
      if (!existing) {
        insertRunStatement.run(command);
        return freeze({
          acquired: true,
          runId: command.jobRunId,
          version: 1,
          attemptCount: 1,
        });
      }
      if (existing.status === "succeeded") {
        return freeze({
          acquired: false,
          reason: "succeeded",
          runId: existing.id,
          version: existing.version,
          attemptCount: existing.attempt_count,
        });
      }
      if (
        ["leased", "running"].includes(existing.status) &&
        existing.lease_expires_at_ms !== null &&
        existing.lease_expires_at_ms > command.nowMs
      ) {
        return freeze({
          acquired: false,
          reason: "leased",
          runId: existing.id,
          version: existing.version,
          attemptCount: existing.attempt_count,
        });
      }
      if (
        retryRunStatement.run({
          ...command,
          runId: existing.id,
          expectedVersion: existing.version,
        }).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The auction resolution job lease changed concurrently."
        );
      }
      return freeze({
        acquired: true,
        runId: existing.id,
        version: existing.version + 1,
        attemptCount: existing.attempt_count + 1,
      });
    });
    completeTransaction = database.transaction((command) =>
      completeAtomic(command)
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareAuctionResolutionRepository",
      tableName: "job_runs",
    });
  }

  function historicalAuthority(row) {
    if (
      !row.submission_actor_user_id ||
      row.submission_actor_user_id !== row.submitted_by_user_id ||
      row.submission_occurred_at_ms !== row.first_submitted_at_ms ||
      typeof row.submission_metadata_json !== "string"
    ) {
      return false;
    }
    let metadata;
    try {
      metadata = JSON.parse(row.submission_metadata_json);
    } catch {
      return false;
    }
    if (
      !metadata ||
      !["manager", "commissioner"].includes(metadata.actorAuthority) ||
      !UUID_PATTERN.test(metadata.actorMembershipId || "")
    ) {
      return false;
    }
    const parameters = {
      leagueId: row.league_id,
      teamId: row.team_id,
      actorUserId: row.submission_actor_user_id,
      actorMembershipId: metadata.actorMembershipId,
      occurredAtMs: row.submission_occurred_at_ms,
    };
    const membership = unique(
      findHistoricalMembershipStatement,
      parameters,
      "Historical bid membership is not unique."
    );
    if (
      !membership ||
      membership.permission_category !== metadata.actorAuthority
    ) {
      return false;
    }
    if (metadata.actorAuthority === "commissioner") return true;
    return Boolean(
      unique(
        findHistoricalManagerAssignmentStatement,
        parameters,
        "Historical bid manager authority is not unique."
      )
    );
  }

  function loadCandidateData(parameters) {
    const auction = unique(
      findAuctionStatement,
      parameters,
      "An auction resolution candidate is not unique."
    );
    if (!auction) return null;
    const bidRows = listBidsStatement.all(parameters);
    const bids = bidRows.map((row) =>
      freeze({
        id: row.bid_id,
        leagueId: row.league_id,
        auctionId: row.auction_id,
        teamId: row.team_id,
        status: row.bid_status,
        teamStatus: row.team_status,
        totalValueCents: row.total_value_cents,
        termYears: row.term_years,
        lowestOfferedAavCents: row.lowest_offered_aav_cents,
        firstSubmittedAtMs: row.first_submitted_at_ms,
        isStartingBid: row.submission_event_type === "auction_started",
        authorityValid: historicalAuthority(row),
      })
    );
    const playerParameters = {
      leagueId: auction.league_id,
      playerId: auction.player_id,
    };
    const correction = unique(
      findPositionCorrectionStatement,
      playerParameters,
      "A league player has multiple current position corrections."
    );
    const sourcePositions = listSourcePositionsStatement.all(
      playerParameters
    );
    const effectivePosition = correction?.position_group ||
      (sourcePositions.length === 1
        ? sourcePositions[0].position_group
        : null);
    return freeze({
      auction: freeze({
        id: auction.auction_id,
        leagueId: auction.league_id,
        playerId: auction.player_id,
        status: auction.auction_status,
        resolvesAtMs: auction.resolves_at_ms,
        playoffsStartAtMs: auction.playoffs_start_at_ms,
        playerOwned: auction.player_owned === 1,
        nowMs: parameters.nowMs,
      }),
      auctionVersion: auction.auction_version,
      seasonId: auction.season_id,
      currentSeasonId: auction.current_season_id,
      currentSeason: freeze({
        id: auction.season_id,
        label: auction.season_label,
        nhlSeasonKey: auction.nhl_season_key,
        status: auction.season_status,
      }),
      regularSeasonEndsAtMs: auction.regular_season_ends_at_ms,
      playerFullName: auction.player_full_name,
      playerStatus: auction.player_status,
      playerReleasedRights: Boolean(
        findReleasedRightsStatement.get(playerParameters)
      ),
      effectivePosition,
      bids: freeze(bids),
    });
  }

  function decideCompletion(candidate) {
    const decision = evaluateAuctionResolution({
      auction: candidate.auction,
      bids: candidate.bids,
    });
    if (decision.outcome === "not_due") return decision;
    const base = {
      auctionId: decision.auctionId,
      leagueId: decision.leagueId,
      dueAtMs: decision.dueAtMs,
      skippedBids: freeze([]),
    };
    if (
      decision.outcome === "cancelled_season_closed" ||
      candidate.currentSeasonId !== candidate.seasonId ||
      candidate.currentSeason.status !== "active" ||
      (candidate.regularSeasonEndsAtMs !== null &&
        candidate.auction.nowMs >= candidate.regularSeasonEndsAtMs)
    ) {
      return freeze({
        ...base,
        outcome: "cancelled_season_closed",
      });
    }
    if (
      decision.outcome === "cancelled_unavailable" ||
      candidate.playerStatus !== "active" ||
      candidate.playerReleasedRights ||
      !["F", "D"].includes(candidate.effectivePosition)
    ) {
      return freeze({ ...base, outcome: "cancelled_unavailable" });
    }
    return decision;
  }

  function updateAuction(command, status) {
    if (
      updateAuctionStatement.run({ ...command, status }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The auction changed before atomic completion."
      );
    }
  }

  function updateBids(command, candidate, decision) {
    const eligible = new Set(
      (decision.rankedBids || []).map(({ bidId }) => bidId)
    );
    for (const bid of candidate.bids) {
      if (bid.status !== "active") continue;
      let status;
      if (decision.outcome === "winner") {
        status = bid.id === decision.winner.bidId
          ? "won"
          : eligible.has(bid.id)
            ? "lost"
            : "invalid";
      } else if (decision.outcome === "no_winner") {
        status = "invalid";
      } else {
        status = "cancelled";
      }
      if (
        updateBidStatusStatement.run({
          ...command,
          bidId: bid.id,
          status,
        }).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "An auction bid changed before atomic completion."
        );
      }
    }
  }

  function nextAvailableSlot(command, candidate, teamId) {
    const maximum = candidate.effectivePosition === "F" ? 12 : 6;
    const occupied = new Set(
      listOccupiedSlotsStatement
        .all({
          ...command,
          seasonId: candidate.seasonId,
          teamId,
          positionGroup: candidate.effectivePosition,
        })
        .map(({ slot_number: value }) => value)
    );
    for (let slot = 1; slot <= maximum; slot += 1) {
      if (!occupied.has(slot)) return slot;
    }
    return null;
  }

  function evaluateWinnerLegality(command, candidate, teamId) {
    const rows = listRosterRowsStatement.all({
      ...command,
      seasonId: candidate.seasonId,
      teamId,
    });
    const structural = evaluateStructuralRosterLegality({
      leagueId: command.leagueId,
      seasonId: candidate.seasonId,
      teamId,
      assignments: rows.map((row) => ({
        leagueId: row.league_id,
        seasonId: row.season_id,
        teamId: row.team_id,
        playerId: row.player_id,
        rosterCategory: row.roster_category,
        assignedPositionGroup: row.position_group,
      })),
      effectivePositions: rows.map((row) => ({
        playerId: row.player_id,
        positionGroup: row.effective_position,
      })),
    });
    const cap = capRepository.calculate({
      leagueId: command.leagueId,
      seasonId: candidate.seasonId,
      teamId,
    });
    const warnings = [
      ...structural.reasons.map((reason) => ({ ...reason, teamId })),
      ...cap.issues.map((issue) => ({ ...issue, teamId })),
      ...(cap.overCap ? [{ code: "TEAM_OVER_CAP", teamId }] : []),
    ];
    return freeze({
      generalIllegal: warnings.length > 0,
      warnings: freeze(warnings.map((warning) => freeze(warning))),
    });
  }

  function eligibleBidHistory(command, decision) {
    const eligible = new Set(
      decision.rankedBids.map(({ bidId }) => bidId)
    );
    return listBidHistoryStatement
      .all(command)
      .filter(({ bid_id: bidId }) => eligible.has(bidId))
      .map((row) => {
        let metadata = null;
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = null;
        }
        const values = row.event_type === "auction_started"
          ? metadata
          : metadata?.after;
        return freeze({
          bidId: row.bid_id,
          teamId: row.team_id,
          eventType: row.event_type,
          totalValueCents: values?.totalValueCents ?? null,
          termYears: values?.termYears ?? null,
          aavCents: values?.aavCents ?? null,
          editCount: values?.editCount ?? 0,
          occurredAtMs: row.occurred_at_ms,
        });
      });
  }

  function insertOutbox(command, auctionVersion) {
    const payload = createSocketInvalidation({
      eventType: "auction.updated",
      scope: "league",
      scopeId: command.leagueId,
      version: auctionVersion,
      changedAtMs: command.nowMs,
    });
    return outboxRepository.insert({
      id: command.outboxEventId,
      league_id: command.leagueId,
      event_type: "auction.updated",
      aggregate_type: "auction",
      aggregate_id: command.auctionId,
      payload_json: JSON.stringify(payload),
      status: "pending",
      attempt_count: 0,
      available_at_ms: command.nowMs,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: command.nowMs,
      updated_at_ms: command.nowMs,
      version: 1,
    });
  }

  function persistWinner(command, candidate, decision) {
    const seasonPlan = planAuctionContractSeasons({
      leagueId: command.leagueId,
      currentSeason: candidate.currentSeason,
      existingSeasons: listSeasonsStatement.all(command).map((row) => ({
        id: row.id,
        label: row.label,
        nhlSeasonKey: row.nhl_season_key,
        status: row.status,
      })),
      futureSeasonIds: command.futureSeasonIds,
      termYears: decision.winner.submittedTermYears,
      nowMs: command.nowMs,
    });
    for (const planned of seasonPlan.seasonsToCreate) {
      seasonsRepository.insert({
        id: planned.id,
        league_id: planned.leagueId,
        label: planned.label,
        nhl_season_key: planned.nhlSeasonKey,
        status: planned.status,
        regular_season_starts_at_ms: null,
        regular_season_ends_at_ms: null,
        fantasy_playoffs_start_at_ms: null,
        fantasy_playoffs_end_at_ms: null,
        free_agent_draft_completed_at_ms: null,
        created_at_ms: planned.createdAtMs,
        updated_at_ms: planned.updatedAtMs,
        version: 1,
      });
    }
    const contract = createNormalContractAggregate({
      contractId: command.contractId,
      contractYearIds: command.contractYearIds.slice(
        0,
        decision.winner.submittedTermYears
      ),
      contractEventId: command.contractEventId,
      leagueId: command.leagueId,
      playerId: candidate.auction.playerId,
      teamId: decision.winner.teamId,
      originalTotalValueCents: decision.winner.finalTotalValueCents,
      termYears: decision.winner.submittedTermYears,
      startSeasonId: candidate.seasonId,
      seasonIds: seasonPlan.seasonIds,
      acquisitionSourceType: "auction_resolution",
      acquisitionSourceId: command.resolutionId,
      auctionBuyoutLockExpiresAtMs:
        command.nowMs + AUCTION_BUYOUT_LOCK_MS,
      actorUserId: null,
      occurredAtMs: command.nowMs,
    });
    contractsRepository.insert(contract.contract);
    for (const year of contract.years) {
      contractYearsRepository.insert(year);
    }
    contractEventsRepository.insert(contract.event);

    const slotNumber = nextAvailableSlot(
      command,
      candidate,
      decision.winner.teamId
    );
    const ownership = createRosterAssignmentRecord({
      id: command.ownershipId,
      leagueId: command.leagueId,
      seasonId: candidate.seasonId,
      playerId: candidate.auction.playerId,
      teamId: decision.winner.teamId,
      ownershipKind: "Rostered",
      rosterCategory: "Active",
      positionGroup: candidate.effectivePosition,
      slotNumber,
      acquiredTransactionType: "auction_resolution",
      acquiredTransactionId: command.resolutionId,
      createdAtMs: command.nowMs,
      updatedAtMs: command.nowMs,
    });
    ownershipsRepository.insert(ownership);
    ownershipEventsRepository.insert({
      id: command.ownershipEventId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      player_id: candidate.auction.playerId,
      team_id: decision.winner.teamId,
      ownership_id: command.ownershipId,
      event_type: "auction_player_acquired",
      actor_user_id: null,
      source_type: "auction_resolution",
      source_id: command.resolutionId,
      before_metadata_json: null,
      after_metadata_json: JSON.stringify({
        ownershipKind: "Rostered",
        rosterCategory: "Active",
        positionGroup: candidate.effectivePosition,
        slotNumber,
      }),
      reason: null,
      occurred_at_ms: command.nowMs,
    });

    const legality = evaluateWinnerLegality(
      command,
      candidate,
      decision.winner.teamId
    );
    updateBids(command, candidate, decision);
    updateAuction(command, "resolved");
    auctionEventsRepository.insert({
      id: command.auctionEventId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      auction_id: command.auctionId,
      bid_id: decision.winner.bidId,
      team_id: decision.winner.teamId,
      actor_user_id: null,
      event_type: "auction_resolved",
      metadata_json: JSON.stringify({
        resolutionId: command.resolutionId,
        outcome: "winner",
        winner: decision.winner,
        skippedBids: decision.skippedBids,
        generalIllegal: legality.generalIllegal,
        warnings: legality.warnings,
      }),
      occurred_at_ms: command.nowMs,
    });
    const resolution = resolutionsRepository.insert({
      id: command.resolutionId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      auction_id: command.auctionId,
      scheduled_occurrence_key: command.occurrenceKey,
      outcome_code: "winner",
      winning_team_id: decision.winner.teamId,
      winning_bid_id: decision.winner.bidId,
      highest_bid_cents: decision.winner.submittedTotalValueCents,
      second_price_input_cents:
        decision.winner.highestCompetingAavCents,
      final_contract_value_cents:
        decision.winner.finalTotalValueCents,
      winning_term_years: decision.winner.submittedTermYears,
      final_aav_cents: decision.winner.finalAavCents,
      general_illegal: legality.generalIllegal ? 1 : 0,
      warnings_json: JSON.stringify(legality.warnings),
      contract_id: command.contractId,
      ownership_id: command.ownershipId,
      trigger_type: "automatic",
      triggered_by_user_id: null,
      idempotency_key: command.occurrenceKey,
      status: "resolved",
      resolved_at_ms: command.nowMs,
    });
    const bidHistory = eligibleBidHistory(command, decision);
    activityRepository.insert({
      id: command.activityId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      event_type: "auction_signing_completed",
      actor_user_id: null,
      actor_authority: "system",
      team_id: decision.winner.teamId,
      player_id: candidate.auction.playerId,
      related_type: "auction_resolution",
      related_id: command.resolutionId,
      display_summary:
        `${candidate.playerFullName} signed through auction.`,
      reason: null,
      metadata_json: JSON.stringify({
        auctionId: command.auctionId,
        resolutionId: command.resolutionId,
        playerId: candidate.auction.playerId,
        playerDisplayName: candidate.playerFullName,
        teamId: decision.winner.teamId,
        bidId: decision.winner.bidId,
        contractId: command.contractId,
        ownershipId: command.ownershipId,
        submittedWinningTotalValueCents:
          decision.winner.submittedTotalValueCents,
        submittedWinningTermYears:
          decision.winner.submittedTermYears,
        submittedWinningAavCents:
          decision.winner.submittedAavCents,
        finalTotalValueCents: decision.winner.finalTotalValueCents,
        finalAavCents: decision.winner.finalAavCents,
        contractTermYears: decision.winner.submittedTermYears,
        remainingYears: decision.winner.submittedTermYears,
        assignmentCategory: "Active",
        assignmentPositionGroup: candidate.effectivePosition,
        assignmentSlotNumber: slotNumber,
        generalIllegal: legality.generalIllegal,
        rankedBids: decision.rankedBids,
        bidHistory,
      }),
      occurred_at_ms: command.nowMs,
    });
    insertOutbox(command, command.expectedAuctionVersion + 1);
    return safeCompletionResult(resolution, false);
  }

  function persistWithoutWinner(command, candidate, decision) {
    const cancelled = decision.outcome !== "no_winner";
    const auctionStatus = cancelled ? "cancelled" : "no_winner";
    const outcomeCode = decision.outcome === "cancelled_season_closed"
      ? "season_closed"
      : decision.outcome === "cancelled_unavailable"
        ? "player_unavailable"
        : "no_winner";
    updateBids(command, candidate, decision);
    updateAuction(command, auctionStatus);
    auctionEventsRepository.insert({
      id: command.auctionEventId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      auction_id: command.auctionId,
      bid_id: null,
      team_id: null,
      actor_user_id: null,
      event_type: cancelled ? "auction_cancelled" : "auction_no_winner",
      metadata_json: JSON.stringify({
        resolutionId: command.resolutionId,
        outcome: outcomeCode,
        skippedBids: decision.skippedBids,
      }),
      occurred_at_ms: command.nowMs,
    });
    const resolution = resolutionsRepository.insert({
      id: command.resolutionId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      auction_id: command.auctionId,
      scheduled_occurrence_key: command.occurrenceKey,
      outcome_code: outcomeCode,
      winning_team_id: null,
      winning_bid_id: null,
      highest_bid_cents: null,
      second_price_input_cents: null,
      final_contract_value_cents: null,
      winning_term_years: null,
      final_aav_cents: null,
      general_illegal: 0,
      warnings_json: "[]",
      contract_id: null,
      ownership_id: null,
      trigger_type: "automatic",
      triggered_by_user_id: null,
      idempotency_key: command.occurrenceKey,
      status: cancelled ? "cancelled" : "no_winner",
      resolved_at_ms: command.nowMs,
    });
    activityRepository.insert({
      id: command.activityId,
      league_id: command.leagueId,
      season_id: candidate.seasonId,
      event_type: cancelled
        ? "auction_cancelled"
        : "auction_completed_without_winner",
      actor_user_id: null,
      actor_authority: "system",
      team_id: null,
      player_id: candidate.auction.playerId,
      related_type: "auction_resolution",
      related_id: command.resolutionId,
      display_summary: cancelled
        ? `${candidate.playerFullName}'s auction was cancelled.`
        : `${candidate.playerFullName}'s auction ended without a winner.`,
      reason: cancelled ? outcomeCode : null,
      metadata_json: JSON.stringify({
        schemaVersion: 1,
        auctionId: command.auctionId,
        resolutionId: command.resolutionId,
        playerId: candidate.auction.playerId,
        playerDisplayName: candidate.playerFullName,
        outcome: outcomeCode,
      }),
      occurred_at_ms: command.nowMs,
    });
    insertOutbox(command, command.expectedAuctionVersion + 1);
    return safeCompletionResult(resolution, false);
  }

  function completeAtomic(command) {
    const existingRows = findResolutionStatement.all(command);
    if (existingRows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "Auction completion replay identities are inconsistent."
      );
    }
    if (existingRows[0]) {
      if (
        existingRows[0].auction_id !== command.auctionId ||
        existingRows[0].scheduled_occurrence_key !== command.occurrenceKey
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "Auction completion replay identity conflicts."
        );
      }
      return safeCompletionResult(existingRows[0], true);
    }

    const candidate = loadCandidateData(command);
    if (!candidate) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The auction completion candidate does not exist."
      );
    }
    if (candidate.auctionVersion !== command.expectedAuctionVersion) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The auction completion version is stale."
      );
    }
    const decision = decideCompletion(candidate);
    if (decision.outcome === "not_due") {
      return freeze({
        completed: false,
        replayed: false,
        status: "not_due",
        reason: decision.reason,
      });
    }
    const expectedOccurrenceKey = buildAuctionResolutionOccurrenceKey({
      auctionId: command.auctionId,
      dueAtMs: decision.dueAtMs,
    });
    if (expectedOccurrenceKey !== command.occurrenceKey) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "The auction completion occurrence does not match the due boundary."
      );
    }
    return decision.outcome === "winner"
      ? persistWinner(command, candidate, decision)
      : persistWithoutWinner(command, candidate, decision);
  }

  return freeze({
    listDue({ nowMs, limit } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "Auction resolution batch size must be between one and 100."
        );
      }
      try {
        return freeze(
          listDueStatement.all({ nowMs: safeTimestamp(nowMs), limit }).map(
            (row) =>
              freeze({
                auctionId: row.auction_id,
                leagueId: row.league_id,
                seasonId: row.season_id,
                auctionVersion: row.auction_version,
                resolvesAtMs: row.resolves_at_ms,
                playoffsStartAtMs: row.playoffs_start_at_ms,
                dueAtMs: row.due_at_ms,
              })
          )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listDueAuctionResolutions",
          tableName: "auctions",
        });
      }
    },

    loadCandidate(input) {
      exactObject(input, ["auctionId", "leagueId", "nowMs"]);
      const parameters = {
        auctionId: stableId(input.auctionId),
        leagueId: stableId(input.leagueId),
        nowMs: safeTimestamp(input.nowMs),
      };
      try {
        const candidate = loadCandidateData(parameters);
        if (!candidate) return null;
        return freeze({
          auction: candidate.auction,
          auctionVersion: candidate.auctionVersion,
          seasonId: candidate.seasonId,
          bids: candidate.bids,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "loadAuctionResolutionCandidate",
          tableName: "auctions",
        });
      }
    },

    completeDue(input) {
      const command = validateCompletionCommand(input);
      try {
        return completeTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "completeDueAuctionResolution",
          tableName: "auction_resolutions",
        });
      }
    },

    claimRun(input) {
      exactObject(input, [
        "jobRunId",
        "leagueId",
        "seasonId",
        "occurrenceKey",
        "scheduledForMs",
        "leaseOwner",
        "nowMs",
        "leaseExpiresAtMs",
      ]);
      const command = {
        jobRunId: stableId(input.jobRunId),
        leagueId: stableId(input.leagueId),
        seasonId: stableId(input.seasonId),
        occurrenceKey: boundedText(input.occurrenceKey),
        scheduledForMs: safeTimestamp(input.scheduledForMs),
        leaseOwner: boundedText(input.leaseOwner, 128),
        nowMs: safeTimestamp(input.nowMs),
        leaseExpiresAtMs: safeTimestamp(input.leaseExpiresAtMs),
      };
      if (command.leaseExpiresAtMs <= command.nowMs) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The auction resolution lease must expire after it starts."
        );
      }
      try {
        return claimTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "claimAuctionResolutionRun",
          tableName: "job_runs",
        });
      }
    },

    succeedRun(input) {
      exactObject(input, [
        "leagueId",
        "runId",
        "leaseOwner",
        "expectedVersion",
        "completedAtMs",
        "auctionId",
        "outcome",
      ]);
      if (!SUCCESS_OUTCOMES.has(input.outcome)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A completed auction resolution outcome is required."
        );
      }
      const command = {
        leagueId: stableId(input.leagueId),
        runId: stableId(input.runId),
        leaseOwner: boundedText(input.leaseOwner, 128),
        expectedVersion: positiveVersion(input.expectedVersion),
        completedAtMs: safeTimestamp(input.completedAtMs),
        resultJson: JSON.stringify({
          auctionId: stableId(input.auctionId),
          outcome: input.outcome,
        }),
      };
      try {
        if (succeedRunStatement.run(command).changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The auction resolution job lease is stale."
          );
        }
        return freeze({
          runId: command.runId,
          status: "succeeded",
          version: command.expectedVersion + 1,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "succeedAuctionResolutionRun",
          tableName: "job_runs",
        });
      }
    },

    failRun(input) {
      exactObject(input, [
        "leagueId",
        "runId",
        "leaseOwner",
        "expectedVersion",
        "completedAtMs",
        "errorCode",
      ]);
      const command = {
        leagueId: stableId(input.leagueId),
        runId: stableId(input.runId),
        leaseOwner: boundedText(input.leaseOwner, 128),
        expectedVersion: positiveVersion(input.expectedVersion),
        completedAtMs: safeTimestamp(input.completedAtMs),
        errorCode: boundedText(input.errorCode, 100),
      };
      try {
        if (failRunStatement.run(command).changes !== 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The auction resolution job lease is stale."
          );
        }
        return freeze({
          runId: command.runId,
          status: "failed",
          version: command.expectedVersion + 1,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "failAuctionResolutionRun",
          tableName: "job_runs",
        });
      }
    },
  });
}

module.exports = {
  JOB_TYPE,
  createSqliteAuctionResolutionRepository,
};
