"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

const {
  createNormalContractAggregate,
} = require("../../../domain/contracts/contractPolicy");
const {
  planContractSeasons,
} = require("../../../domain/contracts/contractSeasonPlanner");
const {
  createRosterAssignmentRecord,
} = require("../../../domain/rosters/rosterAssignmentPolicy");
const {
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  hashFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionApplyRequest,
  validateFreeAgentDraftCorrectionApplyCommand,
  validateFreeAgentDraftCorrectionApplyResult,
  validateFreeAgentDraftCorrectionPreview,
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
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
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
  createSqliteFreeAgentDraftCorrectionPreviewRepository,
} = require("./SqliteFreeAgentDraftCorrectionPreviewRepository");
const {
  createSqliteFreeAgentDraftReadRepository,
} = require("./SqliteFreeAgentDraftReadRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const BUYOUT_LOCK_MS = 14 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_OPERATION =
  "free_agent_draft.allocation.correction";
const RESULT_TYPE =
  "free_agent_draft_allocation_correction_command_result";
const REPLAY_FIELDS = Object.freeze([
  "actorAuthority",
  "actorMembershipId",
  "actorUserId",
  "allocationId",
  "body",
  "clientKey",
  "expectedAllocationVersion",
  "fadId",
  "leagueId",
  "requestJson",
  "requestSha256",
]);
const WRITE_FIELDS = Object.freeze([
  ...REPLAY_FIELDS,
  "commandResultId",
  "completedAtMs",
  "idempotencyExpiresAtMs",
  "idempotencyRequestId",
]);
const ACTOR_AUTHORITIES = new Set([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const TERMINAL_RECOMPUTED_STATUSES = new Set([
  "automatic_award",
  "no_valid_offer",
]);

const FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied:
      "FAD_CORRECTION_AUTHORIZATION_DENIED",
    idempotencyConflict: "IDEMPOTENCY_KEY_REUSED",
    notApplicable: "FAD_CORRECTION_NOT_APPLICABLE",
  });

function invalid(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(
    createHash("sha256").update(namespace, "utf8").digest().subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-${hex.slice(16, 20)}-` +
    hex.slice(20)
  );
}

function correctionPublicationIds(correctionId, activityId) {
  return Object.freeze({
    fad: deterministicUuid(
      `fad-allocation-correction:fad:${correctionId}`
    ),
    activity: deterministicUuid(
      `fad-allocation-correction:activity:${activityId}`
    ),
  });
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
    FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
      .authorizationDenied,
    "Current commissioner authority is required to apply a FAD allocation correction."
  );
}

function notFound() {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    "The scoped FAD allocation was not found."
  );
}

function conflict(message, currentVersion) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    currentVersion === undefined
      ? undefined
      : {
          details: {
            currentVersion,
            refetch: true,
          },
        }
  );
}

function notApplicable(message) {
  throw repositoryError(
    FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
      .notApplicable,
    message ||
      "The FAD allocation correction is no longer safely applicable."
  );
}

function idempotencyConflict() {
  throw repositoryError(
    FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
      .idempotencyConflict,
    "The idempotency key was already used with different input."
  );
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

function exactObject(value, fields, description) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    invalid(`An exact ${description} is required.`);
  }
  return value;
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function lowercaseSha256(value, description) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value)
  ) {
    invalid(`A lowercase ${description} is required.`);
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive allocation version is required.");
  }
  return value;
}

function normalizeIdentity(input, fields) {
  exactObject(
    input,
    fields,
    fields === WRITE_FIELDS
      ? "FAD allocation-correction write input"
      : "FAD allocation-correction replay input"
  );
  let command;
  try {
    command = validateFreeAgentDraftCorrectionApplyCommand({
      allocationId: input.allocationId,
      body: input.body,
      expectedAllocationVersion:
        input.expectedAllocationVersion,
      fadId: input.fadId,
      idempotencyKey: input.clientKey,
      leagueId: input.leagueId,
    });
  } catch (error) {
    invalid(
      "The FAD allocation-correction command is invalid.",
      error
    );
  }
  const requestJson =
    serializeFreeAgentDraftCorrectionApplyRequest(command);
  const requestSha256 =
    hashFreeAgentDraftCorrectionApplyRequest(command);
  if (
    input.requestJson !== requestJson ||
    lowercaseSha256(
      input.requestSha256,
      "FAD allocation-correction request hash"
    ) !== requestSha256
  ) {
    invalid(
      "The FAD allocation-correction request evidence is not canonical."
    );
  }
  if (!ACTOR_AUTHORITIES.has(input.actorAuthority)) {
    invalid(
      "A canonical FAD allocation-correction authority is required."
    );
  }
  return deepFreeze({
    actorAuthority: input.actorAuthority,
    actorMembershipId: stableId(
      input.actorMembershipId,
      "actor membership identifier"
    ),
    actorUserId: stableId(
      input.actorUserId,
      "actor user identifier"
    ),
    allocationId: command.allocationId,
    body: command.body,
    clientKey: command.idempotencyKey,
    expectedAllocationVersion: positiveVersion(
      command.expectedAllocationVersion
    ),
    fadId: command.fadId,
    leagueId: command.leagueId,
    requestJson,
    requestSha256,
  });
}

function normalizeReplayInput(input) {
  return normalizeIdentity(input, REPLAY_FIELDS);
}

function normalizeWriteInput(input) {
  const identity = normalizeIdentity(input, WRITE_FIELDS);
  const completedAtMs = safeTimestamp(
    input.completedAtMs,
    "correction completion timestamp"
  );
  if (completedAtMs > MAXIMUM_TIMESTAMP_MS - BUYOUT_LOCK_MS) {
    invalid(
      "The correction completion timestamp cannot support the required buyout lock."
    );
  }
  const idempotencyExpiresAtMs = safeTimestamp(
    input.idempotencyExpiresAtMs,
    "idempotency expiry timestamp"
  );
  if (idempotencyExpiresAtMs <= completedAtMs) {
    invalid(
      "FAD allocation-correction idempotency must expire after completion."
    );
  }
  const commandResultId = stableId(
    input.commandResultId,
    "command-result identifier"
  );
  const idempotencyRequestId = stableId(
    input.idempotencyRequestId,
    "idempotency-request identifier"
  );
  if (commandResultId === idempotencyRequestId) {
    invalid(
      "FAD allocation-correction receipt identifiers must be unique."
    );
  }
  return deepFreeze({
    ...identity,
    commandResultId,
    completedAtMs,
    idempotencyExpiresAtMs,
    idempotencyRequestId,
  });
}

function requireChanged(result, message) {
  if (result.changes !== 1) conflict(message);
}

function unique(rows, description) {
  if (rows.length > 1) {
    incompatible(`${description} is ambiguous.`);
  }
  return rows[0] || null;
}

function generatedId(createId, description) {
  const id = createId(description);
  if (!UUID_PATTERN.test(id || "")) {
    incompatible(
      `A canonical ${description} could not be generated.`
    );
  }
  return id;
}

function assertSynchronousFailureInjector(
  failureInjector,
  seam
) {
  const result = failureInjector(seam);
  if (result && typeof result.then === "function") {
    throw new TypeError(
      "FAD allocation-correction failure injection must be synchronous."
    );
  }
}

function afterSummaryTeam(decision) {
  if (!decision.winner) return null;
  return (
    decision.rankedOffers.find(
      (offer) => offer.teamId === decision.winner.teamId
    )?.team || null
  );
}

function appliedDeltas(preview, activityId) {
  const winner = preview.recomputedDecision.winner;
  return Object.freeze(
    preview.deltas.map((delta) => {
      let resourceId = delta.resourceId;
      if (resourceId === null) {
        if (delta.resourceType === "contract") {
          resourceId = winner?.contractId ?? null;
        } else if (
          delta.resourceType === "ownership" ||
          delta.resourceType === "roster_entry"
        ) {
          resourceId = winner?.ownershipId ?? null;
        } else if (delta.resourceType === "activity") {
          resourceId = activityId;
        }
      }
      if (resourceId === null) {
        incompatible(
          "A materialized correction delta is missing its resource identity."
        );
      }
      return Object.freeze({ ...delta, resourceId });
    })
  );
}

function rosterCategoryForWinner(winner) {
  if (!winner) return null;
  return winner.slotKey.startsWith("B")
    ? "Bench"
    : "Active";
}

function slotNumberForWinner(winner) {
  if (!winner) return null;
  const value = Number(winner.slotKey.slice(1));
  if (!Number.isSafeInteger(value) || value < 1) {
    incompatible(
      "The corrected Candidate destination slot is invalid."
    );
  }
  return value;
}

function createSqliteFreeAgentDraftAllocationCorrectionRepository({
  database,
  previewRepository,
  readRepository,
  createId = () => randomUUID(),
  leagueOutboxWriter,
  failureInjector = () => {},
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftAllocationCorrectionRepository requires an opened database"
    );
  }
  if (typeof createId !== "function") {
    throw new TypeError(
      "FAD allocation correction requires a synchronous identifier generator"
    );
  }
  if (typeof failureInjector !== "function") {
    throw new TypeError(
      "FAD allocation correction requires a synchronous failure injector"
    );
  }

  const previewReader =
    previewRepository === undefined
      ? createSqliteFreeAgentDraftCorrectionPreviewRepository({
          database,
        })
      : previewRepository;
  const publishedReader =
    readRepository === undefined
      ? createSqliteFreeAgentDraftReadRepository({ database })
      : readRepository;
  if (
    !previewReader ||
    typeof previewReader.previewAllocationCorrection !==
      "function"
  ) {
    throw new TypeError(
      "FAD allocation correction requires a preview repository"
    );
  }
  if (
    !publishedReader ||
    typeof publishedReader.readAllocationResults !== "function"
  ) {
    throw new TypeError(
      "FAD allocation correction requires a published-result repository"
    );
  }

  let statements;
  let outbox;
  let replayTransaction;
  let applyTransaction;
  try {
    statements = Object.freeze({
      authority: database.prepare(`
        SELECT
          league.status AS league_status,
          league.commissioner_membership_id,
          actor.status AS actor_status,
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
        JOIN users AS actor
          ON actor.id = @actorUserId
        LEFT JOIN league_memberships AS membership
          ON membership.league_id = league.id
         AND membership.id = @actorMembershipId
         AND membership.user_id = @actorUserId
         AND membership.status = 'active'
         AND membership.joined_at_ms IS NOT NULL
         AND membership.ended_at_ms IS NULL
        WHERE league.id = @leagueId
        LIMIT 2
      `),
      idempotency: database.prepare(`
        SELECT *
        FROM idempotency_requests
        WHERE league_id = @leagueId
          AND actor_user_id = @actorUserId
          AND operation = '${IDEMPOTENCY_OPERATION}'
          AND client_key = @clientKey
        LIMIT 2
      `),
      result: database.prepare(`
        SELECT *
        FROM free_agent_draft_allocation_correction_command_results
        WHERE league_id = @leagueId
          AND id = @resultId
        LIMIT 2
      `),
      receiptEvidence: database.prepare(`
        SELECT
          correction.feature,
          correction.feature_record_id,
          correction.actor_user_id AS correction_actor_user_id,
          correction.reason AS correction_reason,
          correction.before_snapshot_json AS correction_before_snapshot_json,
          correction.after_snapshot_json AS correction_after_snapshot_json,
          correction.corrected_at_ms,
          activity.actor_user_id AS activity_actor_user_id,
          activity.actor_authority AS activity_actor_authority,
          activity.related_type,
          activity.related_id,
          activity.occurred_at_ms AS activity_occurred_at_ms,
          event.event_kind,
          event.decision_code AS event_decision_code,
          event.resulting_allocation_status,
          event.contract_id AS event_contract_id,
          event.ownership_id AS event_ownership_id,
          event.actor_user_id AS event_actor_user_id,
          event.actor_membership_id AS event_actor_membership_id,
          event.actor_authority AS event_actor_authority,
          event.activity_id AS event_activity_id,
          event.occurred_at_ms AS event_occurred_at_ms
        FROM free_agent_draft_allocation_correction_command_results AS result
        JOIN commissioner_corrections AS correction
          ON correction.league_id = result.league_id
         AND correction.season_id = result.season_id
         AND correction.id = result.commissioner_correction_id
        JOIN league_activity AS activity
          ON activity.league_id = result.league_id
         AND activity.season_id = result.season_id
         AND activity.id = result.activity_id
        JOIN free_agent_draft_allocation_events AS event
          ON event.league_id = result.league_id
         AND event.season_id = result.season_id
         AND event.fad_id = result.fad_id
         AND event.allocation_id = result.allocation_id
         AND event.allocation_version =
              result.resulting_allocation_version
         AND event.player_id = result.player_id
         AND event.correction_id =
              result.commissioner_correction_id
        WHERE result.league_id = @leagueId
          AND result.id = @resultId
        LIMIT 2
      `),
      publication: database.prepare(`
        SELECT
          event.*,
          audience.audience_kind,
          audience.team_id AS audience_team_id,
          audience.user_id AS audience_user_id
        FROM outbox_events AS event
        JOIN outbox_event_audiences AS audience
          ON audience.league_id = event.league_id
         AND audience.outbox_event_id = event.id
        WHERE event.league_id = @leagueId
          AND event.id = @eventId
        ORDER BY audience.id
      `),
      context: database.prepare(`
        SELECT
          allocation.*,
          fad.status AS fad_status,
          fad.version AS fad_version,
          fad.deadline_locked_at_ms,
          player.full_name AS player_full_name,
          season.label AS season_label,
          season.nhl_season_key,
          season.status AS season_status
        FROM free_agent_draft_player_allocations AS allocation
        JOIN free_agent_drafts AS fad
          ON fad.league_id = allocation.league_id
         AND fad.season_id = allocation.season_id
         AND fad.id = allocation.fad_id
        JOIN players AS player
          ON player.id = allocation.player_id
        JOIN seasons AS season
          ON season.league_id = allocation.league_id
         AND season.id = allocation.season_id
        WHERE allocation.league_id = @leagueId
          AND allocation.fad_id = @fadId
          AND allocation.id = @allocationId
        LIMIT 2
      `),
      seasons: database.prepare(`
        SELECT id, league_id, label, nhl_season_key, status
        FROM seasons
        WHERE league_id = @leagueId
        ORDER BY nhl_season_key, id
      `),
      contract: database.prepare(`
        SELECT *
        FROM contracts
        WHERE league_id = @leagueId
          AND id = @contractId
        LIMIT 2
      `),
      contractYears: database.prepare(`
        SELECT *
        FROM contract_years
        WHERE league_id = @leagueId
          AND contract_id = @contractId
        ORDER BY year_number, id
      `),
      ownership: database.prepare(`
        SELECT *
        FROM player_ownerships
        WHERE league_id = @leagueId
          AND id = @ownershipId
        LIMIT 2
      `),
      displayEntries: database.prepare(`
        SELECT *
        FROM roster_display_order_entries
        WHERE league_id = @leagueId
          AND ownership_id = @ownershipId
        ORDER BY id
      `),
      recoveries: database.prepare(`
        SELECT *
        FROM free_agent_draft_recoveries
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
        ORDER BY created_at_ms, id
      `),
      linkedAuction: database.prepare(`
        SELECT
          auction.*,
          context.source_kind,
          context.fad_origin,
          context.fad_rollover_id,
          (SELECT COUNT(*)
             FROM auction_bids AS bid
            WHERE bid.league_id = auction.league_id
              AND bid.auction_id = auction.id) AS bid_count,
          (SELECT COUNT(*)
             FROM auction_resolutions AS resolution
            WHERE resolution.league_id = auction.league_id
              AND resolution.auction_id = auction.id) AS resolution_count,
          (SELECT COUNT(*)
             FROM free_agent_draft_draws AS draw
            WHERE draw.league_id = auction.league_id
              AND draw.auction_id = auction.id) AS draw_count
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id = auction.league_id
         AND context.season_id = auction.season_id
         AND context.auction_id = auction.id
        WHERE auction.league_id = @leagueId
          AND auction.season_id = @seasonId
          AND auction.id = @auctionId
          AND context.fad_id = @fadId
          AND context.fad_allocation_id = @allocationId
        LIMIT 2
      `),
      draw: database.prepare(`
        SELECT *
        FROM free_agent_draft_draws
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND auction_id = @auctionId
        LIMIT 2
      `),
      insertIdempotency: database.prepare(`
        INSERT INTO idempotency_requests (
          id, league_id, actor_user_id, operation,
          client_key, request_hash, status,
          result_type, result_id, created_at_ms,
          completed_at_ms, expires_at_ms
        ) VALUES (
          @idempotencyRequestId, @leagueId, @actorUserId,
          '${IDEMPOTENCY_OPERATION}', @clientKey,
          @requestSha256, 'started', NULL, NULL,
          @completedAtMs, NULL, @idempotencyExpiresAtMs
        )
      `),
      insertCorrection: database.prepare(`
        INSERT INTO commissioner_corrections (
          id, league_id, season_id, feature,
          feature_record_id, actor_user_id, reason,
          before_snapshot_json, after_snapshot_json,
          corrected_at_ms
        ) VALUES (
          @correctionId, @leagueId, @seasonId,
          'free_agent_draft_allocation', @allocationId,
          @actorUserId, @reason, @beforeSnapshotJson,
          @afterSnapshotJson, @completedAtMs
        )
      `),
      auctionToResolving: database.prepare(`
        UPDATE auctions
        SET status = 'resolving',
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @auctionId
          AND status = 'open'
          AND version = @expectedVersion
      `),
      insertAuctionEvent: database.prepare(`
        INSERT INTO auction_events (
          id, league_id, season_id, auction_id,
          bid_id, team_id, actor_user_id, event_type,
          metadata_json, occurred_at_ms
        ) VALUES (
          @eventId, @leagueId, @seasonId, @auctionId,
          NULL, NULL, @actorUserId, 'auction_cancelled',
          @metadataJson, @completedAtMs
        )
      `),
      insertAuctionResolution: database.prepare(`
        INSERT INTO auction_resolutions (
          id, league_id, season_id, auction_id,
          scheduled_occurrence_key, outcome_code,
          winning_team_id, winning_bid_id,
          highest_bid_cents, second_price_input_cents,
          final_contract_value_cents, winning_term_years,
          final_aav_cents, general_illegal, warnings_json,
          contract_id, ownership_id, trigger_type,
          triggered_by_user_id, idempotency_key, status,
          resolved_at_ms
        ) VALUES (
          @resolutionId, @leagueId, @seasonId, @auctionId,
          @occurrenceKey, 'recovered', NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, 0, '[]',
          NULL, NULL, 'commissioner', @actorUserId,
          @resolutionIdempotencyKey, 'cancelled',
          @completedAtMs
        )
      `),
      revealEmptyDraw: database.prepare(`
        UPDATE free_agent_draft_draws
        SET ordered_tied_bid_ids_json = '[]',
            ordered_tied_team_ids_json = '[]',
            rejection_counter = NULL,
            selected_index = NULL,
            selected_bid_id = NULL,
            selected_team_id = NULL,
            selected_digest_hex = NULL,
            revealed_at_ms = @completedAtMs,
            updated_at_ms = @completedAtMs,
            version = 2
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND auction_id = @auctionId
          AND version = 1
          AND revealed_at_ms IS NULL
          AND ordered_tied_bid_ids_json IS NULL
          AND ordered_tied_team_ids_json IS NULL
          AND rejection_counter IS NULL
          AND selected_index IS NULL
          AND selected_bid_id IS NULL
          AND selected_team_id IS NULL
          AND selected_digest_hex IS NULL
      `),
      cancelResolvingAuction: database.prepare(`
        UPDATE auctions
        SET status = 'cancelled',
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @auctionId
          AND status = 'resolving'
          AND version = @expectedVersion
      `),
      cancelContract: database.prepare(`
        UPDATE contracts
        SET status = 'cancelled',
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @contractId
          AND player_id = @playerId
          AND current_team_id = @teamId
          AND status = 'active'
          AND acquisition_source_type =
            'free_agent_draft_allocation'
          AND acquisition_source_id = @allocationId
          AND version = @expectedVersion
      `),
      eliminateContractYears: database.prepare(`
        UPDATE contract_years
        SET status = 'eliminated',
            rollover_at_ms = @completedAtMs
        WHERE league_id = @leagueId
          AND contract_id = @contractId
          AND status IN ('current', 'future')
      `),
      insertContractEvent: database.prepare(`
        INSERT INTO contract_events (
          id, league_id, contract_id, player_id, team_id,
          actor_user_id, event_type, source_type, source_id,
          metadata_json, reason, occurred_at_ms
        ) VALUES (
          @id, @league_id, @contract_id, @player_id,
          @team_id, @actor_user_id, @event_type,
          @source_type, @source_id, @metadata_json,
          @reason, @occurred_at_ms
        )
      `),
      deleteDisplayEntries: database.prepare(`
        DELETE FROM roster_display_order_entries
        WHERE league_id = @leagueId
          AND ownership_id = @ownershipId
      `),
      deleteOwnership: database.prepare(`
        DELETE FROM player_ownerships
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @ownershipId
          AND player_id = @playerId
          AND team_id = @teamId
          AND acquired_transaction_type =
            'free_agent_draft_allocation'
          AND acquired_transaction_id = @allocationId
          AND version = @expectedVersion
      `),
      insertOwnershipEvent: database.prepare(`
        INSERT INTO ownership_events (
          id, league_id, season_id, player_id, team_id,
          ownership_id, event_type, actor_user_id,
          source_type, source_id, before_metadata_json,
          after_metadata_json, reason, occurred_at_ms
        ) VALUES (
          @id, @leagueId, @seasonId, @playerId, @teamId,
          @ownershipId, @eventType, @actorUserId,
          @sourceType, @sourceId, @beforeMetadataJson,
          @afterMetadataJson, @reason, @completedAtMs
        )
      `),
      insertSeason: database.prepare(`
        INSERT INTO seasons (
          id, league_id, label, nhl_season_key, status,
          regular_season_starts_at_ms,
          regular_season_ends_at_ms,
          fantasy_playoffs_start_at_ms,
          fantasy_playoffs_end_at_ms,
          free_agent_draft_completed_at_ms,
          created_at_ms, updated_at_ms, version
        ) VALUES (
          @id, @leagueId, @label, @nhlSeasonKey, @status,
          NULL, NULL, NULL, NULL, NULL,
          @createdAtMs, @updatedAtMs, @version
        )
      `),
      insertContract: database.prepare(`
        INSERT INTO contracts (
          id, league_id, player_id, current_team_id,
          contract_type, original_total_value_cents,
          original_term_years, aav_cents, start_season_id,
          status, acquisition_source_type,
          acquisition_source_id,
          auction_buyout_lock_expires_at_ms,
          created_at_ms, updated_at_ms, version
        ) VALUES (
          @id, @league_id, @player_id, @current_team_id,
          @contract_type, @original_total_value_cents,
          @original_term_years, @aav_cents, @start_season_id,
          @status, @acquisition_source_type,
          @acquisition_source_id,
          @auction_buyout_lock_expires_at_ms,
          @created_at_ms, @updated_at_ms, @version
        )
      `),
      insertContractYear: database.prepare(`
        INSERT INTO contract_years (
          id, league_id, contract_id, season_id,
          year_number, aav_cents, status,
          rollover_at_ms, created_at_ms
        ) VALUES (
          @id, @league_id, @contract_id, @season_id,
          @year_number, @aav_cents, @status,
          @rollover_at_ms, @created_at_ms
        )
      `),
      insertOwnership: database.prepare(`
        INSERT INTO player_ownerships (
          id, league_id, season_id, player_id, team_id,
          ownership_kind, roster_category, position_group,
          slot_number, acquired_transaction_type,
          acquired_transaction_id, created_at_ms,
          updated_at_ms, version, trade_blocked
        ) VALUES (
          @id, @league_id, @season_id, @player_id,
          @team_id, @ownership_kind, @roster_category,
          @position_group, @slot_number,
          @acquired_transaction_type,
          @acquired_transaction_id, @created_at_ms,
          @updated_at_ms, @version, 0
        )
      `),
      updateAllocation: database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = @status,
            decision_code = 'corrected',
            winning_snapshot_entry_id =
              @winningSnapshotEntryId,
            winning_team_id = @winningTeamId,
            contract_id = @contractId,
            ownership_id = @ownershipId,
            accounted_at_ms = @completedAtMs,
            last_error_code = NULL,
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
          AND player_id = @playerId
          AND status <> 'pending'
          AND version = @expectedAllocationVersion
      `),
      insertAllocationEvent: database.prepare(`
        INSERT INTO free_agent_draft_allocation_events (
          id, league_id, season_id, fad_id, allocation_id,
          allocation_version, player_id, event_kind,
          snapshot_entry_id, team_id, offer_valid,
          rank_position, offer_outcome_code, decision_code,
          resulting_allocation_status, contract_id,
          ownership_id, auction_id, activity_id,
          correction_id, actor_user_id,
          actor_membership_id, actor_authority,
          evidence_json, occurred_at_ms, created_at_ms,
          version
        ) VALUES (
          @eventId, @leagueId, @seasonId, @fadId,
          @allocationId, @allocationVersion, @playerId,
          @eventKind, @snapshotEntryId, @teamId,
          @offerValid, @rankPosition, @offerOutcomeCode,
          @decisionCode, @resultingAllocationStatus,
          @contractId, @ownershipId, @auctionId,
          @activityId, @correctionId, @eventActorUserId,
          @eventActorMembershipId, @eventActorAuthority,
          @evidenceJson, @completedAtMs, @completedAtMs, 1
        )
      `),
      startRecovery: database.prepare(`
        UPDATE free_agent_draft_recoveries
        SET status = 'running',
            commissioner_reason = @reason,
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND id = @recoveryId
          AND status = @expectedStatus
          AND version = @expectedVersion
      `),
      resolveRecovery: database.prepare(`
        UPDATE free_agent_draft_recoveries
        SET status = 'resolved',
            last_error_code = NULL,
            commissioner_reason = @reason,
            resolved_by_user_id = @actorUserId,
            resolved_by_membership_id = @actorMembershipId,
            resolved_authority = @actorAuthority,
            resolved_at_ms = @completedAtMs,
            updated_at_ms = @completedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND id = @recoveryId
          AND status = 'running'
          AND version = @expectedVersion
      `),
      insertActivity: database.prepare(`
        INSERT INTO league_activity (
          id, league_id, season_id, event_type,
          actor_user_id, actor_authority, team_id,
          player_id, related_type, related_id,
          display_summary, reason, metadata_json,
          occurred_at_ms
        ) VALUES (
          @activityId, @leagueId, @seasonId,
          @eventType, @actorUserId,
          @actorAuthority, @winningTeamId, @playerId,
          'free_agent_draft_allocation', @allocationId,
          @displaySummary, @reason, @metadataJson,
          @completedAtMs
        )
      `),
      insertResult: database.prepare(`
        INSERT INTO free_agent_draft_allocation_correction_command_results (
          id, league_id, season_id, fad_id, allocation_id,
          player_id, idempotency_request_id,
          commissioner_correction_id, activity_id,
          actor_user_id, actor_membership_id, actor_authority,
          accepted_from_allocation_version,
          resulting_allocation_version, preview_json,
          preview_fingerprint, request_json, request_sha256,
          response_http_status, response_json,
          response_sha256, completed_at_ms, version
        ) VALUES (
          @commandResultId, @leagueId, @seasonId, @fadId,
          @allocationId, @playerId, @idempotencyRequestId,
          @correctionId, @activityId, @actorUserId,
          @actorMembershipId, @actorAuthority,
          @expectedAllocationVersion, @resultingAllocationVersion,
          @previewJson, @previewFingerprint, @requestJson,
          @requestSha256, 200, @responseJson,
          @responseSha256, @completedAtMs, 1
        )
      `),
      completeIdempotency: database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type = '${RESULT_TYPE}',
            result_id = @commandResultId,
            completed_at_ms = @completedAtMs
        WHERE league_id = @leagueId
          AND id = @idempotencyRequestId
          AND status = 'started'
          AND result_type IS NULL
          AND result_id IS NULL
          AND completed_at_ms IS NULL
      `),
    });
    outbox = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftAllocationCorrectionRepository",
      tableName:
        "free_agent_draft_allocation_correction_command_results",
    });
  }

  function requireAuthority(command) {
    const row = unique(
      statements.authority.all(command),
      "The FAD allocation-correction authority"
    );
    if (
      !row ||
      row.league_status === "deleted" ||
      row.actor_status !== "active" ||
      row.membership_status !== "active"
    ) {
      denied();
    }
    const commissioner =
      row.commissioner_membership_id ===
        command.actorMembershipId &&
      row.permission_category === "commissioner";
    const platformAdministrator =
      row.is_platform_administrator === 1;
    if (
      (command.actorAuthority === "commissioner" &&
        !commissioner) ||
      (command.actorAuthority ===
        "platform_administrator_as_commissioner" &&
        !platformAdministrator)
    ) {
      denied();
    }
  }

  function requireCorrectionPublication({
    aggregateId,
    aggregateType,
    eventId,
    eventType,
    leagueId,
    occurredAtMs,
    reasonCode,
    related,
    version,
  }) {
    const rows = statements.publication.all({
      leagueId,
      eventId,
    });
    if (
      rows.length !== 1 ||
      rows[0].event_type !== eventType ||
      rows[0].aggregate_type !== aggregateType ||
      rows[0].aggregate_id !== aggregateId ||
      rows[0].created_at_ms !== occurredAtMs ||
      rows[0].audience_kind !== "league" ||
      rows[0].audience_team_id !== null ||
      rows[0].audience_user_id !== null
    ) {
      incompatible(
        "The immutable FAD allocation-correction publication evidence is incomplete."
      );
    }
    let payload;
    try {
      payload = JSON.parse(rows[0].payload_json);
    } catch (error) {
      incompatible(
        "The immutable FAD allocation-correction publication payload is invalid.",
        error
      );
    }
    let expected;
    try {
      expected = createSocketEventEnvelope({
        eventId,
        type: eventType,
        leagueId,
        resourceId: aggregateId,
        version,
        reasonCode,
        occurredAt: occurredAtMs,
        related,
      });
    } catch (error) {
      incompatible(
        "The immutable FAD allocation-correction publication payload is invalid.",
        error
      );
    }
    if (JSON.stringify(payload) !== JSON.stringify(expected)) {
      incompatible(
        "The immutable FAD allocation-correction publication payload is not exact."
      );
    }
  }

  function safeStoredResult(
    row,
    idempotency,
    command,
    replayed
  ) {
    if (
      !row ||
      row.league_id !== command.leagueId ||
      row.fad_id !== command.fadId ||
      row.allocation_id !== command.allocationId ||
      row.idempotency_request_id !== idempotency.id ||
      row.actor_user_id !== command.actorUserId ||
      row.actor_membership_id !== command.actorMembershipId ||
      row.actor_authority !== command.actorAuthority ||
      row.accepted_from_allocation_version !==
        command.expectedAllocationVersion ||
      row.resulting_allocation_version !==
        command.expectedAllocationVersion + 1 ||
      row.request_json !== command.requestJson ||
      row.request_sha256 !== command.requestSha256 ||
      row.response_http_status !== 200 ||
      row.version !== 1 ||
      idempotency.status !== "completed" ||
      idempotency.result_type !== RESULT_TYPE ||
      idempotency.result_id !== row.id ||
      idempotency.completed_at_ms !== row.completed_at_ms
    ) {
      incompatible(
        "The completed FAD allocation correction has no exact immutable result."
      );
    }
    let preview;
    let data;
    try {
      preview = validateFreeAgentDraftCorrectionPreview({
        leagueId: row.league_id,
        fadId: row.fad_id,
        preview: JSON.parse(row.preview_json),
      });
      data = validateFreeAgentDraftCorrectionApplyResult(
        JSON.parse(row.response_json)
      );
    } catch (error) {
      incompatible(
        "The stored FAD allocation-correction receipt is invalid.",
        error
      );
    }
    if (
      preview.allocationId !== command.allocationId ||
      preview.allocationVersion !==
        command.expectedAllocationVersion ||
      preview.previewFingerprint !==
        row.preview_fingerprint ||
      preview.reversible !== true ||
      preview.blockers.length !== 0 ||
      serializeCanonicalJsonV1(preview) !== row.preview_json ||
      serializeCanonicalJsonV1(data) !== row.response_json ||
      hashCanonicalJsonV1(data) !== row.response_sha256 ||
      data.correctionId !== row.commissioner_correction_id ||
      data.activityId !== row.activity_id ||
      data.allocation.allocationId !== command.allocationId ||
      data.allocation.allocationVersion !==
        row.resulting_allocation_version ||
      data.allocation.decisionCode !== "corrected" ||
      data.completedAtMs !== row.completed_at_ms
    ) {
      incompatible(
        "The stored FAD allocation-correction response evidence is inconsistent."
      );
    }
    const evidence = unique(
      statements.receiptEvidence.all({
        leagueId: command.leagueId,
        resultId: row.id,
      }),
      "The FAD allocation-correction receipt evidence"
    );
    let beforeSnapshot;
    let afterSnapshot;
    try {
      beforeSnapshot = JSON.parse(
        evidence?.correction_before_snapshot_json
      );
      afterSnapshot = JSON.parse(
        evidence?.correction_after_snapshot_json
      );
    } catch (error) {
      incompatible(
        "The immutable FAD allocation-correction publication version evidence is invalid.",
        error
      );
    }
    if (
      !evidence ||
      evidence.feature !== "free_agent_draft_allocation" ||
      evidence.feature_record_id !== command.allocationId ||
      evidence.correction_actor_user_id !==
        command.actorUserId ||
      evidence.correction_reason !== command.body.reason ||
      !Number.isSafeInteger(beforeSnapshot?.fadVersion) ||
      beforeSnapshot.fadVersion < 1 ||
      afterSnapshot?.fadVersion !== beforeSnapshot.fadVersion ||
      evidence.corrected_at_ms !== row.completed_at_ms ||
      evidence.activity_actor_user_id !== command.actorUserId ||
      evidence.activity_actor_authority !==
        command.actorAuthority ||
      evidence.related_type !==
        "free_agent_draft_allocation" ||
      evidence.related_id !== command.allocationId ||
      evidence.activity_occurred_at_ms !==
        row.completed_at_ms ||
      evidence.event_kind !== "correction_applied" ||
      evidence.event_decision_code !== "corrected" ||
      evidence.event_contract_id !==
        (data.allocation.winner?.contractId ?? null) ||
      evidence.event_ownership_id !==
        (data.allocation.winner?.ownershipId ?? null) ||
      evidence.event_actor_user_id !== command.actorUserId ||
      evidence.event_actor_membership_id !==
        command.actorMembershipId ||
      evidence.event_actor_authority !==
        command.actorAuthority ||
      evidence.event_activity_id !== null ||
      evidence.event_occurred_at_ms !== row.completed_at_ms
    ) {
      incompatible(
        "The immutable FAD allocation-correction evidence is incomplete."
      );
    }
    const publicationIds = correctionPublicationIds(
      row.commissioner_correction_id,
      row.activity_id
    );
    const auctionDelta = preview.deltas.find(
      (delta) => delta.resourceType === "auction"
    );
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      teamId: data.allocation.winner?.teamId ?? null,
      allocationId: command.allocationId,
      auctionId: auctionDelta?.resourceId ?? null,
    });
    requireCorrectionPublication({
      aggregateId: command.fadId,
      aggregateType: "free_agent_draft",
      eventId: publicationIds.fad,
      eventType: "free_agent_draft.changed",
      leagueId: command.leagueId,
      occurredAtMs: row.completed_at_ms,
      reasonCode: "correction_applied",
      related,
      version: beforeSnapshot.fadVersion,
    });
    requireCorrectionPublication({
      aggregateId: row.activity_id,
      aggregateType: "league_activity",
      eventId: publicationIds.activity,
      eventType: "activity.created",
      leagueId: command.leagueId,
      occurredAtMs: row.completed_at_ms,
      reasonCode: "correction_applied",
      related,
      version: 1,
    });
    return deepFreeze({
      data,
      httpStatus: 200,
      replayed,
    });
  }

  function findReplay(command) {
    const idempotency = unique(
      statements.idempotency.all(command),
      "The FAD allocation-correction idempotency scope"
    );
    if (!idempotency) return null;
    if (idempotency.request_hash !== command.requestSha256) {
      idempotencyConflict();
    }
    if (
      idempotency.status !== "completed" ||
      idempotency.result_type !== RESULT_TYPE ||
      !UUID_PATTERN.test(idempotency.result_id || "")
    ) {
      incompatible(
        "The FAD allocation-correction idempotency request is incomplete."
      );
    }
    const row = unique(
      statements.result.all({
        leagueId: command.leagueId,
        resultId: idempotency.result_id,
      }),
      "The FAD allocation-correction command result"
    );
    return safeStoredResult(
      row,
      idempotency,
      command,
      true
    );
  }

  function requireContext(command) {
    const context = unique(
      statements.context.all(command),
      "The scoped FAD allocation"
    );
    if (!context) notFound();
    if (
      context.deadline_locked_at_ms === null ||
      context.status === "pending"
    ) {
      notApplicable(
        "The FAD allocation is not in a correctable state."
      );
    }
    if (
      context.version !== command.expectedAllocationVersion
    ) {
      conflict(
        "The FAD allocation version changed before correction.",
        context.version
      );
    }
    if (
      context.updated_at_ms > command.completedAtMs ||
      context.created_at_ms > command.completedAtMs
    ) {
      notApplicable(
        "The correction completion timestamp predates the current allocation evidence."
      );
    }
    return context;
  }

  function requireCurrentPreview(command) {
    let preview;
    try {
      preview = validateFreeAgentDraftCorrectionPreview({
        leagueId: command.leagueId,
        fadId: command.fadId,
        preview:
          previewReader.previewAllocationCorrection({
            actorAuthority: command.actorAuthority,
            actorMembershipId: command.actorMembershipId,
            actorUserId: command.actorUserId,
            allocationId: command.allocationId,
            fadId: command.fadId,
            leagueId: command.leagueId,
            mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
          }),
      });
    } catch (error) {
      if (
        error?.code ===
          FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES
            .authorizationDenied ||
        error?.code ===
          "FAD_CORRECTION_AUTHORIZATION_DENIED"
      ) {
        denied();
      }
      throw error;
    }
    if (
      preview.allocationVersion !==
        command.expectedAllocationVersion
    ) {
      conflict(
        "The FAD allocation version changed before correction.",
        preview.allocationVersion
      );
    }
    if (
      preview.previewFingerprint !==
        command.body.previewFingerprint
    ) {
      notApplicable(
        "The FAD allocation-correction preview fingerprint is stale."
      );
    }
    if (
      preview.reversible !== true ||
      preview.blockers.length !== 0 ||
      !TERMINAL_RECOMPUTED_STATUSES.has(
        preview.recomputedDecision.status
      )
    ) {
      notApplicable(
        "The FAD allocation correction is not a safely reversible terminal recomputation."
      );
    }
    return preview;
  }

  function requireDelta(
    preview,
    { resourceType, resourceId, action, beforeVersion }
  ) {
    const matches = preview.deltas.filter(
      (delta) =>
        delta.resourceType === resourceType &&
        delta.resourceId === resourceId &&
        delta.action === action &&
        delta.beforeVersion === beforeVersion
    );
    if (matches.length !== 1) {
      incompatible(
        `The correction preview is missing its exact ${resourceType} ${action} delta.`
      );
    }
    return matches[0];
  }

  function cancelLinkedAuction({
    command,
    context,
    correctionId,
    delta,
  }) {
    const auction = unique(
      statements.linkedAuction.all({
        ...command,
        seasonId: context.season_id,
        auctionId: delta.resourceId,
      }),
      "The linked correction auction"
    );
    const draw = unique(
      statements.draw.all({
        ...command,
        seasonId: context.season_id,
        auctionId: delta.resourceId,
      }),
      "The linked correction draw"
    );
    if (
      !auction ||
      !draw ||
      !["open", "resolving"].includes(auction.status) ||
      auction.version !== delta.beforeVersion ||
      auction.player_id !== context.player_id ||
      auction.bid_count !== 0 ||
      auction.resolution_count !== 0 ||
      auction.draw_count !== 1 ||
      draw.version !== 1 ||
      draw.revealed_at_ms !== null ||
      draw.ordered_tied_bid_ids_json !== null ||
      draw.ordered_tied_team_ids_json !== null ||
      draw.rejection_counter !== null ||
      draw.selected_index !== null ||
      draw.selected_bid_id !== null ||
      draw.selected_team_id !== null ||
      draw.selected_digest_hex !== null ||
      auction.created_at_ms > command.completedAtMs ||
      auction.updated_at_ms > command.completedAtMs ||
      draw.created_at_ms > command.completedAtMs ||
      draw.updated_at_ms > command.completedAtMs
    ) {
      notApplicable(
        "The linked FAD auction no longer has safely cancellable private-draw evidence."
      );
    }

    let version = auction.version;
    if (auction.status === "open") {
      requireChanged(
        statements.auctionToResolving.run({
          ...command,
          seasonId: context.season_id,
          auctionId: auction.id,
          expectedVersion: version,
        }),
        "The linked FAD auction changed before correction."
      );
      version += 1;
    }
    const eventId = generatedId(
      createId,
      "FAD correction auction-cancelled event"
    );
    statements.insertAuctionEvent.run({
      ...command,
      seasonId: context.season_id,
      auctionId: auction.id,
      eventId,
      metadataJson: serializeCanonicalJsonV1({
        actorAuthority: command.actorAuthority,
        actorMembershipId: command.actorMembershipId,
        correctionId,
        reason: command.body.reason,
        schemaVersion: 1,
      }),
    });
    const resolutionId = generatedId(
      createId,
      "FAD correction auction resolution"
    );
    statements.insertAuctionResolution.run({
      ...command,
      seasonId: context.season_id,
      auctionId: auction.id,
      resolutionId,
      occurrenceKey:
        `auction:${auction.id}:${auction.resolves_at_ms}`,
      resolutionIdempotencyKey:
        `fad-correction:${correctionId}:${auction.id}`,
    });
    requireChanged(
      statements.revealEmptyDraw.run({
        ...command,
        seasonId: context.season_id,
        auctionId: auction.id,
      }),
      "The linked FAD draw changed before correction."
    );
    requireChanged(
      statements.cancelResolvingAuction.run({
        ...command,
        seasonId: context.season_id,
        auctionId: auction.id,
        expectedVersion: version,
      }),
      "The linked FAD auction changed before cancellation."
    );
    assertSynchronousFailureInjector(
      failureInjector,
      "afterLinkedAuctionCancellation"
    );
  }

  function releaseCurrentWinner({
    command,
    context,
    preview,
    correctionId,
  }) {
    const currentWinner = preview.currentDecision.winner;
    const recomputedWinner =
      preview.recomputedDecision.winner;
    const reusesCurrent =
      currentWinner !== null &&
      recomputedWinner !== null &&
      currentWinner.contractId ===
        recomputedWinner.contractId &&
      currentWinner.ownershipId ===
        recomputedWinner.ownershipId;
    if (!currentWinner || reusesCurrent) {
      return Object.freeze({
        currentContract: null,
        currentOwnership: null,
        witnesses: Object.freeze([]),
      });
    }
    const contract = unique(
      statements.contract.all({
        leagueId: command.leagueId,
        contractId: currentWinner.contractId,
      }),
      "The current allocation contract"
    );
    const ownership = unique(
      statements.ownership.all({
        leagueId: command.leagueId,
        ownershipId: currentWinner.ownershipId,
      }),
      "The current allocation ownership"
    );
    const years = statements.contractYears.all({
      leagueId: command.leagueId,
      contractId: currentWinner.contractId,
    });
    const displayEntries = statements.displayEntries.all({
      leagueId: command.leagueId,
      ownershipId: currentWinner.ownershipId,
    });
    if (
      !contract ||
      !ownership ||
      contract.player_id !== context.player_id ||
      contract.current_team_id !== currentWinner.teamId ||
      contract.status !== "active" ||
      contract.acquisition_source_type !==
        "free_agent_draft_allocation" ||
      contract.acquisition_source_id !== context.id ||
      contract.version !== 1 ||
      ownership.season_id !== context.season_id ||
      ownership.player_id !== context.player_id ||
      ownership.team_id !== currentWinner.teamId ||
      ownership.acquired_transaction_type !==
        "free_agent_draft_allocation" ||
      ownership.acquired_transaction_id !== context.id ||
      ownership.version !== 1 ||
      years.length !== contract.original_term_years ||
      years.some(
        (year) =>
          !["current", "future"].includes(year.status)
      ) ||
      contract.updated_at_ms > command.completedAtMs ||
      ownership.updated_at_ms > command.completedAtMs ||
      displayEntries.some(
        (entry) => entry.created_at_ms > command.completedAtMs
      )
    ) {
      notApplicable(
        "The current allocation contract or roster ownership has drifted."
      );
    }
    requireDelta(preview, {
      resourceType: "contract",
      resourceId: contract.id,
      action: "update",
      beforeVersion: contract.version,
    });
    requireDelta(preview, {
      resourceType: "ownership",
      resourceId: ownership.id,
      action: "release",
      beforeVersion: ownership.version,
    });
    const display = displayEntries[0] || null;
    requireDelta(preview, {
      resourceType: "roster_entry",
      resourceId: display?.id ?? ownership.id,
      action: "remove",
      beforeVersion:
        display === null
          ? ownership.version
          : preview.deltas.find(
              (delta) =>
                delta.resourceType === "roster_entry" &&
                delta.resourceId === display.id &&
                delta.action === "remove"
            )?.beforeVersion,
    });

    requireChanged(
      statements.cancelContract.run({
        ...command,
        playerId: context.player_id,
        teamId: currentWinner.teamId,
        contractId: contract.id,
        expectedVersion: contract.version,
      }),
      "The current allocation contract changed before correction."
    );
    if (
      statements.eliminateContractYears.run({
        ...command,
        contractId: contract.id,
      }).changes !== years.length
    ) {
      conflict(
        "The current allocation contract years changed before correction."
      );
    }
    statements.insertContractEvent.run({
      id: generatedId(
        createId,
        "FAD correction contract-cancelled event"
      ),
      league_id: command.leagueId,
      contract_id: contract.id,
      player_id: context.player_id,
      team_id: currentWinner.teamId,
      actor_user_id: command.actorUserId,
      event_type:
        "fad_allocation_correction_contract_cancelled",
      source_type:
        "free_agent_draft_allocation_correction",
      source_id: correctionId,
      metadata_json: serializeCanonicalJsonV1({
        beforeStatus: contract.status,
        beforeVersion: contract.version,
        correctionId,
        schemaVersion: 1,
      }),
      reason: command.body.reason,
      occurred_at_ms: command.completedAtMs,
    });

    const beforeOwnershipJson =
      serializeCanonicalJsonV1({
        ownershipKind: ownership.ownership_kind,
        rosterCategory: ownership.roster_category,
        positionGroup: ownership.position_group,
        slotNumber: ownership.slot_number,
        version: ownership.version,
      });
    if (
      statements.deleteDisplayEntries.run({
        leagueId: command.leagueId,
        ownershipId: ownership.id,
      }).changes !== displayEntries.length
    ) {
      conflict(
        "The current roster display evidence changed before correction."
      );
    }
    requireChanged(
      statements.deleteOwnership.run({
        ...command,
        seasonId: context.season_id,
        playerId: context.player_id,
        teamId: currentWinner.teamId,
        ownershipId: ownership.id,
        expectedVersion: ownership.version,
      }),
      "The current allocation ownership changed before correction."
    );
    statements.insertOwnershipEvent.run({
      ...command,
      seasonId: context.season_id,
      playerId: context.player_id,
      teamId: currentWinner.teamId,
      ownershipId: ownership.id,
      id: generatedId(
        createId,
        "FAD correction ownership-released event"
      ),
      eventType:
        "fad_allocation_correction_player_released",
      sourceType:
        "free_agent_draft_allocation_correction",
      sourceId: correctionId,
      beforeMetadataJson: beforeOwnershipJson,
      afterMetadataJson: null,
      reason: command.body.reason,
    });
    assertSynchronousFailureInjector(
      failureInjector,
      "afterCurrentWinnerRelease"
    );
    return Object.freeze({
      currentContract: contract,
      currentOwnership: ownership,
      witnesses: Object.freeze([
        Object.freeze({
          teamId: ownership.team_id,
          ownershipId: ownership.id,
          ownershipVersion: ownership.version,
          state: "deleted",
        }),
      ]),
    });
  }

  function assignRecomputedWinner({
    command,
    context,
    preview,
  }) {
    const winner = preview.recomputedDecision.winner;
    const currentWinner = preview.currentDecision.winner;
    const reusesCurrent =
      winner !== null &&
      currentWinner !== null &&
      winner.contractId === currentWinner.contractId &&
      winner.ownershipId === currentWinner.ownershipId;
    if (!winner || reusesCurrent) {
      return Object.freeze({
        contract: null,
        ownership: null,
        witnesses: Object.freeze([]),
      });
    }
    const expectedContractId =
      deriveFreeAgentDraftCorrectionResourceId({
        leagueId: command.leagueId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        acceptedFromAllocationVersion:
          command.expectedAllocationVersion,
        targetTeamId: winner.teamId,
        resourceType: "contract",
      });
    const expectedOwnershipId =
      deriveFreeAgentDraftCorrectionResourceId({
        leagueId: command.leagueId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        acceptedFromAllocationVersion:
          command.expectedAllocationVersion,
        targetTeamId: winner.teamId,
        resourceType: "ownership",
      });
    if (
      winner.contractId !== expectedContractId ||
      winner.ownershipId !== expectedOwnershipId
    ) {
      incompatible(
        "The correction preview has noncanonical prospective resource identities."
      );
    }
    requireDelta(preview, {
      resourceType: "contract",
      resourceId: null,
      action: "create",
      beforeVersion: null,
    });
    requireDelta(preview, {
      resourceType: "ownership",
      resourceId: null,
      action: "create",
      beforeVersion: null,
    });
    requireDelta(preview, {
      resourceType: "roster_entry",
      resourceId: null,
      action: "create",
      beforeVersion: null,
    });

    let seasonPlan;
    try {
      seasonPlan = planContractSeasons({
        leagueId: command.leagueId,
        targetSeason: {
          id: context.season_id,
          leagueId: command.leagueId,
          label: context.season_label,
          nhlSeasonKey: context.nhl_season_key,
          status: context.season_status,
        },
        existingSeasons: statements.seasons
          .all(command)
          .map((season) => ({
            id: season.id,
            leagueId: season.league_id,
            label: season.label,
            nhlSeasonKey: season.nhl_season_key,
            status: season.status,
          })),
        futureSeasonIds: [
          generatedId(
            createId,
            "future FAD correction contract season"
          ),
          generatedId(
            createId,
            "future FAD correction contract season"
          ),
        ],
        termYears: winner.termYears,
        nowMs: command.completedAtMs,
      });
    } catch (error) {
      incompatible(
        "The corrected Candidate contract season schedule is invalid.",
        error
      );
    }
    for (const season of seasonPlan.seasonsToCreate) {
      statements.insertSeason.run(season);
    }
    let contractAggregate;
    try {
      contractAggregate = createNormalContractAggregate({
        contractId: winner.contractId,
        contractYearIds: Array.from(
          { length: winner.termYears },
          () =>
            generatedId(
              createId,
              "FAD correction contract year"
            )
        ),
        contractEventId: generatedId(
          createId,
          "FAD correction contract-created event"
        ),
        leagueId: command.leagueId,
        playerId: context.player_id,
        teamId: winner.teamId,
        originalTotalValueCents:
          winner.totalValueCents,
        termYears: winner.termYears,
        startSeasonId: context.season_id,
        seasonIds: seasonPlan.seasonIds,
        acquisitionSourceType:
          "free_agent_draft_allocation",
        acquisitionSourceId: context.id,
        auctionBuyoutLockExpiresAtMs:
          command.completedAtMs + BUYOUT_LOCK_MS,
        actorUserId: command.actorUserId,
        occurredAtMs: command.completedAtMs,
      });
    } catch (error) {
      incompatible(
        "The corrected Candidate contract is invalid.",
        error
      );
    }
    statements.insertContract.run(
      contractAggregate.contract
    );
    for (const year of contractAggregate.years) {
      statements.insertContractYear.run(year);
    }
    statements.insertContractEvent.run(
      contractAggregate.event
    );

    const allocationDelta = requireDelta(preview, {
      resourceType: "allocation",
      resourceId: context.id,
      action: "update",
      beforeVersion: context.version,
    });
    const player = allocationDelta.afterSummary.player;
    if (
      !player ||
      player.playerId !== context.player_id ||
      !["F", "D"].includes(player.positionGroup)
    ) {
      incompatible(
        "The correction preview is missing its exact player position."
      );
    }
    let ownership;
    try {
      ownership = createRosterAssignmentRecord({
        id: winner.ownershipId,
        leagueId: command.leagueId,
        seasonId: context.season_id,
        playerId: context.player_id,
        teamId: winner.teamId,
        ownershipKind: "Rostered",
        rosterCategory: rosterCategoryForWinner(winner),
        positionGroup: player.positionGroup,
        slotNumber: slotNumberForWinner(winner),
        acquiredTransactionType:
          "free_agent_draft_allocation",
        acquiredTransactionId: context.id,
        createdAtMs: command.completedAtMs,
        updatedAtMs: command.completedAtMs,
      });
    } catch (error) {
      incompatible(
        "The corrected Candidate roster assignment is invalid.",
        error
      );
    }
    statements.insertOwnership.run(ownership);
    statements.insertOwnershipEvent.run({
      ...command,
      seasonId: context.season_id,
      playerId: context.player_id,
      teamId: winner.teamId,
      ownershipId: winner.ownershipId,
      id: generatedId(
        createId,
        "FAD correction ownership-acquired event"
      ),
      eventType: "fad_allocation_player_acquired",
      sourceType: "free_agent_draft_allocation",
      sourceId: context.id,
      beforeMetadataJson: null,
      afterMetadataJson: serializeCanonicalJsonV1({
        ownershipKind: "Rostered",
        rosterCategory: ownership.roster_category,
        positionGroup: ownership.position_group,
        slotNumber: ownership.slot_number,
        schemaVersion: 1,
      }),
      reason: command.body.reason,
    });
    assertSynchronousFailureInjector(
      failureInjector,
      "afterRecomputedWinnerAssignment"
    );
    return Object.freeze({
      contract: contractAggregate.contract,
      ownership,
      witnesses: Object.freeze([
        Object.freeze({
          teamId: ownership.team_id,
          ownershipId: ownership.id,
          ownershipVersion: ownership.version,
          state: "present",
        }),
      ]),
    });
  }

  function correctionSnapshots(
    context,
    preview,
    completedAtMs
  ) {
    const winner = preview.recomputedDecision.winner;
    return Object.freeze({
      beforeSnapshotJson: serializeCanonicalJsonV1({
        accountedAtMs: context.accounted_at_ms,
        contractId: context.contract_id,
        decisionCode: context.decision_code,
        fadVersion: context.fad_version,
        ownershipId: context.ownership_id,
        status: context.status,
        version: context.version,
        winningSnapshotEntryId:
          context.winning_snapshot_entry_id,
        winningTeamId: context.winning_team_id,
      }),
      afterSnapshotJson: serializeCanonicalJsonV1({
        accountedAtMs: completedAtMs,
        contractId: winner?.contractId ?? null,
        decisionCode: "corrected",
        fadVersion: context.fad_version,
        ownershipId: winner?.ownershipId ?? null,
        status: preview.recomputedDecision.status,
        version: context.version + 1,
        winningSnapshotEntryId:
          winner?.snapshotEntryId ?? null,
        winningTeamId: winner?.teamId ?? null,
      }),
    });
  }

  function writeAllocationEvents({
    command,
    context,
    preview,
    correctionId,
  }) {
    const allocationVersion = context.version + 1;
    for (const offer of
      preview.recomputedDecision.rankedOffers) {
      const persistedOutcomeCode = offer.valid
        ? offer.outcomeCode
        : offer.validationCode ===
            "candidate_card_structural_conflict"
          ? "excluded_structural_conflict"
          : offer.validationCode === "candidate_card_over_cap"
            ? "excluded_over_cap"
            : "invalid";
      statements.insertAllocationEvent.run({
        ...command,
        seasonId: context.season_id,
        playerId: context.player_id,
        eventId: generatedId(
          createId,
          "FAD correction offer-considered event"
        ),
        allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId: offer.snapshotEntryId,
        teamId: offer.teamId,
        offerValid: offer.valid ? 1 : 0,
        rankPosition: offer.rank,
        offerOutcomeCode: persistedOutcomeCode,
        decisionCode: null,
        resultingAllocationStatus:
          preview.recomputedDecision.status,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: null,
        correctionId: null,
        eventActorUserId: null,
        eventActorMembershipId: null,
        eventActorAuthority: "system",
        evidenceJson: serializeCanonicalJsonV1({
          correctionId,
          mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
          offer: {
            aavCents: offer.aavCents,
            outcomeCode: offer.outcomeCode,
            rank: offer.rank,
            snapshotEntryId: offer.snapshotEntryId,
            teamId: offer.teamId,
            termYears: offer.termYears,
            totalValueCents: offer.totalValueCents,
            valid: offer.valid,
            validationCode: offer.validationCode,
          },
          schemaVersion: 1,
        }),
      });
    }
    const winner = preview.recomputedDecision.winner;
    statements.insertAllocationEvent.run({
      ...command,
      seasonId: context.season_id,
      playerId: context.player_id,
      eventId: generatedId(
        createId,
        "FAD correction-applied allocation event"
      ),
      allocationVersion,
      eventKind: "correction_applied",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: "corrected",
      resultingAllocationStatus:
        preview.recomputedDecision.status,
      contractId: winner?.contractId ?? null,
      ownershipId: winner?.ownershipId ?? null,
      auctionId: context.restricted_auction_id,
      activityId: null,
      correctionId,
      eventActorUserId: command.actorUserId,
      eventActorMembershipId: command.actorMembershipId,
      eventActorAuthority: command.actorAuthority,
      evidenceJson: serializeCanonicalJsonV1({
        acceptedFromAllocationVersion: context.version,
        correctionId,
        previewFingerprint:
          preview.previewFingerprint,
        reason: command.body.reason,
        schemaVersion: 1,
      }),
    });
    assertSynchronousFailureInjector(
      failureInjector,
      "afterAllocationEvents"
    );
  }

  function resolveCausalRecoveries({
    command,
    context,
    preview,
  }) {
    const rows = statements.recoveries.all({
      ...command,
      seasonId: context.season_id,
    });
    const unresolved = rows.filter(
      (row) => row.status !== "resolved"
    );
    const deltas = preview.deltas.filter(
      (delta) =>
        delta.resourceType === "recovery" &&
        delta.action === "resolve"
    );
    if (
      unresolved.length !== deltas.length ||
      unresolved.some(
        (row) =>
          !deltas.some(
            (delta) =>
              delta.resourceId === row.id &&
              delta.beforeVersion === row.version
          )
      )
    ) {
      notApplicable(
        "The causal FAD recovery set changed after the correction preview."
      );
    }
    for (const recovery of unresolved) {
      if (
        ![
          "pending",
          "ready",
          "running",
          "correction_required",
        ].includes(recovery.status) ||
        recovery.created_at_ms > command.completedAtMs ||
        recovery.updated_at_ms > command.completedAtMs
      ) {
        notApplicable(
          "A causal FAD recovery cannot be safely resolved by this correction."
        );
      }
      let version = recovery.version;
      if (recovery.status !== "running") {
        requireChanged(
          statements.startRecovery.run({
            ...command,
            seasonId: context.season_id,
            recoveryId: recovery.id,
            expectedStatus: recovery.status,
            expectedVersion: version,
            reason: command.body.reason,
          }),
          "A causal FAD recovery changed before correction."
        );
        version += 1;
      }
      requireChanged(
        statements.resolveRecovery.run({
          ...command,
          seasonId: context.season_id,
          recoveryId: recovery.id,
          expectedVersion: version,
          reason: command.body.reason,
        }),
        "A causal FAD recovery changed before resolution."
      );
    }
    assertSynchronousFailureInjector(
      failureInjector,
      "afterRecoveryResolution"
    );
  }

  function writeActivityAndSideEffects({
    command,
    context,
    preview,
    correctionId,
    activityId,
  }) {
    const winner = preview.recomputedDecision.winner;
    const activityContract =
      createFreeAgentDraftActivityContract({
        eventType: "free_agent_draft_corrected",
        metadata: {
          allocationId: context.id,
          correctionId,
          fadId: command.fadId,
          resultingAllocationVersion: context.version + 1,
          resultingStatus:
            preview.recomputedDecision.status,
          schemaVersion: 1,
          winningTeamId: winner?.teamId ?? null,
        },
      });
    statements.insertActivity.run({
      ...command,
      seasonId: context.season_id,
      playerId: context.player_id,
      activityId,
      eventType: activityContract.eventType,
      winningTeamId: winner?.teamId ?? null,
      displaySummary:
        `${context.player_full_name} Candidate allocation was corrected.`,
      reason: command.body.reason,
      metadataJson: serializeCanonicalJsonV1(
        activityContract.metadata
      ),
    });
    const publicationIds = correctionPublicationIds(
      correctionId,
      activityId
    );
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      teamId: winner?.teamId ?? null,
      allocationId: context.id,
      auctionId:
        context.restricted_auction_id ||
        context.fallback_open_auction_id ||
        null,
    });
    outbox.write({
      id: publicationIds.fad,
      leagueId: command.leagueId,
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: command.fadId,
      payload: createSocketEventMetadata({
        eventType: "free_agent_draft.changed",
        version: context.fad_version,
        reasonCode: "correction_applied",
        occurredAtMs: command.completedAtMs,
        related,
      }),
      occurredAtMs: command.completedAtMs,
    });
    outbox.write({
      id: publicationIds.activity,
      leagueId: command.leagueId,
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: activityId,
      payload: createSocketEventMetadata({
        eventType: "activity.created",
        version: 1,
        reasonCode: "correction_applied",
        occurredAtMs: command.completedAtMs,
        related,
      }),
      occurredAtMs: command.completedAtMs,
    });
    assertSynchronousFailureInjector(
      failureInjector,
      "afterActivityAndSideEffects"
    );
  }

  function readCorrectedAllocation(command, context) {
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const result = publishedReader.readAllocationResults({
        leagueId: command.leagueId,
        fadId: command.fadId,
        viewerUserId: command.actorUserId,
        viewerMembershipId: command.actorMembershipId,
        nowMs: command.completedAtMs,
        query: {
          q: normalizeCandidateEligiblePlayerName(
            context.player_full_name
          ),
          status: null,
          limit: 100,
          cursor,
        },
      });
      const allocation = result.data.find(
        (item) => item.allocationId === context.id
      );
      if (allocation) return allocation;
      if (!result.page.hasMore) break;
      if (
        typeof result.page.nextCursor !== "string" ||
        result.page.nextCursor === cursor
      ) {
        incompatible(
          "The corrected FAD allocation result cursor is invalid."
        );
      }
      cursor = result.page.nextCursor;
    }
    incompatible(
      "The corrected FAD allocation result is unavailable."
    );
  }

  function committedRoster(
    context,
    releaseWitnesses,
    assignmentWitnesses
  ) {
    const witnesses = [
      ...releaseWitnesses,
      ...assignmentWitnesses,
    ];
    if (witnesses.length === 0) return null;
    const byTeam = new Map();
    for (const witness of witnesses) {
      if (!byTeam.has(witness.teamId)) {
        byTeam.set(witness.teamId, []);
      }
      byTeam.get(witness.teamId).push(
        Object.freeze({
          ownershipId: witness.ownershipId,
          ownershipVersion: witness.ownershipVersion,
          state: witness.state,
        })
      );
    }
    return deepFreeze({
      teams: [...byTeam.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([teamId, ownershipWitnesses]) => ({
          leagueId: context.league_id,
          seasonId: context.season_id,
          teamId,
          ownershipWitnesses:
            ownershipWitnesses.sort((left, right) =>
              left.ownershipId.localeCompare(right.ownershipId)
            ),
        })),
    });
  }

  function persist(command, context, preview) {
    if (
      statements.insertIdempotency.run(command).changes !== 1
    ) {
      incompatible(
        "The FAD allocation-correction idempotency request was not started."
      );
    }
    assertSynchronousFailureInjector(
      failureInjector,
      "afterIdempotencyStart"
    );

    const correctionId = generatedId(
      createId,
      "FAD allocation commissioner correction"
    );
    const activityId = generatedId(
      createId,
      "FAD allocation correction activity"
    );
    const snapshots = correctionSnapshots(
      context,
      preview,
      command.completedAtMs
    );
    statements.insertCorrection.run({
      ...command,
      seasonId: context.season_id,
      correctionId,
      reason: command.body.reason,
      ...snapshots,
    });
    assertSynchronousFailureInjector(
      failureInjector,
      "afterCorrectionEvidence"
    );

    const auctionDeltas = preview.deltas.filter(
      (delta) =>
        delta.resourceType === "auction" &&
        delta.action === "cancel"
    );
    for (const delta of auctionDeltas) {
      cancelLinkedAuction({
        command,
        context,
        correctionId,
        delta,
      });
    }
    if (
      preview.deltas.some(
        (delta) =>
          delta.resourceType === "auction" &&
          delta.action !== "cancel"
      )
    ) {
      notApplicable(
        "A nonterminal FAD auction process cannot be materialized by a terminal allocation correction."
      );
    }

    const release = releaseCurrentWinner({
      command,
      context,
      preview,
      correctionId,
    });
    const assignment = assignRecomputedWinner({
      command,
      context,
      preview,
    });
    const winner = preview.recomputedDecision.winner;
    requireChanged(
      statements.updateAllocation.run({
        ...command,
        seasonId: context.season_id,
        playerId: context.player_id,
        status: preview.recomputedDecision.status,
        winningSnapshotEntryId:
          winner?.snapshotEntryId ?? null,
        winningTeamId: winner?.teamId ?? null,
        contractId: winner?.contractId ?? null,
        ownershipId: winner?.ownershipId ?? null,
      }),
      "The FAD allocation changed before correction committed."
    );
    assertSynchronousFailureInjector(
      failureInjector,
      "afterAllocationUpdate"
    );
    writeAllocationEvents({
      command,
      context,
      preview,
      correctionId,
    });
    resolveCausalRecoveries({
      command,
      context,
      preview,
    });
    writeActivityAndSideEffects({
      command,
      context,
      preview,
      correctionId,
      activityId,
    });

    const allocation = readCorrectedAllocation(
      command,
      context
    );
    const deltas = appliedDeltas(preview, activityId);
    let data;
    try {
      data = validateFreeAgentDraftCorrectionApplyResult({
        correctionId,
        allocation,
        appliedDeltas: deltas,
        activityId,
        completedAtMs: command.completedAtMs,
      });
    } catch (error) {
      incompatible(
        "The committed FAD allocation-correction response is invalid.",
        error
      );
    }
    const receipt = {
      ...command,
      seasonId: context.season_id,
      playerId: context.player_id,
      correctionId,
      activityId,
      resultingAllocationVersion: context.version + 1,
      previewJson: serializeCanonicalJsonV1(preview),
      previewFingerprint: preview.previewFingerprint,
      responseJson: serializeCanonicalJsonV1(data),
      responseSha256: hashCanonicalJsonV1(data),
    };
    statements.insertResult.run(receipt);
    assertSynchronousFailureInjector(
      failureInjector,
      "afterImmutableResult"
    );
    requireChanged(
      statements.completeIdempotency.run(receipt),
      "The FAD allocation-correction idempotency request was not completed."
    );
    assertSynchronousFailureInjector(
      failureInjector,
      "beforeCommit"
    );
    const persistedIdempotency = unique(
      statements.idempotency.all(command),
      "The persisted FAD allocation-correction idempotency scope"
    );
    const persistedResult = unique(
      statements.result.all({
        leagueId: command.leagueId,
        resultId: command.commandResultId,
      }),
      "The persisted FAD allocation-correction result"
    );
    const publicResult = safeStoredResult(
      persistedResult,
      persistedIdempotency,
      command,
      false
    );
    return deepFreeze({
      ...publicResult,
      committedRoster: committedRoster(
        context,
        release.witnesses,
        assignment.witnesses
      ),
    });
  }

  replayTransaction = database.transaction((command) => {
    requireAuthority(command);
    return findReplay(command);
  });

  applyTransaction = database.transaction((command) => {
    requireAuthority(command);
    const replay = findReplay(command);
    if (replay) return replay;
    const context = requireContext(command);
    if (
      context.deadline_locked_at_ms > command.completedAtMs
    ) {
      notApplicable(
        "The correction completion timestamp predates the locked Candidate deadline."
      );
    }
    const preview = requireCurrentPreview(command);
    return persist(command, context, preview);
  });

  return Object.freeze({
    findAllocationCorrectionReplay(input = {}) {
      const command = normalizeReplayInput(input);
      try {
        return replayTransaction.deferred(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findFadAllocationCorrectionReplay",
          tableName:
            "free_agent_draft_allocation_correction_command_results",
        });
      }
    },
    applyAllocationCorrection(input = {}) {
      const command = normalizeWriteInput(input);
      try {
        return applyTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "applyFadAllocationCorrection",
          tableName:
            "free_agent_draft_allocation_correction_command_results",
        });
      }
    },
  });
}

module.exports = {
  BUYOUT_LOCK_MS,
  FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_REPOSITORY_CODES,
  IDEMPOTENCY_OPERATION,
  RESULT_TYPE,
  createSqliteFreeAgentDraftAllocationCorrectionRepository,
};
