const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../leagues/seasonRolloverEvidencePolicy"
);

const AUCTION_ADMINISTRATION_REQUEST_DOMAIN =
  "hundo-leago.auction-administration-request";
const AUCTION_ADMINISTRATION_SCHEMA_VERSION = 1;
const AUCTION_ADMINISTRATION_RESULT_VERSION = 1;
const FAD_RECOVERY_STATUSES = Object.freeze([
  "pending",
  "ready",
  "running",
  "resolved",
  "correction_required",
]);

const AUCTION_ADMINISTRATION_CODES = Object.freeze({
  actionInvalid: "AUCTION_ADMIN_ACTION_INVALID",
  requestInvalid:
    "AUCTION_ADMINISTRATION_REQUEST_INVALID",
  resultInvalid:
    "AUCTION_ADMINISTRATION_RESULT_INVALID",
});

const AUCTION_ADMINISTRATION_REASON_CODES =
  Object.freeze({
    actionInvalid: "action_invalid",
    auctionIdInvalid: "auction_id_invalid",
    auctionProjectionInvalid:
      "auction_projection_invalid",
    bidIdInvalid: "bid_id_invalid",
    bidIdMustBeNull: "bid_id_must_be_null",
    bidIdRequired: "bid_id_required",
    bodyFieldsInvalid: "body_fields_invalid",
    confirmationInvalid: "confirmation_invalid",
    dataFieldsInvalid: "data_fields_invalid",
    dataInvalid: "data_invalid",
    expectedVersionInvalid:
      "expected_resource_version_invalid",
    idInvalid: "result_id_invalid",
    idempotencyRequestIdInvalid:
      "idempotency_request_id_invalid",
    jobRunIdInvalid: "job_run_id_invalid",
    jobRunIdMustBeNull:
      "job_run_id_must_be_null",
    jobRunIdRequired: "job_run_id_required",
    leagueIdInvalid: "league_id_invalid",
    operationInvalid: "operation_invalid",
    preconditionKindInvalid:
      "precondition_kind_invalid",
    preconditionVersionInvalid:
      "precondition_version_invalid",
    requestFieldsInvalid:
      "request_fields_invalid",
    requestSha256Invalid:
      "request_sha256_invalid",
    responseHttpStatusInvalid:
      "response_http_status_invalid",
    responseJsonInvalid: "response_json_invalid",
    responseSha256Invalid:
      "response_sha256_invalid",
    resultFieldsInvalid: "result_fields_invalid",
    resultVersionInvalid: "result_version_invalid",
    resultingVersionInvalid:
      "resulting_resource_version_invalid",
    seasonIdInvalid: "season_id_invalid",
    teamIdInvalid: "team_id_invalid",
    termYearsInvalid: "term_years_invalid",
    timestampInvalid: "timestamp_invalid",
    totalValueInvalid: "total_value_cents_invalid",
    actorUserIdInvalid: "actor_user_id_invalid",
    actorMembershipIdInvalid:
      "actor_membership_id_invalid",
    actorAuthorityInvalid:
      "actor_authority_invalid",
  });

const ACTION_POLICIES = Object.freeze({
  edit_bid: Object.freeze({
    action: "edit_bid",
    operation: "auction.bid.put",
    preconditionKind: "bid",
    bidLink: "required",
    resultVersionRule: "expected_plus_one",
    httpStatus: 200,
  }),
  remove_bid: Object.freeze({
    action: "remove_bid",
    operation: "auction.bid.remove",
    preconditionKind: "bid",
    bidLink: "required",
    resultVersionRule: "expected_plus_one",
    httpStatus: 200,
  }),
  cancel_auction: Object.freeze({
    action: "cancel_auction",
    operation: "auction.cancel",
    preconditionKind: "auction",
    bidLink: "null",
    resultVersionRule: "greater_than_expected",
    httpStatus: 200,
  }),
  request_resolution: Object.freeze({
    action: "request_resolution",
    operation: "auction.resolve.request",
    preconditionKind: "auction",
    bidLink: "null",
    resultVersionRule: "unchanged",
    httpStatus: 202,
  }),
});

const REQUEST_FIELDS = Object.freeze([
  "action",
  "auctionId",
  "bidId",
  "body",
  "leagueId",
  "preconditionKind",
  "preconditionVersion",
]);
const RESULT_FIELDS = Object.freeze([
  "action",
  "actorAuthority",
  "actorMembershipId",
  "actorUserId",
  "auctionId",
  "bidId",
  "createdAtMs",
  "expectedResourceVersion",
  "id",
  "idempotencyRequestId",
  "jobRunId",
  "leagueId",
  "preconditionKind",
  "requestSha256",
  "responseHttpStatus",
  "responseJson",
  "responseSha256",
  "resultingResourceVersion",
  "seasonId",
  "version",
]);
const EDIT_BODY_FIELDS = Object.freeze([
  "aavCents",
  "teamId",
  "termYears",
]);
const CONFIRMATION_BODY_FIELDS =
  Object.freeze(["confirmation"]);
const AUCTION_FIELDS = Object.freeze([
  "administrativeBids",
  "auctionId",
  "bidCount",
  "capabilities",
  "creationCutoffAtMs",
  "drawCommitment",
  "eligibleTeams",
  "fadId",
  "fadOrigin",
  "fadRolloverId",
  "leagueId",
  "minimumContract",
  "openedAtMs",
  "participatingTeamCount",
  "player",
  "resolvedAtMs",
  "resolvesAtMs",
  "result",
  "seasonId",
  "sourceKind",
  "status",
  "targetRolloverAtMs",
  "updatedAtMs",
  "version",
  "viewerTeams",
]);
const TEAM_FIELDS = Object.freeze([
  "logoReference",
  "name",
  "patternTemplate",
  "primaryColour",
  "secondaryColour",
  "teamId",
  "tertiaryColour",
]);
const PLAYER_FIELDS = Object.freeze([
  "fullName",
  "playerId",
  "positionGroup",
]);
const CAPABILITY_FIELDS = Object.freeze([
  "allowed",
  "reasonCode",
]);
const VIEWER_TEAM_FIELDS = Object.freeze([
  "bid",
  "edit",
  "eligible",
  "join",
  "participantStatus",
  "team",
  "teamId",
]);
const ADMINISTRATIVE_BID_FIELDS = Object.freeze([
  "bidId",
  "capabilities",
  "participantStatus",
  "status",
  "team",
  "teamId",
  "version",
]);
const AUCTION_RESULT_FIELDS = Object.freeze([
  "activityId",
  "contractId",
  "drawEvidence",
  "finalAavCents",
  "finalContractValueCents",
  "outcomeCode",
  "ownershipId",
  "recoveryId",
  "resolvedAtMs",
  "submittedAavCents",
  "submittedTermYears",
  "submittedTotalValueCents",
  "winningTeam",
]);
const T083_DATA_FIELDS = Object.freeze([
  "acceptedAtMs",
  "auctionId",
  "occurrenceKey",
  "operationId",
  "pollDescriptor",
  "status",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const ACTOR_AUTHORITIES = Object.freeze([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const PUBLIC_AUCTION_STATUSES = Object.freeze([
  "active",
  "resolved",
  "no_winner",
  "cancelled",
  "correction_required",
]);
const SOURCE_KINDS = Object.freeze([
  "ordinary_weekly",
  "fad_open_rapid",
  "fad_restricted",
]);
const FAD_ORIGINS = Object.freeze([
  "manager_nomination",
  "queued_nomination",
  "candidate_tie_restricted",
  "restricted_no_improvement_fallback",
]);
const BID_STATUSES = Object.freeze([
  "active",
  "won",
  "lost",
  "withdrawn",
  "invalid",
]);
const PARTICIPANT_STATUSES = Object.freeze([
  "active",
  "removed",
]);
const CAPABILITY_REASON_CODES = Object.freeze([
  "NOT_AUTHORIZED",
  "HELP_NOT_GRANTED",
  "PHASE_CLOSED",
  "DEADLINE_PASSED",
  "LEAGUE_FROZEN",
  "SLOT_LOCKED",
  "SLOT_OCCUPIED",
  "ENTRY_NOT_EDITABLE",
  "PLAYER_INELIGIBLE",
  "TEAM_NOT_PARTICIPANT",
  "COOLDOWN_ACTIVE",
  "EDIT_LIMIT_REACHED",
  "PLAYER_QUARANTINED",
  "RECOVERY_NOT_AVAILABLE",
]);

class AuctionAdministrationPolicyError extends Error {
  constructor(code, reasonCode) {
    super("The auction administration value is invalid.");
    this.name = "AuctionAdministrationPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new AuctionAdministrationPolicyError(
    code,
    reasonCode
  );
}

function failAction() {
  fail(
    AUCTION_ADMINISTRATION_CODES.actionInvalid,
    AUCTION_ADMINISTRATION_REASON_CODES.actionInvalid
  );
}

function failRequest(reasonCode) {
  fail(
    AUCTION_ADMINISTRATION_CODES.requestInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  fail(
    AUCTION_ADMINISTRATION_CODES.resultInvalid,
    reasonCode
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

function hasExactDataFields(value, expectedFields) {
  if (!isPlainObject(value)) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value).sort();
  if (
    names.length !== expectedFields.length ||
    names.some(
      (name, index) => name !== expectedFields[index]
    )
  ) {
    return false;
  }
  return names.every((name) => {
    const descriptor =
      Object.getOwnPropertyDescriptor(value, name);
    return Boolean(
      descriptor &&
        descriptor.enumerable === true &&
        Object.prototype.hasOwnProperty.call(
          descriptor,
          "value"
        )
    );
  });
}

function stableId(value, failWith, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failWith(reasonCode);
  }
  return value;
}

function positiveVersion(value, failWith, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    failWith(reasonCode);
  }
  return value;
}

function safeTimestamp(value, failWith, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP_MS
  ) {
    failWith(reasonCode);
  }
  return value;
}

function nonnegativeInteger(
  value,
  failWith,
  reasonCode
) {
  if (!Number.isSafeInteger(value) || value < 0) {
    failWith(reasonCode);
  }
  return value;
}

function sha256Hex(value, failWith, reasonCode) {
  if (
    typeof value !== "string" ||
    !SHA256_PATTERN.test(value)
  ) {
    failWith(reasonCode);
  }
  return value;
}

function actionPolicy(action, failWith = failAction) {
  if (
    typeof action !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      ACTION_POLICIES,
      action
    )
  ) {
    failWith(
      AUCTION_ADMINISTRATION_REASON_CODES.actionInvalid
    );
  }
  return ACTION_POLICIES[action];
}

function getAuctionAdministrationActionPolicy(action) {
  return actionPolicy(action);
}

function validateOffer(aavCents, termYears) {
  if (
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3
  ) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .termYearsInvalid
    );
  }
  if (
    !Number.isSafeInteger(aavCents) ||
    aavCents < 100 ||
    aavCents % 25 !== 0
  ) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .totalValueInvalid
    );
  }
  const totalValueCents = aavCents * termYears;
  if (!Number.isSafeInteger(totalValueCents)) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .totalValueInvalid
    );
  }
  return Object.freeze({
    totalValueCents,
    termYears,
    aavCents,
  });
}

function validateRequestBody(action, body) {
  if (action === "edit_bid") {
    if (!hasExactDataFields(body, EDIT_BODY_FIELDS)) {
      failRequest(
        AUCTION_ADMINISTRATION_REASON_CODES
          .bodyFieldsInvalid
      );
    }
    const offer = validateOffer(
      body.aavCents,
      body.termYears
    );
    return Object.freeze({
      teamId: stableId(
        body.teamId,
        failRequest,
        AUCTION_ADMINISTRATION_REASON_CODES
          .teamIdInvalid
      ),
      totalValueCents: offer.totalValueCents,
      aavCents: offer.aavCents,
      termYears: offer.termYears,
    });
  }

  if (
    !hasExactDataFields(
      body,
      CONFIRMATION_BODY_FIELDS
    )
  ) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .bodyFieldsInvalid
    );
  }
  const expectedConfirmation = Object.freeze({
    remove_bid: "REMOVE AUCTION BID",
    cancel_auction: "CANCEL AUCTION",
    request_resolution: "RESOLVE AUCTION",
  })[action];
  if (body.confirmation !== expectedConfirmation) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .confirmationInvalid
    );
  }
  return Object.freeze({
    confirmation: expectedConfirmation,
  });
}

function auctionAdministrationRequestProjection(
  input
) {
  if (!hasExactDataFields(input, REQUEST_FIELDS)) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .requestFieldsInvalid
    );
  }
  const policy = actionPolicy(
    input.action,
    failRequest
  );
  const leagueId = stableId(
    input.leagueId,
    failRequest,
    AUCTION_ADMINISTRATION_REASON_CODES
      .leagueIdInvalid
  );
  const auctionId = stableId(
    input.auctionId,
    failRequest,
    AUCTION_ADMINISTRATION_REASON_CODES
      .auctionIdInvalid
  );
  let bidId;
  if (policy.bidLink === "required") {
    if (input.bidId === null) {
      failRequest(
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdRequired
      );
    }
    bidId = stableId(
      input.bidId,
      failRequest,
      AUCTION_ADMINISTRATION_REASON_CODES
        .bidIdInvalid
    );
  } else {
    if (input.bidId !== null) {
      failRequest(
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdMustBeNull
      );
    }
    bidId = null;
  }
  if (
    input.preconditionKind !==
    policy.preconditionKind
  ) {
    failRequest(
      AUCTION_ADMINISTRATION_REASON_CODES
        .preconditionKindInvalid
    );
  }
  const preconditionVersion = positiveVersion(
    input.preconditionVersion,
    failRequest,
    AUCTION_ADMINISTRATION_REASON_CODES
      .preconditionVersionInvalid
  );
  const body = validateRequestBody(
    policy.action,
    input.body
  );
  return Object.freeze({
    domain: AUCTION_ADMINISTRATION_REQUEST_DOMAIN,
    schemaVersion:
      AUCTION_ADMINISTRATION_SCHEMA_VERSION,
    leagueId,
    auctionId,
    bidId,
    action: policy.action,
    preconditionKind: policy.preconditionKind,
    preconditionVersion,
    body,
  });
}

function serializeAuctionAdministrationRequest(input) {
  return serializeCanonicalJsonV1(
    auctionAdministrationRequestProjection(input)
  );
}

function hashAuctionAdministrationRequest(input) {
  return hashCanonicalJsonV1(
    auctionAdministrationRequestProjection(input)
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

function validateCanonicalSafeValue(value, reasonCode) {
  let serialized;
  try {
    serialized = serializeCanonicalJsonV1(value);
  } catch {
    failResult(reasonCode);
  }
  return deepFreeze(JSON.parse(serialized));
}

function validateText(value, reasonCode) {
  if (typeof value !== "string" || value.length < 1) {
    failResult(reasonCode);
  }
  return value;
}

function validateNullableStableId(value, reasonCode) {
  if (value === null) {
    return null;
  }
  return stableId(value, failResult, reasonCode);
}

function validateNullablePositiveInteger(
  value,
  reasonCode
) {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    failResult(reasonCode);
  }
  return value;
}

function validateCapability(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!hasExactDataFields(value, CAPABILITY_FIELDS)) {
    failResult(reason);
  }
  if (typeof value.allowed !== "boolean") {
    failResult(reason);
  }
  if (
    (value.allowed && value.reasonCode !== null) ||
    (!value.allowed &&
      !CAPABILITY_REASON_CODES.includes(
        value.reasonCode
      ))
  ) {
    failResult(reason);
  }
}

function validateTeam(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!hasExactDataFields(value, TEAM_FIELDS)) {
    failResult(reason);
  }
  stableId(value.teamId, failResult, reason);
  for (const field of [
    "name",
    "patternTemplate",
    "primaryColour",
    "secondaryColour",
  ]) {
    validateText(value[field], reason);
  }
  for (const field of [
    "logoReference",
    "tertiaryColour",
  ]) {
    if (
      value[field] !== null &&
      typeof value[field] !== "string"
    ) {
      failResult(reason);
    }
  }
}

function validatePlayer(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!hasExactDataFields(value, PLAYER_FIELDS)) {
    failResult(reason);
  }
  stableId(value.playerId, failResult, reason);
  validateText(value.fullName, reason);
  if (!["F", "D"].includes(value.positionGroup)) {
    failResult(reason);
  }
}

function validateViewerBid(value, isFad) {
  const ordinaryFields = [
    "aavCents",
    "bidId",
    "cooldownEndsAtMs",
    "editCount",
    "editLimit",
    "status",
    "termYears",
    "totalValueCents",
    "version",
  ];
  const fields = isFad
    ? [
        ...ordinaryFields,
        "bindingIllegalityConfirmedAtMs",
      ].sort()
    : ordinaryFields.sort();
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!hasExactDataFields(value, fields)) {
    failResult(reason);
  }
  stableId(value.bidId, failResult, reason);
  positiveVersion(value.version, failResult, reason);
  if (!BID_STATUSES.includes(value.status)) {
    failResult(reason);
  }
  if (
    !Number.isSafeInteger(value.totalValueCents) ||
    value.totalValueCents < 1 ||
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 ||
    value.termYears > 3 ||
    !Number.isSafeInteger(value.aavCents) ||
    value.aavCents < 1
  ) {
    failResult(reason);
  }
  nonnegativeInteger(value.editCount, failResult, reason);
  nonnegativeInteger(value.editLimit, failResult, reason);
  if (value.cooldownEndsAtMs !== null) {
    safeTimestamp(
      value.cooldownEndsAtMs,
      failResult,
      reason
    );
  }
  if (isFad) {
    safeTimestamp(
      value.bindingIllegalityConfirmedAtMs,
      failResult,
      reason
    );
  }
}

function validateViewerTeams(value, isFad) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!Array.isArray(value)) {
    failResult(reason);
  }
  for (const row of value) {
    if (!hasExactDataFields(row, VIEWER_TEAM_FIELDS)) {
      failResult(reason);
    }
    stableId(row.teamId, failResult, reason);
    validateTeam(row.team);
    if (
      row.team.teamId !== row.teamId ||
      typeof row.eligible !== "boolean" ||
      (row.participantStatus !== null &&
        !PARTICIPANT_STATUSES.includes(
          row.participantStatus
        ))
    ) {
      failResult(reason);
    }
    if (row.bid !== null) {
      validateViewerBid(row.bid, isFad);
    }
    validateCapability(row.join);
    validateCapability(row.edit);
  }
}

function validateAdministrativeBids(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (!Array.isArray(value)) {
    failResult(reason);
  }
  for (const row of value) {
    if (
      !hasExactDataFields(
        row,
        ADMINISTRATIVE_BID_FIELDS
      )
    ) {
      failResult(reason);
    }
    stableId(row.bidId, failResult, reason);
    stableId(row.teamId, failResult, reason);
    validateTeam(row.team);
    positiveVersion(row.version, failResult, reason);
    if (
      row.team.teamId !== row.teamId ||
      !BID_STATUSES.includes(row.status) ||
      (row.participantStatus !== null &&
        !PARTICIPANT_STATUSES.includes(
          row.participantStatus
        )) ||
      !hasExactDataFields(row.capabilities, [
        "adminEditBid",
        "adminRemoveBid",
      ])
    ) {
      failResult(reason);
    }
    validateCapability(
      row.capabilities.adminEditBid
    );
    validateCapability(
      row.capabilities.adminRemoveBid
    );
  }
}

function validateMinimumContract(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (
    !hasExactDataFields(value, [
      "aavCents",
      "termYears",
      "totalValueCents",
    ])
  ) {
    failResult(reason);
  }
  if (
    !Number.isSafeInteger(value.totalValueCents) ||
    value.totalValueCents < 1 ||
    !Number.isSafeInteger(value.termYears) ||
    value.termYears < 1 ||
    value.termYears > 3 ||
    !Number.isSafeInteger(value.aavCents) ||
    value.aavCents < 1
  ) {
    failResult(reason);
  }
  const roundedAav =
    Math.floor(value.totalValueCents / value.termYears) +
    ((value.totalValueCents % value.termYears) * 2 >=
    value.termYears
      ? 1
      : 0);
  if (roundedAav !== value.aavCents) {
    failResult(reason);
  }
}

function validateAuctionTerminalResult(value, status) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (
    !hasExactDataFields(value, AUCTION_RESULT_FIELDS)
  ) {
    failResult(reason);
  }
  const outcomeByStatus = Object.freeze({
    resolved: "resolved",
    no_winner: "no_winner",
    cancelled: "cancelled",
    correction_required: "correction_required",
  });
  if (value.outcomeCode !== outcomeByStatus[status]) {
    failResult(reason);
  }
  safeTimestamp(value.resolvedAtMs, failResult, reason);
  const nullableIds = [
    "activityId",
    "contractId",
    "ownershipId",
    "recoveryId",
  ];
  for (const field of nullableIds) {
    validateNullableStableId(value[field], reason);
  }
  for (const field of [
    "finalAavCents",
    "finalContractValueCents",
    "submittedAavCents",
    "submittedTermYears",
    "submittedTotalValueCents",
  ]) {
    validateNullablePositiveInteger(value[field], reason);
  }
  if (value.winningTeam !== null) {
    validateTeam(value.winningTeam);
  }
  if (status === "resolved") {
    if (
      value.winningTeam === null ||
      [
        value.contractId,
        value.ownershipId,
        value.submittedTotalValueCents,
        value.submittedTermYears,
        value.submittedAavCents,
        value.finalContractValueCents,
        value.finalAavCents,
      ].some((item) => item === null)
    ) {
      failResult(reason);
    }
  } else if (
    value.winningTeam !== null ||
    [
      value.contractId,
      value.ownershipId,
      value.submittedTotalValueCents,
      value.submittedTermYears,
      value.submittedAavCents,
      value.finalContractValueCents,
      value.finalAavCents,
    ].some((item) => item !== null)
  ) {
    failResult(reason);
  }
  if (
    status === "correction_required" &&
    value.recoveryId === null
  ) {
    failResult(reason);
  }
  if (
    value.drawEvidence !== null &&
    !isPlainObject(value.drawEvidence)
  ) {
    failResult(reason);
  }
}

function validateAuctionProjection(
  value,
  leagueId,
  auctionId
) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES
      .auctionProjectionInvalid;
  if (!hasExactDataFields(value, AUCTION_FIELDS)) {
    failResult(reason);
  }
  if (
    stableId(value.leagueId, failResult, reason) !==
      leagueId ||
    stableId(value.auctionId, failResult, reason) !==
      auctionId
  ) {
    failResult(reason);
  }
  stableId(value.seasonId, failResult, reason);
  positiveVersion(value.version, failResult, reason);
  validatePlayer(value.player);
  if (!PUBLIC_AUCTION_STATUSES.includes(value.status)) {
    failResult(reason);
  }
  const openedAtMs = safeTimestamp(
    value.openedAtMs,
    failResult,
    reason
  );
  const resolvesAtMs = safeTimestamp(
    value.resolvesAtMs,
    failResult,
    reason
  );
  const updatedAtMs = safeTimestamp(
    value.updatedAtMs,
    failResult,
    reason
  );
  if (
    resolvesAtMs <= openedAtMs ||
    updatedAtMs < openedAtMs
  ) {
    failResult(reason);
  }
  nonnegativeInteger(value.bidCount, failResult, reason);
  nonnegativeInteger(
    value.participatingTeamCount,
    failResult,
    reason
  );
  if (!SOURCE_KINDS.includes(value.sourceKind)) {
    failResult(reason);
  }
  const isFad = value.sourceKind !== "ordinary_weekly";
  if (!Array.isArray(value.eligibleTeams)) {
    failResult(reason);
  }
  for (const team of value.eligibleTeams) {
    validateTeam(team);
  }
  if (value.minimumContract !== null) {
    validateMinimumContract(value.minimumContract);
  }
  if (
    value.drawCommitment !== null &&
    !SHA256_PATTERN.test(value.drawCommitment)
  ) {
    failResult(reason);
  }
  if (!isFad) {
    if (
      value.fadOrigin !== null ||
      value.fadId !== null ||
      value.fadRolloverId !== null ||
      value.targetRolloverAtMs !== null ||
      value.creationCutoffAtMs !== null ||
      value.eligibleTeams.length !== 0 ||
      value.minimumContract !== null ||
      value.drawCommitment !== null
    ) {
      failResult(reason);
    }
  } else {
    if (
      !FAD_ORIGINS.includes(value.fadOrigin)
    ) {
      failResult(reason);
    }
    stableId(value.fadId, failResult, reason);
    stableId(value.fadRolloverId, failResult, reason);
    safeTimestamp(
      value.targetRolloverAtMs,
      failResult,
      reason
    );
    safeTimestamp(
      value.creationCutoffAtMs,
      failResult,
      reason
    );
    if (
      value.status === "active" &&
      value.drawCommitment === null
    ) {
      failResult(reason);
    }
    const minimumExpected =
      value.sourceKind === "fad_restricted" ||
      value.fadOrigin ===
        "restricted_no_improvement_fallback";
    if (
      minimumExpected !==
      (value.minimumContract !== null)
    ) {
      failResult(reason);
    }
    if (
      value.sourceKind === "fad_restricted" &&
      value.fadOrigin !==
        "candidate_tie_restricted"
    ) {
      failResult(reason);
    }
    if (
      value.sourceKind === "fad_open_rapid" &&
      value.fadOrigin ===
        "candidate_tie_restricted"
    ) {
      failResult(reason);
    }
  }
  validateViewerTeams(value.viewerTeams, isFad);
  validateAdministrativeBids(
    value.administrativeBids
  );
  if (
    !hasExactDataFields(value.capabilities, [
      "adminCancel",
      "adminResolve",
      "view",
    ])
  ) {
    failResult(reason);
  }
  validateCapability(value.capabilities.view);
  validateCapability(value.capabilities.adminCancel);
  validateCapability(value.capabilities.adminResolve);
  if (value.status === "active") {
    if (
      value.resolvedAtMs !== null ||
      value.result !== null
    ) {
      failResult(reason);
    }
  } else {
    const resolvedAtMs = safeTimestamp(
      value.resolvedAtMs,
      failResult,
      reason
    );
    validateAuctionTerminalResult(
      value.result,
      value.status
    );
    if (value.result.resolvedAtMs !== resolvedAtMs) {
      failResult(reason);
    }
  }
}

function validateAllocationProjection(value) {
  const reason =
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid;
  if (
    !hasExactDataFields(value, [
      "allocationId",
      "allocationVersion",
      "decisionCode",
      "draws",
      "fallback",
      "player",
      "rankedOffers",
      "recoveryStatus",
      "resolvedAtMs",
      "restricted",
      "status",
      "winner",
    ])
  ) {
    failResult(reason);
  }
  stableId(value.allocationId, failResult, reason);
  positiveVersion(
    value.allocationVersion,
    failResult,
    reason
  );
  validatePlayer(value.player);
  validateText(value.status, reason);
  validateText(value.decisionCode, reason);
  for (const field of [
    "draws",
    "rankedOffers",
  ]) {
    if (!Array.isArray(value[field])) {
      failResult(reason);
    }
  }
  if (value.resolvedAtMs !== null) {
    safeTimestamp(value.resolvedAtMs, failResult, reason);
  }
  for (const field of [
    "fallback",
    "restricted",
    "winner",
  ]) {
    if (
      value[field] !== null &&
      !isPlainObject(value[field])
    ) {
      failResult(reason);
    }
  }
  if (
    value.recoveryStatus !== null &&
    !FAD_RECOVERY_STATUSES.includes(
      value.recoveryStatus
    )
  ) {
    failResult(reason);
  }
}

function validateResponseData(
  action,
  data,
  leagueId,
  auctionId,
  bidId,
  resultingResourceVersion
) {
  if (action === "edit_bid") {
    validateAuctionProjection(
      data,
      leagueId,
      auctionId
    );
    return;
  }
  if (action === "remove_bid") {
    if (
      !hasExactDataFields(data, [
        "auction",
        "fadAllocationVersion",
        "removedBidId",
        "restrictedParticipantStatus",
      ])
    ) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .dataFieldsInvalid
      );
    }
    validateAuctionProjection(
      data.auction,
      leagueId,
      auctionId
    );
    if (
      data.removedBidId !== bidId ||
      (data.restrictedParticipantStatus !== null &&
        !PARTICIPANT_STATUSES.includes(
          data.restrictedParticipantStatus
        ))
    ) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
      );
    }
    if (data.fadAllocationVersion !== null) {
      positiveVersion(
        data.fadAllocationVersion,
        failResult,
        AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
      );
    }
    return;
  }
  if (action === "cancel_auction") {
    if (
      !hasExactDataFields(data, [
        "auction",
        "fadAllocation",
        "recoveryId",
      ])
    ) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .dataFieldsInvalid
      );
    }
    validateAuctionProjection(
      data.auction,
      leagueId,
      auctionId
    );
    if (
      data.auction.status !== "cancelled" &&
      data.auction.status !== "correction_required"
    ) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
      );
    }
    if (
      data.auction.version !==
      resultingResourceVersion
    ) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .resultingVersionInvalid
      );
    }
    if (data.fadAllocation !== null) {
      validateAllocationProjection(data.fadAllocation);
    }
    validateNullableStableId(
      data.recoveryId,
      AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
    );
    return;
  }
  if (
    !hasExactDataFields(data, T083_DATA_FIELDS)
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .dataFieldsInvalid
    );
  }
  stableId(
    data.operationId,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
  );
  if (
    data.auctionId !== auctionId ||
    !["pending", "already_succeeded"].includes(
      data.status
    ) ||
    typeof data.occurrenceKey !== "string" ||
    data.occurrenceKey.length < 1
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
    );
  }
  safeTimestamp(
    data.acceptedAtMs,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
  );
  if (
    !hasExactDataFields(data.pollDescriptor, [
      "auctionId",
      "kind",
      "leagueId",
    ]) ||
    data.pollDescriptor.kind !== "auction" ||
    data.pollDescriptor.leagueId !== leagueId ||
    data.pollDescriptor.auctionId !== auctionId
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
    );
  }
}

function validateResultVersionRule(
  policy,
  expectedResourceVersion,
  resultingResourceVersion
) {
  if (
    (policy.resultVersionRule ===
      "expected_plus_one" &&
      resultingResourceVersion !==
        expectedResourceVersion + 1) ||
    (policy.resultVersionRule ===
      "greater_than_expected" &&
      resultingResourceVersion <=
        expectedResourceVersion) ||
    (policy.resultVersionRule === "unchanged" &&
      resultingResourceVersion !==
        expectedResourceVersion)
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .resultingVersionInvalid
    );
  }
}

function validateAuctionAdministrationStoredResult(
  input
) {
  if (!hasExactDataFields(input, RESULT_FIELDS)) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .resultFieldsInvalid
    );
  }
  const policy = actionPolicy(
    input.action,
    failResult
  );
  const leagueId = stableId(
    input.leagueId,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .leagueIdInvalid
  );
  const auctionId = stableId(
    input.auctionId,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .auctionIdInvalid
  );
  let bidId;
  if (policy.bidLink === "required") {
    if (input.bidId === null) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdRequired
      );
    }
    bidId = stableId(
      input.bidId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .bidIdInvalid
    );
  } else {
    if (input.bidId !== null) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdMustBeNull
      );
    }
    bidId = null;
  }
  if (
    input.preconditionKind !==
    policy.preconditionKind
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .preconditionKindInvalid
    );
  }
  const expectedResourceVersion = positiveVersion(
    input.expectedResourceVersion,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .expectedVersionInvalid
  );
  const resultingResourceVersion = positiveVersion(
    input.resultingResourceVersion,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .resultingVersionInvalid
  );
  validateResultVersionRule(
    policy,
    expectedResourceVersion,
    resultingResourceVersion
  );
  if (input.responseHttpStatus !== policy.httpStatus) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .responseHttpStatusInvalid
    );
  }
  if (
    input.version !==
    AUCTION_ADMINISTRATION_RESULT_VERSION
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .resultVersionInvalid
    );
  }
  let jobRunId;
  if (policy.action === "request_resolution") {
    if (input.jobRunId === null) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .jobRunIdRequired
      );
    }
    jobRunId = stableId(
      input.jobRunId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .jobRunIdInvalid
    );
  } else {
    if (input.jobRunId !== null) {
      failResult(
        AUCTION_ADMINISTRATION_REASON_CODES
          .jobRunIdMustBeNull
      );
    }
    jobRunId = null;
  }
  if (
    !ACTOR_AUTHORITIES.includes(
      input.actorAuthority
    )
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .actorAuthorityInvalid
    );
  }
  const requestSha256 = sha256Hex(
    input.requestSha256,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .requestSha256Invalid
  );
  const responseSha256 = sha256Hex(
    input.responseSha256,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .responseSha256Invalid
  );
  if (typeof input.responseJson !== "string") {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .responseJsonInvalid
    );
  }
  let parsedData;
  try {
    parsedData = JSON.parse(input.responseJson);
  } catch {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .responseJsonInvalid
    );
  }
  const data = validateCanonicalSafeValue(
    parsedData,
    AUCTION_ADMINISTRATION_REASON_CODES
      .responseJsonInvalid
  );
  if (
    serializeCanonicalJsonV1(data) !==
      input.responseJson ||
    hashCanonicalJsonV1(data) !== responseSha256
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES
        .responseSha256Invalid
    );
  }
  validateResponseData(
    policy.action,
    data,
    leagueId,
    auctionId,
    bidId,
    resultingResourceVersion
  );
  const createdAtMs = safeTimestamp(
    input.createdAtMs,
    failResult,
    AUCTION_ADMINISTRATION_REASON_CODES
      .timestampInvalid
  );
  if (
    policy.action === "request_resolution" &&
    data.operationId !== jobRunId
  ) {
    failResult(
      AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
    );
  }
  return Object.freeze({
    id: stableId(
      input.id,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES.idInvalid
    ),
    leagueId,
    seasonId: stableId(
      input.seasonId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .seasonIdInvalid
    ),
    auctionId,
    bidId,
    idempotencyRequestId: stableId(
      input.idempotencyRequestId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .idempotencyRequestIdInvalid
    ),
    jobRunId,
    action: policy.action,
    operation: policy.operation,
    actorUserId: stableId(
      input.actorUserId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .actorUserIdInvalid
    ),
    actorMembershipId: stableId(
      input.actorMembershipId,
      failResult,
      AUCTION_ADMINISTRATION_REASON_CODES
        .actorMembershipIdInvalid
    ),
    actorAuthority: input.actorAuthority,
    requestSha256,
    preconditionKind: policy.preconditionKind,
    expectedResourceVersion,
    resultingResourceVersion,
    responseHttpStatus: policy.httpStatus,
    responseJson: input.responseJson,
    responseSha256,
    data,
    createdAtMs,
    version: AUCTION_ADMINISTRATION_RESULT_VERSION,
  });
}

module.exports = {
  ACTION_POLICIES,
  AUCTION_ADMINISTRATION_CODES,
  AUCTION_ADMINISTRATION_REASON_CODES,
  AUCTION_ADMINISTRATION_REQUEST_DOMAIN,
  AUCTION_ADMINISTRATION_RESULT_VERSION,
  AUCTION_ADMINISTRATION_SCHEMA_VERSION,
  AuctionAdministrationPolicyError,
  RESULT_FIELDS,
  REQUEST_FIELDS,
  getAuctionAdministrationActionPolicy,
  auctionAdministrationRequestProjection,
  hashAuctionAdministrationRequest,
  serializeAuctionAdministrationRequest,
  validateAuctionAdministrationStoredResult,
};
