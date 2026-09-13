const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function normalizeMatchupExecutionLeagueIds(value = null) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
      value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
      new Set(value).size !== value.length) {
    throw new TypeError("Matchup execution requires one to 100 distinct canonical league IDs, or null for all leagues.");
  }
  return Object.freeze([...value].sort());
}

module.exports = { normalizeMatchupExecutionLeagueIds };
