"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { test } = require("node:test");

const {
  applyMigrations,
  checksumBytes,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const MIGRATION_FILE =
  "0049_require_canonical_fad_setup_exemption_publications.sql";
const TRIGGER_NAME =
  "fad_setup_exemptions_t037_evidence_insert";
const AUTHORIZED_AT_MS = 20_000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  actor: uuid(1),
  platformRole: uuid(2),
  league: uuid(3),
  season: uuid(4),
  membership: uuid(5),
  migrationReport: uuid(6),
  bootstrapRequest: uuid(7),
  bootstrapActivity: uuid(8),
  bootstrapAudit: uuid(9),
  request: uuid(10),
  exemption: uuid(11),
  activity: uuid(12),
  audit: uuid(13),
  notification: uuid(14),
  leagueOutbox: uuid(15),
  activityOutbox: uuid(16),
  notificationOutbox: uuid(17),
  leagueAudience: uuid(18),
  activityAudience: uuid(19),
  notificationAudience: uuid(20),
  collisionOutbox: uuid(21),
  collisionAudience: uuid(22),
});

function migrationSources(maximumId = 49) {
  return discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= maximumId);
}

function migrate(database, maximumId, buildId) {
  return applyMigrations({
    database,
    migrations: migrationSources(maximumId),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function createDatabase(maximumId) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(database, maximumId, `fad14-schema-${maximumId}`);
  return database;
}

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  return database
    .prepare(
      `INSERT INTO ${tableName} (
         ${fields.join(", ")}
       ) VALUES (
         ${fields.map((field) => `@${field}`).join(", ")}
       )`
    )
    .run(values);
}

function triggerSql(database) {
  return database
    .prepare(
      "SELECT sql FROM sqlite_schema " +
        "WHERE type = 'trigger' AND name = ?"
    )
    .get(TRIGGER_NAME)?.sql;
}

function schemaRowsExceptTarget(database) {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name <> ? ORDER BY type, name"
    )
    .all(TRIGGER_NAME);
}

function schemaObjectCounts(database) {
  return database
    .prepare(
      "SELECT type, COUNT(*) AS count FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type"
    )
    .all();
}

function emptyRelated() {
  return {
    fadId: null,
    teamId: null,
    cardId: null,
    allocationId: null,
    auctionId: null,
    recoveryId: null,
    nominationQueueId: null,
    scheduleRecoveryOperationId: null,
  };
}

function envelope({
  id,
  type,
  resourceId,
  version,
  reasonCode,
}) {
  return JSON.stringify({
    eventId: id,
    type,
    leagueId: IDS.league,
    resourceId,
    version,
    reasonCode,
    occurredAt: AUTHORIZED_AT_MS,
    related: emptyRelated(),
  });
}

function seedOutbox(database, {
  id,
  type,
  aggregateType,
  aggregateId,
  version,
  reasonCode,
}) {
  insert(database, "outbox_events", {
    id,
    league_id: IDS.league,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload_json: envelope({
      id,
      type,
      resourceId: aggregateId,
      version,
      reasonCode,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: AUTHORIZED_AT_MS,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: AUTHORIZED_AT_MS,
    updated_at_ms: AUTHORIZED_AT_MS,
    version: 1,
  });
}

function seedAudience(database, {
  id,
  outboxId,
  kind,
  userId = null,
}) {
  insert(database, "outbox_event_audiences", {
    id,
    league_id: IDS.league,
    outbox_event_id: outboxId,
    audience_kind: kind,
    team_id: null,
    user_id: userId,
    created_at_ms: AUTHORIZED_AT_MS,
  });
}

function seedCanonicalEvidence(database) {
  const createdAtMs = 10_000;
  insert(database, "users", {
    id: IDS.actor,
    email_normalized: "schema49-admin@example.test",
    email_display: "schema49-admin@example.test",
    display_name: "Schema 49 Administrator",
    display_name_normalized: "schema 49 administrator",
    status: "active",
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  insert(database, "platform_roles", {
    id: IDS.platformRole,
    user_id: IDS.actor,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: IDS.actor,
    granted_at_ms: createdAtMs,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "leagues", {
    id: IDS.league,
    name: "Schema 49 League",
    name_normalized: "schema 49 league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    label: "2026",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  insert(database, "league_memberships", {
    id: IDS.membership,
    league_id: IDS.league,
    user_id: IDS.actor,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: createdAtMs,
    ended_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  database
    .prepare(
      "UPDATE leagues SET commissioner_membership_id = ?, " +
        "current_season_id = ?, updated_at_ms = ?, version = 2 " +
        "WHERE id = ?"
    )
    .run(
      IDS.membership,
      IDS.season,
      createdAtMs,
      IDS.league
    );
  insert(database, "idempotency_requests", {
    id: IDS.bootstrapRequest,
    league_id: IDS.league,
    actor_user_id: IDS.actor,
    operation: "admin.league.bootstrap_reset_original.v1",
    client_key: "schema49-bootstrap",
    request_hash: "1".repeat(64),
    status: "completed",
    result_type: "league",
    result_id: IDS.league,
    created_at_ms: createdAtMs,
    completed_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + 86_400_000,
  });
  insert(database, "league_activity", {
    id: IDS.bootstrapActivity,
    league_id: IDS.league,
    season_id: IDS.season,
    event_type: "league_created",
    actor_user_id: IDS.actor,
    actor_authority: "platform_administrator",
    team_id: null,
    player_id: null,
    related_type: "league",
    related_id: IDS.league,
    display_summary: "Schema 49 League was created in Setup.",
    reason: null,
    metadata_json:
      '{"leagueStatus":"setup","seasonStatus":"planned"}',
    occurred_at_ms: createdAtMs,
  });
  insert(database, "security_audit_events", {
    id: IDS.bootstrapAudit,
    event_type: "system_bootstrap.reset_original_league_created",
    outcome: "success",
    actor_user_id: IDS.actor,
    target_user_id: null,
    league_id: IDS.league,
    session_id: null,
    request_correlation_id: null,
    reason_code: "closed_write_reset_handoff",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: createdAtMs,
  });
  insert(database, "migration_reports", {
    id: IDS.migrationReport,
    league_id: IDS.league,
    source_bundle_id: "schema49-foundation",
    reset_manifest_id: "2026-season-1-reset-v1",
    database_schema_version: 48,
    status: "succeeded",
    source_hashes_json: JSON.stringify({
      source: "2".repeat(64),
    }),
    counts_json: JSON.stringify({ teams: 1 }),
    totals_json: JSON.stringify({ records: 1 }),
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: createdAtMs + 1,
    completed_at_ms: createdAtMs + 2,
    created_at_ms: createdAtMs + 1,
  });
  insert(database, "idempotency_requests", {
    id: IDS.request,
    league_id: IDS.league,
    actor_user_id: IDS.actor,
    operation: "league.lifecycle.transition.v2",
    client_key: "schema49-setup-exemption",
    request_hash: "3".repeat(64),
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: AUTHORIZED_AT_MS,
    completed_at_ms: null,
    expires_at_ms: AUTHORIZED_AT_MS + 86_400_000,
  });
  insert(database, "league_activity", {
    id: IDS.activity,
    league_id: IDS.league,
    season_id: IDS.season,
    event_type: "fad_setup_exemption_authorized",
    actor_user_id: IDS.actor,
    actor_authority:
      "platform_administrator_as_commissioner",
    team_id: null,
    player_id: null,
    related_type: "season",
    related_id: IDS.season,
    display_summary:
      "Initial Season 2 Free Agent Draft exemption authorized.",
    reason: null,
    metadata_json: JSON.stringify({
      exemptionId: IDS.exemption,
      migrationReportId: IDS.migrationReport,
      seasonId: IDS.season,
    }),
    occurred_at_ms: AUTHORIZED_AT_MS,
  });
  insert(database, "security_audit_events", {
    id: IDS.audit,
    event_type: "fad.setup_exemption_authorized",
    outcome: "success",
    actor_user_id: IDS.actor,
    target_user_id: null,
    league_id: IDS.league,
    session_id: null,
    request_correlation_id: null,
    reason_code: "initial_season2_no_draft_authorized",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: AUTHORIZED_AT_MS,
  });
  insert(database, "notifications", {
    id: IDS.notification,
    user_id: IDS.actor,
    league_id: IDS.league,
    event_type: "fad_setup_exemption_authorized",
    delivery_status: "pending",
    message_data_json: JSON.stringify({
      destination: {
        kind: "commissioner_fad",
        leagueId: IDS.league,
        seasonId: IDS.season,
      },
      exemptionId: IDS.exemption,
      leagueId: IDS.league,
      seasonId: IDS.season,
    }),
    related_feature: "free_agent_draft_setup",
    related_record_id: IDS.exemption,
    deduplication_key:
      `fad_setup_exemption_authorized:${IDS.league}:` +
      `${IDS.season}:${IDS.exemption}:${IDS.actor}`,
    read_at_ms: null,
    delivered_at_ms: null,
    created_at_ms: AUTHORIZED_AT_MS,
    version: 1,
  });

  seedOutbox(database, {
    id: IDS.leagueOutbox,
    type: "league.changed",
    aggregateType: "league",
    aggregateId: IDS.league,
    version: 2,
    reasonCode: "league_changed",
  });
  seedAudience(database, {
    id: IDS.leagueAudience,
    outboxId: IDS.leagueOutbox,
    kind: "league",
  });
  seedOutbox(database, {
    id: IDS.activityOutbox,
    type: "activity.created",
    aggregateType: "activity",
    aggregateId: IDS.activity,
    version: 1,
    reasonCode: "setup_exemption_authorized",
  });
  seedAudience(database, {
    id: IDS.activityAudience,
    outboxId: IDS.activityOutbox,
    kind: "league",
  });
  seedOutbox(database, {
    id: IDS.notificationOutbox,
    type: "notification.created",
    aggregateType: "notification",
    aggregateId: IDS.notification,
    version: 1,
    reasonCode: "setup_exemption_authorized",
  });
  seedAudience(database, {
    id: IDS.notificationAudience,
    outboxId: IDS.notificationOutbox,
    kind: "user",
    userId: IDS.actor,
  });
}

function insertExemption(database) {
  return insert(
    database,
    "free_agent_draft_setup_exemptions",
    {
      id: IDS.exemption,
      league_id: IDS.league,
      season_id: IDS.season,
      exemption_kind: "initial_season2_transition",
      migration_report_id: IDS.migrationReport,
      reason: "Schema 49 reset transition",
      authorized_by_user_id: IDS.actor,
      authorized_by_membership_id: IDS.membership,
      authorized_authority:
        "platform_administrator_as_commissioner",
      authorized_at_ms: AUTHORIZED_AT_MS,
      consumed_fad_id: null,
      consumed_at_ms: null,
      created_at_ms: AUTHORIZED_AT_MS,
      updated_at_ms: AUTHORIZED_AT_MS,
      version: 1,
      idempotency_request_id: IDS.request,
      migration_report_sha256: "4".repeat(64),
      bootstrap_identity_sha256: "5".repeat(64),
      bootstrap_idempotency_request_id:
        IDS.bootstrapRequest,
      bootstrap_activity_id: IDS.bootstrapActivity,
      bootstrap_security_audit_event_id:
        IDS.bootstrapAudit,
      bootstrap_actor_user_id: IDS.actor,
      authorization_activity_id: IDS.activity,
      authorization_security_audit_event_id: IDS.audit,
      commissioner_notification_id: IDS.notification,
      outbox_event_id: IDS.leagueOutbox,
    }
  );
}

function retainOnlyTargetTrigger(database) {
  const trigger = triggerSql(database);
  const names = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'trigger' AND name <> ?"
    )
    .all(TRIGGER_NAME);
  for (const { name } of names) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
  assert.equal(triggerSql(database), trigger);
}

function assertExemptionRejected(database, pattern) {
  assert.throws(() => insertExemption(database), pattern);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM " +
          "free_agent_draft_setup_exemptions"
      )
      .get().count,
    0
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT status, result_type, result_id, completed_at_ms " +
          "FROM idempotency_requests WHERE id = ?"
      )
      .get(IDS.request),
    {
      status: "started",
      result_type: null,
      result_id: null,
      completed_at_ms: null,
    }
  );
}

test("discovers additive migration 0049", () => {
  const migration = migrationSources(49).find(
    ({ id }) => id === 49
  );
  assert.equal(migration?.fileName, MIGRATION_FILE);
});

test("preserves every unrelated schema object and all pre-notification evidence predicates", () => {
  const database = createDatabase(48);
  try {
    const beforeRows = schemaRowsExceptTarget(database);
    const beforeCounts = schemaObjectCounts(database);
    const beforeTrigger = triggerSql(database);
    const marker =
      "  SELECT CASE WHEN NOT EXISTS (\n" +
      "    SELECT 1\n" +
      "    FROM notifications";
    const beforeBoundary = beforeTrigger.indexOf(marker);
    assert.ok(beforeBoundary > 0);

    migrate(database, 49, "fad14-schema49-preservation");
    const afterTrigger = triggerSql(database);
    const afterBoundary = afterTrigger.indexOf(marker);
    assert.ok(afterBoundary > 0);
    assert.equal(
      afterTrigger.slice(0, afterBoundary),
      beforeTrigger.slice(0, beforeBoundary)
    );
    assert.deepEqual(schemaRowsExceptTarget(database), beforeRows);
    assert.deepEqual(schemaObjectCounts(database), beforeCounts);
    assert.equal(
      database.pragma("user_version", { simple: true }),
      49
    );
    assert.equal(
      database
        .prepare(
          "SELECT metadata_value FROM application_metadata " +
            "WHERE metadata_key = 'data_model_version'"
        )
        .get().metadata_value,
      "49"
    );
    assert.match(
      afterTrigger,
      /permission_category =\s*'commissioner'/
    );
    assert.match(
      afterTrigger,
      /activity\.created'[\s\S]*setup_exemption_authorized/
    );
    assert.match(
      afterTrigger,
      /notification\.created'[\s\S]*setup_exemption_authorized/
    );
    assert.doesNotMatch(afterTrigger, /'kind'\s*,\s*'invalidation'/);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  } finally {
    database.close();
  }
});

test("is red at head 48, green after upgrade 49, and green on fresh 49", () => {
  const upgraded = createDatabase(48);
  try {
    seedCanonicalEvidence(upgraded);
    assertExemptionRejected(
      upgraded,
      /FAD setup exemption notification is inconsistent/
    );
    migrate(upgraded, 49, "fad14-schema49-upgrade");
    assert.equal(insertExemption(upgraded).changes, 1);
    assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
  } finally {
    upgraded.close();
  }

  const fresh = createDatabase(49);
  try {
    seedCanonicalEvidence(fresh);
    assert.equal(insertExemption(fresh).changes, 1);
    assert.deepEqual(fresh.pragma("foreign_key_check"), []);
  } finally {
    fresh.close();
  }
});

test("rejects malformed destination, audience, envelope, authority, missing publication, and aggregate collision atomically", () => {
  const cases = [
    {
      name: "destination",
      pattern: /notification is inconsistent/,
      mutate(database) {
        const message = JSON.parse(
          database
            .prepare(
              "SELECT message_data_json FROM notifications WHERE id = ?"
            )
            .get(IDS.notification).message_data_json
        );
        message.destination.kind = "fad_overview";
        database
          .prepare(
            "UPDATE notifications SET message_data_json = ? WHERE id = ?"
          )
          .run(JSON.stringify(message), IDS.notification);
      },
    },
    {
      name: "audience",
      pattern: /notification publication is inconsistent/,
      mutate(database) {
        database
          .prepare(
            "UPDATE outbox_event_audiences SET " +
              "audience_kind = 'league', user_id = NULL " +
              "WHERE outbox_event_id = ?"
          )
          .run(IDS.notificationOutbox);
      },
    },
    {
      name: "envelope",
      pattern: /Activity publication is inconsistent/,
      mutate(database) {
        const payload = JSON.parse(
          database
            .prepare(
              "SELECT payload_json FROM outbox_events WHERE id = ?"
            )
            .get(IDS.activityOutbox).payload_json
        );
        payload.privateReason = "must not publish";
        database
          .prepare(
            "UPDATE outbox_events SET payload_json = ? WHERE id = ?"
          )
          .run(JSON.stringify(payload), IDS.activityOutbox);
      },
    },
    {
      name: "authority category",
      pattern: /notification is inconsistent/,
      mutate(database) {
        database
          .prepare(
            "UPDATE league_memberships SET " +
              "permission_category = 'manager' WHERE id = ?"
          )
          .run(IDS.membership);
      },
    },
    {
      name: "missing publication",
      pattern: /Activity publication is inconsistent/,
      mutate(database) {
        database
          .prepare(
            "DELETE FROM outbox_event_audiences " +
              "WHERE outbox_event_id = ?"
          )
          .run(IDS.activityOutbox);
        database
          .prepare("DELETE FROM outbox_events WHERE id = ?")
          .run(IDS.activityOutbox);
      },
    },
    {
      name: "aggregate collision",
      pattern: /Activity publication is inconsistent/,
      mutate(database) {
        seedOutbox(database, {
          id: IDS.collisionOutbox,
          type: "activity.created",
          aggregateType: "activity",
          aggregateId: IDS.activity,
          version: 1,
          reasonCode: "setup_exemption_authorized",
        });
        seedAudience(database, {
          id: IDS.collisionAudience,
          outboxId: IDS.collisionOutbox,
          kind: "league",
        });
      },
    },
  ];

  for (const candidate of cases) {
    const database = createDatabase(49);
    try {
      seedCanonicalEvidence(database);
      retainOnlyTargetTrigger(database);
      candidate.mutate(database);
      assertExemptionRejected(database, candidate.pattern);
    } finally {
      database.close();
    }
  }
});

test("rolls back trigger replacement, metadata, and ledger when migration 49 fails", () => {
  const database = createDatabase(48);
  try {
    const beforeTrigger = triggerSql(database);
    const sources = migrationSources(49);
    const migration49 = sources.at(-1);
    const failedSql =
      migration49.sql +
      "\nSELECT definitely_missing_schema49_column FROM leagues;\n";
    const broken = {
      ...migration49,
      sql: failedSql,
      checksum: checksumBytes(Buffer.from(failedSql, "utf8")),
    };
    assert.throws(
      () =>
        applyMigrations({
          database,
          migrations: [...sources.slice(0, -1), broken],
          applicationBuildId: "fad14-schema49-forced-rollback",
          now: () => 2_000,
        }),
      (error) =>
        error?.code === "MIGRATION_APPLY_FAILED" &&
        error?.details?.migrationId === 49
    );
    assert.equal(
      database.pragma("user_version", { simple: true }),
      48
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get().count,
      48
    );
    assert.equal(triggerSql(database), beforeTrigger);
    assert.equal(
      database
        .prepare(
          "SELECT metadata_value FROM application_metadata " +
            "WHERE metadata_key = 'data_model_version'"
        )
        .get().metadata_value,
      "48"
    );
  } finally {
    database.close();
  }
});

test("pins immutable migration 0049 bytes and SHA-256", () => {
  const filePath = path.join(
    MIGRATIONS_DIRECTORY,
    MIGRATION_FILE
  );
  const bytes = fs.readFileSync(filePath);
  const identity = {
    byteLength: bytes.length,
    sha256: crypto
      .createHash("sha256")
      .update(bytes)
      .digest("hex"),
  };
  assert.deepEqual(identity, {
    byteLength: 29_571,
    sha256:
      "5109baabaeed39e06498c7c26274a41a48edfbbdee958e7dd6b278021a29ebc6",
  });
});
