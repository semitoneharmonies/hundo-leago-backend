const ACCELERATED_SEASON_CODES = Object.freeze({
  inputInvalid: "ACCELERATED_SEASON_INPUT_INVALID",
});
const EVENT_TYPES = Object.freeze(["baseline", "lock", "end", "rollover"]);

function invalid(message) {
  const error = new TypeError(message);
  error.code = ACCELERATED_SEASON_CODES.inputInvalid;
  throw error;
}

function buildAcceleratedSeasonTimeline(weeks) {
  if (!Array.isArray(weeks) || weeks.length < 1) invalid("At least one persisted matchup week is required.");
  const events = [];
  let previousSequence = 0;
  let previousStart = -1;
  for (const week of weeks) {
    if (
      !week || !Number.isSafeInteger(week.sequence) || week.sequence !== previousSequence + 1 ||
      !Number.isSafeInteger(week.starts_at_ms) || week.starts_at_ms <= previousStart ||
      !Number.isSafeInteger(week.baseline_at_ms) || week.baseline_at_ms < week.starts_at_ms ||
      !Number.isSafeInteger(week.locks_at_ms) || week.locks_at_ms < week.baseline_at_ms ||
      !Number.isSafeInteger(week.ends_at_ms) || week.ends_at_ms <= week.locks_at_ms ||
      !Number.isSafeInteger(week.rolls_over_at_ms) || week.rolls_over_at_ms < week.ends_at_ms ||
      typeof week.id !== "string"
    ) invalid("Persisted matchup weeks must be contiguous and have ordered boundaries.");
    for (const [eventType, simulatedAtMs] of [
      ["baseline", week.baseline_at_ms],
      ["lock", week.locks_at_ms],
      ["end", week.ends_at_ms],
      ["rollover", week.rolls_over_at_ms],
    ]) {
      events.push(Object.freeze({
        eventIndex: events.length,
        eventType,
        weekId: week.id,
        weekSequence: week.sequence,
        simulatedAtMs,
      }));
    }
    previousSequence = week.sequence;
    previousStart = week.starts_at_ms;
  }
  return Object.freeze(events);
}

module.exports = { ACCELERATED_SEASON_CODES, EVENT_TYPES, buildAcceleratedSeasonTimeline };
