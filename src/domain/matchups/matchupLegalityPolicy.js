const MATCHUP_LEGALITY_CODES = Object.freeze({
  inputInvalid: "MATCHUP_LEGALITY_INPUT_INVALID",
  forwardLimitExceeded: "ACTIVE_FORWARD_LIMIT_EXCEEDED",
  defenceLimitExceeded: "ACTIVE_DEFENCE_LIMIT_EXCEEDED",
  positionInvalid: "ACTIVE_POSITION_INVALID",
  playerDuplicate: "ACTIVE_PLAYER_DUPLICATE",
  capIncomplete: "SALARY_CAP_CALCULATION_INCOMPLETE",
  capExceeded: "SALARY_CAP_EXCEEDED",
});

function evaluateMatchupLineupLegality(activePlayers, cap = null) {
  if (!Array.isArray(activePlayers)) {
    const error = new TypeError("An authoritative active lineup is required.");
    error.code = MATCHUP_LEGALITY_CODES.inputInvalid;
    throw error;
  }
  const reasons = [];
  if (cap !== null) {
    if (cap.complete !== true || !Number.isSafeInteger(cap.capUsageCents) || cap.capUsageCents < 0 ||
        !Number.isSafeInteger(cap.capLimitCents) || cap.capLimitCents < 0) reasons.push(MATCHUP_LEGALITY_CODES.capIncomplete);
    else if (cap.capUsageCents > cap.capLimitCents) reasons.push(MATCHUP_LEGALITY_CODES.capExceeded);
  }
  if (activePlayers.some(player => player?.healthy_ir_count > 0)) reasons.push('HEALTHY_PLAYER_ON_IR');
  if (activePlayers.some(player => !player || !["F", "D"].includes(player.position_group))) {
    reasons.push(MATCHUP_LEGALITY_CODES.positionInvalid);
  }
  const ids = activePlayers.map(player => player?.player_id);
  if (ids.some(id => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    reasons.push(MATCHUP_LEGALITY_CODES.playerDuplicate);
  }
  // These are capacity limits. Empty spaces and internal display slots do not
  // determine scoring eligibility (LEAGUE_RULES and MATCHUPS).
  if (activePlayers.filter(player => player?.position_group === "F").length > 12) {
    reasons.push(MATCHUP_LEGALITY_CODES.forwardLimitExceeded);
  }
  if (activePlayers.filter(player => player?.position_group === "D").length > 6) {
    reasons.push(MATCHUP_LEGALITY_CODES.defenceLimitExceeded);
  }
  return Object.freeze({
    legal: reasons.length === 0,
    reasonCodes: Object.freeze(reasons),
    primaryReasonCode: reasons[0] || null,
  });
}

module.exports = { MATCHUP_LEGALITY_CODES, evaluateMatchupLineupLegality };
