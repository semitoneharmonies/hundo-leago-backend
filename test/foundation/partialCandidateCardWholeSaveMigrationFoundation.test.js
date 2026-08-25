"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function migrations(maximumId = 50) {
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

function constraint(callback, pattern) {
  assert.throws(callback, (error) =>
    error?.code?.startsWith("SQLITE_CONSTRAINT") &&
    (!pattern || pattern.test(error.message))
  );
}

function candidateEntry(sequence, overrides = {}) {
  return {
    id: uuid(100 + sequence),
    league_id: uuid(1),
    season_id: uuid(2),
    fad_id: uuid(3),
    card_id: uuid(4),
    team_id: uuid(5),
    entry_kind: "candidate",
    player_id: uuid(200 + sequence),
    effective_position_group: "F",
    requested_slot_group: "F",
    requested_slot_number: sequence,
    placement_state: "placed",
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: null,
    proposed_term_years: null,
    proposed_aav_cents: null,
    eligibility_status: "invalid",
    validation_code: "CANDIDATE_CONTRACT_INCOMPLETE",
    last_acknowledgement_revision_id: null,
    created_by_user_id: uuid(6),
    created_by_membership_id: uuid(7),
    created_by_authority: "manager",
    last_edited_by_user_id: uuid(6),
    last_edited_by_membership_id: uuid(7),
    last_edited_by_authority: "manager",
    created_at_ms: 100,
    updated_at_ms: 100,
    version: 1,
    ...overrides,
  };
}

function snapshotEntry(sequence, overrides = {}) {
  return {
    id: uuid(300 + sequence),
    league_id: uuid(1),
    season_id: uuid(2),
    fad_id: uuid(3),
    snapshot_id: uuid(8),
    card_id: uuid(4),
    team_id: uuid(5),
    row_kind: "slot",
    occupant_kind: "candidate",
    slot_group: "F",
    slot_number: sequence,
    source_entry_id: uuid(100 + sequence),
    source_entry_version: 1,
    player_id: uuid(200 + sequence),
    effective_position_group: "F",
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: null,
    proposed_term_years: null,
    proposed_aav_cents: null,
    eligibility_status: "invalid",
    validation_code: "CANDIDATE_CONTRACT_INCOMPLETE",
    last_edited_by_user_id: uuid(6),
    last_edited_by_membership_id: uuid(7),
    last_edited_by_authority: "manager",
    last_edited_at_ms: 100,
    created_at_ms: 100,
    ...overrides,
  };
}

function revision(sequence, overrides = {}) {
  return {
    id: uuid(400 + sequence),
    league_id: uuid(1),
    season_id: uuid(2),
    fad_id: uuid(3),
    card_id: uuid(4),
    team_id: uuid(5),
    resulting_card_version: sequence,
    action: "candidate_card_saved",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: uuid(6),
    actor_membership_id: uuid(7),
    actor_authority: "manager",
    before_evidence_json: "{}",
    after_evidence_json: "{}",
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: 100,
    created_at_ms: 100,
    version: 1,
    ...overrides,
  };
}

test("discovers and applies additive migration 0050 from both schema 49 and a fresh database", () => {
  const source = migrations().at(-1);
  assert.equal(source.id, 50);
  assert.equal(
    source.fileName,
    "0050_allow_partial_candidate_card_whole_save.sql"
  );
  assert.ok(source.sql.startsWith("-- hundo-leago: foreign-key-rebuild\n"));

  const upgraded = databaseAt(49, "candidate-partial-schema49");
  try {
    const state = apply(upgraded, 50, "candidate-partial-upgrade50");
    assert.equal(state.userVersion, 50);
    assert.equal(upgraded.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
    assert.equal(
      upgraded.prepare(
        "SELECT metadata_value FROM application_metadata WHERE metadata_key = 'data_model_version'"
      ).get().metadata_value,
      "50"
    );
  } finally {
    upgraded.close();
  }

  const fresh = databaseAt(50, "candidate-partial-fresh50");
  try {
    assert.equal(fresh.pragma("user_version", { simple: true }), 50);
    assert.equal(fresh.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(fresh.pragma("foreign_key_check"), []);
    assert.ok(fresh.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'candidate_card_revision_entry_changes'"
    ).get());
  } finally {
    fresh.close();
  }
});

test("schema 50 rebuilds allocation evidence triggers so only complete snapshot offers participate", () => {
  const database = databaseAt(
    49,
    "candidate-partial-trigger-head49"
  );
  try {
    const triggerCount49 = database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type = 'trigger'
    `).get().count;
    const finalCompletion49 = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name =
          'free_agent_drafts_final_completion_barrier'
    `).get().sql;

    apply(
      database,
      50,
      "candidate-partial-trigger-upgrade50"
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'trigger'
      `).get().count,
      triggerCount49 + 3
    );

    const expectedCompleteOfferPredicates =
      new Map([
        [
          "free_agent_draft_allocations_pending_insert",
          1,
        ],
        [
          "free_agent_draft_allocations_forward_update",
          1,
        ],
        [
          "free_agent_draft_auction_participants_valid_insert",
          1,
        ],
        [
          "free_agent_drafts_deadline_allocation_barrier",
          3,
        ],
        [
          "free_agent_drafts_allocation_completion_barrier",
          6,
        ],
        [
          "free_agent_drafts_automatic_award_resources_barrier",
          2,
        ],
      ]);
    for (const [name, expectedCount] of
      expectedCompleteOfferPredicates) {
      const sql = database.prepare(`
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'trigger' AND name = ?
      `).get(name).sql;
      for (const column of [
        "proposed_total_value_cents",
        "proposed_term_years",
        "proposed_aav_cents",
      ]) {
        assert.equal(
          sql.match(
            new RegExp(
              `${column} IS NOT NULL`,
              "gu"
            )
          )?.length ?? 0,
          expectedCount,
          `${name} must require complete ${column} evidence`
        );
      }
    }

    const participantSql = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name =
          'free_agent_draft_auction_participants_valid_insert'
    `).get().sql;
    assert.match(
      participantSql,
      /candidate_card_saved/u
    );
    assert.match(
      participantSql,
      /candidate_card_revision_entry_changes/u
    );
    assert.equal(
      database.prepare(`
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND name =
            'free_agent_drafts_final_completion_barrier'
      `).get().sql,
      finalCompletion49
    );
  } finally {
    database.close();
  }
});

test("schema 50 keeps automatic-award realtime evidence immutable across later FAD lifecycle versions", () => {
  const database = databaseAt(
    50,
    "candidate-partial-automatic-award-version-evidence"
  );
  try {
    const sql = database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND name = 'free_agent_drafts_automatic_award_resources_barrier'
    `).get().sql;
    assert.match(
      sql,
      /\$\.sideEffects\.fadVersion/u
    );
    assert.match(
      sql,
      /json_extract\(outbox_events\.payload_json, '\$\.version'\)\s*=\s*json_extract\(\s*decision_event\.evidence_json,\s*'\$\.sideEffects\.fadVersion'/u
    );
    assert.doesNotMatch(
      sql,
      /json_extract\(outbox_events\.payload_json, '\$\.version'\)\s*=\s*OLD\.version/u
    );
  } finally {
    database.close();
  }
});

test("schema 50 permits only explicit incomplete Candidate entry and snapshot states", () => {
  const database = databaseAt(50, "candidate-partial-checks50");
  try {
    database.pragma("foreign_keys = OFF");
    for (const trigger of [
      "candidate_card_entries_open_insert",
      "candidate_card_entries_actor_insert",
      "candidate_card_entries_acknowledgement_insert",
      "candidate_card_snapshot_entries_source_insert",
      "candidate_card_snapshot_entries_cap_state_insert",
    ]) {
      database.exec(`DROP TRIGGER ${trigger}`);
    }

    insert(database, "candidate_card_entries", candidateEntry(1));
    insert(database, "candidate_card_entries", candidateEntry(2, {
      proposed_total_value_cents: 900,
    }));
    insert(database, "candidate_card_entries", candidateEntry(3, {
      proposed_term_years: 3,
    }));
    insert(database, "candidate_card_entries", candidateEntry(4, {
      proposed_total_value_cents: 900,
      proposed_term_years: 3,
      proposed_aav_cents: 300,
      eligibility_status: "valid",
      validation_code: null,
    }));

    constraint(() => insert(database, "candidate_card_entries", candidateEntry(5, {
      proposed_aav_cents: 100,
    })));
    constraint(() => insert(database, "candidate_card_entries", candidateEntry(6, {
      eligibility_status: "valid",
      validation_code: null,
    })));
    constraint(() => insert(database, "candidate_card_entries", candidateEntry(7, {
      proposed_total_value_cents: 900,
      proposed_term_years: 3,
      proposed_aav_cents: 300,
    })));

    insert(database, "candidate_card_snapshot_entries", snapshotEntry(8));
    constraint(() => insert(
      database,
      "candidate_card_snapshot_entries",
      snapshotEntry(9, {
        eligibility_status: "valid",
        validation_code: null,
      })
    ));
  } finally {
    database.close();
  }
});

test("schema 50 records card-wide revisions and immutable normalized entry changes", () => {
  const database = databaseAt(50, "candidate-save-evidence50");
  try {
    database.pragma("foreign_keys = OFF");
    database.exec("DROP TRIGGER candidate_card_revisions_authority_insert");
    database.exec("DROP TRIGGER candidate_card_revisions_valid_insert");

    const saved = revision(1);
    insert(database, "candidate_card_revisions", saved);
    constraint(() => insert(database, "candidate_card_revisions", revision(2, {
      affected_entry_id: uuid(102),
      player_id: uuid(202),
    })));
    insert(database, "candidate_card_revisions", revision(3, {
      action: "candidate_added",
      affected_entry_id: uuid(103),
      player_id: uuid(203),
    }));

    const change = {
      league_id: saved.league_id,
      season_id: saved.season_id,
      fad_id: saved.fad_id,
      card_id: saved.card_id,
      team_id: saved.team_id,
      revision_id: saved.id,
      entry_id: uuid(501),
      player_id: uuid(601),
      change_kind: "add",
      before_slot_key: null,
      after_slot_key: "F01",
      before_total_value_cents: null,
      before_term_years: null,
      after_total_value_cents: null,
      after_term_years: null,
      created_at_ms: saved.occurred_at_ms,
    };
    insert(database, "candidate_card_revision_entry_changes", change);
    constraint(
      () => database.prepare(`
        UPDATE candidate_card_revision_entry_changes
        SET after_slot_key = 'F02'
        WHERE league_id = @league_id
          AND revision_id = @revision_id
          AND entry_id = @entry_id
      `).run(change),
      /immutable/u
    );
    constraint(
      () => database.prepare(`
        DELETE FROM candidate_card_revision_entry_changes
        WHERE league_id = @league_id
          AND revision_id = @revision_id
          AND entry_id = @entry_id
      `).run(change),
      /immutable/u
    );
    constraint(() => insert(database, "candidate_card_revision_entry_changes", {
      ...change,
      revision_id: uuid(403),
      entry_id: uuid(502),
    }), /card-wide save revision/u);
  } finally {
    database.close();
  }
});
