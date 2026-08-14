"use strict";

const {
  CandidateAllocationPolicyError,
  decideCandidateAllocation,
} = require(
  "../../../domain/freeAgentDraft/candidateAllocationPolicy"
);
const {
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  compareFreeAgentDraftCorrectionDecisions,
  createFreeAgentDraftCorrectionPreview,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  deriveFreeAgentDraftCorrectionResourceId,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionResourceIdentityPolicy"
);
const {
  normalizeCandidateEligiblePlayerName,
} = require(
  "../../../domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  createSqliteFreeAgentDraftReadRepository,
} = require("./SqliteFreeAgentDraftReadRepository");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INPUT_FIELDS = Object.freeze([
  "actorAuthority",
  "actorMembershipId",
  "actorUserId",
  "allocationId",
  "fadId",
  "leagueId",
  "mode",
]);
const ACTOR_AUTHORITIES = Object.freeze([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const WINNER_STATUSES = Object.freeze([
  "automatic_award",
  "restricted_resolved",
  "fallback_open_resolved",
]);
const RESTRICTED_STATUSES = Object.freeze([
  "restricted_scheduled",
  "restricted_active",
  "restricted_fallback_open",
  "restricted_resolved",
  "fallback_open_resolved",
]);
const FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied:
      "FAD_CORRECTION_AUTHORIZATION_DENIED",
    notApplicable: "FAD_CORRECTION_NOT_APPLICABLE",
  });

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function denied() {
  throw repositoryError(
    FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES
      .authorizationDenied,
    "Current commissioner authority is required to preview a FAD allocation correction."
  );
}

function notFound() {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    "The scoped FAD allocation was not found."
  );
}

function notApplicable() {
  throw repositoryError(
    FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES
      .notApplicable,
    "The FAD allocation is not in a correctable state."
  );
}

function exactObject(value, fields, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    invalid(message);
  }
}

function stableId(value, message) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(message);
  }
  return value;
}

function normalizeInput(input) {
  exactObject(
    input,
    INPUT_FIELDS,
    "An exact FAD allocation-correction preview input is required."
  );
  if (
    !ACTOR_AUTHORITIES.includes(input.actorAuthority) ||
    input.mode !== FREE_AGENT_DRAFT_CORRECTION_MODE
  ) {
    invalid(
      "A canonical FAD allocation-correction preview mode and authority are required."
    );
  }
  return Object.freeze({
    actorAuthority: input.actorAuthority,
    actorMembershipId: stableId(
      input.actorMembershipId,
      "A canonical actor membership is required."
    ),
    actorUserId: stableId(
      input.actorUserId,
      "A canonical actor user is required."
    ),
    allocationId: stableId(
      input.allocationId,
      "A canonical allocation identity is required."
    ),
    fadId: stableId(
      input.fadId,
      "A canonical FAD identity is required."
    ),
    leagueId: stableId(
      input.leagueId,
      "A canonical league identity is required."
    ),
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
  });
}

function unique(rows, description) {
  if (rows.length > 1) {
    incompatible(`${description} is ambiguous.`);
  }
  return rows[0] || null;
}

function teamProjection(row) {
  return Object.freeze({
    teamId: row.team_id,
    name: row.team_name,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate: row.pattern_template,
    logoReference: row.logo_reference,
  });
}

function slotKey(group, number) {
  const value = `${group}${String(number).padStart(2, "0")}`;
  if (
    !/^(?:F(?:0[1-9]|1[0-2])|D0[1-6]|B0[1-4])$/u.test(
      value
    )
  ) {
    incompatible(
      "A locked Candidate offer has an invalid slot identity."
    );
  }
  return value;
}

function afterSummary(overrides = {}) {
  return Object.freeze({
    status: null,
    team: null,
    player: null,
    contractId: null,
    ownershipId: null,
    auctionId: null,
    totalValueCents: null,
    termYears: null,
    aavCents: null,
    rosterCategory: null,
    ...overrides,
  });
}

function diagnostic(code, message, resourceId = null) {
  return Object.freeze({ code, message, resourceId });
}

function sortDiagnostics(values) {
  return Object.freeze(
    values.sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        String(left.resourceId || "").localeCompare(
          String(right.resourceId || "")
        ) ||
        left.message.localeCompare(right.message)
    )
  );
}

function createSqliteFreeAgentDraftCorrectionPreviewRepository({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftCorrectionPreviewRepository requires an opened database"
    );
  }

  let authorityStatement;
  let allocationStatement;
  let offersStatement;
  let recoveriesStatement;
  let auctionsStatement;
  let participantsStatement;
  let contractsStatement;
  let contractYearsStatement;
  let contractEventsStatement;
  let ownershipsStatement;
  let ownershipEventsStatement;
  let rosterDisplayStatement;
  let tradesStatement;
  let buyoutsStatement;
  let retentionsStatement;
  let playerAuctionsStatement;
  let occupiedSlotStatement;
  let contractIdentityStatement;
  let ownershipIdentityStatement;

  try {
    authorityStatement = database.prepare(`
      SELECT
        league.status AS league_status,
        league.commissioner_membership_id,
        user.status AS user_status,
        membership.status AS membership_status,
        membership.permission_category,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles AS role
          WHERE role.user_id = @actorUserId
            AND role.role = 'platform_administrator'
            AND role.status = 'active'
            AND role.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM leagues AS league
      JOIN users AS user
        ON user.id = @actorUserId
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = @actorMembershipId
       AND membership.user_id = @actorUserId
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.ended_at_ms IS NULL
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    allocationStatement = database.prepare(`
      SELECT
        allocation.*,
        fad.status AS fad_status,
        fad.deadline_locked_at_ms,
        player.full_name AS player_full_name,
        player.status AS player_status
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN players AS player
        ON player.id = allocation.player_id
      WHERE allocation.league_id = @leagueId
        AND allocation.fad_id = @fadId
        AND allocation.id = @allocationId
      LIMIT 2
    `);
    offersStatement = database.prepare(`
      SELECT
        offer.*,
        snapshot.completeness_code AS card_completeness_code,
        snapshot.locked_card_version,
        snapshot.processed_at_ms,
        team.name AS team_name,
        team.name_normalized AS team_name_normalized,
        team.status AS team_status,
        team.primary_colour,
        team.secondary_colour,
        team.tertiary_colour,
        team.pattern_template,
        team.logo_reference,
        event.offer_valid,
        event.rank_position,
        event.offer_outcome_code
      FROM candidate_card_snapshot_entries AS offer
      JOIN candidate_card_snapshots AS snapshot
        ON snapshot.league_id = offer.league_id
       AND snapshot.season_id = offer.season_id
       AND snapshot.fad_id = offer.fad_id
       AND snapshot.id = offer.snapshot_id
       AND snapshot.card_id = offer.card_id
       AND snapshot.team_id = offer.team_id
      JOIN teams AS team
        ON team.league_id = offer.league_id
       AND team.id = offer.team_id
      LEFT JOIN free_agent_draft_allocation_events AS event
        ON event.league_id = offer.league_id
       AND event.season_id = offer.season_id
       AND event.fad_id = offer.fad_id
       AND event.allocation_id = @allocationId
       AND event.allocation_version = @allocationVersion
       AND event.event_kind = 'offer_considered'
       AND event.snapshot_entry_id = offer.id
      WHERE offer.league_id = @leagueId
        AND offer.season_id = @seasonId
        AND offer.fad_id = @fadId
        AND offer.player_id = @playerId
        AND offer.occupant_kind = 'candidate'
        AND offer.proposed_total_value_cents IS NOT NULL
        AND offer.proposed_term_years IS NOT NULL
        AND offer.proposed_aav_cents IS NOT NULL
      ORDER BY offer.id
    `);
    recoveriesStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
      ORDER BY updated_at_ms DESC, id DESC
    `);
    auctionsStatement = database.prepare(`
      SELECT
        auction.*,
        context.source_kind,
        context.fad_origin,
        context.fad_rollover_id,
        resolution.id AS resolution_id,
        resolution.status AS resolution_status,
        resolution.outcome_code,
        resolution.winning_bid_id,
        resolution.contract_id AS resolution_contract_id,
        resolution.ownership_id AS resolution_ownership_id,
        (SELECT COUNT(*) FROM auction_bids AS bid
          WHERE bid.league_id = auction.league_id
            AND bid.auction_id = auction.id) AS bid_count,
        (SELECT COUNT(*) FROM auction_events AS event
          WHERE event.league_id = auction.league_id
            AND event.auction_id = auction.id) AS event_count,
        (SELECT COUNT(*) FROM free_agent_draft_draws AS draw
          WHERE draw.league_id = auction.league_id
            AND draw.auction_id = auction.id) AS draw_count,
        (SELECT COUNT(*) FROM free_agent_draft_draws AS draw
          WHERE draw.league_id = auction.league_id
            AND draw.auction_id = auction.id
            AND draw.revealed_at_ms IS NOT NULL)
          AS revealed_draw_count
      FROM auction_contexts AS context
      JOIN auctions AS auction
        ON auction.league_id = context.league_id
       AND auction.id = context.auction_id
      LEFT JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.auction_id = auction.id
      WHERE context.league_id = @leagueId
        AND context.season_id = @seasonId
        AND context.fad_id = @fadId
        AND context.fad_allocation_id = @allocationId
      ORDER BY context.source_kind, auction.id
    `);
    participantsStatement = database.prepare(`
      SELECT team_id
      FROM free_agent_draft_auction_participants
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND auction_id = @auctionId
      ORDER BY team_id, id
    `);
    contractsStatement = database.prepare(`
      SELECT *
      FROM contracts
      WHERE league_id = @leagueId
        AND player_id = @playerId
      ORDER BY created_at_ms, id
    `);
    contractYearsStatement = database.prepare(`
      SELECT year.*
      FROM contract_years AS year
      JOIN contracts AS contract
        ON contract.league_id = year.league_id
       AND contract.id = year.contract_id
      WHERE contract.league_id = @leagueId
        AND contract.player_id = @playerId
      ORDER BY year.contract_id, year.year_number, year.id
    `);
    contractEventsStatement = database.prepare(`
      SELECT event.*
      FROM contract_events AS event
      JOIN contracts AS contract
        ON contract.league_id = event.league_id
       AND contract.id = event.contract_id
      WHERE contract.league_id = @leagueId
        AND contract.player_id = @playerId
      ORDER BY event.occurred_at_ms, event.id
    `);
    ownershipsStatement = database.prepare(`
      SELECT *
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND player_id = @playerId
      ORDER BY created_at_ms, id
    `);
    ownershipEventsStatement = database.prepare(`
      SELECT *
      FROM ownership_events
      WHERE league_id = @leagueId
        AND player_id = @playerId
      ORDER BY occurred_at_ms, id
    `);
    rosterDisplayStatement = database.prepare(`
      SELECT
        entry.*,
        order_set.season_id,
        order_set.team_id,
        order_set.updated_at_ms AS order_set_updated_at_ms,
        order_set.version AS order_set_version
      FROM roster_display_order_entries AS entry
      JOIN roster_display_order_sets AS order_set
        ON order_set.league_id = entry.league_id
       AND order_set.id = entry.order_set_id
      JOIN player_ownerships AS ownership
        ON ownership.league_id = entry.league_id
       AND ownership.id = entry.ownership_id
      WHERE ownership.league_id = @leagueId
        AND ownership.player_id = @playerId
      ORDER BY entry.id
    `);
    tradesStatement = database.prepare(`
      SELECT DISTINCT
        trade.id,
        trade.status,
        trade.version,
        trade.updated_at_ms,
        asset.id AS asset_id,
        asset.asset_type
      FROM trade_assets AS asset
      JOIN trades AS trade
        ON trade.league_id = asset.league_id
       AND trade.id = asset.trade_id
      WHERE asset.league_id = @leagueId
        AND (
          asset.player_id = @playerId
          OR asset.contract_id = @contractId
          OR asset.requested_retention_contract_id = @contractId
        )
      ORDER BY trade.id, asset.sequence, asset.id
    `);
    buyoutsStatement = database.prepare(`
      SELECT *
      FROM buyout_obligations
      WHERE league_id = @leagueId
        AND (
          player_id = @playerId
          OR contract_id = @contractId
        )
      ORDER BY id
    `);
    retentionsStatement = database.prepare(`
      SELECT *
      FROM retention_obligations
      WHERE league_id = @leagueId
        AND (
          player_id = @playerId
          OR contract_id = @contractId
        )
      ORDER BY id
    `);
    playerAuctionsStatement = database.prepare(`
      SELECT
        auction.id,
        auction.status,
        auction.created_at_ms,
        auction.version,
        context.fad_id,
        context.fad_allocation_id,
        context.source_kind
      FROM auctions AS auction
      LEFT JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.auction_id = auction.id
      WHERE auction.league_id = @leagueId
        AND auction.player_id = @playerId
      ORDER BY auction.created_at_ms, auction.id
    `);
    occupiedSlotStatement = database.prepare(`
      SELECT *
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND ownership_kind = 'Rostered'
        AND roster_category = @rosterCategory
        AND slot_number = @slotNumber
        AND (
          @rosterCategory <> 'Active'
          OR position_group = @positionGroup
        )
      ORDER BY id
    `);
    contractIdentityStatement = database.prepare(`
      SELECT id, league_id, player_id
      FROM contracts
      WHERE id = @resourceId
      LIMIT 2
    `);
    ownershipIdentityStatement = database.prepare(`
      SELECT id, league_id, player_id
      FROM player_ownerships
      WHERE id = @resourceId
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFadAllocationCorrectionPreview",
      tableName:
        "free_agent_draft_player_allocations",
    });
  }

  const publishedReadRepository =
    createSqliteFreeAgentDraftReadRepository({ database });
  const capReadRepository = createSqliteCapReadRepository({
    database,
  });

  function requireAuthority(scope) {
    const row = unique(
      authorityStatement.all(scope),
      "The FAD correction authority"
    );
    if (
      !row ||
      row.league_status === "deleted" ||
      row.user_status !== "active" ||
      row.membership_status !== "active"
    ) {
      denied();
    }
    const commissioner =
      row.commissioner_membership_id ===
        scope.actorMembershipId &&
      row.permission_category === "commissioner";
    const platformAdministrator =
      row.is_platform_administrator === 1;
    if (
      (scope.actorAuthority === "commissioner" &&
        !commissioner) ||
      (scope.actorAuthority ===
        "platform_administrator_as_commissioner" &&
        !platformAdministrator)
    ) {
      denied();
    }
  }

  function readAllocation(scope) {
    const allocation = unique(
      allocationStatement.all(scope),
      "The scoped FAD allocation"
    );
    if (!allocation) notFound();
    if (
      allocation.deadline_locked_at_ms === null ||
      allocation.status === "pending"
    ) {
      notApplicable();
    }
    return allocation;
  }

  function readSnapshot(scope, allocation) {
    const rows = offersStatement.all({
      ...scope,
      seasonId: allocation.season_id,
      playerId: allocation.player_id,
      allocationVersion: allocation.version,
    });
    if (rows.length < 1) {
      incompatible(
        "The FAD allocation has no immutable Candidate offers."
      );
    }
    const offerIds = rows.map((row) => row.id);
    const teamIds = rows.map((row) => row.team_id);
    if (
      new Set(offerIds).size !== rows.length ||
      new Set(teamIds).size !== rows.length ||
      rows.some(
        (row) =>
          row.processed_at_ms === null ||
          row.player_id !== allocation.player_id ||
          !UUID_PATTERN.test(row.snapshot_id || "") ||
          !UUID_PATTERN.test(row.team_id || "")
      )
    ) {
      incompatible(
        "The immutable Candidate allocation evidence is ambiguous."
      );
    }
    const offers = rows.map((row) =>
      Object.freeze({
        offerId: row.id,
        cardSnapshotId: row.snapshot_id,
        teamId: row.team_id,
        playerId: row.player_id,
        rowKind: row.row_kind,
        totalValueCents:
          row.proposed_total_value_cents,
        termYears: row.proposed_term_years,
        aavCents: row.proposed_aav_cents,
        eligibilityStatus: row.eligibility_status,
        cardAllocationEligibility:
          row.allocation_eligibility,
        cardCompletenessCode:
          row.card_completeness_code,
      })
    );
    let decision;
    try {
      decision = decideCandidateAllocation({
        playerId: allocation.player_id,
        offers,
      });
    } catch (error) {
      if (error instanceof CandidateAllocationPolicyError) {
        incompatible(
          "The immutable Candidate allocation evidence is invalid.",
          error
        );
      }
      throw error;
    }
    return Object.freeze({
      rows: Object.freeze(rows),
      rowsById: new Map(rows.map((row) => [row.id, row])),
      offers: Object.freeze(offers),
      decision,
    });
  }

  function readPublishedResult(scope, allocation) {
    const query = {
      q: normalizeCandidateEligiblePlayerName(
        allocation.player_full_name
      ),
      status: null,
      limit: 100,
      cursor: null,
    };
    const seen = new Set();
    while (true) {
      const page =
        publishedReadRepository.readAllocationResults({
          leagueId: scope.leagueId,
          fadId: scope.fadId,
          viewerUserId: scope.actorUserId,
          viewerMembershipId: scope.actorMembershipId,
          nowMs: allocation.updated_at_ms,
          query,
        });
      const result = page.data.find(
        (candidate) =>
          candidate.allocationId === scope.allocationId
      );
      if (result) return result;
      if (!page.page.hasMore || !page.page.nextCursor) {
        incompatible(
          "The exact published FAD allocation projection is unavailable."
        );
      }
      if (seen.has(page.page.nextCursor)) {
        incompatible(
          "The published FAD allocation cursor did not advance."
        );
      }
      seen.add(page.page.nextCursor);
      query.cursor = page.page.nextCursor;
    }
  }

  function linkedAuctionStatus(row) {
    if (!row) return null;
    if (["open", "resolving"].includes(row.status)) {
      return row.status;
    }
    if (row.resolution_id === null) {
      if (row.status === "cancelled") return "cancelled";
      return "failed";
    }
    if (row.outcome_code === "winner") return "resolved";
    if (
      [
        "no_winner",
        "player_unavailable",
        "season_closed",
      ].includes(row.outcome_code)
    ) {
      return "no_winner";
    }
    if (row.resolution_status === "cancelled") {
      return "cancelled";
    }
    return "failed";
  }

  function readState(scope, allocation) {
    const base = {
      ...scope,
      seasonId: allocation.season_id,
      playerId: allocation.player_id,
    };
    const recoveries = recoveriesStatement.all(base);
    const unresolvedRecoveries = recoveries.filter(
      (row) => row.status !== "resolved"
    );
    if (unresolvedRecoveries.length > 1) {
      incompatible(
        "The FAD allocation has ambiguous unresolved recovery evidence."
      );
    }
    const auctions = auctionsStatement.all(base);
    if (auctions.some((row) => row.draw_count !== 1)) {
      incompatible(
        "Every linked FAD auction requires exactly one immutable draw."
      );
    }
    const contracts = contractsStatement.all(base);
    const ownerships = ownershipsStatement.all(base);
    const currentContract = allocation.contract_id
      ? contracts.find(
          (row) => row.id === allocation.contract_id
        ) || null
      : null;
    const currentOwnership = allocation.ownership_id
      ? ownerships.find(
          (row) => row.id === allocation.ownership_id
        ) || null
      : null;
    return Object.freeze({
      recoveries: Object.freeze(recoveries),
      currentRecovery:
        unresolvedRecoveries[0] || recoveries[0] || null,
      auctions: Object.freeze(auctions),
      contracts: Object.freeze(contracts),
      currentContract,
      contractYears: Object.freeze(
        contractYearsStatement.all(base)
      ),
      contractEvents: Object.freeze(
        contractEventsStatement.all(base)
      ),
      ownerships: Object.freeze(ownerships),
      currentOwnership,
      ownershipEvents: Object.freeze(
        ownershipEventsStatement.all(base)
      ),
      rosterDisplay: Object.freeze(
        rosterDisplayStatement.all(base)
      ),
      trades: Object.freeze(
        tradesStatement.all({
          ...base,
          contractId: allocation.contract_id,
        })
      ),
      buyouts: Object.freeze(
        buyoutsStatement.all({
          ...base,
          contractId: allocation.contract_id,
        })
      ),
      retentions: Object.freeze(
        retentionsStatement.all({
          ...base,
          contractId: allocation.contract_id,
        })
      ),
      playerAuctions: Object.freeze(
        playerAuctionsStatement.all(base)
      ),
    });
  }

  function currentRankedOffers(snapshot, allocation) {
    const pending = allocation.status === "pending";
    return Object.freeze(
      [...snapshot.rows]
        .sort(
          (left, right) =>
            (left.rank_position === null ? 1 : 0) -
              (right.rank_position === null ? 1 : 0) ||
            (left.rank_position ?? 0) -
              (right.rank_position ?? 0) ||
            right.proposed_total_value_cents -
              left.proposed_total_value_cents ||
            right.proposed_aav_cents -
              left.proposed_aav_cents ||
            left.team_name_normalized.localeCompare(
              right.team_name_normalized
            ) ||
            left.team_id.localeCompare(right.team_id) ||
            left.id.localeCompare(right.id)
        )
        .map((row) => {
          if (
            !pending &&
            (![0, 1].includes(row.offer_valid) ||
              row.rank_position === null ||
              row.offer_outcome_code === null)
          ) {
            incompatible(
              "The stored Candidate offer-ranking evidence is incomplete."
            );
          }
          const rawOutcome = pending
            ? "pending"
            : row.offer_outcome_code;
          const outcomeCode = [
            "excluded_structural_conflict",
            "excluded_over_cap",
          ].includes(rawOutcome)
            ? "invalid"
            : rawOutcome;
          return Object.freeze({
            snapshotEntryId: row.id,
            teamId: row.team_id,
            team: teamProjection(row),
            slotKey: slotKey(
              row.slot_group,
              row.slot_number
            ),
            totalValueCents:
              row.proposed_total_value_cents,
            termYears: row.proposed_term_years,
            aavCents: row.proposed_aav_cents,
            valid: pending
              ? ["valid", "warning"].includes(
                  row.eligibility_status
                ) && row.allocation_eligibility === "eligible"
              : row.offer_valid === 1,
            validationCode:
              row.allocation_exclusion_reason ??
              row.validation_code,
            rank: pending ? null : row.rank_position,
            outcomeCode,
          });
        })
    );
  }

  function currentRestricted(
    scope,
    allocation,
    state
  ) {
    if (!RESTRICTED_STATUSES.includes(allocation.status)) {
      return null;
    }
    const restrictedRows = state.auctions.filter(
      (row) => row.source_kind === "fad_restricted"
    );
    if (restrictedRows.length > 1) {
      incompatible(
        "The FAD allocation has ambiguous restricted auctions."
      );
    }
    if (allocation.status === "restricted_scheduled") {
      return Object.freeze({
        auctionId: null,
        status: "scheduled",
        participantTeamIds: Object.freeze([]),
        minimumTotalValueCents:
          allocation.restricted_minimum_total_cents,
        minimumTermYears:
          allocation.restricted_minimum_term_years,
        minimumAavCents:
          allocation.restricted_minimum_aav_cents,
      });
    }
    const auction = restrictedRows[0];
    if (!auction) {
      incompatible(
        "The restricted FAD allocation has no auction evidence."
      );
    }
    const participants = participantsStatement
      .all({
        ...scope,
        seasonId: allocation.season_id,
        auctionId: auction.id,
      })
      .map((row) => row.team_id);
    if (
      participants.length < 2 ||
      new Set(participants).size !== participants.length
    ) {
      incompatible(
        "The restricted FAD allocation participant evidence is invalid."
      );
    }
    return Object.freeze({
      auctionId: auction.id,
      status:
        allocation.status === "restricted_fallback_open"
          ? "fallback_open"
          : linkedAuctionStatus(auction),
      participantTeamIds: Object.freeze(participants),
      minimumTotalValueCents:
        allocation.restricted_minimum_total_cents,
      minimumTermYears:
        allocation.restricted_minimum_term_years,
      minimumAavCents:
        allocation.restricted_minimum_aav_cents,
    });
  }

  function fallbackCurrentProjection(
    scope,
    allocation,
    snapshot,
    state
  ) {
    const rankedOffers = currentRankedOffers(
      snapshot,
      allocation
    );
    let winner = null;
    if (WINNER_STATUSES.includes(allocation.status)) {
      if (
        !UUID_PATTERN.test(allocation.contract_id || "") ||
        !UUID_PATTERN.test(allocation.ownership_id || "") ||
        !UUID_PATTERN.test(
          allocation.winning_team_id || ""
        )
      ) {
        incompatible(
          "The stored FAD winner identity is incomplete."
        );
      }
      const winningOffer = allocation.winning_snapshot_entry_id
        ? snapshot.rowsById.get(
            allocation.winning_snapshot_entry_id
          ) || null
        : null;
      if (
        allocation.winning_snapshot_entry_id !== null &&
        (!winningOffer ||
          winningOffer.team_id !==
            allocation.winning_team_id)
      ) {
        incompatible(
          "The stored FAD winner does not match its Candidate offer."
        );
      }
      const contract = state.currentContract;
      const ownership = state.currentOwnership;
      const totalValueCents =
        contract?.original_total_value_cents ??
        winningOffer?.proposed_total_value_cents;
      const termYears =
        contract?.original_term_years ??
        winningOffer?.proposed_term_years;
      const aavCents =
        contract?.aav_cents ??
        winningOffer?.proposed_aav_cents;
      if (
        !Number.isSafeInteger(totalValueCents) ||
        !Number.isSafeInteger(termYears) ||
        !Number.isSafeInteger(aavCents)
      ) {
        incompatible(
          "The stored FAD winner contract evidence is unavailable."
        );
      }
      const winnerSlotKey = winningOffer
        ? slotKey(
            winningOffer.slot_group,
            winningOffer.slot_number
          )
        : ownership
          ? slotKey(
              ownership.roster_category === "Bench"
                ? "B"
                : ownership.position_group,
              ownership.slot_number
            )
          : null;
      if (!winnerSlotKey) {
        incompatible(
          "The stored fallback winner roster evidence is unavailable."
        );
      }
      winner = Object.freeze({
        teamId: allocation.winning_team_id,
        snapshotEntryId:
          allocation.winning_snapshot_entry_id,
        contractId: allocation.contract_id,
        ownershipId: allocation.ownership_id,
        slotKey: winnerSlotKey,
        totalValueCents,
        termYears,
        aavCents,
      });
    }
    return Object.freeze({
      status: allocation.status,
      decisionCode: allocation.decision_code,
      rankedOffers,
      winner,
      restricted: currentRestricted(
        scope,
        allocation,
        state
      ),
      recoveryStatus:
        state.currentRecovery?.status ?? null,
    });
  }

  function recomputedRankedOffers(snapshot) {
    const decision = snapshot.decision;
    const eligibleRank = new Map(
      decision.eligibleOffers.map((offer, index) => [
        offer.offerId,
        index + 1,
      ])
    );
    const exclusions = new Map(
      decision.excludedOffers.map((offer) => [
        offer.offerId,
        offer.reasonCode,
      ])
    );
    const tieIds = new Set(
      decision.restrictedTie?.participants.map(
        (participant) =>
          participant.sourceSnapshotEntryId
      ) || []
    );
    const top = decision.eligibleOffers[0] || null;
    return Object.freeze(
      snapshot.offers
        .map((offer) => {
          const row = snapshot.rowsById.get(offer.offerId);
          const exclusion =
            exclusions.get(offer.offerId) || null;
          let outcomeCode;
          if (exclusion !== null) {
            outcomeCode = "invalid";
          } else if (
            decision.winner?.offerId === offer.offerId
          ) {
            outcomeCode = "winner";
          } else if (tieIds.has(offer.offerId)) {
            outcomeCode = "restricted_tied";
          } else if (
            top &&
            offer.totalValueCents < top.totalValueCents
          ) {
            outcomeCode = "lost_lower_total";
          } else {
            outcomeCode = "lost_lower_aav";
          }
          return Object.freeze({
            snapshotEntryId: offer.offerId,
            teamId: offer.teamId,
            team: teamProjection(row),
            slotKey: slotKey(
              row.slot_group,
              row.slot_number
            ),
            totalValueCents: offer.totalValueCents,
            termYears: offer.termYears,
            aavCents: offer.aavCents,
            valid: exclusion === null,
            validationCode:
              row.allocation_exclusion_reason ??
              row.validation_code,
            rank:
              eligibleRank.get(offer.offerId) ?? null,
            outcomeCode,
          });
        })
        .sort(
          (left, right) =>
            (left.rank ?? Number.MAX_SAFE_INTEGER) -
              (right.rank ?? Number.MAX_SAFE_INTEGER) ||
            left.snapshotEntryId.localeCompare(
              right.snapshotEntryId
            )
        )
    );
  }

  function createRecomputedDecision({
    scope,
    allocation,
    snapshot,
    state,
    currentDecision,
  }) {
    const rankedOffers = recomputedRankedOffers(snapshot);
    const recoveryStatus = state.currentRecovery
      ? "resolved"
      : null;
    if (snapshot.decision.outcome === "no_valid_offer") {
      return Object.freeze({
        status: "no_valid_offer",
        decisionCode: "no_valid_offer",
        rankedOffers,
        winner: null,
        restricted: null,
        recoveryStatus,
      });
    }
    if (
      snapshot.decision.outcome === "restricted_auction"
    ) {
      const floor = snapshot.decision.restrictedTie.floor;
      return Object.freeze({
        status: "restricted_scheduled",
        decisionCode: "exact_total_and_term_tie",
        rankedOffers,
        winner: null,
        restricted: Object.freeze({
          auctionId: null,
          status: "scheduled",
          participantTeamIds: Object.freeze([]),
          minimumTotalValueCents:
            floor.totalValueCents,
          minimumTermYears: floor.termYears,
          minimumAavCents: floor.aavCents,
        }),
        recoveryStatus,
      });
    }
    const winningOffer = snapshot.decision.winner;
    const winningRow = snapshot.rowsById.get(
      winningOffer.offerId
    );
    const reusable =
      currentDecision.winner !== null &&
      currentDecision.winner.snapshotEntryId ===
        winningOffer.offerId &&
      currentDecision.winner.teamId ===
        winningOffer.teamId &&
      state.currentContract !== null &&
      state.currentOwnership !== null;
    const identityInput = {
      leagueId: scope.leagueId,
      fadId: scope.fadId,
      allocationId: scope.allocationId,
      acceptedFromAllocationVersion: allocation.version,
      targetTeamId: winningOffer.teamId,
    };
    const contractId = reusable
      ? currentDecision.winner.contractId
      : deriveFreeAgentDraftCorrectionResourceId({
          ...identityInput,
          resourceType: "contract",
        });
    const ownershipId = reusable
      ? currentDecision.winner.ownershipId
      : deriveFreeAgentDraftCorrectionResourceId({
          ...identityInput,
          resourceType: "ownership",
        });
    return Object.freeze({
      status: "automatic_award",
      decisionCode: snapshot.decision.decisionCode,
      rankedOffers,
      winner: Object.freeze({
        teamId: winningOffer.teamId,
        snapshotEntryId: winningOffer.offerId,
        contractId,
        ownershipId,
        slotKey: slotKey(
          winningRow.slot_group,
          winningRow.slot_number
        ),
        totalValueCents: winningOffer.totalValueCents,
        termYears: winningOffer.termYears,
        aavCents: winningOffer.aavCents,
      }),
      restricted: null,
      recoveryStatus,
    });
  }

  function inspectDownstream({
    scope,
    allocation,
    snapshot,
    state,
    currentDecision,
    recomputedDecision,
    player,
  }) {
    const warnings = [];
    const blockers = [];
    const currentContract = state.currentContract;
    const currentOwnership = state.currentOwnership;
    const currentWinner = currentDecision.winner;

    if (
      recomputedDecision.status ===
      "restricted_scheduled"
    ) {
      const exactRestrictedAuction =
        state.auctions.length === 1 &&
        state.auctions[0].source_kind ===
          "fad_restricted"
          ? state.auctions[0]
          : null;
      blockers.push(
        diagnostic(
          "FAD_CORRECTION_REQUIRES_RESTRICTED_AUCTION",
          "The locked Candidate result requires a restricted auction and cannot be completed as a terminal allocation correction.",
          exactRestrictedAuction?.id ?? null
        )
      );
    }

    if (allocation.player_status !== "active") {
      blockers.push(
        diagnostic(
          "FAD_CORRECTION_PLAYER_NOT_ACTIVE",
          `The player status ${allocation.player_status} prevents direct correction.`,
          allocation.player_id
        )
      );
    }
    for (const row of snapshot.rows) {
      if (row.team_status !== "active") {
        blockers.push(
          diagnostic(
            "FAD_CORRECTION_TEAM_NOT_ACTIVE",
            `Candidate team status ${row.team_status} prevents direct correction.`,
            row.team_id
          )
        );
      }
    }

    if (currentWinner) {
      if (!currentContract) {
        blockers.push(
          diagnostic(
            "FAD_CORRECTION_CONTRACT_MISSING",
            "The allocation's downstream contract is missing.",
            currentWinner.contractId
          )
        );
      } else {
        const contractDrift =
          currentContract.player_id !== allocation.player_id ||
          currentContract.current_team_id !==
            currentWinner.teamId ||
          currentContract.status !== "active" ||
          currentContract.acquisition_source_type !==
            "free_agent_draft_allocation" ||
          currentContract.acquisition_source_id !==
            allocation.id ||
          currentContract.version !== 1 ||
          currentContract.updated_at_ms !==
            currentContract.created_at_ms;
        if (contractDrift) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_CONTRACT_DRIFT",
              `Linked contract status ${currentContract.status} at version ${currentContract.version} prevents direct correction.`,
              currentContract.id
            )
          );
        }
        const years = state.contractYears.filter(
          (row) => row.contract_id === currentContract.id
        );
        if (
          years.length !==
            currentContract.original_term_years ||
          years.some(
            (row) =>
              row.aav_cents !== currentContract.aav_cents ||
              !["current", "future"].includes(row.status)
          )
        ) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_CONTRACT_YEAR_DRIFT",
              `Linked contract has ${years.length} current/future year records for a ${currentContract.original_term_years}-year term.`,
              currentContract.id
            )
          );
        }
        const events = state.contractEvents.filter(
          (row) => row.contract_id === currentContract.id
        );
        if (
          events.length !== 1 ||
          events[0]?.event_type !== "contract_created" ||
          events[0]?.source_type !==
            "free_agent_draft_allocation" ||
          events[0]?.source_id !== allocation.id
        ) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_CONTRACT_HISTORY_DRIFT",
              `Linked contract has ${events.length} history records and cannot be safely rewritten.`,
              currentContract.id
            )
          );
        }
      }

      if (!currentOwnership) {
        blockers.push(
          diagnostic(
            "FAD_CORRECTION_OWNERSHIP_MISSING",
            "The allocation's downstream ownership is missing.",
            currentWinner.ownershipId
          )
        );
      } else {
        const expectedOffer =
          currentWinner.snapshotEntryId === null
            ? null
            : snapshot.rowsById.get(
                currentWinner.snapshotEntryId
              );
        const expectedCategory =
          expectedOffer?.slot_group === "B"
            ? "Bench"
            : "Active";
        const ownershipDrift =
          currentOwnership.player_id !== allocation.player_id ||
          currentOwnership.team_id !== currentWinner.teamId ||
          currentOwnership.ownership_kind !== "Rostered" ||
          currentOwnership.acquired_transaction_type !==
            "free_agent_draft_allocation" ||
          currentOwnership.acquired_transaction_id !==
            allocation.id ||
          currentOwnership.version !== 1 ||
          currentOwnership.updated_at_ms !==
            currentOwnership.created_at_ms ||
          (expectedOffer &&
            (currentOwnership.roster_category !==
              expectedCategory ||
              currentOwnership.position_group !==
                expectedOffer.effective_position_group ||
              currentOwnership.slot_number !==
                expectedOffer.slot_number));
        if (ownershipDrift) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_OWNERSHIP_ROSTER_DRIFT",
              `Linked ownership is at version ${currentOwnership.version} in ${currentOwnership.roster_category} slot ${currentOwnership.slot_number}.`,
              currentOwnership.id
            )
          );
        }
        const events = state.ownershipEvents.filter(
          (row) =>
            row.ownership_id === currentOwnership.id
        );
        if (
          events.length !== 1 ||
          events[0]?.event_type !==
            "fad_allocation_player_acquired" ||
          events[0]?.source_type !==
            "free_agent_draft_allocation" ||
          events[0]?.source_id !== allocation.id
        ) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_OWNERSHIP_HISTORY_DRIFT",
              `Linked ownership has ${events.length} history records and cannot be safely rewritten.`,
              currentOwnership.id
            )
          );
        }
      }
    }

    for (const row of state.trades) {
      blockers.push(
        diagnostic(
          "FAD_CORRECTION_TRADE_DRIFT",
          `Linked trade status ${row.status} at version ${row.version} prevents direct correction.`,
          row.id
        )
      );
    }
    for (const row of state.buyouts) {
      blockers.push(
        diagnostic(
          "FAD_CORRECTION_BUYOUT_DRIFT",
          `Linked buyout status ${row.status} at version ${row.version} prevents direct correction.`,
          row.id
        )
      );
    }
    for (const row of state.retentions) {
      blockers.push(
        diagnostic(
          "FAD_CORRECTION_RETENTION_DRIFT",
          `Linked retention status ${row.status} at version ${row.version} prevents direct correction.`,
          row.id
        )
      );
    }

    const linkedAuctionIds = new Set(
      state.auctions.map((row) => row.id)
    );
    for (const row of state.playerAuctions) {
      if (
        !linkedAuctionIds.has(row.id) &&
        row.created_at_ms >= allocation.created_at_ms
      ) {
        blockers.push(
          diagnostic(
            "FAD_CORRECTION_PLAYER_AUCTION_DRIFT",
            `A later player auction is ${row.status} at version ${row.version}.`,
            row.id
          )
        );
      }
    }
    for (const row of state.auctions) {
      if (
        row.bid_count > 0 ||
        row.resolution_id !== null ||
        row.revealed_draw_count > 0 ||
        ["resolved", "cancelled", "failed"].includes(
          row.status
        )
      ) {
        blockers.push(
          diagnostic(
            "FAD_CORRECTION_AUCTION_HISTORY_IRREVERSIBLE",
            `Linked auction ${row.status} at version ${row.version} has ${row.bid_count} bids and ${row.revealed_draw_count} revealed draws.`,
            row.id
          )
        );
      }
    }

    const expectedWinner = recomputedDecision.winner;
    if (expectedWinner) {
      const expectedRow = snapshot.rowsById.get(
        expectedWinner.snapshotEntryId
      );
      const rosterCategory =
        expectedRow.slot_group === "B"
          ? "Bench"
          : "Active";
      const occupied = occupiedSlotStatement
        .all({
          leagueId: scope.leagueId,
          seasonId: allocation.season_id,
          teamId: expectedWinner.teamId,
          rosterCategory,
          positionGroup:
            expectedRow.effective_position_group,
          slotNumber: expectedRow.slot_number,
        })
        .filter(
          (row) =>
            row.id !== state.currentOwnership?.id
        );
      if (occupied.length > 0) {
        for (const row of occupied) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_ROSTER_DESTINATION_OCCUPIED",
              `The requested ${rosterCategory} slot ${expectedRow.slot_number} is occupied at ownership version ${row.version}.`,
              row.id
            )
          );
        }
      }
      for (const row of state.ownerships) {
        if (
          row.id !== state.currentOwnership?.id &&
          row.season_id === allocation.season_id
        ) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_PLAYER_OWNERSHIP_DRIFT",
              `Another player ownership exists at version ${row.version}.`,
              row.id
            )
          );
        }
      }
      for (const row of state.contracts) {
        if (
          row.id !== state.currentContract?.id &&
          row.status === "active"
        ) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_PLAYER_CONTRACT_DRIFT",
              `Another active player contract exists at version ${row.version}.`,
              row.id
            )
          );
        }
      }

      const reusesCurrent =
        currentWinner?.contractId ===
          expectedWinner.contractId &&
        currentWinner?.ownershipId ===
          expectedWinner.ownershipId;
      if (!reusesCurrent) {
        const contractCollision = unique(
          contractIdentityStatement.all({
            resourceId: expectedWinner.contractId,
          }),
          "The prospective correction contract identity"
        );
        const ownershipCollision = unique(
          ownershipIdentityStatement.all({
            resourceId: expectedWinner.ownershipId,
          }),
          "The prospective correction ownership identity"
        );
        if (contractCollision) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_RESOURCE_IDENTITY_COLLISION",
              "The prospective correction contract identity is already in use.",
              contractCollision.id
            )
          );
        }
        if (ownershipCollision) {
          blockers.push(
            diagnostic(
              "FAD_CORRECTION_RESOURCE_IDENTITY_COLLISION",
              "The prospective correction ownership identity is already in use.",
              ownershipCollision.id
            )
          );
        }
      }

      try {
        const cap = capReadRepository.calculate({
          leagueId: scope.leagueId,
          seasonId: allocation.season_id,
          teamId: expectedWinner.teamId,
        });
        let projectedUsage = cap.capUsageCents;
        if (rosterCategory === "Active") {
          projectedUsage += expectedWinner.aavCents;
          if (
            state.currentOwnership?.team_id ===
              expectedWinner.teamId &&
            state.currentOwnership.roster_category ===
              "Active" &&
            state.currentContract
          ) {
            projectedUsage -=
              state.currentContract.aav_cents;
          }
        }
        if (projectedUsage > cap.capLimitCents) {
          warnings.push(
            diagnostic(
              "FAD_CORRECTION_RESULTING_TEAM_OVER_CAP",
              `The corrected roster projects ${projectedUsage} cents against a ${cap.capLimitCents}-cent cap.`,
              expectedWinner.teamId
            )
          );
        }
        for (const issue of cap.issues) {
          warnings.push(
            diagnostic(
              "FAD_CORRECTION_CAP_EVIDENCE_INCOMPLETE",
              `Current cap evidence contains ${issue.code}.`,
              issue.ownershipId
            )
          );
        }
      } catch (error) {
        incompatible(
          "The corrected-team cap projection is unavailable.",
          error
        );
      }
    }

    if (
      compareFreeAgentDraftCorrectionDecisions(
        currentDecision,
        recomputedDecision
      )
    ) {
      warnings.push(
        diagnostic(
          "FAD_CORRECTION_DECISION_ALREADY_CURRENT",
          "The current allocation decision already matches the locked Candidate snapshot.",
          allocation.id
        )
      );
      for (const row of state.rosterDisplay) {
        warnings.push(
          diagnostic(
            "FAD_CORRECTION_ROSTER_DISPLAY_ORDER_PRESERVED",
            `Roster display order set version ${row.order_set_version} will be preserved.`,
            row.id
          )
        );
      }
    }

    return Object.freeze({
      warnings: sortDiagnostics(warnings),
      blockers: sortDiagnostics(blockers),
      player,
    });
  }

  function createDeltas({
    allocation,
    state,
    currentDecision,
    recomputedDecision,
    snapshot,
    player,
    blockers,
  }) {
    const deltas = [];
    const expectedWinner = recomputedDecision.winner;
    const currentWinner = currentDecision.winner;
    const expectedTeam = expectedWinner
      ? recomputedDecision.rankedOffers.find(
          (offer) => offer.teamId === expectedWinner.teamId
        ).team
      : null;
    const expectedRow = expectedWinner
      ? snapshot.rowsById.get(
          expectedWinner.snapshotEntryId
        )
      : null;
    const expectedRosterCategory = expectedRow
      ? expectedRow.slot_group === "B"
        ? "Bench"
        : "Active"
      : null;
    const reusesCurrent =
      currentWinner !== null &&
      expectedWinner !== null &&
      currentWinner.contractId === expectedWinner.contractId &&
      currentWinner.ownershipId === expectedWinner.ownershipId;

    deltas.push(
      Object.freeze({
        resourceType: "allocation",
        resourceId: allocation.id,
        action: "update",
        beforeVersion: allocation.version,
        afterSummary: afterSummary({
          status: recomputedDecision.status,
          team: expectedTeam,
          player,
          contractId: expectedWinner?.contractId ?? null,
          ownershipId:
            expectedWinner?.ownershipId ?? null,
          totalValueCents:
            expectedWinner?.totalValueCents ?? null,
          termYears: expectedWinner?.termYears ?? null,
          aavCents: expectedWinner?.aavCents ?? null,
          rosterCategory: expectedRosterCategory,
        }),
      })
    );

    const irreversibleAuctionIds = new Set(
      blockers
        .filter(
          (item) =>
            item.code ===
            "FAD_CORRECTION_AUCTION_HISTORY_IRREVERSIBLE"
        )
        .map((item) => item.resourceId)
    );
    for (const row of state.auctions) {
      if (
        !irreversibleAuctionIds.has(row.id) &&
        !["cancelled", "resolved"].includes(row.status)
      ) {
        deltas.push(
          Object.freeze({
            resourceType: "auction",
            resourceId: row.id,
            action: "cancel",
            beforeVersion: row.version,
            afterSummary: afterSummary({
              status: "cancelled",
              player,
              auctionId: row.id,
            }),
          })
        );
      }
    }
    if (
      recomputedDecision.status ===
        "restricted_scheduled" &&
      state.auctions.length === 0
    ) {
      deltas.push(
        Object.freeze({
          resourceType: "auction",
          resourceId: null,
          action: "create",
          beforeVersion: null,
          afterSummary: afterSummary({
            player,
          }),
        })
      );
    }

    if (currentWinner && !reusesCurrent) {
      const currentTeam =
        currentDecision.rankedOffers.find(
          (offer) => offer.teamId === currentWinner.teamId
        )?.team ?? null;
      if (state.currentContract) {
        deltas.push(
          Object.freeze({
            resourceType: "contract",
            resourceId: state.currentContract.id,
            action: "update",
            beforeVersion: state.currentContract.version,
            afterSummary: afterSummary({
              status: "Expired",
              team: currentTeam,
              player,
              contractId: state.currentContract.id,
              totalValueCents:
                state.currentContract
                  .original_total_value_cents,
              termYears:
                state.currentContract.original_term_years,
              aavCents: state.currentContract.aav_cents,
            }),
          })
        );
      }
      if (state.currentOwnership) {
        deltas.push(
          Object.freeze({
            resourceType: "ownership",
            resourceId: state.currentOwnership.id,
            action: "release",
            beforeVersion: state.currentOwnership.version,
            afterSummary: afterSummary({
              status: "released",
              team: currentTeam,
              player,
              contractId: state.currentContract?.id ?? null,
              ownershipId: state.currentOwnership.id,
              rosterCategory:
                state.currentOwnership.roster_category,
            }),
          })
        );
        const display = state.rosterDisplay.find(
          (row) =>
            row.ownership_id === state.currentOwnership.id
        );
        deltas.push(
          Object.freeze({
            resourceType: "roster_entry",
            resourceId:
              display?.id ?? state.currentOwnership.id,
            action: "remove",
            beforeVersion:
              display?.order_set_version ??
              state.currentOwnership.version,
            afterSummary: afterSummary({
              status: "removed",
              team: currentTeam,
              player,
              contractId: state.currentContract?.id ?? null,
              ownershipId: state.currentOwnership.id,
              rosterCategory:
                state.currentOwnership.roster_category,
            }),
          })
        );
      }
    }

    if (expectedWinner && !reusesCurrent) {
      deltas.push(
        Object.freeze({
          resourceType: "contract",
          resourceId: null,
          action: "create",
          beforeVersion: null,
          afterSummary: afterSummary({
            status: "Active",
            team: expectedTeam,
            player,
            contractId: expectedWinner.contractId,
            totalValueCents:
              expectedWinner.totalValueCents,
            termYears: expectedWinner.termYears,
            aavCents: expectedWinner.aavCents,
            rosterCategory: expectedRosterCategory,
          }),
        }),
        Object.freeze({
          resourceType: "ownership",
          resourceId: null,
          action: "create",
          beforeVersion: null,
          afterSummary: afterSummary({
            status: "rostered",
            team: expectedTeam,
            player,
            contractId: expectedWinner.contractId,
            ownershipId: expectedWinner.ownershipId,
            totalValueCents:
              expectedWinner.totalValueCents,
            termYears: expectedWinner.termYears,
            aavCents: expectedWinner.aavCents,
            rosterCategory: expectedRosterCategory,
          }),
        }),
        Object.freeze({
          resourceType: "roster_entry",
          resourceId: null,
          action: "create",
          beforeVersion: null,
          afterSummary: afterSummary({
            status: "assigned",
            team: expectedTeam,
            player,
            contractId: expectedWinner.contractId,
            ownershipId: expectedWinner.ownershipId,
            rosterCategory: expectedRosterCategory,
          }),
        })
      );
    }

    if (
      state.currentRecovery &&
      state.currentRecovery.status !== "resolved"
    ) {
      deltas.push(
        Object.freeze({
          resourceType: "recovery",
          resourceId: state.currentRecovery.id,
          action: "resolve",
          beforeVersion: state.currentRecovery.version,
          afterSummary: afterSummary({
            status: "resolved",
            player,
          }),
        })
      );
    }
    deltas.push(
      Object.freeze({
        resourceType: "activity",
        resourceId: null,
        action: "append",
        beforeVersion: null,
        afterSummary: afterSummary({
          status: "appended",
          team: expectedTeam,
          player,
          contractId: expectedWinner?.contractId ?? null,
          ownershipId:
            expectedWinner?.ownershipId ?? null,
        }),
      })
    );
    return Object.freeze(deltas);
  }

  const previewTransaction = database.transaction((scope) => {
    requireAuthority(scope);
      const allocation = readAllocation(scope);
      const snapshot = readSnapshot(scope, allocation);
      const state = readState(scope, allocation);
      let publishedResult = null;
      let publishedReadError = null;
      try {
        publishedResult = readPublishedResult(
          scope,
          allocation
        );
      } catch (error) {
        publishedReadError = error;
      }
      const fallbackDecision = fallbackCurrentProjection(
        scope,
        allocation,
        snapshot,
        state
      );
      const currentDecision = publishedResult
        ? Object.freeze({
            status: publishedResult.status,
            decisionCode: publishedResult.decisionCode,
            rankedOffers: publishedResult.rankedOffers,
            winner: publishedResult.winner,
            restricted: publishedResult.restricted,
            recoveryStatus:
              publishedResult.recoveryStatus,
          })
        : fallbackDecision;
      const player = publishedResult?.player ??
        Object.freeze({
          playerId: allocation.player_id,
          fullName: allocation.player_full_name,
          positionGroup: (() => {
            const positions = new Set(
              snapshot.rows.map(
                (row) => row.effective_position_group
              )
            );
            if (
              positions.size !== 1 ||
              !["F", "D"].includes([...positions][0])
            ) {
              incompatible(
                "A safe FAD player position projection is unavailable."
              );
            }
            return [...positions][0];
          })(),
        });
      const recomputedDecision = createRecomputedDecision({
        scope,
        allocation,
        snapshot,
        state,
        currentDecision,
      });
      const inspection = inspectDownstream({
        scope,
        allocation,
        snapshot,
        state,
        currentDecision,
        recomputedDecision,
        player,
      });
      if (
        publishedReadError &&
        inspection.blockers.length === 0 &&
        allocation.status !== "restricted_scheduled"
      ) {
        throw publishedReadError;
      }
      const deltas = createDeltas({
        allocation,
        state,
        currentDecision,
        recomputedDecision,
        snapshot,
        player,
        blockers: inspection.blockers,
      });
      return createFreeAgentDraftCorrectionPreview({
        leagueId: scope.leagueId,
        fadId: scope.fadId,
        allocationId: allocation.id,
        allocationVersion: allocation.version,
        reversible: inspection.blockers.length === 0,
        currentDecision,
        recomputedDecision,
        deltas,
        warnings: inspection.warnings,
        blockers: inspection.blockers,
      });
  });

  function previewAllocationCorrection(input = {}) {
    const scope = normalizeInput(input);
    try {
      return previewTransaction.deferred(scope);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "previewFadAllocationCorrection",
        tableName:
          "free_agent_draft_player_allocations",
      });
    }
  }

  return Object.freeze({ previewAllocationCorrection });
}

module.exports = {
  FREE_AGENT_DRAFT_CORRECTION_PREVIEW_REPOSITORY_CODES,
  createSqliteFreeAgentDraftCorrectionPreviewRepository,
};
