"use strict";

const path = require("node:path");

const {
  createSecurityFoundations,
} = require("../../bootstrap/createSecurityFoundations");
const {
  createTargetRuntime,
} = require("../../bootstrap/createTargetRuntime");
const {
  FIXTURE_NOW_MS,
  fixtureEmail,
  fixtureId,
} = require("./releaseQaFixtureContract");
const {
  FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  ENTRY_DRAFT_SCHEDULE_ACTION,
  ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
} = require(
  "../../domain/drafts/entryDraftSchedulePolicy"
);
const {
  STANDINGS_FINALIZATION_CONFIRMATION,
} = require(
  "../../domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  planExplicitMatchupSchedule,
} = require("../../domain/matchups/matchupSchedulePolicy");
const {
  buildMatchupOccurrenceKey,
} = require("../../domain/matchups/matchupJobPolicy");
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../domain/statistics/playerGameStatisticsPolicy");
const {
  normalizeStatisticsRows,
} = require("../../domain/statistics/statisticsPolicy");

const DAY_MS = 24 * 60 * 60 * 1_000;
const BROWSER_FIXTURE_SCHEMA_VERSION = 4;
const BROWSER_FIXTURE_KIND = "free_agent_draft_browser";
const HELP_MESSAGE =
  "Alpha exact commissioner help private sentinel.";
const VANCOUVER_TIME_ZONE = "America/Vancouver";

function vancouverDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VANCOUVER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(
    parts
      .filter(({ type }) => ["year", "month", "day"].includes(type))
      .map(({ type, value }) => [type, Number(value)])
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
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName || "");
  if (!match) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_CLOCK_INVALID",
      "The FAD browser fixture could not resolve Vancouver time."
    );
  }
  const direction = match[1] === "+" ? 1 : -1;
  const offsetMinutes =
    direction * (Number(match[2]) * 60 + Number(match[3]));
  return Date.UTC(year, month - 1, day) - offsetMinutes * 60_000;
}

function nextVancouverMondayAtOrAfter(timestamp) {
  const local = vancouverDateParts(timestamp);
  for (let offset = 0; offset < 14; offset += 1) {
    const candidateDate = new Date(
      Date.UTC(local.year, local.month - 1, local.day + offset)
    );
    if (candidateDate.getUTCDay() !== 1) continue;
    const candidate = vancouverMidnightMs(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate()
    );
    if (candidate >= timestamp) return candidate;
  }
  fail(
    "FREE_AGENT_DRAFT_BROWSER_FIXTURE_CLOCK_INVALID",
    "The FAD browser fixture could not resolve its next Monday."
  );
}

function schedulesFor(nowMs) {
  const preseasonFirstWeekStartsAtMs = nextVancouverMondayAtOrAfter(
    nowMs + 8 * DAY_MS
  );
  const alphaFirstWeekStartsAtMs = preseasonFirstWeekStartsAtMs;
  const betaFirstWeekStartsAtMs = preseasonFirstWeekStartsAtMs;
  const gammaFirstWeekStartsAtMs = nextVancouverMondayAtOrAfter(
    nowMs - 13 * DAY_MS
  );
  const betaPriorFirstWeekStartsAtMs =
    vancouverMidnightMs(2026, 3, 16);
  const schedule = (firstWeekStartsAtMs) => Object.freeze({
    nhlRegularSeasonStartsAtMs: firstWeekStartsAtMs - 6 * DAY_MS,
    nhlRegularSeasonEndsAtMs:
      vancouverMidnightMs(2027, 5, 3),
    fantasyPlayoffsStartAtMs:
      vancouverMidnightMs(2027, 4, 5),
    fantasyPlayoffsEndAtMs:
      vancouverMidnightMs(2027, 5, 3),
    firstWeekStartsAtMs,
  });
  return Object.freeze({
    alpha: schedule(alphaFirstWeekStartsAtMs),
    beta: schedule(betaFirstWeekStartsAtMs),
    gamma: schedule(gammaFirstWeekStartsAtMs),
    betaPrior: Object.freeze({
      nhlRegularSeasonStartsAtMs:
        vancouverMidnightMs(2025, 10, 6),
      nhlRegularSeasonEndsAtMs:
        vancouverMidnightMs(2026, 4, 27),
      fantasyPlayoffsStartAtMs:
        vancouverMidnightMs(2026, 3, 30),
      fantasyPlayoffsEndAtMs:
        vancouverMidnightMs(2026, 4, 27),
      firstWeekStartsAtMs:
        betaPriorFirstWeekStartsAtMs,
    }),
  });
}

const ACCOUNT_BLUEPRINTS = Object.freeze({
  platformAdmin: Object.freeze({
    fixtureAlias: "platformAdmin",
  }),
  alphaCommissioner: Object.freeze({
    fixtureAlias: "leagueACommissioner",
  }),
  alphaMultiTeamManager: Object.freeze({
    fixtureAlias: "leagueAManagerOne",
  }),
  alphaOtherManager: Object.freeze({
    fixtureAlias: "leagueAManagerTwo",
  }),
  betaCommissioner: Object.freeze({
    fixtureAlias: "leagueBCommissioner",
  }),
  betaManager: Object.freeze({
    fixtureAlias: "leagueBManagerOne",
  }),
  betaOtherManager: Object.freeze({
    fixtureAlias: "leagueAManagerTwo",
  }),
  gammaCommissioner: Object.freeze({
    fixtureAlias: "leagueACommissioner",
  }),
  gammaManagerOne: Object.freeze({
    fixtureAlias: "leagueAManagerOne",
  }),
  gammaManagerTwo: Object.freeze({
    fixtureAlias: "leagueAManagerTwo",
  }),
  gammaManagerThree: Object.freeze({
    fixtureAlias: "leagueBManagerOne",
  }),
});

const LEAGUE_BLUEPRINTS = Object.freeze({
  alpha: Object.freeze({
    name: "Alpha League",
    scenario: "inaugural_fad",
    commissionerAccountAlias: "alphaCommissioner",
    memberAccountAliases: Object.freeze([
      "platformAdmin",
      "alphaCommissioner",
      "alphaMultiTeamManager",
      "alphaOtherManager",
    ]),
    teamManagerAccountAliases: Object.freeze([
      "alphaMultiTeamManager",
      "alphaOtherManager",
      "alphaMultiTeamManager",
      "alphaOtherManager",
      "alphaMultiTeamManager",
      "alphaOtherManager",
      "alphaMultiTeamManager",
      "alphaOtherManager",
    ]),
    carryovers: Object.freeze([]),
  }),
  beta: Object.freeze({
    name: "Beta League",
    scenario: "second_season_fad",
    commissionerAccountAlias: "alphaCommissioner",
    memberAccountAliases: Object.freeze([
      "platformAdmin",
      "alphaCommissioner",
      "betaCommissioner",
      "betaManager",
      "betaOtherManager",
    ]),
    teamManagerAccountAliases: Object.freeze([
      "betaManager",
      "betaOtherManager",
      "betaManager",
      "betaOtherManager",
      "betaManager",
      "betaOtherManager",
    ]),
    carryovers: Object.freeze([
      Object.freeze({ positionGroup: "F", slotNumber: 1, aavCents: 100, termYears: 2 }),
      Object.freeze({ positionGroup: "F", slotNumber: 2, aavCents: 200, termYears: 3 }),
      Object.freeze({ positionGroup: "F", slotNumber: 3, aavCents: 400, termYears: 2 }),
      Object.freeze({ positionGroup: "F", slotNumber: 4, aavCents: 700, termYears: 3 }),
      Object.freeze({ positionGroup: "D", slotNumber: 1, aavCents: 1_000, termYears: 2 }),
      Object.freeze({ positionGroup: "D", slotNumber: 2, aavCents: 1_500, termYears: 3 }),
    ]),
  }),
  gamma: Object.freeze({
    name: "Gamma League",
    scenario: "week_1_completed_fad",
    commissionerAccountAlias: "gammaCommissioner",
    memberAccountAliases: Object.freeze([
      "platformAdmin",
      "gammaCommissioner",
      "gammaManagerOne",
      "gammaManagerTwo",
      "gammaManagerThree",
    ]),
    teamManagerAccountAliases: Object.freeze(
      Array.from({ length: 14 }, (_, index) => [
        "gammaManagerOne",
        "gammaManagerTwo",
        "gammaManagerThree",
      ][index % 3])
    ),
    carryovers: Object.freeze([
      Object.freeze({ positionGroup: "F", slotNumber: 1, aavCents: 500, termYears: 2 }),
    ]),
  }),
});

const PLAYER_BLUEPRINTS = Object.freeze({
  betaPrivateCandidate: Object.freeze({
    leagueAlias: "beta",
    positionGroup: "D",
  }),
});

function carryoverAlias(leagueAlias, teamIndex, carryoverIndex) {
  return `${leagueAlias}Team${teamIndex + 1}Carryover${carryoverIndex + 1}`;
}

class FreeAgentDraftBrowserFixtureError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "FreeAgentDraftBrowserFixtureError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new FreeAgentDraftBrowserFixtureError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID",
      `The local FAD browser fixture requires ${description}.`
    );
  }
}

function assertRuntime(runtime) {
  if (
    !runtime ||
    !runtime.database ||
    runtime.database.open !== true ||
    runtime.database.pragma("user_version", { simple: true }) !== 54
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID",
      "The local FAD browser fixture requires an open schema-54 release-QA runtime."
    );
  }
  requireMethod(
    runtime.database,
    "transaction",
    "a transactional disposable database"
  );
  requireMethod(
    runtime.services?.sessionService,
    "issueForUser",
    "the real session service"
  );
  requireMethod(
    runtime.services?.sessionService,
    "resolveWithoutActivity",
    "the real session resolver"
  );
  requireMethod(
    runtime.services?.league?.start,
    "start",
    "the real league-start service"
  );
  requireMethod(
    runtime.services?.league?.matchupSchedule,
    "generate",
    "the real matchup-schedule service"
  );
  requireMethod(
    runtime.services?.league?.matchupWeeks,
    "advance",
    "the real matchup-week lifecycle service"
  );
  requireMethod(
    runtime.services?.league?.matchupScoring,
    "readLive",
    "the real live matchup-scoring service"
  );
  requireMethod(
    runtime.services?.league?.matchupResults,
    "finalize",
    "the real matchup-result service"
  );
  requireMethod(
    runtime.services?.league?.matchupStandings,
    "read",
    "the real matchup-standings service"
  );
  requireMethod(
    runtime.services?.league?.standingsFinalization,
    "finalize",
    "the real standings-finalization service"
  );
  requireMethod(
    runtime.services?.league?.entryDraftSchedule,
    "schedule",
    "the real Entry Draft scheduling service"
  );
  requireMethod(
    runtime.services?.league?.seasonRolloverJob,
    "run",
    "the real season-rollover job"
  );
  requireMethod(
    runtime.repositories?.freeAgentDraftReadinessHandoffWriter,
    "write",
    "the canonical FAD readiness-handoff writer"
  );
  requireMethod(
    runtime.services?.league?.freeAgentDraftReadinessJob,
    "run",
    "the real FAD readiness job"
  );
  requireMethod(
    runtime.services?.league?.candidateCards,
    "addCandidate",
    "the real Candidate Card mutation service"
  );
  requireMethod(
    runtime.services?.league?.candidateCards,
    "requestHelp",
    "the real Candidate Card help service"
  );
  return runtime;
}

function accountRecords() {
  return Object.fromEntries(
    Object.entries(ACCOUNT_BLUEPRINTS).map(
      ([alias, blueprint]) => [
        alias,
        Object.freeze({
          alias,
          userId: fixtureId(
            `account:${blueprint.fixtureAlias}`
          ),
          email: fixtureEmail(
            blueprint.fixtureAlias
          ),
        }),
      ]
    )
  );
}

function insertLeagueFoundations({
  repositories,
  accounts,
  leagueAlias,
  blueprint,
  fixtureNowMs,
}) {
  const createdAtMs =
    blueprint.scenario === "week_1_completed_fad"
      ? fixtureNowMs - 45 * DAY_MS
      : blueprint.scenario === "second_season_fad"
        ? fixtureNowMs - 400 * DAY_MS
      : fixtureNowMs - DAY_MS;
  const leagueId = fixtureId(
    `fad-browser-v4:league:${leagueAlias}`
  );
  const seasonId = fixtureId(
    `fad-browser-v4:season:${leagueAlias}`
  );
  const priorSeasonId =
    blueprint.scenario === "second_season_fad"
      ? fixtureId(`fad-browser-v4:season:${leagueAlias}:prior`)
      : null;
  const initialSeasonId = priorSeasonId || seasonId;
  const commissioner =
    accounts[blueprint.commissionerAccountAlias];
  const membershipByAccountAlias = {};

  repositories.leagues.insert({
    id: leagueId,
    name: blueprint.name,
    name_normalized: blueprint.name.toLowerCase(),
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: leagueId,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms:
      fixtureNowMs + 120 * DAY_MS,
    maximum_teams:
      blueprint.teamManagerAccountAliases.length,
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
    id: initialSeasonId,
    league_id: leagueId,
    label: priorSeasonId ? "2025-26" : "2026",
    nhl_season_key: priorSeasonId ? "20252026" : "20262027",
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
  for (const accountAlias of
    blueprint.memberAccountAliases) {
    const account = accounts[accountAlias];
    const membershipId = fixtureId(
      `fad-browser-v4:membership:${leagueAlias}:${accountAlias}`
    );
    repositories.league_memberships.insert({
      id: membershipId,
      league_id: leagueId,
      user_id: account.userId,
      permission_category:
        accountAlias ===
        blueprint.commissionerAccountAlias
          ? "commissioner"
          : accountAlias === "platformAdmin"
            ? "member"
            : "manager",
      status: "active",
      joined_at_ms: createdAtMs,
      ended_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    membershipByAccountAlias[accountAlias] =
      membershipId;
  }

  const teams = blueprint.teamManagerAccountAliases.map(
    (managerAccountAlias, index) => {
      const teamNumber = index + 1;
      const alias = `${leagueAlias}Team${teamNumber}`;
      const teamId = fixtureId(
        `fad-browser-v4:team:${leagueAlias}:${teamNumber}`
      );
      const name =
        `${blueprint.name} Team ${teamNumber}`;
      repositories.teams.insert({
        id: teamId,
        league_id: leagueId,
        name,
        name_normalized: name.toLowerCase(),
        status: "setup",
        primary_colour:
          index % 2 === 0 ? "#16324f" : "#b03a2e",
        secondary_colour: "#f7f7f7",
        logo_reference: null,
        created_at_ms: createdAtMs,
        updated_at_ms: createdAtMs,
        version: 1,
      });
      repositories.team_manager_assignments.insert({
        id: fixtureId(
          `fad-browser-v4:assignment:${leagueAlias}:${teamNumber}`
        ),
        league_id: leagueId,
        team_id: teamId,
        user_id: accounts[managerAccountAlias].userId,
        membership_id:
          membershipByAccountAlias[managerAccountAlias],
        assigned_by_user_id: commissioner.userId,
        replaces_assignment_id: null,
        status: "accepted",
        assigned_at_ms: createdAtMs,
        accepted_at_ms: createdAtMs,
        ended_at_ms: null,
        version: 1,
      });
      return Object.freeze({
        alias,
        name,
        teamId,
        managerAccountAlias,
      });
    }
  );

  const league = repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        membershipByAccountAlias[
          blueprint.commissionerAccountAlias
        ],
      current_season_id: initialSeasonId,
      updated_at_ms: fixtureNowMs,
    },
  });

  return Object.freeze({
    alias: leagueAlias,
    leagueId,
    seasonId,
    priorSeasonId,
    initialSeasonId,
    expectedLeagueVersion: league.version,
    fixtureCreatedAtMs: createdAtMs,
    commissionerAccountAlias:
      blueprint.commissionerAccountAlias,
    teams: Object.freeze(teams),
  });
}

function selectCatalogPlayers(database) {
  const rows = database.prepare(`
    SELECT
      player.id,
      player.full_name,
      source.normalized_position AS position_group
    FROM players AS player
    INNER JOIN player_external_ids AS external
      ON external.player_id = player.id
     AND external.provider = 'sportsdataio-discovery-lab'
    INNER JOIN player_source_state AS source
      ON source.player_id = player.id
     AND source.provider = 'sportsdataio-discovery-lab'
     AND source.ended_at_ms IS NULL
     AND source.active = 1
     AND source.normalized_position IN ('F', 'D')
    WHERE player.status = 'active'
      AND lower(player.full_name) NOT LIKE 'fixture player %'
    GROUP BY player.id, source.normalized_position
    ORDER BY
      lower(player.full_name) ASC,
      player.id ASC
  `).all();
  const available = new Map([
    ["F", rows.filter(({ position_group: position }) => position === "F")],
    ["D", rows.filter(({ position_group: position }) => position === "D")],
  ]);
  const players = {};
  function select(positionGroup) {
    const selected = available.get(positionGroup)?.shift();
    if (!selected) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PLAYER_CATALOG_INCOMPLETE",
        "The FAD browser fixture requires enough catalog-backed players."
      );
    }
    return selected;
  }
  function add(alias, blueprint) {
    const selected = select(blueprint.positionGroup);
    players[alias] = Object.freeze({
      alias,
      playerId: selected.id,
      fullName: selected.full_name,
      ...blueprint,
    });
  }
  for (const [alias, blueprint] of Object.entries(PLAYER_BLUEPRINTS)) {
    add(alias, {
      kind: "candidate",
      leagueAlias: blueprint.leagueAlias,
      positionGroup: blueprint.positionGroup,
    });
  }
  for (const [leagueAlias, leagueBlueprint] of
    Object.entries(LEAGUE_BLUEPRINTS)) {
    leagueBlueprint.teamManagerAccountAliases.forEach((_, teamIndex) => {
      leagueBlueprint.carryovers.forEach((blueprint, carryoverIndex) => {
        const alias = carryoverAlias(
          leagueAlias,
          teamIndex,
          carryoverIndex
        );
        add(alias, {
          kind: "carryover",
          leagueAlias,
          teamIndex,
          ...blueprint,
        });
      });
    });
  }

  const gammaForwardAavs = Object.freeze([
    1_500, 900, 700, 500, 400, 300, 300, 300, 200,
  ]);
  const gammaDefenceAavs = Object.freeze([
    700, 500, 400, 300, 300, 300,
  ]);
  LEAGUE_BLUEPRINTS.gamma.teamManagerAccountAliases.forEach((_, teamIndex) => {
    add(`gammaTeam${teamIndex + 1}SharedWinner`, {
      kind: "gamma_candidate",
      leagueAlias: "gamma",
      teamIndex,
      positionGroup: "F",
      slotKey: "F11",
      aavCents: 500 + (teamIndex % 5) * 100,
      termYears: 3,
      shared: true,
    });
    gammaForwardAavs.forEach((aavCents, index) => {
      const isThirtyDollarThreeYearExample =
        teamIndex === 0 && index === 0;
      add(`gammaTeam${teamIndex + 1}ForwardWinner${index + 1}`, {
        kind: "gamma_candidate",
        leagueAlias: "gamma",
        teamIndex,
        positionGroup: "F",
        slotKey: `F${String(index + 2).padStart(2, "0")}`,
        aavCents: isThirtyDollarThreeYearExample ? 1_000 : aavCents,
        termYears: isThirtyDollarThreeYearExample
          ? 3
          : (index % 3) + 1,
        shared: false,
      });
    });
    gammaDefenceAavs.forEach((aavCents, index) => {
      add(`gammaTeam${teamIndex + 1}DefenceWinner${index + 1}`, {
        kind: "gamma_candidate",
        leagueAlias: "gamma",
        teamIndex,
        positionGroup: "D",
        slotKey: `D${String(index + 1).padStart(2, "0")}`,
        aavCents,
        termYears: (index % 3) + 1,
        shared: false,
      });
    });
    add(`gammaTeam${teamIndex + 1}PostFadForward`, {
      kind: "deferred_roster",
      leagueAlias: "gamma",
      teamIndex,
      positionGroup: "F",
      rosterCategory: "Active",
      slotNumber: 12,
      aavCents: 300,
      termYears: 1,
    });
    ["F", "F", "D", "D"].forEach((positionGroup, index) => {
      add(`gammaTeam${teamIndex + 1}Bench${index + 1}`, {
        kind: "deferred_roster",
        leagueAlias: "gamma",
        teamIndex,
        positionGroup,
        rosterCategory: "Bench",
        slotNumber: index + 1,
        aavCents: 100,
        termYears: 1,
      });
    });
  });
  return Object.freeze(players);
}

function insertPlayerFoundations({
  database,
  repositories,
  leagues,
  accounts,
  fixtureNowMs,
}) {
  const players = selectCatalogPlayers(database);

  for (const player of Object.values(players)) {
    const league = leagues[player.leagueAlias];
    const playerNowMs = league.fixtureCreatedAtMs;
    repositories.league_player_positions.insert({
      id: fixtureId(
        `fad-browser-v4:position:${player.leagueAlias}:${player.alias}`
      ),
      league_id: league.leagueId,
      player_id: player.playerId,
      position_group: player.positionGroup,
      reason: "FAD browser fixture",
      corrected_by_user_id:
        accounts[league.commissionerAccountAlias].userId,
      effective_at_ms: playerNowMs,
      ended_at_ms: null,
      version: 1,
    });
    if (player.kind !== "carryover") continue;

    const team = league.teams[player.teamIndex];
    const contractStartSeasonId =
      league.priorSeasonId || league.seasonId;
    const contractId = fixtureId(
      `fad-browser-v4:contract:${player.alias}`
    );
    repositories.player_ownerships.insert({
      id: fixtureId(`fad-browser-v4:ownership:${player.alias}`),
      league_id: league.leagueId,
      season_id: contractStartSeasonId,
      player_id: player.playerId,
      team_id: team.teamId,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: player.positionGroup,
      slot_number: player.slotNumber,
      acquired_transaction_type: "migration",
      acquired_transaction_id: null,
      created_at_ms: playerNowMs,
      updated_at_ms: playerNowMs,
      version: 1,
    });
    repositories.contracts.insert({
      id: contractId,
      league_id: league.leagueId,
      player_id: player.playerId,
      current_team_id: team.teamId,
      contract_type: "normal",
      original_total_value_cents:
        player.aavCents * player.termYears,
      original_term_years: player.termYears,
      aav_cents: player.aavCents,
      start_season_id: contractStartSeasonId,
      status: "active",
      acquisition_source_type: "migration",
      acquisition_source_id: null,
      auction_buyout_lock_expires_at_ms: null,
      created_at_ms: playerNowMs,
      updated_at_ms: playerNowMs,
      version: 1,
    });
    repositories.contract_years.insert({
      id: fixtureId(
        `fad-browser-v4:contract-year:${player.alias}:1`
      ),
      league_id: league.leagueId,
      contract_id: contractId,
      season_id: contractStartSeasonId,
      year_number: 1,
      aav_cents: player.aavCents,
      status: "current",
      rollover_at_ms: null,
      created_at_ms: playerNowMs,
    });
  }

  return Object.freeze(players);
}

function seedFoundations(runtime, accounts, fixtureNowMs) {
  const repositories =
    runtime.repositories.context.repositories;
  return runtime.database.transaction(() => {
    const leagues = {};
    for (const [leagueAlias, blueprint] of
      Object.entries(LEAGUE_BLUEPRINTS)) {
      leagues[leagueAlias] =
        insertLeagueFoundations({
          repositories,
          accounts,
          leagueAlias,
          blueprint,
          fixtureNowMs,
        });
    }
    const players = insertPlayerFoundations({
      database: runtime.database,
      repositories,
      leagues,
      accounts,
      fixtureNowMs,
    });
    return Object.freeze({
      leagues: Object.freeze(leagues),
      players,
    });
  }).immediate();
}

function authenticate(runtime, userId) {
  const issued =
    runtime.services.sessionService.issueForUser({
      userId,
    });
  const authenticated =
    runtime.services.sessionService.resolveWithoutActivity(
      issued.rawSessionToken
    );
  if (authenticated?.valid !== true) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_AUTHENTICATION_FAILED",
      "The local FAD browser fixture could not establish service authority."
    );
  }
  return authenticated;
}

function revokeActiveFixtureSession(runtime, userId) {
  const activeSessions = runtime.database.prepare(
    "SELECT id, version FROM sessions " +
      "WHERE user_id = ? AND status = 'active'"
  ).all(userId);
  if (activeSessions.length > 1) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_AUTHENTICATION_FAILED",
      "The local FAD browser fixture found ambiguous active-session authority."
    );
  }
  if (activeSessions.length === 0) return null;
  return runtime.services.sessionService.revoke({
    sessionId: activeSessions[0].id,
    expectedVersion: activeSessions[0].version,
    reason: "platform_security_action",
  });
}

function revokeActiveFixtureSessions(runtime, accounts) {
  const userIds = new Set(
    Object.values(accounts).map(({ userId }) => userId)
  );
  for (const userId of userIds) {
    revokeActiveFixtureSession(runtime, userId);
  }
}

function startAndScheduleLeague({
  runtime,
  accounts,
  league,
  schedules,
  seasonId = league.seasonId,
  scheduleAlias = league.alias,
  idempotencySuffix = league.alias,
}) {
  const scheduleInput = schedules[scheduleAlias];
  if (!scheduleInput) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_LIFECYCLE_FAILED",
      "The local FAD browser fixture requires an exact league schedule."
    );
  }
  const authenticated = authenticate(
    runtime,
    accounts[league.commissionerAccountAlias].userId
  );
  const started = runtime.services.league.start.start({
    leagueId: league.leagueId,
    input: {},
    expectedLeagueVersion:
      league.expectedLeagueVersion,
    idempotencyKey:
      `fad-browser-${league.alias}-start`,
    authenticated,
  });
  const schedule =
    runtime.services.league.matchupSchedule.generate({
      leagueId: league.leagueId,
      seasonId,
      expectedSeasonVersion:
        started.league.currentSeason.version,
      input: {
        ...scheduleInput,
        confirmed: true,
      },
      idempotencyKey:
        `fad-browser-${idempotencySuffix}-schedule`,
      authenticated,
    });
  if (
    started.activatedTeamCount !== league.teams.length ||
    schedule.firstWeekStartsAtMs !==
      scheduleInput.firstWeekStartsAtMs
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_LIFECYCLE_FAILED",
      "The local FAD browser fixture did not start its complete league."
    );
  }
  return Object.freeze({ started, schedule });
}

function insertBetaTargetSeasonFoundation({
  runtime,
  league,
  fixtureNowMs,
}) {
  runtime.repositories.context.repositories.seasons.insert({
    id: league.seasonId,
    league_id: league.leagueId,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: fixtureNowMs,
    updated_at_ms: fixtureNowMs,
    version: 1,
  });
}

function schedulePlannedSeason({
  runtime,
  accounts,
  league,
  schedule,
  createdAtMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  const season = runtime.database.prepare(`
    SELECT * FROM seasons
    WHERE league_id = ? AND id = ? AND status = 'planned'
  `).get(league.leagueId, league.seasonId);
  if (!season || !Number.isSafeInteger(createdAtMs)) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_LIFECYCLE_FAILED",
      "The target season is unavailable for matchup scheduling."
    );
  }
  const scheduleOperationId = fixtureId(
    "fad-browser-v4:matchup-schedule:beta-target"
  );
  const weekOneId = fixtureId(
    "fad-browser-v4:matchup-week:beta-target:1"
  );
  const planned = planExplicitMatchupSchedule({
    teamIds: league.teams.map(({ teamId }) => teamId),
    nhlSeasonKey: season.nhl_season_key,
    ...schedule,
    timeZone: VANCOUVER_TIME_ZONE,
    nowMs: createdAtMs,
  });
  const teamById = new Map(
    league.teams.map((team) => [team.teamId, team])
  );
  runtime.database.transaction(() => {
    repositories.matchup_operations.insert({
      id: scheduleOperationId,
      league_id: league.leagueId,
      season_id: league.seasonId,
      matchup_week_id: null,
      matchup_id: null,
      actor_user_id:
        accounts[league.commissionerAccountAlias].userId,
      operation_type: "schedule_generate",
      status: "succeeded",
      reason: null,
      metadata_json: JSON.stringify({
        participantCount: league.teams.length,
        participantTeamIds: league.teams
          .map(({ teamId }) => teamId)
          .sort(),
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
    for (const week of planned.weeks) {
      const weekId =
        week.sequence === 1
          ? weekOneId
          : fixtureId(
              `fad-browser-v4:matchup-week:beta-target:${week.sequence}`
            );
      repositories.matchup_weeks.insert({
        id: weekId,
        league_id: league.leagueId,
        season_id: league.seasonId,
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
          id: fixtureId(
            `fad-browser-v4:matchup:beta-target:${week.sequence}:${pairIndex + 1}`
          ),
          league_id: league.leagueId,
          season_id: league.seasonId,
          matchup_week_id: weekId,
          home_team_id: pair.homeTeamId,
          away_team_id: pair.awayTeamId,
          home_team_name: teamById.get(pair.homeTeamId).name,
          away_team_name: teamById.get(pair.awayTeamId).name,
          status: "scheduled",
          created_at_ms: createdAtMs,
          updated_at_ms: createdAtMs,
          version: 1,
        });
      });
    }
    repositories.season_matchup_schedule_generations.insert({
      league_id: league.leagueId,
      season_id: league.seasonId,
      schedule_version: 1,
      schedule_operation_id: scheduleOperationId,
      week_one_matchup_week_id: weekOneId,
      week_one_starts_at_ms: schedule.firstWeekStartsAtMs,
      status: "current",
      created_at_ms: createdAtMs,
      superseded_at_ms: null,
      version: 1,
    });
    repositories.seasons.updateVersioned({
      key: league.seasonId,
      leagueId: league.leagueId,
      expectedVersion: season.version,
      changes: {
        regular_season_starts_at_ms:
          schedule.nhlRegularSeasonStartsAtMs,
        regular_season_ends_at_ms:
          schedule.nhlRegularSeasonEndsAtMs,
        fantasy_playoffs_start_at_ms:
          schedule.fantasyPlayoffsStartAtMs,
        fantasy_playoffs_end_at_ms:
          schedule.fantasyPlayoffsEndAtMs,
        updated_at_ms: createdAtMs,
      },
    });
  }).immediate();
  return Object.freeze({
    scheduleOperationId,
    weekOneId,
    firstWeekStartsAtMs: schedule.firstWeekStartsAtMs,
  });
}

function insertFutureContractYears({
  runtime,
  leagues,
  players,
  fixtureNowMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  runtime.database.transaction(() => {
    const futureSeasonIdsByLeague = {};
    for (const league of Object.values(leagues)) {
      const insertedFutureSeasonIds = [1, 2, 3].map((offset) => {
        const year = 2026 + offset;
        const futureSeasonId = fixtureId(
          `fad-browser-v4:season:${league.alias}:${year}`
        );
        repositories.seasons.insert({
          id: futureSeasonId,
          league_id: league.leagueId,
          label:
            `${year}-${String((year + 1) % 100).padStart(2, "0")}`,
          nhl_season_key: `${year}${year + 1}`,
          status: "planned",
          regular_season_starts_at_ms: null,
          regular_season_ends_at_ms: null,
          fantasy_playoffs_start_at_ms: null,
          fantasy_playoffs_end_at_ms: null,
          free_agent_draft_completed_at_ms: null,
          created_at_ms: fixtureNowMs,
          updated_at_ms: fixtureNowMs,
          version: 1,
        });
        return futureSeasonId;
      });
      futureSeasonIdsByLeague[league.alias] =
        league.priorSeasonId
          ? [league.seasonId, insertedFutureSeasonIds[0]]
          : insertedFutureSeasonIds;
    }

    for (const player of Object.values(players)) {
      if (player.kind !== "carryover") continue;
      const league = leagues[player.leagueAlias];
      if (!league) continue;
      const contractId = fixtureId(
        `fad-browser-v4:contract:${player.alias}`
      );
      futureSeasonIdsByLeague[player.leagueAlias]
        .slice(0, player.termYears - 1)
        .forEach((seasonId, index) => {
          const yearNumber = index + 2;
          repositories.contract_years.insert({
            id: fixtureId(
              `fad-browser-v4:contract-year:${player.alias}:${yearNumber}`
            ),
            league_id: league.leagueId,
            contract_id: contractId,
            season_id: seasonId,
            year_number: yearNumber,
            aav_cents: player.aavCents,
            status: "future",
            rollover_at_ms: null,
            created_at_ms: fixtureNowMs,
          });
        });
    }
  }).immediate();
}

function backfillFourSeasonDraftPickInventory({
  runtime,
  accounts,
  leagues,
  fixtureNowMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  const write = () => {
    for (const league of Object.values(leagues)) {
      const commissioner = accounts[league.commissionerAccountAlias];
      const seasons = runtime.database.prepare(`
        SELECT future.id, future.nhl_season_key
        FROM seasons AS current
        JOIN seasons AS future
          ON future.league_id = current.league_id
         AND future.nhl_season_key >= current.nhl_season_key
        WHERE current.league_id = ?
          AND current.id = ?
        ORDER BY future.nhl_season_key, future.id
        LIMIT 4
      `).all(league.leagueId, league.seasonId);
      if (seasons.length !== 4 || !commissioner) {
        fail(
          "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PICK_INVENTORY_INVALID",
          "Every FAD fixture league requires four draft-pick seasons and commissioner authority."
        );
      }

      for (const season of seasons) {
        let draft = runtime.database.prepare(`
          SELECT id FROM entry_drafts
          WHERE league_id = ? AND season_id = ?
        `).get(league.leagueId, season.id);
        if (!draft) {
          draft = {
            id: fixtureId(
              `fad-browser-v4:entry-draft:${league.alias}:${season.nhl_season_key}`
            ),
          };
          repositories.entry_drafts.insert({
            id: draft.id,
            league_id: league.leagueId,
            season_id: season.id,
            status: "setup",
            rounds: 4,
            pick_clock_seconds: 300,
            starts_at_ms: null,
            completed_at_ms: null,
            created_by_user_id: commissioner.userId,
            created_at_ms: fixtureNowMs,
            updated_at_ms: fixtureNowMs,
            version: 1,
          });
        }

        const existingCoordinates = new Set(
          runtime.database.prepare(`
            SELECT round_number, original_team_id
            FROM draft_picks
            WHERE league_id = ? AND draft_id = ?
          `).all(league.leagueId, draft.id).map(
            ({ round_number: round, original_team_id: teamId }) =>
              `${round}:${teamId}`
          )
        );
        for (let round = 1; round <= 4; round += 1) {
          league.teams.forEach((team, index) => {
            const coordinate = `${round}:${team.teamId}`;
            if (existingCoordinates.has(coordinate)) return;
            repositories.draft_picks.insert({
              id: fixtureId(
                `fad-browser-v4:draft-pick:${league.alias}:${season.nhl_season_key}:${round}:${index + 1}`
              ),
              league_id: league.leagueId,
              draft_id: draft.id,
              target_season_id: season.id,
              round_number: round,
              position_number: index + 1,
              original_team_id: team.teamId,
              current_owner_team_id: team.teamId,
              status: "unused",
              selection_id: null,
              created_at_ms: fixtureNowMs,
              updated_at_ms: fixtureNowMs,
              version: 1,
            });
          });
        }
      }
    }
  };
  if (runtime.database.inTransaction) return write();
  return runtime.database.transaction(write).immediate();
}

function existingBrowserFixtureFoundations(runtime) {
  const accounts = {};
  const leagues = {};
  for (const [alias, blueprint] of Object.entries(LEAGUE_BLUEPRINTS)) {
    const leagueId = fixtureId(`fad-browser-v4:league:${alias}`);
    const seasonId = fixtureId(`fad-browser-v4:season:${alias}`);
    const league = runtime.database.prepare(`
      SELECT league.id, commissioner.user_id AS commissioner_user_id
      FROM leagues AS league
      JOIN league_memberships AS commissioner
        ON commissioner.league_id = league.id
       AND commissioner.id = league.commissioner_membership_id
       AND commissioner.status = 'active'
      WHERE league.id = ?
        AND league.current_season_id = ?
        AND league.status <> 'deleted'
    `).get(leagueId, seasonId);
    const rows = runtime.database.prepare(`
      SELECT id
      FROM teams
      WHERE league_id = ? AND status <> 'deleted'
    `).all(leagueId);
    const teamIds = new Set(rows.map(({ id }) => id));
    const teams = blueprint.teamManagerAccountAliases.map((_, index) => ({
      teamId: fixtureId(`fad-browser-v4:team:${alias}:${index + 1}`),
    }));
    if (
      !league ||
      rows.length !== teams.length ||
      teams.some(({ teamId }) => !teamIds.has(teamId))
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_EXISTING_STATE_INVALID",
        "The existing staging FAD fixture does not match its deterministic league, season, commissioner, and team identities."
      );
    }
    const commissionerAlias = blueprint.commissionerAccountAlias;
    const priorCommissioner = accounts[commissionerAlias];
    if (
      priorCommissioner &&
      priorCommissioner.userId !== league.commissioner_user_id
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_EXISTING_STATE_INVALID",
        "The shared staging FAD commissioner identity is inconsistent across leagues."
      );
    }
    accounts[commissionerAlias] = {
      userId: league.commissioner_user_id,
    };
    leagues[alias] = {
      alias,
      leagueId,
      seasonId,
      commissionerAccountAlias: commissionerAlias,
      teams,
    };
  }
  return { accounts, leagues };
}

function ensureFourthFutureSeason({ runtime, leagues, fixtureNowMs }) {
  const repositories = runtime.repositories.context.repositories;
  const write = () => {
    for (const league of Object.values(leagues)) {
      const id = fixtureId(
        `fad-browser-v4:season:${league.alias}:2029`
      );
      const rows = runtime.database.prepare(`
        SELECT id, label, nhl_season_key
        FROM seasons
        WHERE league_id = ?
          AND (id = ? OR nhl_season_key = '20292030')
      `).all(league.leagueId, id);
      if (rows.length === 0) {
        repositories.seasons.insert({
          id,
          league_id: league.leagueId,
          label: "2029-30",
          nhl_season_key: "20292030",
          status: "planned",
          regular_season_starts_at_ms: null,
          regular_season_ends_at_ms: null,
          fantasy_playoffs_start_at_ms: null,
          fantasy_playoffs_end_at_ms: null,
          free_agent_draft_completed_at_ms: null,
          created_at_ms: fixtureNowMs,
          updated_at_ms: fixtureNowMs,
          version: 1,
        });
        continue;
      }
      if (
        rows.length !== 1 ||
        rows[0].id !== id ||
        rows[0].label !== "2029-30" ||
        rows[0].nhl_season_key !== "20292030"
      ) {
        fail(
          "FREE_AGENT_DRAFT_BROWSER_FIXTURE_EXISTING_STATE_INVALID",
          "The existing staging FAD fourth future season conflicts with its deterministic identity."
        );
      }
    }
  };
  if (runtime.database.inTransaction) return write();
  return runtime.database.transaction(write).immediate();
}

function draftPickCounts(database, leagues) {
  return Object.fromEntries(
    Object.values(leagues).map((league) => {
      const counts = database.prepare(`
        SELECT COUNT(*) AS total,
               SUM(status = 'unused') AS unused
        FROM draft_picks
        WHERE league_id = ?
      `).get(league.leagueId);
      return [league.alias, {
        total: counts.total,
        unused: counts.unused || 0,
      }];
    })
  );
}

function backfillExistingFreeAgentDraftBrowserFixturePickInventory({
  runtime,
  fixtureNowMs,
}) {
  if (
    !runtime?.database ||
    !Number.isSafeInteger(fixtureNowMs) ||
    fixtureNowMs < 0
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID",
      "The existing staging FAD pick backfill requires an open runtime and safe timestamp."
    );
  }
  const { accounts, leagues } =
    existingBrowserFixtureFoundations(runtime);
  const before = draftPickCounts(runtime.database, leagues);
  runtime.database.transaction(() => {
    ensureFourthFutureSeason({ runtime, leagues, fixtureNowMs });
    backfillFourSeasonDraftPickInventory({
      runtime,
      accounts,
      leagues,
      fixtureNowMs,
    });
  }).immediate();
  const after = draftPickCounts(runtime.database, leagues);
  return Object.freeze({
    code: "STAGING_FAD_PICK_INVENTORY_BACKFILLED",
    leagues: Object.freeze(
      Object.values(leagues).map((league) => Object.freeze({
        alias: league.alias,
        leagueId: league.leagueId,
        insertedPickCount:
          after[league.alias].total - before[league.alias].total,
        totalPickCount: after[league.alias].total,
        unusedPickCount: after[league.alias].unused,
      }))
    ),
  });
}

function insertBetaTargetScheduleJobs({
  runtime,
  league,
  createdAtMs,
}) {
  const database = runtime.database;
  const generation = database.prepare(`
    SELECT schedule_operation_id, schedule_version
    FROM season_matchup_schedule_generations
    WHERE league_id = ? AND season_id = ? AND status = 'current'
  `).get(league.leagueId, league.seasonId);
  const weeks = database.prepare(`
    SELECT id, sequence, starts_at_ms, baseline_at_ms,
           locks_at_ms, ends_at_ms, rolls_over_at_ms
    FROM matchup_weeks
    WHERE league_id = ? AND season_id = ? AND status = 'scheduled'
    ORDER BY sequence
  `).all(league.leagueId, league.seasonId);
  if (!generation || weeks.length < 1) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SCHEDULE_INVALID",
      "Beta requires a current scheduled target-season generation before its matchup jobs can be attached."
    );
  }
  const insertJob = database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (
      @id, @leagueId, @seasonId, @jobType, @occurrenceKey,
      @scheduledForMs, 'pending', 0, NULL, NULL, NULL, NULL,
      NULL, NULL, @createdAtMs, @createdAtMs, 1, NULL,
      @scheduledForMs
    )
  `);
  const insertBinding = database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id, league_id, season_id, job_run_id, job_type,
      schedule_operation_id, schedule_version,
      owning_matchup_week_id, owning_matchup_id,
      created_at_ms, version
    ) VALUES (
      @id, @leagueId, @seasonId, @id, @jobType,
      @scheduleOperationId, @scheduleVersion,
      @weekId, NULL, @createdAtMs, 1
    )
  `);
  database.transaction(() => {
    for (const week of weeks) {
      const occurrences = [
        ["statistics-start", "matchup:statistics_refresh", week.starts_at_ms],
        ["baseline", "matchup:baseline", week.baseline_at_ms],
        ["lock", "matchup:lock", week.locks_at_ms],
        ["statistics-end", "matchup:statistics_refresh", week.ends_at_ms],
        ["finalize", "matchup:finalize", week.ends_at_ms],
        ["rollover", "matchup:rollover", week.rolls_over_at_ms],
      ];
      for (const [slot, jobType, scheduledForMs] of occurrences) {
        const id = fixtureId(
          `fad-browser-v4:job:beta-target:${week.sequence}:${slot}`
        );
        const params = {
          id,
          leagueId: league.leagueId,
          seasonId: league.seasonId,
          weekId: week.id,
          jobType,
          occurrenceKey: buildMatchupOccurrenceKey({
            jobType,
            leagueId: league.leagueId,
            seasonId: league.seasonId,
            weekId: week.id,
            scheduleOperationId: generation.schedule_operation_id,
            scheduleVersion: generation.schedule_version,
            scheduledForMs,
          }),
          scheduledForMs,
          scheduleOperationId: generation.schedule_operation_id,
          scheduleVersion: generation.schedule_version,
          createdAtMs,
        };
        insertJob.run(params);
        insertBinding.run(params);
      }
    }
  }).immediate();
}

function draftScope(database, league, expectedStatus = "cards_open") {
  const fad = database.prepare(`
    SELECT id, status, opened_at_ms, help_opens_at_ms,
           candidate_deadline_at_ms,
           first_matchup_starts_at_ms
    FROM free_agent_drafts
    WHERE league_id = ? AND season_id = ?
  `).get(league.leagueId, league.seasonId);
  if (!fad || fad.status !== expectedStatus) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
      "The local FAD browser fixture did not open Candidate Cards."
    );
  }
  const cards = database.prepare(`
    SELECT id, team_id, version
    FROM candidate_cards
    WHERE league_id = ? AND season_id = ? AND fad_id = ?
    ORDER BY team_id ASC
  `).all(league.leagueId, league.seasonId, fad.id);
  if (cards.length !== league.teams.length) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
      "The local FAD browser fixture requires every Candidate Card."
    );
  }
  const cardByTeamId = new Map(
    cards.map((card) => [card.team_id, card])
  );
  return Object.freeze({ fad, cardByTeamId });
}

function createFixtureLiveStatisticsCapability({
  database,
  clockState,
  nhlSeasonKey,
}) {
  const catalogTotals = database.prepare(`
    SELECT external.external_value AS providerPlayerId
    FROM player_external_ids AS external
    JOIN players AS player ON player.id = external.player_id
    WHERE external.provider = 'sportsdataio-discovery-lab'
      AND player.status = 'active'
    GROUP BY external.external_value
    ORDER BY CAST(external.external_value AS INTEGER), external.external_value
  `).all().filter(({ providerPlayerId }) =>
    /^[1-9][0-9]{0,19}$/.test(String(providerPlayerId))
  );
  if (catalogTotals.length < 700) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PLAYER_CATALOG_INCOMPLETE",
      "The fixture-only matchup runner requires at least 700 catalog-backed players."
    );
  }
  const totalsRows = catalogTotals.map(({ providerPlayerId }, index) => ({
    playerId: String(providerPlayerId),
    gamesPlayed: 1,
    goals: index % 3,
    assists: index % 4,
  }));
  normalizeStatisticsRows({
    rows: totalsRows,
    minimumPlayerCount: 700,
    sourceUpdatedAtMs: 0,
  });
  const verification = Object.freeze({
    status: "verified",
    evidenceId: fixtureId("fad-browser-v4:live-statistics-capability"),
    evidenceSha256: "a".repeat(64),
    issuedAtMs: 0,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    verifiedAtMs: 1,
  });
  const descriptor = {
    mode: "required",
    enabled: true,
    verified: true,
    origin: "https://fixture.invalid",
    nhlSeasonKey,
    capabilityKeyVersion: 1,
    probeNhlSeasonKey: nhlSeasonKey,
    probeKind: "staging_fixture",
    probeManifestSha256: "b".repeat(64),
    verification,
  };
  Object.defineProperty(descriptor, "apiKey", {
    configurable: false,
    enumerable: false,
    value: "fixture-only-no-network",
    writable: false,
  });
  const provider = Object.freeze({
    async fetchLiveSnapshot({ requiredPlayers }) {
      const capturedAtMs = clockState.nowMs;
      return Object.freeze({
        provider: "sportsdataio-live",
        sourceVersion: `fad-browser-v4-${nhlSeasonKey}-${capturedAtMs}`,
        capturedAtMs,
        totalsSourceUpdatedAtMs: capturedAtMs,
        totalsRows,
        playerGameRows: [],
        playerGameCoverage: {
          schemaVersion: 1,
          throughAtMs: capturedAtMs,
          players: requiredPlayers.map((player) => ({
            playerId: player.playerId,
            providerPlayerId: player.providerPlayerId,
            providerTeamId: null,
            disposition: "no_team",
            games: [],
          })),
        },
      });
    },
    async fetchGameStates() {
      throw new Error(
        "The fixture-only statistics adapter received an unexpected game-state request."
      );
    },
  });
  return Object.freeze({
    descriptor: Object.freeze(descriptor),
    createAdapter() {
      return provider;
    },
  });
}

function createClockedFixtureRuntime(
  runtime,
  clockState,
  {
    currentSeason = Object.freeze({
      label: "2026",
      nhlSeasonKey: "20262027",
    }),
    fixtureLiveStatistics = false,
  } = {}
) {
  const securityFoundations = createSecurityFoundations({
    loadConfig: () => runtime.securityConfig,
    now: () => clockState.nowMs,
    loggerSink() {},
  });
  const liveCapability = fixtureLiveStatistics
    ? createFixtureLiveStatisticsCapability({
        database: runtime.database,
        clockState,
        nhlSeasonKey: currentSeason.nhlSeasonKey,
      })
    : null;
  const clocked = createTargetRuntime({
    database: runtime.database,
    migrationsDirectory: path.resolve(
      __dirname,
      "../../../database/migrations"
    ),
    securityFoundations,
    currentSeason,
    leagueWriteMode: "open",
    freeAgentDraftRoutesEnabled: true,
    ...(liveCapability === null
      ? {}
      : {
          sportsDataIoLiveNhl: liveCapability.descriptor,
          sportsDataIoFetchImplementation() {
            throw new Error(
              "The fixture-only statistics adapter must not use the network."
            );
          },
          createSportsDataIoLiveNhlAdapterFunction:
            liveCapability.createAdapter,
        }),
    networkSourceResolver() {
      return "127.0.0.1";
    },
  });
  return Object.freeze({
    ...clocked,
    database: runtime.database,
  });
}

function addGammaCandidates({
  runtime,
  database,
  accounts,
  league,
  scope,
  players,
}) {
  const versions = new Map(
    [...scope.cardByTeamId].map(([teamId, card]) => [
      teamId,
      card.version,
    ])
  );
  const gammaTeams = league.teams.length;
  for (let teamIndex = 0; teamIndex < gammaTeams; teamIndex += 1) {
    const team = league.teams[teamIndex];
    const manager = authenticate(
      runtime,
      accounts[team.managerAccountAlias].userId
    );
    const winners = Object.values(players)
      .filter(
        (player) =>
          player.kind === "gamma_candidate" &&
          player.teamIndex === teamIndex &&
          player.shared === false
      )
      .sort((left, right) =>
        left.slotKey.localeCompare(right.slotKey)
      );
    const ownShared =
      players[`gammaTeam${teamIndex + 1}SharedWinner`];
    const previousIndex =
      (teamIndex + gammaTeams - 1) % gammaTeams;
    const lostShared =
      players[`gammaTeam${previousIndex + 1}SharedWinner`];
    const offers = [
      ...winners,
      ownShared,
      Object.freeze({
        ...lostShared,
        slotKey: "F12",
        aavCents: lostShared.aavCents - 100,
      }),
    ];
    for (const offer of offers) {
      const result = runtime.services.league.candidateCards.addCandidate({
        authenticated: manager,
        leagueId: league.leagueId,
        fadId: scope.fad.id,
        teamId: team.teamId,
        slotKey: offer.slotKey,
        input: {
          playerId: offer.playerId,
          aavCents: offer.aavCents,
          termYears: offer.termYears,
        },
        expectedCardVersion: versions.get(team.teamId),
        idempotencyKey:
          `fad-browser-v4-gamma-${team.alias}-${offer.alias}`,
      });
      versions.set(team.teamId, result.data.card.cardVersion);
    }
  }
  const counts = database.prepare(`
    SELECT team_id, COUNT(*) AS count
    FROM candidate_card_entries
    WHERE league_id = ? AND fad_id = ?
    GROUP BY team_id
    ORDER BY team_id
  `).all(league.leagueId, scope.fad.id);
  if (
    counts.length !== gammaTeams ||
    counts.some(({ count }) => count !== 18)
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_CARD_INVALID",
      "Gamma Candidate Cards must contain 18 complete mandatory rows."
    );
  }
}

function insertFixtureCompletionJob({
  database,
  league,
  scope,
  namespace,
}) {
  const finalRollover = database.prepare(`
    SELECT rolls_over_at_ms
    FROM free_agent_draft_rollovers
    WHERE league_id = ? AND season_id = ? AND fad_id = ?
      AND sequence = 7 AND window_kind = 'initial'
    LIMIT 1
  `).get(league.leagueId, league.seasonId, scope.fad.id);
  if (!finalRollover) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_COMPLETION_JOB_INVALID",
      "The fixture requires its seventh initial rollover before completion can be scheduled."
    );
  }
  database.prepare(`
    INSERT INTO job_runs (
      id, league_id, season_id, job_type, occurrence_key,
      scheduled_for_ms, status, attempt_count, lease_owner,
      lease_expires_at_ms, started_at_ms, completed_at_ms,
      result_json, last_error_code, created_at_ms, updated_at_ms,
      version, lease_token, next_attempt_at_ms
    ) VALUES (
      @id, @leagueId, @seasonId, 'fad_completion', @occurrenceKey,
      @scheduledForMs, 'pending', 0, NULL, NULL, NULL, NULL,
      NULL, NULL, @createdAtMs, @createdAtMs, 1, NULL, NULL
    )
  `).run({
    id: fixtureId(`fad-browser-v4:job:${namespace}:fad-completion`),
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    occurrenceKey: `fad:${scope.fad.id}:complete`,
    scheduledForMs: finalRollover.rolls_over_at_ms,
    createdAtMs: scope.fad.opened_at_ms,
  });
}

function insertDeferredGammaRosters({
  runtime,
  league,
  players,
  fixtureNowMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  runtime.database.transaction(() => {
    for (const player of Object.values(players)) {
      if (player.kind !== "deferred_roster") continue;
      const team = league.teams[player.teamIndex];
      const contractId = fixtureId(
        `fad-browser-v4:contract:${player.alias}`
      );
      repositories.player_ownerships.insert({
        id: fixtureId(`fad-browser-v4:ownership:${player.alias}`),
        league_id: league.leagueId,
        season_id: league.seasonId,
        player_id: player.playerId,
        team_id: team.teamId,
        ownership_kind: "Rostered",
        roster_category: player.rosterCategory,
        position_group: player.positionGroup,
        slot_number: player.slotNumber,
        acquired_transaction_type: "post_fad_fixture",
        acquired_transaction_id: null,
        created_at_ms: fixtureNowMs,
        updated_at_ms: fixtureNowMs,
        version: 1,
      });
      repositories.contracts.insert({
        id: contractId,
        league_id: league.leagueId,
        player_id: player.playerId,
        current_team_id: team.teamId,
        contract_type: "normal",
        original_total_value_cents:
          player.aavCents * player.termYears,
        original_term_years: player.termYears,
        aav_cents: player.aavCents,
        start_season_id: league.seasonId,
        status: "active",
        acquisition_source_type: "post_fad_fixture",
        acquisition_source_id: null,
        auction_buyout_lock_expires_at_ms: null,
        created_at_ms: fixtureNowMs,
        updated_at_ms: fixtureNowMs,
        version: 1,
      });
      repositories.contract_years.insert({
        id: fixtureId(`fad-browser-v4:contract-year:${player.alias}:1`),
        league_id: league.leagueId,
        contract_id: contractId,
        season_id: league.seasonId,
        year_number: 1,
        aav_cents: player.aavCents,
        status: "current",
        rollover_at_ms: null,
        created_at_ms: fixtureNowMs,
      });
    }
  }).immediate();
}

function insertFixtureMatchupScoring({
  runtime,
  league,
  fadId,
  fixtureNowMs,
  namespace = "gamma",
}) {
  const database = runtime.database;
  const repositories = runtime.repositories.context.repositories;
  const week = database.prepare(`
    SELECT week.*
    FROM matchup_weeks AS week
    WHERE week.league_id = ? AND week.season_id = ?
      AND week.sequence = 1
      AND EXISTS (
        SELECT 1
        FROM free_agent_drafts AS draft
        WHERE draft.league_id = week.league_id
          AND draft.season_id = week.season_id
          AND draft.id = ?
          AND draft.status = 'completed'
      )
  `).get(league.leagueId, league.seasonId, fadId);
  const matchups = database.prepare(`
    SELECT id, home_team_id, away_team_id
    FROM matchups
    WHERE league_id = ? AND season_id = ? AND matchup_week_id = ?
    ORDER BY id
  `).all(league.leagueId, league.seasonId, week?.id);
  const scheduledTeams = new Set(
    matchups.flatMap(({ home_team_id: home, away_team_id: away }) => [home, away])
  );
  if (
    !week ||
    week.week_key !== "regular-01" ||
    week.starts_at_ms > fixtureNowMs ||
    week.ends_at_ms < fixtureNowMs ||
    matchups.length !== league.teams.length / 2 ||
    scheduledTeams.size !== league.teams.length
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_MATCHUPS_INVALID",
      `The scoring fixture requires complete scheduled matchup coverage: ${JSON.stringify({
        week: week && {
          id: week.id,
          weekKey: week.week_key,
          startsAtMs: week.starts_at_ms,
          endsAtMs: week.ends_at_ms,
          status: week.status,
        },
        fixtureNowMs,
        matchupCount: matchups.length,
        scheduledTeamCount: scheduledTeams.size,
      })}`
    );
  }

  const activePlayers = database.prepare(`
    SELECT ownership.team_id, ownership.player_id,
           ownership.position_group, ownership.slot_number,
           external.external_value AS provider_player_id
    FROM player_ownerships AS ownership
    JOIN player_external_ids AS external
      ON external.player_id = ownership.player_id
     AND external.provider = 'sportsdataio-discovery-lab'
    WHERE ownership.league_id = ? AND ownership.season_id = ?
      AND ownership.ownership_kind = 'Rostered'
      AND ownership.roster_category = 'Active'
    ORDER BY ownership.team_id, ownership.position_group,
             ownership.slot_number, ownership.player_id
  `).all(league.leagueId, league.seasonId);
  const activePlayerCounts = league.teams.map(
    (team) =>
      activePlayers.filter(({ team_id: teamId }) => teamId === team.teamId)
        .length
  );
  const activePlayersPerTeam = activePlayerCounts[0];
  if (
    !Number.isSafeInteger(activePlayersPerTeam) ||
    activePlayersPerTeam < 1 ||
    activePlayerCounts.some((count) => count !== activePlayersPerTeam)
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_MATCHUPS_INVALID",
      "The scoring fixture requires an equal nonzero active roster for every team."
    );
  }
  const source = database.prepare(`
    SELECT id, provider FROM stat_sources
    WHERE status = 'active'
    ORDER BY provider, id LIMIT 1
  `).get();
  const season = database.prepare(`
    SELECT nhl_season_key FROM seasons
    WHERE league_id = ? AND id = ?
  `).get(league.leagueId, league.seasonId);
  if (!source || !season) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_MATCHUPS_INVALID",
      "Gamma Week 1 requires an active statistics source."
    );
  }
  const evidenceAtMs = Math.max(fixtureNowMs, week.locks_at_ms);
  const refreshId = fixtureId(
    `fad-browser-v4:stat-refresh:${namespace}:week-1`
  );
  const setId = fixtureId(
    `fad-browser-v4:stat-game-set:${namespace}:week-1`
  );
  const sourceVersion = `fad-browser-v4-${namespace}-week-1`;
  const requiredPlayers = activePlayers.map((player) => ({
    playerId: player.player_id,
    providerPlayerId: player.provider_player_id,
  }));
  const coverage = activePlayers.map((player) => ({
    coverageEntryId: fixtureId(
      `fad-browser-v4:stat-coverage:${namespace}:${player.player_id}`
    ),
    playerId: player.player_id,
    providerPlayerId: player.provider_player_id,
    providerTeamId: null,
    disposition: "no_team",
    nhlGameId: null,
    nhlGameScheduledStartsAtMs: null,
  }));
  const coverageEvidence = createPlayerGameCoverageSetEvidence({
    setId,
    statSourceId: source.id,
    refreshId,
    nhlSeasonKey: season.nhl_season_key,
    provider: source.provider,
    sourceVersion,
    capturedAtMs: evidenceAtMs,
    requiredPlayers,
    coverage,
  });
  const observationEvidence = createPlayerGameObservationSetEvidence({
    setId,
    statSourceId: source.id,
    refreshId,
    nhlSeasonKey: season.nhl_season_key,
    provider: source.provider,
    sourceVersion,
    capturedAtMs: evidenceAtMs,
    observations: [],
  });

  const matchupByTeamId = new Map();
  for (const matchup of matchups) {
    matchupByTeamId.set(matchup.home_team_id, matchup.id);
    matchupByTeamId.set(matchup.away_team_id, matchup.id);
  }
  const points = [];
  database.transaction(() => {
    repositories.stat_refreshes.insert({
      id: refreshId,
      stat_source_id: source.id,
      nhl_season_key: season.nhl_season_key,
      source_version: sourceVersion,
      status: "succeeded",
      started_at_ms: evidenceAtMs,
      completed_at_ms: evidenceAtMs,
      player_count: activePlayers.length,
      error_code: null,
      metadata_json: JSON.stringify({ fixture: true, leagueAlias: "gamma" }),
      version: 1,
    });
    for (const row of coverage) {
      repositories.stat_refresh_player_game_coverage_entries.insert({
        id: row.coverageEntryId,
        stat_source_id: source.id,
        refresh_id: refreshId,
        observation_set_id: setId,
        nhl_season_key: season.nhl_season_key,
        player_id: row.playerId,
        provider_player_id: row.providerPlayerId,
        provider_team_id: null,
        disposition: "no_team",
        nhl_game_id: null,
        nhl_game_scheduled_starts_at_ms: null,
        created_at_ms: evidenceAtMs,
        version: 1,
      });
    }
    repositories.stat_refresh_player_game_sets.insert({
      id: setId,
      stat_source_id: source.id,
      refresh_id: refreshId,
      nhl_season_key: season.nhl_season_key,
      provider: source.provider,
      source_version: sourceVersion,
      captured_at_ms: evidenceAtMs,
      required_player_count: coverageEvidence.requiredPlayerCount,
      coverage_entry_count: coverageEvidence.coverageEntryCount,
      expected_player_game_count: coverageEvidence.expectedPlayerGameCount,
      coverage_schema_version: 1,
      coverage_sha256: coverageEvidence.coverageSha256,
      observation_count: observationEvidence.observationCount,
      evidence_schema_version: 1,
      evidence_sha256: observationEvidence.evidenceSha256,
      created_at_ms: evidenceAtMs,
      version: 1,
    });

    const teamIndexById = new Map(
      league.teams.map((team, index) => [team.teamId, index])
    );
    const rosterIndexByTeam = new Map();
    const snapshotByTeam = new Map();
    const lockByTeam = new Map();
    for (const team of league.teams) {
      const snapshotId = fixtureId(
        `fad-browser-v4:stat-snapshot:${namespace}:week-1:${team.teamId}`
      );
      const lockId = fixtureId(
        `fad-browser-v4:matchup-lock:${namespace}:week-1:${team.teamId}`
      );
      repositories.stat_snapshots.insert({
        id: snapshotId,
        stat_source_id: source.id,
        source_refresh_id: refreshId,
        league_id: league.leagueId,
        season_id: league.seasonId,
        matchup_week_id: week.id,
        intended_use: "matchup_baseline",
        completeness_status: "complete",
        freshness_status: "fresh",
        captured_at_ms: evidenceAtMs,
        committed: 1,
        created_at_ms: evidenceAtMs,
      });
      repositories.matchup_roster_locks.insert({
        id: lockId,
        league_id: league.leagueId,
        season_id: league.seasonId,
        matchup_week_id: week.id,
        team_id: team.teamId,
        lock_type: "normal",
        legal: 1,
        legality_reason_code: null,
        locked_at_ms: evidenceAtMs,
        baseline_snapshot_id: snapshotId,
        source_freshness_status: "fresh",
        created_at_ms: evidenceAtMs,
        version: 1,
      });
      snapshotByTeam.set(team.teamId, snapshotId);
      lockByTeam.set(team.teamId, lockId);
      rosterIndexByTeam.set(team.teamId, 0);
    }
    for (const player of activePlayers) {
      const rosterIndex = rosterIndexByTeam.get(player.team_id);
      rosterIndexByTeam.set(player.team_id, rosterIndex + 1);
      const teamIndex = teamIndexById.get(player.team_id);
      const goals = (teamIndex + rosterIndex) % 3;
      const assists = (teamIndex * 2 + rosterIndex) % 4;
      const fantasyPointsHundredths = goals * 125 + assists * 100;
      points.push(fantasyPointsHundredths);
      repositories.player_stat_totals.insert({
        id: fixtureId(`fad-browser-v4:stat-total:${namespace}:${player.player_id}`),
        stat_source_id: source.id,
        refresh_id: refreshId,
        nhl_season_key: season.nhl_season_key,
        player_id: player.player_id,
        games_played: 1,
        goals,
        assists,
        nhl_points: goals + assists,
        fantasy_points_hundredths: fantasyPointsHundredths,
        source_updated_at_ms: evidenceAtMs,
        created_at_ms: evidenceAtMs,
      });
      repositories.stat_snapshot_players.insert({
        id: fixtureId(`fad-browser-v4:snapshot-player:${namespace}:${player.player_id}`),
        league_id: league.leagueId,
        stat_snapshot_id: snapshotByTeam.get(player.team_id),
        player_id: player.player_id,
        games_played: 0,
        goals: 0,
        assists: 0,
        nhl_points: 0,
        fantasy_points_hundredths: 0,
        created_at_ms: evidenceAtMs,
      });
      repositories.matchup_roster_players.insert({
        id: fixtureId(`fad-browser-v4:matchup-player:${namespace}:${player.player_id}`),
        league_id: league.leagueId,
        season_id: league.seasonId,
        matchup_roster_lock_id: lockByTeam.get(player.team_id),
        player_id: player.player_id,
        position_group: player.position_group,
        slot_number: player.slot_number,
        baseline_games_played: 0,
        baseline_goals: 0,
        baseline_assists: 0,
        baseline_fantasy_points_hundredths: 0,
        created_at_ms: evidenceAtMs,
      });
    }
    for (const team of league.teams) {
      const lead = activePlayers.find(({ team_id: teamId }) => teamId === team.teamId);
      repositories.league_activity.insert({
        id: fixtureId(`fad-browser-v4:activity:${namespace}:scoring:${team.teamId}`),
        league_id: league.leagueId,
        season_id: league.seasonId,
        event_type: "matchup_fixture_scoring_play",
        actor_user_id: null,
        actor_authority: "system",
        team_id: team.teamId,
        player_id: lead.player_id,
        related_type: "matchup",
        related_id: matchupByTeamId.get(team.teamId),
        display_summary: "Simulated Week 1 scoring play recorded.",
        reason: null,
        metadata_json: JSON.stringify({
          schemaVersion: 1,
          fixture: true,
          fantasyPointsHundredths:
            points[
              teamIndexById.get(team.teamId) * activePlayersPerTeam
            ],
        }),
        occurred_at_ms: evidenceAtMs,
      });
    }
  }).immediate();

  const baselineTransition = runtime.services.league.matchupWeeks.advance({
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    weekId: week.id,
    operationId: fixtureId(
      `fad-browser-v4:matchup-transition:${namespace}:week-1:baseline`
    ),
    nowMs: fixtureNowMs,
  });
  const liveTransition = runtime.services.league.matchupWeeks.advance({
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    weekId: week.id,
    operationId: fixtureId(
      `fad-browser-v4:matchup-transition:${namespace}:week-1:live`
    ),
    nowMs: fixtureNowMs,
  });
  const liveScores = matchups.map((matchup) =>
    runtime.services.league.matchupScoring.readLive({
      leagueId: league.leagueId,
      seasonId: league.seasonId,
      weekId: week.id,
      matchupId: matchup.id,
      providers: [source.provider],
      nowMs: fixtureNowMs,
    })
  );
  if (
    baselineTransition.week.status !== "baseline_ready" ||
    liveTransition.week.status !== "live" ||
    liveScores.some(
      (score) =>
        score.status !== "live" ||
        score.home.scoreHundredths <= 0 ||
        score.away.scoreHundredths <= 0
    ) ||
    new Set(
      liveScores.flatMap((score) => [
        score.home.scoreHundredths,
        score.away.scoreHundredths,
      ])
    ).size < 2
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_SCORING_INVALID",
      "Gamma Week 1 must be live and score-readable with varied nonzero team totals."
    );
  }

  return Object.freeze({
    weekId: week.id,
    startsAtMs: week.starts_at_ms,
    weekStatus: liveTransition.week.status,
    matchupCount: matchups.length,
    scheduledTeamCount: scheduledTeams.size,
    activeRosterPlayerCount: activePlayers.length,
    scoringPlayerCount: points.length,
    scoringSignalCount: league.teams.length,
    minimumPlayerPointsHundredths: Math.min(...points),
    maximumPlayerPointsHundredths: Math.max(...points),
    scoreReadableMatchups: Object.freeze(
      liveScores.map((score) => Object.freeze({
        matchupId: score.matchupId,
        status: score.status,
        homeScoreHundredths: score.home.scoreHundredths,
        awayScoreHundredths: score.away.scoreHundredths,
      }))
    ),
  });
}

function completeSourceSeasonMatchups({
  runtime,
  league,
}) {
  const database = runtime.database;
  const week = database.prepare(`
    SELECT id, status, ends_at_ms
    FROM matchup_weeks
    WHERE league_id = ? AND season_id = ? AND sequence = 1
  `).get(league.leagueId, league.priorSeasonId);
  const matchups = database.prepare(`
    SELECT id FROM matchups
    WHERE league_id = ? AND season_id = ? AND matchup_week_id = ?
    ORDER BY id
  `).all(league.leagueId, league.priorSeasonId, week?.id);
  const officialResults = database.prepare(`
    SELECT COUNT(*) AS count
    FROM matchup_results
    WHERE league_id = ? AND season_id = ? AND status = 'official'
  `).get(league.leagueId, league.priorSeasonId).count;
  if (
    !week ||
    week.status !== "final" ||
    matchups.length !== 3 ||
    officialResults !== matchups.length
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_MATCHUPS_INVALID",
      "Beta prior-season matchups must finalize through their scheduled occurrence jobs."
    );
  }
  const standings = runtime.services.league.matchupStandings.read({
    leagueId: league.leagueId,
    seasonId: league.priorSeasonId,
  });
  if (
    standings.resultSetStatus !== "complete" ||
    standings.finalizedResultCount !== 3
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_STANDINGS_INVALID",
      "Beta prior-season results did not produce complete standings."
    );
  }
  return standings;
}

async function runBetaSourceMatchupOccurrences({
  runtime,
  league,
  clockState,
}) {
  const database = runtime.database;
  const nextCurrentJob = database.prepare(`
    SELECT run.id, run.job_type, run.status,
           COALESCE(run.next_attempt_at_ms, run.scheduled_for_ms) AS due_at_ms
    FROM job_runs AS run
    JOIN matchup_schedule_job_bindings AS binding
      ON binding.league_id = run.league_id
     AND binding.job_run_id = run.id
    JOIN season_matchup_schedule_generations AS generation
      ON generation.league_id = binding.league_id
     AND generation.season_id = binding.season_id
     AND generation.schedule_operation_id = binding.schedule_operation_id
     AND generation.schedule_version = binding.schedule_version
     AND generation.status = 'current'
    WHERE run.league_id = ? AND run.season_id = ?
      AND run.status IN ('pending', 'failed')
    ORDER BY due_at_ms, run.scheduled_for_ms, run.id
    LIMIT 1
  `);
  for (let pass = 0; pass < 30; pass += 1) {
    const next = nextCurrentJob.get(
      league.leagueId,
      league.priorSeasonId
    );
    if (!next) break;
    clockState.nowMs = Math.max(clockState.nowMs, next.due_at_ms);
    const result = await runtime.services.league.matchupOccurrenceJob.run();
    if (
      result.status === "skipped" ||
      (result.acquired === 0 && result.skipped === 0)
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_MATCHUPS_INVALID",
        "Beta prior-season matchup occurrence jobs stopped making progress."
      );
    }
  }
  const incomplete = database.prepare(`
    SELECT run.job_type, run.status, run.last_error_code
    FROM job_runs AS run
    JOIN matchup_schedule_job_bindings AS binding
      ON binding.league_id = run.league_id
     AND binding.job_run_id = run.id
    JOIN season_matchup_schedule_generations AS generation
      ON generation.league_id = binding.league_id
     AND generation.season_id = binding.season_id
     AND generation.schedule_operation_id = binding.schedule_operation_id
     AND generation.schedule_version = binding.schedule_version
     AND generation.status = 'current'
    WHERE run.league_id = ? AND run.season_id = ?
      AND run.status <> 'succeeded'
    ORDER BY run.scheduled_for_ms, run.job_type, run.id
  `).all(league.leagueId, league.priorSeasonId);
  if (incomplete.length !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_MATCHUPS_INVALID",
      `Beta prior-season matchup occurrence jobs did not finish: ${JSON.stringify(incomplete)}`
    );
  }
}

function seedBetaEntryDraftFoundation({
  runtime,
  accounts,
  league,
  standingsSnapshotId,
  createdAtMs,
}) {
  const repositories = runtime.repositories.context.repositories;
  const database = runtime.database;
  const draftId = fixtureId("fad-browser-v4:entry-draft:beta");
  const lotteryId = fixtureId("fad-browser-v4:draft-lottery:beta");
  const eligibilityId = fixtureId(
    "fad-browser-v4:draft-eligibility:beta"
  );
  const commissioner = accounts[league.commissionerAccountAlias];
  const eligiblePlayer = database.prepare(`
    SELECT player.id, source.normalized_position
    FROM players AS player
    JOIN player_source_state AS source
      ON source.player_id = player.id
     AND source.ended_at_ms IS NULL
     AND source.active = 1
     AND source.normalized_position IN ('F', 'D')
    WHERE player.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM league_player_positions AS position
        WHERE position.league_id = ? AND position.player_id = player.id
      )
    ORDER BY lower(player.full_name), player.id LIMIT 1
  `).get(league.leagueId);
  if (!eligiblePlayer) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_ENTRY_DRAFT_INVALID",
      "Beta requires one catalog-backed Entry Draft eligible player."
    );
  }
  database.transaction(() => {
    repositories.entry_drafts.insert({
      id: draftId,
      league_id: league.leagueId,
      season_id: league.seasonId,
      status: "lottery_ready",
      rounds: 4,
      pick_clock_seconds: 300,
      starts_at_ms: null,
      completed_at_ms: null,
      created_by_user_id: commissioner.userId,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    repositories.draft_lottery_runs.insert({
      id: lotteryId,
      league_id: league.leagueId,
      season_id: league.seasonId,
      draft_id: draftId,
      standings_snapshot_id: standingsSnapshotId,
      algorithm_version: 1,
      participant_count: league.teams.length,
      confirmed_by_user_id: commissioner.userId,
      random_audit_json: JSON.stringify({ fixture: true, algorithm: "ordinal" }),
      status: "committed",
      committed_at_ms: createdAtMs,
    });
    league.teams.forEach((team, index) => {
      repositories.draft_lottery_results.insert({
        id: fixtureId(`fad-browser-v4:draft-lottery-result:beta:${index + 1}`),
        league_id: league.leagueId,
        lottery_run_id: lotteryId,
        original_team_id: team.teamId,
        current_pick_owner_team_id: team.teamId,
        reverse_standings_position: index + 1,
        weight: 1,
        draw_order: null,
        final_draft_position: index + 1,
        finalist_role: null,
        created_at_ms: createdAtMs,
      });
    });
    repositories.draft_eligibility_snapshots.insert({
      id: eligibilityId,
      league_id: league.leagueId,
      draft_id: draftId,
      nhl_entry_draft_key: "2026",
      source_version: "fad-browser-v4-beta",
      snapshot_version: 1,
      status: "confirmed",
      confirmed_by_user_id: commissioner.userId,
      confirmed_at_ms: createdAtMs,
      created_at_ms: createdAtMs,
    });
    repositories.draft_eligible_players.insert({
      id: fixtureId("fad-browser-v4:draft-eligible-player:beta"),
      league_id: league.leagueId,
      eligibility_snapshot_id: eligibilityId,
      player_id: eligiblePlayer.id,
      position_group: eligiblePlayer.normalized_position,
      eligibility_reason: "nhl_entry_draft",
      nhl_draft_year: 2026,
      nhl_round: 1,
      nhl_overall_selection: 1,
      rights_release_event_id: null,
      created_at_ms: createdAtMs,
    });
    for (let round = 1; round <= 4; round += 1) {
      league.teams.forEach((team, index) => {
        repositories.draft_picks.insert({
          id: fixtureId(
            `fad-browser-v4:draft-pick:beta:${round}:${index + 1}`
          ),
          league_id: league.leagueId,
          draft_id: draftId,
          target_season_id: league.seasonId,
          round_number: round,
          position_number: index + 1,
          original_team_id: team.teamId,
          current_owner_team_id: team.teamId,
          status: "unused",
          selection_id: null,
          created_at_ms: createdAtMs,
          updated_at_ms: createdAtMs,
          version: 1,
        });
      });
    }
  }).immediate();
  return draftId;
}

async function completeBetaSourceFad({
  runtime,
  accounts,
  league,
  schedule,
  players,
  fixtureNowMs,
}) {
  const clockState = {
    nowMs: schedule.firstWeekStartsAtMs - 18 * DAY_MS,
  };
  const clocked = createClockedFixtureRuntime(runtime, clockState, {
    currentSeason: Object.freeze({
      label: "2025",
      nhlSeasonKey: "20252026",
    }),
    fixtureLiveStatistics: true,
  });
  startAndScheduleLeague({
    runtime: clocked,
    accounts,
    league,
    schedules: { betaPrior: schedule },
    seasonId: league.priorSeasonId,
    scheduleAlias: "betaPrior",
    idempotencySuffix: "beta-prior",
  });
  insertBetaTargetSeasonFoundation({
    runtime,
    league,
    fixtureNowMs: clockState.nowMs,
  });
  insertFutureContractYears({
    runtime,
    leagues: { beta: league },
    players,
    fixtureNowMs: clockState.nowMs,
  });
  clockState.nowMs = schedule.firstWeekStartsAtMs - 14 * DAY_MS;
  const opening = await clocked.services.league
    .freeAgentDraftReadinessJob.run();
  if (opening.succeeded !== 1 || opening.failed !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SOURCE_FAD_INVALID",
      "Beta prior-season Candidate Cards did not open through the real lifecycle."
    );
  }
  const openScope = draftScope(runtime.database, {
    ...league,
    seasonId: league.priorSeasonId,
  });
  insertFixtureCompletionJob({
    database: runtime.database,
    league: { ...league, seasonId: league.priorSeasonId },
    scope: openScope,
    namespace: "beta-prior",
  });
  const reminder = runtime.database.prepare(`
    SELECT scheduled_for_ms
    FROM job_runs
    WHERE league_id = ? AND season_id = ?
      AND job_type = 'fad_deadline_reminder' AND status = 'pending'
    ORDER BY scheduled_for_ms, id LIMIT 1
  `).get(league.leagueId, league.priorSeasonId);
  if (!reminder) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SOURCE_FAD_INVALID",
      "Beta prior-season FAD requires its scheduled deadline reminder."
    );
  }
  clockState.nowMs = reminder.scheduled_for_ms;
  const reminded = await clocked.services.league
    .freeAgentDraftDeadlineReminderJob.run();
  if (reminded.succeeded !== 1 || reminded.failed !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SOURCE_FAD_INVALID",
      "Beta prior-season FAD reminder did not complete through the scheduled job."
    );
  }
  clockState.nowMs = openScope.fad.candidate_deadline_at_ms;
  const deadline = await clocked.services.league
    .freeAgentDraftDeadlineJob.run();
  if (deadline.succeeded !== 1 || deadline.failed !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SOURCE_FAD_INVALID",
      "Beta prior-season Candidate Cards did not publish through the deadline lifecycle."
    );
  }
  for (let pass = 0; pass < 20; pass += 1) {
    const pending = runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_player_allocations
      WHERE league_id = ? AND fad_id = ? AND status = 'pending'
    `).get(league.leagueId, openScope.fad.id).count;
    const fadStatus = runtime.database.prepare(`
      SELECT status FROM free_agent_drafts WHERE id = ?
    `).get(openScope.fad.id).status;
    if (pending === 0 && fadStatus === "rapid") break;
    await clocked.services.league
      .freeAgentDraftAllocationCycleJob.run();
  }
  clockState.nowMs = schedule.firstWeekStartsAtMs;
  for (let pass = 0; pass < 20; pass += 1) {
    const status = runtime.database.prepare(`
      SELECT status FROM free_agent_drafts WHERE id = ?
    `).get(openScope.fad.id).status;
    if (status === "completed") break;
    await clocked.services.league.freeAgentDraftRolloverJob.run();
    await clocked.services.league.freeAgentDraftCompletionJob.run();
  }
  if (
    runtime.database.prepare(`
      SELECT status FROM free_agent_drafts WHERE id = ?
    `).get(openScope.fad.id).status !== "completed"
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_SOURCE_FAD_INVALID",
      "Beta prior-season FAD did not complete before final standings."
    );
  }
  await runBetaSourceMatchupOccurrences({
    runtime: clocked,
    league,
    clockState,
  });
  const standings = completeSourceSeasonMatchups({
    runtime: clocked,
    league,
  });
  clockState.nowMs = schedule.nhlRegularSeasonEndsAtMs;
  return Object.freeze({ clocked, clockState, standings });
}

function finalizeBetaSourceStandings({
  runtime,
  accounts,
  league,
  standings,
}) {
  const authenticated = authenticate(
    runtime,
    accounts[league.commissionerAccountAlias].userId
  );
  const result = runtime.services.league.standingsFinalization.finalize({
    leagueId: league.leagueId,
    seasonId: league.priorSeasonId,
    input: {
      resultSetHash: standings.resultSetHash,
      confirmation: STANDINGS_FINALIZATION_CONFIRMATION,
    },
    expectedSeasonVersion: standings.seasonVersion,
    idempotencyKey: "fad-browser-v4-beta-prior-final-standings",
    authenticated,
  });
  if (
    result.code !== "STANDINGS_FINALIZED" ||
    result.finalization.seasonId !== league.priorSeasonId
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_STANDINGS_INVALID",
      "Beta prior-season standings did not finalize through the production service."
    );
  }
  return result.finalization;
}

function completeBetaEntryDraftAndHandoff({
  runtime,
  league,
  draftId,
  completedAtMs,
}) {
  const database = runtime.database;
  const plan = createFreeAgentDraftReadinessTriggerPlan({
    operationId: fixtureId(
      "fad-browser-v4:readiness-operation:beta:entry-draft"
    ),
    jobRunId: fixtureId(
      "fad-browser-v4:readiness-job:beta:entry-draft"
    ),
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    triggerKind: "entry_draft_completed",
    triggerResourceId: draftId,
    entryDraftId: draftId,
    setupExemptionId: null,
    createdAtMs: completedAtMs,
  });
  database.transaction(() => {
    database.prepare(`
      UPDATE draft_picks
      SET status = 'forfeited', updated_at_ms = @completedAtMs,
          version = version + 1
      WHERE league_id = @leagueId AND draft_id = @draftId
        AND status = 'unused' AND selection_id IS NULL
    `).run({
      leagueId: league.leagueId,
      draftId,
      completedAtMs,
    });
    database.prepare(`
      UPDATE entry_draft_pick_clocks
      SET status = 'completed', completed_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs, version = version + 1
      WHERE league_id = @leagueId AND entry_draft_id = @draftId
        AND status = 'running'
    `).run({ leagueId: league.leagueId, draftId, completedAtMs });
    const completed = database.prepare(`
      UPDATE entry_drafts
      SET status = 'completed', completed_at_ms = @completedAtMs,
          updated_at_ms = @completedAtMs, version = version + 1
      WHERE league_id = @leagueId AND id = @draftId
        AND season_id = @seasonId AND status = 'active'
    `).run({
      leagueId: league.leagueId,
      seasonId: league.seasonId,
      draftId,
      completedAtMs,
    });
    if (completed.changes !== 1) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_ENTRY_DRAFT_INVALID",
        "Beta Entry Draft could not be terminalized after its genuine rollover."
      );
    }
    runtime.repositories.freeAgentDraftReadinessHandoffWriter.write({
        operationId: plan.readiness.operationId,
        jobRunId: plan.job.id,
        leagueId: plan.readiness.leagueId,
        seasonId: plan.readiness.seasonId,
        triggerKind: plan.readiness.triggerKind,
        triggerResourceId: draftId,
        entryDraftId: draftId,
        setupExemptionId: null,
        createdAtMs: completedAtMs,
      });
  }).immediate();
}

async function completeGammaFixture({
  runtime,
  accounts,
  league,
  schedule,
  players,
  fixtureNowMs,
}) {
  const clockState = {
    nowMs: schedule.firstWeekStartsAtMs - 21 * DAY_MS,
  };
  const clocked = createClockedFixtureRuntime(runtime, clockState);
  startAndScheduleLeague({
    runtime: clocked,
    accounts,
    league,
    schedules: { gamma: schedule },
  });
  insertFutureContractYears({
    runtime,
    leagues: { gamma: league },
    players,
    fixtureNowMs,
  });
  clockState.nowMs = schedule.firstWeekStartsAtMs - 10 * DAY_MS;
  const opening = await clocked.services.league
    .freeAgentDraftReadinessJob.run();
  if (opening.succeeded !== 1 || opening.failed !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_OPENING_FAILED",
      "Gamma Candidate Cards did not open through the readiness lifecycle."
    );
  }
  const openScope = draftScope(runtime.database, league);
  addGammaCandidates({
    runtime: clocked,
    database: runtime.database,
    accounts,
    league,
    scope: openScope,
    players,
  });
  insertFixtureCompletionJob({
    database: runtime.database,
    league,
    scope: openScope,
    namespace: "gamma",
  });
  clockState.nowMs = openScope.fad.candidate_deadline_at_ms;
  const deadline = await clocked.services.league
    .freeAgentDraftDeadlineJob.run();
  if (deadline.succeeded !== 1 || deadline.failed !== 0) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_DEADLINE_FAILED",
      "Gamma Candidate Cards did not publish through the deadline lifecycle."
    );
  }
  for (let pass = 0; pass < 20; pass += 1) {
    const pending = runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_player_allocations
      WHERE league_id = ? AND fad_id = ? AND status = 'pending'
    `).get(league.leagueId, openScope.fad.id).count;
    if (pending === 0) break;
    const allocation = await clocked.services.league
      .freeAgentDraftAllocationCycleJob.run();
    if (allocation.status === "failed") {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_ALLOCATION_FAILED",
        "Gamma FAD allocations did not complete through the allocation lifecycle."
      );
    }
  }
  clockState.nowMs = schedule.firstWeekStartsAtMs;
  for (let pass = 0; pass < 20; pass += 1) {
    const status = runtime.database.prepare(`
      SELECT status FROM free_agent_drafts WHERE id = ?
    `).get(openScope.fad.id).status;
    if (status === "completed") break;
    await clocked.services.league.freeAgentDraftRolloverJob.run();
    const completionResult = await clocked.services.league
      .freeAgentDraftCompletionJob.run();
    if (completionResult.failed > 0) {
      const failure = runtime.database.prepare(`
        SELECT last_error_code
        FROM job_runs
        WHERE league_id = ? AND season_id = ?
          AND job_type = 'fad_completion'
          AND status = 'failed'
        ORDER BY updated_at_ms DESC, id DESC
        LIMIT 1
      `).get(league.leagueId, league.seasonId);
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_COMPLETION_EXECUTION_FAILED",
        `Gamma FAD completion did not terminalize through the lifecycle job (${failure?.last_error_code ?? "unknown"}).`
      );
    }
  }
  const gammaStatus = runtime.database.prepare(`
    SELECT status FROM free_agent_drafts WHERE id = ?
  `).get(openScope.fad.id).status;
  if (gammaStatus !== "completed") {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_COMPLETION_FAILED",
      "Gamma FAD did not complete through the lifecycle jobs."
    );
  }
  const completedScope = draftScope(
    runtime.database,
    league,
    "completed"
  );
  insertDeferredGammaRosters({
    runtime,
    league,
    players,
    fixtureNowMs,
  });
  const matchupFacts = insertFixtureMatchupScoring({
    runtime,
    league,
    fadId: completedScope.fad.id,
    fixtureNowMs,
    namespace: "gamma",
  });
  const rosterFacts = runtime.database.prepare(`
    SELECT ownership.team_id,
           COUNT(*) AS player_count,
           SUM(contract.aav_cents) AS cap_cents
    FROM player_ownerships AS ownership
    JOIN contracts AS contract
      ON contract.league_id = ownership.league_id
     AND contract.player_id = ownership.player_id
     AND contract.current_team_id = ownership.team_id
     AND contract.status = 'active'
    WHERE ownership.league_id = ?
      AND ownership.season_id = ?
      AND ownership.ownership_kind = 'Rostered'
    GROUP BY ownership.team_id
    ORDER BY ownership.team_id
  `).all(league.leagueId, league.seasonId);
  const outcomeFacts = runtime.database.prepare(`
    SELECT event.offer_outcome_code, COUNT(*) AS count
    FROM free_agent_draft_allocation_events AS event
    WHERE event.league_id = ? AND event.fad_id = ?
      AND event.event_kind = 'offer_considered'
    GROUP BY event.offer_outcome_code
    ORDER BY event.offer_outcome_code
  `).all(league.leagueId, completedScope.fad.id);
  const thirtyDollarWinner = players.gammaTeam1ForwardWinner1;
  const thirtyDollarWinnerFact = runtime.database.prepare(`
    SELECT ownership.team_id, ownership.roster_category,
           ownership.position_group, ownership.slot_number,
           contract.original_total_value_cents,
           contract.original_term_years, contract.aav_cents
    FROM player_ownerships AS ownership
    JOIN contracts AS contract
      ON contract.league_id = ownership.league_id
     AND contract.player_id = ownership.player_id
     AND contract.current_team_id = ownership.team_id
     AND contract.status = 'active'
    WHERE ownership.league_id = ? AND ownership.season_id = ?
      AND ownership.player_id = ?
      AND ownership.ownership_kind = 'Rostered'
    LIMIT 1
  `).get(
    league.leagueId,
    league.seasonId,
    thirtyDollarWinner.playerId
  );
  if (
    rosterFacts.length !== 14 ||
    rosterFacts.some(
      ({ player_count: count, cap_cents: cap }) =>
        count !== 22 || cap < 7_000 || cap > 10_000
    ) ||
    !outcomeFacts.some(({ offer_outcome_code: code }) => code === "winner") ||
    !outcomeFacts.some(({ offer_outcome_code: code }) => code.startsWith("lost_")) ||
    thirtyDollarWinnerFact?.team_id !== league.teams[0].teamId ||
    thirtyDollarWinnerFact?.roster_category !== "Active" ||
    thirtyDollarWinnerFact?.position_group !== "F" ||
    thirtyDollarWinnerFact?.slot_number !== 2 ||
    thirtyDollarWinnerFact?.original_total_value_cents !== 3_000 ||
    thirtyDollarWinnerFact?.original_term_years !== 3 ||
    thirtyDollarWinnerFact?.aav_cents !== 1_000
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_GAMMA_RESULT_INVALID",
      "Gamma must finish with full cap-valid rosters and both winning and losing published offers."
    );
  }
  return Object.freeze({
    completedScope,
    rosterFacts,
    outcomeFacts,
    matchupFacts,
    thirtyDollarWinner: Object.freeze({
      playerId: thirtyDollarWinner.playerId,
      fullName: thirtyDollarWinner.fullName,
      teamId: thirtyDollarWinnerFact.team_id,
      totalValueCents:
        thirtyDollarWinnerFact.original_total_value_cents,
      termYears: thirtyDollarWinnerFact.original_term_years,
      aavCents: thirtyDollarWinnerFact.aav_cents,
    }),
  });
}

function candidateCommand({
  runtime,
  accounts,
  league,
  scope,
  teamIndex,
  managerAccountAlias,
  player,
  slotKey,
  aavCents,
  termYears,
}) {
  const team = league.teams[teamIndex];
  const card = scope.cardByTeamId.get(team.teamId);
  const authenticated = authenticate(
    runtime,
    accounts[managerAccountAlias].userId
  );
  return runtime.services.league.candidateCards
    .addCandidate({
      authenticated,
      leagueId: league.leagueId,
      fadId: scope.fad.id,
      teamId: team.teamId,
      slotKey,
      input: {
        playerId: player.playerId,
        aavCents,
        termYears,
      },
      expectedCardVersion: card.version,
      idempotencyKey:
        `fad-browser-${league.alias}-${team.alias}-candidate`,
    });
}

function findCardReadyNotification({
  database,
  league,
  fadId,
  teamAlias,
  recipientUserId,
}) {
  const team = league.teams.find(
    ({ alias }) => alias === teamAlias
  );
  const matches = database.prepare(`
    SELECT id, user_id, event_type, message_data_json
    FROM notifications
    WHERE league_id = ?
      AND event_type = 'fad_cards_opened'
      AND related_record_id = ?
      AND user_id = ?
    ORDER BY id ASC
  `).all(
    league.leagueId,
    fadId,
    recipientUserId
  ).filter((row) => {
    const messageData = JSON.parse(
      row.message_data_json
    );
    return messageData.teamId === team.teamId;
  });
  if (matches.length !== 1) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_NOTIFICATION_FAILED",
      "The local FAD browser fixture requires one exact card-ready notification."
    );
  }
  return matches[0];
}

function manifestTeams(league, scope) {
  return league.teams.map((team) => {
    const card = scope.cardByTeamId.get(team.teamId);
    return {
      alias: team.alias,
      name: team.name,
      teamId: team.teamId,
      managerAccountAlias:
        team.managerAccountAlias,
      cardId: card.id,
    };
  });
}

function alphaSentinels({
  runtime,
  accounts,
  league,
  scope,
  fixtureNowMs,
}) {
  const helpTeam = league.teams[2];
  const commissioner = authenticate(
    runtime,
    accounts.alphaCommissioner.userId
  );
  function commissionerIsDenied(team) {
    try {
      runtime.services.league.candidateCards.privateCard({
        authenticated: commissioner,
        leagueId: league.leagueId,
        fadId: scope.fad.id,
        teamId: team.teamId,
      });
      return false;
    } catch (error) {
      return error?.code === "CANDIDATE_CARD_NOT_FOUND";
    }
  }
  const deniedTeam = league.teams[3];
  if (!commissionerIsDenied(deniedTeam)) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PRIVACY_FAILED",
      "The local FAD browser fixture could not prove commissioner denial outside exact help."
    );
  }
  let exactCommissionerHelp;
  if (
    fixtureNowMs >= scope.fad.help_opens_at_ms &&
    fixtureNowMs < scope.fad.candidate_deadline_at_ms
  ) {
    const helpManager = authenticate(
      runtime,
      accounts[helpTeam.managerAccountAlias].userId
    );
    const help = runtime.services.league.candidateCards
      .requestHelp({
        authenticated: helpManager,
        leagueId: league.leagueId,
        fadId: scope.fad.id,
        teamId: helpTeam.teamId,
        input: { message: HELP_MESSAGE },
        idempotencyKey:
          "fad-browser-alpha-exact-commissioner-help",
      });
    const helpedCard =
      runtime.services.league.candidateCards.privateCard({
        authenticated: commissioner,
        leagueId: league.leagueId,
        fadId: scope.fad.id,
        teamId: helpTeam.teamId,
      });
    if (
      helpedCard.accessReason !==
        "help_grant_commissioner" ||
      helpedCard.helpContext?.helpRequestId !==
        help.data.helpRequestId ||
      helpedCard.slots.some(
        (slot) => slot.occupantKind !== "empty"
      )
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_HELP_FAILED",
        "The local FAD browser fixture could not prove exact commissioner help authority."
      );
    }
    exactCommissionerHelp = {
      status: "active",
      teamAlias: "alphaTeam3",
      cardId: helpedCard.cardId,
      helpRequestId: help.data.helpRequestId,
      message: HELP_MESSAGE,
      requestingAccountAlias: helpTeam.managerAccountAlias,
      commissionerAccountAlias: "alphaCommissioner",
    };
  } else {
    if (!commissionerIsDenied(helpTeam)) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PRIVACY_FAILED",
        "The local FAD browser fixture exposed a card before the help window."
      );
    }
    exactCommissionerHelp = {
      status: "not_open",
      teamAlias: "alphaTeam3",
      helpOpensAtMs: scope.fad.help_opens_at_ms,
      requestingAccountAlias: helpTeam.managerAccountAlias,
      commissionerAccountAlias: "alphaCommissioner",
    };
  }

  const notification = findCardReadyNotification({
    database: runtime.database,
    league,
    fadId: scope.fad.id,
    teamAlias: "alphaTeam1",
    recipientUserId:
      accounts.alphaMultiTeamManager.userId,
  });

  return {
    emptyInauguralCards: true,
    carryoverCount: 0,
    exactCommissionerHelp,
    cardReadyNotification: {
      notificationId: notification.id,
      eventType: notification.event_type,
      recipientAccountAlias:
        "alphaMultiTeamManager",
      teamAlias: "alphaTeam1",
      copy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY
          .fad_cards_opened,
    },
  };
}

function betaSentinels({
  runtime,
  accounts,
  league,
  scope,
  players,
}) {
  const candidate = candidateCommand({
    runtime,
    accounts,
    league,
    scope,
    teamIndex: 0,
    managerAccountAlias: "betaManager",
    player: players.betaPrivateCandidate,
    slotKey: "D03",
    aavCents: 300,
    termYears: 3,
  });
  const slot = candidate.data.card.slots.find(
    (candidateSlot) =>
      candidateSlot.player?.playerId ===
      players.betaPrivateCandidate.playerId
  );
  if (
    slot?.slotKey !== "D03" ||
    slot.occupantKind !== "candidate"
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_SENTINEL_FAILED",
      "The local FAD browser fixture could not prove its Beta private candidate sentinel."
    );
  }
  const notification = findCardReadyNotification({
    database: runtime.database,
    league,
    fadId: scope.fad.id,
    teamAlias: "betaTeam1",
    recipientUserId: accounts.betaManager.userId,
  });
  return {
    privateCandidates: [
      {
        alias: "betaPrivateCandidate",
        playerFullName:
          players.betaPrivateCandidate.fullName,
        playerId:
          players.betaPrivateCandidate.playerId,
        teamAlias: "betaTeam1",
        slotKey: "D03",
        entryId: candidate.data.changedEntryId,
      },
    ],
    cardReadyNotification: {
      notificationId: notification.id,
      eventType: notification.event_type,
      recipientAccountAlias: "betaManager",
      teamAlias: "betaTeam1",
      copy:
        FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY
          .fad_cards_opened,
    },
  };
}

function manifestLeague({
  league,
  scope,
  sentinels,
}) {
  const scenario = LEAGUE_BLUEPRINTS[league.alias].scenario;
  return {
    alias: league.alias,
    name: LEAGUE_BLUEPRINTS[league.alias].name,
    scenario,
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    priorSeasonId: league.priorSeasonId ?? null,
    fadId: scope.fad.id,
    phase: scope.fad.status,
    openedAtMs: scope.fad.opened_at_ms,
    helpOpensAtMs: scope.fad.help_opens_at_ms,
    candidateDeadlineAtMs:
      scope.fad.candidate_deadline_at_ms,
    firstWeekStartsAtMs:
      sentinels?.weekOneMatchups?.startsAtMs ??
      scope.fad.first_matchup_starts_at_ms,
    commissionerAccountAlias:
      league.commissionerAccountAlias,
    memberAccountAliases: [
      ...LEAGUE_BLUEPRINTS[league.alias]
        .memberAccountAliases,
    ],
    candidateCardsEditable:
      scope.fad.status === "cards_open",
    competitionPhase:
      scenario === "week_1_completed_fad"
        ? "week_1"
        : "preseason_fad",
    teams: manifestTeams(league, scope),
    sentinels,
  };
}

async function createFreeAgentDraftBrowserFixture({
  runtime,
  nowMs = FIXTURE_NOW_MS,
} = {}) {
  const targetRuntime = assertRuntime(runtime);
  if (!Number.isSafeInteger(nowMs) || nowMs < DAY_MS) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_CLOCK_INVALID",
      "The FAD browser fixture requires a safe current timestamp."
    );
  }
  try {
    const accounts = accountRecords();
    const foundations = seedFoundations(
      targetRuntime,
      accounts,
      nowMs
    );
    revokeActiveFixtureSessions(
      targetRuntime,
      accounts
    );
    const schedules = schedulesFor(nowMs);
    const gammaResult = await completeGammaFixture({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.gamma,
      schedule: schedules.gamma,
      players: foundations.players,
      fixtureNowMs: nowMs,
    });
    revokeActiveFixtureSessions(
      targetRuntime,
      accounts
    );
    const betaSource = await completeBetaSourceFad({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.beta,
      schedule: schedules.betaPrior,
      players: foundations.players,
      fixtureNowMs: nowMs,
    });
    const betaFinalization = finalizeBetaSourceStandings({
      runtime: betaSource.clocked,
      accounts,
      league: foundations.leagues.beta,
      standings: betaSource.standings,
    });
    schedulePlannedSeason({
      runtime: betaSource.clocked,
      accounts,
      league: foundations.leagues.beta,
      schedule: schedules.beta,
      createdAtMs: betaFinalization.finalizedAtMs,
    });
    const betaEntryDraftId = seedBetaEntryDraftFoundation({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.beta,
      standingsSnapshotId: betaFinalization.snapshotId,
      createdAtMs: betaFinalization.finalizedAtMs,
    });
    betaSource.clockState.nowMs =
      betaFinalization.finalizedAtMs + DAY_MS;
    const betaAuthenticated = authenticate(
      betaSource.clocked,
      accounts[
        foundations.leagues.beta
          .commissionerAccountAlias
      ].userId
    );
    const betaEntryDraft = betaSource.clocked.services.league
      .entryDraftSchedule.schedule({
        leagueId: foundations.leagues.beta.leagueId,
        entryDraftId: betaEntryDraftId,
        input: {
          action: ENTRY_DRAFT_SCHEDULE_ACTION,
          scheduledStartsAtMs:
            schedules.beta.firstWeekStartsAtMs - 14 * DAY_MS,
          confirmation: ENTRY_DRAFT_SCHEDULE_CONFIRMATION,
        },
        expectedEntryDraftVersion: 1,
        idempotencyKey: "fad-browser-v4-beta-entry-draft-schedule",
        authenticated: betaAuthenticated,
      });
    betaSource.clockState.nowMs =
      betaEntryDraft.scheduledStartsAtMs;
    const rollover = await betaSource.clocked.services.league
      .seasonRolloverJob.run();
    if (
      rollover.due !== 1 ||
      rollover.acquired !== 1 ||
      rollover.succeeded !== 1 ||
      rollover.failed !== 0
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_BETA_ROLLOVER_INVALID",
        "Beta did not enter its second season through the production rollover job."
      );
    }
    insertBetaTargetScheduleJobs({
      runtime: betaSource.clocked,
      league: foundations.leagues.beta,
      createdAtMs: betaSource.clockState.nowMs,
    });
    betaSource.clockState.nowMs =
      betaEntryDraft.scheduledStartsAtMs + DAY_MS;
    completeBetaEntryDraftAndHandoff({
      runtime: betaSource.clocked,
      league: foundations.leagues.beta,
      draftId: betaEntryDraftId,
      completedAtMs: betaSource.clockState.nowMs,
    });
    const betaOpening = await betaSource.clocked.services.league
      .freeAgentDraftReadinessJob.run();
    if (
      betaOpening.status !== "succeeded" ||
      betaOpening.succeeded !== 1 ||
      betaOpening.blocked !== 0 ||
      betaOpening.failed !== 0
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
        "Beta did not open its second-season FAD from completed Entry Draft authority."
      );
    }
    startAndScheduleLeague({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.alpha,
      schedules,
    });
    insertFutureContractYears({
      runtime: targetRuntime,
      leagues: {
        alpha: foundations.leagues.alpha,
      },
      players: foundations.players,
      fixtureNowMs: nowMs,
    });
    const alphaOpening = await targetRuntime.services.league
      .freeAgentDraftReadinessJob.run();
    if (
      alphaOpening.status !== "succeeded" ||
      alphaOpening.succeeded !== 1 ||
      alphaOpening.blocked !== 0 ||
      alphaOpening.failed !== 0
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
        "Alpha did not open its inaugural FAD through the real readiness lifecycle."
      );
    }

    const alphaScope = draftScope(
      targetRuntime.database,
      foundations.leagues.alpha
    );
    const betaScope = draftScope(
      targetRuntime.database,
      foundations.leagues.beta
    );
    const alphaFixtureSentinels = alphaSentinels({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.alpha,
      scope: alphaScope,
      fixtureNowMs: nowMs,
    });
    const betaFixtureSentinels = betaSentinels({
      runtime: betaSource.clocked,
      accounts,
      league: foundations.leagues.beta,
      scope: betaScope,
      players: foundations.players,
    });
    backfillFourSeasonDraftPickInventory({
      runtime: targetRuntime,
      accounts,
      leagues: foundations.leagues,
      fixtureNowMs: nowMs,
    });
    const gammaFixtureSentinels = {
      publishedHistoryReadOnly: true,
      rosterPlayersPerTeam: 22,
      capRangeCents: {
        minimum: Math.min(
          ...gammaResult.rosterFacts.map(({ cap_cents: cap }) => cap)
        ),
        maximum: Math.max(
          ...gammaResult.rosterFacts.map(({ cap_cents: cap }) => cap)
        ),
      },
      offerOutcomes: Object.fromEntries(
        gammaResult.outcomeFacts.map(
          ({ offer_outcome_code: code, count }) => [code, count]
        )
      ),
      thirtyDollarThreeYearWinner:
        gammaResult.thirtyDollarWinner,
      weekOneMatchups: gammaResult.matchupFacts,
    };

    return deepFreeze({
      schemaVersion: BROWSER_FIXTURE_SCHEMA_VERSION,
      fixtureKind: BROWSER_FIXTURE_KIND,
      fixedNowMs: nowMs,
      accounts,
      leagues: {
        alpha: manifestLeague({
          league: foundations.leagues.alpha,
          scope: alphaScope,
          sentinels: alphaFixtureSentinels,
        }),
        beta: manifestLeague({
          league: foundations.leagues.beta,
          scope: betaScope,
          sentinels: betaFixtureSentinels,
        }),
        gamma: manifestLeague({
          league: foundations.leagues.gamma,
          scope: gammaResult.completedScope,
          sentinels: gammaFixtureSentinels,
        }),
      },
      privacyChecks: {
        alphaManagerAccountAlias:
          "alphaMultiTeamManager",
        alphaManagerManagedTeamAliases: [
          "alphaTeam1",
          "alphaTeam3",
        ],
        alphaManagerDeniedTeamAlias:
          "alphaTeam2",
        alphaManagerExcludedLeagueAlias: "beta",
        commissionerAccountAlias:
          "alphaCommissioner",
        commissionerDeniedTeamAlias:
          "alphaTeam4",
        commissionerHelpTeamAlias:
          "alphaTeam3",
        privateMarkers: [
          foundations.players.betaPrivateCandidate
            .fullName,
          foundations.players[carryoverAlias("beta", 0, 0)]
            .fullName,
          foundations.players.gammaTeam1SharedWinner
            .fullName,
        ],
      },
    });
  } catch (error) {
    if (
      error instanceof
      FreeAgentDraftBrowserFixtureError
    ) {
      throw error;
    }
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_FAILED",
      "The local FAD browser fixture could not be created safely.",
      error
    );
  }
}

module.exports = {
  BROWSER_FIXTURE_KIND,
  BROWSER_FIXTURE_SCHEMA_VERSION,
  FreeAgentDraftBrowserFixtureError,
  backfillExistingFreeAgentDraftBrowserFixturePickInventory,
  createFreeAgentDraftBrowserFixture,
  schedulesFor,
  selectCatalogPlayers,
};
