"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after } = require("node:test");

// This FAD fixture predates commissioner controls but must include the released
// AAV award correction. Current commissioner scenarios use the full schema.
function historicalSchema65Migrations(sourceDirectory) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, "hundo-schema65-test-"));
  const directory = path.join(root, "database", "migrations");
  fs.mkdirSync(directory, { recursive: true });
  const files = fs.readdirSync(sourceDirectory).filter(file => /^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 65);
  assert.equal(files.length, 65);
  for (const file of files) fs.copyFileSync(path.join(sourceDirectory, file), path.join(directory, file));
  after(() => {
    assert.ok(path.resolve(root).startsWith(temporaryRoot + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return directory;
}

module.exports = { historicalSchema65Migrations };
