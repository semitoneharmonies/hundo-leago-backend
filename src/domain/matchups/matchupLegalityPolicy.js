const MATCHUP_LEGALITY_CODES = Object.freeze({
  inputInvalid: "MATCHUP_LEGALITY_INPUT_INVALID",
  forwardSlotsIncomplete: "ACTIVE_FORWARD_SLOTS_INCOMPLETE",
  defenceSlotsIncomplete: "ACTIVE_DEFENCE_SLOTS_INCOMPLETE",
});

function exactSlots(players, positionGroup, count) {
  const actual = players
    .filter((player) => player?.position_group === positionGroup)
    .map((player) => player.slot_number)
    .sort((left, right) => left - right);
  const expected = Array.from({ length: count }, (_, index) => index + 1);
  return actual.length === expected.length && actual.every((slot, index) => slot === expected[index]);
}

function evaluateMatchupLineupLegality(activePlayers) {
  if (!Array.isArray(activePlayers)) {
    const error = new TypeError("An authoritative active lineup is required.");
    error.code = MATCHUP_LEGALITY_CODES.inputInvalid;
    throw error;
  }
  const reasons = [];
  if (!exactSlots(activePlayers, "F", 12)) {
    reasons.push(MATCHUP_LEGALITY_CODES.forwardSlotsIncomplete);
  }
  if (!exactSlots(activePlayers, "D", 6)) {
    reasons.push(MATCHUP_LEGALITY_CODES.defenceSlotsIncomplete);
  }
  return Object.freeze({
    legal: reasons.length === 0,
    reasonCodes: Object.freeze(reasons),
    primaryReasonCode: reasons[0] || null,
  });
}

module.exports = { MATCHUP_LEGALITY_CODES, evaluateMatchupLineupLegality };
