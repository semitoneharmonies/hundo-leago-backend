const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  M6_JOB_TYPES,
  isMatchupJobWeekSlot,
  parseMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
} = require("../../../domain/matchups/matchupJobPolicy");
const {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("./SqliteMatchupOccurrenceExecutionGuard");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OCCURRENCE_EXECUTION_FIELDS = Object.freeze([
  "bindingId",
  "claimedJobVersion",
  "jobType",
  "leagueId",
  "leaseExpiresAtMs",
  "leaseOwner",
  "leaseToken",
  "occurrenceKey",
  "runId",
  "scheduleOperationId",
  "scheduleVersion",
  "scheduledForMs",
  "seasonId",
  "weekId",
]);
const SKIP_SUPERSEDED_FIELDS = Object.freeze([
  "completedAtMs",
  "occurrenceExecution",
]);
const SUPERSEDED_RESULT_JSON = JSON.stringify({
  outcome: "superseded_schedule_generation",
});

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A stable identifier is required.");
  }
  return value;
}

function bounded(value, maximum = 512) {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A bounded canonical value is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A safe non-negative timestamp is required."
    );
  }
  return value;
}

function positiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A positive safe integer is required."
    );
  }
  return value;
}

function freeze(row) {
  return row ? Object.freeze({ ...row }) : null;
}

const GATE_EVIDENCE_KEYS = Object.freeze([
  "binding_id",
  "binding_season_id",
  "binding_job_type",
  "binding_schedule_operation_id",
  "binding_schedule_version",
  "binding_owning_matchup_week_id",
  "binding_owning_matchup_id",
  "binding_version",
]);

function freezeGatedOccurrence(row) {
  if (!row) return null;
  const occurrence = { ...row };
  for (const key of GATE_EVIDENCE_KEYS) {
    delete occurrence[key];
  }
  return Object.freeze(occurrence);
}

function exactFields(value, fields) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") ===
      fields.join("|")
  );
}

function normalizeOccurrenceExecution(input) {
  if (!exactFields(input, OCCURRENCE_EXECUTION_FIELDS)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact matchup occurrence execution context is required."
    );
  }
  if (!M6_JOB_TYPES.includes(input.jobType)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An approved M6 job type is required."
    );
  }
  return Object.freeze({
    bindingId: stableId(input.bindingId),
    claimedJobVersion: positiveSafeInteger(
      input.claimedJobVersion
    ),
    jobType: input.jobType,
    leagueId: stableId(input.leagueId),
    leaseExpiresAtMs: safeTimestamp(
      input.leaseExpiresAtMs
    ),
    leaseOwner: bounded(input.leaseOwner, 128),
    leaseToken: bounded(input.leaseToken, 200),
    occurrenceKey: bounded(input.occurrenceKey),
    runId: stableId(input.runId),
    scheduleOperationId: stableId(
      input.scheduleOperationId
    ),
    scheduleVersion: positiveSafeInteger(
      input.scheduleVersion
    ),
    scheduledForMs: safeTimestamp(
      input.scheduledForMs
    ),
    seasonId: stableId(input.seasonId),
    weekId: stableId(input.weekId),
  });
}

function freezeOccurrenceExecution(row) {
  return normalizeOccurrenceExecution({
    bindingId: row.binding_id,
    claimedJobVersion: row.version,
    jobType: row.job_type,
    leagueId: row.league_id,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    occurrenceKey: row.occurrence_key,
    runId: row.id,
    scheduleOperationId:
      row.binding_schedule_operation_id,
    scheduleVersion: row.binding_schedule_version,
    scheduledForMs: row.scheduled_for_ms,
    seasonId: row.binding_season_id,
    weekId: row.binding_owning_matchup_week_id,
  });
}

function skipSupersededScope(input) {
  if (!exactFields(input, SKIP_SUPERSEDED_FIELDS)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An exact superseded-occurrence completion command is required."
    );
  }
  return Object.freeze({
    ...normalizeOccurrenceExecution(
      input.occurrenceExecution
    ),
    completedAtMs: safeTimestamp(input.completedAtMs),
    resultJson: SUPERSEDED_RESULT_JSON,
  });
}

function executionFromCommand(command) {
  return Object.freeze(Object.fromEntries(
    OCCURRENCE_EXECUTION_FIELDS.map((field) => [
      field,
      command[field],
    ])
  ));
}

function createSqliteMatchupJobRepository({ database, beforeCommit } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createSqliteMatchupJobRepository requires a database");
  }
  if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
    throw new TypeError("matchup-job beforeCommit must be a function");
  }
  const occurrenceExecutionGuard =
    createSqliteMatchupOccurrenceExecutionGuard({
      database,
    });
  const byOccurrence = database.prepare(
    "SELECT * FROM job_runs WHERE league_id = @leagueId AND job_type = @jobType " +
      "AND occurrence_key = @occurrenceKey LIMIT 2"
  );
  const byId = database.prepare(
    "SELECT * FROM job_runs WHERE league_id = @leagueId AND id = @runId LIMIT 2"
  );
  const bindingsByIdentity = database.prepare(`
    SELECT *
    FROM matchup_schedule_job_bindings
    WHERE league_id = @leagueId
      AND (
        id = @bindingId
        OR job_run_id = @runId
      )
    ORDER BY id
    LIMIT 3
  `);
  const currentGeneration = database.prepare(`
    SELECT *
    FROM season_matchup_schedule_generations
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND schedule_operation_id = @scheduleOperationId
      AND schedule_version = @scheduleVersion
      AND status = 'current'
    LIMIT 2
  `);
  const owningWeek = database.prepare(`
    SELECT *
    FROM matchup_weeks
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND id = @weekId
    LIMIT 2
  `);
  const currentGenerationWeekOne =
    database.prepare(`
      SELECT id
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND sequence = 1
        AND id = @weekOneMatchupWeekId
        AND starts_at_ms = @weekOneStartsAtMs
      LIMIT 2
    `);
  const insert = database.prepare(
    "INSERT INTO job_runs (id, league_id, season_id, job_type, occurrence_key, scheduled_for_ms, " +
      "status, attempt_count, lease_owner, lease_expires_at_ms, started_at_ms, completed_at_ms, " +
      "result_json, last_error_code, created_at_ms, updated_at_ms, version, lease_token, next_attempt_at_ms) " +
      "VALUES (@runId, @leagueId, @seasonId, @jobType, @occurrenceKey, @scheduledForMs, 'pending', " +
      "0, NULL, NULL, NULL, NULL, NULL, NULL, @nowMs, @nowMs, 1, NULL, @scheduledForMs)"
  );
  const insertBinding = database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id,
      league_id,
      season_id,
      job_run_id,
      job_type,
      schedule_operation_id,
      schedule_version,
      owning_matchup_week_id,
      owning_matchup_id,
      created_at_ms,
      version
    ) VALUES (
      @bindingId,
      @leagueId,
      @seasonId,
      @runId,
      @jobType,
      @scheduleOperationId,
      @scheduleVersion,
      @weekId,
      NULL,
      @nowMs,
      1
    )
  `);
  const gateSelect = `
    SELECT
      job_runs.*,
      matchup_schedule_job_bindings.id AS binding_id,
      matchup_schedule_job_bindings.season_id
        AS binding_season_id,
      matchup_schedule_job_bindings.job_type
        AS binding_job_type,
      matchup_schedule_job_bindings.schedule_operation_id
        AS binding_schedule_operation_id,
      matchup_schedule_job_bindings.schedule_version
        AS binding_schedule_version,
      matchup_schedule_job_bindings.owning_matchup_week_id
        AS binding_owning_matchup_week_id,
      matchup_schedule_job_bindings.owning_matchup_id
        AS binding_owning_matchup_id,
      matchup_schedule_job_bindings.version
        AS binding_version
    FROM job_runs
    JOIN matchup_schedule_job_bindings
      ON matchup_schedule_job_bindings.league_id =
          job_runs.league_id
     AND matchup_schedule_job_bindings.job_run_id =
          job_runs.id
     AND matchup_schedule_job_bindings.season_id =
          job_runs.season_id
     AND matchup_schedule_job_bindings.job_type =
          job_runs.job_type
     AND matchup_schedule_job_bindings.owning_matchup_id IS NULL
     AND matchup_schedule_job_bindings.version = 1
    JOIN season_matchup_schedule_generations
      ON season_matchup_schedule_generations.league_id =
          matchup_schedule_job_bindings.league_id
     AND season_matchup_schedule_generations.season_id =
          matchup_schedule_job_bindings.season_id
     AND season_matchup_schedule_generations.schedule_operation_id =
          matchup_schedule_job_bindings.schedule_operation_id
     AND season_matchup_schedule_generations.schedule_version =
          matchup_schedule_job_bindings.schedule_version
     AND season_matchup_schedule_generations.status = 'current'
    JOIN matchup_weeks AS owning_week
      ON owning_week.league_id =
          matchup_schedule_job_bindings.league_id
     AND owning_week.season_id =
          matchup_schedule_job_bindings.season_id
     AND owning_week.id =
          matchup_schedule_job_bindings.owning_matchup_week_id
    JOIN matchup_weeks AS generation_week_one
      ON generation_week_one.league_id =
          season_matchup_schedule_generations.league_id
     AND generation_week_one.season_id =
          season_matchup_schedule_generations.season_id
     AND generation_week_one.id =
          season_matchup_schedule_generations.week_one_matchup_week_id
     AND generation_week_one.starts_at_ms =
          season_matchup_schedule_generations.week_one_starts_at_ms
    JOIN seasons
      ON seasons.league_id = job_runs.league_id
     AND seasons.id = job_runs.season_id
     AND seasons.free_agent_draft_completed_at_ms IS NOT NULL
    JOIN free_agent_drafts
      ON free_agent_drafts.league_id = job_runs.league_id
     AND free_agent_drafts.season_id = job_runs.season_id
     AND free_agent_drafts.status = 'completed'
     AND free_agent_drafts.completed_at_ms =
          seasons.free_agent_draft_completed_at_ms
     AND free_agent_drafts.current_competition_first_matchup_week_id =
          season_matchup_schedule_generations.week_one_matchup_week_id
    WHERE (
      job_runs.occurrence_key =
        job_runs.job_type || ':' ||
        job_runs.league_id || ':' ||
        job_runs.season_id || ':' ||
        matchup_schedule_job_bindings.owning_matchup_week_id || ':' ||
        matchup_schedule_job_bindings.schedule_operation_id || ':' ||
        matchup_schedule_job_bindings.schedule_version || ':' ||
        job_runs.scheduled_for_ms
      OR job_runs.occurrence_key =
        job_runs.job_type || ':' ||
        job_runs.league_id || ':' ||
        job_runs.season_id || ':' ||
        matchup_schedule_job_bindings.owning_matchup_week_id || ':' ||
        job_runs.scheduled_for_ms
    )
      AND (
        (
          job_runs.job_type = 'matchup:statistics_refresh'
          AND job_runs.scheduled_for_ms IN (
            owning_week.starts_at_ms,
            owning_week.ends_at_ms
          )
        )
        OR (
          job_runs.job_type = 'matchup:baseline'
          AND job_runs.scheduled_for_ms =
              owning_week.baseline_at_ms
        )
        OR (
          job_runs.job_type = 'matchup:lock'
          AND job_runs.scheduled_for_ms =
              owning_week.locks_at_ms
        )
        OR (
          job_runs.job_type = 'matchup:finalize'
          AND job_runs.scheduled_for_ms =
              owning_week.ends_at_ms
        )
        OR (
          job_runs.job_type = 'matchup:rollover'
          AND job_runs.scheduled_for_ms =
              owning_week.rolls_over_at_ms
        )
      )
  `;
  const due = database.prepare(`
    ${gateSelect}
      AND job_runs.job_type IN (
        ${M6_JOB_TYPES.map(() => "?").join(", ")}
      )
      AND (
        (
          job_runs.status IN ('pending', 'failed')
          AND COALESCE(
            job_runs.next_attempt_at_ms,
            job_runs.scheduled_for_ms
          ) <= ?
        )
        OR (
          job_runs.status IN ('leased', 'running')
          AND job_runs.lease_expires_at_ms <= ?
        )
      )
    GROUP BY job_runs.id
    HAVING COUNT(*) = 1
    ORDER BY
      COALESCE(
        job_runs.next_attempt_at_ms,
        job_runs.scheduled_for_ms
      ),
      job_runs.scheduled_for_ms,
      job_runs.id
    LIMIT ?
  `);
  const gatedByOccurrence = database.prepare(`
    ${gateSelect}
      AND job_runs.league_id = @leagueId
      AND job_runs.season_id = @seasonId
      AND job_runs.job_type = @jobType
      AND job_runs.occurrence_key = @occurrenceKey
    LIMIT 2
  `);
  const claim = database.prepare(
    "UPDATE job_runs SET status = 'running', attempt_count = attempt_count + 1, " +
      "lease_owner = @leaseOwner, lease_token = @leaseToken, lease_expires_at_ms = @leaseExpiresAtMs, " +
      "started_at_ms = @nowMs, completed_at_ms = NULL, result_json = NULL, last_error_code = NULL, " +
      "next_attempt_at_ms = NULL, updated_at_ms = @nowMs, version = version + 1 " +
      "WHERE id = @runId AND league_id = @leagueId AND version = @expectedVersion"
  );
  const renew = database.prepare(
    "UPDATE job_runs SET lease_expires_at_ms = @leaseExpiresAtMs, updated_at_ms = @nowMs, " +
      "version = version + 1 WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );
  const succeed = database.prepare(
    "UPDATE job_runs SET status = 'succeeded', lease_owner = NULL, lease_token = NULL, " +
      "lease_expires_at_ms = NULL, completed_at_ms = @completedAtMs, result_json = @resultJson, " +
      "last_error_code = NULL, next_attempt_at_ms = NULL, updated_at_ms = @completedAtMs, " +
      "version = version + 1 WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );
  const fail = database.prepare(
    "UPDATE job_runs SET status = 'failed', lease_owner = NULL, lease_token = NULL, " +
      "lease_expires_at_ms = NULL, completed_at_ms = @completedAtMs, result_json = NULL, " +
      "last_error_code = @errorCode, next_attempt_at_ms = @nextAttemptAtMs, " +
      "updated_at_ms = @completedAtMs, version = version + 1 " +
      "WHERE id = @runId AND league_id = @leagueId AND status = 'running' " +
      "AND lease_owner = @leaseOwner AND lease_token = @leaseToken AND version = @expectedVersion"
  );
  const skippedSupersededByExecution = database.prepare(`
    SELECT job_runs.*
    FROM job_runs
    JOIN matchup_schedule_job_bindings AS binding
      ON binding.league_id = job_runs.league_id
     AND binding.season_id = job_runs.season_id
     AND binding.id = @bindingId
     AND binding.job_run_id = job_runs.id
     AND binding.job_type = job_runs.job_type
     AND binding.schedule_operation_id =
          @scheduleOperationId
     AND binding.schedule_version = @scheduleVersion
     AND binding.owning_matchup_week_id = @weekId
     AND binding.owning_matchup_id IS NULL
     AND binding.version = 1
    JOIN season_matchup_schedule_generations AS generation
      ON generation.league_id = binding.league_id
     AND generation.season_id = binding.season_id
     AND generation.schedule_operation_id =
          binding.schedule_operation_id
     AND generation.schedule_version =
          binding.schedule_version
     AND generation.status = 'superseded'
    JOIN season_matchup_schedule_generations AS current_generation
      ON current_generation.league_id = binding.league_id
     AND current_generation.season_id = binding.season_id
     AND current_generation.status = 'current'
     AND current_generation.schedule_operation_id <>
          generation.schedule_operation_id
     AND current_generation.schedule_version <>
          generation.schedule_version
    JOIN matchup_weeks AS current_week_one
      ON current_week_one.league_id =
          current_generation.league_id
     AND current_week_one.season_id =
          current_generation.season_id
     AND current_week_one.id =
          current_generation.week_one_matchup_week_id
     AND current_week_one.sequence = 1
     AND current_week_one.starts_at_ms =
          current_generation.week_one_starts_at_ms
    JOIN seasons
      ON seasons.league_id = job_runs.league_id
     AND seasons.id = job_runs.season_id
     AND seasons.free_agent_draft_completed_at_ms
          IS NOT NULL
    JOIN free_agent_drafts AS fad
      ON fad.league_id = job_runs.league_id
     AND fad.season_id = job_runs.season_id
     AND fad.status = 'completed'
     AND fad.completed_at_ms =
          seasons.free_agent_draft_completed_at_ms
     AND fad.current_competition_first_matchup_week_id =
          current_generation.week_one_matchup_week_id
    WHERE job_runs.id = @runId
      AND job_runs.league_id = @leagueId
      AND job_runs.season_id = @seasonId
      AND job_runs.job_type = @jobType
      AND job_runs.occurrence_key = @occurrenceKey
      AND job_runs.scheduled_for_ms = @scheduledForMs
      AND job_runs.status = 'skipped'
      AND job_runs.lease_owner IS NULL
      AND job_runs.lease_token IS NULL
      AND job_runs.lease_expires_at_ms IS NULL
      AND job_runs.attempt_count >= 1
      AND job_runs.started_at_ms IS NOT NULL
      AND job_runs.completed_at_ms IS NOT NULL
      AND job_runs.started_at_ms <=
          job_runs.completed_at_ms
      AND job_runs.updated_at_ms = job_runs.completed_at_ms
      AND job_runs.result_json = @resultJson
      AND job_runs.last_error_code IS NULL
      AND job_runs.next_attempt_at_ms IS NULL
      AND job_runs.version = @claimedJobVersion + 1
      AND (
        job_runs.occurrence_key =
          job_runs.job_type || ':' ||
          job_runs.league_id || ':' ||
          job_runs.season_id || ':' ||
          binding.owning_matchup_week_id || ':' ||
          binding.schedule_operation_id || ':' ||
          binding.schedule_version || ':' ||
          job_runs.scheduled_for_ms
        OR job_runs.occurrence_key =
          job_runs.job_type || ':' ||
          job_runs.league_id || ':' ||
          job_runs.season_id || ':' ||
          binding.owning_matchup_week_id || ':' ||
          job_runs.scheduled_for_ms
      )
    LIMIT 2
  `);
  const skipSuperseded = database.prepare(`
    UPDATE job_runs
    SET status = 'skipped',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @completedAtMs,
        result_json = @resultJson,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @completedAtMs,
        version = version + 1
    WHERE id = @runId
      AND league_id = @leagueId
      AND season_id = @seasonId
      AND job_type = @jobType
      AND occurrence_key = @occurrenceKey
      AND scheduled_for_ms = @scheduledForMs
      AND status = 'running'
      AND lease_owner = @leaseOwner
      AND lease_token = @leaseToken
      AND lease_expires_at_ms = @leaseExpiresAtMs
      AND started_at_ms IS NOT NULL
      AND started_at_ms <= @completedAtMs
      AND completed_at_ms IS NULL
      AND result_json IS NULL
      AND last_error_code IS NULL
      AND next_attempt_at_ms IS NULL
      AND version = @claimedJobVersion
      AND EXISTS (
        SELECT 1
        FROM matchup_schedule_job_bindings AS binding
        WHERE binding.id = @bindingId
          AND binding.league_id = job_runs.league_id
          AND binding.season_id = job_runs.season_id
          AND binding.job_run_id = job_runs.id
          AND binding.job_type = job_runs.job_type
          AND binding.schedule_operation_id =
              @scheduleOperationId
          AND binding.schedule_version =
              @scheduleVersion
          AND binding.owning_matchup_week_id = @weekId
          AND binding.owning_matchup_id IS NULL
          AND binding.version = 1
      )
      AND EXISTS (
        SELECT 1
        FROM season_matchup_schedule_generations AS generation
        WHERE generation.league_id = job_runs.league_id
          AND generation.season_id = job_runs.season_id
          AND generation.schedule_operation_id =
              @scheduleOperationId
          AND generation.schedule_version =
              @scheduleVersion
          AND generation.status = 'superseded'
      )
  `);

  function occurrenceScope(input) {
    if (!M6_JOB_TYPES.includes(input.jobType)) {
      throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "An approved M6 job type is required.");
    }
    return {
      leagueId: stableId(input.leagueId),
      seasonId: stableId(input.seasonId),
      jobType: input.jobType,
      occurrenceKey: bounded(input.occurrenceKey),
    };
  }

  function scheduleScope(input) {
    const scope = {
      ...occurrenceScope(input),
      bindingId: stableId(input.bindingId),
      runId: stableId(input.runId),
      weekId: stableId(input.weekId),
      scheduleOperationId:
        stableId(input.scheduleOperationId),
      scheduleVersion:
        positiveSafeInteger(input.scheduleVersion),
      scheduledForMs:
        safeTimestamp(input.scheduledForMs),
      nowMs: safeTimestamp(input.nowMs),
    };
    if (
      !Object.prototype.hasOwnProperty.call(
        input,
        "owningMatchupId"
      ) ||
      input.owningMatchupId !== null
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A week-level matchup job must provide a null owning matchup ID."
      );
    }
    let parsed;
    try {
      parsed = parseQualifiedMatchupOccurrenceKey({
        ...scope,
        occurrenceKey: scope.occurrenceKey,
      });
    } catch (error) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A canonical generation-qualified occurrence key is required.",
        { cause: error }
      );
    }
    if (
      parsed.weekId !== scope.weekId ||
      parsed.scheduleOperationId !==
        scope.scheduleOperationId ||
      parsed.scheduleVersion !== scope.scheduleVersion
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "The occurrence key and job binding identity must agree."
      );
    }
    return scope;
  }

  function exactBinding(
    command,
    row,
    occurrenceRow
  ) {
    return Boolean(
      row &&
      occurrenceRow &&
      row.id === command.bindingId &&
      row.league_id === command.leagueId &&
      row.season_id === command.seasonId &&
      row.job_run_id === command.runId &&
      row.job_type === command.jobType &&
      row.schedule_operation_id ===
        command.scheduleOperationId &&
      row.schedule_version ===
        command.scheduleVersion &&
      row.owning_matchup_week_id ===
        command.weekId &&
      row.owning_matchup_id === null &&
      row.created_at_ms ===
        occurrenceRow.created_at_ms &&
      row.version === 1
    );
  }

  function gateOccurrenceIsCanonical(row) {
    if (!row) return false;
    let parsed;
    try {
      parsed = parseMatchupOccurrenceKey({
        jobType: row.job_type,
        leagueId: row.league_id,
        seasonId: row.season_id,
        occurrenceKey: row.occurrence_key,
        scheduledForMs: row.scheduled_for_ms,
      });
    } catch {
      return false;
    }
    return Boolean(
      parsed.weekId ===
        row.binding_owning_matchup_week_id &&
      (
        (
          parsed.scheduleOperationId === null &&
          parsed.scheduleVersion === null
        )
        ||
        (
          parsed.scheduleOperationId ===
            row.binding_schedule_operation_id &&
          parsed.scheduleVersion ===
            row.binding_schedule_version
        )
      )
    );
  }

  function requireCurrentScheduleSlot(command) {
    const generations = currentGeneration.all(command);
    if (generations.length !== 1) {
      throw repositoryError(
        generations.length > 1
          ? REPOSITORY_ERROR_CODES.schemaIncompatible
          : REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup job schedule generation is not uniquely current."
      );
    }
    const weeks = owningWeek.all(command);
    if (weeks.length !== 1) {
      throw repositoryError(
        weeks.length > 1
          ? REPOSITORY_ERROR_CODES.schemaIncompatible
          : REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup job owning week is unavailable."
      );
    }
    const generation = generations[0];
    const week = weeks[0];
    if (
      currentGenerationWeekOne.all({
        ...command,
        weekOneMatchupWeekId:
          generation.week_one_matchup_week_id,
        weekOneStartsAtMs:
          generation.week_one_starts_at_ms,
      }).length !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The current matchup schedule generation has no exact Week 1."
      );
    }
    let validSlot = false;
    try {
      validSlot = isMatchupJobWeekSlot({
        jobType: command.jobType,
        scheduledForMs: command.scheduledForMs,
        startsAtMs: week.starts_at_ms,
        baselineAtMs: week.baseline_at_ms,
        locksAtMs: week.locks_at_ms,
        endsAtMs: week.ends_at_ms,
        rollsOverAtMs: week.rolls_over_at_ms,
      });
    } catch (error) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The matchup job owning week is malformed.",
        { cause: error }
      );
    }
    if (!validSlot) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "The matchup job type and scheduled instant do not match its owning week."
      );
    }
  }

  const scheduleTransaction = database.transaction((command) => {
    requireCurrentScheduleSlot(command);
    const rows = byOccurrence.all(command);
    if (rows.length > 1) {
      throw repositoryError(REPOSITORY_ERROR_CODES.schemaIncompatible, "The scheduled occurrence is ambiguous.");
    }
    if (rows.length === 1) {
      const row = rows[0];
      if (
        row.id !== command.runId || row.season_id !== command.seasonId ||
        row.scheduled_for_ms !== command.scheduledForMs
      ) {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The occurrence key has conflicting evidence.");
      }
      const bindings =
        bindingsByIdentity.all(command);
      if (
        bindings.length !== 1 ||
        !exactBinding(
          command,
          bindings[0],
          row
        )
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The scheduled occurrence has missing or conflicting binding evidence."
        );
      }
      return Object.freeze({ replayed: true, occurrence: freeze(row) });
    }
    if (bindingsByIdentity.all(command).length !== 0) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The matchup job binding identity is already in use."
      );
    }
    insert.run(command);
    if (beforeCommit) {
      beforeCommit("schedule_after_job_insert");
    }
    insertBinding.run(command);
    if (beforeCommit) {
      beforeCommit("schedule_after_binding_insert");
    }
    const bindings = bindingsByIdentity.all(command);
    const insertedRow = byOccurrence.get(command);
    if (
      bindings.length !== 1 ||
      !exactBinding(
        command,
        bindings[0],
        insertedRow
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The scheduled occurrence binding could not be verified."
      );
    }
    return Object.freeze({
      replayed: false,
      occurrence: freeze(insertedRow),
    });
  });

  const claimTransaction = database.transaction((command) => {
    const rows = byOccurrence.all(command);
    if (rows.length !== 1) return Object.freeze({ acquired: false, occurrence: null });
    const row = rows[0];
    if (row.season_id !== command.seasonId) {
      return Object.freeze({
        acquired: false,
        occurrence: null,
      });
    }
    const gatedRows = gatedByOccurrence.all(command);
    if (
      gatedRows.length !== 1 ||
      !gateOccurrenceIsCanonical(gatedRows[0])
    ) {
      return Object.freeze({
        acquired: false,
        occurrence: freeze(row),
      });
    }
    const retryAtMs = row.next_attempt_at_ms ?? row.scheduled_for_ms;
    const eligible =
      (["pending", "failed"].includes(row.status) && retryAtMs <= command.nowMs) ||
      (["leased", "running"].includes(row.status) && row.lease_expires_at_ms <= command.nowMs);
    if (!eligible) return Object.freeze({ acquired: false, occurrence: freeze(row) });
    if (claim.run({ ...command, runId: row.id, expectedVersion: row.version }).changes !== 1) {
      return Object.freeze({ acquired: false, occurrence: freeze(byOccurrence.get(command)) });
    }
    const claimedRows = gatedByOccurrence.all(command);
    if (
      claimedRows.length !== 1 ||
      !gateOccurrenceIsCanonical(claimedRows[0]) ||
      claimedRows[0].id !== row.id ||
      claimedRows[0].status !== "running" ||
      claimedRows[0].attempt_count !==
        row.attempt_count + 1 ||
      claimedRows[0].lease_owner !==
        command.leaseOwner ||
      claimedRows[0].lease_token !==
        command.leaseToken ||
      claimedRows[0].lease_expires_at_ms !==
        command.leaseExpiresAtMs ||
      claimedRows[0].started_at_ms !== command.nowMs ||
      claimedRows[0].version !== row.version + 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The claimed matchup occurrence execution context could not be verified."
      );
    }
    const claimedRow = claimedRows[0];
    if (beforeCommit) beforeCommit("claim");
    return Object.freeze({
      acquired: true,
      occurrence:
        freezeGatedOccurrence(claimedRow),
      occurrenceExecution:
        freezeOccurrenceExecution(claimedRow),
    });
  });

  const skipSupersededTransaction = database.transaction(
    (command) => {
      const replayRows =
        skippedSupersededByExecution.all(command);
      if (replayRows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The skipped matchup occurrence replay is ambiguous."
        );
      }
      if (replayRows.length === 1) {
        return Object.freeze({
          replayed: true,
          occurrence: freeze(replayRows[0]),
        });
      }

      let guardReason = null;
      try {
        occurrenceExecutionGuard.assertCurrent(
          executionFromCommand(command)
        );
      } catch (error) {
        guardReason =
          classifyMatchupOccurrenceExecutionGuardError(
            error
          );
        if (
          guardReason !==
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .generationSuperseded
        ) {
          throw error;
        }
      }
      if (guardReason === null) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "A current matchup schedule generation cannot be skipped."
        );
      }
      if (skipSuperseded.run(command).changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The superseded matchup occurrence lease or binding changed."
        );
      }
      if (beforeCommit) {
        beforeCommit("skip_superseded");
      }
      const skipped = byId.get(command);
      if (
        !skipped ||
        skipped.status !== "skipped" ||
        skipped.lease_owner !== null ||
        skipped.lease_token !== null ||
        skipped.lease_expires_at_ms !== null ||
        skipped.completed_at_ms !==
          command.completedAtMs ||
        skipped.result_json !== command.resultJson ||
        skipped.last_error_code !== null ||
        skipped.next_attempt_at_ms !== null ||
        skipped.version !==
          command.claimedJobVersion + 1
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The superseded matchup occurrence terminal state could not be verified."
        );
      }
      return Object.freeze({
        replayed: false,
        occurrence: freeze(skipped),
      });
    }
  );

  function guardedMutation(statement, command, operation) {
    return database.transaction((input) => {
      if (statement.run(input).changes !== 1) {
        throw repositoryError(REPOSITORY_ERROR_CODES.versionConflict, "The job lease token or version changed.");
      }
      if (beforeCommit) beforeCommit(operation);
      return freeze(byId.get({ leagueId: input.leagueId, runId: input.runId }));
    }).immediate(command);
  }

  return Object.freeze({
    schedule(command) {
      try {
        return scheduleTransaction.immediate(
          scheduleScope(command)
        );
      } catch (error) {
        throw mapRepositoryError(error, { operation: "scheduleMatchupJob", tableName: "job_runs" });
      }
    },
    listDue({ nowMs, limit = 25 }) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw repositoryError(REPOSITORY_ERROR_CODES.argumentInvalid, "A safe due query is required.");
      }
      return Object.freeze(
        due
          .all(
            ...M6_JOB_TYPES,
            nowMs,
            nowMs,
            limit
          )
          .filter(gateOccurrenceIsCanonical)
          .map(freezeGatedOccurrence)
      );
    },
    claim(command) {
      try {
        return claimTransaction.immediate({
          ...command,
          ...occurrenceScope(command),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
          nowMs: safeTimestamp(command.nowMs),
          leaseExpiresAtMs:
            safeTimestamp(command.leaseExpiresAtMs),
        });
      } catch (error) {
        throw mapRepositoryError(error, { operation: "claimMatchupJob", tableName: "job_runs" });
      }
    },
    skipSuperseded(command) {
      try {
        return skipSupersededTransaction.immediate(
          skipSupersededScope(command)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "skipSupersededMatchupJob",
          tableName: "job_runs",
        });
      }
    },
    renew(command) {
      try {
        return guardedMutation(renew, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
        }, "renew");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "renewMatchupJob", tableName: "job_runs" });
      }
    },
    succeed(command) {
      try {
        return guardedMutation(succeed, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
          resultJson: JSON.stringify(command.result ?? null),
        }, "succeed");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "succeedMatchupJob", tableName: "job_runs" });
      }
    },
    fail(command) {
      try {
        return guardedMutation(fail, {
          ...command,
          leagueId: stableId(command.leagueId),
          runId: stableId(command.runId),
          leaseOwner: bounded(command.leaseOwner, 128),
          leaseToken: bounded(command.leaseToken, 200),
          errorCode: bounded(command.errorCode, 100),
        }, "fail");
      } catch (error) {
        throw mapRepositoryError(error, { operation: "failMatchupJob", tableName: "job_runs" });
      }
    },
  });
}

module.exports = { createSqliteMatchupJobRepository };
