const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CommissionerCorrectionPolicyError,
} = require("../../src/domain/leagues/commissionerCorrectionPolicy");
const {
  createCommissionerCorrectionService,
} = require("../../src/application/services/leagues/createCommissionerCorrectionService");

const IDS = Object.freeze({
  league: "00000000-0000-4000-8000-000000000001",
  season: "00000000-0000-4000-8000-000000000002",
  ownership: "00000000-0000-4000-8000-000000000003",
  contract: "00000000-0000-4000-8000-000000000004",
  player: "00000000-0000-4000-8000-000000000005",
  team: "00000000-0000-4000-8000-000000000006",
  user: "00000000-0000-4000-8000-000000000007",
  membership: "00000000-0000-4000-8000-000000000008",
  seasonTwo: "00000000-0000-4000-8000-000000000009",
  seasonThree: "00000000-0000-4000-8000-000000000010",
  contractYear: "00000000-0000-4000-8000-000000000011",
});

function ids() {
  let value = 20;
  return {
    id() {
      value += 1;
      return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    },
  };
}

function rosterBody(overrides = {}) {
  return {
    seasonId: IDS.season,
    ownershipId: IDS.ownership,
    playerId: IDS.player,
    expectedVersion: 2,
    correctedTeamId: IDS.team,
    correctedOwnershipKind: "Rostered",
    correctedRosterCategory: "Bench",
    correctedPositionGroup: "F",
    correctedSlotNumber: 1,
    reason: "Move after correcting the roster sheet.",
    ...overrides,
  };
}

function contractBody(overrides = {}) {
  return {
    seasonId: IDS.season,
    contractId: IDS.contract,
    playerId: IDS.player,
    expectedVersion: 2,
    correctedOriginalTotalValueCents: 1_200,
    correctedOriginalTermYears: 3,
    reason: null,
    ...overrides,
  };
}

function addBody(overrides = {}) {
  return {
    seasonId: IDS.season,
    playerId: IDS.player,
    teamId: IDS.team,
    rosterCategory: "Active",
    positionGroup: "F",
    slotNumber: 1,
    contractType: "normal",
    originalTotalValueCents: 1_200,
    termYears: 3,
    reason: null,
    ...overrides,
  };
}

function result(preview) {
  return {
    preview,
    before: { version: 2 },
    requested: { aavCents: 400 },
    authoritative: { version: 3 },
    warnings: [{ code: "TEAM_OVER_CAP", teamId: IDS.team }],
    teamEvaluations: [
      {
        teamId: IDS.team,
        cap: { capUsageCents: 10_100, capLimitCents: 10_000 },
        warnings: [{ code: "TEAM_OVER_CAP", teamId: IDS.team }],
      },
    ],
    ...(preview
      ? {}
      : {
          correction: { id: "correction-record" },
          activity: {
            id: "activity-record",
            event_type: "commissioner_roster_corrected",
            occurred_at_ms: 1_700_000_000_000,
          },
        }),
  };
}

function createService(calls, workspaceOverride = null) {
  return createCommissionerCorrectionService({
    leagueAuthorization: {
      requireCommissioner(authenticated, leagueId) {
        calls.authority = { authenticated, leagueId };
        return {
          actorUserId: IDS.user,
          membershipId: IDS.membership,
          authority: "commissioner",
        };
      },
    },
    repository: {
      readWorkspace(input) {
        calls.readWorkspace = input;
        return workspaceOverride || {
          league: {
            id: IDS.league,
            currentSeasonId: IDS.season,
          },
          teams: [],
          seasons: [
            { id: IDS.season, sequence: 1 },
            { id: IDS.seasonTwo, sequence: 2 },
            { id: IDS.seasonThree, sequence: 3 },
          ],
          roster: [
            {
              seasonId: IDS.season,
              playerId: IDS.player,
              teamId: IDS.team,
              contract: {
                id: IDS.contract,
                version: 2,
                teamId: IDS.team,
                type: "normal",
                originalTotalValueCents: 400,
                originalTermYears: 1,
                aavCents: 400,
                startSeasonId: IDS.season,
                status: "active",
                auctionBuyoutLockExpiresAtMs: null,
                years: [
                  {
                    id: IDS.contractYear,
                    seasonId: IDS.season,
                    yearNumber: 1,
                    status: "current",
                    rolloverAtMs: null,
                  },
                ],
              },
            },
          ],
          freeAgents: [],
          providerHealth: { stale: true },
        };
      },
      previewAdd(input) {
        calls.previewAdd = input;
        return result(true);
      },
      applyAdd(input, idempotency) {
        calls.applyAdd = input;
        calls.applyAddIdempotency = idempotency;
        return result(false);
      },
      previewRemove(input) {
        calls.previewRemove = input;
        return result(true);
      },
      applyRemove(input, idempotency) {
        calls.applyRemove = input;
        calls.applyRemoveIdempotency = idempotency;
        return result(false);
      },
      previewRoster(input) {
        calls.previewRoster = input;
        return result(true);
      },
      applyRoster(input, idempotency) {
        calls.applyRoster = input;
        calls.applyRosterIdempotency = idempotency;
        return result(false);
      },
      previewContract(input) {
        calls.previewContract = input;
        return result(true);
      },
      applyContract(input, idempotency) {
        calls.applyContract = input;
        calls.applyContractIdempotency = idempotency;
        return result(false);
      },
    },
    clock: { nowMs: () => 1_700_000_000_000 },
    secureRandom: ids(),
  });
}

test("M7-10 reads an authoritative commissioner roster workspace", () => {
  const calls = {};
  const service = createService(calls);
  const response = service.readWorkspace({
    leagueId: IDS.league,
    authenticated: { valid: true },
  });

  assert.equal(response.code, "COMMISSIONER_ROSTER_WORKSPACE_FOUND");
  assert.equal(response.workspace.league.id, IDS.league);
  assert.deepEqual(calls.readWorkspace, {
    leagueId: IDS.league,
    actorUserId: IDS.user,
    actorMembershipId: IDS.membership,
    actorAuthority: "commissioner",
    observedAtMs: 1_700_000_000_000,
  });
  assert.equal(response.workspace.providerHealth.enabled, false);
});

test("M7-10 previews a commissioner roster change using server-owned identity and clock data", () => {
  const calls = {};
  const service = createService(calls);
  const response = service.previewRoster({
    leagueId: IDS.league,
    input: rosterBody(),
    authenticated: { valid: true },
  });

  assert.equal(response.code, "COMMISSIONER_ROSTER_CORRECTION_PREVIEWED");
  assert.equal(response.preview, true);
  assert.deepEqual(response.capImpact, [
    {
      teamId: IDS.team,
      cap: { capUsageCents: 10_100, capLimitCents: 10_000 },
      warnings: [{ code: "TEAM_OVER_CAP", teamId: IDS.team }],
    },
  ]);
  assert.equal(calls.previewRoster.actorUserId, IDS.user);
  assert.equal(calls.previewRoster.actorMembershipId, IDS.membership);
  assert.equal(calls.previewRoster.actorAuthority, "commissioner");
  assert.equal(calls.previewRoster.confirmWarnings, false);
  assert.equal(calls.previewRoster.occurredAtMs, 1_700_000_000_000);
});

test("M7-10 applies a confirmed contract correction and returns durable audit evidence", () => {
  const calls = {};
  const service = createService(calls);
  const response = service.applyContract({
    leagueId: IDS.league,
    input: contractBody({ confirmWarnings: true }),
    idempotencyKey: "contract-correction-one",
    authenticated: { valid: true },
  });

  assert.equal(response.code, "COMMISSIONER_CONTRACT_CORRECTION_APPLIED");
  assert.deepEqual(response.evidence, {
    correctionId: "correction-record",
    activityId: "activity-record",
    activityType: "commissioner_roster_corrected",
    occurredAtMs: 1_700_000_000_000,
  });
  assert.equal(calls.applyContract.confirmWarnings, true);
  assert.equal(calls.applyContract.actorUserId, IDS.user);
  assert.equal(calls.applyContract.correctedTeamId, IDS.team);
  assert.equal(calls.applyContract.correctedContractType, "normal");
  assert.equal(calls.applyContract.correctedStartSeasonId, IDS.season);
  assert.equal(calls.applyContract.correctedStatus, "active");
  assert.equal(
    calls.applyContract.correctedAuctionBuyoutLockExpiresAtMs,
    null
  );
  assert.deepEqual(
    calls.applyContract.correctedYears.map((year) => ({
      seasonId: year.seasonId,
      yearNumber: year.yearNumber,
      status: year.status,
      rolloverAtMs: year.rolloverAtMs,
    })),
    [
      {
        seasonId: IDS.season,
        yearNumber: 1,
        status: "current",
        rolloverAtMs: null,
      },
      {
        seasonId: IDS.seasonTwo,
        yearNumber: 2,
        status: "future",
        rolloverAtMs: null,
      },
      {
        seasonId: IDS.seasonThree,
        yearNumber: 3,
        status: "future",
        rolloverAtMs: null,
      },
    ]
  );
  assert.equal(
    calls.applyContractIdempotency.key,
    "contract-correction-one"
  );
  assert.match(
    calls.applyContractIdempotency.requestHash,
    /^[a-f0-9]{64}$/
  );
});

test("M7-10 revives a previously omitted future year when a contract term is restored", () => {
  const calls = {};
  const workspace = {
    league: {
      id: IDS.league,
      currentSeasonId: IDS.season,
    },
    teams: [],
    seasons: [
      { id: IDS.season, sequence: 1 },
      { id: IDS.seasonTwo, sequence: 2 },
      { id: IDS.seasonThree, sequence: 3 },
    ],
    roster: [
      {
        seasonId: IDS.season,
        playerId: IDS.player,
        teamId: IDS.team,
        contract: {
          id: IDS.contract,
          version: 3,
          teamId: IDS.team,
          type: "normal",
          originalTotalValueCents: 800,
          originalTermYears: 2,
          aavCents: 400,
          startSeasonId: IDS.season,
          status: "active",
          auctionBuyoutLockExpiresAtMs: null,
          years: [
            {
              id: IDS.contractYear,
              seasonId: IDS.season,
              yearNumber: 1,
              status: "current",
              rolloverAtMs: null,
            },
            {
              id: "00000000-0000-4000-8000-000000000012",
              seasonId: IDS.seasonTwo,
              yearNumber: 2,
              status: "future",
              rolloverAtMs: null,
            },
            {
              id: "00000000-0000-4000-8000-000000000013",
              seasonId: IDS.seasonThree,
              yearNumber: 3,
              status: "eliminated",
              rolloverAtMs: 1_699_999_999_000,
            },
          ],
        },
      },
    ],
    freeAgents: [],
    providerHealth: { stale: false },
  };
  const service = createService(calls, workspace);

  service.applyContract({
    leagueId: IDS.league,
    input: contractBody({
      expectedVersion: 3,
      correctedOriginalTotalValueCents: 1_200,
      correctedOriginalTermYears: 3,
      confirmWarnings: true,
    }),
    idempotencyKey: "contract-term-restored",
    authenticated: { valid: true },
  });

  assert.deepEqual(
    calls.applyContract.correctedYears.map((year) => ({
      id: year.id,
      status: year.status,
      rolloverAtMs: year.rolloverAtMs,
    })),
    [
      {
        id: IDS.contractYear,
        status: "current",
        rolloverAtMs: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        status: "future",
        rolloverAtMs: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000013",
        status: "future",
        rolloverAtMs: null,
      },
    ]
  );
});

test("M7-10 fails closed before authorization or persistence when a body includes untrusted fields", () => {
  const calls = {};
  const service = createService(calls);
  assert.throws(
    () =>
      service.applyRoster({
        leagueId: IDS.league,
        input: rosterBody({
          confirmWarnings: true,
          actorUserId: "00000000-0000-4000-8000-000000000099",
        }),
        authenticated: { valid: true },
      }),
    (error) => error instanceof CommissionerCorrectionPolicyError
  );
  assert.equal(calls.authority, undefined);
  assert.equal(calls.applyRoster, undefined);
});

test("M7-10 rejects an unbounded roster-add term before allocating IDs or calling the correction repository", () => {
  const calls = {};
  const service = createService(calls);

  assert.throws(
    () =>
      service.previewAdd({
        leagueId: IDS.league,
        input: addBody({ termYears: Number.MAX_SAFE_INTEGER }),
        authenticated: { valid: true },
      }),
    (error) =>
      error instanceof CommissionerCorrectionPolicyError &&
      error.reasonCode === "COMMISSIONER_CORRECTION_CONTRACT_INVALID"
  );
  assert.equal(calls.previewAdd, undefined);
});

test("M7-10 rejects client-authored contract lifecycle and schedule fields", () => {
  const calls = {};
  const service = createService(calls);

  assert.throws(
    () =>
      service.previewContract({
        leagueId: IDS.league,
        input: contractBody({ correctedTeamId: IDS.team }),
        authenticated: { valid: true },
      }),
    (error) => error instanceof CommissionerCorrectionPolicyError
  );
  assert.equal(calls.authority, undefined);
  assert.equal(calls.readWorkspace, undefined);
  assert.equal(calls.previewContract, undefined);
});
