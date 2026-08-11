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
const BROWSER_FIXTURE_SCHEMA_VERSION = 1;
const BROWSER_FIXTURE_KIND = "free_agent_draft_browser";
const HELP_MESSAGE =
  "Alpha exact commissioner help private sentinel.";
const BASE_SCHEDULE = Object.freeze({
  nhlRegularSeasonStartsAtMs: Date.parse(
    "2026-07-28T07:00:00.000Z"
  ),
  nhlRegularSeasonEndsAtMs: Date.parse(
    "2027-04-12T07:00:00.000Z"
  ),
  fantasyPlayoffsStartAtMs: Date.parse(
    "2027-03-15T07:00:00.000Z"
  ),
  fantasyPlayoffsEndAtMs: Date.parse(
    "2027-04-12T07:00:00.000Z"
  ),
});
const SCHEDULES = Object.freeze({
  alpha: Object.freeze({
    ...BASE_SCHEDULE,
    firstWeekStartsAtMs: Date.parse(
      "2026-08-03T07:00:00.000Z"
    ),
  }),
  beta: Object.freeze({
    ...BASE_SCHEDULE,
    firstWeekStartsAtMs: Date.parse(
      "2026-08-10T07:00:00.000Z"
    ),
  }),
});

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
    name: "FAD Browser Alpha League",
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
    name: "FAD Browser Beta League",
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
    ]),
  }),
});

const PLAYER_BLUEPRINTS = Object.freeze({
  alphaLockedCarryover: Object.freeze({
    firstName: "Alpha",
    lastName: "Locked Carryover Sentinel",
    fullName: "Alpha Locked Carryover Sentinel",
    positionGroup: "F",
  }),
  alphaManagedPrivateCandidate: Object.freeze({
    firstName: "Alpha",
    lastName: "Managed Private Candidate Sentinel",
    fullName: "Alpha Managed Private Candidate Sentinel",
    positionGroup: "F",
  }),
  alphaCommissionerHelpCandidate: Object.freeze({
    firstName: "Alpha",
    lastName: "Help Card Private Sentinel",
    fullName: "Alpha Help Card Private Sentinel",
    positionGroup: "D",
  }),
  alphaCommissionerDeniedCandidate: Object.freeze({
    firstName: "Alpha",
    lastName: "Denied Card Private Sentinel",
    fullName: "Alpha Denied Card Private Sentinel",
    positionGroup: "F",
  }),
  betaPrivateCandidate: Object.freeze({
    firstName: "Beta",
    lastName: "Private Candidate Sentinel",
    fullName: "Beta Private Candidate Sentinel",
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
}) {
  const createdAtMs = FIXTURE_NOW_MS - DAY_MS;
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
      FIXTURE_NOW_MS + 120 * DAY_MS,
    maximum_teams: 6,
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
      updated_at_ms: FIXTURE_NOW_MS,
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

function insertPlayerFoundations({
  repositories,
  leagues,
  accounts,
}) {
  const players = {};
  for (const [alias, blueprint] of
    Object.entries(PLAYER_BLUEPRINTS)) {
    const playerId = fixtureId(
      `fad-browser:player:${alias}`
    );
    repositories.players.insert({
      id: playerId,
      first_name: blueprint.firstName,
      last_name: blueprint.lastName,
      full_name: blueprint.fullName,
      birth_date: null,
      status: "active",
      created_at_ms: FIXTURE_NOW_MS,
      updated_at_ms: FIXTURE_NOW_MS,
      version: 1,
    });
    players[alias] = Object.freeze({
      alias,
      playerId,
      fullName: blueprint.fullName,
      positionGroup: blueprint.positionGroup,
    });
  }

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
        effective_at_ms: FIXTURE_NOW_MS,
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
    created_at_ms: FIXTURE_NOW_MS,
    updated_at_ms: FIXTURE_NOW_MS,
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
    created_at_ms: FIXTURE_NOW_MS,
    updated_at_ms: FIXTURE_NOW_MS,
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
    created_at_ms: FIXTURE_NOW_MS,
  });

  return Object.freeze(players);
}

function seedFoundations(runtime, accounts) {
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
        });
    }
    const players = insertPlayerFoundations({
      repositories,
      leagues,
      accounts,
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
}) {
  const scheduleInput = SCHEDULES[league.alias];
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
    started.activatedTeamCount !== 6 ||
    schedule.firstWeekStartsAtMs !==
      scheduleInput.firstWeekStartsAtMs
  ) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_LIFECYCLE_FAILED",
      "The local FAD browser fixture did not start its complete six-team league."
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
  if (cards.length !== 6) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_OPENING_FAILED",
      "The local FAD browser fixture requires all six Candidate Cards."
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
  const commissioner = authenticate(
    runtime,
    accounts.alphaCommissioner.userId
  );
  const deniedTeam = league.teams[3];
  let commissionerDenied = false;
  try {
    runtime.services.league.candidateCards.privateCard({
      authenticated: commissioner,
      leagueId: league.leagueId,
      fadId: scope.fad.id,
      teamId: deniedTeam.teamId,
    });
  } catch (error) {
    commissionerDenied =
      error?.code === "CANDIDATE_CARD_NOT_FOUND";
  }
  if (!commissionerDenied) {
    fail(
      "FREE_AGENT_DRAFT_BROWSER_FIXTURE_PRIVACY_FAILED",
      "The local FAD browser fixture could not prove commissioner denial outside exact help."
    );
  }
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
    exactCommissionerHelp: {
      teamAlias: "alphaTeam3",
      cardId: helpedCard.cardId,
      helpRequestId: help.data.helpRequestId,
      message: HELP_MESSAGE,
      privatePlayerFullName:
        players.alphaCommissionerHelpCandidate.fullName,
      requestingAccountAlias: "alphaOtherManager",
      commissionerAccountAlias: "alphaCommissioner",
    },
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
} = {}) {
  const targetRuntime = assertRuntime(runtime);
  try {
    const accounts = accountRecords();
    const foundations = seedFoundations(
      targetRuntime,
      accounts
    );
    for (const league of
      Object.values(foundations.leagues)) {
      startAndScheduleLeague({
        runtime: targetRuntime,
        accounts,
        league,
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
      fixedNowMs: FIXTURE_NOW_MS,
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
};
