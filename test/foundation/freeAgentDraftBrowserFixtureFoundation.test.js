"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BROWSER_FIXTURE_KIND,
  BROWSER_FIXTURE_SCHEMA_VERSION,
  FreeAgentDraftBrowserFixtureError,
  backfillExistingFreeAgentDraftBrowserFixturePickInventory,
  createFreeAgentDraftBrowserFixture,
  schedulesFor,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  createReleaseQaRuntime,
} = require(
  "../../src/operations/release/createReleaseQaRuntime"
);
const {
  EXPECTED_LEAGUE_IDS,
  LEGACY_FIXTURE_LEAGUES,
  assertFixtureIdentitiesDistinct,
  assertNoPriorFixture,
  assertStagingScope,
  existingFixtureState,
} = require(
  "../../scripts/create-staging-fad-test-leagues"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "hundo";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function seedRealPlayerCatalog(database) {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIRECTORY, "players.json"), "utf8")
  );
  const selected = [
    ...catalog.filter(
      ({ active, position }) => active === true && position === "F"
    ).slice(0, 500),
    ...catalog.filter(
      ({ active, position }) => active === true && position === "D"
    ).slice(0, 300),
  ];
  let idCounter = 0;
  const repository = createSqlitePlayerCatalogRepository({
    database,
    createId: () =>
      `30000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    now: () => 1_700_000_000_100,
  });
  repository.applyCatalog({
    sourceOperationId: "20000000-0000-4000-8000-000000000001",
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: selected.map((player) => ({
      providerPlayerId: String(player.id),
      firstName: player.firstName,
      lastName: player.lastName,
      fullName: player.fullName,
      birthDate: player.birthDate,
      status: "active",
      sourcePosition: player.position,
      normalizedPosition: player.position,
      nhlTeamAbbreviation: player.teamAbbrev ?? null,
      active: true,
      sourceVersion: "players-json-2026",
      sourceUpdatedAtMs: 1_700_000_000_000,
    })),
  });
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertRecursivelyFrozen(child);
  }
}

function authenticate(runtime, userId) {
  const session =
    runtime.services.sessionService.issueForUser({
      userId,
    });
  const authenticated =
    runtime.services.sessionService.resolveWithoutActivity(
      session.rawSessionToken
    );
  assert.equal(authenticated.valid, true);
  return authenticated;
}

function repeatableSentinelFacts(value) {
  if (Array.isArray(value)) {
    return value.map(repeatableSentinelFacts);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "cardId",
            "entryId",
            "helpRequestId",
            "matchupId",
            "notificationId",
            "weekId",
          ].includes(key)
      )
      .map(([key, child]) => [
        key,
        repeatableSentinelFacts(child),
      ])
  );
}

function assertSentinelIds(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      assertSentinelIds(child);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Id")) {
      assert.equal(
        CANONICAL_UUID_PATTERN.test(child),
        true
      );
    } else {
      assertSentinelIds(child);
    }
  }
}

function repeatableFacts(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    fixtureKind: manifest.fixtureKind,
    fixedNowMs: manifest.fixedNowMs,
    accounts: Object.fromEntries(
      Object.entries(manifest.accounts).map(
        ([alias, account]) => [
          alias,
          {
            alias: account.alias,
            userId: account.userId,
            email: account.email,
          },
        ]
      )
    ),
    leagues: Object.fromEntries(
      Object.entries(manifest.leagues).map(
        ([alias, league]) => [
          alias,
          {
            alias: league.alias,
            name: league.name,
            leagueId: league.leagueId,
            seasonId: league.seasonId,
            phase: league.phase,
            openedAtMs: league.openedAtMs,
            helpOpensAtMs: league.helpOpensAtMs,
            candidateDeadlineAtMs:
              league.candidateDeadlineAtMs,
            firstWeekStartsAtMs:
              league.firstWeekStartsAtMs,
            commissionerAccountAlias:
              league.commissionerAccountAlias,
            teams: league.teams.map((team) => ({
              alias: team.alias,
              name: team.name,
              teamId: team.teamId,
              managerAccountAlias:
                team.managerAccountAlias,
            })),
            sentinelFacts:
              repeatableSentinelFacts(
                league.sentinels
              ),
          },
        ]
      )
    ),
    privacyChecks: manifest.privacyChecks,
  };
}

async function startRuntime(t) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: PASSWORD,
    port: 0,
  });
  t.after(() => started.close());
  return started;
}

test(
  "staging FAD activation refuses production, wrong fixture identity, unsafe scheduling, and duplicates",
  () => {
    const valid = {
      appEnv: "staging",
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
      leagueWriteMode: "open",
      freeAgentDraftRoutesEnabled: true,
      scheduledJobsEnabled: false,
    };
    assert.doesNotThrow(() => assertStagingScope(valid));
    assert.doesNotThrow(() => assertFixtureIdentitiesDistinct());
    assert.equal(EXPECTED_LEAGUE_IDS.length, 3);
    assert.equal(LEGACY_FIXTURE_LEAGUES.length, 4);
    assert.equal(
      new Set([
        ...EXPECTED_LEAGUE_IDS,
        ...LEGACY_FIXTURE_LEAGUES.map(({ id }) => id),
      ]).size,
      7
    );
    for (const overrides of [
      { appEnv: "production" },
      { environmentId: "production" },
      { databaseId: "production" },
      { leagueWriteMode: "closed" },
      { freeAgentDraftRoutesEnabled: false },
      { scheduledJobsEnabled: true },
    ]) {
      assert.throws(
        () => assertStagingScope({ ...valid, ...overrides }),
        (error) => error.code === "STAGING_FAD_TEST_SCOPE_INVALID"
      );
    }
    assert.doesNotThrow(() =>
      assertNoPriorFixture({
        prepare() {
          return { all: () => [] };
        },
      })
    );
    assert.equal(
      existingFixtureState({
        prepare() {
          return { all: () => [] };
        },
      }),
      "absent"
    );
    assert.equal(
      existingFixtureState({
        prepare() {
          return {
            all: () => EXPECTED_LEAGUE_IDS.map((id) => ({ id })),
          };
        },
      }),
      "complete"
    );
    assert.throws(
      () =>
        existingFixtureState({
          prepare() {
            return { all: () => [{ id: EXPECTED_LEAGUE_IDS[0] }] };
          },
        }),
      (error) =>
        error.code === "STAGING_FAD_TEST_EXISTING_STATE_PARTIAL"
    );
    assert.throws(
      () =>
        assertNoPriorFixture({
          prepare() {
            return { all: () => [{ id: EXPECTED_LEAGUE_IDS[0] }] };
          },
        }),
      (error) => error.code === "STAGING_FAD_TEST_ALREADY_EXISTS"
    );
  }
);

test(
  "staging FAD schedule keeps Week 1 on a Vancouver Monday more than one week ahead",
  () => {
    const nowMs = Date.parse("2026-08-12T18:00:00.000Z");
    const schedules = schedulesFor(nowMs);
    assert.equal(
      schedules.alpha.firstWeekStartsAtMs,
      Date.parse("2026-08-24T07:00:00.000Z")
    );
    assert.equal(
      schedules.alpha.firstWeekStartsAtMs >
        nowMs + 8 * 24 * 60 * 60 * 1_000,
      true
    );
    assert.equal(
      schedules.beta.firstWeekStartsAtMs -
        schedules.alpha.firstWeekStartsAtMs,
      0
    );
    assert.equal(
      schedules.gamma.firstWeekStartsAtMs,
      Date.parse("2026-08-03T07:00:00.000Z")
    );
  }
);

test(
  "FAD browser fixture rejects anything except an open schema-51 release-QA runtime",
  async () => {
    const source = fs.readFileSync(
      path.join(
        ROOT_DIRECTORY,
        "src",
        "operations",
        "release",
        "createFreeAgentDraftBrowserFixture.js"
      ),
      "utf8"
    );
    assert.match(source, /fad-browser-v4:/u);
    assert.match(source, /week_1_completed_fad/u);
    assert.deepEqual(
      [...source.matchAll(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([a-z_]+)/giu
      )].map((match) => `${match[1].toUpperCase()} ${match[2]}`),
      [
        "INSERT INTO job_runs",
        "INSERT INTO matchup_schedule_job_bindings",
        "INSERT INTO job_runs",
        "UPDATE draft_picks",
        "UPDATE entry_draft_pick_clocks",
        "UPDATE entry_drafts",
      ]
    );
    await assert.rejects(
      createFreeAgentDraftBrowserFixture({}),
      (error) =>
        error instanceof
          FreeAgentDraftBrowserFixtureError &&
        error.code ===
          "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID"
    );
  }
);

test(
  "FAD browser fixture uses real lifecycle and card services with strict privacy isolation",
  async (t) => {
    const started = await startRuntime(t);
    seedRealPlayerCatalog(started.runtime.database);
    const fixtureAccountEmails = [
      "admin@release-qa.example.test",
      "comm.a@release-qa.example.test",
      "comm.b@release-qa.example.test",
      "man.a.leag.a@release-qa.example.test",
      "man.b.leag.a@release-qa.example.test",
      "man.a.leag.b@release-qa.example.test",
    ];
    for (const email of fixtureAccountEmails) {
      const account = started.runtime.database.prepare(`
        SELECT id
        FROM users
        WHERE email_normalized = ?
      `).get(email);
      assert.ok(account);
      started.runtime.services.sessionService.issueForUser({
        userId: account.id,
      });
    }
    const triggerBaseline =
      started.runtime.database.prepare(`
        SELECT name, sql
        FROM sqlite_schema
        WHERE type = 'trigger'
        ORDER BY name ASC
      `).all();
    const manifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: started.runtime,
      });

    assert.equal(
      manifest.schemaVersion,
      BROWSER_FIXTURE_SCHEMA_VERSION
    );
    assert.equal(
      manifest.fixtureKind,
      BROWSER_FIXTURE_KIND
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(manifest)),
      manifest
    );
    assertRecursivelyFrozen(manifest);
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(/password|cookie|session|token/i.test(serialized), false);

    assert.deepEqual(Object.keys(manifest.leagues), [
      "alpha",
      "beta",
      "gamma",
    ]);
    for (const [leagueAlias, league] of
      Object.entries(manifest.leagues)) {
      const expectedTeamCount = {
        alpha: 8,
        beta: 6,
        gamma: 14,
      }[leagueAlias];
      assert.equal(UUID_PATTERN.test(league.leagueId), true);
      assert.equal(UUID_PATTERN.test(league.seasonId), true);
      assert.equal(UUID_PATTERN.test(league.fadId), true);
      assert.equal(
        league.phase,
        leagueAlias === "gamma" ? "completed" : "cards_open"
      );
      assert.equal(
        league.candidateCardsEditable,
        leagueAlias !== "gamma"
      );
      assert.equal(league.teams.length, expectedTeamCount);
      assert.equal(
        new Set(league.teams.map(({ teamId }) => teamId))
          .size,
        expectedTeamCount
      );
      assert.equal(
        league.helpOpensAtMs >=
          league.openedAtMs,
        true
      );
      assert.equal(
        league.candidateDeadlineAtMs >
          league.openedAtMs,
        true
      );
      if (leagueAlias !== "gamma") {
        assert.equal(league.openedAtMs <= manifest.fixedNowMs, true);
        assert.equal(
          manifest.fixedNowMs < league.candidateDeadlineAtMs,
          true
        );
      }
    }

    const alpha = manifest.leagues.alpha;
    const beta = manifest.leagues.beta;
    const gamma = manifest.leagues.gamma;
    const commissionerAccounts = [alpha, beta, gamma]
      .map(({ commissionerAccountAlias }) =>
        manifest.accounts[commissionerAccountAlias]
      );
    assert.equal(
      new Set(
        commissionerAccounts.map(({ userId }) => userId)
      ).size,
      1
    );
    assert.deepEqual(
      commissionerAccounts.map(({ email }) => email),
      Array(3).fill("comm.a@release-qa.example.test")
    );
    assert.equal(
      beta.memberAccountAliases.includes(
        "betaCommissioner"
      ),
      true
    );
    assert.equal(
      alpha.helpOpensAtMs >= alpha.openedAtMs,
      true
    );
    assert.equal(
      beta.helpOpensAtMs >= beta.openedAtMs,
      true
    );
    assert.equal(
      beta.firstWeekStartsAtMs -
        alpha.firstWeekStartsAtMs,
      0
    );
    assert.deepEqual(
      alpha.teams.slice(0, 2).map(
        ({ managerAccountAlias }) =>
          managerAccountAlias
      ),
      [
        "alphaMultiTeamManager",
        "alphaOtherManager",
      ]
    );
    assert.equal(alpha.sentinels.emptyInauguralCards, true);
    assert.equal(alpha.sentinels.carryoverCount, 0);
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.teamAlias,
      "alphaTeam3"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.status,
      "active"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.requestingAccountAlias,
      "alphaMultiTeamManager"
    );
    assert.equal(
      alpha.sentinels.cardReadyNotification.eventType,
      "fad_cards_opened"
    );
    assert.equal(
      alpha.sentinels.cardReadyNotification.copy,
      "Your Candidate Card is ready."
    );
    assert.equal(
      beta.sentinels.privateCandidates[0].slotKey,
      "D03"
    );
    assert.equal(gamma.competitionPhase, "week_1");
    assert.equal(gamma.firstWeekStartsAtMs <= manifest.fixedNowMs, true);
    assert.equal(
      manifest.fixedNowMs < gamma.firstWeekStartsAtMs + 7 * 24 * 60 * 60 * 1_000,
      true
    );
    assert.equal(gamma.sentinels.publishedHistoryReadOnly, true);
    assert.equal(gamma.sentinels.rosterPlayersPerTeam, 22);
    assert.deepEqual(
      gamma.sentinels.thirtyDollarThreeYearWinner,
      {
        ...gamma.sentinels.thirtyDollarThreeYearWinner,
        totalValueCents: 3_000,
        termYears: 3,
        aavCents: 1_000,
      }
    );
    assert.equal(
      gamma.sentinels.capRangeCents.minimum >= 7_000,
      true
    );
    assert.equal(
      gamma.sentinels.capRangeCents.maximum <= 10_000,
      true
    );
    assert.deepEqual(
      gamma.sentinels.weekOneMatchups,
      {
        ...gamma.sentinels.weekOneMatchups,
        matchupCount: 7,
        scheduledTeamCount: 14,
        activeRosterPlayerCount: 252,
        scoringPlayerCount: 252,
        scoringSignalCount: 14,
      }
    );
    assert.equal(
      gamma.sentinels.weekOneMatchups.maximumPlayerPointsHundredths >
        gamma.sentinels.weekOneMatchups.minimumPlayerPointsHundredths,
      true
    );
    assert.equal(
      manifest.privacyChecks.commissionerDeniedTeamAlias,
      "alphaTeam4"
    );
    assert.equal(
      manifest.privacyChecks.commissionerHelpTeamAlias,
      "alphaTeam3"
    );
    assert.equal(manifest.privacyChecks.privateMarkers.length, 3);
    assert.equal(
      manifest.privacyChecks.privateMarkers.every(
        (name) => typeof name === "string" && !name.includes("Sentinel")
      ),
      true
    );

    const database = started.runtime.database;
    assert.deepEqual(
      database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE (league_id = ? AND season_id = ?)
           OR (league_id = ? AND season_id = ?)
        GROUP BY status
      `).all(
        alpha.leagueId,
        alpha.seasonId,
        beta.leagueId,
        beta.seasonId
      ),
      [{ status: "succeeded", count: 2 }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT trigger_kind, entry_draft_id, setup_exemption_id,
               COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE (league_id = ? AND season_id = ?)
           OR (league_id = ? AND season_id = ?)
        GROUP BY trigger_kind, entry_draft_id, setup_exemption_id
        ORDER BY trigger_kind
      `).all(
        alpha.leagueId,
        alpha.seasonId,
        beta.leagueId,
        beta.seasonId
      ).map((row) => ({
        trigger_kind: row.trigger_kind,
        has_entry_draft: row.entry_draft_id !== null,
        has_setup_exemption: row.setup_exemption_id !== null,
        count: row.count,
      })),
      [
        {
          trigger_kind: "entry_draft_completed",
          has_entry_draft: true,
          has_setup_exemption: false,
          count: 1,
        },
        {
          trigger_kind: "no_draft_inaugural",
          has_entry_draft: false,
          has_setup_exemption: false,
          count: 1,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT from_season_id, to_season_id, status,
               target_season_reused
        FROM season_rollovers
        WHERE league_id = ?
      `).all(beta.leagueId),
      [{
        from_season_id: manifest.leagues.beta.priorSeasonId,
        to_season_id: beta.seasonId,
        status: "succeeded",
        target_season_reused: 1,
      }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM free_agent_drafts
           WHERE id IN (@alphaFad, @betaFad)) AS fads,
          (SELECT COUNT(*) FROM candidate_cards
           WHERE fad_id IN (@alphaFad, @betaFad)) AS cards,
          (SELECT COUNT(*) FROM candidate_card_help_requests
           WHERE fad_id IN (@alphaFad, @betaFad)) AS help_requests,
          (SELECT COUNT(*) FROM notifications
           WHERE related_record_id IN (@alphaFad, @betaFad)
             AND event_type = 'fad_cards_opened') AS card_ready
      `).get({
        alphaFad: alpha.fadId,
        betaFad: beta.fadId,
      }),
      {
        fads: 2,
        cards: 14,
        help_requests: 1,
        card_ready: 14,
      }
    );
    const carryoverCounts = database.prepare(`
      SELECT team_id, COUNT(*) AS count
      FROM candidate_card_entries
      WHERE fad_id IN (?, ?)
        AND entry_kind = 'carryover'
      GROUP BY team_id
      ORDER BY team_id ASC
    `).all(alpha.fadId, beta.fadId);
    assert.equal(carryoverCounts.length, 6);
    assert.deepEqual(
      [...new Set(carryoverCounts.map(({ count }) => count))],
      [6]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT DISTINCT carryover_aav_cents AS aav_cents
        FROM candidate_card_entries
        WHERE fad_id IN (?, ?)
          AND entry_kind = 'carryover'
        ORDER BY carryover_aav_cents ASC
      `).all(alpha.fadId, beta.fadId),
      [
        { aav_cents: 100 },
        { aav_cents: 200 },
        { aav_cents: 400 },
        { aav_cents: 700 },
        { aav_cents: 1_000 },
        { aav_cents: 1_500 },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT DISTINCT remaining_years
        FROM candidate_card_entries
        WHERE fad_id IN (?, ?)
          AND entry_kind = 'carryover'
        ORDER BY remaining_years ASC
      `).all(alpha.fadId, beta.fadId),
      [{ remaining_years: 1 }, { remaining_years: 2 }]
    );
    for (const league of [alpha, beta]) {
      assert.deepEqual(
        database.prepare(`
          SELECT label, nhl_season_key
          FROM seasons
          WHERE league_id = ? AND status = 'planned'
          ORDER BY nhl_season_key ASC
        `).all(league.leagueId),
        [
          { label: "2027-28", nhl_season_key: "20272028" },
          { label: "2028-29", nhl_season_key: "20282029" },
          { label: "2029-30", nhl_season_key: "20292030" },
        ]
      );
    }
    for (const [league, expectedUnusedPicksPerTeam] of [
      [alpha, 16],
      [beta, 12],
      [gamma, 16],
    ]) {
      const inventory = database.prepare(`
        SELECT original_team_id,
               COUNT(*) AS pick_count,
               SUM(status = 'unused') AS unused_pick_count,
               COUNT(DISTINCT target_season_id) AS season_count,
               COUNT(DISTINCT round_number) AS round_count
        FROM draft_picks
        WHERE league_id = ?
        GROUP BY original_team_id
        ORDER BY original_team_id
      `).all(league.leagueId);
      assert.equal(inventory.length, league.teams.length);
      assert.deepEqual(
        inventory.map((row) => ({
          pick_count: row.pick_count,
          unused_pick_count: row.unused_pick_count,
          season_count: row.season_count,
          round_count: row.round_count,
        })),
        Array.from({ length: league.teams.length }, () => ({
          pick_count: 16,
          unused_pick_count: expectedUnusedPicksPerTeam,
          season_count: 4,
          round_count: 4,
        }))
      );
    }
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_entries AS entry
        INNER JOIN players AS player ON player.id = entry.player_id
        WHERE entry.league_id IN (?, ?, ?)
          AND entry.entry_kind = 'carryover'
          AND lower(player.full_name) LIKE 'fixture player %'
      `).get(alpha.leagueId, beta.leagueId, gamma.leagueId).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM league_memberships
        WHERE league_id = ? AND user_id = ?
      `).get(
        beta.leagueId,
        manifest.accounts.alphaMultiTeamManager.userId
      ).count,
      0
    );

    const alphaManager = authenticate(
      started.runtime,
      manifest.accounts.alphaMultiTeamManager.userId
    );
    for (const teamAlias of [
      "alphaTeam1",
      "alphaTeam3",
    ]) {
      const team = alpha.teams.find(
        ({ alias }) => alias === teamAlias
      );
      const card = started.runtime.services.league
        .candidateCards.privateCard({
          authenticated: alphaManager,
          leagueId: alpha.leagueId,
          fadId: alpha.fadId,
          teamId: team.teamId,
      });
      assert.equal(card.accessReason, "team_manager");
      assert.equal(
        card.slots.every((slot) => slot.occupantKind === "empty"),
        true
      );
    }
    const deniedAlphaTeam = alpha.teams.find(
      ({ alias }) => alias === "alphaTeam2"
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaManager,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: deniedAlphaTeam.teamId,
          }),
      (error) => {
        assert.equal(
          error.code,
          "CANDIDATE_CARD_NOT_FOUND"
        );
        return true;
      }
    );
    const betaTeam = beta.teams[0];
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaManager,
            leagueId: beta.leagueId,
            fadId: beta.fadId,
            teamId: betaTeam.teamId,
          }),
      (error) => {
        assert.equal(error.code, "LEAGUE_NOT_FOUND");
        assert.equal(
          JSON.stringify({
            code: error.code,
            message: error.message,
          }).includes(
            beta.sentinels.privateCandidates[0]
              .playerFullName
          ),
          false
        );
        return true;
      }
    );
    const alphaCommissioner = authenticate(
      started.runtime,
      manifest.accounts.alphaCommissioner.userId
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaCommissioner,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: deniedAlphaTeam.teamId,
          }),
      (error) => error.code === "CANDIDATE_CARD_NOT_FOUND"
    );
    const commissionerDeniedTeam = alpha.teams.find(
      ({ alias }) =>
        alias ===
        manifest.privacyChecks
          .commissionerDeniedTeamAlias
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaCommissioner,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: commissionerDeniedTeam.teamId,
          }),
      (error) => {
        assert.equal(
          error.code,
          "CANDIDATE_CARD_NOT_FOUND"
        );
        return true;
      }
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM candidate_cards
        WHERE league_id = ? AND fad_id = ?
        GROUP BY status
      `).all(gamma.leagueId, gamma.fadId),
      [{ status: "locked_complete", count: 14 }]
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshots
        WHERE league_id = ? AND fad_id = ?
      `).get(gamma.leagueId, gamma.fadId).count,
      14
    );
    assert.deepEqual(
      database.prepare(`
        SELECT ownership.team_id, COUNT(*) AS player_count,
               SUM(contract.aav_cents) AS cap_cents
        FROM player_ownerships AS ownership
        JOIN contracts AS contract
          ON contract.league_id = ownership.league_id
         AND contract.player_id = ownership.player_id
         AND contract.current_team_id = ownership.team_id
         AND contract.status = 'active'
        WHERE ownership.league_id = ? AND ownership.season_id = ?
          AND ownership.ownership_kind = 'Rostered'
        GROUP BY ownership.team_id
        ORDER BY ownership.team_id
      `).all(gamma.leagueId, gamma.seasonId).map((row) => ({
        player_count: row.player_count,
        cap_valid: row.cap_cents >= 7_000 && row.cap_cents <= 10_000,
      })),
      Array.from({ length: 14 }, () => ({
        player_count: 22,
        cap_valid: true,
      }))
    );
    assert.equal(
      Object.keys(gamma.sentinels.offerOutcomes).includes("winner"),
      true
    );
    assert.equal(
      Object.keys(gamma.sentinels.offerOutcomes).some((code) =>
        code.startsWith("lost_")
      ),
      true
    );
    const immutableAwardEvidence = database.prepare(`
      SELECT event.evidence_json AS decision_json,
             outbox.payload_json AS outbox_json,
             json_extract(
               event.evidence_json,
               '$.sideEffects.fadVersion'
             ) AS decision_fad_version,
             json_extract(outbox.payload_json, '$.version')
               AS outbox_fad_version
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_draft_allocation_events AS event
        ON event.league_id = allocation.league_id
       AND event.season_id = allocation.season_id
       AND event.fad_id = allocation.fad_id
       AND event.allocation_id = allocation.id
       AND event.allocation_version = allocation.version
       AND event.event_kind = 'decision_recorded'
      JOIN outbox_events AS outbox
        ON outbox.league_id = event.league_id
       AND outbox.id = json_extract(
         event.evidence_json,
         '$.sideEffects.outboxEventId'
       )
      WHERE allocation.league_id = ? AND allocation.fad_id = ?
        AND allocation.status = 'automatic_award'
      ORDER BY allocation.id LIMIT 1
    `).get(gamma.leagueId, gamma.fadId);
    assert.equal(
      immutableAwardEvidence.decision_fad_version,
      immutableAwardEvidence.outbox_fad_version
    );
    const immutableAwardBytes = {
      decision_json: immutableAwardEvidence.decision_json,
      outbox_json: immutableAwardEvidence.outbox_json,
    };
    const completionPublication = database.prepare(`
      SELECT json_extract(payload_json, '$.version') AS version,
             json_extract(payload_json, '$.reasonCode') AS reason_code
      FROM outbox_events
      WHERE league_id = ?
        AND aggregate_type = 'free_agent_draft'
        AND aggregate_id = ?
        AND event_type = 'free_agent_draft.changed'
        AND json_extract(payload_json, '$.reasonCode') = 'completed'
    `).get(gamma.leagueId, gamma.fadId);
    assert.deepEqual(completionPublication, {
      version: database.prepare(`
        SELECT version FROM free_agent_drafts WHERE id = ?
      `).get(gamma.fadId).version,
      reason_code: "completed",
    });
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM matchups
           WHERE league_id = @leagueId
             AND matchup_week_id = @weekId) AS matchups,
          (SELECT COUNT(*) FROM matchup_roster_locks
           WHERE league_id = @leagueId
             AND matchup_week_id = @weekId) AS locks,
          (SELECT COUNT(*) FROM matchup_roster_players
           WHERE league_id = @leagueId) AS roster_players,
          (SELECT COUNT(*) FROM league_activity
           WHERE league_id = @leagueId
             AND event_type = 'matchup_fixture_scoring_play') AS plays
      `).get({
        leagueId: gamma.leagueId,
        weekId: gamma.sentinels.weekOneMatchups.weekId,
      }),
      { matchups: 7, locks: 14, roster_players: 252, plays: 14 }
    );

    const gammaMember = authenticate(
      started.runtime,
      manifest.accounts.gammaManagerOne.userId
    );
    const histories = gamma.teams.map((team) =>
      started.runtime.services.league.freeAgentDraftRead
        .publishedCardHistory({
          authenticated: gammaMember,
          leagueId: gamma.leagueId,
          fadId: gamma.fadId,
          teamId: team.teamId,
        })
    );
    for (const history of histories) {
      assert.equal(history.visibilityMode, "published_history");
      assert.equal(history.slots.length, 22);
      const outcomeCodes = history.slots
        .map(({ outcome }) => outcome?.code ?? null)
        .filter(Boolean);
      assert.equal(
        outcomeCodes.some((code) => code.endsWith("_win")),
        true
      );
      assert.equal(
        outcomeCodes.some((code) => code.endsWith("_loss")),
        true
      );
      assert.deepEqual(history.capabilities.editCard, {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      });
    }
    const winningHistory = histories.find(
      ({ teamId }) =>
        teamId ===
        gamma.sentinels.thirtyDollarThreeYearWinner.teamId
    );
    const thirtyDollarSlot = winningHistory.slots.find(
      ({ player }) =>
        player?.playerId ===
        gamma.sentinels.thirtyDollarThreeYearWinner.playerId
    );
    assert.deepEqual(
      {
        totalValueCents: thirtyDollarSlot.totalValueCents,
        termYears: thirtyDollarSlot.termYears,
        aavCents: thirtyDollarSlot.aavCents,
        outcomeCode: thirtyDollarSlot.outcome.code,
      },
      {
        totalValueCents: 3_000,
        termYears: 3,
        aavCents: 1_000,
        outcomeCode: "automatic_win",
      }
    );

    const firstHistory = histories[0];
    const firstCandidate = firstHistory.slots.find(
      ({ occupantKind }) => occupantKind === "candidate"
    );
    const firstEmpty = firstHistory.slots.find(
      ({ occupantKind }) => occupantKind === "empty"
    );
    const unusedPlayer = database.prepare(`
      SELECT player.id
      FROM players AS player
      JOIN player_source_state AS source
        ON source.player_id = player.id
       AND source.ended_at_ms IS NULL
       AND source.active = 1
       AND source.normalized_position = ?
      WHERE player.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM candidate_card_snapshot_entries AS entry
          WHERE entry.league_id = ? AND entry.fad_id = ?
            AND entry.player_id = player.id
        )
      ORDER BY lower(player.full_name), player.id
      LIMIT 1
    `).get(firstEmpty.slotGroup === "D" ? "D" : "F", gamma.leagueId, gamma.fadId);
    const mutationRevisionCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_card_revisions
      WHERE league_id = ? AND fad_id = ?
    `).get(gamma.leagueId, gamma.fadId).count;
    const mutationCommands = [
      ["add", () => started.runtime.services.league.candidateCards.addCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstHistory.teamId,
        slotKey: firstEmpty.slotKey,
        input: {
          playerId: unusedPlayer.id,
          aavCents: 100,
          termYears: 1,
        },
        expectedCardVersion: firstHistory.cardVersion,
        idempotencyKey: "gamma-completed-add-denied",
      })],
      ["edit", () => started.runtime.services.league.candidateCards.editCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstHistory.teamId,
        entryId: firstCandidate.entryId,
        input: { aavCents: 100, termYears: 2 },
        expectedCardVersion: firstHistory.cardVersion,
        idempotencyKey: "gamma-completed-edit-denied",
      })],
      ["move", () => started.runtime.services.league.candidateCards.moveEntry({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstHistory.teamId,
        entryId: firstCandidate.entryId,
        input: { slotKey: firstEmpty.slotKey },
        expectedCardVersion: firstHistory.cardVersion,
        idempotencyKey: "gamma-completed-move-denied",
      })],
      ["remove", () => started.runtime.services.league.candidateCards.removeCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstHistory.teamId,
        entryId: firstCandidate.entryId,
        expectedCardVersion: firstHistory.cardVersion,
        idempotencyKey: "gamma-completed-remove-denied",
      })],
      ["save", () => started.runtime.services.league.candidateCards.saveCard({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstHistory.teamId,
        input: {
          slots: firstHistory.slots.map((slot) => ({
            slotKey: slot.slotKey,
            candidate: slot.occupantKind === "candidate"
              ? {
                  playerId: slot.player.playerId,
                  aavCents: slot.aavCents,
                  termYears: slot.termYears,
                }
              : null,
          })),
        },
        expectedCardVersion: firstHistory.cardVersion,
        idempotencyKey: "gamma-completed-save-denied",
      })],
    ];
    for (const [name, command] of mutationCommands) {
      assert.throws(command, (error) => {
        const chain = [];
        for (let current = error; current; current = current.cause) {
          chain.push(current.code, current.details?.reasonCode);
        }
        assert.equal(
          chain.some((code) => [
            "FAD_PHASE_CONFLICT",
            "CANDIDATE_CARD_SUMMARY_DRIFT",
          ].includes(code)),
          true,
          `${name}: ${JSON.stringify(chain)}`
        );
        return true;
      });
    }
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_revisions
        WHERE league_id = ? AND fad_id = ?
      `).get(gamma.leagueId, gamma.fadId).count,
      mutationRevisionCount
    );
    assert.deepEqual(
      database.prepare(`
        SELECT event.evidence_json AS decision_json,
               outbox.payload_json AS outbox_json
        FROM free_agent_draft_player_allocations AS allocation
        JOIN free_agent_draft_allocation_events AS event
          ON event.league_id = allocation.league_id
         AND event.season_id = allocation.season_id
         AND event.fad_id = allocation.fad_id
         AND event.allocation_id = allocation.id
         AND event.allocation_version = allocation.version
         AND event.event_kind = 'decision_recorded'
        JOIN outbox_events AS outbox
          ON outbox.league_id = event.league_id
         AND outbox.id = json_extract(
           event.evidence_json,
           '$.sideEffects.outboxEventId'
         )
        WHERE allocation.league_id = ? AND allocation.fad_id = ?
          AND allocation.status = 'automatic_award'
        ORDER BY allocation.id LIMIT 1
      `).get(gamma.leagueId, gamma.fadId),
      immutableAwardBytes
    );

    const provider = database.prepare(`
      SELECT provider FROM stat_sources
      WHERE status = 'active'
      ORDER BY provider, id LIMIT 1
    `).get().provider;
    const scoreReads = gamma.sentinels.weekOneMatchups
      .scoreReadableMatchups.map(({ matchupId }) =>
        started.runtime.services.league.matchupScoring.readLive({
          leagueId: gamma.leagueId,
          seasonId: gamma.seasonId,
          weekId: gamma.sentinels.weekOneMatchups.weekId,
          matchupId,
          providers: [provider],
          nowMs: manifest.fixedNowMs,
        })
      );
    assert.equal(scoreReads.length, 7);
    assert.equal(
      scoreReads.every(
        ({ status, home, away }) =>
          status === "live" &&
          home.scoreHundredths > 0 &&
          away.scoreHundredths > 0
      ),
      true
    );
    assert.equal(
      new Set(scoreReads.flatMap(({ home, away }) => [
        home.scoreHundredths,
        away.scoreHundredths,
      ])).size > 1,
      true
    );

    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
    const protectedTriggers = database.prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
      ORDER BY name ASC
    `).all();
    assert.equal(triggerBaseline.length > 0, true);
    assert.deepEqual(
      protectedTriggers,
      triggerBaseline
    );
  }
);

test(
  "existing staging FAD pick inventory backfills in place without changing team identity or used picks",
  async (t) => {
    const started = await startRuntime(t);
    const database = started.runtime.database;
    seedRealPlayerCatalog(database);
    const manifest = await createFreeAgentDraftBrowserFixture({
      runtime: started.runtime,
    });
    const leagues = Object.values(manifest.leagues);
    const gammaTeam = manifest.leagues.gamma.teams[3];
    database.prepare(`
      UPDATE teams
      SET name = 'Golden Grizzlies',
          name_normalized = 'golden grizzlies',
          version = version + 1
      WHERE league_id = ? AND id = ?
    `).run(manifest.leagues.gamma.leagueId, gammaTeam.teamId);
    const authoritativePick = database.prepare(`
      SELECT id, current_owner_team_id, status, selection_id, version
      FROM draft_picks
      WHERE league_id = ? AND status <> 'unused'
      ORDER BY id
      LIMIT 1
    `).get(manifest.leagues.beta.leagueId);
    assert.ok(authoritativePick);

    const leagueIds = leagues.map(({ leagueId }) => leagueId);
    const placeholders = leagueIds.map(() => "?").join(", ");
    database.prepare(`
      DELETE FROM draft_picks
      WHERE league_id IN (${placeholders}) AND status = 'unused'
    `).run(...leagueIds);
    database.prepare(`
      DELETE FROM entry_drafts
      WHERE league_id IN (${placeholders}) AND status = 'setup'
    `).run(...leagueIds);
    database.prepare(`
      DELETE FROM seasons
      WHERE league_id IN (${placeholders})
        AND nhl_season_key = '20292030'
    `).run(...leagueIds);

    const first =
      backfillExistingFreeAgentDraftBrowserFixturePickInventory({
        runtime: started.runtime,
        fixtureNowMs: manifest.fixedNowMs + 1,
      });
    assert.deepEqual(
      first.leagues.map((league) => ({
        alias: league.alias,
        insertedPickCount: league.insertedPickCount,
        totalPickCount: league.totalPickCount,
        unusedPickCount: league.unusedPickCount,
      })),
      [
        {
          alias: "alpha",
          insertedPickCount: 128,
          totalPickCount: 128,
          unusedPickCount: 128,
        },
        {
          alias: "beta",
          insertedPickCount: 72,
          totalPickCount: 96,
          unusedPickCount: 72,
        },
        {
          alias: "gamma",
          insertedPickCount: 224,
          totalPickCount: 224,
          unusedPickCount: 224,
        },
      ]
    );
    assert.equal(
      database.prepare("SELECT name FROM teams WHERE id = ?")
        .get(gammaTeam.teamId).name,
      "Golden Grizzlies"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT id, current_owner_team_id, status, selection_id, version
        FROM draft_picks WHERE id = ?
      `).get(authoritativePick.id),
      authoritativePick
    );

    const second =
      backfillExistingFreeAgentDraftBrowserFixturePickInventory({
        runtime: started.runtime,
        fixtureNowMs: manifest.fixedNowMs + 2,
      });
    assert.deepEqual(
      second.leagues.map(({ insertedPickCount }) => insertedPickCount),
      [0, 0, 0]
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  }
);

test(
  "FAD browser fixture repeats stable aliases and facts on a fresh disposable runtime",
  async (t) => {
    const first = await startRuntime(t);
    seedRealPlayerCatalog(first.runtime.database);
    const firstManifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: first.runtime,
      });
    const firstFacts = repeatableFacts(firstManifest);
    await first.close();

    const second = await startRuntime(t);
    seedRealPlayerCatalog(second.runtime.database);
    const secondManifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: second.runtime,
      });
    assert.deepEqual(
      repeatableFacts(secondManifest),
      firstFacts
    );
    for (const league of
      Object.values(secondManifest.leagues)) {
      for (const team of league.teams) {
        assert.equal(UUID_PATTERN.test(team.cardId), true);
      }
      assertSentinelIds(league.sentinels);
    }
  }
);
