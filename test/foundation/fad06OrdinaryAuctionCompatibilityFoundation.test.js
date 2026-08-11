"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildAuctionResolutionOccurrenceKey,
  evaluateAuctionResolution,
} = require(
  "../../src/domain/auctions/auctionResolutionPolicy"
);
const {
  createAuctionAdministrationService,
} = require(
  "../../src/application/services/auctions/createAuctionAdministrationService"
);
const {
  createAuctionResolutionService,
} = require(
  "../../src/application/services/auctions/createAuctionResolutionService"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  createSqliteAuctionAdministrationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionAdministrationRepository"
);
const {
  createSqliteAuctionResolutionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  JOB_NAME,
  createResolveTargetAuctionsJob,
} = require(
  "../../src/jobs/definitions/resolveTargetAuctions"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const OPEN_MS = Date.parse(
  "2026-07-21T19:00:00.000Z"
);
const DUE_MS = Date.parse(
  "2026-07-26T23:00:00.000Z"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(60_000),
  season: uuid(60_001),
  teamA: uuid(60_002),
  teamB: uuid(60_003),
  player: uuid(60_004),
  playerSource: uuid(60_005),
  managerA: uuid(60_006),
  managerB: uuid(60_007),
  commissioner: uuid(60_008),
  membershipA: uuid(60_009),
  membershipB: uuid(60_010),
  commissionerMembership: uuid(60_011),
  assignmentA: uuid(60_012),
  assignmentB: uuid(60_013),
  auction: uuid(60_014),
  bidA: uuid(60_015),
  bidB: uuid(60_016),
  eventA: uuid(60_017),
  eventB: uuid(60_018),
});

function policyAuction(overrides = {}) {
  return {
    id: IDS.auction,
    leagueId: IDS.league,
    playerId: IDS.player,
    status: "open",
    resolvesAtMs: DUE_MS,
    playoffsStartAtMs: DUE_MS + 86_400_000,
    playerOwned: false,
    nowMs: DUE_MS,
    ...overrides,
  };
}

function policyBid(sequence, overrides = {}) {
  return {
    id: uuid(61_000 + sequence),
    leagueId: IDS.league,
    auctionId: IDS.auction,
    teamId: uuid(62_000 + sequence),
    status: "active",
    teamStatus: "active",
    totalValueCents: 1_000,
    termYears: 2,
    lowestOfferedAavCents: 100,
    firstSubmittedAtMs: OPEN_MS + sequence,
    isStartingBid: false,
    authorityValid: true,
    ...overrides,
  };
}

function winningBidId(bids) {
  return evaluateAuctionResolution({
    auction: policyAuction(),
    bids,
  }).winner.bidId;
}

function insertUser(
  repositories,
  id,
  displayName
) {
  repositories.users.insert({
    id,
    email_normalized:
      `${displayName.toLowerCase()}@example.test`,
    email_display:
      `${displayName.toLowerCase()}@example.test`,
    display_name: displayName,
    display_name_normalized:
      displayName.toLowerCase(),
    status: "active",
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertTeam(repositories, id, name) {
  repositories.teams.insert({
    id,
    league_id: IDS.league,
    name,
    name_normalized: name.toLowerCase(),
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertMembership(
  repositories,
  id,
  userId,
  permissionCategory
) {
  repositories.league_memberships.insert({
    id,
    league_id: IDS.league,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
}

function insertAssignment(
  repositories,
  id,
  teamId,
  userId,
  membershipId
) {
  repositories.team_manager_assignments.insert({
    id,
    league_id: IDS.league,
    team_id: teamId,
    user_id: userId,
    membership_id: membershipId,
    assigned_by_user_id: IDS.commissioner,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: OPEN_MS - 1_000,
    accepted_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
}

function createPersistenceRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad06-ordinary-compatibility-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId:
      "fad06-ordinary-auction-compatibility",
    now: () => OPEN_MS,
  });
  const { repositories } =
    createSqliteRepositoryContext({
      database: connection.database,
    });

  insertUser(
    repositories,
    IDS.managerA,
    "ManagerA"
  );
  insertUser(
    repositories,
    IDS.managerB,
    "ManagerB"
  );
  insertUser(
    repositories,
    IDS.commissioner,
    "Commissioner"
  );
  repositories.leagues.insert({
    id: IDS.league,
    name: "FAD 06 Compatibility League",
    name_normalized:
      "fad 06 compatibility league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: IDS.league,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: IDS.season,
    league_id: IDS.league,
    label: "2026",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms:
      OPEN_MS - 86_400_000,
    regular_season_ends_at_ms:
      DUE_MS + 200_000_000,
    fantasy_playoffs_start_at_ms:
      DUE_MS + 86_400_000,
    fantasy_playoffs_end_at_ms:
      DUE_MS + 172_800_000,
    free_agent_draft_completed_at_ms:
      OPEN_MS - 1,
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  insertTeam(repositories, IDS.teamA, "Alpha");
  insertTeam(repositories, IDS.teamB, "Bravo");
  insertMembership(
    repositories,
    IDS.membershipA,
    IDS.managerA,
    "manager"
  );
  insertMembership(
    repositories,
    IDS.membershipB,
    IDS.managerB,
    "manager"
  );
  insertMembership(
    repositories,
    IDS.commissionerMembership,
    IDS.commissioner,
    "commissioner"
  );
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        IDS.commissionerMembership,
      current_season_id: IDS.season,
      updated_at_ms: OPEN_MS,
    },
  });
  insertAssignment(
    repositories,
    IDS.assignmentA,
    IDS.teamA,
    IDS.managerA,
    IDS.membershipA
  );
  insertAssignment(
    repositories,
    IDS.assignmentB,
    IDS.teamB,
    IDS.managerB,
    IDS.membershipB
  );
  repositories.players.insert({
    id: IDS.player,
    first_name: "Target",
    last_name: "Player",
    full_name: "Target Player",
    birth_date: null,
    status: "active",
    created_at_ms: OPEN_MS - 1_000,
    updated_at_ms: OPEN_MS - 1_000,
    version: 1,
  });
  repositories.player_source_state.insert({
    id: IDS.playerSource,
    player_id: IDS.player,
    provider: "test",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "TST",
    active: 1,
    source_version: "one",
    source_payload_json: null,
    effective_at_ms: OPEN_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: OPEN_MS - 1_000,
  });
  repositories.auctions.insert({
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: IDS.player,
    status: "open",
    opened_at_ms: OPEN_MS,
    resolves_at_ms: DUE_MS,
    opened_by_user_id: IDS.managerA,
    created_at_ms: OPEN_MS,
    updated_at_ms: OPEN_MS,
    version: 1,
  });
  repositories.auction_contexts.insert({
    id: IDS.auction,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.auction,
    source_kind: "ordinary_weekly",
    fad_id: null,
    fad_rollover_id: null,
    fad_allocation_id: null,
    created_at_ms: OPEN_MS,
  });

  function insertBid({
    id,
    teamId,
    userId,
    membershipId,
    eventId,
    eventType,
    occurredAtMs,
    totalValueCents,
    termYears,
    lowestOfferedAavCents,
  }) {
    repositories.auction_bids.insert({
      id,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.auction,
      team_id: teamId,
      submitted_by_user_id: userId,
      total_value_cents: totalValueCents,
      term_years: termYears,
      lowest_offered_aav_cents:
        lowestOfferedAavCents,
      first_submitted_at_ms: occurredAtMs,
      last_edited_at_ms: occurredAtMs,
      edit_count: 0,
      status: "active",
      idempotency_request_id: null,
      version: 1,
    });
    const whole = Math.floor(
      totalValueCents / termYears
    );
    const remainder = totalValueCents % termYears;
    const aavCents =
      whole +
      (remainder * 2 >= termYears ? 1 : 0);
    const values = {
      totalValueCents,
      termYears,
      aavCents,
      lowestOfferedAavCents,
      editCount: 0,
      version: 1,
    };
    repositories.auction_events.insert({
      id: eventId,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.auction,
      bid_id: id,
      team_id: teamId,
      actor_user_id: userId,
      event_type: eventType,
      metadata_json: JSON.stringify({
        actorMembershipId: membershipId,
        actorAuthority: "manager",
        ...(eventType === "auction_started"
          ? values
          : { before: null, after: values }),
      }),
      occurred_at_ms: occurredAtMs,
    });
  }

  insertBid({
    id: IDS.bidA,
    teamId: IDS.teamA,
    userId: IDS.managerA,
    membershipId: IDS.membershipA,
    eventId: IDS.eventA,
    eventType: "auction_started",
    occurredAtMs: OPEN_MS,
    totalValueCents: 1_000,
    termYears: 3,
    lowestOfferedAavCents: 100,
  });
  insertBid({
    id: IDS.bidB,
    teamId: IDS.teamB,
    userId: IDS.managerB,
    membershipId: IDS.membershipB,
    eventId: IDS.eventB,
    eventType: "bid_submitted",
    occurredAtMs: OPEN_MS + 1,
    totalValueCents: 500,
    termYears: 2,
    lowestOfferedAavCents: 250,
  });

  return {
    database: connection.database,
  };
}

describe(
  "FAD-06 ordinary auction compatibility characterization",
  () => {
    test(
      "keeps AAV, shorter-term, original-time, then stable-ID ranking and exact due pricing",
      () => {
        const highAav = policyBid(2, {
          totalValueCents: 1_500,
          termYears: 3,
          firstSubmittedAtMs: OPEN_MS + 2,
        });
        const lowerAav = policyBid(1, {
          totalValueCents: 400,
          termYears: 1,
          firstSubmittedAtMs: OPEN_MS + 1,
        });
        assert.equal(
          winningBidId([lowerAav, highAav]),
          highAav.id
        );

        const longTerm = policyBid(3, {
          totalValueCents: 1_500,
          termYears: 3,
          firstSubmittedAtMs: OPEN_MS + 1,
        });
        const shortTerm = policyBid(4, {
          totalValueCents: 500,
          termYears: 1,
          firstSubmittedAtMs: OPEN_MS + 2,
        });
        assert.equal(
          winningBidId([longTerm, shortTerm]),
          shortTerm.id
        );

        const earlier = policyBid(5, {
          firstSubmittedAtMs: OPEN_MS + 1,
        });
        const later = policyBid(6, {
          firstSubmittedAtMs: OPEN_MS + 2,
        });
        assert.equal(
          winningBidId([later, earlier]),
          earlier.id
        );

        const lowerStableId = policyBid(7, {
          firstSubmittedAtMs: OPEN_MS + 1,
        });
        const higherStableId = policyBid(8, {
          firstSubmittedAtMs: OPEN_MS + 1,
        });
        assert.equal(
          winningBidId([
            higherStableId,
            lowerStableId,
          ]),
          lowerStableId.id
        );

        const pricingBids = [
          policyBid(9, {
            totalValueCents: 1_000,
            termYears: 3,
            lowestOfferedAavCents: 100,
          }),
          policyBid(10, {
            totalValueCents: 500,
            termYears: 2,
            lowestOfferedAavCents: 250,
          }),
        ];
        assert.deepEqual(
          evaluateAuctionResolution({
            auction: policyAuction({
              nowMs: DUE_MS - 1,
            }),
            bids: pricingBids,
          }),
          {
            auctionId: IDS.auction,
            leagueId: IDS.league,
            dueAtMs: DUE_MS,
            outcome: "not_due",
            reason: "before_deadline",
          }
        );
        const exactDue = evaluateAuctionResolution({
          auction: policyAuction(),
          bids: pricingBids,
        });
        assert.equal(exactDue.dueAtMs, DUE_MS);
        assert.equal(exactDue.outcome, "winner");
        assert.deepEqual(exactDue.winner, {
          bidId: pricingBids[0].id,
          teamId: pricingBids[0].teamId,
          submittedTotalValueCents: 1_000,
          submittedTermYears: 3,
          submittedAavCents: 333,
          lowestOfferedAavCents: 100,
          highestCompetingAavCents: 250,
          requiredWinningAavCents: 250,
          finalTotalValueCents: 800,
          finalAavCents: 267,
        });
      }
    );

    test(
      "keeps T083 enqueue-only and lets its durable job use ordinary completion side effects",
      async (t) => {
        const runtime = createPersistenceRuntime(t);
        let nowMs = DUE_MS - 1;
        let administrationId = 70_000;
        const administrationRepository =
          createSqliteAuctionAdministrationRepository({
            database: runtime.database,
            createId: () => uuid(administrationId++),
          });
        const administrationService =
          createAuctionAdministrationService({
            leagueAuthorization: {
              requireCommissioner(
                authenticated,
                leagueId
              ) {
                assert.deepEqual(authenticated, {
                  userId: IDS.commissioner,
                });
                assert.equal(leagueId, IDS.league);
                return {
                  actorUserId: IDS.commissioner,
                  membershipId:
                    IDS.commissionerMembership,
                  leagueId,
                  authority: "commissioner",
                };
              },
            },
            repository: administrationRepository,
            clock: { nowMs: () => nowMs },
          });
        const request = (idempotencyKey) =>
          administrationService.requestResolution({
            leagueId: IDS.league,
            auctionId: IDS.auction,
            input: {
              confirmation: "RESOLVE AUCTION",
            },
            expectedAuctionVersion: 1,
            idempotencyKey,
            authenticated: {
              userId: IDS.commissioner,
            },
          });

        assert.throws(
          () => request("fad06-before-due"),
          (error) =>
            error.code ===
            "AUCTION_ADMINISTRATION_NOT_DUE"
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT COUNT(*) AS count FROM job_runs"
            )
            .get().count,
          0
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM idempotency_requests
              WHERE operation = 'auction.resolve.request'
            `)
            .get().count,
          0
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM auction_administration_command_results
            `)
            .get().count,
          0
        );

        nowMs = DUE_MS;
        const accepted = request("fad06-at-due");
        assert.equal(accepted.httpStatus, 202);
        assert.equal(accepted.data.status, "pending");
        assert.equal(
          accepted.data.occurrenceKey,
          buildAuctionResolutionOccurrenceKey({
            auctionId: IDS.auction,
            dueAtMs: DUE_MS,
          })
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT job_type, occurrence_key,
                scheduled_for_ms, status
              FROM job_runs
              WHERE id = ?
            `)
            .get(accepted.data.operationId),
          {
            job_type: "auction.resolve.target",
            occurrence_key:
              accepted.data.occurrenceKey,
            scheduled_for_ms: DUE_MS,
            status: "pending",
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(
              "SELECT status, version FROM auctions WHERE id = ?"
            )
            .get(IDS.auction),
          { status: "open", version: 1 }
        );
        for (const tableName of [
          "auction_resolutions",
          "contracts",
          "player_ownerships",
        ]) {
          assert.equal(
            runtime.database
              .prepare(
                `SELECT COUNT(*) AS count FROM ${tableName}`
              )
              .get().count,
            0
          );
        }

        const summerSynchronizationCalls = [];
        const resolutionRepository =
          createSqliteAuctionResolutionRepository({
            database: runtime.database,
            candidateCardSummerSynchronizer: {
              synchronize(input) {
                assert.equal(runtime.database.inTransaction, true);
                summerSynchronizationCalls.push(input);
              },
            },
          });
        const failedClaim =
          resolutionRepository.claimRun({
            jobRunId: uuid(79_999),
            leagueId: IDS.league,
            seasonId: IDS.season,
            occurrenceKey:
              accepted.data.occurrenceKey,
            scheduledForMs: DUE_MS,
            leaseOwner: "fad06-failing-worker",
            nowMs: DUE_MS,
            leaseExpiresAtMs: DUE_MS + 60_000,
          });
        assert.deepEqual(failedClaim, {
          acquired: true,
          runId: accepted.data.operationId,
          version: 2,
          attemptCount: 1,
        });
        assert.deepEqual(
          resolutionRepository.failRun({
            leagueId: IDS.league,
            runId: failedClaim.runId,
            leaseOwner: "fad06-failing-worker",
            expectedVersion: failedClaim.version,
            completedAtMs: DUE_MS,
            errorCode: "AUCTION_RESOLUTION_INCOMPLETE",
          }),
          {
            runId: accepted.data.operationId,
            status: "failed",
            version: 3,
          }
        );

        const retried = request(
          "fad06-retry-after-failure"
        );
        assert.equal(retried.httpStatus, 202);
        assert.equal(retried.data.status, "pending");
        assert.equal(
          retried.data.operationId,
          accepted.data.operationId
        );
        assert.equal(
          retried.data.occurrenceKey,
          accepted.data.occurrenceKey
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, attempt_count, version
              FROM job_runs
              WHERE id = ?
            `)
            .get(accepted.data.operationId),
          {
            status: "pending",
            attempt_count: 1,
            version: 4,
          }
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT COUNT(*) AS count FROM job_runs"
            )
            .get().count,
          1
        );

        const evidenceBeforeChangedInput =
          runtime.database
            .prepare(`
              SELECT
                (SELECT COUNT(*)
                 FROM idempotency_requests
                 WHERE operation =
                   'auction.resolve.request') AS requests,
                (SELECT COUNT(*)
                 FROM auction_administration_command_results)
                   AS results,
                (SELECT COUNT(*) FROM job_runs) AS jobs
            `)
            .get();
        assert.throws(
          () =>
            administrationService.requestResolution({
              leagueId: IDS.league,
              auctionId: IDS.auction,
              input: {
                confirmation: "RESOLVE AUCTION",
              },
              expectedAuctionVersion: 2,
              idempotencyKey: "fad06-at-due",
              authenticated: {
                userId: IDS.commissioner,
              },
            }),
          (error) =>
            error.code === "IDEMPOTENCY_KEY_REUSED"
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                (SELECT COUNT(*)
                 FROM idempotency_requests
                 WHERE operation =
                   'auction.resolve.request') AS requests,
                (SELECT COUNT(*)
                 FROM auction_administration_command_results)
                   AS results,
                (SELECT COUNT(*) FROM job_runs) AS jobs
            `)
            .get(),
          evidenceBeforeChangedInput
        );

        const completionCalls = [];
        let completionId = 80_000;
        const lateLockCalls = [];
        const resolutionService =
          createAuctionResolutionService({
            repository: {
              completeDue(input) {
                completionCalls.push(input);
                return resolutionRepository.completeDue(
                  input
                );
              },
            },
            lateLockCoordinator: {
              async coordinateCommittedRoster(batch) {
                lateLockCalls.push(batch);
                return { status: "not_applicable" };
              },
            },
            secureRandom: {
              id: () => uuid(completionId++),
            },
          });
        assert.equal(completionCalls.length, 0);
        const job = createResolveTargetAuctionsJob({
          repository: resolutionRepository,
          resolutionService,
          clock: { nowMs: () => DUE_MS },
          secureRandom: { id: () => uuid(90_000) },
          leaseOwner: "fad06-compatibility-worker",
          leaseDurationMs: 60_000,
          batchSize: 10,
          logger: { error() {} },
        });

        assert.deepEqual(await job.run(), {
          job: JOB_NAME,
          status: "succeeded",
          due: 1,
          acquired: 1,
          completed: 1,
          failed: 0,
          skipped: 0,
        });
        assert.equal(completionCalls.length, 1);
        assert.deepEqual(
          {
            leagueId: completionCalls[0].leagueId,
            auctionId: completionCalls[0].auctionId,
            occurrenceKey:
              completionCalls[0].occurrenceKey,
            expectedAuctionVersion:
              completionCalls[0]
                .expectedAuctionVersion,
            nowMs: completionCalls[0].nowMs,
          },
          {
            leagueId: IDS.league,
            auctionId: IDS.auction,
            occurrenceKey:
              accepted.data.occurrenceKey,
            expectedAuctionVersion: 1,
            nowMs: DUE_MS,
          }
        );
        assert.equal(lateLockCalls.length, 1);
        assert.deepEqual(
          runtime.database
            .prepare(
              "SELECT status, version FROM auctions WHERE id = ?"
            )
            .get(IDS.auction),
          { status: "resolved", version: 2 }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT id, status, version
              FROM auction_bids
              ORDER BY id
            `)
            .all(),
          [
            {
              id: IDS.bidA,
              status: "won",
              version: 2,
            },
            {
              id: IDS.bidB,
              status: "lost",
              version: 2,
            },
          ]
        );
        const resolution = runtime.database
          .prepare(
            "SELECT * FROM auction_resolutions"
          )
          .get();
        assert.deepEqual(summerSynchronizationCalls, [
          {
            leagueId: IDS.league,
            affectedTeamIds: [IDS.teamA],
            affectedPlayerIds: [IDS.player],
            sourceOperationId: resolution.id,
            sourceKind: "auction_allocation",
            nowMs: DUE_MS,
          },
        ]);
        assert.equal(
          resolution.winning_bid_id,
          IDS.bidA
        );
        assert.equal(
          resolution.highest_bid_cents,
          1_000
        );
        assert.equal(
          resolution.second_price_input_cents,
          250
        );
        assert.equal(
          resolution.final_contract_value_cents,
          800
        );
        assert.equal(
          resolution.winning_term_years,
          3
        );
        assert.equal(resolution.final_aav_cents, 267);

        const contract = runtime.database
          .prepare("SELECT * FROM contracts")
          .get();
        assert.equal(
          contract.original_total_value_cents,
          800
        );
        assert.equal(
          contract.original_term_years,
          3
        );
        assert.equal(contract.aav_cents, 267);
        assert.equal(
          contract.auction_buyout_lock_expires_at_ms,
          DUE_MS + 14 * 24 * 60 * 60 * 1_000
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT year_number, aav_cents, status
              FROM contract_years
              ORDER BY year_number
            `)
            .all(),
          [
            {
              year_number: 1,
              aav_cents: 267,
              status: "current",
            },
            {
              year_number: 2,
              aav_cents: 267,
              status: "future",
            },
            {
              year_number: 3,
              aav_cents: 267,
              status: "future",
            },
          ]
        );
        const ownership = runtime.database
          .prepare(
            "SELECT * FROM player_ownerships"
          )
          .get();
        assert.equal(ownership.team_id, IDS.teamA);
        assert.equal(
          ownership.roster_category,
          "Active"
        );
        assert.equal(ownership.position_group, "F");
        assert.equal(ownership.slot_number, 1);
        assert.equal(
          ownership.acquired_transaction_type,
          "auction_resolution"
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, attempt_count,
                result_json
              FROM job_runs
              WHERE id = ?
            `)
            .get(accepted.data.operationId),
          {
            status: "succeeded",
            attempt_count: 2,
            result_json: JSON.stringify({
              auctionId: IDS.auction,
              outcome: "resolved",
            }),
          }
        );
        const replayed = request(
          "fad06-retry-after-failure"
        );
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.httpStatus, 202);
        assert.deepEqual(replayed.data, retried.data);
        assert.equal(
          replayed.data.status,
          "pending"
        );
        assert.deepEqual(
          request("fad06-at-due").data,
          accepted.data
        );
        assert.deepEqual(
          runtime.database.pragma(
            "foreign_key_check"
          ),
          []
        );
      }
    );

    test(
      "rejects a malformed FAD T083 context before creating administration evidence or a job",
      (t) => {
        const runtime = createPersistenceRuntime(t);
        runtime.database.exec(`
          DROP TRIGGER auction_contexts_immutable_update;
          PRAGMA ignore_check_constraints = ON;
        `);
        runtime.database
          .prepare(`
            UPDATE auction_contexts
            SET source_kind = 'fad_open_rapid'
            WHERE auction_id = ?
          `)
          .run(IDS.auction);

        let generatedIds = 0;
        const administrationService =
          createAuctionAdministrationService({
            leagueAuthorization: {
              requireCommissioner() {
                return {
                  actorUserId: IDS.commissioner,
                  membershipId:
                    IDS.commissionerMembership,
                  leagueId: IDS.league,
                  authority: "commissioner",
                };
              },
            },
            repository:
              createSqliteAuctionAdministrationRepository({
                database: runtime.database,
                createId() {
                  generatedIds += 1;
                  return uuid(95_000 + generatedIds);
                },
              }),
            clock: { nowMs: () => DUE_MS },
          });

        assert.throws(
          () =>
            administrationService.requestResolution({
              leagueId: IDS.league,
              auctionId: IDS.auction,
              input: {
                confirmation: "RESOLVE AUCTION",
              },
              expectedAuctionVersion: 1,
              idempotencyKey:
                "fad06-malformed-fad-rejected",
              authenticated: {
                userId: IDS.commissioner,
              },
            }),
          (error) =>
            error.code ===
            "AUCTION_ADMIN_FAD_INTEGRATION_REQUIRED"
        );
        assert.equal(generatedIds, 0);
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                (SELECT COUNT(*)
                 FROM idempotency_requests
                 WHERE operation =
                   'auction.resolve.request') AS requests,
                (SELECT COUNT(*)
                 FROM auction_administration_command_results)
                   AS results,
                (SELECT COUNT(*) FROM job_runs) AS jobs
            `)
            .get(),
          { requests: 0, results: 0, jobs: 0 }
        );
      }
    );
  }
);
