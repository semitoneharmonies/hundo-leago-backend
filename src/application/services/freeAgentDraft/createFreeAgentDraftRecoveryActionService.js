"use strict";

const {
  hashFreeAgentDraftRecoveryActionRequest,
  normalizeFreeAgentDraftRecoveryActionBody,
  projectFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryActionRequest,
  validateFreeAgentDraftRecoveryIdempotencyKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);

const FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1_000;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;

class FreeAgentDraftRecoveryActionServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreeAgentDraftRecoveryActionServiceError";
    this.code = "FAD_RECOVERY_RESULT_INVALID";
  }
}

function resultInvalid(message) {
  throw new FreeAgentDraftRecoveryActionServiceError(message);
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD recovery action requires ${description}`
    );
  }
}

function exactInput(value) {
  const expected = [
    "authenticated",
    "fadId",
    "idempotencyKey",
    "input",
    "leagueId",
  ].sort();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).sort().join("|") !== expected.join("|")
  ) {
    const error = new TypeError(
      "The FAD recovery-action request is invalid."
    );
    error.code = "FAD_RECOVERY_INPUT_INVALID";
    throw error;
  }
  return value;
}

function canonicalAuthority(value) {
  if (
    !value ||
    typeof value.actorUserId !== "string" ||
    typeof value.membershipId !== "string"
  ) {
    resultInvalid("Canonical FAD recovery authority is unavailable.");
  }
  let actorAuthority;
  if (value.authority === "commissioner") {
    actorAuthority = "commissioner";
  } else if (
    value.authority === "platform_administrator" ||
    value.authority === "platform_administrator_as_commissioner"
  ) {
    actorAuthority = "platform_administrator_as_commissioner";
  } else {
    resultInvalid("Canonical FAD recovery authority is unavailable.");
  }
  return Object.freeze({
    actorAuthority,
    actorMembershipId: value.membershipId,
    actorUserId: value.actorUserId,
  });
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs >
      MAXIMUM_TIMESTAMP_MS -
        FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "FAD recovery action requires a safe UTC timestamp."
    );
  }
  return nowMs;
}

function validateResult({ result, request, replayed, acceptedAtMs }) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    Object.keys(result).sort().join("|") !==
      "data|httpStatus|replayed" ||
    result.httpStatus !== 202 ||
    result.replayed !== replayed
  ) {
    resultInvalid("The FAD recovery-action result is unavailable.");
  }
  let data;
  try {
    data = projectFreeAgentDraftRecoveryAcceptedOperation(result.data);
  } catch {
    resultInvalid("The FAD recovery-action result is invalid.");
  }
  if (
    data.action !== request.body.action ||
    data.resourceId !== request.body.resourceId ||
    data.pollDescriptor.leagueId !== request.leagueId ||
    data.pollDescriptor.fadId !== request.fadId ||
    (!replayed && data.acceptedAtMs !== acceptedAtMs)
  ) {
    resultInvalid(
      "The FAD recovery-action result does not match its request."
    );
  }
  return Object.freeze({
    data,
    httpStatus: 202,
    replayed,
  });
}

function createFreeAgentDraftRecoveryActionService({
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  for (const method of [
    "findRecoveryActionReplay",
    "acceptRecoveryAction",
  ]) {
    assertMethod(repository, method, "recovery-action persistence");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");

  function accept(value = {}) {
    const command = exactInput(value);
    const request = Object.freeze({
      body: normalizeFreeAgentDraftRecoveryActionBody(command.input),
      fadId: command.fadId,
      leagueId: command.leagueId,
    });
    const clientKey =
      validateFreeAgentDraftRecoveryIdempotencyKey(
        command.idempotencyKey
      );
    const authority = canonicalAuthority(
      leagueAuthorization.requireCommissioner(
        command.authenticated,
        request.leagueId
      )
    );
    const repositoryRequest = Object.freeze({
      actorAuthority: authority.actorAuthority,
      actorMembershipId: authority.actorMembershipId,
      actorUserId: authority.actorUserId,
      body: request.body,
      clientKey,
      fadId: request.fadId,
      leagueId: request.leagueId,
      requestJson:
        serializeFreeAgentDraftRecoveryActionRequest(request),
      requestSha256:
        hashFreeAgentDraftRecoveryActionRequest(request),
    });
    const replay = repository.findRecoveryActionReplay(
      repositoryRequest
    );
    if (replay) {
      return validateResult({
        result: replay,
        request,
        replayed: true,
        acceptedAtMs: null,
      });
    }
    const acceptedAtMs = safeNow(clock);
    const result = repository.acceptRecoveryAction({
      ...repositoryRequest,
      acceptedAtMs,
      commandResultId: secureRandom.id(),
      idempotencyExpiresAtMs:
        acceptedAtMs +
        FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS,
      idempotencyRequestId: secureRandom.id(),
    });
    return validateResult({
      result,
      request,
      replayed: false,
      acceptedAtMs,
    });
  }

  return Object.freeze({ accept });
}

module.exports = {
  FREE_AGENT_DRAFT_RECOVERY_ACTION_IDEMPOTENCY_LIFETIME_MS,
  FreeAgentDraftRecoveryActionServiceError,
  createFreeAgentDraftRecoveryActionService,
};
