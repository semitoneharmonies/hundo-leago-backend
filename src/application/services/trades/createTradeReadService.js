const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class TradeReadError extends Error {
  constructor(code) {
    super("The trade proposal could not be read.");
    this.name = "TradeReadError";
    this.code = code;
  }
}

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TradeReadError("TRADE_READ_INPUT_INVALID");
  }
  return value;
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`trade reads require ${description}`);
  }
}

function createTradeReadService({ leagueAuthorization, repository } = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league-member authorization"
  );
  assertMethod(repository, "readDetail", "a read-only trade repository");

  function read({ leagueId, tradeId, authenticated } = {}) {
    const canonicalLeagueId = stableId(leagueId);
    const canonicalTradeId = stableId(tradeId);
    leagueAuthorization.requireActiveMembership(
      authenticated,
      canonicalLeagueId
    );
    const proposal = repository.readDetail({
      leagueId: canonicalLeagueId,
      tradeId: canonicalTradeId,
    });
    if (!proposal) throw new TradeReadError("TRADE_NOT_FOUND");
    return Object.freeze({ code: "TRADE_PROPOSAL_FOUND", proposal });
  }

  return Object.freeze({ read });
}

module.exports = { TradeReadError, createTradeReadService };
