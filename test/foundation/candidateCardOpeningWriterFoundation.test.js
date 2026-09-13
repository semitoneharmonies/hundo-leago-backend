const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

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
  createSqliteCandidateCardOpeningWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardOpeningWriter"
);
const {
  createSqliteCandidateCardRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardRepository"
);
const {
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);
const {
  projectFreeAgentDraftCarryovers,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const CANDIDATE_DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - 7 * DAY_MS;
const OPENED_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 14 * DAY_MS;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 2 * DAY_MS;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function insert(database, tableName, record) {
  const columns = Object.keys(record);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map(() => "?").join(", ")}
      )
    `)
    .run(...columns.map((column) => record[column]));
}

function rowCount(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    )
    .get().count;
}

function seedUser(database, id, label) {
  insert(database, "users", {
    id,
    email_normalized:
      `${label.toLowerCase()}@example.test`,
    email_display:
      `${label.toLowerCase()}@example.test`,
    display_name: label,
    display_name_normalized:
      label.toLowerCase(),
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedLeagueState(
  database,
  {
    teamCount,
    salaryCapCents,
  }
) {
  const ids = {
    league: uuid(1),
    season: uuid(2),
    futureSeasonTwo: uuid(80),
    futureSeasonThree: uuid(81),
    weekOne: uuid(3),
    readiness: uuid(4),
    fad: uuid(5),
    readinessJob: uuid(6),
    teams: [],
  };
  insert(database, "leagues", {
    id: ids.league,
    name: "Candidate Opening League",
    name_normalized:
      "candidate opening league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_settings", {
    league_id: ids.league,
    salary_cap_cents: salaryCapCents,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms:
      WEEK_ONE_AT_MS,
    regular_season_ends_at_ms:
      WEEK_ONE_AT_MS + 24 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 20 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 24 * 7 * DAY_MS,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  for (const future of [
    {
      id: ids.futureSeasonTwo,
      label: "2027-28",
      nhlSeasonKey: "20272028",
    },
    {
      id: ids.futureSeasonThree,
      label: "2028-29",
      nhlSeasonKey: "20282029",
    },
  ]) {
    insert(database, "seasons", {
      id: future.id,
      league_id: ids.league,
      label: future.label,
      nhl_season_key: future.nhlSeasonKey,
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
      free_agent_draft_completed_at_ms: null,
    });
  }

  for (
    let index = 0;
    index < teamCount;
    index += 1
  ) {
    const team = {
      id: uuid(100 + index),
      userId: uuid(200 + index),
      membershipId: uuid(300 + index),
      assignmentId: uuid(400 + index),
      participantId: uuid(500 + index),
      cardId: uuid(600 + index),
      notificationId: uuid(700 + index),
    };
    ids.teams.push(team);
    seedUser(
      database,
      team.userId,
      `Manager ${index + 1}`
    );
    insert(database, "league_memberships", {
      id: team.membershipId,
      league_id: ids.league,
      user_id: team.userId,
      permission_category:
        index === 0
          ? "commissioner"
          : "manager",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "teams", {
      id: team.id,
      league_id: ids.league,
      name: `Opening Team ${index + 1}`,
      name_normalized:
        `opening team ${index + 1}`,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(
      database,
      "team_manager_assignments",
      {
        id: team.assignmentId,
        league_id: ids.league,
        team_id: team.id,
        user_id: team.userId,
        membership_id: team.membershipId,
        assigned_by_user_id:
          ids.teams[0].userId,
        replaces_assignment_id: null,
        status: "accepted",
        assigned_at_ms: 1,
        accepted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      }
    );
  }

  database
    .prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 2,
          version = 2
      WHERE id = ?
    `)
    .run(
      ids.teams[0].membershipId,
      ids.season,
      ids.league
    );
  insert(database, "matchup_weeks", {
    id: ids.weekOne,
    league_id: ids.league,
    season_id: ids.season,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms:
      WEEK_ONE_AT_MS + 60 * 60 * 1000,
    locks_at_ms:
      WEEK_ONE_AT_MS + 2 * 60 * 60 * 1000,
    ends_at_ms:
      WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms:
      WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 2,
    updated_at_ms: 2,
    version: 1,
  });
  const occurrenceKey =
    `fad-readiness:${ids.league}:${ids.season}:inaugural`;
  insert(database, "job_runs", {
    id: ids.readinessJob,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "fad_readiness",
    occurrence_key: occurrenceKey,
    scheduled_for_ms: OPENED_AT_MS - 1,
    status: "running",
    attempt_count: 1,
    lease_owner: "candidate-opening-worker",
    lease_expires_at_ms:
      OPENED_AT_MS + DAY_MS,
    started_at_ms: OPENED_AT_MS,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS - 1,
    updated_at_ms: OPENED_AT_MS,
    version: 2,
    lease_token: "candidate-opening-lease",
    next_attempt_at_ms: null,
  });
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
      id: ids.readiness,
      league_id: ids.league,
      season_id: ids.season,
      readiness_occurrence_key: occurrenceKey,
      trigger_kind: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      job_run_id: ids.readinessJob,
      status: "running",
      attempt_count: 1,
      lease_owner: "candidate-opening-worker",
      lease_token: "candidate-opening-lease",
      lease_expires_at_ms:
        OPENED_AT_MS + DAY_MS,
      blockers_json: "[]",
      matchup_schedule_version_before: null,
      matchup_schedule_version_after: null,
      schedule_recovery_id: null,
      created_fad_id: null,
      reminder_job_run_id: null,
      deadline_job_run_id: null,
      cards_opened_activity_id: null,
      cards_opened_outbox_event_id: null,
      started_at_ms: OPENED_AT_MS,
      next_retry_at_ms: null,
      terminal_at_ms: null,
      created_at_ms: OPENED_AT_MS - 1,
      updated_at_ms: OPENED_AT_MS,
      version: 2,
    }
  );
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: occurrenceKey,
    first_matchup_week_id: ids.weekOne,
    current_competition_first_matchup_week_id:
      ids.weekOne,
    schedule_recovery_id: null,
    participating_team_count: teamCount,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural league season.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms:
      CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms:
      WEEK_ONE_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  for (const team of ids.teams) {
    insert(database, "free_agent_draft_teams", {
      id: team.participantId,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      team_id: team.id,
      team_status_at_setup: "active",
      created_at_ms: OPENED_AT_MS,
    });
  }
  return ids;
}

function openingCommand(ids) {
  return {
    leagueId: ids.league,
    seasonId: ids.season,
    fadId: ids.fad,
    openedAtMs: OPENED_AT_MS,
    candidateDeadlineAtMs:
      CANDIDATE_DEADLINE_AT_MS,
    carryoverProjection: null,
    participants: ids.teams.map((team) => ({
      teamId: team.id,
      participantId: team.participantId,
      cardId: team.cardId,
      notificationId: team.notificationId,
      managerAssignmentId:
        team.assignmentId,
      managerUserId: team.userId,
      managerMembershipId:
        team.membershipId,
    })),
  };
}

function createRuntime(
  t,
  {
    teamCount = 1,
    salaryCapCents = 10_000,
    beforeCommit,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-candidate-opening-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      root,
      "league.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory:
      MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "candidate-card-opening-foundation",
    now: () => 1,
  });
  const ids = seedLeagueState(
    connection.database,
    { teamCount, salaryCapCents }
  );
  const rawWriter =
    createSqliteCandidateCardOpeningWriter({
      database: connection.database,
      beforeCommit,
    });
  const writer = Object.freeze({
    openAll(command) {
      return rawWriter.openAll({
        ...command,
        carryoverProjection:
          command.carryoverProjection ??
          currentCarryoverProjection(
            connection.database,
            ids
          ),
      });
    },
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
    ids,
    writer,
    rawWriter,
    command: openingCommand(ids),
  };
}

function seedCarryover(
  database,
  ids,
  {
    base,
    teamId = ids.teams[0].id,
    rosterCategory,
    positionGroup,
    slotNumber,
    contractType = "normal",
    aavCents = 100,
    originalTotalValueCents =
      contractType === "fantasy_elc"
        ? 300
        : aavCents,
    originalTermYears =
      contractType === "fantasy_elc"
        ? 3
        : 1,
    includeCurrentYear = true,
  }
) {
  const record = {
    playerId: uuid(base),
    ownershipId: uuid(base + 1),
    contractId: uuid(base + 2),
    currentYearId: uuid(base + 3),
    futureYearIds: [
      uuid(base + 4),
      uuid(base + 5),
    ],
  };
  insert(database, "players", {
    id: record.playerId,
    first_name: `Player ${base}`,
    last_name: positionGroup,
    full_name: `Player ${base} ${positionGroup}`,
    birth_date: null,
    status: "active",
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: uuid(base + 10),
    player_id: record.playerId,
    provider: "sportsdataio",
    source_position: positionGroup,
    normalized_position: positionGroup,
    nhl_team_abbreviation: null,
    active: 1,
    source_version: `fixture-${base}`,
    source_payload_json: null,
    effective_at_ms: 3,
    ended_at_ms: null,
    created_at_ms: 3,
  });
  insert(database, "contracts", {
    id: record.contractId,
    league_id: ids.league,
    player_id: record.playerId,
    current_team_id: teamId,
    contract_type: contractType,
    original_total_value_cents:
      originalTotalValueCents,
    original_term_years: originalTermYears,
    aav_cents: aavCents,
    start_season_id: ids.season,
    status: "active",
    acquisition_source_type:
      "season_rollover",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
  });
  if (includeCurrentYear) {
    insert(database, "contract_years", {
      id: record.currentYearId,
      league_id: ids.league,
      contract_id: record.contractId,
      season_id: ids.season,
      year_number: 1,
      aav_cents: aavCents,
      status: "current",
      rollover_at_ms: null,
      created_at_ms: 3,
    });
  }
  for (
    let yearNumber = 2;
    yearNumber <= originalTermYears;
    yearNumber += 1
  ) {
    insert(database, "contract_years", {
      id: record.futureYearIds[yearNumber - 2],
      league_id: ids.league,
      contract_id: record.contractId,
      season_id:
        yearNumber === 2
          ? ids.futureSeasonTwo
          : ids.futureSeasonThree,
      year_number: yearNumber,
      aav_cents: aavCents,
      status: "future",
      rollover_at_ms: null,
      created_at_ms: 3,
    });
  }
  insert(database, "player_ownerships", {
    id: record.ownershipId,
    league_id: ids.league,
    season_id: ids.season,
    player_id: record.playerId,
    team_id: teamId,
    ownership_kind: "Rostered",
    roster_category: rosterCategory,
    position_group: positionGroup,
    slot_number: slotNumber,
    acquired_transaction_type:
      "season_rollover",
    acquired_transaction_id: null,
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
    trade_blocked: 0,
  });
  return record;
}

function assertRepositoryError(
  callback,
  code,
  reasonCode
) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(
        error.details?.reasonCode,
        reasonCode
      );
    }
    return true;
  });
}

function currentCarryoverProjection(database, ids) {
  const context =
    createSqliteFreeAgentDraftReadRepository({
      database,
    }).readOpeningPreflightContext({
      leagueId: ids.league,
      seasonId: ids.season,
    });
  return projectFreeAgentDraftCarryovers({
    seasonId: ids.season,
    participatingTeams: context.participatingTeams,
    leagueSettings: context.leagueSettings,
    ownerships: context.ownerships,
    activeContracts: context.activeContracts,
    targetContractYears:
      context.targetContractYears,
    allContractYears: context.allContractYears,
    leaguePositionOverrides:
      context.leaguePositionOverrides,
    currentPlayerSources:
      context.currentPlayerSources,
  });
}

describe(
  "SQLite Candidate Card opening writer",
  () => {
    test("opens every empty inaugural card with a deterministic 22-slot revision and no unrelated writes", (t) => {
      const {
        database,
        ids,
        writer,
        rawWriter,
        command,
      } = createRuntime(t, {
        teamCount: 2,
      });

      assertRepositoryError(
        () => rawWriter.openAll(command),
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "CARRYOVER_PROJECTION_INVALID"
      );

      const result = writer.openAll(command);

      assert.equal(result.replayed, false);
      assert.equal(result.cards.length, 2);
      assert.equal(
        result.carryoverProjection.teams.length,
        2
      );
      assert.equal(
        typeof result.then,
        "undefined"
      );
      const cards = database
        .prepare(`
          SELECT *
          FROM candidate_cards
          ORDER BY team_id
        `)
        .all();
      assert.equal(cards.length, 2);
      for (const card of cards) {
        assert.equal(card.status, "open");
        assert.equal(
          card.completeness_code,
          "incomplete"
        );
        assert.equal(
          card.filled_mandatory_count,
          0
        );
        assert.equal(
          card.missing_mandatory_count,
          18
        );
        assert.equal(card.filled_bench_count, 0);
        assert.equal(card.empty_bench_count, 4);
        assert.equal(
          card.structural_conflict_count,
          0
        );
        assert.equal(
          card
            .carried_roster_structural_conflict_count,
          0
        );
        assert.equal(
          card.maximum_possible_cap_cents,
          0
        );
        assert.equal(card.version, 1);
      }
      assert.equal(
        rowCount(
          database,
          "candidate_card_entries"
        ),
        0
      );
      const revisions = database
        .prepare(`
          SELECT *
          FROM candidate_card_revisions
          ORDER BY card_id
        `)
        .all();
      assert.equal(revisions.length, 2);
      for (const revision of revisions) {
        assert.equal(
          revision.action,
          "card_opened"
        );
        assert.equal(
          revision.resulting_card_version,
          1
        );
        const evidence = JSON.parse(
          revision.after_evidence_json
        );
        assert.equal(evidence.slots.length, 22);
        assert.deepEqual(
          evidence.slots.map(
            ({ slotKey }) => slotKey
          ),
          [
            ...Array.from(
              { length: 12 },
              (_, index) =>
                `F${String(index + 1).padStart(2, "0")}`
            ),
            ...Array.from(
              { length: 6 },
              (_, index) =>
                `D${String(index + 1).padStart(2, "0")}`
            ),
            ...Array.from(
              { length: 4 },
              (_, index) =>
                `B${String(index + 1).padStart(2, "0")}`
            ),
          ]
        );
        assert.ok(
          evidence.slots.every(
            ({ occupantEntryId }) =>
              occupantEntryId === null
          )
        );
      }
      assert.equal(
        rowCount(database, "league_activity"),
        0
      );
      assert.equal(
        rowCount(database, "notifications"),
        0
      );
      assert.equal(
        rowCount(database, "outbox_events"),
        0
      );
    });

    test("materializes normal and fantasy-ELC Active, Bench, and IR carryovers with derived cap state", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t, {
        salaryCapCents: 500,
      });
      const activeForward = seedCarryover(
        database,
        ids,
        {
          base: 1_000,
          rosterCategory: "Active",
          positionGroup: "F",
          slotNumber: 3,
          contractType: "normal",
          aavCents: 500,
        }
      );
      const activeDefence = seedCarryover(
        database,
        ids,
        {
          base: 1_010,
          rosterCategory: "Active",
          positionGroup: "D",
          slotNumber: 2,
          contractType: "fantasy_elc",
          aavCents: 100,
        }
      );
      const bench = seedCarryover(
        database,
        ids,
        {
          base: 1_020,
          rosterCategory: "Bench",
          positionGroup: "D",
          slotNumber: 2,
          contractType: "fantasy_elc",
          aavCents: 100,
        }
      );
      const injuredReserve = seedCarryover(
        database,
        ids,
        {
          base: 1_030,
          rosterCategory:
            "Injured Reserve",
          positionGroup: "F",
          slotNumber: 4,
          contractType: "normal",
          aavCents: 900,
        }
      );

      writer.openAll(command);

      const card = database
        .prepare(`
          SELECT * FROM candidate_cards
        `)
        .get();
      assert.equal(card.filled_mandatory_count, 3);
      assert.equal(card.missing_mandatory_count, 15);
      assert.equal(card.filled_bench_count, 1);
      assert.equal(card.empty_bench_count, 3);
      assert.equal(
        card.maximum_possible_cap_cents,
        600
      );
      assert.equal(card.cap_status, "over_cap");
      assert.equal(
        card.allocation_eligibility,
        "excluded_over_cap"
      );
      assert.equal(
        card.allocation_exclusion_reason,
        "candidate_card_over_cap"
      );
      assert.equal(
        card
          .carried_roster_structural_conflict_count,
        0
      );
      const entries = database
        .prepare(`
          SELECT *
          FROM candidate_card_entries
          ORDER BY carryover_ownership_id
        `)
        .all();
      assert.equal(entries.length, 4);
      const byOwnership = new Map(
        entries.map((entry) => [
          entry.carryover_ownership_id,
          entry,
        ])
      );
      assert.deepEqual(
        [
          byOwnership.get(
            activeForward.ownershipId
          ).requested_slot_group,
          byOwnership.get(
            activeForward.ownershipId
          ).requested_slot_number,
        ],
        ["F", 3]
      );
      assert.deepEqual(
        [
          byOwnership.get(
            activeDefence.ownershipId
          ).requested_slot_group,
          byOwnership.get(
            activeDefence.ownershipId
          ).requested_slot_number,
        ],
        ["D", 2]
      );
      assert.deepEqual(
        {
          total:
            byOwnership.get(
              activeDefence.ownershipId
            )
              .carryover_original_total_value_cents,
          term:
            byOwnership.get(
              activeDefence.ownershipId
            ).carryover_original_term_years,
          aav:
            byOwnership.get(
              activeDefence.ownershipId
            ).carryover_aav_cents,
          remaining:
            byOwnership.get(
              activeDefence.ownershipId
            ).remaining_years,
        },
        {
          total: 300,
          term: 3,
          aav: 100,
          remaining: 3,
        }
      );
      assert.deepEqual(
        [
          byOwnership.get(bench.ownershipId)
            .requested_slot_group,
          byOwnership.get(bench.ownershipId)
            .requested_slot_number,
        ],
        ["B", 2]
      );
      const irEntry = byOwnership.get(
        injuredReserve.ownershipId
      );
      assert.deepEqual(
        [
          irEntry.source_roster_category,
          irEntry.requested_slot_group,
          irEntry.requested_slot_number,
          irEntry.placement_state,
        ],
        ["Injured Reserve", "F", 1, "placed"]
      );
      assert.deepEqual(
        database
          .prepare(`
            SELECT roster_category, slot_number
            FROM player_ownerships
            WHERE id = ?
          `)
          .get(injuredReserve.ownershipId),
        {
          roster_category: "Injured Reserve",
          slot_number: 4,
        }
      );
    });

    test("uses ownership-ID order for the final IR projection and preserves every unplaced obligation as a conflict", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t);
      for (let slot = 1; slot <= 5; slot += 1) {
        seedCarryover(database, ids, {
          base: 2_000 + slot * 10,
          rosterCategory: "Active",
          positionGroup: "D",
          slotNumber: slot,
          aavCents: 100,
        });
      }
      const higherOwnershipIr = seedCarryover(
        database,
        ids,
        {
          base: 2_200,
          rosterCategory:
            "Injured Reserve",
          positionGroup: "D",
          slotNumber: 2,
          aavCents: 100,
        }
      );
      const lowerOwnershipIr = seedCarryover(
        database,
        ids,
        {
          base: 2_100,
          rosterCategory:
            "Injured Reserve",
          positionGroup: "D",
          slotNumber: 1,
          aavCents: 100,
        }
      );
      const ineligibleBench = seedCarryover(
        database,
        ids,
        {
          base: 2_300,
          rosterCategory: "Bench",
          positionGroup: "F",
          slotNumber: 1,
          aavCents: 500,
        }
      );

      writer.openAll(command);

      const entries = database
        .prepare(`
          SELECT *
          FROM candidate_card_entries
        `)
        .all();
      const byOwnership = new Map(
        entries.map((entry) => [
          entry.carryover_ownership_id,
          entry,
        ])
      );
      assert.deepEqual(
        {
          slot:
            byOwnership.get(
              lowerOwnershipIr.ownershipId
            ).requested_slot_number,
          state:
            byOwnership.get(
              lowerOwnershipIr.ownershipId
            ).placement_state,
        },
        { slot: 6, state: "placed" }
      );
      assert.deepEqual(
        {
          slot:
            byOwnership.get(
              higherOwnershipIr.ownershipId
            ).requested_slot_number,
          state:
            byOwnership.get(
              higherOwnershipIr.ownershipId
            ).placement_state,
          code:
            byOwnership.get(
              higherOwnershipIr.ownershipId
            ).conflict_code,
        },
        {
          slot: 1,
          state: "conflict",
          code: "CARRYOVER_SLOT_CONFLICT",
        }
      );
      assert.deepEqual(
        {
          group:
            byOwnership.get(
              ineligibleBench.ownershipId
            ).requested_slot_group,
          slot:
            byOwnership.get(
              ineligibleBench.ownershipId
            ).requested_slot_number,
          state:
            byOwnership.get(
              ineligibleBench.ownershipId
            ).placement_state,
        },
        { group: "B", slot: 1, state: "conflict" }
      );
      const card = database
        .prepare(`SELECT * FROM candidate_cards`)
        .get();
      assert.equal(
        card.completeness_code,
        "conflicted"
      );
      assert.equal(card.filled_mandatory_count, 6);
      assert.equal(
        card.structural_conflict_count,
        2
      );
      assert.equal(
        card
          .carried_roster_structural_conflict_count,
        2
      );
      assert.equal(
        card.allocation_eligibility,
        "excluded_structural_conflict"
      );
      assert.equal(
        card.allocation_exclusion_reason,
        "candidate_card_structural_conflict"
      );
      assert.equal(entries.length, 8);
      const evidence = JSON.parse(
        database
          .prepare(`
            SELECT after_evidence_json
            FROM candidate_card_revisions
          `)
          .get().after_evidence_json
      );
      assert.equal(evidence.conflicts.length, 2);
      assert.equal(
        evidence.card
          .carriedRosterStructuralConflictCount,
        2
      );

      const repository =
        createSqliteCandidateCardRepository({
          database,
          writeMutationSideEffects() {},
          writeHelpGrantSideEffects() {},
        });
      const privateCard = repository.readPrivate({
        scope: {
          leagueId: ids.league,
          seasonId: ids.season,
          fadId: ids.fad,
          cardId: ids.teams[0].cardId,
          teamId: ids.teams[0].id,
        },
        actor: {
          userId: ids.teams[0].userId,
          membershipId:
            ids.teams[0].membershipId,
          authority: "manager",
        },
        nowMs: OPENED_AT_MS,
      });
      const readableConflict =
        privateCard.entries.find(
          (entry) =>
            entry.ownershipId ===
            ineligibleBench.ownershipId
        );
      assert.equal(
        readableConflict.placementState,
        "conflict"
      );
      assert.equal(
        readableConflict.conflictCode,
        "CARRYOVER_SLOT_CONFLICT"
      );
      assert.equal(readableConflict.aavCents, 500);
    });

    test("replays only the exact all-team opening", (t) => {
      const {
        database,
        writer,
        command,
      } = createRuntime(t, {
        teamCount: 2,
      });
      const first = writer.openAll(command);
      const replay = writer.openAll(command);

      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.cards, first.cards);
      assert.equal(
        rowCount(database, "candidate_cards"),
        2
      );
      assert.equal(
        rowCount(
          database,
          "candidate_card_revisions"
        ),
        2
      );

      const changed = {
        ...command,
        participants: command.participants.map(
          (participant, index) =>
            index === 0
              ? {
                  ...participant,
                  notificationId: uuid(9_999),
                }
              : participant
        ),
      };
      assertRepositoryError(
        () => writer.openAll(changed),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CANDIDATE_CARD_OPENING_REPLAY_MISMATCH"
      );
      assert.equal(
        rowCount(database, "candidate_cards"),
        2
      );
    });

    test("rejects cross-scope commands and stale current-manager evidence before opening any card", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t);
      assertRepositoryError(
        () =>
          writer.openAll({
            ...command,
            seasonId: uuid(8_000),
          }),
        REPOSITORY_ERROR_CODES.versionConflict,
        "FAD_SCOPE_INVALID"
      );
      assert.equal(
        rowCount(database, "candidate_cards"),
        0
      );

      const oldManager = ids.teams[0];
      database
        .prepare(`
          UPDATE team_manager_assignments
          SET status = 'ended',
              ended_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          OPENED_AT_MS + 1,
          oldManager.assignmentId
        );
      const replacementUserId = uuid(8_010);
      const replacementMembershipId = uuid(8_011);
      seedUser(
        database,
        replacementUserId,
        "Replacement Manager"
      );
      insert(database, "league_memberships", {
        id: replacementMembershipId,
        league_id: ids.league,
        user_id: replacementUserId,
        permission_category: "manager",
        status: "active",
        joined_at_ms: OPENED_AT_MS + 1,
        ended_at_ms: null,
        created_at_ms: OPENED_AT_MS + 1,
        updated_at_ms: OPENED_AT_MS + 1,
        version: 1,
      });
      insert(
        database,
        "team_manager_assignments",
        {
          id: uuid(8_012),
          league_id: ids.league,
          team_id: oldManager.id,
          user_id: replacementUserId,
          membership_id:
            replacementMembershipId,
          assigned_by_user_id:
            replacementUserId,
          replaces_assignment_id:
            oldManager.assignmentId,
          status: "accepted",
          assigned_at_ms: OPENED_AT_MS + 1,
          accepted_at_ms: OPENED_AT_MS + 1,
          ended_at_ms: null,
          version: 1,
        }
      );
      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "FAD_PARTICIPANT_AUTHORITY_CHANGED"
      );
      assert.equal(
        rowCount(database, "candidate_cards"),
        0
      );
      assert.equal(
        rowCount(
          database,
          "candidate_card_revisions"
        ),
        0
      );
    });

    test("rejects a replacement assignment even when the manager user and membership are unchanged", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t);
      const manager = ids.teams[0];
      database
        .prepare(`
          UPDATE team_manager_assignments
          SET status = 'ended',
              ended_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          OPENED_AT_MS + 1,
          manager.assignmentId
        );
      insert(
        database,
        "team_manager_assignments",
        {
          id: uuid(8_020),
          league_id: ids.league,
          team_id: manager.id,
          user_id: manager.userId,
          membership_id: manager.membershipId,
          assigned_by_user_id: manager.userId,
          replaces_assignment_id:
            manager.assignmentId,
          status: "accepted",
          assigned_at_ms: OPENED_AT_MS + 1,
          accepted_at_ms: OPENED_AT_MS + 1,
          ended_at_ms: null,
          version: 1,
        }
      );

      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "FAD_PARTICIPANT_AUTHORITY_CHANGED"
      );
      assert.equal(
        rowCount(database, "candidate_cards"),
        0
      );
      assert.equal(
        rowCount(
          database,
          "candidate_card_revisions"
        ),
        0
      );
    });

    test("rejects exact carryover placement drift even when every public count is unchanged", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t);
      const carryover = seedCarryover(
        database,
        ids,
        {
          base: 8_100,
          rosterCategory: "Active",
          positionGroup: "F",
          slotNumber: 1,
        }
      );
      const expected = currentCarryoverProjection(
        database,
        ids
      );
      database
        .prepare(`
          UPDATE player_ownerships
          SET slot_number = 2,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          OPENED_AT_MS + 1,
          carryover.ownershipId
        );

      assertRepositoryError(
        () =>
          writer.openAll({
            ...command,
            carryoverProjection: expected,
          }),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CARRYOVER_PROJECTION_CHANGED"
      );
      for (const tableName of [
        "candidate_cards",
        "candidate_card_entries",
        "candidate_card_revisions",
      ]) {
        assert.equal(
          rowCount(database, tableName),
          0,
          tableName
        );
      }
    });

    test("rejects incomplete current contract-year evidence without partial all-team state", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t, {
        teamCount: 2,
      });
      seedCarryover(database, ids, {
        base: 9_000,
        teamId: ids.teams[0].id,
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
      });
      seedCarryover(database, ids, {
        base: 9_100,
        teamId: ids.teams[1].id,
        rosterCategory: "Active",
        positionGroup: "D",
        slotNumber: 1,
        includeCurrentYear: false,
      });

      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CARRYOVER_PROJECTION_BLOCKED"
      );
      assert.equal(
        rowCount(database, "candidate_cards"),
        0
      );
      assert.equal(
        rowCount(
          database,
          "candidate_card_entries"
        ),
        0
      );
    });

    test("rejects a carried normal contract below the approved minimum and rolls back every team", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t, {
        teamCount: 2,
      });
      seedCarryover(database, ids, {
        base: 9_200,
        teamId: ids.teams[0].id,
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
      });
      seedCarryover(database, ids, {
        base: 9_300,
        teamId: ids.teams[1].id,
        rosterCategory: "Active",
        positionGroup: "D",
        slotNumber: 1,
        contractType: "normal",
        aavCents: 50,
      });

      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CARRYOVER_PROJECTION_BLOCKED"
      );
      for (const tableName of [
        "candidate_cards",
        "candidate_card_entries",
        "candidate_card_revisions",
      ]) {
        assert.equal(
          rowCount(database, tableName),
          0,
          tableName
        );
      }
    });

    test("rejects a carried multi-year normal contract without whole-dollar total precision", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t);
      seedCarryover(database, ids, {
        base: 9_350,
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
        contractType: "normal",
        aavCents: 151,
        originalTotalValueCents: 302,
        originalTermYears: 2,
      });

      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CARRYOVER_PROJECTION_BLOCKED"
      );
      for (const tableName of [
        "candidate_cards",
        "candidate_card_entries",
        "candidate_card_revisions",
      ]) {
        assert.equal(
          rowCount(database, tableName),
          0,
          tableName
        );
      }
    });

    test("rejects a carried fantasy ELC that is not the exact three-year ELC and rolls back every team", (t) => {
      const {
        database,
        ids,
        writer,
        command,
      } = createRuntime(t, {
        teamCount: 2,
      });
      seedCarryover(database, ids, {
        base: 9_400,
        teamId: ids.teams[0].id,
        rosterCategory: "Active",
        positionGroup: "F",
        slotNumber: 1,
      });
      seedCarryover(database, ids, {
        base: 9_500,
        teamId: ids.teams[1].id,
        rosterCategory: "Active",
        positionGroup: "D",
        slotNumber: 1,
        contractType: "fantasy_elc",
        aavCents: 200,
        originalTotalValueCents: 600,
        originalTermYears: 3,
      });

      assertRepositoryError(
        () => writer.openAll(command),
        REPOSITORY_ERROR_CODES.versionConflict,
        "CARRYOVER_PROJECTION_BLOCKED"
      );
      for (const tableName of [
        "candidate_cards",
        "candidate_card_entries",
        "candidate_card_revisions",
      ]) {
        assert.equal(
          rowCount(database, tableName),
          0,
          tableName
        );
      }
    });

    test("rolls back every team and opening revision after a late nested-transaction fault", (t) => {
      const runtime = createRuntime(t, {
        teamCount: 2,
        beforeCommit() {
          throw new Error(
            "forced late opening failure"
          );
        },
      });
      seedCarryover(
        runtime.database,
        runtime.ids,
        {
          base: 10_000,
          rosterCategory: "Active",
          positionGroup: "F",
          slotNumber: 1,
        }
      );
      const outer = runtime.database.transaction(
        () => runtime.writer.openAll(runtime.command)
      );

      assertRepositoryError(
        () => outer.immediate(),
        REPOSITORY_ERROR_CODES.operationFailed
      );
      for (const tableName of [
        "candidate_cards",
        "candidate_card_entries",
        "candidate_card_revisions",
      ]) {
        assert.equal(
          rowCount(runtime.database, tableName),
          0
        );
      }

      const healthyWriter =
        createSqliteCandidateCardOpeningWriter({
          database: runtime.database,
        });
      const healthyOuter =
        runtime.database.transaction(() =>
          healthyWriter.openAll({
            ...runtime.command,
            carryoverProjection:
              currentCarryoverProjection(
                runtime.database,
                runtime.ids
              ),
          })
        );
      const result = healthyOuter.immediate();
      assert.equal(result.replayed, false);
      assert.equal(
        rowCount(runtime.database, "candidate_cards"),
        2
      );
      assert.equal(
        rowCount(
          runtime.database,
          "candidate_card_revisions"
        ),
        2
      );
    });
  }
);
