const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
  createSocketInvalidation,
  createSocketEventMetadata,
} = require("../../src/domain/leagues/socketInvalidation");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueOutboxWriter,
  resolveSqliteLeagueOutboxWriter,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-29T12:00:00.000Z");

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  leagueA: uuid(1),
  leagueB: uuid(2),
  teamA: uuid(3),
  teamB: uuid(4),
  userA: uuid(5),
  membershipA: uuid(6),
  eventA: uuid(10),
  eventB: uuid(11),
  eventC: uuid(12),
  eventD: uuid(13),
  aggregateA: uuid(20),
});

function seed(database) {
  const insertLeague = database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @id, @name, @nameNormalized, 'active', 'America/Vancouver',
      NULL, NULL, @nowMs, @nowMs, 1
    )
  `);
  insertLeague.run({
    id: IDS.leagueA,
    name: "League A",
    nameNormalized: "league a",
    nowMs: NOW_MS,
  });
  insertLeague.run({
    id: IDS.leagueB,
    name: "League B",
    nameNormalized: "league b",
    nowMs: NOW_MS,
  });
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      @id, 'manager@example.test', 'manager@example.test',
      'Manager A', 'manager a', 'active', @nowMs, @nowMs, 1
    )
  `).run({ id: IDS.userA, nowMs: NOW_MS });
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms,
      version
    ) VALUES (
      @id, @leagueId, @userId, 'manager', 'active',
      @nowMs, NULL, @nowMs, @nowMs, 1
    )
  `).run({
    id: IDS.membershipA,
    leagueId: IDS.leagueA,
    userId: IDS.userA,
    nowMs: NOW_MS,
  });
  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      primary_colour, secondary_colour, logo_reference,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @id, @leagueId, @name, @nameNormalized, 'active',
      NULL, NULL, NULL, @nowMs, @nowMs, 1
    )
  `);
  insertTeam.run({
    id: IDS.teamA,
    leagueId: IDS.leagueA,
    name: "Team A",
    nameNormalized: "team a",
    nowMs: NOW_MS,
  });
  insertTeam.run({
    id: IDS.teamB,
    leagueId: IDS.leagueB,
    name: "Team B",
    nameNormalized: "team b",
    nowMs: NOW_MS,
  });
}

function createRuntime(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-league-outbox-writer-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-02-league-outbox-writer-test",
    now: () => NOW_MS,
  });
  seed(connection.database);
  const writer = createSqliteLeagueOutboxWriter({
    database: connection.database,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    writer,
  });
}

function event(overrides = {}) {
  const values = {
    id: IDS.eventA,
    leagueId: IDS.leagueA,
    eventType: "auction.updated",
    aggregateType: "auction",
    aggregateId: IDS.aggregateA,
    occurredAtMs: NOW_MS,
    ...overrides,
  };
  return {
    ...values,
    payload:
      overrides.payload ||
      createSocketInvalidation({
        eventType: values.eventType,
        scope: "league",
        scopeId: values.leagueId,
        version: 2,
        changedAtMs: values.occurredAtMs,
      }),
  };
}

function count(database, tableName) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .get().count;
}

describe("FAD-02 shared atomic league outbox writer", () => {
  test("writes an ordinary event with exactly one league audience", (t) => {
    const runtime = createRuntime(t);
    const input = event();

    const result = runtime.writer.write(input);

    assert.deepEqual(result.event, {
      id: IDS.eventA,
      league_id: IDS.leagueA,
      event_type: "auction.updated",
      aggregate_type: "auction",
      aggregate_id: IDS.aggregateA,
      payload_json: JSON.stringify(input.payload),
      status: "pending",
      attempt_count: 0,
      available_at_ms: NOW_MS,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    assert.deepEqual(result.audiences, [
      {
        id: IDS.eventA,
        league_id: IDS.leagueA,
        outbox_event_id: IDS.eventA,
        audience_kind: "league",
        team_id: null,
        user_id: null,
        created_at_ms: NOW_MS,
      },
    ]);
    assert.equal(count(runtime.database, "outbox_events"), 1);
    assert.equal(
      count(runtime.database, "outbox_event_audiences"),
      1
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("writes explicit same-league team and user audiences only", (t) => {
    const runtime = createRuntime(t);

    const result = runtime.writer.write(
      event({
        id: IDS.eventB,
        eventType: "candidate_card.changed",
        aggregateType: "candidate_card",
        audiences: [
          { kind: "team", teamId: IDS.teamA },
          { kind: "user", userId: IDS.userA },
        ],
      })
    );

    assert.deepEqual(
      result.audiences.map((audience) => ({
        kind: audience.audience_kind,
        teamId: audience.team_id,
        userId: audience.user_id,
      })),
      [
        { kind: "team", teamId: IDS.teamA, userId: null },
        { kind: "user", teamId: null, userId: IDS.userA },
      ]
    );
    assert.equal(
      result.audiences.every(
        (audience) =>
          audience.id !== IDS.eventB &&
          /^[0-9a-f-]{36}$/.test(audience.id)
      ),
      true
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
            AND audience_kind = 'league'
        `)
        .get(IDS.eventB).count,
      0
    );
  });

  test("writes exact canonical metadata with all eight nullable related identifiers", (t) => {
    const runtime = createRuntime(t);
    const payload = createSocketEventMetadata({
      eventType: "candidate_card.changed",
      version: 7,
      reasonCode: "card_changed",
      occurredAtMs: NOW_MS,
      related: createEmptySocketRelated({
        fadId: IDS.aggregateA,
        teamId: IDS.teamA,
        cardId: IDS.eventD,
      }),
    });

    const result = runtime.writer.write(
      event({
        id: IDS.eventD,
        eventType: "candidate_card.changed",
        aggregateType: "candidate_card",
        aggregateId: IDS.eventD,
        payload,
        audiences: [{ kind: "team", teamId: IDS.teamA }],
      })
    );

    const envelope = createSocketEventEnvelope({
      eventId: IDS.eventD,
      type: "candidate_card.changed",
      leagueId: IDS.leagueA,
      resourceId: IDS.eventD,
      version: 7,
      reasonCode: "card_changed",
      occurredAt: NOW_MS,
      related: payload.related,
    });
    assert.deepEqual(JSON.parse(result.event.payload_json), envelope);
    assert.deepEqual(Object.keys(envelope), [
      "eventId",
      "type",
      "leagueId",
      "resourceId",
      "version",
      "reasonCode",
      "occurredAt",
      "related",
    ]);
    assert.deepEqual(Object.keys(envelope.related), [
      "fadId",
      "teamId",
      "cardId",
      "allocationId",
      "auctionId",
      "recoveryId",
      "nominationQueueId",
      "scheduleRecoveryOperationId",
    ]);
    assert.doesNotMatch(
      result.event.payload_json,
      /player|offer|contractValue|helpMessage|activeBid/i
    );
  });

  test("admits the exact setup-exemption Activity and notification publication reasons", () => {
    const activity = createSocketEventMetadata({
      eventType: "activity.created",
      version: 1,
      reasonCode: "setup_exemption_authorized",
      occurredAtMs: NOW_MS,
      related: createEmptySocketRelated(),
    });
    const notification = createSocketEventMetadata({
      eventType: "notification.created",
      version: 1,
      reasonCode: "setup_exemption_authorized",
      occurredAtMs: NOW_MS,
      related: createEmptySocketRelated(),
    });
    assert.equal(
      activity.reasonCode,
      "setup_exemption_authorized"
    );
    assert.equal(
      notification.reasonCode,
      "setup_exemption_authorized"
    );
    assert.deepEqual(
      notification.related,
      createEmptySocketRelated()
    );
    assert.deepEqual(activity.related, createEmptySocketRelated());
  });

  test("accepts an exact preassembled envelope only when wrapper identities agree", (t) => {
    const runtime = createRuntime(t);
    const payload = createSocketEventEnvelope({
      eventId: IDS.eventC,
      type: "free_agent_draft.changed",
      leagueId: IDS.leagueA,
      resourceId: IDS.aggregateA,
      version: 3,
      reasonCode: "cards_opened",
      occurredAt: NOW_MS,
      related: createEmptySocketRelated({
        fadId: IDS.aggregateA,
      }),
    });

    const written = runtime.writer.write(
      event({
        id: IDS.eventC,
        eventType: "free_agent_draft.changed",
        aggregateType: "free_agent_draft",
        aggregateId: IDS.aggregateA,
        payload,
      })
    );
    assert.deepEqual(JSON.parse(written.event.payload_json), payload);

    assert.throws(
      () =>
        runtime.writer.write(
          event({
            id: IDS.eventD,
            eventType: "free_agent_draft.changed",
            aggregateType: "free_agent_draft",
            aggregateId: IDS.aggregateA,
            payload,
          })
        ),
      ({ code }) => code === "REPOSITORY_ARGUMENT_INVALID"
    );
  });

  test("rejects six-ID, extra-key, private-value, and incompatible reason metadata", (t) => {
    const runtime = createRuntime(t);
    const sixRelated = {
      fadId: null,
      teamId: null,
      cardId: null,
      allocationId: null,
      auctionId: null,
      recoveryId: null,
    };
    const invalidCanonicalPayloads = [
      {
        kind: "socket_event",
        eventType: "candidate_card.changed",
        version: 2,
        reasonCode: "card_changed",
        occurredAtMs: NOW_MS,
        related: sixRelated,
      },
      {
        ...createSocketEventMetadata({
          eventType: "candidate_card.changed",
          version: 2,
          reasonCode: "card_changed",
          occurredAtMs: NOW_MS,
          related: createEmptySocketRelated(),
        }),
        playerId: IDS.userA,
      },
      {
        kind: "socket_event",
        eventType: "candidate_card.changed",
        version: 2,
        reasonCode: "auction_changed",
        occurredAtMs: NOW_MS,
        related: createEmptySocketRelated(),
      },
      {
        kind: "socket_event",
        eventType: "candidate_card.changed",
        version: 2,
        reasonCode: "card_changed",
        occurredAtMs: NOW_MS,
        related: {
          ...createEmptySocketRelated(),
          playerId: IDS.userA,
        },
      },
    ];

    for (const payload of invalidCanonicalPayloads) {
      assert.throws(
        () =>
          runtime.writer.write(
            event({
              eventType: "candidate_card.changed",
              aggregateType: "candidate_card",
              payload,
            })
          ),
        ({ code }) => code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    assert.equal(count(runtime.database, "outbox_events"), 0);
  });

  test("rolls back the parent when a same-league audience constraint fails", (t) => {
    const runtime = createRuntime(t);

    assert.throws(
      () =>
        runtime.writer.write(
          event({
            id: IDS.eventC,
            audiences: [
              { kind: "team", teamId: IDS.teamB },
            ],
          })
        ),
      (error) => error?.code === "REPOSITORY_CONSTRAINT"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE id = ?")
        .get(IDS.eventC).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
        `)
        .get(IDS.eventC).count,
      0
    );
  });

  test("propagates an audience failure through a surrounding transaction", (t) => {
    const runtime = createRuntime(t);
    runtime.database.exec(`
      CREATE TABLE league_outbox_writer_probe (
        id INTEGER PRIMARY KEY
      ) STRICT
    `);
    const callerTransaction = runtime.database.transaction(() => {
      runtime.database
        .prepare("INSERT INTO league_outbox_writer_probe (id) VALUES (1)")
        .run();
      runtime.writer.write(
        event({
          id: IDS.eventD,
          audiences: [
            { kind: "team", teamId: IDS.teamB },
          ],
        })
      );
    });

    assert.throws(
      () => callerTransaction.immediate(),
      (error) => error?.code === "REPOSITORY_CONSTRAINT"
    );
    assert.equal(
      count(runtime.database, "league_outbox_writer_probe"),
      0
    );
    assert.equal(
      runtime.database
        .prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE id = ?")
        .get(IDS.eventD).count,
      0
    );
  });

  test("rejects noncanonical event, timestamp, metadata, and audience input", (t) => {
    const runtime = createRuntime(t);
    const invalidInputs = [
      event({ id: "00000000-0000-4000-8000-00000000000A" }),
      event({
        eventType: "Auction Updated",
        payload: createSocketInvalidation({
          eventType: "auction.updated",
          scope: "league",
          scopeId: IDS.leagueA,
          version: 2,
          changedAtMs: NOW_MS,
        }),
      }),
      event({ aggregateType: "Trade Proposal" }),
      event({
        occurredAtMs: -1,
        payload: createSocketInvalidation({
          eventType: "auction.updated",
          scope: "league",
          scopeId: IDS.leagueA,
          version: 2,
          changedAtMs: NOW_MS,
        }),
      }),
      event({
        payload: createSocketInvalidation({
          eventType: "trade.changed",
          scope: "league",
          scopeId: IDS.leagueA,
          version: 2,
          changedAtMs: NOW_MS,
        }),
      }),
      event({
        payload: {
          kind: "invalidation",
          eventType: "auction.updated",
          scope: "league",
          scopeId: IDS.leagueB,
          version: 2,
          changedAtMs: NOW_MS,
        },
      }),
      event({ audiences: [] }),
      event({
        audiences: [{ kind: "league" }, { kind: "league" }],
      }),
      event({
        audiences: [
          { kind: "league" },
          { kind: "team", teamId: IDS.teamA },
        ],
      }),
      event({
        audiences: [{ kind: "team", teamId: "not-a-uuid" }],
      }),
      event({
        payload: {
          kind: "invalidation",
          eventType: "auction.updated",
          scope: "league",
          scopeId: IDS.leagueA,
          version: 1.5,
          changedAtMs: NOW_MS,
        },
      }),
    ];

    for (const input of invalidInputs) {
      assert.throws(
        () => runtime.writer.write(input),
        (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(
      count(runtime.database, "outbox_event_audiences"),
      0
    );
  });

  test("supports explicit injection and guards all current league writers", (t) => {
    const runtime = createRuntime(t);
    const injected = Object.freeze({ write() {} });
    assert.equal(
      resolveSqliteLeagueOutboxWriter({
        database: runtime.database,
        leagueOutboxWriter: injected,
      }),
      injected
    );
    assert.throws(
      () =>
        resolveSqliteLeagueOutboxWriter({
          database: runtime.database,
          leagueOutboxWriter: {},
        }),
      (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
    );

    const repositoryPaths = [
      "SqliteAuctionResolutionRepository.js",
      "SqliteTradeProposalRepository.js",
      "SqliteTradeExpiryRepository.js",
      "SqliteTradeReversalRepository.js",
    ].map((fileName) =>
      path.join(
        ROOT_DIRECTORY,
        "src",
        "infrastructure",
        "persistence",
        "sqlite",
        fileName
      )
    );
    for (const repositoryPath of repositoryPaths) {
      const source = fs.readFileSync(repositoryPath, "utf8");
      assert.doesNotMatch(source, /outbox_events/);
      assert.match(source, /resolveSqliteLeagueOutboxWriter/);
      assert.match(source, /outboxWriter\.write/);
    }
  });
});
