"use strict";

const {
  COOLDOWN_MS,
  calculateAavCents,
} = require("../../../domain/auctions/auctionBidPolicy");
const {
  AUCTION_PUBLIC_STATUSES,
  AUCTION_READ_ORDERS,
  AUCTION_SOURCE_KINDS,
  auctionReadOrder,
} = require("../../../domain/auctions/auctionReadPolicy");
const {
  getAuctionCreationWindow,
} = require("../../../domain/auctions/auctionCreationPolicy");
const {
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAXIMUM_INTERNAL_PAGE_SIZE = 101;
const MAXIMUM_QUERY_CODE_POINTS = 200;
const NORMALIZED_PLAYER_INCLUDES_SQL_FUNCTION =
  "hundo_auction_read_normalized_player_includes_v1";
const PHYSICAL_AUCTION_STATUSES = Object.freeze([
  "open",
  "resolving",
  "resolved",
  "no_winner",
  "cancelled",
  "failed",
]);
const PHYSICAL_BID_STATUSES = Object.freeze([
  "active",
  "won",
  "lost",
  "withdrawn",
  "invalid",
  "cancelled",
]);
const FAD_SOURCE_KINDS = Object.freeze([
  "fad_open_rapid",
  "fad_restricted",
]);
const STATUS_ORDER = Object.freeze([
  "active",
  "resolved",
  "no_winner",
  "cancelled",
  "correction_required",
]);

const AUCTION_READ_REPOSITORY_CODES = Object.freeze({
  authorizationDenied: "AUCTION_READ_AUTHORIZATION_DENIED",
});

function freeze(value) {
  return Object.freeze(value);
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

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
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

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid("A canonical auction-read identifier is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid("A safe auction-read timestamp is required.");
  }
  return value;
}

function nullableStableId(value) {
  return value === null ? null : stableId(value);
}

function canonicalStatuses(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (status) =>
        typeof status !== "string" ||
        !AUCTION_PUBLIC_STATUSES.includes(status)
    )
  ) {
    invalid("Canonical auction-read statuses are required.");
  }
  const selected = new Set(value);
  const canonical = STATUS_ORDER.filter((status) =>
    selected.has(status)
  );
  if (
    canonical.length !== value.length ||
    canonical.some((status, index) => status !== value[index])
  ) {
    invalid("Auction-read statuses must be unique and canonical-sorted.");
  }
  return freeze(canonical);
}

function canonicalCursor(value) {
  if (value === null) return null;
  exactObject(
    value,
    ["auctionId", "sortMs"],
    "A canonical auction-read cursor is required."
  );
  return freeze({
    auctionId: stableId(value.auctionId),
    sortMs: safeTimestamp(value.sortMs),
  });
}

function canonicalListInput(input) {
  exactObject(
    input,
    [
      "cursor",
      "fadId",
      "leagueId",
      "limit",
      "nowMs",
      "order",
      "q",
      "sourceKind",
      "statuses",
      "viewerMembershipId",
      "viewerUserId",
    ],
    "An exact auction collection read input is required."
  );
  const sourceKind = input.sourceKind;
  if (
    sourceKind !== null &&
    !AUCTION_SOURCE_KINDS.includes(sourceKind)
  ) {
    invalid("The auction source-kind filter is invalid.");
  }
  const fadId = nullableStableId(input.fadId);
  if (
    fadId !== null &&
    sourceKind === "ordinary_weekly"
  ) {
    invalid("An ordinary auction filter cannot include a FAD identifier.");
  }
  const statuses = canonicalStatuses(input.statuses);
  if (
    input.q !== null &&
    (
      typeof input.q !== "string" ||
      input.q.length === 0 ||
      input.q !== input.q.trim().toLowerCase() ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(input.q) ||
      /\s/u.test(input.q.replaceAll(" ", "")) ||
      / {2,}/u.test(input.q) ||
      Array.from(input.q).length > MAXIMUM_QUERY_CODE_POINTS
    )
  ) {
    invalid("The normalized auction player query is invalid.");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAXIMUM_INTERNAL_PAGE_SIZE
  ) {
    invalid("The internal auction-read page size is invalid.");
  }
  if (
    !AUCTION_READ_ORDERS.includes(input.order) ||
    input.order !== auctionReadOrder(statuses)
  ) {
    invalid("The auction-read order does not match its status filter.");
  }
  return freeze({
    leagueId: stableId(input.leagueId),
    viewerUserId: stableId(input.viewerUserId),
    viewerMembershipId: stableId(
      input.viewerMembershipId
    ),
    sourceKind,
    fadId,
    statuses,
    q: input.q,
    limit: input.limit,
    order: input.order,
    cursor: canonicalCursor(input.cursor),
    nowMs: safeTimestamp(input.nowMs),
  });
}

function canonicalDetailInput(input) {
  exactObject(
    input,
    [
      "auctionId",
      "leagueId",
      "nowMs",
      "viewerMembershipId",
      "viewerUserId",
    ],
    "An exact auction detail read input is required."
  );
  return freeze({
    auctionId: stableId(input.auctionId),
    leagueId: stableId(input.leagueId),
    viewerUserId: stableId(input.viewerUserId),
    viewerMembershipId: stableId(
      input.viewerMembershipId
    ),
    nowMs: safeTimestamp(input.nowMs),
  });
}

function publicAuctionStatus(
  head,
  context,
  resolutionRows
) {
  const value = head.auction_status;
  if (!PHYSICAL_AUCTION_STATUSES.includes(value)) {
    incompatible("The auction has an unknown persisted status.");
  }
  if (["open", "resolving"].includes(value)) {
    return "active";
  }
  if (value === "failed") {
    return "correction_required";
  }
  if (
    value === "cancelled" &&
    context.source_kind === "fad_restricted" &&
    context.allocation_status ===
      "correction_required"
  ) {
    if (
      resolutionRows.length !== 1 ||
      resolutionRows[0].resolution_status !==
        "cancelled" ||
      resolutionRows[0].outcome_code !== "failed"
    ) {
      incompatible(
        "A cancelled restricted auction has incomplete correction evidence."
      );
    }
    return "correction_required";
  }
  return value;
}

function publicBidStatus(value) {
  if (!PHYSICAL_BID_STATUSES.includes(value)) {
    incompatible("The auction bid has an unknown persisted status.");
  }
  return value === "cancelled" ? "invalid" : value;
}

function allowedCapability() {
  return freeze({ allowed: true, reasonCode: null });
}

function blockedCapability(reasonCode) {
  return freeze({ allowed: false, reasonCode });
}

function teamProjection(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.team_id || "") ||
    typeof row.team_name !== "string" ||
    typeof row.primary_colour !== "string" ||
    typeof row.secondary_colour !== "string" ||
    typeof row.pattern_template !== "string"
  ) {
    incompatible("A safe auction team projection is unavailable.");
  }
  return freeze({
    teamId: row.team_id,
    name: row.team_name,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate: row.pattern_template,
    logoReference: row.logo_reference,
  });
}

function playerProjection(row) {
  const correctionCount = row.correction_position_count;
  const sourceCount = row.source_position_count;
  if (correctionCount > 1) {
    incompatible("A league player has multiple current position corrections.");
  }
  const positionGroup = correctionCount === 1
    ? row.corrected_position_group
    : sourceCount === 1
      ? row.source_position_group
      : null;
  if (
    !UUID_PATTERN.test(row.player_id || "") ||
    typeof row.player_full_name !== "string" ||
    !["F", "D"].includes(positionGroup)
  ) {
    incompatible("A safe auction player projection is unavailable.");
  }
  return freeze({
    playerId: row.player_id,
    fullName: row.player_full_name,
    positionGroup,
  });
}

function sortUniqueRows(rows, key, message) {
  const sorted = [...rows].sort((left, right) =>
    String(left[key]).localeCompare(String(right[key]))
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1][key] === sorted[index][key]) {
      incompatible(message);
    }
  }
  return sorted;
}

function createSqliteAuctionReadRepository({ database } = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.function !== "function"
  ) {
    throw new TypeError(
      "createSqliteAuctionReadRepository requires an opened database"
    );
  }

  let findAuthority;
  let listManagedTeams;
  let findAuctionHead;
  let listContexts;
  let listBids;
  let listStartedEvents;
  let listOpenedNominationQueues;
  let listParticipants;
  let listResolutions;
  let listDraws;
  let listRecoveries;
  let listTerminalActivities;
  let listCurrentFads;
  let listCurrentRollovers;
  let findFadTeam;
  let auctionHeadSql;

  function unique(statement, parameters, message) {
    const rows = statement.all(parameters);
    if (rows.length > 1) incompatible(message);
    return rows[0] || null;
  }

  function requireAuthority(input) {
    const row = unique(
      findAuthority,
      input,
      "Auction read membership is not unique."
    );
    if (
      !row ||
      row.user_status !== "active" ||
      row.membership_status !== "active" ||
      row.league_status === "deleted"
    ) {
      throw repositoryError(
        AUCTION_READ_REPOSITORY_CODES.authorizationDenied,
        "Current active league membership is required to read auctions."
      );
    }
    const commissioner =
      row.commissioner_membership_id ===
        input.viewerMembershipId &&
      row.membership_permission === "commissioner";
    return freeze({
      ...row,
      administrative:
        commissioner || row.is_platform_administrator === 1,
    });
  }

  function managedTeams(input) {
    const rows = listManagedTeams.all(input);
    return sortUniqueRows(
      rows,
      "team_id",
      "A viewer has duplicate current manager assignments for one team."
    );
  }

  function requireContext(head) {
    const rows = listContexts.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    if (rows.length !== 1) {
      incompatible("An auction must have exactly one canonical context.");
    }
    const context = rows[0];
    if (
      !AUCTION_SOURCE_KINDS.includes(context.source_kind) ||
      context.context_id !== head.auction_id ||
      context.context_season_id !== head.season_id ||
      context.context_created_at_ms !== head.created_at_ms
    ) {
      incompatible("The auction context identity is inconsistent.");
    }
    if (context.source_kind === "ordinary_weekly") {
      if (
        context.fad_id !== null ||
        context.fad_rollover_id !== null ||
        context.fad_allocation_id !== null ||
        context.fad_origin !== null ||
        context.target_rollover_at_ms !== null ||
        context.creation_cutoff_at_ms !== null ||
        context.minimum_total_value_cents !== null ||
        context.minimum_term_years !== null ||
        context.minimum_aav_cents !== null
      ) {
        incompatible("An ordinary auction contains FAD context evidence.");
      }
      return context;
    }
    if (
      !UUID_PATTERN.test(context.fad_id || "") ||
      !UUID_PATTERN.test(context.fad_rollover_id || "") ||
      context.target_rollover_at_ms !== head.resolves_at_ms ||
      context.creation_cutoff_at_ms !==
        context.target_rollover_at_ms - 3_600_000
    ) {
      incompatible("The FAD auction rollover context is inconsistent.");
    }
    if (context.source_kind === "fad_restricted") {
      if (
        context.fad_origin !== "candidate_tie_restricted" ||
        !UUID_PATTERN.test(context.fad_allocation_id || "") ||
        !Number.isSafeInteger(context.minimum_total_value_cents) ||
        !Number.isSafeInteger(context.minimum_term_years) ||
        !Number.isSafeInteger(context.minimum_aav_cents)
      ) {
        incompatible("The restricted auction context is inconsistent.");
      }
    } else if (
      ![
        "manager_nomination",
        "queued_nomination",
        "restricted_no_improvement_fallback",
      ].includes(context.fad_origin)
    ) {
      incompatible("The open-rapid auction origin is inconsistent.");
    }
    if (
      context.fad_origin ===
        "restricted_no_improvement_fallback"
    ) {
      if (
        !UUID_PATTERN.test(context.fad_allocation_id || "") ||
        !Number.isSafeInteger(context.minimum_total_value_cents) ||
        !Number.isSafeInteger(context.minimum_term_years) ||
        !Number.isSafeInteger(context.minimum_aav_cents)
      ) {
        incompatible("The FAD fallback minimum is unavailable.");
      }
    } else if (
      context.source_kind === "fad_open_rapid" &&
      (
        context.fad_allocation_id !== null ||
        context.minimum_total_value_cents !== null ||
        context.minimum_term_years !== null ||
        context.minimum_aav_cents !== null
      )
    ) {
      incompatible("A nominated FAD auction contains fallback evidence.");
    }
    return context;
  }

  function participantRows(head, context) {
    const rows = listParticipants.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    const sorted = sortUniqueRows(
      rows,
      "team_id",
      "A restricted auction has duplicate participant teams."
    );
    if (context.source_kind !== "fad_restricted") {
      if (sorted.length !== 0) {
        incompatible("A non-restricted auction contains restricted participants.");
      }
      return sorted;
    }
    if (sorted.length < 2) {
      incompatible("A restricted auction requires at least two participant teams.");
    }
    for (const row of sorted) {
      if (
        row.fad_id !== context.fad_id ||
        row.allocation_id !== context.fad_allocation_id ||
        !["active", "removed"].includes(row.participant_status)
      ) {
        incompatible("Restricted participant evidence is inconsistent.");
      }
    }
    return sorted;
  }

  function drawRow(head, context) {
    const rows = listDraws.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    if (context.source_kind === "ordinary_weekly") {
      if (rows.length !== 0) {
        incompatible("An ordinary auction contains FAD draw evidence.");
      }
      return null;
    }
    if (rows.length !== 1) {
      incompatible("A FAD auction requires exactly one draw commitment.");
    }
    const row = rows[0];
    if (
      row.fad_id !== context.fad_id ||
      row.allocation_id !== context.fad_allocation_id ||
      row.algorithm_version !== 1 ||
      row.created_at_ms !== head.opened_at_ms ||
      !Buffer.isBuffer(row.nonce_bytes) ||
      row.nonce_bytes.length !== 32
    ) {
      incompatible("The FAD draw identity is inconsistent.");
    }
    let expected;
    try {
      expected = createFreeAgentDraftAuctionDrawCommitment({
        auctionId: head.auction_id,
        nonceBytes: row.nonce_bytes,
      });
    } catch {
      incompatible("The FAD draw commitment cannot be reconstructed.");
    }
    if (expected.commitmentHex !== row.commitment_hex) {
      incompatible("The FAD draw commitment does not match its nonce.");
    }
    return row;
  }

  function drawEvidence(head, context, draw, status) {
    if (context.source_kind === "ordinary_weekly") {
      return null;
    }
    if (draw.revealed_at_ms === null) {
      if (!["active", "correction_required"].includes(status)) {
        incompatible("A semantic terminal FAD result has no draw reveal.");
      }
      return status === "active"
        ? null
        : freeze({
            commitmentHex: draw.commitment_hex,
            reveal: null,
          });
    }
    if (status === "active") {
      incompatible("An active FAD auction cannot reveal its draw nonce.");
    }
    let bidIds;
    let teamIds;
    try {
      bidIds = JSON.parse(draw.ordered_tied_bid_ids_json);
      teamIds = JSON.parse(draw.ordered_tied_team_ids_json);
    } catch {
      incompatible("The FAD draw reveal arrays are invalid.");
    }
    if (
      !Array.isArray(bidIds) ||
      !Array.isArray(teamIds) ||
      bidIds.length !== teamIds.length ||
      bidIds.some((id) => !UUID_PATTERN.test(id)) ||
      teamIds.some((id) => !UUID_PATTERN.test(id))
    ) {
      incompatible("The FAD draw reveal arrays are inconsistent.");
    }
    let canonical;
    try {
      canonical = bidIds.length === 0
        ? createFreeAgentDraftAuctionNoSelectionReveal({
            auctionId: head.auction_id,
            commitmentHex: draw.commitment_hex,
            nonceBytes: draw.nonce_bytes,
          })
        : createFreeAgentDraftAuctionDrawReveal({
            auctionId: head.auction_id,
            commitmentHex: draw.commitment_hex,
            nonceBytes: draw.nonce_bytes,
            rolloverAtMs: context.target_rollover_at_ms,
            tiedBidIds: bidIds,
          });
    } catch {
      incompatible("The persisted FAD draw reveal is not replay-stable.");
    }
    if (
      canonical.counter !== draw.rejection_counter ||
      canonical.digestHex !== draw.selected_digest_hex ||
      canonical.selectedIndex !== draw.selected_index ||
      canonical.selectedBidId !== draw.selected_bid_id ||
      (
        canonical.selectionUsed &&
        teamIds[canonical.selectedIndex] !==
          draw.selected_team_id
      ) ||
      (
        !canonical.selectionUsed &&
        draw.selected_team_id !== null
      )
    ) {
      incompatible("The FAD draw selection evidence is inconsistent.");
    }
    return freeze({
      commitmentHex: draw.commitment_hex,
      reveal: freeze({
        algorithmVersion: canonical.algorithmVersion,
        nonceHex: canonical.nonceHex,
        selectionUsed: canonical.selectionUsed,
        orderedBidIds: freeze([...canonical.orderedBidIds]),
        counter: canonical.counter,
        digestHex: canonical.digestHex,
        selectedIndex: canonical.selectedIndex,
        selectedBidId: canonical.selectedBidId,
        selectedTeamId: draw.selected_team_id,
      }),
    });
  }

  function resolutionRow(rows, status) {
    if (status === "active") {
      if (rows.length !== 0) {
        incompatible("An active auction contains terminal resolution evidence.");
      }
      return null;
    }
    if (status === "correction_required") {
      if (rows.length > 1) {
        incompatible("Auction resolution evidence is not unique.");
      }
      return rows[0] || null;
    }
    if (rows.length !== 1) {
      incompatible("A terminal auction requires exactly one resolution.");
    }
    return rows[0];
  }

  function terminalRecovery(head, context, status) {
    const rows = listRecoveries.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    if (context.source_kind === "ordinary_weekly") {
      if (rows.length !== 0) {
        incompatible("An ordinary auction contains FAD recovery evidence.");
      }
      if (status === "correction_required") {
        incompatible("An ordinary failed auction has no safe recovery identity.");
      }
      return null;
    }
    const resolutionRecoveries = rows.filter(
      (row) =>
        row.recovery_kind === "auction_resolution"
    );
    const current = resolutionRecoveries.filter(
      (row) =>
        [
          "pending",
          "ready",
          "running",
          "correction_required",
        ].includes(row.recovery_status)
    );
    if (current.length > 1) {
      incompatible("Current FAD auction recovery evidence is not unique.");
    }
    if (status === "correction_required") {
      if (
        current.length !== 1 ||
        current[0].recovery_status !== "correction_required"
      ) {
        incompatible("A correction-required auction needs exact recovery evidence.");
      }
      return current[0].recovery_id;
    }
    if (current.length === 1) {
      return current[0].recovery_id;
    }
    const resolved = resolutionRecoveries.filter(
      (row) => row.recovery_status === "resolved"
    );
    if (resolved.length > 1) {
      incompatible(
        "Resolved FAD auction recovery evidence is not unique."
      );
    }
    return resolved[0]?.recovery_id || null;
  }

  function terminalActivity(head, resolution, resolvedAtMs) {
    const rows = listTerminalActivities.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
      resolutionId: resolution?.resolution_id || null,
      resolvedAtMs,
    });
    if (rows.length > 1) {
      incompatible("Terminal auction activity evidence is not unique.");
    }
    return rows[0]?.activity_id || null;
  }

  function selectedViewerBid(rows, teamId) {
    const teamRows = rows.filter((row) => row.team_id === teamId);
    for (const statuses of [
      ["active"],
      ["won", "lost"],
      ["withdrawn", "invalid", "cancelled"],
    ]) {
      const selected = teamRows.filter((row) =>
        statuses.includes(row.bid_status)
      );
      if (selected.length > 1 && statuses.length === 1) {
        incompatible("A team has multiple current active auction bids.");
      }
      if (selected.length > 0) {
        return [...selected].sort((left, right) =>
          right.last_edited_at_ms - left.last_edited_at_ms ||
          left.bid_id.localeCompare(right.bid_id)
        )[0];
      }
    }
    return null;
  }

  function nominatedStarter(head, context, bids) {
    if (
      context.source_kind !== "fad_open_rapid" ||
      !["manager_nomination", "queued_nomination"].includes(
        context.fad_origin
      )
    ) {
      return null;
    }
    const events = listStartedEvents.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    if (events.length !== 1) {
      incompatible(
        "A nominated FAD auction requires one exact start event."
      );
    }
    const event = events[0];
    const starterBids = bids.filter(
      (bid) =>
        bid.bid_id === event.bid_id &&
        bid.team_id === event.team_id
    );
    if (
      event.event_type !== "auction_started" ||
      event.occurred_at_ms !== head.opened_at_ms ||
      !UUID_PATTERN.test(event.bid_id || "") ||
      !UUID_PATTERN.test(event.team_id || "") ||
      starterBids.length !== 1
    ) {
      incompatible("The nominated FAD starter event is inconsistent.");
    }
    const queues = listOpenedNominationQueues.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    if (context.fad_origin === "manager_nomination") {
      if (queues.length !== 0) {
        incompatible("A direct FAD starter has queued evidence.");
      }
    } else if (
      queues.length !== 1 ||
      queues[0].season_id !== head.season_id ||
      queues[0].fad_id !== context.fad_id ||
      queues[0].player_id !== head.player_id ||
      queues[0].team_id !== event.team_id ||
      queues[0].status !== "opened" ||
      queues[0].opened_starter_bid_id !== event.bid_id ||
      queues[0].opened_at_ms !== head.opened_at_ms
    ) {
      incompatible("The queued FAD starter backlink is inconsistent.");
    }
    return freeze({
      bidId: event.bid_id,
      teamId: event.team_id,
    });
  }

  function isSupportedBidContext(context, starter) {
    return context.source_kind === "ordinary_weekly" ||
      (
        context.source_kind === "fad_open_rapid" &&
        ["manager_nomination", "queued_nomination"].includes(
          context.fad_origin
        ) &&
        context.fad_allocation_id === null &&
        starter !== null
      ) ||
      (
        context.source_kind === "fad_restricted" &&
        context.allocation_status === "restricted_active"
      ) ||
      (
        context.source_kind === "fad_open_rapid" &&
        context.fad_origin ===
          "restricted_no_improvement_fallback" &&
        context.fad_allocation_id !== null &&
        context.allocation_status ===
          "restricted_fallback_open"
      );
  }

  function bidEditLimit(
    bid,
    head,
    context,
    participant,
    starter
  ) {
    if (participant) return participant.manager_edit_limit;
    if (
      context.source_kind === "fad_open_rapid" &&
      context.fad_origin ===
        "restricted_no_improvement_fallback"
    ) {
      return 1;
    }
    if (
      context.source_kind === "fad_open_rapid" &&
      ["manager_nomination", "queued_nomination"].includes(
        context.fad_origin
      )
    ) {
      return starter?.bidId === bid.bid_id &&
        starter.teamId === bid.team_id
        ? 2
        : 1;
    }
    return bid.first_submitted_at_ms === head.opened_at_ms
      ? 2
      : 1;
  }

  function viewerBidProjection(
    bid,
    head,
    context,
    participant,
    starter
  ) {
    const projection = {
      bidId: bid.bid_id,
      version: bid.bid_version,
      status: publicBidStatus(bid.bid_status),
      totalValueCents: bid.total_value_cents,
      termYears: bid.term_years,
      aavCents: calculateAavCents(
        bid.total_value_cents,
        bid.term_years
      ),
      editCount: bid.edit_count,
      editLimit: bidEditLimit(
        bid,
        head,
        context,
        participant,
        starter
      ),
      cooldownEndsAtMs:
        bid.last_edited_at_ms + COOLDOWN_MS,
    };
    if (FAD_SOURCE_KINDS.includes(context.source_kind)) {
      projection.bindingIllegalityConfirmedAtMs =
        bid.edit_count === 0 &&
        bid.queued_binding_confirmed_at_ms !== null
          ? bid.queued_binding_confirmed_at_ms
          : bid.last_edited_at_ms;
    }
    return freeze(projection);
  }

  function editCapability(
    bid,
    head,
    context,
    participant,
    starter,
    nowMs,
    leagueStatus
  ) {
    if (leagueStatus === "frozen") {
      return blockedCapability("LEAGUE_FROZEN");
    }
    if (leagueStatus !== "active") {
      return blockedCapability("PHASE_CLOSED");
    }
    if (
      !bid ||
      bid.bid_status !== "active" ||
      head.auction_status !== "open" ||
      nowMs < head.opened_at_ms ||
      nowMs >= head.resolves_at_ms ||
      !isSupportedBidContext(context, starter) ||
      participant?.participant_status === "removed"
    ) {
      return blockedCapability("PHASE_CLOSED");
    }
    const limit = bidEditLimit(
      bid,
      head,
      context,
      participant,
      starter
    );
    if (bid.edit_count >= limit) {
      return blockedCapability("EDIT_LIMIT_REACHED");
    }
    if (nowMs < bid.last_edited_at_ms + COOLDOWN_MS) {
      return blockedCapability("COOLDOWN_ACTIVE");
    }
    return allowedCapability();
  }

  function viewerTeamRows(
    managed,
    bids,
    participants,
    head,
    context,
    starter,
    nowMs,
    authority
  ) {
    const participantByTeam = new Map(
      participants.map((row) => [row.team_id, row])
    );
    const visibleManaged = context.source_kind === "fad_restricted"
      ? managed.filter((team) => participantByTeam.has(team.team_id))
      : managed;
    return freeze(visibleManaged.map((team) => {
      const participant = participantByTeam.get(team.team_id) || null;
      const eligible = context.source_kind === "fad_restricted"
        ? participant?.participant_status === "active"
        : true;
      const bid = selectedViewerBid(bids, team.team_id);
      const canJoin =
        authority.league_status === "active" &&
        isSupportedBidContext(context, starter) &&
        eligible &&
        bid?.bid_status !== "active" &&
        head.auction_status === "open" &&
        nowMs >= head.opened_at_ms &&
        nowMs < head.resolves_at_ms;
      return freeze({
        teamId: team.team_id,
        team: teamProjection(team),
        eligible,
        participantStatus:
          participant?.participant_status || null,
        bid: bid
          ? viewerBidProjection(
              bid,
              head,
              context,
              participant,
              starter
            )
          : null,
        join: canJoin
          ? allowedCapability()
          : blockedCapability(
              authority.league_status === "frozen"
                ? "LEAGUE_FROZEN"
                : (
                    context.source_kind === "fad_restricted" &&
                    !eligible
                  )
                ? "TEAM_NOT_PARTICIPANT"
                : "PHASE_CLOSED"
            ),
        edit: editCapability(
          bid,
          head,
          context,
          participant,
          starter,
          nowMs,
          authority.league_status
        ),
      });
    }));
  }

  function administrativeBidRows(
    administrative,
    bids,
    participants,
    head,
    context,
    nowMs,
    leagueStatus
  ) {
    if (!administrative) return freeze([]);
    const participantByTeam = new Map(
      participants.map((row) => [row.team_id, row])
    );
    return freeze([...bids]
      .sort((left, right) =>
        left.bid_id.localeCompare(right.bid_id)
      )
      .map((bid) => {
        const participant = participantByTeam.get(bid.team_id) || null;
        if (
          context.source_kind === "fad_restricted" &&
          !participant
        ) {
          incompatible("A restricted bid has no participant identity.");
        }
        const canAdminister =
          ["active", "frozen"].includes(
            leagueStatus
          ) &&
          bid.bid_status === "active" &&
          head.auction_status === "open" &&
          nowMs >= head.opened_at_ms &&
          nowMs < head.resolves_at_ms &&
          participant?.participant_status !== "removed";
        const capability = canAdminister
          ? allowedCapability()
          : blockedCapability("PHASE_CLOSED");
        return freeze({
          bidId: bid.bid_id,
          teamId: bid.team_id,
          team: teamProjection(bid),
          version: bid.bid_version,
          status: publicBidStatus(bid.bid_status),
          participantStatus:
            participant?.participant_status || null,
          capabilities: freeze({
            adminEditBid: capability,
            adminRemoveBid: capability,
          }),
        });
      }));
  }

  function terminalResult(
    head,
    context,
    bids,
    resolution,
    draw,
    status
  ) {
    if (status === "active") return null;
    const resolvedAtMs = resolution?.resolved_at_ms ??
      head.updated_at_ms;
    safeTimestamp(resolvedAtMs);
    if (resolvedAtMs !== head.updated_at_ms) {
      incompatible("Auction terminal time does not match its resolution.");
    }
    const recoveryId = terminalRecovery(
      head,
      context,
      status
    );
    const activityId = terminalActivity(
      head,
      resolution,
      resolvedAtMs
    );
    const evidence = drawEvidence(
      head,
      context,
      draw,
      status
    );
    if (status !== "resolved") {
      if (
        resolution &&
        (
          resolution.winning_team_id !== null ||
          resolution.winning_bid_id !== null ||
          resolution.contract_id !== null ||
          resolution.ownership_id !== null
        )
      ) {
        incompatible("A non-winning auction contains winning resolution fields.");
      }
      return freeze({
        outcomeCode: status,
        winningTeam: null,
        submittedTotalValueCents: null,
        submittedTermYears: null,
        submittedAavCents: null,
        finalContractValueCents: null,
        finalAavCents: null,
        contractId: null,
        ownershipId: null,
        activityId,
        recoveryId,
        drawEvidence: evidence,
        resolvedAtMs,
      });
    }
    if (
      !resolution ||
      resolution.resolution_status !== "resolved" ||
      !UUID_PATTERN.test(resolution.winning_bid_id || "") ||
      !UUID_PATTERN.test(resolution.winning_team_id || "") ||
      !UUID_PATTERN.test(resolution.contract_id || "") ||
      !UUID_PATTERN.test(resolution.ownership_id || "") ||
      !Number.isSafeInteger(
        resolution.final_contract_value_cents
      ) ||
      !Number.isSafeInteger(resolution.final_aav_cents)
    ) {
      incompatible("A winning auction has incomplete resolution evidence.");
    }
    const winningBids = bids.filter(
      (bid) => bid.bid_id === resolution.winning_bid_id
    );
    if (
      winningBids.length !== 1 ||
      winningBids[0].team_id !== resolution.winning_team_id ||
      winningBids[0].bid_status !== "won"
    ) {
      incompatible("The winning bid identity is inconsistent.");
    }
    const winningBid = winningBids[0];
    return freeze({
      outcomeCode: "resolved",
      winningTeam: teamProjection(winningBid),
      submittedTotalValueCents:
        winningBid.total_value_cents,
      submittedTermYears: winningBid.term_years,
      submittedAavCents: calculateAavCents(
        winningBid.total_value_cents,
        winningBid.term_years
      ),
      finalContractValueCents:
        resolution.final_contract_value_cents,
      finalAavCents: resolution.final_aav_cents,
      contractId: resolution.contract_id,
      ownershipId: resolution.ownership_id,
      activityId,
      recoveryId,
      drawEvidence: evidence,
      resolvedAtMs,
    });
  }

  function projectAuction(
    head,
    authority,
    managed,
    nowMs
  ) {
    const context = requireContext(head);
    const resolutionRows = listResolutions.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    const status = publicAuctionStatus(
      head,
      context,
      resolutionRows
    );
    const participants = participantRows(head, context);
    const draw = drawRow(head, context);
    const resolution = resolutionRow(
      resolutionRows,
      status
    );
    const bids = listBids.all({
      leagueId: head.league_id,
      auctionId: head.auction_id,
    });
    const starter = nominatedStarter(head, context, bids);
    const result = terminalResult(
      head,
      context,
      bids,
      resolution,
      draw,
      status
    );
    const contenderBids = bids.filter((bid) =>
      ["active", "won", "lost"].includes(
        bid.bid_status
      )
    );
    const administrative = authority.administrative;
    const administrationOpen = [
      "active",
      "frozen",
    ].includes(authority.league_status);
    const isActive = status === "active";
    const cancelContextAllowed =
      (
        head.auction_status === "open" &&
        [
          "ordinary_weekly",
          "fad_restricted",
        ].includes(context.source_kind)
      ) ||
      (
        head.auction_status === "failed" &&
        context.source_kind === "fad_open_rapid" &&
        context.fad_allocation_id === null &&
        [
          "manager_nomination",
          "queued_nomination",
        ].includes(context.fad_origin) &&
        status === "correction_required" &&
        UUID_PATTERN.test(
          result?.recoveryId || ""
        )
      );
    const canCancel =
      administrative &&
      administrationOpen &&
      cancelContextAllowed &&
      nowMs >= head.opened_at_ms;
    const canResolve =
      administrative &&
      administrationOpen &&
      head.auction_status === "open" &&
      nowMs >= head.opened_at_ms &&
      nowMs >= head.resolves_at_ms;
    const minimumContract =
      context.minimum_total_value_cents === null
        ? null
        : freeze({
            totalValueCents:
              context.minimum_total_value_cents,
            termYears: context.minimum_term_years,
            aavCents: context.minimum_aav_cents,
          });
    return deepFreeze({
      auctionId: head.auction_id,
      leagueId: head.league_id,
      seasonId: head.season_id,
      version: head.auction_version,
      player: playerProjection(head),
      status,
      openedAtMs: head.opened_at_ms,
      resolvesAtMs: head.resolves_at_ms,
      resolvedAtMs: isActive
        ? null
        : result.resolvedAtMs,
      updatedAtMs: head.updated_at_ms,
      bidCount: contenderBids.length,
      participatingTeamCount: new Set(
        contenderBids.map((bid) => bid.team_id)
      ).size,
      sourceKind: context.source_kind,
      fadOrigin: context.fad_origin,
      fadId: context.fad_id,
      fadRolloverId: context.fad_rollover_id,
      targetRolloverAtMs:
        context.target_rollover_at_ms,
      creationCutoffAtMs:
        context.creation_cutoff_at_ms,
      eligibleTeams: freeze(
        administrative
          ? participants.map((row) => teamProjection(row))
          : []
      ),
      minimumContract,
      drawCommitment: draw?.commitment_hex || null,
      viewerTeams: viewerTeamRows(
        managed,
        bids,
        participants,
        head,
        context,
        starter,
        nowMs,
        authority
      ),
      administrativeBids: administrativeBidRows(
        administrative,
        bids,
        participants,
        head,
        context,
        nowMs,
        authority.league_status
      ),
      result,
      capabilities: freeze({
        view: allowedCapability(),
        adminCancel: canCancel
          ? allowedCapability()
          : blockedCapability(
              administrative
                ? "PHASE_CLOSED"
                : "NOT_AUTHORIZED"
            ),
        adminResolve: canResolve
          ? allowedCapability()
          : blockedCapability(
              administrative
                ? "PHASE_CLOSED"
                : "NOT_AUTHORIZED"
            ),
      }),
    });
  }

  function currentStartContext(input, authority) {
    const fads = authority.current_season_id
      ? listCurrentFads.all({
          leagueId: input.leagueId,
          seasonId: authority.current_season_id,
        })
      : [];
    if (fads.length > 1) {
      incompatible("The current season has multiple FAD records.");
    }
    const fad = fads[0] || null;
    if (fad && fad.fad_status !== "completed") {
      const rollovers = listCurrentRollovers.all({
        leagueId: input.leagueId,
        seasonId: authority.current_season_id,
        fadId: fad.fad_id,
        nowMs: input.nowMs,
      });
      if (rollovers.length > 1) {
        incompatible("The FAD has overlapping current rapid rollovers.");
      }
      const rollover = rollovers[0] || null;
      return freeze({
        sourceKind: "fad_open_rapid",
        fadId: fad.fad_id,
        fadRolloverId: rollover?.rollover_id || null,
        targetRolloverAtMs:
          rollover?.rolls_over_at_ms || null,
        creationCutoffAtMs:
          rollover?.creation_cutoff_at_ms || null,
        generallyAllowed:
          authority.league_status === "active" &&
          authority.season_status === "active" &&
          ["allocating", "rapid"].includes(fad.fad_status) &&
          Boolean(rollover),
        blockedReason:
          authority.league_status === "frozen"
            ? "LEAGUE_FROZEN"
            : "PHASE_CLOSED",
      });
    }
    let window = null;
    if (authority.league_timezone) {
      window = getAuctionCreationWindow({
        nowMs: input.nowMs,
        timeZone: authority.league_timezone,
      });
    }
    const generallyAllowed =
      authority.league_status === "active" &&
      authority.season_status === "active" &&
      authority.regular_season_starts_at_ms !== null &&
      input.nowMs >=
        authority.regular_season_starts_at_ms &&
      (
        authority.regular_season_ends_at_ms === null ||
        input.nowMs <
          authority.regular_season_ends_at_ms
      ) &&
      (
        authority.fantasy_playoffs_start_at_ms === null ||
        input.nowMs <
          authority.fantasy_playoffs_start_at_ms
      ) &&
      authority.free_agent_draft_completed_at_ms !== null &&
      input.nowMs >=
        authority.free_agent_draft_completed_at_ms &&
      Boolean(window?.canStart);
    return freeze({
      sourceKind: "ordinary_weekly",
      fadId: null,
      fadRolloverId: null,
      targetRolloverAtMs: null,
      creationCutoffAtMs: null,
      generallyAllowed,
      blockedReason:
        authority.league_status === "frozen"
          ? "LEAGUE_FROZEN"
          : "PHASE_CLOSED",
    });
  }

  function startTeamRows(input, authority, managed) {
    const context = currentStartContext(input, authority);
    return freeze(managed.map((team) => {
      const participating = context.fadId === null ||
        Boolean(findFadTeam.get({
          leagueId: input.leagueId,
          fadId: context.fadId,
          teamId: team.team_id,
        }));
      const allowed =
        context.generallyAllowed && participating;
      return freeze({
        teamId: team.team_id,
        team: teamProjection(team),
        sourceKind: context.sourceKind,
        fadId: context.fadId,
        fadRolloverId: context.fadRolloverId,
        targetRolloverAtMs:
          context.targetRolloverAtMs,
        creationCutoffAtMs:
          context.creationCutoffAtMs,
        startAuction: allowed
          ? allowedCapability()
          : blockedCapability(
              !participating
                ? "TEAM_NOT_PARTICIPANT"
                : context.blockedReason
            ),
      });
    }));
  }

  function normalizedPlayerName(value) {
    return value.replace(/\s+/gu, " ").trim().toLowerCase();
  }

  function normalizedPlayerIncludes(value, query) {
    if (
      typeof value !== "string" ||
      typeof query !== "string"
    ) {
      return 0;
    }
    return normalizedPlayerName(value).includes(query)
      ? 1
      : 0;
  }

  function headSortColumn(order) {
    if (order === "resolves_asc") {
      return "resolves_at_ms";
    }
    if (order === "resolved_desc") {
      return "terminal_sort_at_ms";
    }
    return "updated_at_ms";
  }

  function selectBoundedAuctionHeads(input, administrative) {
    const statuses = input.statuses;
    const statusParameters = Object.fromEntries(
      statuses.map((status, index) => [`status${index}`, status])
    );
    const statusBindings = statuses
      .map((status, index) => `@status${index}`)
      .join(", ");
    const contextPredicates = [];
    if (input.sourceKind !== null) {
      contextPredicates.push(
        "filtered_context.source_kind = @sourceKind"
      );
    }
    if (input.fadId !== null) {
      contextPredicates.push("filtered_context.fad_id = @fadId");
    }
    const contextFilter = contextPredicates.length === 0
      ? ""
      : `
        AND EXISTS (
          SELECT 1
          FROM auction_contexts AS filtered_context
          WHERE filtered_context.league_id = auction_heads.league_id
            AND filtered_context.auction_id = auction_heads.auction_id
            AND ${contextPredicates.join("\n            AND ")}
        )
      `;
    const sortColumn = headSortColumn(input.order);
    const ascending = input.order === "resolves_asc";
    const sortDirection = ascending ? "ASC" : "DESC";
    const sortComparison = ascending ? ">" : "<";
    const statement = database.prepare(`
      SELECT *
      FROM (
        ${auctionHeadSql}
      ) AS auction_heads
      WHERE auction_heads.league_id = @leagueId
        AND auction_heads.opened_at_ms <= @nowMs
        AND (
          @administrative = 1
          OR NOT EXISTS (
            SELECT 1
            FROM auction_contexts AS private_context
            WHERE private_context.league_id = auction_heads.league_id
              AND private_context.auction_id = auction_heads.auction_id
              AND private_context.source_kind = 'fad_restricted'
          )
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_auction_participants AS private_participant
            JOIN team_manager_assignments AS private_assignment
              ON private_assignment.league_id = private_participant.league_id
             AND private_assignment.team_id = private_participant.team_id
             AND private_assignment.user_id = @viewerUserId
             AND private_assignment.membership_id = @viewerMembershipId
             AND private_assignment.status = 'accepted'
             AND private_assignment.accepted_at_ms <= @nowMs
             AND private_assignment.ended_at_ms IS NULL
            WHERE private_participant.league_id = auction_heads.league_id
              AND private_participant.auction_id = auction_heads.auction_id
              AND private_participant.status = 'active'
          )
        )
        AND (
          auction_heads.auction_status NOT IN ('open', 'resolving')
          OR NOT EXISTS (
            SELECT 1
            FROM auction_contexts AS gated_context
            LEFT JOIN free_agent_draft_player_allocations
              AS gated_allocation
              ON gated_allocation.league_id =
                  gated_context.league_id
             AND gated_allocation.season_id =
                  gated_context.season_id
             AND gated_allocation.fad_id =
                  gated_context.fad_id
             AND gated_allocation.id =
                  gated_context.fad_allocation_id
            WHERE gated_context.league_id =
                auction_heads.league_id
              AND gated_context.auction_id =
                auction_heads.auction_id
              AND gated_context.source_kind = 'fad_restricted'
              AND (
                gated_allocation.id IS NULL
                OR gated_allocation.status <>
                  'restricted_active'
              )
          )
        )
        AND CASE
          WHEN auction_heads.auction_status IN (
            'open',
            'resolving'
          ) THEN 'active'
          WHEN auction_heads.auction_status = 'failed'
            THEN 'correction_required'
          WHEN auction_heads.auction_status = 'cancelled'
            AND EXISTS (
              SELECT 1
              FROM auction_contexts AS status_context
              JOIN free_agent_draft_player_allocations
                AS status_allocation
                ON status_allocation.league_id =
                    status_context.league_id
               AND status_allocation.season_id =
                    status_context.season_id
               AND status_allocation.fad_id =
                    status_context.fad_id
               AND status_allocation.id =
                    status_context.fad_allocation_id
              JOIN auction_resolutions AS status_resolution
                ON status_resolution.league_id =
                    status_context.league_id
               AND status_resolution.season_id =
                    status_context.season_id
               AND status_resolution.auction_id =
                    status_context.auction_id
              WHERE status_context.league_id =
                  auction_heads.league_id
                AND status_context.auction_id =
                  auction_heads.auction_id
                AND status_context.source_kind =
                  'fad_restricted'
                AND status_allocation.status =
                  'correction_required'
                AND status_resolution.status =
                  'cancelled'
                AND status_resolution.outcome_code =
                  'failed'
            ) THEN 'correction_required'
          ELSE auction_heads.auction_status
        END IN (${statusBindings})
        ${contextFilter}
        AND (
          @q IS NULL
          OR ${NORMALIZED_PLAYER_INCLUDES_SQL_FUNCTION}(
            auction_heads.player_full_name,
            @q
          ) = 1
        )
        AND (
          @cursorSortMs IS NULL
          OR auction_heads.${sortColumn} ${sortComparison} @cursorSortMs
          OR (
            auction_heads.${sortColumn} = @cursorSortMs
            AND auction_heads.auction_id > @cursorAuctionId
          )
        )
      ORDER BY
        auction_heads.${sortColumn} ${sortDirection},
        auction_heads.auction_id ASC
      LIMIT @limit
    `);
    return statement.all({
      leagueId: input.leagueId,
      nowMs: input.nowMs,
      administrative: administrative ? 1 : 0,
      viewerUserId: input.viewerUserId,
      viewerMembershipId: input.viewerMembershipId,
      sourceKind: input.sourceKind,
      fadId: input.fadId,
      q: input.q,
      cursorSortMs: input.cursor?.sortMs ?? null,
      cursorAuctionId: input.cursor?.auctionId ?? null,
      limit: input.limit,
      ...statusParameters,
    });
  }

  try {
    database.function(
      NORMALIZED_PLAYER_INCLUDES_SQL_FUNCTION,
      { deterministic: true },
      normalizedPlayerIncludes
    );
    findAuthority = database.prepare(`
      SELECT
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id,
        leagues.commissioner_membership_id,
        users.status AS user_status,
        league_memberships.status AS membership_status,
        league_memberships.permission_category AS membership_permission,
        seasons.status AS season_status,
        seasons.regular_season_starts_at_ms,
        seasons.regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms,
        seasons.free_agent_draft_completed_at_ms,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = @viewerUserId
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
            AND platform_roles.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM leagues
      JOIN users
        ON users.id = @viewerUserId
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = @viewerMembershipId
       AND league_memberships.user_id = @viewerUserId
       AND league_memberships.ended_at_ms IS NULL
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    listManagedTeams = database.prepare(`
      SELECT
        teams.id AS team_id,
        teams.name AS team_name,
        teams.primary_colour,
        teams.secondary_colour,
        teams.tertiary_colour,
        teams.pattern_template,
        teams.logo_reference
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
      ORDER BY teams.id
    `);
    auctionHeadSql = `
      SELECT
        auctions.id AS auction_id,
        auctions.league_id,
        auctions.season_id,
        auctions.player_id,
        auctions.status AS auction_status,
        auctions.opened_at_ms,
        auctions.resolves_at_ms,
        auctions.created_at_ms,
        auctions.updated_at_ms,
        auctions.version AS auction_version,
        players.full_name AS player_full_name,
        COALESCE(
          (
            SELECT MAX(auction_resolutions.resolved_at_ms)
            FROM auction_resolutions
            WHERE auction_resolutions.league_id = auctions.league_id
              AND auction_resolutions.auction_id = auctions.id
          ),
          auctions.updated_at_ms
        ) AS terminal_sort_at_ms,
        (
          SELECT COUNT(*)
          FROM league_player_positions
          WHERE league_player_positions.league_id = auctions.league_id
            AND league_player_positions.player_id = auctions.player_id
            AND league_player_positions.ended_at_ms IS NULL
        ) AS correction_position_count,
        (
          SELECT MAX(position_group)
          FROM league_player_positions
          WHERE league_player_positions.league_id = auctions.league_id
            AND league_player_positions.player_id = auctions.player_id
            AND league_player_positions.ended_at_ms IS NULL
        ) AS corrected_position_group,
        CASE
          WHEN auction_source.id IS NULL THEN 0
          ELSE 1
        END AS source_position_count,
        auction_source.normalized_position AS source_position_group
      FROM auctions
      JOIN players ON players.id = auctions.player_id
      LEFT JOIN player_source_state AS auction_source
        ON auction_source.id = (
          SELECT candidate.id
          FROM player_source_state AS candidate
          WHERE candidate.player_id = auctions.player_id
            AND candidate.normalized_position IN ('F', 'D')
          ORDER BY
            CASE
              WHEN candidate.effective_at_ms <= auctions.opened_at_ms
               AND (
                 candidate.ended_at_ms IS NULL
                 OR candidate.ended_at_ms > auctions.opened_at_ms
               ) THEN 0
              WHEN candidate.ended_at_ms IS NULL THEN 1
              ELSE 2
            END,
            (
              candidate.provider = 'sportsdataio-discovery-lab'
            ) DESC,
            candidate.effective_at_ms DESC,
            candidate.provider ASC,
            candidate.id ASC
          LIMIT 1
        )
    `;
    findAuctionHead = database.prepare(`
      ${auctionHeadSql}
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
        AND auctions.opened_at_ms <= @nowMs
        AND (
          @administrative = 1
          OR NOT EXISTS (
            SELECT 1
            FROM auction_contexts AS private_context
            WHERE private_context.league_id = auctions.league_id
              AND private_context.auction_id = auctions.id
              AND private_context.source_kind = 'fad_restricted'
          )
          OR EXISTS (
            SELECT 1
            FROM free_agent_draft_auction_participants AS private_participant
            JOIN team_manager_assignments AS private_assignment
              ON private_assignment.league_id = private_participant.league_id
             AND private_assignment.team_id = private_participant.team_id
             AND private_assignment.user_id = @viewerUserId
             AND private_assignment.membership_id = @viewerMembershipId
             AND private_assignment.status = 'accepted'
             AND private_assignment.accepted_at_ms <= @nowMs
             AND private_assignment.ended_at_ms IS NULL
            WHERE private_participant.league_id = auctions.league_id
              AND private_participant.auction_id = auctions.id
              AND private_participant.status = 'active'
          )
        )
        AND (
          auctions.status NOT IN ('open', 'resolving')
          OR NOT EXISTS (
            SELECT 1
            FROM auction_contexts AS gated_context
            LEFT JOIN free_agent_draft_player_allocations
              AS gated_allocation
              ON gated_allocation.league_id =
                  gated_context.league_id
             AND gated_allocation.season_id =
                  gated_context.season_id
             AND gated_allocation.fad_id =
                  gated_context.fad_id
             AND gated_allocation.id =
                  gated_context.fad_allocation_id
            WHERE gated_context.league_id = auctions.league_id
              AND gated_context.auction_id = auctions.id
              AND gated_context.source_kind = 'fad_restricted'
              AND (
                gated_allocation.id IS NULL
                OR gated_allocation.status <>
                  'restricted_active'
              )
          )
        )
      LIMIT 2
    `);
    listContexts = database.prepare(`
      SELECT
        auction_contexts.id AS context_id,
        auction_contexts.season_id AS context_season_id,
        auction_contexts.source_kind,
        auction_contexts.fad_id,
        auction_contexts.fad_rollover_id,
        auction_contexts.fad_allocation_id,
        auction_contexts.fad_origin,
        auction_contexts.created_at_ms AS context_created_at_ms,
        free_agent_draft_rollovers.rolls_over_at_ms
          AS target_rollover_at_ms,
        free_agent_draft_rollovers.creation_cutoff_at_ms,
        free_agent_draft_player_allocations.restricted_minimum_total_cents
          AS minimum_total_value_cents,
        free_agent_draft_player_allocations.restricted_minimum_term_years
          AS minimum_term_years,
        free_agent_draft_player_allocations.restricted_minimum_aav_cents
          AS minimum_aav_cents,
        free_agent_draft_player_allocations.status
          AS allocation_status
      FROM auction_contexts
      LEFT JOIN free_agent_draft_rollovers
        ON free_agent_draft_rollovers.league_id = auction_contexts.league_id
       AND free_agent_draft_rollovers.season_id = auction_contexts.season_id
       AND free_agent_draft_rollovers.fad_id = auction_contexts.fad_id
       AND free_agent_draft_rollovers.id = auction_contexts.fad_rollover_id
      LEFT JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id = auction_contexts.league_id
       AND free_agent_draft_player_allocations.season_id = auction_contexts.season_id
       AND free_agent_draft_player_allocations.fad_id = auction_contexts.fad_id
       AND free_agent_draft_player_allocations.id = auction_contexts.fad_allocation_id
      WHERE auction_contexts.league_id = @leagueId
        AND auction_contexts.auction_id = @auctionId
      LIMIT 3
    `);
    listBids = database.prepare(`
      SELECT
        auction_bids.id AS bid_id,
        auction_bids.team_id,
        auction_bids.total_value_cents,
        auction_bids.term_years,
        auction_bids.first_submitted_at_ms,
        auction_bids.last_edited_at_ms,
        auction_bids.edit_count,
        auction_bids.status AS bid_status,
        auction_bids.version AS bid_version,
        teams.name AS team_name,
        teams.primary_colour,
        teams.secondary_colour,
        teams.tertiary_colour,
        teams.pattern_template,
        teams.logo_reference,
        (
          SELECT binding_confirmed_at_ms
          FROM free_agent_draft_nomination_queue
          WHERE free_agent_draft_nomination_queue.league_id = auction_bids.league_id
            AND free_agent_draft_nomination_queue.opened_starter_bid_id = auction_bids.id
          LIMIT 1
        ) AS queued_binding_confirmed_at_ms
      FROM auction_bids
      JOIN teams
        ON teams.league_id = auction_bids.league_id
       AND teams.id = auction_bids.team_id
      WHERE auction_bids.league_id = @leagueId
        AND auction_bids.auction_id = @auctionId
      ORDER BY auction_bids.id
    `);
    listStartedEvents = database.prepare(`
      SELECT
        id AS event_id,
        bid_id,
        team_id,
        event_type,
        occurred_at_ms
      FROM auction_events
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND event_type = 'auction_started'
      ORDER BY id
    `);
    listOpenedNominationQueues = database.prepare(`
      SELECT
        id AS queue_id,
        season_id,
        fad_id,
        player_id,
        team_id,
        status,
        opened_starter_bid_id,
        opened_at_ms
      FROM free_agent_draft_nomination_queue
      WHERE league_id = @leagueId
        AND opened_auction_id = @auctionId
      ORDER BY id
    `);
    listParticipants = database.prepare(`
      SELECT
        free_agent_draft_auction_participants.team_id,
        free_agent_draft_auction_participants.fad_id,
        free_agent_draft_auction_participants.allocation_id,
        free_agent_draft_auction_participants.status AS participant_status,
        free_agent_draft_auction_participants.manager_edit_limit,
        teams.name AS team_name,
        teams.primary_colour,
        teams.secondary_colour,
        teams.tertiary_colour,
        teams.pattern_template,
        teams.logo_reference
      FROM free_agent_draft_auction_participants
      JOIN teams
        ON teams.league_id = free_agent_draft_auction_participants.league_id
       AND teams.id = free_agent_draft_auction_participants.team_id
      WHERE free_agent_draft_auction_participants.league_id = @leagueId
        AND free_agent_draft_auction_participants.auction_id = @auctionId
      ORDER BY free_agent_draft_auction_participants.team_id
    `);
    listResolutions = database.prepare(`
      SELECT
        id AS resolution_id,
        winning_team_id,
        winning_bid_id,
        final_contract_value_cents,
        final_aav_cents,
        contract_id,
        ownership_id,
        outcome_code,
        status AS resolution_status,
        resolved_at_ms
      FROM auction_resolutions
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
      LIMIT 3
    `);
    listDraws = database.prepare(`
      SELECT *
      FROM free_agent_draft_draws
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
      LIMIT 3
    `);
    listRecoveries = database.prepare(`
      SELECT
        id AS recovery_id,
        kind AS recovery_kind,
        status AS recovery_status
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
      ORDER BY created_at_ms DESC, id
    `);
    listTerminalActivities = database.prepare(`
      SELECT id AS activity_id
      FROM league_activity
      WHERE league_id = @leagueId
        AND occurred_at_ms = @resolvedAtMs
        AND (
          (related_type = 'auction' AND related_id = @auctionId)
          OR (
            @resolutionId IS NOT NULL
            AND related_type = 'auction_resolution'
            AND related_id = @resolutionId
          )
        )
      ORDER BY id
      LIMIT 3
    `);
    listCurrentFads = database.prepare(`
      SELECT id AS fad_id, status AS fad_status
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 3
    `);
    listCurrentRollovers = database.prepare(`
      SELECT
        id AS rollover_id,
        creation_cutoff_at_ms,
        rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND status = 'scheduled'
        AND opens_at_ms <= @nowMs
        AND rolls_over_at_ms > @nowMs
      ORDER BY sequence
      LIMIT 3
    `);
    findFadTeam = database.prepare(`
      SELECT id
      FROM free_agent_draft_teams
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND team_id = @teamId
      LIMIT 1
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareAuctionReadRepository",
      tableName: "auctions",
    });
  }

  return freeze({
    listAuctions(input) {
      const canonical = canonicalListInput(input);
      try {
        const authority = requireAuthority(canonical);
        const managed = managedTeams(canonical);
        const projected = selectBoundedAuctionHeads(
          canonical,
          authority.administrative
        )
          .map((head) =>
            projectAuction(
              head,
              authority,
              managed,
              canonical.nowMs
            )
          );
        return deepFreeze({
          auctions: projected,
          startTeams: startTeamRows(
            canonical,
            authority,
            managed
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listSafeAuctions",
          tableName: "auctions",
        });
      }
    },

    readAuction(input) {
      const canonical = canonicalDetailInput(input);
      try {
        const authority = requireAuthority(canonical);
        const head = unique(
          findAuctionHead,
          {
            ...canonical,
            administrative: authority.administrative ? 1 : 0,
          },
          "Auction detail identity is not unique."
        );
        if (!head) return null;
        return projectAuction(
          head,
          authority,
          managedTeams(canonical),
          canonical.nowMs
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "readSafeAuction",
          tableName: "auctions",
        });
      }
    },
  });
}

module.exports = {
  AUCTION_READ_REPOSITORY_CODES,
  MAXIMUM_INTERNAL_PAGE_SIZE,
  createSqliteAuctionReadRepository,
};
