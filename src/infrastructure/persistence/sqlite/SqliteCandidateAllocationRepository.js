"use strict";

const {
  createHash,
  randomBytes,
  randomUUID,
} = require("node:crypto");

const {
  CandidateAllocationPolicyError,
  decideCandidateAllocation,
} = require(
  "../../../domain/freeAgentDraft/candidateAllocationPolicy"
);
const {
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createNormalContractAggregate,
} = require(
  "../../../domain/contracts/contractPolicy"
);
const {
  planContractSeasons,
} = require(
  "../../../domain/contracts/contractSeasonPlanner"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require(
  "../../../domain/leagues/socketInvalidation"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createRosterAssignmentRecord,
} = require(
  "../../../domain/rosters/rosterAssignmentPolicy"
);
const {
  evaluateStructuralRosterLegality,
} = require(
  "../../../domain/rosters/rosterMovementPolicy"
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
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const ALLOCATION_JOB_TYPE = "fad_allocation";
const RESTRICTED_ACTIVATION_JOB_TYPE =
  "fad_restricted_activation";
const ALLOCATION_RECOVERY_KIND =
  "allocation_retry";
const ALLOCATION_CORRECTION_ERROR_CODES =
  Object.freeze({
    playerOwned:
      "FAD_ALLOCATION_PLAYER_OWNED",
    playerContracted:
      "FAD_ALLOCATION_PLAYER_CONTRACTED",
    playerAuctionActive:
      "FAD_ALLOCATION_PLAYER_AUCTION_ACTIVE",
    destinationMismatch:
      "FAD_ALLOCATION_DESTINATION_MISMATCH",
    destinationOccupied:
      "FAD_ALLOCATION_DESTINATION_OCCUPIED",
  });
const BUYOUT_LOCK_MS =
  14 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS =
  8_640_000_000_000_000;
const MAX_LEASE_TEXT_LENGTH = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const CANDIDATE_ALLOCATION_REPOSITORY_METHODS =
  Object.freeze([
    "findAllocation",
    "resolvePending",
  ]);

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

function allocationPublicationIds(outboxEventId, activityId, auctionId) {
  return Object.freeze({
    activity: deterministicUuid(
      `${outboxEventId}:activity.created:${activityId}`
    ),
    auction:
      auctionId === null
        ? null
        : deterministicUuid(
            `${outboxEventId}:auction.changed:${auctionId}`
          ),
  });
}

function correctionPublicationIds(recoveryId, userId) {
  const notificationId = deterministicUuid(
    `${recoveryId}:fad-correction-required:${userId}`
  );
  return Object.freeze({
    fad: deterministicUuid(
      `${recoveryId}:free-agent-draft.changed`
    ),
    notification: notificationId,
    notificationOutbox: deterministicUuid(
      `${notificationId}:notification.created`
    ),
  });
}

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function notFound(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    message
  );
}

function conflict(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
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
      (field, index) =>
        field !== expected[index]
    )
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
    invalid(
      `A canonical ${description} identifier is required.`
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveInteger(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(
      `A positive ${description} is required.`
    );
  }
  return value;
}

function boundedText(
  value,
  description,
  maximumLength =
    MAX_LEASE_TEXT_LENGTH
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid(
      `A bounded ${description} is required.`
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

function canonicalJson(value) {
  return serializeCanonicalJsonV1(value);
}

function parseCanonicalJson(
  encoded,
  description
) {
  let value;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    incompatible(
      `The persisted ${description} is not valid JSON.`,
      error
    );
  }
  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch (error) {
    incompatible(
      `The persisted ${description} is not canonical.`,
      error
    );
  }
  if (canonical !== encoded) {
    incompatible(
      `The persisted ${description} is not canonical.`
    );
  }
  return deepFreeze(value);
}

function normalizeScope(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "fadId",
      "allocationId",
      "playerId",
    ],
    "Candidate allocation lookup"
  );
  return Object.freeze({
    leagueId: stableId(
      input.leagueId,
      "league"
    ),
    seasonId: stableId(
      input.seasonId,
      "season"
    ),
    fadId: stableId(
      input.fadId,
      "Free Agent Draft"
    ),
    allocationId: stableId(
      input.allocationId,
      "allocation"
    ),
    playerId: stableId(
      input.playerId,
      "player"
    ),
  });
}

function normalizeCommand(input) {
  exactObject(
    input,
    [
      "leagueId",
      "seasonId",
      "fadId",
      "allocationId",
      "playerId",
      "expectedAllocationVersion",
      "jobRunId",
      "expectedJobVersion",
      "leaseOwner",
      "leaseToken",
      "nowMs",
    ],
    "Candidate allocation command"
  );
  const scope = normalizeScope({
    leagueId: input.leagueId,
    seasonId: input.seasonId,
    fadId: input.fadId,
    allocationId: input.allocationId,
    playerId: input.playerId,
  });
  return Object.freeze({
    ...scope,
    expectedAllocationVersion:
      positiveInteger(
        input.expectedAllocationVersion,
        "expected allocation version"
      ),
    jobRunId: stableId(
      input.jobRunId,
      "allocation job-run"
    ),
    expectedJobVersion:
      positiveInteger(
        input.expectedJobVersion,
        "expected job-run version"
      ),
    leaseOwner: boundedText(
      input.leaseOwner,
      "allocation lease owner"
    ),
    leaseToken: boundedText(
      input.leaseToken,
      "allocation lease token"
    ),
    nowMs: safeTimestamp(
      input.nowMs,
      "allocation timestamp"
    ),
  });
}

function allocationRecord(row) {
  return deepFreeze({
    id: row.allocation_id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    fadId: row.fad_id,
    playerId: row.player_id,
    status: row.allocation_status,
    decisionCode: row.decision_code,
    winningSnapshotEntryId:
      row.winning_snapshot_entry_id,
    winningTeamId: row.winning_team_id,
    contractId: row.contract_id,
    ownershipId: row.ownership_id,
    restrictedAuctionId:
      row.restricted_auction_id,
    fallbackOpenAuctionId:
      row.fallback_open_auction_id,
    restrictedMinimum:
      row.restricted_minimum_total_cents ===
      null
        ? null
        : {
            totalValueCents:
              row.restricted_minimum_total_cents,
            termYears:
              row.restricted_minimum_term_years,
            aavCents:
              row.restricted_minimum_aav_cents,
          },
    accountedAtMs: row.accounted_at_ms,
    lastErrorCode: row.last_error_code,
    createdAtMs: row.allocation_created_at_ms,
    updatedAtMs: row.allocation_updated_at_ms,
    version: row.allocation_version,
  });
}

function assertSynchronous(
  value,
  description
) {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must complete synchronously.`
    );
  }
}

function uniqueRow(
  statement,
  parameters,
  description
) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(
      `The ${description} is not unique.`
    );
  }
  return rows[0] || null;
}

function requireChanged(result, message) {
  if (result.changes !== 1) {
    conflict(message);
  }
}

function safeWarning(reason, teamId) {
  return Object.freeze({
    code:
      typeof reason?.code === "string"
        ? reason.code
        : "UNKNOWN_LEGALITY_WARNING",
    teamId,
    playerId:
      typeof reason?.playerId === "string"
        ? reason.playerId
        : null,
    ownershipId:
      typeof reason?.ownershipId === "string"
        ? reason.ownershipId
        : null,
    contractId:
      typeof reason?.contractId === "string"
        ? reason.contractId
        : null,
  });
}

function createSqliteCandidateAllocationRepository({
  database,
  capReadRepository,
  leagueOutboxWriter,
  notificationWriter,
  createId = () => randomUUID(),
  createDrawNonce = () => randomBytes(32),
  allowImmediateRestrictedActivation = false,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateAllocationRepository requires an opened database"
    );
  }
  if (
    typeof createId !== "function" ||
    typeof createDrawNonce !== "function"
  ) {
    throw new TypeError(
      "Candidate allocation identifier and nonce factories must be functions"
    );
  }
  if (
    typeof allowImmediateRestrictedActivation !==
    "boolean"
  ) {
    throw new TypeError(
      "Candidate allocation immediate restricted activation capability must be boolean"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Candidate allocation beforeCommit must be a function"
    );
  }

  const capReader =
    capReadRepository === undefined
      ? createSqliteCapReadRepository({
          database,
        })
      : capReadRepository;
  if (
    !capReader ||
    typeof capReader.calculate !== "function"
  ) {
    throw new TypeError(
      "Candidate allocation persistence requires a cap-read repository"
    );
  }
  const outboxWriter =
    resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
  const notifications =
    resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });

  let contextStatement;
  let offersStatement;
  let revisionStatement;
  let managerStatement;
  let commissionerStatement;
  let allocationJobStatement;
  let activeOwnershipStatement;
  let activeContractStatement;
  let activeAuctionStatement;
  let occupiedSlotStatement;
  let seasonsStatement;
  let rosterRowsStatement;
  let currentRolloverStatement;
  let nextRolloverStatement;
  let allocationEventsStatement;
  let replayContractStatement;
  let replayOwnershipStatement;
  let replayAuctionStatement;
  let replayParticipantsStatement;
  let replayDrawStatement;
  let replayActivationJobStatement;
  let replayActivityStatement;
  let replayOutboxStatement;
  let publicationStatement;
  let correctionNotificationStatement;
  let correctionReplayStatement;
  let insertSeasonStatement;
  let insertContractStatement;
  let insertContractYearStatement;
  let insertContractEventStatement;
  let insertOwnershipStatement;
  let insertOwnershipEventStatement;
  let insertAuctionStatement;
  let updateAutomaticAwardStatement;
  let updateRestrictedStatement;
  let updateNoValidOfferStatement;
  let updateCorrectionRequiredStatement;
  let insertAuctionContextStatement;
  let insertParticipantStatement;
  let insertDrawStatement;
  let insertActivationJobStatement;
  let insertActivityStatement;
  let insertAllocationEventStatement;
  let insertAllocationRecoveryStatement;
  let succeedAllocationJobStatement;
  let failAllocationJobStatement;

  try {
    contextStatement = database.prepare(`
      SELECT
        allocation.id AS allocation_id,
        allocation.league_id,
        allocation.season_id,
        allocation.fad_id,
        allocation.player_id,
        allocation.status AS allocation_status,
        allocation.decision_code,
        allocation.winning_snapshot_entry_id,
        allocation.winning_team_id,
        allocation.contract_id,
        allocation.ownership_id,
        allocation.restricted_auction_id,
        allocation.fallback_open_auction_id,
        allocation.restricted_minimum_total_cents,
        allocation.restricted_minimum_term_years,
        allocation.restricted_minimum_aav_cents,
        allocation.accounted_at_ms,
        allocation.last_error_code,
        allocation.created_at_ms AS allocation_created_at_ms,
        allocation.updated_at_ms AS allocation_updated_at_ms,
        allocation.version AS allocation_version,
        fad.status AS fad_status,
        fad.version AS fad_version,
        fad.candidate_deadline_at_ms,
        fad.first_matchup_starts_at_ms,
        league.status AS league_status,
        league.current_season_id,
        season.label AS season_label,
        season.nhl_season_key,
        season.status AS season_status,
        player.full_name AS player_full_name,
        player.status AS player_status
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_drafts AS fad
        ON fad.league_id = allocation.league_id
       AND fad.season_id = allocation.season_id
       AND fad.id = allocation.fad_id
      JOIN leagues AS league
        ON league.id = allocation.league_id
      JOIN seasons AS season
        ON season.league_id = allocation.league_id
       AND season.id = allocation.season_id
      JOIN players AS player
        ON player.id = allocation.player_id
      WHERE allocation.league_id = @leagueId
        AND allocation.season_id = @seasonId
        AND allocation.fad_id = @fadId
        AND allocation.id = @allocationId
        AND allocation.player_id = @playerId
      LIMIT 2
    `);
    offersStatement = database.prepare(`
      SELECT
        offer.id AS snapshot_entry_id,
        offer.snapshot_id,
        offer.card_id,
        offer.team_id,
        offer.row_kind,
        offer.source_entry_id,
        offer.source_entry_version,
        offer.player_id,
        offer.effective_position_group,
        offer.slot_group,
        offer.slot_number,
        offer.conflict_code,
        offer.proposed_total_value_cents,
        offer.proposed_term_years,
        offer.proposed_aav_cents,
        offer.eligibility_status,
        offer.validation_code,
        offer.allocation_eligibility,
        offer.allocation_exclusion_reason,
        offer.last_edited_by_user_id,
        offer.last_edited_by_membership_id,
        offer.last_edited_by_authority,
        offer.last_edited_at_ms,
        snapshot.completeness_code AS card_completeness_code,
        snapshot.locked_card_version,
        CASE WHEN current_entry.id IS NOT NULL
          AND current_entry.version =
            offer.source_entry_version
          AND current_entry.player_id =
            offer.player_id
          AND current_entry.team_id =
            offer.team_id
          AND current_entry.requested_slot_group =
            offer.slot_group
          AND current_entry.requested_slot_number =
            offer.slot_number
          AND current_entry.effective_position_group =
            offer.effective_position_group
          AND (
            (
              offer.row_kind = 'slot'
              AND current_entry.placement_state = 'placed'
              AND current_entry.conflict_code IS NULL
            )
            OR (
              offer.row_kind = 'conflict'
              AND current_entry.placement_state = 'conflict'
              AND current_entry.conflict_code =
                offer.conflict_code
            )
          )
          AND current_entry.proposed_total_value_cents =
            offer.proposed_total_value_cents
          AND current_entry.proposed_term_years =
            offer.proposed_term_years
          AND current_entry.proposed_aav_cents =
            offer.proposed_aav_cents
          THEN 1
          ELSE 0
        END AS source_entry_matches
      FROM candidate_card_snapshot_entries AS offer
      JOIN candidate_card_snapshots AS snapshot
        ON snapshot.league_id = offer.league_id
       AND snapshot.season_id = offer.season_id
       AND snapshot.fad_id = offer.fad_id
       AND snapshot.id = offer.snapshot_id
       AND snapshot.card_id = offer.card_id
       AND snapshot.team_id = offer.team_id
      LEFT JOIN candidate_card_entries AS current_entry
        ON current_entry.league_id = offer.league_id
       AND current_entry.season_id = offer.season_id
       AND current_entry.fad_id = offer.fad_id
       AND current_entry.card_id = offer.card_id
       AND current_entry.team_id = offer.team_id
       AND current_entry.id = offer.source_entry_id
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
    revisionStatement = database.prepare(`
      SELECT
        revision.id,
        revision.actor_user_id,
        revision.actor_membership_id,
        revision.actor_authority
      FROM candidate_card_revisions AS revision
      WHERE revision.league_id = @leagueId
        AND revision.season_id = @seasonId
        AND revision.fad_id = @fadId
        AND revision.card_id = @cardId
        AND revision.team_id = @teamId
        AND (
          (
            revision.affected_entry_id =
              @sourceEntryId
            AND revision.player_id = @playerId
            AND revision.action IN (
              'candidate_added',
              'candidate_edited',
              'candidate_moved'
            )
          )
          OR (
            revision.action =
              'candidate_card_saved'
            AND EXISTS (
              SELECT 1
              FROM candidate_card_revision_entry_changes AS change
              WHERE change.league_id =
                  revision.league_id
                AND change.season_id =
                  revision.season_id
                AND change.fad_id = revision.fad_id
                AND change.card_id = revision.card_id
                AND change.team_id = revision.team_id
                AND change.revision_id = revision.id
                AND change.entry_id = @sourceEntryId
                AND change.player_id = @playerId
                AND change.change_kind IN (
                  'add',
                  'edit',
                  'move'
                )
            )
          )
        )
        AND revision.resulting_card_version <=
          @lockedCardVersion
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_card_revisions AS later_revision
          WHERE later_revision.league_id =
              revision.league_id
            AND later_revision.card_id =
              revision.card_id
            AND later_revision.resulting_card_version >
              revision.resulting_card_version
            AND later_revision.resulting_card_version <=
              @lockedCardVersion
            AND (
              (
                later_revision.affected_entry_id =
                  @sourceEntryId
                AND later_revision.player_id = @playerId
                AND later_revision.action IN (
                  'candidate_added',
                  'candidate_edited',
                  'candidate_moved'
                )
              )
              OR (
                later_revision.action =
                  'candidate_card_saved'
                AND EXISTS (
                  SELECT 1
                  FROM candidate_card_revision_entry_changes AS later_change
                  WHERE later_change.league_id =
                      later_revision.league_id
                    AND later_change.revision_id =
                      later_revision.id
                    AND later_change.entry_id =
                      @sourceEntryId
                    AND later_change.player_id = @playerId
                    AND later_change.change_kind IN (
                      'add',
                      'edit',
                      'move'
                    )
                )
              )
            )
        )
      ORDER BY
        revision.resulting_card_version DESC,
        revision.occurred_at_ms DESC,
        revision.id DESC
      LIMIT 2
    `);
    managerStatement = database.prepare(`
      SELECT
        assignment.user_id,
        assignment.membership_id
      FROM team_manager_assignments AS assignment
      JOIN league_memberships AS membership
        ON membership.league_id =
          assignment.league_id
       AND membership.id =
          assignment.membership_id
       AND membership.user_id =
          assignment.user_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      JOIN users AS manager
        ON manager.id = assignment.user_id
       AND manager.status = 'active'
      WHERE assignment.league_id = @leagueId
        AND assignment.team_id = @teamId
        AND assignment.status = 'accepted'
        AND assignment.accepted_at_ms IS NOT NULL
        AND assignment.ended_at_ms IS NULL
      LIMIT 2
    `);
    commissionerStatement = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
       AND membership.permission_category = 'commissioner'
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    allocationJobStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @jobRunId
        AND job_type = '${ALLOCATION_JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    activeOwnershipStatement =
      database.prepare(`
        SELECT id
        FROM player_ownerships
        WHERE league_id = @leagueId
          AND player_id = @playerId
        LIMIT 2
      `);
    activeContractStatement =
      database.prepare(`
        SELECT id
        FROM contracts
        WHERE league_id = @leagueId
          AND player_id = @playerId
          AND status = 'active'
        LIMIT 2
      `);
    activeAuctionStatement =
      database.prepare(`
        SELECT id
        FROM auctions
        WHERE league_id = @leagueId
          AND player_id = @playerId
          AND status IN ('open', 'resolving')
        LIMIT 2
      `);
    occupiedSlotStatement =
      database.prepare(`
        SELECT id
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
        LIMIT 2
      `);
    seasonsStatement = database.prepare(`
      SELECT
        id,
        league_id,
        label,
        nhl_season_key,
        status
      FROM seasons
      WHERE league_id = @leagueId
      ORDER BY nhl_season_key, id
    `);
    rosterRowsStatement = database.prepare(`
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
            WHERE correction.league_id =
              ownership.league_id
              AND correction.player_id =
                ownership.player_id
              AND correction.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT CASE
              WHEN COUNT(
                DISTINCT source.normalized_position
              ) = 1
              THEN MAX(source.normalized_position)
              ELSE NULL
            END
            FROM player_source_state AS source
            WHERE source.player_id =
              ownership.player_id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position
                IN ('F', 'D')
          )
        ) AS effective_position
      FROM player_ownerships AS ownership
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY ownership.player_id
    `);
    currentRolloverStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_rollovers
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND opens_at_ms <= @nowMs
          AND rolls_over_at_ms > @nowMs
          AND status IN (
            'scheduled',
            'processing'
          )
        ORDER BY sequence
        LIMIT 2
      `);
    nextRolloverStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_rollovers
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND sequence = @sequence
          AND predecessor_rollover_id =
            @predecessorRolloverId
          AND opens_at_ms = @opensAtMs
          AND status = 'scheduled'
        LIMIT 2
      `);
    allocationEventsStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_allocation_events
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
        ORDER BY
          allocation_version,
          CASE event_kind
            WHEN 'offer_considered' THEN 1
            ELSE 2
          END,
          rank_position,
          id
      `);
    replayContractStatement =
      database.prepare(`
        SELECT *
        FROM contracts
        WHERE league_id = @leagueId
          AND id = @contractId
        LIMIT 2
      `);
    replayOwnershipStatement =
      database.prepare(`
        SELECT *
        FROM player_ownerships
        WHERE league_id = @leagueId
          AND id = @ownershipId
        LIMIT 2
      `);
    replayAuctionStatement =
      database.prepare(`
        SELECT
          auction.*,
          context.fad_id,
          context.fad_rollover_id,
          context.fad_allocation_id,
          context.source_kind,
          context.fad_origin
        FROM auctions AS auction
        JOIN auction_contexts AS context
          ON context.league_id =
            auction.league_id
         AND context.season_id =
            auction.season_id
         AND context.auction_id =
            auction.id
        WHERE auction.league_id = @leagueId
          AND auction.id = @auctionId
        LIMIT 2
      `);
    replayParticipantsStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_auction_participants
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND auction_id = @auctionId
        ORDER BY team_id, id
      `);
    replayDrawStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_draws
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND auction_id = @auctionId
        LIMIT 2
      `);
    replayActivationJobStatement =
      database.prepare(`
        SELECT *
        FROM job_runs
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @activationJobRunId
          AND job_type =
            '${RESTRICTED_ACTIVATION_JOB_TYPE}'
          AND occurrence_key =
            @activationOccurrenceKey
          AND scheduled_for_ms =
            @activationAtMs
        LIMIT 2
      `);
    replayActivityStatement =
      database.prepare(`
        SELECT id
        FROM league_activity
        WHERE league_id = @leagueId
          AND id = @activityId
        LIMIT 2
      `);
    replayOutboxStatement =
      database.prepare(`
        SELECT id
        FROM outbox_events
        WHERE league_id = @leagueId
          AND id = @outboxEventId
        LIMIT 2
      `);
    publicationStatement = database.prepare(`
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
    `);
    correctionNotificationStatement = database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = @leagueId
        AND event_type = 'fad_correction_required'
        AND related_feature = 'free_agent_draft'
        AND related_record_id = @fadId
        AND json_extract(message_data_json, '$.allocationId') = @allocationId
        AND json_extract(message_data_json, '$.recoveryId') = @recoveryId
        AND json_extract(message_data_json, '$.playerId') = @playerId
      ORDER BY id
      LIMIT 2
    `);
    correctionReplayStatement =
      database.prepare(`
        SELECT
          recovery.id AS recovery_id,
          recovery.kind AS recovery_kind,
          recovery.status AS recovery_status,
          recovery.last_error_code,
          recovery.job_run_id,
          recovery.created_at_ms AS recovery_created_at_ms,
          recovery.version AS recovery_version,
          event.id AS event_id,
          event.event_kind,
          event.decision_code AS event_decision_code,
          event.resulting_allocation_status,
          event.evidence_json,
          event.occurred_at_ms
        FROM free_agent_draft_recoveries AS recovery
        JOIN free_agent_draft_allocation_events AS event
          ON event.league_id = recovery.league_id
         AND event.season_id = recovery.season_id
         AND event.fad_id = recovery.fad_id
         AND event.allocation_id = recovery.allocation_id
         AND event.player_id = recovery.player_id
        WHERE recovery.league_id = @leagueId
          AND recovery.season_id = @seasonId
          AND recovery.fad_id = @fadId
          AND recovery.allocation_id = @allocationId
          AND recovery.player_id = @playerId
          AND recovery.job_run_id = @jobRunId
          AND recovery.kind = '${ALLOCATION_RECOVERY_KIND}'
          AND event.allocation_version =
            @expectedAllocationVersion + 1
          AND event.event_kind = 'decision_recorded'
          AND event.resulting_allocation_status =
            'correction_required'
        ORDER BY recovery.id, event.id
        LIMIT 2
      `);
    insertSeasonStatement =
      database.prepare(`
        INSERT INTO seasons (
          id,
          league_id,
          label,
          nhl_season_key,
          status,
          regular_season_starts_at_ms,
          regular_season_ends_at_ms,
          fantasy_playoffs_start_at_ms,
          fantasy_playoffs_end_at_ms,
          free_agent_draft_completed_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @id,
          @leagueId,
          @label,
          @nhlSeasonKey,
          @status,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @createdAtMs,
          @createdAtMs,
          1
        )
      `);
    insertContractStatement =
      database.prepare(`
        INSERT INTO contracts (
          id,
          league_id,
          player_id,
          current_team_id,
          contract_type,
          original_total_value_cents,
          original_term_years,
          aav_cents,
          start_season_id,
          status,
          acquisition_source_type,
          acquisition_source_id,
          auction_buyout_lock_expires_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @id,
          @league_id,
          @player_id,
          @current_team_id,
          @contract_type,
          @original_total_value_cents,
          @original_term_years,
          @aav_cents,
          @start_season_id,
          @status,
          @acquisition_source_type,
          @acquisition_source_id,
          @auction_buyout_lock_expires_at_ms,
          @created_at_ms,
          @updated_at_ms,
          @version
        )
      `);
    insertContractYearStatement =
      database.prepare(`
        INSERT INTO contract_years (
          id,
          league_id,
          contract_id,
          season_id,
          year_number,
          aav_cents,
          status,
          rollover_at_ms,
          created_at_ms
        ) VALUES (
          @id,
          @league_id,
          @contract_id,
          @season_id,
          @year_number,
          @aav_cents,
          @status,
          @rollover_at_ms,
          @created_at_ms
        )
      `);
    insertContractEventStatement =
      database.prepare(`
        INSERT INTO contract_events (
          id,
          league_id,
          contract_id,
          player_id,
          team_id,
          actor_user_id,
          event_type,
          source_type,
          source_id,
          metadata_json,
          reason,
          occurred_at_ms
        ) VALUES (
          @id,
          @league_id,
          @contract_id,
          @player_id,
          @team_id,
          NULL,
          @event_type,
          @source_type,
          @source_id,
          @metadata_json,
          NULL,
          @occurred_at_ms
        )
      `);
    insertOwnershipStatement =
      database.prepare(`
        INSERT INTO player_ownerships (
          id,
          league_id,
          season_id,
          player_id,
          team_id,
          ownership_kind,
          roster_category,
          position_group,
          slot_number,
          acquired_transaction_type,
          acquired_transaction_id,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @id,
          @league_id,
          @season_id,
          @player_id,
          @team_id,
          @ownership_kind,
          @roster_category,
          @position_group,
          @slot_number,
          @acquired_transaction_type,
          @acquired_transaction_id,
          @created_at_ms,
          @updated_at_ms,
          @version
        )
      `);
    insertOwnershipEventStatement =
      database.prepare(`
        INSERT INTO ownership_events (
          id,
          league_id,
          season_id,
          player_id,
          team_id,
          ownership_id,
          event_type,
          actor_user_id,
          source_type,
          source_id,
          before_metadata_json,
          after_metadata_json,
          reason,
          occurred_at_ms
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          @playerId,
          @teamId,
          @ownershipId,
          'fad_allocation_player_acquired',
          NULL,
          'free_agent_draft_allocation',
          @allocationId,
          NULL,
          @afterMetadataJson,
          NULL,
          @nowMs
        )
      `);
    insertAuctionStatement =
      database.prepare(`
        INSERT INTO auctions (
          id,
          league_id,
          season_id,
          player_id,
          status,
          opened_at_ms,
          resolves_at_ms,
          opened_by_user_id,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @auctionId,
          @leagueId,
          @seasonId,
          @playerId,
          'open',
          @openedAtMs,
          @resolvesAtMs,
          NULL,
          @openedAtMs,
          @openedAtMs,
          1
        )
      `);
    updateAutomaticAwardStatement =
      database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET
          status = 'automatic_award',
          decision_code = @decisionCode,
          winning_snapshot_entry_id =
            @winningSnapshotEntryId,
          winning_team_id = @winningTeamId,
          contract_id = @contractId,
          ownership_id = @ownershipId,
          restricted_auction_id = NULL,
          fallback_open_auction_id = NULL,
          restricted_minimum_total_cents = NULL,
          restricted_minimum_term_years = NULL,
          restricted_minimum_aav_cents = NULL,
          accounted_at_ms = @nowMs,
          last_error_code = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
          AND player_id = @playerId
          AND status = 'pending'
          AND version =
            @expectedAllocationVersion
      `);
    updateRestrictedStatement =
      database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET
          status = @restrictedStatus,
          decision_code =
            'exact_total_and_term_tie',
          winning_snapshot_entry_id = NULL,
          winning_team_id = NULL,
          contract_id = NULL,
          ownership_id = NULL,
          restricted_auction_id = @auctionId,
          fallback_open_auction_id = NULL,
          restricted_minimum_total_cents =
            @minimumTotalValueCents,
          restricted_minimum_term_years =
            @minimumTermYears,
          restricted_minimum_aav_cents =
            @minimumAavCents,
          accounted_at_ms = NULL,
          last_error_code = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
          AND player_id = @playerId
          AND status = 'pending'
          AND version =
            @expectedAllocationVersion
      `);
    updateNoValidOfferStatement =
      database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET
          status = 'no_valid_offer',
          decision_code = 'no_valid_offer',
          winning_snapshot_entry_id = NULL,
          winning_team_id = NULL,
          contract_id = NULL,
          ownership_id = NULL,
          restricted_auction_id = NULL,
          fallback_open_auction_id = NULL,
          restricted_minimum_total_cents = NULL,
          restricted_minimum_term_years = NULL,
          restricted_minimum_aav_cents = NULL,
          accounted_at_ms = @nowMs,
          last_error_code = NULL,
          updated_at_ms = @nowMs,
          version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
          AND player_id = @playerId
          AND status = 'pending'
          AND version =
            @expectedAllocationVersion
      `);
    updateCorrectionRequiredStatement =
      database.prepare(`
        UPDATE free_agent_draft_player_allocations
        SET
          status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @nowMs,
          version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND fad_id = @fadId
          AND id = @allocationId
          AND player_id = @playerId
          AND status = 'pending'
          AND version =
            @expectedAllocationVersion
      `);
    insertAuctionContextStatement =
      database.prepare(`
        INSERT INTO auction_contexts (
          id,
          league_id,
          season_id,
          auction_id,
          source_kind,
          fad_id,
          fad_rollover_id,
          fad_allocation_id,
          fad_origin,
          created_at_ms
        ) VALUES (
          @auctionId,
          @leagueId,
          @seasonId,
          @auctionId,
          'fad_restricted',
          @fadId,
          @rolloverId,
          @allocationId,
          'candidate_tie_restricted',
          @openedAtMs
        )
      `);
    insertParticipantStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_auction_participants (
          id,
          league_id,
          season_id,
          fad_id,
          allocation_id,
          auction_id,
          team_id,
          status,
          source_snapshot_entry_id,
          originating_candidate_revision_id,
          minimum_total_value_cents,
          minimum_term_years,
          minimum_aav_cents,
          active_improvement_bid_id,
          manager_edit_limit,
          cooldown_duration_ms,
          first_improvement_at_ms,
          current_cooldown_anchor_at_ms,
          improvement_committed_at_ms,
          originating_actor_user_id,
          originating_actor_membership_id,
          originating_actor_authority,
          removed_by_user_id,
          removed_by_membership_id,
          removed_authority,
          removal_reason,
          removed_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @participantId,
          @leagueId,
          @seasonId,
          @fadId,
          @allocationId,
          @auctionId,
          @teamId,
          'active',
          @sourceSnapshotEntryId,
          @originatingCandidateRevisionId,
          @minimumTotalValueCents,
          @minimumTermYears,
          @minimumAavCents,
          NULL,
          1,
          4500000,
          NULL,
          NULL,
          NULL,
          @originatingActorUserId,
          @originatingActorMembershipId,
          @originatingActorAuthority,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @nowMs,
          @nowMs,
          1
        )
      `);
    insertDrawStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_draws (
          id,
          league_id,
          season_id,
          fad_id,
          allocation_id,
          auction_id,
          algorithm_version,
          nonce_bytes,
          commitment_hex,
          ordered_tied_bid_ids_json,
          ordered_tied_team_ids_json,
          rejection_counter,
          selected_index,
          selected_bid_id,
          selected_team_id,
          selected_digest_hex,
          revealed_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        ) VALUES (
          @drawId,
          @leagueId,
          @seasonId,
          @fadId,
          @allocationId,
          @auctionId,
          1,
          @nonceBytes,
          @commitmentHex,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @openedAtMs,
          @openedAtMs,
          1
        )
      `);
    insertActivationJobStatement =
      database.prepare(`
        INSERT INTO job_runs (
          id,
          league_id,
          season_id,
          job_type,
          occurrence_key,
          scheduled_for_ms,
          status,
          attempt_count,
          lease_owner,
          lease_expires_at_ms,
          started_at_ms,
          completed_at_ms,
          result_json,
          last_error_code,
          created_at_ms,
          updated_at_ms,
          version,
          lease_token,
          next_attempt_at_ms
        ) VALUES (
          @activationJobRunId,
          @leagueId,
          @seasonId,
          '${RESTRICTED_ACTIVATION_JOB_TYPE}',
          @activationOccurrenceKey,
          @activationAtMs,
          'pending',
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          @nowMs,
          @nowMs,
          1,
          NULL,
          NULL
        )
      `);
    insertActivityStatement =
      database.prepare(`
        INSERT INTO league_activity (
          id,
          league_id,
          season_id,
          event_type,
          actor_user_id,
          actor_authority,
          team_id,
          player_id,
          related_type,
          related_id,
          display_summary,
          reason,
          metadata_json,
          occurred_at_ms
        ) VALUES (
          @activityId,
          @leagueId,
          @seasonId,
          @eventType,
          NULL,
          'system',
          @teamId,
          @playerId,
          'free_agent_draft_allocation',
          @allocationId,
          @displaySummary,
          NULL,
          @metadataJson,
          @nowMs
        )
      `);
    insertAllocationEventStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_allocation_events (
          id,
          league_id,
          season_id,
          fad_id,
          allocation_id,
          allocation_version,
          player_id,
          event_kind,
          snapshot_entry_id,
          team_id,
          offer_valid,
          rank_position,
          offer_outcome_code,
          decision_code,
          resulting_allocation_status,
          contract_id,
          ownership_id,
          auction_id,
          activity_id,
          correction_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          evidence_json,
          occurred_at_ms,
          created_at_ms,
          version
        ) VALUES (
          @eventId,
          @leagueId,
          @seasonId,
          @fadId,
          @allocationId,
          @allocationVersion,
          @playerId,
          @eventKind,
          @snapshotEntryId,
          @teamId,
          @offerValid,
          @rankPosition,
          @offerOutcomeCode,
          @decisionCode,
          @resultingAllocationStatus,
          @contractId,
          @ownershipId,
          @auctionId,
          @activityId,
          NULL,
          NULL,
          NULL,
          'system',
          @evidenceJson,
          @nowMs,
          @nowMs,
          1
        )
      `);
    insertAllocationRecoveryStatement =
      database.prepare(`
        INSERT INTO free_agent_draft_recoveries (
          id,
          league_id,
          season_id,
          fad_id,
          player_id,
          allocation_id,
          rollover_id,
          auction_id,
          job_run_id,
          kind,
          status,
          earliest_activation_at_ms,
          target_resolution_at_ms,
          last_error_code,
          commissioner_reason,
          created_by_operation_id,
          resolved_by_user_id,
          resolved_by_membership_id,
          resolved_authority,
          created_at_ms,
          updated_at_ms,
          resolved_at_ms,
          version
        ) VALUES (
          @recoveryId,
          @leagueId,
          @seasonId,
          @fadId,
          @playerId,
          @allocationId,
          NULL,
          NULL,
          @jobRunId,
          '${ALLOCATION_RECOVERY_KIND}',
          'correction_required',
          NULL,
          NULL,
          @errorCode,
          NULL,
          @jobRunId,
          NULL,
          NULL,
          NULL,
          @nowMs,
          @nowMs,
          NULL,
          1
        )
      `);
    succeedAllocationJobStatement =
      database.prepare(`
        UPDATE job_runs
        SET
          status = 'succeeded',
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @nowMs,
          result_json = @resultJson,
          last_error_code = NULL,
          updated_at_ms = @nowMs,
          version = version + 1,
          lease_token = NULL,
          next_attempt_at_ms = NULL
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @jobRunId
          AND job_type = '${ALLOCATION_JOB_TYPE}'
          AND occurrence_key = @occurrenceKey
          AND status IN ('leased', 'running')
          AND lease_owner = @leaseOwner
          AND lease_token = @leaseToken
          AND lease_expires_at_ms > @nowMs
          AND version = @expectedJobVersion
      `);
    failAllocationJobStatement =
      database.prepare(`
        UPDATE job_runs
        SET
          status = 'failed',
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @nowMs,
          result_json = NULL,
          last_error_code = @errorCode,
          updated_at_ms = @nowMs,
          version = version + 1,
          lease_token = NULL,
          next_attempt_at_ms = ${MAX_TIMESTAMP_MS}
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @jobRunId
          AND job_type = '${ALLOCATION_JOB_TYPE}'
          AND occurrence_key = @occurrenceKey
          AND status IN ('leased', 'running')
          AND lease_owner = @leaseOwner
          AND lease_token = @leaseToken
          AND lease_expires_at_ms > @nowMs
          AND version = @expectedJobVersion
      `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareCandidateAllocationRepository",
      tableName:
        "free_agent_draft_player_allocations",
    });
  }

  function readContext(scope) {
    return uniqueRow(
      contextStatement,
      scope,
      "Candidate allocation aggregate"
    );
  }

  function readOffers(command) {
    const rows = offersStatement.all(command);
    if (rows.length < 1) {
      incompatible(
        "A pending Candidate allocation must have immutable snapshot offers."
      );
    }
    const offers = rows.map((row) =>
      Object.freeze({
        offerId: row.snapshot_entry_id,
        cardSnapshotId: row.snapshot_id,
        teamId: row.team_id,
        playerId: row.player_id,
        rowKind: row.row_kind,
        totalValueCents:
          row.proposed_total_value_cents,
        termYears: row.proposed_term_years,
        aavCents: row.proposed_aav_cents,
        eligibilityStatus:
          row.eligibility_status,
        cardAllocationEligibility:
          row.allocation_eligibility,
        cardCompletenessCode:
          row.card_completeness_code,
      })
    );
    let decision;
    try {
      decision = decideCandidateAllocation({
        playerId: command.playerId,
        offers,
      });
    } catch (error) {
      if (
        error instanceof
        CandidateAllocationPolicyError
      ) {
        incompatible(
          "The immutable Candidate allocation snapshot is invalid.",
          error
        );
      }
      throw error;
    }
    const rowsById = new Map(
      rows.map((row) => [
        row.snapshot_entry_id,
        row,
      ])
    );
    return Object.freeze({
      rows: Object.freeze(rows),
      rowsById,
      offers: Object.freeze(offers),
      decision,
    });
  }

  function expectedOfferEvidence(
    allocationData
  ) {
    const {
      decision,
      offers,
    } = allocationData;
    const eligibleRank = new Map(
      decision.eligibleOffers.map(
        (offer, index) => [
          offer.offerId,
          index + 1,
        ]
      )
    );
    const excludedOrder = new Map(
      decision.excludedOffers.map(
        (offer, index) => [
          offer.offerId,
          index + 1,
        ]
      )
    );
    const exclusions = new Map(
      decision.excludedOffers.map(
        (offer) => [
          offer.offerId,
          offer.reasonCode,
        ]
      )
    );
    const tieIds = new Set(
      decision.restrictedTie?.participants.map(
        (participant) =>
          participant.sourceSnapshotEntryId
      ) || []
    );
    const top =
      decision.eligibleOffers[0] || null;
    return Object.freeze(
      offers
        .map((offer) => {
          const exclusion =
            exclusions.get(offer.offerId) ||
            null;
          let outcomeCode;
          if (
            exclusion ===
            "candidate_card_structural_conflict"
          ) {
            outcomeCode =
              "excluded_structural_conflict";
          } else if (
            exclusion ===
            "candidate_card_over_cap"
          ) {
            outcomeCode = "excluded_over_cap";
          } else if (exclusion !== null) {
            outcomeCode = "invalid";
          } else if (
            decision.winner?.offerId ===
            offer.offerId
          ) {
            outcomeCode = "winner";
          } else if (
            tieIds.has(offer.offerId)
          ) {
            outcomeCode = "restricted_tied";
          } else if (
            top &&
            offer.totalValueCents <
              top.totalValueCents
          ) {
            outcomeCode = "lost_lower_total";
          } else {
            outcomeCode = "lost_lower_aav";
          }
          return Object.freeze({
            offer,
            offerValid: exclusion === null,
            rankPosition:
              eligibleRank.get(offer.offerId) ||
              null,
            outcomeCode,
            exclusionReason: exclusion,
          });
        })
        .sort(
          (left, right) => {
            if (
              left.rankPosition !== null &&
              right.rankPosition !== null
            ) {
              return (
                left.rankPosition -
                  right.rankPosition ||
                left.offer.offerId.localeCompare(
                  right.offer.offerId
                )
              );
            }
            if (left.rankPosition !== null) return -1;
            if (right.rankPosition !== null) return 1;
            return (
              excludedOrder.get(left.offer.offerId) -
                excludedOrder.get(right.offer.offerId) ||
              left.offer.offerId.localeCompare(
                right.offer.offerId
              )
            );
          }
        )
    );
  }

  function offerEvidenceJson(
    command,
    evidence
  ) {
    return canonicalJson({
      schemaVersion: 1,
      occurrenceKey:
        command.occurrenceKey,
      allocationId:
        command.allocationId,
      playerId: command.playerId,
      offer: evidence.offer,
      offerValid:
        evidence.offerValid,
      rankPosition:
        evidence.rankPosition,
      outcomeCode:
        evidence.outcomeCode,
      exclusionReason:
        evidence.exclusionReason,
    });
  }

  function newIdentityFactory() {
    const used = new Set();
    return (description) => {
      const value = stableId(
        createId(description),
        description
      );
      if (used.has(value)) {
        invalid(
          "Candidate allocation identifier factories must return unique identifiers."
        );
      }
      used.add(value);
      return value;
    };
  }

  function availabilityIssue(command) {
    for (const candidate of [
      {
        statement: activeOwnershipStatement,
        description: "player ownership",
        kind: "player_ownership",
        code:
          ALLOCATION_CORRECTION_ERROR_CODES
            .playerOwned,
      },
      {
        statement: activeContractStatement,
        description: "active player contract",
        kind: "active_contract",
        code:
          ALLOCATION_CORRECTION_ERROR_CODES
            .playerContracted,
      },
      {
        statement: activeAuctionStatement,
        description: "active player auction",
        kind: "active_auction",
        code:
          ALLOCATION_CORRECTION_ERROR_CODES
            .playerAuctionActive,
      },
    ]) {
      const row = uniqueRow(
        candidate.statement,
        command,
        candidate.description
      );
      if (row) {
        return deepFreeze({
          code: candidate.code,
          kind: candidate.kind,
          resourceId: row.id,
        });
      }
    }
    return null;
  }

  function requireActiveOperation(
    command,
    context,
    job
  ) {
    if (
      context.allocation_status !== "pending" ||
      context.allocation_version !==
        command.expectedAllocationVersion
    ) {
      conflict(
        "The Candidate allocation version is stale."
      );
    }
    if (
      context.fad_status !== "allocating" ||
      context.league_status !== "active" ||
      context.current_season_id !==
        command.seasonId ||
      context.season_status !== "active" ||
      context.player_status !== "active" ||
      command.nowMs <
        context.candidate_deadline_at_ms
    ) {
      conflict(
        "The Candidate allocation is not in an allocatable state."
      );
    }
    if (
      !job ||
      job.status !== "leased" &&
        job.status !== "running" ||
      job.version !==
        command.expectedJobVersion ||
      job.lease_owner !==
        command.leaseOwner ||
      job.lease_token !==
        command.leaseToken ||
      job.lease_expires_at_ms === null ||
      job.lease_expires_at_ms <=
        command.nowMs ||
      job.started_at_ms === null ||
      job.started_at_ms >
        command.nowMs ||
      job.scheduled_for_ms !==
        context.candidate_deadline_at_ms ||
      job.attempt_count < 1
    ) {
      conflict(
        "The exact Candidate allocation lease is not active."
      );
    }
  }

  function inspectRequestedDestination(
    command,
    row
  ) {
    if (
      row.row_kind !== "slot" ||
      row.source_entry_matches !== 1 ||
      !["F", "D", "B"].includes(
        row.slot_group
      ) ||
      !["F", "D"].includes(
        row.effective_position_group
      )
    ) {
      return deepFreeze({
        issue: {
          code:
            ALLOCATION_CORRECTION_ERROR_CODES
              .destinationMismatch,
          kind:
            "authoritative_destination_mismatch",
          resourceId: row.source_entry_id,
        },
        destination: null,
      });
    }
    const rosterCategory =
      row.slot_group === "B"
        ? "Bench"
        : "Active";
    const occupant = uniqueRow(
      occupiedSlotStatement,
      {
        ...command,
        teamId: row.team_id,
        rosterCategory,
        positionGroup:
          row.effective_position_group,
        slotNumber: row.slot_number,
      },
      "requested roster destination"
    );
    if (occupant) {
      return deepFreeze({
        issue: {
          code:
            ALLOCATION_CORRECTION_ERROR_CODES
              .destinationOccupied,
          kind: "requested_slot_occupied",
          resourceId: occupant.id,
        },
        destination: null,
      });
    }
    return deepFreeze({
      issue: null,
      destination: {
        rosterCategory,
        positionGroup:
          row.effective_position_group,
        slotNumber: row.slot_number,
      },
    });
  }

  function currentLegality(
    command,
    teamId
  ) {
    const rows = rosterRowsStatement.all({
      ...command,
      teamId,
    });
    const structural =
      evaluateStructuralRosterLegality({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        teamId,
        assignments: rows.map((row) => ({
          leagueId: row.league_id,
          seasonId: row.season_id,
          teamId: row.team_id,
          playerId: row.player_id,
          rosterCategory:
            row.roster_category,
          assignedPositionGroup:
            row.position_group,
        })),
        effectivePositions: rows.map(
          (row) => ({
            playerId: row.player_id,
            positionGroup:
              row.effective_position,
          })
        ),
      });
    const cap = capReader.calculate({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      teamId,
    });
    const warnings = [
      ...structural.reasons.map((reason) =>
        safeWarning(reason, teamId)
      ),
      ...cap.issues.map((reason) =>
        safeWarning(reason, teamId)
      ),
      ...(cap.overCap
        ? [
            Object.freeze({
              code: "TEAM_OVER_CAP",
              teamId,
              playerId: null,
              ownershipId: null,
              contractId: null,
            }),
          ]
        : []),
    ];
    return deepFreeze({
      generalIllegal: warnings.length > 0,
      structuralLegal: structural.legal,
      capCompliant: !cap.overCap,
      warnings,
    });
  }

  function requirePublication({
    aggregateId,
    aggregateType,
    audienceKind,
    eventId,
    eventType,
    leagueId,
    occurredAtMs,
    reasonCode,
    related,
    teamId = null,
    userId = null,
    version,
  }) {
    const rows = publicationStatement.all({
      leagueId,
      eventId,
    });
    if (
      rows.length !== 1 ||
      rows[0].event_type !== eventType ||
      rows[0].aggregate_type !== aggregateType ||
      rows[0].aggregate_id !== aggregateId ||
      rows[0].created_at_ms !== occurredAtMs ||
      rows[0].available_at_ms !== occurredAtMs ||
      rows[0].audience_kind !== audienceKind ||
      rows[0].audience_team_id !== teamId ||
      rows[0].audience_user_id !== userId
    ) {
      incompatible(
        "The Candidate allocation publication evidence is incomplete."
      );
    }
    let payload;
    try {
      payload = JSON.parse(rows[0].payload_json);
    } catch (error) {
      incompatible(
        "The Candidate allocation publication payload is invalid.",
        error
      );
    }
    const expected = createSocketEventEnvelope({
      eventId,
      type: eventType,
      leagueId,
      resourceId: aggregateId,
      version,
      reasonCode,
      occurredAt: occurredAtMs,
      related,
    });
    if (JSON.stringify(payload) !== JSON.stringify(expected)) {
      incompatible(
        "The Candidate allocation publication payload is not exact."
      );
    }
    return rows[0];
  }

  function correctionNotificationContract({
    command,
    issue,
    recoveryId,
    userId,
  }) {
    return createFreeAgentDraftNotificationContract({
      type: "fad_correction_required",
      recipientUserId: userId,
      messageData: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId: command.allocationId,
        auctionId: null,
        recoveryId,
        playerId: command.playerId,
        errorCode: issue.code,
        destination: {
          kind: "fad_recovery",
          leagueId: command.leagueId,
          fadId: command.fadId,
          recoveryId,
        },
      },
    });
  }

  function requireCorrectionNotification(
    command,
    issue,
    recoveryId
  ) {
    const notification = uniqueRow(
      correctionNotificationStatement,
      { ...command, recoveryId },
      "Candidate allocation correction-required notification"
    );
    if (!notification) {
      incompatible(
        "The Candidate allocation correction-required notification is unavailable."
      );
    }
    const contract = correctionNotificationContract({
      command,
      issue,
      recoveryId,
      userId: notification.user_id,
    });
    const ids = correctionPublicationIds(
      recoveryId,
      notification.user_id
    );
    if (
      notification.id !== ids.notification ||
      notification.user_id !== contract.recipientUserId ||
      notification.league_id !== command.leagueId ||
      notification.message_data_json !==
        JSON.stringify(contract.messageData) ||
      notification.related_feature !== "free_agent_draft" ||
      notification.related_record_id !== command.fadId ||
      notification.delivery_status !== "pending" ||
      notification.read_at_ms !== null ||
      notification.delivered_at_ms !== null ||
      notification.version !== 1 ||
      notification.deduplication_key !== contract.deduplicationKey
    ) {
      incompatible(
        "The Candidate allocation correction-required notification is not exact."
      );
    }
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      recoveryId,
    });
    requirePublication({
      aggregateId: notification.id,
      aggregateType: "notification",
      audienceKind: "user",
      eventId: ids.notificationOutbox,
      eventType: "notification.created",
      leagueId: command.leagueId,
      occurredAtMs: notification.created_at_ms,
      reasonCode: "allocation_changed",
      related,
      userId: notification.user_id,
      version: 1,
    });
    return Object.freeze({
      contract,
      ids,
      notification,
      related,
    });
  }

  function writeCorrectionPublications({
    command,
    context,
    issue,
    recoveryId,
  }) {
    const commissioner = uniqueRow(
      commissionerStatement,
      command,
      "Candidate allocation correction commissioner"
    );
    if (!commissioner) {
      conflict(
        "The Candidate allocation correction has no current commissioner recipient."
      );
    }
    const contract = correctionNotificationContract({
      command,
      issue,
      recoveryId,
      userId: commissioner.user_id,
    });
    const ids = correctionPublicationIds(
      recoveryId,
      commissioner.user_id
    );
    notifications.insert({
      id: ids.notification,
      userId: contract.recipientUserId,
      leagueId: command.leagueId,
      eventType: contract.type,
      messageDataJson: JSON.stringify(contract.messageData),
      relatedFeature: "free_agent_draft",
      relatedRecordId: command.fadId,
      deliveryStatus: "pending",
      createdAtMs: command.nowMs,
      deliveredAtMs: null,
      deduplicationKey: contract.deduplicationKey,
    });
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      allocationId: command.allocationId,
      recoveryId,
    });
    outboxWriter.write({
      id: ids.fad,
      leagueId: command.leagueId,
      eventType: "free_agent_draft.changed",
      aggregateType: "free_agent_draft",
      aggregateId: command.fadId,
      payload: createSocketEventMetadata({
        eventType: "free_agent_draft.changed",
        version: context.fad_version,
        reasonCode: "allocation_changed",
        occurredAtMs: command.nowMs,
        related,
      }),
      occurredAtMs: command.nowMs,
    });
    outboxWriter.write({
      id: ids.notificationOutbox,
      leagueId: command.leagueId,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: ids.notification,
      payload: createSocketEventMetadata({
        eventType: "notification.created",
        version: 1,
        reasonCode: "allocation_changed",
        occurredAtMs: command.nowMs,
        related,
      }),
      occurredAtMs: command.nowMs,
      audiences: [
        {
          kind: "user",
          userId: commissioner.user_id,
        },
      ],
    });
    requireCorrectionNotification(
      command,
      issue,
      recoveryId
    );
    requirePublication({
      aggregateId: command.fadId,
      aggregateType: "free_agent_draft",
      audienceKind: "league",
      eventId: ids.fad,
      eventType: "free_agent_draft.changed",
      leagueId: command.leagueId,
      occurredAtMs: command.nowMs,
      reasonCode: "allocation_changed",
      related,
      version: context.fad_version,
    });
    return ids;
  }

  function correctionResponse({
    command,
    issue,
    recoveryId,
    offerEventIds,
    eventId,
    outboxEventId,
    replayed,
  }) {
    return deepFreeze({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId:
        command.allocationId,
      playerId: command.playerId,
      occurrenceKey:
        command.occurrenceKey,
      status: "correction_required",
      decisionCode: null,
      allocationVersion:
        command.expectedAllocationVersion +
        1,
      accountedAtMs: null,
      winner: null,
      restrictedAuction: null,
      recovery: {
        id: recoveryId,
        kind: ALLOCATION_RECOVERY_KIND,
        status: "correction_required",
        errorCode: issue.code,
        jobRunId: command.jobRunId,
      },
      evidence: {
        offerEventIds,
        decisionEventId: eventId,
        activityId: null,
        outboxEventId,
        recoveryId,
      },
      jobRunId: command.jobRunId,
      jobRunVersion:
        command.expectedJobVersion + 1,
      replayed,
    });
  }

  function persistCorrectionRequired({
    command,
    context,
    issue,
    allocationData,
    id,
  }) {
    const recoveryId = id(
      "Candidate allocation recovery"
    );
    const eventId = id(
      "Candidate allocation correction-required event"
    );
    const evidenceJson = canonicalJson({
      schemaVersion: 1,
      operation:
        "free_agent_draft_allocation_quarantined",
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId:
          command.allocationId,
        playerId: command.playerId,
        occurrenceKey:
          command.occurrenceKey,
        jobRunId: command.jobRunId,
      },
      issue,
      publication: {
        fadVersion: context.fad_version,
      },
    });
    insertAllocationRecoveryStatement.run({
      ...command,
      recoveryId,
      errorCode: issue.code,
    });
    requireChanged(
      updateCorrectionRequiredStatement.run({
        ...command,
        errorCode: issue.code,
      }),
      "The Candidate allocation changed before its recovery quarantine committed."
    );
    const offerEventIds = [];
    for (
      const evidence of
        expectedOfferEvidence(
          allocationData
        )
    ) {
      const offerEventId = id(
        "Candidate offer-considered event"
      );
      offerEventIds.push(offerEventId);
      insertAllocationEventStatement.run({
        ...command,
        eventId: offerEventId,
        allocationVersion:
          command.expectedAllocationVersion +
          1,
        eventKind: "offer_considered",
        snapshotEntryId:
          evidence.offer.offerId,
        teamId: evidence.offer.teamId,
        offerValid:
          evidence.offerValid ? 1 : 0,
        rankPosition:
          evidence.rankPosition,
        offerOutcomeCode:
          evidence.outcomeCode,
        decisionCode: null,
        resultingAllocationStatus:
          "correction_required",
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: null,
        evidenceJson: offerEvidenceJson(
          command,
          evidence
        ),
      });
    }
    insertAllocationEventStatement.run({
      ...command,
      eventId,
      allocationVersion:
        command.expectedAllocationVersion +
        1,
      eventKind: "decision_recorded",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: null,
      resultingAllocationStatus:
        "correction_required",
      contractId: null,
      ownershipId: null,
      auctionId: null,
      activityId: null,
      evidenceJson,
    });
    const publicationIds =
      writeCorrectionPublications({
        command,
        context,
        issue,
        recoveryId,
      });
    requireChanged(
      failAllocationJobStatement.run({
        ...command,
        errorCode: issue.code,
      }),
      "The Candidate allocation lease changed before its recovery quarantine committed."
    );
    return correctionResponse({
      command,
      issue,
      recoveryId,
      offerEventIds,
      eventId,
      outboxEventId: publicationIds.fad,
      replayed: false,
    });
  }

  function validateCorrectionReplay(
    command,
    context,
    job
  ) {
    const expectedAllocationVersion =
      command.expectedAllocationVersion +
      1;
    const expectedJobVersion =
      command.expectedJobVersion + 1;
    if (
      context.allocation_status !==
        "correction_required" ||
      context.allocation_version !==
        expectedAllocationVersion ||
      !job ||
      job.status !== "failed" ||
      job.version !== expectedJobVersion
    ) {
      return null;
    }
    const row = uniqueRow(
      correctionReplayStatement,
      command,
      "Candidate allocation recovery replay evidence"
    );
    if (!row) {
      incompatible(
        "The persisted Candidate allocation recovery replay evidence is incomplete."
      );
    }
    const allocationData =
      readOffers(command);
    const expectedOffers =
      expectedOfferEvidence(
        allocationData
      );
    const offerEvents =
      allocationEventsStatement
        .all(command)
        .filter(
          (event) =>
            event.allocation_version ===
              expectedAllocationVersion &&
            event.event_kind ===
              "offer_considered"
        );
    const offerEventsBySnapshotId =
      new Map(
        offerEvents.map((event) => [
          event.snapshot_entry_id,
          event,
        ])
      );
    if (
      offerEvents.length !==
        expectedOffers.length ||
      offerEventsBySnapshotId.size !==
        expectedOffers.length
    ) {
      incompatible(
        "The persisted Candidate allocation recovery replay offer evidence is incomplete."
      );
    }
    const offerEventIds = [];
    for (const expected of expectedOffers) {
      const event =
        offerEventsBySnapshotId.get(
          expected.offer.offerId
        );
      if (
        !event ||
        event.team_id !==
          expected.offer.teamId ||
        event.offer_valid !==
          (expected.offerValid ? 1 : 0) ||
        event.rank_position !==
          expected.rankPosition ||
        event.offer_outcome_code !==
          expected.outcomeCode ||
        event.decision_code !== null ||
        event.resulting_allocation_status !==
          "correction_required" ||
        event.contract_id !== null ||
        event.ownership_id !== null ||
        event.auction_id !== null ||
        event.activity_id !== null ||
        event.occurred_at_ms !==
          context.allocation_updated_at_ms ||
        event.evidence_json !==
          offerEvidenceJson(
            command,
            expected
          )
      ) {
        incompatible(
          "The persisted Candidate allocation recovery replay offer evidence conflicts with its immutable snapshot."
        );
      }
      offerEventIds.push(event.id);
    }
    const evidence = parseCanonicalJson(
      row.evidence_json,
      "Candidate allocation recovery event evidence"
    );
    exactObject(
      evidence,
      [
        "schemaVersion",
        "operation",
        "identity",
        "issue",
        "publication",
      ],
      "Candidate allocation recovery event evidence"
    );
    exactObject(
      evidence.identity,
      [
        "leagueId",
        "seasonId",
        "fadId",
        "allocationId",
        "playerId",
        "occurrenceKey",
        "jobRunId",
      ],
      "Candidate allocation recovery event identity"
    );
    exactObject(
      evidence.issue,
      ["code", "kind", "resourceId"],
      "Candidate allocation recovery issue"
    );
    exactObject(
      evidence.publication,
      ["fadVersion"],
      "Candidate allocation recovery publication"
    );
    if (
      evidence.schemaVersion !== 1 ||
      evidence.operation !==
        "free_agent_draft_allocation_quarantined" ||
      evidence.identity.leagueId !==
        command.leagueId ||
      evidence.identity.seasonId !==
        command.seasonId ||
      evidence.identity.fadId !==
        command.fadId ||
      evidence.identity.allocationId !==
        command.allocationId ||
      evidence.identity.playerId !==
        command.playerId ||
      evidence.identity.occurrenceKey !==
        command.occurrenceKey ||
      evidence.identity.jobRunId !==
        command.jobRunId ||
      !Number.isSafeInteger(
        evidence.publication.fadVersion
      ) ||
      evidence.publication.fadVersion < 1 ||
      row.recovery_kind !==
        ALLOCATION_RECOVERY_KIND ||
      row.recovery_status !==
        "correction_required" ||
      row.recovery_version !== 1 ||
      row.job_run_id !==
        command.jobRunId ||
      row.event_kind !==
        "decision_recorded" ||
      row.event_decision_code !== null ||
      row.resulting_allocation_status !==
        "correction_required" ||
      row.last_error_code !==
        context.last_error_code ||
      evidence.issue.code !==
        context.last_error_code ||
      row.recovery_created_at_ms !==
        context.allocation_updated_at_ms ||
      row.occurred_at_ms !==
        context.allocation_updated_at_ms ||
      job.last_error_code !==
        context.last_error_code ||
      job.completed_at_ms !==
        context.allocation_updated_at_ms ||
      job.updated_at_ms !==
        context.allocation_updated_at_ms ||
      job.result_json !== null ||
      job.lease_owner !== null ||
      job.lease_token !== null ||
      job.lease_expires_at_ms !== null ||
      job.next_attempt_at_ms !==
        MAX_TIMESTAMP_MS
    ) {
      incompatible(
        "The persisted Candidate allocation recovery replay evidence conflicts with its exact occurrence."
      );
    }
    const publication =
      requireCorrectionNotification(
        command,
        evidence.issue,
        row.recovery_id
      );
    requirePublication({
      aggregateId: command.fadId,
      aggregateType: "free_agent_draft",
      audienceKind: "league",
      eventId: publication.ids.fad,
      eventType: "free_agent_draft.changed",
      leagueId: command.leagueId,
      occurredAtMs:
        context.allocation_updated_at_ms,
      reasonCode: "allocation_changed",
      related: publication.related,
      version:
        evidence.publication.fadVersion,
    });
    return correctionResponse({
      command,
      issue: evidence.issue,
      recoveryId: row.recovery_id,
      offerEventIds,
      eventId: row.event_id,
      outboxEventId: publication.ids.fad,
      replayed: true,
    });
  }

  function persistAutomaticAward({
    command,
    context,
    allocationData,
    destination,
    id,
  }) {
    const winner =
      allocationData.decision.winner;
    const winnerRow =
      allocationData.rowsById.get(
        winner.offerId
      );
    if (!winnerRow) {
      incompatible(
        "The deterministic Candidate winner is absent from its snapshot."
      );
    }
    const futureSeasonIds = [
      id("future contract season"),
      id("future contract season"),
    ];
    let seasonPlan;
    try {
      seasonPlan = planContractSeasons({
        leagueId: command.leagueId,
        targetSeason: {
          id: command.seasonId,
          leagueId: command.leagueId,
          label: context.season_label,
          nhlSeasonKey:
            context.nhl_season_key,
          status: context.season_status,
        },
        existingSeasons:
          seasonsStatement
            .all(command)
            .map((season) => ({
              id: season.id,
              leagueId:
                season.league_id,
              label: season.label,
              nhlSeasonKey:
                season.nhl_season_key,
              status: season.status,
            })),
        futureSeasonIds,
        termYears: winner.termYears,
        nowMs: command.nowMs,
      });
    } catch (error) {
      incompatible(
        "The Candidate contract season schedule is invalid.",
        error
      );
    }
    for (const season of
      seasonPlan.seasonsToCreate) {
      insertSeasonStatement.run({
        id: season.id,
        leagueId: season.leagueId,
        label: season.label,
        nhlSeasonKey:
          season.nhlSeasonKey,
        status: season.status,
        createdAtMs: season.createdAtMs,
      });
    }

    const contractId = id(
      "Candidate allocation contract"
    );
    const contractEventId = id(
      "Candidate allocation contract event"
    );
    const contractYearIds = Array.from(
      { length: winner.termYears },
      () =>
        id(
          "Candidate allocation contract year"
        )
    );
    let contract;
    try {
      contract =
        createNormalContractAggregate({
          contractId,
          contractYearIds,
          contractEventId,
          leagueId: command.leagueId,
          playerId: command.playerId,
          teamId: winner.teamId,
          originalTotalValueCents:
            winner.totalValueCents,
          termYears: winner.termYears,
          startSeasonId:
            command.seasonId,
          seasonIds:
            seasonPlan.seasonIds,
          acquisitionSourceType:
            "free_agent_draft_allocation",
          acquisitionSourceId:
            command.allocationId,
          auctionBuyoutLockExpiresAtMs:
            command.nowMs +
            BUYOUT_LOCK_MS,
          actorUserId: null,
          occurredAtMs: command.nowMs,
        });
    } catch (error) {
      incompatible(
        "The deterministic Candidate contract is invalid.",
        error
      );
    }
    insertContractStatement.run(
      contract.contract
    );
    for (const year of contract.years) {
      insertContractYearStatement.run(year);
    }
    insertContractEventStatement.run(
      contract.event
    );

    const ownershipId = id(
      "Candidate allocation ownership"
    );
    const ownershipEventId = id(
      "Candidate allocation ownership event"
    );
    let ownership;
    try {
      ownership =
        createRosterAssignmentRecord({
          id: ownershipId,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          playerId: command.playerId,
          teamId: winner.teamId,
          ownershipKind: "Rostered",
          rosterCategory:
            destination.rosterCategory,
          positionGroup:
            destination.positionGroup,
          slotNumber:
            destination.slotNumber,
          acquiredTransactionType:
            "free_agent_draft_allocation",
          acquiredTransactionId:
            command.allocationId,
          createdAtMs: command.nowMs,
          updatedAtMs: command.nowMs,
        });
    } catch (error) {
      incompatible(
        "The deterministic Candidate roster assignment is invalid.",
        error
      );
    }
    insertOwnershipStatement.run(ownership);
    insertOwnershipEventStatement.run({
      ...command,
      id: ownershipEventId,
      teamId: winner.teamId,
      ownershipId,
      afterMetadataJson: canonicalJson({
        schemaVersion: 1,
        ownershipKind: "Rostered",
        rosterCategory:
          destination.rosterCategory,
        positionGroup:
          destination.positionGroup,
        slotNumber:
          destination.slotNumber,
      }),
    });

    requireChanged(
      updateAutomaticAwardStatement.run({
        ...command,
        decisionCode:
          allocationData.decision
            .decisionCode,
        winningSnapshotEntryId:
          winner.offerId,
        winningTeamId: winner.teamId,
        contractId,
        ownershipId,
      }),
      "The Candidate allocation changed before its automatic award committed."
    );
    const legality = currentLegality(
      command,
      winner.teamId
    );
    return deepFreeze({
      status: "automatic_award",
      decisionCode:
        allocationData.decision
          .decisionCode,
      allocationVersion:
        command.expectedAllocationVersion +
        1,
      accountedAtMs: command.nowMs,
      winner: {
        snapshotEntryId: winner.offerId,
        teamId: winner.teamId,
        totalValueCents:
          winner.totalValueCents,
        termYears: winner.termYears,
        aavCents: winner.aavCents,
        contractId,
        contractYearIds:
          contract.years.map(
            (year) => year.id
          ),
        contractEventId,
        ownershipId,
        ownershipEventId,
        buyoutLockExpiresAtMs:
          command.nowMs +
          BUYOUT_LOCK_MS,
        requestedSlot: destination,
        legality,
      },
      restrictedAuction: null,
    });
  }

  function restrictedWindow(command) {
    const current = uniqueRow(
      currentRolloverStatement,
      command,
      "current FAD rollover"
    );
    if (!current) {
      conflict(
        "No complete rapid-auction window is available for the restricted Candidate tie."
      );
    }
    if (
      allowImmediateRestrictedActivation &&
      command.nowMs <
      current.creation_cutoff_at_ms
    ) {
      return Object.freeze({
        rollover: current,
        activationAtMs: command.nowMs,
        openedAtMs: command.nowMs,
        mode: "immediate",
      });
    }
    const next = uniqueRow(
      nextRolloverStatement,
      {
        ...command,
        sequence: current.sequence + 1,
        predecessorRolloverId:
          current.id,
        opensAtMs:
          current.rolls_over_at_ms,
      },
      "next FAD rollover"
    );
    if (!next) {
      conflict(
        "A complete following rapid-auction window is required for the restricted Candidate tie."
      );
    }
    return Object.freeze({
      rollover: next,
      activationAtMs:
        next.opens_at_ms,
      openedAtMs: next.opens_at_ms,
      mode: "rollover_scheduled",
    });
  }

  function participantOrigins(
    command,
    allocationData
  ) {
    return allocationData.decision
      .restrictedTie.participants.map(
        (participant) => {
          const row =
            allocationData.rowsById.get(
              participant
                .sourceSnapshotEntryId
            );
          if (!row) {
            incompatible(
              "A restricted Candidate participant is absent from its immutable snapshot."
            );
          }
          const revision = uniqueRow(
            revisionStatement,
            {
              ...command,
              cardId: row.card_id,
              teamId: row.team_id,
              sourceEntryId:
                row.source_entry_id,
              lockedCardVersion:
                row.locked_card_version,
            },
            "originating Candidate revision"
          );
          if (
            !revision ||
            revision.actor_user_id !==
              row.last_edited_by_user_id ||
            revision.actor_membership_id !==
              row.last_edited_by_membership_id ||
            revision.actor_authority !==
              row.last_edited_by_authority ||
            revision.actor_user_id === null ||
            revision.actor_membership_id ===
              null ||
            revision.actor_authority ===
              "system"
          ) {
            incompatible(
              "The restricted Candidate minimum lacks exact originating revision evidence."
            );
          }
          const manager = uniqueRow(
            managerStatement,
            {
              ...command,
              teamId:
                participant.teamId,
            },
            "current restricted participant manager"
          );
          if (!manager) {
            conflict(
              "Every restricted Candidate participant requires one current manager."
            );
          }
          return Object.freeze({
            participant,
            row,
            revision,
            manager,
          });
        }
      );
  }

  function persistRestrictedTie({
    command,
    allocationData,
    id,
  }) {
    const window =
      restrictedWindow(command);
    const origins = participantOrigins(
      command,
      allocationData
    );
    const auctionId = id(
      "restricted Candidate auction"
    );
    const drawId = id(
      "restricted Candidate draw"
    );
    const delayedActivation =
      window.mode === "rollover_scheduled";
    const restrictedStatus =
      delayedActivation
        ? "restricted_scheduled"
        : "restricted_active";
    const activationJobRunId =
      delayedActivation
        ? id(
            "restricted Candidate activation job"
          )
        : null;
    let nonce = createDrawNonce({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId:
        command.allocationId,
      auctionId,
    });
    if (
      !(nonce instanceof Uint8Array) ||
      nonce.byteLength !== 32
    ) {
      invalid(
        "Candidate allocation draw nonce factories must return exactly 32 bytes."
      );
    }
    nonce = Buffer.from(nonce);
    let commitment;
    try {
      commitment =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId,
          nonceBytes: nonce,
        });
    } catch (error) {
      incompatible(
        "The restricted Candidate draw commitment is invalid.",
        error
      );
    }
    const floor =
      allocationData.decision
        .restrictedTie.floor;
    const activationOccurrenceKey =
      delayedActivation
        ? buildFreeAgentDraftRestrictedActivationOccurrenceKey({
            fadId: command.fadId,
            allocationId:
              command.allocationId,
            activationAtMs:
              window.activationAtMs,
          })
        : null;

    insertAuctionStatement.run({
      ...command,
      auctionId,
      openedAtMs: window.openedAtMs,
      resolvesAtMs:
        window.rollover.rolls_over_at_ms,
    });
    requireChanged(
      updateRestrictedStatement.run({
        ...command,
        auctionId,
        restrictedStatus,
        minimumTotalValueCents:
          floor.totalValueCents,
        minimumTermYears:
          floor.termYears,
        minimumAavCents:
          floor.aavCents,
      }),
      "The Candidate allocation changed before its restricted tie committed."
    );
    insertAuctionContextStatement.run({
      ...command,
      auctionId,
      rolloverId: window.rollover.id,
      openedAtMs: window.openedAtMs,
    });

    const participants = [];
    for (const origin of origins) {
      const participantId = id(
        "restricted Candidate participant"
      );
      const notificationId = delayedActivation
        ? null
        : id(
            "restricted Candidate notification"
          );
      const notificationOutboxEventId = delayedActivation
        ? null
        : id(
            "restricted Candidate notification outbox event"
          );
      insertParticipantStatement.run({
        ...command,
        participantId,
        auctionId,
        teamId:
          origin.participant.teamId,
        sourceSnapshotEntryId:
          origin.participant
            .sourceSnapshotEntryId,
        originatingCandidateRevisionId:
          origin.revision.id,
        minimumTotalValueCents:
          floor.totalValueCents,
        minimumTermYears:
          floor.termYears,
        minimumAavCents:
          floor.aavCents,
        originatingActorUserId:
          origin.revision.actor_user_id,
        originatingActorMembershipId:
          origin.revision
            .actor_membership_id,
        originatingActorAuthority:
          origin.revision.actor_authority,
      });
      if (!delayedActivation) {
        const notificationContract =
          createFreeAgentDraftNotificationContract({
            type: "fad_restricted_eligible",
            recipientUserId:
              origin.manager.user_id,
            messageData: {
              leagueId: command.leagueId,
              seasonId: command.seasonId,
              fadId: command.fadId,
              allocationId:
                command.allocationId,
              auctionId,
              playerId: command.playerId,
              teamId:
                origin.participant.teamId,
              destination: {
                kind: "auction",
                leagueId: command.leagueId,
                auctionId,
              },
            },
          });
        notifications.insert({
          id: notificationId,
          userId:
            notificationContract.recipientUserId,
          leagueId: command.leagueId,
          eventType: notificationContract.type,
          messageDataJson: canonicalJson(
            notificationContract.messageData
          ),
          relatedFeature:
            "free_agent_draft_auction",
          relatedRecordId: auctionId,
          deliveryStatus: "pending",
          createdAtMs: command.nowMs,
          deliveredAtMs: null,
          deduplicationKey:
            notificationContract.deduplicationKey,
        });
        outboxWriter.write({
          id: notificationOutboxEventId,
          leagueId: command.leagueId,
          eventType: "notification.created",
          aggregateType: "notification",
          aggregateId: notificationId,
          payload: createSocketEventMetadata({
            eventType: "notification.created",
            version: 1,
            reasonCode: "allocation_changed",
            occurredAtMs: command.nowMs,
            related: createEmptySocketRelated({
              fadId: command.fadId,
              teamId:
                origin.participant.teamId,
              cardId: origin.row.card_id,
              allocationId:
                command.allocationId,
              auctionId,
            }),
          }),
          occurredAtMs: command.nowMs,
          audiences: [
            {
              kind: "user",
              userId:
                notificationContract.recipientUserId,
            },
          ],
        });
      }
      participants.push(
        Object.freeze({
          participantId,
          teamId:
            origin.participant.teamId,
          sourceSnapshotEntryId:
            origin.participant
              .sourceSnapshotEntryId,
          originatingCandidateRevisionId:
            origin.revision.id,
          notificationId,
        })
      );
    }
    insertDrawStatement.run({
      ...command,
      drawId,
      auctionId,
      nonceBytes: nonce,
      commitmentHex:
        commitment.commitmentHex,
      openedAtMs: window.openedAtMs,
    });
    if (delayedActivation) {
      insertActivationJobStatement.run({
        ...command,
        activationJobRunId,
        activationOccurrenceKey,
        activationAtMs:
          window.activationAtMs,
      });
    }

    return deepFreeze({
      status: restrictedStatus,
      decisionCode:
        "exact_total_and_term_tie",
      allocationVersion:
        command.expectedAllocationVersion +
        1,
      accountedAtMs: null,
      winner: null,
      restrictedAuction: {
        auctionId,
        rolloverId: window.rollover.id,
        activationJobRunId,
        activationOccurrenceKey,
        activationAtMs:
          window.activationAtMs,
        openedAtMs: window.openedAtMs,
        resolvesAtMs:
          window.rollover
            .rolls_over_at_ms,
        activationMode: window.mode,
        floor,
        participants,
        drawId,
        drawAlgorithmVersion:
          commitment.algorithmVersion,
        drawCommitmentHex:
          commitment.commitmentHex,
      },
    });
  }

  function persistNoValidOffer({
    command,
  }) {
    requireChanged(
      updateNoValidOfferStatement.run(
        command
      ),
      "The Candidate allocation changed before its no-valid-offer result committed."
    );
    return deepFreeze({
      status: "no_valid_offer",
      decisionCode: "no_valid_offer",
      allocationVersion:
        command.expectedAllocationVersion +
        1,
      accountedAtMs: command.nowMs,
      winner: null,
      restrictedAuction: null,
    });
  }

  function activityProjection(
    command,
    context,
    outcome
  ) {
    if (
      outcome.status ===
      "automatic_award"
    ) {
      return Object.freeze({
        eventType:
          "free_agent_draft_player_awarded",
        teamId: outcome.winner.teamId,
        displaySummary:
          `${context.player_full_name} signed through Candidate allocation.`,
      });
    }
    if (
      [
        "restricted_scheduled",
        "restricted_active",
      ].includes(outcome.status)
    ) {
      return Object.freeze({
        eventType:
          "free_agent_draft_restricted_created",
        teamId: null,
        displaySummary:
          `${context.player_full_name} entered a restricted Candidate auction.`,
      });
    }
    return Object.freeze({
      eventType:
        "free_agent_draft_player_invalid",
      teamId: null,
      displaySummary:
        `${context.player_full_name} had no valid Candidate offer.`,
    });
  }

  function writeEvidenceAndSideEffects({
    command,
    context,
    allocationData,
    outcome,
    id,
  }) {
    const activityId = id(
      "Candidate allocation activity"
    );
    const outboxEventId = id(
      "Candidate allocation outbox event"
    );
    const activity =
      activityProjection(
        command,
        context,
        outcome
      );
    const activityContract =
      createFreeAgentDraftActivityContract({
        eventType: activity.eventType,
        metadata: {
          schemaVersion: 1,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          fadId: command.fadId,
          allocationId:
            command.allocationId,
          playerId: command.playerId,
          status: outcome.status,
          decisionCode:
            outcome.decisionCode,
          winningTeamId:
            outcome.winner?.teamId || null,
          contractId:
            outcome.winner?.contractId ||
            null,
          ownershipId:
            outcome.winner?.ownershipId ||
            null,
          restrictedAuctionId:
            outcome.restrictedAuction
              ?.auctionId || null,
          generalIllegal:
            outcome.winner?.legality
              .generalIllegal ?? false,
        },
      });
    insertActivityStatement.run({
      ...command,
      activityId,
      eventType: activityContract.eventType,
      teamId: activity.teamId,
      displaySummary:
        activity.displaySummary,
      metadataJson: canonicalJson(
        activityContract.metadata
      ),
    });
    const related = createEmptySocketRelated({
      fadId: command.fadId,
      teamId:
        outcome.winner?.teamId || null,
      cardId:
        outcome.winner === null
          ? null
          : allocationData.rowsById.get(
                outcome.winner.snapshotEntryId
              )?.card_id || null,
      allocationId: command.allocationId,
      auctionId:
        outcome.restrictedAuction?.auctionId || null,
    });
    const publicationIds = allocationPublicationIds(
      outboxEventId,
      activityId,
      outcome.status === "restricted_active"
        ? outcome.restrictedAuction.auctionId
        : null
    );
    outboxWriter.write({
      id: outboxEventId,
      leagueId: command.leagueId,
      eventType:
        "free_agent_draft.changed",
      aggregateType:
        "free_agent_draft",
      aggregateId: command.fadId,
      payload: createSocketEventMetadata({
        eventType:
          "free_agent_draft.changed",
        version: context.fad_version,
        reasonCode: "allocation_changed",
        occurredAtMs: command.nowMs,
        related,
      }),
      occurredAtMs: command.nowMs,
    });
    outboxWriter.write({
      id: publicationIds.activity,
      leagueId: command.leagueId,
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: activityId,
      payload: createSocketEventMetadata({
        eventType: "activity.created",
        version: 1,
        reasonCode: "allocation_changed",
        occurredAtMs: command.nowMs,
        related,
      }),
      occurredAtMs: command.nowMs,
    });
    if (publicationIds.auction !== null) {
      outboxWriter.write({
        id: publicationIds.auction,
        leagueId: command.leagueId,
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId:
          outcome.restrictedAuction.auctionId,
        payload: createSocketEventMetadata({
          eventType: "auction.changed",
          version: 1,
          reasonCode: "auction_changed",
          occurredAtMs: command.nowMs,
          related,
        }),
        occurredAtMs: command.nowMs,
      });
    }

    const offerEvidence =
      expectedOfferEvidence(
        allocationData
      );
    const offerEventIds = [];
    for (const evidence of offerEvidence) {
      const eventId = id(
        "Candidate offer-considered event"
      );
      offerEventIds.push(eventId);
      insertAllocationEventStatement.run({
        ...command,
        eventId,
        allocationVersion:
          outcome.allocationVersion,
        eventKind: "offer_considered",
        snapshotEntryId:
          evidence.offer.offerId,
        teamId: evidence.offer.teamId,
        offerValid:
          evidence.offerValid ? 1 : 0,
        rankPosition:
          evidence.rankPosition,
        offerOutcomeCode:
          evidence.outcomeCode,
        decisionCode: null,
        resultingAllocationStatus:
          outcome.status,
        contractId: null,
        ownershipId: null,
        auctionId: null,
        activityId: null,
        evidenceJson: offerEvidenceJson(
          command,
          evidence
        ),
      });
    }
    const decisionEventId = id(
      "Candidate allocation decision event"
    );
    insertAllocationEventStatement.run({
      ...command,
      eventId: decisionEventId,
      allocationVersion:
        outcome.allocationVersion,
      eventKind:
        [
          "restricted_scheduled",
          "restricted_active",
        ].includes(outcome.status)
          ? "restricted_state_changed"
          : "decision_recorded",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode:
        outcome.decisionCode,
      resultingAllocationStatus:
        outcome.status,
      contractId:
        outcome.winner?.contractId ||
        null,
      ownershipId:
        outcome.winner?.ownershipId ||
        null,
      auctionId:
        outcome.restrictedAuction
          ?.auctionId || null,
      activityId,
      evidenceJson: canonicalJson({
        schemaVersion: 1,
        occurrenceKey:
          command.occurrenceKey,
        allocationId:
          command.allocationId,
        playerId: command.playerId,
        decision:
          allocationData.decision,
        result: {
          status: outcome.status,
          decisionCode:
            outcome.decisionCode,
          winner: outcome.winner,
          restrictedAuction:
            outcome.restrictedAuction,
        },
        sideEffects: {
          activityId,
          fadVersion: context.fad_version,
          outboxEventId,
        },
      }),
    });
    return deepFreeze({
      offerEventIds,
      decisionEventId,
      activityId,
      outboxEventId,
    });
  }

  function responseProjection({
    command,
    outcome,
    evidence,
  }) {
    return deepFreeze({
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      fadId: command.fadId,
      allocationId:
        command.allocationId,
      playerId: command.playerId,
      occurrenceKey:
        command.occurrenceKey,
      status: outcome.status,
      decisionCode:
        outcome.decisionCode,
      allocationVersion:
        outcome.allocationVersion,
      accountedAtMs:
        outcome.accountedAtMs,
      winner: outcome.winner,
      restrictedAuction:
        outcome.restrictedAuction,
      evidence,
      jobRunId: command.jobRunId,
      jobRunVersion:
        command.expectedJobVersion + 1,
    });
  }

  function storedJobResult(
    command,
    response
  ) {
    return canonicalJson({
      schemaVersion: 1,
      operation:
        "free_agent_draft_candidate_allocation",
      identity: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        allocationId:
          command.allocationId,
        playerId: command.playerId,
        occurrenceKey:
          command.occurrenceKey,
        jobRunId: command.jobRunId,
      },
      request: {
        expectedAllocationVersion:
          command.expectedAllocationVersion,
        expectedJobVersion:
          command.expectedJobVersion,
      },
      response,
    });
  }

  function validateStoredJobResult(
    command,
    job
  ) {
    if (
      job.status !== "succeeded" ||
      typeof job.result_json !== "string"
    ) {
      return null;
    }
    const stored = parseCanonicalJson(
      job.result_json,
      "Candidate allocation job result"
    );
    exactObject(
      stored,
      [
        "schemaVersion",
        "operation",
        "identity",
        "request",
        "response",
      ],
      "stored Candidate allocation result"
    );
    exactObject(
      stored.identity,
      [
        "leagueId",
        "seasonId",
        "fadId",
        "allocationId",
        "playerId",
        "occurrenceKey",
        "jobRunId",
      ],
      "stored Candidate allocation identity"
    );
    exactObject(
      stored.request,
      [
        "expectedAllocationVersion",
        "expectedJobVersion",
      ],
      "stored Candidate allocation request"
    );
    if (
      stored.schemaVersion !== 1 ||
      stored.operation !==
        "free_agent_draft_candidate_allocation" ||
      stored.identity.leagueId !==
        command.leagueId ||
      stored.identity.seasonId !==
        command.seasonId ||
      stored.identity.fadId !==
        command.fadId ||
      stored.identity.allocationId !==
        command.allocationId ||
      stored.identity.playerId !==
        command.playerId ||
      stored.identity.occurrenceKey !==
        command.occurrenceKey ||
      stored.identity.jobRunId !==
        command.jobRunId ||
      stored.request
          .expectedAllocationVersion !==
        command.expectedAllocationVersion ||
      stored.request.expectedJobVersion !==
        command.expectedJobVersion
    ) {
      conflict(
        "The Candidate allocation replay identity conflicts with its stored occurrence."
      );
    }
    return stored.response;
  }

  function validateReplayEvidence(
    command,
    response,
    allocationData,
    context
  ) {
    if (
      !isPlainObject(response) ||
      response.leagueId !==
        command.leagueId ||
      response.seasonId !==
        command.seasonId ||
      response.fadId !== command.fadId ||
      response.allocationId !==
        command.allocationId ||
      response.playerId !==
        command.playerId ||
      response.occurrenceKey !==
        command.occurrenceKey ||
      response.jobRunId !==
        command.jobRunId ||
      !isPlainObject(response.evidence) ||
      !Array.isArray(
        response.evidence.offerEventIds
      ) ||
      !UUID_PATTERN.test(
        response.evidence
          .decisionEventId || ""
      ) ||
      !UUID_PATTERN.test(
        response.evidence.activityId ||
          ""
      ) ||
      !UUID_PATTERN.test(
        response.evidence
          .outboxEventId || ""
      )
    ) {
      incompatible(
        "The persisted Candidate allocation replay response is invalid."
      );
    }
    const events =
      allocationEventsStatement.all(
        command
      );
    const originalEvents = events.filter(
      (event) =>
        event.allocation_version ===
        response.allocationVersion
    );
    const offerIds = new Set(
      originalEvents
        .filter(
          (event) =>
            event.event_kind ===
            "offer_considered"
        )
        .map((event) => event.id)
    );
    if (
      offerIds.size !==
        response.evidence.offerEventIds
          .length ||
      response.evidence.offerEventIds.some(
        (eventId) =>
          !offerIds.has(eventId)
      ) ||
      !originalEvents.some(
        (event) =>
          event.id ===
            response.evidence
              .decisionEventId &&
          event.decision_code ===
            response.decisionCode &&
          event.resulting_allocation_status ===
            response.status
      ) ||
      !uniqueRow(
        replayActivityStatement,
        {
          ...command,
          activityId:
            response.evidence.activityId,
        },
        "Candidate allocation replay activity"
      ) ||
      !uniqueRow(
        replayOutboxStatement,
        {
          ...command,
          outboxEventId:
            response.evidence
              .outboxEventId,
        },
        "Candidate allocation replay outbox"
      )
    ) {
      incompatible(
        "The persisted Candidate allocation replay evidence is incomplete."
      );
    }

    const related = createEmptySocketRelated({
      fadId: command.fadId,
      teamId: response.winner?.teamId || null,
      cardId:
        response.winner === null
          ? null
          : allocationData.rowsById.get(
                response.winner.snapshotEntryId
              )?.card_id || null,
      allocationId: command.allocationId,
      auctionId:
        response.restrictedAuction?.auctionId || null,
    });
    const publicationIds = allocationPublicationIds(
      response.evidence.outboxEventId,
      response.evidence.activityId,
      response.status === "restricted_active"
        ? response.restrictedAuction.auctionId
        : null
    );
    const decisionEvent = originalEvents.find(
      (event) =>
        event.id ===
        response.evidence.decisionEventId
    );
    const decisionEvidence = parseCanonicalJson(
      decisionEvent.evidence_json,
      "Candidate allocation decision publication evidence"
    );
    exactObject(
      decisionEvidence.sideEffects,
      ["activityId", "fadVersion", "outboxEventId"],
      "Candidate allocation decision side effects"
    );
    if (
      decisionEvidence.sideEffects.activityId !==
        response.evidence.activityId ||
      decisionEvidence.sideEffects.outboxEventId !==
        response.evidence.outboxEventId ||
      !Number.isSafeInteger(
        decisionEvidence.sideEffects.fadVersion
      ) ||
      decisionEvidence.sideEffects.fadVersion < 1
    ) {
      incompatible(
        "The persisted Candidate allocation publication version evidence is invalid."
      );
    }
    requirePublication({
      aggregateId: command.fadId,
      aggregateType: "free_agent_draft",
      audienceKind: "league",
      eventId: response.evidence.outboxEventId,
      eventType: "free_agent_draft.changed",
      leagueId: command.leagueId,
      occurredAtMs: context.allocation_updated_at_ms,
      reasonCode: "allocation_changed",
      related,
      version:
        decisionEvidence.sideEffects.fadVersion,
    });
    requirePublication({
      aggregateId: response.evidence.activityId,
      aggregateType: "league_activity",
      audienceKind: "league",
      eventId: publicationIds.activity,
      eventType: "activity.created",
      leagueId: command.leagueId,
      occurredAtMs: context.allocation_updated_at_ms,
      reasonCode: "allocation_changed",
      related,
      version: 1,
    });
    if (publicationIds.auction !== null) {
      requirePublication({
        aggregateId: response.restrictedAuction.auctionId,
        aggregateType: "auction",
        audienceKind: "league",
        eventId: publicationIds.auction,
        eventType: "auction.changed",
        leagueId: command.leagueId,
        occurredAtMs: context.allocation_updated_at_ms,
        reasonCode: "auction_changed",
        related,
        version: 1,
      });
    }

    const decision =
      allocationData.decision;
    if (
      decision.decisionCode !==
        response.decisionCode ||
      (
        decision.outcome ===
          "automatic_award" &&
        response.status !==
          "automatic_award"
      ) ||
      (
        decision.outcome ===
          "restricted_auction" &&
        ![
          "restricted_scheduled",
          "restricted_active",
        ].includes(response.status)
      ) ||
      (
        decision.outcome ===
          "no_valid_offer" &&
        response.status !==
          "no_valid_offer"
      )
    ) {
      incompatible(
        "The stored Candidate allocation result no longer matches its immutable snapshot."
      );
    }

    if (
      response.status ===
      "automatic_award"
    ) {
      const contract = uniqueRow(
        replayContractStatement,
        {
          ...command,
          contractId:
            response.winner?.contractId,
        },
        "Candidate allocation replay contract"
      );
      const ownership = uniqueRow(
        replayOwnershipStatement,
        {
          ...command,
          ownershipId:
            response.winner?.ownershipId,
        },
        "Candidate allocation replay ownership"
      );
      if (
        !contract ||
        !ownership ||
        contract.player_id !==
          command.playerId ||
        contract.original_total_value_cents !==
          response.winner
            .totalValueCents ||
        contract.original_term_years !==
          response.winner.termYears ||
        ownership.player_id !==
          command.playerId
      ) {
        incompatible(
          "The persisted Candidate automatic-award resources are incomplete."
        );
      }
    } else if (
      [
        "restricted_scheduled",
        "restricted_active",
      ].includes(response.status)
    ) {
      const restricted =
        response.restrictedAuction;
      const auction = uniqueRow(
        replayAuctionStatement,
        {
          ...command,
          auctionId:
            restricted?.auctionId,
        },
        "restricted Candidate replay auction"
      );
      const participants =
        replayParticipantsStatement.all({
          ...command,
          auctionId:
            restricted?.auctionId,
        });
      const draw = uniqueRow(
        replayDrawStatement,
        {
          ...command,
          auctionId:
            restricted?.auctionId,
        },
        "restricted Candidate replay draw"
      );
      const delayedActivation =
        response.status ===
        "restricted_scheduled";
      const activationJob =
        delayedActivation
          ? uniqueRow(
              replayActivationJobStatement,
              {
                ...command,
                activationJobRunId:
                  restricted
                    ?.activationJobRunId,
                activationOccurrenceKey:
                  restricted
                    ?.activationOccurrenceKey,
                activationAtMs:
                  restricted?.activationAtMs,
              },
              "restricted Candidate activation job"
            )
          : null;
      let commitment = null;
      if (draw) {
        try {
          commitment =
            createFreeAgentDraftAuctionDrawCommitment({
              auctionId:
                restricted.auctionId,
              nonceBytes:
                draw.nonce_bytes,
            }).commitmentHex;
        } catch {
          commitment = null;
        }
      }
      const expectedTeams =
        decision.restrictedTie.participants
          .map(
            (participant) =>
              participant.teamId
          )
          .sort();
      const expectedByTeam = new Map(
        decision.restrictedTie.participants.map(
          (participant) => [
            participant.teamId,
            participant,
          ]
        )
      );
      if (
        !auction ||
        auction.source_kind !==
          "fad_restricted" ||
        auction.fad_allocation_id !==
          command.allocationId ||
        auction.opened_at_ms !==
          restricted?.openedAtMs ||
        auction.resolves_at_ms !==
          restricted?.resolvesAtMs ||
        !draw ||
        draw.id !== restricted.drawId ||
        draw.commitment_hex !==
          restricted
            .drawCommitmentHex ||
        commitment !==
          draw.commitment_hex ||
        (
          delayedActivation &&
          (
            restricted?.activationMode !==
              "rollover_scheduled" ||
            !UUID_PATTERN.test(
              restricted
                ?.activationJobRunId || ""
            ) ||
            typeof restricted
              ?.activationOccurrenceKey !==
              "string" ||
            !activationJob
          )
        ) ||
        (
          !delayedActivation &&
          (
            restricted?.activationMode !==
              "immediate" ||
            restricted
              ?.activationJobRunId !==
              null ||
            restricted
              ?.activationOccurrenceKey !==
              null ||
            restricted?.activationAtMs !==
              restricted?.openedAtMs
          )
        ) ||
        participants.length !==
          expectedTeams.length ||
        participants.some(
          (participant, index) =>
            participant.team_id !==
              expectedTeams[index] ||
            participant
              .source_snapshot_entry_id !==
              expectedByTeam.get(
                participant.team_id
              )?.sourceSnapshotEntryId ||
            participant
              .minimum_total_value_cents !==
              decision.restrictedTie
                .floor.totalValueCents ||
            participant
              .minimum_term_years !==
              decision.restrictedTie
                .floor.termYears ||
            participant
              .minimum_aav_cents !==
              decision.restrictedTie
                .floor.aavCents
        )
      ) {
        incompatible(
          "The persisted restricted Candidate resources are incomplete."
        );
      }
    }
  }

  const resolveTransaction =
    database.transaction((rawCommand) => {
      const normalized =
        normalizeCommand(rawCommand);
      const occurrenceKey =
        buildFreeAgentDraftAllocationOccurrenceKey({
          fadId: normalized.fadId,
          playerId: normalized.playerId,
        });
      const command = Object.freeze({
        ...normalized,
        occurrenceKey,
      });
      const context = readContext(command);
      if (!context) {
        notFound(
          "The scoped Candidate allocation was not found."
        );
      }
      const job = uniqueRow(
        allocationJobStatement,
        command,
        "Candidate allocation job occurrence"
      );
      const correctionReplay =
        validateCorrectionReplay(
          command,
          context,
          job
        );
      if (correctionReplay) {
        return correctionReplay;
      }
      const replay =
        job &&
        validateStoredJobResult(
          command,
          job
        );
      if (replay) {
        const allocationData =
          readOffers(command);
        validateReplayEvidence(
          command,
          replay,
          allocationData,
          context
        );
        return deepFreeze({
          ...replay,
          replayed: true,
        });
      }

      requireActiveOperation(
        command,
        context,
        job
      );
      const allocationData =
        readOffers(command);
      let issue = null;
      let destination = null;
      if (
        allocationData.decision.outcome !==
        "no_valid_offer"
      ) {
        issue = availabilityIssue(command);
      }
      if (
        !issue &&
        allocationData.decision.outcome ===
          "automatic_award"
      ) {
        const winnerRow =
          allocationData.rowsById.get(
            allocationData.decision.winner
              .offerId
          );
        if (!winnerRow) {
          incompatible(
            "The deterministic Candidate winner is absent from its snapshot."
          );
        }
        const destinationInspection =
          inspectRequestedDestination(
            command,
            winnerRow
          );
        issue = destinationInspection.issue;
        destination =
          destinationInspection.destination;
      }
      const id = newIdentityFactory();
      if (issue) {
        const response =
          persistCorrectionRequired({
            command,
            context,
            issue,
            allocationData,
            id,
          });
        if (beforeCommit) {
          assertSynchronous(
            beforeCommit(
              "resolvePending",
              response
            ),
            "Candidate allocation beforeCommit"
          );
        }
        return response;
      }
      let outcome;
      if (
        allocationData.decision.outcome ===
        "automatic_award"
      ) {
        outcome = persistAutomaticAward({
          command,
          context,
          allocationData,
          destination,
          id,
        });
      } else if (
        allocationData.decision.outcome ===
        "restricted_auction"
      ) {
        outcome = persistRestrictedTie({
          command,
          allocationData,
          id,
        });
      } else if (
        allocationData.decision.outcome ===
        "no_valid_offer"
      ) {
        outcome = persistNoValidOffer({
          command,
        });
      } else {
        incompatible(
          "The Candidate allocation policy returned an unsupported outcome."
        );
      }
      const evidence =
        writeEvidenceAndSideEffects({
          command,
          context,
          allocationData,
          outcome,
          id,
        });
      const response = responseProjection({
        command,
        outcome,
        evidence,
      });
      requireChanged(
        succeedAllocationJobStatement.run({
          ...command,
          resultJson: storedJobResult(
            command,
            response
          ),
        }),
        "The Candidate allocation lease changed before its result committed."
      );
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            "resolvePending",
            response
          ),
          "Candidate allocation beforeCommit"
        );
      }
      return deepFreeze({
        ...response,
        replayed: false,
      });
    });

  return Object.freeze({
    findAllocation(input) {
      const scope = normalizeScope(input);
      try {
        const row = readContext(scope);
        return row
          ? allocationRecord(row)
          : null;
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findCandidateAllocation",
          tableName:
            "free_agent_draft_player_allocations",
        });
      }
    },

    resolvePending(input) {
      try {
        return resolveTransaction.immediate(
          input
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "resolvePendingCandidateAllocation",
          tableName:
            "free_agent_draft_player_allocations",
        });
      }
    },
  });
}

module.exports = {
  ALLOCATION_JOB_TYPE,
  BUYOUT_LOCK_MS,
  CANDIDATE_ALLOCATION_REPOSITORY_METHODS,
  RESTRICTED_ACTIVATION_JOB_TYPE,
  createSqliteCandidateAllocationRepository,
};
