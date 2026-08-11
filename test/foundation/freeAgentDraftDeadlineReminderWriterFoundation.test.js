const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  buildFreeAgentDraftReminderOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createSqliteFreeAgentDraftDeadlineReminderWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftDeadlineReminderWriter"
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
  readiness: uuid(4),
  job: uuid(5),
  leaseToken: uuid(6),
  currentUser: uuid(10),
  currentMembership: uuid(11),
  oldUser: uuid(12),
  oldMembership: uuid(13),
  teamOne: uuid(20),
  teamTwo: uuid(21),
  teamThree: uuid(22),
  cardOne: uuid(30),
  cardTwo: uuid(31),
  cardThree: uuid(32),
  participantOne: uuid(40),
  participantTwo: uuid(41),
  participantThree: uuid(42),
  assignmentOne: uuid(50),
  assignmentTwo: uuid(51),
  oldAssignment: uuid(52),
});
const REMINDER_AT_MS = Date.parse(
  "2027-08-29T07:00:00.000Z"
);
const DEADLINE_AT_MS =
  REMINDER_AT_MS + 72 * 60 * 60 * 1000;
const CLAIMED_AT_MS = REMINDER_AT_MS + 100;
const EXECUTED_AT_MS = CLAIMED_AT_MS + 100;
const LEASE_EXPIRES_AT_MS =
  CLAIMED_AT_MS + 60_000;
const LEASE_OWNER = "fad-reminder-worker";
const OCCURRENCE_KEY =
  buildFreeAgentDraftReminderOccurrenceKey({
    fadId: IDS.fad,
    reminderAtMs: REMINDER_AT_MS,
  });

function createSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    ) STRICT;

    CREATE TABLE leagues (
      id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TABLE league_memberships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at_ms INTEGER
    ) STRICT;

    CREATE TABLE team_manager_assignments (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at_ms INTEGER,
      ended_at_ms INTEGER
    ) STRICT;

    CREATE TABLE free_agent_draft_readiness_operations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_fad_id TEXT,
      reminder_job_run_id TEXT
    ) STRICT;

    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      readiness_operation_id TEXT NOT NULL,
      readiness_occurrence_key TEXT NOT NULL,
      participating_team_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      candidate_deadline_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE free_agent_draft_teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE candidate_cards (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      completeness_code TEXT NOT NULL,
      missing_mandatory_count INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE job_runs (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_for_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at_ms INTEGER,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      result_json TEXT,
      last_error_code TEXT,
      next_attempt_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      league_id TEXT,
      event_type TEXT NOT NULL,
      message_data_json TEXT NOT NULL,
      related_feature TEXT,
      related_record_id TEXT,
      delivery_status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      read_at_ms INTEGER,
      delivered_at_ms INTEGER,
      version INTEGER NOT NULL,
      deduplication_key TEXT
    ) STRICT;

    CREATE UNIQUE INDEX notifications_deduplication
      ON notifications (
        user_id,
        event_type,
        deduplication_key
      )
      WHERE deduplication_key IS NOT NULL;

    CREATE TABLE outbox_events (
      id TEXT PRIMARY KEY,
      league_id TEXT,
      event_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      available_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE outbox_event_audiences (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      outbox_event_id TEXT NOT NULL,
      audience_kind TEXT NOT NULL,
      team_id TEXT,
      user_id TEXT,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX outbox_one_user_audience
      ON outbox_event_audiences (
        league_id,
        outbox_event_id,
        user_id
      )
      WHERE audience_kind = 'user';
  `);
}

function seed(database) {
  database
    .prepare("INSERT INTO leagues (id) VALUES (?)")
    .run(IDS.league);
  const insertUser = database.prepare(
    "INSERT INTO users (id, status) VALUES (?, 'active')"
  );
  insertUser.run(IDS.currentUser);
  insertUser.run(IDS.oldUser);
  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, status,
      ended_at_ms
    ) VALUES (?, ?, ?, ?, ?)
  `);
  insertMembership.run(
    IDS.currentMembership,
    IDS.league,
    IDS.currentUser,
    "active",
    null
  );
  insertMembership.run(
    IDS.oldMembership,
    IDS.league,
    IDS.oldUser,
    "ended",
    REMINDER_AT_MS - 1
  );
  const insertAssignment = database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id,
      membership_id, status, accepted_at_ms,
      ended_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAssignment.run(
    IDS.oldAssignment,
    IDS.league,
    IDS.teamOne,
    IDS.oldUser,
    IDS.oldMembership,
    "ended",
    REMINDER_AT_MS - 1_000,
    REMINDER_AT_MS - 1
  );
  insertAssignment.run(
    IDS.assignmentOne,
    IDS.league,
    IDS.teamOne,
    IDS.currentUser,
    IDS.currentMembership,
    "accepted",
    REMINDER_AT_MS - 1_000,
    null
  );
  insertAssignment.run(
    IDS.assignmentTwo,
    IDS.league,
    IDS.teamTwo,
    IDS.currentUser,
    IDS.currentMembership,
    "accepted",
    REMINDER_AT_MS - 1_000,
    null
  );

  database
    .prepare(`
      INSERT INTO free_agent_draft_readiness_operations (
        id, league_id, season_id,
        readiness_occurrence_key, status,
        created_fad_id, reminder_job_run_id
      ) VALUES (?, ?, ?, ?, 'succeeded', ?, ?)
    `)
    .run(
      IDS.readiness,
      IDS.league,
      IDS.season,
      "readiness-occurrence",
      IDS.fad,
      IDS.job
    );
  database
    .prepare(`
      INSERT INTO free_agent_drafts (
        id, league_id, season_id,
        readiness_operation_id,
        readiness_occurrence_key,
        participating_team_count, status,
        candidate_deadline_at_ms
      ) VALUES (?, ?, ?, ?, ?, 3, 'cards_open', ?)
    `)
    .run(
      IDS.fad,
      IDS.league,
      IDS.season,
      IDS.readiness,
      "readiness-occurrence",
      DEADLINE_AT_MS
    );

  const insertParticipant = database.prepare(`
    INSERT INTO free_agent_draft_teams (
      id, league_id, season_id, fad_id,
      team_id
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertCard = database.prepare(`
    INSERT INTO candidate_cards (
      id, league_id, season_id, fad_id,
      team_id, status, completeness_code,
      missing_mandatory_count
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
  `);
  for (const participant of [
    {
      id: IDS.participantOne,
      teamId: IDS.teamOne,
      cardId: IDS.cardOne,
      completeness: "complete",
      missing: 0,
    },
    {
      id: IDS.participantTwo,
      teamId: IDS.teamTwo,
      cardId: IDS.cardTwo,
      completeness: "incomplete",
      missing: 2,
    },
    {
      id: IDS.participantThree,
      teamId: IDS.teamThree,
      cardId: IDS.cardThree,
      completeness: "conflicted",
      missing: 4,
    },
  ]) {
    insertParticipant.run(
      participant.id,
      IDS.league,
      IDS.season,
      IDS.fad,
      participant.teamId
    );
    insertCard.run(
      participant.cardId,
      IDS.league,
      IDS.season,
      IDS.fad,
      participant.teamId,
      participant.completeness,
      participant.missing
    );
  }

  database
    .prepare(`
      INSERT INTO job_runs (
        id, league_id, season_id, job_type,
        occurrence_key, scheduled_for_ms,
        status, attempt_count, lease_owner,
        lease_token, lease_expires_at_ms,
        started_at_ms, completed_at_ms,
        result_json, last_error_code,
        next_attempt_at_ms, created_at_ms,
        updated_at_ms, version
      ) VALUES (
        ?, ?, ?, 'fad_deadline_reminder',
        ?, ?, 'running', 1, ?, ?, ?, ?,
        NULL, NULL, NULL, NULL, ?, ?, 2
      )
    `)
    .run(
      IDS.job,
      IDS.league,
      IDS.season,
      OCCURRENCE_KEY,
      REMINDER_AT_MS,
      LEASE_OWNER,
      IDS.leaseToken,
      LEASE_EXPIRES_AT_MS,
      CLAIMED_AT_MS,
      REMINDER_AT_MS,
      CLAIMED_AT_MS
    );
}

function command(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    reminderAtMs: REMINDER_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: REMINDER_AT_MS,
    executedAtMs: EXECUTED_AT_MS,
    jobExecution: {
      runId: IDS.job,
      leaseOwner: LEASE_OWNER,
      leaseToken: IDS.leaseToken,
      leaseExpiresAtMs: LEASE_EXPIRES_AT_MS,
      expectedVersion: 2,
    },
    ...overrides,
  };
}

function fixture(t, { beforeCommit } = {}) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad-deadline-reminder-"
    )
  );
  const { database } = openDatabase({
    databasePath: path.join(root, "test.sqlite3"),
    environment: "test",
  });
  createSchema(database);
  seed(database);
  t.after(() => {
    database.close();
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return {
    database,
    writer:
      createSqliteFreeAgentDraftDeadlineReminderWriter({
        database,
        beforeCommit,
      }),
  };
}

function count(database, tableName) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName}`
    )
    .get().count;
}

describe(
  "SQLite Free Agent Draft deadline-reminder writer foundation",
  () => {
    test("atomically reminds each current manager/team pair with private completeness data and one user invalidation audience", (t) => {
      const { database, writer } = fixture(t);

      const result = writer.executeClaimed(command());

      assert.equal(result.outcome, "succeeded");
      assert.equal(result.sentCount, 2);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.reasonCode, null);
      assert.equal(result.notificationIds.length, 2);
      assert.ok(result.outboxEventId);

      const notifications = database
        .prepare(`
          SELECT *
          FROM notifications
          ORDER BY deduplication_key
        `)
        .all();
      assert.equal(notifications.length, 2);
      assert.equal(
        notifications.every(
          ({ user_id: userId }) =>
            userId === IDS.currentUser
        ),
        true
      );
      assert.equal(
        notifications.some(
          ({ user_id: userId }) =>
            userId === IDS.oldUser
        ),
        false
      );
      assert.deepEqual(
        notifications.map(
          ({ deduplication_key: key }) => key
        ),
        [
          `fad:${IDS.fad}:deadline-reminder:${IDS.teamOne}:${IDS.currentUser}`,
          `fad:${IDS.fad}:deadline-reminder:${IDS.teamTwo}:${IDS.currentUser}`,
        ]
      );
      const messages = notifications.map(
        ({ message_data_json: json }) =>
          JSON.parse(json)
      );
      assert.deepEqual(
        messages.map(
          ({
            teamId,
            completenessCode,
            missingMandatoryCount,
          }) => ({
            teamId,
            completenessCode,
            missingMandatoryCount,
          })
        ),
        [
          {
            teamId: IDS.teamOne,
            completenessCode: "complete",
            missingMandatoryCount: 0,
          },
          {
            teamId: IDS.teamTwo,
            completenessCode: "incomplete",
            missingMandatoryCount: 2,
          },
        ]
      );
      for (const message of messages) {
        assert.deepEqual(message.destination, {
          kind: "private_card",
          leagueId: IDS.league,
          fadId: IDS.fad,
          teamId: message.teamId,
          cardId: message.cardId,
        });
        assert.equal(
          Object.hasOwn(message, "playerId"),
          false
        );
        assert.equal(
          Object.hasOwn(message, "contract"),
          false
        );
      }

      const outbox = database
        .prepare(`
          SELECT event.*, notification.message_data_json
          FROM outbox_events AS event
          JOIN notifications AS notification
            ON notification.id = event.aggregate_id
          ORDER BY event.aggregate_id
        `)
        .all();
      assert.equal(outbox.length, 2);
      for (const event of outbox) {
        const payload = JSON.parse(event.payload_json);
        const message = JSON.parse(event.message_data_json);
        assert.equal(event.event_type, "notification.created");
        assert.equal(event.aggregate_type, "notification");
        assert.equal(payload.eventId, event.id);
        assert.equal(payload.type, "notification.created");
        assert.equal(payload.leagueId, IDS.league);
        assert.equal(payload.resourceId, event.aggregate_id);
        assert.equal(payload.version, 1);
        assert.equal(payload.reasonCode, "notification_created");
        assert.equal(payload.occurredAt, EXECUTED_AT_MS);
        assert.equal(payload.related.fadId, IDS.fad);
        assert.equal(payload.related.teamId, message.teamId);
        assert.equal(payload.related.cardId, message.cardId);
        assert.equal(Object.keys(payload.related).length, 8);
      }
      assert.deepEqual(
        database
          .prepare(`
            SELECT audience_kind, team_id, user_id
            FROM outbox_event_audiences
          `)
          .all(),
        [
          {
            audience_kind: "user",
            team_id: null,
            user_id: IDS.currentUser,
          },
          {
            audience_kind: "user",
            team_id: null,
            user_id: IDS.currentUser,
          },
        ]
      );

      const job = database
        .prepare(
          "SELECT * FROM job_runs WHERE id = ?"
        )
        .get(IDS.job);
      assert.equal(job.status, "succeeded");
      assert.equal(job.version, 3);
      assert.equal(job.lease_owner, null);
      assert.equal(job.lease_token, null);
      assert.equal(job.completed_at_ms, EXECUTED_AT_MS);
      assert.deepEqual(JSON.parse(job.result_json), {
        schemaVersion: 1,
        code: "FAD_DEADLINE_REMINDERS_SENT",
        sentCount: 2,
        skippedCount: 1,
        reasonCode: null,
      });
    });

    test("skips an accepted-status assignment without acceptance evidence and creates no private reminder publication for it", (t) => {
      const { database, writer } = fixture(t);
      database.prepare(`
        UPDATE team_manager_assignments
        SET accepted_at_ms = NULL
        WHERE id = @assignmentId
          AND status = 'accepted'
      `).run({ assignmentId: IDS.assignmentTwo });

      const result = writer.executeClaimed(command());

      assert.equal(result.outcome, "succeeded");
      assert.equal(result.sentCount, 1);
      assert.equal(result.skippedCount, 2);
      assert.equal(result.reasonCode, null);
      assert.equal(result.notificationIds.length, 1);
      assert.ok(result.outboxEventId);
      assert.deepEqual(
        database.prepare(`
          SELECT
            user_id,
            json_extract(message_data_json, '$.teamId')
              AS team_id
          FROM notifications
          WHERE event_type = 'fad_deadline_approaching'
          ORDER BY id
        `).all(),
        [
          {
            user_id: IDS.currentUser,
            team_id: IDS.teamOne,
          },
        ]
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM notifications
          WHERE event_type = 'fad_deadline_approaching'
            AND json_extract(
              message_data_json,
              '$.teamId'
            ) = @teamId
        `).get({ teamId: IDS.teamTwo }).count,
        0
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_events AS event
          JOIN notifications AS notification
            ON notification.id = event.aggregate_id
          WHERE event.event_type = 'notification.created'
            AND json_extract(
              notification.message_data_json,
              '$.teamId'
            ) = @teamId
        `).get({ teamId: IDS.teamTwo }).count,
        0
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_event_audiences AS audience
          JOIN outbox_events AS event
            ON event.id = audience.outbox_event_id
          JOIN notifications AS notification
            ON notification.id = event.aggregate_id
          WHERE audience.audience_kind = 'user'
            AND json_extract(
              notification.message_data_json,
              '$.teamId'
            ) = @teamId
        `).get({ teamId: IDS.teamTwo }).count,
        0
      );
      assert.equal(count(database, "outbox_events"), 1);
      assert.equal(
        count(database, "outbox_event_audiences"),
        1
      );
      assert.deepEqual(
        JSON.parse(
          database.prepare(`
            SELECT result_json
            FROM job_runs
            WHERE id = @jobRunId
          `).get({ jobRunId: IDS.job }).result_json
        ),
        {
          schemaVersion: 1,
          code: "FAD_DEADLINE_REMINDERS_SENT",
          sentCount: 1,
          skippedCount: 2,
          reasonCode: null,
        }
      );
    });

    test("terminally skips without side effects at or after the authoritative deadline", async (t) => {
      for (const [label, executedAtMs] of [
        ["exact deadline", DEADLINE_AT_MS],
        ["one millisecond overdue", DEADLINE_AT_MS + 1],
      ]) {
        await t.test(label, (boundaryTest) => {
          const { database, writer } =
            fixture(boundaryTest);
          database
            .prepare(`
              UPDATE job_runs
              SET lease_expires_at_ms = ?
              WHERE id = ?
            `)
            .run(DEADLINE_AT_MS + 60_000, IDS.job);

          const result = writer.executeClaimed(
            command({
              executedAtMs,
              jobExecution: {
                ...command().jobExecution,
                leaseExpiresAtMs:
                  DEADLINE_AT_MS + 60_000,
              },
            })
          );

          assert.deepEqual(
            {
              outcome: result.outcome,
              sentCount: result.sentCount,
              skippedCount: result.skippedCount,
              reasonCode: result.reasonCode,
              notificationIds:
                result.notificationIds,
              outboxEventId: result.outboxEventId,
            },
            {
              outcome: "skipped",
              sentCount: 0,
              skippedCount: 3,
              reasonCode: "deadline_reached",
              notificationIds: [],
              outboxEventId: null,
            }
          );
          assert.equal(
            count(database, "notifications"),
            0
          );
          assert.equal(
            count(database, "outbox_events"),
            0
          );
          assert.equal(
            database
              .prepare(
                "SELECT status FROM job_runs WHERE id = ?"
              )
              .get(IDS.job).status,
            "skipped"
          );
        });
      }
    });

    test("terminally skips when cards were already locked or the FAD completed", (t) => {
      const locked = fixture(t);
      locked.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'deadline_locked'
          WHERE id = ?
        `)
        .run(IDS.fad);
      const lockedResult =
        locked.writer.executeClaimed(command());
      assert.equal(
        lockedResult.reasonCode,
        "cards_locked"
      );
      assert.equal(
        count(locked.database, "notifications"),
        0
      );

      const completed = fixture(t);
      completed.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed'
          WHERE id = ?
        `)
        .run(IDS.fad);
      const completedResult =
        completed.writer.executeClaimed(command());
      assert.equal(
        completedResult.reasonCode,
        "fad_completed"
      );
      assert.equal(
        count(completed.database, "outbox_events"),
        0
      );
    });

    test("fences stale lease/version commands before notifications or terminal writes", (t) => {
      const { database, writer } = fixture(t);

      assert.throws(() =>
        writer.executeClaimed(
          command({
            executedAtMs: REMINDER_AT_MS - 1,
          })
        )
      );
      assert.throws(() =>
        writer.executeClaimed(
          command({
            jobExecution: {
              ...command().jobExecution,
              leaseToken: uuid(999),
            },
          })
        )
      );

      assert.equal(count(database, "notifications"), 0);
      assert.equal(count(database, "outbox_events"), 0);
      const job = database
        .prepare(
          "SELECT status, version FROM job_runs WHERE id = ?"
        )
        .get(IDS.job);
      assert.deepEqual(job, {
        status: "running",
        version: 2,
      });
    });

    test("rolls notification, outbox, and terminal job evidence back together after a late failure", (t) => {
      const { database, writer } = fixture(t, {
        beforeCommit() {
          throw new Error(
            "forced-deadline-reminder-late-failure"
          );
        },
      });

      assert.throws(
        () => writer.executeClaimed(command()),
        (error) => {
          assert.equal(
            error.cause?.message,
            "forced-deadline-reminder-late-failure"
          );
          return true;
        }
      );
      assert.equal(count(database, "notifications"), 0);
      assert.equal(count(database, "outbox_events"), 0);
      assert.equal(
        count(database, "outbox_event_audiences"),
        0
      );
      const job = database
        .prepare(
          "SELECT status, completed_at_ms, result_json, version FROM job_runs WHERE id = ?"
        )
        .get(IDS.job);
      assert.deepEqual(job, {
        status: "running",
        completed_at_ms: null,
        result_json: null,
        version: 2,
      });
    });
  }
);
