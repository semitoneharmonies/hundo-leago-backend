const { randomUUID } = require("node:crypto");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROVIDER_PLAYER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

class PlayerCatalogRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlayerCatalogRepositoryError(code, message);
}

function canonicalText(value, field, { nullable = false, maximum = 200 } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail("PLAYER_CATALOG_INPUT_INVALID", `A canonical ${field} is required.`);
  }
  return value;
}

function safeTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail("PLAYER_CATALOG_INPUT_INVALID", `A safe ${field} timestamp is required.`);
  }
  return value;
}

function validateRow(value) {
  const expected = [
    "active",
    "birthDate",
    "firstName",
    "fullName",
    "lastName",
    "nhlTeamAbbreviation",
    "normalizedPosition",
    "providerPlayerId",
    "sourcePosition",
    "sourceUpdatedAtMs",
    "sourceVersion",
    "status",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A complete normalized catalog row is required.");
  }
  if (!PROVIDER_PLAYER_ID_PATTERN.test(value.providerPlayerId)) {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A stable provider player identifier is required.");
  }
  if (!["active", "historical"].includes(value.status)) {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A valid player status is required.");
  }
  if (typeof value.active !== "boolean") {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A provider active flag is required.");
  }
  if (value.birthDate !== null && !ISO_DATE_PATTERN.test(value.birthDate)) {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A valid player birth date is required.");
  }
  if (![null, "F", "D"].includes(value.normalizedPosition)) {
    fail("PLAYER_CATALOG_INPUT_INVALID", "A normalized player position is required.");
  }
  for (const field of ["sourcePosition", "nhlTeamAbbreviation"]) {
    if (value[field] !== null) canonicalText(value[field], field, { maximum: 30 });
  }
  return Object.freeze({
    providerPlayerId: value.providerPlayerId,
    firstName: canonicalText(value.firstName, "first name"),
    lastName: canonicalText(value.lastName, "last name"),
    fullName: canonicalText(value.fullName, "full name"),
    birthDate: value.birthDate,
    status: value.status,
    sourcePosition: value.sourcePosition,
    normalizedPosition: value.normalizedPosition,
    nhlTeamAbbreviation: value.nhlTeamAbbreviation,
    active: value.active,
    sourceVersion: canonicalText(value.sourceVersion, "source version"),
    sourceUpdatedAtMs: safeTimestamp(value.sourceUpdatedAtMs, "source-updated"),
  });
}

function createSqlitePlayerCatalogRepository({
  database,
  createId = randomUUID,
} = {}) {
  if (!database || typeof database.prepare !== "function" || typeof database.transaction !== "function") {
    throw new TypeError("player catalog persistence requires a SQLite database");
  }
  if (typeof createId !== "function") {
    throw new TypeError("player catalog persistence requires an ID factory");
  }

  const findPlayer = database.prepare(
    "SELECT players.* FROM player_external_ids " +
      "JOIN players ON players.id = player_external_ids.player_id " +
      "WHERE player_external_ids.provider = @provider " +
      "AND player_external_ids.external_value = @externalValue LIMIT 2"
  );
  const insertPlayer = database.prepare(
    "INSERT INTO players (id, first_name, last_name, full_name, birth_date, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (@id, @firstName, @lastName, @fullName, @birthDate, @status, @nowMs, @nowMs, 1)"
  );
  const insertExternalId = database.prepare(
    "INSERT INTO player_external_ids (id, player_id, provider, external_value, created_at_ms) " +
      "VALUES (@id, @playerId, @provider, @externalValue, @nowMs)"
  );
  const updatePlayerIfChanged = database.prepare(
    "UPDATE players SET first_name = @firstName, last_name = @lastName, full_name = @fullName, " +
      "birth_date = @birthDate, status = @status, updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @id AND NOT (first_name IS @firstName AND last_name IS @lastName " +
      "AND full_name IS @fullName AND birth_date IS @birthDate AND status IS @status)"
  );
  const findCurrentSource = database.prepare(
    "SELECT * FROM player_source_state WHERE player_id = @playerId " +
      "AND provider = @provider AND ended_at_ms IS NULL LIMIT 2"
  );
  const closeCurrentSource = database.prepare(
    "UPDATE player_source_state SET ended_at_ms = @endedAtMs WHERE id = @id AND ended_at_ms IS NULL"
  );
  const insertSource = database.prepare(
    "INSERT INTO player_source_state (id, player_id, provider, source_position, normalized_position, " +
      "nhl_team_abbreviation, active, source_version, source_payload_json, effective_at_ms, ended_at_ms, created_at_ms) " +
      "VALUES (@id, @playerId, @provider, @sourcePosition, @normalizedPosition, @nhlTeamAbbreviation, " +
      "@active, @sourceVersion, NULL, @effectiveAtMs, NULL, @createdAtMs)"
  );

  function stableId() {
    const id = createId();
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      fail("PLAYER_CATALOG_ID_INVALID", "The player catalog ID factory returned an invalid ID.");
    }
    return id;
  }

  const applyCatalogTransaction = database.transaction((command) => {
    const result = {
      createdPlayerCount: 0,
      sourceStateChangeCount: 0,
      updatedPlayerCount: 0,
    };
    for (const row of command.rows) {
      const matches = findPlayer.all({
        provider: command.provider,
        externalValue: row.providerPlayerId,
      });
      if (matches.length > 1) {
        fail("PLAYER_CATALOG_SCHEMA_INVALID", "A provider player identifier maps to multiple players.");
      }
      let player = matches[0];
      if (!player) {
        const id = stableId();
        insertPlayer.run({ id, ...row, nowMs: command.capturedAtMs });
        insertExternalId.run({
          id: stableId(),
          playerId: id,
          provider: command.provider,
          externalValue: row.providerPlayerId,
          nowMs: command.capturedAtMs,
        });
        player = { id };
        result.createdPlayerCount += 1;
      } else if (updatePlayerIfChanged.run({
        id: player.id,
        ...row,
        nowMs: command.capturedAtMs,
      }).changes === 1) {
        result.updatedPlayerCount += 1;
      }

      const currentStates = findCurrentSource.all({
        playerId: player.id,
        provider: command.provider,
      });
      if (currentStates.length > 1) {
        fail("PLAYER_CATALOG_SCHEMA_INVALID", "A player has multiple current provider source states.");
      }
      const current = currentStates[0] || null;
      const unchanged = current &&
        current.source_position === row.sourcePosition &&
        current.normalized_position === row.normalizedPosition &&
        current.nhl_team_abbreviation === row.nhlTeamAbbreviation &&
        current.active === (row.active ? 1 : 0) &&
        current.source_version === row.sourceVersion;
      if (unchanged) continue;

      const effectiveAtMs = current
        ? Math.max(command.capturedAtMs, current.effective_at_ms + 1)
        : command.capturedAtMs;
      if (current) {
        closeCurrentSource.run({ id: current.id, endedAtMs: effectiveAtMs });
      }
      insertSource.run({
        id: stableId(),
        playerId: player.id,
        provider: command.provider,
        sourcePosition: row.sourcePosition,
        normalizedPosition: row.normalizedPosition,
        nhlTeamAbbreviation: row.nhlTeamAbbreviation,
        active: row.active ? 1 : 0,
        sourceVersion: row.sourceVersion,
        effectiveAtMs,
        createdAtMs: command.capturedAtMs,
      });
      result.sourceStateChangeCount += 1;
    }
    return Object.freeze(result);
  });

  return Object.freeze({
    applyCatalog({ provider, capturedAtMs, rows } = {}) {
      const canonicalProvider = canonicalText(provider, "provider", { maximum: 80 });
      const canonicalCapturedAtMs = safeTimestamp(capturedAtMs, "catalog capture");
      if (!Array.isArray(rows) || rows.length < 1) {
        fail("PLAYER_CATALOG_INPUT_INVALID", "A non-empty player catalog is required.");
      }
      const canonicalRows = rows.map(validateRow);
      const identifiers = new Set(canonicalRows.map(({ providerPlayerId }) => providerPlayerId));
      if (identifiers.size !== canonicalRows.length) {
        fail("PLAYER_CATALOG_INPUT_INVALID", "Provider player identifiers must be unique.");
      }
      return applyCatalogTransaction.immediate({
        provider: canonicalProvider,
        capturedAtMs: canonicalCapturedAtMs,
        rows: canonicalRows,
      });
    },
  });
}

module.exports = {
  PlayerCatalogRepositoryError,
  createSqlitePlayerCatalogRepository,
};
