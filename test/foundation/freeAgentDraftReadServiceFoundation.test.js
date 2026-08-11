"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createFreeAgentDraftReadService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftReadService"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const SEASON_ID =
  "22222222-2222-4222-8222-222222222222";
const TEAM_ID =
  "33333333-3333-4333-8333-333333333333";
const FAD_ID =
  "44444444-4444-4444-8444-444444444444";
const USER_ID =
  "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ID =
  "66666666-6666-4666-8666-666666666666";
const NOW_MS = 1_790_000_000_000;
const AUTHENTICATED = Object.freeze({
  session: true,
});

function harness({
  nowMs = NOW_MS,
  result = Object.freeze({ projection: true }),
  collectionResult = Object.freeze({
    data: Object.freeze([]),
    page: Object.freeze({
      nextCursor: null,
      hasMore: false,
    }),
  }),
  authorizationError = null,
} = {}) {
  const calls = [];
  const authority = Object.freeze({
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
  });
  const leagueAuthorization = {
    requireActiveMembership(authenticated, leagueId) {
      calls.push([
        "requireActiveMembership",
        authenticated,
        leagueId,
      ]);
      if (authorizationError) throw authorizationError;
      return authority;
    },
    requireCommissioner(authenticated, leagueId) {
      calls.push([
        "requireCommissioner",
        authenticated,
        leagueId,
      ]);
      if (authorizationError) throw authorizationError;
      return authority;
    },
  };
  const repository = {
    readAllocationResults(input) {
      calls.push(["readAllocationResults", input]);
      return collectionResult;
    },
    readNavigation(input) {
      calls.push(["readNavigation", input]);
      return result;
    },
    readReadiness(input) {
      calls.push(["readReadiness", input]);
      return result;
    },
    readOverview(input) {
      calls.push(["readOverview", input]);
      return result;
    },
    readPublishedCardHistory(input) {
      calls.push([
        "readPublishedCardHistory",
        input,
      ]);
      return result;
    },
    readPublishedCardSummaries(input) {
      calls.push([
        "readPublishedCardSummaries",
        input,
      ]);
      return collectionResult;
    },
  };
  const clock = {
    nowMs() {
      calls.push(["nowMs"]);
      return nowMs;
    },
  };
  return {
    calls,
    result,
    collectionResult,
    service: createFreeAgentDraftReadService({
      leagueAuthorization,
      repository,
      clock,
    }),
  };
}

describe("FAD-08 read application boundary", () => {
  test("authorizes an unscoped navigation read and forwards exact viewer evidence", () => {
    const { calls, result, service } = harness();

    assert.equal(
      service.navigation({
        leagueId: LEAGUE_ID,
        authenticated: AUTHENTICATED,
      }),
      result
    );
    assert.deepEqual(calls, [
      [
        "requireActiveMembership",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
      ["nowMs"],
      [
        "readNavigation",
        {
          leagueId: LEAGUE_ID,
          viewerMembershipId: MEMBERSHIP_ID,
          viewerUserId: USER_ID,
          nowMs: NOW_MS,
          rosterSeasonId: null,
          rosterTeamId: null,
        },
      ],
    ]);
  });

  test("keeps a complete roster-scoped navigation pair intact", () => {
    const { calls, service } = harness();

    service.navigation({
      leagueId: LEAGUE_ID,
      authenticated: AUTHENTICATED,
      rosterSeasonId: SEASON_ID,
      rosterTeamId: TEAM_ID,
    });
    assert.deepEqual(calls.at(-1), [
      "readNavigation",
      {
        leagueId: LEAGUE_ID,
        viewerMembershipId: MEMBERSHIP_ID,
        viewerUserId: USER_ID,
        nowMs: NOW_MS,
        rosterSeasonId: SEASON_ID,
        rosterTeamId: TEAM_ID,
      },
    ]);
  });

  test("requires commissioner authority for readiness and samples no clock before authorization", () => {
    const { calls, result, service } = harness();

    assert.equal(
      service.readiness({
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        authenticated: AUTHENTICATED,
      }),
      result
    );
    assert.deepEqual(calls, [
      [
        "requireCommissioner",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
      ["nowMs"],
      [
        "readReadiness",
        {
          leagueId: LEAGUE_ID,
          seasonId: SEASON_ID,
          viewerMembershipId: MEMBERSHIP_ID,
          viewerUserId: USER_ID,
          nowMs: NOW_MS,
        },
      ],
    ]);

    const denied = new Error("denied");
    const blocked = harness({
      authorizationError: denied,
    });
    assert.throws(
      () =>
        blocked.service.readiness({
          leagueId: LEAGUE_ID,
          seasonId: SEASON_ID,
          authenticated: AUTHENTICATED,
        }),
      (error) => error === denied
    );
    assert.deepEqual(blocked.calls, [
      [
        "requireCommissioner",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
    ]);
  });

  test("authorizes an overview as an active league member", () => {
    const { calls, result, service } = harness();

    assert.equal(
      service.overview({
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        authenticated: AUTHENTICATED,
      }),
      result
    );
    assert.deepEqual(calls.at(-1), [
      "readOverview",
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        viewerMembershipId: MEMBERSHIP_ID,
        viewerUserId: USER_ID,
        nowMs: NOW_MS,
      },
    ]);
  });

  test("authorizes T-131 and T-132 as active-member published reads with exact defaults", () => {
    const {
      calls,
      collectionResult,
      result,
      service,
    } = harness();

    assert.equal(
      service.publishedCardSummaries({
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        authenticated: AUTHENTICATED,
      }),
      collectionResult
    );
    assert.deepEqual(calls.slice(-3), [
      [
        "requireActiveMembership",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
      ["nowMs"],
      [
        "readPublishedCardSummaries",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          viewerMembershipId: MEMBERSHIP_ID,
          viewerUserId: USER_ID,
          nowMs: NOW_MS,
          query: { cursor: null, limit: 50 },
        },
      ],
    ]);

    assert.equal(
      service.publishedCardHistory({
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        teamId: TEAM_ID,
        authenticated: AUTHENTICATED,
      }),
      result
    );
    assert.deepEqual(calls.slice(-3), [
      [
        "requireActiveMembership",
        AUTHENTICATED,
        LEAGUE_ID,
      ],
      ["nowMs"],
      [
        "readPublishedCardHistory",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          viewerMembershipId: MEMBERSHIP_ID,
          viewerUserId: USER_ID,
          nowMs: NOW_MS,
        },
      ],
    ]);
  });

  test("normalizes the complete T-140 filter and cursor contract before persistence", () => {
    const { calls, collectionResult, service } =
      harness();
    const encodedCursor =
      "eyJmaWx0ZXJTaGEyNTYiOiJhIn0";

    assert.equal(
      service.allocationResults({
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        authenticated: AUTHENTICATED,
        query: {
          q: "  ALEX\tExample ",
          status: "pending",
          limit: "7",
          cursor: encodedCursor,
        },
      }),
      collectionResult
    );
    assert.deepEqual(calls.at(-1), [
      "readAllocationResults",
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        viewerMembershipId: MEMBERSHIP_ID,
        viewerUserId: USER_ID,
        nowMs: NOW_MS,
        query: {
          q: "alex example",
          status: "pending",
          limit: 7,
          cursor: encodedCursor,
        },
      },
    ]);
  });

  test("rejects malformed published filters before authorization", () => {
    for (const invoke of [
      (service) =>
        service.publishedCardSummaries({
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          authenticated: AUTHENTICATED,
          query: { unknown: true },
        }),
      (service) =>
        service.allocationResults({
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          authenticated: AUTHENTICATED,
          query: { limit: 101 },
        }),
      (service) =>
        service.allocationResults({
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          authenticated: AUTHENTICATED,
          query: { status: "unknown" },
        }),
      (service) =>
        service.allocationResults({
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          authenticated: AUTHENTICATED,
          query: { cursor: "bad+cursor" },
        }),
    ]) {
      const { calls, service } = harness();
      assert.throws(
        () => invoke(service),
        { code: "FAD_READ_INPUT_INVALID" }
      );
      assert.deepEqual(calls, []);
    }
  });

  test("rejects unknown or partial application inputs before authority or persistence", () => {
    for (const input of [
      {
        leagueId: LEAGUE_ID,
        authenticated: AUTHENTICATED,
        rosterSeasonId: SEASON_ID,
      },
      {
        leagueId: LEAGUE_ID,
        authenticated: AUTHENTICATED,
        unknown: true,
      },
      {
        leagueId: LEAGUE_ID,
        authenticated: AUTHENTICATED,
        rosterSeasonId:
          "22222222-2222-2222-8222-222222222222",
        rosterTeamId: TEAM_ID,
      },
    ]) {
      const { calls, service } = harness();
      assert.throws(
        () => service.navigation(input),
        { code: "FAD_READ_INPUT_INVALID" }
      );
      assert.deepEqual(calls, []);
    }
  });

  test("fails closed on an unsafe clock or noncanonical repository result", () => {
    {
      const { calls, service } = harness({
        nowMs: Number.MAX_SAFE_INTEGER,
      });
      assert.throws(
        () =>
          service.overview({
            leagueId: LEAGUE_ID,
            fadId: FAD_ID,
            authenticated: AUTHENTICATED,
          }),
        /safe UTC timestamp/
      );
      assert.equal(
        calls.some(([name]) => name === "readOverview"),
        false
      );
    }
    {
      const { service } = harness({ result: null });
      assert.throws(
        () =>
          service.navigation({
            leagueId: LEAGUE_ID,
            authenticated: AUTHENTICATED,
          }),
        /canonical FAD read projection is unavailable/
      );
    }
    {
      const { service } = harness({
        collectionResult: {
          data: [],
          page: {
            nextCursor: "premature-cursor",
            hasMore: true,
          },
        },
      });
      assert.throws(
        () =>
          service.allocationResults({
            leagueId: LEAGUE_ID,
            fadId: FAD_ID,
            authenticated: AUTHENTICATED,
          }),
        /canonical FAD read collection is unavailable/
      );
    }
  });

  test("requires the complete dependency surface", () => {
    const dependencies = {
      leagueAuthorization: {
        requireActiveMembership() {},
        requireCommissioner() {},
      },
      repository: {
        readAllocationResults() {},
        readNavigation() {},
        readOverview() {},
        readPublishedCardHistory() {},
        readPublishedCardSummaries() {},
        readReadiness() {},
      },
      clock: { nowMs() {} },
    };
    for (const [dependency, method] of [
      ["leagueAuthorization", "requireCommissioner"],
      ["repository", "readOverview"],
      ["clock", "nowMs"],
    ]) {
      const value = {
        ...dependencies,
        [dependency]: {
          ...dependencies[dependency],
        },
      };
      delete value[dependency][method];
      assert.throws(
        () => createFreeAgentDraftReadService(value),
        /FAD reads require/
      );
    }
  });
});
