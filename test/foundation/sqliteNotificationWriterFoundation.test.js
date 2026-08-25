const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteNotificationWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteNotificationWriter"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
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
const LEAGUE_A = "00000000-0000-4000-8000-000000000011";
const LEAGUE_B = "00000000-0000-4000-8000-000000000012";

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-02-notification-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-02-notification-test",
    now: () => NOW_MS,
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

  return Object.freeze({
    database: connection.database,
    writer: createSqliteNotificationWriter({
      database: connection.database,
    }),
  });
}

function command(overrides = {}) {
  return {
    id: uuid(100),
    userId: USER_A,
    leagueId: LEAGUE_A,
    eventType: "fad_deadline_approaching",
    messageDataJson: JSON.stringify({
      schemaVersion: 1,
      destination: {
        kind: "private_card",
        leagueId: LEAGUE_A,
      },
    }),
    relatedFeature: "free_agent_draft",
    relatedRecordId: uuid(700),
    deliveryStatus: "delivered",
    createdAtMs: NOW_MS,
    deliveredAtMs: NOW_MS,
    deduplicationKey:
      `fad:${uuid(800)}:deadline-reminder:${uuid(801)}:${USER_A}`,
    ...overrides,
  };
}

function count(database) {
  return database
    .prepare(
      "SELECT COUNT(*) AS count FROM notifications"
    )
    .get().count;
}

function isCode(code) {
  return (error) => error?.code === code;
}

describe("FAD-02 strict SQLite notification writer", () => {
  test("preserves distinct null-key notification behavior", (t) => {
    const runtime = createRuntime(t);
    const first = runtime.writer.insert(
      command({
        id: uuid(101),
        deduplicationKey: null,
      })
    );
    const second = runtime.writer.insert(
      command({
        id: uuid(102),
        deduplicationKey: null,
      })
    );

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, false);
    assert.notEqual(
      first.notification.id,
      second.notification.id
    );
    assert.equal(count(runtime.database), 2);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT id, deduplication_key
          FROM notifications
          ORDER BY id
        `)
        .all(),
      [
        {
          id: uuid(101),
          deduplication_key: null,
        },
        {
          id: uuid(102),
          deduplication_key: null,
        },
      ]
    );
  });

  test("returns one existing logical notification on exact keyed replay", (t) => {
    const runtime = createRuntime(t);
    const first = runtime.writer.insert(
      command({ id: uuid(110) })
    );
    const replay = runtime.writer.insert(
      command({ id: uuid(111) })
    );

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.notification.id, uuid(110));
    assert.equal(count(runtime.database), 1);

    runtime.database
      .prepare(`
        UPDATE notifications
        SET read_at_ms = @readAtMs,
            version = version + 1
        WHERE id = @id
      `)
      .run({
        id: uuid(110),
        readAtMs: NOW_MS + 1,
      });
    const replayAfterRead = runtime.writer.insert(
      command({ id: uuid(112) })
    );
    assert.equal(replayAfterRead.replayed, true);
    assert.equal(
      replayAfterRead.notification.read_at_ms,
      NOW_MS + 1
    );
    assert.equal(
      replayAfterRead.notification.version,
      2
    );
    assert.equal(count(runtime.database), 1);
  });

  test("fails closed when a keyed collision changes logical content", (t) => {
    const runtime = createRuntime(t);
    runtime.writer.insert(command({ id: uuid(120) }));
    const variants = [
      { id: uuid(121), leagueId: LEAGUE_B },
      {
        id: uuid(122),
        messageDataJson: JSON.stringify({
          schemaVersion: 1,
          changed: true,
        }),
      },
      {
        id: uuid(123),
        relatedFeature: "auction",
        relatedRecordId: uuid(701),
      },
      {
        id: uuid(124),
        deliveryStatus: "suppressed",
        deliveredAtMs: null,
      },
      {
        id: uuid(125),
        createdAtMs: NOW_MS + 1,
        deliveredAtMs: NOW_MS + 1,
      },
    ];

    for (const changes of variants) {
      assert.throws(
        () => runtime.writer.insert(command(changes)),
        isCode(
          REPOSITORY_ERROR_CODES.versionConflict
        )
      );
      assert.equal(count(runtime.database), 1);
    }
    assert.equal(
      runtime.database
        .prepare(`
          SELECT id
          FROM notifications
        `)
        .get().id,
      uuid(120)
    );
  });

  test("allows one key across different users or event types", (t) => {
    const runtime = createRuntime(t);
    const sharedKey = "shared-logical-key";
    runtime.writer.insert(
      command({
        id: uuid(130),
        deduplicationKey: sharedKey,
      })
    );
    runtime.writer.insert(
      command({
        id: uuid(131),
        userId: USER_B,
        deduplicationKey: sharedKey,
      })
    );
    runtime.writer.insert(
      command({
        id: uuid(132),
        eventType: "fad_cards_opened",
        deduplicationKey: sharedKey,
      })
    );

    assert.equal(count(runtime.database), 3);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT user_id, event_type
          FROM notifications
          ORDER BY id
        `)
        .all(),
      [
        {
          user_id: USER_A,
          event_type:
            "fad_deadline_approaching",
        },
        {
          user_id: USER_B,
          event_type:
            "fad_deadline_approaching",
        },
        {
          user_id: USER_A,
          event_type: "fad_cards_opened",
        },
      ]
    );
  });

  test("rejects malformed IDs, timestamps, JSON, pairs, status, and keys", (t) => {
    const runtime = createRuntime(t);
    const invalidCommands = [
      { ...command(), unexpected: true },
      command({ id: "not-an-id" }),
      command({ userId: "not-a-user" }),
      command({ leagueId: "not-a-league" }),
      command({ eventType: "Unsafe Event" }),
      command({ messageDataJson: "not-json" }),
      command({ messageDataJson: "[]" }),
      command({ relatedFeature: null }),
      command({ relatedRecordId: null }),
      command({ deliveryStatus: "unknown" }),
      command({
        deliveryStatus: "pending",
        deliveredAtMs: NOW_MS,
      }),
      command({ deliveredAtMs: NOW_MS - 1 }),
      command({ createdAtMs: -1 }),
      command({ deduplicationKey: "" }),
      command({ deduplicationKey: " untrimmed" }),
      command({ deduplicationKey: "x".repeat(501) }),
    ];

    for (const invalidCommand of invalidCommands) {
      assert.throws(
        () => runtime.writer.insert(invalidCommand),
        isCode(
          REPOSITORY_ERROR_CODES.argumentInvalid
        )
      );
    }
    assert.equal(count(runtime.database), 0);
  });

  test("joins caller transactions and never ignores a conflicting insert", (t) => {
    const runtime = createRuntime(t);
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "src",
        "infrastructure",
        "persistence",
        "sqlite",
        "SqliteNotificationWriter.js"
      ),
      "utf8"
    );
    assert.doesNotMatch(
      source,
      /INSERT\s+OR\s+IGNORE/i
    );

    const outer = runtime.database.transaction(() => {
      runtime.writer.insert(
        command({ id: uuid(140) })
      );
      throw new Error("forced outer rollback");
    });
    assert.throws(
      () => outer.immediate(),
      /forced outer rollback/
    );
    assert.equal(count(runtime.database), 0);

    runtime.writer.insert(
      command({
        id: uuid(141),
        deduplicationKey: null,
      })
    );
    assert.throws(
      () =>
        runtime.writer.insert(
          command({
            id: uuid(141),
            deduplicationKey: null,
          })
        ),
      isCode(REPOSITORY_ERROR_CODES.constraint)
    );
    assert.equal(count(runtime.database), 1);
  });
});
