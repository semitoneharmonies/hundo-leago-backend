function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const numeric = Number(source?.[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return NaN;
}

function normalizePlayer(source) {
  const id = pickNumber(source, ["id", "playerId", "player_id"]);
  const fullName = pickString(source, [
    "fullName",
    "full_name",
    "name",
    "playerName",
  ]);
  const firstName = pickString(source, [
    "firstName",
    "first_name",
    "first",
  ]);
  const lastName = pickString(source, [
    "lastName",
    "last_name",
    "last",
  ]);
  const position =
    pickString(source, ["position", "pos"]) || null;
  const teamAbbrev =
    pickString(source, [
      "teamAbbrev",
      "team_abbrev",
      "team",
      "teamAbbreviation",
    ]) || null;
  const birthDate =
    pickString(source, [
      "birthDate",
      "birth_date",
      "dob",
      "dateOfBirth",
    ]) || null;
  const activeRaw = source?.active;
  const active = activeRaw === undefined ? true : activeRaw !== false;

  return {
    id,
    fullName,
    firstName,
    lastName,
    position,
    teamAbbrev,
    active,
    birthDate,
  };
}

function normalizePlayers(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter(Boolean)
    .map(normalizePlayer)
    .filter((player) => Number.isFinite(player.id) && player.id > 0);
}

function buildSearchHaystack(player) {
  const fullName =
    player.fullName ||
    `${player.firstName || ""} ${player.lastName || ""}`.trim();
  const firstName = player.firstName || "";
  const lastName = player.lastName || "";
  const lastFirst = `${lastName}, ${firstName}`.trim();

  return normalizeString(
    [fullName, firstName, lastName, lastFirst]
      .filter(Boolean)
      .join(" | ")
  );
}

module.exports = {
  buildSearchHaystack,
  normalizePlayer,
  normalizePlayers,
  normalizeString,
  pickNumber,
  pickString,
};
