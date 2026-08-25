const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createLeagueOutboxPublicationService,
  parsePayload,
} = require(
  "../../src/application/services/activity/createLeagueOutboxPublicationService"
);
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
  createSqliteLeagueOutboxRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSocketIoInvalidationPublisher,
} = require(
  "../../src/infrastructure/socket/createSocketIoInvalidationPublisher"
);
const {
  createAuthenticatedSocketRooms,
} = require(
  "../../src/transport/socket/createAuthenticatedSocketRooms"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-29T12:00:00.000Z");
const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const USER_C = "00000000-0000-4000-8000-000000000003";
const LEAGUE_A = "00000000-0000-4000-8000-000000000011";
const LEAGUE_B = "00000000-0000-4000-8000-000000000012";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-02-publisher-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-02-audience-publication-test",
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
    [USER_C, "charlie@example.test", "Charlie"],
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
    [uuid(103), LEAGUE_A, USER_C],
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
  return {
    context,
    database: connection.database,
    repository: createSqliteLeagueOutboxRepository({
      database: connection.database,
    }),
  };
}

function insertOutbox(
  runtime,
  {
    id,
    leagueId = LEAGUE_A,
    availableAtMs = NOW_MS,
    createdAtMs = NOW_MS,
  }
) {
  runtime.context.repositories.outbox_events.insert({
    id,
    league_id: leagueId,
    event_type: "trade.changed",
    aggregate_type: "trade",
    aggregate_id: uuid(600),
    payload_json: JSON.stringify({
      kind: "invalidation",
      eventType: "trade.changed",
      scope: "league",
      scopeId: leagueId,
      version: 2,
      changedAtMs: createdAtMs,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: availableAtMs,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
}

function insertAudience(
  runtime,
  {
    id,
    eventId,
    leagueId = LEAGUE_A,
    kind,
    teamId = null,
    userId = null,
  }
) {
  runtime.context.repositories.outbox_event_audiences.insert({
    id,
    league_id: leagueId,
    outbox_event_id: eventId,
    audience_kind: kind,
    team_id: teamId,
    user_id: userId,
    created_at_ms: NOW_MS,
  });
}

function claimedEvent(id = uuid(801)) {
  return Object.freeze({
    id,
    league_id: LEAGUE_A,
    event_type: "trade.changed",
    aggregate_type: "trade",
    aggregate_id: uuid(802),
    payload_json: JSON.stringify({
      kind: "invalidation",
      eventType: "trade.changed",
      scope: "league",
      scopeId: LEAGUE_A,
      version: 2,
      changedAtMs: NOW_MS,
    }),
    status: "publishing",
    attempt_count: 1,
    available_at_ms: NOW_MS,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 2,
  });
}

describe("FAD-02 audience-aware league outbox publication", () => {
  test("loads exact audiences, reauthorizes users, and safely drains stale private delivery", async (t) => {
    const runtime = createRuntime(t);
    insertOutbox(runtime, {
      id: uuid(701),
      availableAtMs: NOW_MS + 60_000,
    });
    insertAudience(runtime, {
      id: uuid(711),
      eventId: uuid(701),
      kind: "league",
    });
    insertAudience(runtime, {
      id: uuid(712),
      eventId: uuid(701),
      kind: "user",
      userId: USER_C,
    });
    insertOutbox(runtime, {
      id: uuid(702),
      leagueId: LEAGUE_B,
      availableAtMs: NOW_MS + 60_000,
    });
    insertAudience(runtime, {
      id: uuid(713),
      eventId: uuid(702),
      leagueId: LEAGUE_B,
      kind: "league",
    });

    assert.deepEqual(
      runtime.repository
        .listAudiences({
          eventId: uuid(701),
          leagueId: LEAGUE_A,
        })
        .map(({ audience_kind, league_id, user_id }) => ({
          audience_kind,
          league_id,
          user_id,
        })),
      [
        {
          audience_kind: "league",
          league_id: LEAGUE_A,
          user_id: null,
        },
        {
          audience_kind: "user",
          league_id: LEAGUE_A,
          user_id: USER_C,
        },
      ]
    );
    assert.deepEqual(
      runtime.repository.listAudiences({
        eventId: uuid(701),
        leagueId: LEAGUE_B,
      }),
      []
    );
    assert.equal(
      runtime.repository.isUserAudienceAuthorized({
        leagueId: LEAGUE_A,
        userId: USER_C,
      }),
      true
    );
    assert.equal(
      runtime.repository.isUserAudienceAuthorized({
        leagueId: LEAGUE_A,
        userId: USER_B,
      }),
      false
    );

    insertOutbox(runtime, { id: uuid(703) });
    insertAudience(runtime, {
      id: uuid(714),
      eventId: uuid(703),
      kind: "user",
      userId: USER_C,
    });
    insertOutbox(runtime, { id: uuid(704) });
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET status = 'ended', ended_at_ms = @endedAtMs,
          updated_at_ms = @endedAtMs, version = version + 1
        WHERE league_id = @leagueId AND user_id = @userId
      `)
      .run({
        endedAtMs: NOW_MS + 1,
        leagueId: LEAGUE_A,
        userId: USER_C,
      });

    let ioLookups = 0;
    const publisher = createSocketIoInvalidationPublisher({
      getIo() {
        ioLookups += 1;
        throw new Error("must not resolve IO without an authorized room");
      },
    });
    const service = createLeagueOutboxPublicationService({
      repository: runtime.repository,
      publisher,
      clock: { nowMs: () => NOW_MS + 100 },
    });

    assert.deepEqual(await service.publishDue(), [
      { eventId: uuid(703), outcome: "published" },
      { eventId: uuid(704), outcome: "failed" },
    ]);
    assert.equal(ioLookups, 0);
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status FROM outbox_events WHERE id = ?
        `)
        .get(uuid(703)).status,
      "published"
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, last_error_code
          FROM outbox_events WHERE id = ?
        `)
        .get(uuid(704)),
      {
        status: "failed",
        last_error_code: "PUBLICATION_AUDIENCE_MISSING",
      }
    );
  });

  test("fails closed and marks a malformed claimed audience without publishing", async () => {
    const claimed = claimedEvent();
    let published = 0;
    let failure = null;
    const repository = {
      claim() {
        return claimed;
      },
      isUserAudienceAuthorized() {
        throw new Error("must not authorize a malformed audience");
      },
      listAudiences() {
        return [
          {
            id: uuid(803),
            league_id: LEAGUE_B,
            outbox_event_id: claimed.id,
            audience_kind: "league",
            team_id: null,
            user_id: null,
            created_at_ms: NOW_MS,
          },
        ];
      },
      listDue() {
        return [{ ...claimed, status: "pending", version: 1 }];
      },
      markFailed(command) {
        failure = command;
      },
      markPublished() {
        throw new Error("must not mark a malformed audience published");
      },
      recoverInterrupted() {
        return [];
      },
    };
    const service = createLeagueOutboxPublicationService({
      repository,
      publisher: {
        async publish() {
          published += 1;
        },
      },
      clock: { nowMs: () => NOW_MS },
    });

    assert.deepEqual(await service.publishDue(), [
      { eventId: claimed.id, outcome: "failed" },
    ]);
    assert.equal(published, 0);
    assert.equal(
      failure.errorCode,
      "PUBLICATION_AUDIENCE_INVALID"
    );
    assert.equal(failure.expectedVersion, 2);
  });

  test("passes exact private event context into current user authorization", async () => {
    const eventId = uuid(820);
    const cardId = uuid(821);
    const teamId = uuid(822);
    const fadId = uuid(823);
    const payload = createSocketEventEnvelope({
      eventId,
      type: "candidate_card.changed",
      leagueId: LEAGUE_A,
      resourceId: cardId,
      version: 4,
      reasonCode: "card_changed",
      occurredAt: NOW_MS,
      related: createEmptySocketRelated({
        fadId,
        teamId,
        cardId,
      }),
    });
    const claimed = {
      ...claimedEvent(eventId),
      event_type: payload.type,
      aggregate_type: "candidate_card",
      aggregate_id: cardId,
      payload_json: JSON.stringify(payload),
    };
    let authorization = null;
    let published = null;
    const service = createLeagueOutboxPublicationService({
      repository: {
        claim() {
          return claimed;
        },
        isUserAudienceAuthorized(command) {
          authorization = command;
          return true;
        },
        listAudiences() {
          return [
            {
              id: uuid(824),
              league_id: LEAGUE_A,
              outbox_event_id: eventId,
              audience_kind: "user",
              team_id: null,
              user_id: USER_A,
              created_at_ms: NOW_MS,
            },
          ];
        },
        listDue() {
          return [{ ...claimed, status: "pending", version: 1 }];
        },
        markFailed() {
          throw new Error("must not fail an authorized publication");
        },
        markPublished(command) {
          published = command;
        },
        recoverInterrupted() {
          return [];
        },
      },
      publisher: {
        async publish(event) {
          assert.equal(
            event.authorizeUserAudience({
              leagueId: LEAGUE_A,
              userId: USER_A,
            }),
            true
          );
        },
      },
      clock: { nowMs: () => NOW_MS },
    });

    assert.deepEqual(await service.publishDue(), [
      { eventId, outcome: "published" },
    ]);
    assert.deepEqual(authorization, {
      leagueId: LEAGUE_A,
      userId: USER_A,
      eventType: "candidate_card.changed",
      resourceId: cardId,
      reasonCode: "card_changed",
      related: payload.related,
      nowMs: NOW_MS,
    });
    assert.equal(published.eventId, eventId);
  });

  test("decodes exact canonical and supported versioned legacy metadata without private values", () => {
    const fadId = uuid(850);
    const canonicalEventId = uuid(849);
    const canonical = createSocketEventEnvelope({
      eventId: canonicalEventId,
      type: "fad_nomination_queue.changed",
      leagueId: LEAGUE_A,
      resourceId: uuid(852),
      version: 4,
      reasonCode: "nomination_queued",
      occurredAt: NOW_MS,
      related: createEmptySocketRelated({
        fadId,
        teamId: uuid(851),
        nominationQueueId: uuid(852),
      }),
    });
    assert.deepEqual(
      parsePayload({
        id: canonicalEventId,
        league_id: LEAGUE_A,
        event_type: "fad_nomination_queue.changed",
        aggregate_type: "fad_nomination_queue",
        aggregate_id: uuid(852),
        created_at_ms: NOW_MS,
        payload_json: JSON.stringify(canonical),
      }),
      canonical
    );

    assert.deepEqual(
      parsePayload({
        id: uuid(855),
        league_id: LEAGUE_A,
        event_type: "auction.updated",
        aggregate_type: "auction",
        aggregate_id: uuid(853),
        created_at_ms: NOW_MS,
        payload_json: JSON.stringify({
          kind: "invalidation",
          eventType: "auction.updated",
          scope: "league",
          scopeId: LEAGUE_A,
          version: 9,
          changedAtMs: NOW_MS,
        }),
      }),
      createSocketEventEnvelope({
        eventId: uuid(855),
        type: "auction.changed",
        leagueId: LEAGUE_A,
        resourceId: uuid(853),
        version: 9,
        reasonCode: "auction_changed",
        occurredAt: NOW_MS,
        related: createEmptySocketRelated(),
      })
    );

  });

  test("rejects six-ID, extra-key, legacy opening, and unversioned publication payloads", () => {
    const row = {
      id: uuid(859),
      league_id: LEAGUE_A,
      event_type: "trade.changed",
      aggregate_type: "trade",
      aggregate_id: uuid(860),
      created_at_ms: NOW_MS,
    };
    const invalidPayloads = [
      {
        eventId: uuid(859),
        type: "trade.changed",
        leagueId: LEAGUE_A,
        resourceId: uuid(860),
        version: 2,
        reasonCode: "trade_changed",
        occurredAt: NOW_MS,
        related: {
          fadId: null,
          teamId: null,
          cardId: null,
          allocationId: null,
          auctionId: null,
          recoveryId: null,
        },
      },
      {
        ...createSocketEventEnvelope({
          eventId: uuid(859),
          type: "trade.changed",
          leagueId: LEAGUE_A,
          resourceId: uuid(860),
          version: 2,
          reasonCode: "trade_changed",
          occurredAt: NOW_MS,
          related: createEmptySocketRelated(),
        }),
        offer: "$99",
      },
    ];
    for (const payload of invalidPayloads) {
      assert.throws(
        () =>
          parsePayload({
            ...row,
            payload_json: JSON.stringify(payload),
          }),
        ({ code }) => code === "PUBLICATION_PAYLOAD_INVALID"
      );
    }

    assert.throws(
      () =>
        parsePayload({
          ...row,
          payload_json: JSON.stringify({
            kind: "invalidation",
            eventType: "trade.changed",
            scope: "league",
            scopeId: LEAGUE_A,
            changedAtMs: NOW_MS,
          }),
        }),
      ({ code }) =>
        code === "PUBLICATION_PAYLOAD_VERSION_MISSING"
    );
    for (const payload of [
      {
        leagueId: LEAGUE_A,
        seasonId: uuid(862),
        fadId: uuid(861),
        occurredAtMs: NOW_MS,
      },
      {
        leagueId: LEAGUE_A,
        seasonId: uuid(862),
        fadId: uuid(861),
        occurredAtMs: NOW_MS,
        version: 1,
      },
    ]) {
      assert.throws(
        () =>
          parsePayload({
            ...row,
            event_type: "fad_cards_opened",
            aggregate_type: "free_agent_draft",
            aggregate_id: uuid(861),
            payload_json: JSON.stringify(payload),
          }),
        ({ code }) => code === "PUBLICATION_PAYLOAD_INVALID"
      );
    }
  });

  test("retries an unversioned legacy row without publishing or fabricating a version", async (t) => {
    const runtime = createRuntime(t);
    const eventId = uuid(870);
    insertOutbox(runtime, { id: eventId });
    insertAudience(runtime, {
      id: uuid(871),
      eventId,
      kind: "league",
    });
    runtime.database
      .prepare("UPDATE outbox_events SET payload_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          kind: "invalidation",
          eventType: "trade.changed",
          scope: "league",
          scopeId: LEAGUE_A,
          changedAtMs: NOW_MS,
        }),
        eventId
      );
    let nowMs = NOW_MS;
    let publications = 0;
    const service = createLeagueOutboxPublicationService({
      repository: runtime.repository,
      publisher: {
        async publish() {
          publications += 1;
        },
      },
      clock: { nowMs: () => nowMs },
      retryDelayMs: 5_000,
    });

    assert.deepEqual(await service.publishDue(), [
      { eventId, outcome: "failed" },
    ]);
    assert.equal(publications, 0);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, attempt_count, last_error_code
          FROM outbox_events WHERE id = ?
        `)
        .get(eventId),
      {
        status: "failed",
        attempt_count: 1,
        last_error_code: "PUBLICATION_PAYLOAD_VERSION_MISSING",
      }
    );
    assert.deepEqual(await service.publishDue(), []);
    nowMs += 5_000;
    assert.deepEqual(await service.publishDue(), [
      { eventId, outcome: "failed" },
    ]);
    assert.equal(publications, 0);
    assert.equal(
      runtime.database
        .prepare("SELECT attempt_count FROM outbox_events WHERE id = ?")
        .get(eventId).attempt_count,
      2
    );
  });

  test("uses narrow audiences alone for one union emission and rejects unsafe routing", async () => {
    const selectedRooms = [];
    const emissions = [];
    const broadcast = {
      to(room) {
        selectedRooms.push(room);
        return broadcast;
      },
      emit(type, payload) {
        emissions.push({ type, payload });
      },
    };
    const publisher = createSocketIoInvalidationPublisher({
      getIo: () => broadcast,
    });
    const teamId = uuid(901);
    const event = {
      eventId: uuid(902),
      eventType: "trade.changed",
      leagueId: LEAGUE_A,
      aggregateType: "trade",
      aggregateId: uuid(903),
      audiences: [
        {
          kind: "team",
          leagueId: LEAGUE_A,
          teamId,
          userId: null,
        },
        {
          kind: "user",
          leagueId: LEAGUE_A,
          teamId: null,
          userId: USER_A,
        },
      ],
      authorizeUserAudience({ leagueId, userId }) {
        assert.equal(leagueId, LEAGUE_A);
        assert.equal(userId, USER_A);
        return true;
      },
      payload: createSocketEventEnvelope({
        eventId: uuid(902),
        type: "trade.changed",
        leagueId: LEAGUE_A,
        resourceId: uuid(903),
        version: 2,
        reasonCode: "trade_changed",
        occurredAt: NOW_MS,
        related: createEmptySocketRelated(),
      }),
    };

    assert.deepEqual(await publisher.publish(event), {
      delivered: true,
      roomCount: 2,
    });
    assert.deepEqual(selectedRooms, [
      `team:${teamId}`,
      `user:${USER_A}`,
    ]);
    assert.deepEqual(emissions, [
      {
        type: "trade.changed",
        payload: {
          eventId: uuid(902),
          type: "trade.changed",
          leagueId: LEAGUE_A,
          resourceId: uuid(903),
          version: 2,
          reasonCode: "trade_changed",
          occurredAt: NOW_MS,
          related: createEmptySocketRelated(),
        },
      },
    ]);

    await assert.rejects(
      publisher.publish({
        ...event,
        audiences: [
          {
            kind: "league",
            leagueId: LEAGUE_B,
            teamId: null,
            userId: null,
          },
        ],
      }),
      ({ code, message }) =>
        code === "SOCKET_AUDIENCE_INVALID" &&
        !message.includes(LEAGUE_A) &&
        !message.includes(LEAGUE_B)
    );
    assert.equal(emissions.length, 1);

    await assert.rejects(
      publisher.publish({
        ...event,
        audiences: [
          {
            kind: "league",
            leagueId: LEAGUE_A,
            teamId: null,
            userId: null,
          },
          {
            kind: "team",
            leagueId: LEAGUE_A,
            teamId,
            userId: null,
          },
        ],
      }),
      ({ code }) => code === "SOCKET_AUDIENCE_INVALID"
    );
    assert.equal(emissions.length, 1);

    let staleIoLookups = 0;
    const stalePublisher =
      createSocketIoInvalidationPublisher({
        getIo() {
          staleIoLookups += 1;
          return broadcast;
        },
      });
    assert.deepEqual(
      await stalePublisher.publish({
        ...event,
        audiences: [
          {
            kind: "user",
            leagueId: LEAGUE_A,
            teamId: null,
            userId: USER_A,
          },
        ],
        authorizeUserAudience: () => false,
      }),
      { delivered: false, roomCount: 0 }
    );
    assert.equal(staleIoLookups, 0);
    assert.equal(emissions.length, 1);

    await assert.rejects(
      publisher.publish({
        ...event,
        payload: {
          ...event.payload,
          playerId: uuid(999),
        },
      }),
      ({ code }) => code === "SOCKET_EVENT_INVALID"
    );
    await assert.rejects(
      publisher.publish({
        ...event,
        payload: {
          eventId: uuid(902),
          type: "trade.changed",
          leagueId: LEAGUE_A,
          resourceId: uuid(903),
          version: 2,
          reasonCode: "trade_changed",
          occurredAt: NOW_MS,
          related: {
            fadId: null,
            teamId: null,
            cardId: null,
            allocationId: null,
            auctionId: null,
            recoveryId: null,
          },
        },
      }),
      ({ code }) => code === "SOCKET_EVENT_INVALID"
    );
    assert.equal(emissions.length, 1);
  });

  test("reauthorizes the private league cohort before team delivery", async () => {
    const teamId = uuid(920);
    const oldManagerId = uuid(921);
    const newManagerId = uuid(922);
    const desiredRooms = new Map([
      [
        oldManagerId,
        [`user:${oldManagerId}`, `league:${LEAGUE_A}`],
      ],
      [
        newManagerId,
        [
          `user:${newManagerId}`,
          `league:${LEAGUE_A}`,
          `team:${teamId}`,
        ],
      ],
    ]);
    const reauthorized = [];
    const roomManager = createAuthenticatedSocketRooms({
      authorizationService: {
        authorizeHandshake(handshake) {
          const userId = handshake.userId;
          reauthorized.push(userId);
          return Object.freeze({
            userId,
            rooms: Object.freeze(desiredRooms.get(userId)),
          });
        },
      },
    });
    function socket(id, userId, rooms) {
      return {
        id,
        handshake: { userId },
        data: {},
        rooms: new Set([id, ...rooms]),
        disconnected: false,
        async join(room) {
          this.rooms.add(room);
        },
        async leave(room) {
          this.rooms.delete(room);
        },
        disconnect() {
          this.disconnected = true;
          this.rooms.clear();
        },
      };
    }
    const oldManager = socket("old-manager-socket", oldManagerId, [
      `user:${oldManagerId}`,
      `league:${LEAGUE_A}`,
      `team:${teamId}`,
    ]);
    const newManager = socket("new-manager-socket", newManagerId, [
      `user:${newManagerId}`,
      `league:${LEAGUE_A}`,
    ]);
    const sockets = [oldManager, newManager];
    const emissions = [];
    function matching(room) {
      return sockets.filter(({ rooms }) => rooms.has(room));
    }
    function broadcast(selectedRooms) {
      return {
        to(room) {
          return broadcast([...selectedRooms, room]);
        },
        emit(type, payload) {
          emissions.push({
            payload,
            recipients: sockets
              .filter(({ rooms }) =>
                selectedRooms.some((room) => rooms.has(room))
              )
              .map(({ id }) => id),
            type,
          });
        },
      };
    }
    const io = {
      in(room) {
        return {
          async fetchSockets() {
            return matching(room);
          },
        };
      },
      to(room) {
        return broadcast([room]);
      },
    };
    const publisher = createSocketIoInvalidationPublisher({
      getIo: () => io,
      getSocketReauthorizer: () => roomManager.reauthorize,
    });
    const eventId = uuid(923);
    const cardId = uuid(924);
    const fadId = uuid(925);
    const payload = createSocketEventEnvelope({
      eventId,
      type: "candidate_card.changed",
      leagueId: LEAGUE_A,
      resourceId: cardId,
      version: 3,
      reasonCode: "card_changed",
      occurredAt: NOW_MS,
      related: createEmptySocketRelated({
        fadId,
        teamId,
        cardId,
      }),
    });
    const event = {
      eventId,
      eventType: payload.type,
      leagueId: LEAGUE_A,
      aggregateType: "candidate_card",
      aggregateId: cardId,
      audiences: [
        {
          kind: "team",
          leagueId: LEAGUE_A,
          teamId,
          userId: null,
        },
      ],
      payload,
    };

    assert.deepEqual(await publisher.publish(event), {
      delivered: true,
      roomCount: 1,
    });
    assert.deepEqual(reauthorized.sort(), [
      oldManagerId,
      newManagerId,
    ]);
    assert.equal(oldManager.rooms.has(`team:${teamId}`), false);
    assert.equal(newManager.rooms.has(`team:${teamId}`), true);
    assert.deepEqual(emissions, [
      {
        payload,
        recipients: ["new-manager-socket"],
        type: "candidate_card.changed",
      },
    ]);

    await assert.rejects(
      createSocketIoInvalidationPublisher({
        getIo: () => io,
      }).publish(event),
      ({ code }) =>
        code === "SOCKET_AUDIENCE_AUTHORIZATION_FAILED"
    );
  });
});
