const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createAuctionService,
} = require("../../src/application/services/auctions/createAuctionService");
const {
  createAuctionRouter,
  optionalIfMatch,
} = require("../../src/transport/http/createAuctionRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const SEASON_ID = "00000000-0000-4000-8000-000000000002";
const TEAM_ID = "00000000-0000-4000-8000-000000000003";
const PLAYER_ID = "00000000-0000-4000-8000-000000000004";
const AUCTION_ID = "00000000-0000-4000-8000-000000000005";
const BID_ID = "00000000-0000-4000-8000-000000000006";
const USER_ID = "00000000-0000-4000-8000-000000000007";
const MEMBERSHIP_ID = "00000000-0000-4000-8000-000000000008";
const AUCTION_ID_2 = "00000000-0000-4000-8000-000000000009";
const FAD_ID = "00000000-0000-4000-8000-000000000010";
const ROLLOVER_ID = "00000000-0000-4000-8000-000000000011";
const QUEUE_ID = "00000000-0000-4000-8000-000000000012";
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");

function idFactory() {
  let next = 100;
  return {
    id() {
      const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
      next += 1;
      return id;
    },
  };
}

function writeResult(overrides = {}) {
  return {
    replayed: false,
    action: "edited",
    auction: {
      id: AUCTION_ID,
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      status: "open",
      openedAtMs: NOW_MS - 1,
      bidClosesAtMs: NOW_MS + 1,
    },
    bid: {
      id: BID_ID,
      teamId: TEAM_ID,
      totalValueCents: 600,
      termYears: 3,
      aavCents: 200,
      firstSubmittedAtMs: NOW_MS - 1,
      lastEditedAtMs: NOW_MS,
      editCount: 1,
      status: "active",
      version: 2,
    },
    ...overrides,
  };
}

function allowedCapability() {
  return { allowed: true, reasonCode: null };
}

function blockedCapability(reasonCode = "NOT_AUTHORIZED") {
  return { allowed: false, reasonCode };
}

function safeTeamProjection() {
  return {
    teamId: TEAM_ID,
    name: "Safe Team",
    primaryColour: "#112233",
    secondaryColour: "#ddeeff",
    tertiaryColour: null,
    patternTemplate: "solid",
    logoReference: null,
  };
}

function safeAuctionProjection({
  auctionId = AUCTION_ID,
  resolvesAtMs = NOW_MS + 1_000,
} = {}) {
  return {
    auctionId,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    version: 1,
    player: {
      playerId: PLAYER_ID,
      fullName: "Safe Player",
      positionGroup: "F",
    },
    status: "active",
    openedAtMs: NOW_MS - 1_000,
    resolvesAtMs,
    resolvedAtMs: null,
    updatedAtMs: NOW_MS - 1_000,
    bidCount: 0,
    participatingTeamCount: 0,
    sourceKind: "ordinary_weekly",
    fadOrigin: null,
    fadId: null,
    fadRolloverId: null,
    targetRolloverAtMs: null,
    creationCutoffAtMs: null,
    eligibleTeams: [],
    minimumContract: null,
    drawCommitment: null,
    viewerTeams: [],
    administrativeBids: [],
    result: null,
    capabilities: {
      view: allowedCapability(),
      adminCancel: blockedCapability(),
      adminResolve: blockedCapability(),
    },
  };
}

function safeFadAuctionProjection() {
  return {
    ...safeAuctionProjection(),
    sourceKind: "fad_open_rapid",
    fadOrigin: "manager_nomination",
    fadId: FAD_ID,
    fadRolloverId: ROLLOVER_ID,
    targetRolloverAtMs: NOW_MS + 3_600_000,
    creationCutoffAtMs: NOW_MS,
    drawCommitment: "a".repeat(64),
  };
}

function safeQueuedNominationProjection() {
  return {
    queueId: QUEUE_ID,
    fadId: FAD_ID,
    teamId: TEAM_ID,
    player: {
      playerId: PLAYER_ID,
      fullName: "Safe Player",
      positionGroup: "F",
    },
    totalValueCents: 700,
    termYears: 3,
    aavCents: 233,
    bindingIllegalityConfirmedAtMs: NOW_MS,
    acceptedAtMs: NOW_MS,
    openingRolloverId: ROLLOVER_ID,
    resolutionRolloverId: null,
    status: "queued",
    version: 1,
  };
}

function safeStartTeamProjection() {
  return {
    teamId: TEAM_ID,
    team: safeTeamProjection(),
    sourceKind: "ordinary_weekly",
    fadId: null,
    fadRolloverId: null,
    targetRolloverAtMs: null,
    creationCutoffAtMs: null,
    startAuction: blockedCapability("PHASE_CLOSED"),
  };
}

function serviceDependencies(overrides = {}) {
  const calls = [];
  const managerAuthority = Object.freeze({
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    authority: "manager",
  });
  const commissionerAuthority = Object.freeze({
    actorUserId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    authority: "commissioner",
  });
  return {
    calls,
    dependencies: {
      leagueAuthorization: {
        requireActiveMembership() {
          return managerAuthority;
        },
        requireCommissioner() {
          return commissionerAuthority;
        },
      },
      teamAuthorization: {
        requireManager() {
          return managerAuthority;
        },
      },
      leagueAccessRepository: {
        findLeagueSummary() {
          return { current_season_id: SEASON_ID };
        },
      },
      freeAgentDraftAuctionStartWriter: {
        startOrQueue(input) {
          calls.push({ method: "startOrQueue", input });
          return Object.freeze({ applicable: false });
        },
      },
      auctionRepository: {
        startAuction(input) {
          calls.push({ method: "startAuction", input });
          return {
            replayed: false,
            auction: { id: AUCTION_ID, leagueId: LEAGUE_ID },
            openingBid: writeResult().bid,
            event: { id: BID_ID, type: "auction_started" },
          };
        },
      },
      auctionBidRepository: {
        putBid(input) {
          calls.push({ method: "putBid", input });
          return writeResult();
        },
      },
      auctionReadRepository: {
        listAuctions(input) {
          calls.push({
            method: "listAuctions",
            input,
          });
          return {
            auctions: [],
            startTeams: [],
          };
        },
        readAuction(input) {
          calls.push({
            method: "readAuction",
            input,
          });
          return safeAuctionProjection();
        },
      },
      clock: { nowMs: () => NOW_MS },
      secureRandom: idFactory(),
      ...overrides,
    },
  };
}

function requestSecurity() {
  const session = Object.freeze({ user: { id: USER_ID }, session: { id: BID_ID } });
  return {
    assignRequestId(request, response, next) {
      request.testRequestId = "m5-02-request";
      next();
    },
    securityHeaders(request, response, next) {
      response.set("Cache-Control", "no-store");
      next();
    },
    credentialedCors(request, response, next) {
      next();
    },
    requireAllowedOrigin(request, response, next) {
      next();
    },
    requireJson(request, response, next) {
      next();
    },
    requireCompatibleFetchMetadata(request, response, next) {
      next();
    },
    authenticateBootstrap(request, response, next) {
      next();
    },
    authenticateUnsafe(request, response, next) {
      next();
    },
    getRequestId(request) {
      return request.testRequestId;
    },
    getSessionBootstrap() {
      return session;
    },
    getAuthenticatedSession() {
      return session;
    },
  };
}

async function startApi(
  t,
  auctionService,
  auctionAdministrationService =
    auctionAdministrationServiceStub()
) {
  const app = express();
  app.use(
    createAuctionRouter({
      requestSecurity: requestSecurity(),
      auctionService,
      auctionAdministrationService,
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function auctionAdministrationResult(
  action,
  httpStatus,
  data
) {
  return Object.freeze({
    action,
    actorAuthority: "commissioner",
    data,
    evidence: Object.freeze({}),
    httpStatus,
    replayed: false,
  });
}

function auctionAdministrationServiceStub(
  overrides = {}
) {
  return {
    editBid() {
      return auctionAdministrationResult(
        "edit_bid",
        200,
        {
          id: AUCTION_ID,
          sourceKind:
            "ordinary_weekly",
        }
      );
    },
    removeBid() {
      return auctionAdministrationResult(
        "remove_bid",
        200,
        {
          auction: {
            id: AUCTION_ID,
            sourceKind:
              "ordinary_weekly",
          },
          removedBidId: BID_ID,
          restrictedParticipantStatus:
            null,
          fadAllocationVersion: null,
        }
      );
    },
    cancelAuction() {
      return auctionAdministrationResult(
        "cancel_auction",
        200,
        {
          auction: {
            id: AUCTION_ID,
            sourceKind:
              "ordinary_weekly",
          },
          fadAllocation: null,
          recoveryId: null,
        }
      );
    },
    requestResolution() {
      return auctionAdministrationResult(
        "request_resolution",
        202,
        {
          operationId:
            "00000000-0000-4000-8000-000000000099",
          occurrenceKey:
            `auction:${AUCTION_ID}:1000`,
          auctionId: AUCTION_ID,
          status: "pending",
          acceptedAtMs: 1_000,
          pollDescriptor: {
            kind: "auction",
            leagueId: LEAGUE_ID,
            auctionId: AUCTION_ID,
          },
        }
      );
    },
    ...overrides,
  };
}

function auctionServiceStub(overrides = {}) {
  return {
    list() {
      return {
        data: [],
        actions: { startTeams: [] },
        page: {
          nextCursor: null,
          hasMore: false,
        },
      };
    },
    read() {
      return {
        auctionId: AUCTION_ID,
        status: "cancelled",
      };
    },
    start() {
      return { code: "AUCTION_STARTED", auction: { id: AUCTION_ID } };
    },
    putMine() {
      return { code: "AUCTION_BID_SUBMITTED", bid: { id: BID_ID } };
    },
    ...overrides,
  };
}

describe("M5-02 auction application service", () => {
  test("passes authenticated read scope and exact manager bid authority", () => {
    const fixture = serviceDependencies();
    fixture.dependencies.leagueAuthorization.requireCommissioner = () => {
      const error = new Error("not commissioner");
      error.code = "LEAGUE_COMMISSIONER_REQUIRED";
      throw error;
    };
    const service = createAuctionService(fixture.dependencies);
    const listed = service.list({
      leagueId: LEAGUE_ID,
      query: {},
      authenticated: {},
    });
    assert.deepEqual(listed, {
      data: [],
      actions: { startTeams: [] },
      page: {
        nextCursor: null,
        hasMore: false,
      },
    });
    const detail = service.read({
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      authenticated: {},
    });
    assert.equal(detail.auctionId, AUCTION_ID);
    assert.equal(detail.status, "active");
    assert.deepEqual(
      fixture.calls.find(
        ({ method }) => method === "listAuctions"
      ).input,
      {
        leagueId: LEAGUE_ID,
        viewerUserId: USER_ID,
        viewerMembershipId: MEMBERSHIP_ID,
        sourceKind: null,
        fadId: null,
        statuses: ["active"],
        q: null,
        limit: 51,
        order: "resolves_asc",
        cursor: null,
        nowMs: NOW_MS,
      }
    );
    assert.deepEqual(
      fixture.calls.find(
        ({ method }) => method === "readAuction"
      ).input,
      {
        leagueId: LEAGUE_ID,
        auctionId: AUCTION_ID,
        viewerUserId: USER_ID,
        viewerMembershipId: MEMBERSHIP_ID,
        nowMs: NOW_MS,
      }
    );
    const result = service.putMine({
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      input: { teamId: TEAM_ID, aavCents: 200, termYears: 3 },
      expectedBidVersion: 1,
      idempotencyKey: "manager-edit",
      authenticated: {},
    });
    assert.equal(result.bid.totalValueCents, 600);
    const write = fixture.calls.find(({ method }) => method === "putBid").input;
    assert.equal(write.actorAuthority, "manager");
    assert.equal(write.expectedBidVersion, 1);
    assert.equal(write.occurredAtMs, NOW_MS);
    assert.equal(write.idempotencyExpiresAtMs, NOW_MS + 86_400_000);

    service.putMine({
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      input: {
        teamId: TEAM_ID,
        aavCents: 225,
        termYears: 3,
        bindingIllegalityConfirmed: true,
      },
      expectedBidVersion: null,
      idempotencyKey: "fad-manager-join",
      authenticated: {},
    });
    const fadWrite = fixture.calls.filter(
      ({ method }) => method === "putBid"
    ).at(-1).input;
    assert.equal(fadWrite.bindingIllegalityConfirmed, true);
    assert.throws(
      () => service.putMine({
        leagueId: LEAGUE_ID,
        auctionId: AUCTION_ID,
        input: {
          teamId: TEAM_ID,
          aavCents: 225,
          termYears: 3,
          bindingIllegalityConfirmed: false,
        },
        expectedBidVersion: null,
        idempotencyKey: "fad-manager-invalid",
        authenticated: {},
      }),
      (error) => error.code === "AUCTION_BID_INPUT_INVALID"
    );
  });

  test("never returns active values after a commissioner start and exposes no legacy commissioner bid command", () => {
    const fixture = serviceDependencies();
    const service = createAuctionService(fixture.dependencies);
    const started = service.start({
      leagueId: LEAGUE_ID,
      input: {
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        aavCents: 350,
        termYears: 3,
      },
      idempotencyKey: "commissioner-start",
      authenticated: {},
    });
    const serialized = JSON.stringify(started);
    assert.equal(serialized.includes("totalValueCents"), false);
    assert.equal(serialized.includes("termYears"), false);
    assert.equal(serialized.includes("aavCents"), false);
    assert.equal("putAsCommissioner" in service, false);
    assert.deepEqual(
      fixture.calls.map(({ method }) => method),
      ["startOrQueue", "startAuction"]
    );
    assert.deepEqual(
      fixture.calls[0].input,
      {
        leagueId: LEAGUE_ID,
        actorUserId: USER_ID,
        actorMembershipId: MEMBERSHIP_ID,
        body: {
          teamId: TEAM_ID,
          playerId: PLAYER_ID,
          aavCents: 350,
          termYears: 3,
        },
        idempotencyKey: "commissioner-start",
        nowMs: NOW_MS,
        idempotencyExpiresAtMs:
          NOW_MS + 86_400_000,
      }
    );
    assert.deepEqual(
      fixture.calls[1].input,
      {
        auctionId:
          "00000000-0000-4000-8000-000000000100",
        bidId:
          "00000000-0000-4000-8000-000000000101",
        eventId:
          "00000000-0000-4000-8000-000000000102",
        idempotencyRequestId:
          "00000000-0000-4000-8000-000000000103",
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        actorUserId: USER_ID,
        actorMembershipId: MEMBERSHIP_ID,
        actorAuthority: "commissioner",
        aavCents: 350,
        termYears: 3,
        idempotencyKey: "commissioner-start",
        occurredAtMs: NOW_MS,
        idempotencyExpiresAtMs:
          NOW_MS + 86_400_000,
      }
    );

    const platformFixture = serviceDependencies();
    platformFixture.dependencies.leagueAuthorization
      .requireCommissioner = () => ({
        actorUserId: USER_ID,
        membershipId: MEMBERSHIP_ID,
        authority: "platform_administrator",
      });
    const platformService = createAuctionService(
      platformFixture.dependencies
    );
    const platformStarted = platformService.start({
      leagueId: LEAGUE_ID,
      input: {
        teamId: TEAM_ID,
        playerId: PLAYER_ID,
        aavCents: 350,
        termYears: 3,
      },
      idempotencyKey: "platform-admin-start",
      authenticated: {},
    });
    assert.equal(
      platformFixture.calls.find(
        ({ method }) => method === "startAuction"
      ).input.actorAuthority,
      "platform_administrator_as_commissioner"
    );
    const platformSerialized = JSON.stringify(
      platformStarted
    );
    assert.equal(
      platformSerialized.includes("totalValueCents"),
      false
    );
    assert.equal(
      platformSerialized.includes("termYears"),
      false
    );
  });

  test("projects a direct FAD start through the current canonical auction read without exposing writer evidence", () => {
    const fixture = serviceDependencies();
    fixture.dependencies.secureRandom = {
      id() {
        throw new Error(
          "ordinary entropy must not be sampled for a FAD start"
        );
      },
    };
    fixture.dependencies.freeAgentDraftAuctionStartWriter = {
      startOrQueue(input) {
        fixture.calls.push({
          method: "startOrQueue",
          input,
        });
        return Object.freeze({
          kind: "auction_opened",
          replayed: false,
          actorAuthority: "commissioner",
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          auctionId: AUCTION_ID,
          body: Object.freeze({
            playerId: PLAYER_ID,
            teamId: TEAM_ID,
            aavCents: 225,
            termYears: 3,
            bindingIllegalityConfirmed: true,
          }),
          drawCommitmentHex: "private-draw-evidence",
          openingBidId: BID_ID,
        });
      },
    };
    fixture.dependencies.auctionReadRepository
      .readAuction = (input) => {
        fixture.calls.push({
          method: "readAuction",
          input,
        });
        return safeFadAuctionProjection();
      };
    const service = createAuctionService(
      fixture.dependencies
    );
    const body = {
      playerId: PLAYER_ID,
      teamId: TEAM_ID,
      aavCents: 225,
      termYears: 3,
      bindingIllegalityConfirmed: true,
    };
    const started = service.start({
      leagueId: LEAGUE_ID,
      input: body,
      idempotencyKey: "fad-direct-start",
      authenticated: {},
    });

    assert.deepEqual(Object.keys(started), [
      "kind",
      "auction",
      "queuedNomination",
    ]);
    assert.equal(started.kind, "auction_opened");
    assert.deepEqual(
      started.auction,
      safeFadAuctionProjection()
    );
    assert.equal(started.queuedNomination, null);
    assert.equal(Object.isFrozen(started), true);
    assert.deepEqual(
      fixture.calls.map(({ method }) => method),
      ["startOrQueue", "readAuction"]
    );
    assert.deepEqual(fixture.calls[0].input, {
      leagueId: LEAGUE_ID,
      actorUserId: USER_ID,
      actorMembershipId: MEMBERSHIP_ID,
      body,
      idempotencyKey: "fad-direct-start",
      nowMs: NOW_MS,
      idempotencyExpiresAtMs:
        NOW_MS + 86_400_000,
    });
    assert.deepEqual(fixture.calls[1].input, {
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
      viewerUserId: USER_ID,
      viewerMembershipId: MEMBERSHIP_ID,
      nowMs: NOW_MS,
    });
    const serialized = JSON.stringify(started);
    for (const privateField of [
      "actorAuthority",
      "bindingIllegalityConfirmed",
      "drawCommitmentHex",
      "openingBidId",
      "replayed",
    ]) {
      assert.equal(
        serialized.includes(privateField),
        false
      );
    }
  });

  test("projects a queued FAD nomination as the exact manager-private resource without ordinary writes or evidence", () => {
    const fixture = serviceDependencies();
    fixture.dependencies.leagueAuthorization
      .requireCommissioner = () => {
        const error = new Error("not commissioner");
        error.code = "LEAGUE_COMMISSIONER_REQUIRED";
        throw error;
      };
    fixture.dependencies.secureRandom = {
      id() {
        throw new Error(
          "ordinary entropy must not be sampled for a queued nomination"
        );
      },
    };
    const queuedNomination =
      safeQueuedNominationProjection();
    fixture.dependencies.freeAgentDraftAuctionStartWriter = {
      startOrQueue(input) {
        fixture.calls.push({
          method: "startOrQueue",
          input,
        });
        return Object.freeze({
          kind: "nomination_queued",
          replayed: true,
          actorAuthority: "manager",
          fadId: FAD_ID,
          nominationQueueId: QUEUE_ID,
          activationJobRunId:
            "private-activation-job",
          queuedNomination,
        });
      },
    };
    const service = createAuctionService(
      fixture.dependencies
    );
    const body = {
      playerId: PLAYER_ID,
      teamId: TEAM_ID,
      aavCents: 225,
      termYears: 3,
      bindingIllegalityConfirmed: true,
    };
    const started = service.start({
      leagueId: LEAGUE_ID,
      input: body,
      idempotencyKey: "fad-queued-start",
      authenticated: {},
    });

    assert.deepEqual(Object.keys(started), [
      "kind",
      "auction",
      "queuedNomination",
    ]);
    assert.equal(started.kind, "nomination_queued");
    assert.equal(started.auction, null);
    assert.deepEqual(
      started.queuedNomination,
      safeQueuedNominationProjection()
    );
    assert.notEqual(
      started.queuedNomination,
      queuedNomination
    );
    assert.equal(
      Object.isFrozen(started.queuedNomination),
      true
    );
    assert.equal(
      Object.isFrozen(started.queuedNomination.player),
      true
    );
    assert.deepEqual(
      fixture.calls.map(({ method }) => method),
      ["startOrQueue"]
    );
    const serialized = JSON.stringify(started);
    for (const privateField of [
      "activationJobRunId",
      "actorAuthority",
      "idempotencyRequestId",
      "replayed",
    ]) {
      assert.equal(
        serialized.includes(privateField),
        false
      );
    }
  });

  test("overfetches once and binds the next cursor to the normalized active filter", () => {
    const fixture = serviceDependencies();
    fixture.dependencies.auctionReadRepository
      .listAuctions = (input) => {
        fixture.calls.push({
          method: "listAuctions",
          input,
        });
        return {
          auctions: [
            safeAuctionProjection({
              auctionId: AUCTION_ID,
              resolvesAtMs: NOW_MS + 1_000,
            }),
            safeAuctionProjection({
              auctionId: AUCTION_ID_2,
              resolvesAtMs: NOW_MS + 2_000,
            }),
          ],
          startTeams: [safeStartTeamProjection()],
        };
      };
    const service = createAuctionService(
      fixture.dependencies
    );
    const first = service.list({
      leagueId: LEAGUE_ID,
      query: { limit: "1" },
      authenticated: {},
    });
    assert.deepEqual(first.data, [
      safeAuctionProjection({
        auctionId: AUCTION_ID,
        resolvesAtMs: NOW_MS + 1_000,
      }),
    ]);
    assert.deepEqual(first.actions, {
      startTeams: [safeStartTeamProjection()],
    });
    assert.equal(first.page.hasMore, true);
    assert.equal(
      typeof first.page.nextCursor,
      "string"
    );
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.data), true);

    service.list({
      leagueId: LEAGUE_ID,
      query: {
        limit: "1",
        cursor: first.page.nextCursor,
      },
      authenticated: {},
    });
    const calls = fixture.calls.filter(
      ({ method }) => method === "listAuctions"
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input.limit, 2);
    assert.deepEqual(calls[1].input.cursor, {
      sortMs: NOW_MS + 1_000,
      auctionId: AUCTION_ID,
    });
    assert.throws(
      () =>
        service.list({
          leagueId: LEAGUE_ID,
          query: {
            limit: "1",
            status: "resolved",
            cursor: first.page.nextCursor,
          },
          authenticated: {},
        }),
      (error) =>
        error.code ===
        "AUCTION_READ_INPUT_INVALID"
    );
    assert.equal(
      fixture.calls.filter(
        ({ method }) => method === "listAuctions"
      ).length,
      2
    );
  });

  test("rejects non-canonical repository projections before exposing hidden auction values", () => {
    const detailFixture = serviceDependencies();
    detailFixture.dependencies.auctionReadRepository
      .readAuction = () => ({
        ...safeAuctionProjection(),
        leadingTotalValueCents: 12_345,
      });
    const detailService = createAuctionService(
      detailFixture.dependencies
    );
    assert.throws(
      () =>
        detailService.read({
          leagueId: LEAGUE_ID,
          auctionId: AUCTION_ID,
          authenticated: {},
        }),
      (error) =>
        error.code ===
        "AUCTION_READ_PROJECTION_INVALID"
    );

    const collectionFixture = serviceDependencies();
    const malformedStartTeam = safeStartTeamProjection();
    Object.defineProperty(
      malformedStartTeam,
      "privateContractValueCents",
      {
        enumerable: true,
        get() {
          return 12_345;
        },
      }
    );
    collectionFixture.dependencies.auctionReadRepository
      .listAuctions = () => ({
        auctions: [safeAuctionProjection()],
        startTeams: [malformedStartTeam],
      });
    const collectionService = createAuctionService(
      collectionFixture.dependencies
    );
    assert.throws(
      () =>
        collectionService.list({
          leagueId: LEAGUE_ID,
          query: {},
          authenticated: {},
        }),
      (error) =>
        error.code ===
        "AUCTION_READ_PROJECTION_INVALID"
    );
  });

  test("requires every authorization, persistence, clock, and identifier boundary", () => {
    assert.throws(() => createAuctionService(), /auction service requires/);
  });
});

describe("FAD-06 isolated auction HTTP contract", () => {
  test("routes ordinary auction reads, manager commands, and canonical T-080 through T-083 administration", async (t) => {
    const calls = [];
    const service = auctionServiceStub({
      list(input) {
        calls.push({ method: "list", input });
        return {
          data: [],
          actions: { startTeams: [] },
          page: {
            nextCursor: null,
            hasMore: false,
          },
        };
      },
      read(input) {
        calls.push({ method: "read", input });
        return {
          auctionId: AUCTION_ID,
          status: "cancelled",
        };
      },
      start(input) {
        calls.push({ method: "start", input });
        return { code: "AUCTION_STARTED", auction: { id: AUCTION_ID } };
      },
      putMine(input) {
        calls.push({ method: "putMine", input });
        return { code: "AUCTION_BID_EDITED", bid: { id: BID_ID } };
      },
    });
    const administration =
      auctionAdministrationServiceStub({
        editBid(input) {
          calls.push({
            method: "editBid",
            input,
          });
          return auctionAdministrationResult(
            "edit_bid",
            200,
            {
              id: AUCTION_ID,
              sourceKind:
                "ordinary_weekly",
            }
          );
        },
        removeBid(input) {
          calls.push({
            method: "removeBid",
            input,
          });
          return auctionAdministrationResult(
            "remove_bid",
            200,
            {
              auction: {
                id: AUCTION_ID,
                sourceKind:
                  "ordinary_weekly",
              },
              removedBidId: BID_ID,
              restrictedParticipantStatus:
                null,
              fadAllocationVersion: null,
            }
          );
        },
        cancelAuction(input) {
          calls.push({
            method: "cancelAuction",
            input,
          });
          return auctionAdministrationResult(
            "cancel_auction",
            200,
            {
              auction: {
                id: AUCTION_ID,
                sourceKind:
                  "ordinary_weekly",
              },
              fadAllocation: null,
              recoveryId: null,
            }
          );
        },
        requestResolution(input) {
          calls.push({
            method: "requestResolution",
            input,
          });
          return auctionAdministrationResult(
            "request_resolution",
            202,
            {
              operationId:
                "00000000-0000-4000-8000-000000000099",
              occurrenceKey:
                `auction:${AUCTION_ID}:1000`,
              auctionId: AUCTION_ID,
              status: "pending",
              acceptedAtMs: 1_000,
              pollDescriptor: {
                kind: "auction",
                leagueId: LEAGUE_ID,
                auctionId: AUCTION_ID,
              },
            }
          );
        },
      });
    const baseUrl = await startApi(
      t,
      service,
      administration
    );
    const requests = [
      fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions` +
          "?status=cancelled&status=active&q=goalie&limit=25"
      ),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}`),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "start" },
        body: JSON.stringify({
          teamId: TEAM_ID,
          playerId: PLAYER_ID,
          aavCents: 350,
          termYears: 3,
        }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "mine",
          "if-match": '"2"',
        },
        body: JSON.stringify({ teamId: TEAM_ID, aavCents: 200, termYears: 3 }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/${BID_ID}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "admin-edit",
          "if-match": '"3"',
        },
        body: JSON.stringify({ teamId: TEAM_ID, aavCents: 175, termYears: 3 }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/${BID_ID}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "admin-remove",
          "if-match": '"4"',
        },
        body: JSON.stringify({
          confirmation: "REMOVE AUCTION BID",
        }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "admin-cancel",
          "if-match": '"5"',
        },
        body: JSON.stringify({
          confirmation: "CANCEL AUCTION",
        }),
      }),
      fetch(`${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/resolve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "admin-resolve",
          "if-match": '"6"',
        },
        body: JSON.stringify({
          confirmation: "RESOLVE AUCTION",
        }),
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(
      responses.map(({ status }) => status),
      [200, 200, 201, 200, 200, 200, 200, 202]
    );
    assert.deepEqual(calls.map(({ method }) => method).sort(), [
      "cancelAuction",
      "editBid",
      "list",
      "putMine",
      "read",
      "removeBid",
      "requestResolution",
      "start",
    ].sort());
    assert.equal(
      calls.find(({ method }) => method === "putMine").input.expectedBidVersion,
      2
    );
    const listInput = calls.find(
      ({ method }) => method === "list"
    ).input;
    assert.deepEqual(
      listInput.query.status,
      ["cancelled", "active"]
    );
    assert.equal(listInput.query.q, "goalie");
    assert.equal(listInput.query.limit, "25");
    assert.equal(
      calls.find(({ method }) => method === "editBid").input
        .expectedBidVersion,
      3
    );
    assert.equal(
      calls.find(
        ({ method }) =>
          method === "removeBid"
      ).input.expectedBidVersion,
      4
    );
    assert.equal(
      calls.find(
        ({ method }) =>
          method === "cancelAuction"
      ).input.expectedAuctionVersion,
      5
    );
    assert.equal(
      calls.find(
        ({ method }) =>
          method === "requestResolution"
      ).input.expectedAuctionVersion,
      6
    );
    const editBody = await responses[4].json();
    assert.deepEqual(
      Object.keys(editBody).sort(),
      ["data", "meta"]
    );
    assert.deepEqual(editBody.data, {
      id: AUCTION_ID,
      sourceKind: "ordinary_weekly",
    });
    for (const retiredField of [
      "bid",
      "code",
      "evidence",
      "replayed",
    ]) {
      assert.equal(
        retiredField in editBody,
        false
      );
    }
    const resolutionBody =
      await responses[7].json();
    assert.deepEqual(
      Object.keys(resolutionBody.data).sort(),
      [
        "acceptedAtMs",
        "auctionId",
        "occurrenceKey",
        "operationId",
        "pollDescriptor",
        "status",
      ].sort()
    );
    assert.equal(
      "evidence" in resolutionBody.data,
      false
    );
    const collectionBody = await responses[0].json();
    assert.deepEqual(
      Object.keys(collectionBody).sort(),
      ["actions", "data", "meta", "page"]
    );
    assert.deepEqual(collectionBody.data, []);
    assert.deepEqual(
      collectionBody.actions,
      { startTeams: [] }
    );
    assert.deepEqual(collectionBody.page, {
      nextCursor: null,
      hasMore: false,
    });
    const detailBody = await responses[1].json();
    assert.deepEqual(detailBody.data, {
      auctionId: AUCTION_ID,
      status: "cancelled",
    });
  });

  test("maps malformed preconditions and private policy failures to safe responses", async (t) => {
    let calls = 0;
    const baseUrl = await startApi(t, auctionServiceStub({
      list() {
        const error = new Error(
          "private malformed auction filters"
        );
        error.code = "AUCTION_READ_INPUT_INVALID";
        error.reasonCode = "status_invalid";
        throw error;
      },
      read() {
        const error = new Error(
          "private membership changed"
        );
        error.code =
          "AUCTION_READ_AUTHORIZATION_DENIED";
        throw error;
      },
      putMine() {
        calls += 1;
        const error = new Error("private active value");
        error.reasonCode = "AUCTION_BID_COOLDOWN_ACTIVE";
        throw error;
      },
    }));
    const malformed = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": "2" },
        body: JSON.stringify({ teamId: TEAM_ID, aavCents: 200, termYears: 3 }),
      }
    );
    assert.equal(malformed.status, 400);
    assert.equal(calls, 0);
    const cooldown = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: TEAM_ID, aavCents: 200, termYears: 3 }),
      }
    );
    const body = await cooldown.json();
    assert.equal(cooldown.status, 409);
    assert.equal(body.error.code, "AUCTION_BID_COOLDOWN_ACTIVE");
    assert.equal(body.error.requestId, "m5-02-request");
    assert.equal(JSON.stringify(body).includes("private active value"), false);

    const invalidRead = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions?status=active,resolved`
    );
    const invalidReadBody =
      await invalidRead.json();
    assert.equal(invalidRead.status, 400);
    assert.equal(
      invalidReadBody.error.code,
      "AUCTION_INPUT_INVALID"
    );
    const racedRead = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}`
    );
    const racedReadBody = await racedRead.json();
    assert.equal(racedRead.status, 404);
    assert.equal(
      racedReadBody.error.code,
      "LEAGUE_NOT_FOUND"
    );
    assert.equal(
      JSON.stringify(racedReadBody).includes(
        "private membership changed"
      ),
      false
    );

    const validationFixture = serviceDependencies();
    const validationBaseUrl = await startApi(
      t,
      createAuctionService(validationFixture.dependencies)
    );
    const malformedBody = await fetch(
      `${validationBaseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}/bids/mine`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "malformed-fad-body",
        },
        body: JSON.stringify({
          teamId: TEAM_ID,
          aavCents: 200,
          termYears: 3,
          bindingIllegalityConfirmed: false,
        }),
      }
    );
    const malformedBodyPayload = await malformedBody.json();
    assert.equal(malformedBody.status, 400);
    assert.equal(
      malformedBodyPayload.error.code,
      "AUCTION_BID_INPUT_INVALID"
    );
    assert.equal(
      validationFixture.calls.some(
        ({ method }) => method === "putBid"
      ),
      false
    );
  });

  test("maps every private FAD player quarantine to one generic conflict", async (t) => {
    const baseUrl = await startApi(
      t,
      auctionServiceStub({
        start() {
          const error = new Error(
            "private queued team, bid, rollover, and recovery identity"
          );
          error.code = "AUCTION_CREATION_INPUT_INVALID";
          error.reasonCode = "FAD_ALLOCATION_QUARANTINED";
          throw error;
        },
      })
    );
    const response = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "quarantined-player",
        },
        body: JSON.stringify({
          playerId: PLAYER_ID,
          teamId: TEAM_ID,
          aavCents: 300,
          termYears: 2,
        }),
      }
    );
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.deepEqual(body.error, {
      code: "FAD_ALLOCATION_QUARANTINED",
      message: "This player is temporarily unavailable.",
      requestId: "m5-02-request",
    });
    assert.equal(
      JSON.stringify(body).includes("private"),
      false
    );
    for (const key of [
      "teamId",
      "bid",
      "rollover",
      "recovery",
      "queue",
    ]) {
      assert.equal(JSON.stringify(body).includes(key), false);
    }
  });

  test("maps absent and false FAD binding confirmations to the exact safe 422 without an ordinary write", async (t) => {
    const fixture = serviceDependencies({
      freeAgentDraftAuctionStartWriter: {
        startOrQueue(input) {
          fixture.calls.push({
            method: "startOrQueue",
            input,
          });
          const error = new Error(
            "private binding, rollover, and allocation state"
          );
          error.code =
            "AUCTION_CREATION_INPUT_INVALID";
          error.reasonCode =
            "FAD_BINDING_ILLEGALITY_CONFIRMATION_REQUIRED";
          throw error;
        },
      },
    });
    const baseUrl = await startApi(
      t,
      createAuctionService(fixture.dependencies)
    );
    const inputs = [
      {
        playerId: PLAYER_ID,
        teamId: TEAM_ID,
        aavCents: 225,
        termYears: 3,
      },
      {
        playerId: PLAYER_ID,
        teamId: TEAM_ID,
        aavCents: 225,
        termYears: 3,
        bindingIllegalityConfirmed: false,
      },
    ];
    for (const [index, input] of inputs.entries()) {
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key":
              `fad-binding-${index}`,
          },
          body: JSON.stringify(input),
        }
      );
      const payload = await response.json();
      assert.equal(response.status, 422);
      assert.deepEqual(payload.error, {
        code:
          "FAD_BINDING_ILLEGALITY_CONFIRMATION_REQUIRED",
        message:
          "The binding FAD auction confirmation is required.",
        requestId: "m5-02-request",
      });
      assert.equal(
        JSON.stringify(payload).includes("private"),
        false
      );
    }
    assert.equal(
      fixture.calls.filter(
        ({ method }) => method === "startOrQueue"
      ).length,
      2
    );
    assert.equal(
      fixture.calls.some(
        ({ method }) => method === "startAuction"
      ),
      false
    );
  });

  test("maps administration precondition, idempotency, FAD-context, and due-state failures without leaking internals", async (t) => {
    const administration =
      auctionAdministrationServiceStub({
        editBid() {
          const error = new Error(
            "private stale bid state"
          );
          error.code =
            "AUCTION_PRECONDITION_FAILED";
          throw error;
        },
        removeBid() {
          const error = new Error(
            "private idempotency collision"
          );
          error.code =
            "IDEMPOTENCY_KEY_REUSED";
          throw error;
        },
        cancelAuction() {
          const error = new Error(
            "private restricted allocation"
          );
          error.code =
            "AUCTION_ADMIN_FAD_INTEGRATION_REQUIRED";
          throw error;
        },
        requestResolution() {
          const error = new Error(
            "private resolution clock"
          );
          error.code =
            "AUCTION_ADMINISTRATION_NOT_DUE";
          throw error;
        },
      });
    const baseUrl = await startApi(
      t,
      auctionServiceStub(),
      administration
    );
    const command = (
      pathSuffix,
      method,
      version,
      key,
      body
    ) =>
      fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/auctions/${AUCTION_ID}${pathSuffix}`,
        {
          method,
          headers: {
            "content-type":
              "application/json",
            "idempotency-key": key,
            "if-match": `"${version}"`,
          },
          body: JSON.stringify(body),
        }
      );
    const responses = await Promise.all([
      command(
        `/bids/${BID_ID}`,
        "PATCH",
        1,
        "stale",
        {
          teamId: TEAM_ID,
          aavCents: 300,
          termYears: 2,
        }
      ),
      command(
        `/bids/${BID_ID}`,
        "DELETE",
        2,
        "reused",
        {
          confirmation:
            "REMOVE AUCTION BID",
        }
      ),
      command(
        "/cancel",
        "POST",
        3,
        "cancel",
        {
          confirmation: "CANCEL AUCTION",
        }
      ),
      command(
        "/resolve",
        "POST",
        4,
        "resolve",
        {
          confirmation: "RESOLVE AUCTION",
        }
      ),
    ]);
    assert.deepEqual(
      responses.map(
        ({ status }) => status
      ),
      [412, 409, 409, 409]
    );
    const bodies = await Promise.all(
      responses.map((response) =>
        response.json()
      )
    );
    assert.deepEqual(
      bodies.map(
        ({ error }) => error.code
      ),
      [
        "AUCTION_PRECONDITION_FAILED",
        "IDEMPOTENCY_KEY_REUSED",
        "AUCTION_REQUEST_CONFLICT",
        "AUCTION_REQUEST_CONFLICT",
      ]
    );
    assert.equal(
      JSON.stringify(bodies).includes(
        "private"
      ),
      false
    );
  });

  test("parses only optional strong numeric bid versions and requires full boundaries", () => {
    assert.deepEqual(optionalIfMatch({ get: () => undefined }), {
      valid: true,
      version: null,
    });
    assert.deepEqual(optionalIfMatch({ get: () => '"7"' }), {
      valid: true,
      version: 7,
    });
    assert.deepEqual(optionalIfMatch({ get: () => "7" }), {
      valid: false,
      version: null,
    });
    assert.throws(
      () => createAuctionRouter({ requestSecurity: {}, auctionService: auctionServiceStub() }),
      /request-security boundary/
    );
    assert.throws(
      () =>
        createAuctionRouter({
          requestSecurity:
            requestSecurity(),
          auctionService:
            auctionServiceStub(),
        }),
      /auction-administration service/
    );
  });
});
