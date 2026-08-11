"use strict";

const {
  createHash,
  randomBytes,
  randomUUID,
} = require("node:crypto");

const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
  calculateAavCents,
  validateOpeningBid,
} = require("../../../domain/auctions/auctionCreationPolicy");
const {
  decideFreeAgentDraftAuctionStart,
} = require("../../../domain/auctions/auctionStartDecisionPolicy");
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
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

const OPERATION = "auction.start";
const SOURCE_KIND = "fad_open_rapid";
const RESOLUTION_JOB_TYPE = "auction.resolve.target";
const ACTIVATION_JOB_TYPE = "fad_queued_nomination_activation";
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const FREE_AGENT_DRAFT_AUCTION_START_WRITER_METHODS =
  Object.freeze([
    "findStartContext",
    "startOrQueue",
  ]);
const FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE =
  Object.freeze({ applicable: false });
const ORDINARY_BODY_FIELDS = Object.freeze([
  "playerId",
  "teamId",
  "totalValueCents",
  "termYears",
]);
const FAD_BODY_FIELDS = Object.freeze([
  ...ORDINARY_BODY_FIELDS,
  "bindingIllegalityConfirmed",
]);
const FIND_FIELDS = Object.freeze([
  "actorMembershipId",
  "actorUserId",
  "leagueId",
  "nowMs",
  "playerId",
  "teamId",
]);
const COMMAND_FIELDS = Object.freeze([
  "actorMembershipId",
  "actorUserId",
  "body",
  "idempotencyExpiresAtMs",
  "idempotencyKey",
  "leagueId",
  "nowMs",
]);

function invalid(message, reasonCode = "INPUT_INVALID") {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    { details: { reasonCode } }
  );
}

function incompatible(message, reasonCode, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    {
      details: { reasonCode },
      ...(cause === undefined ? {} : { cause }),
    }
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

function exactObject(value, fields, description) {
  if (!isPlainObject(value)) {
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (field, index) => field !== expected[index]
    )
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
  return value;
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} identifier is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function boundedKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid(
      "A bounded idempotency key is required.",
      "IDEMPOTENCY_KEY_INVALID"
    );
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function normalizeScope(input) {
  exactObject(input, FIND_FIELDS, "FAD auction-start context lookup");
  return Object.freeze({
    leagueId: canonicalId(input.leagueId, "league"),
    teamId: canonicalId(input.teamId, "team"),
    playerId: canonicalId(input.playerId, "player"),
    actorUserId: canonicalId(input.actorUserId, "actor user"),
    actorMembershipId: canonicalId(
      input.actorMembershipId,
      "actor membership"
    ),
    nowMs: safeTimestamp(input.nowMs, "auction-start timestamp"),
  });
}

function normalizeCommand(input) {
  exactObject(input, COMMAND_FIELDS, "FAD auction-start command");
  const nowMs = safeTimestamp(input.nowMs, "auction-start timestamp");
  const idempotencyExpiresAtMs = safeTimestamp(
    input.idempotencyExpiresAtMs,
    "idempotency expiry timestamp"
  );
  if (idempotencyExpiresAtMs <= nowMs) {
    invalid(
      "The idempotency expiry must follow acceptance.",
      "IDEMPOTENCY_EXPIRY_INVALID"
    );
  }
  if (!isPlainObject(input.body)) {
    invalid("An exact auction-start body is required.");
  }
  const actualBodyFields = Object.keys(input.body).sort();
  const ordinaryFields = [...ORDINARY_BODY_FIELDS].sort();
  const fadFields = [...FAD_BODY_FIELDS].sort();
  const ordinary =
    actualBodyFields.length === ordinaryFields.length &&
    actualBodyFields.every(
      (field, index) => field === ordinaryFields[index]
    );
  const fad =
    actualBodyFields.length === fadFields.length &&
    actualBodyFields.every(
      (field, index) => field === fadFields[index]
    );
  if (!ordinary && !fad) {
    invalid(
      "An exact ordinary or FAD auction-start body is required.",
      "BODY_FIELDS_INVALID"
    );
  }
  const offer = validateOpeningBid(
    input.body.totalValueCents,
    input.body.termYears
  );
  const body = Object.freeze({
    playerId: canonicalId(input.body.playerId, "player"),
    teamId: canonicalId(input.body.teamId, "team"),
    totalValueCents: offer.totalValueCents,
    termYears: offer.termYears,
    ...(fad
      ? {
          bindingIllegalityConfirmed:
            input.body.bindingIllegalityConfirmed,
        }
      : {}),
  });
  return Object.freeze({
    leagueId: canonicalId(input.leagueId, "league"),
    actorUserId: canonicalId(input.actorUserId, "actor user"),
    actorMembershipId: canonicalId(
      input.actorMembershipId,
      "actor membership"
    ),
    body,
    idempotencyKey: boundedKey(input.idempotencyKey),
    nowMs,
    idempotencyExpiresAtMs,
  });
}

function requestHash(command) {
  const hasBindingConfirmation =
    Object.prototype.hasOwnProperty.call(
      command.body,
      "bindingIllegalityConfirmed"
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        actorUserId: command.actorUserId,
        playerId: command.body.playerId,
        teamId: command.body.teamId,
        totalValueCents: command.body.totalValueCents,
        termYears: command.body.termYears,
        bindingConfirmationPresent:
          hasBindingConfirmation,
        bindingIllegalityConfirmed:
          hasBindingConfirmation
            ? command.body.bindingIllegalityConfirmed
            : null,
      }),
      "utf8"
    )
    .digest("hex");
}

function deterministicUuid(value) {
  const hex = createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function directAuctionOutboxEventId(auctionId) {
  return deterministicUuid(
    `fad-auction-start:${auctionId}:auction-opened`
  );
}

function queuedNominationOutboxEventId(queueId) {
  return deterministicUuid(
    `fad-auction-start:${queueId}:nomination-queued`
  );
}

function parseStartedMetadata(encoded) {
  let value;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    incompatible(
      "The persisted FAD auction-start event is not JSON.",
      "START_EVENT_JSON_INVALID",
      error
    );
  }
  const fields = [
    "aavCents",
    "actorAuthority",
    "actorMembershipId",
    "bidClosesAtMs",
    "bindingIllegalityConfirmed",
    "creationCutoffAtMs",
    "fadId",
    "fadRolloverId",
    "openingTeamId",
    "playerPosition",
    "termYears",
    "totalValueCents",
  ];
  if (!isPlainObject(value)) {
    incompatible(
      "The persisted FAD auction-start event is malformed.",
      "START_EVENT_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index]) ||
    !["manager", "commissioner"].includes(value.actorAuthority) ||
    !UUID_PATTERN.test(value.actorMembershipId) ||
    !UUID_PATTERN.test(value.fadId) ||
    !UUID_PATTERN.test(value.fadRolloverId) ||
    !UUID_PATTERN.test(value.openingTeamId) ||
    !["F", "D"].includes(value.playerPosition) ||
    value.bindingIllegalityConfirmed !== true ||
    !Number.isSafeInteger(value.creationCutoffAtMs) ||
    !Number.isSafeInteger(value.bidClosesAtMs) ||
    !Number.isSafeInteger(value.totalValueCents) ||
    !Number.isSafeInteger(value.termYears) ||
    !Number.isSafeInteger(value.aavCents) ||
    value.aavCents !== calculateAavCents(
      value.totalValueCents,
      value.termYears
    )
  ) {
    incompatible(
      "The persisted FAD auction-start event is malformed.",
      "START_EVENT_INVALID"
    );
  }
  return Object.freeze(value);
}

function createSqliteFreeAgentDraftAuctionStartWriter({
  database,
  createId = () => randomUUID(),
  createDrawNonce = () => randomBytes(32),
  leagueOutboxWriter,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftAuctionStartWriter requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "FAD auction-start identifier creation must be a function"
    );
  }
  if (typeof createDrawNonce !== "function") {
    throw new TypeError(
      "FAD auction-start draw nonce creation must be a function"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "FAD auction-start beforeCommit must be a function"
    );
  }

  let findIdempotency;
  let findAuctionSource;
  let findReplayAuthority;
  let findRoot;
  let findRollover;
  let findPlayer;
  let findPositionCorrection;
  let listSourcePositions;
  let findOwnership;
  let findReleasedRights;
  let findActiveAuction;
  let findQuarantine;
  let insertIdempotency;
  let insertAuction;
  let insertContext;
  let insertDraw;
  let insertBid;
  let insertEvent;
  let insertJob;
  let completeDirect;
  let insertQueue;
  let findDirectReplayScope;
  let findQueueReplayScope;
  let findDirectReplay;
  let findQueueReplay;
  let outbox;
  let findProtectedCommissioner;
  let listProtectedAdministrators;
  let findOutboxEvent;
  let listOutboxAudiences;
  let countRelatedOutboxesAt;
  let buildStartContext;
  let writeTransaction;

  try {
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    findProtectedCommissioner = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
      JOIN users AS user
        ON user.id = membership.user_id
      WHERE league.id = @leagueId
        AND membership.status = 'active'
        AND membership.ended_at_ms IS NULL
        AND user.status = 'active'
      LIMIT 2
    `);
    listProtectedAdministrators = database.prepare(`
      SELECT DISTINCT role.user_id
      FROM platform_roles AS role
      JOIN users AS user
        ON user.id = role.user_id
      JOIN league_memberships AS membership
        ON membership.league_id = @leagueId
       AND membership.user_id = role.user_id
      WHERE role.role = 'platform_administrator'
        AND role.status = 'active'
        AND role.ended_at_ms IS NULL
        AND user.status = 'active'
        AND membership.status = 'active'
        AND membership.ended_at_ms IS NULL
      ORDER BY role.user_id
    `);
    findOutboxEvent = database.prepare(`
      SELECT
        id, league_id, event_type, aggregate_type, aggregate_id,
        payload_json, available_at_ms, created_at_ms
      FROM outbox_events
      WHERE league_id = @leagueId
        AND id = @outboxEventId
      LIMIT 2
    `);
    listOutboxAudiences = database.prepare(`
      SELECT id, audience_kind, team_id, user_id, created_at_ms
      FROM outbox_event_audiences
      WHERE league_id = @leagueId
        AND outbox_event_id = @outboxEventId
      ORDER BY audience_kind, COALESCE(team_id, user_id, '')
    `);
    countRelatedOutboxesAt = database.prepare(`
      SELECT COUNT(*) AS count
      FROM outbox_events
      WHERE league_id = @leagueId
        AND created_at_ms = @occurredAtMs
        AND json_valid(payload_json) = 1
        AND json_extract(payload_json, @relatedPath) = @relatedId
    `);
    findIdempotency = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = '${OPERATION}'
        AND client_key = @idempotencyKey
      LIMIT 2
    `);
    findAuctionSource = database.prepare(`
      SELECT
        context.source_kind,
        context.fad_origin,
        context.fad_allocation_id
      FROM auction_contexts AS context
      WHERE context.league_id = @leagueId
        AND context.auction_id = @resultId
      LIMIT 2
    `);
    findReplayAuthority = database.prepare(`
      SELECT
        league.status AS league_status,
        team.status AS team_status,
        membership.status AS membership_status,
        CASE
          WHEN league.commissioner_membership_id = membership.id
          THEN 1 ELSE 0
        END AS current_commissioner,
        assignment.status AS assignment_status,
        assignment.accepted_at_ms AS assignment_accepted_at_ms,
        assignment.ended_at_ms AS assignment_ended_at_ms,
        CASE WHEN fad_team.id IS NULL THEN 0 ELSE 1 END
          AS fad_team_participating
      FROM leagues AS league
      LEFT JOIN teams AS team
        ON team.league_id = league.id
       AND team.id = @teamId
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = @actorMembershipId
       AND membership.user_id = @actorUserId
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.joined_at_ms <= @nowMs
       AND membership.ended_at_ms IS NULL
       AND EXISTS (
         SELECT 1
         FROM users AS actor_user
         WHERE actor_user.id = @actorUserId
           AND actor_user.status = 'active'
       )
      LEFT JOIN team_manager_assignments AS assignment
        ON assignment.league_id = league.id
       AND assignment.team_id = @teamId
       AND assignment.user_id = @actorUserId
       AND assignment.membership_id = @actorMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.accepted_at_ms <= @nowMs
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN free_agent_draft_teams AS fad_team
        ON fad_team.league_id = league.id
       AND fad_team.fad_id = @fadId
       AND fad_team.team_id = @teamId
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    findRoot = database.prepare(`
      SELECT
        league.status AS league_status,
        season.id AS season_id,
        season.status AS season_status,
        fad.id AS fad_id,
        fad.status AS fad_status,
        fad.allocation_completed_at_ms AS allocation_completed_at_ms,
        team.status AS team_status,
        team.version AS team_version,
        membership.status AS membership_status,
        CASE
          WHEN league.commissioner_membership_id = membership.id
          THEN 1 ELSE 0
        END AS current_commissioner,
        assignment.status AS assignment_status,
        assignment.accepted_at_ms AS assignment_accepted_at_ms,
        assignment.ended_at_ms AS assignment_ended_at_ms,
        CASE WHEN fad_team.id IS NULL THEN 0 ELSE 1 END
          AS fad_team_participating,
        card.version AS candidate_card_version
      FROM leagues AS league
      JOIN seasons AS season
        ON season.league_id = league.id
       AND season.id = league.current_season_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = league.id
       AND fad.season_id = season.id
       AND fad.status = 'rapid'
      LEFT JOIN teams AS team
        ON team.league_id = league.id
       AND team.id = @teamId
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = @actorMembershipId
       AND membership.user_id = @actorUserId
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.joined_at_ms <= @nowMs
       AND membership.ended_at_ms IS NULL
       AND EXISTS (
         SELECT 1
         FROM users AS actor_user
         WHERE actor_user.id = @actorUserId
           AND actor_user.status = 'active'
       )
      LEFT JOIN team_manager_assignments AS assignment
        ON assignment.league_id = league.id
       AND assignment.team_id = @teamId
       AND assignment.user_id = @actorUserId
       AND assignment.membership_id = @actorMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.accepted_at_ms <= @nowMs
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN free_agent_draft_teams AS fad_team
        ON fad_team.league_id = league.id
       AND fad_team.season_id = season.id
       AND fad_team.fad_id = fad.id
       AND fad_team.team_id = @teamId
      LEFT JOIN candidate_cards AS card
        ON card.league_id = league.id
       AND card.season_id = season.id
       AND card.fad_id = fad.id
       AND card.team_id = @teamId
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    findRollover = database.prepare(`
      SELECT
        id,
        league_id,
        season_id,
        fad_id,
        status,
        opens_at_ms,
        creation_cutoff_at_ms,
        rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND status IN ('scheduled', 'processing')
        AND opens_at_ms <= @nowMs
        AND rolls_over_at_ms > @nowMs
      ORDER BY sequence
      LIMIT 2
    `);
    findPlayer = database.prepare(`
      SELECT id, status
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
      SELECT id
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND player_id = @playerId
      LIMIT 2
    `);
    findReleasedRights = database.prepare(`
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
    findActiveAuction = database.prepare(`
      SELECT id
      FROM auctions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND player_id = @playerId
        AND status IN ('open', 'resolving')
      LIMIT 2
    `);
    findQuarantine = database.prepare(`
      SELECT 1 AS quarantined
      FROM free_agent_draft_player_allocations AS allocation
      WHERE allocation.league_id = @leagueId
        AND allocation.season_id = @seasonId
        AND allocation.player_id = @playerId
        AND allocation.status IN (
          'pending',
          'restricted_scheduled',
          'restricted_active',
          'restricted_fallback_open',
          'correction_required'
        )
      UNION ALL
      SELECT 1 AS quarantined
      FROM free_agent_draft_recoveries AS recovery
      WHERE recovery.league_id = @leagueId
        AND recovery.season_id = @seasonId
        AND recovery.player_id = @playerId
        AND recovery.status IN (
          'pending',
          'ready',
          'running',
          'correction_required'
        )
      UNION ALL
      SELECT 1 AS quarantined
      FROM free_agent_draft_nomination_queue AS queue
      WHERE queue.league_id = @leagueId
        AND queue.season_id = @seasonId
        AND queue.player_id = @playerId
        AND queue.status = 'queued'
      UNION ALL
      SELECT 1 AS quarantined
      FROM auctions AS failed_auction
      JOIN auction_contexts AS context
        ON context.league_id = failed_auction.league_id
       AND context.season_id = failed_auction.season_id
       AND context.auction_id = failed_auction.id
       AND context.source_kind IN ('fad_open_rapid', 'fad_restricted')
      WHERE failed_auction.league_id = @leagueId
        AND failed_auction.season_id = @seasonId
        AND failed_auction.player_id = @playerId
        AND failed_auction.status = 'failed'
      LIMIT 1
    `);
    insertIdempotency = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId, @actorUserId,
        '${OPERATION}', @idempotencyKey, @requestHash,
        'started', NULL, NULL, @nowMs, NULL,
        @idempotencyExpiresAtMs
      )
    `);
    insertAuction = database.prepare(`
      INSERT INTO auctions (
        id, league_id, season_id, player_id, status,
        opened_at_ms, resolves_at_ms, opened_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @auctionId, @leagueId, @seasonId, @playerId, 'open',
        @nowMs, @resolvesAtMs, @actorUserId,
        @nowMs, @nowMs, 1
      )
    `);
    insertContext = database.prepare(`
      INSERT INTO auction_contexts (
        id, league_id, season_id, auction_id, source_kind,
        fad_id, fad_rollover_id, fad_allocation_id,
        fad_origin, created_at_ms
      ) VALUES (
        @auctionId, @leagueId, @seasonId, @auctionId,
        '${SOURCE_KIND}', @fadId, @sourceRolloverId,
        NULL, 'manager_nomination', @nowMs
      )
    `);
    insertDraw = database.prepare(`
      INSERT INTO free_agent_draft_draws (
        id, league_id, season_id, fad_id, allocation_id,
        auction_id, algorithm_version, nonce_bytes,
        commitment_hex, ordered_tied_bid_ids_json,
        ordered_tied_team_ids_json, rejection_counter,
        selected_index, selected_bid_id, selected_team_id,
        selected_digest_hex, revealed_at_ms, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        @drawId, @leagueId, @seasonId, @fadId, NULL,
        @auctionId, 1, @nonceBytes, @commitmentHex,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        @nowMs, @nowMs, 1
      )
    `);
    insertBid = database.prepare(`
      INSERT INTO auction_bids (
        id, league_id, season_id, auction_id, team_id,
        submitted_by_user_id, total_value_cents, term_years,
        lowest_offered_aav_cents, first_submitted_at_ms,
        last_edited_at_ms, edit_count, status,
        idempotency_request_id, version
      ) VALUES (
        @bidId, @leagueId, @seasonId, @auctionId, @teamId,
        @actorUserId, @totalValueCents, @termYears, @aavCents,
        @nowMs, @nowMs, 0, 'active', @idempotencyRequestId, 1
      )
    `);
    insertEvent = database.prepare(`
      INSERT INTO auction_events (
        id, league_id, season_id, auction_id, bid_id, team_id,
        actor_user_id, event_type, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @auctionId, @bidId,
        @teamId, @actorUserId, 'auction_started',
        @metadataJson, @nowMs
      )
    `);
    insertJob = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type, occurrence_key,
        scheduled_for_ms, status, attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms, completed_at_ms,
        result_json, last_error_code, created_at_ms, updated_at_ms,
        version, lease_token, next_attempt_at_ms
      ) VALUES (
        @jobRunId, @leagueId, @seasonId, @jobType,
        @occurrenceKey, @scheduledForMs, 'pending', 0,
        NULL, NULL, NULL, NULL, NULL, NULL, @nowMs, @nowMs,
        1, NULL, NULL
      )
    `);
    completeDirect = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'auction',
          result_id = @auctionId, completed_at_ms = @nowMs
      WHERE league_id = @leagueId
        AND id = @idempotencyRequestId
        AND actor_user_id = @actorUserId
        AND operation = '${OPERATION}'
        AND status = 'started'
        AND result_type IS NULL
        AND result_id IS NULL
        AND completed_at_ms IS NULL
    `);
    insertQueue = database.prepare(`
      INSERT INTO free_agent_draft_nomination_queue (
        id, league_id, season_id, fad_id, team_id, player_id,
        source_rollover_id, target_opening_rollover_id,
        resolution_rollover_id, opening_total_value_cents,
        opening_term_years, opening_aav_cents,
        binding_illegality_confirmed, binding_confirmed_at_ms,
        submitted_by_user_id, submitted_by_membership_id,
        accepted_at_ms, candidate_card_version_observed,
        team_version_observed, status, opened_auction_id,
        opened_starter_bid_id, opened_at_ms, terminal_at_ms,
        validation_code, created_at_ms, updated_at_ms, version,
        acceptance_idempotency_request_id
      ) VALUES (
        @queueId, @leagueId, @seasonId, @fadId, @teamId,
        @playerId, @sourceRolloverId, @sourceRolloverId, NULL,
        @totalValueCents, @termYears, @aavCents, 1, @nowMs,
        @actorUserId, @actorMembershipId, @nowMs,
        @candidateCardVersion, @teamVersion, 'queued', NULL,
        NULL, NULL, NULL, NULL, @nowMs, @nowMs, 1,
        @idempotencyRequestId
      )
    `);
    findDirectReplayScope = database.prepare(`
      SELECT
        request.league_id AS league_id,
        context.fad_id AS fad_id,
        bid.team_id AS team_id
      FROM idempotency_requests AS request
      JOIN auctions AS auction
        ON auction.league_id = request.league_id
       AND auction.id = request.result_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
       AND context.source_kind = '${SOURCE_KIND}'
       AND context.fad_origin = 'manager_nomination'
       AND context.fad_allocation_id IS NULL
      JOIN auction_bids AS bid
        ON bid.league_id = auction.league_id
       AND bid.season_id = auction.season_id
       AND bid.auction_id = auction.id
       AND bid.idempotency_request_id = request.id
      WHERE request.league_id = @leagueId
        AND request.id = @idempotencyRequestId
        AND request.actor_user_id = @actorUserId
        AND request.operation = '${OPERATION}'
        AND request.status = 'completed'
        AND request.result_type = 'auction'
      LIMIT 2
    `);
    findQueueReplayScope = database.prepare(`
      SELECT
        request.league_id AS league_id,
        queue.fad_id AS fad_id,
        queue.team_id AS team_id
      FROM idempotency_requests AS request
      JOIN free_agent_draft_nomination_queue AS queue
        ON queue.league_id = request.league_id
       AND queue.id = request.result_id
       AND queue.acceptance_idempotency_request_id = request.id
      WHERE request.league_id = @leagueId
        AND request.id = @idempotencyRequestId
        AND request.actor_user_id = @actorUserId
        AND request.operation = '${OPERATION}'
        AND request.status = 'completed'
        AND request.result_type = 'fad_nomination_queue'
      LIMIT 2
    `);
    findDirectReplay = database.prepare(`
      SELECT
        request.id AS request_id,
        request.league_id AS league_id,
        request.created_at_ms AS accepted_at_ms,
        auction.id AS auction_id,
        auction.season_id AS season_id,
        auction.player_id AS player_id,
        auction.opened_at_ms AS auction_opened_at_ms,
        auction.resolves_at_ms AS auction_resolves_at_ms,
        context.fad_id AS fad_id,
        context.fad_rollover_id AS rollover_id,
        context.created_at_ms AS context_created_at_ms,
        bid.id AS bid_id,
        bid.team_id AS bid_team_id,
        event.id AS event_id,
        event.occurred_at_ms AS event_occurred_at_ms,
        event.metadata_json AS metadata_json,
        draw.id AS draw_id,
        draw.commitment_hex AS commitment_hex,
        draw.created_at_ms AS draw_created_at_ms,
        job.id AS job_run_id,
        job.scheduled_for_ms AS job_scheduled_for_ms
      FROM idempotency_requests AS request
      JOIN auctions AS auction
        ON auction.league_id = request.league_id
       AND auction.id = request.result_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.season_id = auction.season_id
       AND context.auction_id = auction.id
       AND context.source_kind = '${SOURCE_KIND}'
       AND context.fad_origin = 'manager_nomination'
       AND context.fad_allocation_id IS NULL
      JOIN auction_bids AS bid
        ON bid.league_id = auction.league_id
       AND bid.season_id = auction.season_id
       AND bid.auction_id = auction.id
       AND bid.idempotency_request_id = request.id
      JOIN auction_events AS event
        ON event.league_id = bid.league_id
       AND event.season_id = bid.season_id
       AND event.auction_id = bid.auction_id
       AND event.bid_id = bid.id
       AND event.team_id = bid.team_id
       AND event.event_type = 'auction_started'
      JOIN free_agent_draft_draws AS draw
        ON draw.league_id = context.league_id
       AND draw.season_id = context.season_id
       AND draw.fad_id = context.fad_id
       AND draw.auction_id = context.auction_id
      JOIN job_runs AS job
        ON job.league_id = auction.league_id
       AND job.season_id = auction.season_id
       AND job.job_type = '${RESOLUTION_JOB_TYPE}'
       AND job.occurrence_key =
         'auction:' || auction.id || ':' || auction.resolves_at_ms
      WHERE request.league_id = @leagueId
        AND request.id = @idempotencyRequestId
        AND request.actor_user_id = @actorUserId
        AND request.operation = '${OPERATION}'
        AND request.status = 'completed'
        AND request.result_type = 'auction'
      LIMIT 2
    `);
    findQueueReplay = database.prepare(`
      SELECT
        request.id AS request_id,
        request.league_id AS league_id,
        queue.id AS queue_id,
        queue.season_id AS season_id,
        queue.fad_id AS fad_id,
        queue.team_id AS team_id,
        queue.player_id AS player_id,
        queue.source_rollover_id AS rollover_id,
        queue.opening_total_value_cents AS total_value_cents,
        queue.opening_term_years AS term_years,
        queue.opening_aav_cents AS aav_cents,
        queue.binding_illegality_confirmed
          AS binding_illegality_confirmed,
        queue.binding_confirmed_at_ms AS binding_confirmed_at_ms,
        queue.accepted_at_ms AS accepted_at_ms,
        queue.target_opening_rollover_id
          AS target_opening_rollover_id,
        queue.resolution_rollover_id AS resolution_rollover_id,
        queue.status AS queue_status,
        queue.version AS queue_version,
        player.full_name AS player_full_name,
        (
          SELECT COUNT(*)
          FROM league_player_positions AS correction
          WHERE correction.league_id = queue.league_id
            AND correction.player_id = queue.player_id
            AND correction.ended_at_ms IS NULL
        ) AS correction_position_count,
        (
          SELECT MAX(correction.position_group)
          FROM league_player_positions AS correction
          WHERE correction.league_id = queue.league_id
            AND correction.player_id = queue.player_id
            AND correction.ended_at_ms IS NULL
        ) AS corrected_position_group,
        CASE WHEN queue_source.id IS NULL THEN 0 ELSE 1 END
          AS source_position_count,
        queue_source.normalized_position AS source_position_group,
        rollover.creation_cutoff_at_ms AS creation_cutoff_at_ms,
        rollover.rolls_over_at_ms AS opens_at_ms,
        job.id AS job_run_id
      FROM idempotency_requests AS request
      JOIN free_agent_draft_nomination_queue AS queue
        ON queue.league_id = request.league_id
       AND queue.id = request.result_id
       AND queue.acceptance_idempotency_request_id = request.id
      JOIN free_agent_draft_rollovers AS rollover
        ON rollover.league_id = queue.league_id
       AND rollover.season_id = queue.season_id
       AND rollover.fad_id = queue.fad_id
       AND rollover.id = queue.source_rollover_id
      JOIN players AS player
        ON player.id = queue.player_id
      LEFT JOIN player_source_state AS queue_source
        ON queue_source.id = (
          SELECT candidate.id
          FROM player_source_state AS candidate
          WHERE candidate.player_id = queue.player_id
            AND candidate.normalized_position IN ('F', 'D')
          ORDER BY
            CASE
              WHEN candidate.effective_at_ms <= queue.accepted_at_ms
               AND (
                 candidate.ended_at_ms IS NULL
                 OR candidate.ended_at_ms > queue.accepted_at_ms
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
      JOIN job_runs AS job
        ON job.league_id = queue.league_id
       AND job.season_id = queue.season_id
       AND job.job_type = '${ACTIVATION_JOB_TYPE}'
       AND job.occurrence_key =
         'fad:' || queue.fad_id || ':nomination-open:' ||
         queue.id || ':' || rollover.rolls_over_at_ms
      WHERE request.league_id = @leagueId
        AND request.id = @idempotencyRequestId
        AND request.actor_user_id = @actorUserId
        AND request.operation = '${OPERATION}'
        AND request.status = 'completed'
        AND request.result_type = 'fad_nomination_queue'
      LIMIT 2
    `);

    function unique(statement, parameters, description) {
      const rows = statement.all(parameters);
      if (rows.length > 1) {
        incompatible(
          `The ${description} is not unique.`,
          "PERSISTED_SCOPE_NOT_UNIQUE"
        );
      }
      return rows[0] || null;
    }

    function currentProtectedUserIds(leagueId) {
      const commissioner = unique(
        findProtectedCommissioner,
        { leagueId },
        "current protected FAD commissioner"
      );
      const userIds = new Set(
        listProtectedAdministrators
          .all({ leagueId })
          .map(({ user_id: userId }) => userId)
      );
      if (commissioner) userIds.add(commissioner.user_id);
      const result = [...userIds].sort();
      if (result.some((userId) => !UUID_PATTERN.test(userId))) {
        incompatible(
          "The current protected FAD authority is malformed.",
          "PROTECTED_AUTHORITY_INVALID"
        );
      }
      return Object.freeze(result);
    }

    function queueAudiences(leagueId, teamId) {
      return Object.freeze([
        Object.freeze({ kind: "team", teamId }),
        ...currentProtectedUserIds(leagueId).map((userId) =>
          Object.freeze({ kind: "user", userId })
        ),
      ]);
    }

    function persistedQueueAudiences(
      leagueId,
      outboxEventId,
      teamId
    ) {
      const rows = listOutboxAudiences.all({
        leagueId,
        outboxEventId,
      });
      const teamRows = rows.filter(
        ({ audience_kind: kind }) => kind === "team"
      );
      const userRows = rows.filter(
        ({ audience_kind: kind }) => kind === "user"
      );
      const userIds = userRows.map(({ user_id: userId }) => userId);
      if (
        rows.length < 1 ||
        teamRows.length !== 1 ||
        teamRows[0].team_id !== teamId ||
        teamRows[0].user_id !== null ||
        teamRows[0].id !== deterministicUuid(
          `${outboxEventId}:audience:team:${teamId}`
        ) ||
        userRows.some(
          (row) =>
            row.team_id !== null ||
            !UUID_PATTERN.test(row.user_id || "") ||
            row.id !== deterministicUuid(
              `${outboxEventId}:audience:user:${row.user_id}`
            )
        ) ||
        rows.some(
          ({ audience_kind: kind }) =>
            kind !== "team" && kind !== "user"
        ) ||
        new Set(userIds).size !== userIds.length
      ) {
        incompatible(
          "The persisted private nomination-queue audience is invalid.",
          "OUTBOX_AUDIENCE_INVALID"
        );
      }
      return Object.freeze([
        Object.freeze({ kind: "team", teamId }),
        ...userIds.sort().map((userId) =>
          Object.freeze({ kind: "user", userId })
        ),
      ]);
    }

    function writePublication({
      id,
      leagueId,
      eventType,
      aggregateType,
      aggregateId,
      version,
      reasonCode,
      occurredAtMs,
      related,
      audiences,
    }) {
      const result = outbox.write({
        id,
        leagueId,
        eventType,
        aggregateType,
        aggregateId,
        payload: createSocketEventMetadata({
          eventType,
          version,
          reasonCode,
          occurredAtMs,
          related,
        }),
        occurredAtMs,
        audiences,
      });
      if (result && typeof result.then === "function") {
        invalid(
          "FAD auction-start outbox writes must be synchronous.",
          "OUTBOX_WRITE_ASYNC"
        );
      }
    }

    function validatePublication({
      id,
      leagueId,
      eventType,
      aggregateType,
      aggregateId,
      version,
      reasonCode,
      occurredAtMs,
      related,
      relatedPath,
      relatedId,
      audiences,
    }) {
      const event = unique(
        findOutboxEvent,
        { leagueId, outboxEventId: id },
        "canonical FAD auction-start outbox event"
      );
      const expectedPayload = JSON.stringify(
        createSocketEventEnvelope({
          eventId: id,
          type: eventType,
          leagueId,
          resourceId: aggregateId,
          version,
          reasonCode,
          occurredAt: occurredAtMs,
          related,
        })
      );
      if (
        !event ||
        event.league_id !== leagueId ||
        event.event_type !== eventType ||
        event.aggregate_type !== aggregateType ||
        event.aggregate_id !== aggregateId ||
        event.payload_json !== expectedPayload ||
        event.created_at_ms !== occurredAtMs
      ) {
        incompatible(
          "The canonical FAD auction-start outbox event is split.",
          "OUTBOX_EVIDENCE_INVALID"
        );
      }

      const expectedAudiences = audiences
        .map((audience) => ({
          id:
            audience.kind === "league"
              ? id
              : deterministicUuid(
                  `${id}:audience:${audience.kind}:` +
                  `${audience.teamId || audience.userId}`
                ),
          audience_kind: audience.kind,
          team_id:
            audience.kind === "team" ? audience.teamId : null,
          user_id:
            audience.kind === "user" ? audience.userId : null,
          created_at_ms: occurredAtMs,
        }))
        .sort((left, right) => {
          const leftKey =
            `${left.audience_kind}:` +
            `${left.team_id || left.user_id || ""}`;
          const rightKey =
            `${right.audience_kind}:` +
            `${right.team_id || right.user_id || ""}`;
          return leftKey.localeCompare(rightKey);
        });
      const persistedAudiences = listOutboxAudiences.all({
        leagueId,
        outboxEventId: id,
      });
      if (
        persistedAudiences.length !== expectedAudiences.length ||
        persistedAudiences.some((audience, index) => {
          const expected = expectedAudiences[index];
          return (
            audience.id !== expected.id ||
            audience.audience_kind !== expected.audience_kind ||
            audience.team_id !== expected.team_id ||
            audience.user_id !== expected.user_id ||
            audience.created_at_ms !== expected.created_at_ms
          );
        }) ||
        countRelatedOutboxesAt.get({
          leagueId,
          occurredAtMs,
          relatedPath,
          relatedId,
        }).count !== 1
      ) {
        incompatible(
          "The canonical FAD auction-start outbox audience is split.",
          "OUTBOX_AUDIENCE_INVALID"
        );
      }
    }

    buildStartContext = function buildStartContextForWriter(scope) {
      const root = unique(
        findRoot,
        scope,
        "FAD auction-start root"
      );
      if (!root) return null;
      const rollover = unique(
        findRollover,
        {
          ...scope,
          seasonId: root.season_id,
          fadId: root.fad_id,
        },
        "current FAD rapid rollover"
      );
      if (!rollover) {
        throw new AuctionCreationPolicyError(
          AUCTION_CREATION_CODES.windowClosed
        );
      }
      const basePlayer = unique(
        findPlayer,
        scope,
        "stable player"
      );
      const correction = unique(
        findPositionCorrection,
        scope,
        "current league-player position"
      );
      const sourcePositions = listSourcePositions.all(scope);
      const positionGroup = correction?.position_group ||
        (sourcePositions.length === 1
          ? sourcePositions[0].position_group
          : null);
      const owned = Boolean(unique(
        findOwnership,
        { ...scope, seasonId: root.season_id },
        "current player ownership"
      ));
      const activeAuctionExists = Boolean(unique(
        findActiveAuction,
        { ...scope, seasonId: root.season_id },
        "active player auction"
      ));
      const released = Boolean(findReleasedRights.get(scope));
      const quarantined = Boolean(findQuarantine.get({
        ...scope,
        seasonId: root.season_id,
      }));
      return deepFreeze({
        sourceKind: SOURCE_KIND,
        authority: {
          currentCommissioner:
            root.current_commissioner === 1,
          fadTeamParticipating:
            root.fad_team_participating === 1,
          leagueStatus: root.league_status,
          managerAssignmentAcceptedAtMs:
            root.assignment_accepted_at_ms,
          managerAssignmentEndedAtMs:
            root.assignment_ended_at_ms,
          managerAssignmentStatus:
            root.assignment_status,
          membershipStatus: root.membership_status,
          teamId: scope.teamId,
          teamStatus: root.team_status,
        },
        player: {
          activeAuctionExists,
          fadEligible:
            basePlayer?.status === "active" &&
            ["F", "D"].includes(positionGroup) &&
            !released,
          id: scope.playerId,
          owned,
          positionGroup,
          quarantined,
          status: basePlayer?.status || null,
        },
        rapidContext: {
          allocationCompletedAtMs:
            root.allocation_completed_at_ms,
          fadId: root.fad_id,
          fadStatus: root.fad_status,
          leagueId: scope.leagueId,
          seasonId: root.season_id,
          seasonStatus: root.season_status,
          rollover: {
            creationCutoffAtMs:
              rollover.creation_cutoff_at_ms,
            fadId: rollover.fad_id,
            id: rollover.id,
            leagueId: rollover.league_id,
            opensAtMs: rollover.opens_at_ms,
            rollsOverAtMs: rollover.rolls_over_at_ms,
            seasonId: rollover.season_id,
            status: rollover.status,
          },
        },
        persistence: {
          candidateCardVersion:
            root.candidate_card_version,
          teamVersion: root.team_version,
        },
      });
    };

    function directResult(row, replayed) {
      if (!row) {
        incompatible(
          "The immutable FAD auction-start result is unavailable.",
          "DIRECT_REPLAY_UNAVAILABLE"
        );
      }
      const metadata = parseStartedMetadata(row.metadata_json);
      if (
        metadata.fadId !== row.fad_id ||
        metadata.fadRolloverId !== row.rollover_id ||
        metadata.openingTeamId !== row.bid_team_id ||
        metadata.bidClosesAtMs !== row.auction_resolves_at_ms ||
        row.auction_opened_at_ms !== row.accepted_at_ms ||
        row.context_created_at_ms !== row.accepted_at_ms ||
        row.event_occurred_at_ms !== row.accepted_at_ms ||
        row.draw_created_at_ms !== row.accepted_at_ms ||
        row.job_scheduled_for_ms !== row.auction_resolves_at_ms ||
        typeof row.commitment_hex !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.commitment_hex)
      ) {
        incompatible(
          "The immutable FAD auction-start result is split.",
          "DIRECT_REPLAY_SPLIT"
        );
      }
      const related = createEmptySocketRelated({
        fadId: row.fad_id,
        teamId: row.bid_team_id,
        auctionId: row.auction_id,
      });
      validatePublication({
        id: directAuctionOutboxEventId(row.auction_id),
        leagueId: row.league_id,
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: row.auction_id,
        version: 1,
        reasonCode: "auction_changed",
        occurredAtMs: row.accepted_at_ms,
        related,
        relatedPath: "$.related.auctionId",
        relatedId: row.auction_id,
        audiences: [Object.freeze({ kind: "league" })],
      });
      return deepFreeze({
        kind: "auction_opened",
        sourceKind: SOURCE_KIND,
        replayed,
        actorAuthority: metadata.actorAuthority,
        leagueId: row.league_id,
        seasonId: row.season_id,
        fadId: row.fad_id,
        sourceRolloverId: row.rollover_id,
        targetOpeningRolloverId: null,
        resolutionRolloverId: row.rollover_id,
        acceptedAtMs: row.accepted_at_ms,
        opensAtMs: row.accepted_at_ms,
        resolvesAtMs: metadata.bidClosesAtMs,
        bindingIllegalityConfirmedAtMs:
          row.accepted_at_ms,
        body: {
          playerId: row.player_id,
          teamId: metadata.openingTeamId,
          totalValueCents: metadata.totalValueCents,
          termYears: metadata.termYears,
          bindingIllegalityConfirmed: true,
        },
        idempotencyRequestId: row.request_id,
        auctionId: row.auction_id,
        openingBidId: row.bid_id,
        auctionEventId: row.event_id,
        drawId: row.draw_id,
        drawCommitmentHex: row.commitment_hex,
        resolutionJobRunId: row.job_run_id,
      });
    }

    function queueResult(row, replayed) {
      if (!row) {
        incompatible(
          "The immutable queued-nomination result is unavailable.",
          "QUEUE_REPLAY_UNAVAILABLE"
        );
      }
      if (
        row.accepted_at_ms < row.creation_cutoff_at_ms ||
        row.accepted_at_ms >= row.opens_at_ms ||
        row.binding_illegality_confirmed !== 1 ||
        row.binding_confirmed_at_ms !== row.accepted_at_ms ||
        row.aav_cents !== calculateAavCents(
          row.total_value_cents,
          row.term_years
        )
      ) {
        incompatible(
          "The immutable queued-nomination result is split.",
          "QUEUE_REPLAY_SPLIT"
        );
      }
      if (row.correction_position_count > 1) {
        incompatible(
          "The queued nomination player has multiple current position corrections.",
          "QUEUE_PLAYER_POSITION_AMBIGUOUS"
        );
      }
      const positionGroup = row.correction_position_count === 1
        ? row.corrected_position_group
        : row.source_position_count === 1
          ? row.source_position_group
          : null;
      if (
        typeof row.player_full_name !== "string" ||
        !["F", "D"].includes(positionGroup) ||
        !UUID_PATTERN.test(row.target_opening_rollover_id || "") ||
        (
          row.resolution_rollover_id !== null &&
          !UUID_PATTERN.test(row.resolution_rollover_id)
        ) ||
        !["queued", "opened", "invalid"].includes(
          row.queue_status
        ) ||
        !Number.isSafeInteger(row.queue_version) ||
        row.queue_version < 1
      ) {
        incompatible(
          "The current queued-nomination projection is unavailable.",
          "QUEUE_PROJECTION_INVALID"
        );
      }
      const related = createEmptySocketRelated({
        fadId: row.fad_id,
        teamId: row.team_id,
        nominationQueueId: row.queue_id,
      });
      const outboxEventId = queuedNominationOutboxEventId(
        row.queue_id
      );
      validatePublication({
        id: outboxEventId,
        leagueId: row.league_id,
        eventType: "fad_nomination_queue.changed",
        aggregateType: "fad_nomination_queue",
        aggregateId: row.queue_id,
        version: 1,
        reasonCode: "nomination_queued",
        occurredAtMs: row.accepted_at_ms,
        related,
        relatedPath: "$.related.nominationQueueId",
        relatedId: row.queue_id,
        audiences: replayed
          ? persistedQueueAudiences(
              row.league_id,
              outboxEventId,
              row.team_id
            )
          : queueAudiences(row.league_id, row.team_id),
      });
      const queuedNomination = {
        queueId: row.queue_id,
        fadId: row.fad_id,
        teamId: row.team_id,
        player: {
          playerId: row.player_id,
          fullName: row.player_full_name,
          positionGroup,
        },
        totalValueCents: row.total_value_cents,
        termYears: row.term_years,
        aavCents: row.aav_cents,
        bindingIllegalityConfirmedAtMs:
          row.binding_confirmed_at_ms,
        acceptedAtMs: row.accepted_at_ms,
        openingRolloverId: row.target_opening_rollover_id,
        resolutionRolloverId: row.resolution_rollover_id,
        status: row.queue_status,
        version: row.queue_version,
      };
      return deepFreeze({
        kind: "nomination_queued",
        sourceKind: SOURCE_KIND,
        replayed,
        actorAuthority: "manager",
        leagueId: row.league_id,
        seasonId: row.season_id,
        fadId: row.fad_id,
        sourceRolloverId: row.rollover_id,
        targetOpeningRolloverId: row.rollover_id,
        resolutionRolloverId: null,
        acceptedAtMs: row.accepted_at_ms,
        opensAtMs: row.opens_at_ms,
        resolvesAtMs: row.opens_at_ms + 86_400_000,
        bindingIllegalityConfirmedAtMs:
          row.accepted_at_ms,
        body: {
          playerId: row.player_id,
          teamId: row.team_id,
          totalValueCents: row.total_value_cents,
          termYears: row.term_years,
          bindingIllegalityConfirmed: true,
        },
        idempotencyRequestId: row.request_id,
        nominationQueueId: row.queue_id,
        activationJobRunId: row.job_run_id,
        queuedNomination,
      });
    }

    function reusedIdempotencyKey() {
      throw new AuctionCreationPolicyError(
        "IDEMPOTENCY_KEY_REUSED"
      );
    }

    function assertReplayAuthority(scope, command) {
      const authority = unique(
        findReplayAuthority,
        {
          leagueId: scope.leagueId,
          teamId: scope.teamId,
          fadId: scope.fadId,
          actorUserId: command.actorUserId,
          actorMembershipId:
            command.actorMembershipId,
          nowMs: command.nowMs,
        },
        "current FAD auction-start replay authority"
      );
      const common =
        authority?.membership_status === "active" &&
        authority.team_status === "active" &&
        authority.fad_team_participating === 1;
      const manager =
        common &&
        authority.league_status === "active" &&
        authority.assignment_status === "accepted" &&
        Number.isSafeInteger(
          authority.assignment_accepted_at_ms
        ) &&
        authority.assignment_accepted_at_ms <=
          command.nowMs &&
        authority.assignment_ended_at_ms === null;
      const commissioner =
        common &&
        ["active", "frozen"].includes(
          authority.league_status
        ) &&
        authority.current_commissioner === 1;
      const allowed = scope.kind === "nomination_queued"
        ? manager
        : manager || commissioner;
      if (!allowed) {
        throw new AuctionCreationPolicyError(
          AUCTION_CREATION_CODES.authorizationDenied
        );
      }
    }

    function replay(idempotency, command) {
      const semanticHash = requestHash(command);
      const hasBindingConfirmation =
        Object.prototype.hasOwnProperty.call(
          command.body,
          "bindingIllegalityConfirmed"
        );
      if (idempotency.status === "started") {
        const possibleFadHash = requestHash({
          ...command,
          body: {
            ...command.body,
            bindingIllegalityConfirmed: true,
          },
        });
        if (
          hasBindingConfirmation ||
          idempotency.request_hash === possibleFadHash
        ) {
          if (idempotency.request_hash !== semanticHash) {
            reusedIdempotencyKey();
          }
          throw new AuctionCreationPolicyError(
            AUCTION_CREATION_CODES.idempotencyConflict
          );
        }
        return FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE;
      }
      if (
        idempotency.status !== "completed" ||
        !idempotency.result_id
      ) {
        return FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE;
      }
      const parameters = {
        leagueId: command.leagueId,
        actorUserId: command.actorUserId,
        idempotencyRequestId: idempotency.id,
      };
      let result;
      if (idempotency.result_type === "auction") {
        const source = unique(
          findAuctionSource,
          {
            leagueId: command.leagueId,
            resultId: idempotency.result_id,
          },
          "auction-start result source"
        );
        if (source?.source_kind === "ordinary_weekly") {
          return FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE;
        }
        if (
          source?.source_kind !== SOURCE_KIND ||
          source.fad_origin !== "manager_nomination" ||
          source.fad_allocation_id !== null
        ) {
          incompatible(
            "The completed auction-start result has no valid source.",
            "START_RESULT_SOURCE_INVALID"
          );
        }
        if (idempotency.request_hash !== semanticHash) {
          reusedIdempotencyKey();
        }
        const replayScope = unique(
          findDirectReplayScope,
          parameters,
          "immutable direct auction-start replay scope"
        );
        if (!replayScope) {
          incompatible(
            "The immutable direct auction-start replay scope is unavailable.",
            "DIRECT_REPLAY_SCOPE_UNAVAILABLE"
          );
        }
        assertReplayAuthority({
          kind: "auction_opened",
          leagueId: replayScope.league_id,
          fadId: replayScope.fad_id,
          teamId: replayScope.team_id,
        }, command);
        result = directResult(
          unique(
            findDirectReplay,
            parameters,
            "immutable direct auction-start replay"
          ),
          true
        );
      } else if (
        idempotency.result_type === "fad_nomination_queue"
      ) {
        if (idempotency.request_hash !== semanticHash) {
          reusedIdempotencyKey();
        }
        const replayScope = unique(
          findQueueReplayScope,
          parameters,
          "immutable nomination-queue replay scope"
        );
        if (!replayScope) {
          incompatible(
            "The immutable nomination-queue replay scope is unavailable.",
            "QUEUE_REPLAY_SCOPE_UNAVAILABLE"
          );
        }
        assertReplayAuthority({
          kind: "nomination_queued",
          leagueId: replayScope.league_id,
          fadId: replayScope.fad_id,
          teamId: replayScope.team_id,
        }, command);
        result = queueResult(
          unique(
            findQueueReplay,
            parameters,
            "immutable nomination-queue replay"
          ),
          true
        );
      } else {
        return FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE;
      }
      return result;
    }

    function nextId(description, values) {
      const value = canonicalId(
        createId({ description }),
        description
      );
      if (values.has(value)) {
        invalid(
          "FAD auction-start identifier factories must return distinct values.",
          "IDENTIFIER_FACTORY_COLLISION"
        );
      }
      values.add(value);
      return value;
    }

    function invokeBeforeCommit(result) {
      if (!beforeCommit) return;
      const returned = beforeCommit(result);
      if (returned && typeof returned.then === "function") {
        invalid(
          "FAD auction-start beforeCommit must be synchronous.",
          "BEFORE_COMMIT_ASYNC"
        );
      }
    }

    writeTransaction = database.transaction((command) => {
      const idempotency = unique(
        findIdempotency,
        command,
        "FAD auction-start idempotency scope"
      );
      if (idempotency) return replay(idempotency, command);

      const context = buildStartContext({
        leagueId: command.leagueId,
        teamId: command.body.teamId,
        playerId: command.body.playerId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        nowMs: command.nowMs,
      });
      if (!context) {
        return FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE;
      }
      const decision = decideFreeAgentDraftAuctionStart({
        body: command.body,
        authority: context.authority,
        nowMs: command.nowMs,
        player: context.player,
        rapidContext: context.rapidContext,
      });
      const ids = new Set();
      const idempotencyRequestId = nextId(
        "auction-start idempotency request",
        ids
      );
      const common = {
        ...command,
        ...decision,
        teamId: decision.body.teamId,
        playerId: decision.body.playerId,
        totalValueCents:
          decision.body.totalValueCents,
        termYears: decision.body.termYears,
        aavCents: calculateAavCents(
          decision.body.totalValueCents,
          decision.body.termYears
        ),
        idempotencyRequestId,
        requestHash: requestHash(command),
        actorMembershipId: command.actorMembershipId,
      };
      insertIdempotency.run(common);

      let result;
      if (decision.kind === "auction_opened") {
        const auctionId = nextId("auction", ids);
        const drawId = nextId("auction draw", ids);
        const bidId = nextId("opening bid", ids);
        const eventId = nextId("auction-start event", ids);
        const jobRunId = nextId("auction-resolution job", ids);
        let nonceBytes = createDrawNonce({
          leagueId: decision.leagueId,
          seasonId: decision.seasonId,
          fadId: decision.fadId,
          auctionId,
        });
        if (
          !(nonceBytes instanceof Uint8Array) ||
          nonceBytes.byteLength !== 32
        ) {
          invalid(
            "FAD auction-start draw nonce factories must return exactly 32 bytes.",
            "DRAW_NONCE_INVALID"
          );
        }
        nonceBytes = Buffer.from(nonceBytes);
        const commitmentHex =
          createFreeAgentDraftAuctionDrawCommitment({
            auctionId,
            nonceBytes,
          }).commitmentHex;
        const write = {
          ...common,
          auctionId,
          drawId,
          bidId,
          eventId,
          jobRunId,
          nonceBytes,
          commitmentHex,
          jobType: RESOLUTION_JOB_TYPE,
          occurrenceKey:
            `auction:${auctionId}:${decision.resolvesAtMs}`,
          scheduledForMs: decision.resolvesAtMs,
          metadataJson: JSON.stringify({
            openingTeamId: decision.body.teamId,
            actorMembershipId:
              command.actorMembershipId,
            actorAuthority: decision.actorAuthority,
            playerPosition:
              context.player.positionGroup,
            creationCutoffAtMs:
              context.rapidContext.rollover
                .creationCutoffAtMs,
            bidClosesAtMs: decision.resolvesAtMs,
            totalValueCents:
              decision.body.totalValueCents,
            termYears: decision.body.termYears,
            aavCents: common.aavCents,
            bindingIllegalityConfirmed: true,
            fadId: decision.fadId,
            fadRolloverId:
              decision.sourceRolloverId,
          }),
        };
        insertAuction.run(write);
        insertContext.run(write);
        insertDraw.run(write);
        insertBid.run(write);
        insertEvent.run(write);
        insertJob.run(write);
        writePublication({
          id: directAuctionOutboxEventId(auctionId),
          leagueId: command.leagueId,
          eventType: "auction.changed",
          aggregateType: "auction",
          aggregateId: auctionId,
          version: 1,
          reasonCode: "auction_changed",
          occurredAtMs: command.nowMs,
          related: createEmptySocketRelated({
            fadId: decision.fadId,
            teamId: decision.body.teamId,
            auctionId,
          }),
          audiences: [Object.freeze({ kind: "league" })],
        });
        if (completeDirect.run(write).changes !== 1) {
          conflict(
            "The FAD auction-start request could not complete.",
            "IDEMPOTENCY_COMPLETION_CONFLICT"
          );
        }
        result = directResult(
          unique(
            findDirectReplay,
            {
              leagueId: command.leagueId,
              actorUserId: command.actorUserId,
              idempotencyRequestId,
            },
            "direct FAD auction-start result"
          ),
          false
        );
      } else {
        if (
          !Number.isSafeInteger(
            context.persistence.candidateCardVersion
          ) ||
          context.persistence.candidateCardVersion < 1 ||
          !Number.isSafeInteger(
            context.persistence.teamVersion
          ) ||
          context.persistence.teamVersion < 1
        ) {
          conflict(
            "The nomination queue lacks current team/card evidence.",
            "QUEUE_VERSION_EVIDENCE_UNAVAILABLE"
          );
        }
        const queueId = nextId("nomination queue", ids);
        const jobRunId = nextId(
          "queued-nomination activation job",
          ids
        );
        const write = {
          ...common,
          queueId,
          jobRunId,
          candidateCardVersion:
            context.persistence.candidateCardVersion,
          teamVersion: context.persistence.teamVersion,
          jobType: ACTIVATION_JOB_TYPE,
          occurrenceKey:
            `fad:${decision.fadId}:nomination-open:` +
            `${queueId}:${decision.opensAtMs}`,
          scheduledForMs: decision.opensAtMs,
        };
        insertJob.run(write);
        insertQueue.run(write);
        writePublication({
          id: queuedNominationOutboxEventId(queueId),
          leagueId: command.leagueId,
          eventType: "fad_nomination_queue.changed",
          aggregateType: "fad_nomination_queue",
          aggregateId: queueId,
          version: 1,
          reasonCode: "nomination_queued",
          occurredAtMs: command.nowMs,
          related: createEmptySocketRelated({
            fadId: decision.fadId,
            teamId: decision.body.teamId,
            nominationQueueId: queueId,
          }),
          audiences: queueAudiences(
            command.leagueId,
            decision.body.teamId
          ),
        });
        result = queueResult(
          unique(
            findQueueReplay,
            {
              leagueId: command.leagueId,
              actorUserId: command.actorUserId,
              idempotencyRequestId,
            },
            "queued FAD nomination result"
          ),
          false
        );
      }
      invokeBeforeCommit(result);
      return result;
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareFreeAgentDraftAuctionStartWriter",
      tableName: "idempotency_requests",
    });
  }

  return Object.freeze({
    findStartContext(input) {
      const scope = normalizeScope(input);
      try {
        const context = buildStartContext(scope);
        if (!context) return null;
        return deepFreeze({
          sourceKind: context.sourceKind,
          authority: context.authority,
          player: context.player,
          rapidContext: context.rapidContext,
        });
      } catch (error) {
        if (error instanceof AuctionCreationPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "findFreeAgentDraftAuctionStartContext",
          tableName: "free_agent_drafts",
        });
      }
    },

    startOrQueue(input) {
      const command = normalizeCommand(input);
      try {
        return writeTransaction.immediate(command);
      } catch (error) {
        if (error instanceof AuctionCreationPolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "startOrQueueFreeAgentDraftAuction",
          tableName: "idempotency_requests",
        });
      }
    },
  });
}

module.exports = {
  FREE_AGENT_DRAFT_AUCTION_START_OPERATION: OPERATION,
  FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE,
  FREE_AGENT_DRAFT_AUCTION_START_SOURCE_KIND: SOURCE_KIND,
  FREE_AGENT_DRAFT_AUCTION_START_WRITER_METHODS,
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_JOB_TYPE:
    ACTIVATION_JOB_TYPE,
  createSqliteFreeAgentDraftAuctionStartWriter,
};
