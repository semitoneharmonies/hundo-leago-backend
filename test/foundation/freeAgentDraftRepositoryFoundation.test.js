const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_DAY_MS,
  FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
  buildFreeAgentDraftReadinessOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftReadinessAttemptEvidence,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
  projectFreeAgentDraftReadinessPublicDiagnostics,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  planExplicitMatchupSchedule,
} = require(
  "../../src/domain/matchups/matchupSchedulePolicy"
);
const {
  buildMatchupOccurrenceKey,
} = require(
  "../../src/domain/matchups/matchupJobPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../src/domain/leagues/socketInvalidation"
);
const {
  createFreeAgentDraftScheduleRecoveryService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService"
);
const {
  createFreeAgentDraftReadinessService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftReadinessService"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteNotificationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter"
);
const {
  REPOSITORY_METHODS,
  createSqliteFreeAgentDraftRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);
const {
  createSqliteCandidateCardOpeningWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardOpeningWriter"
);
const {
  createSqliteFreeAgentDraftScheduleRecoveryWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftScheduleRecoveryWriter"
);
const {
  createSqliteMatchupScheduleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupScheduleRepository"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function generatedUuid(value) {
  return (
    "90000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function makeSecureRandom(start = 1) {
  let next = start;
  return Object.freeze({
    id() {
      const result = generatedUuid(next);
      next += 1;
      return result;
    },
  });
}

function mutateFixtureWithoutGuards(database, mutation) {
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `)
    .all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll(
        '"',
        '""'
      )}"`
    );
  }
  database.pragma("ignore_check_constraints = ON");
  try {
    mutation();
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    for (const trigger of triggers) {
      database.exec(trigger.sql);
    }
  }
}

const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const CANDIDATE_DEADLINE_AT_MS =
  WEEK_ONE_AT_MS -
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
const OPENED_AT_MS =
  CANDIDATE_DEADLINE_AT_MS -
  36 * 60 * 60 * 1000;
const PLAYOFFS_START_AT_MS = Date.parse(
  "2027-01-18T08:00:00.000Z"
);
const PLAYOFFS_END_AT_MS =
  PLAYOFFS_START_AT_MS +
  28 * FREE_AGENT_DRAFT_DAY_MS;
const RECOVERY_OPENED_AT_MS =
  CANDIDATE_DEADLINE_AT_MS;
const MATCHUP_JOB_SLOTS = Object.freeze([
  Object.freeze({
    jobType: "matchup:statistics_refresh",
    timeField: "startsAtMs",
  }),
  Object.freeze({
    jobType: "matchup:baseline",
    timeField: "baselineAtMs",
  }),
  Object.freeze({
    jobType: "matchup:lock",
    timeField: "locksAtMs",
  }),
  Object.freeze({
    jobType: "matchup:statistics_refresh",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    jobType: "matchup:finalize",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    jobType: "matchup:rollover",
    timeField: "rollsOverAtMs",
  }),
]);

const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  season: uuid(3),
  user: uuid(4),
  membership: uuid(5),
  team: uuid(6),
  assignment: uuid(7),
  weekOne: uuid(8),
  scheduleOne: uuid(9),
  triggerResource: uuid(10),
  readiness: uuid(11),
  readinessJob: uuid(12),
  readinessAttempt: uuid(13),
  secondReadinessAttempt: uuid(14),
  otherUser: uuid(15),
  otherMembership: uuid(16),
});
const READINESS_JOB_LEASE_OWNER =
  "fad-readiness-worker";
const READINESS_JOB_LEASE_TOKEN =
  "fad-readiness-lease-token";
const READINESS_JOB_CLAIMED_AT_MS =
  OPENED_AT_MS - 750;
const READINESS_JOB_LEASE_EXPIRES_AT_MS =
  WEEK_ONE_AT_MS + FREE_AGENT_DRAFT_DAY_MS;
const RECOVERY_TEAM_IDS = Object.freeze([
  IDS.team,
  uuid(401),
  uuid(402),
  uuid(403),
]);

function seedBase(database) {
  const insertLeague = database.prepare(`
    INSERT INTO leagues (
      id,
      name,
      name_normalized,
      status,
      timezone,
      commissioner_membership_id,
      current_season_id,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @name,
      @nameNormalized,
      'active',
      'America/Vancouver',
      NULL,
      NULL,
      1,
      1,
      1
    )
  `);
  insertLeague.run({
    id: IDS.league,
    name: "FAD Lifecycle League",
    nameNormalized: "fad lifecycle league",
  });
  insertLeague.run({
    id: IDS.otherLeague,
    name: "Other FAD League",
    nameNormalized: "other fad league",
  });
  database.prepare(`
    INSERT INTO users (
      id,
      email_normalized,
      email_display,
      display_name,
      display_name_normalized,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?,
      'fad-manager@example.test',
      'fad-manager@example.test',
      'FAD Manager',
      'fad manager',
      'active',
      1,
      1,
      1
    )
  `).run(IDS.user);
  database.prepare(`
    INSERT INTO league_settings (
      league_id,
      salary_cap_cents,
      trade_deadline_at_ms,
      maximum_teams,
      active_forward_slots,
      active_defence_slots,
      bench_slots,
      maximum_bench_aav_cents,
      injured_reserve_slots,
      prospect_slots_unlimited,
      scoring_rule_version,
      standings_rule_version,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, 10000, NULL, 20, 12, 6, 4, 400,
      4, 1, 1, 1, 1, 1, 1
    )
  `).run(IDS.league);
  database.prepare(`
    INSERT INTO seasons (
      id,
      league_id,
      label,
      nhl_season_key,
      status,
      regular_season_starts_at_ms,
      regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      created_at_ms,
      updated_at_ms,
      version,
      free_agent_draft_completed_at_ms
    ) VALUES (
      ?, ?, '2026-27', '20262027', 'active',
      ?, ?, ?, ?, 1, 1, 1, NULL
    )
  `).run(
    IDS.season,
    IDS.league,
    WEEK_ONE_AT_MS,
    PLAYOFFS_END_AT_MS,
    PLAYOFFS_START_AT_MS,
    PLAYOFFS_END_AT_MS
  );
  database.prepare(`
    INSERT INTO league_memberships (
      id,
      league_id,
      user_id,
      permission_category,
      status,
      joined_at_ms,
      ended_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, ?, 'commissioner', 'active',
      1, NULL, 1, 1, 1
    )
  `).run(
    IDS.membership,
    IDS.league,
    IDS.user
  );
  database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, 'FAD Team', 'fad team', 'active',
      '#102030', '#f0a020', NULL, 1, 1, 1
    )
  `).run(IDS.team, IDS.league);
  database.prepare(`
    INSERT INTO team_manager_assignments (
      id,
      league_id,
      team_id,
      user_id,
      membership_id,
      assigned_by_user_id,
      replaces_assignment_id,
      status,
      assigned_at_ms,
      accepted_at_ms,
      ended_at_ms,
      version
    ) VALUES (
      ?, ?, ?, ?, ?, ?, NULL, 'accepted',
      1, 1, NULL, 1
    )
  `).run(
    IDS.assignment,
    IDS.league,
    IDS.team,
    IDS.user,
    IDS.membership,
    IDS.user
  );
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = 2,
        version = 2
    WHERE id = ?
  `).run(
    IDS.membership,
    IDS.season,
    IDS.league
  );
  database.prepare(`
    INSERT INTO matchup_weeks (
      id,
      league_id,
      season_id,
      week_key,
      sequence,
      starts_at_ms,
      baseline_at_ms,
      locks_at_ms,
      ends_at_ms,
      rolls_over_at_ms,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, ?, '2026-W01', 1, ?,
      ?, ?, ?, ?, 'scheduled', 3, 3, 1
    )
  `).run(
    IDS.weekOne,
    IDS.league,
    IDS.season,
    WEEK_ONE_AT_MS,
    WEEK_ONE_AT_MS + 60 * 60 * 1000,
    WEEK_ONE_AT_MS + 16 * 60 * 60 * 1000,
    WEEK_ONE_AT_MS +
      7 * FREE_AGENT_DRAFT_DAY_MS,
    WEEK_ONE_AT_MS +
      7 * FREE_AGENT_DRAFT_DAY_MS
  );
  insertScheduleOperation(
    database,
    IDS.scheduleOne,
    4
  );
  database.prepare(`
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
      ?, ?, 1, ?, ?, ?, 'current', 4, NULL, 1
    )
  `).run(
    IDS.league,
    IDS.season,
    IDS.scheduleOne,
    IDS.weekOne,
    WEEK_ONE_AT_MS
  );
}

function insertScheduleOperation(
  database,
  operationId,
  completedAtMs
) {
  database.prepare(`
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
      ?, ?, ?, NULL, NULL, ?,
      'schedule_generate', 'succeeded',
      NULL, NULL, ?, ?
    )
  `).run(
    operationId,
    IDS.league,
    IDS.season,
    IDS.user,
    completedAtMs - 1,
    completedAtMs
  );
}

function createCandidateCardWriter(database, {
  omitCards = false,
  omitRevisions = false,
  omitCarryovers = false,
  misreportCarryoverProjection = false,
  misreportCardResult = null,
  persistRequestedSlotGroup = null,
  persistPlacementState = null,
  persistCardAsEmpty = false,
} = {}) {
  const insert = database.prepare(`
    INSERT INTO candidate_cards (
      id,
      league_id,
      season_id,
      fad_id,
      team_id,
      status,
      completeness_code,
      filled_mandatory_count,
      missing_mandatory_count,
      filled_bench_count,
      empty_bench_count,
      blocking_validation_count,
      structural_conflict_count,
      carried_roster_structural_conflict_count,
      maximum_possible_cap_cents,
      locked_at_ms,
      created_at_ms,
      updated_at_ms,
      version,
      cap_status,
      allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      @cardId,
      @leagueId,
      @seasonId,
      @fadId,
      @teamId,
      'open',
      @completenessCode,
      @filledMandatoryCount,
      @missingMandatoryCount,
      @filledBenchCount,
      @emptyBenchCount,
      0,
      @structuralConflictCount,
      @structuralConflictCount,
      0,
      NULL,
      @openedAtMs,
      @openedAtMs,
      1,
      'compliant',
      @allocationEligibility,
      @allocationExclusionReason
    )
  `);
  const insertEntry = database.prepare(`
    INSERT INTO candidate_card_entries (
      id,
      league_id,
      season_id,
      fad_id,
      card_id,
      team_id,
      entry_kind,
      player_id,
      effective_position_group,
      requested_slot_group,
      requested_slot_number,
      placement_state,
      conflict_code,
      carryover_ownership_id,
      carryover_contract_id,
      source_roster_category,
      carryover_original_total_value_cents,
      carryover_original_term_years,
      carryover_aav_cents,
      remaining_years,
      proposed_total_value_cents,
      proposed_term_years,
      proposed_aav_cents,
      eligibility_status,
      validation_code,
      last_acknowledgement_revision_id,
      created_by_user_id,
      created_by_membership_id,
      created_by_authority,
      last_edited_by_user_id,
      last_edited_by_membership_id,
      last_edited_by_authority,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @ownership_id,
      @leagueId,
      @seasonId,
      @fadId,
      @cardId,
      @team_id,
      'carryover',
      @player_id,
      @position_group,
      @requestedSlotGroup,
      @slot_number,
      @placement_state,
      @conflict_code,
      @ownership_id,
      @contract_id,
      @roster_category,
      @original_total_value_cents,
      @original_term_years,
      @aav_cents,
      @remaining_years,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      'system',
      NULL,
      NULL,
      'system',
      @openedAtMs,
      @openedAtMs,
      1
    )
  `);
  const insertRevision = database.prepare(`
    INSERT INTO candidate_card_revisions (
      id,
      league_id,
      season_id,
      fad_id,
      card_id,
      team_id,
      resulting_card_version,
      action,
      affected_entry_id,
      player_id,
      actor_user_id,
      actor_membership_id,
      actor_authority,
      before_evidence_json,
      after_evidence_json,
      potential_illegality_acknowledged,
      warning_codes_json,
      occurred_at_ms,
      created_at_ms,
      version
    ) VALUES (
      @notificationId,
      @leagueId,
      @seasonId,
      @fadId,
      @cardId,
      @teamId,
      1,
      'card_opened',
      NULL,
      NULL,
      NULL,
      NULL,
      'system',
      '{"card":null}',
      @afterEvidenceJson,
      0,
      '[]',
      @openedAtMs,
      @openedAtMs,
      1
    )
  `);
  return Object.freeze({
    openAll(command) {
      const resultCards = [];
      if (omitCards) {
        return Object.freeze({
          replayed: false,
          carryoverProjection:
            command.carryoverProjection,
          cards: Object.freeze(resultCards),
        });
      }
      for (const participant of
        command.participants) {
        const teamProjection =
          command.carryoverProjection.teams.find(
            ({ teamId }) =>
              teamId === participant.teamId
          );
        const filledMandatoryCount =
          18 -
          teamProjection.openForwardSlots -
          teamProjection.openDefenceSlots;
        const filledBenchCount =
          4 - teamProjection.openBenchSlots;
        const persistedFilledMandatoryCount =
          persistCardAsEmpty
            ? 0
            : filledMandatoryCount;
        const persistedMissingMandatoryCount =
          persistCardAsEmpty
            ? 18
            : teamProjection.openForwardSlots +
              teamProjection.openDefenceSlots;
        insert.run({
          ...command,
          cardId: participant.cardId,
          teamId: participant.teamId,
          completenessCode:
            teamProjection.structuralConflictCount > 0
              ? "conflicted"
              : filledMandatoryCount === 18
                ? "complete"
                : "incomplete",
          filledMandatoryCount:
            persistedFilledMandatoryCount,
          missingMandatoryCount:
            persistedMissingMandatoryCount,
          filledBenchCount,
          emptyBenchCount:
            teamProjection.openBenchSlots,
          structuralConflictCount:
            teamProjection.structuralConflictCount,
          allocationEligibility:
            teamProjection.structuralConflictCount > 0
              ? "excluded_structural_conflict"
              : "eligible",
          allocationExclusionReason:
            teamProjection.structuralConflictCount > 0
              ? "candidate_card_structural_conflict"
              : null,
        });
        if (!omitCarryovers) {
          for (const carryover of
            teamProjection.entries) {
            insertEntry.run({
              ...command,
              ownership_id:
                carryover.ownershipId,
              player_id: carryover.playerId,
              team_id: participant.teamId,
              roster_category:
                carryover.sourceRosterCategory,
              position_group:
                carryover.effectivePositionGroup,
              slot_number:
                carryover.requestedSlotNumber,
              placement_state:
                persistPlacementState ??
                carryover.placementState,
              conflict_code:
                persistPlacementState === "conflict"
                  ? "CARRYOVER_SLOT_CONFLICT"
                  : carryover.conflictCode,
              contract_id:
                carryover.contractId,
              original_total_value_cents:
                carryover.originalTotalValueCents,
              original_term_years:
                carryover.originalTermYears,
              aav_cents: carryover.aavCents,
              remaining_years:
                carryover.remainingYears,
              cardId: participant.cardId,
              requestedSlotGroup:
                persistRequestedSlotGroup ??
                carryover.requestedSlotGroup,
            });
          }
        }
        if (!omitRevisions) {
          insertRevision.run({
            ...command,
            ...participant,
            afterEvidenceJson: JSON.stringify({
              card: {
                cardId: participant.cardId,
                teamId: participant.teamId,
                version: 1,
              },
              opening: {
                leagueId: command.leagueId,
                seasonId: command.seasonId,
                fadId: command.fadId,
                openedAtMs:
                  command.openedAtMs,
                candidateDeadlineAtMs:
                  command.candidateDeadlineAtMs,
                participantId:
                  participant.participantId,
                notificationId:
                  participant.notificationId,
                managerUserId:
                  participant.managerUserId,
                managerMembershipId:
                  participant.managerMembershipId,
                managerAssignmentId:
                  participant.managerAssignmentId,
              },
            }),
          });
        }
        resultCards.push(
          Object.freeze({
            id: participant.cardId,
            teamId: participant.teamId,
            version:
              misreportCardResult === "version"
                ? 2
                : 1,
            completenessCode:
              teamProjection.structuralConflictCount > 0
                ? "conflicted"
                : filledMandatoryCount === 18
                  ? "complete"
                  : "incomplete",
            carryoverCount:
              teamProjection.carryoverCount,
            structuralConflictCount:
              teamProjection.structuralConflictCount,
            maximumPossibleCapCents: 0,
            openingRevisionId:
              misreportCardResult ===
              "openingRevisionId"
                ? uuid(999_999)
                : participant.notificationId,
          })
        );
      }
      return Object.freeze({
        replayed: false,
        carryoverProjection:
          misreportCarryoverProjection
            ? Object.freeze({
                ...command.carryoverProjection,
                structuralWarnings: Object.freeze([
                  Object.freeze({
                    code:
                      "FAD_CARRYOVER_STRUCTURAL_CONFLICT",
                    field: "candidateCard",
                    message:
                      "Injected false writer result.",
                    resourceId:
                      command.participants[0].teamId,
                    resourceType: "team",
                  }),
                ]),
              })
            : command.carryoverProjection,
        cards: Object.freeze(resultCards),
      });
    },
  });
}

function createRuntime(
  t,
  {
    beforeCommit,
    omitCards = false,
    omitRevisions = false,
    omitCarryovers = false,
    misreportCarryoverProjection = false,
    misreportCardResult = null,
    persistRequestedSlotGroup = null,
    persistPlacementState = null,
    persistCardAsEmpty = false,
    useRealCandidateCardWriter = false,
    scheduleRecoveryWriter,
    scheduleRecoveryWriterFactory,
    transitionWriter,
    transitionWriterFactory,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-repository-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory:
      MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "fad-repository-foundation",
    now: () => 1,
  });
  seedBase(connection.database);
  const repository =
    createSqliteFreeAgentDraftRepository({
      database: connection.database,
      notificationWriter:
        createSqliteNotificationWriter({
          database: connection.database,
        }),
      candidateCardWriter:
        useRealCandidateCardWriter
          ? createSqliteCandidateCardOpeningWriter({
              database: connection.database,
            })
          : createCandidateCardWriter(
              connection.database,
              {
                omitCards,
                omitRevisions,
                omitCarryovers,
                misreportCarryoverProjection,
                misreportCardResult,
                persistRequestedSlotGroup,
                persistPlacementState,
                persistCardAsEmpty,
              }
            ),
      transitionWriter:
        transitionWriterFactory
          ? transitionWriterFactory(
              connection.database
            )
          : transitionWriter,
      scheduleRecoveryWriter:
        scheduleRecoveryWriterFactory
          ? scheduleRecoveryWriterFactory(
              connection.database
            )
          : scheduleRecoveryWriter,
      beforeCommit,
    });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return {
    database: connection.database,
    repository,
  };
}

function readinessInput(overrides = {}) {
  return {
    operationId: IDS.readiness,
    leagueId: IDS.league,
    seasonId: IDS.season,
    triggerKind: "no_draft_inaugural",
    triggerResourceId:
      IDS.season,
    entryDraftId: null,
    setupExemptionId: null,
    jobRunId: IDS.readinessJob,
    createdAtMs: OPENED_AT_MS - 1_000,
    ...overrides,
  };
}

function readinessJobExecution(overrides = {}) {
  return {
    runId: IDS.readinessJob,
    leaseOwner: READINESS_JOB_LEASE_OWNER,
    leaseToken: READINESS_JOB_LEASE_TOKEN,
    leaseExpiresAtMs:
      READINESS_JOB_LEASE_EXPIRES_AT_MS,
    expectedVersion: 2,
    ...overrides,
  };
}

function readinessClaimContext(overrides = {}) {
  const {
    jobExecution: jobOverrides = {},
    ...claimOverrides
  } = overrides;
  return {
    jobExecution: readinessJobExecution(
      jobOverrides
    ),
    readinessVersion: 2,
    attemptNumber: 1,
    ...claimOverrides,
  };
}

function claimReadinessJob(
  database,
  overrides = {}
) {
  const command = {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: null,
    runId: IDS.readinessJob,
    jobType: "fad_readiness",
    occurrenceKey:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId: IDS.season,
      }),
    scheduledForMs: OPENED_AT_MS - 1_000,
    expectedVersion: 1,
    leaseOwner: READINESS_JOB_LEASE_OWNER,
    leaseToken: READINESS_JOB_LEASE_TOKEN,
    nowMs: READINESS_JOB_CLAIMED_AT_MS,
    leaseExpiresAtMs:
      READINESS_JOB_LEASE_EXPIRES_AT_MS,
    ...overrides,
  };
  const claimed =
    createSqliteFreeAgentDraftJobRepository({
      database,
    }).claim(command);
  assert.equal(claimed.acquired, true);
  const execution =
    claimed.occurrence.binding
      .readinessExecution;
  assert.deepEqual(
    {
      operationId: execution.operationId,
      status: execution.status,
    },
    {
      operationId: IDS.readiness,
      status: "running",
    }
  );
  assert.equal(
    claimed.occurrence.version,
    execution.version
  );
  assert.equal(
    claimed.occurrence.attemptCount,
    execution.attemptCount
  );
  return Object.freeze({
    jobExecution: readinessJobExecution({
      runId: command.runId,
      leaseOwner: command.leaseOwner,
      leaseToken: command.leaseToken,
      leaseExpiresAtMs:
        command.leaseExpiresAtMs,
      expectedVersion:
        claimed.occurrence.version,
    }),
    readinessVersion: execution.version,
    attemptNumber: execution.attemptCount,
  });
}

function readinessInitialRollovers(
  candidateDeadlineAtMs
) {
  return Array.from(
    {
      length:
        FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
    },
    (_, index) => {
      const opensAtMs =
        candidateDeadlineAtMs +
        index * FREE_AGENT_DRAFT_DAY_MS;
      const rollsOverAtMs =
        opensAtMs + FREE_AGENT_DRAFT_DAY_MS;
      return {
        creationCutoffAtMs:
          rollsOverAtMs - 60 * 60 * 1000,
        opensAtMs,
        rollsOverAtMs,
        sequence: index + 1,
      };
    }
  );
}

function readinessTeamProjection({
  teamId = IDS.team,
  managerAssignmentId = IDS.assignment,
  name = "FAD Team",
  carryoverCount = 0,
  openBenchSlots = 4,
  openDefenceSlots = 6,
  openForwardSlots = 12,
  structuralConflictCount = 0,
} = {}) {
  return {
    carryoverCount,
    managerAssignmentId,
    managerReady: true,
    openBenchSlots,
    openDefenceSlots,
    openForwardSlots,
    structuralConflictCount,
    team: {
      logoReference: null,
      name,
      patternTemplate: "even-two",
      primaryColour: "#102030",
      secondaryColour: "#f0a020",
      teamId,
      tertiaryColour: null,
    },
    teamId,
  };
}

function emptyCarryoverProjection(participants) {
  return {
    teams: participants.map(({ teamId }) => ({
      teamId,
      entries: [],
      carryoverCount: 0,
      openForwardSlots: 12,
      openDefenceSlots: 6,
      openBenchSlots: 4,
      structuralConflictCount: 0,
    })),
    stateBlockers: [],
    structuralWarnings: [],
  };
}

function readinessTeamProjections(
  participants,
  carryoverProjection =
    emptyCarryoverProjection(participants)
) {
  const carryoverByTeam = new Map(
    carryoverProjection.teams.map((team) => [
      team.teamId,
      team,
    ])
  );
  return participants.map(({ teamId }) => {
    const recoveryIndex =
      RECOVERY_TEAM_IDS.indexOf(teamId);
    const carryover = carryoverByTeam.get(teamId);
    return readinessTeamProjection({
      teamId,
      managerAssignmentId:
        recoveryIndex <= 0
          ? IDS.assignment
          : uuid(409 + recoveryIndex),
      name:
        recoveryIndex <= 0
          ? "FAD Team"
          : `Recovery Team ${recoveryIndex + 1}`,
      carryoverCount: carryover.carryoverCount,
      openBenchSlots:
        carryover.openBenchSlots,
      openDefenceSlots:
        carryover.openDefenceSlots,
      openForwardSlots:
        carryover.openForwardSlots,
      structuralConflictCount:
        carryover.structuralConflictCount,
    });
  });
}

function readinessAttemptProjection({
  blockers = [],
  candidateDeadlineAtMs =
    CANDIDATE_DEADLINE_AT_MS,
  firstMatchupWeekBefore = {
    sequence: 1,
    startsAtMs: WEEK_ONE_AT_MS,
    version: 1,
    weekId: IDS.weekOne,
  },
  firstMatchupWeekAfter =
    firstMatchupWeekBefore,
  observedSeasonVersion = 1,
  openedAtMs = OPENED_AT_MS,
  participatingTeamCount = 1,
  teamProjections = [
    readinessTeamProjection(),
  ],
  warnings = [],
} = {}) {
  return {
    blockers,
    candidateDeadlineAtMs,
    firstMatchupWeekAfter,
    firstMatchupWeekBefore,
    helpOpensAtMs: Math.max(
      openedAtMs,
      candidateDeadlineAtMs -
        48 * 60 * 60 * 1000
    ),
    initialRollovers:
      readinessInitialRollovers(
        candidateDeadlineAtMs
      ),
    observedSeasonVersion,
    participatingTeamCount,
    priorSeasonRollover: null,
    reminderAtMs:
      candidateDeadlineAtMs -
      72 * 60 * 60 * 1000,
    teamProjections,
    warnings,
  };
}

function canonicalReadinessAttempt({
  claim = readinessClaimContext(),
  id = IDS.readinessAttempt,
  leagueId = IDS.league,
  seasonId = IDS.season,
  readinessOperationId = IDS.readiness,
  jobRunId = IDS.readinessJob,
  attemptNumber = claim.attemptNumber,
  observedReadinessVersion =
    claim.readinessVersion,
  outcome,
  observedAtMs,
  recordedAtMs = observedAtMs,
  projection,
} = {}) {
  const evidence =
    createFreeAgentDraftReadinessAttemptEvidence({
      id,
      leagueId,
      seasonId,
      readinessOperationId,
      jobRunId,
      attemptNumber,
      observedReadinessVersion,
      outcome,
      observedAtMs,
      recordedAtMs,
      projection,
    });
  return Object.freeze({
    id: evidence.id,
    leagueId: evidence.leagueId,
    seasonId: evidence.seasonId,
    readinessOperationId:
      evidence.readinessOperationId,
    jobRunId: evidence.jobRunId,
    attemptNumber: evidence.attemptNumber,
    observedReadinessVersion:
      evidence.observedReadinessVersion,
    outcome: evidence.outcome,
    observedAtMs: evidence.observedAtMs,
    recordedAtMs: evidence.recordedAtMs,
    projection: evidence.projection,
  });
}

function publicBlockers(blockers) {
  return projectFreeAgentDraftReadinessPublicDiagnostics(
    blockers
  );
}

function blockerInput({
  claim = readinessClaimContext(),
  blockers,
  blockedAtMs = OPENED_AT_MS - 500,
  nextRetryAtMs = OPENED_AT_MS + 500,
  notificationId = uuid(950),
  attempt = canonicalReadinessAttempt({
    claim,
    outcome: "blocked",
    observedAtMs: blockedAtMs,
    recordedAtMs: blockedAtMs,
    projection: readinessAttemptProjection({
      blockers: publicBlockers(blockers),
    }),
  }),
  overrides = {},
} = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    occurrenceKey:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId: IDS.season,
      }),
    expectedVersion: claim.readinessVersion,
    blockers,
    blockedAtMs,
    nextRetryAtMs,
    notificationId,
    jobExecution: claim.jobExecution,
    attempt,
    ...overrides,
  };
}

function openingEvidence(base = 100) {
  return {
    fadId: uuid(base),
    participants: [
      {
        teamId: IDS.team,
        participantId: uuid(base + 1),
        cardId: uuid(base + 2),
        notificationId: uuid(base + 3),
      },
    ],
    reminderJobRunId: uuid(base + 4),
    deadlineJobRunId: uuid(base + 5),
    rolloverIds: Array.from(
      {
        length:
          FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
      },
      (_, index) => uuid(base + 10 + index)
    ),
    rolloverJobRunIds: Array.from(
      {
        length:
          FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
      },
      (_, index) => uuid(base + 20 + index)
    ),
    activityId: uuid(base + 30),
    outboxEventId: uuid(base + 31),
    outboxAudienceId: uuid(base + 32),
  };
}

function openingInput({
  evidence = openingEvidence(),
  carryoverProjection =
    emptyCarryoverProjection(
      evidence.participants
    ),
  schedule = {
    operationId: IDS.scheduleOne,
    version: 1,
    weekOneMatchupWeekId: IDS.weekOne,
    weekOneStartsAtMs: WEEK_ONE_AT_MS,
  },
  scheduleRecoveryPlan = null,
  openedAtMs = OPENED_AT_MS,
  claim = readinessClaimContext(),
  readinessOperationId = IDS.readiness,
  expectedReadinessVersion =
    claim.readinessVersion,
  leagueId = IDS.league,
  seasonId = IDS.season,
  occurrenceKey =
    buildFreeAgentDraftReadinessOccurrenceKey({
      leagueId: IDS.league,
      seasonId: IDS.season,
      triggerResourceId:
        IDS.season,
    }),
  jobExecution = claim.jobExecution,
  observedSeasonVersion = 1,
  attempt,
} = {}) {
  const replacement =
    scheduleRecoveryPlan?.generation
      ?.replacement;
  const effectiveSchedule = replacement
    ? {
        version:
          replacement.scheduleVersion,
        weekOneMatchupWeekId:
          replacement.weekOneMatchupWeekId,
        weekOneStartsAtMs:
          replacement.weekOneStartsAtMs,
      }
    : schedule;
  const candidateDeadlineAtMs =
    effectiveSchedule.weekOneStartsAtMs -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  const teamProjections =
    readinessTeamProjections(
      evidence.participants,
      carryoverProjection
    );
  const canonicalAttempt =
    attempt === undefined
      ? canonicalReadinessAttempt({
          claim,
          leagueId,
          seasonId,
          readinessOperationId,
          jobRunId:
            jobExecution?.runId ??
            IDS.readinessJob,
          outcome: "succeeded",
          observedAtMs: openedAtMs,
          recordedAtMs: openedAtMs,
          projection:
            readinessAttemptProjection({
              blockers: [],
              candidateDeadlineAtMs,
              firstMatchupWeekBefore: {
                sequence: 1,
                startsAtMs:
                  schedule.weekOneStartsAtMs,
                version: schedule.version,
                weekId:
                  schedule
                    .weekOneMatchupWeekId,
              },
              firstMatchupWeekAfter: {
                sequence: 1,
                startsAtMs:
                  effectiveSchedule
                    .weekOneStartsAtMs,
                version:
                  effectiveSchedule.version,
                weekId:
                  effectiveSchedule
                    .weekOneMatchupWeekId,
              },
              observedSeasonVersion,
              openedAtMs,
              participatingTeamCount:
                teamProjections.length,
              teamProjections,
              warnings: replacement
                ? [
                    {
                      code: "FAD_WEEK_ONE_MOVED",
                      message:
                        "Week 1 must move to preserve the complete FAD period.",
                      resourceId:
                        schedule
                          .weekOneMatchupWeekId,
                    },
                  ]
                : [],
            }),
        })
      : attempt;
  return {
    leagueId,
    seasonId,
    occurrenceKey,
    readinessOperationId,
    expectedReadinessVersion,
    openedAtMs,
    setupPath: "no_draft_inaugural",
    entryDraftId: null,
    setupExemptionId: null,
    priorSeasonRolloverId: null,
    noDraftReason:
      "Inaugural league season.",
    schedule,
    scheduleRecoveryPlan,
    carryoverProjection,
    evidence,
    jobExecution,
    attempt: canonicalAttempt,
  };
}

function assertRepositoryError(
  callback,
  code
) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function rowCount(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    )
    .get().count;
}

function assertOpeningRolledBack(
  database,
  repository,
  occurrenceKey
) {
  for (const tableName of [
    "free_agent_drafts",
    "free_agent_draft_teams",
    "candidate_cards",
    "candidate_card_entries",
    "candidate_card_revisions",
    "free_agent_draft_rollovers",
    "league_activity",
    "notifications",
    "outbox_events",
    "outbox_event_audiences",
    "free_agent_draft_readiness_attempts",
  ]) {
    assert.equal(
      rowCount(database, tableName),
      0,
      tableName
    );
  }
  assert.equal(rowCount(database, "job_runs"), 1);
  const readiness =
    repository.findReadinessByOccurrence({
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey,
    });
  assert.equal(readiness.status, "running");
  assert.equal(readiness.version, 2);
}

function readinessTerminalSnapshot(database) {
  return Object.freeze({
    readiness: database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = ? AND id = ?
    `).get(IDS.league, IDS.readiness),
    job: database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = ? AND id = ?
    `).get(IDS.league, IDS.readinessJob),
    attempts: database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_attempts
      WHERE league_id = ?
        AND readiness_operation_id = ?
      ORDER BY attempt_number
    `).all(IDS.league, IDS.readiness),
    notifications: database.prepare(`
      SELECT *
      FROM notifications
      WHERE league_id = ?
        AND event_type = 'fad_readiness_blocked'
      ORDER BY id
    `).all(IDS.league),
    drafts: database.prepare(`
      SELECT *
      FROM free_agent_drafts
      WHERE league_id = ? AND season_id = ?
      ORDER BY id
    `).all(IDS.league, IDS.season),
  });
}

function retryBlockedReadiness(database, {
  acceptedAtMs,
  actorMembershipId = IDS.membership,
  actorUserId = IDS.user,
  clientKey,
  expectedVersion,
  idempotencyRequestId,
  receiptId,
  retryAttemptNumber,
} = {}) {
  const occurrenceKey =
    buildFreeAgentDraftReadinessOccurrenceKey({
      leagueId: IDS.league,
      seasonId: IDS.season,
      triggerResourceId: IDS.season,
    });
  const request =
    createFreeAgentDraftReadinessRetryRequest({
      actorUserId,
      body: {
        confirmation:
          "RETRY FREE AGENT DRAFT READINESS",
        readinessOperationId: IDS.readiness,
        seasonId: IDS.season,
      },
      clientKey,
      expectedVersion,
      leagueId: IDS.league,
    });
  const receipt =
    createFreeAgentDraftReadinessRetryReceipt({
      acceptedAtMs,
      acceptedFromVersion: expectedVersion,
      actorAuthority: "commissioner",
      actorMembershipId,
      actorUserId,
      id: receiptId,
      idempotencyRequestId,
      jobRunId: IDS.readinessJob,
      leagueId: IDS.league,
      occurrenceKey,
      readinessOperationId: IDS.readiness,
      requestSha256: request.requestSha256,
      resultingReadinessVersion:
        expectedVersion + 1,
      retryAttemptNumber,
      seasonId: IDS.season,
    });
  database.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(
      database.prepare(`
        INSERT INTO idempotency_requests (
          id,
          league_id,
          actor_user_id,
          operation,
          client_key,
          request_hash,
          status,
          result_type,
          result_id,
          created_at_ms,
          completed_at_ms,
          expires_at_ms
        ) VALUES (
          @idempotencyRequestId,
          @leagueId,
          @actorUserId,
          'free_agent_draft.readiness.retry.v1',
          @clientKey,
          @requestSha256,
          'started',
          NULL,
          NULL,
          @acceptedAtMs,
          NULL,
          @expiresAtMs
        )
      `).run({
        acceptedAtMs,
        actorUserId,
        clientKey,
        expiresAtMs:
          acceptedAtMs +
          FREE_AGENT_DRAFT_DAY_MS,
        idempotencyRequestId,
        leagueId: IDS.league,
        requestSha256: request.requestSha256,
      }).changes,
      1
    );
    assert.equal(
      database.prepare(`
        UPDATE job_runs
        SET status = 'pending',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            started_at_ms = NULL,
            completed_at_ms = NULL,
            result_json = NULL,
            last_error_code = NULL,
            next_attempt_at_ms = @acceptedAtMs,
            updated_at_ms = @acceptedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @jobRunId
          AND status = 'failed'
          AND version = @expectedVersion
      `).run({
        acceptedAtMs,
        expectedVersion,
        jobRunId: IDS.readinessJob,
        leagueId: IDS.league,
      }).changes,
      1
    );
    assert.equal(
      database.prepare(`
        INSERT INTO free_agent_draft_readiness_retry_receipts (
          id,
          league_id,
          season_id,
          readiness_operation_id,
          idempotency_request_id,
          actor_user_id,
          actor_membership_id,
          actor_authority,
          request_sha256,
          accepted_from_version,
          resulting_readiness_version,
          retry_attempt_number,
          job_run_id,
          occurrence_key,
          accepted_at_ms,
          response_http_status,
          response_json,
          response_sha256,
          version
        ) VALUES (
          @id,
          @leagueId,
          @seasonId,
          @readinessOperationId,
          @idempotencyRequestId,
          @actorUserId,
          @actorMembershipId,
          @actorAuthority,
          @requestSha256,
          @acceptedFromVersion,
          @resultingReadinessVersion,
          @retryAttemptNumber,
          @jobRunId,
          @occurrenceKey,
          @acceptedAtMs,
          @responseHttpStatus,
          @responseJson,
          @responseSha256,
          @version
        )
      `).run(receipt).changes,
      1
    );
    assert.equal(
      database.prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET next_retry_at_ms = @acceptedAtMs,
            updated_at_ms = @acceptedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @readinessOperationId
          AND status = 'blocked'
          AND version = @acceptedFromVersion
      `).run(receipt).changes,
      1
    );
    assert.equal(
      database.prepare(`
        UPDATE idempotency_requests
        SET status = 'completed',
            result_type =
              'free_agent_draft_readiness_retry_receipt',
            result_id = @receiptId,
            completed_at_ms = @acceptedAtMs
        WHERE league_id = @leagueId
          AND id = @idempotencyRequestId
          AND status = 'started'
      `).run({
        acceptedAtMs,
        idempotencyRequestId,
        leagueId: IDS.league,
        receiptId,
      }).changes,
      1
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
  return receipt;
}

function changeCommissioner(database) {
  database.prepare(`
    INSERT INTO users (
      id,
      email_normalized,
      email_display,
      display_name,
      display_name_normalized,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?,
      'replacement-commissioner@example.test',
      'replacement-commissioner@example.test',
      'Replacement Commissioner',
      'replacement commissioner',
      'active',
      10,
      10,
      1
    )
  `).run(IDS.otherUser);
  database.prepare(`
    INSERT INTO league_memberships (
      id,
      league_id,
      user_id,
      permission_category,
      status,
      joined_at_ms,
      ended_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, ?, 'commissioner', 'active',
      10, NULL, 10, 10, 1
    )
  `).run(
    IDS.otherMembership,
    IDS.league,
    IDS.otherUser
  );
  assert.equal(
    database.prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?,
          updated_at_ms = updated_at_ms + 1,
          version = version + 1
      WHERE id = ?
    `).run(
      IDS.otherMembership,
      IDS.league
    ).changes,
    1
  );
}

function corruptReadinessAttemptHash(
  database,
  attemptId
) {
  const triggerName =
    "free_agent_draft_readiness_attempts_immutable_update";
  const trigger = database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?
  `).get(triggerName);
  assert.ok(trigger?.sql);
  database.exec(`DROP TRIGGER ${triggerName}`);
  try {
    assert.equal(
      database.prepare(`
        UPDATE free_agent_draft_readiness_attempts
        SET projection_sha256 = ?
        WHERE league_id = ? AND id = ?
      `).run(
        "b".repeat(64),
        IDS.league,
        attemptId
      ).changes,
      1
    );
  } finally {
    database.exec(trigger.sql);
  }
}

function seedActiveCarryover(
  database,
  base = 2_000
) {
  const playerId = uuid(base);
  const contractId = uuid(base + 1);
  const contractYearId = uuid(base + 2);
  const ownershipId = uuid(base + 3);
  database.prepare(`
    INSERT INTO players (
      id,
      first_name,
      last_name,
      full_name,
      birth_date,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, 'Carryover', 'Forward',
      'Carryover Forward', NULL, 'active',
      3, 3, 1
    )
  `).run(playerId);
  database.prepare(`
    INSERT INTO contracts (
      id,
      league_id,
      player_id,
      current_team_id,
      contract_type,
      original_total_value_cents,
      original_term_years,
      aav_cents,
      start_season_id,
      status,
      acquisition_source_type,
      acquisition_source_id,
      auction_buyout_lock_expires_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, ?, ?, 'normal', 100, 1, 100,
      ?, 'active', 'season_rollover', NULL,
      NULL, 3, 3, 1
    )
  `).run(
    contractId,
    IDS.league,
    playerId,
    IDS.team,
    IDS.season
  );
  database.prepare(`
    INSERT INTO player_source_state (
      id,
      player_id,
      provider,
      source_position,
      normalized_position,
      nhl_team_abbreviation,
      active,
      source_version,
      source_payload_json,
      effective_at_ms,
      ended_at_ms,
      created_at_ms
    ) VALUES (
      ?, ?, 'sportsdataio', 'F', 'F', NULL,
      1, ?, NULL, 3, NULL, 3
    )
  `).run(
    uuid(base + 4),
    playerId,
    `fixture-${base}`
  );
  database.prepare(`
    INSERT INTO contract_years (
      id,
      league_id,
      contract_id,
      season_id,
      year_number,
      aav_cents,
      status,
      rollover_at_ms,
      created_at_ms
    ) VALUES (
      ?, ?, ?, ?, 1, 100, 'current', NULL, 3
    )
  `).run(
    contractYearId,
    IDS.league,
    contractId,
    IDS.season
  );
  database.prepare(`
    INSERT INTO player_ownerships (
      id,
      league_id,
      season_id,
      player_id,
      team_id,
      ownership_kind,
      roster_category,
      position_group,
      slot_number,
      acquired_transaction_type,
      acquired_transaction_id,
      created_at_ms,
      updated_at_ms,
      version,
      trade_blocked
    ) VALUES (
      ?, ?, ?, ?, ?, 'Rostered', 'Active',
      'F', 1, 'season_rollover', NULL,
      3, 3, 1, 0
    )
  `).run(
    ownershipId,
    IDS.league,
    IDS.season,
    playerId,
    IDS.team
  );
  return Object.freeze({
    playerId,
    contractId,
    contractYearId,
    ownershipId,
  });
}

function activeCarryoverProjection(carryover) {
  return {
    teams: [
      {
        teamId: IDS.team,
        entries: [
          {
            ownershipId: carryover.ownershipId,
            playerId: carryover.playerId,
            contractId: carryover.contractId,
            effectivePositionGroup: "F",
            sourceRosterCategory: "Active",
            requestedSlotGroup: "F",
            requestedSlotNumber: 1,
            placementState: "placed",
            conflictCode: null,
            originalTotalValueCents: 100,
            originalTermYears: 1,
            aavCents: 100,
            remainingYears: 1,
          },
        ],
        carryoverCount: 1,
        openForwardSlots: 11,
        openDefenceSlots: 6,
        openBenchSlots: 4,
        structuralConflictCount: 0,
      },
    ],
    stateBlockers: [],
    structuralWarnings: [],
  };
}

function installScheduleGeneration(
  database,
  {
    operationId,
    scheduleVersion,
    weekOneStartsAtMs,
    completedAtMs,
  }
) {
  database.prepare(`
    UPDATE season_matchup_schedule_generations
    SET status = 'superseded',
        superseded_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND season_id = ?
      AND status = 'current'
  `).run(
    completedAtMs - 1,
    IDS.league,
    IDS.season
  );
  database.prepare(`
    UPDATE matchup_weeks
    SET starts_at_ms = ?,
        baseline_at_ms = ?,
        locks_at_ms = ?,
        ends_at_ms = ?,
        rolls_over_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ?
      AND season_id = ?
      AND id = ?
  `).run(
    weekOneStartsAtMs,
    weekOneStartsAtMs + 60 * 60 * 1000,
    weekOneStartsAtMs +
      16 * 60 * 60 * 1000,
    weekOneStartsAtMs +
      7 * FREE_AGENT_DRAFT_DAY_MS,
    weekOneStartsAtMs +
      7 * FREE_AGENT_DRAFT_DAY_MS,
    completedAtMs - 1,
    IDS.league,
    IDS.season,
    IDS.weekOne
  );
  insertScheduleOperation(
    database,
    operationId,
    completedAtMs
  );
  database.prepare(`
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
      ?, ?, ?, ?, ?, ?, 'current', ?, NULL, 1
    )
  `).run(
    IDS.league,
    IDS.season,
    scheduleVersion,
    operationId,
    IDS.weekOne,
    weekOneStartsAtMs,
    completedAtMs
  );
}

function repositoryRecoveryPlan({
  recoveryKind,
  fadId,
  completedAtMs,
  base,
}) {
  const recoveryId = uuid(base);
  const operationId = uuid(base + 1);
  const weekOneMatchupWeekId = uuid(base + 2);
  const weekOneStartsAtMs =
    WEEK_ONE_AT_MS +
    7 * FREE_AGENT_DRAFT_DAY_MS;
  return Object.freeze({
    action: "stage_recovery",
    recoveryRequired: true,
    recoveryKind,
    scope: Object.freeze({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId,
    }),
    recovery: Object.freeze({
      id: recoveryId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId,
      recoveryKind,
      matchupOperationId: operationId,
      oldScheduleOperationId: IDS.scheduleOne,
      newScheduleOperationId: operationId,
      oldFirstMatchupWeekId: IDS.weekOne,
      newFirstMatchupWeekId:
        weekOneMatchupWeekId,
      oldScheduleVersion: 1,
      newScheduleVersion: 2,
      oldWeekOneStartsAtMs: WEEK_ONE_AT_MS,
      newWeekOneStartsAtMs:
        weekOneStartsAtMs,
      completedAtMs,
    }),
    generation: Object.freeze({
      expectedCurrent: Object.freeze({
        scheduleOperationId: IDS.scheduleOne,
        scheduleVersion: 1,
        weekOneMatchupWeekId: IDS.weekOne,
        weekOneStartsAtMs: WEEK_ONE_AT_MS,
      }),
      replacement: Object.freeze({
        scheduleOperationId: operationId,
        scheduleVersion: 2,
        weekOneMatchupWeekId,
        weekOneStartsAtMs,
      }),
    }),
  });
}

function createRepositoryRecoveryWriter(
  database,
  { calls, failAt = null } = {}
) {
  database.exec(`
    DROP TRIGGER
      free_agent_draft_schedule_recoveries_valid_insert
  `);

  function stage(plan, method) {
    calls?.push(method);
    if (failAt === method) {
      throw new Error(`forced ${method} failure`);
    }
    const old = plan.generation.expectedCurrent;
    const replacement = plan.generation.replacement;
    const changed = database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded',
          superseded_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND schedule_operation_id = @oldOperationId
        AND schedule_version = @oldVersion
        AND status = 'current'
    `).run({
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      completedAtMs: plan.recovery.completedAtMs,
      oldOperationId: old.scheduleOperationId,
      oldVersion: old.scheduleVersion,
    });
    assert.equal(changed.changes, 1);
    database.prepare(`
      DELETE FROM matchup_weeks
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(
      plan.scope.leagueId,
      plan.scope.seasonId,
      old.weekOneMatchupWeekId
    );
    const start = replacement.weekOneStartsAtMs;
    database.prepare(`
      INSERT INTO matchup_weeks (
        id, league_id, season_id, week_key, sequence,
        starts_at_ms, baseline_at_ms, locks_at_ms,
        ends_at_ms, rolls_over_at_ms, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @id, @leagueId, @seasonId, '2026-WR1', 1,
        @startsAtMs, @baselineAtMs, @locksAtMs,
        @endsAtMs, @endsAtMs, 'scheduled',
        @createdAtMs, @createdAtMs, 1
      )
    `).run({
      id: replacement.weekOneMatchupWeekId,
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      startsAtMs: start,
      baselineAtMs: start + 60 * 60 * 1000,
      locksAtMs: start + 16 * 60 * 60 * 1000,
      endsAtMs:
        start + 7 * FREE_AGENT_DRAFT_DAY_MS,
      createdAtMs: plan.recovery.completedAtMs,
    });
    database.prepare(`
      INSERT INTO matchup_operations (
        id, league_id, season_id, matchup_week_id,
        matchup_id, actor_user_id, operation_type,
        status, reason, metadata_json, started_at_ms,
        completed_at_ms
      ) VALUES (
        @id, @leagueId, @seasonId, NULL, NULL, NULL,
        'schedule_generate', 'succeeded', NULL, NULL,
        @completedAtMs, @completedAtMs
      )
    `).run({
      id: replacement.scheduleOperationId,
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      completedAtMs: plan.recovery.completedAtMs,
    });
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version,
        schedule_operation_id, week_one_matchup_week_id,
        week_one_starts_at_ms, status, created_at_ms,
        superseded_at_ms, version
      ) VALUES (
        @leagueId, @seasonId, @scheduleVersion,
        @scheduleOperationId, @weekOneMatchupWeekId,
        @weekOneStartsAtMs, 'current', @createdAtMs,
        NULL, 1
      )
    `).run({
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      scheduleVersion: replacement.scheduleVersion,
      scheduleOperationId:
        replacement.scheduleOperationId,
      weekOneMatchupWeekId:
        replacement.weekOneMatchupWeekId,
      weekOneStartsAtMs:
        replacement.weekOneStartsAtMs,
      createdAtMs: plan.recovery.completedAtMs,
    });
    return {
      staged: true,
      sealed: false,
      recoveryId: plan.recovery.id,
    };
  }

  function seal(plan, method) {
    calls?.push(method);
    if (failAt === method) {
      throw new Error(`forced ${method} failure`);
    }
    const recovery = plan.recovery;
    database.prepare(`
      INSERT INTO free_agent_draft_schedule_recoveries (
        id, league_id, season_id, fad_id, recovery_kind,
        matchup_operation_id, old_schedule_operation_id,
        new_schedule_operation_id, old_first_matchup_week_id,
        new_first_matchup_week_id, old_schedule_version,
        new_schedule_version, old_week_one_starts_at_ms,
        new_week_one_starts_at_ms, removed_week_count,
        removed_matchup_count, replaced_job_count,
        cancelled_job_count, completed_at_ms,
        evidence_schema_version, evidence_sha256,
        created_at_ms, version
      ) VALUES (
        @id, @leagueId, @seasonId, @fadId, @recoveryKind,
        @matchupOperationId, @oldScheduleOperationId,
        @newScheduleOperationId, @oldFirstMatchupWeekId,
        @newFirstMatchupWeekId, @oldScheduleVersion,
        @newScheduleVersion, @oldWeekOneStartsAtMs,
        @newWeekOneStartsAtMs, 1, 0, 0, 0,
        @completedAtMs, 1, @evidenceSha256,
        @completedAtMs, 1
      )
    `).run({
      ...recovery,
      evidenceSha256: "0".repeat(64),
    });
    return {
      staged: true,
      sealed: true,
      recoveryId: recovery.id,
    };
  }

  return Object.freeze({
    stage({ plan }) {
      return stage(plan, "stage");
    },
    seal({ plan }) {
      return seal(plan, "seal");
    },
    applyAndSeal({ plan }) {
      stage(plan, "applyAndSeal");
      return seal(plan, "sealFromApply");
    },
  });
}

function realRecoveryOpeningEvidence(
  base = 20_000
) {
  return Object.freeze({
    fadId: uuid(base),
    participants: Object.freeze(
      RECOVERY_TEAM_IDS.map((teamId, index) =>
        Object.freeze({
          teamId,
          participantId: uuid(
            base + 1 + index * 3
          ),
          cardId: uuid(
            base + 2 + index * 3
          ),
          notificationId: uuid(
            base + 3 + index * 3
          ),
        })
      )
    ),
    reminderJobRunId: uuid(base + 100),
    deadlineJobRunId: uuid(base + 101),
    rolloverIds: Object.freeze(
      Array.from(
        {
          length:
            FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
        },
        (_, index) => uuid(base + 110 + index)
      )
    ),
    rolloverJobRunIds: Object.freeze(
      Array.from(
        {
          length:
            FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT,
        },
        (_, index) => uuid(base + 120 + index)
      )
    ),
    activityId: uuid(base + 130),
    outboxEventId: uuid(base + 131),
    outboxAudienceId: uuid(base + 132),
  });
}

function seedCanonicalRecoverySchedule(
  database,
  fadId,
  {
    recoveryKind = "pre_open",
    recoveryAtMs = RECOVERY_OPENED_AT_MS,
    frozenFadFirstMatchupStartsAtMs = null,
  } = {}
) {
  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @name,
      @nameNormalized,
      'active',
      '#102030',
      '#f0a020',
      NULL,
      2,
      2,
      1
    )
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO team_manager_assignments (
      id,
      league_id,
      team_id,
      user_id,
      membership_id,
      assigned_by_user_id,
      replaces_assignment_id,
      status,
      assigned_at_ms,
      accepted_at_ms,
      ended_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @teamId,
      @userId,
      @membershipId,
      @userId,
      NULL,
      'accepted',
      2,
      2,
      NULL,
      1
    )
  `);
  RECOVERY_TEAM_IDS.slice(1).forEach(
    (teamId, index) => {
      const number = index + 2;
      insertTeam.run({
        id: teamId,
        leagueId: IDS.league,
        name: `Recovery Team ${number}`,
        nameNormalized: `recovery team ${number}`,
      });
      insertAssignment.run({
        id: uuid(410 + index),
        leagueId: IDS.league,
        teamId,
        userId: IDS.user,
        membershipId: IDS.membership,
      });
    }
  );

  const calendar = Object.freeze({
    nhlSeasonKey: "20262027",
    nhlRegularSeasonStartsAtMs:
      WEEK_ONE_AT_MS,
    nhlRegularSeasonEndsAtMs:
      PLAYOFFS_END_AT_MS,
    fantasyPlayoffsStartAtMs:
      PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      PLAYOFFS_END_AT_MS,
    timeZone: "America/Vancouver",
  });
  const planned = planExplicitMatchupSchedule({
    teamIds: RECOVERY_TEAM_IDS,
    ...calendar,
    firstWeekStartsAtMs: WEEK_ONE_AT_MS,
    nowMs: WEEK_ONE_AT_MS - 1,
  });
  const updateFirstWeek = database.prepare(`
    UPDATE matchup_weeks
    SET
      week_key = @weekKey,
      sequence = @sequence,
      starts_at_ms = @startsAtMs,
      baseline_at_ms = @baselineAtMs,
      locks_at_ms = @locksAtMs,
      ends_at_ms = @endsAtMs,
      rolls_over_at_ms = @rollsOverAtMs,
      status = 'scheduled',
      updated_at_ms = 4,
      version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND id = @id
      AND version = 1
  `);
  const insertWeek = database.prepare(`
    INSERT INTO matchup_weeks (
      id,
      league_id,
      season_id,
      week_key,
      sequence,
      starts_at_ms,
      baseline_at_ms,
      locks_at_ms,
      ends_at_ms,
      rolls_over_at_ms,
      status,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @weekKey,
      @sequence,
      @startsAtMs,
      @baselineAtMs,
      @locksAtMs,
      @endsAtMs,
      @rollsOverAtMs,
      'scheduled',
      4,
      4,
      1
    )
  `);
  const insertMatchup = database.prepare(`
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
      4,
      4,
      1
    )
  `);
  const insertJob = database.prepare(`
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
      4,
      4,
      1,
      NULL,
      @scheduledForMs
    )
  `);
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
      @id,
      @jobType,
      @scheduleOperationId,
      1,
      @weekId,
      NULL,
      4,
      1
    )
  `);
  const teamNames = new Map(
    RECOVERY_TEAM_IDS.map((teamId, index) => [
      teamId,
      index === 0
        ? "FAD Team"
        : `Recovery Team ${index + 1}`,
    ])
  );
  const jobs = [];
  const weeks = planned.weeks.map(
    (plannedWeek, weekIndex) => {
      const weekId =
        weekIndex === 0
          ? IDS.weekOne
          : uuid(4_000 + weekIndex);
      const version = weekIndex === 0 ? 2 : 1;
      const week = {
        id: weekId,
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekKey: plannedWeek.weekKey,
        sequence: plannedWeek.sequence,
        startsAtMs: plannedWeek.startsAtMs,
        baselineAtMs: plannedWeek.baselineAtMs,
        locksAtMs: plannedWeek.locksAtMs,
        endsAtMs: plannedWeek.endsAtMs,
        rollsOverAtMs: plannedWeek.rollsOverAtMs,
        status: "scheduled",
        version,
        matchups: [],
        bye: null,
      };
      if (weekIndex === 0) {
        assert.equal(
          updateFirstWeek.run(week).changes,
          1
        );
      } else {
        insertWeek.run(week);
      }
      week.matchups = plannedWeek.pairs.map(
        (pair, pairIndex) => {
          const matchup = {
            id: uuid(
              5_000 + weekIndex * 10 + pairIndex
            ),
            leagueId: IDS.league,
            seasonId: IDS.season,
            weekId,
            homeTeamId: pair.homeTeamId,
            awayTeamId: pair.awayTeamId,
            status: "scheduled",
            version: 1,
          };
          insertMatchup.run({
            ...matchup,
            homeTeamName: teamNames.get(
              matchup.homeTeamId
            ),
            awayTeamName: teamNames.get(
              matchup.awayTeamId
            ),
          });
          return matchup;
        }
      );
      MATCHUP_JOB_SLOTS.forEach(
        ({ jobType, timeField }, slotIndex) => {
          const scheduledForMs = week[timeField];
          const job = {
            id: uuid(
              6_000 + weekIndex * 10 + slotIndex
            ),
            leagueId: IDS.league,
            seasonId: IDS.season,
            weekId,
            jobType,
            occurrenceKey: buildMatchupOccurrenceKey({
              jobType,
              leagueId: IDS.league,
              seasonId: IDS.season,
              weekId,
              scheduleOperationId:
                IDS.scheduleOne,
              scheduleVersion: 1,
              scheduledForMs,
            }),
            scheduledForMs,
            status: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            startedAtMs: null,
            completedAtMs: null,
            resultJson: null,
            lastErrorCode: null,
            createdAtMs: 4,
            updatedAtMs: 4,
            version: 1,
            nextAttemptAtMs: scheduledForMs,
            bindingId: uuid(
              7_000 + weekIndex * 10 + slotIndex
            ),
            bindingJobType: jobType,
            bindingScheduleOperationId:
              IDS.scheduleOne,
            bindingScheduleVersion: 1,
            bindingOwningMatchupWeekId: weekId,
            bindingOwningMatchupId: null,
            bindingCreatedAtMs: 4,
            bindingVersion: 1,
          };
          insertJob.run(job);
          insertBinding.run({
            ...job,
            scheduleOperationId:
              IDS.scheduleOne,
          });
          jobs.push(job);
        }
      );
      return week;
    }
  );

  return Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId,
    recovery: Object.freeze({
      kind: recoveryKind,
      atMs: recoveryAtMs,
      frozenFadFirstMatchupStartsAtMs,
    }),
    calendar,
    currentGeneration: Object.freeze({
      leagueId: IDS.league,
      seasonId: IDS.season,
      scheduleVersion: 1,
      scheduleOperationId: IDS.scheduleOne,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs: WEEK_ONE_AT_MS,
      status: "current",
      supersededAtMs: null,
      version: 1,
    }),
    weeks: Object.freeze(weeks),
    jobs: Object.freeze(jobs),
  });
}

const REAL_RECOVERY_TABLES = Object.freeze([
  "seasons",
  "matchup_weeks",
  "matchups",
  "matchup_byes",
  "matchup_operations",
  "season_matchup_schedule_generations",
  "job_runs",
  "matchup_schedule_job_bindings",
  "free_agent_draft_schedule_recovery_weeks",
  "free_agent_draft_schedule_recovery_matchups",
  "free_agent_draft_schedule_recovery_jobs",
  "free_agent_draft_schedule_recoveries",
  "free_agent_draft_readiness_operations",
  "free_agent_drafts",
  "free_agent_draft_teams",
  "candidate_cards",
  "candidate_card_revisions",
  "candidate_card_snapshots",
  "candidate_card_snapshot_entries",
  "free_agent_draft_player_allocations",
  "free_agent_draft_allocation_events",
  "free_agent_draft_rollovers",
  "free_agent_draft_nomination_queue",
  "free_agent_draft_recoveries",
  "league_activity",
  "notifications",
  "outbox_events",
  "outbox_event_audiences",
]);

function realRecoverySnapshot(database) {
  return Object.freeze(
    Object.fromEntries(
      REAL_RECOVERY_TABLES.map((tableName) => [
        tableName,
        database
          .prepare(
            `SELECT * FROM ${tableName} ORDER BY rowid`
          )
          .all(),
      ])
    )
  );
}

function scheduleRecoverySnapshot(database) {
  const tables = [
    "matchup_weeks",
    "matchups",
    "matchup_byes",
    "matchup_operations",
    "season_matchup_schedule_generations",
    "matchup_schedule_job_bindings",
    "free_agent_draft_schedule_recovery_weeks",
    "free_agent_draft_schedule_recovery_matchups",
    "free_agent_draft_schedule_recovery_jobs",
    "free_agent_draft_schedule_recoveries",
  ];
  return Object.freeze({
    ...Object.fromEntries(
      tables.map((tableName) => [
        tableName,
        database.prepare(
          `SELECT * FROM ${tableName} ORDER BY rowid`
        ).all(),
      ])
    ),
    matchupJobs: database.prepare(`
      SELECT *
      FROM job_runs
      WHERE job_type LIKE 'matchup:%'
      ORDER BY rowid
    `).all(),
  });
}

function createRealPreOpenRecoveryFixture(
  t,
  { afterStep } = {}
) {
  const evidence = realRecoveryOpeningEvidence();
  const runtime = createRuntime(t, {
    scheduleRecoveryWriterFactory(database) {
      return createSqliteFreeAgentDraftScheduleRecoveryWriter({
        database,
        afterStep,
      });
    },
  });
  const context = seedCanonicalRecoverySchedule(
    runtime.database,
    evidence.fadId
  );
  const plan =
    createFreeAgentDraftScheduleRecoveryService({
      secureRandom: makeSecureRandom(50_000),
    }).planRecovery(context);
  assert.equal(plan.action, "stage_recovery");
  assert.equal(plan.recovery.removedWeekCount, 1);
  const openingOptions = Object.freeze({
    evidence,
    openedAtMs: RECOVERY_OPENED_AT_MS,
    scheduleRecoveryPlan: plan,
  });
  return Object.freeze({
    ...runtime,
    context,
    plan,
    openingOptions,
  });
}

function createIntegratedReadinessService({
  database,
  nowMs,
  repository,
  scheduleRecoveryServiceFactory,
  secureRandom = makeSecureRandom(80_000),
}) {
  return createFreeAgentDraftReadinessService({
    clock: Object.freeze({
      nowMs: () => nowMs,
    }),
    readRepository:
      createSqliteFreeAgentDraftReadRepository({
        database,
      }),
    repository,
    scheduleRepository:
      createSqliteMatchupScheduleRepository({
        database,
      }),
    scheduleRecoveryServiceFactory,
    secureRandom,
  });
}

function seedCanonicalReadinessTeamProfiles(database) {
  database.prepare(`
    UPDATE teams
    SET primary_colour = '#102030',
        secondary_colour = '#f0a020',
        tertiary_colour = NULL,
        pattern_template = 'even-two'
    WHERE league_id = ? AND status = 'active'
  `).run(IDS.league);
}

function lockEmptyCandidateCardsAtDeadline(
  database,
  command
) {
  const cards = database.prepare(`
    SELECT *
    FROM candidate_cards
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
    ORDER BY team_id, id
  `).all(command);
  const capLimitCents = database.prepare(`
    SELECT salary_cap_cents
    FROM league_settings
    WHERE league_id = ?
  `).get(command.leagueId).salary_cap_cents;
  const updateCard = database.prepare(`
    UPDATE candidate_cards
    SET status = 'locked_incomplete',
        locked_at_ms = @deadlineAtMs,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND id = @cardId
      AND team_id = @teamId
      AND status = 'open'
      AND version = 1
  `);
  const insertRevision = database.prepare(`
    INSERT INTO candidate_card_revisions (
      id,
      league_id,
      season_id,
      fad_id,
      card_id,
      team_id,
      resulting_card_version,
      action,
      affected_entry_id,
      player_id,
      actor_user_id,
      actor_membership_id,
      actor_authority,
      before_evidence_json,
      after_evidence_json,
      potential_illegality_acknowledged,
      warning_codes_json,
      occurred_at_ms,
      created_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @fadId,
      @cardId,
      @teamId,
      2,
      'deadline_locked',
      NULL,
      NULL,
      NULL,
      NULL,
      'system',
      '{"status":"open"}',
      '{"status":"locked_incomplete"}',
      0,
      '[]',
      @occurredAtMs,
      @occurredAtMs,
      1
    )
  `);
  const insertSnapshot = database.prepare(`
    INSERT INTO candidate_card_snapshots (
      id,
      league_id,
      season_id,
      fad_id,
      card_id,
      team_id,
      locked_card_version,
      locked_status,
      completeness_code,
      filled_mandatory_count,
      missing_mandatory_count,
      filled_bench_count,
      empty_bench_count,
      blocking_validation_count,
      structural_conflict_count,
      cap_limit_cents,
      carried_active_player_amount_cents,
      retention_obligation_cents,
      buyout_penalty_cents,
      carried_cap_usage_cents,
      proposed_candidate_aav_cents,
      maximum_possible_cap_cents,
      maximum_cap_space_cents,
      effective_deadline_at_ms,
      processed_at_ms,
      created_at_ms,
      carried_roster_structural_conflict_count,
      cap_status,
      allocation_eligibility,
      allocation_exclusion_reason
    )
    SELECT
      @snapshotId,
      card.league_id,
      card.season_id,
      card.fad_id,
      card.id,
      card.team_id,
      card.version,
      card.status,
      card.completeness_code,
      card.filled_mandatory_count,
      card.missing_mandatory_count,
      card.filled_bench_count,
      card.empty_bench_count,
      card.blocking_validation_count,
      card.structural_conflict_count,
      @capLimitCents,
      0,
      0,
      0,
      0,
      0,
      card.maximum_possible_cap_cents,
      @capLimitCents - card.maximum_possible_cap_cents,
      @deadlineAtMs,
      @occurredAtMs,
      @occurredAtMs,
      card.carried_roster_structural_conflict_count,
      card.cap_status,
      card.allocation_eligibility,
      card.allocation_exclusion_reason
    FROM candidate_cards AS card
    WHERE card.league_id = @leagueId
      AND card.season_id = @seasonId
      AND card.fad_id = @fadId
      AND card.id = @cardId
      AND card.team_id = @teamId
      AND card.status = 'locked_incomplete'
      AND card.version = 2
  `);
  const insertSnapshotSlot = database.prepare(`
    INSERT INTO candidate_card_snapshot_entries (
      id,
      league_id,
      season_id,
      fad_id,
      snapshot_id,
      card_id,
      team_id,
      row_kind,
      occupant_kind,
      slot_group,
      slot_number,
      created_at_ms,
      allocation_eligibility,
      allocation_exclusion_reason
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @fadId,
      @snapshotId,
      @cardId,
      @teamId,
      'slot',
      'empty',
      @slotGroup,
      @slotNumber,
      @occurredAtMs,
      NULL,
      NULL
    )
  `);
  const slots = [
    ...Array.from(
      { length: 12 },
      (_, index) => ["F", index + 1]
    ),
    ...Array.from(
      { length: 6 },
      (_, index) => ["D", index + 1]
    ),
    ...Array.from(
      { length: 4 },
      (_, index) => ["B", index + 1]
    ),
  ];

  cards.forEach((card, cardIndex) => {
    const values = {
      ...command,
      cardId: card.id,
      teamId: card.team_id,
      deadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
      capLimitCents,
      snapshotId: uuid(81_000 + cardIndex),
    };
    assert.equal(updateCard.run(values).changes, 1);
    insertRevision.run({
      ...values,
      id: uuid(81_100 + cardIndex),
    });
    assert.equal(
      insertSnapshot.run(values).changes,
      1
    );
    slots.forEach(
      ([slotGroup, slotNumber], slotIndex) => {
        insertSnapshotSlot.run({
          ...values,
          id: uuid(
            82_000 + cardIndex * 100 + slotIndex
          ),
          slotGroup,
          slotNumber,
        });
      }
    );
  });

  const deadlineJobValues = {
    ...command,
    deadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
    leaseExpiresAtMs:
      command.occurredAtMs + FREE_AGENT_DRAFT_DAY_MS,
  };
  const matchingDeadlineJob = database.prepare(`
    SELECT COUNT(*) AS count
    FROM job_runs
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND job_type = 'fad_deadline'
      AND scheduled_for_ms = @deadlineAtMs
      AND status = 'pending'
  `).get(deadlineJobValues).count;
  assert.equal(matchingDeadlineJob, 1);
  const leased = database.prepare(`
    UPDATE job_runs
    SET status = 'running',
        attempt_count = attempt_count + 1,
        lease_owner = 'fad-deadline-worker',
        lease_token = 'fad-deadline-token',
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @occurredAtMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND job_type = 'fad_deadline'
      AND scheduled_for_ms = @deadlineAtMs
      AND status = 'pending'
  `).run(deadlineJobValues);
  assert.equal(leased.changes, 1);
}

function finishRapidCompletionEvidence(
  database,
  command
) {
  const finishDeadline = database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @occurredAtMs,
        result_json = '{}',
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND job_type = 'fad_deadline'
      AND scheduled_for_ms = @deadlineAtMs
      AND status = 'running'
  `).run({
    ...command,
    deadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
  });
  assert.equal(finishDeadline.changes, 1);

  database.prepare(`
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
      'fad_completion',
      'fad:' || @fadId || ':complete',
      @scheduledForMs,
      'leased',
      1,
      'fad-completion-worker',
      @leaseExpiresAtMs,
      @scheduledForMs,
      NULL,
      NULL,
      NULL,
      @scheduledForMs,
      @scheduledForMs,
      1,
      'fad-completion-token',
      NULL
    )
  `).run({
    ...command,
    id: uuid(83_000),
    scheduledForMs: command.occurredAtMs - 1,
    leaseExpiresAtMs:
      command.occurredAtMs +
      FREE_AGENT_DRAFT_DAY_MS,
  });

  const rollovers = database.prepare(`
    SELECT rollover.*, job.id AS job_run_id
    FROM free_agent_draft_rollovers AS rollover
    JOIN job_runs AS job
      ON job.league_id = rollover.league_id
     AND job.season_id = rollover.season_id
     AND job.job_type = 'fad_rollover'
     AND job.occurrence_key =
       'fad:' || rollover.fad_id || ':rollover:' ||
         rollover.sequence || ':' || rollover.rolls_over_at_ms
     AND job.scheduled_for_ms = rollover.rolls_over_at_ms
    WHERE rollover.league_id = @leagueId
      AND rollover.season_id = @seasonId
      AND rollover.fad_id = @fadId
    ORDER BY rollover.sequence, rollover.id
  `).all(command);
  const claimJob = database.prepare(`
    UPDATE job_runs
    SET status = 'running',
        attempt_count = attempt_count + 1,
        lease_owner = 'fad-rollover-worker',
        lease_token = @leaseToken,
        lease_expires_at_ms = @leaseExpiresAtMs,
        started_at_ms = @occurredAtMs,
        completed_at_ms = NULL,
        result_json = NULL,
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND id = @jobRunId
      AND status = 'pending'
      AND version = 1
  `);
  const startRollover = database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'processing',
        processing_job_run_id = @jobRunId,
        processing_started_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND id = @rolloverId
      AND status = 'scheduled'
      AND version = 1
  `);
  const finishRollover = database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'completed',
        completed_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND id = @rolloverId
      AND status = 'processing'
      AND version = 2
  `);
  const succeedJob = database.prepare(`
    UPDATE job_runs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at_ms = NULL,
        completed_at_ms = @occurredAtMs,
        result_json = '{}',
        last_error_code = NULL,
        next_attempt_at_ms = NULL,
        updated_at_ms = @occurredAtMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND id = @jobRunId
      AND status = 'running'
      AND lease_token = @leaseToken
      AND version = 2
  `);
  rollovers.forEach((rollover) => {
    const values = {
      ...command,
      rolloverId: rollover.id,
      jobRunId: rollover.job_run_id,
      leaseToken:
        `fad-rollover-${rollover.sequence}`,
      leaseExpiresAtMs:
        command.occurredAtMs +
        FREE_AGENT_DRAFT_DAY_MS,
    };
    assert.equal(claimJob.run(values).changes, 1);
    assert.equal(
      startRollover.run(values).changes,
      1
    );
    assert.equal(
      finishRollover.run(values).changes,
      1
    );
    assert.equal(succeedJob.run(values).changes, 1);
  });

}

function createRealCompletionTransitionWriter(
  database,
  {
    afterTransition,
    beforeTransition,
    calls,
    failAt = null,
  } = {}
) {
  return Object.freeze({
    beforeTransition(command) {
      calls?.push(command.toStatus);
      beforeTransition?.(database, command);
      if (command.toStatus === "deadline_locked") {
        lockEmptyCandidateCardsAtDeadline(
          database,
          command
        );
      } else if (command.toStatus === "completed") {
        finishRapidCompletionEvidence(
          database,
          command
        );
      }
      if (failAt === command.toStatus) {
        throw new Error(
          `forced ${command.toStatus} transition failure`
        );
      }
    },
    ...(afterTransition
      ? {
          afterTransition(payload) {
            return afterTransition(
              database,
              payload
            );
          },
        }
      : {}),
  });
}

function transitionInput({
  fadId,
  expectedVersion,
  fromStatus,
  toStatus,
  occurredAtMs,
  scheduleRecoveryPlan = null,
}) {
  return Object.freeze({
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId,
    expectedVersion,
    fromStatus,
    toStatus,
    occurredAtMs,
    schedule: Object.freeze({
      operationId: IDS.scheduleOne,
      version: 1,
      weekOneMatchupWeekId: IDS.weekOne,
      weekOneStartsAtMs: WEEK_ONE_AT_MS,
    }),
    scheduleRecoveryPlan,
  });
}

function transitionJobExecution(
  overrides = {}
) {
  return Object.freeze({
    runId: uuid(17),
    jobType: "fad_deadline",
    occurrenceKey:
      `fad:deadline:${IDS.league}:${IDS.season}:${uuid(18)}:${CANDIDATE_DEADLINE_AT_MS}`,
    scheduledForMs:
      CANDIDATE_DEADLINE_AT_MS,
    leaseOwner: "fad-deadline-worker",
    leaseToken: "fad-deadline-lease-token",
    leaseExpiresAtMs:
      WEEK_ONE_AT_MS +
      FREE_AGENT_DRAFT_DAY_MS,
    startedAtMs:
      CANDIDATE_DEADLINE_AT_MS,
    attemptCount: 1,
    expectedVersion: 2,
    ...overrides,
  });
}

function createRealCompletionRecoveryFixture(
  t,
  {
    afterTransition,
    beforeCommit,
    beforeTransition,
    completedAtMs = WEEK_ONE_AT_MS,
    afterStep,
    transitionFailAt = null,
  } = {}
) {
  const calls = [];
  const evidence = realRecoveryOpeningEvidence(
    84_000
  );
  const runtime = createRuntime(t, {
    scheduleRecoveryWriterFactory(database) {
      return createSqliteFreeAgentDraftScheduleRecoveryWriter({
        database,
        afterStep,
      });
    },
    transitionWriterFactory(database) {
      return createRealCompletionTransitionWriter(
        database,
        {
          afterTransition,
          beforeTransition,
          calls,
          failAt: transitionFailAt,
        }
      );
    },
    beforeCommit,
  });
  const context = seedCanonicalRecoverySchedule(
    runtime.database,
    evidence.fadId,
    {
      recoveryKind: "completion",
      recoveryAtMs: completedAtMs,
      frozenFadFirstMatchupStartsAtMs:
        WEEK_ONE_AT_MS,
    }
  );
  const plan =
    createFreeAgentDraftScheduleRecoveryService({
      secureRandom: makeSecureRandom(85_000),
    }).planRecovery(context);
  assert.equal(
    plan.action,
    completedAtMs < WEEK_ONE_AT_MS
      ? "no_op"
      : "stage_recovery"
  );
  runtime.repository.ensureReadinessOperation(
    readinessInput()
  );
  const readinessClaim =
    claimReadinessJob(runtime.database);
  const opened = runtime.repository.commitOpening(
    openingInput({
      evidence,
      claim: readinessClaim,
    })
  );
  const deadlineLocked = runtime.repository.advanceStatus(
    transitionInput({
      fadId: opened.draft.id,
      expectedVersion: opened.draft.version,
      fromStatus: "cards_open",
      toStatus: "deadline_locked",
      occurredAtMs: CANDIDATE_DEADLINE_AT_MS,
    })
  );
  const rapid = runtime.repository.advanceStatus(
    transitionInput({
      fadId: opened.draft.id,
      expectedVersion: deadlineLocked.draft.version,
      fromStatus: "deadline_locked",
      toStatus: "rapid",
      occurredAtMs: CANDIDATE_DEADLINE_AT_MS + 1,
    })
  );
  return Object.freeze({
    ...runtime,
    calls,
    context,
    plan,
    opened,
    rapid,
    completionCommand: transitionInput({
      fadId: opened.draft.id,
      expectedVersion: rapid.draft.version,
      fromStatus: "rapid",
      toStatus: "completed",
      occurredAtMs: completedAtMs,
      scheduleRecoveryPlan:
        plan.action === "stage_recovery"
          ? plan
          : null,
    }),
  });
}

describe("SQLite Free Agent Draft lifecycle repository", () => {
  test("exposes the bounded lifecycle surface", (t) => {
    const { repository } = createRuntime(t);
    assert.deepEqual(
      Object.keys(repository),
      REPOSITORY_METHODS
    );
    assert.ok(Object.isFrozen(repository));
  });

  test("requires beforeTransition and validates the optional afterTransition hook at construction", (t) => {
    const { database } = createRuntime(t);

    assert.throws(
      () =>
        createSqliteFreeAgentDraftRepository({
          database,
          transitionWriter: {
            afterTransition() {},
          },
        }),
      /must expose beforeTransition/
    );
    assert.throws(
      () =>
        createSqliteFreeAgentDraftRepository({
          database,
          transitionWriter: {
            beforeTransition() {},
            afterTransition: "not-a-function",
          },
        }),
      /afterTransition must be a function/
    );
    assert.doesNotThrow(() =>
      createSqliteFreeAgentDraftRepository({
        database,
        transitionWriter: {
          beforeTransition() {},
        },
      })
    );
  });

  test("executes a claimed readiness job through real pre-open recovery and atomic card opening", (t) => {
    const { database, repository } = createRuntime(t, {
      useRealCandidateCardWriter: true,
      scheduleRecoveryWriterFactory(currentDatabase) {
        return createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database: currentDatabase,
        });
      },
    });
    seedCanonicalRecoverySchedule(
      database,
      uuid(90_000)
    );
    seedCanonicalReadinessTeamProfiles(database);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const service = createIntegratedReadinessService({
      database,
      nowMs: RECOVERY_OPENED_AT_MS,
      repository,
    });

    const result = service.executeClaimedReadiness({
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey:
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: IDS.league,
          seasonId: IDS.season,
          triggerResourceId: IDS.season,
        }),
      readinessOperationId: IDS.readiness,
      jobExecution: claim.jobExecution,
    });

    assert.equal(result.outcome, "succeeded");
    assert.equal(result.replayed, false);
    assert.equal(
      result.scheduleRecoveryRequired,
      true
    );
    const draft = repository.findDraft({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: result.fadId,
    }).draft;
    assert.equal(draft.status, "cards_open");
    assert.equal(
      draft.firstMatchupStartsAtMs,
      WEEK_ONE_AT_MS +
        7 * FREE_AGENT_DRAFT_DAY_MS
    );
    assert.equal(
      draft.candidateDeadlineAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(
      rowCount(database, "free_agent_draft_teams"),
      RECOVERY_TEAM_IDS.length
    );
    assert.equal(
      rowCount(database, "candidate_cards"),
      RECOVERY_TEAM_IDS.length
    );
    assert.equal(
      rowCount(
        database,
        "candidate_card_revisions"
      ),
      RECOVERY_TEAM_IDS.length
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_rollovers"
      ),
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_schedule_recoveries"
      ),
      1
    );
    assert.deepEqual(
      database.prepare(`
        SELECT outcome, observed_readiness_version,
               attempt_number
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
      `).all(IDS.league),
      [
        {
          outcome: "succeeded",
          observed_readiness_version: 2,
          attempt_number: 1,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count, version,
               created_fad_id,
               matchup_schedule_version_before,
               matchup_schedule_version_after
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readiness),
      {
        status: "succeeded",
        attempt_count: 1,
        version: 3,
        created_fad_id: result.fadId,
        matchup_schedule_version_before: 1,
        matchup_schedule_version_after: 2,
      }
    );
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  });

  test("executes a blocked readiness job without schedule, FAD, card, or activity effects and publishes only its private notification", (t) => {
    const { database, repository } = createRuntime(t, {
      useRealCandidateCardWriter: true,
    });
    seedCanonicalReadinessTeamProfiles(database);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    database.prepare(`
      DELETE FROM team_manager_assignments
      WHERE league_id = ? AND id = ?
    `).run(IDS.league, IDS.assignment);
    const service = createIntegratedReadinessService({
      database,
      nowMs: OPENED_AT_MS,
      repository,
    });

    const result = service.executeClaimedReadiness({
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey:
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: IDS.league,
          seasonId: IDS.season,
          triggerResourceId: IDS.season,
        }),
      readinessOperationId: IDS.readiness,
      jobExecution: claim.jobExecution,
    });

    assert.equal(result.outcome, "blocked");
    assert.equal(result.fadId, null);
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
    assert.equal(
      rowCount(database, "candidate_cards"),
      0
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_schedule_recoveries"
      ),
      0
    );
    assert.equal(rowCount(database, "league_activity"), 0);
    assert.equal(rowCount(database, "outbox_events"), 1);
    assert.deepEqual(
      database.prepare(`
        SELECT status, blockers_json, version
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readiness),
      {
        status: "blocked",
        blockers_json: serializeCanonicalJsonV1([
          {
            code: "FAD_MANAGER_MISSING",
            field: "managerAssignmentId",
            resourceType: "team",
            resourceId: IDS.team,
            message:
              "Every participating team needs a current manager.",
          },
        ]),
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code, version
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readinessJob),
      {
        status: "failed",
        last_error_code: "FAD_READINESS_BLOCKED",
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT outcome
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
      `).all(IDS.league),
      [{ outcome: "blocked" }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT event_type
        FROM notifications
        WHERE league_id = ?
      `).all(IDS.league),
      [{ event_type: "fad_readiness_blocked" }]
    );
  });

  test("transactionally rechecks every opening prerequisite and records semantic drift as a blocker", (t) => {
    const { database, repository } = createRuntime(t, {
      useRealCandidateCardWriter: true,
    });
    seedCanonicalRecoverySchedule(
      database,
      uuid(90_002)
    );
    seedCanonicalReadinessTeamProfiles(database);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    let planCount = 0;
    let openingProbeSnapshot = null;
    const readinessRepository = Object.freeze({
      blockReadinessOperation:
        repository.blockReadinessOperation,
      commitOpening(command) {
        const result = repository.commitOpening(command);
        openingProbeSnapshot = Object.freeze({
          openingBlocked:
            result.openingBlocked === true,
          readinessStatus: result.readiness.status,
          draftCount: rowCount(
            database,
            "free_agent_drafts"
          ),
          cardCount: rowCount(
            database,
            "candidate_cards"
          ),
          recoveryCount: rowCount(
            database,
            "free_agent_draft_schedule_recoveries"
          ),
          attemptCount: rowCount(
            database,
            "free_agent_draft_readiness_attempts"
          ),
          notificationCount: rowCount(
            database,
            "notifications"
          ),
          activityCount: rowCount(
            database,
            "league_activity"
          ),
          outboxCount: rowCount(
            database,
            "outbox_events"
          ),
        });
        return result;
      },
    });
    const service = createIntegratedReadinessService({
      database,
      nowMs: RECOVERY_OPENED_AT_MS,
      repository: readinessRepository,
      scheduleRecoveryServiceFactory({ secureRandom }) {
        const planner =
          createFreeAgentDraftScheduleRecoveryService({
            secureRandom,
          });
        return Object.freeze({
          planRecovery(context) {
            const plan = planner.planRecovery(context);
            planCount += 1;
            database.prepare(`
              DELETE FROM team_manager_assignments
              WHERE league_id = ? AND id = ?
            `).run(IDS.league, IDS.assignment);
            return plan;
          },
        });
      },
    });

    const result = service.executeClaimedReadiness({
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey:
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: IDS.league,
          seasonId: IDS.season,
          triggerResourceId: IDS.season,
        }),
      readinessOperationId: IDS.readiness,
      jobExecution: claim.jobExecution,
    });

    assert.equal(planCount, 1);
    assert.deepEqual(openingProbeSnapshot, {
      openingBlocked: true,
      readinessStatus: "running",
      draftCount: 0,
      cardCount: 0,
      recoveryCount: 0,
      attemptCount: 0,
      notificationCount: 0,
      activityCount: 0,
      outboxCount: 0,
    });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.fadId, null);
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
    assert.equal(
      rowCount(database, "candidate_cards"),
      0
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_schedule_recoveries"
      ),
      0
    );
    assert.equal(rowCount(database, "league_activity"), 0);
    assert.equal(rowCount(database, "outbox_events"), 1);
    assert.deepEqual(
      database.prepare(`
        SELECT status, blockers_json, version
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readiness),
      {
        status: "blocked",
        blockers_json: serializeCanonicalJsonV1([
          {
            code: "FAD_MANAGER_MISSING",
            field: "managerAssignmentId",
            resourceType: "team",
            resourceId: IDS.team,
            message:
              "Every participating team needs a current manager.",
          },
        ]),
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT outcome, observed_readiness_version
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
      `).all(IDS.league),
      [
        {
          outcome: "blocked",
          observed_readiness_version: 2,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, last_error_code, version
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readinessJob),
      {
        status: "failed",
        last_error_code: "FAD_READINESS_BLOCKED",
        version: 3,
      }
    );
  });

  test("rolls real readiness recovery and opening effects back while preserving the reclaimable lease", (t) => {
    const { database, repository } = createRuntime(t, {
      useRealCandidateCardWriter: true,
      scheduleRecoveryWriterFactory(currentDatabase) {
        return createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database: currentDatabase,
          afterStep(step) {
            if (step === "after_schedule_replaced") {
              throw new Error(
                "forced integrated readiness rollback"
              );
            }
          },
        });
      },
    });
    seedCanonicalRecoverySchedule(
      database,
      uuid(90_001)
    );
    seedCanonicalReadinessTeamProfiles(database);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const before = realRecoverySnapshot(database);
    const service = createIntegratedReadinessService({
      database,
      nowMs: RECOVERY_OPENED_AT_MS,
      repository,
    });

    assertRepositoryError(
      () =>
        service.executeClaimedReadiness({
          leagueId: IDS.league,
          seasonId: IDS.season,
          occurrenceKey:
            buildFreeAgentDraftReadinessOccurrenceKey({
              leagueId: IDS.league,
              seasonId: IDS.season,
              triggerResourceId: IDS.season,
            }),
          readinessOperationId: IDS.readiness,
          jobExecution: claim.jobExecution,
        }),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.deepEqual(
      realRecoverySnapshot(database),
      before
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, lease_owner, lease_token,
               lease_expires_at_ms, version
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.readiness),
      {
        status: "running",
        lease_owner: READINESS_JOB_LEASE_OWNER,
        lease_token: READINESS_JOB_LEASE_TOKEN,
        lease_expires_at_ms:
          READINESS_JOB_LEASE_EXPIRES_AT_MS,
        version: 2,
      }
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      0
    );
  });

  test("creates and replays one canonical readiness operation with its exact pending job", (t) => {
    const { database, repository } =
      createRuntime(t);
    const created =
      repository.ensureReadinessOperation(
        readinessInput()
      );
    assert.equal(created.replayed, false);
    assert.equal(created.readiness.status, "pending");
    assert.equal(created.readiness.version, 1);
    assert.equal(
      created.readiness.occurrenceKey,
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: IDS.league,
        seasonId: IDS.season,
        triggerResourceId:
          IDS.season,
      })
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          id,
          league_id,
          season_id,
          job_type,
          occurrence_key,
          scheduled_for_ms,
          status,
          attempt_count,
          lease_owner,
          lease_token,
          lease_expires_at_ms,
          started_at_ms,
          completed_at_ms,
          result_json,
          last_error_code,
          next_attempt_at_ms,
          created_at_ms,
          updated_at_ms,
          version
        FROM job_runs
        WHERE id = ?
      `).get(IDS.readinessJob),
      {
        id: IDS.readinessJob,
        league_id: IDS.league,
        season_id: IDS.season,
        job_type: "fad_readiness",
        occurrence_key:
          created.readiness.occurrenceKey,
        scheduled_for_ms:
          OPENED_AT_MS - 1_000,
        status: "pending",
        attempt_count: 0,
        lease_owner: null,
        lease_token: null,
        lease_expires_at_ms: null,
        started_at_ms: null,
        completed_at_ms: null,
        result_json: null,
        last_error_code: null,
        next_attempt_at_ms: null,
        created_at_ms:
          OPENED_AT_MS - 1_000,
        updated_at_ms:
          OPENED_AT_MS - 1_000,
        version: 1,
      }
    );

    const restartReplay =
      repository.ensureReadinessOperation(
        readinessInput({
          operationId: uuid(900),
        })
      );
    assert.equal(
      restartReplay.replayed,
      true
    );
    assert.equal(
      restartReplay.readiness.id,
      IDS.readiness
    );

    for (const invalidInput of [
      readinessInput({
        operationId: uuid(901),
        jobRunId: null,
      }),
      readinessInput({
        operationId: uuid(902),
        triggerResourceId: IDS.triggerResource,
        jobRunId: uuid(903),
      }),
    ]) {
      assertRepositoryError(
        () =>
          repository.ensureReadinessOperation(
            invalidInput
          ),
        REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
    assert.equal(
      repository.findReadinessByOccurrence({
        leagueId: IDS.otherLeague,
        seasonId: IDS.season,
        occurrenceKey:
          buildFreeAgentDraftReadinessOccurrenceKey({
            leagueId: IDS.otherLeague,
            seasonId: IDS.season,
            triggerResourceId:
              IDS.season,
          }),
      }),
      null
    );
  });

  test("persists canonical blockers and commissioner notification atomically, then replays the same blocker set", (t) => {
    const { database, repository } =
      createRuntime(t);
    const readiness =
      repository.ensureReadinessOperation(
        readinessInput()
      ).readiness;
    const claim = claimReadinessJob(
      database
    );
    const blockers = [
      {
        code: "TEAM_MANAGER_MISSING",
        field: "teamId",
        resourceType: "team",
        resourceId: IDS.team,
        message:
          "The team requires a current manager.",
      },
      {
        code: "SCHEDULE_NOT_READY",
        field: null,
        resourceType: "season",
        resourceId: IDS.season,
        message:
          "The current schedule is not ready.",
      },
    ];
    const command = blockerInput({
      claim,
      blockers,
      blockedAtMs: OPENED_AT_MS - 500,
      nextRetryAtMs: OPENED_AT_MS + 500,
      notificationId: uuid(950),
    });
    assertRepositoryError(
      () =>
        repository.blockReadinessOperation({
          ...command,
          jobExecution: null,
        }),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );
    const blocked =
      repository.blockReadinessOperation(
        command
      );
    assert.equal(blocked.replayed, false);
    assert.equal(
      blocked.readiness.status,
      "blocked"
    );
    assert.equal(
      blocked.readiness.attemptCount,
      1
    );
    assert.equal(blocked.readiness.version, 3);
    const expectedAttempt =
      createFreeAgentDraftReadinessAttemptEvidence(
        command.attempt
      );
    assert.deepEqual(
      database.prepare(`
        SELECT
          id,
          league_id AS leagueId,
          season_id AS seasonId,
          readiness_operation_id AS readinessOperationId,
          job_run_id AS jobRunId,
          attempt_number AS attemptNumber,
          observed_readiness_version AS observedReadinessVersion,
          outcome,
          observed_at_ms AS observedAtMs,
          recorded_at_ms AS recordedAtMs,
          projection_json AS projectionJson,
          projection_sha256 AS projectionSha256,
          version
        FROM free_agent_draft_readiness_attempts
        WHERE id = ?
      `).get(command.attempt.id),
      {
        id: expectedAttempt.id,
        leagueId: expectedAttempt.leagueId,
        seasonId: expectedAttempt.seasonId,
        readinessOperationId:
          expectedAttempt.readinessOperationId,
        jobRunId: expectedAttempt.jobRunId,
        attemptNumber:
          expectedAttempt.attemptNumber,
        observedReadinessVersion:
          expectedAttempt
            .observedReadinessVersion,
        outcome: "blocked",
        observedAtMs:
          expectedAttempt.observedAtMs,
        recordedAtMs:
          expectedAttempt.recordedAtMs,
        projectionJson:
          expectedAttempt.projectionJson,
        projectionSha256:
          expectedAttempt.projectionSha256,
        version: 1,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          status,
          attempt_count AS attemptCount,
          lease_owner AS leaseOwner,
          lease_token AS leaseToken,
          lease_expires_at_ms AS leaseExpiresAtMs,
          started_at_ms AS startedAtMs,
          completed_at_ms AS completedAtMs,
          result_json AS resultJson,
          last_error_code AS lastErrorCode,
          next_attempt_at_ms AS nextAttemptAtMs,
          version
        FROM job_runs
        WHERE id = ?
      `).get(IDS.readinessJob),
      {
        status: "failed",
        attemptCount: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs:
          READINESS_JOB_CLAIMED_AT_MS,
        completedAtMs: command.blockedAtMs,
        resultJson: null,
        lastErrorCode:
          "FAD_READINESS_BLOCKED",
        nextAttemptAtMs:
          command.nextRetryAtMs,
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          lease_owner,
          lease_token,
          lease_expires_at_ms
        FROM free_agent_draft_readiness_operations
        WHERE id = ?
      `).get(readiness.id),
      {
        lease_owner: null,
        lease_token: null,
        lease_expires_at_ms: null,
      }
    );
    assert.deepEqual(
      blocked.readiness.blockers.map(
        ({ code }) => code
      ),
      [
        "SCHEDULE_NOT_READY",
        "TEAM_MANAGER_MISSING",
      ]
    );
    assert.equal(
      database
        .prepare(`
          SELECT blockers_json
          FROM free_agent_draft_readiness_operations
          WHERE id = ?
        `)
        .get(readiness.id).blockers_json,
      serializeCanonicalJsonV1(
        blocked.readiness.blockers
      )
    );
    const notification = database
      .prepare(`
        SELECT *
        FROM notifications
        WHERE id = ?
      `)
      .get(uuid(950));
    assert.equal(
      notification.user_id,
      IDS.user
    );
    assert.equal(
      notification.event_type,
      "fad_readiness_blocked"
    );
    assert.equal(
      notification.league_id,
      IDS.league
    );
    assert.equal(
      notification.related_feature,
      "free_agent_draft"
    );
    assert.equal(
      notification.related_record_id,
      readiness.id
    );
    assert.equal(
      notification.delivery_status,
      "pending"
    );
    assert.equal(
      notification.created_at_ms,
      command.blockedAtMs
    );
    assert.equal(notification.read_at_ms, null);
    assert.equal(
      notification.delivered_at_ms,
      null
    );
    assert.equal(notification.version, 1);
    assert.equal(
      notification.deduplication_key,
      `fad-readiness:${IDS.season}:` +
        `blocked:${readiness.id}:` +
        IDS.user
    );
    assert.deepEqual(
      JSON.parse(notification.message_data_json),
      {
        destination: {
          kind: "commissioner_fad",
          leagueId: IDS.league,
          seasonId: IDS.season,
        },
        errorCodes: [
          "SCHEDULE_NOT_READY",
          "TEAM_MANAGER_MISSING",
        ],
        leagueId: IDS.league,
        readinessOperationId: readiness.id,
        seasonId: IDS.season,
      }
    );
    const notificationPublication = database
      .prepare(`
        SELECT
          event.*,
          audience.audience_kind,
          audience.team_id AS audience_team_id,
          audience.user_id AS audience_user_id
        FROM outbox_events AS event
        JOIN outbox_event_audiences AS audience
          ON audience.league_id = event.league_id
         AND audience.outbox_event_id = event.id
        WHERE event.league_id = @leagueId
          AND event.event_type = 'notification.created'
          AND event.aggregate_type = 'notification'
          AND event.aggregate_id = @notificationId
      `)
      .get({
        leagueId: IDS.league,
        notificationId: notification.id,
      });
    assert.ok(notificationPublication);
    assert.equal(
      notificationPublication.audience_kind,
      "user"
    );
    assert.equal(
      notificationPublication.audience_team_id,
      null
    );
    assert.equal(
      notificationPublication.audience_user_id,
      IDS.user
    );
    assert.deepEqual(
      JSON.parse(
        notificationPublication.payload_json
      ),
      createSocketEventEnvelope({
        eventId: notificationPublication.id,
        type: "notification.created",
        leagueId: IDS.league,
        resourceId: notification.id,
        version: 1,
        reasonCode: "notification_created",
        occurredAt: command.blockedAtMs,
        related: createEmptySocketRelated(),
      })
    );

    const changesBeforeReplay = database
      .prepare(
        "SELECT total_changes() AS changes"
      )
      .get().changes;
    const replay =
      repository.blockReadinessOperation(
        command
      );
    assert.equal(replay.replayed, true);
    assert.equal(
      rowCount(database, "notifications"),
      1
    );
    assert.equal(
      rowCount(database, "outbox_events"),
      1
    );
    assert.equal(
      replay.readiness.version,
      blocked.readiness.version
    );
    assert.equal(
      database
        .prepare(
          "SELECT total_changes() AS changes"
        )
        .get().changes,
      changesBeforeReplay
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      1
    );

    corruptReadinessAttemptHash(
      database,
      command.attempt.id
    );
    const corrupted =
      readinessTerminalSnapshot(database);
    assertRepositoryError(
      () =>
        repository.blockReadinessOperation(
          command
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.deepEqual(
      readinessTerminalSnapshot(database),
      corrupted
    );
  });

  test("does not publish a readiness blocker to an ended membership or inactive commissioner", (t) => {
    const scenarios = [
      {
        label: "ended commissioner membership",
        mutate(database) {
          database.prepare(`
            UPDATE league_memberships
            SET ended_at_ms = ?
            WHERE league_id = ? AND id = ?
          `).run(
            OPENED_AT_MS - 1,
            IDS.league,
            IDS.membership
          );
        },
      },
      {
        label: "inactive commissioner user",
        mutate(database) {
          database.prepare(`
            UPDATE users
            SET status = 'suspended'
            WHERE id = ?
          `).run(IDS.user);
        },
      },
    ];
    for (const scenario of scenarios) {
      const { database, repository } =
        createRuntime(t);
      repository.ensureReadinessOperation(
        readinessInput()
      );
      const claim = claimReadinessJob(database);
      mutateFixtureWithoutGuards(
        database,
        () => scenario.mutate(database)
      );
      const changesBefore = database
        .prepare("SELECT total_changes() AS count")
        .get().count;

      assertRepositoryError(
        () =>
          repository.blockReadinessOperation(
            blockerInput({
              claim,
              blockers: [
                {
                  code: "SCHEDULE_NOT_READY",
                  field: null,
                  resourceType: "season",
                  resourceId: IDS.season,
                  message:
                    "The schedule is incomplete.",
                },
              ],
            })
          ),
        REPOSITORY_ERROR_CODES.versionConflict
      );
      assert.equal(
        database
          .prepare("SELECT total_changes() AS count")
          .get().count,
        changesBefore,
        scenario.label
      );
      for (const tableName of [
        "notifications",
        "outbox_events",
        "outbox_event_audiences",
        "free_agent_draft_readiness_attempts",
      ]) {
        assert.equal(
          rowCount(database, tableName),
          0,
          `${scenario.label}: ${tableName}`
        );
      }
      assert.deepEqual(
        database.prepare(`
          SELECT status, version
          FROM free_agent_draft_readiness_operations
          WHERE league_id = ? AND id = ?
        `).get(IDS.league, IDS.readiness),
        { status: "running", version: 2 },
        scenario.label
      );
    }
  });

  test("rolls blocker state and notification back when the commit hook fails", (t) => {
    const { database, repository } =
      createRuntime(t, {
        beforeCommit(operation) {
          if (
            operation ===
            "blockReadinessOperation"
          ) {
            throw new Error(
              "forced blocker rollback"
            );
          }
        },
      });
    const readiness =
      repository.ensureReadinessOperation(
        readinessInput()
      ).readiness;
    const claim = claimReadinessJob(
      database
    );
    const blockers = [
      {
        code: "SCHEDULE_NOT_READY",
        field: null,
        resourceType: "season",
        resourceId: IDS.season,
        message:
          "The schedule is incomplete.",
      },
    ];
    assertRepositoryError(
      () =>
        repository.blockReadinessOperation(
          blockerInput({
            claim,
            blockers,
          blockedAtMs: OPENED_AT_MS - 500,
            nextRetryAtMs:
              OPENED_AT_MS + 500,
          notificationId: uuid(960),
          })
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    const persisted =
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          readiness.occurrenceKey,
      });
    assert.equal(persisted.status, "running");
    assert.equal(persisted.version, 2);
    assert.equal(persisted.attemptCount, 1);
    assert.equal(
      rowCount(database, "notifications"),
      0
    );
    assert.equal(
      rowCount(database, "outbox_events"),
      0
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      0
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count AS attemptCount,
               lease_token AS leaseToken, version
        FROM job_runs
        WHERE id = ?
      `).get(IDS.readinessJob),
      {
        status: "running",
        attemptCount: 1,
        leaseToken:
          claim.jobExecution.leaseToken,
        version: 2,
      }
    );
  });

  test("requires a future retry and rejects malformed or mismatched readiness-attempt evidence without writes", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const blockers = [
      {
        code: "SCHEDULE_NOT_READY",
        field: null,
        resourceType: "season",
        resourceId: IDS.season,
        message:
          "The current schedule is not ready.",
      },
    ];
    const initial =
      readinessTerminalSnapshot(database);

    for (const nextRetryAtMs of [
      null,
      OPENED_AT_MS - 500,
      OPENED_AT_MS - 501,
    ]) {
      assertRepositoryError(
        () =>
          repository.blockReadinessOperation(
            blockerInput({
              claim,
              blockers,
              blockedAtMs:
                OPENED_AT_MS - 500,
              nextRetryAtMs,
            })
          ),
        REPOSITORY_ERROR_CODES.argumentInvalid
      );
      assert.deepEqual(
        readinessTerminalSnapshot(database),
        initial
      );
    }

    const command = openingInput({ claim });
    const {
      id: omittedAttemptId,
      ...attemptWithoutId
    } = command.attempt;
    assert.equal(
      omittedAttemptId,
      IDS.readinessAttempt
    );
    const blockedAttempt =
      canonicalReadinessAttempt({
        claim,
        outcome: "blocked",
        observedAtMs: OPENED_AT_MS,
        recordedAtMs: OPENED_AT_MS,
        projection:
          readinessAttemptProjection({
            blockers:
              publicBlockers(blockers),
          }),
      });
    const invalidAttempts = [
      {
        attempt: {
          ...command.attempt,
          unexpected: true,
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: attemptWithoutId,
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          projectionSha256: "a".repeat(64),
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          leagueId: IDS.otherLeague,
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          seasonId: uuid(971),
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          readinessOperationId: uuid(972),
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          jobRunId: uuid(973),
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: blockedAttempt,
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          attemptNumber: 2,
        },
        code:
          REPOSITORY_ERROR_CODES.versionConflict,
      },
      {
        attempt: {
          ...command.attempt,
          observedReadinessVersion:
            claim.readinessVersion + 1,
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
      {
        attempt: {
          ...command.attempt,
          observedAtMs:
            command.openedAtMs - 1,
          recordedAtMs:
            command.openedAtMs - 1,
        },
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
      },
    ];
    for (const invalidAttempt of invalidAttempts) {
      assertRepositoryError(
        () =>
          repository.commitOpening(
            openingInput({
              claim,
              attempt:
                invalidAttempt.attempt,
            })
          ),
        invalidAttempt.code
      );
      assert.deepEqual(
        readinessTerminalSnapshot(database),
        initial
      );
    }

    const triggerName =
      "free_agent_draft_readiness_operations_forward_update";
    const trigger = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = ?
    `).get(triggerName);
    assert.ok(trigger?.sql);
    database.exec(`DROP TRIGGER ${triggerName}`);
    try {
      assert.equal(
        database.prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET lease_token = 'split-readiness-token'
          WHERE league_id = ? AND id = ?
        `).run(
          IDS.league,
          IDS.readiness
        ).changes,
        1
      );
    } finally {
      database.exec(trigger.sql);
    }
    const split =
      readinessTerminalSnapshot(database);
    assertRepositoryError(
      () =>
        repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(
      readinessTerminalSnapshot(database),
      split
    );
  });

  test("records each true blocker retry while deduplicating per commissioner user", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const blockers = [
      {
        code: "SCHEDULE_NOT_READY",
        field: null,
        resourceType: "season",
        resourceId: IDS.season,
        message:
          "The current schedule is not ready.",
      },
    ];
    const changedBlockers = [
      {
        code: "TEAM_MANAGER_MISSING",
        field: "teamId",
        resourceType: "team",
        resourceId: IDS.team,
        message:
          "The team requires a current manager.",
      },
    ];
    const firstClaim =
      claimReadinessJob(database);
    const firstBlockedAtMs =
      OPENED_AT_MS - 500;
    repository.blockReadinessOperation(
      blockerInput({
        claim: firstClaim,
        blockers,
        blockedAtMs: firstBlockedAtMs,
        nextRetryAtMs:
          firstBlockedAtMs + 500,
        notificationId: uuid(951),
      })
    );
    const originalNotificationMessage =
      database.prepare(`
        SELECT message_data_json
        FROM notifications
        WHERE league_id = ? AND id = ?
      `).get(
        IDS.league,
        uuid(951)
      ).message_data_json;

    const secondRetryAtMs =
      firstBlockedAtMs + 500;
    retryBlockedReadiness(database, {
      acceptedAtMs: secondRetryAtMs,
      clientKey: "readiness-retry-two",
      expectedVersion: 3,
      idempotencyRequestId: uuid(980),
      receiptId: uuid(981),
      retryAttemptNumber: 2,
    });
    const secondClaim =
      claimReadinessJob(database, {
        expectedVersion: 4,
        leaseOwner:
          "fad-readiness-worker-two",
        leaseToken:
          "fad-readiness-token-two",
        nowMs: secondRetryAtMs,
      });
    assert.equal(secondClaim.attemptNumber, 2);
    const secondBlockedAtMs =
      secondRetryAtMs + 100;
    repository.blockReadinessOperation(
      blockerInput({
        claim: secondClaim,
        blockers: changedBlockers,
        blockedAtMs: secondBlockedAtMs,
        nextRetryAtMs:
          secondBlockedAtMs + 500,
        notificationId: uuid(952),
        attempt:
          canonicalReadinessAttempt({
            claim: secondClaim,
            id: IDS.secondReadinessAttempt,
            outcome: "blocked",
            observedAtMs:
              secondBlockedAtMs,
            recordedAtMs:
              secondBlockedAtMs,
            projection:
              readinessAttemptProjection({
                blockers:
                  publicBlockers(
                    changedBlockers
                  ),
              }),
          }),
      })
    );
    assert.deepEqual(
      database.prepare(`
        SELECT attempt_number, outcome
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
          AND readiness_operation_id = ?
        ORDER BY attempt_number
      `).all(IDS.league, IDS.readiness),
      [
        { attempt_number: 1, outcome: "blocked" },
        { attempt_number: 2, outcome: "blocked" },
      ]
    );
    assert.equal(
      rowCount(database, "notifications"),
      1
    );
    assert.equal(
      rowCount(database, "outbox_events"),
      1
    );
    assert.equal(
      database.prepare(`
        SELECT message_data_json
        FROM notifications
        WHERE league_id = ? AND id = ?
      `).get(
        IDS.league,
        uuid(951)
      ).message_data_json,
      originalNotificationMessage
    );
    assert.deepEqual(
      JSON.parse(
        database.prepare(`
          SELECT projection_json
          FROM free_agent_draft_readiness_attempts
          WHERE league_id = ?
            AND readiness_operation_id = ?
            AND attempt_number = 2
        `).get(
          IDS.league,
          IDS.readiness
        ).projection_json
      ).blockers.map(({ code }) => code),
      ["TEAM_MANAGER_MISSING"]
    );

    changeCommissioner(database);
    const thirdRetryAtMs =
      secondBlockedAtMs + 500;
    retryBlockedReadiness(database, {
      acceptedAtMs: thirdRetryAtMs,
      actorMembershipId:
        IDS.otherMembership,
      actorUserId: IDS.otherUser,
      clientKey: "readiness-retry-three",
      expectedVersion: 6,
      idempotencyRequestId: uuid(982),
      receiptId: uuid(983),
      retryAttemptNumber: 3,
    });
    const thirdClaim =
      claimReadinessJob(database, {
        expectedVersion: 7,
        leaseOwner:
          "fad-readiness-worker-three",
        leaseToken:
          "fad-readiness-token-three",
        nowMs: thirdRetryAtMs,
      });
    assert.equal(thirdClaim.attemptNumber, 3);
    const thirdBlockedAtMs =
      thirdRetryAtMs + 100;
    repository.blockReadinessOperation(
      blockerInput({
        claim: thirdClaim,
        blockers: changedBlockers,
        blockedAtMs: thirdBlockedAtMs,
        nextRetryAtMs:
          thirdBlockedAtMs + 500,
        notificationId: uuid(953),
        attempt:
          canonicalReadinessAttempt({
            claim: thirdClaim,
            id: uuid(17),
            outcome: "blocked",
            observedAtMs: thirdBlockedAtMs,
            recordedAtMs: thirdBlockedAtMs,
            projection:
              readinessAttemptProjection({
                blockers:
                  publicBlockers(
                    changedBlockers
                  ),
              }),
          }),
      })
    );
    assert.deepEqual(
      database.prepare(`
        SELECT attempt_number
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
          AND readiness_operation_id = ?
        ORDER BY attempt_number
      `).all(IDS.league, IDS.readiness),
      [
        { attempt_number: 1 },
        { attempt_number: 2 },
        { attempt_number: 3 },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT user_id, deduplication_key
        FROM notifications
        WHERE league_id = ?
          AND event_type = 'fad_readiness_blocked'
        ORDER BY user_id
      `).all(IDS.league),
      [IDS.user, IDS.otherUser]
        .sort()
        .map((userId) => ({
          user_id: userId,
          deduplication_key:
            `fad-readiness:${IDS.season}:` +
            `blocked:${IDS.readiness}:` +
            userId,
        }))
    );
    assert.equal(
      rowCount(database, "outbox_events"),
      2
    );
  });

  test("reclaims an expired readiness lease without incrementing the attempt and rejects the old token", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const expiredAtMs =
      OPENED_AT_MS - 250;
    const firstClaim =
      claimReadinessJob(database, {
        leaseExpiresAtMs: expiredAtMs,
      });
    const reclaimed =
      claimReadinessJob(database, {
        expectedVersion: 2,
        leaseOwner:
          "fad-readiness-reclaim-worker",
        leaseToken:
          "fad-readiness-reclaim-token",
        nowMs: expiredAtMs,
      });
    assert.equal(reclaimed.attemptNumber, 1);
    assert.equal(reclaimed.readinessVersion, 3);

    const staleTokenClaim = {
      ...reclaimed,
      jobExecution: {
        ...reclaimed.jobExecution,
        leaseOwner:
          firstClaim.jobExecution.leaseOwner,
        leaseToken:
          firstClaim.jobExecution.leaseToken,
      },
    };
    const beforeStaleToken =
      readinessTerminalSnapshot(database);
    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({
            claim: staleTokenClaim,
          })
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(
      readinessTerminalSnapshot(database),
      beforeStaleToken
    );

    const command = openingInput({
      claim: reclaimed,
    });
    const opened =
      repository.commitOpening(command);
    assert.equal(opened.replayed, false);
    assert.deepEqual(
      database.prepare(`
        SELECT attempt_number,
               observed_readiness_version,
               outcome
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
          AND readiness_operation_id = ?
      `).get(IDS.league, IDS.readiness),
      {
        attempt_number: 1,
        observed_readiness_version: 3,
        outcome: "succeeded",
      }
    );
    assert.equal(
      database.prepare(`
        SELECT attempt_count
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(
        IDS.league,
        IDS.readinessJob
      ).attempt_count,
      1
    );
  });

  test("rejects missing, unclaimed, stale, mismatched, expired, and reused readiness-job execution evidence without opening", (t) => {
    const { database, repository } =
      createRuntime(t);
    const readiness =
      repository.ensureReadinessOperation(
        readinessInput()
      ).readiness;

    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({
            jobExecution: null,
          })
        ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );
    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput()
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );

    const claim = claimReadinessJob(
      database
    );
    for (const invalidExecution of [
      {
        name: "stale version",
        code:
          REPOSITORY_ERROR_CODES.argumentInvalid,
        jobExecution:
          readinessJobExecution({
            expectedVersion: 1,
          }),
      },
      {
        name: "wrong owner",
        code:
          REPOSITORY_ERROR_CODES.versionConflict,
        jobExecution:
          readinessJobExecution({
            leaseOwner:
              "wrong-readiness-worker",
          }),
      },
      {
        name: "wrong token",
        code:
          REPOSITORY_ERROR_CODES.versionConflict,
        jobExecution:
          readinessJobExecution({
            leaseToken:
              "wrong-readiness-token",
          }),
      },
      {
        name: "wrong run",
        code:
          REPOSITORY_ERROR_CODES.versionConflict,
        jobExecution:
          readinessJobExecution({
            runId: uuid(970),
          }),
      },
    ]) {
      assert.throws(
        () =>
          repository.commitOpening(
            openingInput({
              claim,
              jobExecution:
                invalidExecution
                  .jobExecution,
            })
          ),
        (error) => {
          assert.equal(
            error.code,
            invalidExecution.code,
            invalidExecution.name
          );
          return true;
        }
      );
    }
    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({
            claim,
            jobExecution:
              readinessJobExecution({
                leaseExpiresAtMs:
                  OPENED_AT_MS,
              }),
          })
        ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );

    const reusedEvidence = openingEvidence(970);
    reusedEvidence.deadlineJobRunId =
      IDS.readinessJob;
    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({
            evidence: reusedEvidence,
            claim,
          })
        ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );

    const reclaimTriggerName =
      "free_agent_draft_readiness_job_reclaim_guard";
    const reclaimTrigger = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = ?
    `).get(reclaimTriggerName);
    assert.ok(reclaimTrigger?.sql);
    database.exec(
      `DROP TRIGGER ${reclaimTriggerName}`
    );
    try {
      assert.equal(
        database.prepare(`
          UPDATE job_runs
          SET job_type = 'fad_deadline'
          WHERE id = ?
        `).run(IDS.readinessJob).changes,
        1
      );
    } finally {
      database.exec(reclaimTrigger.sql);
    }
    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({
            claim,
          })
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    const persisted =
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          readiness.occurrenceKey,
      });
    assert.equal(persisted.status, "running");
    assert.equal(persisted.version, 2);
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
  });

  test("never opens or publishes to ended, inactive, or malformed manager authority", (t) => {
    const scenarios = [
      {
        label: "ended manager membership",
        outcome: "conflict",
        mutate(database) {
          database.prepare(`
            UPDATE league_memberships
            SET ended_at_ms = ?
            WHERE league_id = ? AND id = ?
          `).run(
            OPENED_AT_MS - 1,
            IDS.league,
            IDS.membership
          );
        },
      },
      {
        label: "inactive manager user",
        outcome: "blocked",
        mutate(database) {
          database.prepare(`
            UPDATE users
            SET status = 'suspended'
            WHERE id = ?
          `).run(IDS.user);
        },
      },
      {
        label: "accepted assignment without acceptance evidence",
        outcome: "conflict",
        mutate(database) {
          database.prepare(`
            UPDATE team_manager_assignments
            SET accepted_at_ms = NULL
            WHERE league_id = ? AND id = ?
          `).run(IDS.league, IDS.assignment);
        },
      },
    ];
    for (const scenario of scenarios) {
      const { database, repository } =
        createRuntime(t);
      repository.ensureReadinessOperation(
        readinessInput()
      );
      const claim = claimReadinessJob(database);
      const command = openingInput({ claim });
      mutateFixtureWithoutGuards(
        database,
        () => scenario.mutate(database)
      );

      if (scenario.outcome === "blocked") {
        const result = repository.commitOpening(command);
        assert.equal(result.openingBlocked, true);
        assert.deepEqual(
          result.internalBlockers.map(({ code }) => code),
          ["FAD_MANAGER_INVALID"]
        );
      } else {
        assertRepositoryError(
          () => repository.commitOpening(command),
          REPOSITORY_ERROR_CODES.versionConflict
        );
      }
      assertOpeningRolledBack(
        database,
        repository,
        command.occurrenceKey
      );
      assert.equal(
        rowCount(database, "outbox_event_audiences"),
        0,
        scenario.label
      );
    }
  });

  test("opens every team with the adaptive help clock, seven persisted rollovers, jobs, notifications, and durable restart replay", (t) => {
    const { database, repository } =
      createRuntime(t);
    const readiness =
      repository.ensureReadinessOperation(
        readinessInput()
      ).readiness;
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });
    const opened =
      repository.commitOpening(command);
    assert.equal(opened.replayed, false);
    assert.equal(
      opened.readiness.status,
      "succeeded"
    );
    assert.equal(opened.readiness.version, 3);
    const expectedAttempt =
      createFreeAgentDraftReadinessAttemptEvidence(
        command.attempt
      );
    assert.deepEqual(
      database.prepare(`
        SELECT
          attempt_number AS attemptNumber,
          observed_readiness_version AS observedReadinessVersion,
          outcome,
          observed_at_ms AS observedAtMs,
          recorded_at_ms AS recordedAtMs,
          projection_json AS projectionJson,
          projection_sha256 AS projectionSha256,
          version
        FROM free_agent_draft_readiness_attempts
        WHERE id = ?
      `).get(command.attempt.id),
      {
        attemptNumber: claim.attemptNumber,
        observedReadinessVersion:
          claim.readinessVersion,
        outcome: "succeeded",
        observedAtMs: OPENED_AT_MS,
        recordedAtMs: OPENED_AT_MS,
        projectionJson:
          expectedAttempt.projectionJson,
        projectionSha256:
          expectedAttempt.projectionSha256,
        version: 1,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          status,
          attempt_count AS attemptCount,
          lease_owner AS leaseOwner,
          lease_token AS leaseToken,
          lease_expires_at_ms AS leaseExpiresAtMs,
          started_at_ms AS startedAtMs,
          completed_at_ms AS completedAtMs,
          result_json AS resultJson,
          last_error_code AS lastErrorCode,
          next_attempt_at_ms AS nextAttemptAtMs,
          version
        FROM job_runs
        WHERE id = ?
      `).get(IDS.readinessJob),
      {
        status: "succeeded",
        attemptCount: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs:
          READINESS_JOB_CLAIMED_AT_MS,
        completedAtMs: OPENED_AT_MS,
        resultJson:
          `{"fadId":"${opened.draft.id}",` +
          `"readinessAttemptId":"${command.attempt.id}",` +
          `"readinessOperationId":"${IDS.readiness}"}`,
        lastErrorCode: null,
        nextAttemptAtMs: null,
        version: 3,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          lease_owner,
          lease_token,
          lease_expires_at_ms
        FROM free_agent_draft_readiness_operations
        WHERE id = ?
      `).get(readiness.id),
      {
        lease_owner: null,
        lease_token: null,
        lease_expires_at_ms: null,
      }
    );
    assert.equal(
      opened.draft.status,
      "cards_open"
    );
    assert.equal(
      opened.draft.helpOpensAtMs,
      OPENED_AT_MS
    );
    assert.equal(
      opened.draft.candidateDeadlineAtMs,
      CANDIDATE_DEADLINE_AT_MS
    );
    assert.equal(
      opened.draft.firstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(opened.participants.length, 1);
    assert.equal(opened.cards.length, 1);
    assert.equal(
      opened.rollovers.length,
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
    );
    assert.deepEqual(
      opened.rollovers.map(
        ({ sequence }) => sequence
      ),
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(
      opened.rollovers.at(-1).rollsOverAtMs,
      WEEK_ONE_AT_MS
    );
    for (
      let index = 0;
      index < opened.rollovers.length;
      index += 1
    ) {
      const rollover = opened.rollovers[index];
      assert.equal(
        rollover.opensAtMs,
        CANDIDATE_DEADLINE_AT_MS +
          index * FREE_AGENT_DRAFT_DAY_MS
      );
      assert.equal(
        rollover.creationCutoffAtMs,
        rollover.rollsOverAtMs -
          60 * 60 * 1000
      );
      assert.equal(
        rollover.predecessorRolloverId,
        index === 0
          ? null
          : opened.rollovers[index - 1].id
      );
    }
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM job_runs
          WHERE league_id = ?
            AND season_id = ?
            AND job_type IN (
              'fad_deadline_reminder',
              'fad_deadline',
              'fad_rollover'
            )
            AND status = 'pending'
            AND attempt_count = 0
        `)
        .get(
          IDS.league,
          IDS.season
        ).count,
      9
    );
    const openingNotification = database
      .prepare(`
        SELECT *
        FROM notifications
        WHERE event_type = 'fad_cards_opened'
          AND related_record_id = ?
      `)
      .get(opened.draft.id);
    const openingParticipant =
      command.evidence.participants[0];
    assert.equal(
      openingNotification.id,
      openingParticipant.notificationId
    );
    assert.equal(
      openingNotification.user_id,
      IDS.user
    );
    assert.equal(
      openingNotification.league_id,
      IDS.league
    );
    assert.equal(
      openingNotification.related_feature,
      "free_agent_draft"
    );
    assert.equal(
      openingNotification.delivery_status,
      "pending"
    );
    assert.equal(
      openingNotification.created_at_ms,
      OPENED_AT_MS
    );
    assert.equal(
      openingNotification.read_at_ms,
      null
    );
    assert.equal(
      openingNotification.delivered_at_ms,
      null
    );
    assert.equal(
      openingNotification.version,
      1
    );
    assert.equal(
      openingNotification.deduplication_key,
      `fad:${opened.draft.id}:` +
        `cards-opened:${IDS.team}:` +
        IDS.user
    );
    assert.deepEqual(
      JSON.parse(
        openingNotification.message_data_json
      ),
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: opened.draft.id,
        teamId: IDS.team,
        cardId: openingParticipant.cardId,
        candidateDeadlineAtMs:
          CANDIDATE_DEADLINE_AT_MS,
        destination: {
          kind: "private_card",
          leagueId: IDS.league,
          fadId: opened.draft.id,
          teamId: IDS.team,
          cardId: openingParticipant.cardId,
        },
      }
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM league_activity
          WHERE event_type =
              'free_agent_draft_started'
            AND related_type =
              'free_agent_draft'
            AND related_id = ?
        `)
        .get(opened.draft.id).count,
      1
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
            AND audience_kind = 'league'
        `)
        .get(
          command.evidence.outboxEventId
        ).count,
      1
    );
    const openingOutboxRows = database
      .prepare(`
        SELECT
          id,
          event_type,
          aggregate_type,
          aggregate_id,
          payload_json
        FROM outbox_events
        WHERE league_id = ?
          AND created_at_ms = ?
          AND event_type IN (
            'free_agent_draft.changed',
            'activity.created',
            'candidate_card.changed',
            'notification.created'
          )
        ORDER BY event_type, aggregate_id, id
      `)
      .all(IDS.league, OPENED_AT_MS);
    assert.equal(openingOutboxRows.length, 4);
    const expectedOpeningPublications = new Map([
      [
        "free_agent_draft.changed",
        {
          aggregateType: "free_agent_draft",
          aggregateId: opened.draft.id,
          version: opened.draft.version,
          reasonCode: "cards_opened",
          related: {
            fadId: opened.draft.id,
            teamId: null,
            cardId: null,
          },
          audienceKind: "league",
          audienceId: null,
        },
      ],
      [
        "activity.created",
        {
          aggregateType: "league_activity",
          aggregateId: command.evidence.activityId,
          version: 1,
          reasonCode: "cards_opened",
          related: {
            fadId: opened.draft.id,
            teamId: null,
            cardId: null,
          },
          audienceKind: "league",
          audienceId: null,
        },
      ],
      [
        "candidate_card.changed",
        {
          aggregateType: "candidate_card",
          aggregateId: openingParticipant.cardId,
          version: 1,
          reasonCode: "card_changed",
          related: {
            fadId: opened.draft.id,
            teamId: IDS.team,
            cardId: openingParticipant.cardId,
          },
          audienceKind: "team",
          audienceId: IDS.team,
        },
      ],
      [
        "notification.created",
        {
          aggregateType: "notification",
          aggregateId: openingParticipant.notificationId,
          version: 1,
          reasonCode: "cards_opened",
          related: {
            fadId: opened.draft.id,
            teamId: IDS.team,
            cardId: openingParticipant.cardId,
          },
          audienceKind: "user",
          audienceId: IDS.user,
        },
      ],
    ]);
    for (const row of openingOutboxRows) {
      const expected = expectedOpeningPublications.get(
        row.event_type
      );
      assert.ok(expected);
      assert.equal(
        row.aggregate_type,
        expected.aggregateType
      );
      assert.equal(
        row.aggregate_id,
        expected.aggregateId
      );
      const envelope = JSON.parse(row.payload_json);
      assert.deepEqual(Object.keys(envelope), [
        "eventId",
        "type",
        "leagueId",
        "resourceId",
        "version",
        "reasonCode",
        "occurredAt",
        "related",
      ]);
      assert.equal(envelope.eventId, row.id);
      assert.equal(envelope.type, row.event_type);
      assert.equal(envelope.leagueId, IDS.league);
      assert.equal(
        envelope.resourceId,
        row.aggregate_id
      );
      assert.equal(envelope.version, expected.version);
      assert.equal(
        envelope.reasonCode,
        expected.reasonCode
      );
      assert.equal(envelope.occurredAt, OPENED_AT_MS);
      assert.deepEqual(Object.keys(envelope.related), [
        "fadId",
        "teamId",
        "cardId",
        "allocationId",
        "auctionId",
        "recoveryId",
        "nominationQueueId",
        "scheduleRecoveryOperationId",
      ]);
      assert.deepEqual(envelope.related, {
        ...expected.related,
        allocationId: null,
        auctionId: null,
        recoveryId: null,
        nominationQueueId: null,
        scheduleRecoveryOperationId: null,
      });
      const audiences = database
        .prepare(`
          SELECT
            audience_kind,
            team_id,
            user_id
          FROM outbox_event_audiences
          WHERE league_id = ?
            AND outbox_event_id = ?
        `)
        .all(IDS.league, row.id);
      assert.deepEqual(audiences, [
        {
          audience_kind: expected.audienceKind,
          team_id:
            expected.audienceKind === "team"
              ? expected.audienceId
              : null,
          user_id:
            expected.audienceKind === "user"
              ? expected.audienceId
              : null,
        },
      ]);
    }

    const restarted =
      createSqliteFreeAgentDraftRepository({
        database,
        notificationWriter:
          createSqliteNotificationWriter({
            database,
          }),
        candidateCardWriter:
          createCandidateCardWriter(database),
      });
    const changesBeforeReplay = database
      .prepare(
        "SELECT total_changes() AS changes"
      )
      .get().changes;
    const replay =
      restarted.commitOpening(
        command
      );
    assert.equal(replay.replayed, true);
    assert.equal(
      replay.draft.id,
      opened.draft.id
    );
    assert.equal(
      replay.readiness.version,
      opened.readiness.version
    );
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      1
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_rollovers"
      ),
      7
    );
    assert.equal(
      rowCount(database, "job_runs"),
      10
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      1
    );
    assert.equal(
      database
        .prepare(
          "SELECT total_changes() AS changes"
        )
        .get().changes,
      changesBeforeReplay
    );
  });

  test("rolls the entire opening back on a late failure", (t) => {
    const { database, repository } =
      createRuntime(t, {
        beforeCommit(operation) {
          if (operation === "commitOpening") {
            throw new Error(
              "forced opening rollback"
            );
          }
        },
      });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });
    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    for (const tableName of [
      "free_agent_drafts",
      "free_agent_draft_teams",
      "candidate_cards",
      "free_agent_draft_rollovers",
      "league_activity",
      "notifications",
      "outbox_events",
      "outbox_event_audiences",
      "free_agent_draft_readiness_attempts",
    ]) {
      assert.equal(
        rowCount(database, tableName),
        0,
        tableName
      );
    }
    assert.equal(
      rowCount(database, "job_runs"),
      1
    );
    const readiness =
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          command.occurrenceKey,
      });
    assert.equal(readiness.status, "running");
    assert.equal(readiness.version, 2);
    assert.equal(readiness.attemptCount, 1);
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count AS attemptCount,
               lease_token AS leaseToken, version
        FROM job_runs
        WHERE id = ?
      `).get(IDS.readinessJob),
      {
        status: "running",
        attemptCount: 1,
        leaseToken:
          claim.jobExecution.leaseToken,
        version: 2,
      }
    );
  });

  test("stages pre-open recovery after readiness starts, seals it after FAD creation, and records exact old-to-new provenance", (t) => {
    const calls = [];
    const evidence = openingEvidence(3_100);
    const plan = repositoryRecoveryPlan({
      recoveryKind: "pre_open",
      fadId: evidence.fadId,
      completedAtMs: RECOVERY_OPENED_AT_MS,
      base: 3_200,
    });
    const { database, repository } = createRuntime(t, {
      scheduleRecoveryWriterFactory(currentDatabase) {
        return createRepositoryRecoveryWriter(
          currentDatabase,
          { calls }
        );
      },
    });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      evidence,
      openedAtMs: RECOVERY_OPENED_AT_MS,
      scheduleRecoveryPlan: plan,
      claim,
    });

    const opened = repository.commitOpening(command);
    assert.deepEqual(calls, ["stage", "seal"]);
    assert.equal(opened.replayed, false);
    assert.equal(
      opened.draft.firstMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(
      opened.draft
        .currentCompetitionFirstMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(opened.draft.scheduleRecoveryId, null);
    assert.equal(
      opened.draft.firstMatchupStartsAtMs,
      plan.recovery.newWeekOneStartsAtMs
    );
    assert.equal(
      opened.readiness.matchupScheduleVersionBefore,
      1
    );
    assert.equal(
      opened.readiness.matchupScheduleVersionAfter,
      2
    );
    assert.equal(
      opened.readiness.scheduleRecoveryId,
      plan.recovery.id
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_schedule_recoveries
        WHERE id = ? AND recovery_kind = 'pre_open'
      `).get(plan.recovery.id).count,
      1
    );

    const replay = repository.commitOpening(command);
    assert.equal(replay.replayed, true);
    assert.deepEqual(calls, ["stage", "seal"]);
  });

  test("commits a real one-Monday pre-open schedule recovery with effective clocks and exact replay", (t) => {
    const {
      database,
      repository,
      context,
      plan,
      openingOptions,
    } = createRealPreOpenRecoveryFixture(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const seasonVersionBefore = database
      .prepare(
        "SELECT version FROM seasons WHERE id = ?"
      )
      .get(IDS.season).version;
    const command = openingInput({
      ...openingOptions,
      claim,
      observedSeasonVersion:
        seasonVersionBefore,
    });
    const opened =
      repository.commitOpening(command);

    assert.equal(opened.replayed, false);
    assert.equal(
      opened.draft.firstMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(
      opened.draft
        .currentCompetitionFirstMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(opened.draft.scheduleRecoveryId, null);
    assert.equal(
      opened.draft.firstMatchupStartsAtMs,
      plan.recovery.newWeekOneStartsAtMs
    );
    assert.equal(
      opened.draft.candidateDeadlineAtMs,
      plan.recovery.newWeekOneStartsAtMs -
        FREE_AGENT_DRAFT_INITIAL_WINDOW_MS
    );
    assert.equal(
      opened.rollovers.at(-1).rollsOverAtMs,
      plan.recovery.newWeekOneStartsAtMs
    );
    assert.equal(
      opened.readiness.matchupScheduleVersionBefore,
      plan.recovery.oldScheduleVersion
    );
    assert.equal(
      opened.readiness.matchupScheduleVersionAfter,
      plan.recovery.newScheduleVersion
    );
    assert.equal(
      opened.readiness.scheduleRecoveryId,
      plan.recovery.id
    );
    assert.equal(
      command.attempt.projection
        .observedSeasonVersion,
      seasonVersionBefore
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          recovery_kind,
          old_schedule_version,
          new_schedule_version,
          old_first_matchup_week_id,
          new_first_matchup_week_id,
          evidence_sha256
        FROM free_agent_draft_schedule_recoveries
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, plan.recovery.id),
      {
        recovery_kind: "pre_open",
        old_schedule_version:
          plan.recovery.oldScheduleVersion,
        new_schedule_version:
          plan.recovery.newScheduleVersion,
        old_first_matchup_week_id:
          plan.recovery.oldFirstMatchupWeekId,
        new_first_matchup_week_id:
          plan.recovery.newFirstMatchupWeekId,
        evidence_sha256:
          plan.recovery.evidenceSha256,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM job_runs
        WHERE league_id = ?
          AND season_id = ?
          AND status = 'skipped'
      `).get(IDS.league, IDS.season).count,
      context.jobs.length
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM matchup_schedule_job_bindings
        WHERE league_id = ?
          AND season_id = ?
          AND schedule_operation_id = ?
          AND schedule_version = ?
      `).get(
        IDS.league,
        IDS.season,
        plan.recovery.newScheduleOperationId,
        plan.recovery.newScheduleVersion
      ).count,
      plan.replacementJobs.length
    );
    assert.deepEqual(
      database.pragma("foreign_key_check"),
      []
    );
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);

    const beforeReplay =
      realRecoverySnapshot(database);
    const replay =
      repository.commitOpening(command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.draft.id, opened.draft.id);
    assert.equal(
      replay.readiness.scheduleRecoveryId,
      plan.recovery.id
    );
    assert.deepEqual(
      realRecoverySnapshot(database),
      beforeReplay
    );
  });

  test("rejects a stale real pre-open recovery plan without partial opening or schedule writes", (t) => {
    const {
      database,
      repository,
      plan,
      openingOptions,
    } = createRealPreOpenRecoveryFixture(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const stalePlan = structuredClone(plan);
    stalePlan.generation.expectedCurrent.version = 2;
    stalePlan.generation.superseded.version = 3;
    const command = openingInput({
      ...openingOptions,
      claim,
      scheduleRecoveryPlan: stalePlan,
    });
    const before = realRecoverySnapshot(database);

    assertRepositoryError(
      () =>
        repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(
      realRecoverySnapshot(database),
      before
    );
    assert.equal(
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey: command.occurrenceKey,
      }).status,
      "running"
    );
  });

  test("rolls a real pre-open recovery seal and every opening write back together", (t) => {
    const fixture =
      createRealPreOpenRecoveryFixture(t, {
        afterStep(step) {
          if (step === "after_recovery_seal") {
            throw new Error(
              "forced post-seal opening rollback"
            );
          }
        },
      });
    fixture.repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(
      fixture.database
    );
    const command = openingInput({
      ...fixture.openingOptions,
      claim,
    });
    const before = realRecoverySnapshot(
      fixture.database
    );

    assertRepositoryError(
      () =>
        fixture.repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(
      rowCount(
        fixture.database,
        "free_agent_draft_readiness_attempts"
      ),
      0
    );
    assert.equal(
      fixture.repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey: command.occurrenceKey,
      }).status,
      "running"
    );
    assert.deepEqual(
      fixture.database.pragma("foreign_key_check"),
      []
    );
  });

  test("runs the optional post-transition writer after the root read and before beforeCommit, but never on failure or replay", (t) => {
    const events = [];
    const payloads = [];
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        beforeTransition(database, command) {
          events.push(`before:${command.toStatus}`);
          assert.equal(database.inTransaction, true);
          if (command.toStatus === "completed") {
            assert.equal(
              database.prepare(`
                SELECT status
                FROM free_agent_drafts
                WHERE id = ?
              `).get(command.fadId).status,
              "rapid"
            );
          }
        },
        afterTransition(database, payload) {
          events.push(
            `after:${payload.updated.status}`
          );
          payloads.push(payload);
          assert.equal(database.inTransaction, true);
          assert.equal(
            database.prepare(`
              SELECT status
              FROM free_agent_drafts
              WHERE id = ?
            `).get(payload.updated.id).status,
            payload.updated.status
          );
        },
        beforeCommit(operation, draft) {
          if (
            operation !== "advanceStatus" ||
            draft.status !== "completed"
          ) {
            return;
          }
          events.push(`commit:${draft.status}`);
          assert.equal(
            fixture.database.inTransaction,
            true
          );
          assert.equal(
            fixture.database.prepare(`
              SELECT status
              FROM free_agent_drafts
              WHERE id = ?
            `).get(draft.id).status,
            draft.status
          );
        },
      });
    events.length = 0;
    payloads.length = 0;

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus({
          ...fixture.completionCommand,
          expectedVersion:
            fixture.completionCommand
              .expectedVersion + 1,
        }),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(events, []);
    assert.deepEqual(payloads, []);

    const completed =
      fixture.repository.advanceStatus(
        fixture.completionCommand
      );
    assert.deepEqual(events, [
      "before:completed",
      "after:completed",
      "commit:completed",
    ]);
    assert.equal(payloads.length, 1);
    assert.deepEqual(
      Object.keys(payloads[0]),
      ["effectiveCommand", "existing", "updated"]
    );
    assert.equal(
      payloads[0].effectiveCommand.toStatus,
      "completed"
    );
    assert.equal(
      payloads[0].effectiveCommand.scheduleRecoveryId,
      fixture.plan.recovery.id
    );
    assert.equal(
      payloads[0].effectiveCommand.jobExecution,
      null
    );
    assert.deepEqual(
      payloads[0].existing,
      fixture.rapid.draft
    );
    assert.deepEqual(
      payloads[0].updated,
      completed.draft
    );

    events.length = 0;
    payloads.length = 0;
    const replay =
      fixture.repository.advanceStatus(
        fixture.completionCommand
      );
    assert.equal(replay.replayed, true);
    assert.deepEqual(events, []);
    assert.deepEqual(payloads, []);
  });

  test("normalizes and shares one exact live claimed-job witness across transition hooks", (t) => {
    const observed = [];
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        beforeTransition(_database, command) {
          if (command.toStatus === "completed") {
            observed.push({
              phase: "before",
              witness: command.jobExecution,
            });
          }
        },
        afterTransition(_database, payload) {
          if (
            payload.effectiveCommand.toStatus ===
            "completed"
          ) {
            observed.push({
              phase: "after",
              witness:
                payload.effectiveCommand
                  .jobExecution,
            });
          }
        },
      });
    const witness = transitionJobExecution({
      scheduledForMs:
        CANDIDATE_DEADLINE_AT_MS,
      startedAtMs:
        CANDIDATE_DEADLINE_AT_MS + 1,
      leaseExpiresAtMs:
        WEEK_ONE_AT_MS +
        FREE_AGENT_DRAFT_DAY_MS,
      attemptCount: 3,
      expectedVersion: 7,
    });
    const command = Object.freeze({
      ...fixture.completionCommand,
      jobExecution: witness,
    });

    fixture.repository.advanceStatus(command);

    assert.deepEqual(
      observed.map(({ phase }) => phase),
      ["before", "after"]
    );
    assert.deepEqual(observed[0].witness, witness);
    assert.equal(
      observed[0].witness,
      observed[1].witness
    );
    assert.ok(Object.isFrozen(observed[0].witness));
  });

  test("rejects malformed or stale transition job witnesses before writing", (t) => {
    const fixture =
      createRealCompletionRecoveryFixture(t);
    const before = realRecoverySnapshot(
      fixture.database
    );
    const witness = transitionJobExecution();
    const malformedWitnesses = [
      null,
      { ...witness, unexpected: true },
      { ...witness, runId: "not-a-run-id" },
      {
        ...witness,
        startedAtMs:
          witness.scheduledForMs - 1,
      },
      {
        ...witness,
        startedAtMs:
          fixture.completionCommand
            .occurredAtMs + 1,
      },
      {
        ...witness,
        leaseExpiresAtMs:
          fixture.completionCommand
            .occurredAtMs,
      },
      { ...witness, attemptCount: 0 },
      { ...witness, expectedVersion: 0 },
    ];

    for (const jobExecution of malformedWitnesses) {
      assertRepositoryError(
        () =>
          fixture.repository.advanceStatus({
            ...fixture.completionCommand,
            jobExecution,
          }),
        REPOSITORY_ERROR_CODES.argumentInvalid
      );
    }
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(fixture.database.inTransaction, false);
  });

  test("rejects an asynchronous post-transition writer and rolls the full transition back", (t) => {
    let completedHookCalls = 0;
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        afterTransition(_database, payload) {
          if (
            payload.effectiveCommand.toStatus ===
            "completed"
          ) {
            completedHookCalls += 1;
            return Promise.resolve();
          }
          return undefined;
        },
      });
    const before = realRecoverySnapshot(
      fixture.database
    );

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus(
          fixture.completionCommand
        ),
      REPOSITORY_ERROR_CODES.transactionAsync
    );
    assert.equal(completedHookCalls, 1);
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(
      fixture.repository.findDraft({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: fixture.opened.draft.id,
      }).draft.status,
      "rapid"
    );
    assert.equal(fixture.database.inTransaction, false);
  });

  test("rolls root and post-transition writes back together when the post-transition writer fails", (t) => {
    let completedHookCalls = 0;
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        afterTransition(database, payload) {
          if (
            payload.effectiveCommand.toStatus !==
            "completed"
          ) {
            return;
          }
          completedHookCalls += 1;
          assert.equal(
            database.prepare(`
              UPDATE leagues
              SET name = 'Temporary hook name',
                  name_normalized = 'temporary hook name',
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `).run(
              payload.effectiveCommand.occurredAtMs,
              IDS.league
            ).changes,
            1
          );
          throw new Error(
            "forced post-transition writer failure"
          );
        },
      });
    const before = realRecoverySnapshot(
      fixture.database
    );
    const leagueBefore =
      fixture.database.prepare(`
        SELECT name, name_normalized, version
        FROM leagues
        WHERE id = ?
      `).get(IDS.league);

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus(
          fixture.completionCommand
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.equal(completedHookCalls, 1);
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT name, name_normalized, version
        FROM leagues
        WHERE id = ?
      `).get(IDS.league),
      leagueBefore
    );
    assert.equal(fixture.database.inTransaction, false);
  });

  test("atomically completes a rapid FAD without an optional post-transition hook while moving only current competition Week 1", (t) => {
    const fixture =
      createRealCompletionRecoveryFixture(t);
    const before = fixture.opened.draft;
    const completed = fixture.repository.advanceStatus(
      fixture.completionCommand
    );

    assert.equal(completed.replayed, false);
    assert.equal(completed.draft.status, "completed");
    assert.equal(
      completed.draft.firstMatchupWeekId,
      before.firstMatchupWeekId
    );
    assert.equal(
      completed.draft.firstMatchupStartsAtMs,
      before.firstMatchupStartsAtMs
    );
    assert.equal(
      completed.draft
        .currentCompetitionFirstMatchupWeekId,
      fixture.plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(
      completed.draft.scheduleRecoveryId,
      fixture.plan.recovery.id
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT free_agent_draft_completed_at_ms
        FROM seasons
        WHERE league_id = ? AND id = ?
      `).get(IDS.league, IDS.season)
        .free_agent_draft_completed_at_ms,
      fixture.completionCommand.occurredAtMs
    );
    assert.deepEqual(fixture.calls, [
      "deadline_locked",
      "rapid",
      "completed",
    ]);
    assert.deepEqual(
      fixture.database.pragma("foreign_key_check"),
      []
    );

    const beforeReplay = realRecoverySnapshot(
      fixture.database
    );
    const replay = fixture.repository.advanceStatus(
      fixture.completionCommand
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(fixture.calls, [
      "deadline_locked",
      "rapid",
      "completed",
    ]);
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      beforeReplay
    );
  });

  test("rejects a stale real completion recovery plan without partial lifecycle or schedule writes", (t) => {
    const fixture =
      createRealCompletionRecoveryFixture(t);
    const stalePlan = structuredClone(fixture.plan);
    stalePlan.generation.expectedCurrent.version = 2;
    stalePlan.generation.superseded.version = 3;
    const before = realRecoverySnapshot(
      fixture.database
    );

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus({
          ...fixture.completionCommand,
          scheduleRecoveryPlan: stalePlan,
        }),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(
      fixture.repository.findDraft({
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: fixture.opened.draft.id,
      }).draft.status,
      "rapid"
    );
  });

  test("rolls a sealed completion recovery and all dependent completion evidence back when the writer fails", (t) => {
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        afterStep(step) {
          if (step === "after_recovery_seal") {
            throw new Error(
              "forced completion recovery writer failure"
            );
          }
        },
      });
    const before = realRecoverySnapshot(
      fixture.database
    );

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus(
          fixture.completionCommand
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(fixture.database.inTransaction, false);
  });

  test("rolls completion recovery and transition evidence back together when the dependent transition fails", (t) => {
    const fixture =
      createRealCompletionRecoveryFixture(t, {
        transitionFailAt: "completed",
      });
    const before = realRecoverySnapshot(
      fixture.database
    );

    assertRepositoryError(
      () =>
        fixture.repository.advanceStatus(
          fixture.completionCommand
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.deepEqual(
      realRecoverySnapshot(fixture.database),
      before
    );
    assert.equal(fixture.database.inTransaction, false);
    assert.deepEqual(fixture.calls, [
      "deadline_locked",
      "rapid",
      "completed",
    ]);
  });

  test("applies completion recovery while rapid, then moves only current competition Week 1 using writer-produced evidence", (t) => {
    const calls = [];
    const transitionCommands = [];
    const { database, repository } = createRuntime(t, {
      scheduleRecoveryWriterFactory(currentDatabase) {
        return createRepositoryRecoveryWriter(
          currentDatabase,
          { calls }
        );
      },
      transitionWriter: {
        beforeTransition(command) {
          transitionCommands.push(command);
        },
      },
    });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const opened = repository.commitOpening(
      openingInput({ claim })
    );
    for (const triggerName of [
      "free_agent_drafts_forward_update",
      "free_agent_drafts_deadline_completeness_update",
      "free_agent_drafts_deadline_allocation_barrier",
      "free_agent_drafts_allocation_start_barrier",
      "free_agent_drafts_allocation_completion_barrier",
      "free_agent_drafts_automatic_award_resources_barrier",
      "free_agent_drafts_auction_completion_barrier",
      "free_agent_drafts_final_completion_barrier",
      "free_agent_drafts_resolution_job_completion_barrier",
      "free_agent_drafts_sync_season_completion",
    ]) {
      database.exec(`DROP TRIGGER ${triggerName}`);
    }
    database.prepare(`
      UPDATE free_agent_drafts
      SET status = 'rapid',
          deadline_locked_at_ms = @deadlineAtMs,
          allocation_completed_at_ms = @allocationAtMs,
          updated_at_ms = @allocationAtMs,
          version = 4
      WHERE id = @fadId
    `).run({
      fadId: opened.draft.id,
      deadlineAtMs: CANDIDATE_DEADLINE_AT_MS,
      allocationAtMs: WEEK_ONE_AT_MS,
    });
    const occurredAtMs = WEEK_ONE_AT_MS + 1;
    const plan = repositoryRecoveryPlan({
      recoveryKind: "completion",
      fadId: opened.draft.id,
      completedAtMs: occurredAtMs,
      base: 3_300,
    });
    const command = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: opened.draft.id,
      expectedVersion: 4,
      fromStatus: "rapid",
      toStatus: "completed",
      occurredAtMs,
      schedule: {
        operationId: IDS.scheduleOne,
        version: 1,
        weekOneMatchupWeekId: IDS.weekOne,
        weekOneStartsAtMs: WEEK_ONE_AT_MS,
      },
      scheduleRecoveryPlan: plan,
    };

    const completed = repository.advanceStatus(command);
    assert.equal(completed.replayed, false);
    assert.deepEqual(calls, [
      "applyAndSeal",
      "sealFromApply",
    ]);
    assert.equal(
      transitionCommands[0].scheduleRecoveryId,
      plan.recovery.id
    );
    assert.equal(
      transitionCommands[0].schedule.weekOneMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(
      completed.draft.firstMatchupWeekId,
      IDS.weekOne
    );
    assert.equal(
      completed.draft
        .currentCompetitionFirstMatchupWeekId,
      plan.recovery.newFirstMatchupWeekId
    );
    assert.equal(
      completed.draft.scheduleRecoveryId,
      plan.recovery.id
    );

    const replay = repository.advanceStatus(command);
    assert.equal(replay.replayed, true);
    assert.deepEqual(calls, [
      "applyAndSeal",
      "sealFromApply",
    ]);
    assert.equal(transitionCommands.length, 1);
  });

  test("rolls staged schedule recovery and opening state back together when sealing fails", (t) => {
    const calls = [];
    const evidence = openingEvidence(3_400);
    const plan = repositoryRecoveryPlan({
      recoveryKind: "pre_open",
      fadId: evidence.fadId,
      completedAtMs: RECOVERY_OPENED_AT_MS,
      base: 3_500,
    });
    const { database, repository } = createRuntime(t, {
      scheduleRecoveryWriterFactory(currentDatabase) {
        return createRepositoryRecoveryWriter(
          currentDatabase,
          { calls, failAt: "seal" }
        );
      },
    });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      evidence,
      openedAtMs: RECOVERY_OPENED_AT_MS,
      scheduleRecoveryPlan: plan,
      claim,
    });

    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.operationFailed
    );
    assert.deepEqual(calls, ["stage", "seal"]);
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
    assert.equal(
      rowCount(
      database,
      "free_agent_draft_schedule_recoveries"
      ),
      0
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_readiness_attempts"
      ),
      0
    );
    assert.deepEqual(
      database.prepare(`
        SELECT schedule_operation_id, schedule_version,
               week_one_matchup_week_id
        FROM season_matchup_schedule_generations
        WHERE league_id = ? AND season_id = ?
          AND status = 'current'
      `).get(IDS.league, IDS.season),
      {
        schedule_operation_id: IDS.scheduleOne,
        schedule_version: 1,
        week_one_matchup_week_id: IDS.weekOne,
      }
    );
    assert.equal(
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey: command.occurrenceKey,
      }).status,
      "running"
    );
  });

  test("rejects stale A-to-B-to-A schedule provenance even when Week 1 returns to the original instant", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const scheduleTwo = uuid(980);
    const scheduleThree = uuid(981);
    installScheduleGeneration(database, {
      operationId: scheduleTwo,
      scheduleVersion: 2,
      weekOneStartsAtMs:
        WEEK_ONE_AT_MS +
        7 * FREE_AGENT_DRAFT_DAY_MS,
      completedAtMs: 6,
    });
    installScheduleGeneration(database, {
      operationId: scheduleThree,
      scheduleVersion: 3,
      weekOneStartsAtMs: WEEK_ONE_AT_MS,
      completedAtMs: 8,
    });

    assertRepositoryError(
      () =>
        repository.commitOpening(
          openingInput({ claim })
        ),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    const pending =
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          openingInput({ claim })
            .occurrenceKey,
      });
    assert.equal(pending.status, "running");
    assert.equal(pending.version, 2);
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );

    const opened =
      repository.commitOpening(
        openingInput({
          claim,
          schedule: {
            operationId: scheduleThree,
            version: 3,
            weekOneMatchupWeekId:
              IDS.weekOne,
            weekOneStartsAtMs:
              WEEK_ONE_AT_MS,
          },
        })
      );
    assert.equal(opened.replayed, false);
    assert.equal(
      opened.readiness
        .matchupScheduleVersionBefore,
      3
    );
    assert.equal(
      opened.readiness
        .matchupScheduleVersionAfter,
      3
    );
  });

  test("rejects cross-scope opening without mutating the owning league", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      claim,
      leagueId: IDS.otherLeague,
      occurrenceKey:
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: IDS.otherLeague,
          seasonId: IDS.season,
          triggerResourceId:
            IDS.season,
        }),
    });
    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.recordNotFound
    );
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
    const owning =
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          buildFreeAgentDraftReadinessOccurrenceKey({
            leagueId: IDS.league,
            seasonId: IDS.season,
            triggerResourceId:
              IDS.season,
          }),
      });
    assert.equal(owning.status, "running");
  });

  test("rolls opening back when the accepted assignment ID changes but its manager identity does not", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });
    database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended',
          ended_at_ms = ?,
          version = 2
      WHERE id = ?
    `).run(OPENED_AT_MS + 1, IDS.assignment);
    database.prepare(`
      INSERT INTO team_manager_assignments (
        id,
        league_id,
        team_id,
        user_id,
        membership_id,
        assigned_by_user_id,
        replaces_assignment_id,
        status,
        assigned_at_ms,
        accepted_at_ms,
        ended_at_ms,
        version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, 'accepted',
        ?, ?, NULL, 1
      )
    `).run(
      uuid(2_050),
      IDS.league,
      IDS.team,
      IDS.user,
      IDS.membership,
      IDS.user,
      IDS.assignment,
      OPENED_AT_MS + 1,
      OPENED_AT_MS + 1
    );

    assertRepositoryError(
      () => repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    assertOpeningRolledBack(
      database,
      repository,
      command.occurrenceKey
    );
  });

  test("rolls opening back when the Candidate Card writer reports false carryover evidence", (t) => {
    const { database, repository } =
      createRuntime(t, {
        misreportCarryoverProjection: true,
      });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });

    assertRepositoryError(
      () => repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertOpeningRolledBack(
      database,
      repository,
      command.occurrenceKey
    );
  });

  test("rolls opening back when the Candidate Card writer reports false card or revision evidence", (t) => {
    for (const misreportCardResult of [
      "version",
      "openingRevisionId",
    ]) {
      const { database, repository } =
        createRuntime(t, {
          misreportCardResult,
        });
      repository.ensureReadinessOperation(
        readinessInput()
      );
      const claim = claimReadinessJob(database);
      const command = openingInput({ claim });

      assertRepositoryError(
        () => repository.commitOpening(command),
        REPOSITORY_ERROR_CODES.schemaIncompatible
      );
      assertOpeningRolledBack(
        database,
        repository,
        command.occurrenceKey
      );
    }
  });

  test("rolls opening back on carryover placement drift even when public counts match", (t) => {
    const { database, repository } =
      createRuntime(t, {
        persistPlacementState: "conflict",
      });
    const carryover = seedActiveCarryover(
      database,
      2_060
    );
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      claim,
      carryoverProjection:
        activeCarryoverProjection(carryover),
    });

    assertRepositoryError(
      () => repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertOpeningRolledBack(
      database,
      repository,
      command.occurrenceKey
    );
  });

  test("rolls opening back when persisted card counts drift from the exact carryover projection", (t) => {
    const { database, repository } =
      createRuntime(t, {
        persistCardAsEmpty: true,
      });
    const carryover = seedActiveCarryover(
      database,
      2_070
    );
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      claim,
      carryoverProjection:
        activeCarryoverProjection(carryover),
    });

    assertRepositoryError(
      () => repository.commitOpening(command),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertOpeningRolledBack(
      database,
      repository,
      command.occurrenceKey
    );
  });

  test("fails closed and rolls back when Candidate Card composition is incomplete", (t) => {
    const { database, repository } =
      createRuntime(t, {
        omitCards: true,
      });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });
    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.equal(
      rowCount(database, "free_agent_drafts"),
      0
    );
    assert.equal(
      rowCount(
        database,
        "free_agent_draft_teams"
      ),
      0
    );
    assert.equal(
      rowCount(database, "candidate_cards"),
      0
    );
    assert.equal(
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          command.occurrenceKey,
      }).status,
      "running"
    );
  });

  test("fails closed and rolls back when a Candidate Card opening revision is missing", (t) => {
    const { database, repository } =
      createRuntime(t, {
        omitRevisions: true,
      });
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({ claim });

    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    for (const tableName of [
      "free_agent_drafts",
      "free_agent_draft_teams",
      "candidate_cards",
      "candidate_card_entries",
      "candidate_card_revisions",
      "league_activity",
      "notifications",
      "outbox_events",
      "free_agent_draft_readiness_attempts",
    ]) {
      assert.equal(
        rowCount(database, tableName),
        0,
        tableName
      );
    }
    assert.equal(
      rowCount(database, "job_runs"),
      1
    );
    assert.equal(
      repository.findReadinessByOccurrence({
        leagueId: IDS.league,
        seasonId: IDS.season,
        occurrenceKey:
          command.occurrenceKey,
      }).status,
      "running"
    );
  });

  test("fails closed and rolls back when an authoritative carryover entry is missing", (t) => {
    const { database, repository } =
      createRuntime(t, {
        omitCarryovers: true,
      });
    const carryover = seedActiveCarryover(
      database,
      2_100
    );
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      claim,
      carryoverProjection:
        activeCarryoverProjection(carryover),
    });

    assertRepositoryError(
      () =>
        repository.commitOpening(
          command
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM player_ownerships
          WHERE id = ?
        `)
        .get(carryover.ownershipId).count,
      1
    );
    for (const tableName of [
      "free_agent_drafts",
      "free_agent_draft_teams",
      "candidate_cards",
      "candidate_card_entries",
      "candidate_card_revisions",
      "league_activity",
      "notifications",
      "outbox_events",
      "free_agent_draft_readiness_attempts",
    ]) {
      assert.equal(
        rowCount(database, tableName),
        0,
        tableName
      );
    }
    assert.equal(
      rowCount(database, "job_runs"),
      1
    );
  });

  test("composes the real opening writer atomically and replays durable cards, carryovers, and opening revisions", (t) => {
    const { database, repository } =
      createRuntime(t, {
        useRealCandidateCardWriter: true,
      });
    const carryover = seedActiveCarryover(
      database,
      2_200
    );
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const command = openingInput({
      claim,
      carryoverProjection:
        activeCarryoverProjection(carryover),
    });

    const opened =
      repository.commitOpening(command);
    assert.equal(opened.replayed, false);
    assert.equal(opened.cards.length, 1);
    assert.equal(
      opened.cards[0].id,
      command.evidence.participants[0].cardId
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT
            entry_kind,
            carryover_ownership_id,
            carryover_contract_id,
            player_id
          FROM candidate_card_entries
        `)
        .get(),
      {
        entry_kind: "carryover",
        carryover_ownership_id:
          carryover.ownershipId,
        carryover_contract_id:
          carryover.contractId,
        player_id: carryover.playerId,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT
            card_id,
            team_id,
            resulting_card_version,
            action,
            actor_authority,
            version
          FROM candidate_card_revisions
        `)
        .get(),
      {
        card_id:
          command.evidence.participants[0]
            .cardId,
        team_id: IDS.team,
        resulting_card_version: 1,
        action: "card_opened",
        actor_authority: "system",
        version: 1,
      }
    );

    const replay =
      repository.commitOpening(command);
    assert.equal(replay.replayed, true);
    assert.equal(
      replay.draft.id,
      opened.draft.id
    );
    assert.equal(
      rowCount(database, "candidate_cards"),
      1
    );
    assert.equal(
      rowCount(
        database,
        "candidate_card_entries"
      ),
      1
    );
    assert.equal(
      rowCount(
        database,
        "candidate_card_revisions"
      ),
      1
    );
  });

  test("keeps the root cards-open when deadline-dependent snapshot evidence is absent", (t) => {
    const { database, repository } =
      createRuntime(t);
    repository.ensureReadinessOperation(
      readinessInput()
    );
    const claim = claimReadinessJob(database);
    const opened =
      repository.commitOpening(
        openingInput({ claim })
      );
    assertRepositoryError(
      () =>
        repository.advanceStatus({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: opened.draft.id,
          expectedVersion:
            opened.draft.version,
          fromStatus: "cards_open",
          toStatus: "deadline_locked",
          occurredAtMs:
            CANDIDATE_DEADLINE_AT_MS,
          schedule: {
            operationId: IDS.scheduleOne,
            version: 1,
            weekOneMatchupWeekId:
              IDS.weekOne,
            weekOneStartsAtMs:
              WEEK_ONE_AT_MS,
          },
          scheduleRecoveryPlan: null,
        }),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    const noOpComposed =
      createSqliteFreeAgentDraftRepository({
        database,
        notificationWriter:
          createSqliteNotificationWriter({
            database,
          }),
        candidateCardWriter:
          createCandidateCardWriter(database),
        transitionWriter: {
          beforeTransition() {},
        },
      });
    assertRepositoryError(
      () =>
        noOpComposed.advanceStatus({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId: opened.draft.id,
          expectedVersion:
            opened.draft.version,
          fromStatus: "cards_open",
          toStatus: "deadline_locked",
          occurredAtMs:
            CANDIDATE_DEADLINE_AT_MS,
          schedule: {
            operationId: IDS.scheduleOne,
            version: 1,
            weekOneMatchupWeekId:
              IDS.weekOne,
            weekOneStartsAtMs:
              WEEK_ONE_AT_MS,
          },
          scheduleRecoveryPlan: null,
        }),
      REPOSITORY_ERROR_CODES.versionConflict
    );
    const durable = repository.findDraft({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: opened.draft.id,
    });
    assert.equal(
      durable.draft.status,
      "cards_open"
    );
    assert.equal(
      durable.draft.version,
      opened.draft.version
    );
    assert.equal(
      durable.draft.deadlineLockedAtMs,
      null
    );
  });
});
