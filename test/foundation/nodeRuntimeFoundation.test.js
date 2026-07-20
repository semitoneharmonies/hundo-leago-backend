const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const APPROVED_NODE_VERSION = "24.14.1";
const APPROVED_NODE_ENGINE = ">=24.14.1 <25";

function readRootFile(relativePath) {
  return readFileSync(path.join(ROOT_DIRECTORY, relativePath), "utf8");
}

function readRootJson(relativePath) {
  return JSON.parse(readRootFile(relativePath));
}

test("repository runtime declarations match the approved Node version", () => {
  const packageJson = readRootJson("package.json");
  const packageLock = readRootJson("package-lock.json");

  assert.equal(readRootFile(".node-version").trim(), APPROVED_NODE_VERSION);
  assert.equal(packageJson.engines?.node, APPROVED_NODE_ENGINE);
  assert.equal(packageLock.packages?.[""]?.engines?.node, APPROVED_NODE_ENGINE);
});

test("verification runs under the approved Node version", () => {
  assert.equal(process.versions.node, APPROVED_NODE_VERSION);
});

test("package metadata and dependency declarations remain synchronized", () => {
  const packageJson = readRootJson("package.json");
  const rootLockPackage = readRootJson("package-lock.json").packages?.[""];

  assert.ok(rootLockPackage);
  assert.equal(rootLockPackage.name, packageJson.name);
  assert.equal(rootLockPackage.version, packageJson.version);
  assert.deepEqual(rootLockPackage.dependencies, packageJson.dependencies);
  assert.deepEqual(rootLockPackage.devDependencies, packageJson.devDependencies);
});
