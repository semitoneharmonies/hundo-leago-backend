"use strict";

const {
  projectFreeAgentDraftRecoveryRead,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftRecoveryReadPolicy"
);

const MAXIMUM_TIMESTAMP_MS =
  8_640_000_000_000_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message) {
  const error = new TypeError(message);
  error.code = "FAD_RECOVERY_READ_INPUT_INVALID";
  throw error;
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD recovery reads require ${description}`
    );
  }
}

function exactObject(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value)
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    invalid(
      "An exact FAD recovery-read request is required."
    );
  }
  const actual = Object.getOwnPropertyNames(value)
    .sort()
    .join("|");
  if (actual !== [...keys].sort().join("|")) {
    invalid(
      "An exact FAD recovery-read request is required."
    );
  }
  for (const key of keys) {
    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value"
      )
    ) {
      invalid(
        "An exact FAD recovery-read request is required."
      );
    }
  }
  return value;
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_V4_PATTERN.test(value)
  ) {
    invalid(
      "A canonical FAD recovery-read identifier is required."
    );
  }
  return value;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAXIMUM_TIMESTAMP_MS
  ) {
    throw new TypeError(
      "FAD recovery reads require a safe UTC timestamp."
    );
  }
  return nowMs;
}

function authorizedViewer(authority) {
  if (
    !authority ||
    !UUID_V4_PATTERN.test(
      authority.actorUserId || ""
    ) ||
    !UUID_V4_PATTERN.test(
      authority.membershipId || ""
    ) ||
    ![
      "commissioner",
      "platform_administrator",
      "platform_administrator_as_commissioner",
    ].includes(authority.authority)
  ) {
    throw new TypeError(
      "FAD recovery reads require canonical commissioner authority."
    );
  }
  return Object.freeze({
    viewerUserId: authority.actorUserId,
    viewerMembershipId: authority.membershipId,
    viewerAuthority:
      authority.authority === "commissioner"
        ? "commissioner"
        : "platform_administrator_as_commissioner",
  });
}

function createFreeAgentDraftRecoveryReadService({
  leagueAuthorization,
  repository,
  clock,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  assertMethod(
    repository,
    "readRecovery",
    "the canonical FAD recovery-read repository"
  );
  assertMethod(clock, "nowMs", "a clock");

  function recovery(input = {}) {
    const command = exactObject(input, [
      "authenticated",
      "leagueId",
      "fadId",
    ]);
    const leagueId = stableId(command.leagueId);
    const fadId = stableId(command.fadId);
    const viewer = authorizedViewer(
      leagueAuthorization.requireCommissioner(
        command.authenticated,
        leagueId
      )
    );
    const result = repository.readRecovery({
      leagueId,
      fadId,
      ...viewer,
      nowMs: safeNow(clock),
    });
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      typeof result.then === "function"
    ) {
      throw new TypeError(
        "The canonical FAD recovery-read projection is unavailable."
      );
    }
    return projectFreeAgentDraftRecoveryRead(result);
  }

  return Object.freeze({ recovery });
}

module.exports = {
  createFreeAgentDraftRecoveryReadService,
};
