"use strict";

const {
  FREE_AGENT_DRAFT_CORRECTION_CODES,
  validateFreeAgentDraftCorrectionPreview,
  validateFreeAgentDraftCorrectionPreviewCommand,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);

class FreeAgentDraftCorrectionPreviewServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreeAgentDraftCorrectionPreviewServiceError";
    this.code = "FAD_CORRECTION_RESULT_INVALID";
  }
}

function resultInvalid(message) {
  throw new FreeAgentDraftCorrectionPreviewServiceError(message);
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `FAD allocation-correction preview requires ${description}`
    );
  }
}

function exactInput(value) {
  const fields = [
    "allocationId",
    "authenticated",
    "fadId",
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
      "The FAD allocation-correction preview request is invalid."
    );
    error.code = FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid;
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

function canonicalPreview(command, value) {
  let preview;
  try {
    preview = validateFreeAgentDraftCorrectionPreview({
      leagueId: command.leagueId,
      fadId: command.fadId,
      preview: value,
    });
  } catch {
    resultInvalid(
      "The FAD allocation-correction preview is unavailable."
    );
  }
  if (preview.allocationId !== command.allocationId) {
    resultInvalid(
      "The FAD allocation-correction preview does not match its request."
    );
  }
  return preview;
}

function createFreeAgentDraftCorrectionPreviewService({
  leagueAuthorization,
  repository,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  assertMethod(
    repository,
    "previewAllocationCorrection",
    "read-only correction-preview persistence"
  );

  function preview(value = {}) {
    const input = exactInput(value);
    const command = validateFreeAgentDraftCorrectionPreviewCommand({
      allocationId: input.allocationId,
      body: input.input,
      fadId: input.fadId,
      leagueId: input.leagueId,
    });
    const authority = canonicalAuthority(
      leagueAuthorization.requireCommissioner(
        input.authenticated,
        command.leagueId
      )
    );
    return canonicalPreview(
      command,
      repository.previewAllocationCorrection({
        actorAuthority: authority.actorAuthority,
        actorMembershipId: authority.actorMembershipId,
        actorUserId: authority.actorUserId,
        allocationId: command.allocationId,
        fadId: command.fadId,
        leagueId: command.leagueId,
        mode: command.body.mode,
      })
    );
  }

  return Object.freeze({ preview });
}

module.exports = {
  FreeAgentDraftCorrectionPreviewServiceError,
  createFreeAgentDraftCorrectionPreviewService,
};
