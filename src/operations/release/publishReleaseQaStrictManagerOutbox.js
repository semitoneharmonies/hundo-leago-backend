"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const {
  migrationChecksumSetId:
    calculateMigrationChecksumSetId,
} = require("../backups/createEncryptedOffsiteBackup");

const {
  parsePayload,
} = require(
  "../../application/services/activity/createLeagueOutboxPublicationService"
);
const {
  DEFAULT_CONTRACT: STRICT_RESTORE_CONTRACT,
} = require("./materializeReleaseQaStrictRestore");
const {
  EVENT_TYPE: STRICT_FIXTURE_EVENT_TYPE,
  FIXTURE_NAME,
  SIDE_CAR_IDS,
  receiptEventId,
} = require("./prepareReleaseQaFadPrivacyGate");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require("./releaseQaFixtureContract");

const CONTRACT_VERSION = 1;
const RESULT_CODE = "RELEASE_QA_STRICT_MANAGER_OUTBOX_PUBLISHED";
const REQUIRED_SCHEMA_VERSION = 54;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RECEIPT_REASON_PATTERN =
  /^strict_fad_privacy_gate_v1_[a-f0-9]{16}$/u;
const RELEASE_ID = STRICT_RESTORE_CONTRACT.releaseId;
const PHASES = Object.freeze({
  "team1-to-manager-b": Object.freeze({
    acceptingUserId: fixtureId("account:leagueAManagerTwo"),
    confirmation:
      `PUBLISH-${RELEASE_ID}-TEAM1-TO-MANAGER-B`,
    idempotencyKey:
      `${RELEASE_ID}-outbox-team1-to-manager-b`,
    proposalKey: `${RELEASE_ID}-team1-to-b-propose`,
    acceptanceKey: `${RELEASE_ID}-team1-to-b-accept`,
    expectedAssignmentCount: 5,
    expectedPublicationCount: 1,
  }),
  "team1-return-to-manager-a": Object.freeze({
    acceptingUserId: fixtureId("account:leagueAManagerOne"),
    confirmation:
      `PUBLISH-${RELEASE_ID}-TEAM1-RETURN-TO-MANAGER-A`,
    idempotencyKey:
      `${RELEASE_ID}-outbox-team1-return-to-manager-a`,
    proposalKey: `${RELEASE_ID}-team1-to-a-propose`,
    acceptanceKey: `${RELEASE_ID}-team1-to-a-accept`,
    expectedAssignmentCount: 6,
    expectedPublicationCount: 2,
  }),
});

const ERROR_CODES = Object.freeze({
  inputInvalid: "RELEASE_QA_STRICT_MANAGER_OUTBOX_INPUT_INVALID",
  denied: "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED",
  environmentUnsafe:
    "RELEASE_QA_STRICT_MANAGER_OUTBOX_ENVIRONMENT_UNSAFE",
  stateChanged: "RELEASE_QA_STRICT_MANAGER_OUTBOX_STATE_CHANGED",
  publicationFailed:
    "RELEASE_QA_STRICT_MANAGER_OUTBOX_PUBLICATION_FAILED",
  postcheckFailed:
    "RELEASE_QA_STRICT_MANAGER_OUTBOX_POSTCHECK_FAILED",
  inProgress: "RELEASE_QA_STRICT_MANAGER_OUTBOX_IN_PROGRESS",
});

class ReleaseQaStrictManagerOutboxError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA manager outbox publication failed safely.",
      options
    );
    this.name = "ReleaseQaStrictManagerOutboxError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaStrictManagerOutboxError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactInput(input, backendBuildId) {
  const expectedKeys = [
    "backendBuildId",
    "confirmation",
    "phase",
    "releaseId",
  ];
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    input.releaseId !== RELEASE_ID ||
    !Object.hasOwn(PHASES, input.phase) ||
    input.backendBuildId !== backendBuildId ||
    input.confirmation !== PHASES[input.phase].confirmation
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  return Object.freeze({ phase: input.phase, ...PHASES[input.phase] });
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function migrationChecksumSetId(migrationState) {
  if (
    migrationState?.status !== "exact" ||
    migrationState.userVersion !== REQUIRED_SCHEMA_VERSION ||
    !Array.isArray(migrationState.applied)
  ) {
    return null;
  }
  return calculateMigrationChecksumSetId(
    migrationState.applied.map(({ id, fileName, checksum }) => ({
      id,
      fileName,
      checksum,
    }))
  );
}

function runtimeBindingMatches({
  config,
  migrationState,
  contract = STRICT_RESTORE_CONTRACT,
} = {}) {
  return Boolean(
    config &&
      contract &&
      contract.releaseId === RELEASE_ID &&
      contract.environment === "staging" &&
      contract.environmentId === FIXTURE_ENVIRONMENT_ID &&
      contract.databaseId === FIXTURE_DATABASE_ID &&
      contract.schemaVersion === REQUIRED_SCHEMA_VERSION &&
      config.appEnv === contract.environment &&
      config.environmentId === contract.environmentId &&
      config.databaseId === contract.databaseId &&
      samePath(config.databasePath, contract.sourceDatabasePath) &&
      samePath(config.persistentRoot, contract.persistentRoot) &&
      config.frontendBuildId === contract.frontendBuildId &&
      SHA_PATTERN.test(config.buildId || "") &&
      config.currentSeason?.label === "2026" &&
      config.currentSeason?.nhlSeasonKey === "20262027" &&
      config.leagueWriteMode === "open" &&
      config.freeAgentDraftRoutesEnabled === true &&
      config.scheduledJobsEnabled === false &&
      config.accountEmailDeliveryEnabled === false &&
      config.debugRoutesEnabled === false &&
      config.backupScheduleEnabled === false &&
      config.stagingMaintenanceHoldEnabled === false &&
      config.security?.email?.deliveryMode === "capture" &&
      config.sportsDataIoNhl?.enabled === false &&
      config.sportsDataIoNhlImportFieldsAbsent === true &&
      config.sportsDataIoLiveNhl?.mode === "disabled" &&
      config.sportsDataIoLiveNhl?.enabled === false &&
      migrationChecksumSetId(migrationState) ===
        contract.migrationChecksumSetId
  );
}

function assertRuntimeBinding({ database, config, migrationState, contract }) {
  if (!runtimeBindingMatches({ config, migrationState, contract })) {
    fail(ERROR_CODES.environmentUnsafe);
  }
  let databaseList;
  let schemaVersion;
  try {
    databaseList = database.pragma("database_list");
    schemaVersion = database.pragma("user_version", { simple: true });
  } catch (error) {
    fail(ERROR_CODES.environmentUnsafe, error);
  }
  const main = databaseList.filter(({ name }) => name === "main");
  if (
    main.length !== 1 ||
    !samePath(main[0].file, contract.sourceDatabasePath) ||
    schemaVersion !== REQUIRED_SCHEMA_VERSION
  ) {
    fail(ERROR_CODES.environmentUnsafe);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function scopedSnapshot(database, column, value) {
  const tableRows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const snapshot = {};
  for (const { name } of tableRows) {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
      .all()
      .map(({ name: columnName }) => columnName);
    if (!columns.includes(column)) continue;
    snapshot[name] = database.prepare(
      `SELECT * FROM ${quoteIdentifier(name)} ` +
        `WHERE ${quoteIdentifier(column)} = ? ORDER BY rowid`
    ).all(value);
  }
  return JSON.stringify(snapshot);
}

function unrelatedOutboxSnapshot(database, eventId) {
  return JSON.stringify({
    events: database.prepare(`
      SELECT * FROM outbox_events WHERE id <> ?
      ORDER BY league_id, created_at_ms, id
    `).all(eventId),
    audiences: database.prepare(`
      SELECT * FROM outbox_event_audiences
      WHERE outbox_event_id <> ?
      ORDER BY league_id, outbox_event_id, id
    `).all(eventId),
  });
}

function jobSnapshot(database) {
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table'
      AND (
        name = 'job_runs' OR
        name LIKE '%job_binding%' OR
        name LIKE '%job_attempt%' OR
        name LIKE '%job_occurrence%'
      )
    ORDER BY name
  `).all();
  const snapshot = {};
  for (const { name } of tables) {
    snapshot[name] = database.prepare(
      `SELECT * FROM ${quoteIdentifier(name)} ORDER BY rowid`
    ).all();
  }
  return JSON.stringify(snapshot);
}

function commandHash(operation, values) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ operation, ...values }), "utf8")
    .digest("hex");
}

function assertReceipt(database, contract) {
  const expectedId = receiptEventId(contract.databaseId, contract.releaseId);
  const row = database.prepare(`
    SELECT * FROM security_audit_events WHERE id = ?
  `).get(expectedId);
  if (
    !row ||
    row.event_type !== STRICT_FIXTURE_EVENT_TYPE ||
    row.outcome !== "success" ||
    row.actor_user_id !== null ||
    row.target_user_id !== null ||
    row.league_id !== SIDE_CAR_IDS.leagueId ||
    row.session_id !== null ||
    row.request_correlation_id !== contract.releaseId ||
    !RECEIPT_REASON_PATTERN.test(row.reason_code || "")
  ) {
    fail(ERROR_CODES.stateChanged);
  }
  return row;
}

function assertFixtureRoot(database) {
  const league = database.prepare(`
    SELECT id, name, status, current_season_id
    FROM leagues WHERE id = ?
  `).get(SIDE_CAR_IDS.leagueId);
  const teams = database.prepare(`
    SELECT id, name, status FROM teams
    WHERE league_id = ? ORDER BY id
  `).all(SIDE_CAR_IDS.leagueId);
  if (
    !league ||
    league.name !== FIXTURE_NAME ||
    league.status !== "active" ||
    league.current_season_id !== SIDE_CAR_IDS.seasonId ||
    teams.length !== 4 ||
    teams.some(({ id, status }) =>
      !SIDE_CAR_IDS.teamIds.includes(id) || status !== "active"
    )
  ) {
    fail(ERROR_CODES.stateChanged);
  }
}

function assertIdempotency(database, {
  assignmentId,
  actorUserId,
  clientKey,
  operation,
  requestHash,
}) {
  const rows = database.prepare(`
    SELECT actor_user_id, operation, client_key, request_hash,
           status, result_type, result_id
    FROM idempotency_requests
    WHERE league_id = ? AND actor_user_id = ?
      AND operation = ? AND client_key = ?
  `).all(SIDE_CAR_IDS.leagueId, actorUserId, operation, clientKey);
  if (
    rows.length !== 1 ||
    rows[0].request_hash !== requestHash ||
    rows[0].status !== "completed" ||
    rows[0].result_type !== "team_manager_assignment" ||
    rows[0].result_id !== assignmentId
  ) {
    fail(ERROR_CODES.stateChanged);
  }
}

function parseActivityMetadata(value) {
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertTransferEvidence(database, assignment, replaced, phase) {
  const administrator = fixtureId("account:platformAdmin");
  assertIdempotency(database, {
    assignmentId: assignment.id,
    actorUserId: administrator,
    clientKey: phase.proposalKey,
    operation: "league.team_manager_assignment.propose.v1",
    requestHash: commandHash("league.team_manager_assignment.propose.v1", {
      leagueId: SIDE_CAR_IDS.leagueId,
      teamId: SIDE_CAR_IDS.teamIds[0],
      userId: assignment.user_id,
    }),
  });
  assertIdempotency(database, {
    assignmentId: assignment.id,
    actorUserId: assignment.user_id,
    clientKey: phase.acceptanceKey,
    operation: "league.team_manager_assignment.accept.v1",
    requestHash: commandHash("league.team_manager_assignment.accept.v1", {
      assignmentId: assignment.id,
    }),
  });
  const activities = database.prepare(`
    SELECT event_type, actor_user_id, actor_authority,
           related_type, related_id, metadata_json, occurred_at_ms
    FROM league_activity
    WHERE league_id = ? AND team_id = ? AND related_id = ?
      AND event_type IN (
        'team_manager_assignment_proposed',
        'team_manager_assignment_accepted'
      )
    ORDER BY occurred_at_ms, id
  `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[0], assignment.id);
  if (activities.length !== 2) fail(ERROR_CODES.stateChanged);
  const proposed = activities.find(
    ({ event_type: type }) => type === "team_manager_assignment_proposed"
  );
  const accepted = activities.find(
    ({ event_type: type }) => type === "team_manager_assignment_accepted"
  );
  for (const [activity, actor, authority, status] of [
    [proposed, administrator, "commissioner", "pending"],
    [accepted, assignment.user_id, "proposed_manager", "accepted"],
  ]) {
    const metadata = parseActivityMetadata(activity?.metadata_json);
    if (
      !activity ||
      activity.actor_user_id !== actor ||
      activity.actor_authority !== authority ||
      activity.related_type !== "team_manager_assignment" ||
      activity.occurred_at_ms > assignment.accepted_at_ms ||
      metadata?.assignmentId !== assignment.id ||
      metadata.status !== status ||
      metadata.teamId !== SIDE_CAR_IDS.teamIds[0] ||
      metadata.replacesAssignmentId !== replaced.id
    ) {
      fail(ERROR_CODES.stateChanged);
    }
  }
}

function assertInitialSupportAssignments(database, commissioner) {
  const expectedUsers = [
    fixtureId("account:leagueAManagerTwo"),
    fixtureId("account:leagueAManagerOne"),
    fixtureId("account:leagueAManagerTwo"),
  ];
  for (let index = 1; index < SIDE_CAR_IDS.teamIds.length; index += 1) {
    const rows = database.prepare(`
      SELECT assignment.*, membership.user_id AS membership_user_id,
             membership.permission_category, membership.status AS membership_status
      FROM team_manager_assignments AS assignment
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
      WHERE assignment.league_id = ? AND assignment.team_id = ?
    `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[index]);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row.user_id !== expectedUsers[index - 1] ||
      row.membership_user_id !== row.user_id ||
      row.permission_category !== "manager" ||
      row.membership_status !== "active" ||
      row.assigned_by_user_id !== commissioner ||
      row.replaces_assignment_id !== null ||
      row.status !== "accepted" ||
      row.accepted_at_ms === null ||
      row.ended_at_ms !== null ||
      row.version !== 1
    ) {
      fail(ERROR_CODES.stateChanged);
    }
  }
}

function assertAssignmentChain(database, phase) {
  const managerA = fixtureId("account:leagueAManagerOne");
  const managerB = fixtureId("account:leagueAManagerTwo");
  const administrator = fixtureId("account:platformAdmin");
  const commissioner = fixtureId("account:leagueACommissioner");
  const rows = database.prepare(`
    SELECT assignment.*, membership.user_id AS membership_user_id,
           membership.permission_category, membership.status AS membership_status
    FROM team_manager_assignments AS assignment
    JOIN league_memberships AS membership
      ON membership.league_id = assignment.league_id
     AND membership.id = assignment.membership_id
    WHERE assignment.league_id = ? AND assignment.team_id = ?
    ORDER BY assignment.assigned_at_ms, assignment.id
  `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[0]);
  const total = database.prepare(`
    SELECT COUNT(*) AS count FROM team_manager_assignments WHERE league_id = ?
  `).get(SIDE_CAR_IDS.leagueId).count;
  const initialA = rows.find(({ replaces_assignment_id: id }) => id === null);
  const transferB = rows.find(
    ({ user_id: userId, replaces_assignment_id: id }) =>
      userId === managerB && id === initialA?.id
  );
  const returnedA = rows.find(
    ({ user_id: userId, replaces_assignment_id: id }) =>
      userId === managerA && id === transferB?.id
  );
  if (
    total !== phase.expectedAssignmentCount ||
    rows.length !== phase.expectedAssignmentCount - 3 ||
    !initialA ||
    initialA.user_id !== managerA ||
    initialA.membership_user_id !== managerA ||
    initialA.assigned_by_user_id !== commissioner ||
    initialA.status !== "ended" ||
    initialA.accepted_at_ms === null ||
    initialA.ended_at_ms !== transferB?.accepted_at_ms ||
    initialA.version !== 2 ||
    !transferB ||
    transferB.membership_user_id !== managerB ||
    transferB.assigned_by_user_id !== administrator ||
    transferB.replaces_assignment_id !== initialA.id ||
    transferB.accepted_at_ms === null
  ) {
    fail(ERROR_CODES.stateChanged);
  }
  assertTransferEvidence(database, transferB, initialA, PHASES["team1-to-manager-b"]);
  assertInitialSupportAssignments(database, commissioner);
  if (phase.phase === "team1-to-manager-b") {
    if (
      returnedA ||
      transferB.status !== "accepted" ||
      transferB.ended_at_ms !== null ||
      transferB.version !== 2
    ) {
      fail(ERROR_CODES.stateChanged);
    }
    return transferB;
  }
  if (
    !returnedA ||
    transferB.status !== "ended" ||
    transferB.ended_at_ms !== returnedA.accepted_at_ms ||
    transferB.version !== 3 ||
    returnedA.membership_user_id !== managerA ||
    returnedA.assigned_by_user_id !== administrator ||
    returnedA.status !== "accepted" ||
    returnedA.accepted_at_ms < transferB.accepted_at_ms ||
    returnedA.ended_at_ms !== null ||
    returnedA.version !== 2
  ) {
    fail(ERROR_CODES.stateChanged);
  }
  assertTransferEvidence(
    database,
    returnedA,
    transferB,
    PHASES["team1-return-to-manager-a"]
  );
  return returnedA;
}

function assertPublication(database, assignment, phase) {
  const rows = database.prepare(`
    SELECT * FROM outbox_events
    WHERE league_id = ?
      AND event_type = 'team.changed'
      AND aggregate_type = 'team_manager_assignment'
    ORDER BY created_at_ms, id
  `).all(SIDE_CAR_IDS.leagueId);
  if (rows.length !== phase.expectedPublicationCount) {
    fail(ERROR_CODES.stateChanged);
  }
  let target = null;
  for (const row of rows) {
    let payload;
    try {
      payload = parsePayload(row);
    } catch (error) {
      fail(ERROR_CODES.stateChanged, error);
    }
    const audiences = database.prepare(`
      SELECT id, league_id, outbox_event_id, audience_kind,
             team_id, user_id, created_at_ms
      FROM outbox_event_audiences
      WHERE outbox_event_id = ? AND league_id = ?
    `).all(row.id, SIDE_CAR_IDS.leagueId);
    if (
      payload.eventId !== row.id ||
      payload.type !== "team.changed" ||
      payload.leagueId !== SIDE_CAR_IDS.leagueId ||
      payload.resourceId !== row.aggregate_id ||
      payload.version !== 2 ||
      payload.reasonCode !== "manager_assignment_changed" ||
      payload.occurredAt !== row.created_at_ms ||
      payload.related?.teamId !== SIDE_CAR_IDS.teamIds[0] ||
      audiences.length !== 1 ||
      audiences[0].id !== row.id ||
      audiences[0].outbox_event_id !== row.id ||
      audiences[0].audience_kind !== "league" ||
      audiences[0].league_id !== SIDE_CAR_IDS.leagueId ||
      audiences[0].team_id !== null ||
      audiences[0].user_id !== null ||
      audiences[0].created_at_ms !== row.created_at_ms
    ) {
      fail(ERROR_CODES.stateChanged);
    }
    if (row.aggregate_id === assignment.id) target = row;
    else if (
      phase.phase !== "team1-return-to-manager-a" ||
      row.status !== "published" ||
      row.attempt_count !== 1 ||
      row.published_at_ms === null ||
      row.last_error_code !== null ||
      row.version !== 3
    ) {
      fail(ERROR_CODES.stateChanged);
    }
  }
  if (
    !target ||
    target.created_at_ms !== assignment.accepted_at_ms ||
    target.available_at_ms !== target.created_at_ms ||
    ![
      "pending",
      "published",
    ].includes(target.status) ||
    (target.status === "pending" &&
      (target.attempt_count !== 0 ||
        target.published_at_ms !== null ||
        target.last_error_code !== null ||
        target.version !== 1)) ||
    (target.status === "published" &&
      (target.attempt_count !== 1 ||
        target.published_at_ms === null ||
        target.last_error_code !== null ||
        target.version !== 3))
  ) {
    fail(ERROR_CODES.stateChanged);
  }
  return target;
}

function assertNoPublishingRows(database) {
  const count = database.prepare(`
    SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'publishing'
  `).get().count;
  if (count !== 0) fail(ERROR_CODES.stateChanged);
}

function assertCaller(authenticated, phase) {
  if (
    authenticated?.valid !== true ||
    authenticated.user?.id !== phase.acceptingUserId ||
    authenticated.session?.userId !== phase.acceptingUserId
  ) {
    fail(ERROR_CODES.denied);
  }
}

function createReleaseQaStrictManagerOutboxService({
  database,
  config,
  migrationState,
  outboxPublicationService,
  contract = STRICT_RESTORE_CONTRACT,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.pragma !== "function" ||
    !outboxPublicationService ||
    typeof outboxPublicationService.publishExact !== "function"
  ) {
    throw new TypeError(
      "strict manager outbox publication requires database and canonical publication adapters"
    );
  }
  let running = false;

  async function publish({ input, idempotencyKey, authenticated } = {}) {
    if (running) fail(ERROR_CODES.inProgress);
    assertRuntimeBinding({ database, config, migrationState, contract });
    const phase = exactInput(input, config.buildId);
    if (idempotencyKey !== phase.idempotencyKey) {
      fail(ERROR_CODES.inputInvalid);
    }
    assertCaller(authenticated, phase);
    running = true;
    try {
      assertRuntimeBinding({ database, config, migrationState, contract });
      assertReceipt(database, contract);
      assertFixtureRoot(database);
      assertNoPublishingRows(database);
      const assignment = assertAssignmentChain(database, phase);
      const target = assertPublication(database, assignment, phase);
      if (target.status === "published") {
        const changesBeforeReplay = database.prepare(
          "SELECT total_changes() AS count"
        ).get().count;
        const replay = await outboxPublicationService.publishExact({
          eventId: target.id,
          leagueId: SIDE_CAR_IDS.leagueId,
          expectedVersion: target.version,
        });
        if (
          replay?.outcome !== "already_published" ||
          database.prepare("SELECT total_changes() AS count").get().count !==
            changesBeforeReplay
        ) {
          fail(ERROR_CODES.postcheckFailed);
        }
        return Object.freeze({
          code: RESULT_CODE,
          contractVersion: CONTRACT_VERSION,
          releaseId: RELEASE_ID,
          phase: phase.phase,
          environmentId: config.environmentId,
          databaseId: config.databaseId,
          schemaVersion: REQUIRED_SCHEMA_VERSION,
          backendBuildId: config.buildId,
          frontendBuildId: config.frontendBuildId,
          leagueId: SIDE_CAR_IDS.leagueId,
          teamId: SIDE_CAR_IDS.teamIds[0],
          assignmentId: assignment.id,
          eventId: target.id,
          outcome: "published",
          replayed: true,
          databaseWriteCount: 0,
          schedulerRemainedDisabled: true,
        });
      }

      const gammaLeagueId = fixtureId("fad-browser-v4:league:gamma");
      const before = Object.freeze({
        gamma: scopedSnapshot(database, "league_id", gammaLeagueId),
        teamTwo: scopedSnapshot(database, "team_id", SIDE_CAR_IDS.teamIds[1]),
        jobs: jobSnapshot(database),
        unrelatedOutbox: unrelatedOutboxSnapshot(database, target.id),
      });
      const changesBefore = database.prepare(
        "SELECT total_changes() AS count"
      ).get().count;
      const outcome = await outboxPublicationService.publishExact({
        eventId: target.id,
        leagueId: SIDE_CAR_IDS.leagueId,
        expectedVersion: target.version,
      });
      if (outcome?.outcome !== "published") {
        fail(ERROR_CODES.publicationFailed);
      }
      const persisted = assertPublication(database, assignment, phase);
      assertNoPublishingRows(database);
      assertRuntimeBinding({ database, config, migrationState, contract });
      const databaseWriteCount =
        database.prepare("SELECT total_changes() AS count").get().count -
        changesBefore;
      const after = Object.freeze({
        gamma: scopedSnapshot(database, "league_id", gammaLeagueId),
        teamTwo: scopedSnapshot(database, "team_id", SIDE_CAR_IDS.teamIds[1]),
        jobs: jobSnapshot(database),
        unrelatedOutbox: unrelatedOutboxSnapshot(database, target.id),
      });
      if (
        persisted.status !== "published" ||
        persisted.attempt_count !== 1 ||
        persisted.version !== 3 ||
        persisted.published_at_ms === null ||
        persisted.last_error_code !== null ||
        databaseWriteCount !== 2 ||
        JSON.stringify(after) !== JSON.stringify(before) ||
        database.pragma("foreign_key_check").length !== 0 ||
        database.pragma("integrity_check", { simple: true }) !== "ok"
      ) {
        fail(ERROR_CODES.postcheckFailed);
      }
      return Object.freeze({
        code: RESULT_CODE,
        contractVersion: CONTRACT_VERSION,
        releaseId: RELEASE_ID,
        phase: phase.phase,
        environmentId: config.environmentId,
        databaseId: config.databaseId,
        schemaVersion: REQUIRED_SCHEMA_VERSION,
        backendBuildId: config.buildId,
        frontendBuildId: config.frontendBuildId,
        leagueId: SIDE_CAR_IDS.leagueId,
        teamId: SIDE_CAR_IDS.teamIds[0],
        assignmentId: assignment.id,
        eventId: target.id,
        outcome: "published",
        replayed: false,
        databaseWriteCount,
        schedulerRemainedDisabled: true,
      });
    } finally {
      running = false;
    }
  }

  return Object.freeze({ publish });
}

module.exports = {
  CONTRACT_VERSION,
  ERROR_CODES,
  PHASES,
  RELEASE_ID,
  RESULT_CODE,
  ReleaseQaStrictManagerOutboxError,
  createReleaseQaStrictManagerOutboxService,
  migrationChecksumSetId,
  runtimeBindingMatches,
};
