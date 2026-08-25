const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createLeagueActivityService,
} = require(
  "../../src/application/services/activity/createLeagueActivityService"
);
const {
  createNotificationService,
} = require(
  "../../src/application/services/activity/createNotificationService"
);
const {
  createLeagueOutboxPublicationService,
} = require(
  "../../src/application/services/activity/createLeagueOutboxPublicationService"
);
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  ActivityPolicyError,
  decodeCursor,
  encodeCursor,
  validateActivityPageInput,
  validatePageInput,
} = require("../../src/domain/activity/activityPolicy");
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require("../../src/domain/leagues/socketInvalidation");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteLeagueActivityRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueActivityRepository"
);
const {
  createSqliteLeagueOutboxRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository"
);
const {
  createSqliteNotificationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createSocketIoInvalidationPublisher,
} = require(
  "../../src/infrastructure/socket/createSocketIoInvalidationPublisher"
);
const {
  createPublishLeagueOutboxJob,
} = require("../../src/jobs/definitions/publishLeagueOutbox");
const {
  createActivityNotificationRouter,
} = require("../../src/transport/http/createActivityNotificationRouter");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const LEAGUE_A = "00000000-0000-4000-8000-000000000011";
const LEAGUE_B = "00000000-0000-4000-8000-000000000012";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function authenticated(userId) {
  return {
    valid: true,
    code: "SESSION_VALID",
    session: { id: uuid(userId === USER_A ? 90 : 91), userId, version: 1 },
    user: { id: userId, status: "active", version: 1 },
  };
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m5-09-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-09-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  for (const [id, email, name] of [
    [USER_A, "alpha@example.test", "Alpha"],
    [USER_B, "bravo@example.test", "Bravo"],
  ]) {
    context.repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: name,
      display_name_normalized: name.toLowerCase(),
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, name] of [
    [LEAGUE_A, "Alpha League"],
    [LEAGUE_B, "Bravo League"],
  ]) {
    context.repositories.leagues.insert({
      id,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, leagueId, userId] of [
    [uuid(101), LEAGUE_A, USER_A],
    [uuid(102), LEAGUE_B, USER_B],
  ]) {
    context.repositories.league_memberships.insert({
      id,
      league_id: leagueId,
      user_id: userId,
      permission_category: "member",
      status: "active",
      joined_at_ms: NOW_MS,
      ended_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (let index = 1; index <= 3; index += 1) {
    context.repositories.league_activity.insert({
      id: uuid(200 + index),
      league_id: LEAGUE_A,
      season_id: null,
      event_type: "trade_completed",
      actor_user_id: USER_A,
      actor_authority: "manager",
      team_id: null,
      player_id: null,
      related_type: "trade",
      related_id: uuid(300 + index),
      display_summary: `Trade ${index} completed.`,
      reason: null,
      metadata_json: JSON.stringify({ schemaVersion: 1, index }),
      occurred_at_ms: NOW_MS + index,
    });
  }
  context.repositories.league_activity.insert({
    id: uuid(209),
    league_id: LEAGUE_A,
    season_id: null,
    event_type: "roster_moved",
    actor_user_id: USER_A,
    actor_authority: "manager",
    team_id: null,
    player_id: null,
    related_type: "player_ownership",
    related_id: uuid(399),
    display_summary: "Routine Active to Bench move.",
    reason: null,
    metadata_json: JSON.stringify({ schemaVersion: 1 }),
    occurred_at_ms: NOW_MS + 9,
  });
  context.repositories.league_activity.insert({
    id: uuid(210),
    league_id: LEAGUE_B,
    season_id: null,
    event_type: "private_other_league",
    actor_user_id: USER_B,
    actor_authority: "manager",
    team_id: null,
    player_id: null,
    related_type: null,
    related_id: null,
    display_summary: "Other league only.",
    reason: null,
    metadata_json: null,
    occurred_at_ms: NOW_MS + 10,
  });
  for (const [id, userId, leagueId, createdAtMs] of [
    [uuid(401), USER_A, LEAGUE_A, NOW_MS + 1],
    [uuid(402), USER_A, LEAGUE_A, NOW_MS + 2],
    [uuid(403), USER_B, LEAGUE_B, NOW_MS + 3],
  ]) {
    context.repositories.notifications.insert({
      id,
      user_id: userId,
      league_id: leagueId,
      event_type: "assignment_proposed",
      message_data_json: JSON.stringify({ schemaVersion: 1, safe: true }),
      related_feature: "assignment",
      related_record_id: uuid(500),
      delivery_status: "delivered",
      created_at_ms: createdAtMs,
      read_at_ms: null,
      delivered_at_ms: createdAtMs,
      version: 1,
    });
  }
  const leagueAccessRepository = createSqliteLeagueAccessRepository({
    database: connection.database,
  });
  const authorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({ database: connection.database }),
    leagueAccessRepository,
  });
  return {
    activity: createLeagueActivityService({
      leagueAuthorization: authorization,
      repository: createSqliteLeagueActivityRepository({
        database: connection.database,
      }),
    }),
    context,
    database: connection.database,
    notifications: createNotificationService({
      leagueAuthorization: authorization,
      repository: createSqliteNotificationRepository({
        database: connection.database,
      }),
      clock: { nowMs: () => NOW_MS + 100 },
    }),
  };
}

function insertOutbox(context, {
  id,
  leagueId = LEAGUE_A,
  eventType = "trade.changed",
  aggregateId = uuid(600),
  availableAtMs = NOW_MS,
} = {}) {
  context.repositories.outbox_events.insert({
    id,
    league_id: leagueId,
    event_type: eventType,
    aggregate_type: eventType.startsWith("trade") ? "trade" : "auction",
    aggregate_id: aggregateId,
    payload_json: JSON.stringify({
      kind: "invalidation",
      eventType,
      scope: "league",
      scopeId: leagueId,
      version: 2,
      changedAtMs: availableAtMs,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: availableAtMs,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: availableAtMs,
    updated_at_ms: availableAtMs,
    version: 1,
  });
  context.repositories.outbox_event_audiences.insert({
    id,
    league_id: leagueId,
    outbox_event_id: id,
    audience_kind: "league",
    team_id: null,
    user_id: null,
    created_at_ms: availableAtMs,
  });
}

describe("M5-09 activity and notification policy", () => {
  test("uses bounded opaque deterministic cursors", () => {
    const cursor = encodeCursor({ occurredAtMs: NOW_MS, id: uuid(1) });
    assert.deepEqual(decodeCursor(cursor), {
      occurredAtMs: NOW_MS,
      id: uuid(1),
    });
    assert.deepEqual(validatePageInput({ limit: "10", cursor }), {
      limit: 10,
      cursor: { occurredAtMs: NOW_MS, id: uuid(1) },
    });
    assert.throws(
      () => validatePageInput({ limit: 101 }),
      ActivityPolicyError
    );
    assert.throws(() => decodeCursor("not-a-cursor"), ActivityPolicyError);
    assert.deepEqual(validateActivityPageInput({ category: "trade" }), {
      limit: 25,
      cursor: null,
      category: "trade",
    });
    assert.throws(
      () => validateActivityPageInput({ category: "raw_internal" }),
      ActivityPolicyError
    );
  });
});

describe("M5-09 authenticated League Activity", () => {
  test("is league-scoped, cursor-paginated, and byte-for-byte read-only", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.prepare("SELECT total_changes() AS n").get().n;
    const first = runtime.activity.list({
      leagueId: LEAGUE_A,
      query: { limit: 2 },
      authenticated: authenticated(USER_A),
    });
    assert.deepEqual(first.activity.map(({ summary }) => summary), [
      "Trade 3 completed.",
      "Trade 2 completed.",
    ]);
    assert.equal(first.activity[0].actor.displayName, "Alpha");
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM league_activity WHERE event_type = 'roster_moved'")
        .get().count,
      1
    );
    assert.ok(first.page.nextCursor);
    const second = runtime.activity.list({
      leagueId: LEAGUE_A,
      query: { limit: 2, cursor: first.page.nextCursor },
      authenticated: authenticated(USER_A),
    });
    assert.deepEqual(second.activity.map(({ summary }) => summary), [
      "Trade 1 completed.",
    ]);
    assert.equal(second.page.nextCursor, null);
    const tradeOnly = runtime.activity.list({
      leagueId: LEAGUE_A,
      query: { category: "trade", limit: 10 },
      authenticated: authenticated(USER_A),
    });
    assert.equal(tradeOnly.activity.length, 3);
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS n").get().n,
      before
    );
    runtime.context.repositories.league_activity.insert({
      id: uuid(211),
      league_id: LEAGUE_A,
      season_id: null,
      event_type: "fad_allocation_player_acquired",
      actor_user_id: null,
      actor_authority: "system",
      team_id: null,
      player_id: null,
      related_type: "free_agent_draft",
      related_id: uuid(311),
      display_summary: "Free Agent Draft signing completed.",
      reason: null,
      metadata_json: null,
      occurred_at_ms: NOW_MS + 11,
    });
    const beforeCompetitionRead = runtime.database
      .prepare("SELECT total_changes() AS n")
      .get().n;
    const competitionOnly = runtime.activity.list({
      leagueId: LEAGUE_A,
      query: { category: "competition", limit: 10 },
      authenticated: authenticated(USER_A),
    });
    assert.deepEqual(
      competitionOnly.activity.map(({ type }) => type),
      ["fad_allocation_player_acquired"]
    );
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS n").get().n,
      beforeCompetitionRead
    );
    assert.throws(
      () =>
        runtime.activity.list({
          leagueId: LEAGUE_B,
          query: {},
          authenticated: authenticated(USER_A),
        }),
      ({ code }) => code === "LEAGUE_NOT_FOUND"
    );
  });
});

describe("M5-09 owner-only notification acknowledgement", () => {
  test("lists without writes and marks one or all exactly once", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.prepare("SELECT total_changes() AS n").get().n;
    const listed = runtime.notifications.list({
      query: {},
      authenticated: authenticated(USER_A),
    });
    assert.deepEqual(
      listed.notifications.map(({ id }) => id),
      [uuid(402), uuid(401)]
    );
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS n").get().n,
      before
    );

    const first = runtime.notifications.markRead({
      notificationId: uuid(401),
      authenticated: authenticated(USER_A),
    });
    assert.equal(first.notification.version, 2);
    assert.equal(first.notification.readAtMs, NOW_MS + 100);
    const replay = runtime.notifications.markRead({
      notificationId: uuid(401),
      authenticated: authenticated(USER_A),
    });
    assert.equal(replay.notification.version, 2);

    const beforeCrossOwner = runtime.database
      .prepare("SELECT total_changes() AS n")
      .get().n;
    assert.throws(
      () =>
        runtime.notifications.markRead({
          notificationId: uuid(403),
          authenticated: authenticated(USER_A),
        }),
      ({ code }) => code === "NOTIFICATION_NOT_FOUND"
    );
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS n").get().n,
      beforeCrossOwner
    );

    const all = runtime.notifications.markAllRead({
      authenticated: authenticated(USER_A),
    });
    assert.equal(all.changedCount, 1);
    const allReplay = runtime.notifications.markAllRead({
      authenticated: authenticated(USER_A),
    });
    assert.equal(allReplay.changedCount, 0);
    assert.equal(
      runtime.database
        .prepare("SELECT read_at_ms FROM notifications WHERE id = ?")
        .get(uuid(403)).read_at_ms,
      null
    );
  });

  test("filters by read state and acknowledges exactly one owned batch", (t) => {
    const runtime = createRuntime(t);
    const unread = runtime.notifications.list({
      query: { readStatus: "unread" },
      authenticated: authenticated(USER_A),
    });
    assert.deepEqual(
      unread.notifications.map(({ id }) => id),
      [uuid(402), uuid(401)]
    );

    const batch = runtime.notifications.markBatchRead({
      notificationIds: [uuid(402), uuid(401)],
      authenticated: authenticated(USER_A),
    });
    assert.equal(batch.changedCount, 2);
    assert.equal(batch.readAtMs, NOW_MS + 100);
    assert.deepEqual(batch.notificationIds, [uuid(402), uuid(401)]);
    assert.deepEqual(
      runtime.notifications.list({
        query: { readStatus: "unread" },
        authenticated: authenticated(USER_A),
      }).notifications,
      []
    );
    assert.deepEqual(
      runtime.notifications
        .list({
          query: { readStatus: "read" },
          authenticated: authenticated(USER_A),
        })
        .notifications.map(({ id }) => id),
      [uuid(402), uuid(401)]
    );
    assert.equal(
      runtime.notifications.markBatchRead({
        notificationIds: [uuid(402), uuid(401)],
        authenticated: authenticated(USER_A),
      }).changedCount,
      0
    );

    const beforeCrossOwner = runtime.database
      .prepare("SELECT total_changes() AS n")
      .get().n;
    assert.throws(
      () =>
        runtime.notifications.markBatchRead({
          notificationIds: [uuid(401), uuid(403)],
          authenticated: authenticated(USER_A),
        }),
      ({ code }) => code === "NOTIFICATION_NOT_FOUND"
    );
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS n").get().n,
      beforeCrossOwner
    );
    assert.equal(
      runtime.database
        .prepare("SELECT read_at_ms FROM notifications WHERE id = ?")
        .get(uuid(403)).read_at_ms,
      null
    );
  });
});

describe("M5-09 retry-safe league outbox publication", () => {
  test("claims, fails, retries, publishes, and recovers without re-entering feature state", async (t) => {
    const runtime = createRuntime(t);
    insertOutbox(runtime.context, { id: uuid(701) });
    insertOutbox(runtime.context, {
      id: uuid(702),
      eventType: "auction.updated",
      aggregateId: uuid(601),
    });
    runtime.context.repositories.outbox_events.insert({
      id: uuid(703),
      league_id: null,
      event_type: "account.password_changed_notification",
      aggregate_type: "user",
      aggregate_id: USER_A,
      payload_json: JSON.stringify({ ignoredByLeagueWorker: true }),
      status: "pending",
      attempt_count: 0,
      available_at_ms: NOW_MS,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    let currentTime = NOW_MS + 200;
    let failAuctionOnce = true;
    const captured = [];
    const repository = createSqliteLeagueOutboxRepository({
      database: runtime.database,
    });
    const service = createLeagueOutboxPublicationService({
      repository,
      publisher: {
        async publish(event) {
          captured.push(event);
          if (event.eventType === "auction.changed" && failAuctionOnce) {
            failAuctionOnce = false;
            const error = new Error("temporary socket failure");
            error.code = "SOCKET_TEMPORARY";
            throw error;
          }
        },
      },
      clock: { nowMs: () => currentTime },
      retryDelayMs: 5_000,
    });
    const beforeFeature = runtime.database
      .prepare("SELECT COUNT(*) AS count FROM league_activity")
      .get().count;
    assert.deepEqual(await service.publishDue(), [
      { eventId: uuid(701), outcome: "published" },
      { eventId: uuid(702), outcome: "failed" },
    ]);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, status, attempt_count, last_error_code
          FROM outbox_events WHERE id IN (?, ?) ORDER BY id
        `)
        .all(uuid(701), uuid(702)),
      [
        {
          id: uuid(701),
          status: "published",
          attempt_count: 1,
          last_error_code: null,
        },
        {
          id: uuid(702),
          status: "failed",
          attempt_count: 1,
          last_error_code: "SOCKET_TEMPORARY",
        },
      ]
    );
    assert.deepEqual(await service.publishDue(), []);
    currentTime += 5_000;
    assert.deepEqual(await service.publishDue(), [
      { eventId: uuid(702), outcome: "published" },
    ]);
    assert.equal(
      runtime.database
        .prepare("SELECT attempt_count FROM outbox_events WHERE id = ?")
        .get(uuid(702)).attempt_count,
      2
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM outbox_events WHERE id = ?")
        .get(uuid(703)).status,
      "pending"
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM league_activity").get()
        .count,
      beforeFeature
    );

    insertOutbox(runtime.context, {
      id: uuid(704),
      availableAtMs: currentTime,
    });
    const interrupted = repository.claim({
      eventId: uuid(704),
      leagueId: LEAGUE_A,
      expectedVersion: 1,
      nowMs: currentTime,
    });
    assert.equal(interrupted.status, "publishing");
    currentTime += 10_000;
    const recovered = service.recoverInterrupted({
      staleBeforeMs: currentTime - 1,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "failed");
    assert.equal(recovered[0].last_error_code, "PUBLICATION_INTERRUPTED");

    const job = createPublishLeagueOutboxJob({ service, logger: { error() {} } });
    const jobResult = await job.run();
    assert.equal(jobResult.status, "succeeded");
    assert.equal(jobResult.published, 1);
    assert.equal(captured.filter(({ eventId }) => eventId === uuid(701)).length, 1);
  });

  test("emits the approved metadata-only envelope to the authenticated league room", async () => {
    const emissions = [];
    const publisher = createSocketIoInvalidationPublisher({
      getIo: () => ({
        to(room) {
          return {
            emit(type, payload) {
              emissions.push({ room, type, payload });
            },
          };
        },
      }),
    });
    await publisher.publish({
      eventId: uuid(710),
      eventType: "trade.changed",
      leagueId: LEAGUE_A,
      aggregateType: "trade",
      aggregateId: uuid(711),
      audiences: [
        {
          kind: "league",
          leagueId: LEAGUE_A,
          teamId: null,
          userId: null,
        },
      ],
      payload: createSocketEventEnvelope({
        eventId: uuid(710),
        type: "trade.changed",
        leagueId: LEAGUE_A,
        resourceId: uuid(711),
        version: 2,
        reasonCode: "trade_changed",
        occurredAt: NOW_MS,
        related: createEmptySocketRelated(),
      }),
    });
    assert.deepEqual(emissions, [
      {
        room: `league:${LEAGUE_A}`,
        type: "trade.changed",
        payload: {
          eventId: uuid(710),
          type: "trade.changed",
          leagueId: LEAGUE_A,
          resourceId: uuid(711),
          version: 2,
          reasonCode: "trade_changed",
          occurredAt: NOW_MS,
          related: createEmptySocketRelated(),
        },
      },
    ]);
  });
});

describe("M5-09 activity and notification HTTP boundary", () => {
  test("routes authenticated reads and CSRF-protected exact acknowledgement writes", async (t) => {
    const calls = [];
    const requestSecurity = {
      assignRequestId(request, response, next) {
        request.testRequestId = uuid(800);
        next();
      },
      securityHeaders(request, response, next) { next(); },
      credentialedCors(request, response, next) { next(); },
      requireAllowedOrigin(request, response, next) { next(); },
      requireCompatibleFetchMetadata(request, response, next) { next(); },
      requireJson(request, response, next) {
        if (request.method !== "GET" && !request.is("application/json")) {
          response.status(415).end();
          return;
        }
        next();
      },
      authenticateBootstrap(request, response, next) {
        request.testBootstrap = authenticated(USER_A);
        next();
      },
      authenticateUnsafe(request, response, next) {
        if (request.get("x-csrf-token") !== "valid") {
          response.status(403).end();
          return;
        }
        request.testAuthenticated = authenticated(USER_A);
        next();
      },
      getRequestId: (request) => request.testRequestId,
      getSessionBootstrap: (request) => request.testBootstrap,
      getAuthenticatedSession: (request) => request.testAuthenticated,
    };
    const router = createActivityNotificationRouter({
      requestSecurity,
      leagueActivityService: {
        list(input) {
          calls.push({ method: "activity", input });
          return { code: "LEAGUE_ACTIVITY_FOUND", activity: [], page: {} };
        },
      },
      notificationService: {
        list(input) {
          calls.push({ method: "notifications", input });
          return { code: "NOTIFICATIONS_FOUND", notifications: [], page: {} };
        },
        markRead(input) {
          calls.push({ method: "markRead", input });
          return { code: "NOTIFICATION_READ" };
        },
        markBatchRead(input) {
          calls.push({ method: "markBatchRead", input });
          return { code: "NOTIFICATIONS_READ", changedCount: 2 };
        },
        markAllRead(input) {
          calls.push({ method: "markAllRead", input });
          return { code: "NOTIFICATIONS_READ", changedCount: 0 };
        },
      },
    });
    const app = express();
    app.use(router);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const activityResponse = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_A}/activity?limit=2`
    );
    assert.equal(activityResponse.status, 200);
    const notificationResponse = await fetch(`${baseUrl}/api/v1/notifications`);
    assert.equal(notificationResponse.status, 200);
    const denied = await fetch(
      `${baseUrl}/api/v1/notifications/${uuid(401)}/read`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }
    );
    assert.equal(denied.status, 403);
    const batch = await fetch(`${baseUrl}/api/v1/notifications/read-batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "valid",
      },
      body: JSON.stringify({ notificationIds: [uuid(401), uuid(402)] }),
    });
    assert.equal(batch.status, 200);
    const marked = await fetch(
      `${baseUrl}/api/v1/notifications/${uuid(401)}/read`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "valid",
        },
        body: "{}",
      }
    );
    assert.equal(marked.status, 200);
    const invalidBody = await fetch(`${baseUrl}/api/v1/notifications/read-all`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "valid",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(invalidBody.status, 400);
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["activity", "notifications", "markBatchRead", "markRead"]
    );
  });
});
