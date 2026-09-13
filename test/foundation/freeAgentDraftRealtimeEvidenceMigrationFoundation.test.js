const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { describe, test } = require("node:test");

const {
  applyMigrations,
  checksumBytes,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const MIGRATION_FILE =
  "0048_require_canonical_fad_realtime_evidence.sql";
const MIGRATION_IDENTITY = Object.freeze({
  byteLength: 73_524,
  sha256:
    "c08445d1b3833343f9c276dff3cd9400ebce6e282665179b992f47919feceb21",
});
const READINESS_TRIGGER =
  "free_agent_draft_readiness_operations_forward_update";
const AUTOMATIC_TRIGGER =
  "free_agent_drafts_automatic_award_resources_barrier";
const OPENED_AT_MS = 1_000_000;
const DEADLINE_AT_MS = 1_000_000_000;

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
  readiness: uuid(4),
  readinessAttempt: uuid(5),
  readinessJob: uuid(6),
  reminderJob: uuid(7),
  deadlineJob: uuid(8),
  team: uuid(9),
  card: uuid(10),
  manager: uuid(11),
  membership: uuid(12),
  assignment: uuid(13),
  activity: uuid(14),
  notification: uuid(15),
  fadEvent: uuid(16),
  activityEvent: uuid(17),
  cardEvent: uuid(18),
  notificationEvent: uuid(19),
  otherTeam: uuid(20),
  legacyEvent: uuid(21),
  rollovers: Object.freeze(
    Array.from({ length: 7 }, (_, index) => uuid(30 + index))
  ),
  rolloverJobs: Object.freeze(
    Array.from({ length: 7 }, (_, index) => uuid(40 + index))
  ),
});

function migrations(maximumId) {
  return discoverMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  }).filter(({ id }) => id <= maximumId);
}

function migrate(database, maximumId, buildId) {
  return applyMigrations({
    database,
    migrations: migrations(maximumId),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function createDatabase(maximumId) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(
    database,
    maximumId,
    "fad14-schema-" + maximumId
  );
  return database;
}

function triggerSql(database, name) {
  return database
    .prepare(
      "SELECT sql FROM sqlite_schema " +
        "WHERE type = 'trigger' AND name = ?"
    )
    .get(name)?.sql;
}

function dropAllTriggers(database) {
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'trigger' ORDER BY name"
    )
    .all();
  for (const { name } of triggers) {
    database.exec(
      'DROP TRIGGER "' + name.replaceAll('"', '""') + '"'
    );
  }
}

let rawSequence = 0;
function rawInsert(database, tableName, overrides) {
  rawSequence += 1;
  const columns = database
    .prepare('PRAGMA table_info("' + tableName + '")')
    .all();
  const values = {};
  for (const column of columns) {
    if (Object.hasOwn(overrides, column.name)) {
      values[column.name] = overrides[column.name];
    } else if (column.notnull === 1) {
      if (/INT/i.test(column.type)) {
        values[column.name] = rawSequence;
      } else if (/BLOB/i.test(column.type)) {
        values[column.name] = Buffer.from([rawSequence % 256]);
      } else {
        values[column.name] =
          "raw:" +
          rawSequence +
          ":" +
          tableName +
          ":" +
          column.name;
      }
    } else {
      values[column.name] = null;
    }
  }
  database
    .prepare(
      'INSERT INTO "' +
        tableName +
        '" (' +
        columns
          .map(({ name }) => '"' + name + '"')
          .join(", ") +
        ") VALUES (" +
        columns
          .map(({ name }) => "@" + name)
          .join(", ") +
        ")"
    )
    .run(values);
}

function related({
  fadId = null,
  teamId = null,
  cardId = null,
} = {}) {
  return {
    fadId,
    teamId,
    cardId,
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
  reasonCode,
  relatedIds,
}) {
  return JSON.stringify({
    eventId: id,
    type,
    leagueId: IDS.league,
    resourceId,
    version: 1,
    reasonCode,
    occurredAt: OPENED_AT_MS,
    related: relatedIds,
  });
}

function seedOutbox(
  database,
  { id, type, aggregateType, aggregateId, reasonCode, relatedIds }
) {
  rawInsert(database, "outbox_events", {
    id,
    league_id: IDS.league,
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload_json: envelope({
      id,
      type,
      resourceId: aggregateId,
      reasonCode,
      relatedIds,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: OPENED_AT_MS,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
}

function seedAudience(
  database,
  { id, eventId, kind, teamId = null, userId = null }
) {
  rawInsert(database, "outbox_event_audiences", {
    id,
    league_id: IDS.league,
    outbox_event_id: eventId,
    audience_kind: kind,
    team_id: teamId,
    user_id: userId,
    created_at_ms: OPENED_AT_MS,
  });
}

function seedPendingJob(
  database,
  { id, jobType, occurrenceKey, scheduledForMs }
) {
  rawInsert(database, "job_runs", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    next_attempt_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
}

function seedReadinessFixture(database) {
  const readinessSql = triggerSql(database, READINESS_TRIGGER);
  const automaticSql = triggerSql(database, AUTOMATIC_TRIGGER);
  assert.ok(readinessSql);
  assert.ok(automaticSql);

  database.pragma("foreign_keys = OFF");
  dropAllTriggers(database);
  database.pragma("ignore_check_constraints = ON");

  rawInsert(database, "free_agent_draft_readiness_operations", {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key: "fad:readiness:test",
    trigger_kind: "entry_draft_completed",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: IDS.readinessJob,
    status: "running",
    attempt_count: 1,
    lease_owner: "fixture",
    lease_token: "fixture-token",
    lease_expires_at_ms: OPENED_AT_MS + 100,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: 100,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms: 0,
    updated_at_ms: 100,
    version: 1,
  });
  rawInsert(database, "free_agent_draft_readiness_attempts", {
    id: IDS.readinessAttempt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    job_run_id: IDS.readinessJob,
    attempt_number: 1,
    observed_readiness_version: 1,
    projection_json: '{"blockers":[]}',
    projection_sha256: "a".repeat(64),
    outcome: "succeeded",
    recorded_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    version: 1,
  });
  rawInsert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    readiness_occurrence_key: "fad:readiness:test",
    participating_team_count: 1,
    status: "cards_open",
    candidate_deadline_at_ms: DEADLINE_AT_MS,
    version: 1,
  });
  rawInsert(database, "free_agent_draft_teams", {
    id: uuid(60),
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: IDS.team,
  });
  rawInsert(database, "candidate_cards", {
    id: IDS.card,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    team_id: IDS.team,
    version: 1,
  });

  for (let index = 0; index < 7; index += 1) {
    const rollsOverAtMs =
      DEADLINE_AT_MS + (index + 1) * 86_400_000;
    rawInsert(database, "free_agent_draft_rollovers", {
      id: IDS.rollovers[index],
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: index + 1,
      window_kind: "initial",
      rolls_over_at_ms: rollsOverAtMs,
    });
    seedPendingJob(database, {
      id: IDS.rolloverJobs[index],
      jobType: "fad_rollover",
      occurrenceKey:
        "fad:" +
        IDS.fad +
        ":rollover:" +
        (index + 1) +
        ":" +
        rollsOverAtMs,
      scheduledForMs: rollsOverAtMs,
    });
  }
  seedPendingJob(database, {
    id: IDS.reminderJob,
    jobType: "fad_deadline_reminder",
    occurrenceKey:
      "fad:" +
      IDS.fad +
      ":reminder:" +
      (DEADLINE_AT_MS - 259_200_000),
    scheduledForMs: DEADLINE_AT_MS - 259_200_000,
  });
  seedPendingJob(database, {
    id: IDS.deadlineJob,
    jobType: "fad_deadline",
    occurrenceKey:
      "fad:" + IDS.fad + ":deadline:" + DEADLINE_AT_MS,
    scheduledForMs: DEADLINE_AT_MS,
  });

  rawInsert(database, "league_activity", {
    id: IDS.activity,
    league_id: IDS.league,
    season_id: IDS.season,
    event_type: "free_agent_draft_started",
    actor_user_id: null,
    actor_authority: "system",
    related_type: "free_agent_draft",
    related_id: IDS.fad,
    occurred_at_ms: OPENED_AT_MS,
  });
  rawInsert(database, "team_manager_assignments", {
    id: IDS.assignment,
    league_id: IDS.league,
    team_id: IDS.team,
    membership_id: IDS.membership,
    user_id: IDS.manager,
    status: "accepted",
    ended_at_ms: null,
  });
  rawInsert(database, "league_memberships", {
    id: IDS.membership,
    league_id: IDS.league,
    user_id: IDS.manager,
    status: "active",
  });
  rawInsert(database, "notifications", {
    id: IDS.notification,
    user_id: IDS.manager,
    league_id: IDS.league,
    event_type: "fad_cards_opened",
    message_data_json: JSON.stringify({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      teamId: IDS.team,
      cardId: IDS.card,
    }),
    related_feature: "free_agent_draft",
    related_record_id: IDS.fad,
    created_at_ms: OPENED_AT_MS,
    version: 1,
  });

  seedOutbox(database, {
    id: IDS.fadEvent,
    type: "free_agent_draft.changed",
    aggregateType: "free_agent_draft",
    aggregateId: IDS.fad,
    reasonCode: "cards_opened",
    relatedIds: related({ fadId: IDS.fad }),
  });
  seedAudience(database, {
    id: IDS.fadEvent,
    eventId: IDS.fadEvent,
    kind: "league",
  });
  seedOutbox(database, {
    id: IDS.activityEvent,
    type: "activity.created",
    aggregateType: "league_activity",
    aggregateId: IDS.activity,
    reasonCode: "cards_opened",
    relatedIds: related({ fadId: IDS.fad }),
  });
  seedAudience(database, {
    id: IDS.activityEvent,
    eventId: IDS.activityEvent,
    kind: "league",
  });
  seedOutbox(database, {
    id: IDS.cardEvent,
    type: "candidate_card.changed",
    aggregateType: "candidate_card",
    aggregateId: IDS.card,
    reasonCode: "card_changed",
    relatedIds: related({
      fadId: IDS.fad,
      teamId: IDS.team,
      cardId: IDS.card,
    }),
  });
  seedAudience(database, {
    id: IDS.cardEvent,
    eventId: IDS.cardEvent,
    kind: "team",
    teamId: IDS.team,
  });
  seedOutbox(database, {
    id: IDS.notificationEvent,
    type: "notification.created",
    aggregateType: "notification",
    aggregateId: IDS.notification,
    reasonCode: "cards_opened",
    relatedIds: related({
      fadId: IDS.fad,
      teamId: IDS.team,
      cardId: IDS.card,
    }),
  });
  seedAudience(database, {
    id: IDS.notificationEvent,
    eventId: IDS.notificationEvent,
    kind: "user",
    userId: IDS.manager,
  });

  database.pragma("ignore_check_constraints = OFF");
  database.exec(readinessSql + ";");
  database.exec(automaticSql + ";");
}

function completeReadiness(database) {
  return database
    .prepare(
      "UPDATE free_agent_draft_readiness_operations " +
        "SET status = 'succeeded', " +
        "lease_owner = NULL, lease_token = NULL, " +
        "lease_expires_at_ms = NULL, blockers_json = '[]', " +
        "matchup_schedule_version_before = NULL, " +
        "matchup_schedule_version_after = NULL, " +
        "schedule_recovery_id = NULL, " +
        "created_fad_id = @fadId, " +
        "reminder_job_run_id = @reminderJobId, " +
        "deadline_job_run_id = @deadlineJobId, " +
        "cards_opened_activity_id = @activityId, " +
        "cards_opened_outbox_event_id = @outboxEventId, " +
        "next_retry_at_ms = NULL, " +
        "terminal_at_ms = @openedAtMs, " +
        "updated_at_ms = @openedAtMs, version = version + 1 " +
        "WHERE id = @readinessId"
    )
    .run({
      fadId: IDS.fad,
      reminderJobId: IDS.reminderJob,
      deadlineJobId: IDS.deadlineJob,
      activityId: IDS.activity,
      outboxEventId: IDS.fadEvent,
      openedAtMs: OPENED_AT_MS,
      readinessId: IDS.readiness,
    });
}

function assertReadinessRejected(database) {
  assert.throws(
    () => completeReadiness(database),
    /FAD readiness must open every team and seven windows or none/
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT status, version FROM " +
          "free_agent_draft_readiness_operations WHERE id = ?"
      )
      .get(IDS.readiness),
    { status: "running", version: 1 }
  );
}

function schemaRows(database) {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name NOT IN (?, ?) ORDER BY type, name"
    )
    .all(READINESS_TRIGGER, AUTOMATIC_TRIGGER);
}

describe("migration 0048 canonical FAD realtime evidence", () => {
  test("pins migration 0048 and preserves every unrelated schema object", () => {
    const filePath = path.join(
      MIGRATIONS_DIRECTORY,
      MIGRATION_FILE
    );
    const bytes = fs.readFileSync(filePath);
    assert.equal(bytes.length, MIGRATION_IDENTITY.byteLength);
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      MIGRATION_IDENTITY.sha256
    );

    const database = createDatabase(47);
    try {
      const before = schemaRows(database);
      const oldReadiness = triggerSql(database, READINESS_TRIGGER);
      const oldAutomatic = triggerSql(database, AUTOMATIC_TRIGGER);
      assert.match(
        oldReadiness,
        /outbox_events\.event_type = 'fad_cards_opened'/
      );
      assert.match(
        oldAutomatic,
        /'fad_automatic_signing_completed'/
      );

      migrate(database, 48, "fad14-schema-upgrade");
      assert.equal(
        database.pragma("user_version", { simple: true }),
        48
      );
      assert.deepEqual(schemaRows(database), before);

      const newReadiness = triggerSql(
        database,
        READINESS_TRIGGER
      );
      const newAutomatic = triggerSql(
        database,
        AUTOMATIC_TRIGGER
      );
      const oldReadinessEvidenceStart = oldReadiness.indexOf(
        "        AND EXISTS (\n" +
          "          SELECT 1\n" +
          "          FROM outbox_events",
        oldReadiness.indexOf(
          "league_activity.event_type = " +
            "'free_agent_draft_started'"
        )
      );
      const newReadinessEvidenceStart = newReadiness.indexOf(
        "        AND EXISTS (\n" +
          "          SELECT 1\n" +
          "          FROM outbox_events AS fad_event"
      );
      const readinessEvidenceEndMarker =
        "      )\n    )\n  ) THEN RAISE(";
      const oldReadinessEvidenceEnd = oldReadiness.indexOf(
        readinessEvidenceEndMarker,
        oldReadinessEvidenceStart
      );
      const newReadinessEvidenceEnd = newReadiness.indexOf(
        readinessEvidenceEndMarker,
        newReadinessEvidenceStart
      );
      assert.equal(
        newReadiness.slice(0, newReadinessEvidenceStart),
        oldReadiness.slice(0, oldReadinessEvidenceStart)
      );
      assert.equal(
        newReadiness.slice(newReadinessEvidenceEnd),
        oldReadiness.slice(oldReadinessEvidenceEnd)
      );

      const automaticEvidenceStartMarker =
        "  SELECT CASE WHEN EXISTS (";
      const oldAutomaticEvidenceStart = oldAutomatic.indexOf(
        automaticEvidenceStartMarker,
        oldAutomatic.indexOf(
          "durable automatic-award resources"
        )
      );
      const newAutomaticEvidenceStart = newAutomatic.indexOf(
        automaticEvidenceStartMarker,
        newAutomatic.indexOf(
          "durable automatic-award resources"
        )
      );
      const automaticEvidenceEndMarker =
        "  ) THEN RAISE(\n" +
        "    ABORT,\n" +
        "    'FAD milestone requires automatic-award activity";
      const oldAutomaticEvidenceEnd = oldAutomatic.indexOf(
        automaticEvidenceEndMarker,
        oldAutomaticEvidenceStart
      );
      const newAutomaticEvidenceEnd = newAutomatic.indexOf(
        automaticEvidenceEndMarker,
        newAutomaticEvidenceStart
      );
      assert.equal(
        newAutomatic.slice(0, newAutomaticEvidenceStart),
        oldAutomatic.slice(0, oldAutomaticEvidenceStart)
      );
      assert.equal(
        newAutomatic.slice(newAutomaticEvidenceEnd),
        oldAutomatic.slice(oldAutomaticEvidenceEnd)
      );

      assert.match(
        newReadiness,
        /fad_event\.event_type = 'free_agent_draft\.changed'/
      );
      assert.match(
        newReadiness,
        /activity_event\.event_type = 'activity\.created'/
      );
      assert.match(
        newReadiness,
        /card_event\.event_type = 'candidate_card\.changed'/
      );
      assert.match(
        newReadiness,
        /notification_event\.event_type = 'notification\.created'/
      );
      assert.match(
        newAutomatic,
        /'free_agent_draft_player_awarded'/
      );
      assert.match(newAutomatic, /'allocation_changed'/);
      assert.doesNotMatch(
        newAutomatic,
        /'fad_automatic_signing_completed'/
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.deepEqual(database.pragma("integrity_check"), [
        { integrity_check: "ok" },
      ]);
    } finally {
      database.close();
    }
  });

  test("is red at head 47, green after upgrade 48, and green on fresh 48", () => {
    const upgraded = createDatabase(47);
    try {
      seedReadinessFixture(upgraded);
      assertReadinessRejected(upgraded);
      migrate(upgraded, 48, "fad14-red-green-upgrade");
      assert.equal(completeReadiness(upgraded).changes, 1);
      assert.deepEqual(
        upgraded
          .prepare(
            "SELECT status, version FROM " +
              "free_agent_draft_readiness_operations WHERE id = ?"
          )
          .get(IDS.readiness),
        { status: "succeeded", version: 2 }
      );
    } finally {
      upgraded.close();
    }

    const fresh = createDatabase(48);
    try {
      seedReadinessFixture(fresh);
      assert.equal(completeReadiness(fresh).changes, 1);
    } finally {
      fresh.close();
    }
  });

  test("rejects non-exact payloads, wrong private audiences, and legacy opening events atomically", () => {
    const database = createDatabase(48);
    try {
      seedReadinessFixture(database);
      const cases = [
        () => {
          const row = database
            .prepare(
              "SELECT payload_json FROM outbox_events WHERE id = ?"
            )
            .get(IDS.fadEvent);
          const payload = JSON.parse(row.payload_json);
          payload.related.unapproved = IDS.team;
          database
            .prepare(
              "UPDATE outbox_events SET payload_json = ? WHERE id = ?"
            )
            .run(JSON.stringify(payload), IDS.fadEvent);
        },
        () => {
          database
            .prepare(
              "UPDATE outbox_event_audiences SET team_id = ? " +
                "WHERE outbox_event_id = ?"
            )
            .run(IDS.otherTeam, IDS.cardEvent);
        },
        () => {
          database.pragma("ignore_check_constraints = ON");
          rawInsert(database, "outbox_events", {
            id: IDS.legacyEvent,
            league_id: IDS.league,
            event_type: "fad_cards_opened",
            aggregate_type: "free_agent_draft",
            aggregate_id: IDS.fad,
            payload_json: "{}",
            status: "pending",
            attempt_count: 0,
            available_at_ms: OPENED_AT_MS,
            created_at_ms: OPENED_AT_MS,
            updated_at_ms: OPENED_AT_MS,
            version: 1,
          });
          database.pragma("ignore_check_constraints = OFF");
        },
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const savepoint = "adversarial_" + index;
        database.exec("SAVEPOINT " + savepoint);
        try {
          cases[index]();
          assertReadinessRejected(database);
        } finally {
          database.exec(
            "ROLLBACK TO " +
              savepoint +
              "; RELEASE " +
              savepoint
          );
          database.pragma("ignore_check_constraints = OFF");
        }
      }
      assert.equal(completeReadiness(database).changes, 1);
    } finally {
      database.close();
    }
  });

  test("rolls back both trigger replacements and the ledger when 48 fails", () => {
    const database = createDatabase(47);
    try {
      const readinessBefore = triggerSql(
        database,
        READINESS_TRIGGER
      );
      const automaticBefore = triggerSql(
        database,
        AUTOMATIC_TRIGGER
      );
      const source = migrations(48);
      const migration48 = source.at(-1);
      const failedSql =
        migration48.sql +
        "\nSELECT definitely_missing_fad14_column FROM leagues;\n";
      const broken = {
        ...migration48,
        sql: failedSql,
        checksum: checksumBytes(Buffer.from(failedSql, "utf8")),
      };
      assert.throws(
        () =>
          applyMigrations({
            database,
            migrations: [...source.slice(0, -1), broken],
            applicationBuildId: "fad14-forced-rollback",
            now: () => 2_000,
          }),
        (error) =>
          error?.code === "MIGRATION_APPLY_FAILED" &&
          error?.details?.migrationId === 48
      );
      assert.equal(
        database.pragma("user_version", { simple: true }),
        47
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations"
          )
          .get().count,
        47
      );
      assert.equal(
        triggerSql(database, READINESS_TRIGGER),
        readinessBefore
      );
      assert.equal(
        triggerSql(database, AUTOMATIC_TRIGGER),
        automaticBefore
      );
    } finally {
      database.close();
    }
  });
});
