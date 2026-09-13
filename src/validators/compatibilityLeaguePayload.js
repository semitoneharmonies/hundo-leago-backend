class CompatibilityLeagueValidationError extends Error {
  constructor(message, {
    code,
    statusCode,
  }) {
    super(message);
    this.name =
      "CompatibilityLeagueValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isPlainObject(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function looksLikeWipe(
  storedState,
  incomingTeams
) {
  const storedTeams = Array.isArray(
    storedState?.teams
  )
    ? storedState.teams
    : [];
  const nextTeams = Array.isArray(incomingTeams)
    ? incomingTeams
    : [];
  return (
    storedTeams.length > 0 &&
    nextTeams.length === 0
  );
}

function isManagerWriteBlockedByFreeze(
  storedState,
  meta
) {
  if (!Boolean(storedState?.settings?.frozen)) {
    return false;
  }
  const role = String(
    meta?.actorRole || ""
  ).toLowerCase();
  return role !== "commissioner";
}

function validateCompatibilityLeaguePayload({
  storedState,
  body = {},
} = {}) {
  const meta = body.meta || {};

  if (
    isManagerWriteBlockedByFreeze(
      storedState,
      meta
    )
  ) {
    throw new CompatibilityLeagueValidationError(
      "League is frozen. Manager writes are blocked.",
      {
        code: "LEAGUE_FROZEN",
        statusCode: 423,
      }
    );
  }

  if (looksLikeWipe(storedState, body.teams)) {
    throw new CompatibilityLeagueValidationError(
      "Refusing save: incoming teams is empty (wipe protection).",
      {
        code: "WIPE_PROTECTION",
        statusCode: 400,
      }
    );
  }

  if (
    !Array.isArray(body.teams) ||
    !Array.isArray(body.freeAgents) ||
    !Array.isArray(body.leagueLog) ||
    !Array.isArray(body.tradeProposals) ||
    !Array.isArray(body.tradeBlock)
  ) {
    throw new CompatibilityLeagueValidationError(
      "Refusing save: invalid payload shape (arrays expected).",
      {
        code: "INVALID_ARRAYS",
        statusCode: 400,
      }
    );
  }

  if (
    body.matchups !== undefined &&
    !isPlainObject(body.matchups)
  ) {
    throw new CompatibilityLeagueValidationError(
      "Refusing save: matchups must be an object if provided.",
      {
        code: "INVALID_MATCHUPS",
        statusCode: 400,
      }
    );
  }

  return {
    body,
    meta,
    role: String(
      meta?.actorRole || ""
    ).toLowerCase(),
  };
}

module.exports = {
  CompatibilityLeagueValidationError,
  isManagerWriteBlockedByFreeze,
  isPlainObject,
  looksLikeWipe,
  validateCompatibilityLeaguePayload,
};
