const {
  ACTION_TOKEN_PURPOSES,
  INVALID_ACTION_TOKEN_RESULT,
  createActionTokenDeadline,
  evaluateActionToken,
} = require(
  "../../../domain/accounts/accountActionTokenPolicy"
);

const REPOSITORY_VERSION_CONFLICT =
  "REPOSITORY_VERSION_CONFLICT";
const REPOSITORY_RECORD_NOT_FOUND =
  "REPOSITORY_RECORD_NOT_FOUND";

function safeToken(row) {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    status: row.status,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    consumedAtMs: row.consumed_at_ms,
    invalidatedAtMs: row.invalidated_at_ms,
    failedAttemptCount:
      row.failed_attempt_count,
    version: row.version,
  });
}

function createIssueResult(
  token,
  previousTokenId,
  rawToken
) {
  const result = {
    kind: "internal_action_token_issue",
    previousTokenId,
    token,
  };
  Object.defineProperty(result, "rawToken", {
    configurable: false,
    enumerable: false,
    value: rawToken,
    writable: false,
  });
  return Object.freeze(result);
}

function createIssueTransactionHook(
  transactionHook,
  rawToken,
  expiresAtMs
) {
  if (transactionHook === null) return null;
  if (typeof transactionHook !== "function") {
    throw new TypeError(
      "the action-token transaction hook is invalid"
    );
  }
  return function issueTransactionHook(context) {
    const internalContext = { ...context };
    for (const [key, value] of Object.entries({
      expiresAtMs,
      rawToken,
    })) {
      Object.defineProperty(internalContext, key, {
        configurable: false,
        enumerable: false,
        value,
        writable: false,
      });
    }
    return transactionHook(
      Object.freeze(internalContext)
    );
  };
}

function createAccountActionTokenService({
  repository,
  opaqueTokens,
  clock,
  secureRandom,
} = {}) {
  for (const method of [
    "findByDigest",
    "findActiveByUserPurpose",
    "replaceActive",
    "consumeActive",
    "expireActive",
    "invalidateActive",
    "incrementFailedAttempt",
  ]) {
    if (
      !repository ||
      typeof repository[method] !== "function"
    ) {
      throw new TypeError(
        "account action tokens require a specialized repository"
      );
    }
  }
  if (
    !opaqueTokens ||
    typeof opaqueTokens.generate !==
      "function" ||
    typeof opaqueTokens.digest !== "function" ||
    typeof opaqueTokens.matches !== "function"
  ) {
    throw new TypeError(
      "account action tokens require an opaque-token adapter"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "account action tokens require a clock"
    );
  }
  if (
    !secureRandom ||
    typeof secureRandom.id !== "function"
  ) {
    throw new TypeError(
      "account action tokens require secure identifiers"
    );
  }

  function issue({
    userId,
    purpose,
    transactionHook = null,
  } = {}) {
    if (
      typeof userId !== "string" ||
      userId.trim() === "" ||
      !ACTION_TOKEN_PURPOSES.includes(purpose)
    ) {
      throw new TypeError(
        "an action-token user and purpose are required"
      );
    }
    const nowMs = clock.nowMs();
    const deadline = createActionTokenDeadline(
      purpose,
      nowMs
    );
    const generated = opaqueTokens.generate();
    const replacement = {
      id: secureRandom.id(),
      user_id: userId,
      token_digest: generated.tokenDigest,
      purpose,
      status: "active",
      created_at_ms: deadline.createdAtMs,
      expires_at_ms: deadline.expiresAtMs,
      consumed_at_ms: null,
      invalidated_at_ms: null,
      failed_attempt_count: 0,
      version: 1,
    };
    const stored = repository.replaceActive({
      replacement,
      replacedAtMs: nowMs,
      transactionHook: createIssueTransactionHook(
        transactionHook,
        generated.rawToken,
        deadline.expiresAtMs
      ),
    });
    return createIssueResult(
      safeToken(stored.active),
      stored.previous?.id || null,
      generated.rawToken
    );
  }

  function expireBestEffort(row, nowMs) {
    try {
      repository.expireActive({
        tokenId: row.id,
        expectedVersion: row.version,
        changedAtMs: nowMs,
        transactionHook: null,
      });
    } catch (error) {
      if (
        ![
          REPOSITORY_VERSION_CONFLICT,
          REPOSITORY_RECORD_NOT_FOUND,
        ].includes(error?.code)
      ) {
        throw error;
      }
    }
  }

  function resolveInternal(
    rawToken,
    expectedPurpose
  ) {
    if (
      !ACTION_TOKEN_PURPOSES.includes(
        expectedPurpose
      )
    ) {
      return INVALID_ACTION_TOKEN_RESULT;
    }
    let digest;
    try {
      digest = opaqueTokens.digest(rawToken);
    } catch {
      return INVALID_ACTION_TOKEN_RESULT;
    }
    const row = repository.findByDigest(digest);
    if (
      !row ||
      !opaqueTokens.matches(
        rawToken,
        row.token_digest
      )
    ) {
      return INVALID_ACTION_TOKEN_RESULT;
    }
    const nowMs = clock.nowMs();
    const evaluation = evaluateActionToken(
      row,
      expectedPurpose,
      nowMs
    );
    if (!evaluation.valid) {
      if (
        row.status === "active" &&
        nowMs >= row.expires_at_ms
      ) {
        expireBestEffort(row, nowMs);
      }
      return INVALID_ACTION_TOKEN_RESULT;
    }
    return Object.freeze({
      valid: true,
      code: "ACTION_TOKEN_VALID",
      row,
    });
  }

  function resolve({
    rawToken,
    expectedPurpose,
  } = {}) {
    const result = resolveInternal(
      rawToken,
      expectedPurpose
    );
    if (!result.valid) return result;
    return Object.freeze({
      valid: true,
      code: "ACTION_TOKEN_VALID",
      token: safeToken(result.row),
    });
  }

  function recordFailedAttempt({
    rawToken,
    expectedPurpose,
  } = {}) {
    const result = resolveInternal(
      rawToken,
      expectedPurpose
    );
    if (!result.valid) return result;
    try {
      const updated =
        repository.incrementFailedAttempt({
          tokenId: result.row.id,
          expectedVersion:
            result.row.version,
        });
      return Object.freeze({
        valid: true,
        code: "ACTION_TOKEN_VALID",
        token: safeToken(updated),
      });
    } catch (error) {
      if (
        [
          REPOSITORY_VERSION_CONFLICT,
          REPOSITORY_RECORD_NOT_FOUND,
        ].includes(error?.code)
      ) {
        return INVALID_ACTION_TOKEN_RESULT;
      }
      throw error;
    }
  }

  function consume({
    rawToken,
    expectedPurpose,
    transactionHook = null,
  } = {}) {
    const result = resolveInternal(
      rawToken,
      expectedPurpose
    );
    if (!result.valid) return result;
    try {
      const consumed =
        repository.consumeActive({
          tokenId: result.row.id,
          expectedVersion:
            result.row.version,
          changedAtMs: clock.nowMs(),
          transactionHook,
        });
      return Object.freeze({
        valid: true,
        code: "ACTION_TOKEN_CONSUMED",
        token: safeToken(consumed),
      });
    } catch (error) {
      if (
        [
          REPOSITORY_VERSION_CONFLICT,
          REPOSITORY_RECORD_NOT_FOUND,
        ].includes(error?.code)
      ) {
        return INVALID_ACTION_TOKEN_RESULT;
      }
      throw error;
    }
  }

  function invalidateForUserPurpose({
    userId,
    purpose,
    transactionHook = null,
  } = {}) {
    if (
      typeof userId !== "string" ||
      userId.trim() === "" ||
      !ACTION_TOKEN_PURPOSES.includes(purpose) ||
      (transactionHook !== null &&
        typeof transactionHook !== "function")
    ) {
      throw new TypeError(
        "an action-token user, purpose, and valid hook are required"
      );
    }
    const current =
      repository.findActiveByUserPurpose(
        userId,
        purpose
      );
    if (!current) {
      return Object.freeze({
        invalidated: false,
        code: "ACTION_TOKEN_NOT_ACTIVE",
      });
    }
    try {
      const invalidated = repository.invalidateActive({
        tokenId: current.id,
        expectedVersion: current.version,
        changedAtMs: clock.nowMs(),
        transactionHook,
      });
      return Object.freeze({
        invalidated: true,
        code: "ACTION_TOKEN_INVALIDATED",
        token: safeToken(invalidated),
      });
    } catch (error) {
      if (
        [
          REPOSITORY_VERSION_CONFLICT,
          REPOSITORY_RECORD_NOT_FOUND,
        ].includes(error?.code)
      ) {
        return Object.freeze({
          invalidated: false,
          code: "ACTION_TOKEN_NOT_ACTIVE",
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    consume,
    invalidateForUserPurpose,
    issue,
    recordFailedAttempt,
    resolve,
  });
}

module.exports = {
  createAccountActionTokenService,
};
