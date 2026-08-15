"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createAndActivateFixtureCandidate,
  replaceFixtureCredentials,
} = require(
  "../../scripts/create-staging-fad-test-leagues"
);
const {
  isStagingAccountAutoVerificationEnabled,
} = require(
  "../../src/bootstrap/openDeployedTargetRuntime"
);
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);
const {
  createScryptPasswordHasher,
} = require(
  "../../src/infrastructure/security/createScryptPasswordHasher"
);
const {
  createSecureRandom,
} = require(
  "../../src/infrastructure/security/createSecureRandom"
);
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  createReleaseQaRuntime,
} = require(
  "../../src/operations/release/createReleaseQaRuntime"
);
const {
  FIXTURE_NOW_MS,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  SESSION_COOKIE_PATTERN,
} = require(
  "../../src/operations/release/verifyReleaseQaRuntime"
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
const ORIGINAL_FIXTURE_PASSWORD = "hundo";
const ROTATED_TEST_PASSWORD =
  "Staging FAD acceptance password 2026!";
const REGISTRATION_EMAIL =
  "staging.self-service@release-qa.example.test";
const REGISTRATION_PASSWORD =
  "Staging registration password 2026!";

function seedRealPlayerCatalog(database) {
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIRECTORY, "players.json"),
      "utf8"
    )
  );
  const selected = [
    ...catalog
      .filter(
        ({ active, position }) =>
          active === true && position === "F"
      )
      .slice(0, 500),
    ...catalog
      .filter(
        ({ active, position }) =>
          active === true && position === "D"
      )
      .slice(0, 300),
  ];
  let idCounter = 0;
  const repository =
    createSqlitePlayerCatalogRepository({
      database,
      createId: () =>
        `30000000-0000-4000-8000-${String(
          ++idCounter
        ).padStart(12, "0")}`,
      now: () => 1_700_000_000_100,
    });
  repository.applyCatalog({
    sourceOperationId:
      "20000000-0000-4000-8000-000000000001",
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
      nhlTeamAbbreviation:
        player.teamAbbrev ?? null,
      active: true,
      sourceVersion: "players-json-2026",
      sourceUpdatedAtMs: 1_700_000_000_000,
    })),
  });
}

function browserHeaders(extra = {}) {
  return {
    Accept: "application/json",
    Origin: FRONTEND_ORIGIN,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

async function requestJson(
  started,
  requestPath,
  {
    body,
    cookie,
    csrfToken,
    method = "GET",
  } = {}
) {
  const hasBody = body !== undefined;
  const response = await fetch(
    new URL(requestPath, started.baseUrl),
    {
      method,
      headers: browserHeaders({
        ...(hasBody
          ? { "Content-Type": "application/json" }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken
          ? { "X-CSRF-Token": csrfToken }
          : {}),
      }),
      ...(hasBody
        ? { body: JSON.stringify(body) }
        : {}),
    }
  );
  const text = await response.text();
  assert.equal(
    text.includes(ROTATED_TEST_PASSWORD),
    false
  );
  assert.equal(
    text.includes(REGISTRATION_PASSWORD),
    false
  );
  return Object.freeze({
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
    status: response.status,
    text,
  });
}

function sessionFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  const cookie =
    typeof setCookie === "string"
      ? setCookie.split(";", 1)[0]
      : "";
  const csrfToken = response.json?.data?.csrfToken;
  assert.equal(
    SESSION_COOKIE_PATTERN.test(cookie),
    true
  );
  assert.equal(
    /^[A-Za-z0-9_-]{43}$/.test(csrfToken || ""),
    true
  );
  return Object.freeze({ cookie, csrfToken });
}

async function signIn(started, email, password) {
  const response = await requestJson(
    started,
    "/api/v1/session",
    {
      method: "POST",
      body: { email, password },
    }
  );
  assert.equal(response.status, 200);
  return Object.freeze({
    response,
    session: sessionFrom(response),
  });
}

function sorted(values) {
  return [...values].sort();
}

test(
  "staging FAD accounts authenticate with rotated credentials and self-service registration remains usable",
  async (t) => {
    const started = await createReleaseQaRuntime({
      frontendOrigin: FRONTEND_ORIGIN,
      leagueWriteMode: "open",
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      password: ORIGINAL_FIXTURE_PASSWORD,
      port: 0,
    });
    t.after(() => started.close());
    assert.equal(
      started.runtime.database.pragma("user_version", {
        simple: true,
      }),
      51
    );
    assert.equal(
      isStagingAccountAutoVerificationEnabled({
        ...started.runtime.runtimeConfig,
        databaseId:
          started.runtime.databaseIdentity.databaseId,
        security: started.runtime.securityConfig,
      }),
      true
    );

    seedRealPlayerCatalog(started.runtime.database);
    const secureRandom = createSecureRandom();
    const passwordHasher =
      createScryptPasswordHasher({ secureRandom });
    const replacement =
      await createAndActivateFixtureCandidate({
      database: started.runtime.database,
      nowMs: FIXTURE_NOW_MS,
      createFixture: () =>
        createFreeAgentDraftBrowserFixture({
          runtime: started.runtime,
          nowMs: FIXTURE_NOW_MS,
        }),
      replaceCredentials: ({ accounts }) =>
        replaceFixtureCredentials({
          accounts,
          password: ROTATED_TEST_PASSWORD,
          passwordHasher,
          credentialRepository:
            started.runtime.repositories.credentials,
          sessionRepository:
            started.runtime.repositories.sessions,
          createId: () => secureRandom.id(),
          nowMs: FIXTURE_NOW_MS,
        }),
    });

    assert.equal(replacement.hiddenLegacyLeagueCount, 2);
    assert.equal(replacement.accounts.length, 6);
    assert.equal(
      replacement.credentialReplacement
        .rotatedAccountCount,
      replacement.accounts.length
    );

    const rejectedOldPassword = await requestJson(
      started,
      "/api/v1/session",
      {
        method: "POST",
        body: {
          email: replacement.accounts[0].email,
          password: ORIGINAL_FIXTURE_PASSWORD,
        },
      }
    );
    assert.equal(rejectedOldPassword.status, 401);
    assert.equal(
      rejectedOldPassword.json?.error?.code,
      "SIGN_IN_FAILED"
    );

    const leagueByAlias = new Map(
      Object.entries(replacement.manifest.leagues)
    );
    for (const account of replacement.accounts) {
      const signedIn = await signIn(
        started,
        account.email,
        ROTATED_TEST_PASSWORD
      );
      assert.equal(
        signedIn.response.json?.data?.user?.id,
        account.userId
      );
      const leaguesResponse = await requestJson(
        started,
        "/api/v1/leagues",
        { cookie: signedIn.session.cookie }
      );
      assert.equal(leaguesResponse.status, 200);
      const visibleLeagues =
        leaguesResponse.json?.data?.leagues;
      assert.equal(Array.isArray(visibleLeagues), true);
      const expectedLeagueIds = account.leagueAccess.map(
        ({ leagueAlias }) =>
          leagueByAlias.get(leagueAlias).leagueId
      );
      assert.deepEqual(
        sorted(
          visibleLeagues.map(({ id }) => id)
        ),
        sorted(expectedLeagueIds)
      );

      for (const access of account.leagueAccess) {
        const league = leagueByAlias.get(
          access.leagueAlias
        );
        const visible = visibleLeagues.find(
          ({ id }) => id === league.leagueId
        );
        assert.equal(Boolean(visible), true);
        const permissionCategory =
          account.platformAdministrator
            ? "member"
            : access.commissioner
              ? "commissioner"
              : "manager";
        const effectiveAuthority =
          account.platformAdministrator
            ? "platform_administrator"
            : permissionCategory;
        assert.equal(
          visible.membership.permissionCategory,
          permissionCategory
        );
        assert.equal(
          visible.membership.effectiveAuthority,
          effectiveAuthority
        );

        const teamsResponse = await requestJson(
          started,
          `/api/v1/leagues/${league.leagueId}/teams`,
          { cookie: signedIn.session.cookie }
        );
        assert.equal(teamsResponse.status, 200);
        const teams = teamsResponse.json?.data?.teams;
        assert.equal(Array.isArray(teams), true);
        assert.equal(teams.length, league.teams.length);
        for (const expectedTeam of league.teams) {
          const actualTeam = teams.find(
            ({ id }) => id === expectedTeam.teamId
          );
          assert.equal(Boolean(actualTeam), true);
          assert.equal(
            actualTeam.currentManager?.userId,
            replacement.manifest.accounts[
              expectedTeam.managerAccountAlias
            ].userId
          );
        }
        const teamByAlias = new Map(
          league.teams.map((team) => [team.alias, team])
        );
        const expectedManagedTeamIds =
          access.managedTeamAliases.map(
            (teamAlias) =>
              teamByAlias.get(teamAlias).teamId
          );
        const actualManagedTeamIds = teams
          .filter(
            (team) =>
              team.currentManager?.userId ===
              account.userId
          )
          .map(({ id }) => id);
        assert.deepEqual(
          sorted(actualManagedTeamIds),
          sorted(expectedManagedTeamIds)
        );
      }
    }

    const registration = await requestJson(
      started,
      "/api/v1/accounts",
      {
        method: "POST",
        body: {
          email: REGISTRATION_EMAIL,
          displayName: "Staging Self-Service Tester",
          password: REGISTRATION_PASSWORD,
          passwordConfirmation:
            REGISTRATION_PASSWORD,
        },
      }
    );
    assert.equal(registration.status, 202);
    assert.deepEqual(registration.json?.data, {
      accepted: true,
    });

    const delivery =
      await started.runtime.services.accountEmail
        .deliveryService.deliverDue();
    assert.equal(delivery.length, 1);
    const captured =
      started.runtime.services.accountEmail.adapter
        .listCaptured()
        .find(({ to }) => to === REGISTRATION_EMAIL);
    assert.equal(Boolean(captured), true);
    const verificationLink = new URL(
      captured.verificationUrl
    );
    const rawVerificationToken =
      verificationLink.hash.slice("#token=".length);
    assert.equal(
      /^[A-Za-z0-9_-]{43}$/.test(
        rawVerificationToken
      ),
      true
    );

    const verification = await requestJson(
      started,
      "/api/v1/accounts/email-verifications",
      {
        method: "POST",
        body: { token: rawVerificationToken },
      }
    );
    assert.equal(verification.status, 200);
    assert.equal(
      verification.text.includes(
        rawVerificationToken
      ),
      false
    );
    assert.equal(
      verification.json?.data?.user?.status,
      "active"
    );
    const verificationSession =
      sessionFrom(verification);

    const signOut = await requestJson(
      started,
      "/api/v1/session",
      {
        method: "DELETE",
        body: {},
        cookie: verificationSession.cookie,
        csrfToken:
          verificationSession.csrfToken,
      }
    );
    assert.equal(signOut.status, 200);

    const registeredSignIn = await signIn(
      started,
      REGISTRATION_EMAIL,
      REGISTRATION_PASSWORD
    );
    const registeredLeagues = await requestJson(
      started,
      "/api/v1/leagues",
      { cookie: registeredSignIn.session.cookie }
    );
    assert.equal(registeredLeagues.status, 200);
    assert.deepEqual(
      registeredLeagues.json?.data?.leagues,
      []
    );
  }
);
