"use strict";

const crypto = require("node:crypto");

const {
  assertPassword,
} = require("../../domain/accounts/passwordPolicy");
const {
  ACCOUNT_ALIASES,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureEmail,
  fixtureId,
} = require("./releaseQaFixtureContract");

const CONTRACT_VERSION = 1;
const RESULT_CODE = "RELEASE_QA_CREDENTIALS_ROTATED";
const EVENT_TYPE = "release_qa.credentials_rotated";
const EVENT_REASON_CODE = "operator_shared_password_recovery";
const EXPECTED_ACCOUNT_STATUSES = Object.freeze({
  platformAdmin: "active",
  leagueACommissioner: "active",
  leagueBCommissioner: "active",
  leagueAManagerOne: "active",
  leagueAManagerTwo: "active",
  leagueBManagerOne: "active",
  verifiedWithoutMembership: "active",
  pendingVerification: "pending_verification",
  deactivated: "deactivated",
});

const ERROR_CODES = Object.freeze({
  inputInvalid: "RELEASE_QA_CREDENTIAL_ROTATION_INPUT_INVALID",
  dependencyInvalid: "RELEASE_QA_CREDENTIAL_ROTATION_DEPENDENCY_INVALID",
  fixtureInvalid: "RELEASE_QA_CREDENTIAL_ROTATION_FIXTURE_INVALID",
  stateChanged: "RELEASE_QA_CREDENTIAL_ROTATION_STATE_CHANGED",
  passwordUnchanged: "RELEASE_QA_CREDENTIAL_ROTATION_PASSWORD_UNCHANGED",
  idempotencyConflict: "RELEASE_QA_CREDENTIAL_ROTATION_IDEMPOTENCY_CONFLICT",
  postcheckFailed: "RELEASE_QA_CREDENTIAL_ROTATION_POSTCHECK_FAILED",
  failed: "RELEASE_QA_CREDENTIAL_ROTATION_FAILED",
});

class ReleaseQaCredentialRotationError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA credential rotation failed safely.",
      options
    );
    this.name = "ReleaseQaCredentialRotationError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaCredentialRotationError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `release-QA credential rotation requires ${description}`
    );
  }
}

function exactIdentity(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)
  );
}

function exactRotationId(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)
  );
}

function stableUuid(parts) {
  const bytes = crypto
    .createHash("sha256")
    .update(parts.join("\0"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function receiptEventId({ databaseId, rotationId }) {
  return stableUuid([
    "hundo-leago",
    "release-qa-credential-rotation",
    databaseId,
    rotationId,
    "receipt",
  ]);
}

function replacementCredentialId({ databaseId, rotationId, alias }) {
  return stableUuid([
    "hundo-leago",
    "release-qa-credential-rotation",
    databaseId,
    rotationId,
    "credential",
    alias,
  ]);
}

function fixtureAccounts() {
  if (
    ACCOUNT_ALIASES.length !== 9 ||
    new Set(ACCOUNT_ALIASES).size !== 9 ||
    Object.keys(EXPECTED_ACCOUNT_STATUSES).length !== 9
  ) {
    fail(ERROR_CODES.fixtureInvalid);
  }
  return Object.freeze(
    ACCOUNT_ALIASES.map((alias) =>
      Object.freeze({
        alias,
        email: fixtureEmail(alias),
        status: EXPECTED_ACCOUNT_STATUSES[alias],
        userId: fixtureId(`account:${alias}`),
      })
    )
  );
}

function inspectFixtureAccounts({
  database,
  credentialRepository,
  sessionRepository,
}) {
  const accounts = fixtureAccounts();
  const placeholders = accounts.map(() => "?").join(", ");
  const users = database.prepare(`
    SELECT id, email_normalized, email_display, status
    FROM users
    WHERE id IN (${placeholders})
    ORDER BY id
  `).all(...accounts.map(({ userId }) => userId));
  if (users.length !== accounts.length) {
    fail(ERROR_CODES.fixtureInvalid);
  }
  const usersById = new Map(users.map((user) => [user.id, user]));
  const state = [];
  for (const account of accounts) {
    const user = usersById.get(account.userId);
    const credential = credentialRepository.findActiveByUserId(
      account.userId
    );
    const session = sessionRepository.findActiveByUserId(account.userId);
    if (
      !user ||
      user.email_normalized !== account.email ||
      user.email_display !== account.email ||
      user.status !== account.status ||
      !credential ||
      credential.user_id !== account.userId ||
      credential.status !== "active" ||
      credential.algorithm !== "scrypt" ||
      credential.algorithm_version !== 1 ||
      credential.replaced_at_ms !== null ||
      typeof credential.password_hash !== "string" ||
      credential.password_hash.length === 0 ||
      !Number.isSafeInteger(credential.created_at_ms) ||
      credential.created_at_ms < 0 ||
      !Number.isSafeInteger(credential.version) ||
      credential.version < 1 ||
      (session &&
        (session.user_id !== account.userId ||
          session.status !== "active" ||
          !Number.isSafeInteger(session.created_at_ms) ||
          session.created_at_ms < 0 ||
          !Number.isSafeInteger(session.version) ||
          session.version < 1))
    ) {
      fail(ERROR_CODES.fixtureInvalid);
    }
    state.push(
      Object.freeze({
        account,
        credential: Object.freeze({ ...credential }),
        session: session ? Object.freeze({ ...session }) : null,
      })
    );
  }
  return Object.freeze(state);
}

function sameSecurityState(before, after) {
  if (before.length !== after.length) return false;
  return before.every((prior, index) => {
    const current = after[index];
    return (
      prior.account.alias === current.account.alias &&
      prior.account.userId === current.account.userId &&
      prior.credential.id === current.credential.id &&
      prior.credential.version === current.credential.version &&
      prior.credential.password_hash === current.credential.password_hash &&
      (prior.session?.id || null) === (current.session?.id || null) &&
      (prior.session?.version || null) ===
        (current.session?.version || null)
    );
  });
}

function readReceipt(auditRepository, eventId) {
  return auditRepository.findById(eventId);
}

function receiptReasonCode(revokedActiveSessionCount) {
  if (
    !Number.isSafeInteger(revokedActiveSessionCount) ||
    revokedActiveSessionCount < 0 ||
    revokedActiveSessionCount > 9
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  return `${EVENT_REASON_CODE}_r9_s${revokedActiveSessionCount}`;
}

function parseReceipt(row, expected) {
  if (!row) return null;
  const reasonMatch = new RegExp(
    `^${EVENT_REASON_CODE}_r9_s([0-9])$`,
    "u"
  ).exec(row.reason_code || "");
  const revokedActiveSessionCount = reasonMatch
    ? Number(reasonMatch[1])
    : null;
  if (
    row.id !== expected.receiptEventId ||
    row.event_type !== EVENT_TYPE ||
    row.outcome !== "success" ||
    row.actor_user_id !== null ||
    row.target_user_id !== null ||
    row.league_id !== null ||
    row.session_id !== null ||
    row.request_correlation_id !== expected.rotationId ||
    !reasonMatch ||
    row.network_key_version !== null ||
    row.network_metadata_digest !== null ||
    row.client_metadata_json !== null ||
    row.unknown_account_digest !== null ||
    !Number.isSafeInteger(row.occurred_at_ms) ||
    row.occurred_at_ms < 0
  ) {
    fail(ERROR_CODES.idempotencyConflict);
  }
  return Object.freeze({
    code: RESULT_CODE,
    rotationId: expected.rotationId,
    environmentId: expected.environmentId,
    databaseId: expected.databaseId,
    schemaVersion: expected.schemaVersion,
    fixtureAccountCount: 9,
    rotatedAccountCount: 9,
    revokedActiveSessionCount,
    receiptEventId: expected.receiptEventId,
    rotatedAtMs: row.occurred_at_ms,
  });
}

async function suppliedPasswordMatches({
  password,
  passwordHasher,
  state,
}) {
  const checks = await Promise.all(
    state.map(({ credential }) =>
      passwordHasher.verify(password, credential.password_hash)
    )
  );
  return checks.every((check) => check?.verified === true);
}

async function suppliedPasswordMatchesAny({
  password,
  passwordHasher,
  state,
}) {
  const checks = await Promise.all(
    state.map(({ credential }) =>
      passwordHasher.verify(password, credential.password_hash)
    )
  );
  return checks.some((check) => check?.verified === true);
}

function sanitizedResult(result, { replayed, databaseWriteCount }) {
  return Object.freeze({
    code: result.code,
    contractVersion: CONTRACT_VERSION,
    rotationId: result.rotationId,
    environmentId: result.environmentId,
    databaseId: result.databaseId,
    schemaVersion: result.schemaVersion,
    fixtureAccountCount: result.fixtureAccountCount,
    rotatedAccountCount: result.rotatedAccountCount,
    revokedActiveSessionCount: result.revokedActiveSessionCount,
    receiptEventId: result.receiptEventId,
    rotatedAtMs: result.rotatedAtMs,
    replayed,
    databaseWriteCount,
  });
}

async function rotateReleaseQaCredentials({
  database,
  credentialRepository,
  sessionRepository,
  auditRepository,
  passwordHasher,
  password,
  rotationId,
  environmentId,
  databaseId,
  schemaVersion,
  nowMs,
  assertBinding,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.exec !== "function" ||
    typeof database.pragma !== "function" ||
    !exactRotationId(rotationId) ||
    environmentId !== FIXTURE_ENVIRONMENT_ID ||
    databaseId !== FIXTURE_DATABASE_ID ||
    !exactIdentity(environmentId) ||
    !exactIdentity(databaseId) ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    typeof assertBinding !== "function"
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  for (const [value, method, description] of [
    [credentialRepository, "findActiveByUserId", "credential reads"],
    [credentialRepository, "replaceActive", "credential replacement"],
    [sessionRepository, "findActiveByUserId", "session reads"],
    [sessionRepository, "revokeActive", "session revocation"],
    [auditRepository, "findById", "security-audit receipt reads"],
    [auditRepository, "append", "security-audit receipt writes"],
    [passwordHasher, "hash", "password hashing"],
    [passwordHasher, "verify", "password verification"],
  ]) {
    assertMethod(value, method, description);
  }
  try {
    assertPassword(password);
  } catch (error) {
    fail(ERROR_CODES.inputInvalid, error);
  }

  const eventId = receiptEventId({ databaseId, rotationId });
  const receiptIdentity = Object.freeze({
    databaseId,
    environmentId,
    receiptEventId: eventId,
    rotationId,
    schemaVersion,
  });
  assertBinding();
  const initialState = inspectFixtureAccounts({
    database,
    credentialRepository,
    sessionRepository,
  });
  const priorReceipt = parseReceipt(
    readReceipt(auditRepository, eventId),
    receiptIdentity
  );
  if (priorReceipt) {
    const totalChangesBeforeReplay = database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    try {
      database.exec("BEGIN IMMEDIATE");
      assertBinding();
      const lockedState = inspectFixtureAccounts({
        database,
        credentialRepository,
        sessionRepository,
      });
      const lockedReceipt = parseReceipt(
        readReceipt(auditRepository, eventId),
        receiptIdentity
      );
      const deterministicCredentialIdsExact = lockedState.every(
        ({ account, credential }) =>
          credential.id ===
            replacementCredentialId({
              databaseId,
              rotationId,
              alias: account.alias,
            }) &&
          credential.version === 1 &&
          credential.created_at_ms === lockedReceipt?.rotatedAtMs
      );
      if (
        !lockedReceipt ||
        lockedReceipt.rotatedAtMs !== priorReceipt.rotatedAtMs ||
        lockedReceipt.revokedActiveSessionCount !==
          priorReceipt.revokedActiveSessionCount ||
        !deterministicCredentialIdsExact ||
        lockedState.some(({ session }) => session !== null) ||
        !(await suppliedPasswordMatches({
          password,
          passwordHasher,
          state: lockedState,
        }))
      ) {
        fail(ERROR_CODES.idempotencyConflict);
      }
      assertBinding();
      const finalState = inspectFixtureAccounts({
        database,
        credentialRepository,
        sessionRepository,
      });
      const finalReceipt = parseReceipt(
        readReceipt(auditRepository, eventId),
        receiptIdentity
      );
      if (
        !sameSecurityState(lockedState, finalState) ||
        !finalReceipt ||
        finalReceipt.rotatedAtMs !== lockedReceipt.rotatedAtMs ||
        finalReceipt.revokedActiveSessionCount !==
          lockedReceipt.revokedActiveSessionCount ||
        database.prepare("SELECT total_changes() AS count").get().count !==
          totalChangesBeforeReplay
      ) {
        fail(ERROR_CODES.idempotencyConflict);
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new ReleaseQaCredentialRotationError(
            ERROR_CODES.failed,
            {
              cause: new AggregateError(
                [error, rollbackError],
                "The credential rotation replay rollback failed."
              ),
            }
          );
        }
      }
      if (error instanceof ReleaseQaCredentialRotationError) throw error;
      fail(ERROR_CODES.idempotencyConflict, error);
    }
    return sanitizedResult(priorReceipt, {
      replayed: true,
      databaseWriteCount: 0,
    });
  }

  let passwordMatchesExisting;
  try {
    passwordMatchesExisting = await suppliedPasswordMatchesAny({
      password,
      passwordHasher,
      state: initialState,
    });
  } catch (error) {
    fail(ERROR_CODES.dependencyInvalid, error);
  }
  if (passwordMatchesExisting) {
    fail(ERROR_CODES.passwordUnchanged);
  }

  let replacementHashes;
  try {
    replacementHashes = await Promise.all(
      initialState.map(() => passwordHasher.hash(password))
    );
  } catch (error) {
    fail(ERROR_CODES.dependencyInvalid, error);
  }
  if (
    replacementHashes.length !== 9 ||
    replacementHashes.some(
      (hash) => typeof hash !== "string" || hash.length === 0
    ) ||
    new Set(replacementHashes).size !== 9
  ) {
    fail(ERROR_CODES.dependencyInvalid);
  }

  const effectiveNowMs = initialState.reduce(
    (latest, item) =>
      Math.max(
        latest,
        item.credential.created_at_ms,
        item.session?.created_at_ms || 0
      ),
    nowMs
  );
  const revokedActiveSessionCount = initialState.filter(
    ({ session }) => session !== null
  ).length;
  const result = Object.freeze({
    code: RESULT_CODE,
    rotationId,
    environmentId,
    databaseId,
    schemaVersion,
    fixtureAccountCount: 9,
    rotatedAccountCount: 9,
    revokedActiveSessionCount,
    receiptEventId: eventId,
    rotatedAtMs: effectiveNowMs,
  });
  const expectedCredentialIds = new Map(
    initialState.map(({ account }) => [
      account.userId,
      replacementCredentialId({
        databaseId,
        rotationId,
        alias: account.alias,
      }),
    ])
  );
  const totalChangesBefore = database
    .prepare("SELECT total_changes() AS count")
    .get().count;

  try {
    database.exec("BEGIN IMMEDIATE");
    assertBinding();
    const lockedState = inspectFixtureAccounts({
      database,
      credentialRepository,
      sessionRepository,
    });
    if (
      !sameSecurityState(initialState, lockedState) ||
      readReceipt(auditRepository, eventId) !== null
    ) {
      fail(ERROR_CODES.stateChanged);
    }
    const credentialIdPlaceholders = [...expectedCredentialIds.values()]
      .map(() => "?")
      .join(", ");
    if (
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM user_credentials
        WHERE id IN (${credentialIdPlaceholders})
      `).get(...expectedCredentialIds.values()).count !== 0
    ) {
      fail(ERROR_CODES.idempotencyConflict);
    }

    for (let index = 0; index < lockedState.length; index += 1) {
      const item = lockedState[index];
      credentialRepository.replaceActive({
        currentCredentialId: item.credential.id,
        expectedVersion: item.credential.version,
        replacedAtMs: effectiveNowMs,
        replacement: {
          id: expectedCredentialIds.get(item.account.userId),
          user_id: item.account.userId,
          password_hash: replacementHashes[index],
          algorithm: "scrypt",
          algorithm_version: 1,
          status: "active",
          created_at_ms: effectiveNowMs,
          replaced_at_ms: null,
          version: 1,
        },
      });
      if (item.session) {
        sessionRepository.revokeActive({
          sessionId: item.session.id,
          expectedVersion: item.session.version,
          changedAtMs: effectiveNowMs,
          reason: "platform_security_action",
          transactionHook: null,
        });
      }
    }

    auditRepository.append({
      id: eventId,
      event_type: EVENT_TYPE,
      outcome: "success",
      actor_user_id: null,
      target_user_id: null,
      league_id: null,
      session_id: null,
      request_correlation_id: rotationId,
      reason_code: receiptReasonCode(revokedActiveSessionCount),
      network_key_version: null,
      network_metadata_digest: null,
      client_metadata_json: null,
      unknown_account_digest: null,
      occurred_at_ms: effectiveNowMs,
    });

    assertBinding();
    const finalState = inspectFixtureAccounts({
      database,
      credentialRepository,
      sessionRepository,
    });
    const finalReceipt = parseReceipt(
      readReceipt(auditRepository, eventId),
      receiptIdentity
    );
    const databaseWriteCount =
      database.prepare("SELECT total_changes() AS count").get().count -
      totalChangesBefore;
    if (
      !finalReceipt ||
      finalState.some(({ session }) => session !== null) ||
      finalState.some((item, index) =>
        item.credential.id !==
          expectedCredentialIds.get(item.account.userId) ||
        item.credential.password_hash !== replacementHashes[index] ||
        item.credential.version !== 1 ||
        item.credential.created_at_ms !== effectiveNowMs
      ) ||
      !(await suppliedPasswordMatches({
        password,
        passwordHasher,
        state: finalState,
      })) ||
      databaseWriteCount !== 19 + revokedActiveSessionCount ||
      database.pragma("foreign_key_check").length !== 0 ||
      database.pragma("integrity_check", { simple: true }) !== "ok"
    ) {
      fail(ERROR_CODES.postcheckFailed);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new ReleaseQaCredentialRotationError(
          ERROR_CODES.failed,
          {
            cause: new AggregateError(
              [error, rollbackError],
              "The credential rotation rollback failed."
            ),
          }
        );
      }
    }
    if (error instanceof ReleaseQaCredentialRotationError) throw error;
    fail(ERROR_CODES.failed, error);
  }

  return sanitizedResult(result, {
    replayed: false,
    databaseWriteCount: 19 + revokedActiveSessionCount,
  });
}

module.exports = {
  CONTRACT_VERSION,
  ERROR_CODES,
  EVENT_REASON_CODE,
  EVENT_TYPE,
  EXPECTED_ACCOUNT_STATUSES,
  RESULT_CODE,
  ReleaseQaCredentialRotationError,
  fixtureAccounts,
  inspectFixtureAccounts,
  receiptEventId,
  receiptReasonCode,
  replacementCredentialId,
  rotateReleaseQaCredentials,
  stableUuid,
};
