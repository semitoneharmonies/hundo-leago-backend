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
  teamTwo: "00000000-0000-4000-8000-000000000013",
  ownershipTwo: "00000000-0000-4000-8000-000000000014",
  user: "00000000-0000-4000-8000-000000000007",
  membership: "00000000-0000-4000-8000-000000000008",
  seasonTwo: "00000000-0000-4000-8000-000000000009",
  seasonThree: "00000000-0000-4000-8000-000000000010",
  contractYear: "00000000-0000-4000-8000-000000000011",
  lock: "00000000-0000-4000-8000-000000000012",
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

function removeBody(overrides = {}) {
  return {
    seasonId: IDS.season,
    ownershipId: IDS.ownership,
    playerId: IDS.player,
    expectedVersion: 2,
    contractId: IDS.contract,
    expectedContractVersion: 2,
    reason: null,
    ...overrides,
  };
}

function committedOwnership(version) {
  return Object.freeze({
    id: IDS.ownership,
    leagueId: IDS.league,
    seasonId: IDS.season,
    playerId: IDS.player,
    teamId: IDS.team,
    ownershipKind: "Rostered",
    rosterCategory: "Active",
    positionGroup: "F",
    slotNumber: 1,
    version,
  });
}

function result(preview, kind = "roster") {
  const before = kind === "add"
    ? { ownership: null, contract: null }
    : kind === "remove"
      ? { ownership: committedOwnership(2), contract: { id: IDS.contract } }
      : { version: 2 };
  const authoritative = kind === "add"
    ? { ownership: committedOwnership(1), contract: { id: IDS.contract } }
    : kind === "remove"
      ? { ownership: null, contract: { id: IDS.contract, status: "cancelled" } }
      : { version: 3 };
  const witness = kind === "add"
    ? {
        ownershipId: IDS.ownership,
        ownershipVersion: 1,
        state: "present",
      }
    : kind === "remove"
      ? {
          ownershipId: IDS.ownership,
          ownershipVersion: 2,
          state: "deleted",
        }
      : {
          ownershipId: IDS.ownership,
          ownershipVersion: kind === "contract" ? 2 : 3,
          state: "present",
        };
  return {
    preview,
    before,
    requested: { aavCents: 400 },
    authoritative,
    warnings: [{ code: "TEAM_OVER_CAP", teamId: IDS.team }],
    teamEvaluations: [
      {
        teamId: IDS.team,
        cap: { capUsageCents: 10_100, capLimitCents: 10_000 },
        warnings: [{ code: "TEAM_OVER_CAP", teamId: IDS.team }],
      },
    ],
    committedRoster: {
      teams: [
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          teamId: IDS.team,
          ownershipWitnesses: kind === "contract" ? [] : [witness],
        },
      ],
    },
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

function createService(
  calls,
  workspaceOverride = null,
  lateLockCoordinatorOverride = null
) {
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
        return result(true, "add");
      },
      applyAdd(input, idempotency) {
        calls.applyAdd = input;
        calls.applyAddIdempotency = idempotency;
        return result(false, "add");
      },
      previewRemove(input) {
        calls.previewRemove = input;
        return result(true, "remove");
      },
      applyRemove(input, idempotency) {
        calls.applyRemove = input;
        calls.applyRemoveIdempotency = idempotency;
        return result(false, "remove");
      },
      previewRoster(input) {
        calls.previewRoster = input;
        return result(true);
      },
      applyRoster(input, idempotency) {
        calls.applyRoster = input;
        calls.applyRosterIdempotency = idempotency;
        return calls.applyRosterResult || result(false);
      },
      previewContract(input) {
        calls.previewContract = input;
        return result(true, "contract");
      },
      applyContract(input, idempotency) {
        calls.applyContract = input;
        calls.applyContractIdempotency = idempotency;
        return result(false, "contract");
      },
    },
    lateLockCoordinator: lateLockCoordinatorOverride || {
      async coordinateCommittedRoster(input) {
        calls.coordinateCommittedRoster = input;
        return Object.freeze({ status: "not_applicable" });
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

test("FAD-05 coordinates a committed commissioner addition with its exact present ownership", async () => {
  const calls = {};
  const service = createService(calls, null, {
    async coordinateCommittedRoster(input) {
      calls.coordinateCommittedRoster = input;
      return Object.freeze({ status: "completed", lockId: IDS.lock });
    },
  });

  const response = await service.applyAdd({
    leagueId: IDS.league,
    input: addBody({ confirmWarnings: true }),
    idempotencyKey: "commissioner-add-one",
    authenticated: { valid: true },
  });

  assert.deepEqual(calls.coordinateCommittedRoster, {
    mutationKind: "commissioner_addition",
    teams: [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        teamId: IDS.team,
        ownershipWitnesses: [
          {
            ownershipId: IDS.ownership,
            ownershipVersion: 1,
            state: "present",
          },
        ],
      },
    ],
  });
  assert.deepEqual(response.lateLock, {
    status: "completed",
    lockId: IDS.lock,
  });
  assert.equal(response.authoritative.ownership.version, 1);
});

test("FAD-05 coordinates a committed commissioner removal with its exact deleted last version", async () => {
  const calls = {};
  const service = createService(calls);

  const response = await service.applyRemove({
    leagueId: IDS.league,
    input: removeBody({ confirmWarnings: true }),
    idempotencyKey: "commissioner-remove-one",
    authenticated: { valid: true },
  });

  assert.deepEqual(calls.coordinateCommittedRoster, {
    mutationKind: "commissioner_removal",
    teams: [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        teamId: IDS.team,
        ownershipWitnesses: [
          {
            ownershipId: IDS.ownership,
            ownershipVersion: 2,
            state: "deleted",
          },
        ],
      },
    ],
  });
  assert.deepEqual(response.lateLock, { status: "not_applicable" });
  assert.equal(response.before.ownership.version, 2);
  assert.equal(response.authoritative.ownership, null);
});

test("FAD-05 coordinates a committed same-team commissioner correction with its updated tenure", async () => {
  const calls = {};
  const service = createService(calls);

  const response = await service.applyRoster({
    leagueId: IDS.league,
    input: rosterBody({ confirmWarnings: true }),
    idempotencyKey: "commissioner-roster-correction-one",
    authenticated: { valid: true },
  });

  assert.deepEqual(calls.coordinateCommittedRoster, {
    mutationKind: "commissioner_correction",
    teams: [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        teamId: IDS.team,
        ownershipWitnesses: [
          {
            ownershipId: IDS.ownership,
            ownershipVersion: 3,
            state: "present",
          },
        ],
      },
    ],
  });
  assert.deepEqual(response.lateLock, { status: "not_applicable" });
  assert.equal(Object.isFrozen(response), true);
});

test("FAD-05 coordinates both committed teams for a commissioner tenure transfer", async () => {
  const calls = {};
  calls.applyRosterResult = {
    ...result(false),
    committedRoster: {
      teams: [
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          teamId: IDS.team,
          ownershipWitnesses: [
            {
              ownershipId: IDS.ownership,
              ownershipVersion: 2,
              state: "deleted",
            },
          ],
        },
        {
          leagueId: IDS.league,
          seasonId: IDS.season,
          teamId: IDS.teamTwo,
          ownershipWitnesses: [
            {
              ownershipId: IDS.ownershipTwo,
              ownershipVersion: 1,
              state: "present",
            },
          ],
        },
      ],
      ownershipTransfer: {
        sourceOwnershipId: IDS.ownership,
        sourceOwnershipVersion: 2,
        destinationOwnershipId: IDS.ownershipTwo,
        destinationOwnershipVersion: 1,
      },
    },
  };
  const service = createService(calls);

  const response = await service.applyRoster({
    leagueId: IDS.league,
    input: rosterBody({
      correctedTeamId: IDS.teamTwo,
      confirmWarnings: true,
    }),
    idempotencyKey: "commissioner-roster-transfer-one",
    authenticated: { valid: true },
  });

  assert.deepEqual(calls.coordinateCommittedRoster, {
    mutationKind: "commissioner_correction",
    teams: calls.applyRosterResult.committedRoster.teams,
  });
  assert.deepEqual(response.lateLock, { status: "not_applicable" });
  assert.equal(Object.isFrozen(response), true);
});

test("FAD-05 commissioner previews remain synchronous and never coordinate", () => {
  const calls = {};
  const service = createService(calls);

  const add = service.previewAdd({
    leagueId: IDS.league,
    input: addBody(),
    authenticated: { valid: true },
  });
  const remove = service.previewRemove({
    leagueId: IDS.league,
    input: removeBody(),
    authenticated: { valid: true },
  });
  const roster = service.previewRoster({
    leagueId: IDS.league,
    input: rosterBody(),
    authenticated: { valid: true },
  });
  const contract = service.previewContract({
    leagueId: IDS.league,
    input: contractBody(),
    authenticated: { valid: true },
  });

  assert.equal(add.preview, true);
  assert.equal(remove.preview, true);
  assert.equal(roster.preview, true);
  assert.equal(contract.preview, true);
  assert.equal(typeof add?.then, "undefined");
  assert.equal(typeof remove?.then, "undefined");
  assert.equal(Object.hasOwn(add, "lateLock"), false);
  assert.equal(Object.hasOwn(remove, "lateLock"), false);
  assert.equal(Object.hasOwn(roster, "lateLock"), false);
  assert.equal(Object.hasOwn(contract, "lateLock"), false);
  assert.equal(calls.coordinateCommittedRoster, undefined);
});

test("FAD-05 contains commissioner post-commit coordination failures as awaiting data", async () => {
  const calls = {};
  const service = createService(calls, null, {
    async coordinateCommittedRoster(input) {
      calls.coordinateCommittedRoster = input;
      throw new Error("private late-lock failure");
    },
  });

  const response = await service.applyAdd({
    leagueId: IDS.league,
    input: addBody({ confirmWarnings: true }),
    idempotencyKey: "commissioner-add-fallback",
    authenticated: { valid: true },
  });

  assert.ok(calls.applyAdd);
  assert.ok(calls.coordinateCommittedRoster);
  assert.deepEqual(response.lateLock, { status: "awaiting_data" });
  assert.equal(JSON.stringify(response).includes("private late-lock failure"), false);
});

test("FAD-05 rejects unsafe commissioner late-lock details from the response", async () => {
  const calls = {};
  const service = createService(calls, null, {
    async coordinateCommittedRoster(input) {
      calls.coordinateCommittedRoster = input;
      return {
        status: "completed",
        lockId: IDS.lock,
        internalFailure: "must not escape",
      };
    },
  });

  const response = await service.applyRemove({
    leagueId: IDS.league,
    input: removeBody({ confirmWarnings: true }),
    idempotencyKey: "commissioner-remove-safe-projection",
    authenticated: { valid: true },
  });

  assert.deepEqual(response.lateLock, { status: "awaiting_data" });
  assert.equal(JSON.stringify(response).includes("must not escape"), false);
});

test("M7-10 applies a confirmed contract correction and returns durable audit evidence", async () => {
  const calls = {};
  const service = createService(calls);
  const response = await service.applyContract({
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
  assert.deepEqual(calls.coordinateCommittedRoster, {
    mutationKind: "contract_correction",
    teams: [
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        teamId: IDS.team,
        ownershipWitnesses: [],
      },
    ],
  });
  assert.deepEqual(response.lateLock, { status: "not_applicable" });
});

test("M7-10 revives a previously omitted future year when a contract term is restored", async () => {
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

  await service.applyContract({
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

test("M7-10 fails closed before authorization or persistence when a body includes untrusted fields", async () => {
  const calls = {};
  const service = createService(calls);
  await assert.rejects(
    async () =>
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
