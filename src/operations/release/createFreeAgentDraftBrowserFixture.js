"use strict";

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

const DAY_MS = 24 * 60 * 60 * 1_000;
const BROWSER_FIXTURE_SCHEMA_VERSION = 2;
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
  const alphaFirstWeekStartsAtMs = nextVancouverMondayAtOrAfter(
    nowMs + 8 * DAY_MS
  );
  const betaFirstWeekStartsAtMs = alphaFirstWeekStartsAtMs + 7 * DAY_MS;
  const schedule = (firstWeekStartsAtMs) => Object.freeze({
    nhlRegularSeasonStartsAtMs: firstWeekStartsAtMs - 6 * DAY_MS,
    nhlRegularSeasonEndsAtMs: firstWeekStartsAtMs + 252 * DAY_MS,
    fantasyPlayoffsStartAtMs: firstWeekStartsAtMs + 224 * DAY_MS,
    fantasyPlayoffsEndAtMs: firstWeekStartsAtMs + 252 * DAY_MS,
    firstWeekStartsAtMs,
  });
  return Object.freeze({
    alpha: schedule(alphaFirstWeekStartsAtMs),
    beta: schedule(betaFirstWeekStartsAtMs),
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
});

const LEAGUE_BLUEPRINTS = Object.freeze({
  alpha: Object.freeze({
    name: "Pre-Week 1 FAD Test - Alpha (6 Teams)",
    commissionerAccountAlias: "alphaCommissioner",
    memberAccountAliases: Object.freeze([
      "platformAdmin",
      "alphaCommissioner",
      "alphaMultiTeamManager",
      "alphaOtherManager",
    ]),
    teamManagerAccountAliases: Object.freeze([
      "alphaMultiTeamManager",
      "alphaMultiTeamManager",
      "alphaOtherManager",
      "alphaOtherManager",
      "alphaOtherManager",
      "alphaOtherManager",
    ]),
  }),
  beta: Object.freeze({
    name: "Pre-Week 1 FAD Test - Beta (10 Teams)",
    commissionerAccountAlias: "betaCommissioner",
    memberAccountAliases: Object.freeze([
      "platformAdmin",
      "betaCommissioner",
      "betaManager",
    ]),
    teamManagerAccountAliases: Object.freeze([
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
      "betaManager",
    ]),
  }),
});

const PLAYER_BLUEPRINTS = Object.freeze({
  alphaLockedCarryover: Object.freeze({
    positionGroup: "F",
  }),
  alphaManagedPrivateCandidate: Object.freeze({
    positionGroup: "F",
  }),
  alphaCommissionerHelpCandidate: Object.freeze({
    positionGroup: "D",
  }),
  alphaCommissionerDeniedCandidate: Object.freeze({
    positionGroup: "F",
  }),
  betaPrivateCandidate: Object.freeze({
    positionGroup: "D",
  }),
});

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
    runtime.database.pragma("user_version", { simple: true }) !== 49
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID",
      "The local FAD browser fixture requires an open schema-49 release-QA runtime."
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
  const createdAtMs = fixtureNowMs - DAY_MS;
  const leagueId = fixtureId(
    `fad-browser:league:${leagueAlias}`
  );
  const seasonId = fixtureId(
    `fad-browser:season:${leagueAlias}`
  );
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
    id: seasonId,
    league_id: leagueId,
    label: "2026",
    nhl_season_key: "20262027",
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
      `fad-browser:membership:${leagueAlias}:${accountAlias}`
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
        `fad-browser:team:${leagueAlias}:${teamNumber}`
      );
      const name =
        `FAD Browser ${leagueAlias === "alpha" ? "Alpha" : "Beta"} ` +
        `Team ${teamNumber}`;
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
          `fad-browser:assignment:${leagueAlias}:${teamNumber}`
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
      current_season_id: seasonId,
      updated_at_ms: fixtureNowMs,
    },
  });

  return Object.freeze({
    alias: leagueAlias,
    leagueId,
    seasonId,
    expectedLeagueVersion: league.version,
    commissionerAccountAlias:
      blueprint.commissionerAccountAlias,
    teams: Object.freeze(teams),
  });
}

function selectCatalogPlayers(database) {
  const rows = database.prepare(`
    SELECT player.id, player.full_name, position.position_group
    FROM players AS player
    INNER JOIN player_external_ids AS external
      ON external.player_id = player.id
     AND external.provider = 'sportsdataio-discovery-lab'
    INNER JOIN league_player_positions AS position
      ON position.player_id = player.id
     AND position.league_id = ?
     AND position.ended_at_ms IS NULL
    WHERE player.status = 'active'
    GROUP BY player.id, position.position_group
    ORDER BY
      CASE WHEN lower(player.full_name) LIKE 'fixture player %' THEN 1 ELSE 0 END,
      lower(player.full_name) ASC,
      player.id ASC
  `).all(fixtureId("league:leagueA"));
  const available = new Map([
    ["F", rows.filter(({ position_group: position }) => position === "F")],
    ["D", rows.filter(({ position_group: position }) => position === "D")],
  ]);
  const players = {};
  for (const [alias, blueprint] of Object.entries(PLAYER_BLUEPRINTS)) {
    const selected = available.get(blueprint.positionGroup)?.shift();
    if (!selected) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PLAYER_CATALOG_INCOMPLETE",
        "The FAD browser fixture requires enough catalog-backed players."
      );
    }
    players[alias] = Object.freeze({
      alias,
      playerId: selected.id,
      fullName: selected.full_name,
      positionGroup: blueprint.positionGroup,
    });
  }
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

  for (const [leagueAlias, playerAliases] of [
    [
      "alpha",
      [
        "alphaLockedCarryover",
        "alphaManagedPrivateCandidate",
        "alphaCommissionerHelpCandidate",
        "alphaCommissionerDeniedCandidate",
      ],
    ],
    ["beta", ["betaPrivateCandidate"]],
  ]) {
    for (const playerAlias of playerAliases) {
      const player = players[playerAlias];
      repositories.league_player_positions.insert({
        id: fixtureId(
          `fad-browser:position:${leagueAlias}:${playerAlias}`
        ),
        league_id: leagues[leagueAlias].leagueId,
        player_id: player.playerId,
        position_group: player.positionGroup,
        reason: "FAD browser fixture",
        corrected_by_user_id:
          accounts[
            leagues[leagueAlias]
              .commissionerAccountAlias
          ].userId,
        effective_at_ms: fixtureNowMs,
        ended_at_ms: null,
        version: 1,
      });
    }
  }

  const alpha = leagues.alpha;
  const carryover = players.alphaLockedCarryover;
  const team = alpha.teams[0];
  const contractId = fixtureId(
    "fad-browser:contract:alphaLockedCarryover"
  );
  repositories.player_ownerships.insert({
    id: fixtureId(
      "fad-browser:ownership:alphaLockedCarryover"
    ),
    league_id: alpha.leagueId,
    season_id: alpha.seasonId,
    player_id: carryover.playerId,
    team_id: team.teamId,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: fixtureNowMs,
    updated_at_ms: fixtureNowMs,
    version: 1,
  });
  repositories.contracts.insert({
    id: contractId,
    league_id: alpha.leagueId,
    player_id: carryover.playerId,
    current_team_id: team.teamId,
    contract_type: "normal",
    original_total_value_cents: 500,
    original_term_years: 1,
    aav_cents: 500,
    start_season_id: alpha.seasonId,
    status: "active",
    acquisition_source_type: "migration",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: fixtureNowMs,
    updated_at_ms: fixtureNowMs,
    version: 1,
  });
  repositories.contract_years.insert({
    id: fixtureId(
      "fad-browser:contract-year:alphaLockedCarryover"
    ),
    league_id: alpha.leagueId,
    contract_id: contractId,
    season_id: alpha.seasonId,
    year_number: 1,
    aav_cents: 500,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: fixtureNowMs,
  });

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

function startAndScheduleLeague({
  runtime,
  accounts,
  league,
  schedules,
}) {
  const scheduleInput = schedules[league.alias];
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
      seasonId: league.seasonId,
      expectedSeasonVersion:
        started.league.currentSeason.version,
      input: {
        ...scheduleInput,
        confirmed: true,
      },
      idempotencyKey:
        `fad-browser-${league.alias}-schedule`,
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
}

function draftScope(database, league) {
  const fad = database.prepare(`
    SELECT id, status, opened_at_ms, help_opens_at_ms,
           candidate_deadline_at_ms,
           first_matchup_starts_at_ms
    FROM free_agent_drafts
    WHERE league_id = ? AND season_id = ?
  `).get(league.leagueId, league.seasonId);
  if (!fad || fad.status !== "cards_open") {
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

function candidateCommand({
  runtime,
  accounts,
  league,
  scope,
  teamIndex,
  managerAccountAlias,
  player,
  slotKey,
  totalValueCents,
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
        totalValueCents,
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
  players,
  fixtureNowMs,
}) {
  const managedCandidate = candidateCommand({
    runtime,
    accounts,
    league,
    scope,
    teamIndex: 0,
    managerAccountAlias: "alphaMultiTeamManager",
    player: players.alphaManagedPrivateCandidate,
    slotKey: "F02",
    totalValueCents: 600,
    termYears: 2,
  });
  const helpCandidate = candidateCommand({
    runtime,
    accounts,
    league,
    scope,
    teamIndex: 2,
    managerAccountAlias: "alphaOtherManager",
    player: players.alphaCommissionerHelpCandidate,
    slotKey: "D01",
    totalValueCents: 900,
    termYears: 3,
  });
  const deniedCandidate = candidateCommand({
    runtime,
    accounts,
    league,
    scope,
    teamIndex: 3,
    managerAccountAlias: "alphaOtherManager",
    player: players.alphaCommissionerDeniedCandidate,
    slotKey: "F01",
    totalValueCents: 400,
    termYears: 1,
  });
  const candidateCard = managedCandidate.data.card;
  const carryoverSlot = candidateCard.slots.find(
    (slot) =>
      slot.player?.playerId ===
      players.alphaLockedCarryover.playerId
  );
  const managedCandidateSlot = candidateCard.slots.find(
    (slot) =>
      slot.player?.playerId ===
      players.alphaManagedPrivateCandidate.playerId
  );
  const helpCandidateSlot =
    helpCandidate.data.card.slots.find(
      (slot) =>
        slot.player?.playerId ===
        players.alphaCommissionerHelpCandidate.playerId
    );
  const deniedCandidateSlot =
    deniedCandidate.data.card.slots.find(
      (slot) =>
        slot.player?.playerId ===
        players.alphaCommissionerDeniedCandidate.playerId
    );
  if (
    carryoverSlot?.slotKey !== "F01" ||
    carryoverSlot.occupantKind !== "carryover" ||
    carryoverSlot.locked !== true ||
    managedCandidateSlot?.slotKey !== "F02" ||
    managedCandidateSlot.occupantKind !== "candidate" ||
    helpCandidateSlot?.slotKey !== "D01" ||
    helpCandidateSlot.occupantKind !== "candidate" ||
    deniedCandidateSlot?.slotKey !== "F01" ||
    deniedCandidateSlot.occupantKind !== "candidate"
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_SENTINEL_FAILED",
      "The local FAD browser fixture could not prove its private card sentinels."
    );
  }

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
      accounts.alphaOtherManager.userId
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
      !helpedCard.slots.some(
        (slot) =>
          slot.player?.playerId ===
          players.alphaCommissionerHelpCandidate.playerId
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
      privatePlayerFullName:
        players.alphaCommissionerHelpCandidate.fullName,
      requestingAccountAlias: "alphaOtherManager",
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
      privatePlayerFullName:
        players.alphaCommissionerHelpCandidate.fullName,
      requestingAccountAlias: "alphaOtherManager",
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
    lockedCarryover: {
      playerFullName:
        players.alphaLockedCarryover.fullName,
      playerId:
        players.alphaLockedCarryover.playerId,
      teamAlias: "alphaTeam1",
      slotKey: "F01",
      entryId: carryoverSlot.entryId,
    },
    privateCandidates: [
      {
        alias: "managedTeamCandidate",
        playerFullName:
          players.alphaManagedPrivateCandidate.fullName,
        playerId:
          players.alphaManagedPrivateCandidate.playerId,
        teamAlias: "alphaTeam1",
        slotKey: "F02",
        entryId:
          managedCandidate.data.changedEntryId,
      },
      {
        alias: "commissionerHelpCandidate",
        playerFullName:
          players.alphaCommissionerHelpCandidate.fullName,
        playerId:
          players.alphaCommissionerHelpCandidate.playerId,
        teamAlias: "alphaTeam3",
        slotKey: "D01",
        entryId:
          helpCandidate.data.changedEntryId,
      },
      {
        alias: "commissionerDeniedCandidate",
        playerFullName:
          players.alphaCommissionerDeniedCandidate.fullName,
        playerId:
          players.alphaCommissionerDeniedCandidate.playerId,
        teamAlias: "alphaTeam4",
        slotKey: "F01",
        entryId:
          deniedCandidate.data.changedEntryId,
      },
    ],
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
    slotKey: "D01",
    totalValueCents: 900,
    termYears: 3,
  });
  const slot = candidate.data.card.slots.find(
    (candidateSlot) =>
      candidateSlot.player?.playerId ===
      players.betaPrivateCandidate.playerId
  );
  if (
    slot?.slotKey !== "D01" ||
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
        slotKey: "D01",
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
  return {
    alias: league.alias,
    name: LEAGUE_BLUEPRINTS[league.alias].name,
    leagueId: league.leagueId,
    seasonId: league.seasonId,
    fadId: scope.fad.id,
    phase: scope.fad.status,
    openedAtMs: scope.fad.opened_at_ms,
    helpOpensAtMs: scope.fad.help_opens_at_ms,
    candidateDeadlineAtMs:
      scope.fad.candidate_deadline_at_ms,
    firstWeekStartsAtMs:
      scope.fad.first_matchup_starts_at_ms,
    commissionerAccountAlias:
      league.commissionerAccountAlias,
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
    const schedules = schedulesFor(nowMs);
    for (const league of
      Object.values(foundations.leagues)) {
      startAndScheduleLeague({
        runtime: targetRuntime,
        accounts,
        league,
        schedules,
      });
    }
    const opening = await targetRuntime.services.league
      .freeAgentDraftReadinessJob.run();
    if (
      opening.status !== "succeeded" ||
      opening.succeeded !== 2 ||
      opening.blocked !== 0 ||
      opening.failed !== 0
    ) {
      fail(
        "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
        "The local FAD browser fixture did not open both leagues atomically per league."
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
      players: foundations.players,
      fixtureNowMs: nowMs,
    });
    const betaFixtureSentinels = betaSentinels({
      runtime: targetRuntime,
      accounts,
      league: foundations.leagues.beta,
      scope: betaScope,
      players: foundations.players,
    });

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
      },
      privacyChecks: {
        alphaManagerAccountAlias:
          "alphaMultiTeamManager",
        alphaManagerManagedTeamAliases: [
          "alphaTeam1",
          "alphaTeam2",
        ],
        alphaManagerDeniedTeamAlias:
          "alphaTeam3",
        alphaManagerExcludedLeagueAlias: "beta",
        commissionerAccountAlias:
          "alphaCommissioner",
        commissionerDeniedTeamAlias:
          "alphaTeam4",
        commissionerHelpTeamAlias:
          "alphaTeam3",
        privateMarkers: [
          foundations.players.alphaLockedCarryover
            .fullName,
          foundations.players.alphaManagedPrivateCandidate
            .fullName,
          foundations.players.alphaCommissionerHelpCandidate
            .fullName,
          foundations.players.alphaCommissionerDeniedCandidate
            .fullName,
          foundations.players.betaPrivateCandidate
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
  createFreeAgentDraftBrowserFixture,
  schedulesFor,
  selectCatalogPlayers,
};
