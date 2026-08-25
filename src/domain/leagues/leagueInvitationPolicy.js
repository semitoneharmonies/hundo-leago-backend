const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_TEAM_NAME_CODE_POINTS = 35;
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 128;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WORKFLOWS = Object.freeze([
  "create_team",
  "manage_team",
]);

class LeagueInvitationPolicyError extends Error {
  constructor(reasonCode) {
    super("The league-invitation request is invalid.");
    this.name = "LeagueInvitationPolicyError";
    this.code = "LEAGUE_INVITATION_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new LeagueInvitationPolicyError(reasonCode);
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
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expectedKeys, reasonCode) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expectedKeys.includes(key))
  ) {
    fail(reasonCode);
  }
  return value;
}

function validateStableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("stable_id_invalid");
  }
  return value;
}

function validateIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail("idempotency_key_invalid");
  }
  return value;
}

function validateInvitationInput(input) {
  if (!isPlainObject(input) || !WORKFLOWS.includes(input.workflow)) {
    fail("invitation_input_invalid");
  }
  if (input.workflow === "create_team") {
    exactKeys(
      input,
      ["userId", "workflow"],
      "invitation_input_invalid"
    );
    return Object.freeze({
      userId: validateStableId(input.userId),
      workflow: input.workflow,
      teamId: null,
    });
  }
  exactKeys(
    input,
    ["userId", "workflow", "teamId"],
    "invitation_input_invalid"
  );
  return Object.freeze({
    userId: validateStableId(input.userId),
    workflow: input.workflow,
    teamId: validateStableId(input.teamId),
  });
}

function validateTeamName(value) {
  if (typeof value !== "string") {
    fail("team_name_invalid");
  }
  const teamName = value.trim();
  const teamNameNormalized = teamName.toLowerCase();
  if (
    teamName.length < 1 ||
    Array.from(teamName).length > MAXIMUM_TEAM_NAME_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(teamName) ||
    teamNameNormalized.length > 120
  ) {
    fail("team_name_invalid");
  }
  return Object.freeze({ teamName, teamNameNormalized });
}

function validateAcceptanceInput(input, workflow) {
  if (workflow === "create_team") {
    exactKeys(input, ["teamName"], "acceptance_input_invalid");
    return validateTeamName(input.teamName);
  }
  if (workflow === "manage_team") {
    exactKeys(input, [], "acceptance_input_invalid");
    return Object.freeze({
      teamName: null,
      teamNameNormalized: null,
    });
  }
  fail("invitation_workflow_invalid");
}

function validateDeclineInput(input) {
  exactKeys(input, [], "decline_input_invalid");
  return Object.freeze({});
}

module.exports = {
  FORBIDDEN_TEXT_PATTERN,
  LeagueInvitationPolicyError,
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MAXIMUM_TEAM_NAME_CODE_POINTS,
  UUID_PATTERN,
  WORKFLOWS,
  validateAcceptanceInput,
  validateDeclineInput,
  validateIdempotencyKey,
  validateInvitationInput,
  validateStableId,
  validateTeamName,
};
