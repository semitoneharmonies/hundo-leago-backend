const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  sha256Hex,
} = require("../../src/domain/shared/sha256");

test("pure domain SHA-256 matches standard fixed and UTF-8 vectors", () => {
  const values = [
    "",
    "abc",
    "Hundo Leago",
    "Hundo \u{1f3d2} Leago",
    "a".repeat(1_000_000),
  ];

  for (const value of values) {
    assert.equal(
      sha256Hex(value),
      crypto
        .createHash("sha256")
        .update(value, "utf8")
        .digest("hex")
    );
  }

  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb924" +
      "27ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223" +
      "b00361a396177a9cb410ff61f20015ad"
  );
  assert.throws(
    () => sha256Hex(Buffer.from("abc")),
    /requires a string/
  );
});
