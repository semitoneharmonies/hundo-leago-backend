"use strict";

const { randomUUID } = require("node:crypto");

const {
  COOLDOWN_MS,
  calculateAavCents,
} = require("../../../domain/auctions/auctionBidPolicy");
const {
  AuctionAdministrationPolicyError,
  auctionAdministrationRequestProjection,
  getAuctionAdministrationActionPolicy,
  hashAuctionAdministrationRequest,
  validateAuctionAdministrationStoredResult,
} = require("../../../domain/auctions/auctionAdministrationPolicy");
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require("../../../domain/leagues/seasonRolloverEvidencePolicy");
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  FreeAgentDraftCorrectionPolicyError,
  projectFreeAgentDraftAllocationResultForPublic,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteAuctionReadRepository,
} = require("./SqliteAuctionReadRepository");
const {
  createSqliteFreeAgentDraftInternalReadRepository,
} = require("./SqliteFreeAgentDraftReadRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const JOB_TYPE = "auction.resolve.target";
const RESULT_TYPE = "auction_administration_command_result";
const RESTRICTED_CANCELLATION_ERROR_CODE =
  "RESTRICTED_AUCTION_CANCELLED";
const OPEN_RAPID_CANCELLATION_LEASE_MS = 60_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const AUCTION_ADMINISTRATION_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied:
      "AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED",
    auctionNotFound: "AUCTION_NOT_FOUND",
    fadIntegrationRequired:
      "AUCTION_ADMIN_FAD_INTEGRATION_REQUIRED",
    idempotencyConflict: "IDEMPOTENCY_KEY_REUSED",
    notDue: "AUCTION_ADMINISTRATION_NOT_DUE",
    preconditionFailed: "AUCTION_PRECONDITION_FAILED",
    stateConflict:
      "AUCTION_ADMINISTRATION_STATE_CONFLICT",
  });

class AuctionAdministrationRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuctionAdministrationRepositoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AuctionAdministrationRepositoryError(
    code,
    message
  );
}

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

function exactObject(value, fields) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact auction-administration repository input is required."
    );
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
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
    value > MAX_TIMESTAMP_MS
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe UTC timestamp is required."
    );
  }
  return value;
}

function idempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A bounded idempotency key is required."
    );
  }
  return value;
}

function commandIdentity(input) {
  const action = getAuctionAdministrationActionPolicy(
    input.action
  );
  const requestInput = {
    leagueId: input.leagueId,
    auctionId: input.auctionId,
    bidId: input.bidId,
    action: input.action,
    preconditionKind: action.preconditionKind,
    preconditionVersion: input.preconditionVersion,
    body: input.body,
  };
  return {
    request:
      auctionAdministrationRequestProjection(
        requestInput
      ),
    policy: action,
    requestSha256:
      hashAuctionAdministrationRequest(
        requestInput
      ),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(
      input.actorMembershipId
    ),
    idempotencyKey: idempotencyKey(
      input.idempotencyKey
    ),
  };
}

function validateReplayInput(input) {
  exactObject(input, [
    "action",
    "actorMembershipId",
    "actorUserId",
    "auctionId",
    "bidId",
    "body",
    "idempotencyKey",
    "leagueId",
    "preconditionVersion",
  ]);
  return freeze(commandIdentity(input));
}

function validateInput(input) {
  exactObject(input, [
    "action",
    "actorMembershipId",
    "actorUserId",
    "auctionId",
    "bidId",
    "body",
    "idempotencyExpiresAtMs",
    "idempotencyKey",
    "leagueId",
    "occurredAtMs",
    "preconditionVersion",
  ]);
  const identity = commandIdentity(input);
  const occurredAtMs = safeTimestamp(input.occurredAtMs);
  const idempotencyExpiresAtMs = safeTimestamp(
    input.idempotencyExpiresAtMs
  );
  if (idempotencyExpiresAtMs <= occurredAtMs) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Auction-administration idempotency must expire after creation."
    );
  }
  return freeze({
    ...identity,
    occurredAtMs,
    idempotencyExpiresAtMs,
  });
}

function allowedCapability() {
  return freeze({
    allowed: true,
    reasonCode: null,
  });
}

function blockedCapability(reasonCode) {
  return freeze({
    allowed: false,
    reasonCode,
  });
}

function publicAuctionStatus(status) {
  if (["open", "resolving"].includes(status)) {
    return "active";
  }
  if (status === "failed") {
    return "correction_required";
  }
  return status;
}

function publicBidStatus(status) {
  return status === "cancelled" ? "invalid" : status;
}

function teamProjection(row) {
  return freeze({
    teamId: row.team_id,
    name: row.team_name,
    logoReference: row.logo_reference,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate: row.pattern_template,
  });
}

function findViewerBid(rows, teamId) {
  return (
    rows.find(
      (row) =>
        row.team_id === teamId &&
        row.bid_status === "active"
    ) ||
    rows.find((row) => row.team_id === teamId) ||
    null
  );
}

function viewerBidProjection(row, auction) {
  const editLimit =
    row.first_submitted_at_ms === auction.opened_at_ms
      ? 2
      : 1;
  return freeze({
    bidId: row.bid_id,
    version: row.bid_version,
    status: publicBidStatus(row.bid_status),
    totalValueCents: row.total_value_cents,
    termYears: row.term_years,
    aavCents: calculateAavCents(
      row.total_value_cents,
      row.term_years
    ),
    editCount: row.edit_count,
    editLimit,
    cooldownEndsAtMs:
      row.last_edited_at_ms + COOLDOWN_MS,
  });
}

function viewerEditCapability(row, auction, nowMs) {
  if (auction.league_status === "frozen") {
    return blockedCapability("LEAGUE_FROZEN");
  }
  if (auction.league_status !== "active") {
    return blockedCapability("PHASE_CLOSED");
  }
  if (
    !row ||
    row.bid_status !== "active" ||
    auction.status !== "open" ||
    nowMs < auction.opened_at_ms ||
    nowMs >= auction.resolves_at_ms
  ) {
    return blockedCapability("PHASE_CLOSED");
  }
  const editLimit =
    row.first_submitted_at_ms === auction.opened_at_ms
      ? 2
      : 1;
  if (row.edit_count >= editLimit) {
    return blockedCapability("EDIT_LIMIT_REACHED");
  }
  if (
    nowMs <
    row.last_edited_at_ms + COOLDOWN_MS
  ) {
    return blockedCapability("COOLDOWN_ACTIVE");
  }
  return allowedCapability();
}

function administrativeBidProjection(
  row,
  auction,
  nowMs
) {
  const administrable =
    ["active", "frozen"].includes(
      auction.league_status
    ) &&
    auction.status === "open" &&
    nowMs >= auction.opened_at_ms &&
    nowMs < auction.resolves_at_ms &&
    row.bid_status === "active";
  const capability = administrable
    ? allowedCapability()
    : blockedCapability("PHASE_CLOSED");
  return freeze({
    bidId: row.bid_id,
    teamId: row.team_id,
    team: teamProjection(row),
    version: row.bid_version,
    status: publicBidStatus(row.bid_status),
    participantStatus: null,
    capabilities: freeze({
      adminEditBid: capability,
      adminRemoveBid: capability,
    }),
  });
}

function activeResult() {
  return null;
}

function cancelledResult({
  activityId,
  resolvedAtMs,
}) {
  return freeze({
    outcomeCode: "cancelled",
    winningTeam: null,
    submittedTotalValueCents: null,
    submittedTermYears: null,
    submittedAavCents: null,
    finalContractValueCents: null,
    finalAavCents: null,
    contractId: null,
    ownershipId: null,
    activityId,
    recoveryId: null,
    drawEvidence: null,
    resolvedAtMs,
  });
}

function storedResultRecord(row) {
  return validateAuctionAdministrationStoredResult({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    auctionId: row.auction_id,
    bidId: row.bid_id,
    idempotencyRequestId:
      row.idempotency_request_id,
    jobRunId: row.job_run_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    actorAuthority: row.actor_authority,
    requestSha256: row.request_sha256,
    preconditionKind: row.precondition_kind,
    expectedResourceVersion:
      row.expected_resource_version,
    resultingResourceVersion:
      row.resulting_resource_version,
    responseHttpStatus: row.response_http_status,
    responseJson: row.response_json,
    responseSha256: row.response_sha256,
    createdAtMs: row.created_at_ms,
    version: row.version,
  });
}

function publicStoredResultData(stored) {
  if (
    stored.action !== "cancel_auction" ||
    stored.data.fadAllocation === null ||
    stored.data.fadAllocation === undefined
  ) {
    return stored.data;
  }
  try {
    return deepFreeze({
      ...stored.data,
      fadAllocation:
        projectFreeAgentDraftAllocationResultForPublic(
          stored.data.fadAllocation
        ),
    });
  } catch (error) {
    if (
      error instanceof FreeAgentDraftCorrectionPolicyError
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The stored FAD auction cancellation allocation cannot be safely projected."
      );
    }
    throw error;
  }
}

function safeResult(row, replayed) {
  const stored = storedResultRecord(row);
  return deepFreeze({
    replayed,
    action: stored.action,
    actorAuthority: stored.actorAuthority,
    httpStatus: stored.responseHttpStatus,
    data: publicStoredResultData(stored),
    evidence: {
      resultId: stored.id,
      idempotencyRequestId:
        stored.idempotencyRequestId,
      jobRunId: stored.jobRunId,
      requestSha256: stored.requestSha256,
      responseSha256: stored.responseSha256,
      preconditionKind: stored.preconditionKind,
      expectedResourceVersion:
        stored.expectedResourceVersion,
      resultingResourceVersion:
        stored.resultingResourceVersion,
      createdAtMs: stored.createdAtMs,
      version: stored.version,
    },
  });
}

function createSqliteAuctionAdministrationRepository({
  database,
  createId = randomUUID,
  beforeCommit = () => {},
  leagueOutboxWriter,
  notificationWriter,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteAuctionAdministrationRepository requires an opened database"
    );
  }
  if (
    typeof createId !== "function" ||
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "auction-administration repository dependencies are invalid"
    );
  }

  let findAuthority;
  let findCurrentCommissionerRecipient;
  let findIdempotency;
  let findResult;
  let findRestrictedCancellationNotifications;
  let findNotificationOutboxes;
  let findActivity;
  let findLeaguePublicationOutboxes;
  let findFailedOpenRapidCorrectionOutboxes;
  let findAuction;
  let findBid;
  let findRestrictedParticipant;
  let listAuctionBids;
  let listManagedTeams;
  let findResolution;
  let findJob;
  let findRestrictedAllocation;
  let listRestrictedAllocationEvents;
  let listAuctionRecoveries;
  let findOpenRapidDraw;
  let listOpenRapidFailureEvents;
  let insertIdempotency;
  let updateBidEdit;
  let updateBidRemove;
  let updateRestrictedParticipantEdit;
  let updateRestrictedParticipantRemove;
  let updateAuctionCancel;
  let cancelActiveBids;
  let insertEvent;
  let insertActivity;
  let insertFadCorrectionActivity;
  let insertResolution;
  let insertRestrictedResolution;
  let insertJob;
  let retryJob;
  let insertFailedResolutionJob;
  let failPendingResolutionJob;
  let updateRestrictedAllocationCancel;
  let insertRestrictedAllocationEvent;
  let insertRestrictedRecovery;
  let retryFailedOpenRapidJob;
  let startOpenRapidRecovery;
  let updateFailedAuctionResolving;
  let revealOpenRapidNoSelectionDraw;
  let updateResolvingAuctionCancel;
  let resolveOpenRapidRecovery;
  let succeedOpenRapidJob;
  let insertResult;
  let completeIdempotency;
  let replayTransaction;
  let transaction;
  const auctionReadRepository =
    createSqliteAuctionReadRepository({ database });
  const freeAgentDraftInternalReadRepository =
    createSqliteFreeAgentDraftInternalReadRepository({
      database,
    });
  const outboxWriter = resolveSqliteLeagueOutboxWriter({
    database,
    leagueOutboxWriter,
  });
  const notificationsWriter =
    resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });

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

  function nextId() {
    return stableId(createId());
  }

  function currentCommissionerUserId(command) {
    const commissioner = unique(
      findCurrentCommissionerRecipient,
      {
        leagueId: command.request.leagueId,
        occurredAtMs: command.occurredAtMs,
      },
      "The current auction-recovery commissioner is not unique."
    );
    if (!commissioner) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction cancellation has no current active commissioner recipient."
      );
    }
    return commissioner.user_id;
  }

  function restrictedCancellationNotificationContract({
    leagueId,
    seasonId,
    fadId,
    allocationId,
    auctionId,
    recoveryId,
    playerId,
    occurredAtMs,
    recipientUserId,
  }) {
    return {
      contract: createFreeAgentDraftNotificationContract({
        type: "fad_correction_required",
        recipientUserId,
        messageData: {
          leagueId,
          seasonId,
          fadId,
          allocationId,
          auctionId,
          recoveryId,
          playerId,
          errorCode:
            RESTRICTED_CANCELLATION_ERROR_CODE,
          destination: {
            kind: "fad_recovery",
            leagueId,
            fadId,
            recoveryId,
          },
        },
      }),
      occurredAtMs,
    };
  }

  function validateRestrictedCancellationPublication(
    causality,
    {
      expectedNotificationId = null,
      expectedOutboxEventId = null,
      requireInitialState = false,
    } = {}
  ) {
    const notifications =
      findRestrictedCancellationNotifications.all({
        leagueId: causality.leagueId,
        fadId: causality.fadId,
        recoveryId: causality.recoveryId,
      });
    if (notifications.length !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction cancellation notification is not exact."
      );
    }
    const notification = notifications[0];
    let messageData = null;
    let contract = null;
    try {
      messageData = JSON.parse(
        notification.message_data_json
      );
      contract =
        restrictedCancellationNotificationContract({
          ...causality,
          recipientUserId: notification.user_id,
        }).contract;
    } catch {
      messageData = null;
      contract = null;
    }
    if (
      !contract ||
      (expectedNotificationId !== null &&
        notification.id !== expectedNotificationId) ||
      notification.league_id !== causality.leagueId ||
      notification.event_type !== contract.type ||
      notification.message_data_json !==
        JSON.stringify(contract.messageData) ||
      notification.related_feature !==
        "free_agent_draft" ||
      notification.related_record_id !== causality.fadId ||
      notification.created_at_ms !==
        causality.occurredAtMs ||
      notification.deduplication_key !==
        contract.deduplicationKey ||
      messageData.leagueId !== causality.leagueId ||
      messageData.seasonId !== causality.seasonId ||
      messageData.fadId !== causality.fadId ||
      messageData.allocationId !==
        causality.allocationId ||
      messageData.auctionId !== causality.auctionId ||
      messageData.recoveryId !== causality.recoveryId ||
      messageData.playerId !== causality.playerId ||
      messageData.errorCode !==
        RESTRICTED_CANCELLATION_ERROR_CODE ||
      (requireInitialState &&
        (notification.delivery_status !== "pending" ||
          notification.read_at_ms !== null ||
          notification.delivered_at_ms !== null ||
          notification.version !== 1))
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction cancellation notification evidence is invalid."
      );
    }

    const publications = findNotificationOutboxes.all({
      leagueId: causality.leagueId,
      notificationId: notification.id,
    });
    const publication = publications[0];
    const related = createEmptySocketRelated({
      fadId: causality.fadId,
      allocationId: causality.allocationId,
      auctionId: causality.auctionId,
      recoveryId: causality.recoveryId,
    });
    const expectedPayload = publication
      ? JSON.stringify(
          createSocketEventEnvelope({
            eventId: publication.id,
            type: "notification.created",
            leagueId: causality.leagueId,
            resourceId: notification.id,
            version: 1,
            reasonCode: "auction_changed",
            occurredAt: causality.occurredAtMs,
            related,
          })
        )
      : null;
    if (
      publications.length !== 1 ||
      !publication ||
      (expectedOutboxEventId !== null &&
        publication.id !== expectedOutboxEventId) ||
      publication.payload_json !== expectedPayload ||
      publication.created_at_ms !==
        causality.occurredAtMs ||
      publication.audience_kind !== "user" ||
      publication.audience_team_id !== null ||
      publication.audience_user_id !==
        notification.user_id ||
      (requireInitialState &&
        (publication.status !== "pending" ||
          publication.attempt_count !== 0 ||
          publication.published_at_ms !== null ||
          publication.last_error_code !== null ||
          publication.version !== 1))
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction cancellation notification publication is invalid."
      );
    }
    return freeze({
      notificationId: notification.id,
      outboxEventId: publication.id,
      recipientUserId: notification.user_id,
    });
  }

  function writeRestrictedCancellationPublication({
    command,
    auction,
    recoveryId,
    recipientUserId,
    notificationId,
    outboxEventId,
  }) {
    const causality = {
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      fadId: auction.fad_id,
      allocationId: auction.fad_allocation_id,
      auctionId: auction.auction_id,
      recoveryId,
      playerId: auction.player_id,
      occurredAtMs: command.occurredAtMs,
    };
    const { contract } =
      restrictedCancellationNotificationContract({
        ...causality,
        recipientUserId,
      });
    const written = notificationsWriter.insert({
      id: notificationId,
      userId: recipientUserId,
      leagueId: causality.leagueId,
      eventType: contract.type,
      messageDataJson: JSON.stringify(
        contract.messageData
      ),
      relatedFeature: "free_agent_draft",
      relatedRecordId: causality.fadId,
      deliveryStatus: "pending",
      createdAtMs: causality.occurredAtMs,
      deliveredAtMs: null,
      deduplicationKey: contract.deduplicationKey,
    });
    if (
      !written ||
      typeof written.then === "function" ||
      written.replayed !== false ||
      written.notification?.id !== notificationId
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The restricted auction cancellation notification write was not exact."
      );
    }
    outboxWriter.write({
      id: outboxEventId,
      leagueId: causality.leagueId,
      eventType: "notification.created",
      aggregateType: "notification",
      aggregateId: notificationId,
      payload: createSocketEventMetadata({
        eventType: "notification.created",
        version: 1,
        reasonCode: "auction_changed",
        occurredAtMs: causality.occurredAtMs,
        related: createEmptySocketRelated({
          fadId: causality.fadId,
          allocationId: causality.allocationId,
          auctionId: causality.auctionId,
          recoveryId: causality.recoveryId,
        }),
      }),
      occurredAtMs: causality.occurredAtMs,
      audiences: [
        {
          kind: "user",
          userId: recipientUserId,
        },
      ],
    });
    return validateRestrictedCancellationPublication(
      causality,
      {
        expectedNotificationId: notificationId,
        expectedOutboxEventId: outboxEventId,
        requireInitialState: true,
      }
    );
  }

  function failedOpenRapidCorrectionActivityContract(
    causality
  ) {
    return createFreeAgentDraftActivityContract({
      eventType: "free_agent_draft_corrected",
      metadata: {
        actorMembershipId:
          causality.actorMembershipId,
        auctionId: causality.auctionId,
        fadId: causality.fadId,
        fadVersion: causality.fadVersion,
        outcomeCode: "cancelled",
        recoveryId: causality.recoveryId,
        schemaVersion: 1,
      },
    });
  }

  function validateFailedOpenRapidCorrectionActivity(
    causality
  ) {
    const activity = unique(
      findActivity,
      {
        leagueId: causality.leagueId,
        activityId: causality.activityId,
      },
      "The failed open-rapid correction activity is not unique."
    );
    let contract = null;
    try {
      contract =
        failedOpenRapidCorrectionActivityContract(
          causality
        );
    } catch {
      contract = null;
    }
    if (
      !activity ||
      !contract ||
      activity.league_id !== causality.leagueId ||
      activity.season_id !== causality.seasonId ||
      activity.event_type !== contract.eventType ||
      activity.actor_user_id !==
        causality.actorUserId ||
      activity.actor_authority !==
        causality.actorAuthority ||
      activity.team_id !== null ||
      activity.player_id !== causality.playerId ||
      activity.related_type !== "auction" ||
      activity.related_id !== causality.auctionId ||
      activity.display_summary !==
        `${causality.playerFullName}'s failed Free Agent Draft auction was cancelled and recovered.` ||
      activity.reason !== null ||
      activity.metadata_json !==
        serializeCanonicalJsonV1(contract.metadata) ||
      activity.occurred_at_ms !==
        causality.occurredAtMs
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation correction activity is invalid."
      );
    }
    return activity;
  }

  function validateLeaguePublication(
    causality,
    expected,
    {
      expectedEventId = null,
      requireInitialState = false,
    } = {}
  ) {
    const publications =
      findLeaguePublicationOutboxes.all({
        leagueId: causality.leagueId,
        eventType: expected.eventType,
        aggregateType: expected.aggregateType,
        aggregateId: expected.aggregateId,
        occurredAtMs: causality.occurredAtMs,
        fadId: causality.fadId,
        auctionId: causality.auctionId,
        recoveryId: causality.recoveryId,
      });
    const publication = publications[0];
    const related = createEmptySocketRelated({
      fadId: causality.fadId,
      auctionId: causality.auctionId,
      recoveryId: causality.recoveryId,
    });
    const expectedPayload = publication
      ? JSON.stringify(
          createSocketEventEnvelope({
            eventId: publication.id,
            type: expected.eventType,
            leagueId: causality.leagueId,
            resourceId: expected.aggregateId,
            version: expected.version,
            reasonCode: expected.reasonCode,
            occurredAt: causality.occurredAtMs,
            related,
          })
        )
      : null;
    if (
      publications.length !== 1 ||
      !publication ||
      (expectedEventId !== null &&
        publication.id !== expectedEventId) ||
      publication.payload_json !== expectedPayload ||
      publication.created_at_ms !==
        causality.occurredAtMs ||
      publication.audience_kind !== "league" ||
      publication.audience_team_id !== null ||
      publication.audience_user_id !== null ||
      (requireInitialState &&
        (publication.status !== "pending" ||
          publication.attempt_count !== 0 ||
          publication.available_at_ms !==
            causality.occurredAtMs ||
          publication.published_at_ms !== null ||
          publication.last_error_code !== null ||
          publication.updated_at_ms !==
            causality.occurredAtMs ||
          publication.version !== 1))
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation publication is invalid."
      );
    }
    return publication;
  }

  function failedOpenRapidPublicationExpectations(
    causality
  ) {
    return [
      {
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: causality.fadId,
        version: causality.fadVersion,
        reasonCode: "correction_applied",
      },
      {
        eventType: "activity.created",
        aggregateType: "league_activity",
        aggregateId: causality.activityId,
        version: 1,
        reasonCode: "correction_applied",
      },
      {
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: causality.auctionId,
        version: causality.auctionVersion,
        reasonCode: "auction_changed",
      },
    ];
  }

  function validateFailedOpenRapidPublications(
    causality,
    {
      expectedEventIds = null,
      requireInitialState = false,
    } = {}
  ) {
    const expectations =
      failedOpenRapidPublicationExpectations(causality);
    if (
      expectedEventIds !== null &&
      expectedEventIds.length !== expectations.length
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation publication identity set is incomplete."
      );
    }
    const publications = expectations.map(
      (expected, index) =>
        validateLeaguePublication(
          causality,
          expected,
          {
            expectedEventId:
              expectedEventIds?.[index] ?? null,
            requireInitialState,
          }
        )
    );
    const exactRows =
      findFailedOpenRapidCorrectionOutboxes.all({
        leagueId: causality.leagueId,
        occurredAtMs: causality.occurredAtMs,
        fadId: causality.fadId,
        fadVersion: causality.fadVersion,
        auctionId: causality.auctionId,
        auctionVersion: causality.auctionVersion,
        activityId: causality.activityId,
        recoveryId: causality.recoveryId,
      });
    const expectedIds = new Set(
      publications.map((publication) => publication.id)
    );
    if (
      exactRows.length !== expectations.length ||
      exactRows.some(
        (publication) =>
          !expectedIds.has(publication.id) ||
          publication.audience_kind !== "league" ||
          publication.audience_team_id !== null ||
          publication.audience_user_id !== null
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation publication set is not exact."
      );
    }
    return freeze(publications);
  }

  function writeFailedOpenRapidCorrectionEvidence({
    causality,
    outboxEventIds,
  }) {
    const activityContract =
      failedOpenRapidCorrectionActivityContract(
        causality
      );
    insertFadCorrectionActivity.run({
      activityId: causality.activityId,
      leagueId: causality.leagueId,
      seasonId: causality.seasonId,
      eventType: activityContract.eventType,
      actorUserId: causality.actorUserId,
      actorAuthority: causality.actorAuthority,
      playerId: causality.playerId,
      auctionId: causality.auctionId,
      displaySummary:
        `${causality.playerFullName}'s failed Free Agent Draft auction was cancelled and recovered.`,
      metadataJson: serializeCanonicalJsonV1(
        activityContract.metadata
      ),
      occurredAtMs: causality.occurredAtMs,
    });
    const expectations =
      failedOpenRapidPublicationExpectations(causality);
    for (let index = 0; index < expectations.length; index += 1) {
      const expected = expectations[index];
      outboxWriter.write({
        id: outboxEventIds[index],
        leagueId: causality.leagueId,
        eventType: expected.eventType,
        aggregateType: expected.aggregateType,
        aggregateId: expected.aggregateId,
        payload: createSocketEventMetadata({
          eventType: expected.eventType,
          version: expected.version,
          reasonCode: expected.reasonCode,
          occurredAtMs: causality.occurredAtMs,
          related: createEmptySocketRelated({
            fadId: causality.fadId,
            auctionId: causality.auctionId,
            recoveryId: causality.recoveryId,
          }),
        }),
        occurredAtMs: causality.occurredAtMs,
        audiences: [{ kind: "league" }],
      });
    }
    validateFailedOpenRapidCorrectionActivity(
      causality
    );
    validateFailedOpenRapidPublications(causality, {
      expectedEventIds: outboxEventIds,
      requireInitialState: true,
    });
  }

  function validateCancellationReplay(row) {
    const stored = storedResultRecord(row);
    if (stored.action !== "cancel_auction") {
      return;
    }
    if (
      stored.data.auction?.sourceKind ===
      "fad_restricted"
    ) {
      const causality = {
        leagueId: stored.leagueId,
        seasonId: stored.seasonId,
        fadId: stored.data.auction.fadId,
        allocationId:
          stored.data.fadAllocation?.allocationId,
        auctionId: stored.auctionId,
        recoveryId: stored.data.recoveryId,
        playerId:
          stored.data.auction.player?.playerId,
        occurredAtMs: stored.createdAtMs,
      };
      if (
        causality.allocationId === undefined ||
        causality.playerId === undefined
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The restricted auction cancellation result has incomplete publication causality."
        );
      }
      validateRestrictedCancellationPublication(
        causality
      );
      return;
    }
    if (
      stored.data.auction?.sourceKind !==
      "fad_open_rapid"
    ) {
      return;
    }
    const activityId =
      stored.data.auction.result?.activityId;
    const activity = unique(
      findActivity,
      {
        leagueId: stored.leagueId,
        activityId,
      },
      "The failed open-rapid correction activity is not unique."
    );
    let activityMetadata = null;
    try {
      activityMetadata = JSON.parse(
        activity?.metadata_json
      );
    } catch {
      activityMetadata = null;
    }
    const causality = {
      leagueId: stored.leagueId,
      seasonId: stored.seasonId,
      fadId: stored.data.auction.fadId,
      fadVersion: activityMetadata?.fadVersion,
      auctionId: stored.auctionId,
      auctionVersion:
        stored.resultingResourceVersion,
      recoveryId: stored.data.recoveryId,
      activityId,
      playerId:
        stored.data.auction.player?.playerId,
      playerFullName:
        stored.data.auction.player?.fullName,
      actorUserId: stored.actorUserId,
      actorMembershipId:
        stored.actorMembershipId,
      actorAuthority: stored.actorAuthority,
      occurredAtMs: stored.createdAtMs,
    };
    if (
      !Number.isSafeInteger(causality.fadVersion) ||
      causality.fadVersion < 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation result has incomplete FAD version evidence."
      );
    }
    validateFailedOpenRapidCorrectionActivity(
      causality
    );
    validateFailedOpenRapidPublications(causality);
  }

  function requireAuthority(command) {
    const row = unique(
      findAuthority,
      {
        leagueId: command.request.leagueId,
        actorUserId: command.actorUserId,
        actorMembershipId:
          command.actorMembershipId,
      },
      "Auction-administration authority is not unique."
    );
    if (
      !row ||
      !["active", "frozen"].includes(
        row.league_status
      ) ||
      row.user_status !== "active" ||
      row.membership_status !== "active"
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .authorizationDenied,
        "Current auction-administration authority is required."
      );
    }
    if (
      row.commissioner_membership_id ===
        command.actorMembershipId &&
      row.membership_permission === "commissioner"
    ) {
      return "commissioner";
    }
    if (row.is_platform_administrator === 1) {
      return "platform_administrator_as_commissioner";
    }
    fail(
      AUCTION_ADMINISTRATION_REPOSITORY_CODES
        .authorizationDenied,
      "Current auction-administration authority is required."
    );
  }

  function replay(command) {
    const idempotency = unique(
      findIdempotency,
      {
        leagueId: command.request.leagueId,
        actorUserId: command.actorUserId,
        operation: command.policy.operation,
        idempotencyKey: command.idempotencyKey,
      },
      "Auction-administration idempotency scope is not unique."
    );
    if (!idempotency) {
      return null;
    }
    if (
      idempotency.request_hash !==
        command.requestSha256 ||
      idempotency.status !== "completed" ||
      idempotency.result_type !== RESULT_TYPE ||
      !idempotency.result_id
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .idempotencyConflict,
        "The idempotency key was already used with different input."
      );
    }
    const row = unique(
      findResult,
      {
        leagueId: command.request.leagueId,
        resultId: idempotency.result_id,
      },
      "Auction-administration result identity is not unique."
    );
    if (
      !row ||
      row.idempotency_request_id !== idempotency.id ||
      row.actor_user_id !== command.actorUserId ||
      row.action !== command.request.action ||
      row.request_sha256 !== command.requestSha256
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The completed auction-administration request has no exact immutable result."
      );
    }
    validateCancellationReplay(row);
    return safeResult(row, true);
  }

  function loadAuction(command) {
    const row = unique(
      findAuction,
      {
        leagueId: command.request.leagueId,
        auctionId: command.request.auctionId,
      },
      "Auction identity is not unique within its league."
    );
    if (!row) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .auctionNotFound,
        "The auction was not found."
      );
    }
    if (
      ![
        "ordinary_weekly",
        "fad_open_rapid",
        "fad_restricted",
      ].includes(row.source_kind)
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The auction has an unsupported administration context."
      );
    }
    return row;
  }

  function requireAuction(command, loaded = null) {
    const row = loaded || loadAuction(command);
    if (command.occurredAtMs < row.opened_at_ms) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .auctionNotFound,
        "The auction was not found."
      );
    }
    if (
      row.source_kind === "fad_restricted" &&
      row.fad_allocation_id !== null &&
      row.fad_allocation_status !== "restricted_active" &&
      command.request.action !== "request_resolution"
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .auctionNotFound,
        "The auction was not found."
      );
    }
    return row;
  }

  function requirePrecondition(
    actualVersion,
    expectedVersion
  ) {
    if (actualVersion !== expectedVersion) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction resource changed; refetch it and try again."
      );
    }
  }

  function requireOpenBidWindow(auction, command) {
    if (
      auction.status !== "open" ||
      command.occurredAtMs < auction.opened_at_ms ||
      command.occurredAtMs >= auction.resolves_at_ms
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction bid-administration window is closed."
      );
    }
  }

  function requireBid(command, auction) {
    const bid = unique(
      findBid,
      {
        leagueId: command.request.leagueId,
        auctionId: command.request.auctionId,
        bidId: command.request.bidId,
      },
      "Auction bid identity is not unique."
    );
    if (
      !bid ||
      bid.season_id !== auction.season_id
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .auctionNotFound,
        "The auction bid was not found."
      );
    }
    if (bid.status !== "active") {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "Only an active auction bid may be administered."
      );
    }
    requirePrecondition(
      bid.version,
      command.request.preconditionVersion
    );
    return bid;
  }

  function requireRestrictedParticipant(
    auction,
    bid
  ) {
    if (auction.source_kind !== "fad_restricted") {
      return null;
    }
    const participant = unique(
      findRestrictedParticipant,
      {
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        auctionId: auction.auction_id,
        teamId: bid.team_id,
      },
      "Restricted auction participation is not unique."
    );
    if (
      !participant ||
      participant.status !== "active" ||
      participant.active_improvement_bid_id !== bid.id ||
      participant.allocation_id !==
        auction.fad_allocation_id
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The restricted auction bid has no active participant."
      );
    }
    return participant;
  }

  function projectOrdinaryAuction(
    command,
    auction,
    {
      cancellationActivityId = null,
    } = {}
  ) {
    const rows = listAuctionBids.all({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
    });
    const managedTeams = listManagedTeams.all({
      leagueId: auction.league_id,
      actorUserId: command.actorUserId,
      actorMembershipId:
        command.actorMembershipId,
    });
    const activeRows = rows.filter(
      (row) => row.bid_status === "active"
    );
    const status = publicAuctionStatus(auction.status);
    const isActive = status === "active";
    const viewerTeams = managedTeams.map((team) => {
      const bid = findViewerBid(rows, team.team_id);
      const canJoin =
        auction.league_status === "active" &&
        auction.status === "open" &&
        command.occurredAtMs >=
          auction.opened_at_ms &&
        command.occurredAtMs <
          auction.resolves_at_ms &&
        bid?.bid_status !== "active";
      return freeze({
        teamId: team.team_id,
        team: teamProjection(team),
        eligible: true,
        participantStatus: null,
        bid: bid
          ? viewerBidProjection(bid, auction)
          : null,
        join: canJoin
          ? allowedCapability()
          : blockedCapability(
              auction.league_status === "frozen"
                ? "LEAGUE_FROZEN"
                : "PHASE_CLOSED"
            ),
        edit: viewerEditCapability(
          bid,
          auction,
          command.occurredAtMs
        ),
      });
    });
    const result =
      status === "cancelled"
        ? cancelledResult({
            activityId: cancellationActivityId,
            resolvedAtMs: auction.updated_at_ms,
          })
        : activeResult();
    if (!isActive && status !== "cancelled") {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "This bounded repository cannot reconstruct a non-cancellation terminal result."
      );
    }
    return deepFreeze({
      auctionId: auction.auction_id,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      version: auction.auction_version,
      player: {
        playerId: auction.player_id,
        fullName: auction.player_full_name,
        positionGroup: auction.position_group,
      },
      status,
      openedAtMs: auction.opened_at_ms,
      resolvesAtMs: auction.resolves_at_ms,
      resolvedAtMs: isActive
        ? null
        : auction.updated_at_ms,
      updatedAtMs: auction.updated_at_ms,
      bidCount: activeRows.length,
      participatingTeamCount: new Set(
        activeRows.map((row) => row.team_id)
      ).size,
      sourceKind: "ordinary_weekly",
      fadOrigin: null,
      fadId: null,
      fadRolloverId: null,
      targetRolloverAtMs: null,
      creationCutoffAtMs: null,
      eligibleTeams: [],
      minimumContract: null,
      drawCommitment: null,
      viewerTeams,
      administrativeBids: rows.map((row) =>
        administrativeBidProjection(
          row,
          auction,
          command.occurredAtMs
        )
      ),
      result,
      capabilities: {
        view: allowedCapability(),
        adminCancel:
          ["active", "frozen"].includes(
            auction.league_status
          ) &&
          auction.status === "open" &&
          command.occurredAtMs >=
            auction.opened_at_ms
            ? allowedCapability()
            : blockedCapability("PHASE_CLOSED"),
        adminResolve:
          ["active", "frozen"].includes(
            auction.league_status
          ) &&
          auction.status === "open" &&
          command.occurredAtMs >=
            auction.opened_at_ms &&
          command.occurredAtMs >=
            auction.resolves_at_ms
            ? allowedCapability()
            : blockedCapability("PHASE_CLOSED"),
      },
    });
  }

  function projectAuction(command, auction, options) {
    if (auction.source_kind === "ordinary_weekly") {
      return projectOrdinaryAuction(
        command,
        auction,
        options
      );
    }
    const projected = auctionReadRepository.readAuction({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
      viewerUserId: command.actorUserId,
      viewerMembershipId:
        command.actorMembershipId,
      nowMs: command.occurredAtMs,
    });
    if (!projected) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The FAD auction cannot be projected after administration."
      );
    }
    return projected;
  }

  function projectFadAllocation(command, auction) {
    return freeAgentDraftInternalReadRepository
      .readInternalAllocationResult({
        allocationId: auction.fad_allocation_id,
        fadId: auction.fad_id,
        leagueId: auction.league_id,
        nowMs: command.occurredAtMs,
        playerId: auction.player_id,
        viewerMembershipId: command.actorMembershipId,
        viewerUserId: command.actorUserId,
      });
  }

  function restrictedCancellationContext(
    command,
    auction
  ) {
    if (
      !UUID_PATTERN.test(auction.fad_id || "") ||
      !UUID_PATTERN.test(
        auction.fad_rollover_id || ""
      ) ||
      !UUID_PATTERN.test(
        auction.fad_allocation_id || ""
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction has incomplete FAD identity."
      );
    }
    const allocation = unique(
      findRestrictedAllocation,
      {
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        allocationId: auction.fad_allocation_id,
      },
      "Restricted auction allocation identity is not unique."
    );
    if (
      !allocation ||
      allocation.player_id !== auction.player_id ||
      allocation.restricted_auction_id !==
        auction.auction_id
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction allocation identity is inconsistent."
      );
    }
    if (
      allocation.status !== "restricted_active" ||
      allocation.version !==
        auction.fad_allocation_version
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "Only an active restricted allocation may be cancelled."
      );
    }
    if (
      allocation.decision_code !==
        "exact_total_and_term_tie" ||
      allocation.winning_snapshot_entry_id !== null ||
      allocation.winning_team_id !== null ||
      allocation.contract_id !== null ||
      allocation.ownership_id !== null ||
      allocation.fallback_open_auction_id !== null ||
      allocation.accounted_at_ms !== null ||
      allocation.last_error_code !== null
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted allocation cannot be safely quarantined."
      );
    }
    const allocationEvents =
      listRestrictedAllocationEvents.all({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        allocationId: allocation.id,
        allocationVersion: allocation.version,
      });
    const offerEvents = allocationEvents.filter(
      (event) =>
        event.event_kind === "offer_considered"
    );
    const stateEvents = allocationEvents.filter(
      (event) =>
        event.event_kind ===
        "restricted_state_changed"
    );
    if (
      offerEvents.length < 2 ||
      stateEvents.length !== 1 ||
      allocationEvents.length !==
        offerEvents.length + 1 ||
      stateEvents[0].decision_code !==
        allocation.decision_code ||
      stateEvents[0].auction_id !==
        auction.auction_id ||
      stateEvents[0].resulting_allocation_status !==
        allocation.status
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted allocation has incomplete current-version decision evidence."
      );
    }
    const recoveries = listAuctionRecoveries.all({
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
    });
    if (recoveries.length !== 0) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The restricted auction already has recovery evidence."
      );
    }
    const occurrenceKey =
      `auction:${auction.auction_id}:` +
      `${auction.resolves_at_ms}`;
    const job = unique(
      findJob,
      {
        leagueId: auction.league_id,
        occurrenceKey,
      },
      "Auction resolution job occurrence is not unique."
    );
    if (
      job &&
      (
        job.season_id !== auction.season_id ||
        job.scheduled_for_ms !==
          auction.resolves_at_ms
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted auction resolution job is inconsistent."
      );
    }
    if (job && job.status !== "pending") {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The restricted auction resolution job is already active or terminal."
      );
    }
    projectAuction(command, auction, {});
    return {
      allocation,
      job,
      occurrenceKey,
      offerEvents,
    };
  }

  function failedResolutionJob(
    auction,
    occurrenceKey
  ) {
    const job = unique(
      findJob,
      {
        leagueId: auction.league_id,
        occurrenceKey,
      },
      "Auction resolution job occurrence is not unique."
    );
    if (
      !job ||
      job.season_id !== auction.season_id ||
      job.scheduled_for_ms !==
        auction.resolves_at_ms ||
      job.status !== "failed" ||
      job.attempt_count < 1 ||
      job.lease_owner !== null ||
      job.lease_expires_at_ms !== null ||
      job.lease_token !== null ||
      job.started_at_ms !== auction.updated_at_ms ||
      job.completed_at_ms !== auction.updated_at_ms ||
      job.result_json !== null ||
      job.last_error_code !==
        RESTRICTED_CANCELLATION_ERROR_CODE ||
      job.next_attempt_at_ms !== null ||
      job.updated_at_ms !== auction.updated_at_ms
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The cancelled restricted auction has incomplete failed-job evidence."
      );
    }
    return job;
  }

  function failedOpenRapidCancellationContext(
    command,
    auction
  ) {
    if (
      auction.status !== "failed" ||
      command.occurredAtMs < auction.updated_at_ms
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .fadIntegrationRequired,
        "Only an already-failed open-rapid auction may use commissioner recovery cancellation."
      );
    }
    if (
      !UUID_PATTERN.test(auction.fad_id || "") ||
      !UUID_PATTERN.test(
        auction.fad_rollover_id || ""
      ) ||
      auction.fad_allocation_id !== null ||
      auction.fad_allocation_status !== null ||
      auction.fad_allocation_version !== null ||
      ![
        "manager_nomination",
        "queued_nomination",
      ].includes(auction.fad_origin)
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .fadIntegrationRequired,
        "Only a direct failed open-rapid auction may use commissioner recovery cancellation."
      );
    }
    const occurrenceKey =
      `auction:${auction.auction_id}:` +
      `${auction.resolves_at_ms}`;
    const job = unique(
      findJob,
      {
        leagueId: auction.league_id,
        occurrenceKey,
      },
      "Auction resolution job occurrence is not unique."
    );
    const recoveries = listAuctionRecoveries.all({
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
    });
    const recovery = recoveries.length === 1
      ? recoveries[0]
      : null;
    const draw = unique(
      findOpenRapidDraw,
      {
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        auctionId: auction.auction_id,
      },
      "Open-rapid auction draw identity is not unique."
    );
    const failureEvents =
      listOpenRapidFailureEvents.all({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        auctionId: auction.auction_id,
      });
    const latestFailureEvents = failureEvents.filter(
      (event) =>
        event.occurred_at_ms === auction.updated_at_ms
    );
    const latestFailureEvent =
      latestFailureEvents.length === 1
        ? latestFailureEvents[0]
        : null;
    const bidRows = listAuctionBids.all({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
    });
    let failureMetadata = null;
    try {
      failureMetadata = latestFailureEvent
        ? JSON.parse(latestFailureEvent.metadata_json)
        : null;
    } catch {
      failureMetadata = null;
    }
    if (
      !job ||
      job.season_id !== auction.season_id ||
      job.scheduled_for_ms !==
        auction.resolves_at_ms ||
      job.status !== "failed" ||
      job.attempt_count < 1 ||
      job.lease_owner !== null ||
      job.lease_expires_at_ms !== null ||
      job.lease_token !== null ||
      job.started_at_ms === null ||
      job.started_at_ms > auction.updated_at_ms ||
      job.completed_at_ms !== auction.updated_at_ms ||
      job.result_json !== null ||
      typeof job.last_error_code !== "string" ||
      job.last_error_code.length === 0 ||
      job.next_attempt_at_ms !== null ||
      job.updated_at_ms !== auction.updated_at_ms ||
      !recovery ||
      recovery.fad_id !== auction.fad_id ||
      recovery.player_id !== auction.player_id ||
      recovery.allocation_id !== null ||
      recovery.rollover_id !==
        auction.fad_rollover_id ||
      recovery.auction_id !== auction.auction_id ||
      recovery.job_run_id !== job.id ||
      recovery.kind !== "auction_resolution" ||
      recovery.status !== "correction_required" ||
      recovery.earliest_activation_at_ms !== null ||
      recovery.target_resolution_at_ms !==
        auction.resolves_at_ms ||
      recovery.last_error_code !==
        job.last_error_code ||
      recovery.created_by_operation_id !== job.id ||
      recovery.resolved_by_user_id !== null ||
      recovery.resolved_by_membership_id !== null ||
      recovery.resolved_authority !== null ||
      recovery.created_at_ms > auction.updated_at_ms ||
      recovery.updated_at_ms !== auction.updated_at_ms ||
      recovery.resolved_at_ms !== null ||
      !draw ||
      draw.allocation_id !== null ||
      draw.algorithm_version !== 1 ||
      draw.revealed_at_ms !== null ||
      draw.ordered_tied_bid_ids_json !== null ||
      draw.ordered_tied_team_ids_json !== null ||
      draw.rejection_counter !== null ||
      draw.selected_index !== null ||
      draw.selected_bid_id !== null ||
      draw.selected_team_id !== null ||
      draw.selected_digest_hex !== null ||
      draw.updated_at_ms !== draw.created_at_ms ||
      draw.version !== 1 ||
      latestFailureEvents.length !== 1 ||
      failureEvents.some(
        (event) =>
          event.occurred_at_ms > auction.updated_at_ms
      ) ||
      latestFailureEvent.actor_user_id !== null ||
      latestFailureEvent.bid_id !== null ||
      latestFailureEvent.team_id !== null ||
      failureMetadata === null ||
      typeof failureMetadata !== "object" ||
      Array.isArray(failureMetadata) ||
      Object.keys(failureMetadata)
        .sort()
        .join("|") !==
        "errorCode|jobRunId|recoveryId" ||
      failureMetadata.errorCode !==
        job.last_error_code ||
      failureMetadata.jobRunId !== job.id ||
      failureMetadata.recoveryId !== recovery.id ||
      bidRows.some((bid) =>
        ["won", "lost", "cancelled"].includes(
          bid.bid_status
        )
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .fadIntegrationRequired,
        "The failed open-rapid auction has incomplete recovery evidence."
      );
    }
    const leaseExpiresAtMs =
      command.occurredAtMs +
      OPEN_RAPID_CANCELLATION_LEASE_MS;
    if (
      !Number.isSafeInteger(leaseExpiresAtMs) ||
      leaseExpiresAtMs > MAX_TIMESTAMP_MS
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "The open-rapid cancellation lease time is invalid."
      );
    }
    const projected = projectAuction(
      command,
      auction,
      {}
    );
    if (
      projected.status !== "correction_required" ||
      projected.result?.recoveryId !== recovery.id
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid auction cannot be safely projected."
      );
    }
    return {
      draw,
      failureEvent: latestFailureEvent,
      job,
      leaseExpiresAtMs,
      occurrenceKey,
      recovery,
    };
  }

  function insertStartedRequest(
    command,
    idempotencyRequestId
  ) {
    insertIdempotency.run({
      idempotencyRequestId,
      leagueId: command.request.leagueId,
      actorUserId: command.actorUserId,
      operation: command.policy.operation,
      idempotencyKey: command.idempotencyKey,
      requestSha256: command.requestSha256,
      occurredAtMs: command.occurredAtMs,
      idempotencyExpiresAtMs:
        command.idempotencyExpiresAtMs,
    });
  }

  function persistResult({
    command,
    actorAuthority,
    idempotencyRequestId,
    resultId,
    jobRunId,
    seasonId,
    resultingResourceVersion,
    responseData,
  }) {
    const responseJson =
      serializeCanonicalJsonV1(responseData);
    const responseSha256 =
      hashCanonicalJsonV1(responseData);
    const record = {
      id: resultId,
      leagueId: command.request.leagueId,
      seasonId,
      auctionId: command.request.auctionId,
      bidId: command.request.bidId,
      idempotencyRequestId,
      jobRunId,
      action: command.request.action,
      actorUserId: command.actorUserId,
      actorMembershipId:
        command.actorMembershipId,
      actorAuthority,
      requestSha256: command.requestSha256,
      preconditionKind:
        command.policy.preconditionKind,
      expectedResourceVersion:
        command.request.preconditionVersion,
      resultingResourceVersion,
      responseHttpStatus:
        command.policy.httpStatus,
      responseJson,
      responseSha256,
      createdAtMs: command.occurredAtMs,
      version: 1,
    };
    validateAuctionAdministrationStoredResult(
      record
    );
    insertResult.run({
      resultId,
      leagueId: record.leagueId,
      seasonId: record.seasonId,
      auctionId: record.auctionId,
      bidId: record.bidId,
      idempotencyRequestId,
      jobRunId,
      action: record.action,
      actorUserId: record.actorUserId,
      actorMembershipId:
        record.actorMembershipId,
      actorAuthority,
      requestSha256: record.requestSha256,
      preconditionKind:
        record.preconditionKind,
      expectedResourceVersion:
        record.expectedResourceVersion,
      resultingResourceVersion:
        record.resultingResourceVersion,
      responseHttpStatus:
        record.responseHttpStatus,
      responseJson,
      responseSha256,
      occurredAtMs: record.createdAtMs,
    });
    beforeCommit({
      action: record.action,
      resultId,
      idempotencyRequestId,
    });
    if (
      completeIdempotency.run({
        leagueId: record.leagueId,
        idempotencyRequestId,
        resultId,
        occurredAtMs: record.createdAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "Auction-administration idempotency completion changed concurrently."
      );
    }
    const stored = unique(
      findResult,
      {
        leagueId: record.leagueId,
        resultId,
      },
      "Auction-administration result identity is not unique."
    );
    if (!stored) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The immutable auction-administration result was not persisted."
      );
    }
    return safeResult(stored, false);
  }

  function executeEdit(
    command,
    actorAuthority,
    auction
  ) {
    requireOpenBidWindow(auction, command);
    const bid = requireBid(command, auction);
    const restrictedParticipant =
      requireRestrictedParticipant(auction, bid);
    if (
      bid.team_id !== command.request.body.teamId
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The supplied team does not own the identified bid."
      );
    }
    const nextVersion = bid.version + 1;
    const nextAav = command.request.body.aavCents;
    if (
      restrictedParticipant &&
      !(
        command.request.body.totalValueCents >
          restrictedParticipant.minimum_total_value_cents ||
        (
          command.request.body.totalValueCents ===
            restrictedParticipant.minimum_total_value_cents &&
          nextAav >
            restrictedParticipant.minimum_aav_cents
        )
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "A restricted auction edit must strictly improve the Candidate minimum."
      );
    }
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    const eventId = nextId();
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    if (
      updateBidEdit.run({
        leagueId: command.request.leagueId,
        auctionId: command.request.auctionId,
        bidId: command.request.bidId,
        expectedVersion: bid.version,
        totalValueCents:
          command.request.body.totalValueCents,
        termYears: command.request.body.termYears,
        lowestOfferedAavCents: Math.min(
          bid.lowest_offered_aav_cents,
          nextAav
        ),
        lowestOfferedTotalValueCents: Math.min(
          bid.lowest_offered_total_value_cents ??
            bid.total_value_cents,
          command.request.body.totalValueCents
        ),
        idempotencyRequestId,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction bid changed concurrently."
      );
    }
    if (
      restrictedParticipant &&
      updateRestrictedParticipantEdit.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        auctionId: auction.auction_id,
        teamId: bid.team_id,
        bidId: bid.id,
        expectedVersion:
          restrictedParticipant.version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The restricted auction participant changed concurrently."
      );
    }
    insertEvent.run({
      eventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      bidId: bid.id,
      teamId: bid.team_id,
      actorUserId: command.actorUserId,
      eventType: "bid_edited",
      metadataJson: serializeCanonicalJsonV1({
        actorAuthority,
        actorMembershipId:
          command.actorMembershipId,
        before: {
          totalValueCents:
            bid.total_value_cents,
          termYears: bid.term_years,
          lowestOfferedAavCents:
            bid.lowest_offered_aav_cents,
          lowestOfferedTotalValueCents:
            bid.lowest_offered_total_value_cents ??
              bid.total_value_cents,
          editCount: bid.edit_count,
          version: bid.version,
        },
        after: {
          totalValueCents:
            command.request.body.totalValueCents,
          termYears:
            command.request.body.termYears,
          aavCents: nextAav,
          lowestOfferedAavCents: Math.min(
            bid.lowest_offered_aav_cents,
            nextAav
          ),
          lowestOfferedTotalValueCents: Math.min(
            bid.lowest_offered_total_value_cents ??
              bid.total_value_cents,
            command.request.body.totalValueCents
          ),
          editCount: bid.edit_count,
          version: nextVersion,
        },
      }),
      occurredAtMs: command.occurredAtMs,
    });
    const currentAuction = requireAuction(command);
    const responseData = projectAuction(
      command,
      currentAuction
    );
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: null,
      seasonId: auction.season_id,
      resultingResourceVersion: nextVersion,
      responseData,
    });
  }

  function executeRemove(
    command,
    actorAuthority,
    auction
  ) {
    requireOpenBidWindow(auction, command);
    const bid = requireBid(command, auction);
    const restrictedParticipant =
      requireRestrictedParticipant(auction, bid);
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    const eventId = nextId();
    const nextVersion = bid.version + 1;
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    insertEvent.run({
      eventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      bidId: bid.id,
      teamId: bid.team_id,
      actorUserId: command.actorUserId,
      eventType: "commissioner_bid_removed",
      metadataJson: serializeCanonicalJsonV1({
        actorAuthority,
        actorMembershipId:
          command.actorMembershipId,
        removedBidId: bid.id,
      }),
      occurredAtMs: command.occurredAtMs,
    });
    if (
      updateBidRemove.run({
        leagueId: command.request.leagueId,
        auctionId: command.request.auctionId,
        bidId: command.request.bidId,
        expectedVersion: bid.version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction bid changed concurrently."
      );
    }
    if (
      restrictedParticipant &&
      updateRestrictedParticipantRemove.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        auctionId: auction.auction_id,
        teamId: bid.team_id,
        bidId: bid.id,
        actorUserId: command.actorUserId,
        actorMembershipId:
          command.actorMembershipId,
        actorAuthority,
        expectedVersion:
          restrictedParticipant.version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The restricted auction participant changed concurrently."
      );
    }
    const currentAuction = requireAuction(command);
    const responseData = deepFreeze({
      auction: projectAuction(
        command,
        currentAuction
      ),
      removedBidId: bid.id,
      restrictedParticipantStatus:
        restrictedParticipant ? "removed" : null,
      fadAllocationVersion:
        restrictedParticipant
          ? auction.fad_allocation_version
          : null,
    });
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: null,
      seasonId: auction.season_id,
      resultingResourceVersion: nextVersion,
      responseData,
    });
  }

  function executeOrdinaryCancel(
    command,
    actorAuthority,
    auction
  ) {
    if (
      auction.status !== "open" ||
      command.occurredAtMs < auction.opened_at_ms
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "Only an unresolved open auction may be cancelled."
      );
    }
    requirePrecondition(
      auction.auction_version,
      command.request.preconditionVersion
    );
    if (
      unique(
        findResolution,
        {
          leagueId: auction.league_id,
          auctionId: auction.auction_id,
        },
        "Auction resolution identity is not unique."
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction already has a terminal resolution."
      );
    }
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    const eventId = nextId();
    const activityId = nextId();
    const resolutionId = nextId();
    const nextVersion = auction.auction_version + 1;
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    cancelActiveBids.run({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
    });
    if (
      updateAuctionCancel.run({
        leagueId: auction.league_id,
        auctionId: auction.auction_id,
        expectedVersion:
          auction.auction_version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction changed concurrently."
      );
    }
    const metadataJson = serializeCanonicalJsonV1({
      actorAuthority,
      actorMembershipId:
        command.actorMembershipId,
      outcomeCode: "cancelled",
    });
    insertEvent.run({
      eventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      bidId: null,
      teamId: null,
      actorUserId: command.actorUserId,
      eventType: "auction_cancelled",
      metadataJson,
      occurredAtMs: command.occurredAtMs,
    });
    insertActivity.run({
      activityId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      actorUserId: command.actorUserId,
      actorAuthority,
      playerId: auction.player_id,
      auctionId: auction.auction_id,
      displaySummary: `${auction.player_full_name}'s auction was cancelled.`,
      metadataJson,
      occurredAtMs: command.occurredAtMs,
    });
    insertResolution.run({
      resolutionId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      occurrenceKey: `auction:${auction.auction_id}:${auction.resolves_at_ms}`,
      actorUserId: command.actorUserId,
      idempotencyKey: `auction.cancel:${idempotencyRequestId}`,
      resolvedAtMs: command.occurredAtMs,
    });
    const currentAuction = requireAuction(command);
    const auctionProjection = projectAuction(
      command,
      currentAuction,
      {
        cancellationActivityId: activityId,
      }
    );
    const responseData = deepFreeze({
      auction: auctionProjection,
      fadAllocation: null,
      recoveryId: null,
    });
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: null,
      seasonId: auction.season_id,
      resultingResourceVersion: nextVersion,
      responseData,
    });
  }

  function executeRestrictedCancel(
    command,
    actorAuthority,
    auction
  ) {
    if (
      auction.status !== "open" ||
      command.occurredAtMs < auction.opened_at_ms
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "Only an unresolved open auction may be cancelled."
      );
    }
    requirePrecondition(
      auction.auction_version,
      command.request.preconditionVersion
    );
    if (
      unique(
        findResolution,
        {
          leagueId: auction.league_id,
          auctionId: auction.auction_id,
        },
        "Auction resolution identity is not unique."
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction already has a terminal resolution."
      );
    }
    const context = restrictedCancellationContext(
      command,
      auction
    );
    const recipientUserId =
      currentCommissionerUserId(command);
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    const eventId = nextId();
    const resolutionId = nextId();
    const recoveryId = nextId();
    const jobRunId = context.job?.id || nextId();
    const offerEventIds = context.offerEvents.map(
      () => nextId()
    );
    const allocationEventId = nextId();
    const notificationId = nextId();
    const notificationOutboxEventId = nextId();
    const nextAuctionVersion =
      auction.auction_version + 1;
    const nextAllocationVersion =
      context.allocation.version + 1;
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    if (context.job) {
      if (
        failPendingResolutionJob.run({
          leagueId: auction.league_id,
          jobRunId,
          expectedVersion: context.job.version,
          occurredAtMs: command.occurredAtMs,
          errorCode:
            RESTRICTED_CANCELLATION_ERROR_CODE,
        }).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The restricted auction resolution job changed concurrently."
        );
      }
    } else {
      insertFailedResolutionJob.run({
        jobRunId,
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        occurrenceKey: context.occurrenceKey,
        scheduledForMs: auction.resolves_at_ms,
        occurredAtMs: command.occurredAtMs,
        errorCode:
          RESTRICTED_CANCELLATION_ERROR_CODE,
      });
    }
    if (
      updateRestrictedAllocationCancel.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        allocationId: context.allocation.id,
        playerId: auction.player_id,
        auctionId: auction.auction_id,
        expectedVersion: context.allocation.version,
        occurredAtMs: command.occurredAtMs,
        errorCode:
          RESTRICTED_CANCELLATION_ERROR_CODE,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The restricted allocation changed concurrently."
      );
    }
    context.offerEvents.forEach((offer, index) => {
      insertRestrictedAllocationEvent.run({
        eventId: offerEventIds[index],
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        allocationId: context.allocation.id,
        allocationVersion: nextAllocationVersion,
        playerId: auction.player_id,
        eventKind: "offer_considered",
        snapshotEntryId: offer.snapshot_entry_id,
        teamId: offer.team_id,
        offerValid: offer.offer_valid,
        rankPosition: offer.rank_position,
        offerOutcomeCode: offer.offer_outcome_code,
        decisionCode: null,
        resultingAllocationStatus:
          "correction_required",
        auctionId: null,
        actorUserId: null,
        actorMembershipId: null,
        actorAuthority: "system",
        evidenceJson: offer.evidence_json,
        occurredAtMs: command.occurredAtMs,
      });
    });
    const allocationEvidenceJson =
      serializeCanonicalJsonV1({
        actorAuthority,
        actorMembershipId:
          command.actorMembershipId,
        errorCode:
          RESTRICTED_CANCELLATION_ERROR_CODE,
        operation: "auction.cancel",
        recoveryId,
        schemaVersion: 1,
      });
    insertRestrictedAllocationEvent.run({
      eventId: allocationEventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      fadId: auction.fad_id,
      allocationId: context.allocation.id,
      allocationVersion: nextAllocationVersion,
      playerId: auction.player_id,
      eventKind: "restricted_state_changed",
      snapshotEntryId: null,
      teamId: null,
      offerValid: null,
      rankPosition: null,
      offerOutcomeCode: null,
      decisionCode: context.allocation.decision_code,
      resultingAllocationStatus:
        "correction_required",
      auctionId: auction.auction_id,
      actorUserId: command.actorUserId,
      actorMembershipId:
        command.actorMembershipId,
      actorAuthority,
      evidenceJson: allocationEvidenceJson,
      occurredAtMs: command.occurredAtMs,
    });
    insertRestrictedRecovery.run({
      recoveryId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      fadId: auction.fad_id,
      playerId: auction.player_id,
      allocationId: context.allocation.id,
      rolloverId: auction.fad_rollover_id,
      auctionId: auction.auction_id,
      jobRunId,
      targetResolutionAtMs: auction.resolves_at_ms,
      errorCode:
        RESTRICTED_CANCELLATION_ERROR_CODE,
      occurredAtMs: command.occurredAtMs,
    });
    cancelActiveBids.run({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
    });
    if (
      updateAuctionCancel.run({
        leagueId: auction.league_id,
        auctionId: auction.auction_id,
        expectedVersion:
          auction.auction_version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction changed concurrently."
      );
    }
    const metadataJson = serializeCanonicalJsonV1({
      actorAuthority,
      actorMembershipId:
        command.actorMembershipId,
      errorCode:
        RESTRICTED_CANCELLATION_ERROR_CODE,
      outcomeCode: "failed",
      recoveryId,
    });
    insertEvent.run({
      eventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      bidId: null,
      teamId: null,
      actorUserId: command.actorUserId,
      eventType: "auction_cancelled",
      metadataJson,
      occurredAtMs: command.occurredAtMs,
    });
    insertRestrictedResolution.run({
      resolutionId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      occurrenceKey: context.occurrenceKey,
      actorUserId: command.actorUserId,
      idempotencyKey:
        `auction.cancel:${idempotencyRequestId}`,
      resolvedAtMs: command.occurredAtMs,
    });
    writeRestrictedCancellationPublication({
      command,
      auction,
      recoveryId,
      recipientUserId,
      notificationId,
      outboxEventId: notificationOutboxEventId,
    });
    const currentAuction = loadAuction(command);
    const job = failedResolutionJob(
      currentAuction,
      context.occurrenceKey
    );
    if (job.id !== jobRunId) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted cancellation recovery job identity changed."
      );
    }
    const auctionProjection = projectAuction(
      command,
      currentAuction,
      {}
    );
    const allocationProjection = projectFadAllocation(
      command,
      currentAuction
    );
    if (
      auctionProjection.status !==
        "correction_required" ||
      auctionProjection.result?.recoveryId !==
        recoveryId ||
      allocationProjection.status !==
        "correction_required" ||
      allocationProjection.allocationVersion !==
        nextAllocationVersion ||
      allocationProjection.recoveryStatus !==
        "correction_required"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The restricted cancellation cannot be safely projected."
      );
    }
    const responseData = deepFreeze({
      auction: auctionProjection,
      fadAllocation:
        projectFreeAgentDraftAllocationResultForPublic(
          allocationProjection
        ),
      recoveryId,
    });
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: null,
      seasonId: auction.season_id,
      resultingResourceVersion:
        nextAuctionVersion,
      responseData,
    });
  }

  function executeFailedOpenRapidCancel(
    command,
    actorAuthority,
    auction
  ) {
    requirePrecondition(
      auction.auction_version,
      command.request.preconditionVersion
    );
    if (
      unique(
        findResolution,
        {
          leagueId: auction.league_id,
          auctionId: auction.auction_id,
        },
        "Auction resolution identity is not unique."
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction already has a terminal resolution."
      );
    }
    const context = failedOpenRapidCancellationContext(
      command,
      auction
    );
    if (
      !Number.isSafeInteger(auction.fad_version) ||
      auction.fad_version < 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The failed open-rapid cancellation has no authoritative FAD version."
      );
    }
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    const eventId = nextId();
    const activityId = nextId();
    const resolutionId = nextId();
    const leaseToken = nextId();
    const fadOutboxEventId = nextId();
    const activityOutboxEventId = nextId();
    const auctionOutboxEventId = nextId();
    const leaseOwner =
      `auction-administration:${resultId}`;
    const resultingAuctionVersion =
      auction.auction_version + 2;
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    if (
      retryFailedOpenRapidJob.run({
        leagueId: auction.league_id,
        jobRunId: context.job.id,
        expectedVersion: context.job.version,
        leaseOwner,
        leaseToken,
        leaseExpiresAtMs:
          context.leaseExpiresAtMs,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The failed open-rapid resolution job changed concurrently."
      );
    }
    if (
      startOpenRapidRecovery.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        recoveryId: context.recovery.id,
        expectedVersion: context.recovery.version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The failed open-rapid recovery changed concurrently."
      );
    }
    if (
      updateFailedAuctionResolving.run({
        leagueId: auction.league_id,
        auctionId: auction.auction_id,
        expectedVersion: auction.auction_version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .preconditionFailed,
        "The auction changed concurrently."
      );
    }
    cancelActiveBids.run({
      leagueId: auction.league_id,
      auctionId: auction.auction_id,
    });
    const metadataJson = serializeCanonicalJsonV1({
      actorAuthority,
      actorMembershipId:
        command.actorMembershipId,
      outcomeCode: "cancelled",
      recoveryId: context.recovery.id,
    });
    insertEvent.run({
      eventId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      bidId: null,
      teamId: null,
      actorUserId: command.actorUserId,
      eventType: "auction_cancelled",
      metadataJson,
      occurredAtMs: command.occurredAtMs,
    });
    insertResolution.run({
      resolutionId,
      leagueId: auction.league_id,
      seasonId: auction.season_id,
      auctionId: auction.auction_id,
      occurrenceKey: context.occurrenceKey,
      actorUserId: command.actorUserId,
      idempotencyKey:
        `auction.cancel:${idempotencyRequestId}`,
      resolvedAtMs: command.occurredAtMs,
    });
    if (
      revealOpenRapidNoSelectionDraw.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        auctionId: auction.auction_id,
        expectedVersion: context.draw.version,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The failed open-rapid draw changed concurrently."
      );
    }
    if (
      updateResolvingAuctionCancel.run({
        leagueId: auction.league_id,
        auctionId: auction.auction_id,
        expectedVersion:
          auction.auction_version + 1,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The resolving open-rapid auction changed concurrently."
      );
    }
    if (
      resolveOpenRapidRecovery.run({
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        recoveryId: context.recovery.id,
        expectedVersion:
          context.recovery.version + 1,
        actorUserId: command.actorUserId,
        actorMembershipId:
          command.actorMembershipId,
        actorAuthority,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The running open-rapid recovery changed concurrently."
      );
    }
    const jobResultJson = serializeCanonicalJsonV1({
      auctionId: auction.auction_id,
      outcome: "cancelled",
    });
    if (
      succeedOpenRapidJob.run({
        leagueId: auction.league_id,
        jobRunId: context.job.id,
        expectedVersion: context.job.version + 1,
        leaseOwner,
        leaseToken,
        resultJson: jobResultJson,
        occurredAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The open-rapid cancellation job changed concurrently."
      );
    }
    writeFailedOpenRapidCorrectionEvidence({
      causality: {
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        fadId: auction.fad_id,
        fadVersion: auction.fad_version,
        auctionId: auction.auction_id,
        auctionVersion: resultingAuctionVersion,
        recoveryId: context.recovery.id,
        activityId,
        playerId: auction.player_id,
        playerFullName: auction.player_full_name,
        actorUserId: command.actorUserId,
        actorMembershipId:
          command.actorMembershipId,
        actorAuthority,
        occurredAtMs: command.occurredAtMs,
      },
      outboxEventIds: [
        fadOutboxEventId,
        activityOutboxEventId,
        auctionOutboxEventId,
      ],
    });
    const currentAuction = loadAuction(command);
    const auctionProjection = projectAuction(
      command,
      currentAuction,
      {
        cancellationActivityId: activityId,
      }
    );
    if (
      currentAuction.auction_version !==
        resultingAuctionVersion ||
      auctionProjection.status !== "cancelled" ||
      auctionProjection.result?.outcomeCode !==
        "cancelled" ||
      auctionProjection.result?.recoveryId !==
        context.recovery.id ||
      auctionProjection.result?.activityId !==
        activityId ||
      auctionProjection.result?.drawEvidence?.reveal
        ?.selectionUsed !== false
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The recovered open-rapid cancellation cannot be safely projected."
      );
    }
    const responseData = deepFreeze({
      auction: auctionProjection,
      fadAllocation: null,
      recoveryId: context.recovery.id,
    });
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: null,
      seasonId: auction.season_id,
      resultingResourceVersion:
        resultingAuctionVersion,
      responseData,
    });
  }

  function executeCancel(
    command,
    actorAuthority,
    auction
  ) {
    if (auction.source_kind === "ordinary_weekly") {
      return executeOrdinaryCancel(
        command,
        actorAuthority,
        auction
      );
    }
    if (auction.source_kind === "fad_restricted") {
      return executeRestrictedCancel(
        command,
        actorAuthority,
        auction
      );
    }
    if (
      auction.source_kind === "fad_open_rapid" &&
      auction.status === "failed"
    ) {
      return executeFailedOpenRapidCancel(
        command,
        actorAuthority,
        auction
      );
    }
    fail(
      AUCTION_ADMINISTRATION_REPOSITORY_CODES
        .fadIntegrationRequired,
      "FAD open-rapid cancellation requires its failed-auction recovery path."
    );
  }

  function requireFadResolutionRequestContext(
    command,
    auction,
    job
  ) {
    if (auction.source_kind === "ordinary_weekly") {
      return;
    }
    const restrictedContext =
      auction.source_kind === "fad_restricted" &&
      UUID_PATTERN.test(auction.fad_id || "") &&
      UUID_PATTERN.test(
        auction.fad_rollover_id || ""
      ) &&
      UUID_PATTERN.test(
        auction.fad_allocation_id || ""
      ) &&
      auction.fad_origin ===
        "candidate_tie_restricted" &&
      (
        !["open", "resolving"].includes(
          auction.status
        ) ||
        auction.fad_allocation_status ===
          "restricted_active"
      );
    const directOpenContext =
      auction.source_kind === "fad_open_rapid" &&
      UUID_PATTERN.test(auction.fad_id || "") &&
      UUID_PATTERN.test(
        auction.fad_rollover_id || ""
      ) &&
      [
        "manager_nomination",
        "queued_nomination",
      ].includes(auction.fad_origin) &&
      auction.fad_allocation_id === null;
    const fallbackOpenContext =
      auction.source_kind === "fad_open_rapid" &&
      UUID_PATTERN.test(auction.fad_id || "") &&
      UUID_PATTERN.test(
        auction.fad_rollover_id || ""
      ) &&
      auction.fad_origin ===
        "restricted_no_improvement_fallback" &&
      UUID_PATTERN.test(
        auction.fad_allocation_id || ""
      );
    if (
      !(
        restrictedContext ||
        directOpenContext ||
        fallbackOpenContext
      ) ||
      auction.status === "failed" ||
      (
        auction.status === "resolving" &&
        !["leased", "running"].includes(
          job?.status
        )
      ) ||
      (
        auction.status === "open" &&
        job?.status === "succeeded"
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .fadIntegrationRequired,
        "The FAD auction must remain on its context-aware resolution or recovery path."
      );
    }
    const projected = projectAuction(
      command,
      auction,
      {}
    );
    if (
      ["open", "resolving"].includes(
        auction.status
      ) &&
      projected.status !== "active"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The FAD auction cannot be safely queued for resolution."
      );
    }
  }

  function executeResolutionRequest(
    command,
    actorAuthority,
    auction
  ) {
    requirePrecondition(
      auction.auction_version,
      command.request.preconditionVersion
    );
    if (command.occurredAtMs < auction.resolves_at_ms) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .notDue,
        "The auction is not due for resolution."
      );
    }
    const occurrenceKey =
      `auction:${auction.auction_id}:${auction.resolves_at_ms}`;
    let job = unique(
      findJob,
      {
        leagueId: auction.league_id,
        occurrenceKey,
      },
      "Auction resolution job occurrence is not unique."
    );
    if (
      job &&
      (job.season_id !== auction.season_id ||
        job.scheduled_for_ms !==
          auction.resolves_at_ms)
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The auction resolution job does not match its auction."
      );
    }
    if (
      !job &&
      !["open", "resolving", "failed"].includes(
        auction.status
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The terminal auction has no successful resolution job."
      );
    }
    if (
      job &&
      ![
        "pending",
        "leased",
        "running",
        "succeeded",
        "failed",
      ].includes(job.status)
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction resolution job cannot be requested."
      );
    }
    if (
      job?.status !== "succeeded" &&
      !["open", "resolving", "failed"].includes(
        auction.status
      )
    ) {
      fail(
        AUCTION_ADMINISTRATION_REPOSITORY_CODES
          .stateConflict,
        "The auction cannot accept a pending resolution request."
      );
    }
    requireFadResolutionRequestContext(
      command,
      auction,
      job
    );
    const idempotencyRequestId = nextId();
    const resultId = nextId();
    insertStartedRequest(
      command,
      idempotencyRequestId
    );
    if (!job) {
      const jobRunId = nextId();
      insertJob.run({
        jobRunId,
        leagueId: auction.league_id,
        seasonId: auction.season_id,
        occurrenceKey,
        scheduledForMs: auction.resolves_at_ms,
        occurredAtMs: command.occurredAtMs,
      });
      job = unique(
        findJob,
        {
          leagueId: auction.league_id,
          occurrenceKey,
        },
        "Auction resolution job occurrence is not unique."
      );
    } else if (job.status === "failed") {
      if (
        retryJob.run({
          leagueId: auction.league_id,
          jobRunId: job.id,
          expectedVersion: job.version,
          occurredAtMs: command.occurredAtMs,
        }).changes !== 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The auction resolution job changed concurrently."
        );
      }
      job = unique(
        findJob,
        {
          leagueId: auction.league_id,
          occurrenceKey,
        },
        "Auction resolution job occurrence is not unique."
      );
    }
    const responseData = deepFreeze({
      operationId: job.id,
      occurrenceKey,
      auctionId: auction.auction_id,
      status:
        job.status === "succeeded"
          ? "already_succeeded"
          : "pending",
      acceptedAtMs: command.occurredAtMs,
      pollDescriptor: {
        kind: "auction",
        leagueId: auction.league_id,
        auctionId: auction.auction_id,
      },
    });
    return persistResult({
      command,
      actorAuthority,
      idempotencyRequestId,
      resultId,
      jobRunId: job.id,
      seasonId: auction.season_id,
      resultingResourceVersion:
        auction.auction_version,
      responseData,
    });
  }

  try {
    findAuthority = database.prepare(`
      SELECT
        leagues.status AS league_status,
        leagues.commissioner_membership_id,
        users.status AS user_status,
        league_memberships.status AS membership_status,
        league_memberships.permission_category
          AS membership_permission,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = @actorUserId
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
            AND platform_roles.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END AS is_platform_administrator
      FROM leagues
      JOIN users
        ON users.id = @actorUserId
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id =
          @actorMembershipId
       AND league_memberships.user_id =
          @actorUserId
       AND league_memberships.joined_at_ms IS NOT NULL
       AND league_memberships.ended_at_ms IS NULL
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    findCurrentCommissionerRecipient = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id =
          league.commissioner_membership_id
       AND membership.permission_category =
          'commissioner'
       AND membership.status = 'active'
       AND membership.joined_at_ms IS NOT NULL
       AND membership.joined_at_ms <= @occurredAtMs
       AND membership.ended_at_ms IS NULL
      JOIN users AS user
        ON user.id = membership.user_id
       AND user.status = 'active'
      WHERE league.id = @leagueId
      LIMIT 2
    `);
    findIdempotency = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = @operation
        AND client_key = @idempotencyKey
      LIMIT 2
    `);
    findResult = database.prepare(`
      SELECT *
      FROM auction_administration_command_results
      WHERE league_id = @leagueId
        AND id = @resultId
      LIMIT 2
    `);
    findRestrictedCancellationNotifications =
      database.prepare(`
        SELECT *
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type =
            'fad_correction_required'
          AND related_feature =
            'free_agent_draft'
          AND related_record_id = @fadId
          AND json_extract(
            message_data_json,
            '$.recoveryId'
          ) = @recoveryId
        ORDER BY created_at_ms, user_id, id
      `);
    findNotificationOutboxes = database.prepare(`
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
        AND event.event_type =
          'notification.created'
        AND event.aggregate_type = 'notification'
        AND event.aggregate_id = @notificationId
      ORDER BY event.id, audience.id
    `);
    findActivity = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE league_id = @leagueId
        AND id = @activityId
      LIMIT 2
    `);
    findLeaguePublicationOutboxes = database.prepare(`
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
        AND event.event_type = @eventType
        AND event.aggregate_type = @aggregateType
        AND event.aggregate_id = @aggregateId
        AND event.created_at_ms = @occurredAtMs
        AND json_extract(
          event.payload_json,
          '$.related.fadId'
        ) = @fadId
        AND json_extract(
          event.payload_json,
          '$.related.auctionId'
        ) = @auctionId
        AND json_extract(
          event.payload_json,
          '$.related.recoveryId'
        ) = @recoveryId
      ORDER BY event.id, audience.id
    `);
    findFailedOpenRapidCorrectionOutboxes =
      database.prepare(`
        SELECT
          event.id,
          audience.audience_kind,
          audience.team_id AS audience_team_id,
          audience.user_id AS audience_user_id
        FROM outbox_events AS event
        JOIN outbox_event_audiences AS audience
          ON audience.league_id = event.league_id
         AND audience.outbox_event_id = event.id
        WHERE event.league_id = @leagueId
          AND event.created_at_ms = @occurredAtMs
          AND (
            (
              event.event_type =
                'free_agent_draft.changed'
              AND event.aggregate_type =
                'free_agent_draft'
              AND event.aggregate_id = @fadId
              AND json_extract(
                event.payload_json,
                '$.version'
              ) = @fadVersion
              AND json_extract(
                event.payload_json,
                '$.reasonCode'
              ) = 'correction_applied'
            )
            OR (
              event.event_type = 'activity.created'
              AND event.aggregate_type =
                'league_activity'
              AND event.aggregate_id = @activityId
              AND json_extract(
                event.payload_json,
                '$.version'
              ) = 1
              AND json_extract(
                event.payload_json,
                '$.reasonCode'
              ) = 'correction_applied'
            )
            OR (
              event.event_type = 'auction.changed'
              AND event.aggregate_type = 'auction'
              AND event.aggregate_id = @auctionId
              AND json_extract(
                event.payload_json,
                '$.version'
              ) = @auctionVersion
              AND json_extract(
                event.payload_json,
                '$.reasonCode'
              ) = 'auction_changed'
            )
          )
          AND json_extract(
            event.payload_json,
            '$.related.fadId'
          ) = @fadId
          AND json_extract(
            event.payload_json,
            '$.related.auctionId'
          ) = @auctionId
          AND json_extract(
            event.payload_json,
            '$.related.recoveryId'
          ) = @recoveryId
        ORDER BY event.id, audience.id
      `);
    findAuction = database.prepare(`
      SELECT
        auctions.id AS auction_id,
        auctions.league_id,
        auctions.season_id,
        auctions.player_id,
        auctions.status,
        auctions.opened_at_ms,
        auctions.resolves_at_ms,
        auctions.updated_at_ms,
        auctions.version AS auction_version,
        leagues.status AS league_status,
        auction_contexts.source_kind,
        auction_contexts.fad_id,
        auction_contexts.fad_rollover_id,
        auction_contexts.fad_allocation_id,
        auction_contexts.fad_origin,
        free_agent_drafts.version AS fad_version,
        free_agent_draft_player_allocations.status
          AS fad_allocation_status,
        free_agent_draft_player_allocations.version
          AS fad_allocation_version,
        players.full_name AS player_full_name,
        COALESCE(
          (
            SELECT league_player_positions.position_group
            FROM league_player_positions
            WHERE league_player_positions.league_id =
                auctions.league_id
              AND league_player_positions.player_id =
                auctions.player_id
              AND league_player_positions.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT CASE
              WHEN COUNT(
                DISTINCT player_source_state.normalized_position
              ) = 1
              THEN MAX(
                player_source_state.normalized_position
              )
              ELSE NULL
            END
            FROM player_source_state
            WHERE player_source_state.player_id =
                auctions.player_id
              AND player_source_state.ended_at_ms IS NULL
              AND player_source_state.active = 1
              AND player_source_state.normalized_position
                IN ('F', 'D')
          )
        ) AS position_group
      FROM auctions
      JOIN leagues
        ON leagues.id = auctions.league_id
      JOIN auction_contexts
        ON auction_contexts.league_id =
            auctions.league_id
       AND auction_contexts.season_id =
            auctions.season_id
       AND auction_contexts.auction_id =
            auctions.id
      LEFT JOIN free_agent_drafts
        ON free_agent_drafts.league_id =
            auction_contexts.league_id
       AND free_agent_drafts.season_id =
            auction_contexts.season_id
       AND free_agent_drafts.id =
            auction_contexts.fad_id
      LEFT JOIN free_agent_draft_player_allocations
        ON free_agent_draft_player_allocations.league_id =
            auction_contexts.league_id
       AND free_agent_draft_player_allocations.season_id =
            auction_contexts.season_id
       AND free_agent_draft_player_allocations.fad_id =
            auction_contexts.fad_id
       AND free_agent_draft_player_allocations.id =
            auction_contexts.fad_allocation_id
      JOIN players
        ON players.id = auctions.player_id
      WHERE auctions.league_id = @leagueId
        AND auctions.id = @auctionId
      LIMIT 2
    `);
    findBid = database.prepare(`
      SELECT *
      FROM auction_bids
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @bidId
      LIMIT 2
    `);
    findRestrictedParticipant = database.prepare(`
      SELECT *
      FROM free_agent_draft_auction_participants
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
        AND team_id = @teamId
      LIMIT 2
    `);
    listAuctionBids = database.prepare(`
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
        teams.logo_reference,
        teams.primary_colour,
        teams.secondary_colour,
        teams.tertiary_colour,
        teams.pattern_template
      FROM auction_bids
      JOIN teams
        ON teams.league_id = auction_bids.league_id
       AND teams.id = auction_bids.team_id
      WHERE auction_bids.league_id = @leagueId
        AND auction_bids.auction_id = @auctionId
      ORDER BY
        CASE WHEN auction_bids.status = 'active'
          THEN 0 ELSE 1 END,
        auction_bids.last_edited_at_ms DESC,
        auction_bids.id
    `);
    listManagedTeams = database.prepare(`
      SELECT
        teams.id AS team_id,
        teams.name AS team_name,
        teams.logo_reference,
        teams.primary_colour,
        teams.secondary_colour,
        teams.tertiary_colour,
        teams.pattern_template
      FROM team_manager_assignments
      JOIN teams
        ON teams.league_id =
            team_manager_assignments.league_id
       AND teams.id =
            team_manager_assignments.team_id
      WHERE team_manager_assignments.league_id =
          @leagueId
        AND team_manager_assignments.user_id =
          @actorUserId
        AND team_manager_assignments.membership_id =
          @actorMembershipId
        AND team_manager_assignments.status = 'accepted'
        AND team_manager_assignments.accepted_at_ms
          IS NOT NULL
        AND team_manager_assignments.ended_at_ms
          IS NULL
        AND teams.status = 'active'
      ORDER BY teams.id
    `);
    findResolution = database.prepare(`
      SELECT id
      FROM auction_resolutions
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
      LIMIT 2
    `);
    findJob = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND job_type = '${JOB_TYPE}'
        AND occurrence_key = @occurrenceKey
      LIMIT 2
    `);
    findRestrictedAllocation = database.prepare(`
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
      LIMIT 2
    `);
    listRestrictedAllocationEvents = database.prepare(`
      SELECT *
      FROM free_agent_draft_allocation_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND allocation_id = @allocationId
        AND allocation_version = @allocationVersion
      ORDER BY
        CASE event_kind
          WHEN 'offer_considered' THEN 1
          ELSE 2
        END,
        rank_position,
        id
    `);
    listAuctionRecoveries = database.prepare(`
      SELECT *
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
      ORDER BY created_at_ms, id
    `);
    findOpenRapidDraw = database.prepare(`
      SELECT *
      FROM free_agent_draft_draws
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND auction_id = @auctionId
      LIMIT 2
    `);
    listOpenRapidFailureEvents = database.prepare(`
      SELECT *
      FROM auction_events
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND auction_id = @auctionId
        AND event_type = 'fad_auction_resolution_failed'
      ORDER BY occurred_at_ms, id
    `);
    insertIdempotency = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation,
        client_key, request_hash, status,
        result_type, result_id, created_at_ms,
        completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId,
        @actorUserId, @operation,
        @idempotencyKey, @requestSha256, 'started',
        NULL, NULL, @occurredAtMs,
        NULL, @idempotencyExpiresAtMs
      )
    `);
    updateBidEdit = database.prepare(`
      UPDATE auction_bids
      SET total_value_cents = @totalValueCents,
          term_years = @termYears,
          lowest_offered_aav_cents =
            @lowestOfferedAavCents,
          lowest_offered_total_value_cents =
            @lowestOfferedTotalValueCents,
          last_edited_at_ms = @occurredAtMs,
          idempotency_request_id =
            @idempotencyRequestId,
          version = version + 1
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @bidId
        AND status = 'active'
        AND version = @expectedVersion
    `);
    updateBidRemove = database.prepare(`
      UPDATE auction_bids
      SET status = 'withdrawn',
          last_edited_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND id = @bidId
        AND status = 'active'
        AND version = @expectedVersion
    `);
    updateRestrictedParticipantEdit =
      database.prepare(`
        UPDATE free_agent_draft_auction_participants
        SET current_cooldown_anchor_at_ms =
              @occurredAtMs,
            improvement_committed_at_ms =
              @occurredAtMs,
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND auction_id = @auctionId
          AND team_id = @teamId
          AND active_improvement_bid_id = @bidId
          AND status = 'active'
          AND version = @expectedVersion
      `);
    updateRestrictedParticipantRemove =
      database.prepare(`
        UPDATE free_agent_draft_auction_participants
        SET status = 'removed',
            active_improvement_bid_id = NULL,
            removed_by_user_id = @actorUserId,
            removed_by_membership_id =
              @actorMembershipId,
            removed_authority = @actorAuthority,
            removal_reason =
              'commissioner_bid_removed',
            removed_at_ms = @occurredAtMs,
            updated_at_ms = @occurredAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND auction_id = @auctionId
          AND team_id = @teamId
          AND active_improvement_bid_id = @bidId
          AND status = 'active'
          AND version = @expectedVersion
      `);
    cancelActiveBids = database.prepare(`
      UPDATE auction_bids
      SET status = 'cancelled',
          version = version + 1
      WHERE league_id = @leagueId
        AND auction_id = @auctionId
        AND status = 'active'
    `);
    updateAuctionCancel = database.prepare(`
      UPDATE auctions
      SET status = 'cancelled',
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @auctionId
        AND status = 'open'
        AND version = @expectedVersion
    `);
    insertEvent = database.prepare(`
      INSERT INTO auction_events (
        id, league_id, season_id, auction_id,
        bid_id, team_id, actor_user_id,
        event_type, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @auctionId,
        @bidId, @teamId, @actorUserId,
        @eventType, @metadataJson, @occurredAtMs
      )
    `);
    insertActivity = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type,
        actor_user_id, actor_authority, team_id,
        player_id, related_type, related_id,
        display_summary, reason, metadata_json,
        occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId,
        'auction_cancelled',
        @actorUserId, @actorAuthority, NULL,
        @playerId, 'auction', @auctionId,
        @displaySummary, NULL, @metadataJson,
        @occurredAtMs
      )
    `);
    insertFadCorrectionActivity = database.prepare(`
      INSERT INTO league_activity (
        id, league_id, season_id, event_type,
        actor_user_id, actor_authority, team_id,
        player_id, related_type, related_id,
        display_summary, reason, metadata_json,
        occurred_at_ms
      ) VALUES (
        @activityId, @leagueId, @seasonId,
        @eventType, @actorUserId, @actorAuthority,
        NULL, @playerId, 'auction', @auctionId,
        @displaySummary, NULL, @metadataJson,
        @occurredAtMs
      )
    `);
    insertResolution = database.prepare(`
      INSERT INTO auction_resolutions (
        id, league_id, season_id, auction_id,
        scheduled_occurrence_key, outcome_code,
        winning_team_id, winning_bid_id,
        highest_bid_cents, second_price_input_cents,
        final_contract_value_cents,
        winning_term_years, final_aav_cents,
        general_illegal, warnings_json,
        contract_id, ownership_id, trigger_type,
        triggered_by_user_id, idempotency_key,
        status, resolved_at_ms
      ) VALUES (
        @resolutionId, @leagueId, @seasonId,
        @auctionId, @occurrenceKey, 'recovered',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        0, '[]', NULL, NULL, 'commissioner',
        @actorUserId, @idempotencyKey,
        'cancelled', @resolvedAtMs
      )
    `);
    insertRestrictedResolution = database.prepare(`
      INSERT INTO auction_resolutions (
        id, league_id, season_id, auction_id,
        scheduled_occurrence_key, outcome_code,
        winning_team_id, winning_bid_id,
        highest_bid_cents, second_price_input_cents,
        final_contract_value_cents,
        winning_term_years, final_aav_cents,
        general_illegal, warnings_json,
        contract_id, ownership_id, trigger_type,
        triggered_by_user_id, idempotency_key,
        status, resolved_at_ms
      ) VALUES (
        @resolutionId, @leagueId, @seasonId,
        @auctionId, @occurrenceKey, 'failed',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        0, '[]', NULL, NULL, 'commissioner',
        @actorUserId, @idempotencyKey,
        'cancelled', @resolvedAtMs
      )
    `);
    insertJob = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type,
        occurrence_key, scheduled_for_ms, status,
        attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms,
        completed_at_ms, result_json,
        last_error_code, created_at_ms,
        updated_at_ms, version, lease_token,
        next_attempt_at_ms
      ) VALUES (
        @jobRunId, @leagueId, @seasonId,
        '${JOB_TYPE}', @occurrenceKey,
        @scheduledForMs, 'pending', 0,
        NULL, NULL, NULL, NULL, NULL, NULL,
        @occurredAtMs, @occurredAtMs, 1,
        NULL, @scheduledForMs
      )
    `);
    retryJob = database.prepare(`
      UPDATE job_runs
      SET status = 'pending',
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          lease_token = NULL,
          started_at_ms = NULL,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = @occurredAtMs,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND status = 'failed'
        AND version = @expectedVersion
    `);
    insertFailedResolutionJob = database.prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type,
        occurrence_key, scheduled_for_ms, status,
        attempt_count, lease_owner,
        lease_expires_at_ms, started_at_ms,
        completed_at_ms, result_json,
        last_error_code, created_at_ms,
        updated_at_ms, version, lease_token,
        next_attempt_at_ms
      ) VALUES (
        @jobRunId, @leagueId, @seasonId,
        '${JOB_TYPE}', @occurrenceKey,
        @scheduledForMs, 'failed', 1,
        NULL, NULL, @occurredAtMs, @occurredAtMs,
        NULL, @errorCode, @occurredAtMs,
        @occurredAtMs, 1, NULL, NULL
      )
    `);
    failPendingResolutionJob = database.prepare(`
      UPDATE job_runs
      SET status = 'failed',
          attempt_count = CASE
            WHEN attempt_count < 1 THEN 1
            ELSE attempt_count
          END,
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          lease_token = NULL,
          started_at_ms = @occurredAtMs,
          completed_at_ms = @occurredAtMs,
          result_json = NULL,
          last_error_code = @errorCode,
          next_attempt_at_ms = NULL,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND status = 'pending'
        AND version = @expectedVersion
    `);
    updateRestrictedAllocationCancel = database.prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'correction_required',
          last_error_code = @errorCode,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @allocationId
        AND player_id = @playerId
        AND restricted_auction_id = @auctionId
        AND status = 'restricted_active'
        AND version = @expectedVersion
    `);
    insertRestrictedAllocationEvent = database.prepare(`
      INSERT INTO free_agent_draft_allocation_events (
        id, league_id, season_id, fad_id,
        allocation_id, allocation_version,
        player_id, event_kind, snapshot_entry_id,
        team_id, offer_valid, rank_position,
        offer_outcome_code, decision_code,
        resulting_allocation_status, contract_id,
        ownership_id, auction_id, activity_id,
        correction_id, actor_user_id,
        actor_membership_id, actor_authority,
        evidence_json, occurred_at_ms,
        created_at_ms, version
      ) VALUES (
        @eventId, @leagueId, @seasonId, @fadId,
        @allocationId, @allocationVersion,
        @playerId, @eventKind, @snapshotEntryId,
        @teamId, @offerValid, @rankPosition,
        @offerOutcomeCode, @decisionCode,
        @resultingAllocationStatus, NULL, NULL,
        @auctionId, NULL, NULL, @actorUserId,
        @actorMembershipId, @actorAuthority,
        @evidenceJson, @occurredAtMs,
        @occurredAtMs, 1
      )
    `);
    insertRestrictedRecovery = database.prepare(`
      INSERT INTO free_agent_draft_recoveries (
        id, league_id, season_id, fad_id,
        player_id, allocation_id, rollover_id,
        auction_id, job_run_id, kind, status,
        earliest_activation_at_ms,
        target_resolution_at_ms, last_error_code,
        commissioner_reason, created_by_operation_id,
        resolved_by_user_id, resolved_by_membership_id,
        resolved_authority, created_at_ms, updated_at_ms,
        resolved_at_ms, version, nomination_queue_id
      ) VALUES (
        @recoveryId, @leagueId, @seasonId, @fadId,
        @playerId, @allocationId, @rolloverId,
        @auctionId, @jobRunId, 'auction_resolution',
        'correction_required', NULL,
        @targetResolutionAtMs, @errorCode, NULL,
        @jobRunId, NULL, NULL, NULL,
        @occurredAtMs, @occurredAtMs, NULL, 1, NULL
      )
    `);
    retryFailedOpenRapidJob = database.prepare(`
      UPDATE job_runs
      SET status = 'leased',
          attempt_count = attempt_count + 1,
          lease_owner = @leaseOwner,
          lease_expires_at_ms = @leaseExpiresAtMs,
          lease_token = @leaseToken,
          started_at_ms = @occurredAtMs,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND job_type = '${JOB_TYPE}'
        AND status = 'failed'
        AND attempt_count >= 1
        AND lease_owner IS NULL
        AND lease_expires_at_ms IS NULL
        AND lease_token IS NULL
        AND completed_at_ms IS NOT NULL
        AND result_json IS NULL
        AND last_error_code IS NOT NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedVersion
    `);
    startOpenRapidRecovery = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'running',
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @recoveryId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND kind = 'auction_resolution'
        AND status = 'correction_required'
        AND last_error_code IS NOT NULL
        AND resolved_at_ms IS NULL
        AND version = @expectedVersion
    `);
    updateFailedAuctionResolving = database.prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @auctionId
        AND status = 'failed'
        AND version = @expectedVersion
    `);
    revealOpenRapidNoSelectionDraw = database.prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = '[]',
          ordered_tied_team_ids_json = '[]',
          rejection_counter = NULL,
          selected_index = NULL,
          selected_bid_id = NULL,
          selected_team_id = NULL,
          selected_digest_hex = NULL,
          revealed_at_ms = @occurredAtMs,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND auction_id = @auctionId
        AND revealed_at_ms IS NULL
        AND version = @expectedVersion
    `);
    updateResolvingAuctionCancel = database.prepare(`
      UPDATE auctions
      SET status = 'cancelled',
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @auctionId
        AND status = 'resolving'
        AND version = @expectedVersion
    `);
    resolveOpenRapidRecovery = database.prepare(`
      UPDATE free_agent_draft_recoveries
      SET status = 'resolved',
          last_error_code = NULL,
          resolved_by_user_id = @actorUserId,
          resolved_by_membership_id =
            @actorMembershipId,
          resolved_authority = @actorAuthority,
          resolved_at_ms = @occurredAtMs,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @recoveryId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND kind = 'auction_resolution'
        AND status = 'running'
        AND resolved_at_ms IS NULL
        AND version = @expectedVersion
    `);
    succeedOpenRapidJob = database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_expires_at_ms = NULL,
          lease_token = NULL,
          completed_at_ms = @occurredAtMs,
          result_json = @resultJson,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @occurredAtMs,
          version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND job_type = '${JOB_TYPE}'
        AND status IN ('leased', 'running')
        AND lease_owner = @leaseOwner
        AND lease_token = @leaseToken
        AND lease_expires_at_ms > @occurredAtMs
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND next_attempt_at_ms IS NULL
        AND version = @expectedVersion
    `);
    insertResult = database.prepare(`
      INSERT INTO auction_administration_command_results (
        id, league_id, season_id, auction_id,
        bid_id, idempotency_request_id,
        job_run_id, action, actor_user_id,
        actor_membership_id, actor_authority,
        request_sha256, precondition_kind,
        expected_resource_version,
        resulting_resource_version,
        response_http_status, response_json,
        response_sha256, created_at_ms, version
      ) VALUES (
        @resultId, @leagueId, @seasonId,
        @auctionId, @bidId,
        @idempotencyRequestId, @jobRunId,
        @action, @actorUserId,
        @actorMembershipId, @actorAuthority,
        @requestSha256, @preconditionKind,
        @expectedResourceVersion,
        @resultingResourceVersion,
        @responseHttpStatus, @responseJson,
        @responseSha256, @occurredAtMs, 1
      )
    `);
    completeIdempotency = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type =
            '${RESULT_TYPE}',
          result_id = @resultId,
          completed_at_ms = @occurredAtMs
      WHERE id = @idempotencyRequestId
        AND league_id = @leagueId
        AND status = 'started'
    `);

    replayTransaction = database.transaction((input) => {
      const command = validateReplayInput(input);
      requireAuthority(command);
      loadAuction(command);
      return replay(command);
    });
    transaction = database.transaction((input) => {
      const command = validateInput(input);
      const actorAuthority =
        requireAuthority(command);
      const loadedAuction = loadAuction(command);
      const replayed = replay(command);
      if (replayed) {
        return replayed;
      }
      const auction = requireAuction(
        command,
        loadedAuction
      );
      if (command.request.action === "edit_bid") {
        return executeEdit(
          command,
          actorAuthority,
          auction
        );
      }
      if (command.request.action === "remove_bid") {
        return executeRemove(
          command,
          actorAuthority,
          auction
        );
      }
      if (
        command.request.action ===
        "cancel_auction"
      ) {
        return executeCancel(
          command,
          actorAuthority,
          auction
        );
      }
      return executeResolutionRequest(
        command,
        actorAuthority,
        auction
      );
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareAuctionAdministrationRepository",
      tableName:
        "auction_administration_command_results",
    });
  }

  return freeze({
    findReplay(input) {
      try {
        return replayTransaction.immediate(input);
      } catch (error) {
        if (
          error instanceof
            AuctionAdministrationRepositoryError ||
          error instanceof
            AuctionAdministrationPolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "findAuctionAdministrationReplay",
          tableName:
            "auction_administration_command_results",
        });
      }
    },
    administer(input) {
      try {
        return transaction.immediate(input);
      } catch (error) {
        if (
          error instanceof
            AuctionAdministrationRepositoryError ||
          error instanceof
            AuctionAdministrationPolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "administerAuction",
          tableName:
            "auction_administration_command_results",
        });
      }
    },
  });
}

module.exports = {
  AUCTION_ADMINISTRATION_REPOSITORY_CODES,
  AuctionAdministrationRepositoryError,
  JOB_TYPE,
  RESULT_TYPE,
  createSqliteAuctionAdministrationRepository,
};
