"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  AUCTION_CREATION_CODES,
  AuctionCreationPolicyError,
} = require(
  "../../src/domain/auctions/auctionCreationPolicy"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  applyMigrations,
  discoverMigrations,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE,
  FREE_AGENT_DRAFT_AUCTION_START_WRITER_METHODS,
  createSqliteFreeAgentDraftAuctionStartWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionStartWriter"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 86_400_000;
const ROLLOVER_OPENS_AT_MS = Date.parse(
  "2026-09-28T07:00:00.000Z"
);
const ROLLOVER_AT_MS = ROLLOVER_OPENS_AT_MS + DAY_MS;
const CREATION_CUTOFF_AT_MS = ROLLOVER_AT_MS - 3_600_000;
const DIRECT_AT_MS = ROLLOVER_OPENS_AT_MS + 1_000;
const WEEK_ONE_AT_MS = ROLLOVER_AT_MS + 6 * DAY_MS;
const FAD_OPENED_AT_MS = ROLLOVER_OPENS_AT_MS - 30 * DAY_MS;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function deterministicUuid(value) {
  const hex = createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function identities(index, { dualRole = false } = {}) {
  const base = index * 1_000;
  const managerMembership = uuid(base + 21);
  return Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    weekOne: uuid(base + 3),
    readiness: uuid(base + 4),
    fad: uuid(base + 5),
    rollover: uuid(base + 6),
    player: uuid(base + 7),
    playerSource: uuid(base + 8),
    managerUser: uuid(base + 20),
    managerMembership,
    team: uuid(base + 22),
    assignment: uuid(base + 23),
    fadTeam: uuid(base + 24),
    card: uuid(base + 25),
    commissionerUser: dualRole
      ? uuid(base + 20)
      : uuid(base + 30),
    commissionerMembership: dualRole
      ? managerMembership
      : uuid(base + 31),
    quarantineAllocation: uuid(base + 40),
  });
}

const PRIMARY = identities(1);
const SECONDARY = identities(2, { dualRole: true });

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  try {
    database.prepare(`
      INSERT INTO ${tableName} (${fields.join(", ")})
      VALUES (${fields.map((field) => `@${field}`).join(", ")})
    `).run(values);
  } catch (error) {
    throw new Error(`${tableName}: ${error.message}`, {
      cause: error,
    });
  }
}

function captureAndDropTriggers(database) {
  const triggers = database.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
    ORDER BY name
  `).all();
  for (const trigger of triggers) {
    database.exec(
      `DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`
    );
  }
  return triggers;
}

function restoreTriggers(database, triggers) {
  for (const trigger of triggers) database.exec(trigger.sql);
}

function withoutTriggers(database, mutate) {
  const triggers = captureAndDropTriggers(database);
  try {
    mutate();
  } finally {
    restoreTriggers(database, triggers);
  }
}

function seedLeague(database, ids, index, { dualRole = false } = {}) {
  insert(database, "leagues", {
    id: ids.league,
    name: `FAD Start League ${index}`,
    name_normalized: `fad start league ${index}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: ids.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_settings", {
    league_id: ids.league,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `2026-27-${index}`,
    nhl_season_key: `2026202${index}`,
    status: "active",
    regular_season_starts_at_ms: WEEK_ONE_AT_MS,
    regular_season_ends_at_ms: WEEK_ONE_AT_MS + 20 * 7 * DAY_MS,
    fantasy_playoffs_start_at_ms:
      WEEK_ONE_AT_MS + 17 * 7 * DAY_MS,
    fantasy_playoffs_end_at_ms:
      WEEK_ONE_AT_MS + 21 * 7 * DAY_MS,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchup_weeks", {
    id: ids.weekOne,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `2026-W0${index}`,
    sequence: 1,
    starts_at_ms: WEEK_ONE_AT_MS,
    baseline_at_ms: WEEK_ONE_AT_MS + 3_600_000,
    locks_at_ms: WEEK_ONE_AT_MS + 7_200_000,
    ends_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    rolls_over_at_ms: WEEK_ONE_AT_MS + 7 * DAY_MS,
    status: "scheduled",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "players", {
    id: ids.player,
    first_name: "Rapid",
    last_name: `Player ${index}`,
    full_name: `Rapid Player ${index}`,
    birth_date: null,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "player_source_state", {
    id: ids.playerSource,
    player_id: ids.player,
    provider: `fad-start-${index}`,
    source_position: "D",
    normalized_position: "D",
    nhl_team_abbreviation: "VAN",
    active: 1,
    source_version: "1",
    source_payload_json: "{}",
    effective_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
  });
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.readiness,
    league_id: ids.league,
    season_id: ids.season,
    readiness_occurrence_key:
      `fad-readiness:${ids.league}:${ids.season}`,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: null,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: null,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key:
      `fad-readiness:${ids.league}:${ids.season}`,
    first_matchup_week_id: ids.weekOne,
    current_competition_first_matchup_week_id: ids.weekOne,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status: "rapid",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Inaugural league has no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: FAD_OPENED_AT_MS,
    help_opens_at_ms: ROLLOVER_OPENS_AT_MS - 2 * DAY_MS,
    candidate_deadline_at_ms: ROLLOVER_OPENS_AT_MS,
    first_matchup_starts_at_ms: WEEK_ONE_AT_MS,
    deadline_locked_at_ms: ROLLOVER_OPENS_AT_MS,
    allocation_completed_at_ms: ROLLOVER_OPENS_AT_MS,
    completed_at_ms: null,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: ROLLOVER_OPENS_AT_MS,
    version: 4,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: ids.rollover,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence: 1,
    window_kind: "initial",
    predecessor_rollover_id: null,
    extension_reason: null,
    extension_source_id: null,
    opens_at_ms: ROLLOVER_OPENS_AT_MS,
    creation_cutoff_at_ms: CREATION_CUTOFF_AT_MS,
    rolls_over_at_ms: ROLLOVER_AT_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: FAD_OPENED_AT_MS,
    version: 1,
  });
  insert(database, "users", {
    id: ids.managerUser,
    email_normalized: `fad-start-manager-${index}@example.test`,
    email_display: `fad-start-manager-${index}@example.test`,
    display_name: `FAD Start Manager ${index}`,
    display_name_normalized: `fad start manager ${index}`,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "league_memberships", {
    id: ids.managerMembership,
    league_id: ids.league,
    user_id: ids.managerUser,
    permission_category: "manager",
    status: "active",
    joined_at_ms: 1,
    ended_at_ms: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  if (!dualRole) {
    insert(database, "users", {
      id: ids.commissionerUser,
      email_normalized:
        `fad-start-commissioner-${index}@example.test`,
      email_display:
        `fad-start-commissioner-${index}@example.test`,
      display_name: `FAD Start Commissioner ${index}`,
      display_name_normalized:
        `fad start commissioner ${index}`,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
    insert(database, "league_memberships", {
      id: ids.commissionerMembership,
      league_id: ids.league,
      user_id: ids.commissionerUser,
      permission_category: "commissioner",
      status: "active",
      joined_at_ms: 1,
      ended_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  insert(database, "teams", {
    id: ids.team,
    league_id: ids.league,
    name: `FAD Start Team ${index}`,
    name_normalized: `fad start team ${index}`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    tertiary_colour: null,
    logo_reference: null,
    pattern_template: "even-two",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "team_manager_assignments", {
    id: ids.assignment,
    league_id: ids.league,
    team_id: ids.team,
    user_id: ids.managerUser,
    membership_id: ids.managerMembership,
    assigned_by_user_id: ids.managerUser,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: 1,
    accepted_at_ms: 1,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "free_agent_draft_teams", {
    id: ids.fadTeam,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    team_status_at_setup: "active",
    created_at_ms: FAD_OPENED_AT_MS,
  });
  insert(database, "candidate_cards", {
    id: ids.card,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.team,
    status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 0,
    missing_mandatory_count: 18,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    carried_roster_structural_conflict_count: 0,
    maximum_possible_cap_cents: 0,
    locked_at_ms: ROLLOVER_OPENS_AT_MS,
    created_at_ms: FAD_OPENED_AT_MS,
    updated_at_ms: ROLLOVER_OPENS_AT_MS,
    version: 3,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = @commissionerMembership,
        updated_at_ms = 2,
        version = 2
    WHERE id = @league
  `).run({
    commissionerMembership: ids.commissionerMembership,
    league: ids.league,
  });
}

function createFixture(t, label, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `fad-start-${label}-`)
  );
  const connection = openDatabase({
    databasePath: path.join(directory, "foundation.sqlite"),
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId: `fad-start-writer-${label}`,
    now: () => 44,
  });
  withoutTriggers(connection.database, () => {
    seedLeague(connection.database, PRIMARY, 1);
    seedLeague(connection.database, SECONDARY, 2, {
      dualRole: true,
    });
  });
  const generated = [];
  let next = options.idBase || 8_000;
  let nonceCalls = 0;
  const writer = createSqliteFreeAgentDraftAuctionStartWriter({
    database: connection.database,
    createId() {
      const id = uuid(next);
      next += 1;
      generated.push(id);
      return id;
    },
    createDrawNonce() {
      nonceCalls += 1;
      return Buffer.alloc(32, 0x40 + nonceCalls);
    },
    beforeCommit: options.beforeCommit,
  });
  return Object.freeze({
    database: connection.database,
    generated,
    get nonceCalls() {
      return nonceCalls;
    },
    writer,
  });
}

function scope(ids, nowMs, overrides = {}) {
  return {
    leagueId: ids.league,
    teamId: ids.team,
    playerId: ids.player,
    actorUserId: ids.managerUser,
    actorMembershipId: ids.managerMembership,
    nowMs,
    ...overrides,
  };
}

function command(ids, nowMs, key, overrides = {}) {
  return {
    leagueId: ids.league,
    actorUserId: ids.managerUser,
    actorMembershipId: ids.managerMembership,
    body: {
      playerId: ids.player,
      teamId: ids.team,
      aavCents: 300,
      termYears: 2,
      bindingIllegalityConfirmed: true,
      ...(overrides.body || {}),
    },
    idempotencyKey: key,
    nowMs,
    idempotencyExpiresAtMs: nowMs + DAY_MS,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([keyName]) => keyName !== "body")
    ),
  };
}

function count(database, tableName, leagueId) {
  return database.prepare(`
    SELECT COUNT(*) AS count
    FROM ${tableName}
    WHERE league_id = ?
  `).get(leagueId).count;
}

function databaseFingerprint(database) {
  return {
    sha256: createHash("sha256")
      .update(database.serialize())
      .digest("hex"),
    totalChanges: database.prepare(`
      SELECT total_changes() AS count
    `).get().count,
  };
}

function assertPolicyReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof AuctionCreationPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function assertPolicyReasonWithoutWrites(
  database,
  action,
  reasonCode
) {
  const before = databaseFingerprint(database);
  assertPolicyReason(action, reasonCode);
  assert.deepEqual(databaseFingerprint(database), before);
}

function assertRepositoryReason(action, code, reasonCode) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.details?.reasonCode, reasonCode);
    return true;
  });
}

describe("FAD-13 SQLite auction start/queue writer", () => {
  test("exports a frozen two-method surface and returns policy-ready exact context", (t) => {
    const fixture = createFixture(t, "context");
    assert.deepEqual(
      FREE_AGENT_DRAFT_AUCTION_START_WRITER_METHODS,
      ["findStartContext", "startOrQueue"]
    );
    assert.ok(Object.isFrozen(fixture.writer));
    assert.deepEqual(
      Object.keys(fixture.writer).sort(),
      ["findStartContext", "startOrQueue"]
    );

    const context = fixture.writer.findStartContext(
      scope(SECONDARY, DIRECT_AT_MS)
    );
    assert.deepEqual(Object.keys(context).sort(), [
      "authority",
      "player",
      "rapidContext",
      "sourceKind",
    ]);
    assert.equal(context.sourceKind, "fad_open_rapid");
    assert.equal(context.authority.currentCommissioner, true);
    assert.equal(
      context.authority.managerAssignmentStatus,
      "accepted"
    );
    assert.equal(context.player.fadEligible, true);
    assert.equal(context.player.quarantined, false);
    assert.equal(
      context.rapidContext.rollover.creationCutoffAtMs,
      CREATION_CUTOFF_AT_MS
    );
    assert.equal(fixture.generated.length, 0);
    assert.equal(fixture.nonceCalls, 0);
    assert.equal(
      count(
        fixture.database,
        "idempotency_requests",
        SECONDARY.league
      ),
      0
    );
  });

  test("starts an uncarded eligible-player nomination after the Candidate Card deadline while ties still allocate", (t) => {
    const fixture = createFixture(t, "allocating-direct");
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'allocating',
            allocation_completed_at_ms = NULL,
            updated_at_ms = @updatedAtMs,
            version = version + 1
        WHERE league_id = @leagueId
          AND id = @fadId
      `).run({
        fadId: PRIMARY.fad,
        leagueId: PRIMARY.league,
        updatedAtMs: ROLLOVER_OPENS_AT_MS,
      });
    });

    const context = fixture.writer.findStartContext(
      scope(PRIMARY, DIRECT_AT_MS)
    );
    assert.equal(context.rapidContext.fadStatus, "allocating");
    assert.equal(
      context.rapidContext.allocationCompletedAtMs,
      null
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_entries
        WHERE league_id = @leagueId
          AND fad_id = @fadId
          AND player_id = @playerId
      `).get({
        fadId: PRIMARY.fad,
        leagueId: PRIMARY.league,
        playerId: PRIMARY.player,
      }).count,
      0
    );

    const result = fixture.writer.startOrQueue(
      command(
        PRIMARY,
        DIRECT_AT_MS,
        "allocating-direct-start"
      )
    );
    assert.equal(result.kind, "auction_opened");
    assert.equal(result.actorAuthority, "manager");
  });

  test("records FAD binding acceptance server-side and routes fresh ordinary bodies without writes", (t) => {
    const fadFixture = createFixture(t, "routing-current-fad", {
      idBase: 8_050,
    });
    const missingConfirmation = command(
      PRIMARY,
      DIRECT_AT_MS,
      "missing-confirmation"
    );
    delete missingConfirmation.body.bindingIllegalityConfirmed;
    const fadResult =
      fadFixture.writer.startOrQueue(missingConfirmation);
    assert.equal(fadResult.kind, "auction_opened");
    assert.equal(
      fadResult.body.bindingIllegalityConfirmed,
      true
    );
    assert.equal(
      fadResult.bindingIllegalityConfirmedAtMs,
      DIRECT_AT_MS
    );
    assert.equal(
      count(
        fadFixture.database,
        "idempotency_requests",
        PRIMARY.league
      ),
      1
    );

    const ordinaryFixture = createFixture(t, "routing-no-fad", {
      idBase: 8_060,
    });
    withoutTriggers(ordinaryFixture.database, () => {
      ordinaryFixture.database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'completed', completed_at_ms = @completedAtMs,
            updated_at_ms = @completedAtMs, version = version + 1
        WHERE league_id = @leagueId AND id = @fadId
      `).run({
        completedAtMs: ROLLOVER_AT_MS,
        fadId: PRIMARY.fad,
        leagueId: PRIMARY.league,
      });
    });
    const ordinary = command(
      PRIMARY,
      ROLLOVER_AT_MS + 1,
      "fresh-ordinary"
    );
    delete ordinary.body.bindingIllegalityConfirmed;
    const notApplicable = ordinaryFixture.writer.startOrQueue(ordinary);
    assert.equal(
      notApplicable,
      FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE
    );
    assert.deepEqual(notApplicable, { applicable: false });
    assert.ok(Object.isFrozen(notApplicable));
    assert.equal(ordinaryFixture.generated.length, 0);
    assert.equal(
      count(
        ordinaryFixture.database,
        "idempotency_requests",
        PRIMARY.league
      ),
      0
    );
  });

  test("recognizes an existing ordinary auction.start result before FAD hashing or mutable dispatch", (t) => {
    const fixture = createFixture(t, "routing-ordinary-replay", {
      idBase: 8_070,
    });
    const requestId = uuid(7_001);
    const auctionId = uuid(7_002);
    withoutTriggers(fixture.database, () => {
      insert(fixture.database, "idempotency_requests", {
        id: requestId,
        league_id: PRIMARY.league,
        actor_user_id: PRIMARY.managerUser,
        operation: "auction.start",
        client_key: "ordinary-replay",
        request_hash: "0".repeat(64),
        status: "completed",
        result_type: "auction",
        result_id: auctionId,
        created_at_ms: DIRECT_AT_MS,
        completed_at_ms: DIRECT_AT_MS,
        expires_at_ms: DIRECT_AT_MS + DAY_MS,
      });
      insert(fixture.database, "auctions", {
        id: auctionId,
        league_id: PRIMARY.league,
        season_id: PRIMARY.season,
        player_id: PRIMARY.player,
        status: "resolved",
        opened_at_ms: DIRECT_AT_MS,
        resolves_at_ms: DIRECT_AT_MS + 1,
        opened_by_user_id: PRIMARY.managerUser,
        created_at_ms: DIRECT_AT_MS,
        updated_at_ms: DIRECT_AT_MS + 1,
        version: 2,
      });
      insert(fixture.database, "auction_contexts", {
        id: auctionId,
        league_id: PRIMARY.league,
        season_id: PRIMARY.season,
        auction_id: auctionId,
        source_kind: "ordinary_weekly",
        fad_id: null,
        fad_rollover_id: null,
        fad_allocation_id: null,
        fad_origin: null,
        created_at_ms: DIRECT_AT_MS,
      });
    });
    const input = command(
      PRIMARY,
      DIRECT_AT_MS + 2,
      "ordinary-replay",
      { body: { aavCents: 450 } }
    );
    delete input.body.bindingIllegalityConfirmed;
    assert.equal(
      fixture.writer.startOrQueue(input),
      FREE_AGENT_DRAFT_AUCTION_START_NOT_APPLICABLE
    );
    assert.equal(fixture.generated.length, 0);
    assert.equal(
      count(
        fixture.database,
        "idempotency_requests",
        PRIMARY.league
      ),
      1
    );
  });

  test("manager direct start atomically persists exact private draw, starter, event, job, and immutable replay", (t) => {
    const fixture = createFixture(t, "direct");
    const input = command(
      PRIMARY,
      CREATION_CUTOFF_AT_MS - 1,
      "direct-start"
    );
    const result = fixture.writer.startOrQueue(input);

    assert.equal(result.kind, "auction_opened");
    assert.equal(result.actorAuthority, "manager");
    assert.equal(result.replayed, false);
    assert.equal(result.opensAtMs, CREATION_CUTOFF_AT_MS - 1);
    assert.equal(result.resolvesAtMs, ROLLOVER_AT_MS);
    assert.equal(result.sourceRolloverId, PRIMARY.rollover);
    assert.equal(result.resolutionRolloverId, PRIMARY.rollover);
    assert.equal(result.targetOpeningRolloverId, null);
    assert.equal(result.body.totalValueCents, 600);
    assert.equal(fixture.generated.length, 6);
    assert.equal(fixture.nonceCalls, 1);

    const database = fixture.database;
    const request = database.prepare(`
      SELECT status, result_type, result_id, created_at_ms,
             completed_at_ms
      FROM idempotency_requests
      WHERE id = ?
    `).get(result.idempotencyRequestId);
    assert.deepEqual(request, {
      status: "completed",
      result_type: "auction",
      result_id: result.auctionId,
      created_at_ms: CREATION_CUTOFF_AT_MS - 1,
      completed_at_ms: CREATION_CUTOFF_AT_MS - 1,
    });
    const context = database.prepare(`
      SELECT source_kind, fad_id, fad_rollover_id,
             fad_allocation_id, fad_origin
      FROM auction_contexts
      WHERE auction_id = ?
    `).get(result.auctionId);
    assert.deepEqual(context, {
      source_kind: "fad_open_rapid",
      fad_id: PRIMARY.fad,
      fad_rollover_id: PRIMARY.rollover,
      fad_allocation_id: null,
      fad_origin: "manager_nomination",
    });
    const draw = database.prepare(`
      SELECT algorithm_version, length(nonce_bytes) AS nonce_length,
             commitment_hex, revealed_at_ms, version
      FROM free_agent_draft_draws
      WHERE id = ?
    `).get(result.drawId);
    assert.equal(draw.algorithm_version, 1);
    assert.equal(draw.nonce_length, 32);
    assert.equal(draw.commitment_hex, result.drawCommitmentHex);
    assert.equal(draw.revealed_at_ms, null);
    assert.equal(draw.version, 1);
    const event = database.prepare(`
      SELECT event_type, metadata_json
      FROM auction_events
      WHERE id = ?
    `).get(result.auctionEventId);
    assert.equal(event.event_type, "auction_started");
    const metadata = JSON.parse(event.metadata_json);
    assert.equal(Object.keys(metadata).length, 12);
    assert.deepEqual(metadata, {
      openingTeamId: PRIMARY.team,
      actorMembershipId: PRIMARY.managerMembership,
      actorAuthority: "manager",
      playerPosition: "D",
      creationCutoffAtMs: CREATION_CUTOFF_AT_MS,
      bidClosesAtMs: ROLLOVER_AT_MS,
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
      bindingIllegalityConfirmed: true,
      fadId: PRIMARY.fad,
      fadRolloverId: PRIMARY.rollover,
    });
    const job = database.prepare(`
      SELECT job_type, occurrence_key, scheduled_for_ms, status,
             attempt_count, lease_owner, lease_token,
             next_attempt_at_ms, version
      FROM job_runs
      WHERE id = ?
    `).get(result.resolutionJobRunId);
    assert.deepEqual(job, {
      job_type: "auction.resolve.target",
      occurrence_key:
        `auction:${result.auctionId}:${ROLLOVER_AT_MS}`,
      scheduled_for_ms: ROLLOVER_AT_MS,
      status: "pending",
      attempt_count: 0,
      lease_owner: null,
      lease_token: null,
      next_attempt_at_ms: null,
      version: 1,
    });
    const publication = database.prepare(`
      SELECT id, event_type, aggregate_type, aggregate_id,
             payload_json, created_at_ms
      FROM outbox_events
      WHERE league_id = ?
    `).get(PRIMARY.league);
    assert.equal(publication.event_type, "auction.changed");
    assert.equal(publication.aggregate_type, "auction");
    assert.equal(publication.aggregate_id, result.auctionId);
    assert.equal(
      publication.created_at_ms,
      CREATION_CUTOFF_AT_MS - 1
    );
    assert.deepEqual(JSON.parse(publication.payload_json), {
      eventId: publication.id,
      type: "auction.changed",
      leagueId: PRIMARY.league,
      resourceId: result.auctionId,
      version: 1,
      reasonCode: "auction_changed",
      occurredAt: CREATION_CUTOFF_AT_MS - 1,
      related: {
        fadId: PRIMARY.fad,
        teamId: PRIMARY.team,
        cardId: null,
        allocationId: null,
        auctionId: result.auctionId,
        recoveryId: null,
        nominationQueueId: null,
        scheduleRecoveryOperationId: null,
      },
    });
    assert.deepEqual(
      database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE outbox_event_id = ?
      `).all(publication.id),
      [{ audience_kind: "league", team_id: null, user_id: null }]
    );
    assert.ok(!publication.payload_json.includes(PRIMARY.player));
    assert.ok(!publication.payload_json.includes("totalValue"));

    withoutTriggers(database, () => {
      database.prepare(`
        UPDATE auctions
        SET status = 'resolved', updated_at_ms = ?, version = 2
        WHERE id = ?
      `).run(ROLLOVER_AT_MS, result.auctionId);
      database.prepare(`
        UPDATE auction_bids
        SET status = 'won', total_value_cents = 900,
            lowest_offered_aav_cents = 450,
            last_edited_at_ms = ?, edit_count = 1, version = 2
        WHERE id = ?
      `).run(ROLLOVER_AT_MS - 1, result.openingBidId);
      database.prepare(`
        UPDATE job_runs
        SET status = 'succeeded', attempt_count = 1,
            started_at_ms = ?, completed_at_ms = ?,
            updated_at_ms = ?, version = 2
        WHERE id = ?
      `).run(
        ROLLOVER_AT_MS - 1,
        ROLLOVER_AT_MS,
        ROLLOVER_AT_MS,
        result.resolutionJobRunId
      );
      database.prepare(`
        UPDATE free_agent_draft_rollovers
        SET status = 'completed', processing_job_run_id = ?,
            processing_started_at_ms = ?, completed_at_ms = ?,
            updated_at_ms = ?, version = 2
        WHERE id = ?
      `).run(
        result.resolutionJobRunId,
        ROLLOVER_AT_MS,
        ROLLOVER_AT_MS,
        ROLLOVER_AT_MS,
        PRIMARY.rollover
      );
      database.prepare(`
        UPDATE free_agent_drafts
        SET status = 'completed', completed_at_ms = ?,
            updated_at_ms = ?, version = 5
        WHERE id = ?
      `).run(
        ROLLOVER_AT_MS,
        ROLLOVER_AT_MS,
        PRIMARY.fad
      );
    });
    const callsBeforeReplay = fixture.generated.length;
    const nonceBeforeReplay = fixture.nonceCalls;
    const replay = fixture.writer.startOrQueue({
      ...input,
      nowMs: ROLLOVER_AT_MS + DAY_MS,
      idempotencyExpiresAtMs: ROLLOVER_AT_MS + 2 * DAY_MS,
    });
    assert.deepEqual(
      { ...replay, replayed: false },
      result
    );
    assert.equal(replay.replayed, true);
    assert.equal(fixture.generated.length, callsBeforeReplay);
    assert.equal(fixture.nonceCalls, nonceBeforeReplay);
    assertPolicyReason(
      () => fixture.writer.startOrQueue(command(
        PRIMARY,
        DIRECT_AT_MS,
        "direct-start",
        { body: { aavCents: 400 } }
      )),
      "IDEMPOTENCY_KEY_REUSED"
    );
  });

  test("direct replay checks current role before loading malformed private event evidence", (t) => {
    const fixture = createFixture(t, "replay-authority-precedence", {
      idBase: 8_080,
    });
    const input = command(
      PRIMARY,
      DIRECT_AT_MS,
      "replay-authority-precedence"
    );
    const result = fixture.writer.startOrQueue(input);
    const generatedBeforeReplay = fixture.generated.length;
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE auction_events
        SET metadata_json = '{'
        WHERE id = ?
      `).run(result.auctionEventId);
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended', ended_at_ms = ?
        WHERE id = ?
      `).run(DIRECT_AT_MS + 1, PRIMARY.assignment);
    });
    const replayInput = {
      ...input,
      nowMs: DIRECT_AT_MS + 2,
      idempotencyExpiresAtMs: DIRECT_AT_MS + DAY_MS,
    };
    assertPolicyReason(
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(fixture.generated.length, generatedBeforeReplay);

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'accepted', ended_at_ms = NULL
        WHERE id = ?
      `).run(PRIMARY.assignment);
    });
    assertRepositoryReason(
      () => fixture.writer.startOrQueue(replayInput),
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "START_EVENT_JSON_INVALID"
    );
    assert.equal(fixture.generated.length, generatedBeforeReplay);
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM idempotency_requests WHERE id = ?
      `).get(result.idempotencyRequestId).status,
      "completed"
    );
  });

  test("commissioner can start directly, while dual-role actors persist manager-first on both sides of the cutoff", (t) => {
    const commissionerFixture = createFixture(t, "commissioner", {
      idBase: 8_100,
    });
    const commissioner = commissionerFixture.writer.startOrQueue(command(
      PRIMARY,
      DIRECT_AT_MS,
      "commissioner-direct",
      {
        actorUserId: PRIMARY.commissionerUser,
        actorMembershipId: PRIMARY.commissionerMembership,
      }
    ));
    assert.equal(commissioner.kind, "auction_opened");
    assert.equal(commissioner.actorAuthority, "commissioner");

    const directFixture = createFixture(t, "dual-direct", {
      idBase: 8_200,
    });
    const dualDirect = directFixture.writer.startOrQueue(command(
      SECONDARY,
      DIRECT_AT_MS,
      "dual-direct"
    ));
    assert.equal(dualDirect.actorAuthority, "manager");

    const queueFixture = createFixture(t, "dual-queue", {
      idBase: 8_300,
    });
    const dualQueue = queueFixture.writer.startOrQueue(command(
      SECONDARY,
      CREATION_CUTOFF_AT_MS,
      "dual-queue"
    ));
    assert.equal(dualQueue.kind, "nomination_queued");
    assert.equal(dualQueue.actorAuthority, "manager");

    const rejectedFixture = createFixture(t, "commissioner-queue", {
      idBase: 8_400,
    });
    assertPolicyReason(
      () => rejectedFixture.writer.startOrQueue(command(
        PRIMARY,
        CREATION_CUTOFF_AT_MS,
        "commissioner-queue",
        {
          actorUserId: PRIMARY.commissionerUser,
          actorMembershipId: PRIMARY.commissionerMembership,
        }
      )),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(rejectedFixture.generated.length, 0);
  });

  test("fresh and replayed starts require active current actor evidence and accept the current replacement manager", (t) => {
    const fixture = createFixture(t, "transaction-authority", {
      idBase: 8_240,
    });
    const replacement = Object.freeze({
      user: uuid(98_001),
      membership: uuid(98_002),
      assignment: uuid(98_003),
    });
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended', ended_at_ms = ?
        WHERE id = ?
      `).run(DIRECT_AT_MS - 1, PRIMARY.assignment);
      insert(fixture.database, "users", {
        id: replacement.user,
        email_normalized:
          "fad-start-replacement@example.test",
        email_display:
          "fad-start-replacement@example.test",
        display_name: "FAD Start Replacement",
        display_name_normalized: "fad start replacement",
        status: "active",
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      insert(fixture.database, "league_memberships", {
        id: replacement.membership,
        league_id: PRIMARY.league,
        user_id: replacement.user,
        permission_category: "manager",
        status: "active",
        joined_at_ms: 1,
        ended_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      insert(fixture.database, "team_manager_assignments", {
        id: replacement.assignment,
        league_id: PRIMARY.league,
        team_id: PRIMARY.team,
        user_id: replacement.user,
        membership_id: replacement.membership,
        assigned_by_user_id: PRIMARY.commissionerUser,
        replaces_assignment_id: PRIMARY.assignment,
        status: "accepted",
        assigned_at_ms: 1,
        accepted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      });
    });

    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(command(
        PRIMARY,
        DIRECT_AT_MS,
        "stale-replaced-manager"
      )),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(fixture.generated.length, 0);
    assert.equal(fixture.nonceCalls, 0);

    const input = command(
      PRIMARY,
      DIRECT_AT_MS,
      "current-replacement-manager",
      {
        actorUserId: replacement.user,
        actorMembershipId: replacement.membership,
      }
    );
    const result = fixture.writer.startOrQueue(input);
    assert.equal(result.actorAuthority, "manager");
    assert.equal(result.replayed, false);
    const replayInput = {
      ...input,
      nowMs: DIRECT_AT_MS + 2,
      idempotencyExpiresAtMs: DIRECT_AT_MS + DAY_MS,
    };
    const generatedAfterStart = fixture.generated.length;
    const nonceCallsAfterStart = fixture.nonceCalls;

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE league_memberships
        SET ended_at_ms = ?
        WHERE id = ?
      `).run(DIRECT_AT_MS + DAY_MS, replacement.membership);
    });
    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = NULL,
            ended_at_ms = NULL
        WHERE id = ?
      `).run(replacement.membership);
    });
    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE league_memberships
        SET joined_at_ms = 1
        WHERE id = ?
      `).run(replacement.membership);
      fixture.database.prepare(`
        UPDATE users
        SET status = 'disabled'
        WHERE id = ?
      `).run(replacement.user);
    });
    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE users
        SET status = 'active'
        WHERE id = ?
      `).run(replacement.user);
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET accepted_at_ms = NULL
        WHERE id = ?
      `).run(replacement.assignment);
    });
    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET accepted_at_ms = 1,
            ended_at_ms = ?
        WHERE id = ?
      `).run(DIRECT_AT_MS + DAY_MS, replacement.assignment);
    });
    assertPolicyReasonWithoutWrites(
      fixture.database,
      () => fixture.writer.startOrQueue(replayInput),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(fixture.generated.length, generatedAfterStart);
    assert.equal(fixture.nonceCalls, nonceCallsAfterStart);

    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE team_manager_assignments
        SET ended_at_ms = NULL
        WHERE id = ?
      `).run(replacement.assignment);
    });
    const replay = fixture.writer.startOrQueue(replayInput);
    assert.deepEqual({ ...replay, replayed: false }, result);
    assert.equal(replay.replayed, true);
    assert.equal(fixture.generated.length, generatedAfterStart);
    assert.equal(fixture.nonceCalls, nonceCallsAfterStart);
  });

  test("private queue publication uses only the exact current commissioner and active member administrator", (t) => {
    const fixture = createFixture(t, "queue-current-authority", {
      idBase: 8_450,
    });
    const replacementCommissionerUser = uuid(88_001);
    const replacementCommissionerMembership = uuid(88_002);
    const administratorUser = uuid(88_003);
    const administratorMembership = uuid(88_004);
    const administratorRole = uuid(88_005);
    withoutTriggers(fixture.database, () => {
      for (const [userId, label] of [
        [replacementCommissionerUser, "replacement"],
        [administratorUser, "administrator"],
      ]) {
        insert(fixture.database, "users", {
          id: userId,
          email_normalized: `fad-${label}@example.test`,
          email_display: `fad-${label}@example.test`,
          display_name: `FAD ${label}`,
          display_name_normalized: `fad ${label}`,
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
      }
      insert(fixture.database, "league_memberships", {
        id: replacementCommissionerMembership,
        league_id: PRIMARY.league,
        user_id: replacementCommissionerUser,
        permission_category: "commissioner",
        status: "active",
        joined_at_ms: 1,
        ended_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      insert(fixture.database, "league_memberships", {
        id: administratorMembership,
        league_id: PRIMARY.league,
        user_id: administratorUser,
        permission_category: "member",
        status: "active",
        joined_at_ms: 1,
        ended_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      insert(fixture.database, "platform_roles", {
        id: administratorRole,
        user_id: administratorUser,
        role: "platform_administrator",
        status: "active",
        granted_by_user_id: null,
        granted_at_ms: 1,
        ended_at_ms: null,
        version: 1,
      });
      fixture.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            version = version + 1
        WHERE id = @leagueId
      `).run({
        membershipId: replacementCommissionerMembership,
        leagueId: PRIMARY.league,
      });
    });

    const input = command(
      PRIMARY,
      CREATION_CUTOFF_AT_MS,
      "queue-current-authority"
    );
    const result = fixture.writer.startOrQueue(input);
    const event = fixture.database.prepare(`
      SELECT id FROM outbox_events WHERE aggregate_id = ?
    `).get(result.nominationQueueId);
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT audience_kind, team_id, user_id
        FROM outbox_event_audiences
        WHERE outbox_event_id = ?
        ORDER BY audience_kind, COALESCE(team_id, user_id)
      `).all(event.id),
      [
        {
          audience_kind: "team",
          team_id: PRIMARY.team,
          user_id: null,
        },
        {
          audience_kind: "user",
          team_id: null,
          user_id: replacementCommissionerUser,
        },
        {
          audience_kind: "user",
          team_id: null,
          user_id: administratorUser,
        },
      ].sort((left, right) =>
        `${left.audience_kind}:${left.team_id || left.user_id}`
          .localeCompare(
            `${right.audience_kind}:${right.team_id || right.user_id}`
          )
      )
    );
    assert.ok(
      !fixture.database.prepare(`
        SELECT payload_json FROM outbox_events WHERE id = ?
      `).get(event.id).payload_json.includes(PRIMARY.commissionerUser)
    );

    const generatedBeforeReplay = fixture.generated.length;
    withoutTriggers(fixture.database, () => {
      fixture.database.prepare(`
        UPDATE platform_roles
        SET status = 'ended', ended_at_ms = @endedAtMs,
            version = version + 1
        WHERE id = @roleId
      `).run({
        endedAtMs: CREATION_CUTOFF_AT_MS + 1,
        roleId: administratorRole,
      });
      fixture.database.prepare(`
        UPDATE leagues
        SET commissioner_membership_id = @membershipId,
            version = version + 1
        WHERE id = @leagueId
      `).run({
        membershipId: PRIMARY.commissionerMembership,
        leagueId: PRIMARY.league,
      });
      fixture.database.prepare(`
        UPDATE outbox_events
        SET status = 'failed', attempt_count = 1,
            available_at_ms = @availableAtMs,
            last_error_code = 'TRANSIENT_PUBLICATION_FAILURE',
            updated_at_ms = @updatedAtMs, version = version + 1
        WHERE id = @eventId
      `).run({
        availableAtMs: CREATION_CUTOFF_AT_MS + DAY_MS,
        updatedAtMs: CREATION_CUTOFF_AT_MS + 1,
        eventId: event.id,
      });
    });
    const replay = fixture.writer.startOrQueue({
      ...input,
      nowMs: CREATION_CUTOFF_AT_MS + 2,
      idempotencyExpiresAtMs: ROLLOVER_AT_MS + DAY_MS,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.nominationQueueId, result.nominationQueueId);
    assert.equal(fixture.generated.length, generatedBeforeReplay);
    assert.equal(count(fixture.database, "outbox_events", PRIMARY.league), 1);
  });

  test("exact cutoff and final millisecond queue privately, replay after invalidation, and publish only private queue metadata", (t) => {
    for (const [label, acceptedAtMs] of [
      ["cutoff", CREATION_CUTOFF_AT_MS],
      ["final", ROLLOVER_AT_MS - 1],
    ]) {
      const fixture = createFixture(t, `queue-${label}`, {
        idBase: label === "cutoff" ? 8_500 : 8_600,
      });
      const input = command(
        PRIMARY,
        acceptedAtMs,
        `queue-${label}`
      );
      const result = fixture.writer.startOrQueue(input);
      assert.equal(result.kind, "nomination_queued");
      assert.equal(result.replayed, false);
      assert.equal(result.acceptedAtMs, acceptedAtMs);
      assert.equal(result.opensAtMs, ROLLOVER_AT_MS);
      assert.equal(result.resolvesAtMs, ROLLOVER_AT_MS + DAY_MS);
      assert.equal(result.targetOpeningRolloverId, PRIMARY.rollover);
      assert.equal(result.resolutionRolloverId, null);
      assert.deepEqual(result.queuedNomination, {
        queueId: result.nominationQueueId,
        fadId: PRIMARY.fad,
        teamId: PRIMARY.team,
        player: {
          playerId: PRIMARY.player,
          fullName: "Rapid Player 1",
          positionGroup: "D",
        },
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
        bindingIllegalityConfirmedAtMs: acceptedAtMs,
        acceptedAtMs,
        openingRolloverId: PRIMARY.rollover,
        resolutionRolloverId: null,
        status: "queued",
        version: 1,
      });
      assert.equal(fixture.generated.length, 3);
      assert.equal(fixture.nonceCalls, 0);

      const database = fixture.database;
      const queue = database.prepare(`
        SELECT status, acceptance_idempotency_request_id,
               source_rollover_id, target_opening_rollover_id,
               resolution_rollover_id, candidate_card_version_observed,
               team_version_observed, accepted_at_ms
        FROM free_agent_draft_nomination_queue
        WHERE id = ?
      `).get(result.nominationQueueId);
      assert.deepEqual(queue, {
        status: "queued",
        acceptance_idempotency_request_id:
          result.idempotencyRequestId,
        source_rollover_id: PRIMARY.rollover,
        target_opening_rollover_id: PRIMARY.rollover,
        resolution_rollover_id: null,
        candidate_card_version_observed: 3,
        team_version_observed: 1,
        accepted_at_ms: acceptedAtMs,
      });
      const job = database.prepare(`
        SELECT job_type, occurrence_key, scheduled_for_ms, status
        FROM job_runs
        WHERE id = ?
      `).get(result.activationJobRunId);
      assert.deepEqual(job, {
        job_type: "fad_queued_nomination_activation",
        occurrence_key:
          `fad:${PRIMARY.fad}:nomination-open:` +
          `${result.nominationQueueId}:${ROLLOVER_AT_MS}`,
        scheduled_for_ms: ROLLOVER_AT_MS,
        status: "pending",
      });
      for (const tableName of [
        "auctions",
        "auction_contexts",
        "auction_bids",
        "auction_events",
        "free_agent_draft_draws",
        "league_activity",
        "notifications",
      ]) {
        assert.equal(
          count(database, tableName, PRIMARY.league),
          0,
          `${label} queue leaked ${tableName}`
        );
      }
      const publication = database.prepare(`
        SELECT id, event_type, aggregate_type, aggregate_id,
               payload_json, created_at_ms
        FROM outbox_events
        WHERE league_id = ?
      `).get(PRIMARY.league);
      assert.equal(
        count(database, "outbox_events", PRIMARY.league),
        1
      );
      assert.equal(
        publication.event_type,
        "fad_nomination_queue.changed"
      );
      assert.equal(
        publication.aggregate_type,
        "fad_nomination_queue"
      );
      assert.equal(
        publication.aggregate_id,
        result.nominationQueueId
      );
      assert.equal(publication.created_at_ms, acceptedAtMs);
      assert.deepEqual(JSON.parse(publication.payload_json), {
        eventId: publication.id,
        type: "fad_nomination_queue.changed",
        leagueId: PRIMARY.league,
        resourceId: result.nominationQueueId,
        version: 1,
        reasonCode: "nomination_queued",
        occurredAt: acceptedAtMs,
        related: {
          fadId: PRIMARY.fad,
          teamId: PRIMARY.team,
          cardId: null,
          allocationId: null,
          auctionId: null,
          recoveryId: null,
          nominationQueueId: result.nominationQueueId,
          scheduleRecoveryOperationId: null,
        },
      });
      assert.deepEqual(
        database.prepare(`
          SELECT audience_kind, team_id, user_id
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
          ORDER BY audience_kind, COALESCE(team_id, user_id)
        `).all(publication.id),
        [
          {
            audience_kind: "team",
            team_id: PRIMARY.team,
            user_id: null,
          },
          {
            audience_kind: "user",
            team_id: null,
            user_id: PRIMARY.commissionerUser,
          },
        ]
      );
      assert.ok(!publication.payload_json.includes(PRIMARY.player));
      assert.ok(!publication.payload_json.includes(PRIMARY.managerUser));
      assert.ok(!publication.payload_json.includes("totalValue"));

      withoutTriggers(database, () => {
        database.prepare(`
          UPDATE free_agent_draft_nomination_queue
          SET status = 'invalid', terminal_at_ms = @terminalAtMs,
              validation_code = 'PLAYER_UNAVAILABLE',
              updated_at_ms = @terminalAtMs, version = version + 1
          WHERE id = @queueId
        `).run({
          queueId: result.nominationQueueId,
          terminalAtMs: ROLLOVER_AT_MS,
        });
      });
      const callsBeforeReplay = fixture.generated.length;
      const replay = fixture.writer.startOrQueue({
        ...input,
        nowMs: ROLLOVER_AT_MS + 1,
        idempotencyExpiresAtMs: ROLLOVER_AT_MS + DAY_MS,
      });
      assert.deepEqual(
        {
          ...replay,
          replayed: false,
          queuedNomination: result.queuedNomination,
        },
        result
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.queuedNomination, {
        ...result.queuedNomination,
        status: "invalid",
        version: 2,
      });
      assert.equal(fixture.generated.length, callsBeforeReplay);
      assert.equal(fixture.nonceCalls, 0);
      withoutTriggers(database, () => {
        database.prepare(`
          UPDATE team_manager_assignments
          SET status = 'ended', ended_at_ms = ?
          WHERE id = ?
        `).run(ROLLOVER_AT_MS + 2, PRIMARY.assignment);
      });
      assertPolicyReason(
        () => fixture.writer.startOrQueue({
          ...input,
          nowMs: ROLLOVER_AT_MS + 3,
          idempotencyExpiresAtMs: ROLLOVER_AT_MS + DAY_MS,
        }),
        AUCTION_CREATION_CODES.authorizationDenied
      );
      assert.equal(fixture.generated.length, callsBeforeReplay);
    }
  });

  test("rollover, authority, eligibility, and quarantine failures write nothing", (t) => {
    const rolloverFixture = createFixture(t, "rollover-closed", {
      idBase: 8_700,
    });
    assertPolicyReason(
      () => rolloverFixture.writer.startOrQueue(command(
        PRIMARY,
        ROLLOVER_AT_MS,
        "closed"
      )),
      AUCTION_CREATION_CODES.windowClosed
    );
    assert.equal(rolloverFixture.generated.length, 0);

    const inactiveFixture = createFixture(t, "inactive-player", {
      idBase: 8_800,
    });
    withoutTriggers(inactiveFixture.database, () => {
      inactiveFixture.database.prepare(`
        UPDATE players SET status = 'historical' WHERE id = ?
      `).run(PRIMARY.player);
    });
    assertPolicyReason(
      () => inactiveFixture.writer.startOrQueue(command(
        PRIMARY,
        DIRECT_AT_MS,
        "inactive"
      )),
      AUCTION_CREATION_CODES.playerIneligible
    );
    assert.equal(inactiveFixture.generated.length, 0);

    const quarantineFixture = createFixture(t, "quarantine", {
      idBase: 8_900,
    });
    withoutTriggers(quarantineFixture.database, () => {
      insert(
        quarantineFixture.database,
        "free_agent_draft_player_allocations",
        {
          id: PRIMARY.quarantineAllocation,
          league_id: PRIMARY.league,
          season_id: PRIMARY.season,
          fad_id: PRIMARY.fad,
          player_id: PRIMARY.player,
          status: "correction_required",
          decision_code: "corrected",
          winning_snapshot_entry_id: null,
          winning_team_id: null,
          contract_id: null,
          ownership_id: null,
          restricted_auction_id: null,
          fallback_open_auction_id: null,
          restricted_minimum_total_cents: null,
          restricted_minimum_term_years: null,
          restricted_minimum_aav_cents: null,
          accounted_at_ms: null,
          last_error_code: "PLAYER_STATE_CONFLICT",
          created_at_ms: DIRECT_AT_MS,
          updated_at_ms: DIRECT_AT_MS,
          version: 1,
        }
      );
    });
    assertPolicyReason(
      () => quarantineFixture.writer.startOrQueue(command(
        PRIMARY,
        DIRECT_AT_MS,
        "quarantined"
      )),
      AUCTION_CREATION_CODES.fadAllocationQuarantined
    );
    assert.equal(quarantineFixture.generated.length, 0);

    const authorityFixture = createFixture(t, "authority", {
      idBase: 9_000,
    });
    withoutTriggers(authorityFixture.database, () => {
      authorityFixture.database.prepare(`
        UPDATE team_manager_assignments
        SET status = 'ended', ended_at_ms = ?
        WHERE id = ?
      `).run(DIRECT_AT_MS - 1, PRIMARY.assignment);
    });
    assertPolicyReason(
      () => authorityFixture.writer.startOrQueue(command(
        PRIMARY,
        DIRECT_AT_MS,
        "ended-manager"
      )),
      AUCTION_CREATION_CODES.authorizationDenied
    );
    assert.equal(authorityFixture.generated.length, 0);
  });

  test("same intent key is league-isolated and queue privacy does not cross leagues", (t) => {
    const fixture = createFixture(t, "two-leagues", {
      idBase: 9_100,
    });
    const first = fixture.writer.startOrQueue(command(
      PRIMARY,
      CREATION_CUTOFF_AT_MS,
      "same-private-key"
    ));
    assert.equal(
      count(
        fixture.database,
        "free_agent_draft_nomination_queue",
        SECONDARY.league
      ),
      0
    );
    const second = fixture.writer.startOrQueue(command(
      SECONDARY,
      CREATION_CUTOFF_AT_MS,
      "same-private-key"
    ));
    assert.notEqual(first.nominationQueueId, second.nominationQueueId);
    assert.equal(
      count(
        fixture.database,
        "free_agent_draft_nomination_queue",
        PRIMARY.league
      ),
      1
    );
    assert.equal(
      count(
        fixture.database,
        "free_agent_draft_nomination_queue",
        SECONDARY.league
      ),
      1
    );
    assert.equal(count(fixture.database, "auctions", PRIMARY.league), 0);
    assert.equal(count(fixture.database, "auctions", SECONDARY.league), 0);
    assert.equal(count(fixture.database, "outbox_events", PRIMARY.league), 1);
    assert.equal(count(fixture.database, "outbox_events", SECONDARY.league), 1);
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT league_id, aggregate_id
        FROM outbox_events
        ORDER BY league_id
      `).all(),
      [
        {
          league_id: PRIMARY.league,
          aggregate_id: first.nominationQueueId,
        },
        {
          league_id: SECONDARY.league,
          aggregate_id: second.nominationQueueId,
        },
      ]
    );
  });

  test("beforeCommit rollback removes every direct and queued artifact", (t) => {
    for (const [label, nowMs] of [
      ["direct", DIRECT_AT_MS],
      ["queue", CREATION_CUTOFF_AT_MS],
    ]) {
      const fixture = createFixture(t, `rollback-${label}`, {
        idBase: label === "direct" ? 9_300 : 9_400,
        beforeCommit() {
          throw new Error(`rollback-${label}`);
        },
      });
      assert.throws(
        () => fixture.writer.startOrQueue(command(
          PRIMARY,
          nowMs,
          `rollback-${label}`
        )),
        (error) => {
          assert.equal(error.code, "REPOSITORY_OPERATION_FAILED");
          return true;
        }
      );
      for (const tableName of [
        "idempotency_requests",
        "auctions",
        "auction_contexts",
        "auction_bids",
        "auction_events",
        "free_agent_draft_draws",
        "free_agent_draft_nomination_queue",
        "job_runs",
        "outbox_events",
        "outbox_event_audiences",
      ]) {
        assert.equal(
          count(fixture.database, tableName, PRIMARY.league),
          0,
          `${label} rollback retained ${tableName}`
        );
      }
    }
  });

  test("a canonical queue-publication identity collision rolls every new write back", (t) => {
    const idBase = 9_500;
    const fixture = createFixture(t, "outbox-collision", { idBase });
    const expectedQueueId = uuid(idBase + 1);
    const collisionId = deterministicUuid(
      `fad-auction-start:${expectedQueueId}:nomination-queued`
    );
    withoutTriggers(fixture.database, () => {
      insert(fixture.database, "outbox_events", {
        id: collisionId,
        league_id: PRIMARY.league,
        event_type: "league.changed",
        aggregate_type: "league",
        aggregate_id: PRIMARY.league,
        payload_json: "{}",
        status: "pending",
        attempt_count: 0,
        available_at_ms: 1,
        published_at_ms: null,
        last_error_code: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
    });
    assertRepositoryReason(
      () => fixture.writer.startOrQueue(command(
        PRIMARY,
        CREATION_CUTOFF_AT_MS,
        "outbox-collision"
      )),
      REPOSITORY_ERROR_CODES.constraint,
      undefined
    );
    assert.equal(
      count(fixture.database, "idempotency_requests", PRIMARY.league),
      0
    );
    assert.equal(
      count(
        fixture.database,
        "free_agent_draft_nomination_queue",
        PRIMARY.league
      ),
      0
    );
    assert.equal(count(fixture.database, "job_runs", PRIMARY.league), 0);
    assert.equal(count(fixture.database, "outbox_events", PRIMARY.league), 1);
  });
});
