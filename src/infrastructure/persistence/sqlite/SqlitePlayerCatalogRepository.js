const { createHash, randomUUID } = require("node:crypto");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROVIDER_PLAYER_ID_PATTERN = /^[1-9]\d{0,19}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const CATALOG_EVENT_TYPE = "player_catalog_applied";
const CATALOG_EVENT_FEATURE = "player_data_provider";
const CATALOG_EVENT_REASON = "provider_catalog_import";
const APPLY_INPUT_KEYS = Object.freeze([
  "capturedAtMs",
  "provider",
  "rows",
  "sourceOperationId",
]);

class PlayerCatalogRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlayerCatalogRepositoryError(code, message);
}

function exactObject(value, keys, message) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    fail("PLAYER_CATALOG_INPUT_INVALID", message);
  }
  return value;
}

function canonicalId(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("PLAYER_CATALOG_INPUT_INVALID", `A canonical ${field} is required.`);
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function deterministicUuid(namespace) {
  const hex = createHash("sha256")
    .update(namespace, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function compareProviderPlayerIds(left, right) {
  const lengthDifference =
    left.providerPlayerId.length - right.providerPlayerId.length;
  if (lengthDifference !== 0) return lengthDifference;
  if (left.providerPlayerId < right.providerPlayerId) return -1;
  if (left.providerPlayerId > right.providerPlayerId) return 1;
  return 0;
}

function resolvedPositionGroup(sourceStates) {
  const positions = new Set(
    sourceStates
      .filter((row) => row.active === 1 && ["F", "D"].includes(row.normalized_position))
      .map((row) => row.normalized_position)
  );
  return positions.size === 1 ? [...positions][0] : null;
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

function safeAppliedTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail(
      "PLAYER_CATALOG_CLOCK_INVALID",
      "The player catalog application clock is invalid."
    );
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
  now = Date.now,
} = {}) {
  if (!database || typeof database.prepare !== "function" || typeof database.transaction !== "function") {
    throw new TypeError("player catalog persistence requires a SQLite database");
  }
  if (typeof createId !== "function") {
    throw new TypeError("player catalog persistence requires an ID factory");
  }
  if (typeof now !== "function") {
    throw new TypeError("player catalog persistence requires a clock");
  }

  const findCatalogEvent = database.prepare(
    "SELECT * FROM operational_events WHERE id = @sourceOperationId LIMIT 2"
  );
  const findPlayer = database.prepare(
    "SELECT players.* FROM player_external_ids " +
      "JOIN players ON players.id = player_external_ids.player_id " +
      "WHERE player_external_ids.provider = @provider " +
      "AND player_external_ids.external_value = @externalValue LIMIT 2"
  );
  const findPlayerById = database.prepare(
    "SELECT * FROM players WHERE id = @playerId LIMIT 2"
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
  const listCurrentSources = database.prepare(
    "SELECT id, player_id, provider, normalized_position, active " +
      "FROM player_source_state WHERE player_id = @playerId " +
      "AND ended_at_ms IS NULL ORDER BY provider, id"
  );
  const listAffectedOpenDrafts = database.prepare(`
    SELECT DISTINCT
      fad.league_id AS league_id,
      fad.season_id AS season_id,
      fad.id AS fad_id
    FROM free_agent_drafts AS fad
    JOIN candidate_cards AS card
      ON card.league_id = fad.league_id
     AND card.season_id = fad.season_id
     AND card.fad_id = fad.id
     AND card.status = 'open'
    JOIN candidate_card_entries AS entry
      ON entry.league_id = card.league_id
     AND entry.season_id = card.season_id
     AND entry.fad_id = card.fad_id
     AND entry.card_id = card.id
     AND entry.team_id = card.team_id
     AND entry.player_id = @playerId
    WHERE fad.status = 'cards_open'
    ORDER BY fad.league_id, fad.season_id, fad.id
  `);
  const findCurrentPositionOverride = database.prepare(`
    SELECT id, position_group
    FROM league_player_positions
    WHERE league_id = @leagueId
      AND player_id = @playerId
      AND ended_at_ms IS NULL
    LIMIT 2
  `);
  const insertEligibilityOccurrence = database.prepare(`
    INSERT INTO free_agent_draft_eligibility_revalidation_occurrences (
      id, league_id, season_id, fad_id, player_id,
      source_operation_id, source_provider,
      player_version_before, player_version_after,
      player_status_before, player_status_after,
      source_state_before_id, source_state_after_id,
      source_resolved_position_group_before,
      source_resolved_position_group_after,
      league_position_override_id,
      effective_position_group_before,
      effective_position_group_after,
      eligibility_delta_sha256, job_run_id, occurrence_key,
      scheduled_for_ms, created_at_ms, version
    ) VALUES (
      @occurrenceId, @leagueId, @seasonId, @fadId, @playerId,
      @sourceOperationId, @provider,
      @playerVersionBefore, @playerVersionAfter,
      @playerStatusBefore, @playerStatusAfter,
      @sourceStateBeforeId, @sourceStateAfterId,
      @sourceResolvedPositionGroupBefore,
      @sourceResolvedPositionGroupAfter,
      @leaguePositionOverrideId,
      @effectivePositionGroupBefore,
      @effectivePositionGroupAfter,
      @eligibilityDeltaSha256, @jobRunId, @occurrenceKey,
      @appliedAtMs, @appliedAtMs, 1
    )
  `);
  const insertEligibilityJob = database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count,
      lease_owner, lease_expires_at_ms, started_at_ms,
      completed_at_ms, result_json, last_error_code,
      created_at_ms, updated_at_ms, version,
      lease_token, next_attempt_at_ms
    ) VALUES (
      @jobRunId, @leagueId, @seasonId,
      'fad_eligibility_revalidation', @occurrenceKey,
      @appliedAtMs, 'pending', 0,
      NULL, NULL, NULL,
      NULL, NULL, NULL,
      @appliedAtMs, @appliedAtMs, 1,
      NULL, NULL
    )
  `);
  const insertCatalogEvent = database.prepare(`
    INSERT INTO operational_events (
      id, league_id, season_id, event_type, feature, outcome,
      actor_user_id, reason_code, details_json, occurred_at_ms
    ) VALUES (
      @sourceOperationId, NULL, NULL, '${CATALOG_EVENT_TYPE}',
      '${CATALOG_EVENT_FEATURE}', 'succeeded', NULL,
      '${CATALOG_EVENT_REASON}', @detailsJson, @appliedAtMs
    )
  `);

  function stableId() {
    const id = createId();
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      fail("PLAYER_CATALOG_ID_INVALID", "The player catalog ID factory returned an invalid ID.");
    }
    return id;
  }

  function unique(statement, parameters, message) {
    const rows = statement.all(parameters);
    if (rows.length > 1) {
      fail("PLAYER_CATALOG_SCHEMA_INVALID", message);
    }
    return rows[0] || null;
  }

  function replayResult(event, command) {
    if (
      event.event_type !== CATALOG_EVENT_TYPE ||
      event.league_id !== null ||
      event.season_id !== null
    ) {
      fail(
        "PLAYER_CATALOG_IDEMPOTENCY_CONFLICT",
        "The player catalog source operation conflicts with another operation."
      );
    }
    let details;
    try {
      details = JSON.parse(event.details_json);
    } catch {
      fail(
        "PLAYER_CATALOG_STATE_INVALID",
        "The persisted player catalog operation is invalid."
      );
    }
    if (details?.requestSha256 !== command.requestHash) {
      fail(
        "PLAYER_CATALOG_IDEMPOTENCY_CONFLICT",
        "The player catalog source operation conflicts with another request."
      );
    }
    const expectedKeys = [
      "schemaVersion",
      "code",
      "sourceOperationId",
      "provider",
      "capturedAtMs",
      "appliedAtMs",
      "requestSha256",
      "rowCount",
      "createdPlayerCount",
      "updatedPlayerCount",
      "sourceStateChangeCount",
      "eligibilityChangedPlayerCount",
      "eligibilityRevalidationOccurrenceCount",
    ];
    const counts = [
      details?.createdPlayerCount,
      details?.updatedPlayerCount,
      details?.sourceStateChangeCount,
      details?.eligibilityChangedPlayerCount,
      details?.eligibilityRevalidationOccurrenceCount,
    ];
    if (
      !details ||
      typeof details !== "object" ||
      Array.isArray(details) ||
      Object.keys(details).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(details, key)) ||
      details.schemaVersion !== 1 ||
      details.code !== "PLAYER_CATALOG_APPLIED" ||
      details.sourceOperationId !== command.sourceOperationId ||
      details.provider !== command.provider ||
      details.capturedAtMs !== command.capturedAtMs ||
      details.rowCount !== command.rows.length ||
      details.appliedAtMs !== event.occurred_at_ms ||
      event.feature !== CATALOG_EVENT_FEATURE ||
      event.outcome !== "succeeded" ||
      event.actor_user_id !== null ||
      event.reason_code !== CATALOG_EVENT_REASON ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      fail(
        "PLAYER_CATALOG_STATE_INVALID",
        "The persisted player catalog operation is invalid."
      );
    }
    return deepFreeze({
      sourceOperationId: command.sourceOperationId,
      requestHash: command.requestHash,
      createdPlayerCount: details.createdPlayerCount,
      updatedPlayerCount: details.updatedPlayerCount,
      sourceStateChangeCount: details.sourceStateChangeCount,
      semanticChangedPlayerCount: details.eligibilityChangedPlayerCount,
      revalidationOccurrenceCount:
        details.eligibilityRevalidationOccurrenceCount,
    });
  }

  const applyCatalogTransaction = database.transaction((command) => {
    const priorEvent = unique(
      findCatalogEvent,
      command,
      "A player catalog source operation is not unique."
    );
    if (priorEvent) return replayResult(priorEvent, command);

    const appliedAtMs = safeAppliedTimestamp(now());
    if (appliedAtMs < command.capturedAtMs) {
      fail(
        "PLAYER_CATALOG_CLOCK_INVALID",
        "The player catalog cannot be applied before it was captured."
      );
    }
    const counts = {
      createdPlayerCount: 0,
      sourceStateChangeCount: 0,
      updatedPlayerCount: 0,
    };
    const semanticDeltas = [];
    for (const row of command.rows) {
      const matches = findPlayer.all({
        provider: command.provider,
        externalValue: row.providerPlayerId,
      });
      if (matches.length > 1) {
        fail("PLAYER_CATALOG_SCHEMA_INVALID", "A provider player identifier maps to multiple players.");
      }
      const playerBefore = matches[0] || null;
      let playerId = playerBefore?.id || null;
      const sourcesBefore = playerBefore
        ? listCurrentSources.all({ playerId })
        : [];
      const sourceBefore = playerBefore
        ? unique(
            findCurrentSource,
            { playerId, provider: command.provider },
            "A player has multiple current provider source states."
          )
        : null;
      if (!playerBefore) {
        const id = stableId();
        insertPlayer.run({ id, ...row, nowMs: command.capturedAtMs });
        insertExternalId.run({
          id: stableId(),
          playerId: id,
          provider: command.provider,
          externalValue: row.providerPlayerId,
          nowMs: command.capturedAtMs,
        });
        playerId = id;
        counts.createdPlayerCount += 1;
      } else if (updatePlayerIfChanged.run({
        id: playerId,
        ...row,
        nowMs: command.capturedAtMs,
      }).changes === 1) {
        counts.updatedPlayerCount += 1;
      }

      const sourceUnchanged = sourceBefore &&
        sourceBefore.source_position === row.sourcePosition &&
        sourceBefore.normalized_position === row.normalizedPosition &&
        sourceBefore.nhl_team_abbreviation === row.nhlTeamAbbreviation &&
        sourceBefore.active === (row.active ? 1 : 0) &&
        sourceBefore.source_version === row.sourceVersion;
      if (!sourceUnchanged) {
        const effectiveAtMs = sourceBefore
          ? Math.max(command.capturedAtMs, sourceBefore.effective_at_ms + 1)
          : command.capturedAtMs;
        if (sourceBefore) {
          closeCurrentSource.run({
            id: sourceBefore.id,
            endedAtMs: effectiveAtMs,
          });
        }
        insertSource.run({
          id: stableId(),
          playerId,
          provider: command.provider,
          sourcePosition: row.sourcePosition,
          normalizedPosition: row.normalizedPosition,
          nhlTeamAbbreviation: row.nhlTeamAbbreviation,
          active: row.active ? 1 : 0,
          sourceVersion: row.sourceVersion,
          effectiveAtMs,
          createdAtMs: command.capturedAtMs,
        });
        counts.sourceStateChangeCount += 1;
      }

      const playerAfter = unique(
        findPlayerById,
        { playerId },
        "A player record is not unique."
      );
      const sourcesAfter = listCurrentSources.all({ playerId });
      const sourceAfter = unique(
        findCurrentSource,
        { playerId, provider: command.provider },
        "A player has multiple current provider source states."
      );
      if (!playerAfter || !sourceAfter) {
        fail(
          "PLAYER_CATALOG_SCHEMA_INVALID",
          "The applied player catalog state is unavailable."
        );
      }
      if (playerBefore) {
        const positionBefore = resolvedPositionGroup(sourcesBefore);
        const positionAfter = resolvedPositionGroup(sourcesAfter);
        if (
          playerBefore.status !== playerAfter.status ||
          positionBefore !== positionAfter
        ) {
          semanticDeltas.push(Object.freeze({
            playerId,
            playerVersionBefore: playerBefore.version,
            playerVersionAfter: playerAfter.version,
            playerStatusBefore: playerBefore.status,
            playerStatusAfter: playerAfter.status,
            sourceStateBeforeId: sourceBefore?.id || null,
            sourceStateAfterId: sourceAfter.id,
            sourceResolvedPositionGroupBefore: positionBefore,
            sourceResolvedPositionGroupAfter: positionAfter,
          }));
        }
      }
    }

    let revalidationOccurrenceCount = 0;
    for (const delta of semanticDeltas) {
      const affectedDrafts = listAffectedOpenDrafts.all({
        playerId: delta.playerId,
      });
      for (const draft of affectedDrafts) {
        const positionOverride = unique(
          findCurrentPositionOverride,
          { leagueId: draft.league_id, playerId: delta.playerId },
          "A league player has multiple current position corrections."
        );
        const effectivePositionGroupBefore =
          positionOverride?.position_group ||
          delta.sourceResolvedPositionGroupBefore;
        const effectivePositionGroupAfter =
          positionOverride?.position_group ||
          delta.sourceResolvedPositionGroupAfter;
        if (
          delta.playerStatusBefore === delta.playerStatusAfter &&
          effectivePositionGroupBefore === effectivePositionGroupAfter
        ) {
          continue;
        }
        const identity =
          `${command.sourceOperationId}:${draft.league_id}:` +
          `${draft.season_id}:${draft.fad_id}:${delta.playerId}`;
        const occurrenceId = deterministicUuid(
          `player-catalog-eligibility-occurrence:${identity}`
        );
        const jobRunId = deterministicUuid(
          `player-catalog-eligibility-job:${identity}`
        );
        const occurrenceKey =
          `fad:${draft.fad_id}:eligibility-revalidate:` +
          `${delta.playerId}:${command.sourceOperationId}`;
        const eligibilityEvidence = {
          schemaVersion: 1,
          sourceOperationId: command.sourceOperationId,
          provider: command.provider,
          leagueId: draft.league_id,
          seasonId: draft.season_id,
          fadId: draft.fad_id,
          playerId: delta.playerId,
          player: {
            versionBefore: delta.playerVersionBefore,
            versionAfter: delta.playerVersionAfter,
            statusBefore: delta.playerStatusBefore,
            statusAfter: delta.playerStatusAfter,
          },
          source: {
            stateBeforeId: delta.sourceStateBeforeId,
            stateAfterId: delta.sourceStateAfterId,
            resolvedPositionGroupBefore:
              delta.sourceResolvedPositionGroupBefore,
            resolvedPositionGroupAfter:
              delta.sourceResolvedPositionGroupAfter,
          },
          league: {
            positionOverrideId: positionOverride?.id || null,
            effectivePositionGroupBefore,
            effectivePositionGroupAfter,
          },
        };
        const occurrence = {
          occurrenceId,
          leagueId: draft.league_id,
          seasonId: draft.season_id,
          fadId: draft.fad_id,
          playerId: delta.playerId,
          sourceOperationId: command.sourceOperationId,
          provider: command.provider,
          ...delta,
          leaguePositionOverrideId: positionOverride?.id || null,
          effectivePositionGroupBefore,
          effectivePositionGroupAfter,
          eligibilityDeltaSha256: sha256(eligibilityEvidence),
          jobRunId,
          occurrenceKey,
          appliedAtMs,
        };
        insertEligibilityOccurrence.run(occurrence);
        insertEligibilityJob.run(occurrence);
        revalidationOccurrenceCount += 1;
      }
    }

    const detailsJson = JSON.stringify({
      schemaVersion: 1,
      code: "PLAYER_CATALOG_APPLIED",
      sourceOperationId: command.sourceOperationId,
      provider: command.provider,
      capturedAtMs: command.capturedAtMs,
      appliedAtMs,
      requestSha256: command.requestHash,
      rowCount: command.rows.length,
      createdPlayerCount: counts.createdPlayerCount,
      updatedPlayerCount: counts.updatedPlayerCount,
      sourceStateChangeCount: counts.sourceStateChangeCount,
      eligibilityChangedPlayerCount: semanticDeltas.length,
      eligibilityRevalidationOccurrenceCount:
        revalidationOccurrenceCount,
    });
    insertCatalogEvent.run({
      sourceOperationId: command.sourceOperationId,
      detailsJson,
      appliedAtMs,
    });
    return deepFreeze({
      sourceOperationId: command.sourceOperationId,
      requestHash: command.requestHash,
      createdPlayerCount: counts.createdPlayerCount,
      updatedPlayerCount: counts.updatedPlayerCount,
      sourceStateChangeCount: counts.sourceStateChangeCount,
      semanticChangedPlayerCount: semanticDeltas.length,
      revalidationOccurrenceCount,
    });
  });

  return Object.freeze({
    applyCatalog(input) {
      exactObject(
        input,
        APPLY_INPUT_KEYS,
        "An exact player catalog apply command is required."
      );
      const {
        sourceOperationId,
        provider,
        capturedAtMs,
        rows,
      } = input;
      const canonicalSourceOperationId = canonicalId(
        sourceOperationId,
        "catalog source operation identifier"
      );
      const canonicalProvider = canonicalText(provider, "provider", { maximum: 80 });
      const canonicalCapturedAtMs = safeTimestamp(capturedAtMs, "catalog capture");
      if (!Array.isArray(rows) || rows.length < 1) {
        fail("PLAYER_CATALOG_INPUT_INVALID", "A non-empty player catalog is required.");
      }
      const canonicalRows = rows.map(validateRow).sort(compareProviderPlayerIds);
      const identifiers = new Set(canonicalRows.map(({ providerPlayerId }) => providerPlayerId));
      if (identifiers.size !== canonicalRows.length) {
        fail("PLAYER_CATALOG_INPUT_INVALID", "Provider player identifiers must be unique.");
      }
      const command = {
        sourceOperationId: canonicalSourceOperationId,
        provider: canonicalProvider,
        capturedAtMs: canonicalCapturedAtMs,
        rows: canonicalRows,
      };
      return applyCatalogTransaction.immediate({
        ...command,
        requestHash: sha256({
          schemaVersion: 1,
          provider: command.provider,
          capturedAtMs: command.capturedAtMs,
          rows: command.rows,
        }),
      });
    },
  });
}

module.exports = {
  PlayerCatalogRepositoryError,
  createSqlitePlayerCatalogRepository,
};
