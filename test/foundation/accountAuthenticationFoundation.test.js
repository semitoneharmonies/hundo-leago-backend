const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  AUTHENTICATION_FAILED,
  DUMMY_PASSWORD,
  DUMMY_PASSWORD_HASH,
  createCredentialAuthenticationService,
  inspectInput,
} = require(
  "../../src/application/services/accounts/createCredentialAuthenticationService"
);
const {
  createScryptPasswordHasher,
} = require(
  "../../src/infrastructure/security/createScryptPasswordHasher"
);

function activeUser(overrides = {}) {
  return Object.freeze({
    id: "00000000-0000-4000-8000-000000000001",
    email_normalized: "person@example.com",
    status: "active",
    version: 1,
    ...overrides,
  });
}

function activeCredential(overrides = {}) {
  return Object.freeze({
    id: "00000000-0000-4000-8000-000000000002",
    user_id: "00000000-0000-4000-8000-000000000001",
    password_hash: "stored-hash",
    algorithm: "scrypt",
    algorithm_version: 1,
    status: "active",
    replaced_at_ms: null,
    version: 1,
    ...overrides,
  });
}

function harness({
  user = activeUser(),
  credential = activeCredential(),
  verification = Object.freeze({
    verified: true,
    needsRehash: false,
  }),
  verifyError = null,
} = {}) {
  const calls = {
    credentialUserIds: [],
    emails: [],
    verifications: [],
  };
  const service =
    createCredentialAuthenticationService({
      userRepository: {
        findByNormalizedEmail(email) {
          calls.emails.push(email);
          return user;
        },
      },
      credentialRepository: {
        findActiveByUserId(userId) {
          calls.credentialUserIds.push(userId);
          return credential;
        },
      },
      passwordHasher: {
        async verify(password, encodedPassword) {
          calls.verifications.push({
            encodedPassword,
            password,
          });
          if (verifyError) throw verifyError;
          return verification;
        },
      },
    });
  return { calls, service };
}

describe("credential authentication service", () => {
  test("normalizes only the email and keeps the exact password non-enumerable", () => {
    const inspected = inspectInput({
      email: " Person@Example.COM ",
      password: "  exact pass  ",
    });

    assert.deepEqual(inspected, {
      emailNormalized: "person@example.com",
      valid: true,
    });
    assert.equal(
      inspected.password,
      "  exact pass  "
    );
    assert.equal(
      Object.keys(inspected).includes("password"),
      false
    );
  });

  test("returns an internal success without exposing user or credential rows", async () => {
    const { calls, service } = harness();
    const result = await service.authenticate({
      email: " Person@Example.COM ",
      password: "correct password",
    });

    assert.deepEqual(result, {
      authenticated: true,
      code: "AUTHENTICATION_SUCCEEDED",
    });
    assert.equal(result.user.id, activeUser().id);
    assert.equal(result.credential.id, activeCredential().id);
    assert.equal(result.needsRehash, false);
    assert.deepEqual(Object.keys(result), [
      "authenticated",
      "code",
    ]);
    assert.deepEqual(calls.emails, [
      "person@example.com",
    ]);
    assert.deepEqual(calls.credentialUserIds, [
      activeUser().id,
    ]);
    assert.deepEqual(calls.verifications, [
      {
        encodedPassword: "stored-hash",
        password: "correct password",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /person@example|stored-hash|correct password/
    );
  });

  test("uses one bounded dummy verification for unknown and ineligible accounts", async () => {
    for (const user of [
      null,
      activeUser({ status: "pending_verification" }),
      activeUser({ status: "deactivated" }),
      activeUser({ status: "disabled" }),
    ]) {
      const { calls, service } = harness({
        user,
        verification: Object.freeze({
          verified: false,
          needsRehash: false,
        }),
      });
      const result = await service.authenticate({
        email: "person@example.com",
        password: "submitted password",
      });

      assert.deepEqual(result, AUTHENTICATION_FAILED);
      assert.equal(result.reasonCode, "account_ineligible");
      assert.deepEqual(calls.credentialUserIds, []);
      assert.deepEqual(calls.verifications, [
        {
          encodedPassword: DUMMY_PASSWORD_HASH,
          password: "submitted password",
        },
      ]);
    }
  });

  test("malformed input follows the same public failure and dummy workload", async () => {
    for (const input of [
      null,
      {},
      {
        email: "not-an-email",
        password: "submitted password",
      },
      {
        email: "person@example.com",
        password: "short",
      },
      {
        email: "person@example.com",
        password: "submitted password",
        role: "admin",
      },
    ]) {
      const { calls, service } = harness({
        user: null,
        verification: Object.freeze({
          verified: false,
          needsRehash: false,
        }),
      });
      const result = await service.authenticate(input);

      assert.deepEqual(result, AUTHENTICATION_FAILED);
      assert.equal(calls.verifications.length, 1);
      assert.equal(
        calls.verifications[0].encodedPassword,
        DUMMY_PASSWORD_HASH
      );
      if (
        input === null ||
        Object.keys(input).length !== 2 ||
        input.password === "short"
      ) {
        assert.equal(
          calls.verifications[0].password,
          DUMMY_PASSWORD
        );
      }
    }
  });

  test("keeps wrong-password and invalid stored credential failures generic", async () => {
    const wrong = harness({
      verification: Object.freeze({
        verified: false,
        needsRehash: false,
      }),
    });
    const wrongResult =
      await wrong.service.authenticate({
        email: "person@example.com",
        password: "incorrect password",
      });
    assert.deepEqual(wrongResult, AUTHENTICATION_FAILED);

    const invalidStored = harness({
      verifyError: Object.assign(new Error("private"), {
        code: "STORED_CREDENTIAL_INVALID",
      }),
    });
    const invalidResult =
      await invalidStored.service.authenticate({
        email: "person@example.com",
        password: "submitted password",
      });
    assert.deepEqual(invalidResult, AUTHENTICATION_FAILED);
    assert.equal(
      invalidResult.reasonCode,
      "stored_credential_invalid"
    );
  });

  test("preserves retryable password-processing failures", async () => {
    const capacityError = Object.assign(
      new Error("busy"),
      {
        code: "PASSWORD_PROCESSING_BUSY",
        retryable: true,
      }
    );
    const { service } = harness({
      verifyError: capacityError,
    });

    await assert.rejects(
      service.authenticate({
        email: "person@example.com",
        password: "submitted password",
      }),
      (error) => error === capacityError
    );
  });

  test("the fixed dummy credential is accepted by the production parser and always ignored", async () => {
    const passwordHasher =
      createScryptPasswordHasher({
        secureRandom: {
          bytes(length) {
            return crypto.randomBytes(length);
          },
        },
      });
    const service =
      createCredentialAuthenticationService({
        userRepository: {
          findByNormalizedEmail() {
            return null;
          },
        },
        credentialRepository: {
          findActiveByUserId() {
            throw new Error("must not load");
          },
        },
        passwordHasher,
      });

    const result = await service.authenticate({
      email: "unknown@example.com",
      password: "submitted password",
    });
    assert.deepEqual(result, AUTHENTICATION_FAILED);
  });
});
