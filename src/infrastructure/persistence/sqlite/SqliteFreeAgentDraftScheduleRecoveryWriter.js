const {
  isDeepStrictEqual,
} = require("node:util");

const {
  UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    { details: { reasonCode } }
  );
}

function conflict(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
  );
}

function incompatible(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    { details: { reasonCode } }
  );
}

function stableId(value, description) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
  }
  return value;
}

function safeVersion(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    invalid(
      `A safe ${description} is required.`,
      "VERSION_INVALID"
    );
  }
  return value;
}

function assertSynchronous(value, description) {
  if (
    value &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
    );
  }
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sorted(values) {
  return [...values].sort(compareStrings);
}

function frozenResult(value) {
  return Object.freeze({ ...value });
}

function normalizePlan(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    plan.action !== "stage_recovery" ||
    plan.recoveryRequired !== true ||
    !["pre_open", "completion"].includes(
      plan.recoveryKind
    )
  ) {
    invalid(
      "A staged Free Agent Draft schedule-recovery plan is required.",
      "RECOVERY_PLAN_INVALID"
    );
  }

  const scope = plan.scope;
  const recovery = plan.recovery;
  const operation = plan.operation;
  const generation = plan.generation;
  if (
    !scope ||
    !recovery ||
    !operation ||
    !generation?.expectedCurrent ||
    !generation?.superseded ||
    !generation?.replacement ||
    !plan.removals ||
    !plan.recoveryChildren ||
    !plan.evidence
  ) {
    invalid(
      "The schedule-recovery plan is incomplete.",
      "RECOVERY_PLAN_INCOMPLETE"
    );
  }

  const leagueId = stableId(
    scope.leagueId,
    "recovery league identifier"
  );
  const seasonId = stableId(
    scope.seasonId,
    "recovery season identifier"
  );
  const fadId = stableId(
    scope.fadId,
    "Free Agent Draft identifier"
  );
  const recoveryId = stableId(
    recovery.id,
    "schedule-recovery identifier"
  );
  const operationId = stableId(
    operation.id,
    "schedule operation identifier"
  );
  const oldGeneration = generation.expectedCurrent;
  const newGeneration = generation.replacement;
  const completedAtMs = safeTimestamp(
    recovery.completedAtMs,
    "schedule-recovery timestamp"
  );

  for (const candidate of [
    recovery,
    operation,
    oldGeneration,
    generation.superseded,
    newGeneration,
  ]) {
    if (
      candidate.leagueId !== leagueId ||
      candidate.seasonId !== seasonId
    ) {
      invalid(
        "The schedule-recovery plan crosses league or season scope.",
        "RECOVERY_SCOPE_MISMATCH"
      );
    }
  }
  if (
    recovery.fadId !== fadId ||
    recovery.recoveryKind !== plan.recoveryKind ||
    recovery.matchupOperationId !== operationId ||
    recovery.newScheduleOperationId !== operationId ||
    newGeneration.scheduleOperationId !== operationId ||
    operation.operationType !== "schedule_generate" ||
    operation.status !== "succeeded" ||
    operation.actorUserId !== null ||
    operation.matchupWeekId !== null ||
    operation.matchupId !== null ||
    operation.startedAtMs !== completedAtMs ||
    operation.completedAtMs !== completedAtMs ||
    oldGeneration.status !== "current" ||
    oldGeneration.supersededAtMs !== null ||
    generation.superseded.status !== "superseded" ||
    generation.superseded.supersededAtMs !== completedAtMs ||
    newGeneration.status !== "current" ||
    newGeneration.supersededAtMs !== null ||
    newGeneration.createdAtMs !== completedAtMs
  ) {
    invalid(
      "The schedule-recovery generation transition is inconsistent.",
      "RECOVERY_GENERATION_INVALID"
    );
  }

  const oldScheduleVersion = safeVersion(
    oldGeneration.scheduleVersion,
    "old schedule version"
  );
  const newScheduleVersion = safeVersion(
    newGeneration.scheduleVersion,
    "new schedule version"
  );
  const oldGenerationVersion = safeVersion(
    oldGeneration.version,
    "current generation row version"
  );
  if (
    newScheduleVersion !== oldScheduleVersion + 1 ||
    recovery.oldScheduleVersion !== oldScheduleVersion ||
    recovery.newScheduleVersion !== newScheduleVersion ||
    recovery.oldScheduleOperationId !==
      oldGeneration.scheduleOperationId ||
    recovery.newScheduleOperationId !==
      newGeneration.scheduleOperationId ||
    generation.superseded.version !==
      oldGenerationVersion + 1 ||
    newGeneration.version !== 1
  ) {
    invalid(
      "The schedule-recovery versions are inconsistent.",
      "RECOVERY_VERSION_INVALID"
    );
  }

  const arrays = [
    plan.participantTeamIds,
    plan.removals.weeks,
    plan.removals.matchups,
    plan.removals.byes,
    plan.mappedWeeks,
    plan.oldJobCas,
    plan.replacementJobs,
    plan.replacementBindings,
    plan.recoveryChildren.weeks,
    plan.recoveryChildren.matchups,
    plan.recoveryChildren.jobs,
  ];
  if (
    arrays.some((value) => !Array.isArray(value)) ||
    plan.participantTeamIds.length < 2 ||
    plan.removals.weeks.length < 1 ||
    plan.mappedWeeks.length < 1
  ) {
    invalid(
      "The schedule-recovery row plan is incomplete.",
      "RECOVERY_ROWS_INVALID"
    );
  }

  const participantTeamIds = plan.participantTeamIds.map(
    (teamId) =>
      stableId(teamId, "schedule participant identifier")
  );
  if (
    new Set(participantTeamIds).size !==
      participantTeamIds.length ||
    !isDeepStrictEqual(
      participantTeamIds,
      sorted(participantTeamIds)
    )
  ) {
    invalid(
      "Schedule participants must be unique and canonical.",
      "RECOVERY_PARTICIPANTS_INVALID"
    );
  }

  const removedWeekCount = plan.removals.weeks.length;
  if (
    recovery.removedWeekCount !== removedWeekCount ||
    recovery.removedMatchupCount !==
      plan.removals.matchups.length ||
    plan.recoveryChildren.weeks.length !==
      removedWeekCount ||
    plan.recoveryChildren.matchups.length !==
      plan.removals.matchups.length ||
    plan.oldJobCas.length !==
      (removedWeekCount + plan.mappedWeeks.length) * 6 ||
    plan.recoveryChildren.jobs.length !==
      plan.oldJobCas.length ||
    recovery.cancelledJobCount !==
      removedWeekCount * 6 ||
    recovery.replacedJobCount !==
      plan.mappedWeeks.length * 6 ||
    plan.replacementJobs.length !==
      recovery.replacedJobCount ||
    plan.replacementBindings.length !==
      recovery.replacedJobCount
  ) {
    invalid(
      "The schedule-recovery counts are inconsistent.",
      "RECOVERY_COUNTS_INVALID"
    );
  }

  const removedWeekIds = new Set();
  for (
    let index = 0;
    index < plan.removals.weeks.length;
    index += 1
  ) {
    const week = plan.removals.weeks[index];
    stableId(week.id, "removed matchup week identifier");
    if (
      week.leagueId !== leagueId ||
      week.seasonId !== seasonId ||
      week.sequence !== index + 1 ||
      week.expectedStatus !== "scheduled" ||
      removedWeekIds.has(week.id)
    ) {
      invalid(
        "Removed matchup weeks must be one exact prefix.",
        "REMOVED_WEEK_PREFIX_INVALID"
      );
    }
    safeVersion(week.expectedVersion, "removed week version");
    safeTimestamp(week.startsAtMs, "removed week start");
    removedWeekIds.add(week.id);
  }

  const recoveryWeekChildIds = new Set();
  const actualRemovedWeekEvidence =
    plan.recoveryChildren.weeks
      .map((child) => {
        stableId(
          child.id,
          "removed-week evidence identifier"
        );
        stableId(
          child.removedMatchupWeekId,
          "evidenced removed matchup week identifier"
        );
        if (
          child.leagueId !== leagueId ||
          child.seasonId !== seasonId ||
          child.scheduleRecoveryId !== recoveryId ||
          child.createdAtMs !== completedAtMs ||
          recoveryWeekChildIds.has(child.id)
        ) {
          invalid(
            "Removed-week recovery evidence is inconsistent.",
            "RECOVERY_REMOVED_WEEK_EVIDENCE_INVALID"
          );
        }
        recoveryWeekChildIds.add(child.id);
        safeTimestamp(
          child.removedStartsAtMs,
          "evidenced removed week start"
        );
        return {
          removedMatchupWeekId:
            child.removedMatchupWeekId,
          removedSequence: child.removedSequence,
          removedStartsAtMs: child.removedStartsAtMs,
        };
      })
      .sort(
        (left, right) =>
          left.removedSequence -
            right.removedSequence ||
          compareStrings(
            left.removedMatchupWeekId,
            right.removedMatchupWeekId
          )
      );
  const expectedRemovedWeekEvidence =
    plan.removals.weeks
      .map((week) => ({
        removedMatchupWeekId: week.id,
        removedSequence: week.sequence,
        removedStartsAtMs: week.startsAtMs,
      }))
      .sort(
        (left, right) =>
          left.removedSequence -
            right.removedSequence ||
          compareStrings(
            left.removedMatchupWeekId,
            right.removedMatchupWeekId
          )
      );
  if (
    !isDeepStrictEqual(
      actualRemovedWeekEvidence,
      expectedRemovedWeekEvidence
    )
  ) {
    invalid(
      "Removed-week recovery evidence does not identify the matchup weeks being deleted.",
      "RECOVERY_REMOVED_WEEK_EVIDENCE_MISMATCH"
    );
  }

  const recoveryMatchupChildIds = new Set();
  const actualRemovedMatchupEvidence =
    plan.recoveryChildren.matchups
      .map((child) => {
        stableId(
          child.id,
          "removed-matchup evidence identifier"
        );
        stableId(
          child.removedMatchupId,
          "evidenced removed matchup identifier"
        );
        stableId(
          child.removedMatchupWeekId,
          "evidenced matchup-week identifier"
        );
        if (
          child.leagueId !== leagueId ||
          child.seasonId !== seasonId ||
          child.scheduleRecoveryId !== recoveryId ||
          child.createdAtMs !== completedAtMs ||
          child.version !== 1 ||
          recoveryMatchupChildIds.has(child.id)
        ) {
          invalid(
            "Removed-matchup recovery evidence is inconsistent.",
            "RECOVERY_REMOVED_MATCHUP_EVIDENCE_INVALID"
          );
        }
        recoveryMatchupChildIds.add(child.id);
        return {
          removedMatchupId: child.removedMatchupId,
          removedMatchupWeekId:
            child.removedMatchupWeekId,
        };
      })
      .sort(
        (left, right) =>
          compareStrings(
            left.removedMatchupId,
            right.removedMatchupId
          ) ||
          compareStrings(
            left.removedMatchupWeekId,
            right.removedMatchupWeekId
          )
      );
  const expectedRemovedMatchupEvidence =
    plan.removals.matchups
      .map((matchup) => ({
        removedMatchupId: matchup.id,
        removedMatchupWeekId: matchup.weekId,
      }))
      .sort(
        (left, right) =>
          compareStrings(
            left.removedMatchupId,
            right.removedMatchupId
          ) ||
          compareStrings(
            left.removedMatchupWeekId,
            right.removedMatchupWeekId
          )
      );
  if (
    !isDeepStrictEqual(
      actualRemovedMatchupEvidence,
      expectedRemovedMatchupEvidence
    )
  ) {
    invalid(
      "Removed-matchup recovery evidence does not identify the matchups being deleted.",
      "RECOVERY_REMOVED_MATCHUP_EVIDENCE_MISMATCH"
    );
  }

  const mappedWeekIds = new Set();
  let mappedMatchupCount = 0;
  let mappedByeCount = 0;
  for (
    let index = 0;
    index < plan.mappedWeeks.length;
    index += 1
  ) {
    const week = plan.mappedWeeks[index];
    stableId(week.id, "retained matchup week identifier");
    if (
      week.leagueId !== leagueId ||
      week.seasonId !== seasonId ||
      week.previousSequence !==
        index + removedWeekCount + 1 ||
      week.sequence !== index + 1 ||
      week.weekKey !==
        `regular-${String(index + 1).padStart(2, "0")}` ||
      week.version !== week.expectedVersion + 1 ||
      week.updatedAtMs !== completedAtMs ||
      week.status !== "scheduled" ||
      week.startsAtMs !== week.previousStartsAtMs ||
      week.baselineAtMs !== week.previousBaselineAtMs ||
      week.locksAtMs !== week.previousLocksAtMs ||
      week.endsAtMs !== week.previousEndsAtMs ||
      week.rollsOverAtMs !== week.previousRollsOverAtMs ||
      removedWeekIds.has(week.id) ||
      mappedWeekIds.has(week.id) ||
      !Array.isArray(week.matchups) ||
      week.matchups.length < 1
    ) {
      invalid(
        "A retained matchup week is inconsistent.",
        "RETAINED_WEEK_INVALID"
      );
    }
    safeVersion(week.expectedVersion, "retained week version");
    const participants = [];
    for (const matchup of week.matchups) {
      stableId(matchup.id, "retained matchup identifier");
      stableId(matchup.homeTeamId, "home team identifier");
      stableId(matchup.awayTeamId, "away team identifier");
      if (
        matchup.leagueId !== leagueId ||
        matchup.seasonId !== seasonId ||
        matchup.weekId !== week.id ||
        matchup.homeTeamId === matchup.awayTeamId ||
        matchup.version !== matchup.expectedVersion + 1 ||
        matchup.updatedAtMs !== completedAtMs ||
        matchup.status !== "scheduled"
      ) {
        invalid(
          "A retained matchup is inconsistent.",
          "RETAINED_MATCHUP_INVALID"
        );
      }
      safeVersion(
        matchup.expectedVersion,
        "retained matchup version"
      );
      participants.push(
        matchup.homeTeamId,
        matchup.awayTeamId
      );
    }
    if (week.bye !== null) {
      stableId(week.bye.id, "retained bye identifier");
      stableId(week.bye.teamId, "retained bye team identifier");
      if (
        week.bye.leagueId !== leagueId ||
        week.bye.seasonId !== seasonId ||
        week.bye.weekId !== week.id
      ) {
        invalid(
          "A retained bye is inconsistent.",
          "RETAINED_BYE_INVALID"
        );
      }
      participants.push(week.bye.teamId);
      mappedByeCount += 1;
    }
    if (
      !isDeepStrictEqual(
        sorted(participants),
        participantTeamIds
      )
    ) {
      invalid(
        "A recovered week changed schedule participants.",
        "RECOVERY_PARTICIPANT_SET_CHANGED"
      );
    }
    mappedMatchupCount += week.matchups.length;
    mappedWeekIds.add(week.id);
  }

  if (
    recovery.oldFirstMatchupWeekId !==
      plan.removals.weeks[0].id ||
    recovery.newFirstMatchupWeekId !==
      plan.mappedWeeks[0].id ||
    recovery.oldWeekOneStartsAtMs !==
      plan.removals.weeks[0].startsAtMs ||
    recovery.newWeekOneStartsAtMs !==
      plan.mappedWeeks[0].startsAtMs ||
    oldGeneration.weekOneMatchupWeekId !==
      recovery.oldFirstMatchupWeekId ||
    oldGeneration.weekOneStartsAtMs !==
      recovery.oldWeekOneStartsAtMs ||
    newGeneration.weekOneMatchupWeekId !==
      recovery.newFirstMatchupWeekId ||
    newGeneration.weekOneStartsAtMs !==
      recovery.newWeekOneStartsAtMs ||
    recovery.oldFirstMatchupWeekId ===
      recovery.newFirstMatchupWeekId ||
    recovery.oldWeekOneStartsAtMs >=
      recovery.newWeekOneStartsAtMs
  ) {
    invalid(
      "The schedule-recovery Week 1 transition is inconsistent.",
      "RECOVERY_WEEK_ONE_INVALID"
    );
  }

  if (
    !DIGEST_PATTERN.test(recovery.evidenceSha256 || "") ||
    recovery.evidenceSha256 !==
      plan.evidence.evidenceSha256 ||
    plan.evidence.preimage?.recoveryId !== recoveryId ||
    plan.evidence.preimage?.fadId !== fadId
  ) {
    invalid(
      "The schedule-recovery evidence seal is inconsistent.",
      "RECOVERY_EVIDENCE_INVALID"
    );
  }

  return Object.freeze({
    plan,
    leagueId,
    seasonId,
    fadId,
    recoveryId,
    operationId,
    completedAtMs,
    oldScheduleVersion,
    newScheduleVersion,
    oldGenerationVersion,
    participantTeamIds,
    removedWeekIds,
    mappedWeekIds,
    expectedWeekCount: plan.mappedWeeks.length,
    expectedMatchupCount: mappedMatchupCount,
    expectedByeCount: mappedByeCount,
  });
}

function createSqliteFreeAgentDraftScheduleRecoveryWriter({
  database,
  afterStep,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftScheduleRecoveryWriter requires an opened database"
    );
  }
  if (
    afterStep !== undefined &&
    typeof afterStep !== "function"
  ) {
    throw new TypeError(
      "FAD schedule-recovery afterStep must be a function"
    );
  }

  let activeTeams;
  let seasonState;
  let generationState;
  let scheduleWeeks;
  let scheduleMatchups;
  let scheduleByes;
  let generationJobs;
  let rootById;
  let rootByScope;
  let childCounts;
  let preOpenStageLifecycle;
  let preOpenSealLifecycle;
  let completionLifecycle;
  let updateSeason;
  let insertWeekEvidence;
  let insertMatchupEvidence;
  let skipOldJob;
  let deleteMatchup;
  let deleteBye;
  let deleteWeek;
  let updateRetainedWeek;
  let insertRetainedMatchup;
  let insertRetainedBye;
  let supersedeGeneration;
  let insertOperation;
  let insertGeneration;
  let insertJob;
  let insertBinding;
  let insertJobEvidence;
  let evidenceWeeks;
  let evidenceMatchups;
  let evidenceJobs;
  let insertRecoveryRoot;
  let reconciliationCounts;

  try {
    activeTeams = database.prepare(`
      SELECT id, name
      FROM teams
      WHERE league_id = @leagueId
        AND status = 'active'
      ORDER BY id
    `);
    seasonState = database.prepare(`
      SELECT
        status,
        regular_season_starts_at_ms,
        regular_season_ends_at_ms,
        fantasy_playoffs_start_at_ms,
        fantasy_playoffs_end_at_ms,
        updated_at_ms,
        version
      FROM seasons
      WHERE league_id = @leagueId
        AND id = @seasonId
      LIMIT 2
    `);
    generationState = database.prepare(`
      SELECT
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      FROM season_matchup_schedule_generations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY schedule_version
    `);
    scheduleWeeks = database.prepare(`
      SELECT *
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY sequence, id
    `);
    scheduleMatchups = database.prepare(`
      SELECT *
      FROM matchups
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY matchup_week_id, id
    `);
    scheduleByes = database.prepare(`
      SELECT *
      FROM matchup_byes
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY matchup_week_id, id
    `);
    generationJobs = database.prepare(`
      SELECT
        job_runs.id,
        job_runs.job_type,
        job_runs.occurrence_key,
        job_runs.scheduled_for_ms,
        job_runs.status,
        job_runs.attempt_count,
        job_runs.lease_owner,
        job_runs.lease_token,
        job_runs.lease_expires_at_ms,
        job_runs.started_at_ms,
        job_runs.completed_at_ms,
        job_runs.result_json,
        job_runs.last_error_code,
        job_runs.created_at_ms,
        job_runs.updated_at_ms,
        job_runs.version,
        job_runs.next_attempt_at_ms,
        binding.id AS binding_id,
        binding.schedule_operation_id,
        binding.schedule_version,
        binding.owning_matchup_week_id,
        binding.owning_matchup_id,
        binding.created_at_ms AS binding_created_at_ms,
        binding.version AS binding_version
      FROM matchup_schedule_job_bindings AS binding
      JOIN job_runs
        ON job_runs.league_id = binding.league_id
       AND job_runs.id = binding.job_run_id
      WHERE binding.league_id = @leagueId
        AND binding.season_id = @seasonId
        AND binding.schedule_operation_id = @oldScheduleOperationId
        AND binding.schedule_version = @oldScheduleVersion
      ORDER BY job_runs.id
    `);
    rootById = database.prepare(`
      SELECT *
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = @leagueId
        AND id = @recoveryId
      LIMIT 2
    `);
    rootByScope = database.prepare(`
      SELECT id
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND recovery_kind = @recoveryKind
      LIMIT 2
    `);
    childCounts = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM free_agent_draft_schedule_recovery_weeks
          WHERE league_id = @leagueId
            AND schedule_recovery_id = @recoveryId
        ) AS week_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_schedule_recovery_matchups
          WHERE league_id = @leagueId
            AND schedule_recovery_id = @recoveryId
        ) AS matchup_count,
        (
          SELECT COUNT(*)
          FROM free_agent_draft_schedule_recovery_jobs
          WHERE league_id = @leagueId
            AND schedule_recovery_id = @recoveryId
        ) AS job_count
    `);
    preOpenStageLifecycle = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM free_agent_draft_readiness_operations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND status = 'running'
            AND created_fad_id IS NULL
        ) AS readiness_count,
        (
          SELECT COUNT(*)
          FROM free_agent_drafts
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS fad_count
    `);
    preOpenSealLifecycle = database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_drafts AS fad
      JOIN free_agent_draft_readiness_operations AS readiness
        ON readiness.league_id = fad.league_id
       AND readiness.id = fad.readiness_operation_id
      WHERE fad.league_id = @leagueId
        AND fad.season_id = @seasonId
        AND fad.id = @fadId
        AND fad.status = 'cards_open'
        AND fad.first_matchup_week_id = @newFirstMatchupWeekId
        AND fad.current_competition_first_matchup_week_id =
          @newFirstMatchupWeekId
        AND fad.schedule_recovery_id IS NULL
        AND readiness.status = 'running'
        AND readiness.created_fad_id IS NULL
    `);
    completionLifecycle = database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @fadId
        AND status = 'rapid'
        AND first_matchup_week_id = @oldFirstMatchupWeekId
        AND current_competition_first_matchup_week_id =
          @oldFirstMatchupWeekId
        AND schedule_recovery_id IS NULL
        AND completed_at_ms IS NULL
    `);
    updateSeason = database.prepare(`
      UPDATE seasons
      SET
        updated_at_ms = @completedAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND status IN ('planned', 'active')
        AND regular_season_starts_at_ms =
          @nhlRegularSeasonStartsAtMs
        AND regular_season_ends_at_ms =
          @nhlRegularSeasonEndsAtMs
        AND fantasy_playoffs_start_at_ms =
          @fantasyPlayoffsStartAtMs
        AND fantasy_playoffs_end_at_ms =
          @fantasyPlayoffsEndAtMs
        AND updated_at_ms <= @completedAtMs
        AND version = @expectedSeasonVersion
    `);
    insertWeekEvidence = database.prepare(`
      INSERT INTO free_agent_draft_schedule_recovery_weeks (
        id,
        league_id,
        season_id,
        schedule_recovery_id,
        removed_matchup_week_id,
        removed_sequence,
        removed_starts_at_ms,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @scheduleRecoveryId,
        @removedMatchupWeekId,
        @removedSequence,
        @removedStartsAtMs,
        @createdAtMs
      )
    `);
    insertMatchupEvidence = database.prepare(`
      INSERT INTO free_agent_draft_schedule_recovery_matchups (
        id,
        league_id,
        season_id,
        schedule_recovery_id,
        removed_matchup_id,
        removed_matchup_week_id,
        created_at_ms,
        version
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @scheduleRecoveryId,
        @removedMatchupId,
        @removedMatchupWeekId,
        @createdAtMs,
        @version
      )
    `);
    skipOldJob = database.prepare(`
      UPDATE job_runs
      SET
        status = 'skipped',
        next_attempt_at_ms = NULL,
        updated_at_ms = @resultingUpdatedAtMs,
        version = version + 1
      WHERE id = @jobRunId
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND job_type = @jobType
        AND occurrence_key = @expectedOccurrenceKey
        AND scheduled_for_ms = @expectedScheduledForMs
        AND status = @expectedStatus
        AND attempt_count = @expectedAttemptCount
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at_ms IS NULL
        AND started_at_ms IS NULL
        AND completed_at_ms IS NULL
        AND result_json IS NULL
        AND last_error_code IS NULL
        AND created_at_ms = @expectedCreatedAtMs
        AND updated_at_ms = @expectedUpdatedAtMs
        AND next_attempt_at_ms = @expectedNextAttemptAtMs
        AND version = @expectedJobVersion
        AND EXISTS (
          SELECT 1
          FROM matchup_schedule_job_bindings AS binding
          WHERE binding.league_id = job_runs.league_id
            AND binding.season_id = job_runs.season_id
            AND binding.id = @bindingId
            AND binding.job_run_id = job_runs.id
            AND binding.job_type = @expectedBindingJobType
            AND binding.schedule_operation_id =
              @expectedBindingScheduleOperationId
            AND binding.schedule_version =
              @expectedBindingScheduleVersion
            AND binding.owning_matchup_week_id =
              @expectedBindingOwningMatchupWeekId
            AND binding.owning_matchup_id IS NULL
            AND binding.created_at_ms =
              @expectedBindingCreatedAtMs
            AND binding.version = @expectedBindingVersion
        )
    `);
    deleteMatchup = database.prepare(`
      DELETE FROM matchups
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND matchup_week_id = @weekId
        AND home_team_id = @homeTeamId
        AND away_team_id = @awayTeamId
        AND status = 'scheduled'
        AND version = @expectedVersion
    `);
    deleteBye = database.prepare(`
      DELETE FROM matchup_byes
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND matchup_week_id = @weekId
        AND team_id = @teamId
    `);
    deleteWeek = database.prepare(`
      DELETE FROM matchup_weeks
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND week_key = @weekKey
        AND sequence = @sequence
        AND starts_at_ms = @startsAtMs
        AND baseline_at_ms = @baselineAtMs
        AND locks_at_ms = @locksAtMs
        AND ends_at_ms = @endsAtMs
        AND rolls_over_at_ms = @rollsOverAtMs
        AND status = @expectedStatus
        AND version = @expectedVersion
    `);
    updateRetainedWeek = database.prepare(`
      UPDATE matchup_weeks
      SET
        week_key = @weekKey,
        sequence = @sequence,
        starts_at_ms = @startsAtMs,
        baseline_at_ms = @baselineAtMs,
        locks_at_ms = @locksAtMs,
        ends_at_ms = @endsAtMs,
        rolls_over_at_ms = @rollsOverAtMs,
        status = @status,
        updated_at_ms = @updatedAtMs,
        version = @version
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND week_key = @previousWeekKey
        AND sequence = @previousSequence
        AND starts_at_ms = @previousStartsAtMs
        AND baseline_at_ms = @previousBaselineAtMs
        AND locks_at_ms = @previousLocksAtMs
        AND ends_at_ms = @previousEndsAtMs
        AND rolls_over_at_ms = @previousRollsOverAtMs
        AND status = 'scheduled'
        AND version = @expectedVersion
    `);
    insertRetainedMatchup = database.prepare(`
      INSERT INTO matchups (
        id,
        league_id,
        season_id,
        matchup_week_id,
        home_team_id,
        away_team_id,
        home_team_name,
        away_team_name,
        status,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @weekId,
        @homeTeamId,
        @awayTeamId,
        @homeTeamName,
        @awayTeamName,
        'scheduled',
        @createdAtMs,
        @updatedAtMs,
        @version
      )
    `);
    insertRetainedBye = database.prepare(`
      INSERT INTO matchup_byes (
        id,
        league_id,
        season_id,
        matchup_week_id,
        team_id,
        team_display_name,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @weekId,
        @teamId,
        @teamDisplayName,
        @createdAtMs
      )
    `);
    supersedeGeneration = database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET
        status = 'superseded',
        superseded_at_ms = @completedAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND schedule_operation_id = @oldScheduleOperationId
        AND schedule_version = @oldScheduleVersion
        AND week_one_matchup_week_id = @oldFirstMatchupWeekId
        AND week_one_starts_at_ms = @oldWeekOneStartsAtMs
        AND status = 'current'
        AND superseded_at_ms IS NULL
        AND version = @oldGenerationVersion
    `);
    insertOperation = database.prepare(`
      INSERT INTO matchup_operations (
        id,
        league_id,
        season_id,
        matchup_week_id,
        matchup_id,
        actor_user_id,
        operation_type,
        status,
        reason,
        metadata_json,
        started_at_ms,
        completed_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        NULL,
        NULL,
        NULL,
        'schedule_generate',
        'succeeded',
        @reason,
        @metadataJson,
        @startedAtMs,
        @completedAtMs
      )
    `);
    insertGeneration = database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      ) VALUES (
        @leagueId,
        @seasonId,
        @scheduleVersion,
        @scheduleOperationId,
        @weekOneMatchupWeekId,
        @weekOneStartsAtMs,
        'current',
        @createdAtMs,
        NULL,
        1
      )
    `);
    insertJob = database.prepare(`
      INSERT INTO job_runs (
        id,
        league_id,
        season_id,
        job_type,
        occurrence_key,
        scheduled_for_ms,
        status,
        attempt_count,
        lease_owner,
        lease_expires_at_ms,
        started_at_ms,
        completed_at_ms,
        result_json,
        last_error_code,
        created_at_ms,
        updated_at_ms,
        version,
        lease_token,
        next_attempt_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @jobType,
        @occurrenceKey,
        @scheduledForMs,
        'pending',
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @createdAtMs,
        @updatedAtMs,
        1,
        NULL,
        @nextAttemptAtMs
      )
    `);
    insertBinding = database.prepare(`
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
        @id,
        @leagueId,
        @seasonId,
        @jobRunId,
        @jobType,
        @scheduleOperationId,
        @scheduleVersion,
        @owningMatchupWeekId,
        @owningMatchupId,
        @createdAtMs,
        @version
      )
    `);
    insertJobEvidence = database.prepare(`
      INSERT INTO free_agent_draft_schedule_recovery_jobs (
        id,
        league_id,
        season_id,
        schedule_recovery_id,
        disposition,
        job_type,
        replaced_job_run_id,
        replacement_job_run_id,
        replaced_occurrence_key,
        replacement_occurrence_key,
        replaced_schedule_operation_id,
        replaced_schedule_version,
        replacement_schedule_operation_id,
        replacement_schedule_version,
        replaced_job_version,
        replacement_job_version,
        created_at_ms,
        version
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @scheduleRecoveryId,
        @disposition,
        @jobType,
        @replacedJobRunId,
        @replacementJobRunId,
        @replacedOccurrenceKey,
        @replacementOccurrenceKey,
        @replacedScheduleOperationId,
        @replacedScheduleVersion,
        @replacementScheduleOperationId,
        @replacementScheduleVersion,
        @replacedJobVersion,
        @replacementJobVersion,
        @createdAtMs,
        @version
      )
    `);
    evidenceWeeks = database.prepare(`
      SELECT *
      FROM free_agent_draft_schedule_recovery_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND schedule_recovery_id = @recoveryId
      ORDER BY id
    `);
    evidenceMatchups = database.prepare(`
      SELECT
        removed_matchup.id,
        removed_matchup.league_id,
        removed_matchup.season_id,
        removed_matchup.schedule_recovery_id,
        removed_matchup.removed_matchup_id,
        removed_matchup.removed_matchup_week_id,
        removed_matchup.created_at_ms,
        removed_matchup.version
      FROM free_agent_draft_schedule_recovery_matchups AS removed_matchup
      JOIN free_agent_draft_schedule_recovery_weeks AS removed_week
        ON removed_week.league_id = removed_matchup.league_id
       AND removed_week.season_id = removed_matchup.season_id
       AND removed_week.schedule_recovery_id =
          removed_matchup.schedule_recovery_id
       AND removed_week.removed_matchup_week_id =
          removed_matchup.removed_matchup_week_id
      WHERE removed_matchup.league_id = @leagueId
        AND removed_matchup.season_id = @seasonId
        AND removed_matchup.schedule_recovery_id = @recoveryId
      ORDER BY removed_matchup.id
    `);
    evidenceJobs = database.prepare(`
      SELECT *
      FROM free_agent_draft_schedule_recovery_jobs
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND schedule_recovery_id = @recoveryId
      ORDER BY id
    `);
    insertRecoveryRoot = database.prepare(`
      INSERT INTO free_agent_draft_schedule_recoveries (
        id,
        league_id,
        season_id,
        fad_id,
        recovery_kind,
        matchup_operation_id,
        old_schedule_operation_id,
        new_schedule_operation_id,
        old_first_matchup_week_id,
        new_first_matchup_week_id,
        old_schedule_version,
        new_schedule_version,
        old_week_one_starts_at_ms,
        new_week_one_starts_at_ms,
        removed_week_count,
        removed_matchup_count,
        replaced_job_count,
        cancelled_job_count,
        completed_at_ms,
        evidence_schema_version,
        evidence_sha256,
        created_at_ms,
        version
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @fadId,
        @recoveryKind,
        @matchupOperationId,
        @oldScheduleOperationId,
        @newScheduleOperationId,
        @oldFirstMatchupWeekId,
        @newFirstMatchupWeekId,
        @oldScheduleVersion,
        @newScheduleVersion,
        @oldWeekOneStartsAtMs,
        @newWeekOneStartsAtMs,
        @removedWeekCount,
        @removedMatchupCount,
        @replacedJobCount,
        @cancelledJobCount,
        @completedAtMs,
        @evidenceSchemaVersion,
        @evidenceSha256,
        @createdAtMs,
        @version
      )
    `);
    reconciliationCounts = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM matchup_weeks
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS week_count,
        (
          SELECT COUNT(*)
          FROM matchups
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS matchup_count,
        (
          SELECT COUNT(*)
          FROM matchup_byes
          WHERE league_id = @leagueId
            AND season_id = @seasonId
        ) AS bye_count,
        (
          SELECT COUNT(*)
          FROM season_matchup_schedule_generations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND schedule_operation_id = @oldScheduleOperationId
            AND schedule_version = @oldScheduleVersion
            AND status = 'superseded'
            AND superseded_at_ms = @completedAtMs
        ) AS old_generation_count,
        (
          SELECT COUNT(*)
          FROM season_matchup_schedule_generations
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND schedule_operation_id = @newScheduleOperationId
            AND schedule_version = @newScheduleVersion
            AND status = 'current'
            AND week_one_matchup_week_id = @newFirstMatchupWeekId
        ) AS new_generation_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND id IN (
              SELECT replaced_job_run_id
              FROM free_agent_draft_schedule_recovery_jobs
              WHERE league_id = @leagueId
                AND schedule_recovery_id = @recoveryId
            )
            AND status = 'skipped'
        ) AS skipped_job_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND id IN (
              SELECT replacement_job_run_id
              FROM free_agent_draft_schedule_recovery_jobs
              WHERE league_id = @leagueId
                AND schedule_recovery_id = @recoveryId
                AND replacement_job_run_id IS NOT NULL
            )
            AND status = 'pending'
        ) AS replacement_job_count,
        (
          SELECT COUNT(*)
          FROM job_runs
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND job_type LIKE 'matchup:%'
            AND NOT EXISTS (
              SELECT 1
              FROM matchup_schedule_job_bindings AS binding
              WHERE binding.league_id = job_runs.league_id
                AND binding.job_run_id = job_runs.id
            )
        ) AS unbound_job_count
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareFreeAgentDraftScheduleRecoveryWriter",
      tableName:
        "free_agent_draft_schedule_recoveries",
    });
  }

  function step(name) {
    if (afterStep) {
      assertSynchronous(
        afterStep(name),
        "FAD schedule-recovery afterStep"
      );
    }
  }

  function requireTransaction() {
    if (database.inTransaction !== true) {
      invalid(
        "FAD schedule recovery requires an immediate outer transaction.",
        "OUTER_TRANSACTION_REQUIRED"
      );
    }
  }

  function scopeParameters(normalized) {
    return {
      leagueId: normalized.leagueId,
      seasonId: normalized.seasonId,
      fadId: normalized.fadId,
      recoveryId: normalized.recoveryId,
      recoveryKind: normalized.plan.recoveryKind,
      oldScheduleOperationId:
        normalized.plan.recovery.oldScheduleOperationId,
      newScheduleOperationId:
        normalized.plan.recovery.newScheduleOperationId,
      oldScheduleVersion:
        normalized.oldScheduleVersion,
      newScheduleVersion:
        normalized.newScheduleVersion,
      oldFirstMatchupWeekId:
        normalized.plan.recovery.oldFirstMatchupWeekId,
      newFirstMatchupWeekId:
        normalized.plan.recovery.newFirstMatchupWeekId,
      completedAtMs: normalized.completedAtMs,
    };
  }

  function assertLifecycle(normalized, phase) {
    const parameters = scopeParameters(normalized);
    if (normalized.plan.recoveryKind === "pre_open") {
      if (phase === "stage") {
        const state = preOpenStageLifecycle.get(parameters);
        if (
          state.readiness_count !== 1 ||
          state.fad_count !== 0
        ) {
          conflict(
            "Pre-open schedule recovery no longer owns one running readiness operation before FAD creation.",
            "PRE_OPEN_LIFECYCLE_CHANGED"
          );
        }
      } else if (
        preOpenSealLifecycle.get(parameters).count !== 1
      ) {
        conflict(
          "Pre-open schedule recovery cannot seal without its cards-open FAD and running readiness operation.",
          "PRE_OPEN_SEAL_LIFECYCLE_CHANGED"
        );
      }
      return;
    }
    if (completionLifecycle.get(parameters).count !== 1) {
      conflict(
        "Completion schedule recovery no longer owns the rapid FAD at its frozen Week 1.",
        "COMPLETION_LIFECYCLE_CHANGED"
      );
    }
  }

  function rootRecord(normalized) {
    return rootById.get(scopeParameters(normalized));
  }

  function assertNoConflictingRoot(normalized) {
    const scoped = rootByScope.all(
      scopeParameters(normalized)
    );
    if (
      scoped.length > 0 &&
      scoped.some(({ id }) => id !== normalized.recoveryId)
    ) {
      conflict(
        "Another recovery already owns this FAD lifecycle transition.",
        "RECOVERY_SCOPE_ALREADY_SEALED"
      );
    }
  }

  function assertBaseline(normalized) {
    const { plan } = normalized;
    const parameters = scopeParameters(normalized);
    const teams = activeTeams.all(parameters);
    if (
      !isDeepStrictEqual(
        teams.map(({ id }) => id),
        normalized.participantTeamIds
      )
    ) {
      conflict(
        "Active schedule participants changed before recovery.",
        "RECOVERY_PARTICIPANTS_CHANGED"
      );
    }

    const seasonRows = seasonState.all(parameters);
    if (seasonRows.length !== 1) {
      conflict(
        "The recovery season changed.",
        "RECOVERY_SEASON_CHANGED"
      );
    }
    const season = seasonRows[0];
    const calendar = plan.calendar;
    if (
      !["planned", "active"].includes(season.status) ||
      season.regular_season_starts_at_ms !==
        calendar.nhlRegularSeasonStartsAtMs ||
      season.regular_season_ends_at_ms !==
        calendar.nhlRegularSeasonEndsAtMs ||
      season.fantasy_playoffs_start_at_ms !==
        calendar.fantasyPlayoffsStartAtMs ||
      season.fantasy_playoffs_end_at_ms !==
        calendar.fantasyPlayoffsEndAtMs ||
      season.updated_at_ms > normalized.completedAtMs
    ) {
      conflict(
        "The recovery season calendar changed.",
        "RECOVERY_CALENDAR_CHANGED"
      );
    }

    const generations = generationState.all(parameters);
    const current = generations.filter(
      ({ status }) => status === "current"
    );
    const expected = plan.generation.expectedCurrent;
    if (
      current.length !== 1 ||
      current[0].schedule_version !==
        expected.scheduleVersion ||
      current[0].schedule_operation_id !==
        expected.scheduleOperationId ||
      current[0].week_one_matchup_week_id !==
        expected.weekOneMatchupWeekId ||
      current[0].week_one_starts_at_ms !==
        expected.weekOneStartsAtMs ||
      current[0].superseded_at_ms !== null ||
      current[0].version !== expected.version
    ) {
      conflict(
        "The current schedule generation changed before recovery.",
        "RECOVERY_GENERATION_CHANGED"
      );
    }

    const expectedWeeks = [
      ...plan.removals.weeks.map((week) => ({
        id: week.id,
        week_key: week.weekKey,
        sequence: week.sequence,
        starts_at_ms: week.startsAtMs,
        baseline_at_ms: week.baselineAtMs,
        locks_at_ms: week.locksAtMs,
        ends_at_ms: week.endsAtMs,
        rolls_over_at_ms: week.rollsOverAtMs,
        status: week.expectedStatus,
        version: week.expectedVersion,
      })),
      ...plan.mappedWeeks.map((week) => ({
        id: week.id,
        week_key: week.previousWeekKey,
        sequence: week.previousSequence,
        starts_at_ms: week.previousStartsAtMs,
        baseline_at_ms: week.previousBaselineAtMs,
        locks_at_ms: week.previousLocksAtMs,
        ends_at_ms: week.previousEndsAtMs,
        rolls_over_at_ms: week.previousRollsOverAtMs,
        status: "scheduled",
        version: week.expectedVersion,
      })),
    ].sort((left, right) => left.sequence - right.sequence);
    const actualWeeks = scheduleWeeks.all(parameters).map(
      (week) => ({
        id: week.id,
        week_key: week.week_key,
        sequence: week.sequence,
        starts_at_ms: week.starts_at_ms,
        baseline_at_ms: week.baseline_at_ms,
        locks_at_ms: week.locks_at_ms,
        ends_at_ms: week.ends_at_ms,
        rolls_over_at_ms: week.rolls_over_at_ms,
        status: week.status,
        version: week.version,
      })
    );
    if (!isDeepStrictEqual(actualWeeks, expectedWeeks)) {
      conflict(
        "The matchup weeks changed before recovery.",
        "RECOVERY_WEEKS_CHANGED"
      );
    }

    const expectedMatchups = [
      ...plan.removals.matchups.map((matchup) => ({
        id: matchup.id,
        matchup_week_id: matchup.weekId,
        home_team_id: matchup.homeTeamId,
        away_team_id: matchup.awayTeamId,
        status: matchup.expectedStatus,
        version: matchup.expectedVersion,
      })),
      ...plan.mappedWeeks.flatMap((week) =>
        week.matchups.map((matchup) => ({
          id: matchup.id,
          matchup_week_id: matchup.weekId,
          home_team_id: matchup.previousHomeTeamId,
          away_team_id: matchup.previousAwayTeamId,
          status: "scheduled",
          version: matchup.expectedVersion,
        }))
      ),
    ].sort((left, right) => compareStrings(left.id, right.id));
    const actualMatchups = scheduleMatchups.all(parameters)
      .map((matchup) => ({
        id: matchup.id,
        matchup_week_id: matchup.matchup_week_id,
        home_team_id: matchup.home_team_id,
        away_team_id: matchup.away_team_id,
        status: matchup.status,
        version: matchup.version,
      }))
      .sort((left, right) => compareStrings(left.id, right.id));
    if (!isDeepStrictEqual(actualMatchups, expectedMatchups)) {
      conflict(
        "The matchups changed before recovery.",
        "RECOVERY_MATCHUPS_CHANGED"
      );
    }

    const expectedByes = [
      ...plan.removals.byes.map((bye) => ({
        id: bye.id,
        matchup_week_id: bye.weekId,
        team_id: bye.teamId,
      })),
      ...plan.mappedWeeks
        .filter(({ bye }) => bye !== null)
        .map(({ bye }) => ({
          id: bye.id,
          matchup_week_id: bye.weekId,
          team_id: bye.previousTeamId,
        })),
    ].sort((left, right) => compareStrings(left.id, right.id));
    const actualByes = scheduleByes.all(parameters)
      .map((bye) => ({
        id: bye.id,
        matchup_week_id: bye.matchup_week_id,
        team_id: bye.team_id,
      }))
      .sort((left, right) => compareStrings(left.id, right.id));
    if (!isDeepStrictEqual(actualByes, expectedByes)) {
      conflict(
        "The matchup byes changed before recovery.",
        "RECOVERY_BYES_CHANGED"
      );
    }

    const jobs = generationJobs.all(parameters);
    if (
      jobs.length !== plan.oldJobCas.length ||
      !isDeepStrictEqual(
        jobs.map(({ id }) => id).sort(compareStrings),
        plan.oldJobCas
          .map(({ jobRunId }) => jobRunId)
          .sort(compareStrings)
      )
    ) {
      conflict(
        "The current generation job set changed before recovery.",
        "RECOVERY_JOB_SET_CHANGED"
      );
    }

    return Object.freeze({
      seasonVersion: season.version,
      teams,
      matchupRows: new Map(
        scheduleMatchups
          .all(parameters)
          .map((row) => [row.id, row])
      ),
      byeRows: new Map(
        scheduleByes
          .all(parameters)
          .map((row) => [row.id, row])
      ),
    });
  }

  function assertEvidenceChildren(normalized) {
    const counts = childCounts.get(
      scopeParameters(normalized)
    );
    if (
      counts.week_count !==
        normalized.plan.recovery.removedWeekCount ||
      counts.matchup_count !==
        normalized.plan.recovery.removedMatchupCount ||
      counts.job_count !==
        normalized.plan.oldJobCas.length
    ) {
      conflict(
        "Schedule-recovery child evidence is incomplete.",
        "RECOVERY_STAGE_INCOMPLETE"
      );
    }
  }

  function assertStaged(normalized) {
    assertEvidenceChildren(normalized);
    reconcile(normalized);
  }

  function reconcile(normalized) {
    const counts = reconciliationCounts.get(
      scopeParameters(normalized)
    );
    if (
      counts.week_count !== normalized.expectedWeekCount ||
      counts.matchup_count !==
        normalized.expectedMatchupCount ||
      counts.bye_count !== normalized.expectedByeCount ||
      counts.old_generation_count !== 1 ||
      counts.new_generation_count !== 1 ||
      counts.skipped_job_count !==
        normalized.plan.oldJobCas.length ||
      counts.replacement_job_count !==
        normalized.plan.replacementJobs.length ||
      counts.unbound_job_count !== 0
    ) {
      incompatible(
        "The staged FAD schedule recovery did not reconcile.",
        "RECOVERY_RECONCILIATION_FAILED"
      );
    }

    const weeks = scheduleWeeks.all(
      scopeParameters(normalized)
    );
    for (
      let index = 0;
      index < normalized.plan.mappedWeeks.length;
      index += 1
    ) {
      const expected = normalized.plan.mappedWeeks[index];
      const actual = weeks[index];
      if (
        !actual ||
        actual.id !== expected.id ||
        actual.week_key !== expected.weekKey ||
        actual.sequence !== expected.sequence ||
        actual.starts_at_ms !== expected.startsAtMs ||
        actual.baseline_at_ms !== expected.baselineAtMs ||
        actual.locks_at_ms !== expected.locksAtMs ||
        actual.ends_at_ms !== expected.endsAtMs ||
        actual.rolls_over_at_ms !== expected.rollsOverAtMs ||
        actual.status !== expected.status ||
        actual.version !== expected.version
      ) {
        incompatible(
          "A retained matchup week did not reconcile.",
          "RECOVERY_WEEK_RECONCILIATION_FAILED"
        );
      }
    }
  }

  function reconstructEvidence(normalized) {
    const parameters = scopeParameters(normalized);
    const removedWeeks = evidenceWeeks
      .all(parameters)
      .map((row) => ({
        matchupWeekId: row.removed_matchup_week_id,
        sequence: row.removed_sequence,
        startsAtMs: row.removed_starts_at_ms,
      }));
    const removedMatchups = evidenceMatchups
      .all(parameters)
      .map((row) => ({
        matchupId: row.removed_matchup_id,
        matchupWeekId: row.removed_matchup_week_id,
      }));
    const jobEffects = evidenceJobs
      .all(parameters)
      .map((row) => ({
        disposition: row.disposition,
        jobType: row.job_type,
        oldJobRunId: row.replaced_job_run_id,
        oldOccurrenceKey: row.replaced_occurrence_key,
        oldScheduleOperationId:
          row.replaced_schedule_operation_id,
        oldScheduleVersion:
          row.replaced_schedule_version,
        newJobRunId: row.replacement_job_run_id,
        newOccurrenceKey:
          row.replacement_occurrence_key,
        newScheduleOperationId:
          row.replacement_schedule_operation_id,
        newScheduleVersion:
          row.replacement_schedule_version,
      }));
    return createFreeAgentDraftScheduleRecoveryEvidence({
      recoveryId: normalized.recoveryId,
      leagueId: normalized.leagueId,
      seasonId: normalized.seasonId,
      fadId: normalized.fadId,
      recoveryKind: normalized.plan.recoveryKind,
      operationId: normalized.operationId,
      oldScheduleOperationId:
        normalized.plan.recovery.oldScheduleOperationId,
      newScheduleOperationId:
        normalized.plan.recovery.newScheduleOperationId,
      oldScheduleVersion:
        normalized.oldScheduleVersion,
      newScheduleVersion:
        normalized.newScheduleVersion,
      oldFirstMatchupWeekId:
        normalized.plan.recovery.oldFirstMatchupWeekId,
      newFirstMatchupWeekId:
        normalized.plan.recovery.newFirstMatchupWeekId,
      oldWeek1StartsAtMs:
        normalized.plan.recovery.oldWeekOneStartsAtMs,
      newWeek1StartsAtMs:
        normalized.plan.recovery.newWeekOneStartsAtMs,
      completedAtMs: normalized.completedAtMs,
      removedWeeks,
      removedMatchups,
      jobEffects,
    });
  }

  function assertImmutableChildIdentity(normalized) {
    const parameters = scopeParameters(normalized);
    const byId = (left, right) =>
      compareStrings(left.id, right.id);
    const expectedWeeks = normalized.plan.recoveryChildren.weeks
      .map((child) => ({
        id: child.id,
        leagueId: child.leagueId,
        seasonId: child.seasonId,
        scheduleRecoveryId: child.scheduleRecoveryId,
        removedMatchupWeekId:
          child.removedMatchupWeekId,
        removedSequence: child.removedSequence,
        removedStartsAtMs: child.removedStartsAtMs,
        createdAtMs: child.createdAtMs,
      }))
      .sort(byId);
    const actualWeeks = evidenceWeeks
      .all(parameters)
      .map((row) => ({
        id: row.id,
        leagueId: row.league_id,
        seasonId: row.season_id,
        scheduleRecoveryId: row.schedule_recovery_id,
        removedMatchupWeekId:
          row.removed_matchup_week_id,
        removedSequence: row.removed_sequence,
        removedStartsAtMs: row.removed_starts_at_ms,
        createdAtMs: row.created_at_ms,
      }))
      .sort(byId);
    const expectedMatchups =
      normalized.plan.recoveryChildren.matchups
        .map((child) => ({
          id: child.id,
          leagueId: child.leagueId,
          seasonId: child.seasonId,
          scheduleRecoveryId: child.scheduleRecoveryId,
          removedMatchupId: child.removedMatchupId,
          removedMatchupWeekId:
            child.removedMatchupWeekId,
          createdAtMs: child.createdAtMs,
          version: child.version,
        }))
        .sort(byId);
    const actualMatchups = evidenceMatchups
      .all(parameters)
      .map((row) => ({
        id: row.id,
        leagueId: row.league_id,
        seasonId: row.season_id,
        scheduleRecoveryId: row.schedule_recovery_id,
        removedMatchupId: row.removed_matchup_id,
        removedMatchupWeekId:
          row.removed_matchup_week_id,
        createdAtMs: row.created_at_ms,
        version: row.version,
      }))
      .sort(byId);
    const expectedJobs = normalized.plan.recoveryChildren.jobs
      .map((child) => ({
        id: child.id,
        leagueId: child.leagueId,
        seasonId: child.seasonId,
        scheduleRecoveryId: child.scheduleRecoveryId,
        disposition: child.disposition,
        jobType: child.jobType,
        replacedJobRunId: child.replacedJobRunId,
        replacementJobRunId: child.replacementJobRunId,
        replacedOccurrenceKey: child.replacedOccurrenceKey,
        replacementOccurrenceKey:
          child.replacementOccurrenceKey,
        replacedScheduleOperationId:
          child.replacedScheduleOperationId,
        replacedScheduleVersion:
          child.replacedScheduleVersion,
        replacementScheduleOperationId:
          child.replacementScheduleOperationId,
        replacementScheduleVersion:
          child.replacementScheduleVersion,
        replacedJobVersion: child.replacedJobVersion,
        replacementJobVersion:
          child.replacementJobVersion,
        createdAtMs: child.createdAtMs,
        version: child.version,
      }))
      .sort(byId);
    const actualJobs = evidenceJobs
      .all(parameters)
      .map((row) => ({
        id: row.id,
        leagueId: row.league_id,
        seasonId: row.season_id,
        scheduleRecoveryId: row.schedule_recovery_id,
        disposition: row.disposition,
        jobType: row.job_type,
        replacedJobRunId: row.replaced_job_run_id,
        replacementJobRunId: row.replacement_job_run_id,
        replacedOccurrenceKey: row.replaced_occurrence_key,
        replacementOccurrenceKey:
          row.replacement_occurrence_key,
        replacedScheduleOperationId:
          row.replaced_schedule_operation_id,
        replacedScheduleVersion:
          row.replaced_schedule_version,
        replacementScheduleOperationId:
          row.replacement_schedule_operation_id,
        replacementScheduleVersion:
          row.replacement_schedule_version,
        replacedJobVersion: row.replaced_job_version,
        replacementJobVersion:
          row.replacement_job_version,
        createdAtMs: row.created_at_ms,
        version: row.version,
      }))
      .sort(byId);
    if (
      !isDeepStrictEqual(actualWeeks, expectedWeeks) ||
      !isDeepStrictEqual(actualMatchups, expectedMatchups) ||
      !isDeepStrictEqual(actualJobs, expectedJobs)
    ) {
      conflict(
        "The stored recovery children differ from the requested plan.",
        "RECOVERY_SEAL_REPLAY_MISMATCH"
      );
    }
  }

  function assertSealedReplay(normalized, existingRoot) {
    const recovery = normalized.plan.recovery;
    const expectedRoot = {
      id: recovery.id,
      league_id: recovery.leagueId,
      season_id: recovery.seasonId,
      fad_id: recovery.fadId,
      recovery_kind: recovery.recoveryKind,
      matchup_operation_id: recovery.matchupOperationId,
      old_schedule_operation_id:
        recovery.oldScheduleOperationId,
      new_schedule_operation_id:
        recovery.newScheduleOperationId,
      old_first_matchup_week_id:
        recovery.oldFirstMatchupWeekId,
      new_first_matchup_week_id:
        recovery.newFirstMatchupWeekId,
      old_schedule_version: recovery.oldScheduleVersion,
      new_schedule_version: recovery.newScheduleVersion,
      old_week_one_starts_at_ms:
        recovery.oldWeekOneStartsAtMs,
      new_week_one_starts_at_ms:
        recovery.newWeekOneStartsAtMs,
      removed_week_count: recovery.removedWeekCount,
      removed_matchup_count: recovery.removedMatchupCount,
      replaced_job_count: recovery.replacedJobCount,
      cancelled_job_count: recovery.cancelledJobCount,
      completed_at_ms: recovery.completedAtMs,
      evidence_schema_version:
        recovery.evidenceSchemaVersion,
      evidence_sha256: recovery.evidenceSha256,
      created_at_ms: recovery.createdAtMs,
      version: recovery.version,
    };
    const actualRoot = Object.fromEntries(
      Object.keys(expectedRoot).map((key) => [
        key,
        existingRoot[key],
      ])
    );
    if (!isDeepStrictEqual(actualRoot, expectedRoot)) {
      conflict(
        "The stored recovery seal differs from the requested plan.",
        "RECOVERY_SEAL_REPLAY_MISMATCH"
      );
    }

    assertEvidenceChildren(normalized);
    assertImmutableChildIdentity(normalized);
    const actualEvidence = reconstructEvidence(normalized);
    if (
      actualEvidence.evidenceSha256 !==
        existingRoot.evidence_sha256 ||
      !isDeepStrictEqual(
        actualEvidence.preimage,
        normalized.plan.evidence.preimage
      )
    ) {
      conflict(
        "The stored recovery evidence differs from the requested plan.",
        "RECOVERY_SEAL_REPLAY_MISMATCH"
      );
    }
    return actualEvidence;
  }

  function applyStage(normalized) {
    assertNoConflictingRoot(normalized);
    const existingRoot = rootRecord(normalized);
    if (existingRoot) {
      const actualEvidence = assertSealedReplay(
        normalized,
        existingRoot
      );
      return frozenResult({
        staged: true,
        sealed: true,
        replayed: true,
        recoveryId: normalized.recoveryId,
        evidenceSha256: actualEvidence.evidenceSha256,
      });
    }
    const existingChildren = childCounts.get(
      scopeParameters(normalized)
    );
    if (
      existingChildren.week_count > 0 ||
      existingChildren.matchup_count > 0 ||
      existingChildren.job_count > 0
    ) {
      assertStaged(normalized);
      return frozenResult({
        staged: true,
        sealed: false,
        replayed: true,
        recoveryId: normalized.recoveryId,
      });
    }

    assertLifecycle(normalized, "stage");

    const baseline = assertBaseline(normalized);
    const { plan } = normalized;
    const calendar = plan.calendar;
    if (
      updateSeason.run({
        ...scopeParameters(normalized),
        nhlRegularSeasonStartsAtMs:
          calendar.nhlRegularSeasonStartsAtMs,
        nhlRegularSeasonEndsAtMs:
          calendar.nhlRegularSeasonEndsAtMs,
        fantasyPlayoffsStartAtMs:
          calendar.fantasyPlayoffsStartAtMs,
        fantasyPlayoffsEndAtMs:
          calendar.fantasyPlayoffsEndAtMs,
        expectedSeasonVersion: baseline.seasonVersion,
      }).changes !== 1
    ) {
      conflict(
        "The recovery season changed before its CAS update.",
        "RECOVERY_SEASON_CAS_FAILED"
      );
    }
    step("after_season_cas");

    for (const child of plan.recoveryChildren.weeks) {
      insertWeekEvidence.run({
        id: child.id,
        leagueId: child.leagueId,
        seasonId: child.seasonId,
        scheduleRecoveryId: child.scheduleRecoveryId,
        removedMatchupWeekId:
          child.removedMatchupWeekId,
        removedSequence: child.removedSequence,
        removedStartsAtMs: child.removedStartsAtMs,
        createdAtMs: child.createdAtMs,
      });
    }
    for (const child of plan.recoveryChildren.matchups) {
      insertMatchupEvidence.run({
        id: child.id,
        leagueId: child.leagueId,
        seasonId: child.seasonId,
        scheduleRecoveryId: child.scheduleRecoveryId,
        removedMatchupId: child.removedMatchupId,
        removedMatchupWeekId:
          child.removedMatchupWeekId,
        createdAtMs: child.createdAtMs,
        version: child.version,
      });
    }
    step("after_removed_evidence_staged");

    for (const oldJob of plan.oldJobCas) {
      if (skipOldJob.run(oldJob).changes !== 1) {
        conflict(
          "A current-generation matchup job changed before recovery.",
          "RECOVERY_JOB_CAS_FAILED",
          { jobRunId: oldJob.jobRunId }
        );
      }
    }
    step("after_old_jobs_skipped");

    for (const matchup of plan.removals.matchups) {
      if (deleteMatchup.run({
        ...matchup,
        status: matchup.expectedStatus,
      }).changes !== 1) {
        conflict(
          "A removed matchup changed before recovery.",
          "REMOVED_MATCHUP_CAS_FAILED",
          { matchupId: matchup.id }
        );
      }
    }
    for (const week of plan.mappedWeeks) {
      for (const matchup of week.matchups) {
        if (deleteMatchup.run({
          id: matchup.id,
          leagueId: matchup.leagueId,
          seasonId: matchup.seasonId,
          weekId: matchup.weekId,
          homeTeamId: matchup.previousHomeTeamId,
          awayTeamId: matchup.previousAwayTeamId,
          expectedVersion: matchup.expectedVersion,
        }).changes !== 1) {
          conflict(
            "A retained matchup changed before recovery.",
            "RETAINED_MATCHUP_CAS_FAILED",
            { matchupId: matchup.id }
          );
        }
      }
    }
    for (const bye of plan.removals.byes) {
      if (deleteBye.run(bye).changes !== 1) {
        conflict(
          "A removed matchup bye changed before recovery.",
          "REMOVED_BYE_CAS_FAILED",
          { byeId: bye.id }
        );
      }
    }
    for (const week of plan.mappedWeeks) {
      if (
        week.bye !== null &&
        deleteBye.run({
          id: week.bye.id,
          leagueId: week.bye.leagueId,
          seasonId: week.bye.seasonId,
          weekId: week.bye.weekId,
          teamId: week.bye.previousTeamId,
        }).changes !== 1
      ) {
        conflict(
          "A retained matchup bye changed before recovery.",
          "RETAINED_BYE_CAS_FAILED",
          { byeId: week.bye.id }
        );
      }
    }
    for (const week of plan.removals.weeks) {
      if (deleteWeek.run(week).changes !== 1) {
        conflict(
          "A removed matchup week changed before recovery.",
          "REMOVED_WEEK_CAS_FAILED",
          { matchupWeekId: week.id }
        );
      }
    }
    for (const week of plan.mappedWeeks) {
      if (updateRetainedWeek.run(week).changes !== 1) {
        conflict(
          "A retained matchup week changed before recovery.",
          "RETAINED_WEEK_CAS_FAILED",
          { matchupWeekId: week.id }
        );
      }
    }

    const teamNames = new Map(
      baseline.teams.map(({ id, name }) => [id, name])
    );
    for (const week of plan.mappedWeeks) {
      for (const matchup of week.matchups) {
        const source = baseline.matchupRows.get(matchup.id);
        insertRetainedMatchup.run({
          ...matchup,
          homeTeamName: teamNames.get(matchup.homeTeamId),
          awayTeamName: teamNames.get(matchup.awayTeamId),
          createdAtMs: source.created_at_ms,
        });
      }
      if (week.bye !== null) {
        const source = baseline.byeRows.get(week.bye.id);
        insertRetainedBye.run({
          ...week.bye,
          teamDisplayName: teamNames.get(week.bye.teamId),
          createdAtMs: source.created_at_ms,
        });
      }
    }
    step("after_schedule_replaced");

    if (
      supersedeGeneration.run({
        ...scopeParameters(normalized),
        oldGenerationVersion:
          normalized.oldGenerationVersion,
        oldWeekOneStartsAtMs:
          plan.recovery.oldWeekOneStartsAtMs,
      }).changes !== 1
    ) {
      conflict(
        "The current schedule generation changed before supersession.",
        "RECOVERY_GENERATION_CAS_FAILED"
      );
    }
    step("after_old_generation_superseded");

    insertOperation.run({
      ...plan.operation,
      metadataJson: JSON.stringify(plan.operation.metadata),
    });
    insertGeneration.run(plan.generation.replacement);
    step("after_new_generation");

    for (const job of plan.replacementJobs) {
      insertJob.run(job);
    }
    for (const binding of plan.replacementBindings) {
      insertBinding.run(binding);
    }
    step("after_replacement_jobs");

    for (const child of plan.recoveryChildren.jobs) {
      insertJobEvidence.run(child);
    }
    step("after_job_evidence_staged");
    assertStaged(normalized);
    return frozenResult({
      staged: true,
      sealed: false,
      replayed: false,
      recoveryId: normalized.recoveryId,
      seasonVersionBefore: baseline.seasonVersion,
      seasonVersionAfter: baseline.seasonVersion + 1,
    });
  }

  function applySeal(normalized) {
    assertNoConflictingRoot(normalized);
    const existing = rootRecord(normalized);
    if (existing) {
      const actualEvidence = assertSealedReplay(
        normalized,
        existing
      );
      return frozenResult({
        staged: true,
        sealed: true,
        replayed: true,
        recoveryId: normalized.recoveryId,
        evidenceSha256: actualEvidence.evidenceSha256,
      });
    }

    assertLifecycle(normalized, "seal");
    assertStaged(normalized);
    const actualEvidence = reconstructEvidence(normalized);
    if (
      actualEvidence.evidenceSha256 !==
        normalized.plan.recovery.evidenceSha256 ||
      !isDeepStrictEqual(
        actualEvidence.preimage,
        normalized.plan.evidence.preimage
      )
    ) {
      conflict(
        "Staged recovery evidence does not match its planned digest.",
        "RECOVERY_EVIDENCE_DIGEST_MISMATCH"
      );
    }
    step("before_recovery_seal");
    insertRecoveryRoot.run(normalized.plan.recovery);
    step("after_recovery_seal");

    const sealed = rootRecord(normalized);
    if (
      !sealed ||
      sealed.evidence_sha256 !==
        actualEvidence.evidenceSha256
    ) {
      incompatible(
        "The FAD schedule recovery did not seal exactly once.",
        "RECOVERY_SEAL_RECONCILIATION_FAILED"
      );
    }
    assertStaged(normalized);
    return frozenResult({
      staged: true,
      sealed: true,
      replayed: false,
      recoveryId: normalized.recoveryId,
      evidenceSha256: actualEvidence.evidenceSha256,
    });
  }

  function execute(operation, callback) {
    try {
      requireTransaction();
      return callback();
    } catch (error) {
      throw mapRepositoryError(error, {
        operation,
        tableName:
          "free_agent_draft_schedule_recoveries",
      });
    }
  }

  return Object.freeze({
    stage({ plan } = {}) {
      return execute(
        "stageFreeAgentDraftScheduleRecovery",
        () => applyStage(normalizePlan(plan))
      );
    },
    seal({ plan } = {}) {
      return execute(
        "sealFreeAgentDraftScheduleRecovery",
        () => applySeal(normalizePlan(plan))
      );
    },
    applyAndSeal({ plan } = {}) {
      return execute(
        "applyAndSealFreeAgentDraftScheduleRecovery",
        () => {
          const normalized = normalizePlan(plan);
          if (normalized.plan.recoveryKind !== "completion") {
            invalid(
              "Pre-open recovery must stage before FAD creation and seal afterward.",
              "PRE_OPEN_REQUIRES_STAGE_AND_SEAL"
            );
          }
          const staged = applyStage(normalized);
          const sealed = applySeal(normalized);
          return frozenResult({
            ...sealed,
            replayed:
              staged.replayed && sealed.replayed,
          });
        }
      );
    },
  });
}

module.exports = {
  createSqliteFreeAgentDraftScheduleRecoveryWriter,
};
