"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after } = require("node:test");

// Retired reset and strict-release protocols bind schema 54 and its sealed
// checksums. Their tests must continue to exercise that exact migration set.
function historicalSchema54Migrations(sourceDirectory) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, "hundo-schema54-test-"));
  const directory = path.join(root, "database", "migrations");
  fs.mkdirSync(directory, { recursive: true });
  const files = fs.readdirSync(sourceDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 54);
  assert.equal(files.length, 54);
  for (const file of files) fs.copyFileSync(path.join(sourceDirectory, file), path.join(directory, file));
  after(() => {
    assert.ok(path.resolve(root).startsWith(temporaryRoot + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return directory;
}

module.exports = { historicalSchema54Migrations };
