"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BROWSER_FIXTURE_KIND,
  BROWSER_FIXTURE_SCHEMA_VERSION,
  FreeAgentDraftBrowserFixtureError,
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
  assertNoPriorFixture,
  assertStagingScope,
} = require(
  "../../scripts/create-staging-fad-test-leagues"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
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
            "notificationId",
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
      7 * 24 * 60 * 60 * 1_000
    );
  }
);

test(
  "FAD browser fixture rejects anything except an open schema-49 release-QA runtime",
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
    assert.doesNotMatch(
      source,
      /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|OR)\b/iu
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
    ]);
    for (const [leagueAlias, league] of
      Object.entries(manifest.leagues)) {
      const expectedTeamCount = leagueAlias === "alpha" ? 6 : 10;
      assert.equal(UUID_PATTERN.test(league.leagueId), true);
      assert.equal(UUID_PATTERN.test(league.seasonId), true);
      assert.equal(UUID_PATTERN.test(league.fadId), true);
      assert.equal(league.phase, "cards_open");
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
    }

    const alpha = manifest.leagues.alpha;
    const beta = manifest.leagues.beta;
    assert.equal(
      alpha.helpOpensAtMs > alpha.openedAtMs,
      true
    );
    assert.equal(
      beta.helpOpensAtMs > beta.openedAtMs,
      true
    );
    assert.equal(
      beta.firstWeekStartsAtMs -
        alpha.firstWeekStartsAtMs,
      7 * 24 * 60 * 60 * 1_000
    );
    assert.deepEqual(
      alpha.teams.slice(0, 2).map(
        ({ managerAccountAlias }) =>
          managerAccountAlias
      ),
      [
        "alphaMultiTeamManager",
        "alphaMultiTeamManager",
      ]
    );
    assert.equal(
      alpha.sentinels.lockedCarryover.teamAlias,
      "alphaTeam1"
    );
    assert.equal(
      alpha.sentinels.lockedCarryover.slotKey,
      "F01"
    );
    assert.match(
      alpha.sentinels.lockedCarryover.entryId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    assert.equal(
      alpha.sentinels.privateCandidates.length,
      3
    );
    assert.deepEqual(
      alpha.sentinels.privateCandidates.map(
        ({ alias, teamAlias, slotKey }) => ({
          alias,
          teamAlias,
          slotKey,
        })
      ),
      [
        {
          alias: "managedTeamCandidate",
          teamAlias: "alphaTeam1",
          slotKey: "F02",
        },
        {
          alias: "commissionerHelpCandidate",
          teamAlias: "alphaTeam3",
          slotKey: "D01",
        },
        {
          alias: "commissionerDeniedCandidate",
          teamAlias: "alphaTeam4",
          slotKey: "F01",
        },
      ]
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.teamAlias,
      "alphaTeam3"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.status,
      "not_open"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.helpOpensAtMs >
        manifest.fixedNowMs,
      true
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
      "D01"
    );
    assert.equal(
      manifest.privacyChecks.commissionerDeniedTeamAlias,
      "alphaTeam4"
    );
    assert.equal(
      manifest.privacyChecks.commissionerHelpTeamAlias,
      "alphaTeam3"
    );
    assert.equal(manifest.privacyChecks.privateMarkers.length, 5);
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
        WHERE league_id IN (?, ?)
        GROUP BY status
      `).all(alpha.leagueId, beta.leagueId),
      [{ status: "succeeded", count: 2 }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT trigger_kind, COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE league_id IN (?, ?)
        GROUP BY trigger_kind
      `).all(alpha.leagueId, beta.leagueId),
      [{ trigger_kind: "no_draft_inaugural", count: 2 }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM free_agent_drafts
           WHERE league_id IN (@alpha, @beta)) AS fads,
          (SELECT COUNT(*) FROM candidate_cards
           WHERE league_id IN (@alpha, @beta)) AS cards,
          (SELECT COUNT(*) FROM candidate_card_help_requests
           WHERE league_id IN (@alpha, @beta)) AS help_requests,
          (SELECT COUNT(*) FROM notifications
           WHERE league_id IN (@alpha, @beta)
             AND event_type = 'fad_cards_opened') AS card_ready
      `).get({
        alpha: alpha.leagueId,
        beta: beta.leagueId,
      }),
      {
        fads: 2,
        cards: 16,
        help_requests: 0,
        card_ready: 16,
      }
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
      "alphaTeam2",
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
      if (teamAlias === "alphaTeam1") {
        const carryover = card.slots.find(
          (slot) =>
            slot.entryId ===
            alpha.sentinels.lockedCarryover.entryId
        );
        assert.equal(carryover.occupantKind, "carryover");
        assert.equal(carryover.locked, true);
      }
    }
    const deniedAlphaTeam = alpha.teams.find(
      ({ alias }) => alias === "alphaTeam3"
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
        assert.equal(
          String(error.message).includes(
            alpha.sentinels.exactCommissionerHelp
              .privatePlayerFullName
          ),
          false
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
        assert.equal(
          String(error.message).includes(
            alpha.sentinels.privateCandidates.find(
              ({ alias }) => alias === "commissionerDeniedCandidate"
            ).playerFullName
          ),
          false
        );
        return true;
      }
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
  "FAD browser fixture repeats stable aliases and facts on a fresh disposable runtime",
  async (t) => {
    const first = await startRuntime(t);
    const firstManifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: first.runtime,
      });
    const firstFacts = repeatableFacts(firstManifest);
    await first.close();

    const second = await startRuntime(t);
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
