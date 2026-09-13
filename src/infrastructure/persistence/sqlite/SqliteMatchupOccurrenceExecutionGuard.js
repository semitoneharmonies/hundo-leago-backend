const {
  M6_JOB_TYPES,
  isMatchupJobWeekSlot,
  parseMatchupOccurrenceKey,
} = require("../../../domain/matchups/matchupJobPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS = Object.freeze({
  evidenceInvariant:
    "MATCHUP_OCCURRENCE_EXECUTION_EVIDENCE_INVARIANT",
  generationSuperseded:
    "MATCHUP_OCCURRENCE_GENERATION_SUPERSEDED",
  leaseLost: "MATCHUP_OCCURRENCE_LEASE_LOST",
});

const EXECUTION_CONTEXT_FIELDS = Object.freeze([
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

const GUARDED_REASON_CODES = new Set(
  Object.values(
    MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
  )
);

function classifyMatchupOccurrenceExecutionGuardError(error) {
  const visited = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !visited.has(current)
  ) {
    visited.add(current);
    for (const candidate of [
      current.reasonCode,
      current.details?.reasonCode,
    ]) {
      if (GUARDED_REASON_CODES.has(candidate)) {
        return candidate;
      }
    }
    current = current.cause;
  }
  return null;
}

function guardedError(code, reasonCode, message, details = {}) {
  return repositoryError(code, message, {
    details: {
      ...details,
      reasonCode,
    },
  });
}

function invalid(message) {
  throw guardedError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
      .evidenceInvariant,
    message
  );
}

function invariant(message, details) {
  throw guardedError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
      .evidenceInvariant,
    message,
    details
  );
}

function stableId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(
      `A stable ${description} identifier is required.`
    );
  }
  return value;
}

function bounded(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function safeTimestamp(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveSafeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(`A positive safe ${description} is required.`);
  }
  return value;
}

function normalizeExecutionContext(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("|") !==
      EXECUTION_CONTEXT_FIELDS.join("|")
  ) {
    invalid(
      "An exact matchup occurrence execution context is required."
    );
  }
  if (!M6_JOB_TYPES.includes(input.jobType)) {
    invalid("An approved matchup job type is required.");
  }
  return Object.freeze({
    bindingId: stableId(input.bindingId, "binding"),
    claimedJobVersion: positiveSafeInteger(
      input.claimedJobVersion,
      "claimed job version"
    ),
    jobType: input.jobType,
    leagueId: stableId(input.leagueId, "league"),
    leaseExpiresAtMs: safeTimestamp(
      input.leaseExpiresAtMs,
      "lease expiry"
    ),
    leaseOwner: bounded(
      input.leaseOwner,
      128,
      "lease owner"
    ),
    leaseToken: bounded(
      input.leaseToken,
      200,
      "lease token"
    ),
    occurrenceKey: bounded(
      input.occurrenceKey,
      512,
      "occurrence key"
    ),
    runId: stableId(input.runId, "job run"),
    scheduleOperationId: stableId(
      input.scheduleOperationId,
      "schedule operation"
    ),
    scheduleVersion: positiveSafeInteger(
      input.scheduleVersion,
      "schedule version"
    ),
    scheduledForMs: safeTimestamp(
      input.scheduledForMs,
      "scheduled instant"
    ),
    seasonId: stableId(input.seasonId, "season"),
    weekId: stableId(input.weekId, "matchup week"),
  });
}

function exactlyOne(rows, message, details) {
  if (rows.length !== 1) invariant(message, details);
  return rows[0];
}

function createSqliteMatchupOccurrenceExecutionGuard({
  database,
} = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "createSqliteMatchupOccurrenceExecutionGuard requires a database"
    );
  }

  const jobById = database.prepare(`
    SELECT *
    FROM job_runs
    WHERE id = @runId
    LIMIT 2
  `);
  const bindingsByIdentity = database.prepare(`
    SELECT *
    FROM matchup_schedule_job_bindings
    WHERE id = @bindingId
       OR (
         league_id = @leagueId
         AND job_run_id = @runId
       )
    ORDER BY id
    LIMIT 3
  `);
  const generationsByIdentity = database.prepare(`
    SELECT *
    FROM season_matchup_schedule_generations
    WHERE schedule_operation_id = @scheduleOperationId
       OR (
         league_id = @leagueId
         AND season_id = @seasonId
         AND schedule_version = @scheduleVersion
       )
    ORDER BY schedule_version, schedule_operation_id
    LIMIT 3
  `);
  const currentGenerationsBySeason = database.prepare(`
    SELECT *
    FROM season_matchup_schedule_generations
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND status = 'current'
    ORDER BY schedule_version, schedule_operation_id
    LIMIT 2
  `);
  const owningWeekById = database.prepare(`
    SELECT *
    FROM matchup_weeks
    WHERE id = @weekId
    LIMIT 2
  `);
  const generationWeekOne = database.prepare(`
    SELECT *
    FROM matchup_weeks
    WHERE id = @generationWeekOneId
       OR (
         league_id = @leagueId
         AND season_id = @seasonId
         AND sequence = 1
       )
    ORDER BY id
    LIMIT 3
  `);
  const seasonById = database.prepare(`
    SELECT *
    FROM seasons
    WHERE id = @seasonId
    LIMIT 2
  `);
  const fadBySeason = database.prepare(`
    SELECT *
    FROM free_agent_drafts
    WHERE league_id = @leagueId
      AND season_id = @seasonId
    ORDER BY id
    LIMIT 2
  `);

  function requireGenerationWeekOne(
    execution,
    generation
  ) {
    const rows = generationWeekOne.all({
      ...execution,
      generationWeekOneId:
        generation.week_one_matchup_week_id,
    });
    const weekOne = exactlyOne(
      rows,
      "The current generation Week 1 evidence is missing or ambiguous.",
      {
        scheduleOperationId:
          generation.schedule_operation_id,
      }
    );
    if (
      weekOne.id !==
        generation.week_one_matchup_week_id ||
      weekOne.league_id !== execution.leagueId ||
      weekOne.season_id !== execution.seasonId ||
      weekOne.sequence !== 1 ||
      weekOne.starts_at_ms !==
        generation.week_one_starts_at_ms
    ) {
      invariant(
        "The current generation Week 1 evidence changed.",
        {
          scheduleOperationId:
            generation.schedule_operation_id,
        }
      );
    }
    return weekOne;
  }

  function assertCurrent(executionContext) {
    try {
      if (database.inTransaction !== true) {
        throw guardedError(
          REPOSITORY_ERROR_CODES.scopeRequired,
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .evidenceInvariant,
          "Matchup occurrence execution must be guarded inside its write transaction."
        );
      }
      const execution = normalizeExecutionContext(
        executionContext
      );
      const job = exactlyOne(
        jobById.all(execution),
        "The claimed matchup occurrence job is missing or ambiguous.",
        { runId: execution.runId }
      );
      if (
        job.id !== execution.runId ||
        job.league_id !== execution.leagueId ||
        job.season_id !== execution.seasonId ||
        job.job_type !== execution.jobType ||
        job.occurrence_key !== execution.occurrenceKey ||
        job.scheduled_for_ms !== execution.scheduledForMs
      ) {
        invariant(
          "The claimed matchup occurrence job identity changed.",
          { runId: execution.runId }
        );
      }
      if (
        job.status !== "running" ||
        job.lease_owner !== execution.leaseOwner ||
        job.lease_token !== execution.leaseToken ||
        job.lease_expires_at_ms !==
          execution.leaseExpiresAtMs ||
        job.version !== execution.claimedJobVersion ||
        !Number.isSafeInteger(job.attempt_count) ||
        job.attempt_count < 1 ||
        !Number.isSafeInteger(job.started_at_ms) ||
        job.started_at_ms < 0 ||
        job.completed_at_ms !== null ||
        job.result_json !== null ||
        job.last_error_code !== null ||
        job.next_attempt_at_ms !== null
      ) {
        throw guardedError(
          REPOSITORY_ERROR_CODES.versionConflict,
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .leaseLost,
          "The matchup occurrence execution lease changed.",
          { runId: execution.runId }
        );
      }

      const binding = exactlyOne(
        bindingsByIdentity.all(execution),
        "The matchup occurrence binding is missing or ambiguous.",
        {
          bindingId: execution.bindingId,
          runId: execution.runId,
        }
      );
      if (
        binding.id !== execution.bindingId ||
        binding.league_id !== execution.leagueId ||
        binding.season_id !== execution.seasonId ||
        binding.job_run_id !== execution.runId ||
        binding.job_type !== execution.jobType ||
        binding.schedule_operation_id !==
          execution.scheduleOperationId ||
        binding.schedule_version !==
          execution.scheduleVersion ||
        binding.owning_matchup_week_id !==
          execution.weekId ||
        binding.owning_matchup_id !== null ||
        binding.version !== 1
      ) {
        invariant(
          "The matchup occurrence binding identity changed.",
          {
            bindingId: execution.bindingId,
            runId: execution.runId,
          }
        );
      }

      let parsedOccurrence;
      try {
        parsedOccurrence = parseMatchupOccurrenceKey({
          jobType: execution.jobType,
          leagueId: execution.leagueId,
          seasonId: execution.seasonId,
          occurrenceKey: execution.occurrenceKey,
          scheduledForMs: execution.scheduledForMs,
        });
      } catch (error) {
        invariant(
          "The matchup occurrence key is not canonical.",
          { runId: execution.runId }
        );
      }
      if (
        parsedOccurrence.weekId !== execution.weekId ||
        (
          parsedOccurrence.scheduleOperationId !== null &&
          (
            parsedOccurrence.scheduleOperationId !==
              execution.scheduleOperationId ||
            parsedOccurrence.scheduleVersion !==
              execution.scheduleVersion
          )
        )
      ) {
        invariant(
          "The matchup occurrence key does not match its immutable binding.",
          { runId: execution.runId }
        );
      }

      const generation = exactlyOne(
        generationsByIdentity.all(execution),
        "The matchup schedule generation is missing or ambiguous.",
        {
          scheduleOperationId:
            execution.scheduleOperationId,
          scheduleVersion: execution.scheduleVersion,
        }
      );
      if (
        generation.league_id !== execution.leagueId ||
        generation.season_id !== execution.seasonId ||
        generation.schedule_operation_id !==
          execution.scheduleOperationId ||
        generation.schedule_version !==
          execution.scheduleVersion
      ) {
        invariant(
          "The matchup schedule generation identity changed.",
          {
            scheduleOperationId:
              execution.scheduleOperationId,
            scheduleVersion: execution.scheduleVersion,
          }
        );
      }

      const season = exactlyOne(
        seasonById.all(execution),
        "The matchup occurrence season is missing or ambiguous.",
        { seasonId: execution.seasonId }
      );
      if (
        season.id !== execution.seasonId ||
        season.league_id !== execution.leagueId ||
        season.free_agent_draft_completed_at_ms === null
      ) {
        invariant(
          "The season FAD completion marker is missing or inconsistent.",
          { seasonId: execution.seasonId }
        );
      }
      const fad = exactlyOne(
        fadBySeason.all(execution),
        "The completed FAD gate is missing or ambiguous.",
        { seasonId: execution.seasonId }
      );
      if (
        fad.league_id !== execution.leagueId ||
        fad.season_id !== execution.seasonId ||
        fad.status !== "completed" ||
        fad.completed_at_ms !==
          season.free_agent_draft_completed_at_ms
      ) {
        invariant(
          "The completed FAD gate is inconsistent with its season marker.",
          { seasonId: execution.seasonId }
        );
      }
      const currentGeneration = exactlyOne(
        currentGenerationsBySeason.all(execution),
        "The league season has no unique current matchup schedule generation.",
        { seasonId: execution.seasonId }
      );
      if (
        currentGeneration.league_id !==
          execution.leagueId ||
        currentGeneration.season_id !==
          execution.seasonId ||
        currentGeneration.status !== "current"
      ) {
        invariant(
          "The current matchup schedule generation identity is inconsistent.",
          { seasonId: execution.seasonId }
        );
      }
      requireGenerationWeekOne(
        execution,
        currentGeneration
      );
      if (
        fad.current_competition_first_matchup_week_id !==
          currentGeneration.week_one_matchup_week_id
      ) {
        invariant(
          "The completed FAD gate does not match the current schedule generation.",
          { seasonId: execution.seasonId }
        );
      }
      if (generation.status === "superseded") {
        if (
          currentGeneration.schedule_operation_id ===
            generation.schedule_operation_id ||
          currentGeneration.schedule_version ===
            generation.schedule_version
        ) {
          invariant(
            "The superseded and current schedule generations are not distinct.",
            { seasonId: execution.seasonId }
          );
        }
        throw guardedError(
          REPOSITORY_ERROR_CODES.versionConflict,
          MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS
            .generationSuperseded,
          "The matchup occurrence schedule generation was superseded.",
          {
            scheduleOperationId:
              execution.scheduleOperationId,
            scheduleVersion: execution.scheduleVersion,
          }
        );
      }
      if (generation.status !== "current") {
        invariant(
          "The matchup schedule generation status is invalid.",
          {
            scheduleOperationId:
              execution.scheduleOperationId,
            scheduleVersion: execution.scheduleVersion,
          }
        );
      }
      if (
        currentGeneration.schedule_operation_id !==
          generation.schedule_operation_id ||
        currentGeneration.schedule_version !==
          generation.schedule_version
      ) {
        invariant(
          "The execution generation is not the unique current schedule generation.",
          {
            scheduleOperationId:
              execution.scheduleOperationId,
            scheduleVersion: execution.scheduleVersion,
          }
        );
      }

      const owningWeek = exactlyOne(
        owningWeekById.all(execution),
        "The matchup occurrence owning week is missing or ambiguous.",
        { weekId: execution.weekId }
      );
      if (
        owningWeek.id !== execution.weekId ||
        owningWeek.league_id !== execution.leagueId ||
        owningWeek.season_id !== execution.seasonId
      ) {
        invariant(
          "The matchup occurrence owning week identity changed.",
          { weekId: execution.weekId }
        );
      }

      if (
        !isMatchupJobWeekSlot({
          jobType: execution.jobType,
          scheduledForMs: execution.scheduledForMs,
          startsAtMs: owningWeek.starts_at_ms,
          baselineAtMs: owningWeek.baseline_at_ms,
          locksAtMs: owningWeek.locks_at_ms,
          endsAtMs: owningWeek.ends_at_ms,
          rollsOverAtMs: owningWeek.rolls_over_at_ms,
        })
      ) {
        invariant(
          "The matchup occurrence does not match its generation week slot.",
          { runId: execution.runId }
        );
      }

      return execution;
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "assertCurrentMatchupOccurrenceExecution",
        tableName: "job_runs",
      });
    }
  }

  return Object.freeze({ assertCurrent });
}

module.exports = {
  MATCHUP_OCCURRENCE_EXECUTION_GUARD_REASONS,
  classifyMatchupOccurrenceExecutionGuardError,
  createSqliteMatchupOccurrenceExecutionGuard,
};
