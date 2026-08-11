const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  createSqliteCandidateCardSummerSynchronizer,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardSummerSynchronizer"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  cardA: uuid(11),
  cardB: uuid(12),
  cardC: uuid(13),
  teamA: uuid(21),
  teamB: uuid(22),
  teamC: uuid(23),
  playerEntry: uuid(31),
  playerOwnership: uuid(32),
  entry: uuid(41),
  ownership: uuid(42),
  operation: uuid(51),
});

function createDatabase(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-candidate-summer-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "summer.sqlite3"),
    environment: "test",
  });
  connection.database.exec(`
    CREATE TABLE free_agent_drafts (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (league_id, id)
    ) STRICT;
    CREATE TABLE candidate_cards (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (league_id, id)
    ) STRICT;
    CREATE TABLE candidate_card_entries (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      PRIMARY KEY (league_id, id)
    ) STRICT;
    CREATE TABLE player_ownerships (
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      PRIMARY KEY (league_id, id)
    ) STRICT;
    CREATE TABLE summer_probe (
      id INTEGER PRIMARY KEY
    ) STRICT;
  `);
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return connection.database;
}

function seedOpenCards(database) {
  database
    .prepare(`
      INSERT INTO free_agent_drafts (
        league_id, season_id, id, status
      ) VALUES (?, ?, ?, 'cards_open')
    `)
    .run(IDS.league, IDS.season, IDS.fad);
  const insertCard = database.prepare(`
    INSERT INTO candidate_cards (
      league_id, season_id, fad_id, id, team_id, status, version
    ) VALUES (?, ?, ?, ?, ?, 'open', ?)
  `);
  insertCard.run(
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.cardC,
    IDS.teamC,
    4
  );
  insertCard.run(
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.cardA,
    IDS.teamA,
    2
  );
  insertCard.run(
    IDS.league,
    IDS.season,
    IDS.fad,
    IDS.cardB,
    IDS.teamB,
    3
  );
  database
    .prepare(`
      INSERT INTO candidate_card_entries (
        league_id, season_id, fad_id, card_id, team_id, id, player_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.cardA,
      IDS.teamA,
      IDS.entry,
      IDS.playerEntry
    );
  database
    .prepare(`
      INSERT INTO player_ownerships (
        league_id, season_id, id, player_id, team_id
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      IDS.league,
      IDS.season,
      IDS.ownership,
      IDS.playerOwnership,
      IDS.teamB
    );
}

function input(overrides = {}) {
  return {
    leagueId: IDS.league,
    affectedTeamIds: [IDS.teamC],
    affectedPlayerIds: [
      IDS.playerOwnership,
      IDS.playerEntry,
    ],
    sourceOperationId: IDS.operation,
    sourceKind: "trade_execution",
    nowMs: 1_000,
    ...overrides,
  };
}

describe("FAD-09 Candidate Card summer synchronizer", () => {
  test("discovers entry, ownership, and explicit-team cards and delegates in stable order inside the source transaction", (t) => {
    const database = createDatabase(t);
    seedOpenCards(database);
    const calls = [];
    const repository = {
      synchronizeSummerStateCurrent(command) {
        calls.push(command);
        const changed = command.scope.cardId !== IDS.cardB;
        return {
          changed,
          action: changed
            ? command.scope.cardId === IDS.cardA
              ? "eligibility_revalidated"
              : "summer_state_synchronized"
            : null,
          cardVersion:
            command.scope.cardId === IDS.cardA
              ? 3
              : command.scope.cardId === IDS.cardB
                ? 3
                : 5,
          revisionId: changed ? command.revisionId : null,
        };
      },
    };
    const synchronizer =
      createSqliteCandidateCardSummerSynchronizer({
        database,
        candidateCardRepository: repository,
      });

    const result = database
      .transaction(() => synchronizer.synchronize(input()))
      .immediate();

    assert.equal(result.affectedCardCount, 3);
    assert.equal(result.changedCardCount, 2);
    assert.deepEqual(
      calls.map(({ scope }) => scope.cardId),
      [IDS.cardA, IDS.cardB, IDS.cardC]
    );
    for (const call of calls) {
      assert.deepEqual(call.affectedPlayerIds, [
        IDS.playerEntry,
        IDS.playerOwnership,
      ]);
      assert.equal(call.sourceOperationId, IDS.operation);
      assert.equal(call.sourceKind, "trade_execution");
      assert.equal(call.nowMs, 1_000);
      assert.match(
        call.revisionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
    assert.deepEqual(
      result.cards.map(({ scope, changed, action }) => ({
        cardId: scope.cardId,
        changed,
        action,
      })),
      [
        {
          cardId: IDS.cardA,
          changed: true,
          action: "eligibility_revalidated",
        },
        {
          cardId: IDS.cardB,
          changed: false,
          action: null,
        },
        {
          cardId: IDS.cardC,
          changed: true,
          action: "summer_state_synchronized",
        },
      ]
    );

    const firstRevisionIds = calls.map(({ revisionId }) => revisionId);
    calls.length = 0;
    database
      .transaction(() => synchronizer.synchronize(input()))
      .immediate();
    assert.deepEqual(
      calls.map(({ revisionId }) => revisionId),
      firstRevisionIds
    );
  });

  test("returns an exact no-op when no matching FAD is open", (t) => {
    const database = createDatabase(t);
    seedOpenCards(database);
    database
      .prepare(
        "UPDATE free_agent_drafts SET status = 'deadline_locked'"
      )
      .run();
    let calls = 0;
    const synchronizer =
      createSqliteCandidateCardSummerSynchronizer({
        database,
        candidateCardRepository: {
          synchronizeSummerStateCurrent() {
            calls += 1;
          },
        },
      });

    const result = database
      .transaction(() => synchronizer.synchronize(input()))
      .immediate();
    assert.deepEqual(result, {
      leagueId: IDS.league,
      sourceOperationId: IDS.operation,
      sourceKind: "trade_execution",
      affectedCardCount: 0,
      changedCardCount: 0,
      cards: [],
    });
    assert.equal(calls, 0);
  });

  test("rejects malformed commands and refuses to run outside the source transaction", (t) => {
    const database = createDatabase(t);
    seedOpenCards(database);
    const synchronizer =
      createSqliteCandidateCardSummerSynchronizer({
        database,
        candidateCardRepository: {
          synchronizeSummerStateCurrent() {
            throw new Error("must not be reached");
          },
        },
      });
    for (const command of [
      { ...input(), unexpected: true },
      input({ sourceKind: "unknown" }),
      input({ sourceOperationId: "not-a-uuid" }),
      input({ affectedTeamIds: [IDS.teamC, IDS.teamC] }),
      input({ affectedTeamIds: [], affectedPlayerIds: [] }),
    ]) {
      assert.throws(
        () => synchronizer.synchronize(command),
        (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
    assert.throws(
      () => synchronizer.synchronize(input()),
      (error) => error?.code === "REPOSITORY_ARGUMENT_INVALID"
    );
  });

  test("propagates a per-card failure so the source transaction rolls back", (t) => {
    const database = createDatabase(t);
    seedOpenCards(database);
    let calls = 0;
    const synchronizer =
      createSqliteCandidateCardSummerSynchronizer({
        database,
        candidateCardRepository: {
          synchronizeSummerStateCurrent(command) {
            calls += 1;
            if (calls === 2) {
              throw new Error("injected summer card failure");
            }
            return {
              changed: true,
              action: "carryover_synchronized",
              cardVersion: 3,
              revisionId: command.revisionId,
            };
          },
        },
      });
    const transaction = database.transaction(() => {
      database
        .prepare("INSERT INTO summer_probe (id) VALUES (1)")
        .run();
      synchronizer.synchronize(input());
    });

    assert.throws(
      () => transaction.immediate(),
      (error) => error?.code === "REPOSITORY_OPERATION_FAILED"
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM summer_probe").get()
        .count,
      0
    );
  });
});
