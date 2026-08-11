"use strict";

const {
  hashFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionApplyRequest,
  validateFreeAgentDraftCorrectionApplyCommand,
  validateFreeAgentDraftCorrectionApplyResult,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);

const FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1_000;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class FreeAgentDraftAllocationCorrectionServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreeAgentDraftAllocationCorrectionServiceError";
    this.code = "FAD_CORRECTION_RESULT_INVALID";
  }
}

function resultInvalid(message) {
  throw new FreeAgentDraftAllocationCorrectionServiceError(message);
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD allocation correction requires ${description}`
    );
  }
}

function exactInput(value) {
  const fields = [
    "allocationId",
    "authenticated",
    "expectedAllocationVersion",
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
    Object.keys(value).sort().join("|") !== fields.join("|")
  ) {
    const error = new TypeError(
      "The FAD allocation-correction request is invalid."
    );
    error.code = "FAD_ALLOCATION_CORRECTION_INPUT_INVALID";
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
    resultInvalid(
      "Canonical FAD allocation-correction authority is unavailable."
    );
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
    resultInvalid(
      "Canonical FAD allocation-correction authority is unavailable."
    );
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
        FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS
  ) {
    throw new TypeError(
      "FAD allocation correction requires a safe UTC timestamp."
    );
  }
  return nowMs;
}

function secureResultIds(secureRandom) {
  const idempotencyRequestId = secureRandom.id();
  const commandResultId = secureRandom.id();
  if (
    !UUID_V4_PATTERN.test(idempotencyRequestId || "") ||
    !UUID_V4_PATTERN.test(commandResultId || "") ||
    idempotencyRequestId === commandResultId
  ) {
    throw new TypeError(
      "FAD allocation correction requires unique canonical secure identifiers."
    );
  }
  return Object.freeze({
    commandResultId,
    idempotencyRequestId,
  });
}

function validateResult({
  result,
  command,
  completedAtMs,
  allowCommittedRoster = false,
  expectedReplayed = null,
}) {
  const fields = Object.keys(result || {}).sort().join("|");
  const expectedFields = allowCommittedRoster
    ? [
        "committedRoster|data|httpStatus|replayed",
        "data|httpStatus|replayed",
      ]
    : ["data|httpStatus|replayed"];
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getOwnPropertySymbols(result).length !== 0 ||
    !expectedFields.includes(fields) ||
    result.httpStatus !== 200 ||
    typeof result.replayed !== "boolean" ||
    (expectedReplayed !== null &&
      result.replayed !== expectedReplayed) ||
    (allowCommittedRoster &&
      !result.replayed &&
      !Object.prototype.hasOwnProperty.call(
        result,
        "committedRoster"
      )) ||
    (result.replayed &&
      Object.prototype.hasOwnProperty.call(
        result,
        "committedRoster"
      ))
  ) {
    resultInvalid(
      "The FAD allocation-correction result is unavailable."
    );
  }
  let data;
  try {
    data = validateFreeAgentDraftCorrectionApplyResult(result.data);
  } catch {
    resultInvalid(
      "The FAD allocation-correction result is invalid."
    );
  }
  if (
    data.allocation.allocationId !== command.allocationId ||
    data.allocation.allocationVersion !==
      command.expectedAllocationVersion + 1 ||
    data.allocation.decisionCode !== "corrected" ||
    (!result.replayed &&
      data.completedAtMs !== completedAtMs)
  ) {
    resultInvalid(
      "The FAD allocation-correction result does not match its request."
    );
  }
  const publicResult = Object.freeze({
    data,
    httpStatus: 200,
    replayed: result.replayed,
  });
  return Object.freeze({
    publicResult,
    committedRoster:
      !result.replayed &&
      Object.prototype.hasOwnProperty.call(
        result,
        "committedRoster"
      )
        ? validateCommittedRoster(result.committedRoster)
        : null,
  });
}

function validateCommittedRoster(value) {
  if (value === null) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).join("|") !== "teams" ||
    !Array.isArray(value.teams) ||
    value.teams.length < 1
  ) {
    resultInvalid(
      "The committed FAD roster witness is invalid."
    );
  }
  let previousScope = null;
  const globalOwnershipIds = new Set();
  const teams = value.teams.map((team) => {
    if (
      team === null ||
      typeof team !== "object" ||
      Array.isArray(team) ||
      Object.getOwnPropertySymbols(team).length !== 0 ||
      Object.keys(team).sort().join("|") !==
        "leagueId|ownershipWitnesses|seasonId|teamId" ||
      !UUID_PATTERN.test(team.leagueId || "") ||
      !UUID_PATTERN.test(team.seasonId || "") ||
      !UUID_PATTERN.test(team.teamId || "") ||
      !Array.isArray(team.ownershipWitnesses) ||
      team.ownershipWitnesses.length < 1
    ) {
      resultInvalid(
        "The committed FAD roster witness is invalid."
      );
    }
    const scope =
      `${team.leagueId}\u0000${team.seasonId}\u0000` +
      team.teamId;
    if (previousScope !== null && scope <= previousScope) {
      resultInvalid(
        "The committed FAD roster witness is not stably ordered."
      );
    }
    previousScope = scope;
    let previousOwnershipId = null;
    const ownershipWitnesses =
      team.ownershipWitnesses.map((witness) => {
        if (
          witness === null ||
          typeof witness !== "object" ||
          Array.isArray(witness) ||
          Object.getOwnPropertySymbols(witness).length !== 0 ||
          Object.keys(witness).sort().join("|") !==
            "ownershipId|ownershipVersion|state" ||
          !UUID_PATTERN.test(witness.ownershipId || "") ||
          !Number.isSafeInteger(
            witness.ownershipVersion
          ) ||
          witness.ownershipVersion < 1 ||
          !["present", "deleted"].includes(witness.state) ||
          (previousOwnershipId !== null &&
            witness.ownershipId <= previousOwnershipId) ||
          globalOwnershipIds.has(witness.ownershipId)
        ) {
          resultInvalid(
            "The committed FAD roster witness is invalid."
          );
        }
        previousOwnershipId = witness.ownershipId;
        globalOwnershipIds.add(witness.ownershipId);
        return Object.freeze({ ...witness });
      });
    return Object.freeze({
      leagueId: team.leagueId,
      seasonId: team.seasonId,
      teamId: team.teamId,
      ownershipWitnesses:
        Object.freeze(ownershipWitnesses),
    });
  });
  return Object.freeze({ teams: Object.freeze(teams) });
}

function createFreeAgentDraftAllocationCorrectionService({
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
  lateLockCoordinator,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  for (const method of [
    "findAllocationCorrectionReplay",
    "applyAllocationCorrection",
  ]) {
    assertMethod(
      repository,
      method,
      "allocation-correction persistence"
    );
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  assertMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "post-commit late-lock coordination"
  );

  async function apply(value = {}) {
    const input = exactInput(value);
    const command = validateFreeAgentDraftCorrectionApplyCommand({
      allocationId: input.allocationId,
      body: input.input,
      expectedAllocationVersion:
        input.expectedAllocationVersion,
      fadId: input.fadId,
      idempotencyKey: input.idempotencyKey,
      leagueId: input.leagueId,
    });
    const authority = canonicalAuthority(
      leagueAuthorization.requireCommissioner(
        input.authenticated,
        command.leagueId
      )
    );
    const repositoryRequest = Object.freeze({
      actorAuthority: authority.actorAuthority,
      actorMembershipId: authority.actorMembershipId,
      actorUserId: authority.actorUserId,
      allocationId: command.allocationId,
      body: command.body,
      clientKey: command.idempotencyKey,
      expectedAllocationVersion:
        command.expectedAllocationVersion,
      fadId: command.fadId,
      leagueId: command.leagueId,
      requestJson:
        serializeFreeAgentDraftCorrectionApplyRequest(command),
      requestSha256:
        hashFreeAgentDraftCorrectionApplyRequest(command),
    });
    const replay = repository.findAllocationCorrectionReplay(
      repositoryRequest
    );
    if (replay) {
      return validateResult({
        result: replay,
        command,
        completedAtMs: null,
        expectedReplayed: true,
      }).publicResult;
    }
    const completedAtMs = safeNow(clock);
    const ids = secureResultIds(secureRandom);
    const validated = validateResult({
      result: repository.applyAllocationCorrection({
        ...repositoryRequest,
        ...ids,
        completedAtMs,
        idempotencyExpiresAtMs:
          completedAtMs +
          FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
      }),
      command,
      completedAtMs,
      allowCommittedRoster: true,
    });
    if (
      !validated.publicResult.replayed &&
      validated.committedRoster !== null
    ) {
      try {
        await lateLockCoordinator.coordinateCommittedRoster({
          mutationKind: "fad_allocation_correction",
          teams: validated.committedRoster.teams,
        });
      } catch {
        // The correction is already committed.  Late-lock recovery is
        // deliberately best-effort and cannot change the public receipt.
      }
    }
    return validated.publicResult;
  }

  return Object.freeze({ apply });
}

module.exports = {
  FREE_AGENT_DRAFT_ALLOCATION_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
  FreeAgentDraftAllocationCorrectionServiceError,
  createFreeAgentDraftAllocationCorrectionService,
};
