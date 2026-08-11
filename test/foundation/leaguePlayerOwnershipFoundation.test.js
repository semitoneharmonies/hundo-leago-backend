const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  LEAGUE_PLAYER_OWNERSHIP_CODES,
  LeaguePlayerOwnershipPolicyError,
  createLeaguePositionCorrectionRecord,
  validateLeaguePlayerLookup,
  validatePositionCorrectionReplacement,
  validateTeamOwnershipLookup,
} = require(
  "../../src/domain/players/leaguePlayerOwnershipPolicy"
);
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
  createSqliteLeaguePlayerOwnershipRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeaguePlayerOwnershipRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T00:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  user: uuid(1),
  leagueA: uuid(10),
  leagueB: uuid(11),
  seasonA: uuid(20),
  seasonB: uuid(21),
  teamA: uuid(30),
  teamB: uuid(31),
  player1: uuid(40),
  player2: uuid(41),
  correctionA1: uuid(50),
  correctionA2: uuid(51),
  correctionB1: uuid(52),
  ownershipA1: uuid(60),
  ownershipA2: uuid(61),
  ownershipB1: uuid(62),
});

function databaseSemanticHash(database) {
  const tableNames = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "ORDER BY name ASC"
    )
    .all()
    .map(({ name }) => name);
  const state = tableNames.map((tableName) => ({
    tableName,
    rows: database
      .prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC`)
      .all(),
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

function seedFoundation(context) {
  context.repositories.users.insert({
    id: IDS.user,
    email_normalized: "commissioner@example.test",
    email_display: "commissioner@example.test",
    display_name: "Commissioner",
    display_name_normalized: "commissioner",
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });

  [
    [IDS.leagueA, "Alpha League", "alpha league"],
    [IDS.leagueB, "Bravo League", "bravo league"],
  ].forEach(([id, name, normalizedName]) => {
    context.repositories.leagues.insert({
      id,
      name,
      name_normalized: normalizedName,
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  });

  [
    [IDS.seasonA, IDS.leagueA, "Season A", "2026A"],
    [IDS.seasonB, IDS.leagueB, "Season B", "2026B"],
  ].forEach(([id, leagueId, label, seasonKey]) => {
    context.repositories.seasons.insert({
      id,
      league_id: leagueId,
      label,
      nhl_season_key: seasonKey,
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  });

  [
    [IDS.teamA, IDS.leagueA, "Alpha Team", "alpha team"],
    [IDS.teamB, IDS.leagueB, "Bravo Team", "bravo team"],
  ].forEach(([id, leagueId, name, normalizedName]) => {
    context.repositories.teams.insert({
      id,
      league_id: leagueId,
      name,
      name_normalized: normalizedName,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  });

  [
    [IDS.player1, "One"],
    [IDS.player2, "Two"],
  ].forEach(([id, lastName]) => {
    context.repositories.players.insert({
      id,
      first_name: "Player",
      last_name: lastName,
      full_name: `Player ${lastName}`,
      birth_date: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  });
}

function createRuntime(
  t,
  { candidateCardSummerSynchronizer } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m4-02-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m4-02-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  seedFoundation(context);
  return {
    context,
    database: connection.database,
    repository: createSqliteLeaguePlayerOwnershipRepository({
      database: connection.database,
      candidateCardSummerSynchronizer:
        candidateCardSummerSynchronizer ?? {
          synchronize() {
            return Object.freeze({
              affectedCardCount: 0,
              changedCardCount: 0,
            });
          },
        },
    }),
  };
}

function correctionInput(overrides = {}) {
  return {
    id: IDS.correctionA1,
    leagueId: IDS.leagueA,
    playerId: IDS.player1,
    positionGroup: "F",
    reason: "Commissioner correction",
    correctedByUserId: IDS.user,
    effectiveAtMs: NOW_MS,
    ...overrides,
  };
}

function ownershipRecord(overrides = {}) {
  return {
    id: IDS.ownershipA1,
    league_id: IDS.leagueA,
    season_id: IDS.seasonA,
    player_id: IDS.player1,
    team_id: IDS.teamA,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
    ...overrides,
  };
}

function assertPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    return (
      error instanceof LeaguePlayerOwnershipPolicyError &&
      error.code ===
        LEAGUE_PLAYER_OWNERSHIP_CODES.inputInvalid &&
      error.reasonCode === reasonCode
    );
  });
}

describe("M4-02 league player ownership policy", () => {
  test("accepts only exact stable-ID lookups and F/D corrections", () => {
    const forward = createLeaguePositionCorrectionRecord(
      correctionInput()
    );
    const defence = createLeaguePositionCorrectionRecord(
      correctionInput({ positionGroup: "D", reason: null })
    );
    assert.equal(forward.position_group, "F");
    assert.equal(defence.position_group, "D");
    assert.equal(Object.isFrozen(forward), true);
    assert.equal(
      Object.isFrozen(
        validateLeaguePlayerLookup({
          leagueId: IDS.leagueA,
          playerId: IDS.player1,
        })
      ),
      true
    );
    assert.equal(
      Object.isFrozen(
        validateTeamOwnershipLookup({
          leagueId: IDS.leagueA,
          seasonId: IDS.seasonA,
          teamId: IDS.teamA,
        })
      ),
      true
    );

    assertPolicyError(
      () =>
        createLeaguePositionCorrectionRecord(
          correctionInput({ positionGroup: "G" })
        ),
      LEAGUE_PLAYER_OWNERSHIP_CODES.positionInvalid
    );
    assertPolicyError(
      () =>
        createLeaguePositionCorrectionRecord({
          ...correctionInput(),
          unknown: true,
        }),
      LEAGUE_PLAYER_OWNERSHIP_CODES.inputInvalid
    );
    assertPolicyError(
      () =>
        createLeaguePositionCorrectionRecord(
          correctionInput({ reason: "bad\nreason" })
        ),
      LEAGUE_PLAYER_OWNERSHIP_CODES.reasonInvalid
    );
    assertPolicyError(
      () =>
        validateLeaguePlayerLookup({
          leagueId: "not-a-stable-id",
          playerId: IDS.player1,
        }),
      LEAGUE_PLAYER_OWNERSHIP_CODES.stableIdInvalid
    );
  });

  test("requires replacement corrections to advance effective time", () => {
    assert.deepEqual(
      validatePositionCorrectionReplacement({
        currentEffectiveAtMs: NOW_MS,
        replacementEffectiveAtMs: NOW_MS + 1,
      }),
      {
        currentEffectiveAtMs: NOW_MS,
        replacementEffectiveAtMs: NOW_MS + 1,
      }
    );
    assertPolicyError(
      () =>
        validatePositionCorrectionReplacement({
          currentEffectiveAtMs: NOW_MS,
          replacementEffectiveAtMs: NOW_MS,
        }),
      LEAGUE_PLAYER_OWNERSHIP_CODES.timestampInvalid
    );
  });
});

describe("M4-02 league player ownership repository", () => {
  test("synchronizes one position correction and its current owner inside the mutation transaction", (t) => {
    const calls = [];
    let runtime;
    runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(runtime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    runtime.context.repositories.player_ownerships.insert(
      ownershipRecord()
    );

    runtime.repository.findCurrentPositionCorrection({
      leagueId: IDS.leagueA,
      playerId: IDS.player1,
    });
    runtime.repository.findOwnership({
      leagueId: IDS.leagueA,
      playerId: IDS.player1,
    });
    runtime.repository.listTeamOwnership({
      leagueId: IDS.leagueA,
      seasonId: IDS.seasonA,
      teamId: IDS.teamA,
    });
    assert.equal(calls.length, 0);

    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput()
    );
    assert.deepEqual(calls, [
      {
        leagueId: IDS.leagueA,
        affectedTeamIds: [IDS.teamA],
        affectedPlayerIds: [IDS.player1],
        sourceOperationId: IDS.correctionA1,
        sourceKind: "position_correction",
        nowMs: NOW_MS,
      },
    ]);
  });

  test("creates and reads a current correction without changing global player identity", (t) => {
    const runtime = createRuntime(t);
    const playerBefore = runtime.context.repositories.players.findByKey({
      key: IDS.player1,
    });
    const created = runtime.repository.replaceCurrentPositionCorrection(
      correctionInput()
    );
    const current =
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueA,
        playerId: IDS.player1,
      });

    assert.equal(created.previous, null);
    assert.deepEqual(current, created.current);
    assert.equal(Object.isFrozen(created), true);
    assert.equal(Object.isFrozen(current), true);
    assert.deepEqual(
      runtime.context.repositories.players.findByKey({
        key: IDS.player1,
      }),
      playerBefore
    );
  });

  test("atomically ends the prior correction and preserves one current row", (t) => {
    const runtime = createRuntime(t);
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput({ positionGroup: "D" })
    );
    const replacementEffectiveAtMs = NOW_MS + 1_000;
    const replaced =
      runtime.repository.replaceCurrentPositionCorrection(
        correctionInput({
          id: IDS.correctionA2,
          positionGroup: "F",
          effectiveAtMs: replacementEffectiveAtMs,
        })
      );

    assert.equal(replaced.previous.id, IDS.correctionA1);
    assert.equal(
      replaced.previous.ended_at_ms,
      replacementEffectiveAtMs
    );
    assert.equal(replaced.previous.version, 2);
    assert.equal(replaced.current.id, IDS.correctionA2);
    assert.equal(replaced.current.position_group, "F");
    assert.equal(
      runtime.database
        .prepare(
          "SELECT COUNT(*) AS count FROM league_player_positions " +
            "WHERE league_id = ? AND player_id = ? " +
            "AND ended_at_ms IS NULL"
        )
        .get(IDS.leagueA, IDS.player1).count,
      1
    );
  });

  test("keeps corrections for the same player isolated by league", (t) => {
    const runtime = createRuntime(t);
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput({ positionGroup: "F" })
    );
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput({
        id: IDS.correctionB1,
        leagueId: IDS.leagueB,
        positionGroup: "D",
      })
    );

    assert.equal(
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueA,
        playerId: IDS.player1,
      }).position_group,
      "F"
    );
    assert.equal(
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueB,
        playerId: IDS.player1,
      }).position_group,
      "D"
    );
    assert.equal(
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueB,
        playerId: IDS.player2,
      }),
      null
    );
  });

  test("reads ownership exactly by league/player and lists only the requested team", (t) => {
    const runtime = createRuntime(t);
    runtime.context.repositories.player_ownerships.insert(
      ownershipRecord()
    );
    runtime.context.repositories.player_ownerships.insert(
      ownershipRecord({
        id: IDS.ownershipA2,
        player_id: IDS.player2,
        roster_category: "Bench",
        position_group: "D",
        slot_number: 1,
      })
    );
    runtime.context.repositories.player_ownerships.insert(
      ownershipRecord({
        id: IDS.ownershipB1,
        league_id: IDS.leagueB,
        season_id: IDS.seasonB,
        team_id: IDS.teamB,
        position_group: "D",
      })
    );
    const before = databaseSemanticHash(runtime.database);

    const leagueAOwnership = runtime.repository.findOwnership({
      leagueId: IDS.leagueA,
      playerId: IDS.player1,
    });
    const leagueBOwnership = runtime.repository.findOwnership({
      leagueId: IDS.leagueB,
      playerId: IDS.player1,
    });
    const teamOwnership = runtime.repository.listTeamOwnership({
      leagueId: IDS.leagueA,
      seasonId: IDS.seasonA,
      teamId: IDS.teamA,
    });

    assert.equal(leagueAOwnership.id, IDS.ownershipA1);
    assert.equal(leagueBOwnership.id, IDS.ownershipB1);
    assert.equal(leagueAOwnership.position_group, "F");
    assert.equal(leagueBOwnership.position_group, "D");
    assert.deepEqual(
      new Set(teamOwnership.map(({ id }) => id)),
      new Set([IDS.ownershipA1, IDS.ownershipA2])
    );
    assert.equal(Object.isFrozen(leagueAOwnership), true);
    assert.equal(Object.isFrozen(teamOwnership), true);
    assert.equal(Object.isFrozen(teamOwnership[0]), true);
    assert.equal(
      runtime.repository.findOwnership({
        leagueId: IDS.leagueA,
        playerId: uuid(999),
      }),
      null
    );
    assert.deepEqual(
      runtime.repository.listTeamOwnership({
        leagueId: IDS.leagueB,
        seasonId: IDS.seasonB,
        teamId: IDS.teamA,
      }),
      []
    );
    assert.equal(databaseSemanticHash(runtime.database), before);
  });

  test("rolls back the prior-row ending when replacement insertion fails", (t) => {
    const runtime = createRuntime(t);
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput()
    );
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput({
        id: IDS.correctionB1,
        leagueId: IDS.leagueB,
        playerId: IDS.player2,
      })
    );
    const before = databaseSemanticHash(runtime.database);

    assert.throws(
      () =>
        runtime.repository.replaceCurrentPositionCorrection(
          correctionInput({
            id: IDS.correctionB1,
            positionGroup: "D",
            effectiveAtMs: NOW_MS + 1_000,
          })
        ),
      (error) => error.code === REPOSITORY_ERROR_CODES.constraint
    );
    assert.equal(databaseSemanticHash(runtime.database), before);
    const current =
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueA,
        playerId: IDS.player1,
      });
    assert.equal(current.id, IDS.correctionA1);
    assert.equal(current.ended_at_ms, null);
    assert.equal(current.version, 1);
  });

  test("rolls the prior correction and replacement back when Candidate synchronization fails", (t) => {
    let synchronizationMustFail = false;
    const runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize() {
          if (synchronizationMustFail) {
            throw new Error(
              "injected Candidate synchronization failure"
            );
          }
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    runtime.repository.replaceCurrentPositionCorrection(
      correctionInput()
    );
    const before = databaseSemanticHash(runtime.database);
    synchronizationMustFail = true;

    assert.throws(
      () =>
        runtime.repository.replaceCurrentPositionCorrection(
          correctionInput({
            id: IDS.correctionA2,
            positionGroup: "D",
            effectiveAtMs: NOW_MS + 1_000,
          })
        ),
      (error) =>
        error.code === REPOSITORY_ERROR_CODES.operationFailed &&
        error.cause?.message ===
          "injected Candidate synchronization failure"
    );
    assert.equal(databaseSemanticHash(runtime.database), before);
    const current =
      runtime.repository.findCurrentPositionCorrection({
        leagueId: IDS.leagueA,
        playerId: IDS.player1,
      });
    assert.equal(current.id, IDS.correctionA1);
    assert.equal(current.ended_at_ms, null);
    assert.equal(current.version, 1);
  });
});
