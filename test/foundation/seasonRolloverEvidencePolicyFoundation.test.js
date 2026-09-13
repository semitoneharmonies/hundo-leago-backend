const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  CanonicalJsonV1Error,
  compareUnicodeScalarStrings,
  hashSeasonRolloverItem,
  hashSeasonRolloverManifest,
  hashSeasonRolloverSourceReadiness,
  parseCanonicalJsonV1,
  serializeCanonicalJsonV1,
  serializeSeasonRolloverSourceReadiness,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

test("canonical-json-v1 recursively orders keys and preserves array order", () => {
  const value = Object.freeze({
    z: Object.freeze({
      beta: 2,
      alpha: 1,
    }),
    a: Object.freeze([
      Object.freeze({ y: null, x: true }),
      "value",
      -7,
    ]),
  });

  assert.equal(
    serializeCanonicalJsonV1(value),
    '{"a":[{"x":true,"y":null},"value",-7],"z":{"alpha":1,"beta":2}}'
  );
});

test("canonical-json-v1 orders object keys by Unicode scalar value", () => {
  const basicPrivateUse = "\ue000";
  const supplementary = "\u{10000}";
  assert.ok(
    compareUnicodeScalarStrings(
      basicPrivateUse,
      supplementary
    ) < 0
  );

  assert.equal(
    serializeCanonicalJsonV1({
      [supplementary]: 2,
      [basicPrivateUse]: 1,
    }),
    `{"${basicPrivateUse}":1,"${supplementary}":2}`
  );
});

test("source-readiness serialization stores only the canonical projection while its hash binds the exact envelope", () => {
  const projection = Object.freeze({
    sourceFadId:
      "00000000-0000-4000-8000-000000000001",
    observedAtMs: 123,
    rows: Object.freeze([]),
  });
  const projectionJson =
    '{"observedAtMs":123,"rows":[],"sourceFadId":"00000000-0000-4000-8000-000000000001"}';
  assert.equal(
    serializeSeasonRolloverSourceReadiness(projection),
    projectionJson
  );
  assert.equal(
    hashSeasonRolloverSourceReadiness(projection),
    sha256(
      `{"domain":"hundo-leago.season-rollover-source-readiness","schemaVersion":1,"sourceReadiness":${projectionJson}}`
    )
  );
});

test("item and manifest hashes bind their distinct domains and schema version", () => {
  const item = Object.freeze({
    itemId:
      "00000000-0000-4000-8000-000000000001",
  });
  const manifest = Object.freeze({
    leagueId:
      "00000000-0000-4000-8000-000000000002",
    items: Object.freeze([]),
  });

  assert.equal(
    hashSeasonRolloverItem(item),
    sha256(
      '{"domain":"hundo-leago.season-rollover-item","item":{"itemId":"00000000-0000-4000-8000-000000000001"},"schemaVersion":1}'
    )
  );
  assert.equal(
    hashSeasonRolloverManifest(manifest),
    sha256(
      '{"domain":"hundo-leago.season-rollover-manifest","items":[],"leagueId":"00000000-0000-4000-8000-000000000002","schemaVersion":1}'
    )
  );
  assert.notEqual(
    hashSeasonRolloverItem(item),
    hashSeasonRolloverManifest(item)
  );
  assert.throws(
    () =>
      hashSeasonRolloverManifest({
        ...manifest,
        domain: "attacker-controlled",
        schemaVersion: 999,
      }),
    CanonicalJsonV1Error
  );
});

test("canonical-json-v1 parser accepts only an exact canonical byte representation", () => {
  const canonical =
    '{"a":[1,true,null],"b":"value"}';
  assert.deepEqual(
    parseCanonicalJsonV1(canonical),
    {
      a: [1, true, null],
      b: "value",
    }
  );

  for (const serialized of [
    '{"b":"value","a":[1,true,null]}',
    '{"a":1.0}',
    '{"a":1,"a":1}',
    '{"a":1}\n',
    '{"a":"\\ud800"}',
  ]) {
    assert.throws(
      () => parseCanonicalJsonV1(serialized),
      CanonicalJsonV1Error
    );
  }
});

test("canonical-json-v1 rejects ambiguous or non-JSON values", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse.length = 1;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      return 1;
    },
  });
  const symbolProperty = { value: 1 };
  symbolProperty[Symbol("hidden")] = true;

  for (const value of [
    undefined,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    -0,
    "\ud800",
    new Date(0),
    cyclic,
    sparse,
    accessor,
    symbolProperty,
  ]) {
    assert.throws(
      () => serializeCanonicalJsonV1(value),
      (error) =>
        error instanceof CanonicalJsonV1Error &&
        error.code === "CANONICAL_JSON_V1_INVALID"
    );
  }
});
