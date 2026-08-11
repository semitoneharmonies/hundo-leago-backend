const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COMMITTED_TEAM_KEYS = Object.freeze([
  "leagueId",
  "ownershipWitnesses",
  "seasonId",
  "teamId",
]);
const OWNERSHIP_WITNESS_KEYS = Object.freeze([
  "ownershipId",
  "ownershipVersion",
  "state",
]);

function failInput(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function failWitness(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message
  );
}

function plainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value)
  );
}

function exactObject(value, expectedKeys, description) {
  if (!plainObject(value)) {
    failInput(`An exact ${description} object is required.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys
      .slice()
      .sort()
      .some((key, index) => key !== expectedKeys[index])
  ) {
    failInput(`The ${description} keys are invalid.`);
  }
  return value;
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    failInput(`A canonical ${description} identifier is required.`);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    failInput("A safe late-lock evaluation instant is required.");
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failInput("A positive committed ownership version is required.");
  }
  return value;
}

function normalizeWitnesses(value) {
  if (!Array.isArray(value)) {
    failInput("A canonical committed ownership-witness array is required.");
  }
  let previousOwnershipId = null;
  const witnesses = value.map((candidate) => {
    const witness = exactObject(
      candidate,
      OWNERSHIP_WITNESS_KEYS,
      "ownership witness"
    );
    const ownershipId = stableId(
      witness.ownershipId,
      "ownership witness"
    );
    if (
      previousOwnershipId !== null &&
      ownershipId <= previousOwnershipId
    ) {
      failInput(
        "Ownership witnesses must be unique and ordered by stable identifier."
      );
    }
    if (!["present", "deleted"].includes(witness.state)) {
      failInput("An ownership witness state is invalid.");
    }
    previousOwnershipId = ownershipId;
    return Object.freeze({
      ownershipId,
      ownershipVersion: positiveVersion(
        witness.ownershipVersion
      ),
      state: witness.state,
    });
  });
  return Object.freeze(witnesses);
}

function normalizeCommittedTeam(value) {
  const team = exactObject(
    value,
    COMMITTED_TEAM_KEYS,
    "committed team"
  );
  return Object.freeze({
    leagueId: stableId(team.leagueId, "league"),
    seasonId: stableId(team.seasonId, "season"),
    teamId: stableId(team.teamId, "team"),
    ownershipWitnesses: normalizeWitnesses(
      team.ownershipWitnesses
    ),
  });
}

function freezeTargets(rows, { singleTeam = false } = {}) {
  if (singleTeam && rows.length > 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A team has multiple eligible late-lock targets."
    );
  }
  const identities = new Set();
  const targets = rows.map((row) => {
    const identity =
      `${row.league_id}\u0000${row.season_id}\u0000` +
      `${row.matchup_week_id}\u0000${row.team_id}`;
    if (identities.has(identity)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A team has multiple eligible late-lock targets."
      );
    }
    identities.add(identity);
    return Object.freeze({
      leagueId: row.league_id,
      seasonId: row.season_id,
      weekId: row.matchup_week_id,
      teamId: row.team_id,
      lockId: row.lock_id,
    });
  });
  return Object.freeze(targets);
}

function createSqliteLateLockCoordinatorRepository({ database } = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteLateLockCoordinatorRepository requires a database"
    );
  }

  const commonSelection =
    "SELECT locks.league_id, locks.season_id, " +
    "locks.matchup_week_id, locks.team_id, locks.id AS lock_id " +
    "FROM matchup_roster_locks AS locks " +
    "JOIN matchup_weeks AS weeks " +
    "ON weeks.league_id = locks.league_id " +
    "AND weeks.season_id = locks.season_id " +
    "AND weeks.id = locks.matchup_week_id ";
  const commonEligibility =
    "WHERE locks.lock_type = 'normal' AND locks.legal = 0 " +
    "AND locks.legality_reason_code IS NOT NULL " +
    "AND length(trim(locks.legality_reason_code)) BETWEEN 1 AND 100 " +
    "AND locks.baseline_snapshot_id IS NULL " +
    "AND locks.source_freshness_status = 'unknown' " +
    "AND locks.locked_at_ms = weeks.locks_at_ms " +
    "AND weeks.status = 'live' " +
    "AND weeks.locks_at_ms < @nowMs " +
    "AND @nowMs < weeks.ends_at_ms ";
  const deterministicOrder =
    "ORDER BY locks.league_id, locks.season_id, " +
    "locks.matchup_week_id, locks.team_id, locks.id";

  let ownershipStatement;
  let deletionEvidenceStatement;
  let immediateStatement;
  let scheduledStatement;
  let immediateRead;
  try {
    ownershipStatement = database.prepare(
      "SELECT id, league_id, season_id, team_id, version " +
        "FROM player_ownerships WHERE id = @ownershipId LIMIT 2"
    );
    deletionEvidenceStatement = database.prepare(`
      SELECT events.id
      FROM ownership_events AS events
      WHERE events.league_id = @leagueId
        AND events.season_id = @seasonId
        AND events.team_id = @teamId
        AND events.ownership_id = @ownershipId
        AND (
          (
            (
              (
                events.event_type = 'player_released_by_buyout'
                AND events.source_type = 'buyout'
              )
              OR (
                events.event_type IN (
                  'fantasy_elc_declined',
                  'unsigned_prospect_rights_released'
                )
                AND events.source_type = 'prospect_decision'
              )
            )
            AND json_valid(events.before_metadata_json) = 1
            AND json_type(events.before_metadata_json, '$') = 'object'
            AND json_type(
              events.before_metadata_json,
              '$.version'
            ) = 'integer'
            AND json_extract(
              events.before_metadata_json,
              '$.version'
            ) = @ownershipVersion
            AND json_valid(events.after_metadata_json) = 1
            AND json_type(events.after_metadata_json, '$') = 'object'
            AND json_type(
              events.after_metadata_json,
              '$.owned'
            ) = 'false'
            AND (
              SELECT COUNT(*)
              FROM json_each(events.after_metadata_json)
            ) = 1
          )
          OR (
            events.event_type = 'commissioner_player_removed'
            AND events.source_type = 'commissioner_correction'
            AND json_valid(events.before_metadata_json) = 1
            AND json_type(
              events.before_metadata_json,
              '$.ownership'
            ) = 'object'
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.id'
            ) = @ownershipId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.leagueId'
            ) = @leagueId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.seasonId'
            ) = @seasonId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.teamId'
            ) = @teamId
            AND json_type(
              events.before_metadata_json,
              '$.ownership.version'
            ) = 'integer'
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.version'
            ) = @ownershipVersion
            AND json_valid(events.after_metadata_json) = 1
            AND json_type(events.after_metadata_json, '$') = 'object'
            AND json_type(
              events.after_metadata_json,
              '$.ownership'
            ) = 'null'
            AND (
              SELECT COUNT(*)
              FROM json_each(events.after_metadata_json)
            ) = 2
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(events.after_metadata_json)
              WHERE key NOT IN ('contract', 'ownership')
            )
          )
          OR (
            events.event_type =
              'player_released_by_contract_expiration'
            AND events.source_type = 'season_rollover'
            AND json_valid(events.before_metadata_json) = 1
            AND json_type(events.before_metadata_json, '$') = 'object'
            AND json_type(
              events.before_metadata_json,
              '$.exists'
            ) = 'true'
            AND json_extract(
              events.before_metadata_json,
              '$.id'
            ) = @ownershipId
            AND json_extract(
              events.before_metadata_json,
              '$.seasonId'
            ) = @seasonId
            AND json_extract(
              events.before_metadata_json,
              '$.teamId'
            ) = @teamId
            AND json_type(
              events.before_metadata_json,
              '$.version'
            ) = 'integer'
            AND json_extract(
              events.before_metadata_json,
              '$.version'
            ) = @ownershipVersion
            AND json_valid(events.after_metadata_json) = 1
            AND json_type(events.after_metadata_json, '$') = 'object'
            AND json_type(
              events.after_metadata_json,
              '$.exists'
            ) = 'false'
            AND json_extract(
              events.after_metadata_json,
              '$.id'
            ) = @ownershipId
            AND json_type(
              events.after_metadata_json,
              '$.seasonId'
            ) = 'null'
            AND json_extract(
              events.after_metadata_json,
              '$.teamId'
            ) = @teamId
            AND json_type(
              events.after_metadata_json,
              '$.version'
            ) = 'null'
          )
          OR (
            (
              (
                events.event_type = 'trade_transfer_out'
                AND events.source_type = 'trade'
              )
              OR (
                events.event_type = 'trade_reversal_out'
                AND events.source_type = 'trade_reversal'
              )
              OR (
                events.event_type = 'commissioner_roster_transfer_out'
                AND events.source_type = 'commissioner_correction'
              )
            )
            AND json_valid(events.before_metadata_json) = 1
            AND json_type(events.before_metadata_json, '$') = 'object'
            AND json_extract(
              events.before_metadata_json,
              '$.schemaVersion'
            ) = 2
            AND json_type(
              events.before_metadata_json,
              '$.exists'
            ) = 'true'
            AND json_type(
              events.before_metadata_json,
              '$.ownership'
            ) = 'object'
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.id'
            ) = @ownershipId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.leagueId'
            ) = @leagueId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.seasonId'
            ) = @seasonId
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.playerId'
            ) = events.player_id
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.teamId'
            ) = @teamId
            AND json_type(
              events.before_metadata_json,
              '$.ownership.version'
            ) = 'integer'
            AND json_extract(
              events.before_metadata_json,
              '$.ownership.version'
            ) = @ownershipVersion
            AND (
              SELECT COUNT(*)
              FROM json_each(events.before_metadata_json)
            ) = 3
            AND (
              SELECT COUNT(*)
              FROM json_each(
                events.before_metadata_json,
                '$.ownership'
              )
            ) = 10
            AND json_valid(events.after_metadata_json) = 1
            AND json_type(events.after_metadata_json, '$') = 'object'
            AND json_extract(
              events.after_metadata_json,
              '$.schemaVersion'
            ) = 2
            AND json_type(
              events.after_metadata_json,
              '$.exists'
            ) = 'false'
            AND json_type(
              events.after_metadata_json,
              '$.destinationOwnershipId'
            ) = 'text'
            AND length(json_extract(
              events.after_metadata_json,
              '$.destinationOwnershipId'
            )) = 36
            AND lower(json_extract(
              events.after_metadata_json,
              '$.destinationOwnershipId'
            )) = json_extract(
              events.after_metadata_json,
              '$.destinationOwnershipId'
            )
            AND json_extract(
              events.after_metadata_json,
              '$.destinationOwnershipId'
            ) <> @ownershipId
            AND (
              SELECT COUNT(*)
              FROM json_each(events.after_metadata_json)
            ) = 3
          )
        )
      ORDER BY events.occurred_at_ms DESC, events.id
      LIMIT 2
    `);
    immediateStatement = database.prepare(
      commonSelection +
        commonEligibility +
        "AND locks.league_id = @leagueId " +
        "AND locks.season_id = @seasonId " +
        "AND locks.team_id = @teamId " +
        deterministicOrder +
        " LIMIT 2"
    );
    scheduledStatement = database.prepare(
      commonSelection +
        commonEligibility +
        "AND locks.league_id = @leagueId " +
        "AND locks.season_id = @seasonId " +
        "AND locks.matchup_week_id = @weekId " +
        deterministicOrder
    );
    immediateRead = database.transaction((scope) => {
      for (const witness of scope.ownershipWitnesses) {
        const rows = ownershipStatement.all(witness);
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A committed ownership identifier is ambiguous."
          );
        }
        const current = rows[0] || null;
        if (witness.state === "deleted") {
          if (current) {
            failWitness(
              "A deleted ownership witness is still present."
            );
          }
          const deletionEvidence = deletionEvidenceStatement.all({
            leagueId: scope.leagueId,
            seasonId: scope.seasonId,
            teamId: scope.teamId,
            ownershipId: witness.ownershipId,
            ownershipVersion: witness.ownershipVersion,
          });
          if (deletionEvidence.length === 0) {
            failWitness(
              "A deleted ownership witness lacks exact durable deletion evidence."
            );
          }
          if (deletionEvidence.length > 1) {
            throw repositoryError(
              REPOSITORY_ERROR_CODES.schemaIncompatible,
              "A deleted ownership witness has ambiguous durable evidence."
            );
          }
          continue;
        }
        if (
          !current ||
          current.league_id !== scope.leagueId ||
          current.season_id !== scope.seasonId ||
          current.team_id !== scope.teamId ||
          current.version !== witness.ownershipVersion
        ) {
          failWitness(
            "A committed ownership witness is no longer current."
          );
        }
      }
      return freezeTargets(immediateStatement.all(scope), {
        singleTeam: true,
      });
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareLateLockCoordinatorRepository",
      tableName: "matchup_roster_locks",
    });
  }

  function listEligibleLateLocks(input) {
    try {
      if (!plainObject(input)) {
        failInput("A late-lock target lookup is required.");
      }
      if (input.mode === "committed_team") {
        exactObject(
          input,
          ["mode", "nowMs", "team"],
          "committed-team lookup"
        );
        const team = normalizeCommittedTeam(input.team);
        return immediateRead.deferred({
          ...team,
          nowMs: safeTimestamp(input.nowMs),
        });
      }
      if (input.mode === "scheduled_occurrence") {
        exactObject(
          input,
          ["leagueId", "mode", "nowMs", "seasonId", "weekId"],
          "scheduled-occurrence lookup"
        );
        return freezeTargets(
          scheduledStatement.all({
            leagueId: stableId(input.leagueId, "league"),
            seasonId: stableId(input.seasonId, "season"),
            weekId: stableId(input.weekId, "matchup week"),
            nowMs: safeTimestamp(input.nowMs),
          })
        );
      }
      failInput("A canonical late-lock target lookup mode is required.");
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "listEligibleLateLocks",
        tableName: "matchup_roster_locks",
      });
    }
  }

  return Object.freeze({ listEligibleLateLocks });
}

module.exports = {
  createSqliteLateLockCoordinatorRepository,
};
