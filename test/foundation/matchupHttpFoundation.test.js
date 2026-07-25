const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createMatchupIntegrationService,
} = require("../../src/application/services/matchups/createMatchupIntegrationService");
const {
  createMatchupRouter,
  optionalIfMatch,
} = require("../../src/transport/http/createMatchupRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const SEASON_ID = "00000000-0000-4000-8000-000000000002";
const WEEK_ID = "00000000-0000-4000-8000-000000000003";
const MATCHUP_ID = "00000000-0000-4000-8000-000000000004";
const RESULT_ID = "00000000-0000-4000-8000-000000000005";
const HOME_ID = "00000000-0000-4000-8000-000000000006";
const AWAY_ID = "00000000-0000-4000-8000-000000000007";
const OPERATION_ID = "00000000-0000-4000-8000-000000000008";
const NOW_MS = 10_000;

function rawWeek() {
  return {
    id: WEEK_ID,
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: 1_000,
    baseline_at_ms: 2_000,
    locks_at_ms: 3_000,
    ends_at_ms: 20_000,
    rolls_over_at_ms: 21_000,
    status: "scheduled",
    version: 4,
  };
}

function rawMatchup() {
  return {
    id: MATCHUP_ID,
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    matchup_week_id: WEEK_ID,
    home_team_id: HOME_ID,
    away_team_id: AWAY_ID,
    home_team_name: "Home",
    away_team_name: "Away",
    status: "scheduled",
    version: 2,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: 1_000,
    locks_at_ms: 3_000,
    ends_at_ms: 20_000,
    week_status: "scheduled",
    week_version: 4,
  };
}

function integrationFixture({
  matchupRow = rawMatchup(),
  matchupResult = null,
  finalScore = null,
  liveScore = null,
} = {}) {
  const calls = [];
  const authority = {
    requireActiveMembership(authenticated, leagueId) {
      calls.push({ method: "member", authenticated, leagueId });
      return { actorUserId: "member" };
    },
    requireCommissioner(authenticated, leagueId) {
      calls.push({ method: "commissioner", authenticated, leagueId });
      return { actorUserId: "commissioner" };
    },
  };
  const schedule = {
    season: { id: SEASON_ID, nhl_season_key: "20262027", version: 3 },
    health: {
      latest: { status: "succeeded", started_at_ms: 8_000, completed_at_ms: 9_000 },
      latestSuccessful: { status: "succeeded", completed_at_ms: 9_000 },
    },
    weeks: [rawWeek()],
    matchups: [matchupRow],
    byes: [],
  };
  const readRepository = {
    readSchedule(input) {
      calls.push({ method: "readSchedule", input });
      return schedule;
    },
    readWeek(input) {
      calls.push({ method: "readWeek", input });
      return { week: rawWeek(), matchups: [matchupRow], byes: [] };
    },
    readMatchup(input) {
      calls.push({ method: "readMatchup", input });
      return { matchup: matchupRow, result: matchupResult };
    },
    readResultScope(input) {
      calls.push({ method: "readResultScope", input });
      return {
        result_id: RESULT_ID,
        result_version: 3,
        week_id: WEEK_ID,
        matchup_id: MATCHUP_ID,
      };
    },
  };
  const scheduleService = {
    preview(input) {
      calls.push({ method: "schedulePreview", input });
      return {
        context: { season_version: 3 },
        plan: {
          teamIds: [HOME_ID, AWAY_ID],
          firstWeekStartsAtMs: 1_000,
          weeks: [
            { pairs: [{ homeTeamId: HOME_ID, awayTeamId: AWAY_ID }], byeTeamId: null, endsAtMs: 20_000 },
          ],
        },
      };
    },
    generate(input) {
      calls.push({ method: "scheduleGenerate", input });
      return { weekCount: 1 };
    },
  };
  const weekService = {
    advance(input) {
      calls.push({ method: "weekAdvance", input });
      return { week: { status: "baseline_ready" } };
    },
  };
  const scoringService = {
    readAtRefresh(input) {
      calls.push({ method: "finalScore", input });
      if (finalScore) return finalScore;
      throw new Error("scheduled matchups do not score");
    },
    readLive(input) {
      calls.push({ method: "score", input });
      if (liveScore) return liveScore;
      throw new Error("scheduled matchups do not score");
    },
  };
  const resultService = {
    correct(input) {
      calls.push({ method: "correct", input });
      return { corrected: true };
    },
  };
  const standingsService = {
    read(input) {
      calls.push({ method: "standings", input });
      return {
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        finalizedResultCount: 0,
        sourceResultVersion: 0,
        rows: [],
      };
    },
  };
  const recoveryService = {
    previewStandings(input) {
      calls.push({ method: "standingsPreview", input });
      return {
        currentSnapshotId: null,
        expectedVersion: 1,
        nextSnapshotVersion: 1,
        projection: { rows: [] },
      };
    },
    rebuildStandings(input) {
      calls.push({ method: "standingsRebuild", input });
      return { rebuilt: true };
    },
  };
  const service = createMatchupIntegrationService({
    leagueAuthorization: authority,
    readRepository,
    scheduleService,
    weekService,
    scoringService,
    resultService,
    standingsService,
    recoveryService,
    clock: { nowMs: () => NOW_MS },
    createId: () => OPERATION_ID,
  });
  return { calls, service };
}

describe("M6-12 matchup HTTP integration service", () => {
  test("projects schedule, current week, week detail, matchup detail, health, and standings safely", () => {
    const { calls, service } = integrationFixture();
    const input = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    const list = service.listWeeks(input);
    const current = service.readCurrentWeek(input);
    const week = service.readWeek({ ...input, weekId: WEEK_ID });
    const matchup = service.readMatchup({ ...input, weekId: WEEK_ID, matchupId: MATCHUP_ID });
    const standings = service.readStandings(input);

    assert.equal(list.code, "MATCHUP_WEEKS_FOUND");
    assert.equal(list.weeks[0].matchups[0].homeTeam.name, "Home");
    assert.deepEqual(list.health.statistics, {
      status: "fresh",
      completedAtMs: 9_000,
      ageMs: 1_000,
    });
    assert.equal(current.week.id, WEEK_ID);
    assert.equal(week.week.version, 4);
    assert.equal(matchup.matchup.liveScore, null);
    assert.deepEqual(matchup.matchup.health.scoring, { status: "not_live" });
    assert.equal(standings.code, "MATCHUP_STANDINGS_FOUND");
    assert.equal(calls.filter(({ method }) => method === "member").length, 5);
    assert.equal(calls.some(({ method }) => method === "score"), false);
    assert.equal(JSON.stringify(list).includes("nhl_season_key"), false);
  });

  test("uses commissioner authority and explicit previews before all four writes", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.equal(
      service.generateSchedule({ ...base, input: { confirmed: false } }).code,
      "MATCHUP_SCHEDULE_PREVIEWED"
    );
    assert.equal(
      service.transitionWeek({ ...base, weekId: WEEK_ID, input: { confirmed: false } }).code,
      "MATCHUP_WEEK_TRANSITION_PREVIEWED"
    );
    assert.equal(
      service.correctResult({ ...base, resultId: RESULT_ID, input: { confirmed: false } }).code,
      "MATCHUP_RESULT_CORRECTION_PREVIEWED"
    );
    assert.equal(
      service.rebuildStandings({ ...base, input: { confirmed: false } }).code,
      "MATCHUP_STANDINGS_REBUILD_PREVIEWED"
    );
    assert.equal(calls.filter(({ method }) => method === "commissioner").length, 4);
    for (const method of ["scheduleGenerate", "weekAdvance", "correct", "standingsRebuild"]) {
      assert.equal(calls.some((call) => call.method === method), false, method);
    }
  });

  test("projects a finalized player breakdown from the result's exact statistics refresh", () => {
    const matchupRow = {
      ...rawMatchup(),
      status: "final",
      week_status: "final",
    };
    const matchupResult = {
      id: RESULT_ID,
      status: "official",
      version: 1,
      finalized_at_ms: 9_500,
      result_version_id: OPERATION_ID,
      version_number: 1,
      home_team_id: HOME_ID,
      away_team_id: AWAY_ID,
      home_score_hundredths: 325,
      away_score_hundredths: 0,
      outcome: "home_win",
      source_type: "calculated",
      reason: null,
      result_version_created_at_ms: 9_500,
      result_source_refresh_id: OPERATION_ID,
    };
    const player = {
      playerId: OPERATION_ID,
      fullName: "Fixture Player",
      positionGroup: "F",
      slotNumber: 1,
      gamesPlayedDelta: 2,
      goalDelta: 1,
      assistDelta: 2,
      pointDelta: 3,
      scoreHundredths: 325,
      dataStatus: "available",
    };
    const finalScore = {
      matchupId: MATCHUP_ID,
      status: "final",
      source: {
        refreshId: OPERATION_ID,
        completedAtMs: 9_000,
        ageMs: 1_000,
        freshnessStatus: "fresh",
      },
      home: {
        teamId: HOME_ID,
        legal: true,
        scoreHundredths: 325,
        players: [player],
      },
      away: {
        teamId: AWAY_ID,
        legal: false,
        scoreHundredths: 0,
        players: [],
      },
    };
    const { calls, service } = integrationFixture({
      matchupRow,
      matchupResult,
      finalScore,
    });
    const result = service.readMatchup({
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      weekId: WEEK_ID,
      matchupId: MATCHUP_ID,
      authenticated: { valid: true },
    });
    assert.equal(result.matchup.scoring.mode, "final");
    assert.equal(result.matchup.scoring.home.players[0].fullName, "Fixture Player");
    assert.equal(result.matchup.scoring.home.players[0].pointDelta, 3);
    assert.equal(
      calls.find(({ method }) => method === "finalScore").input.refreshId,
      OPERATION_ID
    );
    assert.equal(result.matchup.result.currentVersion.homeScoreHundredths, 325);
  });

  test("executes confirmed versioned writes with opaque authenticated authority", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.equal(
      service.generateSchedule({ ...base, expectedVersion: 3, input: { confirmed: true } }).code,
      "MATCHUP_SCHEDULE_GENERATED"
    );
    assert.equal(
      service.transitionWeek({
        ...base,
        weekId: WEEK_ID,
        expectedVersion: 4,
        idempotencyKey: OPERATION_ID,
        input: { confirmed: true },
      }).code,
      "MATCHUP_WEEK_TRANSITIONED"
    );
    assert.equal(
      service.correctResult({
        ...base,
        resultId: RESULT_ID,
        expectedVersion: 3,
        idempotencyKey: OPERATION_ID,
        input: {
          confirmed: true,
          homeScoreHundredths: 500,
          awayScoreHundredths: 400,
          reason: "Official provider correction",
        },
      }).code,
      "MATCHUP_RESULT_CORRECTED"
    );
    assert.equal(
      service.rebuildStandings({
        ...base,
        expectedVersion: 1,
        idempotencyKey: OPERATION_ID,
        input: {
          confirmed: true,
          expectedCurrentSnapshotId: null,
          reason: "Apply corrected official result",
        },
      }).code,
      "MATCHUP_STANDINGS_REBUILT"
    );
    assert.equal(calls.find(({ method }) => method === "correct").input.actorUserId, "commissioner");
    assert.equal(calls.find(({ method }) => method === "weekAdvance").input.operationId, OPERATION_ID);
  });

  test("rejects stale, unversioned, unconfirmed, and overposted write input before mutation", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.throws(
      () => service.generateSchedule({ ...base, expectedVersion: 2, input: { confirmed: true } }),
      { code: "MATCHUP_INTEGRATION_VERSION_CONFLICT" }
    );
    assert.throws(
      () => service.transitionWeek({ ...base, weekId: WEEK_ID, input: { confirmed: true } }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.throws(
      () => service.rebuildStandings({ ...base, input: { confirmed: false, reason: "extra" } }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.equal(calls.some(({ method }) => method === "scheduleGenerate"), false);
    assert.equal(calls.some(({ method }) => method === "weekAdvance"), false);
    assert.equal(calls.some(({ method }) => method === "standingsRebuild"), false);
  });
});

function requestSecurity(calls) {
  const session = { valid: true, user: { id: "user" }, session: { id: "session" } };
  return {
    assignRequestId(request, response, next) { request.testRequestId = "m6-12-request"; next(); },
    securityHeaders(request, response, next) { response.set("Cache-Control", "no-store"); next(); },
    credentialedCors(request, response, next) { next(); },
    requireAllowedOrigin(request, response, next) { next(); },
    requireJson(request, response, next) { next(); },
    requireCompatibleFetchMetadata(request, response, next) { next(); },
    authenticateBootstrap(request, response, next) {
      calls.push("authenticateBootstrap");
      if (request.get("x-test-session") !== "valid") {
        return response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      }
      return next();
    },
    authenticateUnsafe(request, response, next) {
      calls.push("authenticateUnsafe");
      if (request.get("x-test-session") !== "valid") {
        return response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      }
      if (request.get("x-test-csrf") !== "valid") {
        return response.status(403).json({ error: { code: "CSRF_REQUIRED" } });
      }
      return next();
    },
    getRequestId(request) { return request.testRequestId; },
    getSessionBootstrap() { return session; },
    getAuthenticatedSession() { return session; },
  };
}

function serviceStub(calls, overrides = {}) {
  return Object.fromEntries(
    [
      "correctResult",
      "generateSchedule",
      "listWeeks",
      "readCurrentWeek",
      "readMatchup",
      "readStandings",
      "readWeek",
      "rebuildStandings",
      "transitionWeek",
    ].map((method) => [
      method,
      overrides[method] || ((input) => {
        calls.push({ method, input });
        return { code: `${method.toUpperCase()}_OK` };
      }),
    ])
  );
}

async function startApi(t, service, securityCalls = []) {
  const app = express();
  app.use(createMatchupRouter({
    requestSecurity: requestSecurity(securityCalls),
    matchupService: service,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function authHeaders(extra = {}) {
  return { "x-test-session": "valid", ...extra };
}

function writeHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "x-test-session": "valid",
    "x-test-csrf": "valid",
    ...extra,
  };
}

describe("M6-12 isolated matchup HTTP contract", () => {
  test("routes all nine approved contracts with authenticated scope and request envelopes", async (t) => {
    const calls = [];
    const securityCalls = [];
    const baseUrl = await startApi(t, serviceStub(calls), securityCalls);
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}`;
    const responses = await Promise.all([
      fetch(`${base}/matchup-weeks`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/current`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}/matchups/${MATCHUP_ID}`, { headers: authHeaders() }),
      fetch(`${base}/standings`, { headers: authHeaders() }),
      fetch(`${base}/matchup-schedules`, {
        method: "POST", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}`, {
        method: "PATCH", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
      fetch(`${base}/matchup-results/${RESULT_ID}/corrections`, {
        method: "POST", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
      fetch(`${base}/standings/rebuilds`, {
        method: "POST", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), Array(9).fill(200));
    assert.equal(calls.length, 9);
    assert.deepEqual(
      calls.map(({ method }) => method).sort(),
      [
        "correctResult", "generateSchedule", "listWeeks", "readCurrentWeek", "readMatchup",
        "readStandings", "readWeek", "rebuildStandings", "transitionWeek",
      ].sort()
    );
    assert.deepEqual(securityCalls.sort(), [
      ...Array(5).fill("authenticateBootstrap"),
      ...Array(4).fill("authenticateUnsafe"),
    ].sort());
    const detail = calls.find(({ method }) => method === "readMatchup").input;
    assert.equal(detail.weekId, WEEK_ID);
    assert.equal(detail.matchupId, MATCHUP_ID);
    const correction = calls.find(({ method }) => method === "correctResult").input;
    assert.equal(correction.resultId, RESULT_ID);
    assert.deepEqual(correction.input, { confirmed: false });
  });

  test("blocks unauthenticated reads and writes without CSRF before service access", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, serviceStub(calls));
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}`;
    const unauthenticated = await fetch(`${base}/matchup-weeks`);
    const noCsrf = await fetch(`${base}/standings/rebuilds`, {
      method: "POST",
      headers: writeHeaders({ "x-test-csrf": "missing" }),
      body: JSON.stringify({ confirmed: false }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.length, 0);
  });

  test("passes version and idempotency preconditions and rejects malformed If-Match", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, serviceStub(calls));
    const url = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/matchup-weeks/${WEEK_ID}`;
    const valid = await fetch(url, {
      method: "PATCH",
      headers: writeHeaders({ "if-match": '"4"', "idempotency-key": OPERATION_ID }),
      body: JSON.stringify({ confirmed: true }),
    });
    const invalid = await fetch(url, {
      method: "PATCH",
      headers: writeHeaders({ "if-match": "4" }),
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(valid.status, 200);
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.expectedVersion, 4);
    assert.equal(calls[0].input.idempotencyKey, OPERATION_ID);
  });

  test("maps validation, authority, missing, stale, conflict, and internal failures safely", async (t) => {
    const cases = [
      ["MATCHUP_INTEGRATION_INPUT_INVALID", 400, "MATCHUP_INPUT_INVALID"],
      ["LEAGUE_COMMISSIONER_REQUIRED", 403, "MATCHUP_AUTHORITY_DENIED"],
      ["MATCHUP_INTEGRATION_MATCHUP_MISSING", 404, "MATCHUP_NOT_FOUND"],
      ["MATCHUP_INTEGRATION_VERSION_CONFLICT", 412, "MATCHUP_PRECONDITION_FAILED"],
      ["MATCHUP_WEEK_STATE_INVALID", 409, "MATCHUP_CONFLICT"],
      ["REPOSITORY_OPERATION_FAILED", 500, "MATCHUP_FAILED"],
    ];
    for (const [errorCode, status, publicCode] of cases) {
      const error = new Error("private database detail");
      error.code = errorCode;
      const baseUrl = await startApi(t, serviceStub([], {
        listWeeks() { throw error; },
      }));
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/matchup-weeks`,
        { headers: authHeaders() }
      );
      const body = await response.json();
      assert.equal(response.status, status, errorCode);
      assert.equal(body.error.code, publicCode, errorCode);
      assert.equal(JSON.stringify(body).includes("private database detail"), false);
    }
  });

  test("validates the isolated If-Match parser", () => {
    assert.deepEqual(optionalIfMatch({ get: () => undefined }), { valid: true, version: null });
    assert.deepEqual(optionalIfMatch({ get: () => '"12"' }), { valid: true, version: 12 });
    assert.deepEqual(optionalIfMatch({ get: () => "12" }), { valid: false, version: null });
  });
});
