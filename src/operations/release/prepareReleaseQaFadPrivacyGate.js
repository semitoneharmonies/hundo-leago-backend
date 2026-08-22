"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const {
  createSecurityFoundations,
} = require("../../bootstrap/createSecurityFoundations");
const {
  createTargetRuntime,
} = require("../../bootstrap/createTargetRuntime");
const {
  createSecureRandom,
} = require("../../infrastructure/security/createSecureRandom");
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  planExplicitMatchupSchedule,
  addLocalDays,
} = require("../../domain/matchups/matchupSchedulePolicy");
const {
  buildMatchupOccurrenceKey,
} = require("../../domain/matchups/matchupJobPolicy");
const {
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE,
} = require(
  "../../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require("./releaseQaFixtureContract");
const {
  stableUuid,
} = require("./rotateReleaseQaCredentials");

const CONTRACT_VERSION = 1;
const RESULT_CODE = "RELEASE_QA_FAD_PRIVACY_GATE_PREPARED";
const EVENT_TYPE = "release_qa.fad_privacy_gate_prepared";
const FIXTURE_KIND = "strict_fad_privacy_gate";
const FIXTURE_NAME = "Gamma Strict Privacy Gate";
const TEAM_NAMES = Object.freeze([
  "Gamma Strict Privacy Gate Team 1",
  "Gamma Strict Privacy Gate Team 2",
  "Gamma Strict Privacy Gate Team 3",
  "Gamma Strict Privacy Gate Team 4",
]);
const VANCOUVER_TIME_ZONE = "America/Vancouver";
const DAY_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_ACTIONABLE_HORIZON_MS = 4 * 60 * 60 * 1_000;
const LEASE_DURATION_MS = 15 * 60 * 1_000;
// Schema 54's canonical services perform 264 fixed row changes plus fifteen
// schedule/job changes per matchup week. Treat drift as a failed write scope.
const FIXED_DATABASE_WRITE_COUNT = 264;
const PER_MATCHUP_WEEK_DATABASE_WRITE_COUNT = 15;
const REQUIRED_SCHEMA_VERSION = 54;

const ACCOUNT_ALIASES = Object.freeze({
  administrator: "platformAdmin",
  commissioner: "leagueACommissioner",
  managerA: "leagueAManagerOne",
  managerB: "leagueAManagerTwo",
});

const SIDE_CAR_IDS = Object.freeze({
  leagueId: stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    "league",
  ]),
  seasonId: stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    "season",
  ]),
  scheduleOperationId: stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    "matchup-schedule-operation",
  ]),
  readinessOperationId: stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    "readiness-operation",
  ]),
  readinessJobRunId: stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    "readiness-job",
  ]),
  teamIds: Object.freeze([1, 2, 3, 4].map((number) =>
    stableUuid([
      "hundo-leago",
      "release-qa",
      FIXTURE_KIND,
      "team",
      String(number),
    ])
  )),
});

const ERROR_CODES = Object.freeze({
  inputInvalid: "RELEASE_QA_FAD_PRIVACY_GATE_INPUT_INVALID",
  fixtureInvalid: "RELEASE_QA_FAD_PRIVACY_GATE_FIXTURE_INVALID",
  stateChanged: "RELEASE_QA_FAD_PRIVACY_GATE_STATE_CHANGED",
  idempotencyConflict:
    "RELEASE_QA_FAD_PRIVACY_GATE_IDEMPOTENCY_CONFLICT",
  horizonInsufficient:
    "RELEASE_QA_FAD_PRIVACY_GATE_HORIZON_INSUFFICIENT",
  writeScopeInvalid:
    "RELEASE_QA_FAD_PRIVACY_GATE_WRITE_SCOPE_INVALID",
  postcheckFailed:
    "RELEASE_QA_FAD_PRIVACY_GATE_POSTCHECK_FAILED",
  failed: "RELEASE_QA_FAD_PRIVACY_GATE_FAILED",
});

class ReleaseQaFadPrivacyGateError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA FAD privacy-gate preparation failed safely.",
      options
    );
    this.name = "ReleaseQaFadPrivacyGateError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaFadPrivacyGateError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function canonicalHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function deterministicSecureRandom(operationId) {
  let idSequence = 0;
  let byteSequence = 0;
  function bytes(length) {
    const chunks = [];
    let remaining = length;
    while (remaining > 0) {
      const chunk = crypto
        .createHash("sha256")
        .update(
          [
            "hundo-leago",
            FIXTURE_KIND,
            operationId,
            "bytes",
            String(++byteSequence),
          ].join("\0"),
          "utf8"
        )
        .digest();
      chunks.push(chunk.subarray(0, Math.min(chunk.length, remaining)));
      remaining -= Math.min(chunk.length, remaining);
    }
    return Buffer.concat(chunks, length);
  }
  return createSecureRandom({
    randomBytes: bytes,
    randomUUID() {
      return stableUuid([
        "hundo-leago",
        FIXTURE_KIND,
        operationId,
        "id",
        String(++idSequence),
      ]);
    },
  });
}

function createClockedRuntime(runtime, clockState, operationId) {
  if (
    !runtime?.database ||
    !runtime?.securityConfig ||
    !clockState ||
    !Number.isSafeInteger(clockState.nowMs)
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  const securityFoundations = createSecurityFoundations({
    loadConfig: () => runtime.securityConfig,
    now: () => clockState.nowMs,
    secureRandom: deterministicSecureRandom(operationId),
    loggerSink() {},
  });
  const clocked = createTargetRuntime({
    database: runtime.database,
    migrationsDirectory: path.resolve(
      __dirname,
      "../../../database/migrations"
    ),
    securityFoundations,
    currentSeason: Object.freeze({
      label: "2026",
      nhlSeasonKey: "20262027",
    }),
    leagueWriteMode: "closed",
    freeAgentDraftRoutesEnabled: false,
    networkSourceResolver() {
      return "127.0.0.1";
    },
  });
  return Object.freeze({
    ...clocked,
    database: runtime.database,
  });
}

function fixtureAccounts(database) {
  const records = Object.fromEntries(
    Object.entries(ACCOUNT_ALIASES).map(([role, alias]) => [
      role,
      Object.freeze({ alias, userId: fixtureId(`account:${alias}`) }),
    ])
  );
  const rows = database.prepare(`
    SELECT id, status
    FROM users
    WHERE id IN (${Object.keys(records).map(() => "?").join(", ")})
    ORDER BY id
  `).all(...Object.values(records).map(({ userId }) => userId));
  if (
    rows.length !== 4 ||
    rows.some(({ status }) => status !== "active") ||
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM platform_roles
      WHERE user_id = ?
        AND role = 'platform_administrator'
        AND status = 'active'
    `).get(records.administrator.userId).count !== 1
  ) {
    fail(ERROR_CODES.fixtureInvalid);
  }
  return Object.freeze(records);
}

function assertGammaSource(database) {
  const gammaLeagueId = fixtureId("fad-browser-v4:league:gamma");
  const source = database.prepare(`
    SELECT league.id AS league_id, league.name, league.status,
           season.id AS season_id, fad.id AS fad_id, fad.status AS fad_status
    FROM leagues AS league
    JOIN seasons AS season
      ON season.league_id = league.id
     AND season.id = league.current_season_id
    JOIN free_agent_drafts AS fad
      ON fad.league_id = league.id
     AND fad.season_id = season.id
    WHERE league.id = ?
  `).get(gammaLeagueId);
  if (
    !source ||
    source.name !== "Gamma League" ||
    source.status !== "active" ||
    source.fad_status !== "completed"
  ) {
    fail(ERROR_CODES.fixtureInvalid);
  }
  return Object.freeze(source);
}

function vancouverDateParts(timestampMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VANCOUVER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(timestampMs));
  return Object.fromEntries(
    parts
      .filter(({ type }) =>
        ["year", "month", "day", "weekday"].includes(type)
      )
      .map(({ type, value }) => [
        type,
        type === "weekday" ? value : Number(value),
      ])
  );
}

function vancouverMidnightMs(year, month, day) {
  const utcNoon = Date.UTC(year, month - 1, day, 12);
  const zoneName = new Intl.DateTimeFormat("en-CA", {
    timeZone: VANCOUVER_TIME_ZONE,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(utcNoon)).find(
    ({ type }) => type === "timeZoneName"
  )?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(zoneName || "");
  if (!match) fail(ERROR_CODES.fixtureInvalid);
  const direction = match[1] === "+" ? 1 : -1;
  const offsetMinutes =
    direction * (Number(match[2]) * 60 + Number(match[3]));
  return Date.UTC(year, month - 1, day) - offsetMinutes * 60_000;
}

function nextVancouverMondayAfter(timestampMs) {
  const local = vancouverDateParts(timestampMs);
  for (let offset = 0; offset < 14; offset += 1) {
    const date = new Date(
      Date.UTC(local.year, local.month - 1, local.day + offset)
    );
    const candidate = vancouverMidnightMs(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate()
    );
    if (date.getUTCDay() === 1 && candidate > timestampMs) return candidate;
  }
  fail(ERROR_CODES.fixtureInvalid);
}

function firstVancouverMondayInApril(year) {
  for (let day = 1; day <= 7; day += 1) {
    const date = new Date(Date.UTC(year, 3, day));
    if (date.getUTCDay() === 1) {
      return vancouverMidnightMs(year, 4, day);
    }
  }
  fail(ERROR_CODES.fixtureInvalid);
}

function scheduleFor(nowMs) {
  const firstWeekStartsAtMs = nextVancouverMondayAfter(nowMs);
  const local = vancouverDateParts(firstWeekStartsAtMs);
  const seasonStartYear = local.month >= 7 ? local.year : local.year - 1;
  const fantasyPlayoffsStartAtMs =
    firstVancouverMondayInApril(seasonStartYear + 1);
  const fantasyPlayoffsEndAtMs = addLocalDays(
    fantasyPlayoffsStartAtMs,
    28,
    VANCOUVER_TIME_ZONE
  );
  const candidateDeadlineAtMs = addLocalDays(
    firstWeekStartsAtMs,
    -7,
    VANCOUVER_TIME_ZONE
  );
  const openedAtMs = addLocalDays(
    firstWeekStartsAtMs,
    -10,
    VANCOUVER_TIME_ZONE
  );
  if (
    candidateDeadlineAtMs > nowMs ||
    firstWeekStartsAtMs - nowMs < MINIMUM_ACTIONABLE_HORIZON_MS ||
    fantasyPlayoffsStartAtMs <= firstWeekStartsAtMs
  ) {
    fail(ERROR_CODES.horizonInsufficient);
  }
  return Object.freeze({
    nhlSeasonKey: `${seasonStartYear}${seasonStartYear + 1}`,
    nhlRegularSeasonStartsAtMs: addLocalDays(
      firstWeekStartsAtMs,
      -6,
      VANCOUVER_TIME_ZONE
    ),
    nhlRegularSeasonEndsAtMs: fantasyPlayoffsEndAtMs,
    fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs,
    candidateDeadlineAtMs,
    openedAtMs,
  });
}

function stableSidecarId(kind, ...parts) {
  return stableUuid([
    "hundo-leago",
    "release-qa",
    FIXTURE_KIND,
    kind,
    ...parts.map(String),
  ]);
}

function seedSidecarFoundations({
  runtime,
  accounts,
  schedule,
  createdAtMs,
  activatedAtMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  const membershipByRole = Object.fromEntries(
    Object.keys(accounts).map((role) => [
      role,
      stableSidecarId("membership", role),
    ])
  );

  repositories.leagues.insert({
    id: SIDE_CAR_IDS.leagueId,
    name: FIXTURE_NAME,
    name_normalized: FIXTURE_NAME.toLowerCase(),
    status: "setup",
    timezone: VANCOUVER_TIME_ZONE,
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: SIDE_CAR_IDS.leagueId,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: schedule.fantasyPlayoffsStartAtMs,
    maximum_teams: 4,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.seasons.insert({
    id: SIDE_CAR_IDS.seasonId,
    league_id: SIDE_CAR_IDS.leagueId,
    label: `${schedule.nhlSeasonKey.slice(0, 4)}-${schedule.nhlSeasonKey.slice(6)}`,
    nhl_season_key: schedule.nhlSeasonKey,
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });

  for (const [role, account] of Object.entries(accounts)) {
    repositories.league_memberships.insert({
      id: membershipByRole[role],
      league_id: SIDE_CAR_IDS.leagueId,
      user_id: account.userId,
      permission_category:
        role === "commissioner"
          ? "commissioner"
          : role === "administrator"
            ? "member"
            : "manager",
      status: "active",
      joined_at_ms: createdAtMs,
      ended_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
  }

  const managerRoles = ["managerA", "managerB", "managerA", "managerB"];
  for (let index = 0; index < 4; index += 1) {
    const managerRole = managerRoles[index];
    const teamId = SIDE_CAR_IDS.teamIds[index];
    repositories.teams.insert({
      id: teamId,
      league_id: SIDE_CAR_IDS.leagueId,
      name: TEAM_NAMES[index],
      name_normalized: TEAM_NAMES[index].toLowerCase(),
      status: "setup",
      primary_colour: index % 2 === 0 ? "#16324f" : "#b03a2e",
      secondary_colour: "#f7f7f7",
      logo_reference: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    repositories.team_manager_assignments.insert({
      id: stableSidecarId("manager-assignment", String(index + 1), managerRole),
      league_id: SIDE_CAR_IDS.leagueId,
      team_id: teamId,
      user_id: accounts[managerRole].userId,
      membership_id: membershipByRole[managerRole],
      assigned_by_user_id: accounts.commissioner.userId,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: createdAtMs,
      accepted_at_ms: createdAtMs,
      ended_at_ms: null,
      version: 1,
    });
  }

  const planned = planExplicitMatchupSchedule({
    teamIds: [...SIDE_CAR_IDS.teamIds],
    nhlSeasonKey: schedule.nhlSeasonKey,
    nhlRegularSeasonStartsAtMs: schedule.nhlRegularSeasonStartsAtMs,
    nhlRegularSeasonEndsAtMs: schedule.nhlRegularSeasonEndsAtMs,
    fantasyPlayoffsStartAtMs: schedule.fantasyPlayoffsStartAtMs,
    fantasyPlayoffsEndAtMs: schedule.fantasyPlayoffsEndAtMs,
    firstWeekStartsAtMs: schedule.firstWeekStartsAtMs,
    timeZone: VANCOUVER_TIME_ZONE,
    nowMs: schedule.openedAtMs,
  });

  const season = repositories.seasons.updateVersioned({
    key: SIDE_CAR_IDS.seasonId,
    leagueId: SIDE_CAR_IDS.leagueId,
    expectedVersion: 1,
    changes: {
      status: "active",
      regular_season_starts_at_ms: schedule.nhlRegularSeasonStartsAtMs,
      regular_season_ends_at_ms: schedule.nhlRegularSeasonEndsAtMs,
      fantasy_playoffs_start_at_ms: schedule.fantasyPlayoffsStartAtMs,
      fantasy_playoffs_end_at_ms: schedule.fantasyPlayoffsEndAtMs,
      updated_at_ms: activatedAtMs,
    },
  });
  for (const teamId of SIDE_CAR_IDS.teamIds) {
    repositories.teams.updateVersioned({
      key: teamId,
      leagueId: SIDE_CAR_IDS.leagueId,
      expectedVersion: 1,
      changes: { status: "active", updated_at_ms: activatedAtMs },
    });
  }
  repositories.leagues.updateVersioned({
    key: SIDE_CAR_IDS.leagueId,
    expectedVersion: 1,
    changes: {
      status: "active",
      commissioner_membership_id: membershipByRole.commissioner,
      current_season_id: SIDE_CAR_IDS.seasonId,
      updated_at_ms: activatedAtMs,
    },
  });

  repositories.matchup_operations.insert({
    id: SIDE_CAR_IDS.scheduleOperationId,
    league_id: SIDE_CAR_IDS.leagueId,
    season_id: SIDE_CAR_IDS.seasonId,
    matchup_week_id: null,
    matchup_id: null,
    actor_user_id: accounts.commissioner.userId,
    operation_type: "schedule_generate",
    status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({
      participantCount: 4,
      participantTeamIds: [...SIDE_CAR_IDS.teamIds].sort(),
      weekCount: planned.weeks.length,
      matchupCount: planned.weeks.reduce(
        (total, week) => total + week.pairs.length,
        0
      ),
      jobOccurrenceCount: 0,
    }),
    started_at_ms: createdAtMs,
    completed_at_ms: createdAtMs,
  });

  const teamNameById = new Map(
    SIDE_CAR_IDS.teamIds.map((teamId, index) => [teamId, TEAM_NAMES[index]])
  );
  let weekOneId = null;
  for (const week of planned.weeks) {
    const weekId = stableSidecarId("matchup-week", String(week.sequence));
    if (week.sequence === 1) weekOneId = weekId;
    repositories.matchup_weeks.insert({
      id: weekId,
      league_id: SIDE_CAR_IDS.leagueId,
      season_id: SIDE_CAR_IDS.seasonId,
      week_key: week.weekKey,
      sequence: week.sequence,
      starts_at_ms: week.startsAtMs,
      baseline_at_ms: week.baselineAtMs,
      locks_at_ms: week.locksAtMs,
      ends_at_ms: week.endsAtMs,
      rolls_over_at_ms: week.rollsOverAtMs,
      status: "scheduled",
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    week.pairs.forEach((pair, pairIndex) => {
      repositories.matchups.insert({
        id: stableSidecarId(
          "matchup",
          String(week.sequence),
          String(pairIndex + 1)
        ),
        league_id: SIDE_CAR_IDS.leagueId,
        season_id: SIDE_CAR_IDS.seasonId,
        matchup_week_id: weekId,
        home_team_id: pair.homeTeamId,
        away_team_id: pair.awayTeamId,
        home_team_name: teamNameById.get(pair.homeTeamId),
        away_team_name: teamNameById.get(pair.awayTeamId),
        status: "scheduled",
        created_at_ms: createdAtMs,
        updated_at_ms: createdAtMs,
        version: 1,
      });
    });
  }
  repositories.season_matchup_schedule_generations.insert({
    league_id: SIDE_CAR_IDS.leagueId,
    season_id: SIDE_CAR_IDS.seasonId,
    schedule_version: 1,
    schedule_operation_id: SIDE_CAR_IDS.scheduleOperationId,
    week_one_matchup_week_id: weekOneId,
    week_one_starts_at_ms: schedule.firstWeekStartsAtMs,
    status: "current",
    created_at_ms: createdAtMs,
    superseded_at_ms: null,
    version: 1,
  });
  insertMatchupScheduleJobs({
    matchupJobs: runtime.repositories.matchupJobs,
    planned,
    createdAtMs,
  });

  return Object.freeze({
    membershipByRole: Object.freeze(membershipByRole),
    planned,
    seasonVersion: season.version,
    weekOneId,
  });
}

function insertMatchupScheduleJobs({ matchupJobs, planned, createdAtMs }) {
  for (const week of planned.weeks) {
    const weekId = stableSidecarId("matchup-week", String(week.sequence));
    const occurrences = [
      ["statistics-start", "matchup:statistics_refresh", week.startsAtMs],
      ["baseline", "matchup:baseline", week.baselineAtMs],
      ["lock", "matchup:lock", week.locksAtMs],
      ["statistics-end", "matchup:statistics_refresh", week.endsAtMs],
      ["finalize", "matchup:finalize", week.endsAtMs],
      ["rollover", "matchup:rollover", week.rollsOverAtMs],
    ];
    for (const [slot, jobType, scheduledForMs] of occurrences) {
      const id = stableSidecarId(
        "matchup-job",
        String(week.sequence),
        slot
      );
      const params = {
        bindingId: id,
        runId: id,
        leagueId: SIDE_CAR_IDS.leagueId,
        seasonId: SIDE_CAR_IDS.seasonId,
        weekId,
        jobType,
        occurrenceKey: buildMatchupOccurrenceKey({
          jobType,
          leagueId: SIDE_CAR_IDS.leagueId,
          seasonId: SIDE_CAR_IDS.seasonId,
          weekId,
          scheduleOperationId: SIDE_CAR_IDS.scheduleOperationId,
          scheduleVersion: 1,
          scheduledForMs,
        }),
        scheduledForMs,
        scheduleOperationId: SIDE_CAR_IDS.scheduleOperationId,
        scheduleVersion: 1,
        owningMatchupId: null,
        nowMs: createdAtMs,
      };
      const scheduled = matchupJobs.schedule(params);
      if (scheduled.replayed !== false) {
        fail(ERROR_CODES.stateChanged);
      }
    }
  }
}

function selectPlayer({ database, runtime, accounts, createdAtMs }) {
  const player = database.prepare(`
    SELECT player.id, player.full_name,
           source.normalized_position AS position_group
    FROM players AS player
    JOIN player_source_state AS source
      ON source.player_id = player.id
     AND source.ended_at_ms IS NULL
     AND source.active = 1
     AND source.normalized_position IN ('F', 'D')
    JOIN player_external_ids AS external
      ON external.player_id = player.id
     AND external.provider = 'sportsdataio-discovery-lab'
    WHERE player.status = 'active'
      AND lower(player.full_name) NOT LIKE 'fixture player %'
    GROUP BY player.id, player.full_name, source.normalized_position
    ORDER BY lower(player.full_name), player.id
    LIMIT 1
  `).get();
  if (!player) fail(ERROR_CODES.fixtureInvalid);
  const repositories = runtime.repositories.context.repositories;
  repositories.league_player_positions.insert({
    id: stableSidecarId("player-position", player.id),
    league_id: SIDE_CAR_IDS.leagueId,
    player_id: player.id,
    position_group: player.position_group,
    reason: "Strict FAD privacy-gate fixture",
    corrected_by_user_id: accounts.commissioner.userId,
    effective_at_ms: createdAtMs,
    ended_at_ms: null,
    version: 1,
  });
  return Object.freeze({
    playerId: player.id,
    fullName: player.full_name,
    positionGroup: player.position_group,
  });
}

function syntheticAuthenticated(userId, role) {
  return Object.freeze({
    valid: true,
    user: Object.freeze({ id: userId }),
    session: Object.freeze({
      id: stableSidecarId("synthetic-session", role),
      userId,
    }),
  });
}

function findDraftScope(database, expectedStatus) {
  const fad = database.prepare(`
    SELECT id, status, candidate_deadline_at_ms,
           first_matchup_starts_at_ms
    FROM free_agent_drafts
    WHERE league_id = ? AND season_id = ?
  `).get(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.seasonId);
  const cards = fad
    ? database.prepare(`
        SELECT id, team_id, version
        FROM candidate_cards
        WHERE league_id = ? AND season_id = ? AND fad_id = ?
        ORDER BY team_id
      `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.seasonId, fad.id)
    : [];
  if (
    !fad ||
    fad.status !== expectedStatus ||
    cards.length !== 4 ||
    cards.some((card, index) => card.team_id !== [...SIDE_CAR_IDS.teamIds].sort()[index])
  ) {
    fail(ERROR_CODES.postcheckFailed);
  }
  return Object.freeze({ fad, cards: Object.freeze(cards) });
}

function findDueOccurrence(repository, { fadId, jobType, nowMs }) {
  const matches = repository.listDue({ nowMs, limit: 100 }).filter(
    (occurrence) =>
      occurrence.fadId === fadId && occurrence.jobType === jobType
  );
  if (matches.length !== 1) fail(ERROR_CODES.postcheckFailed);
  return matches[0];
}

async function executeReadiness(runtime, nowMs) {
  const repository = runtime.repositories.freeAgentDraftJobs;
  const occurrence = findDueOccurrence(repository, {
    fadId: null,
    jobType: "fad_readiness",
    nowMs,
  });
  if (
    occurrence.leagueId !== SIDE_CAR_IDS.leagueId ||
    occurrence.seasonId !== SIDE_CAR_IDS.seasonId ||
    occurrence.runId !== SIDE_CAR_IDS.readinessJobRunId ||
    occurrence.binding?.resourceId !== SIDE_CAR_IDS.readinessOperationId
  ) {
    fail(ERROR_CODES.stateChanged);
  }
  const claim = claimOccurrence(repository, occurrence, nowMs, "readiness");
  const claimed = claim.claimed;
  return runtime.services.league.freeAgentDraftReadiness
    .executeClaimedReadiness({
      leagueId: claimed.leagueId,
      seasonId: claimed.seasonId,
      occurrenceKey: claimed.occurrenceKey,
      readinessOperationId: claimed.binding.resourceId,
      jobExecution: {
        runId: claimed.runId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
        expectedVersion: claimed.version,
      },
    });
}

function claimOccurrence(repository, occurrence, nowMs, purpose) {
  const leaseOwner = `strict-fad-privacy-gate-${purpose}`;
  const leaseToken = stableSidecarId("lease", purpose);
  const leaseExpiresAtMs = nowMs + LEASE_DURATION_MS;
  const claim = repository.claim({
    leagueId: occurrence.leagueId,
    seasonId: occurrence.seasonId,
    fadId: occurrence.fadId,
    runId: occurrence.runId,
    jobType: occurrence.jobType,
    occurrenceKey: occurrence.occurrenceKey,
    scheduledForMs: occurrence.scheduledForMs,
    expectedVersion: occurrence.version,
    leaseOwner,
    leaseToken,
    nowMs,
    leaseExpiresAtMs,
  });
  if (claim?.acquired !== true || !claim.occurrence) {
    fail(ERROR_CODES.stateChanged);
  }
  return Object.freeze({
    claimed: claim.occurrence,
    leaseOwner,
    leaseToken,
    leaseExpiresAtMs,
  });
}

function executeDeadline(runtime, scope, nowMs) {
  const repository = runtime.repositories.freeAgentDraftJobs;
  const occurrence = findDueOccurrence(repository, {
    fadId: scope.fad.id,
    jobType: FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE.deadline,
    nowMs,
  });
  const claim = claimOccurrence(repository, occurrence, nowMs, "deadline");
  const claimed = claim.claimed;
  return runtime.services.league.freeAgentDraftDeadline.executeClaimedDeadline({
    leagueId: claimed.leagueId,
    seasonId: claimed.seasonId,
    fadId: claimed.fadId,
    deadlineAtMs: claimed.binding.deadlineAtMs,
    occurrenceKey: claimed.occurrenceKey,
    scheduledForMs: claimed.scheduledForMs,
    jobExecution: {
      runId: claimed.runId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAtMs: claim.leaseExpiresAtMs,
      startedAtMs: claimed.startedAtMs,
      attemptCount: claimed.attemptCount,
      expectedVersion: claimed.version,
    },
  });
}

async function executeAllocation(runtime, scope, nowMs) {
  const repositories = runtime.repositories;
  const lifecycleCandidates =
    repositories.freeAgentDraftAllocationLifecycleWriter
      .listCandidates({ nowMs, limit: 100 })
      .filter(({ fadId }) => fadId === scope.fad.id);
  if (lifecycleCandidates.length !== 1) fail(ERROR_CODES.postcheckFailed);
  const started = runtime.services.league.freeAgentDraftAllocationLifecycle
    .coordinateRoot(lifecycleCandidates[0]);
  if (started.toStatus !== "allocating") fail(ERROR_CODES.postcheckFailed);

  const occurrence = findDueOccurrence(repositories.freeAgentDraftJobs, {
    fadId: scope.fad.id,
    jobType: FREE_AGENT_DRAFT_JOB_TYPE_BY_OCCURRENCE.allocate,
    nowMs,
  });
  const claim = claimOccurrence(
    repositories.freeAgentDraftJobs,
    occurrence,
    nowMs,
    "allocation"
  );
  const claimed = claim.claimed;
  const terminal = await runtime.services.league.candidateAllocation
    .executeClaimedAllocation({
      leagueId: claimed.leagueId,
      seasonId: claimed.seasonId,
      fadId: claimed.fadId,
      allocationId: claimed.binding.allocationId,
      playerId: claimed.binding.playerId,
      occurrenceKey: claimed.occurrenceKey,
      scheduledForMs: claimed.scheduledForMs,
      jobExecution: {
        runId: claimed.runId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseExpiresAtMs: claim.leaseExpiresAtMs,
        startedAtMs: claimed.startedAtMs,
        attemptCount: claimed.attemptCount,
        expectedVersion: claimed.version,
      },
    });
  if (terminal.status !== "restricted_active") {
    fail(ERROR_CODES.horizonInsufficient);
  }
  const afterCandidates =
    repositories.freeAgentDraftAllocationLifecycleWriter
      .listCandidates({ nowMs, limit: 100 })
      .filter(({ fadId }) => fadId === scope.fad.id);
  if (afterCandidates.length !== 1) fail(ERROR_CODES.postcheckFailed);
  const advanced = runtime.services.league.freeAgentDraftAllocationLifecycle
    .coordinateRoot(afterCandidates[0]);
  if (advanced.toStatus !== "rapid") fail(ERROR_CODES.postcheckFailed);
  return terminal;
}

function roleAuthorities(accounts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(accounts)
        .map(([role, account]) => [
          role,
          syntheticAuthenticated(account.userId, role),
        ])
    )
  );
}

function inspectRoleMatrix(runtime, accounts, nowMs) {
  const draft = findDraftScope(runtime.database, "rapid").fad;
  const authority = roleAuthorities(accounts);
  const read = runtime.services.league.freeAgentDraftRead;
  const expectedPrivateByRoleAndTeam = Object.freeze({
    administrator: [false, false],
    commissioner: [false, false],
    managerA: [true, false],
    managerB: [false, true],
  });
  let actionableUntilMs = null;
  let restrictedAuctionId = null;
  for (const [role, authenticated] of Object.entries(authority)) {
    const summaries = read.publishedCardSummaries({
      authenticated,
      leagueId: SIDE_CAR_IDS.leagueId,
      fadId: draft.id,
      query: { cursor: null, limit: 50 },
    });
    if (
      summaries.data.length !== 4
    ) {
      fail(ERROR_CODES.postcheckFailed);
    }
    const summaryByTeamId = new Map(
      summaries.data.map((summary) => [summary.teamId, summary])
    );
    SIDE_CAR_IDS.teamIds.forEach((teamId, index) => {
      const summary = summaryByTeamId.get(teamId);
      const targetTeam = index < 2;
      if (
        !summary ||
        summary.lifecycleStatus !== "locked_incomplete" ||
        summary.outcomeCounts.signed !== 0 ||
        summary.outcomeCounts.notWon !== 0 ||
        summary.outcomeCounts.tied !== (targetTeam ? 1 : 0)
      ) {
        fail(
          ERROR_CODES.postcheckFailed,
          new Error(`Unexpected summaries: ${JSON.stringify(summaries.data)}`)
        );
      }
      const history = read.publishedCardHistory({
        authenticated,
        leagueId: SIDE_CAR_IDS.leagueId,
        fadId: draft.id,
        teamId,
      });
      const results = read.allocationResults({
        authenticated,
        leagueId: SIDE_CAR_IDS.leagueId,
        fadId: draft.id,
        query: {
          cursor: null,
          limit: 50,
          q: "",
          status: "tied",
          teamId,
        },
      });
      if (!targetTeam) {
        if (history.results.length !== 0 || results.data.length !== 0) {
          fail(ERROR_CODES.postcheckFailed);
        }
        return;
      }
      if (
        history.results.length !== 1 ||
        results.data.length !== 1 ||
        JSON.stringify(history.results) !== JSON.stringify(results.data)
      ) {
        fail(ERROR_CODES.postcheckFailed);
      }
      const row = results.data[0];
      const expectedPrivate = expectedPrivateByRoleAndTeam[role][index];
      if (
        row.status !== "tied" ||
        (expectedPrivate
          ? !row.offer || typeof row.tieAuctionId !== "string"
          : row.offer !== null || row.tieAuctionId !== null)
      ) {
        fail(ERROR_CODES.postcheckFailed);
      }
      if (expectedPrivate) {
        if (
          restrictedAuctionId !== null &&
          restrictedAuctionId !== row.tieAuctionId
        ) {
          fail(ERROR_CODES.postcheckFailed);
        }
        restrictedAuctionId = row.tieAuctionId;
      }
    });
  }

  const auction = runtime.database.prepare(`
    SELECT auction.id, auction.status, auction.opened_at_ms,
           auction.resolves_at_ms,
           COUNT(participant.id) AS participant_count
    FROM auctions AS auction
    JOIN auction_contexts AS context
      ON context.league_id = auction.league_id
     AND context.auction_id = auction.id
     AND context.source_kind = 'fad_restricted'
    JOIN free_agent_draft_auction_participants AS participant
      ON participant.league_id = auction.league_id
     AND participant.auction_id = auction.id
     AND participant.status = 'active'
    WHERE auction.league_id = ? AND auction.id = ?
    GROUP BY auction.id
  `).get(SIDE_CAR_IDS.leagueId, restrictedAuctionId);
  if (
    !auction ||
    auction.status !== "open" ||
    auction.opened_at_ms > nowMs ||
    auction.resolves_at_ms <= nowMs ||
    auction.resolves_at_ms - nowMs < MINIMUM_ACTIONABLE_HORIZON_MS ||
    auction.participant_count !== 2
  ) {
    fail(ERROR_CODES.horizonInsufficient);
  }
  for (const [role, targetTeamId, supportTeamId] of [
    ["managerA", SIDE_CAR_IDS.teamIds[0], SIDE_CAR_IDS.teamIds[2]],
    ["managerB", SIDE_CAR_IDS.teamIds[1], SIDE_CAR_IDS.teamIds[3]],
  ]) {
    const projection = runtime.services.league.auction.read({
      authenticated: authority[role],
      leagueId: SIDE_CAR_IDS.leagueId,
      auctionId: restrictedAuctionId,
    });
    const viewerByTeamId = new Map(
      projection.viewerTeams.map((team) => [team.teamId, team])
    );
    const target = viewerByTeamId.get(targetTeamId);
    const support = viewerByTeamId.get(supportTeamId);
    if (
      projection.status !== "active" ||
      projection.sourceKind !== "fad_restricted" ||
      projection.fadId !== draft.id ||
      projection.auctionId !== restrictedAuctionId ||
      projection.viewerTeams.length !== 2 ||
      target?.eligible !== true ||
      target.participantStatus !== "active" ||
      target.bid !== null ||
      target.join.allowed !== true ||
      support?.eligible !== false ||
      support.participantStatus !== null ||
      support.bid !== null ||
      support.join.allowed !== false ||
      support.join.reasonCode !== "TEAM_NOT_PARTICIPANT"
    ) {
      fail(ERROR_CODES.postcheckFailed);
    }
  }
  actionableUntilMs = auction.resolves_at_ms;
  return Object.freeze({
    actionableUntilMs,
    fadId: draft.id,
    restrictedAuctionId,
  });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function serializedRow(row) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        Buffer.isBuffer(value)
          ? { type: "Buffer", base64: value.toString("base64") }
          : value,
      ])
    )
  );
}

function databaseSnapshot(database) {
  const tables = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
  return Object.freeze(
    Object.fromEntries(
      tables.map((table) => [
        table,
        Object.freeze(
          database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`)
            .all()
            .map(serializedRow)
            .sort()
        ),
      ])
    )
  );
}

function insertedRows(before, after) {
  const inserted = {};
  for (const [table, afterRows] of Object.entries(after)) {
    const remaining = new Map();
    for (const row of before[table] || []) {
      remaining.set(row, (remaining.get(row) || 0) + 1);
    }
    const additions = [];
    for (const row of afterRows) {
      const count = remaining.get(row) || 0;
      if (count > 0) remaining.set(row, count - 1);
      else additions.push(row);
    }
    if ([...remaining.values()].some((count) => count !== 0)) {
      fail(ERROR_CODES.writeScopeInvalid);
    }
    if (additions.length > 0) inserted[table] = additions;
  }
  return inserted;
}

function assertAllowlistedInserts(inserted, receiptEventId) {
  const counts = {};
  for (const [table, rows] of Object.entries(inserted)) {
    for (const encoded of rows) {
      const row = JSON.parse(encoded);
      const sidecarScoped =
        row.league_id === SIDE_CAR_IDS.leagueId ||
        (table === "leagues" && row.id === SIDE_CAR_IDS.leagueId);
      const receiptScoped =
        table === "security_audit_events" && row.id === receiptEventId;
      if (!sidecarScoped && !receiptScoped) {
        fail(
          ERROR_CODES.writeScopeInvalid,
          new Error(
            `Unscoped insert in ${table} (${Object.keys(row).join(",")}).`
          )
        );
      }
    }
    counts[table] = rows.length;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    )
  );
}

function expectedInsertedRowCounts(weekCount) {
  if (!Number.isSafeInteger(weekCount) || weekCount < 1) {
    fail(ERROR_CODES.postcheckFailed);
  }
  return Object.freeze({
    auction_contexts: 1,
    auctions: 1,
    candidate_card_entries: 2,
    candidate_card_revisions: 10,
    candidate_card_snapshot_entries: 88,
    candidate_card_snapshots: 4,
    candidate_cards: 4,
    free_agent_draft_allocation_events: 3,
    free_agent_draft_auction_participants: 2,
    free_agent_draft_draws: 1,
    free_agent_draft_player_allocations: 1,
    free_agent_draft_readiness_attempts: 1,
    free_agent_draft_readiness_operations: 1,
    free_agent_draft_rollovers: 7,
    free_agent_draft_teams: 4,
    free_agent_drafts: 1,
    idempotency_requests: 2,
    job_runs: weekCount * 6 + 11,
    league_activity: 3,
    league_memberships: 4,
    league_player_positions: 1,
    league_settings: 1,
    leagues: 1,
    matchup_operations: 1,
    matchup_schedule_job_bindings: weekCount * 6,
    matchup_weeks: weekCount,
    matchups: weekCount * 2,
    notifications: 14,
    outbox_event_audiences: 29,
    outbox_events: 29,
    season_matchup_schedule_generations: 1,
    seasons: 1,
    security_audit_events: 1,
    team_manager_assignments: 4,
    teams: 4,
  });
}

function currentSidecarRowCounts(database, receiptId, expected) {
  const counts = {};
  for (const table of Object.keys(expected)) {
    if (table === "leagues") {
      counts[table] = database.prepare(
        "SELECT COUNT(*) AS count FROM leagues WHERE id = ?"
      ).get(SIDE_CAR_IDS.leagueId).count;
      continue;
    }
    if (table === "security_audit_events") {
      counts[table] = database.prepare(`
        SELECT COUNT(*) AS count
        FROM security_audit_events WHERE id = ?
      `).get(receiptId).count;
      continue;
    }
    counts[table] = database.prepare(`
      SELECT COUNT(*) AS count
      FROM ${quoteIdentifier(table)}
      WHERE league_id = ?
    `).get(SIDE_CAR_IDS.leagueId).count;
  }
  return Object.freeze(counts);
}

function exactCounts(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function publicFacts({ operationId, preparedAtMs, roleMatrix }) {
  return Object.freeze({
    fixtureKind: FIXTURE_KIND,
    fixtureName: FIXTURE_NAME,
    operationId,
    preparedAtMs,
    leagueId: SIDE_CAR_IDS.leagueId,
    seasonId: SIDE_CAR_IDS.seasonId,
    fadId: roleMatrix.fadId,
    restrictedAuctionId: roleMatrix.restrictedAuctionId,
    activeTeamIds: [...SIDE_CAR_IDS.teamIds],
    selectedTeamIds: [...SIDE_CAR_IDS.teamIds.slice(0, 2)],
    actionableUntilMs: roleMatrix.actionableUntilMs,
    activeTeamCount: 4,
    selectedTeamCount: 2,
    tiedPlayerCount: 1,
    restrictedParticipantCount: 2,
    roleAliases: { ...ACCOUNT_ALIASES },
    initialTeamManagers: SIDE_CAR_IDS.teamIds.map((teamId, index) => ({
      teamId,
      managerAlias: index % 2 === 0 ? "managerA" : "managerB",
    })),
    requiredHostedTransferSmoke: {
      team1: "managerA-to-managerB-to-managerA",
      team2ManagerRemains: "managerB",
    },
    reversal: {
      kind: "verified_backup_restore",
      requiredBackupBoundary: "post-credential-rotation-pre-fixture",
      requiresFullHold: true,
    },
  });
}

function receiptEventId(databaseId, operationId) {
  return stableUuid([
    "hundo-leago",
    FIXTURE_KIND,
    databaseId,
    operationId,
    "receipt",
  ]);
}

function receiptReason(fingerprint) {
  return `strict_fad_privacy_gate_v1_${fingerprint.slice(0, 16)}`;
}

function sanitizedResult(facts, {
  environmentId,
  databaseId,
  schemaVersion,
  receiptId,
  fingerprint,
  replayed,
  databaseWriteCount,
  insertedRowCounts,
}) {
  return Object.freeze({
    code: RESULT_CODE,
    contractVersion: CONTRACT_VERSION,
    operationId: facts.operationId,
    environmentId,
    databaseId,
    schemaVersion,
    fixtureKind: facts.fixtureKind,
    fixtureName: facts.fixtureName,
    leagueId: facts.leagueId,
    seasonId: facts.seasonId,
    fadId: facts.fadId,
    restrictedAuctionId: facts.restrictedAuctionId,
    activeTeamIds: Object.freeze([...facts.activeTeamIds]),
    selectedTeamIds: Object.freeze([...facts.selectedTeamIds]),
    actionableUntilMs: facts.actionableUntilMs,
    activeTeamCount: facts.activeTeamCount,
    selectedTeamCount: facts.selectedTeamCount,
    tiedPlayerCount: facts.tiedPlayerCount,
    restrictedParticipantCount: facts.restrictedParticipantCount,
    roleAliases: Object.freeze({ ...facts.roleAliases }),
    initialTeamManagers: Object.freeze(
      facts.initialTeamManagers.map((assignment) =>
        Object.freeze({ ...assignment })
      )
    ),
    requiredHostedTransferSmoke: Object.freeze({
      ...facts.requiredHostedTransferSmoke,
    }),
    reversal: Object.freeze({ ...facts.reversal }),
    receiptEventId: receiptId,
    fixtureFingerprint: fingerprint,
    preparedAtMs: facts.preparedAtMs,
    replayed,
    databaseWriteCount,
    insertedRowCounts: Object.freeze({ ...insertedRowCounts }),
  });
}

function readReceipt(auditRepository, expected) {
  const row = auditRepository.findById(expected.receiptId);
  if (!row) return null;
  if (
    row.event_type !== EVENT_TYPE ||
    row.outcome !== "success" ||
    row.actor_user_id !== null ||
    row.target_user_id !== null ||
    row.league_id !== SIDE_CAR_IDS.leagueId ||
    row.session_id !== null ||
    row.request_correlation_id !== expected.operationId ||
    row.network_key_version !== null ||
    row.network_metadata_digest !== null ||
    row.client_metadata_json !== null ||
    row.unknown_account_digest !== null ||
    !Number.isSafeInteger(row.occurred_at_ms) ||
    row.occurred_at_ms < 0
  ) {
    fail(ERROR_CODES.idempotencyConflict);
  }
  return Object.freeze({ ...row });
}

async function prepareReleaseQaFadPrivacyGate({
  runtime,
  operationId,
  environmentId,
  databaseId,
  schemaVersion,
  nowMs,
  assertBinding,
  failureHook = null,
} = {}) {
  if (
    !runtime?.database ||
    typeof runtime.database.prepare !== "function" ||
    typeof runtime.database.exec !== "function" ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID ||
    typeof operationId !== "string" ||
    !/^HL-\d{8}-[1-9]\d*$/u.test(operationId) ||
    schemaVersion !== REQUIRED_SCHEMA_VERSION ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    typeof assertBinding !== "function" ||
    ![null, "function"].includes(
      failureHook === null ? null : typeof failureHook
    )
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  const database = runtime.database;
  const auditRepository = createSqliteSecurityAuditRepository({ database });
  const receiptId = receiptEventId(databaseId, operationId);
  assertBinding();
  fixtureAccounts(database);
  assertGammaSource(database);

  const priorReceipt = readReceipt(auditRepository, {
    receiptId,
    operationId,
  });
  if (priorReceipt) {
    const beforeReplayChanges = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    try {
      database.exec("BEGIN IMMEDIATE");
      assertBinding();
      const accounts = fixtureAccounts(database);
      assertGammaSource(database);
      const clockState = { nowMs };
      const clocked = createClockedRuntime(runtime, clockState, operationId);
      const matrix = inspectRoleMatrix(clocked, accounts, nowMs);
      const facts = publicFacts({
        operationId,
        preparedAtMs: priorReceipt.occurred_at_ms,
        roleMatrix: matrix,
      });
      const fingerprint = canonicalHash(facts);
      const weekCount = database.prepare(`
        SELECT COUNT(*) AS count
        FROM matchup_weeks
        WHERE league_id = ?
      `).get(SIDE_CAR_IDS.leagueId).count;
      const insertedRowCounts = expectedInsertedRowCounts(weekCount);
      if (
        priorReceipt.reason_code !== receiptReason(fingerprint) ||
        !exactCounts(
          currentSidecarRowCounts(database, receiptId, insertedRowCounts),
          insertedRowCounts
        ) ||
        database.prepare("SELECT total_changes() AS count").get().count !==
          beforeReplayChanges ||
        database.pragma("foreign_key_check").length !== 0 ||
        database.pragma("integrity_check", { simple: true }) !== "ok"
      ) {
        fail(ERROR_CODES.idempotencyConflict);
      }
      assertBinding();
      database.exec("COMMIT");
      return sanitizedResult(facts, {
        environmentId,
        databaseId,
        schemaVersion,
        receiptId,
        fingerprint,
        replayed: true,
        databaseWriteCount: 0,
        insertedRowCounts,
      });
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      if (error instanceof ReleaseQaFadPrivacyGateError) throw error;
      fail(ERROR_CODES.idempotencyConflict, error);
    }
  }

  if (
    database.prepare("SELECT COUNT(*) AS count FROM leagues WHERE id = ?")
      .get(SIDE_CAR_IDS.leagueId).count !== 0
  ) {
    fail(ERROR_CODES.idempotencyConflict);
  }

  const before = databaseSnapshot(database);
  const totalChangesBefore = database.prepare(
    "SELECT total_changes() AS count"
  ).get().count;
  try {
    database.exec("BEGIN IMMEDIATE");
    assertBinding();
    assertGammaSource(database);
    if (
      readReceipt(auditRepository, { receiptId, operationId }) ||
      database.prepare("SELECT COUNT(*) AS count FROM leagues WHERE id = ?")
        .get(SIDE_CAR_IDS.leagueId).count !== 0
    ) {
      fail(ERROR_CODES.stateChanged);
    }
    const accounts = fixtureAccounts(database);
    const schedule = scheduleFor(nowMs);
    const createdAtMs = schedule.openedAtMs - DAY_MS;
    const foundations = seedSidecarFoundations({
      runtime,
      accounts,
      schedule,
      createdAtMs,
      activatedAtMs: schedule.openedAtMs,
    });
    const player = selectPlayer({
      database,
      runtime,
      accounts,
      createdAtMs,
    });
    const readiness = createFreeAgentDraftReadinessTriggerPlan({
      operationId: SIDE_CAR_IDS.readinessOperationId,
      jobRunId: SIDE_CAR_IDS.readinessJobRunId,
      leagueId: SIDE_CAR_IDS.leagueId,
      seasonId: SIDE_CAR_IDS.seasonId,
      triggerKind: "no_draft_inaugural",
      triggerResourceId: SIDE_CAR_IDS.seasonId,
      entryDraftId: null,
      setupExemptionId: null,
      createdAtMs: schedule.openedAtMs,
    });
    runtime.repositories.freeAgentDraftReadinessHandoffWriter.write({
      operationId: readiness.readiness.operationId,
      jobRunId: readiness.job.id,
      leagueId: readiness.readiness.leagueId,
      seasonId: readiness.readiness.seasonId,
      triggerKind: readiness.readiness.triggerKind,
      triggerResourceId: readiness.readiness.triggerResourceId,
      entryDraftId: null,
      setupExemptionId: null,
      createdAtMs: readiness.readiness.createdAtMs,
    });

    const clockState = { nowMs: schedule.openedAtMs };
    const clocked = createClockedRuntime(runtime, clockState, operationId);
    const opening = await executeReadiness(clocked, clockState.nowMs);
    if (opening.outcome !== "succeeded") {
      fail(
        ERROR_CODES.postcheckFailed,
        new Error(`Unexpected readiness result: ${JSON.stringify(opening)}`)
      );
    }
    const openScope = findDraftScope(database, "cards_open");
    const cardByTeamId = new Map(
      openScope.cards.map((card) => [card.team_id, card])
    );
    clockState.nowMs = openScope.fad.candidate_deadline_at_ms - 1;
    const managerRoles = ["managerA", "managerB"];
    for (let index = 0; index < 2; index += 1) {
      const role = managerRoles[index];
      const teamId = SIDE_CAR_IDS.teamIds[index];
      const card = cardByTeamId.get(teamId);
      const result = clocked.services.league.candidateCards.addCandidate({
        authenticated: syntheticAuthenticated(accounts[role].userId, role),
        leagueId: SIDE_CAR_IDS.leagueId,
        fadId: openScope.fad.id,
        teamId,
        slotKey: "F01",
        input: {
          playerId: player.playerId,
          aavCents: 500,
          termYears: 1,
        },
        expectedCardVersion: card.version,
        idempotencyKey: `strict-fad-privacy-gate-${role}`,
      });
      if (result.data.card.cardVersion !== card.version + 1) {
        fail(ERROR_CODES.postcheckFailed);
      }
    }
    if (failureHook) failureHook("after-candidates");

    clockState.nowMs = openScope.fad.candidate_deadline_at_ms;
    const deadline = executeDeadline(clocked, openScope, clockState.nowMs);
    if (deadline.allocationCount !== 1 || deadline.cardCount !== 4) {
      fail(ERROR_CODES.postcheckFailed);
    }
    const lockedScope = findDraftScope(database, "deadline_locked");
    clockState.nowMs = nowMs;
    const allocation = await executeAllocation(
      clocked,
      lockedScope,
      clockState.nowMs
    );
    if (
      allocation.restrictedAuction?.participants?.length !== 2 ||
      allocation.restrictedAuction.openedAtMs > nowMs ||
      allocation.restrictedAuction.resolvesAtMs <= nowMs
    ) {
      fail(ERROR_CODES.postcheckFailed);
    }
    if (failureHook) failureHook("after-allocation");

    const matrix = inspectRoleMatrix(clocked, accounts, nowMs);
    const facts = publicFacts({
      operationId,
      preparedAtMs: nowMs,
      roleMatrix: matrix,
    });
    const fingerprint = canonicalHash(facts);
    auditRepository.append({
      id: receiptId,
      event_type: EVENT_TYPE,
      outcome: "success",
      actor_user_id: null,
      target_user_id: null,
      league_id: SIDE_CAR_IDS.leagueId,
      session_id: null,
      request_correlation_id: operationId,
      reason_code: receiptReason(fingerprint),
      network_key_version: null,
      network_metadata_digest: null,
      client_metadata_json: null,
      unknown_account_digest: null,
      occurred_at_ms: nowMs,
    });
    if (failureHook) failureHook("after-receipt");
    assertBinding();
    const persistedReceipt = readReceipt(auditRepository, {
      receiptId,
      operationId,
    });
    if (
      persistedReceipt?.reason_code !== receiptReason(fingerprint) ||
      database.pragma("foreign_key_check").length !== 0 ||
      database.pragma("integrity_check", { simple: true }) !== "ok"
    ) {
      fail(ERROR_CODES.postcheckFailed);
    }
    const after = databaseSnapshot(database);
    const inserted = insertedRows(before, after);
    const insertedRowCounts = assertAllowlistedInserts(inserted, receiptId);
    const databaseWriteCount =
      database.prepare("SELECT total_changes() AS count").get().count -
      totalChangesBefore;
    const weekCount = foundations.planned.weeks.length;
    const expectedRowCounts = expectedInsertedRowCounts(weekCount);
    const expectedWriteCount =
      FIXED_DATABASE_WRITE_COUNT +
      weekCount * PER_MATCHUP_WEEK_DATABASE_WRITE_COUNT;
    if (
      !exactCounts(insertedRowCounts, expectedRowCounts) ||
      databaseWriteCount !== expectedWriteCount
    ) {
      fail(ERROR_CODES.writeScopeInvalid);
    }
    database.exec("COMMIT");
    return sanitizedResult(facts, {
      environmentId,
      databaseId,
      schemaVersion,
      receiptId,
      fingerprint,
      replayed: false,
      databaseWriteCount,
      insertedRowCounts: expectedRowCounts,
    });
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        fail(ERROR_CODES.failed, new AggregateError([error, rollbackError]));
      }
    }
    if (error instanceof ReleaseQaFadPrivacyGateError) throw error;
    fail(
      ERROR_CODES.failed,
      new Error(
        typeof error?.message === "string"
          ? error.message
          : "The strict FAD fixture dependency failed.",
        { cause: error }
      )
    );
  }
}

module.exports = {
  ACCOUNT_ALIASES,
  CONTRACT_VERSION,
  ERROR_CODES,
  EVENT_TYPE,
  FIXTURE_KIND,
  FIXTURE_NAME,
  MINIMUM_ACTIONABLE_HORIZON_MS,
  REQUIRED_SCHEMA_VERSION,
  RESULT_CODE,
  SIDE_CAR_IDS,
  TEAM_NAMES,
  ReleaseQaFadPrivacyGateError,
  databaseSnapshot,
  prepareReleaseQaFadPrivacyGate,
  receiptEventId,
  scheduleFor,
};
