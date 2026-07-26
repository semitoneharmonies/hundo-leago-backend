const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createAccountProfileService,
} = require(
  "../../src/application/services/accounts/createAccountProfileService"
);
const {
  parseIfMatch,
} = require("../../src/transport/http/createAccountProfileRouter");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function createService() {
  const rows = new Map([
    [
      USER_ID,
      {
        id: USER_ID,
        email_normalized: "manager@example.test",
        email_display: "Manager@Example.test",
        display_name: "Original Manager",
        display_name_normalized: "original manager",
        status: "active",
        updated_at_ms: 1,
        version: 1,
      },
    ],
    [
      OTHER_ID,
      {
        id: OTHER_ID,
        email_normalized: "other@example.test",
        email_display: "other@example.test",
        display_name: "Taken Name",
        display_name_normalized: "taken name",
        status: "active",
        updated_at_ms: 1,
        version: 1,
      },
    ],
  ]);
  const service = createAccountProfileService({
    activeUserAuthorization: {
      requireActiveUser(authenticated) {
        assert.deepEqual(authenticated, { userId: USER_ID });
        return { actorUserId: USER_ID };
      },
    },
    repositoryContext: {
      transaction(callback) {
        return callback();
      },
    },
    userRepository: {
      findById(id) {
        return rows.get(id) || null;
      },
      findByNormalizedDisplayName(displayName) {
        return (
          [...rows.values()].find(
            (row) => row.display_name_normalized === displayName
          ) || null
        );
      },
      updateVersioned({ key, expectedVersion, changes }) {
        const current = rows.get(key);
        if (!current || current.version !== expectedVersion) {
          const error = new Error("Version conflict");
          error.code = "REPOSITORY_VERSION_CONFLICT";
          throw error;
        }
        const updated = {
          ...current,
          ...changes,
          version: current.version + 1,
        };
        rows.set(key, updated);
        return updated;
      },
    },
    clock: { nowMs: () => 100 },
  });
  return { rows, service };
}

describe("authenticated account profile", () => {
  test("reads only safe fields and updates a unique display name by version", () => {
    const { rows, service } = createService();
    assert.deepEqual(service.read({ authenticated: { userId: USER_ID } }), {
      code: "ACCOUNT_PROFILE_FOUND",
      user: {
        id: USER_ID,
        email: "Manager@Example.test",
        displayName: "Original Manager",
        status: "active",
        version: 1,
      },
    });

    const result = service.update({
      authenticated: { userId: USER_ID },
      input: { displayName: "  Updated Manager  " },
      expectedVersion: 1,
    });
    assert.deepEqual(result, {
      code: "ACCOUNT_PROFILE_UPDATED",
      user: {
        id: USER_ID,
        email: "Manager@Example.test",
        displayName: "Updated Manager",
        status: "active",
        version: 2,
      },
    });
    assert.equal(rows.get(USER_ID).email_display, "Manager@Example.test");
    assert.equal(rows.get(USER_ID).updated_at_ms, 100);
  });

  test("rejects stale, duplicate, unchanged, and malformed updates", () => {
    const { service } = createService();
    const update = (input, expectedVersion = 1) =>
      service.update({
        authenticated: { userId: USER_ID },
        input,
        expectedVersion,
      });

    assert.throws(
      () => update({ displayName: "New Name" }, 2),
      { code: "ACCOUNT_PROFILE_PRECONDITION_FAILED" }
    );
    assert.throws(
      () => update({ displayName: "Taken Name" }),
      { code: "ACCOUNT_DISPLAY_NAME_UNAVAILABLE" }
    );
    assert.throws(
      () => update({ displayName: "Original Manager" }),
      { code: "ACCOUNT_PROFILE_NO_CHANGES" }
    );
    assert.throws(
      () => update({ displayName: "New Name", email: "x@example.test" }),
      { code: "ACCOUNT_PROFILE_INPUT_INVALID" }
    );
  });

  test("accepts only a quoted positive If-Match version", () => {
    assert.equal(parseIfMatch({ get: () => '"12"' }), 12);
    for (const value of [null, "12", '"0"', '"01"', '"1.5"', '"x"']) {
      assert.equal(parseIfMatch({ get: () => value }), null);
    }
  });
});
