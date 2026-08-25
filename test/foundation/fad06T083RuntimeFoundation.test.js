"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSecurityFoundations,
} = require(
  "../../src/bootstrap/createSecurityFoundations"
);
const {
  createTargetRuntime,
} = require(
  "../../src/bootstrap/createTargetRuntime"
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
  seedFixture,
} = require(
  "../../src/operations/release/createReleaseQaFixture"
);
const {
  FIXTURE_NOW_MS,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const PUBLIC_FRONTEND_ORIGIN =
  "https://staging.hundoleago.com";
const DUE_MS = FIXTURE_NOW_MS + 86_400_000;
const BUILD_ID = "fad06-t083-runtime-proof";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function securityEnvironment() {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_BUILD_ID: BUILD_ID,
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "lax",
    PUBLIC_FRONTEND_ORIGIN,
    FRONTEND_ORIGINS: PUBLIC_FRONTEND_ORIGIN,
    EMAIL_DELIVERY_MODE: "capture",
    RATE_LIMIT_KEY_SECRET:
      "fad06-t083-rate-limit-secret-material-0123456789",
    AUDIT_METADATA_SECRET:
      "fad06-t083-audit-secret-material-9876543210",
    ACTION_TOKEN_DELIVERY_KEY:
      Buffer.alloc(32, 0x5a).toString("base64url"),
  };
}

function deterministicFoundations() {
  let nextId = 900_000;
  let nextBytes = 1;
  return createSecurityFoundations({
    env: securityEnvironment(),
    now: () => DUE_MS,
    randomUUID() {
      nextId += 1;
      return uuid(nextId);
    },
    randomBytes(length) {
      const bytes = Buffer.alloc(length, nextBytes);
      nextBytes = nextBytes === 255
        ? 1
        : nextBytes + 1;
      return bytes;
    },
    loggerSink() {},
  });
}

async function createDatabase(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad06-t083-runtime-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "target.sqlite3"
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
    applicationBuildId: BUILD_ID,
    now: () => FIXTURE_NOW_MS,
  });
  const seeded = connection.database.transaction(() =>
    seedFixture(
      connection.database,
      "unused-fad06-t083-runtime-password-hash",
      { includeIdentityMetadata: false }
    )
  ).immediate();
  await Promise.all(seeded.acceptancePromises);
  seeded.assertLateLockCoverage();

  const targetAuctionId = fixtureId("auction:leagueA");
  const authorizedTeamId = fixtureId("team:leagueA:2");
  connection.database.transaction(() => {
    assert.equal(
      connection.database.prepare(`
        UPDATE auction_bids
        SET team_id = ?,
            first_submitted_at_ms = ?,
            last_edited_at_ms = ?
        WHERE auction_id = ? AND status = 'active'
      `).run(
        authorizedTeamId,
        FIXTURE_NOW_MS,
        FIXTURE_NOW_MS,
        targetAuctionId
      ).changes,
      1
    );
    assert.equal(
      connection.database.prepare(`
        INSERT INTO auction_events (
          id, league_id, season_id, auction_id,
          bid_id, team_id, actor_user_id, event_type,
          metadata_json, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?,
          'auction_started', ?, ?)
      `).run(
        fixtureId("fad06-t083:auction-started-event"),
        fixtureId("league:leagueA"),
        fixtureId("season:leagueA:current"),
        targetAuctionId,
        fixtureId("auction-bid:leagueA"),
        authorizedTeamId,
        fixtureId("account:leagueAManagerOne"),
        JSON.stringify({
          actorMembershipId: fixtureId(
            "membership:leagueA:leagueAManagerOne"
          ),
          actorAuthority: "manager",
          totalValueCents: 900,
          termYears: 3,
          aavCents: 300,
          lowestOfferedAavCents: 300,
          editCount: 0,
          version: 1,
        }),
        FIXTURE_NOW_MS
      ).changes,
      1
    );
  }).immediate();

  const otherAuctionId = fixtureId("auction:leagueB");
  const delayed = connection.database.prepare(`
    UPDATE auctions
    SET resolves_at_ms = ?, updated_at_ms = ?
    WHERE id = ? AND status = 'open' AND version = 1
  `).run(
    DUE_MS + 86_400_000,
    FIXTURE_NOW_MS,
    otherAuctionId
  );
  assert.equal(delayed.changes, 1);
  return connection.database;
}

async function startApplication(t, runtime) {
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function requestHeaders(runtime, session) {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie:
      `${runtime.transport.sessionCookie.name}=` +
      session.rawSessionToken,
    "X-CSRF-Token": session.rawCsrfToken,
    "Idempotency-Key": "fad06-t083-runtime-resolution",
    "If-Match": '"1"',
  };
}

function counts(database, auctionId, resolutionId) {
  return database.prepare(`
    SELECT
      (SELECT COUNT(*)
       FROM auction_resolutions
       WHERE auction_id = @auctionId) AS resolutions,
      (SELECT COUNT(*)
       FROM contracts
       WHERE acquisition_source_type = 'auction_resolution'
         AND acquisition_source_id = @resolutionId) AS contracts,
      (SELECT COUNT(*)
       FROM player_ownerships
       WHERE acquired_transaction_type = 'auction_resolution'
         AND acquired_transaction_id = @resolutionId) AS ownerships,
      (SELECT COUNT(*)
       FROM league_activity
       WHERE related_type = 'auction_resolution'
         AND related_id = @resolutionId) AS activities,
      (SELECT COUNT(*)
       FROM outbox_events
       WHERE event_type = 'auction.changed'
         AND aggregate_type = 'auction'
         AND aggregate_id = @auctionId) AS outboxEvents
  `).get({ auctionId, resolutionId });
}

test(
  "composed T-083 HTTP handoff resolves through the real target worker exactly once",
  async (t) => {
    const database = await createDatabase(t);
    const securityFoundations = deterministicFoundations();
    const runtime = createTargetRuntime({
      database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      securityFoundations,
      currentSeason: {
        label: "2026",
        nhlSeasonKey: "20262027",
      },
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    });
    const baseUrl = await startApplication(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const auctionId = fixtureId("auction:leagueA");
    const commissionerId = fixtureId(
      "account:leagueACommissioner"
    );
    const decision =
      runtime.services.league
        .auctionResolutionDecision.decideDue({
          leagueId,
          auctionId,
          nowMs: DUE_MS,
        });
    assert.equal(
      decision.decision.outcome,
      "winner",
      JSON.stringify(decision)
    );
    const session =
      runtime.services.sessionService.issueForUser({
        userId: commissionerId,
      });
    const url = new URL(
      `/api/v1/leagues/${leagueId}/auctions/${auctionId}/resolve`,
      baseUrl
    );
    const request = () => fetch(url, {
      method: "POST",
      headers: requestHeaders(runtime, session),
      body: JSON.stringify({
        confirmation: "RESOLVE AUCTION",
      }),
    });

    const acceptedResponse = await request();
    const acceptedBody = await acceptedResponse.json();
    assert.equal(
      acceptedResponse.status,
      202,
      JSON.stringify(acceptedBody)
    );
    assert.deepEqual(
      Object.keys(acceptedBody).sort(),
      ["data", "meta"]
    );
    assert.deepEqual(
      Object.keys(acceptedBody.data).sort(),
      [
        "acceptedAtMs",
        "auctionId",
        "occurrenceKey",
        "operationId",
        "pollDescriptor",
        "status",
      ].sort()
    );
    const occurrenceKey =
      `auction:${auctionId}:${DUE_MS}`;
    assert.deepEqual(acceptedBody.data, {
      operationId: acceptedBody.data.operationId,
      occurrenceKey,
      auctionId,
      status: "pending",
      acceptedAtMs: DUE_MS,
      pollDescriptor: {
        kind: "auction",
        leagueId,
        auctionId,
      },
    });

    const operationId = acceptedBody.data.operationId;
    assert.deepEqual(
      database.prepare(`
        SELECT id, league_id, season_id, job_type,
          occurrence_key, scheduled_for_ms, status,
          attempt_count, result_json, version
        FROM job_runs
        WHERE id = ?
      `).get(operationId),
      {
        id: operationId,
        league_id: leagueId,
        season_id: fixtureId("season:leagueA:current"),
        job_type: "auction.resolve.target",
        occurrence_key: occurrenceKey,
        scheduled_for_ms: DUE_MS,
        status: "pending",
        attempt_count: 0,
        result_json: null,
        version: 1,
      }
    );
    const administration = database.prepare(`
      SELECT action, precondition_kind,
        expected_resource_version,
        resulting_resource_version, response_http_status,
        response_json, job_run_id, version
      FROM auction_administration_command_results
      WHERE league_id = ? AND auction_id = ?
    `).get(leagueId, auctionId);
    assert.deepEqual(
      {
        action: administration.action,
        preconditionKind:
          administration.precondition_kind,
        expectedVersion:
          administration.expected_resource_version,
        resultingVersion:
          administration.resulting_resource_version,
        responseHttpStatus:
          administration.response_http_status,
        jobRunId: administration.job_run_id,
        version: administration.version,
      },
      {
        action: "request_resolution",
        preconditionKind: "auction",
        expectedVersion: 1,
        resultingVersion: 1,
        responseHttpStatus: 202,
        jobRunId: operationId,
        version: 1,
      }
    );
    assert.deepEqual(
      JSON.parse(administration.response_json),
      acceptedBody.data
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, version
        FROM auctions
        WHERE league_id = ? AND id = ?
      `).get(leagueId, auctionId),
      { status: "open", version: 1 }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*)
           FROM auction_resolutions
           WHERE league_id = @leagueId
             AND auction_id = @auctionId) AS resolutions,
          (SELECT COUNT(*)
           FROM contracts
           WHERE league_id = @leagueId
             AND player_id = @playerId) AS contracts,
          (SELECT COUNT(*)
           FROM player_ownerships
           WHERE league_id = @leagueId
             AND player_id = @playerId) AS ownerships,
          (SELECT COUNT(*)
           FROM outbox_events
           WHERE league_id = @leagueId
             AND event_type = 'auction.changed'
             AND aggregate_id = @auctionId) AS outboxEvents
      `).get({
        leagueId,
        auctionId,
        playerId: fixtureId("player:freeAgentForward"),
      }),
      {
        resolutions: 0,
        contracts: 0,
        ownerships: 0,
        outboxEvents: 0,
      }
    );

    const workerResult =
      await runtime.services.league.auctionResolutionJob.run();
    assert.equal(
      workerResult.status,
      "succeeded",
      JSON.stringify({
        code: workerResult.error?.code,
        message: workerResult.error?.message,
        details: workerResult.error?.details,
        causeCode: workerResult.error?.cause?.code,
        causeMessage: workerResult.error?.cause?.message,
        causeStack: workerResult.error?.cause?.stack,
      })
    );
    assert.deepEqual(
      workerResult,
      {
        job: "auctions:resolve:target",
        status: "succeeded",
        due: 1,
        acquired: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
      }
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, version
        FROM auctions
        WHERE league_id = ? AND id = ?
      `).get(leagueId, auctionId),
      { status: "resolved", version: 2 }
    );
    const resolution = database.prepare(`
      SELECT id, winning_team_id, winning_bid_id,
        contract_id, ownership_id, scheduled_occurrence_key,
        trigger_type, status, resolved_at_ms
      FROM auction_resolutions
      WHERE league_id = ? AND auction_id = ?
    `).get(leagueId, auctionId);
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.trigger_type, "automatic");
    assert.equal(
      resolution.scheduled_occurrence_key,
      occurrenceKey
    );
    assert.equal(resolution.resolved_at_ms, DUE_MS);
    assert.equal(
      resolution.winning_bid_id,
      fixtureId("auction-bid:leagueA")
    );
    assert.equal(
      resolution.winning_team_id,
      fixtureId("team:leagueA:2")
    );

    const contract = database.prepare(`
      SELECT id, player_id, current_team_id AS team_id,
        acquisition_source_type, acquisition_source_id,
        status, version
      FROM contracts
      WHERE league_id = ? AND id = ?
    `).get(leagueId, resolution.contract_id);
    assert.deepEqual(contract, {
      id: resolution.contract_id,
      player_id: fixtureId("player:freeAgentForward"),
      team_id: resolution.winning_team_id,
      acquisition_source_type: "auction_resolution",
      acquisition_source_id: resolution.id,
      status: "active",
      version: 1,
    });
    const ownership = database.prepare(`
      SELECT id, player_id, team_id, ownership_kind,
        roster_category, position_group, slot_number,
        acquired_transaction_type,
        acquired_transaction_id, version
      FROM player_ownerships
      WHERE league_id = ? AND id = ?
    `).get(leagueId, resolution.ownership_id);
    assert.deepEqual(ownership, {
      id: resolution.ownership_id,
      player_id: fixtureId("player:freeAgentForward"),
      team_id: resolution.winning_team_id,
      ownership_kind: "Rostered",
      roster_category: "Active",
      position_group: "F",
      slot_number: null,
      acquired_transaction_type: "auction_resolution",
      acquired_transaction_id: resolution.id,
      version: 1,
    });

    const outbox = database.prepare(`
      SELECT id, event_type, aggregate_type,
        aggregate_id, payload_json, status,
        attempt_count, version
      FROM outbox_events
      WHERE league_id = ?
        AND event_type = 'auction.changed'
        AND aggregate_type = 'auction'
        AND aggregate_id = ?
    `).get(leagueId, auctionId);
    assert.deepEqual(
      {
        eventType: outbox.event_type,
        aggregateType: outbox.aggregate_type,
        aggregateId: outbox.aggregate_id,
        payload: JSON.parse(outbox.payload_json),
        status: outbox.status,
        attemptCount: outbox.attempt_count,
        version: outbox.version,
      },
      {
        eventType: "auction.changed",
        aggregateType: "auction",
        aggregateId: auctionId,
        payload: {
          eventId: outbox.id,
          type: "auction.changed",
          leagueId,
          resourceId: auctionId,
          version: 2,
          reasonCode: "auction_changed",
          occurredAt: DUE_MS,
          related: {
            fadId: null,
            teamId: null,
            cardId: null,
            allocationId: null,
            auctionId,
            recoveryId: null,
            nominationQueueId: null,
            scheduleRecoveryOperationId: null,
          },
        },
        status: "pending",
        attemptCount: 0,
        version: 1,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE league_id = ? AND outbox_event_id = ?
      `).all(leagueId, outbox.id),
      [{
        audience_kind: "league",
        team_id: null,
        user_id: null,
      }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count, result_json
        FROM job_runs
        WHERE id = ?
      `).get(operationId),
      {
        status: "succeeded",
        attempt_count: 1,
        result_json: JSON.stringify({
          auctionId,
          outcome: "resolved",
        }),
      }
    );

    const evidenceCounts = counts(
      database,
      auctionId,
      resolution.id
    );
    assert.deepEqual(evidenceCounts, {
      resolutions: 1,
      contracts: 1,
      ownerships: 1,
      activities: 1,
      outboxEvents: 1,
    });
    const replayResponse = await request();
    const replayBody = await replayResponse.json();
    assert.equal(replayResponse.status, 202);
    assert.deepEqual(replayBody.data, acceptedBody.data);
    assert.notEqual(
      replayBody.meta.requestId,
      acceptedBody.meta.requestId
    );
    assert.equal(replayBody.data.status, "pending");
    assert.deepEqual(
      counts(database, auctionId, resolution.id),
      evidenceCounts
    );
    assert.deepEqual(
      await runtime.services.league.auctionResolutionJob.run(),
      {
        job: "auctions:resolve:target",
        status: "succeeded",
        due: 0,
        acquired: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      }
    );
    assert.deepEqual(
      counts(database, auctionId, resolution.id),
      evidenceCounts
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*)
           FROM idempotency_requests
           WHERE league_id = ?
             AND operation = 'auction.resolve.request')
            AS requests,
          (SELECT COUNT(*)
           FROM auction_administration_command_results
           WHERE league_id = ?
             AND action = 'request_resolution')
            AS results,
          (SELECT COUNT(*)
           FROM job_runs
           WHERE league_id = ?
             AND job_type = 'auction.resolve.target')
            AS jobs
      `).get(leagueId, leagueId, leagueId),
      { requests: 1, results: 1, jobs: 1 }
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  }
);
