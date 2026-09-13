"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function migrations(maximumId = 51) {
  return discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY })
    .filter(({ id }) => id <= maximumId);
}

function apply(database, maximumId, buildId) {
  return applyMigrations({
    database,
    migrations: migrations(maximumId),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function databaseAt(maximumId, buildId) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  apply(database, maximumId, buildId);
  return database;
}

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  return database.prepare(`
    INSERT INTO ${tableName} (${fields.join(", ")})
    VALUES (${fields.map((field) => `@${field}`).join(", ")})
  `).run(values);
}

function constraint(callback) {
  assert.throws(callback, (error) => error?.code?.startsWith("SQLITE_CONSTRAINT"));
}

function candidateEntry(sequence, overrides = {}) {
  return {
    id: uuid(100 + sequence), league_id: uuid(1), season_id: uuid(2),
    fad_id: uuid(3), card_id: uuid(4), team_id: uuid(5),
    entry_kind: "candidate", player_id: uuid(200 + sequence),
    effective_position_group: "F", requested_slot_group: "F",
    requested_slot_number: sequence, placement_state: "placed", conflict_code: null,
    carryover_ownership_id: null, carryover_contract_id: null,
    source_roster_category: null, carryover_original_total_value_cents: null,
    carryover_original_term_years: null, carryover_aav_cents: null,
    remaining_years: null, proposed_total_value_cents: null,
    proposed_term_years: null, proposed_aav_cents: null,
    eligibility_status: "invalid", validation_code: "CANDIDATE_CONTRACT_INCOMPLETE",
    last_acknowledgement_revision_id: null, created_by_user_id: uuid(6),
    created_by_membership_id: uuid(7), created_by_authority: "manager",
    last_edited_by_user_id: uuid(6), last_edited_by_membership_id: uuid(7),
    last_edited_by_authority: "manager", created_at_ms: 100,
    updated_at_ms: 100, version: 1, ...overrides,
  };
}

function auctionBid(sequence, overrides = {}) {
  return {
    id: uuid(500 + sequence), league_id: uuid(1), season_id: uuid(2),
    auction_id: uuid(3), team_id: uuid(600 + sequence), submitted_by_user_id: uuid(6),
    total_value_cents: 1_000, term_years: 3, lowest_offered_aav_cents: 333,
    first_submitted_at_ms: 100, last_edited_at_ms: 100, edit_count: 0,
    status: "active", idempotency_request_id: null, version: 1, ...overrides,
  };
}

function dropTriggersFor(database, tableName, keep = new Set()) {
  for (const { name } of database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?
  `).all(tableName)) {
    if (!keep.has(name)) database.exec(`DROP TRIGGER ${name}`);
  }
}

test("discovers and applies schema 51 from both schema 50 and a fresh database", () => {
  const source = migrations().at(-1);
  assert.equal(source.id, 51);
  assert.equal(source.fileName, "0051_use_aav_first_candidate_cards_and_auctions.sql");
  assert.ok(source.sql.startsWith("-- hundo-leago: foreign-key-rebuild\n"));

  for (const [start, buildId] of [[50, "aav-first-upgrade"], [0, "aav-first-fresh"]]) {
    const database = start === 0 ? new Database(":memory:") : databaseAt(start, `${buildId}-base`);
    try {
      database.pragma("foreign_keys = ON");
      const state = apply(database, 51, buildId);
      assert.equal(state.userVersion, 51);
      assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(database.prepare(
        "SELECT metadata_value FROM application_metadata WHERE metadata_key = 'data_model_version'"
      ).get().metadata_value, "51");
    } finally {
      database.close();
    }
  }
});

test("schema 51 accepts legacy Candidate offers and admits AAV-first partial and complete rows", () => {
  const database = databaseAt(51, "aav-first-candidate-head");
  try {
    database.pragma("foreign_keys = OFF");
    dropTriggersFor(database, "candidate_card_entries");
    insert(database, "candidate_card_entries", candidateEntry(1, {
      proposed_total_value_cents: 900,
    }));
    insert(database, "candidate_card_entries", candidateEntry(2, {
      proposed_total_value_cents: 1_000, proposed_term_years: 3,
      proposed_aav_cents: 333, eligibility_status: "valid", validation_code: null,
    }));

    insert(database, "candidate_card_entries", candidateEntry(3, {
      proposed_aav_cents: 125,
    }));
    insert(database, "candidate_card_entries", candidateEntry(4, {
      proposed_total_value_cents: 250, proposed_term_years: 2,
      proposed_aav_cents: 125, eligibility_status: "valid", validation_code: null,
    }));
    constraint(() => insert(database, "candidate_card_entries", candidateEntry(5, {
      proposed_total_value_cents: 220, proposed_term_years: 2,
      proposed_aav_cents: 110, eligibility_status: "valid", validation_code: null,
    })));
  } finally {
    database.close();
  }
});

test("schema 51 defines the auction total backfill, enforces its low-water mark, and uses total-first draw evidence", () => {
  const source = migrations().at(-1);
  assert.match(
    source.sql,
    /SET lowest_offered_total_value_cents = total_value_cents/u
  );
  const database = databaseAt(51, "aav-first-auction-head");
  try {
    database.pragma("foreign_keys = OFF");
    dropTriggersFor(database, "auction_bids", new Set([
      "auction_bids_lowest_total_insert", "auction_bids_lowest_total_update",
    ]));
    insert(database, "auction_bids", auctionBid(1, {
      lowest_offered_total_value_cents: 1_000,
    }));

    assert.equal(database.prepare(`
      SELECT lowest_offered_total_value_cents FROM auction_bids WHERE id = ?
    `).get(uuid(501)).lowest_offered_total_value_cents, 1_000);

    database.prepare(`
      UPDATE auction_bids
      SET total_value_cents = 900,
          term_years = 3,
          lowest_offered_aav_cents = 300,
          lowest_offered_total_value_cents = 900,
          version = 2
      WHERE id = ?
    `).run(uuid(501));
    database.prepare(`
      UPDATE auction_bids
      SET total_value_cents = 1_200,
          term_years = 3,
          lowest_offered_aav_cents = 300,
          lowest_offered_total_value_cents = 900,
          version = 3
      WHERE id = ?
    `).run(uuid(501));
    constraint(() => database.prepare(`
      UPDATE auction_bids
      SET lowest_offered_total_value_cents = 1_200, version = 4
      WHERE id = ?
    `).run(uuid(501)));

    const revealSql = database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'trigger' AND name = 'free_agent_draft_draws_reveal_update'
    `).get().sql;
    const firstTotalRank = revealSql.indexOf("MAX(candidate.total_value_cents)");
    const firstAavRank = revealSql.indexOf("MAX(candidate.aav_cents)");
    assert.ok(firstTotalRank >= 0 && firstAavRank > firstTotalRank);
  } finally {
    database.close();
  }
});
