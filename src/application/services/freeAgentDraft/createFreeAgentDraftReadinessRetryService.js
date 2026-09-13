"use strict";

const {
  isDeepStrictEqual,
} = require("node:util");

const {
  FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
  createFreeAgentDraftReadinessRetryRequest,
  validateFreeAgentDraftReadinessRetryReceipt,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);

const FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1_000;
const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;

class FreeAgentDraftReadinessRetryServiceError extends Error {
  constructor(message) {
    super(message);
    this.name =
      "FreeAgentDraftReadinessRetryServiceError";
    this.code = "FAD_READINESS_RESULT_INVALID";
  }
}

function resultInvalid(message) {
  throw new FreeAgentDraftReadinessRetryServiceError(
    message
  );
}

function assertMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `FAD readiness retry requires ${description}`
    );
  }
}

function exactInput(input) {
  const fields = [
    "authenticated",
    "expectedVersion",
    "idempotencyKey",
    "input",
    "leagueId",
  ];
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getOwnPropertySymbols(input).length !== 0 ||
    Object.keys(input).sort().join("|") !==
      fields.sort().join("|")
  ) {
    const error = new TypeError(
      "The FAD readiness-retry request is invalid."
    );
    error.code = "FAD_READINESS_INPUT_INVALID";
    throw error;
  }
  return input;
}

function actor(authority) {
  if (
    !authority ||
    typeof authority.actorUserId !== "string" ||
    typeof authority.membershipId !== "string"
  ) {
    resultInvalid(
      "Canonical FAD readiness-retry authority is unavailable."
    );
  }
  let actorAuthority;
  if (authority.authority === "commissioner") {
    actorAuthority = "commissioner";
  } else if (
    authority.authority ===
      "platform_administrator" ||
    authority.authority ===
      "platform_administrator_as_commissioner"
  ) {
    actorAuthority =
      "platform_administrator_as_commissioner";
  } else {
    resultInvalid(
      "Canonical FAD readiness-retry authority is unavailable."
    );
  }
  return Object.freeze({
    actorAuthority,
    actorMembershipId: authority.membershipId,
    actorUserId: authority.actorUserId,
  });
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs >
      MAXIMUM_TIMESTAMP_MS -
        FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "FAD readiness retry requires a safe UTC timestamp."
    );
  }
  return nowMs;
}

function validateResult({
  result,
  request,
  authority,
  replayed,
}) {
  const fields = [
    "data",
    "evidence",
    "httpStatus",
    "replayed",
  ];
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    Object.keys(result).sort().join("|") !==
      fields.sort().join("|") ||
    result.replayed !== replayed ||
    result.httpStatus !== 202
  ) {
    resultInvalid(
      "The FAD readiness-retry result is unavailable."
    );
  }
  let evidence;
  try {
    const {
      data: evidenceData,
      ...storedEvidence
    } = result.evidence;
    evidence =
      validateFreeAgentDraftReadinessRetryReceipt(
        storedEvidence
      );
    if (
      !isDeepStrictEqual(
        evidenceData,
        evidence.data
      )
    ) {
      resultInvalid(
        "The FAD readiness-retry evidence data is invalid."
      );
    }
  } catch (error) {
    if (
      error instanceof
      FreeAgentDraftReadinessRetryServiceError
    ) {
      throw error;
    }
    resultInvalid(
      "The FAD readiness-retry evidence is invalid.",
      error
    );
  }
  if (
    evidence.leagueId !== request.leagueId ||
    evidence.seasonId !== request.seasonId ||
    evidence.readinessOperationId !==
      request.readinessOperationId ||
    evidence.acceptedFromVersion !==
      request.expectedVersion ||
    evidence.requestSha256 !==
      request.requestSha256 ||
    evidence.actorUserId !==
      authority.actorUserId ||
    evidence.actorMembershipId !==
      authority.actorMembershipId ||
    evidence.actorAuthority !==
      authority.actorAuthority ||
    !isDeepStrictEqual(result.data, evidence.data)
  ) {
    resultInvalid(
      "The FAD readiness-retry result does not match its request."
    );
  }
  return Object.freeze({
    data: evidence.data,
    evidence,
    httpStatus: 202,
    replayed,
  });
}

function createFreeAgentDraftReadinessRetryService({
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
    "findReadinessRetryReplay",
    "requeueReadiness",
  ]) {
    assertMethod(
      repository,
      method,
      "the FAD job repository"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  function retry(input = {}) {
    const command = exactInput(input);
    const authority = actor(
      leagueAuthorization.requireCommissioner(
        command.authenticated,
        command.leagueId
      )
    );
    const request =
      createFreeAgentDraftReadinessRetryRequest({
        actorUserId: authority.actorUserId,
        body: command.input,
        clientKey: command.idempotencyKey,
        expectedVersion:
          command.expectedVersion,
        leagueId: command.leagueId,
      });
    const repositoryRequest = {
      actorMembershipId:
        authority.actorMembershipId,
      actorUserId: authority.actorUserId,
      body: {
        confirmation:
          FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
        readinessOperationId:
          request.readinessOperationId,
        seasonId: request.seasonId,
      },
      clientKey: request.clientKey,
      expectedVersion: request.expectedVersion,
      leagueId: request.leagueId,
    };
    const replay =
      repository.findReadinessRetryReplay(
        repositoryRequest
      );
    if (replay) {
      return validateResult({
        result: replay,
        request,
        authority,
        replayed: true,
      });
    }
    const acceptedAtMs = safeNow(clock);
    const result = repository.requeueReadiness({
      ...repositoryRequest,
      acceptedAtMs,
      idempotencyExpiresAtMs:
        acceptedAtMs +
        FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS,
      idempotencyRequestId: secureRandom.id(),
      retryReceiptId: secureRandom.id(),
    });
    return validateResult({
      result,
      request,
      authority,
      replayed: false,
    });
  }

  return Object.freeze({ retry });
}

module.exports = {
  FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS,
  FreeAgentDraftReadinessRetryServiceError,
  createFreeAgentDraftReadinessRetryService,
};
