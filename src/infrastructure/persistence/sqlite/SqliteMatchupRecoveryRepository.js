const { createHash } = require("node:crypto");

const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A stable identifier is required.");
  }
  return value;
}

function exactKeys(value, keys) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function boundedReason(value) {
  return Boolean(
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 1 &&
    value.length <= 500 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function canonicalRowEvidence(rows, { createdAtMs } = {}) {
  if (!Array.isArray(rows)) return null;
  const tuples = [];
  for (const row of rows) {
    const tuple = [
      row.rowId ?? row.id,
      row.teamId ?? row.team_id,
      row.rank,
      row.wins,
      row.losses,
      row.ties,
      row.standingsPoints ?? row.standings_points,
      row.fantasyPointsForHundredths ??
        row.fantasy_points_for_hundredths,
      row.fantasyPointsAgainstHundredths ??
        row.fantasy_points_against_hundredths,
      row.fantasyPointsDifferentialHundredths ??
        row.fantasy_point_differential_hundredths,
      createdAtMs ?? row.created_at_ms,
    ];
    if (
      !UUID_PATTERN.test(tuple[0] || "") ||
      !UUID_PATTERN.test(tuple[1] || "") ||
      !safeInteger(tuple[2], 1) ||
      !safeInteger(tuple[3]) ||
      !safeInteger(tuple[4]) ||
      !safeInteger(tuple[5]) ||
      !safeInteger(tuple[6]) ||
      !safeInteger(tuple[7]) ||
      !safeInteger(tuple[8]) ||
      !Number.isSafeInteger(tuple[9]) ||
      !safeInteger(tuple[10]) ||
      tuple[6] !== tuple[3] * 2 + tuple[5] ||
      tuple[9] !== tuple[7] - tuple[8]
    ) {
      return null;
    }
    tuples.push(tuple);
  }
  tuples.sort((left, right) =>
    left[1].localeCompare(right[1]) || left[0].localeCompare(right[0])
  );
  const rowIds = tuples.map((row) => row[0]);
  const teamIds = tuples.map((row) => row[1]);
  if (
    new Set(rowIds).size !== rowIds.length ||
    new Set(teamIds).size !== teamIds.length
  ) {
    return null;
  }
  return Object.freeze({
    rowCount: tuples.length,
    teamIds: Object.freeze(teamIds),
    rowsSha256: createHash("sha256")
      .update(JSON.stringify(tuples), "utf8")
      .digest("hex"),
  });
}

function canonicalRebuildMetadata(command, snapshotVersion) {
  const expectedCurrentSnapshotId =
    command.expectedCurrentSnapshotId ?? null;
  if (
    !safeInteger(command.expectedVersion, 1) ||
    (
      expectedCurrentSnapshotId !== null &&
      !UUID_PATTERN.test(expectedCurrentSnapshotId || "")
    ) ||
    !boundedReason(command.reason) ||
    !safeInteger(command.sourceResultVersion) ||
    !safeInteger(snapshotVersion, 1) ||
    !safeInteger(command.nowMs)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "The standings rebuild command metadata is invalid."
    );
  }
  const rows = canonicalRowEvidence(command.rows, {
    createdAtMs: command.nowMs,
  });
  if (!rows) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "The standings rebuild row evidence is invalid."
    );
  }
  const metadata = {
    schemaVersion: 1,
    command: {
      operationId: stableId(command.operationId),
      leagueId: stableId(command.leagueId),
      seasonId: stableId(command.seasonId),
      actorUserId: stableId(command.actorUserId),
      expectedVersion: command.expectedVersion,
      expectedCurrentSnapshotId,
      reason: command.reason,
    },
    result: {
      snapshotId: stableId(command.snapshotId),
      snapshotVersion,
      sourceResultVersion: command.sourceResultVersion,
      rowCount: rows.rowCount,
      teamIds: rows.teamIds,
      rowsSha256: rows.rowsSha256,
    },
  };
  return Object.freeze({
    metadata: Object.freeze(metadata),
    metadataJson: JSON.stringify(metadata),
  });
}

function parseCanonicalRebuildMetadata(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 64_000) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !exactKeys(parsed, ["schemaVersion", "command", "result"]) ||
    parsed.schemaVersion !== 1 ||
    !exactKeys(parsed.command, [
      "operationId",
      "leagueId",
      "seasonId",
      "actorUserId",
      "expectedVersion",
      "expectedCurrentSnapshotId",
      "reason",
    ]) ||
    !exactKeys(parsed.result, [
      "snapshotId",
      "snapshotVersion",
      "sourceResultVersion",
      "rowCount",
      "teamIds",
      "rowsSha256",
    ])
  ) {
    return null;
  }
  const command = parsed.command;
  const result = parsed.result;
  if (
    !UUID_PATTERN.test(command.operationId || "") ||
    !UUID_PATTERN.test(command.leagueId || "") ||
    !UUID_PATTERN.test(command.seasonId || "") ||
    !UUID_PATTERN.test(command.actorUserId || "") ||
    !safeInteger(command.expectedVersion, 1) ||
    (
      command.expectedCurrentSnapshotId !== null &&
      !UUID_PATTERN.test(command.expectedCurrentSnapshotId || "")
    ) ||
    !boundedReason(command.reason) ||
    !UUID_PATTERN.test(result.snapshotId || "") ||
    !safeInteger(result.snapshotVersion, 1) ||
    !safeInteger(result.sourceResultVersion) ||
    !safeInteger(result.rowCount) ||
    !Array.isArray(result.teamIds) ||
    result.teamIds.length !== result.rowCount ||
    result.teamIds.some((teamId) => !UUID_PATTERN.test(teamId || "")) ||
    new Set(result.teamIds).size !== result.teamIds.length ||
    result.teamIds.some(
      (teamId, index) => index > 0 && result.teamIds[index - 1] >= teamId
    ) ||
    typeof result.rowsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.rowsSha256)
  ) {
    return null;
  }
  const canonical = JSON.stringify({
    schemaVersion: 1,
    command: {
      operationId: command.operationId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      actorUserId: command.actorUserId,
      expectedVersion: command.expectedVersion,
      expectedCurrentSnapshotId: command.expectedCurrentSnapshotId,
      reason: command.reason,
    },
    result: {
      snapshotId: result.snapshotId,
      snapshotVersion: result.snapshotVersion,
      sourceResultVersion: result.sourceResultVersion,
      rowCount: result.rowCount,
      teamIds: result.teamIds,
      rowsSha256: result.rowsSha256,
    },
  });
  return canonical === value ? Object.freeze(parsed) : null;
}

function createSqliteMatchupRecoveryRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupRecoveryRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup recovery beforeCommit must be a function");
  }
  const matchupContext = database.prepare(
    "SELECT matchups.*, matchup_weeks.status AS week_status, matchup_weeks.version AS week_version, " +
      "league_memberships.user_id AS commissioner_user_id FROM matchups " +
      "JOIN matchup_weeks ON matchup_weeks.league_id = matchups.league_id " +
      "AND matchup_weeks.id = matchups.matchup_week_id " +
      "JOIN leagues ON leagues.id = matchups.league_id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE matchups.league_id = @leagueId AND matchups.season_id = @seasonId " +
      "AND matchups.matchup_week_id = @weekId AND matchups.id = @matchupId LIMIT 2"
  );
  const seasonContext = database.prepare(
    "SELECT seasons.id AS season_id, league_memberships.user_id AS commissioner_user_id " +
      "FROM seasons JOIN leagues ON leagues.id = seasons.league_id " +
      "LEFT JOIN league_memberships ON league_memberships.id = leagues.commissioner_membership_id " +
      "AND league_memberships.league_id = leagues.id AND league_memberships.status = 'active' " +
      "WHERE seasons.league_id = @leagueId AND seasons.id = @seasonId LIMIT 2"
  );
  const currentSnapshot = database.prepare(
    "SELECT * FROM standings_snapshots WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND status = 'current' LIMIT 2"
  );
  const maximumSnapshotVersion = database.prepare(
    "SELECT COALESCE(MAX(snapshot_version), 0) AS version FROM standings_snapshots " +
      "WHERE league_id = @leagueId AND season_id = @seasonId"
  );
  const standingsFinalizationHistory = database.prepare(
    "SELECT COUNT(*) AS count FROM standings_snapshot_finalizations " +
      "WHERE league_id = @leagueId AND season_id = @seasonId"
  );
  const operationSnapshot = database.prepare(
    "SELECT standings_snapshots.*, " +
      "(SELECT COUNT(*) FROM standings_snapshot_finalizations " +
      "WHERE standings_snapshot_finalizations.league_id = standings_snapshots.league_id " +
      "AND standings_snapshot_finalizations.season_id = standings_snapshots.season_id " +
      "AND standings_snapshot_finalizations.standings_snapshot_id = standings_snapshots.id) " +
      "AS finalization_count FROM standings_snapshots " +
      "WHERE standings_snapshots.league_id = @leagueId " +
      "AND standings_snapshots.season_id = @seasonId " +
      "AND standings_snapshots.id = @snapshotId LIMIT 2"
  );
  const operationSnapshotRows = database.prepare(
    "SELECT * FROM standings_rows WHERE league_id = @leagueId AND season_id = @seasonId " +
      "AND standings_snapshot_id = @snapshotId ORDER BY rank ASC, team_id ASC, id ASC"
  );
  const matchupOperation = database.prepare(
    "SELECT * FROM matchup_operations WHERE id = @operationId LIMIT 2"
  );
  const standingsOperation = database.prepare(
    "SELECT * FROM standings_operations WHERE id = @operationId LIMIT 2"
  );
  const routeMatchup = database.prepare(
    "UPDATE matchups SET status = 'correction_required', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @matchupId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND version = @expectedVersion AND status IN ('awaiting_data', 'final')"
  );
  const routeWeek = database.prepare(
    "UPDATE matchup_weeks SET status = 'correction_required', updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @weekId AND league_id = @leagueId AND season_id = @seasonId " +
      "AND version = @expectedWeekVersion AND status IN ('awaiting_data', 'final')"
  );
  const insertMatchupOperation = database.prepare(
    "INSERT INTO matchup_operations (id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@operationId, @leagueId, @seasonId, @weekId, @matchupId, @actorUserId, " +
      "'matchup_recovery_route', 'succeeded', @reason, @metadataJson, @nowMs, @nowMs)"
  );
  const supersedeSnapshot = database.prepare(
    "UPDATE standings_snapshots SET status = 'superseded' WHERE id = @currentSnapshotId " +
      "AND league_id = @leagueId AND season_id = @seasonId AND status = 'current'"
  );
  const insertSnapshot = database.prepare(
    "INSERT INTO standings_snapshots (id, league_id, season_id, snapshot_version, source_result_version, " +
      "status, calculated_at_ms, created_at_ms) VALUES (@snapshotId, @leagueId, @seasonId, " +
      "@snapshotVersion, @sourceResultVersion, 'current', @nowMs, @nowMs)"
  );
  const insertRow = database.prepare(
    "INSERT INTO standings_rows (id, league_id, season_id, standings_snapshot_id, team_id, rank, wins, losses, " +
      "ties, standings_points, fantasy_points_for_hundredths, fantasy_points_against_hundredths, " +
      "fantasy_point_differential_hundredths, created_at_ms) VALUES (@rowId, @leagueId, @seasonId, " +
      "@snapshotId, @teamId, @rank, @wins, @losses, @ties, @standingsPoints, " +
      "@fantasyPointsForHundredths, @fantasyPointsAgainstHundredths, " +
      "@fantasyPointsDifferentialHundredths, @nowMs)"
  );
  const insertStandingsOperation = database.prepare(
    "INSERT INTO standings_operations (id, league_id, season_id, standings_snapshot_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (@operationId, @leagueId, @seasonId, @snapshotId, @actorUserId, 'rebuild', " +
      "'succeeded', @reason, @metadataJson, @nowMs, @nowMs)"
  );

  function matchupKeys(input) {
    return {
      leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId),
      weekId: stableId(input.weekId), matchupId: stableId(input.matchupId),
    };
  }
  function seasonKeys(input) {
    return { leagueId: stableId(input.leagueId), seasonId: stableId(input.seasonId) };
  }
  function one(rows, message) {
    if (rows.length > 1) throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, message);
    return rows[0] ? Object.freeze({ ...rows[0] }) : null;
  }
  function readMatchupContext(input) {
    try {
      return one(matchupContext.all(matchupKeys(input)), "The matchup recovery context is ambiguous.");
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readMatchupRecoveryContext", tableName: "matchups" });
    }
  }
  function readStandingsContext(input) {
    try {
      const scope = seasonKeys(input);
      const season = one(seasonContext.all(scope), "The standings recovery context is ambiguous.");
      if (!season) return null;
      const current = one(currentSnapshot.all(scope), "The current standings snapshot is ambiguous.");
      return Object.freeze({
        season,
        currentSnapshot: current,
        maximumSnapshotVersion: maximumSnapshotVersion.get(scope).version,
        standingsFinalizationCount: standingsFinalizationHistory.get(scope).count,
      });
    } catch (error) {
      throw mapRepositoryError(error, { operation: "readStandingsRecoveryContext", tableName: "standings_snapshots" });
    }
  }
  function standingsReplayConflict() {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.versionConflict,
      "The standings rebuild replay evidence does not match the original command."
    );
  }
  function readStandingsOperationContext(operation, command) {
    if (!operation || !command) standingsReplayConflict();
    const metadata = parseCanonicalRebuildMetadata(operation.metadata_json);
    const expectedCurrentSnapshotId =
      command.expectedCurrentSnapshotId ?? null;
    if (
      !metadata ||
      operation.status !== "succeeded" ||
      !safeInteger(operation.started_at_ms) ||
      !safeInteger(operation.completed_at_ms) ||
      operation.started_at_ms !== operation.completed_at_ms ||
      operation.id !== metadata.command.operationId ||
      operation.league_id !== metadata.command.leagueId ||
      operation.season_id !== metadata.command.seasonId ||
      operation.actor_user_id !== metadata.command.actorUserId ||
      operation.reason !== metadata.command.reason ||
      operation.standings_snapshot_id !== metadata.result.snapshotId ||
      command.operationId !== metadata.command.operationId ||
      command.leagueId !== metadata.command.leagueId ||
      command.seasonId !== metadata.command.seasonId ||
      command.actorUserId !== metadata.command.actorUserId ||
      command.reason !== metadata.command.reason ||
      command.expectedVersion !== metadata.command.expectedVersion ||
      expectedCurrentSnapshotId !==
        metadata.command.expectedCurrentSnapshotId
    ) {
      standingsReplayConflict();
    }
    const scope = {
      leagueId: operation.league_id,
      seasonId: operation.season_id,
      snapshotId: metadata.result.snapshotId,
    };
    const stored = one(
      operationSnapshot.all(scope),
      "The standings rebuild operation snapshot is ambiguous."
    );
    if (
      !stored ||
      stored.finalization_count !== 0 ||
      !["current", "superseded"].includes(stored.status) ||
      stored.id !== metadata.result.snapshotId ||
      stored.snapshot_version !== metadata.result.snapshotVersion ||
      stored.source_result_version !==
        metadata.result.sourceResultVersion ||
      stored.calculated_at_ms !== operation.completed_at_ms ||
      stored.created_at_ms !== operation.completed_at_ms
    ) {
      standingsReplayConflict();
    }
    const snapshot = { ...stored };
    delete snapshot.finalization_count;
    const rows = operationSnapshotRows.all(scope).map((row) => Object.freeze({ ...row }));
    const rowEvidence = canonicalRowEvidence(rows);
    if (
      !rowEvidence ||
      rowEvidence.rowCount !== metadata.result.rowCount ||
      rowEvidence.rowsSha256 !== metadata.result.rowsSha256 ||
      rowEvidence.teamIds.length !== metadata.result.teamIds.length ||
      rowEvidence.teamIds.some(
        (teamId, index) => teamId !== metadata.result.teamIds[index]
      )
    ) {
      standingsReplayConflict();
    }
    return Object.freeze({
      currentSnapshot: Object.freeze(snapshot),
      maximumSnapshotVersion: metadata.result.snapshotVersion,
      rows: Object.freeze(rows),
    });
  }
  function readRecoveryOperation(statement, input, type) {
    const operationId = stableId(input.operationId);
    const rows = statement.all({ operationId });
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The recovery operation is ambiguous.");
    }
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      row.league_id !== input.leagueId || row.season_id !== input.seasonId ||
      row.actor_user_id !== input.actorUserId || row.operation_type !== type
    ) throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery operation ID is already used.");
    return Object.freeze({ ...row });
  }

  const routeTransaction = database.transaction((command) => {
    const prior = matchupOperation.get({ operationId: command.operationId });
    if (prior) {
      if (prior.league_id !== command.leagueId || prior.matchup_id !== command.matchupId || prior.actor_user_id !== command.actorUserId || prior.operation_type !== "matchup_recovery_route") {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery operation ID is already used.");
      }
      return Object.freeze({ replayed: true, matchup: readMatchupContext(command) });
    }
    const context = readMatchupContext(command);
    if (
      !context ||
      (
        context.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      context.version !== command.expectedVersion || context.week_version !== command.expectedWeekVersion
    ) throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The matchup recovery context changed.");
    if (routeMatchup.run(command).changes !== 1 || routeWeek.run(command).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The recovery transition lost its race.");
    }
    insertMatchupOperation.run({ ...command, metadataJson: JSON.stringify({ fromStatus: context.status, fromWeekStatus: context.week_status }) });
    if (beforeCommit) beforeCommit("matchup");
    return Object.freeze({ replayed: false, matchup: readMatchupContext(command) });
  });

  const rebuildTransaction = database.transaction((command) => {
    const prior = standingsOperation.get({ operationId: command.operationId });
    if (prior) {
      if (prior.league_id !== command.leagueId || prior.season_id !== command.seasonId || prior.actor_user_id !== command.actorUserId || prior.operation_type !== "rebuild") {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The standings operation ID is already used.");
      }
      return Object.freeze({
        replayed: true,
        context: readStandingsOperationContext(prior, command),
      });
    }
    const context = readStandingsContext(command);
    const currentId = context?.currentSnapshot?.id || null;
    const currentVersion =
      context?.currentSnapshot?.snapshot_version || 1;
    if (
      !context ||
      (
        context.season.commissioner_user_id !== command.actorUserId &&
        command.authorizedAsPlatformAdministrator !== true
      ) ||
      currentId !== command.expectedCurrentSnapshotId ||
      currentVersion !== command.expectedVersion
    ) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The standings recovery context changed.");
    }
    if (context.standingsFinalizationCount !== 0) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "Canonical standings history blocks a derived standings rebuild."
      );
    }
    const snapshotVersion = context.maximumSnapshotVersion + 1;
    const metadata = canonicalRebuildMetadata(command, snapshotVersion);
    if (currentId && supersedeSnapshot.run({ ...command, currentSnapshotId: currentId }).changes !== 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The current standings snapshot changed.");
    }
    insertSnapshot.run({ ...command, snapshotVersion });
    for (const row of command.rows) insertRow.run({ ...command, ...row });
    insertStandingsOperation.run({
      ...command,
      metadataJson: metadata.metadataJson,
    });
    if (beforeCommit) beforeCommit("standings");
    const persistedOperation = standingsOperation.get({
      operationId: command.operationId,
    });
    return Object.freeze({
      replayed: false,
      context: readStandingsOperationContext(
        persistedOperation,
        command
      ),
    });
  });

  return Object.freeze({
    readMatchupContext,
    readStandingsContext,
    readMatchupOperation(input) {
      try { return readRecoveryOperation(matchupOperation, { ...input, ...matchupKeys(input) }, "matchup_recovery_route"); }
      catch (error) { throw mapRepositoryError(error, { operation: "readMatchupRecoveryOperation", tableName: "matchup_operations" }); }
    },
    readStandingsOperation(input) {
      try { return readRecoveryOperation(standingsOperation, { ...input, ...seasonKeys(input) }, "rebuild"); }
      catch (error) { throw mapRepositoryError(error, { operation: "readStandingsRecoveryOperation", tableName: "standings_operations" }); }
    },
    routeMatchup(command) {
      try { return routeTransaction.immediate({ ...command, ...matchupKeys(command), operationId: stableId(command.operationId) }); }
      catch (error) { throw mapRepositoryError(error, { operation: "routeMatchupRecovery", tableName: "matchups" }); }
    },
    rebuildStandings(command) {
      try { return rebuildTransaction.immediate({ ...command, ...seasonKeys(command), operationId: stableId(command.operationId) }); }
      catch (error) { throw mapRepositoryError(error, { operation: "rebuildStandings", tableName: "standings_snapshots" }); }
    },
  });
}

module.exports = { createSqliteMatchupRecoveryRepository };
