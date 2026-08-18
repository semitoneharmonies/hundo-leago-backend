const crypto = require("node:crypto");

const {
  RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
  RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
} = require("../../../domain/leagues/resetOriginalLeagueBootstrapPolicy");
const {
  canonicalize,
} = require("../../migration/sourceInventory");
const {
  assertResetOriginalLeagueContinuityBaselineMatches,
} = require("../../migration/resetOriginalLeagueContinuityEvidence");
const {
  tableSemanticHash,
} = require("../../migration/runJsonImport");
const {
  REPOSITORY_CATALOG,
} = require("./repositoryCatalog");
const {
  SqliteRepositoryError,
  mapRepositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMINISTRATOR_SETUP_LIFETIME_MS =
  72 * 60 * 60 * 1000;
const REQUIRED_APPLICATION_TABLE_COUNT = 132;
const REQUIRED_SCHEMA_VERSION = 52;
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID =
  "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID";
const IMPORTED_TABLES = Object.freeze([
  "players",
  "player_external_ids",
  "player_source_state",
]);
const FIRST_ADMINISTRATOR_TABLES = Object.freeze([
  "account_action_tokens",
  "outbox_events",
  "platform_roles",
  "security_audit_events",
  "users",
]);
const PROTECTED_UNCHANGED_TABLES = Object.freeze([
  "account_action_tokens",
  "application_metadata",
  "outbox_events",
  "platform_roles",
  "player_external_ids",
  "player_source_state",
  "players",
  "users",
]);
const ORDER_COLUMNS = Object.freeze({
  account_action_tokens: "id",
  application_metadata: "metadata_key",
  idempotency_requests: "id",
  league_activity: "id",
  league_settings: "league_id",
  leagues: "id",
  outbox_events: "id",
  platform_roles: "id",
  player_external_ids: "id",
  player_source_state: "id",
  players: "id",
  security_audit_events: "id",
  seasons: "id",
  users: "id",
});
const COMPLETED_BOOTSTRAP_TABLES = Object.freeze([
  "idempotency_requests",
  "league_activity",
  "league_settings",
  "leagues",
  "seasons",
]);

class ResetOriginalLeagueBootstrapStateError
  extends SqliteRepositoryError {
  constructor(options = {}) {
    super(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID,
      "The reset original-league bootstrap state is invalid.",
      options
    );
    this.name =
      "ResetOriginalLeagueBootstrapStateError";
    this.code =
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID;
  }
}

function fail(options) {
  throw new ResetOriginalLeagueBootstrapStateError(
    options
  );
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex");
}

function exactObject(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    fail();
  }
  return value;
}

function canonicalBase64Url(value, byteLength) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    fail();
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail();
  }
  if (
    decoded.length !== byteLength ||
    decoded.toString("base64url") !== value
  ) {
    fail();
  }
}

function freezeSnapshot(value) {
  if (
    value &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(freezeSnapshot);
    Object.freeze(value);
  }
  return value;
}

function createSqliteResetOriginalLeagueBootstrapRepository({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.pragma !== "function"
  ) {
    throw new TypeError(
      "reset original-league bootstrap requires an opened SQLite database"
    );
  }

  const tableNames = REPOSITORY_CATALOG.map(
    ({ tableName }) => tableName
  ).sort();
  const pristineStates = new WeakSet();
  const countStatements = {};
  const protectedStatements = {};
  const completedBootstrapStatements = {};
  let schemaInventoryStatement;
  let usersStatement;
  let rolesStatement;
  let tokensStatement;
  let outboxStatement;
  let auditStatement;
  let metadataStatement;
  let migrationLedgerStatement;
  try {
    schemaInventoryStatement = database.prepare(
      "SELECT name FROM sqlite_schema " +
        "WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' " +
        "AND name <> 'schema_migrations' " +
        "ORDER BY name ASC"
    );
    for (const tableName of tableNames) {
      countStatements[tableName] = database.prepare(
        `SELECT COUNT(*) AS count FROM "${tableName}"`
      );
    }
    for (const tableName of [
      ...PROTECTED_UNCHANGED_TABLES,
      "security_audit_events",
    ]) {
      protectedStatements[tableName] =
        database.prepare(
          `SELECT * FROM "${tableName}" ` +
            `ORDER BY "${ORDER_COLUMNS[tableName]}" ASC`
        );
    }
    for (const tableName of COMPLETED_BOOTSTRAP_TABLES) {
      completedBootstrapStatements[tableName] =
        database.prepare(
          `SELECT * FROM "${tableName}" ` +
            `ORDER BY "${ORDER_COLUMNS[tableName]}" ASC`
        );
    }
    usersStatement = protectedStatements.users;
    rolesStatement =
      protectedStatements.platform_roles;
    tokensStatement =
      protectedStatements.account_action_tokens;
    outboxStatement =
      protectedStatements.outbox_events;
    auditStatement =
      protectedStatements.security_audit_events;
    metadataStatement =
      protectedStatements.application_metadata;
    migrationLedgerStatement = database.prepare(
      "SELECT migration_id AS id, " +
        "file_name AS fileName, checksum " +
        "FROM schema_migrations " +
        "ORDER BY migration_id ASC"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareResetOriginalLeagueBootstrapRepository",
    });
  }

  function assertSchema(expectedMigrationLedger) {
    const actual = schemaInventoryStatement
      .all()
      .map(({ name }) => name);
    const ledger = migrationLedgerStatement.all();
    const userVersion = database.pragma(
      "user_version",
      { simple: true }
    );
    if (
      userVersion !== REQUIRED_SCHEMA_VERSION ||
      tableNames.length !==
        REQUIRED_APPLICATION_TABLE_COUNT ||
      actual.length !==
        REQUIRED_APPLICATION_TABLE_COUNT ||
      actual.some(
        (tableName, index) =>
          tableName !== tableNames[index]
      ) ||
      !Array.isArray(expectedMigrationLedger) ||
      canonicalize(ledger) !==
        canonicalize(expectedMigrationLedger) ||
      database.pragma("foreign_keys", {
        simple: true,
      }) !== 1 ||
      database.pragma("integrity_check", {
        simple: true,
      }) !== "ok" ||
      database.pragma("foreign_key_check").length !== 0
    ) {
      fail();
    }
  }

  function assertContinuityBaseline(expected) {
    try {
      return assertResetOriginalLeagueContinuityBaselineMatches({
        database,
        expected,
      });
    } catch (error) {
      fail({ cause: error });
    }
  }

  function tableCounts() {
    return Object.freeze(
      Object.fromEntries(
        tableNames.map((tableName) => [
          tableName,
          countStatements[tableName].get().count,
        ])
      )
    );
  }

  function assertPreBootstrapCounts(counts) {
    const permitted = new Set([
      "application_metadata",
      ...IMPORTED_TABLES,
      ...FIRST_ADMINISTRATOR_TABLES,
    ]);
    for (const [tableName, count] of Object.entries(
      counts
    )) {
      if (!Number.isSafeInteger(count) || count < 0) {
        fail();
      }
      if (!permitted.has(tableName) && count !== 0) {
        fail();
      }
    }
    if (
      counts.application_metadata !== 2 ||
      counts.users !== 1 ||
      counts.platform_roles !== 1 ||
      counts.account_action_tokens !== 1 ||
      counts.outbox_events !== 1 ||
      counts.security_audit_events !== 1
    ) {
      fail();
    }
  }

  function assertCompletedBootstrapCounts(
    counts,
    expectedMigrationReportCount
  ) {
    if (
      !Number.isSafeInteger(
        expectedMigrationReportCount
      ) ||
      ![0, 1].includes(
        expectedMigrationReportCount
      )
    ) {
      fail();
    }
    const expectedCounts = Object.freeze({
      account_action_tokens: 1,
      application_metadata: 2,
      idempotency_requests: 1,
      league_activity: 1,
      league_settings: 1,
      leagues: 1,
      migration_reports:
        expectedMigrationReportCount,
      outbox_events: 1,
      platform_roles: 1,
      seasons: 1,
      security_audit_events: 2,
      users: 1,
    });
    for (const [tableName, count] of Object.entries(
      counts
    )) {
      if (!Number.isSafeInteger(count) || count < 0) {
        fail();
      }
      if (IMPORTED_TABLES.includes(tableName)) {
        continue;
      }
      if (
        count !==
        (expectedCounts[tableName] === undefined
          ? 0
          : expectedCounts[tableName])
      ) {
        fail();
      }
    }
  }

  function assertMetadata() {
    const rows = metadataStatement.all();
    if (
      rows.length !== 2 ||
      rows[0].metadata_key !==
        "application_compatibility_version" ||
      rows[0].metadata_value !== "1" ||
      rows[0].created_at_ms !== 0 ||
      rows[0].updated_at_ms !== 0 ||
      rows[1].metadata_key !==
        "data_model_version" ||
      rows[1].metadata_value !==
        String(REQUIRED_SCHEMA_VERSION) ||
      rows[1].created_at_ms !== 0 ||
      rows[1].updated_at_ms !==
        REQUIRED_SCHEMA_VERSION
    ) {
      fail();
    }
  }

  function assertImportedTables(
    expectedTargetTables,
    counts
  ) {
    if (
      !Array.isArray(expectedTargetTables) ||
      expectedTargetTables.length !==
        IMPORTED_TABLES.length
    ) {
      fail();
    }
    expectedTargetTables.forEach(
      (target, index) => {
        exactObject(target, [
          "table",
          "plannedRowCount",
          "validatedRowCount",
          "postRollbackRowCount",
          "semanticHash",
        ]);
        const expectedTable = IMPORTED_TABLES[index];
        if (
          target.table !== expectedTable ||
          !Number.isSafeInteger(
            target.plannedRowCount
          ) ||
          target.plannedRowCount < 0 ||
          target.validatedRowCount !==
            target.plannedRowCount ||
          target.postRollbackRowCount !== null ||
          typeof target.semanticHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(
            target.semanticHash
          ) ||
          counts[expectedTable] !==
            target.validatedRowCount ||
          tableSemanticHash(
            database,
            expectedTable
          ) !== target.semanticHash
        ) {
          fail();
        }
      }
    );
  }

  function assertFirstAdministrator(
    expectedUserId,
    expectedIdentity,
    nowMs,
    authenticateDelivery,
    {
      expectedAuditCount = 1,
      requireUnexpired = true,
    } = {}
  ) {
    if (
      typeof expectedUserId !== "string" ||
      !UUID_PATTERN.test(expectedUserId) ||
      !expectedIdentity ||
      typeof expectedIdentity !== "object" ||
      Array.isArray(expectedIdentity) ||
      typeof authenticateDelivery !== "function" ||
      !Number.isSafeInteger(expectedAuditCount) ||
      expectedAuditCount < 1 ||
      (requireUnexpired &&
        (!Number.isSafeInteger(nowMs) || nowMs < 0))
    ) {
      fail();
    }
    const users = usersStatement.all();
    const roles = rolesStatement.all();
    const tokens = tokensStatement.all();
    const outboxRows = outboxStatement.all();
    const auditRows = auditStatement.all();
    if (
      users.length !== 1 ||
      roles.length !== 1 ||
      tokens.length !== 1 ||
      outboxRows.length !== 1 ||
      auditRows.length !== expectedAuditCount
    ) {
      fail();
    }
    const [user] = users;
    const [role] = roles;
    const [token] = tokens;
    const [outbox] = outboxRows;
    const matchingAudits = auditRows.filter(
      (row) =>
        row.event_type ===
        "system_bootstrap.platform_administrator_created"
    );
    if (matchingAudits.length !== 1) {
      fail();
    }
    const [audit] = matchingAudits;
    exactObject(expectedIdentity, [
      "displayName",
      "displayNameNormalized",
      "emailDisplay",
      "emailNormalized",
    ]);
    if (
      [
        user.id,
        role.id,
        token.id,
        outbox.id,
        audit.id,
      ].some((id) => !UUID_PATTERN.test(id)) ||
      user.id !== expectedUserId ||
      user.email_normalized !==
        expectedIdentity.emailNormalized ||
      user.email_display !==
        expectedIdentity.emailDisplay ||
      user.display_name !==
        expectedIdentity.displayName ||
      user.display_name_normalized !==
        expectedIdentity.displayNameNormalized ||
      user.status !== "pending_credential_setup" ||
      user.version !== 1 ||
      user.created_at_ms !== user.updated_at_ms ||
      role.user_id !== user.id ||
      role.role !== "platform_administrator" ||
      role.status !== "active" ||
      role.granted_by_user_id !== null ||
      role.granted_at_ms !== user.created_at_ms ||
      role.ended_at_ms !== null ||
      role.version !== 1 ||
      token.user_id !== user.id ||
      token.purpose !== "administrator_setup" ||
      token.status !== "active" ||
      token.created_at_ms < user.created_at_ms ||
      token.expires_at_ms -
        token.created_at_ms !==
        ADMINISTRATOR_SETUP_LIFETIME_MS ||
      (requireUnexpired &&
        nowMs >= token.expires_at_ms) ||
      !/^[a-f0-9]{64}$/.test(
        token.token_digest || ""
      ) ||
      token.consumed_at_ms !== null ||
      token.invalidated_at_ms !== null ||
      token.failed_attempt_count !== 0 ||
      token.version !== 1 ||
      outbox.league_id !== null ||
      outbox.event_type !==
        "account.credential_setup_requested" ||
      outbox.aggregate_type !== "user" ||
      outbox.aggregate_id !== user.id ||
      outbox.status !== "pending" ||
      outbox.attempt_count !== 0 ||
      outbox.available_at_ms !== user.created_at_ms ||
      outbox.published_at_ms !== null ||
      outbox.last_error_code !== null ||
      outbox.created_at_ms !== user.created_at_ms ||
      outbox.updated_at_ms !== user.created_at_ms ||
      outbox.version !== 1 ||
      audit.event_type !==
        "system_bootstrap.platform_administrator_created" ||
      audit.outcome !== "success" ||
      audit.actor_user_id !== null ||
      audit.target_user_id !== user.id ||
      audit.league_id !== null ||
      audit.session_id !== null ||
      audit.request_correlation_id !== null ||
      audit.reason_code !== "protected_environment" ||
      audit.network_key_version !== null ||
      audit.network_metadata_digest !== null ||
      audit.client_metadata_json !== null ||
      audit.unknown_account_digest !== null ||
      audit.occurred_at_ms !== user.created_at_ms
    ) {
      fail();
    }

    let payload;
    try {
      payload = JSON.parse(outbox.payload_json);
    } catch {
      fail();
    }
    exactObject(payload, [
      "deliveryKind",
      "envelope",
      "expiresAtMs",
      "purpose",
      "recipientUserId",
      "schemaVersion",
      "tokenId",
    ]);
    if (
      outbox.payload_json !== JSON.stringify(payload) ||
      payload.deliveryKind !==
        "account_action_link" ||
      payload.expiresAtMs !== token.expires_at_ms ||
      payload.purpose !== "administrator_setup" ||
      payload.recipientUserId !== user.id ||
      payload.schemaVersion !== 1 ||
      payload.tokenId !== token.id ||
      !payload.envelope ||
      typeof payload.envelope !== "object" ||
      Array.isArray(payload.envelope)
    ) {
      fail();
    }
    exactObject(payload.envelope, [
      "algorithm",
      "authenticationTag",
      "ciphertext",
      "envelopeVersion",
      "keyVersion",
      "nonce",
    ]);
    if (
      payload.envelope.algorithm !== "A256GCM" ||
      payload.envelope.envelopeVersion !== 1 ||
      payload.envelope.keyVersion !== 1
    ) {
      fail();
    }
    canonicalBase64Url(
      payload.envelope.authenticationTag,
      16
    );
    canonicalBase64Url(
      payload.envelope.ciphertext,
      43
    );
    canonicalBase64Url(
      payload.envelope.nonce,
      12
    );
    let authenticated = false;
    try {
      authenticated =
        authenticateDelivery(
          freezeSnapshot({
            outbox: { ...outbox },
            payload,
            token: { ...token },
            user: { ...user },
          })
        ) === true;
    } catch {
      authenticated = false;
    }
    if (!authenticated) {
      fail();
    }
    return Object.freeze({
      user,
      initialAudit: audit,
      token,
    });
  }

  function protectedHashes() {
    return Object.freeze(
      Object.fromEntries(
        PROTECTED_UNCHANGED_TABLES.map(
          (tableName) => [
            tableName,
            hash(
              protectedStatements[tableName].all()
            ),
          ]
        )
      )
    );
  }

  function assertCompletedBootstrapBinding(value) {
    exactObject(value, [
      "leagueId",
      "leagueName",
      "leagueNameNormalized",
      "requestHash",
      "seasonId",
      "verificationHash",
    ]);
    if (
      !UUID_PATTERN.test(value.leagueId || "") ||
      !UUID_PATTERN.test(value.seasonId || "") ||
      value.leagueId === value.seasonId ||
      typeof value.leagueName !== "string" ||
      value.leagueName.length < 1 ||
      value.leagueName.length > 120 ||
      value.leagueName !== value.leagueName.trim() ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(
        value.leagueName
      ) ||
      value.leagueNameNormalized !==
        value.leagueName.toLowerCase() ||
      value.leagueNameNormalized.length > 120 ||
      !/^[a-f0-9]{64}$/.test(
        value.requestHash || ""
      ) ||
      !/^[a-f0-9]{64}$/.test(
        value.verificationHash || ""
      )
    ) {
      fail();
    }
    return value;
  }

  function singletonRows() {
    return Object.freeze(
      Object.fromEntries(
        COMPLETED_BOOTSTRAP_TABLES.map(
          (tableName) => {
            const rows =
              completedBootstrapStatements[
                tableName
              ].all();
            if (rows.length !== 1) {
              fail();
            }
            return [tableName, rows[0]];
          }
        )
      )
    );
  }

  function assertExactRow(actual, expected) {
    if (
      canonicalize(actual) !== canonicalize(expected)
    ) {
      fail();
    }
  }

  function assertCompletedBootstrapRows({
    binding,
    expectedUserId,
    firstAdministrator,
  }) {
    const rows = singletonRows();
    const idempotency =
      rows.idempotency_requests;
    const activity = rows.league_activity;
    const settings = rows.league_settings;
    const league = rows.leagues;
    const season = rows.seasons;
    const audits = auditStatement.all();
    const bootstrapAudits = audits.filter(
      (row) =>
        row.event_type ===
        RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT
    );
    if (
      bootstrapAudits.length !== 1 ||
      !Number.isSafeInteger(
        idempotency.created_at_ms
      ) ||
      idempotency.created_at_ms < 0
    ) {
      fail();
    }
    const [bootstrapAudit] = bootstrapAudits;
    const createdAtMs = idempotency.created_at_ms;
    const ids = [
      expectedUserId,
      idempotency.id,
      activity.id,
      bootstrapAudit.id,
      league.id,
      season.id,
    ];
    if (
      createdAtMs <
        firstAdministrator.user.created_at_ms ||
      createdAtMs <
        firstAdministrator.token.created_at_ms ||
      createdAtMs >=
        firstAdministrator.token.expires_at_ms ||
      ids.some((id) => !UUID_PATTERN.test(id)) ||
      new Set(ids).size !== ids.length
    ) {
      fail();
    }

    assertExactRow(league, {
      id: binding.leagueId,
      name: binding.leagueName,
      name_normalized:
        binding.leagueNameNormalized,
      status: "setup",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: binding.seasonId,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 2,
    });
    assertExactRow(settings, {
      league_id: binding.leagueId,
      salary_cap_cents: 10000,
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
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    assertExactRow(season, {
      id: binding.seasonId,
      league_id: binding.leagueId,
      label: RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
      nhl_season_key:
        RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
      status: "planned",
      regular_season_starts_at_ms: null,
      regular_season_ends_at_ms: null,
      fantasy_playoffs_start_at_ms: null,
      fantasy_playoffs_end_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
      free_agent_draft_completed_at_ms: null,
    });
    assertExactRow(activity, {
      id: activity.id,
      league_id: binding.leagueId,
      season_id: binding.seasonId,
      event_type: "league_created",
      actor_user_id: expectedUserId,
      actor_authority: "platform_administrator",
      team_id: null,
      player_id: null,
      related_type: "league",
      related_id: binding.leagueId,
      display_summary:
        `${binding.leagueName} was created in Setup.`,
      reason: null,
      metadata_json:
        RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
      occurred_at_ms: createdAtMs,
    });
    assertExactRow(idempotency, {
      id: idempotency.id,
      league_id: binding.leagueId,
      actor_user_id: expectedUserId,
      operation:
        RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
      client_key: binding.verificationHash,
      request_hash: binding.requestHash,
      status: "completed",
      result_type: "league",
      result_id: binding.leagueId,
      created_at_ms: createdAtMs,
      completed_at_ms: createdAtMs,
      expires_at_ms:
        createdAtMs +
        RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
    });
    assertExactRow(bootstrapAudit, {
      id: bootstrapAudit.id,
      event_type:
        RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
      outcome: "success",
      actor_user_id: expectedUserId,
      target_user_id: null,
      league_id: binding.leagueId,
      session_id: null,
      request_correlation_id: null,
      reason_code:
        RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
      network_key_version: null,
      network_metadata_digest: null,
      client_metadata_json: null,
      unknown_account_digest: null,
      occurred_at_ms: createdAtMs,
    });

    return freezeSnapshot({
      bootstrapAudit: { ...bootstrapAudit },
      createdAtMs,
      firstAudit: {
        ...firstAdministrator.initialAudit,
      },
      rows: Object.fromEntries(
        Object.entries(rows).map(
          ([tableName, row]) => [
            tableName,
            { ...row },
          ]
        )
      ),
    });
  }

  function assertPristineContinuity({
    currentProtectedHashes,
    firstAudit,
    pristineState,
  }) {
    if (pristineState === null) {
      return;
    }
    if (
      !pristineStates.has(pristineState) ||
      !pristineState.snapshot ||
      canonicalize(
        pristineState.snapshot.protectedHashes
      ) !== canonicalize(currentProtectedHashes) ||
      pristineState.snapshot.initialAuditHash !==
        hash(firstAudit)
    ) {
      fail();
    }
  }

  function assertCompletedState(
    options,
    expectedMigrationReportCount
  ) {
    if (database.inTransaction !== true) {
      fail();
    }
    exactObject(options, [
      "authenticateDelivery",
      "binding",
      "expectedAdministratorIdentity",
      "expectedContinuityBaseline",
      "expectedMigrationLedger",
      "expectedTargetTables",
      "expectedUserId",
      "pristineState",
    ]);
    const binding =
      assertCompletedBootstrapBinding(
        options.binding
      );
    assertSchema(options.expectedMigrationLedger);
    assertContinuityBaseline(
      options.expectedContinuityBaseline
    );
    const counts = tableCounts();
    assertCompletedBootstrapCounts(
      counts,
      expectedMigrationReportCount
    );
    assertMetadata();
    assertImportedTables(
      options.expectedTargetTables,
      counts
    );
    const firstAdministrator =
      assertFirstAdministrator(
        options.expectedUserId,
        options.expectedAdministratorIdentity,
        null,
        options.authenticateDelivery,
        {
          expectedAuditCount: 2,
          requireUnexpired: false,
        }
      );
    const currentProtectedHashes =
      protectedHashes();
    assertPristineContinuity({
      currentProtectedHashes,
      firstAudit:
        firstAdministrator.initialAudit,
      pristineState: options.pristineState,
    });
    const completed =
      assertCompletedBootstrapRows({
        binding,
        expectedUserId:
          options.expectedUserId,
        firstAdministrator,
      });
    const bootstrapCounts = { ...counts };
    delete bootstrapCounts.migration_reports;
    const snapshot = freezeSnapshot({
      bootstrapRowsHash: hash(completed),
      counts: bootstrapCounts,
      initialAuditHash: hash(
        firstAdministrator.initialAudit
      ),
      protectedHashes:
        currentProtectedHashes,
    });
    const result = {
      actorUserId:
        firstAdministrator.user.id,
      leagueId: binding.leagueId,
      schemaVersion: REQUIRED_SCHEMA_VERSION,
      seasonId: binding.seasonId,
      stateHash: hash(snapshot),
    };
    Object.defineProperty(result, "snapshot", {
      configurable: false,
      enumerable: false,
      value: snapshot,
      writable: false,
    });
    return Object.freeze(result);
  }

  function runCompletedStateAssertion(
    options,
    expectedMigrationReportCount,
    operation
  ) {
    try {
      return assertCompletedState(
        options,
        expectedMigrationReportCount
      );
    } catch (error) {
      if (
        error instanceof
        ResetOriginalLeagueBootstrapStateError
      ) {
        throw error;
      }
      throw mapRepositoryError(error, {
        operation,
      });
    }
  }

  return Object.freeze({
    assertPristineFirstAdministratorState({
      expectedAdministratorIdentity,
      expectedContinuityBaseline,
      expectedUserId,
      expectedTargetTables,
      expectedMigrationLedger,
      nowMs,
      authenticateDelivery,
    } = {}) {
      try {
        if (database.inTransaction !== true) {
          fail();
        }
        assertSchema(expectedMigrationLedger);
        assertContinuityBaseline(
          expectedContinuityBaseline
        );
        const counts = tableCounts();
        assertPreBootstrapCounts(counts);
        assertMetadata();
        assertImportedTables(
          expectedTargetTables,
          counts
        );
        const administrator =
          assertFirstAdministrator(
            expectedUserId,
            expectedAdministratorIdentity,
            nowMs,
            authenticateDelivery
          );
        const snapshot = freezeSnapshot({
          counts,
          protectedHashes: protectedHashes(),
          initialAuditHash: hash(
            administrator.initialAudit
          ),
        });
        const result = {
          actorUserId: administrator.user.id,
          schemaVersion: REQUIRED_SCHEMA_VERSION,
          stateHash: hash(snapshot),
        };
        Object.defineProperty(result, "snapshot", {
          configurable: false,
          enumerable: false,
          value: snapshot,
          writable: false,
        });
        Object.freeze(result);
        pristineStates.add(result);
        return result;
      } catch (error) {
        if (
          error instanceof
          ResetOriginalLeagueBootstrapStateError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation:
            "assertPristineFirstAdministratorState",
        });
      }
    },
    assertCompletedBootstrapState(options = {}) {
      return runCompletedStateAssertion(
        options,
        0,
        "assertCompletedResetOriginalLeagueBootstrapState"
      );
    },
    assertCompletedBootstrapStateAfterMigrationReport(
      options = {}
    ) {
      return runCompletedStateAssertion(
        options,
        1,
        "assertCompletedResetOriginalLeagueBootstrapStateAfterMigrationReport"
      );
    },
  });
}

module.exports = {
  ADMINISTRATOR_SETUP_LIFETIME_MS,
  COMPLETED_BOOTSTRAP_TABLES,
  FIRST_ADMINISTRATOR_TABLES,
  IMPORTED_TABLES,
  PROTECTED_UNCHANGED_TABLES,
  REQUIRED_APPLICATION_TABLE_COUNT,
  REQUIRED_SCHEMA_VERSION,
  RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
  RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_STATE_INVALID,
  ResetOriginalLeagueBootstrapStateError,
  createSqliteResetOriginalLeagueBootstrapRepository,
};
