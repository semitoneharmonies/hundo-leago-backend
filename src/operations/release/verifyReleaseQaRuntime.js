const crypto = require("node:crypto");

const {
  ACCOUNT_ALIASES,
  canonicalize,
  fixtureEmail,
  fixtureId,
} = require("./releaseQaFixtureContract");

class ReleaseQaRuntimeVerificationError extends Error {
  constructor(checkId, message) {
    super(message);
    this.name = "ReleaseQaRuntimeVerificationError";
    this.code = "RELEASE_QA_RUNTIME_VERIFICATION_FAILED";
    this.checkId = checkId;
  }
}

function fail(checkId, message) {
  throw new ReleaseQaRuntimeVerificationError(checkId, message);
}

function validateInput({ baseUrl, frontendOrigin, password }) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail("input", "The release-QA runtime URL is invalid.");
  }
  if (
    parsed.origin !== baseUrl ||
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1"
  ) {
    fail("input", "The release-QA runtime must use an exact loopback origin.");
  }
  if (typeof frontendOrigin !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):517[34]$/.test(frontendOrigin)) {
    fail("input", "The release-QA frontend origin is invalid.");
  }
  if (typeof password !== "string" || password === "") {
    fail("input", "The release-QA password is required.");
  }
}

function browserHeaders(frontendOrigin, extra = {}) {
  return {
    Accept: "application/json",
    Origin: frontendOrigin,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

async function readResponse(response) {
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // The caller will fail with a safe contract error.
    }
  }
  return Object.freeze({
    json,
    status: response.status,
    setCookie: response.headers.get("set-cookie"),
  });
}

async function request(baseUrl, frontendOrigin, requestPath, {
  body,
  cookie,
  csrfToken,
  headers = {},
  method = "GET",
  origin = frontendOrigin,
} = {}) {
  const hasBody = body !== undefined;
  const response = await fetch(new URL(requestPath, baseUrl), {
    method,
    headers: browserHeaders(origin, {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...headers,
    }),
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  return readResponse(response);
}

function expectStatus(checkId, response, status) {
  if (response.status !== status) {
    fail(checkId, `Release-QA check expected HTTP ${status} and received ${response.status}.`);
  }
  return response.json;
}

async function signIn(baseUrl, frontendOrigin, alias, password) {
  const response = await request(baseUrl, frontendOrigin, "/api/v1/session", {
    method: "POST",
    body: { email: fixtureEmail(alias), password },
  });
  const json = expectStatus(`sign-in:${alias}`, response, 200);
  const cookie = response.setCookie?.split(";", 1)[0];
  if (
    typeof cookie !== "string" ||
    !/^hl_session=[A-Za-z0-9_-]{43}$/.test(cookie) ||
    typeof json?.data?.csrfToken !== "string"
  ) {
    fail(`sign-in:${alias}`, "Release-QA sign-in returned an invalid session contract.");
  }
  return Object.freeze({
    alias,
    cookie,
    csrfToken: json.data.csrfToken,
  });
}

async function signOut(baseUrl, frontendOrigin, session) {
  const response = await request(baseUrl, frontendOrigin, "/api/v1/session", {
    method: "DELETE",
    body: {},
    cookie: session.cookie,
    csrfToken: session.csrfToken,
  });
  expectStatus(`sign-out:${session.alias}`, response, 200);
}

function visibleLeagueIds(json) {
  const leagues = json?.data?.leagues;
  if (!Array.isArray(leagues)) return null;
  return leagues.map(({ id }) => id);
}

async function verifyNoMembership(baseUrl, frontendOrigin, password) {
  const session = await signIn(
    baseUrl,
    frontendOrigin,
    "verifiedWithoutMembership",
    password
  );
  try {
    const bootstrap = await request(baseUrl, frontendOrigin, "/api/v1/session", {
      cookie: session.cookie,
    });
    expectStatus("session-bootstrap", bootstrap, 200);
    const leagues = await request(baseUrl, frontendOrigin, "/api/v1/leagues", {
      cookie: session.cookie,
    });
    expectStatus("no-membership", leagues, 200);
    if (visibleLeagueIds(leagues.json)?.length !== 0) {
      fail("no-membership", "The verified no-membership account saw a league.");
    }
  } finally {
    await signOut(baseUrl, frontendOrigin, session);
  }
}

async function verifyManagerScope(baseUrl, frontendOrigin, alias, visibleAlias, hiddenAlias, password) {
  const session = await signIn(baseUrl, frontendOrigin, alias, password);
  const visibleLeagueId = fixtureId(`league:${visibleAlias}`);
  const hiddenLeagueId = fixtureId(`league:${hiddenAlias}`);
  try {
    const leagues = await request(baseUrl, frontendOrigin, "/api/v1/leagues", {
      cookie: session.cookie,
    });
    expectStatus(`league-list:${alias}`, leagues, 200);
    const ids = visibleLeagueIds(leagues.json);
    if (ids?.length !== 1 || ids[0] !== visibleLeagueId) {
      fail(`league-list:${alias}`, "A release-QA manager received the wrong league scope.");
    }
    expectStatus(
      `visible-league:${alias}`,
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${visibleLeagueId}`, {
        cookie: session.cookie,
      }),
      200
    );
    expectStatus(
      `hidden-league:${alias}`,
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${hiddenLeagueId}`, {
        cookie: session.cookie,
      }),
      404
    );
    const teams = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/leagues/${visibleLeagueId}/teams`,
      { cookie: session.cookie }
    );
    const teamsJson = expectStatus(`teams:${alias}`, teams, 200);
    const visibleTeams = teamsJson?.data?.teams;
    if (!Array.isArray(visibleTeams) || visibleTeams.length !== 6) {
      fail(`teams:${alias}`, "The release-QA league did not expose all six teams.");
    }
    const firstTeamId = visibleTeams[0]?.id;
    if (typeof firstTeamId !== "string") {
      fail(`teams:${alias}`, "The release-QA team identity was unavailable.");
    }
    expectStatus(
      `team:${alias}`,
      await request(
        baseUrl,
        frontendOrigin,
        `/api/v1/leagues/${visibleLeagueId}/teams/${firstTeamId}`,
        { cookie: session.cookie }
      ),
      200
    );
    const roster = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/public/leagues/${visibleLeagueId}/teams/${firstTeamId}/roster`
    );
    const rosterJson = expectStatus(`roster:${alias}`, roster, 200);
    const rosterTeam = rosterJson?.data?.roster?.team;
    if (
      rosterTeam?.id !== firstTeamId ||
      !/^#[0-9a-f]{6}$/.test(rosterTeam.primaryColour || "") ||
      !/^#[0-9a-f]{6}$/.test(rosterTeam.secondaryColour || "")
    ) {
      fail(
        `roster:${alias}`,
        "The release-QA public roster returned unusable team presentation data."
      );
    }
    const players = await request(
      baseUrl,
      frontendOrigin,
      "/api/v1/players?query=fixture%20player%2001&limit=5",
      { cookie: session.cookie }
    );
    const playersJson = expectStatus(`players:${alias}`, players, 200);
    const visiblePlayers = playersJson?.data;
    const firstPlayer = visiblePlayers?.[0];
    if (
      !Array.isArray(visiblePlayers) ||
      visiblePlayers.length !== 1 ||
      firstPlayer?.fullName !== "Fixture Player 01" ||
      playersJson?.page?.hasMore !== false
    ) {
      fail(
        `players:${alias}`,
        "The release-QA player search returned an invalid page."
      );
    }
    const playerDetail = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/players/${firstPlayer.id}`,
      { cookie: session.cookie }
    );
    const playerDetailJson = expectStatus(
      `player-detail:${alias}`,
      playerDetail,
      200
    );
    if (
      playerDetailJson?.data?.id !== firstPlayer.id ||
      playerDetailJson?.data?.externalIds?.[0]?.provider !== "release_qa"
    ) {
      fail(
        `player-detail:${alias}`,
        "The release-QA player detail returned an invalid projection."
      );
    }
    expectStatus(
      `auctions:${alias}`,
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${visibleLeagueId}/auctions`, {
        cookie: session.cookie,
      }),
      200
    );
    expectStatus(
      `trades:${alias}`,
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${visibleLeagueId}/trades`, {
        cookie: session.cookie,
      }),
      200
    );
    const seasonId = fixtureId(`season:${visibleAlias}:current`);
    expectStatus(
      `matchup:${alias}`,
      await request(
        baseUrl,
        frontendOrigin,
        `/api/v1/leagues/${visibleLeagueId}/seasons/${seasonId}/matchup-weeks/current`,
        { cookie: session.cookie }
      ),
      200
    );
    const standings = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/leagues/${visibleLeagueId}/seasons/${seasonId}/standings`,
      { cookie: session.cookie }
    );
    const standingsJson = expectStatus(`standings:${alias}`, standings, 200);
    if (standingsJson?.data?.rows?.length !== 6) {
      fail(
        `standings:${alias}`,
        "The release-QA standings omitted registered season participants."
      );
    }

    const deniedWrite = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/leagues/${hiddenLeagueId}/teams/${fixtureId(`team:${hiddenAlias}:1`)}`,
      {
        method: "PATCH",
        body: { primaryColour: "#ffffff", secondaryColour: "#000000" },
        cookie: session.cookie,
        csrfToken: session.csrfToken,
        headers: {
          "If-Match": '"1"',
          "Idempotency-Key": `m7-release-qa-cross-league-${alias}`,
        },
      }
    );
    if (![403, 404].includes(deniedWrite.status)) {
      fail(`hidden-write:${alias}`, "A cross-league write did not fail closed.");
    }
  } finally {
    await signOut(baseUrl, frontendOrigin, session);
  }
}

async function verifyCommissioner(baseUrl, frontendOrigin, password) {
  const session = await signIn(baseUrl, frontendOrigin, "leagueACommissioner", password);
  const leagueId = fixtureId("league:leagueA");
  try {
    expectStatus(
      "commissioner-memberships",
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${leagueId}/memberships`, {
        cookie: session.cookie,
      }),
      200
    );
    expectStatus(
      "commissioner-activity",
      await request(baseUrl, frontendOrigin, `/api/v1/leagues/${leagueId}/activity`, {
        cookie: session.cookie,
      }),
      200
    );
    const notifications = await request(baseUrl, frontendOrigin, "/api/v1/notifications", {
      cookie: session.cookie,
    });
    expectStatus("commissioner-notifications", notifications, 200);
    const notificationId = notifications.json?.data?.notifications?.[0]?.id;
    if (typeof notificationId !== "string") {
      fail("commissioner-notifications", "The release-QA notification was unavailable.");
    }
    expectStatus(
      "commissioner-csrf-denial",
      await request(baseUrl, frontendOrigin, `/api/v1/notifications/${notificationId}/read`, {
        method: "POST",
        body: {},
        cookie: session.cookie,
        csrfToken: "invalid",
      }),
      403
    );
    expectStatus(
      "commissioner-notification-write",
      await request(baseUrl, frontendOrigin, `/api/v1/notifications/${notificationId}/read`, {
        method: "POST",
        body: {},
        cookie: session.cookie,
        csrfToken: session.csrfToken,
      }),
      200
    );
    expectStatus(
      "commissioner-operations-denial",
      await request(baseUrl, frontendOrigin, "/api/v1/operations/health", {
        cookie: session.cookie,
      }),
      403
    );
    const auctions = await request(
      baseUrl,
      frontendOrigin,
      `/api/v1/leagues/${leagueId}/auctions`,
      { cookie: session.cookie }
    );
    expectStatus("commissioner-sealed-auction", auctions, 200);
    const serialized = JSON.stringify(auctions.json);
    if (/totalValueCents|lowestOfferedAavCents|firstSubmittedAtMs/.test(serialized)) {
      fail("commissioner-sealed-auction", "A commissioner response exposed sealed bid values.");
    }
  } finally {
    await signOut(baseUrl, frontendOrigin, session);
  }
}

async function verifyAdministrator(baseUrl, frontendOrigin, password, expectedWriteMode) {
  const session = await signIn(baseUrl, frontendOrigin, "platformAdmin", password);
  try {
    const leagues = await request(baseUrl, frontendOrigin, "/api/v1/leagues", {
      cookie: session.cookie,
    });
    expectStatus("administrator-league-memberships", leagues, 200);
    const visibleIds = visibleLeagueIds(leagues.json);
    const expectedIds = [
      fixtureId("league:leagueA"),
      fixtureId("league:leagueB"),
    ].sort();
    if (
      JSON.stringify([...(visibleIds || [])].sort()) !==
      JSON.stringify(expectedIds)
    ) {
      fail(
        "administrator-league-memberships",
        "The platform administrator did not receive both explicit fixture memberships."
      );
    }
    const visibleLeagues = leagues.json?.data?.leagues;
    if (
      !Array.isArray(visibleLeagues) ||
      visibleLeagues.some(
        (league) =>
          league.membership?.permissionCategory !== "member" ||
          league.membership?.effectiveAuthority !==
            "platform_administrator"
      )
    ) {
      fail(
        "administrator-league-memberships",
        "The administrator's explicit memberships did not project inherited platform authority."
      );
    }
    for (const leagueId of expectedIds) {
      expectStatus(
        "administrator-commissioner-inheritance",
        await request(
          baseUrl,
          frontendOrigin,
          `/api/v1/leagues/${leagueId}/memberships`,
          { cookie: session.cookie }
        ),
        200
      );
    }
    const operations = await request(baseUrl, frontendOrigin, "/api/v1/operations/health", {
      cookie: session.cookie,
    });
    expectStatus("administrator-operations-health", operations, 200);
    if (
      operations.json?.data?.scheduler?.state !== "disabled" ||
      operations.json?.data?.maintenance?.state !== expectedWriteMode ||
      operations.json?.data?.schemaVersion !== 18
    ) {
      fail("administrator-operations-health", "Operations health did not report the release-QA controls.");
    }
  } finally {
    await signOut(baseUrl, frontendOrigin, session);
  }
}

async function verifyReleaseQaRuntime({
  baseUrl,
  expectedWriteMode = "open",
  fixtureManifestChecksum,
  frontendOrigin,
  password,
} = {}) {
  validateInput({ baseUrl, frontendOrigin, password });
  if (!new Set(["closed", "open"]).has(expectedWriteMode)) {
    fail("input", "The expected release-QA write mode is invalid.");
  }
  if (typeof fixtureManifestChecksum !== "string" || !/^[0-9a-f]{64}$/.test(fixtureManifestChecksum)) {
    fail("input", "The release-QA fixture manifest checksum is invalid.");
  }

  const live = await fetch(new URL("/api/v1/health/live", baseUrl));
  const liveBody = await readResponse(live);
  expectStatus("public-live-health", liveBody, 200);
  if (liveBody.json?.data?.status !== "live") {
    fail("public-live-health", "Public liveness was not live.");
  }
  const ready = await fetch(new URL("/api/v1/health/ready", baseUrl));
  const readyBody = await readResponse(ready);
  expectStatus("public-ready-health", readyBody, 200);
  if (readyBody.json?.data?.status !== "ready") {
    fail("public-ready-health", "Public readiness was not ready.");
  }

  expectStatus(
    "origin-denial",
    await request(baseUrl, frontendOrigin, "/api/v1/session", {
      method: "POST",
      body: { email: fixtureEmail("platformAdmin"), password },
      origin: "https://not-allowed.example.test",
    }),
    403
  );
  for (const alias of ["pendingVerification", "deactivated"]) {
    expectStatus(
      `account-state:${alias}`,
      await request(baseUrl, frontendOrigin, "/api/v1/session", {
        method: "POST",
        body: { email: fixtureEmail(alias), password },
      }),
      401
    );
  }

  await verifyNoMembership(baseUrl, frontendOrigin, password);
  await verifyManagerScope(
    baseUrl,
    frontendOrigin,
    "leagueAManagerOne",
    "leagueA",
    "leagueB",
    password
  );
  await verifyManagerScope(
    baseUrl,
    frontendOrigin,
    "leagueBManagerOne",
    "leagueB",
    "leagueA",
    password
  );
  await verifyCommissioner(baseUrl, frontendOrigin, password);
  await verifyAdministrator(baseUrl, frontendOrigin, password, expectedWriteMode);

  const reportWithoutChecksum = Object.freeze({
    reportVersion: 1,
    fixtureManifestChecksum,
    accountAliasCount: ACCOUNT_ALIASES.length,
    checks: Object.freeze({
      accountStates: "passed",
      administratorLeagueAuthority: "passed",
      authenticationAndReload: "passed",
      commissionerBidPrivacy: "passed",
      csrfAndAuthorizedWrite: "passed",
      health: "passed",
      jobsDisabled: "passed",
      operationsAuthorization: "passed",
      originEnforcement: "passed",
      representativeReads: "passed",
      sessionLifecycle: "passed",
      twoLeagueIsolation: "passed",
    }),
    controls: Object.freeze({
      backendBinding: "loopback",
      email: "capture-only",
      providerNetwork: "disabled",
      scheduledJobs: "disabled",
      writeMode: expectedWriteMode,
    }),
  });
  return Object.freeze({
    ...reportWithoutChecksum,
    reportChecksum: crypto.createHash("sha256")
      .update(canonicalize(reportWithoutChecksum))
      .digest("hex"),
  });
}

module.exports = {
  ReleaseQaRuntimeVerificationError,
  browserHeaders,
  verifyReleaseQaRuntime,
};
