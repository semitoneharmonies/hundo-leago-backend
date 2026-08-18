"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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
  projectFreeAgentDraftCarryovers,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  createFreeAgentDraftReadinessAttemptEvidence,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  hashSeasonRolloverItem,
  hashSeasonRolloverManifest,
  hashSeasonRolloverSourceReadiness,
  serializeCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteCandidateCardOpeningWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardOpeningWriter"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  createSqliteFreeAgentDraftRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository"
);
const {
  FREE_AGENT_DRAFT_READ_REPOSITORY_CODES,
  FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS,
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);
const {
  createSqliteNotificationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter"
);
const {
  STANDINGS_FINALIZATION_OPERATION,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsFinalizationRepository"
);
const {
  createSqliteCommissionerAssignmentRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCommissionerAssignmentRepository"
);
const {
  createSqliteTeamManagerAssignmentRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamManagerAssignmentRepository"
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

function fadDrawCommitment(auctionId, nonce) {
  function frame(value) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }
  return createHash("sha256")
    .update(
      Buffer.concat([
        frame(Buffer.from("hundo-fad-draw-v1", "utf8")),
        frame(Buffer.from(auctionId, "utf8")),
        frame(nonce),
      ])
    )
    .digest("hex");
}

const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const SECONDARY_WEEK_ONE_AT_MS = Date.parse(
  "2026-10-05T06:00:00.000Z"
);
const CANDIDATE_DEADLINE_AT_MS =
  WEEK_ONE_AT_MS - FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
const OPENED_AT_MS =
  CANDIDATE_DEADLINE_AT_MS -
  14 * FREE_AGENT_DRAFT_DAY_MS;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS -
  2 * FREE_AGENT_DRAFT_DAY_MS;
const PREPUBLICATION_NOW_MS =
  HELP_OPENS_AT_MS + 60 * 60 * 1_000;
const PUBLICATION_AT_MS = CANDIDATE_DEADLINE_AT_MS;
const ALLOCATION_AT_MS =
  PUBLICATION_AT_MS + 30 * 60 * 1_000;
const COMPLETION_AT_MS =
  PUBLICATION_AT_MS +
  7 * FREE_AGENT_DRAFT_DAY_MS;
const PLAYOFFS_START_AT_MS = Date.parse(
  "2027-01-18T08:00:00.000Z"
);
const PLAYOFFS_END_AT_MS =
  PLAYOFFS_START_AT_MS +
  28 * FREE_AGENT_DRAFT_DAY_MS;
const SECONDARY_PLAYOFFS_START_AT_MS = Date.parse(
  "2027-01-18T07:00:00.000Z"
);
const SECONDARY_PLAYOFFS_END_AT_MS =
  SECONDARY_PLAYOFFS_START_AT_MS +
  28 * FREE_AGENT_DRAFT_DAY_MS;

const PRIMARY = Object.freeze({
  leagueId: uuid(1),
  seasonId: uuid(2),
  commissionerUserId: uuid(3),
  commissionerMembershipId: uuid(4),
  managerUserId: uuid(5),
  managerMembershipId: uuid(6),
  otherManagerUserId: uuid(7),
  otherManagerMembershipId: uuid(8),
  memberUserId: uuid(9),
  memberMembershipId: uuid(10),
  administratorUserId: uuid(11),
  administratorMembershipId: uuid(12),
  administratorRoleId: uuid(13),
  teamOneId: uuid(20),
  teamTwoId: uuid(21),
  teamThreeId: uuid(22),
  assignmentOneId: uuid(30),
  assignmentTwoId: uuid(31),
  assignmentThreeId: uuid(32),
  weekOneId: uuid(40),
  scheduleOperationId: uuid(41),
  readinessOperationId: uuid(50),
  readinessJobId: uuid(51),
  readinessAttemptId: uuid(52),
  fadId: uuid(60),
  participantOneId: uuid(61),
  participantTwoId: uuid(62),
  participantThreeId: uuid(63),
  cardOneId: uuid(70),
  cardTwoId: uuid(71),
  cardThreeId: uuid(72),
  helpRequestId: uuid(80),
  playerId: uuid(81),
  playerPositionId: uuid(82),
  nominationQueueId: uuid(83),
});

const SECONDARY = Object.freeze({
  leagueId: uuid(201),
  seasonId: uuid(202),
  commissionerUserId: uuid(203),
  commissionerMembershipId: uuid(204),
  managerUserId: PRIMARY.managerUserId,
  managerMembershipId: uuid(205),
  teamOneId: uuid(220),
  assignmentOneId: uuid(230),
  weekOneId: uuid(240),
  scheduleOperationId: uuid(241),
  readinessOperationId: uuid(250),
  readinessJobId: uuid(251),
  fadId: uuid(260),
  participantOneId: uuid(261),
  cardOneId: uuid(270),
  helpRequestId: uuid(280),
  playerId: uuid(281),
  playerPositionId: uuid(282),
  nominationQueueId: uuid(283),
});

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function normalizeHashValue(value) {
  if (Buffer.isBuffer(value)) {
    return Object.freeze({
      type: "buffer",
      base64: value.toString("base64"),
    });
  }
  return value;
}

function semanticDatabaseHash(database) {
  const tables = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name);
  const state = tables.map((tableName) => {
    const rows = database
      .prepare(
        `SELECT * FROM "${tableName.replaceAll('"', '""')}"`
      )
      .all()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            normalizeHashValue(value),
          ])
        )
      )
      .map((row) => JSON.stringify(row))
      .sort();
    return [tableName, rows];
  });
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}

function byteDatabaseHash(database) {
  return createHash("sha256")
    .update(database.serialize())
    .digest("hex");
}

function noWriteSnapshot(database) {
  return Object.freeze({
    byteHash: byteDatabaseHash(database),
    semanticHash: semanticDatabaseHash(database),
    totalChanges: database
      .prepare("SELECT total_changes() AS count")
      .get().count,
  });
}

function assertNoWrites(database, before) {
  assert.deepEqual(noWriteSnapshot(database), before);
}

function seedUser(database, id, label) {
  const normalized = label.toLowerCase();
  const email = `${normalized.replaceAll(" ", "-")}@example.test`;
  insert(database, "users", {
    id,
    email_normalized: email,
    email_display: email,
    display_name: label,
    display_name_normalized: normalized,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
}

function seedMembership(
  database,
  {
    id,
    leagueId,
    userId,
    permissionCategory = "member",
    status = "active",
  }
) {
  insert(database, "league_memberships", {
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category: permissionCategory,
    status,
    joined_at_ms: 1,
    ended_at_ms: status === "active" ? null : 2,
    created_at_ms: 1,
    updated_at_ms: status === "active" ? 1 : 2,
    version: status === "active" ? 1 : 2,
  });
}

function seedTeam(
  database,
  {
    id,
    leagueId,
    name,
    primaryColour,
    secondaryColour,
    tertiaryColour = null,
    patternTemplate,
  }
) {
  insert(database, "teams", {
    id,
    league_id: leagueId,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: primaryColour,
    secondary_colour: secondaryColour,
    logo_reference: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    tertiary_colour: tertiaryColour,
    pattern_template: patternTemplate,
  });
}

function seedAssignment(
  database,
  {
    id,
    leagueId,
    teamId,
    userId,
    membershipId,
    assignedByUserId,
  }
) {
  insert(database, "team_manager_assignments", {
    id,
    league_id: leagueId,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: assignedByUserId,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
}

function seedLeagueSettings(database, leagueId) {
  insert(database, "league_settings", {
    league_id: leagueId,
    salary_cap_cents: 100_000,
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
}

function seedSeasonAndSchedule(
  database,
  {
    leagueId,
    seasonId,
    commissionerUserId,
    weekOneId,
    scheduleOperationId,
    weekOneStartsAtMs = WEEK_ONE_AT_MS,
    playoffsStartAtMs = PLAYOFFS_START_AT_MS,
    playoffsEndAtMs = PLAYOFFS_END_AT_MS,
  }
) {
  insert(database, "seasons", {
    id: seasonId,
    league_id: leagueId,
    label: "2026-27",
    nhl_season_key: `${seasonId.slice(-6)}2027`,
    status: "active",
    regular_season_starts_at_ms:
      weekOneStartsAtMs,
    regular_season_ends_at_ms: playoffsEndAtMs,
    fantasy_playoffs_start_at_ms:
      playoffsStartAtMs,
    fantasy_playoffs_end_at_ms: playoffsEndAtMs,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "matchup_weeks", {
    id: weekOneId,
    league_id: leagueId,
    season_id: seasonId,
    week_key: `${seasonId.slice(-6)}-W01`,
    sequence: 1,
    starts_at_ms: weekOneStartsAtMs,
    baseline_at_ms:
      weekOneStartsAtMs + 60 * 60 * 1_000,
    locks_at_ms:
      weekOneStartsAtMs + 16 * 60 * 60 * 1_000,
    ends_at_ms:
      weekOneStartsAtMs +
      7 * FREE_AGENT_DRAFT_DAY_MS,
    rolls_over_at_ms:
      weekOneStartsAtMs +
      7 * FREE_AGENT_DRAFT_DAY_MS,
    status: "scheduled",
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
  });
  insert(database, "matchup_operations", {
    id: scheduleOperationId,
    league_id: leagueId,
    season_id: seasonId,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: commissionerUserId,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: null,
    started_at_ms: 3,
    completed_at_ms: 4,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: leagueId,
    season_id: seasonId,
    schedule_version: 1,
    schedule_operation_id: scheduleOperationId,
    week_one_matchup_week_id: weekOneId,
    week_one_starts_at_ms: weekOneStartsAtMs,
    status: "current",
    created_at_ms: 4,
    superseded_at_ms: null,
    version: 1,
  });
}

function seedPrimaryLeague(database) {
  for (const [id, label] of [
    [PRIMARY.commissionerUserId, "Primary Commissioner"],
    [PRIMARY.managerUserId, "Multi Team Manager"],
    [PRIMARY.otherManagerUserId, "Other Team Manager"],
    [PRIMARY.memberUserId, "Ordinary Member"],
    [PRIMARY.administratorUserId, "Platform Administrator"],
  ]) {
    seedUser(database, id, label);
  }
  insert(database, "leagues", {
    id: PRIMARY.leagueId,
    name: "Primary FAD League",
    name_normalized: "primary fad league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  seedLeagueSettings(database, PRIMARY.leagueId);
  seedSeasonAndSchedule(database, {
    leagueId: PRIMARY.leagueId,
    seasonId: PRIMARY.seasonId,
    commissionerUserId: PRIMARY.commissionerUserId,
    weekOneId: PRIMARY.weekOneId,
    scheduleOperationId: PRIMARY.scheduleOperationId,
  });
  for (const membership of [
    {
      id: PRIMARY.commissionerMembershipId,
      userId: PRIMARY.commissionerUserId,
      permissionCategory: "commissioner",
    },
    {
      id: PRIMARY.managerMembershipId,
      userId: PRIMARY.managerUserId,
      permissionCategory: "manager",
    },
    {
      id: PRIMARY.otherManagerMembershipId,
      userId: PRIMARY.otherManagerUserId,
      permissionCategory: "manager",
    },
    {
      id: PRIMARY.memberMembershipId,
      userId: PRIMARY.memberUserId,
    },
    {
      id: PRIMARY.administratorMembershipId,
      userId: PRIMARY.administratorUserId,
    },
  ]) {
    seedMembership(database, {
      ...membership,
      leagueId: PRIMARY.leagueId,
    });
  }
  insert(database, "platform_roles", {
    id: PRIMARY.administratorRoleId,
    user_id: PRIMARY.administratorUserId,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: PRIMARY.commissionerUserId,
    granted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  const teams = [
    {
      id: PRIMARY.teamOneId,
      name: "Snow Owls",
      primaryColour: "#112233",
      secondaryColour: "#ffffff",
      tertiaryColour: null,
      patternTemplate: "mirrored-centre-band",
    },
    {
      id: PRIMARY.teamTwoId,
      name: "Ice Bears",
      primaryColour: "#223344",
      secondaryColour: "#eeeeee",
      tertiaryColour: "#556677",
      patternTemplate: "even-three",
    },
    {
      id: PRIMARY.teamThreeId,
      name: "Night Foxes",
      primaryColour: "#334455",
      secondaryColour: "#dddddd",
      tertiaryColour: null,
      patternTemplate: "outlined-centre",
    },
  ];
  for (const team of teams) {
    seedTeam(database, {
      ...team,
      leagueId: PRIMARY.leagueId,
    });
  }
  for (const assignment of [
    {
      id: PRIMARY.assignmentOneId,
      teamId: PRIMARY.teamOneId,
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
    },
    {
      id: PRIMARY.assignmentTwoId,
      teamId: PRIMARY.teamTwoId,
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
    },
    {
      id: PRIMARY.assignmentThreeId,
      teamId: PRIMARY.teamThreeId,
      userId: PRIMARY.otherManagerUserId,
      membershipId: PRIMARY.otherManagerMembershipId,
    },
  ]) {
    seedAssignment(database, {
      ...assignment,
      leagueId: PRIMARY.leagueId,
      assignedByUserId: PRIMARY.commissionerUserId,
    });
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
      PRIMARY.commissionerMembershipId,
      PRIMARY.seasonId,
      PRIMARY.leagueId
    );
}

function seedSecondaryLeague(database) {
  seedUser(
    database,
    SECONDARY.commissionerUserId,
    "Secondary Commissioner"
  );
  insert(database, "leagues", {
    id: SECONDARY.leagueId,
    name: "Secondary FAD League",
    name_normalized: "secondary fad league",
    status: "active",
    timezone: "America/Edmonton",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  seedLeagueSettings(database, SECONDARY.leagueId);
  seedSeasonAndSchedule(database, {
    leagueId: SECONDARY.leagueId,
    seasonId: SECONDARY.seasonId,
    commissionerUserId: SECONDARY.commissionerUserId,
    weekOneId: SECONDARY.weekOneId,
    scheduleOperationId: SECONDARY.scheduleOperationId,
    weekOneStartsAtMs:
      SECONDARY_WEEK_ONE_AT_MS,
    playoffsStartAtMs:
      SECONDARY_PLAYOFFS_START_AT_MS,
    playoffsEndAtMs:
      SECONDARY_PLAYOFFS_END_AT_MS,
  });
  seedMembership(database, {
    id: SECONDARY.commissionerMembershipId,
    leagueId: SECONDARY.leagueId,
    userId: SECONDARY.commissionerUserId,
    permissionCategory: "commissioner",
  });
  seedMembership(database, {
    id: SECONDARY.managerMembershipId,
    leagueId: SECONDARY.leagueId,
    userId: SECONDARY.managerUserId,
    permissionCategory: "manager",
  });
  seedTeam(database, {
    id: SECONDARY.teamOneId,
    leagueId: SECONDARY.leagueId,
    name: "Prairie Wolves",
    primaryColour: "#445566",
    secondaryColour: "#cccccc",
    tertiaryColour: null,
    patternTemplate: "split-colour-block",
  });
  seedAssignment(database, {
    id: SECONDARY.assignmentOneId,
    leagueId: SECONDARY.leagueId,
    teamId: SECONDARY.teamOneId,
    userId: SECONDARY.managerUserId,
    membershipId: SECONDARY.managerMembershipId,
    assignedByUserId: SECONDARY.commissionerUserId,
  });
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
      SECONDARY.commissionerMembershipId,
      SECONDARY.seasonId,
      SECONDARY.leagueId
    );
}

function createRuntime(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-read-repository-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-read-repository-foundation",
    now: () => 1,
  });
  seedPrimaryLeague(connection.database);
  seedSecondaryLeague(connection.database);
  const readRepository =
    createSqliteFreeAgentDraftReadRepository({
      database: connection.database,
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
  return Object.freeze({
    database: connection.database,
    readRepository,
  });
}

function readinessOccurrenceKey(scope) {
  return buildFreeAgentDraftReadinessOccurrenceKey({
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    triggerResourceId: scope.seasonId,
  });
}

function safeTeam(database, teamId) {
  const row = database
    .prepare(`
      SELECT
        id AS team_id,
        name,
        primary_colour,
        secondary_colour,
        tertiary_colour,
        pattern_template,
        logo_reference
      FROM teams
      WHERE id = ?
    `)
    .get(teamId);
  return Object.freeze({
    teamId: row.team_id,
    name: row.name,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate: row.pattern_template,
    logoReference: row.logo_reference,
  });
}

function scopedWeekOneStartsAtMs(scope) {
  return scope === SECONDARY
    ? SECONDARY_WEEK_ONE_AT_MS
    : WEEK_ONE_AT_MS;
}

function initialRolloverProjection(
  scope = PRIMARY
) {
  const candidateDeadlineAtMs =
    scopedWeekOneStartsAtMs(scope) -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  return Array.from(
    { length: FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT },
    (_, index) => {
      const opensAtMs =
        candidateDeadlineAtMs +
        index * FREE_AGENT_DRAFT_DAY_MS;
      const rollsOverAtMs =
        opensAtMs + FREE_AGENT_DRAFT_DAY_MS;
      return Object.freeze({
        sequence: index + 1,
        opensAtMs,
        creationCutoffAtMs:
          rollsOverAtMs - 60 * 60 * 1_000,
        rollsOverAtMs,
      });
    }
  );
}

function openingParticipants(scope) {
  if (scope === PRIMARY) {
    return Object.freeze([
      Object.freeze({
        teamId: scope.teamOneId,
        participantId: scope.participantOneId,
        cardId: scope.cardOneId,
        notificationId: uuid(1_001),
        managerAssignmentId: scope.assignmentOneId,
      }),
      Object.freeze({
        teamId: scope.teamTwoId,
        participantId: scope.participantTwoId,
        cardId: scope.cardTwoId,
        notificationId: uuid(1_002),
        managerAssignmentId: scope.assignmentTwoId,
      }),
      Object.freeze({
        teamId: scope.teamThreeId,
        participantId: scope.participantThreeId,
        cardId: scope.cardThreeId,
        notificationId: uuid(1_003),
        managerAssignmentId: scope.assignmentThreeId,
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      teamId: scope.teamOneId,
      participantId: scope.participantOneId,
      cardId: scope.cardOneId,
      notificationId: uuid(2_001),
      managerAssignmentId: scope.assignmentOneId,
    }),
  ]);
}

function openingEvidence(scope) {
  const base = scope === PRIMARY ? 1_100 : 2_100;
  return Object.freeze({
    fadId: scope.fadId,
    participants: openingParticipants(scope).map(
      ({
        teamId,
        participantId,
        cardId,
        notificationId,
      }) =>
        Object.freeze({
          teamId,
          participantId,
          cardId,
          notificationId,
        })
    ),
    reminderJobRunId: uuid(base),
    deadlineJobRunId: uuid(base + 1),
    rolloverIds: Array.from(
      { length: FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT },
      (_, index) => uuid(base + 10 + index)
    ),
    rolloverJobRunIds: Array.from(
      { length: FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT },
      (_, index) => uuid(base + 20 + index)
    ),
    activityId: uuid(base + 30),
    outboxEventId: uuid(base + 31),
    outboxAudienceId: uuid(base + 32),
  });
}

function readinessTeamProjections(database, scope) {
  return openingParticipants(scope).map((participant) =>
    Object.freeze({
      teamId: participant.teamId,
      team: safeTeam(database, participant.teamId),
      managerReady: true,
      managerAssignmentId:
        participant.managerAssignmentId,
      carryoverCount: 0,
      openForwardSlots: 12,
      openDefenceSlots: 6,
      openBenchSlots: 4,
      structuralConflictCount: 0,
    })
  );
}

function readinessAttemptProjection(
  database,
  scope,
  overrides = {}
) {
  const weekOneStartsAtMs =
    scopedWeekOneStartsAtMs(scope);
  const candidateDeadlineAtMs =
    weekOneStartsAtMs -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: {
      weekId: scope.weekOneId,
      sequence: 1,
      startsAtMs: weekOneStartsAtMs,
      version: 1,
    },
    firstMatchupWeekAfter: {
      weekId: scope.weekOneId,
      sequence: 1,
      startsAtMs: weekOneStartsAtMs,
      version: 1,
    },
    candidateDeadlineAtMs,
    reminderAtMs:
      candidateDeadlineAtMs -
      3 * FREE_AGENT_DRAFT_DAY_MS,
    helpOpensAtMs:
      candidateDeadlineAtMs -
      2 * FREE_AGENT_DRAFT_DAY_MS,
    initialRollovers:
      initialRolloverProjection(scope),
    priorSeasonRollover: null,
    participatingTeamCount:
      openingParticipants(scope).length,
    teamProjections:
      readinessTeamProjections(database, scope),
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function readinessTriggerInput(scope) {
  return {
    operationId: scope.readinessOperationId,
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    triggerKind: "no_draft_inaugural",
    triggerResourceId: scope.seasonId,
    entryDraftId: null,
    setupExemptionId: null,
    jobRunId: scope.readinessJobId,
    createdAtMs: OPENED_AT_MS - 1_000,
  };
}

function createLifecycleRepository(database) {
  return createSqliteFreeAgentDraftRepository({
    database,
    notificationWriter:
      createSqliteNotificationWriter({ database }),
    candidateCardWriter:
      createSqliteCandidateCardOpeningWriter({
        database,
      }),
  });
}

function ensureReadiness(database, scope) {
  return createLifecycleRepository(
    database
  ).ensureReadinessOperation(
    readinessTriggerInput(scope)
  );
}

function claimReadiness(
  database,
  scope,
  {
    expectedVersion = 1,
    nowMs = OPENED_AT_MS - 900,
    leaseSuffix = "one",
  } = {}
) {
  const leaseOwner =
    `fad-read-worker-${scope.leagueId.slice(-4)}-${leaseSuffix}`;
  const leaseToken =
    `fad-read-lease-${scope.leagueId.slice(-4)}-${leaseSuffix}`;
  const leaseExpiresAtMs =
    nowMs + 2 * FREE_AGENT_DRAFT_DAY_MS;
  const claimed =
    createSqliteFreeAgentDraftJobRepository({
      database,
    }).claim({
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      fadId: null,
      runId: scope.readinessJobId,
      jobType: "fad_readiness",
      occurrenceKey: readinessOccurrenceKey(scope),
      scheduledForMs: OPENED_AT_MS - 1_000,
      expectedVersion,
      leaseOwner,
      leaseToken,
      nowMs,
      leaseExpiresAtMs,
    });
  assert.equal(claimed.acquired, true);
  return Object.freeze({
    attemptNumber:
      claimed.occurrence.binding
        .readinessExecution.attemptCount,
    readinessVersion:
      claimed.occurrence.binding
        .readinessExecution.version,
    jobExecution: Object.freeze({
      runId: scope.readinessJobId,
      leaseOwner,
      leaseToken,
      leaseExpiresAtMs,
      expectedVersion: claimed.occurrence.version,
    }),
  });
}

function openingCommand(database, scope, claim) {
  const context =
    createSqliteFreeAgentDraftReadRepository({
      database,
    }).readOpeningPreflightContext({
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
    });
  const projection = readinessAttemptProjection(
    database,
    scope
  );
  const attemptId =
    scope === PRIMARY
      ? PRIMARY.readinessAttemptId
      : uuid(2_052);
  const attemptEvidence =
    createFreeAgentDraftReadinessAttemptEvidence({
      id: attemptId,
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      readinessOperationId:
        scope.readinessOperationId,
      jobRunId: scope.readinessJobId,
      attemptNumber: claim.attemptNumber,
      observedReadinessVersion:
        claim.readinessVersion,
      outcome: "succeeded",
      observedAtMs: OPENED_AT_MS,
      recordedAtMs: OPENED_AT_MS,
      projection,
    });
  const attempt = Object.freeze({
    id: attemptEvidence.id,
    leagueId: attemptEvidence.leagueId,
    seasonId: attemptEvidence.seasonId,
    readinessOperationId:
      attemptEvidence.readinessOperationId,
    jobRunId: attemptEvidence.jobRunId,
    attemptNumber: attemptEvidence.attemptNumber,
    observedReadinessVersion:
      attemptEvidence.observedReadinessVersion,
    outcome: attemptEvidence.outcome,
    observedAtMs: attemptEvidence.observedAtMs,
    recordedAtMs: attemptEvidence.recordedAtMs,
    projection: attemptEvidence.projection,
  });
  return {
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    occurrenceKey: readinessOccurrenceKey(scope),
    readinessOperationId:
      scope.readinessOperationId,
    expectedReadinessVersion:
      claim.readinessVersion,
    openedAtMs: OPENED_AT_MS,
    setupPath: "no_draft_inaugural",
    entryDraftId: null,
    setupExemptionId: null,
    priorSeasonRolloverId: null,
    noDraftReason: "Inaugural league season.",
    schedule: {
      operationId: scope.scheduleOperationId,
      version: 1,
      weekOneMatchupWeekId: scope.weekOneId,
      weekOneStartsAtMs:
        scopedWeekOneStartsAtMs(scope),
    },
    scheduleRecoveryPlan: null,
    carryoverProjection:
      projectFreeAgentDraftCarryovers({
        seasonId: scope.seasonId,
        participatingTeams:
          context.participatingTeams,
        leagueSettings: context.leagueSettings,
        ownerships: context.ownerships,
        activeContracts:
          context.activeContracts,
        targetContractYears:
          context.targetContractYears,
        allContractYears:
          context.allContractYears,
        leaguePositionOverrides:
          context.leaguePositionOverrides,
        currentPlayerSources:
          context.currentPlayerSources,
      }),
    evidence: openingEvidence(scope),
    jobExecution: claim.jobExecution,
    attempt,
  };
}

function openDraft(database, scope) {
  const repository = createLifecycleRepository(database);
  repository.ensureReadinessOperation(
    readinessTriggerInput(scope)
  );
  const claim = claimReadiness(database, scope);
  return repository.commitOpening(
    openingCommand(database, scope, claim)
  );
}

function blockReadiness(database, scope = PRIMARY) {
  const repository = createLifecycleRepository(database);
  repository.ensureReadinessOperation(
    readinessTriggerInput(scope)
  );
  const claim = claimReadiness(database, scope);
  const blockedAtMs = OPENED_AT_MS - 500;
  const blocker = Object.freeze({
    code: "TEAM_MANAGER_MISSING",
    field: null,
    resourceType: "team",
    resourceId: scope.teamThreeId,
    message: "A participating team needs an active manager.",
  });
  const projection = readinessAttemptProjection(
    database,
    scope,
    {
      blockers: [
        Object.freeze({
          code: blocker.code,
          message: blocker.message,
          resourceId: blocker.resourceId,
        }),
      ],
      warnings: [
        Object.freeze({
          code: "WEEK_ONE_ADJUSTMENT_AVAILABLE",
          message: "Week 1 can move by whole Mondays.",
          resourceId: scope.weekOneId,
        }),
      ],
    }
  );
  const rawAttempt =
    createFreeAgentDraftReadinessAttemptEvidence({
      id: scope.readinessAttemptId,
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      readinessOperationId:
        scope.readinessOperationId,
      jobRunId: scope.readinessJobId,
      attemptNumber: claim.attemptNumber,
      observedReadinessVersion:
        claim.readinessVersion,
      outcome: "blocked",
      observedAtMs: blockedAtMs,
      recordedAtMs: blockedAtMs,
      projection,
    });
  const attempt = Object.freeze({
    id: rawAttempt.id,
    leagueId: rawAttempt.leagueId,
    seasonId: rawAttempt.seasonId,
    readinessOperationId:
      rawAttempt.readinessOperationId,
    jobRunId: rawAttempt.jobRunId,
    attemptNumber: rawAttempt.attemptNumber,
    observedReadinessVersion:
      rawAttempt.observedReadinessVersion,
    outcome: rawAttempt.outcome,
    observedAtMs: rawAttempt.observedAtMs,
    recordedAtMs: rawAttempt.recordedAtMs,
    projection: rawAttempt.projection,
  });
  return repository.blockReadinessOperation({
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    occurrenceKey: readinessOccurrenceKey(scope),
    expectedVersion: claim.readinessVersion,
    blockers: [blocker],
    blockedAtMs,
    nextRetryAtMs: blockedAtMs + 60 * 60 * 1_000,
    notificationId: uuid(1_250),
    jobExecution: claim.jobExecution,
    attempt,
  });
}

function persistReadinessRetry(database, acceptedAtMs) {
  const clientKey =
    "fad-read-foundation-second-attempt";
  const idempotencyRequestId = uuid(1_251);
  const retryReceiptId = uuid(1_252);
  const request =
    createFreeAgentDraftReadinessRetryRequest({
      actorUserId: PRIMARY.commissionerUserId,
      body: {
        seasonId: PRIMARY.seasonId,
        readinessOperationId:
          PRIMARY.readinessOperationId,
        confirmation:
          "RETRY FREE AGENT DRAFT READINESS",
      },
      clientKey,
      expectedVersion: 3,
      leagueId: PRIMARY.leagueId,
    });
  const receipt =
    createFreeAgentDraftReadinessRetryReceipt({
      acceptedAtMs,
      acceptedFromVersion: 3,
      actorAuthority: "commissioner",
      actorMembershipId:
        PRIMARY.commissionerMembershipId,
      actorUserId: PRIMARY.commissionerUserId,
      id: retryReceiptId,
      idempotencyRequestId,
      jobRunId: PRIMARY.readinessJobId,
      leagueId: PRIMARY.leagueId,
      occurrenceKey: readinessOccurrenceKey(PRIMARY),
      readinessOperationId:
        PRIMARY.readinessOperationId,
      requestSha256: request.requestSha256,
      resultingReadinessVersion: 4,
      retryAttemptNumber: 2,
      seasonId: PRIMARY.seasonId,
    });
  database.exec("BEGIN IMMEDIATE");
  try {
    insert(database, "idempotency_requests", {
      id: idempotencyRequestId,
      league_id: PRIMARY.leagueId,
      actor_user_id: PRIMARY.commissionerUserId,
      operation: "free_agent_draft.readiness.retry.v1",
      client_key: clientKey,
      request_hash: request.requestSha256,
      status: "started",
      result_type: null,
      result_id: null,
      created_at_ms: acceptedAtMs,
      completed_at_ms: null,
      expires_at_ms:
        acceptedAtMs + FREE_AGENT_DRAFT_DAY_MS,
    });
    assert.equal(
      database
        .prepare(`
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
            AND version = 3
        `)
        .run({
          acceptedAtMs,
          jobRunId: PRIMARY.readinessJobId,
          leagueId: PRIMARY.leagueId,
        }).changes,
      1
    );
    insert(
      database,
      "free_agent_draft_readiness_retry_receipts",
      {
        id: receipt.id,
        league_id: receipt.leagueId,
        season_id: receipt.seasonId,
        readiness_operation_id:
          receipt.readinessOperationId,
        idempotency_request_id:
          receipt.idempotencyRequestId,
        actor_user_id: receipt.actorUserId,
        actor_membership_id:
          receipt.actorMembershipId,
        actor_authority: receipt.actorAuthority,
        request_sha256: receipt.requestSha256,
        accepted_from_version:
          receipt.acceptedFromVersion,
        resulting_readiness_version:
          receipt.resultingReadinessVersion,
        retry_attempt_number:
          receipt.retryAttemptNumber,
        job_run_id: receipt.jobRunId,
        occurrence_key: receipt.occurrenceKey,
        accepted_at_ms: receipt.acceptedAtMs,
        response_http_status:
          receipt.responseHttpStatus,
        response_json: receipt.responseJson,
        response_sha256: receipt.responseSha256,
        version: receipt.version,
      }
    );
    assert.equal(
      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET next_retry_at_ms = @acceptedAtMs,
              updated_at_ms = @acceptedAtMs,
              version = version + 1
          WHERE league_id = @leagueId
            AND id = @operationId
            AND status = 'blocked'
            AND version = 3
        `)
        .run({
          acceptedAtMs,
          leagueId: PRIMARY.leagueId,
          operationId: PRIMARY.readinessOperationId,
        }).changes,
      1
    );
    assert.equal(
      database
        .prepare(`
          UPDATE idempotency_requests
          SET status = 'completed',
              result_type =
                'free_agent_draft_readiness_retry_receipt',
              result_id = @retryReceiptId,
              completed_at_ms = @acceptedAtMs
          WHERE league_id = @leagueId
            AND id = @idempotencyRequestId
            AND status = 'started'
        `)
        .run({
          acceptedAtMs,
          idempotencyRequestId,
          leagueId: PRIMARY.leagueId,
          retryReceiptId,
        }).changes,
      1
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function addSecondBlockedReadinessAttempt(database) {
  const acceptedAtMs =
    OPENED_AT_MS + 2 * 60 * 60 * 1_000;
  persistReadinessRetry(database, acceptedAtMs);
  const claim = claimReadiness(
    database,
    PRIMARY,
    {
      expectedVersion: 4,
      nowMs: acceptedAtMs + 1,
      leaseSuffix: "two",
    }
  );
  assert.equal(claim.attemptNumber, 2);
  assert.equal(claim.readinessVersion, 5);

  const blocker = Object.freeze({
    code: "MATCHUP_WEEK_MISSING",
    field: null,
    resourceType: "matchup_week",
    resourceId: PRIMARY.weekOneId,
    message: "The latest attempt could not resolve Week 1.",
  });
  const teamProjections = readinessTeamProjections(
    database,
    PRIMARY
  ).map((projection, index) =>
    index === 0
      ? Object.freeze({
          ...projection,
          team: Object.freeze({
            ...projection.team,
            name: "Newest Frozen Snow Owls",
          }),
        })
      : projection
  );
  const projection = readinessAttemptProjection(
    database,
    PRIMARY,
    {
      firstMatchupWeekAfter: null,
      candidateDeadlineAtMs: null,
      reminderAtMs: null,
      helpOpensAtMs: null,
      initialRollovers: [],
      teamProjections,
      blockers: [
        Object.freeze({
          code: blocker.code,
          message: blocker.message,
          resourceId: blocker.resourceId,
        }),
      ],
      warnings: [],
    }
  );
  const blockedAtMs = acceptedAtMs + 2;
  const rawAttempt =
    createFreeAgentDraftReadinessAttemptEvidence({
      id: uuid(1_253),
      leagueId: PRIMARY.leagueId,
      seasonId: PRIMARY.seasonId,
      readinessOperationId:
        PRIMARY.readinessOperationId,
      jobRunId: PRIMARY.readinessJobId,
      attemptNumber: 2,
      observedReadinessVersion: 5,
      outcome: "blocked",
      observedAtMs: blockedAtMs,
      recordedAtMs: blockedAtMs,
      projection,
    });
  const attempt = Object.freeze({
    id: rawAttempt.id,
    leagueId: rawAttempt.leagueId,
    seasonId: rawAttempt.seasonId,
    readinessOperationId:
      rawAttempt.readinessOperationId,
    jobRunId: rawAttempt.jobRunId,
    attemptNumber: rawAttempt.attemptNumber,
    observedReadinessVersion:
      rawAttempt.observedReadinessVersion,
    outcome: rawAttempt.outcome,
    observedAtMs: rawAttempt.observedAtMs,
    recordedAtMs: rawAttempt.recordedAtMs,
    projection: rawAttempt.projection,
  });
  createLifecycleRepository(
    database
  ).blockReadinessOperation({
    leagueId: PRIMARY.leagueId,
    seasonId: PRIMARY.seasonId,
    occurrenceKey: readinessOccurrenceKey(PRIMARY),
    expectedVersion: 5,
    blockers: [blocker],
    blockedAtMs,
    nextRetryAtMs:
      blockedAtMs + 60 * 60 * 1_000,
    notificationId: uuid(1_254),
    jobExecution: claim.jobExecution,
    attempt,
  });
  return Object.freeze({
    blocker,
    projection: rawAttempt.projection,
  });
}

function dropTableTriggers(database, tableName) {
  const triggers = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name
    `)
    .all(tableName);
  for (const { name } of triggers) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
}

function seedActiveHelpRequest(database, scope = PRIMARY) {
  const isPrimary = scope === PRIMARY;
  const candidateDeadlineAtMs =
    scopedWeekOneStartsAtMs(scope) -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  insert(database, "candidate_card_help_requests", {
    id: scope.helpRequestId,
    league_id: scope.leagueId,
    season_id: scope.seasonId,
    fad_id: scope.fadId,
    card_id: isPrimary
      ? PRIMARY.cardThreeId
      : SECONDARY.cardOneId,
    team_id: isPrimary
      ? PRIMARY.teamThreeId
      : SECONDARY.teamOneId,
    status: "active",
    message: isPrimary
      ? "Please help me finish this card."
      : "Secondary league help sentinel.",
    requested_by_user_id: isPrimary
      ? PRIMARY.otherManagerUserId
      : SECONDARY.managerUserId,
    requested_by_membership_id: isPrimary
      ? PRIMARY.otherManagerMembershipId
      : SECONDARY.managerMembershipId,
    requested_at_ms: PREPUBLICATION_NOW_MS,
    expires_at_ms: candidateDeadlineAtMs,
    created_at_ms: PREPUBLICATION_NOW_MS,
    updated_at_ms: PREPUBLICATION_NOW_MS,
    version: 1,
  });
}

function seedAuthoritativeCandidateConflict(database) {
  const {
    createSqliteCandidateCardRepository,
  } = require(
    "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardRepository"
  );
  const candidatePlayerId = uuid(1_870);
  const candidatePositionId = uuid(1_871);
  const candidateEntryId = uuid(1_872);
  const candidateRevisionId = uuid(1_873);
  const carryoverPlayerId = uuid(1_874);
  const carryoverPositionId = uuid(1_875);
  const carryoverOwnershipId = uuid(1_876);
  const carryoverContractId = uuid(1_877);
  const carryoverContractYearId = uuid(1_878);
  const carryoverEntryId = uuid(1_879);
  const synchronizationRevisionId = uuid(1_880);
  const candidateAddedAtMs = PREPUBLICATION_NOW_MS - 2;
  const synchronizedAtMs = PREPUBLICATION_NOW_MS - 1;
  const conflictCode =
    "CANDIDATE_SLOT_CLAIMED_BY_CARRYOVER";

  for (const player of [
    {
      id: candidatePlayerId,
      positionId: candidatePositionId,
      firstName: "Avery",
      lastName: "Candidate",
    },
    {
      id: carryoverPlayerId,
      positionId: carryoverPositionId,
      firstName: "Cory",
      lastName: "Carryover",
    },
  ]) {
    insert(database, "players", {
      id: player.id,
      first_name: player.firstName,
      last_name: player.lastName,
      full_name: `${player.firstName} ${player.lastName}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_player_positions", {
      id: player.positionId,
      league_id: PRIMARY.leagueId,
      player_id: player.id,
      position_group: "F",
      reason: "Foundation Candidate conflict fixture",
      corrected_by_user_id: PRIMARY.commissionerUserId,
      effective_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }

  const repository = createSqliteCandidateCardRepository({
    database,
    writeMutationSideEffects() {},
    writeHelpGrantSideEffects() {},
  });
  repository.mutate({
    scope: {
      leagueId: PRIMARY.leagueId,
      seasonId: PRIMARY.seasonId,
      fadId: PRIMARY.fadId,
      cardId: PRIMARY.cardOneId,
      teamId: PRIMARY.teamOneId,
    },
    actor: {
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
      authority: "manager",
    },
    expectedCardVersion: 1,
    nowMs: candidateAddedAtMs,
    idempotency: {
      requestId: uuid(1_881),
      clientKey: "fad-read-authoritative-conflict-add",
      expiresAtMs:
        candidateAddedAtMs + FREE_AGENT_DRAFT_DAY_MS,
    },
    revisionId: candidateRevisionId,
    action: {
      type: "add",
      entryId: candidateEntryId,
      playerId: candidatePlayerId,
      slotKey: "F01",
      totalValueCents: 600,
      aavCents: 300,
      termYears: 2,
    },
  });

  insert(database, "player_ownerships", {
    id: carryoverOwnershipId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    player_id: carryoverPlayerId,
    team_id: PRIMARY.teamOneId,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "season_rollover",
    acquired_transaction_id: null,
    created_at_ms: candidateAddedAtMs,
    updated_at_ms: candidateAddedAtMs,
    version: 1,
  });
  insert(database, "contracts", {
    id: carryoverContractId,
    league_id: PRIMARY.leagueId,
    player_id: carryoverPlayerId,
    current_team_id: PRIMARY.teamOneId,
    contract_type: "normal",
    original_total_value_cents: 300,
    original_term_years: 3,
    aav_cents: 100,
    start_season_id: PRIMARY.seasonId,
    status: "active",
    acquisition_source_type: "season_rollover",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: candidateAddedAtMs,
    updated_at_ms: candidateAddedAtMs,
    version: 1,
  });
  insert(database, "contract_years", {
    id: carryoverContractYearId,
    league_id: PRIMARY.leagueId,
    contract_id: carryoverContractId,
    season_id: PRIMARY.seasonId,
    year_number: 3,
    aav_cents: 100,
    status: "current",
    rollover_at_ms: candidateAddedAtMs,
    created_at_ms: candidateAddedAtMs,
  });

  repository.synchronizeCarryovers({
    scope: {
      leagueId: PRIMARY.leagueId,
      seasonId: PRIMARY.seasonId,
      fadId: PRIMARY.fadId,
      cardId: PRIMARY.cardOneId,
      teamId: PRIMARY.teamOneId,
    },
    expectedCardVersion: 2,
    nowMs: synchronizedAtMs,
    revisionId: synchronizationRevisionId,
    carryovers: [
      {
        entryId: carryoverEntryId,
        entryKind: "carryover",
        playerId: carryoverPlayerId,
        ownershipId: carryoverOwnershipId,
        contractId: carryoverContractId,
        effectivePositionGroup: "F",
        slotKey: "F01",
        placementState: "placed",
        conflictCode: null,
        sourceRosterCategory: "Active",
        contractType: "normal",
        originalTotalValueCents: 300,
        originalTermYears: 3,
        aavCents: 100,
        remainingYears: 1,
      },
    ],
    candidateConflicts: [
      { entryId: candidateEntryId, conflictCode },
    ],
    candidateReplacements: [],
  });

  return Object.freeze({
    candidateEntryId,
    conflictCode,
    synchronizedAtMs,
  });
}

function moveDraftToDeadlineLocked(
  database,
  scope = PRIMARY
) {
  // FAD-10 owns the atomic deadline lock and snapshot transition. Until that
  // writer exists, read-foundation fixtures bypass only the two aggregate
  // lifecycle guards; entry, snapshot, allocation, context, and FK guards stay.
  dropTableTriggers(database, "candidate_cards");
  dropTableTriggers(database, "free_agent_drafts");
  database
    .prepare(`
      UPDATE candidate_cards
      SET status = 'locked_incomplete',
          locked_at_ms = @lockedAtMs,
          updated_at_ms = @lockedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND status = 'open'
    `)
    .run({
      fadId: scope.fadId,
      leagueId: scope.leagueId,
      lockedAtMs: PUBLICATION_AT_MS,
    });
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked',
          deadline_locked_at_ms = @deadlineLockedAtMs,
          updated_at_ms = @deadlineLockedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @fadId
    `)
    .run({
      deadlineLockedAtMs: PUBLICATION_AT_MS,
      fadId: scope.fadId,
      leagueId: scope.leagueId,
    });
}

function moveDraftToRapid(database, scope = PRIMARY) {
  // FAD-10/11 will own deadline allocation and rapid activation. This helper
  // bypasses only Candidate Card/FAD aggregate lifecycle guards while all
  // downstream persisted-evidence and foreign-key guards remain enabled.
  dropTableTriggers(database, "candidate_cards");
  dropTableTriggers(database, "free_agent_drafts");
  database
    .prepare(`
      UPDATE candidate_cards
      SET status = 'locked_incomplete',
          locked_at_ms = @lockedAtMs,
          updated_at_ms = @lockedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND status = 'open'
    `)
    .run({
      fadId: scope.fadId,
      leagueId: scope.leagueId,
      lockedAtMs: PUBLICATION_AT_MS,
    });
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'rapid',
          deadline_locked_at_ms = @deadlineLockedAtMs,
          allocation_completed_at_ms = @allocationCompletedAtMs,
          updated_at_ms = @allocationCompletedAtMs,
          version = 4
      WHERE league_id = @leagueId
        AND id = @fadId
    `)
    .run({
      allocationCompletedAtMs: ALLOCATION_AT_MS,
      deadlineLockedAtMs: PUBLICATION_AT_MS,
      fadId: scope.fadId,
      leagueId: scope.leagueId,
    });
}

function seedQueuedNomination(database, scope = PRIMARY) {
  const isPrimary = scope === PRIMARY;
  insert(database, "players", {
    id: scope.playerId,
    first_name: isPrimary ? "Alex" : "Blair",
    last_name: isPrimary ? "Example" : "Boundary",
    full_name: isPrimary
      ? "Alex Example"
      : "Blair Boundary",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: uuid(isPrimary ? 1_300 : 1_301),
    player_id: scope.playerId,
    provider: "sportsdataio-discovery-lab",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "fixture-v1",
    source_payload_json: null,
    effective_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
  });
  insert(database, "league_player_positions", {
    id: scope.playerPositionId,
    league_id: scope.leagueId,
    player_id: scope.playerId,
    position_group: "F",
    reason: "Foundation fixture",
    corrected_by_user_id: scope.commissionerUserId,
    effective_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  const firstRollover = database
    .prepare(`
      SELECT id, creation_cutoff_at_ms, rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = ?
        AND fad_id = ?
        AND sequence = 1
    `)
    .get(scope.leagueId, scope.fadId);
  const acceptedAtMs = firstRollover.creation_cutoff_at_ms;
  const acceptanceIdempotencyRequestId = uuid(
    isPrimary ? 1_302 : 1_303
  );
  const observed = database
    .prepare(`
      SELECT
        candidate_cards.version AS card_version,
        teams.version AS team_version
      FROM candidate_cards
      JOIN teams
        ON teams.league_id = candidate_cards.league_id
       AND teams.id = candidate_cards.team_id
      WHERE candidate_cards.league_id = ?
        AND candidate_cards.fad_id = ?
        AND candidate_cards.team_id = ?
    `)
    .get(scope.leagueId, scope.fadId, scope.teamOneId);
  insert(database, "idempotency_requests", {
    id: acceptanceIdempotencyRequestId,
    league_id: scope.leagueId,
    actor_user_id: scope.managerUserId,
    operation: "auction.start",
    client_key: isPrimary
      ? "fad-read-primary-final-hour-nomination"
      : "fad-read-secondary-final-hour-nomination",
    request_hash: (isPrimary ? "a" : "b").repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: acceptedAtMs,
    completed_at_ms: null,
    expires_at_ms:
      acceptedAtMs + FREE_AGENT_DRAFT_DAY_MS,
  });
  insert(database, "free_agent_draft_nomination_queue", {
    id: scope.nominationQueueId,
    league_id: scope.leagueId,
    season_id: scope.seasonId,
    fad_id: scope.fadId,
    team_id: scope.teamOneId,
    player_id: scope.playerId,
    source_rollover_id: firstRollover.id,
    target_opening_rollover_id: firstRollover.id,
    resolution_rollover_id: null,
    opening_total_value_cents: 600,
    opening_term_years: 2,
    opening_aav_cents: 300,
    binding_illegality_confirmed: 1,
    binding_confirmed_at_ms: acceptedAtMs,
    acceptance_idempotency_request_id:
      acceptanceIdempotencyRequestId,
    submitted_by_user_id: scope.managerUserId,
    submitted_by_membership_id:
      scope.managerMembershipId,
    accepted_at_ms: acceptedAtMs,
    candidate_card_version_observed: observed.card_version,
    team_version_observed: observed.team_version,
    status: "queued",
    opened_auction_id: null,
    opened_starter_bid_id: null,
    opened_at_ms: null,
    terminal_at_ms: null,
    validation_code: null,
    created_at_ms: acceptedAtMs,
    updated_at_ms: acceptedAtMs,
    version: 1,
  });
  return Object.freeze({
    acceptedAtMs,
    rolloverId: firstRollover.id,
    rollsOverAtMs: firstRollover.rolls_over_at_ms,
  });
}

function seedOpenRapidAuction(database, scope = PRIMARY) {
  const isPrimary = scope === PRIMARY;
  const auctionId = uuid(scope === PRIMARY ? 1_310 : 1_311);
  const rapidPlayerId = uuid(
    scope === PRIMARY ? 1_312 : 1_313
  );
  const rapidPlayerPositionId = uuid(
    scope === PRIMARY ? 1_314 : 1_315
  );
  const rollover = database
    .prepare(`
      SELECT id, opens_at_ms, rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = ?
        AND fad_id = ?
        AND sequence = 1
    `)
    .get(scope.leagueId, scope.fadId);
  insert(database, "players", {
    id: rapidPlayerId,
    first_name: isPrimary ? "Robin" : "Sage",
    last_name: "Rapid",
    full_name: isPrimary
      ? "Robin Rapid"
      : "Sage Rapid",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_player_positions", {
    id: rapidPlayerPositionId,
    league_id: scope.leagueId,
    player_id: rapidPlayerId,
    position_group: "F",
    reason: "Foundation rapid-auction fixture",
    corrected_by_user_id: scope.commissionerUserId,
    effective_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "auctions", {
    id: auctionId,
    league_id: scope.leagueId,
    season_id: scope.seasonId,
    player_id: rapidPlayerId,
    status: "open",
    opened_at_ms: ALLOCATION_AT_MS,
    resolves_at_ms: rollover.rolls_over_at_ms,
    opened_by_user_id: scope.managerUserId,
    created_at_ms: ALLOCATION_AT_MS,
    updated_at_ms: ALLOCATION_AT_MS,
    version: 1,
  });
  insert(database, "auction_contexts", {
    id: auctionId,
    league_id: scope.leagueId,
    season_id: scope.seasonId,
    auction_id: auctionId,
    source_kind: "fad_open_rapid",
    fad_id: scope.fadId,
    fad_rollover_id: rollover.id,
    fad_allocation_id: null,
    fad_origin: "manager_nomination",
    created_at_ms: ALLOCATION_AT_MS,
  });
  return Object.freeze({ auctionId, playerId: rapidPlayerId });
}

function seedRestrictedActionWithoutImprovement(database) {
  const restrictedPlayerId = uuid(1_922);
  const allocationId = uuid(1_923);
  const auctionId = uuid(1_924);
  const drawId = uuid(1_925);
  const playerPositionId = uuid(1_926);
  const participantOneId = uuid(1_927);
  const participantThreeId = uuid(1_928);
  const tieOffers = [
    Object.freeze({
      teamId: PRIMARY.teamOneId,
      cardId: PRIMARY.cardOneId,
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
      entryId: uuid(1_929),
      revisionId: uuid(1_930),
      requestId: uuid(1_931),
      snapshotId: uuid(1_932),
      snapshotEntryBase: 20_000,
      participantId: participantOneId,
    }),
    Object.freeze({
      teamId: PRIMARY.teamThreeId,
      cardId: PRIMARY.cardThreeId,
      userId: PRIMARY.otherManagerUserId,
      membershipId: PRIMARY.otherManagerMembershipId,
      entryId: uuid(1_933),
      revisionId: uuid(1_934),
      requestId: uuid(1_935),
      snapshotId: uuid(1_936),
      snapshotEntryBase: 20_100,
      participantId: participantThreeId,
    }),
  ];
  const candidateAddedAtMs = PREPUBLICATION_NOW_MS - 10;
  const {
    createSqliteCandidateCardRepository,
  } = require(
    "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardRepository"
  );
  const candidateRepository =
    createSqliteCandidateCardRepository({
      database,
      writeMutationSideEffects() {},
      writeHelpGrantSideEffects() {},
    });
  const runFixtureStage = (label, callback) => {
    try {
      return callback();
    } catch (error) {
      throw new Error(
        `Restricted urgency fixture failed during ${label}: ${error.message}`,
        { cause: error }
      );
    }
  };

  insert(database, "players", {
    id: restrictedPlayerId,
    first_name: "Casey",
    last_name: "Restricted",
    full_name: "Casey Restricted",
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_player_positions", {
    id: playerPositionId,
    league_id: PRIMARY.leagueId,
    player_id: restrictedPlayerId,
    position_group: "F",
    reason: "Foundation exact-tie fixture",
    corrected_by_user_id: PRIMARY.commissionerUserId,
    effective_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });

  for (const offer of tieOffers) {
    runFixtureStage(`Candidate offer for ${offer.teamId}`, () =>
      candidateRepository.mutate({
      scope: {
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        cardId: offer.cardId,
        teamId: offer.teamId,
      },
      actor: {
        userId: offer.userId,
        membershipId: offer.membershipId,
        authority: "manager",
      },
      expectedCardVersion: 1,
      nowMs: candidateAddedAtMs,
      idempotency: {
        requestId: offer.requestId,
        clientKey:
          `fad-read-restricted-tie-${offer.teamId}`,
        expiresAtMs:
          candidateAddedAtMs + FREE_AGENT_DRAFT_DAY_MS,
      },
      revisionId: offer.revisionId,
      action: {
        type: "add",
        entryId: offer.entryId,
        playerId: restrictedPlayerId,
        slotKey: "F01",
        totalValueCents: 600,
        aavCents: 300,
        termYears: 2,
      },
      })
    );
  }

  runFixtureStage("deadline lock", () =>
    moveDraftToDeadlineLocked(database)
  );

  for (const offer of tieOffers) {
    runFixtureStage(`snapshot for ${offer.teamId}`, () => {
    const card = database
      .prepare(`
        SELECT *
        FROM candidate_cards
        WHERE league_id = ?
          AND id = ?
      `)
      .get(PRIMARY.leagueId, offer.cardId);
    const entry = database
      .prepare(`
        SELECT *
        FROM candidate_card_entries
        WHERE league_id = ?
          AND card_id = ?
          AND id = ?
      `)
      .get(PRIMARY.leagueId, offer.cardId, offer.entryId);
    insert(database, "candidate_card_snapshots", {
      id: offer.snapshotId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      card_id: offer.cardId,
      team_id: offer.teamId,
      locked_card_version: card.version,
      locked_status: card.status,
      completeness_code: card.completeness_code,
      filled_mandatory_count:
        card.filled_mandatory_count,
      missing_mandatory_count:
        card.missing_mandatory_count,
      filled_bench_count: card.filled_bench_count,
      empty_bench_count: card.empty_bench_count,
      blocking_validation_count:
        card.blocking_validation_count,
      structural_conflict_count:
        card.structural_conflict_count,
      cap_limit_cents: 100_000,
      carried_active_player_amount_cents: 0,
      retention_obligation_cents: 0,
      buyout_penalty_cents: 0,
      carried_cap_usage_cents: 0,
      proposed_candidate_aav_cents:
        entry.proposed_aav_cents,
      maximum_possible_cap_cents:
        card.maximum_possible_cap_cents,
      maximum_cap_space_cents:
        100_000 - card.maximum_possible_cap_cents,
      effective_deadline_at_ms: PUBLICATION_AT_MS,
      processed_at_ms: PUBLICATION_AT_MS,
      created_at_ms: PUBLICATION_AT_MS,
      carried_roster_structural_conflict_count:
        card.carried_roster_structural_conflict_count,
      cap_status: card.cap_status,
      allocation_eligibility:
        card.allocation_eligibility,
      allocation_exclusion_reason:
        card.allocation_exclusion_reason,
    });

    const slots = [
      ...Array.from({ length: 12 }, (_, index) => [
        "F",
        index + 1,
      ]),
      ...Array.from({ length: 6 }, (_, index) => [
        "D",
        index + 1,
      ]),
      ...Array.from({ length: 4 }, (_, index) => [
        "B",
        index + 1,
      ]),
    ];
    for (const [index, [slotGroup, slotNumber]] of
      slots.entries()) {
      const isCandidate =
        slotGroup === "F" && slotNumber === 1;
      insert(database, "candidate_card_snapshot_entries", {
        id: uuid(offer.snapshotEntryBase + index),
        league_id: PRIMARY.leagueId,
        season_id: PRIMARY.seasonId,
        fad_id: PRIMARY.fadId,
        snapshot_id: offer.snapshotId,
        card_id: offer.cardId,
        team_id: offer.teamId,
        row_kind: "slot",
        occupant_kind: isCandidate ? "candidate" : "empty",
        slot_group: slotGroup,
        slot_number: slotNumber,
        source_entry_id: isCandidate ? entry.id : null,
        source_entry_version: isCandidate
          ? entry.version
          : null,
        player_id: isCandidate ? entry.player_id : null,
        effective_position_group: isCandidate
          ? entry.effective_position_group
          : null,
        conflict_code: null,
        carryover_ownership_id: null,
        carryover_contract_id: null,
        source_roster_category: null,
        carryover_original_total_value_cents: null,
        carryover_original_term_years: null,
        carryover_aav_cents: null,
        remaining_years: null,
        proposed_total_value_cents: isCandidate
          ? entry.proposed_total_value_cents
          : null,
        proposed_term_years: isCandidate
          ? entry.proposed_term_years
          : null,
        proposed_aav_cents: isCandidate
          ? entry.proposed_aav_cents
          : null,
        eligibility_status: isCandidate
          ? entry.eligibility_status
          : null,
        validation_code: isCandidate
          ? entry.validation_code
          : null,
        last_edited_by_user_id: isCandidate
          ? entry.last_edited_by_user_id
          : null,
        last_edited_by_membership_id: isCandidate
          ? entry.last_edited_by_membership_id
          : null,
        last_edited_by_authority: isCandidate
          ? entry.last_edited_by_authority
          : null,
        last_edited_at_ms: isCandidate
          ? entry.updated_at_ms
          : null,
        created_at_ms: PUBLICATION_AT_MS,
        allocation_eligibility: isCandidate
          ? card.allocation_eligibility
          : null,
        allocation_exclusion_reason: isCandidate
          ? card.allocation_exclusion_reason
          : null,
      });
    }
    });
  }

  runFixtureStage("pending allocation", () =>
    insert(database, "free_agent_draft_player_allocations", {
    id: allocationId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    player_id: restrictedPlayerId,
    status: "pending",
    decision_code: null,
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: null,
    restricted_minimum_term_years: null,
    restricted_minimum_aav_cents: null,
    accounted_at_ms: null,
    last_error_code: null,
    created_at_ms: PUBLICATION_AT_MS,
    updated_at_ms: PUBLICATION_AT_MS,
    version: 1,
    })
  );

  runFixtureStage("rapid activation", () =>
    moveDraftToRapid(database)
  );
  const rollover = database
    .prepare(`
      SELECT id, rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = ?
        AND fad_id = ?
        AND sequence = 1
    `)
    .get(PRIMARY.leagueId, PRIMARY.fadId);
  runFixtureStage("restricted auction", () =>
    insert(database, "auctions", {
    id: auctionId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    player_id: restrictedPlayerId,
    status: "open",
    opened_at_ms: ALLOCATION_AT_MS,
    resolves_at_ms: rollover.rolls_over_at_ms,
    opened_by_user_id: PRIMARY.managerUserId,
    created_at_ms: ALLOCATION_AT_MS,
    updated_at_ms: ALLOCATION_AT_MS,
    version: 1,
    })
  );
  runFixtureStage("restricted allocation transition", () =>
    database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'restricted_active',
          decision_code = 'exact_total_and_term_tie',
          restricted_auction_id = @auctionId,
          restricted_minimum_total_cents = 600,
          restricted_minimum_term_years = 2,
          restricted_minimum_aav_cents = 300,
          updated_at_ms = @allocationAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @allocationId
    `)
    .run({
      allocationId,
      allocationAtMs: ALLOCATION_AT_MS,
      auctionId,
      leagueId: PRIMARY.leagueId,
    })
  );
  runFixtureStage("restricted auction context", () =>
    insert(database, "auction_contexts", {
    id: auctionId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    auction_id: auctionId,
    source_kind: "fad_restricted",
    fad_id: PRIMARY.fadId,
    fad_rollover_id: rollover.id,
    fad_allocation_id: allocationId,
    fad_origin: "candidate_tie_restricted",
    created_at_ms: ALLOCATION_AT_MS,
    })
  );
  const drawNonce = Buffer.alloc(32, 0x2a);
  const drawCommitment = fadDrawCommitment(
    auctionId,
    drawNonce
  );
  runFixtureStage("restricted draw commitment", () =>
    insert(database, "free_agent_draft_draws", {
      id: drawId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      allocation_id: allocationId,
      auction_id: auctionId,
      algorithm_version: 1,
      nonce_bytes: drawNonce,
      commitment_hex: drawCommitment,
      ordered_tied_bid_ids_json: null,
      ordered_tied_team_ids_json: null,
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: null,
      created_at_ms: ALLOCATION_AT_MS,
      updated_at_ms: ALLOCATION_AT_MS,
      version: 1,
    })
  );

  for (const offer of tieOffers) {
    runFixtureStage(`restricted participant ${offer.teamId}`, () =>
      insert(database, "free_agent_draft_auction_participants", {
      id: offer.participantId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      allocation_id: allocationId,
      auction_id: auctionId,
      team_id: offer.teamId,
      status: "active",
      source_snapshot_entry_id: uuid(
        offer.snapshotEntryBase
      ),
      originating_candidate_revision_id: offer.revisionId,
      minimum_total_value_cents: 600,
      minimum_term_years: 2,
      minimum_aav_cents: 300,
      active_improvement_bid_id: null,
      manager_edit_limit: 1,
      cooldown_duration_ms: 4_500_000,
      first_improvement_at_ms: null,
      current_cooldown_anchor_at_ms: null,
      improvement_committed_at_ms: null,
      originating_actor_user_id: offer.userId,
      originating_actor_membership_id: offer.membershipId,
      originating_actor_authority: "manager",
      removed_by_user_id: null,
      removed_by_membership_id: null,
      removed_authority: null,
      removal_reason: null,
      removed_at_ms: null,
      created_at_ms: ALLOCATION_AT_MS,
      updated_at_ms: ALLOCATION_AT_MS,
      version: 1,
      })
    );
  }
  const allocationEventBase = {
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    allocation_id: allocationId,
    allocation_version: 2,
    player_id: restrictedPlayerId,
    resulting_allocation_status: "restricted_active",
    contract_id: null,
    ownership_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: ALLOCATION_AT_MS,
    created_at_ms: ALLOCATION_AT_MS,
    version: 1,
  };
  for (const [index, offer] of tieOffers.entries()) {
    runFixtureStage(
      `restricted offer event ${offer.teamId}`,
      () =>
        insert(
          database,
          "free_agent_draft_allocation_events",
          {
            ...allocationEventBase,
            id: uuid(1_941 + index),
            event_kind: "offer_considered",
            snapshot_entry_id: uuid(
              offer.snapshotEntryBase
            ),
            team_id: offer.teamId,
            offer_valid: 1,
            rank_position: 1,
            offer_outcome_code: "restricted_tied",
            decision_code: null,
            auction_id: null,
          }
        )
    );
  }
  runFixtureStage("restricted state event", () =>
    insert(
      database,
      "free_agent_draft_allocation_events",
      {
        ...allocationEventBase,
        id: uuid(1_943),
        event_kind: "restricted_state_changed",
        snapshot_entry_id: null,
        team_id: null,
        offer_valid: null,
        rank_position: null,
        offer_outcome_code: null,
        decision_code: "exact_total_and_term_tie",
        auction_id: auctionId,
      }
    )
  );
  return Object.freeze({
    allocationId,
    auctionId,
    drawCommitment,
    drawId,
    participantIds: Object.freeze(
      tieOffers.map(({ participantId }) => participantId)
    ),
    restrictedPlayerId,
    snapshotEntryIds: Object.freeze(
      tieOffers.map(({ snapshotEntryBase }) =>
        uuid(snapshotEntryBase)
      )
    ),
  });
}

function terminalizeRestrictedDrawForRead(
  database,
  fixture
) {
  // The auction-resolution writer is outside this read-only foundation. This
  // fixture bypasses only the terminal transition guards and writes a
  // structurally complete correction state for projection verification.
  for (const tableName of [
    "auctions",
    "auction_resolutions",
    "free_agent_draft_draws",
    "free_agent_draft_player_allocations",
    "free_agent_draft_allocation_events",
  ]) {
    dropTableTriggers(database, tableName);
  }
  const terminalAtMs = ALLOCATION_AT_MS + 1;
  database
    .prepare(`
      UPDATE auctions
      SET status = 'no_winner',
          updated_at_ms = @terminalAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @auctionId
    `)
    .run({
      auctionId: fixture.auctionId,
      leagueId: PRIMARY.leagueId,
      terminalAtMs,
    });
  insert(database, "auction_resolutions", {
    id: uuid(1_950),
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    auction_id: fixture.auctionId,
    scheduled_occurrence_key:
      `fad-read-terminal:${fixture.auctionId}`,
    outcome_code: "no_winner",
    winning_team_id: null,
    winning_bid_id: null,
    highest_bid_cents: null,
    second_price_input_cents: null,
    final_contract_value_cents: null,
    winning_term_years: null,
    final_aav_cents: null,
    general_illegal: 0,
    warnings_json: "[]",
    contract_id: null,
    ownership_id: null,
    trigger_type: "automatic",
    triggered_by_user_id: null,
    idempotency_key:
      `fad-read-terminal-${fixture.auctionId}`,
    status: "no_winner",
    resolved_at_ms: terminalAtMs,
  });
  database
    .prepare(`
      UPDATE free_agent_draft_draws
      SET ordered_tied_bid_ids_json = '[]',
          ordered_tied_team_ids_json = '[]',
          rejection_counter = NULL,
          selected_index = NULL,
          selected_bid_id = NULL,
          selected_team_id = NULL,
          selected_digest_hex = NULL,
          revealed_at_ms = @terminalAtMs,
          updated_at_ms = @terminalAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @drawId
    `)
    .run({
      drawId: fixture.drawId,
      leagueId: PRIMARY.leagueId,
      terminalAtMs,
    });
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = 'correction_required',
          last_error_code = 'FALLBACK_ACTIVATION_FAILED',
          updated_at_ms = @terminalAtMs,
          version = 3
      WHERE league_id = @leagueId
        AND id = @allocationId
    `)
    .run({
      allocationId: fixture.allocationId,
      leagueId: PRIMARY.leagueId,
      terminalAtMs,
    });
  database
    .prepare(`
      UPDATE free_agent_draft_allocation_events
      SET allocation_version = 3,
          resulting_allocation_status =
            'correction_required'
      WHERE league_id = @leagueId
        AND allocation_id = @allocationId
        AND allocation_version = 2
    `)
    .run({
      allocationId: fixture.allocationId,
      leagueId: PRIMARY.leagueId,
    });
  return Object.freeze({ terminalAtMs });
}

function seedPublishedPendingResults(database) {
  openDraft(database, PRIMARY);
  const {
    createSqliteCandidateCardRepository,
  } = require(
    "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardRepository"
  );
  const candidateRepository =
    createSqliteCandidateCardRepository({
      database,
      writeMutationSideEffects() {},
      writeHelpGrantSideEffects() {},
    });
  const players = Object.freeze({
    amy: Object.freeze({
      playerId: uuid(21_000),
      fullName: "Amy Candidate",
      positionGroup: "D",
      positionId: uuid(21_001),
      allocationId: uuid(21_002),
    }),
    zed: Object.freeze({
      playerId: uuid(21_010),
      fullName: "Zed Candidate",
      positionGroup: "F",
      positionId: uuid(21_011),
      allocationId: uuid(21_012),
    }),
  });
  for (const player of Object.values(players)) {
    const [firstName, lastName] =
      player.fullName.split(" ");
    insert(database, "players", {
      id: player.playerId,
      first_name: firstName,
      last_name: lastName,
      full_name: player.fullName,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_player_positions", {
      id: player.positionId,
      league_id: PRIMARY.leagueId,
      player_id: player.playerId,
      position_group: player.positionGroup,
      reason: "Published-read foundation fixture",
      corrected_by_user_id:
        PRIMARY.commissionerUserId,
      effective_at_ms: 1,
      ended_at_ms: null,
      version: 1,
    });
  }

  const offers = [
    {
      teamId: PRIMARY.teamOneId,
      cardId: PRIMARY.cardOneId,
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
      player: players.zed,
      slotKey: "F01",
      totalValueCents: 900,
      termYears: 3,
      entryId: uuid(21_100),
      revisionId: uuid(21_101),
      requestId: uuid(21_102),
      snapshotId: uuid(21_103),
      snapshotEntryBase: 22_000,
    },
    {
      teamId: PRIMARY.teamTwoId,
      cardId: PRIMARY.cardTwoId,
      userId: PRIMARY.managerUserId,
      membershipId: PRIMARY.managerMembershipId,
      player: players.amy,
      slotKey: "D01",
      totalValueCents: 400,
      termYears: 2,
      entryId: uuid(21_110),
      revisionId: uuid(21_111),
      requestId: uuid(21_112),
      snapshotId: uuid(21_113),
      snapshotEntryBase: 22_100,
    },
    {
      teamId: PRIMARY.teamThreeId,
      cardId: PRIMARY.cardThreeId,
      userId: PRIMARY.otherManagerUserId,
      membershipId:
        PRIMARY.otherManagerMembershipId,
      player: players.zed,
      slotKey: "F01",
      totalValueCents: 600,
      termYears: 2,
      entryId: uuid(21_120),
      revisionId: uuid(21_121),
      requestId: uuid(21_122),
      snapshotId: uuid(21_123),
      snapshotEntryBase: 22_200,
    },
  ];
  const candidateAddedAtMs =
    PREPUBLICATION_NOW_MS - 10;
  for (const offer of offers) {
    candidateRepository.mutate({
      scope: {
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        cardId: offer.cardId,
        teamId: offer.teamId,
      },
      actor: {
        userId: offer.userId,
        membershipId: offer.membershipId,
        authority: "manager",
      },
      expectedCardVersion: 1,
      nowMs: candidateAddedAtMs,
      idempotency: {
        requestId: offer.requestId,
        clientKey:
          `fad-published-read-${offer.teamId}`,
        expiresAtMs:
          candidateAddedAtMs + FREE_AGENT_DRAFT_DAY_MS,
      },
      revisionId: offer.revisionId,
      action: {
        type: "add",
        entryId: offer.entryId,
        playerId: offer.player.playerId,
        slotKey: offer.slotKey,
        totalValueCents: offer.totalValueCents,
        aavCents:
          offer.totalValueCents / offer.termYears,
        termYears: offer.termYears,
      },
    });
  }

  moveDraftToDeadlineLocked(database);
  const slotCoordinates = [
    ...Array.from({ length: 12 }, (_, index) => [
      "F",
      index + 1,
    ]),
    ...Array.from({ length: 6 }, (_, index) => [
      "D",
      index + 1,
    ]),
    ...Array.from({ length: 4 }, (_, index) => [
      "B",
      index + 1,
    ]),
  ];
  for (const offer of offers) {
    const card = database
      .prepare(`
        SELECT *
        FROM candidate_cards
        WHERE league_id = ?
          AND id = ?
      `)
      .get(PRIMARY.leagueId, offer.cardId);
    const entry = database
      .prepare(`
        SELECT *
        FROM candidate_card_entries
        WHERE league_id = ?
          AND card_id = ?
          AND id = ?
      `)
      .get(
        PRIMARY.leagueId,
        offer.cardId,
        offer.entryId
      );
    insert(database, "candidate_card_snapshots", {
      id: offer.snapshotId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      card_id: offer.cardId,
      team_id: offer.teamId,
      locked_card_version: card.version,
      locked_status: card.status,
      completeness_code: card.completeness_code,
      filled_mandatory_count:
        card.filled_mandatory_count,
      missing_mandatory_count:
        card.missing_mandatory_count,
      filled_bench_count: card.filled_bench_count,
      empty_bench_count: card.empty_bench_count,
      blocking_validation_count:
        card.blocking_validation_count,
      structural_conflict_count:
        card.structural_conflict_count,
      cap_limit_cents: 100_000,
      carried_active_player_amount_cents: 0,
      retention_obligation_cents: 0,
      buyout_penalty_cents: 0,
      carried_cap_usage_cents: 0,
      proposed_candidate_aav_cents:
        entry.proposed_aav_cents,
      maximum_possible_cap_cents:
        card.maximum_possible_cap_cents,
      maximum_cap_space_cents:
        100_000 - card.maximum_possible_cap_cents,
      effective_deadline_at_ms: PUBLICATION_AT_MS,
      processed_at_ms: PUBLICATION_AT_MS,
      created_at_ms: PUBLICATION_AT_MS,
      carried_roster_structural_conflict_count:
        card.carried_roster_structural_conflict_count,
      cap_status: card.cap_status,
      allocation_eligibility:
        card.allocation_eligibility,
      allocation_exclusion_reason:
        card.allocation_exclusion_reason,
    });
    const [candidateGroup, candidateNumberText] =
      /^([FDB])(\d{2})$/.exec(offer.slotKey).slice(1);
    const candidateNumber = Number(candidateNumberText);
    for (const [index, [slotGroup, slotNumber]] of
      slotCoordinates.entries()) {
      const isCandidate =
        slotGroup === candidateGroup &&
        slotNumber === candidateNumber;
      const snapshotEntryId = uuid(
        offer.snapshotEntryBase + index
      );
      if (isCandidate) {
        offer.snapshotEntryId = snapshotEntryId;
      }
      insert(
        database,
        "candidate_card_snapshot_entries",
        {
          id: snapshotEntryId,
          league_id: PRIMARY.leagueId,
          season_id: PRIMARY.seasonId,
          fad_id: PRIMARY.fadId,
          snapshot_id: offer.snapshotId,
          card_id: offer.cardId,
          team_id: offer.teamId,
          row_kind: "slot",
          occupant_kind: isCandidate
            ? "candidate"
            : "empty",
          slot_group: slotGroup,
          slot_number: slotNumber,
          source_entry_id: isCandidate
            ? entry.id
            : null,
          source_entry_version: isCandidate
            ? entry.version
            : null,
          player_id: isCandidate
            ? entry.player_id
            : null,
          effective_position_group: isCandidate
            ? entry.effective_position_group
            : null,
          conflict_code: null,
          carryover_ownership_id: null,
          carryover_contract_id: null,
          source_roster_category: null,
          carryover_original_total_value_cents: null,
          carryover_original_term_years: null,
          carryover_aav_cents: null,
          remaining_years: null,
          proposed_total_value_cents: isCandidate
            ? entry.proposed_total_value_cents
            : null,
          proposed_term_years: isCandidate
            ? entry.proposed_term_years
            : null,
          proposed_aav_cents: isCandidate
            ? entry.proposed_aav_cents
            : null,
          eligibility_status: isCandidate
            ? entry.eligibility_status
            : null,
          validation_code: isCandidate
            ? entry.validation_code
            : null,
          last_edited_by_user_id: isCandidate
            ? entry.last_edited_by_user_id
            : null,
          last_edited_by_membership_id: isCandidate
            ? entry.last_edited_by_membership_id
            : null,
          last_edited_by_authority: isCandidate
            ? entry.last_edited_by_authority
            : null,
          last_edited_at_ms: isCandidate
            ? entry.updated_at_ms
            : null,
          created_at_ms: PUBLICATION_AT_MS,
          allocation_eligibility: isCandidate
            ? card.allocation_eligibility
            : null,
          allocation_exclusion_reason: isCandidate
            ? card.allocation_exclusion_reason
            : null,
        }
      );
    }
  }

  for (const player of Object.values(players)) {
    insert(
      database,
      "free_agent_draft_player_allocations",
      {
        id: player.allocationId,
        league_id: PRIMARY.leagueId,
        season_id: PRIMARY.seasonId,
        fad_id: PRIMARY.fadId,
        player_id: player.playerId,
        status: "pending",
        decision_code: null,
        winning_snapshot_entry_id: null,
        winning_team_id: null,
        contract_id: null,
        ownership_id: null,
        restricted_auction_id: null,
        fallback_open_auction_id: null,
        restricted_minimum_total_cents: null,
        restricted_minimum_term_years: null,
        restricted_minimum_aav_cents: null,
        accounted_at_ms: null,
        last_error_code: null,
        created_at_ms: PUBLICATION_AT_MS,
        updated_at_ms: PUBLICATION_AT_MS,
        version: 1,
      }
    );
  }
  return Object.freeze({
    offers: Object.freeze(
      offers.map((offer) => Object.freeze(offer))
    ),
    players,
  });
}

function moveDraftToCompleted(database, scope = PRIMARY) {
  if (
    database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND tbl_name = 'free_agent_drafts'
      `)
      .get().count > 0
  ) {
    dropTableTriggers(database, "free_agent_drafts");
  }
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'completed',
          deadline_locked_at_ms = @deadlineLockedAtMs,
          allocation_completed_at_ms = @allocationCompletedAtMs,
          completed_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs,
          version = 5
      WHERE league_id = @leagueId
        AND id = @fadId
    `)
    .run({
      allocationCompletedAtMs: ALLOCATION_AT_MS,
      completedAtMs: COMPLETION_AT_MS,
      deadlineLockedAtMs: PUBLICATION_AT_MS,
      fadId: scope.fadId,
      leagueId: scope.leagueId,
    });
  database
    .prepare(`
      UPDATE seasons
      SET free_agent_draft_completed_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
    `)
    .run({
      completedAtMs: COMPLETION_AT_MS,
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
    });
}

function seedActionableRecovery(database) {
  dropTableTriggers(database, "free_agent_draft_recoveries");
  insert(database, "free_agent_draft_recoveries", {
    id: uuid(1_350),
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    player_id: null,
    allocation_id: null,
    rollover_id: null,
    auction_id: null,
    job_run_id: null,
    kind: "deadline_retry",
    status: "ready",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "FAD_DEADLINE_RETRY_REQUIRED",
    commissioner_reason: null,
    created_by_operation_id: "foundation-read-recovery",
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: PREPUBLICATION_NOW_MS,
    updated_at_ms: PREPUBLICATION_NOW_MS,
    resolved_at_ms: null,
    version: 1,
  });
}

function seedScheduleRecovery(
  database,
  { recoveryKind, attachToDraft }
) {
  const completion = recoveryKind === "completion";
  const recoveryId = uuid(completion ? 1_500 : 1_400);
  const operationId = uuid(completion ? 1_501 : 1_401);
  const weekId = uuid(completion ? 1_502 : 1_402);
  const startsAtMs =
    WEEK_ONE_AT_MS + FREE_AGENT_DRAFT_DAY_MS * 7;
  if (completion) {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(`
        DELETE FROM matchup_weeks
        WHERE league_id = ?
          AND id = ?
      `)
      .run(PRIMARY.leagueId, PRIMARY.weekOneId);
  }
  insert(database, "matchup_weeks", {
    id: weekId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    week_key: completion
      ? "2026-RECOVERY-COMPLETION"
      : "2026-RECOVERY-PREOPEN",
    sequence: completion ? 1 : 2,
    starts_at_ms: startsAtMs,
    baseline_at_ms: startsAtMs + 60 * 60 * 1_000,
    locks_at_ms: startsAtMs + 16 * 60 * 60 * 1_000,
    ends_at_ms:
      startsAtMs + 7 * FREE_AGENT_DRAFT_DAY_MS,
    rolls_over_at_ms:
      startsAtMs + 7 * FREE_AGENT_DRAFT_DAY_MS,
    status: "scheduled",
    created_at_ms: COMPLETION_AT_MS,
    updated_at_ms: COMPLETION_AT_MS,
    version: 1,
  });
  insert(database, "matchup_operations", {
    id: operationId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: PRIMARY.commissionerUserId,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: null,
    started_at_ms: COMPLETION_AT_MS - 1,
    completed_at_ms: COMPLETION_AT_MS,
  });
  if (completion) {
    assert.equal(
      database
        .prepare(`
          UPDATE season_matchup_schedule_generations
          SET status = 'superseded',
              superseded_at_ms = @completedAtMs,
              version = version + 1
          WHERE league_id = @leagueId
            AND season_id = @seasonId
            AND schedule_operation_id = @operationId
            AND schedule_version = 1
            AND status = 'current'
            AND version = 1
        `)
        .run({
          completedAtMs: COMPLETION_AT_MS,
          leagueId: PRIMARY.leagueId,
          operationId: PRIMARY.scheduleOperationId,
          seasonId: PRIMARY.seasonId,
        }).changes,
      1
    );
  } else {
    dropTableTriggers(
      database,
      "season_matchup_schedule_generations"
    );
  }
  insert(database, "season_matchup_schedule_generations", {
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    schedule_version: 2,
    schedule_operation_id: operationId,
    week_one_matchup_week_id: weekId,
    week_one_starts_at_ms: startsAtMs,
    status: completion ? "current" : "superseded",
    created_at_ms: COMPLETION_AT_MS,
    superseded_at_ms: completion
      ? null
      : COMPLETION_AT_MS,
    version: completion ? 1 : 2,
  });
  dropTableTriggers(
    database,
    "free_agent_draft_schedule_recoveries"
  );
  insert(database, "free_agent_draft_schedule_recoveries", {
    id: recoveryId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    fad_id: PRIMARY.fadId,
    recovery_kind: recoveryKind,
    matchup_operation_id: operationId,
    old_schedule_operation_id:
      PRIMARY.scheduleOperationId,
    new_schedule_operation_id: operationId,
    old_first_matchup_week_id: PRIMARY.weekOneId,
    new_first_matchup_week_id: weekId,
    old_schedule_version: 1,
    new_schedule_version: 2,
    old_week_one_starts_at_ms: WEEK_ONE_AT_MS,
    new_week_one_starts_at_ms: startsAtMs,
    removed_week_count: 1,
    removed_matchup_count: 0,
    replaced_job_count: 0,
    cancelled_job_count: 0,
    completed_at_ms: COMPLETION_AT_MS,
    evidence_schema_version: 1,
    evidence_sha256: completion
      ? "c".repeat(64)
      : "b".repeat(64),
    created_at_ms: COMPLETION_AT_MS,
    version: 1,
  });
  if (attachToDraft) {
    database
      .prepare(`
        UPDATE free_agent_drafts
        SET current_competition_first_matchup_week_id = @weekId,
            schedule_recovery_id = @recoveryId,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @fadId
      `)
      .run({
        fadId: PRIMARY.fadId,
        leagueId: PRIMARY.leagueId,
        recoveryId,
        weekId,
      });
  }
  if (completion) {
    database.exec("COMMIT");
  }
  return Object.freeze({
    operationId,
    recoveryId,
    startsAtMs,
    weekId,
  });
}

function seedCarryoverSentinel(
  database,
  scope,
  { base, fullName, totalValueCents }
) {
  const [firstName, ...lastParts] = fullName.split(" ");
  const playerId = uuid(base);
  const sourceId = uuid(base + 1);
  const positionId = uuid(base + 2);
  const contractId = uuid(base + 3);
  const contractYearId = uuid(base + 4);
  const ownershipId = uuid(base + 5);
  const commissionerUserId =
    scope === PRIMARY
      ? PRIMARY.commissionerUserId
      : SECONDARY.commissionerUserId;
  insert(database, "players", {
    id: playerId,
    first_name: firstName,
    last_name: lastParts.join(" "),
    full_name: fullName,
    birth_date: null,
    status: "active",
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: sourceId,
    player_id: playerId,
    provider: "sportsdataio-discovery-lab",
    source_position: "D",
    normalized_position: "D",
    nhl_team_abbreviation:
      scope === PRIMARY ? "VAN" : "EDM",
    active: 1,
    source_version:
      scope === PRIMARY
        ? "primary-carryover-v1"
        : "secondary-carryover-v1",
    source_payload_json: null,
    effective_at_ms: 2,
    ended_at_ms: null,
    created_at_ms: 2,
  });
  insert(database, "league_player_positions", {
    id: positionId,
    league_id: scope.leagueId,
    player_id: playerId,
    position_group: "D",
    reason: `${fullName} carryover sentinel`,
    corrected_by_user_id: commissionerUserId,
    effective_at_ms: 2,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "contracts", {
    id: contractId,
    league_id: scope.leagueId,
    player_id: playerId,
    current_team_id: scope.teamOneId,
    contract_type: "normal",
    original_total_value_cents: totalValueCents,
    original_term_years: 1,
    aav_cents: totalValueCents,
    start_season_id: scope.seasonId,
    status: "active",
    acquisition_source_type: "season_rollover",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
  });
  insert(database, "contract_years", {
    id: contractYearId,
    league_id: scope.leagueId,
    contract_id: contractId,
    season_id: scope.seasonId,
    year_number: 1,
    aav_cents: totalValueCents,
    status: "current",
    rollover_at_ms: 2,
    created_at_ms: 3,
  });
  insert(database, "player_ownerships", {
    id: ownershipId,
    league_id: scope.leagueId,
    season_id: scope.seasonId,
    player_id: playerId,
    team_id: scope.teamOneId,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "D",
    slot_number: 1,
    acquired_transaction_type: "season_rollover",
    acquired_transaction_id: null,
    created_at_ms: 3,
    updated_at_ms: 3,
    version: 1,
    trade_blocked: 0,
  });
  return Object.freeze({
    contractId,
    contractYearId,
    ownershipId,
    playerId,
    positionId,
    sourceId,
  });
}

function seedCurrentScheduleJobBinding(database) {
  const jobRunId = uuid(1_750);
  const bindingId = uuid(1_751);
  const jobType = "matchup:baseline";
  const scheduledForMs = WEEK_ONE_AT_MS + 60 * 60 * 1_000;
  insert(database, "job_runs", {
    id: jobRunId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    job_type: jobType,
    occurrence_key:
      `${jobType}:${PRIMARY.leagueId}:` +
      `${PRIMARY.seasonId}:${PRIMARY.weekOneId}:` +
      scheduledForMs,
    scheduled_for_ms: scheduledForMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: 4,
    updated_at_ms: 4,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: scheduledForMs,
  });
  insert(database, "matchup_schedule_job_bindings", {
    id: bindingId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    job_run_id: jobRunId,
    job_type: jobType,
    schedule_operation_id: PRIMARY.scheduleOperationId,
    schedule_version: 1,
    owning_matchup_week_id: PRIMARY.weekOneId,
    owning_matchup_id: null,
    created_at_ms: 4,
    version: 1,
  });
  return Object.freeze({ bindingId, jobRunId });
}

function seedSubsequentSeasonAuthority(database) {
  const ids = Object.freeze({
    priorSeasonId: uuid(1_800),
    playerId: uuid(1_801),
    playerSourceStateId: uuid(1_802),
    positionOverrideId: uuid(1_803),
    contractId: uuid(1_804),
    priorContractYearId: uuid(1_805),
    targetContractYearId: uuid(1_806),
    ownershipId: uuid(1_807),
    priorRetentionObligationId: uuid(1_808),
    priorRetentionYearId: uuid(1_809),
    targetRetentionYearId: uuid(1_810),
    priorBuyoutObligationId: uuid(1_811),
    priorBuyoutYearId: uuid(1_812),
    targetBuyoutYearId: uuid(1_813),
    rolloverId: uuid(1_820),
    rolloverItemId: uuid(1_821),
    ownershipEventId: uuid(1_822),
    bindingId: uuid(1_823),
    occurrenceId: uuid(1_824),
    attemptId: uuid(1_825),
    entryDraftId: uuid(1_826),
    firstPickClockId: uuid(1_827),
    sourceFadId: uuid(1_828),
    sourceFinalizationRootId: uuid(1_829),
    sourceFinalizationId: uuid(1_829),
    sourceStandingsSnapshotId: uuid(1_831),
    sourceStandingsOperationId: uuid(1_832),
    activityId: uuid(1_833),
    securityAuditEventId: uuid(1_834),
    outboxEventId: uuid(1_835),
    scheduledJobRunId: uuid(1_836),
    priorRetentionPlayerId: uuid(1_840),
    priorRetentionContractId: uuid(1_841),
    priorRetentionContractYearId: uuid(1_842),
    targetRetentionPlayerId: uuid(1_843),
    targetRetentionContractId: uuid(1_844),
    targetRetentionContractYearId: uuid(1_845),
    targetRetentionObligationId: uuid(1_846),
    priorBuyoutPlayerId: uuid(1_847),
    priorBuyoutContractId: uuid(1_848),
    priorBuyoutContractYearId: uuid(1_849),
    targetBuyoutPlayerId: uuid(1_850),
    targetBuyoutContractId: uuid(1_851),
    targetBuyoutContractYearId: uuid(1_852),
    targetBuyoutObligationId: uuid(1_853),
    contractEventId: uuid(1_854),
    priorBuyoutTransactionId: uuid(1_855),
    targetBuyoutTransactionId: uuid(1_856),
    contractRolloverItemId: uuid(1_857),
    sourceWeekId: uuid(1_858),
    sourceScheduleOperationId: uuid(1_859),
    sourceReadinessOperationId: uuid(1_860),
    sourceFinalizationIdempotencyId: uuid(1_861),
    sourceStandingsRowOneId: uuid(1_862),
    sourceStandingsRowTwoId: uuid(1_863),
    sourceStandingsRowThreeId: uuid(1_864),
    draftPickId: uuid(1_865),
    scheduleIdempotencyId: uuid(1_866),
    entryDraftScheduleOperationId: uuid(1_867),
    outboxAudienceId: uuid(1_868),
  });
  const rolloverAtMs = OPENED_AT_MS - FREE_AGENT_DRAFT_DAY_MS;
  const priorRegularStartsAtMs =
    WEEK_ONE_AT_MS - 365 * FREE_AGENT_DRAFT_DAY_MS;
  const priorPlayoffsStartAtMs =
    priorRegularStartsAtMs + 7 * FREE_AGENT_DRAFT_DAY_MS;
  const priorPlayoffsEndAtMs =
    priorPlayoffsStartAtMs + 14 * FREE_AGENT_DRAFT_DAY_MS;

  insert(database, "seasons", {
    id: ids.priorSeasonId,
    league_id: PRIMARY.leagueId,
    label: "2025-26",
    nhl_season_key: "0000012026",
    status: "completed",
    regular_season_starts_at_ms: priorRegularStartsAtMs,
    regular_season_ends_at_ms: priorPlayoffsEndAtMs,
    fantasy_playoffs_start_at_ms: priorPlayoffsStartAtMs,
    fantasy_playoffs_end_at_ms: priorPlayoffsEndAtMs,
    created_at_ms: 1,
    updated_at_ms: rolloverAtMs,
    version: 2,
    free_agent_draft_completed_at_ms: priorRegularStartsAtMs,
  });

  const stageParentEvidence = (tableName, write) => {
    const triggers = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
        AND sql IS NOT NULL
      ORDER BY name
    `).all(tableName);
    dropTableTriggers(database, tableName);
    try {
      write();
    } finally {
      for (const { sql } of triggers) {
        database.exec(sql);
      }
    }
  };
  const sourceWeekEndsAtMs =
    priorRegularStartsAtMs + 7 * FREE_AGENT_DRAFT_DAY_MS;
  insert(database, "matchup_weeks", {
    id: ids.sourceWeekId,
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    week_key: "2025-26-W01",
    sequence: 1,
    starts_at_ms: priorRegularStartsAtMs,
    baseline_at_ms:
      priorRegularStartsAtMs + 60 * 60 * 1_000,
    locks_at_ms:
      priorRegularStartsAtMs + 16 * 60 * 60 * 1_000,
    ends_at_ms: sourceWeekEndsAtMs,
    rolls_over_at_ms: sourceWeekEndsAtMs,
    status: "final",
    created_at_ms: 1,
    updated_at_ms: sourceWeekEndsAtMs,
    version: 1,
  });
  insert(database, "matchups", {
    id: uuid(1_869),
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    matchup_week_id: ids.sourceWeekId,
    home_team_id: PRIMARY.teamOneId,
    away_team_id: PRIMARY.teamTwoId,
    home_team_name: "Snow Owls",
    away_team_name: "Ice Bears",
    status: "final",
    created_at_ms: 1,
    updated_at_ms: sourceWeekEndsAtMs,
    version: 1,
  });
  insert(database, "matchup_byes", {
    id: uuid(1_870),
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    matchup_week_id: ids.sourceWeekId,
    team_id: PRIMARY.teamThreeId,
    team_display_name: "Night Foxes",
    created_at_ms: 1,
  });
  insert(database, "matchup_operations", {
    id: ids.sourceScheduleOperationId,
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: PRIMARY.commissionerUserId,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({
      participantCount: 3,
      participantTeamIds: [
        PRIMARY.teamOneId,
        PRIMARY.teamTwoId,
        PRIMARY.teamThreeId,
      ].sort(),
      weekCount: 1,
      matchupCount: 1,
      jobOccurrenceCount: 0,
    }),
    started_at_ms: 1,
    completed_at_ms: 1,
  });
  insert(database, "season_matchup_schedule_generations", {
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    schedule_version: 1,
    schedule_operation_id: ids.sourceScheduleOperationId,
    week_one_matchup_week_id: ids.sourceWeekId,
    week_one_starts_at_ms: priorRegularStartsAtMs,
    status: "current",
    created_at_ms: 1,
    superseded_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.sourceReadinessOperationId,
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    readiness_occurrence_key:
      `fad-readiness:${ids.priorSeasonId}`,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: null,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: null,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms:
      priorRegularStartsAtMs - 15 * FREE_AGENT_DRAFT_DAY_MS,
    updated_at_ms:
      priorRegularStartsAtMs - 15 * FREE_AGENT_DRAFT_DAY_MS,
    version: 1,
  });
  // This read-boundary fixture stages only the already-completed source FAD.
  // Its annual lifecycle is covered by the dedicated repository suite; all
  // FAD triggers are restored before rollover authority is written.
  stageParentEvidence("free_agent_drafts", () => {
    insert(database, "free_agent_drafts", {
      id: ids.sourceFadId,
      league_id: PRIMARY.leagueId,
      season_id: ids.priorSeasonId,
      readiness_operation_id: ids.sourceReadinessOperationId,
      readiness_occurrence_key:
        `fad-readiness:${ids.priorSeasonId}`,
      first_matchup_week_id: ids.sourceWeekId,
      current_competition_first_matchup_week_id:
        ids.sourceWeekId,
      schedule_recovery_id: null,
      participating_team_count: 3,
      status: "completed",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason: "Inaugural league season.",
      opening_authority: "system",
      opened_at_ms:
        priorRegularStartsAtMs - 15 * FREE_AGENT_DRAFT_DAY_MS,
      help_opens_at_ms:
        priorRegularStartsAtMs - 9 * FREE_AGENT_DRAFT_DAY_MS,
      candidate_deadline_at_ms:
        priorRegularStartsAtMs - 7 * FREE_AGENT_DRAFT_DAY_MS,
      first_matchup_starts_at_ms: priorRegularStartsAtMs,
      deadline_locked_at_ms:
        priorRegularStartsAtMs - 7 * FREE_AGENT_DRAFT_DAY_MS,
      allocation_completed_at_ms:
        priorRegularStartsAtMs - 7 * FREE_AGENT_DRAFT_DAY_MS + 1,
      completed_at_ms: priorRegularStartsAtMs,
      created_at_ms:
        priorRegularStartsAtMs - 15 * FREE_AGENT_DRAFT_DAY_MS,
      updated_at_ms: priorRegularStartsAtMs,
      version: 5,
    });
  });
  insert(database, "standings_snapshots", {
    id: ids.sourceStandingsSnapshotId,
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    snapshot_version: 1,
    source_result_version: 0,
    status: "final",
    calculated_at_ms: sourceWeekEndsAtMs,
    created_at_ms: sourceWeekEndsAtMs,
  });
  for (const [id, teamId, rank, wins, losses] of [
    [ids.sourceStandingsRowOneId, PRIMARY.teamOneId, 1, 1, 0],
    [ids.sourceStandingsRowTwoId, PRIMARY.teamTwoId, 2, 0, 1],
    [ids.sourceStandingsRowThreeId, PRIMARY.teamThreeId, 3, 0, 0],
  ]) {
    insert(database, "standings_rows", {
      id,
      league_id: PRIMARY.leagueId,
      season_id: ids.priorSeasonId,
      standings_snapshot_id: ids.sourceStandingsSnapshotId,
      team_id: teamId,
      rank,
      wins,
      losses,
      ties: 0,
      standings_points: wins * 2,
      fantasy_points_for_hundredths: wins * 500,
      fantasy_points_against_hundredths: losses * 500,
      fantasy_point_differential_hundredths:
        wins * 500 - losses * 500,
      created_at_ms: sourceWeekEndsAtMs,
    });
  }
  insert(database, "idempotency_requests", {
    id: ids.sourceFinalizationIdempotencyId,
    league_id: PRIMARY.leagueId,
    actor_user_id: PRIMARY.commissionerUserId,
    operation: STANDINGS_FINALIZATION_OPERATION,
    client_key: "subsequent-season-source-finalization",
    request_hash: "a".repeat(64),
    status: "completed",
    result_type: "standings_finalization",
    result_id: ids.sourceFinalizationId,
    created_at_ms: sourceWeekEndsAtMs,
    completed_at_ms: sourceWeekEndsAtMs,
    expires_at_ms:
      sourceWeekEndsAtMs + FREE_AGENT_DRAFT_DAY_MS,
  });
  insert(database, "standings_operations", {
    id: ids.sourceStandingsOperationId,
    league_id: PRIMARY.leagueId,
    season_id: ids.priorSeasonId,
    standings_snapshot_id: ids.sourceStandingsSnapshotId,
    actor_user_id: PRIMARY.commissionerUserId,
    actor_membership_id: PRIMARY.commissionerMembershipId,
    actor_authority: "commissioner",
    operation_type: "finalize_regular_season",
    status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({ stagedReadBoundary: true }),
    idempotency_request_id:
      ids.sourceFinalizationIdempotencyId,
    started_at_ms: sourceWeekEndsAtMs,
    completed_at_ms: sourceWeekEndsAtMs,
  });
  // Exact immutable standings provenance is staged here because reproducing
  // every historical result-version child belongs to the finalization suite.
  // The trigger is restored before the rollover root validates this parent.
  stageParentEvidence("standings_snapshot_finalizations", () => {
    insert(database, "standings_snapshot_finalizations", {
      id: ids.sourceFinalizationId,
      league_id: PRIMARY.leagueId,
      season_id: ids.priorSeasonId,
      standings_snapshot_id: ids.sourceStandingsSnapshotId,
      finalization_version: 1,
      evidence_schema_version: 1,
      status: "final",
      cause: "regular_season_completion",
      standings_rule_version: 1,
      result_set_hash: "b".repeat(64),
      result_set_hash_version: 1,
      expected_matchup_count: 1,
      finalized_matchup_count: 1,
      expected_week_count: 1,
      weeks_counted: 1,
      participant_count: 3,
      standings_row_count: 3,
      completeness_status: "complete",
      season_version_before: 1,
      season_version_after: 2,
      authorized_by_user_id: PRIMARY.commissionerUserId,
      authorized_by_membership_id:
        PRIMARY.commissionerMembershipId,
      authorized_authority: "commissioner",
      standings_operation_id: ids.sourceStandingsOperationId,
      idempotency_request_id:
        ids.sourceFinalizationIdempotencyId,
      replaces_finalization_id: null,
      superseded_by_snapshot_id: null,
      superseded_by_user_id: null,
      superseded_by_membership_id: null,
      superseded_by_authority: null,
      superseded_by_operation_id: null,
      superseded_at_ms: null,
      finalized_at_ms: sourceWeekEndsAtMs,
      created_at_ms: sourceWeekEndsAtMs,
      updated_at_ms: sourceWeekEndsAtMs,
      version: 1,
    });
  });
  insert(database, "players", {
    id: ids.playerId,
    first_name: "Season",
    last_name: "Carryover",
    full_name: "Season Carryover",
    birth_date: null,
    status: "active",
    created_at_ms: 2,
    updated_at_ms: 2,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: ids.playerSourceStateId,
    player_id: ids.playerId,
    provider: "sportsdataio-discovery-lab",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "subsequent-season-v1",
    source_payload_json: null,
    effective_at_ms: 2,
    ended_at_ms: null,
    created_at_ms: 2,
  });
  insert(database, "league_player_positions", {
    id: ids.positionOverrideId,
    league_id: PRIMARY.leagueId,
    player_id: ids.playerId,
    position_group: "F",
    reason: "Subsequent-season authority fixture.",
    corrected_by_user_id: PRIMARY.commissionerUserId,
    effective_at_ms: 2,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "contracts", {
    id: ids.contractId,
    league_id: PRIMARY.leagueId,
    player_id: ids.playerId,
    current_team_id: PRIMARY.teamOneId,
    contract_type: "normal",
    original_total_value_cents: 2_000,
    original_term_years: 2,
    aav_cents: 1_000,
    start_season_id: ids.priorSeasonId,
    status: "active",
    acquisition_source_type: "season_rollover",
    acquisition_source_id: ids.rolloverId,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: 2,
    updated_at_ms: rolloverAtMs,
    version: 2,
  });
  insert(database, "contract_years", {
    id: ids.priorContractYearId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.contractId,
    season_id: ids.priorSeasonId,
    year_number: 1,
    aav_cents: 1_000,
    status: "completed",
    rollover_at_ms: rolloverAtMs,
    created_at_ms: 2,
  });
  insert(database, "contract_years", {
    id: ids.targetContractYearId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.contractId,
    season_id: PRIMARY.seasonId,
    year_number: 2,
    aav_cents: 1_000,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: 2,
  });
  insert(database, "player_ownerships", {
    id: ids.ownershipId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    player_id: ids.playerId,
    team_id: PRIMARY.teamOneId,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "season_rollover",
    acquired_transaction_id: ids.rolloverId,
    created_at_ms: 2,
    updated_at_ms: rolloverAtMs,
    version: 2,
    trade_blocked: 0,
  });

  const seedSupportingContract = ({
    contractId,
    contractStatus,
    contractYearId,
    firstName,
    playerId,
    seasonId,
    yearStatus,
  }) => {
    insert(database, "players", {
      id: playerId,
      first_name: firstName,
      last_name: "Authority",
      full_name: `${firstName} Authority`,
      birth_date: null,
      status: "active",
      created_at_ms: 2,
      updated_at_ms: 2,
      version: 1,
    });
    insert(database, "contracts", {
      id: contractId,
      league_id: PRIMARY.leagueId,
      player_id: playerId,
      current_team_id: PRIMARY.teamOneId,
      contract_type: "normal",
      original_total_value_cents: 500,
      original_term_years: 1,
      aav_cents: 500,
      start_season_id: seasonId,
      status: contractStatus,
      acquisition_source_type:
        seasonId === ids.priorSeasonId
          ? "season_rollover"
          : "commissioner_correction",
      acquisition_source_id: null,
      auction_buyout_lock_expires_at_ms: null,
      created_at_ms:
        seasonId === ids.priorSeasonId
          ? 2
          : rolloverAtMs + 1,
      updated_at_ms:
        seasonId === ids.priorSeasonId
          ? rolloverAtMs
          : rolloverAtMs + 1,
      version: 1,
    });
    insert(database, "contract_years", {
      id: contractYearId,
      league_id: PRIMARY.leagueId,
      contract_id: contractId,
      season_id: seasonId,
      year_number: 1,
      aav_cents: 500,
      status: yearStatus,
      rollover_at_ms:
        seasonId === ids.priorSeasonId
          ? rolloverAtMs
          : null,
      created_at_ms:
        seasonId === ids.priorSeasonId
          ? 2
          : rolloverAtMs + 1,
    });
  };
  seedSupportingContract({
    contractId: ids.priorRetentionContractId,
    contractStatus: "expired",
    contractYearId: ids.priorRetentionContractYearId,
    firstName: "Prior Retention",
    playerId: ids.priorRetentionPlayerId,
    seasonId: ids.priorSeasonId,
    yearStatus: "completed",
  });
  seedSupportingContract({
    contractId: ids.targetRetentionContractId,
    contractStatus: "active",
    contractYearId: ids.targetRetentionContractYearId,
    firstName: "Target Retention",
    playerId: ids.targetRetentionPlayerId,
    seasonId: PRIMARY.seasonId,
    yearStatus: "current",
  });
  seedSupportingContract({
    contractId: ids.priorBuyoutContractId,
    contractStatus: "eliminated",
    contractYearId: ids.priorBuyoutContractYearId,
    firstName: "Prior Buyout",
    playerId: ids.priorBuyoutPlayerId,
    seasonId: ids.priorSeasonId,
    yearStatus: "eliminated",
  });
  seedSupportingContract({
    contractId: ids.targetBuyoutContractId,
    contractStatus: "eliminated",
    contractYearId: ids.targetBuyoutContractYearId,
    firstName: "Target Buyout",
    playerId: ids.targetBuyoutPlayerId,
    seasonId: PRIMARY.seasonId,
    yearStatus: "eliminated",
  });
  insert(database, "retention_obligations", {
    id: ids.priorRetentionObligationId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.priorRetentionContractId,
    player_id: ids.priorRetentionPlayerId,
    originating_team_id: PRIMARY.teamOneId,
    responsible_team_id: PRIMARY.teamTwoId,
    retained_aav_cents: 250,
    creation_trade_id: null,
    status: "completed",
    created_at_ms: 2,
    updated_at_ms: rolloverAtMs,
    version: 2,
  });
  insert(database, "retention_years", {
    id: ids.priorRetentionYearId,
    league_id: PRIMARY.leagueId,
    retention_obligation_id:
      ids.priorRetentionObligationId,
    season_id: ids.priorSeasonId,
    retained_aav_cents: 250,
    status: "completed",
    created_at_ms: 2,
  });
  insert(database, "retention_obligations", {
    id: ids.targetRetentionObligationId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.targetRetentionContractId,
    player_id: ids.targetRetentionPlayerId,
    originating_team_id: PRIMARY.teamOneId,
    responsible_team_id: PRIMARY.teamThreeId,
    retained_aav_cents: 275,
    creation_trade_id: null,
    status: "active",
    created_at_ms: rolloverAtMs + 1,
    updated_at_ms: rolloverAtMs + 1,
    version: 1,
  });
  insert(database, "retention_years", {
    id: ids.targetRetentionYearId,
    league_id: PRIMARY.leagueId,
    retention_obligation_id:
      ids.targetRetentionObligationId,
    season_id: PRIMARY.seasonId,
    retained_aav_cents: 275,
    status: "current",
    created_at_ms: rolloverAtMs + 1,
  });
  insert(database, "buyout_obligations", {
    id: ids.priorBuyoutObligationId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.priorBuyoutContractId,
    player_id: ids.priorBuyoutPlayerId,
    originating_team_id: PRIMARY.teamOneId,
    responsible_team_id: PRIMARY.teamTwoId,
    annual_penalty_basis_cents: 125,
    buyout_transaction_id:
      ids.priorBuyoutTransactionId,
    status: "completed",
    created_at_ms: 2,
    updated_at_ms: rolloverAtMs,
    version: 2,
  });
  insert(database, "buyout_years", {
    id: ids.priorBuyoutYearId,
    league_id: PRIMARY.leagueId,
    buyout_obligation_id: ids.priorBuyoutObligationId,
    season_id: ids.priorSeasonId,
    penalty_cents: 125,
    status: "completed",
    created_at_ms: 2,
  });
  insert(database, "buyout_obligations", {
    id: ids.targetBuyoutObligationId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.targetBuyoutContractId,
    player_id: ids.targetBuyoutPlayerId,
    originating_team_id: PRIMARY.teamOneId,
    responsible_team_id: PRIMARY.teamThreeId,
    annual_penalty_basis_cents: 150,
    buyout_transaction_id:
      ids.targetBuyoutTransactionId,
    status: "active",
    created_at_ms: rolloverAtMs + 1,
    updated_at_ms: rolloverAtMs + 1,
    version: 1,
  });
  insert(database, "buyout_years", {
    id: ids.targetBuyoutYearId,
    league_id: PRIMARY.leagueId,
    buyout_obligation_id: ids.targetBuyoutObligationId,
    season_id: PRIMARY.seasonId,
    penalty_cents: 150,
    status: "current",
    created_at_ms: rolloverAtMs + 1,
  });

  const ownershipBefore = Object.freeze({
    exists: true,
    id: ids.ownershipId,
    playerId: ids.playerId,
    seasonId: ids.priorSeasonId,
    teamId: PRIMARY.teamOneId,
    version: 1,
  });
  const ownershipAfter = Object.freeze({
    exists: true,
    id: ids.ownershipId,
    playerId: ids.playerId,
    seasonId: PRIMARY.seasonId,
    teamId: PRIMARY.teamOneId,
    updatedAtMs: rolloverAtMs,
    version: 2,
  });
  insert(database, "ownership_events", {
    id: ids.ownershipEventId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    player_id: ids.playerId,
    team_id: PRIMARY.teamOneId,
    ownership_id: ids.ownershipId,
    event_type: "ownership_carried_to_season",
    actor_user_id: null,
    source_type: "season_rollover",
    source_id: ids.rolloverId,
    before_metadata_json:
      serializeCanonicalJsonV1(ownershipBefore),
    after_metadata_json:
      serializeCanonicalJsonV1(ownershipAfter),
    reason: "season_rollover",
    occurred_at_ms: rolloverAtMs,
  });
  const contractBefore = Object.freeze({
    currentTeamId: PRIMARY.teamOneId,
    id: ids.contractId,
    version: 1,
  });
  const contractAfter = Object.freeze({
    currentTeamId: PRIMARY.teamOneId,
    id: ids.contractId,
    updatedAtMs: rolloverAtMs,
    version: 2,
  });
  insert(database, "contract_events", {
    id: ids.contractEventId,
    league_id: PRIMARY.leagueId,
    contract_id: ids.contractId,
    player_id: ids.playerId,
    team_id: PRIMARY.teamOneId,
    actor_user_id: null,
    event_type: "contract_advanced_to_season",
    source_type: "season_rollover",
    source_id: ids.rolloverId,
    metadata_json: serializeCanonicalJsonV1({
      after: contractAfter,
      before: contractBefore,
    }),
    reason: "season_rollover",
    occurred_at_ms: rolloverAtMs,
  });
  const scheduledAtMs =
    rolloverAtMs - FREE_AGENT_DRAFT_DAY_MS;
  insert(database, "entry_drafts", {
    id: ids.entryDraftId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    status: "ready",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: rolloverAtMs,
    completed_at_ms: null,
    created_by_user_id: PRIMARY.commissionerUserId,
    created_at_ms: scheduledAtMs,
    updated_at_ms: scheduledAtMs,
    version: 2,
  });
  insert(database, "draft_picks", {
    id: ids.draftPickId,
    league_id: PRIMARY.leagueId,
    draft_id: ids.entryDraftId,
    target_season_id: PRIMARY.seasonId,
    round_number: 1,
    position_number: 1,
    original_team_id: PRIMARY.teamOneId,
    current_owner_team_id: PRIMARY.teamOneId,
    status: "unused",
    selection_id: null,
    created_at_ms: scheduledAtMs,
    updated_at_ms: scheduledAtMs,
    version: 1,
  });
  insert(database, "job_runs", {
    id: ids.scheduledJobRunId,
    league_id: PRIMARY.leagueId,
    season_id: PRIMARY.seasonId,
    job_type: "league:entry_draft_rollover",
    occurrence_key: `season-rollover:${ids.rolloverId}`,
    scheduled_for_ms: rolloverAtMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: scheduledAtMs,
    updated_at_ms: scheduledAtMs,
    version: 1,
    lease_token: null,
    next_attempt_at_ms: rolloverAtMs,
  });
  insert(database, "idempotency_requests", {
    id: ids.scheduleIdempotencyId,
    league_id: PRIMARY.leagueId,
    actor_user_id: PRIMARY.commissionerUserId,
    operation: "entry_draft.schedule.v1",
    client_key: "subsequent-season-entry-draft-schedule",
    request_hash: "c".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: scheduledAtMs,
    completed_at_ms: null,
    expires_at_ms:
      scheduledAtMs + 2 * FREE_AGENT_DRAFT_DAY_MS,
  });
  const sourceReadiness = Object.freeze({
    fromSeasonId: ids.priorSeasonId,
    leagueId: PRIMARY.leagueId,
    observedAtMs: rolloverAtMs - 1,
    sourceFadId: ids.sourceFadId,
    sourceFinalizationId: ids.sourceFinalizationId,
    sourceFinalizationRootId:
      ids.sourceFinalizationRootId,
    sourceStandingsOperationId:
      ids.sourceStandingsOperationId,
    sourceStandingsSnapshotId:
      ids.sourceStandingsSnapshotId,
  });
  const contractItemProjection = Object.freeze({
    after: contractAfter,
    before: contractBefore,
    causalAssets: [],
    contractEventId: ids.contractEventId,
    effectKind: "contract_advanced",
    entityId: ids.contractId,
    entityType: "contract",
    fromSeasonId: ids.priorSeasonId,
    idempotencyRequestId: null,
    itemId: ids.contractRolloverItemId,
    leagueActivityId: null,
    leagueId: PRIMARY.leagueId,
    occurredAtMs: rolloverAtMs,
    ownershipEventId: null,
    rolloverAttemptId: ids.attemptId,
    rolloverId: ids.rolloverId,
    toSeasonId: PRIMARY.seasonId,
    tradeEventId: null,
  });
  const ownershipItemProjection = Object.freeze({
    after: ownershipAfter,
    before: ownershipBefore,
    causalAssets: [],
    contractEventId: null,
    effectKind: "ownership_carried",
    entityId: ids.ownershipId,
    entityType: "player_ownership",
    fromSeasonId: ids.priorSeasonId,
    idempotencyRequestId: null,
    itemId: ids.rolloverItemId,
    leagueActivityId: null,
    leagueId: PRIMARY.leagueId,
    occurredAtMs: rolloverAtMs,
    ownershipEventId: ids.ownershipEventId,
    rolloverAttemptId: ids.attemptId,
    rolloverId: ids.rolloverId,
    toSeasonId: PRIMARY.seasonId,
    tradeEventId: null,
  });
  const items = Object.freeze([
    Object.freeze({
      ...contractItemProjection,
      payloadSha256: hashSeasonRolloverItem(
        contractItemProjection
      ),
    }),
    Object.freeze({
      ...ownershipItemProjection,
      payloadSha256: hashSeasonRolloverItem(
        ownershipItemProjection
      ),
    }),
  ]);
  const summary = Object.freeze({
    buyoutObligationsCompleted: 0,
    buyoutYearsAdvanced: 0,
    contractsAdvanced: 1,
    contractsExpired: 0,
    ownershipsCarried: 1,
    ownershipsReleased: 0,
    retentionObligationsCompleted: 0,
    retentionYearsAdvanced: 0,
    tradesCancelled: 0,
  });
  const manifest = Object.freeze({
    aggregateActivityId: ids.activityId,
    completedAtMs: rolloverAtMs,
    entryDraftId: ids.entryDraftId,
    entryDraftRolloverBindingId: ids.bindingId,
    entryDraftScheduledByAuthority: "commissioner",
    entryDraftScheduledByUserId:
      PRIMARY.commissionerUserId,
    entryDraftScheduledStartsAtMs: rolloverAtMs,
    entryDraftVersionAfter: 3,
    entryDraftVersionBefore: 2,
    executedAuthority: "system",
    executedByUserId: null,
    executionTrigger: "scheduled_job",
    fantasyPlayoffsEndAtMs: PLAYOFFS_END_AT_MS,
    fantasyPlayoffsStartAtMs: PLAYOFFS_START_AT_MS,
    firstPickClockId: ids.firstPickClockId,
    fromNhlSeasonKey: "0000012026",
    fromSeasonId: ids.priorSeasonId,
    fromSeasonLabel: "2025-26",
    fromSeasonVersionAfter: 2,
    fromSeasonVersionBefore: 1,
    idempotencyRequestId: null,
    items,
    leagueId: PRIMARY.leagueId,
    leagueVersionAfter: 3,
    leagueVersionBefore: 2,
    nhlRegularSeasonEndsAtMs: PLAYOFFS_END_AT_MS,
    nhlRegularSeasonStartsAtMs: WEEK_ONE_AT_MS,
    occurrenceKey: `season-rollover:${ids.rolloverId}`,
    outboxEventId: ids.outboxEventId,
    rolloverAttemptId: ids.attemptId,
    rolloverId: ids.rolloverId,
    rolloverOccurrenceId: ids.occurrenceId,
    scheduledJobRunId: ids.scheduledJobRunId,
    securityAuditEventId: ids.securityAuditEventId,
    sourceFadId: ids.sourceFadId,
    sourceFinalizationId: ids.sourceFinalizationId,
    sourceFinalizationRootId:
      ids.sourceFinalizationRootId,
    sourceReadinessSchemaVersion: 1,
    sourceReadinessSha256:
      hashSeasonRolloverSourceReadiness(sourceReadiness),
    sourceStandingsOperationId:
      ids.sourceStandingsOperationId,
    sourceStandingsSnapshotId:
      ids.sourceStandingsSnapshotId,
    summary,
    targetNhlSeasonKey: `${PRIMARY.seasonId.slice(-6)}2027`,
    targetScheduleId: PRIMARY.scheduleOperationId,
    targetScheduleVersion: 1,
    targetSeasonReused: true,
    toSeasonId: PRIMARY.seasonId,
    toSeasonLabel: "2026-27",
    toSeasonVersionAfter: 2,
    toSeasonVersionBefore: 1,
    weekOneMatchupWeekId: PRIMARY.weekOneId,
    weekOneStartsAtMs: WEEK_ONE_AT_MS,
  });

  const persistRolloverAuthority = database.transaction(() => {
    database.pragma("defer_foreign_keys = ON");
    insert(database, "entry_draft_rollover_bindings", {
      id: ids.bindingId,
      league_id: PRIMARY.leagueId,
      entry_draft_id: ids.entryDraftId,
      from_season_id: ids.priorSeasonId,
      to_season_id: PRIMARY.seasonId,
      current_rollover_occurrence_id: ids.occurrenceId,
      current_scheduled_job_run_id: ids.scheduledJobRunId,
      current_schedule_operation_id:
        ids.entryDraftScheduleOperationId,
      target_schedule_id: PRIMARY.scheduleOperationId,
      target_schedule_version: 1,
      week_one_matchup_week_id: PRIMARY.weekOneId,
      week_one_starts_at_ms: WEEK_ONE_AT_MS,
      scheduled_starts_at_ms: rolloverAtMs,
      current_occurrence_key: manifest.occurrenceKey,
      status: "scheduled",
      successful_rollover_id: null,
      selection_gate_status: "locked",
      trading_gate_status: "locked",
      scheduled_by_user_id: PRIMARY.commissionerUserId,
      scheduled_by_membership_id:
        PRIMARY.commissionerMembershipId,
      scheduled_by_authority: "commissioner",
      source_season_version_at_schedule: 2,
      target_season_version_at_schedule: 1,
      entry_draft_version_at_schedule: 2,
      created_at_ms: scheduledAtMs,
      updated_at_ms: scheduledAtMs,
      version: 1,
    });
    insert(database, "season_rollover_occurrences", {
      id: ids.occurrenceId,
      league_id: PRIMARY.leagueId,
      binding_id: ids.bindingId,
      entry_draft_id: ids.entryDraftId,
      from_season_id: ids.priorSeasonId,
      to_season_id: PRIMARY.seasonId,
      target_schedule_id: PRIMARY.scheduleOperationId,
      target_schedule_version: 1,
      week_one_matchup_week_id: PRIMARY.weekOneId,
      week_one_starts_at_ms: WEEK_ONE_AT_MS,
      scheduled_starts_at_ms: rolloverAtMs,
      occurrence_key: manifest.occurrenceKey,
      scheduled_by_user_id: PRIMARY.commissionerUserId,
      scheduled_by_membership_id:
        PRIMARY.commissionerMembershipId,
      scheduled_by_authority: "commissioner",
      status: "scheduled",
      superseded_by_occurrence_id: null,
      scheduled_job_run_id: ids.scheduledJobRunId,
      schedule_operation_id:
        ids.entryDraftScheduleOperationId,
      successful_rollover_id: null,
      source_season_version_at_schedule: 2,
      target_season_version_at_schedule: 1,
      entry_draft_version_at_schedule: 2,
      terminal_at_ms: null,
      created_at_ms: scheduledAtMs,
      updated_at_ms: scheduledAtMs,
      version: 1,
    });
    insert(database, "entry_draft_schedule_operations", {
      id: ids.entryDraftScheduleOperationId,
      league_id: PRIMARY.leagueId,
      entry_draft_id: ids.entryDraftId,
      action: "schedule",
      idempotency_request_id: ids.scheduleIdempotencyId,
      rollover_binding_id: ids.bindingId,
      rollover_occurrence_id: ids.occurrenceId,
      scheduled_job_run_id: ids.scheduledJobRunId,
      superseded_rollover_occurrence_id: null,
      superseded_job_run_id: null,
      scheduled_starts_at_ms: rolloverAtMs,
      entry_draft_version_before: 1,
      entry_draft_version_after: 2,
      rollover_binding_version_before: 0,
      rollover_binding_version_after: 1,
      scheduled_job_version: 1,
      superseded_job_version_before: null,
      superseded_job_version_after: null,
      scheduled_by_user_id: PRIMARY.commissionerUserId,
      scheduled_by_membership_id:
        PRIMARY.commissionerMembershipId,
      scheduled_by_authority: "commissioner",
      reason: null,
      result_schema_version: 1,
      created_at_ms: scheduledAtMs,
      version: 1,
    });
    database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
          result_type = 'entry_draft_schedule',
          result_id = @operationId,
          completed_at_ms = @completedAtMs
      WHERE league_id = @leagueId
        AND id = @id
        AND status = 'started'
    `).run({
      completedAtMs: scheduledAtMs,
      id: ids.scheduleIdempotencyId,
      leagueId: PRIMARY.leagueId,
      operationId: ids.entryDraftScheduleOperationId,
    });
    assert.equal(database.prepare(`
      UPDATE job_runs
      SET status = 'running',
          attempt_count = 1,
          lease_owner = 'season-rollover-worker',
          lease_token = 'season-rollover-token',
          lease_expires_at_ms = @leaseExpiresAtMs,
          started_at_ms = @startedAtMs,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @startedAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @jobRunId
        AND status = 'pending'
        AND version = 1
    `).run({
      jobRunId: ids.scheduledJobRunId,
      leagueId: PRIMARY.leagueId,
      leaseExpiresAtMs:
        rolloverAtMs + FREE_AGENT_DRAFT_DAY_MS,
      startedAtMs: rolloverAtMs,
    }).changes, 1);
    insert(database, "season_rollover_attempts", {
      id: ids.attemptId,
      league_id: PRIMARY.leagueId,
      binding_id: ids.bindingId,
      rollover_occurrence_id: ids.occurrenceId,
      entry_draft_id: ids.entryDraftId,
      from_season_id: ids.priorSeasonId,
      to_season_id: PRIMARY.seasonId,
      target_schedule_id: PRIMARY.scheduleOperationId,
      target_schedule_version: 1,
      week_one_matchup_week_id: PRIMARY.weekOneId,
      week_one_starts_at_ms: WEEK_ONE_AT_MS,
      scheduled_starts_at_ms: rolloverAtMs,
      occurrence_key: manifest.occurrenceKey,
      attempt_number: 1,
      trigger_kind: "scheduled_job",
      scheduled_job_run_id: ids.scheduledJobRunId,
      retry_idempotency_request_id: null,
      retry_by_user_id: null,
      retry_by_membership_id: null,
      retry_authority: null,
      status: "started",
      blockers_json: "[]",
      season_rollover_id: null,
      source_season_version_observed: 2,
      target_season_version_observed: 1,
      entry_draft_version_observed: 2,
      started_at_ms: rolloverAtMs,
      terminal_at_ms: null,
      created_at_ms: rolloverAtMs,
      updated_at_ms: rolloverAtMs,
      version: 1,
    });
    assert.equal(database.prepare(`
      UPDATE seasons
      SET updated_at_ms = @rolloverAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND status = 'active'
        AND version = 1
        AND free_agent_draft_completed_at_ms IS NULL
    `).run({
      leagueId: PRIMARY.leagueId,
      rolloverAtMs,
      seasonId: PRIMARY.seasonId,
    }).changes, 1);
    assert.equal(database.prepare(`
      UPDATE leagues
      SET updated_at_ms = @rolloverAtMs,
          version = 3
      WHERE id = @leagueId
        AND current_season_id = @seasonId
        AND version = 2
    `).run({
      leagueId: PRIMARY.leagueId,
      rolloverAtMs,
      seasonId: PRIMARY.seasonId,
    }).changes, 1);
    insert(database, "league_activity", {
      id: ids.activityId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      event_type: "season_rolled_over",
      actor_user_id: null,
      actor_authority: "system",
      team_id: null,
      player_id: null,
      related_type: "season",
      related_id: PRIMARY.seasonId,
      display_summary: "The league advanced to the next season.",
      reason: "scheduled_entry_draft_rollover",
      metadata_json: serializeCanonicalJsonV1({
        fromSeasonId: ids.priorSeasonId,
        rolloverId: ids.rolloverId,
        toSeasonId: PRIMARY.seasonId,
      }),
      occurred_at_ms: rolloverAtMs,
    });
    insert(database, "security_audit_events", {
      id: ids.securityAuditEventId,
      event_type: "league.season_rolled_over",
      outcome: "success",
      actor_user_id: null,
      target_user_id: null,
      league_id: PRIMARY.leagueId,
      session_id: null,
      request_correlation_id: null,
      reason_code: "scheduled_entry_draft_rollover",
      network_key_version: null,
      network_metadata_digest: null,
      client_metadata_json: null,
      unknown_account_digest: null,
      occurred_at_ms: rolloverAtMs,
    });
    insert(database, "outbox_events", {
      id: ids.outboxEventId,
      league_id: PRIMARY.leagueId,
      event_type: "league.changed",
      aggregate_type: "league",
      aggregate_id: PRIMARY.leagueId,
      payload_json: JSON.stringify({
        changedAtMs: rolloverAtMs,
        eventType: "league.changed",
        scope: "league",
        scopeId: PRIMARY.leagueId,
        version: 3,
      }),
      status: "pending",
      attempt_count: 0,
      available_at_ms: rolloverAtMs,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: rolloverAtMs,
      updated_at_ms: rolloverAtMs,
      version: 1,
    });
    insert(database, "outbox_event_audiences", {
      id: ids.outboxAudienceId,
      league_id: PRIMARY.leagueId,
      outbox_event_id: ids.outboxEventId,
      audience_kind: "league",
      team_id: null,
      user_id: null,
      created_at_ms: rolloverAtMs,
    });
    for (const item of items) {
      insert(database, "season_rollover_items", {
        id: item.itemId,
        league_id: PRIMARY.leagueId,
        rollover_id: ids.rolloverId,
        binding_id: ids.bindingId,
        rollover_occurrence_id: ids.occurrenceId,
        rollover_attempt_id: ids.attemptId,
        idempotency_request_id: null,
        from_season_id: ids.priorSeasonId,
        to_season_id: PRIMARY.seasonId,
        effect_kind: item.effectKind,
        entity_type: item.entityType,
        entity_id: item.entityId,
        before_json: serializeCanonicalJsonV1(item.before),
        after_json: serializeCanonicalJsonV1(item.after),
        payload_sha256: item.payloadSha256,
        contract_event_id: item.contractEventId,
        ownership_event_id: item.ownershipEventId,
        trade_event_id: item.tradeEventId,
        league_activity_id: item.leagueActivityId,
        causal_assets_json:
          serializeCanonicalJsonV1(item.causalAssets),
        occurred_at_ms: rolloverAtMs,
        created_at_ms: rolloverAtMs,
        version: 1,
      });
    }
    assert.equal(database.prepare(`
      UPDATE draft_picks
      SET updated_at_ms = @rolloverAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @draftPickId
        AND status = 'unused'
        AND version = 1
    `).run({
      draftPickId: ids.draftPickId,
      leagueId: PRIMARY.leagueId,
      rolloverAtMs,
    }).changes, 1);
    insert(database, "entry_draft_pick_clocks", {
      id: ids.firstPickClockId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      binding_id: ids.bindingId,
      rollover_occurrence_id: ids.occurrenceId,
      rollover_attempt_id: ids.attemptId,
      season_rollover_id: ids.rolloverId,
      entry_draft_id: ids.entryDraftId,
      draft_pick_id: ids.draftPickId,
      owning_team_id: PRIMARY.teamOneId,
      clock_generation: 1,
      prior_clock_id: null,
      on_clock_trade_id: null,
      pick_sequence: 1,
      status: "prepared",
      starts_at_ms: rolloverAtMs,
      deadline_at_ms: rolloverAtMs + 300_000,
      completed_at_ms: null,
      created_at_ms: rolloverAtMs,
      updated_at_ms: rolloverAtMs,
      version: 1,
    });
    insert(database, "season_rollovers", {
      id: ids.rolloverId,
      league_id: PRIMARY.leagueId,
      binding_id: ids.bindingId,
      rollover_occurrence_id: ids.occurrenceId,
      rollover_attempt_id: ids.attemptId,
      entry_draft_id: ids.entryDraftId,
      target_schedule_id: PRIMARY.scheduleOperationId,
      target_schedule_version: 1,
      week_one_matchup_week_id: PRIMARY.weekOneId,
      week_one_starts_at_ms: WEEK_ONE_AT_MS,
      first_pick_clock_id: ids.firstPickClockId,
      entry_draft_scheduled_starts_at_ms: rolloverAtMs,
      occurrence_key: manifest.occurrenceKey,
      from_season_id: ids.priorSeasonId,
      to_season_id: PRIMARY.seasonId,
      status: "succeeded",
      execution_trigger: "scheduled_job",
      scheduled_job_run_id: ids.scheduledJobRunId,
      idempotency_request_id: null,
      executed_by_user_id: null,
      executed_by_membership_id: null,
      executed_authority: "system",
      entry_draft_scheduled_by_user_id:
        PRIMARY.commissionerUserId,
      entry_draft_scheduled_by_membership_id:
        PRIMARY.commissionerMembershipId,
      entry_draft_scheduled_by_authority: "commissioner",
      league_version_before: 2,
      league_version_after: 3,
      from_season_version_before: 1,
      from_season_version_after: 2,
      to_season_version_before: 1,
      to_season_version_after: 2,
      entry_draft_version_before: 2,
      entry_draft_version_after: 3,
      target_season_reused: 1,
      from_season_label: "2025-26",
      from_nhl_season_key: "0000012026",
      to_season_label: "2026-27",
      target_nhl_season_key:
        `${PRIMARY.seasonId.slice(-6)}2027`,
      nhl_regular_season_starts_at_ms: WEEK_ONE_AT_MS,
      nhl_regular_season_ends_at_ms: PLAYOFFS_END_AT_MS,
      fantasy_playoffs_start_at_ms: PLAYOFFS_START_AT_MS,
      fantasy_playoffs_end_at_ms: PLAYOFFS_END_AT_MS,
      source_fad_id: ids.sourceFadId,
      source_finalization_root_id:
        ids.sourceFinalizationRootId,
      source_finalization_id: ids.sourceFinalizationId,
      source_standings_snapshot_id:
        ids.sourceStandingsSnapshotId,
      source_standings_operation_id:
        ids.sourceStandingsOperationId,
      source_readiness_json:
        serializeSeasonRolloverSourceReadiness(sourceReadiness),
      source_readiness_schema_version: 1,
      source_readiness_sha256:
        manifest.sourceReadinessSha256,
      aggregate_activity_id: ids.activityId,
      security_audit_event_id: ids.securityAuditEventId,
      outbox_event_id: ids.outboxEventId,
      completed_at_ms: rolloverAtMs,
      contracts_advanced: 1,
      contracts_expired: 0,
      ownerships_carried: 1,
      ownerships_released: 0,
      retention_years_advanced: 0,
      retention_obligations_completed: 0,
      buyout_years_advanced: 0,
      buyout_obligations_completed: 0,
      trades_cancelled: 0,
      manifest_schema_version: 1,
      manifest_sha256: hashSeasonRolloverManifest(manifest),
      created_at_ms: rolloverAtMs,
      version: 1,
    });
    assert.equal(database.prepare(`
      UPDATE season_rollover_attempts
      SET status = 'succeeded',
          blockers_json = '[]',
          season_rollover_id = @rolloverId,
          terminal_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @attemptId
        AND status = 'started'
    `).run({
      attemptId: ids.attemptId,
      completedAtMs: rolloverAtMs,
      leagueId: PRIMARY.leagueId,
      rolloverId: ids.rolloverId,
    }).changes, 1);
    assert.equal(database.prepare(`
      UPDATE season_rollover_occurrences
      SET status = 'succeeded',
          successful_rollover_id = @rolloverId,
          terminal_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @occurrenceId
        AND status = 'scheduled'
    `).run({
      completedAtMs: rolloverAtMs,
      leagueId: PRIMARY.leagueId,
      occurrenceId: ids.occurrenceId,
      rolloverId: ids.rolloverId,
    }).changes, 1);
    assert.equal(database.prepare(`
      UPDATE entry_draft_rollover_bindings
      SET status = 'succeeded',
          successful_rollover_id = @rolloverId,
          selection_gate_status = 'open',
          trading_gate_status = 'open',
          updated_at_ms = @completedAtMs,
          version = 2
      WHERE league_id = @leagueId
        AND id = @bindingId
        AND status = 'scheduled'
        AND version = 1
    `).run({
      bindingId: ids.bindingId,
      completedAtMs: rolloverAtMs,
      leagueId: PRIMARY.leagueId,
      rolloverId: ids.rolloverId,
    }).changes, 1);
    assert.equal(database.prepare(`
      UPDATE entry_drafts
      SET status = 'active',
          updated_at_ms = @completedAtMs,
          version = 3
      WHERE league_id = @leagueId
        AND id = @entryDraftId
        AND status = 'ready'
        AND version = 2
    `).run({
      completedAtMs: rolloverAtMs,
      entryDraftId: ids.entryDraftId,
      leagueId: PRIMARY.leagueId,
    }).changes, 1);
    assert.equal(database.prepare(`
      UPDATE job_runs
      SET status = 'succeeded',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at_ms = NULL,
          completed_at_ms = @completedAtMs,
          result_json = '{}',
          last_error_code = NULL,
          next_attempt_at_ms = NULL,
          updated_at_ms = @completedAtMs,
          version = 3
      WHERE league_id = @leagueId
        AND id = @jobRunId
        AND status = 'running'
        AND version = 2
    `).run({
      completedAtMs: rolloverAtMs,
      jobRunId: ids.scheduledJobRunId,
      leagueId: PRIMARY.leagueId,
    }).changes, 1);
  });
  persistRolloverAuthority.immediate();

  return Object.freeze({
    ids,
    rolloverAtMs,
    scheduleBinding: seedCurrentScheduleJobBinding(database),
  });
}

function navigationInput(scope, overrides = {}) {
  return {
    leagueId: scope.leagueId,
    viewerUserId: PRIMARY.managerUserId,
    viewerMembershipId:
      scope === PRIMARY
        ? PRIMARY.managerMembershipId
        : SECONDARY.managerMembershipId,
    nowMs: PREPUBLICATION_NOW_MS,
    rosterSeasonId: null,
    rosterTeamId: null,
    ...overrides,
  };
}

function readinessInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    seasonId: PRIMARY.seasonId,
    viewerUserId: PRIMARY.commissionerUserId,
    viewerMembershipId:
      PRIMARY.commissionerMembershipId,
    nowMs: PREPUBLICATION_NOW_MS,
    ...overrides,
  };
}

function overviewInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    fadId: PRIMARY.fadId,
    viewerUserId: PRIMARY.managerUserId,
    viewerMembershipId: PRIMARY.managerMembershipId,
    nowMs: PREPUBLICATION_NOW_MS,
    ...overrides,
  };
}

function publishedSummaryInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    fadId: PRIMARY.fadId,
    viewerUserId: PRIMARY.memberUserId,
    viewerMembershipId: PRIMARY.memberMembershipId,
    nowMs: PUBLICATION_AT_MS,
    query: { cursor: null, limit: 50 },
    ...overrides,
  };
}

function publishedHistoryInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    fadId: PRIMARY.fadId,
    teamId: PRIMARY.teamOneId,
    viewerUserId: PRIMARY.memberUserId,
    viewerMembershipId: PRIMARY.memberMembershipId,
    nowMs: PUBLICATION_AT_MS,
    ...overrides,
  };
}

function allocationResultsInput(overrides = {}) {
  return {
    leagueId: PRIMARY.leagueId,
    fadId: PRIMARY.fadId,
    viewerUserId: PRIMARY.memberUserId,
    viewerMembershipId: PRIMARY.memberMembershipId,
    nowMs: PUBLICATION_AT_MS,
    query: {
      cursor: null,
      limit: 50,
      q: "",
      status: null,
    },
    ...overrides,
  };
}

function assertRepositoryError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function assertExactKeys(value, keys) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort()
  );
}

function assertSafeTeamShape(team) {
  assertExactKeys(team, [
    "logoReference",
    "name",
    "patternTemplate",
    "primaryColour",
    "secondaryColour",
    "teamId",
    "tertiaryColour",
  ]);
}

function assertCapabilityShape(capability) {
  assertExactKeys(capability, ["allowed", "reasonCode"]);
}

function assertCardDescriptorShape(descriptor) {
  assertExactKeys(descriptor, [
    "authorizationEvidence",
    "cardId",
    "fadId",
    "mode",
    "seasonId",
    "teamId",
  ]);
  if (descriptor.authorizationEvidence !== null) {
    assertExactKeys(descriptor.authorizationEvidence, [
      "id",
      "kind",
    ]);
  }
}

function assertNavigationShape(navigation) {
  assertExactKeys(navigation, [
    "candidateDeadlineAtMs",
    "competitionFirstMatchupStartsAtMs",
    "fadId",
    "frozenFadFirstMatchupStartsAtMs",
    "managedCards",
    "nextRolloverAtMs",
    "phase",
    "rosterLinks",
    "seasonId",
    "serverNowMs",
    "showMainNavigation",
    "timeZone",
    "urgencyCode",
  ]);
  for (const card of navigation.managedCards) {
    assertExactKeys(card, [
      "allocationEligibility",
      "capStatus",
      "cardId",
      "cardVersion",
      "completenessCode",
      "conflictCount",
      "helpRequestStatus",
      "lifecycleStatus",
      "managerAssignmentId",
      "missingMandatoryCount",
      "team",
      "teamId",
      "urgencyCode",
    ]);
    assertSafeTeamShape(card.team);
  }
  for (const descriptor of navigation.rosterLinks) {
    assertCardDescriptorShape(descriptor);
  }
}

function assertReadinessShape(readiness) {
  assertExactKeys(readiness, [
    "blockers",
    "candidateDeadlineAtMs",
    "entryDraftId",
    "exemptionId",
    "firstMatchupWeekAfter",
    "firstMatchupWeekBefore",
    "helpOpensAtMs",
    "initialRollovers",
    "leagueId",
    "observedSeasonVersion",
    "operationId",
    "operationVersion",
    "participatingTeamCount",
    "priorSeasonRollover",
    "reminderAtMs",
    "resultFadId",
    "retryReadiness",
    "seasonId",
    "serverNowMs",
    "status",
    "teamProjections",
    "timeZone",
    "triggerKind",
    "warnings",
  ]);
  for (const week of [
    readiness.firstMatchupWeekBefore,
    readiness.firstMatchupWeekAfter,
  ]) {
    if (week !== null) {
      assertExactKeys(week, [
        "sequence",
        "startsAtMs",
        "version",
        "weekId",
      ]);
    }
  }
  for (const rollover of readiness.initialRollovers) {
    assertExactKeys(rollover, [
      "creationCutoffAtMs",
      "opensAtMs",
      "rollsOverAtMs",
      "sequence",
    ]);
  }
  if (readiness.priorSeasonRollover !== null) {
    assertExactKeys(readiness.priorSeasonRollover, [
      "completedAtMs",
      "fromSeasonId",
      "manifestSha256",
      "rolloverId",
      "toSeasonId",
    ]);
  }
  for (const projection of readiness.teamProjections) {
    assertExactKeys(projection, [
      "carryoverCount",
      "managerAssignmentId",
      "managerReady",
      "openBenchSlots",
      "openDefenceSlots",
      "openForwardSlots",
      "structuralConflictCount",
      "team",
      "teamId",
    ]);
    assertSafeTeamShape(projection.team);
  }
  for (const diagnostic of [
    ...readiness.blockers,
    ...readiness.warnings,
  ]) {
    assertExactKeys(diagnostic, [
      "code",
      "message",
      "resourceId",
    ]);
  }
  assertCapabilityShape(readiness.retryReadiness);
}

function assertOverviewShape(overview) {
  assertExactKeys(overview, [
    "allocationCompletedAtMs",
    "candidateDeadlineAtMs",
    "capabilities",
    "completedAtMs",
    "competitionFirstMatchupStartsAtMs",
    "counts",
    "deadlineLockedAtMs",
    "fadId",
    "frozenFadFirstMatchupStartsAtMs",
    "helpOpensAtMs",
    "leagueId",
    "nextRolloverAtMs",
    "openedAtMs",
    "phase",
    "presentation",
    "reminderAtMs",
    "scheduleRecoveryOperationId",
    "seasonId",
    "serverNowMs",
    "status",
    "timeZone",
    "version",
    "viewer",
  ]);
  assertExactKeys(overview.counts, [
    "allocationsAutomatic",
    "allocationsPending",
    "cardsLocked",
    "participatingTeams",
    "rapidAuctionsOpen",
    "recoveriesOpen",
    "restrictedFallbackPending",
    "restrictedPending",
    "rolloversCompleted",
    "rolloversPersisted",
  ]);
  assertExactKeys(overview.viewer, [
    "commissionerCards",
    "managedCards",
    "queuedNominations",
  ]);
  for (const card of overview.viewer.managedCards) {
    assertExactKeys(card, [
      "allocationEligibility",
      "capStatus",
      "cardDescriptor",
      "cardId",
      "cardVersion",
      "completenessCode",
      "conflictCount",
      "helpRequestStatus",
      "lifecycleStatus",
      "managerAssignmentId",
      "missingMandatoryCount",
      "team",
      "teamId",
    ]);
    assertSafeTeamShape(card.team);
    assertCardDescriptorShape(card.cardDescriptor);
  }
  for (const card of overview.viewer.commissionerCards) {
    assertExactKeys(card, [
      "allocationEligibility",
      "capStatus",
      "completenessCode",
      "conflictCount",
      "helpRequestId",
      "helpRequestStatus",
      "helpRequestedAtMs",
      "lifecycleStatus",
      "missingMandatoryCount",
      "openPrivateCard",
      "team",
      "teamId",
    ]);
    assertSafeTeamShape(card.team);
    assertCapabilityShape(card.openPrivateCard);
  }
  for (const queued of overview.viewer.queuedNominations) {
    assertExactKeys(queued, [
      "aavCents",
      "cancel",
      "opensAtRolloverId",
      "player",
      "queueId",
      "status",
      "submittedAtMs",
      "targetRolloverId",
      "teamId",
      "termYears",
      "totalValueCents",
    ]);
    assertExactKeys(queued.player, [
      "fullName",
      "playerId",
      "positionGroup",
    ]);
    assertCapabilityShape(queued.cancel);
  }
  assertExactKeys(overview.capabilities, [
    "completeRecoveryAction",
    "viewPublishedCards",
    "viewRecovery",
  ]);
  for (const capability of Object.values(
    overview.capabilities
  )) {
    assertCapabilityShape(capability);
  }
}

describe("SQLite Free Agent Draft read repository foundation", () => {
  test("publishes only the locked seven-method read surface", () => {
    assert.deepEqual(
      FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS,
      [
        "readOpeningPreflightContext",
        "readNavigation",
        "readReadiness",
        "readOverview",
        "readPublishedCardSummaries",
        "readPublishedCardHistory",
        "readAllocationResults",
      ]
    );
    assert.deepEqual(
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES,
      {
        authorizationDenied:
          "FAD_READ_AUTHORIZATION_DENIED",
        candidateCardNotFound:
          "CANDIDATE_CARD_NOT_FOUND",
        cardsNotPublished:
          "FAD_CARDS_NOT_PUBLISHED",
      }
    );
  });

  test("fails every published read closed before deadline publication without writes", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const before = noWriteSnapshot(runtime.database);

    for (const read of [
      () =>
        runtime.readRepository.readPublishedCardSummaries(
          publishedSummaryInput({
            nowMs: PREPUBLICATION_NOW_MS,
          })
        ),
      () =>
        runtime.readRepository.readPublishedCardHistory(
          publishedHistoryInput({
            nowMs: PREPUBLICATION_NOW_MS,
          })
        ),
      () =>
        runtime.readRepository.readAllocationResults(
          allocationResultsInput({
            nowMs: PREPUBLICATION_NOW_MS,
          })
        ),
    ]) {
      assertRepositoryError(
        read,
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
          .cardsNotPublished
      );
    }
    assertNoWrites(runtime.database, before);
  });

  test("reads deterministic published Candidate summaries and immutable 22-slot history without writes", (t) => {
    const runtime = createRuntime(t);
    runtime.database
      .prepare(`
        UPDATE teams
        SET name = 'Ice  Bears',
            name_normalized = 'ice  bears',
            version = version + 1
        WHERE league_id = ?
          AND id = ?
      `)
      .run(PRIMARY.leagueId, PRIMARY.teamTwoId);
    const fixture = seedPublishedPendingResults(
      runtime.database
    );
    const before = noWriteSnapshot(runtime.database);

    const first =
      runtime.readRepository.readPublishedCardSummaries(
        publishedSummaryInput({
          query: { cursor: null, limit: 1 },
        })
      );
    assert.deepEqual(first.page.hasMore, true);
    assert.equal(typeof first.page.nextCursor, "string");
    assert.deepEqual(
      first.data.map(({ teamId }) => teamId),
      [PRIMARY.teamTwoId]
    );
    const second =
      runtime.readRepository.readPublishedCardSummaries(
        publishedSummaryInput({
          query: {
            cursor: first.page.nextCursor,
            limit: 1,
          },
        })
      );
    const third =
      runtime.readRepository.readPublishedCardSummaries(
        publishedSummaryInput({
          query: {
            cursor: second.page.nextCursor,
            limit: 1,
          },
        })
      );
    assert.deepEqual(
      [
        first.data[0].teamId,
        second.data[0].teamId,
        third.data[0].teamId,
      ],
      [
        PRIMARY.teamTwoId,
        PRIMARY.teamThreeId,
        PRIMARY.teamOneId,
      ]
    );
    assert.deepEqual(second.page.hasMore, true);
    assert.equal(typeof second.page.nextCursor, "string");
    assert.deepEqual(third.page, {
      nextCursor: null,
      hasMore: false,
    });
    const summary = first.data[0];
    assertExactKeys(summary, [
      "allocationEligibility",
      "allocationExclusionReason",
      "capStatus",
      "carriedCapUsageCents",
      "commissionerInterventionCount",
      "completeness",
      "counts",
      "fadId",
      "historyDescriptor",
      "leagueId",
      "lifecycleStatus",
      "lockedCardVersion",
      "maximumPossibleCapCents",
      "outcomeCounts",
      "seasonId",
      "snapshotId",
      "team",
      "teamId",
    ]);
    assertSafeTeamShape(summary.team);
    assert.deepEqual(summary.counts, {
      carryovers: 0,
      candidates: 1,
      emptyMandatory: 17,
      emptyBench: 4,
      conflicts: 0,
    });
    assert.deepEqual(summary.outcomeCounts, {
      automaticWins: 0,
      restrictedPending: 0,
      restrictedWins: 0,
      fallbackPending: 0,
      fallbackWins: 0,
      fallbackNoWinner: 0,
      losses: 0,
      invalidOffers: 0,
    });
    assert.deepEqual(summary.historyDescriptor, {
      mode: "published_card",
      seasonId: PRIMARY.seasonId,
      fadId: PRIMARY.fadId,
      teamId: PRIMARY.teamTwoId,
      cardId: PRIMARY.cardTwoId,
    });

    assertRepositoryError(
      () =>
        runtime.readRepository
          .readPublishedCardSummaries(
            publishedSummaryInput({
              query: {
                cursor: first.page.nextCursor,
                limit: 2,
              },
            })
          ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );

    const history =
      runtime.readRepository.readPublishedCardHistory(
        publishedHistoryInput()
      );
    assertExactKeys(history, [
      "accessReason",
      "allocationEligibility",
      "allocationExclusionReason",
      "authorizationEvidence",
      "capProjection",
      "capStatus",
      "capabilities",
      "cardId",
      "cardVersion",
      "commissionerInterventions",
      "completeness",
      "conflicts",
      "fadId",
      "helpContext",
      "leagueId",
      "lifecycleStatus",
      "phase",
      "seasonId",
      "slots",
      "teamId",
      "visibilityMode",
    ]);
    assert.equal(history.phase, "allocating");
    assert.equal(
      history.visibilityMode,
      "published_history"
    );
    assert.equal(history.slots.length, 22);
    assert.deepEqual(
      history.slots.map(({ slotKey }) => slotKey),
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
    const candidate = history.slots[0];
    const teamOneOffer = fixture.offers.find(
      ({ teamId }) => teamId === PRIMARY.teamOneId
    );
    assertExactKeys(candidate, [
      "aavCents",
      "authoritativeRosterCategory",
      "capabilities",
      "entryId",
      "entryVersion",
      "lastEditedAtMs",
      "lastEditedBy",
      "locked",
      "occupantKind",
      "outcome",
      "player",
      "remainingYears",
      "required",
      "slotGroup",
      "slotKey",
      "termYears",
      "totalValueCents",
      "validation",
    ]);
    assert.deepEqual(candidate.player, {
      playerId: fixture.players.zed.playerId,
      fullName: "Zed Candidate",
      positionGroup: "F",
    });
    assert.equal(candidate.entryId, teamOneOffer.entryId);
    assert.equal(candidate.occupantKind, "candidate");
    assert.equal(candidate.totalValueCents, 900);
    assert.equal(candidate.termYears, 3);
    assert.equal(candidate.aavCents, 300);
    assert.equal(candidate.outcome, null);
    assert.deepEqual(candidate.validation, {
      status: "valid",
      codes: [],
    });
    assert.deepEqual(candidate.lastEditedBy, {
      userId: PRIMARY.managerUserId,
      displayName: "Multi Team Manager",
      authority: "manager",
    });
    for (const capability of Object.values(
      candidate.capabilities
    )) {
      assert.deepEqual(capability, {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      });
    }
    assert.deepEqual(history.conflicts, []);
    assert.equal(history.helpContext, null);
    assert.deepEqual(
      history.commissionerInterventions,
      []
    );
    assert.equal(Object.isFrozen(history), true);
    assert.equal(Object.isFrozen(history.slots), true);

    assertRepositoryError(
      () =>
        runtime.readRepository.readPublishedCardHistory(
          publishedHistoryInput({ teamId: uuid(99_999) })
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
        .candidateCardNotFound
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readPublishedCardHistory(
          publishedHistoryInput({
            viewerUserId: SECONDARY.managerUserId,
            viewerMembershipId:
              SECONDARY.managerMembershipId,
          })
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
        .authorizationDenied
    );
    assertNoWrites(runtime.database, before);
  });

  test("publishes an incomplete Candidate snapshot row as invalid_offer without requiring an allocation", (t) => {
    const runtime = createRuntime(t);
    const fixture = seedPublishedPendingResults(
      runtime.database
    );
    const offer = fixture.offers.find(
      ({ teamId }) =>
        teamId === PRIMARY.teamTwoId
    );
    dropTableTriggers(
      runtime.database,
      "candidate_card_snapshot_entries"
    );
    dropTableTriggers(
      runtime.database,
      "candidate_card_entries"
    );
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_player_allocations"
    );
    runtime.database.prepare(`
      UPDATE candidate_card_entries
      SET proposed_term_years = NULL,
          proposed_aav_cents = NULL,
          eligibility_status = 'invalid',
          validation_code =
            'CANDIDATE_CONTRACT_INCOMPLETE'
      WHERE id = ?
    `).run(offer.entryId);
    runtime.database.prepare(`
      UPDATE candidate_card_snapshot_entries
      SET proposed_term_years = NULL,
          proposed_aav_cents = NULL,
          eligibility_status = 'invalid',
          validation_code =
            'CANDIDATE_CONTRACT_INCOMPLETE'
      WHERE id = ?
    `).run(offer.snapshotEntryId);
    runtime.database.prepare(`
      DELETE FROM free_agent_draft_player_allocations
      WHERE id = ?
    `).run(fixture.players.amy.allocationId);
    const before = noWriteSnapshot(runtime.database);

    const history =
      runtime.readRepository.readPublishedCardHistory(
        publishedHistoryInput({
          teamId: PRIMARY.teamTwoId,
        })
      );
    const partial = history.slots.find(
      ({ entryId }) => entryId === offer.entryId
    );
    assert.deepEqual(partial.outcome, {
      code: "invalid_offer",
      allocationId: null,
      auctionId: null,
    });
    assert.deepEqual(
      partial.validation,
      {
        status: "invalid",
        codes: [
          "CANDIDATE_CONTRACT_INCOMPLETE",
        ],
      }
    );
    assert.equal(
      partial.totalValueCents,
      400
    );
    assert.equal(partial.termYears, null);
    assert.equal(partial.aavCents, null);
    assertNoWrites(runtime.database, before);
  });

  test("reads pending T-140 allocations immediately with snapshot evidence, bound cursors, and no writes", (t) => {
    const runtime = createRuntime(t);
    const fixture = seedPublishedPendingResults(
      runtime.database
    );
    const before = noWriteSnapshot(runtime.database);

    const first =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          query: {
            cursor: null,
            limit: 1,
            q: "",
            status: null,
          },
        })
      );
    assert.equal(first.page.hasMore, true);
    assert.equal(typeof first.page.nextCursor, "string");
    assert.equal(first.data.length, 1);
    const amy = first.data[0];
    assertExactKeys(amy, [
      "allocationId",
      "allocationVersion",
      "decisionCode",
      "draws",
      "fallback",
      "player",
      "rankedOffers",
      "recoveryStatus",
      "resolvedAtMs",
      "restricted",
      "status",
      "winner",
    ]);
    assert.equal(
      amy.allocationId,
      fixture.players.amy.allocationId
    );
    assert.deepEqual(amy.player, {
      playerId: fixture.players.amy.playerId,
      fullName: "Amy Candidate",
      positionGroup: "D",
    });
    assert.equal(amy.status, "pending");
    assert.equal(amy.decisionCode, null);
    assert.equal(amy.winner, null);
    assert.equal(amy.restricted, null);
    assert.equal(amy.fallback, null);
    assert.deepEqual(amy.draws, []);
    assert.equal(amy.recoveryStatus, null);
    assert.equal(amy.resolvedAtMs, null);
    assert.equal(amy.rankedOffers.length, 1);
    assert.deepEqual(
      {
        ...amy.rankedOffers[0],
        team: undefined,
      },
      {
        snapshotEntryId:
          fixture.offers.find(
            ({ teamId }) => teamId === PRIMARY.teamTwoId
          ).snapshotEntryId,
        teamId: PRIMARY.teamTwoId,
        team: undefined,
        slotKey: "D01",
        totalValueCents: 400,
        termYears: 2,
        aavCents: 200,
        valid: true,
        validationCode: null,
        rank: null,
        outcomeCode: "pending",
      }
    );
    assertSafeTeamShape(amy.rankedOffers[0].team);

    const second =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          query: {
            cursor: first.page.nextCursor,
            limit: 1,
            q: "",
            status: null,
          },
        })
      );
    assert.deepEqual(second.page, {
      nextCursor: null,
      hasMore: false,
    });
    const zed = second.data[0];
    assert.equal(
      zed.allocationId,
      fixture.players.zed.allocationId
    );
    assert.equal(zed.status, "pending");
    assert.deepEqual(
      zed.rankedOffers.map((offer) => ({
        teamId: offer.teamId,
        totalValueCents: offer.totalValueCents,
        rank: offer.rank,
        outcomeCode: offer.outcomeCode,
      })),
      [
        {
          teamId: PRIMARY.teamOneId,
          totalValueCents: 900,
          rank: null,
          outcomeCode: "pending",
        },
        {
          teamId: PRIMARY.teamThreeId,
          totalValueCents: 600,
          rank: null,
          outcomeCode: "pending",
        },
      ]
    );

    const search =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          query: {
            cursor: null,
            limit: 50,
            q: "  ZED\tCandidate ",
            status: "pending",
          },
        })
      );
    assert.deepEqual(
      search.data.map(({ allocationId }) => allocationId),
      [fixture.players.zed.allocationId]
    );
    assert.deepEqual(search.page, {
      nextCursor: null,
      hasMore: false,
    });
    for (const literalSearch of ["%", "_"]) {
      assert.deepEqual(
        runtime.readRepository.readAllocationResults(
          allocationResultsInput({
            query: {
              cursor: null,
              limit: 50,
              q: literalSearch,
              status: null,
            },
          })
        ),
        {
          data: [],
          page: { nextCursor: null, hasMore: false },
        }
      );
    }
    const noAutomaticAwards =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          query: {
            cursor: null,
            limit: 50,
            q: "",
            status: "automatic_award",
          },
        })
      );
    assert.deepEqual(noAutomaticAwards, {
      data: [],
      page: { nextCursor: null, hasMore: false },
    });
    assertRepositoryError(
      () =>
        runtime.readRepository.readAllocationResults(
          allocationResultsInput({
            query: {
              cursor: first.page.nextCursor,
              limit: 1,
              q: "zed",
              status: null,
            },
          })
        ),
      REPOSITORY_ERROR_CODES.argumentInvalid
    );
    assert.equal(Object.isFrozen(amy), true);
    assert.equal(Object.isFrozen(amy.rankedOffers), true);
    assertNoWrites(runtime.database, before);
  });

  test("projects an automatic winner and rejects omission of its Candidate snapshot identity", (t) => {
    const runtime = createRuntime(t);
    const fixture = seedPublishedPendingResults(
      runtime.database
    );
    const amyOffer = fixture.offers.find(
      ({ teamId }) => teamId === PRIMARY.teamTwoId
    );
    const contractId = uuid(23_000);
    const ownershipId = uuid(23_001);
    dropTableTriggers(runtime.database, "contracts");
    dropTableTriggers(
      runtime.database,
      "player_ownerships"
    );
    const fixtureStage = (label, action) => {
      try {
        return action();
      } catch (error) {
        throw new Error(
          `Automatic-winner fixture failed during ${label}.`,
          { cause: error }
        );
      }
    };
    fixtureStage("contract insert", () => insert(runtime.database, "contracts", {
      id: contractId,
      league_id: PRIMARY.leagueId,
      player_id: fixture.players.amy.playerId,
      current_team_id: PRIMARY.teamTwoId,
      contract_type: "normal",
      original_total_value_cents: 400,
      original_term_years: 2,
      aav_cents: 200,
      start_season_id: PRIMARY.seasonId,
      status: "active",
      acquisition_source_type: "free_agent_draft",
      acquisition_source_id:
        fixture.players.amy.allocationId,
      auction_buyout_lock_expires_at_ms: null,
      created_at_ms: ALLOCATION_AT_MS,
      updated_at_ms: ALLOCATION_AT_MS,
      version: 1,
    }));
    fixtureStage("ownership insert", () => insert(runtime.database, "player_ownerships", {
      id: ownershipId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      player_id: fixture.players.amy.playerId,
      team_id: PRIMARY.teamTwoId,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: "D",
      slot_number: 1,
      acquired_transaction_type: "free_agent_draft",
      acquired_transaction_id:
        fixture.players.amy.allocationId,
      created_at_ms: ALLOCATION_AT_MS,
      updated_at_ms: ALLOCATION_AT_MS,
      version: 1,
      trade_blocked: 0,
    }));
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_player_allocations"
    );
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_allocation_events"
    );
    fixtureStage("allocation transition", () => runtime.database
      .prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'automatic_award',
            decision_code = 'sole_valid_offer',
            winning_snapshot_entry_id = @snapshotEntryId,
            winning_team_id = @teamId,
            contract_id = @contractId,
            ownership_id = @ownershipId,
            accounted_at_ms = @accountedAtMs,
            updated_at_ms = @accountedAtMs,
            version = 2
        WHERE league_id = @leagueId
          AND id = @allocationId
      `)
      .run({
        accountedAtMs: ALLOCATION_AT_MS,
        allocationId: fixture.players.amy.allocationId,
        contractId,
        leagueId: PRIMARY.leagueId,
        ownershipId,
        snapshotEntryId: amyOffer.snapshotEntryId,
        teamId: PRIMARY.teamTwoId,
      }));
    fixtureStage("offer event insert", () => insert(
      runtime.database,
      "free_agent_draft_allocation_events",
      {
        id: uuid(23_002),
        league_id: PRIMARY.leagueId,
        season_id: PRIMARY.seasonId,
        fad_id: PRIMARY.fadId,
        allocation_id: fixture.players.amy.allocationId,
        allocation_version: 2,
        player_id: fixture.players.amy.playerId,
        event_kind: "offer_considered",
        snapshot_entry_id: amyOffer.snapshotEntryId,
        team_id: PRIMARY.teamTwoId,
        offer_valid: 1,
        rank_position: 1,
        offer_outcome_code: "winner",
        decision_code: null,
        resulting_allocation_status: "automatic_award",
        contract_id: null,
        ownership_id: null,
        auction_id: null,
        activity_id: null,
        correction_id: null,
        actor_user_id: null,
        actor_membership_id: null,
        actor_authority: "system",
        evidence_json: "{}",
        occurred_at_ms: ALLOCATION_AT_MS,
        created_at_ms: ALLOCATION_AT_MS,
        version: 1,
      }
    ));
    const awarded =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          query: {
            cursor: null,
            limit: 50,
            q: "amy",
            status: "automatic_award",
          },
        })
      ).data[0];
    assert.deepEqual(awarded.winner, {
      teamId: PRIMARY.teamTwoId,
      snapshotEntryId: amyOffer.snapshotEntryId,
      contractId,
      ownershipId,
      slotKey: "D01",
      totalValueCents: 400,
      termYears: 2,
      aavCents: 200,
    });
    runtime.database.pragma(
      "ignore_check_constraints = ON"
    );
    try {
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_player_allocations
          SET winning_snapshot_entry_id = NULL
          WHERE league_id = ?
            AND id = ?
        `)
        .run(
          PRIMARY.leagueId,
          fixture.players.amy.allocationId
        );
    } finally {
      runtime.database.pragma(
        "ignore_check_constraints = OFF"
      );
    }
    const before = noWriteSnapshot(runtime.database);
    assertRepositoryError(
      () =>
        runtime.readRepository.readAllocationResults(
          allocationResultsInput({
            query: {
              cursor: null,
              limit: 50,
              q: "amy",
              status: "automatic_award",
            },
          })
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertNoWrites(runtime.database, before);
  });

  test("keeps a precreated delayed restricted auction private until activation", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const fixture =
      seedRestrictedActionWithoutImprovement(
        runtime.database
      );
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_player_allocations"
    );
    runtime.database
      .prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'restricted_scheduled'
        WHERE league_id = ?
          AND id = ?
      `)
      .run(PRIMARY.leagueId, fixture.allocationId);
    const before = noWriteSnapshot(runtime.database);

    const result =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          nowMs: ALLOCATION_AT_MS + 1,
          query: {
            cursor: null,
            limit: 50,
            q: "casey restricted",
            status: "restricted_scheduled",
          },
        })
      ).data[0];

    assert.equal(result.allocationId, fixture.allocationId);
    assert.deepEqual(result.restricted, {
      auctionId: null,
      status: "scheduled",
      participantTeamIds: [],
      minimumTotalValueCents: 600,
      minimumTermYears: 2,
      minimumAavCents: 300,
    });
    assert.deepEqual(result.draws, []);
    const history =
      runtime.readRepository.readPublishedCardHistory(
        publishedHistoryInput({
          teamId: PRIMARY.teamOneId,
          nowMs: ALLOCATION_AT_MS + 1,
        })
      );
    assert.deepEqual(history.slots[0].outcome, {
      code: "restricted_pending",
      allocationId: fixture.allocationId,
      auctionId: null,
    });
    assertNoWrites(runtime.database, before);
  });

  test("publishes restricted outcomes with the persisted fad_restricted draw context", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const fixture =
      seedRestrictedActionWithoutImprovement(
        runtime.database
      );
    const activeBefore = noWriteSnapshot(runtime.database);

    const results =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          nowMs: ALLOCATION_AT_MS + 1,
          query: {
            cursor: null,
            limit: 50,
            q: "casey restricted",
            status: "restricted_active",
          },
        })
      );
    assert.equal(results.data.length, 1);
    const result = results.data[0];
    assert.equal(result.allocationId, fixture.allocationId);
    assert.equal(
      result.decisionCode,
      "exact_total_and_term_tie"
    );
    assert.deepEqual(
      result.rankedOffers.map((offer) => ({
        teamId: offer.teamId,
        rank: offer.rank,
        outcomeCode: offer.outcomeCode,
      })),
      [
        {
          teamId: PRIMARY.teamThreeId,
          rank: 1,
          outcomeCode: "restricted_tied",
        },
        {
          teamId: PRIMARY.teamOneId,
          rank: 1,
          outcomeCode: "restricted_tied",
        },
      ]
    );
    assert.deepEqual(result.restricted, {
      auctionId: fixture.auctionId,
      status: "open",
      participantTeamIds: [
        PRIMARY.teamOneId,
        PRIMARY.teamThreeId,
      ],
      minimumTotalValueCents: 600,
      minimumTermYears: 2,
      minimumAavCents: 300,
    });
    assert.equal(result.fallback, null);
    assert.deepEqual(result.draws, []);

    const history =
      runtime.readRepository.readPublishedCardHistory(
        publishedHistoryInput({
          nowMs: ALLOCATION_AT_MS + 1,
        })
      );
    assert.deepEqual(history.slots[0].outcome, {
      code: "restricted_pending",
      allocationId: fixture.allocationId,
      auctionId: fixture.auctionId,
    });
    assertNoWrites(runtime.database, activeBefore);

    const terminal = terminalizeRestrictedDrawForRead(
      runtime.database,
      fixture
    );
    const terminalBefore = noWriteSnapshot(
      runtime.database
    );
    const terminalResults =
      runtime.readRepository.readAllocationResults(
        allocationResultsInput({
          nowMs: terminal.terminalAtMs,
          query: {
            cursor: null,
            limit: 50,
            q: "casey restricted",
            status: "correction_required",
          },
        })
      );
    assert.equal(terminalResults.data.length, 1);
    const terminalResult = terminalResults.data[0];
    assert.equal(
      terminalResult.allocationId,
      fixture.allocationId
    );
    assert.equal(
      terminalResult.restricted.status,
      "no_winner"
    );
    assert.equal(terminalResult.draws.length, 1);
    assert.deepEqual(terminalResult.draws[0], {
      auctionId: fixture.auctionId,
      auctionType: "fad_restricted",
      drawCommitment: fixture.drawCommitment,
      drawReveal: {
        algorithmVersion: 1,
        nonceHex: "2a".repeat(32),
        selectionUsed: false,
        orderedBidIds: [],
        counter: null,
        digestHex: null,
        selectedIndex: null,
        selectedBidId: null,
        selectedTeamId: null,
      },
    });
    assertNoWrites(runtime.database, terminalBefore);

    runtime.database
      .prepare(`
        UPDATE free_agent_draft_draws
        SET commitment_hex = ?
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        "b".repeat(64),
        PRIMARY.leagueId,
        fixture.drawId
      );
    const corruptBefore = noWriteSnapshot(
      runtime.database
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readAllocationResults(
          allocationResultsInput({
            nowMs: terminal.terminalAtMs,
            query: {
              cursor: null,
              limit: 50,
              q: "casey restricted",
              status: "correction_required",
            },
          })
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertNoWrites(runtime.database, corruptBefore);
  });

  test("does not project a restricted tie for a Candidate Card team that is no longer eligible", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const fixture =
      seedRestrictedActionWithoutImprovement(
        runtime.database
      );
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_auction_participants"
    );
    runtime.database
      .prepare(`
        UPDATE free_agent_draft_auction_participants
        SET status = 'removed',
            removed_by_user_id = @userId,
            removed_by_membership_id = @membershipId,
            removed_authority = 'commissioner',
            removal_reason = 'Foundation eligibility change',
            removed_at_ms = @removedAtMs,
            updated_at_ms = @removedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @participantId
      `)
      .run({
        leagueId: PRIMARY.leagueId,
        membershipId: PRIMARY.commissionerMembershipId,
        participantId: fixture.participantIds[0],
        removedAtMs: ALLOCATION_AT_MS + 1,
        userId: PRIMARY.commissionerUserId,
      });
    const before = noWriteSnapshot(runtime.database);

    const history =
      runtime.readRepository.readPublishedCardHistory(
        publishedHistoryInput({
          nowMs: ALLOCATION_AT_MS + 2,
        })
      );

    assert.deepEqual(history.slots[0].outcome, {
      code: "automatic_loss",
      allocationId: fixture.allocationId,
      auctionId: null,
    });
    assertNoWrites(runtime.database, before);
  });

  test("reads the internal opening preflight context without byte, semantic, or total-change writes", (t) => {
    const runtime = createRuntime(t);
    const before = noWriteSnapshot(runtime.database);

    const context =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
      });

    assertExactKeys(context, [
      "activeContracts",
      "allContracts",
      "allContractYears",
      "buyoutObligations",
      "buyoutYears",
      "currentPlayerSources",
      "currentSchedule",
      "currentScheduleJobBindings",
      "currentScheduleOperation",
      "entryDraft",
      "existingFad",
      "firstMatchupWeek",
      "league",
      "leaguePositionOverrides",
      "leagueSettings",
      "managerAssignments",
      "ownerships",
      "participatingTeams",
      "priorSeason",
      "priorSeasonBuyoutYears",
      "priorSeasonContractYears",
      "priorSeasonRollovers",
      "priorSeasonRolloverItems",
      "priorSeasonRolloverOwnershipReceipt",
      "priorSeasonRolloverReceipt",
      "priorSeasonRetentionYears",
      "readinessJob",
      "readinessOperation",
      "retentionObligations",
      "retentionYears",
      "rosterOrderEntries",
      "rosterOrderSets",
      "season",
      "setupExemptions",
      "targetContractYears",
    ]);
    assert.deepEqual(context.league, {
      leagueId: PRIMARY.leagueId,
      status: "active",
      timeZone: "America/Vancouver",
      currentSeasonId: PRIMARY.seasonId,
      commissionerMembershipId:
        PRIMARY.commissionerMembershipId,
      version: 2,
    });
    assert.equal(context.season.seasonId, PRIMARY.seasonId);
    assert.equal(context.season.version, 1);
    assert.equal(context.readinessOperation, null);
    assert.equal(context.readinessJob, null);
    assert.equal(context.existingFad, null);
    assert.deepEqual(context.allContracts, []);
    assert.deepEqual(context.rosterOrderSets, []);
    assert.deepEqual(context.rosterOrderEntries, []);
    assertExactKeys(context.currentSchedule, [
      "createdAtMs",
      "generationVersion",
      "operationId",
      "startsAtMs",
      "version",
      "weekId",
    ]);
    assert.deepEqual(context.currentSchedule, {
      operationId: PRIMARY.scheduleOperationId,
      version: 1,
      generationVersion: 1,
      weekId: PRIMARY.weekOneId,
      startsAtMs: WEEK_ONE_AT_MS,
      createdAtMs: 4,
    });
    assert.deepEqual(context.firstMatchupWeek, {
      weekId: PRIMARY.weekOneId,
      sequence: 1,
      startsAtMs: WEEK_ONE_AT_MS,
      version: 1,
    });
    assert.deepEqual(
      context.participatingTeams.map(({ teamId }) => teamId),
      [
        PRIMARY.teamOneId,
        PRIMARY.teamTwoId,
        PRIMARY.teamThreeId,
      ]
    );
    assert.deepEqual(
      context.managerAssignments.map(
        ({ managerAssignmentId }) => managerAssignmentId
      ),
      [
        PRIMARY.assignmentOneId,
        PRIMARY.assignmentTwoId,
        PRIMARY.assignmentThreeId,
      ]
    );
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.participatingTeams), true);
    assertNoWrites(runtime.database, before);
  });

  test("maps persisted Entry Draft lifecycle statuses to canonical opening-readiness domain values without writes", (t) => {
    for (const fixture of [
      {
        status: "completed",
        expected: "Complete",
        completedAtMs: 2,
      },
      {
        status: "active",
        expected: "Live",
        completedAtMs: null,
      },
    ]) {
      const runtime = createRuntime(t);
      insert(runtime.database, "entry_drafts", {
        id: uuid(fixture.status === "completed" ? 9_801 : 9_802),
        league_id: PRIMARY.leagueId,
        season_id: PRIMARY.seasonId,
        status: fixture.status,
        rounds: 4,
        pick_clock_seconds: 300,
        starts_at_ms: 1,
        completed_at_ms: fixture.completedAtMs,
        created_by_user_id: PRIMARY.commissionerUserId,
        created_at_ms: 1,
        updated_at_ms: fixture.completedAtMs ?? 1,
        version: 1,
      });
      const before = noWriteSnapshot(runtime.database);
      const context =
        runtime.readRepository.readOpeningPreflightContext({
          leagueId: PRIMARY.leagueId,
          seasonId: PRIMARY.seasonId,
        });
      assert.equal(context.entryDraft.status, fixture.expected);
      assert.equal(
        context.entryDraft.status === "Complete",
        fixture.status === "completed"
      );
      assertNoWrites(runtime.database, before);
    }
  });

  test("keeps internal preflight isolated by league and fails closed on a split readiness pair", (t) => {
    const runtime = createRuntime(t);
    ensureReadiness(runtime.database, PRIMARY);

    const secondary =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: SECONDARY.leagueId,
        seasonId: SECONDARY.seasonId,
      });
    assert.equal(secondary.league.leagueId, SECONDARY.leagueId);
    assert.equal(
      secondary.league.timeZone,
      "America/Edmonton"
    );
    assert.equal(secondary.readinessOperation, null);
    assert.deepEqual(
      secondary.participatingTeams.map(({ teamId }) => teamId),
      [SECONDARY.teamOneId]
    );

    runtime.database.pragma("foreign_keys = OFF");
    runtime.database
      .prepare("DELETE FROM job_runs WHERE id = ?")
      .run(PRIMARY.readinessJobId);
    runtime.database.pragma("foreign_keys = ON");
    assertRepositoryError(
      () =>
        runtime.readRepository.readOpeningPreflightContext({
          leagueId: PRIMARY.leagueId,
          seasonId: PRIMARY.seasonId,
        }),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
  });

  test("keeps schedule identity version distinct from the current generation CAS version", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    moveDraftToCompleted(runtime.database);
    const recovery = seedScheduleRecovery(runtime.database, {
      recoveryKind: "completion",
      attachToDraft: true,
    });
    const before = noWriteSnapshot(runtime.database);

    const context =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
      });

    assert.deepEqual(context.currentSchedule, {
      operationId: recovery.operationId,
      version: 2,
      generationVersion: 1,
      weekId: recovery.weekId,
      startsAtMs: recovery.startsAtMs,
      createdAtMs: COMPLETION_AT_MS,
    });
    assert.equal(context.firstMatchupWeek.version, 1);
    assertNoWrites(runtime.database, before);
  });

  test("isolates distinguishable player-source, carryover, contract, and schedule authority across leagues", (t) => {
    const runtime = createRuntime(t);
    const primarySentinel = seedCarryoverSentinel(
      runtime.database,
      PRIMARY,
      {
        base: 1_600,
        fullName: "Primary Carryover",
        totalValueCents: 700,
      }
    );
    const secondarySentinel = seedCarryoverSentinel(
      runtime.database,
      SECONDARY,
      {
        base: 1_700,
        fullName: "Secondary Carryover",
        totalValueCents: 900,
      }
    );

    const primary =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
      });
    const secondary =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: SECONDARY.leagueId,
        seasonId: SECONDARY.seasonId,
      });

    assert.deepEqual(
      primary.ownerships.map(({ ownershipId }) => ownershipId),
      [primarySentinel.ownershipId]
    );
    assert.deepEqual(
      primary.activeContracts.map(({ contractId }) => contractId),
      [primarySentinel.contractId]
    );
    assert.deepEqual(
      primary.allContracts.map(({ contractId }) => contractId),
      [primarySentinel.contractId]
    );
    assert.deepEqual(
      primary.targetContractYears.map(
        ({ contractYearId }) => contractYearId
      ),
      [primarySentinel.contractYearId]
    );
    assert.deepEqual(
      primary.leaguePositionOverrides.map(
        ({ positionOverrideId }) => positionOverrideId
      ),
      [primarySentinel.positionId]
    );
    assert.deepEqual(
      primary.currentPlayerSources.map(
        ({ playerSourceStateId }) => playerSourceStateId
      ),
      [primarySentinel.sourceId]
    );
    assert.equal(
      primary.currentSchedule.operationId,
      PRIMARY.scheduleOperationId
    );
    assert.equal(
      primary.currentSchedule.weekId,
      PRIMARY.weekOneId
    );

    assert.deepEqual(
      secondary.ownerships.map(({ ownershipId }) => ownershipId),
      [secondarySentinel.ownershipId]
    );
    assert.deepEqual(
      secondary.activeContracts.map(({ contractId }) => contractId),
      [secondarySentinel.contractId]
    );
    assert.deepEqual(
      secondary.allContracts.map(({ contractId }) => contractId),
      [secondarySentinel.contractId]
    );
    assert.deepEqual(
      secondary.targetContractYears.map(
        ({ contractYearId }) => contractYearId
      ),
      [secondarySentinel.contractYearId]
    );
    assert.deepEqual(
      secondary.leaguePositionOverrides.map(
        ({ positionOverrideId }) => positionOverrideId
      ),
      [secondarySentinel.positionId]
    );
    assert.deepEqual(
      secondary.currentPlayerSources.map(
        ({ playerSourceStateId }) => playerSourceStateId
      ),
      [secondarySentinel.sourceId]
    );
    assert.equal(
      secondary.currentSchedule.operationId,
      SECONDARY.scheduleOperationId
    );
    assert.equal(
      secondary.currentSchedule.weekId,
      SECONDARY.weekOneId
    );
    assert.equal(
      JSON.stringify(primary).includes(
        secondarySentinel.playerId
      ),
      false
    );
    assert.equal(
      JSON.stringify(secondary).includes(
        primarySentinel.playerId
      ),
      false
    );
  });

  test("reads populated subsequent-season schedule and rollover authority with exact camelCase shapes and league isolation", (t) => {
    const runtime = createRuntime(t);
    const fixture = seedSubsequentSeasonAuthority(
      runtime.database
    );
    const rosterOrderSetId = uuid(9_900);
    const rosterOrderEntryId = uuid(9_901);
    insert(runtime.database, "roster_display_order_sets", {
      id: rosterOrderSetId,
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      team_id: PRIMARY.teamOneId,
      updated_by_user_id: PRIMARY.commissionerUserId,
      created_at_ms: 6,
      updated_at_ms: 6,
      version: 1,
    });
    insert(runtime.database, "roster_display_order_entries", {
      id: rosterOrderEntryId,
      league_id: PRIMARY.leagueId,
      order_set_id: rosterOrderSetId,
      ownership_id: fixture.ids.ownershipId,
      position_group: "F",
      display_order: 1,
      created_at_ms: 6,
    });
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND name IN (
            'season_rollovers_valid_insert',
            'season_rollover_items_valid_insert'
          )
        ORDER BY name
      `).all().map(({ name }) => name),
      [
        "season_rollover_items_valid_insert",
        "season_rollovers_valid_insert",
      ]
    );
    const before = noWriteSnapshot(runtime.database);

    const primary =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
      });
    const secondary =
      runtime.readRepository.readOpeningPreflightContext({
        leagueId: SECONDARY.leagueId,
        seasonId: SECONDARY.seasonId,
      });

    assert.equal(primary.currentScheduleJobBindings.length, 1);
    assertExactKeys(primary.currentScheduleJobBindings[0], [
      "attemptCount",
      "bindingCreatedAtMs",
      "bindingId",
      "bindingVersion",
      "completedAtMs",
      "jobCreatedAtMs",
      "jobRunId",
      "jobStatus",
      "jobType",
      "jobUpdatedAtMs",
      "jobVersion",
      "lastErrorCode",
      "leaseExpiresAtMs",
      "leaseOwner",
      "leaseToken",
      "nextAttemptAtMs",
      "occurrenceKey",
      "owningMatchupId",
      "owningMatchupWeekId",
      "resultJson",
      "scheduleOperationId",
      "scheduleVersion",
      "scheduledForMs",
      "startedAtMs",
    ]);
    assert.equal(
      primary.currentScheduleJobBindings[0].bindingId,
      fixture.scheduleBinding.bindingId
    );
    assert.equal(
      primary.currentScheduleJobBindings[0].jobRunId,
      fixture.scheduleBinding.jobRunId
    );
    assert.equal(
      primary.currentScheduleJobBindings[0].jobType,
      "matchup:baseline"
    );
    assert.equal(
      primary.currentScheduleJobBindings[0].jobStatus,
      "pending"
    );
    assert.equal(
      primary.currentScheduleJobBindings[0]
        .scheduleOperationId,
      PRIMARY.scheduleOperationId
    );
    assert.equal(
      primary.currentScheduleJobBindings[0].scheduleVersion,
      1
    );
    assert.equal(
      primary.currentScheduleJobBindings[0]
        .owningMatchupWeekId,
      PRIMARY.weekOneId
    );
    assertExactKeys(primary.currentScheduleOperation, [
      "completedAtMs",
      "operationId",
      "operationType",
      "seasonId",
      "startedAtMs",
      "status",
    ]);
    assert.deepEqual(primary.currentScheduleOperation, {
      operationId: PRIMARY.scheduleOperationId,
      seasonId: PRIMARY.seasonId,
      operationType: "schedule_generate",
      status: "succeeded",
      startedAtMs: 3,
      completedAtMs: 4,
    });
    assertExactKeys(primary.priorSeason, [
      "freeAgentDraftCompletedAtMs",
      "nhlSeasonKey",
      "seasonId",
      "status",
      "version",
    ]);
    assert.equal(
      primary.priorSeason.seasonId,
      fixture.ids.priorSeasonId
    );
    assert.equal(primary.priorSeason.status, "completed");
    assert.deepEqual(
      primary.priorSeasonRollovers.map(
        ({ rolloverId }) => rolloverId
      ),
      [fixture.ids.rolloverId]
    );
    assertExactKeys(primary.priorSeasonRollovers[0], [
      "completedAtMs",
      "fromSeasonId",
      "manifestSha256",
      "rolloverId",
      "status",
      "toSeasonId",
      "version",
    ]);

    const receipt = primary.priorSeasonRolloverReceipt;
    assertExactKeys(receipt, [
      "completedAtMs",
      "entryDraftId",
      "entryDraftRolloverBindingId",
      "entryDraftVersion",
      "fantasyPlayoffsEndAtMs",
      "fantasyPlayoffsStartAtMs",
      "firstPickClockId",
      "fromSeasonId",
      "fromSeasonStatus",
      "fromSeasonVersion",
      "leagueId",
      "leagueVersion",
      "nhlRegularSeasonEndsAtMs",
      "nhlRegularSeasonStartsAtMs",
      "occurrenceKey",
      "retryAuthorizedAuthority",
      "retryAuthorizedByUserId",
      "rolloverAttemptId",
      "rolloverId",
      "rolloverOccurrenceId",
      "scheduledStartsAtMs",
      "sourceFadId",
      "sourceFinalizationId",
      "sourceFinalizationRootId",
      "sourceReadinessSchemaVersion",
      "sourceReadinessSha256",
      "sourceStandingsOperationId",
      "sourceStandingsSnapshotId",
      "summary",
      "targetNhlSeasonKey",
      "targetScheduleId",
      "targetScheduleVersion",
      "toSeasonId",
      "toSeasonStatus",
      "toSeasonVersion",
      "trigger",
      "version",
      "weekOneMatchupWeekId",
      "weekOneStartsAtMs",
    ]);
    assert.equal(receipt.rolloverId, fixture.ids.rolloverId);
    assert.equal(
      receipt.rolloverAttemptId,
      fixture.ids.attemptId
    );
    assert.equal(receipt.trigger, "scheduled_job");
    assert.deepEqual(receipt.summary, {
      buyoutObligationsCompleted: 0,
      buyoutYearsAdvanced: 0,
      contractsAdvanced: 1,
      contractsExpired: 0,
      ownershipsCarried: 1,
      ownershipsReleased: 0,
      retentionObligationsCompleted: 0,
      retentionYearsAdvanced: 0,
      tradesCancelled: 0,
    });

    const ownershipReceipt =
      primary.priorSeasonRolloverOwnershipReceipt;
    assertExactKeys(ownershipReceipt, [
      "fromSeasonId",
      "leagueId",
      "rolloverId",
      "teams",
      "toSeasonId",
    ]);
    assert.equal(
      ownershipReceipt.rolloverId,
      fixture.ids.rolloverId
    );
    assert.equal(ownershipReceipt.teams.length, 1);
    assertExactKeys(ownershipReceipt.teams[0], [
      "leagueId",
      "ownershipWitnesses",
      "seasonId",
      "teamId",
    ]);
    assert.deepEqual(
      ownershipReceipt.teams[0].ownershipWitnesses,
      [
        {
          ownershipId: fixture.ids.ownershipId,
          ownershipVersion: 2,
          state: "present",
        },
      ]
    );

    assert.equal(primary.priorSeasonRolloverItems.length, 2);
    for (const item of primary.priorSeasonRolloverItems) {
      assertExactKeys(item, [
      "afterJson",
      "beforeJson",
      "bindingId",
      "causalAssetsJson",
      "contractEventId",
      "createdAtMs",
      "effectKind",
      "entityId",
      "entityType",
      "fromSeasonId",
      "idempotencyRequestId",
      "itemId",
      "leagueActivityId",
      "leagueId",
      "occurredAtMs",
      "ownershipEventId",
      "payloadSha256",
      "rolloverAttemptId",
      "rolloverId",
      "rolloverOccurrenceId",
      "toSeasonId",
      "tradeEventId",
      "version",
      ]);
    }
    const ownershipItem =
      primary.priorSeasonRolloverItems.find(
        ({ effectKind }) => effectKind === "ownership_carried"
      );
    const contractItem =
      primary.priorSeasonRolloverItems.find(
        ({ effectKind }) => effectKind === "contract_advanced"
      );
    assert.equal(
      ownershipItem.itemId,
      fixture.ids.rolloverItemId
    );
    assert.equal(
      ownershipItem.ownershipEventId,
      fixture.ids.ownershipEventId
    );
    assert.equal(
      contractItem.itemId,
      fixture.ids.contractRolloverItemId
    );
    assert.equal(
      contractItem.contractEventId,
      fixture.ids.contractEventId
    );

    assert.deepEqual(
      primary.activeContracts.map(({ contractId }) => contractId),
      [
        fixture.ids.contractId,
        fixture.ids.targetRetentionContractId,
      ]
    );
    for (const contract of primary.activeContracts) {
      assertExactKeys(contract, [
        "aavCents",
        "contractId",
        "contractType",
        "currentTeamId",
        "originalTermYears",
        "originalTotalValueCents",
        "playerId",
        "startSeasonId",
        "status",
        "version",
      ]);
    }
    assert.equal(
      primary.allContracts.some(
        ({ contractId, status }) =>
          contractId === fixture.ids.targetBuyoutContractId &&
          status === "eliminated"
      ),
      true
    );
    for (const contract of primary.allContracts) {
      assertExactKeys(contract, [
        "aavCents",
        "contractId",
        "contractType",
        "currentTeamId",
        "originalTermYears",
        "originalTotalValueCents",
        "playerId",
        "startSeasonId",
        "status",
        "version",
      ]);
    }
    assert.deepEqual(
      primary.ownerships.map(({ ownershipId }) => ownershipId),
      [fixture.ids.ownershipId]
    );
    assertExactKeys(primary.ownerships[0], [
      "ownershipId",
      "ownershipKind",
      "playerId",
      "playerStatus",
      "positionGroup",
      "rosterCategory",
      "slotNumber",
      "teamId",
      "version",
    ]);
    assert.deepEqual(
      primary.targetContractYears.map(
        ({ contractYearId }) => contractYearId
      ),
      [
        fixture.ids.targetContractYearId,
        fixture.ids.targetRetentionContractYearId,
        fixture.ids.targetBuyoutContractYearId,
      ]
    );
    for (const year of primary.targetContractYears) {
      assertExactKeys(year, [
        "aavCents",
        "contractId",
        "contractYearId",
        "seasonId",
        "status",
        "yearNumber",
      ]);
    }

    assert.deepEqual(
      primary.allContractYears.map(
        ({ contractYearId }) => contractYearId
      ),
      [
        fixture.ids.priorContractYearId,
        fixture.ids.targetContractYearId,
        fixture.ids.priorRetentionContractYearId,
        fixture.ids.targetRetentionContractYearId,
        fixture.ids.priorBuyoutContractYearId,
        fixture.ids.targetBuyoutContractYearId,
      ]
    );
    for (const year of primary.allContractYears) {
      assertExactKeys(year, [
        "aavCents",
        "contractId",
        "contractYearId",
        "createdAtMs",
        "leagueId",
        "rolloverAtMs",
        "seasonId",
        "status",
        "yearNumber",
      ]);
    }
    assert.equal(
      primary.allContractYears.find(
        ({ contractYearId }) =>
          contractYearId === fixture.ids.priorContractYearId
      ).rolloverAtMs,
      fixture.rolloverAtMs
    );
    assert.equal(
      primary.allContractYears.find(
        ({ contractYearId }) =>
          contractYearId === fixture.ids.targetContractYearId
      ).rolloverAtMs,
      null
    );
    for (const year of primary.allContractYears.filter(
      ({ seasonId }) => seasonId === PRIMARY.seasonId
    )) {
      assert.equal(year.rolloverAtMs, null);
    }
    for (const year of primary.allContractYears.filter(
      ({ seasonId }) => seasonId === fixture.ids.priorSeasonId
    )) {
      assert.equal(year.rolloverAtMs, fixture.rolloverAtMs);
    }
    assert.deepEqual(
      primary.priorSeasonContractYears.map(
        ({ contractYearId }) => contractYearId
      ),
      [fixture.ids.priorContractYearId]
        .concat(
          fixture.ids.priorRetentionContractYearId,
          fixture.ids.priorBuyoutContractYearId
        )
    );
    for (const year of primary.priorSeasonContractYears) {
      assertExactKeys(year, [
        "aavCents",
        "contractId",
        "contractYearId",
        "createdAtMs",
        "leagueId",
        "rolloverAtMs",
        "seasonId",
        "status",
        "yearNumber",
      ]);
    }
    assert.deepEqual(
      primary.retentionObligations
        .map(({ obligationId }) => obligationId)
        .sort(),
      [
        fixture.ids.priorRetentionObligationId,
        fixture.ids.targetRetentionObligationId,
      ].sort()
    );
    assert.deepEqual(
      primary.retentionYears
        .map(({ retentionYearId }) => retentionYearId)
        .sort(),
      [
        fixture.ids.priorRetentionYearId,
        fixture.ids.targetRetentionYearId,
      ].sort()
    );
    assert.deepEqual(
      primary.priorSeasonRetentionYears.map(
        ({ retentionYearId }) => retentionYearId
      ),
      [fixture.ids.priorRetentionYearId]
    );
    assert.deepEqual(
      primary.buyoutObligations
        .map(({ obligationId }) => obligationId)
        .sort(),
      [
        fixture.ids.priorBuyoutObligationId,
        fixture.ids.targetBuyoutObligationId,
      ].sort()
    );
    assert.deepEqual(
      primary.buyoutYears
        .map(({ buyoutYearId }) => buyoutYearId)
        .sort(),
      [
        fixture.ids.priorBuyoutYearId,
        fixture.ids.targetBuyoutYearId,
      ].sort()
    );
    assert.deepEqual(
      primary.priorSeasonBuyoutYears.map(
        ({ buyoutYearId }) => buyoutYearId
      ),
      [fixture.ids.priorBuyoutYearId]
    );
    for (const [rows, keys] of [
      [
        primary.retentionObligations,
        [
          "contractId",
          "createdAtMs",
          "creationTradeId",
          "leagueId",
          "obligationId",
          "originatingTeamId",
          "playerId",
          "responsibleTeamId",
          "retainedAavCents",
          "status",
          "updatedAtMs",
          "version",
        ],
      ],
      [
        primary.retentionYears,
        [
          "createdAtMs",
          "leagueId",
          "retainedAavCents",
          "retentionObligationId",
          "retentionYearId",
          "seasonId",
          "status",
        ],
      ],
      [
        primary.buyoutObligations,
        [
          "annualPenaltyBasisCents",
          "buyoutTransactionId",
          "contractId",
          "createdAtMs",
          "leagueId",
          "obligationId",
          "originatingTeamId",
          "playerId",
          "responsibleTeamId",
          "status",
          "updatedAtMs",
          "version",
        ],
      ],
      [
        primary.buyoutYears,
        [
          "buyoutObligationId",
          "buyoutYearId",
          "createdAtMs",
          "leagueId",
          "penaltyCents",
          "seasonId",
          "status",
        ],
      ],
    ]) {
      for (const row of rows) {
        assertExactKeys(row, keys);
      }
    }
    assert.deepEqual(primary.rosterOrderSets, [
      {
        orderSetId: rosterOrderSetId,
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
        teamId: PRIMARY.teamOneId,
        updatedByUserId: PRIMARY.commissionerUserId,
        createdAtMs: 6,
        updatedAtMs: 6,
        version: 1,
      },
    ]);
    assert.deepEqual(primary.rosterOrderEntries, [
      {
        orderEntryId: rosterOrderEntryId,
        leagueId: PRIMARY.leagueId,
        orderSetId: rosterOrderSetId,
        ownershipId: fixture.ids.ownershipId,
        positionGroup: "F",
        displayOrder: 1,
        createdAtMs: 6,
      },
    ]);

    assert.equal(secondary.priorSeason, null);
    assert.deepEqual(secondary.currentScheduleJobBindings, []);
    assert.deepEqual(secondary.priorSeasonRollovers, []);
    assert.equal(secondary.priorSeasonRolloverReceipt, null);
    assert.equal(
      secondary.priorSeasonRolloverOwnershipReceipt,
      null
    );
    for (const key of [
      "allContracts",
      "allContractYears",
      "retentionObligations",
      "retentionYears",
      "buyoutObligations",
      "buyoutYears",
      "priorSeasonContractYears",
      "priorSeasonRetentionYears",
      "priorSeasonBuyoutYears",
      "rosterOrderSets",
      "rosterOrderEntries",
    ]) {
      assert.deepEqual(secondary[key], [], key);
    }
    for (const id of Object.values(fixture.ids)) {
      assert.equal(JSON.stringify(secondary).includes(id), false);
    }
    assertNoWrites(runtime.database, before);
  });

  test("persists independent opening foundations for both league scopes", (t) => {
    const runtime = createRuntime(t);

    const primary = openDraft(runtime.database, PRIMARY);
    const secondary = openDraft(runtime.database, SECONDARY);

    assert.equal(primary.draft.id, PRIMARY.fadId);
    assert.equal(secondary.draft.id, SECONDARY.fadId);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT league_id, id, participating_team_count
          FROM free_agent_drafts
          ORDER BY league_id
        `)
        .all(),
      [
        {
          league_id: PRIMARY.leagueId,
          id: PRIMARY.fadId,
          participating_team_count: 3,
        },
        {
          league_id: SECONDARY.leagueId,
          id: SECONDARY.fadId,
          participating_team_count: 1,
        },
      ]
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT league_id, COUNT(*) AS count
          FROM candidate_cards
          GROUP BY league_id
          ORDER BY league_id
        `)
        .all(),
      [
        { league_id: PRIMARY.leagueId, count: 3 },
        { league_id: SECONDARY.leagueId, count: 1 },
      ]
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("persists published rapid-phase queue evidence for a managed team", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    seedQueuedNomination(runtime.database);

    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            id,
            team_id,
            player_id,
            status,
            opening_total_value_cents,
            opening_term_years,
            opening_aav_cents
          FROM free_agent_draft_nomination_queue
          WHERE league_id = ?
        `)
        .get(PRIMARY.leagueId),
      {
        id: PRIMARY.nominationQueueId,
        team_id: PRIMARY.teamOneId,
        player_id: PRIMARY.playerId,
        status: "queued",
        opening_total_value_cents: 600,
        opening_term_years: 2,
        opening_aav_cents: 300,
      }
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("returns exact inactive navigation and not-triggered readiness without inventing state", (t) => {
    const runtime = createRuntime(t);
    const before = noWriteSnapshot(runtime.database);

    const navigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY)
      );
    assertNavigationShape(navigation);
    assert.deepEqual(
      navigation,
      {
        serverNowMs: PREPUBLICATION_NOW_MS,
        timeZone: "America/Vancouver",
        fadId: null,
        seasonId: null,
        phase: "inactive",
        showMainNavigation: false,
        candidateDeadlineAtMs: null,
        nextRolloverAtMs: null,
        frozenFadFirstMatchupStartsAtMs: null,
        competitionFirstMatchupStartsAtMs: null,
        managedCards: [],
        rosterLinks: [],
        urgencyCode: "NONE",
      }
    );
    const readiness =
      runtime.readRepository.readReadiness(
        readinessInput()
      );
    assertReadinessShape(readiness);
    assert.deepEqual(
      readiness,
      {
        leagueId: PRIMARY.leagueId,
        seasonId: PRIMARY.seasonId,
        operationId: null,
        operationVersion: null,
        status: "not_triggered",
        triggerKind: null,
        entryDraftId: null,
        exemptionId: null,
        serverNowMs: PREPUBLICATION_NOW_MS,
        timeZone: "America/Vancouver",
        observedSeasonVersion: null,
        firstMatchupWeekBefore: null,
        firstMatchupWeekAfter: null,
        candidateDeadlineAtMs: null,
        reminderAtMs: null,
        helpOpensAtMs: null,
        initialRollovers: [],
        priorSeasonRollover: null,
        participatingTeamCount: 0,
        teamProjections: [],
        blockers: [],
        warnings: [],
        resultFadId: null,
        retryReadiness: {
          allowed: false,
          reasonCode: "RECOVERY_NOT_AVAILABLE",
        },
      }
    );
    assertNoWrites(runtime.database, before);
  });

  test("derives active membership and commissioner authority from persisted scope", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, SECONDARY);

    assertRepositoryError(
      () =>
        runtime.readRepository.readNavigation(
          navigationInput(PRIMARY, {
            viewerMembershipId:
              SECONDARY.managerMembershipId,
          })
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readReadiness(
          readinessInput({
            viewerUserId: PRIMARY.memberUserId,
            viewerMembershipId:
              PRIMARY.memberMembershipId,
          })
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
    );
    assert.equal(
      runtime.readRepository.readReadiness(
        readinessInput({
          viewerUserId: PRIMARY.administratorUserId,
          viewerMembershipId:
            PRIMARY.administratorMembershipId,
        })
      ).status,
      "not_triggered"
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readReadiness(
          readinessInput({
            leagueId: SECONDARY.leagueId,
          })
      ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
    );
    for (const read of [
      () =>
        runtime.readRepository.readNavigation(
          navigationInput(SECONDARY, {
            viewerUserId: PRIMARY.administratorUserId,
            viewerMembershipId:
              PRIMARY.administratorMembershipId,
          })
        ),
      () =>
        runtime.readRepository.readReadiness(
          readinessInput({
            leagueId: SECONDARY.leagueId,
            seasonId: SECONDARY.seasonId,
            viewerUserId: PRIMARY.administratorUserId,
            viewerMembershipId:
              PRIMARY.administratorMembershipId,
          })
        ),
      () =>
        runtime.readRepository.readOverview(
          overviewInput({
            leagueId: SECONDARY.leagueId,
            fadId: SECONDARY.fadId,
            viewerUserId: PRIMARY.administratorUserId,
            viewerMembershipId:
              PRIMARY.administratorMembershipId,
          })
        ),
    ]) {
      assertRepositoryError(
        read,
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
      );
    }
  });

  test("fails closed for active memberships and administrator roles that have already ended", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    openDraft(runtime.database, SECONDARY);

    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET ended_at_ms = @endedAtMs,
            updated_at_ms = @endedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @membershipId
          AND status = 'active'
      `)
      .run({
        endedAtMs: PREPUBLICATION_NOW_MS,
        leagueId: PRIMARY.leagueId,
        membershipId: PRIMARY.managerMembershipId,
      });
    const endedMembershipBefore = noWriteSnapshot(
      runtime.database
    );

    for (const read of [
      () =>
        runtime.readRepository.readNavigation(
          navigationInput(PRIMARY)
        ),
      () =>
        runtime.readRepository.readOverview(
          overviewInput()
        ),
    ]) {
      assertRepositoryError(
        read,
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
      );
    }
    const secondaryNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(SECONDARY)
      );
    assert.deepEqual(
      secondaryNavigation.managedCards.map(
        ({ cardId }) => cardId
      ),
      [SECONDARY.cardOneId]
    );
    assert.equal(
      JSON.stringify(secondaryNavigation).includes(
        PRIMARY.cardOneId
      ),
      false
    );
    assertNoWrites(runtime.database, endedMembershipBefore);

    runtime.database
      .prepare(`
        UPDATE platform_roles
        SET ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
          AND status = 'active'
      `)
      .run({
        endedAtMs: PREPUBLICATION_NOW_MS,
        roleId: PRIMARY.administratorRoleId,
      });
    const endedRoleBefore = noWriteSnapshot(runtime.database);
    const administratorNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: PRIMARY.administratorUserId,
          viewerMembershipId:
            PRIMARY.administratorMembershipId,
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamOneId,
        })
      );
    const administratorOverview =
      runtime.readRepository.readOverview(
        overviewInput({
          viewerUserId: PRIMARY.administratorUserId,
          viewerMembershipId:
            PRIMARY.administratorMembershipId,
        })
      );

    assert.deepEqual(administratorNavigation.managedCards, []);
    assert.deepEqual(administratorNavigation.rosterLinks, []);
    assert.deepEqual(administratorOverview.viewer, {
      managedCards: [],
      commissionerCards: [],
      queuedNominations: [],
    });
    assert.deepEqual(
      administratorOverview.capabilities.viewRecovery,
      {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      }
    );
    for (const privateId of [
      PRIMARY.cardOneId,
      PRIMARY.cardTwoId,
      PRIMARY.cardThreeId,
    ]) {
      assert.equal(
        JSON.stringify({
          administratorNavigation,
          administratorOverview,
        }).includes(privateId),
        false
      );
    }
    assertRepositoryError(
      () =>
        runtime.readRepository.readReadiness(
          readinessInput({
            viewerUserId: PRIMARY.administratorUserId,
            viewerMembershipId:
              PRIMARY.administratorMembershipId,
          })
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
    );
    assert.equal(
      runtime.readRepository.readReadiness(
        readinessInput()
      ).resultFadId,
      PRIMARY.fadId
    );
    assertNoWrites(runtime.database, endedRoleBefore);
  });

  test("requires an accepted timestamp for every private manager card, roster, queue, and restricted-action projection", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const setManagerAcceptance = (database, acceptedAtMs) => {
      let result;
      try {
        result = database
          .prepare(`
            UPDATE team_manager_assignments
            SET accepted_at_ms = @acceptedAtMs
            WHERE league_id = @leagueId
              AND id IN (@assignmentOneId, @assignmentTwoId)
              AND status = 'accepted'
              AND ended_at_ms IS NULL
          `)
          .run({
            acceptedAtMs,
            leagueId: PRIMARY.leagueId,
            assignmentOneId: PRIMARY.assignmentOneId,
            assignmentTwoId: PRIMARY.assignmentTwoId,
          });
      } catch (error) {
        throw new Error(
          `Failed to persist manager accepted_at_ms=${String(
            acceptedAtMs
          )}: ${error.message}`,
          { cause: error }
        );
      }
      assert.equal(result.changes, 2);
    };

    setManagerAcceptance(runtime.database, null);
    const privateCardsBefore = noWriteSnapshot(runtime.database);
    const privateNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamOneId,
        })
      );
    const privateOverview =
      runtime.readRepository.readOverview(overviewInput());
    assert.deepEqual(privateNavigation.managedCards, []);
    assert.deepEqual(privateNavigation.rosterLinks, []);
    assert.deepEqual(privateOverview.viewer, {
      managedCards: [],
      commissionerCards: [],
      queuedNominations: [],
    });
    for (const privateId of [
      PRIMARY.cardOneId,
      PRIMARY.cardTwoId,
      PRIMARY.assignmentOneId,
      PRIMARY.assignmentTwoId,
    ]) {
      assert.equal(
        JSON.stringify({
          privateNavigation,
          privateOverview,
        }).includes(privateId),
        false
      );
    }
    assertNoWrites(runtime.database, privateCardsBefore);

    const rapidRuntime = createRuntime(t);
    openDraft(rapidRuntime.database, PRIMARY);
    let nomination;
    try {
      seedRestrictedActionWithoutImprovement(
        rapidRuntime.database
      );
    } catch (error) {
      throw new Error(
        `Failed to seed restricted read evidence: ${error.message}`,
        { cause: error }
      );
    }
    try {
      nomination = seedQueuedNomination(rapidRuntime.database);
    } catch (error) {
      throw new Error(
        `Failed to seed queued read evidence: ${error.message}`,
        { cause: error }
      );
    }
    setManagerAcceptance(rapidRuntime.database, null);
    const rapidNowMs = nomination.acceptedAtMs + 1;
    const privateRapidBefore = noWriteSnapshot(
      rapidRuntime.database
    );
    const rapidNavigation =
      rapidRuntime.readRepository.readNavigation(
        navigationInput(PRIMARY, { nowMs: rapidNowMs })
      );
    const rapidOverview =
      rapidRuntime.readRepository.readOverview(
        overviewInput({ nowMs: rapidNowMs })
      );

    assert.equal(rapidNavigation.phase, "rapid");
    assert.deepEqual(rapidNavigation.managedCards, []);
    assert.notEqual(
      rapidNavigation.urgencyCode,
      "RESTRICTED_ACTION_REQUIRED"
    );
    assert.deepEqual(rapidOverview.viewer.managedCards, []);
    assert.deepEqual(rapidOverview.viewer.queuedNominations, []);
    for (const privateValue of [
      PRIMARY.nominationQueueId,
      PRIMARY.playerId,
      "Alex Example",
    ]) {
      assert.equal(
        JSON.stringify({
          rapidNavigation,
          rapidOverview,
        }).includes(privateValue),
        false,
        `stale manager projection exposed ${privateValue}`
      );
    }
    assertNoWrites(rapidRuntime.database, privateRapidBefore);

    setManagerAcceptance(rapidRuntime.database, 1);
    const reauthorizedBefore = noWriteSnapshot(
      rapidRuntime.database
    );
    const reauthorizedNavigation =
      rapidRuntime.readRepository.readNavigation(
        navigationInput(PRIMARY, { nowMs: rapidNowMs })
      );
    const reauthorizedOverview =
      rapidRuntime.readRepository.readOverview(
        overviewInput({ nowMs: rapidNowMs })
      );
    assert.equal(
      reauthorizedNavigation.managedCards.find(
        ({ teamId }) => teamId === PRIMARY.teamOneId
      ).urgencyCode,
      "RESTRICTED_ACTION_REQUIRED"
    );
    assert.deepEqual(
      reauthorizedOverview.viewer.queuedNominations.map(
        ({ queueId }) => queueId
      ),
      [PRIMARY.nominationQueueId]
    );
    assertNoWrites(rapidRuntime.database, reauthorizedBefore);
  });

  test("isolates simultaneous two-league cards, help, queues, and roster descriptors for one user", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    openDraft(runtime.database, SECONDARY);
    seedActiveHelpRequest(runtime.database, PRIMARY);
    seedActiveHelpRequest(runtime.database, SECONDARY);
    const prepublicationBefore = noWriteSnapshot(runtime.database);

    const primaryNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY)
      );
    const secondaryNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(SECONDARY)
      );
    const primaryOverview =
      runtime.readRepository.readOverview(
        overviewInput()
      );
    const secondaryOverview =
      runtime.readRepository.readOverview(
        overviewInput({
          leagueId: SECONDARY.leagueId,
          fadId: SECONDARY.fadId,
          viewerMembershipId:
            SECONDARY.managerMembershipId,
        })
      );

    assert.deepEqual(
      primaryNavigation.managedCards.map(({ cardId }) => cardId),
      [PRIMARY.cardOneId, PRIMARY.cardTwoId]
    );
    assert.deepEqual(
      secondaryNavigation.managedCards.map(({ cardId }) => cardId),
      [SECONDARY.cardOneId]
    );
    assert.equal(
      secondaryNavigation.managedCards[0].helpRequestStatus,
      "active"
    );
    assert.deepEqual(
      primaryOverview.viewer.managedCards.map(({ cardId }) => cardId),
      [PRIMARY.cardOneId, PRIMARY.cardTwoId]
    );
    assert.deepEqual(
      secondaryOverview.viewer.managedCards.map(({ cardId }) => cardId),
      [SECONDARY.cardOneId]
    );
    assert.equal(
      secondaryOverview.viewer.managedCards[0].helpRequestStatus,
      "active"
    );
    for (const [projection, forbiddenIds] of [
      [
        { primaryNavigation, primaryOverview },
        [
          SECONDARY.cardOneId,
          SECONDARY.helpRequestId,
          SECONDARY.leagueId,
        ],
      ],
      [
        { secondaryNavigation, secondaryOverview },
        [
          PRIMARY.cardOneId,
          PRIMARY.cardTwoId,
          PRIMARY.cardThreeId,
          PRIMARY.helpRequestId,
          PRIMARY.leagueId,
        ],
      ],
    ]) {
      const serialized = JSON.stringify(projection);
      for (const forbiddenId of forbiddenIds) {
        assert.equal(serialized.includes(forbiddenId), false);
      }
    }
    assert.deepEqual(
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          rosterSeasonId: SECONDARY.seasonId,
          rosterTeamId: SECONDARY.teamOneId,
        })
      ).rosterLinks,
      []
    );
    assert.deepEqual(
      runtime.readRepository.readNavigation(
        navigationInput(SECONDARY, {
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamOneId,
        })
      ).rosterLinks,
      []
    );
    assertNoWrites(runtime.database, prepublicationBefore);

    moveDraftToRapid(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database, SECONDARY);
    const primaryNomination = seedQueuedNomination(
      runtime.database,
      PRIMARY
    );
    const secondaryNomination = seedQueuedNomination(
      runtime.database,
      SECONDARY
    );
    const primaryRapidNowMs =
      primaryNomination.acceptedAtMs + 1;
    const secondaryRapidNowMs =
      secondaryNomination.acceptedAtMs + 1;
    assert.ok(
      primaryRapidNowMs <
        primaryNomination.rollsOverAtMs
    );
    assert.ok(
      secondaryRapidNowMs <
        secondaryNomination.rollsOverAtMs
    );
    const rapidBefore = noWriteSnapshot(runtime.database);
    const primaryRapid = runtime.readRepository.readOverview(
      overviewInput({ nowMs: primaryRapidNowMs })
    );
    const secondaryRapid = runtime.readRepository.readOverview(
      overviewInput({
        leagueId: SECONDARY.leagueId,
        fadId: SECONDARY.fadId,
        viewerMembershipId:
          SECONDARY.managerMembershipId,
        nowMs: secondaryRapidNowMs,
      })
    );

    assert.deepEqual(
      primaryRapid.viewer.queuedNominations.map(
        ({ queueId, player }) => ({
          queueId,
          playerFullName: player.fullName,
        })
      ),
      [
        {
          queueId: PRIMARY.nominationQueueId,
          playerFullName: "Alex Example",
        },
      ]
    );
    assert.deepEqual(
      secondaryRapid.viewer.queuedNominations.map(
        ({ queueId, player }) => ({
          queueId,
          playerFullName: player.fullName,
        })
      ),
      [
        {
          queueId: SECONDARY.nominationQueueId,
          playerFullName: "Blair Boundary",
        },
      ]
    );
    assert.equal(
      JSON.stringify(primaryRapid).includes(
        SECONDARY.nominationQueueId
      ),
      false
    );
    assert.equal(
      JSON.stringify(secondaryRapid).includes(
        PRIMARY.nominationQueueId
      ),
      false
    );
    assertNoWrites(runtime.database, rapidBefore);
  });

  test("projects two managed Candidate Cards and current roster descriptors without competitor details", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);

    const navigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY)
      );

    assertNavigationShape(navigation);
    assert.equal(navigation.fadId, PRIMARY.fadId);
    assert.equal(navigation.seasonId, PRIMARY.seasonId);
    assert.equal(navigation.phase, "help_window");
    assert.equal(navigation.showMainNavigation, true);
    assert.equal(
      navigation.candidateDeadlineAtMs,
      CANDIDATE_DEADLINE_AT_MS
    );
    assert.equal(navigation.nextRolloverAtMs, null);
    assert.equal(
      navigation.frozenFadFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(
      navigation.competitionFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.deepEqual(
      navigation.managedCards.map(({ teamId }) => teamId),
      [PRIMARY.teamOneId, PRIMARY.teamTwoId]
    );
    for (const card of navigation.managedCards) {
      assert.deepEqual(Object.keys(card).sort(), [
        "allocationEligibility",
        "capStatus",
        "cardId",
        "cardVersion",
        "completenessCode",
        "conflictCount",
        "helpRequestStatus",
        "lifecycleStatus",
        "managerAssignmentId",
        "missingMandatoryCount",
        "team",
        "teamId",
        "urgencyCode",
      ]);
      assert.equal(card.lifecycleStatus, "open");
      assert.equal(card.completenessCode, "incomplete");
      assert.equal(card.missingMandatoryCount, 18);
      assert.equal(card.conflictCount, 0);
      assert.equal(card.capStatus, "compliant");
      assert.equal(card.allocationEligibility, "eligible");
      assert.equal(card.helpRequestStatus, "not_requested");
      assert.equal(card.urgencyCode, "HELP_WINDOW_INCOMPLETE");
      assert.equal("slots" in card, false);
      assert.equal("entries" in card, false);
      assert.equal("helpMessage" in card, false);
    }
    assert.deepEqual(
      navigation.rosterLinks,
      navigation.managedCards.map((card) => ({
        mode: "private_card",
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        teamId: card.teamId,
        cardId: card.cardId,
        authorizationEvidence: {
          kind: "manager_assignment",
          id: card.managerAssignmentId,
        },
      }))
    );
    assert.equal(
      navigation.urgencyCode,
      "HELP_WINDOW_INCOMPLETE"
    );
  });

  test("derives CARD_INCOMPLETE before the help window opens", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const before = noWriteSnapshot(runtime.database);

    const navigation = runtime.readRepository.readNavigation(
      navigationInput(PRIMARY, {
        nowMs: OPENED_AT_MS + 1,
      })
    );

    assertNavigationShape(navigation);
    assert.equal(navigation.phase, "cards_open");
    assert.equal(navigation.urgencyCode, "CARD_INCOMPLETE");
    assert.deepEqual(
      navigation.managedCards.map(({ urgencyCode }) => urgencyCode),
      ["CARD_INCOMPLETE", "CARD_INCOMPLETE"]
    );
    assertNoWrites(runtime.database, before);
  });

  test("uses fixed CARD_CONFLICTED precedence across managed cards", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const conflict = seedAuthoritativeCandidateConflict(
      runtime.database
    );
    const before = noWriteSnapshot(runtime.database);

    const navigation = runtime.readRepository.readNavigation(
      navigationInput(PRIMARY)
    );

    assertNavigationShape(navigation);
    assert.equal(navigation.phase, "help_window");
    assert.equal(navigation.urgencyCode, "CARD_CONFLICTED");
    assert.deepEqual(
      Object.fromEntries(
        navigation.managedCards.map((card) => [
          card.teamId,
          card.urgencyCode,
        ])
      ),
      {
        [PRIMARY.teamOneId]: "CARD_CONFLICTED",
        [PRIMARY.teamTwoId]: "HELP_WINDOW_INCOMPLETE",
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            placement_state,
            conflict_code,
            eligibility_status,
            validation_code,
            last_edited_by_authority,
            updated_at_ms
          FROM candidate_card_entries
          WHERE league_id = ?
            AND card_id = ?
            AND id = ?
        `)
        .get(
          PRIMARY.leagueId,
          PRIMARY.cardOneId,
          conflict.candidateEntryId
        ),
      {
        placement_state: "conflict",
        conflict_code: conflict.conflictCode,
        eligibility_status: "invalid",
        validation_code: conflict.conflictCode,
        last_edited_by_authority: "system",
        updated_at_ms: conflict.synchronizedAtMs,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            completeness_code,
            blocking_validation_count,
            structural_conflict_count
          FROM candidate_cards
          WHERE league_id = ?
            AND id = ?
        `)
        .get(PRIMARY.leagueId, PRIMARY.cardOneId),
      {
        completeness_code: "conflicted",
        blocking_validation_count: 1,
        structural_conflict_count: 1,
      }
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
    assertNoWrites(runtime.database, before);
  });

  test("uses DEADLINE_PROCESSING at the exact deadline regardless of card state", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const before = noWriteSnapshot(runtime.database);

    const navigation = runtime.readRepository.readNavigation(
      navigationInput(PRIMARY, {
        nowMs: CANDIDATE_DEADLINE_AT_MS,
      })
    );

    assertNavigationShape(navigation);
    assert.equal(navigation.phase, "deadline_processing");
    assert.equal(navigation.urgencyCode, "DEADLINE_PROCESSING");
    assert.ok(
      navigation.managedCards.every(
        ({ urgencyCode }) => urgencyCode === "DEADLINE_PROCESSING"
      )
    );
    assertNoWrites(runtime.database, before);
  });

  test("applies the optional roster descriptor pair and exact active help privacy", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    seedActiveHelpRequest(runtime.database);

    const managerScoped =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamTwoId,
        })
      );
    assert.equal(managerScoped.rosterLinks.length, 1);
    assert.deepEqual(managerScoped.rosterLinks[0], {
      mode: "private_card",
      seasonId: PRIMARY.seasonId,
      fadId: PRIMARY.fadId,
      teamId: PRIMARY.teamTwoId,
      cardId: PRIMARY.cardTwoId,
      authorizationEvidence: {
        kind: "manager_assignment",
        id: PRIMARY.assignmentTwoId,
      },
    });
    assert.deepEqual(
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamThreeId,
        })
      ).rosterLinks,
      []
    );

    const commissioner =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: PRIMARY.commissionerUserId,
          viewerMembershipId:
            PRIMARY.commissionerMembershipId,
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamThreeId,
        })
      );
    assert.deepEqual(commissioner.managedCards, []);
    assert.deepEqual(commissioner.rosterLinks, [
      {
        mode: "private_card",
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        teamId: PRIMARY.teamThreeId,
        cardId: PRIMARY.cardThreeId,
        authorizationEvidence: {
          kind: "help_request",
          id: PRIMARY.helpRequestId,
        },
      },
    ]);
    assert.equal(
      JSON.stringify(commissioner).includes(
        "Please help me finish this card."
      ),
      false
    );

    assert.throws(
      () =>
        runtime.readRepository.readNavigation(
          navigationInput(PRIMARY, {
            rosterSeasonId: PRIMARY.seasonId,
            rosterTeamId: null,
          })
        ),
      (error) =>
        error.code === REPOSITORY_ERROR_CODES.argumentInvalid
    );
  });

  test("expires commissioner help access from the server clock without mutating the request", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    seedActiveHelpRequest(runtime.database);
    const commissionerInput = {
      viewerUserId: PRIMARY.commissionerUserId,
      viewerMembershipId:
        PRIMARY.commissionerMembershipId,
      rosterSeasonId: PRIMARY.seasonId,
      rosterTeamId: PRIMARY.teamThreeId,
    };

    assert.equal(
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          ...commissionerInput,
          nowMs: CANDIDATE_DEADLINE_AT_MS - 1,
        })
      ).rosterLinks.length,
      1
    );
    const before = noWriteSnapshot(runtime.database);
    const expiredNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          ...commissionerInput,
          nowMs: CANDIDATE_DEADLINE_AT_MS,
        })
      );
    const expiredOverview =
      runtime.readRepository.readOverview(
        overviewInput({
          viewerUserId: PRIMARY.commissionerUserId,
          viewerMembershipId:
            PRIMARY.commissionerMembershipId,
          nowMs: CANDIDATE_DEADLINE_AT_MS,
        })
      );

    assert.equal(expiredNavigation.phase, "deadline_processing");
    assert.deepEqual(expiredNavigation.rosterLinks, []);
    const expiredHelpCard =
      expiredOverview.viewer.commissionerCards.find(
        ({ teamId }) => teamId === PRIMARY.teamThreeId
      );
    assert.equal(expiredHelpCard.helpRequestStatus, "expired");
    assert.equal(
      expiredHelpCard.helpRequestId,
      PRIMARY.helpRequestId
    );
    assert.equal(
      expiredHelpCard.helpRequestedAtMs,
      PREPUBLICATION_NOW_MS
    );
    assert.deepEqual(expiredHelpCard.openPrivateCard, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });
    assert.equal(
      JSON.stringify(expiredOverview).includes(
        "Please help me finish this card."
      ),
      false
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, version, updated_at_ms
          FROM candidate_card_help_requests
          WHERE league_id = ?
            AND id = ?
        `)
        .get(PRIMARY.leagueId, PRIMARY.helpRequestId),
      {
        status: "active",
        version: 1,
        updated_at_ms: PREPUBLICATION_NOW_MS,
      }
    );
    assertNoWrites(runtime.database, before);
  });

  test("follows a live manager transfer for T-126 and T-129 authorization", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const newManagerUserId = uuid(1_900);
    const newManagerMembershipId = uuid(1_901);
    const replacementAssignmentId = uuid(1_902);
    seedUser(runtime.database, newManagerUserId, "Replacement Manager");
    seedMembership(runtime.database, {
      id: newManagerMembershipId,
      leagueId: PRIMARY.leagueId,
      userId: newManagerUserId,
      permissionCategory: "manager",
    });
    const assignments =
      createSqliteTeamManagerAssignmentRepository({
        database: runtime.database,
      });
    const changedAtMs = PREPUBLICATION_NOW_MS + 1;
    runtime.database.exec("BEGIN IMMEDIATE");
    try {
      assignments.insertPendingAssignment({
        id: replacementAssignmentId,
        leagueId: PRIMARY.leagueId,
        teamId: PRIMARY.teamOneId,
        userId: newManagerUserId,
        membershipId: newManagerMembershipId,
        assignedByUserId: PRIMARY.commissionerUserId,
        replacesAssignmentId: PRIMARY.assignmentOneId,
        nowMs: changedAtMs,
      });
      assignments.endAssignment({
        leagueId: PRIMARY.leagueId,
        assignmentId: PRIMARY.assignmentOneId,
        expectedVersion: 1,
        nowMs: changedAtMs,
      });
      assignments.acceptAssignment({
        leagueId: PRIMARY.leagueId,
        assignmentId: replacementAssignmentId,
        expectedVersion: 1,
        nowMs: changedAtMs,
      });
      runtime.database.exec("COMMIT");
    } catch (error) {
      if (runtime.database.inTransaction) {
        runtime.database.exec("ROLLBACK");
      }
      throw error;
    }
    const before = noWriteSnapshot(runtime.database);

    const oldNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY)
      );
    const oldOverview =
      runtime.readRepository.readOverview(
        overviewInput()
      );
    const newNavigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: newManagerUserId,
          viewerMembershipId: newManagerMembershipId,
        })
      );
    const newOverview =
      runtime.readRepository.readOverview(
        overviewInput({
          viewerUserId: newManagerUserId,
          viewerMembershipId: newManagerMembershipId,
        })
      );

    assert.deepEqual(
      oldNavigation.managedCards.map(({ teamId }) => teamId),
      [PRIMARY.teamTwoId]
    );
    assert.deepEqual(
      oldOverview.viewer.managedCards.map(({ teamId }) => teamId),
      [PRIMARY.teamTwoId]
    );
    assert.deepEqual(
      newNavigation.managedCards.map(
        ({ teamId, managerAssignmentId }) => ({
          teamId,
          managerAssignmentId,
        })
      ),
      [
        {
          teamId: PRIMARY.teamOneId,
          managerAssignmentId: replacementAssignmentId,
        },
      ]
    );
    assert.deepEqual(
      newOverview.viewer.managedCards.map(
        ({ teamId, managerAssignmentId }) => ({
          teamId,
          managerAssignmentId,
        })
      ),
      [
        {
          teamId: PRIMARY.teamOneId,
          managerAssignmentId: replacementAssignmentId,
        },
      ]
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
    assertNoWrites(runtime.database, before);
  });

  test("follows a live commissioner reassignment for T-127 and T-129 authority", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const newCommissionerUserId = uuid(1_910);
    const newCommissionerMembershipId = uuid(1_911);
    seedUser(
      runtime.database,
      newCommissionerUserId,
      "Replacement Commissioner"
    );
    seedMembership(runtime.database, {
      id: newCommissionerMembershipId,
      leagueId: PRIMARY.leagueId,
      userId: newCommissionerUserId,
      permissionCategory: "commissioner",
    });
    const commissioners =
      createSqliteCommissionerAssignmentRepository({
        database: runtime.database,
      });
    const league = commissioners.findLeagueById(PRIMARY.leagueId);
    runtime.database.exec("BEGIN IMMEDIATE");
    try {
      commissioners.setLeagueCommissioner({
        leagueId: PRIMARY.leagueId,
        membershipId: newCommissionerMembershipId,
        expectedVersion: league.version,
        nowMs: PREPUBLICATION_NOW_MS + 1,
      });
      runtime.database.exec("COMMIT");
    } catch (error) {
      if (runtime.database.inTransaction) {
        runtime.database.exec("ROLLBACK");
      }
      throw error;
    }
    const before = noWriteSnapshot(runtime.database);

    assertRepositoryError(
      () =>
        runtime.readRepository.readReadiness(
          readinessInput()
        ),
      FREE_AGENT_DRAFT_READ_REPOSITORY_CODES.authorizationDenied
    );
    const replacementReadiness =
      runtime.readRepository.readReadiness(
        readinessInput({
          viewerUserId: newCommissionerUserId,
          viewerMembershipId: newCommissionerMembershipId,
        })
      );
    assert.equal(replacementReadiness.status, "succeeded");
    assert.equal(replacementReadiness.resultFadId, PRIMARY.fadId);

    const formerCommissioner =
      runtime.readRepository.readOverview(
        overviewInput({
          viewerUserId: PRIMARY.commissionerUserId,
          viewerMembershipId:
            PRIMARY.commissionerMembershipId,
        })
      );
    const replacementCommissioner =
      runtime.readRepository.readOverview(
        overviewInput({
          viewerUserId: newCommissionerUserId,
          viewerMembershipId: newCommissionerMembershipId,
        })
      );
    assert.deepEqual(
      formerCommissioner.viewer.commissionerCards,
      []
    );
    assert.deepEqual(
      formerCommissioner.capabilities.viewRecovery,
      {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      }
    );
    assert.equal(
      formerCommissioner.counts.cardsLocked,
      null
    );
    assert.equal(
      replacementCommissioner.viewer.commissionerCards.length,
      3
    );
    assert.deepEqual(
      replacementCommissioner.capabilities.viewRecovery,
      {
        allowed: true,
        reasonCode: null,
      }
    );
    assert.equal(
      replacementCommissioner.counts.cardsLocked,
      0
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
    assertNoWrites(runtime.database, before);
  });

  test("reads only the latest immutable readiness attempt and never couples T-127 to live preflight", (t) => {
    const runtime = createRuntime(t);
    blockReadiness(runtime.database);
    addSecondBlockedReadinessAttempt(runtime.database);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT attempt_number, outcome, version
          FROM free_agent_draft_readiness_attempts
          WHERE league_id = ?
            AND readiness_operation_id = ?
          ORDER BY attempt_number
        `)
        .all(
          PRIMARY.leagueId,
          PRIMARY.readinessOperationId
        ),
      [
        { attempt_number: 1, outcome: "blocked", version: 1 },
        { attempt_number: 2, outcome: "blocked", version: 1 },
      ]
    );
    const before = noWriteSnapshot(runtime.database);

    runtime.database
      .prepare(`
        UPDATE teams
        SET name = 'Changed After Attempt',
            name_normalized = 'changed after attempt',
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @teamId
      `)
      .run({
        leagueId: PRIMARY.leagueId,
        teamId: PRIMARY.teamOneId,
        updatedAtMs: OPENED_AT_MS + 1,
      });
    const afterLiveChange = noWriteSnapshot(runtime.database);
    const readiness =
      runtime.readRepository.readReadiness(
        readinessInput()
    );

    assertReadinessShape(readiness);
    assert.equal(readiness.operationId, PRIMARY.readinessOperationId);
    assert.equal(readiness.operationVersion, 6);
    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.triggerKind, "no_draft_inaugural");
    assert.equal(readiness.entryDraftId, null);
    assert.equal(readiness.exemptionId, null);
    assert.equal(readiness.observedSeasonVersion, 1);
    assert.deepEqual(readiness.firstMatchupWeekBefore, {
      weekId: PRIMARY.weekOneId,
      sequence: 1,
      startsAtMs: WEEK_ONE_AT_MS,
      version: 1,
    });
    assert.equal(readiness.firstMatchupWeekAfter, null);
    assert.equal(
      readiness.teamProjections[0].team.name,
      "Newest Frozen Snow Owls"
    );
    assert.equal(
      readiness.teamProjections.some(
        ({ team }) => team.name === "Changed After Attempt"
      ),
      false
    );
    assert.deepEqual(readiness.blockers, [
      {
        code: "MATCHUP_WEEK_MISSING",
        message: "The latest attempt could not resolve Week 1.",
        resourceId: PRIMARY.weekOneId,
      },
    ]);
    assert.deepEqual(readiness.warnings, []);
    assert.deepEqual(readiness.initialRollovers, []);
    assert.equal(readiness.resultFadId, null);
    assert.deepEqual(readiness.retryReadiness, {
      allowed: true,
      reasonCode: null,
    });
    assertNoWrites(runtime.database, afterLiveChange);
    assert.notDeepEqual(afterLiveChange, before);
  });

  test("returns the successful immutable readiness clock, all seven opening rollovers, and result FAD identity", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const before = noWriteSnapshot(runtime.database);

    const readiness =
      runtime.readRepository.readReadiness(
        readinessInput()
      );

    assertReadinessShape(readiness);
    assert.equal(readiness.status, "succeeded");
    assert.equal(readiness.observedSeasonVersion, 1);
    assert.deepEqual(readiness.firstMatchupWeekBefore, {
      weekId: PRIMARY.weekOneId,
      sequence: 1,
      startsAtMs: WEEK_ONE_AT_MS,
      version: 1,
    });
    assert.deepEqual(
      readiness.firstMatchupWeekAfter,
      readiness.firstMatchupWeekBefore
    );
    assert.equal(
      readiness.candidateDeadlineAtMs,
      CANDIDATE_DEADLINE_AT_MS
    );
    assert.equal(
      readiness.reminderAtMs,
      CANDIDATE_DEADLINE_AT_MS -
        3 * FREE_AGENT_DRAFT_DAY_MS
    );
    assert.equal(readiness.helpOpensAtMs, HELP_OPENS_AT_MS);
    assert.equal(
      readiness.initialRollovers.length,
      FREE_AGENT_DRAFT_INITIAL_ROLLOVER_COUNT
    );
    assert.deepEqual(
      readiness.initialRollovers,
      initialRolloverProjection()
    );
    assert.equal(readiness.participatingTeamCount, 3);
    assert.equal(readiness.teamProjections.length, 3);
    assert.deepEqual(readiness.blockers, []);
    assert.deepEqual(readiness.warnings, []);
    assert.equal(readiness.resultFadId, PRIMARY.fadId);
    assert.deepEqual(readiness.retryReadiness, {
      allowed: false,
      reasonCode: "RECOVERY_NOT_AVAILABLE",
    });
    assertNoWrites(runtime.database, before);
  });

  test("denies readiness retry at the terminal instant or when persisted canonical job evidence is split", (t) => {
    const cases = [
      {
        label: "terminal instant",
        mutate(database) {
          return database
            .prepare(`
              SELECT terminal_at_ms AS nowMs
              FROM free_agent_draft_readiness_operations
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              PRIMARY.leagueId,
              PRIMARY.readinessOperationId
            ).nowMs;
        },
      },
      {
        label: "readiness and job version split",
        mutate(database) {
          dropTableTriggers(database, "job_runs");
          database
            .prepare(`
              UPDATE job_runs
              SET version = version + 1
              WHERE league_id = ?
                AND id = ?
            `)
            .run(
              PRIMARY.leagueId,
              PRIMARY.readinessJobId
            );
          return PREPUBLICATION_NOW_MS;
        },
      },
      {
        label: "noncanonical blockers JSON",
        mutate(database) {
          const blocker = JSON.parse(
            database
              .prepare(`
                SELECT blockers_json
                FROM free_agent_draft_readiness_operations
                WHERE league_id = ?
                  AND id = ?
              `)
              .get(
                PRIMARY.leagueId,
                PRIMARY.readinessOperationId
              ).blockers_json
          )[0];
          const noncanonical = JSON.stringify([
            {
              message: blocker.message,
              resourceType: blocker.resourceType,
              resourceId: blocker.resourceId,
              field: blocker.field,
              code: blocker.code,
            },
          ]);
          assert.notEqual(
            noncanonical,
            serializeCanonicalJsonV1([blocker])
          );
          dropTableTriggers(
            database,
            "free_agent_draft_readiness_operations"
          );
          database
            .prepare(`
              UPDATE free_agent_draft_readiness_operations
              SET blockers_json = ?
              WHERE league_id = ?
                AND id = ?
            `)
            .run(
              noncanonical,
              PRIMARY.leagueId,
              PRIMARY.readinessOperationId
            );
          return PREPUBLICATION_NOW_MS;
        },
      },
      {
        label: "invalid trigger binding",
        mutate(database) {
          const invalidOccurrenceKey =
            buildFreeAgentDraftReadinessOccurrenceKey({
              leagueId: PRIMARY.leagueId,
              seasonId: PRIMARY.seasonId,
              triggerResourceId: PRIMARY.teamOneId,
            });
          dropTableTriggers(
            database,
            "free_agent_draft_readiness_operations"
          );
          dropTableTriggers(database, "job_runs");
          database
            .prepare(`
              UPDATE free_agent_draft_readiness_operations
              SET readiness_occurrence_key = ?
              WHERE league_id = ?
                AND id = ?
            `)
            .run(
              invalidOccurrenceKey,
              PRIMARY.leagueId,
              PRIMARY.readinessOperationId
            );
          database
            .prepare(`
              UPDATE job_runs
              SET occurrence_key = ?
              WHERE league_id = ?
                AND id = ?
            `)
            .run(
              invalidOccurrenceKey,
              PRIMARY.leagueId,
              PRIMARY.readinessJobId
            );
          return PREPUBLICATION_NOW_MS;
        },
      },
    ];

    for (const item of cases) {
      const runtime = createRuntime(t);
      blockReadiness(runtime.database);
      const nowMs = item.mutate(runtime.database);
      const before = noWriteSnapshot(runtime.database);
      const readiness =
        runtime.readRepository.readReadiness(
          readinessInput({ nowMs })
        );
      assertReadinessShape(readiness);
      assert.equal(
        readiness.status,
        "blocked",
        item.label
      );
      assert.deepEqual(
        readiness.retryReadiness,
        {
          allowed: false,
          reasonCode: "RECOVERY_NOT_AVAILABLE",
        },
        item.label
      );
      assertNoWrites(runtime.database, before);
    }
  });

  test("nulls every private prepublication league-wide count for a noncommissioner and keeps all viewer arrays", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    seedActiveHelpRequest(runtime.database);

    const overview = runtime.readRepository.readOverview(
      overviewInput()
    );

    assertOverviewShape(overview);
    assert.equal(overview.leagueId, PRIMARY.leagueId);
    assert.equal(overview.seasonId, PRIMARY.seasonId);
    assert.equal(overview.fadId, PRIMARY.fadId);
    assert.equal(overview.version, 1);
    assert.equal(overview.status, "cards_open");
    assert.equal(overview.phase, "help_window");
    assert.equal(overview.serverNowMs, PREPUBLICATION_NOW_MS);
    assert.equal(overview.timeZone, "America/Vancouver");
    assert.equal(overview.openedAtMs, OPENED_AT_MS);
    assert.equal(
      overview.reminderAtMs,
      CANDIDATE_DEADLINE_AT_MS -
        3 * FREE_AGENT_DRAFT_DAY_MS
    );
    assert.equal(overview.helpOpensAtMs, HELP_OPENS_AT_MS);
    assert.equal(
      overview.candidateDeadlineAtMs,
      CANDIDATE_DEADLINE_AT_MS
    );
    assert.equal(overview.deadlineLockedAtMs, null);
    assert.equal(overview.allocationCompletedAtMs, null);
    assert.equal(
      overview.nextRolloverAtMs,
      initialRolloverProjection()[0].rollsOverAtMs
    );
    assert.equal(
      overview.frozenFadFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(
      overview.competitionFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(overview.scheduleRecoveryOperationId, null);
    assert.equal(overview.completedAtMs, null);
    assert.deepEqual(overview.counts, {
      participatingTeams: 3,
      cardsLocked: null,
      allocationsPending: null,
      allocationsAutomatic: null,
      restrictedPending: null,
      restrictedFallbackPending: null,
      rapidAuctionsOpen: null,
      rolloversPersisted: null,
      rolloversCompleted: null,
      recoveriesOpen: null,
    });
    assert.deepEqual(Object.keys(overview.viewer).sort(), [
      "commissionerCards",
      "managedCards",
      "queuedNominations",
    ]);
    assert.deepEqual(
      overview.viewer.managedCards.map(({ teamId }) => teamId),
      [PRIMARY.teamOneId, PRIMARY.teamTwoId]
    );
    assert.deepEqual(overview.viewer.commissionerCards, []);
    assert.deepEqual(overview.viewer.queuedNominations, []);
    for (const card of overview.viewer.managedCards) {
      assert.equal(card.cardDescriptor.mode, "private_card");
      assert.deepEqual(card.cardDescriptor.authorizationEvidence, {
        kind: "manager_assignment",
        id: card.managerAssignmentId,
      });
      assert.equal("urgencyCode" in card, false);
      assert.equal("helpMessage" in card, false);
    }
    assert.equal(overview.presentation, null);
    assert.deepEqual(overview.capabilities, {
      viewPublishedCards: {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      },
      viewRecovery: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
      completeRecoveryAction: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
    });
  });

  test("gives commissioners coarse card/help state and numeric prepublication counts without the help message", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    seedActiveHelpRequest(runtime.database);
    const before = noWriteSnapshot(runtime.database);

    const overview = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.commissionerUserId,
        viewerMembershipId:
          PRIMARY.commissionerMembershipId,
      })
    );

    assertOverviewShape(overview);
    assert.deepEqual(overview.counts, {
      participatingTeams: 3,
      cardsLocked: 0,
      allocationsPending: 0,
      allocationsAutomatic: 0,
      restrictedPending: 0,
      restrictedFallbackPending: 0,
      rapidAuctionsOpen: 0,
      rolloversPersisted: 7,
      rolloversCompleted: 0,
      recoveriesOpen: 0,
    });
    assert.deepEqual(overview.viewer.managedCards, []);
    assert.equal(overview.viewer.commissionerCards.length, 3);
    assert.deepEqual(overview.viewer.queuedNominations, []);
    const helpCard = overview.viewer.commissionerCards.find(
      ({ teamId }) => teamId === PRIMARY.teamThreeId
    );
    assert.equal(helpCard.helpRequestStatus, "active");
    assert.equal(helpCard.helpRequestId, PRIMARY.helpRequestId);
    assert.equal(
      helpCard.helpRequestedAtMs,
      PREPUBLICATION_NOW_MS
    );
    assert.deepEqual(helpCard.openPrivateCard, {
      allowed: true,
      reasonCode: null,
    });
    for (const card of overview.viewer.commissionerCards.filter(
      ({ teamId }) => teamId !== PRIMARY.teamThreeId
    )) {
      assert.equal(card.helpRequestStatus, "not_requested");
      assert.equal(card.helpRequestId, null);
      assert.equal(card.helpRequestedAtMs, null);
      assert.deepEqual(card.openPrivateCard, {
        allowed: false,
        reasonCode: "HELP_NOT_GRANTED",
      });
    }
    assert.equal(
      JSON.stringify(overview).includes(
        "Please help me finish this card."
      ),
      false
    );
    assert.deepEqual(overview.capabilities, {
      viewPublishedCards: {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      },
      viewRecovery: {
        allowed: true,
        reasonCode: null,
      },
      completeRecoveryAction: {
        allowed: false,
        reasonCode: "RECOVERY_NOT_AVAILABLE",
      },
    });
    assertNoWrites(runtime.database, before);
  });

  test("returns the next persisted incomplete rollover while deadline allocation is still processing", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToDeadlineLocked(runtime.database);
    const deadlineNowMs = PUBLICATION_AT_MS + 1;
    const before = noWriteSnapshot(runtime.database);

    const overview = runtime.readRepository.readOverview(
      overviewInput({ nowMs: deadlineNowMs })
    );

    assertOverviewShape(overview);
    assert.equal(overview.status, "deadline_locked");
    assert.equal(overview.phase, "allocating");
    assert.equal(
      overview.nextRolloverAtMs,
      initialRolloverProjection()[0].rollsOverAtMs
    );
    assertNoWrites(runtime.database, before);
  });

  test("returns empty unauthorized viewer arrays and applies authority-first capabilities", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);

    const member = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.memberUserId,
        viewerMembershipId: PRIMARY.memberMembershipId,
      })
    );
    assertOverviewShape(member);
    assert.deepEqual(member.viewer, {
      managedCards: [],
      commissionerCards: [],
      queuedNominations: [],
    });
    assert.deepEqual(member.capabilities, {
      viewPublishedCards: {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      },
      viewRecovery: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
      completeRecoveryAction: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
    });

    const administrator = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.administratorUserId,
        viewerMembershipId:
          PRIMARY.administratorMembershipId,
      })
    );
    assertOverviewShape(administrator);
    assert.equal(administrator.viewer.commissionerCards.length, 3);
    assert.deepEqual(administrator.capabilities.viewRecovery, {
      allowed: true,
      reasonCode: null,
    });
    assert.deepEqual(
      administrator.capabilities.completeRecoveryAction,
      {
        allowed: false,
        reasonCode: "RECOVERY_NOT_AVAILABLE",
      }
    );
  });

  test("allows only a commissioner to complete one exact actionable recovery", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    seedActionableRecovery(runtime.database);

    const commissioner = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.commissionerUserId,
        viewerMembershipId:
          PRIMARY.commissionerMembershipId,
      })
    );
    assertOverviewShape(commissioner);
    assert.equal(commissioner.counts.recoveriesOpen, 1);
    assert.deepEqual(
      commissioner.capabilities.completeRecoveryAction,
      {
        allowed: true,
        reasonCode: null,
      }
    );

    const member = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.memberUserId,
        viewerMembershipId: PRIMARY.memberMembershipId,
      })
    );
    assert.equal(member.counts.recoveriesOpen, null);
    assert.deepEqual(
      member.capabilities.completeRecoveryAction,
      {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      }
    );

    insert(runtime.database, "free_agent_draft_recoveries", {
      id: uuid(1_351),
      league_id: PRIMARY.leagueId,
      season_id: PRIMARY.seasonId,
      fad_id: PRIMARY.fadId,
      player_id: null,
      allocation_id: null,
      rollover_id: null,
      auction_id: null,
      job_run_id: null,
      kind: "completion",
      status: "pending",
      earliest_activation_at_ms: null,
      target_resolution_at_ms: null,
      last_error_code: null,
      commissioner_reason: null,
      created_by_operation_id: "second-foundation-read-recovery",
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: PREPUBLICATION_NOW_MS + 1,
      updated_at_ms: PREPUBLICATION_NOW_MS + 1,
      resolved_at_ms: null,
      version: 1,
    });
    const ambiguous = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.commissionerUserId,
        viewerMembershipId:
          PRIMARY.commissionerMembershipId,
      })
    );
    assert.equal(ambiguous.counts.recoveriesOpen, 2);
    assert.deepEqual(
      ambiguous.capabilities.completeRecoveryAction,
      {
        allowed: false,
        reasonCode: "RECOVERY_NOT_AVAILABLE",
      }
    );
  });

  test("publishes roster links and manager-only queued nominations in rapid phase", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    const nomination = seedQueuedNomination(runtime.database);
    const rapidNowMs = nomination.acceptedAtMs + 1;
    assert.ok(rapidNowMs < nomination.rollsOverAtMs);

    const overview = runtime.readRepository.readOverview(
      overviewInput({ nowMs: rapidNowMs })
    );
    assertOverviewShape(overview);
    assert.equal(overview.phase, "rapid");
    assert.deepEqual(overview.counts, {
      participatingTeams: 3,
      cardsLocked: 3,
      allocationsPending: 0,
      allocationsAutomatic: 0,
      restrictedPending: 0,
      restrictedFallbackPending: 0,
      rapidAuctionsOpen: 0,
      rolloversPersisted: 7,
      rolloversCompleted: 0,
      recoveriesOpen: 0,
    });
    assert.equal(overview.viewer.managedCards.length, 2);
    for (const card of overview.viewer.managedCards) {
      assert.equal(card.cardDescriptor.mode, "published_card");
      assert.equal(card.cardDescriptor.authorizationEvidence, null);
    }
    assert.equal(overview.viewer.queuedNominations.length, 1);
    const queued = overview.viewer.queuedNominations[0];
    assert.equal(queued.queueId, PRIMARY.nominationQueueId);
    assert.equal(queued.teamId, PRIMARY.teamOneId);
    assert.deepEqual(queued.player, {
      playerId: PRIMARY.playerId,
      fullName: "Alex Example",
      positionGroup: "F",
    });
    assert.equal(queued.totalValueCents, 600);
    assert.equal(queued.termYears, 2);
    assert.equal(queued.aavCents, 300);
    assert.equal(queued.submittedAtMs, nomination.acceptedAtMs);
    assert.equal(
      queued.opensAtRolloverId,
      openingEvidence(PRIMARY).rolloverIds[0]
    );
    assert.equal(queued.targetRolloverId, null);
    assert.equal(queued.status, "queued");
    assert.deepEqual(queued.cancel, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });

    const commissioner = runtime.readRepository.readOverview(
      overviewInput({
        viewerUserId: PRIMARY.commissionerUserId,
        viewerMembershipId:
          PRIMARY.commissionerMembershipId,
        nowMs: rapidNowMs,
      })
    );
    assert.deepEqual(commissioner.viewer.queuedNominations, []);
    assert.deepEqual(overview.capabilities.viewPublishedCards, {
      allowed: true,
      reasonCode: null,
    });

    const publishedRoster =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: PRIMARY.memberUserId,
          viewerMembershipId: PRIMARY.memberMembershipId,
          nowMs: rapidNowMs,
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamThreeId,
        })
      );
    assert.deepEqual(publishedRoster.rosterLinks, [
      {
        mode: "published_card",
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        teamId: PRIMARY.teamThreeId,
        cardId: PRIMARY.cardThreeId,
        authorizationEvidence: null,
      },
    ]);
  });

  test("surfaces active rapid-auction urgency to a nonmanager even with no managed cards", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    const nomination = seedQueuedNomination(runtime.database);
    seedOpenRapidAuction(runtime.database);
    const rapidNowMs = nomination.acceptedAtMs + 1;
    assert.ok(rapidNowMs < nomination.rollsOverAtMs);
    const before = noWriteSnapshot(runtime.database);

    const navigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: PRIMARY.memberUserId,
          viewerMembershipId:
            PRIMARY.memberMembershipId,
          nowMs: rapidNowMs,
        })
      );

    assertNavigationShape(navigation);
    assert.equal(navigation.phase, "rapid");
    assert.deepEqual(navigation.managedCards, []);
    assert.equal(
      navigation.urgencyCode,
      "RAPID_AUCTIONS_ACTIVE"
    );
    assertNoWrites(runtime.database, before);
  });

  test("prioritizes a restricted manager action over a simultaneous rapid auction", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const restricted =
      seedRestrictedActionWithoutImprovement(
        runtime.database
      );
    const nomination = seedQueuedNomination(runtime.database);
    seedOpenRapidAuction(runtime.database);
    const rapidNowMs = nomination.acceptedAtMs + 1;
    assert.ok(rapidNowMs < nomination.rollsOverAtMs);
    const before = noWriteSnapshot(runtime.database);

    const navigation =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, { nowMs: rapidNowMs })
      );

    assertNavigationShape(navigation);
    assert.equal(navigation.phase, "rapid");
    assert.equal(
      navigation.urgencyCode,
      "RESTRICTED_ACTION_REQUIRED"
    );
    assert.deepEqual(
      Object.fromEntries(
        navigation.managedCards.map((card) => [
          card.teamId,
          card.urgencyCode,
        ])
      ),
      {
        [PRIMARY.teamOneId]: "RESTRICTED_ACTION_REQUIRED",
        [PRIMARY.teamTwoId]: "RAPID_AUCTIONS_ACTIVE",
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            decision_code,
            player_id,
            restricted_auction_id,
            restricted_minimum_total_cents,
            restricted_minimum_term_years,
            restricted_minimum_aav_cents
          FROM free_agent_draft_player_allocations
          WHERE league_id = ?
            AND id = ?
        `)
        .get(PRIMARY.leagueId, restricted.allocationId),
      {
        status: "restricted_active",
        decision_code: "exact_total_and_term_tie",
        player_id: restricted.restrictedPlayerId,
        restricted_auction_id: restricted.auctionId,
        restricted_minimum_total_cents: 600,
        restricted_minimum_term_years: 2,
        restricted_minimum_aav_cents: 300,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            participant.team_id,
            participant.source_snapshot_entry_id,
            snapshot.player_id,
            snapshot.proposed_total_value_cents,
            snapshot.proposed_term_years,
            snapshot.proposed_aav_cents,
            snapshot.eligibility_status,
            snapshot.allocation_eligibility
          FROM free_agent_draft_auction_participants AS participant
          JOIN candidate_card_snapshot_entries AS snapshot
            ON snapshot.league_id = participant.league_id
           AND snapshot.id = participant.source_snapshot_entry_id
          WHERE participant.league_id = ?
            AND participant.allocation_id = ?
          ORDER BY participant.team_id
        `)
        .all(PRIMARY.leagueId, restricted.allocationId),
      [PRIMARY.teamOneId, PRIMARY.teamThreeId]
        .sort()
        .map((teamId) => ({
          team_id: teamId,
          source_snapshot_entry_id:
            teamId === PRIMARY.teamOneId
              ? restricted.snapshotEntryIds[0]
              : restricted.snapshotEntryIds[1],
          player_id: restricted.restrictedPlayerId,
          proposed_total_value_cents: 600,
          proposed_term_years: 2,
          proposed_aav_cents: 300,
          eligibility_status: "valid",
          allocation_eligibility: "eligible",
        }))
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
    assertNoWrites(runtime.database, before);
  });

  test("returns repository not-found for missing or cross-league FAD identities", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    openDraft(runtime.database, SECONDARY);

    assertRepositoryError(
      () =>
        runtime.readRepository.readOverview(
          overviewInput({ fadId: uuid(9_999) })
        ),
      REPOSITORY_ERROR_CODES.recordNotFound
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readOverview(
          overviewInput({ fadId: SECONDARY.fadId })
        ),
      REPOSITORY_ERROR_CODES.recordNotFound
    );
  });

  test("fails closed when the latest immutable readiness attempt digest is malformed", (t) => {
    const runtime = createRuntime(t);
    blockReadiness(runtime.database);
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_readiness_attempts"
    );
    runtime.database
      .prepare(`
        UPDATE free_agent_draft_readiness_attempts
        SET projection_sha256 = ?
        WHERE league_id = ?
          AND readiness_operation_id = ?
          AND attempt_number = 1
      `)
      .run(
        "0".repeat(64),
        PRIMARY.leagueId,
        PRIMARY.readinessOperationId
      );

    assertRepositoryError(
      () =>
        runtime.readRepository.readReadiness(
          readinessInput()
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
  });

  test("fails both public FAD reads closed when participant and Candidate Card coverage split", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    dropTableTriggers(runtime.database, "candidate_cards");
    runtime.database.pragma("foreign_keys = OFF");
    runtime.database
      .prepare(`
        DELETE FROM candidate_cards
        WHERE league_id = ?
          AND id = ?
      `)
      .run(PRIMARY.leagueId, PRIMARY.cardThreeId);
    runtime.database.pragma("foreign_keys = ON");

    assertRepositoryError(
      () =>
        runtime.readRepository.readNavigation(
          navigationInput(PRIMARY)
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
    assertRepositoryError(
      () =>
        runtime.readRepository.readOverview(
          overviewInput()
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
  });

  test("fails the overview closed when an attached completion recovery identity is missing", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    moveDraftToCompleted(runtime.database);
    const recovery = seedScheduleRecovery(runtime.database, {
      recoveryKind: "completion",
      attachToDraft: true,
    });
    dropTableTriggers(
      runtime.database,
      "free_agent_draft_schedule_recoveries"
    );
    runtime.database.pragma("foreign_keys = OFF");
    runtime.database
      .prepare(`
        DELETE FROM free_agent_draft_schedule_recoveries
        WHERE league_id = ?
          AND id = ?
      `)
      .run(PRIMARY.leagueId, recovery.recoveryId);
    runtime.database.pragma("foreign_keys = ON");

    assertRepositoryError(
      () =>
        runtime.readRepository.readOverview(
          overviewInput({
            nowMs: COMPLETION_AT_MS + 1,
          })
        ),
      REPOSITORY_ERROR_CODES.schemaIncompatible
    );
  });

  test("exposes only completion-overrun schedule recovery through T-129", (t) => {
    const preOpenRuntime = createRuntime(t);
    openDraft(preOpenRuntime.database, PRIMARY);
    seedScheduleRecovery(preOpenRuntime.database, {
      recoveryKind: "pre_open",
      attachToDraft: false,
    });
    assert.equal(
      preOpenRuntime.readRepository.readOverview(
        overviewInput()
      ).scheduleRecoveryOperationId,
      null
    );

    const completionRuntime = createRuntime(t);
    openDraft(completionRuntime.database, PRIMARY);
    moveDraftToRapid(completionRuntime.database);
    moveDraftToCompleted(completionRuntime.database);
    const recovery = seedScheduleRecovery(
      completionRuntime.database,
      {
        recoveryKind: "completion",
        attachToDraft: true,
      }
    );
    const completed =
      completionRuntime.readRepository.readOverview(
        overviewInput({
          nowMs: COMPLETION_AT_MS + 1,
        })
      );
    assert.equal(completed.status, "completed");
    assert.equal(completed.phase, "completed");
    assert.equal(
      completed.frozenFadFirstMatchupStartsAtMs,
      WEEK_ONE_AT_MS
    );
    assert.equal(
      completed.competitionFirstMatchupStartsAtMs,
      recovery.startsAtMs
    );
    assert.equal(
      completed.scheduleRecoveryOperationId,
      recovery.operationId
    );
  });

  test("keeps completed FAD navigation hidden while retaining viewer-accessible published roster descriptors", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    moveDraftToRapid(runtime.database);
    moveDraftToCompleted(runtime.database);
    const completedNowMs = COMPLETION_AT_MS + 1;

    const unscoped = runtime.readRepository.readNavigation(
      navigationInput(PRIMARY, {
        nowMs: completedNowMs,
      })
    );
    assertNavigationShape(unscoped);
    assert.equal(unscoped.phase, "completed");
    assert.equal(unscoped.showMainNavigation, false);
    assert.deepEqual(
      unscoped.managedCards.map(({ teamId }) => teamId),
      [PRIMARY.teamOneId, PRIMARY.teamTwoId]
    );
    assert.deepEqual(
      unscoped.rosterLinks.map(({ teamId }) => teamId),
      [
        PRIMARY.teamOneId,
        PRIMARY.teamTwoId,
        PRIMARY.teamThreeId,
      ]
    );
    for (const descriptor of unscoped.rosterLinks) {
      assert.equal(descriptor.mode, "published_card");
      assert.equal(descriptor.authorizationEvidence, null);
    }
    assert.equal(unscoped.urgencyCode, "NONE");

    const historical =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          viewerUserId: PRIMARY.memberUserId,
          viewerMembershipId: PRIMARY.memberMembershipId,
          nowMs: completedNowMs,
          rosterSeasonId: PRIMARY.seasonId,
          rosterTeamId: PRIMARY.teamThreeId,
        })
      );
    assertNavigationShape(historical);
    assert.equal(historical.phase, "completed");
    assert.deepEqual(historical.managedCards, []);
    assert.deepEqual(historical.rosterLinks, [
      {
        mode: "published_card",
        seasonId: PRIMARY.seasonId,
        fadId: PRIMARY.fadId,
        teamId: PRIMARY.teamThreeId,
        cardId: PRIMARY.cardThreeId,
        authorizationEvidence: null,
      },
    ]);
  });

  test("hides nonterminal summer navigation exactly at the current competition Week 1 start", (t) => {
    const runtime = createRuntime(t);
    openDraft(runtime.database, PRIMARY);
    const before = noWriteSnapshot(runtime.database);

    const justBefore =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          nowMs: WEEK_ONE_AT_MS - 1,
        })
      );
    const exactlyAt =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          nowMs: WEEK_ONE_AT_MS,
        })
      );
    const justAfter =
      runtime.readRepository.readNavigation(
        navigationInput(PRIMARY, {
          nowMs: WEEK_ONE_AT_MS + 1,
        })
      );

    assert.equal(justBefore.phase, "deadline_processing");
    assert.equal(justBefore.showMainNavigation, true);
    assert.equal(exactlyAt.phase, "deadline_processing");
    assert.equal(exactlyAt.showMainNavigation, false);
    assert.equal(justAfter.showMainNavigation, false);
    assert.deepEqual(
      exactlyAt.rosterLinks.map(({ teamId }) => teamId),
      [PRIMARY.teamOneId, PRIMARY.teamTwoId]
    );
    assertNoWrites(runtime.database, before);
  });
});
