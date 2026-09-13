"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
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
const OPENED_AT_MS = 10_000;
const COOLDOWN_MS = 4_500_000;
const RESOLVES_AT_MS = 20_000_000;
const TRIGGER_NAME = "fad_auction_bids_forward_update";
const MIGRATION_0046 = Object.freeze({
  byteLength: 18_329,
  fileName:
    "0046_bind_fad_open_rapid_starter_edit_limit.sql",
  sha256:
    "78626350a1efa3e76b09f3ba2dc812b135b1e2d19dd2c01d2e973a57a6a884bb",
});

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database.prepare(`
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
  `).run(values);
}

function createRuntime(t, schemaVersion, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= schemaVersion),
    applicationBuildId: `${prefix}${schemaVersion}`,
    now: () => 1,
  });
  assert.equal(state.userVersion, schemaVersion);
  return connection;
}

function upgradeTo46(database) {
  return applyMigrations({
    database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }).filter(({ id }) => id <= 46),
    applicationBuildId: "fad-open-rapid-starter-upgrade-46",
    now: () => 2,
  });
}

function withoutTriggers(database, operation) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  database.pragma("foreign_keys = OFF");
  database.pragma("ignore_check_constraints = ON");
  try {
    for (const { name } of triggers) {
      database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    return operation();
  } finally {
    database.pragma("ignore_check_constraints = OFF");
    for (const { sql } of triggers) database.exec(sql);
    database.pragma("foreign_keys = ON");
  }
}

function fixtureIds(base) {
  return Object.freeze({
    user: uuid(base + 1),
    membership: uuid(base + 2),
    league: uuid(base + 3),
    season: uuid(base + 4),
    fad: uuid(base + 5),
    rollover: uuid(base + 6),
    resolutionRollover: uuid(base + 7),
    starterTeam: uuid(base + 8),
    joinerTeam: uuid(base + 9),
    starterAssignment: uuid(base + 10),
    joinerAssignment: uuid(base + 11),
    player: uuid(base + 12),
    auction: uuid(base + 13),
    allocation: uuid(base + 14),
    starterBid: uuid(base + 15),
    joinerBid: uuid(base + 16),
    startEvent: uuid(base + 17),
    secondStartEvent: uuid(base + 18),
    queue: uuid(base + 19),
    acceptanceRequest: uuid(base + 20),
    participant: uuid(base + 21),
    sourceSnapshot: uuid(base + 22),
    candidateRevision: uuid(base + 23),
  });
}

function seedRequest(database, ids, bidId, index, createdAtMs) {
  const requestId = uuid(Number(bidId.slice(-12)) * 10 + index);
  insert(database, "idempotency_requests", {
    id: requestId,
    league_id: ids.league,
    actor_user_id: ids.user,
    operation: "auction.bid.put",
    client_key: `${bidId}-edit-${index}`,
    request_hash: String(index).repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: createdAtMs,
    completed_at_ms: null,
    expires_at_ms: createdAtMs + 86_400_000,
  });
  return requestId;
}

function seedBid(database, ids, {
  bidId,
  teamId,
  firstSubmittedAtMs,
}) {
  insert(database, "auction_bids", {
    id: bidId,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: ids.auction,
    team_id: teamId,
    submitted_by_user_id: ids.user,
    total_value_cents: 600,
    term_years: 3,
    lowest_offered_aav_cents: 200,
    first_submitted_at_ms: firstSubmittedAtMs,
    last_edited_at_ms: firstSubmittedAtMs,
    edit_count: 0,
    status: "active",
    idempotency_request_id: null,
    version: 1,
  });
  return Object.freeze([
    seedRequest(
      database,
      ids,
      bidId,
      1,
      firstSubmittedAtMs + COOLDOWN_MS
    ),
    seedRequest(
      database,
      ids,
      bidId,
      2,
      firstSubmittedAtMs + 2 * COOLDOWN_MS
    ),
    seedRequest(
      database,
      ids,
      bidId,
      3,
      firstSubmittedAtMs + 3 * COOLDOWN_MS
    ),
  ]);
}

function seedFixture(database, base, {
  sourceKind = "fad_open_rapid",
  origin = "manager_nomination",
  malformedEvent = null,
  includeJoiner = false,
} = {}) {
  const ids = fixtureIds(base);
  const queued = origin === "queued_nomination";
  const firstSubmittedAtMs = queued
    ? OPENED_AT_MS - 1
    : OPENED_AT_MS;
  let starterRequests;
  let joinerRequests = null;
  withoutTriggers(database, () => {
    insert(database, "users", {
      id: ids.user,
      email_normalized: `manager-${base}@example.test`,
      email_display: `manager-${base}@example.test`,
      display_name: `Manager ${base}`,
      display_name_normalized: `manager ${base}`,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "leagues", {
      id: ids.league,
      name: `League ${base}`,
      name_normalized: `league ${base}`,
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: ids.season,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "seasons", {
      id: ids.season,
      league_id: ids.league,
      label: `Season ${base}`,
      nhl_season_key: String(2_000_000 + base),
      status: "active",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      free_agent_draft_completed_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_memberships", {
      id: ids.membership,
      league_id: ids.league,
      user_id: ids.user,
      permission_category: "manager",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    for (const [teamId, assignmentId, suffix] of [
      [ids.starterTeam, ids.starterAssignment, "starter"],
      [ids.joinerTeam, ids.joinerAssignment, "joiner"],
    ]) {
      insert(database, "teams", {
        id: teamId,
        league_id: ids.league,
        name: `${suffix} ${base}`,
        name_normalized: `${suffix} ${base}`,
        status: "active",
        primary_colour: null,
        secondary_colour: null,
        logo_reference: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      insert(database, "team_manager_assignments", {
        id: assignmentId,
        league_id: ids.league,
        team_id: teamId,
        user_id: ids.user,
        membership_id: ids.membership,
        assigned_by_user_id: ids.user,
        replaces_assignment_id: null,
        status: "accepted",
        assigned_at_ms: 1,
        accepted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      });
    }
    insert(database, "players", {
      id: ids.player,
      first_name: "Test",
      last_name: `Player ${base}`,
      full_name: `Test Player ${base}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "auctions", {
      id: ids.auction,
      league_id: ids.league,
      season_id: ids.season,
      player_id: ids.player,
      status: "open",
      opened_at_ms: OPENED_AT_MS,
      resolves_at_ms: RESOLVES_AT_MS,
      opened_by_user_id: ids.user,
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    });
    insert(database, "auction_contexts", {
      id: ids.auction,
      league_id: ids.league,
      season_id: ids.season,
      auction_id: ids.auction,
      source_kind: sourceKind,
      fad_id: sourceKind === "ordinary_weekly" ? null : ids.fad,
      fad_rollover_id:
        sourceKind === "ordinary_weekly" ? null : ids.rollover,
      fad_allocation_id:
        origin === "restricted_no_improvement_fallback" ||
        sourceKind === "fad_restricted"
          ? ids.allocation
          : null,
      fad_origin:
        sourceKind === "ordinary_weekly" ? null : origin,
      created_at_ms: OPENED_AT_MS,
    });
    starterRequests = seedBid(database, ids, {
      bidId: ids.starterBid,
      teamId: ids.starterTeam,
      firstSubmittedAtMs,
    });
    if (includeJoiner) {
      joinerRequests = seedBid(database, ids, {
        bidId: ids.joinerBid,
        teamId: ids.joinerTeam,
        firstSubmittedAtMs: OPENED_AT_MS,
      });
    }
    if (sourceKind !== "ordinary_weekly" && malformedEvent !== "missing") {
      insert(database, "auction_events", {
        id: ids.startEvent,
        league_id: ids.league,
        season_id: ids.season,
        auction_id: ids.auction,
        bid_id: ids.starterBid,
        team_id:
          malformedEvent === "split"
            ? ids.joinerTeam
            : ids.starterTeam,
        actor_user_id: ids.user,
        event_type: "auction_started",
        metadata_json: "{}",
        occurred_at_ms: OPENED_AT_MS,
      });
      if (malformedEvent === "duplicate") {
        insert(database, "auction_events", {
          id: ids.secondStartEvent,
          league_id: ids.league,
          season_id: ids.season,
          auction_id: ids.auction,
          bid_id: ids.starterBid,
          team_id: ids.starterTeam,
          actor_user_id: ids.user,
          event_type: "auction_started",
          metadata_json: "{}",
          occurred_at_ms: OPENED_AT_MS,
        });
      }
    }
    if (queued) {
      insert(database, "free_agent_draft_nomination_queue", {
        id: ids.queue,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        team_id: ids.starterTeam,
        player_id: ids.player,
        source_rollover_id: ids.rollover,
        target_opening_rollover_id: ids.rollover,
        resolution_rollover_id: ids.resolutionRollover,
        opening_total_value_cents: 600,
        opening_term_years: 3,
        opening_aav_cents: 200,
        binding_illegality_confirmed: 1,
        binding_confirmed_at_ms: firstSubmittedAtMs,
        submitted_by_user_id: ids.user,
        submitted_by_membership_id: ids.membership,
        accepted_at_ms: firstSubmittedAtMs,
        candidate_card_version_observed: 1,
        team_version_observed: 1,
        status: "opened",
        opened_auction_id: ids.auction,
        opened_starter_bid_id: ids.starterBid,
        opened_at_ms: OPENED_AT_MS,
        terminal_at_ms: OPENED_AT_MS,
        validation_code: null,
        created_at_ms: firstSubmittedAtMs,
        updated_at_ms: OPENED_AT_MS,
        version: 2,
        acceptance_idempotency_request_id:
          ids.acceptanceRequest,
      });
    }
    if (sourceKind === "fad_restricted") {
      insert(database, "free_agent_draft_auction_participants", {
        id: ids.participant,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        allocation_id: ids.allocation,
        auction_id: ids.auction,
        team_id: ids.starterTeam,
        status: "active",
        source_snapshot_entry_id: ids.sourceSnapshot,
        originating_candidate_revision_id: ids.candidateRevision,
        minimum_total_value_cents: 100,
        minimum_term_years: 1,
        minimum_aav_cents: 100,
        active_improvement_bid_id: ids.starterBid,
        manager_edit_limit: 1,
        cooldown_duration_ms: COOLDOWN_MS,
        first_improvement_at_ms: firstSubmittedAtMs,
        current_cooldown_anchor_at_ms: firstSubmittedAtMs,
        improvement_committed_at_ms: firstSubmittedAtMs,
        originating_actor_user_id: ids.user,
        originating_actor_membership_id: ids.membership,
        originating_actor_authority: "manager",
        removed_by_user_id: null,
        removed_by_membership_id: null,
        removed_authority: null,
        removal_reason: null,
        removed_at_ms: null,
        created_at_ms: firstSubmittedAtMs,
        updated_at_ms: firstSubmittedAtMs,
        version: 1,
      });
    }
  });
  return Object.freeze({
    ...ids,
    starterRequests,
    joinerRequests,
  });
}

function editBid(database, bidId, requestId) {
  const request = database.prepare(`
    SELECT created_at_ms
    FROM idempotency_requests
    WHERE id = ?
  `).get(requestId);
  return database.prepare(`
    UPDATE auction_bids
    SET total_value_cents = 600,
        term_years = 3,
        lowest_offered_aav_cents = 200,
        last_edited_at_ms = @editedAtMs,
        edit_count = edit_count + 1,
        idempotency_request_id = @requestId,
        version = version + 1
    WHERE id = @bidId
  `).run({
    bidId,
    requestId,
    editedAtMs: request.created_at_ms,
  });
}

function assertEditRejected(database, bidId, requestId) {
  assert.throws(
    () => editBid(database, bidId, requestId),
    /FAD bid edit exceeds its actor entitlement, cooldown, or bid floor/u
  );
}

test("schema 46 upgrades head 45 from timestamp inference to exact direct and queued starter evidence", (t) => {
  const migrationPath = path.join(
    MIGRATIONS_DIRECTORY,
    MIGRATION_0046.fileName
  );
  const migrationSql = fs.readFileSync(migrationPath);
  assert.equal(migrationSql.byteLength, MIGRATION_0046.byteLength);
  assert.equal(
    crypto.createHash("sha256").update(migrationSql).digest("hex"),
    MIGRATION_0046.sha256
  );
  const runtime = createRuntime(
    t,
    45,
    "fad-open-rapid-starter-upgrade-"
  );
  const queuedBefore = seedFixture(runtime.database, 700_000, {
    origin: "queued_nomination",
  });
  assert.equal(
    editBid(
      runtime.database,
      queuedBefore.starterBid,
      queuedBefore.starterRequests[0]
    ).changes,
    1
  );
  assertEditRejected(
    runtime.database,
    queuedBefore.starterBid,
    queuedBefore.starterRequests[1]
  );

  const directBefore = seedFixture(runtime.database, 701_000, {
    includeJoiner: true,
  });
  assert.equal(
    editBid(
      runtime.database,
      directBefore.joinerBid,
      directBefore.joinerRequests[0]
    ).changes,
    1
  );
  assert.equal(
    editBid(
      runtime.database,
      directBefore.joinerBid,
      directBefore.joinerRequests[1]
    ).changes,
    1
  );

  const state = upgradeTo46(runtime.database);
  assert.equal(state.status, "exact");
  assert.equal(state.userVersion, 46);
  assert.equal(
    runtime.database.prepare(`
      SELECT metadata_value
      FROM application_metadata
      WHERE metadata_key = 'data_model_version'
    `).pluck().get(),
    "46"
  );
  assert.deepEqual(
    runtime.database.prepare(`
      SELECT migration_id, file_name
      FROM schema_migrations
      WHERE migration_id = 46
    `).get(),
    {
      migration_id: 46,
      file_name: MIGRATION_0046.fileName,
    }
  );

  const queuedAfter = seedFixture(runtime.database, 702_000, {
    origin: "queued_nomination",
  });
  for (const requestId of queuedAfter.starterRequests.slice(0, 2)) {
    assert.equal(
      editBid(
        runtime.database,
        queuedAfter.starterBid,
        requestId
      ).changes,
      1
    );
  }
  assertEditRejected(
    runtime.database,
    queuedAfter.starterBid,
    queuedAfter.starterRequests[2]
  );

  const directAfter = seedFixture(runtime.database, 703_000, {
    includeJoiner: true,
  });
  for (const requestId of directAfter.starterRequests.slice(0, 2)) {
    assert.equal(
      editBid(
        runtime.database,
        directAfter.starterBid,
        requestId
      ).changes,
      1
    );
  }
  assertEditRejected(
    runtime.database,
    directAfter.starterBid,
    directAfter.starterRequests[2]
  );
  assert.equal(
    editBid(
      runtime.database,
      directAfter.joinerBid,
      directAfter.joinerRequests[0]
    ).changes,
    1
  );
  assertEditRejected(
    runtime.database,
    directAfter.joinerBid,
    directAfter.joinerRequests[1]
  );
});

test("fresh schema 46 rejects malformed starter evidence and preserves restricted, fallback, and ordinary limits", (t) => {
  const runtime = createRuntime(
    t,
    46,
    "fad-open-rapid-starter-fresh-"
  );
  for (const [index, malformedEvent] of [
    [0, "missing"],
    [1, "duplicate"],
    [2, "split"],
  ]) {
    const malformed = seedFixture(
      runtime.database,
      710_000 + index * 1_000,
      { malformedEvent, includeJoiner: true }
    );
    assertEditRejected(
      runtime.database,
      malformed.starterBid,
      malformed.starterRequests[0]
    );
  }

  const fallback = seedFixture(runtime.database, 714_000, {
    origin: "restricted_no_improvement_fallback",
  });
  assert.equal(
    editBid(
      runtime.database,
      fallback.starterBid,
      fallback.starterRequests[0]
    ).changes,
    1
  );
  assertEditRejected(
    runtime.database,
    fallback.starterBid,
    fallback.starterRequests[1]
  );

  const restricted = seedFixture(runtime.database, 715_000, {
    sourceKind: "fad_restricted",
    origin: "candidate_tie_restricted",
  });
  assert.equal(
    editBid(
      runtime.database,
      restricted.starterBid,
      restricted.starterRequests[0]
    ).changes,
    1
  );
  assertEditRejected(
    runtime.database,
    restricted.starterBid,
    restricted.starterRequests[1]
  );

  const ordinary = seedFixture(runtime.database, 716_000, {
    sourceKind: "ordinary_weekly",
    origin: null,
  });
  for (const requestId of ordinary.starterRequests) {
    assert.equal(
      editBid(
        runtime.database,
        ordinary.starterBid,
        requestId
      ).changes,
      1
    );
  }
  assert.match(
    runtime.database.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'trigger' AND name = ?
    `).pluck().get(TRIGGER_NAME),
    /starter_event\.bid_id = OLD\.id/u
  );
});
