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
  displayNameUser = user,
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
    displayNames: [],
    verifications: [],
  };
  const service =
    createCredentialAuthenticationService({
      userRepository: {
        findByNormalizedEmail(email) {
          calls.emails.push(email);
          return user;
        },
        findByNormalizedDisplayName(displayName) {
          calls.displayNames.push(displayName);
          return displayNameUser;
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
  test("display names use existing case and whitespace rules without altering passwords", async () => {
    const { calls, service } = harness();
    const input = { identifier: "  Équipe ONE  ", password: "  exact pass  " };
    const result = await service.authenticate(input);
    assert.equal(result.authenticated, true);
    assert.deepEqual(calls.emails, []);
    assert.deepEqual(calls.displayNames, ["équipe one"]);
    assert.equal(calls.verifications[0].password, input.password);
    assert.equal(service.rateLimitSubject(input), "person@example.com");
    assert.equal(service.rateLimitSubject({ email: " PERSON@example.com ", password: "short" }),
      "person@example.com");
    assert.doesNotMatch(JSON.stringify(result), /person@example|stored-hash|exact pass/);
  });

  test("an exact email account wins without a display-name retry on password or eligibility failure", async () => {
    for (const status of ["active", "deactivated", "pending_verification"]) {
      const { calls, service } = harness({
        user: activeUser({ status }),
        displayNameUser: activeUser({ id: "different-account" }),
        verification: { verified: false, needsRehash: false },
      });
      const result = await service.authenticate({
        identifier: " PERSON@example.com ", password: "incorrect password",
      });
      assert.deepEqual(result, AUTHENTICATION_FAILED);
      assert.deepEqual(calls.displayNames, []);
      assert.equal(calls.verifications.length, 1);
      assert.equal(result.user.id, activeUser().id);
    }
  });

  test("an email-shaped display name works only when no email account matches", async () => {
    const { calls, service } = harness({ user: null, displayNameUser: activeUser() });
    const input = { identifier: "Captain@Home", password: "correct password" };
    assert.equal((await service.authenticate(input)).authenticated, true);
    assert.deepEqual(calls.emails, ["captain@home"]);
    assert.deepEqual(calls.displayNames, ["captain@home"]);
    assert.equal(service.rateLimitSubject(input), "person@example.com");
    assert.deepEqual(await service.authenticate({ email: "Captain@Home", password: "correct password" }),
      AUTHENTICATION_FAILED);
    assert.deepEqual(calls.displayNames, ["captain@home", "captain@home"]);
  });

  test("unknown and ineligible display names receive the same generic failure and dummy work", async () => {
    for (const displayNameUser of [null, activeUser({ status: "disabled" }),
      activeUser({ status: "pending_verification" })]) {
      const { calls, service } = harness({ displayNameUser });
      const input = { identifier: "Manager One", password: "submitted password" };
      assert.deepEqual(await service.authenticate(input), AUTHENTICATION_FAILED);
      assert.deepEqual(calls.credentialUserIds, []);
      assert.equal(calls.verifications.length, 1);
      assert.equal(calls.verifications[0].encodedPassword, DUMMY_PASSWORD_HASH);
      assert.equal(service.rateLimitSubject(input), displayNameUser
        ? "person@example.com" : "display_name:manager one");
    }
  });

  test("ambiguous body fields and invalid display names never select an account", async () => {
    for (const identifier of ["", "a".repeat(51), "name\ninside", {}, 1]) {
      const { calls, service } = harness();
      assert.deepEqual(await service.authenticate({ identifier, password: "correct password" }),
        AUTHENTICATION_FAILED);
      assert.deepEqual(calls.displayNames, []);
      assert.deepEqual(calls.emails, []);
    }
    const { calls, service } = harness();
    assert.deepEqual(await service.authenticate({ identifier: "Manager One",
      email: "person@example.com", password: "correct password" }), AUTHENTICATION_FAILED);
    assert.deepEqual(calls.emails, []);
    assert.deepEqual(calls.displayNames, []);
  });

  test("normalizes only the email and keeps the exact password non-enumerable", () => {
    const inspected = inspectInput({
      email: " Person@Example.COM ",
      password: "  exact pass  ",
    });

    assert.deepEqual(inspected, {
      emailNormalized: "person@example.com",
      displayNameNormalized: null,
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
          findByNormalizedDisplayName() {
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
